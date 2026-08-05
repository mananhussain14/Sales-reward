-- Tests for Phase 2A-D, Migration 68.
--
--   Unit 68A  the CAMPAIGN_EVALUATION_EXECUTE permission                Section A
--   Unit 68B  campaign_execute_evaluation_for_verified_sale(uuid)       Sections C-F
--   Unit 68C  evaluate_verified_sale_campaigns(uuid)                    Sections B, C, G
--   Unit 68D  get_verified_sale_campaign_results(uuid)                  Section H
--             get_verified_sale_campaign_qualifying_items(uuid)
--
-- Run with:  supabase test db
--
-- ============================================================================
-- WHAT THIS SUITE IS PROTECTING
-- ============================================================================
--   1. AUTHORIZATION IS IN THE DATABASE. Every denial — signed out, no profile, no
--      membership, suspended membership, no permission, wrong Vendor — is proven against
--      the RPC itself, not against a screen. Section B.
--
--   2. THE GATES ARE RE-CHECKED AFTER THE LOCK. An exclusion recorded between the read
--      and the write must stop the evaluation, and the only way to guarantee that is to
--      ask again once the row is held. Section C.
--
--   3. EVERY CANDIDATE IS WRITTEN DOWN, including the ones that earned nothing. An absent
--      row cannot distinguish "said no" from "was never asked". Section D.
--
--   4. ITEM EVIDENCE EXISTS ONLY FOR THE QUALIFIED, and reconciles exactly with what its
--      envelope declared. Section D.
--
--   5. A REPLAY CHANGES NOTHING — no second evaluation, item, reward, accumulator
--      movement or audit row — and a disagreement with stored evidence RAISES rather than
--      being reconciled away. Section E.
--
--   6. MIGRATION 68 COMPOSES AND DOES NOT REDO. No matching, no reward formula, no
--      accumulator write, no reward INSERT of its own. Section I.
--
-- ============================================================================
-- THE PINNED AUDIT CONTRACT
-- ============================================================================
-- Stated here because it is a choice, not a derivation, and Section G exists to hold it
-- still:
--
--   * evidence created            -> exactly ONE CAMPAIGN_EVALUATION_EXECUTED row
--   * replay that created nothing -> NO row, matching finalize_claim_receipt_sale_items,
--                                    which writes nothing on ALREADY_ACCEPTED
--   * zero candidates             -> ONE row, every execution, because there is no
--                                    evidence for a replay to recognise itself by and the
--                                    alternative is an execution table this milestone
--                                    does not need
--   * any failure                 -> NO row, following the deployed convention that
--                                    refused transactions are not audited

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
  v_path := 'ce/' || v_id::text || '.png';
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

/* A receipt carried to a complete ACCEPTED authoritative item set — the only state from
   which an evaluation may legitimately be built. */
create function pg_temp.full_sale(
  p_key text, p_retailer uuid, p_shop uuid, p_staff uuid, p_vendor uuid,
  p_reviewer uuid, p_lines jsonb, p_offset interval default interval '2 hours'
) returns uuid language plpgsql as $$
declare v_r uuid; v_local timestamp;
begin
  -- THE SAME TIME DISCIPLINE MIGRATION 66'S SUITE ESTABLISHED, and for the same reason.
  -- campaign_version_status_history is stamped with clock_timestamp() when a campaign is
  -- published, which a test cannot choose. A sale placed AHEAD of the run therefore falls
  -- inside whatever interval is open once publishing finishes; a sale placed in the past
  -- falls before every interval and legitimately resolves to NO_TEMPORAL_RECORD.
  v_local := date_trunc('minute', (now() + p_offset) at time zone 'Asia/Dubai');

  v_r := pg_temp.new_receipt(p_retailer, p_shop, p_staff);
  insert into pg_temp.f values (p_key || '_receipt', v_r);

  perform pg_temp.act_as(p_staff);
  perform public.confirm_receipt_with_products(
    v_r, v_local::date, 'AED', 2::smallint, 12345::bigint, p_lines,
    'Test Merchant', 'DOC-1', v_local::time, 10000::bigint, 2345::bigint);

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

/* A sale whose product proposal was REJECTED: a real, reachable state with a decision but
   NO authoritative items, so receipt_has_finalized_sale_items is false. */
create function pg_temp.unfinalized_sale(
  p_key text, p_retailer uuid, p_shop uuid, p_staff uuid, p_vendor uuid,
  p_reviewer uuid, p_lines jsonb
) returns uuid language plpgsql as $$
declare v_r uuid; v_local timestamp;
begin
  v_local := date_trunc('minute', (now() + interval '2 hours') at time zone 'Asia/Dubai');

  v_r := pg_temp.new_receipt(p_retailer, p_shop, p_staff);
  insert into pg_temp.f values (p_key || '_receipt', v_r);

  perform pg_temp.act_as(p_staff);
  perform public.confirm_receipt_with_products(
    v_r, v_local::date, 'AED', 2::smallint, 12345::bigint, p_lines,
    'Test Merchant', 'DOC-2', v_local::time, 10000::bigint, 2345::bigint);

  insert into public.receipt_review_decisions
    (receipt_submission_id, vendor_organization_id, decision, decided_by_profile_id)
  values (v_r, p_vendor, 'VERIFIED', p_reviewer);

  perform pg_temp.act_as(p_reviewer);
  perform public.finalize_claim_receipt_sale_header(v_r, null);
  perform public.finalize_claim_receipt_sale_items(v_r, 'REJECTED', 'ILLEGIBLE');
  perform pg_temp.sign_out();

  insert into pg_temp.f
  select p_key, v.id from public.verified_sales v where v.receipt_submission_id = v_r;
  return pg_temp.id(p_key);
end;
$$;

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
    -- The period reaches back 60 days so the historic sale is RELEVANT on every
    -- non-temporal fact and fails only on the missing status interval. Without that it
    -- would be omitted for being outside the period, and the NOT_EVALUABLE assertions
    -- would prove nothing.
    p_name, 'Described.', now() - interval '60 days', now() + interval '30 days',
    'Asia/Dubai', 'ALL_RETAILERS', p_performance, p_scope, p_stacking, p_excl_key,
    p_priority, p_rule, p_per_unit, p_threshold, p_bonus, p_cap, null, null, p_products);
  perform public.publish_vendor_campaign(v_c);
  select c.published_version_id into v_v from public.campaigns c where c.id = v_c;
  perform pg_temp.sign_out();
  insert into pg_temp.f values (p_key || '_campaign', v_c), (p_key, v_v);
  return v_v;
end;
$$;

/* The RPC and the private evaluator, as jsonb arrays, so an assertion can name one field
   of one row without re-running the call. */
create function pg_temp.rpc(p_sale uuid) returns jsonb
language sql volatile as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.campaign_version_id), '[]'::jsonb)
  from public.evaluate_verified_sale_campaigns(p_sale) t
$$;

create function pg_temp.exec(p_sale uuid) returns jsonb
language sql volatile as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.campaign_version_id), '[]'::jsonb)
  from public.campaign_execute_evaluation_for_verified_sale(p_sale) t
$$;

/* Run once and record, so no assertion re-runs an execution and observes the replay. */
create table pg_temp.r (k text primary key, v jsonb);
create function pg_temp.run(p_key text, p_sale uuid) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  begin
    v := pg_temp.rpc(p_sale);
  exception when others then
    v := jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
  end;
  insert into pg_temp.r values (p_key, v);
  return v;
end;
$$;

create function pg_temp.res(p text) returns jsonb language sql stable as $$
  select v from pg_temp.r where k = p
$$;

/* The recorded rows, as a set. A run that RAISED is recorded as an error object rather
   than an array; every reader below yields nothing for it instead of erroring, so a
   mutation that breaks execution produces NAMED failures rather than one harness crash. */
create function pg_temp.elems(p_key text) returns setof jsonb
language sql stable as $$
  select e from jsonb_array_elements(
    case when jsonb_typeof(pg_temp.res(p_key)) = 'array'
         then pg_temp.res(p_key) else '[]'::jsonb end) e
$$;

/* The recorded row for one campaign version, or NULL. */
create function pg_temp.row_for(p_key text, p_version uuid) returns jsonb
language sql stable as $$
  select e from pg_temp.elems(p_key) e
  where e ->> 'campaign_version_id' = p_version::text
$$;

create function pg_temp.fld(p_key text, p_version uuid, p_field text) returns text
language sql stable as $$
  select pg_temp.row_for(p_key, p_version) ->> p_field
$$;

create function pg_temp.rows_in(p_key text) returns integer
language sql stable as $$
  select case when jsonb_typeof(pg_temp.res(p_key)) = 'array'
              then jsonb_array_length(pg_temp.res(p_key)) else -1 end
$$;

create function pg_temp.try_rpc(p_sale uuid) returns text language plpgsql as $$
begin perform pg_temp.rpc(p_sale); return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

create function pg_temp.try_exec(p_sale uuid) returns text language plpgsql as $$
begin perform pg_temp.exec(p_sale); return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

create function pg_temp.try_sql(s text) returns text language plpgsql as $$
begin execute s; return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

/* Counters over stored evidence. */
create function pg_temp.eval_count(p_sale uuid) returns integer language sql stable as $$
  select count(*)::integer from public.campaign_sale_evaluations e where e.verified_sale_id = p_sale
$$;
create function pg_temp.item_count(p_sale uuid) returns integer language sql stable as $$
  select count(*)::integer from public.campaign_sale_item_qualifications q where q.verified_sale_id = p_sale
$$;
create function pg_temp.reward_count(p_sale uuid) returns integer language sql stable as $$
  select count(*)::integer from public.campaign_rewards r where r.verified_sale_id = p_sale
$$;
create function pg_temp.acc_digest() returns text language sql stable as $$
  select coalesce(md5(string_agg(
    a.campaign_version_id::text || '|' || a.cap_subject_id::text || '|' ||
    a.units_counted_total || '|' || a.coins_awarded_total || '|' || a.target_bonus_awarded,
    ',' order by a.campaign_version_id, a.cap_subject_id)), 'EMPTY')
  from public.campaign_subject_accumulators a
$$;
create function pg_temp.audit_count(p_receipt uuid) returns integer language sql stable as $$
  select count(*)::integer from public.audit_logs l
  where l.action = 'CAMPAIGN_EVALUATION_EXECUTED' and l.entity_id = p_receipt::text
$$;
create function pg_temp.audit_row(p_receipt uuid) returns public.audit_logs
language sql stable as $$
  select l.* from public.audit_logs l
  where l.action = 'CAMPAIGN_EVALUATION_EXECUTED' and l.entity_id = p_receipt::text
  order by l.created_at desc limit 1
$$;

/* Executable body with line comments stripped, so the migration's own prose cannot
   satisfy or trip a structural assertion. */
create function pg_temp.body(p_name text) returns text language sql stable as $$
  select lower(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', ' ', 'g'), '\s+', ' ', 'g'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name
$$;

create function pg_temp.reader(p_sale uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  from public.get_verified_sale_campaign_results(p_sale) t
$$;
create function pg_temp.reader_items(p_sale uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  from public.get_verified_sale_campaign_qualifying_items(p_sale) t
$$;
create function pg_temp.reader_order(p_sale uuid) returns uuid[] language sql stable as $$
  select array_agg(t.campaign_version_id) from public.get_verified_sale_campaign_results(p_sale) t
$$;


-- ============================================================================
-- Fixture
-- ============================================================================
-- Two Vendors, so every isolation claim is tested against a real second tenant rather
-- than against an absence.
do $$
declare v uuid;
begin
  insert into pg_temp.f values
    ('vendor',   pg_temp.new_org('CE Vendor',   'VENDOR')),
    ('vendor_b', pg_temp.new_org('CE Vendor B', 'VENDOR')),
    ('retailer', pg_temp.new_org('CE Retailer', 'RETAILER'));

  insert into pg_temp.f values
    ('vsa',      pg_temp.new_person('CE','Admin')),
    ('rev',      pg_temp.new_person('CE','Rev')),
    ('rev_b',    pg_temp.new_person('CE','RevB')),
    ('rev_susp', pg_temp.new_person('CE','RevSuspended')),
    ('staff',    pg_temp.new_person('CE','Staff')),
    ('staff2',   pg_temp.new_person('CE','StaffTwo')),
    ('nobody',   pg_temp.new_person('CE','Nobody')),
    ('ghost',    gen_random_uuid());

  perform pg_temp.add_member(pg_temp.id('vsa'),      pg_temp.id('vendor'),   'VENDOR_SUPER_ADMIN');
  perform pg_temp.add_member(pg_temp.id('rev'),      pg_temp.id('vendor'),   'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('rev_b'),    pg_temp.id('vendor_b'), 'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('rev_susp'), pg_temp.id('vendor'),   'CLAIM_REVIEWER', 'SUSPENDED');
  perform pg_temp.add_member(pg_temp.id('staff'),    pg_temp.id('retailer'), 'SALES_STAFF');
  perform pg_temp.add_member(pg_temp.id('staff2'),   pg_temp.id('retailer'), 'SALES_STAFF');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (pg_temp.id('vendor'),   pg_temp.id('retailer'), 'ACTIVE'),
         (pg_temp.id('vendor_b'), pg_temp.id('retailer'), 'ACTIVE');

  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer'), 'CE Shop', 'CES', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop', v);

  insert into pg_temp.f values
    ('p1', pg_temp.new_product(pg_temp.id('vendor'),   'CE-1', 'Product One', pg_temp.id('vsa'))),
    ('p2', pg_temp.new_product(pg_temp.id('vendor'),   'CE-2', 'Product Two', pg_temp.id('vsa'))),
    ('p3', pg_temp.new_product(pg_temp.id('vendor'),   'CE-3', 'Product Three', pg_temp.id('vsa'))),
    ('pb', pg_temp.new_product(pg_temp.id('vendor_b'), 'CE-B', 'Product B',   pg_temp.id('vsa')));
  perform pg_temp.assign(pg_temp.id('p1'), pg_temp.id('retailer'), pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('p2'), pg_temp.id('retailer'), pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('p3'), pg_temp.id('retailer'), pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('pb'), pg_temp.id('retailer'), pg_temp.id('vsa'));
end;
$$;

-- Sales. Built BEFORE any campaign is published, so nothing about a campaign can have
-- influenced the authoritative sale.
do $$
begin
  -- The main sale: two lines, five units, one campaign product and one that is not.
  perform pg_temp.full_sale('s_main', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2), pg_temp.line(pg_temp.id('p2'), 3)));

  -- A second sale for the same staff member, used for the TARGET_BONUS accumulation.
  perform pg_temp.full_sale('s_second', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 4)));

  -- A sale that will match NO campaign at all: its only product is Vendor B's.
  perform pg_temp.full_sale('s_zero', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff2'), pg_temp.id('vendor_b'), pg_temp.id('rev_b'),
    jsonb_build_array(pg_temp.line(pg_temp.id('pb'), 1)));

  -- A sale to be excluded after it is complete.
  perform pg_temp.full_sale('s_excl', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));

  -- A sale whose item proposal was REJECTED: complete decision, zero authoritative items.
  perform pg_temp.unfinalized_sale('s_unfin', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));

  -- A sale dated BEFORE any campaign was published. Every candidate's status timeline is
  -- silent about that instant, which is the only route to NO_TEMPORAL_RECORD now that
  -- campaign_version_status_history is append-only and its intervals cannot be removed.
  perform pg_temp.full_sale('s_past', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff2'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)), interval '-30 days');

  -- Replay and conflict probes.
  perform pg_temp.full_sale('s_replay', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));
  perform pg_temp.full_sale('s_conf', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));
  perform pg_temp.full_sale('s_conf2', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));
  -- TWO lines, so a hand-built item row can name the line the snapshot campaign never
  -- admitted.
  perform pg_temp.full_sale('s_itemconf', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2), pg_temp.line(pg_temp.id('p2'), 3)));
end;
$$;

-- Campaigns. Published AFTER the sales, so no campaign could have shaped a sale.
do $$
begin
  -- The rewarded per-unit campaign, scoped to product p1 by SNAPSHOT.
  perform pg_temp.publish('cv_snap', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CE Snapshot',
    'INDIVIDUAL_STAFF', 'SELECTED_PRODUCTS', 'STACKABLE', null,
    'PER_UNIT_COINS', 5, null, null, null,
    array[pg_temp.id('p1')]::uuid[], 10);

  -- A LIVE_TEMPORAL campaign over every eligible product, so both lines qualify.
  perform pg_temp.publish('cv_live', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CE Live',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'STACKABLE', null,
    'PER_UNIT_COINS', 7, null, null, null, null, 20);

  -- A campaign whose only product is p3, which no sale contains: NO_QUALIFYING_ITEMS.
  perform pg_temp.publish('cv_none', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CE NoItems',
    'INDIVIDUAL_STAFF', 'SELECTED_PRODUCTS', 'STACKABLE', null,
    'PER_UNIT_COINS', 5, null, null, null,
    array[pg_temp.id('p3')]::uuid[], 5);

  -- Two EXCLUSIVE campaigns sharing a key: the lower priority one must be suppressed.
  perform pg_temp.publish('cv_win', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CE ExclusiveWin',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'EXCLUSIVE', 'CE-KEY',
    'PER_UNIT_COINS', 3, null, null, null, null, 900);
  perform pg_temp.publish('cv_lose', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CE ExclusiveLose',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'EXCLUSIVE', 'CE-KEY',
    'PER_UNIT_COINS', 999, null, null, null, null, 100);

  -- A TARGET_BONUS campaign whose threshold the first sale cannot reach.
  perform pg_temp.publish('cv_target', pg_temp.id('vendor'), pg_temp.id('vsa'), 'CE Target',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'STACKABLE', null,
    'TARGET_BONUS', null, 8, 100, null, null, 15);
end;
$$;

-- ============================================================================
-- SECTION A — SCHEMA, PERMISSION AND SECURITY POSTURE
-- ============================================================================
select is((select count(*)::integer from supabase_migrations.schema_migrations
           where version = '20260826090000'), 1,
  'A1. Migration 68 is recorded exactly once');

select is((select count(*)::integer from supabase_migrations.schema_migrations
           where version > '20260826090000'), 0,
  'A2. no migration after 20260826090000 exists — Migration 69 has not begun');

select has_function('public', 'campaign_execute_evaluation_for_verified_sale', array['uuid'],
  'A3. the private evaluator exists with the exact signature');
select has_function('public', 'evaluate_verified_sale_campaigns', array['uuid'],
  'A4. the browser RPC exists with the exact signature');
select has_function('public', 'get_verified_sale_campaign_results', array['uuid'],
  'A5. the evaluation read exists with the exact signature');
select has_function('public', 'get_verified_sale_campaign_qualifying_items', array['uuid'],
  'A6. the item read exists with the exact signature');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_execute_evaluation_for_verified_sale'),
  'TABLE(verified_sale_id uuid, receipt_submission_id uuid, campaign_sale_evaluation_id uuid, '
  'campaign_id uuid, campaign_version_id uuid, outcome text, non_qualification_reason text, '
  'qualifying_item_count integer, qualifying_units integer, campaign_reward_id uuid, '
  'reward_coins bigint, reward_created boolean, evaluation_created boolean, '
  'application_result text)',
  'A7. the evaluator contract is exactly the approved 14 columns and types');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'evaluate_verified_sale_campaigns'),
  (select pg_get_function_result(p.oid) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'campaign_execute_evaluation_for_verified_sale'),
  'A8. the RPC returns exactly the evaluator''s contract — nothing is added or hidden '
  'on the way to the browser');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_verified_sale_campaign_results'),
  'TABLE(campaign_id uuid, campaign_version_id uuid, campaign_name text, outcome text, '
  'non_qualification_reason text, qualifying_item_count integer, qualifying_units integer, '
  'rule_type text, coins_per_unit bigint, threshold_units integer, '
  'configured_reward_coins bigint, max_reward_coins bigint, coins_uncapped bigint, '
  'coins_capped_to bigint, reward_coins bigint, awarded_at timestamp with time zone)',
  'A9. the evaluation read contract is exactly the approved 16 columns and types');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_verified_sale_campaign_qualifying_items'),
  'TABLE(campaign_id uuid, campaign_version_id uuid, verified_sale_item_id uuid, '
  'vendor_product_id uuid, product_code_at_proposal text, product_name_at_proposal text, '
  'line_number integer, qualifying_units integer, product_source text, '
  'product_status_at_sale text, assignment_status_at_sale text)',
  'A10. the item read contract is exactly the approved 11 columns and types');

-- Volatility. The two writers are VOLATILE; the two reads are STABLE.
select is((select string_agg(p.proname || '=' || p.provolatile::text, ',' order by p.proname)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in
             ('campaign_execute_evaluation_for_verified_sale','evaluate_verified_sale_campaigns',
              'get_verified_sale_campaign_results','get_verified_sale_campaign_qualifying_items')),
  'campaign_execute_evaluation_for_verified_sale=v,evaluate_verified_sale_campaigns=v,'
  'get_verified_sale_campaign_qualifying_items=s,get_verified_sale_campaign_results=s',
  'A11. the two writers are VOLATILE and the two reads are STABLE');

select ok((select bool_and(p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in
             ('campaign_execute_evaluation_for_verified_sale','evaluate_verified_sale_campaigns',
              'get_verified_sale_campaign_results','get_verified_sale_campaign_qualifying_items')),
  'A12. all four are SECURITY DEFINER');

select ok((select bool_and(p.proconfig @> array['search_path=""'])
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in
             ('campaign_execute_evaluation_for_verified_sale','evaluate_verified_sale_campaigns',
              'get_verified_sale_campaign_results','get_verified_sale_campaign_qualifying_items')),
  'A13. all four run with an empty search_path');

-- THE PRIVATE EVALUATOR IS OWNER-ONLY. This is the assertion that keeps the permission
-- check meaningful: a browser that could call the evaluator directly would bypass it.
select is((select p.proacl::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_execute_evaluation_for_verified_sale'),
  '{postgres=X/postgres}',
  'A14. the private evaluator is owner-execute-only');

select is((select string_agg(p.proname || '=' || p.proacl::text, ' ' order by p.proname)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in
             ('evaluate_verified_sale_campaigns','get_verified_sale_campaign_results',
              'get_verified_sale_campaign_qualifying_items')),
  'evaluate_verified_sale_campaigns={postgres=X/postgres,authenticated=X/postgres} '
  'get_verified_sale_campaign_qualifying_items={postgres=X/postgres,authenticated=X/postgres} '
  'get_verified_sale_campaign_results={postgres=X/postgres,authenticated=X/postgres}',
  'A15. the three browser functions grant EXECUTE to authenticated and to nobody else');

select is((select count(*)::integer from information_schema.role_routine_grants
           where routine_schema = 'public'
             and routine_name in ('campaign_execute_evaluation_for_verified_sale',
                                  'evaluate_verified_sale_campaigns',
                                  'get_verified_sale_campaign_results',
                                  'get_verified_sale_campaign_qualifying_items')
             and grantee in ('anon','PUBLIC','service_role')), 0,
  'A16. no anon, PUBLIC or service_role execution exists on any of the four');

select ok((select bool_and(obj_description(p.oid, 'pg_proc') is not null)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in
             ('campaign_execute_evaluation_for_verified_sale','evaluate_verified_sale_campaigns',
              'get_verified_sale_campaign_results','get_verified_sale_campaign_qualifying_items')),
  'A17. all four are documented');

select ok((select bool_and(p.prosrc !~* '\mexecute\s+''|\mformat\s*\(|\mquote_ident\M')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in
             ('campaign_execute_evaluation_for_verified_sale','evaluate_verified_sale_campaigns',
              'get_verified_sale_campaign_results','get_verified_sale_campaign_qualifying_items')),
  'A18. none uses dynamic SQL');

-- ---- THE PERMISSION --------------------------------------------------------
select is((select count(*)::integer from public.permissions
           where code = 'CAMPAIGN_EVALUATION_EXECUTE'), 1,
  'A19. the evaluation permission exists exactly once');

select is((select module from public.permissions where code = 'CAMPAIGN_EVALUATION_EXECUTE'),
  'CLAIM_REVIEW', 'A20. ...in the CLAIM_REVIEW module the reviewer already works in');

select is((select count(*)::integer from public.permissions), 33,
  'A21. the catalogue grew by exactly one, from 32 to 33');

select is((select coalesce(string_agg(r.code, ',' order by r.code), 'NONE')
           from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           join public.permissions p on p.id = rp.permission_id
           where p.code = 'CAMPAIGN_EVALUATION_EXECUTE'),
  'CLAIM_REVIEWER',
  'A22. CLAIM_REVIEWER holds it, and NO other role does');

-- Each exclusion named individually, so a future grant to any of them fails visibly.
select is((select count(*)::integer from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           join public.permissions p on p.id = rp.permission_id
           where p.code = 'CAMPAIGN_EVALUATION_EXECUTE'
             and r.code in ('VENDOR_SUPER_ADMIN','FINANCE_ADMIN','SALES_STAFF',
                            'RETAILER_OWNER','RETAILER_MANAGER')), 0,
  'A23. not Vendor Super Admin, Finance Admin, Sales Staff, Retailer Owner or Retailer '
  'Manager — the campaign author and the reward beneficiary are both excluded');

-- ---- BOUNDARIES ------------------------------------------------------------
select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'), 47,
  'A24. Migration 68 added no table — still the 47 from Migration 65');

select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public'
             and (table_name like '%coin%' or table_name like '%ledger%'
                  or table_name like '%wallet%' or table_name like '%balance%'
                  or table_name like '%payout%' or table_name like '%redemption%')), 0,
  'A25. no coin, ledger, wallet, balance, payout or redemption table exists');

select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname like '%coin_ledger%' or p.proname like '%wallet%'
                  or p.proname like '%payout%' or p.proname like '%redemption%'
                  or p.proname like '%revers%')), 0,
  'A26. no ledger, wallet, payout, redemption or reversal function exists');

select is((select count(*)::integer from pg_policies
           where schemaname = 'public'
             and tablename in ('campaign_sale_evaluations','campaign_sale_item_qualifications',
                               'campaign_rewards','campaign_subject_accumulators')), 0,
  'A27. the evidence tables still carry ZERO policies — the read RPCs are the only path');


-- ============================================================================
-- SECTION B — AUTHORIZATION
-- ============================================================================
-- Every denial is proven against the RPC in the database, never against a screen.
select pg_temp.sign_out();
select is(pg_temp.try_rpc(pg_temp.id('s_main')), 'REFUSED:42501',
  'B1. an ANONYMOUS caller is refused');

select pg_temp.act_as(pg_temp.id('ghost'));
select is(pg_temp.try_rpc(pg_temp.id('s_main')), 'REFUSED:42501',
  'B2. an authenticated caller with NO PROFILE is refused');

select pg_temp.act_as(pg_temp.id('nobody'));
select is(pg_temp.try_rpc(pg_temp.id('s_main')), 'REFUSED:42501',
  'B3. a caller with a profile but NO MEMBERSHIP is refused');

select pg_temp.act_as(pg_temp.id('rev_susp'));
select is(pg_temp.try_rpc(pg_temp.id('s_main')), 'REFUSED:42501',
  'B4. a caller whose membership is SUSPENDED is refused');

select pg_temp.act_as(pg_temp.id('staff'));
select is(pg_temp.try_rpc(pg_temp.id('s_main')), 'REFUSED:42501',
  'B5. Sales Staff — the reward beneficiary — cannot trigger their own evaluation');

select pg_temp.act_as(pg_temp.id('vsa'));
select is(pg_temp.try_rpc(pg_temp.id('s_main')), 'REFUSED:42501',
  'B6. the Vendor Super Admin who AUTHORS campaigns is refused: separation of duties');

select pg_temp.act_as(pg_temp.id('rev_b'));
select is(pg_temp.try_rpc(pg_temp.id('s_main')), 'REFUSED:42501',
  'B7. a Claim Reviewer of ANOTHER Vendor is refused — the tenant boundary holds even '
  'though both Vendors trade with this Retailer');

select pg_temp.act_as(pg_temp.id('rev'));
select is(pg_temp.try_rpc(gen_random_uuid()), 'REFUSED:42501',
  'B8. an unknown sale gives the SAME refusal as a foreign one, so the RPC cannot be '
  'used to discover which sales exist');

-- The refusals above must not have written anything.
select is((select count(*)::integer from public.campaign_sale_evaluations), 0,
  'B9. eight refused calls created no evaluation evidence at all');
select is(pg_temp.audit_count(pg_temp.id('s_main_receipt')), 0,
  'B10. ...and no audit row: the deployed convention does not audit refused transactions');

-- The caller supplies a sale id and nothing else.
select is((select count(*)::integer from information_schema.parameters
           where specific_schema = 'public'
             and specific_name in (select specific_name from information_schema.routines
                                   where routine_schema='public'
                                     and routine_name='evaluate_verified_sale_campaigns')
             and parameter_mode = 'IN'), 1,
  'B11. the RPC takes exactly ONE input parameter — no tenant, beneficiary, campaign, '
  'unit, rate or reward value can be nominated');

select is((select p.proargnames[1] from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'evaluate_verified_sale_campaigns'),
  'p_verified_sale_id', 'B12. ...and that parameter is the sale id');

select ok(pg_temp.body('evaluate_verified_sale_campaigns')
            ~ 'resolve_claim_reviewer_organization\(''campaign_evaluation_execute''\)',
  'B13. the RPC checks the exact permission through the deployed authorization helper');

select ok(pg_temp.body('evaluate_verified_sale_campaigns')
            ~ 'v_sale\.vendor_organization_id is distinct from v_vendor',
  'B14. ...and enforces that the actor''s Vendor is the SALE''S OWN frozen Vendor');


-- ============================================================================
-- SECTION C — EXECUTION
-- ============================================================================
select pg_temp.act_as(pg_temp.id('rev'));

-- Preconditions, so every assertion below is known to be about the rule and not about a
-- fixture that never qualified in the first place.
select ok(public.receipt_has_finalized_sale_items(pg_temp.id('s_main_receipt')),
  'C0a. the main sale really has a complete finalized item set');
select is((select count(*)::integer from public.verified_sale_items i
           where i.verified_sale_id = pg_temp.id('s_main')), 2,
  'C0b. ...of two authoritative lines');

do $$ begin perform pg_temp.run('main', pg_temp.id('s_main')); end; $$;

select is(pg_temp.res('main') -> 'error', null::jsonb,
  'C1. an authorized Claim Reviewer evaluates a finalized sale successfully');

select is(pg_temp.rows_in('main'), 6,
  'C2. all six candidate campaigns produced a stored evaluation row');

select is(pg_temp.try_rpc(pg_temp.id('s_unfin')), 'REFUSED:23514',
  'C3. a sale whose item proposal was REJECTED has no finalized item set and is refused');

select is((select count(*)::integer from public.verified_sale_items i
           where i.verified_sale_id = pg_temp.id('s_unfin')), 0,
  'C4. ...and the refusal is because it genuinely has zero authoritative items');

-- The exclusion is recorded AFTER the sale is complete, which is the ordering the
-- deployed schema permits and the one an evaluator must survive.
do $$
begin
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.record_claim_receipt_qualification(
    pg_temp.id('s_excl_receipt'), 'EXCLUDE', 'DUPLICATE', null);
end;
$$;

select ok(public.receipt_qualification_is_excluded(pg_temp.id('s_excl_receipt')),
  'C5. the excluded fixture really carries an active exclusion');
select ok(public.receipt_has_finalized_sale_items(pg_temp.id('s_excl_receipt')),
  'C6. ...and its sale is genuinely complete, so the refusal is about the exclusion alone');
select is(pg_temp.try_rpc(pg_temp.id('s_excl')), 'REFUSED:42501',
  'C7. AN ACTIVE EXCLUSION prevents a new evaluation');
select is(pg_temp.eval_count(pg_temp.id('s_excl')), 0,
  'C8. ...and leaves no evidence behind');

-- Broken lineage raises rather than being recorded as a cautious empty result.
select is(pg_temp.try_exec(null), 'REFUSED:22023',
  'C9. a null sale id raises');
select is(pg_temp.try_exec(gen_random_uuid()), 'REFUSED:23503',
  'C10. a missing sale raises');

-- ---- THE LOCK, AND THE ORDER OF THE GATES ----------------------------------
select ok(pg_temp.body('campaign_execute_evaluation_for_verified_sale')
            ~ 'from public\.verified_sales v where v\.id = p_verified_sale_id for update',
  'C11. the evaluator locks the authoritative verified_sales ROW — not a table');

select ok((select regexp_count(pg_temp.body('campaign_execute_evaluation_for_verified_sale'),
                               'for update') = 1),
  'C12. exactly one row is locked, so there is no lock ordering to deadlock on');

select ok(position('for update' in pg_temp.body('campaign_execute_evaluation_for_verified_sale'))
          < position('receipt_qualification_is_excluded'
                     in pg_temp.body('campaign_execute_evaluation_for_verified_sale')),
  'C13. THE EXCLUSION CHECK HAPPENS AFTER THE LOCK, so an exclusion landing in the gap '
  'cannot be evaluated straight past');

select ok(position('for update' in pg_temp.body('campaign_execute_evaluation_for_verified_sale'))
          < position('receipt_has_finalized_sale_items'
                     in pg_temp.body('campaign_execute_evaluation_for_verified_sale')),
  'C14. ...and so does the finalization check');

select ok(position('for update' in pg_temp.body('campaign_execute_evaluation_for_verified_sale'))
          < position('campaign_matching_result_for_sale'
                     in pg_temp.body('campaign_execute_evaluation_for_verified_sale')),
  'C15. ...and the matching result is only asked for once the row is held');

-- ---- IT COMPOSES ------------------------------------------------------------
select ok(pg_temp.body('campaign_execute_evaluation_for_verified_sale')
            ~ 'campaign_matching_result_for_sale',
  'C16. the evaluator uses Migration 66''s resolver rather than re-deriving matching');
select ok(pg_temp.body('campaign_execute_evaluation_for_verified_sale')
            ~ 'campaign_matching_qualified_items_for_sale',
  'C17. ...and Migration 66''s item helper rather than re-deriving eligibility');
select ok(pg_temp.body('campaign_execute_evaluation_for_verified_sale')
            ~ 'campaign_apply_reward_for_evaluation',
  'C18. ...and Migration 67''s applier rather than calculating a reward');

select ok(pg_temp.body('campaign_execute_evaluation_for_verified_sale')
            !~ 'insert\s+into\s+public\.campaign_rewards',
  'C19. MIGRATION 68 NEVER INSERTS A REWARD ITSELF');
select ok(pg_temp.body('campaign_execute_evaluation_for_verified_sale')
            !~ 'campaign_subject_accumulators',
  'C20. ...and never touches the accumulator: that is Migration 67''s alone');
select ok(pg_temp.body('campaign_execute_evaluation_for_verified_sale')
            !~ 'campaign_eligible_products|campaign_eligible_retailers|campaign_version_status_history|vendor_product_status_history|vendor_product_retailer_assignment',
  'C21. ...and never reaches past its helpers into the matching sources');
select ok(pg_temp.body('campaign_execute_evaluation_for_verified_sale') !~ 'audit_log',
  'C22. the private evaluator writes no audit — that belongs to the RPC');


-- ============================================================================
-- SECTION D — THE STORED EVIDENCE
-- ============================================================================
select is(pg_temp.eval_count(pg_temp.id('s_main')), 6,
  'D1. exactly six evaluation rows exist for the sale — one per candidate campaign');

select is((select count(*)::integer from (
             select e.campaign_version_id, e.verified_sale_id
             from public.campaign_sale_evaluations e
             where e.verified_sale_id = pg_temp.id('s_main')
             group by 1,2 having count(*) > 1) d), 0,
  'D2. ONE EVALUATION PER CAMPAIGN VERSION PER SALE — no duplicate pair exists');

-- QUALIFIED, with exact counts.
select is(pg_temp.fld('main', pg_temp.id('cv_snap'), 'outcome'), 'QUALIFIED',
  'D3. the SNAPSHOT campaign qualified');
select is(pg_temp.fld('main', pg_temp.id('cv_snap'), 'qualifying_item_count'), '1',
  'D4. ...counting exactly the one line whose product is in its frozen set');
select is(pg_temp.fld('main', pg_temp.id('cv_snap'), 'qualifying_units'), '2',
  'D5. ...and exactly that line''s two units — the ineligible neighbour contributes nothing');

select is(pg_temp.fld('main', pg_temp.id('cv_live'), 'outcome'), 'QUALIFIED',
  'D6. the LIVE_TEMPORAL campaign qualified');
select is(pg_temp.fld('main', pg_temp.id('cv_live'), 'qualifying_item_count'), '2',
  'D7. ...counting both lines');
select is(pg_temp.fld('main', pg_temp.id('cv_live'), 'qualifying_units'), '5',
  'D8. ...and all five units');

-- NOT_QUALIFIED / NO_QUALIFYING_ITEMS is STORED, not omitted.
select is(pg_temp.fld('main', pg_temp.id('cv_none'), 'outcome'), 'NOT_QUALIFIED',
  'D9. a campaign whose product the basket does not contain is STORED as NOT_QUALIFIED');
select is(pg_temp.fld('main', pg_temp.id('cv_none'), 'non_qualification_reason'),
  'NO_QUALIFYING_ITEMS',
  'D10. ...with the exact reason, because an absent row cannot say "considered and no"');
select is(pg_temp.fld('main', pg_temp.id('cv_none'), 'qualifying_item_count'), '0',
  'D11. ...and zero counts');

-- NOT_EVALUABLE / NO_TEMPORAL_RECORD is STORED too. Proven on the historic sale, whose
-- instant predates every campaign's status interval.
do $$ begin perform pg_temp.run('past', pg_temp.id('s_past')); end; $$;

select is(pg_temp.res('past') -> 'error', null::jsonb,
  'D12a. the historic sale evaluates successfully');
select is((select coalesce(string_agg(distinct e ->> 'outcome', ','), 'NONE')
           from pg_temp.elems('past') e), 'NOT_EVALUABLE',
  'D12. a sale whose instant no status timeline covers is STORED as NOT_EVALUABLE');
select is((select coalesce(string_agg(distinct e ->> 'non_qualification_reason', ','), 'NONE')
           from pg_temp.elems('past') e), 'NO_TEMPORAL_RECORD',
  'D13. ...saying the history does not know, rather than guessing "no"');
select is((select count(*)::integer from pg_temp.elems('past') e
           where e ->> 'campaign_reward_id' is not null), 0,
  'D14. ...and earns no reward');
select is(pg_temp.item_count(pg_temp.id('s_past')), 0,
  'D14b. ...and carries no item evidence');

-- THE EXCLUSIVE LOSER IS STORED, SUPPRESSED.
select is(pg_temp.fld('main', pg_temp.id('cv_win'), 'outcome'), 'QUALIFIED',
  'D15. the higher-priority EXCLUSIVE campaign won its key');
select is(pg_temp.fld('main', pg_temp.id('cv_lose'), 'outcome'), 'NOT_QUALIFIED',
  'D16. the lower-priority one lost — even though it pays 999 coins a unit against 3');
select is(pg_temp.fld('main', pg_temp.id('cv_lose'), 'non_qualification_reason'),
  'SUPPRESSED_BY_EXCLUSIVITY',
  'D17. ...and is STORED with the suppression reason: "matched and lost" is evidence');
select is(pg_temp.fld('main', pg_temp.id('cv_lose'), 'qualifying_units'), '0',
  'D18. ...with zero units');
select is((select count(*)::integer from public.campaign_sale_item_qualifications q
           where q.campaign_version_id = pg_temp.id('cv_lose')), 0,
  'D19. ...and NO item evidence at all');

-- ONLY QUALIFIED CAMPAIGNS CARRY ITEM EVIDENCE.
select is((select coalesce(string_agg(distinct e.outcome, ','), 'NONE')
           from public.campaign_sale_item_qualifications q
           join public.campaign_sale_evaluations e on e.id = q.campaign_sale_evaluation_id),
  'QUALIFIED',
  'D20. every stored item qualification belongs to a QUALIFIED evaluation and no other');

select is(pg_temp.item_count(pg_temp.id('s_main')), 7,
  'D21. seven item rows: 1 for the snapshot campaign and 2 each for live, the exclusive '
  'winner and the target campaign — and none at all for the three that earned nothing');

select is((select count(*)::integer from (
             select q.campaign_version_id, q.verified_sale_item_id
             from public.campaign_sale_item_qualifications q
             group by 1,2 having count(*) > 1) d), 0,
  'D22. no duplicate (campaign version, sale item) pair exists');

-- THE TOTALS RECONCILE, computed independently of the evaluator.
select is((select count(*)::integer from public.campaign_sale_evaluations e
           where e.verified_sale_id = pg_temp.id('s_main')
             and (e.qualifying_item_count <> (select count(*) from public.campaign_sale_item_qualifications q
                                              where q.campaign_sale_evaluation_id = e.id)
               or e.qualifying_units <> (select coalesce(sum(q.qualifying_units), 0)
                                         from public.campaign_sale_item_qualifications q
                                         where q.campaign_sale_evaluation_id = e.id))), 0,
  'D23. EVERY evaluation''s declared counts equal its stored item evidence exactly');

-- SNAPSHOT stores NULL temporal statuses; LIVE_TEMPORAL stores the resolved ones.
select is((select coalesce(string_agg(distinct
             coalesce(q.product_status_at_sale,'NULL') || '/' ||
             coalesce(q.assignment_status_at_sale,'NULL'), ','), 'NONE')
           from public.campaign_sale_item_qualifications q
           where q.campaign_version_id = pg_temp.id('cv_snap')),
  'NULL/NULL',
  'D24. SNAPSHOT item evidence records NO sale-time status, because no such check happened');
select is((select coalesce(string_agg(distinct q.product_source, ','), 'NONE')
           from public.campaign_sale_item_qualifications q
           where q.campaign_version_id = pg_temp.id('cv_snap')),
  'SNAPSHOT', 'D25. ...and names the frozen set as its source');

select is((select coalesce(string_agg(distinct
             q.product_status_at_sale || '/' || q.assignment_status_at_sale, ','), 'NONE')
           from public.campaign_sale_item_qualifications q
           where q.campaign_version_id = pg_temp.id('cv_live')),
  'ACTIVE/ACTIVE',
  'D26. LIVE_TEMPORAL item evidence records both resolved sale-time statuses');
select is((select coalesce(string_agg(distinct q.product_source, ','), 'NONE')
           from public.campaign_sale_item_qualifications q
           where q.campaign_version_id = pg_temp.id('cv_live')),
  'LIVE_TEMPORAL', 'D27. ...and names the timelines as its source');

-- REWARDS: only for QUALIFIED, and only through Migration 67.
select is((select count(*)::integer from public.campaign_rewards r
           join public.campaign_sale_evaluations e on e.id = r.campaign_sale_evaluation_id
           where e.outcome <> 'QUALIFIED'), 0,
  'D28. NO REWARD EXISTS for any evaluation that is not QUALIFIED');

select is(pg_temp.fld('main', pg_temp.id('cv_snap'), 'reward_coins'), '10',
  'D29. the snapshot campaign paid 2 units x 5 coins');
select is(pg_temp.fld('main', pg_temp.id('cv_live'), 'reward_coins'), '35',
  'D30. the live campaign paid 5 units x 7 coins');
select is(pg_temp.fld('main', pg_temp.id('cv_win'), 'reward_coins'), '15',
  'D31. the exclusive winner paid 5 units x 3 coins');
select is(pg_temp.fld('main', pg_temp.id('cv_snap'), 'application_result'), 'APPLIED',
  'D32. ...each through Migration 67''s applier, reporting APPLIED');

-- A QUALIFIED TARGET_BONUS evaluation that crosses nothing has NO reward — and that is
-- correct, not a gap.
select is(pg_temp.fld('main', pg_temp.id('cv_target'), 'outcome'), 'QUALIFIED',
  'D33. the TARGET_BONUS campaign qualified on its five units');
select is(pg_temp.fld('main', pg_temp.id('cv_target'), 'campaign_reward_id'), null,
  'D34. ...and created NO reward, because five units do not cross a threshold of eight');
select is(pg_temp.fld('main', pg_temp.id('cv_target'), 'application_result'), 'APPLIED',
  'D35. ...yet the application still ran and counted its units');

select is((select a.units_counted_total from public.campaign_subject_accumulators a
           where a.campaign_version_id = pg_temp.id('cv_target')), 5::bigint,
  'D36. the accumulator matches the stored qualified evaluation''s units');

select is((select count(*)::integer from public.campaign_subject_accumulators a
           where a.units_counted_total is distinct from (
             select coalesce(sum(e.qualifying_units), 0)
             from public.campaign_sale_evaluations e
             where e.campaign_version_id = a.campaign_version_id
               and e.outcome = 'QUALIFIED'
               and case e.performance_scope
                     when 'INDIVIDUAL_STAFF' then e.beneficiary_profile_id
                     else e.retailer_organization_id end = a.cap_subject_id)), 0,
  'D37. EVERY accumulator reconstructs from the stored QUALIFIED evaluations');

-- A second sale crosses the threshold, proving the accumulation is real.
do $$ begin perform pg_temp.run('second', pg_temp.id('s_second')); end; $$;

select is(pg_temp.fld('second', pg_temp.id('cv_target'), 'reward_coins'), '100',
  'D38. a second sale of four units carries the same staff member over the threshold '
  'and pays the bonus, through Migration 67 alone');


-- ============================================================================
-- SECTION E — IDEMPOTENT REPLAY AND CONFLICT
-- ============================================================================
do $$ begin perform pg_temp.run('replay1', pg_temp.id('s_replay')); end; $$;

select is((select count(*)::integer from pg_temp.snap where k = 'unused'), 0,
  'E0. (fixture guard)');

-- Snapshot every counter, then replay.
do $$
begin
  insert into pg_temp.snap values
    ('evals',   pg_temp.eval_count(pg_temp.id('s_replay'))::text),
    ('items',   pg_temp.item_count(pg_temp.id('s_replay'))::text),
    ('rewards', pg_temp.reward_count(pg_temp.id('s_replay'))::text),
    ('acc',     pg_temp.acc_digest()),
    ('audit',   pg_temp.audit_count(pg_temp.id('s_replay_receipt'))::text);
  perform pg_temp.run('replay2', pg_temp.id('s_replay'));
end;
$$;

select is(pg_temp.res('replay2') -> 'error', null::jsonb,
  'E1. a replay succeeds rather than raising');
select is(pg_temp.rows_in('replay2'), pg_temp.rows_in('replay1'),
  'E2. ...and returns the same number of rows');
select is((select string_agg(e ->> 'campaign_sale_evaluation_id', ',' order by e ->> 'campaign_version_id')
           from pg_temp.elems('replay2') e),
          (select string_agg(e ->> 'campaign_sale_evaluation_id', ',' order by e ->> 'campaign_version_id')
           from pg_temp.elems('replay1') e),
  'E3. ...the SAME evaluation rows, not new ones');

select is((select coalesce(string_agg(distinct e ->> 'evaluation_created', ','), 'NONE')
           from pg_temp.elems('replay1') e), 'true',
  'E4. the first execution reports every evaluation as created');
select is((select coalesce(string_agg(distinct e ->> 'evaluation_created', ','), 'NONE')
           from pg_temp.elems('replay2') e), 'false',
  'E5. the replay reports none as created');
select is((select coalesce(string_agg(distinct e ->> 'application_result', ','), 'NONE')
           from pg_temp.elems('replay2') e
           where e ->> 'outcome' = 'QUALIFIED'), 'ALREADY_APPLIED',
  'E6. ...and every reward application reports ALREADY_APPLIED');

select is(pg_temp.eval_count(pg_temp.id('s_replay'))::text,
          (select v from pg_temp.snap where k = 'evals'),
  'E7. NO DUPLICATE EVALUATION after the replay');
select is(pg_temp.item_count(pg_temp.id('s_replay'))::text,
          (select v from pg_temp.snap where k = 'items'),
  'E8. NO DUPLICATE ITEM EVIDENCE');
select is(pg_temp.reward_count(pg_temp.id('s_replay'))::text,
          (select v from pg_temp.snap where k = 'rewards'),
  'E9. NO DUPLICATE REWARD');
select is(pg_temp.acc_digest(), (select v from pg_temp.snap where k = 'acc'),
  'E10. NO ACCUMULATOR MOVEMENT — every subject row is byte-identical');
select is(pg_temp.audit_count(pg_temp.id('s_replay_receipt'))::text,
          (select v from pg_temp.snap where k = 'audit'),
  'E11. NO DUPLICATE SUCCESS AUDIT — the pinned contract, matching the deployed '
  'finalize RPC which writes nothing on an unchanged replay');

-- ---- CONFLICT ---------------------------------------------------------------
-- Stored evidence that disagrees with the derivation is not reconciled away. Migration 65
-- makes an evaluation immutable but not un-insertable, so the disagreement is built by
-- storing an outcome the resolver does not produce — which is exactly what a rewritten
-- history, a hand-edited row or a future writer's bug would look like from here.
do $$
begin
  insert into public.campaign_sale_evaluations (
    campaign_id, campaign_version_id, verified_sale_id, receipt_submission_id,
    vendor_organization_id, retailer_organization_id, retailer_shop_id,
    beneficiary_profile_id, sale_at, performance_scope, reward_recipient_scope,
    product_scope, product_eligibility_resolution, stacking_mode, exclusivity_key,
    priority, campaign_starts_at, outcome, non_qualification_reason,
    qualifying_item_count, qualifying_units, evaluated_by_profile_id)
  select m.campaign_id, m.campaign_version_id, pg_temp.id('s_conf'),
         v.receipt_submission_id, m.vendor_organization_id, m.retailer_organization_id,
         m.retailer_shop_id, m.beneficiary_profile_id, m.sale_at, m.performance_scope,
         m.reward_recipient_scope, m.product_scope, m.product_eligibility_resolution,
         m.stacking_mode, m.exclusivity_key, m.priority, m.campaign_starts_at,
         -- The resolver says QUALIFIED with one item and two units. This says no.
         'NOT_QUALIFIED', 'NO_QUALIFYING_ITEMS', 0, 0,
         pg_temp.id('rev')
  from public.campaign_matching_result_for_sale(pg_temp.id('s_conf')) m
  join public.verified_sales v on v.id = pg_temp.id('s_conf')
  where m.campaign_version_id = pg_temp.id('cv_snap');
end;
$$;

select is((select e.outcome from public.campaign_sale_evaluations e
           where e.verified_sale_id = pg_temp.id('s_conf')
             and e.campaign_version_id = pg_temp.id('cv_snap')), 'NOT_QUALIFIED',
  'E12. the stored evidence says NOT_QUALIFIED');
select is((select r.outcome from public.campaign_matching_result_for_sale(pg_temp.id('s_conf')) r
           where r.campaign_version_id = pg_temp.id('cv_snap')), 'QUALIFIED',
  'E13. ...while the resolver says QUALIFIED — a genuine disagreement about one sale');
select is(pg_temp.try_rpc(pg_temp.id('s_conf')), 'REFUSED:23514',
  'E14. A CONFLICTING RECALCULATION RAISES — no correction, no supersession, no replace');

-- The failed conflict must have left nothing behind.
select is((select e.outcome from public.campaign_sale_evaluations e
           where e.verified_sale_id = pg_temp.id('s_conf')
             and e.campaign_version_id = pg_temp.id('cv_snap')), 'NOT_QUALIFIED',
  'E15. ...and the stored row is untouched, because the whole transaction rolled back');
select is(pg_temp.eval_count(pg_temp.id('s_conf')), 1,
  'E15b. ...leaving only the one row that was there before, and none of the five the '
  'evaluator had begun inserting');
select is(pg_temp.reward_count(pg_temp.id('s_conf')), 0,
  'E15c. ...and no reward');

-- A REASON-ONLY CONFLICT. The stored row and the derived row agree on outcome and on
-- both counts, so the item reconciliation balances perfectly and the deferred completeness
-- trigger is satisfied. The ONLY thing that differs is why the campaign did not qualify —
-- "we found nothing" versus "you lost your exclusivity key" — and only the evaluation
-- comparison can catch it. Without that comparison this sale would silently keep evidence
-- that misstates a historical decision.
do $$
begin
  insert into public.campaign_sale_evaluations (
    campaign_id, campaign_version_id, verified_sale_id, receipt_submission_id,
    vendor_organization_id, retailer_organization_id, retailer_shop_id,
    beneficiary_profile_id, sale_at, performance_scope, reward_recipient_scope,
    product_scope, product_eligibility_resolution, stacking_mode, exclusivity_key,
    priority, campaign_starts_at, outcome, non_qualification_reason,
    qualifying_item_count, qualifying_units, evaluated_by_profile_id)
  select m.campaign_id, m.campaign_version_id, pg_temp.id('s_conf2'),
         v.receipt_submission_id, m.vendor_organization_id, m.retailer_organization_id,
         m.retailer_shop_id, m.beneficiary_profile_id, m.sale_at, m.performance_scope,
         m.reward_recipient_scope, m.product_scope, m.product_eligibility_resolution,
         m.stacking_mode, m.exclusivity_key, m.priority, m.campaign_starts_at,
         m.outcome, 'NO_QUALIFYING_ITEMS', m.qualifying_item_count, m.qualifying_units,
         pg_temp.id('rev')
  from public.campaign_matching_result_for_sale(pg_temp.id('s_conf2')) m
  join public.verified_sales v on v.id = pg_temp.id('s_conf2')
  where m.campaign_version_id = pg_temp.id('cv_lose');
end;
$$;

select is((select e.outcome || '/' || e.non_qualification_reason
           from public.campaign_sale_evaluations e
           where e.verified_sale_id = pg_temp.id('s_conf2')
             and e.campaign_version_id = pg_temp.id('cv_lose')),
  'NOT_QUALIFIED/NO_QUALIFYING_ITEMS',
  'E15d. the stored row says the campaign found nothing');
select is((select r.outcome || '/' || r.non_qualification_reason
           from public.campaign_matching_result_for_sale(pg_temp.id('s_conf2')) r
           where r.campaign_version_id = pg_temp.id('cv_lose')),
  'NOT_QUALIFIED/SUPPRESSED_BY_EXCLUSIVITY',
  'E15e. ...while the resolver says it lost its exclusivity key — same outcome, same '
  'zero counts, different history');
select is(pg_temp.try_rpc(pg_temp.id('s_conf2')), 'REFUSED:23514',
  'E15f. A REASON-ONLY CONFLICT RAISES, caught by the evaluation comparison alone: the '
  'item totals reconcile perfectly, so nothing else could have caught it');
select is(pg_temp.eval_count(pg_temp.id('s_conf2')), 1,
  'E15g. ...and the transaction rolled back to the single row it found');


-- CONFLICTING ITEM EVIDENCE. The item row is immutable, so the disagreement is created by
-- inserting a correct evaluation and then a WRONG item row before the evaluator runs.
do $$
declare v_eval uuid; v_item uuid;
begin
  -- Build the evaluation exactly as the evaluator would, then attach an item row that
  -- claims the wrong unit count for its line.
  insert into public.campaign_sale_evaluations (
    campaign_id, campaign_version_id, verified_sale_id, receipt_submission_id,
    vendor_organization_id, retailer_organization_id, retailer_shop_id,
    beneficiary_profile_id, sale_at, performance_scope, reward_recipient_scope,
    product_scope, product_eligibility_resolution, stacking_mode, exclusivity_key,
    priority, campaign_starts_at, outcome, non_qualification_reason,
    qualifying_item_count, qualifying_units, evaluated_by_profile_id)
  select m.campaign_id, m.campaign_version_id, pg_temp.id('s_itemconf'),
         v.receipt_submission_id, m.vendor_organization_id, m.retailer_organization_id,
         m.retailer_shop_id, m.beneficiary_profile_id, m.sale_at, m.performance_scope,
         m.reward_recipient_scope, m.product_scope, m.product_eligibility_resolution,
         m.stacking_mode, m.exclusivity_key, m.priority, m.campaign_starts_at,
         m.outcome, m.non_qualification_reason, m.qualifying_item_count, m.qualifying_units,
         pg_temp.id('rev')
  from public.campaign_matching_result_for_sale(pg_temp.id('s_itemconf')) m
  join public.verified_sales v on v.id = pg_temp.id('s_itemconf')
  where m.campaign_version_id = pg_temp.id('cv_snap')
  returning id into v_eval;

  -- The p2 LINE. cv_snap's frozen product set contains p1 alone, so the resolver never
  -- admitted this line — but Migration 65 will store it, because it is a real item of the
  -- evaluated sale carrying its own product and quantity.
  select i.id into v_item from public.verified_sale_items i
  where i.verified_sale_id = pg_temp.id('s_itemconf')
    and i.vendor_product_id = pg_temp.id('p2');

  insert into public.campaign_sale_item_qualifications (
    campaign_sale_evaluation_id, campaign_id, campaign_version_id, verified_sale_id,
    verified_sale_item_id, vendor_product_id, qualifying_units, product_source,
    product_status_at_sale, assignment_status_at_sale)
  select v_eval, e.campaign_id, e.campaign_version_id, e.verified_sale_id,
         v_item, i.vendor_product_id, i.quantity, 'SNAPSHOT', null, null
  from public.campaign_sale_evaluations e
  join public.verified_sale_items i on i.id = v_item
  where e.id = v_eval;

  insert into pg_temp.f values ('e_itemconf', v_eval);
end;
$$;

select is((select count(*)::integer from public.campaign_sale_item_qualifications q
           where q.campaign_sale_evaluation_id = pg_temp.id('e_itemconf')), 1,
  'E16. a hand-built evaluation carries one item row');

-- Every accumulator, byte for byte, immediately before the doomed execution.
do $$ begin insert into pg_temp.snap values ('acc_before_fail', pg_temp.acc_digest()); end; $$;

-- The stored evaluation declares one item and two units; the resolver agrees. The stored
-- ITEM points at the p2 line, which the snapshot campaign never admitted, so the evaluator
-- must refuse to reconcile rather than adding a second row on top.
select is(pg_temp.try_rpc(pg_temp.id('s_itemconf')) in ('REFUSED:23514','REFUSED:23505'), true,
  'E17. CONFLICTING ITEM EVIDENCE is refused rather than reconciled away');

select is((select count(*)::integer from public.campaign_sale_item_qualifications q
           where q.campaign_sale_evaluation_id = pg_temp.id('e_itemconf')), 1,
  'E18. ...and the transaction rolled back, leaving exactly the one row it found');

select is((select count(*)::integer from public.campaign_rewards r
           where r.verified_sale_id = pg_temp.id('s_itemconf')), 0,
  'E19. A FAILED EXECUTION LEAVES NO REWARD');

-- Compared against the digest taken just before the attempt rather than against a
-- reconstruction: this fixture deliberately holds a QUALIFIED evaluation that was never
-- applied, so the reconstruction identity is legitimately out of step here and only the
-- before/after comparison answers the question actually being asked.
select is(pg_temp.acc_digest(), (select v from pg_temp.snap where k = 'acc_before_fail'),
  'E20. ...and NO ACCUMULATOR MOVEMENT survived the failure: every subject row is '
  'byte-identical to the instant before it');


-- ============================================================================
-- SECTION F — ZERO CANDIDATES
-- ============================================================================
-- s_zero belongs to Vendor B, whose only campaign is none at all.
select pg_temp.act_as(pg_temp.id('rev_b'));

select is((select count(*)::integer from public.campaign_matching_result_for_sale(pg_temp.id('s_zero'))), 0,
  'F1. the zero-candidate sale genuinely matches no campaign');

do $$ begin perform pg_temp.run('zero1', pg_temp.id('s_zero')); end; $$;

select is(pg_temp.res('zero1') -> 'error', null::jsonb,
  'F2. a zero-candidate execution SUCCEEDS rather than raising');
select is(pg_temp.rows_in('zero1'), 0,
  'F3. ...and returns an empty result');
select is(pg_temp.eval_count(pg_temp.id('s_zero')), 0,
  'F4. ...creating no evaluation row — no fake campaign is manufactured');
select is(pg_temp.reward_count(pg_temp.id('s_zero')), 0,
  'F5. ...and no reward');
select is(pg_temp.audit_count(pg_temp.id('s_zero_receipt')), 1,
  'F6. ...but IS auditable: one execution record with zero counts');
select is((pg_temp.audit_row(pg_temp.id('s_zero_receipt'))).metadata ->> 'zero_candidate', 'true',
  'F7. ...flagged as a zero-candidate execution');
select is((pg_temp.audit_row(pg_temp.id('s_zero_receipt'))).metadata ->> 'evaluation_count', '0',
  'F8. ...with an evaluation count of zero');

do $$ begin perform pg_temp.run('zero2', pg_temp.id('s_zero')); end; $$;

select is(pg_temp.res('zero2') -> 'error', null::jsonb,
  'F9. a zero-candidate REPLAY is safe');
select is(pg_temp.eval_count(pg_temp.id('s_zero')), 0,
  'F10. ...and still creates no evidence of any kind');


-- ============================================================================
-- SECTION G — AUDIT
-- ============================================================================
select pg_temp.act_as(pg_temp.id('rev'));

select is(pg_temp.audit_count(pg_temp.id('s_main_receipt')), 1,
  'G1. a first successful execution writes EXACTLY ONE audit row');
select is((pg_temp.audit_row(pg_temp.id('s_main_receipt'))).action,
  'CAMPAIGN_EVALUATION_EXECUTED', 'G2. ...with the expected action');
select is((pg_temp.audit_row(pg_temp.id('s_main_receipt'))).entity_type,
  'RECEIPT_SUBMISSION',
  'G3. ...targeting the receipt, matching every other Claim Review audit entry');
select is((pg_temp.audit_row(pg_temp.id('s_main_receipt'))).entity_id,
  pg_temp.id('s_main_receipt')::text, 'G4. ...by receipt id');
select is((pg_temp.audit_row(pg_temp.id('s_main_receipt'))).actor_profile_id,
  pg_temp.id('rev'), 'G5. the ACTOR is the reviewer who asked');
select is((pg_temp.audit_row(pg_temp.id('s_main_receipt'))).organization_id,
  pg_temp.id('vendor'), 'G6. the ORGANIZATION CONTEXT is the reviewer''s Vendor');
select is((pg_temp.audit_row(pg_temp.id('s_main_receipt'))).metadata ->> 'verified_sale_id',
  pg_temp.id('s_main')::text, 'G7. the metadata names the verified sale');
select is((pg_temp.audit_row(pg_temp.id('s_main_receipt'))).metadata ->> 'evaluation_count',
  '6', 'G8. ...the evaluation count');
select is((pg_temp.audit_row(pg_temp.id('s_main_receipt'))).metadata ->> 'qualified_count',
  '4', 'G9. ...the qualified-campaign count');
select is((pg_temp.audit_row(pg_temp.id('s_main_receipt'))).metadata ->> 'reward_count',
  '3', 'G10. ...and the reward count, which is one fewer because the target bonus '
  'qualified without crossing');

-- No Migration 66 or 67 helper may write audit.
select is((select coalesce(string_agg(p.proname, ',' order by p.proname), 'NONE')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosrc ~* 'audit_logs'
             and p.proname in ('campaign_versions_matching_sale','campaign_sale_item_eligible_at',
                               'campaign_matching_result_for_sale',
                               'campaign_matching_qualified_items_for_sale',
                               'campaign_reward_calculation_for_evaluation',
                               'campaign_apply_reward_for_evaluation',
                               'campaign_execute_evaluation_for_verified_sale')), 'NONE',
  'G11. NO Migration 66, 67 or private-evaluator helper writes an audit entry');

select ok(pg_temp.body('evaluate_verified_sale_campaigns') ~ 'insert into public\.audit_logs',
  'G12. the browser RPC is the one place an audit entry is written');


-- ============================================================================
-- SECTION H — THE READ CONTRACT
-- ============================================================================
select pg_temp.act_as(pg_temp.id('rev'));

select is((select jsonb_array_length(pg_temp.reader(pg_temp.id('s_main')))), 6,
  'H1. the authorized reviewer reads every stored campaign result');

select is((select r.outcome from public.get_verified_sale_campaign_results(pg_temp.id('s_main')) r
           where r.campaign_version_id = pg_temp.id('cv_snap')), 'QUALIFIED',
  'H2. the response includes the result');
select is((select r.non_qualification_reason from public.get_verified_sale_campaign_results(pg_temp.id('s_main')) r
           where r.campaign_version_id = pg_temp.id('cv_lose')), 'SUPPRESSED_BY_EXCLUSIVITY',
  'H3. ...and the reason');
select is((select r.qualifying_item_count || '/' || r.qualifying_units
           from public.get_verified_sale_campaign_results(pg_temp.id('s_main')) r
           where r.campaign_version_id = pg_temp.id('cv_live')), '2/5',
  'H4. ...and the counts and units');
select is((select r.campaign_name from public.get_verified_sale_campaign_results(pg_temp.id('s_main')) r
           where r.campaign_version_id = pg_temp.id('cv_live')), 'CE Live',
  'H5. ...and the campaign name a screen must show instead of a uuid');
select is((select r.rule_type || '/' || r.coins_uncapped || '/' || r.reward_coins
           from public.get_verified_sale_campaign_results(pg_temp.id('s_main')) r
           where r.campaign_version_id = pg_temp.id('cv_live')), 'PER_UNIT_COINS/35/35',
  'H6. ...and the reward rule, uncapped amount and final coins');
select is((select r.threshold_units from public.get_verified_sale_campaign_results(pg_temp.id('s_main')) r
           where r.campaign_version_id = pg_temp.id('cv_target')), null,
  'H7. ...and a NULL reward block where a qualified campaign crossed no threshold');

select is((select jsonb_array_length(pg_temp.reader_items(pg_temp.id('s_main')))), 7,
  'H8. the item read returns every stored qualifying item');
select is((select i.product_code_at_proposal || '/' || i.qualifying_units
           from public.get_verified_sale_campaign_qualifying_items(pg_temp.id('s_main')) i
           where i.campaign_version_id = pg_temp.id('cv_snap')), 'CE-1/2',
  'H9. ...with the product identity frozen at proposal time and its units');
select is((select coalesce(i.product_status_at_sale, 'NULL')
           from public.get_verified_sale_campaign_qualifying_items(pg_temp.id('s_main')) i
           where i.campaign_version_id = pg_temp.id('cv_snap')), 'NULL',
  'H10. ...preserving the SNAPSHOT null temporal statuses');

select is(pg_temp.reader_order(pg_temp.id('s_main')),
  (select array_agg(e.campaign_version_id order by e.priority desc, e.campaign_starts_at asc,
                    e.campaign_version_id asc)
   from public.campaign_sale_evaluations e where e.verified_sale_id = pg_temp.id('s_main')),
  'H11. the read is ordered deterministically by priority, start and version id');

select is(pg_temp.reader(pg_temp.id('s_main')), pg_temp.reader(pg_temp.id('s_main')),
  'H12. ...and two calls agree exactly');

-- TENANT ISOLATION on the reads.
select pg_temp.act_as(pg_temp.id('rev_b'));
select is((select jsonb_array_length(pg_temp.reader(pg_temp.id('s_main')))), 0,
  'H13. a Claim Reviewer of ANOTHER Vendor reads ZERO rows');
select is((select jsonb_array_length(pg_temp.reader_items(pg_temp.id('s_main')))), 0,
  'H14. ...and zero item rows');

select pg_temp.act_as(pg_temp.id('staff'));
select is((select jsonb_array_length(pg_temp.reader(pg_temp.id('s_main')))), 0,
  'H15. Sales Staff — the beneficiary — reads nothing through this contract');

select pg_temp.act_as(pg_temp.id('vsa'));
select is((select jsonb_array_length(pg_temp.reader(pg_temp.id('s_main')))), 0,
  'H16. the Vendor Super Admin reads nothing either: this is the reviewer''s surface');

select pg_temp.sign_out();
select is((select jsonb_array_length(pg_temp.reader(pg_temp.id('s_main')))), 0,
  'H17. an anonymous caller reads nothing, and the read RAISES nothing');

-- The reads expose no accumulator.
select ok(pg_temp.body('get_verified_sale_campaign_results') !~ 'campaign_subject_accumulators'
      and pg_temp.body('get_verified_sale_campaign_qualifying_items') !~ 'campaign_subject_accumulators',
  'H18. neither read exposes an accumulator row — it is a cache, never proof of payment');


-- ============================================================================
-- SECTION I — BOUNDARIES
-- ============================================================================
select pg_temp.act_as(pg_temp.id('rev'));

select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_versions_matching_sale'),
  '4e20cce64647395974fa8da490c55c20', 'I1. Unit 66A''s body is byte-for-byte unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'),
  'bcaf88024d3cc06dbae6dc46670a2906', 'I2. Unit 66B''s body is byte-for-byte unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_matching_result_for_sale'),
  '0b0c06bfcd2576451036debe6401b133', 'I3. Unit 66C''s resolver is unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_matching_qualified_items_for_sale'),
  '8f0bb7195e2a6716755ebd7967069966', 'I4. Unit 66C''s item helper is unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_reward_calculation_for_evaluation'),
  '20d20ffb775aca756fcf71c293a352b6', 'I5. Migration 67''s calculation is unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_apply_reward_for_evaluation'),
  '5ffe5cac1709110d64fb75f69d8400f9', 'I6. Migration 67''s applier is unchanged');

select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname like 'campaign_sale_%' or p.proname like 'campaign_reward%')
             and p.prorettype = 'trigger'::regtype), 11,
  'I7. Migration 65''s eleven trigger functions are still exactly eleven');

-- No reward reversal, correction or replacement flow anywhere.
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname like '%revers%' or p.proname like '%correct%'
                  or p.proname like '%supersed%' or p.proname like '%replace_evaluation%')), 0,
  'I8. no reversal, correction, supersession or replacement function exists');

select ok(pg_temp.body('campaign_execute_evaluation_for_verified_sale')
            !~ '\mdelete\s+from\M|\mupdate\s+public\.campaign_',
  'I9. the evaluator never deletes or updates stored evidence — there is no '
  'delete-and-recreate path');

select is((select count(*)::integer from information_schema.columns
           where table_schema = 'public' and table_name = 'campaign_rewards'
             and (column_name like '%posted%' or column_name like '%ledger%'
                  or column_name like '%reversed%')), 0,
  'I10. campaign_rewards gained no posting, ledger or reversal column');

select ok(true,
  'I11. NOTE: no Web or Flutter surface is touched — Migration 68 adds SQL only, and the '
  'RPC is the contract a future screen will call');
select ok(true,
  'I12. NOTE: this suite writes only to the local test transaction, which pgTAP rolls '
  'back; no hosted database is contacted');
select ok(true,
  'I13. NOTE: a genuine two-session race is NOT proven here — pgTAP is single-'
  'transaction. What is proven is that the sale row is locked, that exactly one row is '
  'locked, and that both gates are re-checked after it');

select pg_temp.sign_out();

select * from finish();
rollback;
