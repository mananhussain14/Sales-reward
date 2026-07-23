import { Skeleton, SkeletonStatGrid } from "@/components/ui/skeleton";
import { cardClasses } from "@/components/ui/card";

/**
 * Route-level loading UI for the Retailer Owner overview.
 *
 * Renders inside the already-mounted shell (the layout resolves first), so the
 * sidebar, header, and retailer name stay put and only the main region swaps.
 *
 * The skeleton mirrors the real page's geometry — header block, then a
 * four-column metric grid at the same breakpoints, then a three-row detail
 * panel — so the swap to real content does not shift the layout.
 *
 * NO FAKE DATA. Every placeholder is a neutral pulsing block. Nothing here
 * renders a plausible retailer name, a shop count, a currency, or a status
 * badge: a skeleton that invents values is briefly indistinguishable from real
 * ones, and a number that changes as you read it is worse than an empty space.
 */
export default function RetailerOverviewLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl" aria-busy="true">
      {/* Screen readers get an announcement; sighted users get the skeleton. */}
      <span className="sr-only" role="status">
        Loading your retailer overview…
      </span>

      <div aria-hidden="true">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="mt-2 h-7 w-64" />
            <Skeleton className="mt-2 h-4 w-80 max-w-full" />
          </div>
          <Skeleton className="h-5 w-28 shrink-0 rounded-full" />
        </div>

        {/* Metric grid — same columns and gap as the real page. */}
        <div className="mt-8">
          <SkeletonStatGrid count={4} />
        </div>

        <Skeleton className="mt-4 h-4 w-28" />

        {/* Detail panel */}
        <div className="mt-8">
          <Skeleton className="h-4 w-40" />
          <div className={cardClasses("standard", "mt-3 divide-y divide-slate-100")}>
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="flex items-center justify-between gap-4 px-5 py-3.5"
              >
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
