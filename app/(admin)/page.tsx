import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { StatCard, type DashboardStat } from "@/components/admin/stat-card";
import { getVendorAdminDashboardSummary } from "@/lib/dashboard/vendor-admin-summary";
import { PageHeader } from "@/components/ui/page-header";
import {
  ArrowUpRightIcon,
  AuditIcon,
  KeyIcon,
  ProductsIcon,
  RetailersIcon,
  UsersIcon,
} from "@/components/ui/icons";

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
      tone: "indigo",
      icon: <UsersIcon className="h-5 w-5" />,
    },
    {
      key: "active-roles",
      label: "Active Roles",
      value: summary.activeRoleCount,
      hint: "Roles available in the role catalogue",
      tone: "emerald",
      icon: <KeyIcon className="h-5 w-5" />,
    },
    {
      key: "permissions",
      label: "Permissions",
      value: summary.permissionCount,
      hint: "Permissions defined across all modules",
      tone: "amber",
      icon: <ProductsIcon className="h-5 w-5" />,
    },
    {
      key: "audit-events",
      label: "Audit Events",
      value: summary.auditEventCount,
      hint: "Recorded admin actions for this organization",
      tone: "slate",
      icon: <AuditIcon className="h-5 w-5" />,
    },
  ];

  // Shortcuts to the primary Vendor workflows. Plain links — navigation needs no
  // client state — pointing only at existing, authorized routes.
  const shortcuts = [
    {
      href: "/retailers",
      label: "Manage Retailers",
      description: "View and onboard Retailer organizations",
      icon: <RetailersIcon className="h-5 w-5" />,
    },
    {
      href: "/products",
      label: "Product catalog",
      description: "Manage products and Retailer assignments",
      icon: <ProductsIcon className="h-5 w-5" />,
    },
    {
      href: "/audit-logs",
      label: "Audit logs",
      description: "Review recorded administrative activity",
      icon: <AuditIcon className="h-5 w-5" />,
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Vendor Admin"
        title="Dashboard"
        description={
          <>
            Managing{" "}
            <span className="font-medium text-slate-700">
              {summary.organizationName}
            </span>
            . Overview of your organization&apos;s members, access control, and
            recorded activity.
          </>
        }
      />

      <section aria-label="Key metrics">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {stats.map((stat) => (
            <StatCard key={stat.key} stat={stat} />
          ))}
        </div>
      </section>

      <section aria-label="Quick actions" className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          Quick actions
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {shortcuts.map((shortcut) => (
            <Link
              key={shortcut.href}
              href={shortcut.href}
              className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                  {shortcut.icon}
                </span>
                <ArrowUpRightIcon className="h-4 w-4 text-slate-300 transition-colors group-hover:text-indigo-500" />
              </div>
              <p className="mt-4 text-sm font-semibold text-slate-900">
                {shortcut.label}
              </p>
              <p className="mt-0.5 text-sm text-slate-500">
                {shortcut.description}
              </p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
