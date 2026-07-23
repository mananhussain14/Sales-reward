/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * This is the precedence logic for "where does an authenticated user land?",
 * separated from the resolvers that fetch authorization so it can be unit-tested
 * directly (see ./landing-decision.test.ts). The server-only wiring that calls
 * the real access resolvers lives in ./authenticated-landing.ts, which imports
 * `next/headers` transitively and therefore cannot be imported into a test.
 *
 * The function here takes only the two authorization STATUS discriminants — never
 * an organization, retailer, membership, role, or permission id, and never a
 * caller-supplied destination. Every route it can return is a fixed internal
 * literal from LANDING_ROUTES below, so there is no value a browser could set
 * that becomes a redirect target: an open redirect is impossible by construction.
 */

/**
 * The only destinations the landing decision may produce. Single source of truth,
 * shared with the login action (which redirects to `decision.destination`) and
 * the invitation-completion action (which redirects to `retailer`). Keeping them
 * here means the routes are asserted once, in the pure tests, and cannot drift
 * between the two call sites.
 *
 *   vendor        the existing Vendor Admin landing — app/(admin)/page.tsx is
 *                 served at "/". This is deliberately NOT "/dashboard": the repo
 *                 has no such route.
 *   retailer      the Retailer Owner Portal overview.
 *   retailerStaff the staff roster — the only portal page a Retailer Manager may
 *                 read. Sending them to /retailer instead would bounce them off it,
 *                 because that page requires the RETAILER_OWNER role.
 *   salesStaff    receipt submission and personal history — the only portal page a
 *                 Sales Staff member may reach.
 *   accessDenied  the established generic authenticated-denial route for a user
 *                 who holds neither supported authorization. NOT
 *                 /retailer-access-denied — that is the portal's own direct-route
 *                 denial and would re-run the retailer check, which is the wrong
 *                 surface for a Vendor-shaped or role-less account.
 *   login         the single sign-in route.
 */
export const LANDING_ROUTES = {
  vendor: "/",
  /** The Retailer Owner portal overview. */
  retailer: "/retailer",
  /** A Retailer Manager's permitted landing: the staff roster they may read. */
  retailerStaff: "/retailer/staff",
  /** A Sales Staff member's landing: receipt submission and their own history. */
  salesStaff: "/retailer/receipts",
  accessDenied: "/access-denied",
  login: "/login",
} as const;

/**
 * The Vendor resolver (public.get_vendor_super_admin_context via
 * getVendorSuperAdminAccess) is fail-closed: a database, RPC, or transport
 * failure returns "unauthorized", NOT a distinct error status. It therefore has
 * NO "unavailable" variant, and this input type reflects that exactly — there is
 * no vendor-unavailable case to model because the resolver cannot produce one.
 * A transient Vendor failure is indistinguishable from "not a Vendor" and falls
 * through to the Retailer check, which is precisely how app/(admin)/layout.tsx
 * already treats a Vendor-unauthorized result today.
 */
export type VendorAccessStatus = "authorized" | "unauthenticated" | "unauthorized";

/**
 * The Retailer Owner resolver DOES distinguish an operational failure
 * ("unavailable") from an authorization denial ("unauthorized"), so this input
 * carries all four states. "unavailable" is the only way an operational failure
 * can reach the landing decision at all.
 */
/**
 * The Retailer PORTAL resolver's six states. It distinguishes which experience the
 * caller qualifies for, not merely whether they qualify — "owner", "reader" (a
 * Retailer Manager) and "submitter" (Sales Staff) are three different landings, and
 * each is decided in SQL by a different permission mapping.
 *
 * It also distinguishes an operational failure ("unavailable") from an authorization
 * denial ("unauthorized"), and this decision preserves that distinction rather than
 * collapsing one into the other.
 */
export type RetailerAccessStatus =
  | "owner"
  | "reader"
  | "submitter"
  | "unauthenticated"
  | "unauthorized"
  | "unavailable";

/**
 * The outcome. Every authorization-resolved kind carries its fixed destination;
 * "unavailable" carries NONE, deliberately — an operational failure is not a
 * place to send someone. The login action turns it into a retry-safe message
 * while keeping the just-established session intact, rather than redirecting.
 */
export type LandingDecision =
  | { kind: "vendor"; destination: typeof LANDING_ROUTES.vendor }
  | { kind: "retailer"; destination: typeof LANDING_ROUTES.retailer }
  | { kind: "retailerStaff"; destination: typeof LANDING_ROUTES.retailerStaff }
  | { kind: "salesStaff"; destination: typeof LANDING_ROUTES.salesStaff }
  | { kind: "unauthorized"; destination: typeof LANDING_ROUTES.accessDenied }
  | { kind: "unauthenticated"; destination: typeof LANDING_ROUTES.login }
  | { kind: "unavailable" };

/**
 * Resolve the landing decision from the two authorization statuses.
 *
 * VENDOR-FIRST PRECEDENCE, deliberately:
 *   1. Vendor authorized      -> Vendor landing. A user who legitimately holds
 *      both roles keeps their established Vendor landing and does not silently
 *      get moved to /retailer; the portal stays reachable directly at /retailer.
 *   2. Vendor unauthenticated -> /login. Both resolvers read the same verified
 *      token, so no verified vendor identity means no session at all.
 *   3. Vendor unauthorized    -> consult the Retailer portal resolver:
 *        owner           -> /retailer            (Retailer Owner portal overview)
 *        reader          -> /retailer/staff      (Retailer Manager roster, read-only)
 *        submitter       -> /retailer/receipts   (Sales Staff receipt submission)
 *        unavailable     -> unavailable (operational, NOT a denial)
 *        unauthenticated -> /login (defensive; the token said no session)
 *        unauthorized    -> generic /access-denied
 *
 * OPERATIONAL vs DENIAL: only the Retailer "unavailable" status yields the
 * "unavailable" kind. Nothing here converts a failure into a denial or a denial
 * into a failure.
 */
export function selectLanding(
  vendor: VendorAccessStatus,
  retailer: RetailerAccessStatus,
): LandingDecision {
  if (vendor === "authorized") {
    return { kind: "vendor", destination: LANDING_ROUTES.vendor };
  }

  if (vendor === "unauthenticated") {
    return { kind: "unauthenticated", destination: LANDING_ROUTES.login };
  }

  // vendor === "unauthorized": a verified identity that is not a Vendor Super
  // Admin. Fall through to the Retailer portal authorization, which reports WHICH
  // experience they qualify for.
  switch (retailer) {
    case "owner":
      return { kind: "retailer", destination: LANDING_ROUTES.retailer };
    case "reader":
      return { kind: "retailerStaff", destination: LANDING_ROUTES.retailerStaff };
    case "submitter":
      return { kind: "salesStaff", destination: LANDING_ROUTES.salesStaff };
    case "unavailable":
      return { kind: "unavailable" };
    case "unauthenticated":
      return { kind: "unauthenticated", destination: LANDING_ROUTES.login };
    case "unauthorized":
    default:
      return { kind: "unauthorized", destination: LANDING_ROUTES.accessDenied };
  }
}
