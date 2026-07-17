-- Migration: vendor_super_admin_context
-- Purpose: One read-only function that resolves the ENTIRE Vendor Super Admin
--          authorization chain in a single round trip, and returns the display
--          context the admin shell needs alongside the decision.
--
--          The application previously answered the same question with four
--          sequential remote calls (profile + memberships, then organizations,
--          then one has_organization_role() RPC per candidate organization).
--          Every one of those paid network latency; the joins themselves are
--          trivial for the database. This collapses them into one call without
--          relaxing a single condition.
--
-- Security posture:
--   * language sql, stable, security definer, set search_path = '' — identical
--     to the migration-4 helpers.
--   * Every schema/table/function reference is fully qualified, so nothing can
--     be resolved from an attacker-controlled schema under the empty
--     search_path.
--   * Takes NO arguments. The caller is identified solely via auth.uid(), so
--     application input cannot nominate whose authorization is evaluated or
--     whose profile is returned. There is no user id, organization id, role
--     code, email, or token parameter to abuse.
--   * SECURITY DEFINER is what lets this read the identity/RBAC tables (RLS
--     default-deny to the browser), exactly as the existing helpers do — and
--     like them, the query is hard-filtered to auth.uid(), so it can only ever
--     report on the caller's own authorization. It cannot be used to probe
--     another user, and it returns nothing at all for a caller who does not
--     qualify.
--   * auth.users is never queried. public.profiles.id IS the auth user id
--     (1:1, FK to auth.users), so auth.uid() addresses the profile row directly.
--   * A null auth.uid() (an unauthenticated caller) yields no rows naturally:
--     `p.id = auth.uid()` is null-comparing and matches nothing. The explicit
--     `auth.uid() is not null` guard mirrors the migration-4 helpers rather than
--     relying on that alone.
--   * No dynamic SQL, no writes.
--
-- Returned columns are deliberately minimal — the caller's own name parts, and
-- the id and name of the organization that authorized them. No permission
-- details, no role codes or names, no membership id, no member_roles or
-- role_permissions rows, no email, no mobile number, no status columns. The
-- statuses are CONDITIONS here, not output.
--
-- Scope notes:
--   * Adds one function. No tables, columns, triggers, indexes, or seed data.
--   * Modifies NOTHING that exists: is_active_organization_member(),
--     has_organization_role(), and has_organization_permission() are untouched
--     and still in use by the RLS policies from migration 5, which are likewise
--     unchanged. This function is an addition, not a replacement — the helpers
--     remain the predicates the policies call, and this one is what the
--     application's own authorization check calls.
--   * Depends on migrations 1 (identity), 2 (rbac), and 6 (seeded
--     VENDOR_SUPER_ADMIN role).

-- ============================================================================
-- 1. get_vendor_super_admin_context() -> setof authorized context rows
-- ============================================================================
-- Returns one row per ACTIVE VENDOR organization in which the caller holds the
-- ACTIVE VENDOR_SUPER_ADMIN role through an ACTIVE membership, with an ACTIVE
-- profile. Zero rows means "not a Vendor Super Admin" — which is the same answer
-- for a caller who is unauthenticated, suspended, deactivated, a member of a
-- retailer or suspended organization, or simply holds a different role. The
-- function never distinguishes those cases to the caller, and the application
-- treats them all as unauthorized.
--
-- The join chain and every condition below match has_organization_role(
-- <org>, 'VENDOR_SUPER_ADMIN') exactly — same tables, same ACTIVE requirements
-- on profile, membership, organization, and role, same role code — with one
-- condition added that the application used to apply itself in a separate query:
-- organizations.organization_type = 'VENDOR'. Nothing has been loosened; the
-- filtering simply happens in one place now.
create function public.get_vendor_super_admin_context()
returns table (
  user_id           uuid,
  first_name        text,
  last_name         text,
  organization_id   uuid,
  organization_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id   as user_id,
    p.first_name,
    p.last_name,
    o.id   as organization_id,
    o.name as organization_name
  from public.profiles p
  join public.organization_members m on m.user_id = p.id
  join public.organizations o on o.id = m.organization_id
  join public.member_roles mr on mr.organization_member_id = m.id
  join public.roles r on r.id = mr.role_id
  where auth.uid() is not null
    and p.id = auth.uid()
    and p.status = 'ACTIVE'
    and m.status = 'ACTIVE'
    and o.status = 'ACTIVE'
    and o.organization_type = 'VENDOR'
    and r.status = 'ACTIVE'
    and r.code = 'VENDOR_SUPER_ADMIN'
  -- Deterministic order, so "the first row" is a stable choice rather than
  -- whatever the planner happened to emit. A caller holding the role in two
  -- vendor organizations therefore lands in the same one on every request
  -- instead of flipping between them.
  --
  -- One row per organization is already guaranteed: roles.code is unique, so
  -- exactly one role matches; member_roles is keyed by (organization_member_id,
  -- role_id), so a membership holds it at most once; and organization_members is
  -- unique on (organization_id, user_id), so the caller has at most one
  -- membership per organization. Ordering by organization id is enough to make
  -- the result total.
  order by o.id;
$$;

-- Privileges: no implicit PUBLIC EXECUTE (Postgres grants it by default on
-- functions, which on a SECURITY DEFINER function reading identity tables would
-- be exactly wrong), nothing for anon, EXECUTE for authenticated only. Matches
-- the migration-4 helpers.
revoke all on function public.get_vendor_super_admin_context() from public;
revoke execute on function public.get_vendor_super_admin_context() from anon;
grant execute on function public.get_vendor_super_admin_context() to authenticated;
