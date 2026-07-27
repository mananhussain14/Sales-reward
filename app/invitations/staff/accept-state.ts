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

/**
 * State for the password-RECOVERY request form.
 *
 * Shown when the invited address has an account that cannot be signed in to but already
 * carries a provisioned identity — the case that used to dead-end on an unusable sign-in
 * screen. The remedy is an emailed reset link, never a password field on this page.
 *
 * `sent` is deliberately NOT a claim that an email was delivered. Supabase Auth decides
 * that, and its own throttling may mean no new message goes out for a request made
 * moments after the last one. The copy says a link is on its way if one is needed, which
 * is true either way and discloses nothing about the account beyond what this screen
 * already implies.
 *
 * There is no token, hash, email, auth user id or account state here — the action reads
 * the invitation hash from the HttpOnly cookie and resolves the address server-side.
 */
export type StaffRecoveryState = {
  error: string | null;
  sent: boolean;
};

export const INITIAL_STAFF_RECOVERY_STATE: StaffRecoveryState = {
  error: null,
  sent: false,
};

/**
 * The confirmation shown once a recovery request has been accepted.
 *
 * It lives here, in a plain module both the Server Action layer and the Client Component
 * can import, so the wording exists once. It deliberately does NOT claim an email was
 * delivered — Supabase Auth throttles repeat requests, and a second press moments after
 * the first may legitimately send nothing — and it does NOT name the address, because
 * the invited person already knows which mailbox to check and a stranger holding a
 * forwarded link must not learn it.
 */
export const STAFF_RECOVERY_SENT_MESSAGE =
  "If your account needs it, a password reset link is on its way to the address you were invited at. Open it to finish setting up, then come back here.";
