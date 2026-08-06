import { cn } from "@/components/ui/cn";
import { InfoIcon } from "@/components/ui/icons";
import { CALCULATION_ENGINE_NOTICE } from "@/lib/campaigns/campaign-vocabulary";

/**
 * The compact fact tile used across the campaign detail and Retailer-facing pages.
 *
 * Deliberately SMALLER than the generic DetailStat: a campaign shows six of these at once,
 * and at DetailStat's size six tiles fill a laptop screen on their own — which is what made
 * the previous detail page read as a wall of oversized cards with nothing prioritized.
 *
 * A Server Component. It renders values the server already resolved and computes nothing.
 */
export function FactTile({
  icon,
  label,
  value,
  detail,
  tone = "slate",
  className,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: "slate" | "indigo" | "emerald" | "amber";
  className?: string;
}) {
  const disc = {
    slate: "bg-slate-100 text-slate-600",
    indigo: "bg-indigo-50 text-indigo-600",
    emerald: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-700",
  }[tone];

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3.5",
        className,
      )}
    >
      {icon && (
        <span
          aria-hidden="true"
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            disc,
          )}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-500">{label}</p>
        <div className="mt-0.5 text-sm font-semibold leading-snug text-slate-900">
          {value}
        </div>
        {detail && (
          <div className="mt-0.5 text-xs leading-relaxed text-slate-500">{detail}</div>
        )}
      </div>
    </div>
  );
}

/**
 * The standing notice that no result is computed in this milestone.
 *
 * One component wrapping one constant, so the sentence is identical on the wizard, the
 * campaign detail page and the Retailer portal. Deliberately quiet: it is a standing fact
 * about the product, not a warning about the campaign being read.
 */
export function CalculationEngineNotice({ className }: { className?: string }) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs leading-relaxed text-slate-600",
        className,
      )}
    >
      <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
      <span>{CALCULATION_ENGINE_NOTICE}</span>
    </p>
  );
}

/**
 * A collapsible detail panel for the campaign page.
 *
 * `<details>` rather than a client-side accordion: the browser supplies the disclosure
 * semantics, keyboard operation and find-in-page expansion for free, and the campaign
 * detail page stays a Server Component with no JavaScript needed to read it.
 */
export function DetailPanel({
  title,
  description,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: string;
  /** A small right-aligned count, e.g. how many Retailers a section lists. */
  count?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-2xl border border-slate-200 bg-white shadow-card"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-900">{title}</span>
          {description && (
            <span className="mt-0.5 block text-xs text-slate-500">{description}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {count && (
            <span className="text-xs font-medium text-slate-500">{count}</span>
          )}
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180"
          >
            <path d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </span>
      </summary>
      <div className="border-t border-slate-100 px-5 py-4">{children}</div>
    </details>
  );
}
