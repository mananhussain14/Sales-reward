import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getRetailerOwnerPortalAccess } from "@/lib/retailer-portal/retailer-owner-portal";
import { LANDING_ROUTES } from "@/lib/auth/landing-decision";
import { SignOutButton } from "@/components/auth/sign-out-button";

export const metadata: Metadata = {
  title: "Account activated · SalesReward",
};

/**
 * A safe FALLBACK boundary for a completed invitation.
 *
 * The primary completion path no longer stops here: after
 * accept_retailer_owner_invitation() commits, app/invitations/complete/actions.ts
 * redirects straight to /retailer. This page is what a refresh, an old bookmark,
 * a re-clicked email, or a manual visit lands on — so it must be correct for a
 * user who is ALREADY a fully-activated owner, and safe for everyone else.
 *
 * It resolves Retailer Owner access at its own server boundary rather than
 * trusting how the caller arrived, and routes on the result:
 *   * authorized      -> /retailer (the portal), since acceptance now produces an
 *                        ACTIVE profile + membership. This is a redirect to a
 *                        DIFFERENT route, so there is no loop with this page.
 *   * unauthenticated -> /login (this person has a password and can sign in).
 *   * unauthorized    -> a generic activated-but-no-workspace card. Reached by a
 *                        signed-in non-owner (e.g. a Vendor admin who wandered
 *                        here); it reveals nothing about invitations or
 *                        membership and offers only sign-out.
 *   * unavailable     -> a generic retry-safe card, NOT a denial: an operational
 *                        failure must not read as "you don't have access".
 *
 * The outdated "the retailer workspace is not enabled yet" copy is gone — the
 * portal exists and an activated owner is sent into it.
 *
 * Reveals no invitation or membership internals: no id, email, token, Retailer
 * name, or status. The authorized branch redirects before rendering anything, and
 * the two rendered branches are fixed text.
 */
export default async function InvitationSuccessPage() {
  const access = await getRetailerOwnerPortalAccess();

  if (access.status === "unauthenticated") {
    redirect(LANDING_ROUTES.login);
  }

  if (access.status === "authorized") {
    // A fully-activated owner: send them into the portal they now have access to.
    redirect(LANDING_ROUTES.retailer);
  }

  // access.status is "unauthorized" or "unavailable" — both render a safe card
  // below. They are distinguished only by wording (denial-neutral vs
  // retry-safe); neither exposes why.
  const isUnavailable = access.status === "unavailable";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-900">
      <main className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-600 text-base font-bold text-white">
            SR
          </span>
          <span className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            SalesReward
          </span>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 text-center shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-950">
          {isUnavailable ? (
            <>
              <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                Something went wrong
              </h1>
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                We couldn&apos;t load your workspace just now. This is usually
                temporary.
              </p>
              {/* A plain retry into the portal, which re-runs the access check.
                  No id or state is carried; it is a fixed internal route. */}
              <div className="mt-6">
                <Link
                  href={LANDING_ROUTES.retailer}
                  className="inline-flex w-full items-center justify-center rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950"
                >
                  Try again
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-5 w-5"
                  aria-hidden="true"
                >
                  <path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>

              <h1 className="mt-4 text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                You&apos;re signed in
              </h1>
              {/* Deliberately generic. This branch is a signed-in caller who is
                  not an authorized Retailer Owner; it must not confirm or deny
                  any invitation or membership. */}
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                This account doesn&apos;t currently have access to a retailer
                workspace. If you believe this is a mistake, please contact the
                person who invited you.
              </p>

              <div className="mt-6">
                <SignOutButton variant="card" />
              </div>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-600">
          SalesReward · v0.1
        </p>
      </main>
    </div>
  );
}
