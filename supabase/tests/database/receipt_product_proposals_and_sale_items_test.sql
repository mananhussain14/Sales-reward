-- Tests for Phase 1D-B: the receipt product proposal, the whole-list product
-- decision, and the authoritative sale items.
--
-- Run with:  supabase test db
--
-- ============================================================================
-- WHAT THIS SUITE IS ACTUALLY PROTECTING
-- ============================================================================
-- Four properties matter more than the rest:
--
--   1. A browser can name a product and a quantity, and NOTHING else. Every
--      snapshot is copied server-side, and the table refuses a row whose snapshot
--      does not match the catalogue (Sections E and F).
--
--   2. The reviewer accepts or rejects the WHOLE list. They cannot add, remove,
--      reorder or edit a line, and the item set is copied from the proposal or
--      not created at all (Sections J and K).
--
--   3. A rejected proposal is a DURABLE record, not an absence. That is why the
--      decision table exists (Section K).
--
--   4. An active qualification exclusion fails closed at every write, in the RPC
--      AND again at the table, and a later exclusion never deletes or mutates an
--      existing decision or item (Section M).
--
-- Everything runs inside one transaction and is rolled back. Every fixture is
-- synthetic; the six real hosted receipts, the one real decision and the one real
-- TEST_DATA exclusion are never touched, and this suite runs only locally.
--
-- PGTAP RUNS IN ONE TRANSACTION AND THEREFORE CANNOT PROVE A GENUINE RACE.
-- Section P states what is and is not proven here; the true two-session races are
-- run separately against a disposable database and reported with the milestone.

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
  p_vendor uuid, p_code text, p_name text, p_barcode text default null,
  p_brand text default null, p_status text default 'ACTIVE'
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.vendor_products (
    vendor_organization_id, product_code, barcode, product_name, brand, status,
    created_by_profile_id)
  values (p_vendor, p_code, p_barcode, p_name, p_brand, p_status, pg_temp.id('vsa'))
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.assign(p_product uuid, p_retailer uuid, p_status text default 'ACTIVE')
returns void language plpgsql as $$
begin
  insert into public.vendor_product_retailer_assignments (
    vendor_product_id, retailer_organization_id, status, assigned_by_profile_id,
    assigned_at, updated_at)
  values (p_product, p_retailer, p_status, pg_temp.id('vsa'),
          now() - interval '10 days', now());
end;
$$;

create function pg_temp.new_receipt(p_retailer uuid, p_shop uuid, p_submitter uuid)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_path text;
begin
  v_path := 'pp/' || v_id::text || '.png';
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

create function pg_temp.decide(p_receipt uuid, p_vendor uuid, p_by uuid, p_decision text)
returns void language plpgsql as $$
begin
  insert into public.receipt_review_decisions
    (receipt_submission_id, vendor_organization_id, decision, rejection_reason,
     reviewer_note, decided_by_profile_id)
  values (p_receipt, p_vendor, p_decision,
          case when p_decision = 'REJECTED' then 'UNREADABLE_RECEIPT' else null end,
          null, p_by);
end;
$$;

/* One product line, as the browser would send it. */
create function pg_temp.line(p_product uuid, p_qty integer) returns jsonb
language sql immutable as $$
  select jsonb_build_object('product_id', p_product::text, 'quantity', p_qty)
$$;

/* The combined staff call, returning just the outcome. */
create function pg_temp.propose(p_receipt uuid, p_lines jsonb,
                                p_date date default date '2026-06-15',
                                p_total bigint default 12345)
returns text language sql volatile as $$
  select r.outcome from public.confirm_receipt_with_products(
    p_receipt, p_date, 'AED', 2::smallint, p_total, p_lines,
    'Test Merchant', 'DOC-1', time '14:30', 10000::bigint, 2345::bigint) r
$$;

/* Same, converting a refusal into a readable token. */
create function pg_temp.try_propose(p_receipt uuid, p_lines jsonb)
returns text language plpgsql as $$
begin
  return coalesce(pg_temp.propose(p_receipt, p_lines), 'NO_ROWS');
exception when others then
  return 'REFUSED:' || sqlstate;
end;
$$;

create function pg_temp.finalize(p_receipt uuid, p_decision text,
                                 p_reason text default null, p_note text default null)
returns text language sql volatile as $$
  select r.outcome from public.finalize_claim_receipt_sale_items(
    p_receipt, p_decision, p_reason, p_note) r
$$;

create function pg_temp.try_finalize(p_receipt uuid, p_decision text,
                                     p_reason text default null, p_note text default null)
returns text language plpgsql as $$
begin
  return coalesce(pg_temp.finalize(p_receipt, p_decision, p_reason, p_note), 'NO_ROWS');
exception when others then
  return 'REFUSED:' || sqlstate;
end;
$$;

create function pg_temp.try_sql(s text) returns text language plpgsql as $$
begin execute s; return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

create function pg_temp.items(p_receipt uuid) returns integer
language sql stable as $$
  select count(*)::integer
  from public.verified_sale_items i
  join public.receipt_product_review_decisions d on d.id = i.product_review_decision_id
  where d.receipt_submission_id = p_receipt
$$;

create function pg_temp.audit_count(p_receipt uuid, p_action text) returns integer
language sql stable as $$
  select count(*)::integer from public.audit_logs
  where entity_id = p_receipt::text and action = p_action
$$;

/* A receipt already carrying a VERIFIED decision and an authoritative header. */
create function pg_temp.ready_receipt(p_key text, p_lines jsonb) returns uuid
language plpgsql as $$
declare v uuid;
begin
  v := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values (p_key, v);
  perform pg_temp.act_as(pg_temp.id('staff'));
  perform pg_temp.propose(v, p_lines);
  perform pg_temp.decide(v, pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.finalize_claim_receipt_sale_header(v, null);
  return v;
end;
$$;

do $$
declare v_m uuid; v uuid;
begin
  insert into pg_temp.f values
    ('vendor_a',   pg_temp.new_org('PP Vendor A', 'VENDOR')),
    ('vendor_b',   pg_temp.new_org('PP Vendor B', 'VENDOR')),
    ('retailer_a', pg_temp.new_org('PP Retailer A', 'RETAILER')),
    ('retailer_b', pg_temp.new_org('PP Retailer B', 'RETAILER'));

  insert into pg_temp.f values
    ('rev',        pg_temp.new_person('PP','Rev')),
    ('rev2',       pg_temp.new_person('PP','Rev2')),
    ('revfar',     pg_temp.new_person('PP','RevFar')),
    ('vsa',        pg_temp.new_person('PP','Admin')),
    ('staff',      pg_temp.new_person('PP','Staff')),
    ('staff2',     pg_temp.new_person('PP','Staff2')),
    ('staff_gone', pg_temp.new_person('PP','Gone')),
    ('owner',      pg_temp.new_person('PP','Owner'));

  v_m := pg_temp.add_member(pg_temp.id('rev'),        pg_temp.id('vendor_a'),   'CLAIM_REVIEWER');
  v_m := pg_temp.add_member(pg_temp.id('rev2'),       pg_temp.id('vendor_a'),   'CLAIM_REVIEWER');
  v_m := pg_temp.add_member(pg_temp.id('revfar'),     pg_temp.id('vendor_b'),   'CLAIM_REVIEWER');
  v_m := pg_temp.add_member(pg_temp.id('vsa'),        pg_temp.id('vendor_a'),   'VENDOR_SUPER_ADMIN');
  v_m := pg_temp.add_member(pg_temp.id('staff'),      pg_temp.id('retailer_a'), 'SALES_STAFF');
  v_m := pg_temp.add_member(pg_temp.id('staff2'),     pg_temp.id('retailer_a'), 'SALES_STAFF');
  v_m := pg_temp.add_member(pg_temp.id('staff_gone'), pg_temp.id('retailer_a'), 'SALES_STAFF', 'DEACTIVATED');
  v_m := pg_temp.add_member(pg_temp.id('owner'),      pg_temp.id('retailer_a'), 'RETAILER_OWNER');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (pg_temp.id('vendor_a'), pg_temp.id('retailer_a'), 'ACTIVE'),
         (pg_temp.id('vendor_b'), pg_temp.id('retailer_b'), 'ACTIVE');

  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_a'), 'PP Shop', 'PPS', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop', v);
  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_a'), 'PP Closed', 'PPC', 'DEACTIVATED', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop_gone', v);
  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (pg_temp.id('retailer_b'), 'PP ShopB', 'PPB', 'ACTIVE', 'Asia/Dubai') returning id into v;
  insert into pg_temp.f values ('shop_b', v);

  -- Products. p1/p2/p3 are ACTIVE and assigned; p_inactive is not ACTIVE;
  -- p_unassigned has no assignment; p_foreign belongs to Vendor B.
  insert into pg_temp.f values
    ('p1',          pg_temp.new_product(pg_temp.id('vendor_a'), 'PP-1', 'Product One', '12345678', 'BrandA')),
    ('p2',          pg_temp.new_product(pg_temp.id('vendor_a'), 'PP-2', 'Product Two')),
    ('p3',          pg_temp.new_product(pg_temp.id('vendor_a'), 'PP-3', 'Product Three', '87654321', 'BrandC')),
    ('p_inactive',  pg_temp.new_product(pg_temp.id('vendor_a'), 'PP-OFF', 'Retired Product', null, null, 'INACTIVE')),
    ('p_unassigned',pg_temp.new_product(pg_temp.id('vendor_a'), 'PP-NA', 'Unassigned Product')),
    ('p_foreign',   pg_temp.new_product(pg_temp.id('vendor_b'), 'PP-FB', 'Other Vendor Product'));

  perform pg_temp.assign(pg_temp.id('p1'), pg_temp.id('retailer_a'));
  perform pg_temp.assign(pg_temp.id('p2'), pg_temp.id('retailer_a'));
  perform pg_temp.assign(pg_temp.id('p3'), pg_temp.id('retailer_a'));
  perform pg_temp.assign(pg_temp.id('p_inactive'), pg_temp.id('retailer_a'));
  perform pg_temp.assign(pg_temp.id('p_foreign'), pg_temp.id('retailer_b'));
end;
$$;


-- ============================================================================
-- SECTION A — THE THREE TABLES EXIST, AND ONLY THESE THREE
-- ============================================================================
select has_table('public', 'receipt_confirmation_products',    'A1. the staff proposal table exists');
select has_table('public', 'receipt_product_review_decisions', 'A2. the product decision table exists');
select has_table('public', 'verified_sale_items',              'A3. the authoritative item table exists');

select is(
  (select count(*)::integer from information_schema.tables
   where table_schema = 'public' and table_type = 'BASE TABLE'
     and table_name in ('receipt_confirmation_products',
                        'receipt_product_review_decisions', 'verified_sale_items')),
  3,
  'A4. exactly the three approved new tables'
);

-- The decision table is REQUIRED: a rejection creates zero items, so without it
-- "rejected" and "never reviewed" would be the same empty observation.
select is(
  (select count(*)::integer from information_schema.columns
   where table_schema = 'public' and table_name = 'receipt_product_review_decisions'
     and column_name = 'decision'),
  1,
  'A5. the decision is a durable column, not an Audit Log reconstruction'
);

-- No campaign, reward, coin, balance or payout column anywhere in this milestone.
select is(
  (select count(*)::integer from information_schema.columns
   where table_schema = 'public'
     and table_name in ('receipt_confirmation_products',
                        'receipt_product_review_decisions', 'verified_sale_items')
     and (column_name like '%campaign%' or column_name like '%reward%'
       or column_name like '%coin%'    or column_name like '%balance%'
       or column_name like '%payout%'  or column_name like '%ledger%'
       or column_name like '%price%'   or column_name like '%amount%'
       or column_name like '%status_current%')),
  0,
  'A6. no campaign, reward, coin, balance, payout, price or amount column'
);

-- No mutable lifecycle column that would let an immutable decision be reopened.
select is(
  (select count(*)::integer from information_schema.columns
   where table_schema = 'public' and table_name = 'receipt_product_review_decisions'
     and column_name in ('reopened_at', 'replaced_by', 'corrected_by', 'status', 'state')),
  0,
  'A7. the decision carries no reopen, replace or mutable-status column'
);

-- The approved surface, named exactly. A second proposal, decision or item table
-- appearing under any other name fails here.
select is(
  (select coalesce(string_agg(table_name, ',' order by table_name), 'NONE')::text
   from information_schema.tables
   where table_schema = 'public'
     and (table_name ilike '%confirmation_product%' or table_name ilike '%receipt_product%')),
  'receipt_confirmation_products,receipt_product_review_decisions',
  'A9. the only receipt-product tables are the approved proposal and decision tables'
);

select is(
  (select coalesce(string_agg(table_name, ',' order by table_name), 'NONE')::text
   from information_schema.tables
   where table_schema = 'public' and table_name ilike '%verified_sale%'),
  'verified_sale_items,verified_sales',
  'A10. the only sale tables are the 1D-A header and the 1D-B item table'
);

select is(
  (select count(*)::integer from information_schema.tables
   where table_schema = 'public'
     and (table_name ilike '%campaign_result%' or table_name ilike '%campaign_qualification%'
       or table_name ilike '%qualification_result%')),
  0, 'A11. no campaign-result or campaign-qualification table exists'
);

-- No product WRITE permission beyond the approved one, and no sale permission
-- beyond the two approved finalize permissions.
select is(
  (select coalesce(string_agg(code, ',' order by code), 'NONE')::text
   from public.permissions where code ~ 'SALE'),
  'RECEIPT_SALE_HEADER_FINALIZE,RECEIPT_SALE_ITEMS_FINALIZE',
  'A12. the only sale permissions are the two approved finalize permissions'
);

-- SUPERSEDED IN PART BY PHASE 2A-A: migration 65 created campaign qualification and
-- reward EVIDENCE by approval, so those four tables are excluded by name. Everything
-- that MOVES money — coin, ledger, balance, payout — stays forbidden, which is the
-- rule this assertion has always actually been protecting.
select is(
  (select count(*)::integer from information_schema.tables
   where table_schema = 'public'
     and (table_name like '%reward%' or table_name like '%coin%'
       or table_name like '%ledger%' or table_name like '%balance%'
       or table_name like '%payout%' or table_name like '%campaign_result%'
       or table_name like '%qualification_result%')
     and table_name not in ('campaign_sale_evaluations',
                            'campaign_sale_item_qualifications',
                            'campaign_rewards',
                            'campaign_subject_accumulators')),
  0,
  'A8. no coin, ledger, balance or payout table exists (Phase 2A-A evidence excepted)'
);


-- ============================================================================
-- SECTION B — COLUMNS, TYPES, NULLABILITY, DEFAULTS
-- ============================================================================
select has_column('public', 'receipt_confirmation_products', c, 'B1. proposal has ' || c)
from unnest(array[
  'id','receipt_confirmation_id','vendor_product_id','vendor_organization_id',
  'line_number','quantity','product_code_at_proposal','product_name_at_proposal',
  'barcode_at_proposal','brand_at_proposal','product_status_at_proposal','created_at'
]) as c;

select is(
  (select count(*)::integer from information_schema.columns
   where table_schema='public' and table_name='receipt_confirmation_products'),
  12,
  'B2. the proposal table has exactly twelve columns'
);

select col_type_is('public', 'receipt_confirmation_products', 'quantity', 'integer',
                   'B3. proposal quantity is an INTEGER, never numeric');
select col_type_is('public', 'verified_sale_items', 'quantity', 'integer',
                   'B4. authoritative quantity is an INTEGER, never numeric');
select col_type_is('public', 'receipt_confirmation_products', 'line_number', 'integer',
                   'B5. proposal line_number is an integer');

select col_not_null('public', 'receipt_confirmation_products', c, 'B6. NOT NULL: ' || c)
from unnest(array['receipt_confirmation_id','vendor_product_id','vendor_organization_id',
                  'line_number','quantity','product_code_at_proposal',
                  'product_name_at_proposal','product_status_at_proposal','created_at']) as c;

select col_is_null('public', 'receipt_confirmation_products', 'barcode_at_proposal',
                   'B7. the barcode snapshot stays nullable, as the catalogue is');
select col_is_null('public', 'receipt_confirmation_products', 'brand_at_proposal',
                   'B8. the brand snapshot stays nullable');
select col_is_null('public', 'verified_sale_items', 'barcode_at_proposal',
                   'B9. the authoritative barcode snapshot stays nullable');

select col_has_default('public', 'receipt_confirmation_products', 'created_at',
                       'B10. proposal created_at defaults');
select col_has_default('public', 'receipt_product_review_decisions', 'decided_at',
                       'B11. decision decided_at defaults');

select has_column('public', 'receipt_product_review_decisions', c, 'B12. decision has ' || c)
from unnest(array[
  'id','receipt_submission_id','receipt_confirmation_id','verified_sale_id',
  'vendor_organization_id','decision','rejection_reason','reviewer_note',
  'decided_by_profile_id','decided_at','created_at'
]) as c;

select has_column('public', 'verified_sale_items', c, 'B13. item has ' || c)
from unnest(array[
  'id','verified_sale_id','product_review_decision_id','receipt_confirmation_product_id',
  'vendor_product_id','vendor_organization_id','line_number','quantity',
  'product_code_at_proposal','product_name_at_proposal','barcode_at_proposal',
  'brand_at_proposal','product_status_at_proposal','created_at'
]) as c;

-- Reviewer identity is reachable through the decision, and deliberately NOT
-- duplicated per item, where copies could only ever disagree with it.
select is(
  (select count(*)::integer from information_schema.columns
   where table_schema='public' and table_name='verified_sale_items'
     and column_name in ('decided_by_profile_id','decided_at','finalized_by_profile_id')),
  0,
  'B14. an item does not duplicate reviewer identity or decision time'
);


-- ============================================================================
-- SECTION C — FOREIGN KEYS ARE ALL RESTRICT
-- ============================================================================
select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.receipt_confirmation_products'::regclass
     and contype = 'f' and confdeltype <> 'r'),
  0,
  'C1. every proposal foreign key is ON DELETE RESTRICT'
);
select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.receipt_product_review_decisions'::regclass
     and contype = 'f' and confdeltype <> 'r'),
  0,
  'C2. every decision foreign key is ON DELETE RESTRICT'
);
select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.verified_sale_items'::regclass
     and contype = 'f' and confdeltype <> 'r'),
  0,
  'C3. every authoritative item foreign key is ON DELETE RESTRICT'
);

select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.receipt_confirmation_products'::regclass and contype = 'f'),
  3, 'C4. the proposal has its three foreign keys');
select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.receipt_product_review_decisions'::regclass and contype = 'f'),
  5, 'C5. the decision has its five foreign keys');
select is(
  (select count(*)::integer from pg_constraint
   where conrelid = 'public.verified_sale_items'::regclass and contype = 'f'),
  5, 'C6. the authoritative item has its five foreign keys');


-- ============================================================================
-- SECTION D — UNIQUENESS AND INDEXES
-- ============================================================================
select has_index('public', 'receipt_confirmation_products',
                 'receipt_confirmation_products_line_unique_idx',
                 'D1. deterministic ordering is enforced by a unique index');
select has_index('public', 'receipt_confirmation_products',
                 'receipt_confirmation_products_product_unique_idx',
                 'D2. a product may appear once per proposal');
select has_index('public', 'receipt_product_review_decisions',
                 'receipt_product_review_decisions_submission_unique_idx',
                 'D3. one decision per receipt');
select has_index('public', 'receipt_product_review_decisions',
                 'receipt_product_review_decisions_confirmation_unique_idx',
                 'D4. one decision per confirmation');
select has_index('public', 'receipt_product_review_decisions',
                 'receipt_product_review_decisions_sale_unique_idx',
                 'D5. one decision per authoritative sale');
select has_index('public', 'verified_sale_items',
                 'verified_sale_items_line_unique_idx',
                 'D6. one item per sale line number');
select has_index('public', 'verified_sale_items',
                 'verified_sale_items_product_unique_idx',
                 'D7. one item per product per sale');
select has_index('public', 'verified_sale_items',
                 'verified_sale_items_proposal_unique_idx',
                 'D8. a proposal line can be promoted at most once');
select has_index('public', 'verified_sale_items', 'verified_sale_items_product_idx',
                 'D9. product lookup exists for the future campaign engine');

-- No duplicate index definitions across the three new tables.
select is(
  (select count(*)::integer from (
     select indexdef, count(*) c
     from pg_indexes
     where schemaname = 'public'
       and tablename in ('receipt_confirmation_products',
                         'receipt_product_review_decisions', 'verified_sale_items')
     group by indexdef having count(*) > 1) dup),
  0,
  'D10. no duplicate index is provisioned'
);


-- ============================================================================
-- SECTION E — PERMISSIONS AND ROLE MAPPINGS
-- ============================================================================
select is(
  (select count(*)::integer from public.permissions
   where code in ('RECEIPT_PRODUCT_PROPOSE','RECEIPT_SALE_ITEMS_FINALIZE')),
  2, 'E1. exactly the two new permissions exist');

select is((select module from public.permissions where code = 'RECEIPT_PRODUCT_PROPOSE'),
          'RECEIPTS', 'E2. RECEIPT_PRODUCT_PROPOSE is a RECEIPTS permission');
select is((select module from public.permissions where code = 'RECEIPT_SALE_ITEMS_FINALIZE'),
          'CLAIM_REVIEW', 'E3. RECEIPT_SALE_ITEMS_FINALIZE is a CLAIM_REVIEW permission');

select is(
  (select array_agg(r.code order by r.code) from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RECEIPT_PRODUCT_PROPOSE'),
  array['SALES_STAFF'],
  'E4. RECEIPT_PRODUCT_PROPOSE is mapped to SALES_STAFF and nothing else'
);
select is(
  (select array_agg(r.code order by r.code) from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RECEIPT_SALE_ITEMS_FINALIZE'),
  array['CLAIM_REVIEWER'],
  'E5. RECEIPT_SALE_ITEMS_FINALIZE is mapped to CLAIM_REVIEWER and nothing else'
);

select is(
  (select array_agg(p.code order by p.code) from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'CLAIM_REVIEWER'),
  -- SUPERSEDED IN PART BY PHASE 2A-D [20260826090000]: the approved campaign-evaluation
  -- permission joined the reviewer's set. Still pinned EXACTLY, so an eighth fails here.
  array['CAMPAIGN_EVALUATION_EXECUTE','CLAIM_REVIEW_PORTAL_READ',
        'RECEIPT_QUALIFICATION_CLASSIFY','RECEIPT_REVIEW_DECIDE','RECEIPT_REVIEW_READ',
        'RECEIPT_SALE_HEADER_FINALIZE','RECEIPT_SALE_ITEMS_FINALIZE'],
  'E6. the Claim Reviewer permission set is exactly these seven'
);

-- Sales Staff keeps the header-confirmation permission it already had; the new
-- one is added beside it, never instead of it.
select ok(
  exists (select 1 from public.role_permissions rp
          join public.roles r on r.id = rp.role_id
          join public.permissions p on p.id = rp.permission_id
          where r.code = 'SALES_STAFF' and p.code = 'RECEIPT_EXTRACTION_REVIEW'),
  'E7. Sales Staff still holds the existing header-confirmation permission'
);
select is(
  (select array_agg(p.code order by p.code) from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'SALES_STAFF'),
  array['RECEIPT_EXTRACTION_REVIEW','RECEIPT_PRODUCT_PROPOSE','RECEIPT_PRODUCTS_READ',
        'RECEIPT_SUBMIT','RETAILER_PORTAL_READ','STAFF_CAMPAIGNS_VIEW',
        -- Added by approval in Migration 70 (20260828090000): the seller's own
        -- earnings. It is a READ of rewards already awarded and carries no ability to
        -- submit, propose, review or evaluate anything.
        'STAFF_EARNINGS_VIEW'],
  'E8. the Sales Staff permission set is exactly these seven'
);

-- No other role picked either permission up.
select is(
  (select count(*)::integer from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code in ('RECEIPT_PRODUCT_PROPOSE','RECEIPT_SALE_ITEMS_FINALIZE')
     and r.code not in ('SALES_STAFF','CLAIM_REVIEWER')),
  0, 'E9. neither new permission leaked to another role');

-- No additional product WRITE permission was invented.
select is(
  (select count(*)::integer from public.permissions
   where code like '%PRODUCT%'
     and code not in ('PRODUCTS_MANAGE','PRODUCTS_READ','PRODUCT_RETAILER_ASSIGN',
                      'RECEIPT_PRODUCTS_READ','RETAILER_PRODUCTS_READ',
                      'RECEIPT_PRODUCT_PROPOSE')),
  0, 'E10. no extra product permission was created');


-- ============================================================================
-- SECTION F — RLS, POLICIES AND DIRECT PRIVILEGES
-- ============================================================================
select is(
  (select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('receipt_confirmation_products',
                       'receipt_product_review_decisions','verified_sale_items')
     and c.relrowsecurity),
  3, 'F1. row level security is enabled on all three tables');

select is(
  (select count(*)::integer from pg_policies where schemaname = 'public'
   and tablename in ('receipt_confirmation_products',
                     'receipt_product_review_decisions','verified_sale_items')),
  0, 'F2. the three tables carry ZERO policies');

select is(
  (select count(*)::integer from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('receipt_confirmation_products',
                        'receipt_product_review_decisions','verified_sale_items')
     and grantee in ('PUBLIC','anon','authenticated','service_role')),
  0,
  'F3. PUBLIC, anon, authenticated and service_role hold NO direct table privilege'
);

select is(
  (select count(*)::integer from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('receipt_confirmation_products',
                        'receipt_product_review_decisions','verified_sale_items')
     and grantee in ('PUBLIC','anon','authenticated','service_role')
     and privilege_type in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES')),
  0,
  'F4. no SELECT, INSERT, UPDATE, DELETE, TRUNCATE or REFERENCES is granted'
);

-- Every new function is SECURITY DEFINER with an empty search_path, and none
-- builds SQL from a string.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('confirm_receipt_with_products','get_my_receipt_product_proposal',
                       'get_claim_receipt_product_context','finalize_claim_receipt_sale_items',
                       'get_verified_sale_items','receipt_has_finalized_sale_items',
                       'receipt_confirmation_products_assert_line',
                       'receipt_product_review_decisions_assert_decision',
                       'verified_sale_items_assert_item',
                       'receipt_confirmation_products_guard_change',
                       'receipt_confirmation_products_guard_truncate',
                       'receipt_product_review_decisions_guard_change',
                       'receipt_product_review_decisions_guard_truncate',
                       'verified_sale_items_guard_change',
                       'verified_sale_items_guard_truncate')
     and not p.prosecdef),
  0, 'F5. every new function is SECURITY DEFINER');

select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('confirm_receipt_with_products','get_my_receipt_product_proposal',
                       'get_claim_receipt_product_context','finalize_claim_receipt_sale_items',
                       'get_verified_sale_items','receipt_has_finalized_sale_items',
                       'receipt_confirmation_products_assert_line',
                       'receipt_product_review_decisions_assert_decision',
                       'verified_sale_items_assert_item')
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, array[]::text[])) cfg
       where cfg in ('search_path=', 'search_path=""'))),
  0, 'F6. every new function pins an EMPTY search_path');

select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('confirm_receipt_with_products','get_my_receipt_product_proposal',
                       'get_claim_receipt_product_context','finalize_claim_receipt_sale_items',
                       'get_verified_sale_items','receipt_has_finalized_sale_items',
                       'receipt_confirmation_products_assert_line',
                       'receipt_product_review_decisions_assert_decision',
                       'verified_sale_items_assert_item')
     and p.prosrc ~* '\mexecute\M'),
  0, 'F7. no new function builds or executes dynamic SQL');

-- The four browser RPCs are executable by authenticated only; the campaign oracle
-- and every trigger function are executable by nobody but the owner.
select is(
  (select array_agg(distinct g.grantee::text order by g.grantee::text)
   from information_schema.role_routine_grants g
   where g.specific_schema = 'public'
     and g.routine_name in ('confirm_receipt_with_products','get_my_receipt_product_proposal',
                            'get_claim_receipt_product_context',
                            'finalize_claim_receipt_sale_items','get_verified_sale_items')
     and g.grantee in ('anon','authenticated','service_role','PUBLIC')),
  array['authenticated'],
  'F8. the five browser RPCs are granted to authenticated and to no other browser role'
);

select is(
  (select count(*)::integer from information_schema.role_routine_grants g
   where g.specific_schema = 'public'
     and g.routine_name = 'receipt_has_finalized_sale_items'
     and g.grantee in ('anon','authenticated','service_role','PUBLIC')),
  0, 'F9. the future campaign oracle is NOT browser-executable');

select is(
  (select count(*)::integer from information_schema.role_routine_grants g
   where g.specific_schema = 'public'
     and g.routine_name in ('receipt_confirmation_products_assert_line',
                            'receipt_product_review_decisions_assert_decision',
                            'verified_sale_items_assert_item',
                            'receipt_confirmation_products_guard_change',
                            'verified_sale_items_guard_change')
     and g.grantee in ('anon','authenticated','service_role','PUBLIC')),
  0, 'F10. no trigger or assertion function is browser-executable');


-- ============================================================================
-- SECTION G — THE JSON INPUT CONTRACT
-- ============================================================================
-- Every one of these is a REAL CALL. The browser can name a product and a
-- quantity; anything else is refused before a row exists.
do $$
declare r uuid;
begin
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_json', r);
  perform pg_temp.act_as(pg_temp.id('staff'));
end;
$$;

select is(pg_temp.try_propose(pg_temp.id('r_json'), 'null'::jsonb),
          'REFUSED:22023', 'G1. a null product list is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'), '{}'::jsonb),
          'REFUSED:22023', 'G2. an object instead of an array is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'), '"x"'::jsonb),
          'REFUSED:22023', 'G3. a string instead of an array is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'), '[]'::jsonb),
          'REFUSED:22023', 'G4. an EMPTY product list is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'), jsonb_build_array('x')),
          'REFUSED:22023', 'G5. a non-object element is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('quantity', 1))),
          'REFUSED:22023', 'G6. a missing product_id is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('p1')::text))),
          'REFUSED:22023', 'G7. a missing quantity is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('p1')::text,
                                               'quantity', 1, 'line_number', 9))),
          'REFUSED:22023', 'G8. an UNKNOWN key is refused, never ignored');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('p1')::text,
                                               'quantity', 1, 'product_name', 'Fake'))),
          'REFUSED:22023', 'G9. a client-supplied product_name is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', 'not-a-uuid', 'quantity', 1))),
          'REFUSED:22023', 'G10. a malformed product_id is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', null, 'quantity', 1))),
          'REFUSED:22023', 'G11. a null product_id is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('p1')::text,
                                               'quantity', null))),
          'REFUSED:22023', 'G12. a null quantity is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('p1')::text,
                                               'quantity', 0))),
          'REFUSED:22023', 'G13. quantity 0 is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('p1')::text,
                                               'quantity', 101))),
          'REFUSED:22023', 'G14. quantity 101 is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('p1')::text,
                                               'quantity', 2.5))),
          'REFUSED:22023', 'G15. a DECIMAL quantity is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('p1')::text,
                                               'quantity', '2'))),
          'REFUSED:22023', 'G16. a STRING quantity is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(jsonb_build_object('product_id', pg_temp.id('p1')::text,
                                               'quantity', true))),
          'REFUSED:22023', 'G17. a BOOLEAN quantity is refused');
select is(pg_temp.try_propose(pg_temp.id('r_json'),
          jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1),
                            pg_temp.line(pg_temp.id('p1'), 2))),
          'REFUSED:22023', 'G18. a DUPLICATE product is refused, never merged');

-- Nothing above created anything.
select is((select count(*)::integer from public.receipt_confirmations
           where receipt_submission_id = pg_temp.id('r_json')),
          0, 'G19. no confirmation survived a rejected product list');
select is((select count(*)::integer from public.receipt_confirmation_products),
          0, 'G20. no proposal line survived a rejected product list');

-- Boundaries that must be ACCEPTED.
do $$
declare r uuid; v_lines jsonb := '[]'::jsonb; i integer; p uuid;
begin
  perform pg_temp.act_as(pg_temp.id('staff'));

  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_one', r);

  -- 50 distinct assigned products, for the upper boundary.
  for i in 1..51 loop
    p := pg_temp.new_product(pg_temp.id('vendor_a'), 'BULK-' || i, 'Bulk Product ' || i);
    perform pg_temp.assign(p, pg_temp.id('retailer_a'));
    v_lines := v_lines || jsonb_build_array(pg_temp.line(p, 1));
  end loop;
  insert into pg_temp.f values ('bulk51', gen_random_uuid());
  create temp table bulk_lines as select v_lines as lines;
end;
$$;

select is(pg_temp.try_propose(pg_temp.id('r_one'),
          jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1))),
          'CONFIRMED', 'G21. a single-line proposal is accepted');
select is((select count(*)::integer from public.receipt_confirmation_products),
          1, 'G22. exactly one proposal line was stored');

do $$
declare r uuid;
begin
  perform pg_temp.act_as(pg_temp.id('staff'));
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_51', r);
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_50', r);
end;
$$;

select is(
  pg_temp.try_propose(pg_temp.id('r_51'), (select lines from bulk_lines)),
  'REFUSED:22023', 'G23. a 51-line proposal is refused');

select is(
  pg_temp.try_propose(pg_temp.id('r_50'),
    (select jsonb_agg(e) from (
       select e from jsonb_array_elements((select lines from bulk_lines)) with ordinality as t(e, o)
       where o <= 50) x)),
  'CONFIRMED', 'G24. a 50-line proposal is accepted');

select is(
  (select count(*)::integer from public.receipt_confirmation_products rcp
   join public.receipt_confirmations c on c.id = rcp.receipt_confirmation_id
   where c.receipt_submission_id = pg_temp.id('r_50')),
  50, 'G25. all fifty lines were stored');

-- Array order becomes line_number, so the proposal reads back as entered.
select is(
  (select array_agg(rcp.line_number order by rcp.line_number)
   from public.receipt_confirmation_products rcp
   join public.receipt_confirmations c on c.id = rcp.receipt_confirmation_id
   where c.receipt_submission_id = pg_temp.id('r_one')),
  array[1],
  'G26. line numbers start at 1 and come from array order'
);


-- ============================================================================
-- SECTION H — PRODUCT ELIGIBILITY AND SERVER-SIDE SNAPSHOTS
-- ============================================================================
do $$
declare r uuid;
begin
  perform pg_temp.act_as(pg_temp.id('staff'));
  foreach r in array array[]::uuid[] loop end loop;
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_elig', r);
end;
$$;

select is(pg_temp.try_propose(pg_temp.id('r_elig'),
          jsonb_build_array(pg_temp.line(pg_temp.id('p_inactive'), 1))),
          'REFUSED:22023', 'H1. an INACTIVE product is refused at proposal time');
select is(pg_temp.try_propose(pg_temp.id('r_elig'),
          jsonb_build_array(pg_temp.line(pg_temp.id('p_unassigned'), 1))),
          'REFUSED:22023', 'H2. an UNASSIGNED product is refused');
select is(pg_temp.try_propose(pg_temp.id('r_elig'),
          jsonb_build_array(pg_temp.line(pg_temp.id('p_foreign'), 1))),
          'REFUSED:22023', 'H3. another Vendor''s product is refused');
select is(pg_temp.try_propose(pg_temp.id('r_elig'),
          jsonb_build_array(pg_temp.line(gen_random_uuid(), 1))),
          'REFUSED:22023',
          'H4. a nonexistent product is refused with the SAME message as a foreign one');

-- The snapshot is the catalogue, copied by the database.
do $$
declare r uuid;
begin
  perform pg_temp.act_as(pg_temp.id('staff'));
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_snap', r);
  perform pg_temp.propose(r, jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 3),
                                               pg_temp.line(pg_temp.id('p2'), 7)));
end;
$$;

select is(
  (select array[product_code_at_proposal, product_name_at_proposal,
                barcode_at_proposal, brand_at_proposal, product_status_at_proposal]
   from public.receipt_confirmation_products rcp
   join public.receipt_confirmations c on c.id = rcp.receipt_confirmation_id
   where c.receipt_submission_id = pg_temp.id('r_snap') and rcp.line_number = 1),
  array['PP-1','Product One','12345678','BrandA','ACTIVE'],
  'H5. every snapshot field was copied from the catalogue server-side'
);

select is(
  (select array[barcode_at_proposal, brand_at_proposal]
   from public.receipt_confirmation_products rcp
   join public.receipt_confirmations c on c.id = rcp.receipt_confirmation_id
   where c.receipt_submission_id = pg_temp.id('r_snap') and rcp.line_number = 2),
  array[null, null]::text[],
  'H6. a null barcode and brand are preserved as nulls, not blanks'
);

select is(
  (select quantity from public.receipt_confirmation_products rcp
   join public.receipt_confirmations c on c.id = rcp.receipt_confirmation_id
   where c.receipt_submission_id = pg_temp.id('r_snap') and rcp.line_number = 2),
  7, 'H7. the submitted quantity was stored exactly');

-- A later rename or deactivation must not reach back into the proposal.
do $$
begin
  update public.vendor_products
  set product_name = 'Renamed Product', brand = 'BrandZ', status = 'INACTIVE'
  where id = pg_temp.id('p1');
end;
$$;

select is(
  (select array[product_name_at_proposal, brand_at_proposal, product_status_at_proposal]
   from public.receipt_confirmation_products rcp
   join public.receipt_confirmations c on c.id = rcp.receipt_confirmation_id
   where c.receipt_submission_id = pg_temp.id('r_snap') and rcp.line_number = 1),
  array['Product One','BrandA','ACTIVE'],
  'H8. a later rename, rebrand and deactivation do NOT change the frozen proposal'
);

do $$
begin
  update public.vendor_products
  set product_name = 'Product One', brand = 'BrandA', status = 'ACTIVE'
  where id = pg_temp.id('p1');
end;
$$;

-- A direct insert cannot substitute a snapshot, even bypassing the RPC.
select is(
  pg_temp.try_sql(format($f$
    insert into public.receipt_confirmation_products (
      receipt_confirmation_id, vendor_product_id, vendor_organization_id,
      line_number, quantity, product_code_at_proposal, product_name_at_proposal,
      barcode_at_proposal, brand_at_proposal, product_status_at_proposal)
    values (%L, %L, %L, 9, 1, 'PP-1', 'Something Else', '12345678', 'BrandA', 'ACTIVE')$f$,
    (select c.id from public.receipt_confirmations c
     where c.receipt_submission_id = pg_temp.id('r_snap')),
    pg_temp.id('p1'), pg_temp.id('vendor_a'))),
  'REFUSED:23514',
  'H9. a direct insert cannot substitute a product NAME'
);

select is(
  pg_temp.try_sql(format($f$
    insert into public.receipt_confirmation_products (
      receipt_confirmation_id, vendor_product_id, vendor_organization_id,
      line_number, quantity, product_code_at_proposal, product_name_at_proposal,
      barcode_at_proposal, brand_at_proposal, product_status_at_proposal)
    values (%L, %L, %L, 9, 1, 'FAKE-CODE', 'Product One', '99999999', 'BrandX', 'ACTIVE')$f$,
    (select c.id from public.receipt_confirmations c
     where c.receipt_submission_id = pg_temp.id('r_snap')),
    pg_temp.id('p1'), pg_temp.id('vendor_a'))),
  'REFUSED:23514',
  'H10. a direct insert cannot substitute a code, barcode or brand'
);

select is(
  pg_temp.try_sql(format($f$
    insert into public.receipt_confirmation_products (
      receipt_confirmation_id, vendor_product_id, vendor_organization_id,
      line_number, quantity, product_code_at_proposal, product_name_at_proposal,
      barcode_at_proposal, brand_at_proposal, product_status_at_proposal)
    values (%L, %L, %L, 9, 1, 'PP-FB', 'Other Vendor Product', null, null, 'ACTIVE')$f$,
    (select c.id from public.receipt_confirmations c
     where c.receipt_submission_id = pg_temp.id('r_snap')),
    pg_temp.id('p_foreign'), pg_temp.id('vendor_b'))),
  'REFUSED:23514',
  'H11. a direct insert cannot attach a FOREIGN Vendor''s product'
);


-- ============================================================================
-- SECTION I — THE ATOMIC STAFF WRITE, AND ITS OUTCOMES
-- ============================================================================
select is(
  (select count(*)::integer from public.receipt_confirmations
   where receipt_submission_id = pg_temp.id('r_snap')),
  1, 'I1. exactly one confirmation was created');
select is(pg_temp.audit_count(pg_temp.id('r_snap'), 'RECEIPT_PRODUCTS_PROPOSED'),
          1, 'I2. exactly one proposal Audit Log was written');

-- The Audit Log carries counts, and no product identity of any kind.
select is(
  (select array_agg(k order by k) from (
     select jsonb_object_keys(metadata) k from public.audit_logs
     where entity_id = pg_temp.id('r_snap')::text
       and action = 'RECEIPT_PRODUCTS_PROPOSED') x),
  array['distinct_product_count','line_count','total_quantity'],
  'I3. the proposal Audit Log carries exactly three safe metadata keys'
);
select is(
  (select (metadata ->> 'total_quantity')::integer from public.audit_logs
   where entity_id = pg_temp.id('r_snap')::text
     and action = 'RECEIPT_PRODUCTS_PROPOSED'),
  10, 'I4. total_quantity is the sum of the proposed quantities');
select is(
  (select entity_type from public.audit_logs
   where entity_id = pg_temp.id('r_snap')::text
     and action = 'RECEIPT_PRODUCTS_PROPOSED'),
  'RECEIPT_SUBMISSION', 'I5. the proposal Audit Log names the receipt as its entity');
select is(
  (select organization_id from public.audit_logs
   where entity_id = pg_temp.id('r_snap')::text
     and action = 'RECEIPT_PRODUCTS_PROPOSED'),
  pg_temp.id('retailer_a'), 'I6. the proposal Audit Log belongs to the RETAILER');

-- An invalid line rolls back the confirmation as well.
do $$
declare r uuid;
begin
  perform pg_temp.act_as(pg_temp.id('staff'));
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_rollback', r);
end;
$$;

select is(
  pg_temp.try_propose(pg_temp.id('r_rollback'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1),
                      pg_temp.line(pg_temp.id('p_inactive'), 1))),
  'REFUSED:22023', 'I7. one invalid line refuses the whole submission');
select is(
  (select count(*)::integer from public.receipt_confirmations
   where receipt_submission_id = pg_temp.id('r_rollback')),
  0, 'I8. the header did NOT survive the invalid line');
select is(pg_temp.audit_count(pg_temp.id('r_rollback'), 'RECEIPT_PRODUCTS_PROPOSED'),
          0, 'I9. no Audit Log survived the invalid line');

-- Retry, conflict, and the legacy header-only confirmation.
select is(
  pg_temp.try_propose(pg_temp.id('r_snap'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 3), pg_temp.line(pg_temp.id('p2'), 7))),
  'ALREADY_CONFIRMED', 'I10. the exact same retry is idempotent');
select is(
  (select count(*)::integer from public.receipt_confirmation_products rcp
   join public.receipt_confirmations c on c.id = rcp.receipt_confirmation_id
   where c.receipt_submission_id = pg_temp.id('r_snap')),
  2, 'I11. the retry created no duplicate line');
select is(pg_temp.audit_count(pg_temp.id('r_snap'), 'RECEIPT_PRODUCTS_PROPOSED'),
          1, 'I12. the retry wrote no second Audit Log');

select is(
  pg_temp.try_propose(pg_temp.id('r_snap'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 3), pg_temp.line(pg_temp.id('p2'), 8))),
  'CONFLICT', 'I13. a changed QUANTITY conflicts');
select is(
  pg_temp.try_propose(pg_temp.id('r_snap'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p2'), 7), pg_temp.line(pg_temp.id('p1'), 3))),
  'CONFLICT', 'I14. a changed ORDER conflicts');
select is(
  pg_temp.try_propose(pg_temp.id('r_snap'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 3))),
  'CONFLICT', 'I15. a shortened list conflicts');

select is(
  (select r.outcome from public.confirm_receipt_with_products(
     pg_temp.id('r_snap'), date '2026-06-16', 'AED', 2::smallint, 12345::bigint,
     jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 3), pg_temp.line(pg_temp.id('p2'), 7)),
     'Test Merchant', 'DOC-1', time '14:30', 10000::bigint, 2345::bigint) r),
  'CONFLICT', 'I16. a changed HEADER date conflicts');

select is(
  (select r.outcome from public.confirm_receipt_with_products(
     pg_temp.id('r_snap'), date '2026-06-15', 'AED', 2::smallint, 99999::bigint,
     jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 3), pg_temp.line(pg_temp.id('p2'), 7)),
     'Test Merchant', 'DOC-1', time '14:30', 10000::bigint, 2345::bigint) r),
  'CONFLICT', 'I17. a changed TOTAL conflicts');

-- A header confirmed through the OLD header-only RPC cannot be topped up.
do $$
declare r uuid;
begin
  perform pg_temp.act_as(pg_temp.id('staff'));
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_legacy', r);
  perform public.confirm_receipt_extraction(
    r, date '2026-06-15', 'AED', 2::smallint, 12345::bigint,
    'Test Merchant', 'DOC-1', time '14:30', 10000::bigint, 2345::bigint);
end;
$$;

select is(
  pg_temp.try_propose(pg_temp.id('r_legacy'),
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1))),
  'CONFLICT', 'I18. a header-only confirmation cannot acquire a proposal later');
select is(
  (select count(*)::integer from public.receipt_confirmation_products rcp
   join public.receipt_confirmations c on c.id = rcp.receipt_confirmation_id
   where c.receipt_submission_id = pg_temp.id('r_legacy')),
  0, 'I19. and no line was added to it');

-- The deployed header-only RPC still works untouched.
select is(
  (select count(*)::integer from public.receipt_confirmations
   where receipt_submission_id = pg_temp.id('r_legacy')),
  1, 'I20. confirm_receipt_extraction still creates a header-only confirmation');

-- Oracle safety on the staff side: someone else's receipt is silence, not an error.
do $$
begin perform pg_temp.act_as(pg_temp.id('staff2')); end;
$$;
select is(pg_temp.try_propose(pg_temp.id('r_one'),
          jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1))),
          'NO_ROWS', 'I21. another staff member''s receipt returns zero rows');
select is(pg_temp.try_propose(gen_random_uuid(),
          jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1))),
          'NO_ROWS', 'I22. a nonexistent receipt is indistinguishable from it');

do $$
begin perform pg_temp.act_as(pg_temp.id('owner')); end;
$$;
select is(pg_temp.try_propose(pg_temp.id('r_one'),
          jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1))),
          'REFUSED:42501', 'I23. a Retailer Owner may not propose products');
do $$
begin perform pg_temp.act_as(pg_temp.id('rev')); end;
$$;
select is(pg_temp.try_propose(pg_temp.id('r_one'),
          jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1))),
          'REFUSED:42501', 'I24. a Claim Reviewer may not propose products');


-- ============================================================================
-- SECTION J — THE STAFF PROPOSAL READ
-- ============================================================================
do $$
begin perform pg_temp.act_as(pg_temp.id('staff')); end;
$$;
select is((select count(*)::integer from public.get_my_receipt_product_proposal(pg_temp.id('r_snap'))),
          2, 'J1. staff can read back their own proposal');
select is(
  (select product_name_at_proposal from public.get_my_receipt_product_proposal(pg_temp.id('r_snap'))
   where line_number = 1),
  'Product One', 'J2. the read returns the frozen snapshot');

do $$
begin perform pg_temp.act_as(pg_temp.id('staff2')); end;
$$;
select is((select count(*)::integer from public.get_my_receipt_product_proposal(pg_temp.id('r_snap'))),
          0, 'J3. another staff member reads zero rows');
select is((select count(*)::integer from public.get_my_receipt_product_proposal(gen_random_uuid())),
          0, 'J4. a nonexistent receipt reads zero rows, identically');

-- The read exposes no internal identifier of any kind.
select is(
  (select count(*)::integer
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_my_receipt_product_proposal'
     and pg_get_function_result(p.oid) ~* '(vendor_organization_id|receipt_confirmation_id|vendor_product_id|_id uuid)'),
  0, 'J6. the staff proposal read returns no internal id column');


-- ============================================================================
-- SECTION K — THE WHOLE-LIST DECISION
-- ============================================================================
do $$
begin
  perform pg_temp.ready_receipt('r_accept',
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 2), pg_temp.line(pg_temp.id('p2'), 3)));
  perform pg_temp.ready_receipt('r_reject',
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1)));
  perform pg_temp.ready_receipt('r_other',
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1)));
  perform pg_temp.ready_receipt('r_conf',
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1)));
  perform pg_temp.ready_receipt('r_deact',
    jsonb_build_array(pg_temp.line(pg_temp.id('p3'), 4)));
  perform pg_temp.act_as(pg_temp.id('rev'));
end;
$$;

-- ---- Decision-input validation ----------------------------------------------
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'ACCEPTED', 'ILLEGIBLE', null),
          'REFUSED:22023', 'K1. an acceptance carrying a rejection reason is refused');
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'ACCEPTED', null, 'a note'),
          'REFUSED:22023', 'K2. an acceptance carrying a note is refused');
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'REJECTED', null, null),
          'REFUSED:22023', 'K3. a rejection with no reason is refused');
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'REJECTED', 'NOT_A_REASON', null),
          'REFUSED:22023', 'K4. an unrecognised rejection reason is refused');
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'MAYBE', null, null),
          'REFUSED:22023', 'K5. an unrecognised decision is refused');
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'REJECTED', 'OTHER', null),
          'REFUSED:22023', 'K6. OTHER with no note is refused');
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'REJECTED', 'OTHER', '   '),
          'REFUSED:22023', 'K7. OTHER with a whitespace-only note is refused');
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'REJECTED', 'ILLEGIBLE', repeat('x', 501)),
          'REFUSED:22023', 'K8. a note longer than 500 characters is refused');

select is((select count(*)::integer from public.receipt_product_review_decisions),
          0, 'K9. no decision survived any rejected input');

-- ---- Acceptance --------------------------------------------------------------
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'ACCEPTED'),
          'ACCEPTED', 'K10. a VERIFIED, confirmed, proposed receipt can be accepted');
select is(
  (select count(*)::integer from public.receipt_product_review_decisions
   where receipt_submission_id = pg_temp.id('r_accept')),
  1, 'K11. acceptance created exactly one decision');
select is(pg_temp.items(pg_temp.id('r_accept')), 2,
          'K12. every proposal line became an authoritative item');
select is(pg_temp.audit_count(pg_temp.id('r_accept'), 'SALE_ITEMS_ACCEPTED'),
          1, 'K13. acceptance wrote exactly one Audit Log');

select is(
  (select array_agg(i.quantity order by i.line_number)
   from public.verified_sale_items i
   join public.receipt_product_review_decisions d on d.id = i.product_review_decision_id
   where d.receipt_submission_id = pg_temp.id('r_accept')),
  array[2, 3],
  'K14. quantities were copied exactly, in proposal order'
);
select is(
  (select array_agg(i.product_name_at_proposal order by i.line_number)
   from public.verified_sale_items i
   join public.receipt_product_review_decisions d on d.id = i.product_review_decision_id
   where d.receipt_submission_id = pg_temp.id('r_accept')),
  array['Product One','Product Two'],
  'K15. every snapshot was copied exactly'
);

select is(
  (select array_agg(k order by k) from (
     select jsonb_object_keys(metadata) k from public.audit_logs
     where entity_id = pg_temp.id('r_accept')::text and action = 'SALE_ITEMS_ACCEPTED') x),
  array['line_count','total_quantity'],
  'K16. the acceptance Audit Log carries exactly two safe metadata keys'
);
select is(
  (select organization_id from public.audit_logs
   where entity_id = pg_temp.id('r_accept')::text and action = 'SALE_ITEMS_ACCEPTED'),
  pg_temp.id('vendor_a'), 'K17. the acceptance Audit Log belongs to the VENDOR');

-- ---- Rejection ---------------------------------------------------------------
select is(pg_temp.try_finalize(pg_temp.id('r_reject'), 'REJECTED', 'QUANTITY_MISMATCH'),
          'REJECTED', 'K18. a standard rejection needs no note');
select is(
  (select count(*)::integer from public.receipt_product_review_decisions
   where receipt_submission_id = pg_temp.id('r_reject')),
  1, 'K19. rejection created a DURABLE decision row');
select is(pg_temp.items(pg_temp.id('r_reject')), 0,
          'K20. rejection created ZERO authoritative items');
select is(pg_temp.audit_count(pg_temp.id('r_reject'), 'SALE_ITEMS_REJECTED'),
          1, 'K21. rejection wrote exactly one Audit Log');

-- The image decision is a separate question and is untouched.
select is(
  (select decision from public.receipt_review_decisions
   where receipt_submission_id = pg_temp.id('r_reject')),
  'VERIFIED', 'K22. the receipt image stays VERIFIED when its products are rejected');
select is(
  (select count(*)::integer from public.verified_sales
   where receipt_submission_id = pg_temp.id('r_reject')),
  1, 'K23. the authoritative sale header also survives a product rejection');

select is(pg_temp.try_finalize(pg_temp.id('r_other'), 'REJECTED', 'OTHER', '  spaced note  '),
          'REJECTED', 'K24. OTHER with a real note is accepted');
select is(
  (select reviewer_note from public.receipt_product_review_decisions
   where receipt_submission_id = pg_temp.id('r_other')),
  'spaced note', 'K25. the reviewer note is trimmed');

select is(
  (select array_agg(k order by k) from (
     select jsonb_object_keys(metadata) k from public.audit_logs
     where entity_id = pg_temp.id('r_other')::text and action = 'SALE_ITEMS_REJECTED') x),
  array['line_count','rejection_reason'],
  'K26. the rejection Audit Log carries the reason and the count, and no note'
);
select is(
  (select count(*)::integer from public.audit_logs
   where entity_id = pg_temp.id('r_other')::text
     and action = 'SALE_ITEMS_REJECTED'
     and metadata::text ilike '%spaced note%'),
  0, 'K27. the free-form note is NOT copied into Audit Log metadata');

-- No Audit Log metadata anywhere carries a product identity or an amount.
select is(
  (select count(*)::integer from public.audit_logs
   where action in ('RECEIPT_PRODUCTS_PROPOSED','SALE_ITEMS_ACCEPTED','SALE_ITEMS_REJECTED')
     and (metadata::text ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
       or metadata ? 'product_code' or metadata ? 'product_name'
       or metadata ? 'total_minor'  or metadata ? 'merchant_name'
       or metadata ? 'document_number')),
  0, 'K28. no Phase 1D-B Audit Log carries a UUID, product identity or amount');


-- ============================================================================
-- SECTION L — IDEMPOTENCY, CONFLICT AND IMMUTABILITY
-- ============================================================================
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'ACCEPTED'),
          'ALREADY_ACCEPTED', 'L1. the same reviewer repeating an acceptance is idempotent');
select is(pg_temp.items(pg_temp.id('r_accept')), 2, 'L2. still exactly two items');
select is(pg_temp.audit_count(pg_temp.id('r_accept'), 'SALE_ITEMS_ACCEPTED'),
          1, 'L3. still exactly one acceptance Audit Log');

select is(pg_temp.try_finalize(pg_temp.id('r_other'), 'REJECTED', 'OTHER', 'spaced note'),
          'ALREADY_REJECTED', 'L4. the same reviewer repeating a rejection is idempotent');
select is(pg_temp.audit_count(pg_temp.id('r_other'), 'SALE_ITEMS_REJECTED'),
          1, 'L5. still exactly one rejection Audit Log');

select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'REJECTED', 'ILLEGIBLE'),
          'CONFLICT', 'L6. the same reviewer changing the DECISION conflicts');
select is(pg_temp.try_finalize(pg_temp.id('r_other'), 'REJECTED', 'ILLEGIBLE'),
          'CONFLICT', 'L7. the same reviewer changing the REASON conflicts');
select is(pg_temp.try_finalize(pg_temp.id('r_other'), 'REJECTED', 'OTHER', 'a different note'),
          'CONFLICT', 'L8. the same reviewer changing the NOTE conflicts');

do $$
begin perform pg_temp.act_as(pg_temp.id('rev2')); end;
$$;
select is(pg_temp.try_finalize(pg_temp.id('r_accept'), 'ACCEPTED'),
          'CONFLICT', 'L9. a DIFFERENT reviewer conflicts');
select is(
  (select count(*)::integer from public.receipt_product_review_decisions
   where receipt_submission_id = pg_temp.id('r_accept')),
  1, 'L10. still exactly one decision');
select is(pg_temp.items(pg_temp.id('r_accept')), 2, 'L11. still exactly two items');
select is(pg_temp.audit_count(pg_temp.id('r_accept'), 'SALE_ITEMS_ACCEPTED'),
          1, 'L12. still exactly one Audit Log');
do $$
begin perform pg_temp.act_as(pg_temp.id('rev')); end;
$$;

-- Immutability, tested WITH A ROW PRESENT: a row-level guard cannot fire on an
-- empty table, so an empty-table no-op proves nothing.
select is(pg_temp.try_sql('update public.verified_sale_items set quantity = 99'),
          'REFUSED:23514', 'L13. UPDATE on an authoritative item is refused');
select is(pg_temp.try_sql('delete from public.verified_sale_items'),
          'REFUSED:23514', 'L14. DELETE on an authoritative item is refused');
-- CHANGED BY PHASE 2A-A: campaign_sale_item_qualifications.verified_sale_item_id now
-- references this table, so a plain TRUNCATE is rejected with 0A000 before any
-- BEFORE TRUNCATE trigger fires. The statement is still refused — more strongly, in
-- fact — but by the reference graph rather than by the guard, so both mechanisms are
-- now named. CASCADE is what removes the shortcut and actually reaches the guard.
select is(pg_temp.try_sql('truncate public.verified_sale_items'),
          'REFUSED:0A000',
          'L15. a plain TRUNCATE on authoritative items is refused by the inbound foreign key');
select is(pg_temp.try_sql('truncate public.verified_sale_items cascade'),
          'REFUSED:23514',
          'L15b. ...and a CASCADE TRUNCATE, which does reach it, is refused by the guard');

select is(pg_temp.try_sql($f$update public.receipt_product_review_decisions set decision = 'REJECTED'$f$),
          'REFUSED:23514', 'L16. a decision cannot be REOPENED by update');
select is(pg_temp.try_sql('delete from public.receipt_product_review_decisions'),
          'REFUSED:23514', 'L17. a decision cannot be deleted');
-- These two tables are foreign-key TARGETS, so PostgreSQL refuses TRUNCATE with
-- 0A000 before any trigger can fire. The refusal is what matters; the guard
-- trigger is pinned separately below so it cannot be quietly dropped.
select matches(pg_temp.try_sql('truncate public.receipt_product_review_decisions'),
          '^REFUSED:', 'L18. decisions cannot be truncated');

select is(pg_temp.try_sql('update public.receipt_confirmation_products set quantity = 99'),
          'REFUSED:23514', 'L19. a proposal line cannot be CORRECTED by update');
select is(pg_temp.try_sql('delete from public.receipt_confirmation_products'),
          'REFUSED:23514', 'L20. a proposal line cannot be deleted');
select matches(pg_temp.try_sql('truncate public.receipt_confirmation_products'),
          '^REFUSED:', 'L21. proposals cannot be truncated');

select is(
  (select count(*)::integer from pg_trigger t
   join pg_class c on c.oid = t.tgrelid
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('receipt_confirmation_products',
                       'receipt_product_review_decisions','verified_sale_items')
     and t.tgname like '%guard_truncate'
     and not t.tgisinternal),
  3, 'L21b. all three tables carry their own TRUNCATE guard trigger');

-- A second decision is impossible even bypassing the RPC.
select is(
  pg_temp.try_sql(format($f$
    insert into public.receipt_product_review_decisions (
      receipt_submission_id, receipt_confirmation_id, verified_sale_id,
      vendor_organization_id, decision, decided_by_profile_id)
    select %L, c.id, v.id, %L, 'ACCEPTED', %L
    from public.receipt_confirmations c
    join public.verified_sales v on v.receipt_submission_id = c.receipt_submission_id
    where c.receipt_submission_id = %L$f$,
    pg_temp.id('r_accept'), pg_temp.id('vendor_a'), pg_temp.id('rev'), pg_temp.id('r_accept'))),
  'REFUSED:23505',
  'L22. a second decision for one receipt is refused by the unique index'
);

-- An extra authoritative line cannot be invented.
select is(
  pg_temp.try_sql(format($f$
    insert into public.verified_sale_items (
      verified_sale_id, product_review_decision_id, receipt_confirmation_product_id,
      vendor_product_id, vendor_organization_id, line_number, quantity,
      product_code_at_proposal, product_name_at_proposal, barcode_at_proposal,
      brand_at_proposal, product_status_at_proposal)
    select d.verified_sale_id, d.id, rcp.id, rcp.vendor_product_id, rcp.vendor_organization_id,
           40, 99, rcp.product_code_at_proposal, rcp.product_name_at_proposal,
           rcp.barcode_at_proposal, rcp.brand_at_proposal, rcp.product_status_at_proposal
    from public.receipt_product_review_decisions d
    join public.receipt_confirmation_products rcp
      on rcp.receipt_confirmation_id = d.receipt_confirmation_id and rcp.line_number = 1
    where d.receipt_submission_id = %L$f$, pg_temp.id('r_accept'))),
  'REFUSED:23514',
  'L23. an item whose quantity does not match its proposal line is refused'
);

select is(
  pg_temp.try_sql(format($f$
    insert into public.verified_sale_items (
      verified_sale_id, product_review_decision_id, receipt_confirmation_product_id,
      vendor_product_id, vendor_organization_id, line_number, quantity,
      product_code_at_proposal, product_name_at_proposal, barcode_at_proposal,
      brand_at_proposal, product_status_at_proposal)
    select d.verified_sale_id, d.id, rcp.id, rcp.vendor_product_id, rcp.vendor_organization_id,
           rcp.line_number, rcp.quantity, rcp.product_code_at_proposal,
           rcp.product_name_at_proposal, rcp.barcode_at_proposal, rcp.brand_at_proposal,
           rcp.product_status_at_proposal
    from public.receipt_product_review_decisions d
    join public.receipt_confirmation_products rcp
      on rcp.receipt_confirmation_id = d.receipt_confirmation_id and rcp.line_number = 1
    where d.receipt_submission_id = %L$f$, pg_temp.id('r_accept'))),
  'REFUSED:23505',
  'L24. one proposal line cannot be promoted twice'
);

-- An item under a REJECTED decision is impossible.
select is(
  pg_temp.try_sql(format($f$
    insert into public.verified_sale_items (
      verified_sale_id, product_review_decision_id, receipt_confirmation_product_id,
      vendor_product_id, vendor_organization_id, line_number, quantity,
      product_code_at_proposal, product_name_at_proposal, barcode_at_proposal,
      brand_at_proposal, product_status_at_proposal)
    select d.verified_sale_id, d.id, rcp.id, rcp.vendor_product_id, rcp.vendor_organization_id,
           rcp.line_number, rcp.quantity, rcp.product_code_at_proposal,
           rcp.product_name_at_proposal, rcp.barcode_at_proposal, rcp.brand_at_proposal,
           rcp.product_status_at_proposal
    from public.receipt_product_review_decisions d
    join public.receipt_confirmation_products rcp
      on rcp.receipt_confirmation_id = d.receipt_confirmation_id
    where d.receipt_submission_id = %L$f$, pg_temp.id('r_reject'))),
  'REFUSED:23514',
  'L25. an authoritative item cannot be created under a REJECTED decision'
);


-- ============================================================================
-- SECTION M — FAIL CLOSED, AND WHAT A LATER EXCLUSION DOES NOT DO
-- ============================================================================
do $$
declare r uuid;
begin
  -- A receipt excluded BEFORE any proposal.
  perform pg_temp.act_as(pg_temp.id('staff'));
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_excl_first', r);
  perform pg_temp.decide(r, pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.record_claim_receipt_qualification(r, 'EXCLUDE', 'TEST_DATA', 'test data');
  perform pg_temp.act_as(pg_temp.id('staff'));
end;
$$;

select is(pg_temp.try_propose(pg_temp.id('r_excl_first'),
          jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1))),
          'REFUSED:42501', 'M1. an active TEST_DATA exclusion blocks the PROPOSAL');
select is(
  (select count(*)::integer from public.receipt_confirmations
   where receipt_submission_id = pg_temp.id('r_excl_first')),
  0, 'M2. and no confirmation was created either');

-- A receipt proposed and header-finalized, then excluded before the product decision.
do $$
declare r uuid;
begin
  r := pg_temp.ready_receipt('r_excl_mid', jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1)));
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.record_claim_receipt_qualification(r, 'EXCLUDE', 'TEST_DATA', 'test data');
end;
$$;

select is(pg_temp.try_finalize(pg_temp.id('r_excl_mid'), 'ACCEPTED'),
          'REFUSED:42501', 'M3. an active exclusion blocks ACCEPTANCE');
select is(pg_temp.try_finalize(pg_temp.id('r_excl_mid'), 'REJECTED', 'ILLEGIBLE'),
          'REFUSED:42501', 'M4. an active exclusion blocks REJECTION too');
select is(
  (select count(*)::integer from public.receipt_product_review_decisions
   where receipt_submission_id = pg_temp.id('r_excl_mid')),
  0, 'M5. no decision was created for an excluded receipt');
select is(pg_temp.items(pg_temp.id('r_excl_mid')), 0,
          'M6. and no authoritative item either');

-- The table assertions refuse the same thing even if the RPC were bypassed.
select is(
  pg_temp.try_sql(format($f$
    insert into public.receipt_confirmation_products (
      receipt_confirmation_id, vendor_product_id, vendor_organization_id,
      line_number, quantity, product_code_at_proposal, product_name_at_proposal,
      barcode_at_proposal, brand_at_proposal, product_status_at_proposal)
    select c.id, %L, %L, 20, 1, 'PP-2', 'Product Two', null, null, 'ACTIVE'
    from public.receipt_confirmations c where c.receipt_submission_id = %L$f$,
    pg_temp.id('p2'), pg_temp.id('vendor_a'), pg_temp.id('r_excl_mid'))),
  'REFUSED:42501',
  'M7. a DIRECT proposal insert cannot bypass an active exclusion'
);

select is(
  pg_temp.try_sql(format($f$
    insert into public.receipt_product_review_decisions (
      receipt_submission_id, receipt_confirmation_id, verified_sale_id,
      vendor_organization_id, decision, decided_by_profile_id)
    select %L, c.id, v.id, %L, 'ACCEPTED', %L
    from public.receipt_confirmations c
    join public.verified_sales v on v.receipt_submission_id = c.receipt_submission_id
    where c.receipt_submission_id = %L$f$,
    pg_temp.id('r_excl_mid'), pg_temp.id('vendor_a'), pg_temp.id('rev'), pg_temp.id('r_excl_mid'))),
  'REFUSED:42501',
  'M8. a DIRECT decision insert cannot bypass an active exclusion'
);

-- An exclusion recorded AFTER an accepted decision changes nothing that exists.
do $$
begin
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.record_claim_receipt_qualification(
    pg_temp.id('r_accept'), 'EXCLUDE', 'TEST_DATA', 'excluded after the fact');
end;
$$;

select is(
  (select count(*)::integer from public.receipt_product_review_decisions
   where receipt_submission_id = pg_temp.id('r_accept')),
  1, 'M9. a LATER exclusion does not delete the decision');
select is(pg_temp.items(pg_temp.id('r_accept')), 2,
          'M10. a LATER exclusion does not delete the authoritative items');
select is(
  (select decision from public.receipt_product_review_decisions
   where receipt_submission_id = pg_temp.id('r_accept')),
  'ACCEPTED', 'M11. and does not mutate the decision');

-- The helper still says "complete item set" — because that is all it answers.
-- Eligibility is the CAMPAIGN engine's question, and it must ask both.
select ok(public.receipt_has_finalized_sale_items(pg_temp.id('r_accept')),
          'M12. the item helper is still true after a later exclusion');
select ok(public.receipt_qualification_is_excluded(pg_temp.id('r_accept')),
          'M13. and the exclusion oracle is separately true');
select ok(
  public.receipt_has_finalized_sale_items(pg_temp.id('r_accept'))
    and public.receipt_qualification_is_excluded(pg_temp.id('r_accept')),
  'M14. a future campaign engine MUST check both; neither implies the other'
);


-- ============================================================================
-- SECTION N — THE FUTURE CAMPAIGN ORACLE
-- ============================================================================
do $$
declare r uuid;
begin
  -- Header, but no proposal and no decision.
  perform pg_temp.act_as(pg_temp.id('staff'));
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_header_only', r);
  perform public.confirm_receipt_extraction(
    r, date '2026-06-15', 'AED', 2::smallint, 12345::bigint,
    'Test Merchant', 'DOC-1', time '14:30', 10000::bigint, 2345::bigint);
  perform pg_temp.decide(r, pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.finalize_claim_receipt_sale_header(r, null);

  -- Proposal, but no decision yet.
  perform pg_temp.ready_receipt('r_undecided',
    jsonb_build_array(pg_temp.line(pg_temp.id('p1'), 1)));
  perform pg_temp.act_as(pg_temp.id('rev'));
end;
$$;

select ok(not public.receipt_has_finalized_sale_items(pg_temp.id('r_header_only')),
          'N1. a sale HEADER alone is NOT a finalized item set');
select is((select count(*)::integer from public.verified_sales
           where receipt_submission_id = pg_temp.id('r_header_only')),
          1, 'N2. even though the header genuinely exists');
select ok(not public.receipt_has_finalized_sale_items(pg_temp.id('r_undecided')),
          'N3. a proposal with no decision is not a finalized item set');
select ok(not public.receipt_has_finalized_sale_items(pg_temp.id('r_reject')),
          'N4. a REJECTED decision is not a finalized item set');
select ok(public.receipt_has_finalized_sale_items(pg_temp.id('r_accept')),
          'N5. an accepted, complete item set is');
select ok(not public.receipt_has_finalized_sale_items(gen_random_uuid()),
          'N6. an unknown receipt is not');

-- The helper is invisible to every browser role.
select ok(
  not has_function_privilege('authenticated',
    'public.receipt_has_finalized_sale_items(uuid)', 'execute'),
  'N8. authenticated cannot execute the campaign oracle');
select ok(
  not has_function_privilege('anon',
    'public.receipt_has_finalized_sale_items(uuid)', 'execute'),
  'N9. anon cannot execute the campaign oracle');


-- ============================================================================
-- SECTION O — THE REVIEWER READS
-- ============================================================================
do $$
begin perform pg_temp.act_as(pg_temp.id('rev')); end;
$$;

select is((select count(*)::integer from public.get_claim_receipt_product_context(pg_temp.id('r_conf'))),
          1, 'O1. a receipt with a one-line proposal returns one context row');
select ok(
  (select has_product_proposal from public.get_claim_receipt_product_context(pg_temp.id('r_conf'))),
  'O2. has_product_proposal is true when a proposal exists');
select is(
  (select proposal_line_count from public.get_claim_receipt_product_context(pg_temp.id('r_conf'))),
  1, 'O3. proposal_line_count is reported');
select ok(
  (select has_verified_sale_header from public.get_claim_receipt_product_context(pg_temp.id('r_conf'))),
  'O4. has_verified_sale_header is reported separately');

select is((select count(*)::integer from public.get_claim_receipt_product_context(pg_temp.id('r_header_only'))),
          1, 'O5. a receipt with NO proposal still returns exactly one row');
select ok(
  not (select has_product_proposal from public.get_claim_receipt_product_context(pg_temp.id('r_header_only'))),
  'O6. and reports has_product_proposal = false rather than silence');
select is(
  (select line_number from public.get_claim_receipt_product_context(pg_temp.id('r_header_only'))),
  null, 'O7. with null line columns');

select ok(
  (select already_accepted from public.get_claim_receipt_product_context(pg_temp.id('r_accept')) limit 1),
  'O8. an accepted receipt reports already_accepted');
select ok(
  (select already_rejected from public.get_claim_receipt_product_context(pg_temp.id('r_reject')) limit 1),
  'O9. a rejected receipt reports already_rejected');
select is(
  (select rejection_reason from public.get_claim_receipt_product_context(pg_temp.id('r_reject')) limit 1),
  'QUANTITY_MISMATCH', 'O10. the rejection reason is returned');
select ok(
  (select is_qualification_excluded from public.get_claim_receipt_product_context(pg_temp.id('r_excl_mid')) limit 1),
  'O11. an excluded receipt reports it');

-- Frozen and current product status are BOTH returned, and they differ.
do $$
begin
  update public.vendor_products set status = 'INACTIVE' where id = pg_temp.id('p3');
end;
$$;
select is(
  (select array[product_status_at_proposal, product_status_current]
   from public.get_claim_receipt_product_context(pg_temp.id('r_deact')) where line_number = 1),
  array['ACTIVE','INACTIVE'],
  'O12. the frozen status and the CURRENT status are reported separately'
);
select ok(
  (select product_assigned_currently
   from public.get_claim_receipt_product_context(pg_temp.id('r_deact')) where line_number = 1),
  'O13. current ASSIGNMENT is reported independently and is unaffected by a status change'
);

-- Nothing internal is exposed.
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_claim_receipt_product_context'
     and pg_get_function_result(p.oid) ~*
         '(vendor_organization_id|retailer_organization_id|receipt_confirmation_id|verified_sale_id|product_review_decision_id|receipt_confirmation_product_id|vendor_product_id|storage|file_sha256|email)'),
  0, 'O14. the reviewer context exposes no internal id, path, hash or email');

-- Oracle safety on the reviewer side.
do $$
begin perform pg_temp.act_as(pg_temp.id('revfar')); end;
$$;
select is((select count(*)::integer from public.get_claim_receipt_product_context(pg_temp.id('r_accept'))),
          0, 'O15. a foreign Vendor''s reviewer reads zero context rows');
select is((select count(*)::integer from public.get_verified_sale_items(pg_temp.id('r_accept'))),
          0, 'O16. and zero authoritative items');
select is(pg_temp.try_finalize(pg_temp.id('r_conf'), 'ACCEPTED'),
          'REFUSED:42501', 'O17. and cannot decide it');
select is(pg_temp.try_finalize(gen_random_uuid(), 'ACCEPTED'),
          'REFUSED:42501',
          'O18. a nonexistent receipt raises the SAME refusal as a foreign one');

do $$
begin perform pg_temp.act_as(pg_temp.id('rev')); end;
$$;
select is((select count(*)::integer from public.get_verified_sale_items(pg_temp.id('r_accept'))),
          2, 'O19. the authorized reviewer reads the authoritative items');
select is((select count(*)::integer from public.get_verified_sale_items(pg_temp.id('r_reject'))),
          0, 'O20. a rejected receipt exposes no authoritative items');
select is((select count(*)::integer from public.get_verified_sale_items(pg_temp.id('r_undecided'))),
          0, 'O21. an undecided receipt exposes none either');
select is(
  (select decided_by_display_name from public.get_verified_sale_items(pg_temp.id('r_accept')) limit 1),
  'PP Rev', 'O22. the item read names the deciding reviewer by DISPLAY NAME only');
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_verified_sale_items'
     and pg_get_function_result(p.oid) ~* '(_id uuid|email|storage|sha)'),
  0, 'O23. the item read returns no internal foreign key');

do $$
begin perform pg_temp.act_as(pg_temp.id('staff')); end;
$$;
select is((select count(*)::integer from public.get_claim_receipt_product_context(pg_temp.id('r_accept'))),
          0, 'O24. a Sales Staff member cannot read the reviewer context');
select is(pg_temp.try_finalize(pg_temp.id('r_conf'), 'ACCEPTED'),
          'REFUSED:42501', 'O25. and cannot decide a proposal');
do $$
begin perform pg_temp.sign_out(); end;
$$;
select is((select count(*)::integer from public.get_claim_receipt_product_context(pg_temp.id('r_accept'))),
          0, 'O26. a signed-out caller reads zero context rows');
select is(pg_temp.try_finalize(pg_temp.id('r_conf'), 'ACCEPTED'),
          'REFUSED:42501', 'O27. and cannot decide anything');


-- ============================================================================
-- SECTION P — HISTORY DOES NOT BLOCK, AND WHAT THIS SUITE CANNOT PROVE
-- ============================================================================
do $$
declare r uuid;
begin
  -- A receipt from a shop that has since closed, submitted by staff who have left.
  perform pg_temp.act_as(pg_temp.id('staff'));
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_gone'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_hist', r);
  perform pg_temp.propose(r, jsonb_build_array(pg_temp.line(pg_temp.id('p2'), 1)));
  perform pg_temp.decide(r, pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.act_as(pg_temp.id('rev'));
  perform public.finalize_claim_receipt_sale_header(r, null);
end;
$$;

select is(pg_temp.try_finalize(pg_temp.id('r_hist'), 'ACCEPTED'),
          'ACCEPTED', 'P1. a receipt from a CLOSED shop can still be decided');
select is(pg_temp.items(pg_temp.id('r_hist')), 1, 'P2. and its items were created');

-- The product on r_deact was deactivated in Section O and is now unassigned too.
do $$
begin
  update public.vendor_product_retailer_assignments set status = 'INACTIVE'
  where vendor_product_id = pg_temp.id('p3');
end;
$$;

select is(pg_temp.try_finalize(pg_temp.id('r_deact'), 'ACCEPTED'),
          'ACCEPTED',
          'P3. a product DEACTIVATED and UNASSIGNED after proposal does not block acceptance');
select is(pg_temp.items(pg_temp.id('r_deact')), 1, 'P4. and its item was created');
select is(
  (select i.product_status_at_proposal from public.verified_sale_items i
   join public.receipt_product_review_decisions d on d.id = i.product_review_decision_id
   where d.receipt_submission_id = pg_temp.id('r_deact')),
  'ACTIVE',
  'P5. the authoritative item keeps the PROPOSAL-TIME status, not today''s'
);

-- A receipt whose image was REJECTED can never get a product decision.
do $$
declare r uuid;
begin
  perform pg_temp.act_as(pg_temp.id('staff'));
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_rejimg', r);
  perform pg_temp.propose(r, jsonb_build_array(pg_temp.line(pg_temp.id('p2'), 1)));
  perform pg_temp.decide(r, pg_temp.id('vendor_a'), pg_temp.id('rev'), 'REJECTED');
  perform pg_temp.act_as(pg_temp.id('rev'));
end;
$$;

select is(pg_temp.try_finalize(pg_temp.id('r_rejimg'), 'ACCEPTED'),
          'REFUSED:42501', 'P6. a REJECTED receipt image blocks any product decision');
select is(pg_temp.try_finalize(pg_temp.id('r_undecided'), 'ACCEPTED'),
          'ACCEPTED', 'P7. a receipt with a header and a proposal can be decided');

-- No sale header means no product decision.
do $$
declare r uuid;
begin
  perform pg_temp.act_as(pg_temp.id('staff'));
  r := pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop'), pg_temp.id('staff'));
  insert into pg_temp.f values ('r_nohdr', r);
  perform pg_temp.propose(r, jsonb_build_array(pg_temp.line(pg_temp.id('p2'), 1)));
  perform pg_temp.decide(r, pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.act_as(pg_temp.id('rev'));
end;
$$;

select is(pg_temp.try_finalize(pg_temp.id('r_nohdr'), 'ACCEPTED'),
          'REFUSED:42501', 'P8. a missing sale HEADER blocks the product decision');
select is(pg_temp.try_finalize(pg_temp.id('r_header_only'), 'ACCEPTED'),
          'REFUSED:42501', 'P9. a missing PROPOSAL blocks it too, with the same refusal');

-- No campaign, reward or coin side effect anywhere in this suite.
select is(
  (select count(*)::integer from public.campaign_versions),
  0, 'P10. nothing here created a campaign version');
select is(
  (select count(distinct action)::integer from public.audit_logs
   where action ~* '(reward|coin|ledger|balance|payout|campaign_result)'),
  0, 'P11. no reward, coin, ledger, balance, payout or campaign-result Audit Log exists');

-- ---- What a single-transaction suite cannot prove ---------------------------
-- Every test above ran in ONE session inside ONE transaction. That can prove the
-- rules, the constraints and the refusals, and it CANNOT prove a genuine race:
-- two concurrent sessions never exist here, so the receipt row lock is never
-- actually contended.
--
-- The real races — same staff twice, two different line sets, same reviewer
-- twice, two reviewers, exclusion-first, acceptance-first, and product
-- deactivation mid-review — are run separately as two-session harnesses against a
-- disposable database and reported with the milestone.
select pass('P12. single-session tests do NOT prove concurrency; two-session races are run separately');

select * from finish();
rollback;
