"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LANDING_ROUTES } from "@/lib/auth/landing-decision";
import { isRetailerStaffRegistrationEnabled } from "@/lib/features/retailer-staff-invitations";
import {
  clearStaffInviteCookie,
  readStaffInviteHash,
} from "@/lib/staff/staff-invite-cookie";
import { acceptStaffInvitation } from "@/lib/staff/staff-acceptance";
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

  // A FIXED internal literal. Both staff roles land in the Retailer portal:
  // RETAILER_MANAGER resolves as a roster reader and RETAILER_OWNER-style access is
  // never granted here. A Sales Staff member holds no portal read permission and will
  // be redirected onward by the portal's own layout to the generic denial — which is
  // correct, and is that page's decision to make, not this action's.
  redirect(LANDING_ROUTES.retailer);
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
 * Creates a SalesReward account for an invited person who does not have one.
 *
 * DEFAULT OFF, AND NOT OPERATIONAL ON THE CURRENT PROJECT. The hosted Supabase project
 * reports `disable_signup: true`, so Auth refuses signUp() regardless of this flag;
 * enabling the flag alone changes nothing. See .env.example for the project-side
 * configuration this also requires. Until then the acceptance page never renders the
 * form, and this action refuses every submission — including a hand-crafted one,
 * which is exactly why the gate is here and not only in the markup.
 *
 * THIS IS NOT A SECOND AUTHENTICATION SYSTEM. It calls the project's existing Supabase
 * Auth with the ordinary publishable-key server client — the same client the sign-in
 * action uses — and creates nothing else. There is no bespoke session, no bespoke
 * password store, no parallel login route. Sign-in for existing accounts remains
 * /login, untouched.
 *
 * IT GRANTS NOTHING. A new account is unconfirmed and, even once confirmed, carries no
 * membership, role, or profile: acceptance still requires the invitation's exact
 * canonical email to match this account's CONFIRMED address, and that decision is made
 * in SQL. Creating an account is therefore not a way to reach an invitation — it is
 * only a way to have an identity to accept one with.
 *
 * NOTHING ABOUT THE INVITATION IS REVEALED. The form asks the visitor to type their
 * own email; it is never pre-filled from the invitation, because the invitation's
 * address must not be disclosed to an unauthenticated visitor. The outcome message is
 * identical whether or not the address matches an invitation, and identical whether or
 * not an account already existed.
 */
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 72;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The one outcome message. Deliberately identical for "created", "already exists" and
 * "address is not the invited one" — varying it would let an unauthenticated caller
 * enumerate which addresses have accounts, or probe who was invited.
 */
const REGISTRATION_NOTICE =
  "If that address can be registered, we've sent a confirmation email. Confirm it, then open your invitation link again.";

export async function registerForStaffInvitationAction(
  _prevState: StaffAcceptState,
  formData: FormData,
): Promise<StaffAcceptState> {
  // The gate first, before any validation or network call. A disabled feature makes
  // zero Auth requests.
  if (!isRetailerStaffRegistrationEnabled()) {
    return { error: GENERIC_ERROR, notice: null };
  }

  const rawEmail = formData.get("email");
  const rawPassword = formData.get("password");
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";

  // Shape validation describes the INPUT, never an account, so specific messages here
  // carry no enumeration risk.
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return { error: "Enter a valid email address.", notice: null };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
      notice: null,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { error: "Choose a shorter password.", notice: null };
  }

  const supabase = await createClient();

  try {
    // emailRedirectTo brings a confirmed visitor back to this flow's intake path. It
    // must also be present in the project's allowed redirect URLs — see .env.example.
    const appOrigin = process.env.APP_ORIGIN;
    await supabase.auth.signUp({
      email,
      password,
      options:
        typeof appOrigin === "string" && appOrigin.trim().length > 0
          ? { emailRedirectTo: `${appOrigin.trim()}${RETURN_PATH}` }
          : undefined,
    });
  } catch {
    // The thrown value is deliberately not bound, inspected, or logged: a
    // transport-level exception can carry the request body, which here includes the
    // password.
    return { error: RETRY_ERROR, notice: null };
  }

  // The Supabase result is deliberately NOT inspected. Whether the address was newly
  // registered, already existed, or was refused, the visitor is told the same thing —
  // which is what keeps this from being an account-existence oracle.
  return { error: null, notice: REGISTRATION_NOTICE };
}
