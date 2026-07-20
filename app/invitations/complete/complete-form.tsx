"use client";

import { useActionState } from "react";
import { completeInvitation } from "@/app/invitations/complete/actions";
import { INITIAL_COMPLETE_INVITATION_STATE } from "@/app/invitations/complete/complete-state";

/**
 * Password-completion form for an invited Retailer Owner.
 *
 * A Client Component only so it can surface pending/error state via
 * useActionState. The passwords are posted straight to the `completeInvitation`
 * Server Action — the browser Supabase client is never involved, nothing is
 * persisted client-side, and no value is ever echoed back into the DOM.
 *
 * The inputs are UNCONTROLLED (no value/onChange). React never holds the
 * credential in state, and a failed submission clears both fields because the
 * action returns no values to repopulate them with. Retyping is the correct cost
 * for not keeping a password in a client-side store.
 */
export function CompleteInvitationForm() {
  const [state, formAction, pending] = useActionState(
    completeInvitation,
    INITIAL_COMPLETE_INVITATION_STATE,
  );

  const inputClass =
    "block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500";

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {/*
        THERE IS DELIBERATELY NO HIDDEN FIELD HERE.

        An earlier revision posted a `passwordAlreadySet` flag so a retry could
        skip the password update. That was wrong: a hidden input is ordinary
        attacker-editable form data, so posting it on a FIRST attempt would have
        let the acceptance RPC activate a Retailer Owner membership without any
        credential ever being set.

        The action now runs both steps on every submission, so there is nothing to
        remember and nothing to forge. This form posts exactly two fields, both of
        them the invitee's own typed input.
      */}

      {/*
        Errors are rendered in a live region so screen readers announce them on
        submit. The container is only mounted when there is a message, which is
        what makes the announcement fire. Matches app/login/login-form.tsx.
      */}
      {state.formError && (
        <div
          id="complete-error"
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          >
            <path d="M12 9v3.75m0 3.75h.008M10.34 3.94l-8.02 13.5A1.5 1.5 0 003.6 19.5h16.8a1.5 1.5 0 001.28-2.06l-8.02-13.5a1.5 1.5 0 00-2.58 0z" />
          </svg>
          <p>{state.formError}</p>
        </div>
      )}

      <div className="space-y-2">
        <label
          htmlFor="password"
          className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          /*
            "new-password", not "current-password". This tells the browser and
            password manager that a credential is being CREATED, which is what
            prompts an offer to generate and store a strong one. Using
            "current-password" here would make managers try to autofill an
            existing credential for this origin — exactly wrong for an account
            that does not have one yet.
          */
          autoComplete="new-password"
          required
          minLength={12}
          disabled={pending}
          aria-invalid={state.fieldErrors.password ? true : undefined}
          aria-describedby={
            state.fieldErrors.password ? "password-error" : "password-hint"
          }
          className={inputClass}
        />
        {state.fieldErrors.password ? (
          <p id="password-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
            {state.fieldErrors.password}
          </p>
        ) : (
          <p id="password-hint" className="text-xs text-zinc-500 dark:text-zinc-400">
            Use at least 12 characters.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label
          htmlFor="confirmPassword"
          className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          Confirm password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          disabled={pending}
          aria-invalid={state.fieldErrors.confirmPassword ? true : undefined}
          aria-describedby={
            state.fieldErrors.confirmPassword ? "confirm-password-error" : undefined
          }
          className={inputClass}
        />
        {state.fieldErrors.confirmPassword && (
          <p
            id="confirm-password-error"
            role="alert"
            className="text-sm text-red-600 dark:text-red-400"
          >
            {state.fieldErrors.confirmPassword}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-zinc-950"
      >
        {pending && (
          <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 animate-spin" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} className="opacity-25" />
            <path d="M12 2a10 10 0 0110 10" stroke="currentColor" strokeWidth={4} strokeLinecap="round" />
          </svg>
        )}
        {pending ? "Activating account…" : "Activate account"}
      </button>
    </form>
  );
}
