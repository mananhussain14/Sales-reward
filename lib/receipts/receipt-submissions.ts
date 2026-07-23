// SERVER-ONLY MODULE.
//
// Wires the REAL effects into the pure sequence in
// @/lib/receipts/receipt-submission-flow. It transitively imports the service-role
// admin client and `next/headers`, so it can only ever run on the server, and it is
// never imported by a Client Component.
//
// WHICH CLIENT DOES WHAT, and why:
//   reserve                 — the CALLER'S OWN token (publishable key). This is the
//                             authorization step; it must run as the Sales Staff member
//                             so auth.uid() means something and the RPC can prove the
//                             shop assignment.
//   upload / remove object  — the SERVICE-ROLE Storage client. The `receipts` bucket is
//                             private and storage.objects has RLS enabled with ZERO
//                             policies, so anon and authenticated can neither read nor
//                             write an object. Only a service-role client can, which is
//                             exactly the server-mediated posture this MVP wants.
//   finalize / record failure — the SERVICE-ROLE client, because those two RPCs are
//                             granted to service_role ONLY. Reachable by a browser
//                             role, finalize would let any caller mark a submission
//                             complete without uploading anything.
//
// WHAT NEVER LEAVES THIS MODULE. The object path, the bucket name and the file hash are
// consumed here and appear in no value returned to the caller — the flow's result union
// carries a status and nothing else. The file bytes are held only long enough to hash
// and upload them; they are never written to PostgreSQL.
import { createClient } from "@/lib/supabase/server";
import {
  createAdminClient,
  SupabaseAdminConfigurationError,
} from "@/lib/supabase/admin";
import {
  runReceiptSubmissionFlow,
  type ReceiptReserveResult,
  type ReceiptSubmissionPorts,
  type ReceiptSubmissionResult,
  type ReceiptReserveInput,
} from "@/lib/receipts/receipt-submission-flow";

const RESERVE_RPC = "reserve_receipt_submission" as const;
const FINALIZE_RPC = "finalize_receipt_submission_upload" as const;
const RECORD_FAILURE_RPC = "record_receipt_submission_upload_failure" as const;

/** SQLSTATEs the receipt RPCs raise. Only the CODE is inspected, never a message. */
const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/** Sanitized operator logging. No ids, paths, hashes, buckets, or error objects. */
function logSubmissionFailure(category: string): void {
  console.error(`[receipts-submit] ${category}`);
}

/** One row of reserve_receipt_submission(). */
type ReservationRow = {
  submission_id?: unknown;
  storage_bucket?: unknown;
  storage_object_path?: unknown;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Submits one receipt.
 *
 * @param input the shop id the staff member chose plus the file facts already derived
 *   and validated server-side by @/lib/receipts/receipt-file — including the MIME type
 *   sniffed from the bytes rather than the browser's declared value.
 * @param bytes the file's contents. Uploaded and then discarded; never persisted to
 *   PostgreSQL.
 */
export async function submitReceipt(
  input: ReceiptReserveInput,
  bytes: Uint8Array,
): Promise<ReceiptSubmissionResult> {
  // The service-role client is built FIRST so a missing key fails before anything is
  // reserved. A configuration gap is reported as `unavailable`, never as a throw.
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    if (error instanceof SupabaseAdminConfigurationError) {
      logSubmissionFailure("configuration is incomplete");
      return { status: "unavailable" };
    }
    logSubmissionFailure("setup failed");
    return { status: "unavailable" };
  }

  const supabase = await createClient();

  const ports: ReceiptSubmissionPorts = {
    async reserve(reserveInput): Promise<ReceiptReserveResult> {
      const result = await Promise.resolve(
        supabase.rpc(RESERVE_RPC, {
          p_shop_id: reserveInput.shopId,
          p_original_file_name: reserveInput.fileName,
          p_mime_type: reserveInput.mimeType,
          p_file_size_bytes: reserveInput.sizeBytes,
          p_file_sha256: reserveInput.sha256,
        }),
      ).catch(() => null);

      if (result === null) {
        logSubmissionFailure("reserve transport");
        return { status: "unavailable" };
      }

      if (result.error) {
        // Only the SQLSTATE is read. The message is never bound, returned, or logged.
        const code = (result.error as { code?: string }).code;
        if (code === UNIQUE_VIOLATION) return { status: "duplicate" };
        if (code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
        if (code === CHECK_VIOLATION) return { status: "invalid" };
        logSubmissionFailure("reserve rpc-error");
        return { status: "unavailable" };
      }

      const rows = result.data as unknown;
      const row: ReservationRow | undefined = Array.isArray(rows) ? rows[0] : undefined;
      const submissionId = nonEmptyString(row?.submission_id);
      const bucket = nonEmptyString(row?.storage_bucket);
      const objectPath = nonEmptyString(row?.storage_object_path);

      if (!row || submissionId === null || bucket === null || objectPath === null) {
        logSubmissionFailure("reserve returned an unusable result");
        return { status: "unavailable" };
      }

      return { status: "ok", submissionId, bucket, objectPath };
    },

    async upload({ bucket, objectPath }) {
      // `upsert: false` so a collision is an error rather than a silent overwrite: the
      // path contains a fresh random component, so a collision would mean a defect.
      // `contentType` is the SNIFFED type — the browser's declared value is never used.
      const result = await Promise.resolve(
        admin.storage.from(bucket).upload(objectPath, bytes, {
          contentType: input.mimeType,
          upsert: false,
        }),
      ).catch(() => null);

      if (result === null) {
        logSubmissionFailure("upload transport");
        return { status: "failed" };
      }
      if (result.error) {
        // A Storage error can name the bucket, the key, the account and a request id.
        // It is not bound, returned, or logged.
        logSubmissionFailure("upload rejected");
        return { status: "failed" };
      }
      return { status: "ok" };
    },

    async finalize({ submissionId, sha256, objectPath, mimeType, sizeBytes }) {
      const result = await Promise.resolve(
        admin.rpc(FINALIZE_RPC, {
          p_submission_id: submissionId,
          p_expected_file_sha256: sha256,
          p_storage_object_path: objectPath,
          p_mime_type: mimeType,
          p_file_size_bytes: sizeBytes,
        }),
      ).catch(() => null);

      if (result === null || result.error) {
        logSubmissionFailure("finalize failed");
        return { status: "failed" };
      }
      return { status: "ok" };
    },

    async removeObject({ bucket, objectPath }) {
      // Best effort. A failure here leaves an orphaned object, which is undesirable but
      // harmless — the bucket is private and nothing references it. It must never
      // change the outcome the submitter is told.
      const result = await Promise.resolve(
        admin.storage.from(bucket).remove([objectPath]),
      ).catch(() => null);
      if (result === null || result.error) {
        logSubmissionFailure("could not remove the orphaned object");
      }
    },

    async recordFailure({ submissionId, sha256 }) {
      // Best effort, and it accepts no provider text — the classification is a fixed
      // literal chosen inside the RPC.
      const result = await Promise.resolve(
        admin.rpc(RECORD_FAILURE_RPC, {
          p_submission_id: submissionId,
          p_expected_file_sha256: sha256,
        }),
      ).catch(() => null);
      if (result === null || result.error) {
        logSubmissionFailure("could not record the upload failure");
      }
    },
  };

  return runReceiptSubmissionFlow(input, ports);
}
