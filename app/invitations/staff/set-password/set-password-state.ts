/**
 * Shared state for the recovery set-password form. Lives outside the action module
 * because a "use server" module may export only async functions.
 *
 * The browser-visible surface is ONE optional error string. There is no token, no token
 * hash, no email, no auth user id, no invitation id and no account state: the recovery
 * session is established by /invitations/staff/recover from an HttpOnly cookie, the
 * invitation hash stays in its own HttpOnly cookie, and the invited address never leaves
 * the server at any point in this flow.
 *
 * THERE IS DELIBERATELY NO SUCCESS STATE. Setting the password redirects straight back
 * to the invitation, where the ordinary signed-in path takes over, so there is nothing to
 * report and nothing to wait for.
 */
export type StaffSetPasswordState = {
  error: string | null;
};

export const INITIAL_STAFF_SET_PASSWORD_STATE: StaffSetPasswordState = {
  error: null,
};
