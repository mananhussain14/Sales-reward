import type { QualificationFieldErrors } from "@/lib/review/claim-receipt-qualification-input";

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
export type QualificationSubmissionOutcome =
  | "EXCLUDED"
  | "ALREADY_EXCLUDED"
  | "REINSTATED"
  | "ALREADY_REINSTATED"
  | "CONFLICT";

export type QualificationActionState = {
  fieldErrors: QualificationFieldErrors;
  /** One safe sentence. Never a database message, code or hint. */
  formError: string | null;
  /** Null until an authoritative answer came back. */
  outcome: QualificationSubmissionOutcome | null;
  message: string | null;
  /** True once the database has spoken, by any of the five routes. */
  settled: boolean;
};

export const INITIAL_QUALIFICATION_ACTION_STATE: QualificationActionState = {
  fieldErrors: {},
  formError: null,
  outcome: null,
  message: null,
  settled: false,
};
