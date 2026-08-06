import {
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/** Campaign dashboard loading state: header + actions, the filter row, then cards. */
export default function CampaignsLoading() {
  return (
    <SkeletonScreen label="Loading campaigns…" className="max-w-6xl">
      <div className="space-y-6">
        <SkeletonPageHeader withAction />
        <SkeletonCard className="h-10" />
        <div className="space-y-3">
          <SkeletonCard className="h-40" />
          <SkeletonCard className="h-40" />
          <SkeletonCard className="h-40" />
        </div>
      </div>
    </SkeletonScreen>
  );
}
