/**
 * PURE MODULE — no network, no filesystem, no secret, and no Deno/Node API beyond the Web
 * Crypto UUID generator, which is itself injectable.
 *
 * THE ONLY EXTRACTION PROVIDER IN MILESTONE A.
 *
 * IT MAKES NO EXTERNAL CALL. There is no `fetch`, no `XMLHttpRequest`, no socket, no URL
 * and no credential in this file, and receipt-extraction-safety.test.ts fails the build if
 * one appears. It costs nothing to run and cannot leak a receipt to a third party.
 *
 * IT PRESERVES THE ASYNCHRONOUS PRODUCTION SHAPE. `submit` returns an operation identifier
 * without a result; `poll` reports PENDING until the configured period has elapsed and only
 * then resolves. The default period is deliberately NON-ZERO (see
 * DEFAULT_FAKE_PENDING_MS): with an instant fake, the request function would claim, submit
 * and complete in one invocation, and the PENDING branch, the PROCESSING state, the claim
 * deadline and the reaper would all be untested scaffolding.
 *
 * IT READS NO CLOCK. `poll` is given `startedAtMs` and `nowMs`. Time is an input, so a test
 * asserts the pending path by passing two numbers rather than by sleeping, and the fake is
 * deterministic under test while still behaving asynchronously in the running system.
 *
 * A CLIENT CANNOT CHOOSE ITS OUTCOME. Fixture selection happens in `resolveFakeFixtureKey`
 * below and reads exactly two things: a server-only environment variable, and the
 * server-computed SHA-256 already stored on the receipt row. No request body field, query
 * parameter, header, JWT claim, role, filename or MIME type participates, and there is no
 * code path from a request to a normalized value — the fixtures are compile-time constants.
 */

import {
  buildFixtureExtraction,
  FAKE_FIXTURES,
  FAKE_FIXTURE_KEYS,
  isFakeFixtureKey,
  type FakeFixture,
  type FakeFixtureKey,
} from "./receipt-extraction-fake-fixtures.ts";
import type {
  ExtractionPollInput,
  ExtractionPollResult,
  ExtractionSubmitInput,
  ExtractionSubmitResult,
  ReceiptExtractionProvider,
} from "./receipt-extraction-provider.ts";
import {
  FAKE_OPERATION_ID_PREFIX,
  FAKE_PROVIDER_MODEL,
  FAKE_PROVIDER_NAME,
} from "./receipt-extraction-vocabulary.ts";

export type FakeFixtureSelection =
  | { readonly status: "ok"; readonly key: FakeFixtureKey }
  /** The environment named a fixture that does not exist. FAIL CLOSED — never a fallback. */
  | { readonly status: "unknown-fixture" };

/**
 * Chooses which fixture this request will use.
 *
 * PRECEDENCE, AND WHY:
 *   1. RECEIPT_EXTRACTION_FIXTURE names an exact key. This is how integration tests pick an
 *      outcome — by setting a server-side variable, NOT by crafting an image whose hash
 *      lands in a chosen bucket. Grinding hashes to steer a test is slow, opaque, and
 *      couples the test to the parser it is meant to exercise.
 *   2. Otherwise the file's server-computed SHA-256 selects a bucket, so a local demo with
 *      several receipts shows several shapes instead of the same one repeatedly.
 *
 * AN UNKNOWN KEY IS A HARD FAILURE. It does not fall back to the hash bucket. A typo in a
 * deployment variable must stop the function, not silently select something else and make a
 * test pass against the wrong fixture.
 *
 * NEITHER INPUT IS CLIENT-CONTROLLED. `fixtureEnv` comes from `Deno.env.get`; `fileSha256`
 * is computed by the server from the bytes at reservation time and stored on
 * public.receipt_submissions, where no client can write it.
 */
export function resolveFakeFixtureKey(input: {
  readonly fixtureEnv: unknown;
  readonly fileSha256: unknown;
}): FakeFixtureSelection {
  const named = typeof input.fixtureEnv === "string" ? input.fixtureEnv.trim() : "";

  if (named.length > 0) {
    if (!isFakeFixtureKey(named)) return { status: "unknown-fixture" };
    return { status: "ok", key: named };
  }

  const hash = typeof input.fileSha256 === "string" ? input.fileSha256.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    // No usable hash: fall to the first fixture rather than failing. This branch is only
    // reachable in local development, where the mode gate is already open by deliberate act.
    return { status: "ok", key: FAKE_FIXTURE_KEYS[0] };
  }

  const bucket = Number.parseInt(hash.slice(0, 2), 16) % FAKE_FIXTURE_KEYS.length;
  return { status: "ok", key: FAKE_FIXTURE_KEYS[bucket] };
}

/** Generates a fake operation identifier. Prefixed so it can never pass for a real one. */
export function buildFakeOperationId(uuid: string): string {
  return `${FAKE_OPERATION_ID_PREFIX}${uuid}`;
}

/** True for the exact shape `fake:<uuid>`. Asserted by the safety and pgTAP suites. */
export function isFakeOperationId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^fake:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export type FakeProviderOptions = {
  /** The fixture this provider instance will report. Chosen server-side, never by a client. */
  readonly fixture: FakeFixture;
  /** How long `poll` reports PENDING before resolving. */
  readonly pendingMs: number;
  /** Injectable so tests are deterministic and the module needs no ambient crypto. */
  readonly generateUuid?: () => string;
};

function defaultUuid(): string {
  // Present in Deno and in Node 22. Guarded so the module can still be constructed in an
  // environment without it, provided the caller injects a generator.
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto?.randomUUID) return webCrypto.randomUUID();
  throw new Error("no UUID source available; inject generateUuid");
}

/**
 * Builds the fake provider.
 *
 * `submit` always succeeds. A fixture that represents a provider-side rejection reports it
 * at POLL time, which is when a real document service reports it — and which means that
 * path exercises the post-provider failure contract, where an operation id already exists
 * and must be supplied and matched exactly.
 */
export function createFakeExtractionProvider(
  options: FakeProviderOptions,
): ReceiptExtractionProvider {
  const generateUuid = options.generateUuid ?? defaultUuid;
  const pendingMs = Number.isSafeInteger(options.pendingMs) && options.pendingMs >= 0
    ? options.pendingMs
    : 0;

  return {
    name: FAKE_PROVIDER_NAME,
    model: FAKE_PROVIDER_MODEL,

    submit(input: ExtractionSubmitInput): Promise<ExtractionSubmitResult> {
      // The bytes are accepted and discarded. They are not hashed here, not stored, not
      // logged and not transmitted — a fake that retained receipt bytes would be a copy of
      // customer data with no owner and no retention rule.
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
        return Promise.resolve({ status: "failed", failureCode: "OBJECT_UNREADABLE" });
      }
      return Promise.resolve({
        status: "ok",
        providerOperationId: buildFakeOperationId(generateUuid()),
      });
    },

    poll(input: ExtractionPollInput): Promise<ExtractionPollResult> {
      const elapsed = input.nowMs - input.startedAtMs;

      if (!Number.isFinite(elapsed) || elapsed < pendingMs) {
        return Promise.resolve({ status: "pending" });
      }

      if (options.fixture.failureCode !== null) {
        return Promise.resolve({
          status: "failed",
          failureCode: options.fixture.failureCode,
        });
      }

      const built = buildFixtureExtraction(options.fixture);
      return Promise.resolve({
        status: "succeeded",
        normalized: built.normalized,
        lineItems: built.lineItems,
      });
    },
  };
}

/** Convenience for tests and the Edge Functions: build a provider from a fixture key. */
export function createFakeProviderForKey(
  key: FakeFixtureKey,
  pendingMs: number,
  generateUuid?: () => string,
): ReceiptExtractionProvider {
  return createFakeExtractionProvider({ fixture: FAKE_FIXTURES[key], pendingMs, generateUuid });
}
