import { cardClasses } from "@/components/ui/card";
import {
  Skeleton,
  SkeletonFormActions,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/**
 * Invite Retailer Owner loading state: back link, icon header, then the
 * two-column form + "Retailer Owner access" support card layout.
 */
export default function InviteOwnerLoading() {
  return (
    <SkeletonScreen label="Loading invitation form…" className="max-w-4xl">
      <div className="space-y-6">
        <Skeleton className="h-4 w-32" />
        <div className="flex items-start gap-4">
          <Skeleton className="h-12 w-12 rounded-2xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-52" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <div className={cardClasses("standard", "space-y-5 p-6")}>
              <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-40" />
                </div>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Skeleton className="h-11 w-full rounded-xl" />
                <Skeleton className="h-11 w-full rounded-xl" />
              </div>
              <Skeleton className="h-11 w-full rounded-xl" />
              <SkeletonFormActions />
            </div>
          </div>
          <div className={cardClasses("standard", "space-y-4 p-6")}>
            <Skeleton className="h-4 w-40" />
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        </div>
      </div>
    </SkeletonScreen>
  );
}
