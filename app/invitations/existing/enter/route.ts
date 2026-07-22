import { NextResponse, type NextRequest } from "next/server";
import { hashInvitationToken, isValidRawToken } from "@/lib/invitations/existing-user-token";
import {
  EXISTING_USER_INVITE_COOKIE,
  existingUserInviteCookieOptions,
} from "@/lib/invitations/existing-user-cookie";

/**
 * Existing-user invitation TOKEN INTAKE — hashes and stashes, then gets out of the
 * URL immediately.
 *
 * A Route Handler (not a page) because its whole job is a side effect + redirect,
 * and because only a Route Handler/Action/middleware may set a cookie. Runs on the
 * Node runtime, so it uses Node crypto via hashInvitationToken().
 *
 * WHAT IT DOES
 *   1. Reads `token` (the RAW invitation token) and validates its URL-safe shape.
 *   2. Hashes it SERVER-SIDE (SHA-256, 64 lowercase hex). The raw token is never
 *      stored, logged, or forwarded.
 *   3. Sets the hash in a short-lived HttpOnly, SameSite=Lax, path-scoped,
 *      Secure-in-production cookie.
 *   4. Redirects to the CLEAN URL `/invitations/existing` (query stripped), so the
 *      raw token leaves the address bar, history, and any referrer at once.
 *
 * A `Referrer-Policy: no-referrer` header is set on every response so the token-
 * bearing URL cannot leak as a referrer to the destination page.
 *
 * The token is a DISCOVERY POINTER, not a credential: holding it grants nothing —
 * acceptance still requires an authenticated session whose verified email matches.
 */

const CLEAN_PATH = "/invitations/existing";
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

  // Hashed here and only here. The raw value is not interpolated into a log line,
  // a header, a redirect, or a thrown value.
  const tokenHash = hashInvitationToken(rawToken);

  const response = NextResponse.redirect(internalUrl(request, CLEAN_PATH));
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(
    EXISTING_USER_INVITE_COOKIE,
    tokenHash,
    existingUserInviteCookieOptions(),
  );
  return response;
}
