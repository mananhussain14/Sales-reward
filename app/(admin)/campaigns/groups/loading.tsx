import {
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/**
 * Retailer groups loading state: header, the single-flow create form (which now holds
 * the Retailer picker as well as the two text fields), then the group grid.
 */
export default function RetailerGroupsLoading() {
  return (
    <SkeletonScreen label="Loading Retailer groups…" className="max-w-5xl">
      <div className="space-y-6">
        <SkeletonPageHeader />
        <SkeletonCard className="h-80" />
        <div className="grid gap-3 sm:grid-cols-2">
          <SkeletonCard className="h-32" />
          <SkeletonCard className="h-32" />
          <SkeletonCard className="h-32" />
          <SkeletonCard className="h-32" />
        </div>
      </div>
    </SkeletonScreen>
  );
}
