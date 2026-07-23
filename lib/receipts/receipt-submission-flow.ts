/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client, no crypto.
 *
 * The ORDER of the receipt reserve → upload → finalize sequence, expressed once, with
 * every effect injected. The server module that supplies the real ports
 * (lib/receipts/receipt-submissions.ts) cannot be unit-tested — importing it pulls in
 * `next/headers` and the service-role client — so the sequence itself lives here and is
 * exercised directly by ./receipt-submission-flow.test.ts against fake ports that
 * record what was called, in what order, with what arguments.
 *
 * THE SEQUENCE, and why each step is where it is:
 *
 *   1. reserve   — under the CALLER'S OWN token. This is the authorization step: the
 *                  RPC derives the Retailer, profile and membership from auth.uid(),
 *                  proves the chosen shop is ACTIVE, this Retailer's, and actively
 *                  assigned to this person, applies duplicate protection, and generates
 *                  the private object path. It runs FIRST so that a refusal costs
 *                  nothing and leaves no object behind.
 *   2. upload    — through the SERVICE-ROLE Storage client, to the bucket and path the
 *                  reservation generated. Neither value came from the browser.
 *   3. finalize  — service-role. Re-asserts hash, path, type and size against the
 *                  reserved row and only then marks it SUBMITTED.
 *
 * FAILURE LEAVES NOTHING FALSELY COMPLETE. If the upload fails, or the finalize fails
 * after a successful upload, the flow removes the object (best effort) and records the
 * fixed UPLOAD_FAILED classification. A row is only ever SUBMITTED because finalize
 * said so, and finalize only says so when the object is where the reservation said it
 * would be.
 *
 * NOTHING SECRET ESCAPES. The object path and the file hash are consumed inside this
 * sequence and appear in no result variant, so nothing this returns can carry them
 * toward a browser.
 */

/** Everything the reservation needs. Already validated by the file layer. */
export type ReceiptReserveInput = {
  shopId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

export type ReceiptReserveResult =
  | {
      status: "ok";
      submissionId: string;
      /** Server-generated. Never returned to a browser. */
      bucket: string;
      objectPath: string;
    }
  /** This person already has a live submission of this exact file for this Retailer. */
  | { status: "duplicate" }
  /** Not an authorized Sales Staff member, or the shop is not theirs / not active. */
  | { status: "denied" }
  /** The database refused the file facts. Reachable only from a tampered call. */
  | { status: "invalid" }
  | { status: "unavailable" };

export type ReceiptUploadResult = { status: "ok" } | { status: "failed" };
export type ReceiptFinalizeResult = { status: "ok" } | { status: "failed" };

export type ReceiptSubmissionPorts = {
  reserve(input: ReceiptReserveInput): Promise<ReceiptReserveResult>;
  upload(input: { bucket: string; objectPath: string }): Promise<ReceiptUploadResult>;
  finalize(input: {
    submissionId: string;
    sha256: string;
    objectPath: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<ReceiptFinalizeResult>;
  /** Best effort. Never changes the reported outcome. */
  removeObject(input: { bucket: string; objectPath: string }): Promise<void>;
  /** Best effort. Records only the fixed classification; accepts no provider text. */
  recordFailure(input: { submissionId: string; sha256: string }): Promise<void>;
};

/** The closed set of outcomes. No id, path, hash, bucket, or provider detail. */
export type ReceiptSubmissionResult =
  | { status: "submitted" }
  /** Reserved, but the object did not land — or could not be confirmed. Retryable. */
  | { status: "upload-failed" }
  | { status: "duplicate" }
  | { status: "denied" }
  | { status: "invalid" }
  | { status: "unavailable" };

/**
 * Runs the receipt submission sequence.
 *
 * @param input the validated file facts and the chosen shop id.
 */
export async function runReceiptSubmissionFlow(
  input: ReceiptReserveInput,
  ports: ReceiptSubmissionPorts,
): Promise<ReceiptSubmissionResult> {
  // 1. Reserve, under the caller's own token. Authorization happens here.
  const reserved = await ports.reserve(input);

  if (reserved.status === "duplicate") return { status: "duplicate" };
  if (reserved.status === "denied") return { status: "denied" };
  if (reserved.status === "invalid") return { status: "invalid" };
  if (reserved.status !== "ok") return { status: "unavailable" };

  const location = { bucket: reserved.bucket, objectPath: reserved.objectPath };

  // 2. Upload to the server-generated location.
  const uploaded = await ports.upload(location);

  if (uploaded.status !== "ok") {
    // The object may or may not exist — a failure can happen mid-transfer — so removal
    // is attempted regardless and its own outcome is ignored. Then the row is marked
    // failed, so the history shows the truth and the same file can be retried.
    await ports.removeObject(location);
    await ports.recordFailure({
      submissionId: reserved.submissionId,
      sha256: input.sha256,
    });
    return { status: "upload-failed" };
  }

  // 3. Finalize. The row becomes SUBMITTED only if every fact still matches.
  const finalized = await ports.finalize({
    submissionId: reserved.submissionId,
    sha256: input.sha256,
    objectPath: reserved.objectPath,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
  });

  if (finalized.status !== "ok") {
    // The bytes are in the bucket but the row could not be completed. Leaving the
    // object would orphan it and leaving the row RESERVED would hide the problem from
    // the submitter, so both are cleaned up: object removed, row marked failed. The
    // person is told it failed, which is true — nothing they can rely on was recorded.
    await ports.removeObject(location);
    await ports.recordFailure({
      submissionId: reserved.submissionId,
      sha256: input.sha256,
    });
    return { status: "upload-failed" };
  }

  return { status: "submitted" };
}
