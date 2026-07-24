-- pgTAP behavioural tests for the three Vendor Retailer reads added by
-- migration 20260731090000_mobile_vendor_retailer_reads.sql:
--
--   public.list_vendor_retailers()
--   public.get_vendor_retailer_detail(uuid)
--   public.list_vendor_retailer_shops(uuid)
--
-- and for the internal derivation they share:
--
--   public.vendor_retailer_owner_state(uuid)   [must NOT be callable by a browser role]
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as
-- the `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as
-- far as every authorization helper in this schema is concerned. pg_temp.act_as() does
-- exactly that and pg_temp.sign_out() clears it. This mirrors portal_context_test.sql and
-- sales_staff_receipt_reads_test.sql exactly, deliberately: three different impersonation
-- idioms in one suite directory would be three different claims about what "signed in"
-- means.
--
-- The tests deliberately do NOT `set role authenticated`. All four functions are SECURITY
-- DEFINER, so their behaviour depends on auth.uid() and not on the session role, and
-- switching roles mid-transaction would only make the fixture inserts fail. EXECUTE
-- privilege is a separate concern and is asserted directly against the catalogue in
-- Section A, which is a stronger check than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back, so no fixture survives.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file
-- turns an added test into a confusing failure about arithmetic rather than about
-- behaviour.
--
-- ============================================================================
-- WHAT "DENIED" MEANS HERE, AND WHY THE TWO KINDS DIFFER
-- ============================================================================
-- All three functions RAISE 42501 for a caller who is not an authorized Vendor Super
-- Admin. A denial and "this Vendor manages no Retailers" are different facts.
--
-- The two addressed functions additionally return ZERO ROWS — never a raise — for an
-- authorized Vendor who names a relationship that is not theirs. That distinction is the
-- security property: a distinguishable refusal would confirm that another Vendor's
-- relationship exists. Section H proves an unknown id, a foreign id, and null are
-- byte-identical.

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

/* Creates an auth user + a profile of the given status, and returns the id. */
create function pg_temp.new_user(p_label text, p_status text default 'ACTIVE')
returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_label || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_label, 'Tester', p_status);
  return v_id;
end;
$$;

/* Grants p_user a role in p_org through a membership of the given status. */
create function pg_temp.grant_role(
  p_user uuid,
  p_org uuid,
  p_role_code text,
  p_membership_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status)
  values (p_org, p_user, p_membership_status)
  on conflict (organization_id, user_id) do update set status = excluded.status
  returning id into v_member;

  insert into public.member_roles (organization_member_id, role_id)
  select v_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;

  return v_member;
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

/* Links a vendor to a retailer and returns the relationship id. */
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

create function pg_temp.new_shop(
  p_retailer uuid,
  p_name text,
  p_status text default 'ACTIVE',
  p_code text default null,
  p_city text default null
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.retailer_shops (retailer_organization_id, name, code, city, country_code, status)
  values (p_retailer, p_name, p_code, p_city, 'AE', p_status)
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
 * The SQLSTATE raised when the current caller runs p_sql, or NULL if it returned
 * normally. Sequenced in plpgsql on purpose: throws_ok() cannot express the
 * "zero rows here, raise there" comparisons Section H needs, and comparing SQLSTATEs is
 * what makes "these two denials are indistinguishable" a testable claim rather than a
 * comment.
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
 * The Retailer names visible to the current caller, IN THE FUNCTION'S OWN ORDER.
 *
 * row_number() over () numbers rows in the order they arrive from the function, and the
 * aggregate then sorts by that number — so this captures what the function emitted rather
 * than re-sorting it. Aggregating without an ORDER BY would test nothing about ordering,
 * and aggregating `order by retailer_name` would sort the evidence into agreement with the
 * assertion.
 */
create function pg_temp.my_retailer_names() returns text[]
language sql as $$
  select coalesce(array_agg(t.retailer_name order by t.ord), '{}'::text[])
  from (
    select l.retailer_name, row_number() over () as ord
    from public.list_vendor_retailers() l
  ) t;
$$;

/* One scalar column of the list, keyed by Retailer name. */
create function pg_temp.list_shop_count(p_name text) returns integer
language sql as $$
  select l.shop_count from public.list_vendor_retailers() l where l.retailer_name = p_name;
$$;

create function pg_temp.list_active_shop_count(p_name text) returns integer
language sql as $$
  select l.active_shop_count from public.list_vendor_retailers() l where l.retailer_name = p_name;
$$;

create function pg_temp.list_relationship_status(p_name text) returns text
language sql as $$
  select l.relationship_status from public.list_vendor_retailers() l where l.retailer_name = p_name;
$$;

create function pg_temp.list_retailer_status(p_name text) returns text
language sql as $$
  select l.retailer_status from public.list_vendor_retailers() l where l.retailer_name = p_name;
$$;

create function pg_temp.list_owner_state(p_name text) returns text
language sql as $$
  select l.owner_state from public.list_vendor_retailers() l where l.retailer_name = p_name;
$$;

/* The owner_state the DEPLOYED owner-status RPC reports for one relationship. */
create function pg_temp.rpc_owner_state(p_relationship uuid) returns text
language sql as $$
  select s.owner_state from public.get_vendor_retailer_owner_status(p_relationship) s;
$$;

create function pg_temp.detail_count(p_relationship uuid) returns bigint
language sql as $$
  select count(*) from public.get_vendor_retailer_detail(p_relationship);
$$;

create function pg_temp.shops_count(p_relationship uuid) returns bigint
language sql as $$
  select count(*) from public.list_vendor_retailer_shops(p_relationship);
$$;

/* Shop names in the function's own order — same technique as my_retailer_names(). */
create function pg_temp.shop_names(p_relationship uuid) returns text[]
language sql as $$
  select coalesce(array_agg(t.shop_name order by t.ord), '{}'::text[])
  from (
    select s.shop_name, row_number() over () as ord
    from public.list_vendor_retailer_shops(p_relationship) s
  ) t;
$$;


-- ============================================================================
-- Fixtures
-- ============================================================================
-- Deterministic: every name, status, count and invitation state below is written
-- explicitly, and nothing depends on seeded tenant data (there is none) or on ordering
-- that the functions themselves choose.

create table pg_temp.fx (k text primary key, v uuid);

insert into pg_temp.fx (k, v) values
  ('vendor_a',   pg_temp.new_org('Vendor A')),
  ('vendor_b',   pg_temp.new_org('Vendor B')),
  ('vendor_c',   pg_temp.new_org('Vendor C')),
  -- Retailer names are chosen so that alphabetical order is unambiguous and is NOT the
  -- insertion order — Echo is created before Delta below, so a function that returned
  -- rows in physical order would fail the ordering assertions.
  ('alpha',      pg_temp.new_org('Alpha Retail',  'RETAILER', 'ACTIVE')),
  ('bravo',      pg_temp.new_org('Bravo Stores',  'RETAILER', 'ACTIVE')),
  ('charlie',    pg_temp.new_org('Charlie Mart',  'RETAILER', 'SUSPENDED')),
  ('echo',       pg_temp.new_org('Echo Traders',  'RETAILER', 'ACTIVE')),
  ('delta',      pg_temp.new_org('Delta Shops',   'RETAILER', 'ACTIVE')),
  ('foxtrot',    pg_temp.new_org('Foxtrot Group', 'RETAILER', 'ACTIVE'));

create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.fx where k = p_k; $$;

-- Relationships. Vendor A manages five Retailers in three different relationship states;
-- Vendor B manages Foxtrot AND Alpha (a Retailer legitimately shared by two Vendors,
-- which is what makes the cross-tenant assertions meaningful rather than trivial).
insert into pg_temp.fx (k, v) values
  ('rel_alpha',      pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('alpha'),   'ACTIVE')),
  ('rel_bravo',      pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('bravo'),   'SUSPENDED')),
  ('rel_charlie',    pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('charlie'), 'ACTIVE')),
  ('rel_delta',      pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('delta'),   'DEACTIVATED')),
  ('rel_echo',       pg_temp.link(pg_temp.fx('vendor_a'), pg_temp.fx('echo'),    'ACTIVE')),
  ('rel_b_foxtrot',  pg_temp.link(pg_temp.fx('vendor_b'), pg_temp.fx('foxtrot'), 'ACTIVE')),
  ('rel_b_alpha',    pg_temp.link(pg_temp.fx('vendor_b'), pg_temp.fx('alpha'),   'ACTIVE'));

-- Shops. Alpha: 3 total / 2 active. Charlie: 1 total / 0 active. Delta: 2 total / 2 active.
-- Bravo and Echo: none at all. Foxtrot: 2, belonging to Vendor B's tenant only.
insert into pg_temp.fx (k, v) values
  ('shop_a1', pg_temp.new_shop(pg_temp.fx('alpha'),   'Marina Branch',  'ACTIVE',      'A-1', 'Dubai')),
  ('shop_a2', pg_temp.new_shop(pg_temp.fx('alpha'),   'Airport Kiosk',  'ACTIVE',      'A-2', 'Dubai')),
  ('shop_a3', pg_temp.new_shop(pg_temp.fx('alpha'),   'Zabeel Outlet',  'SUSPENDED',   'A-3', null)),
  ('shop_c1', pg_temp.new_shop(pg_temp.fx('charlie'), 'Old Town Shop',  'DEACTIVATED', null,  null)),
  ('shop_d1', pg_temp.new_shop(pg_temp.fx('delta'),   'Delta One',      'ACTIVE',      'D-1', 'Sharjah')),
  ('shop_d2', pg_temp.new_shop(pg_temp.fx('delta'),   'Delta Two',      'ACTIVE',      'D-2', 'Sharjah')),
  ('shop_f1', pg_temp.new_shop(pg_temp.fx('foxtrot'), 'Foxtrot North',  'ACTIVE',      'F-1', 'Doha')),
  ('shop_f2', pg_temp.new_shop(pg_temp.fx('foxtrot'), 'Foxtrot South',  'ACTIVE',      'F-2', 'Doha'));

-- People.
insert into pg_temp.fx (k, v) values
  ('admin_a',          pg_temp.new_user('admin-a')),
  ('admin_b',          pg_temp.new_user('admin-b')),
  ('admin_c',          pg_temp.new_user('admin-c')),
  ('admin_suspended',  pg_temp.new_user('admin-susp', 'SUSPENDED')),
  ('admin_inactive_m', pg_temp.new_user('admin-inact-m')),
  ('owner_alpha',      pg_temp.new_user('owner-alpha')),
  ('manager_alpha',    pg_temp.new_user('manager-alpha')),
  ('staff_alpha',      pg_temp.new_user('staff-alpha')),
  ('no_org',           pg_temp.new_user('no-org')),
  ('invitee_charlie',  pg_temp.new_user('invitee-charlie'));

select pg_temp.grant_role(pg_temp.fx('admin_a'),          pg_temp.fx('vendor_a'), 'VENDOR_SUPER_ADMIN');
select pg_temp.grant_role(pg_temp.fx('admin_b'),          pg_temp.fx('vendor_b'), 'VENDOR_SUPER_ADMIN');
select pg_temp.grant_role(pg_temp.fx('admin_c'),          pg_temp.fx('vendor_c'), 'VENDOR_SUPER_ADMIN');
select pg_temp.grant_role(pg_temp.fx('admin_suspended'),  pg_temp.fx('vendor_a'), 'VENDOR_SUPER_ADMIN');
select pg_temp.grant_role(pg_temp.fx('admin_inactive_m'), pg_temp.fx('vendor_a'), 'VENDOR_SUPER_ADMIN', 'SUSPENDED');

-- Alpha's own people. The ACTIVE RETAILER_OWNER membership is what makes Alpha's
-- owner_state ACTIVE; the Manager and Sales Staff exist to be REFUSED by all three reads.
select pg_temp.grant_role(pg_temp.fx('owner_alpha'),   pg_temp.fx('alpha'), 'RETAILER_OWNER');
select pg_temp.grant_role(pg_temp.fx('manager_alpha'), pg_temp.fx('alpha'), 'RETAILER_MANAGER');
select pg_temp.grant_role(pg_temp.fx('staff_alpha'),   pg_temp.fx('alpha'), 'SALES_STAFF');

-- Charlie: a genuinely delivered NEW_USER invitation -> PENDING. It needs BOTH a
-- membership and sent_at, which is exactly the completion proof the state derivation
-- requires, so the membership is created INVITED (never ACTIVE — an ACTIVE owner
-- membership would outrank the invitation and make the state ACTIVE instead).
insert into pg_temp.fx (k, v) values
  ('member_charlie', pg_temp.grant_role(pg_temp.fx('invitee_charlie'), pg_temp.fx('charlie'),
                                        'RETAILER_OWNER', 'INVITED'));

insert into public.retailer_invitations (
  vendor_organization_id, retailer_organization_id, email, first_name, last_name,
  role_id, status, auth_user_id, organization_member_id, invitation_kind,
  expires_at, sent_at
)
select pg_temp.fx('vendor_a'), pg_temp.fx('charlie'), 'charlie-owner@test.invalid',
       'Cara', 'Mart', r.id, 'PENDING', pg_temp.fx('invitee_charlie'),
       pg_temp.fx('member_charlie'), 'NEW_USER',
       now() + interval '12 hours', now() - interval '1 hour'
from public.roles r where r.code = 'RETAILER_OWNER';

-- Delta: a NEW_USER invitation that was reserved but never dispatched (sent_at NULL, no
-- membership) -> DELIVERY_FAILED. Still PENDING and still unexpired.
insert into public.retailer_invitations (
  vendor_organization_id, retailer_organization_id, email, first_name, last_name,
  role_id, status, invitation_kind, expires_at, failure_code, failure_recorded_at
)
select pg_temp.fx('vendor_a'), pg_temp.fx('delta'), 'delta-owner@test.invalid',
       'Dana', 'Shop', r.id, 'PENDING', 'NEW_USER',
       now() + interval '12 hours', 'AUTH_DISPATCH_FAILED', now()
from public.roles r where r.code = 'RETAILER_OWNER';

-- Echo: an invitation that ran out of time -> EXPIRED.
insert into public.retailer_invitations (
  vendor_organization_id, retailer_organization_id, email, first_name, last_name,
  role_id, status, invitation_kind, expires_at, sent_at
)
select pg_temp.fx('vendor_a'), pg_temp.fx('echo'), 'echo-owner@test.invalid',
       'Evan', 'Trade', r.id, 'EXPIRED', 'NEW_USER',
       now() - interval '2 days', now() - interval '3 days'
from public.roles r where r.code = 'RETAILER_OWNER';

-- Bravo: nothing at all -> NONE.


-- ============================================================================
-- SECTION A — signature, security attributes and privileges (catalogue-level)
-- ============================================================================
-- Asserted against the catalogue rather than inferred from behaviour: "it did not error
-- for me" is not a privilege check, and a grant that widened by accident would still let
-- every behavioural test pass.

select has_function('public', 'list_vendor_retailers', '{}'::text[],
  'list_vendor_retailers() exists and takes no arguments');
select has_function('public', 'get_vendor_retailer_detail', array['uuid'],
  'get_vendor_retailer_detail(uuid) exists');
select has_function('public', 'list_vendor_retailer_shops', array['uuid'],
  'list_vendor_retailer_shops(uuid) exists');
select has_function('public', 'vendor_retailer_owner_state', array['uuid'],
  'vendor_retailer_owner_state(uuid) exists');

-- NO IDENTITY, VENDOR OR TENANT ARGUMENT ON ANY READ.
select is(pg_temp.input_args('list_vendor_retailers'), '{}'::text[],
  'list_vendor_retailers() accepts no client input at all');
select is(pg_temp.input_args('get_vendor_retailer_detail'), array['p_relationship_id'],
  'get_vendor_retailer_detail takes exactly one input: the relationship selector');
select is(pg_temp.input_args('list_vendor_retailer_shops'), array['p_relationship_id'],
  'list_vendor_retailer_shops takes exactly one input: the relationship selector');

-- Exact output shape. A positional `returns table` contract is only stable if the column
-- list is pinned, and pinning it is what makes an accidental addition a test failure
-- rather than a silently broken pinned mobile build.
select is(
  pg_temp.table_columns('list_vendor_retailers'),
  array['relationship_id', 'retailer_organization_id', 'retailer_name', 'retailer_status',
        'relationship_status', 'relationship_created_at', 'shop_count', 'active_shop_count',
        'owner_state'],
  'list_vendor_retailers() returns exactly the nine agreed columns, in order');

select is(
  pg_temp.table_columns('get_vendor_retailer_detail'),
  array['relationship_id', 'retailer_organization_id', 'retailer_name', 'retailer_status',
        'country_code', 'default_currency', 'relationship_status', 'relationship_created_at',
        'shop_count', 'active_shop_count', 'owner_state'],
  'get_vendor_retailer_detail() returns exactly the eleven agreed columns, in order');

select is(
  pg_temp.table_columns('list_vendor_retailer_shops'),
  array['shop_id', 'shop_name', 'shop_code', 'city', 'country_code', 'shop_status'],
  'list_vendor_retailer_shops() returns exactly the six agreed columns, in order');

-- FORBIDDEN FIELDS. The exact-column assertions above already exclude these; this states
-- the rule directly so the reason survives a future column addition.
select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_retailers')
     || pg_temp.table_columns('get_vendor_retailer_detail')
     || pg_temp.table_columns('list_vendor_retailer_shops')) c
   where c ~ 'token|hash|secret|password|failure|invited_by|auth_user|member_id|role_id|permission|vendor_organization'),
  0::bigint,
  'no output column names a token, hash, secret, failure code, membership, role, permission or vendor id');

select is(
  (select count(*) from unnest(
     pg_temp.table_columns('list_vendor_retailers')
     || pg_temp.table_columns('get_vendor_retailer_detail')) c
   where c ~ 'email|first_name|last_name'),
  0::bigint,
  'neither read returns owner personal data — the owner-status RPC remains its only source');

-- Security attributes.
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='list_vendor_retailers'), true,
  'list_vendor_retailers is SECURITY DEFINER');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_vendor_retailer_detail'), true,
  'get_vendor_retailer_detail is SECURITY DEFINER');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='list_vendor_retailer_shops'), true,
  'list_vendor_retailer_shops is SECURITY DEFINER');
select is((select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='vendor_retailer_owner_state'), true,
  'vendor_retailer_owner_state is SECURITY DEFINER');

-- `set search_path = ''` is stored by PostgreSQL as the literal `search_path=""` — the
-- empty string, quoted. Asserting `search_path=` (unquoted) would match nothing and the
-- test would fail even on a correctly-hardened function, so the quoted form is what is
-- compared here.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public'
     and p.proname in ('list_vendor_retailers','get_vendor_retailer_detail',
                       'list_vendor_retailer_shops','vendor_retailer_owner_state')
     and p.proconfig @> array['search_path=""']),
  4::bigint,
  'all four functions pin an EMPTY search_path');

select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public'
     and p.proname in ('list_vendor_retailers','get_vendor_retailer_detail',
                       'list_vendor_retailer_shops','vendor_retailer_owner_state')
     and p.provolatile = 's'),
  4::bigint,
  'all four functions are STABLE — none may write');

-- Grants: authenticated yes, anon no, PUBLIC no, service_role no.
select ok(has_function_privilege('authenticated', 'public.list_vendor_retailers()', 'execute'),
  'authenticated may execute list_vendor_retailers()');
select ok(has_function_privilege('authenticated', 'public.get_vendor_retailer_detail(uuid)', 'execute'),
  'authenticated may execute get_vendor_retailer_detail(uuid)');
select ok(has_function_privilege('authenticated', 'public.list_vendor_retailer_shops(uuid)', 'execute'),
  'authenticated may execute list_vendor_retailer_shops(uuid)');

select ok(not has_function_privilege('anon', 'public.list_vendor_retailers()', 'execute'),
  'anon may NOT execute list_vendor_retailers()');
select ok(not has_function_privilege('anon', 'public.get_vendor_retailer_detail(uuid)', 'execute'),
  'anon may NOT execute get_vendor_retailer_detail(uuid)');
select ok(not has_function_privilege('anon', 'public.list_vendor_retailer_shops(uuid)', 'execute'),
  'anon may NOT execute list_vendor_retailer_shops(uuid)');

-- The shared derivation is INTERNAL. Reachable by a browser role it would be an oracle
-- for probing any organization id.
select ok(not has_function_privilege('authenticated', 'public.vendor_retailer_owner_state(uuid)', 'execute'),
  'authenticated may NOT execute the internal vendor_retailer_owner_state(uuid)');
select ok(not has_function_privilege('anon', 'public.vendor_retailer_owner_state(uuid)', 'execute'),
  'anon may NOT execute the internal vendor_retailer_owner_state(uuid)');

-- PUBLIC holds nothing. A PUBLIC grant appears in proacl as an entry with an empty
-- grantee ("=X/owner"), and PUBLIC is inherited by every role — so a leftover default
-- grant would hand anon EXECUTE despite the explicit revokes above.
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where n.nspname='public'
     and p.proname in ('list_vendor_retailers','get_vendor_retailer_detail',
                       'list_vendor_retailer_shops','vendor_retailer_owner_state')
     and a::text like '=%'),
  0::bigint,
  'PUBLIC holds EXECUTE on none of the four functions');

select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(coalesce(p.proacl, '{}'::aclitem[])) a
   where n.nspname='public'
     and p.proname in ('list_vendor_retailers','get_vendor_retailer_detail',
                       'list_vendor_retailer_shops','vendor_retailer_owner_state')
     and a::text like 'service_role=%'),
  0::bigint,
  'service_role is granted none of the four functions');

-- NO BROAD TABLE GRANTS, AND NO WEAKENED RLS. This migration must not have made any
-- Flutter read easier by opening a table.
select ok(not has_table_privilege('authenticated', 'public.retailer_invitations', 'select'),
  'public.retailer_invitations remains unreadable by authenticated');
select ok(not has_table_privilege('anon', 'public.vendor_retailers', 'select'),
  'anon still holds no privilege on public.vendor_retailers');
select ok(has_table_privilege('authenticated', 'public.vendor_retailers', 'select'),
  'authenticated keeps exactly the SELECT it already had on public.vendor_retailers');
select ok(not has_table_privilege('authenticated', 'public.vendor_retailers', 'insert'),
  'authenticated still may not INSERT into public.vendor_retailers');
select ok(not has_table_privilege('authenticated', 'public.retailer_shops', 'update'),
  'authenticated still may not UPDATE public.retailer_shops');

select ok((select relrowsecurity from pg_class where oid = 'public.vendor_retailers'::regclass),
  'RLS is still enabled on public.vendor_retailers');
select ok((select relrowsecurity from pg_class where oid = 'public.retailer_shops'::regclass),
  'RLS is still enabled on public.retailer_shops');
select ok((select relrowsecurity from pg_class where oid = 'public.retailer_invitations'::regclass),
  'RLS is still enabled on public.retailer_invitations');
select is(
  (select count(*) from pg_policies where schemaname='public' and tablename='retailer_invitations'),
  0::bigint,
  'public.retailer_invitations still has zero RLS policies');
select is(
  (select count(*) from pg_policies
   where schemaname='public'
     and policyname in ('vendor_retailers_select_vendor_authorized',
                        'retailer_shops_select_vendor_authorized',
                        'organizations_select_vendor_managed_retailers')),
  3::bigint,
  'the three migration-9 Vendor read policies are still present and unrenamed');


-- ============================================================================
-- SECTION B — signed-out callers are denied by all three reads
-- ============================================================================
select pg_temp.sign_out();

select is(pg_temp.sqlstate_of('select * from public.list_vendor_retailers()'), '42501',
  'signed-out caller is denied the Retailer list');
select is(pg_temp.sqlstate_of('select * from public.get_vendor_retailer_detail(gen_random_uuid())'), '42501',
  'signed-out caller is denied the Retailer detail');
select is(pg_temp.sqlstate_of('select * from public.list_vendor_retailer_shops(gen_random_uuid())'), '42501',
  'signed-out caller is denied the Retailer shop list');


-- ============================================================================
-- SECTION C — a Vendor Super Admin sees their OWN Vendor's Retailers, and only those
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('admin_a'));

select is(
  pg_temp.my_retailer_names(),
  array['Alpha Retail', 'Bravo Stores', 'Charlie Mart', 'Delta Shops', 'Echo Traders'],
  'Vendor A lists exactly its five Retailers, ordered by name');

select is((select count(*) from public.list_vendor_retailers()), 5::bigint,
  'Vendor A sees five rows — one per relationship, never one per shop');

select ok(
  not exists (select 1 from public.list_vendor_retailers() l where l.retailer_name = 'Foxtrot Group'),
  'Vendor A cannot see Vendor B''s Retailer');

select is(
  (select l.retailer_organization_id from public.list_vendor_retailers() l
   where l.retailer_name = 'Alpha Retail'),
  pg_temp.fx('alpha'),
  'the Retailer organization id is returned, so a mobile screen can cross-link to products');

select is(
  (select l.relationship_id from public.list_vendor_retailers() l where l.retailer_name = 'Alpha Retail'),
  pg_temp.fx('rel_alpha'),
  'the relationship id returned is Vendor A''s own relationship, not Vendor B''s for the same Retailer');

select ok(
  (select l.relationship_created_at from public.list_vendor_retailers() l
   where l.retailer_name = 'Alpha Retail') is not null,
  'the relationship creation date is returned');

select pg_temp.act_as(pg_temp.fx('admin_b'));

select is(
  pg_temp.my_retailer_names(),
  array['Alpha Retail', 'Foxtrot Group'],
  'Vendor B lists only its own two relationships');

select is(
  (select l.relationship_id from public.list_vendor_retailers() l where l.retailer_name = 'Alpha Retail'),
  pg_temp.fx('rel_b_alpha'),
  'a Retailer shared by two Vendors yields each Vendor its OWN relationship id');

select is(
  (select l.relationship_status from public.list_vendor_retailers() l where l.retailer_name = 'Alpha Retail'),
  'ACTIVE',
  'Vendor B sees its own relationship status for the shared Retailer');

-- Vendor C is a perfectly valid Vendor Super Admin with nothing on record.
select pg_temp.act_as(pg_temp.fx('admin_c'));
select is((select count(*) from public.list_vendor_retailers()), 0::bigint,
  'an authorized Vendor with no Retailers gets an EMPTY SET, not a denial');
select is(pg_temp.sqlstate_of('select * from public.list_vendor_retailers()'), null,
  'and that empty set really is a normal return, not a swallowed error');


-- ============================================================================
-- SECTION D — every non-Vendor role is denied
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('owner_alpha'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_retailers()'), '42501',
  'a Retailer Owner is denied the Vendor Retailer list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_retailer_detail(%L)', pg_temp.fx('rel_alpha'))), '42501',
  'a Retailer Owner is denied the detail — even for their OWN Retailer');
select is(pg_temp.sqlstate_of(format('select * from public.list_vendor_retailer_shops(%L)', pg_temp.fx('rel_alpha'))), '42501',
  'a Retailer Owner is denied the shop list — even for their OWN Retailer');

select pg_temp.act_as(pg_temp.fx('manager_alpha'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_retailers()'), '42501',
  'a Retailer Manager is denied the Vendor Retailer list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_retailer_detail(%L)', pg_temp.fx('rel_alpha'))), '42501',
  'a Retailer Manager is denied the detail');

select pg_temp.act_as(pg_temp.fx('staff_alpha'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_retailers()'), '42501',
  'a Sales Staff member is denied the Vendor Retailer list');
select is(pg_temp.sqlstate_of(format('select * from public.list_vendor_retailer_shops(%L)', pg_temp.fx('rel_alpha'))), '42501',
  'a Sales Staff member is denied the shop list');

select pg_temp.act_as(pg_temp.fx('no_org'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_retailers()'), '42501',
  'an authenticated user with no organization at all is denied');


-- ============================================================================
-- SECTION E — an inactive Vendor profile or membership is denied
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('admin_suspended'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_retailers()'), '42501',
  'a SUSPENDED profile holding VENDOR_SUPER_ADMIN is denied the list');
select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_retailer_detail(%L)', pg_temp.fx('rel_alpha'))), '42501',
  'a SUSPENDED profile is denied the detail');

select pg_temp.act_as(pg_temp.fx('admin_inactive_m'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_retailers()'), '42501',
  'a SUSPENDED membership holding VENDOR_SUPER_ADMIN is denied the list');
select is(pg_temp.sqlstate_of(format('select * from public.list_vendor_retailer_shops(%L)', pg_temp.fx('rel_alpha'))), '42501',
  'a SUSPENDED membership is denied the shop list');


-- ============================================================================
-- SECTION F — statuses and counts are accurate, and no lifecycle state is hidden
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('admin_a'));

select is(pg_temp.list_relationship_status('Alpha Retail'),  'ACTIVE',      'ACTIVE relationship reported accurately');
select is(pg_temp.list_relationship_status('Bravo Stores'),  'SUSPENDED',   'SUSPENDED relationship is listed, not hidden');
select is(pg_temp.list_relationship_status('Delta Shops'),   'DEACTIVATED', 'DEACTIVATED relationship is listed, not hidden');
select is(pg_temp.list_retailer_status('Charlie Mart'),      'SUSPENDED',   'a SUSPENDED Retailer organization is listed with its own status');
select is(pg_temp.list_retailer_status('Alpha Retail'),      'ACTIVE',      'Retailer organization status is a separate fact from relationship status');

-- Counts. shop_count includes every lifecycle state, matching the number the web
-- directory shows today; active_shop_count is the ACTIVE subset.
select is(pg_temp.list_shop_count('Alpha Retail'),        3, 'shop_count counts every shop, whatever its status');
select is(pg_temp.list_active_shop_count('Alpha Retail'), 2, 'active_shop_count excludes the SUSPENDED shop');
select is(pg_temp.list_shop_count('Charlie Mart'),        1, 'a DEACTIVATED shop is still counted in shop_count');
select is(pg_temp.list_active_shop_count('Charlie Mart'), 0, 'and is excluded from active_shop_count');
select is(pg_temp.list_shop_count('Bravo Stores'),        0, 'a Retailer with no shops reports 0 rather than being omitted');
select is(pg_temp.list_active_shop_count('Bravo Stores'), 0, 'and reports 0 active shops');
select is(pg_temp.list_shop_count('Delta Shops'),         2, 'shop counts are per Retailer, not shared');
select is(pg_temp.list_active_shop_count('Delta Shops'),  2, 'all-active Retailer reports both counts equal');

-- A Retailer with three shops must produce ONE row, not three. This is the assertion that
-- would fail if the aggregate were ever replaced by a plain join.
select is(
  (select count(*) from public.list_vendor_retailers() l where l.retailer_name = 'Alpha Retail'),
  1::bigint,
  'a multi-shop Retailer appears exactly once — the shop join cannot duplicate it');

-- A Retailer managed by two Vendors must not appear twice for either of them.
select is(
  (select count(*) from public.list_vendor_retailers() l where l.retailer_name = 'Alpha Retail'),
  1::bigint,
  'a Retailer shared with another Vendor still appears exactly once');

-- Ordering is stable across calls.
select is(pg_temp.my_retailer_names(), pg_temp.my_retailer_names(),
  'the list order is stable between two calls in the same transaction');


-- ============================================================================
-- SECTION G — owner state is accurate, and agrees with the deployed owner-status RPC
-- ============================================================================
select is(pg_temp.list_owner_state('Alpha Retail'), 'ACTIVE',
  'a Retailer with an ACTIVE RETAILER_OWNER membership reports ACTIVE');
select is(pg_temp.list_owner_state('Bravo Stores'), 'NONE',
  'a Retailer with no owner and no invitation reports NONE');
select is(pg_temp.list_owner_state('Charlie Mart'), 'PENDING',
  'a delivered, unexpired NEW_USER invitation reports PENDING');
select is(pg_temp.list_owner_state('Delta Shops'), 'DELIVERY_FAILED',
  'a reserved-but-undispatched invitation reports DELIVERY_FAILED, not PENDING');
select is(pg_temp.list_owner_state('Echo Traders'), 'EXPIRED',
  'an invitation past its expiry reports EXPIRED');

-- THE ANTI-DRIFT ASSERTION. The list's owner_state and the deployed
-- get_vendor_retailer_owner_status() owner_state are two readings of one fact. If a later
-- edit changes either precedence, this fails.
select is(pg_temp.list_owner_state('Alpha Retail'), pg_temp.rpc_owner_state(pg_temp.fx('rel_alpha')),
  'ACTIVE agrees with get_vendor_retailer_owner_status()');
select is(pg_temp.list_owner_state('Bravo Stores'), pg_temp.rpc_owner_state(pg_temp.fx('rel_bravo')),
  'NONE agrees with get_vendor_retailer_owner_status()');
select is(pg_temp.list_owner_state('Charlie Mart'), pg_temp.rpc_owner_state(pg_temp.fx('rel_charlie')),
  'PENDING agrees with get_vendor_retailer_owner_status()');
select is(pg_temp.list_owner_state('Delta Shops'), pg_temp.rpc_owner_state(pg_temp.fx('rel_delta')),
  'DELIVERY_FAILED agrees with get_vendor_retailer_owner_status()');
select is(pg_temp.list_owner_state('Echo Traders'), pg_temp.rpc_owner_state(pg_temp.fx('rel_echo')),
  'EXPIRED agrees with get_vendor_retailer_owner_status()');

-- The state vocabulary is closed.
select is(
  (select count(*) from public.list_vendor_retailers() l
   where l.owner_state not in ('NONE','DELIVERY_FAILED','PENDING','EXPIRED','ACTIVE')),
  0::bigint,
  'owner_state only ever holds one of the five approved words');


-- ============================================================================
-- SECTION H — detail: one row for your own, ZERO ROWS for anything else
-- ============================================================================
select is(pg_temp.detail_count(pg_temp.fx('rel_alpha')), 1::bigint,
  'Vendor A reads its own relationship: exactly one row');

select is(pg_temp.detail_count(pg_temp.fx('rel_b_foxtrot')), 0::bigint,
  'Vendor A reading Vendor B''s relationship gets zero rows');

select is(pg_temp.detail_count(pg_temp.fx('rel_b_alpha')), 0::bigint,
  'even for a Retailer Vendor A also manages, Vendor B''s relationship id is inert');

select is(pg_temp.detail_count(gen_random_uuid()), 0::bigint,
  'an unknown relationship id gets zero rows');

select is(pg_temp.detail_count(null), 0::bigint,
  'a null relationship id gets zero rows');

-- The security property, stated as an equality rather than as three separate facts.
select is(pg_temp.detail_count(pg_temp.fx('rel_b_foxtrot')), pg_temp.detail_count(gen_random_uuid()),
  'another Vendor''s relationship is INDISTINGUISHABLE from one that does not exist');

select is(pg_temp.sqlstate_of(format('select * from public.get_vendor_retailer_detail(%L)', pg_temp.fx('rel_b_foxtrot'))),
  null,
  'and it is answered by an empty result, never by a distinguishable error');

-- Suspended and deactivated relationships remain readable, exactly as on the web.
select is(pg_temp.detail_count(pg_temp.fx('rel_bravo')), 1::bigint,
  'a SUSPENDED relationship is still readable');
select is(pg_temp.detail_count(pg_temp.fx('rel_delta')), 1::bigint,
  'a DEACTIVATED relationship is still readable');


-- ============================================================================
-- SECTION I — detail content is correct
-- ============================================================================
select is(
  (select d.retailer_name from public.get_vendor_retailer_detail(pg_temp.fx('rel_alpha')) d),
  'Alpha Retail', 'detail returns the right Retailer identity');
select is(
  (select d.retailer_organization_id from public.get_vendor_retailer_detail(pg_temp.fx('rel_alpha')) d),
  pg_temp.fx('alpha'), 'detail returns the Retailer organization id');
select is(
  (select d.relationship_id from public.get_vendor_retailer_detail(pg_temp.fx('rel_alpha')) d),
  pg_temp.fx('rel_alpha'), 'detail echoes back the relationship it was addressed by');
select is(
  (select d.relationship_status from public.get_vendor_retailer_detail(pg_temp.fx('rel_bravo')) d),
  'SUSPENDED', 'detail returns the relationship''s own status');
select is(
  (select d.retailer_status from public.get_vendor_retailer_detail(pg_temp.fx('rel_charlie')) d),
  'SUSPENDED', 'detail returns the Retailer organization''s own status');
select is(
  (select d.country_code from public.get_vendor_retailer_detail(pg_temp.fx('rel_alpha')) d),
  'AE', 'detail returns the Retailer profile fields the web already displays');
select is(
  (select d.default_currency from public.get_vendor_retailer_detail(pg_temp.fx('rel_alpha')) d),
  'AED', 'detail returns the default currency');
select is(
  (select d.shop_count from public.get_vendor_retailer_detail(pg_temp.fx('rel_alpha')) d),
  3, 'detail shop_count matches the list');
select is(
  (select d.active_shop_count from public.get_vendor_retailer_detail(pg_temp.fx('rel_alpha')) d),
  2, 'detail active_shop_count matches the list');
select is(
  (select d.owner_state from public.get_vendor_retailer_detail(pg_temp.fx('rel_charlie')) d),
  'PENDING', 'detail owner_state matches the list and the owner-status RPC');
select is(
  (select d.owner_state from public.get_vendor_retailer_detail(pg_temp.fx('rel_charlie')) d),
  pg_temp.rpc_owner_state(pg_temp.fx('rel_charlie')),
  'detail owner_state agrees with get_vendor_retailer_owner_status()');


-- ============================================================================
-- SECTION J — shops: correctly scoped, correctly ordered, cross-tenant absent
-- ============================================================================
select is(
  pg_temp.shop_names(pg_temp.fx('rel_alpha')),
  array['Airport Kiosk', 'Marina Branch', 'Zabeel Outlet'],
  'shops are returned for the addressed relationship, ordered by name');

select is(pg_temp.shops_count(pg_temp.fx('rel_alpha')), 3::bigint,
  'every shop is listed, including the SUSPENDED one — matching shop_count');

select is(
  (select s.shop_status from public.list_vendor_retailer_shops(pg_temp.fx('rel_alpha')) s
   where s.shop_name = 'Zabeel Outlet'),
  'SUSPENDED', 'a non-ACTIVE shop is listed with its own status rather than hidden');

select is(
  (select s.shop_id from public.list_vendor_retailer_shops(pg_temp.fx('rel_alpha')) s
   where s.shop_name = 'Marina Branch'),
  pg_temp.fx('shop_a1'), 'each shop carries a stable id a mobile list can key on');

select is(
  (select s.shop_code from public.list_vendor_retailer_shops(pg_temp.fx('rel_alpha')) s
   where s.shop_name = 'Marina Branch'),
  'A-1', 'shop code is returned');

select is(
  (select s.city from public.list_vendor_retailer_shops(pg_temp.fx('rel_alpha')) s
   where s.shop_name = 'Marina Branch'),
  'Dubai', 'shop city is returned');

select ok(
  (select s.shop_code from public.list_vendor_retailer_shops(pg_temp.fx('rel_alpha')) s
   where s.shop_name = 'Zabeel Outlet') is not null,
  'an optional column is passed through rather than coerced');

select is(
  (select s.city from public.list_vendor_retailer_shops(pg_temp.fx('rel_charlie')) s),
  null, 'a null optional column stays null rather than becoming an empty string');

select is(pg_temp.shops_count(pg_temp.fx('rel_bravo')), 0::bigint,
  'a Retailer with no shops returns an empty set');

-- CROSS-TENANT ABSENCE. Foxtrot's two shops belong to Vendor B's tenant only.
select ok(
  not exists (
    select 1 from public.list_vendor_retailer_shops(pg_temp.fx('rel_alpha')) s
    where s.shop_name in ('Foxtrot North', 'Foxtrot South')
  ),
  'another Retailer''s shops never appear in this Retailer''s list');

select is(pg_temp.shops_count(pg_temp.fx('rel_b_foxtrot')), 0::bigint,
  'Vendor A gets zero shops for Vendor B''s relationship — the same answer as a shop-less Retailer');

select is(pg_temp.shops_count(gen_random_uuid()), 0::bigint,
  'an unknown relationship id yields zero shops, indistinguishably');

select is(pg_temp.shops_count(null), 0::bigint,
  'a null relationship id yields zero shops');

select is(pg_temp.shop_names(pg_temp.fx('rel_alpha')), pg_temp.shop_names(pg_temp.fx('rel_alpha')),
  'shop ordering is stable between two calls in the same transaction');

-- Vendor B, over the SAME Retailer through its own relationship, sees the same shops —
-- the shops belong to the Retailer, and both Vendors are authorized over it.
select pg_temp.act_as(pg_temp.fx('admin_b'));
select is(
  pg_temp.shop_names(pg_temp.fx('rel_b_alpha')),
  array['Airport Kiosk', 'Marina Branch', 'Zabeel Outlet'],
  'a second Vendor managing the same Retailer sees that Retailer''s shops through its own relationship');
select is(pg_temp.shops_count(pg_temp.fx('rel_alpha')), 0::bigint,
  'but Vendor B cannot address them through Vendor A''s relationship id');


select * from finish();
rollback;
