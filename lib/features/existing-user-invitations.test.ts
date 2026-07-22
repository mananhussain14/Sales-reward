/**
 * Unit tests for the existing-user invitation feature flag.
 *
 * Run with:  npm test
 *
 * Node's built-in runner (node:test) + assert, no package added. The module reads its
 * env var at CALL time, so each case sets/clears the variable and calls fresh. The
 * `.ts` import extension is required by Node's ESM resolver; the module has no `@/`
 * alias imports so it loads under `node --experimental-strip-types`. `window` is
 * undefined under Node, so the module's browser guard does not fire on import.
 *
 * The critical property is FAIL-CLOSED, EXACT match: only the literal string "true"
 * enables the feature — every near-miss spelling ("1", "yes", "TRUE", " true ") is
 * disabled, so a deployment typo cannot silently arm a service-role + email path.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isExistingUserInvitationsEnabled,
  RETAILER_OWNER_EXISTING_USER_INVITATIONS_FLAG_VAR,
  EXISTING_USER_INVITATIONS_PAUSED_MESSAGE,
} from "./existing-user-invitations.ts";

const VAR = "RETAILER_OWNER_EXISTING_USER_INVITATIONS_ENABLED";
const ORIGINAL = process.env[VAR];

function setFlag(value: string | undefined): void {
  if (value === undefined) delete process.env[VAR];
  else process.env[VAR] = value;
}

afterEach(() => setFlag(ORIGINAL));

describe("isExistingUserInvitationsEnabled", () => {
  test('enabled ONLY for the exact string "true"', () => {
    setFlag("true");
    assert.equal(isExistingUserInvitationsEnabled(), true);
  });

  test("disabled when unset", () => {
    setFlag(undefined);
    assert.equal(isExistingUserInvitationsEnabled(), false);
  });

  const disabledSpellings = ["false", "1", "0", "yes", "no", "on", "off", "TRUE", "True", " true ", "true ", ""];
  for (const value of disabledSpellings) {
    test(`disabled for ${JSON.stringify(value)} (exact-match, fail-closed)`, () => {
      setFlag(value);
      assert.equal(isExistingUserInvitationsEnabled(), false);
    });
  }

  test("reads at call time — a value change is picked up without re-import", () => {
    setFlag(undefined);
    assert.equal(isExistingUserInvitationsEnabled(), false);
    setFlag("true");
    assert.equal(isExistingUserInvitationsEnabled(), true);
    setFlag("false");
    assert.equal(isExistingUserInvitationsEnabled(), false);
  });
});

describe("exported metadata", () => {
  test("the flag-var name constant matches the variable actually read", () => {
    assert.equal(RETAILER_OWNER_EXISTING_USER_INVITATIONS_FLAG_VAR, VAR);
  });

  test("the paused message is a non-empty string that leaks no env/provider detail", () => {
    assert.equal(typeof EXISTING_USER_INVITATIONS_PAUSED_MESSAGE, "string");
    assert.ok(EXISTING_USER_INVITATIONS_PAUSED_MESSAGE.length > 0);
    assert.ok(!EXISTING_USER_INVITATIONS_PAUSED_MESSAGE.includes(VAR));
    assert.ok(!/resend/i.test(EXISTING_USER_INVITATIONS_PAUSED_MESSAGE));
  });
});
