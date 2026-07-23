import { cardClasses } from "@/components/ui/card";
import {
  Skeleton,
  SkeletonScreen,
  SkeletonTable,
} from "@/components/ui/skeleton";

/**
 * Retailer detail loading state: back link, the organization header, the four
 * summary metric cards, the owner-status card, and the shops table — the same
 * top-to-bottom order the real page uses.
 */
export default function RetailerDetailLoading() {
  return (
    <SkeletonScreen label="Loading Retailer…" className="max-w-6xl">
      <div className="space-y-6">
        <Skeleton className="h-4 w-32" />

        <div className="flex items-start gap-4">
          <Skeleton className="h-12 w-12 rounded-2xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cardClasses("standard", "p-4")}>
              <div className="flex items-start gap-3">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-16" />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <Skeleton className="h-5 w-40" />
          <div className={cardClasses("standard", "space-y-4 p-6")}>
            <div className="flex items-start gap-4">
              <Skeleton className="h-11 w-11 rounded-2xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-72 max-w-full" />
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <Skeleton className="h-5 w-24" />
          <SkeletonTable columns={5} rows={4} />
        </div>
      </div>
    </SkeletonScreen>
  );
}
