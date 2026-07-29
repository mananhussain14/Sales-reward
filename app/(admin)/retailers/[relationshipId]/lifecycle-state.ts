/**
 * The Retailer deactivate/reactivate control's action state.
 *
 * A separate module because ./actions.ts carries the "use server" directive, under which
 * every runtime export must be an async function — a `const` there would be rejected by
 * Next.js. Same split as ../../../(retailer)/retailer/staff/staff-lifecycle-state.ts.
 *
 * WHAT THIS STATE MAY CARRY, exhaustively: two operator-facing strings and an outcome
 * discriminant. No relationship id, Retailer organization id, Vendor organization id, raw
 * status value, SQLSTATE, PostgREST detail, backend message, or any hint that another Vendor
 * relationship exists.
 */
export type RetailerLifecycleOutcome =
  /** Nothing has been submitted yet by this control. */
  | "idle"
  /** The RPC committed AND both status rows actually moved. */
  | "changed"
  /**
   * The RPC committed as a NO-OP: the Retailer was already in the requested state, so
   * nothing was written and no audit row was created. Presented as an outcome, not an
   * error — most often it means another administrator got there first.
   */
  | "unchanged"
  /**
   * The RPC COMMITTED, but the response could not be described or the canonical detail
   * could not be re-read afterwards. Presented as a success with a caveat — never as a
   * failed write, and never in a state where an ordinary retry would resubmit a change that
   * is already committed.
   */
  | "saved-unconfirmed"
  /** Refused before or by the database. `error` carries the operator-facing reason. */
  | "error";

export type RetailerLifecycleState = {
  outcome: RetailerLifecycleOutcome;
  /** Shown for `error`. Never a database or PostgREST message. */
  error: string | null;
  /** Shown for `changed`, `unchanged` and `saved-unconfirmed`. */
  success: string | null;
};

export const INITIAL_RETAILER_LIFECYCLE_STATE: RetailerLifecycleState = {
  outcome: "idle",
  error: null,
  success: null,
};
