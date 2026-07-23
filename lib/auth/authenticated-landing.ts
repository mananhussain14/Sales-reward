// SERVER-ONLY MODULE.
//
// Must never be imported into a Client Component: it transitively imports
// `next/headers` (via both access resolvers), which throws at build time if it
// reaches the browser bundle. The pure precedence logic it delegates to lives in
// @/lib/auth/landing-decision, which has no such import and is what the tests
// exercise.
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import {
  selectLanding,
  type LandingDecision,
} from "@/lib/auth/landing-decision";

/**
 * Resolve where the current authenticated user should land, from their own
 * verified session and nothing else.
 *
 * Takes NO arguments — no organization, retailer, membership, role, or
 * permission id, and no caller-supplied destination. Identity and authorization
 * are resolved entirely by the two existing secure resolvers, each of which
 * reads auth.uid() from the verified token. This function only ORDERS their
 * results; it makes no authorization decision of its own and reaches no table.
 *
 * Both resolvers are request-scoped-cached (React cache at module scope), so
 * calling them here does not duplicate work already done by a layout in the same
 * request, and calling them together is safe: neither takes input, neither
 * mutates, and each can only ever report on the one caller.
 *
 * The Retailer portal resolver is consulted ONLY when the Vendor result is
 * "unauthorized" — a verified-but-not-Vendor identity. When the caller is a
 * Vendor Super Admin, or has no verified session at all, it is not called, which
 * both preserves Vendor-first precedence and avoids a needless round trip.
 *
 * NO ROLE NAME APPEARS HERE. The portal resolver reports "owner", "reader" or
 * "submitter" — which authorized READ succeeded — and a permission-mapping change
 * in SQL therefore changes where someone lands without this file being edited.
 *
 * FAIL-CLOSED AND FAIL-SAFE. Neither resolver throws by contract — each catches
 * its own failures and returns a status (Vendor collapses operational failures
 * to "unauthorized"; Retailer surfaces them as "unavailable"). The try/catch
 * here is defence in depth against an unexpected throw: it maps one to
 * "unavailable" rather than letting it escape, so a login is never turned into a
 * 500 and the established session is never torn down by a transient fault. No
 * error object, session, token, or row is bound or logged.
 */
export async function resolveAuthenticatedLanding(): Promise<LandingDecision> {
  try {
    const vendor = await getVendorSuperAdminAccess();

    // Vendor-first: an authorized Vendor keeps "/", and an unauthenticated caller
    // goes to /login, without the Retailer RPC being consulted at all. The second
    // argument is a placeholder that selectLanding ignores in both branches.
    if (vendor.status === "authorized" || vendor.status === "unauthenticated") {
      return selectLanding(vendor.status, "unauthorized");
    }

    // vendor.status === "unauthorized": verified identity, not a Vendor. Now — and
    // only now — resolve Retailer PORTAL access. It reports which experience the
    // caller qualifies for — owner, roster reader (a Retailer Manager) or receipt
    // submitter (Sales Staff) — each decided in SQL by a different permission
    // mapping, and each landing on a different page. Its "unavailable" is the single
    // operational-failure signal the decision can observe.
    const portal = await getRetailerPortalAccess();
    return selectLanding(
      "unauthorized",
      portal.status === "authorized" ? portal.kind : portal.status,
    );
  } catch {
    // Unreachable under the resolvers' contracts; handled anyway. An operational
    // failure must never masquerade as a denial, so it becomes "unavailable" —
    // the login action renders a retry-safe message and leaves the session alone.
    return { kind: "unavailable" };
  }
}
