-- Migration: claim_reviewer_access
-- Purpose: The authorization root for the Claim Reviewer portal. It adds, and only adds:
--            1. The CLAIM_REVIEW_PORTAL_READ permission, mapped to CLAIM_REVIEWER alone.
--            2. public.resolve_claim_reviewer_organization(text) -- INTERNAL.
--            3. public.get_claim_reviewer_context()              -- the browser's one door.
--
-- WHY THIS EXISTS
--   public.roles has carried CLAIM_REVIEWER since the 20260716133023 seed, deliberately
--   holding ZERO permissions: "They are placeholders naming the intended separation of
--   duties; each gains its module-specific permissions only when that module is built."
--   This is that moment for the portal, and for nothing else.
--
--   Today a Claim Reviewer cannot reach any page at all. The Vendor Admin gate resolves
--   through get_vendor_super_admin_context(), whose SQL contains the literal
--   `r.code = 'VENDOR_SUPER_ADMIN'`, so a reviewer is redirected to /access-denied. This
--   migration gives them their own resolver rather than widening that one.
--
-- ============================================================================
-- WHY A PORTAL-ONLY PERMISSION, AND NOT RECEIPT_REVIEW_READ
-- ============================================================================
-- CLAIM_REVIEW_PORTAL_READ authorizes ONE thing: opening an empty reviewer portal. It
-- grants no receipt queue, no receipt detail, no receipt image, no verification and no
-- financial data, because none of those exist yet.
--
-- The alternative -- creating RECEIPT_REVIEW_READ now and having Phase 1C's queue RPC
-- resolve on it -- would mean that the MOMENT that RPC deploys, every existing reviewer
-- silently gains receipt-data access with nobody having decided to grant it. Splitting
-- the two makes that a separate, visible, reviewable act, and lets "may open the portal"
-- be revoked without touching "may read receipt data".
--
-- This is the same split the project already makes between PRODUCTS_READ and
-- PRODUCTS_MANAGE, and between RECEIPT_SUBMIT and RECEIPT_PRODUCTS_READ.
--
-- ============================================================================
-- WHY A NEW RESOLVER RATHER THAN WIDENING THE VENDOR ONE
-- ============================================================================
-- get_vendor_super_admin_context() gates the ENTIRE shipped Vendor Admin. Admitting a
-- second role there would silently change who can reach every existing Vendor page, and
-- it returns a TABLE, so reshaping it would additionally require DROP + CREATE on a
-- function the web and the mobile client both depend on. It is left byte-untouched.
--
-- public.get_my_portal_context() IS ALSO LEFT BYTE-UNTOUCHED, and that is a hard
-- requirement rather than a preference. The Flutter client consumes it, and its parser
--   * rejects an unrecognised portal_kind (PortalKind.tryParse returns null, and the
--     parser then throws PortalContextFormatException), and
--   * requires context_version to equal its supported version EXACTLY.
-- So adding a CLAIM_REVIEWER portal_kind, or incrementing the version, would break every
-- existing mobile build. The Web does not read that function at all -- it routes through
-- lib/auth/vendor-admin-access.ts and lib/staff/retailer-staff-access.ts -- so the Web
-- reviewer gate is built from the two new functions below and nothing else. A
-- reviewer-only user opening Flutter today receives portal_kind 'NONE' -> "No access",
-- which is already the correct answer: there is no mobile reviewer experience.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--   No RECEIPT_REVIEW_READ and no RECEIPT_VERIFY -- both belong to Phase 1C and their
--   absence is asserted by this milestone's tests.
--   No receipt review queue, receipt detail, image access, verification table, verified
--   sale item, product matching, correction, reward, coin, balance or payout object.
--   No reviewer user, membership or member_roles row: this migration contains no email
--   and no profile identifier, and creates no bootstrap RPC. The first reviewer is added
--   after deployment by a reviewed, one-off SQL transaction.
--   No table, column, constraint, index, trigger or RLS policy, and no table privilege
--   granted to any role.
--   No change to get_vendor_super_admin_context(), get_my_portal_context(), or any
--   existing permission, role or mapping.
--
-- Idempotency posture: the permission upserts on `code` and the mapping is
--   ON CONFLICT DO NOTHING, matching migrations 6, 11, 12, 20260718214858 and
--   20260818090000. The functions are plain CREATE -- a conflicting existing object FAILS
--   the migration. No fixed UUIDs. No dynamic SQL. All identifiers are <= 63 bytes. Every
--   reference is schema-qualified because both functions run with an EMPTY search_path.
--
-- Dependencies: 20260716124419 (profiles, organizations, organization_members),
--   20260716125559 (roles, permissions, role_permissions, member_roles), 20260716133023
--   (the seeded CLAIM_REVIEWER role).

-- ============================================================================
-- PART 1 -- the CLAIM_REVIEW_PORTAL_READ permission
-- ============================================================================
-- Module CLAIM_REVIEW: a new module rather than RECEIPTS, because this permission is
-- about a PORTAL rather than about receipt data, and keeping it separate is what lets the
-- roles screen show reviewer access as its own concern. It mirrors RETAILER_PORTAL_READ
-- in the RETAILER_PORTAL module, which is the closest existing precedent -- also a
-- portal-access permission that grants a shell and no data.
insert into public.permissions (code, name, description, module)
values
  (
    'CLAIM_REVIEW_PORTAL_READ',
    'Open the Claim Review portal',
    'Sign in to the Claim Review portal. Grants no access to receipts, receipt images, verification, products or financial data.',
    'CLAIM_REVIEW'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- Precondition: the target role must exist. Without this, a missing role would make the
-- mapping INSERT write zero rows, the migration would report success with the permission
-- assigned to nobody, and a correctly configured reviewer would be refused with nothing
-- to explain why. Fail loudly instead. Reads one row, writes nothing.
do $$
begin
  if not exists (
    select 1
    from public.roles r
    where r.code = 'CLAIM_REVIEWER'
  ) then
    raise exception 'Seed precondition failed: role CLAIM_REVIEWER does not exist, so CLAIM_REVIEW_PORTAL_READ cannot be assigned';
  end if;
end;
$$;

-- Role -> permission mapping. CLAIM_REVIEWER and ONLY it: the WHERE clause names exactly
-- one role code, so VENDOR_SUPER_ADMIN, FINANCE_ADMIN, RETAILER_OWNER, RETAILER_MANAGER
-- and SALES_STAFF each receive nothing here and cannot acquire reviewer access without
-- their own deliberate, reviewable migration.
--
-- VENDOR_SUPER_ADMIN IS EXCLUDED ON PURPOSE, and it is the exclusion most likely to be
-- questioned later. A Vendor Super Admin authors campaigns; a reviewer decides which
-- sales those campaigns pay for. One person holding both can direct rewards to a chosen
-- Retailer, which is the separation of duties this whole milestone exists to establish.
--
-- Ids resolved by joining on code rather than written literally. Both codes are unique,
-- so the cross join yields precisely 1 x 1 = 1 row. ON CONFLICT DO NOTHING targets the
-- composite primary key, so a re-run is a no-op and no mapping is ever deleted.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'CLAIM_REVIEWER'
  and p.code = 'CLAIM_REVIEW_PORTAL_READ'
on conflict (role_id, permission_id) do nothing;

-- ============================================================================
-- PART 2 -- resolve_claim_reviewer_organization(text)  [INTERNAL]
-- ============================================================================
-- The Vendor organization the calling reviewer acts for, or NULL. NULL is the single
-- answer for "signed out", "no profile", "suspended profile", "suspended membership",
-- "inactive organization", "a Retailer organization", "inactive role", "this role does
-- not hold that permission", AND "more than one qualifying Vendor" alike.
--
-- Structurally a copy of resolve_retailer_member_organization (migration 20260723090000),
-- differing in exactly one predicate -- organization_type = 'VENDOR' instead of
-- 'RETAILER'. Reusing that shape rather than inventing one keeps the two tenant resolvers
-- readable side by side and makes any future divergence obvious.
--
-- NO ROLE CODE APPEARS IN THIS BODY. Authorization travels permission -> role_permissions
-- -> role, so the mapping seeded in PART 1 is the sole authority: revoking that one row
-- disables the entire reviewer portal with no code change, and a future role gains it by
-- acquiring a row rather than by an edit here. A source-level test asserts the absence.
--
-- NO PERMISSION-STATUS PREDICATE, and that is not an omission. public.permissions has
-- columns (id, code, name, description, module, created_at, updated_at) and carries NO
-- status column -- unlike public.roles, whose r.status = 'ACTIVE' IS checked below.
-- Inventing a status test for a column that does not exist would not compile; deactivating
-- a permission is done by removing its mapping.
--
-- ---- ZERO AND MULTIPLE BOTH FAIL CLOSED -------------------------------------
-- `where (select count(*) from qualifying) = 1` is the whole rule. Zero qualifying
-- organizations yields no row; TWO OR MORE also yields no row, rather than picking one.
--
-- This deliberately follows the Retailer resolver and NOT get_vendor_super_admin_context(),
-- which orders by organization id and takes the first -- an asymmetry that function's own
-- comments call out as a pre-existing behaviour of the shipped web application. A reviewer
-- decides what is worth money, and silently choosing one of their two Vendors for them is
-- not a decision this function may make. A reviewer in two Vendors is refused until an
-- explicit Vendor-context chooser is designed, which is a product decision rather than a
-- default.
create function public.resolve_claim_reviewer_organization(
  target_permission_code text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with qualifying as (
    select distinct o.id
    from public.profiles p
    join public.organization_members m on m.user_id = p.id
    join public.organizations o on o.id = m.organization_id
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions perm on perm.id = rp.permission_id
    where target_permission_code is not null
      and auth.uid() is not null
      and p.id = auth.uid()
      and p.status = 'ACTIVE'
      and m.status = 'ACTIVE'
      and o.status = 'ACTIVE'
      and o.organization_type = 'VENDOR'
      and r.status = 'ACTIVE'
      and perm.code = target_permission_code
  )
  select q.id
  from qualifying q
  where (select count(*) from qualifying) = 1;
$$;

-- Internal only: reachable solely from SECURITY DEFINER functions that run as this
-- function's owner. It takes a permission code and resolves no tenant of its own, so
-- exposing it would let a browser probe permission codes directly.
revoke all     on function public.resolve_claim_reviewer_organization(text) from public;
revoke execute on function public.resolve_claim_reviewer_organization(text) from anon;
revoke execute on function public.resolve_claim_reviewer_organization(text) from authenticated;

-- ============================================================================
-- PART 3 -- get_claim_reviewer_context()  [the browser's one door]
-- ============================================================================
-- The reviewer's own identity and the Vendor they act for, or ZERO ROWS.
--
-- Shape and privilege posture mirror get_vendor_super_admin_context() exactly, because
-- lib/review/claim-reviewer-access.ts is the mirror of lib/auth/vendor-admin-access.ts and
-- the two should read the same. It takes NO ARGUMENTS: there is no organization id, no
-- profile id, no permission code and no role code for a caller to supply, so nothing about
-- the tenant or the identity can be nominated from a browser.
--
-- ONE DENIAL FOR EVERY CAUSE. Signed out, no profile, suspended profile, suspended
-- membership, inactive organization, a Retailer organization, inactive role, missing
-- permission mapping, zero Vendors and MORE THAN ONE Vendor all produce the identical
-- answer: zero rows. It raises nothing, so a caller cannot tell the causes apart from the
-- error either -- the same reason every RPC in this schema collapses its refusals.
--
-- AT MOST ONE ROW, structurally. organizations.id and profiles.id are both primary keys,
-- so each join contributes at most one row and their product is at most one. The resolver
-- has already reduced "which Vendor" to a single value or NULL, and `o.id = NULL` matches
-- nothing.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN: no membership id, no role id, no permission id, no
-- email, no phone, no Retailer organization id, and no receipt information. The Vendor
-- organization NAME is returned because it is approved for display to the authorized
-- reviewer and is the same value the Vendor Admin shell already shows an authorized
-- member.
create function public.get_claim_reviewer_context()
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
  from public.organizations o
  join public.profiles p
    on p.id = auth.uid()
   and p.status = 'ACTIVE'
  where o.id = public.resolve_claim_reviewer_organization('CLAIM_REVIEW_PORTAL_READ');
$$;

-- Privileges: no implicit PUBLIC EXECUTE (PostgreSQL grants it by default, which on a
-- SECURITY DEFINER function reading identity tables would be exactly wrong), nothing for
-- anon, EXECUTE for authenticated only.
--
-- service_role is NOT granted. Every legitimate reviewer path derives its authority from
-- auth.uid(), and a service-role path would be a way to obtain a reviewer context with no
-- session at all.
revoke all     on function public.get_claim_reviewer_context() from public;
revoke execute on function public.get_claim_reviewer_context() from anon;
grant  execute on function public.get_claim_reviewer_context() to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One permission, one role mapping, two functions.
--
-- No table, column, constraint, index, trigger or policy is created, altered or dropped.
-- No table privilege is granted, changed or revoked. get_vendor_super_admin_context() and
-- get_my_portal_context() are byte-untouched, so every existing Vendor, Retailer and
-- mobile caller behaves exactly as it did.
--
-- No reviewer exists after this migration: CLAIM_REVIEWER still has zero members, and this
-- file contains no email, no profile identifier and no bootstrap path. Nothing here reads a
-- receipt, verifies a sale, matches a product, evaluates a campaign or credits a coin.
