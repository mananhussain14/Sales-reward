import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StatCard, type DashboardStat } from "@/components/admin/stat-card";
import { getVendorAdminDashboardSummary } from "@/lib/dashboard/vendor-admin-summary";

export const metadata: Metadata = {
  title: "Dashboard · SalesReward Admin",
};

/**
 * Vendor Admin dashboard. A Server Component: every figure below is fetched and
 * rendered on the server, so no Supabase query, organization id, or session
 * token is exposed to the browser.
 *
 * The authorization check here is deliberate duplication of the (admin) layout's
 * check, not an oversight — see the note on the redirects below.
 */
export default async function DashboardPage() {
  const summary = await getVendorAdminDashboardSummary();

  // This page does not assume the layout already guarded it. A layout protects
  // what renders *inside* it, but that is a property of the current route tree,
  // not of this module: the same rule must hold if this page is ever moved,
  // re-exported, or reached through a route that composes a different layout.
  // The check is one function call against the single source of truth, and the
  // two can never disagree because neither re-implements the decision.
  if (summary.status === "unauthenticated") {
    redirect("/login");
  }

  if (summary.status === "unauthorized") {
    redirect("/access-denied");
  }

  // Every value below is a real count or `null` (unreadable) — never a sample.
  const stats: DashboardStat[] = [
    {
      key: "active-members",
      label: "Active Members",
      value: summary.activeMemberCount,
      hint: "Active memberships in this organization",
    },
    {
      key: "active-roles",
      label: "Active Roles",
      value: summary.activeRoleCount,
      hint: "Roles available in the role catalogue",
    },
    {
      key: "permissions",
      label: "Permissions",
      value: summary.permissionCount,
      hint: "Permissions defined across all modules",
    },
    {
      key: "audit-events",
      label: "Audit Events",
      value: summary.auditEventCount,
      hint: "Recorded admin actions for this organization",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Dashboard
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Managing{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {summary.organizationName}
          </span>
          . Overview of your organization&apos;s members, access control, and
          recorded activity.
        </p>
      </div>

      <section aria-label="Key metrics">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((stat) => (
            <StatCard key={stat.key} stat={stat} />
          ))}
        </div>
      </section>
    </div>
  );
}
