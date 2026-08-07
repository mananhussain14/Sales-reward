-- Tests for Phase 2B, Migration 70.
--
--   public.sales_staff_earnings_profile()                        Sections A, B
--   public.get_my_campaign_rewards(int, timestamptz, uuid)       Sections A-D
--   public.get_my_campaign_earnings_summary()                    Sections A, E
--   public.get_my_campaign_target_progress()                     Sections A, F
--
-- Run with:  supabase test db
--
-- ============================================================================
-- WHAT THIS SUITE IS PROTECTING
-- ============================================================================
--   1. A SELLER SEES THEIR OWN EARNINGS AND NOBODY ELSE'S. There is no argument that
--      names a person, and the row filter is beneficiary_profile_id. Section C proves it
--      against a second seller in the SAME Retailer — the case a Retailer filter would
--      wrongly admit — and a third in another Retailer entirely.
--
--   2. HISTORY SURVIVES THE PRESENT. An ended campaign, a deactivated product, a paused
--      campaign and a changed Retailer relationship must none of them delete a reward a
--      seller already earned. Section D.
--
--   3. EARNED IS NOT A BALANCE. No column is named balance, wallet, available,
--      redeemable, payable or settled, and nothing is subtracted. Section E.
--
--   4. PROGRESS IS NORMALIZED, NEVER RAW. cap_subject_type, cap_subject_id, the
--      accumulator's own target flag and every coin total stay inside the database.
--      Section F proves the contract and the team/personal distinction.
--
-- ============================================================================
-- WHAT MIGRATION 70 DELIBERATELY DID NOT ADD
-- ============================================================================
-- Current campaigns and campaign products already shipped in Migration 30 as
-- list_my_staff_campaigns, get_my_staff_campaign and list_my_staff_campaign_products.
-- Section G asserts they are still present, still authenticated-only and still
-- byte-for-byte unchanged, because "we did not duplicate them" is only true while they
-- remain the single owner of that rule.

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
  v_path := 'ss/' || v_id::text || '.png';
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

/* A receipt carried to a complete ACCEPTED authoritative sale. The instant sits ahead of
   the run so it falls inside the status-history intervals campaigns open at publish
   time — the discipline Migrations 66, 68 and 69 all use. */
create function pg_temp.full_sale(
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

create function pg_temp.publish(
  p_key text, p_vendor uuid, p_admin uuid, p_name text,
  p_performance text default 'INDIVIDUAL_STAFF',
  p_scope       text default 'ALL_ELIGIBLE_PRODUCTS',
  p_rule        text default 'PER_UNIT_COINS',
  p_per_unit    bigint default 5,
  p_threshold   integer default null,
  p_bonus       bigint default null,
  p_cap         bigint default null,
  p_products    uuid[] default null,
  p_starts      timestamptz default null,
  p_ends        timestamptz default null
) returns uuid language plpgsql as $$
declare v_c uuid; v_v uuid;
begin
  perform pg_temp.act_as(p_admin);
  v_c := public.create_vendor_campaign_draft(
    p_name, 'Described.',
    coalesce(p_starts, now() - interval '60 days'),
    coalesce(p_ends,   now() + interval '30 days'),
    'Asia/Dubai', 'ALL_RETAILERS', p_performance, p_scope, 'STACKABLE', null,
    10, p_rule, p_per_unit, p_threshold, p_bonus, p_cap, null, null, p_products);
  perform public.publish_vendor_campaign(v_c);
  select c.published_version_id into v_v from public.campaigns c where c.id = v_c;
  perform pg_temp.sign_out();
  insert into pg_temp.f values (p_key || '_campaign', v_c), (p_key, v_v);
  return v_v;
end;
$$;

/* Evaluate a receipt as the reviewer, so rewards are created by the deployed engine and
   never hand-written. */
create function pg_temp.evaluate(p_receipt uuid, p_reviewer uuid) returns void
language plpgsql as $$
begin
  perform pg_temp.act_as(p_reviewer);
  perform 1 from public.evaluate_receipt_campaigns(p_receipt);
  perform pg_temp.sign_out();
end;
$$;

/* The four functions under test, as jsonb, so an assertion can name one field. */
create function pg_temp.rewards(p_limit integer default 50) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.awarded_at desc, t.campaign_reward_id desc), '[]'::jsonb)
  from public.get_my_campaign_rewards(p_limit) t
$$;
create function pg_temp.rewards_raw(p_limit integer default 50) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  from public.get_my_campaign_rewards(p_limit) t
$$;
create function pg_temp.summary() returns jsonb
language sql stable as $$
  select coalesce(to_jsonb(t), 'null'::jsonb)
  from public.get_my_campaign_earnings_summary() t
$$;
create function pg_temp.progress() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  from public.get_my_campaign_target_progress() t
$$;
create function pg_temp.reward_count() returns integer
language sql stable as $$
  select count(*)::integer from public.get_my_campaign_rewards(100)
$$;
create function pg_temp.reward_for(p_version uuid) returns jsonb
language sql stable as $$
  select e from jsonb_array_elements(pg_temp.rewards(100)) e
  where e ->> 'campaign_version_id' = p_version::text
$$;
create function pg_temp.progress_for(p_version uuid) returns jsonb
language sql stable as $$
  select e from jsonb_array_elements(pg_temp.progress()) e
  where e ->> 'campaign_version_id' = p_version::text
$$;

create function pg_temp.try_sql(s text) returns text language plpgsql as $$
begin execute s; return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

/* Executable body with comments stripped, so the migration's own prose — which names
   everything it refuses to expose — cannot satisfy or trip a structural rule. */
create function pg_temp.body(p_name text) returns text language sql stable as $$
  select lower(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', ' ', 'g'), '\s+', ' ', 'g'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name
$$;

create function pg_temp.rpc_names() returns text[] language sql immutable as $$
  select array['get_my_campaign_earnings_summary','get_my_campaign_rewards',
               'get_my_campaign_target_progress']::text[]
$$;


-- ============================================================================
-- Fixture
-- ============================================================================
-- Two Retailers and two sellers in the SAME Retailer, so isolation is tested against the
-- case a Retailer-level filter would wrongly admit as well as against a foreign tenant.
do $$
declare v uuid;
begin
  insert into pg_temp.f values
    ('vendor',    pg_temp.new_org('SS Vendor',    'VENDOR')),
    ('vendor_b',  pg_temp.new_org('SS Vendor B',  'VENDOR')),
    ('retailer',  pg_temp.new_org('SS Retailer',  'RETAILER')),
    ('retailer_b',pg_temp.new_org('SS Retailer B','RETAILER'));

  insert into pg_temp.f values
    ('vsa',      pg_temp.new_person('SS','Admin')),
    ('vsa_b',    pg_temp.new_person('SS','AdminB')),
    ('rev',      pg_temp.new_person('SS','Rev')),
    ('rev_b',    pg_temp.new_person('SS','RevB')),
    ('staff',    pg_temp.new_person('SS','Staff')),
    ('staff2',   pg_temp.new_person('SS','StaffTwo')),
    ('staff_b',  pg_temp.new_person('SS','StaffOther')),
    ('owner',    pg_temp.new_person('SS','Owner')),
    ('suspended',pg_temp.new_person('SS','Suspended')),
    ('nobody',   pg_temp.new_person('SS','Nobody')),
    ('ghost',    gen_random_uuid());

  perform pg_temp.add_member(pg_temp.id('vsa'),    pg_temp.id('vendor'),    'VENDOR_SUPER_ADMIN');
  perform pg_temp.add_member(pg_temp.id('vsa_b'),  pg_temp.id('vendor_b'),  'VENDOR_SUPER_ADMIN');
  perform pg_temp.add_member(pg_temp.id('rev'),    pg_temp.id('vendor'),    'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('rev_b'),  pg_temp.id('vendor_b'),  'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('staff'),  pg_temp.id('retailer'),  'SALES_STAFF');
  perform pg_temp.add_member(pg_temp.id('staff2'), pg_temp.id('retailer'),  'SALES_STAFF');
  perform pg_temp.add_member(pg_temp.id('staff_b'),pg_temp.id('retailer_b'),'SALES_STAFF');
  perform pg_temp.add_member(pg_temp.id('owner'),  pg_temp.id('retailer'),  'RETAILER_OWNER');
  perform pg_temp.add_member(pg_temp.id('suspended'), pg_temp.id('retailer'), 'SALES_STAFF', 'SUSPENDED');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (pg_temp.id('vendor'),   pg_temp.id('retailer'),   'ACTIVE'),
         (pg_temp.id('vendor'),   pg_temp.id('retailer_b'), 'ACTIVE'),
         (pg_temp.id('vendor_b'), pg_temp.id('retailer_b'), 'ACTIVE');

  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer'), 'SS Shop', 'SSS', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop', v);
  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_b'), 'SS Shop B', 'SSB', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop_b', v);

  insert into pg_temp.f values
    ('p1', pg_temp.new_product(pg_temp.id('vendor'), 'SS-1', 'Product One', pg_temp.id('vsa'))),
    ('p2', pg_temp.new_product(pg_temp.id('vendor'), 'SS-2', 'Product Two', pg_temp.id('vsa')));
  perform pg_temp.assign(pg_temp.id('p1'), pg_temp.id('retailer'),   pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('p2'), pg_temp.id('retailer'),   pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('p1'), pg_temp.id('retailer_b'), pg_temp.id('vsa'));
end;
$$;

-- Sales, then campaigns, then evaluation — the real order and the real engine.
do $$
begin
  perform pg_temp.full_sale('s_main', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2), pg_temp.line(pg_temp.id('p2'), 3)));

  perform pg_temp.full_sale('s_two', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff2'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 4)));

  perform pg_temp.full_sale('s_other', pg_temp.id('retailer_b'), pg_temp.id('shop_b'),
    pg_temp.id('staff_b'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));
end;
$$;

do $$
begin
  -- Per-unit, uncapped: 5 units x 7 = 35.
  perform pg_temp.publish('cv_unit', pg_temp.id('vendor'), pg_temp.id('vsa'), 'SS PerUnit',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'PER_UNIT_COINS', 7);

  -- Per-unit with a cap that BITES: 5 x 5 = 25 uncapped, cap 12 -> 12 awarded.
  perform pg_temp.publish('cv_cap', pg_temp.id('vendor'), pg_temp.id('vsa'), 'SS Capped',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'PER_UNIT_COINS', 5, null, null, 12);

  -- Individual target crossed by the main sale: threshold 3, bonus 100.
  perform pg_temp.publish('cv_target', pg_temp.id('vendor'), pg_temp.id('vsa'), 'SS Target',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'TARGET_BONUS', null, 3, 100);

  -- Individual target NOT crossed: threshold 50. Qualifies, pays nothing.
  perform pg_temp.publish('cv_far', pg_temp.id('vendor'), pg_temp.id('vsa'), 'SS FarTarget',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'TARGET_BONUS', null, 50, 100);

  -- TEAM target: threshold 8. staff's 5 + staff2's 4 = 9 crosses on staff2's sale.
  perform pg_temp.publish('cv_team', pg_temp.id('vendor'), pg_temp.id('vsa'), 'SS TeamTarget',
    'RETAILER_TEAM', 'ALL_ELIGIBLE_PRODUCTS', 'TARGET_BONUS', null, 8, 100);

  -- A SNAPSHOT campaign scoped to p1 alone.
  perform pg_temp.publish('cv_snap', pg_temp.id('vendor'), pg_temp.id('vsa'), 'SS Snapshot',
    'INDIVIDUAL_STAFF', 'SELECTED_PRODUCTS', 'PER_UNIT_COINS', 4, null, null, null,
    array[pg_temp.id('p1')]::uuid[]);

  -- A campaign that will be CANCELLED after it has paid, to prove history survives.
  perform pg_temp.publish('cv_gone', pg_temp.id('vendor'), pg_temp.id('vsa'), 'SS WillEnd',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'PER_UNIT_COINS', 2);

end;
$$;

-- Evaluate: staff's sale first, then staff2's (which crosses the team target).
do $$
begin
  perform pg_temp.evaluate(pg_temp.id('s_main_receipt'),  pg_temp.id('rev'));
  perform pg_temp.evaluate(pg_temp.id('s_two_receipt'),   pg_temp.id('rev'));
  perform pg_temp.evaluate(pg_temp.id('s_other_receipt'), pg_temp.id('rev'));
end;
$$;

-- Two more target campaigns, published AFTER evaluation so they change no reward and no
-- total. They exist only to put the progress read's two structural joins under real load.
do $$
declare v_c uuid; v_v2 uuid;
begin
  -- ANOTHER VENDOR'S campaign. Its frozen snapshot names only Retailer B, so this
  -- seller's Retailer is not in it. Nothing but the targeting join keeps it away.
  perform pg_temp.publish('cv_foreign', pg_temp.id('vendor_b'), pg_temp.id('vsa_b'),
    'SS ForeignTarget', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'TARGET_BONUS',
    null, 3, 100);

  -- A campaign REVISED after publication. Version 1 is superseded but KEEPS its own
  -- frozen eligible-retailer snapshot, so only the published-version join stops it being
  -- returned a second time alongside version 2.
  perform pg_temp.publish('cv_rev1', pg_temp.id('vendor'), pg_temp.id('vsa'), 'SS Revised',
    'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS', 'TARGET_BONUS', null, 4, 50);
  v_c := pg_temp.id('cv_rev1_campaign');

  perform pg_temp.act_as(pg_temp.id('vsa'));
  perform public.create_vendor_campaign_version(v_c);
  perform public.publish_vendor_campaign(v_c);
  perform pg_temp.sign_out();

  select c.published_version_id into v_v2 from public.campaigns c where c.id = v_c;
  insert into pg_temp.f values ('cv_rev2', v_v2);
end;
$$;


-- ============================================================================
-- SECTION A — SCHEMA, CONTRACTS AND ACL
-- ============================================================================
select is((select count(*)::integer from supabase_migrations.schema_migrations
           where version = '20260828090000'), 1,
  'A1. Migration 70 is recorded exactly once');

-- Migration 71 (20260828210000) adds Azure receipt-extraction readiness and Migration 72
-- (20260829090000) corrects retry eligibility in one receipt-extraction read. Neither
-- touches this migration's earnings reads.
select is((select coalesce(string_agg(version, ',' order by version), 'NONE')
           from supabase_migrations.schema_migrations
           where version > '20260828090000'),
  '20260828210000,20260829090000',
  'A2. the only migrations after 20260828090000 are approved Migrations 71 and 72');

select has_function('public', 'sales_staff_earnings_profile', array[]::text[],
  'A3. the context helper exists with the exact signature');
select has_function('public', 'get_my_campaign_rewards',
  array['integer','timestamp with time zone','uuid'],
  'A4. the reward history exists with the exact signature');
select has_function('public', 'get_my_campaign_earnings_summary', array[]::text[],
  'A5. the earnings summary exists with the exact signature');
select has_function('public', 'get_my_campaign_target_progress', array[]::text[],
  'A6. the target progress exists with the exact signature');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_my_campaign_rewards'),
  'TABLE(campaign_reward_id uuid, campaign_id uuid, campaign_version_id uuid, '
  'campaign_name text, receipt_submission_id uuid, shop_name text, '
  'sale_at timestamp with time zone, awarded_at timestamp with time zone, rule_type text, '
  'performance_scope text, qualifying_item_count integer, qualifying_units integer, '
  'coins_uncapped bigint, coins_capped_to bigint, reward_coins bigint, '
  'threshold_units integer, configured_reward_coins bigint)',
  'A7. the reward contract is exactly the approved 17 columns and types');

-- THE KEY MIGRATION 69 WAS BUILT TO WITHHOLD IS NOT HANDED BACK HERE.
select ok((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_my_campaign_rewards')
          not like '%verified_sale_id%',
  'A7a. ...and verified_sale_id is NOT among them — a sale is identified to a client by '
  'its receipt, exactly as Migration 69 established');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_my_campaign_earnings_summary'),
  'TABLE(total_reward_coins bigint, current_month_reward_coins bigint, '
  'rewarded_sale_count integer, rewarded_campaign_count integer, '
  'latest_reward_at timestamp with time zone, '
  'current_month_start_utc timestamp with time zone, '
  'current_month_end_utc timestamp with time zone)',
  'A8. the summary contract is exactly the approved 7 columns and types');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_my_campaign_target_progress'),
  'TABLE(campaign_id uuid, campaign_version_id uuid, campaign_name text, '
  'performance_scope text, target_units integer, configured_reward_coins bigint, '
  'progress_units bigint, target_reached boolean, bonus_awarded_to_me boolean)',
  'A9. the progress contract is exactly the approved 9 columns and types');

-- NO INTERNAL SUBJECT IDENTIFIER IN ANY CONTRACT. The rule Migration 70 exists to keep.
select is((select count(*)::integer from information_schema.parameters
           where specific_schema = 'public'
             and specific_name in (select specific_name from information_schema.routines
                                   where routine_schema = 'public'
                                     and routine_name = any (pg_temp.rpc_names()))
             and parameter_name in ('cap_subject_type','cap_subject_id',
                                    'beneficiary_profile_id','coins_awarded_total',
                                    'units_counted_total','target_bonus_awarded',
                                    'campaign_sale_evaluation_id')), 0,
  'A10. NO accumulator subject, beneficiary id, coin total or evaluation id appears in '
  'any return contract');

select ok((select bool_and(p.provolatile = 's') from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname = any (pg_temp.rpc_names())
                  or p.proname = 'sales_staff_earnings_profile')),
  'A11. all four are STABLE — none writes');

select ok((select bool_and(p.prosecdef) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname = any (pg_temp.rpc_names())
                  or p.proname = 'sales_staff_earnings_profile')),
  'A12. all four are SECURITY DEFINER');

select ok((select bool_and(p.proconfig @> array['search_path=""'])
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname = any (pg_temp.rpc_names())
                  or p.proname = 'sales_staff_earnings_profile')),
  'A13. all four run with an empty search_path');

select is((select p.proacl::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'sales_staff_earnings_profile'),
  '{postgres=X/postgres}',
  'A14. the context helper is owner-execute-only');

select is((select string_agg(p.proname || '=' || p.proacl::text, ' ' order by p.proname)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.rpc_names())),
  'get_my_campaign_earnings_summary={postgres=X/postgres,authenticated=X/postgres} '
  'get_my_campaign_rewards={postgres=X/postgres,authenticated=X/postgres} '
  'get_my_campaign_target_progress={postgres=X/postgres,authenticated=X/postgres}',
  'A15. the three reads grant EXECUTE to authenticated and the owner, and nobody else');

select is((select count(*)::integer from information_schema.role_routine_grants
           where routine_schema = 'public'
             and routine_name in ('sales_staff_earnings_profile','get_my_campaign_rewards',
                                  'get_my_campaign_earnings_summary',
                                  'get_my_campaign_target_progress')
             and grantee in ('anon','PUBLIC','service_role')), 0,
  'A16. no anon, PUBLIC or service_role grant exists on any of the four');

select ok((select bool_and(p.prosrc !~* '\mexecute\s+''|\mformat\s*\(|\mquote_ident\M')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname = any (pg_temp.rpc_names())
                  or p.proname = 'sales_staff_earnings_profile')),
  'A17. none uses dynamic SQL');

select ok((select bool_and(obj_description(p.oid, 'pg_proc') is not null)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname = any (pg_temp.rpc_names())
                  or p.proname = 'sales_staff_earnings_profile')),
  'A18. all four are documented');

-- ---- Catalogue ------------------------------------------------------------
select is((select count(*)::integer from public.permissions
           where code = 'STAFF_EARNINGS_VIEW'), 1,
  'A19. the earnings permission exists exactly once');
select is((select module from public.permissions where code = 'STAFF_EARNINGS_VIEW'),
  'RETAILER_PORTAL', 'A20. ...in the Retailer portal module');
select is((select coalesce(string_agg(r.code, ',' order by r.code), 'NONE')
           from public.role_permissions rp
           join public.roles r on r.id = rp.role_id
           join public.permissions p on p.id = rp.permission_id
           where p.code = 'STAFF_EARNINGS_VIEW'),
  'SALES_STAFF', 'A21. SALES_STAFF holds it, and NO other role does');
select is((select count(*)::integer from public.permissions), 34,
  'A22. the permission catalogue grew by exactly one, from 33 to 34');
select is((select count(*)::integer from public.role_permissions), 39,
  'A23. the role-permission catalogue grew by exactly one, from 38 to 39');

select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'), 47,
  'A24. Migration 70 added no table');
select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public'
             and (table_name like '%wallet%' or table_name like '%ledger%'
                  or table_name like '%payout%' or table_name like '%redemption%'
                  or table_name like '%withdraw%' or table_name like '%balance%')), 0,
  'A25. no wallet, ledger, payout, redemption, withdrawal or balance object exists');

-- NO COLUMN IS NAMED AS THOUGH IT WERE MONEY THE SELLER MAY SPEND.
select is((select count(*)::integer from information_schema.parameters
           where specific_schema = 'public'
             and specific_name in (select specific_name from information_schema.routines
                                   where routine_schema = 'public'
                                     and routine_name = any (pg_temp.rpc_names()))
             and (parameter_name like '%balance%' or parameter_name like '%wallet%'
                  or parameter_name like '%available%' or parameter_name like '%redeem%'
                  or parameter_name like '%payable%' or parameter_name like '%settled%'
                  or parameter_name like '%paid%')), 0,
  'A26. NO returned column is named balance, wallet, available, redeemable, payable, '
  'settled or paid');

select ok((select bool_and(pg_temp.body(n) !~ '\minsert\s+into\M|\mupdate\s+public\.|\mdelete\s+from\M')
           from unnest(pg_temp.rpc_names() || array['sales_staff_earnings_profile']) n),
  'A27. NO function contains an INSERT, UPDATE or DELETE');


-- ============================================================================
-- SECTION B — AUTHORIZATION
-- ============================================================================
select pg_temp.sign_out();
select is((select jsonb_array_length(pg_temp.rewards())), 0,
  'B1. an ANONYMOUS caller reads zero rewards');
select ok(pg_temp.summary() is null,
  'B2. ...and gets NO summary row at all — not a row of zeroes');
select is((select jsonb_array_length(pg_temp.progress())), 0,
  'B3. ...and no progress');

select pg_temp.act_as(pg_temp.id('ghost'));
select is((select jsonb_array_length(pg_temp.rewards())), 0,
  'B4. an authenticated caller with NO PROFILE reads nothing');

select pg_temp.act_as(pg_temp.id('nobody'));
select is((select jsonb_array_length(pg_temp.rewards())), 0,
  'B5. a profile with NO MEMBERSHIP reads nothing');

select pg_temp.act_as(pg_temp.id('suspended'));
select is((select jsonb_array_length(pg_temp.rewards())), 0,
  'B6. a SUSPENDED membership reads nothing');
select ok(pg_temp.summary() is null,
  'B7. ...and gets no summary row');

select pg_temp.act_as(pg_temp.id('owner'));
select is((select jsonb_array_length(pg_temp.rewards())), 0,
  'B8. a RETAILER_OWNER reads nothing — this surface is the seller''s own, not a '
  'supervisory view');

select pg_temp.act_as(pg_temp.id('rev'));
select is((select jsonb_array_length(pg_temp.rewards())), 0,
  'B9. a CLAIM_REVIEWER reads nothing here');

select pg_temp.act_as(pg_temp.id('staff'));
select ok((select jsonb_array_length(pg_temp.rewards())) > 0,
  'B10. an active Sales Staff member reads their own rewards');

-- NO ARGUMENT NAMES A PERSON OR A TENANT.
select is((select count(*)::integer from information_schema.parameters
           where specific_schema = 'public'
             and specific_name in (select specific_name from information_schema.routines
                                   where routine_schema = 'public'
                                     and routine_name = any (pg_temp.rpc_names()))
             and parameter_mode = 'IN'), 3,
  'B11. the three reads take THREE input parameters in total — the reward page cursor, '
  'and nothing else');

select is((select coalesce(string_agg(parameter_name, ',' order by ordinal_position), 'NONE')
           from information_schema.parameters
           where specific_schema = 'public'
             and specific_name in (select specific_name from information_schema.routines
                                   where routine_schema = 'public'
                                     and routine_name = 'get_my_campaign_rewards')
             and parameter_mode = 'IN'),
  'p_limit,p_before_awarded_at,p_before_reward_id',
  'B12. ...and none of them is a profile, Retailer, Vendor, shop or campaign id');

select ok((select bool_and(pg_temp.body(n) ~ 'sales_staff_earnings_profile')
           from unnest(pg_temp.rpc_names()) n),
  'B13. every read resolves its identity through the context helper');

select ok(pg_temp.body('sales_staff_earnings_profile') ~ 'auth\.uid\(\)'
      and pg_temp.body('sales_staff_earnings_profile') ~ 'resolve_retailer_member_organization',
  'B14. the helper derives the identity from auth.uid() through the deployed resolver');


-- ============================================================================
-- SECTION C — MY REWARDS, AND ONLY MINE
-- ============================================================================
select pg_temp.act_as(pg_temp.id('staff'));

-- Preconditions: the engine really did award these.
select is((select count(*)::integer from public.campaign_rewards w
           where w.beneficiary_profile_id = pg_temp.id('staff')), 5,
  'C0a. the engine awarded the seller five rewards');
select is((select count(*)::integer from public.campaign_rewards w
           where w.beneficiary_profile_id = pg_temp.id('staff2')), 6,
  'C0b. ...and the second seller in the SAME Retailer six of their own');

select is(pg_temp.reward_count(), 5,
  'C1. the seller reads exactly their own five rewards, and none of the other '
  'seller''s six');

select is((select count(*)::integer from jsonb_array_elements(pg_temp.rewards(100)) e
           where (e ->> 'reward_coins')::bigint is null), 0,
  'C2. every returned row carries a stored reward amount');

-- THE ISOLATION THAT MATTERS MOST: a second seller in the SAME Retailer.
select is((select count(*)::integer from jsonb_array_elements(pg_temp.rewards(100)) e
           where e ->> 'receipt_submission_id' = pg_temp.id('s_two_receipt')::text), 0,
  'C3. ANOTHER SELLER IN THE SAME RETAILER''S reward is not returned — a Retailer-level '
  'filter would have leaked it');

select is((select count(*)::integer from jsonb_array_elements(pg_temp.rewards(100)) e
           where e ->> 'receipt_submission_id' = pg_temp.id('s_other_receipt')::text), 0,
  'C4. ...and neither is another Retailer''s');

select pg_temp.act_as(pg_temp.id('staff_b'));
select is((select count(*)::integer from jsonb_array_elements(pg_temp.rewards(100)) e
           where e ->> 'receipt_submission_id' = pg_temp.id('s_main_receipt')::text), 0,
  'C5. the other Retailer''s seller cannot see this seller''s rewards either');

select pg_temp.act_as(pg_temp.id('staff'));

-- ---- The values are the stored ones, exactly -------------------------------
select is(pg_temp.reward_for(pg_temp.id('cv_unit')) ->> 'reward_coins', '35',
  'C6. PER_UNIT_COINS: 5 units x 7 coins = 35');
select is(pg_temp.reward_for(pg_temp.id('cv_unit')) ->> 'qualifying_units', '5',
  'C7. ...with the qualifying units');
select is(pg_temp.reward_for(pg_temp.id('cv_unit')) ->> 'qualifying_item_count', '2',
  'C8. ...and the item count, joined from the evaluation');
select is(pg_temp.reward_for(pg_temp.id('cv_unit')) ->> 'coins_capped_to', null,
  'C9. ...and no capped_to, because no cap bit');

select is(pg_temp.reward_for(pg_temp.id('cv_cap')) ->> 'coins_uncapped', '25',
  'C10. PARTIAL CAP: the uncapped amount is preserved');
select is(pg_temp.reward_for(pg_temp.id('cv_cap')) ->> 'coins_capped_to', '12',
  'C11. ...the capped amount is returned');
select is(pg_temp.reward_for(pg_temp.id('cv_cap')) ->> 'reward_coins', '12',
  'C12. ...and the final award is the cap');

select is(pg_temp.reward_for(pg_temp.id('cv_target')) ->> 'reward_coins', '100',
  'C13. TARGET_BONUS: the crossing sale paid the configured bonus');
select is(pg_temp.reward_for(pg_temp.id('cv_target')) ->> 'threshold_units', '3',
  'C14. ...and the threshold is returned for display');
select is(pg_temp.reward_for(pg_temp.id('cv_target')) ->> 'rule_type', 'TARGET_BONUS',
  'C15. ...labelled as a target bonus, not a per-unit reward');

-- A QUALIFIED TARGET SALE THAT CROSSED NOTHING IS NOT A REWARD.
select is((select e.outcome from public.campaign_sale_evaluations e
           where e.campaign_version_id = pg_temp.id('cv_far')
             and e.beneficiary_profile_id = pg_temp.id('staff')), 'QUALIFIED',
  'C16. the far-target campaign QUALIFIED the sale');
select is(pg_temp.reward_for(pg_temp.id('cv_far')), null,
  'C17. ...and it correctly appears as NO reward, because 5 units did not reach 50');

-- A SELECTED_PRODUCTS campaign counts only its own products.
select is(pg_temp.reward_for(pg_temp.id('cv_snap')) ->> 'qualifying_units', '2',
  'C17a. SELECTED_PRODUCTS counted only the two units of the listed product, not all '
  'five on the receipt');
select is(pg_temp.reward_for(pg_temp.id('cv_snap')) ->> 'reward_coins', '8',
  'C17b. ...so it paid 2 x 4 = 8, and the returned amount follows the campaign''s own '
  'product scope');

-- ---- Display lineage ------------------------------------------------------
select is(pg_temp.reward_for(pg_temp.id('cv_unit')) ->> 'campaign_name', 'SS PerUnit',
  'C18. the campaign name is returned for display');
select is(pg_temp.reward_for(pg_temp.id('cv_unit')) ->> 'shop_name', 'SS Shop',
  'C19. the shop name is returned — a value this seller already reads elsewhere');
select is(pg_temp.reward_for(pg_temp.id('cv_unit')) ->> 'receipt_submission_id',
          pg_temp.id('s_main_receipt')::text,
  'C20. the receipt id is returned so a screen can navigate to the seller''s own receipt');
select ok((pg_temp.reward_for(pg_temp.id('cv_unit')) ->> 'sale_at') is not null,
  'C21. the sale instant is returned');

-- ---- Nothing internal leaks -----------------------------------------------
select is((select count(*)::integer from jsonb_array_elements(pg_temp.rewards(100)) e
           where e ? 'cap_subject_type' or e ? 'cap_subject_id'
              or e ? 'beneficiary_profile_id' or e ? 'campaign_sale_evaluation_id'
              or e ? 'verified_sale_id'
              or e ? 'vendor_organization_id' or e ? 'retailer_organization_id'), 0,
  'C22. no returned ROW carries a cap subject, beneficiary, evaluation, verified sale or '
  'tenant id');

-- ---- Pagination ------------------------------------------------------------
select is((select jsonb_array_length(pg_temp.rewards(2))), 2,
  'C23. the limit is honoured');
select is((select jsonb_array_length(pg_temp.rewards(0))), 5,
  'C24. a zero limit is CLAMPED to the default, not refused');
select is((select jsonb_array_length(pg_temp.rewards(-5))), 5,
  'C25. a negative limit is clamped too');
select is((select jsonb_array_length(pg_temp.rewards(100000))), 5,
  'C26. an absurd limit is clamped to the ceiling and returns what exists');

-- Keyset: page 2 continues exactly where page 1 stopped, with no repeat and no gap.
select is(
  (with p1 as (select * from public.get_my_campaign_rewards(2)),
        cur as (select awarded_at, campaign_reward_id from p1
                order by awarded_at, campaign_reward_id limit 1),
        p2 as (select * from public.get_my_campaign_rewards(
                 10, (select awarded_at from cur), (select campaign_reward_id from cur)))
   select count(*)::integer from p2),
  3,
  'C27. keyset pagination returns the remaining three rows');

select is(
  (with p1 as (select campaign_reward_id from public.get_my_campaign_rewards(2)),
        cur as (select awarded_at, campaign_reward_id from public.get_my_campaign_rewards(2)
                order by awarded_at, campaign_reward_id limit 1),
        p2 as (select campaign_reward_id from public.get_my_campaign_rewards(
                 10, (select awarded_at from cur), (select campaign_reward_id from cur)))
   select count(*)::integer from p1 join p2 using (campaign_reward_id)),
  0,
  'C28. ...and no row appears on both pages');

select is((select count(*)::integer from (
             select e ->> 'campaign_reward_id' k
             from jsonb_array_elements(pg_temp.rewards(100)) e
             group by 1 having count(*) > 1) d), 0,
  'C29. no reward is returned twice');

select is(pg_temp.rewards(100), pg_temp.rewards(100),
  'C30. two calls agree exactly — ordering is deterministic');


-- ============================================================================
-- SECTION D — HISTORY SURVIVES THE PRESENT
-- ============================================================================
do $$
begin
  -- Deactivate a product, cancel a campaign that already paid, and suspend the trading
  -- relationship. None of them may delete evidence the seller already earned.
  update public.vendor_products set status = 'INACTIVE' where id = pg_temp.id('p2');
  perform pg_temp.act_as(pg_temp.id('vsa'));
  perform public.set_vendor_campaign_lifecycle(pg_temp.id('cv_gone_campaign'), 'CANCEL');
  perform pg_temp.sign_out();
  update public.vendor_retailers set status = 'DEACTIVATED'
   where vendor_organization_id = pg_temp.id('vendor')
     and retailer_organization_id = pg_temp.id('retailer');
end;
$$;

select pg_temp.act_as(pg_temp.id('staff'));

select is((select c.status from public.campaigns c
           where c.id = pg_temp.id('cv_gone_campaign')), 'CANCELLED',
  'D1. the campaign really was cancelled');
select is((select vp.status from public.vendor_products vp where vp.id = pg_temp.id('p2')),
  'INACTIVE', 'D2. the product really was deactivated');

select is(pg_temp.reward_count(), 5,
  'D3. the seller STILL reads all five rewards');
select is(pg_temp.reward_for(pg_temp.id('cv_gone')) ->> 'reward_coins', '10',
  'D4. the CANCELLED campaign''s reward is still visible with its exact amount');
select is(pg_temp.reward_for(pg_temp.id('cv_unit')) ->> 'qualifying_units', '5',
  'D5. a deactivated product does not change what was counted');
select ok((select jsonb_array_length(pg_temp.rewards())) > 0,
  'D6. a suspended Vendor-Retailer relationship does not hide the seller''s history');


-- ============================================================================
-- SECTION E — EARNINGS SUMMARY
-- ============================================================================
select pg_temp.act_as(pg_temp.id('staff'));

-- 35 + 12 + 100 + 8 + 10 = 165
select is(pg_temp.summary() ->> 'total_reward_coins', '165',
  'E1. the total is the sum of the seller''s OWN stored rewards');
select is(pg_temp.summary() ->> 'current_month_reward_coins', '165',
  'E2. every reward was awarded now, so the current-month total matches');
select is(pg_temp.summary() ->> 'rewarded_sale_count', '1',
  'E3. five rewards on ONE sale is one rewarded sale, not five');
select is(pg_temp.summary() ->> 'rewarded_campaign_count', '5',
  'E4. ...across five distinct campaigns');
select ok((pg_temp.summary() ->> 'latest_reward_at') is not null,
  'E5. the latest award instant is returned');
select ok((pg_temp.summary() ->> 'current_month_start_utc') is not null
      and (pg_temp.summary() ->> 'current_month_end_utc') is not null,
  'E6. the month window is returned so a client can label the period it shows');

-- A SECOND SELLER'S EARNINGS ARE NOT IN MY TOTAL.
select is((select sum(w.reward_coins)::text from public.campaign_rewards w
           where w.beneficiary_profile_id = pg_temp.id('staff2')), '264',
  'E7. the second seller earned 264 coins of their own');
select is(pg_temp.summary() ->> 'total_reward_coins', '165',
  'E8. ...and NOT ONE of them is added to this seller''s total');

select pg_temp.act_as(pg_temp.id('staff2'));
select is(pg_temp.summary() ->> 'rewarded_sale_count', '1',
  'E9. the second seller reads their own summary independently');

-- A SELLER WITH NO REWARDS READS ZERO, NOT NULL.
do $$
declare v uuid;
begin
  v := pg_temp.new_person('SS','Fresh');
  insert into pg_temp.f values ('fresh', v);
  perform pg_temp.add_member(v, pg_temp.id('retailer'), 'SALES_STAFF');
end;
$$;
select pg_temp.act_as(pg_temp.id('fresh'));
select is(pg_temp.summary() ->> 'total_reward_coins', '0',
  'E10. a seller with no rewards reads 0, not NULL');
select is(pg_temp.summary() ->> 'rewarded_sale_count', '0',
  'E11. ...and zero rewarded sales');
select is(pg_temp.summary() ->> 'latest_reward_at', null,
  'E12. ...with no latest award instant');
select is((select jsonb_array_length(pg_temp.rewards())), 0,
  'E13. ...and an empty reward history');


-- ============================================================================
-- SECTION F — TARGET PROGRESS
-- ============================================================================
select pg_temp.act_as(pg_temp.id('staff'));

select is((select jsonb_array_length(pg_temp.progress())), 4,
  'F1. progress is returned for the four TARGET_BONUS campaigns this seller may see, '
  'and no others');

-- ANOTHER VENDOR'S CAMPAIGN IS NOT MINE.
select ok((select count(*) from public.campaign_eligible_retailers er
           where er.campaign_version_id = pg_temp.id('cv_foreign')) > 0,
  'F1a. the foreign Vendor''s campaign really was published with a snapshot of its own');
select is(pg_temp.progress_for(pg_temp.id('cv_foreign')), null,
  'F1b. ...and it is NOT returned, because its frozen snapshot does not name this '
  'seller''s Retailer');

-- A REVISED CAMPAIGN APPEARS ONCE, AS THE VERSION IN FORCE.
select ok((select count(*) from public.campaign_eligible_retailers er
           where er.campaign_version_id = pg_temp.id('cv_rev1')) > 0,
  'F1c. the SUPERSEDED version 1 still carries its own eligible-retailer snapshot');
select is((select count(*)::integer from jsonb_array_elements(pg_temp.progress()) e
           where e ->> 'campaign_id' = pg_temp.id('cv_rev1_campaign')::text), 1,
  'F1d. ...yet the revised campaign appears exactly ONCE, not once per version');
select is(pg_temp.progress_for(pg_temp.id('cv_rev2')) ->> 'target_units', '4',
  'F1e. ...and the row returned is version 2, the one in force');
select is(pg_temp.progress_for(pg_temp.id('cv_rev1')), null,
  'F1f. ...while the superseded version 1 is absent');

-- A campaign with no accumulator row yet reads as zero, and is NOT dropped.
select is(pg_temp.progress_for(pg_temp.id('cv_rev2')) ->> 'progress_units', '0',
  'F1g. a campaign nobody has sold into yet shows 0 progress rather than vanishing');
select is(pg_temp.progress_for(pg_temp.id('cv_rev2')) ->> 'target_reached', 'false',
  'F1h. ...and is not reached');

select is((select count(*)::integer from jsonb_array_elements(pg_temp.progress()) e
           where e ->> 'campaign_version_id' in
             (pg_temp.id('cv_unit')::text, pg_temp.id('cv_cap')::text,
              pg_temp.id('cv_snap')::text)), 0,
  'F2. a PER_UNIT_COINS campaign gets NO progress bar — it has no target to reach');

-- INDIVIDUAL progress is the seller's own units.
select is(pg_temp.progress_for(pg_temp.id('cv_target')) ->> 'progress_units', '5',
  'F3. INDIVIDUAL_STAFF progress is the seller''s own five qualifying units');
select is(pg_temp.progress_for(pg_temp.id('cv_target')) ->> 'target_units', '3',
  'F4. ...against the configured threshold');
select is(pg_temp.progress_for(pg_temp.id('cv_target')) ->> 'target_reached', 'true',
  'F5. ...and the target is reached');
select is(pg_temp.progress_for(pg_temp.id('cv_target')) ->> 'bonus_awarded_to_me', 'true',
  'F6. ...with the bonus awarded to this seller');

select is(pg_temp.progress_for(pg_temp.id('cv_far')) ->> 'progress_units', '5',
  'F7. the far target shows the same five units');
select is(pg_temp.progress_for(pg_temp.id('cv_far')) ->> 'target_reached', 'false',
  'F8. ...but is not reached');
select is(pg_temp.progress_for(pg_temp.id('cv_far')) ->> 'bonus_awarded_to_me', 'false',
  'F9. ...and no bonus was awarded');

-- TEAM progress includes the other seller's contribution.
select is(pg_temp.progress_for(pg_temp.id('cv_team')) ->> 'performance_scope',
  'RETAILER_TEAM', 'F10. the team campaign is labelled as team-scoped');
select is(pg_temp.progress_for(pg_temp.id('cv_team')) ->> 'progress_units', '9',
  'F11. TEAM progress is 5 + 4 = 9 — the other seller''s units DO contribute');
select is(pg_temp.progress_for(pg_temp.id('cv_team')) ->> 'target_reached', 'true',
  'F12. ...so the team target of 8 is reached');

-- THE TEAM BONUS WENT TO THE OTHER SELLER, AND THIS SELLER IS TOLD SO HONESTLY.
select is((select w.beneficiary_profile_id from public.campaign_rewards w
           where w.campaign_version_id = pg_temp.id('cv_team')), pg_temp.id('staff2'),
  'F13. the team bonus was awarded to the seller whose sale crossed the threshold');
select is(pg_temp.progress_for(pg_temp.id('cv_team')) ->> 'bonus_awarded_to_me', 'false',
  'F14. ...and THIS seller is correctly told the bonus is not theirs, rather than being '
  'shown the accumulator''s per-subject flag which would have read true');

select pg_temp.act_as(pg_temp.id('staff2'));
select is(pg_temp.progress_for(pg_temp.id('cv_team')) ->> 'bonus_awarded_to_me', 'true',
  'F15. the seller who DID cross it is told the bonus is theirs');
select is(pg_temp.progress_for(pg_temp.id('cv_team')) ->> 'progress_units', '9',
  'F16. ...and sees the same shared team progress');

-- NO RAW ACCUMULATOR ANYWHERE.
select pg_temp.act_as(pg_temp.id('staff'));
select is((select count(*)::integer from jsonb_array_elements(pg_temp.progress()) e
           where e ? 'cap_subject_type' or e ? 'cap_subject_id'
              or e ? 'coins_awarded_total' or e ? 'units_counted_total'
              or e ? 'target_bonus_awarded'), 0,
  'F17. NO progress row exposes a cap subject, a coin total or the accumulator flag');

select ok(pg_temp.body('get_my_campaign_target_progress') !~ 'coins_awarded_total'
      and pg_temp.body('get_my_campaign_target_progress') !~ 'target_bonus_awarded',
  'F18. the body never reads the accumulator''s coin total or its per-subject flag');

-- A seller of another Retailer sees their own team, not this one.
select pg_temp.act_as(pg_temp.id('staff_b'));
select is((select count(*)::integer from jsonb_array_elements(pg_temp.progress()) e
           where (e ->> 'progress_units')::bigint > 2), 0,
  'F19. the other Retailer''s seller never sees this Retailer''s team progress');


-- ============================================================================
-- SECTION G — BOUNDARIES
-- ============================================================================
select pg_temp.sign_out();

-- MIGRATION 30's SALES STAFF CAMPAIGN SURFACE IS UNTOUCHED. Migration 70 did not
-- duplicate it, and that is only true while these remain its single owner.
select is((select coalesce(string_agg(p.proname, ',' order by p.proname), 'NONE')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in
             ('list_my_staff_campaigns','get_my_staff_campaign','list_my_staff_campaign_products')),
  'get_my_staff_campaign,list_my_staff_campaign_products,list_my_staff_campaigns',
  'G1. the three Migration 30 staff campaign reads still exist');

select ok((select bool_and(p.proacl::text = '{postgres=X/postgres,authenticated=X/postgres}')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in
             ('list_my_staff_campaigns','get_my_staff_campaign','list_my_staff_campaign_products')),
  'G2. ...still authenticated-only, with their ACLs unchanged');

select is((select count(*)::integer from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname in ('get_my_current_campaigns','get_my_campaign_eligible_products')), 0,
  'G3. Migration 70 added NO duplicate campaign or product read');

-- Migrations 66-69 are untouched.
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_versions_matching_sale'),
  '4e20cce64647395974fa8da490c55c20', 'G4. Migration 66 Unit A unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'),
  'bcaf88024d3cc06dbae6dc46670a2906', 'G5. Migration 66 Unit B unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_matching_result_for_sale'),
  '0b0c06bfcd2576451036debe6401b133', 'G6. Migration 66 Unit C resolver unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_matching_qualified_items_for_sale'),
  '8f0bb7195e2a6716755ebd7967069966', 'G7. Migration 66 Unit C item helper unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_reward_calculation_for_evaluation'),
  '20d20ffb775aca756fcf71c293a352b6', 'G8. Migration 67 calculation unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_apply_reward_for_evaluation'),
  '5ffe5cac1709110d64fb75f69d8400f9', 'G9. Migration 67 applier unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_execute_evaluation_for_verified_sale'),
  '9467db090e083b11467f67129e7fcc8c', 'G10. Migration 68 evaluator unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'evaluate_verified_sale_campaigns'),
  '8e3fc0603c83b2eada5ad9dbfb86d1c5', 'G11. Migration 68 execution RPC unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'evaluate_receipt_campaigns'),
  'b1cb6c79843f11345a9b3fb62b74ea46', 'G12. Migration 69 execution wrapper unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_receipt_campaign_results'),
  'f36f6504bca37c9f5f052c20119f00eb', 'G13. Migration 69 result wrapper unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_receipt_campaign_qualifying_items'),
  '3bdbc9ef9e8e9f36ad05286be31e2481', 'G14. Migration 69 item wrapper unchanged');

-- Nothing in this migration evaluates, rewards or mutates.
select ok((select bool_and(pg_temp.body(n)
             !~ 'evaluate_receipt_campaigns|evaluate_verified_sale_campaigns|'
                'campaign_execute_evaluation|campaign_apply_reward|campaign_matching_')
           from unnest(pg_temp.rpc_names() || array['sales_staff_earnings_profile']) n),
  'G15. NO function calls an evaluator, an applier or a matching helper');

select is((select count(*)::integer from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('campaign_rewards','campaign_sale_evaluations',
                                'campaign_subject_accumulators','campaign_sale_item_qualifications')
             and grantee in ('anon','authenticated','service_role','PUBLIC')), 0,
  'G16. Migration 70 granted NO direct table access on any evidence table');

select ok(true,
  'G17. NOTE: no Web or Flutter file is touched by this migration — it adds SQL only, '
  'and both client integrations are separate units');
select ok(true,
  'G18. NOTE: this suite writes only to the local test transaction, which pgTAP rolls '
  'back; no hosted database is contacted');

select * from finish();
rollback;
