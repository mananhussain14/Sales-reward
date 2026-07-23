// SERVER-ONLY MODULE.
//
// Must never be imported into a Client Component: it transitively imports
// `next/headers` (via @/lib/supabase/server), which throws at build time if it ever
// reaches the browser bundle.
//
// WHO MAY USE THE RETAILER PORTAL — the one place that question is answered.
//
// Before this milestone the portal admitted exactly one kind of person: a
// RETAILER_OWNER, decided by public.get_retailer_owner_portal_context() (whose
// resolver requires r.code = 'RETAILER_OWNER'). The staff milestone adds a second:
// anyone who can read the staff roster, which today means a RETAILER_MANAGER.
//
// AUTHORIZATION IS STILL ENTIRELY THE DATABASE'S. This module makes no permission
// decision of its own and contains no role or permission constant. It asks two
// existing, independently-authorized questions in order and reports which one
// answered:
//
//   1. getRetailerOwnerPortalAccess()  -> "owner"     (RETAILER_PORTAL_READ + owner role)
//   2. getRetailerStaffMembers()       -> "reader"    (RETAILER_STAFF_READ)
//   3. getMyAssignedReceiptShops()     -> "submitter" (RECEIPT_SUBMIT)
//
// Each permission is mapped to exactly the roles that should have it, and no role name
// appears here — a mapping change in SQL changes who gets which experience without this
// file being edited. RECEIPT_SUBMIT is mapped to SALES_STAFF alone, which is precisely
// why an Owner or a Manager never resolves as a submitter.
//
// WHY THE ROSTER READ IS THE PROBE, rather than a new "am I staff?" call: it is the
// exact read the staff page needs anyway, it is request-cached, and using the real
// operation as the gate means the page can never render for someone the operation
// would refuse. There is no second definition to drift.
//
// NO RETAILER NAME FOR A READER, deliberately. No RPC in the installed schema returns
// the Retailer's name to a non-owner: get_retailer_owner_portal_context requires the
// owner role, and public.organizations is reachable only through RLS reads this
// codebase's portal layer does not perform (it contains zero `.from(` calls, by
// design). Rather than fabricate a name, read a table the portal has always refused to
// read, or guess when a person belongs to more than one organization, a reader's
// `retailerName` is null and the shell simply omits it. Adding it later is a backend
// change — a name-bearing RPC gated on RETAILER_STAFF_READ — not an application one.
import { cache } from "react";
import { getRetailerOwnerPortalAccess } from "@/lib/retailer-portal/retailer-owner-portal";
import { getRetailerStaffMembers } from "@/lib/staff/retailer-staff-data";
import { getMyAssignedReceiptShops } from "@/lib/receipts/receipt-data";
import {
  selectPortalAccess,
  shouldProbeRoster,
  shouldProbeSubmitter,
} from "@/lib/staff/portal-access-decision";

/**
 * What the caller may do in the portal.
 *
 *   owner   full portal: overview, shops, staff roster, invitations, invite/resend/
 *           revoke controls, and assignable shop ids.
 *   reader  the staff roster only. No invitation list, no management controls, no shop
 *           ids — each refused by the database, not merely hidden.
 */
export type RetailerPortalAccessKind = "owner" | "reader" | "submitter";

export type RetailerPortalAccess =
  | {
      status: "authorized";
      kind: "owner";
      /** From the authorized owner context — the only source it may come from. */
      retailerName: string;
    }
  | {
      status: "authorized";
      kind: "reader";
      /** Always null. See the module note above. */
      retailerName: null;
    }
  | {
      status: "authorized";
      kind: "submitter";
      /** Always null, for the same reason as a reader. */
      retailerName: null;
    }
  | { status: "unauthenticated" }
  /** A verified identity that qualifies for neither. */
  | { status: "unauthorized" }
  /** The reads could not be completed. Distinct from a denial. */
  | { status: "unavailable" };

async function resolveRetailerPortalAccess(): Promise<RetailerPortalAccess> {
  const owner = await getRetailerOwnerPortalAccess();

  // The roster is asked only when it could change the answer — see shouldProbeRoster.
  // Its status is fed to the pure decision as "denied" otherwise, which that function
  // ignores in exactly those two branches.
  const roster = shouldProbeRoster(owner.status)
    ? (await getRetailerStaffMembers()).status
    : ("denied" as const);

  // The receipt probe is issued only when neither earlier read authorized the caller,
  // so a Manager's request never touches a Sales-Staff-only RPC at all.
  const submitter = shouldProbeSubmitter(owner.status, roster)
    ? (await getMyAssignedReceiptShops()).status
    : ("denied" as const);

  const decision = selectPortalAccess(owner.status, roster, submitter);

  switch (decision.kind) {
    case "owner":
      return {
        status: "authorized",
        kind: "owner",
        // Reached only when the owner read was "authorized", so the context exists.
        // Narrowed explicitly rather than asserted: a cast would be a claim about the
        // resolver, and TypeScript erases it at runtime.
        retailerName:
          owner.status === "authorized" ? owner.context.retailerName : "",
      };
    case "reader":
      return { status: "authorized", kind: "reader", retailerName: null };
    case "submitter":
      return { status: "authorized", kind: "submitter", retailerName: null };
    case "unauthenticated":
      return { status: "unauthenticated" };
    case "unauthorized":
      return { status: "unauthorized" };
    case "unavailable":
    default:
      return { status: "unavailable" };
  }
}

/**
 * The caller's portal access — the single authorization export for the portal.
 *
 * React `cache` here is REQUEST-SCOPED memoization for one Server Component render,
 * and nothing more: the layout and every page beneath it resolve it once. It is NOT a
 * persistent cache and must never become one — an authorization result belongs to
 * exactly one caller for exactly one request. cache() is called once at module scope;
 * the function takes no arguments, so there is no cache key, deliberately.
 */
export const getRetailerPortalAccess = cache(resolveRetailerPortalAccess);
