-- Migration: vendor_admin_rbac
-- Purpose: Role-based access control for the SalesReward Vendor Admin —
--          roles, permissions, the role<->permission mapping, and the
--          member<->role assignment. Reuses the existing set_updated_at()
--          trigger function and enables Row Level Security (default-deny;
--          no policies yet).
--
-- Scope notes:
--   * Depends on core_identity_tables (organization_members, profiles,
--     public.set_updated_at()).
--   * No seed data, no authorization helper functions, no service-role logic,
--     no audit_logs, no RLS policies — all added in later migrations.
--   * Uses built-in gen_random_uuid(); pgcrypto is NOT enabled.

-- ============================================================================
-- 1. roles
-- ============================================================================
create table public.roles (
  id          uuid        primary key default gen_random_uuid(),
  code        text        not null,
  name        text        not null,
  description text        null,
  status      text        not null default 'ACTIVE',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint roles_code_not_empty
    check (length(trim(code)) > 0),
  constraint roles_name_not_empty
    check (length(trim(name)) > 0),
  constraint roles_code_unique
    unique (code),
  constraint roles_status_allowed
    check (status in ('ACTIVE', 'INACTIVE'))
);

-- ============================================================================
-- 2. permissions
-- ============================================================================
create table public.permissions (
  id          uuid        primary key default gen_random_uuid(),
  code        text        not null,
  name        text        not null,
  description text        null,
  module      text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint permissions_code_not_empty
    check (length(trim(code)) > 0),
  constraint permissions_name_not_empty
    check (length(trim(name)) > 0),
  constraint permissions_module_not_empty
    check (length(trim(module)) > 0),
  constraint permissions_code_unique
    unique (code)
);

-- ============================================================================
-- 3. role_permissions  (M:N roles <-> permissions)
-- ============================================================================
create table public.role_permissions (
  role_id       uuid        not null
                  references public.roles (id) on delete cascade,
  permission_id uuid        not null
                  references public.permissions (id) on delete cascade,
  created_at    timestamptz not null default now(),

  constraint role_permissions_pkey
    primary key (role_id, permission_id)
);

-- ============================================================================
-- 4. member_roles  (which roles an organization member holds)
-- ============================================================================
-- role_id uses ON DELETE RESTRICT so a role that is still assigned to members
-- cannot be deleted out from under them. assigned_by is SET NULL so removing
-- the assigning profile preserves the assignment record.
create table public.member_roles (
  organization_member_id uuid        not null
                           references public.organization_members (id) on delete cascade,
  role_id                uuid        not null
                           references public.roles (id) on delete restrict,
  assigned_by            uuid        null
                           references public.profiles (id) on delete set null,
  assigned_at            timestamptz not null default now(),

  constraint member_roles_pkey
    primary key (organization_member_id, role_id)
);

-- ============================================================================
-- 5. updated_at triggers (reusing public.set_updated_at())
-- ============================================================================
-- role_permissions and member_roles have no updated_at column, so no trigger.
create trigger set_updated_at_on_roles
  before update on public.roles
  for each row execute function public.set_updated_at();

create trigger set_updated_at_on_permissions
  before update on public.permissions
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 6. Indexes
-- ============================================================================
-- roles(status): filter roles by lifecycle state.
create index roles_status_idx
  on public.roles (status);

-- permissions(module): group/list permissions by module.
create index permissions_module_idx
  on public.permissions (module);

-- member_roles(role_id): find all members holding a given role. (Not covered
-- by the PK, whose leading column is organization_member_id.)
create index member_roles_role_id_idx
  on public.member_roles (role_id);

-- role_permissions(permission_id): find all roles granting a given permission.
-- (Not covered by the PK, whose leading column is role_id.)
create index role_permissions_permission_id_idx
  on public.role_permissions (permission_id);

-- ============================================================================
-- 7. Row Level Security (default-deny; policies added in a later migration)
-- ============================================================================
-- With RLS enabled and no policies, the anon/authenticated (publishable-key)
-- roles are denied all access. Browser users therefore cannot assign roles
-- (member_roles) or change role<->permission mappings (role_permissions) —
-- those mutations will happen only through trusted server-side code later.
alter table public.roles            enable row level security;
alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;
alter table public.member_roles     enable row level security;
