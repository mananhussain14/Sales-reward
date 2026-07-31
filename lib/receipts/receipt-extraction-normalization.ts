/**
 * PURE MODULE — no imports beyond siblings, no I/O, no environment, no side effects.
 *
 * TWO JOBS, BOTH ABOUT THE BOUNDARY WITH POSTGREST:
 *
 *   1. INBOUND. Validates and camel-cases the rows the authenticated read RPCs return.
 *      `supabase.rpc()` is untyped in this project (there are no generated database types),
 *      so its result is `any`. A type assertion would be a claim about the SQL rather than
 *      a check of it, and TypeScript erases it at runtime. These functions check.
 *
 *   2. OUTBOUND. Builds the two jsonb documents `record_receipt_extraction_success` accepts,
 *      using EXACTLY the keys its allowlist admits. The RPC refuses an unknown key with
 *      23514, so a mismatch here is a hard failure rather than a silently dropped field —
 *      but building the document in one audited place is what stops the mismatch happening.
 *
 * NOTHING UNSAFE PASSES THROUGH, BECAUSE NOTHING UNSAFE ARRIVES. get_my_receipt_extraction
 * returns no provider, provider model, provider operation id, claim token, expiry, storage
 * bucket, object path, file hash or internal failure code — so there is nothing of that kind
 * here to drop. The absence is enforced in SQL and asserted by the pgTAP projection tests;
 * this module simply has no field for any of them.
 */

import {
  MAX_LINE_ITEMS,
  MAX_MINOR_AMOUNT,
  TEXT_BOUNDS,
  isClientExtractionFailureCode,
  isConfirmationEntryMode,
  isExtractionRequestOutcome,
  isExtractionStatus,
  isExtractionWarningCode,
  type ClientExtractionFailureCode,
  type ConfirmationEntryMode,
  type ExtractionRequestOutcome,
  type ExtractionStatus,
  type ExtractionWarningCode,
} from "./receipt-extraction-vocabulary.ts";
import type {
  NormalizedExtraction,
  NormalizedLineItem,
} from "./receipt-extraction-provider.ts";

/* ---------------------------------------------------------------------------
 * Small runtime readers
 * ------------------------------------------------------------------------- */

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredText(value: unknown): string | null {
  return optionalText(value);
}

function optionalInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function optionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function warningCodes(value: unknown): ExtractionWarningCode[] {
  if (!Array.isArray(value)) return [];
  const out: ExtractionWarningCode[] = [];
  for (const entry of value) {
    if (isExtractionWarningCode(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function changedFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/* ---------------------------------------------------------------------------
 * INBOUND — request_receipt_extraction
 * ------------------------------------------------------------------------- */

export type ExtractionRequestState = {
  readonly outcome: ExtractionRequestOutcome;
  readonly extractionId: string | null;
  readonly attemptNumber: number | null;
  readonly attemptsUsed: number;
  readonly attemptsRemaining: number;
  readonly retryAllowed: boolean;
  readonly manualConfirmationAllowed: boolean;
};

export type RequestStateNormalization =
  | { readonly status: "ok"; readonly state: ExtractionRequestState }
  | { readonly status: "empty" }
  | { readonly status: "malformed"; readonly reason: string };

export function normalizeExtractionRequestState(data: unknown): RequestStateNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };
  if (data.length === 0) return { status: "empty" };

  const row = data[0];
  if (typeof row !== "object" || row === null) {
    return { status: "malformed", reason: "row-not-an-object" };
  }
  const record = row as Record<string, unknown>;

  const outcome = record.outcome;
  if (!isExtractionRequestOutcome(outcome)) {
    return { status: "malformed", reason: "outcome" };
  }

  const attemptsUsed = optionalInteger(record.attempts_used);
  const attemptsRemaining = optionalInteger(record.attempts_remaining);
  const retryAllowed = optionalBoolean(record.retry_allowed);
  const manualAllowed = optionalBoolean(record.manual_confirmation_allowed);

  // These four are structural: a client that renders a retry button or an attempt counter
  // from a missing value would show a confident wrong number.
  if (attemptsUsed === null) return { status: "malformed", reason: "attempts_used" };
  if (attemptsRemaining === null) return { status: "malformed", reason: "attempts_remaining" };
  if (retryAllowed === null) return { status: "malformed", reason: "retry_allowed" };
  if (manualAllowed === null) {
    return { status: "malformed", reason: "manual_confirmation_allowed" };
  }

  return {
    status: "ok",
    state: {
      outcome,
      extractionId: optionalText(record.extraction_id),
      attemptNumber: optionalInteger(record.attempt_number),
      attemptsUsed,
      attemptsRemaining,
      retryAllowed,
      manualConfirmationAllowed: manualAllowed,
    },
  };
}

/* ---------------------------------------------------------------------------
 * INBOUND — get_my_receipt_extraction
 * ------------------------------------------------------------------------- */

export type ReviewedField<TValue> = {
  readonly value: TValue | null;
  readonly sourceText: string | null;
  readonly confidence: number | null;
};

export type ExtractionView = {
  readonly submissionId: string;
  readonly extractionId: string;
  readonly status: ExtractionStatus;
  readonly attemptNumber: number;
  readonly attemptsUsed: number;
  readonly attemptsRemaining: number;
  readonly retryAllowed: boolean;
  readonly manualConfirmationAllowed: boolean;
  readonly confirmationExists: boolean;
  readonly failureCode: ClientExtractionFailureCode | null;
  readonly requestedAt: string | null;
  readonly completedAt: string | null;

  readonly merchantName: ReviewedField<string>;
  readonly documentNumber: ReviewedField<string>;
  readonly transactionDate: ReviewedField<string>;
  readonly transactionTime: ReviewedField<string>;
  readonly currencyCode: ReviewedField<string>;
  readonly currencyMinorUnit: number | null;
  readonly totalMinor: ReviewedField<number>;
  readonly subtotalMinor: ReviewedField<number>;
  readonly taxTotalMinor: ReviewedField<number>;

  readonly warningCodes: readonly ExtractionWarningCode[];
  readonly lineItemCount: number;
};

export type ExtractionViewNormalization =
  | { readonly status: "ok"; readonly extraction: ExtractionView }
  | { readonly status: "empty" }
  | { readonly status: "malformed"; readonly reason: string };

export function normalizeExtractionView(data: unknown): ExtractionViewNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };
  if (data.length === 0) return { status: "empty" };

  const row = data[0];
  if (typeof row !== "object" || row === null) {
    return { status: "malformed", reason: "row-not-an-object" };
  }
  const record = row as Record<string, unknown>;

  const submissionId = requiredText(record.submission_id);
  const extractionId = requiredText(record.extraction_id);
  const status = record.status;
  const attemptNumber = optionalInteger(record.attempt_number);
  const attemptsUsed = optionalInteger(record.attempts_used);
  const attemptsRemaining = optionalInteger(record.attempts_remaining);
  const retryAllowed = optionalBoolean(record.retry_allowed);
  const manualAllowed = optionalBoolean(record.manual_confirmation_allowed);
  const confirmationExists = optionalBoolean(record.confirmation_exists);

  if (submissionId === null) return { status: "malformed", reason: "submission_id" };
  if (extractionId === null) return { status: "malformed", reason: "extraction_id" };
  if (!isExtractionStatus(status)) return { status: "malformed", reason: "status" };
  if (attemptNumber === null) return { status: "malformed", reason: "attempt_number" };
  if (attemptsUsed === null) return { status: "malformed", reason: "attempts_used" };
  if (attemptsRemaining === null) return { status: "malformed", reason: "attempts_remaining" };
  if (retryAllowed === null) return { status: "malformed", reason: "retry_allowed" };
  if (manualAllowed === null) {
    return { status: "malformed", reason: "manual_confirmation_allowed" };
  }
  if (confirmationExists === null) {
    return { status: "malformed", reason: "confirmation_exists" };
  }

  const rawFailure = record.failure_code;
  // An unrecognised failure code is refused rather than passed through: the client
  // vocabulary is closed, and rendering an unknown string would be rendering an internal
  // value the projection is supposed to have mapped away.
  if (rawFailure !== null && rawFailure !== undefined && !isClientExtractionFailureCode(rawFailure)) {
    return { status: "malformed", reason: "failure_code" };
  }

  const field = <TValue>(
    valueKey: string,
    sourceKey: string,
    confidenceKey: string,
    read: (value: unknown) => TValue | null,
  ): ReviewedField<TValue> => ({
    value: read(record[valueKey]),
    sourceText: optionalText(record[sourceKey]),
    confidence: optionalNumber(record[confidenceKey]),
  });

  return {
    status: "ok",
    extraction: {
      submissionId,
      extractionId,
      status,
      attemptNumber,
      attemptsUsed,
      attemptsRemaining,
      retryAllowed,
      manualConfirmationAllowed: manualAllowed,
      confirmationExists,
      failureCode: isClientExtractionFailureCode(rawFailure) ? rawFailure : null,
      requestedAt: optionalText(record.requested_at),
      completedAt: optionalText(record.completed_at),

      merchantName: field(
        "merchant_name",
        "merchant_name_source_text",
        "merchant_name_confidence",
        optionalText,
      ),
      documentNumber: field(
        "document_number",
        "document_number_source_text",
        "document_number_confidence",
        optionalText,
      ),
      transactionDate: field(
        "transaction_date",
        "transaction_date_source_text",
        "transaction_date_confidence",
        optionalText,
      ),
      transactionTime: field(
        "transaction_time",
        "transaction_time_source_text",
        "transaction_time_confidence",
        optionalText,
      ),
      currencyCode: field(
        "currency_code",
        "currency_code_source_text",
        "currency_code_confidence",
        optionalText,
      ),
      currencyMinorUnit: optionalInteger(record.currency_minor_unit),
      totalMinor: field("total_minor", "total_source_text", "total_confidence", optionalInteger),
      subtotalMinor: field(
        "subtotal_minor",
        "subtotal_source_text",
        "subtotal_confidence",
        optionalInteger,
      ),
      taxTotalMinor: field(
        "tax_total_minor",
        "tax_source_text",
        "tax_confidence",
        optionalInteger,
      ),

      warningCodes: warningCodes(record.warning_codes),
      lineItemCount: optionalInteger(record.line_item_count) ?? 0,
    },
  };
}

/* ---------------------------------------------------------------------------
 * INBOUND — list_my_receipt_extraction_line_items
 * ------------------------------------------------------------------------- */

export type LineItemView = {
  readonly lineNumber: number;
  readonly description: string | null;
  readonly descriptionSourceText: string | null;
  readonly quantity: number | null;
  readonly quantitySourceText: string | null;
  readonly unitPriceMinor: number | null;
  readonly unitPriceSourceText: string | null;
  readonly lineTotalMinor: number | null;
  readonly lineTotalSourceText: string | null;
  readonly confidence: number | null;
};

export type LineItemsNormalization =
  | { readonly status: "ok"; readonly lineItems: LineItemView[] }
  | { readonly status: "malformed"; readonly reason: string };

export function normalizeExtractionLineItems(data: unknown): LineItemsNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };

  const lineItems: LineItemView[] = [];

  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      return { status: "malformed", reason: "row-not-an-object" };
    }
    const record = row as Record<string, unknown>;
    const lineNumber = optionalInteger(record.line_number);
    if (lineNumber === null) return { status: "malformed", reason: "line_number" };

    lineItems.push({
      lineNumber,
      description: optionalText(record.description),
      descriptionSourceText: optionalText(record.description_source_text),
      quantity: optionalNumber(record.quantity),
      quantitySourceText: optionalText(record.quantity_source_text),
      unitPriceMinor: optionalInteger(record.unit_price_minor),
      unitPriceSourceText: optionalText(record.unit_price_source_text),
      lineTotalMinor: optionalInteger(record.line_total_minor),
      lineTotalSourceText: optionalText(record.line_total_source_text),
      confidence: optionalNumber(record.confidence),
    });
  }

  return { status: "ok", lineItems };
}

/* ---------------------------------------------------------------------------
 * INBOUND — get_my_receipt_confirmation
 * ------------------------------------------------------------------------- */

export type ConfirmationView = {
  readonly confirmationId: string;
  readonly entryMode: ConfirmationEntryMode;
  readonly changedFields: readonly string[];
  readonly sourceExtractionId: string | null;
  readonly transactionDate: string;
  readonly transactionTime: string | null;
  readonly currencyCode: string;
  readonly currencyMinorUnit: number | null;
  readonly totalMinor: number;
  readonly subtotalMinor: number | null;
  readonly taxTotalMinor: number | null;
  readonly merchantName: string | null;
  readonly documentNumber: string | null;
  readonly confirmedAt: string | null;
};

export type ConfirmationNormalization =
  | { readonly status: "ok"; readonly confirmation: ConfirmationView }
  | { readonly status: "empty" }
  | { readonly status: "malformed"; readonly reason: string };

export function normalizeConfirmation(data: unknown): ConfirmationNormalization {
  if (!Array.isArray(data)) return { status: "malformed", reason: "not-an-array" };
  if (data.length === 0) return { status: "empty" };

  const row = data[0];
  if (typeof row !== "object" || row === null) {
    return { status: "malformed", reason: "row-not-an-object" };
  }
  const record = row as Record<string, unknown>;

  const confirmationId = requiredText(record.confirmation_id);
  const entryMode = record.entry_mode;
  const transactionDate = requiredText(record.transaction_date);
  const currencyCode = requiredText(record.currency_code);
  const totalMinor = optionalInteger(record.total_minor);

  if (confirmationId === null) return { status: "malformed", reason: "confirmation_id" };
  if (!isConfirmationEntryMode(entryMode)) return { status: "malformed", reason: "entry_mode" };
  if (transactionDate === null) return { status: "malformed", reason: "transaction_date" };
  if (currencyCode === null) return { status: "malformed", reason: "currency_code" };
  if (totalMinor === null) return { status: "malformed", reason: "total_minor" };

  return {
    status: "ok",
    confirmation: {
      confirmationId,
      entryMode,
      changedFields: changedFields(record.changed_fields),
      sourceExtractionId: optionalText(record.source_extraction_id),
      transactionDate,
      transactionTime: optionalText(record.transaction_time),
      currencyCode,
      currencyMinorUnit: optionalInteger(record.currency_minor_unit),
      totalMinor,
      subtotalMinor: optionalInteger(record.subtotal_minor),
      taxTotalMinor: optionalInteger(record.tax_total_minor),
      merchantName: optionalText(record.merchant_name),
      documentNumber: optionalText(record.document_number),
      confirmedAt: optionalText(record.confirmed_at),
    },
  };
}

/* ---------------------------------------------------------------------------
 * OUTBOUND — the two jsonb documents record_receipt_extraction_success accepts
 * ------------------------------------------------------------------------- */

/**
 * Trims and bounds one source-text value.
 *
 * Truncation is acceptable HERE and only here: source text is display material shown beside
 * an editable field, so a clipped 500th character costs a reviewer nothing, whereas
 * exceeding the column bound would fail the whole extraction over a cosmetic value. Nothing
 * that participates in a comparison or a stored amount is ever truncated.
 */
function boundedSourceText(value: string | null, bound: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= bound ? trimmed : trimmed.slice(0, bound).trim();
}

function boundedValue(value: string | null, bound: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > bound) return null;
  return trimmed;
}

function boundedMinor(value: number | null): number | null {
  if (value === null || !Number.isSafeInteger(value)) return null;
  if (value < 0 || value > MAX_MINOR_AMOUNT) return null;
  return value;
}

function boundedConfidence(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  // Three decimal places, matching numeric(4,3). Rounded here rather than in SQL so the
  // value the RPC receives is already the value the column will hold.
  return Math.round(value * 1000) / 1000;
}

/**
 * Builds `p_normalized`.
 *
 * The key set is EXACTLY the allowlist `record_receipt_extraction_success` admits. An extra
 * key is 23514 there, so this function and that allowlist are two statements of one
 * contract, and receipt-extraction-safety.test.ts compares them.
 */
export function buildSuccessNormalizedPayload(
  normalized: NormalizedExtraction,
): Record<string, unknown> {
  return {
    merchant_name: boundedValue(normalized.merchantName.value, TEXT_BOUNDS.merchant_name),
    merchant_name_source_text: boundedSourceText(
      normalized.merchantName.sourceText,
      TEXT_BOUNDS.merchant_name_source_text,
    ),
    merchant_name_confidence: boundedConfidence(normalized.merchantName.confidence),

    document_number: boundedValue(normalized.documentNumber.value, TEXT_BOUNDS.document_number),
    document_number_source_text: boundedSourceText(
      normalized.documentNumber.sourceText,
      TEXT_BOUNDS.document_number_source_text,
    ),
    document_number_confidence: boundedConfidence(normalized.documentNumber.confidence),

    transaction_date: normalized.transactionDate.value,
    transaction_date_source_text: boundedSourceText(
      normalized.transactionDate.sourceText,
      TEXT_BOUNDS.transaction_date_source_text,
    ),
    transaction_date_confidence: boundedConfidence(normalized.transactionDate.confidence),

    transaction_time: normalized.transactionTime.value,
    transaction_time_source_text: boundedSourceText(
      normalized.transactionTime.sourceText,
      TEXT_BOUNDS.transaction_time_source_text,
    ),
    transaction_time_confidence: boundedConfidence(normalized.transactionTime.confidence),

    currency_code: normalized.currencyCode.value,
    currency_code_source_text: boundedSourceText(
      normalized.currencyCode.sourceText,
      TEXT_BOUNDS.currency_code_source_text,
    ),
    currency_code_confidence: boundedConfidence(normalized.currencyCode.confidence),

    total_minor: boundedMinor(normalized.total.minor),
    total_source_text: boundedSourceText(
      normalized.total.sourceText,
      TEXT_BOUNDS.total_source_text,
    ),
    total_confidence: boundedConfidence(normalized.total.confidence),

    subtotal_minor: boundedMinor(normalized.subtotal.minor),
    subtotal_source_text: boundedSourceText(
      normalized.subtotal.sourceText,
      TEXT_BOUNDS.subtotal_source_text,
    ),
    subtotal_confidence: boundedConfidence(normalized.subtotal.confidence),

    tax_total_minor: boundedMinor(normalized.taxTotal.minor),
    tax_source_text: boundedSourceText(normalized.taxTotal.sourceText, TEXT_BOUNDS.tax_source_text),
    tax_confidence: boundedConfidence(normalized.taxTotal.confidence),

    warning_codes: [...normalized.warningCodes].filter(isExtractionWarningCode).sort(),
  };
}

/** Builds `p_line_items`. Capped at MAX_LINE_ITEMS, and renumbered densely from 1. */
export function buildSuccessLineItemsPayload(
  lineItems: readonly NormalizedLineItem[],
): Record<string, unknown>[] {
  return lineItems.slice(0, MAX_LINE_ITEMS).map((item, index) => ({
    line_number: index + 1,
    description: boundedValue(item.description, TEXT_BOUNDS.line_item_description),
    description_source_text: boundedSourceText(
      item.descriptionSourceText,
      TEXT_BOUNDS.line_item_description_source_text,
    ),
    quantity:
      item.quantity === null || !Number.isFinite(item.quantity) || item.quantity < 0
        ? null
        : Math.round(item.quantity * 1000) / 1000,
    quantity_source_text: boundedSourceText(
      item.quantitySourceText,
      TEXT_BOUNDS.line_item_quantity_source_text,
    ),
    unit_price_minor: boundedMinor(item.unitPriceMinor),
    unit_price_source_text: boundedSourceText(
      item.unitPriceSourceText,
      TEXT_BOUNDS.line_item_unit_price_source_text,
    ),
    line_total_minor: boundedMinor(item.lineTotalMinor),
    line_total_source_text: boundedSourceText(
      item.lineTotalSourceText,
      TEXT_BOUNDS.line_item_line_total_source_text,
    ),
    confidence: boundedConfidence(item.confidence),
  }));
}
