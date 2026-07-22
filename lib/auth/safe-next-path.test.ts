/**
 * Unit tests for the pure login `next` open-redirect guard.
 *
 * Run with:  npm test
 *
 * Node's built-in runner (node:test) + assert, no package added — matching
 * ./landing-decision.test.ts. The `.ts` import extension is required by Node's ESM
 * resolver and permitted by allowImportingTsExtensions.
 *
 * The whole point is that a hostile `next` NEVER escapes the origin. Every case
 * below that must be rejected is a real open-redirect vector.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveSafeNextPath } from "./safe-next-path.ts";

describe("resolveSafeNextPath — accepts safe internal paths", () => {
  const safe = [
    "/",
    "/invitations/existing",
    "/retailers/123",
    "/access-denied", // a hyphen must NOT be rejected (regression guard)
    "/a/b/c",
    "/path?query=1&x=2",
    "/path#fragment",
    "/retailers/abc-def-123?ownerInvited=sent",
  ];
  for (const value of safe) {
    test(`keeps ${JSON.stringify(value)}`, () => {
      assert.equal(resolveSafeNextPath(value), value);
    });
  }
});

describe("resolveSafeNextPath — rejects open-redirect and malformed values", () => {
  const unsafe: unknown[] = [
    // Non-strings and empties.
    null,
    undefined,
    123,
    {},
    [],
    "",
    // Not an internal absolute path.
    "relative/path",
    "path",
    "#fragment-only",
    "?query-only",
    // Protocol-relative and its encodings.
    "//evil.com",
    "/%2fevil.com",
    "/%2Fevil.com",
    // Backslash tricks, raw and encoded.
    "/\\evil.com",
    "/%5cevil.com",
    "/%5Cevil.com",
    "/path\\to",
    // Schemes.
    "https://evil.com",
    "http://evil.com",
    "javascript:alert(1)",
    "/foo:bar",
    // Whitespace / control characters.
    "/pa th",
    "/path\t",
    "/path\n",
  ];
  for (const value of unsafe) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      assert.equal(resolveSafeNextPath(value), null);
    });
  }

  test("rejects an embedded NUL byte", () => {
    // Built at runtime so this source file carries no literal control byte.
    assert.equal(resolveSafeNextPath("/path" + String.fromCharCode(0)), null);
  });
});
