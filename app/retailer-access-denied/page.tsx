import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRetailerOwnerPortalAccess } from "@/lib/retailer-portal/retailer-owner-portal";
import { SignOutButton } from "@/components/auth/sign-out-button";

export const metadata: Metadata = {
  title: "Access denied · Retailer Owner Portal",
  description: "This account does not have Retailer Owner portal access.",
};

/**
 * Shown to an authenticated user who is not an authorized Retailer Owner.
 *
 * It lives OUTSIDE the (retailer) route group deliberately. Inside it, the group
 * layout's own authorization check would redirect every unauthorized visitor
 * straight back here, producing a redirect loop — the page has to sit where the
 * guard does not run.
 *
 * The access check runs again at this server boundary rather than trusting that
 * the layout redirected here: this page is directly addressable, so its state
 * must be established from the verified session, not from how the caller
 * arrived.
 *
 * The copy is deliberately vague about WHY access was denied, matching
 * /access-denied. This page is reached identically by an inactive profile, an
 * INVITED or inactive membership, an inactive Retailer, a missing or inactive
 * RETAILER_OWNER role, a missing permission, a Vendor Super Admin with no
 * Retailer Owner membership, a user qualifying for zero Retailers, and a user
 * ambiguously qualifying for more than one. Naming the failing condition would
 * tell an unauthorized (possibly hostile) account exactly what to acquire next.
 *
 * The ambiguous case matters most here: it must NOT list the candidate
 * Retailers, or even hint that more than one exists. It reads exactly like every
 * other denial.
 *
 * A Vendor Super Admin who lands here is NOT redirected into the Vendor Admin.
 * That would be an automatic cross-portal redirect based on a failed check in a
 * different product surface — it would tell any visitor whether the signed-in
 * account holds Vendor access, and it would bounce someone who typed /retailer
 * deliberately. The sign-out control is the way out, exactly as on
 * /access-denied.
 */
export default async function RetailerAccessDeniedPage() {
  const access = await getRetailerOwnerPortalAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  // An authorized owner has no reason to see this page — send them to the
  // portal. This keeps the page self-correcting: once access is granted, a stale
  // bookmark stops being a dead end.
  if (access.status === "authorized") {
    redirect("/retailer");
  }

  // "unavailable" deliberately falls through to the same generic card below.
  // The caller could not be evaluated, so the honest thing is to show no more
  // than the denial does — inventing a distinct "try again" state here would
  // reveal that the check reached the database and failed, rather than that it
  // denied.

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-900">
      <main className="w-full max-w-sm">
        {/* Branding — mirrors the login and access-denied lockups so every entry
            point reads as one product. */}
        <div className="mb-8 flex flex-col items-center text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-600 text-base font-bold text-white">
            SR
          </span>
          <span className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
            SalesReward
          </span>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-col items-center text-center">
            <span
              className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400"
              aria-hidden="true"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5"
              >
                <path d="M12 9v3.75m0 3.75h.008M10.34 3.94l-8.02 13.5A1.5 1.5 0 003.6 19.5h16.8a1.5 1.5 0 001.28-2.06l-8.02-13.5a1.5 1.5 0 00-2.58 0z" />
              </svg>
            </span>

            <h1 className="mt-4 text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Access denied
            </h1>

            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
              You are signed in, but this account does not have access to the
              SalesReward Retailer Owner Portal.
            </p>

            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
              If you believe this is a mistake, please contact your system
              administrator.
            </p>

            {/* Lets the user sign out and return to /login with another account.
                Signing out requires no authorization — see app/auth/actions.ts. */}
            <div className="mt-6 w-full">
              <SignOutButton variant="card" />
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-600">
          Retailer Owner Portal · v0.1
        </p>
      </main>
    </div>
  );
}
