// SERVER-ONLY MODULE.
//
// Two independent rollout switches for the Retailer STAFF invitation flow. They mirror
// lib/features/existing-user-invitations.ts exactly — same browser guard, same
// fail-closed comparison, same call-time read — because they guard the same class of
// thing: a server-side path that reaches the service-role client and an outbound email
// provider.
//
// WHY THEY ARE SERVER-ONLY AND NOT NEXT_PUBLIC_. Next.js statically inlines every
// NEXT_PUBLIC_* value into the client bundle, which would publish the flags to every
// visitor. More importantly each flag stands between a forged POST and a privileged
// path. A gate a browser can read is a gate a browser can edit out; both are computed
// on the server and passed down only as finished markup.
//
// WHAT IS *NOT* GATED, deliberately:
//   * Reading the staff roster and the invitation list. These are ordinary authorized
//     reads with no email dependency.
//   * REVOKING an invitation. A kill switch must never itself be switchable off — an
//     operator who needs to withdraw an invitation must always be able to.
//   * ACCEPTING an invitation. Invitations already delivered must stay acceptable even
//     if sending is paused; pausing the send must not strand a recipient mid-flow.
// Only SENDING (and the new-user registration surface) is gated.

if (typeof window !== "undefined") {
  throw new Error(
    "lib/features/retailer-staff-invitations.ts was imported into browser code. This module reads server-only configuration and must only ever run on the server.",
  );
}

/** The environment variables' names — for MESSAGES and documentation only. */
export const RETAILER_STAFF_INVITATIONS_FLAG_VAR =
  "RETAILER_STAFF_INVITATIONS_ENABLED";
export const RETAILER_STAFF_REGISTRATION_FLAG_VAR =
  "RETAILER_STAFF_REGISTRATION_ENABLED";

/**
 * The ONE value that enables a feature. Compared byte-for-byte against the raw
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
 * Whether an invited person with NO SalesReward account may create one from the
 * invitation acceptance page.
 *
 * DEFAULT OFF, AND CURRENTLY NOT OPERATIONAL. The hosted Supabase project reports
 * `disable_signup: true`, so Supabase Auth refuses `signUp()` regardless of what this
 * flag says. Enabling the flag alone changes nothing; it must be paired with the
 * project-side configuration documented in .env.example. Until then the acceptance
 * page offers sign-in only, which is honest: an invited person who has no account is
 * told to contact whoever invited them rather than being shown a button that cannot
 * work.
 *
 * This is a SEPARATE switch from the send flag above because it opens a different
 * surface — account creation — and must be reviewable and reversible on its own.
 */
export function isRetailerStaffRegistrationEnabled(): boolean {
  return process.env.RETAILER_STAFF_REGISTRATION_ENABLED === ENABLED_VALUE;
}

/**
 * The one user-facing message for the paused send state. Exported so the Server Action
 * and the UI render byte-identical text. It names no environment variable, provider,
 * or configuration detail.
 */
export const RETAILER_STAFF_INVITATIONS_PAUSED_MESSAGE =
  "Staff invitations are temporarily unavailable while this feature is being rolled out.";
