/**
 * Unit tests for the ordered worker sequence.
 *
 * Run with:  npm test
 *
 * These pin the ORDER, which is the thing a careless caller would get subtly wrong. The two
 * properties worth stating plainly:
 *
 *   1. THE REQUEST PATH NEVER RECORDS SUCCESS. It claims, downloads, submits and registers,
 *      and stops. If it could also complete, the PENDING branch and the whole polling path
 *      would be dead code until a genuinely asynchronous provider arrived.
 *   2. THE OPERATION IS REGISTERED BEFORE ANY COMPLETION IS POSSIBLE, so every later write
 *      can be proved against a specific provider operation.
 *
 * Every port is a stub that records its calls; no database, no network, no clock.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runExtractionPollFlow,
  runExtractionRequestFlow,
  type ClaimResult,
  type DownloadResult,
  type ExtractionPollPorts,
  type ExtractionRequestPorts,
} from "./receipt-extraction-flow.ts";
import { createFakeProviderForKey } from "./receipt-extraction-fake-provider.ts";
import type { ReceiptExtractionProvider } from "./receipt-extraction-provider.ts";

const EXTRACTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CLAIM_TOKEN = "11111111-2222-3333-4444-555555555555";
const UUID = "99999999-8888-7777-6666-555555555555";
const OPERATION_ID = `fake:${UUID}`;

function okClaim(): ClaimResult {
  return {
    status: "ok",
    claimToken: CLAIM_TOKEN,
    storageBucket: "receipts",
    storageObjectPath: "org/profile/submission/object.jpg",
    mimeType: "image/jpeg",
    attemptNumber: 1,
  };
}

function okDownload(): DownloadResult {
  return { status: "ok", bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]) };
}

type Call = { port: string; args: unknown };

function requestPorts(overrides: Partial<ExtractionRequestPorts> = {}): {
  ports: ExtractionRequestPorts;
  calls: Call[];
} {
  const calls: Call[] = [];
  const provider = createFakeProviderForKey("CLEAN_AED_2", 1500, () => UUID);

  const ports: ExtractionRequestPorts = {
    claim: async (args) => {
      calls.push({ port: "claim", args });
      return okClaim();
    },
    download: async (args) => {
      calls.push({ port: "download", args });
      return okDownload();
    },
    registerOperation: async (args) => {
      calls.push({ port: "registerOperation", args });
      return { status: "ok" };
    },
    recordFailure: async (args) => {
      calls.push({ port: "recordFailure", args });
      return { status: "ok" };
    },
    provider: {
      name: provider.name,
      model: provider.model,
      submit: async (input) => {
        calls.push({ port: "provider.submit", args: { mimeType: input.mimeType } });
        return provider.submit(input);
      },
      poll: async (input) => {
        calls.push({ port: "provider.poll", args: input });
        return provider.poll(input);
      },
    },
    ...overrides,
  };
  return { ports, calls };
}

describe("the request path", () => {
  test("the sequence is claim, download, submit, register — in that order", async () => {
    const { ports, calls } = requestPorts();
    const outcome = await runExtractionRequestFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "submitted");
    assert.deepEqual(
      calls.map((call) => call.port),
      ["claim", "download", "provider.submit", "registerOperation"],
    );
  });

  test("it NEVER records a success — there is no such port on this path", () => {
    const { ports } = requestPorts();
    assert.ok(!("recordSuccess" in ports));
  });

  test("it never polls the provider", async () => {
    const { ports, calls } = requestPorts();
    await runExtractionRequestFlow({ extractionId: EXTRACTION_ID }, ports);
    assert.ok(!calls.some((call) => call.port === "provider.poll"));
  });

  test("the registered operation is the one the provider issued", async () => {
    const { ports, calls } = requestPorts();
    await runExtractionRequestFlow({ extractionId: EXTRACTION_ID }, ports);
    const registration = calls.find((call) => call.port === "registerOperation");
    assert.deepEqual(registration?.args, {
      extractionId: EXTRACTION_ID,
      claimToken: CLAIM_TOKEN,
      providerOperationId: OPERATION_ID,
    });
  });

  test("a lost claim short-circuits WITHOUT calling the provider", async () => {
    const { ports, calls } = requestPorts({ claim: async () => ({ status: "lost" }) });
    const outcome = await runExtractionRequestFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "lost-claim");
    assert.deepEqual(calls.map((c) => c.port), []);
  });

  test("an unavailable claim writes nothing", async () => {
    const { ports, calls } = requestPorts({ claim: async () => ({ status: "unavailable" }) });
    const outcome = await runExtractionRequestFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "unavailable");
    assert.ok(!calls.some((c) => c.port === "recordFailure"));
  });

  test("a failed download records the PRE-PROVIDER failure with a NULL operation id", async () => {
    const { ports, calls } = requestPorts({ download: async () => ({ status: "failed" }) });
    const outcome = await runExtractionRequestFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "object-unreadable");
    const failure = calls.find((c) => c.port === "recordFailure");
    assert.deepEqual(failure?.args, {
      extractionId: EXTRACTION_ID,
      claimToken: CLAIM_TOKEN,
      // Null, because no operation exists yet — the shape the failure RPC's path A demands.
      providerOperationId: null,
      failureCode: "OBJECT_UNREADABLE",
    });
    assert.ok(!calls.some((c) => c.port === "provider.submit"));
  });

  test("a refused submission is also recorded with a NULL operation id", async () => {
    const provider: ReceiptExtractionProvider = {
      name: "FAKE",
      model: "fake-receipt-v1",
      submit: async () => ({ status: "failed", failureCode: "UNSUPPORTED_IMAGE" }),
      poll: async () => ({ status: "pending" }),
    };
    const { ports, calls } = requestPorts({ provider });
    const outcome = await runExtractionRequestFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "submit-failed");
    const failure = calls.find((c) => c.port === "recordFailure");
    assert.equal((failure?.args as { providerOperationId: unknown }).providerOperationId, null);
    assert.ok(!calls.some((c) => c.port === "registerOperation"));
  });

  test("a failed registration does NOT write a failure — the reaper owns a stuck row", async () => {
    const { ports, calls } = requestPorts({
      registerOperation: async () => ({ status: "failed" }),
    });
    const outcome = await runExtractionRequestFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "unavailable");
    // Registration only refuses when this worker no longer holds an open claim, in which
    // case the row is already terminal or already registered and writing to it would be wrong.
    assert.ok(!calls.some((c) => c.port === "recordFailure"));
  });

  test("no port is ever called twice — there is no retry loop", async () => {
    const { ports, calls } = requestPorts();
    await runExtractionRequestFlow({ extractionId: EXTRACTION_ID }, ports);
    const counts = new Map<string, number>();
    for (const call of calls) counts.set(call.port, (counts.get(call.port) ?? 0) + 1);
    for (const [port, count] of counts) assert.equal(count, 1, `${port} was called ${count} times`);
  });
});

function pollPorts(
  state: {
    status: string;
    providerName: string | null;
    providerModel: string | null;
    claimToken: string | null;
    providerOperationId: string | null;
    startedAtMs: number | null;
  },
  overrides: Partial<ExtractionPollPorts> = {},
): { ports: ExtractionPollPorts; calls: Call[] } {
  const calls: Call[] = [];
  const provider = createFakeProviderForKey(
    "CLEAN_AED_2",
    1500,
    () => UUID,
  );

  const ports: ExtractionPollPorts = {
    workerState: async (args) => {
      calls.push({ port: "workerState", args });
      return { status: "ok", state };
    },
    recordSuccess: async (args) => {
      calls.push({ port: "recordSuccess", args });
      return { status: "ok" };
    },
    recordFailure: async (args) => {
      calls.push({ port: "recordFailure", args });
      return { status: "ok" };
    },
    resolveProvider: (args) => {
      calls.push({ port: "resolveProvider", args });
      return provider;
    },
    nowMs: 100_000,
    ...overrides,
  };

  return { ports, calls };
}

describe("the poll path", () => {
  const PROCESSING = {
    status: "PROCESSING",
    providerName: "FAKE",
    providerModel: "fake-receipt-v1",
    claimToken: CLAIM_TOKEN,
    providerOperationId: OPERATION_ID,
    startedAtMs: 0,
  };

  test("a terminal answer is recorded with the SAME token and operation id", async () => {
    const { ports, calls } = pollPorts(PROCESSING);
    const outcome = await runExtractionPollFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "completed-success");
    const success = calls.find((c) => c.port === "recordSuccess");
    const args = success?.args as { claimToken: string; providerOperationId: string };
    assert.equal(args.claimToken, CLAIM_TOKEN);
    assert.equal(args.providerOperationId, OPERATION_ID);
  });

  test("PENDING writes nothing at all", async () => {
    const { ports, calls } = pollPorts(PROCESSING, { nowMs: 500 });
    const outcome = await runExtractionPollFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "pending");
    assert.ok(!calls.some((c) => c.port === "recordSuccess" || c.port === "recordFailure"));
  });

  test("a provider failure is recorded as a POST-provider failure", async () => {
    const { ports, calls } = pollPorts(PROCESSING, {
      resolveProvider: () =>
        createFakeProviderForKey(
          "REJECTED_DOCUMENT",
          0,
          () => UUID,
        ),
    });
    const outcome = await runExtractionPollFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "completed-failure");
    const failure = calls.find((c) => c.port === "recordFailure");
    const args = failure?.args as { providerOperationId: string; failureCode: string };
    assert.equal(args.providerOperationId, OPERATION_ID); // non-null: path B
    assert.equal(args.failureCode, "PROVIDER_REJECTED_DOCUMENT");
  });

  test("an attempt with no registered operation is not pollable", async () => {
    const { ports, calls } = pollPorts({ ...PROCESSING, providerOperationId: null });
    const outcome = await runExtractionPollFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "not-pollable");
    assert.deepEqual(calls.map((c) => c.port), ["workerState"]);
  });

  test("a QUEUED attempt is not pollable", async () => {
    const { ports } = pollPorts({
      status: "QUEUED",
      providerName: null,
      providerModel: null,
      claimToken: null,
      providerOperationId: null,
      startedAtMs: null,
    });
    assert.equal(
      (await runExtractionPollFlow({ extractionId: EXTRACTION_ID }, ports)).status,
      "not-pollable",
    );
  });

  test("a terminal attempt is not pollable", async () => {
    for (const status of ["SUCCEEDED", "FAILED"]) {
      const { ports } = pollPorts({ ...PROCESSING, status });
      assert.equal(
        (await runExtractionPollFlow({ extractionId: EXTRACTION_ID }, ports)).status,
        "not-pollable",
        status,
      );
    }
  });

  test("a missing worker state writes nothing", async () => {
    const { ports, calls } = pollPorts(PROCESSING, {
      workerState: async () => ({ status: "missing" }),
    });
    const outcome = await runExtractionPollFlow({ extractionId: EXTRACTION_ID }, ports);

    assert.equal(outcome.status, "unavailable");
    assert.ok(!calls.some((c) => c.port === "recordSuccess" || c.port === "recordFailure"));
  });

  test("provider selection uses the attempt's stored provider and model", async () => {
    const { ports, calls } = pollPorts(PROCESSING);

    await runExtractionPollFlow(
      { extractionId: EXTRACTION_ID },
      ports,
    );

    const resolution = calls.find(
      (call) => call.port === "resolveProvider",
    );

    assert.deepEqual(resolution?.args, {
      providerName: "FAKE",
      providerModel: "fake-receipt-v1",
    });
  });

  test("an unavailable stored provider leaves the attempt unchanged", async () => {
    let resolutions = 0;

    const { ports, calls } = pollPorts(
      {
        ...PROCESSING,
        providerName: "AZURE_DOCUMENT_INTELLIGENCE",
        providerModel: "prebuilt-invoice",
      },
      {
        resolveProvider: () => {
          resolutions += 1;
          return null;
        },
      },
    );

    const outcome = await runExtractionPollFlow(
      { extractionId: EXTRACTION_ID },
      ports,
    );

    assert.equal(outcome.status, "unavailable");
    assert.equal(resolutions, 1);
    assert.ok(
      !calls.some(
        (call) =>
          call.port === "recordSuccess" ||
          call.port === "recordFailure",
      ),
    );
  });

  test("a mismatched resolved provider is refused before polling", async () => {
    let polls = 0;

    const fake = createFakeProviderForKey(
      "CLEAN_AED_2",
      0,
      () => UUID,
    );

    const { ports, calls } = pollPorts(
      {
        ...PROCESSING,
        providerName: "AZURE_DOCUMENT_INTELLIGENCE",
        providerModel: "prebuilt-invoice",
      },
      {
        resolveProvider: () => ({
          name: fake.name,
          model: fake.model,
          submit: fake.submit,
          poll: async (input) => {
            polls += 1;
            return fake.poll(input);
          },
        }),
      },
    );

    const outcome = await runExtractionPollFlow(
      { extractionId: EXTRACTION_ID },
      ports,
    );

    assert.equal(outcome.status, "unavailable");
    assert.equal(polls, 0);
    assert.ok(
      !calls.some(
        (call) =>
          call.port === "recordSuccess" ||
          call.port === "recordFailure",
      ),
    );
  });

  test("the provider is polled exactly ONCE, never in a loop", async () => {
    let polls = 0;
    const inner = createFakeProviderForKey("CLEAN_AED_2", 1500, () => UUID);
    const { ports } = pollPorts(PROCESSING, {
      nowMs: 500,
      resolveProvider: () => ({
        name: inner.name,
        model: inner.model,
        submit: inner.submit,
        poll: async (input) => {
          polls += 1;
          return inner.poll(input);
        },
      }),
    });
    await runExtractionPollFlow({ extractionId: EXTRACTION_ID }, ports);
    assert.equal(polls, 1);
  });

  test("a refused completion is reported rather than retried", async () => {
    const { ports } = pollPorts(PROCESSING, {
      recordSuccess: async () => ({ status: "failed" }),
    });
    const outcome = await runExtractionPollFlow({ extractionId: EXTRACTION_ID }, ports);
    assert.equal(outcome.status, "unavailable");
  });
});
