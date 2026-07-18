-- Migration: retailer_authorization_helpers
-- Purpose: One read-only authorization helper for Retailers. It answers the
--          single question the Vendor Admin needs and the identity model cannot
--          already express: does the caller hold a permission over a RETAILER
--          organization, by virtue of a VENDOR organization that manages it?
--
--          The existing migration-4 helpers answer "does the caller hold X IN
--          this organization?" — they resolve authorization through the caller's
--          own membership. That is exactly right for the Vendor's own data, and
--          exactly wrong for Retailers: a Vendor Super Admin is a member of the
--          VENDOR organization and is deliberately NOT a member of any Retailer
--          they manage. Making them a member would grant membership semantics —
--          they would appear in the retailer's own member directory and count as
--          one of its people — and would conflate "manages" with "belongs to".
--
--          This helper bridges that gap by hopping exactly one edge:
--          retailer -> public.vendor_retailers -> vendor, and then delegating
--          the real decision, unchanged, to the migration-4 permission helper.
--
-- Security posture (mirrors the migration-4 helpers):
--   * language sql, stable, security definer, set search_path = ''.
--   * Every schema/table/function reference is fully qualified (safe under an
--     empty search_path — nothing can be resolved from an attacker-controlled
--     schema).
--   * Never takes a user id. The caller is identified solely via auth.uid(),
--     resolved inside public.has_organization_permission(), so application input
--     cannot influence WHOSE authorization is evaluated. The only arguments are
--     WHICH retailer and WHICH permission.
--   * Returns a plain boolean via EXISTS, which is never null. Unauthenticated
--     callers, null retailer ids, null permission codes, and unknown retailers
--     all yield false rather than raising.
--   * No dynamic SQL, no writes, no returned rows. No organization name, id,
--     membership row, or any other tenant data leaves the function — only true
--     or false.
--
-- Scope notes: no RLS policies, no tables, no columns, no seed data, no roles,
--   no permissions. Nothing existing is altered: has_organization_permission,
--   has_organization_role, is_active_organization_member, and
--   get_vendor_super_admin_context are all untouched and still in use. This
--   migration only adds one function.
--
-- Dependencies: migration 4 (has_organization_permission) and migration 7
--   (vendor_retailers).

-- ============================================================================
-- 1. has_vendor_retailer_permission(
--      target_retailer_organization_id uuid, target_permission_code text
--    ) -> boolean
-- ============================================================================
-- True when the caller holds target_permission_code in AT LEAST ONE Vendor
-- organization linked to the target Retailer through public.vendor_retailers.
--
-- Authorization is delegated, not reimplemented. Every substantive condition —
-- ACTIVE profile, ACTIVE membership, ACTIVE vendor organization, ACTIVE role,
-- and the role->permission mapping — is evaluated by
-- public.has_organization_permission() against the VENDOR organization. This
-- function adds exactly one fact of its own: which vendors are linked to this
-- retailer. Reassembling any of that chain here would let the Retailer policies
-- and the existing policies drift apart, and only one of the two would be right.
--
-- auth.uid() keeps working through the SECURITY DEFINER boundary: it reads the
-- request's JWT claims from a GUC, not from current_user, so the delegated
-- helper still evaluates the ORIGINAL caller's authorization even though the
-- current user is now the function owner. This is the same reason the
-- migration-4 helpers work when called from an RLS policy.
--
-- Multi-vendor: EXISTS stops at the first vendor that grants the permission, so
-- a Retailer linked to several Vendors is authorized when ANY of them grants it.
-- Today exactly one Vendor exists, which is a strict subset of that behaviour —
-- nothing here assumes a single link, and nothing changes if that stops being
-- true.
--
-- SECURITY DEFINER is load-bearing rather than habitual: public.vendor_retailers
-- is RLS-enabled with ZERO policies (migration 7), so under the invoker's rights
-- it returns no rows to any browser role and this function would answer false
-- for everyone, always. Definer rights are what let it read the relationship
-- table it exists to consult. It reads nothing else — the delegated permission
-- decision is still made by a separate helper against the caller's real
-- identity, so the definer rights widen visibility of the link and grant nothing.
--
-- STATUS IS DELIBERATELY NOT FILTERED — neither vendor_retailers.status nor the
-- Retailer organization's status. This is a READ helper, and a Vendor Admin must
-- be able to see the retailers it manages in every state:
--   * ACTIVE relationships are the ordinary case.
--   * SUSPENDED relationships must stay visible — an admin cannot review, or
--     ever un-suspend, a retailer that has vanished from their console. Hiding a
--     suspended row would make suspension indistinguishable from deletion.
--   * DEACTIVATED relationships must stay visible for history, exactly as
--     DEACTIVATED organizations and memberships remain readable today. This
--     schema retires rows by status and never deletes them, and data retained
--     for history that no one may read is not history.
--   * The Retailer organization's own status is likewise not consulted: a
--     SUSPENDED retailer is still a retailer this vendor manages.
-- The caller's OWN chain is still strictly active-only, because
-- has_organization_permission() enforces it: a suspended Vendor Super Admin, an
-- inactive membership, or a suspended VENDOR organization authorizes nothing
-- here. What is relaxed is the state of the thing being READ, never the state of
-- the person reading.
--
-- Operational WRITES will need a stricter, active-only rule (a vendor should not
-- edit a retailer it has suspended). That is a separate decision and belongs
-- with the write path, not smuggled into a read helper — conflating them would
-- silently make suspended retailers invisible in the process.
create function public.has_vendor_retailer_permission(
  target_retailer_organization_id uuid,
  target_permission_code text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.vendor_retailers vr
    where target_retailer_organization_id is not null
      and target_permission_code is not null
      and auth.uid() is not null
      and vr.retailer_organization_id = target_retailer_organization_id
      and public.has_organization_permission(
        vr.vendor_organization_id,
        target_permission_code
      )
  );
$$;

-- Privileges. Granted to authenticated because the Retailer RLS policies will
-- call this function as that role, exactly as the migration-4 helpers are called
-- today. That is the whole reason it exists, and the reason it is safe to grant:
-- it takes no user id, so a caller can only ever ask about their own
-- authorization, and it returns nothing but a boolean.
--
-- The revokes come first and in this order. PostgreSQL grants EXECUTE to PUBLIC
-- by default on every new function, and PUBLIC is inherited by every role — so
-- without the first statement, anon would hold EXECUTE regardless of anything
-- below. Revoking from authenticated before granting to it is deliberate: it
-- means the grant that follows is this migration's own explicit decision rather
-- than a privilege quietly inherited from PUBLIC. anon is left with nothing.
revoke all on function
  public.has_vendor_retailer_permission(uuid, text)
from public;

revoke execute on function
  public.has_vendor_retailer_permission(uuid, text)
from anon;

revoke execute on function
  public.has_vendor_retailer_permission(uuid, text)
from authenticated;

grant execute on function
  public.has_vendor_retailer_permission(uuid, text)
to authenticated;
