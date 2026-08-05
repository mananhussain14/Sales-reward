import type {
  EvaluationOutcome,
  EvaluationSummary,
} from "@/lib/review/campaign-evaluation-settlement";
import { EMPTY_EVALUATION_SUMMARY } from "@/lib/review/campaign-evaluation-settlement";

/**
 * The state a campaign evaluation hands back to the panel.
 *
 * A separate module from the action itself so the Client Component can import the
 * shape without importing a `"use server"` file — the convention already used by
 * decision-action-state.ts, qualification-action-state.ts,
 * sale-finalization-action-state.ts and product-decision-action-state.ts.
 */
export type { EvaluationOutcome, EvaluationSummary };

export type CampaignEvaluationActionState = {
  /** One safe sentence. Never a database message, code or hint. */
  formError: string | null;
  /** Null until an authoritative answer came back. */
  outcome: EvaluationOutcome | null;
  message: string | null;
  /** Display-only counts, derived from the rows the database returned. */
  summary: EvaluationSummary;
  /**
   * True once the database has given a FINAL answer.
   *
   * Unlike the product decision, this does NOT lock the control: evaluation is
   * idempotent by design and a reviewer may legitimately run it again — the second
   * run simply reports that the stored evidence was returned.
   */
  settled: boolean;
};

export const INITIAL_CAMPAIGN_EVALUATION_ACTION_STATE: CampaignEvaluationActionState =
  {
    formError: null,
    outcome: null,
    message: null,
    summary: EMPTY_EVALUATION_SUMMARY,
    settled: false,
  };
