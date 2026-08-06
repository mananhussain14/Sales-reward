import type { DecisionFieldErrors } from "@/lib/review/claim-review-decision-input";

/**
 * The state a decision submission hands back to the form.
 *
 * A separate module from the action itself so the Client Component can import
 * the shape and its initial value WITHOUT importing a `"use server"` file — the
 * convention already used by campaign-action-state.ts and product-form-state.ts.
 *
 * ============================================================================
 * WHY `settled` IS NOT `success`
 * ============================================================================
 * Three different outcomes end this form: the reviewer's decision was written,
 * an identical one already existed, or somebody else decided first. All three
 * mean the same thing to the UI — THIS RECEIPT NOW HAS A FINAL DECISION AND MUST
 * NOT BE SUBMITTED AGAIN — and only one of them is a success. Collapsing them
 * into a boolean called `success` would make the conflict case read as a win.
 *
 * `settled` therefore drives control removal, and `outcome` carries the truth.
 */
export type DecisionSubmissionOutcome =
  | "DECIDED"
  | "ALREADY_DECIDED"
  | "CONFLICT";

export type DecisionActionState = {
  /** Per-field messages. Empty when nothing was wrong with the input. */
  fieldErrors: DecisionFieldErrors;
  /** One safe sentence. Never a database message, code or hint. */
  formError: string | null;
  /**
   * What the database reports is now true. Null until an authoritative answer
   * came back — a validation failure or an outage leaves this null.
   */
  outcome: DecisionSubmissionOutcome | null;
  /** Message matched to the outcome. Honest about conflicts. */
  message: string | null;
  /**
   * True once the receipt has a final decision by ANY of the three routes.
   * The form removes its submit control on this, so an ordinary retry cannot
   * resubmit — mirroring the campaign lifecycle dialog's `committed`.
   */
  settled: boolean;
};

/**
 * Deliberately carries NO echo of the submitted values. The note lives in the
 * form's own component state and survives the action round trip untouched, so
 * returning a copy would be a second source of truth for the same string — and a
 * reviewer's free-text note about a real receipt is not something to move through
 * more places than it has to.
 */
export const INITIAL_DECISION_ACTION_STATE: DecisionActionState = {
  fieldErrors: {},
  formError: null,
  outcome: null,
  message: null,
  settled: false,
};
