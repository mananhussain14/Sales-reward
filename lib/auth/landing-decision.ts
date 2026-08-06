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
 *   salesStaff    the Sales Staff Home — campaigns, target progress, coins earned and
 *                 the way into receipt submission.
 *   claimReviewer the Claim Review portal. Reached ONLY by a caller who qualifies
 *                 for no other experience — see the precedence note on
 *                 selectLanding below.
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
  /**
   * A Sales Staff member's landing: the Home dashboard.
   *
   * NOT /retailer/receipts any more. That route is unchanged and still carries the
   * submission form and the personal history — it simply is not the landing, because a
   * landing whose primary call to action opens the submission flow cannot itself BE the
   * submission flow. Both routes are gated on the same RECEIPT_SUBMIT mapping, so this
   * moves a destination and changes no authorization.
   */
  salesStaff: "/retailer/home",
  /** The Claim Review portal. */
  claimReviewer: "/review",
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
  | { kind: "claimReviewer"; destination: typeof LANDING_ROUTES.claimReviewer }
  | { kind: "unauthorized"; destination: typeof LANDING_ROUTES.accessDenied }
  | { kind: "unauthenticated"; destination: typeof LANDING_ROUTES.login }
  | { kind: "unavailable" };

/**
 * The Claim Reviewer resolver's four states. Like the Retailer portal resolver and
 * unlike the Vendor one, it distinguishes an operational failure ("unavailable")
 * from an authorization denial ("unauthorized"), and this decision preserves that
 * distinction rather than collapsing one into the other.
 */
export type ClaimReviewerAccessStatus =
  | "authorized"
  | "unauthenticated"
  | "unauthorized"
  | "unavailable";

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
 *        submitter       -> /retailer/home       (Sales Staff Home)
 *        unavailable     -> unavailable (operational, NOT a denial)
 *        unauthenticated -> /login (defensive; the token said no session)
 *        unauthorized    -> consult the Claim Reviewer resolver (step 4)
 *   4. Neither Vendor nor Retailer -> consult the Claim Reviewer resolver:
 *        authorized      -> /review
 *        unavailable     -> unavailable (operational, NOT a denial)
 *        unauthenticated -> /login (defensive)
 *        unauthorized    -> generic /access-denied
 *
 * THE REVIEWER IS CONSULTED LAST, AND THAT ORDERING IS THE WHOLE POINT.
 * It makes adding this branch provably zero-regression: the only callers whose
 * destination can change are those who would previously have landed on
 * /access-denied. A Vendor Super Admin still lands at "/", including one who ALSO
 * holds CLAIM_REVIEWER — they are never silently moved out of Vendor Admin, and
 * /review stays directly reachable. A Retailer Owner, Manager or Sales Staff member
 * keeps their existing landing unchanged.
 *
 * `reviewer` DEFAULTS to "unauthorized" so every pre-existing call site and test
 * continues to describe exactly the same behaviour it did before. That default is
 * not a shortcut: it is what lets the existing landing tests stand unmodified as a
 * regression proof.
 *
 * OPERATIONAL vs DENIAL: the Retailer and Claim Reviewer "unavailable" statuses each
 * yield the "unavailable" kind. Nothing here converts a failure into a denial or a
 * denial into a failure.
 */
export function selectLanding(
  vendor: VendorAccessStatus,
  retailer: RetailerAccessStatus,
  reviewer: ClaimReviewerAccessStatus = "unauthorized",
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
      // The Retailer answer is unknown, so the caller may yet be a Retailer. Do NOT
      // fall through to the reviewer check — that would hand a Retailer the wrong
      // portal during an outage.
      return { kind: "unavailable" };
    case "unauthenticated":
      return { kind: "unauthenticated", destination: LANDING_ROUTES.login };
    case "unauthorized":
    default:
      // Neither a Vendor nor a Retailer. This is the branch that previously ended
      // at /access-denied, and the only branch the reviewer check can change.
      switch (reviewer) {
        case "authorized":
          return {
            kind: "claimReviewer",
            destination: LANDING_ROUTES.claimReviewer,
          };
        case "unavailable":
          // We do not know whether they are a reviewer. Denying them here would
          // turn a transient outage into a refusal they cannot act on.
          return { kind: "unavailable" };
        case "unauthenticated":
          return { kind: "unauthenticated", destination: LANDING_ROUTES.login };
        case "unauthorized":
        default:
          return {
            kind: "unauthorized",
            destination: LANDING_ROUTES.accessDenied,
          };
      }
  }
}
