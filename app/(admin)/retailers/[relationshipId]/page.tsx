import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import {
  getVendorRetailerDetail,
  type VendorRetailerDetail,
  type VendorRetailerShopDetail,
} from "@/lib/retailers/vendor-retailer-detail";

/**
 * Static, and deliberately generic. Naming the Retailer in the title would mean
 * calling the loader a second time from generateMetadata() — the same three
 * queries again, for a browser tab label — and would put a Retailer's name in
 * history entries and window titles for a page whose whole design keeps its
 * identifiers out of view. The heading names the Retailer; the tab does not.
 */
export const metadata: Metadata = {
  title: "Retailer · SalesReward Admin",
};

/**
 * `params` is a Promise in this version of Next.js and must be awaited before
 * any value is read — the same shape the directory's `searchParams` uses.
 */
type PageProps = {
  params: Promise<{
    relationshipId: string;
  }>;
};

/**
 * A stored value that is absent. The dash is decorative, so it is hidden from
 * assistive technology and paired with real text — a screen reader announcing
 * "em dash" says nothing about the data, while "Not recorded" does.
 */
function NotRecorded() {
  return (
    <span className="text-zinc-400 dark:text-zinc-500">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not recorded</span>
    </span>
  );
}

/** Renders a nullable stored string, falling back to the absent marker. */
function OptionalValue({ value }: { value: string | null }) {
  return value === null ? <NotRecorded /> : <>{value}</>;
}

/** Returns to the directory. Present in every state this page can render. */
function BackToRetailersLink() {
  return (
    <Link
      href="/retailers"
      className="inline-flex items-center gap-1.5 rounded-sm text-sm text-zinc-500 underline-offset-4 transition-colors hover:text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:text-zinc-400 dark:hover:text-indigo-400 dark:focus-visible:ring-offset-zinc-950"
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
  );
}

/** One labelled fact in the summary list. */
function SummaryItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-50">{children}</dd>
    </div>
  );
}

/**
 * The Retailer's own facts, as a description list: each value is genuinely a
 * term/definition pair, which a table would only imitate.
 *
 * The two statuses are separate facts and are labelled as such — a Retailer
 * company can be Active while this Vendor has Suspended its relationship with
 * it, and one badge could not say that.
 */
function RetailerSummary({ retailer }: { retailer: VendorRetailerDetail }) {
  return (
    <section
      aria-label="Retailer summary"
      className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950"
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryItem label="Retailer status">
          <StatusBadge status={retailer.retailerStatus} />
        </SummaryItem>
        <SummaryItem label="Relationship status">
          <StatusBadge status={retailer.relationshipStatus} />
        </SummaryItem>
        <SummaryItem label="Country code">
          <OptionalValue value={retailer.countryCode} />
        </SummaryItem>
        <SummaryItem label="Default currency">
          <OptionalValue value={retailer.defaultCurrency} />
        </SummaryItem>
      </dl>
    </section>
  );
}

/** Wide-screen shop presentation. Hidden below `md`, where the cards take over. */
function ShopTable({ shops }: { shops: VendorRetailerShopDetail[] }) {
  return (
    <div className="hidden overflow-hidden rounded-xl border border-zinc-200 md:block dark:border-zinc-800">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Shop
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Code
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              City
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Country
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
          {shops.map((shop, index) => (
            // The shop payload deliberately carries no id, and two shops may
            // legitimately share every visible field — name, code, city, country,
            // and status alike — so a key built from those fields could collide
            // and would silently break rendering the moment it did. The index is
            // safe here for the same reason it was in the directory before
            // relationship ids arrived: this list is server-rendered once, in the
            // loader's fixed alphabetical order, and is never reordered,
            // filtered, paginated, or mutated on the client.
            <tr key={index}>
              <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                {shop.name}
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                <OptionalValue value={shop.code} />
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                <OptionalValue value={shop.city} />
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                <OptionalValue value={shop.countryCode} />
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={shop.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Small-screen shop presentation. A five-column table cannot stay readable at
 * phone widths, so each shop becomes a labelled card rather than a horizontally
 * scrolling row. The card carries its own labels because it has no column
 * headers to inherit them from.
 */
function ShopCards({ shops }: { shops: VendorRetailerShopDetail[] }) {
  return (
    <ul className="space-y-3 md:hidden">
      {shops.map((shop, index) => (
        // Index key for the same reason as the table above: the payload has no
        // id, the visible fields are not guaranteed unique, and the order is
        // fixed and server-rendered.
        <li
          key={index}
          className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-zinc-900 dark:text-zinc-50">{shop.name}</p>
            <StatusBadge status={shop.status} />
          </div>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">Code</dt>
              <dd className="text-zinc-700 dark:text-zinc-300">
                <OptionalValue value={shop.code} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">City</dt>
              <dd className="text-zinc-700 dark:text-zinc-300">
                <OptionalValue value={shop.city} />
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-zinc-500 dark:text-zinc-400">Country</dt>
              <dd className="text-zinc-700 dark:text-zinc-300">
                <OptionalValue value={shop.countryCode} />
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

/** Neutral panel, used for the empty-shops and unavailable states alike. */
function NoticePanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{title}</p>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{body}</p>
    </div>
  );
}

/**
 * Read-only detail view of one Vendor-managed Retailer. A Server Component: the
 * queries, the organization id, and the session all stay on the server, and only
 * display strings reach the browser.
 *
 * The relationship id from the URL is used for exactly one thing — passing to
 * the loader, which treats it as an address and not as authorization. It is
 * never rendered, never placed in metadata or a data attribute, and never
 * logged. Every authorization decision belongs to the loader's own call to
 * getVendorSuperAdminAccess().
 */
export default async function RetailerDetailPage({ params }: PageProps) {
  const { relationshipId } = await params;
  const detail = await getVendorRetailerDetail(relationshipId);

  // As on the directory, the dashboard, and the users page, this page does not
  // assume the layout already guarded it — the rule must hold for this module
  // regardless of the route tree it is composed into. All of them call the same
  // authorization function, so they cannot disagree.
  if (detail.status === "unauthenticated") {
    redirect("/login");
  }

  if (detail.status === "unauthorized") {
    redirect("/access-denied");
  }

  // A malformed id, an unknown id, another Vendor's id, and an id whose row RLS
  // declines to return all arrive here identically — the loader does not
  // distinguish them, and neither does this page. The standard 404 is the right
  // response to every one of them.
  if (detail.status === "not-found") {
    notFound();
  }

  if (detail.status === "unavailable") {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <BackToRetailersLink />
        {/*
          Deliberately generic and reason-free: the only cause is a database or
          network failure, whose detail must never reach a browser. No query,
          table, policy, identifier, or error text appears here.
        */}
        <NoticePanel
          title="Retailer unavailable"
          body="Retailer details are temporarily unavailable. Please try again."
        />
        <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          Signed in to{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {detail.organizationName}
          </span>
        </p>
      </div>
    );
  }

  const { organizationName, retailer } = detail;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <BackToRetailersLink />

      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {retailer.retailerName}
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          A read-only view of this Retailer organization and its shops, as managed
          by{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {organizationName}
          </span>
          .
        </p>
      </div>

      <RetailerSummary retailer={retailer} />

      <section aria-labelledby="shops-heading" className="space-y-3">
        <h3
          id="shops-heading"
          className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50"
        >
          Shops
        </h3>

        {retailer.shops.length === 0 ? (
          // Not an error, and deliberately worded so it cannot be mistaken for
          // one: a Retailer with no shops yet is an ordinary, expected state, and
          // this is a different claim from "we could not load the shops".
          <NoticePanel
            title="No shops yet"
            body="This Retailer has no shops recorded."
          />
        ) : (
          <>
            <ShopTable shops={retailer.shops} />
            <ShopCards shops={retailer.shops} />
          </>
        )}
      </section>
    </div>
  );
}
