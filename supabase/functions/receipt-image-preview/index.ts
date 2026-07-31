// Supabase Edge Function: receipt-image-preview
//
// Mints a SHORT-LIVED, PRIVATE signed URL for one receipt image, for the Sales Staff member
// who submitted it and for nobody else.
//
// WHY A SIGNED URL RATHER THAN PROXYING THE BYTES
//   A proxy would push up to 10 MB per view through this runtime, hold the service-role key
//   on the highest-traffic path in the feature, and defeat the client's image cache — every
//   re-render would re-authenticate and re-download. A signed URL moves the bytes directly
//   from Storage to the device after exactly one authorization decision.
//
// 120 SECONDS. Long enough to fetch a 10 MB photograph over a poor in-store connection, short
//   enough that a URL leaked through a log, a screenshot or a shared debug session is dead
//   almost immediately. THE URL IS A FETCH CREDENTIAL, NOT A DISPLAY CREDENTIAL: the client
//   fetches the bytes once inside the window and holds the decoded image for the review
//   screen, so expiry is invisible in normal use. On any fetch failure — or when the app
//   resumes and the image is no longer in memory — the client calls this endpoint again. It
//   must never persist the URL to disk, to logs, to an image-cache key, or to any state that
//   outlives the screen.
//
// TWO RPCs, DELIBERATELY SPLIT, SO NO OBJECT PATH IS EVER REACHABLE BY `authenticated`
//   1. assert_my_receipt_extraction_access runs UNDER THE CALLER'S OWN TOKEN and returns a
//      BOOLEAN. Its return type has no room for a bucket or a path, so nothing can leak
//      through it even by mistake.
//   2. get_receipt_object_reference runs under service_role and is not executable by any
//      browser role.
//   This is stricter than the existing reserve_receipt_submission precedent, which does
//   return a bucket and path to `authenticated` for the upload path.
//
// VENDOR, RETAILER OWNER AND RETAILER MANAGER ARE REFUSED STRUCTURALLY. The access predicate
//   resolves RECEIPT_EXTRACTION_REVIEW, which is mapped to SALES_STAFF alone, and then also
//   requires submitted_by_profile_id = auth.uid(). No role code appears in this file.
//
// NO PUBLIC URL, NO LISTING, NO DELETION. There is no getPublicUrl, no .list( and no
//   .remove( in this file; lib/receipts/receipt-extraction-safety.test.ts asserts their
//   absence. The bucket stays private, no storage policy is created, and no bucket is added.
//
// THE URL IS NEVER LOGGED. It is bound to one const, placed in the response, and never
//   passed to console.*. logFailure takes a fixed category string only.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.6";

import {
  corsJsonResponse,
  corsPreflightResponse,
} from "../../../lib/receipts/receipt-cors.ts";
import {
  parseExtractionRequest,
  type ExtractionResponseStatus,
} from "../../../lib/receipts/receipt-extraction-request-contract.ts";

const ACCESS_RPC = "assert_my_receipt_extraction_access" as const; // caller's own token
const OBJECT_REFERENCE_RPC = "get_receipt_object_reference" as const; // service role

const INSUFFICIENT_PRIVILEGE = "42501";
const RPC_TIMEOUT_MS = 5_000;

/** The signed-URL lifetime, in seconds. See the module header for the reasoning. */
const SIGNED_URL_TTL_SECONDS = 120;

function logFailure(category: string): void {
  console.error(`[receipt-image-preview] ${category}`);
}

/**
 * Every JSON reply, with caching suppressed.
 *
 * `Cache-Control: no-store` and `Pragma: no-cache` are load-bearing rather than decorative:
 * the body carries a LIVE CAPABILITY, and a cached copy of this response would keep serving
 * a URL after the 120-second window had closed — extending the credential's life past the
 * only thing that bounds it.
 *
 * The headers are added to the shared helper's Response rather than by constructing one, so
 * the CORS policy stays defined in exactly one place and this file adds no `new Response(`.
 */
function json(
  status: ExtractionResponseStatus,
  httpStatus: number,
  extra?: Record<string, unknown>,
): Response {
  const response = corsJsonResponse({ status, ...extra }, httpStatus);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Pragma", "no-cache");
  return response;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPublishableKey(): string | null {
  return (
    nonEmptyString(Deno.env.get("SUPABASE_PUBLISHABLE_KEY")) ??
    nonEmptyString(Deno.env.get("SUPABASE_ANON_KEY"))
  );
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const row = data[0];
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
}

async function handleRequest(request: Request): Promise<Response> {
  // ---- 1. Method and CORS ---------------------------------------------------
  if (request.method === "OPTIONS") return corsPreflightResponse();
  if (request.method !== "POST") return json("invalid", 405, { reason: "method-not-allowed" });

  // ---- 2. Required server configuration -------------------------------------
  const supabaseUrl = nonEmptyString(Deno.env.get("SUPABASE_URL"));
  const publishableKey = readPublishableKey();
  const serviceRoleKey = nonEmptyString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  if (supabaseUrl === null || publishableKey === null || serviceRoleKey === null) {
    logFailure("configuration is incomplete");
    return json("unavailable", 503);
  }

  // ---- 3. Bearer-token extraction -------------------------------------------
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") ?? "");
  if (bearer === null) return json("unauthenticated", 401);
  const accessToken = bearer[1];

  const asCaller: SupabaseClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  // ---- 4. auth.getUser revalidation -----------------------------------------
  const userResult = await asCaller.auth.getUser(accessToken).catch(() => null);
  if (userResult === null || userResult.error || !userResult.data?.user) {
    return json("unauthenticated", 401);
  }

  // ---- 5. Strict body parsing ------------------------------------------------
  const rawBody = await request.text().catch(() => null);
  if (rawBody === null) {
    logFailure("could not read the request body");
    return json("invalid", 400, { reason: "malformed-body" });
  }
  const parsed = parseExtractionRequest(rawBody);
  if (parsed.status !== "ok") return json("invalid", 400, { reason: parsed.reason });
  const submissionId = parsed.request.submissionId;

  // ---- 6. Ownership, under the CALLER'S OWN TOKEN, BEFORE any service-role use
  const access = await asCaller
    .rpc(ACCESS_RPC, { p_submission_id: submissionId })
    .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
    .then((r) => r, () => null);

  if (access === null) {
    logFailure("access check transport");
    return json("unavailable", 503);
  }
  if (access.error) {
    // Only the SQLSTATE is read. 42501 means "not an authorized Sales Staff member at all".
    if ((access.error as { code?: string }).code === INSUFFICIENT_PRIVILEGE) {
      return json("denied", 403);
    }
    logFailure("access check rpc-error");
    return json("unavailable", 503);
  }
  if (access.data !== true) {
    // Unknown, another Sales Staff member's, another Retailer's, RESERVED, UPLOAD_FAILED —
    // all byte-identical. A distinguishable refusal would confirm somebody else's receipt.
    return json("not-found", 404);
  }

  // ---- 7. The object reference, under service_role only ----------------------
  const asService: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const reference = await asService
    .rpc(OBJECT_REFERENCE_RPC, { p_submission_id: submissionId })
    .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
    .then((r) => r, () => null);

  if (reference === null || reference.error) {
    logFailure("object reference lookup failed");
    return json("unavailable", 503);
  }

  const row = firstRow(reference.data);
  const bucket = nonEmptyString(row?.storage_bucket);
  const objectPath = nonEmptyString(row?.storage_object_path);

  if (bucket === null || objectPath === null) {
    // Authorized, but no stored object. Reported as not-found, identically to every other
    // unreadable case.
    return json("not-found", 404);
  }

  // ---- 8. Mint the short-lived signed URL ------------------------------------
  const signed = await asService.storage
    .from(bucket)
    .createSignedUrl(objectPath, SIGNED_URL_TTL_SECONDS)
    .then((r) => r, () => null);

  if (signed === null || signed.error || !signed.data?.signedUrl) {
    // A Storage error can name the bucket, the key, the account and a request id. It is not
    // bound, returned or logged.
    logFailure("signed url could not be created");
    return json("unavailable", 503);
  }

  const url = signed.data.signedUrl;

  // The URL and the expiry, and nothing else. No bucket, no object path, no MIME type, no
  // file hash, no submission id echo.
  return json("ok", 200, { url, expires_in_seconds: SIGNED_URL_TTL_SECONDS });
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    return await handleRequest(request);
  } catch {
    logFailure("unexpected error");
    return json("unavailable", 503);
  }
});
