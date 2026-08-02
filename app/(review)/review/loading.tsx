import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading UI for the Claim Reviewer receipt queue.
 *
 * Renders inside the already-mounted shell (the layout resolves first), so the
 * sidebar, header, reviewer name and Vendor name stay put and only the main region
 * swaps.
 *
 * The skeleton mirrors the real page's geometry — header, filter panel, then a stack
 * of receipt cards — so the swap to real content does not shift the layout.
 *
 * NO FAKE DATA, and here that rule has a sharper edge than usual. Every placeholder
 * is a neutral pulsing block: nothing renders a plausible number, a queue length, a
 * Retailer name or a status badge. A skeleton that invents values is briefly
 * indistinguishable from real ones, and in this portal a fabricated count or shop
 * name would be receipt data the caller may not be authorized to see.
 *
 * Three cards, not twenty-five: the number is a layout hint, never a claim about how
 * many receipts are waiting.
 */
export default function ClaimReviewQueueLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6" aria-busy="true">
      {/* Screen readers get an announcement; sighted users get the skeleton. */}
      <span className="sr-only" role="status">
        Loading the receipt review queue…
      </span>

      <div aria-hidden="true" className="space-y-6">
        {/* Header: eyebrow, title, description, and the count chip's footprint. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-56 max-w-full" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <Skeleton className="h-9 w-28 shrink-0 rounded-lg" />
        </div>

        {/* Filter panel. */}
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
          <Skeleton className="h-4 w-32" />
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Skeleton className="h-11 w-full rounded-lg" />
            <Skeleton className="h-11 w-full rounded-lg" />
            <Skeleton className="h-11 w-full rounded-lg sm:col-span-2 lg:col-span-2" />
          </div>
          <Skeleton className="mt-3 h-3 w-72 max-w-full" />
        </div>

        {/* Receipt cards. */}
        <div className="space-y-3">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1 space-y-3">
                  <Skeleton className="h-5 w-48 max-w-full" />
                  <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                    <Skeleton className="h-4 w-40 max-w-full" />
                    <Skeleton className="h-4 w-44 max-w-full" />
                    <Skeleton className="h-4 w-36 max-w-full" />
                    <Skeleton className="h-4 w-32 max-w-full" />
                  </div>
                  <Skeleton className="h-3 w-28" />
                </div>
                <Skeleton className="h-9 w-36 shrink-0 rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
