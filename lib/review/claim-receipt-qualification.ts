import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * Whether a receipt may proceed toward a sale and a reward — Phase 1D-0.
 *
 * SERVER-ONLY, matching @/lib/review/claim-review-detail.
 *
 * ============================================================================
 * A DIFFERENT QUESTION FROM THE REVIEW DECISION
 * ============================================================================
 * `get_claim_review_detail` answers "was the IMAGE accepted or rejected?".
 * This answers "may this record proceed toward an authoritative sale, campaign
 * qualification and a reward?".
 *
 * They are deliberately separate reads, because they are separate facts with
 * separate lifetimes. A receipt can be VERIFIED forever and excluded tomorrow,
 * and the review decision must not move when that happens.
 *
 * ONE RPC: `get_claim_receipt_qualification(p_submission_id)`. It takes the
 * receipt id and nothing else; the Vendor is resolved in SQL from auth.uid()
 * through the Phase 1B resolver. The ordinary authenticated client is used —
 * this module must never reach for service role, and the event table is revoked
 * from every browser role anyway.
 *
 * Missing, foreign, ineligible and unauthorized all return zero rows and become
 * the single `not-found`, exactly as the detail adapter does.
 */

/** What the reviewer may currently be told about a receipt's qualification. */
export type ClaimReceiptQualification = {
  receiptSubmissionId: string;
  /**
   * 'QUALIFICATION_NOT_EXCLUDED' or 'QUALIFICATION_EXCLUDED'.
   *
   * NOT_EXCLUDED is deliberately NOT "eligible". No sale exists, no reward
   * exists, and nothing has evaluated a campaign — it states the absence of one
   * specific block and nothing more.
   */
  qualificationState: string;
  /** Only when excluded: TEST_DATA, NON_QUALIFYING or DUPLICATE. */
  exclusionReason: string | null;
  reviewerNote: string | null;
  classifiedAt: string | null;
  classifiedByDisplayName: string | null;
  /** True only when there is an active exclusion to reverse. */
  canReinstate: boolean;
};

export type ClaimReceiptQualificationResult =
  | { status: "authorized"; qualification: ClaimReceiptQualification }
  /** Missing, foreign, or this caller may not read it — indistinguishable. */
  | { status: "not-found" }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

/**
 * One row of the RPC, declared explicitly.
 *
 * These seven columns are its entire output. There is no Vendor id, Retailer id,
 * shop id, profile id, event id, reversal id, bucket, path, hash, email or phone
 * to receive — the function does not return them, and this type could not carry
 * them if it wanted to.
 */
type QualificationRpcRow = {
  receipt_submission_id: string;
  qualification_state: string | null;
  exclusion_reason: string | null;
  reviewer_note: string | null;
  classified_at: string | null;
  classified_by_display_name: string | null;
  can_reinstate: boolean | null;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Maps one row, field by field. Deliberately NOT a spread: a column added to the
 * function later must be admitted here consciously before it can reach a page.
 */
function toQualification(
  row: QualificationRpcRow,
  fallbackId: string,
): ClaimReceiptQualification | null {
  const state = optionalText(row.qualification_state);
  if (state === null) return null;

  const excluded = state === "QUALIFICATION_EXCLUDED";

  return {
    receiptSubmissionId: optionalText(row.receipt_submission_id) ?? fallbackId,
    qualificationState: state,
    // Guarded on the state rather than copied blindly, so a malformed row cannot
    // render a reason beside a "not excluded" heading.
    exclusionReason: excluded ? optionalText(row.exclusion_reason) : null,
    reviewerNote: excluded ? optionalText(row.reviewer_note) : null,
    classifiedAt: excluded ? optionalText(row.classified_at) : null,
    classifiedByDisplayName: excluded
      ? optionalText(row.classified_by_display_name)
      : null,
    canReinstate: excluded && row.can_reinstate === true,
  };
}

async function resolveClaimReceiptQualification(
  receiptSubmissionId: string,
): Promise<ClaimReceiptQualificationResult> {
  const supabase = await createClient();

  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims?.sub) {
      return { status: "unauthenticated" };
    }
  } catch {
    // Not bound or logged: auth exceptions can carry token material.
    return { status: "unauthenticated" };
  }

  const result = await Promise.resolve(
    supabase.rpc("get_claim_receipt_qualification", {
      p_submission_id: receiptSubmissionId,
    }),
  ).catch(() => null);

  // The error object is never bound, inspected or logged — a PostgREST error
  // names schemas, tables, columns and functions.
  if (result === null || result.error) {
    console.error("claim-receipt-qualification: read failed");
    return { status: "unavailable" };
  }

  const rows = (result.data ?? []) as QualificationRpcRow[];
  if (rows.length === 0) {
    return { status: "not-found" };
  }

  const qualification = toQualification(rows[0], receiptSubmissionId);
  if (qualification === null) {
    console.error("claim-receipt-qualification: row was unusable");
    return { status: "unavailable" };
  }

  return { status: "authorized", qualification };
}

/**
 * Request-scoped React `cache` only — the page and any component beneath it pay
 * for one round trip. NOT a persistent cache and must never become one: this is
 * per-user, per-tenant data.
 */
export const getClaimReceiptQualification = cache(
  resolveClaimReceiptQualification,
);
