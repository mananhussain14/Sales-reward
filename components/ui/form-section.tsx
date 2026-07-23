import { cardClasses } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { InfoIcon } from "@/components/ui/icons";

/**
 * A numbered form step — a card whose header carries a step index, an icon, a
 * stronger title, and a short explanation, giving a long single-submit form a
 * clear guided structure. This is a VISUAL section indicator only: it does not
 * change the form's submission, which stays a single action.
 */
export function FormStep({
  step,
  icon,
  title,
  description,
  children,
  className,
}: {
  step: number;
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cardClasses("standard", cn("p-5 sm:p-6", className))}>
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600"
        >
          {icon}
          <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[0.7rem] font-bold text-white ring-2 ring-white">
            {step}
          </span>
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
            Step {step}
          </p>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          {description && (
            <p className="mt-1 text-sm text-slate-500">{description}</p>
          )}
        </div>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/**
 * A subtle information panel — a soft tinted strip with an icon, used to explain
 * a workflow ("both will be created together") or summarize selections. Content
 * only; it computes nothing.
 */
export type InfoPanelTone = "indigo" | "slate" | "emerald" | "amber";

const INFO_TONES: Record<InfoPanelTone, { box: string; icon: string }> = {
  indigo: { box: "border-indigo-100 bg-indigo-50/70 text-indigo-900", icon: "text-indigo-600" },
  slate: { box: "border-slate-200 bg-slate-50 text-slate-700", icon: "text-slate-500" },
  emerald: { box: "border-emerald-100 bg-emerald-50/70 text-emerald-900", icon: "text-emerald-600" },
  amber: { box: "border-amber-100 bg-amber-50/70 text-amber-900", icon: "text-amber-600" },
};

export function InfoPanel({
  tone = "indigo",
  icon,
  children,
  className,
}: {
  tone?: InfoPanelTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const styles = INFO_TONES[tone];
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        styles.box,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("mt-0.5 shrink-0", styles.icon)}>
        {icon ?? <InfoIcon className="h-4 w-4" />}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
