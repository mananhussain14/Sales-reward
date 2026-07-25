-- pgTAP behavioural tests for the mobile Vendor Product read contract:
--
--   public.get_vendor_product_detail(uuid)                [added by 20260803090000]
--   public.list_vendor_product_assigned_retailers(uuid)   [added by 20260803090000]
--   public.list_vendor_products()                         [20260727210000 — REUSED AS-IS]
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHY THE PRE-EXISTING LIST IS TESTED HERE TOO
-- ============================================================================
-- list_vendor_products() is not modified by this milestone, but it IS the mobile product
-- list contract, and the milestone that adopts a function is the one that owes it a
-- behavioural specification. Its column set, its zero-argument signature, its grants, its
-- ordering and — above all — its active_assignment_count semantics are now depended on by a
-- second client, and by get_vendor_product_detail(), whose active_assignment_count must
-- equal it row for row. Sections A, D, E and F assert those properties directly rather than
-- assuming them.
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as
-- the `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as far
-- as every authorization helper in this schema is concerned. pg_temp.act_as() does exactly
-- that and pg_temp.sign_out() clears it. This mirrors portal_context_test.sql,
-- sales_staff_receipt_reads_test.sql, vendor_retailer_reads_test.sql,
-- vendor_user_reads_test.sql and vendor_role_reads_test.sql exactly, deliberately: six
-- different impersonation idioms in one suite directory would be six different claims about
-- what "signed in" means.
--
-- The tests deliberately do NOT `set role authenticated`. All three functions are SECURITY
-- DEFINER, so their behaviour depends on auth.uid() and not on the session role, and
-- switching roles mid-transaction would only make the fixture inserts fail. EXECUTE
-- privilege is a separate concern and is asserted directly against the catalogue in
-- Section A, which is a stronger check than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back, so no fixture survives — not
-- the products and assignments inserted below, and not Section K, which temporarily removes
-- seeded role→permission mappings.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file
-- turns an added test into a confusing failure about arithmetic rather than about behaviour.
--
-- ============================================================================
-- WHAT "DENIED" MEANS HERE, AND WHY THE TWO KINDS DIFFER
-- ============================================================================
-- All three functions RAISE 42501 for a caller who is not an authorized Vendor Super Admin
-- holding the required permissions. A denial and "this Vendor has no products" are different
-- facts, and a client renders them differently.
--
-- The two new functions additionally return ZERO ROWS — never a raise — for an authorized
-- Vendor who names a product id that is not theirs, is not a product at all, or is null.
-- Section H proves those three answers are byte-identical, which is what stops an id sweep
-- from revealing the size or existence of another Vendor's catalogue.

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

/* Creates an auth user + a profile with explicit name parts, and returns the id. */
create function pg_temp.new_person(
  p_first text,
  p_last text,
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || lower(p_last) || '@test.invalid');

  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, p_status);

  return v_id;
end;
$$;

create function pg_temp.new_org(
  p_name text,
  p_type text default 'VENDOR',
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.organizations (name, organization_type, status, country_code, default_currency)
  values (p_name, p_type, p_status, 'AE', 'AED')
  returning id into v_id;
  return v_id;
end;
$$;

/* Creates a membership of the given status and returns its id. No role is assigned. */
create function pg_temp.add_member(
  p_user uuid,
  p_org uuid,
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, p_status,
          case when p_status = 'INVITED' then null else now() - interval '30 days' end)
  returning id into v_member;
  return v_member;
end;
$$;

/* Assigns one role, by code, to an existing membership. */
create function pg_temp.add_role(p_member uuid, p_role_code text) returns void
language plpgsql as $$
begin
  insert into public.member_roles (organization_member_id, role_id)
  select p_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;
end;
$$;

/* Links a Vendor to a Retailer and returns the relationship id. */
create function pg_temp.link(
  p_vendor uuid,
  p_retailer uuid,
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (p_vendor, p_retailer, p_status)
  returning id into v_id;
  return v_id;
end;
$$;

/*
 * Creates a product DIRECTLY, not through create_vendor_product().
 *
 * Deliberate: the write RPC derives the Vendor from auth.uid(), so building fixtures through
 * it would mean signing in as each Vendor to seed the other's catalogue, and would make
 * these read tests depend on the write path they are not testing. A direct insert states
 * every field explicitly — including the ones the RPC would normalize — so the assertions
 * below compare against values written here rather than against values the RPC chose.
 */
create function pg_temp.new_product(
  p_vendor uuid,
  p_code text,
  p_name text,
  p_creator uuid,
  p_barcode text default null,
  p_brand text default null,
  p_description text default null,
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.vendor_products (
    vendor_organization_id, product_code, barcode, product_name, brand, description,
    status, created_by_profile_id, created_at, updated_at
  )
  values (
    p_vendor, p_code, p_barcode, p_name, p_brand, p_description,
    p_status, p_creator, now() - interval '10 days', now() - interval '5 days'
  )
  returning id into v_id;
  return v_id;
end;
$$;

/*
 * Creates an assignment row directly, with explicit timestamps.
 *
 * assigned_at and updated_at are written explicitly so Section G can assert them by value.
 * set_updated_at_on_vendor_product_assignments is a BEFORE UPDATE trigger only, so an
 * explicitly-inserted updated_at survives.
 */
create function pg_temp.assign(
  p_product uuid,
  p_retailer uuid,
  p_actor uuid,
  p_status text default 'ACTIVE',
  p_assigned_at timestamptz default null,
  p_updated_at timestamptz default null
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.vendor_product_retailer_assignments (
    vendor_product_id, retailer_organization_id, status, assigned_by_profile_id,
    assigned_at, updated_at
  )
  values (
    p_product, p_retailer, p_status, p_actor,
    coalesce(p_assigned_at, now() - interval '3 days'),
    coalesce(p_updated_at, now() - interval '3 days')
  )
  returning id into v_id;
  return v_id;
end;
$$;

/*
 * CATALOGUE INTROSPECTION FOR `RETURNS TABLE` FUNCTIONS.
 *
 * A set-returning `returns table (...)` function has prorettype = `record`, a pseudo-type
 * with no typrelid — so joining pg_type -> pg_class -> pg_attribute to read its columns
 * silently yields NOTHING, and an assertion written that way compares NULL to NULL and
 * passes vacuously. The column names live in proargnames alongside the INPUT parameter
 * names, distinguished only by proargmodes: 'i' (or 'b'/'v') for an input, 't' for a table
 * column. Both helpers below therefore filter on the mode.
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

create function pg_temp.table_columns(p_name text) returns text[]
language sql stable as $$
  select pg_temp.arg_names(p_name, array['t'::"char"]);
$$;

create function pg_temp.input_args(p_name text) returns text[]
language sql stable as $$
  select pg_temp.arg_names(p_name, array['i'::"char", 'b'::"char", 'v'::"char"]);
$$;

/*
 * The SQLSTATE raised when the current caller runs p_sql, or NULL if it returned normally.
 * Sequenced in plpgsql on purpose: throws_ok() cannot express the "zero rows here, raise
 * there" comparisons Sections H and J need, and comparing SQLSTATEs is what makes "these two
 * answers are indistinguishable" a testable claim rather than a comment.
 */
create function pg_temp.sqlstate_of(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end;
$$;

/*
 * The product names visible to the current caller, IN THE FUNCTION'S OWN ORDER.
 *
 * row_number() over () numbers rows in the order they arrive from the function, and the
 * aggregate then sorts by that number — so this captures what the function emitted rather
 * than re-sorting it. Aggregating `order by product_name` would sort the evidence into
 * agreement with the assertion.
 */
create function pg_temp.my_product_names() returns text[]
language sql as $$
  select coalesce(array_agg(t.product_name order by t.ord), '{}'::text[])
  from (
    select l.product_name, row_number() over () as ord
    from public.list_vendor_products() l
  ) t;
$$;

/* Single columns of the list, keyed by product code. */
create function pg_temp.list_active_count(p_code text) returns bigint
language sql as $$
  select l.active_assignment_count from public.list_vendor_products() l
  where l.product_code = p_code;
$$;

create function pg_temp.list_status(p_code text) returns text
language sql as $$
  select l.status from public.list_vendor_products() l where l.product_code = p_code;
$$;

create function pg_temp.list_product_id(p_code text) returns uuid
language sql as $$
  select l.product_id from public.list_vendor_products() l where l.product_code = p_code;
$$;

create function pg_temp.list_rows() returns bigint
language sql as $$ select count(*) from public.list_vendor_products(); $$;

/* Single columns of the detail. */
create function pg_temp.detail_rows(p_product uuid) returns bigint
language sql as $$ select count(*) from public.get_vendor_product_detail(p_product); $$;

create function pg_temp.detail_total(p_product uuid) returns bigint
language sql as $$
  select d.assignment_count from public.get_vendor_product_detail(p_product) d;
$$;

create function pg_temp.detail_active(p_product uuid) returns bigint
language sql as $$
  select d.active_assignment_count from public.get_vendor_product_detail(p_product) d;
$$;

/* The Retailer names of one product's assignments, IN THE FUNCTION'S OWN ORDER. */
create function pg_temp.assigned_names(p_product uuid) returns text[]
language sql as $$
  select coalesce(array_agg(t.retailer_name order by t.ord), '{}'::text[])
  from (
    select l.retailer_name, row_number() over () as ord
    from public.list_vendor_product_assigned_retailers(p_product) l
  ) t;
$$;

create function pg_temp.assigned_rows(p_product uuid) returns bigint
language sql as $$
  select count(*) from public.list_vendor_product_assigned_retailers(p_product);
$$;

/* One assignment row's columns, keyed by Retailer name. */
create function pg_temp.a_status(p_product uuid, p_retailer text) returns text
language sql as $$
  select l.assignment_status from public.list_vendor_product_assigned_retailers(p_product) l
  where l.retailer_name = p_retailer;
$$;

create function pg_temp.a_rel_status(p_product uuid, p_retailer text) returns text
language sql as $$
  select l.relationship_status from public.list_vendor_product_assigned_retailers(p_product) l
  where l.retailer_name = p_retailer;
$$;

create function pg_temp.a_retailer_status(p_product uuid, p_retailer text) returns text
language sql as $$
  select l.retailer_status from public.list_vendor_product_assigned_retailers(p_product) l
  where l.retailer_name = p_retailer;
$$;

create function pg_temp.a_rel_id(p_product uuid, p_retailer text) returns uuid
language sql as $$
  select l.relationship_id from public.list_vendor_product_assigned_retailers(p_product) l
  where l.retailer_name = p_retailer;
$$;

create function pg_temp.a_org_id(p_product uuid, p_retailer text) returns uuid
language sql as $$
  select l.retailer_organization_id
  from public.list_vendor_product_assigned_retailers(p_product) l
  where l.retailer_name = p_retailer;
$$;

create function pg_temp.a_assigned_at(p_product uuid, p_retailer text) returns timestamptz
language sql as $$
  select l.assigned_at from public.list_vendor_product_assigned_retailers(p_product) l
  where l.retailer_name = p_retailer;
$$;

create function pg_temp.a_updated_at(p_product uuid, p_retailer text) returns timestamptz
language sql as $$
  select l.assignment_updated_at
  from public.list_vendor_product_assigned_retailers(p_product) l
  where l.retailer_name = p_retailer;
$$;


-- ============================================================================
-- Fixtures
-- ============================================================================
-- Deterministic: every organization, relationship, product, status and timestamp below is
-- written explicitly. Nothing depends on the seed data except the role catalogue and its
-- permission mappings, which this suite reads and (in Section K only, transactionally)
-- removes rows from — it never adds a mapping, because proving a permission requirement by
-- granting it would prove nothing.

create table pg_temp.fx (k text primary key, v uuid);

insert into pg_temp.fx (k, v) values
  ('vendor_a', pg_temp.new_org('Vendor A')),
  ('vendor_b', pg_temp.new_org('Vendor B'));

create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.fx where k = p_k; $$;

-- Retailers. Four different (relationship status × organization status) combinations, so
-- Section G can prove that NEITHER of them is allowed to alter an assignment status and that
-- neither filters a row out.
insert into pg_temp.fx (k, v) values
  ('alpha',   pg_temp.new_org('Alpha Retail',  'RETAILER', 'ACTIVE')),
  ('bravo',   pg_temp.new_org('Bravo Stores',  'RETAILER', 'ACTIVE')),
  ('cedar',   pg_temp.new_org('Cedar Mart',    'RETAILER', 'SUSPENDED')),
  ('delta',   pg_temp.new_org('Delta Shops',   'RETAILER', 'ACTIVE')),
  ('echo',    pg_temp.new_org('Echo Traders',  'RETAILER', 'ACTIVE')),
  ('foxtrot', pg_temp.new_org('Foxtrot Group', 'RETAILER', 'ACTIVE'));

insert into pg_temp.fx (k, v) values
  -- Vendor A's Retailers, one per relationship status.
  ('rel_alpha', pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('alpha'), 'ACTIVE')),
  ('rel_bravo', pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('bravo'), 'SUSPENDED')),
  ('rel_cedar', pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('cedar'), 'ACTIVE')),
  ('rel_delta', pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('delta'), 'DEACTIVATED')),
  -- Related, but never assigned anything. Must be ABSENT from the assignment read, which is
  -- the difference from list_vendor_product_retailer_assignments().
  ('rel_echo',  pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('echo'),  'ACTIVE')),
  -- Vendor B's Retailer. Vendor A must never see it or its assignment.
  ('rel_fox',   pg_temp.link(pg_temp.fx('vendor_b'), pg_temp.fx('foxtrot'), 'ACTIVE'));

-- People.
insert into pg_temp.fx (k, v) values
  ('ada',     pg_temp.new_person('Ada',  'Admin')),                       -- Vendor A, authorized
  ('bob',     pg_temp.new_person('Bob',  'Suspended', 'SUSPENDED')),      -- suspended PROFILE
  ('cara',    pg_temp.new_person('Cara', 'Deactivated')),                 -- deactivated MEMBERSHIP
  ('eve',     pg_temp.new_person('Eve',  'Financeonly')),                 -- Vendor role, not Super Admin
  ('gil',     pg_temp.new_person('Gil',  'Bravo')),                       -- Vendor B, authorized
  ('owner',   pg_temp.new_person('Ora',  'Owner')),
  ('manager', pg_temp.new_person('Mia',  'Manager')),
  ('staff',   pg_temp.new_person('Sam',  'Staff')),
  ('no_org',  pg_temp.new_person('Ned',  'Noorg'));                       -- member of nothing

insert into pg_temp.fx (k, v) values
  ('m_ada',     pg_temp.add_member(pg_temp.fx('ada'),     pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_bob',     pg_temp.add_member(pg_temp.fx('bob'),     pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_cara',    pg_temp.add_member(pg_temp.fx('cara'),    pg_temp.fx('vendor_a'), 'DEACTIVATED')),
  ('m_eve',     pg_temp.add_member(pg_temp.fx('eve'),     pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_gil',     pg_temp.add_member(pg_temp.fx('gil'),     pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_owner',   pg_temp.add_member(pg_temp.fx('owner'),   pg_temp.fx('alpha'), 'ACTIVE')),
  ('m_manager', pg_temp.add_member(pg_temp.fx('manager'), pg_temp.fx('alpha'), 'ACTIVE')),
  ('m_staff',   pg_temp.add_member(pg_temp.fx('staff'),   pg_temp.fx('alpha'), 'ACTIVE'));

select pg_temp.add_role(pg_temp.fx('m_ada'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_bob'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_cara'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_gil'),  'VENDOR_SUPER_ADMIN');
-- A Vendor member with a real Vendor role that is NOT Vendor Super Admin. FINANCE_ADMIN is
-- mapped to no PRODUCTS_* permission, and get_vendor_super_admin_context() filters on the
-- Super Admin role, so Eve fails at the first gate.
select pg_temp.add_role(pg_temp.fx('m_eve'), 'FINANCE_ADMIN');

select pg_temp.add_role(pg_temp.fx('m_owner'),   'RETAILER_OWNER');
select pg_temp.add_role(pg_temp.fx('m_manager'), 'RETAILER_MANAGER');
select pg_temp.add_role(pg_temp.fx('m_staff'),   'SALES_STAFF');

-- Products.
--
-- Vendor A holds three, written newest-created LAST so the list's `created_at desc` ordering
-- is a real claim rather than an accident of insertion order. pg_temp.new_product stamps a
-- fixed created_at, so the three are separated explicitly below instead.
insert into pg_temp.fx (k, v) values
  ('p_widget', pg_temp.new_product(
      pg_temp.fx('vendor_a'), 'A-100', 'Alpha Widget', pg_temp.fx('ada'),
      '1234567890123', 'Acme', 'A widget that widgets.', 'ACTIVE')),
  -- Every nullable field genuinely null, and an INACTIVE product: the contract must return
  -- nulls as nulls and must not hide an inactive product or drop its assignments.
  ('p_gadget', pg_temp.new_product(
      pg_temp.fx('vendor_a'), 'B-200', 'Beta Gadget', pg_temp.fx('ada'),
      null, null, null, 'INACTIVE')),
  -- No assignment at all: one row in the list, zero counts, empty companion.
  ('p_thing',  pg_temp.new_product(
      pg_temp.fx('vendor_a'), 'C-300', 'Gamma Thing', pg_temp.fx('ada'),
      null, 'Acme', null, 'ACTIVE')),
  -- VENDOR B's product, deliberately carrying the SAME product code as Vendor A's. The code
  -- unique index is per Vendor, so this is legal — and it proves the isolation assertions
  -- are matching on tenant rather than on a value that happens to be unique.
  ('p_bravo',  pg_temp.new_product(
      pg_temp.fx('vendor_b'), 'A-100', 'Bravo Item', pg_temp.fx('gil'),
      '9876543210987', 'Bravo Brand', 'Vendor B''s own product.', 'ACTIVE'));

-- Distinct created_at values, ordered so that Gamma Thing is newest. The list must emit
-- Gamma Thing, Beta Gadget, Alpha Widget — which is NOT alphabetical order, so an
-- accidental re-sort would be visible.
update public.vendor_products set created_at = now() - interval '30 days'
  where id = pg_temp.fx('p_widget');
update public.vendor_products set created_at = now() - interval '20 days'
  where id = pg_temp.fx('p_gadget');
update public.vendor_products set created_at = now() - interval '10 days'
  where id = pg_temp.fx('p_thing');

-- Assignments of Alpha Widget. Four rows, two ACTIVE:
--
--   Alpha Retail   ACTIVE   rel ACTIVE       org ACTIVE      -> counts as active
--   Bravo Stores   ACTIVE   rel SUSPENDED    org ACTIVE      -> STILL counts as active
--   Cedar Mart     INACTIVE rel ACTIVE       org SUSPENDED   -> withdrawn; total only
--   Delta Shops    INACTIVE rel DEACTIVATED  org ACTIVE      -> withdrawn; total only
--   Echo Traders   (no row)                                  -> absent entirely
--
-- assignment_count = 4, active_assignment_count = 2.
insert into pg_temp.fx (k, v) values
  ('as_alpha', pg_temp.assign(pg_temp.fx('p_widget'), pg_temp.fx('alpha'), pg_temp.fx('ada'),
      'ACTIVE',   timestamptz '2026-05-01 10:00:00+00', timestamptz '2026-05-01 10:00:00+00')),
  ('as_bravo', pg_temp.assign(pg_temp.fx('p_widget'), pg_temp.fx('bravo'), pg_temp.fx('ada'),
      'ACTIVE',   timestamptz '2026-05-02 10:00:00+00', timestamptz '2026-05-02 10:00:00+00')),
  ('as_cedar', pg_temp.assign(pg_temp.fx('p_widget'), pg_temp.fx('cedar'), pg_temp.fx('ada'),
      'INACTIVE', timestamptz '2026-05-03 10:00:00+00', timestamptz '2026-06-03 10:00:00+00')),
  ('as_delta', pg_temp.assign(pg_temp.fx('p_widget'), pg_temp.fx('delta'), pg_temp.fx('ada'),
      'INACTIVE', timestamptz '2026-05-04 10:00:00+00', timestamptz '2026-06-04 10:00:00+00')),
  -- Beta Gadget is INACTIVE as a product but keeps a live assignment: set_vendor_product_status
  -- deliberately does not cascade, and neither count consults the product's own status.
  ('as_gadget', pg_temp.assign(pg_temp.fx('p_gadget'), pg_temp.fx('alpha'), pg_temp.fx('ada'),
      'ACTIVE',   timestamptz '2026-05-05 10:00:00+00', timestamptz '2026-05-05 10:00:00+00')),
  -- Vendor B's own assignment. Must never appear in any Vendor A answer.
  ('as_fox', pg_temp.assign(pg_temp.fx('p_bravo'), pg_temp.fx('foxtrot'), pg_temp.fx('gil'),
      'ACTIVE',   timestamptz '2026-05-06 10:00:00+00', timestamptz '2026-05-06 10:00:00+00'));


-- ============================================================================
-- SECTION A — signature, security attributes and privileges (catalogue-level)
-- ============================================================================
-- Asserted against the catalogue rather than inferred from behaviour: "it did not error for
-- me" is not a privilege check, and a grant that widened by accident would still let every
-- behavioural test pass.

select has_function('public', 'get_vendor_product_detail', array['uuid'],
  'get_vendor_product_detail(uuid) exists');
select has_function('public', 'list_vendor_product_assigned_retailers', array['uuid'],
  'list_vendor_product_assigned_retailers(uuid) exists');
select has_function('public', 'list_vendor_products', '{}'::text[],
  'list_vendor_products() still exists and still takes no arguments');

-- The pre-existing assignment EDITOR read is untouched and still present with its original
-- signature. The web product detail page depends on it exactly as it is.
select has_function('public', 'list_vendor_product_retailer_assignments', array['uuid'],
  'the existing assignment editor read is untouched and still exists');

-- NO IDENTITY, VENDOR, TENANT, ROLE-CODE, PERMISSION-CODE OR STATUS ARGUMENT ON ANY READ.
select is(pg_temp.input_args('list_vendor_products'), '{}'::text[],
  'list_vendor_products() accepts no client input at all');
select is(pg_temp.input_args('get_vendor_product_detail'), array['p_product_id'],
  'get_vendor_product_detail takes exactly one input: the product selector');
select is(pg_temp.input_args('list_vendor_product_assigned_retailers'), array['p_product_id'],
  'list_vendor_product_assigned_retailers takes exactly one input: the same product selector');

-- The two selectors are the SAME parameter name and type, so the operations cannot drift
-- into two address spaces.
select is(
  pg_temp.input_args('get_vendor_product_detail'),
  pg_temp.input_args('list_vendor_product_assigned_retailers'),
  'detail and its assignment companion are addressed identically');

-- The selector is a uuid, not a code, a status or a name.
select is(
  (select array_agg(format_type(t, null) order by ord)
   from unnest(
     (select p.proargtypes::oid[] from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='get_vendor_product_detail')
   ) with ordinality as x(t, ord)),
  array['uuid'],
  'the detail selector is a uuid — never a product code, status or name');

-- Exact output shape. A positional `returns table` contract is only stable if the column
-- list is pinned, and pinning it is what makes an accidental addition a test failure rather
-- than a silently broken pinned mobile build.
select is(
  pg_temp.table_columns('list_vendor_products'),
  array['product_id', 'product_code', 'barcode', 'product_name', 'brand', 'description',
        'status', 'active_assignment_count', 'created_at', 'updated_at'],
  'list_vendor_products() returns exactly the ten shipped columns, in order');

select is(
  pg_temp.table_columns('get_vendor_product_detail'),
  array['product_id', 'product_code', 'barcode', 'product_name', 'brand', 'description',
        'status', 'assignment_count', 'active_assignment_count', 'created_at', 'updated_at'],
  'get_vendor_product_detail() returns exactly the eleven agreed columns, in order');

-- Stated as a relationship as well as two literals: the detail column set IS the list column
-- set plus exactly `assignment_count`, so one Flutter model deserializes both and a future
-- addition has to be made to both or to neither.
select is(
  (select array_agg(c order by c) from unnest(pg_temp.table_columns('get_vendor_product_detail')) c),
  (select array_agg(c order by c) from unnest(
     pg_temp.table_columns('list_vendor_products') || array['assignment_count']) c),
  'the detail column set is the list column set plus assignment_count, and nothing else');

select is(
  pg_temp.table_columns('list_vendor_product_assigned_retailers'),
  array['relationship_id', 'retailer_organization_id', 'retailer_name', 'retailer_status',
        'relationship_status', 'assignment_status', 'assigned_at', 'assignment_updated_at'],
  'list_vendor_product_assigned_retailers() returns exactly the eight agreed columns, in order');

-- The existing editor read's shape is unchanged — proof that this migration did not quietly
-- widen or narrow the function the web depends on.
select is(
  pg_temp.table_columns('list_vendor_product_retailer_assignments'),
  array['retailer_organization_id', 'retailer_name', 'retailer_status',
        'relationship_status', 'assignment_status', 'assigned_at'],
  'the existing assignment editor read still returns its original six columns');

-- FORBIDDEN FIELDS. The exact-column assertions above already exclude these; this states the
-- rules directly so the reasons survive a future column addition.
select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_products')
     || pg_temp.table_columns('get_vendor_product_detail')
     || pg_temp.table_columns('list_vendor_product_assigned_retailers')) c
   where c ~ 'token|hash|secret|password|provider|session|ip_address|invitation|auth_user|user_id|profile_id|created_by|assigned_by|tenant|membership|vendor_organization'),
  0::bigint,
  'no output column names a token, hash, secret, credential, invitation, auth user, profile, creator, membership, tenant or Vendor organization');

select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_products')
     || pg_temp.table_columns('get_vendor_product_detail')
     || pg_temp.table_columns('list_vendor_product_assigned_retailers')) c
   where c ~ 'email|phone|mobile|first_name|last_name|contact|address|owner'),
  0::bigint,
  'no output column carries Retailer personal or contact data — an assignment names an organization, never a person');

-- IMAGES AND STORAGE. The audit found no product image column, no product bucket and no
-- image rendering anywhere in the web product pages. Nothing may introduce one by inference.
select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_products')
     || pg_temp.table_columns('get_vendor_product_detail')
     || pg_temp.table_columns('list_vendor_product_assigned_retailers')) c
-- \y anchors each alternative to a word boundary. Without it, `assigned_at` matches "signed"
-- and `created_by_profile_id` matches "file", and the assertion would fail for a reason that
-- has nothing to do with storage.
   where c ~ '\y(image|photo|picture|thumbnail|media|asset|bucket|storage|object_path|signed|url|file|path|key)'),
  0::bigint,
  'no output column returns an image, a storage path, a bucket, a signed URL or a file reference');

-- And the schema itself still has no such column, so there is nothing that COULD be returned.
select is(
  (select count(*) from information_schema.columns
   where table_schema = 'public' and table_name = 'vendor_products'
     and column_name ~ '\y(image|photo|picture|thumbnail|media|asset|bucket|storage|url|file|path)'),
  0::bigint,
  'public.vendor_products still has no image, media or storage column at all');

-- Nor does any storage bucket hold product media. The only buckets this schema creates are
-- the receipt ones, so option A of the image decision — return nothing, because nothing
-- exists — is the only honest answer available.
select is(
  (select count(*) from storage.buckets b where b.id ~* 'product'),
  0::bigint,
  'no storage bucket holds product media');

select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_products')
     || pg_temp.table_columns('get_vendor_product_detail')
     || pg_temp.table_columns('list_vendor_product_assigned_retailers')) c
   where c ~ 'policy|rls|grant|search_path|definer|expression'),
  0::bigint,
  'no output column exposes a policy name, grant, RLS expression or function internal');

-- Fields no part of this schema supports, asserted ABSENT so a later edit cannot invent
-- product semantics. There is no price, incentive, campaign, reward, coin, payout, claim,
-- receipt, inventory, shop-assignment or draft/archived concept anywhere in the product
-- model.
select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_products')
     || pg_temp.table_columns('get_vendor_product_detail')
     || pg_temp.table_columns('list_vendor_product_assigned_retailers')) c
   where c ~ 'price|cost|amount|currency|incentive|reward|campaign|coin|payout|claim|receipt|sales|inventory|stock|shop'),
  0::bigint,
  'no output column invents pricing, incentive, campaign, reward, coin, payout, claim, receipt, inventory or shop data');

-- Security attributes.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public'
     and p.proname in ('get_vendor_product_detail','list_vendor_product_assigned_retailers')
     and p.prosecdef),
  2::bigint,
  'both new functions are SECURITY DEFINER');

-- `set search_path = ''` is stored by PostgreSQL as the literal `search_path=""` — the empty
-- string, quoted. Asserting `search_path=` (unquoted) would match nothing and the test would
-- fail even on a correctly-hardened function.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public'
     and p.proname in ('get_vendor_product_detail','list_vendor_product_assigned_retailers')
     and p.proconfig @> array['search_path=""']),
  2::bigint,
  'both new functions pin an EMPTY search_path');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public'
     and p.proname in ('get_vendor_product_detail','list_vendor_product_assigned_retailers')
     and p.provolatile = 's'),
  2::bigint,
  'both new functions are STABLE — neither may write a product, an assignment or an audit row');

-- Grants: authenticated yes, anon no, PUBLIC no, service_role no.
select ok(has_function_privilege('authenticated', 'public.get_vendor_product_detail(uuid)', 'execute'),
  'authenticated may execute get_vendor_product_detail(uuid)');
select ok(has_function_privilege('authenticated', 'public.list_vendor_product_assigned_retailers(uuid)', 'execute'),
  'authenticated may execute list_vendor_product_assigned_retailers(uuid)');
select ok(has_function_privilege('authenticated', 'public.list_vendor_products()', 'execute'),
  'authenticated may still execute list_vendor_products()');

select ok(not has_function_privilege('anon', 'public.get_vendor_product_detail(uuid)', 'execute'),
  'anon may NOT execute get_vendor_product_detail(uuid)');
select ok(not has_function_privilege('anon', 'public.list_vendor_product_assigned_retailers(uuid)', 'execute'),
  'anon may NOT execute list_vendor_product_assigned_retailers(uuid)');
select ok(not has_function_privilege('anon', 'public.list_vendor_products()', 'execute'),
  'anon may still NOT execute list_vendor_products()');

-- PUBLIC holds nothing. A PUBLIC grant appears in proacl as an entry with an empty grantee
-- ("=X/owner"), and PUBLIC is inherited by every role — so a leftover default grant would
-- hand anon EXECUTE despite the explicit revokes.
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where n.nspname='public'
     and p.proname in ('get_vendor_product_detail','list_vendor_product_assigned_retailers')
     and a::text like '=%'),
  0::bigint,
  'PUBLIC holds EXECUTE on neither new function');

select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where n.nspname='public'
     and p.proname in ('get_vendor_product_detail','list_vendor_product_assigned_retailers')
     and a::text like 'service_role=%'),
  0::bigint,
  'service_role is granted neither — both derive authority from auth.uid()');


-- ============================================================================
-- SECTION B — the tables are still default-deny, and RLS is not weakened
-- ============================================================================
-- A SECURITY DEFINER function is allowed to run outside the policies; what must never happen
-- is a table being opened so that a direct PostgREST select becomes an easier path than the
-- contract. Both product tables shipped with RLS enabled, ZERO policies and no privilege for
-- any browser role, and this milestone must have changed none of that.

select ok((select relrowsecurity from pg_class where oid = 'public.vendor_products'::regclass),
  'public.vendor_products still has RLS enabled');
select ok((select relrowsecurity from pg_class
           where oid = 'public.vendor_product_retailer_assignments'::regclass),
  'public.vendor_product_retailer_assignments still has RLS enabled');

select is(
  (select count(*) from pg_policies
   where schemaname = 'public'
     and tablename in ('vendor_products', 'vendor_product_retailer_assignments')),
  0::bigint,
  'both product tables still carry ZERO policies — they remain RPC-only and default-deny');

select ok(not has_table_privilege('authenticated', 'public.vendor_products', 'select'),
  'authenticated still may NOT select public.vendor_products directly');
select ok(not has_table_privilege('anon', 'public.vendor_products', 'select'),
  'anon still may NOT select public.vendor_products directly');
select ok(not has_table_privilege('authenticated', 'public.vendor_product_retailer_assignments', 'select'),
  'authenticated still may NOT select the assignment table directly');
select ok(not has_table_privilege('anon', 'public.vendor_product_retailer_assignments', 'select'),
  'anon still may NOT select the assignment table directly');

-- No write privilege was granted to a browser role either, on either table.
select is(
  (select count(*) from unnest(array['insert','update','delete']) act
   where has_table_privilege('authenticated', 'public.vendor_products', act)
      or has_table_privilege('authenticated', 'public.vendor_product_retailer_assignments', act)),
  0::bigint,
  'authenticated holds no insert, update or delete on either product table');

-- The tables the reads join to keep their own RLS.
select ok((select relrowsecurity from pg_class where oid = 'public.vendor_retailers'::regclass),
  'public.vendor_retailers still has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.organizations'::regclass),
  'public.organizations still has RLS enabled');

-- The product status vocabulary is still exactly two words. Nothing in this milestone may
-- introduce a draft, archived, discontinued or approval state — and a client that renders
-- one would be rendering a state the database cannot produce.
select is(
  (select count(*) from pg_constraint
   where conrelid = 'public.vendor_products'::regclass
     and conname = 'vendor_products_status_allowed'),
  1::bigint,
  'the product status CHECK is unchanged — ACTIVE and INACTIVE remain the only states');
select is(
  (select count(*) from pg_constraint
   where conrelid = 'public.vendor_product_retailer_assignments'::regclass
     and conname = 'vendor_product_assignments_status_allowed'),
  1::bigint,
  'the assignment status CHECK is unchanged — ACTIVE and INACTIVE remain the only states');

-- ONE assignment row per (product, Retailer) FOR ALL TIME. This index is what makes
-- "assignment history cannot inflate a count" a schema fact rather than a hope, and both
-- count semantics in Section F rest on it.
select is(
  (select count(*) from pg_indexes
   where schemaname = 'public'
     and indexname = 'vendor_product_retailer_assign_unique_idx'),
  1::bigint,
  'the (product, Retailer) unique index still exists — a pairing can never have two rows');


-- ============================================================================
-- SECTION C — denials
-- ============================================================================
-- Every unauthorized caller gets 42501 from all three reads, and no caller learns anything
-- from the difference between them.

select pg_temp.sign_out();
select throws_ok('select * from public.list_vendor_products()', '42501',
  null, 'signed out: list is refused');
select throws_ok(
  format('select * from public.get_vendor_product_detail(%L)', pg_temp.fx('p_widget')), '42501',
  null, 'signed out: detail is refused');
select throws_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  '42501', null, 'signed out: assignments are refused');

-- Authenticated, but a member of no organization at all.
select pg_temp.act_as(pg_temp.fx('no_org'));
select throws_ok('select * from public.list_vendor_products()', '42501',
  null, 'no organization: list is refused');
select throws_ok(
  format('select * from public.get_vendor_product_detail(%L)', pg_temp.fx('p_widget')), '42501',
  null, 'no organization: detail is refused');
select throws_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  '42501', null, 'no organization: assignments are refused');

-- A Vendor member holding a real Vendor role that is not Vendor Super Admin.
select pg_temp.act_as(pg_temp.fx('eve'));
select throws_ok('select * from public.list_vendor_products()', '42501',
  null, 'Vendor member without Super Admin authority: list is refused');
select throws_ok(
  format('select * from public.get_vendor_product_detail(%L)', pg_temp.fx('p_widget')), '42501',
  null, 'Vendor member without Super Admin authority: detail is refused');
select throws_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  '42501', null, 'Vendor member without Super Admin authority: assignments are refused');

-- A Vendor Super Admin whose PROFILE is suspended.
select pg_temp.act_as(pg_temp.fx('bob'));
select throws_ok('select * from public.list_vendor_products()', '42501',
  null, 'suspended profile: list is refused');
select throws_ok(
  format('select * from public.get_vendor_product_detail(%L)', pg_temp.fx('p_widget')), '42501',
  null, 'suspended profile: detail is refused');
select throws_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  '42501', null, 'suspended profile: assignments are refused');

-- A Vendor Super Admin whose MEMBERSHIP is deactivated.
select pg_temp.act_as(pg_temp.fx('cara'));
select throws_ok('select * from public.list_vendor_products()', '42501',
  null, 'deactivated membership: list is refused');
select throws_ok(
  format('select * from public.get_vendor_product_detail(%L)', pg_temp.fx('p_widget')), '42501',
  null, 'deactivated membership: detail is refused');
select throws_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  '42501', null, 'deactivated membership: assignments are refused');

-- Retailer Owner.
select pg_temp.act_as(pg_temp.fx('owner'));
select throws_ok('select * from public.list_vendor_products()', '42501',
  null, 'Retailer Owner: list is refused');
select throws_ok(
  format('select * from public.get_vendor_product_detail(%L)', pg_temp.fx('p_widget')), '42501',
  null, 'Retailer Owner: detail is refused');
select throws_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  '42501', null, 'Retailer Owner: assignments are refused');

-- Retailer Manager.
select pg_temp.act_as(pg_temp.fx('manager'));
select throws_ok('select * from public.list_vendor_products()', '42501',
  null, 'Retailer Manager: list is refused');
select throws_ok(
  format('select * from public.get_vendor_product_detail(%L)', pg_temp.fx('p_widget')), '42501',
  null, 'Retailer Manager: detail is refused');
select throws_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  '42501', null, 'Retailer Manager: assignments are refused');

-- Sales Staff. Note this is the Retailer that Alpha Widget is ACTIVELY assigned to: being
-- able to SEE a product through list_retailer_assigned_products() grants nothing here.
select pg_temp.act_as(pg_temp.fx('staff'));
select throws_ok('select * from public.list_vendor_products()', '42501',
  null, 'Sales Staff: list is refused');
select throws_ok(
  format('select * from public.get_vendor_product_detail(%L)', pg_temp.fx('p_widget')), '42501',
  null, 'Sales Staff: detail is refused');
select throws_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  '42501', null, 'Sales Staff: assignments are refused');

-- The refusal is INDISTINGUISHABLE across caller kinds and across the three functions. A
-- Retailer Owner and a signed-out stranger get the same SQLSTATE, so neither learns their
-- session was recognized.
select pg_temp.sign_out();
select is(
  pg_temp.sqlstate_of(format('select * from public.get_vendor_product_detail(%L)',
                             pg_temp.fx('p_widget'))),
  '42501',
  'the signed-out detail refusal is 42501');

select pg_temp.act_as(pg_temp.fx('owner'));
select is(
  pg_temp.sqlstate_of(format('select * from public.get_vendor_product_detail(%L)',
                             pg_temp.fx('p_widget'))),
  pg_temp.sqlstate_of(format('select * from public.list_vendor_product_assigned_retailers(%L)',
                             pg_temp.fx('p_widget'))),
  'detail and assignments refuse a Retailer Owner identically');


-- ============================================================================
-- SECTION D — the authorized list: identity, fields, nullability and ordering
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.list_rows(), 3::bigint,
  'Vendor A sees exactly its own three products');

-- Ordering: newest created first, which is NOT alphabetical, so a re-sort would show.
select is(
  pg_temp.my_product_names(),
  array['Gamma Thing', 'Beta Gadget', 'Alpha Widget'],
  'the list is ordered newest-created first, deterministically');

-- Identity is the real row id, and it is the id the detail read accepts.
select is(pg_temp.list_product_id('A-100'), pg_temp.fx('p_widget'),
  'the list returns the real product id');

-- Field accuracy, including every nullable field on both a fully-populated and a fully-null
-- product. Nothing may fabricate a brand, a barcode or a description.
select is(
  (select row(l.product_code, l.product_name, l.barcode, l.brand, l.description, l.status)::text
   from public.list_vendor_products() l where l.product_code = 'A-100'),
  row('A-100', 'Alpha Widget', '1234567890123', 'Acme', 'A widget that widgets.', 'ACTIVE')::text,
  'a fully populated product reports every field verbatim');

select is(
  (select row(l.product_code, l.product_name, l.barcode, l.brand, l.description, l.status)::text
   from public.list_vendor_products() l where l.product_code = 'B-200'),
  row('B-200', 'Beta Gadget', null, null, null, 'INACTIVE')::text,
  'null barcode, brand and description are returned as null, and INACTIVE is returned as INACTIVE');

-- An INACTIVE product is LISTED, not hidden — matching the web catalogue, which shows it with
-- a status pill and an Activate control.
select is(pg_temp.list_status('B-200'), 'INACTIVE',
  'an INACTIVE product still appears in the list and reports its real status');
select is(pg_temp.list_status('A-100'), 'ACTIVE',
  'an ACTIVE product reports ACTIVE');

-- Timestamps are present and ordered as written.
select ok(
  (select l.created_at < l.updated_at is not false from public.list_vendor_products() l
   where l.product_code = 'A-100'),
  'created_at and updated_at are both returned');

-- ONE ROW PER PRODUCT, whatever its assignment count. Alpha Widget has four assignments and
-- Gamma Thing has none; both are exactly one row. This is the join-duplication trap.
select is(
  (select count(*) from public.list_vendor_products() l where l.product_code = 'A-100'),
  1::bigint,
  'a product with four assignments is ONE list row, not four');
select is(
  (select count(*) from public.list_vendor_products() l where l.product_code = 'C-300'),
  1::bigint,
  'a product with no assignments is still one list row');


-- ============================================================================
-- SECTION E — the authorized detail
-- ============================================================================
select is(pg_temp.detail_rows(pg_temp.fx('p_widget')), 1::bigint,
  'the detail read returns exactly one row for an owned product');

select is(
  (select row(d.product_id, d.product_code, d.product_name, d.barcode, d.brand,
              d.description, d.status)::text
   from public.get_vendor_product_detail(pg_temp.fx('p_widget')) d),
  row(pg_temp.fx('p_widget'), 'A-100', 'Alpha Widget', '1234567890123', 'Acme',
      'A widget that widgets.', 'ACTIVE')::text,
  'the detail reports identity, code, name, barcode, brand, description and status verbatim');

select is(
  (select row(d.barcode, d.brand, d.description)::text
   from public.get_vendor_product_detail(pg_temp.fx('p_gadget')) d),
  row(null, null, null)::text,
  'the detail returns genuinely null optional fields as null');

select is(
  (select d.status from public.get_vendor_product_detail(pg_temp.fx('p_gadget')) d),
  'INACTIVE',
  'an INACTIVE product is readable and reports INACTIVE — the detail hides no lifecycle state');

-- THE LIST AND THE DETAIL CANNOT DISAGREE. Every shared column of the same product is equal,
-- asserted as a whole row rather than field by field so an added column is covered too.
select is(
  (select row(d.product_id, d.product_code, d.barcode, d.product_name, d.brand, d.description,
              d.status, d.active_assignment_count, d.created_at, d.updated_at)::text
   from public.get_vendor_product_detail(pg_temp.fx('p_widget')) d),
  (select row(l.product_id, l.product_code, l.barcode, l.product_name, l.brand, l.description,
              l.status, l.active_assignment_count, l.created_at, l.updated_at)::text
   from public.list_vendor_products() l where l.product_code = 'A-100'),
  'every column the detail shares with the list is byte-identical for the same product');

select is(
  (select row(d.product_id, d.product_code, d.barcode, d.product_name, d.brand, d.description,
              d.status, d.active_assignment_count, d.created_at, d.updated_at)::text
   from public.get_vendor_product_detail(pg_temp.fx('p_gadget')) d),
  (select row(l.product_id, l.product_code, l.barcode, l.product_name, l.brand, l.description,
              l.status, l.active_assignment_count, l.created_at, l.updated_at)::text
   from public.list_vendor_products() l where l.product_code = 'B-200'),
  'the same holds for the INACTIVE product with all-null optional fields');


-- ============================================================================
-- SECTION F — assignment count semantics, stated exactly
-- ============================================================================
-- Alpha Widget: Alpha ACTIVE, Bravo ACTIVE (relationship SUSPENDED), Cedar INACTIVE
-- (organization SUSPENDED), Delta INACTIVE (relationship DEACTIVATED), Echo no row.

select is(pg_temp.detail_total(pg_temp.fx('p_widget')), 4::bigint,
  'assignment_count counts EVERY assignment row — ACTIVE and INACTIVE alike');

select is(pg_temp.detail_active(pg_temp.fx('p_widget')), 2::bigint,
  'active_assignment_count counts only the ACTIVE rows');

-- A withdrawn assignment counts in the total and NOT in the active count. Stated as the
-- arithmetic so the two rules are visibly complementary.
select is(
  pg_temp.detail_total(pg_temp.fx('p_widget')) - pg_temp.detail_active(pg_temp.fx('p_widget')),
  2::bigint,
  'the two withdrawn assignments are exactly the difference between the counts');

-- A SUSPENDED relationship does NOT suppress an active assignment. This is the shipped
-- meaning of the number the web catalogue prints, reproduced deliberately.
select is(pg_temp.a_status(pg_temp.fx('p_widget'), 'Bravo Stores'), 'ACTIVE',
  'an assignment to a SUSPENDED relationship is still ACTIVE');
select is(pg_temp.a_rel_status(pg_temp.fx('p_widget'), 'Bravo Stores'), 'SUSPENDED',
  '...and its relationship_status still reports SUSPENDED, so a client can narrow it if it wants');

-- A DEACTIVATED relationship does not fabricate an assignment status either: Delta's row is
-- INACTIVE because it was withdrawn, not because the relationship ended.
select is(pg_temp.a_status(pg_temp.fx('p_widget'), 'Delta Shops'), 'INACTIVE',
  'a withdrawn assignment on a DEACTIVATED relationship reports INACTIVE');
select is(pg_temp.a_rel_status(pg_temp.fx('p_widget'), 'Delta Shops'), 'DEACTIVATED',
  '...and the relationship status is reported separately and exactly');

-- A SUSPENDED Retailer ORGANIZATION is a third, independent fact.
select is(pg_temp.a_retailer_status(pg_temp.fx('p_widget'), 'Cedar Mart'), 'SUSPENDED',
  'a SUSPENDED Retailer organization reports SUSPENDED');
select is(pg_temp.a_rel_status(pg_temp.fx('p_widget'), 'Cedar Mart'), 'ACTIVE',
  '...while its relationship is ACTIVE — three statuses, never derived from one another');

-- THE INVARIANT: assignment_count IS the number of rows the companion returns. If these ever
-- disagree, one of them is filtering and the client cannot tell which.
select is(
  pg_temp.detail_total(pg_temp.fx('p_widget')),
  pg_temp.assigned_rows(pg_temp.fx('p_widget')),
  'assignment_count equals the number of rows the companion read returns');

-- The list's count and the detail's active count are the same number, by construction.
select is(
  pg_temp.list_active_count('A-100'),
  pg_temp.detail_active(pg_temp.fx('p_widget')),
  'the list and the detail report the same active_assignment_count');

-- AN INACTIVE PRODUCT KEEPS ITS ASSIGNMENTS. Deactivating a product deliberately does not
-- cascade, and neither count consults the product's own status.
select is(pg_temp.detail_total(pg_temp.fx('p_gadget')), 1::bigint,
  'an INACTIVE product still reports its assignment in the total');
select is(pg_temp.detail_active(pg_temp.fx('p_gadget')), 1::bigint,
  'an INACTIVE product still reports its ACTIVE assignment as active');
select is(pg_temp.list_active_count('B-200'), 1::bigint,
  '...and the list agrees');

-- A PRODUCT WITH NO ASSIGNMENTS REPORTS ZERO, NEVER NULL. count(*) over an empty lateral is
-- 0; a null here would make every client write a coalesce.
select is(pg_temp.detail_total(pg_temp.fx('p_thing')), 0::bigint,
  'a product with no assignments reports assignment_count 0, not null');
select is(pg_temp.detail_active(pg_temp.fx('p_thing')), 0::bigint,
  '...and active_assignment_count 0, not null');
select is(pg_temp.list_active_count('C-300'), 0::bigint,
  '...and the list reports 0 too');

-- CROSS-VENDOR ROWS ARE NOT COUNTED. Vendor B's assignment of its own 'A-100' must not reach
-- Vendor A's identically-coded product.
select is(
  (select count(*) from public.vendor_product_retailer_assignments a
   where a.vendor_product_id = pg_temp.fx('p_bravo')),
  1::bigint,
  'Vendor B genuinely has an assignment on its own A-100 (fixture sanity)');
select is(pg_temp.detail_total(pg_temp.fx('p_widget')), 4::bigint,
  'Vendor A''s A-100 still counts four — a same-coded foreign product contributes nothing');


-- ============================================================================
-- SECTION G — the assignment companion: membership, accuracy and ordering
-- ============================================================================
select is(pg_temp.assigned_rows(pg_temp.fx('p_widget')), 4::bigint,
  'the companion returns one row per existing assignment — four for Alpha Widget');

-- ONLY ASSIGNED RETAILERS. Echo Traders is one of this Vendor's own ACTIVE Retailers and is
-- absent, because no assignment row exists. This is the whole difference from the existing
-- editor read, which would return it with a NULL assignment_status.
select is(
  pg_temp.assigned_names(pg_temp.fx('p_widget')),
  array['Alpha Retail', 'Bravo Stores', 'Cedar Mart', 'Delta Shops'],
  'only Retailers with an assignment row appear, ordered by Retailer name');

select is(
  (select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_widget')) l
   where l.retailer_name = 'Echo Traders'),
  0::bigint,
  'a related but never-assigned Retailer is ABSENT, not a null-status row');

-- ...while the existing editor read DOES still return it. Asserted directly, because "the two
-- functions answer different questions" is the justification for adding one at all.
select is(
  (select count(*) from public.list_vendor_product_retailer_assignments(pg_temp.fx('p_widget')) l
   where l.retailer_name = 'Echo Traders' and l.assignment_status is null),
  1::bigint,
  'the existing editor read still returns the never-assigned Retailer with a null status — unchanged');

-- assignment_status is NEVER null in the new read. A client never has to decide what a null
-- means.
select is(
  (select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_widget')) l
   where l.assignment_status is null),
  0::bigint,
  'assignment_status is never null in the companion read');

-- Exact per-row accuracy, including both statuses that are NOT the assignment's own.
select is(pg_temp.a_status(pg_temp.fx('p_widget'), 'Alpha Retail'), 'ACTIVE',
  'Alpha Retail''s assignment is ACTIVE');
select is(pg_temp.a_status(pg_temp.fx('p_widget'), 'Cedar Mart'), 'INACTIVE',
  'Cedar Mart''s withdrawn assignment is INACTIVE, and is still returned');
select is(pg_temp.a_retailer_status(pg_temp.fx('p_widget'), 'Alpha Retail'), 'ACTIVE',
  'Alpha Retail''s organization status is ACTIVE');
select is(pg_temp.a_rel_status(pg_temp.fx('p_widget'), 'Alpha Retail'), 'ACTIVE',
  'Alpha Retail''s relationship status is ACTIVE');

-- IDS. The relationship id is the SAME id the shipped Vendor Retailer reads use, which is the
-- point of returning it: a product's assignment row can open the Retailer detail screen.
select is(pg_temp.a_rel_id(pg_temp.fx('p_widget'), 'Alpha Retail'), pg_temp.fx('rel_alpha'),
  'relationship_id is the real vendor_retailers row id');
select is(pg_temp.a_org_id(pg_temp.fx('p_widget'), 'Alpha Retail'), pg_temp.fx('alpha'),
  'retailer_organization_id is the real organization id');

-- Proved against the shipped Retailer read rather than only against the fixture, so the two
-- contracts are asserted to share an address space.
select is(
  pg_temp.a_rel_id(pg_temp.fx('p_widget'), 'Alpha Retail'),
  (select r.relationship_id from public.list_vendor_retailers() r
   where r.retailer_name = 'Alpha Retail'),
  'the relationship_id here is the same id list_vendor_retailers() returns — one address space');

select is(
  (select count(*) from public.get_vendor_retailer_detail(
     pg_temp.a_rel_id(pg_temp.fx('p_widget'), 'Alpha Retail'))),
  1::bigint,
  'that id opens the Vendor Retailer detail screen directly — the cross-link works');

-- DATES. assigned_at and assignment_updated_at are returned verbatim. Nothing infers a
-- withdrawal from a missing date, and no date is fabricated.
select is(pg_temp.a_assigned_at(pg_temp.fx('p_widget'), 'Alpha Retail'),
  timestamptz '2026-05-01 10:00:00+00',
  'assigned_at is returned exactly as stored');
select is(pg_temp.a_updated_at(pg_temp.fx('p_widget'), 'Cedar Mart'),
  timestamptz '2026-06-03 10:00:00+00',
  'assignment_updated_at is returned exactly as stored — for a withdrawn row, when it was withdrawn');
select is(pg_temp.a_assigned_at(pg_temp.fx('p_widget'), 'Cedar Mart'),
  timestamptz '2026-05-03 10:00:00+00',
  '...and assigned_at still reports when it was originally assigned');

-- NO DUPLICATE RETAILER ROWS. One row per (product, Retailer) is a schema guarantee; this
-- proves the joins do not undo it.
select is(
  (select count(*) from (
     select l.retailer_organization_id
     from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_widget')) l
     group by l.retailer_organization_id having count(*) > 1) d),
  0::bigint,
  'no Retailer appears twice in one product''s assignment list');

-- ANOTHER PRODUCT'S ASSIGNMENTS ARE ABSENT. Beta Gadget is assigned only to Alpha Retail.
select is(
  pg_temp.assigned_names(pg_temp.fx('p_gadget')),
  array['Alpha Retail'],
  'a different product returns only its own assignments');

-- A VALID, OWNED PRODUCT WITH NO ASSIGNMENTS IS AN EMPTY LIST, NOT A REFUSAL.
select is(pg_temp.assigned_rows(pg_temp.fx('p_thing')), 0::bigint,
  'an owned product with no assignments returns an empty set');
select is(
  pg_temp.sqlstate_of(format('select * from public.list_vendor_product_assigned_retailers(%L)',
                             pg_temp.fx('p_thing'))),
  null,
  '...and it does not raise — empty is a successful answer');


-- ============================================================================
-- SECTION H — tenant isolation, and the non-leaking selector
-- ============================================================================
-- Vendor A must not be able to tell another Vendor's product from a product that does not
-- exist, and must never see a foreign assignment.

select is(pg_temp.detail_rows(pg_temp.fx('p_bravo')), 0::bigint,
  'Vendor A reads zero rows for Vendor B''s product');
select is(pg_temp.detail_rows(gen_random_uuid()), 0::bigint,
  'Vendor A reads zero rows for an id that names nothing');
select is(pg_temp.detail_rows(null), 0::bigint,
  'Vendor A reads zero rows for a null selector');

-- Identical, not merely all-zero: the three answers must also raise the same thing, which is
-- nothing.
select is(
  pg_temp.sqlstate_of(format('select * from public.get_vendor_product_detail(%L)',
                             pg_temp.fx('p_bravo'))),
  pg_temp.sqlstate_of('select * from public.get_vendor_product_detail(null)'),
  'a foreign product and a null selector are indistinguishable');
select is(
  pg_temp.sqlstate_of(format('select * from public.get_vendor_product_detail(%L)',
                             pg_temp.fx('p_bravo'))),
  pg_temp.sqlstate_of(format('select * from public.get_vendor_product_detail(%L)',
                             gen_random_uuid())),
  'a foreign product and an unknown id are indistinguishable');

-- An id from an entirely different table is just as inert.
select is(pg_temp.detail_rows(pg_temp.fx('rel_alpha')), 0::bigint,
  'a relationship id passed as a product id names nothing and returns zero rows');

-- The companion behaves identically for all four.
select is(pg_temp.assigned_rows(pg_temp.fx('p_bravo')), 0::bigint,
  'the companion returns zero rows for Vendor B''s product, hiding that it has an assignment');
select is(pg_temp.assigned_rows(gen_random_uuid()), 0::bigint,
  'the companion returns zero rows for an unknown id');
select is(pg_temp.assigned_rows(null), 0::bigint,
  'the companion returns zero rows for null');
select is(
  pg_temp.sqlstate_of(format('select * from public.list_vendor_product_assigned_retailers(%L)',
                             pg_temp.fx('p_bravo'))),
  pg_temp.sqlstate_of('select * from public.list_vendor_product_assigned_retailers(null)'),
  'the companion cannot distinguish a foreign product from null either');

-- Vendor A's list contains no Vendor B product, even though one shares its product code.
select is(
  (select count(*) from public.list_vendor_products() l where l.product_name = 'Bravo Item'),
  0::bigint,
  'Vendor A''s list contains no Vendor B product');
select is(
  (select count(*) from public.list_vendor_products() l where l.product_code = 'A-100'),
  1::bigint,
  'the shared product code resolves to exactly one row — Vendor A''s own');

-- No Vendor A answer mentions Foxtrot Group, Vendor B's Retailer.
select is(
  (select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_widget')) l
   where l.retailer_name = 'Foxtrot Group'),
  0::bigint,
  'Vendor B''s Retailer never appears in a Vendor A assignment list');

-- ...and the isolation holds in the other direction too.
select pg_temp.act_as(pg_temp.fx('gil'));
select is(pg_temp.list_rows(), 1::bigint,
  'Vendor B sees exactly its own one product');
select is(pg_temp.my_product_names(), array['Bravo Item'],
  'Vendor B sees only Bravo Item');
select is(pg_temp.detail_rows(pg_temp.fx('p_widget')), 0::bigint,
  'Vendor B reads zero rows for Vendor A''s product');
select is(pg_temp.assigned_rows(pg_temp.fx('p_widget')), 0::bigint,
  'Vendor B reads zero assignment rows for Vendor A''s product');
select is(pg_temp.detail_total(pg_temp.fx('p_bravo')), 1::bigint,
  'Vendor B''s own counts are its own');
select is(
  pg_temp.assigned_names(pg_temp.fx('p_bravo')),
  array['Foxtrot Group'],
  'Vendor B sees only its own Retailer');


-- ============================================================================
-- SECTION I — the reads perform no writes
-- ============================================================================
-- Both functions are declared STABLE (Section A), which the planner enforces, but the
-- observable claim is that calling them changes nothing an operator would notice — in
-- particular that no audit row is written for a read.

select pg_temp.act_as(pg_temp.fx('ada'));

create table pg_temp.before_counts as
select
  (select count(*) from public.vendor_products)                          as products,
  (select count(*) from public.vendor_product_retailer_assignments)      as assignments,
  (select count(*) from public.audit_logs)                               as audits;

-- The reads are called through count(*) rather than as bare selects so every statement in
-- this file still produces exactly one TAP line.
select ok((select count(*) from public.list_vendor_products()) = 3,
  'the list read runs and returns the expected rows');
select ok((select count(*) from public.get_vendor_product_detail(pg_temp.fx('p_widget'))) = 1,
  'the detail read runs and returns the expected row');
select ok(
  (select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_widget'))) = 4,
  'the companion read runs and returns the expected rows');

select is(
  (select row(c.products, c.assignments, c.audits)::text from pg_temp.before_counts c),
  (select row(
     (select count(*) from public.vendor_products),
     (select count(*) from public.vendor_product_retailer_assignments),
     (select count(*) from public.audit_logs))::text),
  'calling all three reads writes no product, no assignment and no audit row');


-- ============================================================================
-- SECTION J — the two reads are stable across repeated calls
-- ============================================================================
-- A mobile client re-fetches on resume and on pull-to-refresh. Ordering that is merely
-- usually-stable produces list widgets that reshuffle, so the total ordering is asserted as a
-- repeat-call property rather than only as a one-shot expectation.

select is(pg_temp.my_product_names(), pg_temp.my_product_names(),
  'the list emits the same order on a repeat call');
select is(
  pg_temp.assigned_names(pg_temp.fx('p_widget')),
  pg_temp.assigned_names(pg_temp.fx('p_widget')),
  'the assignment companion emits the same order on a repeat call');

-- Two Retailers sharing a name must still order totally, by organization id. Renaming Delta
-- to Alpha Retail creates the tie the ordering has to break.
update public.organizations set name = 'Alpha Retail' where id = pg_temp.fx('delta');

select is(
  (select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_widget'))),
  4::bigint,
  'a duplicated Retailer name does not lose or duplicate a row');
-- The emitted order must be exactly (Retailer name, organization id). Compared against the
-- order computed independently from the fixture, so the tie between the two 'Alpha Retail'
-- rows is broken by the documented rule rather than by whatever the plan happened to yield.
select is(
  (select array_agg(t.org order by t.ord)
   from (select l.retailer_organization_id as org, row_number() over () as ord
         from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_widget')) l) t),
  (select array_agg(o.id order by o.name, o.id)
   from public.organizations o
   where o.id in (pg_temp.fx('alpha'), pg_temp.fx('bravo'),
                  pg_temp.fx('cedar'), pg_temp.fx('delta'))),
  'two Retailers sharing a name still order deterministically by organization id');

update public.organizations set name = 'Delta Shops' where id = pg_temp.fx('delta');


-- ============================================================================
-- SECTION K — the permission requirement, and the split
-- ============================================================================
-- The requirement is proved by REMOVING a seeded role→permission mapping, never by adding
-- one: granting a permission and observing success would prove only that the grant worked.
-- Everything here is rolled back with the transaction.

-- Remove PRODUCTS_READ from VENDOR_SUPER_ADMIN. All three reads must now refuse, including
-- the pre-existing list.
delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'PRODUCTS_READ';

select throws_ok('select * from public.list_vendor_products()', '42501',
  null, 'without PRODUCTS_READ, the list is refused even for a Vendor Super Admin');
select throws_ok(
  format('select * from public.get_vendor_product_detail(%L)', pg_temp.fx('p_widget')), '42501',
  null, 'without PRODUCTS_READ, the detail is refused');
select throws_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  '42501', null, 'without PRODUCTS_READ, the assignment companion is refused');

-- Put it back.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'PRODUCTS_READ';

select is(pg_temp.detail_rows(pg_temp.fx('p_widget')), 1::bigint,
  'restoring PRODUCTS_READ restores the detail read (fixture sanity)');

-- THE SPLIT. Removing RETAILERS_READ must refuse ONLY the read that returns Retailer identity
-- and relationship state. The product list and the product detail return neither and must
-- keep working — that is what "least privilege" means here rather than "one permission gates
-- everything product-shaped".
delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'RETAILERS_READ';

select throws_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  '42501', null,
  'without RETAILERS_READ, the assignment companion is refused — it returns Retailer identity');

select lives_ok('select * from public.list_vendor_products()',
  'without RETAILERS_READ, the product list still works — it returns no Retailer data');
select is(pg_temp.detail_rows(pg_temp.fx('p_widget')), 1::bigint,
  'without RETAILERS_READ, the product detail still works — it returns only counts');

-- The counts survive too: a count is not Retailer identity.
select is(pg_temp.detail_total(pg_temp.fx('p_widget')), 4::bigint,
  'the assignment counts remain readable without RETAILERS_READ');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'RETAILERS_READ';

-- And the pre-existing editor read still requires its OWN, different permission — unchanged
-- by this milestone.
delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'PRODUCT_RETAILER_ASSIGN';

select throws_ok(
  format('select * from public.list_vendor_product_retailer_assignments(%L)', pg_temp.fx('p_widget')),
  '42501', null,
  'the existing editor read still requires PRODUCT_RETAILER_ASSIGN — unchanged');

select lives_ok(
  format('select * from public.list_vendor_product_assigned_retailers(%L)', pg_temp.fx('p_widget')),
  'the new read does NOT require PRODUCT_RETAILER_ASSIGN — a read-only role can use it');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'PRODUCT_RETAILER_ASSIGN';


-- ============================================================================
-- SECTION L — the permission mappings themselves are unchanged
-- ============================================================================
-- This milestone seeds no permission and changes no mapping. Asserted against the catalogue,
-- because a silently added mapping is exactly how "read-only" becomes "read-write".

select is(
  (select count(*) from public.permissions p
   where p.code in ('PRODUCTS_READ', 'PRODUCTS_MANAGE', 'PRODUCT_RETAILER_ASSIGN',
                    'RETAILER_PRODUCTS_READ')),
  4::bigint,
  'the four product permissions are exactly the four that shipped — none was added');

select is(
  (select count(*) from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code like 'PRODUCT%' and r.code not in
     ('VENDOR_SUPER_ADMIN', 'RETAILER_OWNER', 'RETAILER_MANAGER')),
  0::bigint,
  'no role outside the three that shipped with a product permission holds one');

-- SALES_STAFF holds none of the FOUR catalogue permissions. It does hold
-- RECEIPT_PRODUCTS_READ (20260730090000) — a deliberately narrower, receipt-matching read
-- that returns no assignment status and is not part of this contract. The distinction is
-- asserted rather than glossed, because "Sales Staff has a product permission" and "Sales
-- Staff can read the Vendor catalogue" are very different claims.
select is(
  (select count(*) from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'SALES_STAFF'
     and p.code in ('PRODUCTS_READ', 'PRODUCTS_MANAGE', 'PRODUCT_RETAILER_ASSIGN',
                    'RETAILER_PRODUCTS_READ')),
  0::bigint,
  'SALES_STAFF still holds none of the four catalogue product permissions');

select is(
  (select count(*) from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'SALES_STAFF' and p.code = 'RECEIPT_PRODUCTS_READ'),
  1::bigint,
  '...and its one product-shaped permission is still the narrow receipt-matching read');

-- ============================================================================
-- SECTION M — a MISSING Vendor–Retailer relationship
-- ============================================================================
-- The companion joins vendor_retailers with a LEFT join, and relationship_id and
-- relationship_status are documented NULLABLE because of it. That nullability had no
-- assertion until this section: a documented behaviour with no test is a claim, not a
-- contract.
--
-- WHY THE LEFT JOIN EXISTS. vendor_product_assignment_assert_link() requires a
-- vendor_retailers row when an assignment is CREATED, so in practice every assignment has
-- one, and no RPC in this schema deletes a relationship. But nothing forbids a direct DELETE,
-- and an INNER join would then make the assignment row VANISH from this list while
-- assignment_count — taken from the assignment table alone — kept counting it. The list and
-- the count would silently contradict each other, and a client could not tell which was
-- wrong. A null relationship_id says "not cross-linkable" out loud instead.
--
-- This runs LAST and deletes a fixture row on purpose. Everything is rolled back with the
-- transaction, and no later section depends on the relationship it removes.

select pg_temp.act_as(pg_temp.fx('ada'));

delete from public.vendor_retailers where id = pg_temp.fx('rel_alpha');

-- The assignment row SURVIVES. This is the whole point.
select is(pg_temp.assigned_rows(pg_temp.fx('p_widget')), 4::bigint,
  'deleting a relationship does not remove its assignment row from the list');

select is(
  pg_temp.assigned_names(pg_temp.fx('p_widget')),
  array['Alpha Retail', 'Bravo Stores', 'Cedar Mart', 'Delta Shops'],
  '...and the ordering is unchanged, because it never depended on the relationship');

-- ...and the invariant holds. An INNER join would break exactly this.
select is(
  pg_temp.detail_total(pg_temp.fx('p_widget')),
  pg_temp.assigned_rows(pg_temp.fx('p_widget')),
  'assignment_count still equals the companion row count with a relationship missing');

select is(pg_temp.detail_active(pg_temp.fx('p_widget')), 2::bigint,
  'the active count is unchanged — neither count ever consulted the relationship');

-- The two relationship columns are NULL, and say so truthfully. Nothing is fabricated: no
-- placeholder id, and no relationship status invented from the assignment's own.
select is(pg_temp.a_rel_id(pg_temp.fx('p_widget'), 'Alpha Retail'), null,
  'relationship_id is NULL when the relationship row is gone — never a fabricated id');
select is(pg_temp.a_rel_status(pg_temp.fx('p_widget'), 'Alpha Retail'), null,
  'relationship_status is NULL too — it is not inferred from the assignment status');

-- The Retailer's OWN facts are unaffected: they come from public.organizations through a
-- primary-key join, which the relationship never mediated.
select is(pg_temp.a_status(pg_temp.fx('p_widget'), 'Alpha Retail'), 'ACTIVE',
  'the assignment status is still reported exactly');
select is(pg_temp.a_retailer_status(pg_temp.fx('p_widget'), 'Alpha Retail'), 'ACTIVE',
  'the Retailer organization status is still reported exactly');
select is(pg_temp.a_org_id(pg_temp.fx('p_widget'), 'Alpha Retail'), pg_temp.fx('alpha'),
  'retailer_organization_id is still the real organization id');

-- Every OTHER row is untouched — a missing relationship is one row's problem, not the list's.
select is(pg_temp.a_rel_id(pg_temp.fx('p_widget'), 'Bravo Stores'), pg_temp.fx('rel_bravo'),
  'the other rows keep their relationship ids');
select is(
  (select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_widget')) l
   where l.relationship_id is null),
  1::bigint,
  'exactly one row lost its relationship id');

-- AND THE BOUNDARY STILL HOLDS. A missing relationship must not become a way to see a
-- Retailer this Vendor does not manage: the rows are still reached through the product's own
-- assignments, which only this Vendor's products can have.
select is(
  (select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_widget')) l
   where l.retailer_name = 'Foxtrot Group'),
  0::bigint,
  'a missing relationship does not expose another Vendor''s Retailer');
select is(pg_temp.assigned_rows(pg_temp.fx('p_bravo')), 0::bigint,
  'and Vendor B''s product is still unreadable to Vendor A');

select * from finish();
rollback;
