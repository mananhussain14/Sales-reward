// SERVER-ONLY MODULE.
//
// The web portal's ONE client of the shared Edge Function `request-receipt-extraction`,
// called with the signed-in Sales Staff member's own access token.
//
// ============================================================================
// WHY THE REQUEST GOES THROUGH THE EDGE FUNCTION AND NOT DIRECTLY TO POSTGRESQL
// ============================================================================
// Creating the attempt row is only the first of four steps. The job must then be claimed,
// the private object downloaded, the document submitted to the reader and the operation
// registered — and the three worker RPCs plus the private bucket are reachable only with
// the service-role key, which this process must not use for a browser-initiated action
// and does not read here at all. One door, on the server, holding one key: the same
// posture lib/staff/retailer-staff-invitations.ts already ships for staff invitations.
//
// The web and the Flutter app therefore initiate a reading the SAME way, through the same
// function, with the same one-field body — rather than through two implementations that
// agree today.
//
// ============================================================================
// THE ACCESS TOKEN, AND WHY getSession() IS RIGHT HERE
// ============================================================================
// This module needs the caller's access token as a STRING to forward, not an
// authorization decision — so `getSession()` is the correct call, and the usual rule
// ("use getUser(), not getSession()") is not being bent. Nothing here trusts the token:
// the gateway verifies the JWT (`verify_jwt = true`), the function revalidates it with
// `auth.getUser()` against the Auth server, and then
// assert_my_receipt_extraction_access() and request_receipt_extraction() decide every
// question about identity, Retailer, permission and receipt ownership from `auth.uid()`
// in PostgreSQL. The Server Action has ALSO already resolved portal access with getUser()
// before reaching here. A forged or stale token forwarded from this line buys nothing.
//
// ============================================================================
// WHAT THIS MODULE CANNOT DO
// ============================================================================
//   * It does not construct a service-role client — `createAdminClient` does not appear.
//   * It does not read SUPABASE_SERVICE_ROLE_KEY, or any secret.
//   * It writes NO table. There is no `.from(` here, and the names of
//     receipt_extractions and receipt_extraction_line_items appear nowhere in the web
//     application at all.
//   * It touches no Storage bucket, mints no URL, and never sees an object path.
//   * It never retries. One request per deliberate submission; see the flow module.
//   * It reads exactly TWO fields out of the response — a status and an outcome, both
//     compared against literals. The reader's own payload, its confidence scores, its
//     error text and every extracted value are structurally unable to pass through here.
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/env/supabase";
import type { ExtractionRequestOutcome } from "@/lib/receipts/receipt-submission-extraction-flow";

/**
 * The Edge Function's name, and the path shape the gateway serves it on.
 *
 * DECLARED EXACTLY ONCE in the whole web application.
 * lib/receipts/receipt-submission-extraction-wiring.test.ts asserts both that this is the
 * only occurrence and that it matches the `[functions.…]` block in supabase/config.toml,
 * so a rename on either side fails the build rather than producing a 404 at runtime that
 * looks exactly like a reading that never started.
 */
const REQUEST_EXTRACTION_FUNCTION = "request-receipt-extraction" as const;

/**
 * The one outcome that means the endpoint answered but created nothing.
 *
 * It is what the function returns when either of its two gates is shut — the database
 * runtime row or its own environment. Reporting it as a success would tell a person their
 * receipt is being read when no attempt exists, which is the single most misleading thing
 * this module could say.
 */
const EXTRACTION_UNAVAILABLE_OUTCOME = "EXTRACTION_UNAVAILABLE" as const;

/** The status the endpoint reports when the request itself was understood and acted on. */
const OK_STATUS = "ok" as const;

/** Sanitized operator logging. No ids, tokens, URLs, bodies, or error objects. */
function logExtractionRequestFailure(category: string): void {
  console.error(`[receipts-extraction-request] ${category}`);
}

/**
 * Asks that one stored receipt be read.
 *
 * @param submissionId the canonical id `reserve_receipt_submission()` returned, carried
 *   here by the submission flow's `submitted` result. It is never a form value.
 *
 * @returns `requested` when an attempt is open or already exists for this receipt, and
 *   `unavailable` for every other case. NEITHER value says anything about whether the
 *   receipt was stored — that was decided before this function was called and is not
 *   revisited by it.
 */
export async function requestReceiptExtraction(
  submissionId: string,
): Promise<ExtractionRequestOutcome> {
  let url: string;
  let publishableKey: string;
  try {
    ({ url, publishableKey } = getSupabaseEnv());
  } catch {
    // The thrown message names only the missing variable; it is not bound or forwarded.
    logExtractionRequestFailure("supabase configuration is incomplete");
    return { status: "unavailable" };
  }

  const supabase = await createClient();

  // See this module's header: the token is fetched to be FORWARDED, not believed.
  const sessionResult = await Promise.resolve(supabase.auth.getSession()).catch(
    () => null,
  );
  const accessToken = sessionResult?.data?.session?.access_token;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    // The session lapsed between the action's own getUser() check and this call. The
    // receipt is already stored; only the reading is affected.
    logExtractionRequestFailure("no access token for the caller");
    return { status: "unavailable" };
  }

  let response: Response;
  try {
    response = await fetch(`${url}/functions/v1/${REQUEST_EXTRACTION_FUNCTION}`, {
      method: "POST",
      headers: {
        // The caller's own token. This is what makes auth.uid() the real submitter.
        Authorization: `Bearer ${accessToken}`,
        // The publishable key the gateway expects. A public value; never the
        // service-role key, which this process does not read at all.
        apikey: publishableKey,
        "Content-Type": "application/json",
      },
      // No cookies: this is a bearer-token request, deliberately.
      credentials: "omit",
      // THE ENTIRE REQUEST BODY. One key, and its value is the database's own id. The
      // endpoint refuses an unknown key with a 400 rather than ignoring it, so this shape
      // is enforced on both sides.
      body: JSON.stringify({ submission_id: submissionId }),
    });
  } catch {
    // A transport throw can carry the request headers, which include the access token.
    // Nothing is bound, inspected, or logged. There is no retry on this path.
    logExtractionRequestFailure("request transport");
    return { status: "unavailable" };
  }

  const body = await response.json().catch(() => null);

  if (body === null || typeof body !== "object") {
    // A body this build cannot read — a gateway error page, or a future contract. Treated
    // as an outage rather than guessed at, and deliberately NOT logged with its content.
    logExtractionRequestFailure("unrecognized response");
    return { status: "unavailable" };
  }

  const record = body as { status?: unknown; outcome?: unknown };

  // Two fields, both compared against literals. Nothing else is read, and no value from
  // the response is returned to the caller or rendered anywhere.
  if (record.status !== OK_STATUS) {
    logExtractionRequestFailure("request refused");
    return { status: "unavailable" };
  }

  if (record.outcome === EXTRACTION_UNAVAILABLE_OUTCOME) {
    logExtractionRequestFailure("reading is switched off");
    return { status: "unavailable" };
  }

  return { status: "requested" };
}
