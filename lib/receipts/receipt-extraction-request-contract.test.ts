/**
 * Unit tests for the strict request-body parser the three extraction Edge Functions share.
 *
 * Run with:  npm test
 *
 * The allowlist IS the validation, and these tests pin that: an unknown key is a 400 rather
 * than an ignored extra. That matters beyond tidiness — an ignored extra is the shape in
 * which a fixture selector, an outcome override or a mode flag would arrive if one were ever
 * smuggled into a client, and it would be silently accepted by a permissive parser and
 * silently dropped by a careful one. Refusing it makes the attempt visible.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  EXTRACTION_REQUEST_FIELDS,
  EXTRACTION_RESPONSE_STATUSES,
  MAX_EXTRACTION_REQUEST_BYTES,
  parseExtractionRequest,
} from "./receipt-extraction-request-contract.ts";

const VALID_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function parse(body: unknown) {
  return parseExtractionRequest(body);
}

function reasonOf(body: unknown): string | null {
  const result = parse(body);
  return result.status === "invalid" ? result.reason : null;
}

describe("the happy path", () => {
  test("one key, a valid uuid", () => {
    const result = parse(JSON.stringify({ submission_id: VALID_ID }));
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.request.submissionId, VALID_ID);
  });

  test("the id is lower-cased so the value handed to PostgREST is canonical", () => {
    const result = parse(JSON.stringify({ submission_id: VALID_ID.toUpperCase() }));
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.request.submissionId, VALID_ID);
  });

  test("surrounding whitespace is trimmed", () => {
    const result = parse(JSON.stringify({ submission_id: `  ${VALID_ID}  ` }));
    assert.equal(result.status, "ok");
    if (result.status === "ok") assert.equal(result.request.submissionId, VALID_ID);
  });
});

describe("the allowlist has exactly one key", () => {
  test("the constant says so", () => {
    assert.deepEqual([...EXTRACTION_REQUEST_FIELDS], ["submission_id"]);
  });

  test("an unknown key is REFUSED, not ignored", () => {
    assert.equal(
      reasonOf(JSON.stringify({ submission_id: VALID_ID, fixture: "CLEAN_AED_2" })),
      "unknown-field",
    );
  });

  test("the specific smuggling shapes this contract exists to refuse", () => {
    const forbidden = [
      { submission_id: VALID_ID, outcome: "SUCCEEDED" },
      { submission_id: VALID_ID, mode: "fake" },
      { submission_id: VALID_ID, provider: "FAKE" },
      { submission_id: VALID_ID, entry_mode: "EXTRACTED" },
      { submission_id: VALID_ID, changed_fields: [] },
      { submission_id: VALID_ID, extraction_id: VALID_ID },
      { submission_id: VALID_ID, claim_token: VALID_ID },
      { submission_id: VALID_ID, organization_id: VALID_ID },
      { submission_id: VALID_ID, storage_bucket: "receipts" },
      { submission_id: VALID_ID, total_minor: 1 },
    ];
    for (const body of forbidden) {
      assert.equal(reasonOf(JSON.stringify(body)), "unknown-field", JSON.stringify(body));
    }
  });
});

describe("malformed roots", () => {
  test("a non-string input", () => {
    assert.equal(reasonOf(null), "malformed-body");
    assert.equal(reasonOf(undefined), "malformed-body");
    assert.equal(reasonOf({ submission_id: VALID_ID }), "malformed-body");
  });

  test("unparseable JSON", () => {
    assert.equal(reasonOf("{"), "malformed-body");
    assert.equal(reasonOf("not json"), "malformed-body");
  });

  test("a JSON root that is not a plain object", () => {
    assert.equal(reasonOf("null"), "malformed-body");
    assert.equal(reasonOf("[]"), "malformed-body");
    assert.equal(reasonOf(`[{"submission_id":"${VALID_ID}"}]`), "malformed-body");
    assert.equal(reasonOf('"a string"'), "malformed-body");
    assert.equal(reasonOf("42"), "malformed-body");
    assert.equal(reasonOf("true"), "malformed-body");
  });
});

describe("the submission id", () => {
  test("a missing id", () => {
    assert.equal(reasonOf("{}"), "invalid-submission-id");
  });

  test("a non-string id", () => {
    assert.equal(reasonOf('{"submission_id": 1}'), "invalid-submission-id");
    assert.equal(reasonOf('{"submission_id": null}'), "invalid-submission-id");
    assert.equal(reasonOf('{"submission_id": {}}'), "invalid-submission-id");
    assert.equal(reasonOf(`{"submission_id": ["${VALID_ID}"]}`), "invalid-submission-id");
  });

  test("a malformed uuid", () => {
    for (const value of ["", "abc", VALID_ID.slice(0, -1), `${VALID_ID}x`, "../../etc/passwd"]) {
      assert.equal(
        reasonOf(JSON.stringify({ submission_id: value })),
        "invalid-submission-id",
        value,
      );
    }
  });
});

describe("the byte bound", () => {
  test("an oversized body is refused BEFORE it is parsed", () => {
    const padded = `{"submission_id":"${VALID_ID}","x":"${"a".repeat(
      MAX_EXTRACTION_REQUEST_BYTES,
    )}"}`;
    // Reported as too-large rather than unknown-field: the bound is checked first, so a
    // large document is never handed to JSON.parse at all.
    assert.equal(reasonOf(padded), "body-too-large");
  });

  test("multi-byte characters are measured as BYTES, not code points", () => {
    const filler = "é".repeat(MAX_EXTRACTION_REQUEST_BYTES - 100);
    assert.equal(reasonOf(`{"submission_id":"${VALID_ID}","x":"${filler}"}`), "body-too-large");
  });

  test("an ordinary body is comfortably inside the bound", () => {
    assert.equal(parse(JSON.stringify({ submission_id: VALID_ID })).status, "ok");
  });
});

describe("the response vocabulary is closed", () => {
  test("exactly six statuses", () => {
    assert.deepEqual([...EXTRACTION_RESPONSE_STATUSES], [
      "ok",
      "invalid",
      "unauthenticated",
      "denied",
      "not-found",
      "unavailable",
    ]);
  });
});
