-- Tests for Phase 2A-B, Migration 66.
--
--   Unit 66A  public.campaign_versions_matching_sale(uuid)          Sections A-I
--   Unit 66B  public.campaign_sale_item_eligible_at(uuid, uuid)     Sections J-P
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
  'B1. Unit 66C/67/68 function does not exist yet: ' || f)
from unnest(array[
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
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = f), 0,
  'K1. Unit 66C/67/68 function still does not exist: ' || f)
from unnest(array[
  'campaign_matching_result_for_sale',
  'campaign_sale_items_eligible_at',
  'campaign_sale_qualifying_units',
  'campaign_sale_exclusive_winner',
  'evaluate_sale_campaign_qualification',
  'award_campaign_reward'
]) as f;

select is(
  (select coalesce(string_agg(p.proname, ',' order by p.proname), 'NONE')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'campaign_%'
     and p.prorettype <> 'trigger'::regtype
     and p.proname in ('campaign_versions_matching_sale','campaign_sale_item_eligible_at')),
  'campaign_sale_item_eligible_at,campaign_versions_matching_sale',
  'K2. both Migration 66 resolvers exist, and they are the two that were approved');

select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'campaign_%'
             and p.prosrc ~* '(insert|update|delete)\s+(into\s+)?public\.campaign_(sale|reward|subject)'), 0,
  'K3. still no campaign function writes to the Migration 65 evidence tables');


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
             and p.proname in ('campaign_versions_matching_sale','campaign_sale_item_eligible_at')
             and p.prosrc ~* 'vendor_retailer_eligible_products_at|vendor_product_eligible_for_retailer_at'), 0,
  'O13. neither Migration 66 resolver touches either unsafe composite helper');


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


select * from finish();
rollback;
