/**
 * Shared state for the staff invitation forms. Lives outside the action module because
 * a "use server" module may export only async functions.
 *
 * The browser-visible surface is an optional error, an optional non-error message, and
 * an optional screen switch. There is NO token, hash, email, invitation id or
 * membership id: the hash is read from the HttpOnly cookie server-side, the invited
 * address never leaves the server at all, and nothing of either kind travels through
 * any of these forms.
 *
 * THERE IS DELIBERATELY NO SUCCESS STATE for activation. Creating the account signs the
 * person straight in and redirects them back to the invitation, so there is nothing to
 * report and nothing to wait for. The old "check your email to confirm your account"
 * notice is gone: no confirmation email is sent, because opening the invitation link
 * already proved control of the invited inbox.
 */
export type StaffAcceptState = {
  error: string | null;
  /**
   * Switches the activation form to the existing-account screen.
   *
   * Reached when the invited address turns out to already have an account — including
   * when a CONCURRENT submission created one between the check and the write. That is
   * a race, not a failure, and the remedy is the same either way: sign in. Modelling it
   * as a screen rather than an error is what makes the race invisible to the person.
   */
  mode?: "sign-in" | null;
  /** The explanatory line shown with `mode`. Never an error, never account detail. */
  message?: string | null;
};

export const INITIAL_STAFF_ACCEPT_STATE: StaffAcceptState = {
  error: null,
  mode: null,
  message: null,
};
