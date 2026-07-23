import {
  SkeletonPageHeader,
  SkeletonScreen,
  SkeletonTable,
} from "@/components/ui/skeleton";

/** Users directory loading state: header, then the members table. */
export default function UsersLoading() {
  return (
    <SkeletonScreen label="Loading users…" className="max-w-6xl">
      <div className="space-y-6">
        <SkeletonPageHeader />
        <SkeletonTable columns={4} rows={6} />
      </div>
    </SkeletonScreen>
  );
}
