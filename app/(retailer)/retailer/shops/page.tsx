import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  getRetailerOwnerPortalAccess,
  getRetailerOwnerPortalShops,
} from "@/lib/retailer-portal/retailer-owner-portal";
import { buildShopKey } from "@/lib/retailer-portal/portal-normalization";
import { StatusBadge } from "@/components/admin/status-badge";

export const metadata: Metadata = {
  title: "Shops · Retailer Owner Portal",
  description: "Read-only list of your Retailer organization's shops.",
};

/**
 * Read-only shop list for the authorized Retailer.
 *
 * Calls exactly one data function, which calls exactly one RPC:
 * public.list_retailer_owner_portal_shops(). That RPC takes no arguments and
 * resolves its own scope from auth.uid(), so this page cannot — and does not —
 * tell the database which Retailer to list. There is no dynamic segment, no
 * search parameter, and no prop through which a tenant could be nominated.
 *
 * NO IDENTIFIERS ANYWHERE. The RPC returns no shop id, so none reaches the
 * markup, a DOM attribute, a URL, a React key, the serialized RSC payload, or a
 * browser log. React keys are built from shopCode plus array index — see
 * buildShopKey — precisely because there is no id to key on and shopCode is not
 * unique in the schema.
 *
 * READ-ONLY. No create, edit, delete, activate, deactivate, row menu, or row
 * link. Rows are not interactive at all: with no shop-detail route in this
 * milestone, a clickable row would have nowhere to go and would need an id to
 * get there.
 */

/** Renders a nullable text column without printing an empty cell. */
function OptionalCell({ value }: { value: string | null }) {
  if (value === null) {
    return (
      <span className="text-zinc-400 dark:text-zinc-600" aria-label="Not recorded">
        —
      </span>
    );
  }

  return <>{value}</>;
}

export default async function RetailerShopsPage() {
  // Authorization first, and at this page's own server boundary — it is directly
  // addressable, so it must not depend on the layout having run.
  const access = await getRetailerOwnerPortalAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }

  if (access.status === "unavailable") {
    throw new Error("Retailer portal context is temporarily unavailable.");
  }

  const shopsResult = await getRetailerOwnerPortalShops();

  // A failed READ is not a failed authorization. The caller is a verified,
  // authorized Retailer Owner — the check above established that — so this
  // renders a retry-safe error region inside the portal rather than redirecting
  // them to an access-denied page that would misattribute a transport or schema
  // fault to their permissions.
  if (shopsResult.status === "unavailable") {
    return (
      <div className="mx-auto w-full max-w-6xl">
        <ShopsHeader />

        <div
          role="alert"
          className="mt-8 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-900/60 dark:bg-amber-950/40"
        >
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Shops could not be loaded
          </h3>
          {/* Generic by design. The underlying cause — a transport fault, an RPC
              error, or a malformed row — was logged server-side as a sanitized
              category. No SQL, RPC name, schema name, policy, id, or stack
              trace reaches the browser. */}
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
            Something went wrong while loading your shops. Please try again in a
            moment.
          </p>
        </div>
      </div>
    );
  }

  const { shops } = shopsResult;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <ShopsHeader shopCount={shops.length} />

      {shops.length === 0 ? (
        /* Empty state. Worded so it cannot be mistaken for a permission
           problem: the caller IS authorized — that is why they can see this
           page — and their Retailer simply has no shops recorded yet. No "Add
           shop" action: this milestone is read-only, and shop creation is a
           Vendor Admin capability. */
        <div className="mt-8 rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-950">
          <span
            className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <path d="M13.5 21v-7.5a.75.75 0 01.75-.75h3a.75.75 0 01.75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 003.75-.615A2.993 2.993 0 009.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 002.25 1.016c.896 0 1.7-.393 2.25-1.015a3.001 3.001 0 003.75.614m-16.5 0a3.004 3.004 0 01-.621-4.72L4.318 3.44A1.5 1.5 0 015.378 3h13.243a1.5 1.5 0 011.06.44l1.19 1.189a3 3 0 01-.621 4.72" />
            </svg>
          </span>
          <h3 className="mt-4 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            No shops to show
          </h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
            There are no shops recorded for your organization yet. Shops added by
            SalesReward will appear here automatically.
          </p>
        </div>
      ) : (
        <>
          {/* Desktop: a real table. Horizontally scrollable rather than
              wrapping, so narrow viewports never squash the columns. */}
          <div className="mt-8 hidden overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm sm:block dark:border-zinc-800 dark:bg-zinc-950">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
                <caption className="sr-only">
                  Shops belonging to your Retailer organization
                </caption>
                <thead className="bg-zinc-50 dark:bg-zinc-900/50">
                  <tr>
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                    >
                      Shop
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                    >
                      Code
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                    >
                      City
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                    >
                      Country
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                    >
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {/* Rendered in the RPC's own order (name, code NULLS LAST,
                      id). Nothing is re-sorted here — a second, locale-dependent
                      ordering could disagree with the database's. */}
                  {shops.map((shop, index) => (
                    <tr key={buildShopKey(shop, index)}>
                      <td className="whitespace-nowrap px-5 py-3.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        {shop.shopName}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-sm text-zinc-600 dark:text-zinc-400">
                        <OptionalCell value={shop.shopCode} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-sm text-zinc-600 dark:text-zinc-400">
                        <OptionalCell value={shop.city} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-sm text-zinc-600 dark:text-zinc-400">
                        <OptionalCell value={shop.countryCode} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        <StatusBadge status={shop.shopStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile: stacked cards. A five-column table is unreadable below
              `sm`, and horizontal scrolling for primary content is worse than
              restacking it. */}
          <ul className="mt-8 flex flex-col gap-3 sm:hidden">
            {shops.map((shop, index) => (
              <li
                key={buildShopKey(shop, index)}
                className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {shop.shopName}
                  </p>
                  <StatusBadge status={shop.shopStatus} />
                </div>

                <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-500 dark:text-zinc-400">Code</dt>
                    <dd className="text-zinc-700 dark:text-zinc-300">
                      <OptionalCell value={shop.shopCode} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-500 dark:text-zinc-400">City</dt>
                    <dd className="text-zinc-700 dark:text-zinc-300">
                      <OptionalCell value={shop.city} />
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-zinc-500 dark:text-zinc-400">Country</dt>
                    <dd className="text-zinc-700 dark:text-zinc-300">
                      <OptionalCell value={shop.countryCode} />
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Page title block. Shared by the loaded, empty, and error renders. */
function ShopsHeader({ shopCount }: { shopCount?: number }) {
  return (
    <header>
      <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Shops
      </h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {shopCount === undefined
          ? "Shops recorded for your Retailer organization."
          : shopCount === 1
            ? "1 shop recorded for your Retailer organization."
            : `${shopCount.toLocaleString("en-US")} shops recorded for your Retailer organization.`}
      </p>
    </header>
  );
}
