import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading UI for one receipt.
 *
 * Mirrors the real page's geometry — header, a wide image panel, and a narrower
 * column of metadata and decision controls — so the swap to real content does not
 * shift the layout.
 *
 * NO FAKE DATA. Every placeholder is a neutral pulsing block: nothing renders a
 * Retailer name, a shop, a filename, a decision or a badge. A skeleton that
 * invents values is briefly indistinguishable from real ones, and here that would
 * be receipt data the caller may not be authorized to see — this route is reached
 * before the RPC has said whether they may see anything at all.
 */
export default function ClaimReviewDetailLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6" aria-busy="true">
      <span className="sr-only" role="status">
        Loading this receipt…
      </span>

      <div aria-hidden="true" className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-64 max-w-full" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <Skeleton className="h-9 w-32 shrink-0 rounded-lg" />
        </div>

        <div className="grid gap-6 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-8 w-28 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-72 w-full rounded-xl sm:h-96" />
              <Skeleton className="mt-3 h-3 w-72 max-w-full" />
            </div>
          </div>

          <div className="space-y-6 lg:col-span-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
              <Skeleton className="h-4 w-36" />
              <div className="mt-4 space-y-4">
                {[0, 1, 2, 3, 4, 5].map((row) => (
                  <div key={row} className="space-y-1.5">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-4 w-44 max-w-full" />
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
              <Skeleton className="h-4 w-44" />
              <Skeleton className="mt-3 h-4 w-full" />
              <Skeleton className="mt-1.5 h-4 w-5/6" />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
              <Skeleton className="h-4 w-40" />
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
              </div>
              <Skeleton className="mt-4 h-11 w-52 rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
