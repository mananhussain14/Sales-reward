import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { RetailerForm } from "@/app/(admin)/retailers/new/retailer-form";
import { BackLink } from "@/components/ui/page-header";

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
        <BackLink href="/retailers">Back to Retailers</BackLink>

        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
          Add Retailer
        </h2>
        <p className="mt-1.5 max-w-2xl text-sm text-slate-500">
          Create a Retailer organization managed by{" "}
          <span className="font-medium text-slate-700">{organizationName}</span>,
          together with its first shop. The Retailer, the relationship, and the
          shop are all created as active, in a single step.
        </p>
      </div>

      <RetailerForm />
    </div>
  );
}
