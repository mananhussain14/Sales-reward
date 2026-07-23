import { Skeleton } from "@/components/ui/skeleton";
import { cardClasses } from "@/components/ui/card";

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

const thClasses = "px-4 py-3 font-semibold";

export default function RetailerStaffLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl" aria-busy="true">
      <span className="sr-only" role="status">
        Loading your staff…
      </span>

      <div aria-hidden="true">
        {/* Title block */}
        <div>
          <Skeleton className="h-7 w-24" />
          <Skeleton className="mt-2 h-4 w-80 max-w-full" />
        </div>

        <Skeleton className="mt-8 h-4 w-28" />

        {/* Desktop table shell */}
        <div className={cardClasses("standard", "mt-3 hidden overflow-hidden sm:block")}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  {["Name", "Role", "Shops", "Status", "Joined"].map((heading) => (
                    <th key={heading} scope="col" className={thClasses}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {SKELETON_ROWS.map((row) => (
                  <tr key={row}>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-36" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-28" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-32" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </td>
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-24" />
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
            <li key={row} className={cardClasses("standard", "p-4")}>
              <div className="flex items-start justify-between gap-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-5 w-16 shrink-0 rounded-full" />
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {[0, 1, 2].map((line) => (
                  <div key={line} className="flex justify-between gap-3">
                    <Skeleton className="h-4 w-14" />
                    <Skeleton className="h-4 w-24" />
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
