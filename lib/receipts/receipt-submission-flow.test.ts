/**
 * Unit tests for the receipt reserve → upload → finalize SEQUENCE.
 *
 * Run with:  npm test
 *
 * The sequence is exercised against fake ports that record every call in order, so
 * these tests pin the contract the milestone cares about:
 *
 *   reserve -> upload -> finalize            (success)
 *   reserve -> upload -> removeObject -> recordFailure   (upload failed)
 *   reserve -> upload -> finalize -> removeObject -> recordFailure  (finalize failed)
 *
 * plus: nothing is uploaded when the reservation is refused, no result ever carries the
 * object path, bucket, hash or submission id, and a failure NEVER leaves a row that
 * would read as submitted.
 *
 * SUPABASE STORAGE IS MOCKED. The `upload` and `removeObject` ports are fakes; the real
 * Storage client is not imported here at all, so no network call of any kind occurs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  runReceiptSubmissionFlow,
  type ReceiptFinalizeResult,
  type ReceiptReserveResult,
  type ReceiptSubmissionPorts,
  type ReceiptUploadResult,
} from "./receipt-submission-flow.ts";

const SUBMISSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHOP_ID = "11111111-1111-4111-8111-111111111111";
const OBJECT_PATH =
  "22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/44444444-4444-4444-8444-444444444444.jpg";
const SHA = "a".repeat(64);

const INPUT = {
  shopId: SHOP_ID,
  fileName: "till.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 204800,
  sha256: SHA,
};

type Call = { port: string; args?: unknown };

type FakeOptions = {
  reserve?: ReceiptReserveResult;
  upload?: ReceiptUploadResult;
  finalize?: ReceiptFinalizeResult;
};

function makePorts(options: FakeOptions = {}) {
  const calls: Call[] = [];

  const ports: ReceiptSubmissionPorts = {
    async reserve(args) {
      calls.push({ port: "reserve", args });
      return (
        options.reserve ?? {
          status: "ok",
          submissionId: SUBMISSION_ID,
          bucket: "receipts",
          objectPath: OBJECT_PATH,
        }
      );
    },
    async upload(args) {
      calls.push({ port: "upload", args });
      return options.upload ?? { status: "ok" };
    },
    async finalize(args) {
      calls.push({ port: "finalize", args });
      return options.finalize ?? { status: "ok" };
    },
    async removeObject(args) {
      calls.push({ port: "removeObject", args });
    },
    async recordFailure(args) {
      calls.push({ port: "recordFailure", args });
    },
  };

  return { ports, calls, order: () => calls.map((call) => call.port) };
}

describe("runReceiptSubmissionFlow — the happy path", () => {
  test("1. calls reserve -> upload -> finalize, in that order", async () => {
    const fake = makePorts();
    const result = await runReceiptSubmissionFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "submitted" });
    assert.deepEqual(fake.order(), ["reserve", "upload", "finalize"]);
  });

  test("2. neither cleanup port is touched on success", async () => {
    const fake = makePorts();
    await runReceiptSubmissionFlow(INPUT, fake.ports);
    assert.ok(!fake.order().includes("removeObject"));
    assert.ok(!fake.order().includes("recordFailure"));
  });

  test("3. the upload goes to the SERVER-GENERATED bucket and path", async () => {
    const fake = makePorts();
    await runReceiptSubmissionFlow(INPUT, fake.ports);

    const upload = fake.calls.find((call) => call.port === "upload");
    assert.deepEqual(upload?.args, { bucket: "receipts", objectPath: OBJECT_PATH });
  });

  test("4. finalize re-asserts every fact the reservation recorded", async () => {
    const fake = makePorts();
    await runReceiptSubmissionFlow(INPUT, fake.ports);

    const finalize = fake.calls.find((call) => call.port === "finalize");
    assert.deepEqual(finalize?.args, {
      submissionId: SUBMISSION_ID,
      sha256: SHA,
      objectPath: OBJECT_PATH,
      mimeType: "image/jpeg",
      sizeBytes: 204800,
    });
  });

  test("5. the reservation is given only the shop id and the validated file facts", async () => {
    const fake = makePorts();
    await runReceiptSubmissionFlow(INPUT, fake.ports);

    const reserve = fake.calls.find((call) => call.port === "reserve");
    assert.deepEqual(Object.keys(reserve?.args as object).sort(), [
      "fileName",
      "mimeType",
      "sha256",
      "shopId",
      "sizeBytes",
    ]);
  });
});

describe("runReceiptSubmissionFlow — a refused reservation uploads nothing", () => {
  const refusals = [
    ["duplicate", { status: "duplicate" }],
    ["denied", { status: "denied" }],
    ["invalid", { status: "invalid" }],
    ["unavailable", { status: "unavailable" }],
  ] as const;

  for (const [label, reserve] of refusals) {
    test(`6. a ${label} reservation stops after reserve and touches Storage never`, async () => {
      const fake = makePorts({ reserve });
      const result = await runReceiptSubmissionFlow(INPUT, fake.ports);

      assert.deepEqual(result, { status: label });
      assert.deepEqual(fake.order(), ["reserve"]);
    });
  }

  test("7. no refusal records a failure — there is nothing to record against", async () => {
    for (const [, reserve] of refusals) {
      const fake = makePorts({ reserve });
      await runReceiptSubmissionFlow(INPUT, fake.ports);
      assert.ok(!fake.order().includes("recordFailure"));
      assert.ok(!fake.order().includes("removeObject"));
    }
  });
});

describe("runReceiptSubmissionFlow — a failed upload cleans up", () => {
  test("8. removes the object and records the failure, in that order", async () => {
    const fake = makePorts({ upload: { status: "failed" } });
    const result = await runReceiptSubmissionFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "upload-failed" });
    assert.deepEqual(fake.order(), [
      "reserve",
      "upload",
      "removeObject",
      "recordFailure",
    ]);
  });

  test("9. finalize is NEVER called after a failed upload", async () => {
    // This is what guarantees a failure cannot produce a row that reads as submitted:
    // only finalize sets SUBMITTED, and it is unreachable on this path.
    const fake = makePorts({ upload: { status: "failed" } });
    await runReceiptSubmissionFlow(INPUT, fake.ports);
    assert.ok(!fake.order().includes("finalize"));
  });

  test("10. cleanup names the same server-generated location, and the failure the hash", async () => {
    const fake = makePorts({ upload: { status: "failed" } });
    await runReceiptSubmissionFlow(INPUT, fake.ports);

    assert.deepEqual(fake.calls.find((c) => c.port === "removeObject")?.args, {
      bucket: "receipts",
      objectPath: OBJECT_PATH,
    });
    assert.deepEqual(fake.calls.find((c) => c.port === "recordFailure")?.args, {
      submissionId: SUBMISSION_ID,
      sha256: SHA,
    });
  });
});

describe("runReceiptSubmissionFlow — a failed finalize also cleans up", () => {
  test("11. the uploaded object is removed and the row is marked failed", async () => {
    const fake = makePorts({ finalize: { status: "failed" } });
    const result = await runReceiptSubmissionFlow(INPUT, fake.ports);

    assert.deepEqual(result, { status: "upload-failed" });
    assert.deepEqual(fake.order(), [
      "reserve",
      "upload",
      "finalize",
      "removeObject",
      "recordFailure",
    ]);
  });

  test("12. the person is never told it succeeded when the row was not completed", async () => {
    const fake = makePorts({ finalize: { status: "failed" } });
    const result = await runReceiptSubmissionFlow(INPUT, fake.ports);
    assert.notEqual(result.status, "submitted");
  });
});

describe("runReceiptSubmissionFlow — nothing secret escapes in the result", () => {
  test("13. no outcome carries the path, bucket, hash, submission id or filename", async () => {
    const outcomes: FakeOptions[] = [
      {},
      { reserve: { status: "duplicate" } },
      { reserve: { status: "denied" } },
      { reserve: { status: "invalid" } },
      { reserve: { status: "unavailable" } },
      { upload: { status: "failed" } },
      { finalize: { status: "failed" } },
    ];

    for (const options of outcomes) {
      const fake = makePorts(options);
      const result = await runReceiptSubmissionFlow(INPUT, fake.ports);
      const serialized = JSON.stringify(result);

      assert.deepEqual(
        Object.keys(result),
        ["status"],
        `result must carry only a status, got ${serialized}`,
      );
      assert.ok(!serialized.includes(OBJECT_PATH), serialized);
      assert.ok(!serialized.includes(SUBMISSION_ID), serialized);
      assert.ok(!serialized.includes(SHA), serialized);
      assert.ok(!serialized.includes("receipts"), serialized);
      assert.ok(!serialized.includes("till.jpg"), serialized);
    }
  });

  test("14. every status is one of the six declared outcomes", async () => {
    const allowed = new Set([
      "submitted",
      "upload-failed",
      "duplicate",
      "denied",
      "invalid",
      "unavailable",
    ]);
    const options: FakeOptions[] = [
      {},
      { reserve: { status: "duplicate" } },
      { reserve: { status: "denied" } },
      { reserve: { status: "invalid" } },
      { upload: { status: "failed" } },
      { finalize: { status: "failed" } },
    ];
    for (const option of options) {
      const { ports } = makePorts(option);
      const result = await runReceiptSubmissionFlow(INPUT, ports);
      assert.ok(allowed.has(result.status), result.status);
    }
  });
});
