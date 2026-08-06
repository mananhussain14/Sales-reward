/**
 * PURE MODULE — no I/O, environment access, network access or secret logging.
 *
 * Defines the closed configuration contract for Azure Document Intelligence.
 * Edge Functions will read environment variables and pass their values into this
 * module. A request body, header, filename or authenticated user can never select
 * the provider, model, endpoint or API version.
 *
 * Configuration fails closed. Missing, malformed or unsupported values return
 * `invalid` rather than selecting a fallback silently.
 */

export const AZURE_DOCUMENT_INTELLIGENCE_PROVIDER_NAME =
  "AZURE_DOCUMENT_INTELLIGENCE" as const;

export const AZURE_DOCUMENT_INTELLIGENCE_RECEIPT_MODEL =
  "prebuilt-receipt" as const;

export const AZURE_DOCUMENT_INTELLIGENCE_INVOICE_MODEL =
  "prebuilt-invoice" as const;

export const AZURE_DOCUMENT_INTELLIGENCE_MODELS = [
  AZURE_DOCUMENT_INTELLIGENCE_RECEIPT_MODEL,
  AZURE_DOCUMENT_INTELLIGENCE_INVOICE_MODEL,
] as const;

export type AzureDocumentIntelligenceModel =
  (typeof AZURE_DOCUMENT_INTELLIGENCE_MODELS)[number];

export const AZURE_DOCUMENT_INTELLIGENCE_API_VERSION =
  "2024-11-30" as const;

export const AZURE_DI_ENDPOINT_ENV = "AZURE_DI_ENDPOINT" as const;
export const AZURE_DI_KEY_ENV = "AZURE_DI_KEY" as const;
export const AZURE_DI_API_VERSION_ENV = "AZURE_DI_API_VERSION" as const;
export const AZURE_DI_MODEL_ENV = "AZURE_DI_MODEL" as const;

export type AzureDocumentIntelligenceConfig = {
  readonly endpoint: string;
  readonly key: string;
  readonly apiVersion: typeof AZURE_DOCUMENT_INTELLIGENCE_API_VERSION;
  readonly model: AzureDocumentIntelligenceModel;
};

export type AzureDocumentIntelligenceConfigResolution =
  | {
      readonly status: "ok";
      readonly config: AzureDocumentIntelligenceConfig;
    }
  | { readonly status: "invalid" };

function isAzureModel(
  value: unknown,
): value is AzureDocumentIntelligenceModel {
  return (
    value === AZURE_DOCUMENT_INTELLIGENCE_RECEIPT_MODEL ||
    value === AZURE_DOCUMENT_INTELLIGENCE_INVOICE_MODEL
  );
}

function resolveEndpoint(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") return null;

  const value = rawValue.trim();
  if (value.length === 0) return null;

  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (parsed.port.length > 0) return null;
  if (parsed.search.length > 0 || parsed.hash.length > 0) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;

  const hostname = parsed.hostname.toLowerCase();

  if (
    hostname === "cognitiveservices.azure.com" ||
    !hostname.endsWith(".cognitiveservices.azure.com")
  ) {
    return null;
  }

  return `https://${hostname}`;
}

function resolveKey(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") return null;

  const value = rawValue.trim();

  if (value.length < 32 || value.length > 256) return null;
  if (/\s/.test(value)) return null;

  return value;
}

export function resolveAzureDocumentIntelligenceConfig(input: {
  readonly endpoint: unknown;
  readonly key: unknown;
  readonly apiVersion: unknown;
  readonly model: unknown;
}): AzureDocumentIntelligenceConfigResolution {
  const endpoint = resolveEndpoint(input.endpoint);
  const key = resolveKey(input.key);

  if (endpoint === null || key === null) {
    return { status: "invalid" };
  }

  if (
    input.apiVersion !== AZURE_DOCUMENT_INTELLIGENCE_API_VERSION
  ) {
    return { status: "invalid" };
  }

  if (!isAzureModel(input.model)) {
    return { status: "invalid" };
  }

  return {
    status: "ok",
    config: {
      endpoint,
      key,
      apiVersion: AZURE_DOCUMENT_INTELLIGENCE_API_VERSION,
      model: input.model,
    },
  };
}

export function buildAzureDocumentAnalyzeUrl(
  config: AzureDocumentIntelligenceConfig,
): string {
  return (
    `${config.endpoint}/documentintelligence/documentModels/` +
    `${config.model}:analyze?api-version=${config.apiVersion}`
  );
}
