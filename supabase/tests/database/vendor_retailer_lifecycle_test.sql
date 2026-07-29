-- pgTAP behavioural tests for the VENDOR RETAILER LIFECYCLE contract:
--
--   public.set_vendor_retailer_status(uuid, text)
--     [20260811090000_vendor_retailer_lifecycle.sql]
--
-- Run with:   npx supabase test db      (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE SPECIFIES
-- ============================================================================
-- This is the FIRST operation that can stop a whole Retailer trading, and the first that can
-- put one back. Everything a second client (Web or Flutter) will depend on is stated here
-- rather than inferred from the migration's prose:
--
--   1. TWO ROWS MOVE, ATOMICALLY, OR NEITHER DOES. vendor_retailers.status and the RETAILER
--      organization's organizations.status are written in one transaction with compare-and-set
--      predicates and checked row counts. Section J proves the rollback in both directions —
--      a blocked audit insert and a suppressed second UPDATE each abandon the first UPDATE.
--   2. WRITING ONLY THE RELATIONSHIP ROW WOULD NOT BLOCK ANYBODY. Section K is the evidence:
--      every Retailer-side refusal below comes from organizations.status, because not one
--      Retailer-side resolver consults vendor_retailers. Section K also proves the block
--      reaches an ALREADY-ISSUED SESSION — nobody is signed out and nothing expires.
--   3. NOTHING IS CASCADED AND NOTHING IS DELETED. Section L walks memberships, roles, Shops,
--      live AND retired Shop assignments, product assignments, receipts, both invitation
--      tables, profiles, auth.users and audit history row by row, before and after.
--   4. REACTIVATION IS A ONE-WORD WRITE, NOT A REBUILD. Section M proves access returns
--      through the SAME primary keys — no membership, role or assignment is recreated.
--   5. EVERY DISCLOSURE-SENSITIVE REFUSAL IS BYTE-IDENTICAL. Unknown, null, foreign,
--      cross-tenant and wrong-type targets, an unauthenticated caller, every Retailer-side
--      caller and a Vendor without RETAILERS_MANAGE all produce the same 42501 and the same
--      message, so a caller cannot sweep relationship ids. Section F is that matrix.
--   6. THE MULTI-VENDOR GUARD REFUSES WITHOUT DISCLOSING. Section I proves it fires in both
--      directions, that a DEACTIVATED foreign relationship does not fire it, and that the
--      refusal is indistinguishable from every other 55000 — no other Vendor id, no other
--      relationship id, no count, no status.
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as the
-- `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as far as
-- every authorization helper in this schema is concerned. pg_temp.act_as() does exactly that
-- and pg_temp.sign_out() clears it. This mirrors every other suite in this directory.
--
-- IT IS ALSO WHAT MAKES SECTION K MEANINGFUL. Suspending a Retailer does not clear the GUC,
-- so the Owner, Manager and Sales Staff in Section K are still holding the very sessions they
-- held before the suspension. That is precisely the "already-issued session" case the
-- milestone had to prove, and it is provable here only because nothing about the session is
-- re-established between the calls.
--
-- The tests do NOT `set role authenticated` except in Section N, where denial of DIRECT table
-- access is the subject. The function is SECURITY DEFINER, so its behaviour depends on
-- auth.uid() and not on the session role, and switching roles for the rest of the suite would
-- only make the fixture inserts fail. EXECUTE privilege is asserted directly against the
-- catalogue in Section A, which is stronger than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back: no organization, relationship,
-- membership, receipt, invitation or audit row written below survives, and neither does
-- Section D's temporary edit of the seeded role -> permission mappings nor Section J's
-- temporary triggers.
--
-- ============================================================================
-- WHAT THIS SUITE CANNOT PROVE, AND SAYS SO
-- ============================================================================
-- pg_prove runs each file in ONE session inside ONE transaction, so it cannot open a second
-- connection and watch it block. TRUE CROSS-SESSION SERIALIZATION IS THEREFORE NOT DIRECTLY
-- OBSERVABLE HERE, and this file does not pretend otherwise. Section H proves the two things
-- that are observable and that together are what serialization is made of:
--
--   * the function takes FOR UPDATE — not FOR SHARE and not nothing — on BOTH rows, and
--     leaves this transaction holding those row locks (asserted from the tuple headers);
--   * it takes them in ONE fixed order, relationship then organization, asserted against the
--     INSTALLED function body so a future edit that reverses them fails here.
--
-- Two concurrent callers therefore queue at the same first row in the same order, which is
-- the property the milestone required. The section header restates this limitation where a
-- reader will meet it.
--
-- ============================================================================
-- DETERMINISM
-- ============================================================================
-- NO ASSERTION DEPENDS ON UUID ORDERING. Where a set has to be compared it is compared over
-- names or codes ordered by themselves, never over generated ids.
--
-- now() is the TRANSACTION timestamp and is constant for the whole file. That is useful — an
-- unchanged updated_at is exactly assertable — but it means now() cannot witness "this row
-- was written". ctid — the tuple's physical location, which ANY row-touching UPDATE changes —
-- is used instead wherever "nothing was written at all" must be proved.
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
  insert into auth.users (id, email, email_confirmed_at)
  values (v_id, lower(p_first) || '.' || lower(p_last) || '@test.invalid', now() - interval '10 days');
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

  if p_role is not null then
    insert into public.member_roles (organization_member_id, role_id)
    select v_member, r.id from public.roles r where r.code = p_role
    on conflict do nothing;
  end if;

  return v_member;
end;
$$;

/* A Vendor -> Retailer relationship. THE TARGET IDENTIFIER OF THE FUNCTION UNDER TEST. */
create function pg_temp.rel(p_vendor uuid, p_retailer uuid, p_status text default 'ACTIVE')
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

/* A Shop assignment, created DIRECTLY. Section L needs both a live row and a RETIRED one, and
 * the retired one is only reachable this way. */
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
create function pg_temp.rel_status(p_rel uuid) returns text
language sql stable as $$
  select vr.status from public.vendor_retailers vr where vr.id = p_rel;
$$;

create function pg_temp.org_status(p_org uuid) returns text
language sql stable as $$
  select o.status from public.organizations o where o.id = p_org;
$$;

/* The physical row version — the only non-vacuous witness that a write touched a row, inside
 * a suite where now() is constant. */
create function pg_temp.rel_version(p_rel uuid) returns text
language sql stable as $$
  select vr.ctid::text from public.vendor_retailers vr where vr.id = p_rel;
$$;

create function pg_temp.org_version(p_org uuid) returns text
language sql stable as $$
  select o.ctid::text from public.organizations o where o.id = p_org;
$$;

create function pg_temp.rel_updated_at(p_rel uuid) returns timestamptz
language sql stable as $$
  select vr.updated_at from public.vendor_retailers vr where vr.id = p_rel;
$$;

create function pg_temp.org_updated_at(p_org uuid) returns timestamptz
language sql stable as $$
  select o.updated_at from public.organizations o where o.id = p_org;
$$;

/* Is this tuple row-locked by an in-flight transaction? A tuple with no lock and no update
 * carries xmax = 0; SELECT ... FOR UPDATE stamps the locking xid into it. Inside this suite
 * the only transaction that could have done so is this one. */
create function pg_temp.rel_locked(p_rel uuid) returns boolean
language sql stable as $$
  select vr.xmax::text <> '0' from public.vendor_retailers vr where vr.id = p_rel;
$$;

create function pg_temp.org_locked(p_org uuid) returns boolean
language sql stable as $$
  select o.xmax::text <> '0' from public.organizations o where o.id = p_org;
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
create function pg_temp.set_sql(p_rel uuid, p_status text) returns text
language sql immutable as $$
  select format(
    'select * from public.set_vendor_retailer_status(%L::uuid, %L::text)',
    p_rel, p_status);
$$;

/* A null target, written the way a client would send one. format(%L) on a null uuid yields
 * the literal NULL, so this is a genuinely null argument rather than the string 'NULL'. */
create function pg_temp.set_sql_null(p_status text) returns text
language sql immutable as $$
  select format(
    'select * from public.set_vendor_retailer_status(null::uuid, %L::text)', p_status);
$$;

/* The write under test, returning its four fields as text so one assertion can state the
 * whole returned row. */
create function pg_temp.set_status(p_rel uuid, p_status text) returns text[]
language plpgsql as $$
declare
  v_id       uuid;
  v_retailer text;
  v_rel      text;
  v_changed  boolean;
begin
  select t.relationship_id, t.retailer_status, t.relationship_status, t.status_changed
    into v_id, v_retailer, v_rel, v_changed
  from public.set_vendor_retailer_status(p_rel, p_status) t;
  return array[v_id::text, v_retailer, v_rel, v_changed::text];
end;
$$;

/* How many rows the write returns. "Exactly one row" is part of the contract and a function
 * that returned two would still satisfy every value assertion below. */
create function pg_temp.set_rows(p_rel uuid, p_status text) returns bigint
language sql volatile as $$
  select count(*) from public.set_vendor_retailer_status(p_rel, p_status);
$$;

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
create function pg_temp.audit_count(p_org uuid) returns bigint
language sql stable as $$
  select count(*) from public.audit_logs a
  where a.entity_type = 'RETAILER_ORGANIZATION'
    and a.entity_id = p_org::text;
$$;

/* The most recently appended audit row for a Retailer organization. ctid is physical
 * insertion order, which for rows appended in one transaction is the order they were
 * written — created_at cannot order them, because now() is constant here. */
create function pg_temp.last_audit(p_org uuid) returns public.audit_logs
language sql stable as $$
  select a.* from public.audit_logs a
  where a.entity_type = 'RETAILER_ORGANIZATION' and a.entity_id = p_org::text
  order by a.ctid desc limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Catalogue introspection
-- ---------------------------------------------------------------------------
/* Function-argument and table-column names, read from the catalogue.
 *
 * A multi-column `returns table (...)` function has prorettype = `record`, a pseudo-type with
 * no typrelid, so reading its columns through pg_class yields NOTHING and an assertion written
 * that way compares NULL to NULL and passes vacuously. The names live in proargnames,
 * distinguished only by proargmodes: 'i'/'b'/'v' for an input, 't' for a table column. */
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
 * Load-bearing, not tidiness: this body's commentary discusses auth.users, DELETE,
 * organization_members, service_role and another Vendor's identity at length precisely to
 * explain why none of them is used, so an assertion against the raw source would fail on the
 * very sentence that states the guarantee. Same idiom as the stripComments() helper in the
 * Node contract suite. */
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

/* The function under test, named ONCE, so a rename shows up as one failure rather than a
 * hundred. */
create function pg_temp.fn() returns text language sql immutable as $$
  select 'set_vendor_retailer_status'::text;
$$;

/* The permission this milestone introduces, named once for the same reason. */
create function pg_temp.perm() returns text language sql immutable as $$
  select 'RETAILERS_MANAGE'::text;
$$;

/* The single refusal message every disclosure-sensitive denial must share. Read from the
 * function rather than restated, so the test cannot drift from the migration — but pinned to
 * a literal below as well, because "they all match each other" would still pass if the
 * message became the empty string. */
create function pg_temp.deny_msg() returns text language sql immutable as $$
  select 'Not authorized to change this Retailer''s status'::text;
$$;

create function pg_temp.unavailable_msg() returns text language sql immutable as $$
  select 'This Retailer cannot be changed right now'::text;
$$;


-- ============================================================================
-- SECTION A — the contract: signature, security attributes, privileges
-- ============================================================================
-- Asserted against the catalogue rather than inferred from behaviour: "it did not error for
-- me" is not a privilege check, and a grant that widened by accident would still let every
-- behavioural test below pass.

select has_function('public', 'set_vendor_retailer_status', array['uuid', 'text'],
  'set_vendor_retailer_status(uuid, text) exists');

-- EXACTLY ONE Retailer lifecycle write exists. This milestone added no second entry point —
-- no deactivate_/reactivate_ pair, no bulk variant, no mobile duplicate. A second one would
-- be a second place for the tenant boundary, the current-pair rule and the multi-Vendor guard
-- to be stated, and only one of them could stay right.
select is(
  (select array_agg(p.proname::text order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname ~ 'vendor_retailer_status|retailer_lifecycle|deactivate_retailer|reactivate_retailer|suspend_retailer'),
  array['set_vendor_retailer_status'],
  'exactly one Vendor Retailer lifecycle write exists — no deactivate/reactivate pair, no bulk variant');

-- THE SIGNATURE IS THE DEPLOYED ONE. Clients call this by NAMED argument through PostgREST,
-- so a renamed parameter or a reordered pair is a silently broken client.
select is(pg_temp.input_types(pg_temp.fn()), array['uuid', 'text'],
  'takes exactly (uuid, text)');
select is(pg_temp.input_args(pg_temp.fn()), array['p_relationship_id', 'p_status'],
  'exposes exactly (p_relationship_id, p_status), in that order');

-- NO DEFAULTS. Both arguments are required, so a call that omits one is a PostgREST error
-- rather than a silently half-addressed write.
select is(
  (select p.pronargdefaults::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  0, 'no argument is defaulted');

-- THE RETURN SHAPE IS THE FOUR FIELDS, AND ONLY THEM. No Retailer name, no email, no
-- timestamp, no member count, no audit detail.
select is(pg_temp.out_args(pg_temp.fn()),
  array['relationship_id', 'retailer_status', 'relationship_status', 'status_changed'],
  'returns exactly (relationship_id, retailer_status, relationship_status, status_changed), in that order');
select is(pg_temp.out_types(pg_temp.fn()),
  array['uuid', 'text', 'text', 'boolean'],
  'the four returned columns are (uuid, text, text, boolean)');

-- NO IDENTITY, TENANT, ROLE, PERMISSION, AUDIT OR TIMESTAMP ARGUMENT. This is the
-- trusted-identity rule stated as a test: a caller may address a relationship and name a
-- state, and nothing else. Everything that decides WHETHER the write may happen is derived
-- server-side from auth.uid().
select is(
  (select count(*) from unnest(pg_temp.input_args(pg_temp.fn())) a
   where a ~ 'organization|vendor|retailer_id|tenant|owner|actor|user|profile|auth|uid|email|token|claim|role|permission|audit|version|reason|note|timestamp|suspended|deactivated'),
  0::bigint,
  'accepts no organization, Vendor, tenant, actor, user, profile, auth, email, token, role, permission, audit, version or timestamp argument');

select is(
  (select count(*) from unnest(pg_temp.input_args(pg_temp.fn())) a
   where a not in ('p_relationship_id', 'p_status')),
  0::bigint,
  'accepts the relationship and the requested state and NOTHING else — no current status, no audit action, no idempotency key');

-- SECURITY DEFINER, VOLATILE, EMPTY search_path.
select ok(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  'the lifecycle write is SECURITY DEFINER');
select is(
  (select p.provolatile::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  'v', 'the lifecycle write is VOLATILE — the correct classification for a function that writes');
select ok(
  (select p.proconfig @> array['search_path=""'] from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  'the lifecycle write runs with an EMPTY search_path');
select is(
  (select l.lanname from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   join pg_language l on l.oid = p.prolang
   where n.nspname = 'public' and p.proname = pg_temp.fn()),
  'plpgsql', 'the lifecycle write is plpgsql');

-- GRANTS: authenticated only.
select ok(has_function_privilege('authenticated',
  'public.set_vendor_retailer_status(uuid, text)', 'execute'),
  'authenticated may execute the lifecycle write');
select ok(not has_function_privilege('anon',
  'public.set_vendor_retailer_status(uuid, text)', 'execute'),
  'anon may NOT execute the lifecycle write');
select ok(not has_function_privilege('service_role',
  'public.set_vendor_retailer_status(uuid, text)', 'execute'),
  'service_role holds NO grant — the whole authority of this function is auth.uid()');

-- PUBLIC holds nothing. PostgreSQL grants EXECUTE to PUBLIC by default on every new function,
-- which on a SECURITY DEFINER writer would be exactly wrong; the migration revokes it and this
-- is what proves the revoke is still in force.
select ok(pg_temp.proacl_of(pg_temp.fn()) !~ '(^|,)=X/',
  'PUBLIC holds no EXECUTE on the lifecycle write');
select ok(pg_temp.proacl_of(pg_temp.fn()) !~ 'service_role',
  'service_role appears nowhere in the function ACL');
select ok(pg_temp.proacl_of(pg_temp.fn()) !~ 'anon',
  'anon appears nowhere in the function ACL');


-- ============================================================================
-- SECTION B — the installed body: what it does, and what it must never do
-- ============================================================================
-- These read the INSTALLED source, not the migration file, so they hold against whatever is
-- actually in the database — including a hot-patched or re-created function.

-- THE LOCK ORDER IS DETERMINISTIC, AND IT IS relationship -> organization. Asserted by
-- position, because a reversal is the one edit that turns two safe concurrent callers into a
-- deadlock, and nothing else in this file could catch it.
select ok(
  position('public.vendor_retailers' in pg_temp.installed_code(pg_temp.fn())) > 0
  and position('public.organizations' in pg_temp.installed_code(pg_temp.fn())) > 0
  and position('public.vendor_retailers' in pg_temp.installed_code(pg_temp.fn()))
      < position('public.organizations' in pg_temp.installed_code(pg_temp.fn())),
  'the relationship table is reached BEFORE the organizations table — one deterministic lock order');

select is(
  (select count(*) from regexp_matches(pg_temp.installed_code(pg_temp.fn()), 'for update', 'g')),
  2::bigint,
  'exactly TWO rows are locked FOR UPDATE — the relationship and its organization');

select ok(pg_temp.installed_code(pg_temp.fn()) !~* '\mfor share\M',
  'neither row is taken with the weaker FOR SHARE — both are written');

-- THE MULTI-VENDOR GUARD IS PRESENT, AND IT IS AN EXISTENCE TEST.
select ok(pg_temp.installed_code(pg_temp.fn()) ~ 'vendor_organization_id <> ',
  'the multi-Vendor guard compares against the derived Vendor with <>');
select ok(pg_temp.installed_code(pg_temp.fn()) ~ 'status <> ''DEACTIVATED''',
  'the guard ignores DEACTIVATED relationships');
select ok(pg_temp.installed_code(pg_temp.fn()) ~* '\mexists\M',
  'the guard is an EXISTS test — never a count, so no cardinality can leak');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* '\mcount\s*\(',
  'nothing in the body counts relationships');

-- BOTH UPDATES EXIST, AND BOTH ARE COMPARE-AND-SET WITH A CHECKED ROW COUNT.
select is(
  (select count(*) from regexp_matches(pg_temp.installed_code(pg_temp.fn()), 'update public\.', 'g')),
  2::bigint,
  'exactly TWO UPDATE statements — vendor_retailers and organizations');
select ok(pg_temp.installed_code(pg_temp.fn()) ~ 'update public\.vendor_retailers',
  'vendor_retailers.status is updated');
select ok(pg_temp.installed_code(pg_temp.fn()) ~ 'update public\.organizations',
  'organizations.status is updated');
select is(
  (select count(*) from regexp_matches(pg_temp.installed_code(pg_temp.fn()), 'get diagnostics', 'g')),
  2::bigint,
  'both row counts are captured');
select is(
  (select count(*) from regexp_matches(pg_temp.installed_code(pg_temp.fn()), 'v_updated <> 1', 'g')),
  2::bigint,
  'both row counts are VERIFIED to be exactly one');

-- NO ROLE-NAME AUTHORIZATION INSIDE THE WRITE PATH. The gate is the permission; the mapping
-- is the authority. A role code here would put the rule in two places that can disagree.
select ok(pg_temp.installed_code(pg_temp.fn()) !~ 'VENDOR_SUPER_ADMIN',
  'the executable body names NO role code — authorization is by permission, never by role name');
select ok(pg_temp.installed_code(pg_temp.fn()) ~ pg_temp.perm(),
  'the executable body names RETAILERS_MANAGE');
select ok(pg_temp.installed_code(pg_temp.fn()) !~ 'RETAILERS_READ|RETAILERS_CREATE',
  'it does not reuse the Retailer READ or CREATE permission');

-- NOTHING ELSE IS WRITTEN. Every one of these is a table the milestone promised to preserve.
select ok(pg_temp.installed_code(pg_temp.fn()) !~* 'update public\.organization_members',
  'organization_members is never updated — SUSPENDED is not cascaded into memberships');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* 'member_roles',
  'member_roles is never referenced');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* 'retailer_shop_members',
  'retailer_shop_members is never referenced');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* 'update public\.profiles',
  'profiles is never updated');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* '\mauth\.users\M',
  'auth.users is never referenced — not banned, not deleted, not updated');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* '\mdelete\s+from\M',
  'there is no DELETE anywhere on this path');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* '\mtruncate\M',
  'and no TRUNCATE');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* '\mexecute\s',
  'no dynamic SQL — every statement is static and every identifier is fixed');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* 'retailer_staff_invitations|retailer_invitations',
  'neither invitation table is touched — pending invitations survive untouched');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* 'receipt_submissions',
  'receipts are never touched');
select ok(pg_temp.installed_code(pg_temp.fn()) !~* 'suspended_at|deactivated_at',
  'no lifecycle timestamp column is written — audit_logs is the history');

-- THE 55000 CAUSES SHARE ONE MESSAGE. Counted, so a future edit that "helpfully" distinguishes
-- the multi-Vendor case from the mismatch case fails here.
select is(
  (select count(*) from regexp_matches(pg_temp.installed_code(pg_temp.fn()),
     'This Retailer cannot be changed right now', 'g')),
  4::bigint,
  'all four 55000 paths raise ONE identical generic message');
select is(
  (select count(*) from regexp_matches(pg_temp.installed_code(pg_temp.fn()),
     'object_not_in_prerequisite_state', 'g')),
  4::bigint,
  'and all four use SQLSTATE 55000');


-- ============================================================================
-- SECTION C — the permission catalogue entry and its ONE mapping
-- ============================================================================
select is(
  (select p.name from public.permissions p where p.code = pg_temp.perm()),
  'Manage Retailer Lifecycle', 'RETAILERS_MANAGE exists and is named "Manage Retailer Lifecycle"');
select is(
  (select p.description from public.permissions p where p.code = pg_temp.perm()),
  'Deactivate and reactivate a connected Retailer.',
  'its description is the approved sentence');
select is(
  (select p.module from public.permissions p where p.code = pg_temp.perm()),
  'RETAILERS', 'it belongs to the RETAILERS module, alongside RETAILERS_READ');

-- MAPPED TO VENDOR_SUPER_ADMIN AND TO NOTHING ELSE. This is the whole tenant-safety argument
-- for the permission: a Retailer-side role holding it could suspend or un-suspend its own
-- tenant, which is the one thing a Vendor-side control exists to prevent.
select is(
  (select array_agg(r.code order by r.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = pg_temp.perm()),
  array['VENDOR_SUPER_ADMIN'],
  'RETAILERS_MANAGE is mapped to VENDOR_SUPER_ADMIN and to NO other role');

select is(
  (select count(*) from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = pg_temp.perm()
     and r.code in ('RETAILER_OWNER', 'RETAILER_MANAGER', 'SALES_STAFF')),
  0::bigint,
  'no Retailer-side role holds it');

-- THE EXISTING PERMISSIONS WERE NOT REDEFINED. RETAILERS_READ keeps its meaning and its
-- module, so nothing that already depends on it changed underneath.
select is(
  (select p.module from public.permissions p where p.code = 'RETAILERS_READ'),
  'RETAILERS', 'RETAILERS_READ is untouched');
select ok(
  exists (select 1 from public.permissions p where p.code = 'RETAILERS_MANAGE')
  and exists (select 1 from public.permissions p where p.code = 'RETAILERS_READ'),
  'the lifecycle permission is ADDITIVE — the read permission still exists beside it');


-- ============================================================================
-- Fixtures
-- ============================================================================
-- EACH BEHAVIOURAL SECTION GETS ITS OWN RETAILER. Sharing one would make a failure in an
-- early section cascade into every later one, and would make "this row was never touched"
-- unprovable.

insert into pg_temp.fx (k, v) values
  ('va_admin',   pg_temp.new_person('Ada',   'Vendorone')),
  ('vb_admin',   pg_temp.new_person('Bob',   'Vendortwo')),
  ('outsider',   pg_temp.new_person('Otto',  'Outsider')),
  -- The Retailer-side people of the downstream Retailer.
  ('d_owner',    pg_temp.new_person('Omar',  'Downowner')),
  ('d_manager',  pg_temp.new_person('Mia',   'Downmgr')),
  ('d_sales',    pg_temp.new_person('Sara',  'Downsales')),
  -- Invitation recipients.
  ('inv_staff',  pg_temp.new_person('Ivy',   'Staffinvitee')),
  ('inv_owner',  pg_temp.new_person('Ian',   'Ownerinvitee'));

insert into pg_temp.fx (k, v) values
  ('vendor_a', pg_temp.new_org('Vendor A', 'VENDOR')),
  ('vendor_b', pg_temp.new_org('Vendor B', 'VENDOR'));

insert into pg_temp.fx (k, v) values
  ('m_va', pg_temp.staff(pg_temp.fx('va_admin'), pg_temp.fx('vendor_a'), 'VENDOR_SUPER_ADMIN')),
  ('m_vb', pg_temp.staff(pg_temp.fx('vb_admin'), pg_temp.fx('vendor_b'), 'VENDOR_SUPER_ADMIN'));

-- One Retailer per section, each with its own relationship to Vendor A.
insert into pg_temp.fx (k, v) values
  ('r_happy',   pg_temp.new_org('Happy Retail')),
  ('r_idem',    pg_temp.new_org('Idempotent Retail')),
  ('r_auth',    pg_temp.new_org('Authz Retail')),
  ('r_input',   pg_temp.new_org('Input Retail')),
  ('r_lock',    pg_temp.new_org('Lock Retail')),
  ('r_roll',    pg_temp.new_org('Rollback Retail')),
  ('r_cas',     pg_temp.new_org('Compareset Retail')),
  ('r_guard',   pg_temp.new_org('Guarded Retail')),
  ('r_down',    pg_temp.new_org('Downstream Retail')),
  ('r_foreign', pg_temp.new_org('Foreign Retail')),
  ('r_type',    pg_temp.new_org('Wrongtype Retail')),
  -- Deliberately inconsistent current pairs.
  ('r_mm_as',   pg_temp.new_org('Mismatch AS')),
  ('r_mm_sa',   pg_temp.new_org('Mismatch SA')),
  ('r_dr',      pg_temp.new_org('Dead Relationship')),
  ('r_do',      pg_temp.new_org('Dead Organization', 'RETAILER', 'DEACTIVATED')),
  -- Multi-Vendor.
  ('r_mv_act',  pg_temp.new_org('Multi Active')),
  ('r_mv_sus',  pg_temp.new_org('Multi Suspended')),
  ('r_mv_dea',  pg_temp.new_org('Multi Deactivated')),
  ('r_mv_re',   pg_temp.new_org('Multi Reactivate', 'RETAILER', 'SUSPENDED'));

insert into pg_temp.fx (k, v) values
  ('rel_happy',  pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_happy'))),
  ('rel_idem',   pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_idem'))),
  ('rel_auth',   pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_auth'))),
  ('rel_input',  pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_input'))),
  ('rel_lock',   pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_lock'))),
  ('rel_roll',   pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_roll'))),
  ('rel_cas',    pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_cas'))),
  ('rel_guard',  pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_guard'))),
  ('rel_down',   pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_down'))),
  ('rel_type',   pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_type'))),
  -- Vendor B's own Retailer. Vendor A must never reach this id.
  ('rel_foreign', pg_temp.rel(pg_temp.fx('vendor_b'), pg_temp.fx('r_foreign'))),
  -- Inconsistent pairs.
  ('rel_mm_as',  pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_mm_as'))),
  ('rel_mm_sa',  pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_mm_sa'), 'SUSPENDED')),
  ('rel_dr',     pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_dr'), 'DEACTIVATED')),
  ('rel_do',     pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_do'))),
  -- Multi-Vendor: Vendor A's relationship, then Vendor B's alongside it.
  ('rel_mv_act', pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_mv_act'))),
  ('rel_mv_sus', pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_mv_sus'))),
  ('rel_mv_dea', pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_mv_dea'))),
  ('rel_mv_re',  pg_temp.rel(pg_temp.fx('vendor_a'), pg_temp.fx('r_mv_re'), 'SUSPENDED'));

insert into pg_temp.fx (k, v) values
  ('rel_b_act',  pg_temp.rel(pg_temp.fx('vendor_b'), pg_temp.fx('r_mv_act'))),
  ('rel_b_sus',  pg_temp.rel(pg_temp.fx('vendor_b'), pg_temp.fx('r_mv_sus'), 'SUSPENDED')),
  ('rel_b_dea',  pg_temp.rel(pg_temp.fx('vendor_b'), pg_temp.fx('r_mv_dea'), 'DEACTIVATED')),
  ('rel_b_re',   pg_temp.rel(pg_temp.fx('vendor_b'), pg_temp.fx('r_mv_re')));

-- 'r_mm_as' must be relationship ACTIVE + organization SUSPENDED. The organization was created
-- ACTIVE so its relationship could be inserted normally; it is moved here, DIRECTLY, because
-- the function under test is exactly the thing that cannot produce this state.
update public.organizations set status = 'SUSPENDED' where id = pg_temp.fx('r_mm_as');

-- 'r_type' must NOT be a RETAILER. The relationship was created against a RETAILER (the
-- vendor_retailers trigger requires it), and the organization is then re-typed directly — that
-- trigger fires only on changes to the relationship's own organization columns, so this is
-- reachable and is precisely the drifted state the function must refuse.
update public.organizations set organization_type = 'VENDOR' where id = pg_temp.fx('r_type');

-- Sanity: the fixture is what the sections below assume.
select is(pg_temp.rel_status(pg_temp.fx('rel_mm_as')), 'ACTIVE',
  'fixture: the AS mismatch really has an ACTIVE relationship');
select is(pg_temp.org_status(pg_temp.fx('r_mm_as')), 'SUSPENDED',
  'fixture: ...against a SUSPENDED organization');
select is(pg_temp.rel_status(pg_temp.fx('rel_mm_sa')), 'SUSPENDED',
  'fixture: the SA mismatch really has a SUSPENDED relationship');
select is(pg_temp.org_status(pg_temp.fx('r_mm_sa')), 'ACTIVE',
  'fixture: ...against an ACTIVE organization');
select is(
  (select o.organization_type from public.organizations o where o.id = pg_temp.fx('r_type')),
  'VENDOR', 'fixture: the wrong-type target really is not a RETAILER any more');


-- ============================================================================
-- SECTION D — the permission is RETAILERS_MANAGE, and it alone
-- ============================================================================
-- The mapping is TEMPORARILY REMOVED to prove the function reads it rather than assuming it.
-- A Vendor Super Admin with the role and without the permission must be refused — which is
-- what makes "the mapping is the authority" a testable claim rather than a comment.

select pg_temp.act_as(pg_temp.fx('va_admin'));

select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_auth'), 'SUSPENDED')), null,
  'with the mapping in place, the Vendor Super Admin is authorized');
-- Undo it: this section is about authorization, not about lifecycle state.
select is((pg_temp.set_status(pg_temp.fx('rel_auth'), 'ACTIVE'))[4], 'true',
  'and the Retailer is put back for the sections that follow');

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and r.code = 'VENDOR_SUPER_ADMIN' and p.code = pg_temp.perm();

select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_auth'), 'SUSPENDED')), '42501',
  'with RETAILERS_MANAGE unmapped, the SAME Vendor Super Admin is refused');
select is(pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_auth'), 'SUSPENDED')),
  pg_temp.deny_msg(),
  'and refused with the generic message — the role is not a substitute for the permission');
select is(pg_temp.rel_status(pg_temp.fx('rel_auth')), 'ACTIVE',
  'and nothing was written');

-- RETAILERS_READ is NOT a substitute. The caller holds it throughout this suite (it is seeded
-- to VENDOR_SUPER_ADMIN), and it did not authorize the call above.
select ok(
  exists (
    select 1 from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    join public.permissions p on p.id = rp.permission_id
    where r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'RETAILERS_READ'),
  'the refused caller still holds RETAILERS_READ — a read permission does not authorize the write');

-- Restore it. Everything after this point runs against the seeded mapping.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN' and p.code = pg_temp.perm()
on conflict (role_id, permission_id) do nothing;

select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_auth'), 'SUSPENDED')), null,
  'restoring the mapping restores the operation');
select is((pg_temp.set_status(pg_temp.fx('rel_auth'), 'ACTIVE'))[4], 'true',
  'and the fixture is left ACTIVE again');


-- ============================================================================
-- SECTION E — the happy paths, in both directions
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('va_admin'));

select is(pg_temp.rel_status(pg_temp.fx('rel_happy')), 'ACTIVE', 'happy: starts ACTIVE (relationship)');
select is(pg_temp.org_status(pg_temp.fx('r_happy')),   'ACTIVE', 'happy: starts ACTIVE (organization)');

select is(pg_temp.set_rows(pg_temp.fx('rel_happy'), 'SUSPENDED'), 1::bigint,
  'happy: the write returns EXACTLY ONE row');
-- The call above already performed the suspension; put it back so the assertions below start
-- from a known state and describe ONE transition each.
select is((pg_temp.set_status(pg_temp.fx('rel_happy'), 'ACTIVE'))[4], 'true',
  'happy: and back to ACTIVE, so the transition below is the one under test');

-- SUSPEND.
select is(pg_temp.set_status(pg_temp.fx('rel_happy'), 'SUSPENDED'),
  array[pg_temp.fx('rel_happy')::text, 'SUSPENDED', 'SUSPENDED', 'true'],
  'happy: suspending returns (the relationship, SUSPENDED, SUSPENDED, changed)');

-- BOTH ROWS MOVED. This pair of assertions is the milestone.
select is(pg_temp.rel_status(pg_temp.fx('rel_happy')), 'SUSPENDED',
  'happy: vendor_retailers.status is SUSPENDED');
select is(pg_temp.org_status(pg_temp.fx('r_happy')), 'SUSPENDED',
  'happy: organizations.status is SUSPENDED — the row that actually blocks the Retailer');

-- REACTIVATE.
select is(pg_temp.set_status(pg_temp.fx('rel_happy'), 'ACTIVE'),
  array[pg_temp.fx('rel_happy')::text, 'ACTIVE', 'ACTIVE', 'true'],
  'happy: reactivating returns (the relationship, ACTIVE, ACTIVE, changed)');
select is(pg_temp.rel_status(pg_temp.fx('rel_happy')), 'ACTIVE',
  'happy: vendor_retailers.status is ACTIVE again');
select is(pg_temp.org_status(pg_temp.fx('r_happy')), 'ACTIVE',
  'happy: organizations.status is ACTIVE again');

-- THE RETURNED VALUES ARE THE COMMITTED ONES, not a hopeful echo of the request. Compared
-- against the rows themselves rather than against the literal.
--
-- The call is materialized into a temp table FIRST, and the row is read afterwards. Putting
-- both inside one is() would leave the order to the planner, and a comparison that can pass or
-- fail on evaluation order is not a test of anything.
create temp table happy_suspend as
  select (pg_temp.set_status(pg_temp.fx('rel_happy'), 'SUSPENDED'))[2] as returned_retailer_status;
select is((select returned_retailer_status from happy_suspend),
  pg_temp.org_status(pg_temp.fx('r_happy')),
  'happy: the returned retailer_status equals the committed organizations.status');

create temp table happy_activate as
  select (pg_temp.set_status(pg_temp.fx('rel_happy'), 'ACTIVE'))[3] as returned_relationship_status;
select is((select returned_relationship_status from happy_activate),
  pg_temp.rel_status(pg_temp.fx('rel_happy')),
  'happy: the returned relationship_status equals the committed vendor_retailers.status');

-- NOTHING ELSE MOVED. Every other Retailer in the fixture is exactly where it was.
select is(pg_temp.org_status(pg_temp.fx('r_idem')), 'ACTIVE',
  'happy: a different Retailer was not affected');
select is(pg_temp.org_status(pg_temp.fx('r_foreign')), 'ACTIVE',
  'happy: nor was another Vendor''s Retailer');


-- ============================================================================
-- SECTION F — idempotency: a repeat writes NOTHING
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('va_admin'));

select is((pg_temp.set_status(pg_temp.fx('rel_idem'), 'SUSPENDED'))[4], 'true',
  'idem: the first suspension is a real change');

create temp table idem_before as
  select pg_temp.rel_version(pg_temp.fx('rel_idem')) as rel_v,
         pg_temp.org_version(pg_temp.fx('r_idem'))   as org_v,
         pg_temp.rel_updated_at(pg_temp.fx('rel_idem')) as rel_u,
         pg_temp.org_updated_at(pg_temp.fx('r_idem'))   as org_u,
         pg_temp.audit_count(pg_temp.fx('r_idem'))      as audits;

select is(pg_temp.set_status(pg_temp.fx('rel_idem'), 'SUSPENDED'),
  array[pg_temp.fx('rel_idem')::text, 'SUSPENDED', 'SUSPENDED', 'false'],
  'idem: repeating the suspension returns status_changed = false');

-- NO ROW WAS TOUCHED. ctid is the physical tuple location and ANY row-touching UPDATE moves
-- it, so this is the assertion that "no UPDATE ran" rather than "the UPDATE was harmless".
select is(pg_temp.rel_version(pg_temp.fx('rel_idem')), (select rel_v from idem_before),
  'idem: the relationship row was not rewritten');
select is(pg_temp.org_version(pg_temp.fx('r_idem')), (select org_v from idem_before),
  'idem: the organization row was not rewritten');
select is(pg_temp.rel_updated_at(pg_temp.fx('rel_idem')), (select rel_u from idem_before),
  'idem: updated_at did not move on the relationship');
select is(pg_temp.org_updated_at(pg_temp.fx('r_idem')), (select org_u from idem_before),
  'idem: nor on the organization — a double-tap cannot destroy when this happened');
select is(pg_temp.audit_count(pg_temp.fx('r_idem')), (select audits from idem_before),
  'idem: and NO audit row was written — a no-op is not an event');

-- The other direction.
select is((pg_temp.set_status(pg_temp.fx('rel_idem'), 'ACTIVE'))[4], 'true',
  'idem: reactivating is a real change');
select is((pg_temp.set_status(pg_temp.fx('rel_idem'), 'ACTIVE'))[4], 'false',
  'idem: repeating the reactivation returns status_changed = false');
select is(pg_temp.audit_count(pg_temp.fx('r_idem')), 2::bigint,
  'idem: exactly two audit rows for four calls — one per REAL transition');


-- ============================================================================
-- SECTION G — authorization, tenancy and disclosure
-- ============================================================================
-- EVERY REFUSAL IN THIS SECTION MUST BE BYTE-IDENTICAL. That is what stops a caller sweeping
-- relationship ids to learn which ones exist, and what stops the refusal disclosing another
-- Vendor's Retailer list.

-- Signed out.
select pg_temp.sign_out();
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_auth'), 'SUSPENDED')), '42501',
  'a signed-out caller is refused');

-- A Retailer Owner, Manager and Sales Staff member of the Retailer being addressed. None of
-- them may switch their own tenant off — or back on.
select pg_temp.act_as(pg_temp.fx('d_owner'));
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_down'), 'SUSPENDED')), '42501',
  'a Retailer Owner is refused — a tenant cannot deactivate itself');
select pg_temp.act_as(pg_temp.fx('d_manager'));
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_down'), 'SUSPENDED')), '42501',
  'a Retailer Manager is refused');
select pg_temp.act_as(pg_temp.fx('d_sales'));
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_down'), 'SUSPENDED')), '42501',
  'a Sales Staff member is refused');
select pg_temp.act_as(pg_temp.fx('outsider'));
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_auth'), 'SUSPENDED')), '42501',
  'a signed-in person with no membership at all is refused');

-- Cross-tenant. Vendor A addressing Vendor B's relationship, and the reverse.
select pg_temp.act_as(pg_temp.fx('va_admin'));
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_foreign'), 'SUSPENDED')), '42501',
  'Vendor A cannot address Vendor B''s relationship');
select pg_temp.act_as(pg_temp.fx('vb_admin'));
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_auth'), 'SUSPENDED')), '42501',
  'and Vendor B cannot address Vendor A''s');
select is(pg_temp.org_status(pg_temp.fx('r_foreign')), 'ACTIVE',
  'neither attempt changed anything');
select is(pg_temp.org_status(pg_temp.fx('r_auth')), 'ACTIVE',
  'in either direction');

-- Unknown, null and wrong-type targets.
select pg_temp.act_as(pg_temp.fx('va_admin'));
select is(pg_temp.sqlstate_of(pg_temp.set_sql(gen_random_uuid(), 'SUSPENDED')), '42501',
  'an unknown relationship id is refused');
select is(pg_temp.sqlstate_of(pg_temp.set_sql_null('SUSPENDED')), '42501',
  'a null relationship id is refused');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_type'), 'SUSPENDED')), '42501',
  'a relationship whose organization is not a RETAILER is refused');
select is(
  (select o.status from public.organizations o where o.id = pg_temp.fx('r_type')),
  'ACTIVE', 'and the non-RETAILER organization was not written');

-- A MALFORMED UUID NEVER REACHES THE FUNCTION. PostgreSQL rejects it while parsing the
-- argument, which is 22P02 and is deliberately NOT converted into an authorization answer.
select is(
  pg_temp.sqlstate_of(
    'select * from public.set_vendor_retailer_status(''not-a-uuid''::uuid, ''SUSPENDED''::text)'),
  '22P02', 'a malformed uuid is PostgreSQL''s 22P02, raised before the body runs');

-- THE DISCLOSURE PROOF. Every message above is the same string, and it is the literal the
-- migration states — not merely equal to each other.
select is(
  (select count(distinct m) from (
     select pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_foreign'), 'SUSPENDED')) as m
     union all select pg_temp.message_of(pg_temp.set_sql(gen_random_uuid(), 'SUSPENDED'))
     union all select pg_temp.message_of(pg_temp.set_sql_null('SUSPENDED'))
     union all select pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_type'), 'SUSPENDED'))
   ) s),
  1::bigint,
  'unknown, null, foreign and wrong-type targets produce ONE indistinguishable message');

select is(pg_temp.message_of(pg_temp.set_sql(gen_random_uuid(), 'SUSPENDED')), pg_temp.deny_msg(),
  'and that message is the generic authorization sentence');

-- The signed-out and wrong-role refusals join the same class.
select pg_temp.sign_out();
select is(pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_auth'), 'SUSPENDED')), pg_temp.deny_msg(),
  'a signed-out caller gets the same sentence');
select pg_temp.act_as(pg_temp.fx('d_owner'));
select is(pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_down'), 'SUSPENDED')), pg_temp.deny_msg(),
  'so does a Retailer Owner — "exists but not yours" and "does not exist" read alike');

-- NO REFUSAL LEAKS AN IDENTIFIER OR A NAME.
select ok(
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_foreign'), 'SUSPENDED'))
    !~ '[0-9a-f]{8}-[0-9a-f]{4}',
  'no refusal message contains a uuid');
select ok(
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_foreign'), 'SUSPENDED')) !~* 'Foreign Retail|Vendor B|@',
  'no refusal message names another Vendor, its Retailer or an email address');


-- ============================================================================
-- SECTION H — the requested status is a closed vocabulary of exactly two words
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('va_admin'));

select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_input'), 'SUSPENDED')), null,
  'SUSPENDED is accepted');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_input'), 'ACTIVE')), null,
  'ACTIVE is accepted');

-- DEACTIVATED is a member of BOTH columns' vocabularies and is deliberately not a member of
-- this function's. Setting it would invent an offboarding decision nobody made.
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_input'), 'DEACTIVATED')), '23514',
  'DEACTIVATED is rejected — this function neither sets nor clears the terminal state');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_input'), 'INVITED')), '23514',
  'INVITED is rejected');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_input'), 'active')), '23514',
  'lowercase "active" is rejected, not coerced');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_input'), 'suspended')), '23514',
  'lowercase "suspended" is rejected too');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_input'), ' ACTIVE')), '23514',
  'a leading space is rejected — nothing is trimmed');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_input'), '')), '23514',
  'the empty string is rejected');
select is(
  pg_temp.sqlstate_of(format(
    'select * from public.set_vendor_retailer_status(%L::uuid, null::text)',
    pg_temp.fx('rel_input'))),
  '23514', 'a null status is rejected');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_input'), 'INACTIVE')), '23514',
  'the USER-FACING word "INACTIVE" is not a stored value and is rejected');

select is(pg_temp.rel_status(pg_temp.fx('rel_input')), 'ACTIVE',
  'no rejected request changed the relationship');
select is(pg_temp.org_status(pg_temp.fx('r_input')), 'ACTIVE',
  'nor the organization');

-- VALIDATION HAPPENS AFTER AUTHORIZATION. A stranger sending nonsense learns that they are a
-- stranger, not that their nonsense was nonsense.
select pg_temp.sign_out();
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_input'), 'nonsense')), '42501',
  'an unauthenticated caller sending an invalid status still gets 42501, never 23514');
select pg_temp.act_as(pg_temp.fx('d_owner'));
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_down'), 'nonsense')), '42501',
  'and so does an unauthorized one — bad input is not an oracle');


-- ============================================================================
-- SECTION I — the CURRENT pair, locking, and atomicity
-- ============================================================================
-- ⚠️ LIMITATION, STATED WHERE IT IS RELEVANT: pg_prove runs this file in ONE session inside
-- ONE transaction, so it cannot open a second connection and watch it block. What is asserted
-- here is (a) that BOTH rows are genuinely row-locked by this transaction after a call, and
-- (b) — in Section B — that the body takes those locks FOR UPDATE in one fixed order. Two
-- concurrent callers therefore queue at the same first row in the same order, which is the
-- serialization property the milestone required. The blocking itself is a PostgreSQL
-- guarantee, not something this file re-proves.

select pg_temp.act_as(pg_temp.fx('va_admin'));

-- THE RELATIONSHIP ROW IS THE OBSERVABLE ONE. Nothing references vendor_retailers by foreign
-- key, so its tuple carries no xmax until something locks it — which makes xmax an exact
-- witness for "this transaction took a row lock here".
--
-- THE ORGANIZATION ROW IS NOT OBSERVABLE THE SAME WAY, and the reason is worth recording: the
-- relationship's own FOREIGN KEY to organizations already takes a KEY SHARE row lock on the
-- referenced organization when the relationship is inserted, so its xmax is non-zero before
-- this function is ever called. xmax cannot distinguish that pre-existing FK lock from the
-- FOR UPDATE taken here, so it is not asserted on — Section B asserts the organizations FOR
-- UPDATE from the installed body instead, which is exact.
select ok(not pg_temp.rel_locked(pg_temp.fx('rel_lock')),
  'lock: the relationship row starts unlocked');

create temp table lock_before as
  select pg_temp.rel_version(pg_temp.fx('rel_lock')) as rel_v,
         pg_temp.org_version(pg_temp.fx('r_lock'))   as org_v;

-- A NO-OP CALL still takes both locks and writes nothing, which is what makes it the clean
-- probe: any lock observed afterwards was taken by the FOR UPDATE clauses and not by an UPDATE.
select is((pg_temp.set_status(pg_temp.fx('rel_lock'), 'ACTIVE'))[4], 'false',
  'lock: the probe call is a no-op — it writes nothing');
select ok(pg_temp.rel_locked(pg_temp.fx('rel_lock')),
  'lock: the relationship row is now row-locked by this transaction');
select is(pg_temp.rel_version(pg_temp.fx('rel_lock')), (select rel_v from lock_before),
  'lock: the relationship row was not rewritten to take its lock');
select is(pg_temp.org_version(pg_temp.fx('r_lock')), (select org_v from lock_before),
  'lock: nor was the organization row');

-- A relationship the caller may NOT address is never locked, because the tenant predicate is
-- part of the same statement that takes the lock.
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_foreign'), 'SUSPENDED')), '42501',
  'lock: a foreign relationship is refused');
select ok(not pg_temp.rel_locked(pg_temp.fx('rel_foreign')),
  'lock: and was never locked — the tenant predicate is IN the locking statement');

-- ---------------------------------------------------------------------------
-- The current pair must be one this function owns
-- ---------------------------------------------------------------------------
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mm_as'), 'SUSPENDED')), '55000',
  'pair: ACTIVE relationship + SUSPENDED organization is refused');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mm_as'), 'ACTIVE')), '55000',
  'pair: and refused in the other direction too');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mm_sa'), 'ACTIVE')), '55000',
  'pair: SUSPENDED relationship + ACTIVE organization is refused');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mm_sa'), 'SUSPENDED')), '55000',
  'pair: and refused in the other direction too');

-- INCONSISTENT STATE IS NOT REPAIRED. This is the point of the rule: quietly reconciling would
-- overwrite whatever the other writer intended and erase the only evidence it exists.
select is(pg_temp.rel_status(pg_temp.fx('rel_mm_as')), 'ACTIVE',
  'pair: the mismatched relationship is untouched...');
select is(pg_temp.org_status(pg_temp.fx('r_mm_as')), 'SUSPENDED',
  'pair: ...and so is the mismatched organization — nothing is silently reconciled');
select is(pg_temp.rel_status(pg_temp.fx('rel_mm_sa')), 'SUSPENDED',
  'pair: the second mismatch is untouched as well...');
select is(pg_temp.org_status(pg_temp.fx('r_mm_sa')), 'ACTIVE',
  'pair: ...in both of its rows');

-- DEACTIVATED on either row is terminal.
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_dr'), 'SUSPENDED')), '55000',
  'pair: a DEACTIVATED relationship cannot be suspended');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_dr'), 'ACTIVE')), '55000',
  'pair: nor reactivated — this function never clears the terminal state');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_do'), 'SUSPENDED')), '55000',
  'pair: a DEACTIVATED organization cannot be suspended');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_do'), 'ACTIVE')), '55000',
  'pair: nor reactivated');
select is(pg_temp.rel_status(pg_temp.fx('rel_dr')), 'DEACTIVATED',
  'pair: the DEACTIVATED relationship is exactly as it was');
select is(pg_temp.org_status(pg_temp.fx('r_do')), 'DEACTIVATED',
  'pair: and so is the DEACTIVATED organization');

-- ONE MESSAGE FOR EVERY 55000 CAUSE.
select is(pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_mm_as'), 'ACTIVE')),
  pg_temp.unavailable_msg(),
  'pair: the generic lifecycle-unavailable sentence');
select is(pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_dr'), 'ACTIVE')),
  pg_temp.unavailable_msg(),
  'pair: and the same one for a DEACTIVATED relationship');

-- ---------------------------------------------------------------------------
-- Atomicity: a failure AFTER the first UPDATE abandons it
-- ---------------------------------------------------------------------------
-- Every refusal the function raises of its own accord happens BEFORE either UPDATE, so a
-- refused call is trivially atomic — asserted throughout Sections D, G, H and above. What
-- THAT cannot prove is the other direction. Two temporary triggers supply the two failures
-- that reach it, and they are the only way to: the function has no post-UPDATE failure mode
-- of its own by design.

-- (1) THE SECOND UPDATE MATCHES NOTHING — the compare-and-set drift path. A BEFORE UPDATE
--     trigger that returns NULL suppresses the organizations write, so the row count is 0 and
--     the function must abort rather than commit a half-applied lifecycle change.
select is(pg_temp.rel_status(pg_temp.fx('rel_cas')), 'ACTIVE', 'cas: starts ACTIVE');

create temp table cas_before as
  select pg_temp.rel_version(pg_temp.fx('rel_cas')) as rel_v,
         pg_temp.org_version(pg_temp.fx('r_cas'))   as org_v;

create function pg_temp.swallow_org_update() returns trigger
language plpgsql as $$
begin
  return null;   -- suppress the row update; row_count becomes 0
end;
$$;

create trigger zz_swallow_org_update_for_test
  before update on public.organizations
  for each row execute function pg_temp.swallow_org_update();

select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_cas'), 'SUSPENDED')), '55000',
  'cas: when the organization UPDATE matches no row, the call fails with 55000');
select is(pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_cas'), 'SUSPENDED')),
  pg_temp.unavailable_msg(),
  'cas: with the generic lifecycle message — drift is NOT reported as an authorization denial');

drop trigger zz_swallow_org_update_for_test on public.organizations;

-- THE FIRST UPDATE WENT WITH IT. This is the assertion the sub-section exists for: the
-- relationship UPDATE had already executed successfully when the row-count check raised.
select is(pg_temp.rel_status(pg_temp.fx('rel_cas')), 'ACTIVE',
  'cas: the relationship is STILL ACTIVE — the first UPDATE was rolled back');
select is(pg_temp.org_status(pg_temp.fx('r_cas')), 'ACTIVE',
  'cas: and the organization never moved');
select is(pg_temp.rel_version(pg_temp.fx('rel_cas')), (select rel_v from cas_before),
  'cas: the relationship is physically the original tuple');
select is(pg_temp.org_version(pg_temp.fx('r_cas')), (select org_v from cas_before),
  'cas: and so is the organization');
select is(pg_temp.audit_count(pg_temp.fx('r_cas')), 0::bigint,
  'cas: no audit row survives — there is no half-applied state to describe');

-- (2) THE AUDIT INSERT FAILS — both status changes must go with it.
select is(pg_temp.rel_status(pg_temp.fx('rel_roll')), 'ACTIVE', 'roll: starts ACTIVE');

create temp table roll_before as
  select pg_temp.rel_version(pg_temp.fx('rel_roll')) as rel_v,
         pg_temp.org_version(pg_temp.fx('r_roll'))   as org_v;

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

select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_roll'), 'SUSPENDED')), 'P0001',
  'roll: with the audit insert blocked, the whole call fails');

drop trigger zz_block_audit_for_test on public.audit_logs;

select is(pg_temp.rel_status(pg_temp.fx('rel_roll')), 'ACTIVE',
  'roll: the relationship is STILL ACTIVE — both UPDATEs were rolled back with the audit write');
select is(pg_temp.org_status(pg_temp.fx('r_roll')), 'ACTIVE',
  'roll: and so is the organization');
select is(pg_temp.rel_version(pg_temp.fx('rel_roll')), (select rel_v from roll_before),
  'roll: the relationship is physically the original tuple');
select is(pg_temp.org_version(pg_temp.fx('r_roll')), (select org_v from roll_before),
  'roll: and so is the organization');
select is(pg_temp.audit_count(pg_temp.fx('r_roll')), 0::bigint,
  'roll: no audit row survives either');

-- The same call, with the injected failures gone, succeeds — proving the failures were the
-- triggers and not something else about the request.
select is((pg_temp.set_status(pg_temp.fx('rel_roll'), 'SUSPENDED'))[4], 'true',
  'roll: the identical call succeeds once the injected failure is removed');
select is(pg_temp.audit_count(pg_temp.fx('r_roll')), 1::bigint,
  'roll: and writes its one audit row');


-- ============================================================================
-- SECTION J — the multi-Vendor safety guard
-- ============================================================================
-- ⚠️ A STOPGAP, NOT AN ARCHITECTURE. organizations.status is ONE column shared by every Vendor
-- that manages a Retailer, so it cannot express "blocked by Vendor A but not by Vendor B".
-- Rather than let one Vendor act on a row another depends on, the operation refuses. These
-- tests pin that refusal, in both directions, and pin that it discloses nothing.

select pg_temp.act_as(pg_temp.fx('va_admin'));

-- Another ACTIVE Vendor relationship.
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mv_act'), 'SUSPENDED')), '55000',
  'guard: another ACTIVE Vendor relationship refuses the suspension');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mv_act'), 'ACTIVE')), '55000',
  'guard: and refuses a no-op-shaped request too — the guard runs before idempotency');

-- Another SUSPENDED Vendor relationship.
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mv_sus'), 'SUSPENDED')), '55000',
  'guard: another SUSPENDED Vendor relationship also refuses');

-- BOTH DIRECTIONS. A Retailer already suspended, with a live foreign relationship, cannot be
-- reactivated either.
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mv_re'), 'ACTIVE')), '55000',
  'guard: reactivation is refused just as suspension is');
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mv_re'), 'SUSPENDED')), '55000',
  'guard: the guard applies to every requested value, not only to the one that changes state');

-- A DEACTIVATED foreign relationship does NOT block. A relationship that has ENDED is retained
-- for history only, and must not freeze an ordinary single-Vendor Retailer forever.
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mv_dea'), 'SUSPENDED')), null,
  'guard: a DEACTIVATED foreign relationship does NOT block the transition');
select is(pg_temp.org_status(pg_temp.fx('r_mv_dea')), 'SUSPENDED',
  'guard: and the transition really happened');
select is((pg_temp.set_status(pg_temp.fx('rel_mv_dea'), 'ACTIVE'))[4], 'true',
  'guard: reactivation works there too');

-- NOTHING WAS WRITTEN WHERE THE GUARD FIRED.
select is(pg_temp.rel_status(pg_temp.fx('rel_mv_act')), 'ACTIVE',
  'guard: the blocked Retailer''s relationship is unchanged');
select is(pg_temp.org_status(pg_temp.fx('r_mv_act')), 'ACTIVE',
  'guard: and its organization is unchanged');
select is(pg_temp.rel_status(pg_temp.fx('rel_b_act')), 'ACTIVE',
  'guard: and the OTHER Vendor''s relationship was not touched either');
select is(pg_temp.audit_count(pg_temp.fx('r_mv_act')), 0::bigint,
  'guard: a refused call writes no audit row');

-- THE REFUSAL DISCLOSES NOTHING. It is the same sentence as an inconsistent pair, so a caller
-- cannot even tell that the reason is multi-Vendor — let alone which Vendor, how many, or what
-- state they are in.
select is(pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_mv_act'), 'SUSPENDED')),
  pg_temp.unavailable_msg(),
  'guard: the refusal is the generic lifecycle-unavailable sentence');
select is(
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_mv_act'), 'SUSPENDED')),
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_mm_as'), 'ACTIVE')),
  'guard: byte-identical to the inconsistent-pair refusal — the CAUSE is not disclosed');
select ok(
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_mv_act'), 'SUSPENDED'))
    !~ '[0-9a-f]{8}-[0-9a-f]{4}',
  'guard: no relationship id or Vendor id appears in the message');
select ok(
  pg_temp.message_of(pg_temp.set_sql(pg_temp.fx('rel_mv_act'), 'SUSPENDED')) !~* 'Vendor B|Multi Active|[0-9]',
  'guard: no Vendor name, Retailer name or count appears either');


-- ============================================================================
-- Downstream fixtures — the Retailer that has everything
-- ============================================================================
-- r_down carries one of each thing the milestone promised to preserve, and one of each caller
-- the suspension has to block. It is built ONCE, measured before, suspended, measured during,
-- reactivated, and measured after.

insert into pg_temp.fx (k, v) values
  ('m_d_owner', pg_temp.staff(pg_temp.fx('d_owner'),   pg_temp.fx('r_down'), 'RETAILER_OWNER')),
  ('m_d_mgr',   pg_temp.staff(pg_temp.fx('d_manager'), pg_temp.fx('r_down'), 'RETAILER_MANAGER')),
  ('m_d_sales', pg_temp.staff(pg_temp.fx('d_sales'),   pg_temp.fx('r_down'), 'SALES_STAFF'));

insert into pg_temp.fx (k, v) values
  ('shop_1', pg_temp.new_shop(pg_temp.fx('r_down'), 'Downtown')),
  ('shop_2', pg_temp.new_shop(pg_temp.fx('r_down'), 'Marina'));

insert into pg_temp.fx (k, v) values
  -- A LIVE assignment and a RETIRED one. Both must survive, and both must still be
  -- distinguishable afterwards.
  ('asg_live',    pg_temp.raw_assign(pg_temp.fx('m_d_sales'), pg_temp.fx('shop_1'), pg_temp.fx('d_owner'))),
  ('asg_retired', pg_temp.raw_assign(pg_temp.fx('m_d_sales'), pg_temp.fx('shop_2'), pg_temp.fx('d_owner'), true));

-- A submitted receipt — history that must survive untouched.
insert into public.receipt_submissions (
  retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
  storage_bucket, storage_object_path, original_file_name, mime_type,
  file_size_bytes, file_sha256, status, submitted_at
)
values (
  pg_temp.fx('r_down'), pg_temp.fx('shop_1'), pg_temp.fx('d_sales'),
  'receipts', 'seed/down/receipt.jpg', 'receipt.jpg', 'image/jpeg',
  2048, repeat('b', 64), 'SUBMITTED', now()
);

-- A PENDING, UNEXPIRED staff invitation for a RETAILER_MANAGER (no Shops, which is what that
-- role's gate requires). It must survive the suspension and be usable again afterwards.
insert into public.retailer_staff_invitations (
  retailer_organization_id, email, first_name, last_name, role_id,
  status, invited_by_profile_id, token_hash, expires_at, sent_at
)
select
  pg_temp.fx('r_down'), 'ivy.staffinvitee@test.invalid', 'Ivy', 'Staffinvitee', r.id,
  'PENDING', pg_temp.fx('d_owner'), repeat('c', 64),
  now() + interval '5 days', now() - interval '1 hour'
from public.roles r where r.code = 'RETAILER_MANAGER';

-- A PENDING, UNEXPIRED Retailer OWNER invitation, with its INVITED membership, exactly as the
-- Vendor-side invitation flow leaves one.
insert into pg_temp.fx (k, v) values
  ('m_inv_owner', pg_temp.staff(pg_temp.fx('inv_owner'), pg_temp.fx('r_down'), 'RETAILER_OWNER', 'INVITED'));

insert into public.retailer_invitations (
  vendor_organization_id, retailer_organization_id, email, first_name, last_name,
  role_id, status, auth_user_id, organization_member_id, invitation_kind,
  expires_at, sent_at
)
select
  pg_temp.fx('vendor_a'), pg_temp.fx('r_down'), 'ian.ownerinvitee@test.invalid',
  'Ian', 'Ownerinvitee', r.id, 'PENDING', pg_temp.fx('inv_owner'),
  pg_temp.fx('m_inv_owner'), 'NEW_USER',
  now() + interval '5 days', now() - interval '1 hour'
from public.roles r where r.code = 'RETAILER_OWNER';

-- TWO Vendor products, both assigned to this Retailer, with different jobs:
--   product_1 is PRESERVED — it is in the snapshot below and nothing may move it, which is
--             what proves an existing assignment survives and is effective again afterwards.
--   product_2 exists SOLELY to probe the unassignment contract while the Retailer is
--             suspended. It is deliberately EXCLUDED from the snapshot, because that probe is
--             a mutation performed by a DIFFERENT RPC and has nothing to say about what THIS
--             function preserves.
insert into public.vendor_products
  (vendor_organization_id, product_code, product_name, status, created_by_profile_id)
values
  (pg_temp.fx('vendor_a'), 'WIDGET-1', 'Widget',  'ACTIVE', pg_temp.fx('va_admin')),
  (pg_temp.fx('vendor_a'), 'WIDGET-2', 'Widget2', 'ACTIVE', pg_temp.fx('va_admin'));

insert into pg_temp.fx (k, v)
select 'product_1', p.id from public.vendor_products p where p.product_code = 'WIDGET-1';
insert into pg_temp.fx (k, v)
select 'product_2', p.id from public.vendor_products p where p.product_code = 'WIDGET-2';

insert into public.vendor_product_retailer_assignments
  (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id)
values
  (pg_temp.fx('product_1'), pg_temp.fx('r_down'), 'ACTIVE', pg_temp.fx('va_admin')),
  (pg_temp.fx('product_2'), pg_temp.fx('r_down'), 'ACTIVE', pg_temp.fx('va_admin'));

-- ---------------------------------------------------------------------------
-- Observations of the things that must not move
-- ---------------------------------------------------------------------------
create function pg_temp.down_snapshot() returns text
language sql stable as $$
  select
    -- memberships: id, status and deactivated_at, ordered by id so the string is stable
    (select coalesce(string_agg(m.id::text || ':' || m.status || ':' ||
                                coalesce(m.deactivated_at::text, '-'), '|' order by m.id::text), '')
       from public.organization_members m where m.organization_id = pg_temp.fx('r_down'))
    || '#' ||
    -- roles held, by membership
    (select coalesce(string_agg(mr.organization_member_id::text || ':' || r.code, '|'
                                order by mr.organization_member_id::text, r.code), '')
       from public.member_roles mr
       join public.roles r on r.id = mr.role_id
       join public.organization_members m on m.id = mr.organization_member_id
      where m.organization_id = pg_temp.fx('r_down'))
    || '#' ||
    -- shops
    (select coalesce(string_agg(s.id::text || ':' || s.name || ':' || s.status, '|' order by s.id::text), '')
       from public.retailer_shops s where s.retailer_organization_id = pg_temp.fx('r_down'))
    || '#' ||
    -- shop assignments, live and retired, by primary key
    (select coalesce(string_agg(sm.id::text || ':' || coalesce(sm.removed_at::text, 'LIVE'), '|'
                                order by sm.id::text), '')
       from public.retailer_shop_members sm
       join public.organization_members m on m.id = sm.organization_member_id
      where m.organization_id = pg_temp.fx('r_down'))
    || '#' ||
    -- product assignments (product_1 only — see the fixture note above)
    (select coalesce(string_agg(a.id::text || ':' || a.status, '|' order by a.id::text), '')
       from public.vendor_product_retailer_assignments a
      where a.retailer_organization_id = pg_temp.fx('r_down')
        and a.vendor_product_id = pg_temp.fx('product_1'))
    || '#' ||
    -- receipts
    (select coalesce(string_agg(rs.id::text || ':' || rs.status, '|' order by rs.id::text), '')
       from public.receipt_submissions rs where rs.retailer_organization_id = pg_temp.fx('r_down'))
    || '#' ||
    -- staff invitations
    (select coalesce(string_agg(i.id::text || ':' || i.status || ':' || i.token_hash, '|' order by i.id::text), '')
       from public.retailer_staff_invitations i where i.retailer_organization_id = pg_temp.fx('r_down'))
    || '#' ||
    -- owner invitations
    (select coalesce(string_agg(ri.id::text || ':' || ri.status, '|' order by ri.id::text), '')
       from public.retailer_invitations ri where ri.retailer_organization_id = pg_temp.fx('r_down'))
    || '#' ||
    -- profiles of the Retailer's people
    (select coalesce(string_agg(p.id::text || ':' || p.status, '|' order by p.id::text), '')
       from public.profiles p
      where p.id in (pg_temp.fx('d_owner'), pg_temp.fx('d_manager'), pg_temp.fx('d_sales'),
                     pg_temp.fx('inv_owner'), pg_temp.fx('inv_staff')))
    || '#' ||
    -- auth identities of the same people
    (select coalesce(string_agg(u.id::text || ':' || u.email || ':' ||
                                coalesce(u.email_confirmed_at::text, '-') || ':' ||
                                coalesce(u.banned_until::text, '-') || ':' ||
                                coalesce(u.deleted_at::text, '-'), '|' order by u.id::text), '')
       from auth.users u
      where u.id in (pg_temp.fx('d_owner'), pg_temp.fx('d_manager'), pg_temp.fx('d_sales'),
                     pg_temp.fx('inv_owner'), pg_temp.fx('inv_staff')));
$$;

/* Audit rows that already existed anywhere for this Retailer's people and tenant, so Section L
 * can prove HISTORY is preserved rather than merely that no new row appeared. */
create function pg_temp.down_audit_history() returns bigint
language sql stable as $$
  select count(*) from public.audit_logs a
  where a.organization_id = pg_temp.fx('r_down');
$$;

-- A pre-existing Retailer-side audit row, so "history is preserved" has something to preserve.
insert into public.audit_logs (organization_id, actor_profile_id, action, entity_type, entity_id, metadata)
values (pg_temp.fx('r_down'), pg_temp.fx('d_owner'), 'STAFF_MEMBERSHIP_REACTIVATED',
        'RETAILER_STAFF_MEMBER', pg_temp.fx('m_d_sales')::text, '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- Everything works BEFORE the suspension. Without this, every "blocked" assertion
-- below would be satisfied by a fixture that never worked in the first place.
-- ---------------------------------------------------------------------------
select pg_temp.act_as(pg_temp.fx('d_owner'));
select is((public.get_my_portal_context() -> 'retailer' ->> 'kind'), 'RETAILER_OWNER',
  'before: the Owner has a RETAILER_OWNER portal context');
select is(pg_temp.sqlstate_of('select * from public.list_retailer_staff_members()'), null,
  'before: the Owner can read the staff roster');
select is((select s.access_state from public.get_my_lifecycle_access_state() s), 'ACTIVE',
  'before: the Owner''s lifecycle diagnostic says ACTIVE');

select pg_temp.act_as(pg_temp.fx('d_manager'));
select is(pg_temp.sqlstate_of('select * from public.list_retailer_staff_members()'), null,
  'before: the Manager can read the staff roster');

select pg_temp.act_as(pg_temp.fx('d_sales'));
select is(pg_temp.sqlstate_of('select * from public.list_my_assigned_receipt_shops()'), null,
  'before: Sales Staff can list their receipt Shops');
select is(
  (select count(*) from public.list_my_assigned_receipt_shops()), 1::bigint,
  'before: and there is exactly one — the live assignment');

select is(pg_temp.sqlstate_of(format(
  'select public.retailer_staff_invitation_gate(%L)', repeat('c', 64))), null,
  'before: the pending staff invitation passes its gate');

select pg_temp.act_as(pg_temp.fx('va_admin'));
select is(pg_temp.sqlstate_of(format(
  'select public.add_vendor_retailer_shop(%L::uuid, ''Probe Shop A'')', pg_temp.fx('rel_down'))), null,
  'before: the Vendor can add a Shop');

-- THE BASELINE, taken AFTER the probes above, so it describes the Retailer exactly as it is
-- on the instant before the suspension. Everything Sections L and M compare against is this.
create temp table down_before as
  select pg_temp.down_snapshot() as snap, pg_temp.down_audit_history() as audits;


-- ============================================================================
-- SECTION K — the suspension blocks everything downstream
-- ============================================================================
-- THE CALLERS BELOW NEVER RE-AUTHENTICATE. Their `request.jwt.claims` GUC is the one they held
-- before the suspension, so every refusal here is a refusal of an ALREADY-ISSUED SESSION on its
-- very next request. Nothing was signed out and nothing expired.

select pg_temp.act_as(pg_temp.fx('va_admin'));
select is((pg_temp.set_status(pg_temp.fx('rel_down'), 'SUSPENDED'))[4], 'true',
  'down: the Vendor suspends the Retailer');
select is(pg_temp.org_status(pg_temp.fx('r_down')), 'SUSPENDED',
  'down: the organization row is SUSPENDED');
select is(pg_temp.rel_status(pg_temp.fx('rel_down')), 'SUSPENDED',
  'down: and so is the relationship row');

-- Retailer Owner.
select pg_temp.act_as(pg_temp.fx('d_owner'));
select is((public.get_my_portal_context() ->> 'portal_kind'), 'NONE',
  'down: the Owner''s portal context collapses to NONE');
select ok((public.get_my_portal_context() -> 'retailer') = 'null'::jsonb,
  'down: with no Retailer block at all');
select is(pg_temp.sqlstate_of('select * from public.list_retailer_staff_members()'), '42501',
  'down: the Owner can no longer read the staff roster');
select is((select count(*) from public.list_retailer_owner_portal_shops()), 0::bigint,
  'down: nor list the Retailer''s Shops');
select is((select s.access_state from public.get_my_lifecycle_access_state() s),
  'ORGANIZATION_INACTIVE',
  'down: and the EXISTING diagnostic already explains why — ORGANIZATION_INACTIVE');

-- Retailer Manager.
select pg_temp.act_as(pg_temp.fx('d_manager'));
select is(pg_temp.sqlstate_of('select * from public.list_retailer_staff_members()'), '42501',
  'down: the Manager is blocked');
select is((select s.access_state from public.get_my_lifecycle_access_state() s),
  'ORGANIZATION_INACTIVE', 'down: with the same explanation');

-- Sales Staff — including the receipt path, which is the one an Edge Function fronts.
select pg_temp.act_as(pg_temp.fx('d_sales'));
select is(pg_temp.sqlstate_of('select * from public.list_my_assigned_receipt_shops()'), '42501',
  'down: Sales Staff can no longer list receipt Shops');
select is(
  pg_temp.sqlstate_of(format(
    'select * from public.reserve_receipt_submission(%L::uuid, ''r.jpg'', ''image/jpeg'', 1024, %L)',
    pg_temp.fx('shop_1'), repeat('d', 64))),
  '42501', 'down: and cannot reserve a receipt submission');
select is((select s.access_state from public.get_my_lifecycle_access_state() s),
  'ORGANIZATION_INACTIVE', 'down: same explanation for Sales Staff');
select is(pg_temp.sqlstate_of('select * from public.list_my_receipt_submissions()'), '42501',
  'down: their own receipt history is no longer readable to them either');

-- Staff invitations — reserving a new one, and accepting the pending one.
select pg_temp.act_as(pg_temp.fx('d_owner'));
select is(
  pg_temp.sqlstate_of(
    'select * from public.reserve_retailer_staff_invitation(''new.hire@test.invalid'', ''New'', ''Hire'', ''RETAILER_MANAGER'', ''{}''::uuid[])'),
  '42501', 'down: the Owner cannot reserve a new staff invitation');
select is(pg_temp.sqlstate_of(format(
  'select public.retailer_staff_invitation_gate(%L)', repeat('c', 64))), '23514',
  'down: the pending staff invitation no longer passes its gate');
select pg_temp.act_as(pg_temp.fx('inv_staff'));
select is(pg_temp.sqlstate_of(format(
  'select public.accept_retailer_staff_invitation(%L)', repeat('c', 64))), '42501',
  'down: and it cannot be accepted');

-- Retailer OWNER invitations — sending and accepting.
select pg_temp.act_as(pg_temp.fx('va_admin'));
select is(
  pg_temp.sqlstate_of(format(
    'select * from public.reserve_retailer_owner_invitation(%L::uuid, ''second.owner@test.invalid'', ''Sec'', ''Owner'')',
    pg_temp.fx('rel_down'))),
  '55000', 'down: the Vendor cannot send or resend a Retailer Owner invitation');
select pg_temp.act_as(pg_temp.fx('inv_owner'));
select is(pg_temp.sqlstate_of('select public.accept_retailer_owner_invitation()'), '42501',
  'down: and the pending Owner invitation cannot be accepted');

-- Vendor-side building-out is blocked too — a Vendor must not keep growing a Retailer it has
-- just switched off.
select pg_temp.act_as(pg_temp.fx('va_admin'));
select is(pg_temp.sqlstate_of(format(
  'select public.add_vendor_retailer_shop(%L::uuid, ''Probe Shop B'')', pg_temp.fx('rel_down'))),
  '23514', 'down: the Vendor cannot add a Shop');
select is(pg_temp.sqlstate_of(format(
  'select public.assign_vendor_product_to_retailer(%L::uuid, %L::uuid)',
  pg_temp.fx('product_1'), pg_temp.fx('r_down'))),
  '42501', 'down: nor assign a product');

-- UNASSIGNMENT IS DELIBERATELY STILL PERMITTED, and this test records that as a contract
-- rather than an oversight. unassign_vendor_product_from_retailer requires the relationship to
-- EXIST but explicitly not to be ACTIVE ("The relationship must exist ... but it need not be
-- ACTIVE"), because withdrawing something is a de-escalation. This milestone did not change
-- that contract, and this asserts it did not.
select is(pg_temp.sqlstate_of(format(
  'select public.unassign_vendor_product_from_retailer(%L::uuid, %L::uuid)',
  pg_temp.fx('product_2'), pg_temp.fx('r_down'))),
  null, 'down: product UNassignment is still permitted — its contract never required ACTIVE');
select is(
  (select a.status from public.vendor_product_retailer_assignments a
    where a.vendor_product_id = pg_temp.fx('product_2')
      and a.retailer_organization_id = pg_temp.fx('r_down')),
  'INACTIVE', 'down: and it really withdrew the assignment');
select is(
  (select a.status from public.vendor_product_retailer_assignments a
    where a.vendor_product_id = pg_temp.fx('product_1')
      and a.retailer_organization_id = pg_temp.fx('r_down')),
  'ACTIVE', 'down: while the OTHER assignment — the preserved one — was not touched');


-- ============================================================================
-- SECTION L — preservation: nothing was cascaded, and nothing was deleted
-- ============================================================================
-- One snapshot string compares every preserved row, by PRIMARY KEY, before and during. A
-- cascade into organization_members, a cleared role, a deleted Shop assignment, a revoked
-- invitation or a touched auth.users row would all move it.

select is(pg_temp.down_snapshot(), (select snap from down_before),
  'preserve: memberships, roles, Shops, live AND retired Shop assignments, product assignments, receipts, both invitation tables, profiles and auth.users are byte-identical');

-- The same facts, stated individually, so a failure above says WHICH.
select is(
  (select array_agg(m.status order by m.status)
   from public.organization_members m where m.organization_id = pg_temp.fx('r_down')),
  array['ACTIVE', 'ACTIVE', 'ACTIVE', 'INVITED'],
  'preserve: organization_members statuses are unchanged — SUSPENDED was NOT cascaded');
select is(
  (select count(*) from public.organization_members m
    where m.organization_id = pg_temp.fx('r_down') and m.deactivated_at is not null),
  0::bigint, 'preserve: no membership was marked deactivated');
select is(
  (select array_agg(r.code order by r.code)
   from public.member_roles mr
   join public.roles r on r.id = mr.role_id
   join public.organization_members m on m.id = mr.organization_member_id
   where m.organization_id = pg_temp.fx('r_down')),
  array['RETAILER_MANAGER', 'RETAILER_OWNER', 'RETAILER_OWNER', 'SALES_STAFF'],
  'preserve: every role assignment survives');
select is(
  (select count(*) from public.retailer_shops s
    where s.retailer_organization_id = pg_temp.fx('r_down') and s.status = 'ACTIVE'),
  3::bigint, 'preserve: the Shops survive, ACTIVE (two fixtures plus the pre-suspension probe)');
select is(
  (select count(*) from public.retailer_shop_members sm
   join public.organization_members m on m.id = sm.organization_member_id
   where m.organization_id = pg_temp.fx('r_down') and sm.removed_at is null),
  1::bigint, 'preserve: the LIVE Shop assignment is still live');
select is(
  (select count(*) from public.retailer_shop_members sm
   join public.organization_members m on m.id = sm.organization_member_id
   where m.organization_id = pg_temp.fx('r_down') and sm.removed_at is not null),
  1::bigint, 'preserve: and the RETIRED one is still retired — neither was rewritten');
select is(
  (select count(*) from public.receipt_submissions rs
    where rs.retailer_organization_id = pg_temp.fx('r_down')),
  1::bigint, 'preserve: the receipt history survives');
select is(
  (select array_agg(i.status) from public.retailer_staff_invitations i
    where i.retailer_organization_id = pg_temp.fx('r_down')),
  array['PENDING'], 'preserve: the staff invitation is still PENDING — not revoked, not expired');
select is(
  (select array_agg(ri.status) from public.retailer_invitations ri
    where ri.retailer_organization_id = pg_temp.fx('r_down')),
  array['PENDING'], 'preserve: and so is the Retailer Owner invitation');
select is(
  (select array_agg(p.status order by p.id::text) from public.profiles p
    where p.id in (pg_temp.fx('d_owner'), pg_temp.fx('d_manager'), pg_temp.fx('d_sales'))),
  array['ACTIVE', 'ACTIVE', 'ACTIVE'],
  'preserve: profiles are untouched — a person is not their employer');

-- auth.users: not banned, not deleted, not re-confirmed, still there.
select is(
  (select count(*) from auth.users u
    where u.id in (pg_temp.fx('d_owner'), pg_temp.fx('d_manager'), pg_temp.fx('d_sales'))
      and u.banned_until is null and u.deleted_at is null and u.email_confirmed_at is not null),
  3::bigint,
  'preserve: every auth.users row is present, unbanned, undeleted and still confirmed');

-- Audit HISTORY is preserved. The pre-existing Retailer-side row is still there, and the
-- Vendor-side lifecycle row landed in the VENDOR's feed, not the Retailer's.
select is(pg_temp.down_audit_history(), (select audits from down_before),
  'preserve: the Retailer''s own audit history is unchanged — the lifecycle event is the Vendor''s');
select is(
  (select count(*) from public.audit_logs a
    where a.organization_id = pg_temp.fx('r_down') and a.action = 'STAFF_MEMBERSHIP_REACTIVATED'),
  1::bigint, 'preserve: including the pre-existing staff-lifecycle entry');


-- ============================================================================
-- SECTION M — reactivation restores everything, without rebuilding anything
-- ============================================================================
create temp table down_during as
  select pg_temp.down_snapshot() as snap;

select pg_temp.act_as(pg_temp.fx('va_admin'));
select is((pg_temp.set_status(pg_temp.fx('rel_down'), 'ACTIVE'))[4], 'true',
  'back: the Vendor reactivates the Retailer');
select is(pg_temp.org_status(pg_temp.fx('r_down')), 'ACTIVE', 'back: the organization is ACTIVE');
select is(pg_temp.rel_status(pg_temp.fx('rel_down')), 'ACTIVE', 'back: and so is the relationship');

-- NOTHING WAS RECREATED. The snapshot compares primary keys, so a membership, role or Shop
-- assignment that had been deleted and re-inserted would show as a different id here even
-- though the counts matched.
select is(pg_temp.down_snapshot(), (select snap from down_during),
  'back: every preserved row is the SAME ROW — reactivation is a one-word write, not a rebuild');
select is(pg_temp.down_snapshot(), (select snap from down_before),
  'back: and identical to the pre-suspension state');

-- Access returns, through the preserved rows.
select pg_temp.act_as(pg_temp.fx('d_owner'));
select is((public.get_my_portal_context() -> 'retailer' ->> 'kind'), 'RETAILER_OWNER',
  'back: the Owner has their portal context again');
select is(pg_temp.sqlstate_of('select * from public.list_retailer_staff_members()'), null,
  'back: and can read the roster');
select is((select s.access_state from public.get_my_lifecycle_access_state() s), 'ACTIVE',
  'back: the diagnostic says ACTIVE again');

select pg_temp.act_as(pg_temp.fx('d_manager'));
select is(pg_temp.sqlstate_of('select * from public.list_retailer_staff_members()'), null,
  'back: the Manager''s access returns');

select pg_temp.act_as(pg_temp.fx('d_sales'));
select is(pg_temp.sqlstate_of('select * from public.list_my_assigned_receipt_shops()'), null,
  'back: Sales Staff can list their Shops again');
select is((select count(*) from public.list_my_assigned_receipt_shops()), 1::bigint,
  'back: exactly the one they had — the RETIRED assignment did not come back to life');
select is(
  (select sm.retailer_shop_id from public.retailer_shop_members sm where sm.id = pg_temp.fx('asg_live')),
  pg_temp.fx('shop_1'),
  'back: and it is the SAME assignment row, by primary key');
select is(pg_temp.sqlstate_of(format(
  'select * from public.reserve_receipt_submission(%L::uuid, ''r.jpg'', ''image/jpeg'', 1024, %L)',
  pg_temp.fx('shop_1'), repeat('e', 64))), null,
  'back: receipt eligibility returns');

-- The pending invitations are usable again, because nothing revoked or expired them.
select is(pg_temp.sqlstate_of(format(
  'select public.retailer_staff_invitation_gate(%L)', repeat('c', 64))), null,
  'back: the still-valid staff invitation passes its gate again');
select pg_temp.act_as(pg_temp.fx('inv_staff'));
select is(pg_temp.sqlstate_of(format(
  'select public.accept_retailer_staff_invitation(%L)', repeat('c', 64))), null,
  'back: and can be accepted');
select pg_temp.act_as(pg_temp.fx('inv_owner'));
select is(pg_temp.sqlstate_of('select public.accept_retailer_owner_invitation()'), null,
  'back: the pending Retailer Owner invitation can be accepted too');

-- Vendor-side building-out works again, through the preserved relationship.
select pg_temp.act_as(pg_temp.fx('va_admin'));
select is(pg_temp.sqlstate_of(format(
  'select public.add_vendor_retailer_shop(%L::uuid, ''Probe Shop C'')', pg_temp.fx('rel_down'))),
  null, 'back: the Vendor can add Shops again');
select is(
  (select a.status from public.vendor_product_retailer_assignments a
    where a.vendor_product_id = pg_temp.fx('product_1')
      and a.retailer_organization_id = pg_temp.fx('r_down')),
  'ACTIVE', 'back: the existing product assignment is effective again, unchanged');


-- ============================================================================
-- SECTION N — audit
-- ============================================================================
-- Measured on a Retailer of its own, so the counts are exact.
select pg_temp.act_as(pg_temp.fx('va_admin'));

select is(pg_temp.audit_count(pg_temp.fx('r_guard')), 0::bigint, 'audit: starts with none');

select is((pg_temp.set_status(pg_temp.fx('rel_guard'), 'SUSPENDED'))[4], 'true',
  'audit: one real suspension');
select is(pg_temp.audit_count(pg_temp.fx('r_guard')), 1::bigint,
  'audit: EXACTLY ONE row per real suspension');
select is((pg_temp.last_audit(pg_temp.fx('r_guard'))).action, 'RETAILER_DEACTIVATED',
  'audit: the action is RETAILER_DEACTIVATED — the product''s word, not the column''s');
select is((pg_temp.last_audit(pg_temp.fx('r_guard'))).entity_type, 'RETAILER_ORGANIZATION',
  'audit: entity_type is RETAILER_ORGANIZATION');
select is((pg_temp.last_audit(pg_temp.fx('r_guard'))).entity_id, pg_temp.fx('r_guard')::text,
  'audit: entity_id is the RETAILER ORGANIZATION id — the thing whose lifecycle changed');
select is((pg_temp.last_audit(pg_temp.fx('r_guard'))).organization_id, pg_temp.fx('vendor_a'),
  'audit: organization_id is the ACTING VENDOR — the entry lands in the Vendor''s feed');
select is((pg_temp.last_audit(pg_temp.fx('r_guard'))).actor_profile_id, pg_temp.fx('va_admin'),
  'audit: the actor is derived from auth.uid()');

-- METADATA: exactly the six approved keys, and nothing else.
select is(
  (select array_agg(k order by k)
   from jsonb_object_keys((pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata) k),
  array['relationship_id', 'relationship_status_after', 'relationship_status_before',
        'retailer_name', 'retailer_status_after', 'retailer_status_before'],
  'audit: metadata carries EXACTLY the six approved keys');
select is(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata ->> 'retailer_status_before', 'ACTIVE',
  'audit: retailer_status_before is the value read under the lock');
select is(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata ->> 'retailer_status_after', 'SUSPENDED',
  'audit: retailer_status_after is the validated request');
select is(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata ->> 'relationship_status_before', 'ACTIVE',
  'audit: relationship_status_before likewise');
select is(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata ->> 'relationship_status_after', 'SUSPENDED',
  'audit: relationship_status_after likewise');
select is(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata ->> 'relationship_id',
  pg_temp.fx('rel_guard')::text,
  'audit: the relationship id is the PROVED one');
select is(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata ->> 'retailer_name', 'Guarded Retail',
  'audit: the Retailer name is the one read from the locked row');

-- NOTHING SENSITIVE IS IN THERE.
select ok(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata::text !~ '@',
  'audit: no email address anywhere in metadata');
select ok(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata::text !~ pg_temp.fx('va_admin')::text,
  'audit: the actor''s profile / Auth id is NOT duplicated into metadata');
select ok(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata::text !~ pg_temp.fx('vendor_b')::text
  and (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata::text !~ pg_temp.fx('vendor_a')::text,
  'audit: no Vendor id — the acting Vendor is organization_id, and no other Vendor appears');
select ok(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata::text !~* 'token|hash|password|secret|invitation|receipt|shop|product',
  'audit: no token, hash, invitation, receipt, Shop or product value');

-- The other direction.
select is((pg_temp.set_status(pg_temp.fx('rel_guard'), 'ACTIVE'))[4], 'true',
  'audit: one real reactivation');
select is(pg_temp.audit_count(pg_temp.fx('r_guard')), 2::bigint,
  'audit: EXACTLY ONE row per real reactivation');
select is((pg_temp.last_audit(pg_temp.fx('r_guard'))).action, 'RETAILER_REACTIVATED',
  'audit: the action is RETAILER_REACTIVATED');
select is(
  (pg_temp.last_audit(pg_temp.fx('r_guard'))).metadata ->> 'retailer_status_before', 'SUSPENDED',
  'audit: and the before/after pair reads the other way round');

-- A refused call writes nothing at all.
select is(pg_temp.sqlstate_of(pg_temp.set_sql(pg_temp.fx('rel_mv_act'), 'SUSPENDED')), '55000',
  'audit: a refused call');
select is(pg_temp.audit_count(pg_temp.fx('r_mv_act')), 0::bigint,
  'audit: writes no audit row');


-- ============================================================================
-- SECTION O — direct table access stays denied
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
    'update public.organizations set status = ''SUSPENDED'' where id = %L::uuid',
    pg_temp.fx('r_guard'))),
  '42501', 'authenticated cannot UPDATE organizations directly');

select is(
  pg_temp.sqlstate_of(format(
    'update public.vendor_retailers set status = ''SUSPENDED'' where id = %L::uuid',
    pg_temp.fx('rel_guard'))),
  '42501', 'authenticated cannot UPDATE vendor_retailers directly');

select is(
  pg_temp.sqlstate_of(format(
    'delete from public.vendor_retailers where id = %L::uuid', pg_temp.fx('rel_guard'))),
  '42501', 'authenticated cannot DELETE a relationship');

select is(
  pg_temp.sqlstate_of(format(
    'delete from public.organizations where id = %L::uuid', pg_temp.fx('r_guard'))),
  '42501', 'authenticated cannot DELETE an organization');

select is(
  pg_temp.sqlstate_of(
    'insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id) values (gen_random_uuid(), gen_random_uuid())'),
  '42501', 'nor INSERT a relationship');

-- The membership tables the milestone promised not to cascade into are likewise unreachable.
select is(
  pg_temp.sqlstate_of(format(
    'update public.organization_members set status = ''DEACTIVATED'' where organization_id = %L::uuid',
    pg_temp.fx('r_down'))),
  '42501', 'authenticated cannot cascade a status into organization_members by hand either');

reset role;

select is(pg_temp.org_status(pg_temp.fx('r_guard')), 'ACTIVE',
  'and none of those direct attempts changed a row');
select is(pg_temp.rel_status(pg_temp.fx('rel_guard')), 'ACTIVE',
  'in either table');

-- NO BROWSER-WRITE RLS POLICY WAS ADDED. Both tables keep read-only policies and nothing else,
-- so there is no path by which a future grant could become a write.
select is(
  (select count(*) from pg_policies
   where schemaname = 'public'
     and tablename in ('organizations', 'vendor_retailers')
     and cmd <> 'SELECT'),
  0::bigint,
  'no INSERT, UPDATE, DELETE or ALL policy exists on organizations or vendor_retailers');

select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('organizations', 'vendor_retailers')
     and grantee in ('authenticated', 'anon')
     and privilege_type in ('INSERT', 'UPDATE', 'DELETE')),
  0::bigint,
  'neither browser role holds INSERT, UPDATE or DELETE on either table');

-- Reads stay open, deliberately: a Vendor must be able to SEE an inactive Retailer in order to
-- reactivate it. This is what makes the operation reversible from the UI that will be built.
select pg_temp.act_as(pg_temp.fx('va_admin'));
select is((pg_temp.set_status(pg_temp.fx('rel_guard'), 'SUSPENDED'))[4], 'true',
  'reads: suspend the Retailer again');
select is(
  (select count(*) from public.list_vendor_retailers() lr
    where lr.retailer_organization_id = pg_temp.fx('r_guard')),
  1::bigint,
  'reads: a SUSPENDED Retailer is STILL listed to its Vendor — otherwise it could never be reactivated');
select is(
  (select lr.retailer_status from public.list_vendor_retailers() lr
    where lr.retailer_organization_id = pg_temp.fx('r_guard')),
  'SUSPENDED', 'reads: and its status is reported honestly');
select is((pg_temp.set_status(pg_temp.fx('rel_guard'), 'ACTIVE'))[4], 'true',
  'reads: and it can be reactivated from exactly that listing');


-- ============================================================================
-- SECTION P — the existing contracts were not changed
-- ============================================================================
-- This milestone is additive. The two functions a client already depends on for routing and
-- for explaining a refusal must be exactly what their own migrations left.
select is(
  (select array_agg(p.proname::text order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('get_my_portal_context', 'get_my_lifecycle_access_state')),
  array['get_my_lifecycle_access_state', 'get_my_portal_context'],
  'both existing context functions still exist');

select pg_temp.act_as(pg_temp.fx('va_admin'));
select is((public.get_my_portal_context() ->> 'context_version'), '1',
  'get_my_portal_context() still reports context_version 1');
select is((public.get_my_portal_context() ->> 'portal_kind'), 'VENDOR_SUPER_ADMIN',
  'and still routes a Vendor Super Admin to the Vendor portal');

select is((select s.access_state from public.get_my_lifecycle_access_state() s),
  'NO_SUPPORTED_ACCESS',
  'get_my_lifecycle_access_state() still answers for the CALLER — a Vendor-only user has no supported Retailer context');
select pg_temp.act_as(pg_temp.fx('d_owner'));
select is((select s.access_state from public.get_my_lifecycle_access_state() s), 'ACTIVE',
  'and still says ACTIVE for a Retailer Owner whose Retailer is active');

select is(pg_temp.out_args('get_my_lifecycle_access_state'), array['access_state'],
  'and still returns exactly one column named access_state');

-- The STAFF lifecycle contract is untouched by this milestone.
select is(pg_temp.input_args('set_retailer_staff_membership_status'),
  array['p_membership_id', 'p_status'],
  'the Retailer STAFF lifecycle write keeps its signature');
select is(pg_temp.out_args('set_retailer_staff_membership_status'),
  array['membership_id', 'membership_status', 'role_code', 'status_changed'],
  'and its return shape');

select * from finish();

rollback;
