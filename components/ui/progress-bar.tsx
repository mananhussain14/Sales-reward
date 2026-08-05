import { cn } from "@/components/ui/cn";

/**
 * A labelled progress bar.
 *
 * PURELY PRESENTATIONAL — it renders the percentage it is handed and computes nothing.
 * The caller supplies both the percentage and the accessible label, because the label
 * has to name the SUBJECT ("Team progress: 9 of 8 units"), and only the caller knows
 * whose progress this is.
 *
 * ============================================================================
 * MEANING IS NEVER CARRIED BY COLOUR ALONE
 * ============================================================================
 * The tone tints the fill, but every screen using this also renders the numbers and a
 * text status beside it. A user who cannot distinguish emerald from slate loses nothing.
 *
 * The bar is a `role="progressbar"` with valuemin / valuemax / valuenow set from the
 * REAL units rather than the clamped percentage, so assistive technology reports "9 of
 * 8" — the true figure — even though the fill stops at 100%.
 */
export type ProgressTone = "emerald" | "amber" | "slate";

const FILL_TONES: Record<ProgressTone, string> = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  slate: "bg-slate-400",
};

export function ProgressBar({
  percent,
  label,
  valueNow,
  valueMax,
  tone = "slate",
  className,
}: {
  /** 0..100, already clamped by the caller. */
  percent: number;
  /** The accessible name. Must say whose progress this is. */
  label: string;
  /** The true current value, which MAY exceed valueMax. */
  valueNow: number;
  valueMax: number;
  tone?: ProgressTone;
  className?: string;
}) {
  const width = Math.min(100, Math.max(0, percent));

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={valueMax}
      aria-valuenow={valueNow}
      className={cn(
        "h-2.5 w-full overflow-hidden rounded-full bg-slate-200",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className={cn("h-full rounded-full transition-[width]", FILL_TONES[tone])}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}
