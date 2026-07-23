import {
  SkeletonPageHeader,
  SkeletonScreen,
  SkeletonTable,
} from "@/components/ui/skeleton";

/** Audit logs loading state: header, then the events table. */
export default function AuditLogsLoading() {
  return (
    <SkeletonScreen label="Loading audit logs…" className="max-w-6xl">
      <div className="space-y-6">
        <SkeletonPageHeader />
        <SkeletonTable columns={4} rows={8} />
      </div>
    </SkeletonScreen>
  );
}
