/**
 * Unit tests for the staff invitation-hash cookie's name and attributes.
 *
 * Run with:  npm test
 *
 * The cookie carries the SHA-256 token HASH — never the raw token — from the intake
 * route to the acceptance page and its Server Actions. These pin the attributes that
 * keep that hash out of client JavaScript and off cleartext transport, and that it
 * cannot collide with the Retailer Owner flow's cookie.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  STAFF_INVITE_COOKIE,
  STAFF_INVITE_COOKIE_MAX_AGE,
  STAFF_INVITE_COOKIE_PATH,
  staffInviteCookieOptions,
} from "./staff-invite-cookie-options.ts";
import { EXISTING_USER_INVITE_COOKIE } from "../invitations/existing-user-cookie-options.ts";

// Next.js augments `process.env.NODE_ENV` to a read-only literal type, so it is
// mutated here through a mutable-record view — the runtime object is the same. Same
// approach as lib/invitations/existing-user-cookie-options.test.ts.
const mutableEnv = process.env as Record<string, string | undefined>;
const ORIGINAL_NODE_ENV = mutableEnv.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = value;
}

afterEach(() => setNodeEnv(ORIGINAL_NODE_ENV));

describe("staff invitation cookie", () => {
  test("1. is httpOnly and SameSite=Lax", () => {
    const options = staffInviteCookieOptions();
    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, "lax");
  });

  test("2. is path-scoped to the staff acceptance routes only", () => {
    assert.equal(STAFF_INVITE_COOKIE_PATH, "/invitations/staff");
    assert.equal(staffInviteCookieOptions().path, STAFF_INVITE_COOKIE_PATH);
  });

  test("3. expires well inside the 24-hour invitation window", () => {
    assert.equal(STAFF_INVITE_COOKIE_MAX_AGE, 60 * 60);
    assert.ok(STAFF_INVITE_COOKIE_MAX_AGE < 24 * 60 * 60);
    assert.equal(staffInviteCookieOptions().maxAge, STAFF_INVITE_COOKIE_MAX_AGE);
  });

  test("4. is Secure in production and read at call time, not captured", () => {
    setNodeEnv("production");
    assert.equal(staffInviteCookieOptions().secure, true);
    setNodeEnv("development");
    assert.equal(staffInviteCookieOptions().secure, false);
    setNodeEnv(undefined);
    assert.equal(staffInviteCookieOptions().secure, false);
  });

  test("5. cannot collide with the Retailer Owner invitation cookie", () => {
    // A person holding both an owner and a staff invitation must not have one silently
    // overwrite the other.
    assert.notEqual(STAFF_INVITE_COOKIE, EXISTING_USER_INVITE_COOKIE);
  });

  test("6. the name is a short opaque identifier that embeds no secret material", () => {
    // It describes WHAT it holds (an invitation hash), exactly as the owner flow's
    // `ru_eu_inv_hash` does, and carries no token, key, email, or id of its own.
    assert.match(STAFF_INVITE_COOKIE, /^[a-z0-9_]{1,32}$/);
    assert.ok(!/token|secret|key|mail|@/i.test(STAFF_INVITE_COOKIE));
  });
});
