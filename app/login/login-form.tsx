"use client";

import { useActionState } from "react";
import { signIn } from "@/app/login/actions";
import { INITIAL_LOGIN_STATE } from "@/app/login/login-state";

/**
 * The universal sign-in form — used by every role.
 *
 * This is a Client Component only so it can surface pending/error state via
 * useActionState. The credential itself is posted straight to the `signIn` Server
 * Action — the browser Supabase client is never involved, and nothing is persisted
 * client-side.
 *
 * It renders no role text and makes no authorization decision. Where the person lands
 * afterwards is resolved on the server from their verified session; this component
 * never learns which role they hold.
 */
export function LoginForm({ next }: { next?: string | null }) {
  const [state, formAction, pending] = useActionState(signIn, INITIAL_LOGIN_STATE);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {/*
        The post-login destination, already validated to a safe same-origin path
        on the server before it reached this prop. The action re-validates it
        again on receipt — this hidden field is a convenience carrier, never a
        trust boundary. Omitted entirely when there is no safe `next`.
      */}
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {/*
        Errors are rendered in a live region so screen readers announce them on
        submit. The container is only mounted when there is a message, which is
        what makes the announcement fire.
      */}
      {state.error && (
        <div
          id="login-error"
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
          <p>{state.error}</p>
        </div>
      )}

      <div className="space-y-2">
        <label
          htmlFor="email"
          className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
        >
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
          aria-describedby={state.error ? "login-error" : undefined}
          className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
      </div>

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
          autoComplete="current-password"
          required
          disabled={pending}
          aria-describedby={state.error ? "login-error" : undefined}
          className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-zinc-950"
      >
        {pending && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="h-4 w-4 animate-spin"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth={4}
              className="opacity-25"
            />
            <path
              d="M12 2a10 10 0 0110 10"
              stroke="currentColor"
              strokeWidth={4}
              strokeLinecap="round"
            />
          </svg>
        )}
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
