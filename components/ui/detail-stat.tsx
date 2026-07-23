import { cn } from "@/components/ui/cn";
import { cardClasses } from "@/components/ui/card";

/**
 * A single labelled fact with an icon — the building block of an organization
 * summary. The value is a node, so a status pill, a code, or plain text all fit
 * the same card. Purely presentational: it renders whatever the server already
 * resolved and computes nothing.
 */
export type DetailStatTone = "indigo" | "emerald" | "amber" | "slate";

const DISC_TONES: Record<DetailStatTone, string> = {
  indigo: "bg-indigo-50 text-indigo-600",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  slate: "bg-slate-100 text-slate-600",
};

export function DetailStat({
  icon,
  label,
  value,
  tone = "slate",
  className,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tone?: DetailStatTone;
  className?: string;
}) {
  return (
    <div className={cardClasses("standard", cn("flex items-start gap-3 p-4", className))}>
      {icon && (
        <span
          aria-hidden="true"
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            DISC_TONES[tone],
          )}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <div className="mt-1 text-sm font-semibold text-slate-900">{value}</div>
      </div>
    </div>
  );
}
