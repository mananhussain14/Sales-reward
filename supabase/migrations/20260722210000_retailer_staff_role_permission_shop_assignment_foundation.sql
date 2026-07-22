-- Migration: retailer_staff_role_permission_shop_assignment_foundation
-- Purpose: The database foundation for Retailer staff management (Checkpoint 1).
--          Five related parts:
--            1. Two roles: RETAILER_MANAGER and SALES_STAFF, seeded ACTIVE.
--            2. Three permissions in a new RETAILER_STAFF module:
--               RETAILER_STAFF_READ, RETAILER_STAFF_MANAGE, RETAILER_STAFF_SHOP_ASSIGN.
--            3. Role -> permission mappings implementing the locked MVP model.
--            4. public.retailer_shop_members — the many-to-many, history-preserving
--               assignment of an organization_members row to a retailer_shops row,
--               with a cross-tenant integrity trigger.
--            5. Default-deny RLS and privilege hardening on the new table.
--
-- LOCKED MVP DECISIONS THIS MIGRATION ENCODES
--   * Only RETAILER_OWNER may MANAGE staff or ASSIGN shops (it alone receives
--     RETAILER_STAFF_MANAGE and RETAILER_STAFF_SHOP_ASSIGN).
--   * RETAILER_MANAGER has read-only staff visibility (RETAILER_STAFF_READ only)
--     and retailer-wide access; it receives neither MANAGE nor SHOP_ASSIGN.
--   * SALES_STAFF is shop-scoped; in this checkpoint it receives only
--     RETAILER_PORTAL_READ so the portal shell can render. The SALES_STAFF
--     "at least one active shop assignment" rule is deliberately NOT enforced by
--     this table — a single-row BEFORE trigger cannot validate a multi-row final
--     state — and belongs to the future staff-invitation/assignment RPCs.
--   * RETAILER_OWNER and RETAILER_MANAGER are retailer-wide by role and receive NO
--     explicit retailer_shop_members rows.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * No invitation table, function, policy, or flag is created or altered. The
--     staff invitation RPCs and shop-assignment write RPCs arrive in later
--     checkpoints; this is catalogue + schema only.
--   * No assignment-write RPC and no audit row. Schema seeding has no runtime
--     actor and no runtime event; audit entries will be written by the future
--     assignment RPCs, exactly as seed migrations 6, 11, 15, and 16 wrote none.
--   * No browser table GRANT and no RLS policy on retailer_shop_members. The
--     browser reaches this table only through future SECURITY DEFINER RPCs.
--   * No existing table, column, constraint, index, trigger, policy, function,
--     role, permission, or mapping is dropped or redefined. RETAILER_OWNER's
--     existing RETAILER_PORTAL_READ and RETAILER_SHOPS_READ mappings (migration 16)
--     are preserved; the three staff mappings are ADDED to them.
--   * No RETAILERS_READ grant to any staff role — that code drives the Vendor-side
--     cross-tenant RLS policies (migrations 9/11) and must stay Vendor-only.
--
-- Idempotency: roles and permissions upsert on their unique `code`; every mapping
--   uses ON CONFLICT (role_id, permission_id) DO NOTHING. No fixed UUIDs — all ids
--   come from the tables' own gen_random_uuid() defaults, so a re-run never
--   duplicates a row and never rewrites an id an FK points at. Nothing is deleted.
--   The DDL (table, indexes, functions, triggers) uses plain CREATE and will fail
--   rather than silently accept a conflicting existing object, matching the repo
--   convention for schema migrations.
--
-- Dependencies:
--   * migration 20260716124419 (organizations, profiles, organization_members,
--     public.set_updated_at()).
--   * migration 20260716125559 (roles, permissions, role_permissions, and the
--     unique code / composite PK constraints these statements target).
--   * migration 20260716133023 (the code-based idempotent seed pattern reused here).
--   * migration 20260717094520 (retailer_shops, and the SECURITY DEFINER trigger
--     validator + privilege-hardening pattern reused for the tenant trigger).
--   * migration 20260720092755 (the RETAILER_OWNER role this maps staff permissions
--     onto, and the role-seed safety-guard pattern reused below).
--   * migration 20260720215500 (RETAILER_PORTAL_READ, RETAILER_SHOPS_READ, and the
--     RETAILER_OWNER mappings preserved here).

-- ============================================================================
-- PART A — Roles
-- ============================================================================
-- Both roles are seeded ACTIVE, matching how migration 6 seeded CLAIM_REVIEWER /
-- FINANCE_ADMIN and migration 15 seeded RETAILER_OWNER.
--
-- SAFETY GUARD (before the upsert). "Idempotent" must not mean "silently overwrite
-- something incompatible". Unlike migration 15's RETAILER_OWNER guard (which
-- protected a zero-permission role and therefore rejected ANY existing mapping or
-- assignment), these two roles are seeded WITH a known, approved permission set.
-- The unsafe case here is therefore narrower and specific: an existing role of the
-- same code that already holds a permission OUTSIDE its approved set — evidence
-- that some other process widened it, which this seed must not paper over.
--
-- This guard is deliberately self-consistent on re-run: after a first successful
-- application each role holds EXACTLY its approved permissions, so the "unexpected
-- mapping" query returns nothing and the guard stays silent. An absent role (the
-- ordinary first run) is skipped. It reads rows and writes nothing.
--
-- Member assignments alone are NOT rejected: seeding a role that people already
-- hold with the SAME permission set is safe and idempotent, so there is nothing to
-- protect against there — the only redefinition risk is an unexpected mapping.
do $$
declare
  v_role_id uuid;
  v_bad     text;
begin
  -- RETAILER_MANAGER: approved set = PORTAL_READ, SHOPS_READ, STAFF_READ.
  select r.id into v_role_id
  from public.roles r
  where r.code = 'RETAILER_MANAGER';

  if v_role_id is not null then
    select string_agg(perm.code, ', ' order by perm.code) into v_bad
    from public.role_permissions rp
    join public.permissions perm on perm.id = rp.permission_id
    where rp.role_id = v_role_id
      and perm.code not in (
        'RETAILER_PORTAL_READ',
        'RETAILER_SHOPS_READ',
        'RETAILER_STAFF_READ'
      );

    if v_bad is not null then
      raise exception
        'Seed precondition failed: role RETAILER_MANAGER already holds unexpected permission mapping(s): %; refusing to redefine a role widened out-of-band', v_bad;
    end if;
  end if;

  -- SALES_STAFF: approved set = PORTAL_READ only (MVP).
  select r.id into v_role_id
  from public.roles r
  where r.code = 'SALES_STAFF';

  if v_role_id is not null then
    select string_agg(perm.code, ', ' order by perm.code) into v_bad
    from public.role_permissions rp
    join public.permissions perm on perm.id = rp.permission_id
    where rp.role_id = v_role_id
      and perm.code not in (
        'RETAILER_PORTAL_READ'
      );

    if v_bad is not null then
      raise exception
        'Seed precondition failed: role SALES_STAFF already holds unexpected permission mapping(s): %; refusing to redefine a role widened out-of-band', v_bad;
    end if;
  end if;
end;
$$;

-- ON CONFLICT (code) targets roles_code_unique. The upsert refreshes the
-- human-readable fields and status so this migration stays the single source of
-- truth for these catalogue entries, while leaving id untouched (any member_roles
-- FK already pointing at the role stays valid across a re-run).
insert into public.roles (code, name, description, status)
values
  (
    'RETAILER_MANAGER',
    'Retailer Manager',
    'Retailer-wide manager with read-only visibility of staff.',
    'ACTIVE'
  ),
  (
    'SALES_STAFF',
    'Sales Staff',
    'Shop-scoped sales staff member of a Retailer organization.',
    'ACTIVE'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  status      = excluded.status,
  updated_at  = now();

-- ============================================================================
-- PART B — Permissions
-- ============================================================================
-- Three permissions in a new RETAILER_STAFF module, following the
-- one-module-per-domain convention alongside ORGANIZATION_MEMBERS, RBAC,
-- AUDIT_LOGS, RETAILERS, and RETAILER_PORTAL. `module` is required
-- (permissions_module_not_empty). permissions has no status column, so module is
-- the field refreshed alongside name/description.
--
-- ON CONFLICT (code) targets permissions_code_unique, matching migrations 6, 11,
-- 12, 15, and 16 exactly. The upsert refreshes only the human-readable fields and
-- module, leaving id untouched so any role_permissions FK survives a re-run.
insert into public.permissions (code, name, description, module)
values
  (
    'RETAILER_STAFF_READ',
    'Read Retailer Staff',
    'View the staff roster of the authenticated user''s own Retailer organization.',
    'RETAILER_STAFF'
  ),
  (
    'RETAILER_STAFF_MANAGE',
    'Manage Retailer Staff',
    'Invite, resend, revoke, deactivate, and reactivate staff of one''s own Retailer organization.',
    'RETAILER_STAFF'
  ),
  (
    'RETAILER_STAFF_SHOP_ASSIGN',
    'Assign Retailer Staff to Shops',
    'Add and remove staff-to-shop assignments within one''s own Retailer organization.',
    'RETAILER_STAFF'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- ============================================================================
-- PART C — Role -> permission mappings
-- ============================================================================
-- Precondition: every role and permission this section references must exist.
-- Resolving a mapping by code silently writes nothing when a side is missing,
-- which would leave the catalogue half-configured and fail closed only later, at
-- the point some page renders empty. This raises instead. It reads rows and writes
-- nothing. In a correctly ordered history none of these can be missing —
-- RETAILER_OWNER and the two portal permissions come from migrations 15/16, and
-- the staff roles and permissions were just seeded in Parts A and B — which is
-- exactly why the check is worth stating: it fires only when an assumption has
-- already broken.
do $$
declare
  v_missing text;
begin
  select string_agg(needed.code, ', ' order by needed.code) into v_missing
  from (
    values
      ('RETAILER_OWNER'),
      ('RETAILER_MANAGER'),
      ('SALES_STAFF')
  ) as needed(code)
  where not exists (
    select 1 from public.roles r where r.code = needed.code
  );

  if v_missing is not null then
    raise exception 'Seed precondition failed: required role(s) missing: %', v_missing;
  end if;

  select string_agg(needed.code, ', ' order by needed.code) into v_missing
  from (
    values
      ('RETAILER_PORTAL_READ'),
      ('RETAILER_SHOPS_READ'),
      ('RETAILER_STAFF_READ'),
      ('RETAILER_STAFF_MANAGE'),
      ('RETAILER_STAFF_SHOP_ASSIGN')
  ) as needed(code)
  where not exists (
    select 1 from public.permissions p where p.code = needed.code
  );

  if v_missing is not null then
    raise exception 'Seed precondition failed: required permission(s) missing: %', v_missing;
  end if;
end;
$$;

-- RETAILER_OWNER — ADD the three staff permissions. Its existing
-- RETAILER_PORTAL_READ and RETAILER_SHOPS_READ mappings (migration 16) are listed
-- too, but ON CONFLICT DO NOTHING makes re-asserting them a no-op that neither
-- duplicates nor rewrites the existing rows. No mapping is removed. The WHERE
-- clause names exactly one role code, so nothing can reach another role.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'RETAILER_OWNER'
  and p.code in (
    'RETAILER_PORTAL_READ',
    'RETAILER_SHOPS_READ',
    'RETAILER_STAFF_READ',
    'RETAILER_STAFF_MANAGE',
    'RETAILER_STAFF_SHOP_ASSIGN'
  )
on conflict (role_id, permission_id) do nothing;

-- RETAILER_MANAGER — read-only staff visibility plus the portal/shop reads. It
-- receives NEITHER RETAILER_STAFF_MANAGE NOR RETAILER_STAFF_SHOP_ASSIGN in this
-- checkpoint: those two codes are absent from this list, and no other statement in
-- this migration names RETAILER_MANAGER, so the role cannot acquire them here.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'RETAILER_MANAGER'
  and p.code in (
    'RETAILER_PORTAL_READ',
    'RETAILER_SHOPS_READ',
    'RETAILER_STAFF_READ'
  )
on conflict (role_id, permission_id) do nothing;

-- SALES_STAFF — RETAILER_PORTAL_READ only (MVP), so the portal shell renders. Its
-- sales permissions arrive with the claims module. It receives no staff-management,
-- shop-assignment, or shop-read permission here.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'SALES_STAFF'
  and p.code = 'RETAILER_PORTAL_READ'
on conflict (role_id, permission_id) do nothing;

-- No statement anywhere in this migration maps any RETAILER_STAFF_* permission to
-- VENDOR_SUPER_ADMIN, CLAIM_REVIEWER, FINANCE_ADMIN, or SALES_STAFF. Each mapping
-- INSERT above names exactly one role in its WHERE clause, so the staff permissions
-- reach only RETAILER_OWNER (all three) and RETAILER_MANAGER (READ only).

-- ============================================================================
-- PART D — retailer_shop_members
-- ============================================================================
-- The many-to-many assignment of a staff MEMBERSHIP to a SHOP. Rows are RETIRED BY
-- removed_at AND NEVER DELETED in normal operation, matching how this schema
-- retires organizations, memberships, relationships, shops, and invitations.
--
-- NO status column, deliberately. A shop assignment is a binary edge — live
-- (removed_at is null) or retired (removed_at set). The staff member's own
-- lifecycle lives on organization_members.status; the shop's on
-- retailer_shops.status. Reassignment creates a NEW row, so history is preserved
-- by accumulation rather than by a status enum this edge does not need.
create table public.retailer_shop_members (
  id                     uuid        primary key default gen_random_uuid(),

  -- ON DELETE CASCADE, matching member_roles.organization_member_id (migration 2):
  -- an assignment is a pure edge with no meaning once its member is gone. In normal
  -- operation memberships are retired by status and never hard-deleted, so this is
  -- a safety net for the rare hard delete rather than an ordinary path.
  organization_member_id uuid        not null,

  -- ON DELETE RESTRICT, matching vendor_retailers / retailer_shops (migration 8):
  -- shops are closed by status, not erased. A shop with assignment history on
  -- record cannot be hard-deleted and must be DEACTIVATED instead.
  retailer_shop_id       uuid        not null,

  -- Who created the assignment. ON DELETE SET NULL, matching
  -- member_roles.assigned_by (migration 2): removing the assigning profile
  -- preserves the assignment record. References public.profiles(id) — the same
  -- authoritative identity every other "who did this" column in this schema uses,
  -- never auth.users directly.
  assigned_by            uuid        null,

  assigned_at            timestamptz not null default now(),

  -- NULL means live; a timestamp means retired. This is the entire lifecycle of an
  -- assignment edge.
  removed_at             timestamptz null,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint retailer_shop_members_member_fk
    foreign key (organization_member_id)
    references public.organization_members (id) on delete cascade,

  constraint retailer_shop_members_shop_fk
    foreign key (retailer_shop_id)
    references public.retailer_shops (id) on delete restrict,

  constraint retailer_shop_members_assigned_by_fk
    foreign key (assigned_by)
    references public.profiles (id) on delete set null
);

-- ============================================================================
-- PART E — Indexes
-- ============================================================================
-- THE duplicate guard. Partial on removed_at IS NULL, which is what allows history
-- to accumulate: one (member, shop) pair may hold at most ONE live assignment,
-- while any number of retired rows for that same pair coexist freely. A plain
-- unique constraint could express neither the partiality nor the predicate, which
-- is why this is an index. This mirrors retailer_invitations_pending_unique_idx
-- (migration 15).
create unique index retailer_shop_members_live_unique_idx
  on public.retailer_shop_members (organization_member_id, retailer_shop_id)
  where removed_at is null;

-- Live shops for a member — "which shops does this person work?". Partial to the
-- live edges, so it stays small as history accumulates.
create index retailer_shop_members_member_active_idx
  on public.retailer_shop_members (organization_member_id)
  where removed_at is null;

-- Live staff for a shop — "who works this shop?". The reverse lookup, likewise
-- partial to live edges.
create index retailer_shop_members_shop_active_idx
  on public.retailer_shop_members (retailer_shop_id)
  where removed_at is null;

-- ============================================================================
-- PART F — Tenant-consistency trigger
-- ============================================================================
-- The security-relevant integrity rule for this table: an assignment may only join
-- a member and a shop that belong to the SAME Retailer organization. A foreign key
-- can guarantee each referenced row EXISTS but nothing about the relationship
-- BETWEEN the two rows; a check constraint may read only the row being written, so
-- it cannot compare against organization_members and retailer_shops. Trigger
-- validation is the mechanism that can — the same reasoning migration 8 gives for
-- assert_organization_type().
--
-- This does NOT reuse assert_organization_type(): that validator checks ONE
-- organization's TYPE, whereas here we must compare the IDENTITY of two
-- organizations resolved from two different tables. A dedicated validator is the
-- honest shape.
--
-- A separate TYPE check is unnecessary: retailer_shops.retailer_organization_id is
-- already trigger-guaranteed to be a RETAILER (migration 8), so equality of the
-- member's organization with the shop's retailer organization implies the member's
-- organization is that same RETAILER.
--
-- SECURITY DEFINER is load-bearing, not habitual: public.organization_members and
-- public.retailer_shops are RLS-enabled, and a validator running under the writer's
-- rights could see a partial view of either. The invariant must be evaluated
-- against the tables as they truly are. search_path = '' with fully qualified
-- references throughout, matching the migration-8 validators. No dynamic SQL, no
-- writes, reads exactly two tables.
--
-- It deliberately does NOT check membership lifecycle, shop lifecycle, or the
-- SALES_STAFF minimum-shop rule. Assignment rows may exist for an INVITED
-- membership (so an accepted staff invitation can apply them atomically later);
-- access remains gated because every authorization helper requires an ACTIVE
-- membership. Shop-active and minimum-shop are policies for the future
-- invitation/assignment RPCs, where the full multi-row final state is visible.
create function public.retailer_shop_members_assert_same_retailer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_org uuid;
  v_shop_org   uuid;
begin
  select m.organization_id
    into v_member_org
  from public.organization_members m
  where m.id = new.organization_member_id;

  select s.retailer_organization_id
    into v_shop_org
  from public.retailer_shops s
  where s.id = new.retailer_shop_id;

  -- Reachable despite the foreign keys: BEFORE ROW triggers fire before the FK is
  -- checked (foreign keys are AFTER ROW triggers), so this validator can run
  -- against an id no row owns. Denying here is both correct and earlier than the FK
  -- would be. The message names the rule, never a row.
  if v_member_org is null or v_shop_org is null then
    raise exception 'Referenced staff member or shop does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  -- The one invariant this trigger exists to enforce. The message names the RULE
  -- that was broken and nothing else — no organization id, name, or status. An
  -- error string is not a safe place to describe rows the caller may not read.
  if v_member_org <> v_shop_org then
    raise exception 'Staff member and shop must belong to the same Retailer'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Privileges: identical reasoning to migration 8's trigger validators. PostgreSQL
-- grants EXECUTE to PUBLIC on every new function by default, and PUBLIC is
-- inherited by every role — so without the revokes below anon and authenticated
-- would hold EXECUTE on a SECURITY DEFINER function despite this migration never
-- granting them anything. The triggers created below keep working regardless:
-- PostgreSQL checks EXECUTE on a trigger function at CREATE TRIGGER time (against
-- the migration role that owns it), not when the trigger fires.
revoke all     on function public.retailer_shop_members_assert_same_retailer() from public;
revoke execute on function public.retailer_shop_members_assert_same_retailer() from anon;
revoke execute on function public.retailer_shop_members_assert_same_retailer() from authenticated;

-- BEFORE ROW, so validation runs before the row is written and before the foreign
-- keys are checked. Split into INSERT and UPDATE triggers because the UPDATE
-- variant needs a WHEN clause referencing OLD, which does not exist during INSERT.
create trigger retailer_shop_members_assert_same_retailer_on_insert
  before insert on public.retailer_shop_members
  for each row execute function public.retailer_shop_members_assert_same_retailer();

-- The UPDATE trigger is narrowed twice over: UPDATE OF limits it to statements that
-- mention a referenced id, and the WHEN clause limits it further to statements that
-- actually change one. An ordinary removed_at write therefore performs no extra
-- lookups and cannot be blocked by this trigger.
create trigger retailer_shop_members_assert_same_retailer_on_update
  before update of organization_member_id, retailer_shop_id
  on public.retailer_shop_members
  for each row
  when (
    new.organization_member_id is distinct from old.organization_member_id
    or new.retailer_shop_id is distinct from old.retailer_shop_id
  )
  execute function public.retailer_shop_members_assert_same_retailer();

-- Reuses public.set_updated_at() from migration 1 for every UPDATE.
create trigger set_updated_at_on_retailer_shop_members
  before update on public.retailer_shop_members
  for each row execute function public.set_updated_at();

-- ============================================================================
-- PART G — Row Level Security and privilege hardening
-- ============================================================================
-- RLS enabled with ZERO policies: default-deny for anon and authenticated, reads
-- and writes alike. This is the posture retailer_invitations (migration 15) and
-- audit_logs (migration 3) hold, and it is deliberate: a browser client cannot
-- read or write one byte of this table by any route. Assignment access will come
-- exclusively through future SECURITY DEFINER RPCs that authorize the caller
-- first.
alter table public.retailer_shop_members enable row level security;

-- RLS decides WHICH ROWS a role may touch; GRANTs decide whether the role may
-- attempt the statement at all. The two are independent, and the gap is not
-- theoretical: Supabase ships ALTER DEFAULT PRIVILEGES for the public schema that
-- grant table privileges to anon and authenticated automatically as tables are
-- created. Left alone, this table would hand the browser roles privileges this
-- migration never intended — which is exactly what migrations 5, 8, and 15 had to
-- undo. TRUNCATE bypasses RLS entirely, REFERENCES would allow FKs that probe row
-- existence, and TRIGGER would allow attaching code — all covered by revoke all.
--
-- Nothing here grants anything. No SELECT policy exists, so no SELECT is granted
-- either. postgres and service_role are untouched: they hold their privileges
-- directly (and service_role additionally BYPASSRLS), so the future trusted RPC
-- path is unaffected.
revoke all on table public.retailer_shop_members from public;
revoke all on table public.retailer_shop_members from anon;
revoke all on table public.retailer_shop_members from authenticated;

-- Closing note: no table privilege is granted to anon or authenticated anywhere in
-- this migration, and no RLS policy is created, altered, or dropped on any table.
-- roles, permissions, role_permissions, member_roles, organizations, profiles,
-- organization_members, retailer_shops, retailer_invitations, vendor_retailers,
-- and audit_logs all keep exactly the posture their own migrations left them in.
-- Access to retailer_shop_members exists only through future RPCs.
