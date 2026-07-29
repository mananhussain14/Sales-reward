// SERVER-ONLY MODULE.
//
// "May this caller change a Retailer's lifecycle at all?" — answered by the database, under
// the caller's own token, with no argument the browser can influence.
//
//   public.has_organization_permission(target_organization_id uuid, target_permission_code text)
//     -> boolean
//
// ============================================================================
// WHY THIS EXISTS AS A SEPARATE PROBE
// ============================================================================
// getVendorSuperAdminAccess() proves the caller holds the ACTIVE VENDOR_SUPER_ADMIN role in
// an ACTIVE VENDOR organization — and deliberately returns NO permission detail, because the
// admin shell it guards does not need any. RETAILERS_MANAGE is a NEW permission mapped to
// that role today, but the mapping is the authority and it can change without this file
// being edited; a page that inferred the capability from the ROLE would silently start
// offering a control the database refuses on the day the mapping is revoked.
//
// The Retailer-side staff control solved the same problem by probing with a READ RPC gated
// on the identical permission. There is no such read for RETAILERS_MANAGE — the write is its
// only consumer — so this asks the question directly, using the helper every RLS policy in
// this project already asks it with.
//
// THIS IS A PRESENTATION PROBE, NEVER AN ENFORCEMENT BOUNDARY. A `confirmed` here permits a
// control to RENDER. The Server Action calls this again for itself, and
// public.set_vendor_retailer_status re-derives the permission from auth.uid() under its own
// row locks regardless of what any page decided. Nothing downstream may treat a `confirmed`
// as permission to write.
//
// NO ARGUMENT IS ACCEPTED. The organization id sent to the helper comes from
// getVendorSuperAdminAccess(), which resolves it from the caller's own cryptographically
// verified token — never from a URL, form field, header or browser state. There is nothing
// here for a caller to substitute, so this probe cannot be pointed at another tenant.
//
// The helper itself is SECURITY DEFINER and hard-filtered to auth.uid(): it requires an
// ACTIVE profile, an ACTIVE membership OF THE ORGANIZATION ASKED ABOUT, an ACTIVE
// organization and an ACTIVE role carrying the permission. So even a substituted id could
// only ever answer `false`.
import { createClient } from "@/lib/supabase/server";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import type { VendorRetailerManageCapability } from "@/lib/retailers/vendor-retailer-lifecycle-input";

/** The permission-check helper. One call, one name, greppable. */
const HAS_ORGANIZATION_PERMISSION_RPC = "has_organization_permission" as const;

/**
 * The permission this milestone introduced, mapped to VENDOR_SUPER_ADMIN alone.
 *
 * Stated here because a permission CODE is what this probe asks about — it is not an
 * authorization decision made in TypeScript. The decision is the database's.
 */
const RETAILERS_MANAGE = "RETAILERS_MANAGE" as const;

export type VendorRetailerManageCapabilityResult = {
  status: VendorRetailerManageCapability;
};

/** Sanitized operator logging. No ids, names, error objects or row data. */
function logCapabilityFailure(category: string): void {
  console.error(`[vendor-retailer-lifecycle] capability probe failed: ${category}`);
}

/**
 * Whether this caller holds RETAILERS_MANAGE in the Vendor organization they are signed in
 * to.
 *
 * THREE OUTCOMES, and the last two are kept apart on purpose:
 *
 *   confirmed    the database said yes.
 *   denied       the database said no — including an unauthenticated or unauthorized caller,
 *                who has no Vendor context to hold a permission in.
 *   unavailable  the question could not be asked. NOT a fact about the caller.
 *
 * Both `denied` and `unavailable` hide the control, because the only safe response to not
 * knowing is to offer nothing. They are still distinct so the Server Action can report a
 * READ failure as a service problem rather than as a refusal of the administrator's rights.
 *
 * A non-boolean response is treated as `unavailable` rather than coerced: `Boolean(undefined)`
 * would be `false`, which is a definite denial this module has no grounds to assert.
 */
export async function getVendorRetailerManageCapability(): Promise<VendorRetailerManageCapabilityResult> {
  const access = await getVendorSuperAdminAccess();

  if (access.status !== "authorized") {
    // No Vendor context at all. Fail closed, and report it as the definite `denied` it is —
    // the caller genuinely holds no permission here, and the page redirects on these states
    // for its own reasons anyway.
    return { status: "denied" };
  }

  const result = await Promise.resolve(
    (await createClient()).rpc(HAS_ORGANIZATION_PERMISSION_RPC, {
      // The ONLY organization id used, and it is server-derived. See the module header.
      target_organization_id: access.organizationId,
      target_permission_code: RETAILERS_MANAGE,
    }),
  ).catch(() => null);

  if (result === null) {
    logCapabilityFailure("transport");
    return { status: "unavailable" };
  }

  if (result.error) {
    // Only the presence of an error is read — never its message, and never its code. There
    // is no refusal to classify here: the helper returns a boolean or it fails.
    logCapabilityFailure("rpc-error");
    return { status: "unavailable" };
  }

  const granted = result.data as unknown;

  if (typeof granted !== "boolean") {
    logCapabilityFailure("malformed-response");
    return { status: "unavailable" };
  }

  return { status: granted ? "confirmed" : "denied" };
}
