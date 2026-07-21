/**
 * PURE MODULE — no imports, no I/O, no `next/server`, no Supabase client.
 *
 * This is the request-routing decision for the Next.js Proxy, separated from the
 * session-refresh wiring in ./proxy.ts so it can be unit-tested directly (see
 * ./proxy-routing.test.ts). The same separation pattern the landing decision
 * uses (lib/auth/landing-decision.ts): the branchy policy lives in a pure
 * function; the module that performs I/O just feeds it verified facts.
 *
 * WHY THIS EXISTS — the bug it repairs.
 *
 * The Proxy previously applied its "authenticated visitor on /login -> send them
 * home" redirect to EVERY request method. A Server Action submitted from the
 * login form posts to the login route's own URL (`POST /login`, carrying the
 * `next-action` header). `NextResponse.redirect()` defaults to HTTP 307, which
 * PRESERVES the method and body — so the Proxy turned `POST /login` into
 * `POST /`, method-preserved. The browser re-issued the sign-in submission
 * against `/`, which has no matching Server Action for that action id, so it
 * received an ordinary page response instead of an action result. React's
 * Server Actions client then threw "An unexpected response was received from the
 * server", surfaced at <LoginForm /> in app/login/page.tsx.
 *
 * THE RULE ENCODED HERE.
 *
 * A Proxy redirect is a NAVIGATION convenience, never an authorization boundary
 * (that lives at the server layouts and inside each Server Action). Navigation
 * redirects must therefore apply ONLY to page navigations — GET and HEAD — and
 * must never intercept a Server Action submission, which is always a POST. The
 * cookie refresh in ./proxy.ts still runs for every request regardless of what
 * this function decides; only the redirect is gated.
 */

/** The sign-in page. */
export const LOGIN_PATH = "/login";

/** Where a verified user is sent when they hit the login page. */
export const AUTHENTICATED_HOME = "/";

/**
 * The complete set of paths an unauthenticated visitor may render.
 *
 * An explicit allowlist of EXACT paths, deliberately not a prefix test. A prefix
 * rule such as `pathname.startsWith("/invitations")` would open every current and
 * future path beneath that segment, including ones nobody reviewed when they were
 * added. Exact matching means opening a route is always a visible edit to this
 * set.
 *
 * Each entry, and why it must be reachable without a session:
 *
 *   /login              the sign-in form itself.
 *   /invitations/accept the invitation callback. The invitee arrives here
 *                       carrying a one-time token and NO session — establishing
 *                       one is the entire purpose of the route. Redirecting them
 *                       to /login would consume the token's single use and strand
 *                       them permanently.
 *   /invitations/error  the generic failure page for the above. It must render for
 *                       a visitor who never obtained a session, which is precisely
 *                       the case that sends them there.
 *
 * Nothing under (admin) appears here, and no Retailer route does either. This set
 * grants VISIBILITY of a page, never authorization: /invitations/accept performs
 * its own token verification, and every admin route is guarded independently at
 * the server layout boundary regardless of what this file allows.
 */
export const PUBLIC_PATHS = new Set<string>([
  LOGIN_PATH,
  "/invitations/accept",
  "/invitations/error",
]);

/**
 * The facts the decision needs, all derived from the request by ./proxy.ts.
 *
 *   method            the HTTP method, verbatim (e.g. "GET", "POST").
 *   pathname          request.nextUrl.pathname — no query string.
 *   hasVerifiedClaims whether supabase.auth.getClaims() returned a verified JWT.
 *                     This is a VERIFIED signal, never a raw cookie read.
 *   isServerAction    whether the request carries the `next-action` header.
 *                     Supplementary only — see decideProxyRoute for why the
 *                     method check is the reliable signal and this is not.
 */
export type ProxyRouteInput = {
  method: string;
  pathname: string;
  hasVerifiedClaims: boolean;
  isServerAction: boolean;
};

/**
 * The outcome. `continue` means "let the request proceed with its refreshed
 * cookies"; `redirect` names one of the two fixed internal destinations. There is
 * no variant that carries a caller-supplied path — an open redirect is impossible
 * by construction, exactly as in the landing decision.
 */
export type ProxyRouteDecision =
  | { kind: "continue" }
  | { kind: "redirect"; destination: typeof LOGIN_PATH | typeof AUTHENTICATED_HOME };

/**
 * Decide what the Proxy should do with a request that has already had its
 * session verified.
 *
 * PAGE-NAVIGATION GATE. A redirect is emitted only for a page navigation, and a
 * page navigation is a GET or HEAD that is NOT a Server Action. Everything else —
 * every POST, and anything carrying the `next-action` header — is allowed through
 * untouched so it can reach its intended endpoint.
 *
 * WHY THE METHOD CHECK IS THE RELIABLE SIGNAL, AND THE HEADER IS NOT.
 * Every Server Action is dispatched as a POST. The JS runtime dispatch adds the
 * `next-action` header, but the progressive-enhancement path (a plain <form>
 * submitting with no client JS) does NOT — it posts multipart form data with an
 * internal field instead. So the header is PRESENT for some actions and ABSENT
 * for others, whereas the method is POST for ALL of them. Gating on GET/HEAD
 * therefore excludes every Server Action, with or without the header; gating on
 * the header alone would miss the no-JS submissions. The header is folded in only
 * as belt-and-suspenders: should a future request ever carry it on a GET/HEAD, we
 * still decline to redirect it, choosing the safe direction (never intercept a
 * possible action). It never BROADENS what gets redirected.
 *
 * SECURITY. Letting a POST through here grants nothing: the (admin) and (retailer)
 * layouts re-check authorization on every render, and each write Server Action
 * re-authorizes itself from the verified token and fails closed. A signed-out POST
 * that this function lets through still hits an action that redirects it to /login
 * or refuses it. The redirects here are pure UX.
 */
export function decideProxyRoute(input: ProxyRouteInput): ProxyRouteDecision {
  const isPageNavigation =
    (input.method === "GET" || input.method === "HEAD") && !input.isServerAction;

  // Non-navigation requests (every POST, and anything flagged as a Server Action)
  // are never page-redirected. This is the whole fix: a login-action POST is left
  // to reach the sign-in action instead of being 307'd — method-preserved — onto
  // "/". Their authorization is enforced downstream, not here.
  if (!isPageNavigation) {
    return { kind: "continue" };
  }

  // Optimistic pre-filter for obviously-unauthenticated navigation. NOT the
  // security boundary — the server layouts re-check and fail closed. Public paths
  // (the sign-in form and the invitation callback/error pages) are exempt.
  if (!input.hasVerifiedClaims && !PUBLIC_PATHS.has(input.pathname)) {
    return { kind: "redirect", destination: LOGIN_PATH };
  }

  // A verified user has no business seeing the sign-in form; send them to the
  // authenticated landing. Only /login bounces — the invitation paths deliberately
  // do not, because verifyOtp establishes a session as part of accepting, and
  // bouncing a visitor off their own callback mid-flight would abort the
  // acceptance it had just performed.
  if (input.hasVerifiedClaims && input.pathname === LOGIN_PATH) {
    return { kind: "redirect", destination: AUTHENTICATED_HOME };
  }

  return { kind: "continue" };
}
