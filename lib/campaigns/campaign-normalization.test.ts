/**
 * Unit tests for @/lib/campaigns/campaign-normalization.
 *
 * Run with:  npm test
 *
 * The module is pure, so these exercise it directly against representative rows. What
 * they establish, in order of how much a mistake would cost:
 *
 *   1. DISCLOSURE. An assigned-visibility row carrying a field it should not — an
 *      exclusivity key, a source, another Retailer — does not reach the UI type, because
 *      the mappers are an allow-list rather than a spread.
 *   2. DRIFT. An unrecognized enum FAILS the read instead of rendering a default. A
 *      campaign whose stacking mode is unknown must not be shown as "Stackable": that is
 *      a claim about how someone will be paid.
 *   3. PRECISION. A coin value beyond Number.MAX_SAFE_INTEGER is refused rather than
 *      silently rounded, and a bigint arriving as a string is read correctly.
 *   4. NO-OP FIDELITY. `published: false` and `statusChanged: false` survive the mapper
 *      intact, because the UI must be able to tell a real write from an idempotent one.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAssignedCampaign,
  normalizeAssignedCampaigns,
  normalizeCampaignHeader,
  normalizeCampaignProducts,
  normalizeEligibleRetailers,
  normalizeGroupMembers,
  normalizeGroupMembershipOutcome,
  normalizeLifecycleOutcome,
  normalizePublicationPreview,
  normalizePublishOutcome,
  normalizeRetailerGroups,
  normalizeTargetGroups,
  normalizeTargetProducts,
  normalizeVendorCampaigns,
  normalizeVersionConfig,
} from "./campaign-normalization.ts";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const GROUP_ID = "33333333-3333-4333-8333-333333333333";
const RELATIONSHIP_ID = "44444444-4444-4444-8444-444444444444";
const PRODUCT_ID = "55555555-5555-4555-8555-555555555555";

/* ---------------------------------------------------------------------------
 * Retailer groups
 * ------------------------------------------------------------------------- */

describe("normalizeRetailerGroups", () => {
  const row = {
    group_id: GROUP_ID.toUpperCase(),
    name: "Premium Dubai",
    description: "Top shops",
    status: "ACTIVE",
    member_count: 3,
    campaign_ref_count: 2,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
  };

  test("1. maps a full row and lower-cases the id", () => {
    const result = normalizeRetailerGroups([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.groups[0], {
      groupId: GROUP_ID,
      name: "Premium Dubai",
      description: "Top shops",
      status: "ACTIVE",
      memberCount: 3,
      campaignRefCount: 2,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
    });
  });

  test("2. an empty description becomes null rather than an empty string", () => {
    const result = normalizeRetailerGroups([{ ...row, description: "   " }]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.groups[0].description, null);
  });

  test("3. an unrecognized status is drift, not a value to render", () => {
    const result = normalizeRetailerGroups([{ ...row, status: "RETIRED" }]);
    assert.deepEqual(result, { status: "malformed", reason: "status" });
  });

  test("4. a missing count fails the read rather than defaulting to zero", () => {
    // Zero members and "we could not read the member count" are different facts.
    const result = normalizeRetailerGroups([{ ...row, member_count: null }]);
    assert.deepEqual(result, { status: "malformed", reason: "member_count" });
  });

  test("5. a non-array, and a non-object row, are both refused", () => {
    assert.equal(normalizeRetailerGroups(null).status, "malformed");
    assert.equal(normalizeRetailerGroups({}).status, "malformed");
    assert.deepEqual(normalizeRetailerGroups(["x"]), {
      status: "malformed",
      reason: "row-not-an-object",
    });
  });

  test("6. an empty result is ok with no groups, never malformed", () => {
    assert.deepEqual(normalizeRetailerGroups([]), { status: "ok", groups: [] });
  });
});

describe("normalizeGroupMembers", () => {
  const row = {
    vendor_retailer_id: RELATIONSHIP_ID,
    retailer_name: "Retailer Alpha",
    retailer_status: "ACTIVE",
    relationship_status: "SUSPENDED",
    added_at: "2026-08-01T00:00:00Z",
  };

  test("7. carries BOTH statuses, so a since-suspended member is visible as such", () => {
    const result = normalizeGroupMembers([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.members[0].retailerStatus, "ACTIVE");
    assert.equal(result.members[0].relationshipStatus, "SUSPENDED");
  });

  test("8. a missing relationship id fails the read", () => {
    const result = normalizeGroupMembers([{ ...row, vendor_retailer_id: null }]);
    assert.deepEqual(result, { status: "malformed", reason: "vendor_retailer_id" });
  });
});

/* ---------------------------------------------------------------------------
 * Vendor campaigns
 * ------------------------------------------------------------------------- */

const campaignRow = {
  campaign_id: CAMPAIGN_ID,
  name: "Winter Push",
  description: "Sell ten, earn a hundred",
  campaign_status: "PUBLISHED",
  derived_state: "ACTIVE",
  version_id: VERSION_ID,
  version_number: 1,
  has_draft: false,
  starts_at: "2026-08-01T00:00:00Z",
  ends_at: null,
  timezone_name: "Asia/Dubai",
  audience_mode: "RETAILER_GROUPS",
  performance_scope: "RETAILER_TEAM",
  product_scope: "SELECTED_PRODUCTS",
  stacking_mode: "EXCLUSIVE",
  exclusivity_key: "WINTER BONUS",
  priority: 50,
  reward_recipient_scope: "CONTRIBUTING_STAFF",
  rule_type: "TARGET_BONUS",
  metric_type: "UNITS_SOLD",
  coins_per_unit: null,
  max_reward_coins: null,
  threshold_units: 10,
  reward_coins: 100,
  eligible_retailer_count: 2,
  selected_retailer_count: 0,
  selected_group_count: 1,
  selected_product_count: 2,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};

describe("normalizeVendorCampaigns", () => {
  test("9. maps a full campaign, including the Vendor-only fields", () => {
    const result = normalizeVendorCampaigns([campaignRow]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const campaign = result.campaigns[0];
    assert.equal(campaign.campaignId, CAMPAIGN_ID);
    assert.equal(campaign.campaignStatus, "PUBLISHED");
    assert.equal(campaign.derivedState, "ACTIVE");
    // The Vendor DOES see the exclusivity configuration. No Retailer-facing type does.
    assert.equal(campaign.exclusivityKey, "WINTER BONUS");
    assert.equal(campaign.priority, 50);
    assert.deepEqual(campaign.reward, {
      ruleType: "TARGET_BONUS",
      metricType: "UNITS_SOLD",
      coinsPerUnit: null,
      maxRewardCoins: null,
      thresholdUnits: 10,
      rewardCoins: 100,
    });
  });

  test("10. the persisted status and the derived state are kept apart", () => {
    // A published campaign whose period has passed is PUBLISHED and ENDED at once.
    const result = normalizeVendorCampaigns([
      { ...campaignRow, campaign_status: "PUBLISHED", derived_state: "ENDED" },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.campaigns[0].campaignStatus, "PUBLISHED");
    assert.equal(result.campaigns[0].derivedState, "ENDED");
  });

  test("11. an unrecognized derived state is drift", () => {
    const result = normalizeVendorCampaigns([
      { ...campaignRow, derived_state: "RUNNING" },
    ]);
    assert.deepEqual(result, { status: "malformed", reason: "derived_state" });
  });

  test("12. an unrecognized stacking mode is drift, NOT a default", () => {
    const result = normalizeVendorCampaigns([{ ...campaignRow, stacking_mode: "MAYBE" }]);
    assert.deepEqual(result, { status: "malformed", reason: "stacking_mode" });
  });

  test("13. an unrecognized rule type is drift", () => {
    const result = normalizeVendorCampaigns([
      { ...campaignRow, rule_type: "PERCENTAGE_OF_SALES" },
    ]);
    assert.deepEqual(result, { status: "malformed", reason: "rule_type" });
  });

  test("14. a null rule is absence, not drift — the RPC LEFT JOINs it", () => {
    const result = normalizeVendorCampaigns([
      { ...campaignRow, rule_type: null, metric_type: null, threshold_units: null, reward_coins: null },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.campaigns[0].reward.ruleType, null);
  });

  test("15. a bigint arriving as a string is read, not dropped", () => {
    const result = normalizeVendorCampaigns([
      { ...campaignRow, reward_coins: "9007199254740991" },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.campaigns[0].reward.rewardCoins, 9007199254740991);
  });

  test("16. a coin value beyond safe-integer range is REFUSED, never rounded", () => {
    // Rounding a coin amount would be quietly changing what someone is owed.
    const result = normalizeVendorCampaigns([
      { ...campaignRow, reward_coins: "9007199254740993" },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.campaigns[0].reward.rewardCoins, null);
  });

  test("17. a negative count is refused", () => {
    const result = normalizeVendorCampaigns([
      { ...campaignRow, eligible_retailer_count: -1 },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    // wholeNumber refuses it, and the count coalesces to 0 rather than showing -1.
    assert.equal(result.campaigns[0].eligibleRetailerCount, 0);
  });

  test("18. a missing has_draft flag fails the read", () => {
    const result = normalizeVendorCampaigns([{ ...campaignRow, has_draft: null }]);
    assert.deepEqual(result, { status: "malformed", reason: "has_draft" });
  });
});

describe("normalizeCampaignHeader", () => {
  const row = {
    campaign_id: CAMPAIGN_ID,
    name: "Winter Push",
    description: null,
    campaign_status: "PUBLISHED",
    derived_state: "ACTIVE",
    draft_version_id: null,
    draft_version_number: null,
    published_version_id: VERSION_ID,
    published_version_number: 1,
    version_count: 2,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };

  test("19. an empty result is not-found, distinct from malformed", () => {
    // An unknown id and another Vendor's id both return zero rows; neither is an error.
    assert.deepEqual(normalizeCampaignHeader([]), { status: "not-found" });
  });

  test("20. maps the two version pointers independently", () => {
    const result = normalizeCampaignHeader([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.campaign.draftVersionId, null);
    assert.equal(result.campaign.publishedVersionId, VERSION_ID);
    assert.equal(result.campaign.versionCount, 2);
  });

  test("21. an unrecognized campaign status is drift", () => {
    const result = normalizeCampaignHeader([{ ...row, campaign_status: "ARCHIVED" }]);
    assert.deepEqual(result, { status: "malformed", reason: "campaign_status" });
  });
});

describe("normalizeVersionConfig", () => {
  const row = {
    version_id: VERSION_ID,
    campaign_id: CAMPAIGN_ID,
    version_number: 1,
    is_published: true,
    published_at: "2026-08-01T00:00:00Z",
    starts_at: "2026-08-01T00:00:00Z",
    ends_at: "2026-09-01T00:00:00Z",
    timezone_name: "Asia/Dubai",
    audience_mode: "ALL_RETAILERS",
    performance_scope: "INDIVIDUAL_STAFF",
    product_scope: "ALL_ELIGIBLE_PRODUCTS",
    stacking_mode: "STACKABLE",
    exclusivity_key: null,
    priority: 0,
    reward_recipient_scope: "CONTRIBUTING_STAFF",
    rule_type: "PER_UNIT_COINS",
    metric_type: "UNITS_SOLD",
    coins_per_unit: 5,
    max_reward_coins: 10000,
    threshold_units: null,
    reward_coins: null,
    eligible_retailer_count: 2,
    eligible_product_count: 0,
    created_at: "2026-08-01T00:00:00Z",
  };

  test("22. every required enum must be present and recognized", () => {
    const result = normalizeVersionConfig([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.version.audienceMode, "ALL_RETAILERS");
    assert.equal(result.version.stackingMode, "STACKABLE");
    assert.equal(result.version.exclusivityKey, null);
  });

  test("23. a zero product count on an ALL_ELIGIBLE_PRODUCTS version is preserved", () => {
    // It means "no snapshot rows", not "no products" — the caller must read productScope
    // before presenting it. Silently substituting a different number here would hide that.
    const result = normalizeVersionConfig([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.version.eligibleProductCount, 0);
    assert.equal(result.version.productScope, "ALL_ELIGIBLE_PRODUCTS");
  });

  test("24. a missing start instant fails the read", () => {
    const result = normalizeVersionConfig([{ ...row, starts_at: null }]);
    assert.deepEqual(result, { status: "malformed", reason: "starts_at" });
  });

  test("25. a missing audience mode fails the read", () => {
    const result = normalizeVersionConfig([{ ...row, audience_mode: null }]);
    assert.deepEqual(result, { status: "malformed", reason: "audience_mode" });
  });

  test("26. an empty result is not-found", () => {
    assert.deepEqual(normalizeVersionConfig([]), { status: "not-found" });
  });
});

describe("normalizeTargetGroups / normalizeTargetProducts / normalizeEligibleRetailers", () => {
  test("27. target groups carry the live member count", () => {
    const result = normalizeTargetGroups([
      { group_id: GROUP_ID, name: "Premium", status: "ACTIVE", member_count: 4 },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.groups[0].memberCount, 4);
  });

  test("28. target products carry their own status, so an inactive one is visible", () => {
    const result = normalizeTargetProducts([
      {
        product_id: PRODUCT_ID,
        product_code: "P-1",
        product_name: "Product One",
        brand: null,
        product_status: "INACTIVE",
      },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.products[0].productStatus, "INACTIVE");
    assert.equal(result.products[0].brand, null);
  });

  test("29. the eligibility snapshot carries the source — a VENDOR-ONLY fact", () => {
    const result = normalizeEligibleRetailers([
      {
        vendor_retailer_id: RELATIONSHIP_ID,
        retailer_name: "Retailer Alpha",
        source: "RETAILER_GROUP",
        source_group_name: "Premium Dubai",
        eligible_product_count: 2,
      },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.retailers[0].source, "RETAILER_GROUP");
    assert.equal(result.retailers[0].sourceGroupName, "Premium Dubai");
  });

  test("30. the publication preview carries the conflict count", () => {
    const result = normalizePublicationPreview([
      {
        vendor_retailer_id: RELATIONSHIP_ID,
        retailer_name: "Retailer Bravo",
        source: "RETAILER_GROUP",
        eligible_product_count: 1,
        missing_product_count: 1,
      },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.rows[0].missingProductCount, 1);
  });

  test("31. a missing preview count fails rather than reading as no conflict", () => {
    const result = normalizePublicationPreview([
      {
        vendor_retailer_id: RELATIONSHIP_ID,
        retailer_name: "Retailer Bravo",
        source: "RETAILER_GROUP",
        eligible_product_count: 1,
        missing_product_count: null,
      },
    ]);
    assert.deepEqual(result, { status: "malformed", reason: "missing_product_count" });
  });
});

/* ---------------------------------------------------------------------------
 * Assigned visibility — the disclosure boundary
 * ------------------------------------------------------------------------- */

const ownerRow = {
  campaign_id: CAMPAIGN_ID,
  campaign_name: "Winter Push",
  description: "Sell ten, earn a hundred",
  vendor_name: "Vendor A",
  derived_state: "ACTIVE",
  campaign_status: "PUBLISHED",
  starts_at: "2026-08-01T00:00:00Z",
  ends_at: null,
  timezone_name: "Asia/Dubai",
  performance_scope: "RETAILER_TEAM",
  product_scope: "SELECTED_PRODUCTS",
  stacking_mode: "EXCLUSIVE",
  reward_recipient_scope: "CONTRIBUTING_STAFF",
  rule_type: "TARGET_BONUS",
  metric_type: "UNITS_SOLD",
  coins_per_unit: null,
  max_reward_coins: null,
  threshold_units: 10,
  reward_coins: 100,
  eligible_product_count: 2,
};

describe("normalizeAssignedCampaigns — the disclosure boundary", () => {
  test("32. maps everything the Owner is entitled to see", () => {
    const result = normalizeAssignedCampaigns([ownerRow]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const campaign = result.campaigns[0];
    assert.equal(campaign.vendorName, "Vendor A");
    assert.equal(campaign.performanceScope, "RETAILER_TEAM");
    // The MODE is visible — it changes what a seller can expect to earn.
    assert.equal(campaign.stackingMode, "EXCLUSIVE");
    assert.equal(campaign.eligibleProductCount, 2);
  });

  test("33. an exclusivity key, a priority and a source CANNOT reach the type", () => {
    // The mapper is an allow-list, so even a row that carried them drops them. The real
    // guarantee is that no assigned-visibility RPC returns them at all; this proves the
    // client side cannot re-introduce one by accident.
    const contaminated = {
      ...ownerRow,
      exclusivity_key: "WINTER BONUS",
      priority: 50,
      source: "RETAILER_GROUP",
      source_group_name: "Premium Dubai",
      version_number: 3,
      eligible_retailer_count: 12,
      vendor_retailer_id: RELATIONSHIP_ID,
      retailer_organization_id: RELATIONSHIP_ID,
    };
    const result = normalizeAssignedCampaigns([contaminated]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;

    const serialized = JSON.stringify(result.campaigns[0]);
    for (const leaked of [
      "WINTER BONUS",
      "RETAILER_GROUP",
      "Premium Dubai",
      RELATIONSHIP_ID,
    ]) {
      assert.ok(!serialized.includes(leaked), `leaked ${leaked}`);
    }
    assert.deepEqual(Object.keys(result.campaigns[0]).filter((key) =>
      /exclusiv|priority|source|version|retailerCount|vendorRetailer/i.test(key),
    ), []);
  });

  test("34. the Sales Staff shape — no vendor_name, no campaign_status — still maps", () => {
    const staffRow = { ...ownerRow };
    delete (staffRow as Record<string, unknown>).vendor_name;
    delete (staffRow as Record<string, unknown>).campaign_status;

    const result = normalizeAssignedCampaigns([staffRow]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.campaigns[0].vendorName, null);
    assert.equal(result.campaigns[0].campaignStatus, null);
    assert.equal(result.campaigns[0].campaignName, "Winter Push");
  });

  test("35. an unrecognized performance scope is drift", () => {
    const result = normalizeAssignedCampaigns([
      { ...ownerRow, performance_scope: "WHOLE_REGION" },
    ]);
    assert.deepEqual(result, { status: "malformed", reason: "performance_scope" });
  });

  test("36. a missing per-Retailer product count fails the read", () => {
    const result = normalizeAssignedCampaigns([
      { ...ownerRow, eligible_product_count: null },
    ]);
    assert.deepEqual(result, { status: "malformed", reason: "eligible_product_count" });
  });

  test("37. the single-row form returns not-found for an empty result", () => {
    assert.deepEqual(normalizeAssignedCampaign([]), { status: "not-found" });
  });

  test("38. the single-row form maps identically to the list form", () => {
    const single = normalizeAssignedCampaign([ownerRow]);
    const list = normalizeAssignedCampaigns([ownerRow]);
    assert.equal(single.status, "ok");
    assert.equal(list.status, "ok");
    if (single.status !== "ok" || list.status !== "ok") return;
    assert.deepEqual(single.campaign, list.campaigns[0]);
  });
});

describe("normalizeCampaignProducts", () => {
  test("39. maps the presentation-safe product fields only", () => {
    const result = normalizeCampaignProducts([
      {
        product_id: PRODUCT_ID,
        product_code: "P-1",
        barcode: "12345678",
        product_name: "Product One",
        brand: "Acme",
        // Not part of the contract; must not survive the allow-list.
        vendor_organization_id: RELATIONSHIP_ID,
      },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.products[0], {
      productId: PRODUCT_ID,
      productCode: "P-1",
      barcode: "12345678",
      productName: "Product One",
      brand: "Acme",
    });
  });
});

/* ---------------------------------------------------------------------------
 * Write outcomes — no-op fidelity
 * ------------------------------------------------------------------------- */

describe("write outcomes preserve the difference between a write and a no-op", () => {
  test("40. published:false survives — it is the idempotent second publish", () => {
    const result = normalizePublishOutcome([
      {
        campaign_id: CAMPAIGN_ID,
        campaign_version_id: VERSION_ID,
        version_number: 1,
        campaign_status: "PUBLISHED",
        eligible_retailer_count: 2,
        eligible_product_count: 3,
        published: false,
      },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.outcome.published, false);
    assert.equal(result.outcome.eligibleRetailerCount, 2);
  });

  test("41. published:true survives", () => {
    const result = normalizePublishOutcome([
      {
        campaign_id: CAMPAIGN_ID,
        campaign_version_id: VERSION_ID,
        version_number: 2,
        campaign_status: "PUBLISHED",
        eligible_retailer_count: 1,
        eligible_product_count: 1,
        published: true,
      },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.outcome.published, true);
  });

  test("42. a missing published flag is malformed, never assumed true", () => {
    // Assuming a publish happened when the response could not say so would be the one
    // mistake that produces a duplicate-publish retry.
    const result = normalizePublishOutcome([
      { campaign_id: CAMPAIGN_ID, published: null },
    ]);
    assert.deepEqual(result, { status: "malformed", reason: "published" });
  });

  test("43. statusChanged:false survives — pausing something already paused", () => {
    const result = normalizeLifecycleOutcome([
      { campaign_id: CAMPAIGN_ID, campaign_status: "PAUSED", status_changed: false },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.outcome.statusChanged, false);
    assert.equal(result.outcome.campaignStatus, "PAUSED");
  });

  test("44. membership counts come back as three separate numbers", () => {
    const result = normalizeGroupMembershipOutcome([
      { members_added: 2, members_removed: 1, members_unchanged: 3 },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.outcome, {
      membersAdded: 2,
      membersRemoved: 1,
      membersUnchanged: 3,
    });
  });

  test("45. an empty write response is malformed, not a silent zero", () => {
    assert.equal(normalizePublishOutcome([]).status, "malformed");
    assert.equal(normalizeLifecycleOutcome([]).status, "malformed");
    assert.equal(normalizeGroupMembershipOutcome([]).status, "malformed");
  });
});
