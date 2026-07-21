import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getRetailerOwnerPortalAccess } from "@/lib/retailer-portal/retailer-owner-portal";
import { StatusBadge } from "@/components/admin/status-badge";

export const metadata: Metadata = {
  title: "Overview · Retailer Owner Portal",
  description: "Read-only overview of your Retailer organization on SalesReward.",
};

/**
 * Retailer Owner Portal overview.
 *
 * Re-resolves access at its own server boundary rather than trusting that the
 * layout allowed it through: this page is directly addressable, so its state
 * must be established from the verified session, not from how the caller
 * arrived. React `cache` makes this free — the layout and this page share one
 * resolution per request.
 *
 * Everything rendered comes from the authorized context. There is no id of any
 * kind on this page: no organization id, membership id, profile id, role id, or
 * permission id reaches the markup, the props, or the RSC payload, because the
 * RPC returns none. No email address and no role or permission code is shown
 * either — the statuses below are lifecycle values, not authorization detail.
 *
 * READ-ONLY. There is no form, no button that mutates, and no action of any
 * kind on this page.
 */

/**
 * A metric tile.
 *
 * Deliberately not @/components/admin/stat-card: that component takes
 * `number | null` and renders "Unavailable" for null, which is the right shape
 * for the Vendor dashboard's independently-failing counts. Here the counts
 * arrive with the context or not at all — if the RPC failed, this page never
 * renders — so a per-tile "unavailable" state would be unreachable, and two of
 * the four tiles show text (currency, country) rather than numbers. Reusing it
 * would mean passing values it was not built to hold.
 */
function MetricTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
        {value}
      </p>
      <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>
    </div>
  );
}

/**
 * Renders a nullable code column.
 *
 * The verified ISO code is shown as stored. No country or currency NAME is
 * fabricated: this repository's only reference helper
 * (@/lib/reference/iso-country-codes) is a validation list of alpha-2 codes, not
 * a name lookup, and it covers no currencies at all. Inventing a display name
 * from an unvalidated mapping would risk showing the wrong country for a real
 * retailer, which is worse than showing the code the operator entered.
 */
function CodeValue({ code }: { code: string | null }) {
  return code ?? "—";
}

export default async function RetailerOverviewPage() {
  const access = await getRetailerOwnerPortalAccess();

  // The layout has already handled each of these, but this page is directly
  // addressable and must not depend on that. The branches are identical, so the
  // two boundaries can never disagree.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }

  if (access.status === "unavailable") {
    throw new Error("Retailer portal context is temporarily unavailable.");
  }

  const { context } = access;

  return (
    <div className="mx-auto w-full max-w-6xl">
      {/* Header ------------------------------------------------------------ */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-indigo-600 dark:text-indigo-400">
            Retailer Owner Portal
          </p>
          <h2 className="mt-1 truncate text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {context.retailerName}
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            A read-only view of your organization and its shops on SalesReward.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Retailer status
          </span>
          <StatusBadge status={context.retailerStatus} />
        </div>
      </header>

      {/* Summary cards ----------------------------------------------------- */}
      <section aria-labelledby="summary-heading" className="mt-8">
        <h3 id="summary-heading" className="sr-only">
          Summary
        </h3>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="Total shops"
            /* Fixed locale: formatted on the server, so a host-dependent locale
               would make output vary by machine. Matches StatCard. */
            value={context.totalShopCount.toLocaleString("en-US")}
            hint="All shops on record, in every status."
          />
          <MetricTile
            label="Active shops"
            value={context.activeShopCount.toLocaleString("en-US")}
            hint="Currently trading."
          />
          <MetricTile
            label="Default currency"
            value={CodeValue({ code: context.defaultCurrency })}
            hint="ISO 4217 code as recorded."
          />
          <MetricTile
            label="Country"
            value={CodeValue({ code: context.countryCode })}
            hint="ISO 3166-1 alpha-2 code as recorded."
          />
        </div>

        {/* Link into the shop list, anchored to the shop-count area as the
            milestone requires. Carries no id — /retailer/shops resolves its own
            scope from the caller's session. */}
        <div className="mt-4">
          <Link
            href="/retailer/shops"
            className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-indigo-600 transition-colors hover:text-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:text-indigo-400 dark:hover:text-indigo-300 dark:focus-visible:ring-offset-zinc-900"
          >
            View all shops
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
              <path d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
            </svg>
          </Link>
        </div>
      </section>

      {/* Additional context ------------------------------------------------ */}
      <section aria-labelledby="details-heading" className="mt-8">
        <h3
          id="details-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Organization details
        </h3>

        <dl className="mt-3 divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between gap-4 px-5 py-3.5">
            <dt className="text-sm text-zinc-500 dark:text-zinc-400">
              Retailer name
            </dt>
            <dd className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {context.retailerName}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-5 py-3.5">
            <dt className="text-sm text-zinc-500 dark:text-zinc-400">
              Retailer status
            </dt>
            <dd>
              <StatusBadge status={context.retailerStatus} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-5 py-3.5">
            <dt className="text-sm text-zinc-500 dark:text-zinc-400">
              Your membership status
            </dt>
            <dd>
              <StatusBadge status={context.membershipStatus} />
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
