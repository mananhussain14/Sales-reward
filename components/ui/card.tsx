import { cn } from "@/components/ui/cn";

/**
 * Surface primitives.
 *
 * `cardClasses` is the single definition of a "card": a white 16px-radius
 * surface with a slate hairline border and the soft `shadow-card`. Variants add
 * intent without changing the shape — `interactive` lifts on hover for clickable
 * cards, `highlighted` tints the border indigo for a featured surface.
 */
type CardVariant = "standard" | "interactive" | "highlighted" | "muted";

const CARD_BASE = "rounded-2xl border bg-white shadow-card";

const CARD_VARIANTS: Record<CardVariant, string> = {
  standard: "border-slate-200",
  interactive:
    "border-slate-200 transition-all duration-150 hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-elevated",
  highlighted: "border-indigo-200 ring-1 ring-indigo-100",
  muted: "border-slate-200 bg-slate-50 shadow-none",
};

export function cardClasses(
  variant: CardVariant = "standard",
  extra?: string,
): string {
  return cn(CARD_BASE, CARD_VARIANTS[variant], extra);
}

export function Card({
  variant = "standard",
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: CardVariant }) {
  return (
    <div {...props} className={cardClasses(variant, className)}>
      {children}
    </div>
  );
}

/**
 * A section card with a title, optional description, and body — the grouped
 * panel used throughout forms and detail pages.
 */
export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cardClasses("standard", cn("p-5 sm:p-6", className))}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          {description && (
            <p className="mt-1 text-sm text-slate-500">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      <div className={cn("mt-5", bodyClassName)}>{children}</div>
    </section>
  );
}
