/**
 * PURE STATE MODULE — no "use server", no imports, no I/O.
 *
 * The useActionState shape for the one-click "Send existing-user invitation"
 * confirm form. It lives beside the action rather than inside it because
 * app/(admin)/retailers/[relationshipId]/owner/invite/actions.ts carries the
 * "use server" directive, under which every runtime export must be an async
 * Server Action — a plain object or type there is rejected at build time.
 *
 * The form carries NO editable fields (the recipient email and names come from the
 * authoritative server status, never the browser), so the state needs only an
 * optional error string. Success is signalled by a redirect, never by this state.
 */
export type SendExistingUserState = {
  /** A safe, code-free message for any refusal or transient failure; null when idle. */
  error: string | null;
};

/** The initial state before the first submit. */
export const INITIAL_SEND_EXISTING_USER_STATE: SendExistingUserState = {
  error: null,
};
