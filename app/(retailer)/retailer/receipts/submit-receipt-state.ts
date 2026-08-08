import { MAX_RECEIPT_FILE_MEGABYTES } from "@/lib/uploads/upload-policy";
import { MAX_EXTRACTION_INPUT_MEGABYTES } from "@/lib/receipts/receipt-extraction-eligibility";
// TYPE-ONLY, so it is erased at build time and no server-only code follows it into the
// browser bundle. It is imported purely so `satisfies` below fails the build if a new
// rejection reason is added to the validator without a sentence being written for it.
import type { ReceiptFileRejection } from "@/lib/receipts/receipt-file";

/**
 * Shared state contract AND shared user-facing copy for the receipt submission form.
 *
 * This lives outside actions.ts deliberately. A module with a top-level "use server"
 * directive may only export async functions — every export becomes a callable server
 * endpoint — so exporting a plain object from there is a runtime error.
 *
 * THE BROWSER-VISIBLE SURFACE IS ONLY WHAT IS HERE: two field messages, one form
 * message, one success message, the shop the person had selected (echoed back so a
 * rejected submission does not lose their choice), and — on the one branch where a
 * reading is actually underway — the id of the receipt just submitted.
 *
 * There is NO storage bucket, object path, file hash, profile id, membership id,
 * organization id, or provider detail. The file itself is never echoed back either: a
 * rejected submission asks for it again, which is both safer and what the browser's file
 * input does anyway.
 *
 * WHY THE SUBMISSION ID IS NOW HERE, WHEN IT DELIBERATELY WAS NOT BEFORE. The web had no
 * use for one until this milestone: it asked for a reading and stopped. But
 * `get-receipt-extraction` is keyed on a submission id, and calling that function is what
 * finalizes a PROCESSING attempt into SUCCEEDED or FAILED — so the browser must hold the
 * id of the receipt it just submitted in order to see the reading through.
 *
 * The widening grants nothing. Every endpoint that accepts the id re-derives the caller
 * from auth.uid(), and assert_my_receipt_extraction_access requires
 * `submitted_by_profile_id = auth.uid()`; naming somebody else's receipt returns
 * `not-found`, byte-identically to naming one that does not exist. It is set on the
 * `submitted` branch ALONE — where an attempt is open or already exists — and stays null
 * for a duplicate, a refusal, an upload failure, a skipped image and a reading that could
 * not be started, because in every one of those there is nothing to poll.
 *
 * WHY THE MESSAGES MOVED HERE. The size and type rules are now checked in TWO places:
 * once in the browser before a request is sent, and once again on the server from the
 * file's own bytes. Two places phrasing the same refusal differently is how a person
 * ends up being told two different things about one file, so the sentences are written
 * once, here, and both sides read them. It is a shared module with no directive of its
 * own, so it is safe in a Client Component and in the Server Action alike; every value
 * in it is a constant string.
 *
 * NOTHING HERE IS VALIDATION AND NOTHING HERE IS AUTHORIZATION. These are sentences.
 * The rules they describe are enforced by @/lib/receipts/receipt-file from the bytes on
 * the server, and again by the database.
 *
 * ============================================================================
 * "INVOICE / RECEIPT" IS THE USER-FACING NAME FOR THE UPLOADED DOCUMENT
 * ============================================================================
 * SalesReward accepts an itemized sales invoice OR a point-of-sale receipt, and a Sales
 * Staff member holding an invoice should not have to guess whether this screen is for them.
 * So every sentence a person reads names both.
 *
 * THE INTERNAL VOCABULARY IS DELIBERATELY UNTOUCHED. The constants in this file are still
 * `RECEIPT_*`, the state type is still `SubmitReceiptState`, the form field is still
 * `receipt`, the route is still /retailer/receipts, and the tables, RPCs and Edge Functions
 * are still `receipt_*`. Renaming any of those would be a schema and contract change wearing
 * a copy change's clothes — and every one of them is proved unchanged by
 * lib/receipts/receipt-document-terminology.test.ts.
 */
export type SubmitReceiptState = {
  fieldErrors: {
    shopId?: string;
    receipt?: string;
  };
  formError: string | null;
  successMessage: string | null;
  /** The shop id the operator had chosen, so the selector can be restored. */
  selectedShopId: string;
  /**
   * The receipt whose reading the panel should follow, or null when there is nothing to
   * follow. Non-null on the `submitted` branch alone — see this module's header.
   */
  extractionSubmissionId: string | null;
};

export const INITIAL_SUBMIT_RECEIPT_STATE: SubmitReceiptState = {
  fieldErrors: {},
  formError: null,
  successMessage: null,
  selectedShopId: "",
  extractionSubmissionId: null,
};

/**
 * The one message for every failure that is not a field problem.
 *
 * It covers an unauthorized caller, an unassigned or inactive shop, another Retailer's
 * shop, a shop id that does not exist, and a database outage. Collapsing them is
 * deliberate: the reservation RPC already refuses all of the addressing cases with a
 * single byte-identical exception so it cannot be used to probe another Retailer's
 * estate, and distinguishing them here would reintroduce exactly that disclosure.
 */
export const RECEIPT_GENERIC_ERROR =
  "We couldn't submit that invoice / receipt. Check the details and try again.";

/**
 * Shown when the reservation succeeded but the file did not reach storage.
 *
 * Safe to be specific: nothing about the provider, the bucket, the key, or the error is
 * named, and telling the person it was the UPLOAD that failed is what tells them
 * retrying the same photo is the right next step.
 */
export const RECEIPT_UPLOAD_FAILED_ERROR =
  "Your invoice / receipt could not be uploaded. Please check your connection and try again.";

/** Shown when this person already has a live submission of this exact file. */
export const RECEIPT_DUPLICATE_ERROR =
  "You've already submitted this invoice / receipt. Choose a different image, or check your history below.";

/**
 * Shown when the submission never reached the Server Action, or reached it and the
 * response could not be used: a dropped connection, a request the framework refused at
 * its own boundary before any application code ran (HTTP 413), a timeout, or an
 * unexpected server fault.
 *
 * THIS IS NOT AN AUTHORIZATION MESSAGE, and the wording is chosen so it can never be
 * read as one. The person keeps their place on the receipt page and is told, truthfully,
 * that nothing was recorded and that trying again is safe — because nothing WAS
 * recorded: a request that never reached the action reserved nothing, uploaded nothing,
 * and wrote nothing.
 *
 * No status code, no framework name, no storage detail, and no stack appears in it.
 */
export const RECEIPT_TRANSPORT_ERROR =
  "We couldn't send that invoice / receipt. Nothing was submitted — please check your connection and try again.";

/**
 * THE PARTIAL SUCCESS: the receipt is stored, and the automatic reading did not begin.
 *
 * IT IS A SUCCESS MESSAGE, NOT AN ERROR, and it is rendered in the success slot. That is
 * the honest classification: the reservation, the upload and the finalize all completed,
 * the receipt is in the private bucket, it appears in the submission history, and a
 * reviewer will see it. Nothing about it needs re-doing, and re-submitting the same photo
 * would simply be refused as a duplicate.
 *
 * IT ALSO DOES NOT CLAIM THE READING STARTED. Saying only "Receipt submitted" would leave
 * a person believing the values were being read when no attempt exists. The sentence
 * states both facts, in that order.
 *
 * No status code, no endpoint name, no provider name, no configuration detail and no
 * backend text appears in it — the request module returns a plain status and nothing else.
 */
export const RECEIPT_EXTRACTION_NOT_STARTED_MESSAGE =
  "Invoice / receipt submitted successfully, but automatic data extraction could not be started.";

/**
 * The same partial success, for an image the reader does not accept.
 *
 * Separated from the sentence above because the cause is different and so is the advice:
 * nothing was wrong and nothing failed, the photograph is simply outside what the reader
 * takes. It names the two formats and the size so the next photograph can be read, and it
 * says plainly that the receipt itself is fine.
 *
 * The numbers come from @/lib/receipts/receipt-extraction-eligibility, which is the module
 * the Server Action actually consults, so the sentence cannot drift from the rule.
 */
export const RECEIPT_EXTRACTION_UNSUPPORTED_IMAGE_MESSAGE =
  `Invoice / receipt submitted successfully. Automatic data extraction was not started because it needs a JPEG or PNG image of ${MAX_EXTRACTION_INPUT_MEGABYTES} MB or smaller.`;

/* ---------------------------------------------------------------------------
 * The three shop states. Sentences only — the rules are in
 * @/lib/receipts/receipt-shop-selection, and the authorization is in SQL.
 * ------------------------------------------------------------------------- */

/**
 * NO ACTIVE ASSIGNMENT. Worded so it cannot be mistaken for a permission problem: they ARE
 * allowed to submit receipts, there is simply no shop to submit against until someone at
 * their Retailer assigns them to one. No shop is fabricated to fill the gap.
 */
export const RECEIPT_NO_ACTIVE_SHOP_MESSAGE = "You are not assigned to an active shop.";

/** What to do about it, said separately so the fact above stands on its own. */
export const RECEIPT_NO_ACTIVE_SHOP_HINT =
  "Ask someone at your Retailer to assign you to a shop, then come back to this page.";

/**
 * MORE THAN ONE ASSIGNMENT. The question is asked before the document is chosen, and the
 * sentence says so: it states the ORDER, not just the requirement, because the order is the
 * part a person cannot infer from a disabled control.
 */
export const RECEIPT_SHOP_CHOICE_HINT =
  "Select the shop where this sale happened before adding the invoice / receipt.";

/** Shown in place of the file picker until that question is answered. */
export const RECEIPT_SHOP_FIRST_MESSAGE =
  "Select the shop above first, then add the invoice / receipt.";

/**
 * EXACTLY ONE ASSIGNMENT. The shop is context, not a question, so it is stated rather than
 * offered — and stated in full, because a person submitting for the wrong shop is exactly what
 * a silent automatic choice would cause.
 */
export function receiptFixedShopNotice(shopLabel: string): string {
  return `Submitting for: ${shopLabel}`;
}

/**
 * One message per distinct, user-actionable file problem.
 *
 * The keys are the rejection reasons @/lib/receipts/receipt-file produces. The browser
 * can only ever raise the first four (it has the file, so it can see a missing, empty,
 * over-sized or multiply-selected selection before sending anything); the server can
 * raise all of them, including the two — an unsupported type and an unusable name — it
 * derives from the bytes rather than from what the browser claimed.
 */
export const RECEIPT_FILE_MESSAGES = {
  missing: "Choose an invoice / receipt image to upload.",
  empty: "That file is empty. Choose a different image.",
  "too-large": `That file is too large. An invoice / receipt must be ${MAX_RECEIPT_FILE_MEGABYTES} MB or smaller.`,
  "unsupported-type": "An invoice / receipt must be a JPEG, PNG or WebP image.",
  "invalid-name": "That file name could not be read. Rename the file and try again.",
  "too-many-files": "Upload one invoice / receipt at a time.",
} as const satisfies Record<ReceiptFileRejection, string>;
