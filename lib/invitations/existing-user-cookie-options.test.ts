/**
 * Unit tests for the existing-user invitation-hash cookie NAME and ATTRIBUTES.
 *
 * Run with:  npm test
 *
 * Node's built-in runner (node:test) + assert, no package added. This pure module has
 * no `next/headers` import, so it loads under `node --experimental-strip-types`
 * (which cannot resolve `next/headers`) — that is the whole reason the attributes are
 * split out from ./existing-user-cookie.ts.
 *
 * These pin the security-critical cookie shape: HttpOnly (invisible to client JS),
 * SameSite=Lax, Secure ONLY outside development, scoped to the acceptance path, and an
 * expiry well inside the 24-hour invitation window. The name is a stable constant.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  EXISTING_USER_INVITE_COOKIE,
  EXISTING_USER_INVITE_COOKIE_PATH,
  EXISTING_USER_INVITE_COOKIE_MAX_AGE,
  existingUserInviteCookieOptions,
} from "./existing-user-cookie-options.ts";

// Next.js augments `process.env.NODE_ENV` to a read-only literal type, so it is
// mutated here through a mutable-record view — the runtime object is the same.
const mutableEnv = process.env as Record<string, string | undefined>;
const ORIGINAL_NODE_ENV = mutableEnv.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) delete mutableEnv.NODE_ENV;
  else mutableEnv.NODE_ENV = value;
}

afterEach(() => setNodeEnv(ORIGINAL_NODE_ENV));

describe("existing-user invite cookie — name and path", () => {
  test("the name is a stable, opaque constant", () => {
    assert.equal(EXISTING_USER_INVITE_COOKIE, "ru_eu_inv_hash");
  });

  test("the path is scoped to the acceptance route", () => {
    assert.equal(EXISTING_USER_INVITE_COOKIE_PATH, "/invitations/existing");
  });

  test("max-age is one hour, well inside the 24h invitation window", () => {
    assert.equal(EXISTING_USER_INVITE_COOKIE_MAX_AGE, 3600);
    assert.ok(EXISTING_USER_INVITE_COOKIE_MAX_AGE <= 24 * 60 * 60);
  });
});

describe("existingUserInviteCookieOptions — attributes", () => {
  test("HttpOnly and SameSite=Lax are always set", () => {
    setNodeEnv("production");
    const opts = existingUserInviteCookieOptions();
    assert.equal(opts.httpOnly, true);
    assert.equal(opts.sameSite, "lax");
    assert.equal(opts.path, "/invitations/existing");
    assert.equal(opts.maxAge, 3600);
  });

  test("Secure is TRUE in production", () => {
    setNodeEnv("production");
    assert.equal(existingUserInviteCookieOptions().secure, true);
  });

  test("Secure is FALSE in development", () => {
    setNodeEnv("development");
    assert.equal(existingUserInviteCookieOptions().secure, false);
  });

  test("Secure is FALSE when NODE_ENV is unset (fail-open only for local, never a real host)", () => {
    setNodeEnv(undefined);
    assert.equal(existingUserInviteCookieOptions().secure, false);
  });

  test("secure is read at call time (production picked up without re-import)", () => {
    setNodeEnv("development");
    assert.equal(existingUserInviteCookieOptions().secure, false);
    setNodeEnv("production");
    assert.equal(existingUserInviteCookieOptions().secure, true);
  });

  test("the options carry NO token, hash, email or id — only cookie attributes", () => {
    setNodeEnv("production");
    assert.deepEqual(Object.keys(existingUserInviteCookieOptions()).sort(), [
      "httpOnly",
      "maxAge",
      "path",
      "sameSite",
      "secure",
    ]);
  });
});
