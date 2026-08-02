-- pgTAP behavioural tests for CLAIM REVIEWER PORTAL ACCESS:
--
--   the CLAIM_REVIEW_PORTAL_READ permission and its single role mapping [20260818210000]
--   public.resolve_claim_reviewer_organization(text)
--   public.get_claim_reviewer_context()
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- Phase 1B grants ONE capability: opening an empty reviewer portal. The suite is
-- weighted towards the three ways that could go wrong in a way that matters:
--
--   * the permission reaching a role it must not (Section B) -- above all
--     VENDOR_SUPER_ADMIN, whose separation from reviewing is the point of the milestone;
--   * the resolver picking a Vendor when a reviewer qualifies for two (Section D), which
--     would silently scope somebody's future financial decisions to the wrong tenant;
--   * this milestone quietly widening something else (Section F) -- the Flutter portal
--     contract, the Vendor Admin context, or receipt access that does not exist yet.
--
-- Every fixture is a REAL profile, membership, role and mapping. Nothing here asserts
-- against a mocked boolean.
--
-- Everything runs inside one transaction and is rolled back. no_plan(), per the
-- convention every suite in this directory follows.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers and fixture
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

create function pg_temp.new_person(
  p_first text, p_last text, p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || lower(p_last) || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, p_status);
  return v_id;
end;
$$;

create function pg_temp.new_org(
  p_name text, p_type text, p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.organizations (name, organization_type, status, country_code, default_currency)
  values (p_name, p_type, p_status, 'AE', 'AED')
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.add_member(
  p_user uuid, p_org uuid, p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, p_status, now() - interval '30 days')
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

create table pg_temp.f (k text primary key, v uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select v from pg_temp.f where k = p
$$;

/* Rows the browser-facing context returns for the CURRENT caller. */
create function pg_temp.ctx_rows() returns integer
language sql stable as $$
  select count(*)::integer from public.get_claim_reviewer_context()
$$;

/* The Vendor the resolver picks for the CURRENT caller, or NULL. */
create function pg_temp.resolved() returns uuid
language sql stable as $$
  select public.resolve_claim_reviewer_organization('CLAIM_REVIEW_PORTAL_READ')
$$;

/* Creates a person holding exactly one role in Vendor A, and returns their id. */
create function pg_temp.person_with_role(p_first text, p_role text) returns uuid
language plpgsql as $$
declare v_p uuid; v_m uuid;
begin
  v_p := pg_temp.new_person(p_first, 'Tester');
  v_m := pg_temp.add_member(v_p, pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, p_role);
  return v_p;
end;
$$;

do $$
declare v_reviewer uuid; v_member uuid;
begin
  insert into pg_temp.f values
    ('vendor_a', pg_temp.new_org('Vendor A', 'VENDOR')),
    ('vendor_b', pg_temp.new_org('Vendor B', 'VENDOR')),
    ('retailer', pg_temp.new_org('Retailer R', 'RETAILER'));

  -- The authorized reviewer: one ACTIVE membership of one ACTIVE Vendor.
  v_reviewer := pg_temp.new_person('Rita', 'Reviewer');
  v_member   := pg_temp.add_member(v_reviewer, pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_member, 'CLAIM_REVIEWER');

  insert into pg_temp.f values
    ('reviewer', v_reviewer), ('reviewer_member', v_member);
end;
$$;

-- ============================================================================
-- SECTION A — the permission and its mapping
-- ============================================================================
select is(
  (select count(*)::integer from public.permissions where code = 'CLAIM_REVIEW_PORTAL_READ'),
  1,
  'A1. the CLAIM_REVIEW_PORTAL_READ permission exists'
);

select is(
  (select module from public.permissions where code = 'CLAIM_REVIEW_PORTAL_READ'),
  'CLAIM_REVIEW',
  'A2. and is filed under the CLAIM_REVIEW module'
);

-- The whole separation-of-duties claim in one assertion.
select is(
  (select coalesce(string_agg(r.code, ',' order by r.code), '(none)')
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'CLAIM_REVIEW_PORTAL_READ'),
  'CLAIM_REVIEWER',
  'A3. it is mapped to CLAIM_REVIEWER and to NOTHING else'
);

select is(
  (select count(*)::integer
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'CLAIM_REVIEW_PORTAL_READ'
     and r.code in ('VENDOR_SUPER_ADMIN', 'FINANCE_ADMIN', 'RETAILER_OWNER',
                    'RETAILER_MANAGER', 'SALES_STAFF')),
  0,
  'A4. no Vendor admin, finance, owner, manager or staff role holds it'
);

-- THE PORTAL-ONLY GUARANTEE. Phase 1B must not create the permissions that will
-- authorize receipt data, or a later milestone would find them already granted.
-- SUPERSEDED BY PHASE 1C-A [20260819090000], WHICH CREATED THIS PERMISSION.
--
-- The original assertion read "RECEIPT_REVIEW_READ does NOT exist yet". Its purpose was
-- never the absence itself — it was that Phase 1B must not hand receipt access to
-- anyone. Phase 1C-A grants it deliberately, so the absence check is replaced by the
-- stronger form of the same guarantee: it exists, and it reaches exactly one role.
-- Deleting the assertion would have dropped the protection; this keeps it.
select is(
  (select coalesce(string_agg(r.code, ',' order by r.code), '(none)')
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RECEIPT_REVIEW_READ'),
  'CLAIM_REVIEWER',
  'A5. RECEIPT_REVIEW_READ reaches CLAIM_REVIEWER and no other role'
);

select is(
  (select count(*)::integer from public.permissions where code = 'RECEIPT_VERIFY'),
  0,
  'A6. RECEIPT_VERIFY does NOT exist yet — verification is a later milestone'
);

-- SUPERSEDED BY PHASE 1C-A [20260819090000], WHICH ADDED TWO PERMISSIONS.
--
-- The original assertion pinned the count at ONE. Its purpose was to stop the reviewer
-- role quietly accumulating capability, so the successor pins the exact SET rather than
-- a number — which is strictly stronger: a fourth permission, or a different third one,
-- now fails just as loudly, and the failure names what changed.
select is(
  (select string_agg(p.code, ',' order by p.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'CLAIM_REVIEWER'),
  'CLAIM_REVIEW_PORTAL_READ,RECEIPT_REVIEW_DECIDE,RECEIPT_REVIEW_READ',
  'A7. CLAIM_REVIEWER holds exactly the portal permission plus the two review permissions'
);

-- ============================================================================
-- SECTION B — who resolves as a reviewer
-- ============================================================================
select pg_temp.act_as(pg_temp.id('reviewer'));

select is(pg_temp.resolved(), pg_temp.id('vendor_a'),
  'B1. an ACTIVE reviewer resolves their one ACTIVE Vendor');

select is(pg_temp.ctx_rows(), 1,
  'B2. and get_claim_reviewer_context returns exactly one row');

select is(
  (select c.organization_name from public.get_claim_reviewer_context() c),
  'Vendor A',
  'B3. carrying the Vendor organization name'
);

select is(
  (select c.user_id from public.get_claim_reviewer_context() c),
  pg_temp.id('reviewer'),
  'B4. and the caller''s own profile id, never another'
);

select is(
  (select c.first_name || ' ' || c.last_name from public.get_claim_reviewer_context() c),
  'Rita Reviewer',
  'B5. and their display name'
);

-- --- every other role resolves to nothing ------------------------------------
-- Each is a real, ACTIVE member holding ONLY the named role, so a refusal is
-- attributable to the missing permission and to nothing else.
--
-- The two Vendor-side roles are placed in the VENDOR organization and the three
-- Retailer-side roles in the RETAILER organization — where each of them actually
-- belongs. Putting a RETAILER_OWNER in a Vendor org would still be refused, but for
-- the wrong reason (wrong organization type rather than missing permission), and it
-- would make the portal-context assertions in Section F meaningless because the
-- Retailer resolvers would report NONE for a Retailer role.
do $$
declare v_code text; v_p uuid; v_m uuid;
begin
  foreach v_code in array array['VENDOR_SUPER_ADMIN','FINANCE_ADMIN'] loop
    insert into pg_temp.f values ('actor_' || v_code, pg_temp.person_with_role(v_code, v_code));
  end loop;

  foreach v_code in array array['RETAILER_OWNER','RETAILER_MANAGER','SALES_STAFF'] loop
    v_p := pg_temp.new_person(v_code, 'Tester');
    v_m := pg_temp.add_member(v_p, pg_temp.id('retailer'));
    perform pg_temp.add_role(v_m, v_code);
    insert into pg_temp.f values ('actor_' || v_code, v_p);
  end loop;
end;
$$;

select pg_temp.act_as(pg_temp.id('actor_VENDOR_SUPER_ADMIN'));
select is(pg_temp.ctx_rows(), 0,
  'B6. a VENDOR_SUPER_ADMIN does NOT resolve as a reviewer — the separation this milestone exists for');
select is(pg_temp.resolved(), null, 'B7. and the resolver returns NULL for them');

select pg_temp.act_as(pg_temp.id('actor_FINANCE_ADMIN'));
select is(pg_temp.ctx_rows(), 0, 'B8. a FINANCE_ADMIN is refused');

select pg_temp.act_as(pg_temp.id('actor_RETAILER_OWNER'));
select is(pg_temp.ctx_rows(), 0, 'B9. a RETAILER_OWNER is refused');

select pg_temp.act_as(pg_temp.id('actor_RETAILER_MANAGER'));
select is(pg_temp.ctx_rows(), 0, 'B10. a RETAILER_MANAGER is refused');

select pg_temp.act_as(pg_temp.id('actor_SALES_STAFF'));
select is(pg_temp.ctx_rows(), 0,
  'B11. a SALES_STAFF member is refused — a submitter must never review');

select pg_temp.sign_out();
select is(pg_temp.ctx_rows(), 0, 'B12. a signed-out caller is refused');
select is(pg_temp.resolved(), null, 'B13. and resolves to NULL');

-- ============================================================================
-- SECTION C — every inactive link in the chain refuses
-- ============================================================================
do $$
declare v_p uuid; v_m uuid; v_org uuid;
begin
  -- SUSPENDED profile, everything else correct.
  v_p := pg_temp.new_person('Sus', 'Pended', 'SUSPENDED');
  v_m := pg_temp.add_member(v_p, pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');
  insert into pg_temp.f values ('inactive_profile', v_p);

  -- DEACTIVATED membership.
  v_p := pg_temp.new_person('Ex', 'Member');
  v_m := pg_temp.add_member(v_p, pg_temp.id('vendor_a'), 'DEACTIVATED');
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');
  insert into pg_temp.f values ('inactive_member', v_p);

  -- ACTIVE everything, but the ORGANIZATION is suspended.
  v_org := pg_temp.new_org('Vendor Dormant', 'VENDOR', 'SUSPENDED');
  v_p   := pg_temp.new_person('Dorm', 'Ant');
  v_m   := pg_temp.add_member(v_p, v_org);
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');
  insert into pg_temp.f values ('inactive_org_person', v_p);

  -- A RETAILER organization rather than a VENDOR one.
  v_p := pg_temp.new_person('Ret', 'Ailer');
  v_m := pg_temp.add_member(v_p, pg_temp.id('retailer'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');
  insert into pg_temp.f values ('retailer_org_person', v_p);

  -- A member with NO role at all.
  v_p := pg_temp.new_person('No', 'Role');
  perform pg_temp.add_member(v_p, pg_temp.id('vendor_a'));
  insert into pg_temp.f values ('no_role', v_p);
end;
$$;

select pg_temp.act_as(pg_temp.id('inactive_profile'));
select is(pg_temp.ctx_rows(), 0, 'C1. an INACTIVE PROFILE is refused');

select pg_temp.act_as(pg_temp.id('inactive_member'));
select is(pg_temp.ctx_rows(), 0, 'C2. a DEACTIVATED MEMBERSHIP is refused');

select pg_temp.act_as(pg_temp.id('inactive_org_person'));
select is(pg_temp.ctx_rows(), 0, 'C3. an INACTIVE VENDOR ORGANIZATION is refused');

select pg_temp.act_as(pg_temp.id('retailer_org_person'));
select is(pg_temp.ctx_rows(), 0,
  'C4. the SAME role in a RETAILER organization is refused — reviewers are Vendor-side');

select pg_temp.act_as(pg_temp.id('no_role'));
select is(pg_temp.ctx_rows(), 0, 'C5. a member holding NO role is refused');

-- --- the role itself, and the mapping ----------------------------------------
-- These two prove the authority really is the mapping rather than anything in code.
select pg_temp.act_as(pg_temp.id('reviewer'));
select is(pg_temp.ctx_rows(), 1, 'C6. (the reviewer is authorized before the next two checks)');

-- Deactivating the ROLE disables every reviewer at once.
update public.roles set status = 'INACTIVE' where code = 'CLAIM_REVIEWER';
select is(pg_temp.ctx_rows(), 0,
  'C7. an INACTIVE CLAIM_REVIEWER role refuses immediately, with no code change');
update public.roles set status = 'ACTIVE' where code = 'CLAIM_REVIEWER';
select is(pg_temp.ctx_rows(), 1, 'C8. and reactivating it restores access on the next call');

-- Removing the MAPPING disables the portal, proving no role code is hard-coded.
delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and r.code = 'CLAIM_REVIEWER' and p.code = 'CLAIM_REVIEW_PORTAL_READ';
select is(pg_temp.ctx_rows(), 0,
  'C9. removing the role-permission MAPPING refuses — the mapping is the sole authority');
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.code = 'CLAIM_REVIEWER' and p.code = 'CLAIM_REVIEW_PORTAL_READ';
select is(pg_temp.ctx_rows(), 1, 'C10. and restoring it restores access');

-- Removing the member-role assignment.
delete from public.member_roles mr
using public.roles r
where mr.role_id = r.id and r.code = 'CLAIM_REVIEWER'
  and mr.organization_member_id = pg_temp.id('reviewer_member');
select is(pg_temp.ctx_rows(), 0,
  'C11. removing the member-role assignment refuses IMMEDIATELY on the next call');
select pg_temp.add_role(pg_temp.id('reviewer_member'), 'CLAIM_REVIEWER');
select is(pg_temp.ctx_rows(), 1, 'C12. and re-assigning it restores access');

-- ============================================================================
-- SECTION D — zero and multiple Vendors both fail closed
-- ============================================================================
-- The reviewer currently qualifies for exactly one Vendor. Adding a second must NOT
-- silently pick one: a reviewer decides what is worth money, and choosing a tenant
-- on their behalf is not a decision this resolver may make.
do $$
declare v_m uuid;
begin
  v_m := pg_temp.add_member(pg_temp.id('reviewer'), pg_temp.id('vendor_b'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');
  insert into pg_temp.f values ('reviewer_member_b', v_m);
end;
$$;

select pg_temp.act_as(pg_temp.id('reviewer'));

select is(pg_temp.resolved(), null,
  'D1. TWO qualifying Vendors resolve to NULL — no lowest-id, no earliest, no arbitrary pick');

select is(pg_temp.ctx_rows(), 0,
  'D2. and the browser-facing context returns ZERO rows rather than one of the two');

-- Removing the second membership restores the unambiguous case, proving D1/D2 were
-- caused by the ambiguity and not by something the fixture broke.
delete from public.member_roles where organization_member_id = pg_temp.id('reviewer_member_b');
delete from public.organization_members where id = pg_temp.id('reviewer_member_b');

select is(pg_temp.resolved(), pg_temp.id('vendor_a'),
  'D3. removing the second Vendor restores a single unambiguous answer');

-- Zero qualifying organizations, from a person who has none at all.
do $$
begin
  insert into pg_temp.f values ('orphan', pg_temp.new_person('Or', 'Phan'));
end;
$$;
select pg_temp.act_as(pg_temp.id('orphan'));
select is(pg_temp.resolved(), null, 'D4. ZERO qualifying organizations resolves to NULL');
select is(pg_temp.ctx_rows(), 0, 'D5. and returns zero rows');

-- ============================================================================
-- SECTION E — the privilege surface
-- ============================================================================
select ok(
  not has_function_privilege('authenticated',
    'public.resolve_claim_reviewer_organization(text)', 'EXECUTE'),
  'E1. the internal resolver is NOT executable by authenticated'
);

select ok(
  not has_function_privilege('anon',
    'public.resolve_claim_reviewer_organization(text)', 'EXECUTE'),
  'E2. nor by anon'
);

select ok(
  has_function_privilege('authenticated',
    'public.get_claim_reviewer_context()', 'EXECUTE'),
  'E3. the browser-facing context RPC IS executable by authenticated'
);

select ok(
  not has_function_privilege('anon', 'public.get_claim_reviewer_context()', 'EXECUTE'),
  'E4. but not by anon'
);

select ok(
  not has_function_privilege('service_role', 'public.get_claim_reviewer_context()', 'EXECUTE'),
  'E5. and not by service_role — reviewer context requires a session'
);

select is(
  (select count(*)::integer from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('resolve_claim_reviewer_organization', 'get_claim_reviewer_context')
     and not p.prosecdef),
  0,
  'E6. both functions are SECURITY DEFINER'
);

select is(
  (select count(*)::integer from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('resolve_claim_reviewer_organization', 'get_claim_reviewer_context')
     and not ('search_path=' in (select unnest(coalesce(p.proconfig, array[]::text[])))
              or 'search_path=""' = any (coalesce(p.proconfig, array[]::text[])))),
  0,
  'E7. and both run with an EMPTY search_path'
);

-- No receipt table became reachable. Phase 1B grants a shell, not data.
select is(
  (select count(*)::integer
   from pg_catalog.pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('receipt_submissions', 'receipt_confirmations', 'receipt_extractions')
     and (has_table_privilege('authenticated', c.oid, 'SELECT')
       or has_table_privilege('anon', c.oid, 'SELECT'))),
  0,
  'E8. no browser role gained SELECT on any receipt table'
);

-- ============================================================================
-- SECTION F — this milestone widened nothing else
-- ============================================================================
-- THE FLUTTER CONTRACT. get_my_portal_context() is consumed by the mobile client,
-- whose parser rejects an unknown portal_kind and requires an exact context_version.
-- These assertions are the regression guard that keeps Phase 1B off it.
select pg_temp.act_as(pg_temp.id('actor_VENDOR_SUPER_ADMIN'));
select is(
  (public.get_my_portal_context() ->> 'portal_kind'),
  'VENDOR_SUPER_ADMIN',
  'F1. a Vendor Super Admin still reports portal_kind VENDOR_SUPER_ADMIN'
);
select is(
  (public.get_my_portal_context() ->> 'context_version'),
  '1',
  'F2. and context_version is still 1'
);

select pg_temp.act_as(pg_temp.id('actor_RETAILER_OWNER'));
select is(
  (public.get_my_portal_context() ->> 'portal_kind'),
  'RETAILER_OWNER',
  'F3. a Retailer Owner still reports RETAILER_OWNER'
);

select pg_temp.act_as(pg_temp.id('actor_RETAILER_MANAGER'));
select is(
  (public.get_my_portal_context() ->> 'portal_kind'),
  'RETAILER_MANAGER',
  'F4. a Retailer Manager still reports RETAILER_MANAGER'
);

select pg_temp.act_as(pg_temp.id('actor_SALES_STAFF'));
select is(
  (public.get_my_portal_context() ->> 'portal_kind'),
  'SALES_STAFF',
  'F5. a Sales Staff member still reports SALES_STAFF'
);

-- A reviewer is invisible to the mobile contract, which is the intended answer: there
-- is no mobile reviewer experience, and NONE is what an unrecognised caller has always
-- received. Crucially it is a value the shipped Flutter parser already understands.
select pg_temp.act_as(pg_temp.id('reviewer'));
select is(
  (public.get_my_portal_context() ->> 'portal_kind'),
  'NONE',
  'F6. a reviewer-only caller reports NONE — a value existing Flutter builds parse'
);
select is(
  (public.get_my_portal_context() ->> 'vendor'),
  null,
  'F7. with a null vendor block, so the mobile parser''s NONE coherence check still holds'
);
select is(
  (public.get_my_portal_context() ->> 'retailer'),
  null,
  'F8. and a null retailer block'
);

-- The set of keys must be exactly what it was: the parser tolerates extra keys, but
-- Phase 1B added none, and this asserts it.
select is(
  (select string_agg(k, ',' order by k)
   from jsonb_object_keys(public.get_my_portal_context()) as k),
  'context_version,portal_kind,retailer,vendor',
  'F9. and the portal-context key set is unchanged'
);

-- THE VENDOR ADMIN GATE. A reviewer must not have gained Vendor Admin access.
select is(
  (select count(*)::integer from public.get_vendor_super_admin_context()),
  0,
  'F10. a reviewer resolves NO Vendor Super Admin context — Vendor Admin was not widened'
);

select pg_temp.act_as(pg_temp.id('actor_VENDOR_SUPER_ADMIN'));
select is(
  (select count(*)::integer from public.get_vendor_super_admin_context()),
  1,
  'F11. while a Vendor Super Admin still resolves exactly one, as before'
);

-- NO RLS POLICY WAS ADDED BY THIS MILESTONE.
--
-- Asserted against the known total rather than against zero: migration 20260716131930
-- created eleven SELECT policies (organizations x2, profiles, organization_members,
-- roles, permissions, role_permissions, member_roles, vendor_retailers, retailer_shops,
-- audit_logs), and those are load-bearing. The claim here is that the count is still
-- exactly eleven — Phase 1B creates no table, so it has nothing to add a policy to, and
-- a new policy appearing would mean this milestone grew a browser-reachable read path.
select is(
  (select count(*)::integer from pg_catalog.pg_policy),
  11,
  'F12. the RLS policy count is unchanged at 11 — this milestone added none'
);

select * from finish();
rollback;
