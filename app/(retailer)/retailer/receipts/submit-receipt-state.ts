/**
 * Shared state contract for the receipt submission form.
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
