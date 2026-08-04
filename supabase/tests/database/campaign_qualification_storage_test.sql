-- Tests for Phase 2A-A: the campaign qualification and reward storage foundation.
--
--   public.campaign_sale_evaluations
--   public.campaign_sale_item_qualifications
--   public.campaign_rewards
--   public.campaign_subject_accumulators
--
-- Run with:  supabase test db
--
-- ============================================================================
-- WHAT THIS SUITE IS ACTUALLY PROTECTING
-- ============================================================================
-- This migration ships no RPC, so every rule it adds is a constraint or a trigger,
-- and the ONLY way to test them is to write directly to the tables. That is not a
-- shortcut around a missing interface — it is the exact threat model. The next
-- migration will write these rows, a later one will too, and neither is obliged to
-- ask permission first. So this suite behaves like a hostile writer throughout.
--
-- Four properties matter more than the rest:
--
--   1. decision = 'ACCEPTED' is NEVER sufficient. The migration-64 limitation is
--      real and reproduced here in Section E: a Claim Reviewer can insert an
--      ACCEPTED product decision carrying NO items, bypassing the RPC that would
--      have copied them. Evidence built on such a decision must be refused by the
--      table, not merely avoided by a well-behaved caller.
--
--   2. Every copied value is proven, not trusted. verified_sales deliberately has no
--      seller column because "a second answer is exactly what drifts". These tables
--      copy the seller, the instant, the tenants and the whole campaign
--      configuration anyway — so Section D proves each copy is asserted against its
--      authoritative source and cannot be asserted into a lie.
--
--   3. One sale pays at most one campaign per exclusivity key. Section H proves the
--      partial unique index makes double payment UNSTORABLE, not merely unlikely.
--
--   4. Nothing here can be edited or deleted. Section C proves it for all three
--      evidence tables, including TRUNCATE, which row-level triggers never see.
--
-- Section J asserts the FOUNDATION BOUNDARY: no matching helper, no evaluation RPC,
-- no permission, no coin or ledger object. A storage migration that quietly grew a
-- reward calculation would pass every other test in this file.
--
-- Everything runs inside one transaction and is rolled back. Every fixture is
-- synthetic; no hosted data is read or written, and this suite runs only locally.
--
-- no_plan() rather than plan(N), per the convention in this directory: a hard-coded
-- count that drifts out of step with the file turns an added test into a confusing
-- failure somewhere else.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers and fixture
-- ============================================================================
create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text)::text, true);
end;
$$;

create function pg_temp.sign_out() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create table pg_temp.f (k text primary key, v uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select v from pg_temp.f where k = p
$$;

create function pg_temp.new_person(p_first text, p_last text, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || left(v_id::text, 8) || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, p_status);
  return v_id;
end;
$$;

create function pg_temp.new_org(p_name text, p_type text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.organizations (name, organization_type, status, country_code, default_currency)
  values (p_name, p_type, 'ACTIVE', 'AE', 'AED') returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.add_member(p_user uuid, p_org uuid, p_role text, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_m uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, p_status, now() - interval '30 days') returning id into v_m;
  insert into public.member_roles (organization_member_id, role_id)
  select v_m, r.id from public.roles r where r.code = p_role on conflict do nothing;
  return v_m;
end;
$$;

create function pg_temp.new_product(
  p_vendor uuid, p_code text, p_name text, p_creator uuid
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.vendor_products (
    vendor_organization_id, product_code, product_name, status, created_by_profile_id)
  values (p_vendor, p_code, p_name, 'ACTIVE', p_creator)
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.assign(p_product uuid, p_retailer uuid, p_by uuid)
returns void language plpgsql as $$
begin
  insert into public.vendor_product_retailer_assignments (
    vendor_product_id, retailer_organization_id, status, assigned_by_profile_id,
    assigned_at, updated_at)
  values (p_product, p_retailer, 'ACTIVE', p_by, now() - interval '10 days', now());
end;
$$;

create function pg_temp.new_receipt(p_retailer uuid, p_shop uuid, p_submitter uuid)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_path text;
begin
  v_path := 'cq/' || v_id::text || '.png';
  insert into public.receipt_submissions (
    id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
    storage_bucket, storage_object_path, original_file_name, mime_type,
    file_size_bytes, file_sha256, status, submitted_at
  ) values (
    v_id, p_retailer, p_shop, p_submitter, 'receipts', v_path, 'r.png', 'image/png',
    1000, encode(gen_random_bytes(32), 'hex'), 'SUBMITTED', now() - interval '1 day'
  );
  insert into storage.objects (bucket_id, name, owner) values ('receipts', v_path, null);
  return v_id;
end;
$$;

create function pg_temp.line(p_product uuid, p_qty integer) returns jsonb
language sql immutable as $$
  select jsonb_build_object('product_id', p_product::text, 'quantity', p_qty)
$$;

/* A receipt carried all the way to a complete, ACCEPTED, authoritative item set —
   the only state from which qualification evidence may legitimately be built. */
create function pg_temp.full_sale(
  p_key text, p_retailer uuid, p_shop uuid, p_staff uuid, p_vendor uuid,
  p_reviewer uuid, p_lines jsonb
) returns uuid language plpgsql as $$
declare v_r uuid;
begin
  v_r := pg_temp.new_receipt(p_retailer, p_shop, p_staff);
  insert into pg_temp.f values (p_key || '_receipt', v_r);

  perform pg_temp.act_as(p_staff);
  perform public.confirm_receipt_with_products(
    v_r, date '2026-06-15', 'AED', 2::smallint, 12345::bigint, p_lines,
    'Test Merchant', 'DOC-1', time '14:30', 10000::bigint, 2345::bigint);

  insert into public.receipt_review_decisions
    (receipt_submission_id, vendor_organization_id, decision, decided_by_profile_id)
  values (v_r, p_vendor, 'VERIFIED', p_reviewer);

  perform pg_temp.act_as(p_reviewer);
  perform public.finalize_claim_receipt_sale_header(v_r, null);
  perform public.finalize_claim_receipt_sale_items(v_r, 'ACCEPTED');
  perform pg_temp.sign_out();

  insert into pg_temp.f
  select p_key, v.id from public.verified_sales v where v.receipt_submission_id = v_r;
  return pg_temp.id(p_key);
end;
$$;

/* A published campaign version. Returns the VERSION id, which is what evidence
   points at. */
create function pg_temp.publish(
  p_key text, p_vendor uuid, p_admin uuid, p_name text,
  p_performance text default 'INDIVIDUAL_STAFF',
  p_scope       text default 'ALL_ELIGIBLE_PRODUCTS',
  p_stacking    text default 'STACKABLE',
  p_excl_key    text default null,
  p_rule        text default 'PER_UNIT_COINS',
  p_per_unit    bigint default 5,
  p_threshold   integer default null,
  p_bonus       bigint default null,
  p_cap         bigint default null,
  p_products    uuid[] default null,
  p_priority    integer default 10
) returns uuid language plpgsql as $$
declare v_c uuid; v_v uuid;
begin
  perform pg_temp.act_as(p_admin);
  v_c := public.create_vendor_campaign_draft(
    p_name, 'Described.', now() - interval '30 days', now() + interval '30 days',
    'Asia/Dubai', 'ALL_RETAILERS', p_performance, p_scope, p_stacking, p_excl_key,
    p_priority, p_rule, p_per_unit, p_threshold, p_bonus, p_cap,
    null, null, p_products);
  perform public.publish_vendor_campaign(v_c);
  select c.published_version_id into v_v from public.campaigns c where c.id = v_c;
  perform pg_temp.sign_out();
  insert into pg_temp.f values (p_key || '_campaign', v_c), (p_key, v_v);
  return v_v;
end;
$$;

/* Build an evaluation row from the authoritative sources, with every field
   individually overridable so a test can corrupt exactly one thing. */
create function pg_temp.ins_eval(
  p_sale uuid, p_version uuid,
  p_outcome text default 'QUALIFIED',
  p_reason  text default null,
  p_items   integer default 2,
  p_units   integer default 5,
  p_campaign uuid default null,
  p_vendor uuid default null,
  p_retailer uuid default null,
  p_shop uuid default null,
  p_beneficiary uuid default null,
  p_sale_at timestamptz default null,
  p_submission uuid default null,
  p_priority integer default null,
  p_starts_at timestamptz default null,
  p_excl_key text default null,
  p_stacking text default null
) returns uuid language plpgsql as $$
declare
  v_sale public.verified_sales%rowtype;
  v_cv   public.campaign_versions%rowtype;
  v_id   uuid;
begin
  select * into v_sale from public.verified_sales v where v.id = p_sale;
  select * into v_cv   from public.campaign_versions c where c.id = p_version;

  insert into public.campaign_sale_evaluations (
    campaign_id, campaign_version_id, verified_sale_id, receipt_submission_id,
    vendor_organization_id, retailer_organization_id, retailer_shop_id,
    beneficiary_profile_id, sale_at,
    performance_scope, reward_recipient_scope, product_scope,
    product_eligibility_resolution, stacking_mode, exclusivity_key,
    priority, campaign_starts_at,
    outcome, non_qualification_reason, qualifying_item_count, qualifying_units,
    evaluated_by_profile_id
  ) values (
    coalesce(p_campaign, v_cv.campaign_id), p_version, p_sale,
    coalesce(p_submission, v_sale.receipt_submission_id),
    coalesce(p_vendor,   v_sale.vendor_organization_id),
    coalesce(p_retailer, v_sale.retailer_organization_id),
    coalesce(p_shop,     v_sale.retailer_shop_id),
    coalesce(p_beneficiary,
             (select s.submitted_by_profile_id from public.receipt_submissions s
              where s.id = v_sale.receipt_submission_id)),
    coalesce(p_sale_at, v_sale.sale_at),
    v_cv.performance_scope, v_cv.reward_recipient_scope, v_cv.product_scope,
    v_cv.product_eligibility_resolution,
    coalesce(p_stacking, v_cv.stacking_mode),
    coalesce(p_excl_key, v_cv.exclusivity_key),
    coalesce(p_priority, v_cv.priority),
    coalesce(p_starts_at, v_cv.starts_at),
    p_outcome, p_reason, p_items, p_units,
    pg_temp.id('rev')
  ) returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.try_eval(
  p_sale uuid, p_version uuid,
  p_outcome text default 'QUALIFIED',
  p_reason  text default null,
  p_items   integer default 2,
  p_units   integer default 5,
  p_campaign uuid default null,
  p_vendor uuid default null,
  p_retailer uuid default null,
  p_shop uuid default null,
  p_beneficiary uuid default null,
  p_sale_at timestamptz default null,
  p_submission uuid default null,
  p_priority integer default null,
  p_starts_at timestamptz default null,
  p_excl_key text default null,
  p_stacking text default null
) returns text language plpgsql as $$
begin
  perform pg_temp.ins_eval(p_sale, p_version, p_outcome, p_reason, p_items, p_units,
    p_campaign, p_vendor, p_retailer, p_shop, p_beneficiary, p_sale_at, p_submission,
    p_priority, p_starts_at, p_excl_key, p_stacking);
  return 'ALLOWED';
exception when others then
  return 'REFUSED:' || sqlstate;
end;
$$;

/* Build a reward row consistent with the campaign version's own rule. */
create function pg_temp.ins_reward(
  p_eval uuid,
  p_units integer default 5,
  p_uncapped bigint default null,
  p_capped bigint default null,
  p_reward bigint default null,
  p_rate bigint default null,
  p_subject_type text default null,
  p_subject_id uuid default null,
  p_beneficiary uuid default null,
  p_cap bigint default null
) returns uuid language plpgsql as $$
declare
  v_e public.campaign_sale_evaluations%rowtype;
  v_r public.campaign_rules%rowtype;
  v_t public.campaign_rule_tiers%rowtype;
  v_unc bigint; v_id uuid;
begin
  select * into v_e from public.campaign_sale_evaluations e where e.id = p_eval;
  select * into v_r from public.campaign_rules r
   where r.campaign_version_id = v_e.campaign_version_id and r.sequence = 1;
  select * into v_t from public.campaign_rule_tiers t
   where t.campaign_rule_id = v_r.id and t.tier_number = 1;

  v_unc := coalesce(p_uncapped,
    case when v_r.rule_type = 'PER_UNIT_COINS'
         then coalesce(p_rate, v_r.coins_per_unit) * p_units
         else v_t.reward_coins end);

  insert into public.campaign_rewards (
    campaign_sale_evaluation_id, campaign_id, campaign_version_id, verified_sale_id,
    receipt_submission_id, vendor_organization_id, retailer_organization_id,
    retailer_shop_id, beneficiary_profile_id,
    performance_scope, cap_subject_type, cap_subject_id,
    rule_type, metric_type, coins_per_unit, threshold_units,
    configured_reward_coins, max_reward_coins,
    units_counted, coins_uncapped, coins_capped_to, reward_coins
  ) values (
    p_eval, v_e.campaign_id, v_e.campaign_version_id, v_e.verified_sale_id,
    v_e.receipt_submission_id, v_e.vendor_organization_id, v_e.retailer_organization_id,
    v_e.retailer_shop_id, coalesce(p_beneficiary, v_e.beneficiary_profile_id),
    v_e.performance_scope,
    coalesce(p_subject_type,
      case when v_e.performance_scope = 'INDIVIDUAL_STAFF'
           then 'SALES_STAFF_PROFILE' else 'RETAILER_ORGANIZATION' end),
    coalesce(p_subject_id,
      case when v_e.performance_scope = 'INDIVIDUAL_STAFF'
           then v_e.beneficiary_profile_id else v_e.retailer_organization_id end),
    v_r.rule_type, v_r.metric_type,
    case when v_r.rule_type = 'PER_UNIT_COINS'
         then coalesce(p_rate, v_r.coins_per_unit) else null end,
    v_t.threshold_units, v_t.reward_coins,
    coalesce(p_cap, v_r.max_reward_coins),
    p_units, v_unc, p_capped, coalesce(p_reward, p_capped, v_unc)
  ) returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.try_reward(
  p_eval uuid,
  p_units integer default 5,
  p_uncapped bigint default null,
  p_capped bigint default null,
  p_reward bigint default null,
  p_rate bigint default null,
  p_subject_type text default null,
  p_subject_id uuid default null,
  p_beneficiary uuid default null,
  p_cap bigint default null
) returns text language plpgsql as $$
begin
  perform pg_temp.ins_reward(p_eval, p_units, p_uncapped, p_capped, p_reward, p_rate,
    p_subject_type, p_subject_id, p_beneficiary, p_cap);
  return 'ALLOWED';
exception when others then
  return 'REFUSED:' || sqlstate;
end;
$$;

/* Build an item qualification, every field overridable. */
create function pg_temp.try_item(
  p_eval uuid,
  p_item uuid,
  p_units integer default null,
  p_source text default null,
  p_status text default null,
  p_assign text default null,
  p_product uuid default null,
  p_sale uuid default null,
  p_version uuid default null
) returns text language plpgsql as $$
declare
  v_e public.campaign_sale_evaluations%rowtype;
  v_i public.verified_sale_items%rowtype;
  v_src text;
begin
  select * into v_e from public.campaign_sale_evaluations e where e.id = p_eval;
  select * into v_i from public.verified_sale_items i where i.id = p_item;
  v_src := coalesce(p_source, v_e.product_eligibility_resolution);

  insert into public.campaign_sale_item_qualifications (
    campaign_sale_evaluation_id, campaign_id, campaign_version_id, verified_sale_id,
    verified_sale_item_id, vendor_product_id, qualifying_units, product_source,
    product_status_at_sale, assignment_status_at_sale
  ) values (
    p_eval, v_e.campaign_id, coalesce(p_version, v_e.campaign_version_id),
    coalesce(p_sale, v_e.verified_sale_id),
    p_item, coalesce(p_product, v_i.vendor_product_id),
    coalesce(p_units, v_i.quantity), v_src,
    coalesce(p_status, case when v_src = 'LIVE_TEMPORAL' then 'ACTIVE' end),
    coalesce(p_assign, case when v_src = 'LIVE_TEMPORAL' then 'ACTIVE' end)
  );
  return 'ALLOWED';
exception when others then
  return 'REFUSED:' || sqlstate;
end;
$$;

create function pg_temp.try_sql(s text) returns text language plpgsql as $$
begin execute s; return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

/* Same as try_reward, but returns the refusal MESSAGE rather than the SQLSTATE.
   Several distinct assertions in this migration raise check_violation, so the state
   alone cannot prove WHICH one refused a row. Where attribution matters, the message
   is the only thing that distinguishes them. */
create function pg_temp.reward_error(
  p_eval uuid,
  p_units integer default 5,
  p_uncapped bigint default null,
  p_capped bigint default null,
  p_reward bigint default null,
  p_rate bigint default null
) returns text language plpgsql as $$
begin
  perform pg_temp.ins_reward(p_eval, p_units, p_uncapped, p_capped, p_reward, p_rate);
  return 'ALLOWED';
exception when others then
  return sqlerrm;
end;
$$;

/* An evaluation plus EXACTLY the item evidence it declares, derived from the sale
   itself so the two can never disagree. A reward now requires this, so any fixture
   that needs one builds it here rather than hand-counting. */
create function pg_temp.complete_eval(p_sale uuid, p_version uuid) returns uuid
language plpgsql as $$
declare v_e uuid; v_items integer; v_units integer; r record;
begin
  select count(*)::integer, coalesce(sum(i.quantity), 0)::integer
    into v_items, v_units
  from public.verified_sale_items i where i.verified_sale_id = p_sale;

  v_e := pg_temp.ins_eval(p_sale, p_version, p_items => v_items, p_units => v_units);

  for r in select i.id from public.verified_sale_items i
           where i.verified_sale_id = p_sale order by i.line_number loop
    perform pg_temp.try_item(v_e, r.id);
  end loop;
  return v_e;
end;
$$;

create function pg_temp.item_of(p_sale uuid, p_product uuid) returns uuid
language sql stable as $$
  select i.id from public.verified_sale_items i
  where i.verified_sale_id = p_sale and i.vendor_product_id = p_product
$$;

-- ---- The fixture -----------------------------------------------------------
-- Two Vendors and two Retailers, so every isolation claim is tested against a real
-- second tenant rather than against an absence.
do $$
declare v uuid;
begin
  insert into pg_temp.f values
    ('vendor_a',   pg_temp.new_org('CQ Vendor A',   'VENDOR')),
    ('vendor_b',   pg_temp.new_org('CQ Vendor B',   'VENDOR')),
    ('retailer_a', pg_temp.new_org('CQ Retailer A', 'RETAILER')),
    ('retailer_b', pg_temp.new_org('CQ Retailer B', 'RETAILER'));

  insert into pg_temp.f values
    ('vsa',   pg_temp.new_person('CQ','Admin')),
    ('vsb',   pg_temp.new_person('CQ','AdminB')),
    ('rev',   pg_temp.new_person('CQ','Rev')),
    ('revb',  pg_temp.new_person('CQ','RevB')),
    ('staff', pg_temp.new_person('CQ','Staff')),
    ('staff2',pg_temp.new_person('CQ','Staff2')),
    ('staffb',pg_temp.new_person('CQ','StaffB'));

  perform pg_temp.add_member(pg_temp.id('vsa'),    pg_temp.id('vendor_a'),   'VENDOR_SUPER_ADMIN');
  perform pg_temp.add_member(pg_temp.id('vsb'),    pg_temp.id('vendor_b'),   'VENDOR_SUPER_ADMIN');
  perform pg_temp.add_member(pg_temp.id('rev'),    pg_temp.id('vendor_a'),   'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('revb'),   pg_temp.id('vendor_b'),   'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('staff'),  pg_temp.id('retailer_a'), 'SALES_STAFF');
  perform pg_temp.add_member(pg_temp.id('staff2'), pg_temp.id('retailer_a'), 'SALES_STAFF');
  perform pg_temp.add_member(pg_temp.id('staffb'), pg_temp.id('retailer_b'), 'SALES_STAFF');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (pg_temp.id('vendor_a'), pg_temp.id('retailer_a'), 'ACTIVE'),
         (pg_temp.id('vendor_b'), pg_temp.id('retailer_b'), 'ACTIVE');

  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_a'), 'CQ Shop', 'CQS', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop', v);
  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_a'), 'CQ Shop Two', 'CQ2', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop2', v);
  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_b'), 'CQ Shop B', 'CQB', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop_b', v);

  insert into pg_temp.f values
    ('p1', pg_temp.new_product(pg_temp.id('vendor_a'), 'CQ-1', 'Product One',  pg_temp.id('vsa'))),
    ('p2', pg_temp.new_product(pg_temp.id('vendor_a'), 'CQ-2', 'Product Two',  pg_temp.id('vsa'))),
    ('p3', pg_temp.new_product(pg_temp.id('vendor_a'), 'CQ-3', 'Product Three',pg_temp.id('vsa'))),
    ('pb', pg_temp.new_product(pg_temp.id('vendor_b'), 'CQ-B', 'Product B',    pg_temp.id('vsb')));

  perform pg_temp.assign(pg_temp.id('p1'), pg_temp.id('retailer_a'), pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('p2'), pg_temp.id('retailer_a'), pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('p3'), pg_temp.id('retailer_a'), pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('pb'), pg_temp.id('retailer_b'), pg_temp.id('vsb'));
end;
$$;

-- Published campaign versions.
do $$
begin
  perform pg_temp.publish('cv_stack', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CQ Stack');
  perform pg_temp.publish('cv_x1', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CQ Excl One',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'EXCLUSIVE', 'GROUP ONE',
    'PER_UNIT_COINS', 7, null, null, null, null, 900);
  perform pg_temp.publish('cv_x2', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CQ Excl Two',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'EXCLUSIVE', 'GROUP ONE',
    'PER_UNIT_COINS', 3, null, null, null, null, 100);
  -- Rate 10, cap 30. s1 contributes 5 units, so the uncapped 50 genuinely exceeds the
  -- cap and a PARTIAL award is exercised with the sale's own real unit count rather
  -- than an invented one.
  perform pg_temp.publish('cv_cap', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CQ Capped',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'STACKABLE', null,
    'PER_UNIT_COINS', 10, null, null, 30);
  perform pg_temp.publish('cv_bonus', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CQ Bonus',
    'RETAILER_TEAM', 'ALL_ELIGIBLE_PRODUCTS', 'STACKABLE', null,
    'TARGET_BONUS', null, 10, 500, null);
  perform pg_temp.publish('cv_sel', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CQ Selected',
    'INDIVIDUAL_STAFF', 'SELECTED_PRODUCTS', 'STACKABLE', null,
    'PER_UNIT_COINS', 4, null, null, null, array[pg_temp.id('p1')]);
  -- A spare PER_UNIT_COINS campaign reserved for the arithmetic section, so those
  -- assertions never have to share a (sale, version) pair with another section and
  -- be rejected by the uniqueness key instead of the constraint under test.
  perform pg_temp.publish('cv_m', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CQ Arithmetic',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'STACKABLE', null,
    'PER_UNIT_COINS', 4);
  -- Reserved for the PER_UNIT_COINS accumulator-reconstruction scenario: two sales by
  -- the SAME staff member, both rewarded, so a per-subject total has two rows to add.
  perform pg_temp.publish('cv_recon', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CQ Recon',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'STACKABLE', null,
    'PER_UNIT_COINS', 2);
  -- Reserved for the unit-equality section, so its probes never share a
  -- (sale, version) pair with another section.
  perform pg_temp.publish('cv_o', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CQ Units',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'STACKABLE', null,
    'PER_UNIT_COINS', 3);
  -- A CAPPED TARGET_BONUS campaign. cv_bonus is uncapped, so its bonus reward always
  -- carries positive coins and cannot distinguish an existence-based reconstruction
  -- of target_bonus_awarded from a coins-based one. This campaign exists purely to
  -- produce the state where the two DISAGREE: a real bonus award worth zero coins
  -- because the subject's cap was already spent.
  perform pg_temp.publish('cv_bz', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CQ Bonus Capped',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'STACKABLE', null,
    'TARGET_BONUS', null, 3, 400, 100);
  perform pg_temp.publish('cv_b', pg_temp.id('vendor_b'), pg_temp.id('vsb'), 'CQ Vendor B');
end;
$$;

-- Sales.
do $$
declare v_r uuid;
begin
  -- s1: p1 x3 + p2 x2  => 2 items, 5 units.
  perform pg_temp.full_sale('s1', pg_temp.id('retailer_a'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor_a'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 3), pg_temp.line(pg_temp.id('p2'), 2)));

  -- s2: a second staff member, so beneficiary isolation is testable.
  perform pg_temp.full_sale('s2', pg_temp.id('retailer_a'), pg_temp.id('shop'),
    pg_temp.id('staff2'), pg_temp.id('vendor_a'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 4)));

  -- s3: excluded later, in Section E, to prove an exclusion recorded AFTER an
  -- evaluation still blocks the reward.
  perform pg_temp.full_sale('s3', pg_temp.id('retailer_a'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor_a'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p3'), 1)));

  -- s4: reserved for Section H alone, and deliberately paired with NO campaign
  -- before it. An exclusivity test run on a sale that some earlier section already
  -- evaluated would trip the (version, sale) key and appear to prove exclusivity
  -- while proving nothing of the sort.
  perform pg_temp.full_sale('s4', pg_temp.id('retailer_a'), pg_temp.id('shop'),
    pg_temp.id('staff2'), pg_temp.id('vendor_a'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p2'), 3)));

  -- s_excl: complete, then EXCLUDED afterwards. Nothing in the deployed schema
  -- prevents excluding a receipt that already carries a finalized sale.
  perform pg_temp.full_sale('s_excl', pg_temp.id('retailer_a'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor_a'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.record_claim_receipt_qualification(
    pg_temp.id('s_excl_receipt'), 'EXCLUDE', 'TEST_DATA', null);
  perform pg_temp.sign_out();

  -- s_b: Vendor B / Retailer B, for cross-tenant refusals.
  perform pg_temp.full_sale('s_b', pg_temp.id('retailer_b'), pg_temp.id('shop_b'),
    pg_temp.id('staffb'), pg_temp.id('vendor_b'), pg_temp.id('revb'),
    jsonb_build_array(pg_temp.line(pg_temp.id('pb'), 1)));

  -- ---- THE MIGRATION-64 LIMITATION, REPRODUCED ----------------------------
  -- A receipt taken to a verified sale, then given an ACCEPTED product decision by
  -- a DIRECT INSERT that copies no items. finalize_claim_receipt_sale_items would
  -- have copied every proposal line and verified the count; a direct insert does
  -- not, and receipt_product_review_decisions_assert_decision cannot notice —
  -- verified_sale_items has a foreign key TO this row, so no item can exist yet.
  v_r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('s_bad_receipt', v_r);
  perform pg_temp.act_as(pg_temp.id('staff'));
  perform public.confirm_receipt_with_products(
    v_r, date '2026-06-15', 'AED', 2::smallint, 12345::bigint,
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)),
    'Test Merchant', 'DOC-1', time '14:30', 10000::bigint, 2345::bigint);
  insert into public.receipt_review_decisions
    (receipt_submission_id, vendor_organization_id, decision, decided_by_profile_id)
  values (v_r, pg_temp.id('vendor_a'), 'VERIFIED', pg_temp.id('rev'));
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.finalize_claim_receipt_sale_header(v_r, null);

  insert into public.receipt_product_review_decisions (
    receipt_submission_id, receipt_confirmation_id, verified_sale_id,
    vendor_organization_id, decision, decided_by_profile_id)
  select v_r, c.id, v.id, pg_temp.id('vendor_a'), 'ACCEPTED', pg_temp.id('rev')
  from public.receipt_confirmations c
  join public.verified_sales v on v.receipt_submission_id = v_r
  where c.receipt_submission_id = v_r;
  perform pg_temp.sign_out();

  insert into pg_temp.f
  select 's_bad', v.id from public.verified_sales v where v.receipt_submission_id = v_r;
end;
$$;


-- ============================================================================
-- SECTION A — THE FOUR TABLES EXIST
-- ============================================================================
select has_table('public', 'campaign_sale_evaluations',
  'A1. the evaluation envelope table exists');
select has_table('public', 'campaign_sale_item_qualifications',
  'A2. the item qualification table exists');
select has_table('public', 'campaign_rewards',
  'A3. the reward evidence table exists');
select has_table('public', 'campaign_subject_accumulators',
  'A4. the subject accumulator table exists');

-- The fixture is only meaningful if it really built what it claims to have built.
select is((select count(*)::integer from public.verified_sale_items i
           where i.verified_sale_id = pg_temp.id('s1')), 2,
  'A5. FIXTURE: s1 carries two authoritative items');
select ok(public.receipt_has_finalized_sale_items(pg_temp.id('s1_receipt')),
  'A6. FIXTURE: s1 has a COMPLETE finalized item set');
select ok(not public.receipt_has_finalized_sale_items(pg_temp.id('s_bad_receipt')),
  'A7. FIXTURE: the incomplete ACCEPTED decision fails receipt_has_finalized_sale_items');
select is((select d.decision from public.receipt_product_review_decisions d
           where d.receipt_submission_id = pg_temp.id('s_bad_receipt')), 'ACCEPTED',
  'A8. FIXTURE: ...even though its decision really does read ACCEPTED');
select ok(public.receipt_qualification_is_excluded(pg_temp.id('s_excl_receipt')),
  'A9. FIXTURE: s_excl carries an active exclusion recorded AFTER finalization');


-- ============================================================================
-- SECTION A2 — THE COMPLETE-ITEM-EVIDENCE INVARIANT
-- ============================================================================
-- An envelope must carry EXACTLY the item evidence it declares, and no reward may be
-- paid from one that does not.
--
-- Enforcement is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so an ordinary
-- INSERT proves nothing on its own: the check does not run until COMMIT, and this
-- suite never commits. Each assertion below therefore forces the check with
-- SET CONSTRAINTS ALL IMMEDIATE and resets to deferred afterwards.
--
-- WHY THIS SECTION RUNS FIRST. SET CONSTRAINTS ALL IMMEDIATE validates every pending
-- deferred event in the transaction, not only the one just created. Later sections
-- legitimately leave incomplete QUALIFIED envelopes lying around as probe fixtures —
-- they never commit, so they are harmless — but they WOULD make a forced check here
-- fail for a reason that has nothing to do with the assertion. Running before any of
-- them exist is what keeps each result attributable.
create function pg_temp.at_commit(s text) returns text language plpgsql as $$
begin
  begin
    execute s;
    set constraints all immediate;
    set constraints all deferred;
    return 'ALLOWED';
  exception when others then
    set constraints all deferred;
    return 'REFUSED:' || sqlstate;
  end;
end;
$$;

/* Build an evaluation plus the first p_take of its sale's items, then force
   commit-time validation. A refusal rolls the whole block back, so a rejected
   probe leaves nothing behind for the next one to trip over. */
create function pg_temp.try_complete(
  p_sale uuid, p_version uuid, p_items integer, p_units integer, p_take integer
) returns text language plpgsql as $$
declare v_e uuid; r record; n integer := 0;
begin
  begin
    v_e := pg_temp.ins_eval(p_sale, p_version, p_items => p_items, p_units => p_units);
    for r in select i.id from public.verified_sale_items i
             where i.verified_sale_id = p_sale order by i.line_number loop
      exit when n >= p_take;
      perform pg_temp.try_item(v_e, r.id);
      n := n + 1;
    end loop;
    set constraints all immediate;
    set constraints all deferred;
    return 'ALLOWED';
  exception when others then
    set constraints all deferred;
    return 'REFUSED:' || sqlstate;
  end;
end;
$$;

/* Reward probes that ALWAYS roll their fixture back, so an itemless or partial
   envelope never survives to interfere with a later forced check. */
create function pg_temp.try_reward_on(p_sale uuid, p_version uuid, p_take integer,
                                      p_items integer, p_units integer)
returns text language plpgsql as $$
declare v_e uuid; r record; n integer := 0;
begin
  v_e := pg_temp.ins_eval(p_sale, p_version, p_items => p_items, p_units => p_units);
  for r in select i.id from public.verified_sale_items i
           where i.verified_sale_id = p_sale order by i.line_number loop
    exit when n >= p_take;
    perform pg_temp.try_item(v_e, r.id);
    n := n + 1;
  end loop;
  perform pg_temp.ins_reward(v_e, p_units);
  raise exception 'PROBE_REACHED_END';
exception when others then
  if sqlerrm = 'PROBE_REACHED_END' then return 'ALLOWED'; end if;
  return 'REFUSED:' || sqlstate;
end;
$$;

-- The trigger really is DEFERRED: an incomplete envelope inserts without complaint,
-- and only a forced commit-time check objects. If this first assertion ever failed,
-- every "refused at commit" result below would be meaningless.
select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_bonus'),
          p_items => 1, p_units => 3), 'ALLOWED',
  'A2-1. an incomplete QUALIFIED envelope INSERTS fine — the check is deferred, not immediate');

select is(public.campaign_evaluation_has_complete_items(
            (select e.id from public.campaign_sale_evaluations e
             where e.verified_sale_id = pg_temp.id('s1')
               and e.campaign_version_id = pg_temp.id('cv_bonus'))), false,
  'A2-2. ...and the helper already knows it is incomplete');

-- ...and that same pending row is what a forced check now rejects.
select is(pg_temp.at_commit('select 1'), 'REFUSED:23514',
  'A2-3. forcing the deferred check REFUSES the transaction while it is incomplete');

-- Complete it, and the transaction becomes valid again.
select is(pg_temp.at_commit(format(
  $q$insert into public.campaign_sale_item_qualifications
       (campaign_sale_evaluation_id, campaign_id, campaign_version_id,
        verified_sale_id, verified_sale_item_id, vendor_product_id,
        qualifying_units, product_source, product_status_at_sale,
        assignment_status_at_sale)
     select e.id, e.campaign_id, e.campaign_version_id, e.verified_sale_id,
            i.id, i.vendor_product_id, i.quantity, 'LIVE_TEMPORAL', 'ACTIVE', 'ACTIVE'
     from public.campaign_sale_evaluations e, public.verified_sale_items i
     where e.verified_sale_id = %L and e.campaign_version_id = %L
       and i.id = %L$q$,
  pg_temp.id('s1'), pg_temp.id('cv_bonus'),
  pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p1')))), 'ALLOWED',
  'A2-4. supplying the declared items makes the same transaction committable');

do $$
begin
  insert into pg_temp.f
  select 'e_done', e.id from public.campaign_sale_evaluations e
  where e.verified_sale_id = pg_temp.id('s1')
    and e.campaign_version_id = pg_temp.id('cv_bonus');
end;
$$;

-- 1. A complete set commits.
select is(pg_temp.try_complete(pg_temp.id('s4'), pg_temp.id('cv_cap'), 1, 3, 1), 'ALLOWED',
  'A2-5. an evaluation carrying exactly its declared items survives commit-time validation');

-- 2. THE BLOCKING DEFECT: QUALIFIED with zero items.
select is(pg_temp.try_complete(pg_temp.id('s2'), pg_temp.id('cv_bonus'), 1, 4, 0),
  'REFUSED:23514',
  'A2-6. a QUALIFIED evaluation with NO item evidence is refused at commit');

-- 3. Declared two, supplied one.
select is(pg_temp.try_complete(pg_temp.id('s1'), pg_temp.id('cv_sel'), 2, 5, 1),
  'REFUSED:23514',
  'A2-7. a declared count of 2 backed by 1 item is refused');

-- 4. Declared units disagree with the actual sum (s1's two items total 5, not 4).
select is(pg_temp.try_complete(pg_temp.id('s1'), pg_temp.id('cv_sel'), 2, 4, 2),
  'REFUSED:23514',
  'A2-8. a declared unit total disagreeing with the item sum is refused');

-- 5. An item set LARGER than declared, not merely smaller.
select is(pg_temp.try_complete(pg_temp.id('s1'), pg_temp.id('cv_sel'), 1, 3, 2),
  'REFUSED:23514',
  'A2-9. an item set larger than declared is refused too');

-- 6/7. Items under a non-qualified envelope. Refused immediately by the per-row
-- assertion, before the deferred check is reached.
do $$
begin
  insert into pg_temp.f values
    ('e_nq', pg_temp.ins_eval(pg_temp.id('s3'), pg_temp.id('cv_x2'),
        p_outcome => 'NOT_QUALIFIED', p_reason => 'PRODUCT_NOT_ELIGIBLE',
        p_items => 0, p_units => 0)),
    ('e_ne', pg_temp.ins_eval(pg_temp.id('s3'), pg_temp.id('cv_x1'),
        p_outcome => 'NOT_EVALUABLE', p_reason => 'NO_TEMPORAL_RECORD',
        p_items => 0, p_units => 0));
end;
$$;
select is(pg_temp.try_item(pg_temp.id('e_nq'),
          pg_temp.item_of(pg_temp.id('s3'), pg_temp.id('p3'))), 'REFUSED:23514',
  'A2-10. an item under a NOT_QUALIFIED evaluation is refused');
select is(pg_temp.try_item(pg_temp.id('e_ne'),
          pg_temp.item_of(pg_temp.id('s3'), pg_temp.id('p3'))), 'REFUSED:23514',
  'A2-11. an item under a NOT_EVALUABLE evaluation is refused');
select is(public.campaign_evaluation_has_complete_items(pg_temp.id('e_ne')), true,
  'A2-12. ...while a zero-count NOT_EVALUABLE envelope with no items is itself complete');

-- 8. THE ITEM-SIDE TRIGGER. e_done was completed and validated in A2-4, so its
-- evaluation-side event is already spent. Appending an extra item afterwards can only
-- be caught by the item-side trigger — which is precisely why there are two.
select is(pg_temp.at_commit(format(
  $q$insert into public.campaign_sale_item_qualifications
       (campaign_sale_evaluation_id, campaign_id, campaign_version_id,
        verified_sale_id, verified_sale_item_id, vendor_product_id,
        qualifying_units, product_source, product_status_at_sale,
        assignment_status_at_sale)
     select e.id, e.campaign_id, e.campaign_version_id, e.verified_sale_id,
            i.id, i.vendor_product_id, i.quantity, 'LIVE_TEMPORAL', 'ACTIVE', 'ACTIVE'
     from public.campaign_sale_evaluations e, public.verified_sale_items i
     where e.id = %L and i.id = %L$q$,
  pg_temp.id('e_done'), pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p2')))),
  'REFUSED:23514',
  'A2-13. an EXTRA item appended to an already-complete evaluation is refused');

-- 9/10/11. The reward boundary. Each probe rolls its own fixture back.
select is(pg_temp.try_reward_on(pg_temp.id('s1'), pg_temp.id('cv_sel'), 0, 2, 5),
  'REFUSED:23514',
  'A2-14. a reward on an ITEMLESS qualified evaluation is refused');
select is(pg_temp.try_reward_on(pg_temp.id('s1'), pg_temp.id('cv_sel'), 1, 2, 5),
  'REFUSED:23514',
  'A2-15. a reward on a PARTIAL-item evaluation is refused');
select is(pg_temp.try_reward_on(pg_temp.id('s1'), pg_temp.id('cv_sel'), 2, 2, 5),
  'ALLOWED',
  'A2-16. a reward on an EXACT complete evaluation is accepted');

-- 12-15. The helper's own contract.
select is(public.campaign_evaluation_has_complete_items(pg_temp.id('e_done')), true,
  'A2-17. the helper is true only for the exact complete set');
select is(public.campaign_evaluation_has_complete_items(gen_random_uuid()), false,
  'A2-18. the helper is false — never null — for a MISSING evaluation');
select is(public.campaign_evaluation_has_complete_items(null), false,
  'A2-19. the helper is false for a null argument');

-- 15/16. The helper is internal. PostgreSQL grants EXECUTE to PUBLIC by default, so
-- this asserts the revoke actually happened rather than assuming it.
select is((select count(*)::integer from information_schema.role_routine_grants
           where routine_schema = 'public'
             and routine_name = 'campaign_evaluation_has_complete_items'
             and grantee in ('anon','authenticated','service_role','PUBLIC')), 0,
  'A2-20. the helper carries no grant to anon, authenticated, service_role or PUBLIC');
select is((select p.proacl::text from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname = 'campaign_evaluation_has_complete_items'),
  '{postgres=X/postgres}',
  'A2-21. ...and only the owner may execute it, matching every other internal helper');
select ok((select p.provolatile = 's' and p.prosecdef
           and p.proconfig @> array['search_path=""']
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname = 'campaign_evaluation_has_complete_items'),
  'A2-22. the helper is STABLE, SECURITY DEFINER, with an empty search_path');

-- The constraint triggers are genuinely deferrable, not ordinary AFTER triggers.
select is((select count(*)::integer from pg_trigger t
           where t.tgname = n and not t.tgisinternal
             and t.tgconstraint <> 0 and t.tgdeferrable and t.tginitdeferred), 1,
  'A2-23. ' || n || ' is a DEFERRABLE INITIALLY DEFERRED constraint trigger')
from unnest(array['campaign_sale_evaluations_assert_complete_items',
                  'campaign_sale_item_qualifications_assert_parent_complete']) as n;


-- ============================================================================
-- SECTION B — COLUMNS, TYPES, CONSTRAINTS, INDEXES
-- ============================================================================
select has_column('public', 'campaign_sale_evaluations', c, 'B1. evaluation has ' || c)
from unnest(array[
  'id','campaign_id','campaign_version_id','verified_sale_id','receipt_submission_id',
  'vendor_organization_id','retailer_organization_id','retailer_shop_id',
  'beneficiary_profile_id','sale_at','performance_scope','reward_recipient_scope',
  'product_scope','product_eligibility_resolution','stacking_mode','exclusivity_key',
  'priority','campaign_starts_at','outcome','non_qualification_reason',
  'qualifying_item_count','qualifying_units','evaluated_at','evaluated_by_profile_id'
]) as c;

select has_column('public', 'campaign_sale_item_qualifications', c, 'B2. item has ' || c)
from unnest(array[
  'id','campaign_sale_evaluation_id','campaign_id','campaign_version_id',
  'verified_sale_id','verified_sale_item_id','vendor_product_id','qualifying_units',
  'product_source','product_status_at_sale','assignment_status_at_sale','created_at'
]) as c;

select has_column('public', 'campaign_rewards', c, 'B3. reward has ' || c)
from unnest(array[
  'id','campaign_sale_evaluation_id','campaign_id','campaign_version_id',
  'verified_sale_id','receipt_submission_id','vendor_organization_id',
  'retailer_organization_id','retailer_shop_id','beneficiary_profile_id',
  'performance_scope','cap_subject_type','cap_subject_id','rule_type','metric_type',
  'coins_per_unit','threshold_units','configured_reward_coins','max_reward_coins',
  'units_counted','coins_uncapped','coins_capped_to','reward_coins','awarded_at'
]) as c;

select has_column('public', 'campaign_subject_accumulators', c, 'B4. accumulator has ' || c)
from unnest(array[
  'campaign_version_id','cap_subject_type','cap_subject_id','units_counted_total',
  'coins_awarded_total','target_bonus_awarded','created_at','updated_at'
]) as c;

-- Coin quantities are bigint; counts are integer. A money-like quantity in a
-- narrower type is a ceiling nobody chose.
select col_type_is('public', 'campaign_rewards', 'coins_uncapped', 'bigint',
  'B5. coins_uncapped is bigint');
select col_type_is('public', 'campaign_rewards', 'reward_coins', 'bigint',
  'B6. reward_coins is bigint');
select col_type_is('public', 'campaign_rewards', 'coins_capped_to', 'bigint',
  'B7. coins_capped_to is bigint');
select col_type_is('public', 'campaign_subject_accumulators', 'coins_awarded_total', 'bigint',
  'B8. coins_awarded_total is bigint');
select col_type_is('public', 'campaign_subject_accumulators', 'units_counted_total', 'bigint',
  'B9. units_counted_total is bigint');
select col_type_is('public', 'campaign_subject_accumulators', 'target_bonus_awarded', 'boolean',
  'B10. target_bonus_awarded is boolean');
select col_type_is('public', 'campaign_sale_evaluations', 'sale_at', 'timestamp with time zone',
  'B11. sale_at is timestamptz');
select col_type_is('public', 'campaign_sale_evaluations', 'qualifying_units', 'integer',
  'B12. qualifying_units is integer');

-- The named CHECKs the later migrations will rely on.
select is((select count(*)::integer from pg_constraint
           where conrelid = 'public.campaign_sale_evaluations'::regclass
             and conname = c and contype = 'c'), 1, 'B13. evaluation CHECK ' || c)
from unnest(array[
  'campaign_sale_evaluations_outcome_allowed',
  'campaign_sale_evaluations_reason_allowed',
  'campaign_sale_evaluations_reason_paired',
  'campaign_sale_evaluations_counts_match_outcome',
  'campaign_sale_evaluations_resolution_matches_scope',
  'campaign_sale_evaluations_exclusivity_paired'
]) as c;

select is((select count(*)::integer from pg_constraint
           where conrelid = 'public.campaign_rewards'::regclass
             and conname = c and contype = 'c'), 1, 'B14. reward CHECK ' || c)
from unnest(array[
  'campaign_rewards_cap_subject_matches_scope',
  'campaign_rewards_reward_is_derived',
  'campaign_rewards_reward_within_cap',
  'campaign_rewards_reward_within_uncapped',
  'campaign_rewards_rate_paired',
  'campaign_rewards_tier_paired'
]) as c;

select is((select count(*)::integer from pg_constraint
           where conrelid = 'public.campaign_sale_item_qualifications'::regclass
             and conname = c and contype = 'c'), 1, 'B15. item CHECK ' || c)
from unnest(array[
  'campaign_sale_item_qualifications_source_allowed',
  'campaign_sale_item_qualifications_live_evidence_paired',
  'campaign_sale_item_qualifications_live_must_be_active'
]) as c;

select is((select count(*)::integer from pg_constraint
           where conrelid = 'public.campaign_subject_accumulators'::regclass
             and conname = c and contype = 'c'), 1, 'B16. accumulator CHECK ' || c)
from unnest(array[
  'campaign_subject_accumulators_subject_allowed',
  'campaign_subject_accumulators_units_non_negative',
  'campaign_subject_accumulators_coins_non_negative'
]) as c;

-- Uniqueness keys.
select has_index('public', 'campaign_sale_evaluations',
  'campaign_sale_evaluations_version_sale_unique_idx',
  'B17. one evaluation per campaign version per sale');
select has_index('public', 'campaign_sale_item_qualifications',
  'campaign_sale_item_qualifications_version_item_unique_idx',
  'B18. one qualification per campaign version per item');
select has_index('public', 'campaign_rewards',
  'campaign_rewards_version_sale_beneficiary_unique_idx',
  'B19. one reward per campaign version per sale per beneficiary');

select ok((select indisunique from pg_index i join pg_class c on c.oid = i.indexrelid
           where c.relname = 'campaign_sale_evaluations_version_sale_unique_idx'),
  'B20. ...and it is genuinely UNIQUE');
select ok((select indisunique from pg_index i join pg_class c on c.oid = i.indexrelid
           where c.relname = 'campaign_rewards_version_sale_beneficiary_unique_idx'),
  'B21. ...as is the reward key');

-- THE partial exclusivity index: unique, partial, and partial on BOTH conditions.
select has_index('public', 'campaign_sale_evaluations',
  'campaign_sale_evaluations_exclusivity_unique_idx',
  'B22. the exclusivity index exists');
select ok((select indisunique from pg_index i join pg_class c on c.oid = i.indexrelid
           where c.relname = 'campaign_sale_evaluations_exclusivity_unique_idx'),
  'B23. the exclusivity index is UNIQUE');
select ok((select pg_get_expr(i.indpred, i.indrelid) is not null
           from pg_index i join pg_class c on c.oid = i.indexrelid
           where c.relname = 'campaign_sale_evaluations_exclusivity_unique_idx'),
  'B24. the exclusivity index is PARTIAL, not total');
select matches(
  (select pg_get_expr(i.indpred, i.indrelid) from pg_index i
   join pg_class c on c.oid = i.indexrelid
   where c.relname = 'campaign_sale_evaluations_exclusivity_unique_idx'),
  'QUALIFIED',
  'B25. ...and its predicate is scoped to QUALIFIED rows');

-- The read-path indexes named in the plan.
select has_index('public', 'campaign_sale_evaluations', i, 'B26. index ' || i)
from unnest(array[
  'campaign_sale_evaluations_sale_idx',
  'campaign_sale_evaluations_vendor_evaluated_idx',
  'campaign_sale_evaluations_version_idx',
  'campaign_sale_evaluations_submission_idx'
]) as i;
select has_index('public', 'campaign_sale_item_qualifications', i, 'B27. index ' || i)
from unnest(array[
  'campaign_sale_item_qualifications_evaluation_idx',
  'campaign_sale_item_qualifications_product_idx',
  'campaign_sale_item_qualifications_sale_idx'
]) as i;
select has_index('public', 'campaign_rewards', i, 'B28. index ' || i)
from unnest(array[
  'campaign_rewards_beneficiary_awarded_idx',
  'campaign_rewards_version_subject_idx',
  'campaign_rewards_evaluation_idx',
  'campaign_rewards_vendor_awarded_idx',
  'campaign_rewards_submission_idx'
]) as i;
select has_index('public', 'campaign_subject_accumulators',
  'campaign_subject_accumulators_subject_idx', 'B29. accumulator subject index');

-- The accumulator's primary key IS the lock target.
select is((select count(*)::integer from pg_constraint
           where conrelid = 'public.campaign_subject_accumulators'::regclass
             and contype = 'p'), 1, 'B30. the accumulator has a primary key');
select is(
  (select array_agg(a.attname::text order by k.ord)
   from pg_constraint con
   join lateral unnest(con.conkey) with ordinality as k(attnum, ord) on true
   join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
   where con.conrelid = 'public.campaign_subject_accumulators'::regclass
     and con.contype = 'p'),
  array['campaign_version_id','cap_subject_type','cap_subject_id']::text[],
  'B31. ...on exactly (version, subject type, subject id)');


-- ============================================================================
-- SECTION C — RLS, GRANTS, AND IMMUTABILITY
-- ============================================================================
select ok((select relrowsecurity from pg_class
           where oid = ('public.' || t)::regclass), 'C1. RLS enabled on ' || t)
from unnest(array['campaign_sale_evaluations','campaign_sale_item_qualifications',
                  'campaign_rewards','campaign_subject_accumulators']) as t;

select is((select count(*)::integer from pg_policies
           where schemaname = 'public' and tablename = t), 0,
  'C2. zero RLS policies on ' || t)
from unnest(array['campaign_sale_evaluations','campaign_sale_item_qualifications',
                  'campaign_rewards','campaign_subject_accumulators']) as t;

-- Deny-all is only deny-all if no privilege was granted alongside it.
select is((select count(*)::integer from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('campaign_sale_evaluations','campaign_sale_item_qualifications',
                                'campaign_rewards','campaign_subject_accumulators')
             and grantee in ('anon','authenticated','service_role','PUBLIC')), 0,
  'C3. no privilege of ANY kind to anon, authenticated, service_role or PUBLIC');

select is((select count(*)::integer from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('campaign_sale_evaluations','campaign_sale_item_qualifications',
                                'campaign_rewards','campaign_subject_accumulators')
             and grantee in ('anon','authenticated','service_role')
             and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')), 0,
  'C4. ...and specifically no DML');

-- Immutability. A real row is created first, so the guard is refusing an UPDATE
-- that would otherwise have succeeded rather than one that had nothing to hit.
-- e_live is a COMPLETE evaluation: s1 carries p1 x3 and p2 x2, so the declared
-- 2 items / 5 units are backed by both item rows. A reward now REQUIRES that
-- completeness, so a fixture that qualified only one line would fail here rather
-- than in the assertion that means to test it.
do $$
declare v_e uuid; v_r uuid;
begin
  v_e := pg_temp.ins_eval(pg_temp.id('s1'), pg_temp.id('cv_stack'), p_items => 2, p_units => 5);
  insert into pg_temp.f values ('e_live', v_e);
  perform pg_temp.try_item(v_e, pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p1')));
  perform pg_temp.try_item(v_e, pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p2')));
  v_r := pg_temp.ins_reward(v_e, 5);
  insert into pg_temp.f values ('r_live', v_r);
end;
$$;

select is(public.campaign_evaluation_has_complete_items(pg_temp.id('e_live')), true,
  'C4b. FIXTURE: e_live really is complete, so later assertions test what they claim');

select is(pg_temp.try_sql(format(
  'update public.campaign_sale_evaluations set qualifying_units = 99 where id = %L',
  pg_temp.id('e_live'))), 'REFUSED:23514', 'C5. an evaluation UPDATE is refused');
select is(pg_temp.try_sql(format(
  'delete from public.campaign_sale_evaluations where id = %L', pg_temp.id('e_live'))),
  'REFUSED:23514', 'C6. an evaluation DELETE is refused');
-- PostgreSQL refuses TRUNCATE on any table carrying PENDING deferred trigger events
-- (55006, "cannot truncate a table with pending trigger events"). Section A2 leaves
-- such events behind, and they would mask the guards under test with an error that has
-- nothing to do with immutability. Flushing them first is what makes the codes below
-- attributable. Every evaluation written so far is complete, so the flush succeeds.
select lives_ok('set constraints all immediate',
  'C6b. pending deferred events flush cleanly — every evaluation so far is complete');
select lives_ok('set constraints all deferred',
  'C6c. ...and deferral is restored for the sections that follow');

-- TRUNCATE on the evaluation table is refused TWICE OVER, and the two mechanisms
-- report different codes, so both are named rather than one being assumed.
--
-- A plain TRUNCATE never reaches the guard at all: campaign_sale_item_qualifications
-- and campaign_rewards both hold a foreign key to this table, and PostgreSQL rejects
-- the statement with 0A000 before any BEFORE TRUNCATE trigger fires. That is a
-- stronger refusal than the guard, not a weaker one — but it is incidental to the
-- reference graph, so it would quietly disappear if those foreign keys ever moved.
select is(pg_temp.try_sql('truncate table public.campaign_sale_evaluations'),
  'REFUSED:0A000',
  'C7. a plain evaluation TRUNCATE is refused by the inbound foreign keys');

-- CASCADE removes that shortcut and reaches the immutable-evidence guard GRAPH.
--
-- What this assertion does NOT establish is WHICH table's guard raised 23514: the
-- cascade also truncates campaign_sale_item_qualifications and campaign_rewards, and
-- either of their guards would produce the same code. Dropping this table's own guard
-- alone still yields 23514 from a downstream one. So the claim is deliberately
-- limited to "the guard graph refuses it", and the per-table catalogue assertions
-- below are what actually pin each individual guard.
select is(pg_temp.try_sql('truncate table public.campaign_sale_evaluations cascade'),
  'REFUSED:23514',
  'C7b. ...and a CASCADE TRUNCATE is refused by the immutable-evidence guard graph');

-- Each evidence table carries its OWN truncate guard. These are the mutation-sensitive
-- assertions: dropping any one guard fails exactly one of them, which the CASCADE
-- assertion above cannot do.
select is((select count(*)::integer from pg_trigger t
           where t.tgrelid = ('public.' || tbl)::regclass
             and t.tgname = tbl || '_guard_truncate'
             and not t.tgisinternal), 1,
  'C7c. ' || tbl || ' carries its own statement-level truncate guard')
from unnest(array['campaign_sale_evaluations','campaign_sale_item_qualifications',
                  'campaign_rewards']) as tbl;

select is((select count(*)::integer from pg_trigger t
           where t.tgrelid = ('public.' || tbl)::regclass
             and t.tgname = tbl || '_guard_change'
             and not t.tgisinternal), 1,
  'C7d. ' || tbl || ' carries its own row-level change guard')
from unnest(array['campaign_sale_evaluations','campaign_sale_item_qualifications',
                  'campaign_rewards']) as tbl;

select is(pg_temp.try_sql(
  'update public.campaign_sale_item_qualifications set qualifying_units = 99'),
  'REFUSED:23514', 'C8. an item qualification UPDATE is refused');
select is(pg_temp.try_sql('delete from public.campaign_sale_item_qualifications'),
  'REFUSED:23514', 'C9. an item qualification DELETE is refused');
select is(pg_temp.try_sql('truncate table public.campaign_sale_item_qualifications'),
  'REFUSED:23514', 'C10. an item qualification TRUNCATE is refused');

select is(pg_temp.try_sql(format(
  'update public.campaign_rewards set reward_coins = 999999 where id = %L',
  pg_temp.id('r_live'))), 'REFUSED:23514', 'C11. a reward UPDATE is refused');
select is(pg_temp.try_sql(format(
  'delete from public.campaign_rewards where id = %L', pg_temp.id('r_live'))),
  'REFUSED:23514', 'C12. a reward DELETE is refused');
select is(pg_temp.try_sql('truncate table public.campaign_rewards'),
  'REFUSED:23514', 'C13. a reward TRUNCATE is refused');

-- The accumulator is the ONE table that must remain writable: it is a cache, and a
-- cache that cannot be maintained is a bug waiting for the arithmetic migration.
select is(pg_temp.try_sql(format(
  $q$insert into public.campaign_subject_accumulators
     (campaign_version_id, cap_subject_type, cap_subject_id, units_counted_total,
      coins_awarded_total)
     values (%L, 'SALES_STAFF_PROFILE', %L, 5, 25)$q$,
  pg_temp.id('cv_stack'), pg_temp.id('staff'))), 'ALLOWED',
  'C14. the accumulator accepts an insert');
select is(pg_temp.try_sql(format(
  $q$update public.campaign_subject_accumulators set coins_awarded_total = 50
     where campaign_version_id = %L$q$, pg_temp.id('cv_stack'))), 'ALLOWED',
  'C15. the accumulator is MUTABLE by design, unlike the evidence tables');


-- ============================================================================
-- SECTION D — LINEAGE ASSERTIONS: EVERY COPIED VALUE IS PROVEN
-- ============================================================================
-- The whole justification for copying beneficiary, instant, tenants and campaign
-- configuration into these rows is that each copy is asserted. If any assertion
-- below stops holding, the copies become the second answer that drifts, and the
-- verified_sales objection to a seller column applies to this table too.
select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x1')), 'ALLOWED',
  'D1. a fully consistent evaluation is accepted');

-- Captured for the item probes in Section F. cv_x1 is LIVE_TEMPORAL and has claimed
-- none of s1's items yet, so an item probe against it is rejected by the constraint
-- under test rather than by the (version, item) unique key.
do $$
begin
  insert into pg_temp.f
  select 'e_x1', e.id from public.campaign_sale_evaluations e
  where e.verified_sale_id = pg_temp.id('s1')
    and e.campaign_version_id = pg_temp.id('cv_x1');
  -- A SNAPSHOT-resolution evaluation, so a SNAPSHOT item probe can be tested without
  -- the product_source/resolution mismatch rejecting first.
  insert into pg_temp.f values
    ('e_snap', pg_temp.ins_eval(pg_temp.id('s1'), pg_temp.id('cv_sel'),
                                p_items => 2, p_units => 5));
end;
$$;

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_campaign => pg_temp.id('cv_stack_campaign')), 'REFUSED:23514',
  'D2. a campaign that is not the version''s own campaign is refused');

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_submission => pg_temp.id('s2_receipt')), 'REFUSED:23514',
  'D3. a receipt that is not the sale''s own receipt is refused');

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_vendor => pg_temp.id('vendor_b')), 'REFUSED:23514',
  'D4. the WRONG VENDOR is refused');

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_retailer => pg_temp.id('retailer_b')), 'REFUSED:23514',
  'D5. the WRONG RETAILER is refused');

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_shop => pg_temp.id('shop2')), 'REFUSED:23514',
  'D6. the WRONG SHOP is refused, even one belonging to the right Retailer');

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_beneficiary => pg_temp.id('staff2')), 'REFUSED:23514',
  'D7. a beneficiary who is not the receipt SUBMITTER is refused');

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_sale_at => now()), 'REFUSED:23514',
  'D8. an INVENTED sale_at is refused; the instant is the sale''s own');

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_priority => 42), 'REFUSED:23514',
  'D9. a priority differing from the campaign version is refused');

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_starts_at => now() - interval '400 days'), 'REFUSED:23514',
  'D10. a campaign_starts_at differing from the version is refused');

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_excl_key => 'SOMETHING ELSE'), 'REFUSED:23514',
  'D11. an exclusivity_key differing from the version is refused');

-- THE TENANT BOUNDARY. campaign_versions_in_force_for_retailer_at answers by
-- Retailer and does NOT filter by Vendor, so this is the assertion standing between
-- one Vendor's campaign and another Vendor's sale.
select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_b')), 'REFUSED:23514',
  'D12. a campaign belonging to a DIFFERENT VENDOR cannot evaluate this sale');

select is(pg_temp.try_eval(pg_temp.id('s_b'), pg_temp.id('cv_stack')), 'REFUSED:23514',
  'D13. ...and the mirror case is refused too');


-- ============================================================================
-- SECTION E — THE COMPLETENESS GATE AND ACTIVE EXCLUSION
-- ============================================================================
-- This is the section that matters most. decision = 'ACCEPTED' is a fact a direct
-- writer can manufacture; a complete item set is not.
select is(pg_temp.try_eval(pg_temp.id('s_bad'), pg_temp.id('cv_stack')), 'REFUSED:23514',
  'E1. an INCOMPLETE ACCEPTED decision cannot produce an evaluation');

select is(
  (select d.decision from public.receipt_product_review_decisions d
   where d.receipt_submission_id = pg_temp.id('s_bad_receipt')), 'ACCEPTED',
  'E2. ...and the refusal is NOT because the decision was missing or rejected');

select is((select count(*)::integer from public.verified_sale_items i
           where i.verified_sale_id = pg_temp.id('s_bad')), 0,
  'E3. ...it is because the item set is empty, which is the migration-64 limitation');

select is(pg_temp.try_eval(pg_temp.id('s_excl'), pg_temp.id('cv_stack')), 'REFUSED:42501',
  'E4. a receipt with an ACTIVE EXCLUSION cannot produce an evaluation');

-- The exclusion arrived AFTER the sale was complete, which is the ordering the
-- deployed schema permits and the one a reward engine must survive.
select ok(public.receipt_has_finalized_sale_items(pg_temp.id('s_excl_receipt')),
  'E5. ...even though that receipt DOES have a complete finalized item set');

-- Reward and item qualification re-check independently. An exclusion recorded
-- between an evaluation and its reward must stop the reward, and the evaluation row
-- cannot know about it.
-- e_s3 is COMPLETE before the exclusion is recorded. An incomplete envelope would be
-- refused a reward by the completeness check, and this section would then prove nothing
-- about exclusion.
do $$
declare v_e uuid;
begin
  v_e := pg_temp.complete_eval(pg_temp.id('s3'), pg_temp.id('cv_stack'));
  insert into pg_temp.f values ('e_s3', v_e);
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.record_claim_receipt_qualification(
    pg_temp.id('s3_receipt'), 'EXCLUDE', 'DUPLICATE', null);
  perform pg_temp.sign_out();
end;
$$;

select is(pg_temp.try_reward(pg_temp.id('e_s3'), 1), 'REFUSED:42501',
  'E6. an exclusion recorded AFTER the evaluation still blocks the reward');
select is(pg_temp.try_item(pg_temp.id('e_s3'), pg_temp.item_of(pg_temp.id('s3'), pg_temp.id('p3'))),
  'REFUSED:42501',
  'E7. ...and blocks a later item qualification too');

-- Locked decision 8: the evidence already written is never deleted or mutated.
select is((select count(*)::integer from public.campaign_sale_evaluations e
           where e.id = pg_temp.id('e_s3')), 1,
  'E8. the evaluation written BEFORE the exclusion still stands, untouched');


-- ============================================================================
-- SECTION F — VOCABULARY AND ARITHMETIC CONSTRAINTS
-- ============================================================================
select is(pg_temp.try_eval(pg_temp.id('s2'), pg_temp.id('cv_stack'),
          p_outcome => 'MAYBE', p_items => 0, p_units => 0), 'REFUSED:23514',
  'F1. an unknown outcome is refused');

select is(pg_temp.try_eval(pg_temp.id('s2'), pg_temp.id('cv_stack'),
          p_outcome => 'QUALIFIED', p_reason => 'NO_QUALIFYING_ITEMS'), 'REFUSED:23514',
  'F2. QUALIFIED carrying a non-qualification reason is refused');

select is(pg_temp.try_eval(pg_temp.id('s2'), pg_temp.id('cv_stack'),
          p_outcome => 'NOT_QUALIFIED', p_reason => null,
          p_items => 0, p_units => 0), 'REFUSED:23514',
  'F3. NOT_QUALIFIED without a reason is refused');

select is(pg_temp.try_eval(pg_temp.id('s2'), pg_temp.id('cv_stack'),
          p_outcome => 'NOT_EVALUABLE', p_reason => null,
          p_items => 0, p_units => 0), 'REFUSED:23514',
  'F4. NOT_EVALUABLE without a reason is refused');

select is(pg_temp.try_eval(pg_temp.id('s2'), pg_temp.id('cv_stack'),
          p_outcome => 'NOT_QUALIFIED', p_reason => 'BECAUSE_I_SAID_SO',
          p_items => 0, p_units => 0), 'REFUSED:23514',
  'F5. a reason outside the closed vocabulary is refused');

select is(pg_temp.try_eval(pg_temp.id('s2'), pg_temp.id('cv_stack'),
          p_outcome => 'QUALIFIED', p_items => 0, p_units => 0), 'REFUSED:23514',
  'F6. QUALIFIED with zero items and zero units is refused');

select is(pg_temp.try_eval(pg_temp.id('s2'), pg_temp.id('cv_stack'),
          p_outcome => 'NOT_QUALIFIED', p_reason => 'NO_QUALIFYING_ITEMS',
          p_items => 1, p_units => 1), 'REFUSED:23514',
  'F7. NOT_QUALIFIED that nevertheless counted something is refused');

select is(pg_temp.try_eval(pg_temp.id('s2'), pg_temp.id('cv_stack'),
          p_items => -1, p_units => -5), 'REFUSED:23514',
  'F8. negative evaluation counts are refused');

select is(pg_temp.try_eval(pg_temp.id('s2'), pg_temp.id('cv_stack'),
          p_items => 2, p_units => 9999), 'REFUSED:23514',
  'F9. more units than one sale can hold is refused');

-- Each of the seven reason tokens the matching migration will need is storable.
select is(pg_temp.try_sql(format(
  $q$insert into public.campaign_sale_evaluations
       (campaign_id, campaign_version_id, verified_sale_id, receipt_submission_id,
        vendor_organization_id, retailer_organization_id, retailer_shop_id,
        beneficiary_profile_id, sale_at, performance_scope, reward_recipient_scope,
        product_scope, product_eligibility_resolution, stacking_mode, priority,
        campaign_starts_at, outcome, non_qualification_reason, evaluated_by_profile_id)
     select cv.campaign_id, cv.id, v.id, v.receipt_submission_id,
            v.vendor_organization_id, v.retailer_organization_id, v.retailer_shop_id,
            s.submitted_by_profile_id, v.sale_at, cv.performance_scope,
            cv.reward_recipient_scope, cv.product_scope,
            cv.product_eligibility_resolution, cv.stacking_mode, cv.priority,
            cv.starts_at, 'NOT_QUALIFIED', %L, %L
     from public.verified_sales v
     join public.receipt_submissions s on s.id = v.receipt_submission_id
     join public.campaign_versions cv on cv.id = %L
     where v.id = %L$q$,
  r, pg_temp.id('rev'), pg_temp.id('cv_sel'), pg_temp.id('s2'))),
  'ALLOWED', 'F10. reason token is storable: ' || r)
from unnest(array['NO_QUALIFYING_ITEMS']) as r;

-- Item qualification vocabulary. These probe e_x1, which has claimed no item of s1,
-- so the (campaign_version_id, verified_sale_item_id) unique key cannot be the first
-- constraint to reject and mask the one under test.
select is(pg_temp.try_item(pg_temp.id('e_x1'),
          pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p2')),
          p_source => 'GUESSED'), 'REFUSED:23514',
  'F11. an unknown product_source is refused');

-- F12 and F13 are both refused; the immediate assertion and the units CHECK agree
-- here, so neither label attributes the refusal to one particular mechanism.
select is(pg_temp.try_item(pg_temp.id('e_x1'),
          pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p2')),
          p_units => 0), 'REFUSED:23514',
  'F12. zero qualifying units on an item is refused');

select is(pg_temp.try_item(pg_temp.id('e_x1'),
          pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p2')),
          p_units => 99), 'REFUSED:23514',
  'F13. units differing from the item''s own quantity are refused');

-- Locked decision 4 made structural: LIVE_TEMPORAL records sale-time evidence,
-- SNAPSHOT must not, because a SNAPSHOT campaign never performed that check.
--
-- e_x1 IS LIVE_TEMPORAL, so product_source matches its evaluation and the only thing
-- left to reject this row is live_must_be_active — the constraint under test.
select is(pg_temp.try_item(pg_temp.id('e_x1'),
          pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p2')),
          p_status => 'INACTIVE'), 'REFUSED:23514',
  'F14. a LIVE_TEMPORAL item qualifying while INACTIVE at sale time is refused');

-- The mirror case, probed against e_snap — a SELECTED_PRODUCTS / SNAPSHOT evaluation.
-- Using a SNAPSHOT evaluation is what makes this isolate live_evidence_paired: against
-- a LIVE_TEMPORAL evaluation the row would be rejected earlier for naming the wrong
-- resolution, and the test would pass without ever reaching the constraint it names.
select is(pg_temp.try_sql(format(
  $q$insert into public.campaign_sale_item_qualifications
       (campaign_sale_evaluation_id, campaign_id, campaign_version_id,
        verified_sale_id, verified_sale_item_id, vendor_product_id,
        qualifying_units, product_source, product_status_at_sale)
     select e.id, e.campaign_id, e.campaign_version_id, e.verified_sale_id,
            %L, %L, 2, 'SNAPSHOT', 'ACTIVE'
     from public.campaign_sale_evaluations e where e.id = %L$q$,
  pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p2')), pg_temp.id('p2'),
  pg_temp.id('e_snap'))), 'REFUSED:23514',
  'F15. a SNAPSHOT item carrying sale-time status evidence is refused');

select is((select e.product_eligibility_resolution
           from public.campaign_sale_evaluations e where e.id = pg_temp.id('e_snap')),
  'SNAPSHOT',
  'F15b. ...and e_snap really is a SNAPSHOT evaluation, so F15 isolated its CHECK');

-- Reward arithmetic.
select is(pg_temp.try_reward(pg_temp.id('e_live'), 5, p_uncapped => 25, p_reward => -1),
  'REFUSED:23514', 'F16. a negative reward is refused');

select is(pg_temp.try_reward(pg_temp.id('e_live'), 5, p_uncapped => 25, p_reward => 99),
  'REFUSED:23514', 'F17. a reward larger than the uncapped amount is refused');

select is(pg_temp.try_reward(pg_temp.id('e_live'), 0), 'REFUSED:23514',
  'F18. a reward counting zero units is refused');

-- Accumulator vocabulary and bounds.
select is(pg_temp.try_sql(format(
  $q$insert into public.campaign_subject_accumulators
     (campaign_version_id, cap_subject_type, cap_subject_id)
     values (%L, 'SOME_OTHER_THING', %L)$q$,
  pg_temp.id('cv_x1'), pg_temp.id('staff'))), 'REFUSED:23514',
  'F19. an unknown cap subject type is refused');

select is(pg_temp.try_sql(format(
  $q$insert into public.campaign_subject_accumulators
     (campaign_version_id, cap_subject_type, cap_subject_id, coins_awarded_total)
     values (%L, 'SALES_STAFF_PROFILE', %L, -1)$q$,
  pg_temp.id('cv_x1'), pg_temp.id('staff'))), 'REFUSED:23514',
  'F20. a negative accumulator coin total is refused');

select is(pg_temp.try_sql(format(
  $q$insert into public.campaign_subject_accumulators
     (campaign_version_id, cap_subject_type, cap_subject_id, units_counted_total)
     values (%L, 'SALES_STAFF_PROFILE', %L, -1)$q$,
  pg_temp.id('cv_x1'), pg_temp.id('staff'))), 'REFUSED:23514',
  'F21. a negative accumulator unit total is refused');


-- ============================================================================
-- SECTION G — REWARD LINEAGE, RULE EVIDENCE, AND THE APPROVED CAP BEHAVIOUR
-- ============================================================================
-- Two COMPLETE evaluations that carry no reward yet: e_g1 receives the valid one,
-- e_g2 absorbs the probes below so none of them can be rejected first by the
-- (version, sale, beneficiary) unique key instead of the constraint under test.
do $$
begin
  insert into pg_temp.f values
    ('e_g1', pg_temp.complete_eval(pg_temp.id('s2'), pg_temp.id('cv_stack'))),
    ('e_g2', pg_temp.complete_eval(pg_temp.id('s2'), pg_temp.id('cv_x2')));
end;
$$;

-- s2 is one line of 4 units, and cv_stack pays 5 a unit, so 4 x 5 = 20.
select is(pg_temp.try_reward(pg_temp.id('e_g1'), 4), 'ALLOWED',
  'G1. a reward consistent with its campaign version''s rule is accepted');

-- A reward whose rule evidence does not match the immutable campaign version is a
-- reward nobody can audit.
select is(pg_temp.try_reward(pg_temp.id('e_g2'), 4, p_rate => 999),
  'REFUSED:23514', 'G2. a coins_per_unit differing from the campaign rule is refused');

select is(pg_temp.try_reward(pg_temp.id('e_g2'), 4, p_cap => 5000),
  'REFUSED:23514', 'G3. a max_reward_coins differing from the campaign rule is refused');

-- A reward requires a QUALIFIED evaluation.
do $$
declare v_e uuid;
begin
  v_e := pg_temp.ins_eval(pg_temp.id('s2'), pg_temp.id('cv_x1'),
           p_outcome => 'NOT_QUALIFIED', p_reason => 'PRODUCT_NOT_ELIGIBLE',
           p_items => 0, p_units => 0);
  insert into pg_temp.f values ('e_notqual', v_e);
end;
$$;
select is(pg_temp.try_reward(pg_temp.id('e_notqual'), 4), 'REFUSED:23514',
  'G4. a reward for a NOT_QUALIFIED evaluation is refused');

-- The cap subject is derived from performance_scope, never chosen.
select is(pg_temp.try_reward(pg_temp.id('e_g2'), 4,
          p_subject_type => 'RETAILER_ORGANIZATION',
          p_subject_id => pg_temp.id('retailer_a')), 'REFUSED:23514',
  'G5. an INDIVIDUAL_STAFF reward with a Retailer cap subject is refused');

select is(pg_temp.try_reward(pg_temp.id('e_g2'), 4,
          p_subject_id => pg_temp.id('staff')), 'REFUSED:23514',
  'G6. a cap subject that is not the beneficiary is refused under INDIVIDUAL_STAFF');

-- RETAILER_TEAM: locked decision 3. The subject is the Retailer, the payee is still
-- the contributing staff member.
do $$
begin
  insert into pg_temp.f values
    ('e_bonus', pg_temp.complete_eval(pg_temp.id('s4'), pg_temp.id('cv_bonus')));
end;
$$;
select is(pg_temp.try_reward(pg_temp.id('e_bonus'), 3), 'ALLOWED',
  'G7. a RETAILER_TEAM TARGET_BONUS reward with a Retailer cap subject is accepted');
select is(
  (select r.beneficiary_profile_id from public.campaign_rewards r
   where r.campaign_version_id = pg_temp.id('cv_bonus')), pg_temp.id('staff2'),
  'G8. ...and the BENEFICIARY is still the contributing staff member');
select is(
  (select r.cap_subject_id from public.campaign_rewards r
   where r.campaign_version_id = pg_temp.id('cv_bonus')), pg_temp.id('retailer_a'),
  'G9. ...while the CAP SUBJECT is the Retailer');
select is(
  (select r.reward_coins from public.campaign_rewards r
   where r.campaign_version_id = pg_temp.id('cv_bonus')), 500::bigint,
  'G10. ...and the full configured bonus is paid once');

-- Locked decision 6: partial award, and a genuine zero.
do $$
begin
  insert into pg_temp.f values
    ('e_cap',  pg_temp.complete_eval(pg_temp.id('s1'), pg_temp.id('cv_cap'))),
    ('e_cap2', pg_temp.complete_eval(pg_temp.id('s2'), pg_temp.id('cv_cap')));
end;
$$;

-- s1's own 5 units x 10 coins = 50 uncapped; the cap is 30, so 30 is paid.
select is(pg_temp.try_reward(pg_temp.id('e_cap'), 5, p_capped => 30),
  'ALLOWED', 'G11. a PARTIAL capped award is accepted');
select is(
  (select r.reward_coins from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_cap')), 30::bigint,
  'G12. ...and reward_coins is the capped amount');
select is(
  (select r.coins_uncapped from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_cap')), 50::bigint,
  'G13. ...while coins_uncapped still records what the rule alone produced');

-- The cap is now exhausted: a real qualification worth zero coins. s2 is 4 units,
-- so the uncapped amount is a genuine 40 and only the CAP drives the zero.
select is(pg_temp.try_reward(pg_temp.id('e_cap2'), 4, p_capped => 0),
  'ALLOWED', 'G14. a ZERO reward for a cap-exhausted qualification is accepted');
select is(
  (select r.reward_coins from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_cap2')), 0::bigint,
  'G15. ...and it really is zero, with the qualification intact');
select is(
  (select r.coins_uncapped from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_cap2')), 40::bigint,
  'G15b. ...while its uncapped amount stays the positive rule result, never an arbitrary zero');
select is(
  (select e.outcome from public.campaign_sale_evaluations e where e.id = pg_temp.id('e_cap2')),
  'QUALIFIED',
  'G16. ...which is exactly why qualification and reward are separate tables');

-- No cap can ever be exceeded, whatever an evaluator computes. 4 units x 10 = 40
-- uncapped, capped_to 35, against a cap of 30.
select is(pg_temp.try_reward(pg_temp.id('e_g2'), 4, p_capped => 35, p_cap => 30),
  'REFUSED:23514', 'G17. a reward exceeding max_reward_coins is refused');

-- Item qualifications must belong to the evaluation's own sale.
select is(pg_temp.try_item(pg_temp.id('e_live'),
          pg_temp.item_of(pg_temp.id('s2'), pg_temp.id('p1'))), 'REFUSED:23514',
  'G18. an item from a DIFFERENT SALE is refused');

select is(pg_temp.try_item(pg_temp.id('e_notqual'),
          pg_temp.item_of(pg_temp.id('s2'), pg_temp.id('p1'))), 'REFUSED:23514',
  'G19. an item qualification under a NOT_QUALIFIED evaluation is refused');

select is(pg_temp.try_item(pg_temp.id('e_live'),
          pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p2')),
          p_product => pg_temp.id('p3')), 'REFUSED:23514',
  'G20. an item qualification naming the wrong product is refused');


-- ============================================================================
-- SECTION H — UNIQUENESS, AND THE EXCLUSIVITY GUARANTEE
-- ============================================================================
select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_stack')), 'REFUSED:23505',
  'H1. a SECOND evaluation of the same sale by the same campaign version is refused');

select is(pg_temp.try_item(pg_temp.id('e_live'),
          pg_temp.item_of(pg_temp.id('s1'), pg_temp.id('p1'))), 'REFUSED:23505',
  'H2. a SECOND qualification of the same item by the same version is refused');

select is(pg_temp.try_reward(pg_temp.id('e_live'), 5), 'REFUSED:23505',
  'H3. a SECOND reward for the same version, sale and beneficiary is refused');

-- THE GUARANTEE. cv_x1 already qualified s1 in D1. cv_x2 shares its exclusivity key.
select is((select e.exclusivity_key from public.campaign_sale_evaluations e
           where e.verified_sale_id = pg_temp.id('s1')
             and e.campaign_version_id = pg_temp.id('cv_x1')), 'GROUP ONE',
  'H4. FIXTURE: cv_x1 qualified s1 under exclusivity key GROUP ONE');

select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2')), 'REFUSED:23505',
  'H5. a SECOND QUALIFIED campaign under the same key, same sale, is UNSTORABLE');

-- The loser's audit trail is still recordable — that is the point of scoping the
-- index to QUALIFIED rows rather than to every row.
select is(pg_temp.try_eval(pg_temp.id('s1'), pg_temp.id('cv_x2'),
          p_outcome => 'NOT_QUALIFIED', p_reason => 'SUPPRESSED_BY_EXCLUSIVITY',
          p_items => 0, p_units => 0), 'ALLOWED',
  'H6. ...but the SUPPRESSED loser can still record why it lost');

-- The same key on a DIFFERENT sale is a different question entirely: locked
-- decision 2 scopes exclusivity per complete verified sale, so s4 is free to be
-- claimed by the same key that is already spent on s1.
select is(pg_temp.try_eval(pg_temp.id('s4'), pg_temp.id('cv_x1'), p_items => 1, p_units => 3),
  'ALLOWED', 'H7. the same exclusivity key on a DIFFERENT sale is allowed');

-- STACKABLE campaigns carry a NULL key. A unique index over a nullable column would
-- treat every null as distinct anyway, but the predicate excludes them explicitly so
-- the intent does not rest on that.
select is(pg_temp.try_eval(pg_temp.id('s4'), pg_temp.id('cv_stack'), p_items => 1, p_units => 3),
  'ALLOWED', 'H8. a STACKABLE (null-key) evaluation is not blocked by the exclusivity index');
select is(pg_temp.try_eval(pg_temp.id('s4'), pg_temp.id('cv_sel'), p_items => 1, p_units => 3),
  'ALLOWED', 'H9. ...nor is a second STACKABLE campaign on the same sale');

-- One EXCLUSIVE winner and two STACKABLE campaigns, all qualifying one sale — the
-- shape the matching migration has to be able to produce.
select ok((select count(*) from public.campaign_sale_evaluations e
           where e.verified_sale_id = pg_temp.id('s4') and e.outcome = 'QUALIFIED') >= 3,
  'H10. ...so several STACKABLE campaigns really can qualify one sale');

select is(pg_temp.try_eval(pg_temp.id('s4'), pg_temp.id('cv_x2'), p_items => 1, p_units => 3),
  'REFUSED:23505',
  'H11. ...while the second EXCLUSIVE campaign in that key is still refused on it');


-- ============================================================================
-- SECTION I — THE ACCUMULATOR IS A CACHE, AND MUST RECONSTRUCT
-- ============================================================================
-- The migration states two identities in a comment, and they draw on DIFFERENT
-- tables. A comment is not a test, so both are asserted here against evidence this
-- suite actually wrote — including the TARGET_BONUS case where the two sources
-- genuinely disagree and reconstructing units from the wrong one is silently wrong.

-- ---- PER_UNIT_COINS: two rewarded sales for ONE subject -------------------------
-- s2 and s4 were both submitted by staff2, so cv_recon gives that subject two
-- qualifying sales (4 units and 3 units) and two rewards (8 and 6 coins at 2/unit).
do $$
begin
  insert into pg_temp.f values
    ('e_r1', pg_temp.complete_eval(pg_temp.id('s2'), pg_temp.id('cv_recon'))),
    ('e_r2', pg_temp.complete_eval(pg_temp.id('s4'), pg_temp.id('cv_recon')));
  perform pg_temp.ins_reward(pg_temp.id('e_r1'), 4);
  perform pg_temp.ins_reward(pg_temp.id('e_r2'), 3);
end;
$$;

-- The subject is DERIVED from performance_scope, exactly as a reconstruction must do,
-- rather than read from an unrelated fixture value.
select is(
  (select coalesce(sum(e.qualifying_units), 0)::bigint
   from public.campaign_sale_evaluations e
   where e.campaign_version_id = pg_temp.id('cv_recon')
     and e.outcome = 'QUALIFIED' and e.qualifying_units > 0
     and case when e.performance_scope = 'INDIVIDUAL_STAFF'
              then e.beneficiary_profile_id else e.retailer_organization_id end
         = pg_temp.id('staff2')),
  7::bigint,
  'I1. PER_UNIT: units_counted_total reconstructs from campaign_sale_evaluations');

select is(
  (select coalesce(sum(r.reward_coins), 0)::bigint from public.campaign_rewards r
   where r.campaign_version_id = pg_temp.id('cv_recon')
     and r.cap_subject_id = pg_temp.id('staff2')),
  14::bigint,
  'I2. PER_UNIT: coins_awarded_total reconstructs from campaign_rewards');

-- Where a reward exists, the two sources agree — that is what the unit-equality
-- assertion buys, and it is why only TARGET_BONUS needs the distinction.
select is(
  (select coalesce(sum(r.units_counted), 0)::bigint from public.campaign_rewards r
   where r.campaign_version_id = pg_temp.id('cv_recon')
     and r.cap_subject_id = pg_temp.id('staff2')),
  7::bigint,
  'I3. PER_UNIT: reward units agree with evaluation units, because every sale was rewarded');

-- ---- TARGET_BONUS: the case where the two sources DISAGREE ----------------------
-- cv_bonus is RETAILER_TEAM, so every qualifying sale in retailer_a shares one
-- subject. Two sales have qualified by this point — e_done (3 units, pre-threshold,
-- NO reward) and e_bonus (3 units, the crossing sale) — and only the crossing sale
-- carries a reward row.
select is(
  (select count(*)::integer from public.campaign_sale_evaluations e
   where e.campaign_version_id = pg_temp.id('cv_bonus') and e.outcome = 'QUALIFIED'),
  2,
  'I4. TARGET_BONUS: two qualifying sales contributed to the threshold');

select is(
  (select count(*)::integer from public.campaign_rewards r
   where r.campaign_version_id = pg_temp.id('cv_bonus')),
  1,
  'I5. ...but only ONE of them produced a reward row');

select is(
  (select coalesce(sum(e.qualifying_units), 0)::bigint
   from public.campaign_sale_evaluations e
   where e.campaign_version_id = pg_temp.id('cv_bonus')
     and e.outcome = 'QUALIFIED' and e.qualifying_units > 0
     and case when e.performance_scope = 'INDIVIDUAL_STAFF'
              then e.beneficiary_profile_id else e.retailer_organization_id end
         = pg_temp.id('retailer_a')),
  6::bigint,
  'I6. TARGET_BONUS: units_counted_total reconstructs to 6 from the evaluations');

-- THE ASSERTION THAT FAILS IF THE RECONSTRUCTION IS CHANGED BACK.
select is(
  (select coalesce(sum(r.units_counted), 0)::bigint from public.campaign_rewards r
   where r.campaign_version_id = pg_temp.id('cv_bonus')
     and r.cap_subject_id = pg_temp.id('retailer_a')),
  3::bigint,
  'I7. ...while summing campaign_rewards.units_counted gives only 3');

select isnt(
  (select coalesce(sum(r.units_counted), 0)::bigint from public.campaign_rewards r
   where r.campaign_version_id = pg_temp.id('cv_bonus')
     and r.cap_subject_id = pg_temp.id('retailer_a')),
  (select coalesce(sum(e.qualifying_units), 0)::bigint
   from public.campaign_sale_evaluations e
   where e.campaign_version_id = pg_temp.id('cv_bonus')
     and e.outcome = 'QUALIFIED' and e.qualifying_units > 0
     and case when e.performance_scope = 'INDIVIDUAL_STAFF'
              then e.beneficiary_profile_id else e.retailer_organization_id end
         = pg_temp.id('retailer_a')),
  'I8. the two sources DISAGREE under TARGET_BONUS — rewards are not the unit source');

select is(
  (select coalesce(sum(r.reward_coins), 0)::bigint from public.campaign_rewards r
   where r.campaign_version_id = pg_temp.id('cv_bonus')
     and r.cap_subject_id = pg_temp.id('retailer_a')),
  500::bigint,
  'I9. TARGET_BONUS: coins_awarded_total still reconstructs from campaign_rewards');

-- The flag is the EXISTENCE of the authoritative bonus reward, not a positive amount:
-- a cap could legitimately zero the coins without un-awarding the bonus.
select ok(
  (select exists (select 1 from public.campaign_rewards r
                  where r.campaign_version_id = pg_temp.id('cv_bonus')
                    and r.cap_subject_id = pg_temp.id('retailer_a')
                    and r.rule_type = 'TARGET_BONUS')),
  'I10. target_bonus_awarded reconstructs from the existence of the TARGET_BONUS reward');

-- ---- THE ZERO-COIN BONUS: where the two reconstructions DISAGREE ----------------
-- cv_bonus is uncapped, so its reward carries 500 coins and an existence-based
-- reconstruction and a `reward_coins > 0` one give the same answer. That makes I10
-- true but NOT discriminating: a regression to the coins form would pass unnoticed.
--
-- cv_bz is a capped TARGET_BONUS campaign whose subject cap is already spent. The
-- bonus IS awarded — the row exists, and coins_uncapped records the full configured
-- 400 — but the cap reduces the payable amount to zero. Reconstructing the flag from
-- reward_coins would report the bonus as never awarded, and a later evaluator could
-- then award it a second time.
do $$
begin
  insert into pg_temp.f values
    ('e_bz', pg_temp.complete_eval(pg_temp.id('s2'), pg_temp.id('cv_bz')));
  -- s2 is 4 units. The configured bonus is 400; remaining headroom is 0.
  perform pg_temp.ins_reward(pg_temp.id('e_bz'), 4, p_capped => 0);
end;
$$;

select is((select count(*)::integer from public.campaign_rewards r
           where r.campaign_sale_evaluation_id = pg_temp.id('e_bz')), 1,
  'I10a. a TARGET_BONUS reward row exists for the capped campaign');
select is((select r.rule_type from public.campaign_rewards r
           where r.campaign_sale_evaluation_id = pg_temp.id('e_bz')), 'TARGET_BONUS',
  'I10b. ...and it really is a TARGET_BONUS award');
select is((select r.coins_uncapped from public.campaign_rewards r
           where r.campaign_sale_evaluation_id = pg_temp.id('e_bz')), 400::bigint,
  'I10c. ...whose uncapped amount is the full configured bonus, positive');
select is((select r.coins_capped_to from public.campaign_rewards r
           where r.campaign_sale_evaluation_id = pg_temp.id('e_bz')), 0::bigint,
  'I10d. ...capped to zero by an exhausted subject cap');
select is((select r.reward_coins from public.campaign_rewards r
           where r.campaign_sale_evaluation_id = pg_temp.id('e_bz')), 0::bigint,
  'I10e. ...so the payable amount is zero');
select is((select r.units_counted from public.campaign_rewards r
           where r.campaign_sale_evaluation_id = pg_temp.id('e_bz')),
          (select e.qualifying_units from public.campaign_sale_evaluations e
           where e.id = pg_temp.id('e_bz')),
  'I10f. ...while every qualifying unit is still counted');

-- THE DISCRIMINATING PAIR. These two queries differ ONLY in how they decide the flag.
select ok(
  (select exists (select 1 from public.campaign_rewards r
                  where r.campaign_version_id = pg_temp.id('cv_bz')
                    and r.cap_subject_id = pg_temp.id('staff2')
                    and r.rule_type = 'TARGET_BONUS')),
  'I10g. EXISTENCE-based reconstruction correctly reports the bonus as awarded');

select ok(
  not (select exists (select 1 from public.campaign_rewards r
                      where r.campaign_version_id = pg_temp.id('cv_bz')
                        and r.cap_subject_id = pg_temp.id('staff2')
                        and r.rule_type = 'TARGET_BONUS'
                        and r.reward_coins > 0)),
  'I10h. ...while a reward_coins > 0 reconstruction wrongly reports it as NOT awarded');

select isnt(
  (select exists (select 1 from public.campaign_rewards r
                  where r.campaign_version_id = pg_temp.id('cv_bz')
                    and r.cap_subject_id = pg_temp.id('staff2')
                    and r.rule_type = 'TARGET_BONUS')),
  (select exists (select 1 from public.campaign_rewards r
                  where r.campaign_version_id = pg_temp.id('cv_bz')
                    and r.cap_subject_id = pg_temp.id('staff2')
                    and r.rule_type = 'TARGET_BONUS'
                    and r.reward_coins > 0)),
  'I10i. the two reconstructions demonstrably DISAGREE on this row');

-- The approved value, stated once, using the approved rule.
select is(
  (select exists (select 1 from public.campaign_rewards r
                  where r.campaign_version_id = pg_temp.id('cv_bz')
                    and r.cap_subject_id = pg_temp.id('staff2')
                    and r.rule_type = 'TARGET_BONUS')),
  true,
  'I10j. target_bonus_awarded is TRUE for this subject and version');

-- The accumulator carries no foreign key to the subject, on purpose: it is a
-- profile under one scope and an organization under the other.
select is((select count(*)::integer from pg_constraint
           where conrelid = 'public.campaign_subject_accumulators'::regclass
             and contype = 'f'
             and conkey = array[(select attnum from pg_attribute
                                 where attrelid = 'public.campaign_subject_accumulators'::regclass
                                   and attname = 'cap_subject_id')]), 0,
  'I11. cap_subject_id carries no foreign key, because it is polymorphic');

select is((select count(*)::integer from pg_constraint
           where conrelid = 'public.campaign_subject_accumulators'::regclass
             and contype = 'f'
             and conkey = array[(select attnum from pg_attribute
                                 where attrelid = 'public.campaign_subject_accumulators'::regclass
                                   and attname = 'campaign_version_id')]), 1,
  'I12. ...while campaign_version_id, which is not polymorphic, does carry one');


-- ============================================================================
-- SECTION M — THE REWARD ROW'S OWN ARITHMETIC
-- ============================================================================
-- coins_uncapped is not a free-text number. Every input needed to check it is in the
-- row, so a row that contradicts itself is refusable without any calculation engine.
do $$
begin
  insert into pg_temp.f values
    ('e_m',  pg_temp.complete_eval(pg_temp.id('s4'), pg_temp.id('cv_m'))),
    ('e_m2', pg_temp.complete_eval(pg_temp.id('s2'), pg_temp.id('cv_bonus')));
end;
$$;

-- cv_m pays 4 a unit and s4 is a single line of 3 units, so 3 x 4 = 12.
select is(pg_temp.try_reward(pg_temp.id('e_m'), 3, p_uncapped => 12), 'ALLOWED',
  'M1. PER_UNIT_COINS with correct multiplication is accepted');
select is(pg_temp.try_reward(pg_temp.id('e_m'), 3, p_uncapped => 13), 'REFUSED:23514',
  'M2. PER_UNIT_COINS with INCORRECT multiplication is refused');
select is(pg_temp.try_reward(pg_temp.id('e_m'), 3, p_uncapped => 0, p_reward => 0),
  'REFUSED:23514',
  'M3. an arbitrary ZERO uncapped amount for a positive rule is refused');

-- TARGET_BONUS: the uncapped amount is the configured bonus, exactly.
select is(
  (select r.coins_uncapped from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_bonus')), 500::bigint,
  'M4. TARGET_BONUS records the configured bonus as its uncapped amount');

select is(pg_temp.try_reward(pg_temp.id('e_m2'), 4, p_uncapped => 499), 'REFUSED:23514',
  'M5. a TARGET_BONUS uncapped amount that is not the configured bonus is refused');

-- Cap interaction is unaffected: partial and cap-exhausted zero both remain legal,
-- and both were exercised against real rule arithmetic in G11-G15b.
select is(
  (select r.coins_capped_to from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_cap')), 30::bigint,
  'M6. a partial cap award still records its capped amount');
select is(
  (select r.coins_capped_to from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_cap2')), 0::bigint,
  'M7. a cap-exhausted award still records a capped amount of zero');

-- Overflow safety. The largest product these constraints can evaluate is
-- 1e9 x 5000 = 5e12, inside the uncapped ceiling and far inside bigint. A value above
-- the ceiling is refused rather than stored, and bigint arithmetic raises 22003 on
-- overflow rather than wrapping.
select is(pg_temp.try_reward(pg_temp.id('e_m2'), 4, p_uncapped => 5000000000001::bigint),
  'REFUSED:23514',
  'M8. an uncapped amount above the 5e12 ceiling is refused');
select is(pg_temp.try_sql('select (9223372036854775807::bigint * 2::bigint)'),
  'REFUSED:22003',
  'M9. bigint overflow raises 22003 rather than wrapping silently');


-- ============================================================================
-- SECTION O — THE REWARD COUNTS THE EVALUATION'S UNITS, EXACTLY
-- ============================================================================
-- Both deployed rule types count every qualifying unit. The cap limits COINS: a
-- partial award reduces coins_capped_to and reward_coins and leaves units untouched,
-- and a cap-exhausted award of zero coins still records the full unit count.
--
-- The hard part of testing this is ATTRIBUTION. A wrong unit count would normally
-- also break the arithmetic CHECK, so a bare check_violation proves nothing about
-- which rule refused the row. Every probe below therefore supplies a coins_uncapped
-- that is CORRECT for the wrong unit count — leaving the unit equality as the only
-- thing left to object — and asserts the refusal MESSAGE, not just the SQLSTATE.
do $$
begin
  insert into pg_temp.f values
    ('e_o', pg_temp.complete_eval(pg_temp.id('s1'), pg_temp.id('cv_o')));
end;
$$;

select is((select e.qualifying_units from public.campaign_sale_evaluations e
           where e.id = pg_temp.id('e_o')), 5,
  'O1. FIXTURE: the evaluation qualified five units');

-- 2. Under-count: 1 unit at cv_o's rate of 3 is a coherent 3 coins, and every other
-- constraint passes. Only the unit equality can refuse it.
select is(pg_temp.reward_error(pg_temp.id('e_o'), 1, p_uncapped => 3),
  'A campaign reward must count exactly the units its evaluation qualified',
  'O2. an UNDER-counted reward is refused, and by the unit-equality assertion itself');

-- 3. Over-count, arithmetically coherent in the same way.
select is(pg_temp.reward_error(pg_temp.id('e_o'), 6, p_uncapped => 18),
  'A campaign reward must count exactly the units its evaluation qualified',
  'O3. an OVER-counted reward is refused by the same assertion');

-- 8. The same rows differ only in the unit count, so nothing else can be responsible.
select is(pg_temp.try_reward(pg_temp.id('e_o'), 1, p_uncapped => 3), 'REFUSED:23514',
  'O4. ...and the SQLSTATE is check_violation, not a uniqueness or FK failure');

-- 1 & 4. The exact count is accepted, and PER_UNIT_COINS pays for all five units.
select is(pg_temp.try_reward(pg_temp.id('e_o'), 5, p_uncapped => 15), 'ALLOWED',
  'O5. the EXACT qualifying unit count is accepted');
select is(
  (select r.units_counted from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_o')), 5,
  'O6. PER_UNIT_COINS records all five units');
select is(
  (select r.reward_coins from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_o')), 15::bigint,
  'O7. ...and pays 5 x 3 = 15, not a fraction of what was earned');

-- 5. TARGET_BONUS records every unit the crossing sale contributed.
select is(
  (select r.units_counted from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_bonus')),
  (select e.qualifying_units from public.campaign_sale_evaluations e
   where e.id = pg_temp.id('e_bonus')),
  'O8. a TARGET_BONUS reward records all units the crossing sale contributed');

-- 6. A partial cap award reduces coins and leaves units intact.
select is(
  (select r.units_counted from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_cap')),
  (select e.qualifying_units from public.campaign_sale_evaluations e
   where e.id = pg_temp.id('e_cap')),
  'O9. a PARTIAL cap award still records every qualifying unit');
select is(
  (select r.reward_coins < r.coins_uncapped from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_cap')), true,
  'O10. ...even though the cap genuinely reduced its coins');

-- 7. Cap exhaustion pays nothing and still counts everything.
select is(
  (select r.units_counted from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_cap2')),
  (select e.qualifying_units from public.campaign_sale_evaluations e
   where e.id = pg_temp.id('e_cap2')),
  'O11. a cap-EXHAUSTED zero reward still records every qualifying unit');
select is(
  (select r.reward_coins from public.campaign_rewards r
   where r.campaign_sale_evaluation_id = pg_temp.id('e_cap2')), 0::bigint,
  'O12. ...while paying nothing at all');

-- No duplicated qualifying_units column was introduced to achieve any of this.
select is((select count(*)::integer from information_schema.columns
           where table_schema = 'public' and table_name = 'campaign_rewards'
             and column_name = 'qualifying_units'), 0,
  'O13. the equality is asserted against the parent row, not by duplicating a column');


-- ============================================================================
-- SECTION N — THE REWARD COLUMN SURFACE
-- ============================================================================
-- campaign_rewards is immutable EARNING evidence. Posting state belongs to the future
-- coin ledger and will be DERIVED from a ledger entry, never stored here as a mutable
-- status. An exact allowlist is what defends that: a wildcard would miss a column
-- named for a purpose nobody predicted.
select is(
  (select array_agg(column_name::text order by column_name)
   from information_schema.columns
   where table_schema = 'public' and table_name = 'campaign_rewards'),
  array[
    'awarded_at','beneficiary_profile_id','campaign_id','campaign_sale_evaluation_id',
    'campaign_version_id','cap_subject_id','cap_subject_type','coins_capped_to',
    'coins_per_unit','coins_uncapped','configured_reward_coins','created_at','id',
    'max_reward_coins','metric_type','performance_scope','receipt_submission_id',
    'retailer_organization_id','retailer_shop_id','reward_coins','rule_type',
    'threshold_units','units_counted','vendor_organization_id','verified_sale_id'
  ]::text[],
  'N1. campaign_rewards has EXACTLY the approved 25-column surface, and nothing else');

-- Named explicitly as well, so a failure says WHICH forbidden column appeared rather
-- than only that two arrays differ.
select is((select count(*)::integer from information_schema.columns
           where table_schema = 'public' and table_name = 'campaign_rewards'
             and column_name = c), 0,
  'N2. campaign_rewards has no ' || c || ' column')
from unnest(array[
  'posting_status','posted_at','balance_state','payment_state','reversed',
  'reversed_at','deleted_at','ledger_entry_id','wallet_id','balance_id','payout_id',
  'settled_at','paid_at','void','voided_at','status'
]) as c;

-- The same rule for the other two evidence tables: no mutable state column crept in.
select is((select count(*)::integer from information_schema.columns
           where table_schema = 'public'
             and table_name in ('campaign_sale_evaluations','campaign_sale_item_qualifications')
             and column_name in ('posting_status','posted_at','payment_state','reversed',
                                 'reversed_at','deleted_at','status')), 0,
  'N3. the evaluation and item tables carry no mutable posting or deletion state either');


-- ============================================================================
-- SECTION J — THE FOUNDATION BOUNDARY
-- ============================================================================
-- A storage migration that quietly grew a reward calculation would pass every test
-- above. These assertions are what make "storage only" a checked claim.
select is((select count(*)::integer from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = f), 0,
-- SUPERSEDED IN PART BY PHASE 2A-B, UNIT 66A: campaign_versions_matching_sale was
-- created by approval in migration 20260824090000 and is excepted by name. It is a
-- PURE resolver — its own suite asserts it performs no write and touches none of the
-- tables below — so the rule this assertion actually owns is intact: Migration 65 is
-- storage only, and no evaluation RPC, reward calculation or accumulator update exists.
  'J1. no matching or evaluation helper exists yet: ' || f)
from unnest(array[
  'campaign_item_eligible_at',
  'verified_sale_beneficiary',
  'verified_sale_is_evaluable',
  'evaluate_sale_campaign_qualification',
  'get_sale_campaign_qualification',
  'list_my_staff_rewards',
  'award_campaign_reward',
  'campaign_reward_for_sale'
]) as f;

-- Every function this migration added is a guard or an assertion — nothing that
-- computes, matches or grants.
-- The ONE non-trigger function this migration adds is the completeness helper. It
-- takes an evaluation id and returns a boolean: it matches nothing, computes no
-- reward, and grants nothing.
--
-- NARROWED FOR PHASE 2A-B, UNIT 66B: campaign_sale_item_eligible_at matches the
-- campaign_sale_% pattern and was created by approval in migration 20260824090000. It is
-- named EXACTLY, not pattern-excluded, so any OTHER campaign_sale_% function — an
-- aggregator, an evaluator, a reward calculator — still fails this assertion the moment
-- it appears. Its own suite proves it is pure, internal and non-writing.
select is(
  (select coalesce(string_agg(p.proname, ',' order by p.proname), 'NONE')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname like 'campaign_sale_%' or p.proname like 'campaign_reward%'
          or p.proname like 'campaign_subject_%' or p.proname like 'campaign_evaluation_%')
     and p.prorettype <> 'trigger'::regtype),
  'campaign_evaluation_has_complete_items,campaign_sale_item_eligible_at',
  'J2. the only non-trigger functions are the completeness helper and the approved '
  'Unit 66B resolver');

select is(
  (select count(*)::integer from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname like 'campaign_sale_%' or p.proname like 'campaign_reward%')
     and p.prorettype = 'trigger'::regtype), 11,
  'J3. exactly eleven trigger functions: 3 change, 3 truncate, 3 insert assertions, 2 deferred completeness');

-- No permission and no role grant.
select is((select count(*)::integer from public.permissions), 32,
  'J4. the permission catalogue is unchanged at 32 entries');
select is((select count(*)::integer from public.permissions
           where code in ('CAMPAIGN_QUALIFICATION_EVALUATE','CAMPAIGN_REWARDS_READ')), 0,
  'J5. no evaluation or reward permission was added');
select is((select count(*)::integer from public.permissions
           where module = 'REWARDS'), 0,
  'J6. the REWARDS permission module does not exist yet');
select is((select count(*)::integer from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           where r.code = 'FINANCE_ADMIN'), 0,
  'J7. FINANCE_ADMIN still holds zero permissions');

-- No coin, ledger, balance or payout object.
select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public'
             and (table_name like '%coin%' or table_name like '%ledger%'
                  or table_name like '%balance%' or table_name like '%payout%'
                  or table_name like '%redemption%')), 0,
  'J8. no coin, ledger, balance, payout or redemption table exists');

-- The tables this migration must not have touched.
select is((select count(*)::integer from pg_trigger t
           where t.tgrelid = 'public.verified_sales'::regclass and not t.tgisinternal), 3,
  'J9. verified_sales still carries its original three triggers');
select is((select count(*)::integer from pg_trigger t
           where t.tgrelid = 'public.verified_sale_items'::regclass and not t.tgisinternal), 3,
  'J10. verified_sale_items is likewise untouched');
select is((select count(*)::integer from pg_policies
           where schemaname = 'public' and tablename = 'campaigns'), 0,
  'J11. the campaign tables'' posture is unchanged');

-- Public table count: 43 before this migration, 47 after. A fifth new table would
-- be something this milestone did not agree to.
select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'), 47,
  'J12. exactly four tables were added, and no more');


-- ============================================================================
-- SECTION K — WHAT THIS SUITE DOES NOT PROVE
-- ============================================================================
-- pgTAP runs in ONE transaction, so it cannot produce a genuine race. The cap
-- arithmetic and the accumulator lock arrive with the calculation migration, and
-- the two-session races belong with them. Nothing in THIS migration performs
-- arithmetic, so there is nothing here for a race to corrupt — but the gap is
-- stated in the suite's own output rather than only in a report.
select ok(true,
  'K1. NOTE: concurrency is NOT proven here — pgTAP is single-transaction; the accumulator lock arrives with the arithmetic migration');

select pg_temp.sign_out();

select * from finish();
rollback;
