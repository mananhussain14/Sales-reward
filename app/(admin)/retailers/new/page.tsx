import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { RetailerForm } from "@/app/(admin)/retailers/new/retailer-form";

export const metadata: Metadata = {
  title: "Add Retailer · SalesReward Admin",
};

/**
 * Retailer onboarding page for the authorized Vendor organization.
 *
 * A Server Component: the session and the authorization decision stay on the
 * server, and only the form — which carries no ids at all — reaches the browser.
 *
 * The guard is repeated here rather than inherited from the (admin) layout, for
 * the same stated reason as the dashboard, the users page, and the retailer
 * directory: the rule must hold for this module regardless of the route tree it
 * is composed into. Every one of them calls the same function, so they cannot
 * disagree. The Server Action behind the form repeats it a third time, because a
 * form rendered behind a guard says nothing about who can call the action.
 */
export default async function NewRetailerPage() {
  const access = await getVendorSuperAdminAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  // Past this point `access.status` is "authorized", so the organization name
  // below is the one resolved by the check above — the only source it may come
  // from. No id from `access` is rendered, passed to the form, or sent anywhere.
  const { organizationName } = access;

  return (
    // A narrower column than the 6xl directory: a single-column form is harder
    // to scan when its labels and inputs are stretched across a wide screen.
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/retailers"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:text-zinc-400 dark:hover:text-zinc-100 dark:focus-visible:ring-offset-zinc-950"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
          Back to Retailers
        </Link>

        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Add Retailer
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Create a Retailer organization managed by{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {organizationName}
          </span>
          , together with its first shop. The Retailer, the relationship, and the
          shop are all created as active, in a single step.
        </p>
      </div>

      <RetailerForm />
    </div>
  );
}
