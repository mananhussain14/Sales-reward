/**
 * PURE MODULE — no imports beyond the campaign form rules, no I/O, no React.
 *
 * The wizard's per-step progress state.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * The stepper previously asked one question — `isStepComplete(values, key)`, which is
 * "does this step currently produce no validation error?" — and rendered "Complete"
 * whenever the answer was yes. That is not the same question as "has the operator
 * completed this step", and on an empty form the two disagree in three separate ways:
 *
 *   1. `audienceMode` defaults to ALL_RETAILERS and `productScope` to
 *      ALL_ELIGIBLE_PRODUCTS. Both defaults are VALID, so steps 2 and 3 reported
 *      "Complete" before the operator had ever seen them.
 *   2. STEP_FIELDS.review is deliberately empty — the review step owns no fields of its
 *      own — so `stepErrors` always returned {} for it and "Review and save" reported
 *      "Complete" on a blank campaign with no name, no reward and no schedule.
 *   3. Nothing tracked whether a step had been VISITED, so there was no way to
 *      distinguish "valid because the operator configured it" from "valid because the
 *      initial state happens to be legal".
 *
 * The summary panel was reading the same values correctly and saying they were missing,
 * so the two controls contradicted each other on the same screen.
 *
 * ============================================================================
 * WHAT THIS MODULE DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ============================================================================
 * It answers ONE question — which of six user-facing states each step is in — by
 * combining three inputs that were previously collapsed into one:
 *
 *   * IS IT VALID       — delegated ENTIRELY to validateCampaignForm via isStepComplete.
 *                         This module contains no field rule of its own, so there is no
 *                         second validation system to drift from the first.
 *   * HAS IT BEEN SEEN  — the wizard's visited set.
 *   * IS IT ACTIVE      — the current step index.
 *
 * The one thing it adds beyond field validity is `audienceResolvesToNoRetailer`, and it
 * is an input rather than a rule: whether a chosen group is empty depends on data the
 * pure form validator has never had (group member counts), and a campaign whose audience
 * resolves to nobody must not read as publish-ready even though every field is legal.
 */
// A RELATIVE import with the explicit extension, matching every other pure module under
// lib/campaigns. `npm test` is plain `node --test`, which does not resolve the `@/` path
// alias — only the bundler does — so an aliased import here would compile under tsc and
// then fail to load in the test runner.
import {
  WIZARD_STEPS,
  isStepComplete,
  type CampaignFormValues,
} from "./campaign-input.ts";

/**
 * The six states a step can be in.
 *
 * The first four apply to the five CONFIGURATION steps. The last two belong to the review
 * step alone, which has no fields of its own and is therefore never "complete" in the
 * same sense — it is READY_TO_SAVE, or it is not.
 */
export const STEP_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETE",
  "NEEDS_ATTENTION",
  "NOT_READY",
  "READY_TO_SAVE",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** The index of the review step. Derived, so a seventh step could not desynchronize it. */
export const REVIEW_STEP_INDEX = WIZARD_STEPS.length - 1;

/**
 * The word shown to an operator for each state.
 *
 * The review step's two states are deliberately worded differently from the others:
 * "Ready to save" says what the next action is, and neither of them says "published",
 * because this wizard has never published anything.
 */
const STATUS_LABELS: Record<StepStatus, string> = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  COMPLETE: "Complete",
  NEEDS_ATTENTION: "Needs attention",
  NOT_READY: "Not ready",
  READY_TO_SAVE: "Ready to save",
};

export function stepStatusLabel(status: StepStatus): string {
  return STATUS_LABELS[status];
}

/**
 * The tone each state is drawn in.
 *
 * Advisory only. Every state renders its LABEL as well, and the two states that most need
 * to be distinguishable at a glance also carry a distinct icon shape, so nothing here is
 * carried by colour alone.
 */
export type StepStatusTone = "slate" | "indigo" | "emerald" | "amber";

const STATUS_TONES: Record<StepStatus, StepStatusTone> = {
  NOT_STARTED: "slate",
  IN_PROGRESS: "indigo",
  COMPLETE: "emerald",
  NEEDS_ATTENTION: "amber",
  NOT_READY: "slate",
  READY_TO_SAVE: "emerald",
};

export function stepStatusTone(status: StepStatus): StepStatusTone {
  return STATUS_TONES[status];
}

/** Whether a state means "this step is finished and valid". */
export function isSettledStatus(status: StepStatus): boolean {
  return status === "COMPLETE" || status === "READY_TO_SAVE";
}

/** Whether a state means "the operator has something to fix here". */
export function needsAttention(status: StepStatus): boolean {
  return status === "NEEDS_ATTENTION";
}

export type StepStatusInput = {
  values: CampaignFormValues;
  /** The step currently on screen. */
  activeIndex: number;
  /** Every step index the operator has actually opened. */
  visited: ReadonlySet<number>;
  /** True once the draft has been written. Only then can the review step be COMPLETE. */
  saved: boolean;
  /**
   * True when the chosen audience currently resolves to no Retailer at all — every
   * selected group is empty. Field-valid, but not publish-ready, and the step must not
   * claim otherwise. Supplied by the caller because group membership counts are data the
   * pure validator does not hold.
   */
  audienceResolvesToNoRetailer?: boolean;
};

/**
 * Whether one CONFIGURATION step's fields are currently valid.
 *
 * Delegates to the authoritative validator and adds nothing except the audience overlay
 * described above. Exported so a test can assert the delegation directly.
 */
export function isConfigurationStepValid(
  values: CampaignFormValues,
  index: number,
  audienceResolvesToNoRetailer = false,
): boolean {
  const step = WIZARD_STEPS[index];
  if (step === undefined || index === REVIEW_STEP_INDEX) return false;

  if (!isStepComplete(values, step.key)) return false;

  // A campaign targeting only empty groups passes every field rule and would still reach
  // nobody. Publication refuses it; the stepper must not call it Complete first.
  if (step.key === "audience" && audienceResolvesToNoRetailer) return false;

  return true;
}

/**
 * The status of every step, in order.
 *
 * CONFIGURATION STEPS resolve in this precedence, and the order matters:
 *
 *   active            -> IN_PROGRESS      the operator is working on it right now
 *   never visited     -> NOT_STARTED      even when its default value is perfectly legal
 *   visited + valid   -> COMPLETE
 *   visited + invalid -> NEEDS_ATTENTION  it was opened, and something is still wrong —
 *                                         including the case where an earlier change
 *                                         invalidated a step that used to be complete
 *
 * THE REVIEW STEP never reports COMPLETE merely because it is reachable:
 *
 *   saved                       -> COMPLETE        the draft actually exists
 *   all five config steps valid -> READY_TO_SAVE
 *   otherwise                   -> NOT_READY
 *
 * Validity is recomputed from `values` on every call, so changing an earlier choice
 * re-derives every later step automatically and no stale indicator can survive.
 */
export function campaignStepStatuses(input: StepStatusInput): StepStatus[] {
  const {
    values,
    activeIndex,
    visited,
    saved,
    audienceResolvesToNoRetailer = false,
  } = input;

  const configurationValid = WIZARD_STEPS.map((_, index) =>
    index === REVIEW_STEP_INDEX
      ? true
      : isConfigurationStepValid(values, index, audienceResolvesToNoRetailer),
  );

  const allConfigurationValid = configurationValid
    .slice(0, REVIEW_STEP_INDEX)
    .every(Boolean);

  return WIZARD_STEPS.map((_, index) => {
    if (index === REVIEW_STEP_INDEX) {
      if (saved) return "COMPLETE";
      return allConfigurationValid ? "READY_TO_SAVE" : "NOT_READY";
    }

    if (index === activeIndex) return "IN_PROGRESS";
    if (!visited.has(index)) return "NOT_STARTED";
    return configurationValid[index] ? "COMPLETE" : "NEEDS_ATTENTION";
  });
}

/**
 * A one-sentence description of overall progress, for the summary badge's accessible
 * name and for anywhere the short "4 of 7" form is not enough on its own.
 */
export function progressDescription(complete: number, total: number, attention: number): string {
  const base = `${complete} of ${total} details complete`;
  if (attention === 0) return base;
  return `${base}, ${attention} ${attention === 1 ? "needs" : "need"} attention`;
}
