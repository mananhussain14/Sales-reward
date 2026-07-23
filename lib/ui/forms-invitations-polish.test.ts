/**
 * SOURCE-LEVEL and PURE-FUNCTION guards for the forms & invitation UI polish.
 *
 * Run with:  npm test
 *
 * These assert the behaviours the redesign had to PRESERVE — form field names,
 * connected Server Actions, separated staff sections, and user-facing status
 * text for every backend state — without asserting a single Tailwind class.
 * Where a property is decided by a pure module it is imported and exercised
 * directly; where it lives in JSX it is checked against a stable identifier
 * (a `name=` attribute, an id, a mapper call), never a class.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  STAFF_INVITATION_STATES,
  staffInvitationStateLabel,
  canResendInvitation,
  canRevokeInvitation,
  type StaffInvitationState,
} from "../staff/staff-normalization.ts";
import {
  buildOwnerStatusView,
  type RetailerOwnerState,
  type VendorRetailerOwnerStatus,
} from "../retailers/owner-status-normalization.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

const RETAILER_FORM = "app/(admin)/retailers/new/retailer-form.tsx";
const STAFF_INVITE_FORM = "app/(retailer)/retailer/staff/invite-staff-form.tsx";
const STAFF_PAGE = "app/(retailer)/retailer/staff/page.tsx";
const RETAILER_DETAIL = "app/(admin)/retailers/[relationshipId]/page.tsx";

describe("Add Retailer form is unchanged in contract", () => {
  const form = read(RETAILER_FORM);

  test("1. retains every submitted field", () => {
    for (const field of [
      "retailerName",
      "countryCode",
      "defaultCurrency",
      "shopName",
      "shopCode",
      "shopCity",
    ]) {
      assert.ok(
        form.includes(`field="${field}"`),
        `Add Retailer form lost the "${field}" field`,
      );
    }
  });

  test("2. still submits to the same Server Action", () => {
    assert.ok(form.includes("onboardRetailer"), "onboardRetailer action was disconnected");
    assert.ok(form.includes("action={formAction}"), "the form no longer posts to the action");
  });

  test("3. shows the combined-create information without new hidden fields", () => {
    assert.ok(
      form.includes("created together"),
      "the 'created together' explanation was removed",
    );
    assert.ok(!/type="hidden"/.test(form), "a hidden field was introduced");
  });
});

describe("Staff invitation form is unchanged in contract", () => {
  const form = read(STAFF_INVITE_FORM);

  test("4. retains name, email, role and shop selection fields", () => {
    for (const field of ["firstName", "lastName", "email", "roleCode", "shopIds"]) {
      assert.ok(form.includes(`name="${field}"`), `invite form lost the "${field}" field`);
    }
  });

  test("5. submits the same trusted role values", () => {
    assert.ok(form.includes("RETAILER_MANAGER"), "manager role value missing");
    assert.ok(form.includes("SALES_STAFF"), "sales staff role value missing");
    assert.ok(form.includes("inviteStaffAction"), "invite Server Action disconnected");
  });

  test("6. carries no token, hash, or role UUID into the client", () => {
    assert.ok(!/name="token"/.test(form), "a token field appeared");
    assert.ok(!/name="tokenHash"/.test(form), "a token hash field appeared");
    assert.ok(!/name="roleId"/.test(form), "a role UUID field appeared");
  });
});

describe("Staff page separates Active staff from Invitations", () => {
  const page = read(STAFF_PAGE);

  test("7. renders both a roster section and an invitations section", () => {
    assert.ok(page.includes('id="roster-heading"'), "the Active staff section id was lost");
    assert.ok(page.includes('id="invitations-heading"'), "the Invitations section id was lost");
    assert.ok(page.includes("Active staff"), "the Active staff heading text was lost");
  });

  test("8. renders a mapped status label, never the raw enum, for invitations", () => {
    assert.ok(
      page.includes("staffInvitationStateLabel"),
      "the invitation state is no longer mapped to a user-facing label",
    );
    // The raw derived state must not be printed straight into the markup.
    assert.ok(
      !page.includes(">{invitation.state}<"),
      "the raw invitation enum is rendered directly",
    );
  });

  test("9. keeps resend and revoke controls (only where the state allows)", () => {
    assert.ok(page.includes("canResendInvitation"), "resend gating was removed");
    assert.ok(page.includes("canRevokeInvitation"), "revoke gating was removed");
    assert.ok(page.includes("ResendInvitationForm"), "the resend control was removed");
    assert.ok(page.includes("RevokeInvitationForm"), "the revoke control was removed");
  });

  test("10. does not reintroduce a manual Accept control", () => {
    assert.ok(!/Accept invitation/i.test(page), "a manual Accept control reappeared");
  });
});

describe("every staff invitation state has visible, non-raw status text", () => {
  test("11. each state maps to a human label distinct from the enum", () => {
    for (const state of STAFF_INVITATION_STATES) {
      const label = staffInvitationStateLabel(state as StaffInvitationState);
      assert.ok(label.trim().length > 0, `state ${state} has an empty label`);
      assert.notEqual(label, state, `state ${state} renders its raw enum value`);
    }
  });

  test("12. resend/revoke are offered only for the three live states", () => {
    const live: StaffInvitationState[] = ["RESERVED", "PENDING", "DELIVERY_FAILED"];
    const history: StaffInvitationState[] = ["EXPIRED", "REVOKED", "ACCEPTED"];
    for (const state of live) {
      assert.ok(canResendInvitation(state), `${state} should allow resend`);
      assert.ok(canRevokeInvitation(state), `${state} should allow revoke`);
    }
    for (const state of history) {
      assert.ok(!canResendInvitation(state), `${state} must not allow resend`);
      assert.ok(!canRevokeInvitation(state), `${state} must not allow revoke`);
    }
  });
});

describe("every Retailer Owner state has a visible heading and description", () => {
  function status(overrides: Partial<VendorRetailerOwnerStatus>): VendorRetailerOwnerStatus {
    return {
      state: "NONE",
      firstName: "Sam",
      lastName: "Rivera",
      email: "owner@example.com",
      sentAt: "2026-01-01T00:00:00Z",
      expiresAt: "2026-02-01T00:00:00Z",
      acceptedAt: null,
      failureCode: null,
      invitationKind: null,
      ...overrides,
    };
  }

  const states: Array<{ state: RetailerOwnerState; extra?: Partial<VendorRetailerOwnerStatus> }> = [
    { state: "NONE", extra: { firstName: null, lastName: null, email: null } },
    { state: "PENDING", extra: { invitationKind: "NEW_USER" } },
    { state: "EXPIRED" },
    { state: "ACTIVE", extra: { acceptedAt: "2026-01-15T00:00:00Z" } },
    { state: "DELIVERY_FAILED", extra: { invitationKind: "NEW_USER" } },
  ];

  test("13. buildOwnerStatusView never returns empty display text", () => {
    for (const { state, extra } of states) {
      const view = buildOwnerStatusView(status({ state, ...extra }));
      assert.ok(view.heading.trim().length > 0, `${state} has an empty heading`);
      assert.ok(view.description.trim().length > 0, `${state} has an empty description`);
    }
  });
});

describe("Retailer detail keeps the owner invitation action connected", () => {
  const page = read(RETAILER_DETAIL);

  test("14. still routes to the owner invite page and uses the status view", () => {
    assert.ok(page.includes("/owner/invite"), "the owner invite route link was removed");
    assert.ok(page.includes("buildOwnerStatusView"), "the owner status view was removed");
  });

  test("15. the active-owner card exposes no identity field beyond the existing ones", () => {
    // The ACTIVE branch may read only these display-safe owner fields. A new field
    // here would mean surfacing identity data the page did not show before.
    const forbidden = ["ownerStatus.userId", "ownerStatus.membershipId", "ownerStatus.invitationId"];
    for (const ref of forbidden) {
      assert.ok(!page.includes(ref), `the detail page now reads ${ref}`);
    }
  });
});
