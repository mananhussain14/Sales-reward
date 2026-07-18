-- Migration: seed_vendor_admin_roles_permissions
-- Purpose: Seed the initial Vendor Admin role and permission catalogue, and map
--          the three foundation permissions to VENDOR_SUPER_ADMIN. This is the
--          migration that makes the migration-5 RLS policies capable of
--          returning true: until now no role or permission row existed, so
--          every permission-based policy branch evaluated to false.
--
-- Scope notes:
--   * Catalogue data ONLY. No organizations, profiles, users, memberships, or
--     member_roles rows are created. Nothing here grants anyone access -- a
--     human only becomes a Super Admin when trusted server-side code assigns
--     the role via member_roles. This migration deliberately does NOT do that.
--   * No tables, columns, constraints, policies, grants, or helper functions
--     are created or altered. No earlier migration is modified.
--   * RLS is never disabled. Migrations run as the migration role (which owns
--     these tables and is not subject to their policies), so these INSERTs
--     succeed without touching the row security posture. The migration-5
--     policies remain exactly as written.
--   * No permissions for claims, payouts, retailers, products, campaigns, or
--     wallets. Those arrive with their modules.
--
-- Idempotency:
--   Every statement is re-runnable. Roles and permissions upsert on their
--   unique `code`; role_permissions is ON CONFLICT DO NOTHING against its
--   composite primary key. Primary keys come from the tables' own
--   gen_random_uuid() defaults -- no fixed UUIDs -- so re-running never
--   duplicates a row and never rewrites an id that existing FKs point at.
--   Nothing is deleted: rows added out-of-band by a later migration or by
--   server-side code survive untouched.
--
-- Dependencies: migration 2 (roles, permissions, role_permissions, and the
--   unique code constraints these upserts target). The permission codes below
--   are the exact literals referenced by the migration-5 policies:
--   ORGANIZATION_MEMBERS_READ, RBAC_READ, AUDIT_LOGS_READ; the role code is
--   VENDOR_SUPER_ADMIN.

-- ============================================================================
-- 1. Roles
-- ============================================================================
-- CLAIM_REVIEWER and FINANCE_ADMIN are seeded as ACTIVE but intentionally hold
-- NO permissions (see section 3). They are placeholders naming the intended
-- separation of duties; each gains its module-specific permissions only when
-- that module is built. An ACTIVE role with no mapped permissions authorizes
-- nothing -- has_organization_permission() joins through role_permissions and
-- finds no row -- so seeding them now is inert, not a latent grant.
--
-- ON CONFLICT (code) targets the roles_code_unique constraint. The upsert
-- refreshes the human-readable fields and status so this migration stays the
-- single source of truth for the catalogue, while leaving id untouched (any
-- member_roles FK already pointing at the role stays valid).
insert into public.roles (code, name, description, status)
values
  (
    'VENDOR_SUPER_ADMIN',
    'Vendor Super Admin',
    'Full administrative access within an assigned vendor organization.',
    'ACTIVE'
  ),
  (
    'CLAIM_REVIEWER',
    'Claim Reviewer',
    'Reviews submitted sales claims when the claims module is introduced.',
    'ACTIVE'
  ),
  (
    'FINANCE_ADMIN',
    'Finance Admin',
    'Manages payout and finance operations when the finance module is introduced.',
    'ACTIVE'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  status      = excluded.status,
  updated_at  = now();

-- ============================================================================
-- 2. Permissions
-- ============================================================================
-- These three codes are consumed verbatim by the migration-5 RLS policies:
--   * ORGANIZATION_MEMBERS_READ -> profiles_select_self_or_authorized_members,
--                                  organization_members_select_self_or_authorized
--   * RBAC_READ                 -> roles/permissions/role_permissions
--                                  _select_rbac_authorized,
--                                  member_roles_select_self_or_rbac_authorized
--   * AUDIT_LOGS_READ           -> audit_logs_select_authorized
-- The policies match on the literal string, so a typo here would silently
-- deny rather than error. They are byte-for-byte identical to migration 5.
--
-- ON CONFLICT (code) targets permissions_code_unique. permissions has no
-- status column, so module is the field refreshed alongside name/description.
insert into public.permissions (code, name, description, module)
values
  (
    'ORGANIZATION_MEMBERS_READ',
    'Read Organization Members',
    'View profiles and memberships belonging to an authorized organization.',
    'ORGANIZATION_MEMBERS'
  ),
  (
    'RBAC_READ',
    'Read Roles and Permissions',
    'View the role and permission catalogue and organization role assignments.',
    'RBAC'
  ),
  (
    'AUDIT_LOGS_READ',
    'Read Audit Logs',
    'View audit records belonging to an authorized organization.',
    'AUDIT_LOGS'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- ============================================================================
-- 3. Role -> permission mappings
-- ============================================================================
-- All three foundation permissions go to VENDOR_SUPER_ADMIN, and only to it.
-- CLAIM_REVIEWER and FINANCE_ADMIN receive nothing: this statement's WHERE
-- clause names exactly one role code, so no mapping row can reach them.
--
-- The ids are resolved by joining on code rather than being written literally,
-- which is what keeps the migration independent of the generated UUIDs. The
-- cross join is safe and exact: roles.code and permissions.code are both
-- unique, so this yields precisely 1 x 3 = 3 rows.
--
-- ON CONFLICT DO NOTHING targets role_permissions_pkey (role_id,
-- permission_id) -- a re-run is a no-op, and an existing mapping is left
-- exactly as it is rather than rewritten.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN'
  and p.code in (
    'ORGANIZATION_MEMBERS_READ',
    'RBAC_READ',
    'AUDIT_LOGS_READ'
  )
on conflict (role_id, permission_id) do nothing;
