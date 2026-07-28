/**
 * Unit tests for lib/staff/staff-shop-assignment-input.ts — every DECISION the Manage
 * Shops editor makes.
 *
 * Run with:  npm test
 *
 * ============================================================================
 * WHY THE EDITOR'S LOGIC IS TESTED HERE AND NOT THROUGH A RENDERED DOM
 * ============================================================================
 * This repository has no component-test harness — no jsdom, no Testing Library, no
 * vitest/jest — and `npm test` runs `node --test` over `lib/**\/*.test.ts` only. Adding
 * one would mean installing packages, which AGENTS.md forbids without a request. The
 * established pattern here is instead the one ./portal-access-decision.test.ts and
 * ./staff-invite-input.test.ts already follow: put every branch in a pure module, test it
 * exhaustively, and keep the component a thin renderer of those decisions. The structural
 * claims about the .tsx itself (Save disabled while pending, no raw id rendered, dialog
 * semantics) are asserted separately by ./staff-shop-assignment-web-safety.test.ts.
 *
 * So: "current assignments are preselected", "at least one shop required", "duplicate
 * selection impossible", "Save disabled during submission", "stale shop handled safely"
 * and "counts are not a total" are all real, executed assertions below — against the
 * functions the component calls for exactly those decisions.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canManageStaffShops,
  canSaveSelection,
  describeSaveOutcome,
  hasSelectionChanged,
  MAX_SHOP_SELECTION,
  normalizeMembershipId,
  normalizeShopSelection,
  reconcileSelection,
  validateShopAssignmentInput,
} from "./staff-shop-assignment-input.ts";

/** Deterministic, obviously-fake UUIDs. No real identifier appears in this file. */
const SHOP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHOP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHOP_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SHOP_FOREIGN = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const MEMBERSHIP = "11111111-1111-4111-8111-111111111111";

// ============================================================================
// Eligibility — which roster rows may be edited
// ============================================================================
describe("canManageStaffShops", () => {
  test("offers the control for an ACTIVE Sales Staff membership", () => {
    assert.equal(
      canManageStaffShops({ roleCode: "SALES_STAFF", membershipStatus: "ACTIVE" }),
      true,
    );
  });

  test("never offers it for a Retailer Manager, whatever their status", () => {
    // Managers are retailer-wide BY ROLE and hold no shop-assignment rows at all, so the
    // operation is undefined for them. The RPC refuses such a target with 42501.
    for (const status of ["ACTIVE", "INVITED", "SUSPENDED", "DEACTIVATED"]) {
      assert.equal(
        canManageStaffShops({ roleCode: "RETAILER_MANAGER", membershipStatus: status }),
        false,
        `RETAILER_MANAGER/${status} must not be offered the control`,
      );
    }
  });

  test("never offers it for a Retailer Owner", () => {
    assert.equal(
      canManageStaffShops({ roleCode: "RETAILER_OWNER", membershipStatus: "ACTIVE" }),
      false,
    );
  });

  test("never offers it for a Sales Staff membership that is not ACTIVE", () => {
    // The RPC's target lookup filters on status = 'ACTIVE', so an INVITED, SUSPENDED or
    // DEACTIVATED membership is refused identically to an unknown one. Showing a control
    // that can only fail is worse than showing none.
    for (const status of ["INVITED", "SUSPENDED", "DEACTIVATED"]) {
      assert.equal(
        canManageStaffShops({ roleCode: "SALES_STAFF", membershipStatus: status }),
        false,
        `SALES_STAFF/${status} must not be offered the control`,
      );
    }
  });

  test("is case- and value-exact: no near-miss role or status is accepted", () => {
    assert.equal(
      canManageStaffShops({ roleCode: "sales_staff", membershipStatus: "ACTIVE" }),
      false,
    );
    assert.equal(
      canManageStaffShops({ roleCode: "SALES_STAFF", membershipStatus: "active" }),
      false,
    );
    assert.equal(
      canManageStaffShops({ roleCode: "", membershipStatus: "" }),
      false,
    );
  });
});

// ============================================================================
// Canonicalization
// ============================================================================
describe("normalizeMembershipId", () => {
  test("trims and lower-cases", () => {
    assert.equal(normalizeMembershipId(`  ${MEMBERSHIP.toUpperCase()}  `), MEMBERSHIP);
  });

  test("treats a non-string as absent rather than coercing it", () => {
    for (const value of [undefined, null, 42, {}, [], new Date(0)]) {
      assert.equal(normalizeMembershipId(value), "");
    }
  });
});

describe("normalizeShopSelection", () => {
  test("trims, lower-cases and sorts, so submission order cannot change the request", () => {
    assert.deepEqual(
      normalizeShopSelection([SHOP_B, ` ${SHOP_A.toUpperCase()} `, SHOP_C]),
      [SHOP_A, SHOP_B, SHOP_C],
    );
  });

  test("CANONICALIZES DUPLICATES rather than rejecting them", () => {
    // The decided behaviour (O-2): {A, A, B} means {A, B}. Under complete replacement the
    // two denote the same final state, so there is nothing for the operator to resolve.
    assert.deepEqual(normalizeShopSelection([SHOP_A, SHOP_A, SHOP_B]), [SHOP_A, SHOP_B]);
    assert.deepEqual(normalizeShopSelection([SHOP_C, SHOP_C, SHOP_C]), [SHOP_C]);
  });

  test("collapses duplicates that differ only in case or padding", () => {
    assert.deepEqual(
      normalizeShopSelection([SHOP_A, SHOP_A.toUpperCase(), ` ${SHOP_A} `]),
      [SHOP_A],
    );
  });

  test("drops blank entries but KEEPS malformed ones for validation to report", () => {
    // A tampered value must not be silently discarded into a shorter, valid-looking
    // request — it has to reach the validator and be refused.
    assert.deepEqual(normalizeShopSelection([SHOP_A, "", "   "]), [SHOP_A]);
    assert.deepEqual(normalizeShopSelection(["not-a-uuid"]), ["not-a-uuid"]);
  });

  test("treats a non-array as an empty selection", () => {
    for (const value of [undefined, null, "abc", 7, {}]) {
      assert.deepEqual(normalizeShopSelection(value), []);
    }
  });
});

// ============================================================================
// Validation
// ============================================================================
describe("validateShopAssignmentInput", () => {
  const allowed = [SHOP_A, SHOP_B, SHOP_C];

  test("accepts a well-formed submission of assignable shops", () => {
    const result = validateShopAssignmentInput(MEMBERSHIP, [SHOP_A, SHOP_B], allowed);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.shopIds, [SHOP_A, SHOP_B]);
    assert.equal(result.ok && result.membershipId, MEMBERSHIP);
  });

  test("REJECTS AN EMPTY SHOP LIST — the zero-shop rule", () => {
    const result = validateShopAssignmentInput(MEMBERSHIP, [], allowed);
    assert.deepEqual(result, { ok: false, reason: "empty" });
  });

  test("rejects a malformed membership id, and does so BEFORE consulting the shops", () => {
    for (const bad of ["", "not-a-uuid", MEMBERSHIP.slice(0, -1), `${MEMBERSHIP}x`]) {
      const result = validateShopAssignmentInput(bad, [SHOP_A], allowed);
      assert.deepEqual(
        result,
        { ok: false, reason: "invalid-target" },
        `${bad || "(empty)"} must be refused as a target`,
      );
    }

    // Even with an otherwise-empty shop list, the TARGET is what is reported — so a
    // tampered id never learns which shops exist by probing the other error.
    assert.deepEqual(validateShopAssignmentInput("nope", [], allowed), {
      ok: false,
      reason: "invalid-target",
    });
  });

  test("rejects a malformed shop id", () => {
    assert.deepEqual(
      validateShopAssignmentInput(MEMBERSHIP, [SHOP_A, "not-a-uuid"], allowed),
      { ok: false, reason: "unavailable-shop" },
    );
  });

  test("DEFENCE IN DEPTH: rejects a shop that is not in the freshly-read assignable set", () => {
    // The security property. SHOP_FOREIGN is a perfectly well-formed UUID; it is refused
    // solely because it is absent from the list the server just read for THIS caller.
    assert.deepEqual(
      validateShopAssignmentInput(MEMBERSHIP, [SHOP_A, SHOP_FOREIGN], allowed),
      { ok: false, reason: "unavailable-shop" },
    );
  });

  test("a malformed shop and a foreign shop are ONE outcome, not two", () => {
    // Distinguishing them would confirm whether some other shop id exists.
    const malformed = validateShopAssignmentInput(MEMBERSHIP, ["zzz"], allowed);
    const foreign = validateShopAssignmentInput(MEMBERSHIP, [SHOP_FOREIGN], allowed);
    assert.deepEqual(malformed, foreign);
  });

  test("refuses everything when the caller has no assignable shops at all", () => {
    assert.deepEqual(validateShopAssignmentInput(MEMBERSHIP, [SHOP_A], []), {
      ok: false,
      reason: "unavailable-shop",
    });
  });

  test("compares the allowed set case-insensitively", () => {
    const result = validateShopAssignmentInput(
      MEMBERSHIP,
      [SHOP_A],
      [SHOP_A.toUpperCase()],
    );
    assert.equal(result.ok, true);
  });

  test("bounds the submission size", () => {
    const many = Array.from({ length: MAX_SHOP_SELECTION + 1 }, (_, i) =>
      `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    assert.deepEqual(validateShopAssignmentInput(MEMBERSHIP, many, many), {
      ok: false,
      reason: "too-many",
    });
  });

  test("returns a COPY of the shop ids, so a caller cannot mutate the validated set", () => {
    const submitted = [SHOP_A, SHOP_B];
    const result = validateShopAssignmentInput(MEMBERSHIP, submitted, allowed);
    assert.equal(result.ok, true);
    if (result.ok) {
      result.shopIds.push(SHOP_FOREIGN);
      assert.deepEqual(submitted, [SHOP_A, SHOP_B]);
    }
  });
});

// ============================================================================
// Selection reconciliation — what the editor opens with
// ============================================================================
describe("reconcileSelection", () => {
  test("PRESELECTS the member's current active assignments", () => {
    assert.deepEqual(
      reconcileSelection([SHOP_A, SHOP_B], [SHOP_A, SHOP_B, SHOP_C]),
      [SHOP_A, SHOP_B],
    );
  });

  test("preselects nothing for a member with no visible assignments", () => {
    assert.deepEqual(reconcileSelection([], [SHOP_A, SHOP_B]), []);
  });

  test("DROPS a current assignment that is no longer assignable", () => {
    // The stale-shop case: a shop deactivated between the roster read and the picker
    // read. Preselecting it would tick a checkbox that does not exist and then submit it.
    assert.deepEqual(reconcileSelection([SHOP_A, SHOP_B], [SHOP_A]), [SHOP_A]);
  });

  test("a member whose every assignment became unassignable opens with nothing ticked", () => {
    // Correct, not a bug: Save stays disabled until the operator chooses, rather than the
    // editor silently submitting a set it could not show.
    assert.deepEqual(reconcileSelection([SHOP_B], [SHOP_A, SHOP_C]), []);
  });

  test("never invents a selection the picker is not offering", () => {
    assert.deepEqual(reconcileSelection([SHOP_FOREIGN], [SHOP_A]), []);
  });

  test("de-duplicates and sorts, so the result is stable and comparable", () => {
    assert.deepEqual(
      reconcileSelection(
        [SHOP_B, SHOP_A, SHOP_B.toUpperCase()],
        [SHOP_A, SHOP_B],
      ),
      [SHOP_A, SHOP_B],
    );
  });

  test("matches case-insensitively across the two reads", () => {
    assert.deepEqual(
      reconcileSelection([SHOP_A.toUpperCase()], [SHOP_A]),
      [SHOP_A],
    );
  });
});

describe("hasSelectionChanged", () => {
  test("false for an identical set, whatever the order or case", () => {
    assert.equal(hasSelectionChanged([SHOP_A, SHOP_B], [SHOP_B, SHOP_A]), false);
    assert.equal(hasSelectionChanged([SHOP_A], [SHOP_A.toUpperCase()]), false);
    assert.equal(hasSelectionChanged([], []), false);
  });

  test("true when a shop is added or removed", () => {
    assert.equal(hasSelectionChanged([SHOP_A], [SHOP_A, SHOP_B]), true);
    assert.equal(hasSelectionChanged([SHOP_A, SHOP_B], [SHOP_A]), true);
    assert.equal(hasSelectionChanged([SHOP_A], [SHOP_B]), true);
  });

  test("a repeated id is not mistaken for a change", () => {
    assert.equal(hasSelectionChanged([SHOP_A], [SHOP_A, SHOP_A]), false);
  });
});

// ============================================================================
// The Save gate
// ============================================================================
describe("canSaveSelection", () => {
  const ready = {
    selectedCount: 1,
    optionsReady: true,
    submitting: false,
    changed: true,
    alreadySaved: false,
  };

  test("enabled when everything is in order", () => {
    assert.equal(canSaveSelection(ready), true);
  });

  test("DISABLED with no shop selected — the zero-shop rule, enforced in the UI too", () => {
    assert.equal(canSaveSelection({ ...ready, selectedCount: 0 }), false);
  });

  test("DISABLED while the shop options have not loaded", () => {
    // A READ failure must never become a write attempt.
    assert.equal(canSaveSelection({ ...ready, optionsReady: false }), false);
  });

  test("DISABLED while a write is in progress — this is the duplicate-submit guard", () => {
    assert.equal(canSaveSelection({ ...ready, submitting: true }), false);
  });

  test("DISABLED when nothing changed, so a no-op save is not offered", () => {
    assert.equal(canSaveSelection({ ...ready, changed: false }), false);
  });

  test("DISABLED after a committed write, so an ordinary retry cannot resubmit it", () => {
    assert.equal(canSaveSelection({ ...ready, alreadySaved: true }), false);
  });

  test("DISABLED above the submission bound", () => {
    assert.equal(
      canSaveSelection({ ...ready, selectedCount: MAX_SHOP_SELECTION + 1 }),
      false,
    );
    assert.equal(
      canSaveSelection({ ...ready, selectedCount: MAX_SHOP_SELECTION }),
      true,
    );
  });

  test("any single blocking condition is sufficient to disable", () => {
    const blockers = [
      { optionsReady: false },
      { submitting: true },
      { changed: false },
      { alreadySaved: true },
      { selectedCount: 0 },
    ];
    for (const blocker of blockers) {
      assert.equal(
        canSaveSelection({ ...ready, ...blocker }),
        false,
        `${JSON.stringify(blocker)} must disable Save`,
      );
    }
  });
});

// ============================================================================
// Success copy — and what it must never claim
// ============================================================================
describe("describeSaveOutcome", () => {
  test("reports an addition and a removal together", () => {
    assert.equal(
      describeSaveOutcome({ added: 1, removed: 1, unchanged: 1 }),
      "Shop assignments updated: 1 added and 1 removed.",
    );
  });

  test("reports an addition alone", () => {
    assert.equal(
      describeSaveOutcome({ added: 2, removed: 0, unchanged: 1 }),
      "Shop assignments updated: 2 added.",
    );
  });

  test("reports a removal alone", () => {
    assert.equal(
      describeSaveOutcome({ added: 0, removed: 3, unchanged: 2 }),
      "Shop assignments updated: 3 removed.",
    );
  });

  test("does NOT claim an update when the backend wrote nothing", () => {
    // added === 0 && removed === 0 means no row moved and no audit event was written.
    // Saying "updated" would claim an event that did not happen.
    const message = describeSaveOutcome({ added: 0, removed: 0, unchanged: 4 });
    assert.match(message, /already up to date/i);
    assert.doesNotMatch(message, /updated:/i);
  });

  test("NEVER presents added + unchanged as the member's total shop count", () => {
    // THE LOAD-BEARING ASSERTION. A member may also hold live assignments to suspended or
    // deactivated shops, which the counts cannot see, so any total stated here would be a
    // confident false statement. The canonical roster re-read is the display authority.
    const cases = [
      { added: 1, removed: 1, unchanged: 1 },
      { added: 2, removed: 0, unchanged: 3 },
      { added: 0, removed: 1, unchanged: 5 },
      { added: 0, removed: 0, unchanged: 2 },
    ];

    for (const counts of cases) {
      const message = describeSaveOutcome(counts);
      const total = counts.added + counts.unchanged;

      assert.doesNotMatch(
        message,
        /\btotal\b|\bin total\b|\bnow (has|works|assigned)\b|\ball shops\b/i,
        `must not claim a total: ${message}`,
      );

      // The arithmetic itself must not appear as a standalone number, unless it happens
      // to coincide with a count the message legitimately reports.
      const reported = new Set([counts.added, counts.removed]);
      if (!reported.has(total)) {
        assert.doesNotMatch(
          message,
          new RegExp(`\\b${total}\\b`),
          `must not surface added+unchanged (${total}): ${message}`,
        );
      }
    }
  });

  test("never leaks an identifier or a shop name — it reports counts only", () => {
    const message = describeSaveOutcome({ added: 1, removed: 1, unchanged: 1 });
    assert.doesNotMatch(
      message,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });
});
