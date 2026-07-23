import {
  SkeletonPageHeader,
  SkeletonScreen,
  SkeletonTable,
} from "@/components/ui/skeleton";

/** Product catalog loading state: header + create action, then the table. */
export default function ProductsLoading() {
  return (
    <SkeletonScreen label="Loading products…" className="max-w-6xl">
      <div className="space-y-6">
        <SkeletonPageHeader withAction />
        <SkeletonTable columns={5} rows={6} />
      </div>
    </SkeletonScreen>
  );
}
