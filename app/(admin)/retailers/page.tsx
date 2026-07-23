import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import {
  getVendorRetailers,
  type VendorRetailer,
} from "@/lib/retailers/vendor-retailers";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { ChevronRightIcon, PlusIcon, RetailersIcon } from "@/components/ui/icons";

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

/**
 * The Retailer name, linked to its detail route. Shared by the table and the
 * cards so both stay identical in target, styling, and focus behaviour.
 *
 * Only the NAME is the link — not the row, not the card. A row-wide link would
 * swallow the status badges and the shop count into one enormous anchor, which
 * screen readers announce as a single unreadable label, and it would leave no
 * way to add a second action to a row later without nesting interactive
 * elements. A named target is also what a keyboard user tabs to.
 *
 * The relationship id appears only in the href. It is never rendered as text.
 */
function RetailerNameLink({ retailer }: { retailer: VendorRetailer }) {
  return (
    <Link
      href={`/retailers/${retailer.relationshipId}`}
      className="rounded-sm font-semibold text-slate-900 underline-offset-4 transition-colors hover:text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
    >
      {retailer.retailerName}
    </Link>
  );
}

/**
 * The explicit "open this Retailer" action, so discovering the detail page never
 * depends on guessing that the name is clickable. It targets the SAME existing
 * detail route as the name — two separate, non-nested links in one row, both
 * keyboard-focusable, neither wrapping the status badges. `block` renders the
 * full-width mobile-card variant with its own visible label.
 */
function ViewDetailsLink({
  relationshipId,
  block = false,
}: {
  relationshipId: string;
  block?: boolean;
}) {
  return (
    <Link
      href={`/retailers/${relationshipId}`}
      className={buttonClasses(
        { variant: block ? "outline" : "ghost", size: "sm" },
        block ? "w-full" : "text-indigo-600 hover:bg-indigo-50 hover:text-indigo-700",
      )}
    >
      {block ? "View Retailer" : "View details"}
      <ChevronRightIcon className="h-4 w-4" />
    </Link>
  );
}

/** Wide-screen presentation. Hidden below `md`, where the cards take over. */
function RetailerTable({ retailers }: { retailers: VendorRetailer[] }) {
  return (
    <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card md:block">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">
              Retailer
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Retailer status
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Relationship
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Shops
            </th>
            <th scope="col" className="px-4 py-3 text-right font-semibold">
              Action
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {retailers.map((retailer) => (
            <tr key={retailer.relationshipId} className="transition-colors hover:bg-slate-50">
              <td className="px-4 py-3">
                <RetailerNameLink retailer={retailer} />
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={retailer.retailerStatus} />
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={retailer.relationshipStatus} />
              </td>
              <td className="px-4 py-3 text-slate-600">
                <ShopCount shopCount={retailer.shopCount} />
              </td>
              <td className="px-4 py-3 text-right">
                <div className="flex justify-end">
                  <ViewDetailsLink relationshipId={retailer.relationshipId} />
                </div>
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
      {retailers.map((retailer) => (
        <li
          key={retailer.relationshipId}
          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card"
        >
          <p>
            <RetailerNameLink retailer={retailer} />
          </p>
          <dl className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
              <dt className="text-xs text-slate-500">Retailer</dt>
              <dd>
                <StatusBadge status={retailer.retailerStatus} />
              </dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-xs text-slate-500">Relationship</dt>
              <dd>
                <StatusBadge status={retailer.relationshipStatus} />
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-sm text-slate-600">
            <ShopCount shopCount={retailer.shopCount} />
          </p>
          {/* An always-visible action, not a hover affordance, so opening the
              Retailer is obvious on touch. Same route as the name above. */}
          <div className="mt-4">
            <ViewDetailsLink relationshipId={retailer.relationshipId} block />
          </div>
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
    <Alert tone="success" role="status">
      Retailer created successfully.
    </Alert>
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
      {/*
        A plain link, not a Client Component: navigating to the form needs no
        client state. The form on the other side is where interactivity begins.
        It is placed here, outside the three body states below, so it is present
        whether the directory lists Retailers, is empty, or could not be loaded.
      */}
      <PageHeader
        title="Retailers"
        description={
          <>
            Retailer organizations managed by{" "}
            <span className="font-medium text-slate-700">{organizationName}</span>
            , with each Retailer&apos;s own state, the state of its relationship
            with this Vendor, and how many shops it has on record.
          </>
        }
        actions={
          <Link href="/retailers/new" className={buttonClasses({ variant: "primary" })}>
            <PlusIcon className="h-4 w-4" />
            Add Retailer
          </Link>
        }
      />

      {justCreated && <CreatedBanner />}

      {retailers === null ? (
        // Deliberately generic and reason-free: the only cause is a database
        // failure, whose detail must never reach a browser. Distinct from the
        // empty state below — unknown is not the same as none.
        <EmptyState
          icon={<RetailersIcon className="h-6 w-6" />}
          title="Directory unavailable"
          description="The Retailer directory could not be loaded. Please try again shortly."
        />
      ) : retailers.length === 0 ? (
        <EmptyState
          icon={<RetailersIcon className="h-6 w-6" />}
          tone="indigo"
          title="No Retailers yet"
          description="Add your first Retailer to begin managing shops, Owners and products."
          action={
            <Link href="/retailers/new" className={buttonClasses({ variant: "primary" })}>
              <PlusIcon className="h-4 w-4" />
              Add Retailer
            </Link>
          }
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
