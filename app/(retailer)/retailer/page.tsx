import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getRetailerOwnerPortalAccess } from "@/lib/retailer-portal/retailer-owner-portal";
import { StatusBadge } from "@/components/admin/status-badge";
import { PageHeader } from "@/components/ui/page-header";
import { cardClasses } from "@/components/ui/card";
import { ChevronRightIcon } from "@/components/ui/icons";

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
    <div className={cardClasses("standard", "p-5")}>
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-3 text-3xl font-semibold tabular-nums text-slate-900">
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
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
      <PageHeader
        eyebrow="Retailer Owner Portal"
        title={context.retailerName}
        description="A read-only view of your organization and its shops on SalesReward."
        actions={
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-slate-500">Retailer status</span>
            <StatusBadge status={context.retailerStatus} />
          </div>
        }
      />

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
            className="inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-indigo-600 transition-colors hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            View all shops
            <ChevronRightIcon className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* Additional context ------------------------------------------------ */}
      <section aria-labelledby="details-heading" className="mt-8">
        <h3 id="details-heading" className="text-sm font-semibold text-slate-900">
          Organization details
        </h3>

        <dl className={cardClasses("standard", "mt-3 divide-y divide-slate-100")}>
          <div className="flex items-center justify-between gap-4 px-5 py-3.5">
            <dt className="text-sm text-slate-500">Retailer name</dt>
            <dd className="truncate text-sm font-medium text-slate-900">
              {context.retailerName}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-5 py-3.5">
            <dt className="text-sm text-slate-500">Retailer status</dt>
            <dd>
              <StatusBadge status={context.retailerStatus} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 px-5 py-3.5">
            <dt className="text-sm text-slate-500">Your membership status</dt>
            <dd>
              <StatusBadge status={context.membershipStatus} />
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
