import {
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonScreen,
  SkeletonStatGrid,
} from "@/components/ui/skeleton";

/**
 * Dashboard loading state (also the default fallback for any admin route without
 * a closer boundary). Mirrors the real dashboard geometry — page header, the
 * four metric cards, then the three quick-action cards — so the swap to real
 * content does not shift the layout. No figures or labels are invented.
 */
export default function DashboardLoading() {
  return (
    <SkeletonScreen label="Loading dashboard…" className="max-w-6xl">
      <div className="space-y-8">
        <SkeletonPageHeader />
        <SkeletonStatGrid count={4} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      </div>
    </SkeletonScreen>
  );
}
