-- Migration: retailer_rls_read_policies
-- Purpose: Row Level Security READ policies for the Vendor side of Retailers.
--          Turns the default-deny posture of migration 7 into a precise,
--          least-privilege read model for browser (publishable-key) clients,
--          exactly as migration 5 did for the identity, RBAC, and audit tables.
--
-- Scope notes:
--   * SELECT policies only. No INSERT/UPDATE/DELETE/ALL policies are created,
--     so every write path stays default-deny for anon/authenticated. Writes
--     continue to happen only through trusted server-side code.
--   * Every policy is TO authenticated. anon is never granted a policy and is
--     never granted a table privilege below.
--   * VENDOR SIDE ONLY. Nothing here grants a Retailer Owner or Retailer staff
--     any access to their own retailer, relationship, or shops. That is a
--     separate policy set, and it arrives with the invitation milestone that
--     first creates such people. Until then no human is a member of a Retailer
--     organization, so there is nobody for those policies to admit.
--   * Depends on migration 7 (vendor_retailers, retailer_shops) and migration 8
--     (has_vendor_retailer_permission). No new functions, tables, columns, or
--     triggers are created, and no earlier migration is modified.
--   * No seed data. RETAILERS_READ is created and mapped in a later migration —
--     see "Temporary fail-closed state" below.
--
-- Authorization model:
--   All authorization is delegated to the SECURITY DEFINER helpers, which are
--   stable + search_path = '' and identify the caller solely via auth.uid().
--   They never accept a user id, so application input cannot influence whose
--   authorization is evaluated. Nothing in these policies reads an organization
--   id supplied by browser code: every id compared below comes from the row
--   being tested, and every identity comes from the verified token.
--
--   Authorization flows through the RETAILERS_READ PERMISSION only. There is
--   deliberately no `or has_organization_role(..., 'VENDOR_SUPER_ADMIN')` branch
--   here, unlike the migration-5 policies. The Super Admin will reach these rows
--   because the seed migration maps RETAILERS_READ to VENDOR_SUPER_ADMIN, not
--   because the policy names that role. One route in means one place to audit,
--   and a future RETAILER_MANAGER role needs a permission grant rather than a
--   policy rewrite.
--
--   The active-lifecycle chain is still enforced in full, but on the READER, not
--   the row: has_organization_permission() requires an ACTIVE profile, an ACTIVE
--   membership, an ACTIVE vendor organization, and an ACTIVE role holding the
--   permission. A suspended Vendor Super Admin reads nothing here.
--
-- Recursion:
--   Both helpers are SECURITY DEFINER and therefore read their tables with the
--   function owner's rights, bypassing RLS entirely. A policy that calls a
--   helper can never re-enter the policy set:
--     * has_vendor_retailer_permission() reads public.vendor_retailers with
--       definer rights, so the organizations and retailer_shops policies below
--       do NOT trigger the vendor_retailers policy.
--     * has_organization_permission() reads the identity/RBAC tables with definer
--       rights, so none of these policies re-enters the migration-5 policy set —
--       including the organizations policy calling into a helper that itself
--       reads public.organizations.
--   No policy below references any RLS-protected table directly.
--
-- Temporary fail-closed state (EXPECTED):
--   These three policies authorize NOBODY until a later migration creates the
--   RETAILERS_READ permission and maps it to VENDOR_SUPER_ADMIN.
--   has_organization_permission() joins public.permissions on
--   perm.code = 'RETAILERS_READ'; with no such row the join finds nothing, EXISTS
--   returns false, and every policy below denies every row to everyone. This is
--   the same deliberate sequencing migration 5 used: it was written before its
--   codes were seeded, and every permission-based branch returned false until
--   migration 6 landed. Failing closed while incomplete is the correct direction
--   to be wrong in — a Retailers page built now would render its empty state, not
--   leak.

-- ============================================================================
-- 1. organizations — Retailer rows visible to an authorized Vendor
-- ============================================================================
-- A SECOND permissive policy on public.organizations. The migration-5 policy
-- organizations_select_active_members is NOT replaced, renamed, or modified:
-- PostgreSQL ORs multiple permissive policies for the same command and role, so
-- a row is visible if EITHER policy admits it. The existing rule (an
-- organization is visible to its own ACTIVE members) keeps working untouched,
-- and this one adds the case it cannot express.
--
-- That case is the whole reason this migration exists. A Vendor Super Admin is a
-- member of the VENDOR organization and deliberately NOT a member of any
-- Retailer they manage, so is_active_organization_member() is false for every
-- retailer row and the existing policy hides all of them. Without this policy a
-- Retailers directory would return zero rows and silently render "no retailers"
-- — the failure would look like absence rather than denial.
--
-- The organization_type test is belt and braces, not the security boundary. A
-- VENDOR organization can never appear as vendor_retailers.retailer_organization_id
-- in the first place: migration 7's BEFORE-row trigger validates that column to
-- be a RETAILER on insert and on update. So the helper would already return
-- false for a vendor id. The explicit test states the policy's intent in the
-- policy itself and keeps this rule correct even if that trigger were ever
-- dropped. It is listed first so the cheap column comparison can short-circuit
-- ahead of the helper call.
--
-- Status is deliberately NOT filtered. ACTIVE, SUSPENDED, and DEACTIVATED
-- retailer organizations all stay readable to an authorized Vendor user: an
-- admin cannot review — or ever un-suspend — a retailer that has vanished from
-- their console, and hiding a suspended row would make suspension
-- indistinguishable from deletion. Deactivated rows stay readable for history,
-- exactly as deactivated organizations and memberships do under migration 5.
-- What is relaxed is the state of the row being READ; the reader's own chain
-- stays strictly active-only inside the helper.
create policy organizations_select_vendor_managed_retailers
  on public.organizations
  for select
  to authenticated
  using (
    public.organizations.organization_type = 'RETAILER'
    and public.has_vendor_retailer_permission(
      public.organizations.id, 'RETAILERS_READ'
    )
  );

-- ============================================================================
-- 2. vendor_retailers — the relationship rows of the caller's own Vendor
-- ============================================================================
-- Authorization is evaluated against THIS ROW'S OWN vendor_organization_id, via
-- has_organization_permission() — the plain organization-scoped helper — and NOT
-- via has_vendor_retailer_permission().
--
-- That choice is a security boundary, not a performance nicety. The retailer-hop
-- helper asks "does the caller hold this permission in ANY vendor linked to this
-- retailer?". Applied here it would leak across vendors the moment a second
-- vendor exists: if Vendor A and Vendor B both link Retailer R, then an admin of
-- Vendor B would satisfy the hop for Retailer R and could therefore read VENDOR
-- A's relationship row — a row describing a commercial relationship they have no
-- part in. The correct question for a relationship row is about the vendor named
-- ON that row, which is already present as a column and needs no hop to find.
--
-- It also keeps the policy trivially non-recursive: has_organization_permission()
-- never reads public.vendor_retailers, so this policy cannot re-enter itself.
--
-- Status is not filtered, for the reasons given on the organizations policy
-- above: a suspended relationship must remain visible to be reviewable, and a
-- deactivated one must remain visible as history.
create policy vendor_retailers_select_vendor_authorized
  on public.vendor_retailers
  for select
  to authenticated
  using (
    public.has_organization_permission(
      public.vendor_retailers.vendor_organization_id, 'RETAILERS_READ'
    )
  );

-- ============================================================================
-- 3. retailer_shops — shops of Retailers the caller's Vendor manages
-- ============================================================================
-- retailer_shops carries no vendor_organization_id of its own — deliberately, per
-- migration 7: a shop's vendor is DERIVED through the relationship rather than
-- denormalized onto the row, so it can never go stale. This policy is where that
-- derivation is spent: has_vendor_retailer_permission() performs the hop
-- retailer -> vendor_retailers -> vendor and delegates the decision to the
-- permission helper.
--
-- The hop is the right question here, unlike on vendor_retailers above: a shop
-- belongs to the RETAILER, not to any one vendor, so any vendor authorized over
-- that retailer is legitimately authorized over its shops. There is no
-- per-vendor shop row to leak.
--
-- The helper reads vendor_retailers with definer rights, so this policy neither
-- depends on nor triggers the vendor_retailers policy above. The two are
-- independent: revoking a vendor's relationship visibility would not accidentally
-- expose shops, and vice versa.
--
-- Status is not filtered — a closed or suspended shop stays visible to an
-- authorized Vendor user, for the same reasons as above.
create policy retailer_shops_select_vendor_authorized
  on public.retailer_shops
  for select
  to authenticated
  using (
    public.has_vendor_retailer_permission(
      public.retailer_shops.retailer_organization_id, 'RETAILERS_READ'
    )
  );

-- ============================================================================
-- 4. Privileges
-- ============================================================================
-- RLS policies decide WHICH ROWS a role may read; GRANTs decide whether the role
-- may attempt the statement at all. Migration 7 revoked every privilege on these
-- two tables from PUBLIC, anon, and authenticated precisely so that the grant
-- would land here, alongside the policies it belongs with — privilege and policy
-- arrive together, and neither outlives the other.
--
-- SELECT and nothing else. INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, and
-- TRIGGER are all withheld and stay withheld: no write policy exists, and even if
-- a future migration mistakenly added one, the missing privilege would keep
-- browser writes failing. TRUNCATE matters independently of policies because it
-- bypasses RLS entirely.
--
-- anon receives nothing. No policy above is TO anon either, so this is belt and
-- braces.
--
-- public.organizations is deliberately absent from this grant. It already holds
-- exactly the SELECT privilege it needs from migration 5, and the new policy in
-- section 1 widens which ROWS that privilege reaches without needing any
-- privilege change. Re-granting would be a no-op at best and a modification of
-- migration 5's posture at worst.
--
-- postgres and service_role are untouched: they hold their privileges directly
-- (and service_role additionally BYPASSRLS), so trusted server-side access is
-- unaffected.
grant select on table
  public.vendor_retailers,
  public.retailer_shops
to authenticated;
