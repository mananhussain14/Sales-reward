/**
 * BEHAVIOURAL tests for the Vendor Retailer lifecycle DECISIONS.
 *
 *   lib/retailers/vendor-retailer-lifecycle-input.ts
 *
 * Run with:  npm test
 *
 * These exercise the pure module directly — no DOM, no Supabase, no `next/headers` — so
 * every rule the control depends on is asserted as BEHAVIOUR rather than as source text. The
 * static guards over the wrapper, the Server Action and the page live in
 * ./vendor-retailer-lifecycle-web.test.ts.
 *
 * WHAT THESE DO NOT PROVE. None of this is the enforcement boundary.
 * public.set_vendor_retailer_status re-derives the acting Vendor, the tenant boundary, the
 * organization type, the multi-Vendor guard and the current pair from auth.uid() under its
 * own row locks, and the pgTAP suite in supabase/tests/database/ is what proves that. These
 * tests prove the BROWSER is never offered an action the database would refuse.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  VENDOR_RETAILER_LIFECYCLE_STATUSES,
  canSubmitVendorRetailerLifecycleChange,
  describeVendorRetailerLifecycleNoChange,
  describeVendorRetailerLifecycleOutcome,
  formatRetailerLifecycleLabel,
  isConfirmedManageCapability,
  isVendorRetailerLifecycleControlOffered,
  isVendorRetailerLifecycleStatus,
  normalizeVendorRetailerRelationshipId,
  normalizeVendorRetailerRequestedStatus,
  readVendorRetailerLifecycleRow,
  resolveVendorRetailerLifecycle,
  validateVendorRetailerLifecycleSubmission,
  validateVendorRetailerLifecycleTransition,
} from "./vendor-retailer-lifecycle-input.ts";

const RELATIONSHIP_ID = "11111111-2222-4333-8444-555555555555";

/** A supported pair, built in one place so a test states only what it varies. */
function pair(retailerStatus: string, relationshipStatus: string) {
  return { retailerStatus, relationshipStatus };
}

// ============================================================================
// The stored vocabulary
// ============================================================================
describe("Vendor Retailer lifecycle — the stored vocabulary", () => {
  test("is exactly ACTIVE and SUSPENDED", () => {
    assert.deepEqual(
      [...VENDOR_RETAILER_LIFECYCLE_STATUSES],
      ["ACTIVE", "SUSPENDED"],
      "the RPC accepts these two and nothing else",
    );
  });

  test("DEACTIVATED is not part of this operation's vocabulary", () => {
    assert.equal(isVendorRetailerLifecycleStatus("DEACTIVATED"), false);
  });

  test("INACTIVE is a display word and is never a stored status", () => {
    assert.equal(
      isVendorRetailerLifecycleStatus("INACTIVE"),
      false,
      "INACTIVE must never be accepted as a value bound for the RPC",
    );
  });

  test("the comparison is case-sensitive and rejects surrounding space", () => {
    for (const bad of ["active", "suspended", " ACTIVE", "ACTIVE ", "Active"]) {
      assert.equal(isVendorRetailerLifecycleStatus(bad), false, `${bad} must be rejected`);
    }
  });

  test("non-strings are rejected without throwing", () => {
    for (const bad of [null, undefined, 0, 1, {}, [], true]) {
      assert.equal(isVendorRetailerLifecycleStatus(bad), false);
    }
  });
});

// ============================================================================
// Lifecycle pair resolution
// ============================================================================
describe("Vendor Retailer lifecycle — pair resolution", () => {
  test("ACTIVE/ACTIVE is eligible and offers Deactivate Retailer", () => {
    const action = resolveVendorRetailerLifecycle(pair("ACTIVE", "ACTIVE"));
    assert.notEqual(action, null);
    assert.equal(action?.actionLabel, "Deactivate Retailer");
  });

  test("ACTIVE/ACTIVE requests SUSPENDED — never INACTIVE", () => {
    const action = resolveVendorRetailerLifecycle(pair("ACTIVE", "ACTIVE"));
    assert.equal(action?.requestedStatus, "SUSPENDED");
    assert.notEqual(action?.requestedStatus as string, "INACTIVE");
  });

  test("SUSPENDED/SUSPENDED is eligible and offers Reactivate Retailer", () => {
    const action = resolveVendorRetailerLifecycle(pair("SUSPENDED", "SUSPENDED"));
    assert.notEqual(action, null);
    assert.equal(action?.actionLabel, "Reactivate Retailer");
  });

  test("SUSPENDED/SUSPENDED requests ACTIVE", () => {
    const action = resolveVendorRetailerLifecycle(pair("SUSPENDED", "SUSPENDED"));
    assert.equal(action?.requestedStatus, "ACTIVE");
  });

  test("ACTIVE/SUSPENDED mismatch is excluded", () => {
    assert.equal(resolveVendorRetailerLifecycle(pair("ACTIVE", "SUSPENDED")), null);
  });

  test("SUSPENDED/ACTIVE mismatch is excluded", () => {
    assert.equal(resolveVendorRetailerLifecycle(pair("SUSPENDED", "ACTIVE")), null);
  });

  test("a DEACTIVATED relationship is excluded, in both directions", () => {
    assert.equal(resolveVendorRetailerLifecycle(pair("ACTIVE", "DEACTIVATED")), null);
    assert.equal(
      resolveVendorRetailerLifecycle(pair("DEACTIVATED", "DEACTIVATED")),
      null,
      "even a SYNCHRONIZED DEACTIVATED pair is refused — the state is terminal",
    );
  });

  test("a DEACTIVATED organization is excluded", () => {
    assert.equal(resolveVendorRetailerLifecycle(pair("DEACTIVATED", "ACTIVE")), null);
  });

  test("an unknown status is excluded even when both rows agree", () => {
    assert.equal(resolveVendorRetailerLifecycle(pair("PAUSED", "PAUSED")), null);
    assert.equal(resolveVendorRetailerLifecycle(pair("INACTIVE", "INACTIVE")), null);
  });

  test("a missing or empty status is excluded", () => {
    assert.equal(resolveVendorRetailerLifecycle(pair("", "")), null);
    assert.equal(
      resolveVendorRetailerLifecycle({
        retailerStatus: undefined as unknown as string,
        relationshipStatus: undefined as unknown as string,
      }),
      null,
    );
  });

  test("only the two synchronized pairs are ever eligible", () => {
    const vocabulary = ["ACTIVE", "SUSPENDED", "DEACTIVATED", "INVITED", "", "INACTIVE"];
    const eligible: string[] = [];

    for (const a of vocabulary) {
      for (const b of vocabulary) {
        if (resolveVendorRetailerLifecycle(pair(a, b)) !== null) {
          eligible.push(`${a}/${b}`);
        }
      }
    }

    assert.deepEqual(eligible.sort(), ["ACTIVE/ACTIVE", "SUSPENDED/SUSPENDED"]);
  });
});

// ============================================================================
// Display terminology
// ============================================================================
describe("Vendor Retailer lifecycle — terminology", () => {
  test("ACTIVE displays Active", () => {
    assert.equal(formatRetailerLifecycleLabel("ACTIVE"), "Active");
  });

  test("SUSPENDED displays Inactive, never Suspended", () => {
    assert.equal(formatRetailerLifecycleLabel("SUSPENDED"), "Inactive");
  });

  test("no offered action label uses the word Suspended", () => {
    for (const p of [pair("ACTIVE", "ACTIVE"), pair("SUSPENDED", "SUSPENDED")]) {
      const action = resolveVendorRetailerLifecycle(p);
      assert.notEqual(action, null);
      assert.doesNotMatch(action!.actionLabel, /suspend/i);
      assert.doesNotMatch(action!.displayLabel, /suspend/i);
    }
  });

  test("the action copy is Deactivate / Reactivate", () => {
    assert.equal(
      resolveVendorRetailerLifecycle(pair("ACTIVE", "ACTIVE"))?.actionLabel,
      "Deactivate Retailer",
    );
    assert.equal(
      resolveVendorRetailerLifecycle(pair("SUSPENDED", "SUSPENDED"))?.actionLabel,
      "Reactivate Retailer",
    );
  });

  test("an out-of-vocabulary status has no lifecycle label", () => {
    assert.equal(formatRetailerLifecycleLabel("DEACTIVATED"), null);
    assert.equal(formatRetailerLifecycleLabel("nonsense"), null);
  });
});

// ============================================================================
// Capability
// ============================================================================
describe("Vendor Retailer lifecycle — capability", () => {
  test("confirmed RETAILERS_MANAGE may show the control", () => {
    assert.equal(isConfirmedManageCapability("confirmed"), true);
    assert.equal(
      isVendorRetailerLifecycleControlOffered({
        capability: "confirmed",
        pair: pair("ACTIVE", "ACTIVE"),
      }),
      true,
    );
  });

  test("denied capability hides the control", () => {
    assert.equal(isConfirmedManageCapability("denied"), false);
    assert.equal(
      isVendorRetailerLifecycleControlOffered({
        capability: "denied",
        pair: pair("ACTIVE", "ACTIVE"),
      }),
      false,
    );
  });

  test("unavailable capability hides the control", () => {
    assert.equal(isConfirmedManageCapability("unavailable"), false);
    assert.equal(
      isVendorRetailerLifecycleControlOffered({
        capability: "unavailable",
        pair: pair("ACTIVE", "ACTIVE"),
      }),
      false,
    );
  });

  test("malformed, unknown and missing capability values all hide the control", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "CONFIRMED",
      "confirmd",
      "pending",
      "loading",
      true,
      1,
      {},
      [],
      { status: "confirmed" },
    ]) {
      assert.equal(
        isConfirmedManageCapability(bad),
        false,
        `${JSON.stringify(bad)} must not count as confirmed`,
      );
      assert.equal(
        isVendorRetailerLifecycleControlOffered({
          capability: bad,
          pair: pair("ACTIVE", "ACTIVE"),
        }),
        false,
      );
    }
  });

  test("the rule is POSITIVE EQUALITY, so a brand-new state fails closed", () => {
    // The property that matters: a value nobody has thought of yet must be refused without
    // this predicate being edited. An exclusion list (`!== "denied"`) would admit it.
    assert.equal(isConfirmedManageCapability("a-state-invented-in-2027"), false);
  });

  test("a confirmed capability still cannot rescue an unsupported pair", () => {
    assert.equal(
      isVendorRetailerLifecycleControlOffered({
        capability: "confirmed",
        pair: pair("ACTIVE", "SUSPENDED"),
      }),
      false,
    );
    assert.equal(
      isVendorRetailerLifecycleControlOffered({
        capability: "confirmed",
        pair: pair("DEACTIVATED", "DEACTIVATED"),
      }),
      false,
    );
  });
});

// ============================================================================
// Canonicalization and validation
// ============================================================================
describe("Vendor Retailer lifecycle — submission validation", () => {
  test("a well-formed submission is accepted", () => {
    const result = validateVendorRetailerLifecycleSubmission(RELATIONSHIP_ID, "SUSPENDED");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.requestedStatus, "SUSPENDED");
  });

  test("an invalid relationship UUID is rejected", () => {
    for (const bad of ["", "not-a-uuid", "1234", `${RELATIONSHIP_ID}x`]) {
      const result = validateVendorRetailerLifecycleSubmission(bad, "SUSPENDED");
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, "invalid-target");
    }
  });

  test("an invalid requested status is rejected", () => {
    for (const bad of ["", "INACTIVE", "DEACTIVATED", "suspended", "nonsense"]) {
      const result = validateVendorRetailerLifecycleSubmission(RELATIONSHIP_ID, bad);
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.reason, "invalid-status");
    }
  });

  test("the target is checked BEFORE the status, so a bad id never reports a status reason", () => {
    const result = validateVendorRetailerLifecycleSubmission("nope", "nonsense");
    assert.equal(!result.ok && result.reason, "invalid-target");
  });

  test("the relationship id is canonicalized but the status is NOT upper-cased", () => {
    assert.equal(
      normalizeVendorRetailerRelationshipId(`  ${RELATIONSHIP_ID.toUpperCase()}  `),
      RELATIONSHIP_ID,
    );
    assert.equal(
      normalizeVendorRetailerRequestedStatus("  active  "),
      "active",
      "silently upper-casing would accept a request the database refuses with 23514",
    );
  });

  test("a File-like value is treated as absent rather than coerced", () => {
    assert.equal(normalizeVendorRetailerRequestedStatus({ name: "x" }), "");
    assert.equal(normalizeVendorRetailerRelationshipId(null), "");
  });
});

describe("Vendor Retailer lifecycle — transition validation", () => {
  test("ACTIVE/ACTIVE accepts SUSPENDED", () => {
    const result = validateVendorRetailerLifecycleTransition(
      pair("ACTIVE", "ACTIVE"),
      "SUSPENDED",
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.requestedStatus, "SUSPENDED");
  });

  test("SUSPENDED/SUSPENDED accepts ACTIVE", () => {
    const result = validateVendorRetailerLifecycleTransition(
      pair("SUSPENDED", "SUSPENDED"),
      "ACTIVE",
    );
    assert.equal(result.ok, true);
  });

  test("the submitted status must be the OPPOSITE of the current pair", () => {
    const sameDirection = validateVendorRetailerLifecycleTransition(
      pair("ACTIVE", "ACTIVE"),
      "ACTIVE",
    );
    assert.equal(sameDirection.ok, false);
    assert.equal(!sameDirection.ok && sameDirection.reason, "wrong-direction");

    const reverse = validateVendorRetailerLifecycleTransition(
      pair("SUSPENDED", "SUSPENDED"),
      "SUSPENDED",
    );
    assert.equal(!reverse.ok && reverse.reason, "wrong-direction");
  });

  test("an unsupported pair is refused whatever is requested", () => {
    for (const p of [
      pair("ACTIVE", "SUSPENDED"),
      pair("SUSPENDED", "ACTIVE"),
      pair("DEACTIVATED", "ACTIVE"),
      pair("ACTIVE", "DEACTIVATED"),
      pair("PAUSED", "PAUSED"),
    ]) {
      for (const requested of ["ACTIVE", "SUSPENDED"]) {
        const result = validateVendorRetailerLifecycleTransition(p, requested);
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.reason, "unsupported-pair");
      }
    }
  });

  test("the pair is the AUTHORITY — a valid-looking status cannot override it", () => {
    // The property: nothing the browser sends can make an unsupported pair actionable.
    const result = validateVendorRetailerLifecycleTransition(
      pair("ACTIVE", "DEACTIVATED"),
      "SUSPENDED",
    );
    assert.equal(result.ok, false);
  });
});

// ============================================================================
// Copy
// ============================================================================
describe("Vendor Retailer lifecycle — copy", () => {
  const NAME = "Northline Retail";

  test("the deactivation success names the Retailer and promises preservation", () => {
    const message = describeVendorRetailerLifecycleOutcome(NAME, "SUSPENDED");
    assert.match(message, /Northline Retail/);
    assert.match(message, /inactive/i);
    assert.match(message, /unchanged|kept|preserved/i);
  });

  test("the reactivation success describes restoration", () => {
    const message = describeVendorRetailerLifecycleOutcome(NAME, "ACTIVE");
    assert.match(message, /active again/i);
    assert.match(message, /available|restored/i);
  });

  test("the no-op copy is an outcome, not an error", () => {
    assert.match(
      describeVendorRetailerLifecycleNoChange(NAME, "SUSPENDED"),
      /already inactive/i,
    );
    assert.match(
      describeVendorRetailerLifecycleNoChange(NAME, "ACTIVE"),
      /already active/i,
    );
  });

  test("no copy string prints the stored vocabulary or an identifier", () => {
    const messages = [
      describeVendorRetailerLifecycleOutcome(NAME, "SUSPENDED"),
      describeVendorRetailerLifecycleOutcome(NAME, "ACTIVE"),
      describeVendorRetailerLifecycleNoChange(NAME, "SUSPENDED"),
      describeVendorRetailerLifecycleNoChange(NAME, "ACTIVE"),
    ];

    for (const message of messages) {
      assert.doesNotMatch(message, /SUSPENDED|DEACTIVATED|\bACTIVE\b/);
      assert.doesNotMatch(message, /suspend/i, "the product never says suspended");
      assert.doesNotMatch(message, /[0-9a-f]{8}-[0-9a-f]{4}/i, "no uuid");
      assert.doesNotMatch(message, /42501|23514|55000|22P02/, "no SQLSTATE");
    }
  });
});

// ============================================================================
// Response parsing
// ============================================================================
/**
 * EVERY REJECTION HERE MEANS "COMMITTED, BUT UNDESCRIBABLE".
 *
 * The parser is reached only when PostgREST reported no error, so the transaction has already
 * committed. `null` is therefore mapped by the wrapper to `saved-unconfirmed` — a success with
 * a caveat that tells the operator to refresh and never invites a retry. Each test below
 * states which of the two facts it is pinning: that the response is refused, and that the
 * refusal is the safe one.
 */
describe("Vendor Retailer lifecycle — RPC response parsing", () => {
  const OTHER_ID = "99999999-8888-4777-8666-555555555555";

  /** A complete, valid single-row response. */
  function response(overrides: Record<string, unknown> = {}) {
    return [
      {
        relationship_id: RELATIONSHIP_ID,
        retailer_status: "SUSPENDED",
        relationship_status: "SUSPENDED",
        status_changed: true,
        ...overrides,
      },
    ];
  }

  test("1. a valid matching relationship_id is accepted", () => {
    const row = readVendorRetailerLifecycleRow(response(), RELATIONSHIP_ID);
    assert.notEqual(row, null);
    assert.equal(row?.retailerStatus, "SUSPENDED");
    assert.equal(row?.relationshipStatus, "SUSPENDED");
    assert.equal(row?.changed, true);
  });

  test("1b. an upper-cased echo of the same UUID is the same row", () => {
    // A UUID's canonical form differs only in case; this is a check that the right ROW came
    // back, not a string-formatting check.
    const row = readVendorRetailerLifecycleRow(
      response({ relationship_id: RELATIONSHIP_ID.toUpperCase() }),
      RELATIONSHIP_ID,
    );
    assert.notEqual(row, null);
  });

  test("2. a MISSING relationship_id is refused", () => {
    const [only] = response();
    delete (only as Record<string, unknown>).relationship_id;
    assert.equal(readVendorRetailerLifecycleRow([only], RELATIONSHIP_ID), null);
  });

  test("3. a NULL relationship_id is refused", () => {
    assert.equal(
      readVendorRetailerLifecycleRow(
        response({ relationship_id: null }),
        RELATIONSHIP_ID,
      ),
      null,
    );
  });

  test("4. a NON-STRING relationship_id is refused", () => {
    for (const bad of [0, 1, true, {}, [], { id: RELATIONSHIP_ID }]) {
      assert.equal(
        readVendorRetailerLifecycleRow(
          response({ relationship_id: bad }),
          RELATIONSHIP_ID,
        ),
        null,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  test("5. a MALFORMED UUID relationship_id is refused", () => {
    for (const bad of ["", "not-a-uuid", "1234", `${RELATIONSHIP_ID}x`, " "]) {
      assert.equal(
        readVendorRetailerLifecycleRow(
          response({ relationship_id: bad }),
          RELATIONSHIP_ID,
        ),
        null,
        `"${bad}" must be refused`,
      );
    }
  });

  test("6. a valid but DIFFERENT UUID is refused", () => {
    // The most important case in this section: a well-formed response describing SOMEBODY
    // ELSE'S relationship must never be rendered as this Retailer's outcome.
    assert.equal(
      readVendorRetailerLifecycleRow(
        response({ relationship_id: OTHER_ID }),
        RELATIONSHIP_ID,
      ),
      null,
    );
  });

  test("7. ZERO result rows are refused", () => {
    assert.equal(readVendorRetailerLifecycleRow([], RELATIONSHIP_ID), null);
    assert.equal(readVendorRetailerLifecycleRow(null, RELATIONSHIP_ID), null);
    assert.equal(readVendorRetailerLifecycleRow(undefined, RELATIONSHIP_ID), null);
  });

  test("8. MORE THAN ONE result row is refused rather than silently truncated", () => {
    const two = [...response(), ...response()];
    assert.equal(
      readVendorRetailerLifecycleRow(two, RELATIONSHIP_ID),
      null,
      "taking the first row would discard evidence that the response is drift",
    );
  });

  test("9. an INVALID retailer_status is refused", () => {
    for (const bad of ["DEACTIVATED", "INACTIVE", "active", "", null, 1, undefined]) {
      assert.equal(
        readVendorRetailerLifecycleRow(
          response({ retailer_status: bad, relationship_status: bad }),
          RELATIONSHIP_ID,
        ),
        null,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  test("10. an INVALID relationship_status is refused", () => {
    for (const bad of ["DEACTIVATED", "INACTIVE", "suspended", "", null]) {
      assert.equal(
        readVendorRetailerLifecycleRow(
          response({ relationship_status: bad }),
          RELATIONSHIP_ID,
        ),
        null,
      );
    }
  });

  test("11. two valid but MISMATCHED statuses are refused", () => {
    assert.equal(
      readVendorRetailerLifecycleRow(
        response({ retailer_status: "ACTIVE", relationship_status: "SUSPENDED" }),
        RELATIONSHIP_ID,
      ),
      null,
    );
    assert.equal(
      readVendorRetailerLifecycleRow(
        response({ retailer_status: "SUSPENDED", relationship_status: "ACTIVE" }),
        RELATIONSHIP_ID,
      ),
      null,
    );
  });

  test("12. a NON-BOOLEAN status_changed is refused, not coerced", () => {
    for (const bad of ["true", "false", 0, 1, null, undefined, {}]) {
      assert.equal(
        readVendorRetailerLifecycleRow(
          response({ status_changed: bad }),
          RELATIONSHIP_ID,
        ),
        null,
        `${JSON.stringify(bad)} must not be treated as a change flag`,
      );
    }
  });

  test("13. a fully valid CHANGED response is described as changed", () => {
    const row = readVendorRetailerLifecycleRow(
      response({ status_changed: true }),
      RELATIONSHIP_ID,
    );
    assert.equal(row?.changed, true);
  });

  test("14. a fully valid NO-OP response is described as unchanged", () => {
    const row = readVendorRetailerLifecycleRow(
      response({
        retailer_status: "ACTIVE",
        relationship_status: "ACTIVE",
        status_changed: false,
      }),
      RELATIONSHIP_ID,
    );
    assert.notEqual(row, null);
    assert.equal(row?.changed, false);
    assert.equal(row?.retailerStatus, "ACTIVE");
  });

  test("15. the validated relationship_id is NOT carried out to the caller", () => {
    const row = readVendorRetailerLifecycleRow(response(), RELATIONSHIP_ID);
    assert.notEqual(row, null);
    assert.deepEqual(
      Object.keys(row!).sort(),
      ["changed", "relationshipStatus", "retailerStatus"],
      "the id is validated internally and then discarded — validation and exposure are separate",
    );
    assert.doesNotMatch(JSON.stringify(row), /[0-9a-f]{8}-[0-9a-f]{4}/i, "no uuid escapes");
  });

  test("16. a non-array single row object is still fully validated", () => {
    // Defensive: whatever shape the client hands back, every rule still applies.
    assert.notEqual(
      readVendorRetailerLifecycleRow(response()[0], RELATIONSHIP_ID),
      null,
    );
    assert.equal(
      readVendorRetailerLifecycleRow(
        { ...response()[0], relationship_id: OTHER_ID },
        RELATIONSHIP_ID,
      ),
      null,
    );
  });

  test("17. non-object responses are refused without throwing", () => {
    for (const bad of ["", "ok", 0, 1, true, [[]], [null], [0]]) {
      assert.equal(
        readVendorRetailerLifecycleRow(bad, RELATIONSHIP_ID),
        null,
        `${JSON.stringify(bad)} must be refused`,
      );
    }
  });

  test("18. an extra unexpected column does not by itself invalidate a good row", () => {
    // Additive drift is tolerated; the four columns this contract depends on are what matter.
    assert.notEqual(
      readVendorRetailerLifecycleRow(
        response({ some_future_column: "whatever" }),
        RELATIONSHIP_ID,
      ),
      null,
    );
  });

  test("19. the parser is pure — it never throws for any input shape", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      "",
      0,
      NaN,
      [],
      [{}],
      [{ relationship_id: RELATIONSHIP_ID }],
      { relationship_id: RELATIONSHIP_ID },
      Object.create(null),
    ];
    for (const input of inputs) {
      assert.doesNotThrow(() => readVendorRetailerLifecycleRow(input, RELATIONSHIP_ID));
    }
  });
});

// ============================================================================
// Submit gating
// ============================================================================
describe("Vendor Retailer lifecycle — submit gating", () => {
  test("a ready control may submit", () => {
    assert.equal(
      canSubmitVendorRetailerLifecycleChange({
        submitting: false,
        alreadyCommitted: false,
        requestedStatus: "SUSPENDED",
      }),
      true,
    );
  });

  test("an in-flight request blocks a duplicate submission", () => {
    assert.equal(
      canSubmitVendorRetailerLifecycleChange({
        submitting: true,
        alreadyCommitted: false,
        requestedStatus: "SUSPENDED",
      }),
      false,
    );
  });

  test("a committed write can never be resubmitted by an ordinary click", () => {
    assert.equal(
      canSubmitVendorRetailerLifecycleChange({
        submitting: false,
        alreadyCommitted: true,
        requestedStatus: "SUSPENDED",
      }),
      false,
    );
  });

  test("no resolved direction means nothing to submit", () => {
    assert.equal(
      canSubmitVendorRetailerLifecycleChange({
        submitting: false,
        alreadyCommitted: false,
        requestedStatus: null,
      }),
      false,
    );
  });
});
