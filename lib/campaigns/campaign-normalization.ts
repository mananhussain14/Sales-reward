/**
 * PURE MODULE — no imports beyond ./campaign-vocabulary, no I/O, no `next/headers`, no
 * Supabase client.
 *
 * Where the campaign RPCs' snake_case output becomes the application's camelCase types,
 * and where their runtime shape is validated. Free of side effects so it can be exercised
 * directly by ./campaign-normalization.test.ts.
 *
 * WHY VALIDATE AT ALL. `supabase.rpc()` is untyped in this project (there are no
 * generated database types), so its result is `any`. A type assertion would be a claim
 * about the SQL, not a check of it, and TypeScript erases it at runtime.
 *
 * NOTHING UNSAFE PASSES THROUGH, because nothing unsafe arrives: no assigned-visibility
 * RPC returns an exclusivity key, a priority, an eligibility source, another Retailer's
 * identity, a version number or audit metadata. The mappers below build an explicit
 * ALLOW-LIST rather than spreading the row, so a column added to an RPC later cannot
 * reach the UI without an edit here.
 *
 * A MALFORMED ROW FAILS THE READ. An unrecognized enum value is treated as schema drift,
 * not as a value to render: a campaign whose stacking mode is unknown must not be shown
 * as "Stackable" by default, because that is a claim about how someone will be paid.
 */
import {
  isAudienceMode,
  isCampaignState,
  isCampaignStatus,
  isGroupStatus,
  isMetricType,
  isPerformanceScope,
  isProductScope,
  isRewardRecipientScope,
  isRuleType,
  isStackingMode,
  type AudienceMode,
  type CampaignState,
  type CampaignStatus,
  type GroupStatus,
  type MetricType,
  type PerformanceScope,
  type ProductScope,
  type RewardRecipientScope,
  type RuleType,
  type StackingMode,
} from "./campaign-vocabulary.ts";

/* ---------------------------------------------------------------------------
 * Primitive readers
 * ------------------------------------------------------------------------- */

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** An id is lower-cased so two spellings of one UUID are one React key and one form value. */
function requiredId(value: unknown): string | null {
  const text = requiredText(value);
  return text === null ? null : text.toLowerCase();
}

function optionalId(value: unknown): string | null {
  const text = optionalText(value);
  return text === null ? null : text.toLowerCase();
}

/** A timestamptz is carried as the ISO string the database emitted, never re-parsed. */
function requiredTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * A non-negative whole number. `bigint` arrives from PostgREST as a number when it fits
 * and a STRING when it does not, so both are accepted — and a value beyond
 * Number.MAX_SAFE_INTEGER is rejected rather than silently rounded, because a rounded
 * coin amount is a wrong coin amount.
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
 * The reward rule, shared by every campaign shape
 * ------------------------------------------------------------------------- */

/**
 * The OFFER, never a result. `coinsPerUnit` and `rewardCoins` are what a campaign pays
 * per unit or at its target; nothing here is a running total, and no field on this type
 * can hold one.
 *
 * Every field is nullable because the RPCs LEFT JOIN the rule and its tier: a campaign
 * with no rule is a malformed draft rather than a parse failure, and the UI renders a
 * neutral dash for it.
 */
export type CampaignReward = {
  ruleType: RuleType | null;
  metricType: MetricType | null;
  coinsPerUnit: number | null;
  maxRewardCoins: number | null;
  thresholdUnits: number | null;
  rewardCoins: number | null;
};

function readReward(record: Record<string, unknown>): CampaignReward | "malformed" {
  const ruleType = record.rule_type;
  const metricType = record.metric_type;

  // Absent entirely — the LEFT JOIN found no rule. Not drift.
  if (ruleType === null || ruleType === undefined) {
    return {
      ruleType: null,
      metricType: null,
      coinsPerUnit: null,
      maxRewardCoins: null,
      thresholdUnits: null,
      rewardCoins: null,
    };
  }

  // Present but unrecognized — drift. Refused rather than rendered.
  if (!isRuleType(ruleType)) return "malformed";
  if (metricType !== null && metricType !== undefined && !isMetricType(metricType)) {
    return "malformed";
  }

  return {
    ruleType,
    metricType: isMetricType(metricType) ? metricType : null,
    coinsPerUnit: optionalWholeNumber(record.coins_per_unit),
    maxRewardCoins: optionalWholeNumber(record.max_reward_coins),
    thresholdUnits: optionalWholeNumber(record.threshold_units),
    rewardCoins: optionalWholeNumber(record.reward_coins),
  };
}

/* ---------------------------------------------------------------------------
 * Retailer groups — list_vendor_retailer_groups() / get_vendor_retailer_group(uuid)
 * ------------------------------------------------------------------------- */

export type RetailerGroup = {
  groupId: string;
  name: string;
  description: string | null;
  status: GroupStatus;
  memberCount: number;
  /** How many campaign versions reference this group — the number to show before an edit. */
  campaignRefCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type RetailerGroupsNormalization =
  | { status: "ok"; groups: RetailerGroup[] }
  | { status: "malformed"; reason: string };

export function normalizeRetailerGroups(data: unknown): RetailerGroupsNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const groups: RetailerGroup[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const groupId = requiredId(record.group_id);
    const name = requiredText(record.name);
    const memberCount = wholeNumber(record.member_count);
    const campaignRefCount = wholeNumber(record.campaign_ref_count);

    if (groupId === null) return { status: "malformed", reason: "group_id" };
    if (name === null) return { status: "malformed", reason: "name" };
    if (!isGroupStatus(record.status)) return { status: "malformed", reason: "status" };
    if (memberCount === null) return { status: "malformed", reason: "member_count" };
    if (campaignRefCount === null) {
      return { status: "malformed", reason: "campaign_ref_count" };
    }

    groups.push({
      groupId,
      name,
      description: optionalText(record.description),
      status: record.status,
      memberCount,
      campaignRefCount,
      createdAt: optionalTimestamp(record.created_at),
      updatedAt: optionalTimestamp(record.updated_at),
    });
  }

  return { status: "ok", groups };
}

/* ---------------------------------------------------------------------------
 * Group membership — list_vendor_retailer_group_members(uuid)
 * ------------------------------------------------------------------------- */

/**
 * One Retailer in a group, addressed by the canonical vendor_retailers RELATIONSHIP id —
 * the same identifier the Vendor Retailer list and the lifecycle contract use.
 *
 * `retailerStatus` and `relationshipStatus` are returned so the editor can show that a
 * member has since been suspended: a suspended member stays in the group but will not be
 * resolved into any future publication, and hiding that would make a later eligibility
 * count look like a bug.
 */
export type RetailerGroupMember = {
  vendorRetailerId: string;
  retailerName: string;
  retailerStatus: string;
  relationshipStatus: string;
  addedAt: string | null;
};

export type GroupMembersNormalization =
  | { status: "ok"; members: RetailerGroupMember[] }
  | { status: "malformed"; reason: string };

export function normalizeGroupMembers(data: unknown): GroupMembersNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const members: RetailerGroupMember[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const vendorRetailerId = requiredId(record.vendor_retailer_id);
    const retailerName = requiredText(record.retailer_name);
    const retailerStatus = requiredText(record.retailer_status);
    const relationshipStatus = requiredText(record.relationship_status);

    if (vendorRetailerId === null) {
      return { status: "malformed", reason: "vendor_retailer_id" };
    }
    if (retailerName === null) return { status: "malformed", reason: "retailer_name" };
    if (retailerStatus === null) return { status: "malformed", reason: "retailer_status" };
    if (relationshipStatus === null) {
      return { status: "malformed", reason: "relationship_status" };
    }

    members.push({
      vendorRetailerId,
      retailerName,
      retailerStatus,
      relationshipStatus,
      addedAt: optionalTimestamp(record.added_at),
    });
  }

  return { status: "ok", members };
}

/* ---------------------------------------------------------------------------
 * Vendor campaign list — list_vendor_campaigns()
 * ------------------------------------------------------------------------- */

export type VendorCampaignSummary = {
  campaignId: string;
  name: string;
  description: string | null;
  /** The persisted management status a human wrote. */
  campaignStatus: CampaignStatus;
  /** The effective-time state, computed in SQL. Never recomputed in TypeScript. */
  derivedState: CampaignState;
  versionId: string | null;
  versionNumber: number | null;
  hasDraft: boolean;
  startsAt: string | null;
  endsAt: string | null;
  timezoneName: string | null;
  audienceMode: AudienceMode | null;
  performanceScope: PerformanceScope | null;
  productScope: ProductScope | null;
  stackingMode: StackingMode | null;
  exclusivityKey: string | null;
  priority: number | null;
  rewardRecipientScope: RewardRecipientScope | null;
  reward: CampaignReward;
  eligibleRetailerCount: number;
  selectedRetailerCount: number;
  selectedGroupCount: number;
  selectedProductCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type VendorCampaignsNormalization =
  | { status: "ok"; campaigns: VendorCampaignSummary[] }
  | { status: "malformed"; reason: string };

export function normalizeVendorCampaigns(data: unknown): VendorCampaignsNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const campaigns: VendorCampaignSummary[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const campaignId = requiredId(record.campaign_id);
    const name = requiredText(record.name);
    const hasDraft = requiredBoolean(record.has_draft);

    if (campaignId === null) return { status: "malformed", reason: "campaign_id" };
    if (name === null) return { status: "malformed", reason: "name" };
    if (!isCampaignStatus(record.campaign_status)) {
      return { status: "malformed", reason: "campaign_status" };
    }
    if (!isCampaignState(record.derived_state)) {
      return { status: "malformed", reason: "derived_state" };
    }
    if (hasDraft === null) return { status: "malformed", reason: "has_draft" };

    // A campaign with no version at all is impossible — create_vendor_campaign_draft
    // writes one in the same transaction — but the LEFT JOIN makes every version column
    // nullable in the type, so each enum is checked only when it is present.
    const audienceMode = record.audience_mode;
    const performanceScope = record.performance_scope;
    const productScope = record.product_scope;
    const stackingMode = record.stacking_mode;
    const recipientScope = record.reward_recipient_scope;

    if (audienceMode !== null && audienceMode !== undefined && !isAudienceMode(audienceMode)) {
      return { status: "malformed", reason: "audience_mode" };
    }
    if (
      performanceScope !== null &&
      performanceScope !== undefined &&
      !isPerformanceScope(performanceScope)
    ) {
      return { status: "malformed", reason: "performance_scope" };
    }
    if (productScope !== null && productScope !== undefined && !isProductScope(productScope)) {
      return { status: "malformed", reason: "product_scope" };
    }
    if (stackingMode !== null && stackingMode !== undefined && !isStackingMode(stackingMode)) {
      return { status: "malformed", reason: "stacking_mode" };
    }
    if (
      recipientScope !== null &&
      recipientScope !== undefined &&
      !isRewardRecipientScope(recipientScope)
    ) {
      return { status: "malformed", reason: "reward_recipient_scope" };
    }

    const reward = readReward(record);
    if (reward === "malformed") return { status: "malformed", reason: "rule_type" };

    campaigns.push({
      campaignId,
      name,
      description: optionalText(record.description),
      campaignStatus: record.campaign_status,
      derivedState: record.derived_state,
      versionId: optionalId(record.version_id),
      versionNumber: optionalWholeNumber(record.version_number),
      hasDraft,
      startsAt: optionalTimestamp(record.starts_at),
      endsAt: optionalTimestamp(record.ends_at),
      timezoneName: optionalText(record.timezone_name),
      audienceMode: isAudienceMode(audienceMode) ? audienceMode : null,
      performanceScope: isPerformanceScope(performanceScope) ? performanceScope : null,
      productScope: isProductScope(productScope) ? productScope : null,
      stackingMode: isStackingMode(stackingMode) ? stackingMode : null,
      exclusivityKey: optionalText(record.exclusivity_key),
      priority: optionalWholeNumber(record.priority),
      rewardRecipientScope: isRewardRecipientScope(recipientScope) ? recipientScope : null,
      reward,
      eligibleRetailerCount: wholeNumber(record.eligible_retailer_count) ?? 0,
      selectedRetailerCount: wholeNumber(record.selected_retailer_count) ?? 0,
      selectedGroupCount: wholeNumber(record.selected_group_count) ?? 0,
      selectedProductCount: wholeNumber(record.selected_product_count) ?? 0,
      createdAt: optionalTimestamp(record.created_at),
      updatedAt: optionalTimestamp(record.updated_at),
    });
  }

  return { status: "ok", campaigns };
}

/* ---------------------------------------------------------------------------
 * Campaign header — get_vendor_campaign(uuid)
 * ------------------------------------------------------------------------- */

export type VendorCampaignHeader = {
  campaignId: string;
  name: string;
  description: string | null;
  campaignStatus: CampaignStatus;
  derivedState: CampaignState;
  draftVersionId: string | null;
  draftVersionNumber: number | null;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  versionCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type CampaignHeaderNormalization =
  | { status: "ok"; campaign: VendorCampaignHeader }
  | { status: "not-found" }
  | { status: "malformed"; reason: string };

export function normalizeCampaignHeader(data: unknown): CampaignHeaderNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };
  if (data.length === 0) return { status: "not-found" };

  const record = asRecord(data[0]);
  if (record === null) return { status: "malformed", reason: "row-not-an-object" };

  const campaignId = requiredId(record.campaign_id);
  const name = requiredText(record.name);
  const versionCount = wholeNumber(record.version_count);

  if (campaignId === null) return { status: "malformed", reason: "campaign_id" };
  if (name === null) return { status: "malformed", reason: "name" };
  if (!isCampaignStatus(record.campaign_status)) {
    return { status: "malformed", reason: "campaign_status" };
  }
  if (!isCampaignState(record.derived_state)) {
    return { status: "malformed", reason: "derived_state" };
  }
  if (versionCount === null) return { status: "malformed", reason: "version_count" };

  return {
    status: "ok",
    campaign: {
      campaignId,
      name,
      description: optionalText(record.description),
      campaignStatus: record.campaign_status,
      derivedState: record.derived_state,
      draftVersionId: optionalId(record.draft_version_id),
      draftVersionNumber: optionalWholeNumber(record.draft_version_number),
      publishedVersionId: optionalId(record.published_version_id),
      publishedVersionNumber: optionalWholeNumber(record.published_version_number),
      versionCount,
      createdAt: optionalTimestamp(record.created_at),
      updatedAt: optionalTimestamp(record.updated_at),
    },
  };
}

/* ---------------------------------------------------------------------------
 * Version configuration — get_vendor_campaign_version(uuid)
 * ------------------------------------------------------------------------- */

export type CampaignVersionConfig = {
  versionId: string;
  campaignId: string;
  versionNumber: number;
  isPublished: boolean;
  publishedAt: string | null;
  startsAt: string;
  endsAt: string | null;
  timezoneName: string;
  audienceMode: AudienceMode;
  performanceScope: PerformanceScope;
  productScope: ProductScope;
  stackingMode: StackingMode;
  exclusivityKey: string | null;
  priority: number;
  rewardRecipientScope: RewardRecipientScope;
  reward: CampaignReward;
  eligibleRetailerCount: number;
  /**
   * (Retailer, product) PAIRS in the frozen snapshot — the same quantity publish reports.
   *
   * It is 0 for an ALL_ELIGIBLE_PRODUCTS version BY DESIGN: that scope writes no snapshot
   * rows because it resolves live. A caller must read `productScope` before presenting
   * this number, or it will render "0 products" for a campaign that includes everything.
   */
  eligibleProductCount: number;
  createdAt: string | null;
};

export type VersionConfigNormalization =
  | { status: "ok"; version: CampaignVersionConfig }
  | { status: "not-found" }
  | { status: "malformed"; reason: string };

export function normalizeVersionConfig(data: unknown): VersionConfigNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };
  if (data.length === 0) return { status: "not-found" };

  const record = asRecord(data[0]);
  if (record === null) return { status: "malformed", reason: "row-not-an-object" };

  const versionId = requiredId(record.version_id);
  const campaignId = requiredId(record.campaign_id);
  const versionNumber = wholeNumber(record.version_number);
  const isPublished = requiredBoolean(record.is_published);
  const startsAt = requiredTimestamp(record.starts_at);
  const timezoneName = requiredText(record.timezone_name);
  const priority = wholeNumber(record.priority);

  if (versionId === null) return { status: "malformed", reason: "version_id" };
  if (campaignId === null) return { status: "malformed", reason: "campaign_id" };
  if (versionNumber === null) return { status: "malformed", reason: "version_number" };
  if (isPublished === null) return { status: "malformed", reason: "is_published" };
  if (startsAt === null) return { status: "malformed", reason: "starts_at" };
  if (timezoneName === null) return { status: "malformed", reason: "timezone_name" };
  if (priority === null) return { status: "malformed", reason: "priority" };
  if (!isAudienceMode(record.audience_mode)) {
    return { status: "malformed", reason: "audience_mode" };
  }
  if (!isPerformanceScope(record.performance_scope)) {
    return { status: "malformed", reason: "performance_scope" };
  }
  if (!isProductScope(record.product_scope)) {
    return { status: "malformed", reason: "product_scope" };
  }
  if (!isStackingMode(record.stacking_mode)) {
    return { status: "malformed", reason: "stacking_mode" };
  }
  if (!isRewardRecipientScope(record.reward_recipient_scope)) {
    return { status: "malformed", reason: "reward_recipient_scope" };
  }

  const reward = readReward(record);
  if (reward === "malformed") return { status: "malformed", reason: "rule_type" };

  return {
    status: "ok",
    version: {
      versionId,
      campaignId,
      versionNumber,
      isPublished,
      publishedAt: optionalTimestamp(record.published_at),
      startsAt,
      endsAt: optionalTimestamp(record.ends_at),
      timezoneName,
      audienceMode: record.audience_mode,
      performanceScope: record.performance_scope,
      productScope: record.product_scope,
      stackingMode: record.stacking_mode,
      exclusivityKey: optionalText(record.exclusivity_key),
      priority,
      rewardRecipientScope: record.reward_recipient_scope,
      reward,
      eligibleRetailerCount: wholeNumber(record.eligible_retailer_count) ?? 0,
      eligibleProductCount: wholeNumber(record.eligible_product_count) ?? 0,
      createdAt: optionalTimestamp(record.created_at),
    },
  };
}

/* ---------------------------------------------------------------------------
 * Targets and eligibility — the Vendor-only reads
 * ------------------------------------------------------------------------- */

export type CampaignTargetRetailer = {
  vendorRetailerId: string;
  retailerName: string;
  retailerStatus: string;
  relationshipStatus: string;
};

export type TargetRetailersNormalization =
  | { status: "ok"; retailers: CampaignTargetRetailer[] }
  | { status: "malformed"; reason: string };

export function normalizeTargetRetailers(data: unknown): TargetRetailersNormalization {
  const result = normalizeGroupMembers(data);
  if (result.status === "malformed") return result;
  return {
    status: "ok",
    retailers: result.members.map((member) => ({
      vendorRetailerId: member.vendorRetailerId,
      retailerName: member.retailerName,
      retailerStatus: member.retailerStatus,
      relationshipStatus: member.relationshipStatus,
    })),
  };
}

export type CampaignTargetGroup = {
  groupId: string;
  name: string;
  status: GroupStatus;
  memberCount: number;
};

export type TargetGroupsNormalization =
  | { status: "ok"; groups: CampaignTargetGroup[] }
  | { status: "malformed"; reason: string };

export function normalizeTargetGroups(data: unknown): TargetGroupsNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const groups: CampaignTargetGroup[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const groupId = requiredId(record.group_id);
    const name = requiredText(record.name);
    const memberCount = wholeNumber(record.member_count);

    if (groupId === null) return { status: "malformed", reason: "group_id" };
    if (name === null) return { status: "malformed", reason: "name" };
    if (!isGroupStatus(record.status)) return { status: "malformed", reason: "status" };
    if (memberCount === null) return { status: "malformed", reason: "member_count" };

    groups.push({ groupId, name, status: record.status, memberCount });
  }

  return { status: "ok", groups };
}

export type CampaignTargetProduct = {
  productId: string;
  productCode: string;
  productName: string;
  brand: string | null;
  productStatus: string;
};

export type TargetProductsNormalization =
  | { status: "ok"; products: CampaignTargetProduct[] }
  | { status: "malformed"; reason: string };

export function normalizeTargetProducts(data: unknown): TargetProductsNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const products: CampaignTargetProduct[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const productId = requiredId(record.product_id);
    const productCode = requiredText(record.product_code);
    const productName = requiredText(record.product_name);
    const productStatus = requiredText(record.product_status);

    if (productId === null) return { status: "malformed", reason: "product_id" };
    if (productCode === null) return { status: "malformed", reason: "product_code" };
    if (productName === null) return { status: "malformed", reason: "product_name" };
    if (productStatus === null) return { status: "malformed", reason: "product_status" };

    products.push({
      productId,
      productCode,
      productName,
      brand: optionalText(record.brand),
      productStatus,
    });
  }

  return { status: "ok", products };
}

/**
 * One row of the frozen eligibility snapshot, VENDOR-ONLY.
 *
 * `source` and `sourceGroupName` explain WHY a Retailer is eligible. They exist on this
 * type and on no assigned-visibility type, because naming the group to a Retailer would
 * disclose a Vendor's segmentation and imply the existence of its other members.
 */
export type CampaignEligibleRetailer = {
  vendorRetailerId: string;
  retailerName: string;
  source: string;
  sourceGroupName: string | null;
  eligibleProductCount: number;
};

export type EligibleRetailersNormalization =
  | { status: "ok"; retailers: CampaignEligibleRetailer[] }
  | { status: "malformed"; reason: string };

export function normalizeEligibleRetailers(data: unknown): EligibleRetailersNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const retailers: CampaignEligibleRetailer[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const vendorRetailerId = requiredId(record.vendor_retailer_id);
    const retailerName = requiredText(record.retailer_name);
    const source = requiredText(record.source);
    const eligibleProductCount = wholeNumber(record.eligible_product_count);

    if (vendorRetailerId === null) {
      return { status: "malformed", reason: "vendor_retailer_id" };
    }
    if (retailerName === null) return { status: "malformed", reason: "retailer_name" };
    if (source === null) return { status: "malformed", reason: "source" };
    if (eligibleProductCount === null) {
      return { status: "malformed", reason: "eligible_product_count" };
    }

    retailers.push({
      vendorRetailerId,
      retailerName,
      source,
      sourceGroupName: optionalText(record.source_group_name),
      eligibleProductCount,
    });
  }

  return { status: "ok", retailers };
}

/**
 * One row of the pre-publication preview.
 *
 * `missingProductCount` above zero IS the conflict the operator must see before they
 * commit: the campaign will run at that Retailer for fewer products than they chose,
 * because the rest are not assigned there.
 */
export type PublicationPreviewRow = {
  vendorRetailerId: string;
  retailerName: string;
  source: string;
  eligibleProductCount: number;
  missingProductCount: number;
};

export type PublicationPreviewNormalization =
  | { status: "ok"; rows: PublicationPreviewRow[] }
  | { status: "malformed"; reason: string };

export function normalizePublicationPreview(
  data: unknown,
): PublicationPreviewNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const rows: PublicationPreviewRow[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const vendorRetailerId = requiredId(record.vendor_retailer_id);
    const retailerName = requiredText(record.retailer_name);
    const source = requiredText(record.source);
    const eligibleProductCount = wholeNumber(record.eligible_product_count);
    const missingProductCount = wholeNumber(record.missing_product_count);

    if (vendorRetailerId === null) {
      return { status: "malformed", reason: "vendor_retailer_id" };
    }
    if (retailerName === null) return { status: "malformed", reason: "retailer_name" };
    if (source === null) return { status: "malformed", reason: "source" };
    if (eligibleProductCount === null) {
      return { status: "malformed", reason: "eligible_product_count" };
    }
    if (missingProductCount === null) {
      return { status: "malformed", reason: "missing_product_count" };
    }

    rows.push({
      vendorRetailerId,
      retailerName,
      source,
      eligibleProductCount,
      missingProductCount,
    });
  }

  return { status: "ok", rows };
}

/* ---------------------------------------------------------------------------
 * Assigned visibility — the Retailer Owner's read
 * ------------------------------------------------------------------------- */

/**
 * A campaign as a Retailer Owner sees it.
 *
 * Compare this type against VendorCampaignSummary: there is no exclusivityKey, no
 * priority, no eligibility source, no version number, no other Retailer's identity and no
 * Retailer count. Those fields are not filtered out here — THEY NEVER ARRIVE. The RPCs
 * do not return them, which is where the guarantee actually lives.
 *
 * `eligibleProductCount` is THIS Retailer's own count and never the campaign's total
 * across Retailers.
 */
export type AssignedCampaign = {
  campaignId: string;
  campaignName: string;
  description: string | null;
  /** Present for the Owner read, absent for the Sales Staff read. */
  vendorName: string | null;
  derivedState: CampaignState;
  campaignStatus: CampaignStatus | null;
  startsAt: string | null;
  endsAt: string | null;
  timezoneName: string | null;
  performanceScope: PerformanceScope;
  productScope: ProductScope;
  stackingMode: StackingMode;
  rewardRecipientScope: RewardRecipientScope | null;
  reward: CampaignReward;
  eligibleProductCount: number;
};

export type AssignedCampaignsNormalization =
  | { status: "ok"; campaigns: AssignedCampaign[] }
  | { status: "malformed"; reason: string };

function readAssignedCampaign(
  record: Record<string, unknown>,
): AssignedCampaign | { reason: string } {
  const campaignId = requiredId(record.campaign_id);
  const campaignName = requiredText(record.campaign_name);
  const eligibleProductCount = wholeNumber(record.eligible_product_count);

  if (campaignId === null) return { reason: "campaign_id" };
  if (campaignName === null) return { reason: "campaign_name" };
  if (!isCampaignState(record.derived_state)) return { reason: "derived_state" };
  if (!isPerformanceScope(record.performance_scope)) return { reason: "performance_scope" };
  if (!isProductScope(record.product_scope)) return { reason: "product_scope" };
  if (!isStackingMode(record.stacking_mode)) return { reason: "stacking_mode" };
  if (eligibleProductCount === null) return { reason: "eligible_product_count" };

  // campaign_status is returned to the Owner and withheld from Sales Staff, so it is
  // checked only when present.
  const campaignStatus = record.campaign_status;
  if (
    campaignStatus !== null &&
    campaignStatus !== undefined &&
    !isCampaignStatus(campaignStatus)
  ) {
    return { reason: "campaign_status" };
  }

  const recipientScope = record.reward_recipient_scope;
  if (
    recipientScope !== null &&
    recipientScope !== undefined &&
    !isRewardRecipientScope(recipientScope)
  ) {
    return { reason: "reward_recipient_scope" };
  }

  const reward = readReward(record);
  if (reward === "malformed") return { reason: "rule_type" };

  return {
    campaignId,
    campaignName,
    description: optionalText(record.description),
    vendorName: optionalText(record.vendor_name),
    derivedState: record.derived_state,
    campaignStatus: isCampaignStatus(campaignStatus) ? campaignStatus : null,
    startsAt: optionalTimestamp(record.starts_at),
    endsAt: optionalTimestamp(record.ends_at),
    timezoneName: optionalText(record.timezone_name),
    performanceScope: record.performance_scope,
    productScope: record.product_scope,
    stackingMode: record.stacking_mode,
    rewardRecipientScope: isRewardRecipientScope(recipientScope) ? recipientScope : null,
    reward,
    eligibleProductCount,
  };
}

export function normalizeAssignedCampaigns(data: unknown): AssignedCampaignsNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const campaigns: AssignedCampaign[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const parsed = readAssignedCampaign(record);
    if ("reason" in parsed) return { status: "malformed", reason: parsed.reason };
    campaigns.push(parsed);
  }

  return { status: "ok", campaigns };
}

export type AssignedCampaignNormalization =
  | { status: "ok"; campaign: AssignedCampaign }
  | { status: "not-found" }
  | { status: "malformed"; reason: string };

export function normalizeAssignedCampaign(data: unknown): AssignedCampaignNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };
  if (data.length === 0) return { status: "not-found" };

  const record = asRecord(data[0]);
  if (record === null) return { status: "malformed", reason: "row-not-an-object" };

  const parsed = readAssignedCampaign(record);
  if ("reason" in parsed) return { status: "malformed", reason: parsed.reason };
  return { status: "ok", campaign: parsed };
}

/* ---------------------------------------------------------------------------
 * Campaign products — the assigned-visibility product reads
 * ------------------------------------------------------------------------- */

export type CampaignProduct = {
  productId: string;
  productCode: string;
  barcode: string | null;
  productName: string;
  brand: string | null;
};

export type CampaignProductsNormalization =
  | { status: "ok"; products: CampaignProduct[] }
  | { status: "malformed"; reason: string };

export function normalizeCampaignProducts(data: unknown): CampaignProductsNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const products: CampaignProduct[] = [];

  for (const row of data) {
    const record = asRecord(row);
    if (record === null) return { status: "malformed", reason: "row-not-an-object" };

    const productId = requiredId(record.product_id);
    const productCode = requiredText(record.product_code);
    const productName = requiredText(record.product_name);

    if (productId === null) return { status: "malformed", reason: "product_id" };
    if (productCode === null) return { status: "malformed", reason: "product_code" };
    if (productName === null) return { status: "malformed", reason: "product_name" };

    products.push({
      productId,
      productCode,
      barcode: optionalText(record.barcode),
      productName,
      brand: optionalText(record.brand),
    });
  }

  return { status: "ok", products };
}

/* ---------------------------------------------------------------------------
 * Write outcomes
 * ------------------------------------------------------------------------- */

/**
 * The result of publish_vendor_campaign().
 *
 * `published: false` is the EXPLICIT NO-OP the RPC returns when there is nothing to
 * publish — a double-clicked button, or a page submitted twice. It is not an error and
 * must not be reported as one, and it must never trigger a retry.
 */
export type PublishOutcome = {
  campaignId: string;
  campaignVersionId: string | null;
  versionNumber: number | null;
  campaignStatus: CampaignStatus | null;
  eligibleRetailerCount: number;
  eligibleProductCount: number;
  published: boolean;
};

export type PublishNormalization =
  | { status: "ok"; outcome: PublishOutcome }
  | { status: "malformed"; reason: string };

export function normalizePublishOutcome(data: unknown): PublishNormalization {
  if (!Array.isArray(data) || data.length === 0) {
    return { status: "malformed", reason: "not-a-row" };
  }

  const record = asRecord(data[0]);
  if (record === null) return { status: "malformed", reason: "row-not-an-object" };

  const campaignId = requiredId(record.campaign_id);
  const published = requiredBoolean(record.published);

  if (campaignId === null) return { status: "malformed", reason: "campaign_id" };
  if (published === null) return { status: "malformed", reason: "published" };

  const campaignStatus = record.campaign_status;
  if (
    campaignStatus !== null &&
    campaignStatus !== undefined &&
    !isCampaignStatus(campaignStatus)
  ) {
    return { status: "malformed", reason: "campaign_status" };
  }

  return {
    status: "ok",
    outcome: {
      campaignId,
      campaignVersionId: optionalId(record.campaign_version_id),
      versionNumber: optionalWholeNumber(record.version_number),
      campaignStatus: isCampaignStatus(campaignStatus) ? campaignStatus : null,
      eligibleRetailerCount: wholeNumber(record.eligible_retailer_count) ?? 0,
      eligibleProductCount: wholeNumber(record.eligible_product_count) ?? 0,
      published,
    },
  };
}

/** The result of set_vendor_campaign_lifecycle(). `statusChanged: false` is a no-op. */
export type LifecycleOutcome = {
  campaignId: string;
  campaignStatus: CampaignStatus;
  statusChanged: boolean;
};

export type LifecycleNormalization =
  | { status: "ok"; outcome: LifecycleOutcome }
  | { status: "malformed"; reason: string };

export function normalizeLifecycleOutcome(data: unknown): LifecycleNormalization {
  if (!Array.isArray(data) || data.length === 0) {
    return { status: "malformed", reason: "not-a-row" };
  }

  const record = asRecord(data[0]);
  if (record === null) return { status: "malformed", reason: "row-not-an-object" };

  const campaignId = requiredId(record.campaign_id);
  const statusChanged = requiredBoolean(record.status_changed);

  if (campaignId === null) return { status: "malformed", reason: "campaign_id" };
  if (!isCampaignStatus(record.campaign_status)) {
    return { status: "malformed", reason: "campaign_status" };
  }
  if (statusChanged === null) return { status: "malformed", reason: "status_changed" };

  return {
    status: "ok",
    outcome: {
      campaignId,
      campaignStatus: record.campaign_status,
      statusChanged,
    },
  };
}

/** The result of set_vendor_retailer_group_members(). */
export type GroupMembershipOutcome = {
  membersAdded: number;
  membersRemoved: number;
  membersUnchanged: number;
};

export type GroupMembershipNormalization =
  | { status: "ok"; outcome: GroupMembershipOutcome }
  | { status: "malformed"; reason: string };

export function normalizeGroupMembershipOutcome(
  data: unknown,
): GroupMembershipNormalization {
  if (!Array.isArray(data) || data.length === 0) {
    return { status: "malformed", reason: "not-a-row" };
  }

  const record = asRecord(data[0]);
  if (record === null) return { status: "malformed", reason: "row-not-an-object" };

  const membersAdded = wholeNumber(record.members_added);
  const membersRemoved = wholeNumber(record.members_removed);
  const membersUnchanged = wholeNumber(record.members_unchanged);

  if (membersAdded === null) return { status: "malformed", reason: "members_added" };
  if (membersRemoved === null) return { status: "malformed", reason: "members_removed" };
  if (membersUnchanged === null) return { status: "malformed", reason: "members_unchanged" };

  return {
    status: "ok",
    outcome: { membersAdded, membersRemoved, membersUnchanged },
  };
}
