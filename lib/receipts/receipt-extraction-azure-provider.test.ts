import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  AzureDocumentIntelligenceConfig,
} from "./receipt-extraction-azure-config.ts";
import {
  buildAzureDocumentPollUrl,
  createAzureDocumentIntelligenceProvider,
  DEFAULT_AZURE_DOCUMENT_MAX_INPUT_BYTES,
  extractAzureDocumentResultId,
} from "./receipt-extraction-azure-provider.ts";

const RESULT_ID = "3b31320d-8bab-4f88-b19c-2322a7f11034";

const CONFIG: AzureDocumentIntelligenceConfig = {
  endpoint:
    "https://salesreward-test.cognitiveservices.azure.com",
  key: "k".repeat(64),
  apiVersion: "2024-11-30",
  model: "prebuilt-invoice",
};

function operationLocation(
  overrides = "",
): string {
  return (
    `${CONFIG.endpoint}/documentintelligence/documentModels/` +
    `${CONFIG.model}/analyzeResults/${RESULT_ID}` +
    `?api-version=${CONFIG.apiVersion}${overrides}`
  );
}

function fetchMock(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

describe("Azure Document Intelligence provider", () => {
  test("validates and reduces Operation-Location to its UUID", () => {
    assert.equal(
      extractAzureDocumentResultId({
        operationLocation: operationLocation(),
        config: CONFIG,
      }),
      RESULT_ID,
    );

    assert.equal(
      buildAzureDocumentPollUrl(CONFIG, RESULT_ID),
      operationLocation(),
    );
  });

  test("rejects untrusted or malformed Operation-Location values", () => {
    const invalid = [
      operationLocation().replace(
        "salesreward-test",
        "attacker",
      ),
      operationLocation().replace(
        "prebuilt-invoice",
        "prebuilt-receipt",
      ),
      `${operationLocation()}&extra=true`,
      operationLocation().replace(
        RESULT_ID,
        "not-a-uuid",
      ),
      `https://user:password@` +
        `salesreward-test.cognitiveservices.azure.com/` +
        `documentintelligence/documentModels/prebuilt-invoice/` +
        `analyzeResults/${RESULT_ID}` +
        `?api-version=2024-11-30`,
    ];

    for (const value of invalid) {
      assert.equal(
        extractAzureDocumentResultId({
          operationLocation: value,
          config: CONFIG,
        }),
        null,
        value,
      );
    }
  });

  test("submits bytes and stores only the returned result UUID", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;

    const provider =
      createAzureDocumentIntelligenceProvider({
        config: CONFIG,
        fetchImpl: fetchMock(async (input, init) => {
          calledUrl = String(input);
          calledInit = init;

          return new Response(null, {
            status: 202,
            headers: {
              "Operation-Location": operationLocation(),
            },
          });
        }),
      });

    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);

    const result = await provider.submit({
      bytes,
      mimeType: "image/jpeg",
    });

    assert.deepEqual(result, {
      status: "ok",
      providerOperationId: RESULT_ID,
    });

    assert.equal(provider.name, "AZURE_DOCUMENT_INTELLIGENCE");
    assert.equal(provider.model, "prebuilt-invoice");
    assert.match(calledUrl, /prebuilt-invoice:analyze/);
    assert.equal(calledInit?.method, "POST");
    assert.ok(calledInit?.body instanceof ArrayBuffer);
    assert.deepEqual(
      new Uint8Array(calledInit.body),
      bytes,
    );

    const headers = new Headers(calledInit?.headers);
    assert.equal(headers.get("Content-Type"), "image/jpeg");
    assert.equal(
      headers.get("Ocp-Apim-Subscription-Key"),
      CONFIG.key,
    );
  });

  test("rejects empty, WebP and oversized inputs without a network call", async () => {
    let calls = 0;

    const provider =
      createAzureDocumentIntelligenceProvider({
        config: CONFIG,
        maxInputBytes: 4,
        fetchImpl: fetchMock(async () => {
          calls += 1;
          throw new Error("must not be called");
        }),
      });

    assert.deepEqual(
      await provider.submit({
        bytes: new Uint8Array(),
        mimeType: "image/jpeg",
      }),
      {
        status: "failed",
        failureCode: "OBJECT_UNREADABLE",
      },
    );

    assert.deepEqual(
      await provider.submit({
        bytes: new Uint8Array([1]),
        mimeType: "image/webp",
      }),
      {
        status: "failed",
        failureCode: "UNSUPPORTED_IMAGE",
      },
    );

    assert.deepEqual(
      await provider.submit({
        bytes: new Uint8Array(5),
        mimeType: "image/png",
      }),
      {
        status: "failed",
        failureCode: "UNSUPPORTED_IMAGE",
      },
    );

    assert.equal(calls, 0);
    assert.equal(
      DEFAULT_AZURE_DOCUMENT_MAX_INPUT_BYTES,
      4 * 1024 * 1024,
    );
  });

  test("maps submit HTTP failures into the closed vocabulary", async () => {
    const cases = [
      [400, "UNSUPPORTED_IMAGE"],
      [413, "UNSUPPORTED_IMAGE"],
      [415, "UNSUPPORTED_IMAGE"],
      [429, "PROVIDER_QUOTA_EXCEEDED"],
      [504, "PROVIDER_TIMEOUT"],
      [500, "PROVIDER_UNAVAILABLE"],
      [401, "INTERNAL"],
    ] as const;

    for (const [status, failureCode] of cases) {
      const provider =
        createAzureDocumentIntelligenceProvider({
          config: CONFIG,
          fetchImpl: fetchMock(async () =>
            new Response(null, { status })
          ),
        });

      assert.deepEqual(
        await provider.submit({
          bytes: new Uint8Array([1]),
          mimeType: "image/png",
        }),
        { status: "failed", failureCode },
        String(status),
      );
    }
  });

  test("distinguishes timeouts from other network failures", async () => {
    const timeoutProvider =
      createAzureDocumentIntelligenceProvider({
        config: CONFIG,
        fetchImpl: fetchMock(async () => {
          throw { name: "TimeoutError" };
        }),
      });

    assert.deepEqual(
      await timeoutProvider.submit({
        bytes: new Uint8Array([1]),
        mimeType: "image/jpeg",
      }),
      {
        status: "failed",
        failureCode: "PROVIDER_TIMEOUT",
      },
    );

    const unavailableProvider =
      createAzureDocumentIntelligenceProvider({
        config: CONFIG,
        fetchImpl: fetchMock(async () => {
          throw new Error("network unavailable");
        }),
      });

    assert.deepEqual(
      await unavailableProvider.submit({
        bytes: new Uint8Array([1]),
        mimeType: "image/jpeg",
      }),
      {
        status: "failed",
        failureCode: "PROVIDER_UNAVAILABLE",
      },
    );
  });

  test("returns pending for running operations", async () => {
    const provider =
      createAzureDocumentIntelligenceProvider({
        config: CONFIG,
        fetchImpl: fetchMock(async () =>
          Response.json({ status: "running" })
        ),
      });

    assert.deepEqual(
      await provider.poll({
        providerOperationId: RESULT_ID,
        startedAtMs: 0,
        nowMs: Date.UTC(2026, 7, 6),
      }),
      { status: "pending" },
    );
  });

  test("normalizes a successful operation immediately", async () => {
    const provider =
      createAzureDocumentIntelligenceProvider({
        config: CONFIG,
        fetchImpl: fetchMock(async () =>
          Response.json({
            status: "succeeded",
            analyzeResult: {
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
                      confidence: 0.97,
                    },
                    InvoiceTotal: {
                      type: "currency",
                      valueCurrency: {
                        amount: 10,
                        currencyCode: "AED",
                      },
                      content: "AED 10.00",
                      confidence: 0.96,
                    },
                  },
                },
              ],
            },
          })
        ),
      });

    const result = await provider.poll({
      providerOperationId: RESULT_ID,
      startedAtMs: 0,
      nowMs: Date.UTC(2026, 7, 6),
    });

    assert.equal(result.status, "succeeded");

    if (result.status !== "succeeded") {
      assert.fail("expected successful normalization");
    }

    assert.equal(result.normalized.merchantName.value, "BASIC");
    assert.equal(result.normalized.documentNumber.value, "A246");
    assert.equal(result.normalized.currencyCode.value, "AED");
    assert.equal(result.normalized.total.minor, 1000);
  });

  test("maps terminal Azure failure without exposing its error object", async () => {
    const provider =
      createAzureDocumentIntelligenceProvider({
        config: CONFIG,
        fetchImpl: fetchMock(async () =>
          Response.json({
            status: "failed",
            error: {
              code: "InvalidContent",
              message: "provider-only message",
            },
          })
        ),
      });

    assert.deepEqual(
      await provider.poll({
        providerOperationId: RESULT_ID,
        startedAtMs: 0,
        nowMs: Date.UTC(2026, 7, 6),
      }),
      {
        status: "failed",
        failureCode: "PROVIDER_REJECTED_DOCUMENT",
      },
    );
  });

  test("fails closed for invalid IDs, JSON and operation statuses", async () => {
    let calls = 0;

    const invalidIdProvider =
      createAzureDocumentIntelligenceProvider({
        config: CONFIG,
        fetchImpl: fetchMock(async () => {
          calls += 1;
          return Response.json({ status: "running" });
        }),
      });

    assert.deepEqual(
      await invalidIdProvider.poll({
        providerOperationId: "not-a-uuid",
        startedAtMs: 0,
        nowMs: Date.UTC(2026, 7, 6),
      }),
      {
        status: "failed",
        failureCode: "NORMALIZATION_FAILED",
      },
    );
    assert.equal(calls, 0);

    const invalidJsonProvider =
      createAzureDocumentIntelligenceProvider({
        config: CONFIG,
        fetchImpl: fetchMock(async () =>
          new Response("not-json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        ),
      });

    assert.deepEqual(
      await invalidJsonProvider.poll({
        providerOperationId: RESULT_ID,
        startedAtMs: 0,
        nowMs: Date.UTC(2026, 7, 6),
      }),
      {
        status: "failed",
        failureCode: "NORMALIZATION_FAILED",
      },
    );

    const unknownStatusProvider =
      createAzureDocumentIntelligenceProvider({
        config: CONFIG,
        fetchImpl: fetchMock(async () =>
          Response.json({ status: "mystery" })
        ),
      });

    assert.deepEqual(
      await unknownStatusProvider.poll({
        providerOperationId: RESULT_ID,
        startedAtMs: 0,
        nowMs: Date.UTC(2026, 7, 6),
      }),
      {
        status: "failed",
        failureCode: "NORMALIZATION_FAILED",
      },
    );
  });
});
