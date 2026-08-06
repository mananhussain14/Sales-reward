/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * The closed vocabularies a campaign is built from, and the ONE place each backend enum
 * becomes a phrase a person reads. Free of side effects so ./campaign-vocabulary.test.ts
 * can exercise it directly.
 *
 * WHY THE LISTS LIVE HERE AND NOWHERE ELSE. Every value below is constrained by a CHECK
 * in supabase/migrations/20260815090000_vendor_campaign_foundation.sql. These arrays are
 * a TYPE-LEVEL MIRROR of those constraints, not a second definition of them: the database
 * refuses anything outside its own list regardless of what this file says, and the
 * normalizer treats an unrecognized value as drift and fails the read rather than
 * rendering an unknown badge — or, worse, defaulting into a state that offers an action.
 *
 * NO REWARD IS EVER COMPUTED HERE. The label helpers describe what a campaign OFFERS —
 * "5 coins per unit", "100 coins at 10 units". Nothing in this file multiplies a rate by
 * a quantity, accumulates a total, or states what anybody has earned: progress,
 * balances and coin credits are a later milestone and are absent by design.
 */

/* ---------------------------------------------------------------------------
 * Audience
 * ------------------------------------------------------------------------- */

export const AUDIENCE_MODES = [
  "ALL_RETAILERS",
  "SELECTED_RETAILERS",
  "RETAILER_GROUPS",
] as const;
export type AudienceMode = (typeof AUDIENCE_MODES)[number];

export function isAudienceMode(value: unknown): value is AudienceMode {
  return typeof value === "string" && (AUDIENCE_MODES as readonly string[]).includes(value);
}

const AUDIENCE_LABELS: Record<AudienceMode, string> = {
  ALL_RETAILERS: "All Retailers",
  SELECTED_RETAILERS: "Selected Retailers",
  RETAILER_GROUPS: "Retailer groups",
};

export function audienceLabel(mode: AudienceMode): string {
  return AUDIENCE_LABELS[mode];
}

/* ---------------------------------------------------------------------------
 * Performance scope
 *
 * The distinction the requirement insists on: this is HOW performance is measured, and
 * has nothing to do with whether a Retailer GROUP was used to choose the audience. The
 * two are independent settings and the wording keeps them apart — "Retailer team", never
 * "group campaign".
 * ------------------------------------------------------------------------- */

export const PERFORMANCE_SCOPES = ["INDIVIDUAL_STAFF", "RETAILER_TEAM"] as const;
export type PerformanceScope = (typeof PERFORMANCE_SCOPES)[number];

export function isPerformanceScope(value: unknown): value is PerformanceScope {
  return (
    typeof value === "string" && (PERFORMANCE_SCOPES as readonly string[]).includes(value)
  );
}

const PERFORMANCE_LABELS: Record<PerformanceScope, string> = {
  INDIVIDUAL_STAFF: "Individual",
  RETAILER_TEAM: "Retailer team",
};

export function performanceLabel(scope: PerformanceScope): string {
  return PERFORMANCE_LABELS[scope];
}

/**
 * The sentence a Retailer Owner and a Sales Staff member must see on a team campaign,
 * stated once so every surface says it identically.
 *
 * It is worded to make the per-Retailer boundary explicit: a team total is this
 * Retailer's, and no other Retailer's sales join it. That is also exactly what the
 * eligibility snapshot enforces — one row per Retailer, so a total cannot span two.
 */
export const RETAILER_TEAM_EXPLANATION =
  "All eligible Sales Staff sales in this Retailer contribute to the shared Retailer target.";

export const INDIVIDUAL_STAFF_EXPLANATION =
  "Each Sales Staff member is measured on their own eligible sales.";

export function performanceExplanation(scope: PerformanceScope): string {
  return scope === "RETAILER_TEAM"
    ? RETAILER_TEAM_EXPLANATION
    : INDIVIDUAL_STAFF_EXPLANATION;
}

/* ---------------------------------------------------------------------------
 * Product scope
 * ------------------------------------------------------------------------- */

export const PRODUCT_SCOPES = ["ALL_ELIGIBLE_PRODUCTS", "SELECTED_PRODUCTS"] as const;
export type ProductScope = (typeof PRODUCT_SCOPES)[number];

export function isProductScope(value: unknown): value is ProductScope {
  return typeof value === "string" && (PRODUCT_SCOPES as readonly string[]).includes(value);
}

const PRODUCT_SCOPE_LABELS: Record<ProductScope, string> = {
  ALL_ELIGIBLE_PRODUCTS: "All eligible products",
  SELECTED_PRODUCTS: "Selected products",
};

export function productScopeLabel(scope: ProductScope): string {
  return PRODUCT_SCOPE_LABELS[scope];
}

/* ---------------------------------------------------------------------------
 * Product eligibility resolution
 *
 * HOW a product scope is resolved, as opposed to WHAT it selects. The database stores it
 * explicitly on the version row and pairs it with the scope under a CHECK constraint, so
 * these two values are not independent settings — they are the resolution each scope
 * implies, surfaced so no screen has to infer it.
 * ------------------------------------------------------------------------- */

export const PRODUCT_ELIGIBILITY_RESOLUTIONS = ["SNAPSHOT", "LIVE_TEMPORAL"] as const;
export type ProductEligibilityResolution =
  (typeof PRODUCT_ELIGIBILITY_RESOLUTIONS)[number];

export function isProductEligibilityResolution(
  value: unknown,
): value is ProductEligibilityResolution {
  return (
    typeof value === "string" &&
    (PRODUCT_ELIGIBILITY_RESOLUTIONS as readonly string[]).includes(value)
  );
}

/**
 * The sentence that tells a reader which of the two behaviours applies.
 *
 * These are the distinction the requirement insists on making visible, worded once here so
 * a Vendor screen and a Retailer screen cannot describe the same campaign differently:
 *
 *   LIVE_TEMPORAL  — the product set moves with the catalogue, and each sale is judged
 *                    against the moment it happened.
 *   SNAPSHOT       — the product set was fixed at publication and cannot move.
 */
const RESOLUTION_EXPLANATIONS: Record<ProductEligibilityResolution, string> = {
  LIVE_TEMPORAL:
    "All products eligible at the time of each verified sale. Products your Vendor assigns later will count for later sales; products withdrawn will stop counting from that point.",
  SNAPSHOT:
    "Only the selected products frozen when this campaign version was published. Later product-assignment changes do not affect it.",
};

export function productResolutionExplanation(
  resolution: ProductEligibilityResolution,
): string {
  return RESOLUTION_EXPLANATIONS[resolution];
}

/** A short badge-sized label for the same distinction. */
const RESOLUTION_LABELS: Record<ProductEligibilityResolution, string> = {
  LIVE_TEMPORAL: "Eligible at time of sale",
  SNAPSHOT: "Frozen at publication",
};

export function productResolutionLabel(
  resolution: ProductEligibilityResolution,
): string {
  return RESOLUTION_LABELS[resolution];
}

/* ---------------------------------------------------------------------------
 * Stacking
 * ------------------------------------------------------------------------- */

export const STACKING_MODES = ["STACKABLE", "EXCLUSIVE"] as const;
export type StackingMode = (typeof STACKING_MODES)[number];

export function isStackingMode(value: unknown): value is StackingMode {
  return typeof value === "string" && (STACKING_MODES as readonly string[]).includes(value);
}

const STACKING_LABELS: Record<StackingMode, string> = {
  STACKABLE: "Stackable",
  EXCLUSIVE: "Exclusive",
};

export function stackingLabel(mode: StackingMode): string {
  return STACKING_LABELS[mode];
}

/**
 * What stacking means to a reader who is not configuring it.
 *
 * The EXCLUSIVE wording deliberately does NOT name the exclusivity key or the priority.
 * Those are the Vendor's configuration for how its own campaigns compete, no
 * assigned-visibility RPC returns them, and describing the ranking to a Retailer would
 * disclose the shape of a campaign portfolio they cannot see.
 */
const STACKING_EXPLANATIONS: Record<StackingMode, string> = {
  STACKABLE: "This campaign can reward alongside other campaigns.",
  EXCLUSIVE: "This campaign does not combine with other exclusive campaigns.",
};

export function stackingExplanation(mode: StackingMode): string {
  return STACKING_EXPLANATIONS[mode];
}

/* ---------------------------------------------------------------------------
 * Reward rule
 * ------------------------------------------------------------------------- */

export const RULE_TYPES = ["PER_UNIT_COINS", "TARGET_BONUS"] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export function isRuleType(value: unknown): value is RuleType {
  return typeof value === "string" && (RULE_TYPES as readonly string[]).includes(value);
}

/**
 * Exhaustive: campaign_rules_metric_allowed permits exactly this. There is deliberately
 * no percentage-of-value metric — the rounding, currency and reversal decisions behind
 * one have not been made, and admitting the vocabulary before they are would be a promise
 * the schema cannot keep.
 */
export const METRIC_TYPES = ["UNITS_SOLD"] as const;
export type MetricType = (typeof METRIC_TYPES)[number];

export function isMetricType(value: unknown): value is MetricType {
  return typeof value === "string" && (METRIC_TYPES as readonly string[]).includes(value);
}

export const REWARD_RECIPIENT_SCOPES = ["CONTRIBUTING_STAFF"] as const;
export type RewardRecipientScope = (typeof REWARD_RECIPIENT_SCOPES)[number];

export function isRewardRecipientScope(value: unknown): value is RewardRecipientScope {
  return (
    typeof value === "string" &&
    (REWARD_RECIPIENT_SCOPES as readonly string[]).includes(value)
  );
}

/* ---------------------------------------------------------------------------
 * Derived state
 * ------------------------------------------------------------------------- */

/**
 * The effective-time state, computed IN SQL by public.campaign_derived_state() and never
 * recomputed here.
 *
 * Deriving it a second time in TypeScript would be a second definition of the rule, free
 * to disagree with the database about what "active" means the moment a clock or a
 * precedence changed. The client renders what it is told.
 */
export const CAMPAIGN_STATES = [
  "DRAFT",
  "SCHEDULED",
  "ACTIVE",
  "PAUSED",
  "ENDED",
  "CANCELLED",
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];

export function isCampaignState(value: unknown): value is CampaignState {
  return typeof value === "string" && (CAMPAIGN_STATES as readonly string[]).includes(value);
}

/** The persisted management status a human writes. Distinct from the derived state. */
export const CAMPAIGN_STATUSES = ["DRAFT", "PUBLISHED", "PAUSED", "CANCELLED"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export function isCampaignStatus(value: unknown): value is CampaignStatus {
  return (
    typeof value === "string" && (CAMPAIGN_STATUSES as readonly string[]).includes(value)
  );
}

export const GROUP_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

export function isGroupStatus(value: unknown): value is GroupStatus {
  return typeof value === "string" && (GROUP_STATUSES as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------------------
 * Coin bounds
 * ------------------------------------------------------------------------- */

/**
 * The largest coin amount any campaign field may hold: 1,000,000,000.
 *
 * A MIRROR of campaign_rules_rate_within_ceiling / campaign_rules_cap_within_ceiling /
 * campaign_rule_tiers_reward_within_ceiling, not a second opinion — the database refuses
 * anything above this regardless of what the browser sends, and campaign_apply_draft_config
 * refuses it again with a message an operator can act on.
 *
 * The bound exists so a future reward engine's rate x quantity cannot overflow bigint:
 * 1e9 x 2,147,483,647 (integer max) = 2.147e18, comfortably below bigint's 9.223e18. It is
 * also far below Number.MAX_SAFE_INTEGER, so every value in range survives JSON transport
 * and JavaScript arithmetic exactly.
 */
export const MAX_CAMPAIGN_COINS = 1_000_000_000;

/** The smallest coin amount any campaign field may hold. */
export const MIN_CAMPAIGN_COINS = 1;

/* ---------------------------------------------------------------------------
 * Reward summaries
 * ------------------------------------------------------------------------- */

/**
 * The reward a campaign OFFERS, as one short phrase.
 *
 * `coins` values arrive as integers from bigint columns and are formatted, never
 * arithmetic'd: this function does not multiply the rate by anything, does not add a cap
 * to a total, and returns nothing that could be mistaken for an amount already earned.
 *
 * Returns null when the rule is absent, which is possible only for a malformed row — the
 * caller renders a neutral dash rather than inventing a reward.
 */
export function rewardSummary(rule: {
  ruleType: RuleType | null;
  coinsPerUnit: number | null;
  thresholdUnits: number | null;
  rewardCoins: number | null;
  maxRewardCoins: number | null;
}): string | null {
  if (rule.ruleType === "PER_UNIT_COINS") {
    if (rule.coinsPerUnit === null) return null;
    const base = `${formatCoins(rule.coinsPerUnit)} per unit`;
    return rule.maxRewardCoins === null
      ? base
      : `${base}, up to ${formatCoins(rule.maxRewardCoins)}`;
  }

  if (rule.ruleType === "TARGET_BONUS") {
    if (rule.thresholdUnits === null || rule.rewardCoins === null) return null;
    return `${formatCoins(rule.rewardCoins)} at ${formatUnits(rule.thresholdUnits)}`;
  }

  return null;
}

/* ---------------------------------------------------------------------------
 * Plain-language labels for the configuration screens
 *
 * The short labels above are what a BADGE or a table cell shows. The ones below are what
 * a person CHOOSING between two options needs: a full phrase that states the effect
 * rather than naming the setting. Both describe the same enum, so they live together and
 * cannot drift apart.
 * ------------------------------------------------------------------------- */

const PRODUCT_SCOPE_PLAIN: Record<ProductScope, string> = {
  ALL_ELIGIBLE_PRODUCTS: "Products eligible at the time of each verified sale",
  SELECTED_PRODUCTS: "Only the products selected for this campaign version",
};

export function productScopePlainLabel(scope: ProductScope): string {
  return PRODUCT_SCOPE_PLAIN[scope];
}

const PERFORMANCE_PLAIN: Record<PerformanceScope, string> = {
  INDIVIDUAL_STAFF: "Individual Sales Staff",
  RETAILER_TEAM: "Retailer team",
};

export function performancePlainLabel(scope: PerformanceScope): string {
  return PERFORMANCE_PLAIN[scope];
}

/**
 * The point a team campaign is most often misread on: a shared target is shared WITHIN
 * one Retailer, never across the campaign's whole audience. Stated as its own sentence so
 * the configuration screen can show it next to the choice rather than burying it.
 */
export const RETAILER_TEAM_INDEPENDENCE =
  "Each Retailer is evaluated on its own. Sales from different Retailers are never added together into one combined target.";

const RULE_TYPE_LABELS: Record<RuleType, string> = {
  PER_UNIT_COINS: "Coins per unit",
  TARGET_BONUS: "Target bonus",
};

export function ruleTypeLabel(rule: RuleType): string {
  return RULE_TYPE_LABELS[rule];
}

const RULE_TYPE_EXPLANATIONS: Record<RuleType, string> = {
  PER_UNIT_COINS: "A fixed number of coins for every eligible unit sold.",
  TARGET_BONUS: "A one-off bonus once a unit target is reached.",
};

export function ruleTypeExplanation(rule: RuleType): string {
  return RULE_TYPE_EXPLANATIONS[rule];
}

/**
 * The honest statement that nothing in this milestone computes a result.
 *
 * One constant, used by every surface that shows a reward, so no screen can imply the
 * calculation exists while another says it does not.
 */
export const CALCULATION_ENGINE_NOTICE =
  "Campaign results and coin calculation will appear when the calculation engine is connected.";

/* ---------------------------------------------------------------------------
 * Reward preview
 * ------------------------------------------------------------------------- */

/**
 * A full sentence describing what the configured rule OFFERS, for the reward step.
 *
 * Distinct from rewardSummary(), which is a fragment for a table cell. This is the
 * sentence an operator reads back to check they configured what they meant, and it is
 * worded for the chosen performance scope — "each Sales Staff member" against an
 * individual campaign, "this Retailer" against a team one.
 *
 * STILL NOT A CALCULATION. It formats the configured numbers and nothing else: no rate is
 * multiplied by a quantity and no total is accumulated. Returns null while the rule is
 * incomplete, so the caller shows guidance instead of a half-sentence.
 */
export function rewardPreviewSentence(rule: {
  ruleType: RuleType | null;
  performanceScope: PerformanceScope | null;
  coinsPerUnit: number | null;
  thresholdUnits: number | null;
  rewardCoins: number | null;
  maxRewardCoins: number | null;
}): string | null {
  const team = rule.performanceScope === "RETAILER_TEAM";

  if (rule.ruleType === "PER_UNIT_COINS") {
    if (rule.coinsPerUnit === null || rule.coinsPerUnit <= 0) return null;
    const earner = team
      ? "Every eligible sale in this Retailer earns"
      : "Each Sales Staff member earns";
    const base = `${earner} ${formatCoins(rule.coinsPerUnit)} per eligible unit`;
    return rule.maxRewardCoins === null || rule.maxRewardCoins <= 0
      ? `${base}.`
      : `${base}, up to ${formatCoins(rule.maxRewardCoins)}.`;
  }

  if (rule.ruleType === "TARGET_BONUS") {
    if (
      rule.thresholdUnits === null ||
      rule.thresholdUnits <= 0 ||
      rule.rewardCoins === null ||
      rule.rewardCoins <= 0
    ) {
      return null;
    }
    const base = team
      ? `When this Retailer reaches ${formatUnits(rule.thresholdUnits)}, contributing Sales Staff share the configured ${formatCoins(rule.rewardCoins)} reward according to the campaign rules`
      : `When a Sales Staff member reaches ${formatUnits(rule.thresholdUnits)}, they earn ${formatCoins(rule.rewardCoins)}`;
    return rule.maxRewardCoins === null || rule.maxRewardCoins <= 0
      ? `${base}.`
      : `${base}, up to ${formatCoins(rule.maxRewardCoins)} for the campaign.`;
  }

  return null;
}

/* ---------------------------------------------------------------------------
 * Publication eligibility outcome
 *
 * WHAT THE DATABASE ACTUALLY DOES, worded once.
 *
 * public.publish_vendor_campaign freezes one row per (eligible Retailer, assigned
 * product) pair and refuses the whole publication ONLY when that set is empty. So a
 * campaign where SOME Retailers are missing SOME products publishes successfully, and the
 * Retailers that matched nothing are still in the audience with no eligible product at
 * all — which is the fact an operator actually needs, and the one the previous wording
 * left out.
 * ------------------------------------------------------------------------- */

export type PublicationEligibility = "CLEAR" | "PARTIAL" | "BLOCKED";

/**
 * Classifies a publication preview.
 *
 * `BLOCKED` when no targeted Retailer has a single selected product assigned — the
 * database refuses that publication outright. `PARTIAL` when at least one Retailer
 * resolves to nothing while at least one other does resolve. `CLEAR` otherwise.
 *
 * An empty preview is CLEAR, not BLOCKED: a campaign with no rows has a different problem
 * (no eligible Retailer at all) which the publish RPC reports on its own.
 */
export function classifyPublicationEligibility(
  rows: { eligibleProductCount: number; missingProductCount: number }[],
  productScope: ProductScope | null,
): PublicationEligibility {
  // Only a SELECTED_PRODUCTS campaign freezes pairs, so only it can be blocked this way.
  if (productScope !== "SELECTED_PRODUCTS" || rows.length === 0) return "CLEAR";

  const totalEligible = rows.reduce((sum, row) => sum + row.eligibleProductCount, 0);
  if (totalEligible === 0) return "BLOCKED";

  return rows.some((row) => row.missingProductCount > 0) ? "PARTIAL" : "CLEAR";
}

const PUBLICATION_ELIGIBILITY_COPY: Record<
  PublicationEligibility,
  { title: string; body: string } | null
> = {
  CLEAR: null,
  PARTIAL: {
    title: "Some Retailers will get fewer products than you selected",
    body: "This campaign can still be published. Each Retailer only ever counts the selected products actually assigned to it, and a Retailer with none of them will be part of the campaign without a single eligible product — so nothing there can earn coins.",
  },
  BLOCKED: {
    title: "This campaign cannot be published yet",
    body: "None of the selected products is assigned to any of the targeted Retailers, so there is nothing for the campaign to reward. Assign the products to these Retailers, choose different products, or change the audience.",
  },
};

export function publicationEligibilityCopy(
  eligibility: PublicationEligibility,
): { title: string; body: string } | null {
  return PUBLICATION_ELIGIBILITY_COPY[eligibility];
}

/** "1 coin" / "5 coins". Grouped with a locale-independent separator for stability. */
export function formatCoins(coins: number): string {
  return `${groupDigits(coins)} ${coins === 1 ? "coin" : "coins"}`;
}

/** "1 unit" / "10 units". */
export function formatUnits(units: number): string {
  return `${groupDigits(units)} ${units === 1 ? "unit" : "units"}`;
}

/**
 * Thousands separators, applied by hand rather than through toLocaleString().
 *
 * The server and the browser can resolve a different default locale for the same render,
 * and a number that changes shape during hydration is a React mismatch. A fixed comma is
 * stable in both places.
 */
function groupDigits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const whole = Math.trunc(Math.abs(value)).toString();
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return value < 0 ? `-${grouped}` : grouped;
}
