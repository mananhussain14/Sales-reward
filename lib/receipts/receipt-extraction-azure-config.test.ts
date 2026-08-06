import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AZURE_DI_API_VERSION_ENV,
  AZURE_DI_ENDPOINT_ENV,
  AZURE_DI_KEY_ENV,
  AZURE_DI_MODEL_ENV,
  AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
  AZURE_DOCUMENT_INTELLIGENCE_INVOICE_MODEL,
  AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
  AZURE_DOCUMENT_INTELLIGENCE_RECEIPT_MODEL,
  buildAzureDocumentAnalyzeUrl,
  resolveAzureDocumentIntelligenceConfig,
} from "./receipt-extraction-azure-config.ts";

const KEY = "a".repeat(84);

function validInput(
  overrides: Partial<{
    endpoint: unknown;
    key: unknown;
    apiVersion: unknown;
    model: unknown;
  }> = {},
) {
  return {
    endpoint:
      "https://salesreward-test.cognitiveservices.azure.com",
    key: KEY,
    apiVersion: "2024-11-30",
    model: "prebuilt-invoice",
    ...overrides,
  };
}

describe("Azure Document Intelligence configuration", () => {
  test("declares the closed provider and environment vocabulary", () => {
    assert.equal(
      AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
      "AZURE_DOCUMENT_INTELLIGENCE",
    );
    assert.equal(
      AZURE_DOCUMENT_INTELLIGENCE_RECEIPT_MODEL,
      "prebuilt-receipt",
    );
    assert.equal(
      AZURE_DOCUMENT_INTELLIGENCE_INVOICE_MODEL,
      "prebuilt-invoice",
    );
    assert.equal(
      AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
      "2024-11-30",
    );

    assert.equal(AZURE_DI_ENDPOINT_ENV, "AZURE_DI_ENDPOINT");
    assert.equal(AZURE_DI_KEY_ENV, "AZURE_DI_KEY");
    assert.equal(AZURE_DI_API_VERSION_ENV, "AZURE_DI_API_VERSION");
    assert.equal(AZURE_DI_MODEL_ENV, "AZURE_DI_MODEL");
  });

  test("accepts the configured invoice model", () => {
    const result = resolveAzureDocumentIntelligenceConfig(validInput());

    assert.equal(result.status, "ok");

    if (result.status !== "ok") {
      assert.fail("expected valid Azure configuration");
    }

    assert.deepEqual(result.config, {
      endpoint:
        "https://salesreward-test.cognitiveservices.azure.com",
      key: KEY,
      apiVersion: "2024-11-30",
      model: "prebuilt-invoice",
    });
  });

  test("accepts the configured receipt model", () => {
    const result = resolveAzureDocumentIntelligenceConfig(
      validInput({ model: "prebuilt-receipt" }),
    );

    assert.equal(result.status, "ok");
  });

  test("normalizes one trailing endpoint slash", () => {
    const result = resolveAzureDocumentIntelligenceConfig(
      validInput({
        endpoint:
          "https://salesreward-test.cognitiveservices.azure.com/",
      }),
    );

    assert.equal(result.status, "ok");

    if (result.status !== "ok") {
      assert.fail("expected valid Azure configuration");
    }

    assert.equal(
      result.config.endpoint,
      "https://salesreward-test.cognitiveservices.azure.com",
    );
  });

  test("builds the exact analyze URL from validated configuration", () => {
    const result = resolveAzureDocumentIntelligenceConfig(validInput());

    if (result.status !== "ok") {
      assert.fail("expected valid Azure configuration");
    }

    assert.equal(
      buildAzureDocumentAnalyzeUrl(result.config),
      "https://salesreward-test.cognitiveservices.azure.com/" +
        "documentintelligence/documentModels/prebuilt-invoice:analyze" +
        "?api-version=2024-11-30",
    );
  });

  test("rejects missing configuration", () => {
    for (const field of [
      "endpoint",
      "key",
      "apiVersion",
      "model",
    ] as const) {
      const result = resolveAzureDocumentIntelligenceConfig(
        validInput({ [field]: undefined }),
      );

      assert.deepEqual(result, { status: "invalid" });
    }
  });

  test("rejects unsupported models and API versions", () => {
    assert.deepEqual(
      resolveAzureDocumentIntelligenceConfig(
        validInput({ model: "custom-model" }),
      ),
      { status: "invalid" },
    );

    assert.deepEqual(
      resolveAzureDocumentIntelligenceConfig(
        validInput({ apiVersion: "latest" }),
      ),
      { status: "invalid" },
    );
  });

  test("rejects unsafe or foreign endpoints", () => {
    const invalidEndpoints = [
      "http://example.cognitiveservices.azure.com",
      "https://cognitiveservices.azure.com",
      "https://example.com",
      "https://user:password@example.cognitiveservices.azure.com",
      "https://example.cognitiveservices.azure.com/path",
      "https://example.cognitiveservices.azure.com?key=value",
      "https://example.cognitiveservices.azure.com#fragment",
      "not-a-url",
    ];

    for (const endpoint of invalidEndpoints) {
      assert.deepEqual(
        resolveAzureDocumentIntelligenceConfig(
          validInput({ endpoint }),
        ),
        { status: "invalid" },
        endpoint,
      );
    }
  });

  test("rejects empty, short or whitespace-containing keys", () => {
    for (const key of [
      "",
      "short",
      `a${"b".repeat(40)} c`,
      "\n".repeat(40),
    ]) {
      assert.deepEqual(
        resolveAzureDocumentIntelligenceConfig(validInput({ key })),
        { status: "invalid" },
      );
    }
  });
});
