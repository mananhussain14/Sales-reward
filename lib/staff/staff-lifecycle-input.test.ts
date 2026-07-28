/**
 * Unit tests for the staff activation/deactivation DECISIONS.
 *
 *   @/lib/staff/staff-lifecycle-input
 *
 * Run with:  npm test
 *
 * These exercise the pure module directly. The Server Action and the Client Component that
 * consume it cannot be unit-tested here — the action pulls in `next/headers` and the
 * component needs a DOM this repository has no harness for — which is exactly why the rules
 * live in a module with no imports and no I/O.
 *
 * WHAT THESE TESTS ARE NOT. They are not a security boundary and do not claim to be. Every
 * rule below is applied again, independently, by public.set_retailer_staff_membership_status
 * under the caller's own token; the behavioural proof of that lives in
 * supabase/tests/database/retailer_staff_membership_lifecycle_test.sql (252 assertions).
 * What is asserted here is that the WEB layer never offers, or forwards, an operation the
 * database would refuse.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildLifecycleEligibleMemberships,
  canSubmitLifecycleChange,
  describeLifecycleNoChange,
  describeLifecycleOutcome,
  ELIGIBLE_LIFECYCLE_ROLES,
  isEligibleLifecycleTarget,
  isLifecycleControlOffered,
  isStaffLifecycleStatus,
  nextLifecycleStatus,
  normalizeLifecycleMembershipId,
  normalizeRequestedStatus,
  STAFF_LIFECYCLE_STATUSES,
  validateStaffLifecycleInput,
  type StaffLifecycleRosterEntry,
} from "./staff-lifecycle-input.ts";

const MANAGER_ID = "11111111-1111-4111-8111-111111111111";
const SALES_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const INVITED_ID = "44444444-4444-4444-8444-444444444444";
const SUSPENDED_ID = "55555555-5555-4555-8555-555555555555";
const DEACTIVATED_MANAGER_ID = "66666666-6666-4666-8666-666666666666";
const DEACTIVATED_SALES_ID = "77777777-7777-4777-8777-777777777777";
const UNSUPPORTED_ROLE_ID = "88888888-8888-4888-8888-888888888888";
const FOREIGN_ID = "99999999-9999-4999-8999-999999999999";

/** A roster as the server would have just read it for the signed-in Owner. */
const ROSTER: StaffLifecycleRosterEntry[] = [
  { membershipId: MANAGER_ID, roleCode: "RETAILER_MANAGER", membershipStatus: "ACTIVE" },
  { membershipId: SALES_ID, roleCode: "SALES_STAFF", membershipStatus: "ACTIVE" },
  { membershipId: OWNER_ID, roleCode: "RETAILER_OWNER", membershipStatus: "ACTIVE" },
  { membershipId: INVITED_ID, roleCode: "SALES_STAFF", membershipStatus: "INVITED" },
  { membershipId: SUSPENDED_ID, roleCode: "SALES_STAFF", membershipStatus: "SUSPENDED" },
  {
    membershipId: DEACTIVATED_MANAGER_ID,
    roleCode: "RETAILER_MANAGER",
    membershipStatus: "DEACTIVATED",
  },
  {
    membershipId: DEACTIVATED_SALES_ID,
    roleCode: "SALES_STAFF",
    membershipStatus: "DEACTIVATED",
  },
  {
    membershipId: UNSUPPORTED_ROLE_ID,
    roleCode: "VENDOR_SUPER_ADMIN",
    membershipStatus: "ACTIVE",
  },
];

// ============================================================================
// The vocabulary
// ============================================================================
describe("staff lifecycle — the vocabulary", () => {
  test("1. exactly two statuses, matching the RPC's closed set", () => {
    assert.deepEqual([...STAFF_LIFECYCLE_STATUSES], ["ACTIVE", "DEACTIVATED"]);
  });

  test("2. INVITED and SUSPENDED are NOT this operation's vocabulary", () => {
    // They are members of the organization_members.status column's vocabulary, but this
    // RPC neither accepts nor produces them — a membership becomes ACTIVE by ACCEPTING an
    // invitation, and SUSPENDED has no owner in this milestone.
    assert.equal(isStaffLifecycleStatus("INVITED"), false);
    assert.equal(isStaffLifecycleStatus("SUSPENDED"), false);
  });

  test("3. the status guard is exact and case-sensitive", () => {
    assert.equal(isStaffLifecycleStatus("ACTIVE"), true);
    assert.equal(isStaffLifecycleStatus("DEACTIVATED"), true);
    // The database compares p_status case-sensitively and raises 23514 for these.
    for (const value of ["active", "Active", "deactivated", " ACTIVE", "", null, 7, {}]) {
      assert.equal(isStaffLifecycleStatus(value), false, `${String(value)} must be refused`);
    }
  });

  test("4. exactly two eligible roles, and RETAILER_OWNER is not one", () => {
    assert.deepEqual(
      [...ELIGIBLE_LIFECYCLE_ROLES],
      ["RETAILER_MANAGER", "SALES_STAFF"],
    );
    assert.ok(
      !(ELIGIBLE_LIFECYCLE_ROLES as readonly string[]).includes("RETAILER_OWNER"),
      "an Owner is the tenant's root of authority and is excluded from this operation",
    );
  });
});

// ============================================================================
// Eligibility — which rows may be acted on
// ============================================================================
describe("staff lifecycle — eligibility", () => {
  test("15. an ACTIVE Retailer Manager is eligible", () => {
    assert.equal(
      isEligibleLifecycleTarget({
        roleCode: "RETAILER_MANAGER",
        membershipStatus: "ACTIVE",
      }),
      true,
    );
  });

  test("16. ACTIVE Sales Staff are eligible", () => {
    assert.equal(
      isEligibleLifecycleTarget({ roleCode: "SALES_STAFF", membershipStatus: "ACTIVE" }),
      true,
    );
  });

  test("17. a DEACTIVATED Retailer Manager is eligible — reactivation is in scope", () => {
    assert.equal(
      isEligibleLifecycleTarget({
        roleCode: "RETAILER_MANAGER",
        membershipStatus: "DEACTIVATED",
      }),
      true,
    );
  });

  test("18. DEACTIVATED Sales Staff are eligible", () => {
    assert.equal(
      isEligibleLifecycleTarget({
        roleCode: "SALES_STAFF",
        membershipStatus: "DEACTIVATED",
      }),
      true,
    );
  });

  test("19. EVERY Retailer Owner row is excluded, in every status", () => {
    for (const status of ["ACTIVE", "DEACTIVATED", "INVITED", "SUSPENDED"]) {
      assert.equal(
        isEligibleLifecycleTarget({ roleCode: "RETAILER_OWNER", membershipStatus: status }),
        false,
        `an Owner row must never be actionable (${status})`,
      );
    }
  });

  test("20. the caller's OWN row is excluded — transitively, and deliberately so", () => {
    // list_retailer_staff_members() returns no user_id and no "this is you" flag, so the
    // Web layer cannot identify the caller's own row directly. It does not need to:
    // RETAILER_STAFF_MANAGE is mapped to RETAILER_OWNER alone, so every caller who can
    // reach this operation is an Owner — and every Owner row is excluded by the rule
    // asserted above, which is strictly wider.
    //
    // The DATABASE does not rely on that coincidence: it compares the target's user id to
    // auth.uid() as a separate explicit check, which is what keeps the rule true if
    // RETAILER_STAFF_MANAGE is ever granted to RETAILER_MANAGER. That is proved in the
    // pgTAP suite, which grants exactly that mapping and watches a Manager be refused
    // their own membership while succeeding on a peer.
    const callersOwnRow = ROSTER.find((entry) => entry.membershipId === OWNER_ID);
    assert.ok(callersOwnRow, "the fixture must contain the Owner's own row");
    assert.equal(isEligibleLifecycleTarget(callersOwnRow!), false);
  });

  test("21. an INVITED membership is excluded", () => {
    assert.equal(
      isEligibleLifecycleTarget({ roleCode: "SALES_STAFF", membershipStatus: "INVITED" }),
      false,
    );
    assert.equal(
      isEligibleLifecycleTarget({
        roleCode: "RETAILER_MANAGER",
        membershipStatus: "INVITED",
      }),
      false,
    );
  });

  test("22. a SUSPENDED membership is excluded", () => {
    assert.equal(
      isEligibleLifecycleTarget({ roleCode: "SALES_STAFF", membershipStatus: "SUSPENDED" }),
      false,
    );
  });

  test("23. an unsupported or unknown role is excluded", () => {
    for (const roleCode of ["VENDOR_SUPER_ADMIN", "", "sales_staff", "SOMETHING_NEW"]) {
      assert.equal(
        isEligibleLifecycleTarget({ roleCode, membershipStatus: "ACTIVE" }),
        false,
        `${roleCode} must not be actionable`,
      );
    }
  });

  test("24. an unrecognized membership status is excluded", () => {
    for (const membershipStatus of ["", "active", "ARCHIVED", "PENDING"]) {
      assert.equal(
        isEligibleLifecycleTarget({ roleCode: "SALES_STAFF", membershipStatus }),
        false,
      );
    }
  });
});

// ============================================================================
// Membership-level eligibility — the multi-role projection
// ============================================================================
describe("staff lifecycle — membership-level eligibility", () => {
  /** A roster row, tersely. */
  const row = (
    membershipId: string,
    roleCode: string,
    membershipStatus = "ACTIVE",
  ): StaffLifecycleRosterEntry => ({ membershipId, roleCode, membershipStatus });

  test("6. a membership with ONE Manager role row is eligible", () => {
    const eligible = buildLifecycleEligibleMemberships([
      row(MANAGER_ID, "RETAILER_MANAGER"),
    ]);
    assert.equal(isLifecycleControlOffered(MANAGER_ID, eligible), true);
  });

  test("7. a membership with ONE Sales Staff role row is eligible", () => {
    const eligible = buildLifecycleEligibleMemberships([row(SALES_ID, "SALES_STAFF")]);
    assert.equal(isLifecycleControlOffered(SALES_ID, eligible), true);
  });

  test("7b. a DEACTIVATED single-role membership is eligible in both roles", () => {
    const eligible = buildLifecycleEligibleMemberships([
      row(DEACTIVATED_MANAGER_ID, "RETAILER_MANAGER", "DEACTIVATED"),
      row(DEACTIVATED_SALES_ID, "SALES_STAFF", "DEACTIVATED"),
    ]);
    assert.equal(isLifecycleControlOffered(DEACTIVATED_MANAGER_ID, eligible), true);
    assert.equal(isLifecycleControlOffered(DEACTIVATED_SALES_ID, eligible), true);
  });

  test("8. duplicate membershipId rows hide the control for EVERY occurrence", () => {
    // Two identical rows — a historical or malformed duplicate rather than a second role.
    // The Web layer cannot tell the causes apart, so the only safe reading is "hidden".
    const eligible = buildLifecycleEligibleMemberships([
      row(SALES_ID, "SALES_STAFF"),
      row(SALES_ID, "SALES_STAFF"),
    ]);
    assert.equal(isLifecycleControlOffered(SALES_ID, eligible), false);
    assert.equal(eligible.size, 0);
  });

  test("9. Manager + Sales Staff on ONE membership hides the control", () => {
    // The dangerous case: judged row-by-row, the SALES_STAFF row looks perfectly eligible
    // — and the RPC would refuse it, because it compares the COMPLETE ACTIVE role set to a
    // single-element array.
    const roster = [
      row(SALES_ID, "SALES_STAFF"),
      row(SALES_ID, "RETAILER_MANAGER"),
    ];
    // Each row on its own passes the row predicate...
    for (const entry of roster) {
      assert.equal(isEligibleLifecycleTarget(entry), true);
    }
    // ...and the membership is still refused.
    const eligible = buildLifecycleEligibleMemberships(roster);
    assert.equal(isLifecycleControlOffered(SALES_ID, eligible), false);
  });

  test("10. Owner + another role on ONE membership hides the control", () => {
    // Without the membership-level rule, the non-Owner row would defeat the Owner
    // exclusion — the headline rule of the whole feature.
    const eligible = buildLifecycleEligibleMemberships([
      row(OWNER_ID, "RETAILER_OWNER"),
      row(OWNER_ID, "SALES_STAFF"),
    ]);
    assert.equal(isLifecycleControlOffered(OWNER_ID, eligible), false);
  });

  test("11. unsupported duplicate roles hide the control", () => {
    const eligible = buildLifecycleEligibleMemberships([
      row(UNSUPPORTED_ROLE_ID, "VENDOR_SUPER_ADMIN"),
      row(UNSUPPORTED_ROLE_ID, "SOMETHING_NEW"),
    ]);
    assert.equal(isLifecycleControlOffered(UNSUPPORTED_ROLE_ID, eligible), false);
  });

  test("11b. a duplicate membership does not poison its NEIGHBOURS", () => {
    // The rule is per membership id, not per roster. A well-formed member alongside a
    // multi-role one must still be actionable.
    const eligible = buildLifecycleEligibleMemberships([
      row(SALES_ID, "SALES_STAFF"),
      row(MANAGER_ID, "RETAILER_MANAGER"),
      row(MANAGER_ID, "SALES_STAFF"),
    ]);
    assert.equal(isLifecycleControlOffered(SALES_ID, eligible), true);
    assert.equal(isLifecycleControlOffered(MANAGER_ID, eligible), false);
  });

  test("11c. the projection is case-insensitive on the membership id", () => {
    const eligible = buildLifecycleEligibleMemberships([
      row(SALES_ID.toUpperCase(), "SALES_STAFF"),
    ]);
    assert.equal(isLifecycleControlOffered(SALES_ID, eligible), true);
    // ...and duplicates that differ only in case are still duplicates.
    const shadowed = buildLifecycleEligibleMemberships([
      row(SALES_ID, "SALES_STAFF"),
      row(SALES_ID.toUpperCase(), "RETAILER_MANAGER"),
    ]);
    assert.equal(isLifecycleControlOffered(SALES_ID, shadowed), false);
  });

  test("11d. blank membership ids are dropped, never matched", () => {
    const eligible = buildLifecycleEligibleMemberships([
      row("", "SALES_STAFF"),
      row("   ", "SALES_STAFF"),
    ]);
    assert.equal(eligible.size, 0);
    assert.equal(isLifecycleControlOffered("", eligible), false);
  });

  test("17. Owner, INVITED and SUSPENDED exclusions survive the projection", () => {
    const eligible = buildLifecycleEligibleMemberships(ROSTER);
    // The fixture roster has one row per membership, so only the four eligible ones pass.
    assert.deepEqual(
      [...eligible].sort(),
      [MANAGER_ID, SALES_ID, DEACTIVATED_MANAGER_ID, DEACTIVATED_SALES_ID].sort(),
    );
    for (const excluded of [OWNER_ID, INVITED_ID, SUSPENDED_ID, UNSUPPORTED_ROLE_ID]) {
      assert.equal(
        isLifecycleControlOffered(excluded, eligible),
        false,
        `${excluded} must remain excluded`,
      );
    }
  });
});

// ============================================================================
// Multi-role rejection in the Server Action's validation gate
// ============================================================================
describe("staff lifecycle — validation rejects multi-role targets", () => {
  test("9b. a submitted id matching TWO roster rows is refused", () => {
    // `find` would have picked one half and judged it in isolation. `filter` + a count is
    // what makes this refusal exist at all.
    const roster: StaffLifecycleRosterEntry[] = [
      { membershipId: SALES_ID, roleCode: "SALES_STAFF", membershipStatus: "ACTIVE" },
      { membershipId: SALES_ID, roleCode: "RETAILER_MANAGER", membershipStatus: "ACTIVE" },
    ];
    const result = validateStaffLifecycleInput(SALES_ID, "DEACTIVATED", roster);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "ineligible-target");
  });

  test("10b. Owner + another role is refused by validation too", () => {
    const roster: StaffLifecycleRosterEntry[] = [
      { membershipId: OWNER_ID, roleCode: "RETAILER_OWNER", membershipStatus: "ACTIVE" },
      { membershipId: OWNER_ID, roleCode: "SALES_STAFF", membershipStatus: "ACTIVE" },
    ];
    const result = validateStaffLifecycleInput(OWNER_ID, "DEACTIVATED", roster);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "ineligible-target");
  });

  test("9c. a single-row membership still validates after the change", () => {
    const result = validateStaffLifecycleInput(SALES_ID, "DEACTIVATED", ROSTER);
    assert.equal(result.ok, true);
  });
});

// ============================================================================
// Direction
// ============================================================================
describe("staff lifecycle — the direction of the action", () => {
  test("33. an ACTIVE row offers Deactivate", () => {
    assert.equal(nextLifecycleStatus("ACTIVE"), "DEACTIVATED");
  });

  test("34. a DEACTIVATED row offers Reactivate", () => {
    assert.equal(nextLifecycleStatus("DEACTIVATED"), "ACTIVE");
  });

  test("35. every other status offers nothing", () => {
    for (const status of ["INVITED", "SUSPENDED", "", "active", "unknown"]) {
      assert.equal(
        nextLifecycleStatus(status),
        null,
        `${status} must not produce a target status`,
      );
    }
  });
});

// ============================================================================
// Canonicalization
// ============================================================================
describe("staff lifecycle — canonicalization", () => {
  test("25a. the membership id is trimmed and lower-cased", () => {
    assert.equal(
      normalizeLifecycleMembershipId(`  ${SALES_ID.toUpperCase()}  `),
      SALES_ID,
    );
  });

  test("25b. a non-string membership id becomes the empty string, not a crash", () => {
    for (const raw of [null, undefined, 7, {}, new Date()]) {
      assert.equal(normalizeLifecycleMembershipId(raw), "");
    }
  });

  test("26a. the requested status is TRIMMED ONLY — never upper-cased", () => {
    // Silently upper-casing would make this layer accept a request the database refuses
    // with 23514, and would let a tampered submission decide the case of a value written
    // verbatim into an audit row.
    assert.equal(normalizeRequestedStatus("  DEACTIVATED  "), "DEACTIVATED");
    assert.equal(normalizeRequestedStatus("active"), "active");
    assert.equal(normalizeRequestedStatus("Deactivated"), "Deactivated");
  });

  test("26b. a non-string status becomes the empty string", () => {
    for (const raw of [null, undefined, 7, {}]) {
      assert.equal(normalizeRequestedStatus(raw), "");
    }
  });
});

// ============================================================================
// Validation — the Server Action's gate before the RPC
// ============================================================================
describe("staff lifecycle — validation", () => {
  test("25. a malformed membership id is rejected BEFORE anything else", () => {
    for (const id of ["", "not-a-uuid", "1234", `${SALES_ID}x`]) {
      const result = validateStaffLifecycleInput(id, "DEACTIVATED", ROSTER);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, "invalid-target");
    }
  });

  test("26. an invalid requested status is rejected, and kept distinct", () => {
    for (const status of ["", "active", "INVITED", "SUSPENDED", "ARCHIVED", " ACTIVE"]) {
      const result = validateStaffLifecycleInput(SALES_ID, status, ROSTER);
      assert.equal(result.ok, false);
      assert.equal(
        result.ok === false && result.reason,
        "invalid-status",
        `${status} must be an invalid-status, not something else`,
      );
    }
  });

  test("26c. the format checks run BEFORE the roster is consulted", () => {
    // A tampered id must be refused without the roster being searched at all, so an empty
    // roster and a full one behave identically.
    const withRoster = validateStaffLifecycleInput("nope", "ACTIVE", ROSTER);
    const withoutRoster = validateStaffLifecycleInput("nope", "ACTIVE", []);
    assert.deepEqual(withRoster, withoutRoster);
  });

  test("28. a membership outside the caller's own roster is rejected", () => {
    // The roster subset check is the security-relevant rule: the id must appear in the
    // list list_retailer_staff_members() just returned for THIS caller, so a cross-tenant
    // or fabricated id never reaches the RPC from this layer.
    const result = validateStaffLifecycleInput(FOREIGN_ID, "DEACTIVATED", ROSTER);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "unknown-target");
  });

  test("28b. an unknown id and an ineligible id are DIFFERENT internal reasons but both refuse", () => {
    // They are separate discriminants so the action can reason about them, and the action
    // maps BOTH to the same operator-facing message — asserted in the contract suite.
    const unknown = validateStaffLifecycleInput(FOREIGN_ID, "ACTIVE", ROSTER);
    const owner = validateStaffLifecycleInput(OWNER_ID, "DEACTIVATED", ROSTER);
    assert.equal(unknown.ok, false);
    assert.equal(owner.ok, false);
    assert.equal(unknown.ok === false && unknown.reason, "unknown-target");
    assert.equal(owner.ok === false && owner.reason, "ineligible-target");
  });

  test("28c. every ineligible roster row is refused by validation", () => {
    for (const id of [OWNER_ID, INVITED_ID, SUSPENDED_ID, UNSUPPORTED_ROLE_ID]) {
      const result = validateStaffLifecycleInput(id, "DEACTIVATED", ROSTER);
      assert.equal(result.ok, false, `${id} must be refused`);
      assert.equal(result.ok === false && result.reason, "ineligible-target");
    }
  });

  test("28d. every eligible roster row is accepted, in both directions", () => {
    const cases: Array<[string, "ACTIVE" | "DEACTIVATED"]> = [
      [MANAGER_ID, "DEACTIVATED"],
      [SALES_ID, "DEACTIVATED"],
      [DEACTIVATED_MANAGER_ID, "ACTIVE"],
      [DEACTIVATED_SALES_ID, "ACTIVE"],
    ];

    for (const [id, requested] of cases) {
      const result = validateStaffLifecycleInput(id, requested, ROSTER);
      assert.equal(result.ok, true, `${id} -> ${requested} must be accepted`);
      if (result.ok) {
        assert.equal(result.membershipId, id);
        assert.equal(result.requestedStatus, requested);
        // The target carried forward is the ROSTER's row, never anything from the browser.
        assert.equal(result.target.membershipId, id);
      }
    }
  });

  test("28e. requesting the status a row ALREADY holds is NOT rejected", () => {
    // That is the RPC's idempotent no-op, which writes nothing and reports
    // status_changed = false. Refusing it here would turn "somebody already did this" into
    // an error, which is both wrong and confusing.
    const result = validateStaffLifecycleInput(SALES_ID, "ACTIVE", ROSTER);
    assert.equal(result.ok, true);
  });

  test("28f. the roster comparison is case-insensitive on the id", () => {
    const result = validateStaffLifecycleInput(SALES_ID, "DEACTIVATED", [
      { ...ROSTER[1], membershipId: SALES_ID.toUpperCase() },
    ]);
    assert.equal(result.ok, true);
  });
});

// ============================================================================
// Submit gating
// ============================================================================
describe("staff lifecycle — submit gating", () => {
  test("37. a submission in flight disables the confirm button", () => {
    assert.equal(
      canSubmitLifecycleChange({
        submitting: true,
        alreadyCommitted: false,
        targetStatus: "DEACTIVATED",
      }),
      false,
    );
  });

  test("37b. a committed write disables it — no ordinary retry may resubmit", () => {
    assert.equal(
      canSubmitLifecycleChange({
        submitting: false,
        alreadyCommitted: true,
        targetStatus: "DEACTIVATED",
      }),
      false,
    );
  });

  test("37c. a row with no direction cannot be submitted", () => {
    assert.equal(
      canSubmitLifecycleChange({
        submitting: false,
        alreadyCommitted: false,
        targetStatus: null,
      }),
      false,
    );
  });

  test("37d. an idle, uncommitted, directed control may submit", () => {
    assert.equal(
      canSubmitLifecycleChange({
        submitting: false,
        alreadyCommitted: false,
        targetStatus: "ACTIVE",
      }),
      true,
    );
  });
});

// ============================================================================
// Copy
// ============================================================================
describe("staff lifecycle — copy", () => {
  const NAME = "Sara Sales";

  test("38. the deactivate sentence states the PRESERVATION semantics", () => {
    const copy = describeLifecycleOutcome(NAME, "DEACTIVATED");
    assert.ok(copy.includes(NAME), "names the person, using their display name");
    assert.match(copy, /roles/i);
    assert.match(copy, /shops/i);
    assert.match(copy, /history/i);
    assert.match(copy, /unchanged|preserved|kept/i);
  });

  test("13/14. the success copy says active / inactive, never deactivated", () => {
    const deactivated = describeLifecycleOutcome(NAME, "DEACTIVATED");
    const activated = describeLifecycleOutcome(NAME, "ACTIVE");

    assert.match(deactivated, /is now inactive/i);
    assert.match(activated, /is now active/i);

    for (const copy of [deactivated, activated]) {
      assert.ok(
        !/deactivat/i.test(copy),
        `success copy must not use the word "deactivated": ${copy}`,
      );
    }
  });

  test("38b. the reactivate sentence promises restoration without rebuilding", () => {
    const copy = describeLifecycleOutcome(NAME, "ACTIVE");
    assert.ok(copy.includes(NAME));
    assert.match(copy, /is now active again/i);
    assert.match(copy, /shop assignments/i);
    assert.match(copy, /available/i);
  });

  test("38c. the no-op sentence claims no event, and uses the same vocabulary", () => {
    // The RPC writes no audit row for a no-op, so the copy must not say "updated".
    const deactivated = describeLifecycleNoChange(NAME, "DEACTIVATED");
    const activated = describeLifecycleNoChange(NAME, "ACTIVE");
    assert.match(deactivated, /no change was needed/i);
    assert.match(activated, /no change was needed/i);
    assert.ok(!/updated|changed to/i.test(deactivated));
    assert.match(deactivated, /already inactive/i);
    assert.match(activated, /already active/i);
    assert.ok(!/deactivat/i.test(deactivated), "never 'already deactivated'");
  });

  test("41. no copy leaks a raw status, role code, uuid or SQLSTATE", () => {
    const strings = [
      describeLifecycleOutcome(NAME, "ACTIVE"),
      describeLifecycleOutcome(NAME, "DEACTIVATED"),
      describeLifecycleNoChange(NAME, "ACTIVE"),
      describeLifecycleNoChange(NAME, "DEACTIVATED"),
    ];

    for (const copy of strings) {
      assert.ok(
        !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(copy),
        `copy must carry no uuid: ${copy}`,
      );
      assert.ok(
        !/\b(DEACTIVATED|SALES_STAFF|RETAILER_MANAGER|RETAILER_OWNER|INVITED|SUSPENDED)\b/.test(
          copy,
        ),
        `copy must carry no raw enum or role code: ${copy}`,
      );
      assert.ok(
        !/\b(42501|23514|55000|22P02)\b/.test(copy),
        `copy must carry no SQLSTATE: ${copy}`,
      );
      assert.ok(
        !/postgres|supabase|rpc|sql/i.test(copy),
        `copy must not name the backend: ${copy}`,
      );
    }
  });
});
