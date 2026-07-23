/**
 * Route-level loading UI for the Retailer staff page.
 *
 * Renders inside the already-mounted shell (the layout resolves first), so the
 * sidebar and header stay put and only the main region swaps.
 *
 * The skeleton mirrors the real page's geometry — title block, then the roster table
 * with its five column headers, then stacked cards below `sm` — so the swap to real
 * content does not shift the layout at either breakpoint.
 *
 * NO FAKE DATA. The column headers are static labels identical on the real page, so
 * they are safe to show; every cell is a neutral pulsing block. No plausible name,
 * role, shop, status, or email is rendered — a skeleton that invents a colleague is
 * briefly indistinguishable from a real one.
 *
 * ONLY THE ROSTER IS SKETCHED. The invitations table and the invite form appear only
 * for an owner, and this file cannot know which kind of caller is loading. Drawing
 * them for everyone would flash an invite form at a Manager who will never be shown
 * one, which is worse than a shorter skeleton.
 */

const SKELETON_ROWS = [0, 1, 2, 3];

const thClasses =
  "px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";

export default function RetailerStaffLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl" aria-busy="true">
      <span className="sr-only" role="status">
        Loading your staff…
      </span>

      <div aria-hidden="true">
        {/* Title block */}
        <div>
          <div className="h-7 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
        </div>

        <div className="mt-8 h-4 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />

        {/* Desktop table shell */}
        <div className="mt-3 hidden overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm sm:block dark:border-zinc-800 dark:bg-zinc-950">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-900/50">
                <tr>
                  {["Name", "Role", "Shops", "Status", "Joined"].map((heading) => (
                    <th key={heading} scope="col" className={thClasses}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {SKELETON_ROWS.map((row) => (
                  <tr key={row}>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-36 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-28 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-5 w-16 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Mobile card shells */}
        <ul className="mt-3 flex flex-col gap-3 sm:hidden">
          {SKELETON_ROWS.map((row) => (
            <li
              key={row}
              className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="h-4 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                <div className="h-5 w-16 shrink-0 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {[0, 1, 2].map((line) => (
                  <div key={line} className="flex justify-between gap-3">
                    <div className="h-4 w-14 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
                    <div className="h-4 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
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
