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
 * message, one success message, and the shop the person had selected (echoed back so a
 * rejected submission does not lose their choice).
 *
 * There is NO submission id, storage bucket, object path, file hash, profile id,
 * membership id, organization id, or provider detail — none is produced by the action,
 * because the submission service returns a status and nothing else. The file itself is
 * never echoed back either: a rejected submission asks for it again, which is both
 * safer and what the browser's file input does anyway.
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
};

export const INITIAL_SUBMIT_RECEIPT_STATE: SubmitReceiptState = {
  fieldErrors: {},
  formError: null,
  successMessage: null,
  selectedShopId: "",
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
  "We couldn't submit that receipt. Check the details and try again.";

/**
 * Shown when the reservation succeeded but the file did not reach storage.
 *
 * Safe to be specific: nothing about the provider, the bucket, the key, or the error is
 * named, and telling the person it was the UPLOAD that failed is what tells them
 * retrying the same photo is the right next step.
 */
export const RECEIPT_UPLOAD_FAILED_ERROR =
  "Your receipt could not be uploaded. Please check your connection and try again.";

/** Shown when this person already has a live submission of this exact file. */
export const RECEIPT_DUPLICATE_ERROR =
  "You've already submitted this receipt. Choose a different photo, or check your history below.";

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
  "We couldn't send that receipt. Nothing was submitted — please check your connection and try again.";

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
  "Receipt submitted successfully, but automatic data extraction could not be started.";

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
  `Receipt submitted successfully. Automatic data extraction was not started because it needs a JPEG or PNG photo of ${MAX_EXTRACTION_INPUT_MEGABYTES} MB or smaller.`;

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
  missing: "Choose a receipt photo to upload.",
  empty: "That file is empty. Choose a different photo.",
  "too-large": `That file is too large. Receipts must be ${MAX_RECEIPT_FILE_MEGABYTES} MB or smaller.`,
  "unsupported-type": "Receipts must be a JPEG, PNG or WebP image.",
  "invalid-name": "That file name could not be read. Rename the file and try again.",
  "too-many-files": "Upload one receipt at a time.",
} as const satisfies Record<ReceiptFileRejection, string>;
