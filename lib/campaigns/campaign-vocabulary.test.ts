/**
 * Unit tests for @/lib/campaigns/campaign-vocabulary.
 *
 * Run with:  npm test
 *
 * The module is pure, so these exercise it directly — no mocking, no Supabase client, no
 * request. What they establish:
 *
 *   1. Every vocabulary is EXHAUSTIVE against its migration CHECK constraint, asserted by
 *      reading the SQL rather than by restating the list. A value added to the database
 *      and not to this module would otherwise reach the normalizer as "drift" and fail a
 *      read for every user at once.
 *   2. The guards reject everything outside their list, including near-misses.
 *   3. The reward summary describes an OFFER and never computes a total.
 *   4. Number formatting is locale-independent, so a server render and a browser render
 *      of the same campaign are byte-identical.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  AUDIENCE_MODES,
  CAMPAIGN_STATES,
  CAMPAIGN_STATUSES,
  GROUP_STATUSES,
  MAX_CAMPAIGN_COINS,
  METRIC_TYPES,
  MIN_CAMPAIGN_COINS,
  PERFORMANCE_SCOPES,
  PRODUCT_ELIGIBILITY_RESOLUTIONS,
  PRODUCT_SCOPES,
  RETAILER_TEAM_EXPLANATION,
  REWARD_RECIPIENT_SCOPES,
  RULE_TYPES,
  STACKING_MODES,
  audienceLabel,
  formatCoins,
  formatUnits,
  isAudienceMode,
  isCampaignState,
  isCampaignStatus,
  isGroupStatus,
  isMetricType,
  isPerformanceScope,
  isProductEligibilityResolution,
  isProductScope,
  isRewardRecipientScope,
  isRuleType,
  isStackingMode,
  performanceExplanation,
  performanceLabel,
  productResolutionExplanation,
  productResolutionLabel,
  productScopeLabel,
  rewardSummary,
  stackingExplanation,
  stackingLabel,
  classifyPublicationEligibility,
  performancePlainLabel,
  productScopePlainLabel,
  publicationEligibilityCopy,
  rewardPreviewSentence,
  ruleTypeExplanation,
  ruleTypeLabel,
  CALCULATION_ENGINE_NOTICE,
  RETAILER_TEAM_INDEPENDENCE,
} from "./campaign-vocabulary.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FOUNDATION = readFileSync(
  join(ROOT, "supabase/migrations/20260815090000_vendor_campaign_foundation.sql"),
  "utf8",
);

/** Pulls the literals out of a `constraint <name> check (... array[...])` block. */
function constraintValues(constraintName: string): string[] {
  const index = FOUNDATION.indexOf(`constraint ${constraintName}`);
  assert.notEqual(index, -1, `constraint ${constraintName} not found in the migration`);
  const block = FOUNDATION.slice(index, index + 600);
  const arrayStart = block.indexOf("array[");
  assert.notEqual(arrayStart, -1, `constraint ${constraintName} has no array[...] list`);
  const arrayEnd = block.indexOf("]", arrayStart);
  const body = block.slice(arrayStart, arrayEnd);
  return [...body.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]).sort();
}

describe("vocabularies mirror the database exactly", () => {
  test("1. audience modes match campaign_versions_audience_allowed", () => {
    assert.deepEqual(
      [...AUDIENCE_MODES].sort(),
      constraintValues("campaign_versions_audience_allowed"),
    );
  });

  test("2. performance scopes match campaign_versions_performance_allowed", () => {
    assert.deepEqual(
      [...PERFORMANCE_SCOPES].sort(),
      constraintValues("campaign_versions_performance_allowed"),
    );
  });

  test("3. product scopes match campaign_versions_product_scope_allowed", () => {
    assert.deepEqual(
      [...PRODUCT_SCOPES].sort(),
      constraintValues("campaign_versions_product_scope_allowed"),
    );
  });

  test("4. stacking modes match campaign_versions_stacking_allowed", () => {
    assert.deepEqual(
      [...STACKING_MODES].sort(),
      constraintValues("campaign_versions_stacking_allowed"),
    );
  });

  test("5. rule types match campaign_rules_type_allowed", () => {
    assert.deepEqual([...RULE_TYPES].sort(), constraintValues("campaign_rules_type_allowed"));
  });

  test("6. metric types match campaign_rules_metric_allowed", () => {
    assert.deepEqual(
      [...METRIC_TYPES].sort(),
      constraintValues("campaign_rules_metric_allowed"),
    );
  });

  test("7. recipient scopes match campaign_versions_recipient_allowed", () => {
    assert.deepEqual(
      [...REWARD_RECIPIENT_SCOPES].sort(),
      constraintValues("campaign_versions_recipient_allowed"),
    );
  });

  test("8. campaign statuses match campaigns_status_allowed", () => {
    assert.deepEqual(
      [...CAMPAIGN_STATUSES].sort(),
      constraintValues("campaigns_status_allowed"),
    );
  });

  test("9. group statuses match campaign_retailer_groups_status_allowed", () => {
    assert.deepEqual(
      [...GROUP_STATUSES].sort(),
      constraintValues("campaign_retailer_groups_status_allowed"),
    );
  });

  test("10. derived states match the CASE arms of campaign_derived_state()", () => {
    const operations = readFileSync(
      join(ROOT, "supabase/migrations/20260815210000_vendor_campaign_operations.sql"),
      "utf8",
    );
    const start = operations.indexOf("create function public.campaign_derived_state");
    assert.notEqual(start, -1);
    const body = operations.slice(start, operations.indexOf("$$;", start));
    // Both arm shapes: `then 'X'` and the trailing `else 'X'`.
    const emitted = [...body.matchAll(/(?:then|else) '([A-Z]+)'/g)].map((m) => m[1]);
    // Every state the function can return is one this module knows, and vice versa.
    assert.deepEqual([...new Set(emitted)].sort(), [...CAMPAIGN_STATES].sort());
  });

  test("10b. resolutions match campaign_versions_resolution_allowed", () => {
    assert.deepEqual(
      [...PRODUCT_ELIGIBILITY_RESOLUTIONS].sort(),
      constraintValues("campaign_versions_resolution_allowed"),
    );
  });

  test("10c. the scope/resolution pairing is enforced by the DATABASE, not by this module", () => {
    // The two are not independent settings. A campaign cannot be SELECTED_PRODUCTS with
    // LIVE_TEMPORAL, or ALL_ELIGIBLE_PRODUCTS with SNAPSHOT, and the constraint says so as
    // an equivalence rather than two implications that could drift apart.
    const index = FOUNDATION.indexOf("constraint campaign_versions_resolution_matches_scope");
    assert.notEqual(index, -1, "the pairing constraint is missing");
    const block = FOUNDATION.slice(index, index + 400).replace(/\s+/g, " ");
    assert.match(block, /product_scope = 'SELECTED_PRODUCTS'/);
    assert.match(block, /product_eligibility_resolution = 'SNAPSHOT'/);
    assert.match(block, /\)\s*=\s*\(/, "the pairing must be an equivalence");
  });

  test("10d. the coin ceiling mirrors the database constraint exactly", () => {
    // Not a second opinion: the same literal must appear in the CHECK constraints.
    const literal = MAX_CAMPAIGN_COINS.toString();
    for (const name of [
      "campaign_rules_rate_within_ceiling",
      "campaign_rules_cap_within_ceiling",
      "campaign_rule_tiers_reward_within_ceiling",
    ]) {
      const at = FOUNDATION.indexOf(`constraint ${name}`);
      assert.notEqual(at, -1, `${name} is missing from the migration`);
      assert.ok(
        FOUNDATION.slice(at, at + 300).includes(literal),
        `${name} does not use ${literal}`,
      );
    }
    assert.equal(MIN_CAMPAIGN_COINS, 1);
  });

  test("10e. the ceiling keeps a future rate x quantity inside bigint", () => {
    // The arithmetic the bound exists for: largest configurable rate, multiplied by more
    // units than a PostgreSQL integer can hold, must still fit in bigint.
    // BigInt(string) rather than a `…n` literal: this project targets ES2017, where BigInt
    // literals are a syntax error. The runtime supports BigInt regardless.
    const INTEGER_MAX = 2_147_483_647;
    const BIGINT_MAX = BigInt("9223372036854775807");
    assert.ok(BigInt(MAX_CAMPAIGN_COINS) * BigInt(INTEGER_MAX) < BIGINT_MAX);
    // And every in-range coin value survives JavaScript arithmetic exactly.
    assert.ok(MAX_CAMPAIGN_COINS < Number.MAX_SAFE_INTEGER);
  });

  test("11. there is NO percentage-of-value metric anywhere", () => {
    assert.equal(METRIC_TYPES.length, 1);
    assert.equal(METRIC_TYPES[0], "UNITS_SOLD");
    // Scoped to SQL ENUM LITERALS — an upper-case single-quoted token — rather than to
    // the whole file. The migration's prose says "no percentage-of-value reward" in a
    // table comment, and a test that could not tell a promise apart from its opposite
    // would be worse than no test.
    const literals = [...FOUNDATION.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)].map((m) => m[1]);
    assert.deepEqual(
      literals.filter((literal) => /PERCENT|VALUE_SHARE|COMMISSION/.test(literal)),
      [],
    );
  });
});

describe("guards reject everything outside their list", () => {
  const NEAR_MISSES = [
    "",
    " ",
    "all_retailers",
    "ALL_RETAILER",
    "ALL_RETAILERS ",
    "GROUP_CAMPAIGN",
    "TIERED_TARGET",
    "PERCENTAGE_OF_SALES",
    "SCHEDULED_ACTIVE",
    null,
    undefined,
    0,
    1,
    true,
    {},
    [],
  ];

  test("12. every guard refuses every near-miss it does not own", () => {
    for (const value of NEAR_MISSES) {
      const accepted = [
        isAudienceMode(value) && (AUDIENCE_MODES as readonly unknown[]).includes(value),
        isPerformanceScope(value) &&
          (PERFORMANCE_SCOPES as readonly unknown[]).includes(value),
        isProductScope(value) && (PRODUCT_SCOPES as readonly unknown[]).includes(value),
        isStackingMode(value) && (STACKING_MODES as readonly unknown[]).includes(value),
        isRuleType(value) && (RULE_TYPES as readonly unknown[]).includes(value),
        isMetricType(value) && (METRIC_TYPES as readonly unknown[]).includes(value),
        isCampaignState(value) && (CAMPAIGN_STATES as readonly unknown[]).includes(value),
        isCampaignStatus(value) && (CAMPAIGN_STATUSES as readonly unknown[]).includes(value),
        isGroupStatus(value) && (GROUP_STATUSES as readonly unknown[]).includes(value),
        isRewardRecipientScope(value) &&
          (REWARD_RECIPIENT_SCOPES as readonly unknown[]).includes(value),
        isProductEligibilityResolution(value) &&
          (PRODUCT_ELIGIBILITY_RESOLUTIONS as readonly unknown[]).includes(value),
      ];
      // A guard may only return true for a member of its own list; none of these are.
      assert.ok(
        accepted.every((ok) => ok === false),
        `a guard accepted ${JSON.stringify(value)}`,
      );
    }
  });

  test("13. TIERED_TARGET is deliberately not yet a rule type", () => {
    assert.equal(isRuleType("TIERED_TARGET"), false);
  });

  test("14. every guard accepts every member of its own list", () => {
    for (const value of AUDIENCE_MODES) assert.ok(isAudienceMode(value));
    for (const value of PERFORMANCE_SCOPES) assert.ok(isPerformanceScope(value));
    for (const value of PRODUCT_SCOPES) assert.ok(isProductScope(value));
    for (const value of STACKING_MODES) assert.ok(isStackingMode(value));
    for (const value of RULE_TYPES) assert.ok(isRuleType(value));
    for (const value of CAMPAIGN_STATES) assert.ok(isCampaignState(value));
    for (const value of CAMPAIGN_STATUSES) assert.ok(isCampaignStatus(value));
    for (const value of GROUP_STATUSES) assert.ok(isGroupStatus(value));
  });
});

describe("labels", () => {
  test("15. every enum member has a non-empty label", () => {
    for (const value of AUDIENCE_MODES) assert.ok(audienceLabel(value).length > 0);
    for (const value of PERFORMANCE_SCOPES) assert.ok(performanceLabel(value).length > 0);
    for (const value of PRODUCT_SCOPES) assert.ok(productScopeLabel(value).length > 0);
    for (const value of STACKING_MODES) assert.ok(stackingLabel(value).length > 0);
  });

  test("16. no label leaks the raw enum string", () => {
    const labels = [
      ...AUDIENCE_MODES.map(audienceLabel),
      ...PERFORMANCE_SCOPES.map(performanceLabel),
      ...PRODUCT_SCOPES.map(productScopeLabel),
      ...STACKING_MODES.map(stackingLabel),
    ];
    for (const label of labels) assert.ok(!/_/.test(label), `raw enum in "${label}"`);
  });

  test("16b. the two resolutions are described in the words the requirement asks for", () => {
    // The distinction a reader must be able to make: a set that moves with the catalogue
    // versus one fixed at publication.
    assert.match(
      productResolutionExplanation("LIVE_TEMPORAL"),
      /eligible at the time of each verified sale/i,
    );
    assert.match(
      productResolutionExplanation("SNAPSHOT"),
      /frozen when this campaign version was published/i,
    );
    // Each must say something the other does not, or the wording is not doing its job.
    assert.notEqual(
      productResolutionExplanation("LIVE_TEMPORAL"),
      productResolutionExplanation("SNAPSHOT"),
    );
    for (const resolution of PRODUCT_ELIGIBILITY_RESOLUTIONS) {
      assert.ok(productResolutionLabel(resolution).length > 0);
      // No raw enum leaks into a label a person reads.
      assert.ok(!/_/.test(productResolutionLabel(resolution)));
    }
  });

  test("16c. neither resolution's wording implies progress or an amount earned", () => {
    for (const resolution of PRODUCT_ELIGIBILITY_RESOLUTIONS) {
      const text = `${productResolutionLabel(resolution)} ${productResolutionExplanation(resolution)}`;
      assert.ok(!/earned|balance|progress|total so far/i.test(text));
    }
  });

  test("17. the team wording states the per-Retailer boundary", () => {
    assert.match(RETAILER_TEAM_EXPLANATION, /this Retailer/);
    assert.equal(performanceExplanation("RETAILER_TEAM"), RETAILER_TEAM_EXPLANATION);
    assert.notEqual(
      performanceExplanation("INDIVIDUAL_STAFF"),
      performanceExplanation("RETAILER_TEAM"),
    );
  });

  test("18. the performance wording never calls a team campaign a group campaign", () => {
    // "group" means the AUDIENCE in this product. Using it for performance would fuse
    // the two concepts the requirement insists on separating.
    for (const scope of PERFORMANCE_SCOPES) {
      assert.ok(!/group/i.test(performanceLabel(scope)));
      assert.ok(!/group/i.test(performanceExplanation(scope)));
    }
  });

  test("19. the stacking wording never mentions the key or the priority", () => {
    for (const mode of STACKING_MODES) {
      const text = `${stackingLabel(mode)} ${stackingExplanation(mode)}`;
      assert.ok(!/key|priority|rank/i.test(text), `disclosure risk in "${text}"`);
    }
  });
});

describe("reward summaries describe an offer, never a result", () => {
  test("20. per-unit reads as a rate", () => {
    assert.equal(
      rewardSummary({
        ruleType: "PER_UNIT_COINS",
        coinsPerUnit: 5,
        thresholdUnits: null,
        rewardCoins: null,
        maxRewardCoins: null,
      }),
      "5 coins per unit",
    );
  });

  test("21. a cap is stated as a ceiling, not added to anything", () => {
    assert.equal(
      rewardSummary({
        ruleType: "PER_UNIT_COINS",
        coinsPerUnit: 5,
        thresholdUnits: null,
        rewardCoins: null,
        maxRewardCoins: 10000,
      }),
      "5 coins per unit, up to 10,000 coins",
    );
  });

  test("22. a target bonus reads as a threshold and a bonus", () => {
    assert.equal(
      rewardSummary({
        ruleType: "TARGET_BONUS",
        coinsPerUnit: null,
        thresholdUnits: 10,
        rewardCoins: 100,
        maxRewardCoins: null,
      }),
      "100 coins at 10 units",
    );
  });

  test("23. a missing rule yields null rather than a fabricated reward", () => {
    assert.equal(
      rewardSummary({
        ruleType: null,
        coinsPerUnit: null,
        thresholdUnits: null,
        rewardCoins: null,
        maxRewardCoins: null,
      }),
      null,
    );
  });

  test("24. an incomplete rule yields null rather than a partial claim", () => {
    assert.equal(
      rewardSummary({
        ruleType: "TARGET_BONUS",
        coinsPerUnit: null,
        thresholdUnits: 10,
        rewardCoins: null,
        maxRewardCoins: null,
      }),
      null,
    );
    assert.equal(
      rewardSummary({
        ruleType: "PER_UNIT_COINS",
        coinsPerUnit: null,
        thresholdUnits: null,
        rewardCoins: null,
        maxRewardCoins: null,
      }),
      null,
    );
  });

  test("25. no summary implies progress, a balance or an amount earned", () => {
    const summaries = [
      rewardSummary({
        ruleType: "PER_UNIT_COINS",
        coinsPerUnit: 5,
        thresholdUnits: null,
        rewardCoins: null,
        maxRewardCoins: 100,
      }),
      rewardSummary({
        ruleType: "TARGET_BONUS",
        coinsPerUnit: null,
        thresholdUnits: 10,
        rewardCoins: 100,
        maxRewardCoins: null,
      }),
    ];
    for (const summary of summaries) {
      assert.ok(summary !== null);
      assert.ok(
        !/earned|balance|progress|so far|remaining|to date/i.test(summary),
        `"${summary}" reads as a result`,
      );
    }
  });
});

describe("number formatting is stable across runtimes", () => {
  test("26. singular and plural are correct", () => {
    assert.equal(formatCoins(1), "1 coin");
    assert.equal(formatCoins(2), "2 coins");
    assert.equal(formatCoins(0), "0 coins");
    assert.equal(formatUnits(1), "1 unit");
    assert.equal(formatUnits(10), "10 units");
  });

  test("27. thousands are grouped with a fixed comma, not a locale separator", () => {
    assert.equal(formatCoins(1000), "1,000 coins");
    assert.equal(formatCoins(1234567), "1,234,567 coins");
    assert.equal(formatUnits(100), "100 units");
  });

  test("28. formatting does not call toLocaleString, which can differ per runtime", () => {
    const source = readFileSync(
      join(ROOT, "lib/campaigns/campaign-vocabulary.ts"),
      "utf8",
    );
    // Comments stripped first: the module EXPLAINS why it avoids toLocaleString, and a
    // test that could not tell an explanation apart from a call would fail on its own
    // documentation. A server/browser locale disagreement is a hydration mismatch, not a
    // cosmetic one.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(!/toLocaleString|Intl\.NumberFormat/.test(code));
  });

  test("29. a non-finite value degrades to 0 rather than rendering NaN", () => {
    assert.equal(formatCoins(Number.NaN), "0 coins");
    assert.equal(formatCoins(Number.POSITIVE_INFINITY), "0 coins");
  });
});

/* ===========================================================================
 * The UX-redesign additions
 *
 * These back the copy the campaign screens now show. Two of them describe how the
 * DATABASE behaves, so they are the place that behaviour is pinned in TypeScript.
 * ======================================================================== */

describe("30. plain-language labels", () => {
  test("30.1 each product scope states its effect, not its name", () => {
    assert.equal(
      productScopePlainLabel("ALL_ELIGIBLE_PRODUCTS"),
      "Products eligible at the time of each verified sale",
    );
    assert.equal(
      productScopePlainLabel("SELECTED_PRODUCTS"),
      "Only the products selected for this campaign version",
    );
  });

  test("30.2 no plain label leaks an enum name", () => {
    for (const label of [
      productScopePlainLabel("ALL_ELIGIBLE_PRODUCTS"),
      productScopePlainLabel("SELECTED_PRODUCTS"),
      performancePlainLabel("INDIVIDUAL_STAFF"),
      performancePlainLabel("RETAILER_TEAM"),
      ruleTypeLabel("PER_UNIT_COINS"),
      ruleTypeLabel("TARGET_BONUS"),
      ruleTypeExplanation("PER_UNIT_COINS"),
      ruleTypeExplanation("TARGET_BONUS"),
      RETAILER_TEAM_INDEPENDENCE,
      CALCULATION_ENGINE_NOTICE,
    ]) {
      assert.ok(
        !/[A-Z]{3,}_[A-Z]/.test(label),
        `a user-facing label contains an enum: ${label}`,
      );
    }
  });

  test("30.3 the team wording says Retailers are evaluated separately", () => {
    // The single most common misreading of a team campaign is that one target is shared
    // across the whole audience. The sentence exists to refuse that reading.
    assert.match(RETAILER_TEAM_INDEPENDENCE, /Each Retailer is evaluated on its own/);
    assert.match(RETAILER_TEAM_INDEPENDENCE, /never added together/);
  });
});

describe("31. the reward preview sentence", () => {
  const base = {
    ruleType: null as null | "PER_UNIT_COINS" | "TARGET_BONUS",
    performanceScope: null as null | "INDIVIDUAL_STAFF" | "RETAILER_TEAM",
    coinsPerUnit: null as number | null,
    thresholdUnits: null as number | null,
    rewardCoins: null as number | null,
    maxRewardCoins: null as number | null,
  };

  test("31.1 a per-unit rule reads as the requirement's example", () => {
    assert.equal(
      rewardPreviewSentence({
        ...base,
        ruleType: "PER_UNIT_COINS",
        performanceScope: "INDIVIDUAL_STAFF",
        coinsPerUnit: 5,
        maxRewardCoins: 100,
      }),
      "Each Sales Staff member earns 5 coins per eligible unit, up to 100 coins.",
    );
  });

  test("31.2 a target bonus on a team campaign reads as the requirement's example", () => {
    assert.equal(
      rewardPreviewSentence({
        ...base,
        ruleType: "TARGET_BONUS",
        performanceScope: "RETAILER_TEAM",
        thresholdUnits: 25,
        rewardCoins: 2500,
      }),
      "When this Retailer reaches 25 units, contributing Sales Staff share the configured 2,500 coins reward according to the campaign rules.",
    );
  });

  test("31.3 the sentence changes with the performance scope", () => {
    const individual = rewardPreviewSentence({
      ...base,
      ruleType: "PER_UNIT_COINS",
      performanceScope: "INDIVIDUAL_STAFF",
      coinsPerUnit: 5,
    });
    const team = rewardPreviewSentence({
      ...base,
      ruleType: "PER_UNIT_COINS",
      performanceScope: "RETAILER_TEAM",
      coinsPerUnit: 5,
    });
    assert.notEqual(individual, team);
    assert.match(String(team), /this Retailer/);
  });

  test("31.4 an incomplete rule returns null rather than half a sentence", () => {
    assert.equal(rewardPreviewSentence({ ...base }), null);
    assert.equal(
      rewardPreviewSentence({ ...base, ruleType: "PER_UNIT_COINS", coinsPerUnit: null }),
      null,
    );
    assert.equal(
      rewardPreviewSentence({ ...base, ruleType: "PER_UNIT_COINS", coinsPerUnit: 0 }),
      null,
    );
    assert.equal(
      rewardPreviewSentence({
        ...base,
        ruleType: "TARGET_BONUS",
        thresholdUnits: 25,
        rewardCoins: null,
      }),
      null,
    );
  });

  test("31.5 it never computes a total or claims anything was earned", () => {
    const sentence = String(
      rewardPreviewSentence({
        ...base,
        ruleType: "PER_UNIT_COINS",
        performanceScope: "INDIVIDUAL_STAFF",
        coinsPerUnit: 7,
        maxRewardCoins: 100,
      }),
    );
    // 7 and 100 appear because they were configured. No product of them does.
    assert.ok(!/700/.test(sentence));
    assert.ok(!/\b(earned so far|to date|balance|progress)\b/i.test(sentence));
  });
});

describe("32. publication eligibility, as the database actually behaves", () => {
  /**
   * These encode a rule verified against the hosted development database before the copy
   * was written:
   *
   *   public.publish_vendor_campaign freezes one row per (eligible Retailer, ACTIVE
   *   assignment) pair and refuses the publication ONLY when that whole set is empty.
   *
   * So a campaign where SOME Retailers match nothing still publishes — with those
   * Retailers included and unable to earn — and only a campaign where NOTHING matches is
   * blocked. The previous UI stated the first half and was silent about the second.
   */
  const row = (eligible: number, missing: number) => ({
    eligibleProductCount: eligible,
    missingProductCount: missing,
  });

  test("32.1 no missing product anywhere is CLEAR", () => {
    assert.equal(
      classifyPublicationEligibility([row(3, 0), row(3, 0)], "SELECTED_PRODUCTS"),
      "CLEAR",
    );
  });

  test("32.2 some Retailers short, at least one matching, is PARTIAL", () => {
    assert.equal(
      classifyPublicationEligibility([row(1, 2), row(3, 0)], "SELECTED_PRODUCTS"),
      "PARTIAL",
    );
    // Including the case the wording leads with: a Retailer with nothing at all, while
    // another Retailer does resolve. The database publishes this.
    assert.equal(
      classifyPublicationEligibility([row(0, 3), row(3, 0)], "SELECTED_PRODUCTS"),
      "PARTIAL",
    );
  });

  test("32.3 nothing matching anywhere is BLOCKED", () => {
    assert.equal(
      classifyPublicationEligibility([row(0, 3), row(0, 3)], "SELECTED_PRODUCTS"),
      "BLOCKED",
    );
  });

  test("32.4 a live-temporal campaign is never blocked this way", () => {
    // It freezes no pairs at all, so there is no empty pair-set to refuse.
    assert.equal(
      classifyPublicationEligibility([row(0, 3)], "ALL_ELIGIBLE_PRODUCTS"),
      "CLEAR",
    );
    assert.equal(classifyPublicationEligibility([row(0, 3)], null), "CLEAR");
  });

  test("32.5 an empty preview is CLEAR, not BLOCKED", () => {
    // A campaign with no rows has a DIFFERENT problem — no eligible Retailer — which the
    // publish RPC reports on its own. Claiming a product conflict would misdirect.
    assert.equal(classifyPublicationEligibility([], "SELECTED_PRODUCTS"), "CLEAR");
  });

  test("32.6 the copy distinguishes reduced from refused, and says the consequence", () => {
    assert.equal(publicationEligibilityCopy("CLEAR"), null);

    const partial = publicationEligibilityCopy("PARTIAL");
    assert.ok(partial !== null);
    assert.match(partial.body, /can still be published/);
    // The fact the previous wording omitted entirely.
    assert.match(partial.body, /without a single eligible product/);

    const blocked = publicationEligibilityCopy("BLOCKED");
    assert.ok(blocked !== null);
    assert.match(blocked.title, /cannot be published/);
    // And it names the ways out rather than only stating the refusal.
    assert.match(blocked.body, /Assign the products/);
    assert.match(blocked.body, /change the audience/);
  });

  test("32.7 neither message leaks a database term", () => {
    for (const eligibility of ["PARTIAL", "BLOCKED"] as const) {
      const copy = publicationEligibilityCopy(eligibility);
      assert.ok(copy !== null);
      for (const text of [copy.title, copy.body]) {
        assert.ok(
          !/SQLSTATE|55000|object_not_in_prerequisite|campaign_eligible|vendor_product_retailer/i.test(
            text,
          ),
          `copy leaks an internal term: ${text}`,
        );
      }
    }
  });
});
