import type { ExtractionView } from "@/lib/receipts/receipt-extraction-normalization";
import type { ClientExtractionFailureCode } from "@/lib/receipts/receipt-extraction-vocabulary";

/**
 * Shared state contract AND shared user-facing copy for the extraction panel.
 *
 * It lives outside the actions module for the same reason ./submit-receipt-state.ts does:
 * a module with a top-level "use server" directive may only export async functions, so a
 * type or a constant string cannot be declared there.
 *
 * ============================================================================
 * WHAT THE BROWSER IS ALLOWED TO SEE
 * ============================================================================
 * Exactly `ExtractionView`, which is whatever survived
 * @/lib/receipts/receipt-extraction-normalization — itself fed only by the safe payload
 * `get-receipt-extraction` builds. That chain has no field for a provider name, a provider
 * model, an Azure operation id, a worker claim token, an attempt expiry, a storage bucket,
 * an object path, a file hash, or the internal ten-value failure code. The ten collapse to
 * three before they leave PostgreSQL, and those three are the only failure vocabulary
 * below.
 *
 * The panel therefore cannot leak an internal value by accident: there is no such value in
 * the type it renders.
 *
 * ============================================================================
 * THE SUBMISSION ID IS NOW BROWSER-VISIBLE, DELIBERATELY
 * ============================================================================
 * ./submit-receipt-state.ts used to state that no submission id reaches the browser, and
 * that was true while the web had nothing to do with one. Polling changes the requirement:
 * `get-receipt-extraction` is keyed on a submission id, so the browser must hold the id of
 * the receipt it just submitted in order to ask about it.
 *
 * This is a widening of the browser-visible surface and it is recorded as such, but it
 * grants nothing. The id names a row whose every endpoint re-derives the caller from
 * auth.uid(): assert_my_receipt_extraction_access requires
 * `submitted_by_profile_id = auth.uid()`, so the only id that is useful to a person is the
 * id of a receipt they submitted themselves. Naming somebody else's returns `not-found`,
 * byte-identically to naming one that does not exist. The Flutter client has always held
 * these ids for the same reason.
 */

/** The safe, validated projection the panel renders. Re-exported for the client component. */
export type { ExtractionView };

/**
 * The closed result of one poll, as the Server Action reports it.
 *
 * `unavailable` is transient and the loop may continue; `unauthorized` and `not-found` end
 * it. The distinction is the whole reason this is a union rather than a nullable view.
 */
export type ExtractionPollResult =
  | { readonly status: "ok"; readonly view: ExtractionView }
  | { readonly status: "unauthorized" }
  | { readonly status: "not-found" }
  | { readonly status: "unavailable" };

/**
 * The closed result of a person-initiated retry.
 *
 * `requested` means an attempt now exists and polling should resume. Every other way of
 * failing is `unavailable`, because the person's next step is identical in all of them.
 */
export type ExtractionRetryResult =
  | { readonly status: "requested" }
  | { readonly status: "unauthorized" }
  | { readonly status: "unavailable" };

/* ---------------------------------------------------------------------------
 * Copy. Sentences only — no rule is enforced by anything in this file.
 * ------------------------------------------------------------------------- */

/** A. Preparing — the attempt exists and no worker has picked it up yet. */
export const EXTRACTION_QUEUED_TITLE = "Preparing to read your invoice / receipt";
export const EXTRACTION_QUEUED_BODY =
  "This usually takes a few seconds. You can stay on this page.";

/** B. Reading — a worker holds the attempt and the provider is working. */
export const EXTRACTION_PROCESSING_TITLE = "Reading your invoice / receipt";
export const EXTRACTION_PROCESSING_BODY =
  "We're picking out the merchant, date and totals.";

/** C. Succeeded. */
export const EXTRACTION_SUCCEEDED_TITLE = "We read your invoice / receipt";
export const EXTRACTION_SUCCEEDED_BODY =
  "Check these details against the paper invoice / receipt. A reviewer confirms them next.";

/* ---------------------------------------------------------------------------
 * C2. The items read from a SUCCEEDED receipt. READ-ONLY, and worded so.
 * ------------------------------------------------------------------------- */

export const EXTRACTION_ITEMS_TITLE = "Items read from this invoice / receipt";

/** Shown while the one line-item read is in flight. It never implies a failure. */
export const EXTRACTION_ITEMS_LOADING_MESSAGE = "Getting the items…";

/**
 * Shown when the line-item read could not be completed.
 *
 * It is careful about what it does NOT say: the receipt was read and stored, so this is a
 * display problem rather than a reading problem, and the sentence may not be readable as
 * "your receipt was lost". A lapsed session and a database fault share this sentence, because
 * naming which one would tell any caller whether our database is healthy.
 */
export const EXTRACTION_ITEMS_UNAVAILABLE_MESSAGE =
  "We couldn't show the items just now. Your invoice / receipt was read and saved.";

/**
 * The sentence that tells a person, plainly, that these values are not theirs to change.
 *
 * IT IS THE MILESTONE'S BOUNDARY STATED TO THE PERSON rather than only in a commit message.
 * Matching items to Vendor products, excluding an unrelated line and everything downstream of
 * that are later milestones; until they exist, the honest thing is to say what these values are
 * for and who acts on them.
 */
export const EXTRACTION_ITEMS_READ_ONLY_NOTE =
  "These are the reader's own values, kept exactly as read. Check them against the paper invoice / receipt.";

/**
 * E. The foreground budget ran out while the attempt was still open.
 *
 * IT IS NOT A FAILURE and the wording may never imply one. Nothing about the attempt
 * changed when we stopped watching; the provider may still finish it, and a later visit
 * will show the result.
 */
export const EXTRACTION_STILL_WORKING_TITLE = "Still being read";
export const EXTRACTION_STILL_WORKING_BODY =
  "This one is taking longer than usual. Your invoice / receipt is safe and the reading is still underway.";
export const EXTRACTION_CHECK_AGAIN_LABEL = "Check again";

/** The retry control. Shown only when the backend says `retry_allowed`. */
export const EXTRACTION_RETRY_LABEL = "Try reading it again";

/**
 * D. Failure. Three codes, because three is all the client contract has.
 *
 * The two image codes are ACTIONABLE — retake the photo — and say so. The third covers a
 * provider outage, an exhausted quota, a timeout, a dead worker and an unreadable object
 * with one sentence, deliberately: distinguishing them would tell any authenticated caller
 * whether our provider is healthy, which is an availability oracle rather than help.
 */
export const EXTRACTION_FAILURE_MESSAGES = {
  IMAGE_NOT_A_RECEIPT:
    "That image didn't look like an invoice or receipt, so we couldn't read it. A clear image of the whole document works best.",
  IMAGE_UNUSABLE:
    "We couldn't use that image. A sharper, well-lit image of the whole invoice / receipt works best.",
  EXTRACTION_UNAVAILABLE:
    "We couldn't read this invoice / receipt automatically. It is submitted, and a reviewer will enter the details.",
} as const satisfies Record<ClientExtractionFailureCode, string>;

/** Shown for a FAILED attempt whose code did not arrive. Same advice, no cause claimed. */
export const EXTRACTION_FAILED_FALLBACK_MESSAGE =
  EXTRACTION_FAILURE_MESSAGES.EXTRACTION_UNAVAILABLE;

export const EXTRACTION_FAILED_TITLE = "We couldn't read this invoice / receipt";

/**
 * Shown when the session lapsed mid-poll.
 *
 * It never says the receipt was lost, because it was not: the submission committed before
 * any of this ran.
 */
export const EXTRACTION_SIGNED_OUT_MESSAGE =
  "Your session ended, so we stopped checking. Your invoice / receipt is submitted — sign in again to see the result.";

/**
 * Shown when polling cannot reach the service at all and the budget is spent.
 *
 * A connection problem, not a reading problem, and worded so it cannot be read as one.
 */
export const EXTRACTION_OFFLINE_MESSAGE =
  "We couldn't check the reading just now. Your invoice / receipt is submitted — check again in a moment.";

/**
 * The remaining gap this milestone does NOT close, stated to the person rather than only
 * in a commit message.
 *
 * The web has no correction or confirmation surface yet: `confirm_receipt_extraction` has
 * no web caller, and building one is its own milestone. So the panel presents what was
 * read and says plainly who acts next, instead of implying the person can edit it here.
 */
export const EXTRACTION_REVIEW_NEXT_STEP =
  "You don't need to do anything else — a reviewer checks these details before the sale counts.";
