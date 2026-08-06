import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
  AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
} from "./receipt-extraction-azure-config.ts";
import {
  resolveReceiptExtractionPollProvider,
  resolveReceiptExtractionRequestProvider,
} from "./receipt-extraction-provider-selection.ts";
import {
  FAKE_PROVIDER_MODEL,
  FAKE_PROVIDER_NAME,
} from "./receipt-extraction-vocabulary.ts";

const UUID =
  "11111111-1111-4111-8111-111111111111";

const AZURE_ENDPOINT =
  "https://salesreward-test.cognitiveservices.azure.com";

const AZURE_KEY = "k".repeat(64);

function requestInput(
  overrides: Record<string, unknown> = {},
) {
  return {
    mode: "azure",
    fakeFixture: undefined,
    fakePendingMs: undefined,
    azureEndpoint: AZURE_ENDPOINT,
    azureKey: AZURE_KEY,
    azureApiVersion:
      AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
    azureModel: "prebuilt-invoice",
    generateUuid: () => UUID,
    ...overrides,
  };
}

function pollInput(
  overrides: Record<string, unknown> = {},
) {
  return {
    mode: "azure",
    fakeFixture: undefined,
    fakePendingMs: undefined,
    azureEndpoint: AZURE_ENDPOINT,
    azureKey: AZURE_KEY,
    azureApiVersion:
      AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
    providerName:
      AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
    providerModel: "prebuilt-invoice",
    generateUuid: () => UUID,
    ...overrides,
  };
}

describe("receipt extraction provider selection", () => {
  test("disabled and malformed request modes fail closed", () => {
    for (const mode of [
      undefined,
      null,
      "",
      "disabled",
      "DISABLED",
      "Azure",
      " azure",
      "azure ",
      "true",
      1,
      {},
    ]) {
      assert.equal(
        resolveReceiptExtractionRequestProvider(
          requestInput({ mode }),
        ),
        null,
        String(mode),
      );
    }
  });

  test("fake request mode returns the exact fake provider", async () => {
    const provider =
      resolveReceiptExtractionRequestProvider(
        requestInput({
          mode: "fake",
          fakeFixture: "CLEAN_AED_2",
          fakePendingMs: "0",
        }),
      );

    assert.ok(provider);
    assert.equal(provider.name, FAKE_PROVIDER_NAME);
    assert.equal(provider.model, FAKE_PROVIDER_MODEL);

    const submitted = await provider.submit({
      bytes: new Uint8Array([1]),
      mimeType: "image/jpeg",
    });

    assert.deepEqual(submitted, {
      status: "ok",
      providerOperationId: `fake:${UUID}`,
    });
  });

  test("an unknown fake fixture fails closed", () => {
    assert.equal(
      resolveReceiptExtractionRequestProvider(
        requestInput({
          mode: "fake",
          fakeFixture: "DOES_NOT_EXIST",
        }),
      ),
      null,
    );
  });

  test("Azure request mode uses the configured request model", () => {
    const provider =
      resolveReceiptExtractionRequestProvider(
        requestInput({
          azureModel: "prebuilt-receipt",
        }),
      );

    assert.ok(provider);
    assert.equal(
      provider.name,
      AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
    );
    assert.equal(provider.model, "prebuilt-receipt");
  });

  test("invalid Azure request configuration fails closed", () => {
    for (const overrides of [
      { azureEndpoint: undefined },
      { azureEndpoint: "http://example.com" },
      { azureKey: "" },
      { azureApiVersion: "2023-01-01" },
      { azureModel: "unknown-model" },
    ]) {
      assert.equal(
        resolveReceiptExtractionRequestProvider(
          requestInput(overrides),
        ),
        null,
        JSON.stringify(overrides),
      );
    }
  });

  test("fake polling requires exact stored fake metadata", () => {
    const provider =
      resolveReceiptExtractionPollProvider(
        pollInput({
          mode: "fake",
          providerName: FAKE_PROVIDER_NAME,
          providerModel: FAKE_PROVIDER_MODEL,
          fakeFixture: "CLEAN_AED_2",
          fakePendingMs: "0",
        }),
      );

    assert.ok(provider);
    assert.equal(provider.name, FAKE_PROVIDER_NAME);
    assert.equal(provider.model, FAKE_PROVIDER_MODEL);
  });

  test("Azure polling uses the immutable stored model", () => {
    const provider =
      resolveReceiptExtractionPollProvider(
        pollInput({
          providerModel: "prebuilt-receipt",
        }),
      );

    assert.ok(provider);
    assert.equal(
      provider.name,
      AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
    );
    assert.equal(provider.model, "prebuilt-receipt");
  });

  test("mode, provider and model mismatches fail closed", () => {
    const cases = [
      pollInput({
        mode: "fake",
        providerName:
          AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
        providerModel: "prebuilt-invoice",
      }),
      pollInput({
        mode: "azure",
        providerName: FAKE_PROVIDER_NAME,
        providerModel: FAKE_PROVIDER_MODEL,
      }),
      pollInput({
        providerName:
          AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
        providerModel: "unknown-model",
      }),
      pollInput({
        mode: "disabled",
      }),
      pollInput({
        azureEndpoint: "https://attacker.example",
      }),
    ];

    for (const input of cases) {
      assert.equal(
        resolveReceiptExtractionPollProvider(input),
        null,
        JSON.stringify({
          mode: input.mode,
          providerName: input.providerName,
          providerModel: input.providerModel,
        }),
      );
    }
  });

  test("provider selection itself performs no network request", () => {
    let calls = 0;

    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("selection must not call fetch");
    }) as typeof fetch;

    const requestProvider =
      resolveReceiptExtractionRequestProvider(
        requestInput({ fetchImpl }),
      );

    const pollProvider =
      resolveReceiptExtractionPollProvider(
        pollInput({ fetchImpl }),
      );

    assert.ok(requestProvider);
    assert.ok(pollProvider);
    assert.equal(calls, 0);
  });
});
