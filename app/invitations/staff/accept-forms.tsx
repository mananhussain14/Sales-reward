"use client";

import { useActionState } from "react";
import {
  acceptStaffInvitationAction,
  registerForStaffInvitationAction,
  signOutForStaffInvitationAction,
} from "@/app/invitations/staff/actions";
import { INITIAL_STAFF_ACCEPT_STATE } from "@/app/invitations/staff/accept-state";

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

function Alert({ error, notice }: { error: string | null; notice: string | null }) {
  if (error) {
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
  if (notice) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-800 dark:border-indigo-900/60 dark:bg-indigo-950/40 dark:text-indigo-300"
      >
        <p>{notice}</p>
      </div>
    );
  }
  return null;
}

/** The Accept button. Posts no fields at all. */
export function AcceptStaffInvitationForm() {
  const [state, formAction, pending] = useActionState(
    acceptStaffInvitationAction,
    INITIAL_STAFF_ACCEPT_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      <Alert error={state.error} notice={state.notice} />
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
      <Alert error={state.error} notice={state.notice} />
      <button type="submit" disabled={pending} className={secondaryButton}>
        {pending ? "Signing out…" : "Sign out and use a different account"}
      </button>
    </form>
  );
}

/**
 * The create-account form. Rendered ONLY when the server says the feature is enabled —
 * and the action re-checks that flag, because a hidden form is not a gate.
 *
 * The email field is never pre-filled: the invitation's address must not be disclosed
 * to an unauthenticated visitor, so they type their own.
 */
export function RegisterForStaffInvitationForm() {
  const [state, formAction, pending] = useActionState(
    registerForStaffInvitationAction,
    INITIAL_STAFF_ACCEPT_STATE,
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Alert error={state.error} notice={state.notice} />

      <div className="space-y-2">
        <label
          htmlFor="register-email"
          className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          Email address
        </label>
        <input
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
          className={inputClasses}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Use the address your invitation was sent to.
        </p>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="register-password"
          className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          Password
        </label>
        <input
          id="register-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          disabled={pending}
          className={inputClasses}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          At least 12 characters.
        </p>
      </div>

      <button type="submit" disabled={pending} className={secondaryButton}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
