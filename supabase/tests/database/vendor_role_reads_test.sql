-- pgTAP behavioural tests for the three Vendor Role reads added by
-- migration 20260802090000_mobile_vendor_role_reads.sql:
--
--   public.list_vendor_roles()
--   public.get_vendor_role_detail(uuid)
--   public.list_vendor_role_permissions(uuid)
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as
-- the `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as
-- far as every authorization helper in this schema is concerned. pg_temp.act_as() does
-- exactly that and pg_temp.sign_out() clears it. This mirrors portal_context_test.sql,
-- sales_staff_receipt_reads_test.sql, vendor_retailer_reads_test.sql and
-- vendor_user_reads_test.sql exactly, deliberately: five different impersonation idioms in
-- one suite directory would be five different claims about what "signed in" means.
--
-- The tests deliberately do NOT `set role authenticated`. All three functions are SECURITY
-- DEFINER, so their behaviour depends on auth.uid() and not on the session role, and
-- switching roles mid-transaction would only make the fixture inserts fail. EXECUTE
-- privilege is a separate concern and is asserted directly against the catalogue in
-- Section A, which is a stronger check than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back, so no fixture survives — not
-- the two extra role definitions inserted below, and not Section L, which temporarily
-- removes seeded role→permission mappings.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file
-- turns an added test into a confusing failure about arithmetic rather than about
-- behaviour.
--
-- ============================================================================
-- WHAT "DENIED" MEANS HERE, AND WHY THE TWO KINDS DIFFER
-- ============================================================================
-- All three functions RAISE 42501 for a caller who is not an authorized Vendor Super Admin
-- holding the required permissions. A denial and "this role grants no permissions" are
-- different facts.
--
-- get_vendor_role_detail() and list_vendor_role_permissions() additionally return ZERO
-- ROWS — never a raise — for an authorized Vendor who names an id that is not a role.
-- Section I proves an unknown uuid, an id belonging to another table, and null are
-- byte-identical.
--
-- ============================================================================
-- THE ROLE CATALOGUE IS GLOBAL, AND THESE TESTS ASSERT THAT RATHER THAN WISH IT AWAY
-- ============================================================================
-- public.roles, public.permissions and public.role_permissions carry no organization_id
-- (Section B proves this against information_schema rather than trusting the comment). So
-- there is no "Vendor B's role" for Vendor A to be refused: both Vendors read the same rows.
-- The tenant boundary in this contract is assigned_member_count, which is scoped to the
-- CALLING Vendor's own memberships — Section H proves Vendor A and Vendor B read identical
-- role rows with different counts, in both directions.

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

/* The catalogue id of a role, by code. Never returned by any contract function — the tests
   need it only to address a fixture and to prove the contract's own ids are the same ones. */
create function pg_temp.role_id(p_code text) returns uuid
language sql stable as $$
  select r.id from public.roles r where r.code = p_code;
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
 * there" comparisons Sections I and J need, and comparing SQLSTATEs is what makes "these
 * two answers are indistinguishable" a testable claim rather than a comment.
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
 * The role names visible to the current caller, IN THE FUNCTION'S OWN ORDER.
 *
 * row_number() over () numbers rows in the order they arrive from the function, and the
 * aggregate then sorts by that number — so this captures what the function emitted rather
 * than re-sorting it. Aggregating `order by role_name` would sort the evidence into
 * agreement with the assertion.
 */
create function pg_temp.my_role_names() returns text[]
language sql as $$
  select coalesce(array_agg(t.role_name order by t.ord), '{}'::text[])
  from (
    select l.role_name, row_number() over () as ord
    from public.list_vendor_roles() l
  ) t;
$$;

/* Single columns of the list, keyed by role name. */
create function pg_temp.list_status(p_name text) returns text
language sql as $$
  select l.role_status from public.list_vendor_roles() l where l.role_name = p_name;
$$;

create function pg_temp.list_description(p_name text) returns text
language sql as $$
  select l.role_description from public.list_vendor_roles() l where l.role_name = p_name;
$$;

create function pg_temp.list_permission_count(p_name text) returns integer
language sql as $$
  select l.permission_count from public.list_vendor_roles() l where l.role_name = p_name;
$$;

create function pg_temp.list_member_count(p_name text) returns integer
language sql as $$
  select l.assigned_member_count from public.list_vendor_roles() l where l.role_name = p_name;
$$;

create function pg_temp.list_role_id(p_name text) returns uuid
language sql as $$
  select l.role_id from public.list_vendor_roles() l where l.role_name = p_name;
$$;

create function pg_temp.detail_count(p_role uuid) returns bigint
language sql as $$
  select count(*) from public.get_vendor_role_detail(p_role);
$$;

/* The permission names of one role, IN THE FUNCTION'S OWN ORDER. */
create function pg_temp.permission_names(p_role uuid) returns text[]
language sql as $$
  select coalesce(array_agg(t.permission_name order by t.ord), '{}'::text[])
  from (
    select l.permission_name, row_number() over () as ord
    from public.list_vendor_role_permissions(p_role) l
  ) t;
$$;


-- ============================================================================
-- Fixtures
-- ============================================================================
-- Deterministic: every name, status and assignment below is written explicitly. The SEEDED
-- role catalogue is used as-is and is never modified — this suite must not prove its own
-- assertions by rewriting the thing under test — with two ADDED definitions that the seeds
-- do not provide and the contract must handle: an INACTIVE role and a role with a NULL
-- description.

create table pg_temp.fx (k text primary key, v uuid);

insert into pg_temp.fx (k, v) values
  ('vendor_a', pg_temp.new_org('Vendor A')),
  ('vendor_b', pg_temp.new_org('Vendor B')),
  ('alpha',    pg_temp.new_org('Alpha Retail', 'RETAILER', 'ACTIVE'));

create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.fx where k = p_k; $$;

-- An INACTIVE role DEFINITION. The Roles catalogue must SHOW it and MARK it — the opposite
-- of list_vendor_users(), which hides an inactive definition from a user's role_names. The
-- two are consistent: one describes the definition, the other an assignment.
insert into public.roles (code, name, description, status)
values ('LEGACY_VENDOR_ROLE', 'Legacy Vendor Role', 'Retired role definition.', 'INACTIVE');

-- A role whose description is genuinely NULL. Nothing may fabricate one.
insert into public.roles (code, name, description, status)
values ('UNDESCRIBED_ROLE', 'Undescribed Role', null, 'ACTIVE');

-- People.
insert into pg_temp.fx (k, v) values
  ('ada',      pg_temp.new_person('Ada',  'Admin')),
  ('zoe',      pg_temp.new_person('Zoe',  'Multirole')),
  ('bob',      pg_temp.new_person('Bob',  'Suspended', 'SUSPENDED')),
  ('cara',     pg_temp.new_person('Cara', 'Deactivated')),
  ('dan',      pg_temp.new_person('Dan',  'Invited', 'INVITED')),
  ('eve',      pg_temp.new_person('Eve',  'Noroles')),
  ('fay',      pg_temp.new_person('Fay',  'Legacyrole')),
  -- Vendor B's people. Vendor B sees the SAME roles as Vendor A — the catalogue is
  -- global — but must never see Vendor A's assignment counts.
  ('gil',      pg_temp.new_person('Gil',  'Bravo')),
  ('hal',      pg_temp.new_person('Hal',  'Bee')),
  -- Retailer people, every one of whom must be refused.
  ('owner',    pg_temp.new_person('Ora',  'Owner')),
  ('manager',  pg_temp.new_person('Mia',  'Manager')),
  ('staff',    pg_temp.new_person('Sam',  'Staff')),
  -- Authenticated, but a member of nothing at all.
  ('no_org',   pg_temp.new_person('Ned',  'Noorg'));

insert into pg_temp.fx (k, v) values
  ('m_ada',  pg_temp.add_member(pg_temp.fx('ada'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_zoe',  pg_temp.add_member(pg_temp.fx('zoe'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  -- ACTIVE membership, SUSPENDED profile.
  ('m_bob',  pg_temp.add_member(pg_temp.fx('bob'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  -- DEACTIVATED membership of an ACTIVE profile.
  ('m_cara', pg_temp.add_member(pg_temp.fx('cara'), pg_temp.fx('vendor_a'), 'DEACTIVATED')),
  -- The only "invited/pending" state this schema has for a Vendor user.
  ('m_dan',  pg_temp.add_member(pg_temp.fx('dan'),  pg_temp.fx('vendor_a'), 'INVITED')),
  ('m_eve',  pg_temp.add_member(pg_temp.fx('eve'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_fay',  pg_temp.add_member(pg_temp.fx('fay'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_gil',  pg_temp.add_member(pg_temp.fx('gil'),  pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_hal_b', pg_temp.add_member(pg_temp.fx('hal'), pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_owner',   pg_temp.add_member(pg_temp.fx('owner'),   pg_temp.fx('alpha'), 'ACTIVE')),
  ('m_manager', pg_temp.add_member(pg_temp.fx('manager'), pg_temp.fx('alpha'), 'ACTIVE')),
  ('m_staff',   pg_temp.add_member(pg_temp.fx('staff'),   pg_temp.fx('alpha'), 'ACTIVE'));

-- Role assignments in VENDOR A. The counts these produce are stated once here and asserted
-- in Section H:
--
--   Vendor Super Admin  3  (Ada ACTIVE, Bob ACTIVE membership / SUSPENDED profile,
--                           Cara DEACTIVATED membership) — no status filter applies
--   Claim Reviewer      2  (Zoe, Dan INVITED)
--   Finance Admin       1  (Zoe — a multi-role member counts once per role, never twice
--                           in one)
--   Legacy Vendor Role  1  (Fay — an INACTIVE definition still reports its holders)
--   every other role    0  (including all three Retailer roles: their holders are in the
--                           Retailer organization, which is not this Vendor)
select pg_temp.add_role(pg_temp.fx('m_ada'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_bob'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_cara'), 'VENDOR_SUPER_ADMIN');

select pg_temp.add_role(pg_temp.fx('m_zoe'), 'FINANCE_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_zoe'), 'CLAIM_REVIEWER');
select pg_temp.add_role(pg_temp.fx('m_dan'), 'CLAIM_REVIEWER');
select pg_temp.add_role(pg_temp.fx('m_fay'), 'LEGACY_VENDOR_ROLE');
-- Eve holds no role at all.

-- Vendor B: one administrator and one Claim Reviewer, so its counts differ from Vendor A's
-- on every role that matters.
select pg_temp.add_role(pg_temp.fx('m_gil'),   'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_hal_b'), 'CLAIM_REVIEWER');

select pg_temp.add_role(pg_temp.fx('m_owner'),   'RETAILER_OWNER');
select pg_temp.add_role(pg_temp.fx('m_manager'), 'RETAILER_MANAGER');
select pg_temp.add_role(pg_temp.fx('m_staff'),   'SALES_STAFF');


-- ============================================================================
-- SECTION A — signature, security attributes and privileges (catalogue-level)
-- ============================================================================
-- Asserted against the catalogue rather than inferred from behaviour: "it did not error
-- for me" is not a privilege check, and a grant that widened by accident would still let
-- every behavioural test pass.

select has_function('public', 'list_vendor_roles', '{}'::text[],
  'list_vendor_roles() exists and takes no arguments');
select has_function('public', 'get_vendor_role_detail', array['uuid'],
  'get_vendor_role_detail(uuid) exists');
select has_function('public', 'list_vendor_role_permissions', array['uuid'],
  'list_vendor_role_permissions(uuid) exists');

-- NO IDENTITY, VENDOR, TENANT, ROLE-CODE OR PERMISSION-CODE ARGUMENT ON ANY READ.
select is(pg_temp.input_args('list_vendor_roles'), '{}'::text[],
  'list_vendor_roles() accepts no client input at all');
select is(pg_temp.input_args('get_vendor_role_detail'), array['p_role_id'],
  'get_vendor_role_detail takes exactly one input: the role selector');
select is(pg_temp.input_args('list_vendor_role_permissions'), array['p_role_id'],
  'list_vendor_role_permissions takes exactly one input: the same role selector');

-- The two selectors are the SAME parameter name and type, so the operations cannot drift
-- into two address spaces.
select is(
  pg_temp.input_args('get_vendor_role_detail'),
  pg_temp.input_args('list_vendor_role_permissions'),
  'detail and its permission companion are addressed identically');

-- Exact output shape. A positional `returns table` contract is only stable if the column
-- list is pinned, and pinning it is what makes an accidental addition a test failure rather
-- than a silently broken pinned mobile build.
select is(
  pg_temp.table_columns('list_vendor_roles'),
  array['role_id', 'role_name', 'role_description', 'role_status', 'role_created_at',
        'permission_count', 'assigned_member_count'],
  'list_vendor_roles() returns exactly the seven agreed columns, in order');

select is(
  pg_temp.table_columns('get_vendor_role_detail'),
  array['role_id', 'role_name', 'role_description', 'role_status', 'role_created_at',
        'permission_count', 'assigned_member_count'],
  'get_vendor_role_detail() returns exactly the same seven columns, in order');

-- Stated as a relationship as well as two literals, so the two can never drift apart
-- without this failing. public.roles has nothing further to show about a role definition:
-- its remaining columns are `code` (refused) and `updated_at` (a record of the last seed
-- run), so a wider detail shape would mean inventing data.
select is(
  pg_temp.table_columns('get_vendor_role_detail'),
  pg_temp.table_columns('list_vendor_roles'),
  'the detail column set IS the list column set — one Flutter model deserializes both');

select is(
  pg_temp.table_columns('list_vendor_role_permissions'),
  array['permission_name', 'permission_description'],
  'list_vendor_role_permissions() returns exactly the two columns the web Roles page shows');

-- FORBIDDEN FIELDS. The exact-column assertions above already exclude these; this states
-- the rules directly so the reasons survive a future column addition.
select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_roles')
     || pg_temp.table_columns('get_vendor_role_detail')
     || pg_temp.table_columns('list_vendor_role_permissions')) c
   where c ~ 'code'),
  0::bigint,
  'no output column carries a role code or a permission code — those are the literals the RLS policies match on');

select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_roles')
     || pg_temp.table_columns('get_vendor_role_detail')
     || pg_temp.table_columns('list_vendor_role_permissions')) c
   where c ~ 'token|hash|secret|password|provider|session|ip_address|invitation|auth_user|user_id|profile_id|organization_id|tenant|membership'),
  0::bigint,
  'no output column names a token, hash, secret, credential, invitation, auth user, profile, membership, organization or tenant');

select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_roles')
     || pg_temp.table_columns('get_vendor_role_detail')
     || pg_temp.table_columns('list_vendor_role_permissions')) c
   where c ~ 'policy|rls|grant|search_path|definer|expression|sql'),
  0::bigint,
  'no output column exposes a policy name, grant, RLS expression or function internal');

select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_roles')
     || pg_temp.table_columns('get_vendor_role_detail')) c
   where c ~ 'member_name|display_name|first_name|last_name|email|mobile|phone'),
  0::bigint,
  'a role read returns no member personal data — only a COUNT crosses that boundary');

-- The two fields the schema cannot support, asserted as ABSENT so a later edit cannot add
-- them by inference. There is no role kind column and no permission status column
-- (Section B proves both against information_schema); a system/custom flag would have to be
-- derived from the role name or code, and an active_permission_count would always equal
-- permission_count.
select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_roles')
     || pg_temp.table_columns('get_vendor_role_detail')) c
   where c ~ 'kind|is_system|is_custom|is_builtin|is_editable|editable|active_permission'),
  0::bigint,
  'no output column invents a system/custom kind, an editable flag, or an active-permission count');

-- Security attributes.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public'
     and p.proname in ('list_vendor_roles','get_vendor_role_detail','list_vendor_role_permissions')
     and p.prosecdef),
  3::bigint,
  'all three functions are SECURITY DEFINER');

-- `set search_path = ''` is stored by PostgreSQL as the literal `search_path=""` — the
-- empty string, quoted. Asserting `search_path=` (unquoted) would match nothing and the
-- test would fail even on a correctly-hardened function.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public'
     and p.proname in ('list_vendor_roles','get_vendor_role_detail','list_vendor_role_permissions')
     and p.proconfig @> array['search_path=""']),
  3::bigint,
  'all three functions pin an EMPTY search_path');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public'
     and p.proname in ('list_vendor_roles','get_vendor_role_detail','list_vendor_role_permissions')
     and p.provolatile = 's'),
  3::bigint,
  'all three functions are STABLE — none may write');

-- Grants: authenticated yes, anon no, PUBLIC no, service_role no.
select ok(has_function_privilege('authenticated', 'public.list_vendor_roles()', 'execute'),
  'authenticated may execute list_vendor_roles()');
select ok(has_function_privilege('authenticated', 'public.get_vendor_role_detail(uuid)', 'execute'),
  'authenticated may execute get_vendor_role_detail(uuid)');
select ok(has_function_privilege('authenticated', 'public.list_vendor_role_permissions(uuid)', 'execute'),
  'authenticated may execute list_vendor_role_permissions(uuid)');

select ok(not has_function_privilege('anon', 'public.list_vendor_roles()', 'execute'),
  'anon may NOT execute list_vendor_roles()');
select ok(not has_function_privilege('anon', 'public.get_vendor_role_detail(uuid)', 'execute'),
  'anon may NOT execute get_vendor_role_detail(uuid)');
select ok(not has_function_privilege('anon', 'public.list_vendor_role_permissions(uuid)', 'execute'),
  'anon may NOT execute list_vendor_role_permissions(uuid)');

-- PUBLIC holds nothing. A PUBLIC grant appears in proacl as an entry with an empty grantee
-- ("=X/owner"), and PUBLIC is inherited by every role — so a leftover default grant would
-- hand anon EXECUTE despite the explicit revokes.
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where n.nspname='public'
     and p.proname in ('list_vendor_roles','get_vendor_role_detail','list_vendor_role_permissions')
     and a::text like '=%'),
  0::bigint,
  'PUBLIC holds EXECUTE on none of the three functions');

select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where n.nspname='public'
     and p.proname in ('list_vendor_roles','get_vendor_role_detail','list_vendor_role_permissions')
     and a::text like 'service_role=%'),
  0::bigint,
  'service_role is granted none of them — all three derive authority from auth.uid()');

-- NO BROAD TABLE GRANTS, AND NO WEAKENED RLS. This migration must not have made any Flutter
-- read easier by opening a table. A SECURITY DEFINER function is allowed to run outside the
-- policies; what must never happen is the policies being switched off so that a direct
-- PostgREST select becomes an easier path than the contract.
select ok((select relrowsecurity from pg_class where oid = 'public.roles'::regclass),
  'public.roles still has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.permissions'::regclass),
  'public.permissions still has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.role_permissions'::regclass),
  'public.role_permissions still has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.member_roles'::regclass),
  'public.member_roles still has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.organization_members'::regclass),
  'public.organization_members still has RLS enabled');

-- The five migration-5 read policies these functions stand in for are all still present and
-- unmodified in name.
select is(
  (select count(*) from pg_policies
   where schemaname = 'public'
     and policyname in ('roles_select_rbac_authorized',
                        'permissions_select_rbac_authorized',
                        'role_permissions_select_rbac_authorized',
                        'member_roles_select_self_or_rbac_authorized',
                        'organization_members_select_self_or_authorized')),
  5::bigint,
  'the five migration-5 read policies for roles, permissions and memberships are still in place');

-- authenticated keeps SELECT and nothing more; anon keeps nothing at all.
select is(
  (select count(*)
   from unnest(array['public.roles', 'public.permissions', 'public.role_permissions',
                     'public.member_roles', 'public.organization_members']) t
   where has_table_privilege('anon', t, 'select')
      or has_table_privilege('anon', t, 'insert')),
  0::bigint,
  'anon still holds no privilege on any RBAC or membership table');

select is(
  (select count(*)
   from unnest(array['public.roles', 'public.permissions', 'public.role_permissions',
                     'public.member_roles', 'public.organization_members']) t
   where has_table_privilege('authenticated', t, 'insert')
      or has_table_privilege('authenticated', t, 'update')
      or has_table_privilege('authenticated', t, 'delete')),
  0::bigint,
  'authenticated still holds no write privilege on any RBAC or membership table — this milestone is reads only');


-- ============================================================================
-- SECTION B — the schema facts this contract is built on
-- ============================================================================
-- Every design decision in the migration rests on these, and a comment is not evidence.
-- If any of them ever changes, this section fails first and the contract is revisited
-- deliberately rather than by inference.

select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name in ('roles', 'permissions', 'role_permissions')
      and column_name in ('organization_id', 'vendor_organization_id', 'tenant_id')),
  'the role and permission catalogue carries NO organization scope — it is global, and this contract does not pretend otherwise');

-- AN INACTIVE ASSIGNED PERMISSION IS UNREPRESENTABLE, NOT MERELY UNSEEDED. Both halves are
-- asserted: the definition table has no status, and neither does the assignment table. If
-- either ever gains one, this contract must grow a permission_status column and an
-- active_permission_count, and these two assertions are what force that conversation.
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'permissions'
      and column_name = 'status'),
  'public.permissions has NO status column — there is no active/inactive permission distinction to report');

select is(
  (select array_agg(c.column_name::text order by c.column_name)
   from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'permissions'),
  array['code', 'created_at', 'description', 'id', 'module', 'name', 'updated_at'],
  'public.permissions has exactly seven columns, and a status is not among them');

select is(
  (select array_agg(c.column_name::text order by c.column_name)
   from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'role_permissions'),
  array['created_at', 'permission_id', 'role_id'],
  'public.role_permissions has exactly three columns — an ASSIGNMENT cannot carry a status either');

-- THE EFFECTIVENESS GATE IS THE ROLE'S STATUS, AND NOTHING ELSE ABOUT A PERMISSION. Asserted
-- against the deployed helper's own source, because this is the fact the whole
-- permission-status question turns on: has_organization_permission() cannot filter on a
-- permission status, since there is no column to filter on. It filters on r.status instead.
select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'has_organization_permission')
    like '%r.status = ''ACTIVE''%',
  'has_organization_permission() gates on the ROLE status');

select ok(
  (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'has_organization_permission')
    not like '%perm.status%',
  'and carries NO permission-status predicate — there is no such column to predicate on');

select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'roles'
      and column_name in ('kind', 'role_kind', 'is_system', 'is_custom', 'is_builtin', 'is_editable')),
  'public.roles has NO system/custom/editable property — one could only be invented from the name or code');

select is(
  (select array_agg(c.column_name::text order by c.column_name)
   from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'roles'),
  array['code', 'created_at', 'description', 'id', 'name', 'status', 'updated_at'],
  'public.roles has exactly seven columns; the contract returns five of them and refuses `code` and `updated_at`');

-- member_roles is the ONLY place an organization enters the role picture, and it does so
-- through organization_members. That is why assigned_member_count is the one tenant-scoped
-- value in this contract.
select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'member_roles'
      and column_name = 'organization_id'),
  'member_roles carries no organization_id either — the owning organization is reached through organization_members');


-- ============================================================================
-- SECTION C — signed-out callers are denied by all three reads
-- ============================================================================
select pg_temp.sign_out();

select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'signed-out caller is denied the role list');
select is(pg_temp.sqlstate_of('select * from public.get_vendor_role_detail(gen_random_uuid())'), '42501',
  'signed-out caller is denied the role detail');
select is(pg_temp.sqlstate_of('select * from public.list_vendor_role_permissions(gen_random_uuid())'), '42501',
  'signed-out caller is denied the role permissions');
select is(
  pg_temp.sqlstate_of(format('select * from public.get_vendor_role_detail(%L)', pg_temp.role_id('VENDOR_SUPER_ADMIN'))),
  '42501',
  'signed-out caller is denied even for a role id that really exists');
select is(
  pg_temp.sqlstate_of(format('select * from public.list_vendor_role_permissions(%L)', pg_temp.role_id('VENDOR_SUPER_ADMIN'))),
  '42501',
  'and is denied that role''s permissions too');


-- ============================================================================
-- SECTION D — an authorized Vendor Super Admin lists the catalogue, in a stable order
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is(
  pg_temp.my_role_names(),
  array['Claim Reviewer', 'Finance Admin', 'Legacy Vendor Role', 'Retailer Manager',
        'Retailer Owner', 'Sales Staff', 'Undescribed Role', 'Vendor Super Admin'],
  'the whole catalogue is listed, ordered by role name — the six seeded roles plus the two added by this suite');

select is((select count(*) from public.list_vendor_roles()), 8::bigint,
  'eight rows — one per role DEFINITION, never one per permission mapping or role assignment');

select is(pg_temp.my_role_names(), pg_temp.my_role_names(),
  'the ordering is stable across repeated calls');

-- The list is exactly public.roles, neither narrowed nor widened. Stated as an equality
-- against the table so a filter added later fails here rather than silently hiding a role.
select is(
  (select count(*) from public.list_vendor_roles()),
  (select count(*) from public.roles),
  'the list returns every role definition on record — no status, kind or name filter is applied');

select is(pg_temp.list_role_id('Vendor Super Admin'), pg_temp.role_id('VENDOR_SUPER_ADMIN'),
  'the role_id returned is the public.roles primary key — the id the detail read is addressed by');

select ok(
  (select l.role_created_at from public.list_vendor_roles() l where l.role_name = 'Vendor Super Admin') is not null,
  'the role creation date is returned');

-- ROLE ROWS ARE IDENTICAL FOR EVERY AUTHORIZED VENDOR, because the catalogue is global.
-- This is the shipped web behaviour, asserted rather than quietly narrowed.
select pg_temp.act_as(pg_temp.fx('gil'));
select is(pg_temp.my_role_names(),
  array['Claim Reviewer', 'Finance Admin', 'Legacy Vendor Role', 'Retailer Manager',
        'Retailer Owner', 'Sales Staff', 'Undescribed Role', 'Vendor Super Admin'],
  'a second Vendor reads the same catalogue rows — roles are global definitions, not tenant data');


-- ============================================================================
-- SECTION E — every caller without Vendor Super Admin authority is denied
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('owner'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'a Retailer Owner is denied the role list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_role_detail(%L)', pg_temp.role_id('RETAILER_OWNER'))), '42501',
  'a Retailer Owner is denied the detail — even for the very role they hold');
select is(pg_temp.sqlstate_of(format('select * from public.list_vendor_role_permissions(%L)', pg_temp.role_id('RETAILER_OWNER'))), '42501',
  'and is denied that role''s permissions');

select pg_temp.act_as(pg_temp.fx('manager'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'a Retailer Manager is denied the role list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_role_detail(%L)', pg_temp.role_id('RETAILER_MANAGER'))), '42501',
  'a Retailer Manager is denied the detail');
select is(pg_temp.sqlstate_of(format('select * from public.list_vendor_role_permissions(%L)', pg_temp.role_id('RETAILER_MANAGER'))), '42501',
  'a Retailer Manager is denied the permissions');

select pg_temp.act_as(pg_temp.fx('staff'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'a Sales Staff member is denied the role list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_role_detail(%L)', pg_temp.role_id('SALES_STAFF'))), '42501',
  'a Sales Staff member is denied the detail');
select is(pg_temp.sqlstate_of(format('select * from public.list_vendor_role_permissions(%L)', pg_temp.role_id('SALES_STAFF'))), '42501',
  'a Sales Staff member is denied the permissions');

select pg_temp.act_as(pg_temp.fx('no_org'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'an authenticated user with no organization at all is denied');

-- A Vendor A member in good standing who simply does not hold VENDOR_SUPER_ADMIN. This is
-- the case that matters most: she is inside the tenant, and she holds two real roles.
select pg_temp.act_as(pg_temp.fx('zoe'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'a Vendor user holding only CLAIM_REVIEWER and FINANCE_ADMIN is denied the list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_role_detail(%L)', pg_temp.role_id('CLAIM_REVIEWER'))), '42501',
  'that same Vendor user cannot read the detail of a role she herself holds');
select is(pg_temp.sqlstate_of(format('select * from public.list_vendor_role_permissions(%L)', pg_temp.role_id('CLAIM_REVIEWER'))), '42501',
  'nor its permissions — an assignment is not an authority to read the catalogue');

select pg_temp.act_as(pg_temp.fx('eve'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'a Vendor member with NO role at all is denied — an absent role is never a default grant');

-- An inactive CALLER is denied for that reason alone. Bob and Cara both hold
-- VENDOR_SUPER_ADMIN in Vendor A; Bob's profile is SUSPENDED and Cara's membership is
-- DEACTIVATED. Section H then counts both of them as HOLDERS of that role, which is what
-- proves the ACTIVE requirements govern who may call and not who is counted.
select pg_temp.act_as(pg_temp.fx('bob'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'a SUSPENDED profile holding VENDOR_SUPER_ADMIN is denied the list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_role_detail(%L)', pg_temp.role_id('VENDOR_SUPER_ADMIN'))), '42501',
  'a SUSPENDED profile is denied the detail');
select is(pg_temp.sqlstate_of(format('select * from public.list_vendor_role_permissions(%L)', pg_temp.role_id('VENDOR_SUPER_ADMIN'))), '42501',
  'a SUSPENDED profile is denied the permissions');

select pg_temp.act_as(pg_temp.fx('cara'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'a DEACTIVATED membership holding VENDOR_SUPER_ADMIN is denied the list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_role_detail(%L)', pg_temp.role_id('VENDOR_SUPER_ADMIN'))), '42501',
  'a DEACTIVATED membership is denied the detail');


-- ============================================================================
-- SECTION F — role fields are accurate, and nothing is fabricated
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.list_status('Vendor Super Admin'), 'ACTIVE',
  'an ACTIVE role definition reports ACTIVE');
select is(pg_temp.list_status('Legacy Vendor Role'), 'INACTIVE',
  'an INACTIVE role definition is LISTED and MARKED — the catalogue does not hide it');

select is(
  pg_temp.list_description('Vendor Super Admin'),
  'Full administrative access within an assigned vendor organization.',
  'the stored description is returned verbatim');

select ok(pg_temp.list_description('Undescribed Role') is null,
  'a role with no description returns NULL — nothing is fabricated to fill the field');

select is(
  (select count(*) from public.list_vendor_roles() l where l.role_status not in ('ACTIVE', 'INACTIVE')),
  0::bigint,
  'every returned status is one the roles_status_allowed constraint permits — no status is mapped or defaulted');

-- The status reported is the STORED status, not a derived one. Proven by changing it.
update public.roles set status = 'INACTIVE' where code = 'FINANCE_ADMIN';
select is(pg_temp.list_status('Finance Admin'), 'INACTIVE',
  'the status column is read from the row, not inferred — deactivating a definition is reflected immediately');
select is((select count(*) from public.list_vendor_roles()), 8::bigint,
  'and deactivating it does not remove it from the catalogue');
update public.roles set status = 'ACTIVE' where code = 'FINANCE_ADMIN';

-- Role names and codes are different things, and only names are returned.
select ok(
  not exists (
    select 1 from public.list_vendor_roles() l
    where l.role_name in ('VENDOR_SUPER_ADMIN', 'CLAIM_REVIEWER', 'FINANCE_ADMIN',
                          'RETAILER_OWNER', 'RETAILER_MANAGER', 'SALES_STAFF')),
  'role_name carries display names only — never the internal role codes');


-- ============================================================================
-- SECTION G — permission_count semantics
-- ============================================================================
-- VENDOR_SUPER_ADMIN's exact permission set is seed data spread across several migrations
-- and grows whenever a module is built, so the count is asserted against the mapping table
-- rather than against a number written here — a literal would be a second copy of the seed,
-- free to drift.
select is(
  pg_temp.list_permission_count('Vendor Super Admin'),
  (select count(*)::integer from public.role_permissions rp
   where rp.role_id = pg_temp.role_id('VENDOR_SUPER_ADMIN')),
  'permission_count equals the number of role_permissions rows for that role');

select ok(pg_temp.list_permission_count('Vendor Super Admin') >= 3,
  'and it is at least the three foundation permissions the seed maps');

-- FINANCE_ADMIN, not CLAIM_REVIEWER. Both were seeded with zero mappings, and this
-- assertion used the reviewer until migration 20260818210000 deliberately gave it
-- CLAIM_REVIEW_PORTAL_READ. The BEHAVIOUR under test — a role with no mappings reports 0
-- rather than NULL or the whole catalogue — is unchanged; only the example had to move to
-- a role that is still genuinely empty. FINANCE_ADMIN remains so until its own module is
-- built, exactly as the 20260716133023 seed describes.
select is(pg_temp.list_permission_count('Finance Admin'), 0,
  'a role with no permission mappings reports 0 — FINANCE_ADMIN is seeded exactly that way');
select is(pg_temp.list_permission_count('Undescribed Role'), 0,
  'a freshly defined role with no mappings reports 0 rather than NULL');

-- Retailer roles DO carry permissions, and the Vendor sees those counts — because the
-- catalogue is global. Asserted so that a later "filter this to Vendor roles" edit fails
-- here rather than silently changing what the contract means.
select ok(pg_temp.list_permission_count('Retailer Owner') > 0,
  'a Retailer role''s permission count is reported to the Vendor too — the catalogue is not filtered by scope');

select is(
  (select count(*) from public.list_vendor_roles() l where l.permission_count is null),
  0::bigint,
  'permission_count is never NULL — a client never has to branch on it');

-- THE INVARIANT: the count and the companion read can never disagree, for any role. This is
-- what makes it safe for a detail screen to show the number before the list arrives.
select is(
  (select count(*) from public.list_vendor_roles() l
   where l.permission_count <> (select count(*) from public.list_vendor_role_permissions(l.role_id))),
  0::bigint,
  'for EVERY role, permission_count equals the number of rows list_vendor_role_permissions() returns');

-- A role with many permissions is still ONE row.
select is(
  (select count(*) from public.list_vendor_roles() l where l.role_name = 'Vendor Super Admin'),
  1::bigint,
  'a role holding several permissions produces ONE row, never one per permission');


-- ============================================================================
-- SECTION H — assigned_member_count semantics and tenant isolation
-- ============================================================================
-- This is the ONLY tenant-scoped value in the contract, and the only reason a global
-- catalogue means anything to one Vendor.

select is(pg_temp.list_member_count('Vendor Super Admin'), 3,
  'Vendor A counts its three VENDOR_SUPER_ADMIN holders — including the SUSPENDED profile and the DEACTIVATED membership');

select is(pg_temp.list_member_count('Claim Reviewer'), 2,
  'Zoe and the INVITED Dan both count — no membership or profile status filter is applied');

select is(pg_temp.list_member_count('Finance Admin'), 1,
  'a member holding two roles contributes 1 to EACH count, never 2 to one');

select is(pg_temp.list_member_count('Legacy Vendor Role'), 1,
  'an INACTIVE definition still reports its holders — that is what an administrator needs before retiring it');

select is(pg_temp.list_member_count('Undescribed Role'), 0,
  'a role nobody holds reports 0');

-- CROSS-ORGANIZATION EXCLUSION. All three Retailer roles are genuinely held — by members of
-- the Retailer organization — and every one of them must read 0 for this Vendor.
select is(pg_temp.list_member_count('Retailer Owner'), 0,
  'a role held only in another organization reports 0 for this Vendor');
select is(pg_temp.list_member_count('Retailer Manager'), 0,
  'the Retailer Manager assignment in the Retailer organization is invisible to the Vendor count');
select is(pg_temp.list_member_count('Sales Staff'), 0,
  'and so is the Sales Staff assignment');

select is(
  (select count(*) from public.list_vendor_roles() l where l.assigned_member_count is null),
  0::bigint,
  'assigned_member_count is never NULL');

-- THE INVARIANT: every count is exactly the number of member_roles rows reachable through
-- THIS Vendor's memberships. Asserted set-wise for every role at once.
select is(
  (select count(*) from public.list_vendor_roles() l
   where l.assigned_member_count <> (
     select count(*)
     from public.member_roles mr
     join public.organization_members m on m.id = mr.organization_member_id
     where mr.role_id = l.role_id
       and m.organization_id = pg_temp.fx('vendor_a'))),
  0::bigint,
  'for EVERY role, assigned_member_count is the count of this Vendor''s own member_roles rows');

-- A role held by several members is still ONE row.
select is(
  (select count(*) from public.list_vendor_roles() l where l.role_name = 'Vendor Super Admin'),
  1::bigint,
  'a role held by three members produces ONE row, never three');

-- TENANT ISOLATION, IN BOTH DIRECTIONS. Vendor B reads the same role NAMES and different
-- COUNTS. This is the assertion that proves the count is scoped to the caller and not to
-- the catalogue.
select pg_temp.act_as(pg_temp.fx('gil'));

select is(pg_temp.list_member_count('Vendor Super Admin'), 1,
  'Vendor B counts only its own single administrator — Vendor A''s three are invisible');
select is(pg_temp.list_member_count('Claim Reviewer'), 1,
  'Vendor B counts only its own Claim Reviewer');
select is(pg_temp.list_member_count('Finance Admin'), 0,
  'a role held in Vendor A but not in Vendor B reports 0 for Vendor B');
select is(pg_temp.list_member_count('Legacy Vendor Role'), 0,
  'and so does Vendor A''s legacy-role holder');

select is(
  pg_temp.list_description('Vendor Super Admin'),
  'Full administrative access within an assigned vendor organization.',
  'while the role DEFINITION Vendor B reads is identical to Vendor A''s — the catalogue is shared, the counts are not');

-- A PERSON WHO BELONGS TO TWO ORGANIZATIONS CONTRIBUTES TO EACH SEPARATELY. Hal already has
-- a Vendor B membership holding CLAIM_REVIEWER; give him a Vendor A membership holding
-- FINANCE_ADMIN and neither Vendor's numbers may move for the other's role.
insert into pg_temp.fx (k, v) values
  ('m_hal_a', pg_temp.add_member(pg_temp.fx('hal'), pg_temp.fx('vendor_a'), 'ACTIVE'));
select pg_temp.add_role(pg_temp.fx('m_hal_a'), 'FINANCE_ADMIN');

select is(pg_temp.list_member_count('Claim Reviewer'), 1,
  'Vendor B''s Claim Reviewer count is unchanged by a new membership of the same person elsewhere');
select is(pg_temp.list_member_count('Finance Admin'), 0,
  'and Vendor B does not gain the Finance Admin assignment made in Vendor A');

select pg_temp.act_as(pg_temp.fx('ada'));
select is(pg_temp.list_member_count('Finance Admin'), 2,
  'Vendor A now counts two Finance Admins — its own Zoe plus Hal''s Vendor A membership');
select is(pg_temp.list_member_count('Claim Reviewer'), 2,
  'and Vendor A does not gain Hal''s Vendor B Claim Reviewer assignment');
select is((select count(*) from public.list_vendor_roles()), 8::bigint,
  'the catalogue is still eight rows — an assignment never adds a role row');


-- ============================================================================
-- SECTION I — detail: one row for a real role, ZERO ROWS for anything else
-- ============================================================================
-- The security property of this section is that all three "no" answers are byte-identical,
-- and that none of them is an error.
select is(pg_temp.detail_count(pg_temp.role_id('VENDOR_SUPER_ADMIN')), 1::bigint,
  'an authorized Vendor reads one role definition');

select is(pg_temp.detail_count(gen_random_uuid()), 0::bigint,
  'an id that names no role yields zero rows');

select is(pg_temp.detail_count(pg_temp.fx('vendor_a')), 0::bigint,
  'an id belonging to another table (an organization) yields zero rows — the selector is not a general oracle');

select is(pg_temp.detail_count(pg_temp.fx('m_ada')), 0::bigint,
  'and neither is a membership id');

select is(pg_temp.detail_count(null), 0::bigint,
  'a null selector yields zero rows');

select is(
  pg_temp.sqlstate_of('select * from public.get_vendor_role_detail(gen_random_uuid())'),
  pg_temp.sqlstate_of(format('select * from public.get_vendor_role_detail(%L)', pg_temp.fx('vendor_a'))),
  'an unknown id and a foreign-table id are INDISTINGUISHABLE — both return normally');

select is(pg_temp.sqlstate_of('select * from public.get_vendor_role_detail(null)'), null,
  'and a null selector is not an error either');

-- DETAIL AGREES WITH THE LIST ON EVERY COLUMN, for a role chosen because it exercises all
-- of them: a real description, an ACTIVE status, several permissions and several holders.
select is(
  (select d.role_name from public.get_vendor_role_detail(pg_temp.role_id('VENDOR_SUPER_ADMIN')) d),
  'Vendor Super Admin', 'detail returns the role name');
select is(
  (select d.role_description from public.get_vendor_role_detail(pg_temp.role_id('VENDOR_SUPER_ADMIN')) d),
  pg_temp.list_description('Vendor Super Admin'), 'list and detail agree on the description');
select is(
  (select d.role_status from public.get_vendor_role_detail(pg_temp.role_id('LEGACY_VENDOR_ROLE')) d),
  'INACTIVE', 'detail reports an INACTIVE definition as INACTIVE, and opens it rather than refusing');
select ok(
  (select d.role_description from public.get_vendor_role_detail(pg_temp.role_id('UNDESCRIBED_ROLE')) d) is null,
  'detail returns a NULL description rather than fabricating one');
select is(
  (select d.role_id from public.get_vendor_role_detail(pg_temp.role_id('CLAIM_REVIEWER')) d),
  pg_temp.role_id('CLAIM_REVIEWER'), 'detail echoes the role id it was given');
select is(
  (select d.permission_count from public.get_vendor_role_detail(pg_temp.role_id('VENDOR_SUPER_ADMIN')) d),
  pg_temp.list_permission_count('Vendor Super Admin'), 'list and detail agree on permission_count');
select is(
  (select d.assigned_member_count from public.get_vendor_role_detail(pg_temp.role_id('VENDOR_SUPER_ADMIN')) d),
  pg_temp.list_member_count('Vendor Super Admin'), 'list and detail agree on assigned_member_count');
select is(
  (select d.role_created_at from public.get_vendor_role_detail(pg_temp.role_id('VENDOR_SUPER_ADMIN')) d),
  (select l.role_created_at from public.list_vendor_roles() l where l.role_name = 'Vendor Super Admin'),
  'list and detail agree on the creation timestamp');

-- THE DETAIL'S MEMBER COUNT IS RECOMPUTED FOR THE CALLING VENDOR, not baked into the role.
select pg_temp.act_as(pg_temp.fx('gil'));
select is(
  (select d.assigned_member_count from public.get_vendor_role_detail(pg_temp.role_id('VENDOR_SUPER_ADMIN')) d),
  1,
  'Vendor B opening the SAME role id sees its own member count');
select is(
  (select d.role_name from public.get_vendor_role_detail(pg_temp.role_id('VENDOR_SUPER_ADMIN')) d),
  'Vendor Super Admin',
  'while reading the same shared definition — this is the documented global-catalogue behaviour');


-- ============================================================================
-- SECTION J — the permission companion read
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

-- ONLY THE SELECTED ROLE'S PERMISSIONS. The three foundation permissions are asserted by
-- name because they are stable seed data referenced by the RLS policies themselves.
select ok(
  pg_temp.permission_names(pg_temp.role_id('VENDOR_SUPER_ADMIN')) @>
    array['Read Audit Logs', 'Read Organization Members', 'Read Roles and Permissions'],
  'the role''s permissions are returned by display NAME');

select is(
  (select l.permission_description from public.list_vendor_role_permissions(pg_temp.role_id('VENDOR_SUPER_ADMIN')) l
   where l.permission_name = 'Read Roles and Permissions'),
  'View the role and permission catalogue and organization role assignments.',
  'the stored permission description is returned verbatim');

-- FINANCE_ADMIN for the same reason as the count assertion above: CLAIM_REVIEWER now
-- holds exactly one permission by design, so it is no longer an example of an empty role.
select is(pg_temp.permission_names(pg_temp.role_id('FINANCE_ADMIN')), '{}'::text[],
  'a role with no permissions returns an EMPTY list, not NULL and not the whole catalogue');

-- And the reviewer's single portal permission is asserted positively, so the row this
-- assertion used to cover is still covered rather than merely moved away from.
select is(pg_temp.permission_names(pg_temp.role_id('CLAIM_REVIEWER')),
  array['Open the Claim Review portal']::text[],
  'CLAIM_REVIEWER holds exactly its one portal permission — no receipt access');

select is(pg_temp.permission_names(pg_temp.role_id('UNDESCRIBED_ROLE')), '{}'::text[],
  'and so does a freshly defined role — a role with no mappings is never defaulted to all permissions');

-- ANOTHER ROLE'S PERMISSIONS ARE ABSENT. Proven with a fixture rather than with seed data:
-- a permission mapped to EXACTLY ONE role, so "it appears under that role and nowhere else"
-- is decidable without depending on which permissions the seeds happen to have mapped to
-- VENDOR_SUPER_ADMIN by this milestone. Rolled back with everything else.
insert into public.permissions (code, name, description, module)
values ('FIXTURE_SCOPED_READ', 'Fixture Scoped Read',
        'Mapped to the legacy fixture role and to nothing else.', 'FIXTURE');

insert into public.role_permissions (role_id, permission_id)
select pg_temp.role_id('LEGACY_VENDOR_ROLE'), p.id
from public.permissions p where p.code = 'FIXTURE_SCOPED_READ';

select is(pg_temp.permission_names(pg_temp.role_id('LEGACY_VENDOR_ROLE')),
  array['Fixture Scoped Read'],
  'a role returns exactly the permissions mapped to it');

select ok(
  not ('Fixture Scoped Read' = any (pg_temp.permission_names(pg_temp.role_id('VENDOR_SUPER_ADMIN')))),
  'and that permission appears under NO other role — one role''s grants never leak into another''s list');

select ok(
  not exists (
    select 1
    from public.roles r, lateral public.list_vendor_role_permissions(r.id) l
    where l.permission_name = 'Fixture Scoped Read'
      and r.code <> 'LEGACY_VENDOR_ROLE'),
  'asserted across the WHOLE catalogue, not just against one other role');

select is(
  (select count(*) from public.list_vendor_role_permissions(pg_temp.role_id('RETAILER_MANAGER'))),
  (select count(*)::bigint from public.role_permissions rp where rp.role_id = pg_temp.role_id('RETAILER_MANAGER')),
  'each role returns exactly its own mapping rows, no more and no fewer');

-- NO PERMISSION CODE EVER LEAKS THROUGH THE NAME OR DESCRIPTION COLUMNS.
select ok(
  not exists (
    select 1 from public.roles r, lateral public.list_vendor_role_permissions(r.id) l
    where l.permission_name in (select p.code from public.permissions p)),
  'no returned permission_name is a permission CODE — codes are authorization vocabulary and stay internal');

-- NO DUPLICATE PERMISSION ROWS, and stable ordering.
select is(
  (select count(*) from public.list_vendor_role_permissions(pg_temp.role_id('VENDOR_SUPER_ADMIN'))),
  (select count(distinct l.permission_name)::bigint
   from public.list_vendor_role_permissions(pg_temp.role_id('VENDOR_SUPER_ADMIN')) l),
  'no permission appears twice for one role');

select is(
  pg_temp.permission_names(pg_temp.role_id('VENDOR_SUPER_ADMIN')),
  (select array_agg(n order by n)
   from unnest(pg_temp.permission_names(pg_temp.role_id('VENDOR_SUPER_ADMIN'))) n),
  'permissions arrive ordered by display name');

select is(
  pg_temp.permission_names(pg_temp.role_id('VENDOR_SUPER_ADMIN')),
  pg_temp.permission_names(pg_temp.role_id('VENDOR_SUPER_ADMIN')),
  'and that order is stable across repeated calls');

-- UNKNOWN, FOREIGN-TABLE AND NULL SELECTORS ARE ALL THE SAME NON-LEAKING ANSWER, and all of
-- them are identical to a genuinely permission-less role.
select is(pg_temp.permission_names(gen_random_uuid()), '{}'::text[],
  'an unknown id returns an empty list');
select is(pg_temp.permission_names(pg_temp.fx('vendor_a')), '{}'::text[],
  'an organization id returns an empty list');
select is(pg_temp.permission_names(null), '{}'::text[],
  'a null selector returns an empty list');
select is(
  pg_temp.sqlstate_of('select * from public.list_vendor_role_permissions(gen_random_uuid())'),
  pg_temp.sqlstate_of(format('select * from public.list_vendor_role_permissions(%L)', pg_temp.role_id('CLAIM_REVIEWER'))),
  'an unknown role and a permission-less real role are INDISTINGUISHABLE — the detail read is what disambiguates');

-- THE CATALOGUE SECTION OF THE WEB PAGE IS NOT REACHABLE HERE. This operation answers only
-- "what does THIS role grant"; there is no argument that widens it to every permission.
select ok(
  (select count(*) from public.list_vendor_role_permissions(pg_temp.role_id('VENDOR_SUPER_ADMIN')))
    < (select count(*) from public.permissions),
  'the companion never returns the whole permission catalogue — only the selected role''s grants');


-- ============================================================================
-- SECTION K — inactive definitions and the documented status semantics
-- ============================================================================
-- public.permissions has no status column (Section B), so there is no inactive PERMISSION
-- to exclude or mark and no active_permission_count to reconcile. What CAN be inactive is a
-- ROLE, and the rule is: listed, marked, counted, and openable.
select is(pg_temp.list_status('Legacy Vendor Role'), 'INACTIVE',
  'the inactive role is marked');
select is(pg_temp.list_member_count('Legacy Vendor Role'), 1,
  'its holders are counted rather than hidden');
select is(pg_temp.detail_count(pg_temp.role_id('LEGACY_VENDOR_ROLE')), 1::bigint,
  'and it can be opened — a detail screen is where a Vendor goes to understand a retired role');

-- The documented disagreement with list_vendor_users(), stated as a test so that neither
-- side can be "fixed" without the other being reconsidered: this contract describes the
-- DEFINITION and counts its holders, while the user directory hides an inactive definition
-- from a member's role names.
select ok(
  exists (select 1 from public.member_roles mr
          join public.organization_members m on m.id = mr.organization_member_id
          where mr.role_id = pg_temp.role_id('LEGACY_VENDOR_ROLE')
            and m.organization_id = pg_temp.fx('vendor_a')),
  'the inactive role really is still assigned in this Vendor — the count above is not vacuous');
select ok(
  not exists (select 1 from public.list_vendor_users() u where 'Legacy Vendor Role' = any (u.role_names)),
  'while list_vendor_users() still hides that inactive DEFINITION from the holder''s role names — the documented, deliberate difference');

-- ----------------------------------------------------------------------------
-- AN INACTIVE ROLE'S MAPPED PERMISSIONS ARE LISTED BUT AUTHORIZE NOTHING
-- ----------------------------------------------------------------------------
-- This is the substance of the permission-status question, and it is a fact about ROLE
-- status rather than permission status (Section B proves a permission has no status to
-- have). LEGACY_VENDOR_ROLE is INACTIVE and Section J mapped FIXTURE_SCOPED_READ to it; Fay
-- holds it through an ACTIVE membership of an ACTIVE profile in Vendor A. If role status
-- were NOT the gate, she would hold that permission.
select pg_temp.act_as(pg_temp.fx('fay'));

select is(
  public.has_organization_permission(pg_temp.fx('vendor_a'), 'FIXTURE_SCOPED_READ'),
  false,
  'a permission mapped to an INACTIVE role authorizes NOTHING, even for a member in good standing who holds that role');

-- The same person, the same membership, the same mapping — only the ROLE's status changes.
-- That is what proves role status is the effectiveness gate and nothing about the permission
-- itself is.
update public.roles set status = 'ACTIVE' where code = 'LEGACY_VENDOR_ROLE';

select is(
  public.has_organization_permission(pg_temp.fx('vendor_a'), 'FIXTURE_SCOPED_READ'),
  true,
  'activating the ROLE makes the very same mapped permission effective — nothing about the permission changed');

update public.roles set status = 'INACTIVE' where code = 'LEGACY_VENDOR_ROLE';

select is(
  public.has_organization_permission(pg_temp.fx('vendor_a'), 'FIXTURE_SCOPED_READ'),
  false,
  'and deactivating it again withdraws the permission');

-- Meanwhile the contract keeps LISTING and COUNTING that permission, which is correct rather
-- than misleading: this operation answers "what is mapped to this role", and role_status —
-- returned by both other reads — is the field that says whether the role is live. The web
-- renders exactly this combination today. A client that hid these rows would make a retired
-- role look permission-less, which is the opposite of what an administrator opened the
-- screen to learn.
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.permission_names(pg_temp.role_id('LEGACY_VENDOR_ROLE')),
  array['Fixture Scoped Read'],
  'the INACTIVE role''s mapped permission is still LISTED — the operation reports mappings, not effective grants');

select is(pg_temp.list_permission_count('Legacy Vendor Role'), 1,
  'and is still COUNTED, so permission_count and the companion cannot disagree for an inactive role either');

select is(pg_temp.list_status('Legacy Vendor Role'), 'INACTIVE',
  'while role_status carries the fact that makes both of the above truthful — a client must render it alongside the permission list');

-- The contract must expose NO other status, because there is no other status to expose.
select is(
  (select count(*) from unnest(pg_temp.table_columns('list_vendor_role_permissions')) c
   where c ~ 'status'),
  0::bigint,
  'and the permission rows carry no status column of their own — an inactive assigned permission is unrepresentable, not merely unseeded');


-- ============================================================================
-- SECTION L — the permission requirements are real, not decorative
-- ============================================================================
-- All three functions are SECURITY DEFINER and therefore run outside the RLS policies that
-- normally require RBAC_READ and ORGANIZATION_MEMBERS_READ. The explicit checks stand in for
-- those policies, and this section proves they are load-bearing AND correctly split: the
-- companion read touches no membership table and must therefore survive the loss of
-- ORGANIZATION_MEMBERS_READ, while the two reads that return a member count must not. The
-- deletes are rolled back with the rest of the transaction.

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.code = 'VENDOR_SUPER_ADMIN'
  and p.code = 'ORGANIZATION_MEMBERS_READ';

select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'losing ORGANIZATION_MEMBERS_READ denies the list — it returns a count derived from organization_members');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_role_detail(%L)', pg_temp.role_id('CLAIM_REVIEWER'))), '42501',
  'and denies the detail, for the same reason');
select is(pg_temp.sqlstate_of(format('select * from public.list_vendor_role_permissions(%L)', pg_temp.role_id('VENDOR_SUPER_ADMIN'))), null,
  'but the permission companion still works — it reads no membership table, so it requires no membership permission');

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.code = 'VENDOR_SUPER_ADMIN'
  and p.code = 'RBAC_READ';

select is(pg_temp.sqlstate_of(format('select * from public.list_vendor_role_permissions(%L)', pg_temp.role_id('VENDOR_SUPER_ADMIN'))), '42501',
  'removing RBAC_READ as well denies the companion — that IS the permission it requires');
select is(pg_temp.sqlstate_of('select * from public.list_vendor_roles()'), '42501',
  'and the list stays denied');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_role_detail(%L)', pg_temp.role_id('CLAIM_REVIEWER'))), '42501',
  'and so does the detail');


select finish();

rollback;
