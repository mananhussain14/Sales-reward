import { cn } from "@/components/ui/cn";

/**
 * Empty / notice state.
 *
 * One presentation for "there is nothing here yet", "this could not be loaded",
 * and "you have no items". An icon sits in a soft tinted disc, above a short
 * title and a supporting line, with an optional action. `tone` only changes the
 * disc color — never the wording, which each caller supplies and which stays
 * deliberately reason-free for the unavailable case.
 */
type EmptyTone = "slate" | "indigo" | "emerald" | "amber";

const DISC_TONES: Record<EmptyTone, string> = {
  slate: "bg-slate-100 text-slate-500",
  indigo: "bg-indigo-50 text-indigo-600",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
};

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "slate",
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  tone?: EmptyTone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center",
        className,
      )}
    >
      {icon && (
        <span
          aria-hidden="true"
          className={cn(
            "mb-4 flex h-14 w-14 items-center justify-center rounded-2xl",
            DISC_TONES[tone],
          )}
        >
          {icon}
        </span>
      )}
      <p className="text-base font-semibold text-slate-900">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-slate-500">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
