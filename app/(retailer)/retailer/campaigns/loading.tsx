import {
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/** Retailer campaigns loading state: header, then the grouped campaign cards. */
export default function RetailerCampaignsLoading() {
  return (
    <SkeletonScreen label="Loading campaigns…" className="max-w-5xl">
      <div className="space-y-6">
        <SkeletonPageHeader />
        <SkeletonCard className="h-44" />
        <SkeletonCard className="h-44" />
      </div>
    </SkeletonScreen>
  );
}
