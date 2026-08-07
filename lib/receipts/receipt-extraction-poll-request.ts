// SERVER-ONLY MODULE.
//
// The web portal's ONE client of the shared Edge Function `get-receipt-extraction`,
// called with the signed-in Sales Staff member's own access token.
//
// It is the deliberate twin of ./receipt-extraction-request.ts and follows that module's
// posture line for line: one door, on the server, holding one key.
//
// ============================================================================
// CALLING THIS ENDPOINT IS WHAT FINISHES A READING
// ============================================================================
// This is not a status read. `get-receipt-extraction` claims nothing, but for an attempt
// that is already PROCESSING it polls the provider operation and records the terminal
// SUCCEEDED or FAILED row through the service-role worker RPCs — inside the function,
// never here. So this module is the web's half of a contract the backend already
// implements: the reading completes because somebody calls this, and until this milestone
// nobody on the web ever did.
//
// The alternative — reading receipt_extractions from the browser — would be wrong twice
// over. The table is not selectable by `authenticated` at all, and even if it were, a
// direct read would never finalize the attempt; it would only observe a row that stays
// PROCESSING until the reaper marks it WORKER_ABANDONED.
//
// ============================================================================
// WHAT THIS MODULE CANNOT DO
// ============================================================================
//   * It does not construct a service-role client — `createAdminClient` does not appear.
//   * It does not read SUPABASE_SERVICE_ROLE_KEY, or any Azure value, or any secret.
//   * It writes NO table and names none. There is no `.from(` here.
//   * It touches no Storage bucket and never sees an object path.
//   * It NEVER requests a new extraction. There is no call to the request function and no
//     retry of any kind on this path: a poll that fails is reported as a poll that failed,
//     because creating an attempt spends one of a person's three and must stay a
//     deliberate act.
//   * It returns only values that survived ./receipt-extraction-normalization.ts, which
//     has no field for a provider, an operation id, a claim token, an expiry, a bucket, an
//     object path, a file hash or an internal failure code.
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/env/supabase";
import { normalizeExtractionView } from "@/lib/receipts/receipt-extraction-normalization";
import type { ExtractionView } from "@/lib/receipts/receipt-extraction-normalization";
import type { ExtractionPollOutcome } from "@/lib/receipts/receipt-extraction-polling";

/**
 * The Edge Function's name, and the path shape the gateway serves it on.
 *
 * DECLARED EXACTLY ONCE in the whole web application, exactly as the request function's
 * name is. lib/receipts/receipt-submission-extraction-wiring.test.ts asserts the config
 * agreement for both, so a rename fails the build rather than producing a runtime 404 that
 * looks identical to a reading that never finished.
 */
const GET_EXTRACTION_FUNCTION = "get-receipt-extraction" as const;

/** The status the endpoint reports when the request was understood and acted on. */
const OK_STATUS = "ok" as const;

/** Sanitized operator logging. No ids, tokens, URLs, bodies, or error objects. */
function logExtractionPollFailure(category: string): void {
  console.error(`[receipts-extraction-poll] ${category}`);
}

/**
 * Polls one of the caller's own receipts, and lets the backend finalize it.
 *
 * @param submissionId the canonical submission id. It is re-authorized inside the Edge
 *   Function and again in PostgreSQL from `auth.uid()`; naming somebody else's receipt
 *   here yields `not-found`, not their data.
 */
export async function pollReceiptExtraction(
  submissionId: string,
): Promise<ExtractionPollOutcome<ExtractionView>> {
  let url: string;
  let publishableKey: string;
  try {
    ({ url, publishableKey } = getSupabaseEnv());
  } catch {
    logExtractionPollFailure("supabase configuration is incomplete");
    return { status: "unavailable" };
  }

  const supabase = await createClient();

  // The token is fetched to be FORWARDED, not believed — the same reasoning the request
  // module documents at length. The gateway verifies the JWT, the function revalidates it
  // with auth.getUser(), and assert_my_receipt_extraction_access() decides ownership.
  const sessionResult = await Promise.resolve(supabase.auth.getSession()).catch(
    () => null,
  );
  const accessToken = sessionResult?.data?.session?.access_token;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    // A lapsed session is reported as `unauthorized` rather than `unavailable`: the loop
    // must STOP for this one, because polling again cannot fix a signed-out caller.
    logExtractionPollFailure("no access token for the caller");
    return { status: "unauthorized" };
  }

  let response: Response;
  try {
    response = await fetch(`${url}/functions/v1/${GET_EXTRACTION_FUNCTION}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        // A public value. The service-role key is not read by this process at all.
        apikey: publishableKey,
        "Content-Type": "application/json",
      },
      credentials: "omit",
      // THE ENTIRE REQUEST BODY. One key, exactly as the shared contract allows; the
      // endpoint refuses an unknown key with a 400 rather than ignoring it.
      body: JSON.stringify({ submission_id: submissionId }),
      // A poll must never be served from a cache: a cached PROCESSING would loop forever
      // against a reading that finished minutes ago.
      cache: "no-store",
    });
  } catch {
    // A transport throw can carry the request headers, which include the access token.
    // Nothing is bound, inspected, or logged. Transient, so the loop may continue.
    logExtractionPollFailure("poll transport");
    return { status: "unavailable" };
  }

  if (response.status === 401 || response.status === 403) {
    // Signed out, or no longer a Sales Staff member of that Retailer. Polling again
    // cannot change either, so this ends the loop.
    logExtractionPollFailure("poll refused");
    return { status: "unauthorized" };
  }

  if (response.status === 404) {
    // Unknown receipt, somebody else's receipt, or no attempt at all. All three are one
    // answer by design, and none of them is worth polling again.
    return { status: "not-found" };
  }

  const body = await response.json().catch(() => null);

  if (body === null || typeof body !== "object") {
    logExtractionPollFailure("unrecognized response");
    return { status: "unavailable" };
  }

  const record = body as { status?: unknown; extraction?: unknown };

  if (record.status !== OK_STATUS) {
    // 503, 400, or any non-ok envelope. Treated as transient rather than guessed at, and
    // deliberately not logged with its content.
    logExtractionPollFailure("poll unavailable");
    return { status: "unavailable" };
  }

  // The normalizer reads ROWS, and the endpoint returns ONE object, so it is wrapped.
  // Reusing that function rather than re-reading fields here is what keeps the web's view
  // of the contract identical to the one the RPC tests already pin.
  const normalized = normalizeExtractionView([record.extraction]);

  if (normalized.status === "empty") {
    return { status: "not-found" };
  }

  if (normalized.status !== "ok") {
    // A body whose shape this build cannot vouch for. Reported as transient and never
    // rendered — a half-validated extraction is not shown to anybody.
    logExtractionPollFailure("unreadable extraction payload");
    return { status: "unavailable" };
  }

  return { status: "ok", view: normalized.extraction };
}

export type { ExtractionView };
