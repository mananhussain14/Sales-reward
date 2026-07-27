/**
 * Unit tests for the staff account-state model.
 *
 * Run with:  npm test
 *
 * This is the file that decides which screen an invited person sees and, more
 * importantly, WHICH OF THEM MAY SET A PASSWORD. The shipped design asked one question
 * ("does an auth.users row exist?") and dead-ended anyone whose row could not be signed
 * in to. The five states fix that, and the tests below pin the property that makes the
 * fix safe rather than merely convenient:
 *
 *   RECOVERY_REQUIRED must NEVER admit first-password activation.
 *
 * That state means the row already carries a password or a provisioned identity — a
 * profile, a membership, a role assignment — which for an address invited through the
 * Retailer Owner flow is a half-built RETAILER_OWNER identity. Letting a STAFF
 * invitation token set its first password would convert that token from a discovery
 * pointer into an account credential.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  allowsFirstPasswordActivation,
  allowsPasswordRecovery,
  isStaffAccountState,
  STAFF_ACCOUNT_STATES,
  staffRegistrationViewFor,
  type StaffAccountState,
} from "./staff-account-state.ts";

describe("the state vocabulary is closed", () => {
  test("1. exactly five states are declared", () => {
    assert.deepEqual([...STAFF_ACCOUNT_STATES], [
      "NO_ACCOUNT",
      "ACTIVATION_REQUIRED",
      "SIGN_IN",
      "RECOVERY_REQUIRED",
      "ACCOUNT_BLOCKED",
    ]);
  });

  test("2. isStaffAccountState accepts exactly those and nothing else", () => {
    for (const state of STAFF_ACCOUNT_STATES) {
      assert.equal(isStaffAccountState(state), true, state);
    }
    for (const value of [
      "no_account",
      "SIGN_IN ",
      "",
      "HAS_AUTH_ACCOUNT",
      "true",
      null,
      undefined,
      1,
      {},
      ["SIGN_IN"],
    ]) {
      assert.equal(isStaffAccountState(value), false, JSON.stringify(value ?? null));
    }
  });
});

describe("state → screen", () => {
  const EXPECTED: [StaffAccountState, string][] = [
    ["NO_ACCOUNT", "register"],
    ["ACTIVATION_REQUIRED", "register"],
    ["SIGN_IN", "sign-in"],
    ["RECOVERY_REQUIRED", "recover"],
    ["ACCOUNT_BLOCKED", "blocked"],
  ];

  for (const [index, [state, view]] of EXPECTED.entries()) {
    test(`${3 + index}. ${state} renders the ${view} screen`, () => {
      assert.equal(staffRegistrationViewFor(state), view);
    });
  }

  test("8. every declared state maps to a screen — none falls through", () => {
    for (const state of STAFF_ACCOUNT_STATES) {
      assert.notEqual(
        staffRegistrationViewFor(state),
        "unavailable",
        `${state} has no screen`,
      );
    }
  });

  test("9. an unrecognized value collapses to 'unavailable', never to a form", () => {
    // A future state this build predates, a malformed row, a null. Failing toward
    // "show nothing" is safe; failing toward "offer activation" would not be.
    for (const value of [
      "FUTURE_STATE",
      "sign_in",
      "",
      null,
      undefined,
      0,
      {},
      true,
    ]) {
      assert.equal(
        staffRegistrationViewFor(value),
        "unavailable",
        JSON.stringify(value ?? null),
      );
    }
  });

  test("10. exactly two states reach the password form", () => {
    const registering = STAFF_ACCOUNT_STATES.filter(
      (state) => staffRegistrationViewFor(state) === "register",
    );
    assert.deepEqual([...registering], ["NO_ACCOUNT", "ACTIVATION_REQUIRED"]);
  });
});

describe("first-password activation is admitted for exactly two states", () => {
  test("11. NO_ACCOUNT and ACTIVATION_REQUIRED are allowed", () => {
    assert.equal(allowsFirstPasswordActivation("NO_ACCOUNT"), true);
    assert.equal(allowsFirstPasswordActivation("ACTIVATION_REQUIRED"), true);
  });

  test("12. RECOVERY_REQUIRED is REFUSED — the security property of this milestone", () => {
    // If this ever passes, a staff invitation token can set the first password on an
    // account that already stands for a provisioned identity.
    assert.equal(allowsFirstPasswordActivation("RECOVERY_REQUIRED"), false);
  });

  test("13. SIGN_IN and ACCOUNT_BLOCKED are refused", () => {
    assert.equal(allowsFirstPasswordActivation("SIGN_IN"), false);
    assert.equal(allowsFirstPasswordActivation("ACCOUNT_BLOCKED"), false);
  });

  test("14. nothing outside the vocabulary is admitted", () => {
    for (const value of [
      "FUTURE_STATE",
      "no_account",
      "ACTIVATION_REQUIRED ",
      "",
      null,
      undefined,
      true,
      1,
      {},
    ]) {
      assert.equal(
        allowsFirstPasswordActivation(value),
        false,
        JSON.stringify(value ?? null),
      );
    }
  });

  test("15. the screen and the permission agree, state by state", () => {
    // A state that renders the password form must be allowed to use it, and one that
    // does not must not be. A mismatch either way is a bug: a form that cannot submit,
    // or a permission with no screen behind it that a forged POST could still reach.
    for (const state of STAFF_ACCOUNT_STATES) {
      assert.equal(
        staffRegistrationViewFor(state) === "register",
        allowsFirstPasswordActivation(state),
        `${state} disagrees between screen and permission`,
      );
    }
  });
});

describe("password recovery is admitted for exactly one state", () => {
  test("16. only RECOVERY_REQUIRED may request a recovery email", () => {
    assert.equal(allowsPasswordRecovery("RECOVERY_REQUIRED"), true);
    for (const state of STAFF_ACCOUNT_STATES) {
      if (state === "RECOVERY_REQUIRED") continue;
      assert.equal(allowsPasswordRecovery(state), false, state);
    }
  });

  test("17. SIGN_IN may NOT — a usable account has the ordinary sign-in path", () => {
    // Otherwise an invitation token becomes a way to send unsolicited reset mail to a
    // working account, and a forwarded token becomes a nudge to reset a password that
    // did not need resetting.
    assert.equal(allowsPasswordRecovery("SIGN_IN"), false);
  });

  test("18. nothing outside the vocabulary is admitted", () => {
    for (const value of ["RECOVERY", "recovery_required", "", null, undefined, {}, 1]) {
      assert.equal(allowsPasswordRecovery(value), false, JSON.stringify(value ?? null));
    }
  });

  test("19. the two permissions are mutually exclusive for every state", () => {
    // No state may both set a password directly and request recovery: that would be a
    // path where the token-holder could choose the weaker proof.
    for (const state of STAFF_ACCOUNT_STATES) {
      assert.ok(
        !(allowsFirstPasswordActivation(state) && allowsPasswordRecovery(state)),
        `${state} admits both activation and recovery`,
      );
    }
  });

  test("20. the recovery screen and the recovery permission agree", () => {
    for (const state of STAFF_ACCOUNT_STATES) {
      assert.equal(
        staffRegistrationViewFor(state) === "recover",
        allowsPasswordRecovery(state),
        `${state} disagrees between screen and permission`,
      );
    }
  });
});
