-- Tests for Phase 2A-B, Migration 66.
--
--   Unit 66A  public.campaign_versions_matching_sale(uuid)          Sections A-I
--   Unit 66B  public.campaign_sale_item_eligible_at(uuid, uuid)     Sections J-P
--   Unit 66C  public.campaign_matching_result_for_sale(uuid)          Sections Q-V
--             public.campaign_matching_qualified_items_for_sale(uuid)
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


-- ---- Unit 66B fixture ------------------------------------------------------
-- Seven products, one sale, and a deliberate injury to each temporal axis. Every
-- product is ACTIVE and ACTIVELY assigned when the sale is created — the sale RPCs
-- refuse otherwise — so each injury below happens strictly AFTER the sale exists. That
-- ordering is the whole point: a resolver that consulted current state would change its
-- answer about a historical sale, and these products are what makes that visible.
--
--   q_snap    healthy. Selected into the SNAPSHOT campaign.
--   q_live    healthy. Not selected, so it is NOT_ELIGIBLE under SNAPSHOT and ELIGIBLE
--             under LIVE_TEMPORAL — the same item, two verdicts, by declared resolution.
--   q_pdead   selected, then DEACTIVATED. Snapshot must not notice; live must.
--   q_adead   selected, then UNASSIGNED. Snapshot must not notice; live must.
--   q_pgap    product timeline closed before the sale; assignment still ACTIVE.
--   q_agap    assignment timeline closed before the sale; product explicitly INACTIVE.
--             This is the case that proves missing history OUTRANKS a definite no.
--   q_both    both timelines closed before the sale.
do $$
declare v_p uuid;
begin
  insert into pg_temp.f values
    ('q_snap',  pg_temp.new_product(pg_temp.id('vendor_a'), 'CM-Q1', 'Q Snap',   pg_temp.id('vsa'))),
    ('q_live',  pg_temp.new_product(pg_temp.id('vendor_a'), 'CM-Q2', 'Q Live',   pg_temp.id('vsa'))),
    ('q_pdead', pg_temp.new_product(pg_temp.id('vendor_a'), 'CM-Q3', 'Q PDead',  pg_temp.id('vsa'))),
    ('q_adead', pg_temp.new_product(pg_temp.id('vendor_a'), 'CM-Q4', 'Q ADead',  pg_temp.id('vsa'))),
    ('q_pgap',  pg_temp.new_product(pg_temp.id('vendor_a'), 'CM-Q5', 'Q PGap',   pg_temp.id('vsa'))),
    ('q_agap',  pg_temp.new_product(pg_temp.id('vendor_a'), 'CM-Q6', 'Q AGap',   pg_temp.id('vsa'))),
    ('q_both',  pg_temp.new_product(pg_temp.id('vendor_a'), 'CM-Q7', 'Q Both',   pg_temp.id('vsa'))),
    -- Vendor A's product, assigned ONLY to Retailer B and never selected into the
    -- SNAPSHOT campaign. See M12-M14: this is the one shape in which "does this version
    -- have frozen rows?" and "what did this version declare?" give different answers.
    ('q_rb',    pg_temp.new_product(pg_temp.id('vendor_a'), 'CM-Q8', 'Q RetailerB', pg_temp.id('vsa')));

  foreach v_p in array array[
    pg_temp.id('q_snap'), pg_temp.id('q_live'), pg_temp.id('q_pdead'), pg_temp.id('q_adead'),
    pg_temp.id('q_pgap'), pg_temp.id('q_agap'), pg_temp.id('q_both')]
  loop
    perform pg_temp.assign(v_p, pg_temp.id('retailer_a'), pg_temp.id('vsa'));
  end loop;

  perform pg_temp.assign(pg_temp.id('q_rb'), pg_temp.id('retailer_b'), pg_temp.id('vsa'));
end;
$$;

-- One sale carrying all seven products, each with a DIFFERENT quantity, so an
-- implementation that returned a constant, the first item's quantity, or the sale's
-- total instead of this item's own quantity cannot pass Section M or N.
do $$
begin
  perform pg_temp.sale_at_offset('s_items', pg_temp.id('retailer_a'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor_a'), pg_temp.id('rev'),
    jsonb_build_array(
      pg_temp.line(pg_temp.id('q_snap'),  3), pg_temp.line(pg_temp.id('q_live'),  4),
      pg_temp.line(pg_temp.id('q_pdead'), 5), pg_temp.line(pg_temp.id('q_adead'), 6),
      pg_temp.line(pg_temp.id('q_pgap'),  7), pg_temp.line(pg_temp.id('q_agap'),  8),
      pg_temp.line(pg_temp.id('q_both'),  9)),
    interval '2 hours');

  -- A sale 30 days back, before ANY of these timelines begin. Under SNAPSHOT it must
  -- still resolve — the frozen set does not depend on a timeline at all.
  perform pg_temp.sale_at_offset('s_items_past', pg_temp.id('retailer_a'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor_a'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('q_snap'), 2)), interval '-30 days');

  -- Vendor A's sale in Retailer B, healthy on every axis. The SNAPSHOT campaign below
  -- targets ALL_RETAILERS, so Retailer B IS an eligible Retailer of that version — it
  -- simply has no frozen product rows, because none of the selected products is assigned
  -- to it. That is the reachable case where inferring the mode from row presence pays a
  -- reward on a product the Vendor never selected.
  perform pg_temp.sale_at_offset('s_rb', pg_temp.id('retailer_b'), pg_temp.id('shop_b'),
    pg_temp.id('staffb'), pg_temp.id('vendor_a'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('q_rb'), 4)), interval '2 hours');
end;
$$;

-- The SNAPSHOT campaign. Published while all three selected products are healthy, which
-- is the only moment publish_vendor_campaign will freeze them.
do $$
declare v_c uuid; v_v uuid;
begin
  perform pg_temp.act_as(pg_temp.id('vsa'));
  v_c := public.create_vendor_campaign_draft(
    'CM Snapshot', 'Described.', now() - interval '1 day', now() + interval '30 days',
    'Asia/Dubai', 'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'SELECTED_PRODUCTS', 'STACKABLE',
    null, 10, 'PER_UNIT_COINS', 5, null, null, null, null, null,
    array[pg_temp.id('q_snap'), pg_temp.id('q_pdead'), pg_temp.id('q_adead')]::uuid[]);
  perform public.publish_vendor_campaign(v_c);
  select c.published_version_id into v_v from public.campaigns c where c.id = v_c;
  perform pg_temp.sign_out();
  insert into pg_temp.f values ('cv_snap_campaign', v_c), ('cv_snap', v_v);
end;
$$;

-- THE INJURIES. All after the sale, all after publication.
do $$
declare v_at timestamptz;
begin
  select v.sale_at into v_at from public.verified_sales v where v.id = pg_temp.id('s_items');

  -- Explicit INACTIVE covering the sale instant: the trigger closes the ACTIVE interval
  -- at clock_timestamp() (now, an hour before the sale) and opens an open-ended INACTIVE
  -- one, so the sale falls inside the INACTIVE interval.
  update public.vendor_products set status = 'INACTIVE'
   where id = pg_temp.id('q_pdead');

  update public.vendor_product_retailer_assignments set status = 'INACTIVE'
   where vendor_product_id = pg_temp.id('q_adead')
     and retailer_organization_id = pg_temp.id('retailer_a');

  -- SILENCE covering the sale instant: close the open interval an hour BEFORE the sale
  -- and open nothing after it, so no interval covers sale_at and the primitive returns
  -- NULL. This is the state a pre-backfill sale is in, constructed deliberately.
  update public.vendor_product_status_history set valid_to = v_at - interval '1 hour'
   where vendor_product_id in (pg_temp.id('q_pgap'), pg_temp.id('q_both'))
     and valid_to is null;

  update public.vendor_product_retailer_assignment_history set valid_to = v_at - interval '1 hour'
   where vendor_product_id in (pg_temp.id('q_agap'), pg_temp.id('q_both'))
     and retailer_organization_id = pg_temp.id('retailer_a')
     and valid_to is null;

  -- q_agap only: the assignment axis is now silent AND the product axis says a definite
  -- INACTIVE. One axis has a confident answer, the other has none.
  update public.vendor_products set status = 'INACTIVE'
   where id = pg_temp.id('q_agap');
end;
$$;

/* One authoritative sale item, by product, from the seven-line sale. */
create function pg_temp.item(p_product uuid) returns uuid language sql stable as $$
  select i.id from public.verified_sale_items i
  where i.verified_sale_id = pg_temp.id('s_items')
    and i.vendor_product_id = p_product
$$;

/* The whole verdict in one string: source | product status | assignment status | units |
   result | reason. Pinning all six together is what stops a correct-looking result from
   shipping with mismatched evidence beside it. */
create function pg_temp.ev(p_version uuid, p_item uuid) returns text language sql stable as $$
  select coalesce(e.product_source, '-') || ' | ' || coalesce(e.product_status_at_sale, '-')
      || ' | ' || coalesce(e.assignment_status_at_sale, '-') || ' | ' || e.qualifying_units::text
      || ' | ' || e.eligibility_result || ' | ' || coalesce(e.eligibility_reason, '-')
  from public.campaign_sale_item_eligible_at(p_version, p_item) e
$$;

/* The single item of the Retailer B sale. */
create function pg_temp.item_rb() returns uuid language sql stable as $$
  select i.id from public.verified_sale_items i where i.verified_sale_id = pg_temp.id('s_rb')
$$;

/* Unit 66B's body, normalized the same way Section F normalizes 66A's. */
create function pg_temp.b_body() returns text language sql stable as $$
  select lower(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', ' ', 'g'), '\s+', ' ', 'g'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'
$$;

/* The same body with the four LEGITIMATE status tokens removed — the two evidence OUT
   parameters, the safe product-status primitive, and the local that carries its result.
   Anything containing "status" that survives is a reference to some OTHER status column,
   and in this neighbourhood every one of those is CURRENT state: vendor_products.status,
   vendor_product_retailer_assignments.status, campaigns.status. Removing tokens rather
   than matching references is what makes the guard immune to formatting — an unqualified
   `status`, a spaced `vp . status` and a quoted `vp."status"` all leave the same residue. */
create function pg_temp.b_body_no_evidence() returns text language sql stable as $$
  select replace(replace(replace(replace(pg_temp.b_body(),
           'assignment_status_at_sale', ''), 'product_status_at_sale', ''),
           'vendor_product_status_at', ''), 'v_status', '')
$$;

/* Everything from the identity assignments onwards — the dispatch and both branches, and
   nothing before them. The declared-resolution test also appears in the earlier
   scope/resolution VALIDATION, so pinning it against the whole body would be satisfied
   by a function that validates the mode and then dispatches on something else entirely.
   O10 pins it here instead. */
create function pg_temp.b_dispatch() returns text language sql stable as $$
  select substring(pg_temp.b_body() from position('campaign_version_id := v_version.id' in pg_temp.b_body()))
$$;


-- ---- Unit 66C fixture: an isolated third tenant ----------------------------
-- Vendor C and Retailer C trade only with each other and appear in no other section.
-- Orchestration tests assert EXACT campaign sets, counts, units and row orders, so they
-- are kept out of the shared Vendor A fixture where adding one campaign would silently
-- change another section's expectations.
create function pg_temp.publish_cfg(
  p_key text, p_vendor uuid, p_admin uuid, p_name text,
  p_starts timestamptz, p_ends timestamptz, p_priority integer,
  p_stacking text, p_excl_key text,
  p_product_scope text, p_product_ids uuid[], p_coins bigint
) returns uuid language plpgsql as $$
declare v_c uuid; v_v uuid;
begin
  perform pg_temp.act_as(p_admin);
  v_c := public.create_vendor_campaign_draft(
    p_name, 'Described.', p_starts, p_ends, 'Asia/Dubai', 'ALL_RETAILERS',
    'INDIVIDUAL_STAFF', p_product_scope, p_stacking, p_excl_key, p_priority,
    'PER_UNIT_COINS', p_coins, null, null, null, null, null, p_product_ids);
  perform public.publish_vendor_campaign(v_c);
  select c.published_version_id into v_v from public.campaigns c where c.id = v_c;
  perform pg_temp.sign_out();
  insert into pg_temp.f values (p_key || '_campaign', v_c), (p_key, v_v);
  return v_v;
end;
$$;

/* A verified sale whose proposed item set the reviewer REJECTED. The header is
   finalized, so the authoritative sale exists — with zero authoritative items. */
create function pg_temp.sale_rejected(
  p_key text, p_retailer uuid, p_shop uuid, p_staff uuid, p_vendor uuid,
  p_reviewer uuid, p_lines jsonb
) returns uuid language plpgsql as $$
declare v_r uuid; v_local timestamp;
begin
  v_local := date_trunc('minute', (now() + interval '2 hours') at time zone 'Asia/Dubai');
  v_r := pg_temp.new_receipt(p_retailer, p_shop, p_staff);
  perform pg_temp.act_as(p_staff);
  perform public.confirm_receipt_with_products(
    v_r, v_local::date, 'AED', 2::smallint, 12345::bigint, p_lines,
    'Test Merchant', 'DOC-1', v_local::time, 10000::bigint, 2345::bigint);
  insert into public.receipt_review_decisions
    (receipt_submission_id, vendor_organization_id, decision, decided_by_profile_id)
  values (v_r, p_vendor, 'VERIFIED', p_reviewer);
  perform pg_temp.act_as(p_reviewer);
  perform public.finalize_claim_receipt_sale_header(v_r, null);
  perform public.finalize_claim_receipt_sale_items(v_r, 'REJECTED', 'WRONG_PRODUCT', null);
  perform pg_temp.sign_out();
  insert into pg_temp.f
  select p_key, v.id from public.verified_sales v where v.receipt_submission_id = v_r;
  return pg_temp.id(p_key);
end;
$$;

do $$
declare v uuid; v_p uuid;
begin
  insert into pg_temp.f values
    ('vendor_c',   pg_temp.new_org('CM Vendor C',   'VENDOR')),
    ('retailer_c', pg_temp.new_org('CM Retailer C', 'RETAILER')),
    ('vsc',    pg_temp.new_person('CM','AdminC')),
    ('revc',   pg_temp.new_person('CM','RevC')),
    ('staffc', pg_temp.new_person('CM','StaffC'));

  perform pg_temp.add_member(pg_temp.id('vsc'),    pg_temp.id('vendor_c'),   'VENDOR_SUPER_ADMIN');
  perform pg_temp.add_member(pg_temp.id('revc'),   pg_temp.id('vendor_c'),   'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('staffc'), pg_temp.id('retailer_c'), 'SALES_STAFF');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (pg_temp.id('vendor_c'), pg_temp.id('retailer_c'), 'ACTIVE');

  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_c'), 'CM Shop C', 'CMC', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop_c', v);

  insert into pg_temp.f values
    ('c_p1', pg_temp.new_product(pg_temp.id('vendor_c'), 'CM-C1', 'C One',   pg_temp.id('vsc'))),
    ('c_p2', pg_temp.new_product(pg_temp.id('vendor_c'), 'CM-C2', 'C Two',   pg_temp.id('vsc'))),
    ('c_p3', pg_temp.new_product(pg_temp.id('vendor_c'), 'CM-C3', 'C Dead',  pg_temp.id('vsc'))),
    ('c_p4', pg_temp.new_product(pg_temp.id('vendor_c'), 'CM-C4', 'C Gap',   pg_temp.id('vsc')));

  foreach v_p in array array[pg_temp.id('c_p1'), pg_temp.id('c_p2'),
                             pg_temp.id('c_p3'), pg_temp.id('c_p4')]
  loop
    perform pg_temp.assign(v_p, pg_temp.id('retailer_c'), pg_temp.id('vsc'));
  end loop;
end;
$$;

-- Six sales, each shaped for exactly one rule. c_p3 becomes INACTIVE and c_p4's timeline
-- falls silent AFTER all of them exist, so every sale is created from a healthy state.
do $$
begin
  -- one eligible line, one that will become ineligible
  perform pg_temp.sale_at_offset('cs_mix', pg_temp.id('retailer_c'), pg_temp.id('shop_c'),
    pg_temp.id('staffc'), pg_temp.id('vendor_c'), pg_temp.id('revc'),
    jsonb_build_array(pg_temp.line(pg_temp.id('c_p1'), 4), pg_temp.line(pg_temp.id('c_p3'), 5)),
    interval '2 hours');

  -- two lines that both stay eligible
  perform pg_temp.sale_at_offset('cs_two', pg_temp.id('retailer_c'), pg_temp.id('shop_c'),
    pg_temp.id('staffc'), pg_temp.id('vendor_c'), pg_temp.id('revc'),
    jsonb_build_array(pg_temp.line(pg_temp.id('c_p1'), 4), pg_temp.line(pg_temp.id('c_p2'), 3)),
    interval '2 hours');

  -- nothing eligible at all
  perform pg_temp.sale_at_offset('cs_none', pg_temp.id('retailer_c'), pg_temp.id('shop_c'),
    pg_temp.id('staffc'), pg_temp.id('vendor_c'), pg_temp.id('revc'),
    jsonb_build_array(pg_temp.line(pg_temp.id('c_p3'), 5)), interval '2 hours');

  -- one eligible line beside one whose history falls silent
  perform pg_temp.sale_at_offset('cs_poison', pg_temp.id('retailer_c'), pg_temp.id('shop_c'),
    pg_temp.id('staffc'), pg_temp.id('vendor_c'), pg_temp.id('revc'),
    jsonb_build_array(pg_temp.line(pg_temp.id('c_p1'), 4), pg_temp.line(pg_temp.id('c_p4'), 9)),
    interval '2 hours');

  -- a single line the SELECTED_PRODUCTS exclusive campaign never selected
  perform pg_temp.sale_at_offset('cs_solo', pg_temp.id('retailer_c'), pg_temp.id('shop_c'),
    pg_temp.id('staffc'), pg_temp.id('vendor_c'), pg_temp.id('revc'),
    jsonb_build_array(pg_temp.line(pg_temp.id('c_p1'), 4)), interval '2 hours');

  -- the reviewer rejected the whole proposed set: an authoritative sale, zero items
  perform pg_temp.sale_rejected('cs_reject', pg_temp.id('retailer_c'), pg_temp.id('shop_c'),
    pg_temp.id('staffc'), pg_temp.id('vendor_c'), pg_temp.id('revc'),
    jsonb_build_array(pg_temp.line(pg_temp.id('c_p1'), 4)));
end;
$$;

-- Vendor C's campaigns. Published while every product is healthy, so the SELECTED_PRODUCTS
-- versions can freeze what they were meant to freeze.
do $$
declare v_at timestamptz; v_e uuid; v_l uuid; i integer;
begin
  select v.sale_at into v_at from public.verified_sales v where v.id = pg_temp.id('cs_two');

  -- Two STACKABLE campaigns with DIFFERENT product scopes, so Section S can prove each
  -- keeps its own item set rather than sharing one.
  perform pg_temp.publish_cfg('cc_ok', pg_temp.id('vendor_c'), pg_temp.id('vsc'), 'CC Open',
    v_at - interval '10 days', v_at + interval '10 days', 10, 'STACKABLE', null,
    'ALL_ELIGIBLE_PRODUCTS', null, 5);

  perform pg_temp.publish_cfg('cc_snap', pg_temp.id('vendor_c'), pg_temp.id('vsc'), 'CC Snap',
    v_at - interval '10 days', v_at + interval '10 days', 20, 'STACKABLE', null,
    'SELECTED_PRODUCTS', array[pg_temp.id('c_p2')]::uuid[], 5);

  -- Its status timeline is closed below, so Unit 66A calls it NOT_EVALUABLE even though
  -- every item of cs_two is ELIGIBLE. That is what makes rule 7 testable.
  perform pg_temp.publish_cfg('cc_gap', pg_temp.id('vendor_c'), pg_temp.id('vsc'), 'CC Gap',
    v_at - interval '10 days', v_at + interval '10 days', 30, 'STACKABLE', null,
    'ALL_ELIGIBLE_PRODUCTS', null, 5);

  -- EXCLUSIVE key BUNDLE. The HIGH-priority campaign deliberately matches FEWER units
  -- (one selected product, 3 units) and is worth ONE coin per unit; the low-priority
  -- rival matches every product (7 units) at 999 coins per unit. Priority must still win.
  perform pg_temp.publish_cfg('cx_hi', pg_temp.id('vendor_c'), pg_temp.id('vsc'), 'CX High',
    v_at - interval '10 days', v_at + interval '10 days', 900, 'EXCLUSIVE', 'BUNDLE',
    'SELECTED_PRODUCTS', array[pg_temp.id('c_p2')]::uuid[], 1);

  perform pg_temp.publish_cfg('cx_lo', pg_temp.id('vendor_c'), pg_temp.id('vsc'), 'CX Low',
    v_at - interval '10 days', v_at + interval '10 days', 100, 'EXCLUSIVE', 'BUNDLE',
    'ALL_ELIGIBLE_PRODUCTS', null, 999);

  -- EXCLUSIVE key TIEB: equal priority, different start. The earlier start must win.
  --
  -- THE PAIR IS BUILT SO THE START DATE IS THE ONLY THING THAT CAN DECIDE IT. Version ids
  -- are random, so a naively-published pair leaves the LATER campaign holding the lower id
  -- roughly half the time — and in exactly those runs, dropping campaign_starts_at from the
  -- tie-break still elects the earlier campaign, by luck, and the test passes while the
  -- rule is broken. Publishing until the later-starting campaign holds the LOWER id makes
  -- the two keys DISAGREE: start says CX TieEarly, id says CX TieLate. Now only an
  -- implementation that consults the start date in the right position can win the test,
  -- in every run. Rejected pairs are CANCELLED, which Unit 66A omits entirely.
  i := 0;
  loop
    i := i + 1;
    v_e := pg_temp.publish_cfg('cx_te_try' || i, pg_temp.id('vendor_c'), pg_temp.id('vsc'),
      'CX TieEarly ' || i, v_at - interval '9 days', v_at + interval '10 days', 500,
      'EXCLUSIVE', 'TIEB', 'ALL_ELIGIBLE_PRODUCTS', null, 5);
    v_l := pg_temp.publish_cfg('cx_tl_try' || i, pg_temp.id('vendor_c'), pg_temp.id('vsc'),
      'CX TieLate ' || i, v_at - interval '8 days', v_at + interval '10 days', 500,
      'EXCLUSIVE', 'TIEB', 'ALL_ELIGIBLE_PRODUCTS', null, 5);

    exit when v_l < v_e;

    perform pg_temp.lifecycle(pg_temp.id('cx_te_try' || i || '_campaign'), pg_temp.id('vsc'), 'CANCEL');
    perform pg_temp.lifecycle(pg_temp.id('cx_tl_try' || i || '_campaign'), pg_temp.id('vsc'), 'CANCEL');

    if i >= 30 then
      raise exception 'Could not build an id-inverted TIEB pair in 30 attempts';
    end if;
  end loop;

  insert into pg_temp.f values ('cx_te', v_e), ('cx_tl', v_l);

  -- EXCLUSIVE key TIEC: equal priority AND equal start, so only the version id separates
  -- them. Which id is lower is random per run, which is exactly why T7 computes the
  -- expected winner rather than naming one.
  perform pg_temp.publish_cfg('cx_ia', pg_temp.id('vendor_c'), pg_temp.id('vsc'), 'CX IdA',
    v_at - interval '7 days', v_at + interval '10 days', 500, 'EXCLUSIVE', 'TIEC',
    'ALL_ELIGIBLE_PRODUCTS', null, 5);

  perform pg_temp.publish_cfg('cx_ib', pg_temp.id('vendor_c'), pg_temp.id('vsc'), 'CX IdB',
    v_at - interval '7 days', v_at + interval '10 days', 500, 'EXCLUSIVE', 'TIEC',
    'ALL_ELIGIBLE_PRODUCTS', null, 5);
end;
$$;

-- Vendor C's injuries, after every sale and every publication.
do $$
declare v_at timestamptz;
begin
  select v.sale_at into v_at from public.verified_sales v where v.id = pg_temp.id('cs_two');

  update public.vendor_products set status = 'INACTIVE' where id = pg_temp.id('c_p3');

  update public.vendor_product_status_history set valid_to = v_at - interval '1 hour'
   where vendor_product_id = pg_temp.id('c_p4') and valid_to is null;

  -- CC Gap's campaign timeline is closed an hour before the sale, leaving the sale
  -- instant uncovered. Unit 66A's own suite proves this produces NO_TEMPORAL_RECORD.
  update public.campaign_version_status_history set valid_to = v_at - interval '1 hour'
   where campaign_id = pg_temp.id('cc_gap_campaign') and valid_to is null;
end;
$$;

/* One campaign's final result for one sale: outcome/reason/count/units, or ABSENT. */
create function pg_temp.res(p_sale uuid, p_version uuid) returns text
language sql stable as $$
  select coalesce(
    (select r.outcome || '/' || coalesce(r.non_qualification_reason, '-') || '/'
         || r.qualifying_item_count::text || '/' || r.qualifying_units::text
     from public.campaign_matching_result_for_sale(p_sale) r
     where r.campaign_version_id = p_version),
    'ABSENT')
$$;

/* The campaign result set as one ordered digest. row_number() over () numbers rows in
   the order the function emitted them, so this pins ORDER as well as content. */
create function pg_temp.res_digest(p_sale uuid) returns text language sql stable as $$
  select string_agg(t.line, ' >> ' order by t.n)
  from (select row_number() over () as n,
               r.outcome || '/' || coalesce(r.non_qualification_reason, '-') || '/'
            || r.qualifying_item_count::text || '/' || r.qualifying_units::text as line
        from public.campaign_matching_result_for_sale(p_sale) r) t
$$;

create function pg_temp.res_order(p_sale uuid) returns uuid[] language sql stable as $$
  select array_agg(t.v order by t.n)
  from (select row_number() over () as n, r.campaign_version_id as v
        from public.campaign_matching_result_for_sale(p_sale) r) t
$$;

create function pg_temp.items_digest(p_sale uuid) returns text language sql stable as $$
  select coalesce(string_agg(t.line, ' >> ' order by t.n), 'NONE')
  from (select row_number() over () as n,
               q.campaign_version_id::text || ':' || q.vendor_product_id::text || ':'
            || q.qualifying_units::text || ':' || q.product_source || ':'
            || coalesce(q.product_status_at_sale, '-') || ':'
            || coalesce(q.assignment_status_at_sale, '-') as line
        from public.campaign_matching_qualified_items_for_sale(p_sale) q) t
$$;

/* The qualifying products of one campaign, in the order the helper returned them. */
create function pg_temp.item_products(p_sale uuid, p_version uuid) returns uuid[]
language sql stable as $$
  select array_agg(t.v order by t.n)
  from (select row_number() over () as n, q.vendor_product_id as v
        from public.campaign_matching_qualified_items_for_sale(p_sale) q
        where q.campaign_version_id = p_version) t
$$;

/* Either Unit 66C function's body, normalized as Sections F and O normalize the others. */
create function pg_temp.c_body(p_name text) returns text language sql stable as $$
  select lower(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', ' ', 'g'), '\s+', ' ', 'g'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name
$$;

create table pg_temp.snap (k text primary key, v text);


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
-- NARROWED FOR UNIT 66B: campaign_sale_item_eligible_at was created by approval in the
-- same migration and is excepted BY NAME, not by pattern. Section J proves it is pure,
-- internal and non-writing; the rule this assertion owns — that no aggregation,
-- evaluation RPC, reward calculation or application surface exists yet — is intact.
-- NARROWED AGAIN FOR UNIT 66C: campaign_matching_result_for_sale and
-- campaign_matching_qualified_items_for_sale were created by approval in the same
-- migration and are excepted BY NAME. Section Q proves both are pure, internal and
-- non-writing. The rule this assertion owns — that no evaluation RPC, reward
-- calculation, accumulator update or application surface exists yet — is intact.
  'B1. Unit 67/68 function does not exist yet: ' || f)
from unnest(array[
  'evaluate_sale_campaign_qualification',
  'get_sale_campaign_qualification',
  'list_my_staff_rewards'
]) as f;

-- NARROWED FOR PHASE 2A-C: campaign_apply_reward_for_evaluation was created by approval
-- in migration 20260825090000 and is the ONE function permitted to write a reward and
-- maintain the accumulator. It is named exactly, so any other campaign_% function that
-- starts writing evidence — including either of this migration's own, which is what this
-- assertion exists to protect — still fails.
select is((select coalesce(string_agg(p.proname, ',' order by p.proname), 'NONE')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_%'
             and p.prosrc ~* '(insert|update|delete)\s+(into\s+)?public\.campaign_(sale|reward|subject)'),
  'campaign_apply_reward_for_evaluation',
  'B2. the approved Migration 67 applier is the only campaign function that writes to '
  'the Migration 65 evidence tables');

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



-- ============================================================================
-- ============================================================================
-- UNIT 66B — public.campaign_sale_item_eligible_at(uuid, uuid)
-- ============================================================================
-- ============================================================================
-- Four properties carry this unit:
--
--   1. THE DECLARED RESOLUTION DECIDES, not the presence of snapshot rows. A
--      LIVE_TEMPORAL version has NO campaign_eligible_products rows by design, so an
--      implementation that inferred the mode from that table would disqualify every
--      item of every open-scope campaign. Section M/N test the same item both ways.
--
--   2. SNAPSHOT IS FROZEN. Deactivating the product or removing the assignment
--      afterwards cannot disturb a historical match, and no temporal evidence is
--      reported because no temporal question was asked. Section M.
--
--   3. MISSING HISTORY OUTRANKS A DEFINITE NO. Section N, and q_agap in particular:
--      one axis silent, the other explicitly INACTIVE, answer NOT_EVALUABLE.
--
--   4. THE COMPOSITE HELPERS ARE REFUSED. One reads current product status, the other
--      collapses NULL to false. Section O pins both out by name and by residue.


-- ============================================================================
-- SECTION J — UNIT 66B SCHEMA AND SECURITY
-- ============================================================================
select has_function('public', 'campaign_sale_item_eligible_at', array['uuid','uuid'],
  'J1. the product eligibility resolver exists with the exact signature');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'),
  'TABLE(campaign_version_id uuid, verified_sale_item_id uuid, verified_sale_id uuid, '
  'vendor_product_id uuid, qualifying_units integer, product_source text, '
  'product_status_at_sale text, assignment_status_at_sale text, eligibility_result text, '
  'eligibility_reason text)',
  'J2. the return contract is exactly the approved 10 columns and types');

select is((select pg_get_function_identity_arguments(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'),
  'p_campaign_version_id uuid, p_verified_sale_item_id uuid',
  'J3. it takes the campaign version and the sale item, and derives everything else');

select ok((select p.provolatile = 's' and p.prosecdef
           and p.proconfig @> array['search_path=""']
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'),
  'J4. STABLE, SECURITY DEFINER, empty search_path');

select is((select p.proacl::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'),
  '{postgres=X/postgres}',
  'J5. owner-execute-only — the default PUBLIC grant really was revoked');

select is((select count(*)::integer from information_schema.role_routine_grants
           where routine_schema = 'public'
             and routine_name = 'campaign_sale_item_eligible_at'
             and grantee in ('anon','authenticated','service_role','PUBLIC')), 0,
  'J6. no grant to anon, authenticated, service_role or PUBLIC');

select isnt((select obj_description(p.oid, 'pg_proc') from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'),
  null, 'J7. the function is documented');

select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'), 47,
  'J8. Unit 66B added no table either — still the 47 from Migration 65');

select is((select count(*)::integer from public.permissions), 32,
  'J9. the permission catalogue is still unchanged at 32');


-- ============================================================================
-- SECTION K — UNIT BOUNDARY: 66A AND 66B ONLY
-- ============================================================================
-- The two resolvers are the whole of Migration 66. Nothing that aggregates, decides an
-- exclusive winner, calculates a reward or exposes a surface may exist yet.
-- NARROWED FOR UNIT 66C, exactly as B1 above: the two orchestration functions are
-- excepted by name, and every executor, calculator and surface stays forbidden.
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = f), 0,
  'K1. Unit 67/68 function still does not exist: ' || f)
from unnest(array[
  'campaign_sale_items_eligible_at',
  'campaign_sale_qualifying_units',
  'campaign_sale_exclusive_winner',
  'evaluate_sale_campaign_qualification',
  'award_campaign_reward',
  'campaign_reward_for_sale',
  'get_sale_campaign_qualification',
  'list_my_staff_rewards'
]) as f;

select is(
  (select coalesce(string_agg(p.proname, ',' order by p.proname), 'NONE')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'campaign_%'
     and p.prorettype <> 'trigger'::regtype
     and p.proname in ('campaign_versions_matching_sale','campaign_sale_item_eligible_at',
                       'campaign_matching_result_for_sale',
                       'campaign_matching_qualified_items_for_sale')),
  'campaign_matching_qualified_items_for_sale,campaign_matching_result_for_sale,'
  'campaign_sale_item_eligible_at,campaign_versions_matching_sale',
  'K2. all four Migration 66 functions exist, and they are the four that were approved');

-- NARROWED FOR PHASE 2A-C, for the same reason and by the same exact name as B2.
select is((select coalesce(string_agg(p.proname, ',' order by p.proname), 'NONE')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_%'
             and p.prosrc ~* '(insert|update|delete)\s+(into\s+)?public\.campaign_(sale|reward|subject)'),
  'campaign_apply_reward_for_evaluation',
  'K3. still the approved Migration 67 applier alone writes to the Migration 65 evidence '
  'tables');


-- ============================================================================
-- SECTION L — AUTHORITATIVE LINEAGE
-- ============================================================================
-- Broken lineage RAISES. A contradictory input is not an unknown, and answering it
-- would launder the contradiction into evidence that looks resolved.
select throws_ok(
  'select * from public.campaign_sale_item_eligible_at(null, null)',
  '22023', null, 'L1. two null ids raise invalid_parameter_value');

select is(pg_temp.try_sql(format(
  'select * from public.campaign_sale_item_eligible_at(null, %L)', pg_temp.item(pg_temp.id('q_live')))),
  'REFUSED:22023', 'L2. a null campaign version id raises invalid_parameter_value');

select is(pg_temp.try_sql(format(
  'select * from public.campaign_sale_item_eligible_at(%L, null)', pg_temp.id('cv_ok'))),
  'REFUSED:22023', 'L3. a null sale item id raises invalid_parameter_value');

select is(pg_temp.try_sql(format(
  'select * from public.campaign_sale_item_eligible_at(%L, %L)',
  pg_temp.id('cv_ok'), gen_random_uuid())),
  'REFUSED:23503', 'L4. a missing sale item raises foreign_key_violation');

select is(pg_temp.try_sql(format(
  'select * from public.campaign_sale_item_eligible_at(%L, %L)',
  gen_random_uuid(), pg_temp.item(pg_temp.id('q_live')))),
  'REFUSED:23503', 'L5. a missing campaign version raises foreign_key_violation');

-- THE VENDOR BOUNDARY, both directions. Vendor B trades with Retailer A, so its campaign
-- genuinely targets this Retailer — the only thing separating it from this sale is the
-- Vendor check, exactly as in Section D.
select is(pg_temp.try_sql(format(
  'select * from public.campaign_sale_item_eligible_at(%L, %L)',
  pg_temp.id('cv_vb'), pg_temp.item(pg_temp.id('q_live')))),
  'REFUSED:23514', 'L6. Vendor B''s campaign against Vendor A''s sale item raises check_violation');

select is(pg_temp.try_sql(format(
  'select * from public.campaign_sale_item_eligible_at(%L, %L)',
  pg_temp.id('cv_ok'),
  (select i.id from public.verified_sale_items i where i.verified_sale_id = pg_temp.id('s_b') limit 1))),
  'REFUSED:23514', 'L7. Vendor A''s campaign against Vendor B''s sale item raises check_violation');

-- The remaining lineage branches are unreachable from SQL: verified_sale_items has NOT
-- NULL foreign keys to verified_sales and vendor_products, and the item/product Vendor
-- columns are held equal to the sale's by Migration 63's insert assertions. They are
-- pinned structurally so a future refactor cannot delete them unnoticed, since deleting
-- an unreachable branch breaks no behavioural test.
select ok(pg_temp.b_body() like '%has no verified sale%',
  'L8. the missing-sale branch exists, though the foreign key makes it unreachable');
select ok(pg_temp.b_body() like '%has no vendor product%',
  'L9. the missing-product branch exists, though the foreign key makes it unreachable');
select ok(pg_temp.b_body() like '%sale item belongs to a different vendor%',
  'L10. the item-Vendor branch exists, though the insert assertions make it unreachable');
select ok(pg_temp.b_body() like '%product belongs to a different vendor%',
  'L11. the product-Vendor branch exists, though the insert assertions make it unreachable');
select ok(pg_temp.b_body() like '%unsupported product scope and resolution%',
  'L12. an unrecognized scope/resolution pair raises rather than falling through the dispatch');


-- ============================================================================
-- SECTION M — SNAPSHOT: THE FROZEN SET, AND NOTHING ELSE
-- ============================================================================
select is((select cv.product_eligibility_resolution from public.campaign_versions cv
           where cv.id = pg_temp.id('cv_snap')), 'SNAPSHOT',
  'M1. precondition: cv_snap really did publish as SNAPSHOT');

select is((select count(*)::integer from public.campaign_eligible_products ep
           where ep.campaign_version_id = pg_temp.id('cv_snap')
             and ep.retailer_organization_id = pg_temp.id('retailer_a')), 3,
  'M2. precondition: three products were frozen for this Retailer at publication');

select is(pg_temp.ev(pg_temp.id('cv_snap'), pg_temp.item(pg_temp.id('q_snap'))),
  'SNAPSHOT | - | - | 3 | ELIGIBLE | -',
  'M3. a frozen product is ELIGIBLE for its own quantity, with no temporal evidence');

select is(pg_temp.ev(pg_temp.id('cv_snap'), pg_temp.item(pg_temp.id('q_live'))),
  'SNAPSHOT | - | - | 0 | NOT_ELIGIBLE | PRODUCT_NOT_ELIGIBLE',
  'M4. a product outside the frozen set is NOT_ELIGIBLE and counts zero units');

-- THE POINT OF FREEZING. Both of these products were injured after publication.
select is(pg_temp.ev(pg_temp.id('cv_snap'), pg_temp.item(pg_temp.id('q_pdead'))),
  'SNAPSHOT | - | - | 5 | ELIGIBLE | -',
  'M5. deactivating the product afterwards does not disturb the historical match');

select is(pg_temp.ev(pg_temp.id('cv_snap'), pg_temp.item(pg_temp.id('q_adead'))),
  'SNAPSHOT | - | - | 6 | ELIGIBLE | -',
  'M6. removing the assignment afterwards does not disturb it either');

select is(pg_temp.ev(pg_temp.id('cv_snap'), pg_temp.item(pg_temp.id('q_both'))),
  'SNAPSHOT | - | - | 0 | NOT_ELIGIBLE | PRODUCT_NOT_ELIGIBLE',
  'M7. an absent timeline is irrelevant under SNAPSHOT — membership alone decides');

-- A sale predating every timeline. Under SNAPSHOT there is nothing to be missing.
select is((select e.eligibility_result || '/' || e.qualifying_units::text
           from public.campaign_sale_item_eligible_at(pg_temp.id('cv_snap'),
             (select i.id from public.verified_sale_items i
              where i.verified_sale_id = pg_temp.id('s_items_past'))) e),
  'ELIGIBLE/2',
  'M8. a sale from before any history still resolves, and never NOT_EVALUABLE');

-- NULL temporal evidence is not incidental: campaign_sale_item_qualifications_live_
-- evidence_paired refuses a stored SNAPSHOT row that carries a sale-time product status.
select ok((select e.product_status_at_sale is null and e.assignment_status_at_sale is null
           from public.campaign_sale_item_eligible_at(pg_temp.id('cv_snap'),
                  pg_temp.item(pg_temp.id('q_snap'))) e),
  'M9. both sale-time evidence columns are NULL, as Migration 65''s pairing CHECK requires');

select is((select count(*)::integer from public.campaign_sale_item_eligible_at(
             pg_temp.id('cv_snap'), pg_temp.item(pg_temp.id('q_snap')))), 1,
  'M10. exactly one row is returned for one (version, item) pair');

-- THE REACHABLE PRESENCE-INFERENCE CASE. Retailer B is an eligible Retailer of this
-- ALL_RETAILERS version, but none of the three selected products is assigned to it, so
-- the frozen set holds nothing for it. "Are there rows for this sale's Retailer?" and
-- "what did the version declare?" disagree here, and only the second is correct.
select is((select count(*)::integer from public.campaign_eligible_products ep
           where ep.campaign_version_id = pg_temp.id('cv_snap')
             and ep.retailer_organization_id = pg_temp.id('retailer_b')), 0,
  'M12. precondition: the frozen set holds nothing at all for Retailer B');

select is(pg_temp.ev(pg_temp.id('cv_snap'), pg_temp.item_rb()),
  'SNAPSHOT | - | - | 0 | NOT_ELIGIBLE | PRODUCT_NOT_ELIGIBLE',
  'M13. an unselected product is NOT_ELIGIBLE even where the frozen set is empty');

-- The contrast that gives M13 its force: the same item, healthy on both axes, is
-- ELIGIBLE the moment a version actually declares LIVE_TEMPORAL. So M13 is not passing
-- because the product is broken — it is passing because the version never selected it.
select is(pg_temp.ev(pg_temp.id('cv_ok'), pg_temp.item_rb()),
  'LIVE_TEMPORAL | ACTIVE | ACTIVE | 4 | ELIGIBLE | -',
  'M14. ...while the same item under a LIVE_TEMPORAL version is ELIGIBLE for 4 units');

select ok((select e.campaign_version_id = pg_temp.id('cv_snap')
             and e.verified_sale_item_id = pg_temp.item(pg_temp.id('q_snap'))
             and e.verified_sale_id = pg_temp.id('s_items')
             and e.vendor_product_id = pg_temp.id('q_snap')
           from public.campaign_sale_item_eligible_at(pg_temp.id('cv_snap'),
                  pg_temp.item(pg_temp.id('q_snap'))) e),
  'M15. the row echoes the derived lineage: version, item, sale and product');


-- ============================================================================
-- SECTION N — LIVE_TEMPORAL: BOTH AXES, AT THE SALE INSTANT
-- ============================================================================
select is((select cv.product_eligibility_resolution from public.campaign_versions cv
           where cv.id = pg_temp.id('cv_ok')), 'LIVE_TEMPORAL',
  'N1. precondition: cv_ok is the open-scope campaign');

-- THE DISPATCH IS ON THE DECLARED MODE. cv_ok has no frozen rows at all, by design. An
-- implementation that inferred SNAPSHOT from an empty campaign_eligible_products would
-- fail every assertion below with a uniform NOT_ELIGIBLE.
select is((select count(*)::integer from public.campaign_eligible_products ep
           where ep.campaign_version_id = pg_temp.id('cv_ok')), 0,
  'N2. precondition: a LIVE_TEMPORAL version freezes no products whatsoever');

select is(pg_temp.ev(pg_temp.id('cv_ok'), pg_temp.item(pg_temp.id('q_live'))),
  'LIVE_TEMPORAL | ACTIVE | ACTIVE | 4 | ELIGIBLE | -',
  'N3. both axes ACTIVE at sale_at is ELIGIBLE, with both statuses recorded');

-- The same item the frozen campaign called ELIGIBLE. Two resolutions, two answers, one
-- history — which is precisely what makes the declared mode load-bearing.
select is(pg_temp.ev(pg_temp.id('cv_ok'), pg_temp.item(pg_temp.id('q_pdead'))),
  'LIVE_TEMPORAL | INACTIVE | ACTIVE | 0 | NOT_ELIGIBLE | PRODUCT_NOT_ELIGIBLE',
  'N4. an explicitly INACTIVE product is NOT_ELIGIBLE, counts zero, and says why');

select is(pg_temp.ev(pg_temp.id('cv_ok'), pg_temp.item(pg_temp.id('q_adead'))),
  'LIVE_TEMPORAL | ACTIVE | INACTIVE | 0 | NOT_ELIGIBLE | PRODUCT_NOT_ELIGIBLE',
  'N5. an explicitly INACTIVE assignment is NOT_ELIGIBLE, counts zero, and says why');

select is(pg_temp.ev(pg_temp.id('cv_ok'), pg_temp.item(pg_temp.id('q_pgap'))),
  'LIVE_TEMPORAL | - | ACTIVE | 0 | NOT_EVALUABLE | NO_TEMPORAL_RECORD',
  'N6. a silent product timeline is NOT_EVALUABLE even though the assignment is ACTIVE');

-- THE ADJUDICATION. The assignment axis is silent; the product axis says a definite
-- INACTIVE. A resolver that answered NOT_ELIGIBLE here would be right by accident and
-- wrong in principle: it would be reporting a fact it did not establish.
select is(pg_temp.ev(pg_temp.id('cv_ok'), pg_temp.item(pg_temp.id('q_agap'))),
  'LIVE_TEMPORAL | INACTIVE | - | 0 | NOT_EVALUABLE | NO_TEMPORAL_RECORD',
  'N7. a silent assignment timeline outranks an explicitly INACTIVE product');

select is(pg_temp.ev(pg_temp.id('cv_ok'), pg_temp.item(pg_temp.id('q_both'))),
  'LIVE_TEMPORAL | - | - | 0 | NOT_EVALUABLE | NO_TEMPORAL_RECORD',
  'N8. both timelines silent is NOT_EVALUABLE with no evidence to report');

-- Units, stated separately from the composite so the rule is named rather than implied.
select is((select e.qualifying_units from public.campaign_sale_item_eligible_at(
             pg_temp.id('cv_ok'), pg_temp.item(pg_temp.id('q_snap'))) e), 3,
  'N9. an ELIGIBLE item counts THIS item''s quantity, not the first item''s or the sale''s');

select is((select coalesce(sum(e.qualifying_units), -1)::integer
           from unnest(array[pg_temp.id('q_pdead'), pg_temp.id('q_adead'),
                             pg_temp.id('q_pgap'), pg_temp.id('q_agap'), pg_temp.id('q_both')]) as p,
                lateral public.campaign_sale_item_eligible_at(pg_temp.id('cv_ok'), pg_temp.item(p)) e), 0,
  'N10. every non-ELIGIBLE verdict counts exactly zero units');

select ok((select bool_and(e.qualifying_units >= 1)
           from unnest(array[pg_temp.id('q_snap'), pg_temp.id('q_live')]) as p,
                lateral public.campaign_sale_item_eligible_at(pg_temp.id('cv_ok'), pg_temp.item(p)) e),
  'N11. every ELIGIBLE verdict counts at least one unit, as Migration 65 stores it');

-- The result/reason pairing is a closed vocabulary, checked across all seven items and
-- both resolutions at once.
select ok((select bool_and(
             e.eligibility_result in ('ELIGIBLE','NOT_ELIGIBLE','NOT_EVALUABLE')
             and ((e.eligibility_result = 'ELIGIBLE'      and e.eligibility_reason is null)
               or (e.eligibility_result = 'NOT_ELIGIBLE'  and e.eligibility_reason = 'PRODUCT_NOT_ELIGIBLE')
               or (e.eligibility_result = 'NOT_EVALUABLE' and e.eligibility_reason = 'NO_TEMPORAL_RECORD')))
           from unnest(array[pg_temp.id('cv_snap'), pg_temp.id('cv_ok')]) as v,
                unnest(array[pg_temp.id('q_snap'), pg_temp.id('q_live'), pg_temp.id('q_pdead'),
                             pg_temp.id('q_adead'), pg_temp.id('q_pgap'), pg_temp.id('q_agap'),
                             pg_temp.id('q_both')]) as p,
                lateral public.campaign_sale_item_eligible_at(v, pg_temp.item(p)) e),
  'N12. result and reason are paired from the approved vocabulary in all fourteen cases');

select ok((select bool_and((e.product_source = 'LIVE_TEMPORAL') = (e.product_status_at_sale is not null
                            or e.eligibility_result = 'NOT_EVALUABLE'))
           from unnest(array[pg_temp.id('cv_snap'), pg_temp.id('cv_ok')]) as v,
                unnest(array[pg_temp.id('q_snap'), pg_temp.id('q_live'), pg_temp.id('q_pdead'),
                             pg_temp.id('q_adead'), pg_temp.id('q_pgap'), pg_temp.id('q_agap'),
                             pg_temp.id('q_both')]) as p,
                lateral public.campaign_sale_item_eligible_at(v, pg_temp.item(p)) e),
  'N13. only LIVE_TEMPORAL ever reports a sale-time product status');

select ok((select bool_and(e.product_source in ('SNAPSHOT','LIVE_TEMPORAL'))
           from unnest(array[pg_temp.id('cv_snap'), pg_temp.id('cv_ok')]) as v,
                unnest(array[pg_temp.id('q_snap'), pg_temp.id('q_both')]) as p,
                lateral public.campaign_sale_item_eligible_at(v, pg_temp.item(p)) e),
  'N14. product_source is always one of the two approved values');

-- UNIT 66B DOES NOT RE-DECIDE CANDIDACY. Whether the campaign was in force, or covered
-- the sale at all, is Unit 66A's answer and 66C's to combine. Re-checking it here would
-- give one question two owners that could disagree.
select is(pg_temp.ev(pg_temp.id('cv_paused'), pg_temp.item(pg_temp.id('q_live'))),
  'LIVE_TEMPORAL | ACTIVE | ACTIVE | 4 | ELIGIBLE | -',
  'N15. a paused campaign still gets a product answer — candidacy is Unit 66A''s question');

select is(pg_temp.ev(pg_temp.id('cv_start_after'), pg_temp.item(pg_temp.id('q_live'))),
  'LIVE_TEMPORAL | ACTIVE | ACTIVE | 4 | ELIGIBLE | -',
  'N16. so does a campaign whose period excludes the sale entirely');


-- ============================================================================
-- SECTION O — THE UNSAFE COMPOSITES, AND CURRENT STATE
-- ============================================================================
-- Section N would still pass if the resolver called vendor_retailer_eligible_products_at
-- today, because every product in this fixture whose CURRENT status happens to match its
-- status at sale_at agrees either way. These guards are what make the choice of
-- primitive checkable rather than incidental.
select ok(pg_temp.b_body() like '%vendor_product_assignment_state_at%',
  'O1. the safe assignment primitive is called directly');

select ok(pg_temp.b_body() like '%vendor_product_status_at%',
  'O2. the safe product-status primitive is called directly');

select ok(pg_temp.b_body() not like '%vendor_retailer_eligible_products_at%',
  'O3. the composite that reads CURRENT vendor_products.status is not used');

select ok(pg_temp.b_body() not like '%vendor_product_eligible_for_retailer_at%',
  'O4. the composite that collapses NULL into false is not used');

select ok(pg_temp.b_body() not like '%campaign_product_eligibility_as_of%'
      and pg_temp.b_body() not like '%campaign_derived_state%'
      and pg_temp.b_body() not like '%published_version_id%',
  'O5. no display-only helper and no published_version_id');

select ok(pg_temp.b_body() !~ '\mnow\s*\(' and pg_temp.b_body() !~ '\mcurrent_timestamp\M',
  'O6. every temporal question is asked at sale_at — never at now()');

select ok(pg_temp.b_body() like '%v_sale.sale_at%',
  'O7. and sale_at is the instant actually passed to the primitives');

-- THE RESIDUE GUARD. Adding `and vp.status = ''ACTIVE''`, or reading v_product.status, or
-- consulting campaigns.status, leaves a "status" token that the four legitimate ones
-- cannot absorb — in any spelling, qualified or not, quoted or not.
select ok(pg_temp.b_body_no_evidence() not like '%status%',
  'O8. no CURRENT status column decides a historical eligibility, in any spelling');

-- The control. If the strip list ever stopped matching, O8 would pass vacuously.
select ok(pg_temp.b_body() like '%status%',
  'O9. control: the unstripped body does contain status tokens, so O8 is not vacuous');

select ok(pg_temp.b_dispatch() like '%product_eligibility_resolution = ''snapshot''%',
  'O10. the DISPATCH itself reads the version''s declared resolution');

select ok(pg_temp.b_dispatch() not like '%if exists ( select 1 from public.campaign_eligible_products%',
  'O11. it does not branch on whether frozen rows happen to exist — see M12-M14');

select ok(pg_temp.b_body_no_evidence() not like '%is_version_in_force%'
      and pg_temp.b_body_no_evidence() not like '%campaign_version_status_history%',
  'O12. it does not re-decide campaign candidacy from the status timeline');

-- Migration 66 as a whole: neither resolver may reach the unsafe composites. Stated over
-- both functions so a future unit cannot slip one in beside a passing 66B.
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('campaign_versions_matching_sale','campaign_sale_item_eligible_at',
                               'campaign_matching_result_for_sale',
                               'campaign_matching_qualified_items_for_sale')
             and p.prosrc ~* 'vendor_retailer_eligible_products_at|vendor_product_eligible_for_retailer_at'), 0,
  'O13. no Migration 66 function touches either unsafe composite helper');


-- ============================================================================
-- SECTION P — UNIT 66B WRITES NOTHING
-- ============================================================================
-- Every assertion above has now called the resolver dozens of times.
select ok((select regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
                  !~* '\minsert\s+into\M|\mupdate\s+public\.|\mdelete\s+from\M'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='campaign_sale_item_eligible_at'),
  'P1. the executable body contains no INSERT, UPDATE or DELETE statement');

select is((select count(*)::integer from public.campaign_sale_evaluations), 0,
  'P2. still no evaluation evidence');
select is((select count(*)::integer from public.campaign_sale_item_qualifications), 0,
  'P3. still no item qualification evidence');
select is((select count(*)::integer from public.campaign_rewards), 0,
  'P4. still no reward evidence');
select is((select count(*)::integer from public.campaign_subject_accumulators), 0,
  'P5. still no accumulator row');

-- The frozen snapshot is read constantly by Section M and must be exactly as published.
select is((select count(*)::integer from public.campaign_eligible_products ep
           where ep.campaign_version_id = pg_temp.id('cv_snap')), 3,
  'P6. reading the frozen product set neither added to it nor removed from it');




-- ============================================================================
-- ============================================================================
-- UNIT 66C — ORCHESTRATION
--   public.campaign_matching_result_for_sale(uuid)
--   public.campaign_matching_qualified_items_for_sale(uuid)
-- ============================================================================
-- ============================================================================
-- Five properties carry this unit:
--
--   1. AN INELIGIBLE ITEM DOES NOT VETO ITS NEIGHBOURS, but ONE UNKNOWN ITEM VETOES THE
--      WHOLE CAMPAIGN. Those two rules pull in opposite directions and a single
--      implementation has to get both right. Section R.
--
--   2. THE TIE-BREAK IS priority, start, id — AND NOTHING ELSE. The fixture makes the
--      high-priority campaign match FEWER units and pay ONE coin against a rival's 999,
--      so a winner chosen by money or by basket size would be visibly wrong. Section T.
--
--   3. A SUPPRESSED LOSER IS INERT. Zero count, zero units, no qualifying items — but
--      the row is still returned, because "matched and lost" is evidence. Section T/U.
--
--   4. ONLY FINAL OUTCOMES REACH THE ITEM HELPER. Provisionally-qualified-then-suppressed
--      campaigns contribute nothing. Section U.
--
--   5. ORDER IS PART OF THE CONTRACT. Two calls agree, and current state cannot move a
--      historical result. Section V.


-- ============================================================================
-- SECTION Q — UNIT 66C SCHEMA AND SECURITY
-- ============================================================================
select has_function('public', 'campaign_matching_result_for_sale', array['uuid'],
  'Q1. the orchestration resolver exists with the exact signature');

select has_function('public', 'campaign_matching_qualified_items_for_sale', array['uuid'],
  'Q2. the qualifying-item helper exists with the exact signature');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_matching_result_for_sale'),
  'TABLE(campaign_id uuid, campaign_version_id uuid, vendor_organization_id uuid, '
  'retailer_organization_id uuid, retailer_shop_id uuid, beneficiary_profile_id uuid, '
  'sale_at timestamp with time zone, performance_scope text, reward_recipient_scope text, '
  'product_scope text, product_eligibility_resolution text, stacking_mode text, '
  'exclusivity_key text, priority integer, campaign_starts_at timestamp with time zone, '
  'campaign_ends_at timestamp with time zone, outcome text, non_qualification_reason text, '
  'qualifying_item_count integer, qualifying_units integer)',
  'Q3. the result contract is exactly the approved 20 columns and types');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname = 'campaign_matching_qualified_items_for_sale'),
  'TABLE(campaign_id uuid, campaign_version_id uuid, verified_sale_id uuid, '
  'verified_sale_item_id uuid, vendor_product_id uuid, qualifying_units integer, '
  'product_source text, product_status_at_sale text, assignment_status_at_sale text)',
  'Q4. the item contract is exactly the approved 9 columns and types — a typed row set, '
  'not JSON');

select ok((select bool_and(p.provolatile = 's') from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_matching_%'),
  'Q5. both are STABLE');

select ok((select bool_and(p.prosecdef) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_matching_%'),
  'Q6. both are SECURITY DEFINER');

select ok((select bool_and(p.proconfig @> array['search_path=""']) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_matching_%'),
  'Q7. both run with an empty search_path');

select ok((select bool_and(p.proacl::text = '{postgres=X/postgres}') from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_matching_%'),
  'Q8. both are owner-execute-only — the default PUBLIC grant really was revoked');

select is((select count(*)::integer from information_schema.role_routine_grants
           where routine_schema = 'public' and routine_name like 'campaign_matching_%'
             and grantee in ('anon','authenticated','service_role','PUBLIC')), 0,
  'Q9. no application role may execute either function');

select ok((select bool_and(obj_description(p.oid, 'pg_proc') is not null) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_matching_%'),
  'Q10. both are documented');

select is((select count(*)::integer from public.permissions), 32,
  'Q11. the permission catalogue is still 32 — no new permission was minted');

select is((select count(*)::integer from public.role_permissions rp
           join public.permissions pm on pm.id = rp.permission_id
           where pm.code like '%CAMPAIGN_MATCH%' or pm.code like '%EVALUAT%'), 0,
  'Q12. no role was granted a matching or evaluation permission');

select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'), 47,
  'Q13. Unit 66C added no table either — still the 47 from Migration 65');

select ok((select bool_and(regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
                  !~* '\minsert\s+into\M|\mupdate\s+public\.|\mdelete\s+from\M|\mtruncate\M')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_matching_%'),
  'Q14. neither executable body contains INSERT, UPDATE, DELETE or TRUNCATE');

select ok((select bool_and(p.prosrc !~* '\mexecute\s+|\mformat\s*\(|\mquote_ident\M')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_matching_%'),
  'Q15. neither uses dynamic SQL');

select ok((select bool_and(p.prosrc !~* '\mnow\s*\(|\mcurrent_timestamp\M|published_version_id')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_matching_%'),
  'Q16. neither reads now() or campaigns.published_version_id');

-- SUPERSEDED IN PART BY PHASE 2A-C: Migration 67 (20260825090000) was created by
-- approval and is named exactly. The rule this assertion still owns is that NOTHING
-- beyond it has been applied — a Migration 68 appearing without approval fails here.
select is((select coalesce(string_agg(version, ',' order by version), 'NONE')
           from supabase_migrations.schema_migrations
           where version > '20260824090000'), '20260825090000',
  'Q17. the only migration after 20260824090000 is the approved Migration 67');

select is((select count(*)::integer from supabase_migrations.schema_migrations
           where version = '20260824090000'), 1,
  'Q18. Migration 66 is recorded exactly once');

-- IT COMPOSES. If either helper name disappeared from the body, this unit would have
-- started re-deriving an answer that already has an owner.
select ok(pg_temp.c_body('campaign_matching_result_for_sale')
            like '%campaign_versions_matching_sale%',
  'Q19. the resolver composes Unit 66A rather than re-deriving candidacy');

select ok(pg_temp.c_body('campaign_matching_result_for_sale')
            like '%campaign_sale_item_eligible_at%',
  'Q20. ...and composes Unit 66B rather than re-deriving product eligibility');

select ok(pg_temp.c_body('campaign_matching_qualified_items_for_sale')
            like '%campaign_matching_result_for_sale%',
  'Q21. the item helper composes the resolver, so the QUALIFIED set is decided once');

-- Neither may consult the status timeline, the frozen snapshot or the product timelines
-- directly: every one of those questions belongs to 66A or 66B.
select ok((select bool_and(p.prosrc !~* 'campaign_version_status_history|campaign_eligible_products|campaign_eligible_retailers|vendor_product_status_history|vendor_product_retailer_assignment')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_matching_%'),
  'Q22. neither reaches past its helpers into the underlying history or snapshot tables');


-- ============================================================================
-- SECTION R — MULTI-ITEM AGGREGATION
-- ============================================================================
-- Preconditions, so every negative below is known to fail on the intended rule rather
-- than on a campaign that was never targeted or never in force.
select is((select count(*)::integer from public.verified_sale_items i
           where i.verified_sale_id = pg_temp.id('cs_two')), 2,
  'R1. precondition: cs_two carries exactly two authoritative items');

select is((select m.candidate_result from public.campaign_versions_matching_sale(pg_temp.id('cs_two')) m
           where m.campaign_version_id = pg_temp.id('cc_ok')), 'CANDIDATE',
  'R2. precondition: CC Open is a genuine 66A candidate for cs_two');

-- ONE ELIGIBLE, ONE INELIGIBLE. The ineligible line contributes nothing and vetoes
-- nothing.
select is(pg_temp.res(pg_temp.id('cs_mix'), pg_temp.id('cc_ok')), 'QUALIFIED/-/1/4',
  'R3. one eligible and one ineligible item still QUALIFIES, counting only the eligible '
  'one and only its 4 units');

select is((select e.eligibility_result from public.campaign_sale_item_eligible_at(
             pg_temp.id('cc_ok'),
             (select i.id from public.verified_sale_items i
              where i.verified_sale_id = pg_temp.id('cs_mix')
                and i.vendor_product_id = pg_temp.id('c_p3'))) e), 'NOT_ELIGIBLE',
  'R4. ...and the uncounted line really was NOT_ELIGIBLE, not merely absent');

select is(pg_temp.res(pg_temp.id('cs_two'), pg_temp.id('cc_ok')), 'QUALIFIED/-/2/7',
  'R5. two eligible items give an exact count of 2 and the exact sum 4 + 3 = 7');

-- NOTHING ELIGIBLE.
select is(pg_temp.res(pg_temp.id('cs_none'), pg_temp.id('cc_ok')),
  'NOT_QUALIFIED/NO_QUALIFYING_ITEMS/0/0',
  'R6. every item decidable and none eligible is NOT_QUALIFIED / NO_QUALIFYING_ITEMS');

select is((select m.candidate_result from public.campaign_versions_matching_sale(pg_temp.id('cs_none')) m
           where m.campaign_version_id = pg_temp.id('cc_ok')), 'CANDIDATE',
  'R7. ...and R6 failed on its items, not because the campaign was omitted');

-- A REJECTED item set: an authoritative sale with zero authoritative items. Reachable,
-- legitimate, and vacuously NO_QUALIFYING_ITEMS rather than an error.
select is((select count(*)::integer from public.verified_sale_items i
           where i.verified_sale_id = pg_temp.id('cs_reject')), 0,
  'R8. precondition: a REJECTED proposal leaves an authoritative sale with no items');

select is(pg_temp.res(pg_temp.id('cs_reject'), pg_temp.id('cc_ok')),
  'NOT_QUALIFIED/NO_QUALIFYING_ITEMS/0/0',
  'R9. a sale with no authoritative items is NO_QUALIFYING_ITEMS, and does not raise');

-- ONE UNKNOWN ITEM POISONS THE CAMPAIGN, even though its neighbour is eligible.
select is(pg_temp.res(pg_temp.id('cs_poison'), pg_temp.id('cc_ok')),
  'NOT_EVALUABLE/NO_TEMPORAL_RECORD/0/0',
  'R10. one item with no temporal record makes the whole evaluation NOT_EVALUABLE');

select is((select e.eligibility_result from public.campaign_sale_item_eligible_at(
             pg_temp.id('cc_ok'),
             (select i.id from public.verified_sale_items i
              where i.verified_sale_id = pg_temp.id('cs_poison')
                and i.vendor_product_id = pg_temp.id('c_p1'))) e), 'ELIGIBLE',
  'R11. ...and the other item genuinely WAS eligible — missing history outranks it');

select is((select count(*)::integer from public.campaign_matching_qualified_items_for_sale(
             pg_temp.id('cs_poison'))
           where campaign_version_id = pg_temp.id('cc_ok')), 0,
  'R12. a poisoned evaluation contributes no qualifying items at all');

-- UNIT 66A SAID NOT_EVALUABLE. The items are not consulted, and the campaign result is
-- not upgraded by them. CC Gap's items are ALL eligible, so any implementation that let
-- item evidence overrule unknown campaign history would report QUALIFIED / 2 / 7 here.
select is((select m.candidate_result from public.campaign_versions_matching_sale(pg_temp.id('cs_two')) m
           where m.campaign_version_id = pg_temp.id('cc_gap')), 'NOT_EVALUABLE',
  'R13. precondition: Unit 66A calls CC Gap NOT_EVALUABLE for cs_two');

select is(pg_temp.res(pg_temp.id('cs_two'), pg_temp.id('cc_gap')),
  'NOT_EVALUABLE/NO_TEMPORAL_RECORD/0/0',
  'R14. unknown CAMPAIGN history stays NOT_EVALUABLE even though every item is eligible');

select is(pg_temp.res(pg_temp.id('cs_two'), pg_temp.id('cc_ok')), 'QUALIFIED/-/2/7',
  'R15. ...and the very same items DO qualify a campaign whose history is known');

-- Duplicate item rows are impossible by construction, and the resolver's own integrity
-- check would raise if 66B ever answered twice for one item.
select has_index('public', 'verified_sale_items', 'verified_sale_items_product_unique_idx',
  'R16. one product may appear at most once per authoritative sale');

select has_index('public', 'verified_sale_items', 'verified_sale_items_line_unique_idx',
  'R17. ...and one line number may appear at most once');

select ok(pg_temp.c_body('campaign_matching_result_for_sale') like '%count(distinct%',
  'R18. the resolver counts DISTINCT judged items, and raises when the total disagrees');

-- Outcome and reason are a closed, paired vocabulary across every campaign of every
-- Vendor C sale at once.
select ok((select bool_and(
             r.outcome in ('QUALIFIED','NOT_QUALIFIED','NOT_EVALUABLE')
             and ((r.outcome = 'QUALIFIED'     and r.non_qualification_reason is null)
               or (r.outcome = 'NOT_QUALIFIED' and r.non_qualification_reason
                     in ('NO_QUALIFYING_ITEMS','SUPPRESSED_BY_EXCLUSIVITY'))
               or (r.outcome = 'NOT_EVALUABLE' and r.non_qualification_reason = 'NO_TEMPORAL_RECORD')))
           from unnest(array[pg_temp.id('cs_mix'), pg_temp.id('cs_two'), pg_temp.id('cs_none'),
                             pg_temp.id('cs_poison'), pg_temp.id('cs_solo'), pg_temp.id('cs_reject')]) as sale,
                lateral public.campaign_matching_result_for_sale(sale) r),
  'R19. outcome and reason are paired from the approved vocabulary in every result');

select ok((select bool_and(r.outcome = 'QUALIFIED'
                           or (r.qualifying_item_count = 0 and r.qualifying_units = 0))
           from unnest(array[pg_temp.id('cs_mix'), pg_temp.id('cs_two'), pg_temp.id('cs_none'),
                             pg_temp.id('cs_poison'), pg_temp.id('cs_solo'), pg_temp.id('cs_reject')]) as sale,
                lateral public.campaign_matching_result_for_sale(sale) r),
  'R20. every result other than QUALIFIED reports zero items and zero units');

select ok((select bool_and(r.qualifying_item_count >= 1 and r.qualifying_units >= 1)
           from unnest(array[pg_temp.id('cs_mix'), pg_temp.id('cs_two')]) as sale,
                lateral public.campaign_matching_result_for_sale(sale) r
           where r.outcome = 'QUALIFIED'),
  'R21. ...and every QUALIFIED result reports at least one item and one unit');

-- Lineage still raises rather than producing NOT_EVALUABLE evidence.
select throws_ok('select * from public.campaign_matching_result_for_sale(null)',
  '22023', null, 'R22. a null sale id raises invalid_parameter_value');

select is(pg_temp.try_sql(format(
  'select * from public.campaign_matching_result_for_sale(%L)', gen_random_uuid())),
  'REFUSED:23503', 'R23. a missing verified sale raises foreign_key_violation');

-- The item helper needs its OWN guards: its query joins on p_verified_sale_id, so the
-- planner proves the join empty for a bad id and never executes the resolver whose
-- raises would otherwise fire. Without these, broken lineage would return an empty set
-- indistinguishable from "this sale matched nothing".
select throws_ok('select * from public.campaign_matching_qualified_items_for_sale(null)',
  '22023', null, 'R24. the item helper raises on a null sale id too');

select is(pg_temp.try_sql(format(
  'select * from public.campaign_matching_qualified_items_for_sale(%L)', gen_random_uuid())),
  'REFUSED:23503',
  'R25. ...and on a missing verified sale, rather than returning an empty result');


-- ============================================================================
-- SECTION S — STACKABLE
-- ============================================================================
select is((select cv.stacking_mode || '/' || coalesce(cv.exclusivity_key, '-')
           from public.campaign_versions cv where cv.id = pg_temp.id('cc_ok')), 'STACKABLE/-',
  'S1. precondition: CC Open is STACKABLE with no exclusivity key');

select is((select cv.stacking_mode || '/' || coalesce(cv.exclusivity_key, '-')
           from public.campaign_versions cv where cv.id = pg_temp.id('cc_snap')), 'STACKABLE/-',
  'S2. precondition: so is CC Snap');

select is(pg_temp.res(pg_temp.id('cs_two'), pg_temp.id('cc_ok')), 'QUALIFIED/-/2/7',
  'S3. two stackable campaigns both remain QUALIFIED — the open-scope one on 2 items');

select is(pg_temp.res(pg_temp.id('cs_two'), pg_temp.id('cc_snap')), 'QUALIFIED/-/1/3',
  'S4. ...and the frozen-scope one on its own single selected item');

select is(pg_temp.item_products(pg_temp.id('cs_two'), pg_temp.id('cc_snap')),
  array[pg_temp.id('c_p2')]::uuid[],
  'S5. each stackable campaign keeps its OWN item set, not a shared one');

select is(pg_temp.item_products(pg_temp.id('cs_two'), pg_temp.id('cc_ok')),
  array[pg_temp.id('c_p1'), pg_temp.id('c_p2')]::uuid[],
  'S6. ...and the open-scope campaign keeps both of its items, in line order');

-- Two STACKABLE campaigns sharing a key is impossible: campaign_versions_exclusivity_paired
-- makes a key equivalent to EXCLUSIVE, so NULL keys can never form one shared group.
select is((select count(*)::integer from public.campaign_versions cv
           where cv.stacking_mode = 'STACKABLE' and cv.exclusivity_key is not null), 0,
  'S7. a STACKABLE campaign can never carry an exclusivity key');

select ok(pg_temp.c_body('campaign_matching_result_for_sale') like '%k_stacking = ''exclusive''%',
  'S8. only EXCLUSIVE rows enter the suppression window');


-- ============================================================================
-- SECTION T — EXCLUSIVITY
-- ============================================================================
-- The fixture is deliberately adversarial: the HIGH-priority campaign matches FEWER
-- units and is worth ONE coin per unit, against a rival matching more units at 999.
select is((select cv.priority::text || '/' || cv.exclusivity_key
           from public.campaign_versions cv where cv.id = pg_temp.id('cx_hi')), '900/BUNDLE',
  'T1. precondition: CX High is priority 900 in key BUNDLE');

select is((select cv.priority::text || '/' || cv.exclusivity_key
           from public.campaign_versions cv where cv.id = pg_temp.id('cx_lo')), '100/BUNDLE',
  'T2. precondition: CX Low is priority 100 in the same key');

select ok((select (select r.coins_per_unit from public.campaign_rules r
                   where r.campaign_version_id = pg_temp.id('cx_lo') and r.sequence = 1)
         > (select r.coins_per_unit from public.campaign_rules r
                   where r.campaign_version_id = pg_temp.id('cx_hi') and r.sequence = 1)),
  'T3. precondition: the LOSER is worth far more per unit than the winner');

select is(pg_temp.res(pg_temp.id('cs_two'), pg_temp.id('cx_hi')), 'QUALIFIED/-/1/3',
  'T4. higher priority wins, keeping its own smaller item count and unit total');

select is(pg_temp.res(pg_temp.id('cs_two'), pg_temp.id('cx_lo')),
  'NOT_QUALIFIED/SUPPRESSED_BY_EXCLUSIVITY/0/0',
  'T5. the loser is SUPPRESSED_BY_EXCLUSIVITY with zero count and zero units — despite '
  'matching more units at a higher coin rate');

-- PRIORITY TIE -> EARLIER START.
select is(pg_temp.res(pg_temp.id('cs_two'), pg_temp.id('cx_te')), 'QUALIFIED/-/2/7',
  'T6. on a priority tie the earlier campaign_starts_at wins');

select is(pg_temp.res(pg_temp.id('cs_two'), pg_temp.id('cx_tl')),
  'NOT_QUALIFIED/SUPPRESSED_BY_EXCLUSIVITY/0/0',
  'T7. ...and the later-starting rival is suppressed');

select ok((select (select cv.priority from public.campaign_versions cv where cv.id = pg_temp.id('cx_te'))
                = (select cv.priority from public.campaign_versions cv where cv.id = pg_temp.id('cx_tl'))),
  'T8. ...and T6 really was decided on the start date, because the priorities are equal');

-- The inversion that makes T6 load-bearing: the id key points the OTHER way, so an
-- implementation that dropped campaign_starts_at would elect CX TieLate every run.
select ok(pg_temp.id('cx_tl') < pg_temp.id('cx_te'),
  'T8b. ...and the LATER-starting campaign holds the LOWER version id, so start date and '
  'id disagree and only the start date can produce T6''s answer');

-- PRIORITY AND START TIE -> LOWER VERSION ID. Which id is lower varies per run, so the
-- expected winner is computed rather than named.
select ok((select (select cv.starts_at from public.campaign_versions cv where cv.id = pg_temp.id('cx_ia'))
                = (select cv.starts_at from public.campaign_versions cv where cv.id = pg_temp.id('cx_ib'))),
  'T9. precondition: the TIEC pair shares a priority AND a start instant');

select is(pg_temp.res(pg_temp.id('cs_two'), least(pg_temp.id('cx_ia'), pg_temp.id('cx_ib'))),
  'QUALIFIED/-/2/7',
  'T10. with both keys tied, the LOWER campaign_version_id wins');

select is(pg_temp.res(pg_temp.id('cs_two'), greatest(pg_temp.id('cx_ia'), pg_temp.id('cx_ib'))),
  'NOT_QUALIFIED/SUPPRESSED_BY_EXCLUSIVITY/0/0',
  'T11. ...and the higher one is suppressed');

-- THREE KEYS, THREE WINNERS. Exclusivity partitions; it does not elect one campaign
-- per sale.
select is((select count(*)::integer from public.campaign_matching_result_for_sale(pg_temp.id('cs_two')) r
           where r.outcome = 'QUALIFIED' and r.stacking_mode = 'EXCLUSIVE'), 3,
  'T12. each of the three exclusivity keys produces exactly one winner');

select is((select coalesce(string_agg(distinct r.exclusivity_key, ',' order by r.exclusivity_key), 'NONE')
           from public.campaign_matching_result_for_sale(pg_temp.id('cs_two')) r
           where r.outcome = 'QUALIFIED' and r.stacking_mode = 'EXCLUSIVE'),
  'BUNDLE,TIEB,TIEC',
  'T13. ...and they are one winner per distinct key, not three from one key');

select is((select count(*)::integer from public.campaign_matching_result_for_sale(pg_temp.id('cs_two')) r
           where r.non_qualification_reason = 'SUPPRESSED_BY_EXCLUSIVITY'), 3,
  'T14. and exactly three losers were suppressed');

-- STACKABLE campaigns are untouched by any of it.
select is((select count(*)::integer from public.campaign_matching_result_for_sale(pg_temp.id('cs_two')) r
           where r.stacking_mode = 'STACKABLE' and r.outcome = 'QUALIFIED'), 2,
  'T15. both STACKABLE campaigns survive the exclusive contest untouched');

-- ANOTHER SALE RESOLVES INDEPENDENTLY, and a campaign that fails on its own items never
-- suppresses a rival. On cs_solo the high-priority campaign has nothing eligible, so the
-- key's winner is the low-priority one that does.
select is(pg_temp.res(pg_temp.id('cs_solo'), pg_temp.id('cx_hi')),
  'NOT_QUALIFIED/NO_QUALIFYING_ITEMS/0/0',
  'T16. on another sale the high-priority campaign qualifies for nothing...');

select is(pg_temp.res(pg_temp.id('cs_solo'), pg_temp.id('cx_lo')), 'QUALIFIED/-/1/4',
  'T17. ...so the low-priority rival wins that key there — losers never suppress');

select is(pg_temp.res(pg_temp.id('cs_two'), pg_temp.id('cx_lo')),
  'NOT_QUALIFIED/SUPPRESSED_BY_EXCLUSIVITY/0/0',
  'T18. ...while the same campaign is still suppressed on cs_two — per sale, not global');

-- REWARD VALUE IS NEVER CONSULTED, textually as well as behaviourally.
select ok(pg_temp.c_body('campaign_matching_result_for_sale')
            !~ 'campaign_rules|coins_per_unit|reward_coins|threshold_units|max_reward_coins|rule_type',
  'T19. the resolver names no reward rule, coin rate, threshold, cap or tier');

select ok(pg_temp.c_body('campaign_matching_result_for_sale')
            like '%partition by p.k_excl_key order by p.k_priority desc, p.k_starts_at asc, p.k_version_id asc%',
  'T20. the tie-break is exactly priority DESC, starts_at ASC, version_id ASC');

-- The window must not see qualifying_units or the item count.
select ok((select substring(pg_temp.c_body('campaign_matching_result_for_sale')
                    from position('partition by' in pg_temp.c_body('campaign_matching_result_for_sale'))
                    for 200) !~ 'p_units|p_count|qualifying_units|qualifying_item_count'),
  'T21. basket size is not part of the ordering — one campaign''s quantities cannot move '
  'another''s rank');


-- ============================================================================
-- SECTION U — THE QUALIFYING ITEM HELPER
-- ============================================================================
select is((select count(*)::integer from public.campaign_matching_qualified_items_for_sale(
             pg_temp.id('cs_two'))), 8,
  'U1. cs_two yields eight qualifying item rows: 1 + 2 + 2 + 1 + 2 across five winners');

select is((select coalesce(string_agg(distinct r.outcome, ','), 'NONE')
           from public.campaign_matching_result_for_sale(pg_temp.id('cs_two')) r
           where r.campaign_version_id in (
             select q.campaign_version_id
             from public.campaign_matching_qualified_items_for_sale(pg_temp.id('cs_two')) q)),
  'QUALIFIED',
  'U2. every campaign appearing in the item helper is finally QUALIFIED');

select is((select count(*)::integer from public.campaign_matching_qualified_items_for_sale(
             pg_temp.id('cs_two')) q where q.campaign_version_id = pg_temp.id('cx_lo')), 0,
  'U3. a SUPPRESSED_BY_EXCLUSIVITY loser contributes no item rows');

select is((select count(*)::integer from public.campaign_matching_qualified_items_for_sale(
             pg_temp.id('cs_two')) q where q.campaign_version_id = pg_temp.id('cc_gap')), 0,
  'U4. a NOT_EVALUABLE campaign contributes no item rows');

select is((select count(*)::integer from public.campaign_matching_qualified_items_for_sale(
             pg_temp.id('cs_none'))), 0,
  'U5. a sale whose every campaign is NO_QUALIFYING_ITEMS yields no item rows at all');

-- Exact identity and quantity, taken from the authoritative row.
select ok((select q.verified_sale_id = pg_temp.id('cs_mix')
             and q.verified_sale_item_id = (select i.id from public.verified_sale_items i
                                            where i.verified_sale_id = pg_temp.id('cs_mix')
                                              and i.vendor_product_id = pg_temp.id('c_p1'))
             and q.vendor_product_id = pg_temp.id('c_p1')
             and q.qualifying_units = 4
           from public.campaign_matching_qualified_items_for_sale(pg_temp.id('cs_mix')) q
           where q.campaign_version_id = pg_temp.id('cc_ok')),
  'U6. the row carries the exact sale, item, product and authoritative quantity');

select ok((select bool_and(q.qualifying_units = i.quantity)
           from public.campaign_matching_qualified_items_for_sale(pg_temp.id('cs_two')) q
           join public.verified_sale_items i on i.id = q.verified_sale_item_id),
  'U7. every returned quantity equals the authoritative item quantity');

select ok((select bool_and(q.campaign_version_id <> pg_temp.id('cc_ok')
                           or q.vendor_product_id <> pg_temp.id('c_p3'))
           from public.campaign_matching_qualified_items_for_sale(pg_temp.id('cs_mix')) q),
  'U8. the ineligible line of a qualified campaign is not returned');

-- SNAPSHOT evidence is null; LIVE_TEMPORAL evidence carries the sale-time statuses.
select is((select q.product_source || '/' || coalesce(q.product_status_at_sale, '-') || '/'
                || coalesce(q.assignment_status_at_sale, '-')
           from public.campaign_matching_qualified_items_for_sale(pg_temp.id('cs_two')) q
           where q.campaign_version_id = pg_temp.id('cc_snap')), 'SNAPSHOT/-/-',
  'U9. a frozen-scope campaign returns SNAPSHOT evidence with null sale-time statuses');

select is((select coalesce(string_agg(distinct q.product_source || '/' || q.product_status_at_sale
                    || '/' || q.assignment_status_at_sale, ','), 'NONE')
           from public.campaign_matching_qualified_items_for_sale(pg_temp.id('cs_two')) q
           where q.campaign_version_id = pg_temp.id('cc_ok')),
  'LIVE_TEMPORAL/ACTIVE/ACTIVE',
  'U10. an open-scope campaign returns the sale-time product and assignment statuses');

-- Migration 65's live_evidence_paired CHECK is exactly this pairing, so the evidence
-- writer can insert these rows unchanged.
select ok((select bool_and((q.product_source = 'LIVE_TEMPORAL') = (q.product_status_at_sale is not null))
           from public.campaign_matching_qualified_items_for_sale(pg_temp.id('cs_two')) q),
  'U11. source and evidence are paired exactly as campaign_sale_item_qualifications '
  'requires');

select is((select count(*)::integer from (
             select q.campaign_version_id, q.verified_sale_item_id
             from public.campaign_matching_qualified_items_for_sale(pg_temp.id('cs_two')) q
             group by 1, 2 having count(*) > 1) d), 0,
  'U12. no (campaign, item) pair is returned twice');

select ok((select bool_and(q.qualifying_units >= 1)
           from public.campaign_matching_qualified_items_for_sale(pg_temp.id('cs_two')) q),
  'U13. every returned item counts at least one unit — no zero rows leak through');

-- The counts the resolver reported ARE the rows this helper returns. If they ever
-- disagreed, the evidence writer would insert a total that its own items contradict.
select ok((select bool_and(r.qualifying_item_count = k.n and r.qualifying_units = k.u)
           from public.campaign_matching_result_for_sale(pg_temp.id('cs_two')) r
           cross join lateral (
             select count(*)::integer as n, coalesce(sum(q.qualifying_units), 0)::integer as u
             from public.campaign_matching_qualified_items_for_sale(pg_temp.id('cs_two')) q
             where q.campaign_version_id = r.campaign_version_id) k
           where r.outcome = 'QUALIFIED'),
  'U14. the resolver''s counts and units reconcile exactly with the item rows');

select ok((select count(*)::integer from information_schema.columns
           where table_schema = 'public' and table_name = 'x') = 0
       and (select pg_get_function_result(p.oid) from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'campaign_matching_qualified_items_for_sale')
           !~ 'product_name|product_code|barcode|brand|json|jsonb',
  'U15. no mutable product display field and no JSON is returned');


-- ============================================================================
-- SECTION V — DETERMINISM AND BOUNDARIES
-- ============================================================================
select is(pg_temp.res_order(pg_temp.id('cs_two')),
  array[pg_temp.id('cx_hi'), pg_temp.id('cx_te'), pg_temp.id('cx_tl'),
        least(pg_temp.id('cx_ia'), pg_temp.id('cx_ib')),
        greatest(pg_temp.id('cx_ia'), pg_temp.id('cx_ib')),
        pg_temp.id('cx_lo'), pg_temp.id('cc_gap'), pg_temp.id('cc_snap'),
        pg_temp.id('cc_ok')]::uuid[],
  'V1. campaign results arrive in priority DESC, starts_at ASC, version_id ASC order');

select is(pg_temp.item_products(pg_temp.id('cs_two'), pg_temp.id('cx_te')),
  array[pg_temp.id('c_p1'), pg_temp.id('c_p2')]::uuid[],
  'V2. a campaign''s item rows arrive in sale-item line order');

select is(pg_temp.res_digest(pg_temp.id('cs_two')), pg_temp.res_digest(pg_temp.id('cs_two')),
  'V3. two calls for one sale return byte-equivalent ordered campaign results');

select is(pg_temp.items_digest(pg_temp.id('cs_two')), pg_temp.items_digest(pg_temp.id('cs_two')),
  'V4. two calls return byte-equivalent ordered item results');

-- Units 66A and 66B are untouched by this unit. If either body changed, that is a
-- different unit's work and needs its own approval — not a hash quietly refreshed here.
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_versions_matching_sale'),
  '4e20cce64647395974fa8da490c55c20',
  'V5. Unit 66A''s body is byte-for-byte what it was when it was approved');

select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'),
  'bcaf88024d3cc06dbae6dc46670a2906',
  'V6. Unit 66B''s body is byte-for-byte what it was when it was approved');

-- Nothing was written, by anything, anywhere in this suite.
select is((select count(*)::integer from public.campaign_sale_evaluations), 0,
  'V7. no evaluation evidence exists');
select is((select count(*)::integer from public.campaign_sale_item_qualifications), 0,
  'V8. no item qualification evidence exists');
select is((select count(*)::integer from public.campaign_rewards), 0,
  'V9. no reward evidence exists');
select is((select count(*)::integer from public.campaign_subject_accumulators), 0,
  'V10. no accumulator row exists');

select is((select count(*)::integer from information_schema.tables where table_schema='public'
           and (table_name like '%coin%' or table_name like '%ledger%' or table_name like '%wallet%'
             or table_name like '%balance%' or table_name like '%payout%' or table_name like '%redemption%')), 0,
  'V11. still no coin, ledger, wallet, balance, payout or redemption object');

-- NARROWED FOR PHASE 2A-C: campaign_apply_reward_for_evaluation was created by approval
-- in migration 20260825090000 and is the ONE function permitted to lock and maintain the
-- accumulator. It is named exactly, so any other function reaching that table — including
-- either of Unit 66C's, which is what this assertion was written to protect — still
-- fails. Its own suite proves the pure calculation does not read the table at all.
select is((select coalesce(string_agg(p.proname, ',' order by p.proname), 'NONE')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosrc ~* 'campaign_subject_accumulators'
             and p.prorettype <> 'trigger'::regtype),
  'campaign_apply_reward_for_evaluation',
  'V12. the approved Migration 67 applier is the only non-trigger function that touches '
  'the accumulator table');

-- CURRENT STATE CANNOT MOVE A HISTORICAL RESULT. Deactivating the Retailer, its Sales
-- Staff member and the trading relationship changes nothing, because none of them is a
-- temporal source: 66A reads the frozen retailer snapshot and the status timeline, 66B
-- reads the two product timelines, and 66C reads neither directly.
insert into pg_temp.snap values
  ('cs_two_res',   pg_temp.res_digest(pg_temp.id('cs_two'))),
  ('cs_two_items', pg_temp.items_digest(pg_temp.id('cs_two')));

do $$
begin
  update public.organizations set status = 'DEACTIVATED' where id = pg_temp.id('retailer_c');
  update public.profiles      set status = 'DEACTIVATED' where id = pg_temp.id('staffc');
  update public.vendor_retailers set status = 'DEACTIVATED'
   where vendor_organization_id = pg_temp.id('vendor_c')
     and retailer_organization_id = pg_temp.id('retailer_c');
end;
$$;

select is(pg_temp.res_digest(pg_temp.id('cs_two')),
          (select v from pg_temp.snap where k = 'cs_two_res'),
  'V13. deactivating the Retailer, the Sales Staff member and the trading relationship '
  'leaves the campaign result identical');

select is(pg_temp.items_digest(pg_temp.id('cs_two')),
          (select v from pg_temp.snap where k = 'cs_two_items'),
  'V14. ...and leaves the qualifying item rows identical');


select * from finish();
rollback;
