-- pgTAP behavioural tests for the Vendor Product-to-Retailer ASSIGNMENT WRITE contract:
--
--   public.assign_vendor_product_to_retailer(uuid, uuid)       [20260727210000 — REUSED AS-IS]
--   public.unassign_vendor_product_from_retailer(uuid, uuid)   [20260727210000 — REUSED AS-IS]
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHY TWO PRE-EXISTING FUNCTIONS ARE SPECIFIED HERE, AND WHY NO MIGRATION EXISTS
-- ============================================================================
-- The mobile Vendor Product ASSIGNMENT writes milestone adds NO migration and NO new RPC.
-- The audit (docs/mobile-vendor-product-assignment-writes-audit.md) traced the whole web
-- flow — app/(admin)/products/[productId]/page.tsx -> app/(admin)/products/actions.ts ->
-- lib/products/vendor-products.ts -> RPC — and found NO direct table write, NO service-role
-- client, NO caller-supplied tenant id and NO TypeScript-only validation rule anywhere on
-- the assignment path. Both writes already:
--
--   * derive the Vendor from auth.uid() through get_vendor_super_admin_context(),
--   * gate on PRODUCT_RETAILER_ASSIGN — a permission DISTINCT from PRODUCTS_MANAGE,
--   * accept only two opaque addresses (a product id and a Retailer organization id),
--   * mutate the assignment row and insert its audit row in ONE transaction,
--   * never DELETE: withdrawal sets status 'INACTIVE' and the row survives for all time.
--
-- That is already the shared contract a second client needs, so duplicating it for mobile
-- would be a second definition of "assign a product", free to drift from the one the web
-- calls. This milestone therefore ADOPTS the two functions unchanged.
--
-- THE MILESTONE THAT ADOPTS A FUNCTION IS THE ONE THAT OWES IT A SPECIFICATION. Before this
-- file, neither function had a behavioural database test of ANY kind. vendor_product_writes_
-- test.sql asserts only that they still EXIST and that product record writes do not touch an
-- assignment row (its Section L) — a boundary check, not a specification of what they do.
-- vendor_product_reads_test.sql builds its assignment fixtures with direct INSERTs precisely
-- so the read suite does not depend on the write path. So every section below is new
-- coverage, and nothing in it restates an existing assertion.
--
-- ============================================================================
-- THE FOUR SEMANTICS THIS SUITE PINS, BECAUSE A SECOND CLIENT WILL DEPEND ON THEM
-- ============================================================================
--   1. CREATE AND REACTIVATE ARE ONE OPERATION. assign_vendor_product_to_retailer inserts
--      when no row exists and flips an INACTIVE row back to ACTIVE when one does. There is no
--      separate "activate" function, and there must not be: a second entry point would be a
--      second place for the eligibility rules to be stated.
--   2. WITHDRAWAL IS DELIBERATELY WEAKER THAN ASSIGNMENT. Assigning requires an ACTIVE
--      product AND an ACTIVE relationship AND an ACTIVE Retailer organization. Withdrawing
--      requires NONE of the three — a Vendor must be able to withdraw a product from a
--      Retailer it has since suspended, which is exactly when withdrawal matters most.
--   3. assigned_at IS THE CURRENT ASSIGNMENT'S START, NOT THE PAIRING'S HISTORY. Reactivation
--      OVERWRITES it with now(); withdrawal leaves it alone. Section F proves both directions
--      against backdated rows. A client must not present it as "first assigned".
--   4. A NO-OP IS SILENT AND WRITES NOTHING. Assigning an already-ACTIVE pairing, or
--      withdrawing an already-INACTIVE or never-created one, returns normally having written
--      no row version and no audit row — which is what stops a mobile double-tap from
--      producing two audit rows for one decision.
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as the
-- `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as far as
-- every authorization helper in this schema is concerned. pg_temp.act_as() does exactly that
-- and pg_temp.sign_out() clears it. This mirrors vendor_product_writes_test.sql,
-- vendor_product_reads_test.sql and every other suite in this directory — one idiom for
-- "signed in", not seven.
--
-- The tests deliberately do NOT `set role authenticated`. Both functions are SECURITY
-- DEFINER, so their behaviour depends on auth.uid() and not on the session role, and
-- switching roles mid-transaction would only make the fixture inserts fail. EXECUTE privilege
-- is asserted directly against the catalogue in Section A, which is stronger than "it did not
-- error for me".
--
-- Everything runs inside one transaction and is rolled back: no product, assignment or audit
-- row written below survives, and neither does Section C's temporary removal of seeded
-- role -> permission mappings.
--
-- WHY now() CANNOT BE A WITNESS, AND WHAT IS USED INSTEAD. now() is the TRANSACTION
-- timestamp, constant for the whole of this suite, so `assigned_at = updated_at` holds for
-- every row created here and an assertion that a no-op "did not move updated_at" would pass
-- even if the no-op had performed a full UPDATE. Two honest witnesses are used instead:
-- ctid (the tuple's physical location, which ANY row-touching UPDATE changes) for "nothing
-- was written at all", and DELIBERATELY BACKDATED timestamps for "this column did / did not
-- move", where the backdated value is far enough from now() to be unambiguous.
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
  perform set_config('request.jwt.claims', json_build_object('sub', p_user::text)::text, true);
end;
$$;

create function pg_temp.sign_out() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.new_person(p_first text, p_last text, p_status text default 'ACTIVE')
returns uuid
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

create function pg_temp.new_org(p_name text, p_type text default 'VENDOR', p_status text default 'ACTIVE')
returns uuid
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

create function pg_temp.add_member(p_user uuid, p_org uuid, p_status text default 'ACTIVE')
returns uuid
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

/* A member holding one role in one organization, in a single call. */
create function pg_temp.staff(p_user uuid, p_org uuid, p_role text, p_status text default 'ACTIVE')
returns uuid
language plpgsql as $$
declare
  v_member uuid;
begin
  v_member := pg_temp.add_member(p_user, p_org, p_status);
  perform pg_temp.add_role(v_member, p_role);
  return v_member;
end;
$$;

create function pg_temp.link(p_vendor uuid, p_retailer uuid, p_status text default 'ACTIVE')
returns uuid
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
 * Used for every product here. This suite specifies the ASSIGNMENT writes, so its products
 * are fixtures rather than subjects; going through the create RPC would make an assignment
 * assertion fail for a reason belonging to a different contract, and would make it impossible
 * to seed another Vendor's catalogue at all (create derives the Vendor from auth.uid()).
 */
create function pg_temp.raw_product(
  p_vendor uuid,
  p_code text,
  p_name text,
  p_creator uuid,
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.vendor_products (
    vendor_organization_id, product_code, product_name, status, created_by_profile_id
  )
  values (p_vendor, p_code, p_name, p_status, p_creator)
  returning id into v_id;
  return v_id;
end;
$$;

/*
 * Creates an assignment row DIRECTLY, bypassing assign_vendor_product_to_retailer().
 *
 * The only way to seed a starting state the RPC itself refuses to produce — an ACTIVE
 * assignment against a SUSPENDED relationship, for instance, which is reachable in production
 * (suspend a relationship without withdrawing its products) but which the assign path will
 * not create.
 */
create function pg_temp.raw_assignment(
  p_product uuid,
  p_retailer uuid,
  p_actor uuid,
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.vendor_product_retailer_assignments (
    vendor_product_id, retailer_organization_id, status, assigned_by_profile_id
  )
  values (p_product, p_retailer, p_status, p_actor)
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

create function pg_temp.input_types(p_name text) returns text[]
language sql stable as $$
  select coalesce(array_agg(format_type(t, null) order by ord), '{}'::text[])
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(p.proargtypes::oid[]) with ordinality as x(t, ord)
  where n.nspname = 'public' and p.proname = p_name;
$$;

create function pg_temp.return_type(p_name text) returns text
language sql stable as $$
  select format_type(p.prorettype, null)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name;
$$;

/*
 * The SQLSTATE raised when the current caller runs p_sql, or NULL if it returned normally.
 * Sequenced in plpgsql on purpose: throws_ok() cannot express the "this refusal is
 * byte-identical to that one" comparisons Section D needs.
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

create function pg_temp.message_of(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end;
$$;

/* The two calls under test, as text, so a denial and a success are written the same way. */
create function pg_temp.assign_sql(p_product uuid, p_retailer uuid) returns text
language sql immutable as $$
  select format('select public.assign_vendor_product_to_retailer(%L::uuid, %L::uuid)',
                p_product, p_retailer);
$$;

create function pg_temp.unassign_sql(p_product uuid, p_retailer uuid) returns text
language sql immutable as $$
  select format('select public.unassign_vendor_product_from_retailer(%L::uuid, %L::uuid)',
                p_product, p_retailer);
$$;

/* One assignment row's status, or NULL when the pairing has no row at all. The distinction
 * between "no row" and "INACTIVE row" is the whole difference between deletion and
 * withdrawal, so it must never collapse into one value. */
create function pg_temp.assignment_status(p_product uuid, p_retailer uuid) returns text
language sql stable as $$
  select a.status from public.vendor_product_retailer_assignments a
  where a.vendor_product_id = p_product and a.retailer_organization_id = p_retailer;
$$;

create function pg_temp.assignment_id(p_product uuid, p_retailer uuid) returns uuid
language sql stable as $$
  select a.id from public.vendor_product_retailer_assignments a
  where a.vendor_product_id = p_product and a.retailer_organization_id = p_retailer;
$$;

/*
 * The physical row version of one assignment — the ONLY non-vacuous witness that a write
 * actually wrote something, inside a suite that runs in one transaction. See the header for
 * why updated_at cannot be that witness.
 */
create function pg_temp.assignment_version(p_product uuid, p_retailer uuid) returns text
language sql stable as $$
  select a.ctid::text from public.vendor_product_retailer_assignments a
  where a.vendor_product_id = p_product and a.retailer_organization_id = p_retailer;
$$;

create function pg_temp.product_version(p_product uuid) returns text
language sql stable as $$
  select vp.ctid::text from public.vendor_products vp where vp.id = p_product;
$$;

create function pg_temp.relationship_version(p_vendor uuid, p_retailer uuid) returns text
language sql stable as $$
  select vr.ctid::text from public.vendor_retailers vr
  where vr.vendor_organization_id = p_vendor and vr.retailer_organization_id = p_retailer;
$$;

create function pg_temp.org_version(p_org uuid) returns text
language sql stable as $$
  select o.ctid::text from public.organizations o where o.id = p_org;
$$;

/* Pushes both of an assignment's timestamps into the past, so a later write's effect on each
 * is observable against a transaction-constant now(). */
create function pg_temp.backdate(p_product uuid, p_retailer uuid) returns void
language sql as $$
  update public.vendor_product_retailer_assignments
  set assigned_at = now() - interval '10 days',
      updated_at  = now() - interval '10 days'
  where vendor_product_id = p_product and retailer_organization_id = p_retailer;
$$;

create function pg_temp.is_backdated(p_ts timestamptz) returns boolean
language sql stable as $$ select p_ts < now() - interval '9 days'; $$;

/* How many audit rows exist for one product, optionally narrowed to one action. */
create function pg_temp.audit_count(p_product uuid, p_action text default null)
returns bigint
language sql stable as $$
  select count(*) from public.audit_logs a
  where a.entity_id = p_product::text
    and a.entity_type = 'VENDOR_PRODUCT'
    and (p_action is null or a.action = p_action);
$$;

/* The metadata of the single most recently appended audit row for a product. ctid is physical
 * insertion order, which for rows appended in one transaction is the order they were written
 * — created_at cannot order them, because now() is constant here. */
create function pg_temp.last_audit(p_product uuid) returns jsonb
language sql stable as $$
  select a.metadata from public.audit_logs a
  where a.entity_id = p_product::text and a.entity_type = 'VENDOR_PRODUCT'
  order by a.ctid desc limit 1;
$$;

create function pg_temp.last_audit_action(p_product uuid) returns text
language sql stable as $$
  select a.action from public.audit_logs a
  where a.entity_id = p_product::text and a.entity_type = 'VENDOR_PRODUCT'
  order by a.ctid desc limit 1;
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

select has_function('public', 'assign_vendor_product_to_retailer', array['uuid', 'uuid'],
  'assign_vendor_product_to_retailer(uuid, uuid) exists');
select has_function('public', 'unassign_vendor_product_from_retailer', array['uuid', 'uuid'],
  'unassign_vendor_product_from_retailer(uuid, uuid) exists');

-- EXACTLY TWO ASSIGNMENT WRITES EXIST. This milestone adopted the two shipped functions and
-- added no third — no separate "activate", no "set_assignment_status", no bulk variant, and
-- no mobile duplicate. Matched on the assignment WRITE prefix rather than on a bare 'assign',
-- which also catches list_retailer_assigned_products, list_my_assigned_receipt_shops, the
-- shop-assignment validators and several other unrelated objects.
select is(
  (select array_agg(p.proname::text order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname ~ '^(un)?assign_vendor_product'),
  array['assign_vendor_product_to_retailer', 'unassign_vendor_product_from_retailer'],
  'exactly the two shipped assignment writes exist — this milestone added no third');

-- THE SIGNATURES ARE THE DEPLOYED ONES. The web calls these by NAMED argument through
-- PostgREST, so a renamed parameter or a reordered pair is a silently broken client.
select is(pg_temp.input_types('assign_vendor_product_to_retailer'), array['uuid', 'uuid'],
  'assign_vendor_product_to_retailer takes exactly (uuid, uuid)');
select is(pg_temp.input_types('unassign_vendor_product_from_retailer'), array['uuid', 'uuid'],
  'unassign_vendor_product_from_retailer takes exactly (uuid, uuid)');

select is(pg_temp.input_args('assign_vendor_product_to_retailer'),
  array['p_product_id', 'p_retailer_organization_id'],
  'assign exposes exactly (p_product_id, p_retailer_organization_id), in that order');
select is(pg_temp.input_args('unassign_vendor_product_from_retailer'),
  array['p_product_id', 'p_retailer_organization_id'],
  'unassign exposes exactly (p_product_id, p_retailer_organization_id), in that order');

-- NO DEFAULTS. Both arguments are required, so a call that omits one is a PostgREST error
-- rather than a silently half-addressed write.
select is(
  (select array_agg(p.pronargdefaults::int order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer',
                       'unassign_vendor_product_from_retailer')),
  array[0, 0],
  'neither assignment write has a defaulted argument');

-- BOTH RETURN void. This is the shipped contract and is deliberately not widened here:
-- changing a return type requires DROP + CREATE, which would break the web's calls and any
-- pinned client. The consequence — a no-op is indistinguishable from a change — is a
-- documented limitation, and the canonical reads are what a client refreshes from.
select is(pg_temp.return_type('assign_vendor_product_to_retailer'), 'void',
  'assign returns void — no row, no id, no status');
select is(pg_temp.return_type('unassign_vendor_product_from_retailer'), 'void',
  'unassign returns void — no row, no id, no status');

-- NO IDENTITY, TENANT, ROLE OR PERMISSION ARGUMENT ON EITHER WRITE. This is the
-- trusted-identity rule stated as a test: a caller may address a product and a Retailer
-- organization, and nothing else. Everything that decides WHETHER the write may happen is
-- derived server-side from auth.uid().
select is(
  (select count(*) from unnest(
     pg_temp.input_args('assign_vendor_product_to_retailer')
     || pg_temp.input_args('unassign_vendor_product_from_retailer')) a
   where a ~ 'vendor|tenant|owner|user|profile|member|actor|role|permission|auth|uid|token|claim'),
  0::bigint,
  'neither write accepts a Vendor, tenant, owner, user, profile, membership, actor, role, permission or token argument');

-- And nothing beyond the two addresses: no status, no timestamp, no note, no effective date,
-- no relationship id, no assignment id, no idempotency key.
select is(
  (select count(*) from unnest(
     pg_temp.input_args('assign_vendor_product_to_retailer')
     || pg_temp.input_args('unassign_vendor_product_from_retailer')) a
   where a not in ('p_product_id', 'p_retailer_organization_id')),
  0::bigint,
  'the two writes accept the two addresses and NOTHING else — no status, note, date, assignment id or idempotency key');

-- SECURITY DEFINER, VOLATILE, EMPTY search_path — all three, on both.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer',
                       'unassign_vendor_product_from_retailer')
     and p.prosecdef),
  2::bigint,
  'both assignment writes are SECURITY DEFINER');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer',
                       'unassign_vendor_product_from_retailer')
     and p.provolatile = 'v'),
  2::bigint,
  'both assignment writes are VOLATILE — the correct classification for a function that writes');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer',
                       'unassign_vendor_product_from_retailer')
     and p.proconfig @> array['search_path=""']),
  2::bigint,
  'both assignment writes run with an EMPTY search_path');

-- GRANTS: authenticated only. anon, PUBLIC and service_role all denied.
select ok(has_function_privilege('authenticated',
  'public.assign_vendor_product_to_retailer(uuid, uuid)', 'execute'),
  'authenticated may execute assign_vendor_product_to_retailer');
select ok(has_function_privilege('authenticated',
  'public.unassign_vendor_product_from_retailer(uuid, uuid)', 'execute'),
  'authenticated may execute unassign_vendor_product_from_retailer');

select ok(not has_function_privilege('anon',
  'public.assign_vendor_product_to_retailer(uuid, uuid)', 'execute'),
  'anon may NOT execute assign_vendor_product_to_retailer');
select ok(not has_function_privilege('anon',
  'public.unassign_vendor_product_from_retailer(uuid, uuid)', 'execute'),
  'anon may NOT execute unassign_vendor_product_from_retailer');

-- PUBLIC holds nothing. Postgres grants EXECUTE to PUBLIC by default on every new function,
-- which on a SECURITY DEFINER writer would be exactly wrong; the migration revokes it and
-- this is what proves the revoke is still in force.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer',
                       'unassign_vendor_product_from_retailer')
     and coalesce(array_to_string(p.proacl, ','), '') ~ '(^|,)=X/'),
  0::bigint,
  'neither assignment write grants EXECUTE to PUBLIC');

-- NO SERVICE-ROLE GRANT. Both derive their authority from auth.uid(), which a service-role
-- connection does not have, so a service_role grant would produce a function that can only
-- ever refuse — and would invite a caller to try.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer',
                       'unassign_vendor_product_from_retailer')
     and coalesce(array_to_string(p.proacl, ','), '') ~ 'service_role=X'),
  0::bigint,
  'neither assignment write is granted to service_role');

-- The two tables stay default-deny with zero policies and zero browser privileges. An RLS
-- policy or a table grant added later would be a second, independent definition of who may
-- change an assignment, and these RPCs already answer that question.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.vendor_product_retailer_assignments'::regclass),
  'vendor_product_retailer_assignments still has RLS enabled');
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename = 'vendor_product_retailer_assignments'),
  0::bigint,
  'vendor_product_retailer_assignments still has ZERO policies — default deny');
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'vendor_product_retailer_assignments'
     and grantee in ('anon', 'authenticated', 'PUBLIC')),
  0::bigint,
  'no browser role holds any privilege on vendor_product_retailer_assignments');

-- THE UNIQUENESS AUTHORITY IS STILL IN PLACE, and it is unconditional: one row per
-- (product, Retailer) FOR ALL TIME, not one per active pair. This index is what makes a
-- duplicate assignment structurally impossible and what makes withdrawal non-destructive.
select ok(
  (select i.indisunique and i.indpred is null
   from pg_index i join pg_class c on c.oid = i.indexrelid
   where i.indrelid = 'public.vendor_product_retailer_assignments'::regclass
     and c.relname = 'vendor_product_retailer_assign_unique_idx'),
  'vendor_product_retailer_assign_unique_idx is UNIQUE and UNPARTIAL — one row per pairing, for all time');

select is(
  (select array_agg(a.attname::text order by k.ord)
   from pg_index i
   join pg_class c on c.oid = i.indexrelid
   cross join lateral unnest(i.indkey) with ordinality as k(att, ord)
   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att
   where i.indrelid = 'public.vendor_product_retailer_assignments'::regclass
     and c.relname = 'vendor_product_retailer_assign_unique_idx'),
  array['vendor_product_id', 'retailer_organization_id'],
  'the uniqueness scope is exactly (vendor_product_id, retailer_organization_id) — not scoped by status or by relationship');

-- THE STATUS DOMAIN IS EXACTLY TWO VALUES. Nothing below may assume a third.
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.vendor_product_retailer_assignments'::regclass
     and conname = 'vendor_product_assignments_status_allowed'),
  'CHECK ((status = ANY (ARRAY[''ACTIVE''::text, ''INACTIVE''::text])))',
  'an assignment status is exactly ACTIVE or INACTIVE — there is no third state to transition to');

-- NEITHER FUNCTION CONTAINS A DELETE. Withdrawal is a status change; the history of a pairing
-- can never be destroyed by an assign/withdraw cycle. Asserted against the installed source
-- rather than against the migration file, so a later CREATE OR REPLACE cannot slip past it.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer',
                       'unassign_vendor_product_from_retailer')
     and p.prosrc ~* '\mdelete\s+from\m'),
  0::bigint,
  'neither installed assignment write contains a DELETE statement — withdrawal is never deletion');

-- Nor a TRUNCATE, and nor any dynamic SQL, which is where a tenant predicate goes to die.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer',
                       'unassign_vendor_product_from_retailer')
     and (p.prosrc ~* '\mtruncate\m' or p.prosrc ~* '\mexecute\s')),
  0::bigint,
  'neither installed assignment write contains a TRUNCATE or any dynamic SQL');


-- ============================================================================
-- Fixture
-- ============================================================================
-- Two Vendors, so every tenant-isolation claim below is about a Retailer and a product that
-- genuinely belong to someone else rather than about an id that names nothing.
--
-- Vendor A manages four Retailers, one in each state the eligibility matrix distinguishes:
--   ret_ok     ACTIVE org,     ACTIVE relationship      — the only assignable one
--   ret_susp_r ACTIVE org,     SUSPENDED relationship
--   ret_dead_r ACTIVE org,     DEACTIVATED relationship
--   ret_susp_o SUSPENDED org,  ACTIVE relationship
--   ret_dead_o DEACTIVATED org, ACTIVE relationship
insert into pg_temp.fx (k, v) values
  ('admin_a',    pg_temp.new_person('Ada', 'Admin')),
  ('admin_a2',   pg_temp.new_person('Alma', 'Second')),
  ('admin_b',    pg_temp.new_person('Ben', 'Boss')),
  ('plain_a',    pg_temp.new_person('Pat', 'Plain')),
  ('finance_a',  pg_temp.new_person('Fay', 'Finance')),
  ('owner_r',    pg_temp.new_person('Ola', 'Owner')),
  ('manager_r',  pg_temp.new_person('Mo', 'Manager')),
  ('staff_r',    pg_temp.new_person('Sam', 'Staff')),
  ('sleeper',    pg_temp.new_person('Sue', 'Sleeper', 'SUSPENDED')),
  ('exmember',   pg_temp.new_person('Eli', 'Exmember')),
  ('multi',      pg_temp.new_person('Mia', 'Multi')),
  ('dead_vendor_admin', pg_temp.new_person('Dan', 'Dormant'));

insert into pg_temp.fx (k, v) values
  ('vendor_a',   pg_temp.new_org('Vendor A')),
  ('vendor_b',   pg_temp.new_org('Vendor B')),
  -- Sorts BEFORE vendor_a and vendor_b only by id, which is random; the multi-Vendor test
  -- below reads the real lowest id rather than assuming one.
  ('vendor_c',   pg_temp.new_org('Vendor C')),
  ('vendor_dead', pg_temp.new_org('Vendor Dormant', 'VENDOR', 'DEACTIVATED')),
  ('ret_ok',     pg_temp.new_org('Alpha Retail',   'RETAILER')),
  ('ret_susp_r', pg_temp.new_org('Bravo Retail',   'RETAILER')),
  ('ret_dead_r', pg_temp.new_org('Charlie Retail', 'RETAILER')),
  ('ret_susp_o', pg_temp.new_org('Delta Retail',   'RETAILER', 'SUSPENDED')),
  ('ret_dead_o', pg_temp.new_org('Echo Retail',    'RETAILER', 'DEACTIVATED')),
  ('ret_b',      pg_temp.new_org('Zulu Retail',    'RETAILER'));

select pg_temp.staff(pg_temp.fx('admin_a'),  pg_temp.fx('vendor_a'), 'VENDOR_SUPER_ADMIN');
select pg_temp.staff(pg_temp.fx('admin_a2'), pg_temp.fx('vendor_a'), 'VENDOR_SUPER_ADMIN');
select pg_temp.staff(pg_temp.fx('admin_b'),  pg_temp.fx('vendor_b'), 'VENDOR_SUPER_ADMIN');
select pg_temp.staff(pg_temp.fx('finance_a'), pg_temp.fx('vendor_a'), 'FINANCE_ADMIN');
select pg_temp.staff(pg_temp.fx('sleeper'),  pg_temp.fx('vendor_a'), 'VENDOR_SUPER_ADMIN');
select pg_temp.staff(pg_temp.fx('exmember'), pg_temp.fx('vendor_a'), 'VENDOR_SUPER_ADMIN', 'DEACTIVATED');
select pg_temp.staff(pg_temp.fx('dead_vendor_admin'), pg_temp.fx('vendor_dead'), 'VENDOR_SUPER_ADMIN');
-- A Vendor member with a membership but NO role at all.
select pg_temp.add_member(pg_temp.fx('plain_a'), pg_temp.fx('vendor_a'));
-- Retailer-side people, in the Retailer organization Vendor A manages.
select pg_temp.staff(pg_temp.fx('owner_r'),   pg_temp.fx('ret_ok'), 'RETAILER_OWNER');
select pg_temp.staff(pg_temp.fx('manager_r'), pg_temp.fx('ret_ok'), 'RETAILER_MANAGER');
select pg_temp.staff(pg_temp.fx('staff_r'),   pg_temp.fx('ret_ok'), 'SALES_STAFF');
-- A Super Admin of TWO Vendors, for the lowest-organization-id tie-break.
select pg_temp.staff(pg_temp.fx('multi'), pg_temp.fx('vendor_a'), 'VENDOR_SUPER_ADMIN');
select pg_temp.staff(pg_temp.fx('multi'), pg_temp.fx('vendor_c'), 'VENDOR_SUPER_ADMIN');

select pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('ret_ok'));
select pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('ret_susp_r'), 'SUSPENDED');
select pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('ret_dead_r'), 'DEACTIVATED');
select pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('ret_susp_o'));
select pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('ret_dead_o'));
select pg_temp.link(pg_temp.fx('vendor_b'), pg_temp.fx('ret_b'));
-- Vendor C manages the SAME Retailer organization as Vendor A. This is the case that proves
-- the Retailer organization id is not itself authorization: the same id is legitimately
-- addressable by two different Vendors, and each may only reach its own assignment rows.
select pg_temp.link(pg_temp.fx('vendor_c'), pg_temp.fx('ret_ok'));

insert into pg_temp.fx (k, v) values
  ('p_active',   pg_temp.raw_product(pg_temp.fx('vendor_a'), 'A-ACTIVE',  'Active Widget',   pg_temp.fx('admin_a'))),
  ('p_inactive', pg_temp.raw_product(pg_temp.fx('vendor_a'), 'A-INACTIVE','Inactive Widget', pg_temp.fx('admin_a'), 'INACTIVE')),
  ('p_matrix',   pg_temp.raw_product(pg_temp.fx('vendor_a'), 'A-MATRIX',  'Matrix Widget',   pg_temp.fx('admin_a'))),
  ('p_hist',     pg_temp.raw_product(pg_temp.fx('vendor_a'), 'A-HIST',    'History Widget',  pg_temp.fx('admin_a'))),
  ('p_audit',    pg_temp.raw_product(pg_temp.fx('vendor_a'), 'A-AUDIT',   'Audit Widget',    pg_temp.fx('admin_a'))),
  ('p_reads',    pg_temp.raw_product(pg_temp.fx('vendor_a'), 'A-READS',   'Reads Widget',    pg_temp.fx('admin_a'))),
  ('p_c',        pg_temp.raw_product(pg_temp.fx('vendor_c'), 'C-1',       'Vendor C Widget', pg_temp.fx('multi'))),
  ('p_foreign',  pg_temp.raw_product(pg_temp.fx('vendor_b'), 'B-1',       'Foreign Widget',  pg_temp.fx('admin_b')));

-- A stable id that names nothing at all, for the "unknown" cases.
insert into pg_temp.fx (k, v) values ('nowhere', '00000000-0000-4000-8000-000000000000'::uuid);


-- ============================================================================
-- SECTION B — authorization
-- ============================================================================
-- Every refusal below is 42501. That single SQLSTATE covers "not signed in", "not a Vendor
-- Super Admin", "missing the permission", "unknown product" and "another Vendor's product"
-- alike, which is what stops a caller sweeping ids to learn what exists.

select pg_temp.sign_out();

select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a signed-out caller cannot assign');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a signed-out caller cannot withdraw');

-- A signed-out caller wrote nothing.
select is(pg_temp.assignment_status(pg_temp.fx('p_active'), pg_temp.fx('ret_ok')), null,
  'and no assignment row came into existence as a result');

-- An authenticated caller with no Vendor organization at all.
select pg_temp.act_as(pg_temp.fx('owner_r'));
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a Retailer Owner cannot assign');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a Retailer Owner cannot withdraw');

select pg_temp.act_as(pg_temp.fx('manager_r'));
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a Retailer Manager cannot assign');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a Retailer Manager cannot withdraw');

select pg_temp.act_as(pg_temp.fx('staff_r'));
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a Sales Staff member cannot assign');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a Sales Staff member cannot withdraw');

-- A Vendor member holding a membership but no role.
select pg_temp.act_as(pg_temp.fx('plain_a'));
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a Vendor member with no role cannot assign');

-- A Vendor member holding a DIFFERENT Vendor role. FINANCE_ADMIN is a real seeded role that
-- is not VENDOR_SUPER_ADMIN, so this is "a Vendor employee who is not an administrator"
-- rather than "a person with no access".
select pg_temp.act_as(pg_temp.fx('finance_a'));
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a Vendor member who is not a Super Admin cannot assign');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a Vendor member who is not a Super Admin cannot withdraw');

-- An INACTIVE profile, an INACTIVE membership and a DEACTIVATED Vendor organization each
-- break the chain get_vendor_super_admin_context() walks, independently of any permission.
select pg_temp.act_as(pg_temp.fx('sleeper'));
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a SUSPENDED profile cannot assign, even holding the role');

select pg_temp.act_as(pg_temp.fx('exmember'));
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a DEACTIVATED membership cannot assign, even holding the role');

select pg_temp.act_as(pg_temp.fx('dead_vendor_admin'));
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'a Super Admin of a DEACTIVATED Vendor organization cannot assign');

-- None of the refusals above wrote anything.
select is((select count(*) from public.vendor_product_retailer_assignments
           where vendor_product_id = pg_temp.fx('p_active')), 0::bigint,
  'not one of the eleven refusals above created an assignment row');
select is(pg_temp.audit_count(pg_temp.fx('p_active')), 0::bigint,
  'and not one of them wrote an audit row');

-- THE AUTHORIZED CALLER. Everything from here runs as Vendor A's Super Admin unless a test
-- explicitly switches.
select pg_temp.act_as(pg_temp.fx('admin_a'));
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  null, 'a Vendor Super Admin holding PRODUCT_RETAILER_ASSIGN may assign');
select is(pg_temp.assignment_status(pg_temp.fx('p_active'), pg_temp.fx('ret_ok')), 'ACTIVE',
  'and the pairing is now ACTIVE');


-- ============================================================================
-- SECTION C — the permission is PRODUCT_RETAILER_ASSIGN, and it is NOT PRODUCTS_MANAGE
-- ============================================================================
-- The seeded mapping is REMOVED rather than assumed absent. Asserting "a Super Admin can
-- assign" proves only that the caller holds SOMETHING; removing exactly one mapping and
-- watching exactly one capability disappear is what proves WHICH permission is the gate.
-- The transaction is rolled back, so the seeds are untouched on disk.

create temp table saved_perms as
  select rp.role_id, rp.permission_id, p.code
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  join public.roles r on r.id = rp.role_id
  where r.code = 'VENDOR_SUPER_ADMIN'
    and p.code in ('PRODUCT_RETAILER_ASSIGN', 'PRODUCTS_MANAGE', 'PRODUCTS_READ');

select is((select count(*) from saved_perms), 3::bigint,
  'VENDOR_SUPER_ADMIN is seeded with all three product permissions — the starting point');

-- Remove ONLY PRODUCT_RETAILER_ASSIGN. PRODUCTS_MANAGE and PRODUCTS_READ stay.
delete from public.role_permissions rp
using public.permissions p, public.roles r
where rp.permission_id = p.id and rp.role_id = r.id
  and r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'PRODUCT_RETAILER_ASSIGN';

select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_ok'))),
  '42501', 'without PRODUCT_RETAILER_ASSIGN, assigning is refused');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'without PRODUCT_RETAILER_ASSIGN, withdrawing is refused');

-- PRODUCTS_MANAGE ALONE DOES NOT GRANT ASSIGNMENT. The caller still holds it, and still
-- cannot assign — while the operation PRODUCTS_MANAGE really does gate still works. This is
-- the assertion that makes "the two permissions are distinct" a fact rather than a claim.
select is(pg_temp.sqlstate_of(format('select public.set_vendor_product_status(%L::uuid, %L)',
    pg_temp.fx('p_matrix'), 'INACTIVE')),
  null, 'PRODUCTS_MANAGE is unaffected — a product status change still succeeds');
select is(pg_temp.sqlstate_of(format('select public.set_vendor_product_status(%L::uuid, %L)',
    pg_temp.fx('p_matrix'), 'ACTIVE')),
  null, 'and back again, leaving the fixture as it was');

select is(pg_temp.assignment_status(pg_temp.fx('p_active'), pg_temp.fx('ret_ok')), 'ACTIVE',
  'the refused withdrawal changed nothing — the pairing is still ACTIVE');

insert into public.role_permissions (role_id, permission_id)
select role_id, permission_id from saved_perms where code = 'PRODUCT_RETAILER_ASSIGN';

-- Now the converse: remove PRODUCTS_MANAGE and keep PRODUCT_RETAILER_ASSIGN. Assignment must
-- still work, because it is NOT gated on PRODUCTS_MANAGE. A client that assumed one
-- product-management permission covered everything would break exactly here.
delete from public.role_permissions rp
using public.permissions p, public.roles r
where rp.permission_id = p.id and rp.role_id = r.id
  and r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'PRODUCTS_MANAGE';

select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  null, 'PRODUCT_RETAILER_ASSIGN alone is sufficient to withdraw — PRODUCTS_MANAGE is not required');
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  null, 'PRODUCT_RETAILER_ASSIGN alone is sufficient to assign — PRODUCTS_MANAGE is not required');
select is(pg_temp.sqlstate_of(format('select public.set_vendor_product_status(%L::uuid, %L)',
    pg_temp.fx('p_matrix'), 'INACTIVE')),
  '42501', 'while the product status change that DOES need PRODUCTS_MANAGE is now refused');

insert into public.role_permissions (role_id, permission_id)
select role_id, permission_id from saved_perms where code = 'PRODUCTS_MANAGE';

-- PRODUCTS_READ is likewise not a gate on either write.
delete from public.role_permissions rp
using public.permissions p, public.roles r
where rp.permission_id = p.id and rp.role_id = r.id
  and r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'PRODUCTS_READ';

select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  null, 'PRODUCTS_READ is not required to withdraw either');

insert into public.role_permissions (role_id, permission_id)
select role_id, permission_id from saved_perms where code = 'PRODUCTS_READ';

-- Restore the fixture to a known state for the sections that follow.
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'));
select is(pg_temp.assignment_status(pg_temp.fx('p_active'), pg_temp.fx('ret_ok')), 'ACTIVE',
  'all three seeded mappings are restored and the fixture is ACTIVE again');


-- ============================================================================
-- SECTION D — tenant isolation, and refusals that leak nothing
-- ============================================================================
-- The caller-supplied ids are ADDRESSES. Each is filtered on TWO columns — the id itself and
-- the Vendor this function derived from auth.uid() — so an id belonging to another Vendor
-- selects nothing.

select pg_temp.act_as(pg_temp.fx('admin_a'));

-- Vendor A may pair its own product with its own eligible Retailer. Already proven in B;
-- what matters here is that every OTHER pairing is refused.
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_foreign'), pg_temp.fx('ret_ok'))),
  '42501', 'Vendor A cannot assign Vendor B''s product, even to Vendor A''s own Retailer');
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_b'))),
  '42501', 'Vendor A cannot assign its own product to Vendor B''s Retailer');
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_foreign'), pg_temp.fx('ret_b'))),
  '42501', 'Vendor A cannot pair Vendor B''s product with Vendor B''s Retailer — the whole foreign pairing is refused');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_foreign'), pg_temp.fx('ret_b'))),
  '42501', 'and cannot withdraw one either');

-- Nothing about Vendor B moved.
select is((select count(*) from public.vendor_product_retailer_assignments
           where vendor_product_id = pg_temp.fx('p_foreign')), 0::bigint,
  'no assignment row exists for Vendor B''s product — the refusals wrote nothing');
select is(pg_temp.audit_count(pg_temp.fx('p_foreign')), 0::bigint,
  'and no audit row was written against Vendor B''s product');

-- FOREIGN EXISTENCE DOES NOT LEAK. A product that exists but belongs to Vendor B, and an id
-- that names no row anywhere, produce BYTE-IDENTICAL refusals. Compared as messages, not just
-- as SQLSTATEs: two different sentences carrying the same code would still be an oracle.
select is(
  pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_foreign'), pg_temp.fx('ret_ok'))),
  pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('nowhere'), pg_temp.fx('ret_ok'))),
  'a foreign product and a nonexistent product are refused with the SAME message');
select is(
  pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('nowhere'), pg_temp.fx('ret_ok'))),
  pg_temp.message_of('select public.assign_vendor_product_to_retailer(null::uuid, null::uuid)'),
  'and a null product id is refused with that same message again');

select is(
  pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_b'))),
  pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('nowhere'))),
  'a foreign Retailer and a nonexistent Retailer are refused with the SAME message');

select is(
  pg_temp.message_of(pg_temp.unassign_sql(pg_temp.fx('p_foreign'), pg_temp.fx('ret_ok'))),
  pg_temp.message_of(pg_temp.unassign_sql(pg_temp.fx('nowhere'), pg_temp.fx('ret_ok'))),
  'the same holds for withdrawal: foreign and nonexistent products are indistinguishable');

-- NO REFUSAL NAMES A TABLE, COLUMN, INDEX, CONSTRAINT OR SQL FRAGMENT. This is the discipline
-- the product WRITE repair (20260807090000) existed to restore; the assignment writes take no
-- text input at all, so they have no normalization path to a constraint error — but a message
-- could still be careless.
--
-- The pattern matches IDENTIFIERS, not English words. An earlier draft also matched bare SQL
-- keywords and failed on 'Select one of your active Retailers' — a sentence addressed to an
-- operator, in which "select" is a verb. Matching `snake_case` names, index/constraint
-- vocabulary and the SQL-error phrasings PostgreSQL actually emits is the real rule.
select is(
  (select count(*) from (values
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_foreign'), pg_temp.fx('ret_ok')))),
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'),  pg_temp.fx('ret_b')))),
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_inactive'), pg_temp.fx('ret_ok')))),
      (pg_temp.message_of(pg_temp.unassign_sql(pg_temp.fx('p_foreign'), pg_temp.fx('ret_ok'))))
    ) as m(msg)
   where msg ~* 'vendor_product|vendor_retailers|audit_logs|organization_members|_idx|_pkey'
      or msg ~* '\mconstraint\M|\mrelation\M|\mcolumn\M|violates|duplicate key|syntax'),
  0::bigint,
  'no assignment refusal names a table, column, index, constraint or database-level error phrasing');

-- NOR ANY FOREIGN NAME. Vendor B and its Retailer are named in the fixture; neither name may
-- appear in a message Vendor A can read.
select is(
  (select count(*) from (values
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_foreign'), pg_temp.fx('ret_ok')))),
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'),  pg_temp.fx('ret_b')))),
      (pg_temp.message_of(pg_temp.unassign_sql(pg_temp.fx('p_foreign'), pg_temp.fx('ret_b'))))
    ) as m(msg)
   where msg ~* 'Vendor B|Zulu|Foreign Widget|B-1'),
  0::bigint,
  'no refusal echoes another Vendor''s organization name, Retailer name, product name or product code');

-- THE SAME RETAILER ORGANIZATION ID, TWO VENDORS. Vendor C also manages ret_ok. Vendor A's
-- assignment of ret_ok is Vendor A's alone: Vendor C sees no assignment of its own product,
-- and assigning as Vendor C creates a SEPARATE row rather than touching Vendor A's.
select pg_temp.act_as(pg_temp.fx('admin_b'));
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  '42501', 'Vendor B cannot reach the pairing Vendor A created, though the Retailer id is a real one');

select pg_temp.act_as(pg_temp.fx('admin_a'));
select is((select count(*) from public.vendor_product_retailer_assignments
           where retailer_organization_id = pg_temp.fx('ret_ok')), 1::bigint,
  'exactly one assignment row exists against the shared Retailer — Vendor A''s');

-- MULTI-VENDOR CALLER: the lowest organization id wins, deterministically. Reproduced from
-- the shipped rule rather than asserted as a preference; the expected Vendor is COMPUTED from
-- the fixture, so the test does not depend on which random uuid sorted first.
select pg_temp.act_as(pg_temp.fx('multi'));
select is(
  pg_temp.sqlstate_of(pg_temp.assign_sql(
    case when pg_temp.fx('vendor_a') < pg_temp.fx('vendor_c')
         then pg_temp.fx('p_matrix') else pg_temp.fx('p_c') end,
    pg_temp.fx('ret_ok'))),
  null,
  'a two-Vendor Super Admin acts as the LOWEST organization id, and may assign that Vendor''s product');
select is(
  pg_temp.sqlstate_of(pg_temp.assign_sql(
    case when pg_temp.fx('vendor_a') < pg_temp.fx('vendor_c')
         then pg_temp.fx('p_c') else pg_temp.fx('p_matrix') end,
    pg_temp.fx('ret_ok'))),
  '42501',
  'and may NOT assign the higher-id Vendor''s product — the tie-break is total, not a fallback');

-- EVERY AUDIT ROW BELONGS TO THE TRUSTED VENDOR. Not one names a Vendor the caller did not
-- act as, and there is no argument by which they could.
select is(
  (select count(*) from public.audit_logs a
   where a.entity_type = 'VENDOR_PRODUCT'
     and a.action in ('PRODUCT_ASSIGNED_TO_RETAILER', 'PRODUCT_UNASSIGNED_FROM_RETAILER')
     and a.organization_id not in (pg_temp.fx('vendor_a'), pg_temp.fx('vendor_c'))),
  0::bigint,
  'every assignment audit row written here belongs to a Vendor the caller genuinely acted as');

-- Undo the multi-Vendor writes so the later count assertions start from a known state.
select pg_temp.act_as(pg_temp.fx('multi'));
select public.unassign_vendor_product_from_retailer(
  case when pg_temp.fx('vendor_a') < pg_temp.fx('vendor_c')
       then pg_temp.fx('p_matrix') else pg_temp.fx('p_c') end,
  pg_temp.fx('ret_ok'));
select pg_temp.act_as(pg_temp.fx('admin_a'));


-- ============================================================================
-- SECTION E — the eligibility matrix
-- ============================================================================
-- Every real status combination, for both operations. The values are the ones the schema
-- actually allows and no others: products are ACTIVE|INACTIVE
-- (vendor_products_status_allowed), organizations and relationships are
-- ACTIVE|SUSPENDED|DEACTIVATED (organizations_status_allowed,
-- vendor_retailers_status_allowed), and an assignment is absent|ACTIVE|INACTIVE.
--
-- THE RULE, STATED ONCE:
--   assign   requires product ACTIVE **and** relationship ACTIVE **and** Retailer org ACTIVE.
--   withdraw requires NONE of the three — only that the pairing is addressable by this Vendor.

-- ---- Product status ---------------------------------------------------------
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_inactive'), pg_temp.fx('ret_ok'))),
  '55000', 'an INACTIVE product cannot receive a NEW assignment');
select is(pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_inactive'), pg_temp.fx('ret_ok'))),
  'Activate this product before assigning it to a Retailer',
  'and says so specifically — safe, because ownership was already proven and the Vendor can see its own product''s status');
select is(pg_temp.assignment_status(pg_temp.fx('p_inactive'), pg_temp.fx('ret_ok')), null,
  'the refused assignment created no row');

-- An existing INACTIVE assignment cannot be REACTIVATED while the product is inactive either
-- — reactivation goes through the same gate, because it is the same operation.
select pg_temp.raw_assignment(pg_temp.fx('p_inactive'), pg_temp.fx('ret_ok'), pg_temp.fx('admin_a'), 'INACTIVE');
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_inactive'), pg_temp.fx('ret_ok'))),
  '55000', 'an existing INACTIVE assignment cannot be reactivated while the product is INACTIVE');
select is(pg_temp.assignment_status(pg_temp.fx('p_inactive'), pg_temp.fx('ret_ok')), 'INACTIVE',
  'and the row is left exactly as it was');

-- But an ACTIVE assignment CAN be withdrawn while the product is inactive. Deactivating a
-- product deliberately does not cascade into its assignments, so withdrawal must remain the
-- way to end one.
select pg_temp.raw_assignment(pg_temp.fx('p_inactive'), pg_temp.fx('ret_susp_r'), pg_temp.fx('admin_a'), 'ACTIVE');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_inactive'), pg_temp.fx('ret_susp_r'))),
  null, 'an ACTIVE assignment of an INACTIVE product CAN be withdrawn — withdrawal has no product-status gate');
select is(pg_temp.assignment_status(pg_temp.fx('p_inactive'), pg_temp.fx('ret_susp_r')), 'INACTIVE',
  'and the withdrawal took effect');

-- ---- Relationship status ----------------------------------------------------
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_susp_r'))),
  '42501', 'a SUSPENDED relationship cannot receive an assignment');
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_dead_r'))),
  '42501', 'a DEACTIVATED relationship cannot receive an assignment');

-- ---- Retailer organization status -------------------------------------------
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_susp_o'))),
  '42501', 'a SUSPENDED Retailer organization cannot receive an assignment');
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_dead_o'))),
  '42501', 'a DEACTIVATED Retailer organization cannot receive an assignment');

-- ALL FOUR INELIGIBLE-RETAILER REFUSALS ARE THE SAME SENTENCE, and it is the same one an
-- unrelated Retailer gets. A caller cannot learn WHY from the message — in particular cannot
-- learn that a Retailer exists but is suspended, which is a fact about the Retailer.
select is(
  (select count(distinct msg) from (values
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_susp_r')))),
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_dead_r')))),
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_susp_o')))),
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_dead_o')))),
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_b')))),
      (pg_temp.message_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('nowhere'))))
    ) as m(msg)),
  1::bigint,
  'suspended, deactivated, unrelated and nonexistent Retailers all produce ONE identical refusal');

-- ---- Withdrawal is weaker, and deliberately so ------------------------------
-- A historical assignment survives a relationship suspension and a Retailer deactivation
-- (both are reachable: neither status change cascades into assignment rows), and a Vendor
-- must be able to withdraw it. These starting states are seeded directly because the assign
-- path will not create them.
select pg_temp.raw_assignment(pg_temp.fx('p_matrix'), pg_temp.fx('ret_susp_r'), pg_temp.fx('admin_a'), 'ACTIVE');
select pg_temp.raw_assignment(pg_temp.fx('p_matrix'), pg_temp.fx('ret_dead_r'), pg_temp.fx('admin_a'), 'ACTIVE');
select pg_temp.raw_assignment(pg_temp.fx('p_matrix'), pg_temp.fx('ret_susp_o'), pg_temp.fx('admin_a'), 'ACTIVE');
select pg_temp.raw_assignment(pg_temp.fx('p_matrix'), pg_temp.fx('ret_dead_o'), pg_temp.fx('admin_a'), 'ACTIVE');

select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_susp_r'))),
  null, 'a product CAN be withdrawn from a SUSPENDED relationship');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_dead_r'))),
  null, 'a product CAN be withdrawn from a DEACTIVATED relationship');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_susp_o'))),
  null, 'a product CAN be withdrawn from a SUSPENDED Retailer organization');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_dead_o'))),
  null, 'a product CAN be withdrawn from a DEACTIVATED Retailer organization');

select is(
  (select array_agg(a.status order by o.name)
   from public.vendor_product_retailer_assignments a
   join public.organizations o on o.id = a.retailer_organization_id
   where a.vendor_product_id = pg_temp.fx('p_matrix')),
  array['INACTIVE', 'INACTIVE', 'INACTIVE', 'INACTIVE'],
  'all four historical pairings are now INACTIVE, and all four rows still exist');

-- ---- Existing-assignment status: same-status requests are silent no-ops ------
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_susp_r'))),
  null, 'withdrawing an already-INACTIVE assignment is a silent no-op, not an error');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('nowhere'))),
  '42501', 'while withdrawing from a Retailer that is not this Vendor''s is still refused');
select is(pg_temp.sqlstate_of(pg_temp.unassign_sql(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'))),
  null, 'withdrawing a pairing that was NEVER assigned is a silent no-op');
select is(pg_temp.assignment_status(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok')), null,
  'and it did NOT bring a row into existence — "no row" and "INACTIVE row" stay distinct');

select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'))),
  null, 'assigning an already-ACTIVE pairing is a silent no-op, not a conflict');


-- ============================================================================
-- SECTION F — mutation semantics
-- ============================================================================
-- What each operation writes, and — just as load-bearing — what it leaves alone.

-- ---- One row per pairing, reused forever ------------------------------------
insert into pg_temp.fx (k, v) values
  ('a_hist', pg_temp.assignment_id(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok')));
select is(pg_temp.fx('a_hist'), null, 'p_hist starts with no assignment row at all');

select public.assign_vendor_product_to_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
delete from pg_temp.fx where k = 'a_hist';
insert into pg_temp.fx (k, v) values
  ('a_hist', pg_temp.assignment_id(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok')));

select is((select count(*) from public.vendor_product_retailer_assignments
           where vendor_product_id = pg_temp.fx('p_hist')), 1::bigint,
  'a new assignment inserts EXACTLY one row');
select isnt(pg_temp.fx('a_hist'), null, 'and that row has an id');

-- A full withdraw / re-assign / withdraw / re-assign cycle. The id must never change: the row
-- IS the pairing's history, and a cycle that replaced it would destroy the record that this
-- product was once available at this Retailer.
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));

select is((select count(*) from public.vendor_product_retailer_assignments
           where vendor_product_id = pg_temp.fx('p_hist')), 1::bigint,
  'after two full withdraw/re-assign cycles there is still exactly ONE row');
select is(pg_temp.assignment_id(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok')), pg_temp.fx('a_hist'),
  'and it is the SAME row — the pairing''s identity survives every cycle');
select is(pg_temp.assignment_status(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok')), 'ACTIVE',
  'ending ACTIVE, as the last operation asked');

-- Withdrawal does not delete, and cannot be made to.
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select is((select count(*) from public.vendor_product_retailer_assignments
           where id = pg_temp.fx('a_hist')), 1::bigint,
  'the row survives withdrawal — this is a status change, never a deletion');
select is(pg_temp.assignment_status(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok')), 'INACTIVE',
  'marked INACTIVE');

-- ---- Timestamp semantics ----------------------------------------------------
-- WITHDRAWAL PRESERVES assigned_at AND MOVES updated_at.
select pg_temp.backdate(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select pg_temp.backdate(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));

select ok(pg_temp.is_backdated(
    (select assigned_at from public.vendor_product_retailer_assignments where id = pg_temp.fx('a_hist'))),
  'withdrawal PRESERVES assigned_at — it does not restamp when the assignment began');
select ok(not pg_temp.is_backdated(
    (select updated_at from public.vendor_product_retailer_assignments where id = pg_temp.fx('a_hist'))),
  'withdrawal MOVES updated_at — the set_updated_at trigger fires on the status change');

-- REACTIVATION OVERWRITES assigned_at. This is the semantic a client most easily gets wrong:
-- assigned_at is when the CURRENT assignment began, NOT when the pairing was first created.
select pg_temp.backdate(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));

select ok(not pg_temp.is_backdated(
    (select assigned_at from public.vendor_product_retailer_assignments where id = pg_temp.fx('a_hist'))),
  'reactivation RESETS assigned_at to now() — it is the current assignment''s start, NOT the pairing''s first-ever assignment');
select ok(not pg_temp.is_backdated(
    (select updated_at from public.vendor_product_retailer_assignments where id = pg_temp.fx('a_hist'))),
  'and moves updated_at with it');

-- The reactivating actor is recorded as the CURRENT caller, not the original assigner.
select pg_temp.act_as(pg_temp.fx('admin_a2'));
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select is((select assigned_by_profile_id from public.vendor_product_retailer_assignments
           where id = pg_temp.fx('a_hist')), pg_temp.fx('admin_a2'),
  'reactivation records the CURRENT caller as assigned_by_profile_id, taken from auth.uid() and from no argument');
select pg_temp.act_as(pg_temp.fx('admin_a'));

-- ---- A no-op writes no row version at all -----------------------------------
-- ctid, not updated_at: see the header. This proves the stronger claim — the UPDATE never ran.
insert into pg_temp.fx (k, v) values ('noop_probe', pg_temp.fx('p_hist'));

create temp table version_before as
  select pg_temp.assignment_version(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok')) as v;
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select is(pg_temp.assignment_version(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok')),
  (select v from version_before),
  'assigning an already-ACTIVE pairing writes NO row version — the no-op branch really writes nothing');

select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
create temp table version_inactive as
  select pg_temp.assignment_version(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok')) as v;
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok'));
select is(pg_temp.assignment_version(pg_temp.fx('p_hist'), pg_temp.fx('ret_ok')),
  (select v from version_inactive),
  'withdrawing an already-INACTIVE pairing writes NO row version either');

-- ---- Nothing outside the assignment row is touched --------------------------
create temp table neighbours_before as
  select pg_temp.product_version(pg_temp.fx('p_active'))                              as product_v,
         pg_temp.relationship_version(pg_temp.fx('vendor_a'), pg_temp.fx('ret_ok'))   as rel_v,
         pg_temp.org_version(pg_temp.fx('ret_ok'))                                    as org_v,
         (select status from public.vendor_products where id = pg_temp.fx('p_active')) as product_status,
         (select status from public.vendor_retailers
           where vendor_organization_id = pg_temp.fx('vendor_a')
             and retailer_organization_id = pg_temp.fx('ret_ok'))                     as rel_status,
         (select status from public.organizations where id = pg_temp.fx('ret_ok'))    as org_status;

select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'));
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_active'), pg_temp.fx('ret_ok'));

select is(pg_temp.product_version(pg_temp.fx('p_active')), (select product_v from neighbours_before),
  'an assignment write does not touch the PRODUCT row — not its status, not even its updated_at');
select is(pg_temp.relationship_version(pg_temp.fx('vendor_a'), pg_temp.fx('ret_ok')),
  (select rel_v from neighbours_before),
  'nor the Vendor-Retailer RELATIONSHIP row');
select is(pg_temp.org_version(pg_temp.fx('ret_ok')), (select org_v from neighbours_before),
  'nor the Retailer ORGANIZATION row');
select is(
  (select status from public.vendor_products where id = pg_temp.fx('p_active')),
  (select product_status from neighbours_before), 'the product status is unchanged');
select is(
  (select status from public.vendor_retailers
    where vendor_organization_id = pg_temp.fx('vendor_a')
      and retailer_organization_id = pg_temp.fx('ret_ok')),
  (select rel_status from neighbours_before), 'the relationship status is unchanged');
select is(
  (select status from public.organizations where id = pg_temp.fx('ret_ok')),
  (select org_status from neighbours_before), 'the Retailer organization status is unchanged');

-- THE PAIRING ITSELF IS IMMUTABLE. Even a direct UPDATE cannot re-point an assignment at
-- another product or another Retailer — so there is no path, RPC or otherwise, by which a
-- pairing's history could be silently re-attributed.
select throws_ok(
  format('update public.vendor_product_retailer_assignments set retailer_organization_id = %L where id = %L',
         pg_temp.fx('ret_susp_r'), pg_temp.fx('a_hist')),
  '23514',
  'An assignment cannot be re-pointed; withdraw it and create another',
  'an assignment row cannot be re-pointed at a different Retailer, even by a direct UPDATE');


-- ============================================================================
-- SECTION G — the audit row
-- ============================================================================
-- One successful mutation writes exactly one audit row, in the same transaction, with a
-- whitelisted metadata set. A no-op writes none.

select pg_temp.act_as(pg_temp.fx('admin_a'));

select is(pg_temp.audit_count(pg_temp.fx('p_audit')), 0::bigint,
  'p_audit starts with no audit rows');

select public.assign_vendor_product_to_retailer(pg_temp.fx('p_audit'), pg_temp.fx('ret_ok'));

select is(pg_temp.audit_count(pg_temp.fx('p_audit')), 1::bigint,
  'one assignment writes exactly ONE audit row');
select is(pg_temp.last_audit_action(pg_temp.fx('p_audit')), 'PRODUCT_ASSIGNED_TO_RETAILER',
  'with the exact shipped action code');

select is(
  (select a.entity_type from public.audit_logs a where a.entity_id = pg_temp.fx('p_audit')::text limit 1),
  'VENDOR_PRODUCT',
  'entity_type is VENDOR_PRODUCT — the assignment is audited AGAINST THE PRODUCT, not against a separate entity');
select is(
  (select a.entity_id from public.audit_logs a
    where a.entity_id = pg_temp.fx('p_audit')::text limit 1),
  pg_temp.fx('p_audit')::text,
  'entity_id is the PRODUCT id — not the assignment id, and not the Retailer id');
select is(
  (select a.organization_id from public.audit_logs a
    where a.entity_id = pg_temp.fx('p_audit')::text limit 1),
  pg_temp.fx('vendor_a'),
  'organization_id is the DERIVED Vendor — there is no argument by which a caller could nominate another');
select is(
  (select a.actor_profile_id from public.audit_logs a
    where a.entity_id = pg_temp.fx('p_audit')::text limit 1),
  pg_temp.fx('admin_a'),
  'actor_profile_id is auth.uid() — taken from the session, never from a parameter');

-- THE METADATA WHITELIST, EXACTLY. Five keys, no more: a later addition that leaked an id or
-- an internal would fail here rather than in production.
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.last_audit(pg_temp.fx('p_audit'))) k),
  array['assignment_status', 'product_code', 'product_name', 'product_status', 'retailer_name'],
  'assignment audit metadata carries exactly five keys, and they are display fields');

select is(pg_temp.last_audit(pg_temp.fx('p_audit')) ->> 'product_code',   'A-AUDIT',
  'the product code snapshot is the real one');
select is(pg_temp.last_audit(pg_temp.fx('p_audit')) ->> 'product_name',   'Audit Widget',
  'the product display-name snapshot is the real one');
select is(pg_temp.last_audit(pg_temp.fx('p_audit')) ->> 'retailer_name',  'Alpha Retail',
  'the Retailer display-name snapshot is the real one');
select is(pg_temp.last_audit(pg_temp.fx('p_audit')) ->> 'assignment_status', 'ACTIVE',
  'and the assignment status snapshot records the state the operation established');

-- NO ID, NO INTERNAL, ANYWHERE IN THE METADATA. Names travel; identifiers and authorization
-- internals do not.
select is(
  (select count(*) from jsonb_object_keys(pg_temp.last_audit(pg_temp.fx('p_audit'))) k
   where k ~ 'id$|_id|organization|profile|member|role|permission|token|email|phone|relationship'),
  0::bigint,
  'no assignment audit metadata key is an id, organization, profile, membership, role, permission, token or contact field');

-- NO FOREIGN NAME CAN APPEAR. The Retailer name is read through the derived Vendor's own
-- relationship, so it can only ever be a Retailer this Vendor manages.
select is(
  (select count(*) from public.audit_logs a
   where a.action in ('PRODUCT_ASSIGNED_TO_RETAILER', 'PRODUCT_UNASSIGNED_FROM_RETAILER')
     and a.metadata::text ~* 'Zulu|Vendor B|Foreign Widget'),
  0::bigint,
  'no assignment audit row anywhere carries another Vendor''s Retailer name, organization name or product');

-- WITHDRAWAL AUDITS TOO, WITH ITS OWN CODE AND ITS OWN STATUS SNAPSHOT.
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_audit'), pg_temp.fx('ret_ok'));
select is(pg_temp.audit_count(pg_temp.fx('p_audit')), 2::bigint,
  'the withdrawal writes a second audit row');
select is(pg_temp.last_audit_action(pg_temp.fx('p_audit')), 'PRODUCT_UNASSIGNED_FROM_RETAILER',
  'with the exact shipped withdrawal action code');
select is(pg_temp.last_audit(pg_temp.fx('p_audit')) ->> 'assignment_status', 'INACTIVE',
  'and its status snapshot records INACTIVE — the state it established, not the one it replaced');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.last_audit(pg_temp.fx('p_audit'))) k),
  array['assignment_status', 'product_code', 'product_name', 'product_status', 'retailer_name'],
  'the withdrawal metadata carries the same five whitelisted keys');

-- A NO-OP WRITES NO AUDIT ROW. This is what stops a mobile double-tap producing two audit
-- entries for one decision.
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_audit'), pg_temp.fx('ret_ok'));
select is(pg_temp.audit_count(pg_temp.fx('p_audit')), 2::bigint,
  'a repeated withdrawal writes NO third audit row — an audit trail entry must correspond to a change');

select public.assign_vendor_product_to_retailer(pg_temp.fx('p_audit'), pg_temp.fx('ret_ok'));
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_audit'), pg_temp.fx('ret_ok'));
select is(pg_temp.audit_count(pg_temp.fx('p_audit')), 3::bigint,
  'and a repeated assignment writes no extra row either — three real transitions, three audit rows');

-- A FAILED MUTATION LEAVES NO AUDIT ROW. The audit INSERT is the last statement in the same
-- function body, so a refusal raised before it can never have written one. Both refusal
-- shapes are exercised: the product gate and the Retailer gate.
--
-- CHECK ORDER, STATED BECAUSE IT IS OBSERVABLE. Ownership is proven first, then the PRODUCT's
-- status, then the Retailer's eligibility. So a call in which BOTH the product and the
-- Retailer are ineligible reports the PRODUCT problem (55000), not the Retailer one. That
-- leaks nothing: the 55000 branch is reachable only after the caller has been shown to own
-- the product, and its status is already on their own catalogue page.
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_inactive'), pg_temp.fx('ret_dead_r'))),
  '55000',
  'when the product AND the Retailer are both ineligible, the PRODUCT gate answers first — ownership is proven before either');
select is(pg_temp.sqlstate_of(pg_temp.assign_sql(pg_temp.fx('p_matrix'), pg_temp.fx('ret_dead_r'))),
  '42501',
  'and with an ACTIVE product, the Retailer gate answers with the generic non-leaking refusal');
select is(pg_temp.audit_count(pg_temp.fx('p_inactive'), 'PRODUCT_ASSIGNED_TO_RETAILER'), 0::bigint,
  'neither refused assignment left an audit row behind');
select is(pg_temp.audit_count(pg_temp.fx('p_matrix'), 'PRODUCT_ASSIGNED_TO_RETAILER'), 0::bigint,
  'and no assignment audit row exists for the matrix product, which was never successfully assigned');

-- ATOMICITY, PROVEN RATHER THAN ASSERTED. A statement-level trigger that fails on any
-- assignment audit INSERT must take the assignment mutation down with it: if the mutation
-- survived while the audit row did not, the two are not in one transaction.
create function pg_temp.veto_audit() returns trigger
language plpgsql as $$
begin
  raise exception 'audit sink unavailable' using errcode = 'io_error';
end;
$$;

create trigger veto_assignment_audit
  before insert on public.audit_logs
  for each row
  when (new.action in ('PRODUCT_ASSIGNED_TO_RETAILER', 'PRODUCT_UNASSIGNED_FROM_RETAILER'))
  execute function pg_temp.veto_audit();

-- Wrapped in a SAVEPOINT so the deliberate failure does not abort the suite.
create function pg_temp.attempt_with_veto(p_sql text) returns text
language plpgsql as $$
begin
  begin
    execute p_sql;
    return null;
  exception when others then
    return sqlstate;
  end;
end;
$$;

select is(pg_temp.assignment_status(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok')), null,
  'p_reads has no assignment row before the atomicity probe');
select is(pg_temp.attempt_with_veto(pg_temp.assign_sql(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'))),
  '58030', 'with the audit sink failing, the assignment call raises');
select is(pg_temp.assignment_status(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok')), null,
  'AND NO ASSIGNMENT ROW SURVIVES — an audit failure rolls the mutation back, so the two are one transaction');

-- The same in the withdrawal direction: the status change must not survive a failed audit.
select is(pg_temp.attempt_with_veto(pg_temp.unassign_sql(pg_temp.fx('p_audit'), pg_temp.fx('ret_ok'))),
  '58030', 'with the audit sink failing, the withdrawal call raises');
select is(pg_temp.assignment_status(pg_temp.fx('p_audit'), pg_temp.fx('ret_ok')), 'ACTIVE',
  'AND THE STATUS IS UNCHANGED — the withdrawal rolled back with its audit row');

drop trigger veto_assignment_audit on public.audit_logs;

-- NO AUDIT ROW EXISTS WITHOUT ITS ASSIGNMENT, ANYWHERE IN THIS SUITE.
select is(
  (select count(*) from public.audit_logs a
   where a.action in ('PRODUCT_ASSIGNED_TO_RETAILER', 'PRODUCT_UNASSIGNED_FROM_RETAILER')
     and not exists (select 1 from public.vendor_product_retailer_assignments x
                     where x.vendor_product_id::text = a.entity_id)),
  0::bigint,
  'every assignment audit row written here has a surviving assignment row behind it');

-- THE ACTION VOCABULARY DID NOT GROW. Both codes are already in the set the shipped mobile
-- Audit Logs contract documents (migration 20260804090000), so no client needs a new label.
select is(
  (select count(*) from public.audit_logs
   where entity_type = 'VENDOR_PRODUCT'
     and action not in ('PRODUCT_CREATED', 'PRODUCT_UPDATED',
                        'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
                        'PRODUCT_ASSIGNED_TO_RETAILER', 'PRODUCT_UNASSIGNED_FROM_RETAILER')),
  0::bigint,
  'no product audit row carries an action code outside the six already shipped — this milestone invented none');


-- ============================================================================
-- SECTION H — read-after-write compatibility
-- ============================================================================
-- The writes return void, so a client refreshes through the canonical reads. These assertions
-- are what make that instruction safe: after every mutation the three shipped reads agree with
-- the table and with each other.

select pg_temp.act_as(pg_temp.fx('admin_a'));

-- A clean subject: p_reads, currently with no assignment rows at all.
select is((select count(*) from public.vendor_product_retailer_assignments
           where vendor_product_id = pg_temp.fx('p_reads')), 0::bigint,
  'p_reads starts with no assignments');

select is((select d.assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_reads')) d),
  0::bigint, 'get_vendor_product_detail reports assignment_count 0');
select is((select d.active_assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_reads')) d),
  0::bigint, 'and active_assignment_count 0');
select is((select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_reads'))),
  0::bigint, 'and the assigned-Retailer list is empty');

-- Assign to the one eligible Retailer.
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));

select is((select d.assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_reads')) d),
  1::bigint, 'after one assignment, assignment_count is 1');
select is((select d.active_assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_reads')) d),
  1::bigint, 'and active_assignment_count is 1');
select is((select l.active_assignment_count from public.list_vendor_products() l
           where l.product_id = pg_temp.fx('p_reads')),
  1::bigint, 'and list_vendor_products agrees — the list and the detail cannot disagree');

select is((select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_reads'))),
  1::bigint, 'the assigned-Retailer list returns exactly one row');
select is((select l.assignment_status from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_reads')) l),
  'ACTIVE', 'marked ACTIVE');
select is((select l.retailer_name from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_reads')) l),
  'Alpha Retail', 'naming the right Retailer');
select ok((select l.relationship_id is not null from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_reads')) l),
  'and carrying the relationship_id a client needs to open the Retailer screen');
select ok((select l.assigned_at is not null and l.assignment_updated_at is not null
           from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_reads')) l),
  'with both timestamps populated');

-- WITHDRAW. THE HISTORICAL ROW STAYS VISIBLE, and the two counts diverge — which is precisely
-- what tells a client that ending an assignment is not erasing one.
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));

select is((select d.assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_reads')) d),
  1::bigint, 'after withdrawal, assignment_count is STILL 1 — it counts every row, whatever its status');
select is((select d.active_assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_reads')) d),
  0::bigint, 'while active_assignment_count drops to 0');
select is((select l.active_assignment_count from public.list_vendor_products() l
           where l.product_id = pg_temp.fx('p_reads')),
  0::bigint, 'and the catalogue list agrees');
select is((select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_reads'))),
  1::bigint, 'the withdrawn assignment is STILL LISTED — withdrawal is not deletion');
select is((select l.assignment_status from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_reads')) l),
  'INACTIVE', 'and it is marked INACTIVE, so the client distinguishes current from historical by status alone');

-- Reassign, and the counts converge again on the same single row.
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));
select is((select d.assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_reads')) d),
  1::bigint, 'reassignment does not inflate assignment_count — the row was reused, not duplicated');
select is((select d.active_assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_reads')) d),
  1::bigint, 'and active_assignment_count returns to 1');

-- THE STANDING INVARIANT between the two reads: the assigned-Retailer row count IS
-- assignment_count, after every mutation this suite performed.
select is(
  (select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_matrix'))),
  (select d.assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_matrix')) d),
  'for the four-Retailer matrix product, the assigned-Retailer row count equals assignment_count exactly');
select is(
  (select count(*) from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_hist'))),
  (select d.assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_hist')) d),
  'and for the product cycled through two full withdraw/re-assign rounds');

-- COUNTS IGNORE RELATIONSHIP AND RETAILER STATUS. An ACTIVE assignment to a suspended
-- Retailer still counts as active — the shipped meaning of the number the web prints.
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));
select pg_temp.raw_assignment(pg_temp.fx('p_reads'), pg_temp.fx('ret_susp_o'), pg_temp.fx('admin_a'), 'ACTIVE');
select is((select d.active_assignment_count from public.get_vendor_product_detail(pg_temp.fx('p_reads')) d),
  2::bigint, 'an ACTIVE assignment against a SUSPENDED Retailer organization still counts as active');
select is(
  (select l.retailer_status from public.list_vendor_product_assigned_retailers(pg_temp.fx('p_reads')) l
    where l.retailer_organization_id = pg_temp.fx('ret_susp_o')),
  'SUSPENDED',
  'and the companion read returns the Retailer status honestly, so a client can compute a narrower figure itself');

-- The editor matrix the WEB uses still sees the same truth. Unchanged by this milestone, and
-- asserted here so a later edit to either read cannot drift from the other.
select is(
  (select m.assignment_status from public.list_vendor_product_retailer_assignments(pg_temp.fx('p_reads')) m
    where m.retailer_organization_id = pg_temp.fx('ret_ok')),
  'ACTIVE',
  'the web editor matrix reports the same ACTIVE assignment the mobile read does');
select is(
  (select m.assignment_status from public.list_vendor_product_retailer_assignments(pg_temp.fx('p_reads')) m
    where m.retailer_organization_id = pg_temp.fx('ret_dead_r')),
  null,
  'and reports NULL for a Retailer this product was never assigned to — its own distinct contract, unchanged');


-- ============================================================================
-- SECTION I — concurrency and uniqueness
-- ============================================================================
-- Cross-session races cannot be run inside one pgTAP transaction, so what is asserted here is
-- the MECHANISM that makes them safe, plus the outcomes that are observable single-session.
-- The four real races (create/create, create/withdraw, withdraw/create, withdraw/withdraw)
-- were run against a live two-session database during the audit and are recorded in
-- docs/mobile-vendor-product-assignment-writes-audit.md § 9; all four serialize, none
-- duplicates a row, and the audit-row count equals the number of REAL transitions.

-- THE LOCKS THAT DO THE SERIALIZING. assign takes FOR UPDATE on the product row before it
-- looks at anything else, so two concurrent assignments of the SAME product serialize on it;
-- both writes then take FOR UPDATE on the assignment row, which is what orders an assign
-- against a withdraw. Asserted against the installed source, so a later CREATE OR REPLACE
-- that dropped a lock would fail here.
select ok(
  (select p.prosrc ~* 'from public\.vendor_products\s+where id = p_product_id\s+and vendor_organization_id = v_vendor\s+for update'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'assign_vendor_product_to_retailer'),
  'assign locks the product row FOR UPDATE, which is what serializes two concurrent assignments of one product');
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer', 'unassign_vendor_product_from_retailer')
     and p.prosrc ~* 'from public\.vendor_product_retailer_assignments\s+where vendor_product_id[^;]+for update'),
  2::bigint,
  'BOTH writes lock the existing assignment row FOR UPDATE, which is what orders an assign against a withdraw');

-- THE UNIQUE INDEX IS THE FINAL PROTECTION, and it really does refuse a second row. Proven by
-- attempting the duplicate INSERT directly — the state a lost race would produce.
select throws_ok(
  format($q$insert into public.vendor_product_retailer_assignments
            (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id)
          values (%L, %L, 'ACTIVE', %L)$q$,
         pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'), pg_temp.fx('admin_a')),
  '23505', null,
  'a second row for an existing pairing is refused by the unique index, whatever the status');

-- And it is refused for an INACTIVE row too — the index is unpartial, so history cannot be
-- duplicated by withdrawing and inserting afresh.
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));
select throws_ok(
  format($q$insert into public.vendor_product_retailer_assignments
            (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id)
          values (%L, %L, 'ACTIVE', %L)$q$,
         pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'), pg_temp.fx('admin_a')),
  '23505', null,
  'and refused even when the existing row is INACTIVE — a withdrawn pairing cannot be duplicated');

-- REPEATED OPERATIONS CONVERGE. Four assignments and four withdrawals in sequence leave one
-- row and exactly the audit rows the real transitions justify.
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));
select public.assign_vendor_product_to_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));
select public.unassign_vendor_product_from_retailer(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok'));

select is((select count(*) from public.vendor_product_retailer_assignments
           where vendor_product_id = pg_temp.fx('p_reads')
             and retailer_organization_id = pg_temp.fx('ret_ok')), 1::bigint,
  'six repeated operations leave exactly ONE row');
select is(pg_temp.assignment_status(pg_temp.fx('p_reads'), pg_temp.fx('ret_ok')), 'INACTIVE',
  'in the state the last real transition asked for');

-- NO DUPLICATE PAIRING EXISTS ANYWHERE IN THIS SUITE.
select is(
  (select count(*) from (
     select vendor_product_id, retailer_organization_id
     from public.vendor_product_retailer_assignments
     group by 1, 2 having count(*) > 1) d),
  0::bigint,
  'not one duplicate (product, Retailer) pairing exists after everything above');


-- ============================================================================
-- SECTION J — sensitive-field exclusion, and the boundaries this milestone did not cross
-- ============================================================================

-- NEITHER WRITE RETURNS ANYTHING AT ALL, so the "no sensitive field in the result" rule holds
-- structurally rather than by inspection. Restated as a test because it is the reason no
-- organization id, profile id, membership id, permission code or audit metadata can reach a
-- client through these two calls.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer', 'unassign_vendor_product_from_retailer')
     and format_type(p.prorettype, null) <> 'void'),
  0::bigint,
  'neither write returns a row, an id, a status, a collection, or anything else — so no field can leak through a result');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('assign_vendor_product_to_retailer', 'unassign_vendor_product_from_retailer')
     and pg_temp.arg_names(p.proname, array['t'::"char"]) <> '{}'::text[]),
  0::bigint,
  'and neither declares any OUT or TABLE column');

-- THE PRODUCT RECORD WRITE CONTRACT IS UNTOUCHED. This milestone changed no product write.
select is(pg_temp.input_types('create_vendor_product'), array['text','text','text','text','text'],
  'create_vendor_product still takes exactly five text inputs — unchanged by this milestone');
select is(pg_temp.input_types('update_vendor_product'), array['uuid','text','text','text','text'],
  'update_vendor_product still takes uuid then four text inputs — unchanged');
select is(pg_temp.input_types('set_vendor_product_status'), array['uuid','text'],
  'set_vendor_product_status still takes exactly (uuid, text) — unchanged');

-- THE READ CONTRACTS ARE UNTOUCHED. A silent change to any of the three would break a shipped
-- Flutter screen, and read-after-write is the whole basis of the void return.
select is(pg_temp.arg_names('list_vendor_product_assigned_retailers', array['t'::"char"]),
  array['relationship_id', 'retailer_organization_id', 'retailer_name', 'retailer_status',
        'relationship_status', 'assignment_status', 'assigned_at', 'assignment_updated_at'],
  'list_vendor_product_assigned_retailers still returns its eight shipped columns, in order');
select is(pg_temp.arg_names('get_vendor_product_detail', array['t'::"char"]),
  array['product_id', 'product_code', 'barcode', 'product_name', 'brand', 'description',
        'status', 'assignment_count', 'active_assignment_count', 'created_at', 'updated_at'],
  'get_vendor_product_detail still returns its eleven shipped columns, in order');
select is(pg_temp.arg_names('list_vendor_products', array['t'::"char"]),
  array['product_id', 'product_code', 'barcode', 'product_name', 'brand', 'description',
        'status', 'active_assignment_count', 'created_at', 'updated_at'],
  'list_vendor_products still returns its ten shipped columns, in order');
select is(pg_temp.arg_names('list_vendor_product_retailer_assignments', array['t'::"char"]),
  array['retailer_organization_id', 'retailer_name', 'retailer_status',
        'relationship_status', 'assignment_status', 'assigned_at'],
  'the web editor matrix still returns its six shipped columns, in order — the web is unaffected');

-- NOTHING WAS DELETED, ANYWHERE. Every product and every relationship this suite touched
-- still exists, and every assignment row ever created here still exists.
select is(
  (select count(*) from public.vendor_products where vendor_organization_id = pg_temp.fx('vendor_a')),
  6::bigint,
  'all six of Vendor A''s products still exist — no assignment operation removed one');
select is(
  (select count(*) from public.vendor_retailers where vendor_organization_id = pg_temp.fx('vendor_a')),
  5::bigint,
  'all five of Vendor A''s Retailer relationships still exist');
select ok(
  (select count(*) from public.vendor_product_retailer_assignments) > 0,
  'and assignment rows exist — none of the withdrawals above removed one');

select * from finish();
rollback;
