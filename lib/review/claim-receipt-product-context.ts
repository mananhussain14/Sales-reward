import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  parseClaimProductContext,
  type ClaimReceiptProductContext,
  type ProductContextRpcRow,
} from "@/lib/review/claim-product-context";

/**
 * What a Claim Reviewer may be told about a receipt's product proposal, and
 * whether it may yet be decided.
 *
 * SERVER-ONLY, matching @/lib/review/claim-receipt-sale-context.
 *
 * ONE RPC: `get_claim_receipt_product_context(p_submission_id)`. It takes the
 * receipt id and nothing else; the Vendor is resolved in SQL from auth.uid()
 * through the Phase 1B resolver. The ordinary authenticated client is used — this
 * module must never reach for service role, and `receipt_confirmation_products`,
 * `receipt_product_review_decisions` and `verified_sale_items` are revoked from
 * every browser role anyway.
 *
 * ============================================================================
 * THREE ANSWERS THAT LOOK ALIKE AND ARE NOT
 * ============================================================================
 * The function distinguishes them deliberately, and so does this module:
 *
 *   zero rows              — unreadable, foreign, missing, or not this reviewer's.
 *                            Becomes `not-found`, and the panel offers no control.
 *   one row, no proposal   — the Sales Staff member submitted no product list.
 *                            A real state with `hasProductProposal: false`.
 *   one row per line       — a proposal exists, and every line is returned.
 *
 * ============================================================================
 * AN UNREADABLE ROW IS NOT A DECIDABLE ONE
 * ============================================================================
 * Every vocabulary is validated in @/lib/review/claim-product-context, and
 * anything unrecognised comes back as null and fails CLOSED as `unavailable`
 * here. An unknown decision word must never fall through to "no decision yet",
 * because that state is the one that renders the accept and reject controls — a
 * parsing gap would become a second permanent decision attempt on a receipt that
 * already has one.
 */

export type {
  ClaimProductProposalLine,
  ClaimReceiptProductContext,
} from "@/lib/review/claim-product-context";

export type ClaimReceiptProductContextResult =
  | { status: "authorized"; context: ClaimReceiptProductContext }
  /** Missing, foreign, or this caller may not read it — indistinguishable. */
  | { status: "not-found" }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

async function resolveClaimReceiptProductContext(
  receiptSubmissionId: string,
): Promise<ClaimReceiptProductContextResult> {
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
    supabase.rpc("get_claim_receipt_product_context", {
      p_submission_id: receiptSubmissionId,
    }),
  ).catch(() => null);

  // The error object is never bound, inspected or logged — a PostgREST error
  // names schemas, tables, columns and functions.
  if (result === null || result.error) {
    console.error("claim-receipt-product-context: read failed");
    return { status: "unavailable" };
  }

  const rows = (result.data ?? []) as ProductContextRpcRow[];
  if (rows.length === 0) {
    return { status: "not-found" };
  }

  const context = parseClaimProductContext(rows, receiptSubmissionId);
  if (context === null) {
    console.error("claim-receipt-product-context: rows were unusable");
    return { status: "unavailable" };
  }

  return { status: "authorized", context };
}

/**
 * Request-scoped React `cache` only — the page and any component beneath it pay
 * for one round trip. NOT a persistent cache and must never become one: this is
 * per-user, per-tenant data.
 */
export const getClaimReceiptProductContext = cache(
  resolveClaimReceiptProductContext,
);
