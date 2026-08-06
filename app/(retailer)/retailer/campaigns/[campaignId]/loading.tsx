import {
  SkeletonCard,
  SkeletonPageHeader,
  SkeletonScreen,
  SkeletonStatGrid,
} from "@/components/ui/skeleton";

/**
 * Retailer campaign detail loading state.
 *
 * Mirrors the real page — header, the offer panel, four fact tiles, then the product
 * table — so the layout does not visibly jump once the two reads resolve.
 */
export default function RetailerCampaignDetailLoading() {
  return (
    <SkeletonScreen label="Loading campaign…" className="max-w-4xl">
      <div className="space-y-4">
        <SkeletonPageHeader />
        <SkeletonCard className="h-24" />
        <SkeletonStatGrid count={4} />
        <SkeletonCard className="h-56" />
      </div>
    </SkeletonScreen>
  );
}
