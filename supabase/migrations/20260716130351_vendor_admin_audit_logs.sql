-- Migration: vendor_admin_audit_logs
-- Purpose: Immutable security and administrative activity records for the
--          Vendor Admin system. Creates storage + default-deny RLS only.
--
-- Scope notes:
--   * Depends on core_identity_tables (organizations, profiles).
--   * Append-only by design: no updated_at column, no updated_at trigger.
--   * No audit triggers, no helper functions, no seed data, no service-role
--     logic, no RLS policies. Records are inserted explicitly by trusted
--     server-side code later.
--   * Uses built-in gen_random_uuid(); pgcrypto is NOT enabled.

-- ============================================================================
-- audit_logs
-- ============================================================================
create table public.audit_logs (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        null
                     references public.organizations (id) on delete set null,
  actor_profile_id uuid        null
                     references public.profiles (id) on delete set null,
  action           text        not null,
  entity_type      text        not null,
  entity_id        text        null,
  metadata         jsonb       not null default '{}'::jsonb,
  ip_address       inet        null,
  user_agent       text        null,
  created_at       timestamptz not null default now(),

  constraint audit_logs_action_not_empty
    check (length(trim(action)) > 0),
  constraint audit_logs_entity_type_not_empty
    check (length(trim(entity_type)) > 0),
  constraint audit_logs_metadata_is_object
    check (jsonb_typeof(metadata) = 'object')
);

-- ============================================================================
-- Indexes
-- ============================================================================
-- Org activity feed, newest first.
create index audit_logs_org_created_idx
  on public.audit_logs (organization_id, created_at desc);

-- Per-actor activity feed, newest first.
create index audit_logs_actor_created_idx
  on public.audit_logs (actor_profile_id, created_at desc);

-- Look up the history of a specific entity.
create index audit_logs_entity_idx
  on public.audit_logs (entity_type, entity_id);

-- Global activity feed, newest first.
create index audit_logs_created_idx
  on public.audit_logs (created_at desc);

-- ============================================================================
-- Row Level Security (default-deny; no policies)
-- ============================================================================
-- With RLS enabled and no policies, the anon/authenticated (publishable-key)
-- roles are denied ALL access, including INSERT/UPDATE/DELETE. Browser users
-- therefore cannot create, modify, or delete audit records. Writes will occur
-- only through trusted server-side code later.
alter table public.audit_logs enable row level security;
