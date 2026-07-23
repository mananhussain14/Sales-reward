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
// THE EMAIL NEVER LEAVES THIS MODULE — the two exports below are the whole point.
//
//   getStaffRegistrationView()      returns a DISCRIMINANT ONLY — "register",
//                                   "sign-in" or "unavailable". This is what the PAGE
//                                   calls, so the address cannot reach a prop, an RSC
//                                   payload, the HTML, or client JavaScript even by
//                                   accident.
//   activateInvitedStaffAccount()   creates the account AND signs the person in, and
//                                   returns a status. The email is read, used and
//                                   discarded inside one function; the Server Action
//                                   that calls it never sees the address at all.
//
// Keeping both the lookup and the two Auth calls behind one export is what makes "the
// email cannot leak" a property of the code rather than a rule someone has to
// remember. An export that returned the address would put it one careless spread away
// from the browser.
//
// WHY admin.createUser AND NOT signUp. Public signup is disabled on the hosted project
// and stays that way: this application never wants an anonymous visitor creating an
// account. The invited person has already proved control of the invited inbox by
// opening the emailed invitation link, so a second confirmation round trip would prove
// nothing and would strand them behind an email that public-signup-disabled never
// sends. The account is therefore created through the Auth Admin API with
// email_confirm: true — confirmed at creation, on the strength of the invitation — and
// the person is signed straight in.
//
// NOTHING IS LOGGED. Not the email, not the token hash, not the RPC's error. A failure
// is reported as a category and nothing else.
import {
  createAdminClient,
  SupabaseAdminConfigurationError,
} from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
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

export type StaffActivationResult =
  /** The account was created (already confirmed) and the person is now signed in. */
  | { status: "activated" }
  /**
   * The invited address already has an account — either the context said so, or a
   * concurrent request created one between the check and the write. Both are the same
   * fact and the same remedy: sign in instead. The caller switches the screen rather
   * than reporting an error, so a race is invisible to the person.
   */
  | { status: "already-registered" }
  /** Unavailable invitation, Auth refusal, or sign-in failure. One generic outcome. */
  | { status: "unavailable" };

/**
 * Creates the invited person's account and signs them in.
 *
 * THE EMAIL IS DERIVED, NEVER SUPPLIED. It comes from the invitation the token hash
 * resolves — the same canonical address the acceptance RPC will later require the
 * signed-in user's confirmed email to equal. No parameter carries an address, so no
 * caller can nominate one.
 *
 * TWO CLIENTS, EACH FOR ITS OWN REASON:
 *   admin (service-role)  auth.admin.createUser is the only way to create an account
 *                         for SOMEBODY ELSE, and the only way to mark it confirmed
 *                         without an email round trip. It writes no cookie — the admin
 *                         client has sessions disabled entirely.
 *   server (cookie-aware) signInWithPassword must run on the request's own cookie
 *                         store, because establishing THIS visitor's session is the
 *                         whole point of the second step.
 *
 * email_confirm: true is the substantive decision. The invitation link was delivered to
 * the invited inbox and the person opened it, which is the same proof a confirmation
 * email would gather — so gathering it twice would only add a step that cannot complete
 * while public signup is disabled.
 *
 * NOTHING IS RETURNED OR LOGGED. Not the address, not the password, not the token hash,
 * not the created user's id, and not any Auth error. Only a status.
 */
export async function activateInvitedStaffAccount(
  tokenHash: string,
  password: string,
): Promise<StaffActivationResult> {
  const context = await readContext(tokenHash);

  // An unknown, malformed, expired, revoked, accepted or stale invitation.
  if (context.status !== "ok") return { status: "unavailable" };

  // The page would not have shown the activation form in this case; reaching it means
  // the state changed underneath, or the request was forged. Either way the remedy is
  // the same, and nothing is created.
  if (context.hasAuthAccount) return { status: "already-registered" };

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

  // ---------------------------------------------------------------------------
  // 1. Create the account, already confirmed.
  // ---------------------------------------------------------------------------
  const created = await Promise.resolve(
    admin.auth.admin.createUser({
      email: context.invitedEmail,
      password,
      email_confirm: true,
    }),
  ).catch(() => null);

  if (created === null) {
    // A transport-level throw can carry the request body, which here holds the address
    // AND the password. Nothing is bound, inspected, or logged.
    logRegistrationFailure("account creation threw");
    return { status: "unavailable" };
  }

  if (created.error) {
    // THE CONCURRENCY CASE. GoTrue refuses to create an address that already exists,
    // which is exactly what a second simultaneous submission produces. Matched on the
    // error CODE where GoTrue provides one, with a narrow status fallback — never on
    // message text, which is one upgrade away from changing. This mirrors the
    // classification the Retailer Owner invitation flow already uses. Neither the code
    // nor the message is returned or logged.
    const code = (created.error as { code?: string }).code;
    const status = (created.error as { status?: number }).status;

    if (code === "email_exists" || code === "user_already_exists" || status === 422) {
      return { status: "already-registered" };
    }

    logRegistrationFailure("account creation was refused");
    return { status: "unavailable" };
  }

  // ---------------------------------------------------------------------------
  // 2. Sign them in, on this request's own cookies.
  // ---------------------------------------------------------------------------
  // The account exists and is confirmed from here on. A failure below therefore does
  // NOT mean "activation failed" in the sense of nothing having happened — it means the
  // session could not be established — so the caller's generic message invites a retry
  // and the person can also simply sign in at /login. Reporting it as a creation
  // failure would send them round a loop that now hits the already-registered branch.
  const supabase = await createClient();

  const signedIn = await Promise.resolve(
    supabase.auth.signInWithPassword({ email: context.invitedEmail, password }),
  ).catch(() => null);

  if (signedIn === null || signedIn.error) {
    // The thrown value and the Auth error are both deliberately unbound: a transport
    // exception can carry the password, and an auth error can echo the identifier.
    logRegistrationFailure("sign-in after activation failed");
    return { status: "unavailable" };
  }

  return { status: "activated" };
}
