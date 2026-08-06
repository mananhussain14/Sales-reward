import {
  SkeletonCard,
  SkeletonFormActions,
  SkeletonFormSection,
  SkeletonPageHeader,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/**
 * Wizard loading state.
 *
 * Mirrors the real three-column layout — step rail, step, live summary — so the page does
 * not visibly re-flow the moment it hydrates. Below `lg` the rail collapses to the compact
 * "Step X of 6" header, and the skeleton collapses with it.
 */
export default function NewCampaignLoading() {
  return (
    <SkeletonScreen label="Loading the campaign wizard…" className="max-w-6xl">
      <div className="space-y-6">
        <SkeletonPageHeader />
        <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[13rem_minmax(0,1fr)_17rem]">
          <SkeletonCard className="h-16 lg:h-72" />
          <div className="min-w-0 space-y-4">
            <SkeletonFormSection fields={3} />
            <SkeletonFormActions />
          </div>
          <SkeletonCard className="h-14 xl:h-72" />
        </div>
      </div>
    </SkeletonScreen>
  );
}
