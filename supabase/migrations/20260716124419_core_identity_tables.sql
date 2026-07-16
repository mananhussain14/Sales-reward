-- Migration: core_identity_tables
-- Purpose: Foundation identity tables for the SalesReward Vendor Admin —
--          organizations, application profiles (linked to Supabase Auth), and
--          the membership link between them. Includes a reusable updated_at
--          trigger and enables Row Level Security (default-deny; no policies yet).
--
-- Scope notes:
--   * No roles/permissions/audit/retailer/product/etc. tables (added later).
--   * No seed data, no bootstrap functions, no service-role logic.
--   * No auth.users trigger — profiles are created explicitly by trusted
--     server-side code later.
--   * Uses built-in gen_random_uuid(); pgcrypto is NOT enabled.

-- ============================================================================
-- 1. Reusable updated_at trigger function
-- ============================================================================
-- Defined first because the table triggers below depend on it. search_path is
-- pinned to '' so unqualified object references cannot be hijacked; now() is
-- resolved from pg_catalog, which is always available.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- 2. organizations
-- ============================================================================
create table public.organizations (
  id                uuid        primary key default gen_random_uuid(),
  name              text        not null,
  organization_type text        not null default 'VENDOR',
  status            text        not null default 'ACTIVE',
  country_code      text        null,
  default_currency  text        null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint organizations_name_not_empty
    check (length(trim(name)) > 0),
  constraint organizations_type_allowed
    check (organization_type in ('VENDOR', 'RETAILER')),
  constraint organizations_status_allowed
    check (status in ('ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  constraint organizations_country_code_len
    check (country_code is null or char_length(country_code) = 2),
  constraint organizations_default_currency_len
    check (default_currency is null or char_length(default_currency) = 3)
);

-- ============================================================================
-- 3. profiles  (1:1 with auth.users — id IS the auth user id)
-- ============================================================================
create table public.profiles (
  id            uuid        primary key
                  references auth.users (id) on delete cascade,
  first_name    text        not null,
  last_name     text        not null,
  mobile_number text        null,
  status        text        not null default 'ACTIVE',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint profiles_first_name_not_empty
    check (length(trim(first_name)) > 0),
  constraint profiles_last_name_not_empty
    check (length(trim(last_name)) > 0),
  constraint profiles_status_allowed
    check (status in ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'))
);

-- ============================================================================
-- 4. organization_members  (links a profile to an organization)
-- ============================================================================
create table public.organization_members (
  id              uuid        primary key default gen_random_uuid(),
  organization_id uuid        not null
                    references public.organizations (id) on delete cascade,
  user_id         uuid        not null
                    references public.profiles (id) on delete cascade,
  status          text        not null default 'ACTIVE',
  joined_at       timestamptz null,
  deactivated_at  timestamptz null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint organization_members_unique_membership
    unique (organization_id, user_id),
  constraint organization_members_status_allowed
    check (status in ('INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'))
);

-- ============================================================================
-- 5. updated_at triggers
-- ============================================================================
create trigger set_updated_at_on_organizations
  before update on public.organizations
  for each row execute function public.set_updated_at();

create trigger set_updated_at_on_profiles
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger set_updated_at_on_organization_members
  before update on public.organization_members
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 6. Indexes
-- ============================================================================
-- organizations(status): filter organizations by lifecycle state.
create index organizations_status_idx
  on public.organizations (status);

-- organization_members(user_id): look up all memberships for a given profile.
-- (Not covered by the unique(organization_id, user_id) index, whose leading
--  column is organization_id.)
create index organization_members_user_id_idx
  on public.organization_members (user_id);

-- organization_members(organization_id, status): list members of an org by
-- state. The unique(organization_id, user_id) index cannot serve status
-- filtering, so this composite is not redundant.
create index organization_members_org_status_idx
  on public.organization_members (organization_id, status);

-- ============================================================================
-- 7. Row Level Security (default-deny; policies added in a later migration)
-- ============================================================================
alter table public.organizations        enable row level security;
alter table public.profiles             enable row level security;
alter table public.organization_members enable row level security;
