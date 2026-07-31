/**
 * Unit tests for the closed extraction vocabularies.
 *
 * Run with:  npm test
 *
 * The vocabularies are enforced twice — by CHECK constraints in migration 20260812210000 and
 * by these constants — so the risk they carry is DRIFT, not malformation. These tests pin the
 * exact membership of every closed set and, above all, that the ten stored failure codes map
 * TOTALLY onto the three a client is allowed to see. A stored code with no mapping would fall
 * through to a client as an internal value.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_EXTRACTION_FAILURE_CODES,
  CLIENT_FAILURE_CODE_BY_STORED,
  CONFIRMATION_COMPARABLE_FIELDS,
  CONFIRMATION_ENTRY_MODES,
  EXTRACTION_FAILURE_CODES,
  EXTRACTION_REQUEST_OUTCOMES,
  EXTRACTION_RUNTIME_MODES,
  EXTRACTION_STATUSES,
  EXTRACTION_WARNING_CODES,
  FAKE_OPERATION_ID_PREFIX,
  FAKE_PROVIDER_MODEL,
  FAKE_PROVIDER_NAME,
  MAX_EXTRACTION_ATTEMPTS,
  MAX_LINE_ITEMS,
  MAX_MINOR_AMOUNT,
  POST_PROVIDER_FAILURE_CODES,
  PRE_PROVIDER_FAILURE_CODES,
  REAPER_ONLY_FAILURE_CODES,
  TEXT_BOUNDS,
  attemptsRemaining,
  toClientFailureCode,
} from "./receipt-extraction-vocabulary.ts";

describe("the lifecycle vocabularies", () => {
  test("four statuses", () => {
    assert.deepEqual([...EXTRACTION_STATUSES], ["QUEUED", "PROCESSING", "SUCCEEDED", "FAILED"]);
  });

  test("two runtime modes, and the safe one is first", () => {
    assert.deepEqual([...EXTRACTION_RUNTIME_MODES], ["DISABLED", "FAKE"]);
  });

  test("three attempts", () => {
    assert.equal(MAX_EXTRACTION_ATTEMPTS, 3);
  });
});

describe("the provider is locked to the fake", () => {
  test("name and model", () => {
    assert.equal(FAKE_PROVIDER_NAME, "FAKE");
    assert.equal(FAKE_PROVIDER_MODEL, "fake-receipt-v1");
  });

  test("operation ids carry a prefix that cannot pass for a real one", () => {
    assert.equal(FAKE_OPERATION_ID_PREFIX, "fake:");
  });
});

describe("the two failure vocabularies", () => {
  test("ten stored codes", () => {
    assert.equal(EXTRACTION_FAILURE_CODES.length, 10);
    assert.deepEqual([...EXTRACTION_FAILURE_CODES].sort(), [
      "INTERNAL",
      "NEVER_CLAIMED",
      "NORMALIZATION_FAILED",
      "OBJECT_UNREADABLE",
      "PROVIDER_QUOTA_EXCEEDED",
      "PROVIDER_REJECTED_DOCUMENT",
      "PROVIDER_TIMEOUT",
      "PROVIDER_UNAVAILABLE",
      "UNSUPPORTED_IMAGE",
      "WORKER_ABANDONED",
    ]);
  });

  test("three client codes", () => {
    assert.deepEqual([...CLIENT_EXTRACTION_FAILURE_CODES], [
      "IMAGE_NOT_A_RECEIPT",
      "IMAGE_UNUSABLE",
      "EXTRACTION_UNAVAILABLE",
    ]);
  });

  test("the mapping is TOTAL over the stored codes", () => {
    // A stored code with no mapping would reach a client as an internal value.
    for (const stored of EXTRACTION_FAILURE_CODES) {
      const mapped = CLIENT_FAILURE_CODE_BY_STORED[stored];
      assert.ok(mapped !== undefined, `${stored} has no client mapping`);
      assert.ok(
        (CLIENT_EXTRACTION_FAILURE_CODES as readonly string[]).includes(mapped),
        `${stored} maps outside the client vocabulary`,
      );
    }
  });

  test("only the caller's-own-file failures are distinguishable", () => {
    assert.equal(toClientFailureCode("PROVIDER_REJECTED_DOCUMENT"), "IMAGE_NOT_A_RECEIPT");
    assert.equal(toClientFailureCode("UNSUPPORTED_IMAGE"), "IMAGE_UNUSABLE");
  });

  test("every infrastructure failure collapses to one code", () => {
    for (const stored of [
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_QUOTA_EXCEEDED",
      "PROVIDER_TIMEOUT",
      "OBJECT_UNREADABLE",
      "NORMALIZATION_FAILED",
      "WORKER_ABANDONED",
      "NEVER_CLAIMED",
      "INTERNAL",
    ]) {
      assert.equal(toClientFailureCode(stored), "EXTRACTION_UNAVAILABLE", stored);
    }
  });

  test("no failure maps to no code", () => {
    assert.equal(toClientFailureCode(null), null);
    assert.equal(toClientFailureCode(undefined), null);
  });

  test("an unrecognised code collapses safely rather than leaking or vanishing", () => {
    assert.equal(toClientFailureCode("SOMETHING_NEW"), "EXTRACTION_UNAVAILABLE");
  });

  test("the reaper-only codes are exactly two, and are stored codes", () => {
    assert.deepEqual([...REAPER_ONLY_FAILURE_CODES], ["WORKER_ABANDONED", "NEVER_CLAIMED"]);
    for (const code of REAPER_ONLY_FAILURE_CODES) {
      assert.ok((EXTRACTION_FAILURE_CODES as readonly string[]).includes(code));
    }
  });

  test("the pre- and post-provider sets partition the worker-writable codes", () => {
    const workerWritable = EXTRACTION_FAILURE_CODES.filter(
      (code) => !(REAPER_ONLY_FAILURE_CODES as readonly string[]).includes(code),
    );
    const union = [...PRE_PROVIDER_FAILURE_CODES, ...POST_PROVIDER_FAILURE_CODES];
    assert.deepEqual([...union].sort(), [...workerWritable].sort());
    // Disjoint: a code cannot be legal both before and after the provider is reached.
    for (const code of PRE_PROVIDER_FAILURE_CODES) {
      assert.ok(!(POST_PROVIDER_FAILURE_CODES as readonly string[]).includes(code));
    }
  });
});

describe("warnings and confirmation vocabularies", () => {
  test("twelve warning codes", () => {
    assert.equal(EXTRACTION_WARNING_CODES.length, 12);
    assert.ok(EXTRACTION_WARNING_CODES.includes("AMBIGUOUS_AMOUNT_FORMAT"));
    assert.ok(EXTRACTION_WARNING_CODES.includes("SUBTOTAL_TAX_TOTAL_MISMATCH"));
  });

  test("three entry modes", () => {
    assert.deepEqual([...CONFIRMATION_ENTRY_MODES], ["MANUAL", "EXTRACTED", "MIXED"]);
  });

  test("eight comparable fields, declared SORTED", () => {
    assert.equal(CONFIRMATION_COMPARABLE_FIELDS.length, 8);
    assert.deepEqual(
      [...CONFIRMATION_COMPARABLE_FIELDS],
      [...CONFIRMATION_COMPARABLE_FIELDS].sort(),
    );
  });

  test("six request outcomes", () => {
    assert.deepEqual([...EXTRACTION_REQUEST_OUTCOMES], [
      "ALREADY_CONFIRMED",
      "ACTIVE",
      "SUCCEEDED",
      "EXHAUSTED",
      "EXTRACTION_UNAVAILABLE",
      "QUEUED",
    ]);
  });
});

describe("bounds", () => {
  test("the monetary ceiling and line-item cap", () => {
    assert.equal(MAX_MINOR_AMOUNT, 1_000_000_000_000);
    assert.equal(MAX_LINE_ITEMS, 200);
  });

  test("every OCR-derived text column has a positive bound", () => {
    for (const [column, bound] of Object.entries(TEXT_BOUNDS)) {
      assert.ok(Number.isSafeInteger(bound) && bound > 0, `${column} has no usable bound`);
    }
  });

  test("the source-text bounds match the contract", () => {
    assert.equal(TEXT_BOUNDS.merchant_name_source_text, 500);
    assert.equal(TEXT_BOUNDS.document_number_source_text, 250);
    assert.equal(TEXT_BOUNDS.transaction_date_source_text, 100);
    assert.equal(TEXT_BOUNDS.transaction_time_source_text, 100);
    assert.equal(TEXT_BOUNDS.currency_code_source_text, 50);
    assert.equal(TEXT_BOUNDS.total_source_text, 100);
    assert.equal(TEXT_BOUNDS.subtotal_source_text, 100);
    assert.equal(TEXT_BOUNDS.tax_source_text, 100);
    assert.equal(TEXT_BOUNDS.line_item_description_source_text, 1000);
    assert.equal(TEXT_BOUNDS.line_item_quantity_source_text, 100);
    assert.equal(TEXT_BOUNDS.line_item_unit_price_source_text, 100);
    assert.equal(TEXT_BOUNDS.line_item_line_total_source_text, 100);
  });
});

describe("attemptsRemaining is a fact, never a signal", () => {
  test("it depends only on the count of persisted rows", () => {
    assert.equal(attemptsRemaining(0), 3);
    assert.equal(attemptsRemaining(1), 2);
    assert.equal(attemptsRemaining(2), 1);
    assert.equal(attemptsRemaining(3), 0);
  });

  test("it never goes negative", () => {
    assert.equal(attemptsRemaining(4), 0);
    assert.equal(attemptsRemaining(99), 0);
  });
});
