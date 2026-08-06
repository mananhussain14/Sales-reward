import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AZURE_LOW_CONFIDENCE_THRESHOLD,
  normalizeAzureAnalyzeResult,
} from "./receipt-extraction-azure-normalization.ts";

function invoiceResult() {
  return {
    modelId: "prebuilt-invoice",
    documents: [
      {
        docType: "invoice",
        fields: {
          VendorName: {
            type: "string",
            valueString: "BASIC",
            content: "BASIC",
            confidence: 0.99,
          },
          InvoiceId: {
            type: "string",
            valueString: "A246",
            content: "A246",
            confidence: 0.98,
          },
          InvoiceDate: {
            type: "date",
            valueDate: "2026-08-01",
            content: "01/08/2026",
            confidence: 0.95,
          },
          InvoiceTotal: {
            type: "currency",
            valueCurrency: {
              amount: 356.4,
              currencyCode: "AED",
              currencySymbol: "AED",
            },
            content: "AED 356.40",
            confidence: 0.96,
          },
          SubTotal: {
            type: "currency",
            valueCurrency: {
              amount: 300,
              currencyCode: "AED",
            },
            content: "300.00",
            confidence: 0.95,
          },
          TotalTax: {
            type: "currency",
            valueCurrency: {
              amount: 11.4,
              currencyCode: "AED",
            },
            content: "11.40",
            confidence: 0.94,
          },
          Items: {
            type: "array",
            valueArray: [
              {
                type: "object",
                confidence: 0.93,
                valueObject: {
                  ProductCode: {
                    type: "string",
                    valueString: "SKU-100",
                    content: "SKU-100",
                    confidence: 0.97,
                  },
                  Description: {
                    type: "string",
                    valueString: "Sales reward product",
                    content: "Sales reward product",
                    confidence: 0.96,
                  },
                  Quantity: {
                    type: "number",
                    valueNumber: 2,
                    content: "2",
                    confidence: 0.95,
                  },
                  UnitPrice: {
                    type: "currency",
                    valueCurrency: {
                      amount: 50,
                      currencyCode: "AED",
                    },
                    content: "50.00",
                    confidence: 0.94,
                  },
                  Amount: {
                    type: "currency",
                    valueCurrency: {
                      amount: 100,
                      currencyCode: "AED",
                    },
                    content: "100.00",
                    confidence: 0.93,
                  },
                },
              },
            ],
          },
        },
      },
    ],
  };
}

describe("Azure analyze-result normalization", () => {
  test("declares the review confidence threshold explicitly", () => {
    assert.equal(AZURE_LOW_CONFIDENCE_THRESHOLD, 0.8);
  });

  test("normalizes invoice fields and line items into the existing contract", () => {
    const result = normalizeAzureAnalyzeResult({
      analyzeResult: invoiceResult(),
      model: "prebuilt-invoice",
      today: "2026-08-06",
    });

    assert.equal(result.status, "succeeded");

    if (result.status !== "succeeded") {
      assert.fail("expected successful normalization");
    }

    assert.deepEqual(result.normalized.merchantName, {
      value: "BASIC",
      sourceText: "BASIC",
      confidence: 0.99,
    });
    assert.equal(result.normalized.documentNumber.value, "A246");
    assert.equal(result.normalized.transactionDate.value, "2026-08-01");
    assert.equal(result.normalized.transactionTime.value, null);
    assert.equal(result.normalized.currencyCode.value, "AED");
    assert.equal(result.normalized.total.minor, 35640);
    assert.equal(result.normalized.subtotal.minor, 30000);
    assert.equal(result.normalized.taxTotal.minor, 1140);

    assert.deepEqual(result.lineItems, [
      {
        lineNumber: 1,
        description: "SKU-100 — Sales reward product",
        descriptionSourceText: "SKU-100 — Sales reward product",
        quantity: 2,
        quantitySourceText: "2",
        unitPriceMinor: 5000,
        unitPriceSourceText: "50.00",
        lineTotalMinor: 10000,
        lineTotalSourceText: "100.00",
        confidence: 0.93,
      },
    ]);

    assert.deepEqual(result.normalized.warningCodes, [
      "MISSING_TRANSACTION_TIME",
      "SUBTOTAL_TAX_TOTAL_MISMATCH",
    ]);
  });

  test("normalizes receipt fields, time and Arabic-Indic amount text", () => {
    const result = normalizeAzureAnalyzeResult({
      model: "prebuilt-receipt",
      today: "2026-08-06",
      analyzeResult: {
        modelId: "prebuilt-receipt",
        documents: [
          {
            docType: "receipt",
            fields: {
              MerchantName: {
                type: "string",
                valueString: "متجر",
                content: "متجر",
                confidence: 0.97,
              },
              TransactionDate: {
                type: "date",
                valueDate: "2026-08-05",
                content: "٠٥/٠٨/٢٠٢٦",
                confidence: 0.96,
              },
              TransactionTime: {
                type: "time",
                valueTime: "14:32:00",
                content: "14:32",
                confidence: 0.95,
              },
              Total: {
                type: "currency",
                valueCurrency: {
                  amount: 356.4,
                  currencyCode: "AED",
                  currencySymbol: "د.إ",
                },
                content: "٣٥٦٫٤٠ د.إ",
                confidence: 0.94,
              },
              Subtotal: {
                type: "currency",
                valueCurrency: {
                  amount: 345,
                  currencyCode: "AED",
                },
                content: "٣٤٥٫٠٠",
                confidence: 0.93,
              },
              TotalTax: {
                type: "currency",
                valueCurrency: {
                  amount: 11.4,
                  currencyCode: "AED",
                },
                content: "١١٫٤٠",
                confidence: 0.92,
              },
            },
          },
        ],
      },
    });

    assert.equal(result.status, "succeeded");

    if (result.status !== "succeeded") {
      assert.fail("expected successful normalization");
    }

    assert.equal(result.normalized.merchantName.value, "متجر");
    assert.equal(result.normalized.transactionDate.value, "2026-08-05");
    assert.equal(result.normalized.transactionTime.value, "14:32");
    assert.equal(result.normalized.currencyCode.value, "AED");
    assert.equal(result.normalized.total.minor, 35640);
    assert.equal(result.normalized.subtotal.minor, 34500);
    assert.equal(result.normalized.taxTotal.minor, 1140);
    assert.ok(
      result.normalized.warningCodes.includes(
        "MISSING_DOCUMENT_NUMBER",
      ),
    );
  });

  test("derives low-confidence and future-date warnings", () => {
    const payload = invoiceResult();

    payload.documents[0].fields.InvoiceDate.confidence = 0.61;
    payload.documents[0].fields.InvoiceDate.valueDate = "2026-08-10";
    payload.documents[0].fields.InvoiceTotal.confidence = 0.62;

    const result = normalizeAzureAnalyzeResult({
      analyzeResult: payload,
      model: "prebuilt-invoice",
      today: "2026-08-06",
    });

    assert.equal(result.status, "succeeded");

    if (result.status !== "succeeded") {
      assert.fail("expected successful normalization");
    }

    assert.ok(
      result.normalized.warningCodes.includes(
        "LOW_CONFIDENCE_TOTAL",
      ),
    );
    assert.ok(
      result.normalized.warningCodes.includes(
        "LOW_CONFIDENCE_DATE",
      ),
    );
    assert.ok(
      result.normalized.warningCodes.includes("DATE_IN_FUTURE"),
    );
  });

  test("retains ambiguous and negative amount text without guessing", () => {
    const payload = invoiceResult();

    payload.documents[0].fields.InvoiceTotal.content = "AED 12.5";
    payload.documents[0].fields.SubTotal.content = "(AED 10.00)";

    const result = normalizeAzureAnalyzeResult({
      analyzeResult: payload,
      model: "prebuilt-invoice",
      today: "2026-08-06",
    });

    assert.equal(result.status, "succeeded");

    if (result.status !== "succeeded") {
      assert.fail("expected successful normalization");
    }

    assert.equal(result.normalized.total.minor, null);
    assert.equal(result.normalized.total.sourceText, "AED 12.5");
    assert.equal(result.normalized.subtotal.minor, null);
    assert.equal(
      result.normalized.subtotal.sourceText,
      "(AED 10.00)",
    );
    assert.ok(
      result.normalized.warningCodes.includes(
        "AMBIGUOUS_AMOUNT_FORMAT",
      ),
    );
    assert.ok(
      result.normalized.warningCodes.includes(
        "NEGATIVE_AMOUNT_REJECTED",
      ),
    );
  });

  test("does not assume two minor units for an unknown currency", () => {
    const payload = invoiceResult();

    payload.documents[0].fields.InvoiceTotal.valueCurrency.currencyCode =
      "ZZZ";
    payload.documents[0].fields.SubTotal.valueCurrency.currencyCode =
      "ZZZ";
    payload.documents[0].fields.TotalTax.valueCurrency.currencyCode =
      "ZZZ";
    payload.documents[0].fields.Items.valueArray = [];

    payload.documents[0].fields.InvoiceTotal.content = "ZZZ 356.40";
    payload.documents[0].fields.SubTotal.content = "ZZZ 300.00";
    payload.documents[0].fields.TotalTax.content = "ZZZ 11.40";

    const result = normalizeAzureAnalyzeResult({
      analyzeResult: payload,
      model: "prebuilt-invoice",
      today: "2026-08-06",
    });

    assert.equal(result.status, "succeeded");

    if (result.status !== "succeeded") {
      assert.fail("expected successful normalization");
    }

    assert.equal(result.normalized.currencyCode.value, null);
    assert.equal(result.normalized.total.minor, null);
    assert.equal(
      result.normalized.total.sourceText,
      "ZZZ 356.40",
    );
  });

  test("refuses a model mismatch as a normalization failure", () => {
    const result = normalizeAzureAnalyzeResult({
      analyzeResult: invoiceResult(),
      model: "prebuilt-receipt",
      today: "2026-08-06",
    });

    assert.deepEqual(result, {
      status: "failed",
      failureCode: "NORMALIZATION_FAILED",
    });
  });

  test("treats a result with no detected document fields as rejected", () => {
    const result = normalizeAzureAnalyzeResult({
      model: "prebuilt-invoice",
      today: "2026-08-06",
      analyzeResult: {
        modelId: "prebuilt-invoice",
        documents: [],
      },
    });

    assert.deepEqual(result, {
      status: "failed",
      failureCode: "PROVIDER_REJECTED_DOCUMENT",
    });
  });

  test("requires an injected valid calendar date", () => {
    const result = normalizeAzureAnalyzeResult({
      analyzeResult: invoiceResult(),
      model: "prebuilt-invoice",
      today: "2026-02-30",
    });

    assert.deepEqual(result, {
      status: "failed",
      failureCode: "NORMALIZATION_FAILED",
    });
  });
});
