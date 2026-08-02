import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading UI for the Claim Review dashboard.
 *
 * Renders inside the already-mounted shell (the layout resolves first), so the
 * sidebar, header, reviewer name and Vendor name stay put and only the main region
 * swaps.
 *
 * The skeleton mirrors the real page's geometry — a heading block, then a single
 * wide panel where the empty state sits — so the swap to real content does not
 * shift the layout.
 *
 * NO FAKE DATA, and here that rule has a sharper edge than usual: this page will
 * never show a receipt count, so the skeleton must not imply one. Every placeholder
 * is a neutral pulsing block. Nothing renders a plausible number, a queue length or
 * a status badge — a skeleton that invents values is briefly indistinguishable from
 * real ones, and in this portal a fabricated count would be receipt data the caller
 * is not authorized to see.
 */
export default function ReviewDashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-3xl" aria-busy="true">
      {/* Screen readers get an announcement; sighted users get the skeleton. */}
      <span className="sr-only" role="status">
        Loading Claim Review…
      </span>

      <div aria-hidden="true" className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-10 shadow-card">
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-2xl" />
            <Skeleton className="h-5 w-64 max-w-full" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
