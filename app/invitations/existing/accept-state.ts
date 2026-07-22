/**
 * Shared state for the existing-user acceptance form. Lives outside the action
 * module because a "use server" module may export only async functions.
 *
 * The browser-visible surface is a single optional error string. There is no token,
 * no hash, no email, no id — the hash is read from the HttpOnly cookie server-side
 * and never travels through this form.
 */
export type AcceptExistingState = { error: string | null };

export const INITIAL_ACCEPT_EXISTING_STATE: AcceptExistingState = { error: null };
