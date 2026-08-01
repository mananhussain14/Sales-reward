/**
 * Unit tests for @/lib/campaigns/campaign-step-state.
 *
 * Run with:  npm test
 *
 * ============================================================================
 * THE DEFECT THESE EXIST TO PIN
 * ============================================================================
 * The wizard rail previously derived "Complete" from `isStepComplete` alone, which
 * answers "does this step produce no validation error right now?". On an untouched form
 * that answer is YES for three steps the operator has never seen:
 *
 *   * Retailer audience — because `audienceMode` defaults to the valid ALL_RETAILERS
 *   * Product eligibility — because `productScope` defaults to the valid
 *     ALL_ELIGIBLE_PRODUCTS
 *   * Review and save — because it owns no fields, so its error set is always empty
 *
 * so a blank campaign with no name, no reward and no schedule showed three steps as
 * "Complete" while the summary panel beside it correctly reported those values missing.
 *
 * Every test below is written against the real validator through the real module. There
 * is deliberately no second copy of any field rule here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_CAMPAIGN_FORM,
  WIZARD_STEPS,
  type CampaignFormValues,
} from "./campaign-input.ts";
import {
  campaignStepStatuses,
  isConfigurationStepValid,
  isSettledStatus,
  needsAttention,
  progressDescription,
  stepStatusLabel,
  stepStatusTone,
  REVIEW_STEP_INDEX,
  STEP_STATUSES,
  type StepStatus,
} from "./campaign-step-state.ts";

/** A campaign whose every step is valid, used as the baseline to break one thing at a time. */
function completeForm(overrides: Partial<CampaignFormValues> = {}): CampaignFormValues {
  return {
    ...EMPTY_CAMPAIGN_FORM,
    name: "Summer bonus",
    audienceMode: "ALL_RETAILERS",
    productScope: "ALL_ELIGIBLE_PRODUCTS",
    performanceScope: "INDIVIDUAL_STAFF",
    ruleType: "PER_UNIT_COINS",
    coinsPerUnit: "5",
    timezoneName: "Asia/Dubai",
    startsAt: "2026-09-01T09:00",
    endsAt: "",
    stackingMode: "STACKABLE",
    priority: "0",
    ...overrides,
  };
}

const ALL_STEPS = new Set(WIZARD_STEPS.map((_, index) => index));

function statuses(
  values: CampaignFormValues,
  options: {
    activeIndex?: number;
    visited?: ReadonlySet<number>;
    saved?: boolean;
    audienceResolvesToNoRetailer?: boolean;
  } = {},
): StepStatus[] {
  return campaignStepStatuses({
    values,
    activeIndex: options.activeIndex ?? 0,
    visited: options.visited ?? new Set([options.activeIndex ?? 0]),
    saved: options.saved ?? false,
    audienceResolvesToNoRetailer: options.audienceResolvesToNoRetailer,
  });
}

/* ========================================================================= */

describe("1. the initial wizard", () => {
  test("1.1 step 1 is In progress and steps 2-5 are Not started", () => {
    // The exact state the browser review found wrong.
    const result = statuses(EMPTY_CAMPAIGN_FORM, { activeIndex: 0 });
    assert.deepEqual(result, [
      "IN_PROGRESS",
      "NOT_STARTED",
      "NOT_STARTED",
      "NOT_STARTED",
      "NOT_STARTED",
      "NOT_READY",
    ]);
  });

  test("1.2 review is Not ready, never Complete, on a blank form", () => {
    const result = statuses(EMPTY_CAMPAIGN_FORM);
    assert.equal(result[REVIEW_STEP_INDEX], "NOT_READY");
    assert.notEqual(result[REVIEW_STEP_INDEX], "COMPLETE");
  });

  test("1.3 the valid audience DEFAULT does not mark the unvisited step Complete", () => {
    // ALL_RETAILERS is valid with no ids, which is exactly why validity alone was wrong.
    assert.equal(EMPTY_CAMPAIGN_FORM.audienceMode, "ALL_RETAILERS");
    assert.equal(isConfigurationStepValid(EMPTY_CAMPAIGN_FORM, 1), true);
    assert.equal(statuses(EMPTY_CAMPAIGN_FORM)[1], "NOT_STARTED");
  });

  test("1.4 the valid product DEFAULT does not mark the unvisited step Complete", () => {
    assert.equal(EMPTY_CAMPAIGN_FORM.productScope, "ALL_ELIGIBLE_PRODUCTS");
    assert.equal(isConfigurationStepValid(EMPTY_CAMPAIGN_FORM, 2), true);
    assert.equal(statuses(EMPTY_CAMPAIGN_FORM)[2], "NOT_STARTED");
  });
});

describe("2. progressing through the steps", () => {
  test("2.1 a valid step 1 becomes Complete once the operator moves on", () => {
    const result = statuses(completeForm({ name: "Summer bonus" }), {
      activeIndex: 1,
      visited: new Set([0, 1]),
    });
    assert.equal(result[0], "COMPLETE");
    assert.equal(result[1], "IN_PROGRESS");
    assert.deepEqual(result.slice(2, 5), ["NOT_STARTED", "NOT_STARTED", "NOT_STARTED"]);
  });

  test("2.2 an invalid step 1 becomes Needs attention once left behind", () => {
    const result = statuses(completeForm({ name: "   " }), {
      activeIndex: 1,
      visited: new Set([0, 1]),
    });
    assert.equal(result[0], "NEEDS_ATTENTION");
  });

  test("2.3 the active step always reads In progress", () => {
    // Even when its fields are already valid — it is what the operator is doing now.
    for (let index = 0; index < REVIEW_STEP_INDEX; index += 1) {
      const result = statuses(completeForm(), { activeIndex: index, visited: ALL_STEPS });
      assert.equal(result[index], "IN_PROGRESS", `step ${index + 1} was not In progress`);
    }
  });

  test("2.4 a step visited out of order leaves the skipped ones Not started", () => {
    // Jumping from step 1 straight to step 5 must not imply 2-4 were done.
    const result = statuses(completeForm(), {
      activeIndex: 4,
      visited: new Set([0, 4]),
    });
    assert.equal(result[1], "NOT_STARTED");
    assert.equal(result[2], "NOT_STARTED");
    assert.equal(result[3], "NOT_STARTED");
    assert.equal(result[4], "IN_PROGRESS");
  });
});

describe("3. step-specific validity comes from the real validator", () => {
  test("3.1 SELECTED_RETAILERS with no ids is invalid", () => {
    const values = completeForm({
      audienceMode: "SELECTED_RETAILERS",
      vendorRetailerIds: [],
    });
    assert.equal(isConfigurationStepValid(values, 1), false);
    assert.equal(statuses(values, { activeIndex: 5, visited: ALL_STEPS })[1], "NEEDS_ATTENTION");
  });

  test("3.2 RETAILER_GROUPS with no groups is invalid", () => {
    const values = completeForm({ audienceMode: "RETAILER_GROUPS", groupIds: [] });
    assert.equal(isConfigurationStepValid(values, 1), false);
  });

  test("3.3 a group audience that resolves to nobody is not Complete", () => {
    // Field-valid — a group WAS chosen — but every chosen group is empty, so the
    // campaign would reach no Retailer and publication would refuse it.
    const values = completeForm({
      audienceMode: "RETAILER_GROUPS",
      groupIds: ["11111111-1111-4111-8111-111111111111"],
    });
    assert.equal(isConfigurationStepValid(values, 1), true);
    assert.equal(isConfigurationStepValid(values, 1, true), false);

    const result = statuses(values, {
      activeIndex: 5,
      visited: ALL_STEPS,
      audienceResolvesToNoRetailer: true,
    });
    assert.equal(result[1], "NEEDS_ATTENTION");
    assert.equal(result[REVIEW_STEP_INDEX], "NOT_READY");
  });

  test("3.4 SELECTED_PRODUCTS with no products is invalid", () => {
    const values = completeForm({ productScope: "SELECTED_PRODUCTS", productIds: [] });
    assert.equal(isConfigurationStepValid(values, 2), false);
  });

  test("3.5 the reward step stays incomplete until every rule-specific field is valid", () => {
    // PER_UNIT_COINS needs a rate.
    assert.equal(
      isConfigurationStepValid(completeForm({ coinsPerUnit: "" }), 3),
      false,
    );
    assert.equal(isConfigurationStepValid(completeForm({ coinsPerUnit: "0" }), 3), false);
    // TARGET_BONUS needs both a target and a bonus.
    const bonus = completeForm({
      ruleType: "TARGET_BONUS",
      coinsPerUnit: "",
      thresholdUnits: "25",
      rewardCoins: "",
    });
    assert.equal(isConfigurationStepValid(bonus, 3), false);
    assert.equal(
      isConfigurationStepValid({ ...bonus, rewardCoins: "2500" }, 3),
      true,
    );
    // And the ceiling the database enforces.
    assert.equal(
      isConfigurationStepValid(completeForm({ coinsPerUnit: "1000000001" }), 3),
      false,
    );
  });

  test("3.6 the schedule step needs a zone, a start, and a sane end", () => {
    assert.equal(isConfigurationStepValid(completeForm({ timezoneName: "" }), 4), false);
    assert.equal(isConfigurationStepValid(completeForm({ startsAt: "" }), 4), false);
    assert.equal(
      isConfigurationStepValid(
        completeForm({ startsAt: "2026-09-10T09:00", endsAt: "2026-09-01T09:00" }),
        4,
      ),
      false,
    );
    // An absent end is the evergreen case, which is valid.
    assert.equal(isConfigurationStepValid(completeForm({ endsAt: "" }), 4), true);
  });

  test("3.7 EXCLUSIVE needs a key; STACKABLE does not depend on a stale one", () => {
    assert.equal(
      isConfigurationStepValid(
        completeForm({ stackingMode: "EXCLUSIVE", exclusivityKey: "" }),
        4,
      ),
      false,
    );
    assert.equal(
      isConfigurationStepValid(
        completeForm({ stackingMode: "EXCLUSIVE", exclusivityKey: "SKINCARE Q3" }),
        4,
      ),
      true,
    );
    // A leftover key must not make a stackable campaign invalid — the database nulls it.
    assert.equal(
      isConfigurationStepValid(
        completeForm({ stackingMode: "STACKABLE", exclusivityKey: "SKINCARE Q3" }),
        4,
      ),
      true,
    );
  });

  test("3.8 the optional description never makes a step incomplete", () => {
    assert.equal(isConfigurationStepValid(completeForm({ description: "" }), 0), true);
    assert.equal(
      isConfigurationStepValid(completeForm({ description: "Anything" }), 0),
      true,
    );
  });
});

describe("4. dependencies recompute", () => {
  test("4.1 a Complete step becomes Needs attention when a later change invalidates it", () => {
    const before = statuses(completeForm(), { activeIndex: 5, visited: ALL_STEPS });
    assert.equal(before[1], "COMPLETE");

    // The operator switches the audience to a mode that now needs ids it has not chosen.
    const after = statuses(
      completeForm({ audienceMode: "SELECTED_RETAILERS", vendorRetailerIds: [] }),
      { activeIndex: 5, visited: ALL_STEPS },
    );
    assert.equal(after[1], "NEEDS_ATTENTION");
    // …and the review step follows immediately. No stale indicator survives.
    assert.equal(after[REVIEW_STEP_INDEX], "NOT_READY");
  });

  test("4.2 no status is ever left stale, because every call recomputes from values", () => {
    const values = completeForm();
    const a = statuses(values, { activeIndex: 5, visited: ALL_STEPS });
    const b = statuses(values, { activeIndex: 5, visited: ALL_STEPS });
    assert.deepEqual(a, b);
  });
});

describe("5. the review step", () => {
  test("5.1 it is Ready to save only when all five configuration steps are valid", () => {
    const result = statuses(completeForm(), { activeIndex: 5, visited: ALL_STEPS });
    assert.deepEqual(result.slice(0, 5), [
      "COMPLETE",
      "COMPLETE",
      "COMPLETE",
      "COMPLETE",
      "COMPLETE",
    ]);
    assert.equal(result[REVIEW_STEP_INDEX], "READY_TO_SAVE");
  });

  test("5.2 one invalid step is enough to keep it Not ready", () => {
    for (const broken of [
      completeForm({ name: "" }),
      completeForm({ coinsPerUnit: "" }),
      completeForm({ timezoneName: "" }),
    ]) {
      const result = statuses(broken, { activeIndex: 5, visited: ALL_STEPS });
      assert.equal(result[REVIEW_STEP_INDEX], "NOT_READY");
    }
  });

  test("5.3 it never says Complete before the draft is actually saved", () => {
    // Fully valid, every step visited, sitting on the review step — still not Complete.
    const unsaved = statuses(completeForm(), {
      activeIndex: 5,
      visited: ALL_STEPS,
      saved: false,
    });
    assert.notEqual(unsaved[REVIEW_STEP_INDEX], "COMPLETE");

    const saved = statuses(completeForm(), {
      activeIndex: 5,
      visited: ALL_STEPS,
      saved: true,
    });
    assert.equal(saved[REVIEW_STEP_INDEX], "COMPLETE");
  });

  test("5.4 being reachable or selected is not enough", () => {
    // Active, visited, and blank. The old code called this Complete.
    const result = statuses(EMPTY_CAMPAIGN_FORM, {
      activeIndex: 5,
      visited: ALL_STEPS,
    });
    assert.equal(result[REVIEW_STEP_INDEX], "NOT_READY");
  });
});

describe("6. labels and tones", () => {
  test("6.1 every status has a distinct, human label", () => {
    const labels = STEP_STATUSES.map(stepStatusLabel);
    assert.deepEqual(labels, [
      "Not started",
      "In progress",
      "Complete",
      "Needs attention",
      "Not ready",
      "Ready to save",
    ]);
    assert.equal(new Set(labels).size, labels.length, "two statuses share a label");
  });

  test("6.2 no label implies the campaign was published", () => {
    for (const label of STEP_STATUSES.map(stepStatusLabel)) {
      assert.ok(!/publish/i.test(label), `a status label mentions publishing: ${label}`);
    }
  });

  test("6.3 every status has a tone, and the tone is never the only signal", () => {
    for (const status of STEP_STATUSES) {
      assert.ok(stepStatusTone(status).length > 0);
      // The label is what carries the meaning; the tone only decorates it.
      assert.ok(stepStatusLabel(status).trim().length > 0);
    }
  });

  test("6.4 the settled and attention predicates agree with the labels", () => {
    assert.equal(isSettledStatus("COMPLETE"), true);
    assert.equal(isSettledStatus("READY_TO_SAVE"), true);
    assert.equal(isSettledStatus("NOT_STARTED"), false);
    assert.equal(isSettledStatus("NEEDS_ATTENTION"), false);
    assert.equal(needsAttention("NEEDS_ATTENTION"), true);
    assert.equal(needsAttention("NOT_READY"), false);
  });
});

describe("7. the progress sentence", () => {
  test("7.1 it reads as words, not a ratio", () => {
    assert.equal(progressDescription(4, 7, 0), "4 of 7 details complete");
  });

  test("7.2 it names how many need attention, with correct agreement", () => {
    assert.equal(
      progressDescription(4, 7, 1),
      "4 of 7 details complete, 1 needs attention",
    );
    assert.equal(
      progressDescription(2, 7, 3),
      "2 of 7 details complete, 3 need attention",
    );
  });
});

describe("8. structural invariants", () => {
  test("8.1 the review index is derived from the step list, not hard-coded", () => {
    assert.equal(REVIEW_STEP_INDEX, WIZARD_STEPS.length - 1);
    assert.equal(WIZARD_STEPS[REVIEW_STEP_INDEX].key, "review");
  });

  test("8.2 one status is produced per step, always", () => {
    for (const active of [0, 2, 5]) {
      const result = statuses(completeForm(), { activeIndex: active, visited: ALL_STEPS });
      assert.equal(result.length, WIZARD_STEPS.length);
      for (const status of result) {
        assert.ok(
          (STEP_STATUSES as readonly string[]).includes(status),
          `unknown status ${status}`,
        );
      }
    }
  });

  test("8.3 the review step is never given a configuration status", () => {
    for (const values of [EMPTY_CAMPAIGN_FORM, completeForm()]) {
      for (const saved of [false, true]) {
        const status = statuses(values, {
          activeIndex: 5,
          visited: ALL_STEPS,
          saved,
        })[REVIEW_STEP_INDEX];
        assert.ok(
          ["NOT_READY", "READY_TO_SAVE", "COMPLETE"].includes(status),
          `review reported ${status}`,
        );
      }
    }
    // And isConfigurationStepValid refuses to answer for it at all.
    assert.equal(isConfigurationStepValid(completeForm(), REVIEW_STEP_INDEX), false);
  });
});
