-- pgTAP behavioural tests for the Vendor Product WRITE contract:
--
--   public.create_vendor_product(text, text, text, text, text)   [20260727210000, REPAIRED 20260807090000]
--   public.update_vendor_product(uuid, text, text, text, text)   [20260727210000, REPAIRED 20260807090000]
--   public.set_vendor_product_status(uuid, text)                 [20260727210000 — REUSED AS-IS]
--   public.normalize_product_line(text)                          [20260807090000]
--   public.normalize_product_block(text)                         [20260807090000]
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHY THREE PRE-EXISTING FUNCTIONS ARE SPECIFIED HERE
-- ============================================================================
-- The mobile Vendor Product writes milestone adds NO new write RPC. The audit
-- (docs/mobile-vendor-product-writes-audit.md) found that the web already writes products
-- through three SECURITY DEFINER functions that derive the Vendor from auth.uid(), gate on
-- PRODUCTS_MANAGE, and write the product and its audit row in one transaction — which is
-- exactly the shared contract a second client needs. Two of them carried one confirmed
-- normalization defect, repaired by 20260807090000; set_vendor_product_status is reused
-- untouched.
--
-- The milestone that ADOPTS a function is the one that owes it a behavioural specification.
-- Before this file, not one of the three had a database test of any kind: the product suite
-- that exists (vendor_product_reads_test.sql) specifies the READ contract and deliberately
-- builds its fixtures with direct inserts so it does not depend on the write path. So every
-- section below is new coverage, not a restatement.
--
-- ============================================================================
-- THE DEFECT THIS SUITE PINS — SECTION J IS THE REGRESSION TEST
-- ============================================================================
-- Both repaired functions normalized as `btrim(...)` then `regexp_replace('\s+', ' ')`.
-- btrim/1 removes ONLY U+0020, so leading/trailing tabs, newlines and Unicode space
-- separators survived it, were then turned INTO plain spaces by the collapse, and were never
-- trimmed. The value reached INSERT/UPDATE with an untrimmed edge and hit a table CHECK
-- constraint — returning PostgreSQL's own error text, which names the table
-- `vendor_products` and the constraint, to the caller.
--
-- The web never hit it because lib/products/product-input.ts trims in JavaScript first, where
-- `.trim()` does strip those characters. That is exactly the failure mode this project's
-- shared-backend principle exists to prevent: a rule enforced only in TypeScript is a rule a
-- second client bypasses. Section J proves no input can reach a constraint any more; Section
-- D proves the repaired normalization is the same rule product-input.ts applies.
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as the
-- `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as far as
-- every authorization helper in this schema is concerned. pg_temp.act_as() does exactly that
-- and pg_temp.sign_out() clears it. This mirrors portal_context_test.sql,
-- vendor_product_reads_test.sql and every other suite in this directory — one idiom for
-- "signed in", not seven.
--
-- The tests deliberately do NOT `set role authenticated`. All three write functions are
-- SECURITY DEFINER, so their behaviour depends on auth.uid() and not on the session role, and
-- switching roles mid-transaction would only make the fixture inserts fail. EXECUTE privilege
-- is asserted directly against the catalogue in Section A, which is stronger than "it did not
-- error for me".
--
-- Everything runs inside one transaction and is rolled back: no product, assignment or audit
-- row written below survives, and neither does Section C's temporary removal of seeded
-- role -> permission mappings.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file
-- turns an added test into a confusing failure about arithmetic rather than about behaviour.

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

create function pg_temp.add_role(p_member uuid, p_role_code text) returns void
language plpgsql as $$
begin
  insert into public.member_roles (organization_member_id, role_id)
  select p_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;
end;
$$;

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
 * Creates a product DIRECTLY, bypassing create_vendor_product().
 *
 * Used only to seed ANOTHER Vendor's catalogue, which the write RPC cannot do — it derives
 * the Vendor from auth.uid(), so seeding Vendor B through it would mean signing in as Vendor
 * B to test Vendor A's isolation. Every product whose CREATION is under test is created
 * through the RPC.
 */
create function pg_temp.raw_product(
  p_vendor uuid,
  p_code text,
  p_name text,
  p_creator uuid,
  p_barcode text default null,
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.vendor_products (
    vendor_organization_id, product_code, barcode, product_name,
    status, created_by_profile_id
  )
  values (p_vendor, p_code, p_barcode, p_name, p_status, p_creator)
  returning id into v_id;
  return v_id;
end;
$$;

/* Function-argument and table-column names, read from the catalogue.
 *
 * A `returns table (...)` function has prorettype = `record`, a pseudo-type with no typrelid,
 * so reading its columns through pg_class yields NOTHING and an assertion written that way
 * compares NULL to NULL and passes vacuously. The names live in proargnames, distinguished
 * only by proargmodes: 'i'/'b'/'v' for an input, 't' for a table column. */
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

create function pg_temp.input_args(p_name text) returns text[]
language sql stable as $$
  select pg_temp.arg_names(p_name, array['i'::"char", 'b'::"char", 'v'::"char"]);
$$;

/* The declared input types of a function, in order. */
create function pg_temp.input_types(p_name text) returns text[]
language sql stable as $$
  select coalesce(array_agg(format_type(t, null) order by ord), '{}'::text[])
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(p.proargtypes::oid[]) with ordinality as x(t, ord)
  where n.nspname = 'public' and p.proname = p_name;
$$;

/* The declared return type of a function. */
create function pg_temp.return_type(p_name text) returns text
language sql stable as $$
  select format_type(p.prorettype, null)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name;
$$;

/*
 * The SQLSTATE raised when the current caller runs p_sql, or NULL if it returned normally.
 * Sequenced in plpgsql on purpose: throws_ok() cannot express the "this refusal is
 * byte-identical to that one" comparisons Sections F and I need.
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

/* The MESSAGE raised when the current caller runs p_sql, or NULL if it returned normally.
 * Section J compares these against the repository's own fixed literals — the whole point of
 * the repair is that a client never receives anything else. */
create function pg_temp.message_of(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end;
$$;

/* One product row, as a single comparable record. */
create function pg_temp.product_of(p_id uuid)
returns table (code text, name text, barcode text, brand text, description text, status text)
language sql stable as $$
  select vp.product_code, vp.product_name, vp.barcode, vp.brand, vp.description, vp.status
  from public.vendor_products vp where vp.id = p_id;
$$;

/*
 * Creates ONE product and returns its stored row — the only safe way to assert what a create
 * wrote.
 *
 * WHY THIS EXISTS. The obvious spelling,
 *     select product_code from public.vendor_products where id = public.create_vendor_product(...)
 * puts a VOLATILE function in a WHERE predicate, so the planner is entitled to evaluate it
 * once PER SCANNED ROW — and does. Every call after the first then fails on the per-Vendor
 * unique code index, so the assertion aborts the whole suite with "A product with that code
 * already exists" for a reason that has nothing to do with what it was testing. Calling the
 * write once, in plpgsql, and returning the row is what makes the evaluation count exactly one.
 */
create function pg_temp.created(
  p_code text,
  p_name text,
  p_barcode text default null,
  p_brand text default null,
  p_description text default null
)
returns table (code text, name text, barcode text, brand text, description text, status text)
language plpgsql as $$
declare
  v_id uuid;
begin
  v_id := public.create_vendor_product(p_code, p_name, p_barcode, p_brand, p_description);
  return query select * from pg_temp.product_of(v_id);
end;
$$;

/* How many audit rows exist for one product, optionally narrowed to one action. */
create function pg_temp.audit_count(p_product uuid, p_action text default null)
returns bigint
language sql stable as $$
  select count(*) from public.audit_logs a
  where a.entity_id = p_product::text
    and a.entity_type = 'VENDOR_PRODUCT'
    and (p_action is null or a.action = p_action);
$$;

create table pg_temp.fx (k text primary key, v uuid);
create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.fx where k = p_k; $$;


-- ============================================================================
-- SECTION A — signature, security attributes and privileges (catalogue-level)
-- ============================================================================
-- Asserted against the catalogue rather than inferred from behaviour: "it did not error for
-- me" is not a privilege check, and a grant that widened by accident would still let every
-- behavioural test pass.

select has_function('public', 'create_vendor_product',
  array['text', 'text', 'text', 'text', 'text'],
  'create_vendor_product(text, text, text, text, text) exists');
select has_function('public', 'update_vendor_product',
  array['uuid', 'text', 'text', 'text', 'text'],
  'update_vendor_product(uuid, text, text, text, text) exists');
select has_function('public', 'set_vendor_product_status', array['uuid', 'text'],
  'set_vendor_product_status(uuid, text) exists');

-- THE SIGNATURES ARE THE DEPLOYED ONES. The repair migration replaced two bodies in place;
-- had it altered an argument list or a return type, the web's own calls would break and a
-- pinned mobile build would break with them. These four assertions are what make "the
-- contract did not change" a fact rather than an intention.
select is(pg_temp.input_types('create_vendor_product'),
  array['text', 'text', 'text', 'text', 'text'],
  'create_vendor_product still takes exactly five text inputs, in order');
select is(pg_temp.input_types('update_vendor_product'),
  array['uuid', 'text', 'text', 'text', 'text'],
  'update_vendor_product still takes uuid then four text inputs, in order');
select is(pg_temp.input_types('set_vendor_product_status'), array['uuid', 'text'],
  'set_vendor_product_status still takes exactly (uuid, text)');

select is(pg_temp.return_type('create_vendor_product'), 'uuid',
  'create_vendor_product still returns the new product id and nothing else');
select is(pg_temp.return_type('update_vendor_product'), 'void',
  'update_vendor_product still returns void');
select is(pg_temp.return_type('set_vendor_product_status'), 'void',
  'set_vendor_product_status still returns void');

-- EXACT PARAMETER NAMES, IN ORDER. Supabase clients call an RPC by NAMED argument, so a
-- renamed parameter is a silently broken client even when the types still line up.
select is(pg_temp.input_args('create_vendor_product'),
  array['p_product_code', 'p_product_name', 'p_barcode', 'p_brand', 'p_description'],
  'create_vendor_product exposes exactly the five shipped parameter names, in order');
select is(pg_temp.input_args('update_vendor_product'),
  array['p_product_id', 'p_product_name', 'p_barcode', 'p_brand', 'p_description'],
  'update_vendor_product exposes exactly the five shipped parameter names, in order');
select is(pg_temp.input_args('set_vendor_product_status'),
  array['p_product_id', 'p_status'],
  'set_vendor_product_status exposes exactly its two shipped parameter names, in order');

-- NO IDENTITY, TENANT, ROLE OR PERMISSION ARGUMENT ON ANY WRITE. This is the trusted-identity
-- rule stated as a test: a caller may address a product, and supply its display values, and
-- nothing else. Everything that decides WHETHER the write may happen is derived server-side.
select is(
  (select count(*) from unnest(
     pg_temp.input_args('create_vendor_product')
     || pg_temp.input_args('update_vendor_product')
     || pg_temp.input_args('set_vendor_product_status')) a
   where a ~ 'organization|vendor|tenant|owner|user|profile|member|actor|role|permission|auth|uid|token|claim'),
  0::bigint,
  'no write accepts an organization, Vendor, tenant, owner, user, profile, membership, actor, role, permission or token argument');

-- Create in particular must not accept an owner: a product is created FOR the derived Vendor.
select is(
  (select count(*) from unnest(pg_temp.input_args('create_vendor_product')) a
   where a <> 'p_product_code' and a <> 'p_product_name' and a <> 'p_barcode'
     and a <> 'p_brand' and a <> 'p_description'),
  0::bigint,
  'create accepts the five product fields and NOTHING else — no organization id anywhere');

-- Create takes no status either: the web offers no choice of initial status, so neither may
-- a second client. A product is born ACTIVE and is moved by the dedicated status operation.
select is(
  (select count(*) from unnest(pg_temp.input_args('create_vendor_product')) a where a ~ 'status'),
  0::bigint,
  'create accepts no initial-status argument — the web has never offered that choice');

-- Update takes no product code: the code is immutable, and a parameter for it would be an
-- invitation the trigger then has to refuse. Matched by EXACT NAME rather than by a `~ 'code'`
-- pattern, which would also match the legitimate p_barcode and fail for the wrong reason.
select is(
  (select count(*) from unnest(pg_temp.input_args('update_vendor_product')) a
   where a = 'p_product_code'),
  0::bigint,
  'update accepts no product-code argument — the code is immutable by trigger');

-- Security attributes.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_vendor_product', 'update_vendor_product', 'set_vendor_product_status')
     and p.prosecdef),
  3::bigint,
  'all three write functions are SECURITY DEFINER');

-- `set search_path = ''` is stored by PostgreSQL as the literal `search_path=""` — the empty
-- string, quoted. Asserting `search_path=` (unquoted) would match nothing and the test would
-- fail even on a correctly-hardened function.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_vendor_product', 'update_vendor_product', 'set_vendor_product_status')
     and p.proconfig @> array['search_path=""']),
  3::bigint,
  'all three write functions pin an EMPTY search_path');

-- VOLATILE, not STABLE. A write mislabelled STABLE may be executed against a stale snapshot,
-- folded, or skipped by the planner. 'v' is volatile, 's' stable, 'i' immutable.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_vendor_product', 'update_vendor_product', 'set_vendor_product_status')
     and p.provolatile = 'v'),
  3::bigint,
  'all three write functions are VOLATILE — none is mislabelled STABLE');

-- The two new helpers are pure text transforms: IMMUTABLE is correct for them precisely
-- because the whitespace set is spelled out literally rather than inherited from a
-- locale-dependent character class.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('normalize_product_line', 'normalize_product_block')
     and p.provolatile = 'i' and not p.prosecdef),
  2::bigint,
  'both normalization helpers are IMMUTABLE and SECURITY INVOKER — they hold no authority');

-- Grants: authenticated yes, anon no, PUBLIC no, service_role no.
select ok(has_function_privilege('authenticated',
  'public.create_vendor_product(text, text, text, text, text)', 'execute'),
  'authenticated may execute create_vendor_product');
select ok(has_function_privilege('authenticated',
  'public.update_vendor_product(uuid, text, text, text, text)', 'execute'),
  'authenticated may execute update_vendor_product');
select ok(has_function_privilege('authenticated',
  'public.set_vendor_product_status(uuid, text)', 'execute'),
  'authenticated may execute set_vendor_product_status');

select ok(not has_function_privilege('anon',
  'public.create_vendor_product(text, text, text, text, text)', 'execute'),
  'anon may NOT execute create_vendor_product');
select ok(not has_function_privilege('anon',
  'public.update_vendor_product(uuid, text, text, text, text)', 'execute'),
  'anon may NOT execute update_vendor_product');
select ok(not has_function_privilege('anon',
  'public.set_vendor_product_status(uuid, text)', 'execute'),
  'anon may NOT execute set_vendor_product_status');

-- PUBLIC holds nothing, so no future role inherits execute by default.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_vendor_product', 'update_vendor_product', 'set_vendor_product_status',
                       'normalize_product_line', 'normalize_product_block')
     and coalesce(array_to_string(p.proacl, ','), '') ~ '(^|,)=X'),
  0::bigint,
  'PUBLIC holds no EXECUTE on any product write function or helper');

-- service_role is granted nothing: every write derives its authority from auth.uid(), which a
-- service-role connection does not have, so a grant would only produce a function that
-- refuses — while advertising a bypass that does not exist.
select ok(not has_function_privilege('service_role',
  'public.create_vendor_product(text, text, text, text, text)', 'execute'),
  'service_role holds no EXECUTE on create_vendor_product');
select ok(not has_function_privilege('service_role',
  'public.update_vendor_product(uuid, text, text, text, text)', 'execute'),
  'service_role holds no EXECUTE on update_vendor_product');
select ok(not has_function_privilege('service_role',
  'public.set_vendor_product_status(uuid, text)', 'execute'),
  'service_role holds no EXECUTE on set_vendor_product_status');

-- The helpers are internal. Neither browser role may reach them directly.
select ok(not has_function_privilege('authenticated', 'public.normalize_product_line(text)', 'execute'),
  'authenticated may NOT execute normalize_product_line directly');
select ok(not has_function_privilege('anon', 'public.normalize_product_block(text)', 'execute'),
  'anon may NOT execute normalize_product_block directly');

-- THE TABLES STAY DEFAULT-DENY. The RPCs are the only way in; if a browser role could write
-- the table directly, every authorization test in this file would be describing an optional
-- path rather than the only one.
select ok(not has_table_privilege('authenticated', 'public.vendor_products', 'INSERT'),
  'authenticated may NOT insert into vendor_products directly');
select ok(not has_table_privilege('authenticated', 'public.vendor_products', 'UPDATE'),
  'authenticated may NOT update vendor_products directly');
select ok(not has_table_privilege('authenticated', 'public.vendor_products', 'DELETE'),
  'authenticated may NOT delete from vendor_products directly');
select ok(not has_table_privilege('authenticated', 'public.vendor_products', 'SELECT'),
  'authenticated may NOT select vendor_products directly');
select ok(not has_table_privilege('anon', 'public.vendor_products', 'SELECT'),
  'anon may NOT select vendor_products directly');
select ok(not has_table_privilege('authenticated', 'public.audit_logs', 'INSERT'),
  'authenticated may NOT write audit rows directly');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.vendor_products'::regclass),
  'RLS is still enabled on vendor_products');
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'vendor_products'),
  0::bigint,
  'vendor_products still has ZERO policies — the repair did not weaken RLS');

-- NO PRODUCT DELETION EXISTS ANYWHERE. Deactivation is not deletion, and this milestone must
-- not have introduced one by another name.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname ~ 'product'
     and p.proname ~ '(delete|remove|destroy|purge|drop)'),
  0::bigint,
  'no product delete/remove/purge function exists in the schema');

-- ============================================================================
-- SECTION B — fixtures
-- ============================================================================
-- Two Vendors and one Retailer. Vendor A is where the writes happen; Vendor B exists so
-- Sections F and I can prove isolation with real rows rather than with absence.

insert into pg_temp.fx (k, v) values
  ('vendor_a', pg_temp.new_org('Vendor A')),
  ('vendor_b', pg_temp.new_org('Vendor B')),
  ('vendor_suspended', pg_temp.new_org('Vendor Suspended', 'VENDOR', 'SUSPENDED')),
  ('alpha', pg_temp.new_org('Alpha Retail', 'RETAILER', 'ACTIVE'));

insert into pg_temp.fx (k, v) values
  ('ada',       pg_temp.new_person('Ada', 'Vendor')),        -- Vendor A super admin
  ('bob',       pg_temp.new_person('Bob', 'Bee')),           -- Vendor B super admin
  ('carol',     pg_temp.new_person('Carol', 'Plain')),       -- Vendor A member, no super-admin role
  ('dan',       pg_temp.new_person('Dan', 'Dormant', 'SUSPENDED')), -- suspended profile
  ('eve',       pg_temp.new_person('Eve', 'Exiled')),        -- membership not ACTIVE
  ('frank',     pg_temp.new_person('Frank', 'Frozen')),      -- super admin of a SUSPENDED Vendor
  ('grace',     pg_temp.new_person('Grace', 'Owner')),       -- Retailer Owner
  ('heidi',     pg_temp.new_person('Heidi', 'Manager')),     -- Retailer Manager
  ('ivan',      pg_temp.new_person('Ivan', 'Staff')),        -- Sales Staff
  ('nobody',    pg_temp.new_person('No', 'Body'));           -- profile, but no membership

select pg_temp.add_role(pg_temp.add_member(pg_temp.fx('ada'), pg_temp.fx('vendor_a')), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.add_member(pg_temp.fx('bob'), pg_temp.fx('vendor_b')), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_member(pg_temp.fx('carol'), pg_temp.fx('vendor_a'));
select pg_temp.add_role(pg_temp.add_member(pg_temp.fx('dan'), pg_temp.fx('vendor_a')), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.add_member(pg_temp.fx('eve'), pg_temp.fx('vendor_a'), 'SUSPENDED'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.add_member(pg_temp.fx('frank'), pg_temp.fx('vendor_suspended')), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.add_member(pg_temp.fx('grace'), pg_temp.fx('alpha')), 'RETAILER_OWNER');
select pg_temp.add_role(pg_temp.add_member(pg_temp.fx('heidi'), pg_temp.fx('alpha')), 'RETAILER_MANAGER');
select pg_temp.add_role(pg_temp.add_member(pg_temp.fx('ivan'), pg_temp.fx('alpha')), 'SALES_STAFF');

select pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('alpha'));

-- Vendor B's own product, seeded directly. Section I proves Vendor A can neither read through
-- nor write to it, and that its values never change.
insert into pg_temp.fx (k, v) values
  ('b_product', pg_temp.raw_product(pg_temp.fx('vendor_b'), 'B-ONLY', 'Vendor B Widget',
                                    pg_temp.fx('bob'), '11112222333344'));

-- ============================================================================
-- SECTION C — create authorization
-- ============================================================================
-- Every refusal below is SQLSTATE 42501 with the SAME message. A caller who is signed out,
-- who is not a Vendor Super Admin, whose profile is suspended, whose membership is suspended,
-- or whose organization is suspended cannot tell those cases apart — and neither can an
-- attacker probing which of them applies.

select pg_temp.sign_out();
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('X-1', 'Nope')$$), '42501',
  'a signed-out caller may not create a product');
select is(
  (select count(*) from public.vendor_products where product_code = 'X-1'),
  0::bigint,
  'and nothing was written');

select pg_temp.act_as(pg_temp.fx('nobody'));
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('X-2', 'Nope')$$), '42501',
  'an authenticated caller with no organization membership may not create a product');

select pg_temp.act_as(pg_temp.fx('carol'));
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('X-3', 'Nope')$$), '42501',
  'a Vendor member without VENDOR_SUPER_ADMIN may not create a product');

select pg_temp.act_as(pg_temp.fx('dan'));
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('X-4', 'Nope')$$), '42501',
  'a SUSPENDED profile may not create a product, even holding the role');

select pg_temp.act_as(pg_temp.fx('eve'));
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('X-5', 'Nope')$$), '42501',
  'a SUSPENDED membership may not create a product');

select pg_temp.act_as(pg_temp.fx('frank'));
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('X-6', 'Nope')$$), '42501',
  'a Super Admin of a SUSPENDED Vendor organization may not create a product');

select pg_temp.act_as(pg_temp.fx('grace'));
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('X-7', 'Nope')$$), '42501',
  'a Retailer Owner may not create a Vendor product');
select pg_temp.act_as(pg_temp.fx('heidi'));
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('X-8', 'Nope')$$), '42501',
  'a Retailer Manager may not create a Vendor product');
select pg_temp.act_as(pg_temp.fx('ivan'));
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('X-9', 'Nope')$$), '42501',
  'a Sales Staff member may not create a Vendor product');

select is(
  (select count(*) from public.vendor_products where product_code like 'X-%'),
  0::bigint,
  'not one refused create wrote a product row');
select is(
  (select count(*) from public.audit_logs where action = 'PRODUCT_CREATED'),
  0::bigint,
  'and not one refused create wrote an audit row');

-- THE PERMISSION IS REQUIRED SEPARATELY FROM THE ROLE. Holding VENDOR_SUPER_ADMIN is not by
-- itself authority to write: the mapping is what grants it. Removing PRODUCTS_MANAGE while
-- leaving the role intact must deny all three writes — and must leave the READ working, which
-- is what proves the two permissions are genuinely distinct rather than one check in disguise.
select pg_temp.act_as(pg_temp.fx('ada'));

create temporary table pg_temp.removed_manage as
select rp.role_id, rp.permission_id
from public.role_permissions rp
join public.roles r on r.id = rp.role_id
join public.permissions p on p.id = rp.permission_id
where r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'PRODUCTS_MANAGE';

select is((select count(*) from pg_temp.removed_manage), 1::bigint,
  'PRODUCTS_MANAGE is mapped to VENDOR_SUPER_ADMIN exactly once (the seeded mapping under test)');

delete from public.role_permissions rp
using pg_temp.removed_manage rm
where rp.role_id = rm.role_id and rp.permission_id = rm.permission_id;

select is(pg_temp.sqlstate_of($$select public.create_vendor_product('X-10', 'Nope')$$), '42501',
  'without PRODUCTS_MANAGE, create is denied even for a Vendor Super Admin');
select is(pg_temp.sqlstate_of(
  format($$select public.update_vendor_product(%L::uuid, 'Nope')$$, pg_temp.fx('b_product'))), '42501',
  'without PRODUCTS_MANAGE, update is denied');
select is(pg_temp.sqlstate_of(
  format($$select public.set_vendor_product_status(%L::uuid, 'INACTIVE')$$, pg_temp.fx('b_product'))), '42501',
  'without PRODUCTS_MANAGE, the status change is denied');
select is(pg_temp.sqlstate_of($$select count(*) from public.list_vendor_products()$$), null,
  'but PRODUCTS_READ still works — the write permission is genuinely separate from the read one');

insert into public.role_permissions (role_id, permission_id)
select role_id, permission_id from pg_temp.removed_manage;

select is(pg_temp.sqlstate_of($$select count(*) from public.list_vendor_products()$$), null,
  'the seeded mapping is restored');

-- ALL THREE WRITES SHARE ONE PERMISSION, AND THAT IS THE SHIPPED DESIGN. Asserted explicitly
-- so it is a documented decision rather than an assumption: PRODUCTS_MANAGE covers create,
-- edit and status, while PRODUCT_RETAILER_ASSIGN — a genuinely separate permission — covers
-- the assignment writes this milestone defers.
select is(
  (select count(*) from public.permissions where code in
     ('PRODUCTS_READ', 'PRODUCTS_MANAGE', 'PRODUCT_RETAILER_ASSIGN')),
  3::bigint,
  'the three Vendor product permissions exist, and the write one is distinct from the assign one');

-- ============================================================================
-- SECTION D — create validation, normalization and the returned row
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

-- The happy path, and the ownership invariant that matters most: the product belongs to the
-- DERIVED Vendor. No argument said so.
insert into pg_temp.fx (k, v) values
  ('p1', (select public.create_vendor_product('SR-100', 'Standard Widget', '012345678905',
                                              'Acme', 'A widget.')));

select isnt(pg_temp.fx('p1'), null, 'create returns the new product id');
select is(
  (select vendor_organization_id from public.vendor_products where id = pg_temp.fx('p1')),
  pg_temp.fx('vendor_a'),
  'the product is owned by the DERIVED Vendor — no argument nominated it');
select is(
  (select created_by_profile_id from public.vendor_products where id = pg_temp.fx('p1')),
  pg_temp.fx('ada'),
  'the creator is auth.uid(), which no parameter can influence');
select is(
  (select status from public.vendor_products where id = pg_temp.fx('p1')), 'ACTIVE',
  'a new product is ACTIVE — there is no initial-status choice');
select is(
  (select count(*) from public.vendor_product_retailer_assignments
   where vendor_product_id = pg_temp.fx('p1')),
  0::bigint,
  'creation does NOT assign the product to any Retailer');

-- NORMALIZATION. Each case states the rule product-input.ts applies in JavaScript, so the two
-- clients cannot disagree about what a value means.
select is(
  (select code from pg_temp.created(' sr-200 ', 'Trim Me')),
  'SR-200',
  'the product code is trimmed and upper-cased');
select is(
  (select code from pg_temp.created('SR 300', 'Collapse Me')),
  'SR 300',
  'internal whitespace runs in a product code collapse to one space');
select is(
  (select name from pg_temp.created('SR-400', ' Spaced Out ')),
  'Spaced Out',
  'the product name is trimmed and whitespace-collapsed');
select is(
  (select barcode from pg_temp.created('SR-500', 'Barcoded', ' 012-345 678-909 ')),
  '012345678909',
  'a barcode is stripped of spaces and hyphens');
select is(
  (select brand from pg_temp.created('SR-600', 'Branded', null, ' Acme Industries ')),
  'Acme Industries',
  'the brand is trimmed and whitespace-collapsed');

-- DESCRIPTION IS TRIMMED BUT NOT COLLAPSED. Internal formatting belongs to its author: a
-- paragraph break in a description is content, and the one rule that distinguishes a
-- description from a name.
select is(
  (select description from pg_temp.created('SR-700', 'Described', null, null, E' First line.\n\nSecond line. ')),
  E'First line.\n\nSecond line.',
  'a description is trimmed at the ends but keeps its internal formatting exactly');

-- EMPTY AND WHITESPACE-ONLY OPTIONALS BECOME NULL, NOT ''. A nullable column that can also
-- hold '' has two spellings of "absent", and every later comparison has to know both.
select is(
  (select array[barcode, brand, description] from pg_temp.created('SR-800', 'Bare', '', '', '')),
  array[null, null, null]::text[],
  'empty-string optionals normalize to null');
select is(
  (select array[barcode, brand, description] from pg_temp.created('SR-810', 'Blank', ' ', ' ', ' ')),
  array[null, null, null]::text[],
  'whitespace-only optionals normalize to null');
select is(
  (select array[barcode, brand, description] from pg_temp.created('SR-820', 'Nulls', null, null, null)),
  array[null, null, null]::text[],
  'explicitly null optionals stay null');

-- REQUIRED FIELDS. Missing, empty and whitespace-only are all refused, with the function's own
-- message and a check_violation SQLSTATE the client can map.
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('', 'No Code')$$), '23514',
  'an empty product code is refused');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('   ', 'No Code')$$), '23514',
  'a whitespace-only product code is refused');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product(null, 'No Code')$$), '23514',
  'a null product code is refused');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('SR-900', '')$$), '23514',
  'an empty product name is refused');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('SR-900', '   ')$$), '23514',
  'a whitespace-only product name is refused');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('SR-900', null)$$), '23514',
  'a null product name is refused');

-- LENGTH BOUNDS, AT THE BOUNDARY ON BOTH SIDES. Off-by-one in a length rule is the classic
-- way a valid value becomes unenterable, so each limit is tested at exactly N and N+1.
select isnt(
  (select public.create_vendor_product(repeat('A', 64), 'Max Code')), null,
  'a 64-character product code is accepted (the maximum)');
select is(pg_temp.sqlstate_of(
  format($$select public.create_vendor_product(%L, 'Too Long')$$, repeat('B', 65))), '23514',
  'a 65-character product code is refused');
select isnt(
  (select public.create_vendor_product('SR-N200', repeat('N', 200))), null,
  'a 200-character product name is accepted (the maximum)');
select is(pg_temp.sqlstate_of(
  format($$select public.create_vendor_product('SR-N201', %L)$$, repeat('N', 201))), '23514',
  'a 201-character product name is refused');
select isnt(
  (select public.create_vendor_product('SR-B120', 'Max Brand', null, repeat('R', 120))), null,
  'a 120-character brand is accepted (the maximum)');
select is(pg_temp.sqlstate_of(
  format($$select public.create_vendor_product('SR-B121', 'Long Brand', null, %L)$$, repeat('R', 121))),
  '23514',
  'a 121-character brand is refused');
select isnt(
  (select public.create_vendor_product('SR-D2000', 'Max Desc', null, null, repeat('D', 2000))), null,
  'a 2000-character description is accepted (the maximum)');
select is(pg_temp.sqlstate_of(
  format($$select public.create_vendor_product('SR-D2001', 'Long Desc', null, null, %L)$$, repeat('D', 2001))),
  '23514',
  'a 2001-character description is refused');

-- The single-character minimum, for each required field.
select isnt((select public.create_vendor_product('A', 'B')), null,
  'a one-character code and a one-character name are both accepted (the minimum)');

-- PRODUCT-CODE CHARACTER RULES. The permitted set is upper-case letters, digits, space and
-- . _ / - , starting with a letter or digit.
select isnt((select public.create_vendor_product('AB-1_2.3/4 5', 'All Separators')), null,
  'every permitted separator is accepted in a product code');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('-LEADING', 'Bad Start')$$), '23514',
  'a product code may not start with a separator');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('SR@100', 'Bad Char')$$), '23514',
  'a product code may not contain @');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('SR#100', 'Bad Char')$$), '23514',
  'a product code may not contain #');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('SR''100', 'Bad Char')$$), '23514',
  'a product code may not contain a quote');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('CAFÉ-1', 'Non-ASCII')$$), '23514',
  'a product code may not contain a non-ASCII letter');

-- CASE FOLDING IS THE CODE''S ALONE. A name and a brand are written the way their owner
-- writes them; only the code is canonicalized, because only the code is a key.
select is(
  (select array[code, name, brand] from pg_temp.created('mIxEd-1', 'iPhone Case', null, 'eBay')),
  array['MIXED-1', 'iPhone Case', 'eBay'],
  'the code is upper-cased; the name and brand keep their author''s casing exactly');

-- BARCODE RULES: digits only, 8 to 14 of them, optional.
select isnt((select public.create_vendor_product('BC-8', 'Eight', '12345678')), null,
  'an 8-digit barcode is accepted (the minimum)');
select isnt((select public.create_vendor_product('BC-14', 'Fourteen', '12345678901234')), null,
  'a 14-digit barcode is accepted (the maximum)');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('BC-7', 'Seven', '1234567')$$), '23514',
  'a 7-digit barcode is refused');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('BC-15', 'Fifteen', '123456789012345')$$),
  '23514',
  'a 15-digit barcode is refused');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('BC-AL', 'Alpha', '1234567A')$$), '23514',
  'a barcode containing a letter is refused');

-- UNICODE IN THE DISPLAY FIELDS IS ALLOWED, and is length-checked in CHARACTERS rather than
-- bytes — a name of 200 multi-byte characters must not be refused for being "too long".
select isnt(
  (select public.create_vendor_product('U-1', 'Café Cañón 日本語 🎉', null, 'Ünïcøde')), null,
  'a name and brand may contain accented, CJK and emoji characters');
select isnt(
  (select public.create_vendor_product('U-2', repeat('é', 200))), null,
  'a 200-character name of multi-byte characters is accepted — the limit is characters, not bytes');
select is(pg_temp.sqlstate_of(
  format($$select public.create_vendor_product('U-3', %L)$$, repeat('é', 201))), '23514',
  'and 201 multi-byte characters is refused, on the same character rule');

-- AUDIT: exactly one row, with the right action, entity and metadata — and nothing more.
select is(pg_temp.audit_count(pg_temp.fx('p1'), 'PRODUCT_CREATED'), 1::bigint,
  'a successful create writes exactly ONE PRODUCT_CREATED audit row');
select is(pg_temp.audit_count(pg_temp.fx('p1')), 1::bigint,
  'and no other audit row for that product');
select is(
  (select entity_type from public.audit_logs where entity_id = pg_temp.fx('p1')::text),
  'VENDOR_PRODUCT',
  'the audit entity_type is VENDOR_PRODUCT — the value the mobile audit screen already maps');
select is(
  (select organization_id from public.audit_logs where entity_id = pg_temp.fx('p1')::text),
  pg_temp.fx('vendor_a'),
  'the audit organization is the TRUSTED derived Vendor');
select is(
  (select actor_profile_id from public.audit_logs where entity_id = pg_temp.fx('p1')::text),
  pg_temp.fx('ada'),
  'the audit actor is auth.uid()');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(
     (select metadata from public.audit_logs where entity_id = pg_temp.fx('p1')::text)) k),
  array['product_code', 'product_name', 'product_status', 'vendor_name'],
  'the create audit metadata carries exactly four display keys');

-- The METADATA carries no barcode, and no identity. A barcode is a commercial identifier a
-- Vendor may not want replayed into an activity feed that a wider set of roles can read.
select is(
  (select count(*) from public.audit_logs a, jsonb_object_keys(a.metadata) k
   where a.entity_type = 'VENDOR_PRODUCT'
     and k ~ 'barcode|description|profile|actor|user|organization_id|membership|role|permission|token'),
  0::bigint,
  'no product audit metadata key carries a barcode, description, identity or authorization value');

-- ============================================================================
-- SECTION E — create uniqueness
-- ============================================================================
-- Uniqueness is scoped PER VENDOR by two indexes. That scope is the security property: a
-- globally unique code would let one Vendor's catalogue block another's, and would turn a
-- failed insert into an oracle for a competitor's product codes.

select is(pg_temp.sqlstate_of($$select public.create_vendor_product('SR-100', 'Duplicate')$$), '23505',
  'a duplicate product code in the SAME Vendor is refused');
select is(pg_temp.message_of($$select public.create_vendor_product('SR-100', 'Duplicate')$$),
  'A product with that code already exists',
  'and the message is the repository''s own safe literal, naming no table or constraint');

-- CASE AND WHITESPACE VARIANTS ARE THE SAME CODE. This is what normalization buys: 'sr-100',
-- 'SR 100' and ' sr-100 ' cannot become three products that a receipt matcher must later
-- disambiguate.
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('sr-100', 'Lowercase')$$), '23505',
  'a lower-case spelling of an existing code is refused as a duplicate');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('  SR-100  ', 'Padded')$$), '23505',
  'a space-padded spelling of an existing code is refused as a duplicate');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product(E'\tSR-100', 'Tabbed')$$), '23505',
  'a TAB-padded spelling is also refused as a duplicate — the repair is what makes this reachable');

select is(pg_temp.sqlstate_of($$select public.create_vendor_product('DUP-BC', 'Dup', '012345678905')$$),
  '23505',
  'a duplicate barcode in the same Vendor is refused');
select is(pg_temp.message_of($$select public.create_vendor_product('DUP-BC', 'Dup', '012345678905')$$),
  'A product with that barcode already exists',
  'and the barcode message is its own safe literal, distinct from the code one');
select is(pg_temp.sqlstate_of($$select public.create_vendor_product('DUP-BC2', 'Dup', '012-345-678-905')$$),
  '23505',
  'a separator-spelled duplicate barcode is caught too — normalization precedes the index');

-- MANY NULL BARCODES ARE FINE. The barcode index is PARTIAL (where barcode is not null), so
-- "no barcode" is not a value that can collide.
select isnt((select public.create_vendor_product('NB-1', 'No Barcode One')), null,
  'a product with no barcode is accepted');
select isnt((select public.create_vendor_product('NB-2', 'No Barcode Two')), null,
  'a second product with no barcode is accepted — nulls do not collide');
select isnt((select public.create_vendor_product('NB-3', 'No Barcode Three', '')), null,
  'and an empty-string barcode is a third non-collision, because it normalized to null');

-- A FAILED CREATE LEAVES NOTHING BEHIND. Not a product, and not an audit row.
select is(
  (select count(*) from public.vendor_products where product_name = 'Duplicate'),
  0::bigint,
  'a refused duplicate wrote no product row');
select is(
  (select count(*) from public.audit_logs
   where metadata ->> 'product_name' = 'Duplicate'),
  0::bigint,
  'and wrote no audit row — the mutation and its audit share one transaction');

-- ============================================================================
-- SECTION F — edit authorization and tenant isolation
-- ============================================================================
-- The refusal for a foreign product must be BYTE-IDENTICAL to the refusal for an unknown one,
-- or an id sweep becomes an existence oracle for a competitor's catalogue.

select pg_temp.act_as(pg_temp.fx('ada'));

select is(
  pg_temp.sqlstate_of(format($$select public.update_vendor_product(%L::uuid, 'Renamed')$$,
                             pg_temp.fx('b_product'))),
  '42501',
  'Vendor A may not edit Vendor B''s product');
select is(
  pg_temp.sqlstate_of($$select public.update_vendor_product(
    '00000000-0000-0000-0000-000000000000'::uuid, 'Renamed')$$),
  '42501',
  'an id that names no product is refused');
select is(
  pg_temp.sqlstate_of($$select public.update_vendor_product(null::uuid, 'Renamed')$$),
  '42501',
  'a null product id is refused');

select is(
  pg_temp.message_of(format($$select public.update_vendor_product(%L::uuid, 'Renamed')$$,
                            pg_temp.fx('b_product'))),
  pg_temp.message_of($$select public.update_vendor_product(
    '00000000-0000-0000-0000-000000000000'::uuid, 'Renamed')$$),
  'a FOREIGN product and an UNKNOWN one are refused with byte-identical messages');
select is(
  pg_temp.message_of($$select public.update_vendor_product(null::uuid, 'Renamed')$$),
  pg_temp.message_of($$select public.update_vendor_product(
    '00000000-0000-0000-0000-000000000000'::uuid, 'Renamed')$$),
  'and a NULL id is indistinguishable from both');

-- A malformed uuid never reaches the function: PostgreSQL refuses the cast (22P02). Asserted
-- so the client knows this case is a transport-level error, not an authorization answer.
select is(pg_temp.sqlstate_of($$select public.update_vendor_product('not-a-uuid'::uuid, 'X')$$),
  '22P02',
  'a malformed uuid is rejected by the type system before any authorization runs');

-- VENDOR B''S ROW IS UNTOUCHED — the real test of isolation is the data, not the error.
select results_eq(
  format($$select code, name, barcode, status from pg_temp.product_of(%L::uuid)$$, pg_temp.fx('b_product')),
  $$values ('B-ONLY'::text, 'Vendor B Widget'::text, '11112222333344'::text, 'ACTIVE'::text)$$,
  'Vendor B''s product is completely unchanged by every attempt above');
select is(pg_temp.audit_count(pg_temp.fx('b_product')), 0::bigint,
  'and no audit row was written against Vendor B''s product');

select is(
  pg_temp.sqlstate_of(format($$select public.set_vendor_product_status(%L::uuid, 'INACTIVE')$$,
                             pg_temp.fx('b_product'))),
  '42501',
  'Vendor A may not change the status of Vendor B''s product either');
select is(
  (select status from public.vendor_products where id = pg_temp.fx('b_product')), 'ACTIVE',
  'Vendor B''s product is still ACTIVE');

-- VENDOR B''S DUPLICATE VALUES DO NOT LEAK. Vendor A may freely use the code and barcode that
-- Vendor B already uses: uniqueness is per-Vendor, so a cross-tenant collision is impossible
-- and no error can hint that the value is taken elsewhere.
select isnt(
  (select public.create_vendor_product('B-ONLY', 'Same Code, Different Vendor', '11112222333344')),
  null,
  'Vendor A may use a product code AND barcode that Vendor B already uses');

-- And the reverse direction: Vendor B still cannot see or touch Vendor A's rows.
select pg_temp.act_as(pg_temp.fx('bob'));
select is(
  pg_temp.sqlstate_of(format($$select public.update_vendor_product(%L::uuid, 'Hijacked')$$,
                             pg_temp.fx('p1'))),
  '42501',
  'Vendor B may not edit Vendor A''s product');
select is(
  (select product_name from public.vendor_products where id = pg_temp.fx('p1')),
  'Standard Widget',
  'Vendor A''s product name is unchanged');

-- ============================================================================
-- SECTION G — edit semantics
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

-- Every mutable field moves, together, in one call.
select public.update_vendor_product(pg_temp.fx('p1'), 'Renamed Widget', '999888777666', 'NewBrand', 'New text.');
select results_eq(
  format($$select code, name, barcode, brand, description from pg_temp.product_of(%L::uuid)$$, pg_temp.fx('p1')),
  $$values ('SR-100'::text, 'Renamed Widget'::text, '999888777666'::text, 'NewBrand'::text, 'New text.'::text)$$,
  'every mutable field updates, and the immutable product code does not');

-- NULLABLE FIELDS CAN BE CLEARED. An operator who removes a barcode must end up with null,
-- not with '' — the same "absent" the create path produces.
select public.update_vendor_product(pg_temp.fx('p1'), 'Renamed Widget', '', '', '');
select is(
  (select array[barcode, brand, description] from public.vendor_products where id = pg_temp.fx('p1')),
  array[null, null, null]::text[],
  'barcode, brand and description can each be cleared back to null');

-- NORMALIZATION ON EDIT IS THE SAME RULE AS ON CREATE. If it were not, a value could mean one
-- thing when typed into the create form and another when corrected in the edit form.
select public.update_vendor_product(pg_temp.fx('p1'), '  Spaced   Name  ', ' 111-222 333-444 ',
                                    '  Brand   Name ', E'  Body\n\nText  ');
select results_eq(
  format($$select name, barcode, brand, description from pg_temp.product_of(%L::uuid)$$, pg_temp.fx('p1')),
  $$values ('Spaced Name'::text, '111222333444'::text, 'Brand Name'::text, E'Body\n\nText'::text)$$,
  'edit normalizes exactly as create does');

-- THE PRODUCT CODE IS IMMUTABLE, AND THE FUNCTION OFFERS NO WAY TO TRY. The trigger is the
-- backstop; asserted directly so the guarantee does not rest on the absent parameter alone.
select is(
  (select product_code from public.vendor_products where id = pg_temp.fx('p1')), 'SR-100',
  'the product code survives every edit');
select throws_ok(
  format($$update public.vendor_products set product_code = 'HACKED' where id = %L$$, pg_temp.fx('p1')),
  '23514',
  'Product code is immutable; create a replacement product instead',
  'and a direct attempt to re-key the row is refused by the immutability trigger');

-- created_at IS PRESERVED; updated_at MOVES. The trigger owns updated_at, so an edit cannot
-- forge either timestamp.
select is(
  (select created_at from public.vendor_products where id = pg_temp.fx('p1')),
  (select min(created_at) from public.vendor_products where id = pg_temp.fx('p1')),
  'created_at is stable across edits');
select ok(
  (select updated_at >= created_at from public.vendor_products where id = pg_temp.fx('p1')),
  'updated_at is at or after created_at');

-- THE NO-OP EDIT. Submitting the form unchanged must not write, must not move updated_at, and
-- must not write an audit row: an audit trail whose entries do not correspond to changes is
-- worse than a shorter one.
create temporary table pg_temp.before_noop as
select updated_at, pg_temp.audit_count(pg_temp.fx('p1')) as audits
from public.vendor_products where id = pg_temp.fx('p1');

select public.update_vendor_product(pg_temp.fx('p1'), 'Spaced Name', '111222333444',
                                    'Brand Name', E'Body\n\nText');

select is(
  (select updated_at from public.vendor_products where id = pg_temp.fx('p1')),
  (select updated_at from pg_temp.before_noop),
  'a no-op edit does not move updated_at');
select is(
  pg_temp.audit_count(pg_temp.fx('p1')),
  (select audits from pg_temp.before_noop),
  'and a no-op edit writes no audit row');

-- A no-op is still a SUCCESS, not an error: a client must not have to distinguish "nothing
-- changed" from "the write failed".
select is(pg_temp.sqlstate_of(
  format($$select public.update_vendor_product(%L::uuid, 'Spaced Name', '111222333444',
                                               'Brand Name', E'Body\n\nText')$$, pg_temp.fx('p1'))),
  null,
  'a no-op edit returns successfully');

-- AN EDIT THAT ONLY CHANGES WHITESPACE IS ALSO A NO-OP, because normalization runs first.
select public.update_vendor_product(pg_temp.fx('p1'), '  Spaced    Name  ', ' 111 222 333 444 ',
                                    ' Brand  Name ', E'\tBody\n\nText\t');
select is(
  (select updated_at from public.vendor_products where id = pg_temp.fx('p1')),
  (select updated_at from pg_temp.before_noop),
  'a whitespace-only difference is recognized as no change at all');

-- A MEANINGFUL EDIT WRITES EXACTLY ONE AUDIT ROW.
create temporary table pg_temp.before_real as
select pg_temp.audit_count(pg_temp.fx('p1'), 'PRODUCT_UPDATED') as updates;

select public.update_vendor_product(pg_temp.fx('p1'), 'Truly Different');
select is(
  pg_temp.audit_count(pg_temp.fx('p1'), 'PRODUCT_UPDATED'),
  (select updates + 1 from pg_temp.before_real),
  'a meaningful edit writes exactly one PRODUCT_UPDATED audit row');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(
     (select metadata from public.audit_logs
      where entity_id = pg_temp.fx('p1')::text and action = 'PRODUCT_UPDATED'
      order by created_at desc limit 1)) k),
  array['product_code', 'product_name', 'product_status'],
  'the update audit metadata carries exactly three display keys');

-- A FAILED EDIT ROLLS BACK COMPLETELY: no value change, no audit row.
insert into pg_temp.fx (k, v) values
  ('p_conflict', (select public.create_vendor_product('CONFLICT-1', 'Conflict Holder', '555444333222')));

create temporary table pg_temp.before_fail as
select pg_temp.audit_count(pg_temp.fx('p1')) as audits,
       (select product_name from public.vendor_products where id = pg_temp.fx('p1')) as name;

select is(
  pg_temp.sqlstate_of(format($$select public.update_vendor_product(%L::uuid, 'Steal The Barcode', '555444333222')$$,
                             pg_temp.fx('p1'))),
  '23505',
  'an edit that duplicates another product''s barcode is refused');
select is(
  (select product_name from public.vendor_products where id = pg_temp.fx('p1')),
  (select name from pg_temp.before_fail),
  'and the name change in that same call was rolled back too');
select is(pg_temp.audit_count(pg_temp.fx('p1')), (select audits from pg_temp.before_fail),
  'and the failed edit wrote no audit row');

-- Over-length and malformed values on edit are refused with the same check_violation the
-- create path uses, so one client-side mapping serves both.
select is(pg_temp.sqlstate_of(
  format($$select public.update_vendor_product(%L::uuid, '')$$, pg_temp.fx('p1'))), '23514',
  'an empty name is refused on edit');
select is(pg_temp.sqlstate_of(
  format($$select public.update_vendor_product(%L::uuid, %L)$$, pg_temp.fx('p1'), repeat('Z', 201))), '23514',
  'an over-length name is refused on edit');
select is(pg_temp.sqlstate_of(
  format($$select public.update_vendor_product(%L::uuid, 'Fine', '123')$$, pg_temp.fx('p1'))), '23514',
  'a malformed barcode is refused on edit');

-- ============================================================================
-- SECTION H — status semantics
-- ============================================================================
insert into pg_temp.fx (k, v) values
  ('p_status', (select public.create_vendor_product('ST-1', 'Status Subject')));

select is((select status from public.vendor_products where id = pg_temp.fx('p_status')), 'ACTIVE',
  'the subject starts ACTIVE');

select public.set_vendor_product_status(pg_temp.fx('p_status'), 'INACTIVE');
select is((select status from public.vendor_products where id = pg_temp.fx('p_status')), 'INACTIVE',
  'ACTIVE -> INACTIVE is permitted');
select is(pg_temp.audit_count(pg_temp.fx('p_status'), 'PRODUCT_DEACTIVATED'), 1::bigint,
  'and audits PRODUCT_DEACTIVATED exactly once');

select public.set_vendor_product_status(pg_temp.fx('p_status'), 'ACTIVE');
select is((select status from public.vendor_products where id = pg_temp.fx('p_status')), 'ACTIVE',
  'INACTIVE -> ACTIVE is permitted — deactivation is reversible, not deletion');
select is(pg_temp.audit_count(pg_temp.fx('p_status'), 'PRODUCT_ACTIVATED'), 1::bigint,
  'and audits PRODUCT_ACTIVATED exactly once');

-- SETTING THE CURRENT STATUS IS AN IDEMPOTENT NO-OP. A double-tap on a mobile button must not
-- produce two audit rows describing one decision.
create temporary table pg_temp.before_same as
select updated_at, pg_temp.audit_count(pg_temp.fx('p_status')) as audits
from public.vendor_products where id = pg_temp.fx('p_status');

select public.set_vendor_product_status(pg_temp.fx('p_status'), 'ACTIVE');
select is(pg_temp.audit_count(pg_temp.fx('p_status')), (select audits from pg_temp.before_same),
  'setting the status it already has writes no audit row');
select is(
  (select updated_at from public.vendor_products where id = pg_temp.fx('p_status')),
  (select updated_at from pg_temp.before_same),
  'and does not move updated_at');

-- INVALID TARGET STATUSES ARE REFUSED, with the function's own message.
select is(pg_temp.sqlstate_of(
  format($$select public.set_vendor_product_status(%L::uuid, 'DELETED')$$, pg_temp.fx('p_status'))), '23514',
  'an invented status is refused');
select is(pg_temp.sqlstate_of(
  format($$select public.set_vendor_product_status(%L::uuid, 'ARCHIVED')$$, pg_temp.fx('p_status'))), '23514',
  'ARCHIVED is not a product status in this schema');
select is(pg_temp.sqlstate_of(
  format($$select public.set_vendor_product_status(%L::uuid, '')$$, pg_temp.fx('p_status'))), '23514',
  'an empty status is refused');
select is(pg_temp.sqlstate_of(
  format($$select public.set_vendor_product_status(%L::uuid, null)$$, pg_temp.fx('p_status'))), '23514',
  'a null status is refused');
select is(pg_temp.message_of(
  format($$select public.set_vendor_product_status(%L::uuid, 'DELETED')$$, pg_temp.fx('p_status'))),
  'Choose a valid product status',
  'and the refusal is the repository''s own safe literal');

-- The status IS case- and whitespace-normalized, so a client that sends 'active' is understood.
select public.set_vendor_product_status(pg_temp.fx('p_status'), '  inactive  ');
select is((select status from public.vendor_products where id = pg_temp.fx('p_status')), 'INACTIVE',
  'the target status is trimmed and upper-cased before it is checked');
select public.set_vendor_product_status(pg_temp.fx('p_status'), 'ACTIVE');

-- STATUS DOES NOT TOUCH ASSIGNMENTS — the documented interaction, asserted rather than
-- assumed. Cascading would destroy the record of which Retailers held the product, and
-- reactivating could not restore it faithfully.
insert into public.vendor_product_retailer_assignments
  (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id)
values (pg_temp.fx('p_status'), pg_temp.fx('alpha'), 'ACTIVE', pg_temp.fx('ada'));

create temporary table pg_temp.before_deact as
select status, updated_at from public.vendor_product_retailer_assignments
where vendor_product_id = pg_temp.fx('p_status');

select public.set_vendor_product_status(pg_temp.fx('p_status'), 'INACTIVE');

select is(
  (select status from public.vendor_product_retailer_assignments
   where vendor_product_id = pg_temp.fx('p_status')),
  (select status from pg_temp.before_deact),
  'deactivating a product does NOT change its assignment rows');
select is(
  (select updated_at from public.vendor_product_retailer_assignments
   where vendor_product_id = pg_temp.fx('p_status')),
  (select updated_at from pg_temp.before_deact),
  'and does not even touch the assignment row''s updated_at');
select is(
  (select count(*) from public.vendor_product_retailer_assignments
   where vendor_product_id = pg_temp.fx('p_status')),
  1::bigint,
  'the assignment row still exists — history is preserved, nothing is deleted');

-- HISTORY IS PRESERVED ON THE PRODUCT ITSELF TOO: deactivation is a status change, not a
-- removal, so the row and its creation timestamp survive.
select is(
  (select count(*) from public.vendor_products where id = pg_temp.fx('p_status')), 1::bigint,
  'the deactivated product row still exists');
select public.set_vendor_product_status(pg_temp.fx('p_status'), 'ACTIVE');

-- A STATUS CHANGE AND AN EDIT ARE INDEPENDENT OPERATIONS. An edit must not move the status,
-- and a status change must not touch the display fields.
select public.update_vendor_product(pg_temp.fx('p_status'), 'Status Subject Renamed');
select is((select status from public.vendor_products where id = pg_temp.fx('p_status')), 'ACTIVE',
  'an edit never changes the status');
select public.set_vendor_product_status(pg_temp.fx('p_status'), 'INACTIVE');
select is(
  (select product_name from public.vendor_products where id = pg_temp.fx('p_status')),
  'Status Subject Renamed',
  'and a status change never changes the display fields');
select public.set_vendor_product_status(pg_temp.fx('p_status'), 'ACTIVE');

-- An INACTIVE product is still editable: correcting the details of a withdrawn product is a
-- normal thing to want, and nothing in the schema forbids it.
select public.set_vendor_product_status(pg_temp.fx('p_status'), 'INACTIVE');
select is(pg_temp.sqlstate_of(
  format($$select public.update_vendor_product(%L::uuid, 'Edited While Inactive')$$, pg_temp.fx('p_status'))),
  null,
  'an INACTIVE product can still be edited');
select public.set_vendor_product_status(pg_temp.fx('p_status'), 'ACTIVE');

-- ============================================================================
-- SECTION I — the repaired defect: no raw constraint error is reachable
-- ============================================================================
-- THE REGRESSION TEST. Before 20260807090000, every input below produced PostgreSQL's own
-- error text — naming the table `vendor_products` and the violated constraint — because
-- btrim/1 removes only U+0020 and the collapse step then manufactured an untrimmed edge.
--
-- The assertion is deliberately stated as a PROPERTY of the whole input space rather than as
-- six individual expectations: for EVERY input, the outcome is either success or one of this
-- repository's own fixed messages. A future edit that reintroduces a raw constraint error for
-- some seventh input fails here even though nobody thought to write that case down.

create function pg_temp.safe_messages() returns text[]
language sql immutable as $$
  select array[
    'Enter a valid product code',
    'Enter a product name',
    'Enter a valid barcode, or leave it blank',
    'Brand is too long',
    'Description is too long',
    'A product with that code already exists',
    'A product with that barcode already exists',
    'Not authorized to manage products',
    'Not authorized to manage this product',
    'Choose a valid product status'
  ];
$$;

/* Every whitespace character JavaScript's `.trim()` removes, each wrapped around a value. If
 * the database and lib/products/product-input.ts disagreed about any one of them, the two
 * clients would store different text for the same keystrokes. */
create function pg_temp.ws_chars() returns table (label text, ch text)
language sql immutable as $$
  values ('tab', E'\t'), ('newline', E'\n'), ('vertical tab', E'\v'), ('form feed', E'\f'),
         ('carriage return', E'\r'), ('space', ' '),
         ('no-break space', E'\u00A0'), ('ogham space', E'\u1680'),
         ('en quad', E'\u2000'), ('hair space', E'\u200A'),
         ('line separator', E'\u2028'), ('paragraph separator', E'\u2029'),
         ('narrow no-break space', E'\u202F'), ('medium mathematical space', E'\u205F'),
         ('ideographic space', E'\u3000'), ('zero-width no-break space', E'\uFEFF');
$$;

select pg_temp.act_as(pg_temp.fx('ada'));

-- 1. Every whitespace character, wrapped around a PRODUCT NAME, normalizes away cleanly.
select is(
  (select count(*) from pg_temp.ws_chars() w
   cross join lateral pg_temp.created('WS-N-' || upper(replace(w.label, ' ', '')),
                                      w.ch || 'Widget' || w.ch) c
   where c.name is distinct from 'Widget'),
  0::bigint,
  'EVERY whitespace character is trimmed from a product name — the defect, closed');

-- 2. Every whitespace character, wrapped around a PRODUCT CODE. Each case needs its OWN code,
--    because a per-Vendor unique index is exactly what this repository uses to stop two
--    products sharing one — so the label is folded into the code and into the expectation.
select is(
  (select count(*) from pg_temp.ws_chars() w
   cross join lateral (select 'WSC-' || upper(replace(w.label, ' ', '-')) as want) e
   cross join lateral pg_temp.created(w.ch || e.want || w.ch, 'Code Subject ' || w.label) c
   where c.code is distinct from e.want),
  0::bigint,
  'EVERY whitespace character is trimmed from a product code');

-- 3. Every whitespace character, wrapped around a BRAND.
select is(
  (select count(*) from pg_temp.ws_chars() w
   cross join lateral pg_temp.created('WS-B-' || upper(replace(w.label, ' ', '')),
                                      'Brand Subject', null, w.ch || 'Acme' || w.ch) c
   where c.brand is distinct from 'Acme'),
  0::bigint,
  'EVERY whitespace character is trimmed from a brand');

-- 4. Every whitespace character, wrapped around a DESCRIPTION. This one CHANGED behaviour: it
--    used to be stored with the character still attached, while the web stripped it in
--    JavaScript — two clients, two stored values, same keystrokes.
select is(
  (select count(*) from pg_temp.ws_chars() w
   cross join lateral pg_temp.created('WS-D-' || upper(replace(w.label, ' ', '')),
                                      'Desc Subject', null, null, w.ch || 'Body' || w.ch) c
   where c.description is distinct from 'Body'),
  0::bigint,
  'EVERY whitespace character is trimmed from a description, matching the web exactly');

-- 5. A brand or description made ONLY of whitespace becomes null, whichever character it is.
select is(
  (select count(*) from pg_temp.ws_chars() w
   cross join lateral pg_temp.created('WS-O-' || upper(replace(w.label, ' ', '')),
                                      'Only Subject', null, w.ch) c
   where c.brand is not null),
  0::bigint,
  'a brand of nothing but whitespace becomes null, for every whitespace character');

-- 6. THE PROPERTY ITSELF. A deliberately hostile input set, every one of which must either
--    succeed or fail with one of this repository's own messages. Never a constraint name.
create temporary table pg_temp.hostile as
select * from (values
  (E'\tCODE1',        E'\tName'),
  (E'CODE2\t',        E'Name\t'),
  (E'\nCODE3',        E'\nName'),
  (E'CODE4\r',        E'Name\r'),
  (E'\u00A0CODE5',   E'\u00A0Name'),
  (E'\u3000CODE6',   E'Name\u3000'),
  (E'\vCODE7\f',      E'\vName\f'),
  (E'CO  DE8',        E'Na  me'),
  (E'\t\n\r ',        E'\t\n\r '),
  ('',                ''),
  (repeat('Q', 65),   repeat('Q', 201)),
  ('BAD@CODE',        'Fine Name'),
  ('-BADSTART',       'Fine Name')
) as t(code, name);

-- Each input is executed EXACTLY ONCE, in a lateral, and that single outcome is then judged.
-- Calling message_of twice per row would run the write twice, and the second run of a
-- SUCCESSFUL case would come back "A product with that code already exists" — a pass for
-- entirely the wrong reason.
select is(
  (select count(*) from pg_temp.hostile h
   cross join lateral (
     select pg_temp.message_of(
       format($$select public.create_vendor_product(%L, %L, %L, %L, %L)$$,
              h.code, h.name, E'\t12345678\t', E'\nAcme\n', E'\u00A0Body\u00A0')) as msg
   ) r
   where r.msg is not null and r.msg <> all (pg_temp.safe_messages())),
  0::bigint,
  'NO hostile input produces anything but success or one of the repository''s own safe messages');

-- 7. And the same property on the EDIT path.
select is(
  (select count(*) from pg_temp.hostile h
   cross join lateral (
     select pg_temp.message_of(
       format($$select public.update_vendor_product(%L::uuid, %L, %L, %L, %L)$$,
              pg_temp.fx('p1'), h.name, E'\t12345678\t', E'\nAcme\n', E'\u00A0Body\u00A0')) as msg
   ) r
   where r.msg is not null and r.msg <> all (pg_temp.safe_messages())),
  0::bigint,
  'and no hostile input to the EDIT path produces anything but a safe message either');

-- 8. Stated once more as the rule it enforces: no error message may ever name the table, a
--    constraint, a column, a function or a SQL fragment.
select is(
  (select count(*) from unnest(pg_temp.safe_messages()) m
   where m ~* 'vendor_products|constraint|violates|relation|column|pg_|select|insert|update|search_path|null value'),
  0::bigint,
  'not one of the safe messages names a table, constraint, column or SQL construct');

-- ============================================================================
-- SECTION J — the write result exposes nothing sensitive
-- ============================================================================
-- The three writes return a uuid, void and void. There is no row shape to leak through — and
-- that is itself the assertion: nothing about the Vendor, the actor, the audit or the
-- assignments travels back from a write.

select is(pg_temp.return_type('create_vendor_product'), 'uuid',
  'create returns only an opaque product id — no organization, actor, role or audit data');
select is(pg_temp.arg_names('create_vendor_product', array['t'::"char"]), '{}'::text[],
  'create declares no output columns at all, so no field can be added to it by accident');
select is(pg_temp.arg_names('update_vendor_product', array['t'::"char"]), '{}'::text[],
  'update declares no output columns');
select is(pg_temp.arg_names('set_vendor_product_status', array['t'::"char"]), '{}'::text[],
  'the status operation declares no output columns');

-- THE READ-AFTER-WRITE CONTRACT. Because the writes return no row, the canonical way for a
-- client to refresh one product is the existing detail read — which is the reason no write
-- needs to grow a row shape, and the reason no write returns assignment counts (a write that
-- did would couple the product mutation to the assignment table for no gain).
select is(
  (select product_name from public.get_vendor_product_detail(pg_temp.fx('p_status'))),
  'Edited While Inactive',
  'the existing detail read returns the freshly written product — the mobile read-after-write path');
select is(
  (select assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_status'))),
  1::bigint,
  'and it carries the assignment counts the writes deliberately do not');

-- ============================================================================
-- SECTION K — atomicity and concurrency
-- ============================================================================
-- A product write and its audit row are ONE transaction, so the two can never be observed
-- apart. Real concurrent sessions cannot be created inside a single test transaction, so the
-- concurrency authority is asserted where it actually lives: in the unique indexes, which
-- settle a race regardless of what any function checked first.

select is(
  (select count(*) from pg_index i
   join pg_class c on c.oid = i.indexrelid
   where i.indrelid = 'public.vendor_products'::regclass
     and i.indisunique
     and c.relname in ('vendor_products_code_unique_idx', 'vendor_products_barcode_unique_idx')),
  2::bigint,
  'both uniqueness authorities are real UNIQUE indexes — not a check the function does first');

-- Scoped PER VENDOR. A read-committed "does this code exist?" check inside the function could
-- never settle a race on its own; the index is what does, and its column list is what makes
-- the refusal safe to report.
select is(
  (select array_agg(a.attname::text order by k.ord)
   from pg_index i
   join pg_class c on c.oid = i.indexrelid
   cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
   where i.indrelid = 'public.vendor_products'::regclass
     and c.relname = 'vendor_products_code_unique_idx'),
  array['vendor_organization_id', 'product_code'],
  'the product-code uniqueness authority is scoped to the Vendor, not global');
select is(
  (select array_agg(a.attname::text order by k.ord)
   from pg_index i
   join pg_class c on c.oid = i.indexrelid
   cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
   where i.indrelid = 'public.vendor_products'::regclass
     and c.relname = 'vendor_products_barcode_unique_idx'),
  array['vendor_organization_id', 'barcode'],
  'the barcode uniqueness authority is scoped to the Vendor too');
select ok(
  (select i.indpred is not null from pg_index i join pg_class c on c.oid = i.indexrelid
   where i.indrelid = 'public.vendor_products'::regclass
     and c.relname = 'vendor_products_barcode_unique_idx'),
  'the barcode index is PARTIAL, which is why any number of products may have no barcode');

-- AUDIT ROWS NEVER OUTNUMBER WRITES. Every audit row for a product this suite created has a
-- product that still exists — no audit row survived a rolled-back mutation.
select is(
  (select count(*) from public.audit_logs a
   where a.entity_type = 'VENDOR_PRODUCT'
     and not exists (select 1 from public.vendor_products vp where vp.id::text = a.entity_id)),
  0::bigint,
  'no product audit row exists without the product it describes');

-- And every audit row this suite produced belongs to the trusted Vendor, never to another.
select is(
  (select count(*) from public.audit_logs a
   where a.entity_type = 'VENDOR_PRODUCT'
     and a.organization_id is distinct from pg_temp.fx('vendor_a')),
  0::bigint,
  'every product audit row written here belongs to the derived Vendor A, and to no other');

-- ============================================================================
-- SECTION L — the assignment boundary is untouched
-- ============================================================================
-- Product assignment writes are a SEPARATE, DEFERRED milestone. This milestone must not have
-- moved them, and must not have made a product write mutate an assignment as a side effect.

select has_function('public', 'assign_vendor_product_to_retailer', array['uuid', 'uuid'],
  'the existing assignment write still exists, unchanged');
select has_function('public', 'unassign_vendor_product_from_retailer', array['uuid', 'uuid'],
  'the existing assignment withdrawal still exists, unchanged');
-- Matched on the assignment WRITE prefix rather than on a bare 'assign', which also catches
-- list_retailer_assigned_products, list_my_assigned_receipt_shops, the shop-assignment
-- validators and five other unrelated objects.
select is(
  (select array_agg(p.proname::text order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname ~ '^(un)?assign_vendor_product'),
  array['assign_vendor_product_to_retailer', 'unassign_vendor_product_from_retailer'],
  'exactly the two shipped assignment writes exist — this milestone added no third');

-- The whole product lifecycle, start to finish, touching no assignment row.
insert into pg_temp.fx (k, v) values
  ('p_life', (select public.create_vendor_product('LIFE-1', 'Lifecycle Subject')));
select public.update_vendor_product(pg_temp.fx('p_life'), 'Lifecycle Renamed');
select public.set_vendor_product_status(pg_temp.fx('p_life'), 'INACTIVE');
select public.set_vendor_product_status(pg_temp.fx('p_life'), 'ACTIVE');

select is(
  (select count(*) from public.vendor_product_retailer_assignments
   where vendor_product_id = pg_temp.fx('p_life')),
  0::bigint,
  'create, edit and two status changes created no assignment row of any kind');
select is(pg_temp.audit_count(pg_temp.fx('p_life')), 4::bigint,
  'and produced exactly four audit rows: created, updated, deactivated, activated');
select is(
  (select array_agg(action order by created_at) from public.audit_logs
   where entity_id = pg_temp.fx('p_life')::text),
  array['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_DEACTIVATED', 'PRODUCT_ACTIVATED'],
  'in exactly that order, with exactly those four action codes');

-- Those four action codes are the ones the shipped mobile Audit Logs screen already maps, so
-- this milestone introduces no new action code and needs no Flutter label change.
select is(
  (select count(*) from public.audit_logs where entity_type = 'VENDOR_PRODUCT'
     and action not in ('PRODUCT_CREATED', 'PRODUCT_UPDATED',
                        'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
                        'PRODUCT_ASSIGNED_TO_RETAILER', 'PRODUCT_UNASSIGNED_FROM_RETAILER')),
  0::bigint,
  'no product audit row carries an action code outside the six already shipped');

-- NOTHING WAS DELETED, ANYWHERE. Deactivation is a status, not a removal.
select ok(
  (select count(*) from public.vendor_products where vendor_organization_id = pg_temp.fx('vendor_a')) > 0,
  'Vendor A''s catalogue is non-empty — every product created here still exists');
select is(
  (select count(*) from public.vendor_products where id = pg_temp.fx('b_product')), 1::bigint,
  'and Vendor B''s product was never removed');

select * from finish();
rollback;
