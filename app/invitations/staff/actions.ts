"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LANDING_ROUTES } from "@/lib/auth/landing-decision";
import {
  clearStaffInviteCookie,
  readStaffInviteHash,
} from "@/lib/staff/staff-invite-cookie";
import { acceptStaffInvitation } from "@/lib/staff/staff-acceptance";
import { getStaffRegistrationCredentials } from "@/lib/staff/staff-registration";
import { resolveAuthenticatedLanding } from "@/lib/auth/authenticated-landing";
import { validatePassword } from "@/lib/auth/password-policy";
import type { StaffAcceptState } from "@/app/invitations/staff/accept-state";

/**
 * Server Actions for the staff invitation acceptance page.
 *
 * THE TOKEN HASH COMES ONLY FROM THE HttpOnly COOKIE — never from form data. None of
 * these forms posts a token or a hash, and none of these actions reads a form field
 * for one; a hand-crafted POST carrying either is ignored. Acceptance is authorized
 * entirely by the database RPC, which resolves auth.uid(), requires a CONFIRMED Auth
 * email that exactly matches the invitation's canonical address, and refuses every
 * other case with one generic error.
 *
 * NO PROFILE, MEMBERSHIP, ROLE OR SHOP WRITE HAPPENS IN APPLICATION CODE. `.from(`
 * appears nowhere in this module. public.accept_retailer_staff_invitation performs the
 * profile creation or permitted activation, the ACTIVE membership, the single
 * member-role edge, the Sales Staff shop rows, the invitation finalization, the token
 * clearing and the audit event — atomically, in one transaction, rolling all of it
 * back together on any failure.
 *
 * EVERY REDIRECT TARGET IS A FIXED INTERNAL LITERAL. No caller-supplied path reaches a
 * redirect here, so an open redirect is impossible by construction. The only `next`
 * value in this flow is the constant "/invitations/staff" placed on the sign-in link,
 * and the login page re-validates even that through resolveSafeNextPath.
 *
 * Because of the "use server" directive, every runtime export here is a callable
 * server endpoint, so Next.js rejects anything that is not an async function. The
 * state type lives in ./accept-state.
 */

/** Shown for any refusal — wrong account, unverified, expired, revoked, accepted. */
const GENERIC_ERROR =
  "This invitation can no longer be accepted. Please ask the person who invited you to send a new one.";

/** Shown for a transient failure where retrying is worthwhile. */
const RETRY_ERROR = "Something went wrong. Please try again.";

/** The safe internal return path for this flow. A constant, never a caller value. */
const RETURN_PATH = "/invitations/staff";

/* ---------------------------------------------------------------------------
 * Accept
 * ------------------------------------------------------------------------- */

export async function acceptStaffInvitationAction(
  _prevState: StaffAcceptState,
  _formData: FormData,
): Promise<StaffAcceptState> {
  // The hash is read server-side from the HttpOnly cookie. No FormData is consulted.
  const tokenHash = await readStaffInviteHash();
  if (!tokenHash) {
    return { error: GENERIC_ERROR, notice: null };
  }

  // Require a verified session for clean UX; the RPC also fails closed without one.
  const supabase = await createClient();
  let hasSession = false;
  try {
    const { data } = await supabase.auth.getClaims();
    hasSession = Boolean(data?.claims?.sub);
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can carry
    // token material.
    hasSession = false;
  }

  // Outside any try/catch: redirect() signals by throwing NEXT_REDIRECT.
  if (!hasSession) {
    redirect(`/login?next=${RETURN_PATH}`);
  }

  const result = await acceptStaffInvitation(tokenHash);

  if (result.status === "unavailable") {
    return { error: RETRY_ERROR, notice: null };
  }
  if (result.status === "refused") {
    return { error: GENERIC_ERROR, notice: null };
  }

  // Accepted. The caller is now an ACTIVE member of the Retailer with exactly one
  // staff role. Clear the single-use cookie and drop any cached render produced before
  // the membership existed, so the portal's authorization resolvers re-run.
  await clearStaffInviteCookie();
  revalidatePath("/", "layout");

  // Land them where their NEW role is actually authorized, by asking the same
  // server-side resolver the sign-in action uses. The membership now exists, so the
  // resolver sees it: a RETAILER_MANAGER resolves as a roster reader and lands on
  // /retailer/staff, a SALES_STAFF member resolves as a receipt submitter and lands on
  // /retailer/receipts.
  //
  // Deriving it beats hard-coding a route per role: this action never learns which
  // role the invitation carried, and it does not need to — the permission mappings in
  // SQL decide, exactly as they do at sign-in.
  //
  // Every destination the resolver can produce is a fixed internal literal from
  // LANDING_ROUTES, so there is no open-redirect surface. A resolver failure falls back
  // to the portal overview, which performs its own authorization and will redirect
  // onward if that is not their page.
  let destination: string = LANDING_ROUTES.retailer;
  try {
    const landing = await resolveAuthenticatedLanding();
    if (landing.kind !== "unavailable") {
      destination = landing.destination;
    }
  } catch {
    // The thrown value is deliberately not bound or logged. The membership was created
    // either way, so the person is sent somewhere safe rather than shown an error.
  }

  redirect(destination);
}

/* ---------------------------------------------------------------------------
 * Sign out (wrong account)
 * ------------------------------------------------------------------------- */

/**
 * Signs the current visitor out and returns them to sign-in with a safe internal
 * `next` that brings them back here — where the invitation hash cookie (untouched by
 * sign-out) is still waiting, so signing in as the invited address resolves the
 * invitation. The raw token is not in `next`, and neither is the hash.
 *
 * Offered on the generic unavailable screen, which is shown for EVERY unavailable
 * cause. It therefore discloses nothing: a visitor who is simply signed in as the
 * wrong person gets a way forward without the page having confirmed that an invitation
 * exists at all.
 */
export async function signOutForStaffInvitationAction(
  _prevState: StaffAcceptState,
  _formData: FormData,
): Promise<StaffAcceptState> {
  const supabase = await createClient();
  try {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) return { error: RETRY_ERROR, notice: null };
  } catch {
    return { error: RETRY_ERROR, notice: null };
  }

  revalidatePath("/", "layout");
  redirect(`/login?next=${RETURN_PATH}`);
}

/* ---------------------------------------------------------------------------
 * Register (feature-flagged, default OFF)
 * ------------------------------------------------------------------------- */

/**
 * Activates an invited staff member's account — PASSWORD ONLY.
 *
 * THE INVITED EMAIL IS NEVER ASKED FOR AND NEVER SHOWN. It is derived, server-side,
 * from the invitation token: the HttpOnly cookie carries the token's SHA-256 hash, the
 * service-role RPC maps that hash to the invitation's own canonical address, and that
 * address goes straight to Supabase Auth. The form has two fields — password and
 * confirmation — and no email input at all, so there is nothing for a person to mistype
 * and nothing for a stranger to substitute.
 *
 * WHY THE COOKIE HOLDS THE HASH RATHER THAN THE RAW TOKEN. /invitations/staff/enter
 * hashes the raw token the moment it arrives and stores only the digest, so the raw
 * token exists for exactly one redirect hop and never at rest. Reading the hash here is
 * therefore both what the cookie contains and the stronger arrangement: storing the raw
 * token so it could be re-hashed later would keep a live credential in a cookie for an
 * hour to no benefit. The shape is validated before use, and the value is never logged.
 *
 * THIS IS NOT A SECOND AUTHENTICATION SYSTEM. It calls the project's existing Supabase
 * Auth through the ordinary publishable-key server client — the same client the sign-in
 * action uses — and creates nothing else. No bespoke session, no bespoke password
 * store, no parallel login route. Signing in remains /login for everyone.
 *
 * IT GRANTS NOTHING. The new account is unconfirmed, and even once confirmed it carries
 * no membership, role or profile: acceptance still requires the invitation's canonical
 * email to equal this account's CONFIRMED address, decided in SQL. Creating an account
 * is not a way to reach an invitation — only a way to have an identity to accept one
 * with.
 *
 * NOTHING IS LOGGED. Not the email, the raw token, the token hash, the password, or any
 * Auth error. Every refusal returns one of two fixed strings.
 */

/** Shown for every refusal on this path. Names nothing about the invitation. */
const ACTIVATION_ERROR =
  "This invitation can no longer be used. Please ask the person who invited you to send a new one.";

/**
 * The one success notice. Identical whether the address was newly registered or Auth
 * declined for a reason we deliberately do not inspect, so this cannot become an
 * account-existence oracle.
 */
const ACTIVATION_NOTICE =
  "Check your email to confirm your account, then return to this invitation.";

export async function activateStaffAccountAction(
  _prevState: StaffAcceptState,
  formData: FormData,
): Promise<StaffAcceptState> {
  // 1. The token hash, from the HttpOnly cookie and nowhere else. No form field
  //    carries it, so a hand-crafted POST cannot supply one.
  const tokenHash = await readStaffInviteHash();
  if (!tokenHash) {
    return { error: ACTIVATION_ERROR, notice: null };
  }

  // 2. The password and its confirmation — the only two values this form submits.
  //    Validated against the shared policy, so the rule here, the rule in the Retailer
  //    Owner activation form, and the `minLength` in the markup are one constant.
  //    Supabase Auth applies its own rules afterwards and its refusal stands.
  const password = formData.get("password");
  const confirmation = formData.get("confirmPassword");

  const passwordCheck = validatePassword(password, confirmation);
  if (!passwordCheck.ok) {
    // Describes the INPUT, never the account or the invitation, so it carries no
    // enumeration risk.
    return { error: passwordCheck.message, notice: null };
  }

  // 3. The canonical invited email — server-side, service-role, never rendered.
  const credentials = await getStaffRegistrationCredentials(tokenHash);

  // An unavailable invitation and one whose address already has an account are
  // reported identically: the page would not have rendered this form for the latter,
  // so reaching it means the state changed underneath or the request was forged.
  if (credentials.status !== "ok") {
    return { error: ACTIVATION_ERROR, notice: null };
  }

  const supabase = await createClient();

  try {
    // emailRedirectTo brings the confirmed visitor back to this same acceptance page,
    // where the invitation cookie is still waiting. It must also be present in the
    // project's allowed redirect URLs — see .env.example.
    const appOrigin = process.env.APP_ORIGIN;
    await supabase.auth.signUp({
      email: credentials.invitedEmail,
      password: typeof password === "string" ? password : "",
      options:
        typeof appOrigin === "string" && appOrigin.trim().length > 0
          ? { emailRedirectTo: `${appOrigin.trim()}${RETURN_PATH}` }
          : undefined,
    });
  } catch {
    // The thrown value is deliberately not bound, inspected, or logged: a
    // transport-level exception can carry the request body, which here includes the
    // password AND the invited address.
    return { error: RETRY_ERROR, notice: null };
  }

  // The Supabase result is deliberately NOT inspected, and nothing about it is
  // returned. The visitor is told the same thing either way.
  return { error: null, notice: ACTIVATION_NOTICE };
}
