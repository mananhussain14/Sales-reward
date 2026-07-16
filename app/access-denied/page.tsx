import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";

export const metadata: Metadata = {
  title: "Access denied · SalesReward Admin",
  description: "This account does not have Vendor Super Admin access.",
};

/**
 * Shown to an authenticated user who is not an active Vendor Super Admin.
 *
 * The access check runs again at this server boundary rather than trusting the
 * fact that the layout redirected here — this page is directly addressable, so
 * its own state must be established from the verified session, not from how the
 * caller arrived.
 *
 * The copy is deliberately vague about WHY access was denied. Naming the missing
 * role, the organization, or the failing lifecycle state would tell an
 * unauthorized (possibly hostile) account exactly what to acquire next, and
 * would confirm which organizations exist.
 *
 * No logout button yet — out of scope for this milestone.
 */
export default async function AccessDeniedPage() {
  const access = await getVendorSuperAdminAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  // An authorized admin has no reason to see this page — send them to the
  // dashboard. This also keeps the page self-correcting: once access is granted,
  // a stale bookmark stops being a dead end.
  if (access.status === "authorized") {
    redirect("/");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 dark:bg-zinc-900">
      <main className="w-full max-w-sm">
        {/* Branding — mirrors the login lockup so the two pages read as one product. */}
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
              You are signed in, but this account does not have active Vendor
              Super Admin access to the SalesReward admin.
            </p>

            <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
              If you believe this is a mistake, please contact your system
              administrator.
            </p>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-zinc-400 dark:text-zinc-600">
          Vendor Admin · v0.1
        </p>
      </main>
    </div>
  );
}
