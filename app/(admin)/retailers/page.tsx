import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import {
  getVendorRetailers,
  type VendorRetailer,
} from "@/lib/retailers/vendor-retailers";

export const metadata: Metadata = {
  title: "Retailers · SalesReward Admin",
};

/**
 * Counts read as prose rather than a bare number, so "1 shop" never renders as
 * "1 shops". A Retailer with no shops is a legitimate state — the loader reports
 * 0 rather than omitting the Retailer — and reads as "0 shops".
 */
function ShopCount({ shopCount }: { shopCount: number }) {
  return (
    <span>
      {shopCount} {shopCount === 1 ? "shop" : "shops"}
    </span>
  );
}

/** Wide-screen presentation. Hidden below `md`, where the cards take over. */
function RetailerTable({ retailers }: { retailers: VendorRetailer[] }) {
  return (
    <div className="hidden overflow-hidden rounded-xl border border-zinc-200 md:block dark:border-zinc-800">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Retailer
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Retailer status
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Relationship
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Shops
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
          {retailers.map((retailer, index) => (
            // The directory carries no ids by design, so there is no natural key:
            // two Retailers may legitimately share a name. The index is stable
            // here because this list is server-rendered in a fixed alphabetical
            // sort order and never reordered, filtered, or mutated on the client.
            <tr key={index}>
              <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                {retailer.retailerName}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={retailer.retailerStatus} />
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={retailer.relationshipStatus} />
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                <ShopCount shopCount={retailer.shopCount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Small-screen presentation. A four-column table cannot stay readable at phone
 * widths, so each Retailer becomes a labelled card rather than a horizontally
 * scrolling row.
 *
 * The two badges sit side by side, so the card labels which is which — on the
 * desktop table the column headers carry that, but a card has no headers and
 * "Active / Suspended" alone would not say that the company is live while the
 * relationship is paused.
 */
function RetailerCards({ retailers }: { retailers: VendorRetailer[] }) {
  return (
    <ul className="space-y-3 md:hidden">
      {retailers.map((retailer, index) => (
        // Index key for the same reason as the table above: no id, fixed order.
        <li
          key={index}
          className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <p className="font-medium text-zinc-900 dark:text-zinc-50">
            {retailer.retailerName}
          </p>
          <dl className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Retailer</dt>
              <dd>
                <StatusBadge status={retailer.retailerStatus} />
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Relationship</dt>
              <dd>
                <StatusBadge status={retailer.relationshipStatus} />
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            <ShopCount shopCount={retailer.shopCount} />
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Neutral panel used for both the empty and the unavailable states. */
function NoticePanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{title}</p>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{body}</p>
    </div>
  );
}

/**
 * Read-only Retailer directory for the authorized Vendor organization. A Server
 * Component: the queries, the organization id, and the session all stay on the
 * server, and only display strings reach the browser.
 */
export default async function RetailersPage() {
  const directory = await getVendorRetailers();

  // As on the dashboard and the users page, this page does not assume the layout
  // already guarded it — the rule must hold for this module regardless of the
  // route tree it is composed into. Both call the same function, so they cannot
  // disagree.
  if (directory.status === "unauthenticated") {
    redirect("/login");
  }

  if (directory.status === "unauthorized") {
    redirect("/access-denied");
  }

  const { organizationName, retailers } = directory;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Retailers
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Retailer organizations managed by{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {organizationName}
          </span>
          , with each Retailer&apos;s own state, the state of its relationship
          with this Vendor, and how many shops it has on record.
        </p>
      </div>

      {retailers === null ? (
        // Deliberately generic and reason-free: the only cause is a database
        // failure, whose detail must never reach a browser. Distinct from the
        // empty state below — unknown is not the same as none.
        <NoticePanel
          title="Directory unavailable"
          body="The Retailer directory could not be loaded. Please try again shortly."
        />
      ) : retailers.length === 0 ? (
        <NoticePanel
          title="No Retailers yet"
          body="This Vendor has no Retailer organizations on record."
        />
      ) : (
        <section aria-label="Vendor-managed Retailers">
          <RetailerTable retailers={retailers} />
          <RetailerCards retailers={retailers} />
        </section>
      )}
    </div>
  );
}
