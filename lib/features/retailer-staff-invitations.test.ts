/**
 * Unit tests for the Retailer staff invitation SEND feature flag.
 *
 * Run with:  npm test
 *
 * The module reads its env vars at CALL time, so each case sets/clears the variable
 * and calls fresh. `window` is undefined under Node, so the module's browser guard does
 * not fire on import.
 *
 * The critical property is FAIL-CLOSED, EXACT match: only the literal string "true"
 * enables a feature — every near-miss spelling ("1", "yes", "TRUE", " true ") is
 * disabled, so a deployment typo cannot silently arm a service-role + email path, or
 * open an account-creation surface.
 *
 * Only SENDING is gated. Reading the roster, reading the invitation list, REVOKING an
 * invitation, ACCEPTING one and ACTIVATING an account from one are all deliberately
 * ungated — a kill switch must not be able to strand a recipient mid-flow.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isRetailerStaffInvitationsEnabled,
  RETAILER_STAFF_INVITATIONS_FLAG_VAR,
  RETAILER_STAFF_INVITATIONS_PAUSED_MESSAGE,
} from "./retailer-staff-invitations.ts";

const SEND_VAR = "RETAILER_STAFF_INVITATIONS_ENABLED";

const ORIGINAL_SEND = process.env[SEND_VAR];

function set(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => set(SEND_VAR, ORIGINAL_SEND));

const DISABLED_SPELLINGS = [
  "false",
  "1",
  "0",
  "yes",
  "no",
  "on",
  "off",
  "TRUE",
  "True",
  " true ",
  "true ",
  "",
];

describe("isRetailerStaffInvitationsEnabled — sending", () => {
  test('1. enabled ONLY for the exact string "true"', () => {
    set(SEND_VAR, "true");
    assert.equal(isRetailerStaffInvitationsEnabled(), true);
  });

  test("2. disabled when unset — the default posture", () => {
    set(SEND_VAR, undefined);
    assert.equal(isRetailerStaffInvitationsEnabled(), false);
  });

  for (const value of DISABLED_SPELLINGS) {
    test(`3. disabled for ${JSON.stringify(value)} (exact-match, fail-closed)`, () => {
      set(SEND_VAR, value);
      assert.equal(isRetailerStaffInvitationsEnabled(), false);
    });
  }

  test("4. reads at call time — a value change is picked up without re-import", () => {
    set(SEND_VAR, undefined);
    assert.equal(isRetailerStaffInvitationsEnabled(), false);
    set(SEND_VAR, "true");
    assert.equal(isRetailerStaffInvitationsEnabled(), true);
    set(SEND_VAR, "false");
    assert.equal(isRetailerStaffInvitationsEnabled(), false);
  });
});

describe("the flag's variable name is the documented one", () => {
  test("10. the exported name matches the environment variable it reads", () => {
    // .env.example documents this exact name; a drift here would silently disarm the
    // gate, because an unset variable reads as disabled.
    assert.equal(RETAILER_STAFF_INVITATIONS_FLAG_VAR, SEND_VAR);
  });
});

describe("the paused message is safe", () => {
  test("11. names no variable, provider, or configuration detail", () => {
    const message = RETAILER_STAFF_INVITATIONS_PAUSED_MESSAGE;
    assert.ok(message.length > 0);
    assert.ok(!message.includes(SEND_VAR));
    assert.ok(!/resend|supabase|env|service.role|api.key/i.test(message));
  });
});
