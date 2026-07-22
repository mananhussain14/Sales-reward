/**
 * Unit tests for the existing-user invitation token generator/hasher.
 *
 * Run with:  npm test
 *
 * Node's built-in runner (node:test) + assert, no package added. The `.ts` import
 * extension is required by Node's ESM resolver and permitted by
 * allowImportingTsExtensions.
 *
 * These pin the security-critical properties: the stored value is ALWAYS the
 * SHA-256 of the raw token as 64 lowercase hex, generation is cryptographically
 * random (fresh every call), and incoming-token/hash shape checks fail closed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  generateInvitationToken,
  hashInvitationToken,
  isValidRawToken,
  isValidTokenHash,
  TOKEN_HASH_PATTERN,
  RAW_TOKEN_PATTERN,
} from "./existing-user-token.ts";

describe("hashInvitationToken", () => {
  test("is SHA-256(raw) as 64 lowercase hex", () => {
    const raw = "example-raw-token";
    const expected = createHash("sha256").update(raw, "utf8").digest("hex");
    const actual = hashInvitationToken(raw);
    assert.equal(actual, expected);
    assert.match(actual, TOKEN_HASH_PATTERN);
    assert.equal(actual, actual.toLowerCase());
    assert.equal(actual.length, 64);
  });

  test("is deterministic for the same input", () => {
    assert.equal(hashInvitationToken("abc"), hashInvitationToken("abc"));
  });

  test("differs for different inputs", () => {
    assert.notEqual(hashInvitationToken("abc"), hashInvitationToken("abd"));
  });
});

describe("generateInvitationToken", () => {
  test("returns a URL-safe raw token whose hash matches", () => {
    const { rawToken, tokenHash } = generateInvitationToken();
    assert.match(rawToken, RAW_TOKEN_PATTERN);
    assert.ok(isValidRawToken(rawToken));
    assert.equal(tokenHash, hashInvitationToken(rawToken));
    assert.match(tokenHash, TOKEN_HASH_PATTERN);
  });

  test("produces a fresh, unique token every call (not Math.random-degenerate)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const { rawToken } = generateInvitationToken();
      assert.ok(!seen.has(rawToken), "token collision — randomness is broken");
      seen.add(rawToken);
    }
  });

  test("raw token has at least 256 bits of entropy (>= 43 base64url chars)", () => {
    const { rawToken } = generateInvitationToken();
    assert.ok(rawToken.length >= 43);
  });
});

describe("isValidRawToken — fails closed", () => {
  test("accepts a well-formed base64url token", () => {
    assert.ok(isValidRawToken("A".repeat(43)));
  });
  const bad: unknown[] = [
    null,
    undefined,
    123,
    "",
    "short",
    "A".repeat(42), // one char under the 43 minimum
    "has spaces here aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "has/slash/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "A".repeat(513), // over the 512 cap
  ];
  for (const value of bad) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      assert.equal(isValidRawToken(value), false);
    });
  }
});

describe("isValidTokenHash — fails closed", () => {
  test("accepts 64 lowercase hex", () => {
    assert.ok(isValidTokenHash("a".repeat(64)));
    assert.ok(isValidTokenHash(hashInvitationToken("x")));
  });
  const bad: unknown[] = [
    null,
    undefined,
    123,
    "",
    "A".repeat(64), // uppercase not allowed
    "a".repeat(63), // too short
    "a".repeat(65), // too long
    "g".repeat(64), // non-hex
    "z".repeat(64),
  ];
  for (const value of bad) {
    test(`rejects ${JSON.stringify(value)}`, () => {
      assert.equal(isValidTokenHash(value), false);
    });
  }
});
