// Supabase Edge Function: request-receipt-extraction
//
// THE ENTRY POINT for asking that a submitted receipt be read. One authenticated Sales
// Staff member, one receipt they submitted themselves.
//
// WHY THIS FUNCTION HOLDS THE SERVICE-ROLE KEY
//   The `receipts` bucket is private and storage.objects has RLS enabled with ZERO
//   policies, so only a service-role client can read an object. The four worker RPCs are
//   granted to service_role alone, deliberately: a browser-reachable claim would let anyone
//   who learned an extraction id take a job and write a result. A Flutter client therefore
//   cannot drive extraction on its own and must not be given a key that would let it. This
//   function holds that key on the server and exposes one narrow door.
//
// IN MILESTONE A THIS FUNCTION IS THE WORKER, AND IT STILL FOLLOWS THE WORKER CONTRACT.
//   There is no out-of-process worker yet, so this invocation claims, downloads, submits
//   and registers. It does NOT collapse those into one call: it goes through the same
//   claim -> register-operation sequence a real worker will use, and it deliberately STOPS
//   at PROCESSING. Completion belongs to get-receipt-extraction alone. That split is what
//   keeps the asynchronous shape the only path there is — a request function that also
//   completed would leave the polling branch dead until a genuinely asynchronous provider
//   arrived, and then discover it broken.
//
//   `record_receipt_extraction_success` is NEVER called from this file, and
//   lib/receipts/receipt-extraction-safety.test.ts fails the build if it appears.
//
// TWO INDEPENDENT GATES, AND NEITHER IS REACHABLE BY A CLIENT
//   1. The DATABASE gate: public.receipt_extraction_runtime.mode, seeded DISABLED. It is
//      read inside request_receipt_extraction and guards the INSERT and nothing else.
//   2. The EDGE gate: RECEIPT_EXTRACTION_MODE, read below and evaluated only AFTER
//      authentication, parsing and authorization have all succeeded.
//   No request body field, query parameter, header, JWT claim, role, filename, MIME type or
//   file hash participates in either decision.
//
// THE ORDER OF THE CHECKS IS A SECURITY PROPERTY. An unauthenticated caller gets 401, a
//   malformed body 400, an unauthorized role 403 and an unreadable receipt 404 — every one
//   of them BEFORE the mode is consulted. Disabled mode is indistinguishable from
//   infrastructure unavailability only for a caller who has already proven they may see this
//   specific receipt.
//
// NO GLOBAL REAPER. expire_stale_receipt_extraction_claims is only ever called with ONE
//   extraction id, obtained from a caller-authorized read. Passing NULL would sweep every
//   expired row in the database from a user-triggered request path.
//
// WHAT NEVER LEAVES THIS FUNCTION. The storage bucket, the object path, the file hash, the
//   claim token, the provider operation id, the service-role key and the publishable key are
//   consumed here and appear in no response body, no header and no log line. The response is
//   built by RE-READING through the caller's own RPC, never by echoing a service-role result.
//
// PROVIDER NETWORK IS ISOLATED. This function reads server-only configuration and
// delegates provider construction to the shared selector. It never calls fetch directly,
// logs a credential, or includes provider configuration in a client response.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.6";

import {
  corsJsonResponse,
  corsPreflightResponse,
} from "../../../lib/receipts/receipt-cors.ts";
import {
  parseExtractionRequest,
  type ExtractionResponseStatus,
} from "../../../lib/receipts/receipt-extraction-request-contract.ts";
import {
  AZURE_DI_API_VERSION_ENV,
  AZURE_DI_ENDPOINT_ENV,
  AZURE_DI_KEY_ENV,
  AZURE_DI_MODEL_ENV,
} from "../../../lib/receipts/receipt-extraction-azure-config.ts";
import {
  RECEIPT_EXTRACTION_FIXTURE_ENV,
  RECEIPT_EXTRACTION_FAKE_PENDING_MS_ENV,
  RECEIPT_EXTRACTION_MODE_ENV,
} from "../../../lib/receipts/receipt-extraction-mode.ts";
import {
  resolveReceiptExtractionRequestProvider,
} from "../../../lib/receipts/receipt-extraction-provider-selection.ts";
import {
  runExtractionRequestFlow,
  type ExtractionRequestPorts,
} from "../../../lib/receipts/receipt-extraction-flow.ts";

/** The RPCs this function calls, and the privilege level each runs at. */
const ACCESS_RPC = "assert_my_receipt_extraction_access" as const; // caller's own token
const GET_EXTRACTION_RPC = "get_my_receipt_extraction" as const; // caller's own token
const GET_CONFIRMATION_RPC = "get_my_receipt_confirmation" as const; // caller's own token
const REQUEST_RPC = "request_receipt_extraction" as const; // caller's own token
const EXPIRE_RPC = "expire_stale_receipt_extraction_claims" as const; // service role
const CLAIM_RPC = "claim_receipt_extraction_job" as const; // service role
const RECORD_OPERATION_RPC = "record_receipt_extraction_operation" as const; // service role
const RECORD_FAILURE_RPC = "record_receipt_extraction_failure" as const; // service role

/** The SQLSTATE the authenticated RPCs raise for an unauthorized caller. */
const INSUFFICIENT_PRIVILEGE = "42501";

/** Per-call budgets. There is NO retry loop anywhere: retry is the caller's explicit act. */
const RPC_TIMEOUT_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * Sanitized operator logging. No ids, paths, hashes, buckets, tokens, operation ids, URLs,
 * environment values or error objects — identical posture to submit-receipt's logFailure.
 */
function logFailure(category: string): void {
  console.error(`[request-receipt-extraction] ${category}`);
}

function json(
  status: ExtractionResponseStatus,
  httpStatus: number,
  extra?: Record<string, unknown>,
): Response {
  return corsJsonResponse({ status, ...extra }, httpStatus);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPublishableKey(): string | null {
  return (
    nonEmptyString(Deno.env.get("SUPABASE_PUBLISHABLE_KEY")) ??
    nonEmptyString(Deno.env.get("SUPABASE_ANON_KEY"))
  );
}

/**
 * The EXPLICIT allowlist of fields that may appear in an extraction payload.
 *
 * Copied key by key rather than spread, so a column added to get_my_receipt_extraction by a
 * future migration cannot reach a client until somebody adds it here deliberately.
 *
 * `retry_allowed` is the ONLY field this layer may modify, and it may only be NARROWED:
 * `rpc && edgeEnabled`. There is no branch that assigns `true`. attempts_used and
 * attempts_remaining are passed through untouched — they are facts about persisted rows and
 * are never used to signal availability.
 */
function safeExtractionPayload(
  row: Record<string, unknown>,
  edgeEnabled: boolean,
): Record<string, unknown> {
  return {
    submission_id: row.submission_id,
    extraction_id: row.extraction_id,
    status: row.status,
    attempt_number: row.attempt_number,
    attempts_used: row.attempts_used,
    attempts_remaining: row.attempts_remaining,
    retry_allowed: row.retry_allowed === true && edgeEnabled,
    manual_confirmation_allowed: row.manual_confirmation_allowed,
    confirmation_exists: row.confirmation_exists,
    failure_code: row.failure_code,
    requested_at: row.requested_at,
    completed_at: row.completed_at,
    merchant_name: row.merchant_name,
    merchant_name_source_text: row.merchant_name_source_text,
    merchant_name_confidence: row.merchant_name_confidence,
    document_number: row.document_number,
    document_number_source_text: row.document_number_source_text,
    document_number_confidence: row.document_number_confidence,
    transaction_date: row.transaction_date,
    transaction_date_source_text: row.transaction_date_source_text,
    transaction_date_confidence: row.transaction_date_confidence,
    transaction_time: row.transaction_time,
    transaction_time_source_text: row.transaction_time_source_text,
    transaction_time_confidence: row.transaction_time_confidence,
    currency_code: row.currency_code,
    currency_code_source_text: row.currency_code_source_text,
    currency_code_confidence: row.currency_code_confidence,
    currency_minor_unit: row.currency_minor_unit,
    total_minor: row.total_minor,
    total_source_text: row.total_source_text,
    total_confidence: row.total_confidence,
    subtotal_minor: row.subtotal_minor,
    subtotal_source_text: row.subtotal_source_text,
    subtotal_confidence: row.subtotal_confidence,
    tax_total_minor: row.tax_total_minor,
    tax_source_text: row.tax_source_text,
    tax_confidence: row.tax_confidence,
    warning_codes: row.warning_codes,
    line_item_count: row.line_item_count,
  };
}

/** The same narrowing rule, for the counters returned when no extraction row exists. */
function stateResponse(
  outcome: string,
  counters: {
    attemptsUsed: number;
    attemptsRemaining: number;
    retryAllowed: boolean;
    manualConfirmationAllowed: boolean;
  },
  extraction: Record<string, unknown> | null,
  edgeEnabled: boolean,
): Response {
  return json("ok", 200, {
    outcome,
    attempts_used: counters.attemptsUsed,
    attempts_remaining: counters.attemptsRemaining,
    retry_allowed: counters.retryAllowed && edgeEnabled,
    manual_confirmation_allowed: counters.manualConfirmationAllowed,
    extraction,
  });
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const row = data[0];
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
}

function asInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  return fallback;
}

async function handleRequest(request: Request): Promise<Response> {
  // ---- 1. Method and CORS ---------------------------------------------------
  // Answered BEFORE authentication, and it must be: a browser sends a preflight with no
  // Authorization header, so refusing it would block every cross-origin caller.
  if (request.method === "OPTIONS") return corsPreflightResponse();
  if (request.method !== "POST") return json("invalid", 405, { reason: "method-not-allowed" });

  // ---- 2. Required server configuration -------------------------------------
  const supabaseUrl = nonEmptyString(Deno.env.get("SUPABASE_URL"));
  const publishableKey = readPublishableKey();
  const serviceRoleKey = nonEmptyString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  if (supabaseUrl === null || publishableKey === null || serviceRoleKey === null) {
    logFailure("configuration is incomplete");
    return json("unavailable", 503);
  }

  // ---- 3. Bearer-token extraction -------------------------------------------
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("Authorization") ?? "");
  if (bearer === null) return json("unauthenticated", 401);
  const accessToken = bearer[1];

  const asCaller: SupabaseClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  // ---- 4. auth.getUser revalidation -----------------------------------------
  // REVALIDATES with the Auth server rather than decoding the token, which is what makes a
  // revoked or expired session fail here. Same rule lib/supabase/server.ts states.
  const userResult = await asCaller.auth.getUser(accessToken).catch(() => null);
  if (userResult === null || userResult.error || !userResult.data?.user) {
    return json("unauthenticated", 401);
  }

  // ---- 5. Strict body parsing ------------------------------------------------
  const rawBody = await request.text().catch(() => null);
  if (rawBody === null) {
    logFailure("could not read the request body");
    return json("invalid", 400, { reason: "malformed-body" });
  }

  const parsed = parseExtractionRequest(rawBody);
  if (parsed.status !== "ok") return json("invalid", 400, { reason: parsed.reason });
  const submissionId = parsed.request.submissionId;

  // ---- 6/7. Authorization, under the CALLER'S OWN TOKEN -----------------------
  const access = await asCaller
    .rpc(ACCESS_RPC, { p_submission_id: submissionId })
    .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
    .then((result) => result, () => null);

  if (access === null) {
    logFailure("access check transport");
    return json("unavailable", 503);
  }
  if (access.error) {
    // 42501 means "not an authorized Sales Staff member at all". Only the CODE is read;
    // the message is never bound, returned or logged.
    if ((access.error as { code?: string }).code === INSUFFICIENT_PRIVILEGE) {
      return json("denied", 403);
    }
    logFailure("access check rpc-error");
    return json("unavailable", 503);
  }
  if (access.data !== true) {
    // Unknown, another person's, another Retailer's, or not SUBMITTED — all identical.
    return json("not-found", 404);
  }

  const asService: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const readExtraction = async (): Promise<Record<string, unknown> | null | "error"> => {
    const result = await asCaller
      .rpc(GET_EXTRACTION_RPC, { p_submission_id: submissionId })
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
      .then((r) => r, () => null);
    if (result === null || result.error) return "error";
    return firstRow(result.data);
  };

  // ---- 8. Read the existing extraction state ---------------------------------
  let extractionRow = await readExtraction();
  if (extractionRow === "error") {
    logFailure("extraction read failed");
    return json("unavailable", 503);
  }

  // ---- 9. No attempt yet: is there a confirmation? ----------------------------
  // A MANUAL confirmation can exist with no extraction at all (source_extraction_id is
  // null), so the extraction read alone cannot answer this.
  if (extractionRow === null) {
    const confirmation = await asCaller
      .rpc(GET_CONFIRMATION_RPC, { p_submission_id: submissionId })
      .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
      .then((r) => r, () => null);

    if (confirmation === null || confirmation.error) {
      logFailure("confirmation read failed");
      return json("unavailable", 503);
    }
    if (firstRow(confirmation.data) !== null) {
      return stateResponse(
        "ALREADY_CONFIRMED",
        {
          attemptsUsed: 0,
          attemptsRemaining: 3,
          retryAllowed: false,
          manualConfirmationAllowed: false,
        },
        null,
        false,
      );
    }
  }

  // ---- 10/11. Scope-expire ONE stale attempt, then re-read --------------------
  // Cleanup, not creation, so it runs BEFORE the mode gate: an operator who disables
  // extraction must not strand an open attempt against the active-attempt unique index.
  if (
    extractionRow !== null &&
    (extractionRow.status === "QUEUED" || extractionRow.status === "PROCESSING")
  ) {
    const extractionId = nonEmptyString(extractionRow.extraction_id);
    if (extractionId !== null) {
      const expired = await asService
        .rpc(EXPIRE_RPC, { p_extraction_id: extractionId })
        .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
        .then((r) => r, () => null);

      if (expired !== null && !expired.error && asInteger(expired.data, 0) === 1) {
        const reread = await readExtraction();
        if (reread === "error") {
          logFailure("extraction re-read failed");
          return json("unavailable", 503);
        }
        extractionRow = reread;
      }
    }
  }

  // ---- 12. Report existing state, WITHOUT consulting either gate --------------
  // These outcomes create nothing and are identical whether extraction is enabled or not,
  // so answering them while a gate is shut leaks no configuration.
  // Provider selection is server-environment-only and performs no network work.
  // A malformed mode, fixture or Azure configuration resolves to null.
  const provider = resolveReceiptExtractionRequestProvider({
    mode: Deno.env.get(RECEIPT_EXTRACTION_MODE_ENV),
    fakeFixture:
      Deno.env.get(RECEIPT_EXTRACTION_FIXTURE_ENV),
    fakePendingMs:
      Deno.env.get(RECEIPT_EXTRACTION_FAKE_PENDING_MS_ENV),
    azureEndpoint:
      Deno.env.get(AZURE_DI_ENDPOINT_ENV),
    azureKey:
      Deno.env.get(AZURE_DI_KEY_ENV),
    azureApiVersion:
      Deno.env.get(AZURE_DI_API_VERSION_ENV),
    azureModel:
      Deno.env.get(AZURE_DI_MODEL_ENV),
  });

  const edgeEnabled = provider !== null;

  if (extractionRow !== null) {
    const status = extractionRow.status;
    const attemptsUsed = asInteger(extractionRow.attempts_used, 0);

    if (extractionRow.confirmation_exists === true) {
      return json("ok", 200, {
        outcome: "ALREADY_CONFIRMED",
        attempts_used: attemptsUsed,
        attempts_remaining: asInteger(extractionRow.attempts_remaining, 0),
        retry_allowed: false,
        manual_confirmation_allowed: false,
        extraction: safeExtractionPayload(extractionRow, edgeEnabled),
      });
    }
    if (status === "SUCCEEDED" || status === "QUEUED" || status === "PROCESSING") {
      return json("ok", 200, {
        outcome: status === "SUCCEEDED" ? "SUCCEEDED" : "ACTIVE",
        attempts_used: attemptsUsed,
        attempts_remaining: asInteger(extractionRow.attempts_remaining, 0),
        retry_allowed: false,
        manual_confirmation_allowed: extractionRow.manual_confirmation_allowed === true,
        extraction: safeExtractionPayload(extractionRow, edgeEnabled),
      });
    }
    if (attemptsUsed >= 3) {
      return json("ok", 200, {
        outcome: "EXHAUSTED",
        attempts_used: attemptsUsed,
        attempts_remaining: 0,
        retry_allowed: false,
        manual_confirmation_allowed: true,
        extraction: safeExtractionPayload(extractionRow, edgeEnabled),
      });
    }
  }

  // ---- 13/14. The Edge gate, guarding creation and provider work only ---------
  if (provider === null) {
    logFailure("extraction mode or provider configuration disabled");
    const attemptsUsed = extractionRow === null ? 0 : asInteger(extractionRow.attempts_used, 0);
    return stateResponse(
      "EXTRACTION_UNAVAILABLE",
      {
        attemptsUsed,
        attemptsRemaining: Math.max(0, 3 - attemptsUsed),
        retryAllowed: false,
        manualConfirmationAllowed: true,
      },
      extractionRow === null ? null : safeExtractionPayload(extractionRow, false),
      false,
    );
  }

  // ---- 15. THE FIRST MUTATION. Nothing above this line writes an attempt. -----
  const requested = await asCaller
    .rpc(REQUEST_RPC, { p_submission_id: submissionId })
    .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
    .then((r) => r, () => null);

  if (requested === null) {
    logFailure("request transport");
    return json("unavailable", 503);
  }
  if (requested.error) {
    if ((requested.error as { code?: string }).code === INSUFFICIENT_PRIVILEGE) {
      return json("denied", 403);
    }
    logFailure("request rpc-error");
    return json("unavailable", 503);
  }

  const requestRow = firstRow(requested.data);
  if (requestRow === null) return json("not-found", 404);

  // ---- 16. When a new attempt exists: claim, download, submit, register -------
  if (requestRow.outcome === "QUEUED") {
    const extractionId = nonEmptyString(requestRow.extraction_id);

    if (extractionId === null) {
      logFailure("request returned an unusable result");
      return json("unavailable", 503);
    }

    // The provider was selected before the first mutation. Its name and model
    // are persisted by the database claim before any receipt bytes are transmitted.
    const ports: ExtractionRequestPorts = {
      async claim({ extractionId: id }) {
        const result = await asService
          .rpc(CLAIM_RPC, {
            p_extraction_id: id,
            p_provider: provider.name,
            p_provider_model: provider.model,
          })
          .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
          .then((r) => r, () => null);

        if (result === null || result.error) {
          logFailure("claim failed");
          return { status: "unavailable" };
        }
        const row = firstRow(result.data);
        if (row === null) return { status: "lost" };

        const claimToken = nonEmptyString(row.claim_token);
        const bucket = nonEmptyString(row.storage_bucket);
        const objectPath = nonEmptyString(row.storage_object_path);
        const mimeType = nonEmptyString(row.mime_type);

        if (claimToken === null || bucket === null || objectPath === null || mimeType === null) {
          logFailure("claim returned an unusable result");
          return { status: "unavailable" };
        }
        return {
          status: "ok",
          claimToken,
          storageBucket: bucket,
          storageObjectPath: objectPath,
          mimeType,
          attemptNumber: asInteger(row.attempt_number, 1),
        };
      },

      async download({ storageBucket, storageObjectPath }) {
        const result = await Promise.race([
          asService.storage.from(storageBucket).download(storageObjectPath),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), DOWNLOAD_TIMEOUT_MS)),
        ]).catch(() => null);

        if (result === null || result.error || !result.data) {
          // A Storage error can name the bucket, the key, the account and a request id. It
          // is not bound, returned, or logged.
          logFailure("object download failed");
          return { status: "failed" };
        }
        try {
          return { status: "ok", bytes: new Uint8Array(await result.data.arrayBuffer()) };
        } catch {
          logFailure("object could not be read");
          return { status: "failed" };
        }
      },

      async registerOperation({ extractionId: id, claimToken, providerOperationId }) {
        const result = await asService
          .rpc(RECORD_OPERATION_RPC, {
            p_extraction_id: id,
            p_claim_token: claimToken,
            p_provider_operation_id: providerOperationId,
          })
          .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
          .then((r) => r, () => null);

        if (result === null || result.error) {
          logFailure("operation registration failed");
          return { status: "failed" };
        }
        return { status: "ok" };
      },

      async recordFailure({ extractionId: id, claimToken, providerOperationId, failureCode }) {
        const result = await asService
          .rpc(RECORD_FAILURE_RPC, {
            p_extraction_id: id,
            p_claim_token: claimToken,
            p_provider_operation_id: providerOperationId,
            p_failure_code: failureCode,
          })
          .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
          .then((r) => r, () => null);

        if (result === null || result.error) {
          logFailure("failure could not be recorded");
          return { status: "failed" };
        }
        return { status: "ok" };
      },

      provider,
    };

    // The ORDER lives in the shared pure module, so this function and any future worker
    // cannot execute a different sequence.
    await runExtractionRequestFlow({ extractionId }, ports);
  }

  // ---- 17. The response: a caller-scoped read-back, always --------------------
  // Built by re-reading through the caller's own RPC rather than by echoing anything a
  // service-role call returned, which is what makes a storage path, a claim token or an
  // operation id structurally unable to reach the wire.
  const finalRow = await readExtraction();
  if (finalRow === "error") {
    logFailure("final read failed");
    return json("unavailable", 503);
  }

  const attemptsUsed = finalRow === null
    ? asInteger(requestRow.attempts_used, 0)
    : asInteger(finalRow.attempts_used, 0);

  return json("ok", 200, {
    outcome: requestRow.outcome,
    attempts_used: attemptsUsed,
    attempts_remaining: Math.max(0, 3 - attemptsUsed),
    retry_allowed: requestRow.retry_allowed === true && edgeEnabled,
    manual_confirmation_allowed: requestRow.manual_confirmation_allowed === true,
    extraction: finalRow === null ? null : safeExtractionPayload(finalRow, edgeEnabled),
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    return await handleRequest(request);
  } catch {
    // THE LAST RESPONSE THAT COULD HAVE ESCAPED THE CORS POLICY. An uncaught throw becomes a
    // runtime-generated 500 carrying no CORS headers, which a browser discards without ever
    // showing the client a status or a body. The error is not bound, echoed or logged: it
    // can quote a request body, an object path or a provider message.
    logFailure("unexpected error");
    return json("unavailable", 503);
  }
});
