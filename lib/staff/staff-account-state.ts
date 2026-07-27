/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * The closed account-state vocabulary returned by
 * public.get_retailer_staff_registration_context, and the ONE mapping from a state to
 * the screen the invitation page renders.
 *
 * It lives here, separate from the server module that calls the RPC, so the mapping can
 * be exercised directly by ./staff-account-state.test.ts — importing
 * lib/staff/staff-registration.ts pulls in `next/headers` and the service-role client
 * and cannot be unit-tested at all.
 *
 * ============================================================================
 * WHY FIVE STATES AND NOT A BOOLEAN
 * ============================================================================
 * The shipped design asked one question — "does an auth.users row exist for the invited
 * address?" — and answered "then show sign-in". That dead-ends a person whose row exists
 * but cannot be signed in to: an address invited earlier through the Retailer Owner
 * NEW_USER flow has an UNCONFIRMED, PASSWORD-LESS row, so they were offered a sign-in
 * they could not perform while the activation form was never shown.
 *
 * The fix is not "let them set a password", because that row may already carry a
 * provisioned identity — finalize_retailer_owner_invitation creates a profile, an
 * INVITED membership and a RETAILER_OWNER role assignment against exactly such a row.
 * Setting its first password from a STAFF invitation token would convert that token from
 * a discovery pointer into an account credential, and let its holder claim an identity
 * that is midway through becoming a Retailer Owner.
 *
 * So the states below separate "an empty shell it is safe to activate" from "a
 * half-built identity that must be recovered by email instead".
 */

/**
 * The five states the database may report. Anything else — including a value from a
 * future migration this build predates — is treated as unknown and refused.
 *
 *   NO_ACCOUNT           no auth.users row for the invited address.
 *   ACTIVATION_REQUIRED  a row exists, cannot sign in, has no password, and carries no
 *                        provisioned profile / membership / role assignment.
 *   SIGN_IN              the address has a confirmed, password-capable, non-blocked
 *                        account.
 *   RECOVERY_REQUIRED    cannot sign in, but already carries a password or a
 *                        provisioned identity.
 *   ACCOUNT_BLOCKED      banned, soft-deleted, or ambiguous.
 */
export const STAFF_ACCOUNT_STATES = [
  "NO_ACCOUNT",
  "ACTIVATION_REQUIRED",
  "SIGN_IN",
  "RECOVERY_REQUIRED",
  "ACCOUNT_BLOCKED",
] as const;

export type StaffAccountState = (typeof STAFF_ACCOUNT_STATES)[number];

/** Whether a value from the database is one of the five declared states. */
export function isStaffAccountState(value: unknown): value is StaffAccountState {
  return (
    typeof value === "string" &&
    (STAFF_ACCOUNT_STATES as readonly string[]).includes(value)
  );
}

/**
 * What the signed-out invitation page renders.
 *
 *   "register"     the password-only activation form (no email field — the address is
 *                  derived from the invitation on the server).
 *   "sign-in"      the universal sign-in prompt.
 *   "recover"      "finish securing your existing account" — offers an emailed
 *                  password-reset link, and offers NOTHING that could set a password
 *                  directly.
 *   "blocked"      a neutral support message with no technical detail.
 *   "unavailable"  unknown, malformed, expired, revoked, accepted, foreign or stale
 *                  token — one screen for all of them.
 */
export type StaffRegistrationView =
  | "register"
  | "sign-in"
  | "recover"
  | "blocked"
  | "unavailable";

/**
 * The ONE state → screen mapping.
 *
 * Written as an exhaustive Record rather than a switch with a default, so adding a state
 * to the vocabulary is a TYPE ERROR until this file decides what it looks like. A
 * silently-defaulted new state is how a dangerous case would start rendering the
 * activation form.
 */
const VIEW_FOR_STATE: Record<StaffAccountState, StaffRegistrationView> = {
  // Both take the first-password activation flow. ACTIVATION_REQUIRED is safe for
  // exactly one reason: the database has proven the row is an empty shell.
  NO_ACCOUNT: "register",
  ACTIVATION_REQUIRED: "register",
  SIGN_IN: "sign-in",
  RECOVERY_REQUIRED: "recover",
  ACCOUNT_BLOCKED: "blocked",
};

/**
 * Maps a state to its screen. An unrecognized value — a future state, a malformed row,
 * a null — collapses to "unavailable" rather than being guessed at, which fails toward
 * showing nothing rather than toward offering activation.
 */
export function staffRegistrationViewFor(value: unknown): StaffRegistrationView {
  return isStaffAccountState(value) ? VIEW_FOR_STATE[value] : "unavailable";
}

/**
 * Whether first-password activation may run for a state.
 *
 * THE SECURITY PREDICATE OF THIS MILESTONE, and the reason it is a named function rather
 * than an inline comparison: it is asserted directly by the tests, and every call site
 * that could set a password goes through it. RECOVERY_REQUIRED must never be true here —
 * that is the whole point of the state existing.
 */
export function allowsFirstPasswordActivation(value: unknown): boolean {
  return value === "NO_ACCOUNT" || value === "ACTIVATION_REQUIRED";
}

/**
 * Whether an emailed password recovery may be requested for a state.
 *
 * Deliberately NOT true for SIGN_IN. A usable account has the ordinary sign-in path, and
 * letting an invitation token trigger recovery mail for it would turn the token into a
 * way to spam a working account's inbox — and, for a forwarded token, into a nudge to
 * reset a password that did not need resetting.
 */
export function allowsPasswordRecovery(value: unknown): boolean {
  return value === "RECOVERY_REQUIRED";
}
