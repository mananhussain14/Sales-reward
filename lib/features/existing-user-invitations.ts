// SERVER-ONLY MODULE.
//
// The single source of truth for whether EXISTING-USER Retailer Owner invitations
// are enabled. This is a SEPARATE rollout flag from the new-user flow's
// RETAILER_OWNER_INVITATIONS_ENABLED: the existing-user path adds an application-
// owned Resend email dependency and a new acceptance route, so it is gated on its
// own switch and can be enabled or paused independently.
//
// WHY IT IS SERVER-ONLY AND NOT NEXT_PUBLIC_. Next.js statically inlines every
// NEXT_PUBLIC_* value into the client bundle, which would publish the flag to every
// visitor. More importantly this flag stands between a forged POST and the
// service-role preparation RPC + the Resend send. A gate a browser can read is a
// gate a browser can edit out; it is computed on the server and passed down only
// as finished markup. The browser guard below mirrors lib/features/
// retailer-owner-invitations.ts.

if (typeof window !== "undefined") {
  throw new Error(
    "lib/features/existing-user-invitations.ts was imported into browser code. This module reads server-only configuration and must only ever run on the server.",
  );
}

/** The environment variable's name — for MESSAGES and documentation only. */
export const RETAILER_OWNER_EXISTING_USER_INVITATIONS_FLAG_VAR =
  "RETAILER_OWNER_EXISTING_USER_INVITATIONS_ENABLED";

/**
 * The ONE value that enables the feature. Compared byte-for-byte against the raw
 * environment string: "1", "yes", "on", "TRUE", " true ", and "True" are all
 * DISABLED. A flag guarding a service-role code path fails closed, and accepting a
 * family of spellings is how a deployment typo silently arms a feature.
 */
const ENABLED_VALUE = "true";

/**
 * Whether existing-user Retailer Owner invitations may be sent.
 *
 * THE ONLY place RETAILER_OWNER_EXISTING_USER_INVITATIONS_ENABLED is read. Read at
 * CALL time (not captured at module scope) so a restarted process picks up a
 * changed value without a stale cached boolean.
 *
 * Referenced as a literal `process.env.FOO` expression because Next.js only
 * performs static replacement on literals.
 */
export function isExistingUserInvitationsEnabled(): boolean {
  return process.env.RETAILER_OWNER_EXISTING_USER_INVITATIONS_ENABLED === ENABLED_VALUE;
}

/**
 * The one user-facing message for the paused state. Exported so the Server Action
 * and the UI render byte-identical text. It names no environment variable, provider,
 * or configuration detail.
 */
export const EXISTING_USER_INVITATIONS_PAUSED_MESSAGE =
  "Existing-account invitations are temporarily unavailable while this flow is being rolled out.";
