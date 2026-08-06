import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * The richer surface vocabulary the Sales Staff experience is built from.
 *
 * The product already has one card (`cardClasses`) and one page header; what it lacked
 * was a way to make a screen feel COMPOSED rather than tiled — a soft ground behind the
 * content, a compact way to state a figure, and a raised surface for the one thing that
 * matters most on a screen.
 *
 * Everything here is decorative. NOT ONE OF THESE COMPONENTS RENDERS A VALUE OF ITS OWN,
 * so none of them can misstate one — they receive already-formatted strings.
 *
 * All are Server Components: the entrance animation is pure CSS, so none of this ships
 * JavaScript.
 */

/** The tones these surfaces may take. Same families as the shared badge and alert. */
export type SurfaceTone = "indigo" | "emerald" | "amber" | "blue" | "slate" | "red";

const FEATURE_TONES: Record<SurfaceTone, string> = {
  indigo: "border-indigo-200 from-indigo-50",
  emerald: "border-emerald-200 from-emerald-50",
  amber: "border-amber-200 from-amber-50",
  blue: "border-blue-200 from-blue-50",
  slate: "border-slate-200 from-slate-100",
  red: "border-red-200 from-red-50",
};

const DISC_TONES: Record<SurfaceTone, string> = {
  indigo: "bg-indigo-50 text-indigo-600",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  blue: "bg-blue-50 text-blue-600",
  slate: "bg-slate-100 text-slate-500",
  red: "bg-red-50 text-red-600",
};

const PILL_TONES: Record<SurfaceTone, string> = {
  indigo: "border-indigo-200 bg-indigo-50",
  emerald: "border-emerald-200 bg-emerald-50",
  amber: "border-amber-200 bg-amber-50",
  blue: "border-blue-200 bg-blue-50",
  slate: "border-slate-200 bg-slate-50",
  red: "border-red-200 bg-red-50",
};

const PILL_LABEL_TONES: Record<SurfaceTone, string> = {
  indigo: "text-indigo-700",
  emerald: "text-emerald-700",
  amber: "text-amber-700",
  blue: "text-blue-700",
  slate: "text-slate-500",
  red: "text-red-700",
};

/**
 * Content arriving: a 220ms fade with an 8px rise, played once.
 *
 * `index` staggers a list. The stagger is deliberately CAPPED — twenty cards at 45ms each
 * would make the last arrive a second after the first, which reads as a slow screen
 * rather than as a considered one.
 *
 * The rise is a `transform`, so it moves nothing else on the page: there is no layout
 * shift to measure. Under a reduced-motion preference both the duration and the delay
 * collapse and the content is simply present.
 */
export function Reveal({
  children,
  index = 0,
  as: Element = "div",
  className,
}: {
  children: ReactNode;
  index?: number;
  /**
   * The element to render.
   *
   * `li` exists because this wrapper is used INSIDE lists, and a `<ul>` whose children
   * are `<div>`s wrapping `<li>`s is invalid markup that breaks list semantics for a
   * screen reader — it would no longer announce "list, 6 items".
   */
  as?: "div" | "li";
  className?: string;
}) {
  const step = 45;
  const capped = Math.min(Math.max(index, 0), 6);

  return (
    <Element
      className={cn("sr-animate-rise", className)}
      style={{ "--sr-delay": `${capped * step}ms` } as CSSProperties}
    >
      {children}
    </Element>
  );
}

/**
 * Two soft brand-tinted shapes behind a screen's content.
 *
 * A full-page gradient tints every card sitting on it and flattens the hierarchy the
 * cards exist to create. Two large, very low-opacity blurred discs bled off the corners
 * give the page depth where there is NO content and leave the surfaces above them
 * unchanged.
 *
 * IT DOES NOT MOVE. A drifting background is movement a reader cannot stop, on a screen
 * they are trying to read numbers off.
 */
export function SoftBackdrop({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute -top-24 right-[6%] h-72 w-72 rounded-full bg-indigo-500/[0.07] blur-3xl" />
        <div className="absolute left-[-10%] top-[14%] h-56 w-56 rounded-full bg-blue-500/[0.05] blur-3xl" />
      </div>
      {children}
    </div>
  );
}

/**
 * The raised surface for the single most important thing on a screen.
 *
 * A larger radius than every other card, a heavier shadow, and a tinted WASH behind its
 * content — a wash rather than a fill, so the tint fades out before the text starts and
 * the content keeps its contrast.
 *
 * It is the visual budget a screen spends ONCE. A page with two of these has neither.
 */
export function FeatureCard({
  children,
  tone = "indigo",
  className,
}: {
  children: ReactNode;
  tone?: SurfaceTone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[28px] border bg-gradient-to-bl to-white to-[62%] shadow-elevated",
        FEATURE_TONES[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A tinted icon container. Sizes follow the product's disc scale (40 / 44 / 48). */
export function IconDisc({
  icon,
  tone = "indigo",
  size = 40,
  className,
}: {
  icon: ReactNode;
  tone?: SurfaceTone;
  size?: 32 | 40 | 44 | 48 | 56;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        size >= 44 ? "rounded-2xl" : "rounded-xl",
        DISC_TONES[tone],
        className,
      )}
      style={{ width: size, height: size }}
    >
      {icon}
    </span>
  );
}

/**
 * A compact label-over-value pill.
 *
 * The unit of the earnings strip and of a campaign card's metadata. It replaces the
 * full-width bordered row, which is what made every screen read as a form.
 *
 * Both `label` and `value` are already-formatted strings — this renders them and computes
 * nothing.
 */
export function StatPill({
  label,
  value,
  icon,
  tone = "slate",
  className,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  tone?: SurfaceTone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border px-3 py-2",
        PILL_TONES[tone],
        className,
      )}
    >
      <p
        className={cn(
          "flex items-center gap-1.5 text-xs",
          PILL_LABEL_TONES[tone],
        )}
      >
        {icon !== undefined && (
          <span aria-hidden="true" className="shrink-0">
            {icon}
          </span>
        )}
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-900">
        {value}
      </p>
    </div>
  );
}

/**
 * A small rounded chip: one glyph and one short label.
 *
 * Used for the additive campaign qualifiers — a cap, exclusivity, how eligibility is
 * resolved. Each is rendered only where the contract says so; there is no "uncapped" or
 * "stackable" chip shouting about the ordinary case.
 */
export function Chip({
  icon,
  label,
  tone = "slate",
}: {
  icon?: ReactNode;
  label: string;
  tone?: SurfaceTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        PILL_TONES[tone],
        PILL_LABEL_TONES[tone],
      )}
    >
      {icon !== undefined && (
        <span aria-hidden="true" className="shrink-0">
          {icon}
        </span>
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}
