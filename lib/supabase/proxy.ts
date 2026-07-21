import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/env/supabase";
import { decideProxyRoute } from "@/lib/supabase/proxy-routing";

/**
 * Supabase session refresh for the Next.js 16 Proxy (formerly middleware).
 *
 * Responsibilities, in order of importance:
 *   1. Refresh the Supabase auth cookies on every matched request, regardless of
 *      HTTP method. Access tokens are short-lived; without this, a browsing user's
 *      session would lapse and Server Components — which cannot write cookies —
 *      would have no way to renew it.
 *   2. Perform an OPTIMISTIC, NAVIGATION-ONLY redirect for obviously-
 *      unauthenticated traffic and for a verified visitor on /login. The routing
 *      policy for this lives in the pure ./proxy-routing.ts (decideProxyRoute).
 *
 * Step 2 is a UX nicety, NOT the security boundary. Per the Next.js
 * authentication guide, Proxy must not be treated as a full authorization
 * solution: it runs on prefetches, it is skipped for paths outside the matcher,
 * and it can be bypassed by any request that reaches a route directly. Real
 * enforcement lives at the server layout boundary — see app/(admin)/layout.tsx
 * and app/login/page.tsx, each of which independently verifies claims.
 *
 * WHY THE REDIRECT IS NAVIGATION-ONLY. `NextResponse.redirect()` defaults to HTTP
 * 307, which preserves the request method and body. A Server Action posts to its
 * own page URL (a login submission is `POST /login`), so redirecting it would
 * method-preserve `POST /login` onto `POST /` and corrupt the action response —
 * the browser would surface "An unexpected response was received from the server".
 * decideProxyRoute therefore emits a redirect ONLY for GET/HEAD page navigations,
 * never for a POST/Server Action, which is left to reach its endpoint (where it
 * re-authorizes itself and fails closed). See ./proxy-routing.ts for the full
 * rationale.
 *
 * The `next-action` header (ACTION_HEADER in Next.js) is read purely as a
 * supplementary signal — the method check already excludes every Server Action,
 * including the no-JS progressive-enhancement POST that carries no such header.
 */

/**
 * Builds a redirect that carries over every cookie Supabase just wrote.
 *
 * `NextResponse.redirect()` starts with an empty cookie jar, so returning one
 * directly would discard a freshly-rotated token and log the user out on the
 * next request. Copying the jar across is what keeps the refresh durable.
 *
 * The search string is dropped deliberately: it keeps any submitted values out
 * of the redirect URL (and therefore out of browser history, referrers, and
 * server logs).
 */
function redirectPreservingCookies(
  request: NextRequest,
  response: NextResponse,
  pathname: string,
): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";

  const redirectResponse = NextResponse.redirect(url);
  for (const cookie of response.cookies.getAll()) {
    redirectResponse.cookies.set(cookie);
  }

  return redirectResponse;
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // Mutable: the `setAll` adapter below rebuilds this whenever Supabase rotates
  // a token, so the response handed back always carries the newest cookies.
  let response = NextResponse.next({ request });

  const { url, publishableKey } = getSupabaseEnv();

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      // The getAll/setAll pair is the current @supabase/ssr adapter contract.
      // The older get/set/remove adapters are deprecated and cannot express a
      // multi-cookie rotation correctly, so they are not used here.
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Update the request first so anything rendered downstream in this same
        // pass observes the new cookies...
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        // ...then rebuild the response around the updated request and mirror the
        // cookies onto it so they actually reach the browser.
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  let hasVerifiedClaims: boolean;
  try {
    // Do not insert logic between createServerClient() and this call: it is what
    // triggers the token refresh, and any early return in between would ship a
    // response with stale cookies.
    //
    // getClaims() verifies the JWT signature (against the cached JWKS for
    // asymmetric keys, otherwise via the Auth server) and refreshes the session
    // first if the token is close to expiring. getSession() is never used: it
    // returns whatever is in the cookie without verifying it, so it cannot
    // support a trust decision.
    const { data } = await supabase.auth.getClaims();
    hasVerifiedClaims = Boolean(data?.claims);
  } catch {
    // A transport failure against the Auth server must not turn into a 500 for
    // every route. Skip the optimistic redirect and let the request through with
    // its refreshed cookies — the layout boundary re-checks and fails CLOSED, so
    // being permissive here costs nothing in security terms.
    return response;
  }

  // The routing decision is delegated in full to the pure decideProxyRoute, so
  // this refresh path and the unit tests exercise exactly the same policy. It is
  // fed only VERIFIED facts: the method, the pathname, the verified-claims result
  // above, and whether the request carries the `next-action` header. Crucially,
  // it emits a redirect only for GET/HEAD page navigations — a Server Action POST
  // is always returned as `continue`, so the login submission reaches its action
  // instead of being 307'd onto "/".
  const decision = decideProxyRoute({
    method: request.method,
    pathname: request.nextUrl.pathname,
    hasVerifiedClaims,
    // ACTION_HEADER is "next-action"; the Headers API matches names
    // case-insensitively. Present only means "flagged Server Action" — a
    // supplementary guard, not the primary one (the method check already covers
    // every action). See ./proxy-routing.ts.
    isServerAction: request.headers.has("next-action"),
  });

  if (decision.kind === "redirect") {
    return redirectPreservingCookies(request, response, decision.destination);
  }

  // Must be returned as-is (never a fresh NextResponse), or the rotated cookies
  // are lost.
  return response;
}
