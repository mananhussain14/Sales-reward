import { Skeleton } from "@/components/ui/skeleton";
import { cardClasses } from "@/components/ui/card";

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
          <Skeleton className="h-7 w-32" />
          <Skeleton className="mt-2 h-4 w-72 max-w-full" />
        </div>

        {/* Desktop table shell */}
        <div className={cardClasses("standard", "mt-8 hidden overflow-hidden sm:block")}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  {["Shop", "Code", "City", "Country", "Status"].map((heading) => (
                    <th key={heading} scope="col" className="px-4 py-3 font-semibold">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {SKELETON_ROWS.map((row) => (
                  <tr key={row}>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-40" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-16" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-24" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-10" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-5 w-16 rounded-full" />
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
            <li key={row} className={cardClasses("standard", "p-4")}>
              <div className="flex items-start justify-between gap-3">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {[0, 1, 2].map((line) => (
                  <div key={line} className="flex justify-between gap-3">
                    <Skeleton className="h-4 w-14" />
                    <Skeleton className="h-4 w-20" />
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
