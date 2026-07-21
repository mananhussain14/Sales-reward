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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="h-3 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="mt-2 h-7 w-64 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          </div>
          <div className="h-5 w-28 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
        </div>

        {/* Metric grid — same columns and gap as the real page. */}
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((tile) => (
            <div
              key={tile}
              className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="mt-3 h-8 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              <div className="mt-2 h-3 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            </div>
          ))}
        </div>

        <div className="mt-4 h-4 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />

        {/* Detail panel */}
        <div className="mt-8">
          <div className="h-4 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="mt-3 divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="flex items-center justify-between gap-4 px-5 py-3.5"
              >
                <div className="h-4 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
