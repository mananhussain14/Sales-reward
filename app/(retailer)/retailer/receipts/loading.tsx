/**
 * Route-level loading UI for the Sales Staff receipt page.
 *
 * Renders inside the already-mounted shell (the layout resolves first), so the sidebar
 * and header stay put and only the main region swaps.
 *
 * The skeleton mirrors the real page's geometry — title block, submission card, then
 * the history table with its five column headers and stacked cards below `sm` — so the
 * swap to real content does not shift the layout at either breakpoint.
 *
 * NO FAKE DATA. The column headers and the two section labels are static and identical
 * on the real page, so they are safe to show; every value is a neutral pulsing block.
 * No plausible shop name, filename, size, date or status badge is rendered — a skeleton
 * that invents a submission is briefly indistinguishable from a real one.
 */

const SKELETON_ROWS = [0, 1, 2];

const thClasses =
  "px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400";

export default function RetailerReceiptsLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl" aria-busy="true">
      <span className="sr-only" role="status">
        Loading your receipts…
      </span>

      <div aria-hidden="true">
        {/* Title block */}
        <div>
          <div className="h-7 w-32 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
          <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
        </div>

        {/* Submission card */}
        <div className="mt-8 h-4 w-36 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 dark:border-slate-800 dark:bg-slate-950">
          <div className="space-y-5">
            <div className="space-y-2">
              <div className="h-4 w-16 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
              <div className="h-9 w-full animate-pulse rounded-md bg-slate-200 dark:bg-slate-800" />
            </div>
            <div className="space-y-2">
              <div className="h-4 w-28 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
              <div className="h-9 w-full animate-pulse rounded-md bg-slate-200 dark:bg-slate-800" />
              <div className="h-3 w-56 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
            </div>
            <div className="h-10 w-40 animate-pulse rounded-md bg-slate-200 dark:bg-slate-800" />
          </div>
        </div>

        {/* History */}
        <div className="mt-10 h-4 w-32 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />

        <div className="mt-3 hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm sm:block dark:border-slate-800 dark:bg-slate-950">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800">
              <thead className="bg-slate-50 dark:bg-slate-900/50">
                <tr>
                  {["Submitted", "Shop", "File", "Size", "Status"].map((heading) => (
                    <th key={heading} scope="col" className={thClasses}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {SKELETON_ROWS.map((row) => (
                  <tr key={row}>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-32 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-28 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-36 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-14 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-5 w-20 animate-pulse rounded-full bg-slate-200 dark:bg-slate-800" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <ul className="mt-3 flex flex-col gap-3 sm:hidden">
          {SKELETON_ROWS.map((row) => (
            <li
              key={row}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-950"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="h-4 w-36 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                <div className="h-5 w-20 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-slate-800" />
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {[0, 1, 2].map((line) => (
                  <div key={line} className="flex justify-between gap-3">
                    <div className="h-4 w-16 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
                    <div className="h-4 w-24 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
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
