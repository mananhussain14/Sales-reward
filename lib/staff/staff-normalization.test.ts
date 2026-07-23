/**
 * Unit tests for the staff RPC normalizers and the derived presentation rules.
 *
 * Run with:  npm test
 *
 * These pin the fail-closed contract (a drifted or malformed row is refused, never
 * rendered as `undefined`), the exact set of derived invitation states, which of them
 * may be resent or revoked, and — for the recipient resolver — that zero rows is one
 * generic "unavailable" outcome rather than an error or a partial row.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  canResendInvitation,
  canRevokeInvitation,
  describeIntendedShops,
  isHistoricalInvitation,
  normalizeAssignableShops,
  normalizeRecipientInvitation,
  normalizeStaffInvitations,
  normalizeStaffMembers,
  staffInvitationStateLabel,
  STAFF_INVITATION_STATES,
  type StaffInvitationState,
} from "./staff-normalization.ts";

const SHOP_A = "11111111-1111-4111-8111-111111111111";
const SHOP_B = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const INVITATION = "44444444-4444-4444-8444-444444444444";

describe("normalizeAssignableShops", () => {
  test("1. maps a well-formed row and lower-cases the id", () => {
    const result = normalizeAssignableShops([
      {
        shop_id: SHOP_A.toUpperCase(),
        shop_name: "Alpha Store",
        shop_code: "A-1",
        city: "Auckland",
      },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.shops[0], {
      shopId: SHOP_A,
      shopName: "Alpha Store",
      shopCode: "A-1",
      city: "Auckland",
    });
  });

  test("2. nullable columns become null, never empty strings", () => {
    const result = normalizeAssignableShops([
      { shop_id: SHOP_A, shop_name: "Beta", shop_code: null, city: "   " },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.shops[0].shopCode, null);
    assert.equal(result.shops[0].city, null);
  });

  test("3. an empty list is a valid successful answer, not a failure", () => {
    assert.deepEqual(normalizeAssignableShops([]), { status: "ok", shops: [] });
  });

  test("4. fails closed on drift rather than offering a blank checkbox", () => {
    for (const data of [
      null,
      undefined,
      "rows",
      [null],
      [{ shop_name: "no id" }],
      [{ shop_id: SHOP_A }],
      [{ shop_id: "", shop_name: "blank id" }],
    ]) {
      assert.equal(
        normalizeAssignableShops(data).status,
        "malformed",
        `${JSON.stringify(data)} must be refused`,
      );
    }
  });
});

describe("normalizeStaffMembers", () => {
  const row = {
    membership_id: MEMBERSHIP,
    first_name: "Ada",
    last_name: "Lovelace",
    role_code: "SALES_STAFF",
    role_name: "Sales Staff",
    membership_status: "ACTIVE",
    shop_ids: [SHOP_A, SHOP_B],
    shop_names: ["Alpha", "Beta"],
    joined_at: "2026-07-01T00:00:00Z",
    created_at: "2026-06-01T00:00:00Z",
  };

  test("5. maps a well-formed roster row", () => {
    const result = normalizeStaffMembers([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.members[0].membershipId, MEMBERSHIP);
    assert.deepEqual(result.members[0].shopNames, ["Alpha", "Beta"]);
    assert.equal(result.members[0].joinedAt, "2026-07-01T00:00:00Z");
  });

  test("6. tolerates absent arrays and a null joined_at", () => {
    const result = normalizeStaffMembers([
      { ...row, shop_ids: null, shop_names: undefined, joined_at: null },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.members[0].shopIds, []);
    assert.deepEqual(result.members[0].shopNames, []);
    assert.equal(result.members[0].joinedAt, null);
  });

  test("7. refuses a row missing any required column", () => {
    for (const key of [
      "membership_id",
      "first_name",
      "last_name",
      "role_code",
      "membership_status",
    ]) {
      const broken = { ...row, [key]: null };
      const result = normalizeStaffMembers([broken]);
      assert.equal(result.status, "malformed", `${key} must be required`);
      if (result.status !== "malformed") return;
      assert.equal(result.reason, key);
    }
  });
});

describe("normalizeStaffInvitations", () => {
  const row = {
    invitation_id: INVITATION,
    first_name: "Ada",
    last_name: "Lovelace",
    email: "Ada@Example.com",
    role_code: "SALES_STAFF",
    derived_state: "PENDING",
    created_at: "2026-07-01T00:00:00Z",
    sent_at: "2026-07-01T00:05:00Z",
    accepted_at: null,
    revoked_at: null,
    expires_at: "2026-07-02T00:00:00Z",
    failure_code: null,
    shop_ids: [SHOP_A],
  };

  test("8. maps a well-formed invitation and canonicalizes the email", () => {
    const result = normalizeStaffInvitations([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.invitations[0].email, "ada@example.com");
    assert.equal(result.invitations[0].state, "PENDING");
    assert.equal(result.invitations[0].deliveryFailed, false);
  });

  test("9. surfaces THAT delivery failed, never the failure code itself", () => {
    const result = normalizeStaffInvitations([
      { ...row, derived_state: "DELIVERY_FAILED", failure_code: "EMAIL_DISPATCH_FAILED" },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    const invitation = result.invitations[0];
    assert.equal(invitation.deliveryFailed, true);
    assert.ok(
      !JSON.stringify(invitation).includes("EMAIL_DISPATCH_FAILED"),
      "the internal failure code must not reach the UI",
    );
  });

  test("10. refuses an unrecognized derived state rather than defaulting", () => {
    // Defaulting could silently offer an action on a state the backend did not
    // describe. Refusing the read is the safe direction.
    for (const state of ["UNKNOWN", "", null, "pending", 7]) {
      const result = normalizeStaffInvitations([{ ...row, derived_state: state }]);
      assert.equal(result.status, "malformed", `${String(state)} must be refused`);
    }
  });

  test("11. accepts every state the backend can emit", () => {
    for (const state of STAFF_INVITATION_STATES) {
      const result = normalizeStaffInvitations([{ ...row, derived_state: state }]);
      assert.equal(result.status, "ok", `${state} must be accepted`);
    }
  });
});

describe("invitation action availability", () => {
  const live: StaffInvitationState[] = ["RESERVED", "PENDING", "DELIVERY_FAILED"];
  const historical: StaffInvitationState[] = ["EXPIRED", "REVOKED", "ACCEPTED"];

  test("12. live states may be resent and revoked", () => {
    for (const state of live) {
      assert.equal(canResendInvitation(state), true, state);
      assert.equal(canRevokeInvitation(state), true, state);
      assert.equal(isHistoricalInvitation(state), false, state);
    }
  });

  test("13. accepted, expired and revoked rows offer no action at all", () => {
    for (const state of historical) {
      assert.equal(canResendInvitation(state), false, state);
      assert.equal(canRevokeInvitation(state), false, state);
      assert.equal(isHistoricalInvitation(state), true, state);
    }
  });

  test("14. every state has a label, and no label leaks a raw enum value", () => {
    for (const state of STAFF_INVITATION_STATES) {
      const label = staffInvitationStateLabel(state);
      assert.ok(label.length > 0, state);
      assert.notEqual(label, state);
    }
  });

  test("15. live and historical together cover every state exactly once", () => {
    assert.equal(live.length + historical.length, STAFF_INVITATION_STATES.length);
    for (const state of STAFF_INVITATION_STATES) {
      assert.notEqual(
        canResendInvitation(state),
        isHistoricalInvitation(state),
        `${state} must be exactly one of live/historical`,
      );
    }
  });
});

describe("describeIntendedShops", () => {
  const assignable = [
    { shopId: SHOP_A, shopName: "Alpha", shopCode: null, city: null },
    { shopId: SHOP_B, shopName: "Beta", shopCode: null, city: null },
  ];

  test("16. resolves names and sorts them", () => {
    const result = describeIntendedShops([SHOP_B, SHOP_A], assignable);
    assert.deepEqual(result.names, ["Alpha", "Beta"]);
    assert.equal(result.unavailableCount, 0);
  });

  test("17. counts unmatched ids instead of printing a UUID on screen", () => {
    const result = describeIntendedShops(
      [SHOP_A, "99999999-9999-4999-8999-999999999999"],
      assignable,
    );
    assert.deepEqual(result.names, ["Alpha"]);
    assert.equal(result.unavailableCount, 1);
  });

  test("18. never returns an identifier in the names it emits", () => {
    const result = describeIntendedShops([SHOP_A, SHOP_B], assignable);
    for (const name of result.names) {
      assert.ok(
        !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(name),
      );
    }
  });
});

describe("normalizeRecipientInvitation", () => {
  const row = {
    invitation_id: INVITATION,
    first_name: "Ada",
    last_name: "Lovelace",
    email: "Ada@Example.com",
    retailer_name: "Harbour Retail",
    role_code: "SALES_STAFF",
    role_name: "Sales Staff",
    shop_names: ["Alpha", "Beta"],
    expires_at: "2026-07-02T00:00:00Z",
  };

  test("19. maps the safe display payload", () => {
    const result = normalizeRecipientInvitation([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.invitation.retailerName, "Harbour Retail");
    assert.equal(result.invitation.email, "ada@example.com");
    assert.deepEqual(result.invitation.shopNames, ["Alpha", "Beta"]);
  });

  test("20. the invitation id is NOT carried into the page's data", () => {
    const result = normalizeRecipientInvitation([row]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.ok(
      !JSON.stringify(result.invitation).includes(INVITATION),
      "acceptance addresses the invitation by cookie hash, so no id belongs here",
    );
  });

  test("21. zero rows is ONE generic unavailable outcome, not an error", () => {
    assert.deepEqual(normalizeRecipientInvitation([]), { status: "unavailable" });
  });

  test("22. a Manager invitation carries no shops", () => {
    const result = normalizeRecipientInvitation([
      { ...row, role_code: "RETAILER_MANAGER", role_name: "Retailer Manager", shop_names: [] },
    ]);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.invitation.shopNames, []);
  });

  test("23. fails closed on drift", () => {
    for (const key of ["first_name", "last_name", "email", "retailer_name", "role_code"]) {
      const result = normalizeRecipientInvitation([{ ...row, [key]: null }]);
      assert.equal(result.status, "malformed", `${key} must be required`);
    }
    assert.equal(normalizeRecipientInvitation("nope").status, "malformed");
  });
});
