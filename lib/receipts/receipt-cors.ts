/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client, no Deno API.
 *
 * THE ONE CORS POLICY for the `submit-receipt` Edge Function, and the only place that
 * builds a `Response` for it. Written dependency-free for the same reason
 * ./receipt-file.ts and ./receipt-submission-flow.ts are: Deno imports it directly from
 * supabase/functions/submit-receipt/index.ts, and Node imports it from
 * ./receipt-cors.test.ts, so the policy that ships is the policy that is tested.
 *
 * ============================================================================
 * WHY THIS MODULE EXISTS
 * ============================================================================
 * A Flutter Web build calling the hosted function from a browser origin is subject to
 * CORS; the Flutter mobile build is not. The preflight succeeded and the POST that
 * followed was blocked, because the allowed-request-header list named only
 * `authorization` and `content-type` while the Supabase client also sends `apikey` and
 * `x-client-info` on every call. A preflight that omits ONE requested header fails the
 * whole check, and the browser discards the real response — the function ran, the
 * receipt was never seen.
 *
 * The second half of the same defect was structural: the header map was a module-level
 * constant that only the `json()` helper spread. Anything that returned a `Response`
 * without going through it — including an unexpected throw, which the runtime turns into
 * a bare 500 — reached the browser with no CORS headers at all and was therefore
 * invisible to the client. Building EVERY response here, including the preflight, is
 * what makes "some responses carry the headers" impossible to reintroduce.
 *
 * ============================================================================
 * WHY THIS IS NOT AN AUTHORIZATION CHANGE
 * ============================================================================
 * CORS is a browser policy about which ORIGIN may read a response. It is not an
 * authentication or authorization mechanism, and nothing here grants access to anything:
 * the gateway still rejects an unverified JWT (`verify_jwt = true`), the function still
 * revalidates the token with `auth.getUser()`, and the database still decides every
 * question about identity, Retailer, shop assignment and status.
 *
 * `Access-Control-Allow-Origin: *` is safe for THIS endpoint specifically because it
 * carries NO ambient authority. It authenticates from an `Authorization: Bearer` header,
 * which a browser will not attach to a cross-site request on its own, and it reads no
 * cookie. A hostile page can already send this request from a server; being able to send
 * it from a browser tab gains an attacker nothing it does not have to supply a stolen
 * token to obtain.
 *
 * `Access-Control-Allow-Credentials: true` is DELIBERATELY ABSENT, and asserted absent by
 * ./receipt-cors.test.ts. It is the one header that would make the wildcard origin
 * dangerous — it tells the browser to attach ambient credentials to a cross-origin
 * request and to let the calling page read the reply. The Flutter client is bearer-token
 * only and needs no cookie; a browser also refuses `*` together with credentials, so
 * enabling it would break the very clients this module exists to unblock.
 */

/**
 * Any origin. Not a variable and not echoed from the request: an echoed `Origin` is how
 * a wildcard policy becomes a credentialed one by accident.
 */
export const CORS_ALLOWED_ORIGIN = "*";

/**
 * The methods the endpoint answers. `POST` is the submission itself; `OPTIONS` is the
 * preflight. Nothing else is listed, so a browser will not even attempt a `GET`, `PUT` or
 * `DELETE` — and the function refuses them independently anyway.
 */
export const CORS_ALLOWED_METHODS = ["POST", "OPTIONS"] as const;

/**
 * The request headers a browser may send.
 *
 * A preflight fails if a single requested header is missing from this list, so it must
 * cover everything a real Supabase client attaches, not merely everything this function
 * reads:
 *
 *   authorization         the caller's access token — the only one the function reads
 *   apikey                the publishable key; the Supabase JS and Dart clients send it
 *                         on every request, including `functions.invoke`
 *   x-client-info         the client library's name and version, sent unconditionally
 *   content-type          multipart/form-data with its boundary
 *   x-supabase-api-version  sent by recent client versions during API version pinning
 *   x-region              sent by `functions.invoke` when a region is selected
 *
 * Listing a header here does NOT make the function read it. `apikey`, `x-client-info`,
 * `x-supabase-api-version` and `x-region` are permitted through the preflight and then
 * ignored: identity comes from `authorization` and from `auth.getUser()`, never from a
 * header a client can set freely.
 */
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
 * every submission after the first without pinning a stale policy for long.
 */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 3600;

/**
 * The CORS headers, as a FRESH object each call so no caller can mutate a shared map and
 * change the policy for every later response.
 */
export function receiptCorsHeaders(): Record<string, string> {
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
 * Returned for `OPTIONS` before authentication is considered, which is required — a
 * browser sends a preflight WITHOUT the `Authorization` header, so answering it with a
 * 401 would block every cross-origin caller before the real request was ever attempted.
 * It discloses nothing: the reply is the same for every caller and says only which
 * methods and headers the endpoint accepts.
 */
export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: receiptCorsHeaders() });
}

/**
 * Every non-preflight response. There is no path to a JSON reply that skips this, so a
 * success, a refusal, a duplicate, an upload failure and an unexpected error all carry
 * identical CORS headers and are all equally readable by the browser that asked.
 *
 * The payload is the caller's to choose; this function adds nothing to it and reads
 * nothing from it — keeping the closed response vocabulary the Edge Function's own
 * concern, where lib/receipts/receipt-edge-function-safety.test.ts enforces it.
 */
export function corsJsonResponse(
  payload: Record<string, unknown>,
  httpStatus: number,
): Response {
  return new Response(JSON.stringify(payload), {
    status: httpStatus,
    headers: { ...receiptCorsHeaders(), "Content-Type": "application/json" },
  });
}
