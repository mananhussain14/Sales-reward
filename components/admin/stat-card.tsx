import type { DashboardStat } from "@/lib/placeholder-stats";

/**
 * Presentational metric card. Renders a visible "Placeholder" badge so the
 * sample figures are never mistaken for real data.
 */
export function StatCard({ stat }: { stat: DashboardStat }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {stat.label}
        </p>
        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-950/60 dark:text-amber-400">
          Placeholder
        </span>
      </div>
      <p className="mt-3 text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
        {stat.value}
      </p>
      <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{stat.hint}</p>
    </div>
  );
}
