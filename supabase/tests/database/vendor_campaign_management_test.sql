-- pgTAP behavioural tests for the Vendor CAMPAIGN MANAGEMENT contract:
--
--   Retailer groups          [20260815090000 storage, 20260815210000 operations]
--     public.list_vendor_retailer_groups()
--     public.get_vendor_retailer_group(uuid)
--     public.list_vendor_retailer_group_members(uuid)
--     public.create_vendor_retailer_group(text, text)
--     public.update_vendor_retailer_group(uuid, text, text, text)
--     public.set_vendor_retailer_group_members(uuid, uuid[])
--
--   Vendor campaigns
--     public.list_vendor_campaigns()
--     public.get_vendor_campaign(uuid)
--     public.get_vendor_campaign_version(uuid)
--     public.list_vendor_campaign_version_retailers(uuid)
--     public.list_vendor_campaign_version_groups(uuid)
--     public.list_vendor_campaign_version_products(uuid)
--     public.list_vendor_campaign_eligible_retailers(uuid)
--     public.preview_vendor_campaign_publication(uuid)
--     public.create_vendor_campaign_draft(19 args)
--     public.update_vendor_campaign_draft(20 args)
--     public.publish_vendor_campaign(uuid)
--     public.set_vendor_campaign_lifecycle(uuid, text)
--     public.create_vendor_campaign_version(uuid)
--
--   Assigned visibility
--     public.list_my_retailer_campaigns()      public.get_my_retailer_campaign(uuid)
--     public.list_my_retailer_campaign_products(uuid)
--     public.list_my_staff_campaigns()         public.get_my_staff_campaign(uuid)
--     public.list_my_staff_campaign_products(uuid)
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- The campaign milestone introduces the first objects in this schema that are IMMUTABLE
-- AFTER AN EVENT rather than immutable from creation, and the first that must keep
-- telling the truth about a moment in the past while the world moves on around them. So
-- the sections below are weighted towards exactly those two claims:
--
--   * a published version, and every table describing it, cannot change (Section F);
--   * a published SNAPSHOT survives a later group edit and a later product-assignment
--     change, in both directions (Section H).
--
-- Everything else — authorization, tenant isolation, validation, lifecycle, visibility —
-- is covered because a wrong answer there is a disclosure or a lost promise, not merely
-- a bug.
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as
-- the `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as
-- far as every authorization helper in this schema is concerned. pg_temp.act_as() does
-- exactly that and pg_temp.sign_out() clears it. This mirrors vendor_product_writes_test,
-- portal_context_test and every other suite in this directory — one idiom for "signed
-- in", not seven.
--
-- The tests deliberately do NOT `set role authenticated`. Every function under test is
-- SECURITY DEFINER, so its behaviour depends on auth.uid() and not on the session role,
-- and switching roles mid-transaction would only make the fixture inserts fail. EXECUTE
-- privilege is asserted directly against the catalogue in Section A, which is stronger
-- than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back: no campaign, group,
-- snapshot or audit row written below survives.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file
-- turns an added test into a confusing failure about arithmetic rather than about
-- behaviour.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers — the same shapes the product and lifecycle suites use
-- ============================================================================
create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text)::text, true);
end;
$$;

create function pg_temp.sign_out() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.new_person(p_first text, p_last text, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || lower(p_last) || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, p_status);
  return v_id;
end;
$$;

create function pg_temp.new_org(p_name text, p_type text default 'VENDOR', p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.organizations (name, organization_type, status, country_code, default_currency)
  values (p_name, p_type, p_status, 'AE', 'AED')
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.add_member(p_user uuid, p_org uuid, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_member uuid;
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

create function pg_temp.link(p_vendor uuid, p_retailer uuid, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (p_vendor, p_retailer, p_status)
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.raw_product(p_vendor uuid, p_code text, p_name text, p_creator uuid,
                                    p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.vendor_products (vendor_organization_id, product_code, product_name,
                                      status, created_by_profile_id)
  values (p_vendor, p_code, p_name, p_status, p_creator)
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.assign(p_product uuid, p_retailer_org uuid, p_actor uuid,
                               p_status text default 'ACTIVE')
returns void language plpgsql as $$
begin
  insert into public.vendor_product_retailer_assignments
    (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id)
  values (p_product, p_retailer_org, p_status, p_actor);
end;
$$;

/*
 * A complete, publishable draft with sensible defaults, so a test that cares about ONE
 * dimension does not have to restate the other eighteen. Every argument the test is
 * interested in is still passed explicitly at the call site.
 */
create function pg_temp.draft(
  p_name        text,
  p_audience    text default 'ALL_RETAILERS',
  p_performance text default 'INDIVIDUAL_STAFF',
  p_scope       text default 'ALL_ELIGIBLE_PRODUCTS',
  p_stacking    text default 'STACKABLE',
  p_key         text default null,
  p_rule        text default 'PER_UNIT_COINS',
  p_per_unit    bigint default 5,
  p_threshold   integer default null,
  p_bonus       bigint default null,
  p_retailers   uuid[] default null,
  p_groups      uuid[] default null,
  p_products    uuid[] default null,
  p_starts      timestamptz default null,
  p_ends        timestamptz default null
) returns uuid language plpgsql as $$
begin
  return public.create_vendor_campaign_draft(
    p_name, 'Described.', coalesce(p_starts, now() - interval '1 day'), p_ends,
    'Asia/Dubai', p_audience, p_performance, p_scope, p_stacking, p_key, 10,
    p_rule, p_per_unit, p_threshold, p_bonus, null,
    p_retailers, p_groups, p_products
  );
end;
$$;

-- ============================================================================
-- Fixture
-- ============================================================================
-- Two Vendors, so every isolation claim is tested against a real second tenant rather
-- than against an absence. Four Retailers under Vendor A: two ordinary, one whose
-- ORGANIZATION is suspended, and one whose RELATIONSHIP is suspended — the two
-- lifecycle cases the eligibility rule has to separate.
create table pg_temp.f (k text primary key, v uuid);

do $$
declare
  v_vendor_a uuid; v_vendor_b uuid;
  v_ret_a uuid; v_ret_b uuid; v_ret_susp_org uuid; v_ret_susp_rel uuid; v_ret_b_side uuid;
  v_admin_a uuid; v_admin_b uuid; v_owner_a uuid; v_owner_b uuid;
  v_staff_a uuid; v_manager_a uuid; v_inactive_owner uuid;
  v_m uuid;
begin
  v_vendor_a := pg_temp.new_org('Vendor A', 'VENDOR');
  v_vendor_b := pg_temp.new_org('Vendor B', 'VENDOR');

  v_ret_a         := pg_temp.new_org('Retailer Alpha',   'RETAILER');
  v_ret_b         := pg_temp.new_org('Retailer Bravo',   'RETAILER');
  v_ret_susp_org  := pg_temp.new_org('Retailer Charlie', 'RETAILER', 'SUSPENDED');
  v_ret_susp_rel  := pg_temp.new_org('Retailer Delta',   'RETAILER');
  v_ret_b_side    := pg_temp.new_org('Retailer Echo',    'RETAILER');

  v_admin_a   := pg_temp.new_person('Ada',  'Admin');
  v_admin_b   := pg_temp.new_person('Bob',  'Admin');
  v_owner_a   := pg_temp.new_person('Olga', 'Owner');
  v_owner_b   := pg_temp.new_person('Omar', 'Owner');
  v_staff_a   := pg_temp.new_person('Sam',  'Staff');
  v_manager_a := pg_temp.new_person('Mia',  'Manager');
  v_inactive_owner := pg_temp.new_person('Ivy', 'Inactive');

  v_m := pg_temp.add_member(v_admin_a, v_vendor_a); perform pg_temp.add_role(v_m, 'VENDOR_SUPER_ADMIN');
  v_m := pg_temp.add_member(v_admin_b, v_vendor_b); perform pg_temp.add_role(v_m, 'VENDOR_SUPER_ADMIN');
  v_m := pg_temp.add_member(v_owner_a, v_ret_a);    perform pg_temp.add_role(v_m, 'RETAILER_OWNER');
  v_m := pg_temp.add_member(v_owner_b, v_ret_b);    perform pg_temp.add_role(v_m, 'RETAILER_OWNER');
  v_m := pg_temp.add_member(v_staff_a, v_ret_a);    perform pg_temp.add_role(v_m, 'SALES_STAFF');
  v_m := pg_temp.add_member(v_manager_a, v_ret_a);  perform pg_temp.add_role(v_m, 'RETAILER_MANAGER');
  -- An INACTIVE membership in an active Retailer: the "inactive memberships are denied"
  -- case, distinct from an inactive organization.
  v_m := pg_temp.add_member(v_inactive_owner, v_ret_b, 'DEACTIVATED');
  perform pg_temp.add_role(v_m, 'RETAILER_OWNER');

  insert into pg_temp.f values
    ('vendor_a', v_vendor_a), ('vendor_b', v_vendor_b),
    ('ret_a', v_ret_a), ('ret_b', v_ret_b),
    ('ret_susp_org', v_ret_susp_org), ('ret_susp_rel', v_ret_susp_rel),
    ('ret_b_side', v_ret_b_side),
    ('admin_a', v_admin_a), ('admin_b', v_admin_b),
    ('owner_a', v_owner_a), ('owner_b', v_owner_b),
    ('staff_a', v_staff_a), ('manager_a', v_manager_a),
    ('inactive_owner', v_inactive_owner),
    ('link_a', pg_temp.link(v_vendor_a, v_ret_a)),
    ('link_b', pg_temp.link(v_vendor_a, v_ret_b)),
    ('link_susp_org', pg_temp.link(v_vendor_a, v_ret_susp_org)),
    ('link_susp_rel', pg_temp.link(v_vendor_a, v_ret_susp_rel, 'SUSPENDED')),
    ('link_b_side', pg_temp.link(v_vendor_b, v_ret_b_side));

  -- Vendor A's catalogue. P1 is assigned to both Alpha and Bravo; P2 to Alpha only —
  -- so a campaign selecting both products has a real, asymmetric assignment conflict.
  -- P3 is INACTIVE, and P_B belongs to the other Vendor entirely.
  insert into pg_temp.f values
    ('p1',   pg_temp.raw_product(v_vendor_a, 'P-1', 'Product One',   v_admin_a)),
    ('p2',   pg_temp.raw_product(v_vendor_a, 'P-2', 'Product Two',   v_admin_a)),
    ('p3',   pg_temp.raw_product(v_vendor_a, 'P-3', 'Product Three', v_admin_a, 'INACTIVE')),
    ('p_b',  pg_temp.raw_product(v_vendor_b, 'B-1', 'Bravo Product', v_admin_b));
end;
$$;

do $$
begin
  perform pg_temp.assign((select v from pg_temp.f where k='p1'), (select v from pg_temp.f where k='ret_a'), (select v from pg_temp.f where k='admin_a'));
  perform pg_temp.assign((select v from pg_temp.f where k='p1'), (select v from pg_temp.f where k='ret_b'), (select v from pg_temp.f where k='admin_a'));
  perform pg_temp.assign((select v from pg_temp.f where k='p2'), (select v from pg_temp.f where k='ret_a'), (select v from pg_temp.f where k='admin_a'));
  perform pg_temp.assign((select v from pg_temp.f where k='p3'), (select v from pg_temp.f where k='ret_a'), (select v from pg_temp.f where k='admin_a'));
end;
$$;

create function pg_temp.id(p_key text) returns uuid
language sql stable as $$ select v from pg_temp.f where k = p_key $$;

-- ============================================================================
-- SECTION A — the privilege surface, asserted against the catalogue
-- ============================================================================
-- Stronger than "it did not error for me": these read pg_proc and pg_class directly, so
-- a future migration that grants a browser role table access, or forgets to revoke a
-- helper, fails here rather than in production.
select is(
  (select count(*)::integer
   from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'campaign%'
     and (has_table_privilege('authenticated', c.oid, 'SELECT')
       or has_table_privilege('authenticated', c.oid, 'INSERT')
       or has_table_privilege('authenticated', c.oid, 'UPDATE')
       or has_table_privilege('authenticated', c.oid, 'DELETE'))),
  0,
  'A1. no campaign table grants any privilege to authenticated'
);

select is(
  (select count(*)::integer
   from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'campaign%'
     and not c.relrowsecurity),
  0,
  'A2. every campaign table has row level security enabled'
);

select is(
  (select count(*)::integer
   from pg_catalog.pg_policy p
   join pg_catalog.pg_class c on c.oid = p.polrelid
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname like 'campaign%'),
  0,
  'A3. no campaign table carries a policy — default deny is the whole design'
);

select ok(
  has_function_privilege('authenticated', 'public.list_vendor_campaigns()', 'EXECUTE'),
  'A4. authenticated may execute the Vendor campaign list RPC'
);

select ok(
  not has_function_privilege('authenticated',
    'public.resolve_campaign_vendor_organization(text)', 'EXECUTE'),
  'A5. the internal Vendor resolver is NOT reachable by a browser'
);

select ok(
  not has_function_privilege('authenticated',
    'public.campaign_apply_draft_config(uuid, uuid, timestamptz, timestamptz, text, text, text, text, text, text, integer, text, bigint, integer, bigint, bigint, uuid[], uuid[], uuid[])',
    'EXECUTE'),
  'A6. the internal draft-config writer is NOT reachable by a browser'
);

select ok(
  not has_function_privilege('anon', 'public.publish_vendor_campaign(uuid)', 'EXECUTE'),
  'A7. an anonymous caller cannot publish'
);

select ok(
  not has_function_privilege('service_role', 'public.publish_vendor_campaign(uuid)', 'EXECUTE'),
  'A8. service_role is granted no campaign path — every write needs a session'
);

-- ============================================================================
-- SECTION B — authorization and tenant isolation
-- ============================================================================
select pg_temp.sign_out();

select throws_ok(
  $$ select * from public.list_vendor_campaigns() $$,
  '42501',
  'Not authorized to view campaigns',
  'B1. a signed-out caller is refused'
);

select pg_temp.act_as(pg_temp.id('owner_a'));

select throws_ok(
  $$ select * from public.list_vendor_campaigns() $$,
  '42501', null,
  'B2. a Retailer Owner cannot manage campaigns'
);

select throws_ok(
  $$ select * from public.list_vendor_retailer_groups() $$,
  '42501', null,
  'B3. a Retailer Owner cannot manage Retailer groups'
);

select pg_temp.act_as(pg_temp.id('staff_a'));

select throws_ok(
  $$ select * from public.list_vendor_campaigns() $$,
  '42501', null,
  'B4. a Sales Staff member cannot manage campaigns'
);

-- RETAILER_MANAGER: the approved scope for this milestone grants them NOTHING. Asserted
-- rather than assumed, so a future role_permissions row that widened them silently would
-- fail here.
select pg_temp.act_as(pg_temp.id('manager_a'));

select throws_ok(
  $$ select * from public.list_my_retailer_campaigns() $$,
  '42501', null,
  'B5. a Retailer Manager receives NO assigned-campaign visibility (deferred by design)'
);

select is(
  (select count(*)::integer
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'RETAILER_MANAGER'
     and p.code in ('CAMPAIGNS_VIEW_ASSIGNED', 'STAFF_CAMPAIGNS_VIEW', 'CAMPAIGNS_MANAGE',
                    'RETAILER_GROUPS_MANAGE')),
  0,
  'B6. RETAILER_MANAGER holds no campaign permission mapping at all'
);

-- An INACTIVE membership is denied even though the person holds the right role in an
-- active organization: the resolver requires an ACTIVE membership.
select pg_temp.act_as(pg_temp.id('inactive_owner'));

select throws_ok(
  $$ select * from public.list_my_retailer_campaigns() $$,
  '42501', null,
  'B7. an inactive membership is denied assigned-campaign visibility'
);

-- ============================================================================
-- SECTION C — Retailer groups
-- ============================================================================
select pg_temp.act_as(pg_temp.id('admin_a'));

select lives_ok(
  $$ select public.create_vendor_retailer_group('  Premium   Dubai  ', '  Top shops  ') $$,
  'C1. a Vendor Super Admin can create a group'
);

-- Normalization is the DATABASE'S rule, not the form's: the stored name is trimmed and
-- whitespace-collapsed, which is what makes the unique index compare like with like.
select is(
  (select name from public.campaign_retailer_groups
   where vendor_organization_id = pg_temp.id('vendor_a')),
  'Premium Dubai',
  'C2. the group name is normalized in SQL, not merely in the client'
);

select throws_ok(
  $$ select public.create_vendor_retailer_group('premium dubai', null) $$,
  '23505', 'A group with that name already exists',
  'C3. group names are unique per Vendor, case-insensitively'
);

select throws_ok(
  $$ select public.create_vendor_retailer_group('   ', null) $$,
  '23514', 'Enter a group name',
  'C4. a blank group name is refused'
);

-- Vendor B may reuse the name: the index is scoped per Vendor, so a failed insert cannot
-- be an oracle for a competitor's group names.
select pg_temp.act_as(pg_temp.id('admin_b'));
select lives_ok(
  $$ select public.create_vendor_retailer_group('Premium Dubai', null) $$,
  'C5. a different Vendor may reuse a group name'
);

select pg_temp.act_as(pg_temp.id('admin_a'));

-- Vendor A's one group, resolved by OWNER rather than by name: C22 renames it, and a
-- helper that looked the name up would silently start returning NULL from that point on
-- — which reads as a validation failure in a later section rather than as a broken
-- fixture. Vendor A creates exactly one group in this suite, so the owner is a key.
create function pg_temp.group_a() returns uuid language sql stable as $$
  select id from public.campaign_retailer_groups
  where vendor_organization_id = pg_temp.id('vendor_a')
$$;

select lives_ok(
  format($$ select * from public.set_vendor_retailer_group_members(%L, array[%L, %L]::uuid[]) $$,
         pg_temp.group_a(), pg_temp.id('link_a'), pg_temp.id('link_b')),
  'C6. members can be added'
);

select is(
  (select member_count from public.get_vendor_retailer_group(pg_temp.group_a())),
  2,
  'C7. the group reports two live members'
);

-- A foreign relationship id is refused for the WHOLE call, so the operator never believes
-- they saved a set they did not, and the refusal is the generic authorization message so
-- it cannot be used to probe another Vendor's relationships.
select throws_ok(
  format($$ select * from public.set_vendor_retailer_group_members(%L, array[%L, %L]::uuid[]) $$,
         pg_temp.group_a(), pg_temp.id('link_a'), pg_temp.id('link_b_side')),
  '42501', 'Not authorized to manage Retailer groups',
  'C8. another Vendor''s Retailer relationship cannot be added'
);

select is(
  (select member_count from public.get_vendor_retailer_group(pg_temp.group_a())),
  2,
  'C9. the refused call changed nothing'
);

select throws_ok(
  format($$ select * from public.set_vendor_retailer_group_members(%L, array[%L]::uuid[]) $$,
         pg_temp.group_a(), pg_temp.id('link_susp_rel')),
  '55000', 'Only active Retailers can be added to a group',
  'C10. a SUSPENDED relationship cannot be added'
);

select throws_ok(
  format($$ select * from public.set_vendor_retailer_group_members(%L, array[%L]::uuid[]) $$,
         pg_temp.group_a(), pg_temp.id('link_susp_org')),
  '55000', null,
  'C11. a relationship to a SUSPENDED Retailer organization cannot be added'
);

-- Re-saving the same set is a no-op: nothing added, nothing removed, and no audit row.
select is(
  (select members_added || '/' || members_removed || '/' || members_unchanged
   from public.set_vendor_retailer_group_members(
     pg_temp.group_a(), array[pg_temp.id('link_a'), pg_temp.id('link_b')]::uuid[])),
  '0/0/2',
  'C12. re-saving an unchanged set adds and removes nothing'
);

select is(
  (select count(*)::integer from public.audit_logs
   where action = 'RETAILER_GROUP_MEMBERS_CHANGED'),
  1,
  'C13. the no-op membership save wrote NO second audit event'
);

-- Duplicate live membership is structurally impossible: the partial unique index is the
-- concurrency authority, and the contract canonicalizes duplicates before it gets there.
select is(
  (select members_added from public.set_vendor_retailer_group_members(
     pg_temp.group_a(),
     array[pg_temp.id('link_a'), pg_temp.id('link_a'), pg_temp.id('link_b')]::uuid[])),
  0,
  'C14. a duplicated id in the input creates no second live membership'
);

select is(
  (select count(*)::integer from public.campaign_retailer_group_members
   where campaign_retailer_group_id = pg_temp.group_a() and removed_at is null),
  2,
  'C15. exactly two live memberships remain'
);

-- Removal is SOFT: the row survives with removed_at stamped, so the history a published
-- snapshot may need to explain is never destroyed.
select is(
  (select members_removed from public.set_vendor_retailer_group_members(
     pg_temp.group_a(), array[pg_temp.id('link_a')]::uuid[])),
  1,
  'C16. removing a member reports one removal'
);

select is(
  (select count(*)::integer from public.campaign_retailer_group_members
   where campaign_retailer_group_id = pg_temp.group_a() and removed_at is not null),
  1,
  'C17. the removed membership row SURVIVES with removed_at stamped'
);

-- Re-adding inserts a NEW live row rather than clearing the old one's removed_at.
select is(
  (select members_added from public.set_vendor_retailer_group_members(
     pg_temp.group_a(), array[pg_temp.id('link_a'), pg_temp.id('link_b')]::uuid[])),
  1,
  'C18. re-adding a removed member adds a new membership'
);

select is(
  (select count(*)::integer from public.campaign_retailer_group_members
   where campaign_retailer_group_id = pg_temp.group_a()
     and vendor_retailer_id = pg_temp.id('link_b')),
  2,
  'C19. re-adding left the historical removal intact — two rows, one live'
);

select is(
  (select changed from public.update_vendor_retailer_group(
     pg_temp.group_a(), 'Premium Dubai', 'Top shops', null)),
  false,
  'C20. renaming to the identical values reports no change'
);

select is(
  (select count(*)::integer from public.audit_logs where action = 'RETAILER_GROUP_UPDATED'),
  0,
  'C21. the no-op rename wrote no audit event'
);

select is(
  (select changed from public.update_vendor_retailer_group(
     pg_temp.group_a(), 'Premium UAE', 'Top shops', null)),
  true,
  'C22. a real rename reports a change'
);

-- Cross-Vendor: Vendor B can neither see nor address Vendor A's group. A foreign id and
-- an unknown id are the same answer.
select pg_temp.act_as(pg_temp.id('admin_b'));

select is(
  (select count(*)::integer from public.get_vendor_retailer_group(pg_temp.group_a())),
  0,
  'C23. another Vendor addressing the group by id gets zero rows'
);

select is(
  (select count(*)::integer from public.list_vendor_retailer_group_members(pg_temp.group_a())),
  0,
  'C24. another Vendor cannot enumerate the group''s members'
);

select throws_ok(
  format($$ select * from public.set_vendor_retailer_group_members(%L, array[]::uuid[]) $$,
         pg_temp.group_a()),
  '42501', null,
  'C25. another Vendor cannot empty the group'
);

select is(
  (select count(*)::integer from public.get_vendor_retailer_group(gen_random_uuid())),
  0,
  'C26. an unknown group id is indistinguishable from a foreign one'
);

-- ============================================================================
-- SECTION D — campaign validation
-- ============================================================================
select pg_temp.act_as(pg_temp.id('admin_a'));

select throws_ok(
  $$ select pg_temp.draft('   ') $$,
  '23514', 'Enter a campaign name',
  'D1. a blank campaign name is refused'
);

select throws_ok(
  $$ select public.create_vendor_campaign_draft('X', null, null, null, 'Asia/Dubai',
       'ALL_RETAILERS','INDIVIDUAL_STAFF','ALL_ELIGIBLE_PRODUCTS','STACKABLE',null,0,
       'PER_UNIT_COINS',5,null,null,null,null,null,null) $$,
  '23514', 'Enter a start date',
  'D2. a missing start date is refused'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_starts => now(), p_ends => now() - interval '1 hour') $$,
  '23514', 'The end date must be after the start date',
  'D3. an end at or before the start is refused'
);

select throws_ok(
  $$ select public.create_vendor_campaign_draft('X', null, now(), null, 'Mars/Olympus',
       'ALL_RETAILERS','INDIVIDUAL_STAFF','ALL_ELIGIBLE_PRODUCTS','STACKABLE',null,0,
       'PER_UNIT_COINS',5,null,null,null,null,null,null) $$,
  '23514', 'Choose a valid campaign time zone',
  'D4. an unknown IANA time zone is refused BY THE DATABASE, not by a client list'
);

select lives_ok(
  $$ select public.create_vendor_campaign_draft('Evergreen ok', null, now(), null,
       'America/Argentina/Buenos_Aires',
       'ALL_RETAILERS','INDIVIDUAL_STAFF','ALL_ELIGIBLE_PRODUCTS','STACKABLE',null,0,
       'PER_UNIT_COINS',5,null,null,null,null,null,null) $$,
  'D5. a real, unusual IANA zone is accepted'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_audience => 'SELECTED_RETAILERS', p_retailers => array[]::uuid[]) $$,
  '23514', 'Select at least one Retailer',
  'D6. SELECTED_RETAILERS with an empty selection is refused'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_audience => 'RETAILER_GROUPS', p_groups => array[]::uuid[]) $$,
  '23514', 'Select at least one Retailer group',
  'D7. RETAILER_GROUPS with no group is refused'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_scope => 'SELECTED_PRODUCTS', p_products => array[]::uuid[]) $$,
  '23514', 'Select at least one product',
  'D8. SELECTED_PRODUCTS with no product is refused'
);

select throws_ok(
  format($$ select pg_temp.draft('X', p_scope => 'SELECTED_PRODUCTS', p_products => array[%L]::uuid[]) $$,
         pg_temp.id('p_b')),
  '42501', 'Not authorized to manage campaigns',
  'D9. another Vendor''s product cannot be selected'
);

select throws_ok(
  format($$ select pg_temp.draft('X', p_audience => 'SELECTED_RETAILERS', p_retailers => array[%L]::uuid[]) $$,
         pg_temp.id('link_b_side')),
  '42501', null,
  'D10. another Vendor''s Retailer cannot be targeted'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_stacking => 'EXCLUSIVE', p_key => '   ') $$,
  '23514', 'Enter an exclusivity key for an exclusive campaign',
  'D11. EXCLUSIVE without a key is refused'
);

select lives_ok(
  $$ select pg_temp.draft('Stackable no key', p_stacking => 'STACKABLE', p_key => null) $$,
  'D12. STACKABLE does NOT require an exclusivity key'
);

-- A key supplied alongside STACKABLE is forced to NULL rather than merely ignored, so a
-- stackable version can never look like it competes with something.
select is(
  (select exclusivity_key from public.campaign_versions cv
   join public.campaigns c on c.id = cv.campaign_id
   where c.name = 'Stackable no key'),
  null,
  'D13. a stackable version stores no exclusivity key'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_rule => 'PER_UNIT_COINS', p_per_unit => 0) $$,
  '23514', 'Enter coins per unit between 1 and 1,000,000,000',
  'D14. zero coins per unit is refused'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_rule => 'PER_UNIT_COINS', p_per_unit => -5) $$,
  '23514', null,
  'D15. a negative coin rate is refused'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_rule => 'TARGET_BONUS', p_per_unit => null,
                          p_threshold => 0, p_bonus => 100) $$,
  '23514', 'Enter the unit target',
  'D16. a zero unit target is refused'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_rule => 'TARGET_BONUS', p_per_unit => null,
                          p_threshold => 10, p_bonus => 0) $$,
  '23514', 'Enter bonus coins between 1 and 1,000,000,000',
  'D17. a zero bonus is refused'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_performance => 'EVERYBODY') $$,
  '23514', 'Choose how performance is measured',
  'D18. an unknown performance scope is refused'
);

select throws_ok(
  $$ select pg_temp.draft('X', p_rule => 'PERCENTAGE_OF_SALES') $$,
  '23514', 'Choose a reward type',
  'D19. percentage-of-sales is NOT a reward type in this milestone'
);

select throws_ok(
  $$ select public.create_vendor_campaign_draft('X', null, now(), null, 'Asia/Dubai',
       'ALL_RETAILERS','INDIVIDUAL_STAFF','ALL_ELIGIBLE_PRODUCTS','STACKABLE',null,5000,
       'PER_UNIT_COINS',5,null,null,null,null,null,null) $$,
  '23514', 'Priority must be between 0 and 1000',
  'D20. an out-of-range priority is refused'
);

-- Coins are integers end to end. bigint arguments cannot carry a fraction at all, which
-- is the point: there is no rounding rule to get wrong later.
select is(
  (select count(*)::integer
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_vendor_campaign_draft', 'update_vendor_campaign_draft')
     and (pg_catalog.pg_get_function_arguments(p.oid) like '%numeric%'
       or pg_catalog.pg_get_function_arguments(p.oid) like '%double precision%'
       or pg_catalog.pg_get_function_arguments(p.oid) like '%real%')),
  0,
  'D21. no draft contract accepts a floating-point or numeric reward value'
);

-- ============================================================================
-- SECTION E — publishing and the eligibility snapshot
-- ============================================================================
-- The campaign under test: a group audience, selected products, and an assignment
-- conflict built into the fixture — P-2 is assigned to Alpha but not to Bravo.
do $$
declare v_c uuid;
begin
  perform pg_temp.act_as(pg_temp.id('admin_a'));
  v_c := pg_temp.draft(
    'Winter Push',
    p_audience  => 'RETAILER_GROUPS',
    p_scope     => 'SELECTED_PRODUCTS',
    p_stacking  => 'EXCLUSIVE',
    p_key       => 'winter bonus',
    p_rule      => 'TARGET_BONUS',
    p_per_unit  => null,
    p_threshold => 10,
    p_bonus     => 100,
    p_groups    => array[pg_temp.group_a()]::uuid[],
    p_products  => array[pg_temp.id('p1'), pg_temp.id('p2')]::uuid[]
  );
  insert into pg_temp.f values ('winter', v_c);
end;
$$;

create function pg_temp.draft_version(p_campaign uuid) returns uuid
language sql stable as $$
  select draft_version_id from public.get_vendor_campaign(p_campaign)
$$;

create function pg_temp.live_version(p_campaign uuid) returns uuid
language sql stable as $$
  select published_version_id from public.get_vendor_campaign(p_campaign)
$$;

select is(
  (select exclusivity_key from public.get_vendor_campaign_version(
     pg_temp.draft_version(pg_temp.id('winter')))),
  'WINTER BONUS',
  'E1. the exclusivity key is normalized upper-case by the DATABASE'
);

select is(
  (select derived_state from public.get_vendor_campaign(pg_temp.id('winter'))),
  'DRAFT',
  'E2. an unpublished campaign derives DRAFT'
);

-- The preview shows the conflict BEFORE the operator commits: Bravo holds one of the two
-- selected products, so one is missing there.
select is(
  (select missing_product_count from public.preview_vendor_campaign_publication(
     pg_temp.draft_version(pg_temp.id('winter')))
   where retailer_name = 'Retailer Bravo'),
  1,
  'E3. the pre-publication preview surfaces the unassigned-product conflict'
);

select is(
  (select missing_product_count from public.preview_vendor_campaign_publication(
     pg_temp.draft_version(pg_temp.id('winter')))
   where retailer_name = 'Retailer Alpha'),
  0,
  'E4. the preview reports no conflict where every selected product is assigned'
);

select is(
  (select published from public.publish_vendor_campaign(pg_temp.id('winter'))),
  true,
  'E5. publishing reports that it published'
);

select is(
  (select campaign_status from public.get_vendor_campaign(pg_temp.id('winter'))),
  'PUBLISHED',
  'E6. the campaign moved to PUBLISHED'
);

select is(
  (select derived_state from public.get_vendor_campaign(pg_temp.id('winter'))),
  'ACTIVE',
  'E7. inside its period the campaign DERIVES ACTIVE with no scheduled job'
);

select is(
  (select draft_version_id from public.get_vendor_campaign(pg_temp.id('winter'))),
  null,
  'E8. publication cleared the draft pointer'
);

-- THE DETERMINISTIC PRODUCT RULE: an unassigned selected product is EXCLUDED for that
-- Retailer, never silently included.
select is(
  (select eligible_product_count from public.list_vendor_campaign_eligible_retailers(
     pg_temp.live_version(pg_temp.id('winter'))) where retailer_name = 'Retailer Alpha'),
  2,
  'E9. Alpha, which holds both selected products, is eligible for both'
);

select is(
  (select eligible_product_count from public.list_vendor_campaign_eligible_retailers(
     pg_temp.live_version(pg_temp.id('winter'))) where retailer_name = 'Retailer Bravo'),
  1,
  'E10. Bravo is eligible only for the product actually assigned to it'
);

select is(
  (select count(*)::integer from public.campaign_eligible_products ep
   where ep.campaign_version_id = pg_temp.live_version(pg_temp.id('winter'))
     and ep.vendor_product_id = pg_temp.id('p2')
     and ep.retailer_organization_id = pg_temp.id('ret_b')),
  0,
  'E11. the unassigned pair was NOT written into the snapshot'
);

select is(
  (select source from public.list_vendor_campaign_eligible_retailers(
     pg_temp.live_version(pg_temp.id('winter'))) where retailer_name = 'Retailer Alpha'),
  'RETAILER_GROUP',
  'E12. the snapshot records WHY the Retailer was eligible'
);

-- IDEMPOTENCE. A second publish is an explicit no-op: no new version, no duplicate
-- snapshot row, and no second audit event.
select is(
  (select published from public.publish_vendor_campaign(pg_temp.id('winter'))),
  false,
  'E13. publishing twice is an explicit no-op, not an error'
);

select is(
  (select count(*)::integer from public.campaign_eligible_retailers
   where campaign_version_id = pg_temp.live_version(pg_temp.id('winter'))),
  2,
  'E14. the duplicate publish created no duplicate snapshot rows'
);

select is(
  (select count(*)::integer from public.campaign_versions
   where campaign_id = pg_temp.id('winter')),
  1,
  'E15. the duplicate publish created no second version'
);

select is(
  (select count(*)::integer from public.audit_logs
   where action = 'CAMPAIGN_PUBLISHED' and entity_id = pg_temp.id('winter')::text),
  1,
  'E16. the duplicate publish wrote no second audit event'
);

-- Both counts must agree between the publishing branch and the no-op branch.
select is(
  (select eligible_product_count from public.publish_vendor_campaign(pg_temp.id('winter'))),
  (select count(*)::integer from public.campaign_eligible_products
   where campaign_version_id = pg_temp.live_version(pg_temp.id('winter'))),
  'E17. the no-op branch reports the same product count the snapshot holds'
);

-- SUSPENDED lifecycle states are EXCLUDED from the snapshot rather than frozen into it.
do $$
declare v_c uuid;
begin
  v_c := pg_temp.draft('All Retailers Team',
    p_audience => 'ALL_RETAILERS', p_performance => 'RETAILER_TEAM');
  perform public.publish_vendor_campaign(v_c);
  insert into pg_temp.f values ('team', v_c);
end;
$$;

select is(
  (select count(*)::integer from public.list_vendor_campaign_eligible_retailers(
     pg_temp.live_version(pg_temp.id('team')))),
  2,
  'E18. ALL_RETAILERS resolves to the two ACTIVE Retailers only'
);

select is(
  (select count(*)::integer from public.campaign_eligible_retailers
   where campaign_version_id = pg_temp.live_version(pg_temp.id('team'))
     and vendor_retailer_id in (pg_temp.id('link_susp_org'), pg_temp.id('link_susp_rel'))),
  0,
  'E19. a suspended Retailer and a suspended relationship are both excluded'
);

-- One row per Retailer is what forbids a RETAILER_TEAM total from spanning two.
select is(
  (select count(*)::integer from (
     select vendor_retailer_id from public.campaign_eligible_retailers
     where campaign_version_id = pg_temp.live_version(pg_temp.id('team'))
     group by vendor_retailer_id having count(*) > 1) dupes),
  0,
  'E20. a RETAILER_TEAM snapshot holds exactly one row per Retailer'
);

-- Publication is refused rather than producing an empty promise.
select throws_ok(
  format($$ select public.publish_vendor_campaign(
      pg_temp.draft('Nobody', p_audience => 'SELECTED_RETAILERS',
                    p_retailers => array[%L]::uuid[])) $$, pg_temp.id('link_susp_rel')),
  '55000', 'This campaign does not currently apply to any active Retailer',
  'E21. a campaign resolving to no active Retailer cannot be published'
);

select throws_ok(
  format($$ select public.publish_vendor_campaign(
      pg_temp.draft('No products', p_audience => 'SELECTED_RETAILERS',
                    p_retailers => array[%L]::uuid[],
                    p_scope => 'SELECTED_PRODUCTS',
                    p_products => array[%L]::uuid[])) $$,
         pg_temp.id('link_b'), pg_temp.id('p2')),
  '55000', 'None of the selected products is assigned to an eligible Retailer',
  'E22. a campaign whose selected products reach nobody cannot be published'
);

-- ============================================================================
-- SECTION F — a published version is immutable, in every table that describes it
-- ============================================================================
select throws_ok(
  format($$ update public.campaign_versions set starts_at = now() where id = %L $$,
         pg_temp.live_version(pg_temp.id('winter'))),
  '23514', 'A published campaign version is immutable; create a new version',
  'F1. a published version''s dates cannot be changed'
);

select throws_ok(
  format($$ update public.campaign_versions set audience_mode = 'ALL_RETAILERS' where id = %L $$,
         pg_temp.live_version(pg_temp.id('winter'))),
  '23514', null,
  'F2. a published version''s audience mode cannot be changed'
);

select throws_ok(
  format($$ delete from public.campaign_versions where id = %L $$,
         pg_temp.live_version(pg_temp.id('winter'))),
  '23514', 'A published campaign version cannot be deleted',
  'F3. a published version cannot be deleted'
);

-- "Immutable" has to mean the WHOLE configuration, not merely the row that heads it.
select throws_ok(
  format($$ insert into public.campaign_version_retailers (campaign_version_id, vendor_retailer_id)
            values (%L, %L) $$,
         pg_temp.live_version(pg_temp.id('winter')), pg_temp.id('link_a')),
  '23514', 'A published campaign version is immutable; create a new version',
  'F4. a Retailer cannot be added to a published version'
);

select throws_ok(
  format($$ delete from public.campaign_version_products where campaign_version_id = %L $$,
         pg_temp.live_version(pg_temp.id('winter'))),
  '23514', null,
  'F5. a published version''s selected products cannot be deleted'
);

select throws_ok(
  format($$ update public.campaign_rules set coins_per_unit = 999
            where campaign_version_id = %L $$, pg_temp.live_version(pg_temp.id('winter'))),
  '23514', null,
  'F6. a published version''s reward rule cannot be edited'
);

select throws_ok(
  format($$ update public.campaign_rule_tiers set reward_coins = 999
            where campaign_rule_id in (select id from public.campaign_rules
                                       where campaign_version_id = %L) $$,
         pg_temp.live_version(pg_temp.id('winter'))),
  '23514', null,
  'F7. a published version''s reward tier cannot be edited'
);

select throws_ok(
  format($$ update public.campaign_eligible_retailers set source = 'ALL_RETAILERS'
            where campaign_version_id = %L $$, pg_temp.live_version(pg_temp.id('winter'))),
  '23514', 'A published campaign eligibility snapshot is immutable',
  'F8. a snapshot row cannot be updated'
);

select throws_ok(
  format($$ delete from public.campaign_eligible_products where campaign_version_id = %L $$,
         pg_temp.live_version(pg_temp.id('winter'))),
  '23514', null,
  'F9. a snapshot row cannot be deleted'
);

-- The RPC path refuses before the trigger ever fires, with a message an operator can act
-- on rather than a constraint name.
select pg_temp.act_as(pg_temp.id('admin_a'));

select throws_ok(
  format($$ select * from public.update_vendor_campaign_draft(%L, 'Renamed', null,
      now(), null, 'Asia/Dubai', 'ALL_RETAILERS','INDIVIDUAL_STAFF','ALL_ELIGIBLE_PRODUCTS',
      'STACKABLE', null, 0, 'PER_UNIT_COINS', 5, null, null, null, null, null, null) $$,
         pg_temp.id('winter')),
  '55000', 'This campaign has no draft to edit; create a new version first',
  'F10. a published campaign with no draft cannot be edited in place'
);

-- ============================================================================
-- SECTION G — lifecycle
-- ============================================================================
select is(
  (select status_changed from public.set_vendor_campaign_lifecycle(pg_temp.id('winter'), 'PAUSE')),
  true,
  'G1. a published campaign can be paused'
);

select is(
  (select derived_state from public.get_vendor_campaign(pg_temp.id('winter'))),
  'PAUSED',
  'G2. the paused campaign derives PAUSED'
);

select is(
  (select status_changed from public.set_vendor_campaign_lifecycle(pg_temp.id('winter'), 'PAUSE')),
  false,
  'G3. pausing twice is a no-op, not an error'
);

select is(
  (select count(*)::integer from public.audit_logs
   where action = 'CAMPAIGN_PAUSED' and entity_id = pg_temp.id('winter')::text),
  1,
  'G4. the no-op pause wrote no second audit event'
);

-- Pausing preserves the published configuration and its snapshot completely.
select is(
  (select count(*)::integer from public.campaign_eligible_retailers
   where campaign_version_id = pg_temp.live_version(pg_temp.id('winter'))),
  2,
  'G5. pausing left the eligibility snapshot untouched'
);

select is(
  (select status_changed from public.set_vendor_campaign_lifecycle(pg_temp.id('winter'), 'RESUME')),
  true,
  'G6. a paused campaign can be resumed'
);

select is(
  (select derived_state from public.get_vendor_campaign(pg_temp.id('winter'))),
  'ACTIVE',
  'G7. resuming restores eligibility against the ORIGINAL dates'
);

select throws_ok(
  format($$ select * from public.set_vendor_campaign_lifecycle(%L, 'PAUSE') $$,
         pg_temp.draft('Never published')),
  '55000', 'This campaign has not been published yet',
  'G8. a draft cannot be paused'
);

select throws_ok(
  format($$ select * from public.set_vendor_campaign_lifecycle(%L, 'DESTROY') $$,
         pg_temp.id('winter')),
  '23514', 'Invalid campaign action',
  'G9. an unknown lifecycle action is refused'
);

select pg_temp.act_as(pg_temp.id('admin_b'));
select throws_ok(
  format($$ select * from public.set_vendor_campaign_lifecycle(%L, 'CANCEL') $$,
         pg_temp.id('winter')),
  '42501', null,
  'G10. another Vendor cannot cancel this campaign'
);

select pg_temp.act_as(pg_temp.id('admin_a'));

-- ============================================================================
-- SECTION H — the snapshot survives the world changing around it
-- ============================================================================
-- This is the section the whole versioning design exists for.
select is(
  (select count(*)::integer from public.set_vendor_retailer_group_members(
     pg_temp.group_a(), array[pg_temp.id('link_b')]::uuid[])),
  1,
  'H1. Alpha is removed from the group AFTER the campaign published'
);

select is(
  (select count(*)::integer from public.list_vendor_campaign_eligible_retailers(
     pg_temp.live_version(pg_temp.id('winter')))),
  2,
  'H2. the published snapshot STILL names both Retailers after the group edit'
);

-- And in the other direction: a product-assignment change cannot rewrite history either.
do $$
begin
  update public.vendor_product_retailer_assignments
  set status = 'INACTIVE'
  where vendor_product_id = pg_temp.id('p1')
    and retailer_organization_id = pg_temp.id('ret_a');
end;
$$;

select is(
  (select eligible_product_count from public.list_vendor_campaign_eligible_retailers(
     pg_temp.live_version(pg_temp.id('winter'))) where retailer_name = 'Retailer Alpha'),
  2,
  'H3. withdrawing a product assignment does NOT alter the published snapshot'
);

-- Restore it, so the version-2 resolution below is about the GROUP edit alone.
do $$
begin
  update public.vendor_product_retailer_assignments
  set status = 'ACTIVE'
  where vendor_product_id = pg_temp.id('p1')
    and retailer_organization_id = pg_temp.id('ret_a');
end;
$$;

-- A NEW version resolves afresh — which is exactly what "a new version may use the
-- updated group" means.
do $$
begin
  perform public.create_vendor_campaign_version(pg_temp.id('winter'));
end;
$$;

select is(
  (select version_number from public.get_vendor_campaign_version(
     pg_temp.draft_version(pg_temp.id('winter')))),
  2,
  'H4. a new version is numbered 2'
);

select is(
  (select rule_type || '/' || threshold_units || '/' || reward_coins
   from public.get_vendor_campaign_version(pg_temp.draft_version(pg_temp.id('winter')))),
  'TARGET_BONUS/10/100',
  'H5. the new version copied the published rule and its tier'
);

select is(
  (select count(*)::integer from public.list_vendor_campaign_version_groups(
     pg_temp.draft_version(pg_temp.id('winter')))),
  1,
  'H6. the new version copied the authoring targets'
);

select is(
  (select count(*)::integer from public.campaign_eligible_retailers
   where campaign_version_id = pg_temp.draft_version(pg_temp.id('winter'))),
  0,
  'H7. the new version copied NO snapshot — it resolves its own at publication'
);

select throws_ok(
  format($$ select public.create_vendor_campaign_version(%L) $$, pg_temp.id('winter')),
  '55000', 'This campaign already has a draft version',
  'H8. a second concurrent draft version is refused'
);

do $$
begin
  perform public.publish_vendor_campaign(pg_temp.id('winter'));
end;
$$;

select is(
  (select count(*)::integer from public.list_vendor_campaign_eligible_retailers(
     pg_temp.live_version(pg_temp.id('winter')))),
  1,
  'H9. version 2 resolved against the EDITED group — one Retailer now'
);

select is(
  (select count(*)::integer from public.campaign_eligible_retailers er
   join public.campaign_versions cv on cv.id = er.campaign_version_id
   where cv.campaign_id = pg_temp.id('winter') and cv.version_number = 1),
  2,
  'H10. version 1''s snapshot is STILL intact and still names both Retailers'
);

-- ============================================================================
-- SECTION I — assigned visibility: Retailer Owner
-- ============================================================================
select pg_temp.act_as(pg_temp.id('owner_a'));

-- Alpha's owner: after version 2, Alpha is no longer in the group, so the Winter Push is
-- gone from their list — but the ALL_RETAILERS team campaign remains.
select is(
  (select count(*)::integer from public.list_my_retailer_campaigns()
   where campaign_name = 'Winter Push'),
  0,
  'I1. a Retailer dropped by the new in-force version stops seeing the campaign'
);

select is(
  (select performance_scope from public.list_my_retailer_campaigns()
   where campaign_name = 'All Retailers Team'),
  'RETAILER_TEAM',
  'I2. the Owner sees the team campaign assigned to their Retailer'
);

select is(
  (select vendor_name from public.list_my_retailer_campaigns()
   where campaign_name = 'All Retailers Team'),
  'Vendor A',
  'I3. the Owner read returns the Vendor name, as the requirement states'
);

-- A DRAFT is invisible: it has no published version, so no snapshot names anyone.
do $$
begin
  perform pg_temp.act_as(pg_temp.id('admin_a'));
  perform pg_temp.draft('Secret Draft', p_audience => 'ALL_RETAILERS');
  perform pg_temp.act_as(pg_temp.id('owner_a'));
end;
$$;

select is(
  (select count(*)::integer from public.list_my_retailer_campaigns()
   where campaign_name = 'Secret Draft'),
  0,
  'I4. a DRAFT campaign is invisible to a Retailer Owner'
);

-- THE DISCLOSURE TESTS. What the Owner read must never carry.
select is(
  (select count(*)::integer
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('list_my_retailer_campaigns', 'get_my_retailer_campaign',
                       'list_my_staff_campaigns', 'get_my_staff_campaign')
     and (pg_catalog.pg_get_function_result(p.oid) like '%exclusivity_key%'
       or pg_catalog.pg_get_function_result(p.oid) like '%priority%'
       or pg_catalog.pg_get_function_result(p.oid) like '%source%'
       or pg_catalog.pg_get_function_result(p.oid) like '%vendor_retailer_id%'
       or pg_catalog.pg_get_function_result(p.oid) like '%version_number%'
       or pg_catalog.pg_get_function_result(p.oid) like '%eligible_retailer_count%')),
  0,
  'I5. no assigned-visibility read returns exclusivity key, priority, eligibility source, another Retailer''s id, version internals or a Retailer count'
);

select is(
  (select count(*)::integer
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like '%my_staff_campaign%'
     and pg_catalog.pg_get_function_result(p.oid) like '%vendor_name%'),
  0,
  'I6. the Sales Staff reads withhold the Vendor name, following list_my_receipt_products()'
);

-- Bravo's owner sees only Bravo's own eligible product count, never the campaign total.
select pg_temp.act_as(pg_temp.id('owner_b'));

select is(
  (select eligible_product_count from public.list_my_retailer_campaigns()
   where campaign_name = 'Winter Push'),
  1,
  'I7. an Owner sees only their OWN Retailer''s eligible product count'
);

select is(
  (select count(*)::integer from public.list_my_retailer_campaign_products(pg_temp.id('winter'))),
  1,
  'I8. the campaign product list is scoped to the caller''s Retailer'
);

select is(
  (select product_code from public.list_my_retailer_campaign_products(pg_temp.id('winter'))),
  'P-1',
  'I9. and it names only the product actually assigned to them'
);

-- A campaign this Retailer is not on returns zero rows, exactly as an unknown id does.
select is(
  (select count(*)::integer from public.get_my_retailer_campaign(gen_random_uuid())),
  0,
  'I10. an unknown campaign id returns zero rows'
);

select is(
  (select count(*)::integer from public.list_my_retailer_campaign_products(gen_random_uuid())),
  0,
  'I11. an unassigned campaign''s products cannot be enumerated'
);

-- ============================================================================
-- SECTION J — assigned visibility: Sales Staff
-- ============================================================================
select pg_temp.act_as(pg_temp.id('staff_a'));

select is(
  (select count(*)::integer from public.list_my_staff_campaigns()
   where campaign_name = 'All Retailers Team'),
  1,
  'J1. a Sales Staff member sees the ACTIVE campaign for their Retailer'
);

select is(
  (select count(*)::integer from public.list_my_staff_campaigns()
   where campaign_name = 'Secret Draft'),
  0,
  'J2. a DRAFT campaign is invisible to Sales Staff'
);

-- ALL_ELIGIBLE_PRODUCTS resolves LIVE for a staff member, which is what the phrase means.
select is(
  (select count(*)::integer from public.list_my_staff_campaign_products(pg_temp.id('team'))),
  2,
  'J3. ALL_ELIGIBLE_PRODUCTS resolves live to the Retailer''s two ACTIVE assigned products'
);

select is(
  (select count(*)::integer from public.list_my_staff_campaign_products(pg_temp.id('team'))
   where product_code = 'P-3'),
  0,
  'J4. an INACTIVE product is not eligible even though it is assigned'
);

-- Paused, ended and cancelled campaigns offer a seller nothing, so they are not shown.
do $$
begin
  perform pg_temp.act_as(pg_temp.id('admin_a'));
  perform public.set_vendor_campaign_lifecycle(pg_temp.id('team'), 'PAUSE');
  perform pg_temp.act_as(pg_temp.id('staff_a'));
end;
$$;

select is(
  (select count(*)::integer from public.list_my_staff_campaigns()
   where campaign_name = 'All Retailers Team'),
  0,
  'J5. Sales Staff stop seeing a campaign the moment it is paused'
);

select is(
  (select count(*)::integer from public.list_my_staff_campaign_products(pg_temp.id('team'))),
  0,
  'J6. and cannot enumerate its products either'
);

-- The Owner keeps historical visibility while the seller loses operational visibility:
-- the two audiences differ deliberately.
select pg_temp.act_as(pg_temp.id('owner_a'));

select is(
  (select derived_state from public.list_my_retailer_campaigns()
   where campaign_name = 'All Retailers Team'),
  'PAUSED',
  'J7. the Retailer Owner still sees the paused campaign, and sees that it is paused'
);

do $$
begin
  perform pg_temp.act_as(pg_temp.id('admin_a'));
  perform public.set_vendor_campaign_lifecycle(pg_temp.id('team'), 'RESUME');
  perform public.set_vendor_campaign_lifecycle(pg_temp.id('team'), 'CANCEL');
  perform pg_temp.act_as(pg_temp.id('owner_a'));
end;
$$;

select is(
  (select derived_state from public.list_my_retailer_campaigns()
   where campaign_name = 'All Retailers Team'),
  'CANCELLED',
  'J8. a cancelled campaign remains visible historically to the Retailer Owner'
);

select pg_temp.act_as(pg_temp.id('staff_a'));

select is(
  (select count(*)::integer from public.list_my_staff_campaigns()
   where campaign_name = 'All Retailers Team'),
  0,
  'J9. a cancelled campaign is not shown to Sales Staff'
);

-- ============================================================================
-- SECTION K — derived state is a function of the clock, not of a job
-- ============================================================================
select pg_temp.act_as(pg_temp.id('admin_a'));

do $$
declare v_c uuid;
begin
  v_c := pg_temp.draft('Future Campaign',
    p_starts => now() + interval '10 days', p_ends => now() + interval '20 days');
  perform public.publish_vendor_campaign(v_c);
  insert into pg_temp.f values ('future', v_c);
end;
$$;

select is(
  (select derived_state from public.get_vendor_campaign(pg_temp.id('future'))),
  'SCHEDULED',
  'K1. a published campaign whose period has not begun derives SCHEDULED'
);

-- ENDED is derived by comparing the clock, so it needs no sweep. The version is immutable,
-- so the only honest way to test a past period is to publish one.
do $$
declare v_c uuid;
begin
  v_c := pg_temp.draft('Past Campaign',
    p_starts => now() - interval '20 days', p_ends => now() - interval '10 days');
  perform public.publish_vendor_campaign(v_c);
  insert into pg_temp.f values ('past', v_c);
end;
$$;

select is(
  (select derived_state from public.get_vendor_campaign(pg_temp.id('past'))),
  'ENDED',
  'K2. a published campaign whose period has passed derives ENDED with no scheduled job'
);

select is(
  (select campaign_status from public.get_vendor_campaign(pg_temp.id('past'))),
  'PUBLISHED',
  'K3. and its PERSISTED management status is still PUBLISHED — time is derived, not written'
);

select pg_temp.act_as(pg_temp.id('staff_a'));

select is(
  (select count(*)::integer from public.list_my_staff_campaigns()
   where campaign_name = 'Past Campaign'),
  0,
  'K4. Sales Staff do not see an ended campaign'
);

select is(
  (select count(*)::integer from public.list_my_staff_campaigns()
   where campaign_name = 'Future Campaign'),
  1,
  'K5. Sales Staff DO see an upcoming campaign'
);

select pg_temp.act_as(pg_temp.id('owner_a'));

select is(
  (select derived_state from public.list_my_retailer_campaigns()
   where campaign_name = 'Past Campaign'),
  'ENDED',
  'K6. the Retailer Owner sees the ended campaign historically'
);

-- ============================================================================
-- SECTION L — audit facts are server-derived, and no reward is ever computed
-- ============================================================================
select is(
  (select count(*)::integer from public.audit_logs
   where action in ('RETAILER_GROUP_CREATED', 'RETAILER_GROUP_UPDATED',
                    'RETAILER_GROUP_MEMBERS_CHANGED', 'CAMPAIGN_DRAFT_CREATED',
                    'CAMPAIGN_DRAFT_UPDATED', 'CAMPAIGN_PUBLISHED', 'CAMPAIGN_PAUSED',
                    'CAMPAIGN_RESUMED', 'CAMPAIGN_CANCELLED', 'CAMPAIGN_VERSION_CREATED')
     and (organization_id is null or actor_profile_id is null)),
  0,
  'L1. every campaign audit row carries a server-derived organization and actor'
);

select is(
  (select count(*)::integer from public.audit_logs
   where action = 'CAMPAIGN_PUBLISHED'
     and not (metadata ? 'eligible_retailer_count' and metadata ? 'status_before'
              and metadata ? 'status_after' and metadata ? 'version_number')),
  0,
  'L2. a publish audit row records the server-derived counts and the status transition'
);

-- No contract in this milestone can be asked to compute or return progress, a balance,
-- a coin credit, a claim or a payout. Asserted against the catalogue so a future function
-- that added one to this surface fails here.
--
-- NARROWED FOR PHASE 2B. Migration 70 (20260828090000) added ONE approved progress read,
-- get_my_campaign_target_progress, and it is excluded by exact name. Everything this
-- assertion was written to protect is untouched: the campaign CONFIGURATION surface —
-- every draft, publish, version, group and assigned-visibility contract in this file —
-- still returns the OFFER and never what anyone has sold or earned. L3a below re-proves
-- that for the two staff reads specifically, and a SECOND progress-bearing campaign
-- function still fails here.
select is(
  (select count(*)::integer
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname like '%campaign%' or p.proname like '%retailer_group%')
     and p.proname <> 'get_my_campaign_target_progress'
     and (pg_catalog.pg_get_function_result(p.oid) ~* '(progress|balance|earned|credited|coins_earned|payout|claim|ledger)'
       or pg_catalog.pg_get_function_arguments(p.oid) ~* '(progress|balance|earned|credited|payout|claim|ledger)')),
  0,
  'L3. NO campaign contract accepts or returns progress, a balance, an earned amount, a claim or a payout'
);

-- The four assigned-visibility reads are the ones a Retailer Owner and a shop-floor
-- seller actually call, and they are the ones a progress column would most easily creep
-- into. They present the OFFER only, and this says so by name rather than by pattern.
select is(
  (select coalesce(string_agg(p.proname, ',' order by p.proname), 'NONE')
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('list_my_staff_campaigns', 'get_my_staff_campaign',
                       'list_my_staff_campaign_products', 'list_my_retailer_campaigns',
                       'get_my_retailer_campaign', 'list_my_retailer_campaign_products')
     and pg_catalog.pg_get_function_result(p.oid) ~* '(progress|balance|earned|credited|payout|claim|ledger)'),
  'NONE',
  'L3a. and NO assigned-visibility read returns progress, a balance or an earned amount — '
  'Migration 70 put that in its own function instead of widening any of these'
);

select is(
  (select count(*)::integer
   from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'campaign%'
     and a.attname ~* '(progress|balance|earned|credited|units_sold_total|payout|claim)'),
  0,
  'L4. no campaign TABLE holds a progress, balance, earned, credited, payout or claim column'
);

-- Coins are integers in storage as well as in the contracts.
select is(
  (select count(*)::integer
   from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   join pg_catalog.pg_type t on t.oid = a.atttypid
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'campaign%'
     and t.typname in ('float4', 'float8', 'numeric')),
  0,
  'L5. no campaign table stores a floating-point or numeric value — coins never round'
);

-- ============================================================================
-- SECTION M — product eligibility resolution: SNAPSHOT vs LIVE_TEMPORAL
-- ============================================================================
-- The two product scopes answer the eligibility question in genuinely different ways, and
-- campaign_versions.product_eligibility_resolution states which applies rather than
-- leaving a reader to infer it.
--
-- HOW TIME IS HANDLED HERE. Everything in this suite runs inside ONE transaction, so now()
-- is frozen at its start while the maintenance trigger stamps boundaries with
-- clock_timestamp() — which is always LATER. A withdrawal performed through the RPC in
-- this transaction therefore takes effect at an instant now() has not reached, and a read
-- resolved at now() would correctly still include the product. That is a property of the
-- test harness, not of the product.
--
-- So the READ-PATH assertions below drive a timeline whose boundaries lie in the PAST,
-- exactly as one left behind by an earlier transaction, by closing an open interval and
-- opening its successor directly. Both operations are permitted; Section D of
-- vendor_product_assignment_history_test.sql proves a CLOSED interval is frozen and that
-- nothing can be deleted. The RPC-driven path is proven there too (Section C), and M9/M10
-- below prove the resolver against the RPC's own writes.
select pg_temp.act_as(pg_temp.id('admin_a'));

select is(
  (select product_eligibility_resolution from public.get_vendor_campaign_version(
     pg_temp.live_version(pg_temp.id('winter')))),
  'SNAPSHOT',
  'M1. a SELECTED_PRODUCTS version resolves by frozen SNAPSHOT'
);

select is(
  (select product_eligibility_resolution from public.get_vendor_campaign_version(
     pg_temp.live_version(pg_temp.id('team')))),
  'LIVE_TEMPORAL',
  'M2. an ALL_ELIGIBLE_PRODUCTS version resolves LIVE_TEMPORAL'
);

-- DERIVED, never supplied. There is no argument for it in either draft contract.
select is(
  (select count(*)::integer
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('create_vendor_campaign_draft', 'update_vendor_campaign_draft')
     and pg_catalog.pg_get_function_arguments(p.oid) like '%eligibility_resolution%'),
  0,
  'M3. no draft contract accepts the resolution from a client — it is derived from the scope'
);

-- The pairing cannot be broken. Asserted against a DRAFT whose scope is
-- ALL_ELIGIBLE_PRODUCTS, so 'SNAPSHOT' is genuinely the inconsistent value for it.
do $$
begin
  insert into pg_temp.f values ('pairing', pg_temp.draft('Pairing probe'));
end;
$$;

select throws_ok(
  format($$ update public.campaign_versions set product_eligibility_resolution = 'SNAPSHOT'
            where id = %L $$, pg_temp.draft_version(pg_temp.id('pairing'))),
  '23514', null,
  'M4. SNAPSHOT on an ALL_ELIGIBLE_PRODUCTS version is refused by the database'
);

-- The mirror case needs a SELECTED_PRODUCTS DRAFT of its own: 'winter' has already
-- published version 2 by this point, so its draft pointer is null and an UPDATE keyed on it
-- would match no row and prove nothing.
do $$
begin
  insert into pg_temp.f values ('pairing_sel', pg_temp.draft(
    'Pairing probe selected',
    p_scope => 'SELECTED_PRODUCTS',
    p_products => array[pg_temp.id('p1')]::uuid[]));
end;
$$;

select throws_ok(
  format($$ update public.campaign_versions set product_eligibility_resolution = 'LIVE_TEMPORAL'
            where id = %L $$, pg_temp.draft_version(pg_temp.id('pairing_sel'))),
  '23514', null,
  'M5. and LIVE_TEMPORAL on a SELECTED_PRODUCTS version is refused too'
);

-- ---- A timeline whose boundaries lie in the past ---------------------------
-- One extra product, assigned to Alpha ten days ago. The team campaign is
-- ALL_ELIGIBLE_PRODUCTS, so it covers whatever is eligible at the relevant moment.
do $$
declare v_product uuid; v_assign uuid;
begin
  v_product := pg_temp.raw_product(pg_temp.id('vendor_a'), 'P-T', 'Timeline Product',
                                   pg_temp.id('admin_a'));
  insert into pg_temp.f values ('p_t', v_product);

  insert into public.vendor_product_retailer_assignments
    (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id,
     assigned_at, updated_at)
  values (v_product, pg_temp.id('ret_a'), 'ACTIVE', pg_temp.id('admin_a'),
          now() - interval '10 days', now() - interval '10 days')
  returning id into v_assign;
  insert into pg_temp.f values ('assign_t', v_assign);
end;
$$;

select pg_temp.act_as(pg_temp.id('owner_a'));

select is(
  (select count(*)::integer from public.list_my_retailer_campaign_products(pg_temp.id('team'))
   where product_code = 'P-T'),
  1,
  'M6. a LIVE_TEMPORAL campaign includes a product once its eligible interval has begun'
);

-- Withdraw it, effective one day ago — the shape an earlier transaction would have left.
do $$
begin
  update public.vendor_product_retailer_assignment_history
  set valid_to = now() - interval '1 day'
  where vendor_product_id = pg_temp.id('p_t')
    and retailer_organization_id = pg_temp.id('ret_a')
    and valid_to is null;

  insert into public.vendor_product_retailer_assignment_history
    (assignment_id, vendor_product_id, retailer_organization_id,
     assignment_status, valid_from, valid_to)
  values (pg_temp.id('assign_t'), pg_temp.id('p_t'), pg_temp.id('ret_a'),
          'INACTIVE', now() - interval '1 day', null);
end;
$$;

select is(
  (select count(*)::integer from public.list_my_retailer_campaign_products(pg_temp.id('team'))
   where product_code = 'P-T'),
  0,
  'M7. and excludes it at and after the instant it was withdrawn'
);

-- THE HISTORICAL ANSWER SURVIVES — the whole point of the timeline.
select ok(
  public.vendor_product_eligible_for_retailer_at(
    pg_temp.id('p_t'), pg_temp.id('ret_a'), now() - interval '5 days'),
  'M8. the withdrawn product is STILL eligible for a sale timestamp before the withdrawal'
);

select ok(
  not public.vendor_product_eligible_for_retailer_at(
    pg_temp.id('p_t'), pg_temp.id('ret_a'), now()),
  'M9. and not eligible now'
);

-- The campaign itself was NOT touched by any of that. These are VENDOR reads, so the
-- session switches back: get_vendor_campaign* require CAMPAIGNS_MANAGE and correctly
-- refuse the Retailer Owner the assertions above were acting as.
select pg_temp.act_as(pg_temp.id('admin_a'));

select is(
  (select product_scope || '/' || product_eligibility_resolution
   from public.get_vendor_campaign_version(pg_temp.live_version(pg_temp.id('team')))),
  'ALL_ELIGIBLE_PRODUCTS/LIVE_TEMPORAL',
  'M10. the published configuration is unchanged by an assignment change'
);

select is(
  (select version_count from public.get_vendor_campaign(pg_temp.id('team'))),
  1,
  'M11. and no new campaign version was created'
);

-- A product that becomes eligible again qualifies for future sales, with no new version.
do $$
begin
  perform pg_temp.act_as(pg_temp.id('owner_a'));

  update public.vendor_product_retailer_assignment_history
  set valid_to = now() - interval '1 hour'
  where vendor_product_id = pg_temp.id('p_t')
    and retailer_organization_id = pg_temp.id('ret_a')
    and valid_to is null;

  insert into public.vendor_product_retailer_assignment_history
    (assignment_id, vendor_product_id, retailer_organization_id,
     assignment_status, valid_from, valid_to)
  values (pg_temp.id('assign_t'), pg_temp.id('p_t'), pg_temp.id('ret_a'),
          'ACTIVE', now() - interval '1 hour', null);
end;
$$;

select is(
  (select count(*)::integer from public.list_my_retailer_campaign_products(pg_temp.id('team'))
   where product_code = 'P-T'),
  1,
  'M12. re-assignment makes it eligible again without a new campaign version'
);

select pg_temp.act_as(pg_temp.id('admin_a'));

select is(
  (select version_count from public.get_vendor_campaign(pg_temp.id('team'))),
  1,
  'M13. still one version'
);

-- ---- SNAPSHOT is unaffected by every one of those changes ------------------
select pg_temp.act_as(pg_temp.id('owner_b'));

select is(
  (select count(*)::integer from public.list_my_retailer_campaign_products(pg_temp.id('winter'))),
  1,
  'M14. a SELECTED_PRODUCTS campaign is untouched by the whole timeline above'
);

-- Sales Staff read the SAME product semantics as their Retailer Owner.
--
-- A FRESH campaign, because 'team' was cancelled in Section J and Sales Staff correctly see
-- only ACTIVE and SCHEDULED campaigns. Reusing it would have tested the cancellation rule a
-- second time rather than the product semantics this section is about.
do $$
declare v_c uuid;
begin
  perform pg_temp.act_as(pg_temp.id('admin_a'));
  v_c := pg_temp.draft('Live Temporal Staff', p_audience => 'ALL_RETAILERS');
  perform public.publish_vendor_campaign(v_c);
  insert into pg_temp.f values ('live_staff', v_c);
end;
$$;

select pg_temp.act_as(pg_temp.id('staff_a'));

select is(
  (select product_eligibility_resolution from public.list_my_staff_campaigns()
   where campaign_name = 'Live Temporal Staff'),
  'LIVE_TEMPORAL',
  'M15. the Sales Staff contract exposes the same resolution'
);

select is(
  (select count(*)::integer from public.list_my_staff_campaign_products(pg_temp.id('live_staff'))
   where product_code = 'P-T'),
  1,
  'M16. and the same temporal product set'
);

select pg_temp.act_as(pg_temp.id('admin_a'));

-- ============================================================================
-- SECTION N — the coin ceiling
-- ============================================================================
select pg_temp.act_as(pg_temp.id('admin_a'));

select lives_ok(
  $$ select pg_temp.draft('At the ceiling', p_per_unit => 1000000000) $$,
  'N1. exactly 1,000,000,000 coins per unit is accepted'
);

select throws_ok(
  $$ select pg_temp.draft('Over the ceiling', p_per_unit => 1000000001) $$,
  '23514', 'Enter coins per unit between 1 and 1,000,000,000',
  'N2. 1,000,000,001 is refused'
);

select throws_ok(
  $$ select pg_temp.draft('Bigint max', p_per_unit => 9223372036854775807) $$,
  '23514', null,
  'N3. bigint maximum is refused'
);

select throws_ok(
  $$ select pg_temp.draft('Bonus over ceiling', p_rule => 'TARGET_BONUS', p_per_unit => null,
                          p_threshold => 10, p_bonus => 1000000001) $$,
  '23514', 'Enter bonus coins between 1 and 1,000,000,000',
  'N4. a bonus above the ceiling is refused'
);

select throws_ok(
  $$ select public.create_vendor_campaign_draft('Cap over ceiling', null, now(), null,
       'Asia/Dubai', 'ALL_RETAILERS','INDIVIDUAL_STAFF','ALL_ELIGIBLE_PRODUCTS','STACKABLE',
       null, 0, 'PER_UNIT_COINS', 5, null, null, 1000000001, null, null, null) $$,
  '23514', 'The maximum coins must be between 1 and 1,000,000,000',
  'N5. a cap above the ceiling is refused'
);

-- The CONSTRAINT, not only the RPC. A future writer that bypassed campaign_apply_draft_config
-- would still be bounded.
select throws_ok(
  format($$ insert into public.campaign_rules (campaign_version_id, rule_type, coins_per_unit)
            values (%L, 'PER_UNIT_COINS', 9223372036854775807) $$,
         pg_temp.draft_version(pg_temp.id('pairing'))),
  '23514', null,
  'N6. the ceiling is a CHECK constraint too, not only an RPC guard'
);

-- THE ARITHMETIC THE CEILING PROTECTS: the largest configurable rate multiplied by more
-- units than threshold_units (an integer) can hold still fits in bigint.
select ok(
  (1000000000::bigint * 2147483647::bigint) < 9223372036854775807::bigint,
  'N7. max coins per unit x max integer units stays inside bigint'
);

select * from finish();

rollback;
