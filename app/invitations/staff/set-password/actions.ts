"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { validatePassword } from "@/lib/auth/password-policy";
import type { StaffSetPasswordState } from "@/app/invitations/staff/set-password/set-password-state";

/**
 * The Server Action that completes password RECOVERY for an invited staff member.
 *
 * WHAT IT RUNS ON. The RECOVERY SESSION established by /invitations/staff/recover, which
 * verified the emailed one-time token with the Auth server. `supabase.auth.updateUser`
 * acts on that session and on nothing else: there is no email parameter, no user id, and
 * no service-role client anywhere in this module, so the browser cannot nominate whose
 * password is changed. A caller with no session is refused.
 *
 * IT GRANTS NOTHING, AND IT ACCEPTS NOTHING. The invitation is not accepted here — that
 * would spend it before the person could ever sign in again, exactly as
 * /invitations/accept documents. It is not even read. On success the person is sent back
 * to /invitations/staff, where the ordinary signed-in path applies the SAME check it
 * applies to everyone: public.accept_retailer_staff_invitation requires the session's
 * CONFIRMED email to equal the invitation's canonical address, decided in SQL.
 *
 * So resetting a password does NOT accept an invitation, and a person who recovers an
 * account that was never the invited address simply finds no invitation waiting.
 *
 * NO OPEN REDIRECT. The single destination is a fixed internal literal; no `next`,
 * `redirectTo` or `returnUrl` is read from the form or the URL anywhere in this module.
 *
 * NOTHING IS LOGGED. Not the password, the session, the address, or any Auth error.
 */

/** Where a completed recovery returns to. A fixed internal literal. */
const RETURN_PATH = "/invitations/staff";

/** Where a caller with no usable recovery session is sent. */
const FAILURE_PATH = "/invitations/error";

/**
 * The one message for every refusal that is not a password-input problem: an expired or
 * already-consumed recovery session, an Auth rejection, and a transport failure alike.
 * It names no account, address, or provider detail.
 */
const GENERIC_ERROR =
  "We couldn’t set your password. Open the link in your email again, or ask for a new one.";

export async function setStaffRecoveryPasswordAction(
  _prevState: StaffSetPasswordState,
  formData: FormData,
): Promise<StaffSetPasswordState> {
  const supabase = await createClient();

  // 1. The recovery session. getClaims() cryptographically verifies the JWT rather than
  //    trusting the cookie the way getSession() would — the same check every other route
  //    in this codebase makes. A Server Action is a public endpoint, so this is
  //    re-established here regardless of what the page decided.
  let signedIn = false;
  try {
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can carry
    // token material.
    signedIn = false;
  }

  if (!signedIn) {
    // The recovery link expired, was already used, or the session was signed out in
    // another tab. redirect() throws NEXT_REDIRECT, so it sits outside every try/catch.
    redirect(FAILURE_PATH);
  }

  // 2. The password and its confirmation — the only two values this form submits.
  //    Validated against the shared policy, so the rule here, the rule in the activation
  //    form and the `minLength` in the markup are one constant. Supabase Auth applies its
  //    own rules afterwards and its refusal stands.
  const password = formData.get("password");
  const confirmation = formData.get("confirmPassword");

  const passwordCheck = validatePassword(password, confirmation);
  if (!passwordCheck.ok) {
    // Describes the INPUT, never the account.
    return { error: passwordCheck.message };
  }

  // 3. Update the password on the recovery session. No address is passed, because the
  //    session already identifies exactly one account.
  const updated = await Promise.resolve(
    supabase.auth.updateUser({
      password: typeof password === "string" ? password : "",
    }),
  ).catch(() => null);

  if (updated === null) {
    // A transport-level throw can carry the request body, which holds the password.
    console.error("staff/set-password: update threw");
    return { error: GENERIC_ERROR };
  }

  if (updated.error) {
    // The Auth error can echo the identifier and distinguish "same as old password" from
    // "session expired". It is never bound, returned, or logged.
    console.error("staff/set-password: update was refused");
    return { error: GENERIC_ERROR };
  }

  // 4. Done. The account now has a usable password and a confirmed address, and the
  //    session is a normal one. Returning to the invitation lets the existing transition
  //    accept it — subject to the exact-email check, which nothing here has weakened.
  //
  //    The invitation cookie is deliberately NOT cleared here: acceptance is what
  //    consumes it, and the acceptance action already clears it on every terminal
  //    outcome. Clearing it now would strand the person one step from the finish.
  revalidatePath("/", "layout");
  redirect(RETURN_PATH);
}
