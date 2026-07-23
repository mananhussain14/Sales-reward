import {
  SkeletonPageHeader,
  SkeletonScreen,
  SkeletonTable,
} from "@/components/ui/skeleton";

/** Retailers directory loading state: header + Add action, then the table. */
export default function RetailersLoading() {
  return (
    <SkeletonScreen label="Loading Retailers…" className="max-w-6xl">
      <div className="space-y-6">
        <SkeletonPageHeader withAction />
        <SkeletonTable columns={5} rows={6} />
      </div>
    </SkeletonScreen>
  );
}
