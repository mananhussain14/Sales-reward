/**
 * AZURE DOCUMENT INTELLIGENCE PROVIDER ADAPTER.
 *
 * This is the only shared receipt module permitted to contact Azure. It receives only
 * bytes and MIME type through the existing provider port. It never receives a submission
 * id, retailer id, user id, bucket, path, filename or file hash.
 *
 * No response body, provider URL, key, error object or raw OCR payload is logged, returned
 * to a client or stored. A successful response is immediately reduced to the existing
 * provider-neutral normalized extraction.
 */

import {
  AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
  buildAzureDocumentAnalyzeUrl,
  type AzureDocumentIntelligenceConfig,
} from "./receipt-extraction-azure-config.ts";
import { normalizeAzureAnalyzeResult } from "./receipt-extraction-azure-normalization.ts";
import type {
  ExtractionPollInput,
  ExtractionPollResult,
  ExtractionSubmitInput,
  ExtractionSubmitResult,
  ReceiptExtractionProvider,
} from "./receipt-extraction-provider.ts";
import type {
  ExtractionFailureCode,
} from "./receipt-extraction-vocabulary.ts";

/** Current Azure F0 analyze-document input limit. Injectable for a later tier upgrade. */
export const DEFAULT_AZURE_DOCUMENT_MAX_INPUT_BYTES = 4 * 1024 * 1024;

/** One provider request must finish well inside the database's five-minute claim window. */
export const DEFAULT_AZURE_DOCUMENT_REQUEST_TIMEOUT_MS = 20_000;

export const AZURE_DOCUMENT_SUPPORTED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
] as const;

type AzureDocumentMimeType =
  (typeof AZURE_DOCUMENT_SUPPORTED_MIME_TYPES)[number];

export type AzureDocumentIntelligenceProviderOptions = {
  readonly config: AzureDocumentIntelligenceConfig;
  readonly fetchImpl?: typeof fetch;
  readonly requestTimeoutMs?: number;
  readonly maxInputBytes?: number;
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

function isAzureDocumentMimeType(
  value: string,
): value is AzureDocumentMimeType {
  return (
    AZURE_DOCUMENT_SUPPORTED_MIME_TYPES as readonly string[]
  ).includes(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  );
}

/**
 * Validates Azure's Operation-Location and extracts only its UUID result identifier.
 *
 * The full provider URL is never persisted. The URL must belong to the configured endpoint,
 * name the configured model, use the configured API version and contain no extra query,
 * credentials or fragment.
 */
export function extractAzureDocumentResultId(input: {
  readonly operationLocation: unknown;
  readonly config: AzureDocumentIntelligenceConfig;
}): string | null {
  const rawLocation = optionalText(input.operationLocation);
  if (rawLocation === null) return null;

  let endpoint: URL;
  let location: URL;

  try {
    endpoint = new URL(input.config.endpoint);
    location = new URL(rawLocation);
  } catch {
    return null;
  }

  if (
    location.protocol !== "https:" ||
    location.origin !== endpoint.origin ||
    location.username !== "" ||
    location.password !== "" ||
    location.hash !== ""
  ) {
    return null;
  }

  const segments = location.pathname.split("/");

  if (
    segments.length !== 6 ||
    segments[0] !== "" ||
    segments[1] !== "documentintelligence" ||
    segments[2] !== "documentModels" ||
    segments[3] !== input.config.model ||
    segments[4] !== "analyzeResults" ||
    !isUuid(segments[5])
  ) {
    return null;
  }

  const queryKeys = [...location.searchParams.keys()];

  if (
    queryKeys.length !== 1 ||
    queryKeys[0] !== "api-version" ||
    location.searchParams.getAll("api-version").length !== 1 ||
    location.searchParams.get("api-version") !== input.config.apiVersion
  ) {
    return null;
  }

  return segments[5].toLowerCase();
}

/** Reconstructs the poll URL from trusted configuration plus the stored UUID only. */
export function buildAzureDocumentPollUrl(
  config: AzureDocumentIntelligenceConfig,
  providerOperationId: string,
): string | null {
  if (!isUuid(providerOperationId)) return null;

  return (
    `${config.endpoint}/documentintelligence/documentModels/` +
    `${encodeURIComponent(config.model)}/analyzeResults/` +
    `${providerOperationId.toLowerCase()}?api-version=` +
    `${encodeURIComponent(config.apiVersion)}`
  );
}

function timeoutMs(value: unknown): number {
  return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 1_000 &&
      value <= 60_000
    )
    ? value
    : DEFAULT_AZURE_DOCUMENT_REQUEST_TIMEOUT_MS;
}

function maximumInputBytes(value: unknown): number {
  return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0
    )
    ? value
    : DEFAULT_AZURE_DOCUMENT_MAX_INPUT_BYTES;
}

function failureFromThrown(error: unknown): ExtractionFailureCode {
  const record = asRecord(error);
  const name = optionalText(record?.name);

  return name === "AbortError" || name === "TimeoutError"
    ? "PROVIDER_TIMEOUT"
    : "PROVIDER_UNAVAILABLE";
}

function failureFromHttpStatus(
  status: number,
  phase: "submit" | "poll",
): ExtractionFailureCode {
  if (status === 408 || status === 504) {
    return "PROVIDER_TIMEOUT";
  }

  if (status === 429) {
    return "PROVIDER_QUOTA_EXCEEDED";
  }

  if (
    phase === "submit" &&
    (status === 400 ||
      status === 413 ||
      status === 415 ||
      status === 422)
  ) {
    return "UNSUPPORTED_IMAGE";
  }

  if (status >= 500 && status <= 599) {
    return "PROVIDER_UNAVAILABLE";
  }

  // Authentication, authorization, invalid operation identifiers and unexpected protocol
  // responses indicate deployment or integration defects rather than a user document fault.
  return "INTERNAL";
}

async function parseJsonRecord(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await response.json());
  } catch {
    return null;
  }
}

function utcCalendarDate(nowMs: number): string | null {
  if (!Number.isFinite(nowMs)) return null;

  const date = new Date(nowMs);
  if (Number.isNaN(date.getTime())) return null;

  try {
    return date.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

export function createAzureDocumentIntelligenceProvider(
  options: AzureDocumentIntelligenceProviderOptions,
): ReceiptExtractionProvider {
  const config = options.config;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = timeoutMs(options.requestTimeoutMs);
  const maxInputBytes = maximumInputBytes(options.maxInputBytes);

  return {
    name: AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME,
    model: config.model,

    async submit(
      input: ExtractionSubmitInput,
    ): Promise<ExtractionSubmitResult> {
      if (
        !(input.bytes instanceof Uint8Array) ||
        input.bytes.byteLength === 0
      ) {
        return {
          status: "failed",
          failureCode: "OBJECT_UNREADABLE",
        };
      }

      if (
        !isAzureDocumentMimeType(input.mimeType) ||
        input.bytes.byteLength > maxInputBytes
      ) {
        return {
          status: "failed",
          failureCode: "UNSUPPORTED_IMAGE",
        };
      }

      try {
        // Copy into an ordinary ArrayBuffer. The provider input may be backed by any
        // ArrayBufferLike implementation, while the shared fetch typings require a
        // concrete BodyInit-compatible ArrayBuffer.
        const requestBytes = new Uint8Array(input.bytes.byteLength);
        requestBytes.set(input.bytes);

        const response = await fetchImpl(
          buildAzureDocumentAnalyzeUrl(config),
          {
            method: "POST",
            headers: {
              "Content-Type": input.mimeType,
              "Ocp-Apim-Subscription-Key": config.key,
              Accept: "application/json",
            },
            body: requestBytes.buffer,
            signal: AbortSignal.timeout(requestTimeoutMs),
          },
        );

        if (response.status !== 202) {
          return {
            status: "failed",
            failureCode: failureFromHttpStatus(
              response.status,
              "submit",
            ),
          };
        }

        const providerOperationId =
          extractAzureDocumentResultId({
            operationLocation:
              response.headers.get("Operation-Location"),
            config,
          });

        if (providerOperationId === null) {
          return {
            status: "failed",
            failureCode: "INTERNAL",
          };
        }

        return {
          status: "ok",
          providerOperationId,
        };
      } catch (error) {
        return {
          status: "failed",
          failureCode: failureFromThrown(error),
        };
      }
    },

    async poll(
      input: ExtractionPollInput,
    ): Promise<ExtractionPollResult> {
      const pollUrl = buildAzureDocumentPollUrl(
        config,
        input.providerOperationId,
      );
      const today = utcCalendarDate(input.nowMs);

      if (pollUrl === null || today === null) {
        return {
          status: "failed",
          failureCode: "NORMALIZATION_FAILED",
        };
      }

      try {
        const response = await fetchImpl(pollUrl, {
          method: "GET",
          headers: {
            "Ocp-Apim-Subscription-Key": config.key,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });

        if (response.status !== 200) {
          return {
            status: "failed",
            failureCode: failureFromHttpStatus(
              response.status,
              "poll",
            ),
          };
        }

        const body = await parseJsonRecord(response);
        if (body === null) {
          return {
            status: "failed",
            failureCode: "NORMALIZATION_FAILED",
          };
        }

        const operationStatus = optionalText(body.status);

        if (
          operationStatus === "notStarted" ||
          operationStatus === "running"
        ) {
          return { status: "pending" };
        }

        if (
          operationStatus === "failed" ||
          operationStatus === "canceled"
        ) {
          return {
            status: "failed",
            failureCode: "PROVIDER_REJECTED_DOCUMENT",
          };
        }

        if (operationStatus !== "succeeded") {
          return {
            status: "failed",
            failureCode: "NORMALIZATION_FAILED",
          };
        }

        return normalizeAzureAnalyzeResult({
          analyzeResult: body.analyzeResult,
          model: config.model,
          today,
        });
      } catch (error) {
        return {
          status: "failed",
          failureCode: failureFromThrown(error),
        };
      }
    },
  };
}
