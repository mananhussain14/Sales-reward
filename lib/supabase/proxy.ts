import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { getSupabaseEnv } from "@/lib/env/supabase";

/**
 * Supabase session refresh for the Next.js 16 Proxy (formerly middleware).
 *
 * Responsibilities, in order of importance:
 *   1. Refresh the Supabase auth cookies on every matched request. Access
 *      tokens are short-lived; without this, a browsing user's session would
 *      lapse and Server Components — which cannot write cookies — would have no
 *      way to renew it.
 *   2. Perform an OPTIMISTIC redirect for obviously-unauthenticated traffic.
 *
 * Step 2 is a UX nicety, NOT the security boundary. Per the Next.js
 * authentication guide, Proxy must not be treated as a full authorization
 * solution: it runs on prefetches, it is skipped for paths outside the matcher,
 * and it can be bypassed by any request that reaches a route directly. Real
 * enforcement lives at the server layout boundary — see app/(admin)/layout.tsx
 * and app/login/page.tsx, each of which independently verifies claims.
 */

/** The only path an unauthenticated visitor may render. */
const LOGIN_PATH = "/login";

/** Where a verified user is sent when they hit the login page. */
const AUTHENTICATED_HOME = "/";

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

  const { pathname } = request.nextUrl;

  if (!hasVerifiedClaims && pathname !== LOGIN_PATH) {
    return redirectPreservingCookies(request, response, LOGIN_PATH);
  }

  if (hasVerifiedClaims && pathname === LOGIN_PATH) {
    return redirectPreservingCookies(request, response, AUTHENTICATED_HOME);
  }

  // Must be returned as-is (never a fresh NextResponse), or the rotated cookies
  // are lost.
  return response;
}
