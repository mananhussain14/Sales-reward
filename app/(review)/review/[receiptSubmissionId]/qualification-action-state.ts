import type { QualificationFieldErrors } from "@/lib/review/claim-receipt-qualification-input";
import type { QualificationSubmissionOutcome } from "@/lib/review/claim-receipt-qualification-settlement";

/**
 * The state a qualification submission hands back to the panel.
 *
 * A separate module from the action itself so the Client Component can import
 * the shape without importing a `"use server"` file — the convention already
 * used by decision-action-state.ts and campaign-action-state.ts.
 *
 * `settled` rather than `success`, for the same reason the decision form uses
 * it: five outcomes end this form and only two of them wrote anything. All five
 * mean "stop offering to submit"; only `outcome` carries which one happened.
 */
export type { QualificationSubmissionOutcome };

export type QualificationActionState = {
  fieldErrors: QualificationFieldErrors;
  /** One safe sentence. Never a database message, code or hint. */
  formError: string | null;
  /** Null until an authoritative answer came back. */
  outcome: QualificationSubmissionOutcome | null;
  message: string | null;
  /** True once the database has spoken, by any of the five routes. */
  settled: boolean;
  /**
   * The request did not complete, so what the database did is UNKNOWN.
   *
   * Distinct from both success and failure on purpose. `settled` stays false so
   * the reviewer may try again, but the copy must not claim the write failed —
   * it may well have committed. The panel uses this to offer a refresh first.
   */
  uncertain: boolean;
};

export const INITIAL_QUALIFICATION_ACTION_STATE: QualificationActionState = {
  fieldErrors: {},
  formError: null,
  outcome: null,
  message: null,
  settled: false,
  uncertain: false,
};
