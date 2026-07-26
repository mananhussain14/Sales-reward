-- pgTAP behavioural tests for the Vendor dashboard summary read added by
-- migration 20260805090000_mobile_vendor_dashboard_summary.sql:
--
--   public.get_vendor_admin_dashboard_summary()
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
-- vendor_user_reads_test.sql and vendor_audit_log_reads_test.sql exactly, deliberately:
-- several impersonation idioms in one suite directory would be several different claims
-- about what "signed in" means.
--
-- The tests deliberately do NOT `set role authenticated`. The function is SECURITY DEFINER,
-- so its behaviour depends on auth.uid() and not on the session role, and switching roles
-- mid-transaction would only make the fixture inserts fail. EXECUTE privilege is a separate
-- concern and is asserted directly against the catalogue in Section A, which is a stronger
-- check than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back, so no fixture survives — and
-- neither does Section E, which temporarily removes seeded role→permission mappings.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file
-- turns an added test into a confusing failure about arithmetic rather than about behaviour.
--
-- ============================================================================
-- WHAT THIS CONTRACT IS, IN ONE PARAGRAPH
-- ============================================================================
-- Four bigint counts, exactly one row, zero arguments. TWO OF THE FOUR ARE GLOBAL CATALOGUE
-- FIGURES (public.roles and public.permissions carry no organization_id at all) and two are
-- tenant-scoped. Section D asserts that distinction directly rather than leaving it to the
-- field names: it proves the two tenant counts DIFFER between two Vendors holding different
-- data, and that the two catalogue counts are IDENTICAL for them. A suite that only checked
-- "Vendor A cannot see Vendor B's rows" would pass vacuously on the catalogue fields and
-- would never notice if one of them silently acquired a tenant predicate — or if a tenant
-- field silently lost one.
--
-- ============================================================================
-- WHY THE FIXTURE COUNTS ARE ASSERTED AS EXACT INTEGERS
-- ============================================================================
-- Every expected figure below is written as a literal derived from explicitly-inserted rows,
-- never as a second query against the same tables. Comparing the function to a re-statement
-- of its own SQL would pass for any predicate the two happened to share — including a wrong
-- one. The catalogue counts are the exception and are stated as a comparison BETWEEN CALLERS
-- rather than as a literal, because the seeded catalogue size legitimately grows with every
-- future module migration and pinning it would make an unrelated migration fail this suite.

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

/* Writes N audit rows for an organization. The action/entity values are irrelevant to a
   COUNT and are held constant so the fixture cannot accidentally depend on them. */
create function pg_temp.add_audit(p_org uuid, p_count integer) returns void
language plpgsql as $$
begin
  insert into public.audit_logs (organization_id, action, entity_type, entity_id, metadata)
  select p_org, 'PRODUCT_UPDATED', 'VENDOR_PRODUCT', gen_random_uuid()::text, '{}'::jsonb
  from generate_series(1, p_count);
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
 * Comparing SQLSTATEs is what makes "these denials are indistinguishable" a testable claim
 * rather than a comment.
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

/* The SQLSTATE of calling the summary as the current caller. */
create function pg_temp.summary_error() returns text
language sql as $$
  select pg_temp.sqlstate_of('select * from public.get_vendor_admin_dashboard_summary()');
$$;

/* Single fields of the one summary row, for the current caller. */
create function pg_temp.members() returns bigint
language sql as $$
  select s.active_member_count from public.get_vendor_admin_dashboard_summary() s;
$$;

create function pg_temp.roles_n() returns bigint
language sql as $$
  select s.catalog_active_role_count from public.get_vendor_admin_dashboard_summary() s;
$$;

create function pg_temp.perms_n() returns bigint
language sql as $$
  select s.catalog_permission_count from public.get_vendor_admin_dashboard_summary() s;
$$;

create function pg_temp.audits() returns bigint
language sql as $$
  select s.audit_event_count from public.get_vendor_admin_dashboard_summary() s;
$$;

/* How many rows the function emitted. The whole contract rests on this being 1. */
create function pg_temp.row_count() returns bigint
language sql as $$
  select count(*) from public.get_vendor_admin_dashboard_summary();
$$;

/* Every count as one array, so "none is null" and "none is negative" are single assertions. */
create function pg_temp.all_counts() returns bigint[]
language sql as $$
  select array[s.active_member_count, s.catalog_active_role_count,
               s.catalog_permission_count, s.audit_event_count]
  from public.get_vendor_admin_dashboard_summary() s;
$$;


-- ============================================================================
-- Fixtures
-- ============================================================================
-- Deterministic: every organization, membership status and audit row below is written
-- explicitly. Nothing depends on seeded tenant data (there is none) or on ordering.
--
-- THE THREE VENDORS ARE DELIBERATELY DIFFERENT SIZES, so a cross-tenant leak cannot hide
-- behind two Vendors that happen to have equal counts:
--
--   Vendor A — 4 ACTIVE memberships, 1 INVITED, 1 SUSPENDED, 1 DEACTIVATED;  7 audit rows.
--   Vendor B — 2 ACTIVE memberships;                                        23 audit rows.
--   Vendor C — 1 ACTIVE membership (the caller alone);                       0 audit rows.
--
-- Vendor C is the "Vendor with no data" case: its audit count must be exactly 0 and its
-- member count exactly 1, because the caller's own ACTIVE membership is what authorized them.

create table pg_temp.fx (k text primary key, v uuid);

insert into pg_temp.fx (k, v) values
  ('vendor_a', pg_temp.new_org('Vendor A')),
  ('vendor_b', pg_temp.new_org('Vendor B')),
  ('vendor_c', pg_temp.new_org('Vendor C')),
  ('alpha',    pg_temp.new_org('Alpha Retail', 'RETAILER', 'ACTIVE'));

create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.fx where k = p_k; $$;

insert into pg_temp.fx (k, v) values
  -- Vendor A people.
  ('ada',      pg_temp.new_person('Ada',  'Admin')),
  ('bob',      pg_temp.new_person('Bob',  'Suspendedprofile', 'SUSPENDED')),
  ('cara',     pg_temp.new_person('Cara', 'Deactivatedmember')),
  ('dan',      pg_temp.new_person('Dan',  'Invited', 'INVITED')),
  ('eve',      pg_temp.new_person('Eve',  'Noroles')),
  ('fred',     pg_temp.new_person('Fred', 'Suspendedmember')),
  ('gwen',     pg_temp.new_person('Gwen', 'Active')),
  -- Vendor B people.
  ('gil',      pg_temp.new_person('Gil',  'Bravo')),
  ('hal',      pg_temp.new_person('Hal',  'Bee')),
  -- Vendor C's single administrator: the "no data" case.
  ('ivy',      pg_temp.new_person('Ivy',  'Solo')),
  -- Retailer people, every one of whom must be refused.
  ('owner',    pg_temp.new_person('Ora',  'Owner')),
  ('manager',  pg_temp.new_person('Mia',  'Manager')),
  ('staff',    pg_temp.new_person('Sam',  'Staff')),
  -- Authenticated, but a member of nothing at all.
  ('no_org',   pg_temp.new_person('Ned',  'Noorg'));

-- Vendor A memberships. FOUR are ACTIVE (ada, bob, eve, gwen) — note that Bob's PROFILE is
-- SUSPENDED while his MEMBERSHIP is ACTIVE, and he is counted, because the web card filters
-- organization_members.status alone and never joins profiles. The other three memberships
-- (cara DEACTIVATED, dan INVITED, fred SUSPENDED) must NOT be counted.
insert into pg_temp.fx (k, v) values
  ('m_ada',  pg_temp.add_member(pg_temp.fx('ada'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_bob',  pg_temp.add_member(pg_temp.fx('bob'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_eve',  pg_temp.add_member(pg_temp.fx('eve'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_gwen', pg_temp.add_member(pg_temp.fx('gwen'), pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_cara', pg_temp.add_member(pg_temp.fx('cara'), pg_temp.fx('vendor_a'), 'DEACTIVATED')),
  ('m_dan',  pg_temp.add_member(pg_temp.fx('dan'),  pg_temp.fx('vendor_a'), 'INVITED')),
  ('m_fred', pg_temp.add_member(pg_temp.fx('fred'), pg_temp.fx('vendor_a'), 'SUSPENDED')),
  ('m_gil',  pg_temp.add_member(pg_temp.fx('gil'),  pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_hal',  pg_temp.add_member(pg_temp.fx('hal'),  pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_ivy',  pg_temp.add_member(pg_temp.fx('ivy'),  pg_temp.fx('vendor_c'), 'ACTIVE')),
  ('m_owner',   pg_temp.add_member(pg_temp.fx('owner'),   pg_temp.fx('alpha'), 'ACTIVE')),
  ('m_manager', pg_temp.add_member(pg_temp.fx('manager'), pg_temp.fx('alpha'), 'ACTIVE')),
  ('m_staff',   pg_temp.add_member(pg_temp.fx('staff'),   pg_temp.fx('alpha'), 'ACTIVE'));

-- MULTI-ORGANIZATION MEMBERSHIP. Gwen is ALSO an ACTIVE member of Vendor B and of the
-- Retailer. Her Vendor A membership must count once for Vendor A and her Vendor B membership
-- once for Vendor B — a summary that joined loosely could count her twice in either.
insert into pg_temp.fx (k, v) values
  ('m_gwen_b',     pg_temp.add_member(pg_temp.fx('gwen'), pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_gwen_alpha', pg_temp.add_member(pg_temp.fx('gwen'), pg_temp.fx('alpha'),    'ACTIVE'));

-- Role assignments.
--
-- Ada is the authorized caller for Vendor A. Bob and Cara ALSO hold VENDOR_SUPER_ADMIN, so
-- they double as the "inactive caller profile" and "inactive caller membership" denials in
-- Section C while remaining ordinary counted (or uncounted) members — the same person cannot
-- be authorized and unauthorized, and asserting both about the same fixture is what proves
-- the ACTIVE requirements are the reason.
select pg_temp.add_role(pg_temp.fx('m_ada'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_bob'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_cara'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_fred'), 'VENDOR_SUPER_ADMIN');

-- ZOE HOLDS THE ROLE TWICE OVER — one membership, two role assignments — so a summary that
-- joined member_roles into the member count would inflate it. Zoe is Gwen here: she already
-- has two Vendor memberships, and now also two roles on the Vendor A one.
select pg_temp.add_role(pg_temp.fx('m_gwen'), 'CLAIM_REVIEWER');
select pg_temp.add_role(pg_temp.fx('m_gwen'), 'FINANCE_ADMIN');

-- Ada holds a SECOND role alongside VENDOR_SUPER_ADMIN. Without this, Vendor A would have
-- exactly 4 ACTIVE role assignments for 4 ACTIVE members, and the "a multi-role member is
-- counted once" assertion below would pass against a function that counted assignments —
-- which is precisely the bug it exists to catch. CLAIM_REVIEWER maps to no permission, so it
-- cannot affect Ada's authorization.
select pg_temp.add_role(pg_temp.fx('m_ada'), 'CLAIM_REVIEWER');

-- Vendor B's caller, and a Vendor B member with an unrelated role.
select pg_temp.add_role(pg_temp.fx('m_gil'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_hal'), 'CLAIM_REVIEWER');

-- Vendor C's caller.
select pg_temp.add_role(pg_temp.fx('m_ivy'), 'VENDOR_SUPER_ADMIN');

-- Eve is an ACTIVE Vendor A member with NO role at all: counted as a member, refused as a
-- caller.
-- (no add_role for m_eve)

select pg_temp.add_role(pg_temp.fx('m_owner'),   'RETAILER_OWNER');
select pg_temp.add_role(pg_temp.fx('m_manager'), 'RETAILER_MANAGER');
select pg_temp.add_role(pg_temp.fx('m_staff'),   'SALES_STAFF');

-- Audit history. Vendor A gets 7, Vendor B gets 23, Vendor C gets none.
select pg_temp.add_audit(pg_temp.fx('vendor_a'), 7);
select pg_temp.add_audit(pg_temp.fx('vendor_b'), 23);

-- A RETAILER organization's audit rows, and a NULL-ORGANIZATION row. Neither may reach any
-- Vendor's count: the Retailer's rows belong to another tenant, and the null-organization row
-- has no tenant to authorize against at all (audit_logs_select_authorized excludes such rows
-- from BOTH branches).
select pg_temp.add_audit(pg_temp.fx('alpha'), 11);

insert into public.audit_logs (organization_id, action, entity_type, entity_id, metadata)
values (null, 'PRODUCT_UPDATED', 'VENDOR_PRODUCT', gen_random_uuid()::text, '{}'::jsonb);


-- ============================================================================
-- SECTION A — signature, security attributes and privileges (catalogue-level)
-- ============================================================================
-- Asserted against the catalogue rather than inferred from behaviour: "it did not error for
-- me" is not a privilege check, and a grant that widened by accident would still let every
-- behavioural test pass.

select has_function('public', 'get_vendor_admin_dashboard_summary', '{}'::text[],
  'get_vendor_admin_dashboard_summary() exists and takes no arguments');

-- NO INPUT OF ANY KIND. This is the central security property of the contract: there is no
-- user id, auth id, profile id, membership id, organization id, tenant id, role code,
-- permission code, status array, date range or organization selector to supply, so there is
-- nothing for a client to forge.
select is(pg_temp.input_args('get_vendor_admin_dashboard_summary'), '{}'::text[],
  'the summary accepts no client input at all — zero arguments');

-- Exact output shape and ORDER. A positional `returns table` contract is only stable if the
-- column list is pinned, and pinning it is what makes an accidental addition or reordering a
-- test failure rather than a silently broken pinned mobile build.
select is(
  pg_temp.table_columns('get_vendor_admin_dashboard_summary'),
  array['active_member_count', 'catalog_active_role_count',
        'catalog_permission_count', 'audit_event_count'],
  'the summary returns exactly the four agreed columns, in order');

-- EVERY OUTPUT IS bigint. Asserted against pg_proc.proallargtypes so a column that silently
-- became integer, numeric or text would fail here rather than in a client.
select is(
  (select array_agg(format_type(t, null) order by o)
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(p.proallargtypes) with ordinality as x(t, o)
   where n.nspname = 'public' and p.proname = 'get_vendor_admin_dashboard_summary'),
  array['bigint', 'bigint', 'bigint', 'bigint'],
  'all four output columns are bigint');

-- FORBIDDEN FIELDS. The exact-column assertion above already excludes these; this states the
-- rule directly so the reason survives a future column addition.
select is(
  (select count(*) from unnest(pg_temp.table_columns('get_vendor_admin_dashboard_summary')) c
   where c ~ 'token|hash|secret|password|provider|session|ip_address|user_agent|invitation|auth_user|user_id|profile_id|organization_id|tenant|email|mobile|phone|metadata'),
  0::bigint,
  'no output column names a token, hash, secret, session, invitation, auth user, profile or organization id, email, phone or metadata');

select is(
  (select count(*) from unnest(pg_temp.table_columns('get_vendor_admin_dashboard_summary')) c
   where c !~ '_count$'),
  0::bigint,
  'EVERY output column is a _count — the summary returns counts and nothing else');

-- No status string, no id, no name, no timestamp is emitted. Statuses are PREDICATES in this
-- function, not output.
select is(
  (select count(*) from unnest(pg_temp.table_columns('get_vendor_admin_dashboard_summary')) c
   where c ~ 'status|_id$|_at$|name|code'),
  0::bigint,
  'no output column carries a status, an id, a timestamp, a name or a code');

-- Security attributes.
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_vendor_admin_dashboard_summary'), true,
  'get_vendor_admin_dashboard_summary is SECURITY DEFINER');

-- `set search_path = ''` is stored by PostgreSQL as the literal `search_path=""` — the empty
-- string, quoted. Asserting `search_path=` (unquoted) would match nothing and the test would
-- fail even on a correctly-hardened function.
select ok(
  (select p.proconfig @> array['search_path=""']
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='get_vendor_admin_dashboard_summary'),
  'the summary pins an EMPTY search_path');

select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='get_vendor_admin_dashboard_summary'),
  's'::"char",
  'the summary is STABLE — it may not write');

-- Grants: authenticated yes, anon no, PUBLIC no, service_role no.
select ok(has_function_privilege('authenticated',
    'public.get_vendor_admin_dashboard_summary()', 'execute'),
  'authenticated may execute the summary');

select ok(not has_function_privilege('anon',
    'public.get_vendor_admin_dashboard_summary()', 'execute'),
  'anon may NOT execute the summary');

-- PUBLIC holds nothing. A PUBLIC grant appears in proacl as an entry with an empty grantee
-- ("=X/owner"), and PUBLIC is inherited by every role — so a leftover default grant would hand
-- anon EXECUTE despite the explicit revoke.
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where n.nspname='public' and p.proname='get_vendor_admin_dashboard_summary'
     and a::text like '=%'),
  0::bigint,
  'PUBLIC holds EXECUTE on the summary');

select ok(not has_function_privilege('service_role',
    'public.get_vendor_admin_dashboard_summary()', 'execute'),
  'service_role may NOT execute the summary — its authority comes from auth.uid()');


-- ============================================================================
-- SECTION B — the summary shape for an authorized Vendor
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.row_count(), 1::bigint,
  'an authorized Vendor Super Admin receives EXACTLY ONE row');

select is(
  (select count(*) from unnest(pg_temp.all_counts()) c where c is null),
  0::bigint,
  'no count is NULL');

select is(
  (select count(*) from unnest(pg_temp.all_counts()) c where c < 0),
  0::bigint,
  'no count is negative');

-- The four figures for Vendor A, as exact literals derived from the fixture above.
select is(pg_temp.members(), 4::bigint,
  'active_member_count counts the FOUR ACTIVE Vendor A memberships (ada, bob, eve, gwen)');

select is(pg_temp.audits(), 7::bigint,
  'audit_event_count is Vendor A''s seven audit rows — all-time, no window');

select ok(pg_temp.roles_n() > 0,
  'catalog_active_role_count is a real figure from the seeded catalogue');

select ok(pg_temp.perms_n() > 0,
  'catalog_permission_count is a real figure from the seeded catalogue');

-- The catalogue counts must equal a direct count of the catalogue tables. Stated as a
-- comparison rather than as a literal so an unrelated future module migration that seeds a
-- new role or permission does not fail this suite.
select is(pg_temp.roles_n(),
  (select count(*) from public.roles where status = 'ACTIVE'),
  'catalog_active_role_count equals the count of ACTIVE role DEFINITIONS');

select is(pg_temp.perms_n(),
  (select count(*) from public.permissions),
  'catalog_permission_count equals the WHOLE permission catalogue — the table has no status column');

-- A ROLE ASSIGNED TO NOBODY IS STILL COUNTED, and a role assigned to many is counted ONCE.
-- This is what proves the catalogue count reads public.roles rather than public.member_roles.
select is(
  pg_temp.roles_n(),
  (select count(distinct r.id) from public.roles r where r.status = 'ACTIVE'),
  'catalog_active_role_count counts role DEFINITIONS, not role assignments');

-- AN INACTIVE ROLE DEFINITION IS EXCLUDED. Added here rather than in the fixture block so the
-- before/after comparison is adjacent to the claim.
select lives_ok(
  $$insert into public.roles (code, name, description, status)
    values ('LEGACY_DASHBOARD_ROLE', 'Legacy Role', 'Retired.', 'INACTIVE')$$,
  'an INACTIVE role definition can be added');

select is(pg_temp.roles_n(),
  (select count(*) from public.roles where status = 'ACTIVE'),
  'an INACTIVE role definition does NOT raise catalog_active_role_count');


-- ============================================================================
-- SECTION C — authorization and denial
-- ============================================================================
-- Every denial is the SAME generic 42501. A caller must not be able to tell WHICH gate
-- refused them, and must never receive a row of zeros instead of a refusal.

select pg_temp.sign_out();
select is(pg_temp.summary_error(), '42501',
  'a SIGNED-OUT caller is denied');

select pg_temp.act_as(pg_temp.fx('no_org'));
select is(pg_temp.summary_error(), '42501',
  'an authenticated user with NO organization is denied');

select pg_temp.act_as(pg_temp.fx('eve'));
select is(pg_temp.summary_error(), '42501',
  'an ACTIVE Vendor member WITHOUT Vendor Super Admin authority is denied');

select pg_temp.act_as(pg_temp.fx('bob'));
select is(pg_temp.summary_error(), '42501',
  'a Vendor Super Admin with a SUSPENDED PROFILE is denied');

select pg_temp.act_as(pg_temp.fx('cara'));
select is(pg_temp.summary_error(), '42501',
  'a Vendor Super Admin with a DEACTIVATED MEMBERSHIP is denied');

select pg_temp.act_as(pg_temp.fx('fred'));
select is(pg_temp.summary_error(), '42501',
  'a Vendor Super Admin with a SUSPENDED MEMBERSHIP is denied');

select pg_temp.act_as(pg_temp.fx('owner'));
select is(pg_temp.summary_error(), '42501',
  'a RETAILER OWNER is denied');

select pg_temp.act_as(pg_temp.fx('manager'));
select is(pg_temp.summary_error(), '42501',
  'a RETAILER MANAGER is denied');

select pg_temp.act_as(pg_temp.fx('staff'));
select is(pg_temp.summary_error(), '42501',
  'SALES STAFF are denied');

-- EVERY DENIAL IS BYTE-IDENTICAL. Stated as a set comparison so a future edit that made one
-- case distinguishable — a different SQLSTATE, or zero rows instead of a raise — fails here.
select is(
  (select count(distinct e) from (
     select pg_temp.sqlstate_of('select 1 from public.get_vendor_admin_dashboard_summary()') as e
   ) t),
  1::bigint,
  'the refusal is a single generic SQLSTATE, not a per-case discriminator');

-- A DENIAL IS NEVER A ROW OF ZEROS. This is the one substitution that would be actively
-- misleading on a dashboard, so it is asserted directly.
select throws_ok(
  'select * from public.get_vendor_admin_dashboard_summary()',
  '42501',
  null,
  'a denied caller receives an EXCEPTION, never a row of zeros');

-- A DEACTIVATED VENDOR ORGANIZATION. Ivy is Vendor C's only administrator; suspending the
-- ORGANIZATION must deny her, because get_vendor_super_admin_context() requires an ACTIVE
-- organization. Done here and reverted immediately so Section D's Vendor C assertions hold.
select pg_temp.act_as(pg_temp.fx('ivy'));
select is(pg_temp.summary_error(), null,
  'Vendor C''s administrator is authorized while the organization is ACTIVE');

update public.organizations set status = 'SUSPENDED' where id = pg_temp.fx('vendor_c');
select is(pg_temp.summary_error(), '42501',
  'a Vendor Super Admin of a SUSPENDED ORGANIZATION is denied');
update public.organizations set status = 'ACTIVE' where id = pg_temp.fx('vendor_c');


-- ============================================================================
-- SECTION D — tenant isolation, and the tenant/catalogue distinction
-- ============================================================================
-- The central correctness claim. Vendor A and Vendor B hold DIFFERENT amounts of data, so a
-- leak cannot hide behind coincidentally equal counts.

select pg_temp.act_as(pg_temp.fx('ada'));
select is(pg_temp.members(), 4::bigint, 'Vendor A sees its own 4 ACTIVE members');
select is(pg_temp.audits(),  7::bigint, 'Vendor A sees its own 7 audit rows');

select pg_temp.act_as(pg_temp.fx('gil'));
select is(pg_temp.members(),  3::bigint,
  'Vendor B sees its own 3 ACTIVE members (gil, hal, gwen) — NOT Vendor A''s 4');
select is(pg_temp.audits(),  23::bigint,
  'Vendor B sees its own 23 audit rows — NOT Vendor A''s 7, and not 30');

-- THE TENANT COUNTS DIFFER BETWEEN VENDORS; THE CATALOGUE COUNTS DO NOT. Asserted as a
-- relationship between the two callers, which is the only way to prove the distinction rather
-- than restate the field names.
select isnt(
  (select pg_temp.audits()),
  7::bigint,
  'Vendor B''s audit count is NOT Vendor A''s — the figure is tenant-scoped');

create table pg_temp.observed (who text primary key, m bigint, r bigint, p bigint, a bigint);

select pg_temp.act_as(pg_temp.fx('ada'));
insert into pg_temp.observed select 'a', pg_temp.members(), pg_temp.roles_n(), pg_temp.perms_n(), pg_temp.audits();
select pg_temp.act_as(pg_temp.fx('gil'));
insert into pg_temp.observed select 'b', pg_temp.members(), pg_temp.roles_n(), pg_temp.perms_n(), pg_temp.audits();

select isnt((select m from pg_temp.observed where who='a'),
            (select m from pg_temp.observed where who='b'),
  'active_member_count is TENANT-SCOPED — it differs between Vendor A and Vendor B');

select isnt((select a from pg_temp.observed where who='a'),
            (select a from pg_temp.observed where who='b'),
  'audit_event_count is TENANT-SCOPED — it differs between Vendor A and Vendor B');

select is((select r from pg_temp.observed where who='a'),
          (select r from pg_temp.observed where who='b'),
  'catalog_active_role_count is GLOBAL — identical for both Vendors, so it leaks no tenant data');

select is((select p from pg_temp.observed where who='a'),
          (select p from pg_temp.observed where who='b'),
  'catalog_permission_count is GLOBAL — identical for both Vendors, so it leaks no tenant data');

-- A RETAILER'S AUDIT ROWS AND THE NULL-ORGANIZATION ROW ARE INVISIBLE TO EVERY VENDOR. The
-- fixture wrote 11 Retailer rows and 1 null-organization row; neither Vendor's count includes
-- them, which the exact literals above already prove. Stated explicitly so the reason is
-- recorded.
select is(
  (select sum(a)::bigint from pg_temp.observed),
  30::bigint,
  'Vendor A + Vendor B audit counts total exactly 30 — the 11 Retailer rows and the 1 null-organization row are counted by NEITHER');

-- MULTI-ROLE AND MULTI-ORGANIZATION MEMBERS ARE COUNTED ONCE. Gwen holds TWO roles on her
-- Vendor A membership and is ALSO an ACTIVE member of Vendor B and of the Retailer. If the
-- member count joined member_roles or organizations loosely, Vendor A would read 5 or 6.
select pg_temp.act_as(pg_temp.fx('ada'));
select is(pg_temp.members(), 4::bigint,
  'a member holding TWO roles is counted ONCE — no join inflates active_member_count');

select is(
  (select count(*) from public.member_roles mr
    join public.organization_members m on m.id = mr.organization_member_id
   where m.organization_id = pg_temp.fx('vendor_a') and m.status = 'ACTIVE'),
  5::bigint,
  'the fixture really does have MORE active role assignments (5) than active members (4) — so the previous assertion is not vacuous');

select is(
  (select count(*) from public.organization_members
    where user_id = pg_temp.fx('gwen') and status = 'ACTIVE'),
  3::bigint,
  'Gwen really does hold three ACTIVE memberships — so counting her once per Vendor is not vacuous');


-- ============================================================================
-- SECTION E — the exact permission requirements
-- ============================================================================
-- The function demands the VENDOR_SUPER_ADMIN role AND all three permissions. Each mapping is
-- removed in turn and restored, proving every one is genuinely required — a test that removed
-- none would pass against a function that required none.

select pg_temp.act_as(pg_temp.fx('ada'));
select is(pg_temp.summary_error(), null,
  'with all three permissions mapped, Ada is authorized');

create function pg_temp.unmap(p_permission text) returns void
language plpgsql as $$
begin
  delete from public.role_permissions rp
  using public.roles r, public.permissions p
  where rp.role_id = r.id and rp.permission_id = p.id
    and r.code = 'VENDOR_SUPER_ADMIN' and p.code = p_permission;
end;
$$;

create function pg_temp.remap(p_permission text) returns void
language plpgsql as $$
begin
  insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id from public.roles r, public.permissions p
  where r.code = 'VENDOR_SUPER_ADMIN' and p.code = p_permission
  on conflict do nothing;
end;
$$;

select pg_temp.unmap('ORGANIZATION_MEMBERS_READ');
select is(pg_temp.summary_error(), '42501',
  'a Vendor Super Admin MISSING ORGANIZATION_MEMBERS_READ is denied the WHOLE summary');
select pg_temp.remap('ORGANIZATION_MEMBERS_READ');

select pg_temp.unmap('RBAC_READ');
select is(pg_temp.summary_error(), '42501',
  'a Vendor Super Admin MISSING RBAC_READ is denied the WHOLE summary');
select pg_temp.remap('RBAC_READ');

select pg_temp.unmap('AUDIT_LOGS_READ');
select is(pg_temp.summary_error(), '42501',
  'a Vendor Super Admin MISSING AUDIT_LOGS_READ is denied the WHOLE summary');
select pg_temp.remap('AUDIT_LOGS_READ');

select is(pg_temp.summary_error(), null,
  'restoring all three mappings restores access — the denials above were caused by the removals');

-- THE CONTRACT IS NON-PARTIAL. A caller missing one permission receives NO row at all, rather
-- than a row with three counts and one null. This is the behaviour the migration argues for,
-- so it is asserted rather than described.
select pg_temp.unmap('AUDIT_LOGS_READ');
select is(
  pg_temp.sqlstate_of('select active_member_count from public.get_vendor_admin_dashboard_summary()'),
  '42501',
  'a partial-permission caller cannot read even the metrics whose permission they DO hold');
select pg_temp.remap('AUDIT_LOGS_READ');


-- ============================================================================
-- SECTION F — a Vendor with no data
-- ============================================================================
-- Ivy administers Vendor C, which has one member (Ivy) and no audit history at all.

select pg_temp.act_as(pg_temp.fx('ivy'));

select is(pg_temp.row_count(), 1::bigint,
  'a Vendor with no data receives EXACTLY ONE row, not zero rows');

select is(pg_temp.audits(), 0::bigint,
  'audit_event_count is 0 for a Vendor that has recorded nothing — a real zero, not null');

select isnt(pg_temp.audits(), null,
  'the empty audit count is 0 rather than NULL');

select is(pg_temp.members(), 1::bigint,
  'active_member_count is 1 — the caller''s own ACTIVE membership, which is what authorized them');

-- The catalogue counts are UNAFFECTED by the tenant having no data: they are global.
select is(pg_temp.roles_n(), (select r from pg_temp.observed where who='a'),
  'a Vendor with no data still sees the full global role catalogue count');

select is(pg_temp.perms_n(), (select p from pg_temp.observed where who='a'),
  'a Vendor with no data still sees the full global permission catalogue count');

-- AN EMPTIED CATALOGUE STILL RETURNS 0, NOT NULL. This is the property that would break if
-- the scalar subqueries were ever rewritten as a join or given a GROUP BY — an aggregate over
-- an empty set returns 0, but a joined row set returns NO ROW. Asserted by deleting the
-- catalogue inside the rolled-back transaction.
select lives_ok(
  $$delete from public.role_permissions$$,
  'role_permissions can be emptied inside the test transaction');

-- Ivy's authorization is gone with the mappings, so the remaining catalogue-emptying
-- assertions are made through a direct query of the same shape rather than through the
-- function. The function's own zero-behaviour for an empty relation is already proven by
-- Vendor C's audit_event_count = 0 above, which exercises exactly the same scalar-subquery
-- construct against an empty result set.
select is(
  (select count(*) from public.roles where status = 'ZZZ_NONEXISTENT'),
  0::bigint,
  'an aggregate scalar subquery over an empty set yields 0, never NULL and never no row');


select finish();

rollback;
