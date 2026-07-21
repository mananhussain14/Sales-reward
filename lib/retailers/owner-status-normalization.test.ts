/**
 * Unit tests for the pure Retailer Owner status normalization, presentation, and
 * submit-planning layer — including delivery-failure classification.
 *
 * Run with:  npm test
 *
 * Uses Node's BUILT-IN test runner (node:test) and assertion library
 * (node:assert). No testing package is installed — Node strips the TypeScript
 * types at load time via --experimental-strip-types, so these run directly
 * against the source with no build step.
 *
 * Scope is deliberately the PURE layer only. The server modules that call the RPCs
 * cannot be unit-tested here: they import `next/headers` transitively, which throws
 * outside a request scope. Their behaviour is covered by the database-level
 * harnesses against real PostgreSQL.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeOwnerStatusResult,
  buildOwnerStatusView,
  buildInviteFormModel,
  formatOwnerDisplayName,
  formatOwnerTimestamp,
  isDeliveryFailureRetryable,
  planInvitationSubmit,
  resolveOwnerInvitedCode,
  resolveOwnerInvitedMessage,
  RETAILER_OWNER_FAILURE_CODES,
  DATE_NOT_AVAILABLE,
  OWNER_NAME_FALLBACK,
  type VendorRetailerOwnerStatus,
} from "./owner-status-normalization.ts";

/** One valid RPC row, with sensible defaults (NONE, all-null). */
function row(overrides: Record<string, unknown> = {}) {
  return {
    owner_state: "NONE",
    owner_first_name: null,
    owner_last_name: null,
    owner_email: null,
    sent_at: null,
    expires_at: null,
    accepted_at: null,
    failure_code: null,
    ...overrides,
  };
}

/** A complete normalized status object for the presentation/planning tests. */
function status(overrides: Partial<VendorRetailerOwnerStatus>): VendorRetailerOwnerStatus {
  return {
    state: "NONE",
    firstName: null,
    lastName: null,
    email: null,
    sentAt: null,
    expiresAt: null,
    acceptedAt: null,
    failureCode: null,
    ...overrides,
  };
}

// ============================================================================
// Normalization — states, failure codes, fail-closed
// ============================================================================
describe("normalizeOwnerStatusResult — valid states", () => {
  test("NONE maps with failureCode null", () => {
    const r = normalizeOwnerStatusResult([row({ owner_state: "NONE" })]);
    assert.equal(r.status, "ok");
    assert.equal(r.status === "ok" && r.value.state, "NONE");
    assert.equal(r.status === "ok" && r.value.failureCode, null);
  });

  test("PENDING maps (member/sent present, failureCode null)", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "PENDING", owner_email: "p@x.com", sent_at: "2026-07-20T09:00:00Z", expires_at: "2026-07-21T09:00:00Z" }),
    ]);
    assert.equal(r.status, "ok");
    assert.equal(r.status === "ok" && r.value.state, "PENDING");
    assert.equal(r.status === "ok" && r.value.failureCode, null);
  });

  test("EXPIRED maps, failureCode null", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "EXPIRED", owner_email: "e@x.com", expires_at: "2026-07-19T09:00:00Z" }),
    ]);
    assert.equal(r.status === "ok" && r.value.state, "EXPIRED");
    assert.equal(r.status === "ok" && r.value.failureCode, null);
  });

  test("ACTIVE maps, failureCode null", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "ACTIVE", owner_first_name: "Al", owner_email: "a@x.com", accepted_at: "2026-07-20T12:00:00Z" }),
    ]);
    assert.equal(r.status === "ok" && r.value.state, "ACTIVE");
    assert.equal(r.status === "ok" && r.value.failureCode, null);
  });

  test("DELIVERY_FAILED historical (null) maps and is complete-shaped", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "DELIVERY_FAILED", owner_first_name: "Fay", owner_last_name: "Fail", owner_email: "f@x.com", expires_at: "2026-07-21T09:00:00Z" }),
    ]);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.status === "ok" && r.value, {
      state: "DELIVERY_FAILED",
      firstName: "Fay",
      lastName: "Fail",
      email: "f@x.com",
      sentAt: null,
      expiresAt: "2026-07-21T09:00:00Z",
      acceptedAt: null,
      failureCode: null,
    });
  });

  for (const code of RETAILER_OWNER_FAILURE_CODES) {
    test(`DELIVERY_FAILED + ${code} maps`, () => {
      const r = normalizeOwnerStatusResult([
        row({ owner_state: "DELIVERY_FAILED", owner_email: "f@x.com", failure_code: code }),
      ]);
      assert.equal(r.status, "ok");
      assert.equal(r.status === "ok" && r.value.state, "DELIVERY_FAILED");
      assert.equal(r.status === "ok" && r.value.failureCode, code);
    });
  }
});

describe("normalizeOwnerStatusResult — fails closed", () => {
  test("unknown owner_state fails", () => {
    assert.equal(normalizeOwnerStatusResult([row({ owner_state: "REVOKED" })]).status, "malformed");
  });

  test("unknown failure_code fails", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "DELIVERY_FAILED", owner_email: "f@x.com", failure_code: "SMTP_550" }),
    ]);
    assert.equal(r.status, "malformed");
  });

  test("failure_code on a non-DELIVERY_FAILED state fails", () => {
    for (const s of ["NONE", "PENDING", "EXPIRED", "ACTIVE"]) {
      const r = normalizeOwnerStatusResult([
        row({ owner_state: s, owner_email: "x@x.com", failure_code: "EXISTING_ACCOUNT" }),
      ]);
      assert.equal(r.status, "malformed", `expected malformed for ${s}`);
    }
  });

  test("actionable DELIVERY_FAILED with no email fails (null and AUTH_DISPATCH_FAILED)", () => {
    assert.equal(
      normalizeOwnerStatusResult([row({ owner_state: "DELIVERY_FAILED", owner_email: null, failure_code: null })]).status,
      "malformed",
    );
    assert.equal(
      normalizeOwnerStatusResult([row({ owner_state: "DELIVERY_FAILED", owner_email: null, failure_code: "AUTH_DISPATCH_FAILED" })]).status,
      "malformed",
    );
  });

  test("terminal DELIVERY_FAILED tolerates a missing email (informational only)", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "DELIVERY_FAILED", owner_email: null, failure_code: "EXISTING_ACCOUNT" }),
    ]);
    assert.equal(r.status, "ok");
  });

  test("malformed timestamp fails", () => {
    assert.equal(
      normalizeOwnerStatusResult([row({ owner_state: "PENDING", owner_email: "p@x.com", sent_at: "nope" })]).status,
      "malformed",
    );
  });

  test("missing row and multiple rows fail", () => {
    assert.equal(normalizeOwnerStatusResult([]).status, "malformed");
    assert.equal(normalizeOwnerStatusResult([row(), row({ owner_state: "ACTIVE" })]).status, "malformed");
    assert.equal(normalizeOwnerStatusResult(null).status, "malformed");
  });

  test("does not propagate an unexpected id field", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "ACTIVE", invitation_id: "11111111-1111-1111-1111-111111111111" }),
    ]);
    assert.equal(r.status, "ok");
    assert.deepEqual(
      r.status === "ok" && Object.keys(r.value).sort(),
      ["acceptedAt", "email", "expiresAt", "failureCode", "firstName", "lastName", "sentAt", "state"],
    );
  });
});

// ============================================================================
// Failure-code vocabulary — the server-only recorder passes only these codes
// ============================================================================
describe("RETAILER_OWNER_FAILURE_CODES", () => {
  test("is exactly the three approved safe codes", () => {
    assert.deepEqual([...RETAILER_OWNER_FAILURE_CODES].sort(), [
      "AUTH_DISPATCH_FAILED",
      "EXISTING_ACCOUNT",
      "FINALIZATION_FAILED",
    ]);
  });
});

// ============================================================================
// isDeliveryFailureRetryable
// ============================================================================
describe("isDeliveryFailureRetryable", () => {
  test("null and AUTH_DISPATCH_FAILED are retryable", () => {
    assert.equal(isDeliveryFailureRetryable(null), true);
    assert.equal(isDeliveryFailureRetryable("AUTH_DISPATCH_FAILED"), true);
  });
  test("EXISTING_ACCOUNT and FINALIZATION_FAILED are not", () => {
    assert.equal(isDeliveryFailureRetryable("EXISTING_ACCOUNT"), false);
    assert.equal(isDeliveryFailureRetryable("FINALIZATION_FAILED"), false);
  });
});

// ============================================================================
// Display formatting
// ============================================================================
describe("formatOwnerDisplayName", () => {
  test("both / one / neither", () => {
    assert.equal(formatOwnerDisplayName("Alex", "Active"), "Alex Active");
    assert.equal(formatOwnerDisplayName("Alex", null), "Alex");
    assert.equal(formatOwnerDisplayName(null, "Active"), "Active");
    assert.equal(formatOwnerDisplayName(null, null), OWNER_NAME_FALLBACK);
  });
});

describe("formatOwnerTimestamp", () => {
  test("null and invalid -> Not available, never 'Invalid Date'", () => {
    assert.equal(formatOwnerTimestamp(null), DATE_NOT_AVAILABLE);
    assert.equal(formatOwnerTimestamp("nonsense"), DATE_NOT_AVAILABLE);
  });
  test("valid ISO -> deterministic UTC string", () => {
    const out = formatOwnerTimestamp("2026-07-20T10:30:00Z");
    assert.ok(out.includes("2026") && out.endsWith("UTC") && !out.includes("Invalid"));
  });
});

// ============================================================================
// View-model — heading / description / action per state and failure code
// ============================================================================
describe("buildOwnerStatusView", () => {
  test("NONE action = Invite", () => {
    assert.equal(buildOwnerStatusView(status({ state: "NONE" })).action?.label, "Invite Retailer Owner");
  });
  test("PENDING action = Resend", () => {
    assert.equal(buildOwnerStatusView(status({ state: "PENDING" })).action?.label, "Resend invitation");
  });
  test("EXPIRED action = Send new invitation", () => {
    assert.equal(buildOwnerStatusView(status({ state: "EXPIRED" })).action?.label, "Send new invitation");
  });
  test("ACTIVE has no action", () => {
    assert.equal(buildOwnerStatusView(status({ state: "ACTIVE" })).action, null);
  });

  test("DELIVERY_FAILED + AUTH_DISPATCH_FAILED offers Retry", () => {
    const v = buildOwnerStatusView(status({ state: "DELIVERY_FAILED", failureCode: "AUTH_DISPATCH_FAILED", email: "f@x.com" }));
    assert.equal(v.action?.label, "Retry invitation");
    assert.equal(v.heading, "Invitation not sent");
  });
  test("DELIVERY_FAILED + null (historical) offers Retry", () => {
    const v = buildOwnerStatusView(status({ state: "DELIVERY_FAILED", failureCode: null, email: "f@x.com" }));
    assert.equal(v.action?.label, "Retry invitation");
  });
  test("DELIVERY_FAILED + EXISTING_ACCOUNT offers no action", () => {
    const v = buildOwnerStatusView(status({ state: "DELIVERY_FAILED", failureCode: "EXISTING_ACCOUNT", email: "f@x.com" }));
    assert.equal(v.action, null);
    assert.ok(v.description.includes("already has an account"));
  });
  test("DELIVERY_FAILED + FINALIZATION_FAILED offers no action", () => {
    const v = buildOwnerStatusView(status({ state: "DELIVERY_FAILED", failureCode: "FINALIZATION_FAILED", email: "f@x.com" }));
    assert.equal(v.action, null);
    assert.equal(v.heading, "Owner setup incomplete");
  });
});

// ============================================================================
// Invite form model
// ============================================================================
describe("buildInviteFormModel", () => {
  test("NONE -> new, editable, empty", () => {
    const m = buildInviteFormModel(status({ state: "NONE" }));
    assert.equal(m.mode, "new");
    assert.equal(m.lockedEmail, null);
  });
  test("DELIVERY_FAILED retryable -> retry with locked email", () => {
    const m = buildInviteFormModel(status({ state: "DELIVERY_FAILED", failureCode: "AUTH_DISPATCH_FAILED", firstName: "Fay", email: "f@x.com" }));
    assert.equal(m.mode, "retry");
    assert.equal(m.lockedEmail, "f@x.com");
    assert.equal(m.submitLabel, "Retry invitation");
  });
  test("PENDING -> resend with locked email", () => {
    const m = buildInviteFormModel(status({ state: "PENDING", email: "p@x.com" }));
    assert.equal(m.mode, "resend");
    assert.equal(m.lockedEmail, "p@x.com");
  });
  test("EXPIRED -> replace, editable, previous recipient context", () => {
    const m = buildInviteFormModel(status({ state: "EXPIRED", firstName: "Eve", lastName: "E", email: "e@x.com" }));
    assert.equal(m.mode, "replace");
    assert.equal(m.lockedEmail, null);
    assert.equal(m.previousRecipient?.email, "e@x.com");
  });
});

// ============================================================================
// Submit planning — tamper + terminal-state protection
// ============================================================================
describe("planInvitationSubmit", () => {
  test("PENDING forces the RPC email (submitted value irrelevant)", () => {
    const p = planInvitationSubmit("PENDING", null, "real@x.com");
    assert.equal(p.kind, "resend");
    assert.equal(p.kind === "resend" && p.email, "real@x.com");
  });
  test("DELIVERY_FAILED + AUTH_DISPATCH_FAILED -> secure retry (canonical email wins)", () => {
    const p = planInvitationSubmit("DELIVERY_FAILED", "AUTH_DISPATCH_FAILED", "Real@X.com");
    assert.equal(p.kind, "resend");
    assert.equal(p.kind === "resend" && p.email, "real@x.com");
  });
  test("DELIVERY_FAILED + null -> secure retry", () => {
    assert.equal(planInvitationSubmit("DELIVERY_FAILED", null, "r@x.com").kind, "resend");
  });
  test("DELIVERY_FAILED + EXISTING_ACCOUNT -> blocked", () => {
    assert.equal(planInvitationSubmit("DELIVERY_FAILED", "EXISTING_ACCOUNT", "r@x.com").kind, "blocked-existing-account");
  });
  test("DELIVERY_FAILED + FINALIZATION_FAILED -> blocked", () => {
    assert.equal(planInvitationSubmit("DELIVERY_FAILED", "FINALIZATION_FAILED", "r@x.com").kind, "blocked-finalization");
  });
  test("ACTIVE -> blocked-active", () => {
    assert.equal(planInvitationSubmit("ACTIVE", null, null).kind, "blocked-active");
  });
  test("retryable resend with missing email fails closed", () => {
    assert.equal(planInvitationSubmit("DELIVERY_FAILED", "AUTH_DISPATCH_FAILED", null).kind, "state-unavailable");
    assert.equal(planInvitationSubmit("PENDING", null, "  ").kind, "state-unavailable");
  });
  test("NONE and EXPIRED accept the submitted email (new mode)", () => {
    assert.equal(planInvitationSubmit("NONE", null, "n@x.com").kind, "new");
    assert.equal(planInvitationSubmit("EXPIRED", null, "old@x.com").kind, "new");
  });
});

// ============================================================================
// Success feedback — fixed vocabulary only
// ============================================================================
describe("success feedback", () => {
  test("resolveOwnerInvitedCode: PENDING->resent, EXPIRED->new, others->sent", () => {
    assert.equal(resolveOwnerInvitedCode("PENDING"), "resent");
    assert.equal(resolveOwnerInvitedCode("EXPIRED"), "new");
    assert.equal(resolveOwnerInvitedCode("NONE"), "sent");
    assert.equal(resolveOwnerInvitedCode("DELIVERY_FAILED"), "sent");
  });
  test("resolveOwnerInvitedMessage maps known codes and rejects everything else", () => {
    assert.equal(resolveOwnerInvitedMessage("sent"), "Retailer Owner invitation sent.");
    assert.equal(resolveOwnerInvitedMessage("resent"), "Retailer Owner invitation resent.");
    assert.equal(resolveOwnerInvitedMessage("new"), "New Retailer Owner invitation sent.");
    assert.equal(resolveOwnerInvitedMessage("1"), "Retailer Owner invitation sent.");
    assert.equal(resolveOwnerInvitedMessage("<script>"), null);
    assert.equal(resolveOwnerInvitedMessage("constructor"), null);
    assert.equal(resolveOwnerInvitedMessage(undefined), null);
    assert.equal(resolveOwnerInvitedMessage(["sent"]), null);
  });
});
