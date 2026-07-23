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
 * Server Actions for the staff invitation flow.
 *
 * THE TOKEN HASH COMES ONLY FROM THE HttpOnly COOKIE — never from form data. None of
 * these forms posts a token, a hash, an email, a role, a Retailer id, or an invitation
 * id; a hand-crafted POST carrying any of them is ignored, because no action reads a
 * form field for one. Acceptance is authorized entirely by the database RPC, which
 * resolves auth.uid(), requires a CONFIRMED Auth email that exactly matches the
 * invitation's canonical address, and refuses every other case with one generic error.
 *
 * NO PROFILE, MEMBERSHIP, ROLE OR SHOP WRITE HAPPENS IN APPLICATION CODE. `.from(`
 * appears nowhere in this module. public.accept_retailer_staff_invitation performs the
 * profile creation or permitted activation, the ACTIVE membership, the single
 * member-role edge, the Sales Staff shop rows, the invitation finalization, the token
 * clearing and the audit event — atomically, and it is the only authority that does.
 *
 * EVERY REDIRECT TARGET IS A FIXED INTERNAL LITERAL. Landings come only from
 * LANDING_ROUTES, resolved on the server from the caller's verified session — never
 * from a client-submitted role. The one `next` value in this flow is the constant
 * "/invitations/staff" placed on the sign-in link, which the login page re-validates
 * through resolveSafeNextPath. So no open redirect is possible.
 *
 * NOTHING IS LOGGED. Not an email, password, raw token, token hash, user id, invitation
 * id, provider error or Supabase error.
 */

/** Shown for any refusal — wrong account, unverified, expired, revoked, accepted. */
const GENERIC_ERROR =
  "This invitation can no longer be accepted. Please ask the person who invited you to send a new one.";

/** Shown for a transient failure where retrying is worthwhile. */
const RETRY_ERROR = "Something went wrong. Please try again.";

/** The safe internal return path for this flow. A constant, never a caller value. */
const RETURN_PATH = "/invitations/staff";

/* ---------------------------------------------------------------------------
 * Shared landing resolution
 * ------------------------------------------------------------------------- */

/**
 * Resolves where the currently-authenticated caller should land, from their verified
 * session and nothing else, and whether they are authorized for anything at all.
 *
 * `authorized` is true only for a real role landing (Vendor dashboard, Retailer portal,
 * staff roster, or receipts). "unauthorized" and an operational "unavailable" both fall
 * back to the generic /access-denied — which is a neutral, self-correcting page with a
 * sign-out control, never a dead end. This never reveals anything about an invitation:
 * it is purely "given who you are, where do you belong".
 *
 * Not exported: it is a helper, and a "use server" module may export only async
 * functions that are meant to be endpoints.
 */
async function resolveLanding(): Promise<{ authorized: boolean; destination: string }> {
  try {
    const landing = await resolveAuthenticatedLanding();
    switch (landing.kind) {
      case "vendor":
      case "retailer":
      case "retailerStaff":
      case "salesStaff":
        return { authorized: true, destination: landing.destination };
      case "unauthenticated":
        return { authorized: false, destination: LANDING_ROUTES.login };
      default:
        // "unauthorized" and "unavailable": the honest, generic destination.
        return { authorized: false, destination: LANDING_ROUTES.accessDenied };
    }
  } catch {
    // The thrown value is deliberately not bound or logged.
    return { authorized: false, destination: LANDING_ROUTES.accessDenied };
  }
}

/* ---------------------------------------------------------------------------
 * Accept — invoked automatically by the transition component, always via POST
 * ------------------------------------------------------------------------- */

/**
 * Accepts the invitation for the currently signed-in, verified recipient.
 *
 * This is the ONE database mutation of the flow, and it happens on a POST — never
 * during a GET render. The page validates the exact verified-email match server-side
 * and only then renders a data-free transition component that submits this action once.
 *
 * IDEMPOTENT AND RACE-SAFE. accept_retailer_staff_invitation clears the token on
 * success, so a duplicate or racing submission (a dev remount, a double click, a second
 * tab) finds no live token and is refused. A refusal here therefore almost always means
 * "already accepted by this same user", so rather than showing an error we re-resolve
 * their landing: if they are now authorized for a role, membership exists and they are
 * simply done — redirect them there. Only a caller who is a member of nothing after a
 * refusal sees the generic message.
 *
 * No cookie at all means the invitation was already completed (its cookie was cleared)
 * or was never present in this browser. A signed-in caller in that state is sent to
 * their authorized landing rather than a stale form — which is also what stops the Back
 * button returning to an actionable page.
 */
export async function acceptStaffInvitationAction(
  _prevState: StaffAcceptState,
  _formData: FormData,
): Promise<StaffAcceptState> {
  const tokenHash = await readStaffInviteHash();

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

  // Outside any try/catch: redirect() signals by throwing NEXT_REDIRECT. A POST with no
  // session is bounced to the universal login carrying only the fixed internal `next`.
  if (!hasSession) {
    redirect(`/login?next=${RETURN_PATH}`);
  }

  // Completed or never present. Clearing is a harmless no-op if it is already gone.
  if (!tokenHash) {
    await clearStaffInviteCookie();
    revalidatePath("/", "layout");
    const { destination } = await resolveLanding();
    redirect(destination);
  }

  const result = await acceptStaffInvitation(tokenHash);

  if (result.status === "accepted") {
    // The caller is now an ACTIVE member with exactly one staff role. Clear the
    // single-use cookie and drop any cached render produced before the membership
    // existed, so the landing resolver sees the new role.
    await clearStaffInviteCookie();
    revalidatePath("/", "layout");
    const { destination } = await resolveLanding();
    redirect(destination);
  }

  if (result.status === "refused") {
    // Racing duplicate that already succeeded, or a genuinely stale / wrong-account
    // invitation. The landing resolver tells them apart: an authorized landing means
    // membership exists → treat as done. Everything else is the generic refusal.
    const { authorized, destination } = await resolveLanding();
    if (authorized) {
      await clearStaffInviteCookie();
      revalidatePath("/", "layout");
      redirect(destination);
    }
    return { error: GENERIC_ERROR };
  }

  // A transport/database failure. Retrying is worthwhile, and the transition offers it.
  return { error: RETRY_ERROR };
}

/* ---------------------------------------------------------------------------
 * Continue as invited staff — the account switch
 * ------------------------------------------------------------------------- */

/**
 * Signs the currently-authenticated account out of this browser and returns to the
 * invitation, so the invited person can proceed on the same tab.
 *
 * THE INVITATION COOKIE IS PRESERVED. supabase.auth.signOut() clears only the Supabase
 * AUTH session cookies (via the server client's cookie adapter) and revokes the refresh
 * token upstream. It knows nothing about the staff invitation's HttpOnly hash cookie,
 * which is a separate, differently-named cookie on a different path — so the invitation
 * context survives the switch untouched. Nothing here reads, clears, or even names that
 * cookie.
 *
 * Because one browser profile shares one Supabase session, this may sign the same
 * account out of its other tabs on their next refresh. That is expected and correct:
 * the person asked to continue as the invited staff member instead.
 *
 * It returns to /invitations/staff — NOT /login — because the page itself then decides,
 * on the server, whether to show password activation or a sign-in prompt for the
 * invited address. It reads no form data and never sees the token, the hash, or any
 * account detail.
 */
export async function continueAsInvitedStaffAction(
  _prevState: StaffAcceptState,
  _formData: FormData,
): Promise<StaffAcceptState> {
  const supabase = await createClient();
  try {
    // scope: "local" ends only THIS browser session. The default would revoke the
    // account's other devices too — a surprising side effect for an account switch.
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) return { error: RETRY_ERROR };
  } catch {
    // The thrown value is deliberately not bound, inspected, or logged: a transport
    // exception can carry the session cookie.
    return { error: RETRY_ERROR };
  }

  // Drop any cached render produced while authenticated, then return to the invitation
  // — now signed out, with the invitation cookie still in place.
  revalidatePath("/", "layout");
  redirect(RETURN_PATH);
}

/* ---------------------------------------------------------------------------
 * Stay signed in
 * ------------------------------------------------------------------------- */

/**
 * Keeps the current account signed in and sends it to its own authorized landing —
 * NOT to an access-denied page for an account that is, in fact, authorized somewhere.
 *
 * Reads no form data. The destination is resolved from the verified session on the
 * server; a client-submitted role could not influence it.
 */
export async function stayInvitedSignedInAction(
  _prevState: StaffAcceptState,
  _formData: FormData,
): Promise<StaffAcceptState> {
  const { destination } = await resolveLanding();
  redirect(destination);
}

/* ---------------------------------------------------------------------------
 * Activate — new invited staff, password only
 * ------------------------------------------------------------------------- */

/**
 * Activates an invited staff member's account — PASSWORD ONLY.
 *
 * THE INVITED EMAIL IS NEVER ASKED FOR, SHOWN, OR EVEN SEEN BY THIS MODULE. The
 * HttpOnly cookie carries the invitation token's SHA-256 hash; everything else happens
 * inside @/lib/staff/staff-registration, which resolves the canonical address through a
 * service-role RPC, creates the account already-confirmed, signs the person in, and
 * returns a status. This action passes a hash and a password and receives one word back.
 *
 * WHY THE COOKIE HOLDS THE HASH RATHER THAN THE RAW TOKEN. /invitations/staff/enter
 * hashes the raw token the moment it arrives and stores only the digest, so the raw
 * token exists for exactly one redirect hop and never at rest.
 *
 * NO CONFIRMATION EMAIL, AND NO "CHECK YOUR EMAIL" SCREEN. The person opened an
 * invitation link that was delivered to the invited inbox — that IS proof of control of
 * the address, the same proof a confirmation email would gather. The account is created
 * with email_confirm: true and the person is signed straight in, then redirected back
 * to the invitation where the transition accepts it automatically. Public Supabase
 * signup stays disabled throughout; nothing here uses it.
 *
 * IT GRANTS NOTHING. The new account carries no membership, role or profile: acceptance
 * still requires the invitation's canonical email to equal this account's confirmed
 * address, decided in SQL by accept_retailer_staff_invitation.
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
  // 1. The token hash, from the HttpOnly cookie and nowhere else. No form field carries
  //    it, so a hand-crafted POST cannot supply one.
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
    // Describes the INPUT, never the account or the invitation.
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
    // universal sign-in button, the one useful thing to offer.
    return { error: null, mode: "sign-in", message: ALREADY_REGISTERED_MESSAGE };
  }

  if (result.status !== "activated") {
    return { error: ACTIVATION_ERROR, mode: null };
  }

  // 4. Signed in. Return to the invitation, where the transition now accepts it
  //    automatically and redirects to the correct role landing. Redirecting rather than
  //    reporting success is what removes the old, false "check your email" state.
  //
  //    A FIXED internal literal. redirect() throws NEXT_REDIRECT, so it sits outside
  //    every try/catch.
  revalidatePath("/", "layout");
  redirect(RETURN_PATH);
}
