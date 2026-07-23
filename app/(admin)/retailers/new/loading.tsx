import {
  Skeleton,
  SkeletonFormActions,
  SkeletonFormSection,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/** Add Retailer loading state: back link, header, the two step cards, actions. */
export default function NewRetailerLoading() {
  return (
    <SkeletonScreen label="Loading form…" className="max-w-3xl">
      <div className="space-y-6">
        <Skeleton className="h-4 w-32" />
        <div className="flex items-start gap-4">
          <Skeleton className="h-12 w-12 rounded-2xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
        </div>
        <SkeletonFormSection fields={3} />
        <SkeletonFormSection fields={3} />
        <SkeletonFormActions />
      </div>
    </SkeletonScreen>
  );
}
