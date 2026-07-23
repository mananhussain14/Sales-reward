import {
  Skeleton,
  SkeletonFormSection,
  SkeletonScreen,
  SkeletonTable,
} from "@/components/ui/skeleton";

/** Product detail loading state: back link, header, details card, assignments table. */
export default function ProductDetailLoading() {
  return (
    <SkeletonScreen label="Loading product…" className="max-w-3xl">
      <div className="space-y-6">
        <Skeleton className="h-4 w-32" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <SkeletonFormSection fields={3} />
        <div className="space-y-3">
          <Skeleton className="h-5 w-40" />
          <SkeletonTable columns={3} rows={3} />
        </div>
      </div>
    </SkeletonScreen>
  );
}
