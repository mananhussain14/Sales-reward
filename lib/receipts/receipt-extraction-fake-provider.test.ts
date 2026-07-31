/**
 * Unit tests for the fake extraction provider and its fixtures.
 *
 * Run with:  npm test
 *
 * EVERY FIXTURE IS EXERCISED THROUGH AN INJECTED PROVIDER — no image bytes are crafted, no
 * SHA-256 is ground out to land in a chosen bucket, and no environment variable is read.
 * Grinding hashes to steer a test is slow, opaque, and couples the test to the very parser it
 * is meant to exercise.
 *
 * The two properties that matter most here are that the fake makes NO EXTERNAL CALL, and that
 * its outcome cannot be chosen by anything a client controls.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAKE_FIXTURES,
  FAKE_FIXTURE_KEYS,
  buildFixtureExtraction,
  isFakeFixtureKey,
} from "./receipt-extraction-fake-fixtures.ts";
import {
  buildFakeOperationId,
  createFakeProviderForKey,
  isFakeOperationId,
  resolveFakeFixtureKey,
} from "./receipt-extraction-fake-provider.ts";
import {
  EXTRACTION_WARNING_CODES,
  FAKE_PROVIDER_MODEL,
  FAKE_PROVIDER_NAME,
  MAX_MINOR_AMOUNT,
} from "./receipt-extraction-vocabulary.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function providerFor(key: (typeof FAKE_FIXTURE_KEYS)[number], pendingMs = 0) {
  return createFakeProviderForKey(key, pendingMs, () => UUID);
}

describe("the eight fixtures", () => {
  test("exactly eight, and the keys match the map", () => {
    assert.equal(FAKE_FIXTURE_KEYS.length, 8);
    assert.deepEqual([...FAKE_FIXTURE_KEYS].sort(), Object.keys(FAKE_FIXTURES).sort());
    for (const key of FAKE_FIXTURE_KEYS) assert.equal(FAKE_FIXTURES[key].key, key);
  });

  test("exactly one fixture reports a provider failure", () => {
    const failing = FAKE_FIXTURE_KEYS.filter((key) => FAKE_FIXTURES[key].failureCode !== null);
    assert.deepEqual(failing, ["REJECTED_DOCUMENT"]);
  });

  test("every warning a fixture derives is in the closed set", () => {
    for (const key of FAKE_FIXTURE_KEYS) {
      const { normalized } = buildFixtureExtraction(FAKE_FIXTURES[key]);
      for (const warning of normalized.warningCodes) {
        assert.ok(
          (EXTRACTION_WARNING_CODES as readonly string[]).includes(warning),
          `${key} produced ${warning}`,
        );
      }
    }
  });

  test("every amount a fixture produces is within the stored bounds", () => {
    for (const key of FAKE_FIXTURE_KEYS) {
      const { normalized, lineItems } = buildFixtureExtraction(FAKE_FIXTURES[key]);
      for (const amount of [normalized.total, normalized.subtotal, normalized.taxTotal]) {
        if (amount.minor === null) continue;
        assert.ok(Number.isSafeInteger(amount.minor) && amount.minor >= 0, key);
        assert.ok(amount.minor <= MAX_MINOR_AMOUNT, key);
      }
      for (const item of lineItems) {
        assert.ok(item.lineNumber >= 1);
      }
    }
  });

  test("the minor-unit classes the schema admits are covered", () => {
    const units = new Set(FAKE_FIXTURE_KEYS.map((key) => FAKE_FIXTURES[key].minorUnit));
    assert.ok(units.has(0), "no zero-minor fixture");
    assert.ok(units.has(2), "no two-minor fixture");
    assert.ok(units.has(3), "no three-minor fixture");
  });
});

describe("the fixture amounts parse to the intended values", () => {
  test("AED, two minor units", () => {
    const { normalized } = buildFixtureExtraction(FAKE_FIXTURES.CLEAN_AED_2);
    assert.equal(normalized.total.minor, 123456);
    assert.equal(normalized.subtotal.minor, 117600);
    assert.equal(normalized.taxTotal.minor, 5856);
    assert.equal(normalized.currencyCode.value, "AED");
  });

  test("JPY, zero minor units — grouping is not a decimal", () => {
    const { normalized } = buildFixtureExtraction(FAKE_FIXTURES.JPY_0_MINOR);
    assert.equal(normalized.total.minor, 12480);
  });

  test("KWD, three minor units — 12.500 is twelve and a half dinars", () => {
    const { normalized } = buildFixtureExtraction(FAKE_FIXTURES.KWD_3_MINOR);
    assert.equal(normalized.total.minor, 12500);
  });

  test("EUR, comma decimal and narrow-space grouping", () => {
    const { normalized } = buildFixtureExtraction(FAKE_FIXTURES.EUR_DECIMAL_COMMA);
    assert.equal(normalized.total.minor, 128490);
    assert.equal(normalized.subtotal.minor, 107075);
  });

  test("a missing merchant is warned, never invented", () => {
    const { normalized } = buildFixtureExtraction(FAKE_FIXTURES.MISSING_MERCHANT);
    assert.equal(normalized.merchantName.value, null);
    assert.ok(normalized.warningCodes.includes("MISSING_MERCHANT_NAME"));
  });

  test("a rounding mismatch is warned and NOT corrected", () => {
    const { normalized } = buildFixtureExtraction(FAKE_FIXTURES.ROUNDING_MISMATCH);
    assert.equal(normalized.subtotal.minor, 10000);
    assert.equal(normalized.taxTotal.minor, 500);
    assert.equal(normalized.total.minor, 10501); // NOT 10500
    assert.ok(normalized.warningCodes.includes("SUBTOTAL_TAX_TOTAL_MISMATCH"));
  });
});

describe("the asynchronous shape", () => {
  test("submit returns an operation id and no result", async () => {
    const provider = providerFor("CLEAN_AED_2");
    const result = await provider.submit({ bytes: BYTES, mimeType: "image/jpeg" });
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.providerOperationId, `fake:${UUID}`);
      assert.ok(isFakeOperationId(result.providerOperationId));
    }
  });

  test("poll reports PENDING until the configured period has elapsed", async () => {
    const provider = providerFor("CLEAN_AED_2", 1500);
    const pending = await provider.poll({
      providerOperationId: `fake:${UUID}`,
      startedAtMs: 1_000,
      nowMs: 1_500,
    });
    assert.equal(pending.status, "pending");

    const done = await provider.poll({
      providerOperationId: `fake:${UUID}`,
      startedAtMs: 1_000,
      nowMs: 3_000,
    });
    assert.equal(done.status, "succeeded");
  });

  test("time is an INPUT, so the test never sleeps", async () => {
    const provider = providerFor("CLEAN_AED_2", 60_000);
    const result = await provider.poll({
      providerOperationId: `fake:${UUID}`,
      startedAtMs: 0,
      nowMs: 60_000,
    });
    assert.equal(result.status, "succeeded");
  });

  test("the failing fixture fails at POLL, not at submit", async () => {
    const provider = providerFor("REJECTED_DOCUMENT");
    const submitted = await provider.submit({ bytes: BYTES, mimeType: "image/jpeg" });
    assert.equal(submitted.status, "ok"); // an operation exists: the POST-provider shape

    const polled = await provider.poll({
      providerOperationId: `fake:${UUID}`,
      startedAtMs: 0,
      nowMs: 1,
    });
    assert.equal(polled.status, "failed");
    if (polled.status === "failed") {
      assert.equal(polled.failureCode, "PROVIDER_REJECTED_DOCUMENT");
    }
  });

  test("empty bytes are a pre-provider failure", async () => {
    const provider = providerFor("CLEAN_AED_2");
    const result = await provider.submit({ bytes: new Uint8Array(), mimeType: "image/jpeg" });
    assert.equal(result.status, "failed");
    if (result.status === "failed") assert.equal(result.failureCode, "OBJECT_UNREADABLE");
  });

  test("the provider reports the locked name and model", () => {
    const provider = providerFor("CLEAN_AED_2");
    assert.equal(provider.name, FAKE_PROVIDER_NAME);
    assert.equal(provider.model, FAKE_PROVIDER_MODEL);
  });
});

describe("fixture selection is server-controlled and fails closed", () => {
  test("a named fixture wins", () => {
    const result = resolveFakeFixtureKey({ fixtureEnv: "KWD_3_MINOR", fileSha256: "a".repeat(64) });
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.key, "KWD_3_MINOR");
  });

  test("an unknown key FAILS CLOSED and does not fall back to the hash bucket", () => {
    const result = resolveFakeFixtureKey({ fixtureEnv: "NOPE", fileSha256: "a".repeat(64) });
    assert.equal(result.status, "unknown-fixture");
  });

  test("a typo in a deployment variable stops the function rather than silently selecting", () => {
    for (const value of ["clean_aed_2", "CLEAN_AED", "CLEAN_AED_2 ", ""]) {
      const result = resolveFakeFixtureKey({ fixtureEnv: value, fileSha256: "" });
      if (value.trim() === "") {
        assert.equal(result.status, "ok"); // unset means "use the bucket"
      } else if (value.trim() === "CLEAN_AED_2") {
        assert.equal(result.status, "ok");
      } else {
        assert.equal(result.status, "unknown-fixture", value);
      }
    }
  });

  test("the hash bucket is deterministic", () => {
    for (let i = 0; i < 500; i += 1) {
      const hash = i.toString(16).padStart(64, "0");
      const a = resolveFakeFixtureKey({ fixtureEnv: undefined, fileSha256: hash });
      const b = resolveFakeFixtureKey({ fixtureEnv: undefined, fileSha256: hash });
      assert.deepEqual(a, b);
    }
  });

  test("the bucket only ever selects a KNOWN fixture", () => {
    for (let i = 0; i < 256; i += 1) {
      const hash = i.toString(16).padStart(2, "0").repeat(32);
      const result = resolveFakeFixtureKey({ fixtureEnv: undefined, fileSha256: hash });
      assert.equal(result.status, "ok");
      if (result.status === "ok") assert.ok(isFakeFixtureKey(result.key));
    }
  });

  test("no client-shaped input can select a fixture", () => {
    // The only two inputs are a server env var and a server-computed hash. Anything a client
    // could send is not a parameter of this function at all — asserted structurally below.
    assert.equal(resolveFakeFixtureKey.length, 1);
  });
});

describe("operation ids", () => {
  test("the prefix makes a fake operation unmistakable", () => {
    assert.equal(buildFakeOperationId(UUID), `fake:${UUID}`);
    assert.ok(isFakeOperationId(`fake:${UUID}`));
  });

  test("anything else is not a fake operation id", () => {
    for (const value of [UUID, `real:${UUID}`, "fake:", "", null, 42, "fake:not-a-uuid"]) {
      assert.equal(isFakeOperationId(value), false, String(value));
    }
  });
});

describe("the fake makes no external call", () => {
  const SOURCES = [
    "lib/receipts/receipt-extraction-fake-provider.ts",
    "lib/receipts/receipt-extraction-fake-fixtures.ts",
  ].map((path) => ({
    path,
    code: readFileSync(join(ROOT, path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, ""),
  }));

  test("no network primitive appears", () => {
    for (const { path, code } of SOURCES) {
      for (const forbidden of [
        /\bfetch\s*\(/,
        /XMLHttpRequest/,
        /WebSocket/,
        /https?:\/\//,
        /node:https?/,
        /Deno\.connect/,
      ]) {
        assert.ok(!forbidden.test(code), `${path} contains ${forbidden}`);
      }
    }
  });

  test("no environment is read inside the provider itself", () => {
    for (const { path, code } of SOURCES) {
      assert.ok(!/Deno\.env/.test(code), `${path} reads Deno.env`);
      assert.ok(!/process\.env/.test(code), `${path} reads process.env`);
    }
  });

  test("no credential-shaped identifier appears", () => {
    for (const { path, code } of SOURCES) {
      for (const forbidden of [/api[_-]?key/i, /secret/i, /endpoint/i, /subscription/i]) {
        assert.ok(!forbidden.test(code), `${path} matches ${forbidden}`);
      }
    }
  });
});
