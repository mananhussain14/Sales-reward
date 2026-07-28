/**
 * The activation/deactivation control's action state.
 *
 * A separate module because ./actions.ts carries the "use server" directive, under which
 * every runtime export must be an async function — a `const` there would be rejected by
 * Next.js. Same split as ./manage-shops-state.ts.
 *
 * WHAT THIS STATE MAY CARRY, exhaustively: two operator-facing strings and an outcome
 * discriminant. No membership id, no role code, no raw membership status, no SQLSTATE, no
 * PostgREST detail, no backend message, no token, and no Retailer id or name.
 */
export type StaffLifecycleOutcome =
  /** Nothing has been submitted yet by this control. */
  | "idle"
  /** The RPC committed AND the status actually moved. */
  | "changed"
  /**
   * The RPC committed as a NO-OP: the membership was already in the requested state, so
   * nothing was written and no audit row was created. Presented as an outcome, not an
   * error — most often it means another operator got there first.
   */
  | "unchanged"
  /**
   * The RPC COMMITTED, but the response could not be described or the canonical roster
   * could not be re-read afterwards. Presented as a success with a caveat — never as a
   * failed write, and never in a state where an ordinary retry would resubmit a change
   * that is already committed.
   */
  | "saved-unconfirmed"
  /** Refused before or by the database. `error` carries the operator-facing reason. */
  | "error";

export type StaffLifecycleState = {
  outcome: StaffLifecycleOutcome;
  /** Shown for `error`. Never a database or PostgREST message. */
  error: string | null;
  /** Shown for `changed`, `unchanged` and `saved-unconfirmed`. */
  success: string | null;
};

export const INITIAL_STAFF_LIFECYCLE_STATE: StaffLifecycleState = {
  outcome: "idle",
  error: null,
  success: null,
};
