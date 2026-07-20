import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Invitation acceptance callback — TOKEN VERIFICATION ONLY.
 *
 * A Route Handler rather than a page, because this endpoint's whole job is to
 * perform a side effect and redirect: it never renders anything, and a page that
 * mutated state during render would re-run on every refresh and prefetch.
 *
 * WHAT IT DOES
 *   1. Reads `token_hash` and `type=invite` from the query string — ordinary
 *      parameters, because supabase/templates/invite.html emits {{ .TokenHash }}
 *      rather than GoTrue's default fragment-based {{ .ConfirmationURL }}.
 *   2. Exchanges the hash for a session via verifyOtp(), SERVER-SIDE. The token
 *      never enters client JavaScript.
 *   3. Redirects to /invitations/complete.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — AND THIS IS THE POINT
 *   IT DOES NOT ACCEPT THE INVITATION. accept_retailer_owner_invitation() is not
 *   called here, and this route activates nothing.
 *
 *   An earlier draft did accept here, and that was wrong in a way worth spelling
 *   out. Clicking a link in an email is not the same act as completing
 *   registration: at this moment the invitee has a session but NO PASSWORD, so
 *   accepting would flip their membership to ACTIVE and mark the invitation
 *   ACCEPTED while leaving them unable to ever sign in again. The invitation would
 *   be spent, the account would look live, and the person would be locked out with
 *   no supported path back — an email preview fetch or a security scanner
 *   following the link would be enough to cause it.
 *
 *   Acceptance now happens in the password-completion action, only after
 *   auth.updateUser({ password }) succeeds. This route's sole job is to establish
 *   who the invitee is; /invitations/complete is where they become a real account.
 *
 * WHY THE TOKEN IS NEVER LOGGED
 *   `token_hash` is a single-use bearer credential. It is read into a local, passed
 *   directly to verifyOtp, and never interpolated into a log line, an error
 *   message, a redirect URL, or a thrown value. Every failure below logs a fixed
 *   static string.
 */

/**
 * Where a verified invitee is sent to set their password and finish.
 *
 * This route requires an authenticated session, which the verifyOtp() call above
 * has just established. It is deliberately NOT on the proxy's public allowlist.
 */
const COMPLETION_PATH = "/invitations/complete";

/**
 * Where every failure lands, without exception.
 *
 * ONE destination for all of: a missing token, a wrong `type`, an expired token,
 * an already-consumed token, and a forged token.
 *
 * Collapsing them is deliberate. Distinguishing them would let an unauthenticated
 * caller probe token validity by watching which page they land on, and would
 * confirm whether a given invitation exists and how far through its lifecycle it
 * is.
 */
const FAILURE_PATH = "/invitations/error";

/**
 * The ONLY OTP type this callback will process.
 *
 * Checked strictly. Supabase issues token hashes for `recovery`, `magiclink`,
 * `signup`, and `email_change` through the same verifyOtp surface; accepting an
 * arbitrary `type` would let a token minted for one of those flows be replayed
 * against the invitation flow, establishing a session on a route whose whole
 * purpose is to admit someone into a Retailer organization.
 */
const INVITE_TYPE = "invite";

/**
 * Builds an internal redirect.
 *
 * The path is always one of the two module constants above — never a value read
 * from the query string, a header, or the database. No `next`, `redirectTo`, or
 * `returnUrl` parameter is read anywhere in this file, and the invite template
 * deliberately does not emit one, so there is no caller-controlled destination to
 * sanitize: an open redirect is impossible here because no user input ever reaches
 * a redirect target.
 *
 * Cloning `request.nextUrl` and replacing the pathname keeps the redirect strictly
 * same-origin. `url.search = ""` drops the token from the outgoing URL, so it
 * cannot survive into browser history, a referrer header, or a server access log.
 * This mirrors redirectPreservingCookies() in lib/supabase/proxy.ts.
 */
function redirectTo(request: NextRequest, pathname: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return url;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type");

  // Shape screening before any network call. A link that does not carry both
  // parameters, or carries a `type` this route does not handle, is not something
  // to hand to the Auth server.
  if (typeof tokenHash !== "string" || tokenHash.length === 0 || type !== INVITE_TYPE) {
    return NextResponse.redirect(redirectTo(request, FAILURE_PATH));
  }

  // createClient() wires cookie writes through the Route Handler's cookie store,
  // which is what lets verifyOtp() persist the new session. This is the ordinary
  // publishable-key server client: the invitee authenticates as themselves, and
  // the service-role client has no part in acceptance.
  const supabase = await createClient();

  try {
    // Exchanges the single-use hash for a session and writes the auth cookies.
    // The token is passed straight through and is not stored, echoed, or logged.
    const { error } = await supabase.auth.verifyOtp({
      type: INVITE_TYPE,
      token_hash: tokenHash,
    });

    if (error) {
      // The Supabase error is deliberately not bound, inspected, or logged: its
      // message and status distinguish "expired" from "already used" from
      // "invalid", which is precisely the discrimination this route refuses to
      // expose. It can also echo the submitted token.
      console.error("invitations/accept: token verification failed");
      return NextResponse.redirect(redirectTo(request, FAILURE_PATH));
    }
  } catch {
    // A transport-level throw can carry request URLs and headers — which on this
    // request include the token. Nothing is bound or logged.
    console.error("invitations/accept: token verification threw");
    return NextResponse.redirect(redirectTo(request, FAILURE_PATH));
  }

  // A session now exists for the invitee, and that is ALL this route has done. The
  // invitation is still PENDING and the membership is still INVITED. Nothing has
  // been consumed that a retry could not repeat, and nothing has been granted that
  // a password failure would leave dangling.
  return NextResponse.redirect(redirectTo(request, COMPLETION_PATH));
}
