/**
 * PURE MODULE — no I/O, no `next/headers`, no Supabase client, no environment, no crypto.
 * Its only imports are a sibling pure module and two types.
 *
 * WHAT HAPPENS AFTER A RECEIPT IS STORED, expressed once, with the one effect injected.
 * The server module that supplies the real port
 * (lib/receipts/receipt-extraction-request.ts) cannot be unit-tested — importing it pulls
 * in `next/headers` — so the decision itself lives here and is exercised directly by
 * ./receipt-submission-extraction-flow.test.ts against a fake port that records what was
 * called, how many times, and with what argument.
 *
 * ============================================================================
 * TWO OPERATIONS, NOT ONE
 * ============================================================================
 * Storing the receipt and reading it are separate acts with separate failure modes, and
 * this module is the seam between them. The receipt is ALREADY COMMITTED by the time
 * anything here runs: the reservation, the upload and the finalize have all succeeded and
 * the row says SUBMITTED. Nothing below may undo that.
 *
 * So there is no branch here that deletes an object, rolls a row back, or re-reports a
 * stored receipt as an upload failure. A reading that could not be started is reported as
 * its OWN outcome, and the person is told the truth twice over: the receipt is safe, and
 * the automatic reading did not begin.
 *
 * ============================================================================
 * THE ID IS THE ONE THE DATABASE GAVE US
 * ============================================================================
 * The submission id passed to the port comes from the `submitted` result variant, which
 * carries the value `reserve_receipt_submission()` returned. It is never read from the
 * form, from a hidden field, from a header, or from anything else the browser influenced
 * — the browser supplies exactly one shop id and one file, and neither is an id of a
 * submission. A tampered request cannot aim an extraction attempt at somebody else's
 * receipt from here, and could not succeed if it did: the endpoint re-derives the caller
 * from auth.uid() and refuses every receipt that is not their own.
 *
 * ============================================================================
 * EXACTLY ONE REQUEST, AND NEVER A RETRY
 * ============================================================================
 * The port is called AT MOST ONCE per run, on one branch, with no loop and no catch that
 * calls it again. Requesting an extraction can consume one of the three attempts a
 * receipt gets in its lifetime, so an automatic second attempt would spend a person's
 * allowance on a fault they never saw. Retrying is a deliberate act, and this milestone
 * does not offer one.
 *
 * The corresponding double-submit protection is upstream and in the database: a repeated
 * form submission of the same file is refused as a duplicate before it reserves anything,
 * and `request_receipt_extraction` answers ACTIVE — creating nothing — when an attempt is
 * already open for that receipt.
 */
// Relative, with explicit `.ts` extensions, so this module resolves under the Node test
// runner as well as under the bundler — the same convention every other unit-tested module
// in this directory uses.
import {
  classifyExtractionEligibility,
  type ExtractionIneligibilityReason,
} from "./receipt-extraction-eligibility.ts";
import type { ReceiptSubmissionResult } from "./receipt-submission-flow.ts";

/**
 * The closed set of outcomes the request port may report.
 *
 * `unavailable` covers every way asking can fail — a lapsed session, a transport fault, a
 * gateway error, a reader that is switched off, an unreadable response — because the
 * receipt's fate and the person's next step are identical in all of them.
 */
export type ExtractionRequestOutcome =
  | { readonly status: "requested" }
  | { readonly status: "unavailable" };

export type ReceiptExtractionRequestPorts = {
  /** Called at most once. Must not throw; a fault is an `unavailable` result. */
  requestExtraction(input: {
    readonly submissionId: string;
  }): Promise<ExtractionRequestOutcome>;
};

/** The file facts this decision needs, both derived server-side from the bytes. */
export type ReceiptExtractionFileFacts = {
  readonly mimeType: string;
  readonly sizeBytes: number;
};

/**
 * The closed set of outcomes the Server Action maps to a sentence.
 *
 * The five non-submitted statuses pass through UNCHANGED from the submission flow, so
 * this module cannot turn a duplicate into a failure or a denial into an outage. The
 * three `submitted*` members are all SUCCESSES — the receipt is stored in every one of
 * them — and they differ only in what they may honestly say about the reading.
 */
export type ReceiptSubmissionOutcome =
  /** Stored, and a reading was requested. */
  | { readonly status: "submitted" }
  /** Stored. The reading could not be started; nothing was consumed. */
  | { readonly status: "submitted-extraction-unstarted" }
  /** Stored. The image is one the reader does not accept, so nothing was asked. */
  | {
      readonly status: "submitted-extraction-skipped";
      readonly reason: ExtractionIneligibilityReason;
    }
  | { readonly status: "upload-failed" }
  | { readonly status: "duplicate" }
  | { readonly status: "denied" }
  | { readonly status: "invalid" }
  | { readonly status: "unavailable" };

/**
 * Decides what follows one submission attempt.
 *
 * @param submission the closed result of the reserve → upload → finalize sequence.
 * @param file the MIME type and size derived from the file's own bytes.
 */
export async function runReceiptSubmissionOutcome(
  submission: ReceiptSubmissionResult,
  file: ReceiptExtractionFileFacts,
  ports: ReceiptExtractionRequestPorts,
): Promise<ReceiptSubmissionOutcome> {
  // Nothing was stored, so there is nothing to read. The port is not called on ANY of
  // these branches — a duplicate, a refused reservation, a failed upload and a failed
  // finalize all leave this function without touching it.
  if (submission.status !== "submitted") {
    return { status: submission.status };
  }

  const eligibility = classifyExtractionEligibility(file);

  if (eligibility.status !== "eligible") {
    // Knowable here, for free. Asking anyway would spend one of three attempts to be told
    // the same thing by the reader.
    return {
      status: "submitted-extraction-skipped",
      reason: eligibility.reason,
    };
  }

  // THE ONLY CALL. One await, one argument, and the argument is the database's own id.
  const requested = await ports.requestExtraction({
    submissionId: submission.submissionId,
  });

  // No retry, and no reclassification of the receipt: it is stored either way.
  return requested.status === "requested"
    ? { status: "submitted" }
    : { status: "submitted-extraction-unstarted" };
}
