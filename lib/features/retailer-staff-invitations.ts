// SERVER-ONLY MODULE.
//
// The rollout switch for SENDING Retailer STAFF invitations. It mirrors
// lib/features/existing-user-invitations.ts exactly — same browser guard, same
// fail-closed comparison, same call-time read — because it guards the same class of
// thing: a server-side path that reaches the service-role client and an outbound email
// provider.
//
// WHY IT IS SERVER-ONLY AND NOT NEXT_PUBLIC_. Next.js statically inlines every
// NEXT_PUBLIC_* value into the client bundle, which would publish the flag to every
// visitor. More importantly the flag stands between a forged POST and a privileged
// path. A gate a browser can read is a gate a browser can edit out; it is computed on
// the server and passed down only as finished markup.
//
// WHAT IS *NOT* GATED, deliberately:
//   * Reading the staff roster and the invitation list. These are ordinary authorized
//     reads with no email dependency.
//   * REVOKING an invitation. A kill switch must never itself be switchable off — an
//     operator who needs to withdraw an invitation must always be able to.
//   * ACCEPTING an invitation, or ACTIVATING an account from one. Invitations already
//     delivered must stay usable even if sending is paused; pausing the send must not
//     strand a recipient mid-flow.
// Only SENDING is gated.

if (typeof window !== "undefined") {
  throw new Error(
    "lib/features/retailer-staff-invitations.ts was imported into browser code. This module reads server-only configuration and must only ever run on the server.",
  );
}

/** The environment variable's name — for MESSAGES and documentation only. */
export const RETAILER_STAFF_INVITATIONS_FLAG_VAR =
  "RETAILER_STAFF_INVITATIONS_ENABLED";

/**
 * The ONE value that enables the feature. Compared byte-for-byte against the raw
 * environment string: "1", "yes", "on", "TRUE", " true ", and "True" are all DISABLED.
 * A flag guarding a service-role code path fails closed, and accepting a family of
 * spellings is how a deployment typo silently arms a feature.
 */
const ENABLED_VALUE = "true";

/**
 * Whether Retailer staff invitations may be SENT (a fresh invite or a resend).
 *
 * THE ONLY place RETAILER_STAFF_INVITATIONS_ENABLED is read. Read at CALL time (not
 * captured at module scope) so a restarted process picks up a changed value without a
 * stale cached boolean. Referenced as a literal `process.env.FOO` expression because
 * Next.js only performs static replacement on literals.
 */
export function isRetailerStaffInvitationsEnabled(): boolean {
  return process.env.RETAILER_STAFF_INVITATIONS_ENABLED === ENABLED_VALUE;
}

/**
 * The one user-facing message for the paused send state. Exported so the Server Action
 * and the UI render byte-identical text. It names no environment variable, provider,
 * or configuration detail.
 */
export const RETAILER_STAFF_INVITATIONS_PAUSED_MESSAGE =
  "Staff invitations are temporarily unavailable while this feature is being rolled out.";
