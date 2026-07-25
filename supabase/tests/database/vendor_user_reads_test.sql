-- pgTAP behavioural tests for the two Vendor User reads added by
-- migration 20260801090000_mobile_vendor_user_reads.sql:
--
--   public.list_vendor_users()
--   public.get_vendor_user_detail(uuid)
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
-- sales_staff_receipt_reads_test.sql and vendor_retailer_reads_test.sql exactly,
-- deliberately: four different impersonation idioms in one suite directory would be four
-- different claims about what "signed in" means.
--
-- The tests deliberately do NOT `set role authenticated`. Both functions are SECURITY
-- DEFINER, so their behaviour depends on auth.uid() and not on the session role, and
-- switching roles mid-transaction would only make the fixture inserts fail. EXECUTE
-- privilege is a separate concern and is asserted directly against the catalogue in
-- Section A, which is a stronger check than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back, so no fixture survives — and
-- neither does Section K, which temporarily removes a seeded role→permission mapping.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file
-- turns an added test into a confusing failure about arithmetic rather than about
-- behaviour.
--
-- ============================================================================
-- WHAT "DENIED" MEANS HERE, AND WHY THE TWO KINDS DIFFER
-- ============================================================================
-- Both functions RAISE 42501 for a caller who is not an authorized Vendor Super Admin. A
-- denial and "this Vendor has no other users" are different facts.
--
-- get_vendor_user_detail() additionally returns ZERO ROWS — never a raise — for an
-- authorized Vendor who names a membership that is not theirs. That distinction is the
-- security property: a distinguishable refusal would confirm that another Vendor's user
-- exists. Section H proves an unknown id, a foreign Vendor's id, a Retailer membership id
-- and null are byte-identical.
--
-- ============================================================================
-- THERE ARE NO VENDOR USER INVITATIONS TO TEST
-- ============================================================================
-- The schema has exactly two invitation tables and both are RETAILER-scoped by trigger
-- (public.retailer_invitations_assert_organization_types on retailer_invitations;
-- retailer_staff_invitations carries no vendor_organization_id at all). Nothing invites a
-- user into a VENDOR organization, so there is no pending-invitation list to assert on and
-- no invitation id space to keep apart from the membership id space. What Section F asserts
-- instead is the state that DOES exist: an INVITED membership of an INVITED profile is
-- listed, with both statuses reported accurately. Section A additionally proves that no
-- output column of either function could carry a token, a hash, or any invitation field.

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
 * Creates an auth user + a profile with EXPLICIT name parts, and returns the id.
 *
 * The names are given rather than derived because display-name composition and ordering
 * are both under test: a helper that invented `label || ' Tester'` would make every
 * fixture sort by its label and prove nothing about either.
 */
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
  p_status text default 'ACTIVE',
  p_deactivated_at timestamptz default null
) returns uuid
language plpgsql as $$
declare
  v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at, deactivated_at)
  values (p_org, p_user, p_status,
          case when p_status = 'INVITED' then null else now() - interval '30 days' end,
          p_deactivated_at)
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
 * there" comparisons Section H needs, and comparing SQLSTATEs is what makes "these two
 * denials are indistinguishable" a testable claim rather than a comment.
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
 * The display names visible to the current caller, IN THE FUNCTION'S OWN ORDER.
 *
 * row_number() over () numbers rows in the order they arrive from the function, and the
 * aggregate then sorts by that number — so this captures what the function emitted rather
 * than re-sorting it. Aggregating `order by display_name` would sort the evidence into
 * agreement with the assertion.
 */
create function pg_temp.my_user_names() returns text[]
language sql as $$
  select coalesce(array_agg(t.display_name order by t.ord), '{}'::text[])
  from (
    select l.display_name, row_number() over () as ord
    from public.list_vendor_users() l
  ) t;
$$;

/* Single columns of the list, keyed by display name. */
create function pg_temp.list_profile_status(p_name text) returns text
language sql as $$
  select l.profile_status from public.list_vendor_users() l where l.display_name = p_name;
$$;

create function pg_temp.list_membership_status(p_name text) returns text
language sql as $$
  select l.membership_status from public.list_vendor_users() l where l.display_name = p_name;
$$;

create function pg_temp.list_role_names(p_name text) returns text[]
language sql as $$
  select l.role_names from public.list_vendor_users() l where l.display_name = p_name;
$$;

create function pg_temp.list_membership_id(p_name text) returns uuid
language sql as $$
  select l.membership_id from public.list_vendor_users() l where l.display_name = p_name;
$$;

create function pg_temp.detail_count(p_membership uuid) returns bigint
language sql as $$
  select count(*) from public.get_vendor_user_detail(p_membership);
$$;


-- ============================================================================
-- Fixtures
-- ============================================================================
-- Deterministic: every name, status and role below is written explicitly, and nothing
-- depends on seeded tenant data (there is none) or on ordering the functions choose.

create table pg_temp.fx (k text primary key, v uuid);

insert into pg_temp.fx (k, v) values
  ('vendor_a', pg_temp.new_org('Vendor A')),
  ('vendor_b', pg_temp.new_org('Vendor B')),
  ('vendor_c', pg_temp.new_org('Vendor C')),
  ('alpha',    pg_temp.new_org('Alpha Retail', 'RETAILER', 'ACTIVE'));

create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.fx where k = p_k; $$;

-- An INACTIVE role DEFINITION. A membership may still hold it — member_roles has no status
-- filter of its own — and the contract says such a role must NOT be advertised as live,
-- exactly as lib/members/vendor-organization-members.ts filters `roles.status = 'ACTIVE'`.
insert into public.roles (code, name, description, status)
values ('LEGACY_VENDOR_ROLE', 'Legacy Vendor Role', 'Retired role definition.', 'INACTIVE');

-- People. NOTE THE INSERTION ORDER: Zoe is created FIRST and sorts LAST, so a function
-- returning rows in physical order would fail every ordering assertion in Section C.
insert into pg_temp.fx (k, v) values
  ('zoe',      pg_temp.new_person('Zoe',  'Multirole')),
  ('ada',      pg_temp.new_person('Ada',  'Admin')),
  ('bob',      pg_temp.new_person('Bob',  'Suspended', 'SUSPENDED')),
  ('cara',     pg_temp.new_person('Cara', 'Deactivated')),
  ('dan',      pg_temp.new_person('Dan',  'Invited', 'INVITED')),
  ('eve',      pg_temp.new_person('Eve',  'Noroles')),
  ('fay',      pg_temp.new_person('Fay',  'Legacyrole')),
  -- Vendor B's people, whom Vendor A must never see.
  ('gil',      pg_temp.new_person('Gil',  'Bravo')),
  ('hal',      pg_temp.new_person('Hal',  'Bee')),
  -- Vendor C's single administrator: the "no other users" case.
  ('ivy',      pg_temp.new_person('Ivy',  'Solo')),
  -- Retailer people, every one of whom must be refused.
  ('owner',    pg_temp.new_person('Ora',  'Owner')),
  ('manager',  pg_temp.new_person('Mia',  'Manager')),
  ('staff',    pg_temp.new_person('Sam',  'Staff')),
  -- Authenticated, but a member of nothing at all.
  ('no_org',   pg_temp.new_person('Ned',  'Noorg'));

-- Vendor A memberships. Every lifecycle state is represented, because none is filtered.
insert into pg_temp.fx (k, v) values
  ('m_ada',  pg_temp.add_member(pg_temp.fx('ada'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_zoe',  pg_temp.add_member(pg_temp.fx('zoe'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  -- ACTIVE membership, SUSPENDED profile: two independent facts, both reported.
  ('m_bob',  pg_temp.add_member(pg_temp.fx('bob'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  -- DEACTIVATED membership of an ACTIVE profile, with the timestamp the detail read returns.
  ('m_cara', pg_temp.add_member(pg_temp.fx('cara'), pg_temp.fx('vendor_a'), 'DEACTIVATED',
                                now() - interval '2 days')),
  -- The only "invited/pending" state this schema has for a Vendor user.
  ('m_dan',  pg_temp.add_member(pg_temp.fx('dan'),  pg_temp.fx('vendor_a'), 'INVITED')),
  ('m_eve',  pg_temp.add_member(pg_temp.fx('eve'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_fay',  pg_temp.add_member(pg_temp.fx('fay'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_gil',  pg_temp.add_member(pg_temp.fx('gil'),  pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_hal',  pg_temp.add_member(pg_temp.fx('hal'),  pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_ivy',  pg_temp.add_member(pg_temp.fx('ivy'),  pg_temp.fx('vendor_c'), 'ACTIVE')),
  ('m_owner',   pg_temp.add_member(pg_temp.fx('owner'),   pg_temp.fx('alpha'), 'ACTIVE')),
  ('m_manager', pg_temp.add_member(pg_temp.fx('manager'), pg_temp.fx('alpha'), 'ACTIVE')),
  ('m_staff',   pg_temp.add_member(pg_temp.fx('staff'),   pg_temp.fx('alpha'), 'ACTIVE'));

-- Role assignments.
--
-- Ada is the authorized caller for Vendor A. Bob and Cara ALSO hold VENDOR_SUPER_ADMIN, so
-- they double as the "inactive caller profile" and "inactive caller membership" denials in
-- Section E while remaining ordinary listed targets in Section F — the same person cannot
-- be authorized and unauthorized, and asserting both about the same fixture is what proves
-- the ACTIVE requirements are the reason.
select pg_temp.add_role(pg_temp.fx('m_ada'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_bob'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_cara'), 'VENDOR_SUPER_ADMIN');

-- Zoe holds TWO roles. They are assigned in REVERSE alphabetical order so that the
-- role_names ordering assertion tests the aggregate's ORDER BY rather than insertion order.
select pg_temp.add_role(pg_temp.fx('m_zoe'), 'FINANCE_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_zoe'), 'CLAIM_REVIEWER');

-- Fay holds ONLY the INACTIVE definition -> her role list must come back empty, not
-- populated with a retired role name.
select pg_temp.add_role(pg_temp.fx('m_fay'), 'LEGACY_VENDOR_ROLE');

-- Dan (INVITED) and Eve hold no role at all.

select pg_temp.add_role(pg_temp.fx('m_gil'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_hal'), 'CLAIM_REVIEWER');
select pg_temp.add_role(pg_temp.fx('m_ivy'), 'VENDOR_SUPER_ADMIN');

select pg_temp.add_role(pg_temp.fx('m_owner'),   'RETAILER_OWNER');
select pg_temp.add_role(pg_temp.fx('m_manager'), 'RETAILER_MANAGER');
select pg_temp.add_role(pg_temp.fx('m_staff'),   'SALES_STAFF');


-- ============================================================================
-- SECTION A — signature, security attributes and privileges (catalogue-level)
-- ============================================================================
-- Asserted against the catalogue rather than inferred from behaviour: "it did not error
-- for me" is not a privilege check, and a grant that widened by accident would still let
-- every behavioural test pass.

select has_function('public', 'list_vendor_users', '{}'::text[],
  'list_vendor_users() exists and takes no arguments');
select has_function('public', 'get_vendor_user_detail', array['uuid'],
  'get_vendor_user_detail(uuid) exists');

-- NO IDENTITY, VENDOR, TENANT, ROLE OR PERMISSION ARGUMENT ON EITHER READ.
select is(pg_temp.input_args('list_vendor_users'), '{}'::text[],
  'list_vendor_users() accepts no client input at all');
select is(pg_temp.input_args('get_vendor_user_detail'), array['p_membership_id'],
  'get_vendor_user_detail takes exactly one input: the membership selector');

-- Exact output shape. A positional `returns table` contract is only stable if the column
-- list is pinned, and pinning it is what makes an accidental addition a test failure rather
-- than a silently broken pinned mobile build.
select is(
  pg_temp.table_columns('list_vendor_users'),
  array['membership_id', 'display_name', 'profile_status', 'membership_status',
        'membership_created_at', 'joined_at', 'role_names'],
  'list_vendor_users() returns exactly the seven agreed columns, in order');

select is(
  pg_temp.table_columns('get_vendor_user_detail'),
  array['membership_id', 'display_name', 'profile_status', 'membership_status',
        'membership_created_at', 'joined_at', 'deactivated_at', 'role_names'],
  'get_vendor_user_detail() returns exactly the eight agreed columns, in order');

-- The detail contract is the list contract PLUS deactivated_at, and nothing else. Stated
-- as a relationship rather than as two literal arrays, so the two can never drift apart
-- without this failing.
select is(
  (select array_agg(c order by c) from unnest(pg_temp.table_columns('get_vendor_user_detail')) c
   where c <> 'deactivated_at'),
  (select array_agg(c order by c) from unnest(pg_temp.table_columns('list_vendor_users')) c),
  'the detail column set is the list column set plus deactivated_at, exactly');

-- FORBIDDEN FIELDS. The exact-column assertions above already exclude these; this states
-- the rule directly so the reason survives a future column addition.
select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_users')
     || pg_temp.table_columns('get_vendor_user_detail')) c
   where c ~ 'token|hash|secret|password|provider|session|ip_address|invitation|auth_user|user_id|profile_id|organization_id|tenant'),
  0::bigint,
  'no output column names a token, hash, secret, password, provider, session, invitation, auth user, profile or organization id');

select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_users')
     || pg_temp.table_columns('get_vendor_user_detail')) c
   where c ~ 'permission|role_id|role_code|role_codes'),
  0::bigint,
  'no output column carries permission internals or raw role identifiers — role NAMES only');

select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_users')
     || pg_temp.table_columns('get_vendor_user_detail')) c
   where c ~ 'email|mobile|phone'),
  0::bigint,
  'neither read returns an email address or a phone number — the web Vendor Users page shows neither');

-- Security attributes.
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='list_vendor_users'), true,
  'list_vendor_users is SECURITY DEFINER');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_vendor_user_detail'), true,
  'get_vendor_user_detail is SECURITY DEFINER');

-- `set search_path = ''` is stored by PostgreSQL as the literal `search_path=""` — the
-- empty string, quoted. Asserting `search_path=` (unquoted) would match nothing and the
-- test would fail even on a correctly-hardened function.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public'
     and p.proname in ('list_vendor_users','get_vendor_user_detail')
     and p.proconfig @> array['search_path=""']),
  2::bigint,
  'both functions pin an EMPTY search_path');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public'
     and p.proname in ('list_vendor_users','get_vendor_user_detail')
     and p.provolatile = 's'),
  2::bigint,
  'both functions are STABLE — neither may write');

-- Grants: authenticated yes, anon no, PUBLIC no, service_role no.
select ok(has_function_privilege('authenticated', 'public.list_vendor_users()', 'execute'),
  'authenticated may execute list_vendor_users()');
select ok(has_function_privilege('authenticated', 'public.get_vendor_user_detail(uuid)', 'execute'),
  'authenticated may execute get_vendor_user_detail(uuid)');

select ok(not has_function_privilege('anon', 'public.list_vendor_users()', 'execute'),
  'anon may NOT execute list_vendor_users()');
select ok(not has_function_privilege('anon', 'public.get_vendor_user_detail(uuid)', 'execute'),
  'anon may NOT execute get_vendor_user_detail(uuid)');

-- PUBLIC holds nothing. A PUBLIC grant appears in proacl as an entry with an empty grantee
-- ("=X/owner"), and PUBLIC is inherited by every role — so a leftover default grant would
-- hand anon EXECUTE despite the explicit revokes.
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where n.nspname='public'
     and p.proname in ('list_vendor_users','get_vendor_user_detail')
     and a::text like '=%'),
  0::bigint,
  'PUBLIC holds EXECUTE on neither function');

select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where n.nspname='public'
     and p.proname in ('list_vendor_users','get_vendor_user_detail')
     and a::text like 'service_role=%'),
  0::bigint,
  'service_role is granted neither function — both derive authority from auth.uid()');

-- NO BROAD TABLE GRANTS, AND NO WEAKENED RLS. This migration must not have made any Flutter
-- read easier by opening a table.
-- RLS is still ENABLED on every table these reads touch. A SECURITY DEFINER function is
-- allowed to run outside those policies; what must never happen is the policies being
-- switched off so that a direct PostgREST select becomes an easier path than the contract.
select ok((select relrowsecurity from pg_class where oid = 'public.organization_members'::regclass),
  'public.organization_members still has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'public.profiles still has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.member_roles'::regclass),
  'public.member_roles still has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.roles'::regclass),
  'public.roles still has RLS enabled');

-- The four migration-5 read policies these functions stand in for are all still present and
-- unmodified in name.
select is(
  (select count(*) from pg_policies
   where schemaname = 'public'
     and policyname in ('profiles_select_self_or_authorized_members',
                        'organization_members_select_self_or_authorized',
                        'member_roles_select_self_or_rbac_authorized',
                        'roles_select_rbac_authorized')),
  4::bigint,
  'the four migration-5 read policies for users and roles are still in place');
select ok(not has_table_privilege('anon', 'public.profiles', 'select'),
  'anon still holds no privilege on public.profiles');
select ok(not has_table_privilege('authenticated', 'public.retailer_invitations', 'select'),
  'public.retailer_invitations remains unreadable by authenticated');
select ok(not has_table_privilege('authenticated', 'public.retailer_staff_invitations', 'select'),
  'public.retailer_staff_invitations remains unreadable by authenticated');

-- THE SCHEMA HAS NO VENDOR USER INVITATION TABLE. This is the assertion the "should
-- invitations be in the list?" audit question resolves to: there is nothing to list.
-- The exact set, not a count: naming it is what makes the claim readable, and it fails
-- loudly the day a Vendor user invitation table is added — which is exactly when this
-- milestone's "there are no invitations to list" contract stops being true.
select is(
  -- relname is `name`, not `text`; without the cast pgTAP finds no is(name[], text[]) and
  -- the whole file aborts rather than failing one assertion.
  (select array_agg(c.relname::text order by c.relname)
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relname like '%invitation%'),
  array['retailer_invitation_shop_assignments', 'retailer_invitations',
        'retailer_staff_invitations'],
  'every invitation table in the schema is Retailer-scoped — none invites a user into a Vendor organization');

select ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'retailer_staff_invitations'
      and column_name = 'vendor_organization_id'),
  'retailer_staff_invitations has no Vendor scope at all');


-- ============================================================================
-- SECTION B — signed-out callers are denied by both reads
-- ============================================================================
select pg_temp.sign_out();

select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'signed-out caller is denied the Vendor user list');
select is(pg_temp.sqlstate_of('select * from public.get_vendor_user_detail(gen_random_uuid())'), '42501',
  'signed-out caller is denied the Vendor user detail');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_user_detail(%L)', pg_temp.fx('m_ada'))), '42501',
  'signed-out caller is denied even for a membership id that really exists');


-- ============================================================================
-- SECTION C — a Vendor Super Admin sees their OWN Vendor's users, in a stable order
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is(
  pg_temp.my_user_names(),
  array['Ada Admin', 'Bob Suspended', 'Cara Deactivated', 'Dan Invited',
        'Eve Noroles', 'Fay Legacyrole', 'Zoe Multirole'],
  'Vendor A lists exactly its seven users, ordered by display name (Zoe was inserted first and sorts last)');

select is((select count(*) from public.list_vendor_users()), 7::bigint,
  'seven rows — one per membership, never one per role assignment');

select is(pg_temp.my_user_names(), pg_temp.my_user_names(),
  'the ordering is stable across repeated calls');

select ok(
  not exists (select 1 from public.list_vendor_users() l where l.display_name in ('Gil Bravo', 'Hal Bee')),
  'Vendor A cannot see Vendor B''s users');

select ok(
  not exists (select 1 from public.list_vendor_users() l where l.display_name in ('Ora Owner', 'Mia Manager', 'Sam Staff')),
  'Vendor A cannot see Retailer staff — the list is Vendor-organization users only');

select is(pg_temp.list_membership_id('Ada Admin'), pg_temp.fx('m_ada'),
  'the membership id returned is the organization_members row id, not a profile or auth id');

select ok(
  (select l.membership_created_at from public.list_vendor_users() l where l.display_name = 'Ada Admin') is not null,
  'the membership creation date is returned');

select pg_temp.act_as(pg_temp.fx('gil'));

select is(pg_temp.my_user_names(), array['Gil Bravo', 'Hal Bee'],
  'Vendor B lists only its own two users');

select ok(
  not exists (select 1 from public.list_vendor_users() l where l.display_name = 'Ada Admin'),
  'Vendor B cannot see Vendor A''s users');

-- Vendor C's administrator is the only member of Vendor C. This is the honest form of the
-- "no users" case: an authorized caller is BY DEFINITION an ACTIVE member of the Vendor
-- they are listing, so their own row is always present and the result is never empty.
select pg_temp.act_as(pg_temp.fx('ivy'));
select is(pg_temp.my_user_names(), array['Ivy Solo'],
  'a Vendor whose only user is its administrator returns exactly that one row');
select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), null,
  'and that is a normal return, not a swallowed error');


-- ============================================================================
-- SECTION D — every non-Vendor role, and every non-member, is denied
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('owner'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'a Retailer Owner is denied the Vendor user list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_user_detail(%L)', pg_temp.fx('m_owner'))), '42501',
  'a Retailer Owner is denied the detail — even for their OWN membership');

select pg_temp.act_as(pg_temp.fx('manager'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'a Retailer Manager is denied the Vendor user list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_user_detail(%L)', pg_temp.fx('m_ada'))), '42501',
  'a Retailer Manager is denied the detail');

select pg_temp.act_as(pg_temp.fx('staff'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'a Sales Staff member is denied the Vendor user list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_user_detail(%L)', pg_temp.fx('m_staff'))), '42501',
  'a Sales Staff member is denied the detail');

select pg_temp.act_as(pg_temp.fx('no_org'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'an authenticated user with no organization at all is denied');

-- A Vendor A member in good standing who simply does not hold VENDOR_SUPER_ADMIN. This is
-- the "Vendor user without the required authority" case, and it is the one that matters
-- most: she is inside the tenant.
select pg_temp.act_as(pg_temp.fx('zoe'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'a Vendor user holding only CLAIM_REVIEWER and FINANCE_ADMIN is denied the list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_user_detail(%L)', pg_temp.fx('m_zoe'))), '42501',
  'that same Vendor user cannot even read her own membership through this contract');

select pg_temp.act_as(pg_temp.fx('eve'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'a Vendor member with NO role at all is denied — an absent role is never a default grant');


-- ============================================================================
-- SECTION E — an inactive Vendor profile or membership is denied as a CALLER
-- ============================================================================
-- Bob and Cara both hold VENDOR_SUPER_ADMIN in Vendor A. Bob's profile is SUSPENDED and
-- Cara's membership is DEACTIVATED, and each is refused for that reason alone. Section F
-- then shows the very same rows being LISTED, which is what proves the ACTIVE requirements
-- govern who may call and not who may be seen.
select pg_temp.act_as(pg_temp.fx('bob'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'a SUSPENDED profile holding VENDOR_SUPER_ADMIN is denied the list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_user_detail(%L)', pg_temp.fx('m_ada'))), '42501',
  'a SUSPENDED profile is denied the detail');

select pg_temp.act_as(pg_temp.fx('cara'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'a DEACTIVATED membership holding VENDOR_SUPER_ADMIN is denied the list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_user_detail(%L)', pg_temp.fx('m_ada'))), '42501',
  'a DEACTIVATED membership is denied the detail');


-- ============================================================================
-- SECTION F — statuses are accurate and no lifecycle state is hidden
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.list_membership_status('Ada Admin'),        'ACTIVE',      'ACTIVE membership reported accurately');
select is(pg_temp.list_membership_status('Cara Deactivated'), 'DEACTIVATED', 'a DEACTIVATED membership is listed, not hidden');
select is(pg_temp.list_membership_status('Dan Invited'),      'INVITED',     'an INVITED membership is listed — this is how a not-yet-active Vendor user appears');
select is(pg_temp.list_membership_status('Bob Suspended'),    'ACTIVE',      'membership status is independent of profile status');

select is(pg_temp.list_profile_status('Ada Admin'),        'ACTIVE',    'ACTIVE profile reported accurately');
select is(pg_temp.list_profile_status('Bob Suspended'),    'SUSPENDED', 'a SUSPENDED profile is listed with its own status');
select is(pg_temp.list_profile_status('Dan Invited'),      'INVITED',   'an INVITED profile is reported as INVITED');
select is(pg_temp.list_profile_status('Cara Deactivated'), 'ACTIVE',    'profile status is independent of membership status');

-- joined_at is present for a real membership and absent for one that never joined.
select ok(
  (select l.joined_at from public.list_vendor_users() l where l.display_name = 'Ada Admin') is not null,
  'joined_at is returned for a membership that has joined');
select ok(
  (select l.joined_at from public.list_vendor_users() l where l.display_name = 'Dan Invited') is null,
  'joined_at is NULL for an INVITED membership that has not joined — not fabricated');


-- ============================================================================
-- SECTION G — role representation
-- ============================================================================
select is(pg_temp.list_role_names('Ada Admin'), array['Vendor Super Admin'],
  'a single role is returned as a one-element array of role NAMES');

select is(pg_temp.list_role_names('Zoe Multirole'), array['Claim Reviewer', 'Finance Admin'],
  'multiple roles are returned in one array, ordered by name (they were assigned in reverse)');

select is((select count(*) from public.list_vendor_users() l where l.display_name = 'Zoe Multirole'), 1::bigint,
  'two role assignments produce ONE user row, never two');

select is(pg_temp.list_role_names('Eve Noroles'), '{}'::text[],
  'a user with no role gets an EMPTY array');

select ok(pg_temp.list_role_names('Eve Noroles') is not null,
  'and that empty array is not NULL — a client never has to branch on null');

select ok(not ('Vendor Super Admin' = any (pg_temp.list_role_names('Eve Noroles'))),
  'a missing role is NEVER defaulted to Vendor Super Admin');

select is(pg_temp.list_role_names('Fay Legacyrole'), '{}'::text[],
  'an INACTIVE role DEFINITION is not advertised as a live role, matching the web');

select ok(
  not exists (
    select 1 from public.list_vendor_users() l
    where 'Legacy Vendor Role' = any (l.role_names)),
  'the retired role name appears nowhere in the directory');

-- No role CODE ever leaks through the names array.
select ok(
  not exists (
    select 1 from public.list_vendor_users() l, unnest(l.role_names) n
    where n in ('VENDOR_SUPER_ADMIN', 'CLAIM_REVIEWER', 'FINANCE_ADMIN')),
  'role_names carries display names only — never the internal role codes');


-- ============================================================================
-- SECTION H — detail: one row for your own, ZERO ROWS for anything else
-- ============================================================================
-- The security property of this section is that all four "no" answers are byte-identical.
select is(pg_temp.detail_count(pg_temp.fx('m_zoe')), 1::bigint,
  'an authorized Vendor reads one of its OWN memberships');

select is(pg_temp.detail_count(pg_temp.fx('m_gil')), 0::bigint,
  'another Vendor''s membership yields ZERO ROWS, not a refusal');

select is(pg_temp.detail_count(pg_temp.fx('m_owner')), 0::bigint,
  'a Retailer membership id yields zero rows — the id exists, but not in this organization');

select is(pg_temp.detail_count(gen_random_uuid()), 0::bigint,
  'an id that names no row at all yields zero rows');

select is(pg_temp.detail_count(null), 0::bigint,
  'a null selector yields zero rows');

select is(
  pg_temp.sqlstate_of(format('select * from public.get_vendor_user_detail(%L)', pg_temp.fx('m_gil'))),
  pg_temp.sqlstate_of('select * from public.get_vendor_user_detail(gen_random_uuid())'),
  'a foreign membership and an unknown id are INDISTINGUISHABLE — both return normally');

select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_user_detail(%L)', pg_temp.fx('m_gil'))), null,
  'and neither is an error — nothing reveals that another Vendor''s user exists');

-- The mirror image, from Vendor B's side.
select pg_temp.act_as(pg_temp.fx('gil'));
select is(pg_temp.detail_count(pg_temp.fx('m_ada')), 0::bigint,
  'Vendor B cannot read Vendor A''s membership either — isolation is symmetric');
select is(pg_temp.detail_count(pg_temp.fx('m_hal')), 1::bigint,
  'but Vendor B reads its own membership normally');


-- ============================================================================
-- SECTION I — detail content is correct and agrees with the list
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is((select d.display_name from public.get_vendor_user_detail(pg_temp.fx('m_zoe')) d),
  'Zoe Multirole', 'detail returns the composed display name');

select is((select d.role_names from public.get_vendor_user_detail(pg_temp.fx('m_zoe')) d),
  array['Claim Reviewer', 'Finance Admin'],
  'detail returns all assigned roles, ordered exactly as the list orders them');

select is((select d.role_names from public.get_vendor_user_detail(pg_temp.fx('m_fay')) d),
  '{}'::text[],
  'detail applies the same ACTIVE-role filter as the list');

select is((select d.profile_status from public.get_vendor_user_detail(pg_temp.fx('m_bob')) d),
  'SUSPENDED', 'detail reports the target profile status');

select is((select d.membership_status from public.get_vendor_user_detail(pg_temp.fx('m_cara')) d),
  'DEACTIVATED', 'detail reports the target membership status');

select is((select d.membership_id from public.get_vendor_user_detail(pg_temp.fx('m_cara')) d),
  pg_temp.fx('m_cara'), 'detail echoes the membership id it was given, once it is authorized');

select ok((select d.deactivated_at from public.get_vendor_user_detail(pg_temp.fx('m_cara')) d) is not null,
  'deactivated_at is returned for a DEACTIVATED membership');

select ok((select d.deactivated_at from public.get_vendor_user_detail(pg_temp.fx('m_ada')) d) is null,
  'deactivated_at is NULL for a live membership — never fabricated');

select ok((select d.joined_at from public.get_vendor_user_detail(pg_temp.fx('m_dan')) d) is null,
  'detail reports a NULL joined_at for an INVITED membership');

-- The list and the detail must never disagree about the same person.
select is(
  (select d.display_name from public.get_vendor_user_detail(pg_temp.fx('m_bob')) d),
  (select l.display_name from public.list_vendor_users() l where l.membership_id = pg_temp.fx('m_bob')),
  'list and detail agree on the display name');

select is(
  (select d.role_names from public.get_vendor_user_detail(pg_temp.fx('m_ada')) d),
  pg_temp.list_role_names('Ada Admin'),
  'list and detail agree on the role array');

select is(
  (select d.membership_created_at from public.get_vendor_user_detail(pg_temp.fx('m_ada')) d),
  (select l.membership_created_at from public.list_vendor_users() l where l.membership_id = pg_temp.fx('m_ada')),
  'list and detail agree on the membership creation timestamp');


-- ============================================================================
-- SECTION J — no cross-organization data reaches either read
-- ============================================================================
-- Hal is given a SECOND membership, in Vendor A, holding a different role. A profile that
-- belongs to more than one organization must contribute exactly the membership of the
-- organization being read — never a merged view of both.
insert into pg_temp.fx (k, v) values
  ('m_hal_a', pg_temp.add_member(pg_temp.fx('hal'), pg_temp.fx('vendor_a'), 'ACTIVE'));
select pg_temp.add_role(pg_temp.fx('m_hal_a'), 'FINANCE_ADMIN');

select is((select count(*) from public.list_vendor_users() l where l.display_name = 'Hal Bee'), 1::bigint,
  'a person who belongs to two organizations appears ONCE in this Vendor''s list');

select is(pg_temp.list_membership_id('Hal Bee'), pg_temp.fx('m_hal_a'),
  'and it is THIS Vendor''s membership id, not the other organization''s');

select is(pg_temp.list_role_names('Hal Bee'), array['Finance Admin'],
  'only the roles assigned through THIS Vendor''s membership are returned — the other organization''s role is absent');

select is((select d.role_names from public.get_vendor_user_detail(pg_temp.fx('m_hal_a')) d),
  array['Finance Admin'],
  'detail applies the same per-membership role scoping');

select is((select count(*) from public.list_vendor_users()), 8::bigint,
  'the list grew by exactly one row, not by a duplicate of an existing person');


-- ============================================================================
-- SECTION K — the permission requirement is real, not decorative
-- ============================================================================
-- Both functions are SECURITY DEFINER and therefore run outside the RLS policies that
-- normally require ORGANIZATION_MEMBERS_READ and RBAC_READ. The explicit permission checks
-- are what stand in for those policies, and this section proves they are load-bearing by
-- removing a seeded mapping and watching an otherwise-perfect Vendor Super Admin be
-- refused. The delete is rolled back with the rest of the transaction.
delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.code = 'VENDOR_SUPER_ADMIN'
  and p.code = 'RBAC_READ';

select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'a Vendor Super Admin whose role no longer grants RBAC_READ is denied the list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_user_detail(%L)', pg_temp.fx('m_ada'))), '42501',
  'and is denied the detail for the same reason');

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id
  and rp.permission_id = p.id
  and r.code = 'VENDOR_SUPER_ADMIN'
  and p.code = 'ORGANIZATION_MEMBERS_READ';

select is(pg_temp.sqlstate_of('select * from public.list_vendor_users()'), '42501',
  'removing ORGANIZATION_MEMBERS_READ as well keeps the denial — both permissions are required');


select finish();

rollback;
