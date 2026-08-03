import type { SaleFinalizationFieldErrors } from "@/lib/review/claim-sale-finalization-input";
import type { SaleFinalizationOutcome } from "@/lib/review/claim-sale-finalization-settlement";

/**
 * The state a sale finalization hands back to the panel.
 *
 * A separate module from the action itself so the Client Component can import
 * the shape without importing a `"use server"` file — the convention already
 * used by decision-action-state.ts and qualification-action-state.ts.
 */
export type { SaleFinalizationOutcome };

export type SaleFinalizationActionState = {
  fieldErrors: SaleFinalizationFieldErrors;
  /** One safe sentence. Never a database message, code or hint. */
  formError: string | null;
  /** Null until an authoritative answer came back. */
  outcome: SaleFinalizationOutcome | null;
  message: string | null;
  /**
   * True once the database has given a FINAL answer.
   *
   * Deliberately false for AMBIGUOUS_TIME_REQUIRES_CHOICE: that outcome is the
   * database asking a question, and the form must stay open to answer it.
   */
  settled: boolean;
  /**
   * The request did not complete, so what the database did is UNKNOWN.
   *
   * Distinct from both success and failure on purpose. `settled` stays false so
   * the reviewer may try again, but the copy must not claim the write failed —
   * it may well have committed. The panel uses this to offer a refresh first.
   */
  uncertain: boolean;
  /**
   * True when the database asked for a daylight-saving selection.
   *
   * Drives focus back to the FIRST/SECOND controls without settling the form.
   */
  needsDstChoice: boolean;
};

export const INITIAL_SALE_FINALIZATION_ACTION_STATE: SaleFinalizationActionState =
  {
    fieldErrors: {},
    formError: null,
    outcome: null,
    message: null,
    settled: false,
    uncertain: false,
    needsDstChoice: false,
  };
