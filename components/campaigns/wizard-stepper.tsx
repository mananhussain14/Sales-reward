"use client";

import { cn } from "@/components/ui/cn";
import { AlertTriangleIcon, CheckIcon } from "@/components/ui/icons";
import {
  isSettledStatus,
  needsAttention,
  stepStatusLabel,
  type StepStatus,
} from "@/lib/campaigns/campaign-step-state";

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
 * BOTH PRESENTATIONS READ THE SAME `statuses` ARRAY. They cannot disagree about a step,
 * because neither of them derives anything — the state is computed once, in
 * @/lib/campaigns/campaign-step-state, and passed in.
 *
 * A step is reachable by click whether or not the steps before it are complete: this is a
 * configuration form, not a payment funnel, and jumping back to fix step 2 from step 5 is
 * the common case. Completion is shown, never enforced by hiding — the Save control is
 * what validation actually gates.
 *
 * STATE IS NEVER CARRIED BY COLOUR ALONE. Every step renders its status as a WORD, and the
 * two states an operator must act on differ in SHAPE as well: a check for a settled step,
 * a warning triangle for one that needs attention.
 */

export type StepperStep = {
  key: string;
  title: string;
  /** One sentence describing what the step decides. */
  summary: string;
};

/** The marker inside a step's disc: a tick, a warning, or the step's number. */
function StepMarker({
  status,
  index,
  active,
}: {
  status: StepStatus;
  index: number;
  active: boolean;
}) {
  if (needsAttention(status)) {
    return <AlertTriangleIcon className="h-4 w-4" />;
  }
  if (isSettledStatus(status) && !active) {
    return <CheckIcon className="h-4 w-4" />;
  }
  return <>{index + 1}</>;
}

const DISC_TONES: Record<StepStatus, string> = {
  NOT_STARTED: "bg-white text-slate-500 ring-slate-300",
  IN_PROGRESS: "bg-indigo-600 text-white ring-indigo-600",
  COMPLETE: "bg-emerald-50 text-emerald-700 ring-emerald-300",
  NEEDS_ATTENTION: "bg-amber-50 text-amber-700 ring-amber-400",
  NOT_READY: "bg-white text-slate-500 ring-slate-300",
  READY_TO_SAVE: "bg-emerald-50 text-emerald-700 ring-emerald-300",
};

const SEGMENT_TONES: Record<StepStatus, string> = {
  NOT_STARTED: "bg-slate-200 hover:bg-slate-300",
  IN_PROGRESS: "bg-indigo-600",
  COMPLETE: "bg-emerald-500",
  NEEDS_ATTENTION: "bg-amber-500",
  NOT_READY: "bg-slate-200 hover:bg-slate-300",
  READY_TO_SAVE: "bg-emerald-500",
};

const LABEL_TONES: Record<StepStatus, string> = {
  NOT_STARTED: "text-slate-500",
  IN_PROGRESS: "text-indigo-700",
  COMPLETE: "text-emerald-700",
  NEEDS_ATTENTION: "text-amber-700",
  NOT_READY: "text-slate-500",
  READY_TO_SAVE: "text-emerald-700",
};

export function WizardStepper({
  steps,
  statuses,
  activeIndex,
  onSelect,
}: {
  steps: readonly StepperStep[];
  /** One status per step, computed by campaignStepStatuses. */
  statuses: readonly StepStatus[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  const current = steps[activeIndex];
  const total = steps.length;
  const settled = statuses.filter((status) => isSettledStatus(status)).length;
  const attention = statuses.filter((status) => needsAttention(status)).length;

  return (
    <>
      {/* ---------------- Narrow: compact header, fixed height ---------------- */}
      <div className="lg:hidden">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
            Step {activeIndex + 1} of {total}
          </p>
          <p className="text-xs text-slate-500">
            {attention > 0
              ? `${attention} ${attention === 1 ? "step needs" : "steps need"} attention`
              : `${settled} of ${total} complete`}
          </p>
        </div>
        <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-900">
          {current?.title}
        </h2>
        <p className="mt-0.5 text-sm text-slate-500">{current?.summary}</p>

        {/* A segmented bar: one segment per step, so position is visible without labels.
            Each segment's accessible name still carries the step's status in words. */}
        <ol
          className="mt-3 flex gap-1.5"
          aria-label={`Step ${activeIndex + 1} of ${total}: ${current?.title ?? ""}`}
        >
          {steps.map((step, index) => {
            const status = statuses[index] ?? "NOT_STARTED";
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
                    SEGMENT_TONES[status],
                  )}
                >
                  <span className="sr-only">
                    {`Step ${index + 1}: ${step.title} — ${stepStatusLabel(status)}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {/* The active step's own status in words, so the narrow layout states it too
            rather than leaving it to the bar's colours. */}
        <p className={cn("mt-2 text-xs font-medium", LABEL_TONES[statuses[activeIndex] ?? "NOT_STARTED"])}>
          {stepStatusLabel(statuses[activeIndex] ?? "NOT_STARTED")}
        </p>
      </div>

      {/* ---------------- Wide: vertical rail ---------------- */}
      <nav className="hidden lg:block" aria-label="Campaign steps">
        <ol className="relative space-y-1">
          {steps.map((step, index) => {
            const status = statuses[index] ?? "NOT_STARTED";
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
                      isSettledStatus(status) ? "bg-emerald-300" : "bg-slate-200",
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
                      DISC_TONES[status],
                    )}
                  >
                    <StepMarker status={status} index={index} active={active} />
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
                    {/* The status in words. Never colour alone. */}
                    <span
                      className={cn("mt-0.5 block text-xs font-medium", LABEL_TONES[status])}
                    >
                      {stepStatusLabel(status)}
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
