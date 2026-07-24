-- pgTAP behavioural tests for public.get_my_portal_context()
-- (migration 20260729090000_shared_portal_context.sql)
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- public.auth.uid() resolves the caller from the request's JWT claims, which
-- Supabase exposes as the `request.jwt.claims` GUC:
--
--   auth.uid() = (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
--
-- so setting that GUC transaction-locally IS signing in, as far as every
-- authorization helper in this schema is concerned. pg_temp.act_as() below does
-- exactly that, and pg_temp.sign_out() clears it.
--
-- The tests deliberately do NOT `set role authenticated`. The function under test
-- is SECURITY DEFINER, so its behaviour depends on auth.uid() and not on the
-- session role, and switching roles mid-transaction would only make the fixture
-- inserts fail. EXECUTE privilege is a separate concern and is asserted directly
-- against the catalogue in Section A, which is a stronger check than "it did not
-- error for me".
--
-- Everything runs inside one transaction and is rolled back, so no fixture
-- survives the run. The two tests that mutate seeded catalogue rows (Section N)
-- are last, for that reason.
--
-- no_plan() rather than plan(N): the assertion count is incidental here, and a
-- hard-coded number that drifts out of step with the file turns an added test
-- into a confusing failure about arithmetic rather than about behaviour.

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

/* The value under test, for the currently impersonated caller. */
create function pg_temp.ctx() returns jsonb
language sql as $$
  select public.get_my_portal_context();
$$;

/* A capability hint, as text ('true' / 'false'), for the current caller. */
create function pg_temp.cap(p_name text) returns text
language sql as $$
  select public.get_my_portal_context() #>> array['retailer', 'capabilities', p_name];
$$;

/* The single value every unauthorized caller must receive, byte for byte. */
create function pg_temp.denial() returns jsonb
language sql as $$
  select jsonb_build_object(
    'context_version', 1,
    'portal_kind',     'NONE',
    'vendor',          null::jsonb,
    'retailer',        null::jsonb
  );
$$;

/*
 * Creates an auth user + an ACTIVE profile, and returns the id.
 *
 * public.profiles.id is a FK to auth.users(id), so a real auth row is required.
 * Only id and email are supplied: every other auth.users column is nullable or
 * carries a default in the GoTrue schema. If a future Auth release adds a NOT
 * NULL column without a default, this is the one place that needs updating.
 */
create function pg_temp.new_user(p_label text) returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_label || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_label, 'Tester', 'ACTIVE');
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

-- ============================================================================
-- Fixtures
-- ============================================================================
create temporary table t_ids (label text primary key, id uuid not null);

do $$
declare
  v_vendor    uuid := gen_random_uuid();
  v_retailer1 uuid := gen_random_uuid();
  v_retailer2 uuid := gen_random_uuid();
  v_suspended uuid := gen_random_uuid();
begin
  insert into public.organizations (id, name, organization_type, status) values
    (v_vendor,    'Test Vendor Co',     'VENDOR',   'ACTIVE'),
    (v_retailer1, 'Test Retailer One',  'RETAILER', 'ACTIVE'),
    (v_retailer2, 'Test Retailer Two',  'RETAILER', 'ACTIVE'),
    (v_suspended, 'Suspended Retailer', 'RETAILER', 'SUSPENDED');

  insert into t_ids values
    ('vendor_org', v_vendor),
    ('retailer1',  v_retailer1),
    ('retailer2',  v_retailer2),
    ('suspended',  v_suspended);

  -- One user per scenario.
  insert into t_ids values
    ('vendor_admin',   pg_temp.new_user('vendoradmin')),
    ('owner1',         pg_temp.new_user('owner1')),
    ('owner2',         pg_temp.new_user('owner2')),
    ('manager1',       pg_temp.new_user('manager1')),
    ('sales1',         pg_temp.new_user('sales1')),
    ('nobody',         pg_temp.new_user('nobody')),
    ('invited',        pg_temp.new_user('invited')),
    ('suspended_mem',  pg_temp.new_user('suspendedmem')),
    ('ambiguous',      pg_temp.new_user('ambiguous')),
    ('dual',           pg_temp.new_user('dual')),
    ('noroles',        pg_temp.new_user('noroles')),
    ('permless',       pg_temp.new_user('permless')),
    ('susp_org_owner', pg_temp.new_user('susporgowner')),
    ('inactive_role',  pg_temp.new_user('inactiverole'));
end;
$$;

do $$
declare
  v_vendor    uuid := (select id from t_ids where label = 'vendor_org');
  v_retailer1 uuid := (select id from t_ids where label = 'retailer1');
  v_retailer2 uuid := (select id from t_ids where label = 'retailer2');
  v_suspended uuid := (select id from t_ids where label = 'suspended');
begin
  perform pg_temp.grant_role((select id from t_ids where label='vendor_admin'), v_vendor,    'VENDOR_SUPER_ADMIN');
  perform pg_temp.grant_role((select id from t_ids where label='owner1'),       v_retailer1, 'RETAILER_OWNER');
  perform pg_temp.grant_role((select id from t_ids where label='owner2'),       v_retailer2, 'RETAILER_OWNER');
  perform pg_temp.grant_role((select id from t_ids where label='manager1'),     v_retailer1, 'RETAILER_MANAGER');
  perform pg_temp.grant_role((select id from t_ids where label='sales1'),       v_retailer1, 'SALES_STAFF');

  -- 'nobody' gets an ACTIVE profile and no membership at all.

  -- Membership states that must NOT authorize.
  perform pg_temp.grant_role((select id from t_ids where label='invited'),       v_retailer1, 'RETAILER_OWNER', 'INVITED');
  perform pg_temp.grant_role((select id from t_ids where label='suspended_mem'), v_retailer1, 'RETAILER_OWNER', 'SUSPENDED');

  -- Owner of TWO retailers: the ambiguity rule must fail closed.
  perform pg_temp.grant_role((select id from t_ids where label='ambiguous'), v_retailer1, 'RETAILER_OWNER');
  perform pg_temp.grant_role((select id from t_ids where label='ambiguous'), v_retailer2, 'RETAILER_OWNER');

  -- Holds BOTH a Vendor role and a Retailer Owner role.
  perform pg_temp.grant_role((select id from t_ids where label='dual'), v_vendor,    'VENDOR_SUPER_ADMIN');
  perform pg_temp.grant_role((select id from t_ids where label='dual'), v_retailer1, 'RETAILER_OWNER');

  -- Malformed / incomplete: an ACTIVE membership carrying no role at all.
  insert into public.organization_members (organization_id, user_id, status)
  values (v_retailer1, (select id from t_ids where label='noroles'), 'ACTIVE');

  -- Malformed / incomplete: an ACTIVE role that maps to no permission whatsoever.
  -- CLAIM_REVIEWER is seeded ACTIVE and deliberately holds none.
  perform pg_temp.grant_role((select id from t_ids where label='permless'), v_retailer1, 'CLAIM_REVIEWER');

  -- A legitimate owner role, but the organization itself is SUSPENDED.
  perform pg_temp.grant_role((select id from t_ids where label='susp_org_owner'), v_suspended, 'RETAILER_OWNER');

  -- Used by Section N once SALES_STAFF is flipped to INACTIVE.
  perform pg_temp.grant_role((select id from t_ids where label='inactive_role'), v_retailer2, 'SALES_STAFF');
end;
$$;

-- ============================================================================
-- SECTION A — contract surface: grants, revokes, and no client-supplied input
-- ============================================================================
select ok(
  has_function_privilege('authenticated', 'public.get_my_portal_context()', 'EXECUTE'),
  'authenticated holds EXECUTE'
);

select ok(
  not has_function_privilege('anon', 'public.get_my_portal_context()', 'EXECUTE'),
  'anon does NOT hold EXECUTE — a signed-out caller cannot invoke it at all'
);

select ok(
  not has_function_privilege('service_role', 'public.get_my_portal_context()', 'EXECUTE'),
  'service_role does NOT hold EXECUTE — it has no auth.uid() to resolve'
);

select is(
  (select pronargs from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_my_portal_context'),
  0::smallint,
  'takes ZERO arguments — no user, org, role, membership or email can be supplied'
);

select ok(
  (select prosecdef from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_my_portal_context'),
  'is SECURITY DEFINER'
);

-- PostgreSQL stores `SET search_path = ''` in proconfig as a name=value string.
-- Both spellings are accepted here because the exact quoting of an empty value
-- has varied between server versions, and the property under test is "it is
-- pinned to nothing", not "it is spelled a particular way".
select ok(
  (select exists (
     select 1
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     cross join lateral unnest(coalesce(p.proconfig, '{}')) as cfg
     where n.nspname = 'public'
       and p.proname = 'get_my_portal_context'
       and cfg in ('search_path=', 'search_path=""')
   )),
  'pins search_path to the empty string'
);

select is(
  (select provolatile from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_my_portal_context'),
  's'::"char",
  'is STABLE — it reads and never writes'
);

select is(
  (select pg_catalog.format_type(prorettype, null) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_my_portal_context'),
  'jsonb',
  'returns jsonb, so a new key is an additive change rather than a DROP'
);

-- ============================================================================
-- SECTION B — signed out
-- ============================================================================
select pg_temp.sign_out();

select is(pg_temp.ctx(), pg_temp.denial(), 'signed out -> the canonical denial value');
select is(pg_temp.ctx() ->> 'context_version', '1', 'context_version is 1 even when denied');

-- ============================================================================
-- SECTION C — Vendor Super Admin
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'vendor_admin'));

select is(pg_temp.ctx() ->> 'portal_kind', 'VENDOR_SUPER_ADMIN', 'Vendor Super Admin -> VENDOR_SUPER_ADMIN');
select is(pg_temp.ctx() #>> '{vendor,organization_id}',
          (select id::text from t_ids where label = 'vendor_org'),
          'vendor block carries the caller''s own Vendor organization id');
select is(pg_temp.ctx() #>> '{vendor,organization_name}', 'Test Vendor Co',
          'vendor block carries the Vendor organization display name');
select is(pg_temp.ctx() -> 'retailer', 'null'::jsonb,
          'a Vendor-only account has no retailer block');

-- ============================================================================
-- SECTION D — Retailer Owner
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'owner1'));

select is(pg_temp.ctx() ->> 'portal_kind', 'RETAILER_OWNER', 'Retailer Owner -> RETAILER_OWNER');
select is(pg_temp.ctx() #>> '{retailer,kind}', 'RETAILER_OWNER', 'retailer.kind agrees with portal_kind');
select is(pg_temp.ctx() #>> '{retailer,organization_id}',
          (select id::text from t_ids where label = 'retailer1'),
          'owner resolves their own Retailer organization');
select is(pg_temp.ctx() #>> '{retailer,organization_name}', 'Test Retailer One',
          'owner receives the Retailer display name');
select is(pg_temp.ctx() -> 'vendor', 'null'::jsonb, 'a Retailer Owner has no vendor block');

select is(pg_temp.cap('view_retailer_overview'), 'true',  'owner: view_retailer_overview');
select is(pg_temp.cap('view_shops'),             'true',  'owner: view_shops');
select is(pg_temp.cap('view_staff'),             'true',  'owner: view_staff');
select is(pg_temp.cap('manage_staff'),           'true',  'owner: manage_staff');
select is(pg_temp.cap('assign_staff_shops'),     'true',  'owner: assign_staff_shops');
select is(pg_temp.cap('view_assigned_products'), 'true',  'owner: view_assigned_products');
select is(pg_temp.cap('submit_receipts'),        'false', 'owner: submit_receipts is FALSE — RECEIPT_SUBMIT is SALES_STAFF only');

-- ============================================================================
-- SECTION E — Retailer Manager
--
-- The view_shops assertion is the point of this section. A RETAILER_MANAGER
-- HOLDS the RETAILER_SHOPS_READ permission, but the shops screen is served by
-- list_retailer_owner_portal_shops(), which resolves through the OWNER resolver
-- and hard-filters r.code = 'RETAILER_OWNER'. A permission-derived capability
-- would report true here and send both clients to a screen the database refuses.
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'manager1'));

select is(pg_temp.ctx() ->> 'portal_kind', 'RETAILER_MANAGER', 'Retailer Manager -> RETAILER_MANAGER');
select is(pg_temp.ctx() #>> '{retailer,organization_id}',
          (select id::text from t_ids where label = 'retailer1'),
          'manager resolves their own Retailer organization');
select is(pg_temp.ctx() #>> '{retailer,organization_name}', 'Test Retailer One',
          'manager CAN read their own Retailer name (closes audit gap Q3 / D-6)');

select is(pg_temp.cap('view_retailer_overview'), 'false', 'manager: view_retailer_overview is FALSE (owner-gated)');
select is(pg_temp.cap('view_shops'),             'false', 'manager: view_shops is FALSE despite HOLDING RETAILER_SHOPS_READ');
select is(pg_temp.cap('view_staff'),             'true',  'manager: view_staff');
select is(pg_temp.cap('manage_staff'),           'false', 'manager: manage_staff is FALSE');
select is(pg_temp.cap('assign_staff_shops'),     'false', 'manager: assign_staff_shops is FALSE');
select is(pg_temp.cap('view_assigned_products'), 'true',  'manager: view_assigned_products');
select is(pg_temp.cap('submit_receipts'),        'false', 'manager: submit_receipts is FALSE');

-- ============================================================================
-- SECTION F — Sales Staff
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'sales1'));

select is(pg_temp.ctx() ->> 'portal_kind', 'SALES_STAFF', 'Sales Staff -> SALES_STAFF');
select is(pg_temp.ctx() #>> '{retailer,organization_name}', 'Test Retailer One',
          'sales staff receive their Retailer name');

select is(pg_temp.cap('submit_receipts'),        'true',  'sales staff: submit_receipts');
select is(pg_temp.cap('view_staff'),             'false', 'sales staff: view_staff is FALSE');
select is(pg_temp.cap('view_assigned_products'), 'false', 'sales staff: view_assigned_products is FALSE');
select is(pg_temp.cap('view_retailer_overview'), 'false',
          'sales staff: view_retailer_overview is FALSE despite HOLDING RETAILER_PORTAL_READ');

-- ============================================================================
-- SECTION G — an authenticated account with no application role
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'nobody'));
select is(pg_temp.ctx(), pg_temp.denial(), 'profile with no membership -> the canonical denial value');

-- ============================================================================
-- SECTION H — memberships that must not authorize
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'invited'));
select is(pg_temp.ctx(), pg_temp.denial(), 'INVITED membership -> denied');

select pg_temp.act_as((select id from t_ids where label = 'suspended_mem'));
select is(pg_temp.ctx(), pg_temp.denial(), 'SUSPENDED membership -> denied');

select pg_temp.act_as((select id from t_ids where label = 'susp_org_owner'));
select is(pg_temp.ctx(), pg_temp.denial(), 'owner of a SUSPENDED organization -> denied');

-- ============================================================================
-- SECTION I — ambiguous multi-Retailer membership fails closed
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'ambiguous'));

select is(pg_temp.ctx(), pg_temp.denial(),
          'owner of TWO Retailers -> denied, never an arbitrary pick');

-- ============================================================================
-- SECTION J — tenant isolation
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'owner2'));

select is(pg_temp.ctx() #>> '{retailer,organization_id}',
          (select id::text from t_ids where label = 'retailer2'),
          'owner2 resolves retailer2');
select isnt(pg_temp.ctx() #>> '{retailer,organization_id}',
            (select id::text from t_ids where label = 'retailer1'),
            'owner2 never sees retailer1');
select is(pg_temp.ctx() #>> '{retailer,organization_name}', 'Test Retailer Two',
          'owner2 sees only their own tenant name');

-- ============================================================================
-- SECTION K — role precedence, and the dual-role caller
--
-- Vendor-first for ROUTING, but the retailer block is still resolved, so a
-- caller who holds both can enter the Retailer portal without a second lookup.
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'dual'));

select is(pg_temp.ctx() ->> 'portal_kind', 'VENDOR_SUPER_ADMIN',
          'dual-role caller routes Vendor-first');
select is(pg_temp.ctx() #>> '{vendor,organization_id}',
          (select id::text from t_ids where label = 'vendor_org'),
          'dual-role caller keeps a vendor block');
select is(pg_temp.ctx() #>> '{retailer,kind}', 'RETAILER_OWNER',
          'dual-role caller ALSO keeps their retailer block');

-- ============================================================================
-- SECTION L — malformed / incomplete membership data
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label = 'noroles'));
select is(pg_temp.ctx(), pg_temp.denial(), 'ACTIVE membership carrying no role -> denied');

select pg_temp.act_as((select id from t_ids where label = 'permless'));
select is(pg_temp.ctx(), pg_temp.denial(), 'ACTIVE role mapped to no permission -> denied');

-- ============================================================================
-- SECTION M — generic denial: every refusal is indistinguishable
-- ============================================================================
-- Impersonation and evaluation are sequenced explicitly in plpgsql. Expressing
-- this as a single SELECT would leave "set the GUC, then call the function" to
-- the planner's evaluation order, which is not guaranteed and would make the
-- assertion quietly meaningless rather than failing.
create function pg_temp.distinct_results(p_labels text[]) returns bigint
language plpgsql as $$
declare
  v_label   text;
  v_id      uuid;
  v_results jsonb[] := '{}';
begin
  foreach v_label in array p_labels loop
    select id into v_id from pg_temp.t_ids where label = v_label;
    perform pg_temp.act_as(v_id);
    v_results := v_results || public.get_my_portal_context();
  end loop;

  return (select count(distinct x) from unnest(v_results) as x);
end;
$$;

select is(
  pg_temp.distinct_results(array[
    'nobody', 'invited', 'suspended_mem', 'ambiguous',
    'noroles', 'permless', 'susp_org_owner'
  ]),
  1::bigint,
  'all seven distinct denial causes return ONE identical value — not an oracle'
);

-- ============================================================================
-- SECTION N — catalogue mutations (last: these edit seeded rows)
-- ============================================================================
update public.roles set status = 'INACTIVE' where code = 'SALES_STAFF';

select pg_temp.act_as((select id from t_ids where label = 'inactive_role'));
select is(pg_temp.ctx(), pg_temp.denial(), 'membership through an INACTIVE role -> denied');

select pg_temp.act_as((select id from t_ids where label = 'sales1'));
select is(pg_temp.ctx(), pg_temp.denial(),
          'deactivating a role revokes the experience immediately, with no code change');

select * from finish();

rollback;
