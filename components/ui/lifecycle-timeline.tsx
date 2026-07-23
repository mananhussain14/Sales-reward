import { cn } from "@/components/ui/cn";
import { CheckIcon, XIcon } from "@/components/ui/icons";

/**
 * A VISUAL-ONLY lifecycle timeline.
 *
 * It renders the stages the CALLER supplies with the states the CALLER supplies.
 * It infers nothing: a stage is "complete", "current", "upcoming", or "failed"
 * only because server-resolved status data proved it so. For a state whose exact
 * stage cannot be determined, the caller shows a simpler status card instead of a
 * guessed timeline — this component never fills a gap by assuming progress.
 *
 * Vertical layout, so it stays readable at every width and never overflows on a
 * phone. The current step gets a soft pulsing ring (suppressed under
 * reduced-motion via the global rule) so the eye lands on "where we are now".
 */
export type LifecycleStepState = "complete" | "current" | "upcoming" | "failed";

export type LifecycleStep = {
  label: string;
  state: LifecycleStepState;
  /** Optional supporting line under the label (e.g. a date). */
  hint?: string;
};

const NODE_STYLES: Record<LifecycleStepState, string> = {
  complete: "border-emerald-600 bg-emerald-600 text-white",
  current: "border-indigo-500 bg-indigo-50 text-indigo-700",
  upcoming: "border-slate-300 bg-white text-slate-400",
  failed: "border-red-500 bg-red-500 text-white",
};

const LABEL_STYLES: Record<LifecycleStepState, string> = {
  complete: "text-slate-900",
  current: "text-indigo-700 font-semibold",
  upcoming: "text-slate-400",
  failed: "text-red-700 font-semibold",
};

/** Screen-reader suffix so status is not conveyed by color/icon alone. */
const STATE_SR_TEXT: Record<LifecycleStepState, string> = {
  complete: "completed",
  current: "in progress",
  upcoming: "not started",
  failed: "failed",
};

export function LifecycleTimeline({
  steps,
  className,
}: {
  steps: LifecycleStep[];
  className?: string;
}) {
  return (
    <ol className={cn("space-y-0", className)}>
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        // The connector below a node is "done" only when this step is complete.
        const connectorDone = step.state === "complete";
        return (
          <li key={step.label} className="relative flex gap-3 pb-5 last:pb-0">
            {/* Connector line to the next node. */}
            {!isLast && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-0.5 rounded-full",
                  connectorDone ? "bg-emerald-500" : "bg-slate-200",
                )}
              />
            )}
            <span
              aria-hidden="true"
              className={cn(
                "relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-[0.7rem] font-semibold",
                NODE_STYLES[step.state],
                step.state === "current" &&
                  "ring-4 ring-indigo-100 motion-safe:animate-pulse",
              )}
            >
              {step.state === "complete" ? (
                <CheckIcon className="h-3.5 w-3.5" />
              ) : step.state === "failed" ? (
                <XIcon className="h-3.5 w-3.5" />
              ) : (
                index + 1
              )}
            </span>
            <div className="min-w-0 pt-0.5">
              <p className={cn("text-sm", LABEL_STYLES[step.state])}>
                {step.label}
                <span className="sr-only"> — {STATE_SR_TEXT[step.state]}</span>
              </p>
              {step.hint && (
                <p className="mt-0.5 text-xs text-slate-500">{step.hint}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
