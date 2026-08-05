import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { CampaignEvaluationRow } from "@/lib/review/campaign-evaluation-display";

/**
 * Running campaign evaluation — the write side of Phase 2A-F.
 *
 * SERVER-ONLY. One RPC and nothing else:
 *
 *   public.evaluate_receipt_campaigns(p_submission_id)
 *
 * ============================================================================
 * ONE ARGUMENT, AND NOT ONE MORE
 * ============================================================================
 * No verified sale id, Vendor, Retailer, shop, campaign, campaign version,
 * beneficiary, product, unit count, rate, cap, threshold, reward, accumulator or
 * audit action — and this module could not supply one if it wanted to, because the
 * function has no parameter for any of it. Migration 69 resolves the sale from the
 * receipt through the unique index; Migration 68 checks CAMPAIGN_EVALUATION_EXECUTE
 * and RECEIPT_REVIEW_READ, compares the Vendor against the sale's own frozen one,
 * locks the sale row, re-checks finalization and exclusion, writes the evidence,
 * calls Migration 67 for the reward and writes its own audit entry — all in one
 * transaction, none of it here.
 *
 * ============================================================================
 * WHY THE SQLSTATE IS THE ONLY THING READ FROM AN ERROR
 * ============================================================================
 * PostgREST reports a raised exception as an error whose message, details and hint
 * name schemas, tables and functions. Only `code` is touched, exactly as
 * finalize-claim-receipt-sale-items does.
 *
 * The database deliberately raises the SAME 42501 for "not a reviewer", "not your
 * Vendor", "no such receipt", "no finalized sale" and "actively excluded", so this
 * module cannot rebuild the oracle the RPC is careful not to be — every one of them
 * becomes a single `refused`. The narrower classes below exist only for the codes the
 * database genuinely distinguishes.
 */

export type EvaluateReceiptCampaignsResult =
  | { status: "ok"; rows: CampaignEvaluationRow[] }
  | { status: "unauthenticated" }
  /**
   * Not a reviewer, not your Vendor, no such receipt, no finalized sale, or actively
   * excluded. Deliberately MERGED — the database gives one answer and so does this.
   */
  | { status: "refused" }
  /** Stored evidence disagrees with the recalculation. Nothing was written. */
  | { status: "conflict" }
  /** The call did not complete. Whether it committed is UNKNOWN. */
  | { status: "unavailable" };

/** One row of the RPC, declared explicitly — the exact deployed 13 columns. */
type EvaluationRpcRow = {
  receipt_submission_id: string | null;
  campaign_sale_evaluation_id: string | null;
  campaign_id: string | null;
  campaign_version_id: string | null;
  outcome: string | null;
  non_qualification_reason: string | null;
  qualifying_item_count: number | string | null;
  qualifying_units: number | string | null;
  campaign_reward_id: string | null;
  reward_coins: number | string | null;
  reward_created: boolean | null;
  evaluation_created: boolean | null;
  application_result: string | null;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Unsafe integers are rejected, never rounded. See receipt-campaign-results. */
function optionalWholeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Only the SQLSTATE is read. Message, details and hint are never touched. */
function sqlstateOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Field by field, never a spread. */
function toRow(row: EvaluationRpcRow): CampaignEvaluationRow | null {
  const campaignId = optionalText(row.campaign_id);
  const campaignVersionId = optionalText(row.campaign_version_id);
  const outcome = optionalText(row.outcome);

  if (campaignId === null || campaignVersionId === null || outcome === null) {
    return null;
  }

  return {
    campaignId,
    campaignVersionId,
    outcome,
    nonQualificationReason: optionalText(row.non_qualification_reason),
    qualifyingItemCount: optionalWholeNumber(row.qualifying_item_count) ?? 0,
    qualifyingUnits: optionalWholeNumber(row.qualifying_units) ?? 0,
    campaignRewardId: optionalText(row.campaign_reward_id),
    rewardCoins: optionalWholeNumber(row.reward_coins),
    rewardCreated: row.reward_created === true,
    evaluationCreated: row.evaluation_created === true,
    applicationResult: optionalText(row.application_result),
  };
}

export async function evaluateReceiptCampaigns(
  receiptSubmissionId: string,
): Promise<EvaluateReceiptCampaignsResult> {
  const supabase = await createClient();

  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims?.sub) {
      return { status: "unauthenticated" };
    }
  } catch {
    return { status: "unauthenticated" };
  }

  const result = await Promise.resolve(
    supabase.rpc("evaluate_receipt_campaigns", {
      p_submission_id: receiptSubmissionId,
    }),
  ).catch(() => null);

  if (result === null) {
    console.error("evaluate-receipt-campaigns: call did not complete");
    return { status: "unavailable" };
  }

  if (result.error) {
    switch (sqlstateOf(result.error)) {
      case "42501":
        // Authorization OR eligibility OR unknown receipt. Merged on purpose.
        console.error("evaluate-receipt-campaigns: refused by the database");
        return { status: "refused" };
      case "23514":
        // A conflicting recalculation, or item evidence that does not reconcile.
        // Migration 68 raised before writing anything.
        console.error("evaluate-receipt-campaigns: stored evidence conflict");
        return { status: "conflict" };
      default:
        console.error("evaluate-receipt-campaigns: call failed");
        return { status: "unavailable" };
    }
  }

  // ZERO ROWS IS A SUCCESS. It means the sale matched no campaign — Migration 68
  // returns an empty result and writes an audit entry saying so. Treating it as a
  // failure would report an error for a completely normal receipt.
  const raw = (result.data ?? []) as EvaluationRpcRow[];
  const rows: CampaignEvaluationRow[] = [];
  let dropped = 0;

  for (const row of raw) {
    const mapped = toRow(row);
    if (mapped === null) {
      dropped += 1;
      continue;
    }
    rows.push(mapped);
  }

  // An unreadable row means the summary counts would be wrong, and a wrong "2 rewards
  // created" is worse than an honest failure. The write itself has already committed,
  // so this is reported as uncertain rather than refused.
  if (dropped > 0) {
    console.error(
      `evaluate-receipt-campaigns: ${dropped} returned row(s) were unreadable`,
    );
    return { status: "unavailable" };
  }

  return { status: "ok", rows };
}
