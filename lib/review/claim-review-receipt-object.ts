import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Reading the private receipt image bytes — the ONLY service-role path in Phase 1C-C.
 *
 * ============================================================================
 * READ THIS BEFORE IMPORTING
 * ============================================================================
 * This module bypasses Row Level Security. It performs NO authorization of its
 * own and must never be called until the caller has ALREADY been authorized for
 * this exact receipt by `getClaimReviewDetail`, which runs as the ordinary
 * signed-in reviewer and therefore goes through the Vendor resolver and the
 * tenant check.
 *
 * That ordering is the entire security model here, and it is load-bearing for a
 * specific reason: `public.get_claim_review_object_reference` has NO reviewer
 * check inside it at all. Its whole body is
 *
 *     select storage_bucket, storage_object_path, mime_type, file_size_bytes
 *     from public.receipt_submissions where id = $1 and status = 'SUBMITTED'
 *
 * so it would hand back the private path for ANY submitted receipt in ANY Vendor
 * to anyone who could execute it. It is safe only because it is granted to
 * `service_role` alone and because this module is only reached after the
 * authenticated check has already passed. Calling it first, or calling it on an
 * id the reviewer has not been cleared for, is a cross-tenant disclosure.
 *
 * The single caller is app/(review)/review/[receiptSubmissionId]/image/route.ts.
 * A contract test pins that, and pins that no other Phase 1C-C file imports a
 * service-role client.
 *
 * ============================================================================
 * WHY NOT A SIGNED URL
 * ============================================================================
 * A signed URL is a bearer token in a link. It works for anyone who has it, from
 * any browser, until it expires — so it survives sign-out, revocation, a copied
 * address bar and a shared screenshot, and it is invisible to every check this
 * application makes. Streaming through a route means every single byte is served
 * behind a fresh reviewer authorization, and revoking a reviewer takes effect on
 * the next request rather than at some future expiry.
 *
 * That is also why the bucket stays private with zero storage policies, and why
 * nothing here returns, logs or renders the bucket, the object path or the key.
 */

/** Exactly what the upload flow accepts, and therefore all a receipt can be. */
export const RECEIPT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type ReceiptImageMimeType = (typeof RECEIPT_IMAGE_MIME_TYPES)[number];

export function isReceiptImageMimeType(v: unknown): v is ReceiptImageMimeType {
  return (
    typeof v === "string" &&
    (RECEIPT_IMAGE_MIME_TYPES as readonly string[]).includes(v)
  );
}

/**
 * The upper bound on what this route will buffer, mirroring the upload limit
 * enforced on `receipt_submissions.file_size_bytes`. A stored object larger than
 * this cannot have come through the upload flow, so refusing it costs a real
 * reviewer nothing and prevents an unbounded read.
 */
export const RECEIPT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export type ReceiptImageBytes = {
  bytes: ArrayBuffer;
  /** Server-authoritative, from the database — never from the browser. */
  contentType: ReceiptImageMimeType;
};

export type ReceiptImageResult =
  | { status: "ok"; image: ReceiptImageBytes }
  /** No object reference, or the stored bytes are gone. */
  | { status: "missing" }
  /** Stored MIME is not one this application ever accepts. */
  | { status: "unsupported" }
  | { status: "unavailable" };

type ObjectRefRow = {
  storage_bucket: string | null;
  storage_object_path: string | null;
  mime_type: string | null;
  file_size_bytes: number | string | null;
};

function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Fetches the private image bytes for a receipt the caller is ALREADY authorized
 * to read.
 *
 * @param receiptSubmissionId a validated id the caller has already cleared
 *        through `getClaimReviewDetail`. Passing an unauthorized id here is a
 *        cross-tenant disclosure — see the module header.
 */
export async function readClaimReviewReceiptImage(
  receiptSubmissionId: string,
): Promise<ReceiptImageResult> {
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    // SupabaseAdminConfigurationError names the env VARIABLE, never its value —
    // but it is still not bound or logged here, and never reaches a response.
    console.error("claim-review-image: service-role client unavailable");
    return { status: "unavailable" };
  }

  const refResult = await Promise.resolve(
    admin.rpc("get_claim_review_object_reference", {
      p_submission_id: receiptSubmissionId,
    }),
  ).catch(() => null);

  if (refResult === null || refResult.error) {
    console.error("claim-review-image: object reference read failed");
    return { status: "unavailable" };
  }

  const rows = (refResult.data ?? []) as ObjectRefRow[];
  if (rows.length === 0) return { status: "missing" };

  const bucket = nonEmpty(rows[0].storage_bucket);
  const path = nonEmpty(rows[0].storage_object_path);
  const mimeType = rows[0].mime_type;

  if (bucket === null || path === null) return { status: "missing" };

  // Checked BEFORE the download, so an object with a MIME this application never
  // accepts is never even read. The stored value is the only one consulted; the
  // browser cannot propose a type.
  if (!isReceiptImageMimeType(mimeType)) {
    console.error("claim-review-image: stored mime type is not permitted");
    return { status: "unsupported" };
  }

  const declaredSize =
    typeof rows[0].file_size_bytes === "number"
      ? rows[0].file_size_bytes
      : Number.parseInt(String(rows[0].file_size_bytes ?? ""), 10);
  if (Number.isFinite(declaredSize) && declaredSize > RECEIPT_IMAGE_MAX_BYTES) {
    console.error("claim-review-image: stored object exceeds the upload limit");
    return { status: "unsupported" };
  }

  const download = await Promise.resolve(
    admin.storage.from(bucket).download(path),
  ).catch(() => null);

  // The storage error is never bound or returned: it carries the bucket and the
  // object path, which are exactly the two things that must not leave the server.
  if (download === null || download.error || !download.data) {
    console.error("claim-review-image: object download failed");
    return { status: "missing" };
  }

  const blob = download.data;
  if (blob.size > RECEIPT_IMAGE_MAX_BYTES) {
    console.error("claim-review-image: downloaded object exceeds the limit");
    return { status: "unsupported" };
  }

  const bytes = await blob.arrayBuffer();

  return {
    status: "ok",
    // The DATABASE's MIME type, not the blob's. A stored object whose bytes were
    // swapped cannot talk this route into serving it as something else.
    image: { bytes, contentType: mimeType },
  };
}
