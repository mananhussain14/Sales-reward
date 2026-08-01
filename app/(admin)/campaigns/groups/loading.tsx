import {
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/** Retailer groups loading state: header + create action, then the group cards. */
export default function RetailerGroupsLoading() {
  return (
    <SkeletonScreen label="Loading Retailer groups…" className="max-w-4xl">
      <div className="space-y-6">
        <SkeletonPageHeader withAction />
        <SkeletonCard className="h-44" />
        <SkeletonCard className="h-28" />
        <SkeletonCard className="h-28" />
      </div>
    </SkeletonScreen>
  );
}
