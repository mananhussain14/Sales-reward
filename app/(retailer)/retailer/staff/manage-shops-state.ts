import type { AssignableShop } from "@/lib/staff/staff-normalization";

/**
 * The Manage Shops editor's action state.
 *
 * A separate module because ./actions.ts carries the "use server" directive, under which
 * every runtime export must be an async function — a `const` there would be rejected by
 * Next.js. `import type` above is erased at compile time and adds no export.
 *
 * WHAT THIS STATE MAY CARRY, exhaustively: two operator-facing strings, an outcome
 * discriminant, and — only when the assignable-shop set turned out to be stale — the
 * refreshed shop list the server just read for THIS caller. No membership id, no
 * SQLSTATE, no PostgREST detail, no backend message, no token, and no Retailer id.
 */
export type ManageShopsOutcome =
  /** Nothing has been submitted yet in this editor. */
  | "idle"
  /** The RPC committed and the roster was re-read successfully. */
  | "saved"
  /**
   * The RPC COMMITTED, but the canonical roster could not be re-read afterwards (or the
   * response did not carry the counts). Presented as a success with a caveat — never as
   * a failed write, and never with an enabled Save that would resubmit a committed
   * change.
   */
  | "saved-unconfirmed"
  /** Refused before or by the database. `error` carries the operator-facing reason. */
  | "error"
  /**
   * At least one selected shop is no longer in the assignable set the server just read.
   * Nothing was submitted. `refreshedShops` carries the current options so the editor can
   * re-render the picker and the operator can review before saving.
   */
  | "stale-shops";

export type ManageShopsState = {
  outcome: ManageShopsOutcome;
  /** Shown for `error` and `stale-shops`. Never a database or PostgREST message. */
  error: string | null;
  /** Shown for `saved` and `saved-unconfirmed`. Describes a CHANGE, never a total. */
  success: string | null;
  /**
   * Only populated for `stale-shops`: the assignable shops as of the refused attempt.
   * Comes from the same authorized read that already populates the picker, so it
   * discloses nothing the editor was not already showing.
   */
  refreshedShops: AssignableShop[] | null;
};

export const INITIAL_MANAGE_SHOPS_STATE: ManageShopsState = {
  outcome: "idle",
  error: null,
  success: null,
  refreshedShops: null,
};
