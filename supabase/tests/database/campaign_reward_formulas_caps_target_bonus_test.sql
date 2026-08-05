-- Tests for Phase 2A-C, Migration 67.
--
--   Unit 67A  public.campaign_reward_calculation_for_evaluation(uuid)   Sections A-D
--   Unit 67B  public.campaign_apply_reward_for_evaluation(uuid)         Sections A, D-F
--
-- Run with:  supabase test db
--
-- ============================================================================
-- WHAT THIS SUITE IS PROTECTING
-- ============================================================================
-- Six properties carry this migration, and each is the one a plausible-looking
-- implementation gets wrong:
--
--   1. A CAP REDUCES COINS AND NEVER UNITS, and a partial award is exactly the
--      remaining headroom rather than all-or-nothing. An exhausted cap produces a real
--      zero-coin reward whose units still accumulate. Section B.
--
--   2. RETAILER_TEAM CHANGES WHAT IS COUNTED, NOT WHO IS PAID. Another team member's
--      earlier units push the total over the threshold; the member whose own sale
--      crosses it receives the whole bonus, once. Section C.
--
--   3. THE TARGET BONUS IS ONCE, AND "ONCE" IS RECONSTRUCTED FROM REWARD EXISTENCE —
--      never from reward_coins > 0. A capped crossing that paid zero has still been
--      claimed. Section C and Section D.
--
--   4. UNITS COME FROM EVALUATIONS AND COINS COME FROM REWARDS. Under TARGET_BONUS the
--      two genuinely disagree, because every pre-crossing sale counts units and creates
--      no reward at all. Section D.
--
--   5. A REPLAY CHANGES NOTHING. One reward, one unit increment, one coin increment, one
--      bonus — including for the TARGET_BONUS sale that has no reward row to recognise
--      itself by. Section D.
--
--   6. A FAILED APPLICATION LEAVES NOTHING. No reward, no accumulator movement, no
--      half-written state. Section D.
--
-- ============================================================================
-- WHAT THIS SUITE CANNOT PROVE, STATED RATHER THAN IMPLIED
-- ============================================================================
-- pgTAP runs in ONE transaction and rolls it back, so it cannot produce a genuine race
-- between two sessions. Section E therefore proves the STRUCTURE of the lock (the row
-- is locked, the row is created safely, exactly one row is locked) and the SERIAL
-- consequences of it (a cap is never exceeded across successive consumers, a threshold
-- is never claimed twice), and says plainly which part remains unproven. Migration 65's
-- suite made the same declaration and deferred the races to this migration; this suite
-- inherits the honest half of that and defers the two-session race to a harness that can
-- open two sessions.
--
-- ============================================================================
-- ONE STATE THE DEPLOYED SCHEMA CANNOT REACH THROUGH THE APPLIER
-- ============================================================================
-- A TARGET_BONUS campaign version pays exactly one bonus per cap subject, so the coins
-- already awarded against that subject are ALWAYS zero at the moment the bonus is
-- computed, and the remaining headroom is therefore always the whole configured cap —
-- which campaign_rules_cap_positive forces to be at least 1. A crossing that the applier
-- itself reduces to zero coins is consequently unreachable while a rule may carry only
-- one tier: the reachable capped crossing is a PARTIAL award, and C10 tests it exactly.
--
-- The zero-coin TARGET_BONUS reward is still a storable, legitimate row — every
-- Migration 65 constraint admits it — and the rule that matters about it is that it
-- still counts as the bonus having been claimed. D14-D17 build one directly and prove
-- the applier reconstructs "awarded" from its existence and not from its zero.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers
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

-- Recorded application results, so each application runs EXACTLY ONCE and every
-- assertion about it reads the recorded answer rather than re-running it.
create table pg_temp.r (k text primary key, v jsonb);
create function pg_temp.res(p text) returns jsonb language sql stable as $$
  select v from pg_temp.r where k = p
$$;
create function pg_temp.rnum(p text, p_field text) returns bigint language sql stable as $$
  select (pg_temp.res(p) ->> p_field)::bigint
$$;
create function pg_temp.rtxt(p text, p_field text) returns text language sql stable as $$
  select pg_temp.res(p) ->> p_field
$$;
create function pg_temp.rbool(p text, p_field text) returns boolean language sql stable as $$
  select (pg_temp.res(p) ->> p_field)::boolean
$$;

create table pg_temp.snap (k text primary key, v text);

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

create function pg_temp.new_product(p_vendor uuid, p_code text, p_name text, p_creator uuid)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.vendor_products (
    vendor_organization_id, product_code, product_name, status, created_by_profile_id)
  values (p_vendor, p_code, p_name, 'ACTIVE', p_creator) returning id into v_id;
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
  v_path := 'cr/' || v_id::text || '.png';
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

/* A receipt carried all the way to a complete, ACCEPTED, authoritative item set — the
   only state from which reward evidence may legitimately be built. */
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

/* A published campaign version, with the whole reward rule under the caller's control. */
create function pg_temp.publish(
  p_key text, p_vendor uuid, p_admin uuid, p_name text,
  p_performance text default 'INDIVIDUAL_STAFF',
  p_rule        text default 'PER_UNIT_COINS',
  p_per_unit    bigint default 5,
  p_threshold   integer default null,
  p_bonus       bigint default null,
  p_cap         bigint default null
) returns uuid language plpgsql as $$
declare v_c uuid; v_v uuid;
begin
  perform pg_temp.act_as(p_admin);
  v_c := public.create_vendor_campaign_draft(
    p_name, 'Described.', now() - interval '30 days', now() + interval '30 days',
    'Asia/Dubai', 'ALL_RETAILERS', p_performance, 'ALL_ELIGIBLE_PRODUCTS',
    'STACKABLE', null, 10, p_rule, p_per_unit, p_threshold, p_bonus, p_cap,
    null, null, null);
  perform public.publish_vendor_campaign(v_c);
  select c.published_version_id into v_v from public.campaigns c where c.id = v_c;
  perform pg_temp.sign_out();
  insert into pg_temp.f values (p_key || '_campaign', v_c), (p_key, v_v);
  return v_v;
end;
$$;

/* An evaluation row built from the authoritative sources, every field overridable so a
   test can corrupt exactly one thing. */
create function pg_temp.ins_eval(
  p_sale uuid, p_version uuid,
  p_outcome text default 'QUALIFIED',
  p_reason  text default null,
  p_items   integer default 1,
  p_units   integer default 1
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
    v_cv.campaign_id, p_version, p_sale, v_sale.receipt_submission_id,
    v_sale.vendor_organization_id, v_sale.retailer_organization_id,
    v_sale.retailer_shop_id,
    (select s.submitted_by_profile_id from public.receipt_submissions s
      where s.id = v_sale.receipt_submission_id),
    v_sale.sale_at,
    v_cv.performance_scope, v_cv.reward_recipient_scope, v_cv.product_scope,
    v_cv.product_eligibility_resolution, v_cv.stacking_mode, v_cv.exclusivity_key,
    v_cv.priority, v_cv.starts_at,
    p_outcome, p_reason, p_items, p_units,
    pg_temp.id('rev')
  ) returning id into v_id;
  return v_id;
end;
$$;

/* An evaluation plus EXACTLY the item evidence it declares, derived from the sale so the
   two can never disagree. Every reward fixture goes through here. */
create function pg_temp.complete_eval(p_key text, p_sale uuid, p_version uuid) returns uuid
language plpgsql as $$
declare v_e uuid; v_items integer; v_units integer; r record; v_src text;
begin
  select count(*)::integer, coalesce(sum(i.quantity), 0)::integer
    into v_items, v_units
  from public.verified_sale_items i where i.verified_sale_id = p_sale;

  v_e := pg_temp.ins_eval(p_sale, p_version, p_items => v_items, p_units => v_units);

  select cv.product_eligibility_resolution into v_src
  from public.campaign_versions cv where cv.id = p_version;

  for r in select i.id, i.vendor_product_id, i.quantity
           from public.verified_sale_items i
           where i.verified_sale_id = p_sale order by i.line_number loop
    insert into public.campaign_sale_item_qualifications (
      campaign_sale_evaluation_id, campaign_id, campaign_version_id, verified_sale_id,
      verified_sale_item_id, vendor_product_id, qualifying_units, product_source,
      product_status_at_sale, assignment_status_at_sale
    )
    select v_e, e.campaign_id, e.campaign_version_id, e.verified_sale_id,
           r.id, r.vendor_product_id, r.quantity, v_src,
           case when v_src = 'LIVE_TEMPORAL' then 'ACTIVE' end,
           case when v_src = 'LIVE_TEMPORAL' then 'ACTIVE' end
    from public.campaign_sale_evaluations e where e.id = v_e;
  end loop;

  insert into pg_temp.f values (p_key, v_e);
  return v_e;
end;
$$;

/* The two functions under test, as jsonb, so an assertion can name one field. */
create function pg_temp.calc(p_eval uuid) returns jsonb language sql stable as $$
  select to_jsonb(c) from public.campaign_reward_calculation_for_evaluation(p_eval) c
$$;

create function pg_temp.apply(p_eval uuid) returns jsonb language sql volatile as $$
  select to_jsonb(a) from public.campaign_apply_reward_for_evaluation(p_eval) a
$$;

/* Apply once and record the answer under a key, so later assertions never re-run it.
   A failure is RECORDED rather than propagated: a fixture that aborts on the first
   surprise reports one harness error instead of the dozen NAMED assertions that would
   have told a reader which rule broke. The inner block is a subtransaction, so a failed
   application leaves nothing behind — which is itself an assertion this suite makes. */
create function pg_temp.apply_as(p_key text, p_eval uuid) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  begin
    v := pg_temp.apply(p_eval);
  exception when others then
    v := jsonb_build_object('application_result', 'RAISED',
                            'sqlstate', sqlstate, 'error', sqlerrm);
  end;
  insert into pg_temp.r values (p_key, v);
  return v;
end;
$$;

create function pg_temp.try_calc(p_eval uuid) returns text language plpgsql as $$
begin perform pg_temp.calc(p_eval); return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

create function pg_temp.try_apply(p_eval uuid) returns text language plpgsql as $$
begin perform pg_temp.apply(p_eval); return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

create function pg_temp.try_sql(s text) returns text language plpgsql as $$
begin execute s; return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

/* Accumulator readers. The subject is derived exactly as the reward table's
   cap_subject_matches_scope CHECK derives it. */
create function pg_temp.acc(p_version uuid, p_subject uuid) returns public.campaign_subject_accumulators
language sql stable as $$
  select a.* from public.campaign_subject_accumulators a
  where a.campaign_version_id = p_version and a.cap_subject_id = p_subject
$$;

create function pg_temp.acc_units(p_version uuid, p_subject uuid) returns bigint
language sql stable as $$ select (pg_temp.acc(p_version, p_subject)).units_counted_total $$;

create function pg_temp.acc_coins(p_version uuid, p_subject uuid) returns bigint
language sql stable as $$ select (pg_temp.acc(p_version, p_subject)).coins_awarded_total $$;

create function pg_temp.acc_target(p_version uuid, p_subject uuid) returns boolean
language sql stable as $$ select (pg_temp.acc(p_version, p_subject)).target_bonus_awarded $$;

/* The two reconstruction identities Migration 65 documented, computed independently of
   the migration under test so a shared mistake cannot satisfy both. */
create function pg_temp.rebuilt_units(p_version uuid, p_subject uuid) returns bigint
language sql stable as $$
  select coalesce(sum(e.qualifying_units), 0)::bigint
  from public.campaign_sale_evaluations e
  where e.campaign_version_id = p_version
    and e.outcome = 'QUALIFIED'
    and case e.performance_scope
          when 'INDIVIDUAL_STAFF' then e.beneficiary_profile_id
          else e.retailer_organization_id
        end = p_subject
$$;

create function pg_temp.rebuilt_coins(p_version uuid, p_subject uuid) returns bigint
language sql stable as $$
  select coalesce(sum(r.reward_coins), 0)::bigint
  from public.campaign_rewards r
  where r.campaign_version_id = p_version and r.cap_subject_id = p_subject
$$;

create function pg_temp.rebuilt_target(p_version uuid, p_subject uuid) returns boolean
language sql stable as $$
  select exists (select 1 from public.campaign_rewards r
                 where r.campaign_version_id = p_version
                   and r.cap_subject_id = p_subject
                   and r.rule_type = 'TARGET_BONUS')
$$;

create function pg_temp.reward_of(p_eval uuid) returns public.campaign_rewards
language sql stable as $$
  select r.* from public.campaign_rewards r where r.campaign_sale_evaluation_id = p_eval
$$;

create function pg_temp.reward_count(p_version uuid) returns integer
language sql stable as $$
  select count(*)::integer from public.campaign_rewards r where r.campaign_version_id = p_version
$$;

/* Executable body with line comments stripped, so the migration's own prose — which
   necessarily discusses the things it refuses to do — cannot satisfy a structural
   assertion. */
create function pg_temp.body(p_name text) returns text language sql stable as $$
  select lower(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', ' ', 'g'), '\s+', ' ', 'g'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name
$$;


-- ============================================================================
-- Fixture
-- ============================================================================
-- One Vendor, one Retailer, one shop, three Sales Staff members. A second staff member
-- is what makes every RETAILER_TEAM claim a real test rather than a restatement of the
-- INDIVIDUAL_STAFF one; the third exists only to be deactivated after their sale.
do $$
declare v uuid;
begin
  insert into pg_temp.f values
    ('vendor',   pg_temp.new_org('CR Vendor',   'VENDOR')),
    ('retailer', pg_temp.new_org('CR Retailer', 'RETAILER'));

  insert into pg_temp.f values
    ('vsa',    pg_temp.new_person('CR','Admin')),
    ('rev',    pg_temp.new_person('CR','Rev')),
    ('staff',  pg_temp.new_person('CR','Staff')),
    ('staff2', pg_temp.new_person('CR','StaffTwo')),
    ('staff3', pg_temp.new_person('CR','StaffThree'));

  perform pg_temp.add_member(pg_temp.id('vsa'),    pg_temp.id('vendor'),   'VENDOR_SUPER_ADMIN');
  perform pg_temp.add_member(pg_temp.id('rev'),    pg_temp.id('vendor'),   'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('staff'),  pg_temp.id('retailer'), 'SALES_STAFF');
  perform pg_temp.add_member(pg_temp.id('staff2'), pg_temp.id('retailer'), 'SALES_STAFF');
  perform pg_temp.add_member(pg_temp.id('staff3'), pg_temp.id('retailer'), 'SALES_STAFF');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (pg_temp.id('vendor'), pg_temp.id('retailer'), 'ACTIVE');

  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer'), 'CR Shop', 'CRS', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop', v);

  insert into pg_temp.f values
    ('p1', pg_temp.new_product(pg_temp.id('vendor'), 'CR-1', 'Product One', pg_temp.id('vsa'))),
    ('p2', pg_temp.new_product(pg_temp.id('vendor'), 'CR-2', 'Product Two', pg_temp.id('vsa')));
  perform pg_temp.assign(pg_temp.id('p1'), pg_temp.id('retailer'), pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('p2'), pg_temp.id('retailer'), pg_temp.id('vsa'));
end;
$$;

-- Sales. Every unit count below is the authoritative sum of verified_sale_items.quantity,
-- never a number a fixture asserted.
do $$
begin
  perform pg_temp.full_sale('s1', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1)));

  perform pg_temp.full_sale('s2', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));

  perform pg_temp.full_sale('s3', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 3)));

  perform pg_temp.full_sale('s5', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 5)));

  -- Two lines, five units: the multi-item arithmetic case.
  perform pg_temp.full_sale('sm', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2), pg_temp.line(pg_temp.id('p2'), 3)));

  perform pg_temp.full_sale('sx', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));

  perform pg_temp.full_sale('t2', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff2'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));

  perform pg_temp.full_sale('t4', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff2'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 4)));

  perform pg_temp.full_sale('u4', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff3'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 4)));
end;
$$;

-- Campaign versions. Each scenario gets its OWN version, so its accumulator is its own
-- and no test can pass by borrowing another's running total.
do $$
declare v_rule uuid;
begin
  perform pg_temp.publish('cv_pu',    pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR PerUnit');
  perform pg_temp.publish('cv_rate7', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR Rate7',
    'INDIVIDUAL_STAFF', 'PER_UNIT_COINS', 7);
  perform pg_temp.publish('cv_capfull', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR CapFull',
    'INDIVIDUAL_STAFF', 'PER_UNIT_COINS', 5, null, null, 1000);
  perform pg_temp.publish('cv_cappart', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR CapPartial',
    'INDIVIDUAL_STAFF', 'PER_UNIT_COINS', 5, null, null, 12);
  perform pg_temp.publish('cv_capexh', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR CapExhausted',
    'INDIVIDUAL_STAFF', 'PER_UNIT_COINS', 5, null, null, 5);

  perform pg_temp.publish('cv_below', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR TargetBelow',
    'INDIVIDUAL_STAFF', 'TARGET_BONUS', null, 10, 100);
  perform pg_temp.publish('cv_tb', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR TargetAccum',
    'INDIVIDUAL_STAFF', 'TARGET_BONUS', null, 5, 100);
  perform pg_temp.publish('cv_tbeq', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR TargetExact',
    'INDIVIDUAL_STAFF', 'TARGET_BONUS', null, 5, 100);
  perform pg_temp.publish('cv_tbover', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR TargetOver',
    'INDIVIDUAL_STAFF', 'TARGET_BONUS', null, 3, 100);
  perform pg_temp.publish('cv_atthr', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR TargetAtThreshold',
    'INDIVIDUAL_STAFF', 'TARGET_BONUS', null, 3, 100);
  perform pg_temp.publish('cv_tbcap', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR TargetCapped',
    'INDIVIDUAL_STAFF', 'TARGET_BONUS', null, 3, 100, 40);
  -- Threshold 5, so the hand-built bonus below sits on a 3-unit evaluation that did NOT
  -- itself cross it. The next 2-unit sale therefore DOES satisfy the crossing test, and
  -- the one-time guard is the ONLY thing standing between it and a second bonus.
  perform pg_temp.publish('cv_zero', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR TargetZeroCoin',
    'INDIVIDUAL_STAFF', 'TARGET_BONUS', null, 5, 100, 100);

  perform pg_temp.publish('cv_team', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR TeamTarget',
    'RETAILER_TEAM', 'TARGET_BONUS', null, 5, 100);
  perform pg_temp.publish('cv_teampu', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR TeamPerUnit',
    'RETAILER_TEAM', 'PER_UNIT_COINS', 5, null, null, 20);

  perform pg_temp.publish('cv_deact', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR Deactivated');
  perform pg_temp.publish('cv_conf',  pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR Conflict');
  perform pg_temp.publish('cv_ind',   pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR IndependentSubjects');
  perform pg_temp.publish('cv_state', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR StateInvariance');
  perform pg_temp.publish('cv_uniq',  pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR Uniqueness');
  perform pg_temp.publish('cv_fail',  pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR FailedApplication');
  perform pg_temp.publish('cv_excl',  pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR Excluded');
  perform pg_temp.publish('cv_bad',   pg_temp.id('vendor'), pg_temp.id('vsa'), 'CR BadEvidence');

  -- A TARGET_BONUS version carrying a SECOND tier. The tier is inserted while the version
  -- is still a draft, because campaign_tier_assert_version_draft refuses it afterwards —
  -- which is precisely why publication is the only way to reach this state, and why the
  -- calculation has to refuse it rather than silently use tier 1.
  perform pg_temp.act_as(pg_temp.id('vsa'));
  insert into pg_temp.f values ('cv_2tier_campaign', public.create_vendor_campaign_draft(
    'CR TwoTiers', 'Described.', now() - interval '30 days', now() + interval '30 days',
    'Asia/Dubai', 'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
    'STACKABLE', null, 10, 'TARGET_BONUS', null, 3, 100, null, null, null, null));

  select r.id into v_rule
  from public.campaign_rules r
  join public.campaign_versions cv on cv.id = r.campaign_version_id
  where cv.campaign_id = pg_temp.id('cv_2tier_campaign');

  insert into public.campaign_rule_tiers (campaign_rule_id, tier_number, threshold_units, reward_coins)
  values (v_rule, 2, 9, 500);

  perform public.publish_vendor_campaign(pg_temp.id('cv_2tier_campaign'));
  insert into pg_temp.f
  select 'cv_2tier', c.published_version_id from public.campaigns c
  where c.id = pg_temp.id('cv_2tier_campaign');
  perform pg_temp.sign_out();
end;
$$;


-- ============================================================================
-- SECTION A — SCHEMA, CONTRACT AND SECURITY POSTURE
-- ============================================================================
select is((select count(*)::integer from supabase_migrations.schema_migrations
           where version = '20260825090000'), 1,
  'A1. Migration 67 is recorded exactly once');

-- SUPERSEDED IN PART BY PHASES 2A-D, 2A-E AND 2B: Migrations 68 (20260826090000), 69
-- (20260827090000) and 70 (20260828090000) were created by approval and are named
-- exactly. Migration 70 reads rewards and never writes one; G8 and G9 of its own suite
-- pin this migration's two functions by source hash. The rule this assertion owns is
-- that nothing beyond them has been applied.
select is((select coalesce(string_agg(version, ',' order by version), 'NONE')
           from supabase_migrations.schema_migrations
           where version > '20260825090000'),
  '20260826090000,20260827090000,20260828090000',
  'A2. the only migrations after 20260825090000 are the approved Migrations 68, 69 '
  'and 70');

select has_function('public', 'campaign_reward_calculation_for_evaluation', array['uuid'],
  'A3. the pure calculation exists with the exact signature');

select has_function('public', 'campaign_apply_reward_for_evaluation', array['uuid'],
  'A4. the reward applier exists with the exact signature');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_reward_calculation_for_evaluation'),
  'TABLE(campaign_sale_evaluation_id uuid, campaign_id uuid, campaign_version_id uuid, '
  'verified_sale_id uuid, receipt_submission_id uuid, vendor_organization_id uuid, '
  'retailer_organization_id uuid, retailer_shop_id uuid, beneficiary_profile_id uuid, '
  'performance_scope text, cap_subject_type text, cap_subject_id uuid, rule_type text, '
  'metric_type text, coins_per_unit bigint, threshold_units integer, '
  'configured_reward_coins bigint, max_reward_coins bigint, units_counted integer, '
  'units_before bigint, units_after bigint, threshold_crossed boolean, '
  'target_already_awarded boolean, coins_uncapped bigint, cap_remaining_headroom bigint, '
  'coins_capped_to bigint, reward_coins bigint, coins_before bigint, coins_after bigint, '
  'creates_reward boolean, no_reward_reason text)',
  'A5. the calculation contract is exactly the approved 31 columns and types');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_apply_reward_for_evaluation'),
  'TABLE(campaign_reward_id uuid, campaign_sale_evaluation_id uuid, campaign_version_id uuid, '
  'cap_subject_type text, cap_subject_id uuid, rule_type text, units_counted integer, '
  'units_before bigint, units_after bigint, threshold_units integer, threshold_crossed boolean, '
  'coins_uncapped bigint, cap_remaining_headroom bigint, coins_capped_to bigint, '
  'reward_coins bigint, coins_before bigint, coins_after bigint, reward_created boolean, '
  'application_result text)',
  'A6. the application contract is exactly the approved 19 columns and types');

-- The calculation is truthfully STABLE: it writes nothing. The applier is truthfully
-- VOLATILE: it takes a lock and inserts. Getting either wrong would let the planner
-- cache or reorder something that must not be.
select is((select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_reward_calculation_for_evaluation'),
  's', 'A7. the calculation is STABLE');

select is((select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_apply_reward_for_evaluation'),
  'v', 'A8. the applier is VOLATILE');

select ok((select bool_and(p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('campaign_reward_calculation_for_evaluation',
                               'campaign_apply_reward_for_evaluation')),
  'A9. both are SECURITY DEFINER — the evidence tables are deny-all RLS with no grants');

select ok((select bool_and(p.proconfig @> array['search_path=""'])
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('campaign_reward_calculation_for_evaluation',
                               'campaign_apply_reward_for_evaluation')),
  'A10. both run with an empty search_path');

select ok((select bool_and(p.proacl::text = '{postgres=X/postgres}')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('campaign_reward_calculation_for_evaluation',
                               'campaign_apply_reward_for_evaluation')),
  'A11. both are owner-execute-only — the default PUBLIC grant really was revoked');

select is((select count(*)::integer from information_schema.role_routine_grants
           where routine_schema = 'public'
             and routine_name in ('campaign_reward_calculation_for_evaluation',
                                  'campaign_apply_reward_for_evaluation')
             and grantee in ('anon','authenticated','service_role','PUBLIC')), 0,
  'A12. no PUBLIC, anon, authenticated or service_role execution exists');

select ok((select bool_and(obj_description(p.oid, 'pg_proc') is not null)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('campaign_reward_calculation_for_evaluation',
                               'campaign_apply_reward_for_evaluation')),
  'A13. both are documented');

-- No permission, no role grant, no application-facing RPC.
-- SUPERSEDED IN PART BY PHASE 2A-D: migration 20260826090000 added
-- CAMPAIGN_EVALUATION_EXECUTE by approval. A15 below still owns the rule this migration
-- cares about — that no REWARD or COIN permission was minted.
-- Migration 67 minted no permission. STAFF_EARNINGS_VIEW (Migration 70) is the one
-- approved addition since, and is named so an unapproved thirty-fifth still fails.
select is((select count(*)::integer from public.permissions), 34,
  'A14. the permission catalogue is at 34 — Migration 67 minted none, and the only '
  'addition since is the approved STAFF_EARNINGS_VIEW');

select is((select count(*)::integer from public.permissions
           where module = 'REWARDS' or code like '%REWARD%' or code like '%COIN%'), 0,
  'A15. no reward or coin permission was minted');

select is((select count(*)::integer from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           where r.code = 'FINANCE_ADMIN'), 0,
  'A16. FINANCE_ADMIN still holds zero permissions');

-- An application-facing RPC is one `authenticated` may execute. Migration 67 added none,
-- which is checked by counting the whole executable surface rather than by name.
select is((select count(*)::integer from information_schema.role_routine_grants g
           where g.routine_schema = 'public'
             and g.grantee = 'authenticated'
             and g.routine_name like 'campaign_%'
             and g.routine_name not in (
               select r.routine_name from information_schema.role_routine_grants r
               where r.routine_schema = 'public' and r.grantee = 'authenticated'
                 and r.routine_name in ('campaign_apply_draft_config'))), 0,
  'A17. no campaign_% function became callable by authenticated in this migration');

select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname like '%coin_ledger%' or p.proname like '%wallet%'
                  or p.proname like '%balance%' or p.proname like '%payout%'
                  or p.proname like '%redemption%')), 0,
  'A18. no ledger, wallet, balance, payout or redemption function exists');

select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public'
             and (table_name like '%coin%' or table_name like '%ledger%'
                  or table_name like '%wallet%' or table_name like '%balance%'
                  or table_name like '%payout%' or table_name like '%redemption%')), 0,
  'A19. no coin, ledger, wallet, balance, payout or redemption table exists');

select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'), 47,
  'A20. Migration 67 added no table — still the 47 from Migration 65');

-- Neither function may post a reward anywhere, and only the applier may write at all.
select ok(pg_temp.body('campaign_reward_calculation_for_evaluation')
            !~ '\minsert\s+into\M|\mupdate\s+public\.|\mdelete\s+from\M|\mfor\s+update\M',
  'A21. the calculation''s executable body contains no INSERT, UPDATE, DELETE or lock');

select ok(pg_temp.body('campaign_reward_calculation_for_evaluation')
            !~ 'campaign_subject_accumulators',
  'A22. the calculation does not read the accumulator cache at all — it reconstructs '
  'from the evidence tables');

select ok((select bool_and(p.prosrc !~* '\mexecute\s+|\mformat\s*\(|\mquote_ident\M')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('campaign_reward_calculation_for_evaluation',
                               'campaign_apply_reward_for_evaluation')),
  'A23. neither uses dynamic SQL');

-- The applier's only INSERT targets are the accumulator row it locks and the reward.
select ok(pg_temp.body('campaign_apply_reward_for_evaluation')
            !~ 'campaign_sale_item_qualifications',
  'A24. the applier writes no item evidence');

select ok(pg_temp.body('campaign_apply_reward_for_evaluation')
            !~ '\minsert\s+into\s+public\.campaign_sale_evaluations\M',
  'A25. the applier writes no evaluation evidence');

select ok(pg_temp.body('campaign_apply_reward_for_evaluation') !~ 'audit_log',
  'A26. the applier writes no audit log — that contract belongs to Migration 68');

-- No rounding, no float, no division anywhere in the arithmetic.
select ok((select bool_and(p.prosrc !~* '\mround\s*\(|\mfloat|\mdouble\s+precision\M|::\s*numeric\M')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('campaign_reward_calculation_for_evaluation',
                               'campaign_apply_reward_for_evaluation')),
  'A27. no rounding, float or numeric coercion appears in either body');


-- ============================================================================
-- Evidence and applications
-- ============================================================================
-- Every application runs EXACTLY ONCE here and its answer is recorded. Assertions below
-- read the record, so no assertion can accidentally re-run an application and observe
-- the idempotent second answer instead of the first.
--
-- EACH EVALUATION IS APPLIED AS SOON AS IT IS WRITTEN, which is the order Migration 68
-- will use: it writes the envelope, the items and the reward in one transaction. The
-- applier reconciles the accumulator against "every OTHER qualified evaluation for this
-- subject", so a fixture that wrote several evaluations before applying any of them would
-- be asking it to reconcile against work nobody has done — and it fails closed on exactly
-- that, deliberately.
do $$
declare v_e uuid;
begin
  -- ---- PER_UNIT_COINS ------------------------------------------------------
  perform pg_temp.complete_eval('e_pu1',  pg_temp.id('s1'), pg_temp.id('cv_pu'));
  perform pg_temp.apply_as('a_pu1', pg_temp.id('e_pu1'));
  perform pg_temp.complete_eval('e_pum',  pg_temp.id('sm'), pg_temp.id('cv_pu'));
  perform pg_temp.apply_as('a_pum', pg_temp.id('e_pum'));

  perform pg_temp.complete_eval('e_r7',   pg_temp.id('s3'), pg_temp.id('cv_rate7'));
  perform pg_temp.apply_as('a_r7',  pg_temp.id('e_r7'));
  perform pg_temp.complete_eval('e_cf',   pg_temp.id('s5'), pg_temp.id('cv_capfull'));
  perform pg_temp.apply_as('a_cf',  pg_temp.id('e_cf'));
  perform pg_temp.complete_eval('e_cp',   pg_temp.id('s5'), pg_temp.id('cv_cappart'));
  perform pg_temp.apply_as('a_cp',  pg_temp.id('e_cp'));

  perform pg_temp.complete_eval('e_ce1',  pg_temp.id('s1'), pg_temp.id('cv_capexh'));
  perform pg_temp.apply_as('a_ce1', pg_temp.id('e_ce1'));
  perform pg_temp.complete_eval('e_ce2',  pg_temp.id('s3'), pg_temp.id('cv_capexh'));
  perform pg_temp.apply_as('a_ce2', pg_temp.id('e_ce2'));

  -- ---- TARGET_BONUS --------------------------------------------------------
  perform pg_temp.complete_eval('e_below', pg_temp.id('s3'), pg_temp.id('cv_below'));
  perform pg_temp.apply_as('a_below', pg_temp.id('e_below'));

  -- Accumulate 3, then 2, landing EXACTLY on a threshold of 5.
  perform pg_temp.complete_eval('e_tb3', pg_temp.id('s3'), pg_temp.id('cv_tb'));
  perform pg_temp.apply_as('a_tb3', pg_temp.id('e_tb3'));
  perform pg_temp.complete_eval('e_tb2', pg_temp.id('s2'), pg_temp.id('cv_tb'));
  perform pg_temp.apply_as('a_tb2', pg_temp.id('e_tb2'));
  -- And a third qualifying sale AFTER the bonus: units accumulate, nothing is paid twice.
  perform pg_temp.complete_eval('e_tb1', pg_temp.id('s1'), pg_temp.id('cv_tb'));
  perform pg_temp.apply_as('a_tb1', pg_temp.id('e_tb1'));

  -- One sale that lands exactly on the threshold from zero.
  perform pg_temp.complete_eval('e_tbeq', pg_temp.id('s5'), pg_temp.id('cv_tbeq'));
  perform pg_temp.apply_as('a_tbeq', pg_temp.id('e_tbeq'));

  -- One sale that crosses from strictly below to strictly above.
  perform pg_temp.complete_eval('e_over', pg_temp.id('s5'), pg_temp.id('cv_tbover'));
  perform pg_temp.apply_as('a_over', pg_temp.id('e_over'));
  perform pg_temp.complete_eval('e_over2', pg_temp.id('s1'), pg_temp.id('cv_tbover'));
  perform pg_temp.apply_as('a_over2', pg_temp.id('e_over2'));

  -- A capped crossing: the bonus is 100 and the cap leaves 40.
  perform pg_temp.complete_eval('e_tbcap', pg_temp.id('s3'), pg_temp.id('cv_tbcap'));
  perform pg_temp.apply_as('a_tbcap', pg_temp.id('e_tbcap'));

  -- ---- RETAILER_TEAM -------------------------------------------------------
  -- staff contributes 3, staff2's sale of 2 crosses the team threshold of 5.
  perform pg_temp.complete_eval('e_team3', pg_temp.id('s3'), pg_temp.id('cv_team'));
  perform pg_temp.apply_as('a_team3', pg_temp.id('e_team3'));
  perform pg_temp.complete_eval('e_team2', pg_temp.id('t2'), pg_temp.id('cv_team'));
  perform pg_temp.apply_as('a_team2', pg_temp.id('e_team2'));

  -- A TEAM cap: staff takes 15 of 20, staff2's 10 is cut to the remaining 5.
  perform pg_temp.complete_eval('e_tpu3', pg_temp.id('s3'), pg_temp.id('cv_teampu'));
  perform pg_temp.apply_as('a_tpu3', pg_temp.id('e_tpu3'));
  perform pg_temp.complete_eval('e_tpu2', pg_temp.id('t2'), pg_temp.id('cv_teampu'));
  perform pg_temp.apply_as('a_tpu2', pg_temp.id('e_tpu2'));

  -- ---- Independent subjects -------------------------------------------------
  perform pg_temp.complete_eval('e_ind1', pg_temp.id('s1'), pg_temp.id('cv_ind'));
  perform pg_temp.apply_as('a_ind1', pg_temp.id('e_ind1'));
  perform pg_temp.complete_eval('e_ind2', pg_temp.id('t2'), pg_temp.id('cv_ind'));
  perform pg_temp.apply_as('a_ind2', pg_temp.id('e_ind2'));

  -- ---- Replay ---------------------------------------------------------------
  perform pg_temp.apply_as('a_pu1_replay', pg_temp.id('e_pu1'));
  perform pg_temp.apply_as('a_tb3_replay', pg_temp.id('e_tb3'));
  perform pg_temp.apply_as('a_tb2_replay', pg_temp.id('e_tb2'));

  -- ---- Uniqueness and conflict ----------------------------------------------
  perform pg_temp.complete_eval('e_uniq', pg_temp.id('s1'), pg_temp.id('cv_uniq'));
  perform pg_temp.apply_as('a_uniq', pg_temp.id('e_uniq'));
  perform pg_temp.complete_eval('e_conf', pg_temp.id('s1'), pg_temp.id('cv_conf'));
  perform pg_temp.apply_as('a_conf', pg_temp.id('e_conf'));

  -- ---- Rejection fixtures ---------------------------------------------------
  -- A NOT_QUALIFIED envelope, and an envelope declaring evidence it does not carry.
  v_e := pg_temp.ins_eval(pg_temp.id('s2'), pg_temp.id('cv_bad'),
           p_outcome => 'NOT_QUALIFIED', p_reason => 'NO_QUALIFYING_ITEMS',
           p_items => 0, p_units => 0);
  insert into pg_temp.f values ('e_notqual', v_e);

  v_e := pg_temp.ins_eval(pg_temp.id('s3'), pg_temp.id('cv_bad'),
           p_items => 1, p_units => 3);
  insert into pg_temp.f values ('e_noitems', v_e);

  -- Complete evidence FIRST, and the exclusion afterwards. That ordering is the whole
  -- point: Migration 65 refuses an evaluation for an already-excluded receipt, so the only
  -- way to reach "an exclusion arrived between the evaluation and the reward" is to write
  -- the evidence while the receipt was clean.
  perform pg_temp.complete_eval('e_excl', pg_temp.id('sx'), pg_temp.id('cv_excl'));

  -- A failed-application probe with a healthy accumulator already in place, on the same
  -- subject, so a failure that moved the accumulator would be visible.
  perform pg_temp.complete_eval('e_fail_ok',  pg_temp.id('s1'), pg_temp.id('cv_fail'));
  perform pg_temp.apply_as('a_fail_ok', pg_temp.id('e_fail_ok'));
  perform pg_temp.complete_eval('e_fail_bad', pg_temp.id('sx'), pg_temp.id('cv_fail'));

  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.record_claim_receipt_qualification(
    pg_temp.id('sx_receipt'), 'EXCLUDE', 'DUPLICATE', null);
  perform pg_temp.sign_out();

  -- The two-tier version.
  perform pg_temp.complete_eval('e_2tier', pg_temp.id('s5'), pg_temp.id('cv_2tier'));

  -- Already at the threshold with no bonus yet recorded: only reachable by hand, and
  -- exactly the shape the strict `previous < threshold` comparison has to refuse.
  perform pg_temp.complete_eval('e_at5', pg_temp.id('s5'), pg_temp.id('cv_atthr'));
  insert into public.campaign_subject_accumulators
    (campaign_version_id, cap_subject_type, cap_subject_id, units_counted_total)
  values (pg_temp.id('cv_atthr'), 'SALES_STAFF_PROFILE', pg_temp.id('staff'), 5);
  perform pg_temp.complete_eval('e_at2', pg_temp.id('s2'), pg_temp.id('cv_atthr'));
  perform pg_temp.apply_as('a_at2', pg_temp.id('e_at2'));

  -- The state-invariance digest, taken BEFORE anything is deactivated.
  perform pg_temp.complete_eval('e_state', pg_temp.id('s5'), pg_temp.id('cv_state'));
  insert into pg_temp.snap values ('state_calc', pg_temp.calc(pg_temp.id('e_state'))::text);
end;
$$;


-- ============================================================================
-- SECTION B — PER_UNIT_COINS, CAPS AND PARTIAL AWARDS
-- ============================================================================
-- Preconditions, so every arithmetic assertion below is known to be about the number the
-- sale really carried rather than about a fixture's opinion of it.
select is((select v.qualifying_units from public.campaign_sale_evaluations v
           where v.id = pg_temp.id('e_pu1')), 1,
  'B0a. the one-unit evaluation really carries one unit');
select is((select v.qualifying_units from public.campaign_sale_evaluations v
           where v.id = pg_temp.id('e_pum')), 5,
  'B0b. the two-line evaluation really carries five units across two items');

select is(pg_temp.rnum('a_pu1', 'reward_coins'), 5::bigint,
  'B1. ONE UNIT at 5 coins per unit awards 5');

select is(pg_temp.rnum('a_pum', 'reward_coins'), 25::bigint,
  'B2. FIVE units across two sale lines award 25 — the whole basket, not the first line');

select is(pg_temp.rnum('a_r7', 'reward_coins'), 21::bigint,
  'B3. exact rate arithmetic: 3 units at 7 coins per unit is 21, not 20 and not 21.5');

select is(pg_temp.rnum('a_r7', 'coins_uncapped'), 21::bigint,
  'B4. ...and the uncapped value records the same exact product');

select is((pg_temp.reward_of(pg_temp.id('e_r7'))).coins_uncapped, 21::bigint,
  'B5. ...as does the stored immutable reward row');

-- No cap: the awarded amount IS the uncapped amount, and coins_capped_to stays NULL
-- because a ceiling that did not bite must not be recorded as one that did.
select is(pg_temp.rnum('a_pum', 'reward_coins'), pg_temp.rnum('a_pum', 'coins_uncapped'),
  'B6. with NO cap the award equals the uncapped value exactly');
select is((pg_temp.reward_of(pg_temp.id('e_pum'))).coins_capped_to, null::bigint,
  'B7. ...and coins_capped_to is NULL, not a copy of the award');
select is((pg_temp.reward_of(pg_temp.id('e_pum'))).max_reward_coins, null::bigint,
  'B8. ...and no cap is recorded on the reward');

-- A cap with room to spare changes nothing at all.
select is(pg_temp.rnum('a_cf', 'reward_coins'), 25::bigint,
  'B9. a cap of 1000 against 25 uncapped coins awards the full 25');
select is((pg_temp.reward_of(pg_temp.id('e_cf'))).coins_capped_to, null::bigint,
  'B10. ...and records no capped_to, because the cap did not bite');
select is(pg_temp.rnum('a_cf', 'cap_remaining_headroom'), 1000::bigint,
  'B11. ...while still reporting the headroom it measured against');

-- THE PARTIAL AWARD. 25 coins earned, 12 of headroom, 12 paid — not 0 and not 25.
select is(pg_temp.rnum('a_cp', 'coins_uncapped'), 25::bigint,
  'B12. a capped sale still records what the rule alone produced');
select is(pg_temp.rnum('a_cp', 'reward_coins'), 12::bigint,
  'B13. THE PARTIAL AWARD is exactly the remaining headroom — not all-or-nothing');
select is((pg_temp.reward_of(pg_temp.id('e_cp'))).coins_capped_to, 12::bigint,
  'B14. ...and coins_capped_to records the ceiling that bit');
select isnt(pg_temp.rnum('a_cp', 'reward_coins'), pg_temp.rnum('a_cp', 'coins_uncapped'),
  'B15. uncapped and awarded remain DISTINCT values on the same row');
select is(pg_temp.rnum('a_cp', 'units_counted'), 5::bigint,
  'B16. THE CAP REDUCED COINS AND NOT UNITS — all five units are still counted');

-- THE EXHAUSTED CAP. The first sale takes the whole cap; the second earns 15 and is paid
-- nothing, and is still a real, immutable reward.
select is(pg_temp.rnum('a_ce1', 'reward_coins'), 5::bigint,
  'B17. the first sale consumes the entire cap of 5');
select is(pg_temp.rnum('a_ce2', 'cap_remaining_headroom'), 0::bigint,
  'B18. the second sale finds zero headroom');
select is(pg_temp.rnum('a_ce2', 'coins_uncapped'), 15::bigint,
  'B19. ...still records the 15 coins the rule produced');
select is(pg_temp.rnum('a_ce2', 'reward_coins'), 0::bigint,
  'B20. ...and awards zero');
select is((pg_temp.reward_of(pg_temp.id('e_ce2'))).id is not null, true,
  'B21. A ZERO-COIN AWARD IS STILL A REWARD ROW — the qualification was real');
select is((pg_temp.reward_of(pg_temp.id('e_ce2'))).coins_capped_to, 0::bigint,
  'B22. ...and its capped_to says the cap took everything');
select is((pg_temp.reward_of(pg_temp.id('e_ce2'))).units_counted, 3,
  'B23. ...and it counts all three units despite paying nothing');

select is(pg_temp.acc_units(pg_temp.id('cv_capexh'), pg_temp.id('staff')), 4::bigint,
  'B24. UNITS STILL ACCUMULATE when the award is zero: 1 + 3 = 4');
select is(pg_temp.acc_coins(pg_temp.id('cv_capexh'), pg_temp.id('staff')), 5::bigint,
  'B25. ...and coins stop at the cap, because zero was added and not 15');

select is(pg_temp.acc_coins(pg_temp.id('cv_capexh'), pg_temp.id('staff')) <= 5, true,
  'B26. the cap is never exceeded across successive consumers');

-- The applier reports the same numbers it stored. A result contract that drifted from the
-- row would make every caller's audit trail a second opinion.
select is(pg_temp.rnum('a_cp', 'reward_coins'), (pg_temp.reward_of(pg_temp.id('e_cp'))).reward_coins,
  'B27. the returned award equals the stored award');
select is(pg_temp.rnum('a_cp', 'coins_after'),
          pg_temp.acc_coins(pg_temp.id('cv_cappart'), pg_temp.id('staff')),
  'B28. the returned coins_after equals the accumulator it wrote');


-- ============================================================================
-- SECTION C — TARGET_BONUS
-- ============================================================================
select is(pg_temp.rbool('a_below', 'threshold_crossed'), false,
  'C1. three units against a threshold of ten crosses nothing');
select is(pg_temp.rbool('a_below', 'reward_created'), false,
  'C2. ...and creates no reward row: a pre-crossing sale is not a zero-coin award');
select is(pg_temp.reward_count(pg_temp.id('cv_below')), 0,
  'C3. ...so the campaign has no rewards at all');
select is(pg_temp.acc_units(pg_temp.id('cv_below'), pg_temp.id('staff')), 3::bigint,
  'C4. ...while its three units still count towards the threshold');

-- Accumulated crossing, landing EXACTLY on the threshold.
select is(pg_temp.rbool('a_tb3', 'reward_created'), false,
  'C5. the first sale of three against a threshold of five pays nothing');
select is(pg_temp.rnum('a_tb2', 'units_before'), 3::bigint,
  'C6. the second sale sees the first sale''s three units as its prior total');
select is(pg_temp.rbool('a_tb2', 'threshold_crossed'), true,
  'C7. EXACT CROSSING: 3 + 2 reaches 5 and crosses');
select is(pg_temp.rnum('a_tb2', 'reward_coins'), 100::bigint,
  'C8. ...and pays the whole configured bonus, not a share of it');
select is((pg_temp.reward_of(pg_temp.id('e_tb2'))).coins_uncapped, 100::bigint,
  'C9. ...whose uncapped amount IS the configured bonus, unscaled by units');

-- Crossing from strictly below to strictly above.
select is(pg_temp.rnum('a_over', 'units_before'), 0::bigint,
  'C10. a first sale of five against a threshold of three starts from zero');
select is(pg_temp.rbool('a_over', 'threshold_crossed'), true,
  'C11. ...crosses from below to above');
select is(pg_temp.rnum('a_over', 'reward_coins'), 100::bigint,
  'C12. ...and pays the bonus once');

-- Exactly on the threshold in a single sale.
select is(pg_temp.rbool('a_tbeq', 'threshold_crossed'), true,
  'C13. five units against a threshold of five crosses on the first sale');

-- ALREADY AT THE THRESHOLD. previous < threshold is STRICT, so a subject standing on it
-- cannot cross it a second time.
select is(pg_temp.rnum('a_at2', 'units_before'), 5::bigint,
  'C14. a subject already at five units reports five as its prior total');
select is(pg_temp.rbool('a_at2', 'threshold_crossed'), false,
  'C15. ALREADY AT THE THRESHOLD does not cross it again');
select is(pg_temp.reward_count(pg_temp.id('cv_atthr')), 0,
  'C16. ...and awards nothing');

-- A PREVIOUSLY AWARDED TIER IS NOT PAID TWICE.
select is(pg_temp.rbool('a_over2', 'reward_created'), false,
  'C17. a later qualifying sale after the bonus creates no second reward');
select is(pg_temp.rtxt('a_over2', 'rule_type'), 'TARGET_BONUS',
  'C18. ...on the same TARGET_BONUS campaign');
select is(pg_temp.reward_count(pg_temp.id('cv_tbover')), 1,
  'C19. THE BONUS IS ONCE: exactly one reward exists for that campaign version');
select is(pg_temp.rbool('a_tb1', 'reward_created'), false,
  'C20. ...and the same holds for the accumulated-crossing campaign');
select is(pg_temp.reward_count(pg_temp.id('cv_tb')), 1,
  'C21. ...which likewise has exactly one reward across three qualifying sales');
select is(pg_temp.acc_units(pg_temp.id('cv_tb'), pg_temp.id('staff')), 6::bigint,
  'C22. ...while all six units accumulated, including the post-crossing sale''s');

-- A CAPPED CROSSING. The bonus is 100, the cap is 40, the award is the exact headroom.
select is(pg_temp.rnum('a_tbcap', 'coins_uncapped'), 100::bigint,
  'C23. a capped crossing records the full configured bonus as uncapped');
select is(pg_temp.rnum('a_tbcap', 'reward_coins'), 40::bigint,
  'C24. ...and awards exactly the remaining headroom');
select is((pg_temp.reward_of(pg_temp.id('e_tbcap'))).coins_capped_to, 40::bigint,
  'C25. ...recording the ceiling that bit');
select is((pg_temp.reward_of(pg_temp.id('e_tbcap'))).threshold_units, 3,
  'C26. THE CROSSING STAYS IDENTIFIABLE from the reward''s own threshold evidence, '
  'not from its coin amount');

-- ---- RETAILER_TEAM ---------------------------------------------------------
select is(pg_temp.rtxt('a_team3', 'cap_subject_type'), 'RETAILER_ORGANIZATION',
  'C27. a RETAILER_TEAM campaign accumulates against the Retailer, not the staff member');
select is(pg_temp.rnum('a_team2', 'units_before'), 3::bigint,
  'C28. ANOTHER TEAM MEMBER''S UNITS CONTRIBUTE: staff2''s sale sees staff''s three');
select is(pg_temp.rbool('a_team2', 'threshold_crossed'), true,
  'C29. ...which is what carries the team over the threshold of five');
select is((pg_temp.reward_of(pg_temp.id('e_team2'))).beneficiary_profile_id, pg_temp.id('staff2'),
  'C30. THE CROSSING SALE''S OWN SUBMITTER receives the bonus');
select is((pg_temp.reward_of(pg_temp.id('e_team2'))).reward_coins, 100::bigint,
  'C31. ...and receives the FULL bonus, not a share proportional to their contribution');
select is((pg_temp.reward_of(pg_temp.id('e_team3'))).id, null::uuid,
  'C32. the earlier contributor receives NO reward for the crossing they enabled');
select is(pg_temp.reward_count(pg_temp.id('cv_team')), 1,
  'C33. ...so the team bonus is paid exactly once, to exactly one person');
select is((pg_temp.reward_of(pg_temp.id('e_team2'))).cap_subject_id, pg_temp.id('retailer'),
  'C34. RETAILER_TEAM changes what is COUNTED, never who is PAID: the subject is the '
  'Retailer and the beneficiary is the staff member');

-- A TEAM cap is shared across the team, which is the whole point of the shared subject.
select is(pg_temp.rnum('a_tpu3', 'reward_coins'), 15::bigint,
  'C35. the first team sale takes 15 of a shared cap of 20');
select is(pg_temp.rnum('a_tpu2', 'coins_before'), 15::bigint,
  'C36. ...and the second team member sees those 15 as already spent');
select is(pg_temp.rnum('a_tpu2', 'reward_coins'), 5::bigint,
  'C37. ...so their 10 earned coins are cut to the 5 that remain');

-- ---- MULTI-TIER ------------------------------------------------------------
-- The deployed model carries exactly one tier. A second one is refused rather than
-- resolved by an invented highest-only or sum-all rule.
select is((select count(*)::integer from public.campaign_rule_tiers t
           join public.campaign_rules r on r.id = t.campaign_rule_id
           where r.campaign_version_id = pg_temp.id('cv_2tier')), 2,
  'C38. the two-tier fixture really carries two tiers');
select is(pg_temp.try_calc(pg_temp.id('e_2tier')), 'REFUSED:0A000',
  'C39. MULTI-TIER IS REFUSED as an unsupported configuration, not silently reduced '
  'to tier 1');
select is(pg_temp.try_apply(pg_temp.id('e_2tier')), 'REFUSED:0A000',
  'C40. ...and the applier refuses it for the same reason');
select is(pg_temp.reward_count(pg_temp.id('cv_2tier')), 0,
  'C41. ...leaving no reward behind');

-- Every TARGET_BONUS reward this suite produced copies tier 1 and nothing else, which is
-- the only tier campaign_rewards_assert_reward will prove a row against.
select is((select count(*)::integer from public.campaign_rewards r
           join public.campaign_rules ru on ru.campaign_version_id = r.campaign_version_id
           join public.campaign_rule_tiers t on t.campaign_rule_id = ru.id and t.tier_number = 1
           where r.rule_type = 'TARGET_BONUS'
             and (r.threshold_units is distinct from t.threshold_units
               or r.configured_reward_coins is distinct from t.reward_coins)), 0,
  'C42. every stored TARGET_BONUS reward matches its rule''s tier_number 1 exactly');

-- ---- STAFF DEACTIVATION AFTER THE SALE -------------------------------------
do $$
begin
  update public.profiles set status = 'DEACTIVATED' where id = pg_temp.id('staff3');
  update public.organization_members set status = 'DEACTIVATED'
   where user_id = pg_temp.id('staff3');

  perform pg_temp.complete_eval('e_deact', pg_temp.id('u4'), pg_temp.id('cv_deact'));
  perform pg_temp.apply_as('a_deact', pg_temp.id('e_deact'));
end;
$$;

select is((select p.status from public.profiles p where p.id = pg_temp.id('staff3')),
  'DEACTIVATED', 'C43. the third staff member really is deactivated');
select is(pg_temp.rnum('a_deact', 'reward_coins'), 20::bigint,
  'C44. A HISTORICAL SALE BY A LATER-DEACTIVATED STAFF MEMBER still rewards in full');
select is((pg_temp.reward_of(pg_temp.id('e_deact'))).beneficiary_profile_id, pg_temp.id('staff3'),
  'C45. ...and the departed member remains the beneficiary of record');


-- ============================================================================
-- SECTION D — THE ACCUMULATOR, IDEMPOTENCY AND REJECTION
-- ============================================================================
select is(pg_temp.rtxt('a_pu1', 'cap_subject_type'), 'SALES_STAFF_PROFILE',
  'D1. INDIVIDUAL_STAFF resolves a SALES_STAFF_PROFILE subject');
select is(pg_temp.res('a_pu1') ->> 'cap_subject_id', pg_temp.id('staff')::text,
  'D2. ...which is the beneficiary profile');
select is(pg_temp.rtxt('a_tpu3', 'cap_subject_type'), 'RETAILER_ORGANIZATION',
  'D3. RETAILER_TEAM resolves a RETAILER_ORGANIZATION subject');
select is(pg_temp.res('a_tpu3') ->> 'cap_subject_id', pg_temp.id('retailer')::text,
  'D4. ...which is the Retailer organization');

-- Before and after, exactly, on both axes.
select is(pg_temp.rnum('a_ce1', 'units_before'), 0::bigint, 'D5. exact units before: 0');
select is(pg_temp.rnum('a_ce1', 'units_after'),  1::bigint, 'D6. exact units after: 1');
select is(pg_temp.rnum('a_ce2', 'units_before'), 1::bigint, 'D7. exact units before: 1');
select is(pg_temp.rnum('a_ce2', 'units_after'),  4::bigint, 'D8. exact units after: 4');
select is(pg_temp.rnum('a_ce1', 'coins_before'), 0::bigint, 'D9. exact coins before: 0');
select is(pg_temp.rnum('a_ce1', 'coins_after'),  5::bigint, 'D10. exact coins after: 5');
select is(pg_temp.rnum('a_ce2', 'coins_before'), 5::bigint, 'D11. exact coins before: 5');
select is(pg_temp.rnum('a_ce2', 'coins_after'),  5::bigint,
  'D12. exact coins after: still 5 — the zero award added nothing');

select is(pg_temp.acc_units(pg_temp.id('cv_capexh'), pg_temp.id('staff')),
          pg_temp.rnum('a_ce2', 'units_after'),
  'D13. the accumulator reconciles EXACTLY with the last reward''s after-state');

-- ---- A ZERO-COIN TARGET_BONUS REWARD IS STILL A CLAIMED BONUS ---------------
-- Built by hand, because the applier cannot reach it: a subject's first and only bonus
-- always meets an untouched cap. The row is legitimate under every Migration 65
-- constraint, and the rule being tested is that "awarded" is reconstructed from its
-- EXISTENCE and not from its zero.
do $$
declare v_e uuid; v_r public.campaign_rules%rowtype; v_t public.campaign_rule_tiers%rowtype;
begin
  v_e := pg_temp.complete_eval('e_zero3', pg_temp.id('s3'), pg_temp.id('cv_zero'));
  select * into v_r from public.campaign_rules r
   where r.campaign_version_id = pg_temp.id('cv_zero') and r.sequence = 1;
  select * into v_t from public.campaign_rule_tiers t
   where t.campaign_rule_id = v_r.id and t.tier_number = 1;

  insert into public.campaign_rewards (
    campaign_sale_evaluation_id, campaign_id, campaign_version_id, verified_sale_id,
    receipt_submission_id, vendor_organization_id, retailer_organization_id,
    retailer_shop_id, beneficiary_profile_id,
    performance_scope, cap_subject_type, cap_subject_id,
    rule_type, metric_type, coins_per_unit, threshold_units,
    configured_reward_coins, max_reward_coins,
    units_counted, coins_uncapped, coins_capped_to, reward_coins
  )
  select v_e, e.campaign_id, e.campaign_version_id, e.verified_sale_id,
         e.receipt_submission_id, e.vendor_organization_id, e.retailer_organization_id,
         e.retailer_shop_id, e.beneficiary_profile_id,
         e.performance_scope, 'SALES_STAFF_PROFILE', e.beneficiary_profile_id,
         v_r.rule_type, v_r.metric_type, v_r.coins_per_unit, v_t.threshold_units,
         v_t.reward_coins, v_r.max_reward_coins,
         e.qualifying_units, v_t.reward_coins, 0, 0
  from public.campaign_sale_evaluations e where e.id = v_e;

  -- The cache, deliberately left saying the bonus was NOT awarded.
  insert into public.campaign_subject_accumulators
    (campaign_version_id, cap_subject_type, cap_subject_id,
     units_counted_total, coins_awarded_total, target_bonus_awarded)
  values (pg_temp.id('cv_zero'), 'SALES_STAFF_PROFILE', pg_temp.id('staff'), 3, 0, false);

  perform pg_temp.complete_eval('e_zero2', pg_temp.id('s2'), pg_temp.id('cv_zero'));
  perform pg_temp.apply_as('a_zero2', pg_temp.id('e_zero2'));
end;
$$;

select is((pg_temp.reward_of(pg_temp.id('e_zero3'))).reward_coins, 0::bigint,
  'D14. the hand-built TARGET_BONUS reward really pays zero coins');
select is((pg_temp.reward_of(pg_temp.id('e_zero3'))).coins_uncapped, 100::bigint,
  'D15. ...and still records the crossing it evidences');
select is(pg_temp.rbool('a_zero2', 'threshold_crossed'), true,
  'D16a. the later sale GENUINELY crosses the threshold — 3 before, 5 after, against 5 — '
  'so nothing but the one-time guard can stop it');
select is(pg_temp.rbool('a_zero2', 'reward_created'), false,
  'D16. TARGET AWARDED IS RECONSTRUCTED FROM REWARD EXISTENCE: a crossing sale gets no '
  'second bonus, even though the first paid zero and the cache said otherwise');
select is(pg_temp.rtxt('a_zero2', 'application_result'), 'APPLIED',
  'D16b. ...and the application still succeeds, recording the units it counted');
select is(pg_temp.reward_count(pg_temp.id('cv_zero')), 1,
  'D17. ...so the campaign still holds exactly one bonus');
select is(pg_temp.acc_target(pg_temp.id('cv_zero'), pg_temp.id('staff')), true,
  'D18. ...and the stale cache flag is repaired from the evidence, not trusted');
select is(pg_temp.acc_units(pg_temp.id('cv_zero'), pg_temp.id('staff')), 5::bigint,
  'D19. ...while the later sale''s units still accumulate');

-- ---- IDEMPOTENT REPLAY -----------------------------------------------------
select is(pg_temp.rtxt('a_pu1_replay', 'application_result'), 'ALREADY_APPLIED',
  'D20. replaying an applied evaluation returns the existing result');
select is(pg_temp.res('a_pu1_replay') ->> 'campaign_reward_id',
          pg_temp.res('a_pu1') ->> 'campaign_reward_id',
  'D21. ...the SAME reward row, not a new one');
select is((select count(*)::integer from public.campaign_rewards r
           where r.campaign_sale_evaluation_id = pg_temp.id('e_pu1')), 1,
  'D22. ONE REWARD PER EVALUATION survives the replay');
select is(pg_temp.acc_units(pg_temp.id('cv_pu'), pg_temp.id('staff')), 6::bigint,
  'D23. NO DOUBLE UNIT INCREMENT: 1 + 5 across two sales, and the replay added nothing');
select is(pg_temp.acc_coins(pg_temp.id('cv_pu'), pg_temp.id('staff')), 30::bigint,
  'D24. NO DOUBLE COIN INCREMENT: 5 + 25, and the replay added nothing');

-- The replay of a TARGET_BONUS sale that has NO reward row to recognise itself by.
select is(pg_temp.rtxt('a_tb3_replay', 'application_result'), 'ALREADY_APPLIED',
  'D25. replaying a NON-CROSSING TARGET_BONUS sale is recognised with no reward row '
  'to find');
select is(pg_temp.rbool('a_tb3_replay', 'reward_created'), false,
  'D26. ...and still creates nothing');
select is(pg_temp.rtxt('a_tb2_replay', 'application_result'), 'ALREADY_APPLIED',
  'D27. replaying the CROSSING sale returns its stored bonus');
select is(pg_temp.rnum('a_tb2_replay', 'reward_coins'), 100::bigint,
  'D28. ...unchanged');
select is(pg_temp.acc_units(pg_temp.id('cv_tb'), pg_temp.id('staff')), 6::bigint,
  'D29. NO DUPLICATE UNITS from either replay');
select is(pg_temp.acc_coins(pg_temp.id('cv_tb'), pg_temp.id('staff')), 100::bigint,
  'D30. NO DUPLICATE BONUS from either replay');

-- ---- A CONFLICTING REPLAY --------------------------------------------------
-- Every field the applier compares against a stored reward is FORCED equal by
-- campaign_rewards_assert_reward, so a reward whose rule or units disagree with its
-- evaluation cannot be stored at all — that branch is a backstop for a future writer, not
-- a reachable state today. The conflict that IS reachable is a cache that disagrees with
-- the evidence, and it must raise rather than be silently repaired into a second payment.
do $$
begin
  update public.campaign_subject_accumulators
     set units_counted_total = 999
   where campaign_version_id = pg_temp.id('cv_conf');
end;
$$;

select is(pg_temp.try_apply(pg_temp.id('e_conf')), 'REFUSED:23514',
  'D31. A CONFLICTING REPLAY RAISES: an accumulator that reconciles with neither the '
  'before-state nor the after-state is refused');

select is(pg_temp.try_sql(format(
  $q$select 1 from public.campaign_apply_reward_for_evaluation(%L)$q$, pg_temp.id('e_conf'))),
  'REFUSED:23514',
  'D32. ...consistently, and not once');

do $$
begin
  update public.campaign_subject_accumulators
     set units_counted_total = 1, coins_awarded_total = 5
   where campaign_version_id = pg_temp.id('cv_conf');
end;
$$;

select is(pg_temp.try_apply(pg_temp.id('e_conf')), 'ALLOWED',
  'D33. ...and is accepted again once the cache agrees with the evidence');

-- ---- REJECTION -------------------------------------------------------------
select is(pg_temp.try_calc(null), 'REFUSED:22023',
  'D34. a null evaluation id is refused');
select is(pg_temp.try_apply(null), 'REFUSED:22023',
  'D35. ...by the applier too');
select is(pg_temp.try_calc(gen_random_uuid()), 'REFUSED:23503',
  'D36. a missing evaluation is refused');
select is(pg_temp.try_apply(gen_random_uuid()), 'REFUSED:23503',
  'D37. ...by the applier too');

select is(pg_temp.try_calc(pg_temp.id('e_notqual')), 'REFUSED:23514',
  'D38. a NOT_QUALIFIED evaluation is refused — a reward without a qualification is a '
  'payment without a reason');
select is(pg_temp.try_apply(pg_temp.id('e_notqual')), 'REFUSED:23514',
  'D39. ...by the applier too');

select ok(public.campaign_evaluation_has_complete_items(pg_temp.id('e_noitems')) = false,
  'D40. the incomplete fixture really does lack the evidence it declares');
select is(pg_temp.try_calc(pg_temp.id('e_noitems')), 'REFUSED:23514',
  'D41. INCOMPLETE ITEM EVIDENCE is refused: outcome = QUALIFIED is not sufficient');
select is(pg_temp.try_apply(pg_temp.id('e_noitems')), 'REFUSED:23514',
  'D42. ...by the applier too');

select ok(public.receipt_qualification_is_excluded(pg_temp.id('sx_receipt')),
  'D43. the excluded fixture really carries an active exclusion');
select ok(public.receipt_has_finalized_sale_items(pg_temp.id('sx_receipt')),
  'D44. ...and its sale is genuinely complete, so the refusal is about the exclusion');
select is(pg_temp.try_calc(pg_temp.id('e_excl')), 'REFUSED:42501',
  'D45. AN ACTIVE EXCLUSION recorded after the evaluation prevents a new reward');
select is(pg_temp.try_apply(pg_temp.id('e_excl')), 'REFUSED:42501',
  'D46. ...by the applier too');
select is((select count(*)::integer from public.campaign_sale_evaluations e
           where e.id = pg_temp.id('e_excl')), 1,
  'D47. ...and the historical evidence written before it stands untouched');

-- ---- A FAILED APPLICATION LEAVES NOTHING -----------------------------------
select is(pg_temp.acc_units(pg_temp.id('cv_fail'), pg_temp.id('staff')), 1::bigint,
  'D48. the failed-application fixture starts with one unit accumulated');
select is(pg_temp.acc_coins(pg_temp.id('cv_fail'), pg_temp.id('staff')), 5::bigint,
  'D49. ...and five coins');
select is(pg_temp.try_apply(pg_temp.id('e_fail_bad')), 'REFUSED:42501',
  'D50. applying the excluded evaluation on the same subject fails');
select is(pg_temp.acc_units(pg_temp.id('cv_fail'), pg_temp.id('staff')), 1::bigint,
  'D51. A FAILED APPLICATION LEAVES THE ACCUMULATOR UNCHANGED');
select is(pg_temp.acc_coins(pg_temp.id('cv_fail'), pg_temp.id('staff')), 5::bigint,
  'D52. ...on both axes');
select is((select count(*)::integer from public.campaign_rewards r
           where r.campaign_sale_evaluation_id = pg_temp.id('e_fail_bad')), 0,
  'D53. A FAILED APPLICATION LEAVES NO REWARD');

-- A rejected application must not even leave the accumulator row it would have created.
select is((select count(*)::integer from public.campaign_subject_accumulators a
           where a.campaign_version_id = pg_temp.id('cv_bad')), 0,
  'D54. ...and creates no accumulator row for a campaign it never applied');

-- ---- ONE REWARD PER EVALUATION ---------------------------------------------
select is((select count(*)::integer from (
             select r.campaign_sale_evaluation_id
             from public.campaign_rewards r
             group by r.campaign_sale_evaluation_id having count(*) > 1) d), 0,
  'D55. no evaluation anywhere carries more than one reward');

-- ---- THE ACCUMULATOR RECONSTRUCTS ------------------------------------------
-- Recomputed from the evidence by this suite's own independent queries, so a shared
-- mistake in the migration cannot satisfy both sides.
--
-- cv_fail is excluded, and only cv_fail. It deliberately holds a QUALIFIED evaluation
-- whose application was REFUSED, which is a state Migration 68 cannot leave behind — it
-- writes the evaluation and applies it in one transaction, so a refusal takes the
-- evaluation with it — and which only exists here because this fixture inserted the
-- evidence directly. D51 to D53 own that campaign's real assertion.
select is((select count(*)::integer from public.campaign_subject_accumulators a
           where a.campaign_version_id <> pg_temp.id('cv_fail')
             and a.units_counted_total
                 is distinct from pg_temp.rebuilt_units(a.campaign_version_id, a.cap_subject_id)), 0,
  'D56. EVERY accumulator''s units reconstruct from QUALIFIED evaluations');

select is((select count(*)::integer from public.campaign_subject_accumulators a
           where a.coins_awarded_total
                 is distinct from pg_temp.rebuilt_coins(a.campaign_version_id, a.cap_subject_id)), 0,
  'D57. EVERY accumulator''s coins reconstruct from campaign_rewards');

select is((select count(*)::integer from public.campaign_subject_accumulators a
           where a.target_bonus_awarded
                 is distinct from pg_temp.rebuilt_target(a.campaign_version_id, a.cap_subject_id)), 0,
  'D58. EVERY accumulator''s target flag reconstructs from TARGET_BONUS reward existence, '
  'including the zero-coin one');

-- The two sources genuinely DISAGREE for a TARGET_BONUS campaign, which is the case that
-- catches a writer reconstructing units from the wrong table.
select isnt(pg_temp.rebuilt_units(pg_temp.id('cv_tb'), pg_temp.id('staff')),
            (select coalesce(sum(r.units_counted), 0)::bigint from public.campaign_rewards r
             where r.campaign_version_id = pg_temp.id('cv_tb')),
  'D59. under TARGET_BONUS the evaluation units and the reward units genuinely differ — '
  'six counted, two paid on');


-- ============================================================================
-- SECTION E — LOCKING, CONCURRENCY AND THE UNIQUENESS BACKSTOPS
-- ============================================================================
-- pgTAP is single-transaction, so a real race is not reachable here. What IS reachable
-- and is asserted: the lock exists and is on the right row, the row is created safely,
-- exactly one row is locked, subjects do not share rows, and the serial consequences a
-- correct lock guarantees actually hold.
select ok(pg_temp.body('campaign_apply_reward_for_evaluation') ~ '\mfor\s+update\M',
  'E1. the applier takes a row lock');

select ok(pg_temp.body('campaign_apply_reward_for_evaluation')
            ~ 'from\s+public\.campaign_subject_accumulators\s+a\s+where.*for\s+update',
  'E2. ...and the locked row is the campaign_subject_accumulators row itself');

select ok((select (regexp_count(pg_temp.body('campaign_apply_reward_for_evaluation'),
                                'for\s+update')) = 1),
  'E3. exactly ONE row is locked per application, so no lock ordering exists to deadlock '
  'on');

select ok(pg_temp.body('campaign_apply_reward_for_evaluation') !~ 'advisory',
  'E4. no advisory lock is used where an authoritative row lock is sufficient');

select ok(pg_temp.body('campaign_apply_reward_for_evaluation')
            ~ 'on\s+conflict\s+on\s+constraint\s+campaign_subject_accumulators_pkey\s+do\s+nothing',
  'E5. the accumulator row is created with insert-on-conflict against the subject key, '
  'so two first-ever applications for one subject cannot collide');

select ok(position('on conflict' in pg_temp.body('campaign_apply_reward_for_evaluation'))
          < position('for update' in pg_temp.body('campaign_apply_reward_for_evaluation')),
  'E6. ...and the creation happens BEFORE the lock, which is the only order that can '
  'lock a row that may not exist yet');

-- The lock is taken BEFORE the reconstruction, which is what makes a competitor's
-- committed reward visible to this application rather than invisible to it.
select ok(position('for update' in pg_temp.body('campaign_apply_reward_for_evaluation'))
          < position('campaign_reward_calculation_for_evaluation'
                     in pg_temp.body('campaign_apply_reward_for_evaluation')),
  'E7. the recalculation happens AFTER the lock, never before it');

-- Serial consequences.
select ok(pg_temp.acc_coins(pg_temp.id('cv_capexh'), pg_temp.id('staff')) <= 5,
  'E8. successive cap consumers cannot together exceed the cap');
select ok(pg_temp.acc_coins(pg_temp.id('cv_teampu'), pg_temp.id('retailer')) <= 20,
  'E9. ...including two different staff members sharing one team cap');
select is((select count(*)::integer from public.campaign_rewards r
           where r.rule_type = 'TARGET_BONUS'
           group by r.campaign_version_id, r.cap_subject_id
           having count(*) > 1), null::integer,
  'E10. no campaign version and subject anywhere holds two TARGET_BONUS rewards');

-- Different subjects keep independent rows and do not contend.
select is((select count(*)::integer from public.campaign_subject_accumulators a
           where a.campaign_version_id = pg_temp.id('cv_ind')), 2,
  'E11. two staff subjects on one campaign version keep two accumulator rows');
select is(pg_temp.acc_units(pg_temp.id('cv_ind'), pg_temp.id('staff')), 1::bigint,
  'E12. ...with independent unit totals');
select is(pg_temp.acc_units(pg_temp.id('cv_ind'), pg_temp.id('staff2')), 2::bigint,
  'E13. ...that do not leak into one another');

-- One row per subject, never two — the insert-on-conflict behaved.
select is((select count(*)::integer from (
             select a.campaign_version_id, a.cap_subject_type, a.cap_subject_id
             from public.campaign_subject_accumulators a
             group by 1,2,3 having count(*) > 1) d), 0,
  'E14. no duplicate accumulator row exists for any subject');

-- THE UNIQUENESS BACKSTOPS REMAIN FINAL. Even a correct applier is not the last line.
select is(pg_temp.try_sql(format($q$
    insert into public.campaign_rewards (
      campaign_sale_evaluation_id, campaign_id, campaign_version_id, verified_sale_id,
      receipt_submission_id, vendor_organization_id, retailer_organization_id,
      retailer_shop_id, beneficiary_profile_id, performance_scope, cap_subject_type,
      cap_subject_id, rule_type, metric_type, coins_per_unit, threshold_units,
      configured_reward_coins, max_reward_coins, units_counted, coins_uncapped,
      coins_capped_to, reward_coins)
    select r.campaign_sale_evaluation_id, r.campaign_id, r.campaign_version_id,
           r.verified_sale_id, r.receipt_submission_id, r.vendor_organization_id,
           r.retailer_organization_id, r.retailer_shop_id, r.beneficiary_profile_id,
           r.performance_scope, r.cap_subject_type, r.cap_subject_id, r.rule_type,
           r.metric_type, r.coins_per_unit, r.threshold_units, r.configured_reward_coins,
           r.max_reward_coins, r.units_counted, r.coins_uncapped, r.coins_capped_to,
           r.reward_coins
    from public.campaign_rewards r where r.campaign_sale_evaluation_id = %L$q$,
  pg_temp.id('e_uniq'))), 'REFUSED:23505',
  'E15. a second reward for the same version, sale and beneficiary is refused by the '
  'unique index, whatever any function decided');

select is(pg_temp.try_sql(format($q$
    insert into public.campaign_subject_accumulators
      (campaign_version_id, cap_subject_type, cap_subject_id)
    values (%L, 'SALES_STAFF_PROFILE', %L)$q$,
  pg_temp.id('cv_pu'), pg_temp.id('staff'))), 'REFUSED:23505',
  'E16. a duplicate accumulator row is refused by the primary key');

select ok(true,
  'E17. NOTE: a genuine two-session race is NOT proven here — pgTAP is single-'
  'transaction. What is proven is the lock''s structure, its position relative to the '
  'recalculation, and the serial invariants a correct lock guarantees');


-- ============================================================================
-- SECTION F — BOUNDARIES
-- ============================================================================
-- Migration 66's four functions are untouched. If any body changed, that is a different
-- unit's work needing its own approval — not a hash quietly refreshed here.
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_versions_matching_sale'),
  '4e20cce64647395974fa8da490c55c20', 'F1. Unit 66A''s body is byte-for-byte unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'),
  'bcaf88024d3cc06dbae6dc46670a2906', 'F2. Unit 66B''s body is byte-for-byte unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_matching_result_for_sale'),
  '0b0c06bfcd2576451036debe6401b133', 'F3. Unit 66C''s resolver is byte-for-byte unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_matching_qualified_items_for_sale'),
  '8f0bb7195e2a6716755ebd7967069966', 'F4. Unit 66C''s item helper is byte-for-byte unchanged');

-- Migration 65's guards and assertions are untouched too.
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname like 'campaign_sale_%' or p.proname like 'campaign_reward%')
             and p.prorettype = 'trigger'::regtype), 11,
  'F5. Migration 65''s eleven trigger functions are still exactly eleven');

-- Migration 67 creates no evaluation or item evidence. Every row of both exists because
-- this suite's fixture inserted it directly.
select ok(pg_temp.body('campaign_apply_reward_for_evaluation')
            !~ 'insert\s+into\s+public\.campaign_sale_',
  'F6. the applier inserts no evaluation and no item qualification');
select is((select count(*)::integer from public.campaign_sale_item_qualifications q
           where not exists (select 1 from public.verified_sale_items i
                             where i.id = q.verified_sale_item_id)), 0,
  'F7. every item qualification still points at a real authoritative sale item');

-- No reward is posted anywhere: there is nowhere to post one.
select is((select count(*)::integer from information_schema.columns
           where table_schema = 'public' and table_name = 'campaign_rewards'
             and (column_name like '%posted%' or column_name like '%ledger%'
                  or column_name like '%settled%')), 0,
  'F8. campaign_rewards gained no posting, ledger or settlement column');

select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public'
             and (table_name like '%coin%' or table_name like '%ledger%'
                  or table_name like '%wallet%' or table_name like '%balance%'
                  or table_name like '%payout%' or table_name like '%redemption%')), 0,
  'F9. still no coin, ledger, wallet, balance, payout or redemption object');

select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosrc ~* 'audit_log'
             and p.proname in ('campaign_reward_calculation_for_evaluation',
                               'campaign_apply_reward_for_evaluation')), 0,
  'F10. neither function reaches the audit log — that is Migration 68''s contract');

-- CURRENT STATE CANNOT MOVE A HISTORICAL REWARD. The campaign is paused, the product is
-- deactivated, the trading relationship is suspended and the Retailer is deactivated;
-- none of them is a source this calculation reads.
do $$
begin
  perform pg_temp.act_as(pg_temp.id('vsa'));
  perform public.set_vendor_campaign_lifecycle(pg_temp.id('cv_state_campaign'), 'PAUSE');
  perform pg_temp.sign_out();

  update public.vendor_products set status = 'INACTIVE' where id = pg_temp.id('p1');
  update public.vendor_retailers set status = 'DEACTIVATED'
   where vendor_organization_id = pg_temp.id('vendor')
     and retailer_organization_id = pg_temp.id('retailer');
  update public.organizations set status = 'DEACTIVATED' where id = pg_temp.id('retailer');
end;
$$;

select is(pg_temp.calc(pg_temp.id('e_state'))::text,
          (select v from pg_temp.snap where k = 'state_calc'),
  'F11. pausing the campaign, deactivating the product, suspending the relationship and '
  'deactivating the Retailer leave the calculation byte-identical');

select is((select h.lifecycle_status from public.campaign_version_status_history h
           where h.campaign_id = pg_temp.id('cv_state_campaign') and h.valid_to is null),
  'PAUSED', 'F12. ...and the campaign really is paused, so F11 is not a vacuous comparison');

select is((select vp.status from public.vendor_products vp where vp.id = pg_temp.id('p1')),
  'INACTIVE', 'F13. ...and the product really is deactivated');

select ok(true,
  'F14. NOTE: no Web or Flutter surface exists to change — Migration 67 adds no RPC, no '
  'permission and no grant, so nothing outside the database can reach either function');

select ok(true,
  'F15. NOTE: this suite writes only to the local test transaction, which pgTAP rolls '
  'back; no hosted database is contacted and no hosted row is written');


select pg_temp.sign_out();

select * from finish();
rollback;
