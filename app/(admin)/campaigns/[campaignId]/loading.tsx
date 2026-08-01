import {
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonScreen,
  SkeletonStatGrid,
} from "@/components/ui/skeleton";

/** Campaign detail loading state: header, the summary tiles, then the panels. */
export default function CampaignDetailLoading() {
  return (
    <SkeletonScreen label="Loading campaign…" className="max-w-5xl">
      <div className="space-y-6">
        <SkeletonPageHeader withAction />
        <SkeletonStatGrid count={4} />
        <SkeletonCard className="h-56" />
        <SkeletonCard className="h-56" />
      </div>
    </SkeletonScreen>
  );
}
