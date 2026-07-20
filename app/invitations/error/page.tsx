import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Invitation unavailable · SalesReward",
};

/**
 * The single failure destination for /invitations/accept.
 *
 * DELIBERATELY REASON-FREE. A missing token, a malformed one, an expired one, an
 * already-consumed one, a forged one, a revoked invitation, an invitation whose
 * Retailer has since been suspended, and a database outage all land here and see
 * exactly this text.
 *
 * That is not laziness about error messages — it is the point. Varying the copy
 * would let anyone holding a guessed or intercepted token learn which of those
 * states applies, turning this page into an oracle for whether a given invitation
 * exists and how far through its lifecycle it is. The RPC behind the callback
 * raises one byte-identical exception for its authorization cases for the same
 * reason; softening it here would undo that.
 *
 * A Server Component with no data access at all: it reads no search parameter, no
 * cookie, no header, and no database row, so there is nothing here to leak and
 * nothing to tamper with. It renders identically for every visitor.
 *
 * The route is listed in PUBLIC_PATHS in lib/supabase/proxy.ts because the people
 * who need it are precisely those who failed to obtain a session.
 */
export default function InvitationErrorPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-900">
      <main className="w-full max-w-sm">
        {/* Mirrors the login page lockup so the two read as one product. */}
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-600 text-base font-bold text-white">
            SR
          </span>
          <span className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            SalesReward
          </span>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-950">
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            This invitation link cannot be used
          </h1>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            The link may have expired, may already have been used, or may no longer
            be valid.
          </p>
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            Please ask the person who invited you to send a new invitation.
          </p>
        </div>

        {/*
          No "try again" control and no link back to the callback. Retrying is
          impossible by construction — an invitation token is single-use — so
          offering it would only produce a second identical failure.

          A sign-in link IS offered, because this page has more than one kind of
          visitor. Someone whose link expired has no password and cannot use it —
          hence the wording below, which offers rather than instructs. But someone
          who ALREADY completed their invitation and then re-clicked the old email
          also lands here, and for them signing in is exactly the right next step.
          The two are indistinguishable to this page by design, so it offers the
          action that helps one and merely fails harmlessly for the other.
        */}
        <p className="mt-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
          Already set up your account?{" "}
          <Link
            href="/login"
            className="rounded-sm font-medium text-indigo-600 underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:text-indigo-400 dark:focus-visible:ring-offset-zinc-900"
          >
            Sign in
          </Link>
        </p>
      </main>
    </div>
  );
}
