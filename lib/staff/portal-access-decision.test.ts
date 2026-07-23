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
  shouldProbeSubmitter,
  type OwnerAccessStatus,
  type RosterReadStatus,
  type SubmitterReadStatus,
} from "./portal-access-decision.ts";

const OWNER_STATUSES: OwnerAccessStatus[] = [
  "authorized",
  "unauthenticated",
  "unauthorized",
  "unavailable",
];
const ROSTER_STATUSES: RosterReadStatus[] = ["ok", "denied", "unavailable"];
const SUBMITTER_STATUSES: SubmitterReadStatus[] = ["ok", "denied", "unavailable"];

describe("selectPortalAccess — Retailer Owner", () => {
  test("1. an authorized owner gets the full portal regardless of the roster read", () => {
    for (const roster of ROSTER_STATUSES) {
      assert.deepEqual(selectPortalAccess("authorized", roster, "denied"), { kind: "owner" });
    }
  });

  test("2. the roster read is not even issued for an authorized owner", () => {
    assert.equal(shouldProbeRoster("authorized"), false);
  });
});

describe("selectPortalAccess — Retailer Manager (roster reader)", () => {
  test("3. not an owner + roster readable => reader", () => {
    assert.deepEqual(selectPortalAccess("unauthorized", "ok", "denied"), { kind: "reader" });
  });

  test("4. the roster IS probed when the owner read did not authorize", () => {
    assert.equal(shouldProbeRoster("unauthorized"), true);
    assert.equal(shouldProbeRoster("unavailable"), true);
  });

  test("5. a reader is still a reader when the owner read failed operationally", () => {
    // An owner-side transport fault must not deny a Manager who can be served.
    assert.deepEqual(selectPortalAccess("unavailable", "ok", "denied"), { kind: "reader" });
  });
});

describe("selectPortalAccess — Sales Staff and outsiders", () => {
  test("6. neither read authorizes => unauthorized", () => {
    // A SALES_STAFF member holds neither RETAILER_PORTAL_READ-with-owner-role nor
    // RETAILER_STAFF_READ, so both reads refuse and the portal is closed to them.
    assert.deepEqual(selectPortalAccess("unauthorized", "denied", "denied"), {
      kind: "unauthorized",
    });
  });

  test("7. no session => unauthenticated, and the roster is not probed", () => {
    assert.equal(shouldProbeRoster("unauthenticated"), false);
    for (const roster of ROSTER_STATUSES) {
      assert.deepEqual(selectPortalAccess("unauthenticated", roster, "denied"), {
        kind: "unauthenticated",
      });
    }
  });
});

describe("selectPortalAccess — operational failure is never a denial", () => {
  test("8. owner unavailable + roster denied => unavailable, NOT unauthorized", () => {
    // We never established that they are not an owner. Reporting a denial here would
    // tell a real owner they lack access because of a network hiccup.
    assert.deepEqual(selectPortalAccess("unavailable", "denied", "denied"), {
      kind: "unavailable",
    });
  });

  test("9. a failed roster read is unavailable, not a denial", () => {
    assert.deepEqual(selectPortalAccess("unauthorized", "unavailable", "denied"), {
      kind: "unavailable",
    });
  });

  test("10. every combination yields exactly one of the six kinds", () => {
    const allowed = new Set([
      "owner",
      "reader",
      "submitter",
      "unauthenticated",
      "unauthorized",
      "unavailable",
    ]);
    for (const owner of OWNER_STATUSES) {
      for (const roster of ROSTER_STATUSES) {
      for (const submitter of SUBMITTER_STATUSES) {
        const decision = selectPortalAccess(owner, roster, submitter);
        assert.ok(
          allowed.has(decision.kind),
          `unexpected kind for ${owner}/${roster}/${submitter}: ${decision.kind}`,
        );
      }
      }
    }
  });

  test("11. no combination of failures ever produces owner access", () => {
    for (const owner of OWNER_STATUSES) {
      for (const roster of ROSTER_STATUSES) {
        for (const submitter of SUBMITTER_STATUSES) {
          if (owner === "authorized") continue;
          assert.notEqual(
            selectPortalAccess(owner, roster, submitter).kind,
            "owner",
            `${owner}/${roster}/${submitter} must not grant owner access`,
          );
        }
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

describe("selectPortalAccess — Sales Staff (receipt submitter)", () => {
  test("16. not an owner, not a roster reader, but may submit => submitter", () => {
    assert.deepEqual(selectPortalAccess("unauthorized", "denied", "ok"), {
      kind: "submitter",
    });
  });

  test("17. an Owner never becomes a submitter, whatever the receipt read says", () => {
    // RECEIPT_SUBMIT is mapped to SALES_STAFF alone, so an Owner's receipt read would
    // be denied anyway — but owner-first precedence means the question is never even
    // reached, and that must stay true.
    for (const submitter of SUBMITTER_STATUSES) {
      assert.deepEqual(selectPortalAccess("authorized", "denied", submitter), {
        kind: "owner",
      });
    }
  });

  test("18. a Manager never becomes a submitter — the roster settles it first", () => {
    for (const submitter of SUBMITTER_STATUSES) {
      assert.deepEqual(selectPortalAccess("unauthorized", "ok", submitter), {
        kind: "reader",
      });
    }
  });

  test("19. the receipt probe is skipped for an Owner, a Manager and a signed-out visitor", () => {
    // A Manager's request must never call a Sales-Staff-only RPC at all.
    assert.equal(shouldProbeSubmitter("authorized", "denied"), false);
    assert.equal(shouldProbeSubmitter("unauthenticated", "denied"), false);
    assert.equal(shouldProbeSubmitter("unauthorized", "ok"), false);
  });

  test("20. the receipt probe IS issued when neither earlier read authorized", () => {
    assert.equal(shouldProbeSubmitter("unauthorized", "denied"), true);
    assert.equal(shouldProbeSubmitter("unavailable", "denied"), true);
    assert.equal(shouldProbeSubmitter("unauthorized", "unavailable"), true);
  });

  test("21. a denied receipt read leaves the caller unauthorized, not submitting", () => {
    assert.deepEqual(selectPortalAccess("unauthorized", "denied", "denied"), {
      kind: "unauthorized",
    });
  });

  test("22. a failed receipt read is unavailable, never a silent denial or an admission", () => {
    assert.deepEqual(selectPortalAccess("unauthorized", "denied", "unavailable"), {
      kind: "unavailable",
    });
  });

  test("23. no signed-out visitor ever reaches the submitter experience", () => {
    for (const roster of ROSTER_STATUSES) {
      for (const submitter of SUBMITTER_STATUSES) {
        assert.notEqual(
          selectPortalAccess("unauthenticated", roster, submitter).kind,
          "submitter",
        );
      }
    }
  });
});
