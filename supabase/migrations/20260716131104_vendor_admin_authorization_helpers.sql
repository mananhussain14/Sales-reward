-- Migration: vendor_admin_authorization_helpers
-- Purpose: Read-only authorization helper functions for the Vendor Admin.
--          These are the building blocks that future RLS policies and
--          server-side checks will call. They NEVER take a user id — the
--          caller is always identified via auth.uid() — so they can only ever
--          report on the currently authenticated user's own authorization.
--
-- Security posture (all three functions):
--   * language sql, stable, security definer, set search_path = ''.
--   * Every schema/table/function reference is fully qualified (safe under an
--     empty search_path — nothing can be resolved from an attacker-controlled
--     schema).
--   * SECURITY DEFINER lets them read the identity/RBAC tables (which are RLS
--     default-deny to the browser) — but every query is hard-filtered to
--     auth.uid(), so no membership data leaks and no other user can be probed.
--   * Return a plain boolean (via EXISTS, which is never null). Unauthenticated
--     callers, null organization ids, and null codes all yield false.
--   * No dynamic SQL, no writes, no returned rows.
--
-- Scope notes: no tables changed, no RLS policies, no seed data, no bootstrap,
--   no audit triggers. Depends on migrations 1 (identity) and 2 (rbac).

-- ============================================================================
-- 1. is_active_organization_member(target_organization_id uuid) -> boolean
-- ============================================================================
-- True only when the caller has an ACTIVE profile, an ACTIVE membership in the
-- target organization, and that organization is ACTIVE.
create function public.is_active_organization_member(
  target_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.organization_members m on m.user_id = p.id
    join public.organizations o on o.id = m.organization_id
    where target_organization_id is not null
      and auth.uid() is not null
      and p.id = auth.uid()
      and p.status = 'ACTIVE'
      and m.organization_id = target_organization_id
      and m.status = 'ACTIVE'
      and o.status = 'ACTIVE'
  );
$$;

revoke all on function public.is_active_organization_member(uuid) from public;
revoke execute on function public.is_active_organization_member(uuid) from anon;
grant execute on function public.is_active_organization_member(uuid) to authenticated;

-- ============================================================================
-- 2. has_organization_role(target_organization_id uuid, target_role_code text)
--    -> boolean
-- ============================================================================
-- True only when the caller passes all active profile/membership/organization
-- checks AND holds an ACTIVE role whose code equals target_role_code, via that
-- same membership.
create function public.has_organization_role(
  target_organization_id uuid,
  target_role_code text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.organization_members m on m.user_id = p.id
    join public.organizations o on o.id = m.organization_id
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    where target_organization_id is not null
      and target_role_code is not null
      and auth.uid() is not null
      and p.id = auth.uid()
      and p.status = 'ACTIVE'
      and m.organization_id = target_organization_id
      and m.status = 'ACTIVE'
      and o.status = 'ACTIVE'
      and r.code = target_role_code
      and r.status = 'ACTIVE'
  );
$$;

revoke all on function public.has_organization_role(uuid, text) from public;
revoke execute on function public.has_organization_role(uuid, text) from anon;
grant execute on function public.has_organization_role(uuid, text) to authenticated;

-- ============================================================================
-- 3. has_organization_permission(
--      target_organization_id uuid, target_permission_code text
--    ) -> boolean
-- ============================================================================
-- True only when the caller passes all active profile/membership/organization
-- checks, holds an ACTIVE role, and that role is mapped (via role_permissions)
-- to a permission whose code equals target_permission_code.
create function public.has_organization_permission(
  target_organization_id uuid,
  target_permission_code text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.organization_members m on m.user_id = p.id
    join public.organizations o on o.id = m.organization_id
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions perm on perm.id = rp.permission_id
    where target_organization_id is not null
      and target_permission_code is not null
      and auth.uid() is not null
      and p.id = auth.uid()
      and p.status = 'ACTIVE'
      and m.organization_id = target_organization_id
      and m.status = 'ACTIVE'
      and o.status = 'ACTIVE'
      and r.status = 'ACTIVE'
      and perm.code = target_permission_code
  );
$$;

revoke all on function public.has_organization_permission(uuid, text) from public;
revoke execute on function public.has_organization_permission(uuid, text) from anon;
grant execute on function public.has_organization_permission(uuid, text) to authenticated;
