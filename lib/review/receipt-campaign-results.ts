import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { CampaignResult } from "@/lib/review/campaign-evaluation-display";

/**
 * The stored campaign results for one receipt — Phase 2A-F.
 *
 * SERVER-ONLY. ONE RPC: `get_receipt_campaign_results(p_submission_id)`, the
 * Migration 69 receipt-keyed wrapper. It takes the receipt id and NOTHING else: no
 * Vendor, no verified sale id, no campaign, no beneficiary. The Vendor is resolved in
 * SQL from auth.uid() through the Phase 1B reviewer resolver, and the wrapper
 * resolves the verified sale internally through the unique receipt index.
 *
 * ============================================================================
 * THE VERIFIED SALE ID IS NEVER SEEN HERE
 * ============================================================================
 * That is the entire reason Migration 69 exists. `verified_sales` carries RLS with
 * zero policies and `authenticated` holds no SELECT on it, so this module could not
 * read a sale id if it tried — and it must not want to. The route key is the receipt,
 * and it stays the receipt all the way down.
 *
 * ============================================================================
 * ZERO ROWS IS NOT "NO CAMPAIGNS"
 * ============================================================================
 * The RPC returns zero rows for a sale nobody has evaluated, a sale that matched no
 * campaign, a foreign Vendor, a caller without RECEIPT_REVIEW_READ and an unknown
 * receipt alike — it raises nothing. So `results: []` means only "there is nothing
 * stored to show", and the panel says "not evaluated" until an execution in the same
 * interaction reports otherwise. `null` is reserved for a read that FAILED and must
 * never be confused with an empty one.
 *
 * Bounded and read-only: one call, no polling, no automatic re-read.
 */

export type { CampaignResult };

export type ReceiptCampaignResultsResult =
  | { status: "authorized"; results: CampaignResult[] }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

/**
 * One row of the RPC, declared explicitly — the exact deployed 16 columns.
 *
 * `bigint` arrives from PostgREST as a number when it fits and a STRING when it does
 * not, so every coin column admits both and is narrowed below.
 */
type CampaignResultRpcRow = {
  campaign_id: string | null;
  campaign_version_id: string | null;
  campaign_name: string | null;
  outcome: string | null;
  non_qualification_reason: string | null;
  qualifying_item_count: number | string | null;
  qualifying_units: number | string | null;
  rule_type: string | null;
  coins_per_unit: number | string | null;
  threshold_units: number | string | null;
  configured_reward_coins: number | string | null;
  max_reward_coins: number | string | null;
  coins_uncapped: number | string | null;
  coins_capped_to: number | string | null;
  reward_coins: number | string | null;
  awarded_at: string | null;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * A non-negative whole number, or `null`.
 *
 * A value beyond Number.MAX_SAFE_INTEGER is REJECTED rather than silently rounded —
 * the same rule campaign-normalization applies to configured coins, and for the same
 * reason: a rounded coin amount is a wrong coin amount, and showing one on a reward
 * screen would be worse than showing nothing.
 */
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

/** A required count. Absent or unsafe collapses to 0 rather than to NaN. */
function wholeNumber(value: unknown): number {
  return optionalWholeNumber(value) ?? 0;
}

/**
 * Maps one row, field by field. Deliberately NOT a spread: a column added to the RPC
 * later must be admitted here consciously before it can reach a page.
 */
function toResult(row: CampaignResultRpcRow): CampaignResult | null {
  const campaignId = optionalText(row.campaign_id);
  const campaignVersionId = optionalText(row.campaign_version_id);
  const outcome = optionalText(row.outcome);

  // Without an identity or an outcome the row cannot be grouped or labelled, and a
  // half-rendered campaign card is worse than a missing one.
  if (campaignId === null || campaignVersionId === null || outcome === null) {
    return null;
  }

  return {
    campaignId,
    campaignVersionId,
    campaignName: optionalText(row.campaign_name),
    outcome,
    nonQualificationReason: optionalText(row.non_qualification_reason),
    qualifyingItemCount: wholeNumber(row.qualifying_item_count),
    qualifyingUnits: wholeNumber(row.qualifying_units),
    ruleType: optionalText(row.rule_type),
    coinsPerUnit: optionalWholeNumber(row.coins_per_unit),
    thresholdUnits: optionalWholeNumber(row.threshold_units),
    configuredRewardCoins: optionalWholeNumber(row.configured_reward_coins),
    maxRewardCoins: optionalWholeNumber(row.max_reward_coins),
    coinsUncapped: optionalWholeNumber(row.coins_uncapped),
    coinsCappedTo: optionalWholeNumber(row.coins_capped_to),
    rewardCoins: optionalWholeNumber(row.reward_coins),
    awardedAt: optionalText(row.awarded_at),
  };
}

async function resolveReceiptCampaignResults(
  receiptSubmissionId: string,
): Promise<ReceiptCampaignResultsResult> {
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
    supabase.rpc("get_receipt_campaign_results", {
      p_submission_id: receiptSubmissionId,
    }),
  ).catch(() => null);

  // The error object is never bound, inspected or rendered — a PostgREST error names
  // schemas, tables, columns and functions.
  if (result === null || result.error) {
    console.error("receipt-campaign-results: read failed");
    return { status: "unavailable" };
  }

  const rows = (result.data ?? []) as CampaignResultRpcRow[];
  const results: CampaignResult[] = [];
  let dropped = 0;

  for (const row of rows) {
    const mapped = toResult(row);
    if (mapped === null) {
      dropped += 1;
      continue;
    }
    results.push(mapped);
  }

  // A dropped row is a real inconsistency and is logged — but the readable rows are
  // still shown, because hiding a campaign the reviewer earned would be worse.
  if (dropped > 0) {
    console.error(
      `receipt-campaign-results: ${dropped} row(s) were unusable and were not displayed`,
    );
  }

  return { status: "authorized", results };
}

/** Request-scoped React `cache` only. Never a persistent, cross-user cache. */
export const getReceiptCampaignResults = cache(resolveReceiptCampaignResults);
