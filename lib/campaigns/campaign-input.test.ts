/**
 * Unit tests for @/lib/campaigns/campaign-input.
 *
 * Run with:  npm test
 *
 * The module is pure, so these exercise it directly. What they establish:
 *
 *   1. Normalization matches what the database will store, so the value echoed back to an
 *      operator is the value that will be saved.
 *   2. Every rule the RPC enforces is ALSO enforced here, against the same inputs the
 *      pgTAP suite uses — so the two cannot disagree about what is valid.
 *   3. The wall-clock -> instant conversion resolves against the CAMPAIGN'S time zone,
 *      not the browser's. This is the one piece of real arithmetic in the module and the
 *      one whose failure would be silent: a campaign that starts at the wrong hour looks
 *      exactly like a campaign that starts at the right one.
 *   4. There is NO path from an invalid form to RPC arguments.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MAX_CAMPAIGN_COINS } from "./campaign-vocabulary.ts";
import {
  EMPTY_CAMPAIGN_FORM,
  MAX_UNIT_TARGET,
  WIZARD_STEPS,
  hasMembershipChanged,
  isStepComplete,
  isKnownTimeZone,
  isUuid,
  isoToWallClock,
  normalizeCampaignForm,
  normalizeGroupForm,
  stepErrors,
  toCampaignRpcArgs,
  validateCampaignForm,
  validateGroupForm,
  wallClockToIso,
  type CampaignFormValues,
} from "./campaign-input.ts";

const RETAILER_A = "11111111-1111-4111-8111-111111111111";
const RETAILER_B = "22222222-2222-4222-8222-222222222222";
const GROUP_A = "33333333-3333-4333-8333-333333333333";
const PRODUCT_A = "44444444-4444-4444-8444-444444444444";

/** A complete, valid per-unit campaign. Tests override only what they are about. */
function validForm(overrides: Partial<CampaignFormValues> = {}): CampaignFormValues {
  return {
    ...EMPTY_CAMPAIGN_FORM,
    name: "Winter Push",
    description: "Five coins a unit.",
    timezoneName: "Asia/Dubai",
    startsAt: "2026-09-01T09:00",
    coinsPerUnit: "5",
    ...overrides,
  };
}

describe("normalization matches what the database stores", () => {
  test("1. the name is trimmed and internal whitespace collapsed", () => {
    const v = normalizeCampaignForm(validForm({ name: "  Winter   Push  " }));
    assert.equal(v.name, "Winter Push");
  });

  test("2. the exclusivity key is upper-cased and collapsed", () => {
    // The DATABASE decides whether two campaigns compete, by comparing this exact form.
    const v = normalizeCampaignForm(validForm({ exclusivityKey: " winter   bonus " }));
    assert.equal(v.exclusivityKey, "WINTER BONUS");
  });

  test("3. enum fields are upper-cased, so a lower-case submit is not a validation error", () => {
    const v = normalizeCampaignForm(
      validForm({ audienceMode: "selected_retailers", ruleType: "target_bonus" }),
    );
    assert.equal(v.audienceMode, "SELECTED_RETAILERS");
    assert.equal(v.ruleType, "TARGET_BONUS");
  });

  test("4. duplicate and blank ids collapse, and ids lower-case", () => {
    const v = normalizeCampaignForm(
      validForm({
        vendorRetailerIds: [RETAILER_A.toUpperCase(), RETAILER_A, "", "  ", RETAILER_B],
      }),
    );
    assert.deepEqual(v.vendorRetailerIds, [RETAILER_A, RETAILER_B]);
  });

  test("5. normalization is idempotent", () => {
    const once = normalizeCampaignForm(validForm({ name: "  A   B " }));
    assert.deepEqual(normalizeCampaignForm(once), once);
  });
});

describe("validation mirrors the RPC's rules", () => {
  test("6. a complete per-unit campaign is valid", () => {
    assert.equal(validateCampaignForm(validForm()).ok, true);
  });

  test("7. a blank name is refused", () => {
    const result = validateCampaignForm(validForm({ name: "   " }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.fieldErrors.name ?? "", /name/i);
  });

  test("8. an over-long name is refused", () => {
    const result = validateCampaignForm(validForm({ name: "x".repeat(151) }));
    assert.equal(result.ok, false);
  });

  test("9. a missing start is refused", () => {
    const result = validateCampaignForm(validForm({ startsAt: "" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.fieldErrors.startsAt !== undefined);
  });

  test("10. an end at or before the start is refused", () => {
    const before = validateCampaignForm(
      validForm({ startsAt: "2026-09-01T09:00", endsAt: "2026-08-01T09:00" }),
    );
    assert.equal(before.ok, false);
    const equal = validateCampaignForm(
      validForm({ startsAt: "2026-09-01T09:00", endsAt: "2026-09-01T09:00" }),
    );
    assert.equal(equal.ok, false);
    if (equal.ok) return;
    assert.match(equal.fieldErrors.endsAt ?? "", /after the start/i);
  });

  test("11. an end after the start is accepted, and an absent end is evergreen", () => {
    assert.equal(
      validateCampaignForm(
        validForm({ startsAt: "2026-09-01T09:00", endsAt: "2026-10-01T09:00" }),
      ).ok,
      true,
    );
    assert.equal(validateCampaignForm(validForm({ endsAt: "" })).ok, true);
  });

  test("12. SELECTED_RETAILERS with an empty selection is refused", () => {
    const result = validateCampaignForm(
      validForm({ audienceMode: "SELECTED_RETAILERS", vendorRetailerIds: [] }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.fieldErrors.vendorRetailerIds ?? "", /at least one Retailer/i);
  });

  test("13. RETAILER_GROUPS with no group is refused", () => {
    const result = validateCampaignForm(
      validForm({ audienceMode: "RETAILER_GROUPS", groupIds: [] }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.fieldErrors.groupIds ?? "", /group/i);
  });

  test("14. ALL_RETAILERS needs no selection", () => {
    assert.equal(
      validateCampaignForm(validForm({ audienceMode: "ALL_RETAILERS" })).ok,
      true,
    );
  });

  test("15. SELECTED_PRODUCTS with no product is refused", () => {
    const result = validateCampaignForm(
      validForm({ productScope: "SELECTED_PRODUCTS", productIds: [] }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.fieldErrors.productIds ?? "", /product/i);
  });

  test("16. a malformed id in a selection is refused", () => {
    const result = validateCampaignForm(
      validForm({ audienceMode: "SELECTED_RETAILERS", vendorRetailerIds: ["not-a-uuid"] }),
    );
    assert.equal(result.ok, false);
  });

  test("17. EXCLUSIVE requires a key; STACKABLE does not", () => {
    const missing = validateCampaignForm(
      validForm({ stackingMode: "EXCLUSIVE", exclusivityKey: "  " }),
    );
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.match(missing.fieldErrors.exclusivityKey ?? "", /exclusivity key/i);

    assert.equal(
      validateCampaignForm(validForm({ stackingMode: "STACKABLE", exclusivityKey: "" })).ok,
      true,
    );
    assert.equal(
      validateCampaignForm(
        validForm({ stackingMode: "EXCLUSIVE", exclusivityKey: "winter bonus" }),
      ).ok,
      true,
    );
  });

  test("18. an exclusivity key with an illegal character is refused", () => {
    const result = validateCampaignForm(
      validForm({ stackingMode: "EXCLUSIVE", exclusivityKey: "winter@bonus" }),
    );
    assert.equal(result.ok, false);
  });

  test("19. zero and negative coin values are refused", () => {
    for (const coins of ["0", "-5", "", "abc", "1.5", "1e3"]) {
      const result = validateCampaignForm(validForm({ coinsPerUnit: coins }));
      assert.equal(result.ok, false, `accepted "${coins}"`);
    }
  });

  test("20. a target bonus needs both a positive target and a positive bonus", () => {
    const base = { ruleType: "TARGET_BONUS", coinsPerUnit: "" };
    assert.equal(
      validateCampaignForm(
        validForm({ ...base, thresholdUnits: "10", rewardCoins: "100" }),
      ).ok,
      true,
    );
    assert.equal(
      validateCampaignForm(validForm({ ...base, thresholdUnits: "0", rewardCoins: "100" }))
        .ok,
      false,
    );
    assert.equal(
      validateCampaignForm(validForm({ ...base, thresholdUnits: "10", rewardCoins: "0" }))
        .ok,
      false,
    );
  });

  test("21. an optional cap is blank-or-positive", () => {
    assert.equal(validateCampaignForm(validForm({ maxRewardCoins: "" })).ok, true);
    assert.equal(validateCampaignForm(validForm({ maxRewardCoins: "10000" })).ok, true);
    assert.equal(validateCampaignForm(validForm({ maxRewardCoins: "0" })).ok, false);
  });

  test("21b. exactly the ceiling is accepted, one above is refused", () => {
    assert.equal(
      validateCampaignForm(validForm({ coinsPerUnit: "1000000000" })).ok,
      true,
      "1,000,000,000 coins per unit must be accepted",
    );
    assert.equal(
      validateCampaignForm(validForm({ coinsPerUnit: "1000000001" })).ok,
      false,
      "1,000,000,001 must be refused",
    );
    assert.equal(
      validateCampaignForm(validForm({ maxRewardCoins: "1000000000" })).ok,
      true,
    );
    assert.equal(
      validateCampaignForm(validForm({ maxRewardCoins: "1000000001" })).ok,
      false,
    );
  });

  test("21c. bigint maximum is refused, and never silently rounded", () => {
    // 9223372036854775807 is far beyond Number.MAX_SAFE_INTEGER, so parsing it would round.
    // The validator refuses it outright rather than accepting a different number than the
    // operator typed.
    const result = validateCampaignForm(
      validForm({ coinsPerUnit: "9223372036854775807" }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.fieldErrors.coinsPerUnit !== undefined);
  });

  test("21d. a target bonus is bounded on both fields", () => {
    const base = { ruleType: "TARGET_BONUS", coinsPerUnit: "" };
    assert.equal(
      validateCampaignForm(
        validForm({ ...base, thresholdUnits: "10", rewardCoins: "1000000000" }),
      ).ok,
      true,
    );
    assert.equal(
      validateCampaignForm(
        validForm({ ...base, thresholdUnits: "10", rewardCoins: "1000000001" }),
      ).ok,
      false,
    );
    // The unit target is an integer column, so its own ceiling is integer max.
    assert.equal(
      validateCampaignForm(
        validForm({ ...base, thresholdUnits: String(MAX_UNIT_TARGET), rewardCoins: "5" }),
      ).ok,
      true,
    );
    assert.equal(
      validateCampaignForm(
        validForm({
          ...base,
          thresholdUnits: String(MAX_UNIT_TARGET + 1),
          rewardCoins: "5",
        }),
      ).ok,
      false,
    );
  });

  test("21e. every accepted coin value survives JavaScript arithmetic exactly", () => {
    assert.ok(MAX_CAMPAIGN_COINS < Number.MAX_SAFE_INTEGER);
    const args = toCampaignRpcArgs(validForm({ coinsPerUnit: String(MAX_CAMPAIGN_COINS) }));
    assert.ok(args !== null);
    assert.equal(args.p_coins_per_unit, MAX_CAMPAIGN_COINS);
    assert.ok(Number.isSafeInteger(args.p_coins_per_unit));
  });

  test("22. an out-of-range priority is refused", () => {
    assert.equal(validateCampaignForm(validForm({ priority: "1001" })).ok, false);
    assert.equal(validateCampaignForm(validForm({ priority: "-1" })).ok, false);
    assert.equal(validateCampaignForm(validForm({ priority: "1000" })).ok, true);
    assert.equal(validateCampaignForm(validForm({ priority: "" })).ok, true);
  });

  test("23. an unknown enum value is refused", () => {
    assert.equal(validateCampaignForm(validForm({ audienceMode: "EVERYONE" })).ok, false);
    assert.equal(
      validateCampaignForm(validForm({ performanceScope: "WHOLE_REGION" })).ok,
      false,
    );
    assert.equal(
      validateCampaignForm(validForm({ ruleType: "PERCENTAGE_OF_SALES" })).ok,
      false,
    );
  });

  test("24. a missing time zone is refused, and a shape-invalid one too", () => {
    assert.equal(validateCampaignForm(validForm({ timezoneName: "" })).ok, false);
    assert.equal(validateCampaignForm(validForm({ timezoneName: "Bad Zone!" })).ok, false);
  });

  test("25. a well-shaped but nonexistent zone is refused, against the ZONE field", () => {
    // Checked by asking Intl, not by a shipped list of IANA names. The DATABASE refuses
    // it independently — pgTAP test D4 proves that — so this is a faster message, never
    // the authority.
    const result = validateCampaignForm(validForm({ timezoneName: "Mars/Olympus" }));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.fieldErrors.timezoneName !== undefined);
    // NOT reported against the start date, which is perfectly well formed.
    assert.equal(result.fieldErrors.startsAt, undefined);
  });

  test("25b. a real but unusual zone is accepted", () => {
    assert.equal(
      validateCampaignForm(
        validForm({ timezoneName: "America/Argentina/Buenos_Aires" }),
      ).ok,
      true,
    );
    assert.ok(isKnownTimeZone("Asia/Dubai"));
    assert.ok(!isKnownTimeZone("Mars/Olympus"));
  });
});

describe("wall-clock times resolve in the CAMPAIGN's zone, not the browser's", () => {
  test("26. a Dubai wall clock becomes the correct UTC instant", () => {
    // Asia/Dubai is UTC+4 year-round: 09:00 local is 05:00Z.
    assert.equal(wallClockToIso("2026-09-01T09:00", "Asia/Dubai"), "2026-09-01T05:00:00.000Z");
  });

  test("27. UTC is the identity", () => {
    assert.equal(wallClockToIso("2026-09-01T09:00", "UTC"), "2026-09-01T09:00:00.000Z");
  });

  test("28. a DST zone resolves both sides of the change correctly", () => {
    // Europe/London: BST (UTC+1) in July, GMT (UTC+0) in January.
    assert.equal(wallClockToIso("2026-07-01T12:00", "Europe/London"), "2026-07-01T11:00:00.000Z");
    assert.equal(wallClockToIso("2026-01-01T12:00", "Europe/London"), "2026-01-01T12:00:00.000Z");
  });

  test("29. a negative-offset zone resolves correctly", () => {
    // America/New_York in January is UTC-5.
    assert.equal(
      wallClockToIso("2026-01-15T08:00", "America/New_York"),
      "2026-01-15T13:00:00.000Z",
    );
  });

  test("30. the conversion round-trips", () => {
    for (const zone of ["Asia/Dubai", "UTC", "Europe/London", "America/New_York"]) {
      const wall = "2026-06-15T14:30";
      const iso = wallClockToIso(wall, zone);
      assert.ok(iso !== null, `${zone} produced null`);
      assert.equal(isoToWallClock(iso, zone), wall, `${zone} did not round-trip`);
    }
  });

  test("31. a malformed wall clock or an unknown zone yields null, never a guess", () => {
    assert.equal(wallClockToIso("not-a-time", "UTC"), null);
    assert.equal(wallClockToIso("2026-09-01", "UTC"), null);
    assert.equal(wallClockToIso("2026-09-01T09:00", ""), null);
    assert.equal(wallClockToIso("2026-09-01T09:00", "Mars/Olympus"), null);
  });

  test("32. isoToWallClock degrades to an empty string rather than throwing", () => {
    assert.equal(isoToWallClock("not-an-instant", "UTC"), "");
    assert.equal(isoToWallClock("2026-09-01T09:00:00Z", "Mars/Olympus"), "");
  });

  test("33. the same wall clock in two zones is two different instants", () => {
    // The whole point: a campaign authored as "9am Dubai" must not become 9am London.
    const dubai = wallClockToIso("2026-09-01T09:00", "Asia/Dubai");
    const london = wallClockToIso("2026-09-01T09:00", "Europe/London");
    assert.notEqual(dubai, london);
  });
});

describe("wizard steps", () => {
  test("34. there are six steps, ending with review", () => {
    assert.equal(WIZARD_STEPS.length, 6);
    assert.equal(WIZARD_STEPS[WIZARD_STEPS.length - 1].key, "review");
  });

  test("35. a step shows only its own errors", () => {
    const result = validateCampaignForm(
      validForm({ name: "", coinsPerUnit: "0", timezoneName: "" }),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;

    assert.deepEqual(Object.keys(stepErrors(result.fieldErrors, "details")), ["name"]);
    assert.deepEqual(Object.keys(stepErrors(result.fieldErrors, "reward")), ["coinsPerUnit"]);
    assert.ok("timezoneName" in stepErrors(result.fieldErrors, "schedule"));
    // The details step must not surface the schedule's problem.
    assert.ok(!("timezoneName" in stepErrors(result.fieldErrors, "details")));
  });

  test("36. a step with no errors of its own is complete even when another has some", () => {
    const values = validForm({ coinsPerUnit: "0" });
    assert.equal(isStepComplete(values, "details"), true);
    assert.equal(isStepComplete(values, "reward"), false);
  });

  test("37. the review step has no fields of its own, so it is always complete", () => {
    assert.equal(isStepComplete(validForm({ name: "" }), "review"), true);
  });
});

describe("RPC arguments", () => {
  test("38. an invalid form produces NO arguments — there is no bypass", () => {
    assert.equal(toCampaignRpcArgs(validForm({ name: "" })), null);
    assert.equal(toCampaignRpcArgs(validForm({ coinsPerUnit: "0" })), null);
  });

  test("39. a per-unit campaign sends the rate and no target fields", () => {
    const args = toCampaignRpcArgs(validForm({ maxRewardCoins: "10000" }));
    assert.ok(args !== null);
    assert.equal(args.p_rule_type, "PER_UNIT_COINS");
    assert.equal(args.p_coins_per_unit, 5);
    assert.equal(args.p_threshold_units, null);
    assert.equal(args.p_reward_coins, null);
    assert.equal(args.p_max_reward_coins, 10000);
  });

  test("40. a target-bonus campaign sends the target and no rate", () => {
    const args = toCampaignRpcArgs(
      validForm({
        ruleType: "TARGET_BONUS",
        coinsPerUnit: "",
        thresholdUnits: "10",
        rewardCoins: "100",
      }),
    );
    assert.ok(args !== null);
    assert.equal(args.p_rule_type, "TARGET_BONUS");
    assert.equal(args.p_coins_per_unit, null);
    assert.equal(args.p_threshold_units, 10);
    assert.equal(args.p_reward_coins, 100);
  });

  test("41. arrays the mode does not use are sent as null, not as a stale selection", () => {
    const args = toCampaignRpcArgs(
      validForm({
        audienceMode: "ALL_RETAILERS",
        // Left over from a previous step; the campaign does not use them.
        vendorRetailerIds: [RETAILER_A],
        groupIds: [GROUP_A],
        productScope: "ALL_ELIGIBLE_PRODUCTS",
        productIds: [PRODUCT_A],
      }),
    );
    assert.ok(args !== null);
    assert.equal(args.p_vendor_retailer_ids, null);
    assert.equal(args.p_group_ids, null);
    assert.equal(args.p_product_ids, null);
  });

  test("42. the selected mode sends exactly its own array", () => {
    const args = toCampaignRpcArgs(
      validForm({
        audienceMode: "SELECTED_RETAILERS",
        vendorRetailerIds: [RETAILER_A, RETAILER_B],
        groupIds: [GROUP_A],
      }),
    );
    assert.ok(args !== null);
    assert.deepEqual(args.p_vendor_retailer_ids, [RETAILER_A, RETAILER_B]);
    assert.equal(args.p_group_ids, null);
  });

  test("43. a stackable campaign sends a null exclusivity key", () => {
    const args = toCampaignRpcArgs(
      validForm({ stackingMode: "STACKABLE", exclusivityKey: "leftover" }),
    );
    assert.ok(args !== null);
    assert.equal(args.p_exclusivity_key, null);
  });

  test("44. an exclusive campaign sends the normalized key", () => {
    const args = toCampaignRpcArgs(
      validForm({ stackingMode: "EXCLUSIVE", exclusivityKey: " winter  bonus " }),
    );
    assert.ok(args !== null);
    assert.equal(args.p_exclusivity_key, "WINTER BONUS");
  });

  test("45. the start is an ISO instant resolved in the campaign's zone", () => {
    const args = toCampaignRpcArgs(
      validForm({ timezoneName: "Asia/Dubai", startsAt: "2026-09-01T09:00" }),
    );
    assert.ok(args !== null);
    assert.equal(args.p_starts_at, "2026-09-01T05:00:00.000Z");
    assert.equal(args.p_timezone_name, "Asia/Dubai");
  });

  test("46. an evergreen campaign sends a null end", () => {
    const args = toCampaignRpcArgs(validForm({ endsAt: "" }));
    assert.ok(args !== null);
    assert.equal(args.p_ends_at, null);
  });

  test("47. an empty description is null, not an empty string", () => {
    const args = toCampaignRpcArgs(validForm({ description: "   " }));
    assert.ok(args !== null);
    assert.equal(args.p_description, null);
  });

  test("48. every argument key is one the RPC declares", () => {
    const args = toCampaignRpcArgs(validForm());
    assert.ok(args !== null);
    // No actor id, Vendor id, organization id, permission code or audit field: the
    // database derives every one of them from auth.uid().
    for (const key of Object.keys(args)) {
      assert.ok(key.startsWith("p_"), `unexpected argument ${key}`);
      assert.ok(
        !/actor|vendor_organization|organization_id|permission|role|audit|status_before/i.test(
          key,
        ),
        `argument ${key} would be a client-supplied authority claim`,
      );
    }
  });
});

describe("Retailer group input", () => {
  test("49. a group name is trimmed, collapsed and required", () => {
    assert.equal(normalizeGroupForm({ name: "  A   B ", description: "" }).name, "A B");
    assert.equal(validateGroupForm({ name: "   ", description: "" }).ok, false);
    assert.equal(validateGroupForm({ name: "Premium", description: "" }).ok, true);
  });

  test("50. over-long name and description are refused", () => {
    assert.equal(
      validateGroupForm({ name: "x".repeat(121), description: "" }).ok,
      false,
    );
    assert.equal(
      validateGroupForm({ name: "Premium", description: "x".repeat(501) }).ok,
      false,
    );
  });

  test("51. membership change detection ignores order and duplicates", () => {
    assert.equal(hasMembershipChanged([RETAILER_A, RETAILER_B], [RETAILER_B, RETAILER_A]), false);
    assert.equal(hasMembershipChanged([RETAILER_A], [RETAILER_A, RETAILER_A]), false);
    assert.equal(hasMembershipChanged([RETAILER_A], [RETAILER_A, RETAILER_B]), true);
    assert.equal(hasMembershipChanged([RETAILER_A], []), true);
    assert.equal(hasMembershipChanged([], []), false);
  });

  test("52. it is case-insensitive about ids", () => {
    assert.equal(hasMembershipChanged([RETAILER_A], [RETAILER_A.toUpperCase()]), false);
  });
});

describe("isUuid", () => {
  test("53. accepts canonical UUIDs and rejects near-misses", () => {
    assert.equal(isUuid(RETAILER_A), true);
    assert.equal(isUuid(RETAILER_A.toUpperCase()), true);
    assert.equal(isUuid(""), false);
    assert.equal(isUuid("11111111-1111-4111-8111-11111111111"), false);
    assert.equal(isUuid("../../etc/passwd"), false);
    assert.equal(isUuid(`${RETAILER_A} `), false);
  });
});
