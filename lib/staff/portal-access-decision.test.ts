/**
 * Unit tests for the Retailer portal access precedence and staff-section visibility.
 *
 * Run with:  npm test
 *
 * Node's built-in runner (node:test) + assert, no package added. The `.ts` import
 * extension is required by Node's ESM resolver and permitted by
 * allowImportingTsExtensions.
 *
 * These pin the ROLE VISIBILITY contract of this milestone:
 *   - a Retailer Owner sees the whole portal and every staff control;
 *   - a Retailer Manager sees the roster and nothing else;
 *   - a Sales Staff member (and anyone outside the Retailer) is refused entirely;
 * and they pin it WITHOUT naming a role, because the decision is driven by which
 * authorized database read succeeded. The role→permission mapping lives in SQL and is
 * verified there; these tests verify that the application honours whatever it says.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  selectPortalAccess,
  shouldProbeRoster,
  showsInvitationSection,
  showsInviteForm,
  showsInviteSection,
  type OwnerAccessStatus,
  type RosterReadStatus,
} from "./portal-access-decision.ts";

const OWNER_STATUSES: OwnerAccessStatus[] = [
  "authorized",
  "unauthenticated",
  "unauthorized",
  "unavailable",
];
const ROSTER_STATUSES: RosterReadStatus[] = ["ok", "denied", "unavailable"];

describe("selectPortalAccess — Retailer Owner", () => {
  test("1. an authorized owner gets the full portal regardless of the roster read", () => {
    for (const roster of ROSTER_STATUSES) {
      assert.deepEqual(selectPortalAccess("authorized", roster), { kind: "owner" });
    }
  });

  test("2. the roster read is not even issued for an authorized owner", () => {
    assert.equal(shouldProbeRoster("authorized"), false);
  });
});

describe("selectPortalAccess — Retailer Manager (roster reader)", () => {
  test("3. not an owner + roster readable => reader", () => {
    assert.deepEqual(selectPortalAccess("unauthorized", "ok"), { kind: "reader" });
  });

  test("4. the roster IS probed when the owner read did not authorize", () => {
    assert.equal(shouldProbeRoster("unauthorized"), true);
    assert.equal(shouldProbeRoster("unavailable"), true);
  });

  test("5. a reader is still a reader when the owner read failed operationally", () => {
    // An owner-side transport fault must not deny a Manager who can be served.
    assert.deepEqual(selectPortalAccess("unavailable", "ok"), { kind: "reader" });
  });
});

describe("selectPortalAccess — Sales Staff and outsiders", () => {
  test("6. neither read authorizes => unauthorized", () => {
    // A SALES_STAFF member holds neither RETAILER_PORTAL_READ-with-owner-role nor
    // RETAILER_STAFF_READ, so both reads refuse and the portal is closed to them.
    assert.deepEqual(selectPortalAccess("unauthorized", "denied"), {
      kind: "unauthorized",
    });
  });

  test("7. no session => unauthenticated, and the roster is not probed", () => {
    assert.equal(shouldProbeRoster("unauthenticated"), false);
    for (const roster of ROSTER_STATUSES) {
      assert.deepEqual(selectPortalAccess("unauthenticated", roster), {
        kind: "unauthenticated",
      });
    }
  });
});

describe("selectPortalAccess — operational failure is never a denial", () => {
  test("8. owner unavailable + roster denied => unavailable, NOT unauthorized", () => {
    // We never established that they are not an owner. Reporting a denial here would
    // tell a real owner they lack access because of a network hiccup.
    assert.deepEqual(selectPortalAccess("unavailable", "denied"), {
      kind: "unavailable",
    });
  });

  test("9. a failed roster read is unavailable, not a denial", () => {
    assert.deepEqual(selectPortalAccess("unauthorized", "unavailable"), {
      kind: "unavailable",
    });
  });

  test("10. every combination yields exactly one of the five kinds", () => {
    const allowed = new Set([
      "owner",
      "reader",
      "unauthenticated",
      "unauthorized",
      "unavailable",
    ]);
    for (const owner of OWNER_STATUSES) {
      for (const roster of ROSTER_STATUSES) {
        const decision = selectPortalAccess(owner, roster);
        assert.ok(
          allowed.has(decision.kind),
          `unexpected kind for ${owner}/${roster}: ${decision.kind}`,
        );
      }
    }
  });

  test("11. no combination of failures ever produces owner access", () => {
    for (const owner of OWNER_STATUSES) {
      for (const roster of ROSTER_STATUSES) {
        if (owner === "authorized") continue;
        assert.notEqual(
          selectPortalAccess(owner, roster).kind,
          "owner",
          `${owner}/${roster} must not grant owner access`,
        );
      }
    }
  });
});

describe("staff page section visibility", () => {
  test("12. an owner (reads succeed) sees the invitation list AND the invite form", () => {
    assert.equal(showsInvitationSection("ok"), true);
    assert.equal(showsInviteSection("ok"), true);
    assert.equal(showsInviteForm("ok"), true);
  });

  test("13. a manager (reads denied) sees NEITHER — not even an empty heading", () => {
    assert.equal(showsInvitationSection("denied"), false);
    assert.equal(showsInviteSection("denied"), false);
    assert.equal(showsInviteForm("denied"), false);
  });

  test("14. a failed read keeps the section but withholds the form", () => {
    // The caller was authorized — the read reached the database and was not refused —
    // so the section renders a retry message rather than vanishing. The form itself is
    // withheld because its shop picker has no data to render from.
    assert.equal(showsInvitationSection("unavailable"), true);
    assert.equal(showsInviteSection("unavailable"), true);
    assert.equal(showsInviteForm("unavailable"), false);
  });

  test("15. the invite form is never rendered without a successful assignable-shop read", () => {
    // This is what guarantees the shop picker's options can only come from
    // list_retailer_staff_assignable_shops(): there is no other branch that mounts it.
    for (const status of ["denied", "unavailable"] as const) {
      assert.equal(showsInviteForm(status), false);
    }
  });
});
