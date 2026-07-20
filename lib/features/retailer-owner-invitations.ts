// SERVER-ONLY MODULE.
//
// The single source of truth for whether Retailer Owner invitations are enabled.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FLAG EXISTS, AND WHEN IT MAY BE TURNED ON
// ─────────────────────────────────────────────────────────────────────────────
// The Retailer Owner invitation feature is BUILT but NOT FINISHED. The database
// lifecycle, the Auth Admin dispatch service, the acceptance callback, the
// password-completion screen, and the audit trail all exist and are correct. What
// does not yet work is EMAIL DELIVERY: a real invitation was dispatched using
// Supabase's DEFAULT invite template, and the resulting link could not be
// processed, because the default template returns access tokens in a URL FRAGMENT
// while /invitations/accept requires the TokenHash query parameters that
// supabase/templates/invite.html produces.
//
// This flag MUST REMAIN DISABLED until all three of the following are true:
//
//   1. Custom SMTP is configured for the Supabase project.
//   2. The custom TokenHash invite template (supabase/templates/invite.html) is
//      installed on the project, replacing the default template.
//   3. The end-to-end test passes: invite link → /invitations/accept →
//      /invitations/complete → password set → membership ACTIVE.
//
// It is a TEMPORARY SAFETY GATE, not a deletion. Nothing under app/invitations,
// lib/invitations, supabase/templates, or the applied migration is removed or
// redesigned by it. Flipping the variable to "true" restores the previous
// behaviour exactly.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT IS SERVER-ONLY, AND WHY IT IS NOT NEXT_PUBLIC_
// ─────────────────────────────────────────────────────────────────────────────
// Next.js statically inlines every NEXT_PUBLIC_* value into the client bundle, so
// that prefix would publish this deployment's feature configuration to every
// visitor. More importantly, the flag is a SECURITY GATE: it is what stands
// between a forged POST and the service-role Auth Admin API. A gate a browser can
// read is a gate whose absence a browser can also infer, and a gate evaluated in
// a Client Component is no gate at all — the value would simply be edited out.
//
// The enabled state is therefore computed on the server and PASSED DOWN as a
// prop to any Client Component that needs it. No Client Component reads
// process.env, and this module exports no environment value — only a boolean.
//
// The browser guard below mirrors lib/supabase/admin.ts. The `server-only`
// package would state this more directly; it is not installed, and no dependency
// is added for it.

if (typeof window !== "undefined") {
  throw new Error(
    "lib/features/retailer-owner-invitations.ts was imported into browser code. This module reads server-only configuration and must only ever run on the server.",
  );
}

/**
 * The environment variable's name. Used for MESSAGES and documentation only —
 * never for the lookup itself, which must be a literal `process.env.FOO`
 * expression for Next.js to replace it statically.
 */
export const RETAILER_OWNER_INVITATIONS_FLAG_VAR =
  "RETAILER_OWNER_INVITATIONS_ENABLED";

/**
 * The ONE value that enables the feature.
 *
 * Compared byte-for-byte against the raw environment string. Deliberately NOT
 * trimmed, NOT lower-cased, and NOT parsed as a general "truthy" token: "1",
 * "yes", "on", "TRUE", " true ", and "True" are all DISABLED. A flag that guards
 * a service-role code path fails closed, and accepting a family of spellings is
 * how a typo in a deployment config silently arms a feature nobody meant to arm.
 *
 * Absent, blank, "false", and any other value alike mean DISABLED. There is no
 * default-on path anywhere in this module.
 */
const ENABLED_VALUE = "true";

/**
 * Whether Retailer Owner invitations may be dispatched.
 *
 * THE ONLY place RETAILER_OWNER_INVITATIONS_ENABLED is read in this codebase.
 * Every caller — the Server Action, the invite page, the Retailer detail page —
 * goes through this function, so no two of them can disagree about the state of
 * the feature, and there is exactly one line to change when the gate is lifted.
 *
 * Read at CALL time rather than captured at module scope, so a restarted process
 * picks up a changed value without a stale cached boolean surviving in a warm
 * module.
 *
 * @returns true only when the variable is exactly the string "true".
 */
export function isRetailerOwnerInvitationsEnabled(): boolean {
  return process.env.RETAILER_OWNER_INVITATIONS_ENABLED === ENABLED_VALUE;
}

/**
 * The one user-facing message for the paused state.
 *
 * Exported so the Server Action and both UI surfaces render byte-identical text.
 *
 * It explains WHAT is happening ("temporarily unavailable") and gives an honest,
 * non-specific reason ("email delivery is being configured"). It deliberately
 * does NOT name the environment variable, the Supabase project, the template, the
 * SMTP provider, or the flag's current value — a message shown to an admin is a
 * message an attacker can read, and deployment configuration is not something to
 * describe to either. It also does not imply that SMTP already works.
 */
export const RETAILER_OWNER_INVITATIONS_PAUSED_MESSAGE =
  "Retailer Owner invitations are temporarily unavailable while email delivery is being configured.";
