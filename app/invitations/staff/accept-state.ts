/**
 * Shared state for the staff acceptance forms. Lives outside the action module because
 * a "use server" module may export only async functions.
 *
 * The browser-visible surface is an optional error and an optional notice. There is no
 * token, no hash, no email, no invitation id, no membership id — the hash is read from
 * the HttpOnly cookie server-side and never travels through any of these forms.
 */
export type StaffAcceptState = {
  error: string | null;
  /** A non-error message, e.g. after requesting an account confirmation email. */
  notice: string | null;
};

export const INITIAL_STAFF_ACCEPT_STATE: StaffAcceptState = {
  error: null,
  notice: null,
};
