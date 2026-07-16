import type { Metadata } from "next";
import { StatCard } from "@/components/admin/stat-card";
import { PLACEHOLDER_STATS } from "@/lib/placeholder-stats";

export const metadata: Metadata = {
  title: "Dashboard · SalesReward Admin",
};

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Dashboard
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Overview of retailer activity, campaigns, claims, and payouts.
        </p>
      </div>

      {/* Placeholder-data notice */}
      <div
        role="note"
        className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mt-0.5 h-4 w-4 shrink-0"
          aria-hidden="true"
        >
          <path d="M12 9v3.75m0 3.75h.008M10.34 3.94l-8.02 13.5A1.5 1.5 0 003.6 19.5h16.8a1.5 1.5 0 001.28-2.06l-8.02-13.5a1.5 1.5 0 00-2.58 0z" />
        </svg>
        <p>
          <span className="font-semibold">Placeholder data.</span> All figures
          below are sample values for layout purposes only and are not connected
          to any live data source yet.
        </p>
      </div>

      <section aria-label="Key metrics">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {PLACEHOLDER_STATS.map((stat) => (
            <StatCard key={stat.key} stat={stat} />
          ))}
        </div>
      </section>
    </div>
  );
}
