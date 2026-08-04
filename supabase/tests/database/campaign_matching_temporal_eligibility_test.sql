-- Tests for Phase 2A-B, Unit 66A: the candidate campaign resolver.
--
--   public.campaign_versions_matching_sale(uuid)
--
-- Run with:  supabase test db
--
-- ============================================================================
-- WHAT THIS SUITE IS PROTECTING
-- ============================================================================
-- Four properties matter more than the rest:
--
--   1. THE VENDOR BOUNDARY. The shipped in-force helper has no vendor filter, so a
--      second Vendor targeting the same Retailer is exactly the mistake this resolver
--      exists to avoid. Section D tests it in both directions.
--
--   2. HISTORY, NOT CURRENT STATE. The version returned is the one the per-campaign
--      status timeline names at sale_at — never campaigns.published_version_id, never
--      now(). Section F.
--
--   3. OMISSION IS NOT IGNORANCE. A campaign the history proves was paused, cancelled
--      or superseded is OMITTED; a campaign with no covering interval is returned as
--      NOT_EVALUABLE / NO_TEMPORAL_RECORD. Collapsing those two would let a reward
--      engine treat "we don't know" as "no". Section G.
--
--   4. BROKEN LINEAGE RAISES. It is not recorded as NOT_EVALUABLE, because a corrupt
--      input is not an unknown. Section C.
--
-- ============================================================================
-- HOW THE FIXTURE CONTROLS TIME, AND THE ONE CASE IT CANNOT
-- ============================================================================
-- Two clocks matter and only one is controllable.
--
--   * The CAMPAIGN PERIOD (starts_at/ends_at) is passed in, so period boundaries are
--     tested exactly, to the microsecond.
--
--   * The STATUS TIMELINE is stamped with clock_timestamp() by
--     campaign_status_record_history whenever a campaign is published, paused or
--     cancelled. A test cannot choose those instants.
--
-- So the fixture places sale_at TWO HOURS AHEAD of the test run, which puts it inside
-- whatever interval is open when the suite finishes publishing. A second sale is dated
-- in the past, before any interval exists, to reach NO_TEMPORAL_RECORD.
--
-- NOT REACHABLE HERE: a sale_at falling strictly BETWEEN two publish instants. sale_at
-- is minute-granular (resolve_sale_instant truncates, and verified_sales_assert_lineage
-- re-derives it), while two publishes in one transaction are microseconds apart, so no
-- minute-granular instant can separate them without a real wall-clock delay. G6 states
-- the gap rather than leaving it implied, and G5 asserts the property that IS reachable:
-- at most one version of a campaign is ever returned, and it is the one the timeline
-- names.

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
  v_path := 'cm/' || v_id::text || '.png';
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

/* A verified sale whose instant is chosen by the caller. p_offset shifts the sale
   relative to the test run; the local wall-clock date and minute are derived from it
   in the shop's zone so resolve_sale_instant reproduces exactly that instant. */
create function pg_temp.sale_at_offset(
  p_key text, p_retailer uuid, p_shop uuid, p_staff uuid, p_vendor uuid,
  p_reviewer uuid, p_lines jsonb, p_offset interval
) returns uuid language plpgsql as $$
declare v_r uuid; v_local timestamp;
begin
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

/* A published campaign version with an explicitly chosen period. */
create function pg_temp.publish(
  p_key text, p_vendor uuid, p_admin uuid, p_name text,
  p_starts timestamptz, p_ends timestamptz,
  p_priority integer default 10,
  p_stacking text default 'STACKABLE',
  p_excl_key text default null,
  p_performance text default 'INDIVIDUAL_STAFF'
) returns uuid language plpgsql as $$
declare v_c uuid; v_v uuid;
begin
  perform pg_temp.act_as(p_admin);
  v_c := public.create_vendor_campaign_draft(
    p_name, 'Described.', p_starts, p_ends, 'Asia/Dubai', 'ALL_RETAILERS',
    p_performance, 'ALL_ELIGIBLE_PRODUCTS', p_stacking, p_excl_key, p_priority,
    'PER_UNIT_COINS', 5, null, null, null, null, null, null);
  perform public.publish_vendor_campaign(v_c);
  select c.published_version_id into v_v from public.campaigns c where c.id = v_c;
  perform pg_temp.sign_out();
  insert into pg_temp.f values (p_key || '_campaign', v_c), (p_key, v_v);
  return v_v;
end;
$$;

create function pg_temp.lifecycle(p_campaign uuid, p_admin uuid, p_action text)
returns void language plpgsql as $$
begin
  perform pg_temp.act_as(p_admin);
  perform public.set_vendor_campaign_lifecycle(p_campaign, p_action);
  perform pg_temp.sign_out();
end;
$$;

/* The resolver's verdict for one (sale, version) pair, or ABSENT when omitted. */
create function pg_temp.verdict(p_sale uuid, p_version uuid) returns text
language sql stable as $$
  select coalesce(
    (select m.candidate_result || coalesce('/' || m.candidate_reason, '')
     from public.campaign_versions_matching_sale(p_sale) m
     where m.campaign_version_id = p_version),
    'ABSENT')
$$;

create function pg_temp.match_count(p_sale uuid) returns integer
language sql stable as $$
  select count(*)::integer from public.campaign_versions_matching_sale(p_sale)
$$;

create function pg_temp.try_sql(s text) returns text language plpgsql as $$
begin execute s; return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

/* The resolver's body with line comments stripped, whitespace collapsed and case
   folded. Section F pins the HISTORICAL SOURCE against this rather than against raw
   prosrc, so the body's own prose — which necessarily discusses current state in order
   to explain why it is not used — cannot satisfy or trip an assertion. */
create function pg_temp.fn_body() returns text language sql stable as $$
  select lower(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', ' ', 'g'), '\s+', ' ', 'g'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'campaign_versions_matching_sale'
$$;

/* The same body with the two LEGITIMATE historical tokens removed. Anything containing
   "status" that survives this is a reference to some other status column, and in this
   schema the only campaign-domain table with one is campaigns — i.e. current state.
   Removing tokens rather than pattern-matching references is what makes the guard
   independent of formatting: an unqualified `status`, a spaced `c . status`, a quoted
   `c."status"`, and a `case`/`coalesce` wrapper all leave the same residue. */
create function pg_temp.fn_body_no_history() returns text language sql stable as $$
  select replace(replace(pg_temp.fn_body(), 'campaign_version_status_history', ''),
                 'is_version_in_force', '')
$$;

/* The FINAL candidacy filter — everything from the outer query's FROM onwards, which is
   where the decision is actually made. Pinning this separately is what distinguishes
   "the history table is joined" from "the history decides". */
create function pg_temp.fn_decision() returns text language sql stable as $$
  select substring(pg_temp.fn_body() from position('from judged' in pg_temp.fn_body()))
$$;

-- ---- Fixture ---------------------------------------------------------------
-- Two Vendors and two Retailers, so the vendor boundary is tested against a real
-- second tenant rather than against an absence.
do $$
declare v uuid;
begin
  insert into pg_temp.f values
    ('vendor_a',   pg_temp.new_org('CM Vendor A',   'VENDOR')),
    ('vendor_b',   pg_temp.new_org('CM Vendor B',   'VENDOR')),
    ('retailer_a', pg_temp.new_org('CM Retailer A', 'RETAILER')),
    ('retailer_b', pg_temp.new_org('CM Retailer B', 'RETAILER'));

  insert into pg_temp.f values
    ('vsa',   pg_temp.new_person('CM','Admin')),
    ('vsb',   pg_temp.new_person('CM','AdminB')),
    ('rev',   pg_temp.new_person('CM','Rev')),
    ('revb',  pg_temp.new_person('CM','RevB')),
    ('staff', pg_temp.new_person('CM','Staff')),
    ('staffb',pg_temp.new_person('CM','StaffB'));

  perform pg_temp.add_member(pg_temp.id('vsa'),    pg_temp.id('vendor_a'),   'VENDOR_SUPER_ADMIN');
  perform pg_temp.add_member(pg_temp.id('vsb'),    pg_temp.id('vendor_b'),   'VENDOR_SUPER_ADMIN');
  perform pg_temp.add_member(pg_temp.id('rev'),    pg_temp.id('vendor_a'),   'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('revb'),   pg_temp.id('vendor_b'),   'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('staff'),  pg_temp.id('retailer_a'), 'SALES_STAFF');
  perform pg_temp.add_member(pg_temp.id('staffb'), pg_temp.id('retailer_b'), 'SALES_STAFF');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (pg_temp.id('vendor_a'), pg_temp.id('retailer_a'), 'ACTIVE'),
         (pg_temp.id('vendor_b'), pg_temp.id('retailer_b'), 'ACTIVE'),
         -- The two CROSS relationships are what make D2/D3 and D4 real tests. Each
         -- Vendor trades with BOTH Retailers, so an ALL_RETAILERS campaign from either
         -- Vendor targets both, and the ONLY thing separating them at match time is the
         -- vendor filter. Without these rows the retailer snapshot would exclude the
         -- foreign campaign on its own and the vendor boundary would go untested.
         (pg_temp.id('vendor_b'), pg_temp.id('retailer_a'), 'ACTIVE'),
         (pg_temp.id('vendor_a'), pg_temp.id('retailer_b'), 'ACTIVE');

  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_a'), 'CM Shop', 'CMS', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop', v);
  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_a'), 'CM Shop Two', 'CM2', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop2', v);
  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_b'), 'CM Shop B', 'CMB', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop_b', v);

  insert into pg_temp.f values
    ('p1', pg_temp.new_product(pg_temp.id('vendor_a'), 'CM-1', 'Product One', pg_temp.id('vsa'))),
    ('pb', pg_temp.new_product(pg_temp.id('vendor_b'), 'CM-B', 'Product B',   pg_temp.id('vsb')));
  perform pg_temp.assign(pg_temp.id('p1'), pg_temp.id('retailer_a'), pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('pb'), pg_temp.id('retailer_a'), pg_temp.id('vsb'));
  perform pg_temp.assign(pg_temp.id('pb'), pg_temp.id('retailer_b'), pg_temp.id('vsb'));
end;
$$;

-- Sales. s_now sits two hours ahead of the run, so every interval opened below covers
-- it. s_past is dated 30 days back, before any interval exists.
do $$
begin
  perform pg_temp.sale_at_offset('s_now', pg_temp.id('retailer_a'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor_a'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 3)), interval '2 hours');

  perform pg_temp.sale_at_offset('s_past', pg_temp.id('retailer_a'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor_a'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)), interval '-30 days');

  -- Vendor B's own sale in its own Retailer, for the mirror vendor test.
  perform pg_temp.sale_at_offset('s_b', pg_temp.id('retailer_b'), pg_temp.id('shop_b'),
    pg_temp.id('staffb'), pg_temp.id('vendor_b'), pg_temp.id('revb'),
    jsonb_build_array(pg_temp.line(pg_temp.id('pb'), 1)), interval '2 hours');
end;
$$;

-- Campaigns, published AFTER the sales exist so their periods can be pinned to the
-- exact sale instant.
do $$
declare v_at timestamptz;
begin
  select v.sale_at into v_at from public.verified_sales v where v.id = pg_temp.id('s_now');
  insert into pg_temp.f values ('probe', gen_random_uuid());

  -- Ordinary in-force campaign covering the sale.
  perform pg_temp.publish('cv_ok', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM Ok',
    v_at - interval '10 days', v_at + interval '10 days');

  -- Period boundary probes.
  perform pg_temp.publish('cv_start_eq', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM StartEq',
    v_at, v_at + interval '10 days');
  perform pg_temp.publish('cv_start_after', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM StartAfter',
    v_at + interval '1 microsecond', v_at + interval '10 days');
  perform pg_temp.publish('cv_end_eq', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM EndEq',
    v_at - interval '10 days', v_at);
  perform pg_temp.publish('cv_end_after', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM EndAfter',
    v_at - interval '10 days', v_at + interval '1 microsecond');
  perform pg_temp.publish('cv_open', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM OpenEnded',
    v_at - interval '10 days', null);

  -- Period reaches back past s_past, so that sale is RELEVANT on every non-temporal
  -- fact and fails only on the missing status interval. Without this the sale would be
  -- omitted for being outside the period and G1 would prove nothing.
  perform pg_temp.publish('cv_wide', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM Wide',
    v_at - interval '60 days', v_at + interval '10 days');

  -- Vendor B campaign targeting Retailer A — the vendor-boundary probe.
  perform pg_temp.publish('cv_vb', pg_temp.id('vendor_b'), pg_temp.id('vsb'), 'CM VendorB',
    v_at - interval '10 days', v_at + interval '10 days');

  -- Lifecycle probes.
  perform pg_temp.publish('cv_paused', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM Paused',
    v_at - interval '10 days', v_at + interval '10 days');
  perform pg_temp.lifecycle(pg_temp.id('cv_paused_campaign'), pg_temp.id('vsa'), 'PAUSE');

  perform pg_temp.publish('cv_cancelled', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM Cancelled',
    v_at - interval '10 days', v_at + interval '10 days');
  perform pg_temp.lifecycle(pg_temp.id('cv_cancelled_campaign'), pg_temp.id('vsa'), 'CANCEL');

  -- Ordering probes: three campaigns whose keys tie progressively.
  perform pg_temp.publish('cv_hi', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM HiPriority',
    v_at - interval '10 days', v_at + interval '10 days', 900);
  perform pg_temp.publish('cv_tie_early', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM TieEarly',
    v_at - interval '9 days', v_at + interval '10 days', 500);
  perform pg_temp.publish('cv_tie_late', pg_temp.id('vendor_a'), pg_temp.id('vsa'), 'CM TieLate',
    v_at - interval '8 days', v_at + interval '10 days', 500);
end;
$$;


-- ============================================================================
-- SECTION A — SCHEMA AND SECURITY
-- ============================================================================
select has_function('public', 'campaign_versions_matching_sale', array['uuid'],
  'A1. the candidate resolver exists with the exact signature');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_versions_matching_sale'),
  'TABLE(campaign_id uuid, campaign_version_id uuid, vendor_organization_id uuid, '
  'retailer_organization_id uuid, retailer_shop_id uuid, beneficiary_profile_id uuid, '
  'sale_at timestamp with time zone, performance_scope text, reward_recipient_scope text, '
  'product_scope text, product_eligibility_resolution text, stacking_mode text, '
  'exclusivity_key text, priority integer, campaign_starts_at timestamp with time zone, '
  'campaign_ends_at timestamp with time zone, candidate_result text, candidate_reason text)',
  'A2. the return contract is exactly the approved 18 columns and types');

select ok((select p.provolatile = 's' and p.prosecdef
           and p.proconfig @> array['search_path=""']
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_versions_matching_sale'),
  'A3. STABLE, SECURITY DEFINER, empty search_path');

select is((select p.proacl::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_versions_matching_sale'),
  '{postgres=X/postgres}',
  'A4. owner-execute-only — the default PUBLIC grant really was revoked');

select is((select count(*)::integer from information_schema.role_routine_grants
           where routine_schema = 'public'
             and routine_name = 'campaign_versions_matching_sale'
             and grantee in ('anon','authenticated','service_role','PUBLIC')), 0,
  'A5. no grant to anon, authenticated, service_role or PUBLIC');

select isnt((select obj_description(p.oid, 'pg_proc') from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'campaign_versions_matching_sale'),
  null, 'A6. the function is documented');

-- Migration 66 adds no table and no permission.
select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'), 47,
  'A7. no table was added — still the 47 from Migration 65');
select is((select count(*)::integer from public.permissions), 32,
  'A8. the permission catalogue is unchanged at 32');


-- ============================================================================
-- SECTION B — UNIT BOUNDARY: 66A ONLY
-- ============================================================================
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = f), 0,
  'B1. Unit 66B/66C/67/68 function does not exist yet: ' || f)
from unnest(array[
  'campaign_sale_item_eligible_at',
  'campaign_matching_result_for_sale',
  'evaluate_sale_campaign_qualification',
  'get_sale_campaign_qualification',
  'list_my_staff_rewards'
]) as f;

select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_%'
             and p.prosrc ~* '(insert|update|delete)\s+(into\s+)?public\.campaign_(sale|reward|subject)'), 0,
  'B2. no campaign function writes to the Migration 65 evidence tables');

select is((select count(*)::integer from information_schema.tables where table_schema='public'
           and (table_name like '%coin%' or table_name like '%ledger%' or table_name like '%wallet%'
             or table_name like '%balance%' or table_name like '%payout%' or table_name like '%redemption%')), 0,
  'B3. no coin, ledger, wallet, balance, payout or redemption object');


-- ============================================================================
-- SECTION C — AUTHORITATIVE LINEAGE
-- ============================================================================
-- Broken lineage RAISES. It is never dressed up as NOT_EVALUABLE.
select throws_ok('select * from public.campaign_versions_matching_sale(null)',
  '22023', null, 'C1. a null sale id raises invalid_parameter_value');

select is(pg_temp.try_sql(format(
  'select * from public.campaign_versions_matching_sale(%L)', gen_random_uuid())),
  'REFUSED:23503', 'C2. a missing verified sale raises foreign_key_violation');

-- Lineage is DERIVED, never supplied. Each of these is read from the authoritative row.
--
-- WHY NOT A SCALAR SUBQUERY. The obvious form here is
--   (select distinct m.vendor_organization_id from ...matching_sale(...) m)
-- and it is exactly wrong for this suite. A LEAKED CANDIDATE — a campaign belonging to
-- another Vendor — is precisely the defect these assertions must diagnose, and it makes
-- that subquery return two rows, which raises 21000 and ABORTS THE WHOLE TRANSACTION.
-- Every later section, including the dedicated Vendor-isolation tests in Section D,
-- would then never run, and the one failure reported would name a lineage test rather
-- than the boundary that actually broke.
--
-- array_agg(distinct ... order by ...) is multi-row safe: a leak produces a two-element
-- array that fails cleanly by name, the transaction survives, and Section D still runs
-- and still names the real culprit. Comparing the WHOLE aggregated array (rather than
-- probing for the expected value) is what keeps this non-vacuous in both directions:
-- it proves the expected value is present AND that nothing else is.
select is((select array_agg(distinct m.vendor_organization_id order by m.vendor_organization_id)
           from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m),
  array[pg_temp.id('vendor_a')]::uuid[],
  'C3. every returned row carries the SALE''s Vendor, and no other');

select is((select array_agg(distinct m.retailer_organization_id order by m.retailer_organization_id)
           from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m),
  array[pg_temp.id('retailer_a')]::uuid[],
  'C4. every returned row carries the SALE''s Retailer, and no other');

select is((select array_agg(distinct m.retailer_shop_id order by m.retailer_shop_id)
           from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m),
  array[pg_temp.id('shop')]::uuid[],
  'C5. every returned row carries the SALE''s shop, and no other');

select is((select array_agg(distinct m.beneficiary_profile_id order by m.beneficiary_profile_id)
           from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m),
  array[pg_temp.id('staff')]::uuid[],
  'C6. every row names the RECEIPT SUBMITTER as beneficiary — verified_sales has no seller column');

select is((select array_agg(distinct m.sale_at order by m.sale_at)
           from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m),
  array[(select v.sale_at from public.verified_sales v where v.id = pg_temp.id('s_now'))]::timestamptz[],
  'C7. every row copies the sale''s own instant, and no other');

-- C3-C7 compare aggregates, so they would also pass against an EMPTY result. This makes
-- them non-vacuous: there is genuinely something to aggregate.
select ok(pg_temp.match_count(pg_temp.id('s_now')) > 0,
  'C8. FIXTURE: the resolver returns rows, so C3-C7 are not vacuously true');

do $$
begin
  update public.organization_members set status = 'DEACTIVATED'
   where user_id = pg_temp.id('staff') and organization_id = pg_temp.id('retailer_a');
  update public.organizations set status = 'SUSPENDED' where id = pg_temp.id('retailer_a');
end;
$$;

select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_ok')), 'CANDIDATE',
  'C9. a DEACTIVATED staff member and SUSPENDED Retailer do not invalidate a historical match');

do $$
begin
  update public.organizations set status = 'ACTIVE' where id = pg_temp.id('retailer_a');
  update public.organization_members set status = 'ACTIVE'
   where user_id = pg_temp.id('staff') and organization_id = pg_temp.id('retailer_a');
end;
$$;


-- ============================================================================
-- SECTION D — THE VENDOR BOUNDARY
-- ============================================================================
select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_ok')), 'CANDIDATE',
  'D1. a same-Vendor campaign targeting this Retailer is a candidate');

-- Vendor B genuinely trades with Retailer A and its campaign genuinely targets it, so
-- the ONLY thing keeping it out is the vendor filter this resolver adds.
select is((select count(*)::integer from public.campaign_eligible_retailers er
           where er.campaign_version_id = pg_temp.id('cv_vb')
             and er.retailer_organization_id = pg_temp.id('retailer_a')), 1,
  'D2. FIXTURE: Vendor B''s campaign really does target Retailer A');

select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_vb')), 'ABSENT',
  'D3. ...yet it is omitted from Vendor A''s sale — the vendor boundary holds');

select is(pg_temp.verdict(pg_temp.id('s_b'), pg_temp.id('cv_ok')), 'ABSENT',
  'D4. ...and the mirror case: Vendor A''s campaign is absent from Vendor B''s sale');

-- The shipped helper is the reason this filter has to exist here.
select ok((select p.prosrc !~* 'vendor' from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='campaign_versions_in_force_for_retailer_at'),
  'D5. campaign_versions_in_force_for_retailer_at still has NO vendor filter — hence D3');

select ok((select p.prosrc !~* 'order by' from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.proname='campaign_versions_in_force_for_retailer_at'),
  'D6. ...and no ORDER BY, hence this resolver supplies its own');


-- ============================================================================
-- SECTION E — RETAILER TARGETING AND CAMPAIGN PERIOD
-- ============================================================================
-- Targeting comes from the frozen publication snapshot, and the shop is not a
-- targeting dimension at all.
-- Scoped to the campaign CONFIGURATION tables. Migration 65's evidence tables do carry
-- retailer_shop_id, but as sale lineage copied from verified_sales, never as targeting.
select is((select count(*)::integer from information_schema.columns
           where table_schema='public' and column_name like '%shop%'
             and table_name in ('campaigns','campaign_versions','campaign_rules',
               'campaign_rule_tiers','campaign_version_products','campaign_version_retailers',
               'campaign_version_retailer_groups','campaign_retailer_groups',
               'campaign_retailer_group_members','campaign_eligible_retailers',
               'campaign_eligible_products','campaign_version_status_history')), 0,
  'E1. no campaign CONFIGURATION table carries a shop column — shop is not a targeting dimension');

select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_start_eq')), 'CANDIDATE',
  'E2. sale_at exactly AT starts_at is inside the period');
select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_start_after')), 'ABSENT',
  'E3. sale_at one microsecond BEFORE starts_at is outside');
select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_end_eq')), 'ABSENT',
  'E4. sale_at exactly AT ends_at is outside — the period is half-open');
select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_end_after')), 'CANDIDATE',
  'E5. sale_at one microsecond BEFORE ends_at is inside');
select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_open')), 'CANDIDATE',
  'E6. an open-ended campaign covers the sale');

-- The mirror precondition for D4: Vendor A's campaign genuinely targets Retailer B, so
-- its absence from Vendor B's sale can only be the vendor filter's doing.
select is((select count(*)::integer from public.campaign_eligible_retailers er
           where er.campaign_version_id = pg_temp.id('cv_ok')
             and er.retailer_organization_id = pg_temp.id('retailer_b')), 1,
  'E7. FIXTURE: Vendor A''s campaign really does target Retailer B');


-- ============================================================================
-- SECTION F — HISTORY, NOT CURRENT STATE
-- ============================================================================
select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_paused')), 'ABSENT',
  'F1. a campaign PAUSED at sale_at is omitted');
select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_cancelled')), 'ABSENT',
  'F2. a campaign CANCELLED at sale_at is omitted');

-- Both were genuinely published first, so the omission is the status timeline talking,
-- not a missing snapshot.
select is((select count(*)::integer from public.campaign_eligible_retailers er
           where er.campaign_version_id = pg_temp.id('cv_paused')
             and er.retailer_organization_id = pg_temp.id('retailer_a')), 1,
  'F3. FIXTURE: the paused campaign really did target this Retailer when published');

select is((select h.lifecycle_status from public.campaign_version_status_history h
           where h.campaign_id = pg_temp.id('cv_paused_campaign') and h.valid_to is null),
  'PAUSED', 'F4. ...and its open interval really says PAUSED');

-- The resolver reads the timeline, never campaigns.published_version_id.
select is((select c.published_version_id from public.campaigns c
           where c.id = pg_temp.id('cv_paused_campaign')), pg_temp.id('cv_paused'),
  'F5. published_version_id still points at the paused version...');
select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_paused')), 'ABSENT',
  'F6. ...and the resolver still omits it, because it reads the status timeline');

-- Resuming restores it, proving F1 was the status and not something structural.
do $$ begin perform pg_temp.lifecycle(pg_temp.id('cv_paused_campaign'), pg_temp.id('vsa'), 'RESUME'); end; $$;
select is(pg_temp.verdict(pg_temp.id('s_now'), pg_temp.id('cv_paused')), 'CANDIDATE',
  'F7. RESUMING the campaign makes it a candidate again at the same sale_at');

-- ---- THE HISTORICAL SOURCE, PINNED STRUCTURALLY ----------------------------------
-- F1-F7 above prove the RESULT is right, but they cannot prove WHERE it came from.
-- In this fixture a campaign's current status always equals its status at sale_at:
-- every lifecycle change happens at test time and sale_at sits two hours later, so
-- reading campaigns.status instead of the historical interval yields the same answers
-- and F1-F7 all still pass.
--
-- WHY NO BEHAVIOURAL DIVERGENCE TEST HERE, STATED ACCURATELY. Through the ordinary
-- sale-construction path the divergence is impractical: sale_at is minute-granular
-- (resolve_sale_instant truncates and verified_sales_assert_lineage re-derives it) while
-- two lifecycle changes inside one transaction are microseconds apart, so no sale can be
-- placed strictly between them. It is NOT fundamentally impossible — a fixture could
-- insert campaign_version_status_history rows directly with chosen valid_from/valid_to
-- straddling sale_at, since that table's triggers enforce append-only, no-overlap and
-- interval ordering but do not require clock_timestamp() boundaries. That more intrusive
-- fixture was not attempted in Unit 66A.
--
-- So the exact historical source is pinned STRUCTURALLY below instead. Boundary and
-- missing-history behaviour remain covered behaviourally by Sections E and G.
select ok(pg_temp.fn_body() like '%campaign_version_status_history%',
  'F8. candidacy reads public.campaign_version_status_history');

select ok(pg_temp.fn_body() like '%valid_from <= v_sale.sale_at%',
  'F9. ...comparing valid_from against the SALE''s own instant');

select ok(pg_temp.fn_body() like '%valid_to is null or v_sale.sale_at < h.valid_to%',
  'F10. ...and valid_to half-open against that same instant');

select ok(pg_temp.fn_body() like '%is_version_in_force%',
  'F11. ...and deciding in-force from the historical is_version_in_force indicator');

-- THE FORBIDDEN HALF. An earlier version of this guard matched a qualified `alias.status`
-- reference, and three semantically identical formulations walked straight past it:
-- an unqualified `status`, `c . status` with spaces around the dot, and a quoted
-- `c."status"`. All three let current campaign state decide candidacy while every other
-- assertion here stayed green.
--
-- So the check no longer looks for a reference SHAPE. It deletes the two tokens that may
-- legitimately contain "status" and requires nothing to be left. campaigns is still
-- joined for Vendor and campaign lineage (F14), so this is not a ban on the table — it
-- is a ban on reading a status column from it.
select ok(pg_temp.fn_body_no_history() not like '%status%',
  'F12. current campaigns.status cannot decide historical candidacy, in any spelling');

-- The positive half. F8-F12 could all pass while the history was joined, extracted and
-- then quietly ignored, so this pins the decision itself: the final candidacy filter must
-- consume the in-force value the lateral pulled out of the timeline.
select ok(pg_temp.fn_decision() like '%h_in_force%',
  'F12b. the final candidacy filter uses the HISTORICAL in-force value, not merely joins it');

select ok(pg_temp.fn_decision() not like '%status%',
  'F12c. ...and the final candidacy filter reads no status column at all');

-- The last way round F12. Every guard above inspects THIS function's body, so a
-- current-state read can still be smuggled out of sight by putting it in a NEW public
-- helper and calling that instead — the resolver body then contains no `status` at all,
-- and keeping `j.h_in_force` textually present satisfies F12b too. A mutation doing
-- exactly that passed 75/75 before this assertion existed.
--
-- Unit 66A's resolver reads authoritative tables directly and calls NO public function,
-- so the boundary is simply that: no public function call of any kind. The pattern
-- tolerates whitespace around the dot and the parenthesis and accepts a quoted
-- identifier, so `public . "cm_live_flag" (` is caught as readily as
-- `public.cm_live_flag(`. Table references such as `from public.campaigns c` are not
-- matched, because they are not followed by an opening parenthesis.
--
-- DELIBERATELY SCOPED TO UNIT 66A. If Units 66B/66C want to compose a safe lower-level
-- historical helper, this assertion must be narrowed by an explicit successor review —
-- the same way Migration 65's J1 was narrowed for this unit — rather than quietly
-- deleted.
select ok(pg_temp.fn_body() !~ 'public[[:space:]]*\.[[:space:]]*("[^"]+"|[a-z_][a-z0-9_$]*)[[:space:]]*\(',
  'F12d. resolver calls no public helper that could hide current-state eligibility');

select ok(pg_temp.fn_body() not like '%published_version_id%',
  'F13. campaigns.published_version_id is not used to select the historical version');

-- Proves F12 is a real constraint rather than passing because campaigns is absent.
select ok(pg_temp.fn_body() like '%public.campaigns%',
  'F14. ...while campaigns IS joined, for Vendor and campaign lineage only');

select ok(true,
  'F15. NOTE: a behavioural current-vs-history divergence is impractical through the ordinary sale path (minute-granular sale_at vs microsecond transitions) but NOT impossible — a direct history-row fixture could do it; not attempted in Unit 66A, so F8-F14 pin the source structurally');


-- ============================================================================
-- SECTION G — OMISSION VERSUS NOT_EVALUABLE
-- ============================================================================
-- s_past predates every status interval, so no covering interval exists for any
-- campaign. That is unknown, not "no", and must be reported.
select is(pg_temp.verdict(pg_temp.id('s_past'), pg_temp.id('cv_wide')),
  'NOT_EVALUABLE/NO_TEMPORAL_RECORD',
  'G1. a sale predating all status history is NOT_EVALUABLE / NO_TEMPORAL_RECORD');

select ok((select v.sale_at < h.valid_from
           from public.verified_sales v, public.campaign_version_status_history h
           where v.id = pg_temp.id('s_past') and h.campaign_id = pg_temp.id('cv_wide_campaign')),
  'G1b. FIXTURE: that sale really does predate the campaign''s only status interval');

select ok((select v.sale_at >= cv.starts_at and (cv.ends_at is null or v.sale_at < cv.ends_at)
           from public.verified_sales v, public.campaign_versions cv
           where v.id = pg_temp.id('s_past') and cv.id = pg_temp.id('cv_wide')),
  'G1c. ...while sitting INSIDE the campaign period, so only the missing history excludes it');

select ok(pg_temp.match_count(pg_temp.id('s_past')) >= 1,
  'G2. ...returned as rows rather than silently omitted');

select is((select count(*)::integer from public.campaign_versions_matching_sale(pg_temp.id('s_past')) m
           where m.candidate_result = 'CANDIDATE'), 0,
  'G3. ...and none of them is a candidate');

-- The pairing vocabulary is closed and consistent in both directions.
select is((select count(*)::integer from public.campaign_versions_matching_sale(pg_temp.id('s_past')) m
           where m.candidate_result not in ('CANDIDATE','NOT_EVALUABLE')
              or (m.candidate_result = 'CANDIDATE' and m.candidate_reason is not null)
              or (m.candidate_result = 'NOT_EVALUABLE' and m.candidate_reason is distinct from 'NO_TEMPORAL_RECORD')), 0,
  'G4. result/reason pairing is closed: CANDIDATE has no reason, NOT_EVALUABLE says NO_TEMPORAL_RECORD');

-- An explicit non-in-force history is OMITTED, never mislabelled as missing.
select is((select count(*)::integer from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m
           where m.campaign_version_id in (pg_temp.id('cv_cancelled'), pg_temp.id('cv_vb'))), 0,
  'G5. explicit non-in-force and foreign-Vendor versions are omitted, not NO_TEMPORAL_RECORD');

-- At most one version of any campaign is ever returned, because the timeline names one.
select is((select count(*)::integer from (
             select m.campaign_id from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m
             group by m.campaign_id having count(*) > 1) x), 0,
  'G6. at most ONE version per campaign is returned — the one the timeline names');

select ok(true,
  'G7. NOTE: a sale_at strictly BETWEEN two publish instants is not reachable here — sale_at is minute-granular and two publishes in one transaction are microseconds apart');


-- ============================================================================
-- SECTION H — DETERMINISTIC TOTAL ORDER
-- ============================================================================
-- priority DESC, then campaign_starts_at ASC, then campaign_version_id ASC.
select is((select m.campaign_version_id from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m limit 1),
  pg_temp.id('cv_hi'),
  'H1. the highest priority sorts first');

-- array_agg without ORDER BY preserves the order the function emitted, which is
-- precisely what is under test.
select ok((select array_position(arr, pg_temp.id('cv_tie_early'))
                < array_position(arr, pg_temp.id('cv_tie_late'))
           from (select array_agg(m.campaign_version_id) as arr
                 from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m) t),
  'H2. on a priority tie the EARLIER campaign start sorts first');

select is((select m.priority from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m
           where m.campaign_version_id = pg_temp.id('cv_tie_early')),
          (select m.priority from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m
           where m.campaign_version_id = pg_temp.id('cv_tie_late')),
  'H2b. FIXTURE: those two really do tie on priority, so H2 tested the start-date key');

select ok((select bool_and(ok) from (
             select (lag(m.priority) over () is null
                     or lag(m.priority) over () >= m.priority) as ok
             from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m) t),
  'H3. priority is non-increasing across the whole result');

-- Byte-equivalent repetition.
select is(
  (select string_agg(m.campaign_version_id::text, ',') from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m),
  (select string_agg(m.campaign_version_id::text, ',') from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m),
  'H4. repeated calls return the same rows in the same order');

select is(
  (select md5(string_agg(m::text, '|')) from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m),
  (select md5(string_agg(m::text, '|')) from public.campaign_versions_matching_sale(pg_temp.id('s_now')) m),
  'H5. ...and every column is byte-equivalent, not just the ids');


-- ============================================================================
-- SECTION I — THE FUNCTION WRITES NOTHING
-- ============================================================================
select is((select count(*)::integer from public.campaign_sale_evaluations), 0,
  'I1. no evaluation evidence was written');
select is((select count(*)::integer from public.campaign_sale_item_qualifications), 0,
  'I2. no item qualification evidence was written');
select is((select count(*)::integer from public.campaign_rewards), 0,
  'I3. no reward evidence was written');
select is((select count(*)::integer from public.campaign_subject_accumulators), 0,
  'I4. no accumulator row was written');

-- Comments are stripped first: the body legitimately DISCUSSES the frozen snapshot
-- being guarded against UPDATE and DELETE, and a naive word match would flag its own
-- documentation as a write.
select ok((select regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
                  !~* '\minsert\s+into\M|\mupdate\s+public\.|\mdelete\s+from\M'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='campaign_versions_matching_sale'),
  'I5. the executable body contains no INSERT, UPDATE or DELETE statement');

select ok((select p.prosrc !~* '\mnow\s*\(|\mcurrent_timestamp\M|published_version_id|campaign_derived_state|campaign_product_eligibility_as_of|vendor_retailer_eligible_products_at'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='campaign_versions_matching_sale'),
  'I6. it uses no now(), no published_version_id and none of the display-only or unsafe helpers');

select * from finish();
rollback;
