// SERVER-ONLY MODULE.
//
// Everything the staff invitation flow does BEFORE the person has a usable session:
// classifying the invited address, activating a brand-new account, and requesting a
// password-recovery email for an account that exists but cannot be signed in to.
//
// ============================================================================
// THE DEFECT THIS MODULE'S CONTRACT WAS REPAIRED TO FIX
// ============================================================================
// The previous version asked the database one question — "does an auth.users row exist
// for the invited address?" — and rendered sign-in whenever it did. An address invited
// earlier through the Retailer Owner NEW_USER flow has a row that is UNCONFIRMED and
// carries NO PASSWORD, so the person was offered a sign-in they could not perform while
// the activation form was never shown. There was no way out of that screen.
//
// It is now classified into five states by
// public.get_retailer_staff_registration_context (migration 20260808090000), and the
// dangerous middle case gets an emailed recovery link rather than a password form. See
// ./staff-account-state.ts for why "just let them set a password" is unsafe.
//
// ============================================================================
// THE INVITED EMAIL, AND HOW LITTLE OF THE CODE CAN SEE IT
// ============================================================================
// The classification RPC NO LONGER RETURNS AN ADDRESS AT ALL. The address comes from a
// second, separate service-role-only RPC,
// public.resolve_retailer_staff_invitation_recipient, which is called by exactly two
// private helpers in this file — the two operations that must act on the mailbox. The
// page's path cannot obtain an address even by accident, because the function it calls
// does not return one.
//
// The exports below are the whole public surface, and none of them carries an address:
//
//   getStaffRegistrationView()               a DISCRIMINANT ONLY.
//   activateInvitedStaffAccount()            creates or completes the account AND signs
//                                            the person in; returns a status.
//   requestInvitedStaffPasswordRecovery()    sends the recovery email; returns a status.
//
// WHY admin.createUser AND NOT signUp. Public signup is disabled on the hosted project
// and stays that way: this application never wants an anonymous visitor creating an
// account. The invited person has already proved control of the invited inbox by opening
// the emailed invitation link, so a second confirmation round trip would prove nothing
// and would strand them behind an email that public-signup-disabled never sends.
//
// NOTHING IS LOGGED. Not the email, the token hash, the password, the recovery URL, or
// any Auth/RPC error. A failure is reported as a category and nothing else.
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import {
  createAdminClient,
  SupabaseAdminConfigurationError,
} from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/env/supabase";
import { isValidTokenHash } from "@/lib/invitations/existing-user-token";
import {
  allowsFirstPasswordActivation,
  allowsPasswordRecovery,
  isStaffAccountState,
  staffRegistrationViewFor,
  type StaffAccountState,
  type StaffRegistrationView,
} from "@/lib/staff/staff-account-state";

const REGISTRATION_CONTEXT_RPC = "get_retailer_staff_registration_context" as const;
const RECIPIENT_RPC = "resolve_retailer_staff_invitation_recipient" as const;

/**
 * Where the recovery link lands. A FIXED internal path under the staff invitation route,
 * combined with APP_ORIGIN — never a value read from a request, a form, or the database,
 * so there is no caller-controlled destination and an open redirect is impossible.
 *
 * It must sit under /invitations/staff because that is the invitation cookie's path: a
 * recovery link that landed anywhere else would arrive without the invitation hash and
 * strand the person a second time.
 */
export const STAFF_RECOVERY_LANDING_PATH = "/invitations/staff/recover";

/** Sanitized operator logging. Never an email, hash, URL, error object, or row. */
function logRegistrationFailure(category: string): void {
  console.error(`[staff-registration] ${category}`);
}

export type { StaffRegistrationView };

/* ---------------------------------------------------------------------------
 * The two RPC reads
 * ------------------------------------------------------------------------- */

type ContextResult =
  | { status: "ok"; accountState: StaffAccountState }
  /** Unknown, malformed, expired, revoked, accepted, stale — indistinguishable. */
  | { status: "unavailable" };

/**
 * The classification. Private, because every export is a projection of it.
 *
 * Returns NO ADDRESS — the RPC has none to give since migration 20260808090000.
 */
async function readContext(tokenHash: string): Promise<ContextResult> {
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

  // A throw, the RPC's own generic refusal, or a shape that is not what the contract
  // promises — all collapse to one outcome. The error is never bound or logged: its
  // message can name tables, columns, functions and policies, and this one is about an
  // invitation the caller may not be entitled to know exists.
  if (result === null || result.error) {
    logRegistrationFailure("context unavailable");
    return { status: "unavailable" };
  }

  const rows = result.data as unknown;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const accountState = (row as { account_state?: unknown } | undefined)?.account_state;

  // An unrecognized state — a future migration this build predates, or a malformed row —
  // is refused rather than guessed at. Failing toward "show nothing" is safe; failing
  // toward "offer activation" would not be.
  if (!isStaffAccountState(accountState)) {
    logRegistrationFailure("context returned an unusable result");
    return { status: "unavailable" };
  }

  return { status: "ok", accountState };
}

/**
 * The invited address, from the SEPARATE service-role-only RPC.
 *
 * Called by exactly two places in this file, both of which use it immediately and
 * discard it. It is never returned by an export, never placed in a result, never
 * rendered, and never logged.
 */
async function readRecipientEmail(
  admin: ReturnType<typeof createAdminClient>,
  tokenHash: string,
): Promise<string | null> {
  const result = await Promise.resolve(
    admin.rpc(RECIPIENT_RPC, { p_token_hash: tokenHash }),
  ).catch(() => null);

  if (result === null || result.error) {
    logRegistrationFailure("recipient unavailable");
    return null;
  }

  const rows = result.data as unknown;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  const email = (row as { invited_email?: unknown } | undefined)?.invited_email;

  if (typeof email !== "string" || email.trim().length === 0) {
    logRegistrationFailure("recipient returned an unusable result");
    return null;
  }

  return email.trim().toLowerCase();
}

/**
 * What the activation PAGE should render — and nothing more.
 *
 * Deliberately carries NO email and NO state name, so the page has neither to render,
 * log, or pass to a Client Component.
 */
export async function getStaffRegistrationView(
  tokenHash: string,
): Promise<StaffRegistrationView> {
  const context = await readContext(tokenHash);
  if (context.status !== "ok") return "unavailable";
  return staffRegistrationViewFor(context.accountState);
}

/* ---------------------------------------------------------------------------
 * First-password activation
 * ------------------------------------------------------------------------- */

export type StaffActivationResult =
  /** The account was created or completed (confirmed) and the person is signed in. */
  | { status: "activated" }
  /**
   * The invited address already has a usable account — either the context said SIGN_IN,
   * or a concurrent request created one between the check and the write. Both are the
   * same fact and the same remedy: sign in instead.
   */
  | { status: "already-registered" }
  /**
   * The address has an account that cannot sign in AND already carries a provisioned
   * identity. First-password activation is REFUSED for it — see ./staff-account-state.ts
   * — and the caller must switch to the recovery screen.
   */
  | { status: "recovery-required" }
  /** Unavailable invitation, blocked account, Auth refusal, or sign-in failure. */
  | { status: "unavailable" };

/**
 * The maximum number of Auth pages scanned when resolving the existing shell account's
 * id for the ACTIVATION_REQUIRED path.
 *
 * The installed @supabase/auth-js admin API exposes no lookup-by-email (`listUsers`
 * takes only `page`/`perPage`), so the id of an already-existing shell must be found by
 * scanning. This bound — 10 pages of 1000 — is far beyond this application's scale and
 * exists so a pathological user table cannot turn one activation into an unbounded scan.
 * Exceeding it fails CLOSED to `unavailable`; the person is not left without a route,
 * because every other state either creates a fresh account or uses recovery, neither of
 * which needs an id. Stated as a known limitation in the audit document.
 */
const MAX_AUTH_PAGES = 10;
const AUTH_PAGE_SIZE = 1000;

/** Resolves an existing Auth user's id by address. Returns null if not found. */
async function findAuthUserId(
  admin: ReturnType<typeof createAdminClient>,
  email: string,
): Promise<string | null> {
  for (let page = 1; page <= MAX_AUTH_PAGES; page += 1) {
    const result = await Promise.resolve(
      admin.auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE }),
    ).catch(() => null);

    if (result === null || result.error) {
      logRegistrationFailure("account lookup failed");
      return null;
    }

    const users = result.data?.users ?? [];

    for (const user of users) {
      if ((user.email ?? "").trim().toLowerCase() === email) {
        return user.id;
      }
    }

    if (users.length < AUTH_PAGE_SIZE) return null;
  }

  logRegistrationFailure("account lookup exceeded its bound");
  return null;
}

/**
 * Creates (or completes) the invited person's account and signs them in.
 *
 * THE EMAIL IS DERIVED, NEVER SUPPLIED. It comes from the invitation the token hash
 * resolves — the same canonical address the acceptance RPC will later require the
 * signed-in user's confirmed email to equal. No parameter carries an address, so no
 * caller can nominate one.
 *
 * THE STATE GATE IS THE SECURITY CONTROL. `allowsFirstPasswordActivation` admits exactly
 * NO_ACCOUNT and ACTIVATION_REQUIRED. RECOVERY_REQUIRED is refused here even though the
 * page would not have offered the form for it, because a Server Action is a public
 * endpoint and a hand-crafted POST reaches this line regardless of what was rendered.
 *
 * email_confirm: true is the substantive decision, and it applies to both admitted
 * states. The invitation link was delivered to the invited inbox and the person opened
 * it, which is the same proof a confirmation email would gather.
 *
 * NOTHING IS RETURNED OR LOGGED. Not the address, the password, the token hash, the
 * created user's id, or any Auth error. Only a status.
 */
export async function activateInvitedStaffAccount(
  tokenHash: string,
  password: string,
): Promise<StaffActivationResult> {
  const context = await readContext(tokenHash);

  if (context.status !== "ok") return { status: "unavailable" };

  if (context.accountState === "SIGN_IN") return { status: "already-registered" };

  if (allowsPasswordRecovery(context.accountState)) {
    return { status: "recovery-required" };
  }

  // ACCOUNT_BLOCKED, or any state this build does not admit.
  if (!allowsFirstPasswordActivation(context.accountState)) {
    return { status: "unavailable" };
  }

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

  const invitedEmail = await readRecipientEmail(admin, tokenHash);
  if (invitedEmail === null) return { status: "unavailable" };

  // ---------------------------------------------------------------------------
  // 1. Create the account, or complete the existing empty shell.
  // ---------------------------------------------------------------------------
  if (context.accountState === "NO_ACCOUNT") {
    const created = await Promise.resolve(
      admin.auth.admin.createUser({
        email: invitedEmail,
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
      // which is what a second simultaneous submission produces. Matched on the error
      // CODE where GoTrue provides one, with a narrow status fallback — never on message
      // text. Neither the code nor the message is returned or logged.
      const code = (created.error as { code?: string }).code;
      const status = (created.error as { status?: number }).status;

      if (code === "email_exists" || code === "user_already_exists" || status === 422) {
        return { status: "already-registered" };
      }

      logRegistrationFailure("account creation was refused");
      return { status: "unavailable" };
    }
  } else {
    // ACTIVATION_REQUIRED: the row exists but the database has proven it is an empty
    // shell — unconfirmed, no password, and no profile, membership or role assignment.
    // Setting its first password is therefore equivalent to creating the account, which
    // is the only reason this branch is allowed to exist at all.
    const userId = await findAuthUserId(admin, invitedEmail);

    if (userId === null) {
      // The row the database saw is not resolvable through the Auth API — a race, or the
      // scan bound above. Nothing is written.
      return { status: "unavailable" };
    }

    const updated = await Promise.resolve(
      admin.auth.admin.updateUserById(userId, { password, email_confirm: true }),
    ).catch(() => null);

    if (updated === null) {
      logRegistrationFailure("account completion threw");
      return { status: "unavailable" };
    }

    if (updated.error) {
      logRegistrationFailure("account completion was refused");
      return { status: "unavailable" };
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Sign them in, on this request's own cookies.
  // ---------------------------------------------------------------------------
  // The account exists and is confirmed from here on. A failure below therefore does NOT
  // mean "activation failed" in the sense of nothing having happened — it means the
  // session could not be established — so the caller's generic message invites a retry
  // and the person can also simply sign in at /login.
  const supabase = await createClient();

  const signedIn = await Promise.resolve(
    supabase.auth.signInWithPassword({ email: invitedEmail, password }),
  ).catch(() => null);

  if (signedIn === null || signedIn.error) {
    // The thrown value and the Auth error are both deliberately unbound: a transport
    // exception can carry the password, and an auth error can echo the identifier.
    logRegistrationFailure("sign-in after activation failed");
    return { status: "unavailable" };
  }

  return { status: "activated" };
}

/* ---------------------------------------------------------------------------
 * Password recovery
 * ------------------------------------------------------------------------- */

export type StaffRecoveryResult =
  /**
   * The recovery request was accepted by Supabase Auth. Deliberately NOT "an email was
   * delivered" — the provider decides that, and its own throttling may mean no new
   * message is sent for a request made moments after the last one. The caller's copy
   * says "if that address needs it, a link is on its way", which is true either way.
   */
  | { status: "requested" }
  /** The invitation or the account state does not permit recovery. Generic. */
  | { status: "refused" }
  /** Configuration, transport, or an Auth refusal. Retryable. */
  | { status: "unavailable" };

/**
 * Sends a password-recovery email to the invited address.
 *
 * THE ONLY INPUT IS THE INVITATION TOKEN HASH, which the caller reads from the scoped
 * HttpOnly cookie. No address, user id, invitation id or organization id is accepted
 * from, or reachable by, the browser: the address is resolved server-side from the
 * invitation and used immediately.
 *
 * IT DISCLOSES NOTHING NEW. Recovery is offered only for RECOVERY_REQUIRED, a state the
 * page has already acted on by rendering this screen, so a caller learns nothing from
 * the result that the screen did not already tell them. SIGN_IN is refused here on
 * purpose — a usable account has the ordinary sign-in path, and letting an invitation
 * token trigger recovery mail for one would turn the token into a way to disturb a
 * working account.
 *
 * NOT the service-role client. Recovery is a public Auth endpoint and needs no
 * elevation, so it is requested with the publishable key. The client is built here
 * rather than reused from @/lib/supabase/server because that one is cookie-bound and in
 * PKCE mode: this request establishes no session and must write no cookie, and the
 * emailed link is verified server-side by /invitations/staff/recover using the token
 * hash the email template emits.
 */
export async function requestInvitedStaffPasswordRecovery(
  tokenHash: string,
): Promise<StaffRecoveryResult> {
  const context = await readContext(tokenHash);

  if (context.status !== "ok") return { status: "refused" };

  // The gate. Everything except RECOVERY_REQUIRED is refused, including SIGN_IN.
  if (!allowsPasswordRecovery(context.accountState)) {
    return { status: "refused" };
  }

  const appOrigin = readAppOrigin();
  if (appOrigin === null) {
    logRegistrationFailure("configuration is incomplete");
    return { status: "unavailable" };
  }

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

  const invitedEmail = await readRecipientEmail(admin, tokenHash);
  if (invitedEmail === null) return { status: "unavailable" };

  let env: ReturnType<typeof getSupabaseEnv>;
  try {
    env = getSupabaseEnv();
  } catch {
    logRegistrationFailure("configuration is incomplete");
    return { status: "unavailable" };
  }

  const anon = createSupabaseClient(env.url, env.publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      // Implicit rather than PKCE: no code verifier is stored anywhere, because the
      // emailed link is exchanged server-side from its token hash, not from a code.
      flowType: "implicit",
    },
  });

  const sent = await Promise.resolve(
    anon.auth.resetPasswordForEmail(invitedEmail, {
      // A FIXED internal path on the configured origin. GoTrue additionally checks it
      // against the project's redirect allow-list, so even this value cannot become an
      // open redirect.
      redirectTo: `${appOrigin}${STAFF_RECOVERY_LANDING_PATH}`,
    }),
  ).catch(() => null);

  if (sent === null) {
    // A transport throw can carry the request body, which holds the address.
    logRegistrationFailure("recovery request threw");
    return { status: "unavailable" };
  }

  if (sent.error) {
    // Includes the provider's own rate limiting. The error is never bound, returned or
    // logged — its message distinguishes "too many requests" from "unknown address",
    // which is exactly the discrimination this must not expose.
    logRegistrationFailure("recovery request was refused");
    return { status: "unavailable" };
  }

  return { status: "requested" };
}

/**
 * The configured application origin, validated and reduced to an origin.
 *
 * A literal `process.env.APP_ORIGIN` expression because Next.js only performs static
 * replacement on literals. Returns null rather than throwing so the caller reports a
 * retryable failure instead of a stack trace.
 */
function readAppOrigin(): string | null {
  const configured = process.env.APP_ORIGIN;
  if (typeof configured !== "string" || configured.trim().length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(configured.trim());
  } catch {
    return null;
  }

  const isLoopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    return null;
  }

  return parsed.origin;
}
