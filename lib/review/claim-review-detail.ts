import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * One receipt, for the Claim Reviewer detail page — the read side of Phase 1C-C.
 *
 * SERVER-ONLY, matching @/lib/review/claim-review-queue. A client-side import is a
 * build error rather than a runtime surprise.
 *
 * ============================================================================
 * ONE RPC, AND NOTHING ELSE
 * ============================================================================
 *   public.get_claim_review_detail(p_submission_id uuid)
 *
 * It takes the receipt id and NOTHING ELSE — no Vendor, no reviewer, no
 * membership. The Vendor is resolved in SQL from auth.uid() through the Phase 1B
 * resolver, so there is no tenant identifier for this module to hold or for a URL
 * to supply. That is the whole boundary and it is not restated in TypeScript,
 * because a second copy could drift from the first.
 *
 * The ordinary authenticated server client is used. This module MUST NOT use the
 * service-role client: the only approved service-role path in Phase 1C-C is the
 * image byte stream, and it runs only after this function has already authorized
 * the reviewer. Metadata obtained with service role would bypass the tenant check
 * entirely.
 *
 * ============================================================================
 * NOT-FOUND, FOREIGN AND UNAUTHORIZED ARE ONE ANSWER
 * ============================================================================
 * The RPC returns zero rows for a receipt that does not exist, one belonging to
 * another Vendor, one whose Retailer link is no longer ACTIVE, and one requested
 * by somebody who is not a reviewer at all. This module cannot distinguish them
 * and deliberately does not try: they collapse into a single `not-found`, so the
 * page cannot be used to discover which receipt ids are real.
 *
 * ============================================================================
 * DECIDED RECEIPTS STILL RESOLVE
 * ============================================================================
 * A decision lives in its own table, so a decided receipt keeps
 * `status = 'SUBMITTED'` and this RPC keeps returning it — with the decision
 * columns populated. That is what makes the read-only decided view possible, and
 * it is why the page must branch on `decision`, never on whether a row came back.
 */

/** One browser-safe receipt detail. Every field here is displayed. */
export type ClaimReviewDetail = {
  /** The only identifier that crosses. It is already in the URL. */
  receiptSubmissionId: string;
  retailerName: string;
  shopName: string;
  shopCode: string | null;
  /** The shop's state TODAY. Context, not a filter — see D7. */
  shopStatus: string;
  submitterName: string;
  submitterStatus: string;
  /** ISO 8601 UTC, straight from the database. */
  submittedAt: string;
  mimeType: string;
  fileSizeBytes: number;
  originalFileName: string;
  /** True when the same bytes appear more than once. A flag, never a hash. */
  hasDuplicateHash: boolean;
  /** 'NONE' today — extraction is DISABLED and no run exists. */
  extractionStatus: string;
  hasRetailerConfirmation: boolean;

  /** null while pending. Non-null makes this receipt read-only and final. */
  decision: string | null;
  rejectionReason: string | null;
  reviewerNote: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
};

export type ClaimReviewDetailResult =
  | { status: "authorized"; detail: ClaimReviewDetail }
  /** Does not exist, another Vendor's, or this caller may not read it. */
  | { status: "not-found" }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

/**
 * One row of `get_claim_review_detail`, declared explicitly.
 *
 * An untyped rpc() call yields `any` and would silently accept a shape change.
 * These nineteen columns are the function's entire output — no bucket, no object
 * path, no file hash, no id but the receipt's own.
 */
type DetailRpcRow = {
  receipt_submission_id: string;
  retailer_name: string | null;
  shop_name: string | null;
  shop_code: string | null;
  shop_status: string | null;
  submitter_name: string | null;
  submitter_status: string | null;
  submitted_at: string;
  mime_type: string | null;
  file_size_bytes: number | string | null;
  original_file_name: string | null;
  has_duplicate_hash: boolean | null;
  extraction_status: string | null;
  has_retailer_confirmation: boolean | null;
  decision: string | null;
  rejection_reason: string | null;
  reviewer_note: string | null;
  decided_at: string | null;
  decided_by_name: string | null;
};

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** `bigint` arrives as a string above 2^53. Anything unusable becomes 0, not NaN. */
function byteCount(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Maps one RPC row, field by field.
 *
 * Deliberately NOT a spread. A column added to the function in a later milestone
 * must be admitted here consciously before it can reach a page — which is the
 * only reason a future `storage_object_path` could not arrive by accident.
 *
 * Returns null for a row with no usable id or timestamp: such a row cannot be
 * rendered honestly, and a page built on it would show blanks where facts belong.
 */
function toDetail(row: DetailRpcRow): ClaimReviewDetail | null {
  const id = optionalText(row.receipt_submission_id);
  const submittedAt = optionalText(row.submitted_at);
  if (id === null || submittedAt === null) return null;

  // A decision is only real when the database gave BOTH the verdict and its
  // timestamp. Treating a half-populated decision as final would lock a receipt
  // out of review on the strength of a malformed row.
  const decision = optionalText(row.decision);
  const decidedAt = optionalText(row.decided_at);
  const decided = decision !== null && decidedAt !== null;

  return {
    receiptSubmissionId: id,
    retailerName: text(row.retailer_name, "Unknown retailer"),
    shopName: text(row.shop_name, "Unknown shop"),
    shopCode: optionalText(row.shop_code),
    shopStatus: text(row.shop_status, "UNKNOWN"),
    submitterName: text(row.submitter_name, "Unknown staff member"),
    submitterStatus: text(row.submitter_status, "UNKNOWN"),
    submittedAt,
    mimeType: text(row.mime_type, "unknown"),
    fileSizeBytes: byteCount(row.file_size_bytes),
    originalFileName: text(row.original_file_name, "receipt"),
    hasDuplicateHash: row.has_duplicate_hash === true,
    extractionStatus: text(row.extraction_status, "NONE"),
    hasRetailerConfirmation: row.has_retailer_confirmation === true,
    decision: decided ? decision : null,
    rejectionReason: decided ? optionalText(row.rejection_reason) : null,
    reviewerNote: decided ? optionalText(row.reviewer_note) : null,
    decidedAt: decided ? decidedAt : null,
    decidedByName: decided ? optionalText(row.decided_by_name) : null,
  };
}

async function resolveClaimReviewDetail(
  receiptSubmissionId: string,
): Promise<ClaimReviewDetailResult> {
  const supabase = await createClient();

  // 1. Identity, verified with the Auth server rather than trusted from a cookie.
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims?.sub) {
      return { status: "unauthenticated" };
    }
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can
    // carry token material.
    return { status: "unauthenticated" };
  }

  // 2. The single read. The id is the only argument.
  const result = await Promise.resolve(
    supabase.rpc("get_claim_review_detail", {
      p_submission_id: receiptSubmissionId,
    }),
  ).catch(() => null);

  // A PostgREST error names schemas, tables, columns and functions, so the error
  // object is never bound, inspected or logged. Note the RPC does not raise for
  // an unauthorized caller — it returns zero rows — so a reported error genuinely
  // means the call did not complete.
  if (result === null || result.error) {
    console.error("claim-review-detail: detail read failed");
    return { status: "unavailable" };
  }

  const rows = (result.data ?? []) as DetailRpcRow[];
  if (rows.length === 0) {
    // Missing, foreign, ineligible and unauthorized all arrive here identically.
    return { status: "not-found" };
  }

  const detail = toDetail(rows[0]);
  if (detail === null) {
    console.error("claim-review-detail: detail row was unusable");
    return { status: "unavailable" };
  }

  return { status: "authorized", detail };
}

/**
 * The detail for one receipt, for the current reviewer.
 *
 * React `cache` is REQUEST-SCOPED memoization for a single Server Component
 * render — so the page and the image route within one request pay for one round
 * trip. It is NOT a persistent cache and must never become one: this is
 * per-user, per-tenant data and a shared cache would be a cross-tenant leak.
 */
export const getClaimReviewDetail = cache(resolveClaimReviewDetail);
