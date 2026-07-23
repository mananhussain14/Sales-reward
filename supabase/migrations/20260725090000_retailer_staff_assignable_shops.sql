-- Migration: retailer_staff_assignable_shops
-- Purpose: Adds exactly ONE function and nothing else:
--            public.list_retailer_staff_assignable_shops()
--          the Retailer Owner's list of shops that may be attached to a SALES_STAFF
--          invitation, WITH their ids.
--
-- WHY THIS EXISTS — the gap it closes
--   public.reserve_retailer_staff_invitation(text, text, text, text, uuid[]) requires
--   at least one shop UUID for a SALES_STAFF invitation. Before this migration no
--   application code could obtain one:
--     * public.list_retailer_owner_portal_shops() — the portal's authorized
--       active-shop source — deliberately returns NO id (shop_name, shop_code, city,
--       country_code, shop_status only), because the read-only portal had nothing to
--       address a shop with.
--     * public.retailer_shops carries a single RLS policy,
--       retailer_shops_select_vendor_authorized, whose USING clause is
--       has_vendor_retailer_permission(retailer_organization_id, 'RETAILERS_READ') —
--       a VENDOR-scoped test. A Retailer Owner selecting that table gets zero rows.
--     * The only other authenticated-callable functions that emit shop ids are
--       list_retailer_staff_invitations() and list_retailer_staff_members(), and both
--       are circular for this purpose: they return shops that are ALREADY attached to
--       an invitation or an existing staff member, never the assignable set.
--   So Sales Staff invitations were unreachable from the application. This function is
--   the minimum that unblocks them.
--
-- WHY THE PERMISSION IS RETAILER_STAFF_SHOP_ASSIGN, NOT RETAILER_SHOPS_READ
--   Shop ids are internal identifiers, and the ONLY legitimate reason to hand one to a
--   browser today is so it can be passed straight back to
--   reserve_retailer_staff_invitation. RETAILER_STAFF_SHOP_ASSIGN names exactly that
--   capability and is currently mapped to RETAILER_OWNER alone — so a RETAILER_MANAGER
--   (who holds RETAILER_SHOPS_READ and RETAILER_STAFF_READ) and a SALES_STAFF member
--   receive nothing here. Gating on RETAILER_SHOPS_READ instead would have handed shop
--   ids to Managers, who have no operation in this milestone that consumes one.
--
--   The mapping is the authority, not this function: if a future migration grants
--   RETAILER_STAFF_SHOP_ASSIGN to another role, that role gains this list without this
--   file being edited. No role code appears below.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No table, column, constraint, index, trigger, policy, role, permission or
--   role-permission mapping is created, altered or dropped. No existing function is
--   touched. No table privilege is granted to any browser role — direct browser reads
--   of public.retailer_shops stay denied to Retailer members exactly as they were, and
--   this function is the only way through. No Retailer NAME is exposed and no
--   Retailer-context capability is added: a Manager-facing page rendering without a
--   Retailer name is a deliberate, accepted product state for this milestone, not
--   something this migration works around.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE).
--   A conflicting existing object FAILS the migration. No fixed UUIDs. No dynamic SQL.
--   All identifiers are <= 63 bytes. Every reference is schema-qualified because the
--   function runs with an EMPTY search_path.
--
-- Dependencies: 20260717094520 (retailer_shops), 20260722210000
--   (RETAILER_STAFF_SHOP_ASSIGN permission and its RETAILER_OWNER mapping),
--   20260723090000 (resolve_retailer_member_organization).

-- ============================================================================
-- FUNCTION — list_retailer_staff_assignable_shops()
-- ============================================================================
-- The ACTIVE shops of the caller's own Retailer, with ids, for the staff-invitation
-- shop picker.
--
-- NO TENANT INPUT. Zero arguments, deliberately. There is no Retailer id,
-- organization id, relationship id, or membership id to pass, so no URL segment, form
-- field, hidden input, header or cookie can nominate whose shops are returned. The
-- Retailer is derived inside the function from auth.uid() through the established
-- resolver, which fails closed when the caller resolves to zero or to more than one
-- qualifying Retailer.
--
-- UNAUTHORIZED IS AN EXCEPTION, NOT AN EMPTY LIST. An unresolved caller raises the
-- same generic insufficient_privilege error every other staff operation raises, so a
-- denial is never mistaken for "this Retailer has no shops" — a distinction the invite
-- form depends on to avoid telling an Owner their Retailer is empty when in fact they
-- were refused.
--
-- ONLY ASSIGNABLE SHOPS. status = 'ACTIVE' only, matching what
-- reserve_retailer_staff_invitation will itself accept: offering a suspended or
-- deactivated shop would produce a picker whose selections the reservation refuses.
create function public.list_retailer_staff_assignable_shops()
returns table (
  shop_id   uuid,
  shop_name text,
  shop_code text,
  city      text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('RETAILER_STAFF_SHOP_ASSIGN');

  if v_retailer is null then
    raise exception 'Not authorized to view assignable shops'
      using errcode = 'insufficient_privilege';
  end if;

  -- Deterministic ordering so the picker's option order is stable across renders and
  -- across replicas. shop_code is nullable, so NULLS LAST keeps un-coded shops from
  -- floating to the top; the id is the final tie-break, which is total because it is
  -- the primary key.
  return query
  select
    s.id,
    s.name,
    s.code,
    s.city
  from public.retailer_shops s
  where s.retailer_organization_id = v_retailer
    and s.status = 'ACTIVE'
  order by s.name, s.code nulls last, s.id;
end;
$$;

revoke all     on function public.list_retailer_staff_assignable_shops() from public;
revoke execute on function public.list_retailer_staff_assignable_shops() from anon;
grant  execute on function public.list_retailer_staff_assignable_shops() to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One function added; nothing else exists in this migration. service_role is granted
-- nothing: this is a browser read whose entire authority comes from auth.uid(), and a
-- service-role path would let shop ids be enumerated with no session at all.
