import type { ReactNode } from "react";
import { cardClasses } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";

export type StatTone = "indigo" | "emerald" | "amber" | "slate";

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
  /** Optional accent tone for the icon disc. Purely decorative. */
  tone?: StatTone;
  /** Optional icon rendered in a tinted disc. Decorative. */
  icon?: ReactNode;
};

const DISC_TONES: Record<StatTone, string> = {
  indigo: "bg-indigo-50 text-indigo-600",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  slate: "bg-slate-100 text-slate-600",
};

/** Presentational metric card. Renders live server-fetched figures. */
export function StatCard({ stat }: { stat: DashboardStat }) {
  // Destructured so the null check below narrows the value for the render.
  const { label, value, hint, tone = "indigo", icon } = stat;

  return (
    <div className={cardClasses("interactive", "p-5")}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        {icon && (
          <span
            aria-hidden="true"
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-xl",
              DISC_TONES[tone],
            )}
          >
            {icon}
          </span>
        )}
      </div>
      {value === null ? (
        // Deliberately not "0" and not "—": the figure is unknown, not empty.
        // The reason is never shown, since it can only come from a database
        // error whose detail must not reach a browser.
        <p className="mt-3 text-lg font-medium text-slate-400">Unavailable</p>
      ) : (
        <p className="mt-3 text-3xl font-semibold tabular-nums text-slate-900">
          {/* Fixed locale: the value is formatted on the server, so a
              server-dependent locale would make output vary by host. */}
          {value.toLocaleString("en-US")}
        </p>
      )}
      <p className="mt-1 text-xs text-slate-400">{hint}</p>
    </div>
  );
}
