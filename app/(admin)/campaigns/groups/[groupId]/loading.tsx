import {
  SkeletonCard,
  SkeletonFormSection,
  SkeletonPageHeader,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/** Group detail loading state: header, the rename form, then the membership editor. */
export default function RetailerGroupDetailLoading() {
  return (
    <SkeletonScreen label="Loading group…" className="max-w-4xl">
      <div className="space-y-6">
        <SkeletonPageHeader />
        <SkeletonFormSection fields={2} />
        <SkeletonCard className="h-72" />
      </div>
    </SkeletonScreen>
  );
}
