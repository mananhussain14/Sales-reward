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
import { activateInvitedStaffAccount } from "@/lib/staff/staff-registration";
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
    return { error: GENERIC_ERROR };
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
    return { error: RETRY_ERROR };
  }
  if (result.status === "refused") {
    return { error: GENERIC_ERROR };
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
    if (error) return { error: RETRY_ERROR };
  } catch {
    return { error: RETRY_ERROR };
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
 * THE INVITED EMAIL IS NEVER ASKED FOR, SHOWN, OR EVEN SEEN BY THIS MODULE. The
 * HttpOnly cookie carries the invitation token's SHA-256 hash; everything else happens
 * inside @/lib/staff/staff-registration, which resolves the canonical address through
 * a service-role RPC, creates the account, signs the person in, and returns a status.
 * This action passes a hash and a password and receives one word back.
 *
 * WHY THE COOKIE HOLDS THE HASH RATHER THAN THE RAW TOKEN. /invitations/staff/enter
 * hashes the raw token the moment it arrives and stores only the digest, so the raw
 * token exists for exactly one redirect hop and never at rest. Reading the hash here is
 * therefore both what the cookie contains and the stronger arrangement.
 *
 * NO CONFIRMATION EMAIL, AND NO "CHECK YOUR EMAIL" SCREEN. The person opened an
 * invitation link that was delivered to the invited inbox — that IS proof of control of
 * the address, and it is the same proof a confirmation email would gather. The account
 * is created already-confirmed and the person is signed straight in, so activation ends
 * on the invitation itself rather than in a mailbox. Public Supabase signup stays
 * disabled throughout; nothing here uses it.
 *
 * THIS IS NOT A SECOND AUTHENTICATION SYSTEM. It creates a Supabase Auth user and
 * establishes a Supabase session through the project's ordinary cookie-aware client —
 * the same client the sign-in action uses. No bespoke session, no bespoke password
 * store, no parallel login route. Signing in remains /login for everyone.
 *
 * IT GRANTS NOTHING. The new account carries no membership, role or profile:
 * acceptance still requires the invitation's canonical email to equal this account's
 * confirmed address, decided in SQL by accept_retailer_staff_invitation. Creating an
 * account is not a way to reach an invitation — only a way to have an identity to
 * accept one with.
 *
 * NOTHING IS LOGGED. Not the email, the raw token, the token hash, the password, or any
 * Auth error.
 */

/** Shown for every refusal on this path. Names nothing about the invitation. */
const ACTIVATION_ERROR =
  "This invitation can no longer be used. Please ask the person who invited you to send a new one.";

/**
 * Shown when the invited address turns out to already have an account — including when
 * a concurrent submission created one a moment ago. The form switches to the sign-in
 * prompt, so a race is invisible rather than an error.
 */
const ALREADY_REGISTERED_MESSAGE =
  "You already have a SalesReward account. Sign in to continue.";

export async function activateStaffAccountAction(
  _prevState: StaffAcceptState,
  formData: FormData,
): Promise<StaffAcceptState> {
  // 1. The token hash, from the HttpOnly cookie and nowhere else. No form field
  //    carries it, so a hand-crafted POST cannot supply one.
  const tokenHash = await readStaffInviteHash();
  if (!tokenHash) {
    return { error: ACTIVATION_ERROR, mode: null };
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
    return { error: passwordCheck.message, mode: null };
  }

  // 3. Create the account (already confirmed) and sign them in. The address is
  //    resolved, used and discarded inside that call; it never reaches this module.
  const result = await activateInvitedStaffAccount(
    tokenHash,
    typeof password === "string" ? password : "",
  );

  if (result.status === "already-registered") {
    // Not an error — a different screen. The form swaps its password fields for the
    // universal sign-in button, which is the one useful thing to offer.
    return { error: null, mode: "sign-in", message: ALREADY_REGISTERED_MESSAGE };
  }

  if (result.status !== "activated") {
    return { error: ACTIVATION_ERROR, mode: null };
  }

  // 4. Signed in. Drop any cached render produced while signed out, then return to the
  //    invitation — where the authenticated recipient RPC now resolves it and offers
  //    Accept. Redirecting rather than reporting success is what removes the old,
  //    false "check your email" state: there is nothing to wait for.
  //
  //    A FIXED internal literal. redirect() signals by throwing NEXT_REDIRECT, so it
  //    sits outside every try/catch.
  revalidatePath("/", "layout");
  redirect(RETURN_PATH);
}
