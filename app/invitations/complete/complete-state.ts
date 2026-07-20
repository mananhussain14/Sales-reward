/**
 * Shared state contract for the invitation password-completion form.
 *
 * Lives outside actions.ts deliberately, matching app/login/login-state.ts and
 * app/(admin)/retailers/[relationshipId]/shops/new/add-shop-state.ts: a module
 * with a top-level "use server" directive may only export async functions — every
 * export becomes a callable server endpoint — so exporting a plain object or const
 * from there is a runtime error.
 *
 * No "use server" / "use client" directive here on purpose: this module is plain,
 * side-effect-free data that both the Server Action and the Client Component
 * import.
 *
 * THE VALUES FIELD THAT ISN'T HERE
 *   Every other form in this codebase echoes its submitted values back so a
 *   rejected submission does not clear the inputs. This one deliberately does NOT.
 *   The only two inputs are passwords, and a password must never make a second
 *   trip across the network, never be re-rendered into HTML, never enter an RSC
 *   payload, and never sit in React state where an extension or a devtools
 *   snapshot could read it. Retyping a password after a failed attempt is the
 *   correct cost.
 *
 * THE FLAG THAT ISN'T HERE EITHER
 *   An earlier revision carried a `passwordAlreadySet` boolean through this state
 *   and back up as a hidden form field, so a retry could SKIP the password update
 *   and go straight to acceptance. That was a client-controlled bypass: anything
 *   in this type reaches the browser and comes back as attacker-editable form
 *   data, so a forged flag would let the acceptance RPC run in a submission that
 *   never set a credential at all.
 *
 *   It is gone, and nothing replaces it — not a cookie, not a query parameter, not
 *   browser storage. The action now performs the SAME two steps on every single
 *   submission (update the password, then accept), which needs no memory of what a
 *   previous attempt did and therefore has no state for a caller to forge.
 *
 * Everything in this file crosses the network to the browser, so nothing here may
 * carry anything sensitive: there is no invitation id, Auth user id, profile id,
 * membership id, organization id, email, token, SQLSTATE, constraint name, or raw
 * Supabase error in any of these shapes.
 */

/** The form's two inputs. */
export type CompleteInvitationField = "password" | "confirmPassword";

/** Typed state for `useActionState`. This is the entire browser-visible surface. */
export type CompleteInvitationState = {
  /**
   * Per-input messages, all authored in this codebase and all describing the
   * INPUT rather than Auth or the database. Partial because a valid field has no
   * entry.
   */
  fieldErrors: Partial<Record<CompleteInvitationField, string>>;
  /**
   * One safe message for everything that is not a field problem — a rejected
   * password, a failed acceptance, an expired invitation, or a transport error.
   * Never a Supabase, GoTrue, PostgreSQL, SQLSTATE, or policy string.
   */
  formError: string | null;
};

/** The form's state before any submission has occurred. */
export const INITIAL_COMPLETE_INVITATION_STATE: CompleteInvitationState = {
  fieldErrors: {},
  formError: null,
};
