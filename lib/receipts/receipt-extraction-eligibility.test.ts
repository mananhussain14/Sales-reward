/**
 * The web-side eligibility gate, and the drift guard that keeps it honest.
 *
 * Run with:  npm test
 *
 * Two jobs. The first is ordinary: the classification is correct at and around both
 * boundaries. The second is the reason this file matters — the constants here are a COPY
 * of the adapter's own limits, and a copy that is free to drift is worse than no copy at
 * all. So the adapter is imported and the two are asserted equal. If a tier upgrade raises
 * the document limit, this test fails until the web gate is raised with it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyExtractionEligibility,
  EXTRACTION_ELIGIBLE_MIME_TYPES,
  MAX_EXTRACTION_INPUT_BYTES,
  MAX_EXTRACTION_INPUT_MEGABYTES,
} from "./receipt-extraction-eligibility.ts";
import {
  AZURE_DOCUMENT_SUPPORTED_MIME_TYPES,
  DEFAULT_AZURE_DOCUMENT_MAX_INPUT_BYTES,
} from "./receipt-extraction-azure-provider.ts";
import { SUPPORTED_RECEIPT_MIME_TYPES } from "./receipt-file.ts";

describe("the gate agrees with the adapter that enforces it", () => {
  test("1. the accepted types are exactly the adapter's supported types", () => {
    assert.deepEqual(
      [...EXTRACTION_ELIGIBLE_MIME_TYPES],
      [...AZURE_DOCUMENT_SUPPORTED_MIME_TYPES],
    );
  });

  test("2. the size ceiling is exactly the adapter's input ceiling", () => {
    assert.equal(MAX_EXTRACTION_INPUT_BYTES, DEFAULT_AZURE_DOCUMENT_MAX_INPUT_BYTES);
  });

  test("3. the displayed number describes the enforced one", () => {
    assert.equal(MAX_EXTRACTION_INPUT_MEGABYTES * 1024 * 1024, MAX_EXTRACTION_INPUT_BYTES);
  });

  test("4. the gate is strictly NARROWER than what the product stores", () => {
    // The whole reason this module exists. If these two ever became the same set, the
    // gate would be dead code and the test would say so.
    const stored = new Set<string>(SUPPORTED_RECEIPT_MIME_TYPES);
    const readable = new Set<string>(EXTRACTION_ELIGIBLE_MIME_TYPES);
    assert.ok(readable.size < stored.size, "the gate accepts everything the product does");
    for (const type of readable) {
      assert.ok(stored.has(type), `${type} is readable but not storable`);
    }
    assert.ok(stored.has("image/webp"), "the product no longer stores WebP");
    assert.ok(!readable.has("image/webp"), "WebP must not be offered to the reader");
  });
});

describe("classifyExtractionEligibility", () => {
  test("5. a JPEG and a PNG within the ceiling are eligible", () => {
    for (const mimeType of EXTRACTION_ELIGIBLE_MIME_TYPES) {
      assert.deepEqual(classifyExtractionEligibility({ mimeType, sizeBytes: 1024 }), {
        status: "eligible",
      });
    }
  });

  test("6. WebP is ineligible as an unsupported type, at any size", () => {
    for (const sizeBytes of [1, 1024, MAX_EXTRACTION_INPUT_BYTES]) {
      assert.deepEqual(
        classifyExtractionEligibility({ mimeType: "image/webp", sizeBytes }),
        { status: "ineligible", reason: "unsupported-type" },
      );
    }
  });

  test("7. the type is decided before the size", () => {
    // An over-sized WebP is reported as a type problem, because shrinking it would still
    // leave it unreadable.
    assert.deepEqual(
      classifyExtractionEligibility({
        mimeType: "image/webp",
        sizeBytes: MAX_EXTRACTION_INPUT_BYTES + 1,
      }),
      { status: "ineligible", reason: "unsupported-type" },
    );
  });

  test("8. the boundary is exercised at MAX-1, MAX and MAX+1", () => {
    assert.equal(
      classifyExtractionEligibility({
        mimeType: "image/jpeg",
        sizeBytes: MAX_EXTRACTION_INPUT_BYTES - 1,
      }).status,
      "eligible",
    );
    assert.equal(
      classifyExtractionEligibility({
        mimeType: "image/jpeg",
        sizeBytes: MAX_EXTRACTION_INPUT_BYTES,
      }).status,
      "eligible",
    );
    assert.deepEqual(
      classifyExtractionEligibility({
        mimeType: "image/jpeg",
        sizeBytes: MAX_EXTRACTION_INPUT_BYTES + 1,
      }),
      { status: "ineligible", reason: "too-large" },
    );
  });

  test("9. a receipt the product accepts but the reader cannot take is refused here", () => {
    // 10 MiB is a valid upload. It is not a valid document.
    assert.deepEqual(
      classifyExtractionEligibility({
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024,
      }),
      { status: "ineligible", reason: "too-large" },
    );
  });

  test("10. a size that cannot be reasoned about is refused, not waved through", () => {
    for (const sizeBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        classifyExtractionEligibility({ mimeType: "image/jpeg", sizeBytes }).status,
        "ineligible",
      );
    }
  });

  test("11. a declared type is matched exactly — no case folding, no padding", () => {
    for (const mimeType of ["IMAGE/JPEG", " image/jpeg", "image/jpeg ", "image/jpg"]) {
      assert.deepEqual(classifyExtractionEligibility({ mimeType, sizeBytes: 1024 }), {
        status: "ineligible",
        reason: "unsupported-type",
      });
    }
  });
});
