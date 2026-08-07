"use server";

import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { pollReceiptExtraction } from "@/lib/receipts/receipt-extraction-poll-request";
import { requestReceiptExtraction } from "@/lib/receipts/receipt-extraction-request";
import { getMyReceiptExtractionLineItems } from "@/lib/receipts/receipt-extraction-line-items";
import type { LineItemReadResult } from "@/lib/receipts/receipt-line-item-load";
import type {
  ExtractionPollResult,
  ExtractionRetryResult,
} from "@/app/(retailer)/retailer/receipts/extraction-panel-state";

/**
 * The three Server Actions the extraction panel drives.
 *
 * A SERVER ACTION IS A PUBLIC ENDPOINT. Every one of these is reachable by a hand-crafted
 * POST from any client, with any submission id, regardless of which page rendered the panel or
 * whether it rendered at all. So none of them trusts the route: portal access is re-resolved
 * from the verified session on every call, the id is re-validated as a UUID, and the RPC
 * behind each one re-derives the caller from auth.uid() and refuses every receipt that is not
 * their own. Hiding a control removes the accident; only these checks — and the RPCs behind
 * them — remove the capability.
 *
 * NO TABLE IS READ OR WRITTEN HERE. `.from(` appears in no action, no service-role client is
 * constructed on any path, and the extraction tables are named in no file of the web
 * application. Everything goes through the two shared Edge Functions and one authorized RPC,
 * all three with the caller's own token.
 *
 * NOTHING HERE WRITES. There is no confirmation, correction, exclusion or approval action in
 * this module, because this milestone gives Sales Staff no way to amend what was read: the
 * original OCR values are evidence, and evidence a submitter can edit is not evidence.
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

/**
 * Reads the line items of one of the caller's own receipts, for display and nothing else.
 *
 * IT IS A READ, AND ONLY A READ. It creates no attempt, completes none, writes no row and
 * touches no Storage object. Calling it a hundred times changes nothing about the receipt —
 * unlike the poll action, which is what finalizes an attempt, and unlike the retry action,
 * which spends one of a receipt's three.
 *
 * THE CLIENT DECIDES WHEN, NOT WHETHER. The panel asks only once a reading has SUCCEEDED (see
 * @/lib/receipts/receipt-line-item-load), because that is the only status with line items to
 * return. A tampered client that asks about a QUEUED attempt is not refused here — it simply
 * receives the empty list the RPC's own `status = 'SUCCEEDED'` filter produces.
 *
 * A DENIAL IS REPORTED AS `unauthorized`, and a fault as `unavailable`, because the client's
 * next step differs: one is final, the other may be retried by a person. Neither carries a
 * database message, a SQLSTATE or a receipt id.
 */
export async function readReceiptLineItemsAction(
  submissionId: string,
): Promise<LineItemReadResult> {
  if (typeof submissionId !== "string" || !UUID_PATTERN.test(submissionId.trim())) {
    // A malformed id yields the same empty answer an unknown one does, so a tampered client
    // learns nothing about which receipts exist.
    return { status: "ok", lineItems: [] };
  }

  const refusal = await refuseUnlessSubmitter();
  if (refusal !== null) {
    return refusal.status === "unauthorized"
      ? { status: "unauthorized" }
      : { status: "unavailable" };
  }

  const result = await getMyReceiptExtractionLineItems(
    submissionId.trim().toLowerCase(),
  );

  if (result.status === "ok") return { status: "ok", lineItems: result.lineItems };
  // `denied` means the caller may not submit receipts at all, which is the same dead end for
  // this client as a lapsed session: asking again cannot change it.
  return result.status === "denied"
    ? { status: "unauthorized" }
    : { status: "unavailable" };
}
