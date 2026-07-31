/**
 * Unit tests for the PostgREST boundary: inbound row validation and outbound jsonb building.
 *
 * Run with:  npm test
 *
 * `supabase.rpc()` is untyped in this project, so its result is `any`. These tests pin that
 * the normalizers CHECK rather than assert — a malformed row is refused, not rendered — and
 * that the outbound payload uses exactly the keys the success RPC's closed allowlist admits.
 * An extra key there is 23514, so the two are one contract stated in two places.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildSuccessLineItemsPayload,
  buildSuccessNormalizedPayload,
  normalizeConfirmation,
  normalizeExtractionLineItems,
  normalizeExtractionRequestState,
  normalizeExtractionView,
} from "./receipt-extraction-normalization.ts";
import { buildFixtureExtraction, FAKE_FIXTURES } from "./receipt-extraction-fake-fixtures.ts";
import { MAX_LINE_ITEMS, TEXT_BOUNDS } from "./receipt-extraction-vocabulary.ts";
import type { NormalizedLineItem } from "./receipt-extraction-provider.ts";

const SUBMISSION = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const EXTRACTION = "11111111-2222-3333-4444-555555555555";

/** The exact key set record_receipt_extraction_success accepts in p_normalized. */
const NORMALIZED_ALLOWLIST = [
  "merchant_name", "merchant_name_source_text", "merchant_name_confidence",
  "document_number", "document_number_source_text", "document_number_confidence",
  "transaction_date", "transaction_date_source_text", "transaction_date_confidence",
  "transaction_time", "transaction_time_source_text", "transaction_time_confidence",
  "currency_code", "currency_code_source_text", "currency_code_confidence",
  "total_minor", "total_source_text", "total_confidence",
  "subtotal_minor", "subtotal_source_text", "subtotal_confidence",
  "tax_total_minor", "tax_source_text", "tax_confidence",
  "warning_codes",
].sort();

/** The exact key set it accepts in each element of p_line_items. */
const LINE_ITEM_ALLOWLIST = [
  "line_number", "description", "description_source_text",
  "quantity", "quantity_source_text",
  "unit_price_minor", "unit_price_source_text",
  "line_total_minor", "line_total_source_text",
  "confidence",
].sort();

function requestRow(overrides: Record<string, unknown> = {}) {
  return [{
    outcome: "QUEUED",
    extraction_id: EXTRACTION,
    attempt_number: 1,
    attempts_used: 1,
    attempts_remaining: 2,
    retry_allowed: false,
    manual_confirmation_allowed: false,
    ...overrides,
  }];
}

function viewRow(overrides: Record<string, unknown> = {}) {
  return [{
    submission_id: SUBMISSION,
    extraction_id: EXTRACTION,
    status: "SUCCEEDED",
    attempt_number: 1,
    attempts_used: 1,
    attempts_remaining: 2,
    retry_allowed: false,
    manual_confirmation_allowed: true,
    confirmation_exists: false,
    failure_code: null,
    requested_at: "2026-07-30T10:00:00+00:00",
    completed_at: "2026-07-30T10:00:02+00:00",
    merchant_name: "Lulu Hypermarket",
    merchant_name_source_text: "Lulu Hypermarket",
    merchant_name_confidence: 0.97,
    currency_code: "AED",
    currency_minor_unit: 2,
    total_minor: 123456,
    warning_codes: ["MISSING_DOCUMENT_NUMBER", "NOT_A_REAL_CODE"],
    line_item_count: 2,
    ...overrides,
  }];
}

describe("request state", () => {
  test("a well-formed row normalizes", () => {
    const result = normalizeExtractionRequestState(requestRow());
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.state.outcome, "QUEUED");
      assert.equal(result.state.attemptsUsed, 1);
      assert.equal(result.state.attemptsRemaining, 2);
    }
  });

  test("zero rows is `empty`, not malformed", () => {
    assert.equal(normalizeExtractionRequestState([]).status, "empty");
  });

  test("an outcome outside the closed set is refused", () => {
    const result = normalizeExtractionRequestState(requestRow({ outcome: "SOMETHING" }));
    assert.equal(result.status, "malformed");
  });

  test("missing counters are refused rather than defaulted", () => {
    // A client rendering "0 of 3 attempts" from a missing value would show a confident wrong
    // number, which is worse than an error.
    for (const key of ["attempts_used", "attempts_remaining", "retry_allowed"]) {
      const row = requestRow();
      delete (row[0] as Record<string, unknown>)[key];
      assert.equal(normalizeExtractionRequestState(row).status, "malformed", key);
    }
  });

  test("a non-array is refused", () => {
    assert.equal(normalizeExtractionRequestState(null).status, "malformed");
    assert.equal(normalizeExtractionRequestState({}).status, "malformed");
  });
});

describe("the extraction view", () => {
  test("a well-formed row normalizes and unknown warning codes are dropped", () => {
    const result = normalizeExtractionView(viewRow());
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.extraction.merchantName.value, "Lulu Hypermarket");
      assert.equal(result.extraction.currencyMinorUnit, 2);
      assert.equal(result.extraction.totalMinor.value, 123456);
      assert.deepEqual([...result.extraction.warningCodes], ["MISSING_DOCUMENT_NUMBER"]);
    }
  });

  test("zero rows is `empty`", () => {
    assert.equal(normalizeExtractionView([]).status, "empty");
  });

  test("an unknown STATUS is refused", () => {
    assert.equal(normalizeExtractionView(viewRow({ status: "PARTIAL" })).status, "malformed");
  });

  test("an INTERNAL failure code reaching the client is refused, not rendered", () => {
    // The projection is supposed to have mapped these away. Seeing one means the mapping
    // regressed, and passing it through would leak the internal vocabulary.
    for (const internal of ["PROVIDER_TIMEOUT", "WORKER_ABANDONED", "OBJECT_UNREADABLE"]) {
      const result = normalizeExtractionView(viewRow({ failure_code: internal }));
      assert.equal(result.status, "malformed", internal);
    }
  });

  test("the three client failure codes are accepted", () => {
    for (const code of ["IMAGE_NOT_A_RECEIPT", "IMAGE_UNUSABLE", "EXTRACTION_UNAVAILABLE"]) {
      const result = normalizeExtractionView(viewRow({ failure_code: code }));
      assert.equal(result.status, "ok", code);
    }
  });

  test("a missing required identifier is refused", () => {
    for (const key of ["submission_id", "extraction_id", "attempt_number"]) {
      const row = viewRow();
      delete (row[0] as Record<string, unknown>)[key];
      assert.equal(normalizeExtractionView(row).status, "malformed", key);
    }
  });
});

describe("line items", () => {
  test("rows normalize and keep their ordinal", () => {
    const result = normalizeExtractionLineItems([
      { line_number: 1, description: "Rice", quantity: 2, unit_price_minor: 4400 },
      { line_number: 2, description: null, quantity: null, unit_price_minor: null },
    ]);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.lineItems.length, 2);
      assert.equal(result.lineItems[0].lineNumber, 1);
      assert.equal(result.lineItems[1].description, null);
    }
  });

  test("an empty list is ok, not malformed", () => {
    const result = normalizeExtractionLineItems([]);
    assert.equal(result.status, "ok");
  });

  test("a row without an ordinal is refused", () => {
    assert.equal(normalizeExtractionLineItems([{ description: "x" }]).status, "malformed");
  });
});

describe("confirmation", () => {
  test("a well-formed row normalizes", () => {
    const result = normalizeConfirmation([{
      confirmation_id: EXTRACTION,
      entry_mode: "MIXED",
      changed_fields: ["total_minor"],
      source_extraction_id: EXTRACTION,
      transaction_date: "2026-07-12",
      currency_code: "AED",
      currency_minor_unit: 2,
      total_minor: 123456,
      confirmed_at: "2026-07-30T10:05:00+00:00",
    }]);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.confirmation.entryMode, "MIXED");
      assert.deepEqual([...result.confirmation.changedFields], ["total_minor"]);
    }
  });

  test("zero rows is `empty`", () => {
    assert.equal(normalizeConfirmation([]).status, "empty");
  });

  test("an unknown entry mode is refused", () => {
    const result = normalizeConfirmation([{
      confirmation_id: EXTRACTION, entry_mode: "PARTIAL",
      transaction_date: "2026-07-12", currency_code: "AED", total_minor: 1,
    }]);
    assert.equal(result.status, "malformed");
  });

  test("missing required values are refused", () => {
    for (const key of ["transaction_date", "currency_code", "total_minor"]) {
      const row: Record<string, unknown> = {
        confirmation_id: EXTRACTION, entry_mode: "MANUAL",
        transaction_date: "2026-07-12", currency_code: "AED", total_minor: 1,
      };
      delete row[key];
      assert.equal(normalizeConfirmation([row]).status, "malformed", key);
    }
  });
});

describe("the outbound success payload", () => {
  const { normalized, lineItems } = buildFixtureExtraction(FAKE_FIXTURES.CLEAN_AED_2);

  test("its keys are EXACTLY the RPC's allowlist", () => {
    const payload = buildSuccessNormalizedPayload(normalized);
    assert.deepEqual(Object.keys(payload).sort(), NORMALIZED_ALLOWLIST);
  });

  test("each line item's keys are EXACTLY the RPC's allowlist", () => {
    const payload = buildSuccessLineItemsPayload(lineItems);
    assert.ok(payload.length > 0);
    for (const item of payload) {
      assert.deepEqual(Object.keys(item).sort(), LINE_ITEM_ALLOWLIST);
    }
  });

  test("it carries no raw payload, no provider error and no free text blob", () => {
    const payload = buildSuccessNormalizedPayload(normalized);
    const serialized = JSON.stringify(payload);
    for (const forbidden of ["raw", "payload", "provider", "error", "http", "blob", "ocr_text"]) {
      assert.ok(!Object.keys(payload).some((key) => key.includes(forbidden)), forbidden);
    }
    assert.ok(!serialized.includes("Deno"));
  });

  test("values carry through exactly", () => {
    const payload = buildSuccessNormalizedPayload(normalized);
    assert.equal(payload.total_minor, 123456);
    assert.equal(payload.currency_code, "AED");
    assert.equal(payload.merchant_name, "Lulu Hypermarket");
  });

  test("warning codes are filtered to the closed set and sorted", () => {
    const payload = buildSuccessNormalizedPayload({
      ...normalized,
      warningCodes: ["ZERO_TOTAL", "MISSING_MERCHANT_NAME"] as never,
    });
    assert.deepEqual(payload.warning_codes, ["MISSING_MERCHANT_NAME", "ZERO_TOTAL"]);
  });

  test("source text is trimmed and bounded so the column CHECK cannot be tripped", () => {
    const payload = buildSuccessNormalizedPayload({
      ...normalized,
      merchantName: {
        value: "Shop",
        sourceText: `  ${"x".repeat(TEXT_BOUNDS.merchant_name_source_text + 200)}  `,
        confidence: 0.5,
      },
    });
    const source = payload.merchant_name_source_text as string;
    assert.ok(source.length <= TEXT_BOUNDS.merchant_name_source_text);
    assert.equal(source, source.trim());
  });

  test("an over-long normalized VALUE is dropped rather than truncated", () => {
    // Truncating a source text costs a reviewer nothing; truncating a value they might
    // confirm would silently store something the receipt does not say.
    const payload = buildSuccessNormalizedPayload({
      ...normalized,
      merchantName: {
        value: "y".repeat(TEXT_BOUNDS.merchant_name + 1),
        sourceText: "y",
        confidence: 0.5,
      },
    });
    assert.equal(payload.merchant_name, null);
  });

  test("out-of-range amounts and confidences are dropped", () => {
    const payload = buildSuccessNormalizedPayload({
      ...normalized,
      total: { minor: -1, sourceText: "x", confidence: 2 },
      subtotal: { minor: 10 ** 13, sourceText: "x", confidence: -1 },
    });
    assert.equal(payload.total_minor, null);
    assert.equal(payload.total_confidence, null);
    assert.equal(payload.subtotal_minor, null);
    assert.equal(payload.subtotal_confidence, null);
  });

  test("line items are renumbered densely from 1 and capped", () => {
    const many: NormalizedLineItem[] = Array.from({ length: MAX_LINE_ITEMS + 25 }, (_, index) => ({
      lineNumber: 900 + index,
      description: `Item ${index}`,
      descriptionSourceText: null,
      quantity: 1,
      quantitySourceText: null,
      unitPriceMinor: 1,
      unitPriceSourceText: null,
      lineTotalMinor: 1,
      lineTotalSourceText: null,
      confidence: 0.5,
    }));
    const payload = buildSuccessLineItemsPayload(many);
    assert.equal(payload.length, MAX_LINE_ITEMS);
    assert.equal(payload[0].line_number, 1);
    assert.equal(payload[MAX_LINE_ITEMS - 1].line_number, MAX_LINE_ITEMS);
  });
});
