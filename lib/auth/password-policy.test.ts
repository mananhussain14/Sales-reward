/**
 * Unit tests for the shared password policy.
 *
 * Run with:  npm test
 *
 * The critical property is that ONE constant governs everything: the length the Server
 * Actions require, the `minLength` the browser enforces, the hint the forms render, and
 * auth.minimum_password_length in supabase/config.toml. These tests pin the value at 6
 * and pin the behaviour of the shared validator.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_HINT,
  validatePassword,
} from "./password-policy.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("the policy constants", () => {
  test("1. the minimum is 6 — matching Supabase, not stricter, not looser", () => {
    assert.equal(MIN_PASSWORD_LENGTH, 6);
  });

  test("2. supabase/config.toml sets the same minimum", () => {
    // If these ever disagree, one of them is lying to the user: either we reject
    // passwords Auth would accept, or we promise a floor Auth does not enforce.
    const config = readFileSync(join(ROOT, "supabase/config.toml"), "utf8");
    const match = /^minimum_password_length\s*=\s*(\d+)\s*$/m.exec(config);
    assert.ok(match, "minimum_password_length not found in supabase/config.toml");
    assert.equal(
      Number(match[1]),
      MIN_PASSWORD_LENGTH,
      "supabase/config.toml and MIN_PASSWORD_LENGTH disagree",
    );
  });

  test("3. the upper bound is bcrypt's 72-byte truncation point", () => {
    assert.equal(MAX_PASSWORD_LENGTH, 72);
  });

  test("4. the hint is generated from the constant, so it cannot drift", () => {
    assert.ok(PASSWORD_HINT.includes(String(MIN_PASSWORD_LENGTH)));
  });
});

describe("validatePassword — length", () => {
  test("5. accepts exactly the minimum", () => {
    assert.deepEqual(validatePassword("a".repeat(MIN_PASSWORD_LENGTH)), { ok: true });
  });

  test("6. rejects one character under the minimum", () => {
    const result = validatePassword("a".repeat(MIN_PASSWORD_LENGTH - 1));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "too-short");
  });

  test("7. accepts exactly the maximum and rejects one over", () => {
    assert.deepEqual(validatePassword("a".repeat(MAX_PASSWORD_LENGTH)), { ok: true });
    const result = validatePassword("a".repeat(MAX_PASSWORD_LENGTH + 1));
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "too-long");
  });

  test("8. a non-string is treated as empty, never coerced", () => {
    for (const value of [null, undefined, 123456, {}, []]) {
      const result = validatePassword(value);
      assert.equal(result.ok, false, JSON.stringify(value));
      if (result.ok) return;
      assert.equal(result.reason, "too-short");
    }
  });
});

describe("validatePassword — confirmation", () => {
  test("9. matching passwords pass", () => {
    assert.deepEqual(validatePassword("hunter2!", "hunter2!"), { ok: true });
  });

  test("10. a mismatch is rejected", () => {
    const result = validatePassword("hunter2!", "hunter3!");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "mismatch");
  });

  test("11. length is reported before the match, so a short pair says 'too short'", () => {
    // Someone who typed the same too-short password twice needs the useful message.
    const result = validatePassword("abc", "abc");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "too-short");
  });

  test("12. omitting the confirmation skips only the match check", () => {
    assert.deepEqual(validatePassword("longenough"), { ok: true });
    assert.equal(validatePassword("abc").ok, false);
  });

  test("13. a non-string confirmation cannot accidentally match", () => {
    for (const value of [null, 0, {}] as unknown[]) {
      const result = validatePassword("longenough", value);
      assert.equal(result.ok, false, JSON.stringify(value));
      if (result.ok) return;
      assert.equal(result.reason, "mismatch");
    }
  });
});

describe("messages are safe", () => {
  test("14. no message echoes the password or its length back", () => {
    const secret = "correct horse battery staple";
    const rejections = [
      validatePassword(secret.slice(0, 3)),
      validatePassword("a".repeat(MAX_PASSWORD_LENGTH + 1)),
      validatePassword(secret, `${secret}x`),
    ];

    for (const result of rejections) {
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.ok(!result.message.includes(secret.slice(0, 3)), result.message);
      assert.ok(!result.message.includes("horse"), result.message);
      assert.ok(!result.message.includes(secret), result.message);
    }
  });

  test("15. every rejection carries a reason and a message, and nothing else", () => {
    const result = validatePassword("x");
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(Object.keys(result).sort(), ["message", "ok", "reason"]);
  });
});
