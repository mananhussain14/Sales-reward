/**
 * WHAT HAPPENS AFTER A RECEIPT IS STORED — the behaviour, against a fake port.
 *
 * Run with:  npm test
 *
 * This is the test the milestone was missing. The Azure adapter, the normalization, the
 * configuration and the SQL contract were all covered; the one thing nothing asserted was
 * that a successful web submission causes an extraction request AT ALL — and it did not.
 * These cases fail if that wiring is ever removed again.
 *
 * The port RECORDS every call, so "exactly once" and "not at all" are observations rather
 * than inferences.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runReceiptSubmissionOutcome,
  type ExtractionRequestOutcome,
  type ReceiptExtractionRequestPorts,
} from "./receipt-submission-extraction-flow.ts";
import type { ReceiptSubmissionResult } from "./receipt-submission-flow.ts";
import { MAX_EXTRACTION_INPUT_BYTES } from "./receipt-extraction-eligibility.ts";

/** The canonical id, as reserve_receipt_submission() would have returned it. */
const SUBMISSION_ID = "0f2a4a9c-6b3e-4c1a-9d77-2b6d8b5e1c40";
/** An id no honest path can produce here — used to prove none is invented. */
const OTHER_ID = "11111111-2222-3333-4444-555555555555";

const JPEG = { mimeType: "image/jpeg", sizeBytes: 512 * 1024 };
const WEBP = { mimeType: "image/webp", sizeBytes: 512 * 1024 };
const OVERSIZED = { mimeType: "image/png", sizeBytes: MAX_EXTRACTION_INPUT_BYTES + 1 };

const SUBMITTED: ReceiptSubmissionResult = {
  status: "submitted",
  submissionId: SUBMISSION_ID,
};

function makePorts(outcome: ExtractionRequestOutcome = { status: "requested" }): {
  ports: ReceiptExtractionRequestPorts;
  calls: { submissionId: string }[];
} {
  const calls: { submissionId: string }[] = [];
  return {
    calls,
    ports: {
      async requestExtraction(input) {
        calls.push(input);
        return outcome;
      },
    },
  };
}

describe("a stored receipt is offered to the reader", () => {
  test("1. one successful submission requests extraction EXACTLY once", async () => {
    const fake = makePorts();
    const result = await runReceiptSubmissionOutcome(SUBMITTED, JPEG, fake.ports);

    assert.equal(fake.calls.length, 1);
    assert.deepEqual(result, { status: "submitted" });
  });

  test("2. the id sent is the canonical one the database returned", async () => {
    const fake = makePorts();
    await runReceiptSubmissionOutcome(SUBMITTED, JPEG, fake.ports);

    assert.deepEqual(fake.calls, [{ submissionId: SUBMISSION_ID }]);
    assert.notEqual(fake.calls[0].submissionId, OTHER_ID);
  });

  test("3. the port receives ONE field and nothing else", async () => {
    const fake = makePorts();
    await runReceiptSubmissionOutcome(SUBMITTED, JPEG, fake.ports);

    assert.deepEqual(Object.keys(fake.calls[0]), ["submissionId"]);
  });

  test("4. an id is never invented for a result that did not carry one", async () => {
    // The `submitted` variant is the only one with an id, and TypeScript enforces that.
    // This asserts the runtime consequence: nothing else reaches the port.
    for (const submission of [
      { status: "duplicate" },
      { status: "denied" },
      { status: "invalid" },
      { status: "unavailable" },
      { status: "upload-failed" },
    ] as ReceiptSubmissionResult[]) {
      const fake = makePorts();
      await runReceiptSubmissionOutcome(submission, JPEG, fake.ports);
      assert.equal(fake.calls.length, 0, submission.status);
    }
  });
});

describe("nothing that was not stored is ever read", () => {
  test("5. a duplicate requests extraction ZERO times, and passes through", async () => {
    const fake = makePorts();
    const result = await runReceiptSubmissionOutcome(
      { status: "duplicate" },
      JPEG,
      fake.ports,
    );

    assert.equal(fake.calls.length, 0);
    assert.deepEqual(result, { status: "duplicate" });
  });

  test("6. a failed upload requests extraction ZERO times", async () => {
    const fake = makePorts();
    const result = await runReceiptSubmissionOutcome(
      { status: "upload-failed" },
      JPEG,
      fake.ports,
    );

    assert.equal(fake.calls.length, 0);
    assert.deepEqual(result, { status: "upload-failed" });
  });

  test("7. a failed finalize requests extraction ZERO times", async () => {
    // A finalize failure is reported by the submission flow as `upload-failed` — the
    // object is removed and the row is marked failed — so it reaches this module in that
    // shape. Asserted separately from case 6 because they are different faults upstream.
    const fake = makePorts();
    const result = await runReceiptSubmissionOutcome(
      { status: "upload-failed" },
      JPEG,
      fake.ports,
    );

    assert.equal(fake.calls.length, 0);
    assert.equal(result.status, "upload-failed");
  });

  test("8. a denial, an invalid file and an outage request extraction ZERO times", async () => {
    for (const status of ["denied", "invalid", "unavailable"] as const) {
      const fake = makePorts();
      const result = await runReceiptSubmissionOutcome({ status }, JPEG, fake.ports);
      assert.equal(fake.calls.length, 0, status);
      assert.deepEqual(result, { status });
    }
  });
});

describe("an image the reader cannot take costs no attempt", () => {
  test("9. WebP requests extraction ZERO times and says so honestly", async () => {
    const fake = makePorts();
    const result = await runReceiptSubmissionOutcome(SUBMITTED, WEBP, fake.ports);

    assert.equal(fake.calls.length, 0);
    assert.deepEqual(result, {
      status: "submitted-extraction-skipped",
      reason: "unsupported-type",
    });
  });

  test("10. a file above the reader's ceiling requests extraction ZERO times", async () => {
    const fake = makePorts();
    const result = await runReceiptSubmissionOutcome(SUBMITTED, OVERSIZED, fake.ports);

    assert.equal(fake.calls.length, 0);
    assert.deepEqual(result, {
      status: "submitted-extraction-skipped",
      reason: "too-large",
    });
  });

  test("11. a skipped reading is still a STORED receipt", async () => {
    for (const file of [WEBP, OVERSIZED]) {
      const fake = makePorts();
      const result = await runReceiptSubmissionOutcome(SUBMITTED, file, fake.ports);
      assert.ok(result.status.startsWith("submitted"), result.status);
      assert.notEqual(result.status, "upload-failed");
    }
  });
});

describe("partial success keeps the receipt", () => {
  test("12. an unavailable request is reported as a SUBMITTED outcome", async () => {
    const fake = makePorts({ status: "unavailable" });
    const result = await runReceiptSubmissionOutcome(SUBMITTED, JPEG, fake.ports);

    assert.deepEqual(result, { status: "submitted-extraction-unstarted" });
  });

  test("13. it is never converted into an upload failure or a denial", async () => {
    const fake = makePorts({ status: "unavailable" });
    const result = await runReceiptSubmissionOutcome(SUBMITTED, JPEG, fake.ports);

    for (const forbidden of ["upload-failed", "denied", "invalid", "unavailable"]) {
      assert.notEqual(result.status, forbidden);
    }
  });

  test("14. a failed request is NOT retried", async () => {
    const fake = makePorts({ status: "unavailable" });
    await runReceiptSubmissionOutcome(SUBMITTED, JPEG, fake.ports);

    // Requesting can consume one of three lifetime attempts. Exactly one call, ever.
    assert.equal(fake.calls.length, 1);
  });

  test("15. a port that throws is a fault this module does not swallow silently", async () => {
    // The real port cannot throw — it returns `unavailable` for every fault, which case
    // 12 covers. This pins the contract: if a future port DOES throw, the failure is
    // visible here rather than being caught and reported as a success.
    const ports: ReceiptExtractionRequestPorts = {
      async requestExtraction() {
        throw new Error("transport");
      },
    };

    await assert.rejects(() => runReceiptSubmissionOutcome(SUBMITTED, JPEG, ports));
  });
});

describe("the closed vocabulary", () => {
  test("16. every outcome is one of the eight declared statuses", async () => {
    const allowed = new Set([
      "submitted",
      "submitted-extraction-unstarted",
      "submitted-extraction-skipped",
      "upload-failed",
      "duplicate",
      "denied",
      "invalid",
      "unavailable",
    ]);

    const cases: [ReceiptSubmissionResult, typeof JPEG, ExtractionRequestOutcome][] = [
      [SUBMITTED, JPEG, { status: "requested" }],
      [SUBMITTED, JPEG, { status: "unavailable" }],
      [SUBMITTED, WEBP, { status: "requested" }],
      [SUBMITTED, OVERSIZED, { status: "requested" }],
      [{ status: "duplicate" }, JPEG, { status: "requested" }],
      [{ status: "denied" }, JPEG, { status: "requested" }],
      [{ status: "invalid" }, JPEG, { status: "requested" }],
      [{ status: "unavailable" }, JPEG, { status: "requested" }],
      [{ status: "upload-failed" }, JPEG, { status: "requested" }],
    ];

    for (const [submission, file, outcome] of cases) {
      const { ports } = makePorts(outcome);
      const result = await runReceiptSubmissionOutcome(submission, file, ports);
      assert.ok(allowed.has(result.status), result.status);
    }
  });

  test("17. no outcome carries an id, a path, a bucket, or a hash", async () => {
    for (const outcome of [
      { status: "requested" } as const,
      { status: "unavailable" } as const,
    ]) {
      const { ports } = makePorts(outcome);
      const result = await runReceiptSubmissionOutcome(SUBMITTED, JPEG, ports);
      const serialized = JSON.stringify(result);

      assert.ok(!serialized.includes(SUBMISSION_ID), serialized);
      assert.ok(!/receipts|objectPath|sha256|bucket/i.test(serialized), serialized);
    }
  });
});
