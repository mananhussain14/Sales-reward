import {
  Skeleton,
  SkeletonFormActions,
  SkeletonFormSection,
  SkeletonScreen,
} from "@/components/ui/skeleton";

/** Add Shop loading state: back link, icon header, the details card, actions. */
export default function AddShopLoading() {
  return (
    <SkeletonScreen label="Loading form…" className="max-w-3xl">
      <div className="space-y-6">
        <Skeleton className="h-4 w-32" />
        <div className="flex items-start gap-4">
          <Skeleton className="h-12 w-12 rounded-2xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
        </div>
        <SkeletonFormSection fields={4} />
        <SkeletonFormActions />
      </div>
    </SkeletonScreen>
  );
}
