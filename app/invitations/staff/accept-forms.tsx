"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  acceptStaffInvitationAction,
  activateStaffAccountAction,
  signOutForStaffInvitationAction,
} from "@/app/invitations/staff/actions";
import { INITIAL_STAFF_ACCEPT_STATE } from "@/app/invitations/staff/accept-state";
import { MIN_PASSWORD_LENGTH, PASSWORD_HINT } from "@/lib/auth/password-policy";

/**
 * The three controls on the staff acceptance page.
 *
 * Client Components only so they can surface pending/error state via useActionState.
 * None of them carries a token, a token hash, an invitation id, or an email: the
 * acceptance and sign-out actions read the hash from the HttpOnly cookie server-side,
 * and there is nothing here for a browser to tamper with. Duplicate submission is
 * prevented by disabling the submit button while `pending` is true.
 */

const primaryButton =
  "inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-zinc-950";

const secondaryButton =
  "inline-flex w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:focus-visible:ring-offset-zinc-950";

const inputClasses =
  "block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500";

/**
 * The error banner.
 *
 * Errors only. There is deliberately no success variant on this page: activation ends
 * by signing the person in and redirecting them back to the invitation, so there is
 * nothing to announce and nothing to wait for.
 */
function Alert({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      aria-live="polite"
      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
    >
      <p>{error}</p>
    </div>
  );
}

/** The Accept button. Posts no fields at all. */
export function AcceptStaffInvitationForm() {
  const [state, formAction, pending] = useActionState(
    acceptStaffInvitationAction,
    INITIAL_STAFF_ACCEPT_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      <Alert error={state.error} />
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "Accepting…" : "Accept invitation"}
      </button>
    </form>
  );
}

/** Sign out, then return to sign-in with a safe internal `next` back to this page. */
export function SignOutForStaffInvitationForm() {
  const [state, formAction, pending] = useActionState(
    signOutForStaffInvitationAction,
    INITIAL_STAFF_ACCEPT_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      <Alert error={state.error} />
      <button type="submit" disabled={pending} className={secondaryButton}>
        {pending ? "Signing out…" : "Sign out and use a different account"}
      </button>
    </form>
  );
}

/**
 * The PASSWORD-ONLY activation form, for an invited person with no account yet.
 *
 * TWO FIELDS, AND NO EMAIL INPUT. The invited address is derived on the server from the
 * invitation token and handed straight to Supabase Auth; it is never rendered, never
 * placed in a prop or a hidden field, and never sent to the browser in any form. That
 * is why there is nothing here to pre-fill and nothing for a stranger to substitute.
 *
 * There is deliberately no "Sign in" button in this form either: someone who has no
 * account cannot sign in, and offering it would suggest their address might already be
 * registered — which is exactly the fact the flow does not disclose.
 *
 * `minLength` comes from the shared password policy, so the browser's rule, the Server
 * Action's rule and the Supabase setting are one constant.
 */
export function ActivateStaffAccountForm() {
  const [state, formAction, pending] = useActionState(
    activateStaffAccountAction,
    INITIAL_STAFF_ACCEPT_STATE,
  );

  // The invited address turned out to have an account already — either it always did,
  // or a concurrent submission created one. Swap the password fields for the sign-in
  // button rather than reporting an error: the remedy is the same, and a race the
  // person did not cause should not read as a failure.
  if (state.mode === "sign-in") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {state.message ?? "You already have a SalesReward account. Sign in to continue."}
        </p>
        <StaffInvitationSignInPrompt />
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Alert error={state.error} />

      <div className="space-y-2">
        <label
          htmlFor="activate-password"
          className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          Password
        </label>
        <input
          id="activate-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={pending}
          aria-describedby="activate-password-hint"
          className={inputClasses}
        />
        <p
          id="activate-password-hint"
          className="text-xs text-zinc-500 dark:text-zinc-400"
        >
          {PASSWORD_HINT}
        </p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="activate-confirm-password"
          className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          Confirm password
        </label>
        <input
          id="activate-confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={pending}
          className={inputClasses}
        />
      </div>

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "Creating your account…" : "Activate account"}
      </button>
    </form>
  );
}

/**
 * The sign-in prompt shown when the invited address ALREADY has an account.
 *
 * No password fields: the person has a password already, and offering to set another
 * would be a password-reset flow this milestone does not build. The link goes to the
 * universal /login with a validated internal return path back to this page, where the
 * invitation cookie is still waiting.
 *
 * The invited address is NOT shown. Confirming which address has an account, to a
 * visitor who has not authenticated, is exactly the disclosure the flow avoids — and
 * the person about to sign in already knows which address they were invited at.
 */
export function StaffInvitationSignInPrompt() {
  return (
    <Link
      href="/login?next=/invitations/staff"
      className="inline-flex w-full items-center justify-center rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950"
    >
      Sign in
    </Link>
  );
}
