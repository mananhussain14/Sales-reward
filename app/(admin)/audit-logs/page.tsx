import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  getVendorAuditLogs,
  type VendorAuditLog,
} from "@/lib/audit/vendor-audit-logs";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { AuditIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Audit Logs · SalesReward Admin",
};

/** Wide-screen presentation. Hidden below `md`, where the cards take over. */
function AuditTable({ auditLogs }: { auditLogs: VendorAuditLog[] }) {
  return (
    <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card md:block">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">
              Time (UTC)
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Actor
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Action
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Resource
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {auditLogs.map((auditLog, index) => (
            // The history carries no ids by design, so there is no natural key:
            // two records may legitimately share every rendered field. The index
            // is stable here because this list is server-rendered in a fixed sort
            // order and never reordered, filtered, or mutated on the client.
            <tr key={index} className="transition-colors hover:bg-slate-50">
              <td className="whitespace-nowrap px-4 py-3 text-slate-600 tabular-nums">
                {auditLog.occurredAt}
              </td>
              <td className="px-4 py-3 font-medium text-slate-900">
                {auditLog.actorDisplayName}
              </td>
              <td className="px-4 py-3 text-slate-600">{auditLog.action}</td>
              <td className="px-4 py-3 text-slate-600">{auditLog.entityType}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Small-screen presentation. A four-column table cannot stay readable at phone
 * widths, so each record becomes a labelled card rather than a horizontally
 * scrolling row.
 */
function AuditCards({ auditLogs }: { auditLogs: VendorAuditLog[] }) {
  return (
    <ul className="space-y-3 md:hidden">
      {auditLogs.map((auditLog, index) => (
        // Index key for the same reason as the table above: no id, fixed order.
        <li
          key={index}
          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card"
        >
          <p className="font-medium text-slate-900">{auditLog.action}</p>
          <p className="mt-1 text-sm text-slate-600">{auditLog.entityType}</p>
          <p className="mt-2 text-sm text-slate-500">
            {auditLog.actorDisplayName}
            <span aria-hidden="true"> · </span>
            <span className="tabular-nums">{auditLog.occurredAt} UTC</span>
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Read-only audit history for the authorized Vendor organization. A Server
 * Component: the queries, the organization id, the actor ids, and the session all
 * stay on the server, and only display strings reach the browser.
 */
export default async function AuditLogsPage() {
  const history = await getVendorAuditLogs();

  // As on the dashboard, the Users directory, and the Roles catalogue, this page
  // does not assume the layout already guarded it — the rule must hold for this
  // module regardless of the route tree it is composed into. All of them call the
  // same function, so they cannot disagree.
  if (history.status === "unauthenticated") {
    redirect("/login");
  }

  if (history.status === "unauthorized") {
    redirect("/access-denied");
  }

  const { organizationName, auditLogs } = history;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Audit Logs"
        description={
          <>
            Recorded administrative activity for{" "}
            <span className="font-medium text-slate-700">{organizationName}</span>
            . Showing the latest 100 records, newest first, with times in UTC.
          </>
        }
      />

      {auditLogs === null ? (
        // Deliberately generic and reason-free: the only cause is a database
        // failure, whose detail must never reach a browser. Distinct from the
        // empty state below — unknown is not the same as none, and on an audit
        // page that distinction matters more than anywhere else.
        <EmptyState
          icon={<AuditIcon className="h-6 w-6" />}
          title="Audit logs unavailable"
          description="The audit history could not be loaded. Please try again shortly."
        />
      ) : auditLogs.length === 0 ? (
        <EmptyState
          icon={<AuditIcon className="h-6 w-6" />}
          tone="indigo"
          title="No activity recorded yet"
          description="No administrative actions have been recorded for this organization."
        />
      ) : (
        <section aria-label="Audit records">
          <AuditTable auditLogs={auditLogs} />
          <AuditCards auditLogs={auditLogs} />
        </section>
      )}
    </div>
  );
}
