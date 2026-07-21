/**
 * Route-level loading UI for the Retailer Owner shop list.
 *
 * Mirrors the real page's geometry — title block, then the desktop table shell
 * with its five column headers, then stacked cards below `sm` — so the swap to
 * real content does not shift the layout at either breakpoint.
 *
 * NO FAKE DATA. The column headers are static labels that are identical on the
 * real page, so they are safe to show; every cell is a neutral pulsing block.
 * No plausible shop name, code, city, country, or status badge is rendered — a
 * skeleton that invents a shop is briefly indistinguishable from a real one.
 *
 * The row count is a fixed placeholder and is deliberately NOT presented as the
 * real number of shops: the count is unknown until the RPC returns, and the
 * heading below shows no figure at all until it does.
 */

/** Placeholder rows. Enough to fill the fold without implying a real count. */
const SKELETON_ROWS = [0, 1, 2, 3, 4];

export default function RetailerShopsLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl" aria-busy="true">
      <span className="sr-only" role="status">
        Loading your shops…
      </span>

      <div aria-hidden="true">
        {/* Title block */}
        <div>
          <div className="h-7 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="mt-2 h-4 w-72 max-w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>

        {/* Desktop table shell */}
        <div className="mt-8 hidden overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm sm:block dark:border-zinc-800 dark:bg-zinc-950">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-900/50">
                <tr>
                  {["Shop", "Code", "City", "Country", "Status"].map((heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {SKELETON_ROWS.map((row) => (
                  <tr key={row}>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-10 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-5 w-16 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Mobile card shells */}
        <ul className="mt-8 flex flex-col gap-3 sm:hidden">
          {SKELETON_ROWS.map((row) => (
            <li
              key={row}
              className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="h-4 w-36 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-5 w-16 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {[0, 1, 2].map((line) => (
                  <div key={line} className="flex justify-between gap-3">
                    <div className="h-4 w-14 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    <div className="h-4 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
