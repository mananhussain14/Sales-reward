/**
 * Shared state contract for the per-invitation Resend and Revoke controls.
 *
 * Lives outside actions.ts because a module with a top-level "use server" directive
 * may only export async functions.
 *
 * The browser-visible surface is two optional strings. No invitation id, token, token
 * hash, email, or database detail is ever placed here — the invitation id travels only
 * INTO the action as a hidden field (an address the database re-checks against the
 * Retailer it derives for itself), never back out.
 */
export type InvitationActionState = {
  error: string | null;
  success: string | null;
};

export const INITIAL_INVITATION_ACTION_STATE: InvitationActionState = {
  error: null,
  success: null,
};
