"use server";

import { evaluateReceiptCampaigns } from "@/lib/review/evaluate-receipt-campaigns";
import { isReceiptSubmissionId } from "@/lib/review/claim-review-queue-filters";
import {
  classifyEvaluation,
  evaluationMessage,
  summarize,
  CONFLICT_MESSAGE,
  EMPTY_EVALUATION_SUMMARY,
  MALFORMED_REQUEST_MESSAGE,
  REFUSED_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from "@/lib/review/campaign-evaluation-settlement";
import {
  type CampaignEvaluationActionState,
  INITIAL_CAMPAIGN_EVALUATION_ACTION_STATE,
} from "@/app/(review)/review/[receiptSubmissionId]/campaign-evaluation-action-state";

/**
 * The Server Action behind "Evaluate campaigns".
 *
 * ============================================================================
 * WHAT IT READS, AND WHAT IT REFUSES TO
 * ============================================================================
 * Exactly ONE field: receiptSubmissionId.
 *
 * NO verified sale id. NO Vendor, Retailer, shop, reviewer, actor or membership. NO
 * campaign, campaign version, product, unit count, rate, cap, threshold or reward. NO
 * audit action. NO return URL. None would be usable if a crafted request supplied
 * them, because `evaluate_receipt_campaigns` has no parameter for any of it.
 *
 * ============================================================================
 * IT CALCULATES NO REWARD
 * ============================================================================
 * `summarize` COUNTS the rows the database returned. It multiplies nothing, applies
 * no cap and compares no threshold — every coin value on the screen is a stored
 * `campaign_rewards` value that Migration 67 wrote.
 *
 * ============================================================================
 * IT REVALIDATES NOTHING
 * ============================================================================
 * Next.js would otherwise complete the mutation, the cache invalidation and the page
 * re-render in one roundtrip, holding the reply behind a re-render of the very page
 * the reviewer is on. This action returns its outcome and nothing else; the panel
 * renders it and then refreshes the route itself. See
 * docs/server-action-authoritative-settlement.md.
 *
 * ============================================================================
 * A REPEAT PRESS IS NOT SHORT-CIRCUITED
 * ============================================================================
 * Unlike the product decision, `settled` does NOT block a second call: evaluation is
 * same-result idempotent in the database, and a reviewer re-running it is a
 * legitimate way to confirm the stored result. The panel disables the control while a
 * request is in flight, which is what actually prevents a double submission.
 *
 * ============================================================================
 * NOTHING RAW IS LOGGED
 * ============================================================================
 * Nothing here logs a receipt id, a campaign, a coin value or any provider error.
 */

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function evaluateReceiptCampaignsAction(
  _prevState: CampaignEvaluationActionState,
  formData: FormData,
): Promise<CampaignEvaluationActionState> {
  const receiptSubmissionId = field(formData, "receiptSubmissionId").trim();
  const base: CampaignEvaluationActionState = {
    ...INITIAL_CAMPAIGN_EVALUATION_ACTION_STATE,
  };

  // A malformed id never reaches an RPC. Reported as a generic problem rather than
  // "no such receipt", because the form is only ever rendered with an id the server
  // itself put there — a bad one means something is wrong, not missing.
  if (!isReceiptSubmissionId(receiptSubmissionId)) {
    return { ...base, formError: MALFORMED_REQUEST_MESSAGE };
  }

  const result = await evaluateReceiptCampaigns(receiptSubmissionId);

  if (result.status === "unauthenticated" || result.status === "refused") {
    // The database answered, and the answer was no. Not authorized, not your Vendor,
    // not finalized, actively excluded and not there are ONE answer by design.
    return { ...base, formError: REFUSED_MESSAGE };
  }

  if (result.status === "conflict") {
    // Migration 68 raised before writing anything, so this is a definite failure and
    // nothing changed.
    return { ...base, formError: CONFLICT_MESSAGE };
  }

  if (result.status === "unavailable") {
    return { ...base, formError: UNAVAILABLE_MESSAGE };
  }

  // The database has spoken. Return immediately: the panel renders this outcome and
  // then refreshes the route itself.
  const summary = summarize(result.rows);
  const outcome = classifyEvaluation(summary);

  return {
    ...base,
    outcome,
    message: evaluationMessage(outcome, summary),
    summary: result.rows.length === 0 ? EMPTY_EVALUATION_SUMMARY : summary,
    settled: true,
  };
}
