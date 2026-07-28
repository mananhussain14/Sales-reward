-- pgTAP behavioural tests for the Retailer staff MEMBERSHIP LIFECYCLE contracts:
--
--   public.set_retailer_staff_membership_status(uuid, text)
--   public.get_my_lifecycle_access_state()
--     [20260810090000_retailer_staff_membership_lifecycle.sql]
--
-- Run with:   npx supabase test db      (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE SPECIFIES
-- ============================================================================
-- This is the FIRST operation that can stand a Retailer staff member down, and the first
-- that can put them back. Everything a second client (web or Flutter) will depend on is
-- stated here rather than inferred from the migration's prose:
--
--   1. DEACTIVATION IS A MEMBERSHIP FACT, NOT AN IDENTITY FACT. Exactly one row and two
--      columns move. Sections L and O are the whole of that guarantee: the role assignment,
--      the live AND retired Shop rows, the profile, the receipt history and the invitation
--      history are all still there afterwards, byte for byte, which is what makes
--      reactivation a one-column write rather than a rebuild.
--   2. auth.users IS NEVER TOUCHED. Not banned, not deleted, not updated. A deactivated
--      person can still SIGN IN; they simply have no Retailer context. Section O proves the
--      block happens at the RPC using their EXISTING session, with no sign-out required.
--   3. ONLY TWO ROLE SHAPES ARE ELIGIBLE — exactly {RETAILER_MANAGER} or exactly
--      {SALES_STAFF}. Every RETAILER_OWNER target, every multi-role target and every
--      role-less target is refused. Section F is that matrix.
--   4. THE CALLER MAY NOT ADDRESS THEMSELVES, and Section F proves this with a caller whose
--      OWN membership is not an Owner — otherwise the Owner rule would be doing the work and
--      the self rule would be untested.
--   5. A NO-OP WRITES NOTHING, INCLUDING NO AUDIT ROW AND NO NEW deactivated_at. Section H.
--   6. EVERY DISCLOSURE-SENSITIVE REFUSAL IS BYTE-IDENTICAL. Unknown, foreign, Owner,
--      multi-role, role-less, INVITED, SUSPENDED and self targets all produce the same
--      42501 and the same message, so a caller cannot sweep membership ids.
--   7. THE DIAGNOSTIC IS SELF-ONLY AND SAYS NOTHING ELSE. Section P walks all six words of
--      the access_state vocabulary and proves the value carries no id, name, email, role,
--      timestamp or database message.
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as
-- the `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as far
-- as every authorization helper in this schema is concerned. pg_temp.act_as() does exactly
-- that and pg_temp.sign_out() clears it. This mirrors every other suite in this directory —
-- one idiom for "signed in", not seven.
--
-- IT IS ALSO WHAT MAKES SECTION O MEANINGFUL. Deactivating a membership does not clear the
-- GUC, so the caller in Section O is still holding the very session they held before they
-- were stood down. That is precisely the "already-issued session" case the milestone had to
-- prove, and it is provable here only because nothing about the session is re-established
-- between the two calls.
--
-- The tests do NOT `set role authenticated` except in Section M, where denial of DIRECT
-- table access is the subject. Both functions are SECURITY DEFINER, so their behaviour
-- depends on auth.uid() and not on the session role, and switching roles for the rest of the
-- suite would only make the fixture inserts fail. EXECUTE privilege is asserted directly
-- against the catalogue in Sections A and B, which is stronger than "it did not error for
-- me".
--
-- Everything runs inside one transaction and is rolled back: no membership, audit, receipt
-- or invitation row written below survives, and neither does Section D's temporary edit of
-- the seeded role -> permission mappings nor Section N's temporary trigger.
--
-- ============================================================================
-- DETERMINISM
-- ============================================================================
-- NO ASSERTION DEPENDS ON UUID ORDERING. Where a set has to be compared it is compared over
-- names or codes ordered by themselves, never over generated ids.
--
-- now() is the TRANSACTION timestamp and is constant for the whole file. That is USEFUL here
-- — `deactivated_at = now()` is exactly assertable — but it means now() cannot witness "this
-- row was written". ctid — the tuple's physical location, which ANY row-touching UPDATE
-- changes — is used instead wherever "nothing was written at all" must be proved.
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

/* An auth.users row with NO profile — the "never provisioned" shell that Section P
 * distinguishes from a deactivated person. */
create function pg_temp.new_shell(p_email text) returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_email);
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

  if p_role is not null then
    insert into public.member_roles (organization_member_id, role_id)
    select v_member, r.id from public.roles r where r.code = p_role
    on conflict do nothing;
  end if;

  return v_member;
end;
$$;

/* A second ACTIVE role on an existing membership — the multi-role target. */
create function pg_temp.add_role(p_member uuid, p_role text) returns void
language plpgsql as $$
begin
  insert into public.member_roles (organization_member_id, role_id)
  select p_member, r.id from public.roles r where r.code = p_role
  on conflict do nothing;
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

/* A LIVE Shop assignment, created DIRECTLY. Section L needs both a live row and a RETIRED
 * one, and the retired one is only reachable this way. */
create function pg_temp.raw_assign(p_member uuid, p_shop uuid, p_actor uuid,
                                   p_removed boolean default false)
returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.retailer_shop_members (organization_member_id, retailer_shop_id,
                                            assigned_by, removed_at)
  values (p_member, p_shop, p_actor, case when p_removed then now() else null end)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Observations
-- ---------------------------------------------------------------------------
create function pg_temp.member_status(p_member uuid) returns text
language sql stable as $$
  select m.status from public.organization_members m where m.id = p_member;
$$;

create function pg_temp.deactivated_at_of(p_member uuid) returns timestamptz
language sql stable as $$
  select m.deactivated_at from public.organization_members m where m.id = p_member;
$$;

/* The physical row version — the only non-vacuous witness that a write touched this row,
 * inside a suite where now() is constant. */
create function pg_temp.member_version(p_member uuid) returns text
language sql stable as $$
  select m.ctid::text from public.organization_members m where m.id = p_member;
$$;

/* The complete ACTIVE role-code set of a membership, ordered by code. This is what the
 * function under test must never change. */
create function pg_temp.role_codes(p_member uuid) returns text[]
language sql stable as $$
  select coalesce(array_agg(r.code order by r.code), '{}'::text[])
  from public.member_roles mr
  join public.roles r on r.id = mr.role_id
  where mr.organization_member_id = p_member
    and r.status = 'ACTIVE';
$$;

create function pg_temp.live_shop_names(p_member uuid) returns text[]
language sql stable as $$
  select coalesce(array_agg(s.name order by s.name), '{}'::text[])
  from public.retailer_shop_members sm
  join public.retailer_shops s on s.id = sm.retailer_shop_id
  where sm.organization_member_id = p_member
    and sm.removed_at is null;
$$;

create function pg_temp.retired_shop_names(p_member uuid) returns text[]
language sql stable as $$
  select coalesce(array_agg(s.name order by s.name), '{}'::text[])
  from public.retailer_shop_members sm
  join public.retailer_shops s on s.id = sm.retailer_shop_id
  where sm.organization_member_id = p_member
    and sm.removed_at is not null;
$$;

create function pg_temp.shop_row_count(p_member uuid) returns bigint
language sql stable as $$
  select count(*) from public.retailer_shop_members sm
  where sm.organization_member_id = p_member;
$$;

create function pg_temp.receipt_count(p_profile uuid) returns bigint
language sql stable as $$
  select count(*) from public.receipt_submissions rs
  where rs.submitted_by_profile_id = p_profile;
$$;

create function pg_temp.invitation_count(p_member uuid) returns bigint
language sql stable as $$
  select count(*) from public.retailer_staff_invitations i
  where i.organization_member_id = p_member;
$$;

create function pg_temp.profile_status(p_profile uuid) returns text
language sql stable as $$
  select p.status from public.profiles p where p.id = p_profile;
$$;

create function pg_temp.auth_user_exists(p_user uuid) returns boolean
language sql stable as $$
  select exists (select 1 from auth.users u where u.id = p_user);
$$;

-- ---------------------------------------------------------------------------
-- Error capture
-- ---------------------------------------------------------------------------
/*
 * The SQLSTATE raised when the current caller runs p_sql, or NULL if it returned normally.
 * Sequenced in plpgsql on purpose: throws_ok() cannot express the "this refusal is
 * byte-identical to that one" comparisons Section F needs.
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

/* The write under test, as text, so a denial and a success are written the same way. */
create function pg_temp.set_sql(p_member uuid, p_status text) returns text
language sql immutable as $$
  select format(
    'select * from public.set_retailer_staff_membership_status(%L::uuid, %L::text)',
    p_member, p_status);
$$;

/* The write under test, returning its four fields as text so one assertion can state the
 * whole returned row. */
create function pg_temp.set_status(p_member uuid, p_status text) returns text[]
language plpgsql as $$
declare
  v_id      uuid;
  v_st      text;
  v_role    text;
  v_changed boolean;
begin
  select t.membership_id, t.membership_status, t.role_code, t.status_changed
    into v_id, v_st, v_role, v_changed
  from public.set_retailer_staff_membership_status(p_member, p_status) t;
  return array[v_id::text, v_st, v_role, v_changed::text];
end;
$$;

/* The diagnostic under test, as its single word. */
create function pg_temp.my_state() returns text
language sql stable as $$
  select s.access_state from public.get_my_lifecycle_access_state() s;
$$;

/* How many rows the diagnostic returns. "Exactly one row" is part of the contract and a
 * function that returned two would still satisfy every value assertion below. */
create function pg_temp.my_state_rows() returns bigint
language sql stable as $$
  select count(*) from public.get_my_lifecycle_access_state();
$$;

/* BECOME p_user, then ask the diagnostic about them.
 *
 * The impersonation and the question have to happen in that order inside ONE call, because
 * the diagnostic takes no argument — there is no way to ask about somebody without being
 * them, which is the entire point of the contract. Sequenced in plpgsql rather than written
 * as a subquery in a WHERE clause, so the order is guaranteed rather than left to the
 * planner. */
create function pg_temp.state_of(p_user uuid) returns text
language plpgsql as $$
begin
  perform pg_temp.act_as(p_user);
  return pg_temp.my_state();
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
create function pg_temp.audit_count(p_member uuid) returns bigint
language sql stable as $$
  select count(*) from public.audit_logs a
  where a.entity_type = 'RETAILER_STAFF_MEMBER'
    and a.entity_id = p_member::text;
$$;

/* The most recently appended audit row for a membership. ctid is physical insertion order,
 * which for rows appended in one transaction is the order they were written — created_at
 * cannot order them, because now() is constant here. */
create function pg_temp.last_audit(p_member uuid) returns public.audit_logs
language sql stable as $$
  select a.* from public.audit_logs a
  where a.entity_type = 'RETAILER_STAFF_MEMBER' and a.entity_id = p_member::text
  order by a.ctid desc limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Catalogue introspection
-- ---------------------------------------------------------------------------
/* Function-argument and table-column names, read from the catalogue.
 *
 * A multi-column `returns table (...)` function has prorettype = `record`, a pseudo-type
 * with no typrelid, so reading its columns through pg_class yields NOTHING and an assertion
 * written that way compares NULL to NULL and passes vacuously. The names live in
 * proargnames, distinguished only by proargmodes: 'i'/'b'/'v' for an input, 't' for a table
 * column. */
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

create function pg_temp.out_types(p_name text) returns text[]
language sql stable as $$
  select coalesce(array_agg(format_type(x.t, null) order by x.ord), '{}'::text[])
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(p.proallargtypes) with ordinality as x(t, ord)
  join lateral unnest(p.proargmodes) with ordinality as m(mode, mord) on m.mord = x.ord
  where n.nspname = 'public' and p.proname = p_name and m.mode = any (array['t'::"char", 'o'::"char"]);
$$;

create function pg_temp.installed_source(p_name text) returns text
language sql stable as $$
  select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name;
$$;

/* The installed body with every `--` comment line removed.
 *
 * Load-bearing, not tidiness: both bodies' commentary discusses auth.users, DELETE,
 * RETAILER_OWNER and service_role at length precisely to explain why none of them is used,
 * so an assertion against the raw source would fail on the sentence that states the
 * guarantee. Same idiom as the stripComments() helper in the Node contract suite. */
create function pg_temp.installed_code(p_name text) returns text
language sql stable as $$
  select string_agg(line, E'\n')
  from unnest(string_to_array(pg_temp.installed_source(p_name), E'\n')) as line
  where line !~ '^\s*--';
$$;

create function pg_temp.proacl_of(p_name text) returns text
language sql stable as $$
  select coalesce(array_to_string(p.proacl, ','), '')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = p_name;
$$;

create table pg_temp.fx (k text primary key, v uuid);
create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.fx where k = p_k; $$;

-- The two functions under test, named once each so a rename shows up as one failure rather
-- than sixty.
create function pg_temp.wfn() returns text language sql immutable as $$
  select 'set_retailer_staff_membership_status'::text;
$$;
create function pg_temp.rfn() returns text language sql immutable as $$
  select 'get_my_lifecycle_access_state'::text;
$$;


-- ============================================================================
-- SECTION A — the WRITE contract: signature, security attributes, privileges
-- ============================================================================
-- Asserted against the catalogue rather than inferred from behaviour: "it did not error for
-- me" is not a privilege check, and a grant that widened by accident would still let every
-- behavioural test below pass.

select has_function('public', 'set_retailer_staff_membership_status', array['uuid', 'text'],
  'set_retailer_staff_membership_status(uuid, text) exists');

-- EXACTLY ONE staff membership-status write exists. This milestone added no second entry
-- point — no deactivate_/reactivate_ pair, no bulk variant, no mobile duplicate. A second
-- one would be a second place for the Owner exclusion, the self exclusion and the eligible
-- role set to be stated, and only one of them could stay right.
select is(
  (select array_agg(p.proname::text order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname ~ 'staff_membership_status'),
  array['set_retailer_staff_membership_status'],
  'exactly one staff membership-status write exists — no deactivate/reactivate pair, no bulk variant');

-- THE SIGNATURE IS THE DEPLOYED ONE. Clients call this by NAMED argument through PostgREST,
-- so a renamed parameter or a reordered pair is a silently broken client.
select is(pg_temp.input_types(pg_temp.wfn()), array['uuid', 'text'],
  'takes exactly (uuid, text)');
select is(pg_temp.input_args(pg_temp.wfn()), array['p_membership_id', 'p_status'],
  'exposes exactly (p_membership_id, p_status), in that order');

-- NO DEFAULTS. Both arguments are required, so a call that omits one is a PostgREST error
-- rather than a silently half-addressed write.
select is(
  (select p.pronargdefaults::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.wfn()),
  0, 'no argument is defaulted');

-- THE RETURN SHAPE IS THE FOUR FIELDS, AND ONLY THEM. No email, no name, no timestamp, no
-- organization, no audit detail.
select is(pg_temp.out_args(pg_temp.wfn()),
  array['membership_id', 'membership_status', 'role_code', 'status_changed'],
  'returns exactly (membership_id, membership_status, role_code, status_changed), in that order');
select is(pg_temp.out_types(pg_temp.wfn()),
  array['uuid', 'text', 'text', 'boolean'],
  'the four returned columns are (uuid, text, text, boolean)');

-- NO IDENTITY, TENANT, ROLE, PERMISSION, AUDIT OR TIMESTAMP ARGUMENT. This is the
-- trusted-identity rule stated as a test: a caller may address a membership and name a
-- state, and nothing else. Everything that decides WHETHER the write may happen is derived
-- server-side from auth.uid().
select is(
  (select count(*) from unnest(pg_temp.input_args(pg_temp.wfn())) a
   where a ~ 'organization|retailer|tenant|owner|actor|user|profile|auth|uid|email|token|claim|role|permission|audit|version|reason|note|timestamp|deactivated'),
  0::bigint,
  'accepts no organization, Retailer, tenant, actor, user, profile, auth, email, token, role, permission, audit, version or timestamp argument');

select is(
  (select count(*) from unnest(pg_temp.input_args(pg_temp.wfn())) a
   where a not in ('p_membership_id', 'p_status')),
  0::bigint,
  'accepts the membership and the requested state and NOTHING else — no current status, no audit action, no idempotency key');

-- SECURITY DEFINER, VOLATILE, EMPTY search_path.
select ok(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.wfn()),
  'the write is SECURITY DEFINER');
select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.wfn()),
  'v', 'the write is VOLATILE — the correct classification for a function that writes');
select ok(
  (select p.proconfig @> array['search_path=""'] from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.wfn()),
  'the write runs with an EMPTY search_path');

-- GRANTS: authenticated only.
select ok(has_function_privilege('authenticated',
  'public.set_retailer_staff_membership_status(uuid, text)', 'execute'),
  'authenticated may execute the status write');
select ok(not has_function_privilege('anon',
  'public.set_retailer_staff_membership_status(uuid, text)', 'execute'),
  'anon may NOT execute the status write');

-- PUBLIC holds nothing. PostgreSQL grants EXECUTE to PUBLIC by default on every new
-- function, which on a SECURITY DEFINER writer would be exactly wrong; the migration revokes
-- it and this is what proves the revoke is still in force.
select ok(pg_temp.proacl_of(pg_temp.wfn()) !~ '(^|,)=X/',
  'the status write does not grant EXECUTE to PUBLIC');

-- NO SERVICE-ROLE GRANT. Its entire authority is auth.uid(), which a service-role connection
-- does not have, so a grant would produce a function that can only ever refuse — and would
-- invite a caller to try.
select ok(pg_temp.proacl_of(pg_temp.wfn()) !~ 'service_role=X',
  'the status write is NOT granted to service_role');

-- ---------------------------------------------------------------------------
-- The installed body — what it must never contain
-- ---------------------------------------------------------------------------
-- Asserted against the INSTALLED body rather than against the migration file, so a later
-- CREATE OR REPLACE cannot slip past it.

select ok(pg_temp.installed_code(pg_temp.wfn()) !~* '\mdelete\M',
  'the installed write body contains no DELETE — a membership is deactivated, never destroyed');
select ok(pg_temp.installed_code(pg_temp.wfn()) !~* '\mtruncate\M',
  'the installed write body contains no TRUNCATE');
select ok(pg_temp.installed_code(pg_temp.wfn()) !~* '\mexecute\M',
  'the installed write body contains no dynamic SQL');

-- auth.users IS NOT TOUCHED, AND IS NOT EVEN MENTIONED IN CODE. This is the single most
-- important structural guarantee of the milestone: no ban, no soft delete, no metadata
-- write, no read.
select ok(pg_temp.installed_code(pg_temp.wfn()) !~* 'auth\.users',
  'the installed write body never references auth.users — no ban, no delete, no update');

-- THE PRESERVED TABLES ARE NEVER WRITTEN. member_roles is READ (the role-set check) and must
-- never be written; retailer_shop_members is not referenced at all.
select ok(pg_temp.installed_code(pg_temp.wfn()) !~* '(insert\s+into|update)\s+public\.member_roles',
  'the installed write body never INSERTs or UPDATEs member_roles');
select ok(pg_temp.installed_code(pg_temp.wfn()) !~* 'retailer_shop_members',
  'the installed write body never references retailer_shop_members at all');
select ok(pg_temp.installed_code(pg_temp.wfn()) !~* '(insert\s+into|update)\s+public\.profiles',
  'the installed write body never writes profiles — profiles.status is not this feature''s to change');
select ok(pg_temp.installed_code(pg_temp.wfn()) !~* 'receipt_submissions|retailer_staff_invitations',
  'the installed write body never references receipts or invitations');

-- EXACTLY ONE UPDATE STATEMENT, AND IT IS AGAINST organization_members. A second one would
-- be a second thing this "one column pair" write changes.
select is(
  (select count(*) from regexp_matches(pg_temp.installed_code(pg_temp.wfn()),
                                       '\mupdate\s+public\.', 'gi')),
  1::bigint,
  'the installed write body contains exactly ONE UPDATE statement');
select ok(pg_temp.installed_code(pg_temp.wfn()) ~* 'update\s+public\.organization_members',
  'and that UPDATE targets public.organization_members');

-- THE LOCKING CLAUSES ARE PRESENT IN THE INSTALLED BODY. True concurrency cannot be
-- exercised inside one transaction (see Section K), so the mechanism is asserted here and its
-- OUTCOME — idempotency against committed state — is asserted behaviourally below.
select ok(pg_temp.installed_code(pg_temp.wfn()) ~* '\mfor\s+update\M',
  'the installed write body locks the target membership FOR UPDATE — the serialization point');
select ok(pg_temp.installed_code(pg_temp.wfn()) ~* '\mfor\s+share\M',
  'the installed write body pins the acting Retailer''s lifecycle row FOR SHARE');
select ok(pg_temp.installed_code(pg_temp.wfn()) ~* 'get\s+diagnostics',
  'the installed write body checks the UPDATE row count rather than assuming it');

-- THE PERMISSION IS NAMED, AND NO CALLER ROLE CODE GATES THE OPERATION. The role ->
-- permission MAPPING is the authority; a caller role code in the body would be a second,
-- drifting copy of it. RETAILER_MANAGER and SALES_STAFF DO appear — they constrain the
-- TARGET — and RETAILER_OWNER deliberately does NOT, because the Owner exclusion is achieved
-- by requiring an exact one-element role set rather than by naming the role that is banned.
select ok(pg_temp.installed_code(pg_temp.wfn()) like '%RETAILER_STAFF_MANAGE%',
  'the installed write body gates on the EXISTING RETAILER_STAFF_MANAGE permission');
select ok(pg_temp.installed_code(pg_temp.wfn()) not like '%RETAILER_OWNER%',
  'the executable write body names no RETAILER_OWNER role code — Owners are excluded by the exact-set rule, not by name');
select ok(pg_temp.installed_code(pg_temp.wfn()) like '%RETAILER_MANAGER%'
      and pg_temp.installed_code(pg_temp.wfn()) like '%SALES_STAFF%',
  'the executable write body names the two ELIGIBLE TARGET roles — a target restriction, not a caller gate');

-- NO NEW PERMISSION WAS INVENTED. The milestone was told to reuse RETAILER_STAFF_MANAGE, and
-- a permission catalogue that had grown a lifecycle-specific code would mean a second
-- authority for the same decision.
select is(
  (select count(*) from public.permissions p
   where p.code ~* 'LIFECYCLE|DEACTIVAT|REACTIVAT|STAFF_STATUS|MEMBERSHIP_STATUS'),
  0::bigint,
  'no new lifecycle/deactivation permission was created — RETAILER_STAFF_MANAGE is reused');


-- ============================================================================
-- SECTION B — the READ contract: signature, security attributes, privileges
-- ============================================================================

select has_function('public', 'get_my_lifecycle_access_state', '{}'::text[],
  'get_my_lifecycle_access_state() exists');

-- ZERO ARGUMENTS IS THE WHOLE SECURITY DESIGN. A function that accepted a profile id, an
-- email, a membership id or an organization id would be a lookup service for other people's
-- lifecycle states wearing a self-service label. There is nothing to substitute.
select is(
  (select p.pronargs::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.rfn()),
  0, 'the diagnostic takes ZERO arguments');
select is(pg_temp.input_types(pg_temp.rfn()), '{}'::text[],
  'the diagnostic declares no input types at all');
select is(pg_temp.input_args(pg_temp.rfn()), '{}'::text[],
  'and no input argument names — no tenant selector, no identifier, no filter');

-- EXACTLY ONE COLUMN, NAMED access_state, OF TYPE text.
select is(pg_temp.out_args(pg_temp.rfn()), array['access_state'],
  'returns exactly one column, named access_state');
select is(pg_temp.out_types(pg_temp.rfn()), array['text'],
  'and that column is text');

-- NO ID, NAME, EMAIL, ROLE, ORGANIZATION, STATUS OR TIMESTAMP COLUMN. Stated as an explicit
-- negative so a later edit that "helpfully" added organization_name fails here rather than in
-- a privacy review.
select is(
  (select count(*) from unnest(pg_temp.out_args(pg_temp.rfn())) c
   where c <> 'access_state'),
  0::bigint,
  'the diagnostic returns access_state and NOTHING else — no id, name, email, role, organization, raw status or timestamp');

-- SECURITY DEFINER, STABLE, EMPTY search_path.
select ok(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.rfn()),
  'the diagnostic is SECURITY DEFINER');
select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.rfn()),
  's', 'the diagnostic is STABLE — it writes nothing, not even an audit row');
select ok(
  (select p.proconfig @> array['search_path=""'] from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.rfn()),
  'the diagnostic runs with an EMPTY search_path');

-- GRANTS: authenticated only.
select ok(has_function_privilege('authenticated',
  'public.get_my_lifecycle_access_state()', 'execute'),
  'authenticated may execute the diagnostic');
select ok(not has_function_privilege('anon',
  'public.get_my_lifecycle_access_state()', 'execute'),
  'anon may NOT execute the diagnostic — a signed-out caller has no self to describe');
select ok(pg_temp.proacl_of(pg_temp.rfn()) !~ '(^|,)=X/',
  'the diagnostic does not grant EXECUTE to PUBLIC');
select ok(pg_temp.proacl_of(pg_temp.rfn()) !~ 'service_role=X',
  'the diagnostic is NOT granted to service_role');

-- IT PERFORMS NO WRITE OF ANY KIND. STABLE already forbids it at the engine level; the source
-- assertions state the intent, so a later edit that made it VOLATILE to "just log this" fails
-- both here and above.
select ok(pg_temp.installed_code(pg_temp.rfn()) !~* '\minsert\M',
  'the installed diagnostic body contains no INSERT — no audit row, no last-seen write');
select ok(pg_temp.installed_code(pg_temp.rfn()) !~* '\mupdate\M',
  'the installed diagnostic body contains no UPDATE');
select ok(pg_temp.installed_code(pg_temp.rfn()) !~* '\mdelete\M',
  'the installed diagnostic body contains no DELETE');
select ok(pg_temp.installed_code(pg_temp.rfn()) !~* '\mexecute\M',
  'the installed diagnostic body contains no dynamic SQL');
select ok(pg_temp.installed_code(pg_temp.rfn()) !~* 'auth\.users',
  'the installed diagnostic body never reads auth.users');

-- IT DERIVES THE SUBJECT FROM auth.uid() AND FROM NOTHING ELSE.
select ok(pg_temp.installed_code(pg_temp.rfn()) ~* 'auth\.uid\(\)',
  'the installed diagnostic body derives the subject from auth.uid()');

-- THE VOCABULARY IS CLOSED, AND IT IS EXACTLY THESE SIX WORDS. Read out of the installed body
-- rather than assumed, so a seventh word cannot appear without failing here.
select is(
  (select array_agg(distinct m[1] order by m[1])
   from regexp_matches(pg_temp.installed_code(pg_temp.rfn()),
     '''(ACTIVE|PROFILE_INACTIVE|MEMBERSHIP_INACTIVE|ORGANIZATION_INACTIVE|NO_SUPPORTED_ACCESS|AMBIGUOUS)''',
     'g') m),
  array['ACTIVE', 'AMBIGUOUS', 'MEMBERSHIP_INACTIVE', 'NO_SUPPORTED_ACCESS',
        'ORGANIZATION_INACTIVE', 'PROFILE_INACTIVE'],
  'the installed diagnostic body uses exactly the six declared access_state words');

-- THE THREE SUPPORTED RETAILER ROLES ARE NAMED, and nothing else is.
select ok(pg_temp.installed_code(pg_temp.rfn()) like '%RETAILER_OWNER%'
      and pg_temp.installed_code(pg_temp.rfn()) like '%RETAILER_MANAGER%'
      and pg_temp.installed_code(pg_temp.rfn()) like '%SALES_STAFF%',
  'the diagnostic interprets exactly the three supported Retailer roles');
select ok(pg_temp.installed_code(pg_temp.rfn()) not like '%VENDOR_SUPER_ADMIN%',
  'the diagnostic does not interpret the Vendor role — a Vendor-only user has NO_SUPPORTED_ACCESS');


-- ============================================================================
-- SECTION C — nothing else moved
-- ============================================================================
-- The migration added two functions. Everything it did NOT add is asserted here, because a
-- widened table posture or an edited read contract would be invisible to every behavioural
-- test below.

-- organization_members keeps its installed posture: RLS on, SELECT-only for the browser,
-- and NO insert/update/delete privilege of any kind.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.organization_members'::regclass),
  'organization_members still has RLS enabled');

select is(
  (select coalesce(array_agg(distinct g.privilege_type::text order by g.privilege_type::text), '{}'::text[])
   from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.table_name = 'organization_members'
     and g.grantee in ('anon', 'authenticated', 'PUBLIC')),
  array['SELECT'],
  'the only browser privilege on organization_members is still SELECT — no INSERT, UPDATE or DELETE was added');

-- NO NEW RLS POLICY. The count is pinned rather than the contents, so an added write policy
-- fails here even if it were named like a read one.
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename = 'organization_members'),
  1::bigint,
  'organization_members still has exactly its ONE installed read policy — no browser-write policy was added');

select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename = 'organization_members' and cmd <> 'SELECT'),
  0::bigint,
  'and no policy on organization_members permits anything but SELECT');

-- The preserved tables keep their posture too.
select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'retailer_shop_members'
     and grantee in ('anon', 'authenticated', 'PUBLIC')),
  0::bigint,
  'no browser role holds any privilege on retailer_shop_members');

select is(
  (select coalesce(array_agg(distinct g.privilege_type::text order by g.privilege_type::text), '{}'::text[])
   from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.table_name = 'member_roles'
     and g.grantee in ('anon', 'authenticated', 'PUBLIC')),
  array['SELECT'],
  'member_roles is still SELECT-only for the browser');

-- NO COLUMN WAS ADDED. The lifecycle is written into columns that already existed.
select has_column('public', 'organization_members', 'deactivated_at',
  'organization_members.deactivated_at already existed — no column was added');
select has_column('public', 'organization_members', 'status',
  'organization_members.status already existed');

-- get_my_portal_context() IS UNCHANGED — same zero-argument signature, same jsonb return,
-- same STABLE/SECURITY DEFINER posture, and still context_version 1. This milestone was
-- required to leave portal routing exactly as it found it.
select has_function('public', 'get_my_portal_context', '{}'::text[],
  'get_my_portal_context() still exists with zero arguments');
select is(
  (select format_type(p.prorettype, null) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_my_portal_context'),
  'jsonb', 'get_my_portal_context() still returns jsonb — its contract is untouched');
select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_my_portal_context'),
  's', 'get_my_portal_context() is still STABLE');
select ok(
  pg_temp.installed_code('get_my_portal_context') ~ '''context_version'',\s*1',
  'get_my_portal_context() still declares context_version 1 — no client contract version moved');

-- AND THE TWO ARE SEPARATE FUNCTIONS. The diagnostic is not reachable through the portal
-- context, and the portal context did not grow a lifecycle field.
select ok(
  pg_temp.installed_code('get_my_portal_context') !~* 'get_my_lifecycle_access_state|access_state',
  'get_my_portal_context() does not call or embed the lifecycle diagnostic — they stay separate');
select ok(
  pg_temp.installed_code(pg_temp.rfn()) !~* 'get_my_portal_context',
  'and the diagnostic does not call the portal context either');

-- The shipped staff roster contract is untouched, so the membership_id a client already has
-- is still the id this write accepts.
select is(pg_temp.out_args('list_retailer_staff_members'),
  array['membership_id', 'first_name', 'last_name', 'role_code', 'role_name',
        'membership_status', 'shop_ids', 'shop_names', 'joined_at', 'created_at'],
  'list_retailer_staff_members contract is unchanged');


-- ============================================================================
-- Fixture
-- ============================================================================
-- THREE Retailers plus a Vendor, so every tenant-isolation claim below is about a membership
-- that genuinely belongs to someone else rather than about an id that names nothing.
--
--   Retailer One    ACTIVE    — the tenant under test
--   Retailer Two    ACTIVE    — a complete, separate tenant
--   Retailer Three  SUSPENDED — the inactive-organization case
--
-- EACH BEHAVIOURAL SECTION GETS ITS OWN STAFF MEMBER. Sharing one would make a failure in an
-- early section cascade into every later one, and would make "this row was never touched"
-- unprovable.

insert into pg_temp.fx (k, v) values
  ('owner_1',      pg_temp.new_person('Ola',   'Owner')),
  ('owner_1b',     pg_temp.new_person('Omar',  'Second')),
  ('mgr_caller',   pg_temp.new_person('Mia',   'Mgrcaller')),
  ('staff_caller', pg_temp.new_person('Sam',   'Stfcaller')),
  ('vendor_admin', pg_temp.new_person('Ada',   'Admin')),
  ('owner_2',      pg_temp.new_person('Otto',  'Foreign')),
  ('owner_3',      pg_temp.new_person('Ivan',  'Inactive')),
  -- One target per behavioural section.
  ('u_mgr',        pg_temp.new_person('Mo',    'Manager')),
  ('u_sales',      pg_temp.new_person('Sara',  'Sales')),
  ('u_idem',       pg_temp.new_person('Ida',   'Idem')),
  ('u_multi',      pg_temp.new_person('Max',   'Multi')),
  ('u_roleless',   pg_temp.new_person('Rob',   'Roleless')),
  ('u_invited',    pg_temp.new_person('Iris',  'Invited')),
  ('u_susp',       pg_temp.new_person('Fred',  'Frozen')),
  ('u_preserve',   pg_temp.new_person('Pia',   'Preserve')),
  ('u_receipt',    pg_temp.new_person('Rita',  'Receipt')),
  ('u_audit',      pg_temp.new_person('Amy',   'Audited')),
  ('u_roll',       pg_temp.new_person('Rex',   'Rollback')),
  ('u_guard',      pg_temp.new_person('Gus',   'Guard')),
  ('u_mgr2',       pg_temp.new_person('Nina',  'Mgrtwo')),
  ('u_foreign',    pg_temp.new_person('Fay',   'Faraway')),
  ('u_r3',         pg_temp.new_person('Rick',  'Third')),
  -- Section P subjects.
  ('p_inactive',   pg_temp.new_person('Pat',   'Inactiveprofile', 'DEACTIVATED')),
  ('p_ambig',      pg_temp.new_person('Ann',   'Ambiguous')),
  ('p_r3both',     pg_temp.new_person('Bea',   'Bothinactive'));

-- An auth.users row with NO profile at all — never provisioned, not deactivated.
insert into pg_temp.fx (k, v) values ('p_shell', pg_temp.new_shell('shell@test.invalid'));

insert into pg_temp.fx (k, v) values
  ('r1',     pg_temp.new_org('Retailer One')),
  ('r2',     pg_temp.new_org('Retailer Two')),
  ('r3',     pg_temp.new_org('Retailer Three')),
  ('vendor', pg_temp.new_org('The Vendor', 'VENDOR'));

insert into pg_temp.fx (k, v) values
  -- Retailer One.
  ('m_owner_1',   pg_temp.staff(pg_temp.fx('owner_1'),      pg_temp.fx('r1'), 'RETAILER_OWNER')),
  ('m_owner_1b',  pg_temp.staff(pg_temp.fx('owner_1b'),     pg_temp.fx('r1'), 'RETAILER_OWNER')),
  ('m_mgrcall',   pg_temp.staff(pg_temp.fx('mgr_caller'),   pg_temp.fx('r1'), 'RETAILER_MANAGER')),
  ('m_stfcall',   pg_temp.staff(pg_temp.fx('staff_caller'), pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_mgr',       pg_temp.staff(pg_temp.fx('u_mgr'),        pg_temp.fx('r1'), 'RETAILER_MANAGER')),
  ('m_mgr2',      pg_temp.staff(pg_temp.fx('u_mgr2'),       pg_temp.fx('r1'), 'RETAILER_MANAGER')),
  ('m_sales',     pg_temp.staff(pg_temp.fx('u_sales'),      pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_idem',      pg_temp.staff(pg_temp.fx('u_idem'),       pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_multi',     pg_temp.staff(pg_temp.fx('u_multi'),      pg_temp.fx('r1'), 'SALES_STAFF')),
  -- A membership with NO role at all — a half-built or partially-revoked state.
  ('m_roleless',  pg_temp.staff(pg_temp.fx('u_roleless'),   pg_temp.fx('r1'), null)),
  ('m_invited',   pg_temp.staff(pg_temp.fx('u_invited'),    pg_temp.fx('r1'), 'SALES_STAFF', 'INVITED')),
  ('m_susp',      pg_temp.staff(pg_temp.fx('u_susp'),       pg_temp.fx('r1'), 'SALES_STAFF', 'SUSPENDED')),
  ('m_preserve',  pg_temp.staff(pg_temp.fx('u_preserve'),   pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_receipt',   pg_temp.staff(pg_temp.fx('u_receipt'),    pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_audit',     pg_temp.staff(pg_temp.fx('u_audit'),      pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_roll',      pg_temp.staff(pg_temp.fx('u_roll'),       pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_guard',     pg_temp.staff(pg_temp.fx('u_guard'),      pg_temp.fx('r1'), 'SALES_STAFF')),
  ('m_ambig1',    pg_temp.staff(pg_temp.fx('p_ambig'),      pg_temp.fx('r1'), 'SALES_STAFF')),
  -- Retailer Two.
  ('m_owner_2',   pg_temp.staff(pg_temp.fx('owner_2'),      pg_temp.fx('r2'), 'RETAILER_OWNER')),
  ('m_foreign',   pg_temp.staff(pg_temp.fx('u_foreign'),    pg_temp.fx('r2'), 'SALES_STAFF')),
  ('m_ambig2',    pg_temp.staff(pg_temp.fx('p_ambig'),      pg_temp.fx('r2'), 'SALES_STAFF')),
  ('m_pinact',    pg_temp.staff(pg_temp.fx('p_inactive'),   pg_temp.fx('r2'), 'SALES_STAFF')),
  -- Retailer Three, suspended below after its rows exist.
  ('m_owner_3',   pg_temp.staff(pg_temp.fx('owner_3'),      pg_temp.fx('r3'), 'RETAILER_OWNER')),
  ('m_r3',        pg_temp.staff(pg_temp.fx('u_r3'),         pg_temp.fx('r3'), 'SALES_STAFF')),
  -- The precedence subject: inactive membership AND inactive organization.
  ('m_r3both',    pg_temp.staff(pg_temp.fx('p_r3both'),     pg_temp.fx('r3'), 'SALES_STAFF', 'DEACTIVATED')),
  -- A Vendor Super Admin, who must be refused by the Retailer-only resolver.
  ('m_vendor',    pg_temp.staff(pg_temp.fx('vendor_admin'), pg_temp.fx('vendor'), 'VENDOR_SUPER_ADMIN'));

-- The multi-role target: SALES_STAFF *and* RETAILER_MANAGER at once.
select pg_temp.add_role(pg_temp.fx('m_multi'), 'RETAILER_MANAGER');

insert into pg_temp.fx (k, v) values
  ('alpha',  pg_temp.new_shop(pg_temp.fx('r1'), 'Alpha Shop')),
  ('bravo',  pg_temp.new_shop(pg_temp.fx('r1'), 'Bravo Shop')),
  ('sierra', pg_temp.new_shop(pg_temp.fx('r1'), 'Sierra Shop', 'SUSPENDED'));

-- A stable id that names nothing at all, for the "unknown" cases.
insert into pg_temp.fx (k, v) values ('nowhere', '00000000-0000-4000-8000-000000000000'::uuid);

-- Retailer Three is suspended only now, so its members and roles could be created first.
update public.organizations set status = 'SUSPENDED' where id = pg_temp.fx('r3');

-- The preservation fixture: one LIVE assignment, one RETIRED assignment, and a live
-- assignment to a SUSPENDED shop (invisible to every roster, and therefore the one most
-- easily destroyed by a careless edit).
select pg_temp.raw_assign(pg_temp.fx('m_preserve'), pg_temp.fx('alpha'),  pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_preserve'), pg_temp.fx('sierra'), pg_temp.fx('owner_1'));
select pg_temp.raw_assign(pg_temp.fx('m_preserve'), pg_temp.fx('bravo'),  pg_temp.fx('owner_1'), true);

-- The receipt-eligibility fixture.
select pg_temp.raw_assign(pg_temp.fx('m_receipt'), pg_temp.fx('alpha'), pg_temp.fx('owner_1'));

-- A receipt already submitted by the preservation subject — history that must survive.
insert into public.receipt_submissions (
  retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
  storage_bucket, storage_object_path, original_file_name, mime_type,
  file_size_bytes, file_sha256, status, submitted_at
)
values (
  pg_temp.fx('r1'), pg_temp.fx('alpha'), pg_temp.fx('u_preserve'),
  'receipts', 'seed/preserve/receipt.jpg', 'receipt.jpg', 'image/jpeg',
  1024, repeat('a', 64), 'SUBMITTED', now()
);

-- An ACCEPTED invitation pointing at the preservation subject's membership — history that
-- must survive. Both acceptance references are set, as the acceptance-references trigger
-- requires of an ACCEPTED row.
insert into public.retailer_staff_invitations (
  retailer_organization_id, email, first_name, last_name, role_id,
  status, auth_user_id, organization_member_id, invited_by_profile_id, accepted_at
)
select
  pg_temp.fx('r1'), 'pia.preserve@test.invalid', 'Pia', 'Preserve', r.id,
  'ACCEPTED', pg_temp.fx('u_preserve'), pg_temp.fx('m_preserve'), pg_temp.fx('owner_1'), now()
from public.roles r where r.code = 'SALES_STAFF';

-- Sanity: the fixture is what the sections below assume.
select is(pg_temp.role_codes(pg_temp.fx('m_multi')),
  array['RETAILER_MANAGER', 'SALES_STAFF'],
  'fixture: the multi-role target really holds TWO active roles');
select is(pg_temp.role_codes(pg_temp.fx('m_roleless')), '{}'::text[],
  'fixture: the role-less target really holds none');
select is(pg_temp.invitation_count(pg_temp.fx('m_preserve')), 1::bigint,
  'fixture: the preservation subject has one accepted invitation on record');
select is(pg_temp.receipt_count(pg_temp.fx('u_preserve')), 1::bigint,
  'fixture: and one submitted receipt');


-- ============================================================================
-- SECTION D — the permission is RETAILER_STAFF_MANAGE, and it alone
-- ============================================================================
-- The seeded mapping is REMOVED rather than assumed present. Asserting "an Owner can
-- deactivate" proves only that the caller holds SOMETHING; removing exactly one mapping and
-- watching exactly one capability disappear is what proves WHICH permission is the gate. The
-- transaction is rolled back, so the seeds are untouched on disk.

select is(
  (select array_agg(r.code::text order by r.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RETAILER_STAFF_MANAGE'),
  array['RETAILER_OWNER'],
  'RETAILER_STAFF_MANAGE is mapped to RETAILER_OWNER and to no other role');

create temp table saved_perms as
  select rp.role_id, rp.permission_id, p.code
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  join public.roles r on r.id = rp.role_id
  where r.code = 'RETAILER_OWNER'
    and p.code in ('RETAILER_STAFF_MANAGE', 'RETAILER_STAFF_SHOP_ASSIGN');

select pg_temp.act_as(pg_temp.fx('owner_1'));

-- Remove ONLY RETAILER_STAFF_MANAGE. SHOP_ASSIGN stays.
delete from public.role_permissions rp
using public.permissions p, public.roles r
where rp.permission_id = p.id and rp.role_id = r.id
  and r.code = 'RETAILER_OWNER' and p.code = 'RETAILER_STAFF_MANAGE';

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), 'DEACTIVATED')),
  '42501',
  'without RETAILER_STAFF_MANAGE, the status write is refused');
select is(pg_temp.member_status(pg_temp.fx('m_guard')), 'ACTIVE',
  'and the refused write changed nothing');

-- RETAILER_STAFF_SHOP_ASSIGN ALONE DOES NOT GRANT THE LIFECYCLE WRITE. The caller still holds
-- it, and the operation IT gates still works — which is what makes "the two permissions are
-- distinct" a fact rather than a claim.
select is(
  pg_temp.sqlstate_of(format(
    'select * from public.set_retailer_staff_shop_assignments(%L::uuid, %L::uuid[])',
    pg_temp.fx('m_receipt'), array[pg_temp.fx('alpha')])),
  null,
  'RETAILER_STAFF_SHOP_ASSIGN is unaffected — the Shop assignment write still works');

insert into public.role_permissions (role_id, permission_id)
select role_id, permission_id from saved_perms where code = 'RETAILER_STAFF_MANAGE';

-- The converse: remove SHOP_ASSIGN and keep MANAGE. The lifecycle write must still work,
-- because it is NOT gated on SHOP_ASSIGN. A client that assumed one staff permission covered
-- everything would break exactly here.
delete from public.role_permissions rp
using public.permissions p, public.roles r
where rp.permission_id = p.id and rp.role_id = r.id
  and r.code = 'RETAILER_OWNER' and p.code = 'RETAILER_STAFF_SHOP_ASSIGN';

select is(
  pg_temp.set_status(pg_temp.fx('m_guard'), 'DEACTIVATED'),
  array[pg_temp.fx('m_guard')::text, 'DEACTIVATED', 'SALES_STAFF', 'true'],
  'RETAILER_STAFF_MANAGE alone is sufficient — RETAILER_STAFF_SHOP_ASSIGN is not required');

insert into public.role_permissions (role_id, permission_id)
select role_id, permission_id from saved_perms where code = 'RETAILER_STAFF_SHOP_ASSIGN';

-- Put the guard member back, so later sections start from a known state.
select pg_temp.set_status(pg_temp.fx('m_guard'), 'ACTIVE');
select is(pg_temp.member_status(pg_temp.fx('m_guard')), 'ACTIVE',
  'the guard member is ACTIVE again for the sections that follow');


-- ============================================================================
-- SECTION E — caller authorization
-- ============================================================================
-- Every refusal below is 42501, and every one leaves the row untouched.

select pg_temp.sign_out();
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_sales'), 'DEACTIVATED')),
  '42501', 'a signed-out caller cannot change a membership status');

select pg_temp.act_as(pg_temp.fx('mgr_caller'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_sales'), 'DEACTIVATED')),
  '42501', 'a Retailer Manager cannot change a membership status — read-only by mapping');

select pg_temp.act_as(pg_temp.fx('staff_caller'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_sales'), 'DEACTIVATED')),
  '42501', 'a Sales Staff member cannot change a membership status');

select pg_temp.act_as(pg_temp.fx('vendor_admin'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_sales'), 'DEACTIVATED')),
  '42501', 'a Vendor Super Admin cannot use the Retailer staff lifecycle write');

-- The Owner of a SUSPENDED Retailer is refused with 42501 from the RESOLVER, not 55000: the
-- resolver requires an ACTIVE organization and fires long before the 55000 re-check. Stated
-- explicitly because the naive expectation is the opposite one. See Section K.
select pg_temp.act_as(pg_temp.fx('owner_3'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_r3'), 'DEACTIVATED')),
  '42501',
  'the Owner of a SUSPENDED Retailer is refused — and with 42501 from the resolver, not 55000');

-- A caller who owns TWO Retailers resolves to NEITHER. The resolver fails closed on more than
-- one qualifying organization, so an Owner of two Retailers cannot act on either until an
-- organization switcher exists. Asserted because it is the one authorization outcome that
-- depends on the caller having MORE access, not less.
select pg_temp.staff(pg_temp.fx('owner_1b'), pg_temp.fx('r2'), 'RETAILER_OWNER');
select pg_temp.act_as(pg_temp.fx('owner_1b'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_sales'), 'DEACTIVATED')),
  '42501',
  'a caller who owns TWO Retailers resolves to neither and is refused — fail closed');

select is(pg_temp.member_status(pg_temp.fx('m_sales')), 'ACTIVE',
  'none of those refusals changed the target');
select is(pg_temp.audit_count(pg_temp.fx('m_sales')), 0::bigint,
  'and none of them wrote an audit row');


-- ============================================================================
-- SECTION F — target validation
-- ============================================================================
-- Every refusal here is the SAME 42501 with the SAME message, which is what stops a caller
-- sweeping membership ids to learn which ones exist somewhere else.

select pg_temp.act_as(pg_temp.fx('owner_1'));

-- F1. Null and unknown.
select is(
  pg_temp.sqlstate_of(
    'select * from public.set_retailer_staff_membership_status(null::uuid, ''DEACTIVATED'')'),
  '42501', 'a NULL membership id is refused');
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('nowhere'), 'DEACTIVATED')),
  '42501', 'an unknown membership id is refused');

-- F2. Cross-tenant. This membership genuinely exists — it just belongs to Retailer Two.
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_foreign'), 'DEACTIVATED')),
  '42501', 'another Retailer''s membership is refused');
select is(pg_temp.member_status(pg_temp.fx('m_foreign')), 'ACTIVE',
  'and the foreign membership is untouched');

-- F3. EVERY Owner target. Both the caller's own Owner membership and a SECOND Owner's, so
-- "Owners are excluded" is proved as a rule about the target's role rather than as a
-- coincidence of self-addressing.
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_owner_1b'), 'DEACTIVATED')),
  '42501', 'a DIFFERENT Retailer Owner cannot be deactivated — the headline exclusion');
select is(pg_temp.member_status(pg_temp.fx('m_owner_1b')), 'ACTIVE',
  'and that Owner is untouched');
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_owner_1'), 'DEACTIVATED')),
  '42501', 'the caller''s own Owner membership cannot be deactivated either');

-- F4. Multi-role and role-less.
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_multi'), 'DEACTIVATED')),
  '42501', 'a member holding TWO active roles is refused — the role set must be exactly one');
select is(pg_temp.role_codes(pg_temp.fx('m_multi')),
  array['RETAILER_MANAGER', 'SALES_STAFF'],
  'and the multi-role member keeps both roles');
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_roleless'), 'DEACTIVATED')),
  '42501', 'a membership with NO active role is refused');

-- F5. States this RPC does not own.
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_invited'), 'ACTIVE')),
  '42501', 'an INVITED membership cannot be promoted to ACTIVE by this RPC — acceptance is the only path');
select is(pg_temp.member_status(pg_temp.fx('m_invited')), 'INVITED',
  'and the INVITED membership is untouched');
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_invited'), 'DEACTIVATED')),
  '42501', 'nor may it be deactivated');
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_susp'), 'ACTIVE')),
  '42501', 'a SUSPENDED membership is not this RPC''s to clear');
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_susp'), 'DEACTIVATED')),
  '42501', 'nor to convert');
select is(pg_temp.member_status(pg_temp.fx('m_susp')), 'SUSPENDED',
  'and the SUSPENDED membership is untouched');

-- F6. SELF-TARGETING, PROVED IN ISOLATION.
-- Under today's mapping the caller is always an Owner, so F3 already refuses their own
-- membership — by the OWNER rule. That would leave the SELF rule untested and free to rot.
-- So RETAILER_STAFF_MANAGE is granted to RETAILER_MANAGER for the length of this block: the
-- Manager caller is then genuinely authorized, their own membership is an ELIGIBLE role
-- shape, and the ONLY thing that can refuse it is the self rule.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r, public.permissions p
where r.code = 'RETAILER_MANAGER' and p.code = 'RETAILER_STAFF_MANAGE'
on conflict do nothing;

select pg_temp.act_as(pg_temp.fx('mgr_caller'));

-- The grant really took effect: this caller can now act on somebody else.
select is(
  pg_temp.set_status(pg_temp.fx('m_mgr2'), 'DEACTIVATED'),
  array[pg_temp.fx('m_mgr2')::text, 'DEACTIVATED', 'RETAILER_MANAGER', 'true'],
  'self: with the temporary mapping the Manager caller IS authorized — they can deactivate a peer');

-- ...and still cannot address themselves.
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_mgrcall'), 'DEACTIVATED')),
  '42501',
  'self: a caller may NOT deactivate their own membership, even when their role shape is eligible');
select is(pg_temp.member_status(pg_temp.fx('m_mgrcall')), 'ACTIVE',
  'self: and their own membership is untouched');
select is(pg_temp.audit_count(pg_temp.fx('m_mgrcall')), 0::bigint,
  'self: with no audit row written');

-- Restore the peer and remove the temporary mapping.
select pg_temp.set_status(pg_temp.fx('m_mgr2'), 'ACTIVE');
delete from public.role_permissions rp
using public.permissions p, public.roles r
where rp.permission_id = p.id and rp.role_id = r.id
  and r.code = 'RETAILER_MANAGER' and p.code = 'RETAILER_STAFF_MANAGE';

select pg_temp.act_as(pg_temp.fx('mgr_caller'));
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_sales'), 'DEACTIVATED')),
  '42501', 'self: the temporary mapping is gone — the Manager is read-only again');

-- F7. EVERY DISCLOSURE-SENSITIVE REFUSAL IS BYTE-IDENTICAL.
-- Same SQLSTATE and same message for: unknown, cross-tenant, Owner, multi-role, role-less,
-- INVITED and SUSPENDED. If any one of these were distinguishable, a caller could use it to
-- learn which membership ids exist, and in what shape, inside a Retailer they cannot read.
select pg_temp.act_as(pg_temp.fx('owner_1'));

select is(
  (select count(distinct s)
   from unnest(array[
     pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('nowhere'),    'DEACTIVATED')),
     pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_foreign'),  'DEACTIVATED')),
     pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_owner_1b'), 'DEACTIVATED')),
     pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_multi'),    'DEACTIVATED')),
     pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_roleless'), 'DEACTIVATED')),
     pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_invited'),  'DEACTIVATED')),
     pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_susp'),     'DEACTIVATED'))
   ]) s),
  1::bigint,
  'disclosure: all seven target refusals share ONE SQLSTATE');

select is(
  (select count(distinct m)
   from unnest(array[
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('nowhere'),    'DEACTIVATED')),
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_foreign'),  'DEACTIVATED')),
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_owner_1b'), 'DEACTIVATED')),
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_multi'),    'DEACTIVATED')),
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_roleless'), 'DEACTIVATED')),
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_invited'),  'DEACTIVATED')),
     pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_susp'),     'DEACTIVATED'))
   ]) m),
  1::bigint,
  'disclosure: and ONE message — an unknown id is indistinguishable from another Retailer''s Owner');

-- The message names nothing. A refusal that echoed the id back would be a disclosure of its
-- own, and one that named the role would tell the caller what they were not allowed to know.
select ok(
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('m_foreign'), 'DEACTIVATED'))
    !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@|OWNER|MANAGER|SALES|Retailer Two',
  'disclosure: the refusal message contains no uuid, email, role code or organization name');


-- ============================================================================
-- SECTION G — the happy paths
-- ============================================================================

select pg_temp.act_as(pg_temp.fx('owner_1'));

-- G1. A RETAILER_MANAGER, down and back up.
select is(pg_temp.member_status(pg_temp.fx('m_mgr')), 'ACTIVE',
  'mgr: starts ACTIVE');
select ok(pg_temp.deactivated_at_of(pg_temp.fx('m_mgr')) is null,
  'mgr: with a null deactivated_at');

select is(
  pg_temp.set_status(pg_temp.fx('m_mgr'), 'DEACTIVATED'),
  array[pg_temp.fx('m_mgr')::text, 'DEACTIVATED', 'RETAILER_MANAGER', 'true'],
  'mgr: the Owner deactivates a Retailer Manager — returns the id, the new status, the proved role, and status_changed = true');
select is(pg_temp.member_status(pg_temp.fx('m_mgr')), 'DEACTIVATED',
  'mgr: the row now reads DEACTIVATED');
select is(pg_temp.deactivated_at_of(pg_temp.fx('m_mgr')), now(),
  'mgr: and deactivated_at was SET to the transaction timestamp');

select is(
  pg_temp.set_status(pg_temp.fx('m_mgr'), 'ACTIVE'),
  array[pg_temp.fx('m_mgr')::text, 'ACTIVE', 'RETAILER_MANAGER', 'true'],
  'mgr: the Owner reactivates the Retailer Manager');
select is(pg_temp.member_status(pg_temp.fx('m_mgr')), 'ACTIVE',
  'mgr: the row reads ACTIVE again');
select ok(pg_temp.deactivated_at_of(pg_temp.fx('m_mgr')) is null,
  'mgr: and deactivated_at was CLEARED — the pair can never disagree');

-- G2. A SALES_STAFF member, down and back up.
select is(
  pg_temp.set_status(pg_temp.fx('m_sales'), 'DEACTIVATED'),
  array[pg_temp.fx('m_sales')::text, 'DEACTIVATED', 'SALES_STAFF', 'true'],
  'sales: the Owner deactivates a Sales Staff member');
select is(pg_temp.member_status(pg_temp.fx('m_sales')), 'DEACTIVATED',
  'sales: the row now reads DEACTIVATED');
select is(pg_temp.deactivated_at_of(pg_temp.fx('m_sales')), now(),
  'sales: deactivated_at was set');

select is(
  pg_temp.set_status(pg_temp.fx('m_sales'), 'ACTIVE'),
  array[pg_temp.fx('m_sales')::text, 'ACTIVE', 'SALES_STAFF', 'true'],
  'sales: the Owner reactivates the Sales Staff member');
select ok(pg_temp.deactivated_at_of(pg_temp.fx('m_sales')) is null,
  'sales: deactivated_at was cleared');

-- G3. THE ROLE CODE RETURNED IS THE ONE THE FUNCTION PROVED, never one it was handed —
-- there is no argument that could have supplied it.
select is(
  (pg_temp.set_status(pg_temp.fx('m_mgr'), 'DEACTIVATED'))[3],
  'RETAILER_MANAGER',
  'the returned role_code is derived from the target''s own ACTIVE role set');
select pg_temp.set_status(pg_temp.fx('m_mgr'), 'ACTIVE');


-- ============================================================================
-- SECTION H — idempotency
-- ============================================================================
-- The idempotent path must write NOTHING: no row version change, no moved deactivated_at, no
-- audit row. Re-running the UPDATE "harmlessly" would silently advance deactivated_at and
-- destroy exactly the fact that column exists to hold.

select is(pg_temp.member_status(pg_temp.fx('m_idem')), 'ACTIVE',
  'idem: starts ACTIVE');

-- H1. Idempotent REACTIVATE — already ACTIVE.
create temp table idem_active_before as
  select pg_temp.member_version(pg_temp.fx('m_idem')) as v;

select is(
  pg_temp.set_status(pg_temp.fx('m_idem'), 'ACTIVE'),
  array[pg_temp.fx('m_idem')::text, 'ACTIVE', 'SALES_STAFF', 'false'],
  'idem: reactivating an ACTIVE membership reports status_changed = false');
select is(pg_temp.member_version(pg_temp.fx('m_idem')),
  (select v from idem_active_before),
  'idem: and the physical row was NOT touched');
select is(pg_temp.audit_count(pg_temp.fx('m_idem')), 0::bigint,
  'idem: and no audit row was written');

-- H2. A real deactivation, so H3 has something to repeat.
select is(
  (pg_temp.set_status(pg_temp.fx('m_idem'), 'DEACTIVATED'))[4], 'true',
  'idem: the first deactivation IS a change');
select is(pg_temp.audit_count(pg_temp.fx('m_idem')), 1::bigint,
  'idem: and writes exactly one audit row');

-- H3. Idempotent DEACTIVATE — already DEACTIVATED.
create temp table idem_deact_before as
  select pg_temp.member_version(pg_temp.fx('m_idem')) as v,
         pg_temp.deactivated_at_of(pg_temp.fx('m_idem')) as d;

select is(
  pg_temp.set_status(pg_temp.fx('m_idem'), 'DEACTIVATED'),
  array[pg_temp.fx('m_idem')::text, 'DEACTIVATED', 'SALES_STAFF', 'false'],
  'idem: deactivating a DEACTIVATED membership reports status_changed = false');
select is(pg_temp.member_version(pg_temp.fx('m_idem')),
  (select v from idem_deact_before),
  'idem: the physical row was NOT touched');
select is(pg_temp.deactivated_at_of(pg_temp.fx('m_idem')),
  (select d from idem_deact_before),
  'idem: deactivated_at kept its ORIGINAL value — a double-tap does not move it');
select is(pg_temp.audit_count(pg_temp.fx('m_idem')), 1::bigint,
  'idem: and NO second audit row was written — a no-op is not an event');

-- H4. A THIRD call, this time a real change, still works. The no-op path did not leave the
-- membership in a state the function cannot act on.
select is(
  (pg_temp.set_status(pg_temp.fx('m_idem'), 'ACTIVE'))[4], 'true',
  'idem: a subsequent real change is still applied');
select is(pg_temp.audit_count(pg_temp.fx('m_idem')), 2::bigint,
  'idem: and writes its own audit row — exactly two changes, exactly two rows');


-- ============================================================================
-- SECTION I — audit
-- ============================================================================

select is(pg_temp.audit_count(pg_temp.fx('m_audit')), 0::bigint,
  'audit: no audit row exists before the write');

-- I1. DEACTIVATION.
select pg_temp.set_status(pg_temp.fx('m_audit'), 'DEACTIVATED');

select is(pg_temp.audit_count(pg_temp.fx('m_audit')), 1::bigint,
  'audit: EXACTLY ONE audit row was written');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).action, 'STAFF_MEMBERSHIP_DEACTIVATED',
  'audit: the deactivation action code is STAFF_MEMBERSHIP_DEACTIVATED');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).entity_type, 'RETAILER_STAFF_MEMBER',
  'audit: the entity type is RETAILER_STAFF_MEMBER');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).entity_id, pg_temp.fx('m_audit')::text,
  'audit: the entity id is the target MEMBERSHIP id');

-- organization_id is the RETAILER's, which is what keeps this entry out of
-- list_vendor_audit_logs — that function filters on the caller's own Vendor organization.
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).organization_id, pg_temp.fx('r1'),
  'audit: organization_id is the Retailer''s — invisible to every Vendor audit reader');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).actor_profile_id, pg_temp.fx('owner_1'),
  'audit: actor_profile_id is the acting Owner, taken from auth.uid()');

select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata ->> 'role_code', 'SALES_STAFF',
  'audit: the role code recorded is the one the function PROVED');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata ->> 'membership_status_before', 'ACTIVE',
  'audit: the before status is the one read under lock');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata ->> 'membership_status_after', 'DEACTIVATED',
  'audit: and the after status is the validated request');

-- THE EXACT KEY SET, so a later edit cannot quietly add a field.
select is(
  (select array_agg(k order by k)
   from jsonb_object_keys((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata) k),
  array['membership_status_after', 'membership_status_before', 'role_code'],
  'audit: the metadata carries exactly three keys and no others');

-- NOTHING UNSAFE IS IN THE METADATA. No uuid of any kind — not a profile id, not an Auth id,
-- not a Shop id, not an invitation or receipt id — and no email, token, hash or provider
-- message. The membership id lives in entity_id, which the reader already has authority over.
select ok(
  (pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata::text
    !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  'audit: the metadata contains NO uuid of any kind');
select ok(
  (pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata::text
    !~* 'email|token|hash|secret|password|@|shop|invitation|receipt',
  'audit: the metadata contains no email, token, hash, Shop, invitation or receipt reference');

-- ip_address and user_agent are left null: this function cannot observe them truthfully.
select ok((pg_temp.last_audit(pg_temp.fx('m_audit'))).ip_address is null,
  'audit: ip_address is null — the function cannot observe it truthfully');
select ok((pg_temp.last_audit(pg_temp.fx('m_audit'))).user_agent is null,
  'audit: user_agent is null');

-- I2. REACTIVATION writes the OTHER action, with the before/after reversed.
select pg_temp.set_status(pg_temp.fx('m_audit'), 'ACTIVE');

select is(pg_temp.audit_count(pg_temp.fx('m_audit')), 2::bigint,
  'audit: the reactivation writes a second audit row');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).action, 'STAFF_MEMBERSHIP_REACTIVATED',
  'audit: the reactivation action code is STAFF_MEMBERSHIP_REACTIVATED');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata ->> 'membership_status_before', 'DEACTIVATED',
  'audit: its before status is DEACTIVATED');
select is((pg_temp.last_audit(pg_temp.fx('m_audit'))).metadata ->> 'membership_status_after', 'ACTIVE',
  'audit: and its after status is ACTIVE');

-- I3. The two actions are DISTINCT, so a reader can tell direction without diffing metadata.
select is(
  (select count(distinct a.action) from public.audit_logs a
   where a.entity_type = 'RETAILER_STAFF_MEMBER' and a.entity_id = pg_temp.fx('m_audit')::text),
  2::bigint,
  'audit: deactivation and reactivation are two DIFFERENT action codes');


-- ============================================================================
-- SECTION J — the requested status is a closed vocabulary (23514)
-- ============================================================================
-- A distinct SQLSTATE from the 42501 family, deliberately: a bad status is the caller's own
-- malformed input and discloses nothing about anyone else, so telling them apart is safe and
-- useful. Every value below leaves the row untouched.

select pg_temp.act_as(pg_temp.fx('owner_1'));

select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), 'active')),
  '23514', 'a lowercase ''active'' is refused — the comparison is exact and case-sensitive');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), 'deactivated')),
  '23514', 'a lowercase ''deactivated'' is refused');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), '')),
  '23514', 'an empty status is refused');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), ' ACTIVE')),
  '23514', 'a padded status is refused rather than trimmed');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), 'INVITED')),
  '23514', 'INVITED is refused — a member becomes ACTIVE by ACCEPTING, never by this RPC');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), 'SUSPENDED')),
  '23514', 'SUSPENDED is refused — this milestone defines no owner for it');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), 'ARCHIVED')),
  '23514', 'an invented status is refused');
select is(
  pg_temp.sqlstate_of(format(
    'select * from public.set_retailer_staff_membership_status(%L::uuid, null::text)',
    pg_temp.fx('m_guard'))),
  '23514', 'a NULL status is refused');

select is(pg_temp.member_status(pg_temp.fx('m_guard')), 'ACTIVE',
  'and every rejected status left the membership exactly as it was');
select is(pg_temp.audit_count(pg_temp.fx('m_guard')), 2::bigint,
  'with no audit row beyond Section D''s two real changes');

-- 23514 IS RAISED ONLY AFTER AUTHORIZATION. A stranger with a bad status is refused as a
-- stranger (42501), not told that their status was the problem — otherwise the input check
-- would be an oracle for "this endpoint exists and I got past the door".
select pg_temp.sign_out();
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), 'nonsense')),
  '42501',
  'a signed-out caller with an invalid status is refused as UNAUTHORIZED, not as invalid input');
select pg_temp.act_as(pg_temp.fx('staff_caller'));
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), 'nonsense')),
  '42501',
  'and so is an authenticated but unauthorized one — authorization is checked first');


-- ============================================================================
-- SECTION K — the acting Retailer's lifecycle (55000)
-- ============================================================================
-- HONEST LIMITATION, STATED RATHER THAN PAPERED OVER.
--
-- The 55000 branch fires when the acting Retailer is not ACTIVE AT THE MOMENT ITS LIFECYCLE
-- ROW IS LOCKED. It is DEFENCE IN DEPTH and is UNREACHABLE from a single transaction, because
-- resolve_retailer_member_organization already requires an ACTIVE organization and both reads
-- see the same snapshot: an organization that is inactive when the lock is taken was inactive
-- when the resolver ran, so the resolver returned NULL and the caller was refused with 42501
-- long before. Section E asserts exactly that, and it is the outcome a client will actually
-- observe today.
--
-- 55000 therefore becomes reachable only when a Vendor-side Retailer lifecycle write exists
-- and suspends the organization BETWEEN the resolver's read and this function's lock. That
-- write is a LATER MILESTONE. Until it ships, this section asserts the branch STRUCTURALLY —
-- that it exists, that it is the right SQLSTATE, and that it is taken before any target is
-- resolved — and the accompanying documentation records that its behavioural coverage arrives
-- with the Vendor milestone.
--
-- The alternative — deleting the check because it cannot be exercised yet — would mean the
-- Vendor milestone silently inherits a function that writes into a suspended Retailer.

select ok(
  pg_temp.installed_code(pg_temp.wfn()) ~* 'object_not_in_prerequisite_state',
  '55000: the acting-Retailer lifecycle check exists and raises object_not_in_prerequisite_state');
-- It re-verifies the organization TYPE as well as its status. Asserted as two facts about
-- the installed body — that organization_type is read from public.organizations under the
-- lock, and that 'RETAILER' is compared against it — rather than as one brittle regex over
-- the exact variable names the body happens to use.
select ok(
  pg_temp.installed_code(pg_temp.wfn()) ~* 'organization_type'
    and pg_temp.installed_code(pg_temp.wfn()) ~* '''RETAILER''',
  '55000: it re-verifies the organization TYPE as well as its status');

-- THE ORDER IS LOAD-BEARING: the Retailer is pinned BEFORE the target membership is read, so
-- a suspended Retailer can never be used as an oracle for which membership ids live inside
-- it. Asserted by position in the installed body.
select ok(
  position('for share' in lower(pg_temp.installed_code(pg_temp.wfn())))
    < position('for update' in lower(pg_temp.installed_code(pg_temp.wfn()))),
  '55000: the Retailer lifecycle row is pinned BEFORE the target membership is locked');

-- And the 42501 the client sees TODAY for the same real-world situation is asserted
-- behaviourally in Section E ("the Owner of a SUSPENDED Retailer is refused"), so the
-- observable contract is covered even though this branch is not.


-- ============================================================================
-- SECTION L — preservation
-- ============================================================================
-- THE WHOLE POINT OF THE MILESTONE. Deactivation must destroy nothing, which is what makes
-- reactivation a one-column write rather than a rebuild — and what makes the operation safe
-- to hand to a Retailer Owner, since neither member_roles nor retailer_shop_members has any
-- restore path.

select pg_temp.act_as(pg_temp.fx('owner_1'));

create temp table preserve_before as
  select pg_temp.role_codes(pg_temp.fx('m_preserve'))          as roles,
         pg_temp.live_shop_names(pg_temp.fx('m_preserve'))     as live_shops,
         pg_temp.retired_shop_names(pg_temp.fx('m_preserve'))  as retired_shops,
         pg_temp.shop_row_count(pg_temp.fx('m_preserve'))      as shop_rows,
         pg_temp.profile_status(pg_temp.fx('u_preserve'))      as profile_status,
         pg_temp.receipt_count(pg_temp.fx('u_preserve'))       as receipts,
         pg_temp.invitation_count(pg_temp.fx('m_preserve'))    as invitations;

select is((select live_shops from preserve_before),
  array['Alpha Shop', 'Sierra Shop'],
  'preserve: the subject starts with two live assignments — one to an ACTIVE shop, one to a SUSPENDED one');
select is((select retired_shops from preserve_before), array['Bravo Shop'],
  'preserve: and one RETIRED assignment on record');

select pg_temp.set_status(pg_temp.fx('m_preserve'), 'DEACTIVATED');
select is(pg_temp.member_status(pg_temp.fx('m_preserve')), 'DEACTIVATED',
  'preserve: the membership really was deactivated');

-- L1. The membership row itself SURVIVES. Deactivation is a status change, never a delete.
select ok(
  exists (select 1 from public.organization_members m where m.id = pg_temp.fx('m_preserve')),
  'preserve: the organization_members row still exists — no row was deleted');

-- L2. Roles.
select is(pg_temp.role_codes(pg_temp.fx('m_preserve')), (select roles from preserve_before),
  'preserve: member_roles is untouched — the role assignment survives');
select is(pg_temp.role_codes(pg_temp.fx('m_preserve')), array['SALES_STAFF'],
  'preserve: and it is still exactly SALES_STAFF');

-- L3. Shop assignments — live, retired, and the invisible one.
select is(pg_temp.live_shop_names(pg_temp.fx('m_preserve')), (select live_shops from preserve_before),
  'preserve: every LIVE Shop assignment survives, including the one to a SUSPENDED shop that no roster shows');
select is(pg_temp.retired_shop_names(pg_temp.fx('m_preserve')), (select retired_shops from preserve_before),
  'preserve: and every RETIRED Shop assignment survives as history');
select is(pg_temp.shop_row_count(pg_temp.fx('m_preserve')), (select shop_rows from preserve_before),
  'preserve: the total retailer_shop_members row count is unchanged — nothing added, nothing removed');

-- L4. Profile and Auth identity.
select is(pg_temp.profile_status(pg_temp.fx('u_preserve')), (select profile_status from preserve_before),
  'preserve: profiles.status is NOT modified — a membership is not an identity');
select is(pg_temp.profile_status(pg_temp.fx('u_preserve')), 'ACTIVE',
  'preserve: the profile is still ACTIVE, so the person''s other employments are unaffected');
select ok(pg_temp.auth_user_exists(pg_temp.fx('u_preserve')),
  'preserve: the auth.users row still exists — not deleted');
select ok(
  (select u.banned_until is null from auth.users u where u.id = pg_temp.fx('u_preserve')),
  'preserve: and not banned — a deactivated person can still SIGN IN, they simply have no context');
select ok(
  (select u.deleted_at is null from auth.users u where u.id = pg_temp.fx('u_preserve')),
  'preserve: and not soft-deleted');

-- L5. Receipt and invitation history.
select is(pg_temp.receipt_count(pg_temp.fx('u_preserve')), (select receipts from preserve_before),
  'preserve: receipt history survives');
select is(pg_temp.invitation_count(pg_temp.fx('m_preserve')), (select invitations from preserve_before),
  'preserve: invitation history survives, still pointing at the same membership');
select is(
  (select i.status from public.retailer_staff_invitations i
   where i.organization_member_id = pg_temp.fx('m_preserve')),
  'ACCEPTED',
  'preserve: and the accepted invitation is still ACCEPTED');

-- L6. Audit history from BEFORE the deactivation is not disturbed either.
select is(pg_temp.audit_count(pg_temp.fx('m_preserve')), 1::bigint,
  'preserve: exactly the one new audit row — no history was rewritten');

-- L7. REACTIVATION RESTORES ACCESS WITHOUT RECREATING ANYTHING.
select pg_temp.set_status(pg_temp.fx('m_preserve'), 'ACTIVE');
select is(pg_temp.role_codes(pg_temp.fx('m_preserve')), array['SALES_STAFF'],
  'preserve: after reactivation the role is the SAME row, not a recreated one');
select is(pg_temp.live_shop_names(pg_temp.fx('m_preserve')), array['Alpha Shop', 'Sierra Shop'],
  'preserve: and the Shop assignments are the SAME rows');
select is(pg_temp.shop_row_count(pg_temp.fx('m_preserve')), (select shop_rows from preserve_before),
  'preserve: reactivation INSERTED no Shop row — restoration is automatic because nothing was removed');


-- ============================================================================
-- SECTION M — direct table access stays denied
-- ============================================================================
-- The RPC is not "the recommended way in", it is the ONLY way in. Asserted by actually
-- attempting each statement as the browser role, which is stronger than reading a grant.
--
-- The fixture table has to be readable by `authenticated` for the duration, because the
-- statements below are assembled from it AFTER the role switch. This grants access to a
-- pg_temp table of test uuids and to nothing else.
grant select on pg_temp.fx to authenticated;

set local role authenticated;

select is(
  pg_temp.sqlstate_of(format(
    'update public.organization_members set status = ''DEACTIVATED'' where id = %L::uuid',
    pg_temp.fx('m_guard'))),
  '42501', 'authenticated cannot UPDATE organization_members directly');

select is(
  pg_temp.sqlstate_of(format(
    'update public.organization_members set deactivated_at = now() where id = %L::uuid',
    pg_temp.fx('m_guard'))),
  '42501', 'authenticated cannot write deactivated_at directly either');

select is(
  pg_temp.sqlstate_of(format(
    'delete from public.organization_members where id = %L::uuid', pg_temp.fx('m_guard'))),
  '42501', 'authenticated cannot DELETE a membership');

select is(
  pg_temp.sqlstate_of(format(
    'insert into public.organization_members (organization_id, user_id, status) values (%L::uuid, %L::uuid, ''ACTIVE'')',
    pg_temp.fx('r1'), pg_temp.fx('u_guard'))),
  '42501', 'nor INSERT one');

-- The preserved tables are likewise unreachable.
select is(
  pg_temp.sqlstate_of(format(
    'delete from public.member_roles where organization_member_id = %L::uuid', pg_temp.fx('m_guard'))),
  '42501', 'authenticated cannot DELETE from member_roles');
select is(
  pg_temp.sqlstate_of('select count(*) from public.retailer_shop_members'),
  '42501', 'authenticated cannot even SELECT from retailer_shop_members');

-- And it cannot reach the internal resolver either function authorizes through.
select is(
  pg_temp.sqlstate_of(
    'select public.resolve_retailer_member_organization(''RETAILER_STAFF_MANAGE'')'),
  '42501', 'authenticated cannot call the internal authorization resolver');

reset role;

select is(pg_temp.member_status(pg_temp.fx('m_guard')), 'ACTIVE',
  'and none of those direct attempts changed a row');


-- ============================================================================
-- SECTION N — atomicity
-- ============================================================================
-- The status change and its audit row are ONE transaction, and a failure abandons both.
--
-- Every refusal the function itself raises happens BEFORE the UPDATE, so a refused call is
-- trivially atomic — asserted throughout Sections E, F and J. What THAT cannot prove is the
-- other direction: that a failure AFTER the UPDATE also rolls the UPDATE back. A temporary
-- BEFORE INSERT trigger on audit_logs supplies exactly that failure, and it is the only way
-- to reach it — the function has no post-UPDATE failure mode of its own by design.
--
-- The trigger is dropped immediately, and the whole file is rolled back regardless.

select pg_temp.act_as(pg_temp.fx('owner_1'));

select is(pg_temp.member_status(pg_temp.fx('m_roll')), 'ACTIVE',
  'roll: starts ACTIVE');

create temp table roll_before as
  select pg_temp.member_version(pg_temp.fx('m_roll')) as v;

create function pg_temp.block_audit() returns trigger
language plpgsql as $$
begin
  raise exception 'audit write blocked for the atomicity test'
    using errcode = 'raise_exception';
end;
$$;

create trigger zz_block_audit_for_test
  before insert on public.audit_logs
  for each row execute function pg_temp.block_audit();

select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_roll'), 'DEACTIVATED')),
  'P0001',
  'roll: with the audit insert blocked, the whole call fails');

drop trigger zz_block_audit_for_test on public.audit_logs;

-- THE STATUS CHANGE WENT WITH IT. This is the assertion the section exists for: the UPDATE
-- had already executed successfully when the audit insert raised, and it was still abandoned.
select is(pg_temp.member_status(pg_temp.fx('m_roll')), 'ACTIVE',
  'roll: the membership is STILL ACTIVE — the UPDATE was rolled back with the failed audit write');
select ok(pg_temp.deactivated_at_of(pg_temp.fx('m_roll')) is null,
  'roll: deactivated_at was never set');
select is(pg_temp.member_version(pg_temp.fx('m_roll')), (select v from roll_before),
  'roll: and the physical row is the original one');
select is(pg_temp.audit_count(pg_temp.fx('m_roll')), 0::bigint,
  'roll: no audit row survives either — there is no half-applied state');

-- The same call, with the trigger gone, succeeds — proving the failure was the trigger and
-- not something else about the request.
select is(
  (pg_temp.set_status(pg_temp.fx('m_roll'), 'DEACTIVATED'))[4], 'true',
  'roll: the identical call succeeds once the injected failure is removed');
select is(pg_temp.audit_count(pg_temp.fx('m_roll')), 1::bigint,
  'roll: and writes its one audit row');


-- ============================================================================
-- SECTION O — the existing session, and what it can still do
-- ============================================================================
-- THE MILESTONE'S LOAD-BEARING CLAIM: a status change takes effect on an ALREADY-ISSUED
-- session through the existing protected-request checks, with no sign-out, no token
-- revocation and no auth.users change.
--
-- Nothing below re-establishes the session. pg_temp.act_as() is called ONCE for the Sales
-- Staff member and their JWT claims stay set for the rest of the section, exactly as a real
-- unexpired token would. The only thing that changes between the call that works and the call
-- that is refused is one column on one row.

select pg_temp.act_as(pg_temp.fx('owner_1'));
select is(pg_temp.member_status(pg_temp.fx('m_receipt')), 'ACTIVE',
  'session: the Sales Staff member starts ACTIVE');

-- The staff member signs in ONCE, here, and never again in this section.
select pg_temp.act_as(pg_temp.fx('u_receipt'));

select is(
  pg_temp.sqlstate_of(format(
    'select * from public.reserve_receipt_submission(%L::uuid, ''receipt.jpg'', ''image/jpeg'', 2048, %L)',
    pg_temp.fx('alpha'), repeat('b', 64))),
  null,
  'session: while ACTIVE they can reserve a receipt submission');

-- The portal agrees they have a Retailer context.
select is(
  public.get_my_portal_context() ->> 'portal_kind', 'SALES_STAFF',
  'session: and the portal reports a SALES_STAFF context');

-- The DIAGNOSTIC agrees too.
select is(pg_temp.my_state(), 'ACTIVE',
  'session: and the lifecycle diagnostic reports ACTIVE');

-- The Owner stands them down. This is the ONLY thing that changes.
select pg_temp.act_as(pg_temp.fx('owner_1'));
select pg_temp.set_status(pg_temp.fx('m_receipt'), 'DEACTIVATED');

-- Back to the staff member's ORIGINAL session — same GUC, same claims, never re-issued.
select pg_temp.act_as(pg_temp.fx('u_receipt'));

select is(
  pg_temp.sqlstate_of(format(
    'select * from public.reserve_receipt_submission(%L::uuid, ''receipt2.jpg'', ''image/jpeg'', 2048, %L)',
    pg_temp.fx('alpha'), repeat('c', 64))),
  '42501',
  'session: the DEACTIVATED member is refused on their VERY NEXT protected request — same session, no sign-out');

select is(
  public.get_my_portal_context() ->> 'portal_kind', 'NONE',
  'session: the portal now reports NONE — the existing resolver already handles this');

-- ...AND THIS IS THE GAP THE DIAGNOSTIC CLOSES. The refusal above is the same generic 42501 a
-- wrong-role caller gets, so the application cannot tell the two apart. The diagnostic can.
select is(pg_temp.my_state(), 'MEMBERSHIP_INACTIVE',
  'session: while the diagnostic explains WHY — MEMBERSHIP_INACTIVE, not a generic denial');

-- The Auth identity is completely untouched by all of this.
select ok(pg_temp.auth_user_exists(pg_temp.fx('u_receipt')),
  'session: their auth.users row is intact');
select ok(
  (select u.banned_until is null and u.deleted_at is null
   from auth.users u where u.id = pg_temp.fx('u_receipt')),
  'session: neither banned nor soft-deleted — the block is the membership row, not the identity');

-- REACTIVATION RESTORES RECEIPT ELIGIBILITY, with no role and no Shop assignment recreated.
select pg_temp.act_as(pg_temp.fx('owner_1'));
select pg_temp.set_status(pg_temp.fx('m_receipt'), 'ACTIVE');

select is(pg_temp.role_codes(pg_temp.fx('m_receipt')), array['SALES_STAFF'],
  'session: reactivation recreated no role — the original row was never removed');
select is(pg_temp.live_shop_names(pg_temp.fx('m_receipt')), array['Alpha Shop'],
  'session: and recreated no Shop assignment');

select pg_temp.act_as(pg_temp.fx('u_receipt'));
select is(
  pg_temp.sqlstate_of(format(
    'select * from public.reserve_receipt_submission(%L::uuid, ''receipt3.jpg'', ''image/jpeg'', 2048, %L)',
    pg_temp.fx('alpha'), repeat('d', 64))),
  null,
  'session: and they can submit receipts again immediately — eligibility is restored, not rebuilt');
select is(pg_temp.my_state(), 'ACTIVE',
  'session: the diagnostic reports ACTIVE again');


-- ============================================================================
-- SECTION P — the lifecycle diagnostic, behaviourally
-- ============================================================================
-- Every branch of the vocabulary, walked as the person it describes. The subject is always
-- auth.uid(): there is no argument, so each assertion below is made by BECOMING that person
-- and asking about nobody else.

-- P1. UNAUTHENTICATED — 42501, not a vocabulary word.
select pg_temp.sign_out();
select is(
  pg_temp.sqlstate_of('select * from public.get_my_lifecycle_access_state()'),
  '42501',
  'state: a signed-out caller is refused with 42501 — "not signed in" is not a lifecycle state');

-- P2. ACTIVE — one valid, fully active Retailer context.
select pg_temp.act_as(pg_temp.fx('u_sales'));
select is(pg_temp.my_state(), 'ACTIVE',
  'state: ACTIVE for one valid active Retailer context');
select is(pg_temp.my_state_rows(), 1::bigint,
  'state: and exactly ONE row is returned');

-- An OWNER is a supported role too, so the diagnostic works for them as well.
select pg_temp.act_as(pg_temp.fx('owner_1'));
select is(pg_temp.my_state(), 'ACTIVE',
  'state: ACTIVE for a Retailer Owner — all three supported roles are interpreted');
select pg_temp.act_as(pg_temp.fx('mgr_caller'));
select is(pg_temp.my_state(), 'ACTIVE',
  'state: and for a Retailer Manager');

-- P3. PROFILE_INACTIVE — the broadest cause, and it wins over everything below it.
select pg_temp.act_as(pg_temp.fx('p_inactive'));
select is(pg_temp.my_state(), 'PROFILE_INACTIVE',
  'state: PROFILE_INACTIVE when the caller''s own profile is not ACTIVE');

-- P4. MEMBERSHIP_INACTIVE — an ACTIVE Retailer, an inactive membership. Produced by the very
-- function this migration adds, rather than by a hand-written UPDATE.
select pg_temp.act_as(pg_temp.fx('owner_1'));
select pg_temp.set_status(pg_temp.fx('m_sales'), 'DEACTIVATED');
select pg_temp.act_as(pg_temp.fx('u_sales'));
select is(pg_temp.my_state(), 'MEMBERSHIP_INACTIVE',
  'state: MEMBERSHIP_INACTIVE for an inactive membership of an ACTIVE Retailer');
select pg_temp.act_as(pg_temp.fx('owner_1'));
select pg_temp.set_status(pg_temp.fx('m_sales'), 'ACTIVE');

-- P5. ORGANIZATION_INACTIVE — an ACTIVE membership of a SUSPENDED Retailer.
select pg_temp.act_as(pg_temp.fx('u_r3'));
select is(pg_temp.member_status(pg_temp.fx('m_r3')), 'ACTIVE',
  'state: the Retailer Three member''s own membership is ACTIVE');
select is(pg_temp.my_state(), 'ORGANIZATION_INACTIVE',
  'state: ORGANIZATION_INACTIVE when the Retailer itself is not ACTIVE');

-- P6. PRECEDENCE — both inactive reports the ORGANIZATION, because the Retailer-wide block is
-- the broader cause and the only one an Owner could act on.
select pg_temp.act_as(pg_temp.fx('p_r3both'));
select is(pg_temp.member_status(pg_temp.fx('m_r3both')), 'DEACTIVATED',
  'state: the precedence subject''s membership really is DEACTIVATED');
select is(pg_temp.my_state(), 'ORGANIZATION_INACTIVE',
  'state: ORGANIZATION_INACTIVE takes precedence when BOTH the organization and the membership are inactive');

-- P7. NO_SUPPORTED_ACCESS — a Vendor-only user, a role-less membership, and an auth row with
-- no profile at all.
select pg_temp.act_as(pg_temp.fx('vendor_admin'));
select is(pg_temp.my_state(), 'NO_SUPPORTED_ACCESS',
  'state: NO_SUPPORTED_ACCESS for a Vendor-only user — the Vendor role is not interpreted here');
select pg_temp.act_as(pg_temp.fx('u_roleless'));
select is(pg_temp.my_state(), 'NO_SUPPORTED_ACCESS',
  'state: NO_SUPPORTED_ACCESS for a membership carrying no supported role');
select pg_temp.act_as(pg_temp.fx('p_shell'));
select is(pg_temp.my_state(), 'NO_SUPPORTED_ACCESS',
  'state: NO_SUPPORTED_ACCESS — not PROFILE_INACTIVE — for an auth row that was never provisioned a profile');

-- P8. AMBIGUOUS — two qualifying Retailer contexts. The diagnostic will not guess, exactly as
-- the Retailer resolvers return NULL rather than choose.
select pg_temp.act_as(pg_temp.fx('p_ambig'));
select is(pg_temp.my_state(), 'AMBIGUOUS',
  'state: AMBIGUOUS for a person with supported memberships at TWO Retailers');

-- A member holding TWO supported roles at ONE Retailer is NOT ambiguous — that is one
-- context, and reporting otherwise would punish a person for their own role list.
select pg_temp.act_as(pg_temp.fx('u_multi'));
select is(pg_temp.my_state(), 'ACTIVE',
  'state: two supported roles at ONE Retailer is ONE context, not an ambiguous pair');

-- P9. THE VALUE DISCLOSES NOTHING. Walked over every state a caller can actually reach, so a
-- future edit that appended a name or an id to any one branch fails here.
select pg_temp.act_as(pg_temp.fx('u_sales'));
select ok(
  pg_temp.my_state() !~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@|Retailer One|Sara|Sales Shop|[0-9]{4}-[0-9]{2}-[0-9]{2}',
  'state: the returned value contains no uuid, email, organization name, person name or timestamp');
select ok(
  pg_temp.my_state() in ('ACTIVE', 'PROFILE_INACTIVE', 'MEMBERSHIP_INACTIVE',
                         'ORGANIZATION_INACTIVE', 'NO_SUPPORTED_ACCESS', 'AMBIGUOUS'),
  'state: and is always one of the six declared words');

-- THE WHOLE MAPPING, IN ONE ASSERTION. Every subject the fixture can offer, each asked as
-- themselves, compared against the exact word expected for them. Stated as a mapping rather
-- than as "none of them returned something undeclared", because that weaker form passes
-- vacuously the moment the impersonation stops working — a count of zero looks identical
-- whether the rule holds or the loop never ran.
select is(
  (select array_agg(pg_temp.state_of(pg_temp.fx(x.k)) order by x.k)
   from (values ('mgr_caller'), ('owner_1'), ('p_ambig'), ('p_inactive'), ('p_r3both'),
                ('p_shell'), ('u_multi'), ('u_r3'), ('u_roleless'), ('u_sales'),
                ('vendor_admin')) as x(k)),
  array['ACTIVE',                -- mgr_caller    Retailer Manager, everything active
        'ACTIVE',                -- owner_1       Retailer Owner, everything active
        'AMBIGUOUS',             -- p_ambig       supported memberships at two Retailers
        'PROFILE_INACTIVE',      -- p_inactive    own profile not ACTIVE
        'ORGANIZATION_INACTIVE', -- p_r3both      BOTH inactive -> organization wins
        'NO_SUPPORTED_ACCESS',   -- p_shell       auth row, never provisioned a profile
        'ACTIVE',                -- u_multi       two supported roles, ONE Retailer
        'ORGANIZATION_INACTIVE', -- u_r3          active membership of a suspended Retailer
        'NO_SUPPORTED_ACCESS',   -- u_roleless    membership carrying no supported role
        'ACTIVE',                -- u_sales       Sales Staff, everything active
        'NO_SUPPORTED_ACCESS'],  -- vendor_admin  Vendor-only, not interpreted here
  'state: all eleven fixture subjects map to exactly the expected word');

-- P10. IT PERFORMS NO WRITE. Asserted behaviourally as well as structurally: calling it for
-- every subject above moved no audit row and no membership.
select pg_temp.act_as(pg_temp.fx('u_sales'));
create temp table state_write_check as
  select (select count(*) from public.audit_logs) as audits,
         (select count(*) from public.organization_members) as members,
         (select count(*) from public.member_roles) as roles;

select pg_temp.my_state();
select pg_temp.my_state();
select pg_temp.my_state();

select is(
  array[(select count(*) from public.audit_logs),
        (select count(*) from public.organization_members),
        (select count(*) from public.member_roles)],
  (select array[audits, members, roles] from state_write_check),
  'state: three more calls wrote nothing — no audit row, no membership, no role');

-- P11. IT IS NOT AN AUTHORIZATION GATE, and the suite says so out loud. The diagnostic
-- reporting ACTIVE does not make an unauthorized operation succeed: the Sales Staff member
-- below reads ACTIVE and is STILL refused the Owner's write, because the real resolver — not
-- this function — decides.
select is(pg_temp.my_state(), 'ACTIVE',
  'gate: the Sales Staff member''s diagnostic reads ACTIVE');
select is(
  pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('m_guard'), 'DEACTIVATED')),
  '42501',
  'gate: and they are STILL refused the lifecycle write — the diagnostic authorizes nothing');


-- ============================================================================
-- SECTION Q — get_my_portal_context() was not weakened
-- ============================================================================
-- Section C proved its signature and version are untouched. This proves its BEHAVIOUR is: the
-- same generic, uninformative answer for every kind of denial, which is the property the
-- diagnostic was added SEPARATELY in order to avoid disturbing.

select pg_temp.sign_out();
select is(
  public.get_my_portal_context() ->> 'portal_kind', 'NONE',
  'portal: a signed-out caller still gets the ordinary NONE, not an error and not a reason');

select pg_temp.act_as(pg_temp.fx('vendor_admin'));
select is(
  public.get_my_portal_context() ->> 'portal_kind', 'VENDOR_SUPER_ADMIN',
  'portal: a Vendor Super Admin still routes to the Vendor portal');

select pg_temp.act_as(pg_temp.fx('p_inactive'));
select is(
  public.get_my_portal_context() ->> 'portal_kind', 'NONE',
  'portal: an inactive profile still gets a bare NONE — the portal still refuses to explain itself');
select is(
  (public.get_my_portal_context() -> 'retailer')::text, 'null',
  'portal: with a null retailer block, exactly as before');

-- AND THE TWO ANSWERS ARE INDEPENDENT. The portal says NONE for both an inactive profile and
-- a Vendor-only user; the diagnostic distinguishes them. That difference IS the milestone.
select is(pg_temp.my_state(), 'PROFILE_INACTIVE',
  'portal: while the diagnostic distinguishes this NONE from every other NONE');
select pg_temp.act_as(pg_temp.fx('vendor_admin'));
select is(
  public.get_my_portal_context() ->> 'portal_kind', 'VENDOR_SUPER_ADMIN',
  'portal: the Vendor''s routing is unchanged by any of this');

select finish();

rollback;
