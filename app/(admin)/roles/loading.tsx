import { cardClasses } from "@/components/ui/card";
import {
  Skeleton,
  SkeletonPageHeader,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/** Roles & permissions loading state: header, then role cards and a permissions list. */
export default function RolesLoading() {
  return (
    <SkeletonScreen label="Loading roles…" className="max-w-6xl">
      <div className="space-y-6">
        <SkeletonPageHeader />
        <div className="space-y-3">
          <Skeleton className="h-4 w-16" />
          {[0, 1, 2].map((i) => (
            <div key={i} className={cardClasses("standard", "space-y-4 p-4 sm:p-5")}>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-3 w-72 max-w-full" />
              <div className="space-y-2 border-t border-slate-100 pt-4">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </SkeletonScreen>
  );
}
