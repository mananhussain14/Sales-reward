import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * A circular progress indicator, drawn in the product's own language.
 *
 * ============================================================================
 * IT DRAWS A RATIO AND CLAIMS NOTHING
 * ============================================================================
 * `fraction` is a DISPLAY VALUE the caller has already derived (see
 * `progressFraction` in @/lib/earnings/earnings-presentation). This component performs no
 * comparison, reads no target and decides nothing about whether a goal was met: a ring
 * that filled itself from two numbers would be a second definition of "reached" living in
 * a painter.
 *
 * The caller keeps the real numerator and denominator on screen beside it — 9 of 8 stays
 * 9 of 8 while the arc rests at full, because an arc cannot sweep past its own
 * circumference and rounding the numbers to match it would make a target look smaller
 * than it is.
 *
 * ============================================================================
 * SILENT TO ASSISTIVE TECHNOLOGY, BY DESIGN
 * ============================================================================
 * The ring is `aria-hidden`. A bare circular indicator announces a percentage and nothing
 * about WHOSE units it counts, which is precisely the confusion a RETAILER_TEAM target
 * creates. Every caller wraps the whole block in one `role="progressbar"` whose
 * `aria-valuetext` names the scope, the values and the state; announcing here as well
 * would have a reader hear the percentage twice.
 *
 * ============================================================================
 * NO LIBRARY, AND NO CANVAS
 * ============================================================================
 * Two `<circle>` elements and a dash offset. A charting dependency for one indicator
 * would be a large bundle for a shape SVG draws natively, and a canvas would not scale
 * with the reader's zoom.
 *
 * MOTION: the arc sweeps once from zero and stops, in pure CSS — so this stays a Server
 * Component. Under a reduced-motion preference it is painted at its value on the first
 * frame. See `.sr-ring-sweep` in app/globals.css.
 */

/**
 * The gauge's colour ramp. A PRESENTATION choice that decides nothing — the same
 * `fraction` produces the same geometry under every sweep.
 *
 * Read from the product's own scales rather than hand-mixed, so the gauge cannot drift
 * away from the palette the rest of the application uses.
 */
export type RingSweep = "indigo" | "warm" | "emerald";

const SWEEPS: Record<RingSweep, readonly [string, string]> = {
  /** Early progress, and any campaign with no target of its own. */
  indigo: ["#155DFC", "#4F39F6"],
  /** Warms as a target comes into reach. Says nothing about having reached it. */
  warm: ["#4F39F6", "#E17100"],
  /** `target_reached` is true — the database's answer, never this component's. */
  emerald: ["#155DFC", "#009966"],
};

export function ProgressRing({
  fraction,
  size = 128,
  strokeWidth = 10,
  sweep = "indigo",
  ticks,
  glow = false,
  trackClassName,
  center,
  idSuffix,
  className,
}: {
  /** 0..1. Clamped here as well as by the caller: an arc that swept past a full turn would overdraw its own start. */
  fraction: number;
  size?: number;
  strokeWidth?: number;
  sweep?: RingSweep;
  /**
   * Evenly spaced dial graduations around the whole circle.
   *
   * Deliberately NOT derived from the target: a 50-unit target does not get 50 ticks.
   * They make the sweep easier to read and say nothing about units.
   */
  ticks?: number;
  /** Paints a soft halo beneath the arc. */
  glow?: boolean;
  /** Overrides the track colour, for a ring sitting on a tinted surface. */
  trackClassName?: string;
  /** Rendered inside the ring. Usually the percentage and a short label. */
  center?: ReactNode;
  /**
   * Makes this instance's gradient and filter ids unique.
   *
   * Required rather than defaulted: two rings sharing one gradient id on a page would
   * both resolve to whichever was defined first. Same mechanism as `BrandLockup`.
   */
  idSuffix: string;
  className?: string;
}) {
  const value = Math.min(1, Math.max(0, fraction));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value);
  const centre = size / 2;

  const gradientId = `sr-ring-gradient${idSuffix}`;
  const glowId = `sr-ring-glow${idSuffix}`;
  const [from, to] = SWEEPS[sweep];

  // Inside the track, like a dial's graduations.
  const tickOuter = radius - strokeWidth / 2 - 3;
  const tickInner = tickOuter - 5;
  const tickMarks =
    ticks !== undefined && ticks >= 2
      ? Array.from({ length: ticks }, (_, index) => {
          // From twelve o'clock. A ring that started at three would read as a pie chart.
          const angle = (index / ticks) * 2 * Math.PI - Math.PI / 2;
          return {
            x1: centre + Math.cos(angle) * tickInner,
            y1: centre + Math.sin(angle) * tickInner,
            x2: centre + Math.cos(angle) * tickOuter,
            y2: centre + Math.sin(angle) * tickOuter,
          };
        })
      : [];

  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
    >
      <svg
        // The whole gauge is decorative; the block around it carries the meaning.
        aria-hidden="true"
        focusable="false"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="block"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
          {glow && (
            <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="5" />
            </filter>
          )}
        </defs>

        {/* Rotated so the sweep begins at twelve o'clock. */}
        <g transform={`rotate(-90 ${centre} ${centre})`}>
          {tickMarks.map((tick, index) => (
            <line
              key={index}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              strokeWidth={1.5}
              strokeLinecap="round"
              className={cn("stroke-slate-200", trackClassName)}
            />
          ))}

          <circle
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className={cn("stroke-slate-200", trackClassName)}
          />

          {value > 0 && glow && (
            <circle
              cx={centre}
              cy={centre}
              r={radius}
              fill="none"
              stroke={to}
              strokeOpacity={0.28}
              strokeWidth={strokeWidth * 1.7}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              filter={`url(#${glowId})`}
            />
          )}

          {value > 0 && (
            <circle
              cx={centre}
              cy={centre}
              r={radius}
              fill="none"
              stroke={`url(#${gradientId})`}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              // The animation drives the offset from the full circumference down
              // to this value and holds it. The inline value is the fallback for
              // a browser that never runs the animation at all.
              strokeDashoffset={offset}
              className="sr-ring-sweep"
              style={
                {
                  "--sr-ring-circumference": `${circumference}`,
                  "--sr-ring-offset": `${offset}`,
                } as React.CSSProperties
              }
            />
          )}
        </g>
      </svg>

      {center !== undefined && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center text-center"
          // Inset by the stroke so the label never sits under the arc.
          style={{ padding: strokeWidth + 8 }}
        >
          {center}
        </div>
      )}
    </div>
  );
}
