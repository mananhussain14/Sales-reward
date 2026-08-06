/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * The row shapes of the three Migration 70 Sales Staff reads, normalized from the
 * `unknown` PostgREST hands back into types the pages can render. Separated from the
 * server-only adapters (./staff-earnings.ts) so every rule here can be unit-tested by
 * CALLING it, exactly as lib/campaigns/campaign-normalization.ts is.
 *
 * ============================================================================
 * THESE ARE STORED FACTS. NOTHING HERE COMPUTES A REWARD.
 * ============================================================================
 * Every coin figure below was written by campaign_apply_reward_for_evaluation at award
 * time and is carried through untouched. This module does not multiply units by a rate,
 * does not apply a cap, does not decide whether a target was crossed and does not total
 * anything the database did not already total. A number that disagreed with the ledger
 * of record would be worse than no number at all.
 *
 * The ONE arithmetic function here is `capReduction`, and it subtracts two values the
 * database stored on the SAME row purely to label a difference the reviewer can already
 * see. It reconstructs nothing.
 *
 * ============================================================================
 * EARNED IS NOT A BALANCE
 * ============================================================================
 * No type in this file has a field named balance, wallet, available, redeemable, payable
 * or settled, and none may gain one. There is no ledger and no redemption model in the
 * schema; a "balance" rendered here would be an invention.
 */

/* ---------------------------------------------------------------------------
 * Field readers — identical rules to lib/campaigns/campaign-normalization.ts
 * ------------------------------------------------------------------------- */

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Lower-cased so two spellings of one UUID are one React key and one URL value. */
function requiredId(value: unknown): string | null {
  const text = requiredText(value);
  return text === null ? null : text.toLowerCase();
}

/** A timestamptz is carried as the ISO string the database emitted, never re-parsed. */
function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * A non-negative whole number.
 *
 * `bigint` arrives from PostgREST as a number when it fits and a STRING when it does
 * not, so both are accepted — and a value beyond Number.MAX_SAFE_INTEGER is REJECTED
 * rather than silently rounded, because a rounded coin amount is a wrong coin amount and
 * showing one on an earnings screen would be worse than showing nothing.
 */
function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function optionalWholeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return wholeNumber(value);
}

function requiredBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asRecord(row: unknown): Record<string, unknown> | null {
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
}

/* ---------------------------------------------------------------------------
 * Shared vocabulary
 * ------------------------------------------------------------------------- */

export const REWARD_RULE_TYPES = ["PER_UNIT_COINS", "TARGET_BONUS"] as const;
export type RewardRuleType = (typeof REWARD_RULE_TYPES)[number];

export function isRewardRuleType(value: unknown): value is RewardRuleType {
  return (
    typeof value === "string" &&
    (REWARD_RULE_TYPES as readonly string[]).includes(value)
  );
}

export const EARNING_PERFORMANCE_SCOPES = [
  "INDIVIDUAL_STAFF",
  "RETAILER_TEAM",
] as const;
export type EarningPerformanceScope =
  (typeof EARNING_PERFORMANCE_SCOPES)[number];

export function isEarningPerformanceScope(
  value: unknown,
): value is EarningPerformanceScope {
  return (
    typeof value === "string" &&
    (EARNING_PERFORMANCE_SCOPES as readonly string[]).includes(value)
  );
}

/* ---------------------------------------------------------------------------
 * get_my_campaign_rewards — the exact deployed 17 columns
 * ------------------------------------------------------------------------- */

/**
 * One reward the SIGNED-IN seller earned.
 *
 * THERE IS NO `verifiedSaleId` FIELD, and there is none to add: the RPC does not return
 * one. Migration 69 exists to keep that key out of a client, and Migration 70 followed
 * it — a sale is identified here by the RECEIPT the seller themselves submitted.
 *
 * There is likewise no beneficiary, cap subject, accumulator or evaluation id: the row
 * belongs to the caller by construction, because the RPC filters on their own profile
 * and takes no argument that could name anyone.
 */
export type CampaignRewardEntry = {
  rewardId: string;
  campaignId: string;
  campaignVersionId: string;
  campaignName: string | null;
  /** The seller's own receipt. Never a verified sale id. */
  receiptSubmissionId: string;
  shopName: string | null;
  saleAt: string | null;
  awardedAt: string;
  ruleType: RewardRuleType | null;
  performanceScope: EarningPerformanceScope | null;
  qualifyingItemCount: number;
  qualifyingUnits: number;
  /** What the rule produced BEFORE any cap. Stored, never recomputed. */
  coinsUncapped: number | null;
  /** The cap ceiling actually applied, or null when no cap bit. Stored. */
  coinsCappedTo: number | null;
  /** The amount actually awarded. The only figure that is the seller's earning. */
  rewardCoins: number;
  thresholdUnits: number | null;
  configuredRewardCoins: number | null;
};

export type RewardEntriesNormalization =
  | { status: "ok"; rewards: CampaignRewardEntry[] }
  | { status: "malformed"; reason: string };

function readRewardEntry(
  record: Record<string, unknown>,
): CampaignRewardEntry | { reason: string } {
  const rewardId = requiredId(record.campaign_reward_id);
  const campaignId = requiredId(record.campaign_id);
  const campaignVersionId = requiredId(record.campaign_version_id);
  const receiptSubmissionId = requiredId(record.receipt_submission_id);
  const awardedAt = optionalTimestamp(record.awarded_at);
  const rewardCoins = wholeNumber(record.reward_coins);
  const qualifyingItemCount = wholeNumber(record.qualifying_item_count);
  const qualifyingUnits = wholeNumber(record.qualifying_units);

  // Without an identity the row cannot be keyed; without an amount or an award instant
  // it cannot be presented as an earning at all. A half-rendered reward is worse than a
  // refused read, because a seller would read the missing half as zero.
  if (rewardId === null) return { reason: "campaign_reward_id" };
  if (campaignId === null) return { reason: "campaign_id" };
  if (campaignVersionId === null) return { reason: "campaign_version_id" };
  if (receiptSubmissionId === null) return { reason: "receipt_submission_id" };
  if (awardedAt === null) return { reason: "awarded_at" };
  if (rewardCoins === null) return { reason: "reward_coins" };
  if (qualifyingItemCount === null) return { reason: "qualifying_item_count" };
  if (qualifyingUnits === null) return { reason: "qualifying_units" };

  // Present but unrecognized is DRIFT and is refused rather than rendered under a
  // wrong label. Absent is legitimate and stays null.
  const ruleType = record.rule_type;
  if (ruleType !== null && ruleType !== undefined && !isRewardRuleType(ruleType)) {
    return { reason: "rule_type" };
  }

  const scope = record.performance_scope;
  if (scope !== null && scope !== undefined && !isEarningPerformanceScope(scope)) {
    return { reason: "performance_scope" };
  }

  return {
    rewardId,
    campaignId,
    campaignVersionId,
    campaignName: optionalText(record.campaign_name),
    receiptSubmissionId,
    shopName: optionalText(record.shop_name),
    saleAt: optionalTimestamp(record.sale_at),
    awardedAt,
    ruleType: isRewardRuleType(ruleType) ? ruleType : null,
    performanceScope: isEarningPerformanceScope(scope) ? scope : null,
    qualifyingItemCount,
    qualifyingUnits,
    coinsUncapped: optionalWholeNumber(record.coins_uncapped),
    coinsCappedTo: optionalWholeNumber(record.coins_capped_to),
    rewardCoins,
    thresholdUnits: optionalWholeNumber(record.threshold_units),
    configuredRewardCoins: optionalWholeNumber(record.configured_reward_coins),
  };
}

export function normalizeRewardEntries(
  data: unknown,
): RewardEntriesNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const rewards: CampaignRewardEntry[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const parsed = readRewardEntry(record);
    if ("reason" in parsed) return { status: "malformed", reason: parsed.reason };
    rewards.push(parsed);
  }

  return { status: "ok", rewards };
}

/* ---------------------------------------------------------------------------
 * get_my_campaign_earnings_summary — the exact deployed 7 columns
 * ------------------------------------------------------------------------- */

/**
 * The seller's own totals.
 *
 * EVERY FIELD IS A SUM THE DATABASE PERFORMED over campaign_rewards rows that already
 * exist. Nothing is subtracted, because there is nothing to subtract from.
 * `totalRewardCoins` is COINS EARNED — not a wallet, not a balance, not an available
 * amount, and the field name says so.
 */
export type EarningsSummary = {
  totalRewardCoins: number;
  currentMonthRewardCoins: number;
  /** DISTINCT sales: two campaigns paying on one sale is one rewarded sale. */
  rewardedSaleCount: number;
  /** DISTINCT campaigns, for the same reason. */
  rewardedCampaignCount: number;
  latestRewardAt: string | null;
  currentMonthStartUtc: string | null;
  currentMonthEndUtc: string | null;
};

export type EarningsSummaryNormalization =
  | { status: "ok"; summary: EarningsSummary }
  /** Zero rows. The RPC returns none for a caller it does not authorize. */
  | { status: "not-found" }
  | { status: "malformed"; reason: string };

export function normalizeEarningsSummary(
  data: unknown,
): EarningsSummaryNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };
  if (data.length === 0) return { status: "not-found" };

  const record = asRecord(data[0]);
  if (record === null) return { status: "malformed", reason: "row-not-an-object" };

  const totalRewardCoins = wholeNumber(record.total_reward_coins);
  const currentMonthRewardCoins = wholeNumber(record.current_month_reward_coins);
  const rewardedSaleCount = wholeNumber(record.rewarded_sale_count);
  const rewardedCampaignCount = wholeNumber(record.rewarded_campaign_count);

  // A seller with no rewards reads 0 from SQL, never NULL — so a null here is drift,
  // not an empty history, and is refused rather than displayed as a zero that might be
  // wrong.
  if (totalRewardCoins === null) return { status: "malformed", reason: "total_reward_coins" };
  if (currentMonthRewardCoins === null) {
    return { status: "malformed", reason: "current_month_reward_coins" };
  }
  if (rewardedSaleCount === null) {
    return { status: "malformed", reason: "rewarded_sale_count" };
  }
  if (rewardedCampaignCount === null) {
    return { status: "malformed", reason: "rewarded_campaign_count" };
  }

  return {
    status: "ok",
    summary: {
      totalRewardCoins,
      currentMonthRewardCoins,
      rewardedSaleCount,
      rewardedCampaignCount,
      latestRewardAt: optionalTimestamp(record.latest_reward_at),
      currentMonthStartUtc: optionalTimestamp(record.current_month_start_utc),
      currentMonthEndUtc: optionalTimestamp(record.current_month_end_utc),
    },
  };
}

/* ---------------------------------------------------------------------------
 * get_my_campaign_target_progress — the exact deployed 9 columns
 * ------------------------------------------------------------------------- */

/**
 * Progress towards one TARGET_BONUS campaign's threshold.
 *
 * ============================================================================
 * NORMALIZED, NEVER RAW
 * ============================================================================
 * There is no `capSubjectType`, no `capSubjectId`, no accumulator coin total and no
 * accumulator target flag on this type, because the RPC returns none of them. Under
 * RETAILER_TEAM the accumulator's own flag reads true for the whole Retailer once ANY
 * member crosses; `bonusAwardedToMe` is instead reconstructed in SQL from the existence
 * of a reward whose beneficiary is the caller, which is the only question a seller is
 * actually asking.
 *
 * `progressUnits` under RETAILER_TEAM is the TEAM's units, not the caller's. Nothing in
 * this type distinguishes the caller's own contribution, so nothing rendered from it may
 * claim to — see teamProgress() in ./earnings-presentation.ts.
 */
export type CampaignTargetProgress = {
  campaignId: string;
  campaignVersionId: string;
  campaignName: string | null;
  performanceScope: EarningPerformanceScope;
  targetUnits: number;
  configuredRewardCoins: number | null;
  /** The subject's units. Under RETAILER_TEAM this is the whole team's. */
  progressUnits: number;
  targetReached: boolean;
  /** True only when a TARGET_BONUS reward exists for THIS caller. */
  bonusAwardedToMe: boolean;
};

export type TargetProgressNormalization =
  | { status: "ok"; progress: CampaignTargetProgress[] }
  | { status: "malformed"; reason: string };

function readTargetProgress(
  record: Record<string, unknown>,
): CampaignTargetProgress | { reason: string } {
  const campaignId = requiredId(record.campaign_id);
  const campaignVersionId = requiredId(record.campaign_version_id);
  const targetUnits = wholeNumber(record.target_units);
  const progressUnits = wholeNumber(record.progress_units);
  const targetReached = requiredBoolean(record.target_reached);
  const bonusAwardedToMe = requiredBoolean(record.bonus_awarded_to_me);

  if (campaignId === null) return { reason: "campaign_id" };
  if (campaignVersionId === null) return { reason: "campaign_version_id" };
  if (!isEarningPerformanceScope(record.performance_scope)) {
    return { reason: "performance_scope" };
  }
  if (targetUnits === null) return { reason: "target_units" };
  if (progressUnits === null) return { reason: "progress_units" };

  // A missing boolean must never be coerced. `false` would tell a seller who DID earn a
  // bonus that they did not, and `true` would tell one who did not that they did.
  if (targetReached === null) return { reason: "target_reached" };
  if (bonusAwardedToMe === null) return { reason: "bonus_awarded_to_me" };

  return {
    campaignId,
    campaignVersionId,
    campaignName: optionalText(record.campaign_name),
    performanceScope: record.performance_scope,
    targetUnits,
    configuredRewardCoins: optionalWholeNumber(record.configured_reward_coins),
    progressUnits,
    targetReached,
    bonusAwardedToMe,
  };
}

export function normalizeTargetProgress(
  data: unknown,
): TargetProgressNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const progress: CampaignTargetProgress[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const parsed = readTargetProgress(record);
    if ("reason" in parsed) return { status: "malformed", reason: parsed.reason };
    progress.push(parsed);
  }

  return { status: "ok", progress };
}
