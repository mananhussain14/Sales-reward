/**
 * Shared state contract for the sign-in form.
 *
 * This lives outside actions.ts deliberately. A module with a top-level
 * "use server" directive may only export async functions — every export becomes
 * a callable server endpoint — so exporting a plain object from there is a
 * runtime error. The type alone could have stayed (types are erased before the
 * directive is enforced), but keeping the pair together is clearer than
 * splitting them across files.
 *
 * No "use server" / "use client" directive here on purpose: this module is
 * plain, side-effect-free data that both the Server Action and the Client
 * Component import.
 */

/** Typed state for `useActionState`. `error` is the only thing sent to the browser. */
export type LoginState = {
  /** Human-readable message to display, or null when there is nothing to report. */
  error: string | null;
};

/** The form's state before any submission has occurred. */
export const INITIAL_LOGIN_STATE: LoginState = { error: null };
