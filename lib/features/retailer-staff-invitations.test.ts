/**
 * Unit tests for the two Retailer staff invitation feature flags.
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
 * The two flags must also be INDEPENDENT: sending invitations and allowing an invited
 * person to self-register are separate decisions with separate blast radii, and
 * enabling one must never enable the other.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isRetailerStaffInvitationsEnabled,
  isRetailerStaffRegistrationEnabled,
  RETAILER_STAFF_INVITATIONS_FLAG_VAR,
  RETAILER_STAFF_REGISTRATION_FLAG_VAR,
  RETAILER_STAFF_INVITATIONS_PAUSED_MESSAGE,
} from "./retailer-staff-invitations.ts";

const SEND_VAR = "RETAILER_STAFF_INVITATIONS_ENABLED";
const REGISTER_VAR = "RETAILER_STAFF_REGISTRATION_ENABLED";

const ORIGINAL_SEND = process.env[SEND_VAR];
const ORIGINAL_REGISTER = process.env[REGISTER_VAR];

function set(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  set(SEND_VAR, ORIGINAL_SEND);
  set(REGISTER_VAR, ORIGINAL_REGISTER);
});

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

describe("isRetailerStaffRegistrationEnabled — new-user registration", () => {
  test('5. enabled ONLY for the exact string "true"', () => {
    set(REGISTER_VAR, "true");
    assert.equal(isRetailerStaffRegistrationEnabled(), true);
  });

  test("6. disabled when unset — the default, and the current deployment state", () => {
    // The hosted project has disable_signup=true, so this must default OFF: the page
    // then offers sign-in only rather than a button Auth would refuse.
    set(REGISTER_VAR, undefined);
    assert.equal(isRetailerStaffRegistrationEnabled(), false);
  });

  for (const value of DISABLED_SPELLINGS) {
    test(`7. disabled for ${JSON.stringify(value)} (exact-match, fail-closed)`, () => {
      set(REGISTER_VAR, value);
      assert.equal(isRetailerStaffRegistrationEnabled(), false);
    });
  }
});

describe("the two flags are independent", () => {
  test("8. enabling sending does NOT enable registration", () => {
    set(SEND_VAR, "true");
    set(REGISTER_VAR, undefined);
    assert.equal(isRetailerStaffInvitationsEnabled(), true);
    assert.equal(isRetailerStaffRegistrationEnabled(), false);
  });

  test("9. enabling registration does NOT enable sending", () => {
    set(SEND_VAR, undefined);
    set(REGISTER_VAR, "true");
    assert.equal(isRetailerStaffInvitationsEnabled(), false);
    assert.equal(isRetailerStaffRegistrationEnabled(), true);
  });

  test("10. the two variable names are distinct and are the ones documented", () => {
    assert.equal(RETAILER_STAFF_INVITATIONS_FLAG_VAR, SEND_VAR);
    assert.equal(RETAILER_STAFF_REGISTRATION_FLAG_VAR, REGISTER_VAR);
    assert.notEqual(
      RETAILER_STAFF_INVITATIONS_FLAG_VAR,
      RETAILER_STAFF_REGISTRATION_FLAG_VAR,
    );
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
