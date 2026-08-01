import {
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonScreen,
  SkeletonStatGrid,
} from "@/components/ui/skeleton";

/**
 * Campaign detail loading state: header, the six summary tiles, then the collapsed
 * detail panels — the same shape the loaded page settles into.
 */
export default function CampaignDetailLoading() {
  return (
    <SkeletonScreen label="Loading campaign…" className="max-w-5xl">
      <div className="space-y-6">
        <SkeletonPageHeader withAction />
        <SkeletonStatGrid count={6} />
        <div className="space-y-3">
          <SkeletonCard className="h-16" />
          <SkeletonCard className="h-16" />
          <SkeletonCard className="h-16" />
          <SkeletonCard className="h-16" />
        </div>
      </div>
    </SkeletonScreen>
  );
}
