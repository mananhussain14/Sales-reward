"use client";

import { cn } from "@/components/ui/cn";
import { CheckIcon } from "@/components/ui/icons";

/**
 * The campaign wizard's progress control.
 *
 * WHY IT IS NOT A ROW OF PILLS. Six labelled pills cannot fit one line at laptop width, so
 * they wrapped to two or three ragged rows and the control read as a pile of buttons
 * rather than a sense of position. This renders two different things instead, each right
 * for its width, and NEITHER can wrap:
 *
 *   * `lg` and wider — a VERTICAL rail beside the content. Every step is visible with its
 *     number, its state and a connecting line, and the content sits next to it.
 *   * below `lg` — a COMPACT HEADER: "Step 3 of 6", the step's own title, and a segmented
 *     progress bar. Fixed height, no wrapping, no truncation.
 *
 * Both are the same `<ol>` of buttons underneath, so keyboard order, focus and the
 * announced position are identical at every width — only the presentation differs.
 *
 * A step is reachable by click whether or not the steps before it are complete: this is a
 * configuration form, not a payment funnel, and jumping back to fix step 2 from step 5 is
 * the common case. Completion is shown, never enforced by hiding — the Save control is
 * what validation actually gates.
 */

export type StepperStep = {
  key: string;
  title: string;
  /** One sentence describing what the step decides. */
  summary: string;
};

export function WizardStepper({
  steps,
  activeIndex,
  isComplete,
  onSelect,
}: {
  steps: readonly StepperStep[];
  activeIndex: number;
  /** Whether the step at this index has everything it needs. */
  isComplete: (index: number) => boolean;
  onSelect: (index: number) => void;
}) {
  const current = steps[activeIndex];
  const total = steps.length;

  return (
    <>
      {/* ---------------- Narrow: compact header, fixed height ---------------- */}
      <div className="lg:hidden">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
            Step {activeIndex + 1} of {total}
          </p>
          <p className="text-xs text-slate-500">
            {steps.filter((_, index) => isComplete(index)).length} of {total} complete
          </p>
        </div>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
          {current?.title}
        </h2>
        <p className="mt-0.5 text-sm text-slate-500">{current?.summary}</p>

        {/* A segmented bar: one segment per step, so position is visible without labels. */}
        <ol
          className="mt-3 flex gap-1.5"
          aria-label={`Step ${activeIndex + 1} of ${total}: ${current?.title ?? ""}`}
        >
          {steps.map((step, index) => {
            const done = isComplete(index);
            const active = index === activeIndex;
            return (
              <li key={step.key} className="flex-1">
                <button
                  type="button"
                  onClick={() => onSelect(index)}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "h-1.5 w-full rounded-full transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
                    active
                      ? "bg-indigo-600"
                      : done
                        ? "bg-emerald-500"
                        : "bg-slate-200 hover:bg-slate-300",
                  )}
                >
                  <span className="sr-only">
                    {`Step ${index + 1}: ${step.title}${done ? " (complete)" : ""}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {/* ---------------- Wide: vertical rail ---------------- */}
      <nav className="hidden lg:block" aria-label="Campaign steps">
        <ol className="relative space-y-1">
          {steps.map((step, index) => {
            const done = isComplete(index);
            const active = index === activeIndex;
            const last = index === steps.length - 1;

            return (
              <li key={step.key} className="relative">
                {/* The connector, drawn behind the marker so states read as a sequence. */}
                {!last && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute left-[15px] top-9 h-[calc(100%-1.25rem)] w-px",
                      done ? "bg-emerald-300" : "bg-slate-200",
                    )}
                  />
                )}

                <button
                  type="button"
                  onClick={() => onSelect(index)}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "group flex w-full items-start gap-3 rounded-xl px-2 py-2 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
                    active ? "bg-indigo-50" : "hover:bg-slate-50",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 transition-colors",
                      active
                        ? "bg-indigo-600 text-white ring-indigo-600"
                        : done
                          ? "bg-emerald-50 text-emerald-700 ring-emerald-300"
                          : "bg-white text-slate-500 ring-slate-300",
                    )}
                  >
                    {done && !active ? (
                      <CheckIcon className="h-4 w-4" />
                    ) : (
                      index + 1
                    )}
                  </span>

                  <span className="min-w-0 pt-1">
                    <span
                      className={cn(
                        "block text-sm font-medium",
                        active ? "text-indigo-900" : "text-slate-800",
                      )}
                    >
                      {step.title}
                    </span>
                    {/* Completion is stated in words as well as colour. */}
                    <span className="mt-0.5 block text-xs text-slate-500">
                      {done ? "Complete" : active ? "In progress" : "Not started"}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
