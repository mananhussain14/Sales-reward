import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { NormalizedProductDecision } from "@/lib/review/claim-product-decision-input";
import { isProductDecisionOutcome } from "@/lib/review/claim-product-decision-settlement";

/**
 * Recording the one immutable product decision — the write side of the Phase 1D-B
 * reviewer flow.
 *
 * SERVER-ONLY. One RPC and nothing else:
 *
 *   public.finalize_claim_receipt_sale_items(
 *     p_submission_id, p_decision, p_rejection_reason, p_reviewer_note)
 *
 * ============================================================================
 * FOUR ARGUMENTS, AND NOT ONE MORE
 * ============================================================================
 * No product, quantity, line number, product snapshot, barcode, brand, sale,
 * confirmation, decision, proposal-line, Vendor, Retailer, shop, staff, reviewer,
 * membership, campaign, reward, audit action or idempotency key — and this module
 * could not supply one if it wanted to. The function copies every authoritative
 * item from the immutable Sales Staff proposal, derives the Vendor from the Phase
 * 1B resolver and the actor from auth.uid(), re-checks the VERIFIED decision, the
 * sale header and the qualification exclusion under a row lock, and writes its own
 * audit event in the same transaction.
 *
 * ============================================================================
 * WHY THE SQLSTATE IS THE ONLY THING READ FROM AN ERROR
 * ============================================================================
 * PostgREST reports a raised exception as an error, and its message, details and
 * hint name schemas, tables and functions. Only `code` is touched. The database
 * deliberately raises the SAME 42501 for "not a reviewer", "not yours", "not
 * VERIFIED", "excluded", "no sale header", "no proposal" and "does not exist", so
 * this module cannot rebuild the oracle the RPC is careful not to be — every one
 * of those becomes a single `refused`.
 */

export type ProductDecisionWriteResult =
  | {
      status: "ok";
      outcome:
        | "ACCEPTED"
        | "REJECTED"
        | "ALREADY_ACCEPTED"
        | "ALREADY_REJECTED"
        | "CONFLICT";
      /** Lines promoted to authoritative items. Zero for a rejection. */
      lineCount: number | null;
      /** True only when THIS call created the decision. */
      changed: boolean;
    }
  | { status: "unauthenticated" }
  /** Not a reviewer, not eligible, excluded, or not there. Deliberately merged. */
  | { status: "refused" }
  /** The decision, reason or note was refused by the database's own rules. */
  | { status: "invalid-input" }
  /** The call did not complete. Whether it committed is UNKNOWN. */
  | { status: "unavailable" };

type ProductDecisionRpcRow = {
  outcome: string | null;
  line_count: number | string | null;
  changed: boolean | null;
};

function optionalInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

/** Only the SQLSTATE is read. Message, details and hint are never touched. */
function sqlstateOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export async function finalizeClaimReceiptSaleItems(
  receiptSubmissionId: string,
  input: NormalizedProductDecision,
): Promise<ProductDecisionWriteResult> {
  const supabase = await createClient();

  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims?.sub) {
      return { status: "unauthenticated" };
    }
  } catch {
    return { status: "unauthenticated" };
  }

  const result = await Promise.resolve(
    supabase.rpc("finalize_claim_receipt_sale_items", {
      p_submission_id: receiptSubmissionId,
      p_decision: input.decision,
      p_rejection_reason: input.rejectionReason,
      p_reviewer_note: input.reviewerNote,
    }),
  ).catch(() => null);

  if (result === null) {
    console.error("finalize-sale-items: write did not complete");
    return { status: "unavailable" };
  }

  if (result.error) {
    switch (sqlstateOf(result.error)) {
      case "42501":
        // Authorization OR eligibility. Merged on purpose.
        console.error("finalize-sale-items: refused by the database");
        return { status: "refused" };
      case "22023":
        console.error("finalize-sale-items: decision inputs rejected");
        return { status: "invalid-input" };
      default:
        console.error("finalize-sale-items: write failed");
        return { status: "unavailable" };
    }
  }

  const rows = (result.data ?? []) as ProductDecisionRpcRow[];
  const row = rows.length > 0 ? rows[0] : null;

  // A successful call that returned no recognizable outcome is unavailable, NOT
  // success. Reporting a permanent product decision on an unreadable answer would
  // be the worst lie this module could tell.
  if (row === null || !isProductDecisionOutcome(row.outcome)) {
    console.error("finalize-sale-items: outcome was unreadable");
    return { status: "unavailable" };
  }

  return {
    status: "ok",
    outcome: row.outcome,
    lineCount: optionalInteger(row.line_count),
    changed: row.changed === true,
  };
}
