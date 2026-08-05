/**
 * Tests for the Web Sales Staff Current Campaigns and My Campaign Earnings UI.
 *
 * Run with:  npm test
 *
 * Two kinds, matching every other suite in this repository:
 *
 *   1. REAL UNIT TESTS of the pure modules — the normalizers and the presentation
 *      helpers. Every rule is exercised by CALLING the function, never by reading its
 *      source.
 *
 *   2. SOURCE-SCANNING CONTRACT TESTS of the adapters and the three pages. Those are
 *      `server-only` modules and Server Components: they cannot be invoked here. What
 *      they must NOT do is still checkable, and for this feature the most valuable
 *      properties are NEGATIVE ones — no reward may be calculated in TypeScript, no
 *      verified sale id may be rendered, no table may be read directly, no service-role
 *      client may be used, and no database message may reach a browser.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY SOURCE RULE, so no comment can satisfy a security
 * test. These files discuss at length the very identifiers the rules forbid.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  isEarningPerformanceScope,
  isRewardRuleType,
  normalizeEarningsSummary,
  normalizeRewardEntries,
  normalizeTargetProgress,
  type CampaignRewardEntry,
} from "./earnings-normalization.ts";
import {
  CAMPAIGNS_UNAVAILABLE_MESSAGE,
  CURSOR_AWARDED_AT_PARAM,
  CURSOR_REWARD_ID_PARAM,
  EARNINGS_UNAVAILABLE_MESSAGE,
  NOT_A_WALLET_NOTICE,
  NO_CAMPAIGNS_MESSAGE,
  NO_PRODUCTS_MESSAGE,
  NO_REWARDS_MESSAGE,
  REWARDS_PAGE_SIZE,
  TEAM_PROGRESS_EXPLANATION,
  capReduction,
  formatCoins,
  formatEarningsDate,
  formatUnits,
  nextRewardCursor,
  parseRewardCursor,
  progressAriaLabel,
  progressByCampaignId,
  progressPercent,
  progressScopeExplanation,
  progressScopeLabel,
  receiptReference,
  rewardCursorHref,
  rewardRuleLabel,
  targetOutcome,
  targetStatement,
  wasCapped,
} from "./earnings-presentation.ts";

/* ---------------------------------------------------------------------------
 * Source access
 * ------------------------------------------------------------------------- */

const ROOT = join(import.meta.dirname, "..", "..");

const STAFF_CAMPAIGNS_ADAPTER = join(ROOT, "lib/campaigns/staff-campaigns.ts");
const STAFF_EARNINGS_ADAPTER = join(ROOT, "lib/earnings/staff-earnings.ts");
const CAMPAIGNS_PAGE = join(
  ROOT,
  "app/(retailer)/retailer/my-campaigns/page.tsx",
);
const CAMPAIGN_DETAIL_PAGE = join(
  ROOT,
  "app/(retailer)/retailer/my-campaigns/[campaignId]/page.tsx",
);
const EARNINGS_PAGE = join(ROOT, "app/(retailer)/retailer/my-earnings/page.tsx");
const NAV_ITEMS = join(ROOT, "components/retailer-portal/retailer-nav-items.tsx");
const FIXTURE = join(
  ROOT,
  "scripts/sales-staff-campaigns-earnings-manual-fixture.mjs",
);

/** Source with comments stripped, so prose can neither satisfy nor trip a rule. */
function code(path: string): string {
  const raw = readFileSync(path, "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const ALL_FEATURE_SOURCES = [
  STAFF_CAMPAIGNS_ADAPTER,
  STAFF_EARNINGS_ADAPTER,
  CAMPAIGNS_PAGE,
  CAMPAIGN_DETAIL_PAGE,
  EARNINGS_PAGE,
];

/* ---------------------------------------------------------------------------
 * Row builders
 * ------------------------------------------------------------------------- */

function rewardRow(overrides: Record<string, unknown> = {}) {
  return {
    campaign_reward_id: "11111111-1111-4111-8111-111111111111",
    campaign_id: "22222222-2222-4222-8222-222222222222",
    campaign_version_id: "33333333-3333-4333-8333-333333333333",
    campaign_name: "Summer Push",
    receipt_submission_id: "44444444-4444-4444-8444-444444444444",
    shop_name: "Downtown",
    sale_at: "2026-08-01T10:00:00+00:00",
    awarded_at: "2026-08-01T11:00:00+00:00",
    rule_type: "PER_UNIT_COINS",
    performance_scope: "INDIVIDUAL_STAFF",
    qualifying_item_count: 2,
    qualifying_units: 5,
    coins_uncapped: 35,
    coins_capped_to: null,
    reward_coins: 35,
    threshold_units: null,
    configured_reward_coins: null,
    ...overrides,
  };
}

function summaryRow(overrides: Record<string, unknown> = {}) {
  return {
    total_reward_coins: 165,
    current_month_reward_coins: 165,
    rewarded_sale_count: 1,
    rewarded_campaign_count: 5,
    latest_reward_at: "2026-08-01T11:00:00+00:00",
    current_month_start_utc: "2026-08-01T00:00:00+00:00",
    current_month_end_utc: "2026-09-01T00:00:00+00:00",
    ...overrides,
  };
}

function progressRow(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: "22222222-2222-4222-8222-222222222222",
    campaign_version_id: "33333333-3333-4333-8333-333333333333",
    campaign_name: "Target Push",
    performance_scope: "INDIVIDUAL_STAFF",
    target_units: 3,
    configured_reward_coins: 100,
    progress_units: 5,
    target_reached: true,
    bonus_awarded_to_me: true,
    ...overrides,
  };
}

function entry(overrides: Partial<CampaignRewardEntry> = {}): CampaignRewardEntry {
  const normalized = normalizeRewardEntries([rewardRow()]);
  assert.equal(normalized.status, "ok");
  if (normalized.status !== "ok") throw new Error("unreachable");
  return { ...normalized.rewards[0], ...overrides };
}

/* =========================================================================
 * 1-14. RPC ADAPTERS
 * ======================================================================= */
describe("1. the adapters call exactly the deployed RPCs, by exact name", () => {
  const campaigns = code(STAFF_CAMPAIGNS_ADAPTER);
  const earnings = code(STAFF_EARNINGS_ADAPTER);

  test("1. list_my_staff_campaigns is called by its exact deployed name", () => {
    assert.match(campaigns, /"list_my_staff_campaigns"/);
  });

  test("2. get_my_staff_campaign is called by its exact deployed name", () => {
    assert.match(campaigns, /"get_my_staff_campaign"/);
  });

  test("3. list_my_staff_campaign_products is called by its exact deployed name", () => {
    assert.match(campaigns, /"list_my_staff_campaign_products"/);
  });

  test("4. get_my_campaign_rewards is called by its exact deployed name", () => {
    assert.match(earnings, /"get_my_campaign_rewards"/);
  });

  test("5. get_my_campaign_earnings_summary is called by its exact deployed name", () => {
    assert.match(earnings, /"get_my_campaign_earnings_summary"/);
  });

  test("6. get_my_campaign_target_progress is called by its exact deployed name", () => {
    assert.match(earnings, /"get_my_campaign_target_progress"/);
  });

  test("7. NO profile id is ever supplied as a parameter", () => {
    for (const path of ALL_FEATURE_SOURCES) {
      assert.doesNotMatch(
        code(path),
        /p_(profile|beneficiary|staff|user)_?(id|profile_id)?\s*:/,
        `${path} supplies a profile parameter`,
      );
    }
  });

  test("8. NO Retailer, Vendor or shop override is ever supplied", () => {
    for (const path of ALL_FEATURE_SOURCES) {
      assert.doesNotMatch(
        code(path),
        /p_(retailer|vendor|shop|organization)[a-z_]*\s*:/,
        `${path} supplies a tenant override`,
      );
    }
  });

  test("9. the campaign reads pass p_campaign_id, the deployed argument name", () => {
    assert.match(campaigns, /p_campaign_id:/);
    // Migration 30 has NO version-keyed argument. Sending one would simply be ignored,
    // which is worse than failing: the page would silently read the wrong campaign.
    assert.doesNotMatch(campaigns, /p_campaign_version_id/);
  });

  test("9b. reward pagination uses the exact deployed argument names", () => {
    assert.match(earnings, /p_limit:/);
    assert.match(earnings, /p_before_awarded_at:/);
    assert.match(earnings, /p_before_reward_id:/);
  });

  test("10. verified_sale_id appears in NO adapter, page or type", () => {
    for (const path of [...ALL_FEATURE_SOURCES, join(ROOT, "lib/earnings/earnings-normalization.ts")]) {
      assert.doesNotMatch(
        code(path),
        /verified_sale_id|verifiedSaleId/,
        `${path} references a verified sale id`,
      );
    }
  });

  test("11. receipt_submission_id is preserved through normalization", () => {
    const normalized = normalizeRewardEntries([rewardRow()]);
    assert.equal(normalized.status, "ok");
    if (normalized.status !== "ok") return;
    assert.equal(
      normalized.rewards[0].receiptSubmissionId,
      "44444444-4444-4444-8444-444444444444",
    );
  });

  test("12. bigint values are narrowed safely and unsafe ones are refused", () => {
    // A bigint that fits arrives as a number.
    const asNumber = normalizeRewardEntries([rewardRow({ reward_coins: 35 })]);
    assert.equal(asNumber.status, "ok");

    // One that does not fit arrives as a STRING, and is accepted when safe.
    const asString = normalizeRewardEntries([
      rewardRow({ reward_coins: "9007199254740991" }),
    ]);
    assert.equal(asString.status, "ok");
    if (asString.status === "ok") {
      assert.equal(asString.rewards[0].rewardCoins, 9007199254740991);
    }

    // Beyond MAX_SAFE_INTEGER it is REFUSED, never rounded.
    const unsafe = normalizeRewardEntries([
      rewardRow({ reward_coins: "9007199254740993" }),
    ]);
    assert.equal(unsafe.status, "malformed");

    const unsafeSummary = normalizeEarningsSummary([
      summaryRow({ total_reward_coins: "99999999999999999999" }),
    ]);
    assert.equal(unsafeSummary.status, "malformed");
  });

  test("13. raw database messages are never read or exposed — only the SQLSTATE", () => {
    for (const path of [STAFF_CAMPAIGNS_ADAPTER, STAFF_EARNINGS_ADAPTER]) {
      const source = code(path);
      assert.match(source, /code\?:\s*string/);
      assert.doesNotMatch(
        source,
        /error\.(message|details|hint)/,
        `${path} reads a database message`,
      );
    }
  });

  test("14. NO service-role client is used by any feature module", () => {
    for (const path of ALL_FEATURE_SOURCES) {
      const source = code(path);
      assert.doesNotMatch(source, /service_?[Rr]ole/, `${path} names service role`);
      assert.doesNotMatch(
        source,
        /createServiceClient|createAdminClient|SUPABASE_SERVICE/,
        `${path} builds a privileged client`,
      );
    }
  });

  test("14b. both adapters are server-only and use the session client", () => {
    for (const path of [STAFF_CAMPAIGNS_ADAPTER, STAFF_EARNINGS_ADAPTER]) {
      const source = code(path);
      assert.match(source, /import\s+"server-only"/);
      assert.match(source, /@\/lib\/supabase\/server/);
    }
  });
});

/* =========================================================================
 * 15-28. CURRENT CAMPAIGNS
 * ======================================================================= */
describe("2. the Current Campaigns page", () => {
  const page = code(CAMPAIGNS_PAGE);

  test("15. it renders campaigns from the staff list read", () => {
    assert.match(page, /listMyStaffCampaigns/);
    assert.match(page, /campaigns\.filter/);
  });

  test("16 & 17. ACTIVE and SCHEDULED are the sections, and the badge names them", () => {
    assert.match(page, /"ACTIVE"/);
    assert.match(page, /"SCHEDULED"/);
    assert.match(page, /CampaignStateBadge/);
  });

  test("18. the empty state uses the approved sentence", () => {
    assert.equal(
      NO_CAMPAIGNS_MESSAGE,
      "No active or upcoming campaigns are available for your shop.",
    );
    assert.match(page, /NO_CAMPAIGNS_MESSAGE/);
  });

  test("19. campaign cards link by the authoritative campaign id", () => {
    assert.match(page, /\/retailer\/my-campaigns\/\$\{campaign\.campaignId\}/);
    // Never by name — two campaigns may share one.
    assert.doesNotMatch(page, /my-campaigns\/\$\{campaign\.campaignName\}/);
  });

  test("20. no draft terminology or draft state is referenced", () => {
    for (const path of [CAMPAIGNS_PAGE, CAMPAIGN_DETAIL_PAGE]) {
      assert.doesNotMatch(code(path), /"DRAFT"|Draft|draft/, `${path} mentions drafts`);
    }
  });

  test("21 & 22. both rule types are rendered through the shared vocabulary", () => {
    assert.match(page, /rewardSummary/);
    assert.equal(rewardRuleLabel("PER_UNIT_COINS"), "Coins per unit");
    assert.equal(rewardRuleLabel("TARGET_BONUS"), "Target bonus");
  });

  test("23. individual progress is labelled as the seller's own", () => {
    assert.equal(progressScopeLabel("INDIVIDUAL_STAFF"), "Your progress");
    assert.equal(
      progressScopeExplanation("INDIVIDUAL_STAFF"),
      "This total counts your own qualifying units.",
    );
  });

  test("24. RETAILER_TEAM progress is labelled TEAM progress and explained", () => {
    assert.equal(progressScopeLabel("RETAILER_TEAM"), "Team progress");
    assert.equal(progressScopeExplanation("RETAILER_TEAM"), TEAM_PROGRESS_EXPLANATION);
    assert.match(TEAM_PROGRESS_EXPLANATION, /everyone at your Retailer, not only yours/);
  });

  test("25. bonus_awarded_to_me true is the ONLY case that says you received it", () => {
    const awarded = targetStatement({
      performanceScope: "INDIVIDUAL_STAFF",
      targetReached: true,
      bonusAwardedToMe: true,
    });
    assert.equal(awarded.outcome, "awarded");
    assert.equal(awarded.label, "Bonus awarded to you");
    assert.match(awarded.detail, /You received/);
  });

  test("26. a TEAM target crossed by a colleague NEVER claims a personal bonus", () => {
    const teamCrossed = targetStatement({
      performanceScope: "RETAILER_TEAM",
      targetReached: true,
      bonusAwardedToMe: false,
    });
    assert.equal(teamCrossed.outcome, "reached-not-yours");
    assert.equal(teamCrossed.label, "Team target reached");
    // It must say plainly that the bonus went elsewhere.
    assert.match(teamCrossed.detail, /awarded to another team member/);
    // And it must never use the first person about earning.
    assert.doesNotMatch(teamCrossed.detail, /You received|you earned|Bonus awarded to you/i);
  });

  test("26b. an individual target reached without a reward reads as pending, not denied", () => {
    const pending = targetStatement({
      performanceScope: "INDIVIDUAL_STAFF",
      targetReached: true,
      bonusAwardedToMe: false,
    });
    assert.equal(pending.outcome, "reached-pending");
    assert.doesNotMatch(pending.detail, /not eligible|denied|refused/i);
    assert.match(pending.detail, /once the sale that crossed it has been verified/);
  });

  test("26c. every outcome is reachable and total", () => {
    assert.equal(
      targetOutcome({
        performanceScope: "INDIVIDUAL_STAFF",
        targetReached: false,
        bonusAwardedToMe: false,
      }),
      "not-reached",
    );
    // An awarded bonus wins even if targetReached were somehow false.
    assert.equal(
      targetOutcome({
        performanceScope: "RETAILER_TEAM",
        targetReached: false,
        bonusAwardedToMe: true,
      }),
      "awarded",
    );
  });

  test("27. NO accumulator identifier is referenced anywhere in the feature", () => {
    for (const path of [
      ...ALL_FEATURE_SOURCES,
      join(ROOT, "lib/earnings/earnings-normalization.ts"),
      join(ROOT, "lib/earnings/earnings-presentation.ts"),
    ]) {
      const source = code(path);
      assert.doesNotMatch(
        source,
        /cap_subject_type|cap_subject_id|capSubject|units_counted_total|coins_awarded_total|target_bonus_awarded\b/,
        `${path} references accumulator internals`,
      );
    }
  });

  test("28. a campaign with no progress row renders no progress bar", () => {
    // The page renders the block only when a progress row exists for that campaign, and
    // only TARGET_BONUS campaigns appear in the progress contract.
    assert.match(page, /progress !== undefined && <TargetProgressBlock/);
    const byId = progressByCampaignId([]);
    assert.equal(byId.get("22222222-2222-4222-8222-222222222222"), undefined);
  });

  test("28b. progress joins on campaign id, never on display name", () => {
    const normalized = normalizeTargetProgress([progressRow()]);
    assert.equal(normalized.status, "ok");
    if (normalized.status !== "ok") return;
    const byId = progressByCampaignId(normalized.progress);
    assert.equal(byId.size, 1);
    assert.ok(byId.has("22222222-2222-4222-8222-222222222222"));
    assert.equal(byId.has("Target Push"), false);
  });

  test("28c. a duplicate campaign id keeps the first row rather than picking arbitrarily", () => {
    const normalized = normalizeTargetProgress([
      progressRow({ progress_units: 5 }),
      progressRow({ progress_units: 99 }),
    ]);
    assert.equal(normalized.status, "ok");
    if (normalized.status !== "ok") return;
    const byId = progressByCampaignId(normalized.progress);
    assert.equal(byId.get("22222222-2222-4222-8222-222222222222")?.progressUnits, 5);
  });
});

/* =========================================================================
 * 29-36. CAMPAIGN DETAIL
 * ======================================================================= */
describe("3. the Campaign Detail page", () => {
  const page = code(CAMPAIGN_DETAIL_PAGE);

  test("29. the detail fields come from the deployed contract", () => {
    assert.match(page, /getMyStaffCampaign/);
    assert.match(page, /ruleTypeLabel/);
    assert.match(page, /coinsPerUnit/);
    assert.match(page, /thresholdUnits/);
    assert.match(page, /maxRewardCoins/);
    assert.match(page, /performancePlainLabel/);
  });

  test("30. a missing or unauthorized campaign is a SINGLE non-leaking answer", () => {
    assert.match(page, /notFound\(\)/);
    // One branch for not-found. The page never distinguishes "another Retailer's" from
    // "does not exist", because the RPC does not either.
    assert.equal((page.match(/not-found/g) ?? []).length, 1);
  });

  test("31. eligible products are rendered from the products read", () => {
    assert.match(page, /listMyStaffCampaignProducts/);
    assert.match(page, /productsResult\.products\.map/);
  });

  test("32. the SNAPSHOT explanation uses the approved wording", () => {
    assert.match(page, /Published campaign product selection/);
    assert.match(page, /captured when it was published/);
  });

  test("33. the LIVE_TEMPORAL explanation uses the approved wording", () => {
    assert.match(page, /Eligibility checked at sale time/);
    assert.match(page, /at the moment the sale is verified/);
  });

  test("33b. it never promises that today's list guarantees a future reward", () => {
    assert.doesNotMatch(page, /guarantee|will earn|always qualify/i);
  });

  test("34. the empty product state uses the approved sentence", () => {
    assert.equal(NO_PRODUCTS_MESSAGE, "No product list is available for this campaign.");
    assert.match(page, /NO_PRODUCTS_MESSAGE/);
  });

  test("35. the database's product order is preserved — nothing re-sorts", () => {
    assert.doesNotMatch(page, /\.sort\(|localeCompare/);
  });

  test("36. no unrelated Vendor catalogue data is displayed", () => {
    // The staff contract withholds the Vendor's name; the page must not invent a field.
    assert.doesNotMatch(page, /vendorName/);
    assert.doesNotMatch(page, /vendor_name/);
  });
});

/* =========================================================================
 * 37-43. EARNINGS SUMMARY
 * ======================================================================= */
describe("4. the earnings summary", () => {
  const page = code(EARNINGS_PAGE);

  test("37-41. every summary field is rendered", () => {
    assert.match(page, /Total campaign coins earned/);
    assert.match(page, /Coins earned this month/);
    assert.match(page, /Rewarded sales/);
    assert.match(page, /Rewarded campaigns/);
    assert.match(page, /Latest reward date/);
    assert.match(page, /totalRewardCoins/);
    assert.match(page, /currentMonthRewardCoins/);
    assert.match(page, /rewardedSaleCount/);
    assert.match(page, /rewardedCampaignCount/);
    assert.match(page, /latestRewardAt/);
  });

  test("41b. the summary values are the stored ones, normalized exactly", () => {
    const normalized = normalizeEarningsSummary([summaryRow()]);
    assert.equal(normalized.status, "ok");
    if (normalized.status !== "ok") return;
    assert.equal(normalized.summary.totalRewardCoins, 165);
    assert.equal(normalized.summary.currentMonthRewardCoins, 165);
    assert.equal(normalized.summary.rewardedSaleCount, 1);
    assert.equal(normalized.summary.rewardedCampaignCount, 5);
    assert.equal(normalized.summary.latestRewardAt, "2026-08-01T11:00:00+00:00");
  });

  test("42. a zero-reward summary reads as zeros, not dashes or errors", () => {
    const normalized = normalizeEarningsSummary([
      summaryRow({
        total_reward_coins: 0,
        current_month_reward_coins: 0,
        rewarded_sale_count: 0,
        rewarded_campaign_count: 0,
        latest_reward_at: null,
      }),
    ]);
    assert.equal(normalized.status, "ok");
    if (normalized.status !== "ok") return;
    assert.equal(normalized.summary.totalRewardCoins, 0);
    assert.equal(normalized.summary.rewardedSaleCount, 0);
    assert.equal(formatCoins(normalized.summary.totalRewardCoins), "0");
    // Only the absent timestamp becomes a dash.
    assert.equal(normalized.summary.latestRewardAt, null);
  });

  test("42b. zero rows is a DENIAL, not an empty history", () => {
    assert.equal(normalizeEarningsSummary([]).status, "not-found");
    const earnings = code(STAFF_EARNINGS_ADAPTER);
    assert.match(earnings, /not-found"\)\s*return\s*\{\s*status:\s*"denied"/);
  });

  test("43. NO wallet, balance, redeemable, payout or settled wording appears", () => {
    const forbidden =
      /\b(wallet|balance|redeem|redeemable|redemption|payout|withdraw|settled|available coins|coins available|cash out)\b/gi;

    // The ONLY permitted occurrences are the sentences that say these features do NOT
    // exist, and the identifier of the constant holding one of them. They are REMOVED
    // from the source before the scan, so anything the rule then finds is a genuine use
    // — a filter that merely checked the file contained a disclaimer somewhere would
    // excuse every other occurrence in the same file.
    const APPROVED = [
      NOT_A_WALLET_NOTICE,
      "Campaign rewards earned from verified sales. Wallet and redemption features are not available yet.",
      "NOT_A_WALLET_NOTICE",
    ];

    for (const path of [...ALL_FEATURE_SOURCES, NAV_ITEMS]) {
      let source = code(path);
      for (const approved of APPROVED) source = source.split(approved).join(" ");

      const matches = source.match(forbidden) ?? [];
      assert.deepEqual(
        matches,
        [],
        `${path} uses wallet wording outside the approved notice: ${matches.join(", ")}`,
      );
    }
  });

  test("43a. that scan really does catch a forbidden word (the rule has teeth)", () => {
    // Guards the test above: if the approved-sentence stripping were ever widened to
    // excuse everything, this would still fail.
    const forbidden =
      /\b(wallet|balance|redeem|redeemable|redemption|payout|withdraw|settled)\b/gi;
    const pretend = "const label = 'Wallet balance'; // payout";
    assert.deepEqual(pretend.match(forbidden), ["Wallet", "balance", "payout"]);
  });

  test("43b. the not-a-wallet notice is present, exact, and rendered", () => {
    assert.equal(
      NOT_A_WALLET_NOTICE,
      "These are campaign rewards earned. Wallet, payout and redemption features are not available yet.",
    );
    assert.match(code(EARNINGS_PAGE), /NOT_A_WALLET_NOTICE/);
  });

  test("43c. the page heading is the approved one", () => {
    assert.match(code(EARNINGS_PAGE), /title="My campaign earnings"/);
  });
});

/* =========================================================================
 * 44-55. REWARD HISTORY
 * ======================================================================= */
describe("5. the reward history", () => {
  const page = code(EARNINGS_PAGE);

  test("44. rewards normalize from the exact deployed row shape", () => {
    const normalized = normalizeRewardEntries([rewardRow()]);
    assert.equal(normalized.status, "ok");
    if (normalized.status !== "ok") return;
    assert.equal(normalized.rewards.length, 1);
    assert.equal(normalized.rewards[0].rewardCoins, 35);
  });

  test("45-48. campaign, sale date, receipt reference and counts are rendered", () => {
    assert.match(page, /campaignName/);
    assert.match(page, /formatEarningsDate\(reward\.saleAt\)/);
    assert.match(page, /receiptReference\(reward\.receiptSubmissionId\)/);
    assert.match(page, /qualifyingItemCount/);
    assert.match(page, /qualifyingUnits/);
  });

  test("49. a per-unit reward shows units and the uncapped amount", () => {
    const perUnit = entry({ ruleType: "PER_UNIT_COINS", qualifyingUnits: 5, coinsUncapped: 35 });
    assert.equal(perUnit.qualifyingUnits, 5);
    assert.equal(perUnit.coinsUncapped, 35);
    assert.match(page, /before any cap/);
  });

  test("50. a target-bonus reward shows the threshold and configured bonus", () => {
    const normalized = normalizeRewardEntries([
      rewardRow({
        rule_type: "TARGET_BONUS",
        threshold_units: 3,
        configured_reward_coins: 100,
        reward_coins: 100,
        coins_uncapped: 100,
      }),
    ]);
    assert.equal(normalized.status, "ok");
    if (normalized.status !== "ok") return;
    assert.equal(normalized.rewards[0].thresholdUnits, 3);
    assert.equal(normalized.rewards[0].configuredRewardCoins, 100);
    assert.match(page, /Target of \$\{formatUnits\(reward\.thresholdUnits\)\} units/);
  });

  test("51 & 52. a partial cap shows BOTH stored values and labels the reduction", () => {
    const capped = entry({ coinsUncapped: 25, coinsCappedTo: 12, rewardCoins: 12 });
    assert.equal(capReduction(capped), 13);
    assert.equal(wasCapped(capped), true);
    assert.match(page, /Reduced by the campaign maximum/);
    assert.match(page, /formatCoins\(reward\.coinsUncapped\)/);
    assert.match(page, /formatCoins\(reward\.rewardCoins\)/);
  });

  test("52b. an uncapped reward reports NO reduction", () => {
    assert.equal(capReduction(entry({ coinsUncapped: 35, rewardCoins: 35 })), null);
    assert.equal(wasCapped(entry({ coinsUncapped: 35, rewardCoins: 35 })), false);
    // An absent uncapped value cannot produce a reduction either.
    assert.equal(capReduction(entry({ coinsUncapped: null, rewardCoins: 35 })), null);
    // And a nonsensical negative difference is not reported as a reduction.
    assert.equal(capReduction(entry({ coinsUncapped: 10, rewardCoins: 35 })), null);
  });

  test("52c. accumulator headroom is never shown", () => {
    assert.doesNotMatch(code(EARNINGS_PAGE), /headroom|remaining cap|cap remaining/i);
  });

  test("53. the empty reward state uses the approved sentence", () => {
    assert.equal(NO_REWARDS_MESSAGE, "You have not earned any campaign rewards yet.");
    assert.match(page, /NO_REWARDS_MESSAGE/);
  });

  test("54. NO verified sale id is rendered; the receipt reference is short", () => {
    assert.doesNotMatch(page, /verifiedSaleId|verified_sale_id/);
    assert.equal(
      receiptReference("44444444-4444-4444-8444-444444444444"),
      "44444444",
    );
    assert.equal(receiptReference("44444444-4444-4444-8444-444444444444").length, 8);
  });

  test("55. no application type can hold another staff member's data", () => {
    const normalization = code(join(ROOT, "lib/earnings/earnings-normalization.ts"));
    assert.doesNotMatch(
      normalization,
      /beneficiary_profile_id|beneficiaryProfileId|other_?staff|staffProfileId/,
    );
  });

  test("55b. a malformed row is refused rather than half-rendered", () => {
    assert.equal(normalizeRewardEntries([rewardRow({ reward_coins: null })]).status, "malformed");
    assert.equal(normalizeRewardEntries([rewardRow({ awarded_at: null })]).status, "malformed");
    assert.equal(normalizeRewardEntries([rewardRow({ campaign_reward_id: null })]).status, "malformed");
    assert.equal(normalizeRewardEntries("nope").status, "malformed");
    // Unrecognized enum values are DRIFT and refused, not rendered under a wrong label.
    assert.equal(normalizeRewardEntries([rewardRow({ rule_type: "MYSTERY" })]).status, "malformed");
    assert.equal(
      normalizeTargetProgress([progressRow({ performance_scope: "MYSTERY" })]).status,
      "malformed",
    );
    // A missing boolean is never coerced: it would invert the answer.
    assert.equal(
      normalizeTargetProgress([progressRow({ bonus_awarded_to_me: null })]).status,
      "malformed",
    );
  });
});

/* =========================================================================
 * 56-62. PAGINATION
 * ======================================================================= */
describe("6. keyset pagination", () => {
  const page = code(EARNINGS_PAGE);
  const earnings = code(STAFF_EARNINGS_ADAPTER);

  test("56. the first page sends null cursors", () => {
    assert.equal(parseRewardCursor({}), null);
    assert.match(earnings, /p_before_awarded_at:\s*null,\s*p_before_reward_id:\s*null/);
  });

  test("57. an older-page request passes BOTH cursor fields", () => {
    const cursor = parseRewardCursor({
      [CURSOR_AWARDED_AT_PARAM]: "2026-08-01T11:00:00+00:00",
      [CURSOR_REWARD_ID_PARAM]: "11111111-1111-4111-8111-111111111111",
    });
    assert.notEqual(cursor, null);
    assert.equal(cursor?.beforeAwardedAt, "2026-08-01T11:00:00+00:00");
    assert.equal(cursor?.beforeRewardId, "11111111-1111-4111-8111-111111111111");
  });

  test("58. an invalid or half-supplied cursor falls back to the first page", () => {
    // Only one half.
    assert.equal(
      parseRewardCursor({ [CURSOR_AWARDED_AT_PARAM]: "2026-08-01T11:00:00+00:00" }),
      null,
    );
    assert.equal(
      parseRewardCursor({ [CURSOR_REWARD_ID_PARAM]: "11111111-1111-4111-8111-111111111111" }),
      null,
    );
    // A non-uuid id.
    assert.equal(
      parseRewardCursor({
        [CURSOR_AWARDED_AT_PARAM]: "2026-08-01T11:00:00+00:00",
        [CURSOR_REWARD_ID_PARAM]: "not-a-uuid",
      }),
      null,
    );
    // An unparseable timestamp.
    assert.equal(
      parseRewardCursor({
        [CURSOR_AWARDED_AT_PARAM]: "yesterday",
        [CURSOR_REWARD_ID_PARAM]: "11111111-1111-4111-8111-111111111111",
      }),
      null,
    );
    // A repeated parameter arrives as an array and is ambiguous.
    assert.equal(
      parseRewardCursor({
        [CURSOR_AWARDED_AT_PARAM]: ["a", "b"],
        [CURSOR_REWARD_ID_PARAM]: "11111111-1111-4111-8111-111111111111",
      }),
      null,
    );
    // Empty strings.
    assert.equal(
      parseRewardCursor({ [CURSOR_AWARDED_AT_PARAM]: "  ", [CURSOR_REWARD_ID_PARAM]: "  " }),
      null,
    );
  });

  test("59. the UI page size is a constant within the RPC's 1..100 limit", () => {
    assert.equal(REWARDS_PAGE_SIZE, 20);
    assert.ok(REWARDS_PAGE_SIZE >= 1 && REWARDS_PAGE_SIZE <= 100);
    // The limit is never taken from a search parameter.
    assert.doesNotMatch(page, /searchParams.*limit|params\[?"?limit/i);
    assert.match(earnings, /p_limit:\s*REWARDS_PAGE_SIZE/);
  });

  test("60. ordering is deterministic and the cursor comes from the LAST row", () => {
    const full = Array.from({ length: REWARDS_PAGE_SIZE }, (_, index) =>
      entry({
        rewardId: `0000000${index}-1111-4111-8111-111111111111`.slice(0, 36),
        awardedAt: `2026-08-0${(index % 9) + 1}T11:00:00+00:00`,
      }),
    );
    const cursor = nextRewardCursor(full, REWARDS_PAGE_SIZE);
    assert.notEqual(cursor, null);
    assert.equal(cursor?.beforeRewardId, full[full.length - 1].rewardId);
    assert.equal(cursor?.beforeAwardedAt, full[full.length - 1].awardedAt);
  });

  test("60b. a short page is the LAST page and offers no cursor", () => {
    assert.equal(nextRewardCursor([entry()], REWARDS_PAGE_SIZE), null);
    assert.equal(nextRewardCursor([], REWARDS_PAGE_SIZE), null);
  });

  test("61. NO offset pagination is introduced", () => {
    for (const path of [...ALL_FEATURE_SOURCES]) {
      const source = code(path);
      assert.doesNotMatch(source, /\boffset\b|p_offset|\.range\(/i, `${path} uses offset paging`);
    }
  });

  test("61b. the cursor href carries exactly the two cursor parameters", () => {
    const href = rewardCursorHref("/retailer/my-earnings", {
      beforeAwardedAt: "2026-08-01T11:00:00+00:00",
      beforeRewardId: "11111111-1111-4111-8111-111111111111",
    });
    const url = new URL(href, "https://example.test");
    assert.equal(url.pathname, "/retailer/my-earnings");
    assert.equal([...url.searchParams.keys()].sort().join(","), "before,beforeId");
  });

  test("62. nothing is keyed by display name", () => {
    for (const path of ALL_FEATURE_SOURCES) {
      const source = code(path);
      assert.doesNotMatch(source, /key=\{[^}]*[Nn]ame\}/, `${path} keys by a name`);
    }
  });
});

/* =========================================================================
 * 63-72. NAVIGATION AND BOUNDARIES
 * ======================================================================= */
describe("7. navigation and feature boundaries", () => {
  const nav = code(NAV_ITEMS);

  test("63. the Sales Staff navigation contains both new entries", () => {
    assert.match(nav, /label:\s*"Current campaigns"/);
    assert.match(nav, /label:\s*"My campaign earnings"/);
    assert.match(nav, /href:\s*"\/retailer\/my-campaigns"/);
    assert.match(nav, /href:\s*"\/retailer\/my-earnings"/);
    // Both belong to the submitter list, and only that list.
    assert.match(
      nav,
      /kind === "submitter"\)\s*\{\s*return \[RECEIPTS_ITEM, MY_CAMPAIGNS_ITEM, MY_EARNINGS_ITEM\]/,
    );
  });

  test("64. owner and reader navigation is unchanged", () => {
    assert.match(nav, /return \[STAFF_ITEM, PRODUCTS_ITEM\]/);
    assert.match(
      nav,
      /return \[OVERVIEW_ITEM, SHOPS_ITEM, STAFF_ITEM, PRODUCTS_ITEM, CAMPAIGNS_ITEM\]/,
    );
  });

  test("64b. the new routes are absent from every other portal's navigation", () => {
    const adminNav = code(join(ROOT, "components/admin/nav-items.tsx"));
    assert.doesNotMatch(adminNav, /my-campaigns|my-earnings/);
  });

  test("65 & 66. NO table is read directly by any feature module", () => {
    const tables = [
      "campaign_rewards",
      "campaign_subject_accumulators",
      "campaign_sale_evaluations",
      "campaign_sale_item_qualifications",
      "verified_sales",
      "organization_members",
      "member_roles",
    ];
    for (const path of ALL_FEATURE_SOURCES) {
      const source = code(path);
      assert.doesNotMatch(source, /\.from\(/, `${path} uses .from()`);
      for (const table of tables) {
        assert.doesNotMatch(
          source,
          new RegExp(`["'\`]${table}["'\`]`),
          `${path} names table ${table}`,
        );
      }
    }
  });

  test("67. NO reward is calculated in TypeScript", () => {
    for (const path of ALL_FEATURE_SOURCES) {
      const source = code(path);
      // No multiplication of units by a rate, and no coin arithmetic of any kind.
      assert.doesNotMatch(
        source,
        /coinsPerUnit\s*\*|\*\s*coinsPerUnit|qualifyingUnits\s*\*|\*\s*qualifyingUnits/,
        `${path} multiplies a rate by units`,
      );
      assert.doesNotMatch(
        source,
        /rewardCoins\s*[+\-*/]\s*|[+\-*/]\s*rewardCoins/,
        `${path} performs coin arithmetic`,
      );
    }
  });

  test("67b. the ONE subtraction is capReduction, over two stored values on one row", () => {
    const presentation = code(join(ROOT, "lib/earnings/earnings-presentation.ts"));
    const subtractions = presentation.match(/[a-zA-Z.]+\s-\s[a-zA-Z.]+/g) ?? [];
    assert.deepEqual(subtractions, ["reward.coinsUncapped - reward.rewardCoins"]);
    // It reconstructs nothing: both operands are stored fields of the same reward.
    assert.equal(capReduction({ coinsUncapped: 25, rewardCoins: 12 }), 13);
  });

  test("68. NO migration file is touched by this feature", () => {
    for (const path of [...ALL_FEATURE_SOURCES, NAV_ITEMS]) {
      assert.doesNotMatch(code(path), /supabase\/migrations/, `${path} references migrations`);
    }
  });

  test("69. NO Flutter file is referenced", () => {
    for (const path of ALL_FEATURE_SOURCES) {
      assert.doesNotMatch(code(path), /\.dart|flutter/i, `${path} references Flutter`);
    }
  });

  test("70. NO wallet or ledger functionality is added", () => {
    for (const path of ALL_FEATURE_SOURCES) {
      assert.doesNotMatch(
        code(path),
        /createWallet|ledgerEntry|postToLedger|redeemCoins|requestPayout/i,
        `${path} adds wallet functionality`,
      );
    }
  });

  test("71 & 72. NO hosted write or deployment command appears anywhere", () => {
    for (const path of [...ALL_FEATURE_SOURCES, NAV_ITEMS]) {
      const source = code(path);
      assert.doesNotMatch(source, /db push|--linked|vercel|supabase link/i, path);
      assert.doesNotMatch(source, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/, path);
    }
  });

  test("72b. every page re-resolves portal access at its own server boundary", () => {
    for (const path of [CAMPAIGNS_PAGE, CAMPAIGN_DETAIL_PAGE, EARNINGS_PAGE]) {
      const source = code(path);
      assert.match(source, /getRetailerPortalAccess/, `${path} skips the access check`);
      assert.match(source, /redirect\("\/login"\)/, `${path} lacks the unauthenticated branch`);
      assert.match(
        source,
        /redirect\("\/retailer-access-denied"\)/,
        `${path} lacks the unauthorized branch`,
      );
    }
  });

  test("72c. no SQLSTATE, SQL, schema or function name can reach the browser", () => {
    for (const path of [CAMPAIGNS_PAGE, CAMPAIGN_DETAIL_PAGE, EARNINGS_PAGE]) {
      const source = code(path);
      assert.doesNotMatch(source, /42501|23514|23505|SQLSTATE/, `${path} exposes a SQLSTATE`);
      assert.doesNotMatch(source, /public\.[a-z_]+\(/, `${path} names a database function`);
      assert.doesNotMatch(source, /error\.(message|details|hint)/, `${path} renders a db message`);
    }
  });

  test("72d. the approved error sentences are the ones used", () => {
    assert.equal(
      CAMPAIGNS_UNAVAILABLE_MESSAGE,
      "Campaign information could not be loaded. Try again.",
    );
    assert.equal(
      EARNINGS_UNAVAILABLE_MESSAGE,
      "Earnings information could not be loaded. Try again.",
    );
  });

  test("72e. a failed history read does NOT clear a good summary", () => {
    const page = code(EARNINGS_PAGE);
    // The two reads are rendered by independent branches, so neither failure can blank
    // the other's section.
    assert.match(page, /summaryResult\.status === "unavailable"/);
    assert.match(page, /rewardsResult\.status === "unavailable"/);
    assert.doesNotMatch(page, /rewardsResult\.status !== "ok"[\s\S]{0,80}summaryResult/);
  });
});

/* =========================================================================
 * 8. Presentation helpers, formatting and accessibility
 * ======================================================================= */
describe("8. presentation helpers", () => {
  test("progressPercent clamps at 100 and never divides by zero", () => {
    assert.equal(progressPercent({ progressUnits: 5, targetUnits: 10 }), 50);
    // Progress may EXCEED the target; the bar must not.
    assert.equal(progressPercent({ progressUnits: 9, targetUnits: 8 }), 100);
    assert.equal(progressPercent({ progressUnits: 0, targetUnits: 10 }), 0);
    assert.equal(progressPercent({ progressUnits: 5, targetUnits: 0 }), 0);
    assert.equal(progressPercent({ progressUnits: 5, targetUnits: -3 }), 0);
  });

  test("the progress bar's accessible label names the subject and both values", () => {
    assert.equal(
      progressAriaLabel({
        performanceScope: "RETAILER_TEAM",
        progressUnits: 9,
        targetUnits: 8,
      }),
      "Team progress: 9 of 8 units",
    );
    assert.equal(
      progressAriaLabel({
        performanceScope: "INDIVIDUAL_STAFF",
        progressUnits: 2,
        targetUnits: 5,
      }),
      "Your progress: 2 of 5 units",
    );
  });

  test("the progress bar reports the TRUE value to assistive technology", () => {
    const bar = code(join(ROOT, "components/ui/progress-bar.tsx"));
    assert.match(bar, /role="progressbar"/);
    assert.match(bar, /aria-valuenow=\{valueNow\}/);
    assert.match(bar, /aria-valuemax=\{valueMax\}/);
    assert.match(bar, /aria-label=\{label\}/);
  });

  test("coins and units are grouped for readability", () => {
    assert.equal(formatCoins(1234567), "1,234,567");
    assert.equal(formatUnits(1000), "1,000");
    assert.equal(formatCoins(0), "0");
  });

  test("dates render in UTC and refuse unparseable values", () => {
    assert.equal(formatEarningsDate("2026-08-01T11:00:00+00:00"), "01 Aug 2026");
    assert.equal(formatEarningsDate(null), null);
    assert.equal(formatEarningsDate("not a date"), null);
  });

  test("the vocabulary guards accept only deployed values", () => {
    assert.equal(isRewardRuleType("PER_UNIT_COINS"), true);
    assert.equal(isRewardRuleType("TARGET_BONUS"), true);
    assert.equal(isRewardRuleType("MYSTERY"), false);
    assert.equal(isEarningPerformanceScope("RETAILER_TEAM"), true);
    assert.equal(isEarningPerformanceScope("INDIVIDUAL_STAFF"), true);
    assert.equal(isEarningPerformanceScope("SHOP"), false);
  });
});

/* =========================================================================
 * 9. The local-only manual fixture
 * ======================================================================= */
describe("9. the manual fixture is local-only and safe", () => {
  test("it exists and is not a migration", () => {
    assert.ok(existsSync(FIXTURE), "fixture script is missing");
    assert.doesNotMatch(code(FIXTURE), /supabase\/migrations/);
  });

  test("it refuses any non-loopback Supabase host", () => {
    const source = code(FIXTURE);
    assert.match(source, /127\.0\.0\.1/);
    assert.match(source, /localhost/);
    // A hosted host must be actively refused, not merely unmentioned.
    assert.match(source, /supabase\.co/);
  });

  test("it never runs a linked or hosted command", () => {
    const source = code(FIXTURE);
    assert.doesNotMatch(source, /--linked/);
    assert.doesNotMatch(source, /db push/);
    assert.doesNotMatch(source, /vercel/i);
  });

  test("it supports cleanup and uses no real personal data", () => {
    const source = code(FIXTURE);
    assert.match(source, /--cleanup/);
    assert.match(source, /@test\.invalid/);
    assert.match(source, /randomUUID/);
  });

  test("it does not modify .env.local", () => {
    const source = code(FIXTURE);
    assert.doesNotMatch(source, /writeFileSync[^)]*\.env/);
  });
});
