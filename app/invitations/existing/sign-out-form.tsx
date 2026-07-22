"use client";

import { useActionState } from "react";
import { signOutForExistingInvitationAction } from "@/app/invitations/existing/actions";
import { INITIAL_ACCEPT_EXISTING_STATE } from "@/app/invitations/existing/accept-state";

/**
 * Sign-out control for the wrong-account case. Signs the current visitor out and
 * returns them to sign-in with a safe `next` back to this page. Carries no token,
 * hash, email, or account detail.
 */
export function SignOutMismatchForm() {
  const [state, formAction, pending] = useActionState(
    signOutForExistingInvitationAction,
    INITIAL_ACCEPT_EXISTING_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.error && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          <p>{state.error}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:focus-visible:ring-offset-zinc-950"
      >
        {pending ? "Signing out…" : "Sign out and sign in as the invited address"}
      </button>
    </form>
  );
}
