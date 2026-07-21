/**
 * Shared state contract for the Invite Retailer Owner form.
 *
 * Lives outside actions.ts deliberately, matching add-shop-state.ts,
 * onboard-state.ts, and login-state.ts: a module with a top-level "use server"
 * directive may only export async functions — every export becomes a callable
 * server endpoint — so exporting a plain object or const from there is a runtime
 * error.
 *
 * No "use server" / "use client" directive here on purpose: this module is plain,
 * side-effect-free data that both the Server Action and the Client Component
 * import.
 *
 * Everything in this file crosses the network to the browser, so nothing here may
 * carry anything the browser did not already send. There is deliberately no Vendor
 * organization id, Retailer organization id, actor/profile id, invitation id,
 * membership id, Auth user id, role code, permission code, status, SQLSTATE,
 * constraint name, or raw Supabase error in any of these shapes — the browser has
 * no legitimate use for one, and a field that does not exist cannot leak.
 *
 * Note what is ALSO absent: the relationship id. It travels in the form as a
 * hidden input and in the URL as a route segment, but it is not part of the state
 * echoed back — the form already knows it from its prop, and putting it here would
 * be a second copy to keep in step for no benefit.
 */

import type { InviteFormModel } from "@/lib/retailers/owner-status-normalization";

/**
 * The form's three inputs. Named as one union so the field errors and the retained
 * values cannot drift apart: adding an input means adding it here, and both
 * records below fail to typecheck until they account for it.
 */
export type InviteOwnerField = "firstName" | "lastName" | "email";

/**
 * The submitted values, echoed back so a rejected submission does not clear the
 * form. These are the caller's OWN input after trimming and canonicalization —
 * never anything read from the database.
 *
 * Unlike the password-completion form, echoing IS correct here: none of these is a
 * credential, and making an admin retype a colleague's full name because the
 * Retailer happened to be suspended would be gratuitous.
 */
export type InviteOwnerValues = Record<InviteOwnerField, string>;

/** Typed state for `useActionState`. This is the entire browser-visible surface. */
export type InviteOwnerState = {
  /**
   * Per-input messages, all authored in this codebase and all describing the
   * INPUT rather than the database. Partial because a valid field has no entry.
   *
   * `email` additionally carries the two database outcomes specific enough to name
   * a field: the address already has an account, and the Retailer already has an
   * owner. The action maps SQLSTATEs and typed service results — never message
   * strings — to these entries.
   */
  fieldErrors: Partial<Record<InviteOwnerField, string>>;
  /**
   * One safe message for everything that is not a field problem — a refused
   * authorization, a malformed or inaccessible relationship id, an inactive
   * Retailer or relationship, a misconfigured environment, or a transport failure.
   * Never a Supabase, GoTrue, PostgreSQL, SQLSTATE, constraint, function, schema,
   * table, or policy string.
   */
  formError: string | null;
  /** The submitted values to re-render. */
  values: InviteOwnerValues;
};

/** An untouched form: every input blank. */
export const EMPTY_INVITE_OWNER_VALUES: InviteOwnerValues = {
  firstName: "",
  lastName: "",
  email: "",
};

/** The form's state before any submission has occurred. */
export const INITIAL_INVITE_OWNER_STATE: InviteOwnerState = {
  fieldErrors: {},
  formError: null,
  values: EMPTY_INVITE_OWNER_VALUES,
};

/**
 * Seeds the form's initial state from the state-aware model, so a retry, resend,
 * or expiry-replacement opens with the existing recipient prefilled rather than
 * blank. These are DISPLAY prefills only: the Server Action re-reads the owner
 * status before dispatch and, for a resend/retry, forces the RPC's own email
 * regardless of what is submitted — so a tampered prefill cannot change who is
 * invited.
 */
export function buildInitialInviteOwnerState(
  model: InviteFormModel,
): InviteOwnerState {
  return {
    fieldErrors: {},
    formError: null,
    values: {
      firstName: model.initialFirstName,
      lastName: model.initialLastName,
      email: model.initialEmail,
    },
  };
}
