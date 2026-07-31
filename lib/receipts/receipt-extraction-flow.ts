/**
 * PURE MODULE — no imports beyond sibling types, no I/O, no environment, no side effects.
 *
 * THE ORDER OF THE WORKER SEQUENCE, stated once, over injected ports.
 *
 * WHY THE ORDER LIVES HERE AND NOT IN THE EDGE FUNCTIONS. The same sequence is driven today
 * by two Deno functions and will be driven tomorrow by an out-of-process worker. If each
 * caller expressed the order itself, each could express a DIFFERENT order — and the orders
 * that look reasonable but are wrong are exactly the dangerous ones: submitting to the
 * provider before registering the operation identifier loses the ability to correlate a
 * result; recording success before registering it makes the operation check vacuous.
 * lib/receipts/receipt-submission-flow.ts exists for the identical reason on the upload
 * path, and this module follows it deliberately.
 *
 * THE REQUEST PATH NEVER RECORDS SUCCESS. `runExtractionRequestFlow` claims, downloads,
 * submits and registers — and then stops, leaving the attempt PROCESSING. Completion
 * belongs exclusively to `runExtractionPollFlow`. That split is what keeps the asynchronous
 * shape the only path there is; a request function that could also complete would make the
 * polling branch dead code until a genuinely asynchronous provider arrived.
 *
 * THE ONE FAILURE THE REQUEST PATH MAY RECORD is OBJECT_UNREADABLE, and only because the
 * object could not be fetched. Leaving that attempt PROCESSING would make the submitter
 * wait out the full claim deadline before the reaper freed it, for a fault we already know
 * about.
 *
 * NO RETRY LOOP, ANYWHERE. Neither flow retries a port. A retry is the caller's explicit
 * act, through request_receipt_extraction, which is the only path that respects the
 * three-attempt maximum. An automatic retry inside a flow would consume that budget
 * invisibly.
 */

import type {
  ExtractionPollResult,
  NormalizedExtraction,
  NormalizedLineItem,
  ReceiptExtractionProvider,
} from "./receipt-extraction-provider.ts";
import type { ExtractionFailureCode } from "./receipt-extraction-vocabulary.ts";

/* ---------------------------------------------------------------------------
 * The request path: claim -> download -> submit -> register
 * ------------------------------------------------------------------------- */

export type ClaimResult =
  | {
      readonly status: "ok";
      readonly claimToken: string;
      readonly storageBucket: string;
      readonly storageObjectPath: string;
      readonly mimeType: string;
      readonly attemptNumber: number;
    }
  /** Another worker took it, or it is no longer QUEUED. A NORMAL outcome, not an error. */
  | { readonly status: "lost" }
  | { readonly status: "unavailable" };

export type DownloadResult =
  | { readonly status: "ok"; readonly bytes: Uint8Array }
  | { readonly status: "failed" };

export type AcknowledgeResult = { readonly status: "ok" } | { readonly status: "failed" };

export type ExtractionRequestPorts = {
  claim(input: { readonly extractionId: string }): Promise<ClaimResult>;
  download(input: {
    readonly storageBucket: string;
    readonly storageObjectPath: string;
  }): Promise<DownloadResult>;
  registerOperation(input: {
    readonly extractionId: string;
    readonly claimToken: string;
    readonly providerOperationId: string;
  }): Promise<AcknowledgeResult>;
  recordFailure(input: {
    readonly extractionId: string;
    readonly claimToken: string;
    readonly providerOperationId: string | null;
    readonly failureCode: ExtractionFailureCode;
  }): Promise<AcknowledgeResult>;
  readonly provider: ReceiptExtractionProvider;
};

export type ExtractionRequestOutcome =
  /** Claimed, submitted and registered. The attempt is PROCESSING and awaits a poll. */
  | { readonly status: "submitted" }
  /** Another worker claimed it first. Nothing was written; read the state back. */
  | { readonly status: "lost-claim" }
  /** The object could not be read. The attempt was failed with OBJECT_UNREADABLE. */
  | { readonly status: "object-unreadable" }
  /** The provider refused the submission outright. The attempt was failed. */
  | { readonly status: "submit-failed" }
  /** A step could not be completed. The attempt is left for the reaper. */
  | { readonly status: "unavailable" };

/**
 * Claims a QUEUED attempt and gets it as far as PROCESSING with a registered operation.
 *
 * `extractionId` is supplied by the caller from a CALLER-AUTHORIZED read — this flow never
 * discovers work of its own, and there is no path here that scans for jobs.
 */
export async function runExtractionRequestFlow(
  input: { readonly extractionId: string },
  ports: ExtractionRequestPorts,
): Promise<ExtractionRequestOutcome> {
  // 1. Claim. A single conditional UPDATE in SQL is the concurrency authority; losing is
  //    a normal outcome and is reported as such rather than as an error.
  const claim = await ports.claim({ extractionId: input.extractionId });

  if (claim.status === "lost") return { status: "lost-claim" };
  if (claim.status !== "ok") return { status: "unavailable" };

  // 2. Download. The bucket and path came from the claim and never from a client.
  const download = await ports.download({
    storageBucket: claim.storageBucket,
    storageObjectPath: claim.storageObjectPath,
  });

  if (download.status !== "ok") {
    // The pre-provider failure path: no operation exists, so the operation id supplied to
    // record_receipt_extraction_failure must be null, and the only code that RPC accepts
    // in that shape is OBJECT_UNREADABLE.
    await ports.recordFailure({
      extractionId: input.extractionId,
      claimToken: claim.claimToken,
      providerOperationId: null,
      failureCode: "OBJECT_UNREADABLE",
    });
    return { status: "object-unreadable" };
  }

  // 3. Submit to the provider.
  const submitted = await ports.provider.submit({
    bytes: download.bytes,
    mimeType: claim.mimeType,
  });

  if (submitted.status !== "ok") {
    // The provider refused before issuing an operation, so this is still the pre-provider
    // shape: the stored operation id is null and must be reported as null.
    await ports.recordFailure({
      extractionId: input.extractionId,
      claimToken: claim.claimToken,
      providerOperationId: null,
      failureCode: submitted.failureCode,
    });
    return { status: "submit-failed" };
  }

  // 4. Register the operation identifier. This is the PROCESSING -> PROCESSING transition,
  //    permitted exactly once, and it is what makes every later completion provable
  //    against a specific provider operation.
  const registered = await ports.registerOperation({
    extractionId: input.extractionId,
    claimToken: claim.claimToken,
    providerOperationId: submitted.providerOperationId,
  });

  if (registered.status !== "ok") {
    // Deliberately NOT failed here. The registration RPC refuses for exactly one reason
    // that matters — this worker no longer holds an open claim — and in that case the row
    // is already terminal or already registered, so writing to it would be wrong. The
    // reaper owns anything genuinely stuck.
    return { status: "unavailable" };
  }

  return { status: "submitted" };
}

/* ---------------------------------------------------------------------------
 * The poll path: read worker state -> poll once -> complete
 * ------------------------------------------------------------------------- */

export type WorkerState = {
  readonly status: string;
  readonly claimToken: string | null;
  readonly providerOperationId: string | null;
  readonly startedAtMs: number | null;
};

export type WorkerStateResult =
  | { readonly status: "ok"; readonly state: WorkerState }
  | { readonly status: "missing" };

export type ExtractionPollPorts = {
  workerState(input: { readonly extractionId: string }): Promise<WorkerStateResult>;
  recordSuccess(input: {
    readonly extractionId: string;
    readonly claimToken: string;
    readonly providerOperationId: string;
    readonly normalized: NormalizedExtraction;
    readonly lineItems: readonly NormalizedLineItem[];
  }): Promise<AcknowledgeResult>;
  recordFailure(input: {
    readonly extractionId: string;
    readonly claimToken: string;
    readonly providerOperationId: string;
    readonly failureCode: ExtractionFailureCode;
  }): Promise<AcknowledgeResult>;
  readonly provider: ReceiptExtractionProvider;
  /** Injected so this module reads no clock of its own. */
  readonly nowMs: number;
};

export type ExtractionPollOutcome =
  /** The provider has not finished. The attempt stays PROCESSING. */
  | { readonly status: "pending" }
  | { readonly status: "completed-success" }
  | { readonly status: "completed-failure"; readonly failureCode: ExtractionFailureCode }
  /** Not in a pollable shape: not PROCESSING, or no operation registered yet. */
  | { readonly status: "not-pollable" }
  | { readonly status: "unavailable" };

/**
 * Polls the provider ONCE and completes the attempt when the answer is terminal.
 *
 * ONCE, not until-done. A loop would hold the invocation open and hide latency the client
 * must be able to see, and it would turn one provider hiccup into a wedged request.
 */
export async function runExtractionPollFlow(
  input: { readonly extractionId: string },
  ports: ExtractionPollPorts,
): Promise<ExtractionPollOutcome> {
  const read = await ports.workerState({ extractionId: input.extractionId });

  if (read.status !== "ok") return { status: "unavailable" };

  const state = read.state;

  // Only a PROCESSING attempt that has registered an operation can be polled. A QUEUED
  // attempt has no operation; a terminal attempt is finished and immutable.
  if (
    state.status !== "PROCESSING" ||
    state.claimToken === null ||
    state.providerOperationId === null ||
    state.startedAtMs === null
  ) {
    return { status: "not-pollable" };
  }

  const polled: ExtractionPollResult = await ports.provider.poll({
    providerOperationId: state.providerOperationId,
    startedAtMs: state.startedAtMs,
    nowMs: ports.nowMs,
  });

  if (polled.status === "pending") return { status: "pending" };

  if (polled.status === "failed") {
    const recorded = await ports.recordFailure({
      extractionId: input.extractionId,
      claimToken: state.claimToken,
      providerOperationId: state.providerOperationId,
      failureCode: polled.failureCode,
    });
    return recorded.status === "ok"
      ? { status: "completed-failure", failureCode: polled.failureCode }
      : { status: "unavailable" };
  }

  const recorded = await ports.recordSuccess({
    extractionId: input.extractionId,
    claimToken: state.claimToken,
    providerOperationId: state.providerOperationId,
    normalized: polled.normalized,
    lineItems: polled.lineItems,
  });

  return recorded.status === "ok" ? { status: "completed-success" } : { status: "unavailable" };
}
