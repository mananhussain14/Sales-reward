-- Migration: seed_retailer_read_permission
-- Purpose: Seed the RETAILERS_READ permission and map it to VENDOR_SUPER_ADMIN.
--          This is the migration that makes the migration-9 Retailer RLS
--          policies capable of returning true: until now no permission row
--          carried that code, so has_organization_permission() found no matching
--          row and every Retailer policy denied every row to everyone.
--
--          Migration 6 did exactly this for the foundation policies. The
--          sequencing is deliberate in both cases — policies land fail-closed,
--          and the seed is what opens them.
--
-- Scope notes:
--   * Catalogue data ONLY. No organizations, retailers, shops, profiles, users,
--     memberships, member_roles, or vendor_retailers rows are created. Nothing
--     here grants any HUMAN access to anything: a person becomes able to read
--     Retailers only if trusted server-side code has already assigned them the
--     VENDOR_SUPER_ADMIN role via member_roles. This migration deliberately does
--     NOT do that.
--   * No Retailer records will appear anywhere until tenant data is bootstrapped
--     separately. This migration creates the permission to read them, not the
--     things to be read.
--   * No RETAILER_OWNER or RETAILER_STAFF role. Those belong with the invitation
--     milestone that first creates such people; seeding them now would be
--     defining vocabulary for a module that does not exist.
--   * No tables, columns, constraints, policies, grants, functions, or triggers
--     are created or altered. No earlier migration is modified.
--   * RLS is never disabled. Migrations run as the migration role (which owns
--     these tables and is not subject to their policies), so these statements
--     succeed without touching the row security posture. The migration-9 policies
--     remain exactly as written.
--
-- Idempotency:
--   Every statement is re-runnable. The permission upserts on its unique `code`;
--   role_permissions is ON CONFLICT DO NOTHING against its composite primary key.
--   The primary key comes from the table's own gen_random_uuid() default -- no
--   fixed UUIDs -- so a re-run never duplicates a row and never rewrites an id
--   that existing FKs point at. Nothing is deleted.
--
-- Dependencies: migration 2 (permissions, role_permissions, and the unique code
--   constraints these upserts target) and migration 6 (the seeded
--   VENDOR_SUPER_ADMIN role this maps to). The permission code below is the exact
--   literal referenced by the migration-9 policies: RETAILERS_READ.

-- ============================================================================
-- 1. Permission
-- ============================================================================
-- Exactly one permission. It is consumed verbatim by all three migration-9
-- Retailer policies:
--   * organizations_select_vendor_managed_retailers
--   * vendor_retailers_select_vendor_authorized
--   * retailer_shops_select_vendor_authorized
-- Those policies match on the literal string, so a typo here would silently deny
-- rather than error. It is byte-for-byte identical to migration 9.
--
-- `module` is required (permissions.module is NOT NULL with a non-empty check)
-- and follows the established one-module-per-domain convention alongside
-- ORGANIZATION_MEMBERS, RBAC, and AUDIT_LOGS.
--
-- ON CONFLICT (code) targets permissions_code_unique, matching migration 6's
-- convention exactly. The upsert refreshes only the human-readable fields and
-- the module, so this migration stays the single source of truth for the
-- catalogue entry, while leaving `id` untouched -- any role_permissions FK
-- already pointing at this permission stays valid across a re-run.
insert into public.permissions (code, name, description, module)
values
  (
    'RETAILERS_READ',
    'Read Retailers',
    'Read Vendor-managed Retailer organizations, relationships, and shop locations.',
    'RETAILERS'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- ============================================================================
-- 2. Precondition: the target role must exist
-- ============================================================================
-- The mapping below resolves its role by code. If VENDOR_SUPER_ADMIN were
-- missing, that SELECT would simply return no rows: the INSERT would write
-- nothing, the migration would report success, and RETAILERS_READ would sit in
-- the catalogue assigned to nobody. Every Retailer policy would keep denying,
-- and the only symptom would be a Retailers page that looks empty rather than
-- broken -- fail-closed, but silently, and silence is the hard part to debug.
--
-- This raises instead. It is a precondition check, not a permission grant: it
-- reads one row and writes nothing. Migration 6 seeds VENDOR_SUPER_ADMIN, so
-- this cannot fire in a correctly ordered migration history -- which is exactly
-- why it is worth stating. It fires only when an assumption this migration
-- depends on has already broken.
do $$
begin
  if not exists (
    select 1
    from public.roles r
    where r.code = 'VENDOR_SUPER_ADMIN'
  ) then
    raise exception 'Seed precondition failed: role VENDOR_SUPER_ADMIN does not exist, so RETAILERS_READ cannot be assigned';
  end if;
end;
$$;

-- ============================================================================
-- 3. Role -> permission mapping
-- ============================================================================
-- RETAILERS_READ goes to VENDOR_SUPER_ADMIN, and only to it. This statement's
-- WHERE clause names exactly one role code, so no mapping row can reach
-- CLAIM_REVIEWER, FINANCE_ADMIN, or any role added later: a role that is not
-- named here receives nothing, and an unknown future role would have to be
-- granted this permission by its own deliberate migration.
--
-- The ids are resolved by joining on code rather than being written literally,
-- which is what keeps the migration independent of the generated UUIDs. The
-- cross join is safe and exact: roles.code and permissions.code are both unique,
-- so this yields precisely 1 x 1 = 1 row.
--
-- ON CONFLICT DO NOTHING targets role_permissions_pkey (role_id, permission_id)
-- -- a re-run is a no-op, and an existing mapping is left exactly as it is
-- rather than rewritten.
--
-- This completes the authorization path, which stays permission-based end to end:
--
--   VENDOR_SUPER_ADMIN -> role_permissions -> RETAILERS_READ -> Retailer policies
--
-- No Retailer RLS policy names a role. The Super Admin reaches Retailer rows
-- because of the mapping created here, not because a policy mentions them, so a
-- future RETAILER_MANAGER needs a row in this table rather than a policy rewrite.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN'
  and p.code = 'RETAILERS_READ'
on conflict (role_id, permission_id) do nothing;
