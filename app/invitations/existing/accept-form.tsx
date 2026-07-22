"use client";

import { useActionState } from "react";
import { acceptExistingUserInvitationAction } from "@/app/invitations/existing/actions";
import { INITIAL_ACCEPT_EXISTING_STATE } from "@/app/invitations/existing/accept-state";

/**
 * The Accept button for the existing-user invitation.
 *
 * A Client Component only so it can surface pending/error state via useActionState.
 * It carries NO token and NO hash — the acceptance action reads the hash from the
 * HttpOnly cookie server-side. There is nothing here for a browser to tamper with.
 */
export function AcceptExistingInvitationForm() {
  const [state, formAction, pending] = useActionState(
    acceptExistingUserInvitationAction,
    INITIAL_ACCEPT_EXISTING_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.error && (
        <div
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          <p>{state.error}</p>
        </div>
      )}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-zinc-950"
      >
        {pending ? "Accepting…" : "Accept invitation"}
      </button>
    </form>
  );
}
