import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Staff account RECOVERY callback — TOKEN VERIFICATION ONLY.
 *
 * A Route Handler rather than a page, because its whole job is a side effect and a
 * redirect: it never renders anything, and a page that mutated state during render would
 * re-run on every refresh and prefetch.
 *
 * WHY IT EXISTS
 *   An invited staff member whose Auth row exists but cannot be signed in to — invited
 *   earlier and never confirmed, or carrying no password — used to be shown an ordinary
 *   sign-in screen they could not use, with no way forward. They are now sent a password
 *   recovery email instead, and this is where that email's link lands.
 *
 *   Recovery rather than "let the invitation set a password" is the whole point: an
 *   emailed recovery link proves CURRENT control of the invited mailbox, whereas the
 *   invitation token may be old, forwarded, or leaked. See
 *   lib/staff/staff-account-state.ts.
 *
 * WHAT IT DOES
 *   1. Reads `token_hash` and `type=recovery` from the query string — ordinary
 *      parameters, because supabase/templates/recovery.html emits {{ .TokenHash }}
 *      rather than GoTrue's default fragment-based {{ .ConfirmationURL }}.
 *   2. Exchanges the hash for a session via verifyOtp(), SERVER-SIDE. The token never
 *      enters client JavaScript.
 *   3. Redirects to /invitations/staff/set-password.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — AND THIS IS THE POINT
 *   IT DOES NOT SET A PASSWORD, and IT DOES NOT ACCEPT THE INVITATION.
 *   accept_retailer_staff_invitation() is not called here and nothing is granted.
 *
 *   At this moment the person has a session but still no usable password, exactly as in
 *   /invitations/accept — and for the same reason that route documents: accepting here
 *   would spend the invitation and flip a membership live while leaving them unable to
 *   sign in again. An email preview fetch or a security scanner following the link would
 *   be enough to cause it.
 *
 *   Acceptance still happens afterwards, through the ordinary signed-in path on
 *   /invitations/staff, which requires the session's CONFIRMED email to equal the
 *   invitation's canonical address — decided in SQL, not here.
 *
 * THE INVITATION COOKIE IS UNTOUCHED. This route neither reads nor writes it. It stays
 * where /invitations/staff/enter put it, scoped HttpOnly to /invitations/staff — which
 * is why this route lives under that path: a recovery landing anywhere else would arrive
 * without the invitation hash and strand the person a second time.
 *
 * NO OPEN REDIRECT IS POSSIBLE. Both destinations are fixed module constants. No `next`,
 * `redirectTo` or `returnUrl` parameter is read anywhere in this file, and the recovery
 * template emits none — so no user input ever reaches a redirect target.
 *
 * WHY THE TOKEN IS NEVER LOGGED
 *   `token_hash` is a single-use bearer credential. It is read into a local, passed
 *   directly to verifyOtp, and never interpolated into a log line, an error message, a
 *   redirect URL, or a thrown value. Every failure logs a fixed static string.
 */

/** Where a verified person sets their new password. Requires the session established here. */
const SET_PASSWORD_PATH = "/invitations/staff/set-password";

/**
 * Where every failure lands, without exception — a missing token, a wrong `type`, an
 * expired token, an already-consumed token, and a forged token alike.
 *
 * Collapsing them is deliberate. Distinguishing them would let an unauthenticated caller
 * probe token validity by watching which page they land on.
 */
const FAILURE_PATH = "/invitations/error";

/**
 * The ONLY OTP type this callback will process.
 *
 * Checked strictly. Supabase issues token hashes for `invite`, `magiclink`, `signup` and
 * `email_change` through the same verifyOtp surface; accepting an arbitrary `type` would
 * let a token minted for one of those flows be replayed here to establish a session on a
 * route whose next step is setting a password.
 */
const RECOVERY_TYPE = "recovery";

/**
 * Builds an internal redirect. Cloning `request.nextUrl` and replacing the pathname keeps
 * it strictly same-origin; `url.search = ""` drops the token from the outgoing URL so it
 * cannot survive into browser history, a referrer header, or a server access log.
 */
function redirectTo(request: NextRequest, pathname: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return url;
}

/** Every response carries no-referrer, so the token-bearing URL cannot leak onward. */
function withNoReferrer(response: NextResponse): NextResponse {
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type");

  // Shape screening before any network call. A link that does not carry both parameters,
  // or carries a `type` this route does not handle, is not something to hand to Auth.
  if (typeof tokenHash !== "string" || tokenHash.length === 0 || type !== RECOVERY_TYPE) {
    return withNoReferrer(NextResponse.redirect(redirectTo(request, FAILURE_PATH)));
  }

  // The ordinary publishable-key server client, wired to this request's cookie store so
  // verifyOtp() can persist the new session. The service-role client has no part in
  // recovery — the person authenticates as themselves.
  const supabase = await createClient();

  try {
    const { error } = await supabase.auth.verifyOtp({
      type: RECOVERY_TYPE,
      token_hash: tokenHash,
    });

    if (error) {
      // The Supabase error is deliberately not bound, inspected, or logged: its message
      // and status distinguish "expired" from "already used" from "invalid", which is
      // precisely the discrimination this route refuses to expose. It can also echo the
      // submitted token.
      console.error("invitations/staff/recover: token verification failed");
      return withNoReferrer(NextResponse.redirect(redirectTo(request, FAILURE_PATH)));
    }
  } catch {
    // A transport-level throw can carry request URLs and headers — which on this request
    // include the token. Nothing is bound or logged.
    console.error("invitations/staff/recover: token verification threw");
    return withNoReferrer(NextResponse.redirect(redirectTo(request, FAILURE_PATH)));
  }

  // A session now exists, and that is ALL this route has done. No password has been set,
  // the invitation is still PENDING, and nothing has been granted that a later failure
  // would leave dangling.
  return withNoReferrer(NextResponse.redirect(redirectTo(request, SET_PASSWORD_PATH)));
}
