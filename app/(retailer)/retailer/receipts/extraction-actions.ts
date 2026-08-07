"use server";

import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { pollReceiptExtraction } from "@/lib/receipts/receipt-extraction-poll-request";
import { requestReceiptExtraction } from "@/lib/receipts/receipt-extraction-request";
import type {
  ExtractionPollResult,
  ExtractionRetryResult,
} from "@/app/(retailer)/retailer/receipts/extraction-panel-state";

/**
 * The two Server Actions the extraction panel drives.
 *
 * A SERVER ACTION IS A PUBLIC ENDPOINT. Both of these are reachable by a hand-crafted POST
 * from any client, with any submission id, regardless of which page rendered the panel or
 * whether it rendered at all. So neither trusts the route: portal access is re-resolved
 * from the verified session on every call, the id is re-validated as a UUID, and the Edge
 * Function behind each one re-derives the caller from auth.uid() and refuses every receipt
 * that is not their own. Hiding a control removes the accident; only these checks — and
 * the RPCs behind them — remove the capability.
 *
 * NO TABLE IS READ OR WRITTEN HERE. `.from(` appears in neither action, no service-role
 * client is constructed on either path, and the extraction tables are named in no file of
 * the web application. Everything goes through the two shared Edge Functions with the
 * caller's own token.
 *
 * WHY POLLING IS A SERVER ACTION RATHER THAN A BROWSER FETCH. The web's posture for these
 * functions is already "one door, on the server, holding one key" — the request path has
 * worked that way since it shipped. Keeping the poll on the same side means the access
 * token is never handed to page JavaScript, the function name and publishable key stay out
 * of the bundle, and one module remains the single place a rename has to be made.
 */

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Re-establishes that the caller may act on their own receipts.
 *
 * Returns `null` when they may. The two refusals are kept DISTINCT — `unauthorized` stops
 * the client's loop, `unavailable` lets it keep trying — because a signed-out caller and a
 * momentary database outage need opposite responses from a polling client.
 *
 * An Owner or a Manager reaching either endpoint is refused here and again by the RPCs:
 * RECEIPT_EXTRACTION_REVIEW is mapped to SALES_STAFF alone.
 */
async function refuseUnlessSubmitter(): Promise<
  { readonly status: "unauthorized" } | { readonly status: "unavailable" } | null
> {
  const access = await getRetailerPortalAccess();

  if (access.status === "unauthenticated" || access.status === "unauthorized") {
    return { status: "unauthorized" };
  }
  if (access.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (access.kind !== "submitter") {
    return { status: "unauthorized" };
  }
  return null;
}

/**
 * Polls one of the caller's receipts, letting the backend finalize a PROCESSING attempt.
 *
 * THIS ACTION NEVER CREATES AN ATTEMPT. It calls the read function and nothing else, so no
 * number of polls — successful, failed, or hammered by a tampered client — can spend one of
 * the three attempts a receipt gets. Creating an attempt lives in the other action below
 * and requires a person to ask.
 */
export async function pollReceiptExtractionAction(
  submissionId: string,
): Promise<ExtractionPollResult> {
  if (typeof submissionId !== "string" || !UUID_PATTERN.test(submissionId.trim())) {
    // A malformed id and an unknown one are one answer, so a tampered client learns
    // nothing about which receipts exist.
    return { status: "not-found" };
  }

  const refusal = await refuseUnlessSubmitter();
  if (refusal !== null) return refusal;

  return pollReceiptExtraction(submissionId.trim().toLowerCase());
}

/**
 * Asks that a receipt be read again, because a person clicked Retry.
 *
 * THE CLIENT DOES NOT DECIDE WHETHER A RETRY IS ALLOWED. It shows the control only when
 * the backend's own `retry_allowed` is true, and this action does not re-check that flag
 * either — `request_receipt_extraction` is the authority and answers EXHAUSTED, ACTIVE,
 * SUCCEEDED or ALREADY_CONFIRMED for every case where another attempt must not be created.
 * Re-implementing the three-attempt budget here would be a second, drifting copy of a rule
 * the database already enforces structurally with `check (attempt_number between 1 and 3)`.
 *
 * IT IS CALLED ONCE PER CLICK. There is no loop, no catch that calls it again, and no
 * automatic invocation from the polling path — an automatic second attempt would spend a
 * person's allowance on a fault they never saw.
 */
export async function retryReceiptExtractionAction(
  submissionId: string,
): Promise<ExtractionRetryResult> {
  if (typeof submissionId !== "string" || !UUID_PATTERN.test(submissionId.trim())) {
    return { status: "unavailable" };
  }

  const refusal = await refuseUnlessSubmitter();
  if (refusal !== null) return refusal;

  const outcome = await requestReceiptExtraction(submissionId.trim().toLowerCase());

  return outcome.status === "requested"
    ? { status: "requested" }
    : { status: "unavailable" };
}
