// Supabase Edge Function: get-receipt-extraction
//
// READS the extraction state of one receipt the caller submitted themselves, and — when the
// attempt is genuinely in flight and the gate is open — polls the provider ONCE and
// completes it.
//
// THIS IS THE ONLY FUNCTION THAT COMPLETES AN ATTEMPT. request-receipt-extraction claims,
//   submits and registers, then stops at PROCESSING. Keeping completion here is what makes
//   the asynchronous shape the only path there is: the PENDING branch, the PROCESSING state
//   and the reaper are exercised on every ordinary run rather than being scaffolding that
//   waits for a genuinely asynchronous provider to arrive and then turns out to be broken.
//
// ONE POLL PER CALL, NEVER A LOOP. A loop would hold the invocation open and hide latency
//   the client must be able to see, and would turn one provider hiccup into a wedged request.
//   There is no automatic retry anywhere in this file.
//
// DISABLING EXECUTION MUST NEVER HIDE STORED EVIDENCE. A SUCCEEDED result and a FAILED
//   result are returned REGARDLESS of the Edge gate — they are facts already recorded, and a
//   configuration switch that made a staff member's own extracted values disappear would be
//   a data-availability bug dressed as a feature flag. The gate is consulted only when the
//   attempt is still open, and then only to decide whether to CLAIM, POLL or COMPLETE.
//
// NO GLOBAL REAPER. expire_stale_receipt_extraction_claims is only ever called with ONE
//   extraction id, obtained from a caller-authorized read.
//
// WHAT NEVER LEAVES THIS FUNCTION. The claim token, the provider operation id, the storage
//   bucket, the object path, the file hash and both keys are consumed here and appear in no
//   response body, no header and no log line. Every response is a re-read through the
//   caller's own RPC.
//
// NO AZURE. No endpoint, credential, SDK, region or service name appears in this file.

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
  isFakeExtractionEnabled,
  RECEIPT_EXTRACTION_FIXTURE_ENV,
  RECEIPT_EXTRACTION_FAKE_PENDING_MS_ENV,
  RECEIPT_EXTRACTION_MODE_ENV,
  resolveFakePendingMs,
} from "../../../lib/receipts/receipt-extraction-mode.ts";
import {
  createFakeProviderForKey,
  resolveFakeFixtureKey,
} from "../../../lib/receipts/receipt-extraction-fake-provider.ts";
import {
  runExtractionPollFlow,
  type ExtractionPollPorts,
} from "../../../lib/receipts/receipt-extraction-flow.ts";
import {
  buildSuccessLineItemsPayload,
  buildSuccessNormalizedPayload,
} from "../../../lib/receipts/receipt-extraction-normalization.ts";

const ACCESS_RPC = "assert_my_receipt_extraction_access" as const; // caller's own token
const GET_EXTRACTION_RPC = "get_my_receipt_extraction" as const; // caller's own token
const EXPIRE_RPC = "expire_stale_receipt_extraction_claims" as const; // service role
const WORKER_STATE_RPC = "get_receipt_extraction_worker_state" as const; // service role
const RECORD_SUCCESS_RPC = "record_receipt_extraction_success" as const; // service role
const RECORD_FAILURE_RPC = "record_receipt_extraction_failure" as const; // service role

const INSUFFICIENT_PRIVILEGE = "42501";
const RPC_TIMEOUT_MS = 5_000;

function logFailure(category: string): void {
  console.error(`[get-receipt-extraction] ${category}`);
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

/**
 * The EXPLICIT allowlist of client-visible extraction fields. Copied key by key so a column
 * added by a future migration cannot reach a client until it is added here deliberately.
 *
 * `retry_allowed` is the ONLY field this layer modifies, and only by NARROWING with `&&`.
 * There is no assignment of `true`. attempts_used and attempts_remaining pass through
 * untouched: they are facts about persisted rows, never availability signals.
 */
function safeExtractionPayload(
  row: Record<string, unknown>,
  edgeFakeEnabled: boolean,
): Record<string, unknown> {
  return {
    submission_id: row.submission_id,
    extraction_id: row.extraction_id,
    status: row.status,
    attempt_number: row.attempt_number,
    attempts_used: row.attempts_used,
    attempts_remaining: row.attempts_remaining,
    retry_allowed: row.retry_allowed === true && edgeFakeEnabled,
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

async function handleRequest(request: Request): Promise<Response> {
  // ---- 1. Method and CORS ---------------------------------------------------
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
    .then((r) => r, () => null);

  if (access === null) {
    logFailure("access check transport");
    return json("unavailable", 503);
  }
  if (access.error) {
    if ((access.error as { code?: string }).code === INSUFFICIENT_PRIVILEGE) {
      return json("denied", 403);
    }
    logFailure("access check rpc-error");
    return json("unavailable", 503);
  }
  if (access.data !== true) return json("not-found", 404);

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

  // ---- 8. The caller-scoped read ---------------------------------------------
  let row = await readExtraction();
  if (row === "error") {
    logFailure("extraction read failed");
    return json("unavailable", 503);
  }
  // No attempt exists for a receipt the caller demonstrably owns. Reported identically to an
  // unreadable id, which costs the client nothing: it knows it owns the receipt.
  if (row === null) return json("not-found", 404);

  const edgeFakeEnabled = isFakeExtractionEnabled(Deno.env.get(RECEIPT_EXTRACTION_MODE_ENV));

  // ---- 9/10. Scope-expire ONE stale attempt, then re-read ---------------------
  // Runs regardless of the Edge gate: reaping is cleanup, not execution, and an operator who
  // disables extraction must not leave an open attempt stranded against the active-attempt
  // unique index for the rest of that receipt's life.
  if (row.status === "QUEUED" || row.status === "PROCESSING") {
    const extractionId = nonEmptyString(row.extraction_id);
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
        if (reread === null) return json("not-found", 404);
        row = reread;
      }
    }
  }

  // ---- 11. Stored evidence is returned regardless of the gate -----------------
  if (row.status === "SUCCEEDED" || row.status === "FAILED") {
    return json("ok", 200, { extraction: safeExtractionPayload(row, edgeFakeEnabled) });
  }

  // ---- 12/13. Still open: NOW the gate decides whether any work happens -------
  if (!edgeFakeEnabled) {
    // No claim, no poll, no operation registration, no completion. The row is returned as it
    // stands; nothing about the configuration appears in the response.
    logFailure("extraction mode disabled");
    return json("ok", 200, { extraction: safeExtractionPayload(row, false) });
  }

  const extractionId = nonEmptyString(row.extraction_id);
  if (extractionId === null) {
    return json("ok", 200, { extraction: safeExtractionPayload(row, edgeFakeEnabled) });
  }

  // Env-only selection, as in request-receipt-extraction: the file hash is not plumbed to
  // the worker in Milestone A, so the default fixture applies when the variable is unset.
  const fixture = resolveFakeFixtureKey({
    fixtureEnv: Deno.env.get(RECEIPT_EXTRACTION_FIXTURE_ENV),
    fileSha256: null,
  });
  if (fixture.status !== "ok") {
    logFailure("configured fixture is unknown");
    return json("unavailable", 503);
  }

  const provider = createFakeProviderForKey(
    fixture.key,
    resolveFakePendingMs(Deno.env.get(RECEIPT_EXTRACTION_FAKE_PENDING_MS_ENV)),
  );

  // ---- 14. Read worker state, poll once, complete when terminal ---------------
  const ports: ExtractionPollPorts = {
    async workerState({ extractionId: id }) {
      const result = await asService
        .rpc(WORKER_STATE_RPC, { p_extraction_id: id })
        .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
        .then((r) => r, () => null);

      if (result === null || result.error) {
        logFailure("worker state read failed");
        return { status: "missing" };
      }
      const stateRow = firstRow(result.data);
      if (stateRow === null) return { status: "missing" };

      const startedAt = nonEmptyString(stateRow.started_at);
      return {
        status: "ok",
        state: {
          status: typeof stateRow.status === "string" ? stateRow.status : "",
          claimToken: nonEmptyString(stateRow.worker_claim_token),
          providerOperationId: nonEmptyString(stateRow.provider_operation_id),
          startedAtMs: startedAt === null ? null : Date.parse(startedAt),
        },
      };
    },

    async recordSuccess({ extractionId: id, claimToken, providerOperationId, normalized, lineItems }) {
      const result = await asService
        .rpc(RECORD_SUCCESS_RPC, {
          p_extraction_id: id,
          p_claim_token: claimToken,
          p_provider_operation_id: providerOperationId,
          // Built in one audited place, with exactly the keys the RPC's closed allowlist
          // admits. An extra key is 23514 there, so the two are one contract.
          p_normalized: buildSuccessNormalizedPayload(normalized),
          p_line_items: buildSuccessLineItemsPayload(lineItems),
        })
        .abortSignal(AbortSignal.timeout(RPC_TIMEOUT_MS))
        .then((r) => r, () => null);

      if (result === null || result.error) {
        logFailure("result could not be recorded");
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
    nowMs: Date.now(),
  };

  const outcome = await runExtractionPollFlow({ extractionId }, ports);

  // ---- 15. The response: a caller-scoped read-back, always --------------------
  if (outcome.status === "completed-success" || outcome.status === "completed-failure") {
    const finalRow = await readExtraction();
    if (finalRow === "error") {
      logFailure("final read failed");
      return json("unavailable", 503);
    }
    if (finalRow === null) return json("not-found", 404);
    return json("ok", 200, { extraction: safeExtractionPayload(finalRow, edgeFakeEnabled) });
  }

  return json("ok", 200, { extraction: safeExtractionPayload(row, edgeFakeEnabled) });
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    return await handleRequest(request);
  } catch {
    logFailure("unexpected error");
    return json("unavailable", 503);
  }
});
