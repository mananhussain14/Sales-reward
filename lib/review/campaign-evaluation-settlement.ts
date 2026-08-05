import type { CampaignEvaluationRow } from "@/lib/review/campaign-evaluation-display";

/**
 * What an evaluation attempt SETTLED as — the pure half of the Server Action.
 *
 * NO React, NO Supabase, NO `server-only`. The action calls `summarize` and
 * `settleEvaluation`; the panel renders what they return. Both are ordinary functions
 * so every message in this feature is testable by calling it.
 *
 * ============================================================================
 * A REPLAY IS NOT A SECOND AWARD, AND THE COPY MUST NOT SAY IT IS
 * ============================================================================
 * Migration 68 is same-result idempotent: running it again returns the stored
 * evidence, creates nothing and moves no accumulator. The reviewer has to be told
 * that in words, because the SCREEN looks identical either way — the same campaigns,
 * the same coins. Copy that said "reward created" on a replay would be the single
 * most misleading sentence this feature could produce, so `evaluationsCreated` and
 * `rewardsCreated` are counted from the rows and the wording follows them.
 *
 * ============================================================================
 * MIXED IS A REAL OUTCOME
 * ============================================================================
 * One execution can create some evaluations while another campaign's reward reports
 * ALREADY_APPLIED — a partially-completed earlier attempt, or a campaign published
 * between two runs. The summary counts each row on its own rather than assuming the
 * whole result shares one status.
 */

export const EVALUATION_OUTCOMES = [
  /** At least one evaluation row was created by THIS call. */
  "EVALUATED",
  /** Rows came back and none was created by this call. */
  "ALREADY_EVALUATED",
  /** The call succeeded and matched no campaign at all. */
  "NO_CAMPAIGNS",
] as const;
export type EvaluationOutcome = (typeof EVALUATION_OUTCOMES)[number];

export function isEvaluationOutcome(value: unknown): value is EvaluationOutcome {
  return (
    typeof value === "string" &&
    (EVALUATION_OUTCOMES as readonly string[]).includes(value)
  );
}

/** Display-only counts, derived from the returned rows and nothing else. */
export type EvaluationSummary = {
  /** Every campaign the sale was evaluated against. */
  campaignCount: number;
  /** Rows whose outcome is QUALIFIED. */
  qualifiedCount: number;
  /** Evaluations created by THIS call. */
  evaluationsCreated: number;
  /** Rewards created by THIS call — `APPLIED` and a reward row. */
  rewardsCreated: number;
  /** Reward applications that found an existing reward. */
  rewardsAlreadyApplied: number;
  /** Total coins across the rows that carry a stored reward. */
  totalRewardCoins: number;
};

export const EMPTY_EVALUATION_SUMMARY: EvaluationSummary = {
  campaignCount: 0,
  qualifiedCount: 0,
  evaluationsCreated: 0,
  rewardsCreated: 0,
  rewardsAlreadyApplied: 0,
  totalRewardCoins: 0,
};

/**
 * Counts the rows. Summing `rewardCoins` is presentation, not reward arithmetic: each
 * value is a stored `campaign_rewards.reward_coins` and nothing is derived from a
 * rate, a unit count or a cap.
 */
export function summarize(
  rows: readonly CampaignEvaluationRow[],
): EvaluationSummary {
  let qualifiedCount = 0;
  let evaluationsCreated = 0;
  let rewardsCreated = 0;
  let rewardsAlreadyApplied = 0;
  let totalRewardCoins = 0;

  for (const row of rows) {
    if (row.outcome === "QUALIFIED") qualifiedCount += 1;
    if (row.evaluationCreated) evaluationsCreated += 1;
    // A reward created by THIS call: the applier ran now AND left a row. APPLIED
    // without a reward is the target-bonus sale that counted units and crossed
    // nothing — real, successful, and not a reward.
    if (row.applicationResult === "APPLIED" && row.rewardCreated) {
      rewardsCreated += 1;
    }
    if (row.applicationResult === "ALREADY_APPLIED") rewardsAlreadyApplied += 1;
    if (row.rewardCoins !== null) totalRewardCoins += row.rewardCoins;
  }

  return {
    campaignCount: rows.length,
    qualifiedCount,
    evaluationsCreated,
    rewardsCreated,
    rewardsAlreadyApplied,
    totalRewardCoins,
  };
}

/** Which of the three settled shapes this result is. */
export function classifyEvaluation(
  summary: EvaluationSummary,
): EvaluationOutcome {
  if (summary.campaignCount === 0) return "NO_CAMPAIGNS";
  return summary.evaluationsCreated > 0 ? "EVALUATED" : "ALREADY_EVALUATED";
}

export const NO_CAMPAIGNS_MESSAGE = "No campaigns matched this verified sale.";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The sentence the reviewer reads. Accurate about what THIS call did, and never
 * about what a previous one did.
 */
export function evaluationMessage(
  outcome: EvaluationOutcome,
  summary: EvaluationSummary,
): string {
  if (outcome === "NO_CAMPAIGNS") return NO_CAMPAIGNS_MESSAGE;

  if (outcome === "ALREADY_EVALUATED") {
    const base =
      "Existing campaign evaluation returned. No duplicate reward was created.";
    return `${base} ${plural(summary.campaignCount, "campaign", "campaigns")} already evaluated.`;
  }

  const parts = [
    `Campaign evaluation completed. ${plural(summary.evaluationsCreated, "campaign evaluation", "campaign evaluations")} created`,
  ];
  parts.push(
    summary.rewardsCreated === 0
      ? "no reward was created"
      : `${plural(summary.rewardsCreated, "reward", "rewards")} created`,
  );
  // Mixed results say so rather than being flattened into "created".
  if (summary.rewardsAlreadyApplied > 0) {
    parts.push(
      `${plural(summary.rewardsAlreadyApplied, "reward was", "rewards were")} already applied`,
    );
  }
  return `${parts.join(", ")}.`;
}

/* ---------------------------------------------------------------------------
 * The panel's visual state
 * ------------------------------------------------------------------------- */

export const PANEL_STATES = [
  "unavailable",
  "not-ready",
  "ready",
  "evaluated",
  "zero-campaigns",
] as const;
export type PanelState = (typeof PANEL_STATES)[number];

/**
 * Which state the panel is in.
 *
 * THE ORDER OF THESE BRANCHES IS THE RULE. Stored rows win over everything, because
 * evidence that exists must always be shown. Only when there is none does the
 * ACTION result get to distinguish "matched nothing" from "not evaluated yet" — a
 * distinction the reads genuinely cannot make, since the database stores nothing in
 * either case.
 */
export function panelState(input: {
  /** `null` when the results read failed — never "no campaigns". */
  storedResults: readonly unknown[] | null;
  /** The settled outcome of an execution in THIS interaction, if any. */
  lastOutcome: EvaluationOutcome | null;
  /** Whether the receipt currently offers the action at all. */
  canEvaluate: boolean;
}): PanelState {
  if (input.storedResults === null) return "unavailable";
  if (input.storedResults.length > 0) return "evaluated";
  if (input.lastOutcome === "NO_CAMPAIGNS") return "zero-campaigns";
  return input.canEvaluate ? "ready" : "not-ready";
}

/* ---------------------------------------------------------------------------
 * Error copy — one safe sentence per class, never a database message
 * ------------------------------------------------------------------------- */

export const REFUSED_MESSAGE =
  "You do not have permission to evaluate campaigns for this receipt.";
export const NOT_READY_MESSAGE =
  "Finalize the verified sale items before evaluating campaigns.";
export const EXCLUDED_MESSAGE =
  "This receipt is excluded from campaign qualification.";
export const CONFLICT_MESSAGE =
  "Stored campaign evidence no longer matches the calculated result. No changes were made.";
export const UNAVAILABLE_MESSAGE =
  "Campaign evaluation could not be completed. Try again.";
export const MALFORMED_REQUEST_MESSAGE =
  "Something went wrong with this request. Refresh the page and try again.";

export const PENDING_MESSAGE = "Evaluating campaigns…";
export const REFRESHING_MESSAGE = "Refreshing campaign results…";

/**
 * Refresh only after a settled execution.
 *
 * A failure must NOT refresh: it changed nothing, and re-rendering would replace the
 * error the reviewer is reading with a page that looks untouched.
 */
export function shouldRefreshAfterEvaluation(state: {
  outcome: EvaluationOutcome | null;
  formError: string | null;
}): boolean {
  return state.outcome !== null && state.formError === null;
}
