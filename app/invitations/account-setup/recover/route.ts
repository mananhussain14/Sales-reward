import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GENERIC account RECOVERY callback — TOKEN VERIFICATION ONLY.
 *
 * A Route Handler rather than a page, because its whole job is a side effect and a
 * redirect: it renders nothing, and a page that mutated state during render would
 * re-run on every refresh and prefetch.
 *
 * ============================================================================
 * WHY IT EXISTS
 * ============================================================================
 * /invitations/account-setup completes a generic invited account by setting a
 * password, but it REQUIRES a session and cannot create one — it has no token to
 * exchange. A recovery email carries `?token_hash=…&type=recovery`, so pointing the
 * email straight at that page would land a visitor with a token and no session on a
 * screen that refuses anyone without one. Something has to perform the exchange
 * first. This route is that step, and nothing more.
 *
 * It is the generic counterpart of /invitations/staff/recover, which does the same
 * job for an invited Retailer staff member and hands off to the STAFF password
 * screen. That route is deliberately left untouched and remains the landing for
 * every recovery email already in flight; this one exists so a Vendor-side invitee
 * with no Retailer invitation is no longer routed through a Retailer flow that ends
 * on /access-denied.
 *
 * ============================================================================
 * WHAT IT DOES
 * ============================================================================
 *   1. Reads `token_hash` and `type=recovery` from the query string — ordinary
 *      parameters, because the project's recovery template emits {{ .TokenHash }}
 *      rather than GoTrue's default fragment-based {{ .ConfirmationURL }}.
 *   2. Exchanges the hash for a session via verifyOtp(), SERVER-SIDE. The token never
 *      enters client JavaScript.
 *   3. Redirects to /invitations/account-setup.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY DOES NOT DO
 * ============================================================================
 * It does not set a password — that belongs to the generic account-setup action, and
 * duplicating it here would create a second, differently-guarded way to change a
 * credential. It creates no profile, no organization membership, no member-role
 * assignment and no audit event; it calls no RPC; it imports no service-role client.
 *
 * So establishing a session here grants NOTHING. The page it redirects to
 * re-establishes every one of its own preconditions — verified session, confirmed
 * address, and no existing portal — because a redirect is not a permission.
 *
 * It names no role. Any generic, portal-less invited account can use it.
 *
 * NOTHING IS LOGGED. Not the token hash, the address, an id, or any Auth error
 * object.
 */

/**
 * Where a verified recovery session continues. A fixed module constant, never a
 * value read from the query string, a header or the database — so there is no
 * caller-controlled destination to sanitize and an open redirect is impossible.
 */
const SETUP_PATH = "/invitations/account-setup";

/**
 * Where every failure goes. The SAME generic invitation error page the invitation
 * callback and the staff recovery callback use, so a malformed link, an expired
 * token, an already-consumed token and an invalid one are indistinguishable from
 * outside. This route must not become an oracle.
 */
const FAILURE_PATH = "/invitations/error";

/**
 * The ONLY OTP type this callback will process.
 *
 * Checked strictly. Supabase issues token hashes for `invite`, `magiclink`, `signup`
 * and `email_change` through the same verifyOtp surface; accepting an arbitrary
 * `type` would let a token minted for one of those flows be replayed against this
 * one to establish a session.
 */
const RECOVERY_TYPE = "recovery";

/**
 * Builds an internal redirect.
 *
 * The path is always one of the two module constants above. Cloning
 * `request.nextUrl` and replacing the pathname keeps the redirect strictly
 * same-origin, and `url.search = ""` drops the token from the outgoing URL so it
 * cannot survive into browser history, a referrer header or a server access log.
 * This mirrors app/invitations/accept/route.ts and app/invitations/staff/recover.
 */
function redirectTo(request: NextRequest, pathname: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return url;
}

/**
 * Belt-and-braces against the token reaching a third party through the Referer
 * header on the redirect hop, matching app/invitations/staff/recover/route.ts.
 */
function withNoReferrer(response: NextResponse): NextResponse {
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type");

  // Shape screening before any network call. A link missing either parameter, or
  // carrying a `type` this route does not handle, is not something to hand to the
  // Auth server.
  if (
    typeof tokenHash !== "string" ||
    tokenHash.length === 0 ||
    type !== RECOVERY_TYPE
  ) {
    return withNoReferrer(
      NextResponse.redirect(redirectTo(request, FAILURE_PATH)),
    );
  }

  // createClient() wires cookie writes through the Route Handler's cookie store,
  // which is what lets verifyOtp() persist the new session. This is the ordinary
  // publishable-key server client: the invitee authenticates as themselves, and the
  // service-role client has no part in recovery.
  const supabase = await createClient();

  try {
    // Exchanges the single-use hash for a session and writes the auth cookies. The
    // token is passed straight through and is not stored, echoed or logged.
    const { error } = await supabase.auth.verifyOtp({
      type: RECOVERY_TYPE,
      token_hash: tokenHash,
    });

    if (error) {
      // The Supabase error is deliberately not bound, inspected or logged: its
      // message and status distinguish "expired" from "already used" from
      // "invalid", which is precisely the discrimination this route refuses to
      // expose. It can also echo the submitted token.
      console.error("account-setup/recover: token verification failed");
      return withNoReferrer(
        NextResponse.redirect(redirectTo(request, FAILURE_PATH)),
      );
    }
  } catch {
    // A transport-level throw can carry request URLs and headers — which on this
    // request include the token. Nothing is bound or logged.
    console.error("account-setup/recover: token verification threw");
    return withNoReferrer(
      NextResponse.redirect(redirectTo(request, FAILURE_PATH)),
    );
  }

  // A session now exists, and that is ALL this route has done. No password has been
  // set and no authorization has been granted; the destination re-checks the
  // session, the confirmed address and the absence of a portal for itself.
  return withNoReferrer(NextResponse.redirect(redirectTo(request, SETUP_PATH)));
}
