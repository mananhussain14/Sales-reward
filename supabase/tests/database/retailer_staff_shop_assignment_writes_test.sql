-- pgTAP behavioural tests for the post-acceptance Retailer staff SHOP ASSIGNMENT write:
--
--   public.set_retailer_staff_shop_assignments(uuid, uuid[])
--     [20260809090000_retailer_staff_shop_assignment_management.sql]
--
-- Run with:   npx supabase test db      (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE SPECIFIES
-- ============================================================================
-- This is the FIRST and ONLY write that can change a Sales Staff member's shops after
-- the invitation has been accepted. Before it, public.retailer_shop_members was written
-- at exactly one moment — inside accept_retailer_staff_invitation — and never again.
-- Everything a second client (web or Flutter) will depend on is therefore stated here
-- rather than inferred from the migration's prose:
--
--   1. REPLACEMENT, SCOPED TO THE ACTIVE-SHOP PROJECTION. The caller sends the complete
--      requested set; add/keep/remove is computed server-side. A live assignment to a
--      SUSPENDED or DEACTIVATED shop is invisible in list_retailer_staff_members() and
--      is therefore PRESERVED, untouched, and counted in none of the three totals.
--      Sections H and I are the whole of that guarantee.
--   2. AT LEAST ONE SHOP. An empty or null requested set is refused (23514). There is no
--      "stand this person down" path in this milestone.
--   3. DUPLICATES ARE CANONICALIZED, NOT REJECTED. {A, A, B} means {A, B}.
--   4. RETIREMENT, NEVER DELETION. removed_at is set; the row survives. Re-adding a
--      previously removed shop INSERTS A NEW ROW and the retired one stays on record.
--   5. A NO-OP WRITES NOTHING, INCLUDING NO AUDIT ROW. This is what stops a double-tap
--      producing two audit entries for one decision.
--   6. EVERY REFUSAL IS UNIFORM. Unauthenticated, Manager, Sales Staff, Vendor,
--      cross-tenant, unknown, inactive and non-Sales-Staff targets all receive the SAME
--      42501, so a caller cannot sweep membership ids to learn what exists elsewhere.
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as
-- the `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as
-- far as every authorization helper in this schema is concerned. pg_temp.act_as() does
-- exactly that and pg_temp.sign_out() clears it. This mirrors every other suite in this
-- directory — one idiom for "signed in", not seven.
--
-- The tests do NOT `set role authenticated` except in Section K, where denial of DIRECT
-- table access is the subject. The function is SECURITY DEFINER, so its behaviour depends
-- on auth.uid() and not on the session role, and switching roles for the rest of the
-- suite would only make the fixture inserts fail. EXECUTE privilege is asserted directly
-- against the catalogue in Section A, which is stronger than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back: no membership, assignment or
-- audit row written below survives, and neither does Section C's temporary removal of a
-- seeded role -> permission mapping.
--
-- ============================================================================
-- DETERMINISM
-- ============================================================================
-- NO ASSERTION DEPENDS ON UUID ORDERING. Every set comparison is made over shop NAMES
-- ordered by name — chosen so that alphabetical order is fixed by the fixture and not by
-- gen_random_uuid(). (A previous suite in this directory had to be repaired for exactly
-- that class of flakiness; see commit 5667221.)
--
-- now() is the TRANSACTION timestamp and is constant for the whole file, so it cannot
-- witness "this row was written". ctid — the tuple's physical location, which ANY
-- row-touching UPDATE changes — is used instead wherever "nothing was written at all"
-- must be proved.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file
-- turns an added test into a confusing failure about arithmetic rather than about
-- behaviour.

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

create function pg_temp.new_org(p_name text, p_type text default 'RETAILER', p_status text default 'ACTIVE')
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

/* A member holding one role in one organization, in a single call. */
create function pg_temp.staff(p_user uuid, p_org uuid, p_role text, p_status text default 'ACTIVE')
returns uuid
language plpgsql as $$
declare
  v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, p_status,
          case when p_status = 'INVITED' then null else now() - interval '30 days' end)
  returning id into v_member;

  insert into public.member_roles (organization_member_id, role_id)
  select v_member, r.id from public.roles r where r.code = p_role
  on conflict do nothing;

  return v_member;
end;
$$;

create function pg_temp.new_shop(p_org uuid, p_name text, p_status text default 'ACTIVE')
returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.retailer_shops (retailer_organization_id, name, code, city, country_code, status)
  values (p_org, p_name, upper(replace(p_name, ' ', '-')), 'Dubai', 'AE', p_status)
  returning id into v_id;
  return v_id;
end;
$$;

/*
 * Creates a LIVE assignment row DIRECTLY, bypassing the function under test.
 *
 * Every starting state below is seeded this way, for two reasons. The function is the
 * SUBJECT of this suite, so using it to build fixtures would make a failure in one
 * section cascade into unrelated ones; and it is the only way to seed a state the
 * function itself refuses to produce — a live assignment to a SUSPENDED shop, which is
 * reachable in production (deactivate a shop without touching its staff) and which
 * Section H depends on entirely.
 */
create function pg_temp.raw_assign(p_member uuid, p_shop uuid, p_actor uuid)
returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.retailer_shop_members (organization_member_id, retailer_shop_id, assigned_by)
  values (p_member, p_shop, p_actor)
  returning id into v_id;
  return v_id;
end;
$$;

/* THE canonical observation: the shop NAMES a member is live-assigned to, ordered by
 * name. Deliberately NOT filtered by shop status — this is the whole truth of the table,
 * which is what makes "the suspended shop survived" observable at all. */
create function pg_temp.live_names(p_member uuid) returns text[]
language sql stable as $$
  select coalesce(array_agg(s.name order by s.name), '{}'::text[])
  from public.retailer_shop_members sm
  join public.retailer_shops s on s.id = sm.retailer_shop_id
  where sm.organization_member_id = p_member
    and sm.removed_at is null;
$$;

/* The same set as the ROSTER would show it — live AND shop ACTIVE. The projection the
 * function's replacement is scoped to. */
create function pg_temp.live_active_names(p_member uuid) returns text[]
language sql stable as $$
  select coalesce(array_agg(s.name order by s.name), '{}'::text[])
  from public.retailer_shop_members sm
  join public.retailer_shops s on s.id = sm.retailer_shop_id
  where sm.organization_member_id = p_member
    and sm.removed_at is null
    and s.status = 'ACTIVE';
$$;

create function pg_temp.retired_names(p_member uuid) returns text[]
language sql stable as $$
  select coalesce(array_agg(s.name order by s.name), '{}'::text[])
  from public.retailer_shop_members sm
  join public.retailer_shops s on s.id = sm.retailer_shop_id
  where sm.organization_member_id = p_member
    and sm.removed_at is not null;
$$;

/* Total rows for one (member, shop) pair, live and retired alike. The distinction
 * between "one row flipped back" and "a second row was inserted" is the whole of the
 * history-preservation guarantee, so it must never collapse into one number. */
create function pg_temp.row_count(p_member uuid, p_shop uuid) returns bigint
language sql stable as $$
  select count(*) from public.retailer_shop_members sm
  where sm.organization_member_id = p_member and sm.retailer_shop_id = p_shop;
$$;

create function pg_temp.live_row_count(p_member uuid) returns bigint
language sql stable as $$
  select count(*) from public.retailer_shop_members sm
  where sm.organization_member_id = p_member and sm.removed_at is null;
$$;

/* The physical row version of one live assignment — the only non-vacuous witness that a
 * write touched it, inside a suite where now() is constant. */
create function pg_temp.live_version(p_member uuid, p_shop uuid) returns text
language sql stable as $$
  select sm.ctid::text from public.retailer_shop_members sm
  where sm.organization_member_id = p_member
    and sm.retailer_shop_id = p_shop
    and sm.removed_at is null;
$$;

create function pg_temp.removed_at_of(p_member uuid, p_shop uuid) returns timestamptz
language sql stable as $$
  select max(sm.removed_at) from public.retailer_shop_members sm
  where sm.organization_member_id = p_member and sm.retailer_shop_id = p_shop;
$$;

/*
 * The SQLSTATE raised when the current caller runs p_sql, or NULL if it returned
 * normally. Sequenced in plpgsql on purpose: throws_ok() cannot express the "this refusal
 * is byte-identical to that one" comparisons Sections D and E need.
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

/* The call under test, as text, so a denial and a success are written the same way. */
create function pg_temp.set_sql(p_member uuid, p_shops uuid[]) returns text
language sql immutable as $$
  select format(
    'select * from public.set_retailer_staff_shop_assignments(%L::uuid, %L::uuid[])',
    p_member, p_shops);
$$;

/* The call under test, returning its three counts as [added, removed, unchanged]. */
create function pg_temp.set_shops(p_member uuid, p_shops uuid[]) returns integer[]
language plpgsql as $$
declare
  v_a integer;
  v_r integer;
  v_u integer;
begin
  select t.shops_added, t.shops_removed, t.shops_unchanged
    into v_a, v_r, v_u
  from public.set_retailer_staff_shop_assignments(p_member, p_shops) t;
  return array[v_a, v_r, v_u];
end;
$$;

create function pg_temp.audit_count(p_member uuid) returns bigint
language sql stable as $$
  select count(*) from public.audit_logs a
  where a.entity_type = 'RETAILER_STAFF_MEMBER'
    and a.entity_id = p_member::text;
$$;

/* The most recently appended audit row for a membership. ctid is physical insertion
 * order, which for rows appended in one transaction is the order they were written —
 * created_at cannot order them, because now() is constant here. */
create function pg_temp.last_audit(p_member uuid) returns public.audit_logs
language sql stable as $$
  select a.* from public.audit_logs a
  where a.entity_type = 'RETAILER_STAFF_MEMBER' and a.entity_id = p_member::text
  order by a.ctid desc limit 1;
$$;

/* Function-argument and table-column names, read from the catalogue.
 *
 * A `returns table (...)` function has prorettype = `record`, a pseudo-type with no
 * typrelid, so reading its columns through pg_class yields NOTHING and an assertion
 * written that way compares NULL to NULL and passes vacuously. The names live in
 * proargnames, distinguished only by proargmodes: 'i'/'b'/'v' for an input, 't' for a
 * table column. */
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

create function pg_temp.out_args(p_name text) returns text[]
language sql stable as $$
  select pg_temp.arg_names(p_name, array['t'::"char", 'o'::"char"]);
$$;

create function pg_temp.input_types(p_name text) returns text[]
language sql stable as $$
  select coalesce(array_agg(format_type(t, null) order by ord), '{}'::text[])
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(p.proargtypes::oid[]) with ordinality as x(t, ord)
  where n.nspname = 'public' and p.proname = p_name;
$$;

create function pg_temp.installed_source(p_name text) returns text
language sql stable as $$
  select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name;
$$;

/* The installed body with every `--` comment line removed.
 *
 * Load-bearing, not tidiness: the body's own commentary discusses RETAILER_OWNER and
 * RETAILER_MANAGER at length precisely to explain why neither gates the operation, so an
 * assertion against the raw source would fail on the sentence that states the guarantee.
 * Same idiom as the stripComments() helper in the Node contract suite. */
create function pg_temp.installed_code(p_name text) returns text
language sql stable as $$
  select string_agg(line, E'\n')
  from unnest(string_to_array(pg_temp.installed_source(p_name), E'\n')) as line
  where line !~ '^\s*--';
$$;

create table pg_temp.fx (k text primary key, v uuid);
create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.fx where k = p_k; $$;

-- The function under test, named once so a rename shows up as one failure rather than
-- forty.
create function pg_temp.fn() returns text language sql immutable as $$
  select 'set_retailer_staff_shop_assignments'::text;
$$;


-- ============================================================================
-- SECTION A — signature, security attributes and privileges (catalogue-level)
-- ============================================================================
-- Asserted against the catalogue rather than inferred from behaviour: "it did not error
-- for me" is not a privilege check, and a grant that widened by accident would still let
-- every behavioural test below pass.

select has_function('public', 'set_retailer_staff_shop_assignments', array['uuid', 'uuid[]'],
  'set_retailer_staff_shop_assignments(uuid, uuid[]) exists');

-- EXACTLY ONE staff shop-assignment write exists. This milestone added no second entry
-- point — no add_/remove_ pair, no bulk variant, no mobile duplicate. A second one would
-- be a second place for the zero-shop rule and the ACTIVE-projection rule to be stated,
-- and only one of the two could stay right.
select is(
  (select array_agg(p.proname::text order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname ~ 'retailer_staff_shop_assignment'),
  array['set_retailer_staff_shop_assignments'],
  'exactly one staff shop-assignment write exists — no add/remove pair, no bulk variant');

-- THE SIGNATURE IS THE DEPLOYED ONE. Clients call this by NAMED argument through
-- PostgREST, so a renamed parameter or a reordered pair is a silently broken client.
select is(pg_temp.input_types(pg_temp.fn()), array['uuid', 'uuid[]'],
  'takes exactly (uuid, uuid[])');
select is(pg_temp.input_args(pg_temp.fn()), array['p_membership_id', 'p_shop_ids'],
  'exposes exactly (p_membership_id, p_shop_ids), in that order');

-- NO DEFAULTS. Both arguments are required, so a call that omits one is a PostgREST
-- error rather than a silently half-addressed write.
select is(
  (select p.pronargdefaults::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  0, 'no argument is defaulted');

-- THE RETURN SHAPE IS THE THREE COUNTS, AND ONLY THEM. No id, no name, no timestamp, no
-- status, no audit detail, and no hidden non-ACTIVE assignment.
select is(pg_temp.out_args(pg_temp.fn()),
  array['shops_added', 'shops_removed', 'shops_unchanged'],
  'returns exactly (shops_added, shops_removed, shops_unchanged), in that order');

select is(
  (select array_agg(format_type(t, null) order by ord)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(p.proallargtypes) with ordinality as x(t, ord)
   join lateral unnest(p.proargmodes) with ordinality as m(mode, mord) on m.mord = x.ord
   where n.nspname = 'public' and p.proname = pg_temp.fn() and m.mode = 't'),
  array['integer', 'integer', 'integer'],
  'all three returned counts are integer');

-- NO IDENTITY, TENANT, ROLE, PERMISSION, STATUS, TIMESTAMP OR AUDIT ARGUMENT. This is the
-- trusted-identity rule stated as a test: a caller may address a membership and name a
-- shop set, and nothing else. Everything that decides WHETHER the write may happen is
-- derived server-side from auth.uid().
select is(
  (select count(*) from unnest(pg_temp.input_args(pg_temp.fn())) a
   where a ~ 'organization|retailer|tenant|owner|actor|user|profile|auth|uid|email|token|claim|role|permission|status|audit|version|updated|timestamp'),
  0::bigint,
  'accepts no organization, Retailer, tenant, actor, user, profile, auth, email, token, role, permission, status, audit or version argument');

select is(
  (select count(*) from unnest(pg_temp.input_args(pg_temp.fn())) a
   where a not in ('p_membership_id', 'p_shop_ids')),
  0::bigint,
  'accepts the membership and the shop set and NOTHING else — no current-assignment list, no add/remove pair, no idempotency key');

-- SECURITY DEFINER, VOLATILE, EMPTY search_path.
select ok(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  'is SECURITY DEFINER');
select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  'v', 'is VOLATILE — the correct classification for a function that writes');
select ok(
  (select p.proconfig @> array['search_path=""'] from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  'runs with an EMPTY search_path');

-- GRANTS: authenticated only.
select ok(has_function_privilege('authenticated',
  'public.set_retailer_staff_shop_assignments(uuid, uuid[])', 'execute'),
  'authenticated may execute the assignment write');
select ok(not has_function_privilege('anon',
  'public.set_retailer_staff_shop_assignments(uuid, uuid[])', 'execute'),
  'anon may NOT execute the assignment write');

-- PUBLIC holds nothing. PostgreSQL grants EXECUTE to PUBLIC by default on every new
-- function, which on a SECURITY DEFINER writer would be exactly wrong; the migration
-- revokes it and this is what proves the revoke is still in force.
select ok(
  (select coalesce(array_to_string(p.proacl, ','), '') !~ '(^|,)=X/' from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  'the assignment write does not grant EXECUTE to PUBLIC');

-- NO SERVICE-ROLE GRANT. Its entire authority is auth.uid(), which a service-role
-- connection does not have, so a grant would produce a function that can only ever refuse
-- — and would invite a caller to try.
select ok(
  (select coalesce(array_to_string(p.proacl, ','), '') !~ 'service_role=X' from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  'the assignment write is NOT granted to service_role');

-- THE INSTALLED SOURCE CONTAINS NO DELETE, NO TRUNCATE AND NO DYNAMIC SQL. Retirement is
-- never deletion, and a tenant predicate assembled by string concatenation is a tenant
-- predicate waiting to be lost. Asserted against the installed body rather than against
-- the migration file, so a later CREATE OR REPLACE cannot slip past it.
select ok(pg_temp.installed_code(pg_temp.fn()) !~* '\mdelete\M',
  'the installed body contains no DELETE — an assignment is retired, never destroyed');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* '\mtruncate\M',
  'the installed body contains no TRUNCATE');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* '\mexecute\M',
  'the installed body contains no dynamic SQL');

-- THE LOCKING CLAUSES ARE PRESENT IN THE INSTALLED BODY. True concurrency cannot be
-- exercised inside one transaction (see Section L), so the mechanism is asserted here and
-- its OUTCOME — idempotency and last-write-wins — is asserted behaviourally below.
select ok(pg_temp.installed_code(pg_temp.fn()) ~* '\mfor\s+update\M',
  'the installed body locks the target membership FOR UPDATE — the serialization point');
select ok(pg_temp.installed_code(pg_temp.fn()) ~* '\mfor\s+share\M',
  'the installed body locks the requested shops FOR SHARE');
select ok(pg_temp.installed_code(pg_temp.fn()) ~* 'order\s+by\s+s\.id',
  'the requested shops are locked in ascending UUID order — deterministic lock order');

-- THE PERMISSION IS NAMED, AND NO ROLE CODE GATES THE OPERATION. The role -> permission
-- MAPPING is the authority; a role code in the body would be a second, drifting copy of
-- it. 'SALES_STAFF' is the one role code that legitimately appears — it constrains the
-- TARGET, not the caller — so it is excluded by name rather than by a weaker pattern.
select ok(pg_temp.installed_code(pg_temp.fn()) like '%RETAILER_STAFF_SHOP_ASSIGN%',
  'the installed body gates on RETAILER_STAFF_SHOP_ASSIGN');
select ok(pg_temp.installed_code(pg_temp.fn()) not like '%RETAILER_OWNER%',
  'the executable body names no RETAILER_OWNER role code — the mapping is the authority');
select ok(pg_temp.installed_code(pg_temp.fn()) not like '%RETAILER_MANAGER%',
  'the executable body names no RETAILER_MANAGER role code either');
-- SALES_STAFF is the ONE role code that legitimately appears, and it constrains the
-- TARGET rather than the caller: this operation is defined only for Sales Staff, so the
-- restriction belongs in the function and not in a permission mapping.
select ok(pg_temp.installed_code(pg_temp.fn()) like '%SALES_STAFF%',
  'the executable body names SALES_STAFF — the target restriction, not a caller gate');

-- ============================================================================
-- SECTION B — the table's posture is unchanged by this milestone
-- ============================================================================
-- An RLS policy or a table grant added here would be a second, independent definition of
-- who may change an assignment, and this RPC already answers that question.

select ok(
  (select relrowsecurity from pg_class where oid = 'public.retailer_shop_members'::regclass),
  'retailer_shop_members still has RLS enabled');

select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename = 'retailer_shop_members'),
  0::bigint,
  'retailer_shop_members still has ZERO policies — default deny');

select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'retailer_shop_members'
     and grantee in ('anon', 'authenticated', 'PUBLIC')),
  0::bigint,
  'no browser role holds any privilege on retailer_shop_members');

-- THE DUPLICATE GUARD IS STILL IN PLACE, and it is still PARTIAL. Partiality is what lets
-- history accumulate: one live row per (member, shop), any number of retired ones.
select ok(
  (select i.indisunique and i.indpred is not null
   from pg_index i join pg_class c on c.oid = i.indexrelid
   where i.indrelid = 'public.retailer_shop_members'::regclass
     and c.relname = 'retailer_shop_members_live_unique_idx'),
  'retailer_shop_members_live_unique_idx is UNIQUE and PARTIAL — one LIVE row per pairing, history unbounded');

select is(
  (select array_agg(a.attname::text order by k.ord)
   from pg_index i
   join pg_class c on c.oid = i.indexrelid
   cross join lateral unnest(i.indkey) with ordinality as k(att, ord)
   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.att
   where i.indrelid = 'public.retailer_shop_members'::regclass
     and c.relname = 'retailer_shop_members_live_unique_idx'),
  array['organization_member_id', 'retailer_shop_id'],
  'the live-uniqueness scope is exactly (organization_member_id, retailer_shop_id)');

-- retailer_shop_members has NO status column: removed_at IS the lifecycle. A test written
-- against a status column would pass vacuously, so the absence is asserted.
select hasnt_column('public', 'retailer_shop_members', 'status',
  'retailer_shop_members has no status column — removed_at is the entire lifecycle');
select has_column('public', 'retailer_shop_members', 'removed_at',
  'retailer_shop_members retires rows through removed_at');

-- THE READ CONTRACTS ARE UNTOUCHED. This milestone changed no read, so the roster still
-- returns the canonical membership id the write addresses, and the shop picker still
-- returns shop ids. A client can therefore drive the whole editor from the two reads it
-- already makes.
select is(pg_temp.out_args('list_retailer_staff_members'),
  array['membership_id', 'first_name', 'last_name', 'role_code', 'role_name',
        'membership_status', 'shop_ids', 'shop_names', 'joined_at', 'created_at'],
  'list_retailer_staff_members still returns membership_id first and its contract is unchanged');
select is(pg_temp.out_args('list_retailer_staff_assignable_shops'),
  array['shop_id', 'shop_name', 'shop_code', 'city'],
  'list_retailer_staff_assignable_shops contract is unchanged');


-- ============================================================================
-- Fixture
-- ============================================================================
-- TWO ACTIVE Retailers plus one that is later SUSPENDED, so every tenant-isolation claim
-- below is about a membership and a shop that genuinely belong to someone else rather
-- than about an id that names nothing.
--
-- SHOP NAMES ARE THE ORDERING KEY EVERYWHERE, so they are chosen to sort unambiguously:
--   Alpha / Bravo / Charlie / Delta   ACTIVE   — the assignable set of Retailer One
--   Sierra                            SUSPENDED
--   Yankee                            DEACTIVATED
--   Zulu                              ACTIVE, but belongs to Retailer Two
--
-- EACH BEHAVIOURAL SECTION GETS ITS OWN STAFF MEMBER. Sharing one would make a failure in
-- an early section cascade into every later one, and would make "this row was never
-- touched" unprovable.

insert into pg_temp.fx (k, v) values
  ('owner_1',      pg_temp.new_person('Ola',   'Owner')),
  ('owner_1b',     pg_temp.new_person('Omar',  'Second')),
  ('manager_1',    pg_temp.new_person('Mo',    'Manager')),
  ('vendor_admin', pg_temp.new_person('Ada',   'Admin')),
  ('owner_2',      pg_temp.new_person('Otto',  'Foreign')),
  ('owner_3',      pg_temp.new_person('Ivan',  'Inactive')),
  -- One person per behavioural section.
  ('u_grow',       pg_temp.new_person('Gina',  'Grow')),
  ('u_shrink',     pg_temp.new_person('Sara',  'Shrink')),
  ('u_swap',       pg_temp.new_person('Sven',  'Swap')),
  ('u_idem',       pg_temp.new_person('Ida',   'Idem')),
  ('u_dup',        pg_temp.new_person('Dana',  'Dupe')),
  ('u_hidden',     pg_temp.new_person('Hana',  'Hidden')),
  ('u_hist',       pg_temp.new_person('Hugo',  'History')),
  ('u_roll',       pg_temp.new_person('Rex',   'Rollback')),
  ('u_audit',      pg_temp.new_person('Amy',   'Audited')),
  ('u_guard',      pg_temp.new_person('Gus',   'Guard')),
  ('u_zero',       pg_temp.new_person('Zoe',   'Zero')),
  ('u_frozen',     pg_temp.new_person('Fred',  'Frozen')),
  ('u_caller',     pg_temp.new_person('Cara',  'Caller')),
  ('u_foreign',    pg_temp.new_person('Fay',   'Foreign')),
  ('u_r3',         pg_temp.new_person('Rita',  'Suspended'));

insert into pg_temp.fx (k, v) values
  ('r1',     pg_temp.new_org('Retailer One')),
  ('r2',     pg_temp.new_org('Retailer Two')),
  ('r3',     pg_temp.new_org('Retailer Three')),
  ('vendor', pg_temp.new_org('The Vendor', 'VENDOR'));

-- Retailer One: the Owner under test, a Manager (read-only), and the Sales Staff.
insert into pg_temp.fx (k, v) values
  ('m_owner_1',   pg_temp.staff(pg_temp.fx('owner_1'),   pg_temp.fx('r1'), 'RETAILER_OWNER')),
  ('m_manager_1', pg_temp.staff(pg_temp.fx('manager_1'), pg_temp.fx('r1'), 'RETAILER_MANAGER')),
  ('m_grow',      pg_temp.staff(pg_temp.fx('u_grow'),    pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_shrink',    pg_temp.staff(pg_temp.fx('u_shrink'),  pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_swap',      pg_temp.staff(pg_temp.fx('u_swap'),    pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_idem',      pg_temp.staff(pg_temp.fx('u_idem'),    pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_dup',       pg_temp.staff(pg_temp.fx('u_dup'),     pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_hidden',    pg_temp.staff(pg_temp.fx('u_hidden'),  pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_hist',      pg_temp.staff(pg_temp.fx('u_hist'),    pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_roll',      pg_temp.staff(pg_temp.fx('u_roll'),    pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_audit',     pg_temp.staff(pg_temp.fx('u_audit'),   pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_guard',     pg_temp.staff(pg_temp.fx('u_guard'),   pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_zero',      pg_temp.staff(pg_temp.fx('u_zero'),    pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_caller',    pg_temp.staff(pg_temp.fx('u_caller'),  pg_temp.fx('r1'), 'SALES_STAFF')),
  -- A SUSPENDED Sales Staff membership: manageable state is ACTIVE only.
  ('m_frozen',    pg_temp.staff(pg_temp.fx('u_frozen'),  pg_temp.fx('r1'), 'SALES_STAFF', 'SUSPENDED')),
  -- Retailer Two: a complete, separate tenant.
  ('m_owner_2',   pg_temp.staff(pg_temp.fx('owner_2'),   pg_temp.fx('r2'), 'RETAILER_OWNER')),
  ('m_foreign',   pg_temp.staff(pg_temp.fx('u_foreign'), pg_temp.fx('r2'), 'SALES_STAFF')),
  -- Retailer Three: suspended below, after its rows exist.
  ('m_owner_3',   pg_temp.staff(pg_temp.fx('owner_3'),   pg_temp.fx('r3'), 'RETAILER_OWNER')),
  ('m_r3',        pg_temp.staff(pg_temp.fx('u_r3'),      pg_temp.fx('r3'), 'SALES_STAFF')),
  -- A Vendor Super Admin, who must be refused by the Retailer-only resolver.
  ('m_vendor',    pg_temp.staff(pg_temp.fx('vendor_admin'), pg_temp.fx('vendor'), 'VENDOR_SUPER_ADMIN'));

insert into pg_temp.fx (k, v) values
  ('alpha',   pg_temp.new_shop(pg_temp.fx('r1'), 'Alpha Shop')),
  ('bravo',   pg_temp.new_shop(pg_temp.fx('r1'), 'Bravo Shop')),
  ('charlie', pg_temp.new_shop(pg_temp.fx('r1'), 'Charlie Shop')),
  ('delta',   pg_temp.new_shop(pg_temp.fx('r1'), 'Delta Shop')),
  ('sierra',  pg_temp.new_shop(pg_temp.fx('r1'), 'Sierra Shop', 'SUSPENDED')),
  ('yankee',  pg_temp.new_shop(pg_temp.fx('r1'), 'Yankee Shop', 'DEACTIVATED')),
  ('zulu',    pg_temp.new_shop(pg_temp.fx('r2'), 'Zulu Shop')),
  ('r3shop',  pg_temp.new_shop(pg_temp.fx('r3'), 'Romeo Shop'));

-- A stable id that names nothing at all, for the "unknown" cases.
insert into pg_temp.fx (k, v) values ('nowhere', '00000000-0000-4000-8000-000000000000'::uuid);

-- Retailer Three is suspended only now, so its members, roles and shop could be created
-- first. This is the "inactive Retailer" case; a suspended organization is exactly what
-- resolve_retailer_member_organization refuses.
update public.organizations set status = 'SUSPENDED' where id = pg_temp.fx('r3');

-- Starting assignments, seeded directly. Every one of these is a LIVE row.
select pg_temp.raw_assign(pg_temp.fx('m_grow'),   pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_shrink'), pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_shrink'), pg_temp.fx('bravo'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_shrink'), pg_temp.fx('charlie'), pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_swap'),   pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_swap'),   pg_temp.fx('bravo'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_idem'),   pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_idem'),   pg_temp.fx('bravo'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_dup'),    pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
-- The R-1 fixture: one visible ACTIVE shop and TWO invisible ones.
select pg_temp.raw_assign(pg_temp.fx('m_hidden'), pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_hidden'), pg_temp.fx('sierra'),  pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_hidden'), pg_temp.fx('yankee'),  pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_hist'),   pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_hist'),   pg_temp.fx('bravo'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_roll'),   pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_roll'),   pg_temp.fx('bravo'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_audit'),  pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_guard'),  pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_zero'),   pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_caller'), pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_frozen'), pg_temp.fx('alpha'),   pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_foreign'), pg_temp.fx('zulu'),   pg_temp.fx('owner_2'));

-- The Manager holds NO assignment rows. Retailer-wide roles are retailer-wide BY ROLE,
-- which is precisely why a shop write against one is meaningless and refused.
select is(pg_temp.live_names(pg_temp.fx('m_manager_1')), '{}'::text[],
  'the Retailer Manager holds no shop assignment rows — retailer-wide access is by role');


-- ============================================================================
-- SECTION C — the permission is RETAILER_STAFF_SHOP_ASSIGN, and it alone
-- ============================================================================
-- The seeded mapping is REMOVED rather than assumed present. Asserting "an Owner can
-- assign" proves only that the caller holds SOMETHING; removing exactly one mapping and
-- watching exactly one capability disappear is what proves WHICH permission is the gate.
-- The transaction is rolled back, so the seeds are untouched on disk.

-- First, the mapping is what the milestone assumed: only RETAILER_OWNER holds it.
select is(
  (select array_agg(r.code::text order by r.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RETAILER_STAFF_SHOP_ASSIGN'),
  array['RETAILER_OWNER'],
  'RETAILER_STAFF_SHOP_ASSIGN is mapped to RETAILER_OWNER and to no other role');

create temp table saved_perms as
  select rp.role_id, rp.permission_id, p.code
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  join public.roles r on r.id = rp.role_id
  where r.code = 'RETAILER_OWNER'
    and p.code in ('RETAILER_STAFF_SHOP_ASSIGN', 'RETAILER_STAFF_MANAGE', 'RETAILER_STAFF_READ');

select is((select count(*) from saved_perms), 3::bigint,
  'RETAILER_OWNER is seeded with all three staff permissions — the starting point');

select pg_temp.act_as(pg_temp.fx('owner_1'));

-- Remove ONLY RETAILER_STAFF_SHOP_ASSIGN. MANAGE and READ stay.
delete from public.role_permissions rp
using public.permissions p, public.roles r
where rp.permission_id = p.id and rp.role_id = r.id
  and r.code = 'RETAILER_OWNER' and p.code = 'RETAILER_STAFF_SHOP_ASSIGN';

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), array[pg_temp.fx('bravo')])),
  '42501',
  'without RETAILER_STAFF_SHOP_ASSIGN, the assignment write is refused');

-- RETAILER_STAFF_MANAGE ALONE DOES NOT GRANT SHOP ASSIGNMENT. The caller still holds it,
-- and still cannot assign — while the operation MANAGE really does gate still works. This
-- is what makes "the two permissions are distinct" a fact rather than a claim.
select is(
  pg_temp.sqlstate_of('select * from public.list_retailer_staff_invitations()'),
  null,
  'RETAILER_STAFF_MANAGE is unaffected — the invitation roster still reads');

select is(pg_temp.live_names(pg_temp.fx('m_guard')), array['Alpha Shop'],
  'the refused write changed nothing');

insert into public.role_permissions (role_id, permission_id)
select role_id, permission_id from saved_perms where code = 'RETAILER_STAFF_SHOP_ASSIGN';

-- The converse: remove RETAILER_STAFF_MANAGE and keep SHOP_ASSIGN. The write must still
-- work, because it is NOT gated on MANAGE. A client that assumed one staff-management
-- permission covered everything would break exactly here.
delete from public.role_permissions rp
using public.permissions p, public.roles r
where rp.permission_id = p.id and rp.role_id = r.id
  and r.code = 'RETAILER_OWNER' and p.code = 'RETAILER_STAFF_MANAGE';

select is(pg_temp.set_shops(pg_temp.fx('m_guard'), array[pg_temp.fx('alpha')]),
  array[0, 0, 1],
  'RETAILER_STAFF_SHOP_ASSIGN alone is sufficient — RETAILER_STAFF_MANAGE is not required');

select is(
  pg_temp.sqlstate_of('select * from public.list_retailer_staff_invitations()'),
  '42501',
  'while the invitation roster that DOES need RETAILER_STAFF_MANAGE is now refused');

insert into public.role_permissions (role_id, permission_id)
select role_id, permission_id from saved_perms where code = 'RETAILER_STAFF_MANAGE';


-- ============================================================================
-- SECTION D — caller authorization
-- ============================================================================
-- Every refusal below is 42501, and every one leaves the table untouched.

select pg_temp.sign_out();
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), array[pg_temp.fx('bravo')])),
  '42501', 'an anonymous caller cannot set shop assignments');

select pg_temp.act_as(pg_temp.fx('manager_1'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), array[pg_temp.fx('bravo')])),
  '42501', 'a Retailer Manager cannot set shop assignments — read-only by mapping');

select pg_temp.act_as(pg_temp.fx('u_caller'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), array[pg_temp.fx('bravo')])),
  '42501', 'a Sales Staff member cannot set another member''s shop assignments');
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_caller'), array[pg_temp.fx('bravo')])),
  '42501', 'and a Sales Staff member cannot set their OWN shop assignments either');

select pg_temp.act_as(pg_temp.fx('vendor_admin'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), array[pg_temp.fx('bravo')])),
  '42501', 'a Vendor Super Admin cannot manage Retailer staff shops');

-- A DIFFERENT Retailer's Owner, addressing this Retailer's staff and shops. Both ids are
-- real; neither is theirs.
select pg_temp.act_as(pg_temp.fx('owner_2'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), array[pg_temp.fx('bravo')])),
  '42501', 'another Retailer''s Owner cannot target this Retailer''s staff');

-- The SUSPENDED Retailer. Its Owner is refused with 42501, NOT 55000: the resolver
-- requires an ACTIVE organization and fires long before the 55000 re-check, which exists
-- only for an organization suspended between the two. Documented here because a client
-- reading for 55000 would never see it on this path.
select pg_temp.act_as(pg_temp.fx('owner_3'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_r3'), array[pg_temp.fx('r3shop')])),
  '42501',
  'the Owner of a SUSPENDED Retailer is refused — and with 42501 from the resolver, not 55000');

-- None of the six refusals wrote anything.
select is(pg_temp.live_names(pg_temp.fx('m_guard')), array['Alpha Shop'],
  'not one of the caller refusals changed an assignment');
select is(pg_temp.audit_count(pg_temp.fx('m_guard')), 0::bigint,
  'and not one of them wrote an audit row');


-- ============================================================================
-- SECTION E — target validation
-- ============================================================================
-- Every refusal here is ALSO 42501 and carries the SAME message as a caller refusal, so a
-- caller cannot tell "that membership is not yours" from "you may not do this at all",
-- and cannot sweep ids to discover which ones exist in some other tenant.

select pg_temp.act_as(pg_temp.fx('owner_1'));

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(null, array[pg_temp.fx('bravo')])),
  '42501', 'a NULL membership id is refused');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('nowhere'), array[pg_temp.fx('bravo')])),
  '42501', 'a membership id that names nothing is refused');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_manager_1'), array[pg_temp.fx('bravo')])),
  '42501', 'a RETAILER_MANAGER target is refused — Managers are retailer-wide by role');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_owner_1'), array[pg_temp.fx('bravo')])),
  '42501', 'a RETAILER_OWNER target is refused — including the caller''s own membership');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_frozen'), array[pg_temp.fx('bravo')])),
  '42501', 'a SUSPENDED Sales Staff membership is refused — manageable means ACTIVE');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_foreign'), array[pg_temp.fx('zulu')])),
  '42501', 'another Retailer''s Sales Staff member is refused');

-- THE FOUR REFUSALS ARE INDISTINGUISHABLE. Same SQLSTATE and same message for "unknown",
-- "not yours", "wrong role" and "inactive" — which is the property that makes id sweeping
-- useless.
select is(
  (select count(distinct m) from unnest(array[
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('nowhere'),     array[pg_temp.fx('bravo')])),
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_manager_1'), array[pg_temp.fx('bravo')])),
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_frozen'),    array[pg_temp.fx('bravo')])),
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_foreign'),   array[pg_temp.fx('zulu')]))
   ]) m),
  1::bigint,
  'unknown, wrong-role, inactive and cross-tenant targets are refused with one identical message');

-- Nothing was written to any of them.
select is(pg_temp.live_names(pg_temp.fx('m_manager_1')), '{}'::text[],
  'the Manager still holds no assignment');
select is(pg_temp.live_names(pg_temp.fx('m_frozen')), array['Alpha Shop'],
  'the suspended member''s assignment is untouched');
select is(pg_temp.live_names(pg_temp.fx('m_foreign')), array['Zulu Shop'],
  'the other Retailer''s member is untouched');


-- ============================================================================
-- SECTION F — shop-set validation
-- ============================================================================
-- All 23514: these are malformed or ineligible INPUT, not authorization failures, and a
-- client must be able to tell the two apart to decide whether to re-render the form or
-- send the user away.

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_zero'), '{}'::uuid[])),
  '23514', 'an EMPTY shop list is refused — Sales Staff must keep at least one shop');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_zero'), null)),
  '23514', 'a NULL shop array is refused, identically to an empty one');

select is(
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_zero'), '{}'::uuid[])),
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_zero'), null)),
  'and both carry the same message — null and empty are one zero-shop input');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_zero'),
    array[pg_temp.fx('bravo'), null]::uuid[])),
  '23514', 'a NULL element inside the array is refused');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_zero'), array[pg_temp.fx('sierra')])),
  '23514', 'a SUSPENDED shop cannot be requested');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_zero'), array[pg_temp.fx('yankee')])),
  '23514', 'a DEACTIVATED shop cannot be requested');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_zero'), array[pg_temp.fx('zulu')])),
  '23514', 'another Retailer''s shop cannot be requested');

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_zero'), array[pg_temp.fx('nowhere')])),
  '23514', 'a shop id that names nothing cannot be requested');

-- AN UNKNOWN SHOP AND ANOTHER RETAILER'S SHOP ARE INDISTINGUISHABLE, so a caller cannot
-- probe another Retailer's estate one id at a time.
select is(
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_zero'), array[pg_temp.fx('zulu')])),
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_zero'), array[pg_temp.fx('nowhere')])),
  'a foreign shop and a nonexistent shop are refused with one identical message');

-- A MALFORMED UUID never reaches the function at all — PostgreSQL rejects the cast first.
-- Asserted so the taxonomy is complete: a client sees 22P02, not 23514.
select is(
  pg_temp.sqlstate_of(
    'select * from public.set_retailer_staff_shop_assignments(''not-a-uuid''::uuid, ''{}''::uuid[])'),
  '22P02', 'a malformed UUID is rejected by the type system before the function runs');

select is(pg_temp.live_names(pg_temp.fx('m_zero')), array['Alpha Shop'],
  'none of the shop-set refusals changed an assignment');
select is(pg_temp.audit_count(pg_temp.fx('m_zero')), 0::bigint,
  'and none of them wrote an audit row');


-- ============================================================================
-- SECTION G — the three replacement shapes
-- ============================================================================

-- G1. ONE SHOP -> MANY. The existing assignment is kept, not rewritten.
select is(pg_temp.live_names(pg_temp.fx('m_grow')), array['Alpha Shop'],
  'grow: starts on one shop');

create temp table grow_before as
  select pg_temp.live_version(pg_temp.fx('m_grow'), pg_temp.fx('alpha')) as v;

select is(
  pg_temp.set_shops(pg_temp.fx('m_grow'),
    array[pg_temp.fx('alpha'), pg_temp.fx('bravo'), pg_temp.fx('charlie')]),
  array[2, 0, 1],
  'grow: {A} -> {A,B,C} reports 2 added, 0 removed, 1 unchanged');

select is(pg_temp.live_names(pg_temp.fx('m_grow')),
  array['Alpha Shop', 'Bravo Shop', 'Charlie Shop'],
  'grow: the live set is exactly the requested set');

-- THE UNCHANGED ROW WAS NOT REWRITTEN. ctid is the witness: any UPDATE that touched this
-- row would have moved it. This is what preserves the original assigned_at — the record
-- of when this person actually started at this shop — across an unrelated edit.
select is(
  pg_temp.live_version(pg_temp.fx('m_grow'), pg_temp.fx('alpha')),
  (select v from grow_before),
  'grow: the kept assignment''s physical row is untouched — assigned_at survives');

select is(pg_temp.retired_names(pg_temp.fx('m_grow')), '{}'::text[],
  'grow: nothing was retired');

-- G2. REMOVE ONE OF SEVERAL.
select is(pg_temp.live_names(pg_temp.fx('m_shrink')),
  array['Alpha Shop', 'Bravo Shop', 'Charlie Shop'], 'shrink: starts on three shops');

select is(
  pg_temp.set_shops(pg_temp.fx('m_shrink'),
    array[pg_temp.fx('alpha'), pg_temp.fx('charlie')]),
  array[0, 1, 2],
  'shrink: dropping one reports 0 added, 1 removed, 2 unchanged');

select is(pg_temp.live_names(pg_temp.fx('m_shrink')), array['Alpha Shop', 'Charlie Shop'],
  'shrink: only the requested two are live');

-- RETIRED, NOT DELETED. The row is still there, and it now carries removed_at.
select is(pg_temp.retired_names(pg_temp.fx('m_shrink')), array['Bravo Shop'],
  'shrink: the dropped assignment is RETIRED, not deleted');
select ok(pg_temp.removed_at_of(pg_temp.fx('m_shrink'), pg_temp.fx('bravo')) is not null,
  'shrink: the retired row carries a removed_at timestamp');
select is(pg_temp.row_count(pg_temp.fx('m_shrink'), pg_temp.fx('bravo')), 1::bigint,
  'shrink: and the row still exists — retirement never destroys history');

-- G3. REPLACE ALL. No shop in common between the old set and the new one.
select is(pg_temp.live_names(pg_temp.fx('m_swap')), array['Alpha Shop', 'Bravo Shop'],
  'swap: starts on A and B');

select is(
  pg_temp.set_shops(pg_temp.fx('m_swap'),
    array[pg_temp.fx('charlie'), pg_temp.fx('delta')]),
  array[2, 2, 0],
  'swap: a complete replacement reports 2 added, 2 removed, 0 unchanged');

select is(pg_temp.live_names(pg_temp.fx('m_swap')), array['Charlie Shop', 'Delta Shop'],
  'swap: the live set is exactly the new one');
select is(pg_temp.retired_names(pg_temp.fx('m_swap')), array['Alpha Shop', 'Bravo Shop'],
  'swap: both old assignments are retired');
select is(pg_temp.live_row_count(pg_temp.fx('m_swap')), 2::bigint,
  'swap: exactly two live rows remain');


-- ============================================================================
-- SECTION H — R-1: live assignments to NON-ACTIVE shops are preserved
-- ============================================================================
-- THE SINGLE MOST CONSEQUENTIAL BEHAVIOUR IN THIS CONTRACT, and the reason replacement is
-- scoped rather than total.
--
-- list_retailer_staff_members() filters shop_ids/shop_names to `s.status = 'ACTIVE'`, so a
-- live assignment to a SUSPENDED or DEACTIVATED shop is INVISIBLE to every client. A
-- client that faithfully round-trips what it read is therefore ALWAYS omitting those
-- shops — not because the Owner decided to, but because the Owner was never shown them.
-- If omission implied retirement, using the UI correctly would silently destroy them, and
-- this table has no restore.

select is(pg_temp.live_names(pg_temp.fx('m_hidden')),
  array['Alpha Shop', 'Sierra Shop', 'Yankee Shop'],
  'hidden: the table holds three live assignments — one ACTIVE, one SUSPENDED, one DEACTIVATED');

select is(pg_temp.live_active_names(pg_temp.fx('m_hidden')), array['Alpha Shop'],
  'hidden: but the roster projection shows only the ACTIVE one');

-- The Owner sees {Alpha} and asks for {Alpha, Bravo}. Sierra and Yankee are absent from
-- the request only because they were absent from the roster.
select is(
  pg_temp.set_shops(pg_temp.fx('m_hidden'),
    array[pg_temp.fx('alpha'), pg_temp.fx('bravo')]),
  array[1, 0, 1],
  'hidden: adding one shop reports 1 added, 0 removed, 1 unchanged — the invisible two are in NO count');

select is(pg_temp.live_names(pg_temp.fx('m_hidden')),
  array['Alpha Shop', 'Bravo Shop', 'Sierra Shop', 'Yankee Shop'],
  'hidden: BOTH non-ACTIVE assignments survive untouched');

select is(pg_temp.retired_names(pg_temp.fx('m_hidden')), '{}'::text[],
  'hidden: nothing was retired — the client''s blind spot destroyed nothing');

-- And they stay preserved through a replacement that retires a VISIBLE shop, which is the
-- case that would expose a scoping mistake most sharply.
select is(
  pg_temp.set_shops(pg_temp.fx('m_hidden'), array[pg_temp.fx('bravo')]),
  array[0, 1, 1],
  'hidden: retiring the visible Alpha reports 0 added, 1 removed, 1 unchanged');
select is(pg_temp.live_names(pg_temp.fx('m_hidden')),
  array['Bravo Shop', 'Sierra Shop', 'Yankee Shop'],
  'hidden: Alpha is gone; Sierra and Yankee are still live');
select is(pg_temp.retired_names(pg_temp.fx('m_hidden')), array['Alpha Shop'],
  'hidden: and only the visible shop was retired');

-- The zero-shop rule is evaluated over the REQUESTED (active) set, not over the whole
-- table. A member whose only live rows are invisible still cannot be emptied.
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_hidden'), '{}'::uuid[])),
  '23514',
  'hidden: an empty request is still refused even though two invisible assignments exist');


-- ============================================================================
-- SECTION I — idempotency, duplicates, and history
-- ============================================================================

-- I1. AN IDENTICAL REQUEST IS A NO-OP THAT WRITES NOTHING AT ALL.
select is(pg_temp.live_names(pg_temp.fx('m_idem')), array['Alpha Shop', 'Bravo Shop'],
  'idem: starts on A and B');

select is(
  pg_temp.set_shops(pg_temp.fx('m_idem'), array[pg_temp.fx('alpha'), pg_temp.fx('bravo')]),
  array[0, 0, 2],
  'idem: an identical request reports 0 added, 0 removed, 2 unchanged');

-- NO AUDIT ROW. A no-op is not an event; an audit trail that logs one per double-tap is a
-- trail nobody can read. This matches reserve_retailer_staff_invitation's resend path,
-- which likewise writes no second RESERVED row.
select is(pg_temp.audit_count(pg_temp.fx('m_idem')), 0::bigint,
  'idem: and writes NO audit row — a no-op is not an event');

-- Physically untouched, both rows.
create temp table idem_before as
  select pg_temp.live_version(pg_temp.fx('m_idem'), pg_temp.fx('alpha')) as va,
         pg_temp.live_version(pg_temp.fx('m_idem'), pg_temp.fx('bravo')) as vb;

select pg_temp.set_shops(pg_temp.fx('m_idem'), array[pg_temp.fx('alpha'), pg_temp.fx('bravo')]);
select pg_temp.set_shops(pg_temp.fx('m_idem'), array[pg_temp.fx('alpha'), pg_temp.fx('bravo')]);

select is(
  array[pg_temp.live_version(pg_temp.fx('m_idem'), pg_temp.fx('alpha')),
        pg_temp.live_version(pg_temp.fx('m_idem'), pg_temp.fx('bravo'))],
  (select array[va, vb] from idem_before),
  'idem: three identical requests moved neither physical row');
select is(pg_temp.audit_count(pg_temp.fx('m_idem')), 0::bigint,
  'idem: and still no audit row after three repeats');
select is(pg_temp.live_row_count(pg_temp.fx('m_idem')), 2::bigint,
  'idem: still exactly two live rows — no duplicate was created');

-- I2. DUPLICATES ARE CANONICALIZED. {A, A, B} means {A, B}: no duplicate row, no refusal.
select is(pg_temp.live_names(pg_temp.fx('m_dup')), array['Alpha Shop'], 'dup: starts on A');

select is(
  pg_temp.set_shops(pg_temp.fx('m_dup'),
    array[pg_temp.fx('alpha'), pg_temp.fx('alpha'), pg_temp.fx('bravo')]),
  array[1, 0, 1],
  'dup: {A,A,B} reports 1 added, 0 removed, 1 unchanged — the repeat is collapsed, not counted twice');

select is(pg_temp.live_names(pg_temp.fx('m_dup')), array['Alpha Shop', 'Bravo Shop'],
  'dup: the live set is {A,B}');
select is(pg_temp.live_row_count(pg_temp.fx('m_dup')), 2::bigint,
  'dup: exactly two live rows — the duplicate produced no second row');

-- A repeated id for a shop that is NOT yet assigned must also collapse to one insert.
select is(
  pg_temp.set_shops(pg_temp.fx('m_dup'),
    array[pg_temp.fx('charlie'), pg_temp.fx('charlie'), pg_temp.fx('charlie')]),
  array[1, 2, 0],
  'dup: {C,C,C} adds Charlie exactly once and retires the other two');
select is(pg_temp.row_count(pg_temp.fx('m_dup'), pg_temp.fx('charlie')), 1::bigint,
  'dup: exactly one Charlie row exists');

-- I3. RE-ADDING A REMOVED SHOP INSERTS A NEW ROW; HISTORY ACCUMULATES.
select is(pg_temp.live_names(pg_temp.fx('m_hist')), array['Alpha Shop', 'Bravo Shop'],
  'hist: starts on A and B');

select pg_temp.set_shops(pg_temp.fx('m_hist'), array[pg_temp.fx('alpha')]);
select is(pg_temp.retired_names(pg_temp.fx('m_hist')), array['Bravo Shop'],
  'hist: B is retired');
select is(pg_temp.row_count(pg_temp.fx('m_hist'), pg_temp.fx('bravo')), 1::bigint,
  'hist: one B row exists, and it is the retired one');

select is(
  pg_temp.set_shops(pg_temp.fx('m_hist'), array[pg_temp.fx('alpha'), pg_temp.fx('bravo')]),
  array[1, 0, 1],
  'hist: re-adding B reports it as ADDED, not as unchanged');

-- TWO ROWS, NOT ONE. A resurrected row would have erased the fact that this person was
-- ever off this shop; a new row records both the departure and the return.
select is(pg_temp.row_count(pg_temp.fx('m_hist'), pg_temp.fx('bravo')), 2::bigint,
  'hist: re-adding INSERTED A NEW ROW — the retired one was not resurrected');
select is(
  (select count(*) from public.retailer_shop_members sm
   where sm.organization_member_id = pg_temp.fx('m_hist')
     and sm.retailer_shop_id = pg_temp.fx('bravo')
     and sm.removed_at is not null),
  1::bigint,
  'hist: the historical retired row is still on record with its removed_at intact');
select is(pg_temp.live_names(pg_temp.fx('m_hist')), array['Alpha Shop', 'Bravo Shop'],
  'hist: and exactly one live B row results');

-- The live-unique index still forbids a second live row for the same pairing. Attempted
-- directly, because the function can no longer produce one.
select is(
  pg_temp.sqlstate_of(format(
    'insert into public.retailer_shop_members (organization_member_id, retailer_shop_id) values (%L::uuid, %L::uuid)',
    pg_temp.fx('m_hist'), pg_temp.fx('bravo'))),
  '23505',
  'hist: a second LIVE row for the same (member, shop) is still rejected by the unique index');


-- ============================================================================
-- SECTION J — atomicity and audit
-- ============================================================================

-- J1. ONE INVALID SHOP ROLLS BACK THE WHOLE REPLACEMENT.
select is(pg_temp.live_names(pg_temp.fx('m_roll')), array['Alpha Shop', 'Bravo Shop'],
  'roll: starts on A and B');

create temp table roll_before as
  select pg_temp.live_version(pg_temp.fx('m_roll'), pg_temp.fx('alpha')) as va,
         pg_temp.live_version(pg_temp.fx('m_roll'), pg_temp.fx('bravo')) as vb;

-- A request that is valid in every respect EXCEPT one shop: it would have retired Bravo,
-- kept Alpha, and added Charlie. All three must be abandoned together.
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_roll'),
    array[pg_temp.fx('alpha'), pg_temp.fx('charlie'), pg_temp.fx('zulu')])),
  '23514',
  'roll: one foreign shop among three valid ones refuses the whole request');

select is(pg_temp.live_names(pg_temp.fx('m_roll')), array['Alpha Shop', 'Bravo Shop'],
  'roll: NOTHING was applied — not the addition, not the retirement');
select is(pg_temp.retired_names(pg_temp.fx('m_roll')), '{}'::text[],
  'roll: no row was retired');
select is(
  array[pg_temp.live_version(pg_temp.fx('m_roll'), pg_temp.fx('alpha')),
        pg_temp.live_version(pg_temp.fx('m_roll'), pg_temp.fx('bravo'))],
  (select array[va, vb] from roll_before),
  'roll: neither physical row was touched');
select is(pg_temp.audit_count(pg_temp.fx('m_roll')), 0::bigint,
  'roll: and no audit row was written');

-- The same request WITHOUT the invalid shop succeeds, proving the refusal was about that
-- shop and not about something else in the request.
select is(
  pg_temp.set_shops(pg_temp.fx('m_roll'),
    array[pg_temp.fx('alpha'), pg_temp.fx('charlie')]),
  array[1, 1, 1],
  'roll: the same request minus the foreign shop succeeds');

-- J2. THE AUDIT ROW.
select is(pg_temp.audit_count(pg_temp.fx('m_audit')), 0::bigint,
  'audit: no audit row exists before the write');

select is(
  pg_temp.set_shops(pg_temp.fx('m_audit'),
    array[pg_temp.fx('bravo'), pg_temp.fx('charlie')]),
  array[2, 1, 0],
  'audit: {A} -> {B,C} reports 2 added, 1 removed, 0 unchanged');

select is(pg_temp.audit_count(pg_temp.fx('m_audit')), 1::bigint,
  'audit: EXACTLY ONE audit row was written');

select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).action, 'STAFF_SHOP_ASSIGNMENTS_UPDATED',
  'audit: the action code is STAFF_SHOP_ASSIGNMENTS_UPDATED');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).entity_type, 'RETAILER_STAFF_MEMBER',
  'audit: the entity type is RETAILER_STAFF_MEMBER');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).entity_id, pg_temp.fx('m_audit')::text,
  'audit: the entity id is the target MEMBERSHIP id');

-- organization_id is the RETAILER's, which is what keeps this entry out of
-- list_vendor_audit_logs — that function filters on the caller's own Vendor organization.
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).organization_id, pg_temp.fx('r1'),
  'audit: organization_id is the Retailer''s — invisible to every Vendor audit reader');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).actor_profile_id, pg_temp.fx('owner_1'),
  'audit: actor_profile_id is the acting Owner');

-- The before/after picture, in counts and display names.
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata -> 'shop_count_before', '1'::jsonb,
  'audit: shop_count_before is the ACTIVE-projection count before the write');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata -> 'shop_count_after', '2'::jsonb,
  'audit: shop_count_after is the count after it');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata -> 'shops_added',
  '["Bravo Shop", "Charlie Shop"]'::jsonb,
  'audit: shops_added names the shops, in a deterministic order');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata -> 'shops_removed',
  '["Alpha Shop"]'::jsonb,
  'audit: shops_removed names the shops');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata ->> 'role_code', 'SALES_STAFF',
  'audit: the role code recorded is the one the function PROVED, not one it was handed');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata ->> 'membership_status', 'ACTIVE',
  'audit: likewise the membership status');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata ->> 'retailer_name', 'Retailer One',
  'audit: the Retailer name is a display value, resolved server-side');

-- NOTHING UNSAFE IS IN THE METADATA. No uuid of any kind — not a shop id, not a membership
-- id, not a profile or Auth id — and no email, token, hash or delivery field. The
-- membership id lives in entity_id, which the reader already has authority over.
select ok(
  (pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata::text
    !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  'audit: the metadata contains NO uuid of any kind');
select ok(
  (pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata::text !~* 'email|token|hash|secret|password|@',
  'audit: the metadata contains no email, token, hash or secret');

-- The exact key set, so a later edit cannot quietly add a field.
select is(
  (select array_agg(k order by k)
   from jsonb_object_keys((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata) k),
  array['membership_status', 'retailer_name', 'role_code', 'shop_count_after',
        'shop_count_before', 'shops_added', 'shops_removed'],
  'audit: the metadata carries exactly seven keys and no others');

-- ip_address and user_agent are left null: this function cannot observe them truthfully.
select ok((pg_temp.last_audit(pg_temp.fx('m_audit'))).ip_address is null,
  'audit: ip_address is null — the function cannot observe it truthfully');
select ok((pg_temp.last_audit(pg_temp.fx('m_audit'))).user_agent is null,
  'audit: user_agent is null');

-- A SECOND, DIFFERENT request writes a SECOND audit row. Only no-ops are silent.
select pg_temp.set_shops(pg_temp.fx('m_audit'), array[pg_temp.fx('bravo')]);
select is(pg_temp.audit_count(pg_temp.fx('m_audit')), 2::bigint,
  'audit: a second CHANGING request writes a second audit row');
select pg_temp.set_shops(pg_temp.fx('m_audit'), array[pg_temp.fx('bravo')]);
select is(pg_temp.audit_count(pg_temp.fx('m_audit')), 2::bigint,
  'audit: but repeating it writes no third — only changes are recorded');


-- ============================================================================
-- SECTION K — direct table access stays denied
-- ============================================================================
-- The RPC is not "the recommended way in", it is the ONLY way in. Asserted by actually
-- attempting each statement as the browser role, which is stronger than reading a grant.
--
-- The fixture table has to be readable by `authenticated` for the duration, because the
-- statements below are assembled from it AFTER the role switch. This grants access to a
-- pg_temp table of test uuids and to nothing else — no privilege on any public table is
-- granted anywhere in this file, which is exactly what the four assertions below prove.
grant select on pg_temp.fx to authenticated;

set local role authenticated;

select is(
  pg_temp.sqlstate_of(format(
    'insert into public.retailer_shop_members (organization_member_id, retailer_shop_id) values (%L::uuid, %L::uuid)',
    pg_temp.fx('m_guard'), pg_temp.fx('delta'))),
  '42501', 'authenticated cannot INSERT into retailer_shop_members directly');

select is(
  pg_temp.sqlstate_of(format(
    'update public.retailer_shop_members set removed_at = now() where organization_member_id = %L::uuid',
    pg_temp.fx('m_guard'))),
  '42501', 'authenticated cannot UPDATE retailer_shop_members directly');

select is(
  pg_temp.sqlstate_of(format(
    'delete from public.retailer_shop_members where organization_member_id = %L::uuid',
    pg_temp.fx('m_guard'))),
  '42501', 'authenticated cannot DELETE from retailer_shop_members directly');

select is(
  pg_temp.sqlstate_of('select count(*) from public.retailer_shop_members'),
  '42501', 'authenticated cannot even SELECT from retailer_shop_members');

-- And it cannot reach the internal resolver the function authorizes through, which is
-- granted to no browser role at all.
select is(
  pg_temp.sqlstate_of(
    'select public.resolve_retailer_member_organization(''RETAILER_STAFF_SHOP_ASSIGN'')'),
  '42501', 'authenticated cannot call the internal authorization resolver');

reset role;

select is(pg_temp.live_names(pg_temp.fx('m_guard')), array['Alpha Shop'],
  'and none of those direct attempts changed a row');


-- ============================================================================
-- SECTION L — concurrency, as far as one transaction can prove it
-- ============================================================================
-- HONEST LIMITATION, STATED RATHER THAN PAPERED OVER: two genuinely concurrent sessions
-- cannot be exercised from inside a single pgTAP transaction, so the FOR UPDATE / FOR
-- SHARE mechanism is asserted structurally in Section A and its OBSERVABLE consequences
-- are asserted here. What a real second session would add is proof that the lock BLOCKS;
-- what is proved below is that the function recomputes from committed state every time,
-- which is what makes blocking sufficient.

select pg_temp.act_as(pg_temp.fx('owner_1'));

-- LAST WRITE WINS, AND EACH CALL RECOMPUTES FROM THE TABLE. A sequence of requests that a
-- stale client might send produces the state of the LAST one, never a merge of them and
-- never a partial application.
select pg_temp.set_shops(pg_temp.fx('m_caller'), array[pg_temp.fx('alpha'), pg_temp.fx('bravo')]);
select pg_temp.set_shops(pg_temp.fx('m_caller'), array[pg_temp.fx('charlie')]);
select is(
  pg_temp.set_shops(pg_temp.fx('m_caller'), array[pg_temp.fx('alpha')]),
  array[1, 1, 0],
  'serial: each call diffs against the CURRENT table, not against the caller''s last request');
select is(pg_temp.live_names(pg_temp.fx('m_caller')), array['Alpha Shop'],
  'serial: the final state is exactly the last request');

-- A SECOND OWNER OF THE SAME RETAILER gets identical treatment — the function derives the
-- Retailer per call and holds no caller-specific state between them. (The resolver admits
-- a caller only when EXACTLY ONE Retailer qualifies, so this is also the check that a
-- second Owner does not somehow resolve to zero.)
select pg_temp.staff(pg_temp.fx('owner_1b'), pg_temp.fx('r1'), 'RETAILER_OWNER');
select pg_temp.act_as(pg_temp.fx('owner_1b'));
select is(
  pg_temp.set_shops(pg_temp.fx('m_caller'), array[pg_temp.fx('bravo')]),
  array[1, 1, 0],
  'serial: a second Owner of the same Retailer may take over mid-sequence — last write wins');
select is(pg_temp.live_names(pg_temp.fx('m_caller')), array['Bravo Shop'],
  'serial: and their request is the one that stands');

-- A MULTI-RETAILER CALLER RESOLVES TO NOTHING. The resolver fails closed on two or more
-- qualifying Retailers, so an Owner of two Retailers cannot act on either until an
-- organization switcher exists. Asserted here because it is the one authorization outcome
-- that depends on the caller having MORE access, not less.
select pg_temp.staff(pg_temp.fx('owner_1b'), pg_temp.fx('r2'), 'RETAILER_OWNER');
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_caller'), array[pg_temp.fx('alpha')])),
  '42501',
  'a caller who owns TWO Retailers resolves to neither and is refused — fail closed');
select is(pg_temp.live_names(pg_temp.fx('m_caller')), array['Bravo Shop'],
  'and that refusal changed nothing');


-- ============================================================================
-- SECTION M — the roster agrees with the table after every write
-- ============================================================================
-- The write and the read must describe the same world, or a client will render a set the
-- database does not hold. Checked through the SHIPPED read rather than through a
-- hand-written query, so a divergence in either one fails here.

select pg_temp.act_as(pg_temp.fx('owner_1'));

select is(
  (select m.shop_names from public.list_retailer_staff_members() m
   where m.membership_id = pg_temp.fx('m_swap')),
  array['Charlie Shop', 'Delta Shop'],
  'roster: the swapped member''s shop_names match the table');

-- And for the R-1 member, the roster still shows ONLY the ACTIVE shop — the two preserved
-- assignments remain invisible, exactly as they were before the write.
select is(
  (select m.shop_names from public.list_retailer_staff_members() m
   where m.membership_id = pg_temp.fx('m_hidden')),
  array['Bravo Shop'],
  'roster: the preserved non-ACTIVE assignments are still invisible to the client');

-- The membership id the roster returns IS the id the write accepts. This is the whole
-- client contract in one assertion: no second identifier, no lookup, no translation.
select is(
  pg_temp.set_shops(
    (select m.membership_id from public.list_retailer_staff_members() m
     where m.membership_id = pg_temp.fx('m_grow')),
    array[pg_temp.fx('alpha')]),
  array[0, 2, 1],
  'roster: membership_id taken straight from the roster is a valid write target');

select finish();

rollback;
