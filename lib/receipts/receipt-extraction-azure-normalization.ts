/**
 * PURE MODULE — no network, environment, database, filesystem, logging or clock access.
 *
 * Converts one successful Azure Document Intelligence analyzeResult into the existing
 * provider-neutral SalesReward extraction shape.
 *
 * RAW PROVIDER PAYLOADS NEVER LEAVE THIS FUNCTION. Only explicitly selected normalized
 * fields, source text, confidence values, warnings and line items are returned.
 *
 * MONEY IS NEVER CALCULATED WITH FLOATING POINT. Azure's printed field content is passed
 * through the existing exact receipt amount parser together with the ISO currency minor
 * unit. The standardized valueCurrency.amount is deliberately not multiplied by 10^n.
 */

import {
  hasSubtotalTaxTotalMismatch,
  parseAmountToMinor,
} from "./receipt-amount-parsing.ts";
import {
  AZURE_DOCUMENT_INTELLIGENCE_INVOICE_MODEL,
  type AzureDocumentIntelligenceModel,
} from "./receipt-extraction-azure-config.ts";
import type {
  NormalizedAmount,
  NormalizedDate,
  NormalizedExtraction,
  NormalizedLineItem,
  NormalizedText,
  NormalizedTime,
} from "./receipt-extraction-provider.ts";
import {
  MAX_LINE_ITEMS,
  type ExtractionFailureCode,
  type ExtractionWarningCode,
} from "./receipt-extraction-vocabulary.ts";
import {
  isIsoCurrencyCode,
  isoCurrencyMinorUnit,
} from "../reference/iso-currency-codes.ts";

/**
 * A confidence below 0.80 receives a review warning.
 *
 * This is a review hint, not an acceptance boundary. Low-confidence values are still
 * displayed and can be corrected by the staff member before confirmation.
 */
export const AZURE_LOW_CONFIDENCE_THRESHOLD = 0.8;

export type AzureAnalyzeResultNormalization =
  | {
      readonly status: "succeeded";
      readonly normalized: NormalizedExtraction;
      readonly lineItems: readonly NormalizedLineItem[];
    }
  | {
      readonly status: "failed";
      readonly failureCode: ExtractionFailureCode;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    )
    ? value as Record<string, unknown>
    : null;
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function confidence(field: Record<string, unknown> | null): number | null {
  if (field === null) return null;
  const value = field.confidence;

  return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1
    )
    ? value
    : null;
}

function fieldContent(field: Record<string, unknown> | null): string | null {
  return field === null ? null : optionalText(field.content);
}

function field(
  fields: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> | null {
  for (const name of names) {
    const candidate = asRecord(fields[name]);
    if (candidate !== null) return candidate;
  }
  return null;
}

function uniquePush(
  warnings: ExtractionWarningCode[],
  warning: ExtractionWarningCode,
): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function normalizedText(
  sourceField: Record<string, unknown> | null,
): NormalizedText {
  if (sourceField === null) {
    return { value: null, sourceText: null, confidence: null };
  }

  const sourceText = fieldContent(sourceField);
  const value = optionalText(sourceField.valueString) ?? sourceText;

  return {
    value,
    sourceText,
    confidence: value === null ? null : confidence(sourceField),
  };
}

function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);

  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizedDate(
  sourceField: Record<string, unknown> | null,
): NormalizedDate {
  if (sourceField === null) {
    return { value: null, sourceText: null, confidence: null };
  }

  const sourceText = fieldContent(sourceField);
  const candidate = sourceField.valueDate;
  const value = isIsoCalendarDate(candidate) ? candidate : null;

  return {
    value,
    sourceText,
    confidence: value === null ? null : confidence(sourceField),
  };
}

function normalizedTime(
  sourceField: Record<string, unknown> | null,
): NormalizedTime {
  if (sourceField === null) {
    return { value: null, sourceText: null, confidence: null };
  }

  const sourceText = fieldContent(sourceField);
  const rawValue = optionalText(sourceField.valueTime);

  if (rawValue === null) {
    return { value: null, sourceText, confidence: null };
  }

  const match =
    /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/
      .exec(rawValue);

  const value = match === null ? null : `${match[1]}:${match[2]}`;

  return {
    value,
    sourceText,
    confidence: value === null ? null : confidence(sourceField),
  };
}

function currencyObject(
  sourceField: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return sourceField === null ? null : asRecord(sourceField.valueCurrency);
}

function currencyCodeFromContent(content: string | null): string | null {
  if (content === null) return null;

  const codes = new Set<string>();

  for (const match of content.matchAll(/(?:^|[^A-Z])([A-Z]{3})(?=$|[^A-Z])/g)) {
    if (isIsoCurrencyCode(match[1])) codes.add(match[1]);
  }

  return codes.size === 1 ? [...codes][0] : null;
}

function currencyCodeFromField(
  sourceField: Record<string, unknown> | null,
): string | null {
  const valueCurrency = currencyObject(sourceField);
  const rawCode = optionalText(valueCurrency?.currencyCode);
  const normalizedCode = rawCode?.toUpperCase() ?? null;

  if (normalizedCode !== null && isIsoCurrencyCode(normalizedCode)) {
    return normalizedCode;
  }

  return currencyCodeFromContent(fieldContent(sourceField));
}

function currencySourceText(
  sourceField: Record<string, unknown> | null,
  code: string,
): string {
  const valueCurrency = currencyObject(sourceField);

  return (
    optionalText(valueCurrency?.currencySymbol) ??
    optionalText(valueCurrency?.currencyCode) ??
    code
  );
}

function resolveCurrency(
  candidates: readonly (Record<string, unknown> | null)[],
): NormalizedText {
  const byCode = new Map<string, Record<string, unknown>>();

  for (const candidate of candidates) {
    const code = currencyCodeFromField(candidate);
    if (code !== null && candidate !== null && !byCode.has(code)) {
      byCode.set(code, candidate);
    }
  }

  // Conflicting currencies are never guessed. The reviewer must select the currency.
  if (byCode.size !== 1) {
    return { value: null, sourceText: null, confidence: null };
  }

  const [code, sourceField] = [...byCode.entries()][0];

  return {
    value: code,
    sourceText: currencySourceText(sourceField, code),
    confidence: confidence(sourceField),
  };
}

function normalizedAmount(
  sourceField: Record<string, unknown> | null,
  minorUnit: number | null,
  warnings?: ExtractionWarningCode[],
): NormalizedAmount {
  if (sourceField === null) {
    return { minor: null, sourceText: null, confidence: null };
  }

  const sourceText = fieldContent(sourceField);

  if (sourceText === null || minorUnit === null) {
    return { minor: null, sourceText, confidence: null };
  }

  const parsed = parseAmountToMinor(sourceText, minorUnit);

  if (parsed.status !== "ok") {
    if (warnings !== undefined && parsed.warning !== null) {
      uniquePush(warnings, parsed.warning);
    }

    return { minor: null, sourceText, confidence: null };
  }

  return {
    minor: parsed.minor,
    sourceText,
    confidence: confidence(sourceField),
  };
}

function numberValue(
  sourceField: Record<string, unknown> | null,
): number | null {
  if (sourceField === null) return null;

  const value = sourceField.valueNumber;

  return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0
    )
    ? value
    : null;
}

function combinedText(
  productCode: string | null,
  description: string | null,
): string | null {
  if (productCode !== null && description !== null) {
    return `${productCode} — ${description}`;
  }

  return productCode ?? description;
}

function minimumConfidence(
  values: readonly (number | null)[],
): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.min(...present);
}

function itemObject(
  value: unknown,
): Record<string, unknown> | null {
  const itemField = asRecord(value);
  return itemField === null ? null : asRecord(itemField.valueObject);
}

function itemCurrencyFields(
  itemsField: Record<string, unknown> | null,
  invoice: boolean,
): Record<string, unknown>[] {
  if (itemsField === null || !Array.isArray(itemsField.valueArray)) return [];

  const out: Record<string, unknown>[] = [];

  for (const rawItem of itemsField.valueArray.slice(0, MAX_LINE_ITEMS)) {
    const item = itemObject(rawItem);
    if (item === null) continue;

    const unitPrice = field(
      item,
      invoice ? ["UnitPrice"] : ["Price"],
    );
    const lineTotal = field(
      item,
      invoice ? ["Amount"] : ["TotalPrice"],
    );

    if (unitPrice !== null) out.push(unitPrice);
    if (lineTotal !== null) out.push(lineTotal);
  }

  return out;
}

function normalizeLineItems(input: {
  readonly itemsField: Record<string, unknown> | null;
  readonly invoice: boolean;
  readonly minorUnit: number | null;
}): NormalizedLineItem[] {
  if (
    input.itemsField === null ||
    !Array.isArray(input.itemsField.valueArray)
  ) {
    return [];
  }

  const lineItems: NormalizedLineItem[] = [];

  for (
    const rawItem of input.itemsField.valueArray.slice(0, MAX_LINE_ITEMS)
  ) {
    const itemField = asRecord(rawItem);
    const item = itemField === null ? null : asRecord(itemField.valueObject);
    if (item === null) continue;

    const descriptionField = field(item, ["Description"]);
    const productCodeField = field(item, ["ProductCode"]);
    const quantityField = field(item, ["Quantity"]);

    const unitPriceField = field(
      item,
      input.invoice ? ["UnitPrice"] : ["Price"],
    );
    const lineTotalField = field(
      item,
      input.invoice ? ["Amount"] : ["TotalPrice"],
    );

    const description = combinedText(
      normalizedText(productCodeField).value,
      normalizedText(descriptionField).value,
    );

    const descriptionSourceText = combinedText(
      fieldContent(productCodeField),
      fieldContent(descriptionField),
    );

    const unitPrice = normalizedAmount(
      unitPriceField,
      input.minorUnit,
    );
    const lineTotal = normalizedAmount(
      lineTotalField,
      input.minorUnit,
    );

    lineItems.push({
      lineNumber: lineItems.length + 1,
      description,
      descriptionSourceText,
      quantity: numberValue(quantityField),
      quantitySourceText: fieldContent(quantityField),
      unitPriceMinor: unitPrice.minor,
      unitPriceSourceText: unitPrice.sourceText,
      lineTotalMinor: lineTotal.minor,
      lineTotalSourceText: lineTotal.sourceText,
      confidence: minimumConfidence([
        confidence(itemField),
        confidence(productCodeField),
        confidence(descriptionField),
        confidence(quantityField),
        confidence(unitPriceField),
        confidence(lineTotalField),
      ]),
    });
  }

  return lineItems;
}

/**
 * Normalizes the `analyzeResult` member of a successful Azure operation response.
 *
 * `today` is injected as YYYY-MM-DD so the module reads no clock and future-date behavior
 * is deterministic under test.
 */
export function normalizeAzureAnalyzeResult(input: {
  readonly analyzeResult: unknown;
  readonly model: AzureDocumentIntelligenceModel;
  readonly today: string;
}): AzureAnalyzeResultNormalization {
  if (!isIsoCalendarDate(input.today)) {
    return { status: "failed", failureCode: "NORMALIZATION_FAILED" };
  }

  const analyzeResult = asRecord(input.analyzeResult);

  if (
    analyzeResult === null ||
    analyzeResult.modelId !== input.model ||
    !Array.isArray(analyzeResult.documents)
  ) {
    return { status: "failed", failureCode: "NORMALIZATION_FAILED" };
  }

  const document = asRecord(analyzeResult.documents[0]);
  const fields = document === null ? null : asRecord(document.fields);

  if (fields === null) {
    return {
      status: "failed",
      failureCode: "PROVIDER_REJECTED_DOCUMENT",
    };
  }

  const invoice =
    input.model === AZURE_DOCUMENT_INTELLIGENCE_INVOICE_MODEL;

  const merchantField = field(
    fields,
    invoice ? ["VendorName"] : ["MerchantName"],
  );
  const documentNumberField = field(
    fields,
    invoice ? ["InvoiceId"] : [],
  );
  const dateField = field(
    fields,
    invoice ? ["InvoiceDate"] : ["TransactionDate"],
  );
  // TransactionTime is not a standard invoice field, but accepting it when present is safe.
  const timeField = field(fields, ["TransactionTime"]);

  const totalField = field(
    fields,
    invoice ? ["InvoiceTotal"] : ["Total"],
  );
  const subtotalField = field(
    fields,
    invoice ? ["SubTotal"] : ["Subtotal"],
  );
  const taxField = field(fields, ["TotalTax"]);
  const itemsField = field(fields, ["Items"]);

  const currency = resolveCurrency([
    totalField,
    subtotalField,
    taxField,
    ...itemCurrencyFields(itemsField, invoice),
  ]);

  const minorUnit =
    currency.value === null
      ? null
      : isoCurrencyMinorUnit(currency.value);

  const warnings: ExtractionWarningCode[] = [];

  const merchantName = normalizedText(merchantField);
  const documentNumber = normalizedText(documentNumberField);
  const transactionDate = normalizedDate(dateField);
  const transactionTime = normalizedTime(timeField);

  const total = normalizedAmount(totalField, minorUnit, warnings);
  const subtotal = normalizedAmount(
    subtotalField,
    minorUnit,
    warnings,
  );
  const taxTotal = normalizedAmount(taxField, minorUnit, warnings);

  const lineItems = normalizeLineItems({
    itemsField,
    invoice,
    minorUnit,
  });

  const hasMaterialResult =
    merchantName.value !== null ||
    documentNumber.value !== null ||
    transactionDate.value !== null ||
    total.sourceText !== null ||
    lineItems.length > 0;

  if (!hasMaterialResult) {
    return {
      status: "failed",
      failureCode: "PROVIDER_REJECTED_DOCUMENT",
    };
  }

  if (merchantName.value === null) {
    uniquePush(warnings, "MISSING_MERCHANT_NAME");
  }
  if (documentNumber.value === null) {
    uniquePush(warnings, "MISSING_DOCUMENT_NUMBER");
  }
  if (transactionTime.value === null) {
    uniquePush(warnings, "MISSING_TRANSACTION_TIME");
  }

  if (
    total.confidence !== null &&
    total.confidence < AZURE_LOW_CONFIDENCE_THRESHOLD
  ) {
    uniquePush(warnings, "LOW_CONFIDENCE_TOTAL");
  }

  if (
    transactionDate.confidence !== null &&
    transactionDate.confidence < AZURE_LOW_CONFIDENCE_THRESHOLD
  ) {
    uniquePush(warnings, "LOW_CONFIDENCE_DATE");
  }

  if (
    transactionDate.value !== null &&
    transactionDate.value > input.today
  ) {
    uniquePush(warnings, "DATE_IN_FUTURE");
  }

  if (total.minor === 0) {
    uniquePush(warnings, "ZERO_TOTAL");
  }

  if (
    hasSubtotalTaxTotalMismatch(
      subtotal.minor,
      taxTotal.minor,
      total.minor,
    )
  ) {
    uniquePush(warnings, "SUBTOTAL_TAX_TOTAL_MISMATCH");
  }

  return {
    status: "succeeded",
    normalized: {
      merchantName,
      documentNumber,
      transactionDate,
      transactionTime,
      currencyCode: currency,
      total,
      subtotal,
      taxTotal,
      warningCodes: warnings,
    },
    lineItems,
  };
}
