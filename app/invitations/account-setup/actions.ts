"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveAuthenticatedLanding } from "@/lib/auth/authenticated-landing";
import { validatePassword } from "@/lib/auth/password-policy";
import type { AccountSetupState } from "@/app/invitations/account-setup/account-setup-state";

/**
 * Password creation for a GENERIC invited account — one that has verified an Auth
 * invitation but has no application identity of any kind.
 *
 * ============================================================================
 * WHAT THIS DOES, AND THE MUCH LONGER LIST OF WHAT IT DOES NOT
 * ============================================================================
 * It does exactly one thing: sets a password on the caller's own already-verified
 * Auth account, through the ordinary authenticated client, and then signs them out.
 *
 * It does NOT create a public.profiles row. It does NOT create an
 * organization_members row. It does NOT assign a member_roles entry. It does NOT
 * write audit_logs. It calls NO RPC — not the Retailer acceptance functions, not the
 * finalization functions, not a reviewer bootstrap. It imports no service-role
 * client, and this file's module graph contains none.
 *
 * That is the whole point of the separation. AUTH CONFIRMATION IS NOT APPLICATION
 * AUTHORIZATION. Finishing this form leaves the person able to authenticate and able
 * to do nothing else: with no profile row, every portal resolver in the database —
 * Vendor, Retailer and Claim Review alike — returns zero rows for them. Their
 * application access is granted later, by a separately approved administrative
 * process, and never by anything a browser can reach.
 *
 * ============================================================================
 * WHY IT IS SEPARATE FROM THE RETAILER FLOW
 * ============================================================================
 * app/invitations/complete/actions.ts sets a password AND THEN calls
 * accept_retailer_owner_invitation(), flipping a membership from INVITED to ACTIVE.
 * That second step is authorization, and it is correct there because a pending
 * Retailer invitation row is what authorizes it. A generic invitee has no such row,
 * so there is nothing to accept — and reusing that action would have meant either
 * inventing an invitation or making the acceptance conditional, which is exactly the
 * kind of branch that later becomes a bypass. Two actions, one authorizing and one
 * not, cannot drift into each other.
 *
 * NOTHING IS LOGGED that could carry a credential: not the password, the session,
 * the address, or any Auth error object.
 */

/**
 * Where a caller with no usable session is sent. A fixed internal literal.
 *
 * The generic invitation failure page, deliberately — the same destination an
 * expired, already-used or invalid token reaches, so this action cannot become an
 * oracle distinguishing them.
 */
const FAILURE_PATH = "/invitations/error";

/**
 * Where a completed setup returns to.
 *
 * A fixed literal including its query string; no part of it is caller-supplied, so
 * an open redirect is impossible. The `notice` value is matched by the login page
 * against one exact literal and is never rendered as text, so it cannot carry a
 * message of an attacker's choosing.
 */
const SUCCESS_PATH = "/login?notice=account-ready";

/**
 * The one message for every refusal that is not a password-input problem: an Auth
 * rejection and a transport failure alike. It names no account, address or provider
 * detail, and is safe to retry.
 */
const GENERIC_ERROR =
  "We couldn’t set your password. Please try again in a moment.";

export async function completeGenericAccountSetupAction(
  _prevState: AccountSetupState,
  formData: FormData,
): Promise<AccountSetupState> {
  // ---------------------------------------------------------------------------
  // 1. Read the two inputs — the only values this form submits
  // ---------------------------------------------------------------------------
  // Nothing else is read from formData anywhere in this file. There is no user id,
  // no email, no organization, no role and no redirect target to read, so a forged
  // field has nothing to attach itself to.
  const rawPassword = formData.get("password");
  const rawConfirm = formData.get("confirmPassword");

  const password = typeof rawPassword === "string" ? rawPassword : "";
  const confirmPassword = typeof rawConfirm === "string" ? rawConfirm : "";

  // ---------------------------------------------------------------------------
  // 2. Validate — server-side, before any network call
  // ---------------------------------------------------------------------------
  // Every field is checked before returning, so one submission reports every problem
  // at once. These rules describe the INPUT and disclose nothing about the account.
  const fieldErrors: AccountSetupState["fieldErrors"] = {};

  if (password.length === 0) {
    fieldErrors.password = "Choose a password.";
  } else {
    // The one shared policy, so this rule, the Retailer flow's rule and the
    // `minLength` in the markup are a single constant.
    const check = validatePassword(password);
    if (!check.ok) {
      fieldErrors.password = check.message;
    }
  }

  if (confirmPassword.length === 0) {
    fieldErrors.confirmPassword = "Re-enter the password.";
  } else if (password !== confirmPassword) {
    // Compared before anything is sent anywhere: a mismatch means one of the two was
    // mistyped, and setting either would be guessing which.
    fieldErrors.confirmPassword = "Both passwords must match.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    // No values are echoed back — see the note in ./account-setup-state.
    return { fieldErrors, formError: null };
  }

  // ---------------------------------------------------------------------------
  // 3. Re-establish the session — never assumed from the page that rendered the form
  // ---------------------------------------------------------------------------
  // A Server Action is a public endpoint, reachable directly by any caller
  // regardless of which page rendered the form or whether that page guarded itself.
  // getClaims() verifies the JWT signature rather than trusting the cookie the way
  // getSession() would.
  const supabase = await createClient();

  let hasSession: boolean;
  try {
    const { data } = await supabase.auth.getClaims();
    hasSession = Boolean(data?.claims?.sub);
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can carry
    // token material.
    hasSession = false;
  }

  // Outside every try/catch: redirect() signals by throwing NEXT_REDIRECT, and
  // catching it would swallow the navigation.
  if (!hasSession) {
    redirect(FAILURE_PATH);
  }

  // ---------------------------------------------------------------------------
  // 4. Refuse an already-configured user — re-checked here, not trusted from the page
  // ---------------------------------------------------------------------------
  // This endpoint exists for accounts with NO portal. A Vendor Super Admin, Retailer
  // Owner, Retailer Manager, Sales Staff member or Claim Reviewer has an ordinary
  // signed-in session and must change their password through the normal route, not
  // through an invitation-completion endpoint that ends by signing them out.
  //
  // Takes no arguments and reads only auth.uid() through the existing resolvers, so
  // nothing submitted with this form influences the answer. "unavailable" is refused
  // too: during a resolver outage we cannot tell a configured user from a generic
  // one, and the fail-closed direction is to refuse.
  const landing = await resolveAuthenticatedLanding();

  if (landing.kind !== "unauthorized") {
    return { fieldErrors: {}, formError: GENERIC_ERROR };
  }

  // ---------------------------------------------------------------------------
  // 5. Set the password — Supabase Auth only
  // ---------------------------------------------------------------------------
  // The ordinary authenticated client, under the caller's own token. No address and
  // no user id is passed: the session already identifies exactly one account, so
  // there is no parameter a caller could substitute to act on someone else's.
  //
  // Promise.resolve() because the Auth builder is a thenable rather than a real
  // Promise, matching the shape used throughout this codebase.
  const updated = await Promise.resolve(
    supabase.auth.updateUser({ password }),
  ).catch(() => null);

  if (updated === null) {
    // A transport-level throw can carry the request body — which here IS the
    // password. Nothing is bound, inspected or logged.
    console.error("account-setup: password update threw");
    return { fieldErrors: {}, formError: GENERIC_ERROR };
  }

  if (updated.error) {
    // The Auth error can echo the identifier and can distinguish "same as old
    // password" from "session expired". It is never bound, returned or logged.
    console.error("account-setup: password update was refused");
    return { fieldErrors: {}, formError: GENERIC_ERROR };
  }

  // ---------------------------------------------------------------------------
  // 6. Sign out, then send them to sign in
  // ---------------------------------------------------------------------------
  // The session that reached this point came from a one-time invitation token. It
  // has served its only purpose, and ending it deliberately means the next thing the
  // person does is prove the password they just chose actually works — while they
  // still remember choosing it.
  //
  // It also makes a duplicate submission harmless: the second one finds no session at
  // step 3 and redirects to the generic failure page rather than re-running anything.
  //
  // A sign-out failure is swallowed. The password IS set at this point, and reporting
  // an error would tell the person their password did not take when it did. The worst
  // case is a session that outlives this request, which the login page then bounces.
  await Promise.resolve(supabase.auth.signOut()).catch(() => null);

  revalidatePath("/", "layout");
  redirect(SUCCESS_PATH);
}
