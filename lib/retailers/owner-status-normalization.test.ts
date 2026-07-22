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
  classifyOwnerAction,
  formatOwnerDisplayName,
  formatOwnerTimestamp,
  isDeliveryFailureRetryable,
  isExistingUserActionKind,
  isExistingUserActionPlan,
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
    invitation_kind: null,
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
    invitationKind: null,
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
      invitationKind: null,
    });
  });

  for (const code of RETAILER_OWNER_FAILURE_CODES) {
    test(`DELIVERY_FAILED + ${code} maps`, () => {
      // EXISTING_USER_EMAIL_FAILED is an existing-user-flow code and is valid ONLY on
      // an EXISTING_USER invitation; the new-user codes carry a null/NEW_USER kind.
      const invitation_kind =
        code === "EXISTING_USER_EMAIL_FAILED" ? "EXISTING_USER" : null;
      const r = normalizeOwnerStatusResult([
        row({ owner_state: "DELIVERY_FAILED", owner_email: "f@x.com", failure_code: code, invitation_kind }),
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

  test("EXISTING_ACCOUNT with no email now fails (it is actionable: send-existing)", () => {
    // EXISTING_ACCOUNT is no longer a dead end — it offers an existing-user send,
    // which needs a recipient — so a missing email is a fault, not tolerated.
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "DELIVERY_FAILED", owner_email: null, failure_code: "EXISTING_ACCOUNT" }),
    ]);
    assert.equal(r.status, "malformed");
  });

  test("FINALIZATION_FAILED tolerates a missing email (informational only)", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "DELIVERY_FAILED", owner_email: null, failure_code: "FINALIZATION_FAILED" }),
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
      ["acceptedAt", "email", "expiresAt", "failureCode", "firstName", "invitationKind", "lastName", "sentAt", "state"],
    );
  });
});

// ============================================================================
// Failure-code vocabulary — the server-only recorder passes only these codes
// ============================================================================
describe("RETAILER_OWNER_FAILURE_CODES", () => {
  test("is exactly the four approved safe codes", () => {
    assert.deepEqual([...RETAILER_OWNER_FAILURE_CODES].sort(), [
      "AUTH_DISPATCH_FAILED",
      "EXISTING_ACCOUNT",
      "EXISTING_USER_EMAIL_FAILED",
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
  test("PENDING action = Resend (needs a recipient email)", () => {
    assert.equal(
      buildOwnerStatusView(status({ state: "PENDING", email: "p@x.com" })).action?.label,
      "Resend invitation",
    );
  });
  test("EXPIRED action = Invite Retailer Owner", () => {
    // EXPIRED reuses the editable new-user invite form, so it carries the invite label.
    assert.equal(buildOwnerStatusView(status({ state: "EXPIRED" })).action?.label, "Invite Retailer Owner");
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
  test("DELIVERY_FAILED + EXISTING_ACCOUNT now offers the existing-user send", () => {
    const v = buildOwnerStatusView(status({ state: "DELIVERY_FAILED", failureCode: "EXISTING_ACCOUNT", email: "f@x.com" }));
    assert.equal(v.action?.label, "Send existing-user invitation");
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

// ============================================================================
// invitation_kind normalization + EXISTING_USER_EMAIL_FAILED
// ============================================================================
describe("normalizeOwnerStatusResult — invitation_kind", () => {
  test("EXISTING_USER_EMAIL_FAILED is an approved failure code", () => {
    assert.ok(RETAILER_OWNER_FAILURE_CODES.includes("EXISTING_USER_EMAIL_FAILED"));
  });

  test("NEW_USER PENDING carries invitationKind NEW_USER", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "PENDING", owner_email: "p@x.com", invitation_kind: "NEW_USER" }),
    ]);
    assert.equal(r.status === "ok" && r.value.invitationKind, "NEW_USER");
  });

  test("EXISTING_USER PENDING carries invitationKind EXISTING_USER", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "PENDING", owner_email: "p@x.com", invitation_kind: "EXISTING_USER" }),
    ]);
    assert.equal(r.status === "ok" && r.value.invitationKind, "EXISTING_USER");
  });

  test("null invitation_kind is allowed on non-NONE states", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "PENDING", owner_email: "p@x.com", invitation_kind: null }),
    ]);
    assert.equal(r.status === "ok" && r.value.invitationKind, null);
  });

  test("an unknown invitation_kind fails closed", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "PENDING", owner_email: "p@x.com", invitation_kind: "SOMETHING" }),
    ]);
    assert.equal(r.status, "malformed");
  });

  test("invitation_kind on the NONE state fails closed", () => {
    const r = normalizeOwnerStatusResult([
      row({ owner_state: "NONE", invitation_kind: "NEW_USER" }),
    ]);
    assert.equal(r.status, "malformed");
  });

  test("EXISTING_USER_EMAIL_FAILED with a valid EXISTING_USER DELIVERY_FAILED normalizes", () => {
    const r = normalizeOwnerStatusResult([
      row({
        owner_state: "DELIVERY_FAILED",
        owner_email: "e@x.com",
        failure_code: "EXISTING_USER_EMAIL_FAILED",
        invitation_kind: "EXISTING_USER",
      }),
    ]);
    assert.equal(r.status, "ok");
    assert.equal(r.status === "ok" && r.value.failureCode, "EXISTING_USER_EMAIL_FAILED");
    assert.equal(r.status === "ok" && r.value.invitationKind, "EXISTING_USER");
  });

  test("EXISTING_USER_EMAIL_FAILED on a NEW_USER invitation fails closed", () => {
    const r = normalizeOwnerStatusResult([
      row({
        owner_state: "DELIVERY_FAILED",
        owner_email: "e@x.com",
        failure_code: "EXISTING_USER_EMAIL_FAILED",
        invitation_kind: "NEW_USER",
      }),
    ]);
    assert.equal(r.status, "malformed");
  });
});

// ============================================================================
// classifyOwnerAction — the single action source of truth
// ============================================================================
describe("classifyOwnerAction", () => {
  test("ACTIVE -> none", () => {
    assert.equal(classifyOwnerAction(status({ state: "ACTIVE" })).kind, "none");
  });

  test("NONE and EXPIRED -> invite-new", () => {
    assert.equal(classifyOwnerAction(status({ state: "NONE" })).kind, "invite-new");
    assert.equal(classifyOwnerAction(status({ state: "EXPIRED" })).kind, "invite-new");
  });

  test("NEW_USER PENDING -> resend-new with the canonical email", () => {
    const plan = classifyOwnerAction(
      status({ state: "PENDING", email: "Owner@X.com", invitationKind: "NEW_USER" }),
    );
    assert.equal(plan.kind, "resend-new");
    assert.equal(plan.kind === "resend-new" && plan.email, "owner@x.com");
  });

  test("EXISTING_USER PENDING -> resend-existing", () => {
    const plan = classifyOwnerAction(
      status({ state: "PENDING", email: "e@x.com", invitationKind: "EXISTING_USER" }),
    );
    assert.equal(plan.kind, "resend-existing");
  });

  test("NEW_USER DELIVERY_FAILED EXISTING_ACCOUNT -> send-existing", () => {
    const plan = classifyOwnerAction(
      status({
        state: "DELIVERY_FAILED",
        email: "e@x.com",
        failureCode: "EXISTING_ACCOUNT",
        invitationKind: "NEW_USER",
      }),
    );
    assert.equal(plan.kind, "send-existing");
  });

  test("NEW_USER DELIVERY_FAILED AUTH_DISPATCH_FAILED -> retry-new", () => {
    const plan = classifyOwnerAction(
      status({
        state: "DELIVERY_FAILED",
        email: "e@x.com",
        failureCode: "AUTH_DISPATCH_FAILED",
        invitationKind: "NEW_USER",
      }),
    );
    assert.equal(plan.kind, "retry-new");
  });

  test("EXISTING_USER DELIVERY_FAILED (EXISTING_USER_EMAIL_FAILED) -> retry-existing", () => {
    const plan = classifyOwnerAction(
      status({
        state: "DELIVERY_FAILED",
        email: "e@x.com",
        failureCode: "EXISTING_USER_EMAIL_FAILED",
        invitationKind: "EXISTING_USER",
      }),
    );
    assert.equal(plan.kind, "retry-existing");
  });

  test("FINALIZATION_FAILED -> none", () => {
    assert.equal(
      classifyOwnerAction(
        status({ state: "DELIVERY_FAILED", failureCode: "FINALIZATION_FAILED" }),
      ).kind,
      "none",
    );
  });

  test("a DELIVERY_FAILED with no email -> none (cannot act)", () => {
    assert.equal(
      classifyOwnerAction(
        status({ state: "DELIVERY_FAILED", email: null, failureCode: "AUTH_DISPATCH_FAILED" }),
      ).kind,
      "none",
    );
  });
});

describe("isExistingUserActionKind", () => {
  test("true for the three existing-user kinds", () => {
    assert.ok(isExistingUserActionKind("send-existing"));
    assert.ok(isExistingUserActionKind("resend-existing"));
    assert.ok(isExistingUserActionKind("retry-existing"));
  });
  test("false for new-user kinds and none", () => {
    for (const k of ["invite-new", "resend-new", "retry-new", "none"] as const) {
      assert.equal(isExistingUserActionKind(k), false);
    }
  });
});

describe("buildOwnerStatusView — existing-user states", () => {
  test("EXISTING_ACCOUNT offers the Send existing-user invitation action", () => {
    const view = buildOwnerStatusView(
      status({
        state: "DELIVERY_FAILED",
        email: "e@x.com",
        failureCode: "EXISTING_ACCOUNT",
        invitationKind: "NEW_USER",
      }),
    );
    assert.equal(view.action?.label, "Send existing-user invitation");
  });

  test("EXISTING_USER PENDING offers a Resend action", () => {
    const view = buildOwnerStatusView(
      status({ state: "PENDING", email: "e@x.com", invitationKind: "EXISTING_USER" }),
    );
    assert.equal(view.action?.label, "Resend invitation");
  });

  test("EXISTING_USER DELIVERY_FAILED offers a Retry action", () => {
    const view = buildOwnerStatusView(
      status({
        state: "DELIVERY_FAILED",
        email: "e@x.com",
        failureCode: "EXISTING_USER_EMAIL_FAILED",
        invitationKind: "EXISTING_USER",
      }),
    );
    assert.equal(view.action?.label, "Retry invitation");
  });

  test("FINALIZATION_FAILED offers no action", () => {
    const view = buildOwnerStatusView(
      status({ state: "DELIVERY_FAILED", failureCode: "FINALIZATION_FAILED" }),
    );
    assert.equal(view.action, null);
  });
});

// ============================================================================
// AUTHORITATIVE VENDOR UI STATE MATRIX (A–K) — one row per matrix entry.
//
// Pins the single source both Vendor pages derive from: for each status, the
// classifier kind, the view action label, whether an action exists, and which flow
// (new-user vs existing-user token+Resend) carries it out. This is the regression
// guard that the detail card and the invite page cannot drift apart, and that the
// existing-user rollout did not change new-user rows.
// ============================================================================
describe("Vendor UI state matrix (A–K)", () => {
  type Row = {
    id: string;
    s: VendorRetailerOwnerStatus;
    kind: string;
    label: string | null; // null => no action
    existingUserFlow: boolean;
  };

  const rows: Row[] = [
    // A. NONE -> editable new-user invite.
    { id: "A NONE", s: status({ state: "NONE" }), kind: "invite-new", label: "Invite Retailer Owner", existingUserFlow: false },
    // B. EXPIRED -> editable new-user invite (reuses the invite label).
    { id: "B EXPIRED", s: status({ state: "EXPIRED", email: "e@x.com" }), kind: "invite-new", label: "Invite Retailer Owner", existingUserFlow: false },
    // C. NEW_USER PENDING -> locked new-user resend.
    { id: "C NEW_USER PENDING", s: status({ state: "PENDING", email: "p@x.com", invitationKind: "NEW_USER" }), kind: "resend-new", label: "Resend invitation", existingUserFlow: false },
    // D. NEW_USER DELIVERY_FAILED + AUTH_DISPATCH_FAILED -> locked new-user retry.
    { id: "D NEW_USER AUTH_DISPATCH_FAILED", s: status({ state: "DELIVERY_FAILED", email: "e@x.com", failureCode: "AUTH_DISPATCH_FAILED", invitationKind: "NEW_USER" }), kind: "retry-new", label: "Retry invitation", existingUserFlow: false },
    // E. NEW_USER DELIVERY_FAILED + historical null -> locked new-user retry.
    { id: "E NEW_USER null-failure", s: status({ state: "DELIVERY_FAILED", email: "e@x.com", failureCode: null, invitationKind: "NEW_USER" }), kind: "retry-new", label: "Retry invitation", existingUserFlow: false },
    // F. NEW_USER DELIVERY_FAILED + EXISTING_ACCOUNT -> existing-user SEND.
    { id: "F EXISTING_ACCOUNT", s: status({ state: "DELIVERY_FAILED", email: "e@x.com", failureCode: "EXISTING_ACCOUNT", invitationKind: "NEW_USER" }), kind: "send-existing", label: "Send existing-user invitation", existingUserFlow: true },
    // G. EXISTING_USER PENDING -> existing-user RESEND.
    { id: "G EXISTING_USER PENDING", s: status({ state: "PENDING", email: "e@x.com", invitationKind: "EXISTING_USER" }), kind: "resend-existing", label: "Resend invitation", existingUserFlow: true },
    // H. EXISTING_USER DELIVERY_FAILED + EXISTING_USER_EMAIL_FAILED -> existing-user RETRY.
    { id: "H EXISTING_USER_EMAIL_FAILED", s: status({ state: "DELIVERY_FAILED", email: "e@x.com", failureCode: "EXISTING_USER_EMAIL_FAILED", invitationKind: "EXISTING_USER" }), kind: "retry-existing", label: "Retry invitation", existingUserFlow: true },
    // H (null variant). EXISTING_USER DELIVERY_FAILED + null -> existing-user RETRY.
    { id: "H EXISTING_USER null-failure", s: status({ state: "DELIVERY_FAILED", email: "e@x.com", failureCode: null, invitationKind: "EXISTING_USER" }), kind: "retry-existing", label: "Retry invitation", existingUserFlow: true },
    // I. FINALIZATION_FAILED -> no action.
    { id: "I FINALIZATION_FAILED", s: status({ state: "DELIVERY_FAILED", email: "e@x.com", failureCode: "FINALIZATION_FAILED", invitationKind: "NEW_USER" }), kind: "none", label: null, existingUserFlow: false },
    // J. ACTIVE -> no action.
    { id: "J ACTIVE", s: status({ state: "ACTIVE", email: "e@x.com" }), kind: "none", label: null, existingUserFlow: false },
  ];

  for (const row of rows) {
    test(`${row.id}: kind=${row.kind}, label=${row.label ?? "none"}, existingUserFlow=${row.existingUserFlow}`, () => {
      const plan = classifyOwnerAction(row.s);
      assert.equal(plan.kind, row.kind, `${row.id} classifier kind`);

      const view = buildOwnerStatusView(row.s);
      if (row.label === null) {
        assert.equal(view.action, null, `${row.id} must offer no action`);
      } else {
        assert.equal(view.action?.label, row.label, `${row.id} action label`);
      }

      assert.equal(
        isExistingUserActionKind(plan.kind),
        row.existingUserFlow,
        `${row.id} must be carried by the ${row.existingUserFlow ? "existing-user" : "new-user"} flow`,
      );

      // Canonical email is locked to the RPC's own value for every action-bearing
      // state — never a browser-chosen recipient.
      if (isExistingUserActionPlan(plan)) {
        assert.equal(plan.email, "e@x.com", `${row.id} recipient must be the canonical status email`);
      }
    });
  }

  test("K MALFORMED/UNKNOWN: an unknown state fails closed (no plan, no action)", () => {
    const r = normalizeOwnerStatusResult([row({ owner_state: "REVOKED" })]);
    assert.equal(r.status, "malformed");
    // A malformed read never reaches classifyOwnerAction/buildOwnerStatusView — the
    // server maps it to "unavailable" and the pages render a generic notice, no form.
  });

  test("existing-user recipient is canonicalized (lower/trimmed), never the raw form value", () => {
    const plan = classifyOwnerAction(
      status({ state: "DELIVERY_FAILED", email: "  Owner@X.COM ", failureCode: "EXISTING_ACCOUNT", invitationKind: "NEW_USER" }),
    );
    assert.equal(plan.kind, "send-existing");
    assert.equal(plan.kind === "send-existing" && plan.email, "owner@x.com");
  });
});
