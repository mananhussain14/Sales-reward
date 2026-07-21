/**
 * Unit tests for the pure Retailer Owner status normalization, presentation, and
 * submit-planning layer.
 *
 * Run with:  npm test
 *
 * Uses Node's BUILT-IN test runner (node:test) and assertion library
 * (node:assert). No testing package is installed — Node strips the TypeScript
 * types at load time via --experimental-strip-types, so these run directly
 * against the source with no build step.
 *
 * Scope is deliberately the PURE layer only. The server module that calls the RPC
 * (./vendor-retailer-owner-status.ts) cannot be unit-tested here: it imports
 * `next/headers` transitively, which throws outside a request scope. Its behaviour
 * is covered by the database-level dry-run harness, which exercises the real
 * authorization chain against real PostgreSQL.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOwnerStatusResult,
  buildOwnerStatusView,
  buildInviteFormModel,
  formatOwnerDisplayName,
  formatOwnerTimestamp,
  planInvitationSubmit,
  resolveOwnerInvitedCode,
  resolveOwnerInvitedMessage,
  DATE_NOT_AVAILABLE,
  OWNER_NAME_FALLBACK,
  type VendorRetailerOwnerStatus,
} from "./owner-status-normalization.ts";

/** One valid RPC row for a given state, with sensible defaults. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    owner_state: "NONE",
    owner_first_name: null,
    owner_last_name: null,
    owner_email: null,
    sent_at: null,
    expires_at: null,
    accepted_at: null,
    ...overrides,
  };
}

// ============================================================================
// Normalization — the five states map, malformed input fails closed
// ============================================================================
describe("normalizeOwnerStatusResult — valid states", () => {
  test("1. NONE maps correctly", () => {
    const result = normalizeOwnerStatusResult([row({ owner_state: "NONE" })]);
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" && result.value.state, "NONE");
  });

  test("2. DELIVERY_FAILED maps correctly", () => {
    const result = normalizeOwnerStatusResult([
      row({
        owner_state: "DELIVERY_FAILED",
        owner_first_name: "Fay",
        owner_last_name: "Fail",
        owner_email: "failed@example.com",
        expires_at: "2026-07-20T10:30:00Z",
      }),
    ]);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.status === "ok" && result.value, {
      state: "DELIVERY_FAILED",
      firstName: "Fay",
      lastName: "Fail",
      email: "failed@example.com",
      sentAt: null,
      expiresAt: "2026-07-20T10:30:00Z",
      acceptedAt: null,
    });
  });

  test("3. PENDING maps correctly", () => {
    const result = normalizeOwnerStatusResult([
      row({
        owner_state: "PENDING",
        owner_first_name: "Pat",
        owner_last_name: "Pending",
        owner_email: "pending@example.com",
        sent_at: "2026-07-20T09:00:00Z",
        expires_at: "2026-07-21T09:00:00Z",
      }),
    ]);
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" && result.value.state, "PENDING");
    assert.equal(result.status === "ok" && result.value.sentAt, "2026-07-20T09:00:00Z");
  });

  test("4. EXPIRED maps correctly", () => {
    const result = normalizeOwnerStatusResult([
      row({
        owner_state: "EXPIRED",
        owner_first_name: "Eve",
        owner_last_name: "Expired",
        owner_email: "expired@example.com",
        sent_at: "2026-07-18T09:00:00Z",
        expires_at: "2026-07-19T09:00:00Z",
      }),
    ]);
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" && result.value.state, "EXPIRED");
  });

  test("5. ACTIVE maps correctly", () => {
    const result = normalizeOwnerStatusResult([
      row({
        owner_state: "ACTIVE",
        owner_first_name: "Alex",
        owner_last_name: "Active",
        owner_email: "active@example.com",
        accepted_at: "2026-07-20T12:00:00Z",
      }),
    ]);
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" && result.value.state, "ACTIVE");
    assert.equal(result.status === "ok" && result.value.acceptedAt, "2026-07-20T12:00:00Z");
  });

  test("trims present name and email values", () => {
    const result = normalizeOwnerStatusResult([
      row({ owner_state: "ACTIVE", owner_first_name: "  Alex  ", owner_email: "  a@b.com  " }),
    ]);
    assert.equal(result.status === "ok" && result.value.firstName, "Alex");
    assert.equal(result.status === "ok" && result.value.email, "a@b.com");
  });
});

describe("normalizeOwnerStatusResult — fails closed", () => {
  test("6. unknown state fails closed", () => {
    const result = normalizeOwnerStatusResult([row({ owner_state: "REVOKED" })]);
    assert.equal(result.status, "malformed");
  });

  test("6b. absent state fails closed", () => {
    const result = normalizeOwnerStatusResult([row({ owner_state: undefined })]);
    assert.equal(result.status, "malformed");
  });

  test("7. malformed timestamp fails closed", () => {
    const result = normalizeOwnerStatusResult([
      row({ owner_state: "PENDING", sent_at: "not-a-date" }),
    ]);
    assert.equal(result.status, "malformed");
  });

  test("7b. present-but-blank name fails closed", () => {
    const result = normalizeOwnerStatusResult([
      row({ owner_state: "ACTIVE", owner_first_name: "   " }),
    ]);
    assert.equal(result.status, "malformed");
  });

  test("8. missing row (zero rows) fails closed", () => {
    const result = normalizeOwnerStatusResult([]);
    assert.equal(result.status, "malformed");
  });

  test("9. multiple rows fail closed", () => {
    const result = normalizeOwnerStatusResult([row(), row({ owner_state: "ACTIVE" })]);
    assert.equal(result.status, "malformed");
  });

  test("non-array result fails closed", () => {
    assert.equal(normalizeOwnerStatusResult(null).status, "malformed");
    assert.equal(normalizeOwnerStatusResult({}).status, "malformed");
  });

  test("does not propagate an unexpected id field", () => {
    const result = normalizeOwnerStatusResult([
      row({ owner_state: "ACTIVE", invitation_id: "11111111-1111-1111-1111-111111111111" }),
    ]);
    assert.equal(result.status, "ok");
    // The value object has exactly the seven safe keys — no id leaked through.
    assert.deepEqual(
      result.status === "ok" && Object.keys(result.value).sort(),
      ["acceptedAt", "email", "expiresAt", "firstName", "lastName", "sentAt", "state"],
    );
  });
});

// ============================================================================
// Display formatting
// ============================================================================
describe("formatOwnerDisplayName", () => {
  test("10. both names -> first last", () => {
    assert.equal(formatOwnerDisplayName("Alex", "Active"), "Alex Active");
  });
  test("10. only first name", () => {
    assert.equal(formatOwnerDisplayName("Alex", null), "Alex");
  });
  test("10. only last name", () => {
    assert.equal(formatOwnerDisplayName(null, "Active"), "Active");
  });
  test("10. neither -> safe fallback", () => {
    assert.equal(formatOwnerDisplayName(null, null), OWNER_NAME_FALLBACK);
    assert.equal(formatOwnerDisplayName("  ", "  "), OWNER_NAME_FALLBACK);
  });
});

describe("formatOwnerTimestamp", () => {
  test("null -> Not available", () => {
    assert.equal(formatOwnerTimestamp(null), DATE_NOT_AVAILABLE);
  });
  test("unparseable -> Not available, never 'Invalid Date'", () => {
    const out = formatOwnerTimestamp("nonsense");
    assert.equal(out, DATE_NOT_AVAILABLE);
    assert.ok(!out.includes("Invalid"));
  });
  test("valid ISO -> deterministic UTC string", () => {
    const out = formatOwnerTimestamp("2026-07-20T10:30:00Z");
    assert.ok(out.includes("2026"));
    assert.ok(out.endsWith("UTC"));
    assert.ok(!out.includes("Invalid"));
  });
});

// ============================================================================
// View-model — action label per state
// ============================================================================
describe("buildOwnerStatusView", () => {
  test("11. NONE action = Invite Retailer Owner", () => {
    assert.equal(buildOwnerStatusView("NONE").action?.label, "Invite Retailer Owner");
  });
  test("12. DELIVERY_FAILED action = Retry invitation", () => {
    assert.equal(buildOwnerStatusView("DELIVERY_FAILED").action?.label, "Retry invitation");
  });
  test("13. PENDING action = Resend invitation", () => {
    assert.equal(buildOwnerStatusView("PENDING").action?.label, "Resend invitation");
  });
  test("14. EXPIRED action = Send new invitation", () => {
    assert.equal(buildOwnerStatusView("EXPIRED").action?.label, "Send new invitation");
  });
  test("15. ACTIVE has no invitation action", () => {
    assert.equal(buildOwnerStatusView("ACTIVE").action, null);
  });
});

// ============================================================================
// Invite form model
// ============================================================================
describe("buildInviteFormModel", () => {
  function status(overrides: Partial<VendorRetailerOwnerStatus>): VendorRetailerOwnerStatus {
    return {
      state: "NONE",
      firstName: null,
      lastName: null,
      email: null,
      sentAt: null,
      expiresAt: null,
      acceptedAt: null,
      ...overrides,
    };
  }

  test("NONE -> new mode, editable, empty", () => {
    const model = buildInviteFormModel(status({ state: "NONE" }));
    assert.equal(model.mode, "new");
    assert.equal(model.lockedEmail, null);
    assert.equal(model.initialEmail, "");
  });

  test("DELIVERY_FAILED -> retry mode with locked email + prefilled names", () => {
    const model = buildInviteFormModel(
      status({ state: "DELIVERY_FAILED", firstName: "Fay", lastName: "Fail", email: "f@x.com" }),
    );
    assert.equal(model.mode, "retry");
    assert.equal(model.lockedEmail, "f@x.com");
    assert.equal(model.initialFirstName, "Fay");
    assert.equal(model.submitLabel, "Retry invitation");
  });

  test("PENDING -> resend mode with locked email", () => {
    const model = buildInviteFormModel(
      status({ state: "PENDING", firstName: "Pat", lastName: "P", email: "p@x.com" }),
    );
    assert.equal(model.mode, "resend");
    assert.equal(model.lockedEmail, "p@x.com");
    assert.equal(model.submitLabel, "Resend invitation");
  });

  test("EXPIRED -> replace mode, editable email, previous recipient as context", () => {
    const model = buildInviteFormModel(
      status({ state: "EXPIRED", firstName: "Eve", lastName: "E", email: "e@x.com" }),
    );
    assert.equal(model.mode, "replace");
    assert.equal(model.lockedEmail, null);
    assert.equal(model.previousRecipient?.email, "e@x.com");
    assert.equal(model.previousRecipient?.name, "Eve E");
  });
});

// ============================================================================
// Submit planning — tamper + concurrency protection
// ============================================================================
describe("planInvitationSubmit", () => {
  test("16. PENDING forces the RPC email, ignoring any submitted value", () => {
    const plan = planInvitationSubmit("PENDING", "real@x.com");
    assert.equal(plan.kind, "resend");
    assert.equal(plan.kind === "resend" && plan.email, "real@x.com");
  });

  test("16. DELIVERY_FAILED forces the RPC email", () => {
    const plan = planInvitationSubmit("DELIVERY_FAILED", "Real@X.com");
    assert.equal(plan.kind, "resend");
    // Canonicalized to match the database's stored form.
    assert.equal(plan.kind === "resend" && plan.email, "real@x.com");
  });

  test("16. NONE and EXPIRED accept the submitted email (new mode)", () => {
    assert.equal(planInvitationSubmit("NONE", null).kind, "new");
    assert.equal(planInvitationSubmit("EXPIRED", "old@x.com").kind, "new");
  });

  test("17. ACTIVE is blocked", () => {
    assert.equal(planInvitationSubmit("ACTIVE", null).kind, "blocked-active");
  });

  test("17. resend state with missing email fails closed", () => {
    assert.equal(planInvitationSubmit("PENDING", null).kind, "state-unavailable");
    assert.equal(planInvitationSubmit("DELIVERY_FAILED", "  ").kind, "state-unavailable");
  });
});

// ============================================================================
// Success feedback — fixed vocabulary only
// ============================================================================
describe("resolveOwnerInvitedCode", () => {
  test("PENDING -> resent, EXPIRED -> new, others -> sent", () => {
    assert.equal(resolveOwnerInvitedCode("PENDING"), "resent");
    assert.equal(resolveOwnerInvitedCode("EXPIRED"), "new");
    assert.equal(resolveOwnerInvitedCode("NONE"), "sent");
    assert.equal(resolveOwnerInvitedCode("DELIVERY_FAILED"), "sent");
  });
});

describe("resolveOwnerInvitedMessage", () => {
  test("known codes map to fixed messages", () => {
    assert.equal(resolveOwnerInvitedMessage("sent"), "Retailer Owner invitation sent.");
    assert.equal(resolveOwnerInvitedMessage("resent"), "Retailer Owner invitation resent.");
    assert.equal(resolveOwnerInvitedMessage("new"), "New Retailer Owner invitation sent.");
    assert.equal(resolveOwnerInvitedMessage("1"), "Retailer Owner invitation sent.");
  });

  test("18. arbitrary text is rejected (no injection)", () => {
    assert.equal(resolveOwnerInvitedMessage("<script>alert(1)</script>"), null);
    assert.equal(resolveOwnerInvitedMessage("You have been hacked"), null);
    assert.equal(resolveOwnerInvitedMessage(""), null);
    assert.equal(resolveOwnerInvitedMessage(undefined), null);
    assert.equal(resolveOwnerInvitedMessage(["sent"]), null);
  });

  test("18. inherited object keys cannot select a message", () => {
    assert.equal(resolveOwnerInvitedMessage("constructor"), null);
    assert.equal(resolveOwnerInvitedMessage("toString"), null);
    assert.equal(resolveOwnerInvitedMessage("hasOwnProperty"), null);
  });
});
