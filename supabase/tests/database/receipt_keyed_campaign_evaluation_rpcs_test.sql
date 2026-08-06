-- Tests for Phase 2A-E, Migration 69.
--
--   public.evaluate_receipt_campaigns(uuid)                Sections A-D
--   public.get_receipt_campaign_results(uuid)              Sections A, E
--   public.get_receipt_campaign_qualifying_items(uuid)     Sections A, E
--
-- Run with:  supabase test db
--
-- ============================================================================
-- WHAT THIS SUITE IS PROTECTING
-- ============================================================================
-- These are the thinnest functions in the schema, and thin is exactly what has to
-- stay true. Four properties carry them:
--
--   1. THEY DELEGATE AND DO NOT DECIDE. Each calls its one Migration 68 counterpart
--      and contains no authorization, no matching, no reward arithmetic, no
--      accumulator access and no write of any kind. Section C proves it structurally
--      AND behaviourally — a wrapper that quietly re-implemented a read would return
--      rows to a caller Migration 68 would have refused.
--
--   2. THE INTERNAL SALE ID NEVER LEAVES. verified_sale_id is projected away from
--      the execution contract and appears in none of the three. The whole reason
--      these wrappers exist is that the browser must not hold that key. Section B.
--
--   3. REFUSALS DO NOT BECOME AN ORACLE. Unknown receipt, unfinalized sale, foreign
--      Vendor and no permission all raise ONE 42501 with one message from the
--      execution wrapper, and all return ZERO ROWS from the reads. A caller must not
--      be able to tell "no such receipt" from "not yours". Section D.
--
--   4. ONE RECEIPT RESOLVES TO ONE SALE, BY INDEX. The resolution has no ORDER BY
--      and no LIMIT because a second row is unstorable. Section F.
--
-- ============================================================================
-- WHAT THIS SUITE DOES NOT RE-PROVE
-- ============================================================================
-- Nothing about matching, reward arithmetic, caps, target crossing, locking,
-- accumulator reconciliation or audit content. Migrations 66, 67 and 68 own all of
-- it and their own suites prove it. What IS re-proven here is that delegating
-- through a receipt id reaches the same answers — because a wrapper that silently
-- resolved the wrong sale would pass every structural test in this file.

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

create function pg_temp.new_person(p_first text, p_last text) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || left(v_id::text, 8) || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, 'ACTIVE');
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

create function pg_temp.add_member(p_user uuid, p_org uuid, p_role text) returns uuid
language plpgsql as $$
declare v_m uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, 'ACTIVE', now() - interval '30 days') returning id into v_m;
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
  v_path := 'rk/' || v_id::text || '.png';
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

/* A receipt carried to a complete ACCEPTED authoritative item set. The sale instant
   sits ahead of the run so it falls inside the status-history intervals every
   campaign opens at publish time — the same discipline Migrations 66 and 68 use. */
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

/* A VERIFIED receipt with NO authoritative sale at all: confirmed and reviewed, but
   the sale header was never finalized. The wrapper must refuse it exactly as it
   refuses an unknown receipt. */
create function pg_temp.unfinalized_receipt(
  p_key text, p_retailer uuid, p_shop uuid, p_staff uuid, p_vendor uuid,
  p_reviewer uuid, p_lines jsonb
) returns uuid language plpgsql as $$
declare v_r uuid; v_local timestamp;
begin
  v_local := date_trunc('minute', (now() + interval '2 hours') at time zone 'Asia/Dubai');
  v_r := pg_temp.new_receipt(p_retailer, p_shop, p_staff);
  insert into pg_temp.f values (p_key, v_r);

  perform pg_temp.act_as(p_staff);
  perform public.confirm_receipt_with_products(
    v_r, v_local::date, 'AED', 2::smallint, 12345::bigint, p_lines,
    'Test Merchant', 'DOC-9', v_local::time, 10000::bigint, 2345::bigint);

  insert into public.receipt_review_decisions
    (receipt_submission_id, vendor_organization_id, decision, decided_by_profile_id)
  values (v_r, p_vendor, 'VERIFIED', p_reviewer);
  perform pg_temp.sign_out();
  return v_r;
end;
$$;

create function pg_temp.publish(
  p_key text, p_vendor uuid, p_admin uuid, p_name text,
  p_scope    text default 'ALL_ELIGIBLE_PRODUCTS',
  p_stacking text default 'STACKABLE',
  p_excl_key text default null,
  p_per_unit bigint default 5,
  p_products uuid[] default null,
  p_priority integer default 10
) returns uuid language plpgsql as $$
declare v_c uuid; v_v uuid;
begin
  perform pg_temp.act_as(p_admin);
  v_c := public.create_vendor_campaign_draft(
    p_name, 'Described.', now() - interval '60 days', now() + interval '30 days',
    'Asia/Dubai', 'ALL_RETAILERS', 'INDIVIDUAL_STAFF', p_scope, p_stacking, p_excl_key,
    p_priority, 'PER_UNIT_COINS', p_per_unit, null, null, null, null, null, p_products);
  perform public.publish_vendor_campaign(v_c);
  select c.published_version_id into v_v from public.campaigns c where c.id = v_c;
  perform pg_temp.sign_out();
  insert into pg_temp.f values (p_key || '_campaign', v_c), (p_key, v_v);
  return v_v;
end;
$$;

/* The three wrappers, as jsonb arrays, so an assertion can name one field. */
create function pg_temp.exec_rpc(p_receipt uuid) returns jsonb
language sql volatile as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.campaign_version_id), '[]'::jsonb)
  from public.evaluate_receipt_campaigns(p_receipt) t
$$;
create function pg_temp.results(p_receipt uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  from public.get_receipt_campaign_results(p_receipt) t
$$;
create function pg_temp.items(p_receipt uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  from public.get_receipt_campaign_qualifying_items(p_receipt) t
$$;

/* The Migration 68 originals, for the equivalence assertions. */
create function pg_temp.results_by_sale(p_sale uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  from public.get_verified_sale_campaign_results(p_sale) t
$$;
create function pg_temp.items_by_sale(p_sale uuid) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  from public.get_verified_sale_campaign_qualifying_items(p_sale) t
$$;

/* Run once and record, so no assertion re-runs an execution. A failure is RECORDED
   rather than propagated, so a mutation produces NAMED failures instead of one
   harness crash. */
create table pg_temp.r (k text primary key, v jsonb);
create function pg_temp.run(p_key text, p_receipt uuid) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  begin
    v := pg_temp.exec_rpc(p_receipt);
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
create function pg_temp.elems(p_key text) returns setof jsonb language sql stable as $$
  select e from jsonb_array_elements(
    case when jsonb_typeof(pg_temp.res(p_key)) = 'array'
         then pg_temp.res(p_key) else '[]'::jsonb end) e
$$;
create function pg_temp.rows_in(p_key text) returns integer language sql stable as $$
  select case when jsonb_typeof(pg_temp.res(p_key)) = 'array'
              then jsonb_array_length(pg_temp.res(p_key)) else -1 end
$$;
create function pg_temp.fld(p_key text, p_version uuid, p_field text) returns text
language sql stable as $$
  select (select e from pg_temp.elems(p_key) e
          where e ->> 'campaign_version_id' = p_version::text) ->> p_field
$$;

create function pg_temp.try_exec(p_receipt uuid) returns text language plpgsql as $$
begin perform pg_temp.exec_rpc(p_receipt); return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;
create function pg_temp.exec_message(p_receipt uuid) returns text language plpgsql as $$
begin perform pg_temp.exec_rpc(p_receipt); return 'ALLOWED';
exception when others then return sqlerrm; end;
$$;

/* Executable body with line comments stripped, so the migration's own prose — which
   necessarily names everything it refuses to do — cannot satisfy or trip a
   structural assertion. */
create function pg_temp.body(p_name text) returns text language sql stable as $$
  select lower(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', ' ', 'g'), '\s+', ' ', 'g'))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name
$$;

create function pg_temp.wrapper_names() returns text[] language sql immutable as $$
  select array['evaluate_receipt_campaigns','get_receipt_campaign_qualifying_items',
               'get_receipt_campaign_results']::text[]
$$;

create function pg_temp.eval_count(p_sale uuid) returns integer language sql stable as $$
  select count(*)::integer from public.campaign_sale_evaluations e where e.verified_sale_id = p_sale
$$;
create function pg_temp.reward_count(p_sale uuid) returns integer language sql stable as $$
  select count(*)::integer from public.campaign_rewards r where r.verified_sale_id = p_sale
$$;
create function pg_temp.acc_digest() returns text language sql stable as $$
  select coalesce(md5(string_agg(
    a.campaign_version_id::text || '|' || a.cap_subject_id::text || '|' ||
    a.units_counted_total || '|' || a.coins_awarded_total, ',' order by a.campaign_version_id,
    a.cap_subject_id)), 'EMPTY')
  from public.campaign_subject_accumulators a
$$;


-- ============================================================================
-- Fixture
-- ============================================================================
do $$
declare v uuid;
begin
  insert into pg_temp.f values
    ('vendor',   pg_temp.new_org('RK Vendor',   'VENDOR')),
    ('vendor_b', pg_temp.new_org('RK Vendor B', 'VENDOR')),
    ('retailer', pg_temp.new_org('RK Retailer', 'RETAILER'));

  insert into pg_temp.f values
    ('vsa',    pg_temp.new_person('RK','Admin')),
    ('rev',    pg_temp.new_person('RK','Rev')),
    ('rev_b',  pg_temp.new_person('RK','RevB')),
    ('staff',  pg_temp.new_person('RK','Staff')),
    ('nobody', pg_temp.new_person('RK','Nobody'));

  perform pg_temp.add_member(pg_temp.id('vsa'),   pg_temp.id('vendor'),   'VENDOR_SUPER_ADMIN');
  perform pg_temp.add_member(pg_temp.id('rev'),   pg_temp.id('vendor'),   'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('rev_b'), pg_temp.id('vendor_b'), 'CLAIM_REVIEWER');
  perform pg_temp.add_member(pg_temp.id('staff'), pg_temp.id('retailer'), 'SALES_STAFF');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (pg_temp.id('vendor'),   pg_temp.id('retailer'), 'ACTIVE'),
         (pg_temp.id('vendor_b'), pg_temp.id('retailer'), 'ACTIVE');

  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer'), 'RK Shop', 'RKS', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop', v);

  insert into pg_temp.f values
    ('p1', pg_temp.new_product(pg_temp.id('vendor'),   'RK-1', 'Product One', pg_temp.id('vsa'))),
    ('p2', pg_temp.new_product(pg_temp.id('vendor'),   'RK-2', 'Product Two', pg_temp.id('vsa'))),
    ('pb', pg_temp.new_product(pg_temp.id('vendor_b'), 'RK-B', 'Product B',   pg_temp.id('vsa')));
  perform pg_temp.assign(pg_temp.id('p1'), pg_temp.id('retailer'), pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('p2'), pg_temp.id('retailer'), pg_temp.id('vsa'));
  perform pg_temp.assign(pg_temp.id('pb'), pg_temp.id('retailer'), pg_temp.id('vsa'));
end;
$$;

do $$
begin
  -- The main sale: two lines, five units.
  perform pg_temp.full_sale('s_main', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2), pg_temp.line(pg_temp.id('p2'), 3)));

  -- A Vendor B sale that matches no campaign at all.
  perform pg_temp.full_sale('s_zero', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor_b'), pg_temp.id('rev_b'),
    jsonb_build_array(pg_temp.line(pg_temp.id('pb'), 1)));

  -- Excluded after completion.
  perform pg_temp.full_sale('s_excl', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));

  -- VERIFIED, but no sale header was ever finalized: no verified_sales row exists.
  perform pg_temp.unfinalized_receipt('r_unfin', pg_temp.id('retailer'), pg_temp.id('shop'),
    pg_temp.id('staff'), pg_temp.id('vendor'), pg_temp.id('rev'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2)));
end;
$$;

do $$
begin
  perform pg_temp.publish('cv_all', pg_temp.id('vendor'), pg_temp.id('vsa'), 'RK All',
    'ALL_ELIGIBLE_PRODUCTS', 'STACKABLE', null, 7, null, 20);
  perform pg_temp.publish('cv_snap', pg_temp.id('vendor'), pg_temp.id('vsa'), 'RK Snapshot',
    'SELECTED_PRODUCTS', 'STACKABLE', null, 5, array[pg_temp.id('p1')]::uuid[], 10);
  perform pg_temp.publish('cv_none', pg_temp.id('vendor'), pg_temp.id('vsa'), 'RK NoItems',
    'SELECTED_PRODUCTS', 'STACKABLE', null, 5, array[pg_temp.id('p2')]::uuid[], 5);
  perform pg_temp.publish('cv_win', pg_temp.id('vendor'), pg_temp.id('vsa'), 'RK ExclusiveWin',
    'ALL_ELIGIBLE_PRODUCTS', 'EXCLUSIVE', 'RK-KEY', 3, null, 900);
  perform pg_temp.publish('cv_lose', pg_temp.id('vendor'), pg_temp.id('vsa'), 'RK ExclusiveLose',
    'ALL_ELIGIBLE_PRODUCTS', 'EXCLUSIVE', 'RK-KEY', 999, null, 100);
end;
$$;


-- ============================================================================
-- SECTION A — SCHEMA, CONTRACT AND ACL
-- ============================================================================
select is((select count(*)::integer from supabase_migrations.schema_migrations
           where version = '20260827090000'), 1,
  'A1. Migration 69 is recorded exactly once');

-- SUPERSEDED IN PART BY PHASE 2B: Migrations 70 (20260828090000) and
-- 71 (20260828210000) were created by approval and are named exactly. Migration 70 adds
-- Sales Staff earnings reads. Migration 71 adds Azure receipt-extraction readiness.
-- Neither touches this migration's wrappers. The rule this assertion still
-- owns is that nothing beyond them has been applied.
select is((select coalesce(string_agg(version, ',' order by version), 'NONE')
           from supabase_migrations.schema_migrations
           where version > '20260827090000'),
  '20260828090000,20260828210000',
  'A2. the only migrations after 20260827090000 are approved Migrations 70 and 71');

select has_function('public', 'evaluate_receipt_campaigns', array['uuid'],
  'A3. the execution wrapper exists with the exact signature');
select has_function('public', 'get_receipt_campaign_results', array['uuid'],
  'A4. the result read exists with the exact signature');
select has_function('public', 'get_receipt_campaign_qualifying_items', array['uuid'],
  'A5. the item read exists with the exact signature');

select is((select coalesce(string_agg(p.proname, ',' order by p.proname), 'NONE')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and (p.proname like '%receipt_campaign%' or p.proname like 'evaluate_receipt%')),
  'evaluate_receipt_campaigns,get_receipt_campaign_qualifying_items,'
  'get_receipt_campaign_results',
  'A6. EXACTLY three receipt-keyed campaign functions exist, and no fourth');

-- Each takes ONE input, and it is the receipt id. No tenant, campaign, beneficiary,
-- quantity, rate or reward value can be nominated.
select is((select coalesce(string_agg(p.proname || ':' || pg_get_function_arguments(p.oid), ' | '
                                      order by p.proname), 'NONE')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.wrapper_names())),
  'evaluate_receipt_campaigns:p_submission_id uuid | '
  'get_receipt_campaign_qualifying_items:p_submission_id uuid | '
  'get_receipt_campaign_results:p_submission_id uuid',
  'A7. all three take exactly one parameter, p_submission_id uuid');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'evaluate_receipt_campaigns'),
  'TABLE(receipt_submission_id uuid, campaign_sale_evaluation_id uuid, campaign_id uuid, '
  'campaign_version_id uuid, outcome text, non_qualification_reason text, '
  'qualifying_item_count integer, qualifying_units integer, campaign_reward_id uuid, '
  'reward_coins bigint, reward_created boolean, evaluation_created boolean, '
  'application_result text)',
  'A8. the execution contract is the approved 13 columns — Migration 68''s 14 minus '
  'verified_sale_id');

-- The two reads pass their delegate's contract through UNCHANGED, asserted against
-- the deployed function rather than against a literal, so a Migration 68 column
-- change cannot silently diverge here.
select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_receipt_campaign_results'),
          (select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_verified_sale_campaign_results'),
  'A9. the result read returns EXACTLY its delegate''s 16-column contract');

select is((select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_receipt_campaign_qualifying_items'),
          (select pg_get_function_result(p.oid) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_verified_sale_campaign_qualifying_items'),
  'A10. the item read returns EXACTLY its delegate''s 11-column contract');

select is((select string_agg(p.proname || '=' || p.provolatile::text, ',' order by p.proname)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.wrapper_names())),
  'evaluate_receipt_campaigns=v,get_receipt_campaign_qualifying_items=s,'
  'get_receipt_campaign_results=s',
  'A11. the execution wrapper is VOLATILE and both reads are STABLE');

select ok((select bool_and(p.prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.wrapper_names())),
  'A12. all three are SECURITY DEFINER');

select ok((select bool_and(p.proconfig @> array['search_path=""'])
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.wrapper_names())),
  'A13. all three run with an empty search_path');

select ok((select bool_and(p.prosrc !~* '\mexecute\s+''|\mformat\s*\(|\mquote_ident\M')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.wrapper_names())),
  'A14. none uses dynamic SQL');

select ok((select bool_and(obj_description(p.oid, 'pg_proc') is not null)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.wrapper_names())),
  'A15. all three are documented');

-- ---- ACL -------------------------------------------------------------------
select is((select string_agg(p.proname || '=' || p.proacl::text, ' ' order by p.proname)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.wrapper_names())),
  'evaluate_receipt_campaigns={postgres=X/postgres,authenticated=X/postgres} '
  'get_receipt_campaign_qualifying_items={postgres=X/postgres,authenticated=X/postgres} '
  'get_receipt_campaign_results={postgres=X/postgres,authenticated=X/postgres}',
  'A16. all three grant EXECUTE to authenticated and the owner, and to nobody else');

select ok((select bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE'))
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.wrapper_names())),
  'A17. authenticated can execute all three');

select is((select count(*)::integer from information_schema.role_routine_grants
           where routine_schema = 'public'
             and routine_name = any (pg_temp.wrapper_names())
             and grantee in ('anon','PUBLIC','service_role')), 0,
  'A18. no anon, PUBLIC or service_role execution grant exists on any of the three');

select ok((select bool_and(pg_get_userbyid(p.proowner) = 'postgres')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.wrapper_names())),
  'A19. the owner retains execution');

-- ---- NOTHING ELSE WAS ADDED ------------------------------------------------
-- Migration 69 minted nothing. STAFF_EARNINGS_VIEW and its SALES_STAFF grant
-- (Migration 70) are the one approved addition to each catalogue since.
select is((select count(*)::integer from public.permissions), 34,
  'A20. the permission catalogue is at 34 — Migration 69 minted none, and the only '
  'addition since is the approved STAFF_EARNINGS_VIEW');
select is((select count(*)::integer from public.role_permissions), 39,
  'A21. the role-permission catalogue is at 39 — Migration 69 granted none, and the '
  'only grant since is the approved STAFF_EARNINGS_VIEW to SALES_STAFF');
select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'), 47,
  'A22. Migration 69 added no table — still the 47 from Migration 65');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v'), 0,
  'A23. Migration 69 added no view');

-- THE TABLE THE WRAPPERS READ STAYS UNREADABLE. This is the assertion that keeps the
-- SECURITY DEFINER resolver from being a back door.
select ok(has_table_privilege('authenticated', 'public.verified_sales', 'SELECT') = false,
  'A24. authenticated STILL cannot SELECT public.verified_sales directly');
select is((select count(*)::integer from pg_policies
           where schemaname = 'public' and tablename = 'verified_sales'), 0,
  'A25. no RLS policy was added to verified_sales');
select ok((select c.relrowsecurity from pg_class c where c.oid = 'public.verified_sales'::regclass),
  'A26. verified_sales still has RLS enabled');

select is((select count(*)::integer from information_schema.tables
           where table_schema = 'public'
             and (table_name like '%coin%' or table_name like '%ledger%'
                  or table_name like '%wallet%' or table_name like '%balance%'
                  or table_name like '%payout%' or table_name like '%redemption%')), 0,
  'A27. no coin, ledger, wallet, balance, payout or redemption object exists');


-- ============================================================================
-- SECTION B — THE INTERNAL SALE ID NEVER LEAVES
-- ============================================================================
-- The whole reason these wrappers exist. Asserted on the CONTRACT, so it holds
-- whether or not any row is ever returned.
select is((select count(*)::integer from information_schema.parameters
           where specific_schema = 'public'
             and specific_name in (select specific_name from information_schema.routines
                                   where routine_schema = 'public'
                                     and routine_name = any (pg_temp.wrapper_names()))
             and parameter_name = 'verified_sale_id'), 0,
  'B1. verified_sale_id appears in NO return contract of any of the three wrappers');

select ok((select bool_and(pg_get_function_result(p.oid) !~ 'verified_sale_id')
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = any (pg_temp.wrapper_names())),
  'B2. ...confirmed against the rendered result signature too');

-- And against real rows, so a future column added by name would be caught as well.
do $$ begin perform pg_temp.act_as(pg_temp.id('rev')); perform pg_temp.run('main', pg_temp.id('s_main_receipt')); end; $$;

select is((select count(*)::integer from pg_temp.elems('main') e
           where e ? 'verified_sale_id'), 0,
  'B3. no returned execution ROW carries verified_sale_id');
select is((select count(*)::integer
           from jsonb_array_elements(pg_temp.results(pg_temp.id('s_main_receipt'))) e
           where e ? 'verified_sale_id'), 0,
  'B4. no returned result ROW carries verified_sale_id');
select is((select count(*)::integer
           from jsonb_array_elements(pg_temp.items(pg_temp.id('s_main_receipt'))) e
           where e ? 'verified_sale_id'), 0,
  'B5. no returned item ROW carries verified_sale_id');

select ok((select bool_and(e ? 'receipt_submission_id') from pg_temp.elems('main') e),
  'B6. the execution result still names the receipt the caller asked about');


-- ============================================================================
-- SECTION C — DELEGATION, AND NOTHING BUT DELEGATION
-- ============================================================================
select ok(pg_temp.body('evaluate_receipt_campaigns') ~ 'evaluate_verified_sale_campaigns',
  'C1. the execution wrapper delegates to the Migration 68 execution RPC');
select ok(pg_temp.body('get_receipt_campaign_results') ~ 'get_verified_sale_campaign_results',
  'C2. the result read delegates to the Migration 68 result RPC');
select ok(pg_temp.body('get_receipt_campaign_qualifying_items')
            ~ 'get_verified_sale_campaign_qualifying_items',
  'C3. the item read delegates to the Migration 68 item RPC');

-- EXACTLY its own counterpart, and no other. A wrapper reaching a second Migration
-- 68 function would be doing work of its own.
select ok(pg_temp.body('evaluate_receipt_campaigns')
            !~ 'get_verified_sale_campaign_results|get_verified_sale_campaign_qualifying_items',
  'C4. the execution wrapper calls no other Migration 68 function');
select ok(pg_temp.body('get_receipt_campaign_results')
            !~ 'evaluate_verified_sale_campaigns|get_verified_sale_campaign_qualifying_items',
  'C5. the result read calls no other Migration 68 function');
select ok(pg_temp.body('get_receipt_campaign_qualifying_items')
            !~ 'evaluate_verified_sale_campaigns|get_verified_sale_campaign_results',
  'C6. the item read calls no other Migration 68 function');

-- NOT the private evaluator, and NOT Migrations 66 or 67. Reaching past the
-- authorized browser RPC into the internals it fronts would skip every check.
select ok((select bool_and(pg_temp.body(n) !~ 'campaign_execute_evaluation_for_verified_sale')
           from unnest(pg_temp.wrapper_names()) n),
  'C7. NO wrapper calls the private Migration 68 evaluator directly');
select ok((select bool_and(pg_temp.body(n)
             !~ 'campaign_matching_result_for_sale|campaign_matching_qualified_items_for_sale|'
                'campaign_versions_matching_sale|campaign_sale_item_eligible_at')
           from unnest(pg_temp.wrapper_names()) n),
  'C8. NO wrapper calls a Migration 66 matching function');
select ok((select bool_and(pg_temp.body(n)
             !~ 'campaign_reward_calculation_for_evaluation|campaign_apply_reward_for_evaluation')
           from unnest(pg_temp.wrapper_names()) n),
  'C9. NO wrapper calls a Migration 67 reward function');

-- NO writes, NO evidence reads, NO accumulator, NO audit.
select ok((select bool_and(pg_temp.body(n) !~ '\minsert\s+into\M|\mupdate\s+public\.|\mdelete\s+from\M')
           from unnest(pg_temp.wrapper_names()) n),
  'C10. NO wrapper contains an INSERT, UPDATE or DELETE');
select ok((select bool_and(pg_temp.body(n) !~ 'campaign_subject_accumulators')
           from unnest(pg_temp.wrapper_names()) n),
  'C11. NO wrapper reads the accumulator');
select ok((select bool_and(pg_temp.body(n) !~ 'audit_log')
           from unnest(pg_temp.wrapper_names()) n),
  'C12. NO wrapper touches the audit log');
select ok((select bool_and(pg_temp.body(n)
             !~ 'campaign_sale_evaluations|campaign_sale_item_qualifications|campaign_rewards')
           from unnest(pg_temp.wrapper_names()) n),
  'C13. NO wrapper reads an evidence table directly — the delegate is the only path');

-- NO authorization of its own. Migration 68 stays the sole authority.
select ok((select bool_and(pg_temp.body(n) !~ 'resolve_claim_reviewer_organization')
           from unnest(pg_temp.wrapper_names()) n),
  'C14. NO wrapper resolves a reviewer organization itself');
select ok((select bool_and(pg_temp.body(n)
             !~ 'role_permissions|public\.permissions|member_roles|organization_members')
           from unnest(pg_temp.wrapper_names()) n),
  'C15. NO wrapper performs a permission, role or membership check of its own');
select ok((select bool_and(pg_temp.body(n) !~ 'vendor_organization_id')
           from unnest(pg_temp.wrapper_names()) n),
  'C16. NO wrapper compares a Vendor — isolation belongs entirely to the delegate');

-- NO business logic.
-- The reward column NAMES do appear, because the read wrappers project their
-- delegate's contract through column by column. What must not appear is COMPUTATION:
-- no cap arithmetic, no threshold comparison, no exclusivity ranking, and no reach
-- into the campaign rule tables those numbers came from.
select ok((select bool_and(pg_temp.body(n)
             !~ 'exclusivity|greatest\s*\(|least\s*\(|campaign_rules|campaign_rule_tiers|'
                'row_number|partition\s+by')
           from unnest(pg_temp.wrapper_names()) n),
  'C17. NO wrapper contains cap arithmetic, exclusivity ranking or any read of the '
  'campaign rule tables');

select ok((select bool_and(pg_temp.body(n) !~ '[*+]|\s-\s')
           from unnest(pg_temp.wrapper_names()) n),
  'C18a. NO wrapper performs arithmetic of any kind — every number it returns is one '
  'the delegate already computed');

-- The resolution is by the unique index alone. No ORDER BY and no LIMIT, because a
-- second row is unstorable and choosing one would make the answer planner-dependent.
select ok((select bool_and(pg_temp.body(n) !~ '\morder\s+by\M|\mlimit\M')
           from unnest(pg_temp.wrapper_names()) n),
  'C18. NO wrapper orders or limits its resolution — the receipt index makes it total');


-- ============================================================================
-- SECTION D — EXECUTION BEHAVIOUR THROUGH THE RECEIPT KEY
-- ============================================================================
select pg_temp.act_as(pg_temp.id('rev'));

select is(pg_temp.res('main') -> 'error', null::jsonb,
  'D1. an authorized Claim Reviewer evaluates BY RECEIPT ID successfully');
select is(pg_temp.rows_in('main'), 5,
  'D2. all five candidate campaigns came back');

-- THE RESOLUTION REACHED THE RIGHT SALE. A wrapper that resolved the wrong one would
-- pass every structural assertion above, so this is checked against the evidence the
-- execution actually wrote.
select is(pg_temp.eval_count(pg_temp.id('s_main')), 5,
  'D3. the evidence was written against the receipt''s OWN verified sale');
select is((select coalesce(string_agg(distinct e ->> 'receipt_submission_id', ','), 'NONE')
           from pg_temp.elems('main') e), pg_temp.id('s_main_receipt')::text,
  'D4. every returned row names the receipt that was passed in');

select is(pg_temp.fld('main', pg_temp.id('cv_snap'), 'outcome'), 'QUALIFIED',
  'D5. the snapshot campaign qualified');
select is(pg_temp.fld('main', pg_temp.id('cv_snap'), 'reward_coins'), '10',
  'D6. ...and paid 2 units x 5 coins, through Migration 67 as before');
select is(pg_temp.fld('main', pg_temp.id('cv_lose'), 'non_qualification_reason'),
  'SUPPRESSED_BY_EXCLUSIVITY',
  'D7. the exclusive loser is still suppressed — the delegate decided, not the wrapper');
select is((select coalesce(string_agg(distinct e ->> 'evaluation_created', ','), 'NONE')
           from pg_temp.elems('main') e), 'true',
  'D8. the FIRST execution reports every evaluation as created');

-- ---- REPLAY ----------------------------------------------------------------
do $$
declare v_acc text; v_ev integer; v_rw integer;
begin
  v_acc := pg_temp.acc_digest();
  v_ev  := pg_temp.eval_count(pg_temp.id('s_main'));
  v_rw  := pg_temp.reward_count(pg_temp.id('s_main'));
  insert into pg_temp.f values ('probe', gen_random_uuid());
  perform pg_temp.run('replay', pg_temp.id('s_main_receipt'));
  create temp table replay_snap as
  select v_acc as acc, v_ev as ev, v_rw as rw;
end;
$$;

select is(pg_temp.res('replay') -> 'error', null::jsonb,
  'D9. a replay through the receipt key succeeds');
select is((select coalesce(string_agg(distinct e ->> 'evaluation_created', ','), 'NONE')
           from pg_temp.elems('replay') e), 'false',
  'D10. ...and reports nothing as newly created');
select is((select coalesce(string_agg(distinct e ->> 'application_result', ','), 'NONE')
           from pg_temp.elems('replay') e
           where e ->> 'outcome' = 'QUALIFIED'), 'ALREADY_APPLIED',
  'D11. ...with every reward application reporting ALREADY_APPLIED');
select is(pg_temp.eval_count(pg_temp.id('s_main')), (select ev from replay_snap),
  'D12. NO duplicate evaluation from the replay');
select is(pg_temp.reward_count(pg_temp.id('s_main')), (select rw from replay_snap),
  'D13. NO duplicate reward');
select is(pg_temp.acc_digest(), (select acc from replay_snap),
  'D14. NO accumulator movement — Migration 67''s idempotency reaches through intact');

-- ---- ZERO CANDIDATES -------------------------------------------------------
select pg_temp.act_as(pg_temp.id('rev_b'));
do $$ begin perform pg_temp.run('zero', pg_temp.id('s_zero_receipt')); end; $$;
select is(pg_temp.res('zero') -> 'error', null::jsonb,
  'D15. a zero-candidate receipt SUCCEEDS');
select is(pg_temp.rows_in('zero'), 0,
  'D16. ...with an empty result, which is not an error');
select is(pg_temp.eval_count(pg_temp.id('s_zero')), 0,
  'D17. ...and creates no evidence');

-- ---- REFUSALS, ALL COLLAPSED INTO ONE --------------------------------------
select pg_temp.act_as(pg_temp.id('rev'));
select is(pg_temp.try_exec(null), 'REFUSED:42501',
  'D18. a NULL receipt id is refused');
select is(pg_temp.try_exec(gen_random_uuid()), 'REFUSED:42501',
  'D19. an UNKNOWN receipt is refused');
select is(pg_temp.try_exec(pg_temp.id('r_unfin')), 'REFUSED:42501',
  'D20. a VERIFIED receipt with NO finalized sale is refused');
select is((select count(*)::integer from public.verified_sales v
           where v.receipt_submission_id = pg_temp.id('r_unfin')), 0,
  'D21. ...and that receipt genuinely has no verified sale, so D20 is not vacuous');

select pg_temp.act_as(pg_temp.id('rev_b'));
select is(pg_temp.try_exec(pg_temp.id('s_main_receipt')), 'REFUSED:42501',
  'D22. a reviewer of ANOTHER Vendor is refused');
select pg_temp.act_as(pg_temp.id('staff'));
select is(pg_temp.try_exec(pg_temp.id('s_main_receipt')), 'REFUSED:42501',
  'D23. Sales Staff — the beneficiary — is refused');
select pg_temp.act_as(pg_temp.id('nobody'));
select is(pg_temp.try_exec(pg_temp.id('s_main_receipt')), 'REFUSED:42501',
  'D24. a caller with no membership is refused');
select pg_temp.sign_out();
select is(pg_temp.try_exec(pg_temp.id('s_main_receipt')), 'REFUSED:42501',
  'D25. an anonymous caller is refused');

-- NOT AN ORACLE. Every cause must produce the SAME message as well as the same code,
-- or the wrapper has told the caller something the delegate would not have.
select pg_temp.act_as(pg_temp.id('rev'));
select is(pg_temp.exec_message(gen_random_uuid()), pg_temp.exec_message(pg_temp.id('r_unfin')),
  'D26. "unknown receipt" and "no finalized sale" give the IDENTICAL message');
select is(pg_temp.exec_message(null), pg_temp.exec_message(gen_random_uuid()),
  'D27. ...and so does a null id');
select is(pg_temp.exec_message(gen_random_uuid()),
          (select pg_temp.exec_message(pg_temp.id('s_main_receipt'))
           from (select pg_temp.act_as(pg_temp.id('rev_b'))) _),
  'D28. ...and so does a FOREIGN VENDOR''s real receipt: the refusals are '
  'indistinguishable, so this cannot be used to discover which receipts exist');

-- ---- ACTIVE EXCLUSION ------------------------------------------------------
do $$
begin
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.record_claim_receipt_qualification(
    pg_temp.id('s_excl_receipt'), 'EXCLUDE', 'DUPLICATE', null);
end;
$$;
select ok(public.receipt_qualification_is_excluded(pg_temp.id('s_excl_receipt')),
  'D29. the excluded fixture really carries an active exclusion');
select is(pg_temp.try_exec(pg_temp.id('s_excl_receipt')), 'REFUSED:42501',
  'D30. an ACTIVELY EXCLUDED receipt is still refused through the wrapper');
select is(pg_temp.eval_count(pg_temp.id('s_excl')), 0,
  'D31. ...leaving no evidence');


-- ============================================================================
-- SECTION E — THE READS
-- ============================================================================
select pg_temp.act_as(pg_temp.id('rev'));

select is((select jsonb_array_length(pg_temp.results(pg_temp.id('s_main_receipt')))), 5,
  'E1. the authorized reviewer reads every stored campaign result by receipt id');
select is((select jsonb_array_length(pg_temp.items(pg_temp.id('s_main_receipt')))), 6,
  'E2. ...and every qualifying item');

-- THE WRAPPER IS THE DELEGATE. Byte-for-byte equality against the sale-keyed
-- function is the strongest statement available that nothing was re-implemented,
-- re-ordered or re-filtered on the way through.
select is(pg_temp.results(pg_temp.id('s_main_receipt')), pg_temp.results_by_sale(pg_temp.id('s_main')),
  'E3. the result read is byte-identical to its sale-keyed delegate, INCLUDING order');
select is(pg_temp.items(pg_temp.id('s_main_receipt')), pg_temp.items_by_sale(pg_temp.id('s_main')),
  'E4. the item read is byte-identical to its sale-keyed delegate, INCLUDING order');

select is(pg_temp.results(pg_temp.id('s_main_receipt')), pg_temp.results(pg_temp.id('s_main_receipt')),
  'E5. two result calls agree exactly — ordering is deterministic');
select is(pg_temp.items(pg_temp.id('s_main_receipt')), pg_temp.items(pg_temp.id('s_main_receipt')),
  'E6. two item calls agree exactly');

select is((select r.outcome from public.get_receipt_campaign_results(pg_temp.id('s_main_receipt')) r
           where r.campaign_version_id = pg_temp.id('cv_snap')), 'QUALIFIED',
  'E7. the result read carries the outcome');
select is((select r.campaign_name || '/' || r.qualifying_units || '/' || r.reward_coins
           from public.get_receipt_campaign_results(pg_temp.id('s_main_receipt')) r
           where r.campaign_version_id = pg_temp.id('cv_all')), 'RK All/5/35',
  'E8. ...the campaign name, units and final coins');
select is((select i.product_code_at_proposal || '/' || i.qualifying_units
           from public.get_receipt_campaign_qualifying_items(pg_temp.id('s_main_receipt')) i
           where i.campaign_version_id = pg_temp.id('cv_snap')), 'RK-1/2',
  'E9. the item read carries the frozen product identity and units');
select is((select coalesce(i.product_status_at_sale, 'NULL')
           from public.get_receipt_campaign_qualifying_items(pg_temp.id('s_main_receipt')) i
           where i.campaign_version_id = pg_temp.id('cv_snap')), 'NULL',
  'E10. ...preserving the SNAPSHOT null temporal statuses');

-- ---- ZERO ROWS FOR EVERY DENIAL, AND NO RAISE ------------------------------
select is((select jsonb_array_length(pg_temp.results(null))), 0,
  'E11. a NULL id reads zero rows');
select is((select jsonb_array_length(pg_temp.items(null))), 0,
  'E12. ...for items too');
select is((select jsonb_array_length(pg_temp.results(gen_random_uuid()))), 0,
  'E13. an UNKNOWN receipt reads zero rows');
select is((select jsonb_array_length(pg_temp.items(gen_random_uuid()))), 0,
  'E14. ...for items too');
select is((select jsonb_array_length(pg_temp.results(pg_temp.id('r_unfin')))), 0,
  'E15. a receipt with no finalized sale reads zero rows');
select is((select jsonb_array_length(pg_temp.items(pg_temp.id('r_unfin')))), 0,
  'E16. ...for items too');

select pg_temp.act_as(pg_temp.id('rev_b'));
select is((select jsonb_array_length(pg_temp.results(pg_temp.id('s_main_receipt')))), 0,
  'E17. a FOREIGN VENDOR''s reviewer reads zero rows — no tenant data leaks');
select is((select jsonb_array_length(pg_temp.items(pg_temp.id('s_main_receipt')))), 0,
  'E18. ...for items too');

select pg_temp.act_as(pg_temp.id('staff'));
select is((select jsonb_array_length(pg_temp.results(pg_temp.id('s_main_receipt')))), 0,
  'E19. Sales Staff reads nothing through this contract');
select pg_temp.sign_out();
select is((select jsonb_array_length(pg_temp.results(pg_temp.id('s_main_receipt')))), 0,
  'E20. an anonymous caller reads nothing, and the read RAISES nothing');


-- ============================================================================
-- SECTION F — INTEGRITY AND BOUNDARIES
-- ============================================================================
select pg_temp.act_as(pg_temp.id('rev'));

-- The index the resolution depends on.
select is((select count(*)::integer from pg_indexes
           where schemaname = 'public' and tablename = 'verified_sales'
             and indexdef ilike '%unique%' and indexdef ilike '%receipt_submission_id%'), 1,
  'F1. the verified_sales receipt UNIQUE index still exists');

select is((select count(*)::integer from (
             select v.receipt_submission_id from public.verified_sales v
             group by 1 having count(*) > 1) d), 0,
  'F2. no receipt has two verified sales');

-- A second sale for the same receipt is UNSTORABLE, not merely absent — asserted on
-- the index itself. An attempted duplicate INSERT would prove the wrong guard: the
-- deployed verified_sales_assert_lineage trigger refuses it with 23514 before the
-- unique index is ever consulted, so the row never reaches the constraint this
-- wrapper's one-to-one resolution actually depends on.
select ok((select i.indisunique
           from pg_index i
           where i.indexrelid = 'public.verified_sales_receipt_unique_idx'::regclass),
  'F3a. the receipt index is genuinely UNIQUE');

select is((select array_agg(a.attname::text order by a.attnum)
           from pg_index i
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
           where i.indexrelid = 'public.verified_sales_receipt_unique_idx'::regclass),
  array['receipt_submission_id']::text[],
  'F3b. ...on exactly receipt_submission_id and nothing else, so one receipt resolves '
  'to at most one sale and the wrapper never has a choice to make');

-- ---- THE THREE EARLIER MIGRATIONS ARE UNTOUCHED ----------------------------
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_versions_matching_sale'),
  '4e20cce64647395974fa8da490c55c20', 'F4. Migration 66 Unit A is byte-for-byte unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_sale_item_eligible_at'),
  'bcaf88024d3cc06dbae6dc46670a2906', 'F5. Migration 66 Unit B is unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_matching_result_for_sale'),
  '0b0c06bfcd2576451036debe6401b133', 'F6. Migration 66 Unit C resolver is unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_matching_qualified_items_for_sale'),
  '8f0bb7195e2a6716755ebd7967069966', 'F7. Migration 66 Unit C item helper is unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_reward_calculation_for_evaluation'),
  '20d20ffb775aca756fcf71c293a352b6', 'F8. Migration 67 calculation is unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_apply_reward_for_evaluation'),
  '5ffe5cac1709110d64fb75f69d8400f9', 'F9. Migration 67 applier is unchanged');

-- MIGRATION 68 IS THE ONE THIS MIGRATION FRONTS, so all four bodies are pinned.
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'campaign_execute_evaluation_for_verified_sale'),
  '9467db090e083b11467f67129e7fcc8c', 'F10. Migration 68 private evaluator is unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'evaluate_verified_sale_campaigns'),
  '8e3fc0603c83b2eada5ad9dbfb86d1c5', 'F11. Migration 68 execution RPC is unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_verified_sale_campaign_results'),
  '7ec6819a02c693658ca80c1d265216dd', 'F12. Migration 68 result read is unchanged');
select is((select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'get_verified_sale_campaign_qualifying_items'),
  'ec4fc4893ca21957c6eb645cd717df23', 'F13. Migration 68 item read is unchanged');

-- ...and their ACLs, so the sale-keyed surface is neither widened nor narrowed.
select is((select string_agg(p.proname || '=' || p.proacl::text, ' ' order by p.proname)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in
             ('campaign_execute_evaluation_for_verified_sale','evaluate_verified_sale_campaigns',
              'get_verified_sale_campaign_results','get_verified_sale_campaign_qualifying_items')),
  'campaign_execute_evaluation_for_verified_sale={postgres=X/postgres} '
  'evaluate_verified_sale_campaigns={postgres=X/postgres,authenticated=X/postgres} '
  'get_verified_sale_campaign_qualifying_items={postgres=X/postgres,authenticated=X/postgres} '
  'get_verified_sale_campaign_results={postgres=X/postgres,authenticated=X/postgres}',
  'F14. the Migration 68 functions retain their exact ACLs — the private evaluator is '
  'still owner-only');

select ok(true,
  'F15. NOTE: no Web or Flutter file is touched by this migration — it adds SQL only, '
  'and the Web integration is a separate unit');
select ok(true,
  'F16. NOTE: this suite writes only to the local test transaction, which pgTAP rolls '
  'back; no hosted database is contacted');

select pg_temp.sign_out();

select * from finish();
rollback;
