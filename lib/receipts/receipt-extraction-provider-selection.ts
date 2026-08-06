/**
 * PURE PROVIDER SELECTION — no environment access, authorization, storage or logging.
 *
 * Edge Functions read server-only environment values and pass them here as unknown.
 * This module resolves the exact runtime mode, validates provider configuration and
 * constructs one provider. Every malformed or mismatched value returns null.
 *
 * REQUEST SELECTION
 *   The configured Azure model becomes immutable attempt metadata when the database
 *   claim succeeds.
 *
 * POLL SELECTION
 *   The model comes from immutable worker-state metadata, never from the current
 *   AZURE_DI_MODEL environment value. This prevents a deployment change from polling
 *   an existing operation through the wrong model.
 */

import {
  AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
  resolveAzureDocumentIntelligenceConfig,
} from "./receipt-extraction-azure-config.ts";
import {
  createAzureDocumentIntelligenceProvider,
} from "./receipt-extraction-azure-provider.ts";
import {
  createFakeProviderForKey,
  resolveFakeFixtureKey,
} from "./receipt-extraction-fake-provider.ts";
import {
  RECEIPT_EXTRACTION_MODE_AZURE,
  RECEIPT_EXTRACTION_MODE_FAKE,
  resolveFakePendingMs,
  resolveReceiptExtractionEdgeMode,
} from "./receipt-extraction-mode.ts";
import type {
  ReceiptExtractionProvider,
} from "./receipt-extraction-provider.ts";
import {
  FAKE_PROVIDER_MODEL,
  FAKE_PROVIDER_NAME,
} from "./receipt-extraction-vocabulary.ts";

type SharedRuntimeValues = {
  readonly mode: unknown;
  readonly fakeFixture: unknown;
  readonly fakePendingMs: unknown;
  readonly azureEndpoint: unknown;
  readonly azureKey: unknown;
  readonly azureApiVersion: unknown;

  /** Injectable for deterministic tests. */
  readonly generateUuid?: () => string;

  /** Injectable so unit tests never contact Azure. */
  readonly fetchImpl?: typeof fetch;
};

export type ReceiptExtractionRequestProviderInput =
  SharedRuntimeValues & {
    /** Used only when creating a new Azure attempt. */
    readonly azureModel: unknown;
  };

export type ReceiptExtractionPollProviderInput =
  SharedRuntimeValues & {
    /** Immutable metadata read from the extraction attempt. */
    readonly providerName: unknown;
    readonly providerModel: unknown;
  };

function createConfiguredFakeProvider(
  input: SharedRuntimeValues,
): ReceiptExtractionProvider | null {
  const fixture = resolveFakeFixtureKey({
    fixtureEnv: input.fakeFixture,
    fileSha256: null,
  });

  if (fixture.status !== "ok") return null;

  return createFakeProviderForKey(
    fixture.key,
    resolveFakePendingMs(input.fakePendingMs),
    input.generateUuid,
  );
}

function createConfiguredAzureProvider(
  input: SharedRuntimeValues,
  model: unknown,
): ReceiptExtractionProvider | null {
  const resolved = resolveAzureDocumentIntelligenceConfig({
    endpoint: input.azureEndpoint,
    key: input.azureKey,
    apiVersion: input.azureApiVersion,
    model,
  });

  if (resolved.status !== "ok") return null;

  return createAzureDocumentIntelligenceProvider({
    config: resolved.config,
    fetchImpl: input.fetchImpl,
  });
}

/**
 * Selects the provider used to create and submit a new attempt.
 *
 * Azure's model comes from the server-only AZURE_DI_MODEL value. The database claim
 * records provider.name and provider.model before the document is submitted.
 */
export function resolveReceiptExtractionRequestProvider(
  input: ReceiptExtractionRequestProviderInput,
): ReceiptExtractionProvider | null {
  const mode = resolveReceiptExtractionEdgeMode(input.mode);

  if (mode === RECEIPT_EXTRACTION_MODE_FAKE) {
    return createConfiguredFakeProvider(input);
  }

  if (mode === RECEIPT_EXTRACTION_MODE_AZURE) {
    return createConfiguredAzureProvider(
      input,
      input.azureModel,
    );
  }

  return null;
}

/**
 * Selects the provider used to poll an existing attempt.
 *
 * Both the current Edge mode and immutable stored metadata must agree. For Azure,
 * the stored model is passed into configuration resolution; the current deployment's
 * AZURE_DI_MODEL value cannot redirect an operation created under another model.
 */
export function resolveReceiptExtractionPollProvider(
  input: ReceiptExtractionPollProviderInput,
): ReceiptExtractionProvider | null {
  const mode = resolveReceiptExtractionEdgeMode(input.mode);

  if (mode === RECEIPT_EXTRACTION_MODE_FAKE) {
    if (
      input.providerName !== FAKE_PROVIDER_NAME ||
      input.providerModel !== FAKE_PROVIDER_MODEL
    ) {
      return null;
    }

    return createConfiguredFakeProvider(input);
  }

  if (mode === RECEIPT_EXTRACTION_MODE_AZURE) {
    if (
      input.providerName !==
        AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME
    ) {
      return null;
    }

    return createConfiguredAzureProvider(
      input,
      input.providerModel,
    );
  }

  return null;
}
