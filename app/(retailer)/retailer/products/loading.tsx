import {
  SkeletonPageHeader,
  SkeletonScreen,
  SkeletonTable,
} from "@/components/ui/skeleton";

/** Retailer assigned-products loading state: header, then the products table. */
export default function RetailerProductsLoading() {
  return (
    <SkeletonScreen label="Loading products…" className="max-w-6xl">
      <div className="space-y-6">
        <SkeletonPageHeader />
        <SkeletonTable columns={4} rows={6} />
      </div>
    </SkeletonScreen>
  );
}
