import type { Metadata } from "next";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { formatOwnerTimestamp } from "@/lib/retailers/owner-status-normalization";
import { readExistingUserInviteHash } from "@/lib/invitations/existing-user-cookie";
import { resolveExistingUserInvitation } from "@/lib/invitations/existing-user-acceptance";
import { AcceptExistingInvitationForm } from "@/app/invitations/existing/accept-form";
import { SignOutMismatchForm } from "@/app/invitations/existing/sign-out-form";

/**
 * The CLEAN existing-user acceptance page (no token in the URL — it was exchanged
 * for an HttpOnly hash cookie by /invitations/existing/enter).
 *
 * `referrer: no-referrer` so this page never leaks its URL onward. `robots
 * noindex` because an invitation page should never be indexed.
 */
export const metadata: Metadata = {
  title: "Accept invitation · SalesReward",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/** Centered card shell shared by every state below. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-900">
      <main className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-600 text-base font-bold text-white">
            SR
          </span>
          <span className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            SalesReward
          </span>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-950">
          {children}
        </div>
      </main>
    </div>
  );
}

/**
 * The acceptance page.
 *
 * Never queries invitation tables directly — everything flows through the two
 * SECURITY DEFINER RPCs (resolver + accept) wrapped in
 * @/lib/invitations/existing-user-acceptance, under the caller's own token. The
 * hash is read from the HttpOnly cookie server-side and never rendered.
 */
export default async function ExistingUserInvitationPage() {
  const supabase = await createClient();

  let signedIn = false;
  try {
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  } catch {
    signedIn = false;
  }

  // Signed out: prompt sign-in. The invitation hash cookie survives login; `next`
  // carries only the clean path, never the raw token.
  if (!signedIn) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Sign in to accept your invitation
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          You&rsquo;ve been invited to become a Retailer Owner. Sign in to your existing
          SalesReward account to accept.
        </p>
        <Link
          href="/login?next=/invitations/existing"
          className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950"
        >
          Sign in
        </Link>
      </Shell>
    );
  }

  const tokenHash = await readExistingUserInviteHash();
  if (!tokenHash) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Invitation link not found
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          This invitation link is no longer valid. Please open the most recent
          invitation email again, or ask the person who invited you to send a new one.
        </p>
      </Shell>
    );
  }

  const resolved = await resolveExistingUserInvitation(tokenHash);

  if (resolved.status === "unavailable") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          This invitation can no longer be accepted
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          The invitation may have expired, been withdrawn, or already been accepted.
          Please ask the person who invited you to send a new one.
        </p>
      </Shell>
    );
  }

  if (resolved.status === "mismatch") {
    // A valid invitation, but this is the wrong (or unverified) account. Reveal
    // NOTHING about the invited address or Retailer.
    return (
      <Shell>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          This invitation is for a different account
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          You&rsquo;re signed in as a different account than the one this invitation was
          sent to. Sign out and sign in as the invited email address to accept it.
        </p>
        <div className="mt-6">
          <SignOutMismatchForm />
        </div>
      </Shell>
    );
  }

  // Match: the caller&rsquo;s verified email matches the invitation.
  return (
    <Shell>
      <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Accept ownership of {resolved.retailerName}
      </h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        Accepting makes you the Retailer Owner of{" "}
        <span className="font-medium text-zinc-700 dark:text-zinc-300">
          {resolved.retailerName}
        </span>{" "}
        on SalesReward.
      </p>
      {resolved.expiresAt && (
        <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
          This invitation is valid until {formatOwnerTimestamp(resolved.expiresAt)}.
        </p>
      )}
      <div className="mt-6">
        <AcceptExistingInvitationForm />
      </div>
    </Shell>
  );
}
