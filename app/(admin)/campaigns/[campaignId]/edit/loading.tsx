import {
  SkeletonCard,
  SkeletonFormActions,
  SkeletonFormSection,
  SkeletonPageHeader,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/** Draft editor loading state: header, the step rail, then the first step's fields. */
export default function EditCampaignDraftLoading() {
  return (
    <SkeletonScreen label="Loading the draft…" className="max-w-4xl">
      <div className="space-y-6">
        <SkeletonPageHeader />
        <SkeletonCard className="h-14" />
        <SkeletonFormSection fields={3} />
        <SkeletonFormActions />
      </div>
    </SkeletonScreen>
  );
}
