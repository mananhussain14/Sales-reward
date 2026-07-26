-- pgTAP behavioural tests for the Vendor company/profile self-read added by
-- migration 20260806090000_mobile_vendor_company_profile_reads.sql:
--
--   public.get_my_vendor_profile()
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as the
-- `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as far as every
-- authorization helper in this schema is concerned. pg_temp.act_as() does exactly that and
-- pg_temp.sign_out() clears it. This mirrors portal_context_test.sql, vendor_user_reads_test.sql,
-- vendor_audit_log_reads_test.sql and vendor_dashboard_summary_test.sql exactly, deliberately:
-- several impersonation idioms in one suite directory would be several different claims about
-- what "signed in" means.
--
-- The tests deliberately do NOT `set role authenticated`. The function is SECURITY DEFINER, so
-- its behaviour depends on auth.uid() and not on the session role, and switching roles
-- mid-transaction would only make the fixture inserts fail. EXECUTE privilege is a separate
-- concern and is asserted directly against the catalogue in Section A, which is a stronger check
-- than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back, so no fixture survives — and neither
-- does Section E, which temporarily removes a seeded role→permission mapping.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file turns an
-- added test into a confusing failure about arithmetic rather than about behaviour.
--
-- ============================================================================
-- WHAT THIS CONTRACT IS, IN ONE PARAGRAPH
-- ============================================================================
-- Two fields, exactly one row, zero arguments, about the CALLER THEMSELVES: their own composed
-- display name and their own ACTIVE role names in their own Vendor. It returns NO company field
-- at all — the organization name comes from get_my_portal_context(), and Section G asserts that
-- this function does not duplicate it. It returns no status and no timestamp, because for an
-- authorized caller every relevant status is ACTIVE by construction (Section F proves that the
-- statuses really are conditions of authorization rather than omitted output).
--
-- ============================================================================
-- WHY THE EXPECTED VALUES ARE WRITTEN AS LITERALS
-- ============================================================================
-- Every expected name and role list below is a literal derived from explicitly-inserted fixture
-- rows, never a second query against the same tables. Comparing the function to a re-statement of
-- its own SQL would pass for any predicate the two happened to share — including a wrong one.

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

/*
 * CATALOGUE INTROSPECTION FOR `RETURNS TABLE` FUNCTIONS.
 *
 * A set-returning `returns table (...)` function has prorettype = `record`, a pseudo-type with no
 * typrelid — so joining pg_type -> pg_class -> pg_attribute to read its columns silently yields
 * NOTHING, and an assertion written that way compares NULL to NULL and passes vacuously. The
 * column names live in proargnames alongside the INPUT parameter names, distinguished only by
 * proargmodes: 'i' (or 'b'/'v') for an input, 't' for a table column. Both helpers below
 * therefore filter on the mode.
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

/* The SQLSTATE of calling the self-read as the current caller. */
create function pg_temp.profile_error() returns text
language sql as $$
  select pg_temp.sqlstate_of('select * from public.get_my_vendor_profile()');
$$;

/* The two fields, for the current caller. */
create function pg_temp.my_name() returns text
language sql as $$
  select v.administrator_display_name from public.get_my_vendor_profile() v;
$$;

create function pg_temp.my_roles() returns text[]
language sql as $$
  select v.administrator_role_names from public.get_my_vendor_profile() v;
$$;

/* How many rows the function emitted. The whole contract rests on this being 1. */
create function pg_temp.row_count() returns bigint
language sql as $$
  select count(*) from public.get_my_vendor_profile();
$$;

/* The `vendor.organization_name` PortalContext reports for the current caller, for Section G. */
create function pg_temp.portal_org_name() returns text
language sql as $$
  select public.get_my_portal_context() -> 'vendor' ->> 'organization_name';
$$;


-- ============================================================================
-- Fixtures
-- ============================================================================
-- Deterministic: every organization, membership status and role assignment below is written
-- explicitly. Nothing depends on seeded tenant data (there is none) or on ordering.
--
--   Vendor A — "Acme Vendor". Ada is its administrator and holds TWO active roles plus one
--              INACTIVE definition, so the array assertions are not vacuous. Zara is a SECOND
--              Vendor A administrator whose personal data must never appear in Ada's row.
--   Vendor B — "Bravo Vendor". Gil is its administrator. Vendor B exists so tenant isolation is
--              a comparison between two real Vendors rather than an argument.
--   Vendor C — "Charlie Vendor". Ivy holds VENDOR_SUPER_ADMIN and NOTHING ELSE, which is the
--              minimal authorized shape.
--   Alpha    — a RETAILER organization, whose Owner, Manager and Sales Staff must all be refused.
--
-- MULTI-VENDOR AMBIGUITY: Mike is an ACTIVE VENDOR_SUPER_ADMIN of BOTH Vendor A and Vendor B,
-- with DIFFERENT extra roles in each, so the lowest-organization-id rule is observable rather
-- than asserted by inspection.

create table pg_temp.fx (k text primary key, v uuid);

insert into pg_temp.fx (k, v) values
  ('vendor_a', pg_temp.new_org('Acme Vendor')),
  ('vendor_b', pg_temp.new_org('Bravo Vendor')),
  ('vendor_c', pg_temp.new_org('Charlie Vendor')),
  ('alpha',    pg_temp.new_org('Alpha Retail', 'RETAILER', 'ACTIVE'));

create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.fx where k = p_k; $$;

insert into pg_temp.fx (k, v) values
  -- Vendor A people.
  ('ada',      pg_temp.new_person('Ada',  'Admin')),
  ('zara',     pg_temp.new_person('Zara', 'Colleague')),
  ('eve',      pg_temp.new_person('Eve',  'Noroles')),
  ('bob',      pg_temp.new_person('Bob',  'Suspendedprofile', 'SUSPENDED')),
  ('cara',     pg_temp.new_person('Cara', 'Deactivatedmember')),
  ('fred',     pg_temp.new_person('Fred', 'Suspendedmember')),
  ('dan',      pg_temp.new_person('Dan',  'Invitedmember', 'INVITED')),
  -- Vendor B.
  ('gil',      pg_temp.new_person('Gil',  'Bravo')),
  -- Vendor C — the minimal authorized administrator.
  ('ivy',      pg_temp.new_person('Ivy',  'Solo')),
  -- A Super Admin of TWO Vendors.
  ('mike',     pg_temp.new_person('Mike', 'Multi')),
  -- Whitespace-padded name parts: the composition must trim, not concatenate blindly.
  ('pad',      pg_temp.new_person('  Pia  ', '  Padded  ')),
  -- Retailer people, every one of whom must be refused.
  ('owner',    pg_temp.new_person('Ora',  'Owner')),
  ('manager',  pg_temp.new_person('Mia',  'Manager')),
  ('staff',    pg_temp.new_person('Sam',  'Staff')),
  -- Authenticated, but a member of nothing at all.
  ('no_org',   pg_temp.new_person('Ned',  'Noorg'));

insert into pg_temp.fx (k, v) values
  ('m_ada',   pg_temp.add_member(pg_temp.fx('ada'),   pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_zara',  pg_temp.add_member(pg_temp.fx('zara'),  pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_eve',   pg_temp.add_member(pg_temp.fx('eve'),   pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_bob',   pg_temp.add_member(pg_temp.fx('bob'),   pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_cara',  pg_temp.add_member(pg_temp.fx('cara'),  pg_temp.fx('vendor_a'), 'DEACTIVATED')),
  ('m_fred',  pg_temp.add_member(pg_temp.fx('fred'),  pg_temp.fx('vendor_a'), 'SUSPENDED')),
  ('m_dan',   pg_temp.add_member(pg_temp.fx('dan'),   pg_temp.fx('vendor_a'), 'INVITED')),
  ('m_pad',   pg_temp.add_member(pg_temp.fx('pad'),   pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_gil',   pg_temp.add_member(pg_temp.fx('gil'),   pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_ivy',   pg_temp.add_member(pg_temp.fx('ivy'),   pg_temp.fx('vendor_c'), 'ACTIVE')),
  ('m_mike_a', pg_temp.add_member(pg_temp.fx('mike'), pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_mike_b', pg_temp.add_member(pg_temp.fx('mike'), pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_owner',   pg_temp.add_member(pg_temp.fx('owner'),   pg_temp.fx('alpha'), 'ACTIVE')),
  ('m_manager', pg_temp.add_member(pg_temp.fx('manager'), pg_temp.fx('alpha'), 'ACTIVE')),
  ('m_staff',   pg_temp.add_member(pg_temp.fx('staff'),   pg_temp.fx('alpha'), 'ACTIVE'));

-- ADA IS ALSO AN ACTIVE MEMBER OF THE RETAILER, holding a Retailer role there. Her Vendor
-- profile row must NOT include it: a role held in another organization is another organization's
-- fact, and a loose join over member_roles would leak it into her Vendor role list.
insert into pg_temp.fx (k, v) values
  ('m_ada_alpha', pg_temp.add_member(pg_temp.fx('ada'), pg_temp.fx('alpha'), 'ACTIVE'));

select pg_temp.add_role(pg_temp.fx('m_ada_alpha'), 'RETAILER_MANAGER');

-- Role assignments.
--
-- ADA HOLDS TWO ACTIVE ROLES on her Vendor A membership (VENDOR_SUPER_ADMIN and CLAIM_REVIEWER)
-- plus one INACTIVE definition added below. Two active roles is what makes "the array really is
-- a list", "the ordering is by name", and "two roles do not become two rows" non-vacuous.
select pg_temp.add_role(pg_temp.fx('m_ada'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_ada'),  'CLAIM_REVIEWER');

-- Zara is a SECOND Vendor A administrator, with a role Ada does not hold. If the self predicate
-- were ever loosened to the tenant alone, Ada's row would acquire Zara's name or Zara's role —
-- which is precisely what Section D asserts cannot happen.
select pg_temp.add_role(pg_temp.fx('m_zara'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_zara'), 'FINANCE_ADMIN');

-- Bob, Cara and Fred hold VENDOR_SUPER_ADMIN too, so they double as the inactive-profile,
-- deactivated-membership and suspended-membership denials in Section C while remaining ordinary
-- Vendor A members. The same person cannot be authorized and unauthorized, and asserting both
-- about the same fixture is what proves the ACTIVE requirements are the reason.
select pg_temp.add_role(pg_temp.fx('m_bob'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_cara'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_fred'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_dan'),  'VENDOR_SUPER_ADMIN');

-- Eve is an ACTIVE Vendor A member with NO role at all.
-- (no add_role for m_eve)

select pg_temp.add_role(pg_temp.fx('m_pad'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_gil'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_ivy'), 'VENDOR_SUPER_ADMIN');

-- Mike: Super Admin in BOTH Vendors, with a different second role in each, so which Vendor the
-- lowest-id rule picked is visible in the returned array rather than inferred.
select pg_temp.add_role(pg_temp.fx('m_mike_a'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_mike_a'), 'CLAIM_REVIEWER');
select pg_temp.add_role(pg_temp.fx('m_mike_b'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_mike_b'), 'FINANCE_ADMIN');

select pg_temp.add_role(pg_temp.fx('m_owner'),   'RETAILER_OWNER');
select pg_temp.add_role(pg_temp.fx('m_manager'), 'RETAILER_MANAGER');
select pg_temp.add_role(pg_temp.fx('m_staff'),   'SALES_STAFF');

-- An INACTIVE role definition, assigned to Ada. It must NOT appear in her role names: an
-- INACTIVE definition still assigned to someone is not a live role.
insert into public.roles (code, name, description, status)
values ('LEGACY_VENDOR_ROLE', 'Legacy Vendor Role', 'Retired.', 'INACTIVE');

select pg_temp.add_role(pg_temp.fx('m_ada'), 'LEGACY_VENDOR_ROLE');


-- ============================================================================
-- SECTION A — signature, security attributes and privileges (catalogue-level)
-- ============================================================================
-- Asserted against the catalogue rather than inferred from behaviour: "it did not error for me"
-- is not a privilege check, and a grant that widened by accident would still let every
-- behavioural test pass.

select has_function('public', 'get_my_vendor_profile', '{}'::text[],
  'get_my_vendor_profile() exists and takes no arguments');

-- NO INPUT OF ANY KIND. This is the central security property of the contract: there is no auth
-- user id, profile id, membership id, organization id, tenant id, role code, permission code,
-- profile selector or organization selector to supply, so there is nothing for a client to forge
-- and no way to name another person or another Vendor.
select is(pg_temp.input_args('get_my_vendor_profile'), '{}'::text[],
  'the self-read accepts no client input at all — zero arguments');

-- Exact output shape and ORDER. A positional `returns table` contract is only stable if the
-- column list is pinned, and pinning it is what makes an accidental addition or reordering a test
-- failure rather than a silently broken pinned mobile build.
select is(
  pg_temp.table_columns('get_my_vendor_profile'),
  array['administrator_display_name', 'administrator_role_names'],
  'the self-read returns exactly the two agreed columns, in order');

-- EXACT OUTPUT TYPES. Asserted against pg_proc.proallargtypes so a column that silently became
-- json, jsonb, uuid or a scalar text would fail here rather than in a client.
select is(
  (select array_agg(format_type(t, null) order by o)
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(p.proallargtypes) with ordinality as x(t, o)
   where n.nspname = 'public' and p.proname = 'get_my_vendor_profile'),
  array['text', 'text[]'],
  'the outputs are exactly (text, text[]) — no json, no jsonb, no uuid');

-- FORBIDDEN FIELDS. The exact-column assertion above already excludes these; this states the rule
-- directly so the reason survives a future column addition.
select is(
  (select count(*) from unnest(pg_temp.table_columns('get_my_vendor_profile')) c
   where c ~ 'token|hash|secret|password|provider|session|ip_address|user_agent|invitation|auth_user|user_id|profile_id|membership_id|organization_id|tenant|email|mobile|phone|address|metadata|billing|tax|bank|registration|legal|website|logo|avatar|permission'),
  0::bigint,
  'no output column names a token, hash, secret, session, invitation, auth/profile/membership/organization id, email, phone, address, metadata, billing, tax, bank, registration, legal name, website, logo, avatar or permission');

-- NO STATUS AND NO TIMESTAMP. The statuses are CONDITIONS of authorization in this function, not
-- output (Section F proves that), and no web surface displays a timestamp for the caller.
select is(
  (select count(*) from unnest(pg_temp.table_columns('get_my_vendor_profile')) c
   where c ~ 'status|_at$|_id$|_code$'),
  0::bigint,
  'no output column carries a status, a timestamp, an id or a code');

-- EVERY OUTPUT IS PERSONAL AND SAYS SO. The `administrator_` prefix is what keeps a Flutter model
-- that merges this row with PortalContext's company block unambiguous.
select is(
  (select count(*) from unnest(pg_temp.table_columns('get_my_vendor_profile')) c
   where c !~ '^administrator_'),
  0::bigint,
  'EVERY output column is prefixed administrator_ — company and personal fields cannot be confused');

-- NO COMPANY FIELD IS RETURNED AT ALL. Stated as its own assertion because it is the audit's
-- central architectural decision, not an incidental omission. See also Section G.
select is(
  (select count(*) from unnest(pg_temp.table_columns('get_my_vendor_profile')) c
   where c ~ 'organization|company|vendor'),
  0::bigint,
  'no output column is a company/organization field — the organization name comes from get_my_portal_context()');

-- Security attributes.
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_my_vendor_profile'), true,
  'get_my_vendor_profile is SECURITY DEFINER');

-- `set search_path = ''` is stored by PostgreSQL as the literal `search_path=""` — the empty
-- string, quoted. Asserting `search_path=` (unquoted) would match nothing and the test would fail
-- even on a correctly-hardened function.
select ok(
  (select p.proconfig @> array['search_path=""']
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='get_my_vendor_profile'),
  'the self-read pins an EMPTY search_path');

select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='get_my_vendor_profile'),
  's'::"char",
  'the self-read is STABLE — it may not write');

-- Grants: authenticated yes, anon no, PUBLIC no, service_role no.
select ok(has_function_privilege('authenticated',
    'public.get_my_vendor_profile()', 'execute'),
  'authenticated may execute the self-read');

select ok(not has_function_privilege('anon',
    'public.get_my_vendor_profile()', 'execute'),
  'anon may NOT execute the self-read');

-- PUBLIC holds nothing. A PUBLIC grant appears in proacl as an entry with an empty grantee
-- ("=X/owner"), and PUBLIC is inherited by every role — so a leftover default grant would hand
-- anon EXECUTE despite the explicit revoke.
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where n.nspname='public' and p.proname='get_my_vendor_profile'
     and a::text like '=%'),
  0::bigint,
  'PUBLIC holds no EXECUTE on the self-read');

select ok(not has_function_privilege('service_role',
    'public.get_my_vendor_profile()', 'execute'),
  'service_role may NOT execute the self-read — its authority comes from auth.uid()');

-- THE FUNCTION IS OWNED BY THE MIGRATION ROLE, like every other definer function in this schema.
-- A SECURITY DEFINER function runs as its owner, so the owner IS part of its security posture.
select is(
  (select pg_get_userbyid(p.proowner) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='get_my_vendor_profile'),
  (select pg_get_userbyid(p.proowner) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='get_vendor_super_admin_context'),
  'the self-read has the SAME owner as get_vendor_super_admin_context — no privilege escalation via ownership');


-- ============================================================================
-- SECTION B — the row an authorized administrator receives
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.row_count(), 1::bigint,
  'an authorized Vendor Super Admin receives EXACTLY ONE row');

select is(pg_temp.my_name(), 'Ada Admin',
  'administrator_display_name is the caller''s own composed name');

select isnt(pg_temp.my_name(), null,
  'administrator_display_name is never NULL');

-- TWO ACTIVE ROLES, ORDERED BY NAME, AND THE INACTIVE ONE EXCLUDED. 'Claim Reviewer' sorts before
-- 'Vendor Super Admin', so this literal also pins the ordering.
select is(pg_temp.my_roles(), array['Claim Reviewer', 'Vendor Super Admin'],
  'administrator_role_names is the caller''s ACTIVE Vendor role NAMES, ordered by name');

select isnt(pg_temp.my_roles(), null,
  'administrator_role_names is never NULL');

select ok(array_length(pg_temp.my_roles(), 1) = 2,
  'holding TWO roles yields an array of two — not two rows');

-- NAMES, NOT CODES. Asserted directly: a client rendering 'VENDOR_SUPER_ADMIN' would be printing
-- an authorization literal onto a profile screen.
select ok(
  not (pg_temp.my_roles() && array['VENDOR_SUPER_ADMIN', 'CLAIM_REVIEWER', 'FINANCE_ADMIN']),
  'no role CODE appears in administrator_role_names — only display names');

select ok(
  'Vendor Super Admin' = any (pg_temp.my_roles()),
  'the authorizing role is present under its display name');

-- THE INACTIVE DEFINITION IS EXCLUDED, and the fixture really does assign one, so the assertion
-- is not vacuous.
select is(
  (select count(*) from public.member_roles mr
   join public.roles r on r.id = mr.role_id
   where mr.organization_member_id = pg_temp.fx('m_ada') and r.status = 'INACTIVE'),
  1::bigint,
  'the fixture really does assign Ada an INACTIVE role definition');

select ok(
  not ('Legacy Vendor Role' = any (pg_temp.my_roles())),
  'an INACTIVE role definition assigned to the caller is NOT reported as a live role');

-- A ROLE HELD IN ANOTHER ORGANIZATION IS NOT A VENDOR ROLE. Ada is an ACTIVE RETAILER_MANAGER of
-- Alpha Retail; that fact belongs to another tenant and must not appear here.
select is(
  (select count(*) from public.member_roles mr
   where mr.organization_member_id = pg_temp.fx('m_ada_alpha')),
  1::bigint,
  'the fixture really does give Ada a role in the RETAILER organization');

select ok(
  not ('Retailer Manager' = any (pg_temp.my_roles())),
  'a role held in ANOTHER organization does NOT appear in the Vendor profile row');

-- THE MINIMAL AUTHORIZED SHAPE: exactly one role, and the array is never empty for an authorized
-- caller, because the role that authorized them is always in it.
select pg_temp.act_as(pg_temp.fx('ivy'));
select is(pg_temp.my_roles(), array['Vendor Super Admin'],
  'a caller holding only VENDOR_SUPER_ADMIN gets an array of exactly one');
select ok(array_length(pg_temp.my_roles(), 1) >= 1,
  'administrator_role_names is never EMPTY for an authorized caller — the authorizing role is in it');

-- NAME COMPOSITION: PADDING IS TRIMMED, AND JOINED BY EXACTLY ONE SPACE. profiles allows padded
-- values (the CHECK is on the trimmed length), so this is a reachable input rather than a
-- hypothetical.
select pg_temp.act_as(pg_temp.fx('pad'));
select is(pg_temp.my_name(), 'Pia Padded',
  'padded name parts are trimmed and joined with exactly one space');


-- ============================================================================
-- SECTION C — authorization and denial
-- ============================================================================
-- Every denial is the SAME generic 42501. A caller must not be able to tell WHICH gate refused
-- them, and must never receive a row instead of a refusal.

select pg_temp.sign_out();
select is(pg_temp.profile_error(), '42501',
  'a SIGNED-OUT caller is denied');

select pg_temp.act_as(pg_temp.fx('no_org'));
select is(pg_temp.profile_error(), '42501',
  'an authenticated user with NO organization is denied');

select pg_temp.act_as(pg_temp.fx('eve'));
select is(pg_temp.profile_error(), '42501',
  'an ACTIVE Vendor member WITHOUT Vendor Super Admin authority is denied');

select pg_temp.act_as(pg_temp.fx('bob'));
select is(pg_temp.profile_error(), '42501',
  'a Vendor Super Admin with a SUSPENDED PROFILE is denied');

select pg_temp.act_as(pg_temp.fx('cara'));
select is(pg_temp.profile_error(), '42501',
  'a Vendor Super Admin with a DEACTIVATED MEMBERSHIP is denied');

select pg_temp.act_as(pg_temp.fx('fred'));
select is(pg_temp.profile_error(), '42501',
  'a Vendor Super Admin with a SUSPENDED MEMBERSHIP is denied');

select pg_temp.act_as(pg_temp.fx('dan'));
select is(pg_temp.profile_error(), '42501',
  'a Vendor Super Admin with an INVITED profile and INVITED membership is denied');

select pg_temp.act_as(pg_temp.fx('owner'));
select is(pg_temp.profile_error(), '42501',
  'a RETAILER OWNER is denied');

select pg_temp.act_as(pg_temp.fx('manager'));
select is(pg_temp.profile_error(), '42501',
  'a RETAILER MANAGER is denied');

select pg_temp.act_as(pg_temp.fx('staff'));
select is(pg_temp.profile_error(), '42501',
  'SALES STAFF are denied');

-- A DENIAL IS AN EXCEPTION, NEVER AN EMPTY OR PLACEHOLDER PROFILE. This is the substitution that
-- would be actively misleading — a row whose display name was a fallback would let a denied
-- caller render a profile screen for an identity they do not hold.
select throws_ok(
  'select * from public.get_my_vendor_profile()',
  '42501',
  null,
  'a denied caller receives an EXCEPTION, never a row of nulls or placeholders');

-- EVERY DENIAL IS BYTE-IDENTICAL, including the message. Stated as a set comparison so a future
-- edit that made one case distinguishable — a different SQLSTATE, a different message, or zero
-- rows instead of a raise — fails here.
create table pg_temp.denials (who text primary key, state text, msg text);

create function pg_temp.record_denial(p_who text, p_user uuid) returns void
language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  begin
    perform * from public.get_my_vendor_profile();
    insert into pg_temp.denials values (p_who, null, 'NO ERROR RAISED');
  exception when others then
    insert into pg_temp.denials values (p_who, sqlstate, sqlerrm);
  end;
end;
$$;

select pg_temp.record_denial('no_org',  pg_temp.fx('no_org'));
select pg_temp.record_denial('eve',     pg_temp.fx('eve'));
select pg_temp.record_denial('bob',     pg_temp.fx('bob'));
select pg_temp.record_denial('cara',    pg_temp.fx('cara'));
select pg_temp.record_denial('fred',    pg_temp.fx('fred'));
select pg_temp.record_denial('owner',   pg_temp.fx('owner'));
select pg_temp.record_denial('manager', pg_temp.fx('manager'));
select pg_temp.record_denial('staff',   pg_temp.fx('staff'));

select is((select count(distinct state) from pg_temp.denials), 1::bigint,
  'every denial carries the SAME SQLSTATE — the refusal is not a per-case discriminator');

select is((select count(distinct msg) from pg_temp.denials), 1::bigint,
  'every denial carries the SAME MESSAGE — it is not an oracle for which gate refused');

-- THE MESSAGE NAMES NOTHING. Not a table, column, policy, permission code, Vendor, organization
-- name or person.
select ok(
  (select msg !~* 'profiles|organization_members|member_roles|public\.|policy|RBAC_READ|VENDOR_SUPER_ADMIN|Acme|Bravo|Charlie|Alpha|Ada|Zara'
     from pg_temp.denials limit 1),
  'the denial message names no table, column, policy, permission code, organization or person');

-- A SUSPENDED VENDOR ORGANIZATION. Ivy is Vendor C's only administrator; suspending the
-- ORGANIZATION must deny her, because get_vendor_super_admin_context() requires an ACTIVE
-- organization. Reverted immediately so later sections hold.
select pg_temp.act_as(pg_temp.fx('ivy'));
select is(pg_temp.profile_error(), null,
  'Vendor C''s administrator is authorized while the organization is ACTIVE');

update public.organizations set status = 'SUSPENDED' where id = pg_temp.fx('vendor_c');
select is(pg_temp.profile_error(), '42501',
  'a Vendor Super Admin of a SUSPENDED ORGANIZATION is denied');

update public.organizations set status = 'DEACTIVATED' where id = pg_temp.fx('vendor_c');
select is(pg_temp.profile_error(), '42501',
  'a Vendor Super Admin of a DEACTIVATED ORGANIZATION is denied');

update public.organizations set status = 'ACTIVE' where id = pg_temp.fx('vendor_c');
select is(pg_temp.profile_error(), null,
  'restoring the organization restores access — the denials above were caused by its status');

-- A RETAILER-TYPE ORGANIZATION IS NOT A VENDOR. Changing Vendor C's TYPE (not its status) must
-- deny, because the context function filters organization_type = 'VENDOR'.
update public.organizations set organization_type = 'RETAILER' where id = pg_temp.fx('vendor_c');
select is(pg_temp.profile_error(), '42501',
  'an administrator of a RETAILER-type organization is denied — the type filter is real');
update public.organizations set organization_type = 'VENDOR' where id = pg_temp.fx('vendor_c');

-- AN INACTIVE ROLE DEFINITION CANNOT AUTHORIZE. Retiring VENDOR_SUPER_ADMIN itself must deny
-- everyone, because the chain requires r.status = 'ACTIVE'.
update public.roles set status = 'INACTIVE' where code = 'VENDOR_SUPER_ADMIN';
select is(pg_temp.profile_error(), '42501',
  'an INACTIVE VENDOR_SUPER_ADMIN role definition authorizes nobody');
update public.roles set status = 'ACTIVE' where code = 'VENDOR_SUPER_ADMIN';


-- ============================================================================
-- SECTION D — self isolation and tenant isolation
-- ============================================================================
-- The central correctness claim, and the reason this function exists: a caller receives THEIR OWN
-- row, from THEIR OWN Vendor, and there is no selector with which to ask for anything else.

select pg_temp.act_as(pg_temp.fx('ada'));

-- Ada and Zara are BOTH Vendor A administrators with DIFFERENT names and DIFFERENT roles.
select ok(
  pg_temp.my_name() <> 'Zara Colleague',
  'the caller does NOT receive another Vendor administrator''s name');

select ok(
  not ('Finance Admin' = any (pg_temp.my_roles())),
  'the caller does NOT receive another Vendor administrator''s role — Zara''s FINANCE_ADMIN is absent');

select is(pg_temp.row_count(), 1::bigint,
  'a Vendor with several administrators still yields exactly ONE row — the caller''s own');

-- The same function, called by Zara, returns Zara. Asserted as a comparison so "it returns the
-- caller" is proven rather than restated.
select pg_temp.act_as(pg_temp.fx('zara'));
select is(pg_temp.my_name(), 'Zara Colleague',
  'the SAME zero-argument call returns ZARA''s profile when Zara calls it');
select is(pg_temp.my_roles(), array['Finance Admin', 'Vendor Super Admin'],
  'and ZARA''s roles — the subject is auth.uid(), never a parameter');

create table pg_temp.observed (who text primary key, nm text, roles text[]);

select pg_temp.act_as(pg_temp.fx('ada'));
insert into pg_temp.observed select 'ada', pg_temp.my_name(), pg_temp.my_roles();
select pg_temp.act_as(pg_temp.fx('zara'));
insert into pg_temp.observed select 'zara', pg_temp.my_name(), pg_temp.my_roles();
select pg_temp.act_as(pg_temp.fx('gil'));
insert into pg_temp.observed select 'gil', pg_temp.my_name(), pg_temp.my_roles();

select isnt((select nm from pg_temp.observed where who='ada'),
            (select nm from pg_temp.observed where who='zara'),
  'two administrators of the SAME Vendor receive DIFFERENT names — the read is per-caller');

select isnt((select roles from pg_temp.observed where who='ada'),
            (select roles from pg_temp.observed where who='zara'),
  'two administrators of the same Vendor receive DIFFERENT role lists');

-- CROSS-TENANT: Vendor B's administrator sees only himself. Vendor A's people are invisible.
select is((select nm from pg_temp.observed where who='gil'), 'Gil Bravo',
  'Vendor B''s administrator receives his own name');

select ok(
  (select nm from pg_temp.observed where who='gil') not in ('Ada Admin', 'Zara Colleague'),
  'Vendor B''s administrator receives NO Vendor A person''s name');

-- NO SELECTOR EXISTS, so there is no overload through which another profile or Vendor could be
-- named. Asserted against the catalogue: a future edit adding a parameter would fail here.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_my_vendor_profile'),
  1::bigint,
  'there is exactly ONE get_my_vendor_profile — no overload accepting a selector exists');

select is(
  (select p.pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_my_vendor_profile'),
  0::smallint,
  'and it declares ZERO parameters, so no profile or organization can be selected');

-- MULTI-VENDOR AMBIGUITY FOLLOWS THE SHIPPED LOWEST-ORGANIZATION-ID RULE. Mike administers both
-- Vendors with a different second role in each, so the observable role list proves WHICH Vendor
-- was chosen. The expected value is computed from the fixture's actual id ordering rather than
-- hard-coded, because gen_random_uuid() decides which Vendor is "lowest" at run time.
select pg_temp.act_as(pg_temp.fx('mike'));

select is(pg_temp.row_count(), 1::bigint,
  'a Super Admin of TWO Vendors still receives exactly ONE row — memberships do not multiply it');

select is(
  pg_temp.my_roles(),
  case when pg_temp.fx('vendor_a') < pg_temp.fx('vendor_b')
       then array['Claim Reviewer', 'Vendor Super Admin']
       else array['Finance Admin', 'Vendor Super Admin']
  end,
  'a multi-Vendor Super Admin gets the roles of the LOWEST-organization-id Vendor — the shipped rule');

-- AND THE SAME VENDOR PORTALCONTEXT REPORTS. This is what makes composing the two calls on one
-- screen safe: the company name and the role list are always about the same organization.
select is(
  pg_temp.portal_org_name(),
  case when pg_temp.fx('vendor_a') < pg_temp.fx('vendor_b')
       then 'Acme Vendor' else 'Bravo Vendor' end,
  'get_my_portal_context() resolves the SAME Vendor for the same caller — the two reads cannot disagree');

-- A SECOND MEMBERSHIP IN A RETAILER DOES NOT ADD A ROW EITHER. Ada holds one; her row count is 1.
select pg_temp.act_as(pg_temp.fx('ada'));
select is(
  (select count(*) from public.organization_members where user_id = pg_temp.fx('ada')),
  2::bigint,
  'Ada really does hold TWO memberships — so the single-row assertion is not vacuous');
select is(pg_temp.row_count(), 1::bigint,
  'a caller with a membership in another organization still receives exactly ONE row');


-- ============================================================================
-- SECTION E — the exact permission requirement
-- ============================================================================
-- The function demands the VENDOR_SUPER_ADMIN role AND RBAC_READ. The mapping is removed and
-- restored, proving the requirement is genuine — a test that removed nothing would pass against a
-- function that required nothing.

select pg_temp.act_as(pg_temp.fx('ada'));
select is(pg_temp.profile_error(), null,
  'with RBAC_READ mapped, Ada is authorized');

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

select pg_temp.unmap('RBAC_READ');
select is(pg_temp.profile_error(), '42501',
  'a Vendor Super Admin MISSING RBAC_READ is denied — narrower than the RLS policy, which is an OR');
select pg_temp.remap('RBAC_READ');

select is(pg_temp.profile_error(), null,
  'restoring RBAC_READ restores access — the denial above was caused by the removal');

-- ORGANIZATION_MEMBERS_READ IS *NOT* REQUIRED, AND THAT IS DELIBERATE. Reading one's own name is
-- an ownership fact, not a directory capability: the migration-5 policies admit a caller's own
-- profile and membership rows unconditionally. Asserted so a later "tighten it up" edit that
-- added the requirement would fail here and have to justify itself.
select pg_temp.unmap('ORGANIZATION_MEMBERS_READ');
select is(pg_temp.profile_error(), null,
  'a Vendor Super Admin WITHOUT ORGANIZATION_MEMBERS_READ can still read their OWN profile');
select is(pg_temp.my_name(), 'Ada Admin',
  'and the row is unchanged — self data is gated by ownership, not by the directory permission');
select pg_temp.remap('ORGANIZATION_MEMBERS_READ');

-- AUDIT_LOGS_READ IS NOT REQUIRED EITHER — this read touches no audit row.
select pg_temp.unmap('AUDIT_LOGS_READ');
select is(pg_temp.profile_error(), null,
  'AUDIT_LOGS_READ is irrelevant to the profile read — no audit row is touched');
select pg_temp.remap('AUDIT_LOGS_READ');

-- NEVER MORE PERMISSIVE THAN THE DIRECTORY READ. list_vendor_users() also requires RBAC_READ, so
-- there is no permission state in which this function reveals a role name the directory would
-- refuse. Asserted as a paired comparison rather than by inspection.
select pg_temp.unmap('RBAC_READ');
select is(
  pg_temp.sqlstate_of('select * from public.list_vendor_users()'),
  pg_temp.profile_error(),
  'when RBAC_READ is withdrawn, BOTH the directory read and the profile read refuse identically');
select pg_temp.remap('RBAC_READ');

-- THE ROLE NAMES MATCH THE DIRECTORY EXACTLY. One database, one answer: the caller's own row in
-- list_vendor_users() must carry the same name and the same role array.
select is(
  pg_temp.my_name(),
  (select u.display_name from public.list_vendor_users() u
    where u.display_name = 'Ada Admin'),
  'the display name is byte-identical to the caller''s own list_vendor_users() row');

select is(
  pg_temp.my_roles(),
  (select u.role_names from public.list_vendor_users() u
    where u.display_name = 'Ada Admin'),
  'the role names are byte-identical to the caller''s own list_vendor_users() row');


-- ============================================================================
-- SECTION F — the statuses really are CONDITIONS, not omitted output
-- ============================================================================
-- The migration argues that no status column is returned because an authorized caller is ACTIVE
-- in all three by construction. That is a claim about the authorization chain, so it is asserted
-- as one: every caller who receives a row has an ACTIVE profile, an ACTIVE membership and an
-- ACTIVE organization. If any of the three could be non-ACTIVE while a row was returned, the
-- omission would be hiding a real value and the field would have to exist.

select pg_temp.act_as(pg_temp.fx('ada'));

select is(
  (select p.status from public.profiles p where p.id = pg_temp.fx('ada')),
  'ACTIVE',
  'an authorized caller''s PROFILE status is ACTIVE — so a returned column could only say ACTIVE');

select is(
  (select m.status from public.organization_members m where m.id = pg_temp.fx('m_ada')),
  'ACTIVE',
  'an authorized caller''s MEMBERSHIP status is ACTIVE');

select is(
  (select o.status from public.organizations o where o.id = pg_temp.fx('vendor_a')),
  'ACTIVE',
  'an authorized caller''s ORGANIZATION status is ACTIVE');

-- The converse, already proven per-case in Section C, stated as the general rule: no non-ACTIVE
-- profile, membership or organization can obtain a row at all.
select pg_temp.record_denial('recheck_bob',  pg_temp.fx('bob'));
select pg_temp.record_denial('recheck_cara', pg_temp.fx('cara'));
select pg_temp.record_denial('recheck_fred', pg_temp.fx('fred'));

select is(
  (select count(*) from pg_temp.denials where who like 'recheck_%' and state = '42501'),
  3::bigint,
  'a SUSPENDED profile, a DEACTIVATED membership and a SUSPENDED membership all get NO row — the statuses are conditions');


-- ============================================================================
-- SECTION G — PortalContext non-duplication
-- ============================================================================
-- The audit's architectural decision is that the COMPANY half of the mobile screen is served by
-- get_my_portal_context() and this function adds only the personal half. That is a relationship
-- between two contracts, so it is asserted as one rather than left to the field names.

select pg_temp.act_as(pg_temp.fx('ada'));

-- PortalContext DOES supply the organization name, so requiring Flutter to use it is not a
-- deferral to something that does not work.
select is(pg_temp.portal_org_name(), 'Acme Vendor',
  'get_my_portal_context() really does return the Vendor organization name');

-- And this function does NOT. Asserted over the catalogue column names (no company field exists)
-- and over the returned values (no field carries the organization name as data).
select ok(
  pg_temp.my_name() <> 'Acme Vendor'
  and not ('Acme Vendor' = any (pg_temp.my_roles())),
  'the self-read returns the organization name in NO field — there is exactly one source for it');

-- PortalContext does NOT supply the caller's name or roles, which is why this function exists.
-- Asserted so "the gap is real" is a test rather than a paragraph.
select ok(
  (public.get_my_portal_context() -> 'vendor') ? 'organization_id'
  and (public.get_my_portal_context() -> 'vendor') ? 'organization_name',
  'PortalContext''s vendor block carries exactly the two company keys');

select is(
  (select count(*) from jsonb_object_keys(public.get_my_portal_context() -> 'vendor') k
    where k not in ('organization_id', 'organization_name')),
  0::bigint,
  'PortalContext''s vendor block carries NOTHING ELSE — no caller name, no role, no status');

select ok(
  public.get_my_portal_context()::text not like '%Ada Admin%'
  and public.get_my_portal_context()::text not like '%Vendor Super Admin%',
  'PortalContext returns neither the caller''s display name nor a role display name — the gap this function fills');

-- PortalContext still answers for a caller this function refuses, and the two refusals are
-- deliberately DIFFERENT in kind: PortalContext returns portal_kind "NONE" as a VALUE, while this
-- function RAISES. A client must not collapse one into the other.
select pg_temp.act_as(pg_temp.fx('owner'));
select is(
  public.get_my_portal_context() ->> 'portal_kind',
  'RETAILER_OWNER',
  'PortalContext still answers for a Retailer Owner — it is not gated on Vendor authority');
select is(pg_temp.profile_error(), '42501',
  'while the Vendor profile read refuses the same caller — different contracts, different subjects');

select pg_temp.act_as(pg_temp.fx('no_org'));
select is(
  public.get_my_portal_context() ->> 'portal_kind',
  'NONE',
  'PortalContext expresses denial as a VALUE ("NONE")');
select is(pg_temp.profile_error(), '42501',
  'the Vendor profile read expresses denial as an EXCEPTION — a client must not collapse the two');


-- ============================================================================
-- SECTION H — nothing was written, and nothing else changed
-- ============================================================================
-- The function is STABLE (Section A) so it cannot write, but "no row moved" is worth asserting
-- against the tables it reads, because a trigger-driven side effect would not be caught by the
-- volatility flag alone.

select pg_temp.act_as(pg_temp.fx('ada'));

create table pg_temp.before_counts as
select
  (select count(*) from public.profiles)             as profiles,
  (select count(*) from public.organization_members)  as members,
  (select count(*) from public.member_roles)          as member_roles,
  (select count(*) from public.roles)                 as roles,
  (select count(*) from public.audit_logs)            as audit_logs,
  (select max(updated_at) from public.profiles)       as profiles_touched;

select is(pg_temp.row_count(), 1::bigint, 'the read runs');
select is(pg_temp.row_count(), 1::bigint, 'and again — it is repeatable');

select is(
  (select b.profiles = (select count(*) from public.profiles)
      and b.members  = (select count(*) from public.organization_members)
      and b.member_roles = (select count(*) from public.member_roles)
      and b.roles    = (select count(*) from public.roles)
      and b.audit_logs = (select count(*) from public.audit_logs)
      and b.profiles_touched = (select max(updated_at) from public.profiles)
   from pg_temp.before_counts b),
  true,
  'calling the self-read inserts, updates and deletes NOTHING — including no audit row');


-- ============================================================================
-- SECTION I — display-name composition, and its UNREACHABLE fallback
-- ============================================================================
-- Section B proves the composition for the two shapes the schema actually permits ("Ada Admin",
-- and padded parts trimmed to "Pia Padded"). This section pins the FULL semantics of the
-- expression AND proves that every other shape is impossible to store — which is what makes the
-- 'Member' floor a defensive floor rather than a branch a client must handle.
--
-- WHY THIS MATTERS. lib/auth/vendor-admin-access.ts falls back to 'Vendor Admin' while this
-- function, list_vendor_users() and get_vendor_user_detail() fall back to 'Member'. That
-- divergence is only OBSERVABLE if a profile can hold two blank name parts. The constraint proofs
-- below are the evidence that it cannot, so the divergence is unreachable and the web is
-- deliberately left alone.

-- The expression itself, on every name shape. Evaluated directly rather than through the function,
-- because the table cannot be made to hold most of these — which is precisely the point.
select is(
  (select coalesce(nullif(btrim(btrim(f) || ' ' || btrim(l)), ''), 'Member')
     from (values ('Ada','Admin')) v(f,l)),
  'Ada Admin',
  'composition: both parts present -> "First Last"');

select is(
  (select coalesce(nullif(btrim(btrim(f) || ' ' || btrim(l)), ''), 'Member')
     from (values ('  Pia  ','  Padded  ')) v(f,l)),
  'Pia Padded',
  'composition: padding is trimmed on BOTH parts and they are joined by exactly one space');

select is(
  (select coalesce(nullif(btrim(btrim(f) || ' ' || btrim(l)), ''), 'Member')
     from (values ('Ada','')) v(f,l)),
  'Ada',
  'composition: first name only -> no trailing space (UNREACHABLE — see the CHECK proofs below)');

select is(
  (select coalesce(nullif(btrim(btrim(f) || ' ' || btrim(l)), ''), 'Member')
     from (values ('','Admin')) v(f,l)),
  'Admin',
  'composition: last name only -> no leading space (UNREACHABLE)');

select is(
  (select coalesce(nullif(btrim(btrim(f) || ' ' || btrim(l)), ''), 'Member')
     from (values ('   ','  ')) v(f,l)),
  'Member',
  'composition: both parts whitespace-only -> the fallback literal (UNREACHABLE)');

select is(
  (select coalesce(nullif(btrim(btrim(f) || ' ' || btrim(l)), ''), 'Member')
     from (values ('','')) v(f,l)),
  'Member',
  'composition: both parts empty -> the fallback literal (UNREACHABLE)');

-- NULL PROPAGATION. btrim(null) is null and `null || ' '` is null, so a null part collapses the
-- whole expression to null and the coalesce catches it. Asserted for each null position, because a
-- future rewrite using concat() instead of || would silently change this (concat treats null as '').
select is(
  (select coalesce(nullif(btrim(btrim(f) || ' ' || btrim(l)), ''), 'Member')
     from (values (null::text,null::text)) v(f,l)),
  'Member',
  'composition: both parts NULL -> the fallback literal, never a bare null (UNREACHABLE)');

select is(
  (select coalesce(nullif(btrim(btrim(f) || ' ' || btrim(l)), ''), 'Member')
     from (values (null::text,'Admin')) v(f,l)),
  'Member',
  'composition: a NULL first name collapses the whole value — || propagates null (UNREACHABLE)');

select is(
  (select coalesce(nullif(btrim(btrim(f) || ' ' || btrim(l)), ''), 'Member')
     from (values ('Ada',null::text)) v(f,l)),
  'Member',
  'composition: a NULL last name collapses the whole value (UNREACHABLE)');

-- NOW THE UNREACHABILITY PROOFS. public.profiles constrains BOTH name columns NOT NULL and
-- `length(trim(...)) > 0` (20260716124419), so none of the shapes marked UNREACHABLE above can be
-- stored — on INSERT or on UPDATE.
select ok(
  (select count(*) from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and conname in ('profiles_first_name_not_empty', 'profiles_last_name_not_empty')) = 2,
  'both profiles name columns carry a non-empty-after-trim CHECK');

select ok(
  (select count(*) from pg_attribute
    where attrelid = 'public.profiles'::regclass
      and attname in ('first_name','last_name')
      and attnotnull) = 2,
  'both profiles name columns are NOT NULL');

-- A person to attempt the impossible writes against. Created here, not in the fixture block, so
-- the attempts sit beside the claim they support.
insert into auth.users (id, email)
values ('dddddddd-0000-0000-0000-00000000000d', 'floor@test.invalid');

select throws_ok(
  $$insert into public.profiles (id, first_name, last_name)
    values ('dddddddd-0000-0000-0000-00000000000d', null, 'Surname')$$,
  '23502',
  null,
  'a NULL first_name cannot be stored');

select throws_ok(
  $$insert into public.profiles (id, first_name, last_name)
    values ('dddddddd-0000-0000-0000-00000000000d', 'Given', null)$$,
  '23502',
  null,
  'a NULL last_name cannot be stored');

select throws_ok(
  $$insert into public.profiles (id, first_name, last_name)
    values ('dddddddd-0000-0000-0000-00000000000d', '', 'Surname')$$,
  '23514',
  null,
  'an EMPTY first_name cannot be stored');

select throws_ok(
  $$insert into public.profiles (id, first_name, last_name)
    values ('dddddddd-0000-0000-0000-00000000000d', 'Given', '')$$,
  '23514',
  null,
  'an EMPTY last_name cannot be stored');

select throws_ok(
  $$insert into public.profiles (id, first_name, last_name)
    values ('dddddddd-0000-0000-0000-00000000000d', '   ', '  ')$$,
  '23514',
  null,
  'WHITESPACE-ONLY name parts cannot be stored — so the fallback literal is unreachable');

-- Padded but non-empty IS storable, which is why Section B's "Pia Padded" case is real.
select lives_ok(
  $$insert into public.profiles (id, first_name, last_name)
    values ('dddddddd-0000-0000-0000-00000000000d', '  Given  ', '  Surname  ')$$,
  'padded but non-empty name parts ARE storable — the trimming case is reachable');

-- And the constraint holds on UPDATE too, so an existing profile cannot be emptied later.
select throws_ok(
  $$update public.profiles set first_name = '   '
     where id = 'dddddddd-0000-0000-0000-00000000000d'$$,
  '23514',
  null,
  'an existing profile cannot be UPDATED to a blank name either');

-- THE FALLBACK LITERAL IS THE SAME ONE THE OTHER SQL READS USE. Asserted against the deployed
-- function bodies, so a future edit that changed one and not the others fails here.
select ok(
  (select pg_get_functiondef(p.oid) like '%''Member''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_my_vendor_profile'),
  'get_my_vendor_profile uses the ''Member'' floor');

select ok(
  (select bool_and(pg_get_functiondef(p.oid) like '%''Member''%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('list_vendor_users', 'get_vendor_user_detail')),
  'and so do list_vendor_users() and get_vendor_user_detail() — one answer inside the database');

-- Under the constraints above, the display name for ANY storable profile is exactly
-- "trim(first) || ' ' || trim(last)". Asserted end to end against the function for the caller.
select pg_temp.act_as(pg_temp.fx('ada'));
select is(
  pg_temp.my_name(),
  (select btrim(p.first_name) || ' ' || btrim(p.last_name)
     from public.profiles p where p.id = pg_temp.fx('ada')),
  'for any STORABLE profile the returned name is exactly trim(first) || one space || trim(last)');


-- ============================================================================
-- SECTION J — an empty role array is UNREACHABLE, and duplicates cannot inflate
-- ============================================================================
-- Section B observes that the array is never empty for an authorized caller. That is an
-- observation about a fixture. This proves it is a PROPERTY of the authorization chain: the only
-- way to empty the array is to remove the very assignment that authorizes the caller, which
-- produces a refusal instead.

select pg_temp.act_as(pg_temp.fx('ivy'));
select is(pg_temp.my_roles(), array['Vendor Super Admin'],
  'Ivy holds exactly the one authorizing role');

select lives_ok(
  $$delete from public.member_roles
     where organization_member_id = (select id from public.organization_members
                                      where user_id = (select id from public.profiles
                                                        where first_name = 'Ivy'))$$,
  'Ivy''s only role assignment can be removed');

select is(pg_temp.profile_error(), '42501',
  'removing the authorizing role DENIES — an empty role array is unreachable, not merely unobserved');

select pg_temp.add_role(pg_temp.fx('m_ivy'), 'VENDOR_SUPER_ADMIN');
select is(pg_temp.my_roles(), array['Vendor Super Admin'],
  'restoring it restores the row — the denial above was caused by the removal');

-- DUPLICATE ROLE ASSIGNMENT IS FORBIDDEN BY THE SCHEMA, so a role name cannot appear twice.
select pg_temp.act_as(pg_temp.fx('ada'));

-- Addressed through the fixture helper, so the statement names exactly Ada's Vendor A membership
-- and the role she already holds on it — no incidental predicate could make this throw for another
-- reason. pg_temp.add_role() cannot be reused here: it carries `on conflict do nothing`, which
-- would swallow the very violation being asserted.
select throws_ok(
  $$insert into public.member_roles (organization_member_id, role_id)
    select pg_temp.fx('m_ada'), r.id
    from public.roles r
    where r.code = 'VENDOR_SUPER_ADMIN'$$,
  '23505',
  null,
  'a DUPLICATE (membership, role) assignment violates member_roles_pkey — a role cannot be held twice');

select is(pg_temp.my_roles(), array['Claim Reviewer', 'Vendor Super Admin'],
  'and the array is unchanged after the failed duplicate — no name is repeated');

-- Ada holds TWO memberships and TWO active roles; the outer row is still one, and the array still
-- has two entries. A join instead of a correlated aggregate would have produced two rows.
select is(pg_temp.row_count(), 1::bigint,
  'two roles and two memberships still yield ONE row');

select is(array_length(pg_temp.my_roles(), 1), 2,
  'and exactly two array entries — the aggregate cannot duplicate or drop one');


-- ============================================================================
-- SECTION K — the function is STRICTLY NARROWER than RLS, never wider
-- ============================================================================
-- The migration claims that requiring the role AND RBAC_READ "can only refuse callers the policies
-- would have admitted, never admit one they would refuse". That is a comparison against RLS, so it
-- is asserted as one: the same caller is put through the ACTUAL policies as the `authenticated`
-- role, with RBAC_READ withdrawn, and the two answers are compared.

create function pg_temp.count_as_authenticated(p_sql text) returns bigint
language plpgsql as $$
declare v_count bigint;
begin
  set local role authenticated;
  execute p_sql into v_count;
  reset role;
  return v_count;
exception when others then
  reset role;
  raise;
end;
$$;

select pg_temp.act_as(pg_temp.fx('ada'));

-- WITH RBAC_READ WITHDRAWN the RLS policy still admits this caller to the role catalogue, because
-- roles_select_rbac_authorized is an OR whose second branch is the VENDOR_SUPER_ADMIN ROLE.
select pg_temp.unmap('RBAC_READ');

select ok(
  pg_temp.count_as_authenticated('select count(*) from public.roles') > 0,
  'RLS STILL admits the caller to the roles catalogue without RBAC_READ — the policy is an OR on the role');

select is(pg_temp.profile_error(), '42501',
  'the function refuses that same caller anyway — it is STRICTLY NARROWER than the policies, never wider');

select pg_temp.remap('RBAC_READ');

-- AND SELF ROWS NEED NO PERMISSION AT ALL, which is why ORGANIZATION_MEMBERS_READ is not required.
-- Every role→permission mapping is removed, so no permission-based policy branch can be true; the
-- caller still reads their own profile, their own membership and their own role assignments.
create table pg_temp.self_rls as select 0::bigint p, 0::bigint m, 0::bigint mr;
delete from pg_temp.self_rls;

select lives_ok($$delete from public.role_permissions$$,
  'every role→permission mapping can be removed inside the test transaction');

insert into pg_temp.self_rls
select
  pg_temp.count_as_authenticated(
    'select count(*) from public.profiles where id = ' || quote_literal(pg_temp.fx('ada')) || '::uuid'),
  pg_temp.count_as_authenticated(
    'select count(*) from public.organization_members where user_id = ' || quote_literal(pg_temp.fx('ada')) || '::uuid'),
  pg_temp.count_as_authenticated(
    'select count(*) from public.member_roles where organization_member_id = ' || quote_literal(pg_temp.fx('m_ada')) || '::uuid');

select is((select p from pg_temp.self_rls), 1::bigint,
  'with NO permission mapped at all, the caller still reads their OWN profile row under RLS');

select ok((select m from pg_temp.self_rls) >= 1,
  'and their OWN membership rows — self access is gated by ownership, not by ORGANIZATION_MEMBERS_READ');

select ok((select mr from pg_temp.self_rls) >= 1,
  'and their OWN role assignments — which is why requiring the directory permission would be untrue');

-- Restore, so nothing after this depends on the stripped catalogue.
select pg_temp.remap('ORGANIZATION_MEMBERS_READ');
select pg_temp.remap('RBAC_READ');
select pg_temp.remap('AUDIT_LOGS_READ');

select is(pg_temp.profile_error(), null,
  'restoring the mappings restores access');


-- ============================================================================
-- SECTION L — a caller whose auth user is gone
-- ============================================================================
-- public.profiles.id references auth.users(id) ON DELETE CASCADE, and
-- public.organization_members.user_id references public.profiles(id) ON DELETE CASCADE. Deleting
-- the Auth account therefore removes the profile and the membership, and the caller resolves to no
-- Vendor. The claim is that this DENIES rather than producing a row with a fallback name.

select pg_temp.act_as(pg_temp.fx('zara'));
select is(pg_temp.profile_error(), null, 'Zara is authorized while her auth user exists');

select lives_ok(
  $$delete from auth.users where id = (select id from public.profiles where first_name = 'Zara')$$,
  'Zara''s auth user can be deleted');

select is(
  (select count(*) from public.profiles where first_name = 'Zara'),
  0::bigint,
  'her profile cascaded away with the auth user');

select is(pg_temp.profile_error(), '42501',
  'a caller whose auth user is ABSENT is denied — never a row carrying the fallback name');


select finish();

rollback;
