// SERVER-ONLY MODULE.
//
// The bridge between an invitation token hash and the CANONICAL INVITED EMAIL, so an
// invited staff member can activate their account by choosing a password alone —
// without ever being asked to type, or being shown, the address they were invited at.
//
// It calls exactly one RPC, public.get_retailer_staff_registration_context, through the
// SERVICE-ROLE client. That RPC is granted to service_role only and revoked from anon
// and authenticated, precisely because it maps a token to an email: reachable by a
// browser, it would let anyone holding a token learn who was invited.
//
// THE EMAIL IS COMPARTMENTALISED BY DESIGN — the two exports below are the whole point.
//
//   getStaffRegistrationView()        returns a DISCRIMINANT ONLY — "register",
//                                     "sign-in" or "unavailable". No email. This is
//                                     what the PAGE calls, so the address cannot reach
//                                     a prop, an RSC payload, the HTML, or client
//                                     JavaScript even by accident.
//   getStaffRegistrationCredentials() returns the email. This is what the ACTION calls,
//                                     immediately before handing it to Supabase Auth.
//
// Splitting them is what makes "the page cannot leak the email" a property of the code
// rather than a rule someone has to remember. A single function returning both would
// put the address one careless `{...ctx}` away from the browser.
//
// NOTHING IS LOGGED. Not the email, not the token hash, not the RPC's error. A failure
// is reported as a category and nothing else.
import {
  createAdminClient,
  SupabaseAdminConfigurationError,
} from "@/lib/supabase/admin";
import { isValidTokenHash } from "@/lib/invitations/existing-user-token";

const REGISTRATION_CONTEXT_RPC = "get_retailer_staff_registration_context" as const;

/** Sanitized operator logging. Never an email, hash, error object, or row. */
function logRegistrationFailure(category: string): void {
  console.error(`[staff-registration] ${category}`);
}

/** The raw shape the RPC returns. Never leaves this module intact. */
type RegistrationContextRow = {
  invited_email?: unknown;
  has_auth_account?: unknown;
};

type RawContext =
  | { status: "ok"; invitedEmail: string; hasAuthAccount: boolean }
  /** Unknown, malformed, expired, revoked, accepted, stale — indistinguishable. */
  | { status: "unavailable" };

/**
 * The single RPC call. Private: both exports below are thin projections of it, and
 * neither the raw row nor the error ever escapes.
 */
async function readContext(tokenHash: string): Promise<RawContext> {
  // Shape-validate first. A malformed value can never match a stored hash, so it exits
  // on the same generic path as a wrong one — without a round trip.
  if (!isValidTokenHash(tokenHash)) return { status: "unavailable" };

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    if (error instanceof SupabaseAdminConfigurationError) {
      logRegistrationFailure("configuration is incomplete");
    } else {
      logRegistrationFailure("setup failed");
    }
    return { status: "unavailable" };
  }

  // Promise.resolve() because the PostgREST builder is a thenable, not a real Promise.
  const result = await Promise.resolve(
    admin.rpc(REGISTRATION_CONTEXT_RPC, { p_token_hash: tokenHash }),
  ).catch(() => null);

  // A throw, or the RPC's own generic refusal, or a shape that is not what the contract
  // promises — all collapse to one outcome. The error is never bound or logged: its
  // message can name tables, columns, functions and policies, and this one is about an
  // invitation the caller may not be entitled to know exists.
  if (result === null || result.error) {
    logRegistrationFailure("context unavailable");
    return { status: "unavailable" };
  }

  const rows = result.data as unknown;
  const row: RegistrationContextRow | undefined = Array.isArray(rows) ? rows[0] : undefined;

  const invitedEmail =
    typeof row?.invited_email === "string" ? row.invited_email.trim() : "";

  if (!row || invitedEmail.length === 0 || typeof row.has_auth_account !== "boolean") {
    logRegistrationFailure("context returned an unusable result");
    return { status: "unavailable" };
  }

  return {
    status: "ok",
    invitedEmail: invitedEmail.toLowerCase(),
    hasAuthAccount: row.has_auth_account,
  };
}

/**
 * What the activation PAGE should render — and nothing more.
 *
 *   "register"     the invited address has no account yet: offer password creation.
 *   "sign-in"      it already has one: offer the universal login instead.
 *   "unavailable"  the token is unknown, malformed, expired, revoked, accepted or
 *                  stale. One screen for all of them.
 *
 * Deliberately carries NO email, so the page has none to render, log, or pass to a
 * Client Component.
 */
export type StaffRegistrationView = "register" | "sign-in" | "unavailable";

export async function getStaffRegistrationView(
  tokenHash: string,
): Promise<StaffRegistrationView> {
  const context = await readContext(tokenHash);
  if (context.status !== "ok") return "unavailable";
  return context.hasAuthAccount ? "sign-in" : "register";
}

export type StaffRegistrationCredentials =
  | { status: "ok"; invitedEmail: string }
  /** Already has an account — the activation form must not proceed. */
  | { status: "already-registered" }
  | { status: "unavailable" };

/**
 * The canonical invited email, for the activation ACTION only.
 *
 * The `already-registered` branch is returned rather than folded into `unavailable`
 * because the action must never create a second account for an address that has one —
 * and because the page's own branch may have gone stale between render and submit. It
 * is the action's last check before Supabase Auth, not a message shown to anyone: the
 * caller maps it to the same generic response as every other refusal.
 */
export async function getStaffRegistrationCredentials(
  tokenHash: string,
): Promise<StaffRegistrationCredentials> {
  const context = await readContext(tokenHash);
  if (context.status !== "ok") return { status: "unavailable" };
  if (context.hasAuthAccount) return { status: "already-registered" };
  return { status: "ok", invitedEmail: context.invitedEmail };
}
