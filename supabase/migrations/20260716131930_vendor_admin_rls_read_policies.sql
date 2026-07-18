-- Migration: vendor_admin_rls_read_policies
-- Purpose: Row Level Security READ policies for the Vendor Admin foundation.
--          Turns the default-deny posture of migrations 1-3 into a precise,
--          least-privilege read model for browser (publishable-key) clients.
--
-- Scope notes:
--   * SELECT policies only. No INSERT/UPDATE/DELETE/ALL policies are created,
--     so every write path stays default-deny for anon/authenticated. Writes
--     continue to happen only through trusted server-side code.
--   * Every policy is TO authenticated. anon is never granted a policy and is
--     additionally stripped of table privileges below.
--   * Depends on migrations 1 (identity), 2 (rbac), 3 (audit_logs) for the
--     tables, and 4 (authorization helpers) for the three SECURITY DEFINER
--     predicates. No new functions, tables, columns, or triggers are created,
--     and no earlier migration is modified.
--   * No seed data, no bootstrap Super Admin. The role/permission codes below
--     (VENDOR_SUPER_ADMIN, ORGANIZATION_MEMBERS_READ, RBAC_READ,
--     AUDIT_LOGS_READ) are seeded in a later migration; until then the helpers
--     find no matching row and every permission-based branch returns false.
--
-- Authorization model:
--   All authorization is delegated to the migration-4 helpers, which are
--   SECURITY DEFINER + stable + search_path = '' and identify the caller solely
--   via auth.uid(). They never accept a user id, so application input cannot
--   influence whose authorization is evaluated. They also enforce the active
--   lifecycle chain (ACTIVE profile + ACTIVE membership + ACTIVE organization,
--   plus ACTIVE role for the role/permission variants), so inactive profiles,
--   memberships, organizations, and roles can never authorize a read.
--
-- Recursion:
--   The helpers are SECURITY DEFINER and therefore read the identity/RBAC
--   tables with the function owner's rights, bypassing RLS entirely. A policy
--   that calls a helper can never re-enter the policy set. See the notes on the
--   individual policies for the two places where a policy references a table
--   directly rather than through a helper.

-- ============================================================================
-- 1. organizations
-- ============================================================================
-- An organization row is visible only to its own ACTIVE members. The helper
-- resolves membership internally with definer rights, so this policy does not
-- read public.organization_members under RLS and cannot recurse.
create policy organizations_select_active_members
  on public.organizations
  for select
  to authenticated
  using (
    public.is_active_organization_member(public.organizations.id)
  );

-- ============================================================================
-- 2. profiles
-- ============================================================================
-- A profile is visible when it is the caller's own, or when the target profile
-- is a member of an organization in which the caller holds
-- ORGANIZATION_MEMBERS_READ or VENDOR_SUPER_ADMIN. The EXISTS is anchored to
-- the TARGET profile's memberships (m.user_id = public.profiles.id) and each
-- candidate organization is authorized individually, so a profile in an
-- organization the caller has no rights over is never exposed.
--
-- The EXISTS reads public.organization_members, which is itself RLS-protected.
-- That is intentional and safe: the organization_members policy below depends
-- only on auth.uid() and the SECURITY DEFINER helpers, never on
-- public.profiles, so there is no policy cycle.
create policy profiles_select_self_or_authorized_members
  on public.profiles
  for select
  to authenticated
  using (
    public.profiles.id = (select auth.uid())
    or exists (
      select 1
      from public.organization_members m
      where m.user_id = public.profiles.id
        and (
          public.has_organization_permission(
            m.organization_id, 'ORGANIZATION_MEMBERS_READ'
          )
          or public.has_organization_role(
            m.organization_id, 'VENDOR_SUPER_ADMIN'
          )
        )
    )
  );

-- ============================================================================
-- 3. organization_members
-- ============================================================================
-- A membership row is visible when it is the caller's own, or when the caller
-- holds ORGANIZATION_MEMBERS_READ or VENDOR_SUPER_ADMIN for that row's
-- organization. Both helper calls are SECURITY DEFINER, so evaluating this
-- policy does not re-read public.organization_members under RLS -- the helpers
-- read it with definer rights instead. This is what makes it safe for the
-- profiles policy above to reference this table.
create policy organization_members_select_self_or_authorized
  on public.organization_members
  for select
  to authenticated
  using (
    public.organization_members.user_id = (select auth.uid())
    or public.has_organization_permission(
      public.organization_members.organization_id, 'ORGANIZATION_MEMBERS_READ'
    )
    or public.has_organization_role(
      public.organization_members.organization_id, 'VENDOR_SUPER_ADMIN'
    )
  );

-- ============================================================================
-- 4. roles
-- ============================================================================
-- roles, permissions, and role_permissions are a GLOBAL catalogue: the rows are
-- not scoped to an organization. They are therefore hidden entirely unless the
-- caller holds RBAC_READ or VENDOR_SUPER_ADMIN in at least one of their own
-- organizations. The EXISTS is hard-filtered to m.user_id = auth.uid(), so a
-- caller can only ever test their OWN memberships; the helpers then enforce the
-- active profile/membership/organization/role chain per candidate organization.
--
-- The EXISTS reads public.organization_members under RLS and matches only the
-- caller's own rows, which the self branch of the policy above always admits.
-- That policy never references public.roles, so there is no cycle.
create policy roles_select_rbac_authorized
  on public.roles
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.user_id = (select auth.uid())
        and (
          public.has_organization_permission(m.organization_id, 'RBAC_READ')
          or public.has_organization_role(
            m.organization_id, 'VENDOR_SUPER_ADMIN'
          )
        )
    )
  );

-- ============================================================================
-- 5. permissions
-- ============================================================================
-- Same global-catalogue rule as roles.
create policy permissions_select_rbac_authorized
  on public.permissions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.user_id = (select auth.uid())
        and (
          public.has_organization_permission(m.organization_id, 'RBAC_READ')
          or public.has_organization_role(
            m.organization_id, 'VENDOR_SUPER_ADMIN'
          )
        )
    )
  );

-- ============================================================================
-- 6. role_permissions
-- ============================================================================
-- Same global-catalogue rule as roles.
create policy role_permissions_select_rbac_authorized
  on public.role_permissions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.user_id = (select auth.uid())
        and (
          public.has_organization_permission(m.organization_id, 'RBAC_READ')
          or public.has_organization_role(
            m.organization_id, 'VENDOR_SUPER_ADMIN'
          )
        )
    )
  );

-- ============================================================================
-- 7. member_roles
-- ============================================================================
-- member_roles carries no organization_id of its own, so the owning
-- organization is resolved through organization_members via
-- organization_member_id. A row is visible when the assignment belongs to one
-- of the caller's own memberships, or when the caller holds RBAC_READ or
-- VENDOR_SUPER_ADMIN for the organization that owns the target membership.
-- Authorization is evaluated against m.organization_id -- the TARGET row's
-- organization -- so an RBAC_READ grant in one organization never exposes
-- assignments in another.
create policy member_roles_select_self_or_rbac_authorized
  on public.member_roles
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members m
      where m.id = public.member_roles.organization_member_id
        and (
          m.user_id = (select auth.uid())
          or public.has_organization_permission(m.organization_id, 'RBAC_READ')
          or public.has_organization_role(
            m.organization_id, 'VENDOR_SUPER_ADMIN'
          )
        )
    )
  );

-- ============================================================================
-- 8. audit_logs
-- ============================================================================
-- audit_logs.organization_id is nullable (it is ON DELETE SET NULL, and global
-- records may be written with no organization). Such rows have no organization
-- to authorize against and must never reach a browser client, so the NOT NULL
-- test is factored OUT of the OR and ANDed across BOTH authorization paths:
--
--     organization_id is not null AND (AUDIT_LOGS_READ OR VENDOR_SUPER_ADMIN)
--
-- Writing it as `(is not null and A) or B` would let the VENDOR_SUPER_ADMIN
-- branch admit null-organization rows. The parenthesisation below prevents
-- that. (The helpers also return false for a null organization id, so this is
-- defence in depth rather than the only guard.) Null-organization audit records
-- remain readable only to server-side code.
create policy audit_logs_select_authorized
  on public.audit_logs
  for select
  to authenticated
  using (
    public.audit_logs.organization_id is not null
    and (
      public.has_organization_permission(
        public.audit_logs.organization_id, 'AUDIT_LOGS_READ'
      )
      or public.has_organization_role(
        public.audit_logs.organization_id, 'VENDOR_SUPER_ADMIN'
      )
    )
  );

-- ============================================================================
-- 9. Privilege hardening
-- ============================================================================
-- RLS policies decide WHICH ROWS a role may read; GRANTs decide whether the
-- role may attempt the statement at all. The two are independent, so the
-- default-deny row model is backed here by a default-deny privilege model:
-- browser roles get SELECT and nothing else.
--
-- Nothing below touches postgres or service_role. Those roles hold their
-- privileges directly (and service_role additionally BYPASSRLS), so revoking
-- from PUBLIC/anon/authenticated leaves trusted server-side access unchanged.

-- PUBLIC is inherited by every role, so any privilege left here would leak to
-- anon and authenticated regardless of the explicit grants below.
revoke all on table
  public.organizations,
  public.profiles,
  public.organization_members,
  public.roles,
  public.permissions,
  public.role_permissions,
  public.member_roles,
  public.audit_logs
from public;

-- anon (unauthenticated publishable-key callers) gets no table access at all.
-- No policy above is TO anon either, so this is belt and braces.
revoke all on table
  public.organizations,
  public.profiles,
  public.organization_members,
  public.roles,
  public.permissions,
  public.role_permissions,
  public.member_roles,
  public.audit_logs
from anon;

-- authenticated loses every write and schema-side privilege. Even if a future
-- migration mistakenly adds a permissive write policy, the missing privilege
-- keeps browser writes failing. TRUNCATE bypasses RLS entirely, so revoking it
-- matters. REFERENCES would allow foreign keys that probe row existence, and
-- TRIGGER would allow attaching code to these tables.
revoke insert, update, delete, truncate, references, trigger on table
  public.organizations,
  public.profiles,
  public.organization_members,
  public.roles,
  public.permissions,
  public.role_permissions,
  public.member_roles,
  public.audit_logs
from authenticated;

-- The only browser privilege: SELECT, further narrowed row-by-row by the
-- policies above.
grant select on table
  public.organizations,
  public.profiles,
  public.organization_members,
  public.roles,
  public.permissions,
  public.role_permissions,
  public.member_roles,
  public.audit_logs
to authenticated;
