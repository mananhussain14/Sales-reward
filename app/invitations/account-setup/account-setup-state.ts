/**
 * Shared state contract for the GENERIC account-setup form.
 *
 * Lives outside actions.ts deliberately, matching
 * app/invitations/complete/complete-state.ts and app/login/login-state.ts: a module
 * with a top-level "use server" directive may only export async functions — every
 * export becomes a callable server endpoint — so exporting a plain object or a const
 * from there is a runtime error.
 *
 * No "use server" / "use client" directive here on purpose: this module is plain,
 * side-effect-free data that both the Server Action and the Client Component import.
 *
 * NO VALUES FIELD, for the same reason app/invitations/complete/complete-state.ts has
 * none. The only two inputs are passwords, and a password must never make a second
 * trip across the network, never be re-rendered into HTML, never enter an RSC payload,
 * and never sit in React state where an extension or a devtools snapshot could read
 * it. Retyping after a rejected submission is the correct cost.
 *
 * NO STATE THAT COULD BECOME A BYPASS. There is deliberately no "passwordAlreadySet",
 * no user id, no organization id and no role — anything in this type crosses to the
 * browser and returns as attacker-editable form data. The action re-derives identity
 * and authorization from the verified session on every submission, so there is
 * nothing here for a caller to forge.
 *
 * Everything in this file reaches the browser, so nothing here may carry an Auth user
 * id, profile id, membership id, organization id, role id, email address, token,
 * SQLSTATE, constraint name or raw Supabase error.
 */

/** The form's two inputs. */
export type AccountSetupField = "password" | "confirmPassword";

/** Typed state for `useActionState`. This is the entire browser-visible surface. */
export type AccountSetupState = {
  /**
   * Per-input messages, all authored in this codebase and all describing the INPUT
   * rather than Auth or the database. Partial because a valid field has no entry.
   */
  fieldErrors: Partial<Record<AccountSetupField, string>>;
  /**
   * One safe message for everything that is not a field problem — a password Auth
   * refused, or a transport failure. Never a Supabase, GoTrue, PostgreSQL, SQLSTATE
   * or policy string.
   */
  formError: string | null;
};

/** The form's state before any submission has occurred. */
export const INITIAL_ACCOUNT_SETUP_STATE: AccountSetupState = {
  fieldErrors: {},
  formError: null,
};
