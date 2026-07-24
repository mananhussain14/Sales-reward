-- pgTAP behavioural tests for the two Sales Staff receipt reads added by
-- migration 20260730090000_sales_staff_receipt_product_and_submission_reads.sql:
--
--   public.list_my_receipt_products()
--   public.get_my_receipt_submission(uuid)
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- public.auth.uid() resolves the caller from the request's JWT claims, which
-- Supabase exposes as the `request.jwt.claims` GUC:
--
--   auth.uid() = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
--
-- so setting that GUC transaction-locally IS signing in, as far as every
-- authorization helper in this schema is concerned. pg_temp.act_as() below does
-- exactly that, and pg_temp.sign_out() clears it. This mirrors
-- supabase/tests/database/portal_context_test.sql exactly, deliberately: two
-- different impersonation idioms in one suite directory would be two different
-- claims about what "signed in" means.
--
-- The tests deliberately do NOT `set role authenticated`. Both functions under
-- test are SECURITY DEFINER, so their behaviour depends on auth.uid() and not on
-- the session role, and switching roles mid-transaction would only make the
-- fixture inserts fail. EXECUTE privilege is a separate concern and is asserted
-- directly against the catalogue in Section A, which is a stronger check than
-- "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back, so no fixture
-- survives the run. The tests that mutate seeded catalogue rows (Section M) are
-- last, for that reason.
--
-- no_plan() rather than plan(N): the assertion count is incidental here, and a
-- hard-coded number that drifts out of step with the file turns an added test
-- into a confusing failure about arithmetic rather than about behaviour.
--
-- ============================================================================
-- WHAT "DENIED" MEANS FOR EACH FUNCTION, AND WHY THEY DIFFER
-- ============================================================================
-- list_my_receipt_products() RAISES on an unauthorized caller (42501). A denial
-- and "your Retailer has no products assigned yet" are different facts.
--
-- get_my_receipt_submission(uuid) also RAISES for a caller who is not authorized
-- Sales Staff at all — but returns ZERO ROWS for an authorized caller who names a
-- submission that is not theirs. That distinction is the security property: a
-- distinguishable refusal would confirm that some other person's submission
-- exists. Section H proves the two cases are indistinguishable from each other.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers
-- ============================================================================
create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user::text)::text,
    true  -- transaction-local
  );
end;
$$;

create function pg_temp.sign_out() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

/*
 * Creates an auth user + a profile of the given status, and returns the id.
 *
 * public.profiles.id is a FK to auth.users(id), so a real auth row is required.
 */
create function pg_temp.new_user(p_label text, p_status text default 'ACTIVE')
returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_label || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_label, 'Tester', p_status);
  return v_id;
end;
$$;

/* Grants p_user a role in p_org through a membership of the given status. */
create function pg_temp.grant_role(
  p_user uuid,
  p_org uuid,
  p_role_code text,
  p_membership_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status)
  values (p_org, p_user, p_membership_status)
  on conflict (organization_id, user_id) do update set status = excluded.status
  returning id into v_member;

  insert into public.member_roles (organization_member_id, role_id)
  select v_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;

  return v_member;
end;
$$;

/*
 * CATALOGUE INTROSPECTION FOR `RETURNS TABLE` FUNCTIONS.
 *
 * A set-returning `returns table (...)` function has prorettype = `record`, a
 * pseudo-type with no typrelid — so joining pg_type -> pg_class -> pg_attribute to
 * read its columns silently yields NOTHING, and an assertion written that way
 * compares NULL to NULL and passes vacuously. The column names live in
 * proargnames alongside the INPUT parameter names, distinguished only by
 * proargmodes: 'i' (or 'b'/'v') for an input, 't' for a table column.
 *
 * Both helpers below therefore filter on the mode. Reading them any other way is
 * how a shape assertion turns into a no-op.
 */
create function pg_temp.arg_names(p_name text, p_modes "char"[]) returns text[]
language sql stable as $$
  select coalesce(array_agg(x.name order by x.ord), '{}'::text[])
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(
    p.proargnames,
    coalesce(p.proargmodes,
             array_fill('i'::"char", array[coalesce(array_length(p.proargnames, 1), 0)]))
  ) with ordinality as x(name, mode, ord)
  where n.nspname = 'public'
    and p.proname = p_name
    and x.mode = any (p_modes);
$$;

/* The declared output columns of a `returns table` function, in order. */
create function pg_temp.table_columns(p_name text) returns text[]
language sql stable as $$
  select pg_temp.arg_names(p_name, array['t'::"char"]);
$$;

/* The declared INPUT parameter names of a function, in order. */
create function pg_temp.input_args(p_name text) returns text[]
language sql stable as $$
  select pg_temp.arg_names(p_name, array['i'::"char", 'b'::"char", 'v'::"char"]);
$$;

/* The product codes visible to the current caller, ordered, as an array. */
create function pg_temp.my_product_codes() returns text[]
language sql as $$
  select coalesce(array_agg(p.product_code order by p.product_code), '{}')
  from public.list_my_receipt_products() p;
$$;

/* How many rows the current caller sees for one submission id. */
create function pg_temp.submission_row_count(p_id uuid) returns bigint
language sql as $$
  select count(*) from public.get_my_receipt_submission(p_id);
$$;

/*
 * The SQLSTATE raised when the current caller invokes a function, or NULL if it
 * returned normally.
 *
 * Sequenced in plpgsql on purpose. throws_ok() cannot be used for the
 * zero-rows-vs-raise comparisons in Section H, and comparing SQLSTATEs is what
 * makes "these two denials are indistinguishable" a testable claim rather than a
 * comment.
 */
create function pg_temp.products_sqlstate() returns text
language plpgsql as $$
begin
  perform * from public.list_my_receipt_products();
  return null;
exception when others then
  return sqlstate;
end;
$$;

create function pg_temp.submission_sqlstate(p_id uuid) returns text
language plpgsql as $$
begin
  perform * from public.get_my_receipt_submission(p_id);
  return null;
exception when others then
  return sqlstate;
end;
$$;

-- ============================================================================
-- Fixtures
-- ============================================================================
-- DETERMINISTIC: every organization, product, shop and submission below is
-- created by this file. Nothing depends on seed data other than the roles and
-- permissions catalogue the migrations install, and no assertion depends on a
-- row this file did not create.
create temporary table t_ids (label text primary key, id uuid not null);

do $$
declare
  v_vendor1   uuid := gen_random_uuid();
  v_vendor2   uuid := gen_random_uuid();
  v_retailer1 uuid := gen_random_uuid();
  v_retailer2 uuid := gen_random_uuid();
begin
  insert into public.organizations (id, name, organization_type, status) values
    (v_vendor1,   'Receipt Test Vendor One', 'VENDOR',   'ACTIVE'),
    (v_vendor2,   'Receipt Test Vendor Two', 'VENDOR',   'ACTIVE'),
    (v_retailer1, 'Receipt Test Retailer 1', 'RETAILER', 'ACTIVE'),
    (v_retailer2, 'Receipt Test Retailer 2', 'RETAILER', 'ACTIVE');

  insert into t_ids values
    ('vendor1',   v_vendor1),
    ('vendor2',   v_vendor2),
    ('retailer1', v_retailer1),
    ('retailer2', v_retailer2);

  -- vendor_product_retailer_assignments carries a trigger requiring a
  -- vendor_retailers link between the product's Vendor and the Retailer.
  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values
    (v_vendor1, v_retailer1, 'ACTIVE'),
    (v_vendor1, v_retailer2, 'ACTIVE'),
    (v_vendor2, v_retailer2, 'ACTIVE');

  insert into t_ids values
    ('vendor_admin',   pg_temp.new_user('rcpt_vendoradmin')),
    ('owner1',         pg_temp.new_user('rcpt_owner1')),
    ('manager1',       pg_temp.new_user('rcpt_manager1')),
    ('sales1',         pg_temp.new_user('rcpt_sales1')),
    ('sales1b',        pg_temp.new_user('rcpt_sales1b')),
    ('sales2',         pg_temp.new_user('rcpt_sales2')),
    -- profiles.status is one of INVITED / ACTIVE / SUSPENDED / DEACTIVATED, and the
    -- resolver requires ACTIVE. Both non-active terminal states are covered.
    ('sales_susp_profile',   pg_temp.new_user('rcpt_suspprof',   'SUSPENDED')),
    ('sales_deact_profile',  pg_temp.new_user('rcpt_deactprof',  'DEACTIVATED')),
    ('sales_inactive_member',  pg_temp.new_user('rcpt_inactmem')),
    ('sales_ambiguous',        pg_temp.new_user('rcpt_ambiguous')),
    ('sales_multirole',        pg_temp.new_user('rcpt_multirole')),
    ('nobody',                 pg_temp.new_user('rcpt_nobody'));
end;
$$;

do $$
declare
  v_retailer1 uuid := (select id from t_ids where label = 'retailer1');
  v_retailer2 uuid := (select id from t_ids where label = 'retailer2');
  v_vendor1   uuid := (select id from t_ids where label = 'vendor1');
begin
  perform pg_temp.grant_role((select id from t_ids where label='vendor_admin'), v_vendor1,   'VENDOR_SUPER_ADMIN');
  perform pg_temp.grant_role((select id from t_ids where label='owner1'),       v_retailer1, 'RETAILER_OWNER');
  perform pg_temp.grant_role((select id from t_ids where label='manager1'),     v_retailer1, 'RETAILER_MANAGER');

  -- Two Sales Staff at retailer1, one at retailer2. sales1 and sales1b are the
  -- pair that proves one staff member cannot read another's submission even
  -- inside the SAME Retailer.
  perform pg_temp.grant_role((select id from t_ids where label='sales1'),  v_retailer1, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='sales1b'), v_retailer1, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='sales2'),  v_retailer2, 'SALES_STAFF');

  -- Denied shapes.
  perform pg_temp.grant_role((select id from t_ids where label='sales_susp_profile'),  v_retailer1, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='sales_deact_profile'), v_retailer1, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='sales_inactive_member'),  v_retailer1, 'SALES_STAFF', 'SUSPENDED');

  -- Sales Staff at BOTH Retailers: the ambiguity rule must fail closed.
  perform pg_temp.grant_role((select id from t_ids where label='sales_ambiguous'), v_retailer1, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='sales_ambiguous'), v_retailer2, 'SALES_STAFF');

  -- One membership carrying TWO roles. CLAIM_REVIEWER is seeded ACTIVE and holds
  -- no permission, so it changes nothing about authorization — but it doubles the
  -- rows the resolver's join produces, which is exactly the shape that would
  -- duplicate products if the resolver were not DISTINCT.
  perform pg_temp.grant_role((select id from t_ids where label='sales_multirole'), v_retailer1, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='sales_multirole'), v_retailer1, 'CLAIM_REVIEWER');

  -- 'nobody' gets an ACTIVE profile and no membership at all.
end;
$$;

-- Products. VP-R1-ACTIVE and VP-R1-SECOND are the only two a retailer1 Sales
-- Staff member may ever see.
do $$
declare
  v_vendor1   uuid := (select id from t_ids where label = 'vendor1');
  v_vendor2   uuid := (select id from t_ids where label = 'vendor2');
  v_retailer1 uuid := (select id from t_ids where label = 'retailer1');
  v_retailer2 uuid := (select id from t_ids where label = 'retailer2');
  v_creator   uuid := (select id from t_ids where label = 'vendor_admin');
  v_p_active  uuid := gen_random_uuid();
  v_p_second  uuid := gen_random_uuid();
  v_p_inact   uuid := gen_random_uuid();
  v_p_withdr  uuid := gen_random_uuid();
  v_p_other   uuid := gen_random_uuid();
  v_p_v2      uuid := gen_random_uuid();
begin
  insert into public.vendor_products
    (id, vendor_organization_id, product_code, barcode, product_name, brand, description, status, created_by_profile_id)
  values
    (v_p_active, v_vendor1, 'VP-R1-ACTIVE', '00000000000017', 'Active Product',      'BrandA', 'desc a', 'ACTIVE',   v_creator),
    (v_p_second, v_vendor1, 'VP-R1-SECOND', null,             'Second Product',      'BrandB', null,     'ACTIVE',   v_creator),
    (v_p_inact,  v_vendor1, 'VP-R1-INACT',  null,             'Inactive Product',    null,     null,     'INACTIVE', v_creator),
    (v_p_withdr, v_vendor1, 'VP-R1-WITHDR', null,             'Withdrawn Product',   null,     null,     'ACTIVE',   v_creator),
    (v_p_other,  v_vendor1, 'VP-R2-ONLY',   null,             'Other Retailer Only', null,     null,     'ACTIVE',   v_creator),
    (v_p_v2,     v_vendor2, 'VP-V2-ONLY',   null,             'Other Vendor Only',   null,     null,     'ACTIVE',   v_creator);

  insert into t_ids values
    ('p_active', v_p_active),
    ('p_second', v_p_second),
    ('p_inact',  v_p_inact),
    ('p_withdr', v_p_withdr),
    ('p_other',  v_p_other),
    ('p_v2',     v_p_v2);

  insert into public.vendor_product_retailer_assignments
    (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id)
  values
    -- Visible to retailer1.
    (v_p_active, v_retailer1, 'ACTIVE',   v_creator),
    (v_p_second, v_retailer1, 'ACTIVE',   v_creator),
    -- Assigned but the PRODUCT is INACTIVE.
    (v_p_inact,  v_retailer1, 'ACTIVE',   v_creator),
    -- ACTIVE product but the ASSIGNMENT was withdrawn.
    (v_p_withdr, v_retailer1, 'INACTIVE', v_creator),
    -- Another Retailer's scope entirely.
    (v_p_other,  v_retailer2, 'ACTIVE',   v_creator),
    -- Another Vendor's product, assigned to the other Retailer.
    (v_p_v2,     v_retailer2, 'ACTIVE',   v_creator);
end;
$$;

-- Shops and submissions. The submissions are inserted directly rather than
-- through reserve_receipt_submission() because this suite tests the READ; the
-- write path has its own contract and inserting here keeps the fixture
-- deterministic (no generated paths, no clock dependence).
do $$
declare
  v_retailer1 uuid := (select id from t_ids where label = 'retailer1');
  v_retailer2 uuid := (select id from t_ids where label = 'retailer2');
  v_shop1     uuid := gen_random_uuid();
  v_shop2     uuid := gen_random_uuid();
  v_sub1      uuid := gen_random_uuid();
  v_sub1b     uuid := gen_random_uuid();
  v_sub2      uuid := gen_random_uuid();
begin
  insert into public.retailer_shops (id, retailer_organization_id, name, code, status) values
    (v_shop1, v_retailer1, 'Receipt Test Shop One', 'RTS-1', 'ACTIVE'),
    (v_shop2, v_retailer2, 'Receipt Test Shop Two', 'RTS-2', 'ACTIVE');

  insert into t_ids values ('shop1', v_shop1), ('shop2', v_shop2);

  insert into public.receipt_submissions (
    id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
    storage_bucket, storage_object_path, original_file_name, mime_type,
    file_size_bytes, file_sha256, status, submitted_at
  ) values
    (v_sub1, v_retailer1, v_shop1, (select id from t_ids where label='sales1'),
     'receipts', v_retailer1::text || '/a/' || v_sub1::text || '/obj.jpg',
     'sales1-receipt.jpg', 'image/jpeg', 1024,
     repeat('a', 64), 'SUBMITTED', now()),

    (v_sub1b, v_retailer1, v_shop1, (select id from t_ids where label='sales1b'),
     'receipts', v_retailer1::text || '/b/' || v_sub1b::text || '/obj.jpg',
     'sales1b-receipt.jpg', 'image/png', 2048,
     repeat('b', 64), 'RESERVED', null),

    (v_sub2, v_retailer2, v_shop2, (select id from t_ids where label='sales2'),
     'receipts', v_retailer2::text || '/c/' || v_sub2::text || '/obj.jpg',
     'sales2-receipt.jpg', 'image/webp', 4096,
     repeat('c', 64), 'SUBMITTED', now());

  insert into t_ids values ('sub1', v_sub1), ('sub1b', v_sub1b), ('sub2', v_sub2);
end;
$$;

-- ============================================================================
-- SECTION A — contract surface: signature, grants, hardening
-- ============================================================================
select is(
  (select pronargs from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'list_my_receipt_products'),
  0::smallint,
  'list_my_receipt_products takes ZERO arguments — no Retailer, profile or membership can be supplied'
);

select is(
  (select pg_catalog.pg_get_function_identity_arguments(p.oid) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_my_receipt_submission'),
  'p_submission_id uuid',
  'get_my_receipt_submission takes exactly one uuid — a submission id and nothing else'
);

select ok(
  has_function_privilege('authenticated', 'public.list_my_receipt_products()', 'EXECUTE'),
  'authenticated holds EXECUTE on list_my_receipt_products'
);
select ok(
  not has_function_privilege('anon', 'public.list_my_receipt_products()', 'EXECUTE'),
  'anon does NOT hold EXECUTE on list_my_receipt_products'
);
select ok(
  not has_function_privilege('service_role', 'public.list_my_receipt_products()', 'EXECUTE'),
  'service_role does NOT hold EXECUTE on list_my_receipt_products'
);

select ok(
  has_function_privilege('authenticated', 'public.get_my_receipt_submission(uuid)', 'EXECUTE'),
  'authenticated holds EXECUTE on get_my_receipt_submission'
);
select ok(
  not has_function_privilege('anon', 'public.get_my_receipt_submission(uuid)', 'EXECUTE'),
  'anon does NOT hold EXECUTE on get_my_receipt_submission'
);
select ok(
  not has_function_privilege('service_role', 'public.get_my_receipt_submission(uuid)', 'EXECUTE'),
  'service_role does NOT hold EXECUTE on get_my_receipt_submission'
);

select ok(
  (select bool_and(prosecdef) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('list_my_receipt_products', 'get_my_receipt_submission')),
  'both functions are SECURITY DEFINER'
);

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral unnest(coalesce(p.proconfig, '{}')) as cfg
    where n.nspname = 'public'
      and p.proname in ('list_my_receipt_products', 'get_my_receipt_submission')
      and cfg in ('search_path=', 'search_path=""')),
  2::bigint,
  'both functions pin search_path to the empty string'
);

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('list_my_receipt_products', 'get_my_receipt_submission')
      and p.provolatile = 's'),
  2::bigint,
  'both functions are STABLE — they read and never write'
);

-- The identity/tenant derivation is structural: neither function can be given an
-- organization, profile or membership id because neither has a parameter for one.
-- Asserted here against the catalogue rather than by reading the source.
-- Filtered to INPUT arguments. get_my_receipt_submission declares an OUT column
-- named `status`, which is a returned fact and not something a caller may supply;
-- scanning proargnames without the mode filter would flag it and make this
-- assertion a statement about the wrong thing.
select is(pg_temp.input_args('list_my_receipt_products'), '{}'::text[],
          'list_my_receipt_products declares no input parameter at all');

select is(pg_temp.input_args('get_my_receipt_submission'), array['p_submission_id'],
          'get_my_receipt_submission declares exactly one input: the submission id');

select is(
  (select count(*)
     from unnest(pg_temp.input_args('list_my_receipt_products')
                 || pg_temp.input_args('get_my_receipt_submission')) as argname
    where argname ilike '%organization%'
       or argname ilike '%profile%'
       or argname ilike '%member%'
       or argname ilike '%user%'
       or argname ilike '%retailer%'
       or argname ilike '%status%'),
  0::bigint,
  'neither function accepts a tenant, identity, membership or status parameter'
);

-- The RECEIPT_PRODUCTS_READ mapping is the whole authorization model. If it ever
-- reached a second role, every "X receives no product access" test below would
-- still pass while the capability had silently widened.
select is(
  (select array_agg(r.code order by r.code)
     from public.role_permissions rp
     join public.roles r on r.id = rp.role_id
     join public.permissions perm on perm.id = rp.permission_id
    where perm.code = 'RECEIPT_PRODUCTS_READ'),
  array['SALES_STAFF'],
  'RECEIPT_PRODUCTS_READ is mapped to SALES_STAFF and to NO other role'
);

select is(
  (select array_agg(r.code order by r.code)
     from public.role_permissions rp
     join public.roles r on r.id = rp.role_id
     join public.permissions perm on perm.id = rp.permission_id
    where perm.code = 'RECEIPT_SUBMIT'),
  array['SALES_STAFF'],
  'RECEIPT_SUBMIT is still mapped to SALES_STAFF alone — unchanged by this migration'
);

-- ============================================================================
-- SECTION B — signed out
-- ============================================================================
select pg_temp.sign_out();

select is(pg_temp.products_sqlstate(), '42501',
          'signed out -> list_my_receipt_products raises insufficient_privilege');
select is(pg_temp.submission_sqlstate((select id from t_ids where label='sub1')), '42501',
          'signed out -> get_my_receipt_submission raises insufficient_privilege');

-- ============================================================================
-- SECTION C — the happy path: an ACTIVE Sales Staff member
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'sales1'));

select is(pg_temp.my_product_codes(), array['VP-R1-ACTIVE', 'VP-R1-SECOND'],
          'Sales Staff see exactly the ACTIVE products actively assigned to their own Retailer');

select is(
  (select count(*) from public.list_my_receipt_products()),
  2::bigint,
  'no extra rows: the INACTIVE product, the withdrawn assignment and both out-of-scope products are all absent'
);

select is(
  (select array_agg(product_name order by product_name) from public.list_my_receipt_products()),
  array['Active Product', 'Second Product'],
  'display fields are populated'
);

select is(
  (select barcode from public.list_my_receipt_products() where product_code = 'VP-R1-ACTIVE'),
  '00000000000017',
  'the barcode is returned — it is what a scanner resolves against'
);

select is(
  (select brand from public.list_my_receipt_products() where product_code = 'VP-R1-SECOND'),
  'BrandB',
  'the brand is returned'
);

-- The returned shape is exactly five columns. A later edit that added
-- vendor_organization_id, assignment_status, or an audit column would leak
-- catalogue-administration data to a submitter, and would fail here.
select is(
  pg_temp.table_columns('list_my_receipt_products'),
  array['product_id', 'product_code', 'barcode', 'product_name', 'brand'],
  'list_my_receipt_products returns exactly its five declared columns and nothing else'
);

-- ============================================================================
-- SECTION D — every other role receives NO Sales Staff product access
--
-- This is the intended backend model, stated explicitly: RECEIPT_PRODUCTS_READ is
-- mapped to SALES_STAFF alone. A Retailer Owner and a Retailer Manager already
-- hold RETAILER_PRODUCTS_READ and therefore already have the richer
-- list_retailer_assigned_products() read; granting both would give them two
-- different answers to one question. Nothing here is "allowed unless" — the
-- migration allows no other role, and these assertions prove it.
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'vendor_admin'));
select is(pg_temp.products_sqlstate(), '42501',
          'Vendor Super Admin receives NO Sales Staff product access');

select pg_temp.act_as((select id from t_ids where label = 'owner1'));
select is(pg_temp.products_sqlstate(), '42501',
          'Retailer Owner receives NO Sales Staff product access');

select pg_temp.act_as((select id from t_ids where label = 'manager1'));
select is(pg_temp.products_sqlstate(), '42501',
          'Retailer Manager receives NO Sales Staff product access');

select pg_temp.act_as((select id from t_ids where label = 'nobody'));
select is(pg_temp.products_sqlstate(), '42501',
          'an authenticated account with no membership receives no product access');

-- The Owner/Manager read still works, so the denial above is about the NEW
-- permission and not about a broken fixture.
select pg_temp.act_as((select id from t_ids where label = 'owner1'));
select is(
  (select count(*) from public.list_retailer_assigned_products()),
  2::bigint,
  'the Owner still has their own RETAILER_PRODUCTS_READ catalogue — this migration did not narrow it'
);

-- ============================================================================
-- SECTION E — inactive profile, inactive membership, ambiguity
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'sales_susp_profile'));
select is(pg_temp.products_sqlstate(), '42501',
          'SUSPENDED profile -> denied product access');
select is(pg_temp.submission_sqlstate((select id from t_ids where label='sub1')), '42501',
          'SUSPENDED profile -> denied submission access');

select pg_temp.act_as((select id from t_ids where label = 'sales_deact_profile'));
select is(pg_temp.products_sqlstate(), '42501',
          'DEACTIVATED profile -> denied product access');
select is(pg_temp.submission_sqlstate((select id from t_ids where label='sub1')), '42501',
          'DEACTIVATED profile -> denied submission access');

select pg_temp.act_as((select id from t_ids where label = 'sales_inactive_member'));
select is(pg_temp.products_sqlstate(), '42501',
          'SUSPENDED membership -> denied product access');
select is(pg_temp.submission_sqlstate((select id from t_ids where label='sub1')), '42501',
          'SUSPENDED membership -> denied submission access');

select pg_temp.act_as((select id from t_ids where label = 'sales_ambiguous'));
select is(pg_temp.products_sqlstate(), '42501',
          'Sales Staff at TWO Retailers -> fails closed, never an arbitrary pick');
select is(pg_temp.submission_sqlstate((select id from t_ids where label='sub1')), '42501',
          'ambiguous membership -> submission read also fails closed');

-- ============================================================================
-- SECTION F — tenant isolation for products
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'sales2'));

select is(pg_temp.my_product_codes(), array['VP-R2-ONLY', 'VP-V2-ONLY'],
          'retailer2 Sales Staff see only retailer2''s assigned products');

select ok(
  not (pg_temp.my_product_codes() && array['VP-R1-ACTIVE', 'VP-R1-SECOND']),
  'retailer2 Sales Staff never see retailer1''s products');

select pg_temp.act_as((select id from t_ids where label = 'sales1'));
select ok(
  not (pg_temp.my_product_codes() && array['VP-R2-ONLY', 'VP-V2-ONLY']),
  'retailer1 Sales Staff never see another Retailer''s or another Vendor''s products');

-- ============================================================================
-- SECTION G — duplicate catalogue relationships do not duplicate products
-- ============================================================================
-- Two independent duplication risks are covered.
--
-- 1. The assignment table itself. vendor_product_retailer_assign_unique_idx
--    permits ONE row per (product, Retailer) for all time, so a second assignment
--    cannot exist to be joined twice. Proven by attempting it.
-- 2. The RESOLVER's join. A membership carrying two roles produces two rows in
--    the resolver's qualifying set; `select distinct` collapses them. Without it
--    the resolver would still return one organization id, but the shape is the
--    one that would multiply rows if the product query were ever rewritten to
--    join through member_roles.
select throws_ok(
  format(
    'insert into public.vendor_product_retailer_assignments
       (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id)
     values (%L, %L, %L, %L)',
    (select id from t_ids where label='p_active'),
    (select id from t_ids where label='retailer1'),
    'ACTIVE',
    (select id from t_ids where label='vendor_admin')
  ),
  '23505',
  null,
  'a duplicate (product, Retailer) assignment is impossible — the unique index refuses it'
);

select pg_temp.act_as((select id from t_ids where label = 'sales_multirole'));
select is(pg_temp.my_product_codes(), array['VP-R1-ACTIVE', 'VP-R1-SECOND'],
          'a member holding TWO roles still sees each product exactly once');
select is(
  (select count(*) from public.list_my_receipt_products()),
  2::bigint,
  'two roles do not double the row count'
);

-- ============================================================================
-- SECTION H — get_my_receipt_submission: ownership, and the zero-rows rule
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'sales1'));

select is(pg_temp.submission_row_count((select id from t_ids where label='sub1')), 1::bigint,
          'the submitter reads their OWN submission');

select is(
  (select status from public.get_my_receipt_submission((select id from t_ids where label='sub1'))),
  'SUBMITTED',
  'the status is returned');
select is(
  (select shop_name from public.get_my_receipt_submission((select id from t_ids where label='sub1'))),
  'Receipt Test Shop One',
  'the shop name is returned');
select is(
  (select original_file_name from public.get_my_receipt_submission((select id from t_ids where label='sub1'))),
  'sales1-receipt.jpg',
  'the submitter''s own filename is returned');
select is(
  (select submission_id from public.get_my_receipt_submission((select id from t_ids where label='sub1'))),
  (select id from t_ids where label='sub1'),
  'the submission id round-trips — a client can key a list on it');

-- THE CENTRAL SECURITY PROPERTY.
select is(pg_temp.submission_row_count((select id from t_ids where label='sub1b')), 0::bigint,
          'another Sales Staff member IN THE SAME RETAILER gets ZERO ROWS for a colleague''s submission');

select pg_temp.act_as((select id from t_ids where label = 'sales1b'));
select is(pg_temp.submission_row_count((select id from t_ids where label='sub1')), 0::bigint,
          'and the reverse: sales1b cannot read sales1''s submission');
select is(pg_temp.submission_row_count((select id from t_ids where label='sub1b')), 1::bigint,
          'sales1b CAN read their own RESERVED submission');

select pg_temp.act_as((select id from t_ids where label = 'sales2'));
select is(pg_temp.submission_row_count((select id from t_ids where label='sub1')), 0::bigint,
          'a same-role user in ANOTHER Retailer gets zero rows');
select is(pg_temp.submission_row_count((select id from t_ids where label='sub2')), 1::bigint,
          'that user still reads their own');

-- Unknown id, and the indistinguishability that makes the whole design work.
select pg_temp.act_as((select id from t_ids where label = 'sales1'));
select is(pg_temp.submission_row_count('00000000-0000-0000-0000-000000000000'::uuid), 0::bigint,
          'an unknown uuid returns zero rows');
select is(pg_temp.submission_row_count(null), 0::bigint,
          'a null id returns zero rows rather than raising');

select is(
  pg_temp.submission_sqlstate((select id from t_ids where label='sub1b')),
  pg_temp.submission_sqlstate('00000000-0000-0000-0000-000000000000'::uuid),
  'a real submission that is not mine and a uuid that does not exist behave IDENTICALLY — no existence oracle'
);

select is(
  pg_temp.submission_sqlstate((select id from t_ids where label='sub2')),
  pg_temp.submission_sqlstate('00000000-0000-0000-0000-000000000000'::uuid),
  'a CROSS-TENANT submission is likewise indistinguishable from a nonexistent one'
);

select is(
  (select count(distinct c) from (values
     (pg_temp.submission_row_count((select id from t_ids where label='sub1b'))),
     (pg_temp.submission_row_count((select id from t_ids where label='sub2'))),
     (pg_temp.submission_row_count('00000000-0000-0000-0000-000000000000'::uuid))
   ) as v(c)),
  1::bigint,
  'colleague''s row, cross-tenant row and nonexistent row all yield the same row count'
);

-- ============================================================================
-- SECTION I — Vendor, Owner and Manager cannot read a private submission
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'vendor_admin'));
select is(pg_temp.submission_sqlstate((select id from t_ids where label='sub1')), '42501',
          'a Vendor Super Admin cannot use this function to read a staff member''s submission');

select pg_temp.act_as((select id from t_ids where label = 'owner1'));
select is(pg_temp.submission_sqlstate((select id from t_ids where label='sub1')), '42501',
          'a Retailer Owner cannot read their own staff member''s submission through it');

select pg_temp.act_as((select id from t_ids where label = 'manager1'));
select is(pg_temp.submission_sqlstate((select id from t_ids where label='sub1')), '42501',
          'a Retailer Manager cannot either');

-- ============================================================================
-- SECTION J — no storage secret is exposed
-- ============================================================================
-- The row exists and carries a bucket, an object path and a SHA-256 (the fixture
-- set all three), so this is a real test of what the FUNCTION withholds rather
-- than of an empty column.
select is(
  pg_temp.table_columns('get_my_receipt_submission'),
  array['submission_id', 'shop_name', 'shop_code', 'status', 'original_file_name',
        'mime_type', 'file_size_bytes', 'submitted_at', 'created_at'],
  'get_my_receipt_submission returns exactly nine columns: no bucket, no object path, no hash, no profile id, no organization id, no failure code'
);

-- Non-vacuity guard for the two shape assertions above and the one below: an
-- introspection query that silently returned nothing would make all three pass by
-- comparing empty to empty.
select isnt(pg_temp.table_columns('get_my_receipt_submission'), '{}'::text[],
            'the column introspection actually resolved something');

-- Byte-identical to its sibling, so one client model deserializes both.
select is(
  pg_temp.table_columns('get_my_receipt_submission'),
  pg_temp.table_columns('list_my_receipt_submissions'),
  'its shape is identical to list_my_receipt_submissions — one client model deserializes both'
);

-- None of the withheld columns may appear under any spelling.
select is(
  (select count(*)
     from unnest(pg_temp.table_columns('get_my_receipt_submission')
                 || pg_temp.table_columns('list_my_receipt_products')) as col
    where col ilike '%bucket%'
       or col ilike '%object_path%'
       or col ilike '%sha%'
       or col ilike '%hash%'
       or col ilike '%profile%'
       or col ilike '%organization%'
       or col ilike '%failure%'),
  0::bigint,
  'no returned column names a bucket, an object path, a hash, a profile, an organization or a failure code'
);

-- ============================================================================
-- SECTION K — the tables themselves stay default-deny
-- ============================================================================
select ok(
  (select relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'receipt_submissions'),
  'receipt_submissions still has RLS enabled'
);

select is(
  (select count(*) from pg_policies
    where schemaname = 'public'
      and tablename in ('receipt_submissions', 'vendor_products', 'vendor_product_retailer_assignments')),
  0::bigint,
  'the three tables these functions read still have ZERO policies — every read goes through a definer RPC'
);

select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('receipt_submissions', 'vendor_products', 'vendor_product_retailer_assignments')
      and grantee in ('anon', 'authenticated')),
  0::bigint,
  'no browser role holds ANY privilege on those tables'
);

-- The bucket must stay private, and no storage policy may have appeared.
select ok(
  (select not public from storage.buckets where id = 'receipts'),
  'the receipts bucket is still private'
);

select is(
  (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'),
  0::bigint,
  'storage.objects still has zero policies — no direct client write path exists'
);

-- ============================================================================
-- SECTION L — this migration changed nothing that was already deployed
-- ============================================================================
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('list_my_assigned_receipt_shops', 'reserve_receipt_submission',
                        'finalize_receipt_submission_upload',
                        'record_receipt_submission_upload_failure',
                        'list_my_receipt_submissions')),
  5::bigint,
  'all five original receipt operations still exist'
);

select ok(
  has_function_privilege('service_role',
    'public.finalize_receipt_submission_upload(uuid, text, text, text, bigint)', 'EXECUTE'),
  'finalize is still granted to service_role'
);
select ok(
  not has_function_privilege('authenticated',
    'public.finalize_receipt_submission_upload(uuid, text, text, text, bigint)', 'EXECUTE'),
  'finalize is still NOT reachable by a browser role'
);
select ok(
  not has_function_privilege('authenticated',
    'public.record_receipt_submission_upload_failure(uuid, text)', 'EXECUTE'),
  'record-failure is still NOT reachable by a browser role'
);

-- ============================================================================
-- SECTION M — catalogue mutations (last: these edit seeded rows)
-- ============================================================================
-- Deactivating the role must revoke both reads immediately, with no code change.
-- This is the property that makes the permission mapping the authority.
update public.roles set status = 'INACTIVE' where code = 'SALES_STAFF';

select pg_temp.act_as((select id from t_ids where label = 'sales1'));
select is(pg_temp.products_sqlstate(), '42501',
          'deactivating SALES_STAFF revokes product access immediately');
select is(pg_temp.submission_sqlstate((select id from t_ids where label='sub1')), '42501',
          'and revokes the submission read immediately — the mapping is the authority');

select * from finish();

rollback;
