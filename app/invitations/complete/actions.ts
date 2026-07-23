"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LANDING_ROUTES } from "@/lib/auth/landing-decision";
import { validatePassword } from "@/lib/auth/password-policy";
import type { CompleteInvitationState } from "@/app/invitations/complete/complete-state";

/**
 * Server Action backing the invitation password-completion form.
 *
 * EVERY SUBMISSION PERFORMS BOTH STEPS, IN THIS ORDER, WITH NO BRANCHES:
 *
 *   1. auth.updateUser({ password })        — Supabase Auth
 *   2. accept_retailer_owner_invitation()   — PostgreSQL
 *
 * Step 2 is physically unreachable unless step 1 returned without error: the only
 * route past the password block is falling through it, and every failure path
 * inside it returns. There is no flag, no cached outcome, and no conditional that
 * could let acceptance run on its own.
 *
 * WHY THERE IS NO RETRY FLAG ANY MORE
 *   An earlier revision passed a `passwordAlreadySet` boolean down to the browser
 *   as a hidden input and read it back to decide whether to skip step 1. That was
 *   a client-controlled bypass. Hidden fields are ordinary attacker-editable form
 *   data, so posting `passwordAlreadySet=1` on a first attempt would have run the
 *   acceptance RPC — activating a Retailer Owner membership — in a submission that
 *   never set a credential at all. Anyone who could reach this action with a
 *   verified invite session could have activated their account without ever
 *   choosing a password.
 *
 *   The flag is deleted, and nothing takes its place: no cookie, no query
 *   parameter, no localStorage, no sessionStorage, no client state. Retry is
 *   handled by simply doing the work again — the password update is re-applied and
 *   the acceptance RPC is idempotent — so the action needs no memory of previous
 *   attempts and exposes no state for a caller to forge.
 *
 * PASSWORD ORDER IS ALSO A SAFETY PROPERTY, not just a sequence. Accepting first
 * would flip the membership to ACTIVE and burn the invitation while the person
 * still had no password — a live-looking account its owner could never sign in to,
 * with no supported way back.
 *
 * NO PASSWORD EVER REACHES POSTGRESQL. The credential goes to Supabase Auth and
 * nowhere else: the acceptance RPC takes zero arguments, no invitation column
 * stores a password, and no audit record mentions one. This module never logs the
 * password, the token, the email, the invitation id, the Auth user id, or any raw
 * error object, and never returns the password in state or a URL.
 *
 * Because of the "use server" directive, `completeInvitation` must be this
 * module's only runtime export — every export here is exposed as a callable server
 * endpoint, so Next.js rejects anything that is not an async function.
 */

/**
 * The password rules come from the SHARED policy module, not from constants declared
 * here. Both account-creation flows — this one and invited staff activation — and both
 * of their forms now read the same two numbers, so the length a browser enforces, the
 * length this action requires, and auth.minimum_password_length = 6 in
 * supabase/config.toml can no longer drift apart.
 *
 * Supabase Auth remains the final authority: these checks run first so the person gets
 * a specific message instead of a generic auth failure, and Auth applies its own rules
 * afterwards.
 */

/**
 * The Supabase Auth error code meaning "the new password is identical to the
 * current one".
 *
 * This is the ONE Auth outcome treated as a non-failure, and the reasoning is
 * worth stating because it looks like a loophole and is not.
 *
 * It can only arise on a RETRY: the previous submission's updateUser already
 * succeeded, and the invitee has now typed the same password again because
 * acceptance failed the first time. GoTrue is not saying "I refused to set your
 * credential" — it is saying "your credential is ALREADY exactly this value".
 * Treating that as a failure would strand the invitee permanently: their password
 * is set, their invitation is unaccepted, and every retry with the password they
 * chose would be rejected forever.
 *
 * It is not a bypass, because reaching it requires already knowing the account's
 * current password. An attacker who submits a guess gets an ordinary error, not
 * this one — this outcome is itself proof that the submitted value matches the
 * stored credential.
 *
 * Matched on the CODE only, never on message text. If a future GoTrue changes the
 * code, this stops matching and the retry degrades to "choose a different
 * password" — inconvenient, never unsafe.
 */
const SAME_PASSWORD_CODE = "same_password";

/**
 * Shown when Supabase Auth refuses the password.
 *
 * One message for every Auth rejection — too weak, too short, previously breached,
 * rate limited, or a session that has expired. The raw error is never forwarded:
 * its message and status distinguish failure modes, and its body can echo the
 * submitted credential.
 */
const GENERIC_PASSWORD_ERROR =
  "We couldn't set that password. Please choose a different one and try again.";

/**
 * Shown when the password was set but the database acceptance failed.
 *
 * Actionable on purpose: the invitee's credential is now live, so "something went
 * wrong" would leave them unsure whether to retype it or try signing in. Re-
 * submitting is safe and is exactly what they should do.
 */
const ACCEPTANCE_RETRY_ERROR =
  "Your password was saved, but we couldn't finish activating your account. Please submit the form again to complete it.";

/**
 * Shown when there is no live invitation to accept at all.
 *
 * One message for: never invited, expired, revoked, the Retailer suspended since
 * the invitation was sent, and a session matching no invitation. The RPC refuses
 * all of them with one byte-identical exception so it cannot be used to confirm an
 * invitation exists; this preserves that.
 */
const NO_INVITATION_ERROR =
  "This invitation can no longer be completed. Please ask the person who invited you to send a new one.";

/** PostgreSQL insufficient_privilege — the acceptance RPC's one generic refusal. */
const INSUFFICIENT_PRIVILEGE_SQLSTATE = "42501";

export async function completeInvitation(
  _prevState: CompleteInvitationState,
  formData: FormData,
): Promise<CompleteInvitationState> {
  // ---------------------------------------------------------------------------
  // 1. Read — server-side, from FormData, and nowhere else
  // ---------------------------------------------------------------------------
  // FormData entries are `string | File`; a File here means a malformed or
  // hand-crafted request and is treated as absent. Passwords are NOT trimmed —
  // leading and trailing whitespace are legitimate credential characters, and
  // silently stripping them would set a password different from the one the person
  // believes they chose.
  //
  // These are the ONLY two fields this action reads. There is no third field, and
  // in particular no flag describing what a previous attempt achieved.
  const rawPassword = formData.get("password");
  const rawConfirm = formData.get("confirmPassword");

  const password = typeof rawPassword === "string" ? rawPassword : "";
  const confirmPassword = typeof rawConfirm === "string" ? rawConfirm : "";

  // ---------------------------------------------------------------------------
  // 2. Validate — server-side
  // ---------------------------------------------------------------------------
  // Every field is checked before returning, so one submission reports every
  // problem at once rather than revealing them one round trip at a time. These
  // rules describe the INPUT and carry no information about the account.
  const fieldErrors: CompleteInvitationState["fieldErrors"] = {};

  if (password.length === 0) {
    fieldErrors.password = "Choose a password.";
  } else {
    // One shared rule, one shared message. `confirmation` is omitted because this form
    // has a single password field; passing nothing skips only the match check.
    const check = validatePassword(password);
    if (!check.ok) {
      fieldErrors.password = check.message;
    }
  }

  if (confirmPassword.length === 0) {
    fieldErrors.confirmPassword = "Re-enter the password.";
  } else if (password !== confirmPassword) {
    // Compared before anything is sent anywhere. A mismatch means one of the two
    // was mistyped, and setting either value would be guessing which.
    fieldErrors.confirmPassword = "Both passwords must match.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    // No values are echoed back — see the note in ./complete-state.
    return { fieldErrors, formError: null };
  }

  // ---------------------------------------------------------------------------
  // 3. Resolve the authenticated session — repeated here, never assumed
  // ---------------------------------------------------------------------------
  // A Server Action is a public endpoint, reachable directly by any caller
  // regardless of which page rendered the form or whether that page guarded
  // itself. getClaims() verifies the JWT signature rather than trusting the cookie
  // the way getSession() would.
  const supabase = await createClient();

  let hasSession: boolean;
  try {
    const { data } = await supabase.auth.getClaims();
    hasSession = Boolean(data?.claims?.sub);
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can
    // carry token material.
    hasSession = false;
  }

  // Outside every try/catch: redirect() signals by throwing NEXT_REDIRECT, and
  // catching it would swallow the navigation.
  if (!hasSession) {
    redirect("/invitations/error");
  }

  // ---------------------------------------------------------------------------
  // 4. Set the password — Supabase Auth only, on EVERY submission
  // ---------------------------------------------------------------------------
  // No condition guards this call. It runs on the first attempt and on every
  // retry, which is what makes the retry flag unnecessary and therefore
  // unforgeable.
  //
  // Re-applying the same password on a retry is harmless: it either succeeds (the
  // credential is set to the submitted value) or returns SAME_PASSWORD_CODE (the
  // credential already IS the submitted value). Both mean the same thing for the
  // step that follows.
  try {
    const { error } = await supabase.auth.updateUser({ password });

    if (error && (error as { code?: string }).code !== SAME_PASSWORD_CODE) {
      // The raw error is swallowed rather than forwarded, and is not logged
      // either, since these objects can echo the submitted credential.
      //
      // RETURNING HERE IS THE SECURITY BOUNDARY: acceptance lives below this
      // block and there is no other route to it, so a refused password cannot be
      // followed by an activated membership.
      console.error("completeInvitation: password update was refused");
      return { fieldErrors: {}, formError: GENERIC_PASSWORD_ERROR };
    }
  } catch {
    // A transport-level exception can carry the request body — which here IS the
    // password. Nothing is bound, inspected, or logged. Same boundary: return.
    console.error("completeInvitation: password update threw");
    return { fieldErrors: {}, formError: GENERIC_PASSWORD_ERROR };
  }

  // Reaching this line is proof that updateUser resolved without a blocking error
  // in THIS submission. Nothing carried over from a previous request contributed
  // to that conclusion.

  // ---------------------------------------------------------------------------
  // 5. Accept — PostgreSQL, under the invitee's own token
  // ---------------------------------------------------------------------------
  // ZERO arguments. The RPC resolves the invitation solely from auth.uid(), so
  // nothing submitted with this form influences which invitation is accepted —
  // there is no parameter a caller could substitute. It is idempotent for an
  // already-accepted invitation, so a duplicate submission succeeds rather than
  // erroring.
  //
  // Promise.resolve() because the PostgREST builder is a thenable, not a real
  // Promise, matching the shape used throughout this codebase.
  const acceptance = await Promise.resolve(
    supabase.rpc("accept_retailer_owner_invitation"),
  ).catch(() => null);

  if (acceptance === null || acceptance.error) {
    // Two genuinely different situations, distinguished only by SQLSTATE — never
    // by message text.
    //
    //   42501 — the RPC's one generic refusal: no pending invitation, expired,
    //     revoked, or the Retailer no longer active. Retrying will not help, so
    //     the invitee is told to ask for a new invitation.
    //   anything else — a transport failure or database outage. Retrying WILL
    //     help, and re-submitting re-runs both steps safely.
    const isRefusal =
      acceptance?.error?.code === INSUFFICIENT_PRIVILEGE_SQLSTATE;

    console.error("completeInvitation: acceptance was refused");

    return {
      fieldErrors: {},
      formError: isRefusal ? NO_INVITATION_ERROR : ACCEPTANCE_RETRY_ERROR,
    };
  }

  // ---------------------------------------------------------------------------
  // 6. Success
  // ---------------------------------------------------------------------------
  // Committed: the membership is ACTIVE, the invitation is ACCEPTED, and the audit
  // record was written in the same transaction as both.

  // The session's authorization state changed — profile, membership, and
  // invitation are now all ACTIVE/ACCEPTED — so any render produced before this
  // point is stale.
  revalidatePath("/", "layout");

  // Straight into the portal. The acceptance the RPC just committed makes this
  // caller satisfy the Retailer Owner authorization chain
  // (profiles.status = ACTIVE, membership ACTIVE, RETAILER_OWNER role, read
  // permission), so /retailer will render rather than deny — completing the
  // journey immediately instead of parking the new owner on a confirmation page.
  //
  // A FIXED internal literal (LANDING_ROUTES.retailer, the same constant the
  // login resolver uses). No redirectTo/next form field or search parameter is
  // read anywhere in this module, so there is no open-redirect vector, and no
  // invitation id, organization id, email, token, or membership detail appears in
  // the destination. It is NOT "/" or any Vendor route.
  //
  // /invitations/success is retained as a safe fallback for refreshes, old
  // bookmarks, and replay — see app/invitations/success/page.tsx — but the
  // primary completion path no longer stops there.
  //
  // Outside any try/catch, and nothing follows it: redirect() throws
  // NEXT_REDIRECT, so no success state is returned or could be. Swallowing that
  // throw would turn a committed acceptance into a spurious failure message.
  redirect(LANDING_ROUTES.retailer);
}
