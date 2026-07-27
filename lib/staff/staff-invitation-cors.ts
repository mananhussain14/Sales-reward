/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client, no Deno API,
 * no Node API.
 *
 * THE ONE CORS POLICY for the `send-retailer-staff-invitation` Edge Function, and the
 * only place that builds a `Response` for it. It is the SAME policy
 * lib/receipts/receipt-cors.ts states for `submit-receipt`, for the same reasons, and
 * ./staff-invitation-cors.test.ts asserts the two header maps are byte-identical — so
 * the two mobile entry points cannot drift into answering preflights differently.
 *
 * (It is a separate module rather than an import of the receipts one because that module
 * is documented, tested and deployed as submit-receipt's policy; a runtime dependency
 * from a staff function on a receipts module would couple two independently deployed
 * functions, and rewriting the receipts module into a shared one would change code that
 * is already live in a deployed function this milestone must not touch. The cross-module
 * equality test is what removes the cost of the duplication.)
 *
 * ============================================================================
 * WHAT THE HEADER LIST MUST COVER
 * ============================================================================
 * A preflight fails if a SINGLE requested header is missing from the allow-list, and the
 * browser then discards the real response — the function runs, the invitation is sent,
 * and the client sees nothing. A real Supabase client (JS or Dart) attaches `apikey` and
 * `x-client-info` on every call including `functions.invoke`, plus
 * `x-supabase-api-version` and `x-region` on recent versions. All of them are listed.
 *
 * Listing a header does NOT make the function read it. Identity comes from
 * `authorization` and from `auth.getUser()`, never from a header a client sets freely.
 *
 * ============================================================================
 * WHY THIS IS NOT AN AUTHORIZATION CHANGE
 * ============================================================================
 * CORS is a browser policy about which ORIGIN may READ a response. Nothing here grants
 * access to anything: the gateway still rejects an unverified JWT (`verify_jwt = true`),
 * the function still revalidates the token with `auth.getUser()`, and
 * reserve_retailer_staff_invitation() still decides every question about identity,
 * Retailer, permission and shop ownership under the caller's own token.
 *
 * `Access-Control-Allow-Origin: *` is safe for THIS endpoint specifically because it
 * carries NO AMBIENT AUTHORITY. It authenticates from an `Authorization: Bearer` header,
 * which a browser will not attach to a cross-site request on its own, and IT READS NO
 * COOKIE — the invitation send is deliberately not a cookie-authenticated request. A
 * hostile page can already issue this request from a server; being able to issue it from
 * a browser tab gains an attacker nothing it does not need a stolen token to obtain.
 *
 * This also covers, without an origin allow-list to maintain: a Flutter Web build on a
 * localhost development port, the configured production web origin, and future Flutter
 * native calls (which are not subject to CORS at all).
 *
 * `Access-Control-Allow-Credentials: true` is DELIBERATELY ABSENT, and asserted absent
 * by the test. It is the one header that would make the wildcard origin dangerous — it
 * tells the browser to attach ambient credentials cross-origin and to let the calling
 * page read the reply. A browser also refuses `*` together with credentials, so enabling
 * it would break the very clients this policy exists to serve.
 */

/**
 * Any origin. Not a variable and not echoed from the request: an echoed `Origin` is how
 * a wildcard policy becomes a credentialed one by accident.
 */
export const CORS_ALLOWED_ORIGIN = "*";

/**
 * The methods the endpoint answers. `POST` is the send itself; `OPTIONS` is the
 * preflight. Nothing else is listed, and the function refuses everything else
 * independently anyway.
 */
export const CORS_ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/** The request headers a browser may send. See this module's header for why each. */
export const CORS_ALLOWED_REQUEST_HEADERS = [
  "authorization",
  "apikey",
  "x-client-info",
  "content-type",
  "x-supabase-api-version",
  "x-region",
] as const;

/**
 * How long a browser may cache the preflight. One hour removes a second round trip from
 * every send after the first without pinning a stale policy for long.
 */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 3600;

/**
 * The CORS headers, as a FRESH object each call so no caller can mutate a shared map and
 * change the policy for every later response.
 */
export function staffInvitationCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": CORS_ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS.join(", "),
    "Access-Control-Allow-Headers": CORS_ALLOWED_REQUEST_HEADERS.join(", "),
    "Access-Control-Max-Age": String(CORS_PREFLIGHT_MAX_AGE_SECONDS),
  };
}

/**
 * The preflight answer: 204, no body, the full policy.
 *
 * Returned for `OPTIONS` BEFORE authentication is considered, which is required — a
 * browser sends a preflight without the `Authorization` header, so answering it with a
 * 401 would block every cross-origin caller before the real request was ever attempted.
 * It discloses nothing: the reply is identical for every caller and says only which
 * methods and headers the endpoint accepts.
 */
export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: staffInvitationCorsHeaders() });
}

/**
 * Every non-preflight response. There is no path to a JSON reply that skips this, so a
 * success, a refusal, a conflict, a delivery failure, the partial-success outcome and an
 * unexpected error all carry identical CORS headers and are all equally readable by the
 * browser that asked.
 *
 * `Cache-Control: no-store` because every reply here is the result of a write attempt
 * against one operator's own Retailer; nothing about it may be reused for a later
 * request or by an intermediary.
 *
 * The payload is the caller's to choose; this function adds nothing to it and reads
 * nothing from it — keeping the closed response vocabulary the contract module's
 * concern, where ./staff-invitation-delivery-contract.ts defines it.
 */
export function corsJsonResponse(
  payload: Record<string, unknown>,
  httpStatus: number,
): Response {
  return new Response(JSON.stringify(payload), {
    status: httpStatus,
    headers: {
      ...staffInvitationCorsHeaders(),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
