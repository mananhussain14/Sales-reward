import {
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/** Retailer campaign list loading state: header, then the grouped campaign cards. */
export default function RetailerCampaignsLoading() {
  return (
    <SkeletonScreen label="Loading campaigns…" className="max-w-4xl">
      <div className="space-y-6">
        <SkeletonPageHeader />
        <SkeletonCard className="h-64" />
        <SkeletonCard className="h-64" />
      </div>
    </SkeletonScreen>
  );
}
