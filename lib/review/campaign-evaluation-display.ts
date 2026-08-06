/**
 * Reading a campaign evaluation — the pure half of Phase 2A-F.
 *
 * NO React, NO Supabase, NO `server-only`. Every rule here is a function a test can
 * call, which is the point: the panel is a Client Component and the adapters are
 * server-only, so anything that can be a pure function is one.
 *
 * ============================================================================
 * NOTHING IN THIS FILE COMPUTES A REWARD
 * ============================================================================
 * Every coin value displayed comes from `get_receipt_campaign_results`, which reads
 * the immutable `campaign_rewards` row Migration 67 wrote. There is no rate here, no
 * multiplication, no cap subtraction and no threshold comparison — the browser is
 * shown what was stored, never a second opinion about it. `capReduction` looks like
 * arithmetic and is not: it is the DIFFERENCE between two stored values, used only to
 * label a reduction the database already applied.
 *
 * ============================================================================
 * A ZERO-ROW READ IS AMBIGUOUS, AND THE UI MUST NOT PRETEND OTHERWISE
 * ============================================================================
 * `get_receipt_campaign_results` returns zero rows for a sale nobody has evaluated
 * AND for one that was evaluated and matched no campaign. The reads cannot tell those
 * apart, because the database stores nothing in either case — and deliberately so:
 * Migration 68 refused to add an execution-history table for it.
 *
 * So the distinction lives in the ACTION RESULT, not in the read. `panelState` takes
 * both and only reports `zero-campaigns` once an execution in this interaction has
 * said so. Before that it reports `ready`, which is honest: we do not know.
 */

/* ---------------------------------------------------------------------------
 * Vocabularies, as the database defines them
 * ------------------------------------------------------------------------- */

export const CAMPAIGN_OUTCOMES = [
  "QUALIFIED",
  "NOT_QUALIFIED",
  "NOT_EVALUABLE",
] as const;
export type CampaignOutcome = (typeof CAMPAIGN_OUTCOMES)[number];

export function isCampaignOutcome(value: unknown): value is CampaignOutcome {
  return (
    typeof value === "string" &&
    (CAMPAIGN_OUTCOMES as readonly string[]).includes(value)
  );
}

const OUTCOME_LABELS: Record<CampaignOutcome, string> = {
  QUALIFIED: "Qualified",
  NOT_QUALIFIED: "Not qualified",
  NOT_EVALUABLE: "Not evaluable",
};

/**
 * A readable outcome, and never a raw underscored token.
 *
 * An unrecognized value cannot crash a page and must not be printed either: a future
 * database vocabulary would otherwise leak an internal token into the UI. The caller
 * logs the raw value server-side; the reviewer sees a neutral sentence.
 */
export function outcomeLabel(outcome: string | null): string {
  return isCampaignOutcome(outcome) ? OUTCOME_LABELS[outcome] : "Result recorded";
}

/** Badge tone. The WORD carries the meaning; tone only reinforces it. */
export function outcomeTone(
  outcome: string | null,
): "emerald" | "slate" | "amber" {
  if (outcome === "QUALIFIED") return "emerald";
  if (outcome === "NOT_EVALUABLE") return "amber";
  return "slate";
}

const REASON_LABELS: Record<string, string> = {
  NO_QUALIFYING_ITEMS:
    "No products on this sale qualified for the campaign.",
  SUPPRESSED_BY_EXCLUSIVITY:
    "Another exclusive campaign had higher priority for this sale.",
  NO_TEMPORAL_RECORD:
    "Historical campaign or product eligibility data was unavailable for the sale time.",
  // Reserved by campaign_sale_evaluations_reason_allowed. Unreachable for a stored
  // row today — Migration 65 refuses evidence for an excluded receipt — but mapped
  // so it could never render as a raw token if that ever changes.
  EXCLUDED: "This receipt is excluded from campaign qualification.",
  CAMPAIGN_NOT_IN_FORCE: "The campaign was not in force for this sale.",
  RETAILER_NOT_TARGETED: "This Retailer was not targeted by the campaign.",
  PRODUCT_NOT_ELIGIBLE: "No eligible product was found for the campaign.",
};

/** `null` for no reason at all; a safe sentence for an unrecognized one. */
export function reasonLabel(reason: string | null): string | null {
  if (reason === null || reason.trim() === "") return null;
  return REASON_LABELS[reason] ?? "This campaign did not produce a reward.";
}

const RULE_TYPE_LABELS: Record<string, string> = {
  PER_UNIT_COINS: "Coins per unit",
  TARGET_BONUS: "Target bonus",
};

export function ruleTypeLabel(ruleType: string | null): string | null {
  if (ruleType === null || ruleType.trim() === "") return null;
  return RULE_TYPE_LABELS[ruleType] ?? "Reward rule";
}

const SOURCE_LABELS: Record<string, string> = {
  SNAPSHOT: "Published campaign product selection",
  LIVE_TEMPORAL: "Eligible at sale time",
};

export function productSourceLabel(source: string | null): string {
  if (source === null || source.trim() === "") return "Eligibility not recorded";
  return SOURCE_LABELS[source] ?? "Eligibility recorded";
}

/** ACTIVE / INACTIVE at the sale instant. Only ever present for LIVE_TEMPORAL. */
export function saleTimeStatusLabel(status: string | null): string | null {
  if (status === null || status.trim() === "") return null;
  if (status === "ACTIVE") return "Active";
  if (status === "INACTIVE") return "Inactive";
  return "Recorded";
}

/* ---------------------------------------------------------------------------
 * The shapes the adapters produce
 * ------------------------------------------------------------------------- */

/** One stored campaign result. Coin values are whole numbers or `null`. */
export type CampaignResult = {
  campaignId: string;
  campaignVersionId: string;
  campaignName: string | null;
  outcome: string;
  nonQualificationReason: string | null;
  qualifyingItemCount: number;
  qualifyingUnits: number;
  ruleType: string | null;
  coinsPerUnit: number | null;
  thresholdUnits: number | null;
  configuredRewardCoins: number | null;
  maxRewardCoins: number | null;
  coinsUncapped: number | null;
  coinsCappedTo: number | null;
  rewardCoins: number | null;
  awardedAt: string | null;
};

export type CampaignQualifyingItem = {
  campaignId: string;
  campaignVersionId: string;
  verifiedSaleItemId: string;
  vendorProductId: string;
  productCodeAtProposal: string | null;
  productNameAtProposal: string | null;
  lineNumber: number | null;
  qualifyingUnits: number;
  productSource: string | null;
  productStatusAtSale: string | null;
  assignmentStatusAtSale: string | null;
};

/** One row of the execution RPC, already mapped. */
export type CampaignEvaluationRow = {
  campaignId: string;
  campaignVersionId: string;
  outcome: string;
  nonQualificationReason: string | null;
  qualifyingItemCount: number;
  qualifyingUnits: number;
  campaignRewardId: string | null;
  rewardCoins: number | null;
  rewardCreated: boolean;
  evaluationCreated: boolean;
  applicationResult: string | null;
};

/* ---------------------------------------------------------------------------
 * Reward presentation
 * ------------------------------------------------------------------------- */

/**
 * Did the cap reduce this award, and by how much?
 *
 * NOT a calculation of the reward. `coinsCappedTo` is written by Migration 67 ONLY
 * when the cap actually bit (campaign_rewards_capped_range forces it below the
 * uncapped amount), so its presence alone is the signal. The subtraction exists to
 * word the reduction, never to decide the award.
 */
export function capReduction(result: CampaignResult): number | null {
  const { coinsUncapped, coinsCappedTo } = result;
  if (coinsCappedTo === null || coinsUncapped === null) return null;
  if (coinsCappedTo >= coinsUncapped) return null;
  return coinsUncapped - coinsCappedTo;
}

/** True when a stored reward exists for this campaign result. */
export function hasReward(result: CampaignResult): boolean {
  return result.rewardCoins !== null;
}

/**
 * A QUALIFIED campaign with no reward row.
 *
 * Reachable and CORRECT: a TARGET_BONUS sale that counted its units without crossing
 * the threshold creates no reward at all. It must never render as a missing value or
 * an error.
 */
export function isQualifiedWithoutReward(result: CampaignResult): boolean {
  return result.outcome === "QUALIFIED" && !hasReward(result);
}

export const TARGET_BONUS_NOT_AWARDED_MESSAGE =
  "Qualified sale. Target bonus was not awarded on this sale.";

export const CAP_REDUCED_MESSAGE = "Reward reduced by the campaign cap.";

/** Thousands separators only. No currency symbol: coins are not money. */
export function formatCoins(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en-US").format(value);
}

/** An ISO instant as a readable UTC string, or `null` for anything unusable. */
export function formatAwardedAt(value: string | null): string | null {
  if (value === null || value.trim() === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/* ---------------------------------------------------------------------------
 * Grouping items under their campaign
 * ------------------------------------------------------------------------- */

/**
 * The authoritative grouping key.
 *
 * `get_receipt_campaign_qualifying_items` returns no evaluation id, so the stable key
 * is the campaign VERSION — which is what Migration 65's evidence is unique on
 * (campaign_version_id, verified_sale_item_id) and what the results read is keyed by.
 * The campaign NAME is never used: two campaigns may share one, and a rename would
 * silently re-parent evidence.
 */
export function campaignKey(row: {
  campaignId: string;
  campaignVersionId: string;
}): string {
  return `${row.campaignId}:${row.campaignVersionId}`;
}

export type GroupedItems = {
  /** Items keyed by `campaignKey`, in the RPC's own order. */
  byCampaign: Map<string, CampaignQualifyingItem[]>;
  /**
   * Items whose campaign key matches no returned result.
   *
   * Never rendered. Kept so the caller can log the inconsistency rather than attach
   * a product to the wrong campaign — the one failure mode that would be invisible
   * and wrong at the same time.
   */
  unmatched: CampaignQualifyingItem[];
};

/**
 * Groups items under the results they belong to, preserving RPC order.
 *
 * The order is the database's — campaign priority, then receipt line number, then
 * item id — and nothing here re-sorts it. Sorting by a display field would make the
 * list unstable whenever a product was renamed.
 */
export function groupQualifyingItems(
  results: readonly CampaignResult[],
  items: readonly CampaignQualifyingItem[],
): GroupedItems {
  const known = new Set(results.map(campaignKey));
  const byCampaign = new Map<string, CampaignQualifyingItem[]>();
  const unmatched: CampaignQualifyingItem[] = [];

  for (const item of items) {
    const key = campaignKey(item);
    if (!known.has(key)) {
      unmatched.push(item);
      continue;
    }
    const bucket = byCampaign.get(key);
    if (bucket === undefined) {
      byCampaign.set(key, [item]);
    } else {
      bucket.push(item);
    }
  }

  return { byCampaign, unmatched };
}

/**
 * The items to show under one result.
 *
 * Only a QUALIFIED campaign has any: Migration 68 writes item evidence for nothing
 * else, so a NOT_QUALIFIED, NOT_EVALUABLE or exclusivity-suppressed campaign returns
 * an empty list here as well as in the database. Checking BOTH is deliberate — if a
 * future read ever returned a stray row, this would still not render it under a
 * campaign that did not qualify.
 */
export function itemsForResult(
  result: CampaignResult,
  grouped: GroupedItems,
): CampaignQualifyingItem[] {
  if (result.outcome !== "QUALIFIED") return [];
  return grouped.byCampaign.get(campaignKey(result)) ?? [];
}
