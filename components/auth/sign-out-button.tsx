"use client";

import { useActionState } from "react";
import { signOut } from "@/app/auth/actions";
import { INITIAL_SIGN_OUT_STATE } from "@/app/auth/sign-out-state";

/**
 * Sign-out control for the Vendor Admin.
 *
 * This is a Client Component only so it can surface pending/error state via
 * useActionState. The session teardown itself happens entirely in the `signOut`
 * Server Action — the browser Supabase client is never involved, and no session
 * state is read from or written to localStorage (there is none to clear: the
 * session lives in httpOnly cookies the server owns).
 *
 * Rendered as a real <form>, not an onClick handler, so it degrades to a normal
 * POST and carries the browser's cookies with it.
 */

type SignOutButtonProps = {
  /**
   * Where the button is being rendered.
   *
   * "header" — compact, secondary-weight control for the dashboard header. The
   *   error panel floats so a failure cannot change the header's fixed height.
   * "card"   — full-width primary control for the access-denied card, where
   *   signing out is the only action available.
   */
  variant?: "header" | "card";
};

/** Distinguishes the two error regions if both variants ever mount at once. */
const ERROR_ID = "sign-out-error";

export function SignOutButton({ variant = "header" }: SignOutButtonProps) {
  const [state, formAction, pending] = useActionState(
    signOut,
    INITIAL_SIGN_OUT_STATE,
  );

  const isCard = variant === "card";

  const buttonClassName = isCard
    ? "inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-zinc-950"
    : "inline-flex items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:focus-visible:ring-offset-zinc-950";

  /*
    Errors are rendered in a live region so screen readers announce them. The
    container is only mounted when there is a message, which is what makes the
    announcement fire — matching the sign-in form's behaviour.

    In the header the panel is absolutely positioned beneath the button: the
    header is a fixed h-16 row, so an in-flow error block would push the layout
    around on failure.
  */
  const errorRegion = state.error ? (
    <div
      id={ERROR_ID}
      role="alert"
      aria-live="polite"
      className={
        isCard
          ? "mb-4 flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-left text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
          : "absolute right-0 top-full z-40 mt-2 flex w-64 items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-left text-sm text-red-800 shadow-lg dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
      }
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
  ) : null;

  return (
    <form action={formAction} className={isCard ? "w-full" : "relative"}>
      {isCard && errorRegion}

      <button
        type="submit"
        disabled={pending}
        aria-describedby={state.error ? ERROR_ID : undefined}
        className={buttonClassName}
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
        {pending ? "Signing out…" : "Sign out"}
      </button>

      {!isCard && errorRegion}
    </form>
  );
}
