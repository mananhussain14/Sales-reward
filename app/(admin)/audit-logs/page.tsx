import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  getVendorAuditLogs,
  type VendorAuditLog,
} from "@/lib/audit/vendor-audit-logs";

export const metadata: Metadata = {
  title: "Audit Logs · SalesReward Admin",
};

/** Neutral panel used for both the empty and the unavailable states. */
function NoticePanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{title}</p>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{body}</p>
    </div>
  );
}

/** Wide-screen presentation. Hidden below `md`, where the cards take over. */
function AuditTable({ auditLogs }: { auditLogs: VendorAuditLog[] }) {
  return (
    <div className="hidden overflow-hidden rounded-xl border border-zinc-200 md:block dark:border-zinc-800">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Time (UTC)
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Actor
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Action
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Resource
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
          {auditLogs.map((auditLog, index) => (
            // The history carries no ids by design, so there is no natural key:
            // two records may legitimately share every rendered field. The index
            // is stable here because this list is server-rendered in a fixed sort
            // order and never reordered, filtered, or mutated on the client.
            <tr key={index}>
              <td className="whitespace-nowrap px-4 py-3 text-zinc-600 tabular-nums dark:text-zinc-300">
                {auditLog.occurredAt}
              </td>
              <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                {auditLog.actorDisplayName}
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                {auditLog.action}
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
                {auditLog.entityType}
              </td>
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
          className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <p className="font-medium text-zinc-900 dark:text-zinc-50">
            {auditLog.action}
          </p>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            {auditLog.entityType}
          </p>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
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
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Audit Logs
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Recorded administrative activity for{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {organizationName}
          </span>
          . Showing the latest 100 records, newest first, with times in UTC.
        </p>
      </div>

      {auditLogs === null ? (
        // Deliberately generic and reason-free: the only cause is a database
        // failure, whose detail must never reach a browser. Distinct from the
        // empty state below — unknown is not the same as none, and on an audit
        // page that distinction matters more than anywhere else.
        <NoticePanel
          title="Audit logs unavailable"
          body="The audit history could not be loaded. Please try again shortly."
        />
      ) : auditLogs.length === 0 ? (
        <NoticePanel
          title="No activity recorded yet"
          body="No administrative actions have been recorded for this organization."
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
