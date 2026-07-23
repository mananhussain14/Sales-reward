import { NextResponse, type NextRequest } from "next/server";
import {
  hashInvitationToken,
  isValidRawToken,
} from "@/lib/invitations/existing-user-token";
import {
  STAFF_INVITE_COOKIE,
  staffInviteCookieOptions,
} from "@/lib/staff/staff-invite-cookie";

/**
 * Staff invitation TOKEN INTAKE — hashes and stashes, then gets out of the URL
 * immediately.
 *
 * A Route Handler (not a page) because its whole job is a side effect + redirect, and
 * because only a Route Handler / Server Action / proxy may set a cookie. Runs on the
 * Node runtime, so it uses Node crypto via hashInvitationToken().
 *
 * WHAT IT DOES
 *   1. Reads `token` (the RAW invitation token) and validates its URL-safe shape.
 *   2. Hashes it SERVER-SIDE (SHA-256, 64 lowercase hex). The raw token is never
 *      stored, logged, or forwarded.
 *   3. Sets the hash in a short-lived HttpOnly, SameSite=Lax, path-scoped,
 *      Secure-in-production cookie.
 *   4. Redirects to the CLEAN URL `/invitations/staff` (query stripped), so the raw
 *      token leaves the address bar, browser history, and any referrer at once.
 *
 * A `Referrer-Policy: no-referrer` header is set on every response so the
 * token-bearing URL cannot leak as a referrer to the destination page.
 *
 * NOTHING IS LOGGED HERE. Not the token, not the hash, not the failure reason — every
 * failure takes the same silent path to the same destination, because a log line that
 * distinguishes "malformed" from "absent" is one more place the flow's shape leaks.
 *
 * THE TOKEN IS A DISCOVERY POINTER, NOT A CREDENTIAL. It says WHICH invitation a
 * clicker is acting on; it authenticates no one. Both the resolver and the acceptance
 * RPC additionally require an authenticated session whose CONFIRMED email exactly
 * matches the invitation's address, so a leaked or forwarded token is inert on its own.
 *
 * This mirrors /invitations/existing/enter exactly, with its own cookie name and path
 * so the two invitation flows can never overwrite one another.
 */

const CLEAN_PATH = "/invitations/staff";
const FAILURE_PATH = "/invitations/error";

/** Same-origin internal redirect URL with the query dropped. */
function internalUrl(request: NextRequest, pathname: string): URL {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  return url;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rawToken = request.nextUrl.searchParams.get("token");

  if (!isValidRawToken(rawToken)) {
    // A missing or malformed token is reported identically to every other failure.
    const response = NextResponse.redirect(internalUrl(request, FAILURE_PATH));
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }

  // Hashed here and only here. The raw value is not interpolated into a log line, a
  // header, a redirect, or a thrown value.
  const tokenHash = hashInvitationToken(rawToken);

  const response = NextResponse.redirect(internalUrl(request, CLEAN_PATH));
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(STAFF_INVITE_COOKIE, tokenHash, staffInviteCookieOptions());
  return response;
}
