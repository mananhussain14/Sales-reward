/**
 * Tests for Phase 2A-F: the Claim Reviewer campaign-evaluation Web UI.
 *
 * Run with:  npm test
 *
 * Two kinds, matching the other review suites:
 *
 *   1. REAL UNIT TESTS of the pure modules — the label maps, the reward
 *      presentation, the item grouping, the summary and the settlement. Every rule
 *      is exercised by CALLING the function rather than by reading its source.
 *
 *   2. SOURCE-SCANNING CONTRACT TESTS of the adapters, the Server Action, the panel
 *      and the page. Those are `server-only` modules, a `"use server"` file and a
 *      Client Component: they cannot be invoked here. What they must NOT do is still
 *      checkable, and for this milestone the most valuable properties are NEGATIVE
 *      ones — no reward may be calculated in TypeScript, no verified sale id may be
 *      read or supplied, and no database message may reach a browser.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY SOURCE RULE, so no comment can satisfy a
 * security test. These files explain at length the identifiers the rules forbid.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  campaignKey,
  capReduction,
  formatAwardedAt,
  formatCoins,
  groupQualifyingItems,
  hasReward,
  isCampaignOutcome,
  isQualifiedWithoutReward,
  itemsForResult,
  outcomeLabel,
  outcomeTone,
  productSourceLabel,
  reasonLabel,
  ruleTypeLabel,
  saleTimeStatusLabel,
  CAMPAIGN_OUTCOMES,
  CAP_REDUCED_MESSAGE,
  TARGET_BONUS_NOT_AWARDED_MESSAGE,
  type CampaignQualifyingItem,
  type CampaignResult,
} from "./campaign-evaluation-display.ts";
import {
  classifyEvaluation,
  evaluationMessage,
  isEvaluationOutcome,
  panelState,
  shouldRefreshAfterEvaluation,
  summarize,
  CONFLICT_MESSAGE,
  EMPTY_EVALUATION_SUMMARY,
  EVALUATION_OUTCOMES,
  EXCLUDED_MESSAGE,
  MALFORMED_REQUEST_MESSAGE,
  NO_CAMPAIGNS_MESSAGE,
  NOT_READY_MESSAGE,
  PENDING_MESSAGE,
  REFRESHING_MESSAGE,
  REFUSED_MESSAGE,
  UNAVAILABLE_MESSAGE,
} from "./campaign-evaluation-settlement.ts";
import type { CampaignEvaluationRow } from "./campaign-evaluation-display.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DETAIL_DIR = join(ROOT, "app", "(review)", "review", "[receiptSubmissionId]");

const EXEC_ADAPTER = join(ROOT, "lib", "review", "evaluate-receipt-campaigns.ts");
const RESULTS_ADAPTER = join(ROOT, "lib", "review", "receipt-campaign-results.ts");
const ITEMS_ADAPTER = join(
  ROOT,
  "lib",
  "review",
  "receipt-campaign-qualifying-items.ts",
);
const DISPLAY_MOD = join(ROOT, "lib", "review", "campaign-evaluation-display.ts");
const SETTLEMENT_MOD = join(
  ROOT,
  "lib",
  "review",
  "campaign-evaluation-settlement.ts",
);
const ACTIONS = join(DETAIL_DIR, "campaign-evaluation-actions.ts");
const ACTION_STATE = join(DETAIL_DIR, "campaign-evaluation-action-state.ts");
const PANEL = join(DETAIL_DIR, "campaign-evaluation-panel.tsx");
const DETAIL_PAGE = join(DETAIL_DIR, "page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}
/** Source with every comment removed, so prose can never satisfy a rule. */
function codeOf(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const PHASE_2A_F_FILES = [
  EXEC_ADAPTER,
  RESULTS_ADAPTER,
  ITEMS_ADAPTER,
  DISPLAY_MOD,
  SETTLEMENT_MOD,
  ACTIONS,
  ACTION_STATE,
  PANEL,
];
const ALL_CODE = PHASE_2A_F_FILES.map(codeOf).join("\n");
const ADAPTER_CODE = [EXEC_ADAPTER, RESULTS_ADAPTER, ITEMS_ADAPTER]
  .map(codeOf)
  .join("\n");

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

function result(over: Partial<CampaignResult> = {}): CampaignResult {
  return {
    campaignId: "c1",
    campaignVersionId: "v1",
    campaignName: "Summer push",
    outcome: "QUALIFIED",
    nonQualificationReason: null,
    qualifyingItemCount: 1,
    qualifyingUnits: 2,
    ruleType: "PER_UNIT_COINS",
    coinsPerUnit: 5,
    thresholdUnits: null,
    configuredRewardCoins: null,
    maxRewardCoins: null,
    coinsUncapped: 10,
    coinsCappedTo: null,
    rewardCoins: 10,
    awardedAt: "2026-06-15T14:30:00.000Z",
    ...over,
  };
}

function item(over: Partial<CampaignQualifyingItem> = {}): CampaignQualifyingItem {
  return {
    campaignId: "c1",
    campaignVersionId: "v1",
    verifiedSaleItemId: "i1",
    vendorProductId: "p1",
    productCodeAtProposal: "SKU-1",
    productNameAtProposal: "Product One",
    lineNumber: 1,
    qualifyingUnits: 2,
    productSource: "SNAPSHOT",
    productStatusAtSale: null,
    assignmentStatusAtSale: null,
    ...over,
  };
}

function row(over: Partial<CampaignEvaluationRow> = {}): CampaignEvaluationRow {
  return {
    campaignId: "c1",
    campaignVersionId: "v1",
    outcome: "QUALIFIED",
    nonQualificationReason: null,
    qualifyingItemCount: 1,
    qualifyingUnits: 2,
    campaignRewardId: "r1",
    rewardCoins: 10,
    rewardCreated: true,
    evaluationCreated: true,
    applicationResult: "APPLIED",
    ...over,
  };
}

/* ===========================================================================
 * 1. OUTCOME AND REASON MAPPING
 * ========================================================================= */
describe("outcome and reason mapping", () => {
  test("every deployed outcome has a readable label", () => {
    assert.equal(outcomeLabel("QUALIFIED"), "Qualified");
    assert.equal(outcomeLabel("NOT_QUALIFIED"), "Not qualified");
    assert.equal(outcomeLabel("NOT_EVALUABLE"), "Not evaluable");
  });

  test("no label is a raw underscored token", () => {
    for (const outcome of CAMPAIGN_OUTCOMES) {
      assert.ok(!outcomeLabel(outcome).includes("_"));
    }
  });

  test("an unknown future outcome is safe and never printed raw", () => {
    const label = outcomeLabel("SOME_FUTURE_STATE");
    assert.equal(label, "Result recorded");
    assert.ok(!label.includes("SOME_FUTURE_STATE"));
    assert.ok(!label.includes("_"));
  });

  test("a null outcome does not crash", () => {
    assert.equal(typeof outcomeLabel(null), "string");
  });

  test("isCampaignOutcome guards the vocabulary", () => {
    assert.ok(isCampaignOutcome("QUALIFIED"));
    assert.ok(!isCampaignOutcome("qualified"));
    assert.ok(!isCampaignOutcome(null));
  });

  test("tone reinforces the word and never replaces it", () => {
    assert.equal(outcomeTone("QUALIFIED"), "emerald");
    assert.equal(outcomeTone("NOT_EVALUABLE"), "amber");
    assert.equal(outcomeTone("NOT_QUALIFIED"), "slate");
    assert.equal(outcomeTone("SOMETHING_ELSE"), "slate");
  });

  test("the three deployed reasons map to reviewer sentences", () => {
    assert.equal(
      reasonLabel("NO_QUALIFYING_ITEMS"),
      "No products on this sale qualified for the campaign.",
    );
    assert.equal(
      reasonLabel("SUPPRESSED_BY_EXCLUSIVITY"),
      "Another exclusive campaign had higher priority for this sale.",
    );
    assert.equal(
      reasonLabel("NO_TEMPORAL_RECORD"),
      "Historical campaign or product eligibility data was unavailable for the sale time.",
    );
  });

  test("NO_TEMPORAL_RECORD never implies reviewer fault or an override", () => {
    const label = reasonLabel("NO_TEMPORAL_RECORD") ?? "";
    assert.ok(!/you |your |please |override|fix|retry|correct/i.test(label));
  });

  test("no reason renders as null rather than as an empty sentence", () => {
    assert.equal(reasonLabel(null), null);
    assert.equal(reasonLabel("  "), null);
  });

  test("an unknown reason is safe and never printed raw", () => {
    const label = reasonLabel("SOME_NEW_REASON") ?? "";
    assert.ok(!label.includes("SOME_NEW_REASON"));
    assert.ok(!label.includes("_"));
  });

  test("rule types are readable", () => {
    assert.equal(ruleTypeLabel("PER_UNIT_COINS"), "Coins per unit");
    assert.equal(ruleTypeLabel("TARGET_BONUS"), "Target bonus");
    assert.equal(ruleTypeLabel(null), null);
    assert.ok(!(ruleTypeLabel("FUTURE_RULE") ?? "").includes("_"));
  });

  test("product source labels match the approved wording", () => {
    assert.equal(
      productSourceLabel("SNAPSHOT"),
      "Published campaign product selection",
    );
    assert.equal(productSourceLabel("LIVE_TEMPORAL"), "Eligible at sale time");
    assert.ok(!productSourceLabel(null).includes("_"));
    assert.ok(!productSourceLabel("FUTURE_SOURCE").includes("_"));
  });

  test("sale-time statuses are readable, and absent stays absent", () => {
    assert.equal(saleTimeStatusLabel("ACTIVE"), "Active");
    assert.equal(saleTimeStatusLabel("INACTIVE"), "Inactive");
    assert.equal(saleTimeStatusLabel(null), null);
  });
});

/* ===========================================================================
 * 2. REWARD PRESENTATION
 * ========================================================================= */
describe("reward presentation", () => {
  test("an uncapped reward reports no reduction", () => {
    assert.equal(capReduction(result()), null);
  });

  test("a partial cap reports the exact difference", () => {
    const r = result({ coinsUncapped: 25, coinsCappedTo: 12, rewardCoins: 12 });
    assert.equal(capReduction(r), 13);
  });

  test("an exhausted cap reports the whole amount and a zero reward", () => {
    const r = result({ coinsUncapped: 15, coinsCappedTo: 0, rewardCoins: 0 });
    assert.equal(capReduction(r), 15);
    assert.ok(hasReward(r), "a zero-coin award is still a reward row");
  });

  test("a cap that did not bite reports nothing", () => {
    const r = result({ coinsUncapped: 10, coinsCappedTo: 10 });
    assert.equal(capReduction(r), null);
  });

  test("hasReward follows the stored reward, not the coin amount", () => {
    assert.ok(hasReward(result({ rewardCoins: 0 })));
    assert.ok(!hasReward(result({ rewardCoins: null })));
  });

  test("a QUALIFIED target bonus with no reward is a normal state", () => {
    const r = result({
      ruleType: "TARGET_BONUS",
      thresholdUnits: 8,
      coinsUncapped: null,
      rewardCoins: null,
      awardedAt: null,
    });
    assert.ok(isQualifiedWithoutReward(r));
    assert.ok(!/error|problem|fail|missing/i.test(TARGET_BONUS_NOT_AWARDED_MESSAGE));
  });

  test("a NOT_QUALIFIED campaign is not reported as a missing bonus", () => {
    assert.ok(
      !isQualifiedWithoutReward(
        result({ outcome: "NOT_QUALIFIED", rewardCoins: null }),
      ),
    );
  });

  test("the cap message does not imply a calculation failure", () => {
    assert.ok(!/error|fail|invalid|wrong/i.test(CAP_REDUCED_MESSAGE));
  });

  test("coins format with separators and no currency symbol", () => {
    assert.equal(formatCoins(1234567), "1,234,567");
    assert.equal(formatCoins(0), "0");
    assert.equal(formatCoins(null), null);
    assert.ok(!/[$£€]/.test(formatCoins(10) ?? ""));
  });

  test("an unusable awarded timestamp renders as null, not as Invalid Date", () => {
    assert.equal(formatAwardedAt(null), null);
    assert.equal(formatAwardedAt("not-a-date"), null);
    assert.equal(formatAwardedAt("2026-06-15T14:30:00.000Z"), "2026-06-15 14:30 UTC");
  });
});

/* ===========================================================================
 * 3. GROUPING QUALIFYING ITEMS
 * ========================================================================= */
describe("qualifying item grouping", () => {
  test("the key is the campaign VERSION, never the display name", () => {
    const a = campaignKey({ campaignId: "c1", campaignVersionId: "v1" });
    const b = campaignKey({ campaignId: "c1", campaignVersionId: "v2" });
    assert.notEqual(a, b, "two versions of one campaign are distinct");
  });

  test("items attach to their own campaign", () => {
    const results = [result(), result({ campaignId: "c2", campaignVersionId: "v2" })];
    const items = [
      item(),
      item({ campaignId: "c2", campaignVersionId: "v2", verifiedSaleItemId: "i2" }),
    ];
    const grouped = groupQualifyingItems(results, items);
    assert.equal(itemsForResult(results[0], grouped).length, 1);
    assert.equal(itemsForResult(results[0], grouped)[0].verifiedSaleItemId, "i1");
    assert.equal(itemsForResult(results[1], grouped)[0].verifiedSaleItemId, "i2");
  });

  test("RPC order is preserved and never re-sorted by a display field", () => {
    const items = [
      item({ verifiedSaleItemId: "i1", lineNumber: 1, productNameAtProposal: "Zeta" }),
      item({ verifiedSaleItemId: "i2", lineNumber: 2, productNameAtProposal: "Alpha" }),
    ];
    const grouped = groupQualifyingItems([result()], items);
    const ids = itemsForResult(result(), grouped).map((i) => i.verifiedSaleItemId);
    assert.deepEqual(ids, ["i1", "i2"]);
  });

  test("an item with no matching campaign is NOT attached to another one", () => {
    const results = [result()];
    const stray = item({
      campaignId: "cX",
      campaignVersionId: "vX",
      verifiedSaleItemId: "iX",
    });
    const grouped = groupQualifyingItems(results, [item(), stray]);
    assert.equal(grouped.unmatched.length, 1);
    assert.equal(grouped.unmatched[0].verifiedSaleItemId, "iX");
    const shown = itemsForResult(results[0], grouped);
    assert.equal(shown.length, 1);
    assert.ok(!shown.some((i) => i.verifiedSaleItemId === "iX"));
  });

  test("a suppressed exclusive campaign shows no items even if rows exist", () => {
    const suppressed = result({
      outcome: "NOT_QUALIFIED",
      nonQualificationReason: "SUPPRESSED_BY_EXCLUSIVITY",
      qualifyingItemCount: 0,
      qualifyingUnits: 0,
    });
    const grouped = groupQualifyingItems([suppressed], [item()]);
    assert.deepEqual(itemsForResult(suppressed, grouped), []);
  });

  test("NOT_EVALUABLE shows no items either", () => {
    const ne = result({
      outcome: "NOT_EVALUABLE",
      nonQualificationReason: "NO_TEMPORAL_RECORD",
    });
    assert.deepEqual(itemsForResult(ne, groupQualifyingItems([ne], [item()])), []);
  });

  test("no item is rendered twice", () => {
    const grouped = groupQualifyingItems([result()], [item(), item()]);
    const ids = itemsForResult(result(), grouped).map((i) => i.verifiedSaleItemId);
    // Both rows are returned as the RPC gave them, but each appears under exactly one
    // campaign — the duplicate here is a fixture, not a second rendering path.
    assert.equal(new Set(ids).size, 1);
  });

  test("a SNAPSHOT item carries no sale-time status and that is not an error", () => {
    const snap = item({ productSource: "SNAPSHOT" });
    assert.equal(snap.productStatusAtSale, null);
    assert.equal(saleTimeStatusLabel(snap.productStatusAtSale), null);
  });

  test("a LIVE_TEMPORAL item carries both historical statuses", () => {
    const live = item({
      productSource: "LIVE_TEMPORAL",
      productStatusAtSale: "ACTIVE",
      assignmentStatusAtSale: "ACTIVE",
    });
    assert.equal(productSourceLabel(live.productSource), "Eligible at sale time");
    assert.equal(saleTimeStatusLabel(live.productStatusAtSale), "Active");
    assert.equal(saleTimeStatusLabel(live.assignmentStatusAtSale), "Active");
  });
});

/* ===========================================================================
 * 4. SUMMARY AND SETTLEMENT
 * ========================================================================= */
describe("evaluation summary", () => {
  test("a first execution counts created evaluations and rewards", () => {
    const s = summarize([row(), row({ campaignVersionId: "v2" })]);
    assert.equal(s.campaignCount, 2);
    assert.equal(s.evaluationsCreated, 2);
    assert.equal(s.rewardsCreated, 2);
    assert.equal(s.rewardsAlreadyApplied, 0);
    assert.equal(s.totalRewardCoins, 20);
    assert.equal(classifyEvaluation(s), "EVALUATED");
  });

  test("a replay creates nothing", () => {
    const s = summarize([
      row({ evaluationCreated: false, applicationResult: "ALREADY_APPLIED" }),
    ]);
    assert.equal(s.evaluationsCreated, 0);
    assert.equal(s.rewardsCreated, 0);
    assert.equal(s.rewardsAlreadyApplied, 1);
    assert.equal(classifyEvaluation(s), "ALREADY_EVALUATED");
  });

  test("APPLIED without a reward row is not counted as a reward", () => {
    // The target-bonus sale that counted units and crossed nothing.
    const s = summarize([
      row({ applicationResult: "APPLIED", rewardCreated: false, rewardCoins: null }),
    ]);
    assert.equal(s.rewardsCreated, 0);
    assert.equal(s.evaluationsCreated, 1);
    assert.equal(s.totalRewardCoins, 0);
  });

  test("a non-qualified row contributes no reward and no qualified count", () => {
    const s = summarize([
      row({
        outcome: "NOT_QUALIFIED",
        nonQualificationReason: "NO_QUALIFYING_ITEMS",
        campaignRewardId: null,
        rewardCoins: null,
        rewardCreated: false,
        applicationResult: null,
      }),
    ]);
    assert.equal(s.qualifiedCount, 0);
    assert.equal(s.rewardsCreated, 0);
  });

  test("a MIXED result is counted per row, not flattened", () => {
    const s = summarize([
      row({ campaignVersionId: "v1", evaluationCreated: true, applicationResult: "APPLIED" }),
      row({
        campaignVersionId: "v2",
        evaluationCreated: false,
        applicationResult: "ALREADY_APPLIED",
      }),
    ]);
    assert.equal(s.evaluationsCreated, 1);
    assert.equal(s.rewardsCreated, 1);
    assert.equal(s.rewardsAlreadyApplied, 1);
    assert.equal(classifyEvaluation(s), "EVALUATED");
    const message = evaluationMessage("EVALUATED", s);
    assert.match(message, /already applied/i);
  });

  test("zero rows is NO_CAMPAIGNS, not a failure", () => {
    const s = summarize([]);
    assert.deepEqual(s, EMPTY_EVALUATION_SUMMARY);
    assert.equal(classifyEvaluation(s), "NO_CAMPAIGNS");
    assert.equal(evaluationMessage("NO_CAMPAIGNS", s), NO_CAMPAIGNS_MESSAGE);
    assert.ok(!/error|fail|problem/i.test(NO_CAMPAIGNS_MESSAGE));
  });

  test("the replay message never claims a new reward", () => {
    const s = summarize([
      row({ evaluationCreated: false, applicationResult: "ALREADY_APPLIED" }),
    ]);
    const message = evaluationMessage("ALREADY_EVALUATED", s);
    assert.match(message, /no duplicate reward/i);
    assert.ok(!/reward created|rewards created/i.test(message));
  });

  test("the first-execution message states what was created", () => {
    const s = summarize([row()]);
    const message = evaluationMessage("EVALUATED", s);
    assert.match(message, /completed/i);
    assert.match(message, /1 campaign evaluation created/);
    assert.match(message, /1 reward created/);
  });

  test("a first execution that created no reward says so plainly", () => {
    const s = summarize([
      row({ applicationResult: "APPLIED", rewardCreated: false, rewardCoins: null }),
    ]);
    assert.match(evaluationMessage("EVALUATED", s), /no reward was created/i);
  });

  test("isEvaluationOutcome guards the vocabulary", () => {
    for (const o of EVALUATION_OUTCOMES) assert.ok(isEvaluationOutcome(o));
    assert.ok(!isEvaluationOutcome("EVALUATED_TWICE"));
  });
});

describe("panel state", () => {
  test("a failed read is unavailable, never 'no campaigns'", () => {
    assert.equal(
      panelState({ storedResults: null, lastOutcome: null, canEvaluate: true }),
      "unavailable",
    );
  });

  test("stored rows always win", () => {
    assert.equal(
      panelState({ storedResults: [1], lastOutcome: null, canEvaluate: false }),
      "evaluated",
    );
    assert.equal(
      panelState({ storedResults: [1], lastOutcome: "NO_CAMPAIGNS", canEvaluate: true }),
      "evaluated",
    );
  });

  test("zero rows before an execution is 'ready', not 'no campaigns'", () => {
    assert.equal(
      panelState({ storedResults: [], lastOutcome: null, canEvaluate: true }),
      "ready",
    );
  });

  test("zero rows AFTER an execution said so is 'zero-campaigns'", () => {
    assert.equal(
      panelState({ storedResults: [], lastOutcome: "NO_CAMPAIGNS", canEvaluate: true }),
      "zero-campaigns",
    );
  });

  test("an ineligible receipt reports not-ready", () => {
    assert.equal(
      panelState({ storedResults: [], lastOutcome: null, canEvaluate: false }),
      "not-ready",
    );
  });

  test("a settled success refreshes; a failure does not", () => {
    assert.ok(shouldRefreshAfterEvaluation({ outcome: "EVALUATED", formError: null }));
    assert.ok(shouldRefreshAfterEvaluation({ outcome: "NO_CAMPAIGNS", formError: null }));
    assert.ok(!shouldRefreshAfterEvaluation({ outcome: null, formError: null }));
    assert.ok(
      !shouldRefreshAfterEvaluation({ outcome: null, formError: REFUSED_MESSAGE }),
    );
  });
});

describe("error copy", () => {
  const MESSAGES = [
    REFUSED_MESSAGE,
    NOT_READY_MESSAGE,
    EXCLUDED_MESSAGE,
    CONFLICT_MESSAGE,
    UNAVAILABLE_MESSAGE,
    MALFORMED_REQUEST_MESSAGE,
    PENDING_MESSAGE,
    REFRESHING_MESSAGE,
  ];

  test("no message leaks SQL, a schema name or an internal identifier", () => {
    for (const m of MESSAGES) {
      assert.ok(
        !/select |insert |update |public\.|_id\b|sqlstate|42501|23514|pg_|rpc/i.test(m),
        `leaky message: ${m}`,
      );
    }
  });

  test("no message contains a raw underscored token", () => {
    for (const m of MESSAGES) assert.ok(!/[a-z]_[a-z]/i.test(m), `raw token: ${m}`);
  });

  test("the conflict message states that nothing changed", () => {
    assert.match(CONFLICT_MESSAGE, /no changes were made/i);
  });
});

/* ===========================================================================
 * 5. THE ADAPTERS — source-scanning contract rules
 * ========================================================================= */
describe("RPC adapters", () => {
  test("each adapter calls its Migration 69 RPC by exact name", () => {
    assert.match(codeOf(EXEC_ADAPTER), /rpc\(\s*"evaluate_receipt_campaigns"/);
    assert.match(
      codeOf(RESULTS_ADAPTER),
      /rpc\(\s*"get_receipt_campaign_results"/,
    );
    assert.match(
      codeOf(ITEMS_ADAPTER),
      /rpc\(\s*"get_receipt_campaign_qualifying_items"/,
    );
  });

  test("NO adapter calls a sale-keyed Migration 68 RPC", () => {
    assert.ok(!/evaluate_verified_sale_campaigns/.test(ADAPTER_CODE));
    assert.ok(!/get_verified_sale_campaign_results/.test(ADAPTER_CODE));
    assert.ok(!/get_verified_sale_campaign_qualifying_items/.test(ADAPTER_CODE));
  });

  test("p_submission_id is the ONLY RPC argument anywhere", () => {
    const args = ALL_CODE.match(/p_[a-z_]+/g) ?? [];
    assert.deepEqual([...new Set(args)], ["p_submission_id"]);
  });

  test("no verified sale id is supplied, read or named in code", () => {
    assert.ok(!/p_verified_sale_id/.test(ALL_CODE));
    assert.ok(!/verified_sale_id/.test(ALL_CODE));
    assert.ok(!/verifiedSaleId/.test(ALL_CODE));
  });

  test("no adapter reads the verified_sales table", () => {
    assert.ok(!/from\(\s*["']verified_sales/.test(ALL_CODE));
    assert.ok(!/verified_sales/.test(ALL_CODE));
  });

  test("no tenant, campaign, beneficiary or reward override is supplied", () => {
    for (const forbidden of [
      "p_vendor",
      "p_retailer",
      "p_campaign",
      "p_beneficiary",
      "p_units",
      "p_rate",
      "p_reward",
      "p_coins",
    ]) {
      assert.ok(!ALL_CODE.includes(forbidden), `forbidden argument: ${forbidden}`);
    }
  });

  test("no adapter reaches for a service-role client", () => {
    assert.ok(!/service[_-]?role/i.test(ALL_CODE));
    assert.ok(!/supabase\/admin/.test(ALL_CODE));
    for (const f of [EXEC_ADAPTER, RESULTS_ADAPTER, ITEMS_ADAPTER]) {
      assert.match(codeOf(f), /@\/lib\/supabase\/server/);
    }
  });

  test("every adapter is server-only", () => {
    for (const f of [EXEC_ADAPTER, RESULTS_ADAPTER, ITEMS_ADAPTER]) {
      assert.match(read(f), /^import "server-only";/m);
    }
  });

  test("the two reads are request-scoped with React cache", () => {
    for (const f of [RESULTS_ADAPTER, ITEMS_ADAPTER]) {
      assert.match(codeOf(f), /cache\(/);
    }
  });

  test("bigint columns are narrowed, never cast blindly", () => {
    for (const f of [EXEC_ADAPTER, RESULTS_ADAPTER, ITEMS_ADAPTER]) {
      const code = codeOf(f);
      assert.match(code, /Number\.isSafeInteger/);
      assert.match(code, /number \| string \| null/);
    }
  });

  test("no adapter uses `any` or a Record<string, unknown> row type", () => {
    for (const f of PHASE_2A_F_FILES) {
      const code = codeOf(f);
      assert.ok(!/:\s*any\b/.test(code), `any in ${f}`);
      assert.ok(!/as\s+any\b/.test(code), `as any in ${f}`);
      assert.ok(!/Record<string,\s*unknown>\[\]/.test(code), `loose rows in ${f}`);
    }
  });

  test("only the SQLSTATE is read from an error", () => {
    const code = codeOf(EXEC_ADAPTER);
    assert.match(code, /code\?\:\s*unknown/);
    for (const leak of [".message", ".details", ".hint"]) {
      assert.ok(!code.includes(leak), `error field read: ${leak}`);
    }
  });

  test("the execution adapter maps the deployed SQLSTATEs", () => {
    const code = codeOf(EXEC_ADAPTER);
    assert.match(code, /case "42501"/);
    assert.match(code, /case "23514"/);
  });

  test("zero returned rows is a SUCCESS, not an error", () => {
    const code = codeOf(EXEC_ADAPTER);
    assert.ok(!/rows\.length === 0[\s\S]{0,120}unavailable/.test(code));
    assert.ok(!/rows\.length === 0[\s\S]{0,120}refused/.test(code));
  });

  test("nothing logged carries a receipt id, a coin value or a provider error", () => {
    const logs = ALL_CODE.match(/console\.[a-z]+\(([\s\S]*?)\);/g) ?? [];
    assert.ok(logs.length > 0, "the adapters do log failures");
    for (const line of logs) {
      assert.ok(!/receiptSubmissionId|result\.error|error\)/.test(line), line);
    }
  });
});

/* ===========================================================================
 * 6. THE SERVER ACTION
 * ========================================================================= */
describe("server action", () => {
  test("it is a Server Action", () => {
    assert.match(read(ACTIONS), /^"use server";/m);
  });

  test("it reads exactly ONE form field", () => {
    const fields = codeOf(ACTIONS).match(/field\(formData,\s*"([a-zA-Z]+)"\)/g) ?? [];
    assert.deepEqual([...new Set(fields)], ['field(formData, "receiptSubmissionId")']);
  });

  test("the id is validated before any RPC is reached", () => {
    const code = codeOf(ACTIONS);
    const guard = code.indexOf("isReceiptSubmissionId");
    const call = code.indexOf("evaluateReceiptCampaigns(");
    assert.ok(guard > -1 && call > -1 && guard < call);
  });

  test("it delegates to the adapter and never calls an RPC itself", () => {
    const code = codeOf(ACTIONS);
    assert.match(code, /evaluateReceiptCampaigns\(/);
    assert.ok(!/\.rpc\(/.test(code));
    assert.ok(!/createClient/.test(code));
  });

  test("every failure class maps to its safe message", () => {
    const code = codeOf(ACTIONS);
    assert.match(code, /REFUSED_MESSAGE/);
    assert.match(code, /CONFLICT_MESSAGE/);
    assert.match(code, /UNAVAILABLE_MESSAGE/);
    assert.match(code, /MALFORMED_REQUEST_MESSAGE/);
  });

  test("it revalidates nothing — the panel refreshes after settlement", () => {
    assert.ok(!/revalidatePath|revalidateTag/.test(codeOf(ACTIONS)));
  });

  test("it calculates no reward", () => {
    const code = codeOf(ACTIONS);
    assert.ok(!/coinsPerUnit|coins_per_unit|thresholdUnits|maxRewardCoins/.test(code));
    assert.ok(!/\*\s*qualifyingUnits|qualifyingUnits\s*\*/.test(code));
  });

  test("a repeat press is NOT short-circuited — evaluation is idempotent", () => {
    // Unlike the product decision, no `prevState.settled` early return exists: the
    // database is same-result idempotent and a second press is a legitimate check.
    assert.ok(!/prevState\.settled/.test(codeOf(ACTIONS)));
  });
});

/* ===========================================================================
 * 7. THE PANEL AND THE PAGE
 * ========================================================================= */
describe("panel and page", () => {
  test("the panel is a Client Component", () => {
    assert.match(read(PANEL), /^"use client";/m);
  });

  test("evaluation never runs on load — it is submitted by the reviewer", () => {
    const code = codeOf(PANEL);
    assert.match(code, /<form\s+action=\{formAction\}/);
    // No effect calls the action, and no auto-submit exists.
    assert.ok(!/useEffect\([\s\S]{0,200}formAction/.test(code));
    assert.ok(!/requestSubmit|\.submit\(\)/.test(code));
  });

  test("the control is disabled while a request is in flight", () => {
    const code = codeOf(PANEL);
    assert.match(code, /disabled=\{pending\}/);
    assert.match(code, /loading=\{pending\}/);
  });

  test("the pending state is announced", () => {
    assert.match(codeOf(PANEL), /role="status"[\s\S]{0,200}PENDING_MESSAGE/);
  });

  test("failures use an accessible alert region", () => {
    assert.match(codeOf(PANEL), /role="alert"/);
  });

  test("the button carries a descriptive accessible label", () => {
    assert.match(codeOf(PANEL), /aria-label="Evaluate campaigns for this verified sale"/);
  });

  test("the panel refreshes the route after settlement", () => {
    const code = codeOf(PANEL);
    assert.match(code, /router\.refresh\(\)/);
    assert.match(code, /shouldRefreshAfterEvaluation/);
  });

  test("the panel calculates no reward and reads no accumulator", () => {
    const code = codeOf(PANEL);
    assert.ok(!/coinsPerUnit\s*\*|\*\s*qualifyingUnits/.test(code));
    assert.ok(!/accumulator|units_counted_total|coins_awarded_total/i.test(code));
  });

  test("the panel never renders a raw outcome or reason token", () => {
    const code = codeOf(PANEL);
    assert.ok(!/\{result\.outcome\}/.test(code));
    assert.ok(!/\{result\.nonQualificationReason\}/.test(code));
    assert.ok(!/\{item\.productSource\}/.test(code));
  });

  test("the page passes the receipt id and never a sale id", () => {
    const code = codeOf(DETAIL_PAGE);
    assert.match(code, /getReceiptCampaignResults\(d\.receiptSubmissionId\)/);
    assert.match(code, /getReceiptCampaignQualifyingItems\(d\.receiptSubmissionId\)/);
    assert.ok(!/verifiedSaleId|verified_sale_id/.test(code));
  });

  test("the panel is keyed on the receipt so state resets between receipts", () => {
    assert.match(
      codeOf(DETAIL_PAGE),
      /<CampaignEvaluationPanel[\s\S]{0,120}key=\{d\.receiptSubmissionId\}/,
    );
  });

  test("a failed read reaches the panel as null, never as an empty list", () => {
    const code = codeOf(DETAIL_PAGE);
    assert.match(code, /campaignResultsResult\.status === "authorized"/);
    assert.match(code, /:\s*null;/);
  });

  test("the action is only offered for a finalized, unexcluded receipt", () => {
    const code = codeOf(DETAIL_PAGE);
    assert.match(code, /alreadyFinalized === true/);
    assert.match(code, /alreadyAccepted === true/);
    assert.match(code, /canEvaluateCampaigns\s*=\s*campaignReadable\s*&&\s*!campaignExcluded/);
  });
});

/* ===========================================================================
 * 8. BOUNDARIES
 * ========================================================================= */
describe("boundaries", () => {
  test("every Phase 2A-F file exists", () => {
    for (const f of PHASE_2A_F_FILES) assert.ok(existsSync(f), `missing: ${f}`);
  });

  test("no Web file writes to a database table directly", () => {
    for (const verb of [".insert(", ".update(", ".delete(", ".upsert("]) {
      assert.ok(!ALL_CODE.includes(verb), `direct write: ${verb}`);
    }
  });

  test("no Web file reads an evidence table directly", () => {
    for (const table of [
      "campaign_sale_evaluations",
      "campaign_sale_item_qualifications",
      "campaign_rewards",
      "campaign_subject_accumulators",
    ]) {
      assert.ok(!ALL_CODE.includes(table), `direct table access: ${table}`);
    }
  });

  test("no coin ledger, wallet, balance, payout or redemption is IMPLEMENTED", () => {
    // Scoped to CODE usage — an identifier, a call, a property, an import path or an
    // RPC/table string. The panel deliberately tells the reviewer in plain words that
    // evaluation "creates no coin balance, no payout and no redemption", and that
    // reassurance must not be what trips this rule.
    for (const word of ["ledger", "wallet", "payout", "redemption", "balance"]) {
      const asIdentifier = new RegExp(
        `\\w${word}|${word}\\w|\\b${word}\\s*[(.=:]`,
        "i",
      );
      assert.ok(!asIdentifier.test(ALL_CODE), `forbidden concept in code: ${word}`);
    }
  });

  test("no forbidden concept reaches an RPC name or a table string", () => {
    const strings = ALL_CODE.match(/"[^"]*"/g) ?? [];
    for (const literal of strings) {
      if (!/^"(get_|evaluate_|campaign_|receipt_|verified_)/.test(literal)) continue;
      assert.ok(
        !/ledger|wallet|payout|redemption|balance/i.test(literal),
        `forbidden identifier string: ${literal}`,
      );
    }
  });

  test("no Web file re-implements database authorization", () => {
    for (const word of [
      "CAMPAIGN_EVALUATION_EXECUTE",
      "RECEIPT_REVIEW_READ",
      "CLAIM_REVIEWER",
      "role_permissions",
    ]) {
      assert.ok(!ALL_CODE.includes(word), `duplicated authorization: ${word}`);
    }
  });
});
