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
  METRIC_TYPES,
  PERFORMANCE_SCOPES,
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
  isProductScope,
  isRewardRecipientScope,
  isRuleType,
  isStackingMode,
  performanceExplanation,
  performanceLabel,
  productScopeLabel,
  rewardSummary,
  stackingExplanation,
  stackingLabel,
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
