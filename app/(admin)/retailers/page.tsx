import type { Metadata } from "next";
import Link from "next/link";
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

/**
 * Confirmation shown once, immediately after onboarding, when the action
 * redirects here with `?created=1`.
 *
 * The flag is the entire message. It carries no Retailer id, no organization id,
 * no shop id, and no name — nothing from the database travels in the URL, so
 * there is nothing here to leak, tamper with, or address a row by. A forged
 * `?created=1` therefore shows a banner and changes nothing else, which is the
 * whole reason the flag is allowed to be this dumb.
 *
 * role="status" rather than "alert": this is a confirmation, announced politely,
 * not something demanding interruption.
 */
function CreatedBanner() {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
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
        <path d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p>Retailer created successfully.</p>
    </div>
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
export default async function RetailersPage({
  searchParams,
}: {
  // A promise in this version of Next.js — it must be awaited before any value
  // is read.
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [directory, resolvedSearchParams] = await Promise.all([
    getVendorRetailers(),
    searchParams,
  ]);

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

  // A repeated parameter arrives as an array, so the value is compared only when
  // it is a single string. Anything else — absent, repeated, or any other value
  // — simply means no banner.
  const justCreated = resolvedSearchParams.created === "1";

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/*
        The heading and the action sit in one row so "Add Retailer" aligns with
        the title. It is placed here, outside the three body states below, so it
        is present whether the directory lists Retailers, is empty, or could not
        be loaded — the empty state is exactly when a Vendor most needs it. It is
        also after both redirects above, so it can never render for a caller who
        is not an authorized Vendor Super Admin.
      */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
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

        {/*
          A plain link, not a Client Component: navigating to the form needs no
          client state. The form on the other side is where interactivity begins.
        */}
        <Link
          href="/retailers/new"
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-zinc-950"
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
            <path d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Retailer
        </Link>
      </div>

      {justCreated && <CreatedBanner />}

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
