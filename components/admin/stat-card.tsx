export type DashboardStat = {
  key: string;
  label: string;
  /**
   * The real count, or `null` when it could not be read. `null` is NOT zero:
   * 0 is a valid figure and renders as "0", while null renders "Unavailable".
   */
  value: number | null;
  /** Short supporting context shown under the value. */
  hint: string;
};

/** Presentational metric card. Renders live server-fetched figures. */
export function StatCard({ stat }: { stat: DashboardStat }) {
  // Destructured so the null check below narrows the value for the render.
  const { label, value, hint } = stat;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
          {label}
        </p>
      </div>
      {value === null ? (
        // Deliberately not "0" and not "—": the figure is unknown, not empty.
        // The reason is never shown, since it can only come from a database
        // error whose detail must not reach a browser.
        <p className="mt-3 text-lg font-medium text-zinc-400 dark:text-zinc-500">
          Unavailable
        </p>
      ) : (
        <p className="mt-3 text-3xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
          {/* Fixed locale: the value is formatted on the server, so a
              server-dependent locale would make output vary by host. */}
          {value.toLocaleString("en-US")}
        </p>
      )}
      <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{hint}</p>
    </div>
  );
}
