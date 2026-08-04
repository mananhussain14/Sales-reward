import type { ProductDecisionFieldErrors } from "@/lib/review/claim-product-decision-input";
import type { ProductDecisionOutcome } from "@/lib/review/claim-product-decision-settlement";

/**
 * The state a product decision hands back to the panel.
 *
 * A separate module from the action itself so the Client Component can import
 * the shape without importing a `"use server"` file — the convention already used
 * by decision-action-state.ts, qualification-action-state.ts and
 * sale-finalization-action-state.ts.
 */
export type { ProductDecisionOutcome };

export type ProductDecisionActionState = {
  fieldErrors: ProductDecisionFieldErrors;
  /** One safe sentence. Never a database message, code or hint. */
  formError: string | null;
  /** Null until an authoritative answer came back. */
  outcome: ProductDecisionOutcome | null;
  message: string | null;
  /**
   * True once the database has given a FINAL answer.
   *
   * Every product outcome settles — unlike the sale header, none of them is the
   * database asking the reviewer a question.
   */
  settled: boolean;
  /**
   * The request did not complete, so what the database did is UNKNOWN.
   *
   * Distinct from both success and failure on purpose. `settled` stays false so
   * the reviewer may act again, but the copy must not claim the write failed — it
   * may well have committed. The panel uses this to offer a status check first.
   */
  uncertain: boolean;
};

export const INITIAL_PRODUCT_DECISION_ACTION_STATE: ProductDecisionActionState =
  {
    fieldErrors: {},
    formError: null,
    outcome: null,
    message: null,
    settled: false,
    uncertain: false,
  };
