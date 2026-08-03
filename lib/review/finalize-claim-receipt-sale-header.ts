import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { NormalizedSaleFinalization } from "@/lib/review/claim-sale-finalization-input";
import { isSaleFinalizationOutcome } from "@/lib/review/claim-sale-finalization-settlement";

/**
 * Creating one immutable authoritative sale header — the write side of the
 * Phase 1D-A reviewer flow.
 *
 * SERVER-ONLY. One RPC and nothing else:
 *
 *   public.finalize_claim_receipt_sale_header(p_submission_id, p_dst_ambiguity_choice)
 *
 * ============================================================================
 * TWO ARGUMENTS, AND NOT ONE MORE
 * ============================================================================
 * No amount, subtotal, tax, currency, merchant, document number, date, time,
 * timezone, resolved instant, Vendor, Retailer, shop, staff, reviewer,
 * membership, decision id, confirmation id, audit action or idempotency key —
 * and this module could not supply one if it wanted to. The function copies every
 * figure from the immutable Sales Staff proposal, derives the Vendor from the
 * Phase 1B resolver and the actor from auth.uid(), freezes the shop's zone under
 * a row lock, and writes its own audit event in the same transaction.
 *
 * ============================================================================
 * WHY THE SQLSTATE IS THE ONLY THING READ FROM AN ERROR
 * ============================================================================
 * PostgREST reports a raised exception as an error, and its message, details and
 * hint name schemas, tables and functions. Only `code` is touched. The database
 * deliberately raises the SAME 42501 for "not yours", "not eligible" and "does
 * not exist", so this module cannot rebuild the oracle the RPC is careful not to
 * be — every one of those becomes a single `refused`.
 */

export type SaleFinalizationWriteResult =
  | {
      status: "ok";
      outcome: "FINALIZED" | "ALREADY_FINALIZED" | "AMBIGUOUS_TIME_REQUIRES_CHOICE" | "CONFLICT";
      saleTimePrecision: string | null;
      saleAt: string | null;
      dstAmbiguityChoice: string | null;
      /** True only when THIS call created the sale. */
      changed: boolean;
    }
  | { status: "unauthenticated" }
  /** Not a reviewer, not eligible, excluded, or not there. Deliberately merged. */
  | { status: "refused" }
  /** The printed local time never existed in the shop's zone. */
  | { status: "nonexistent-time" }
  /** The shop has no IANA zone, so no instant can be resolved. */
  | { status: "no-timezone" }
  /** The choice was invalid, unnecessary, or no longer applies. */
  | { status: "invalid-choice" }
  /** The call did not complete. Whether it committed is UNKNOWN. */
  | { status: "unavailable" };

type FinalizationRpcRow = {
  outcome: string | null;
  sale_time_precision: string | null;
  sale_at: string | null;
  dst_ambiguity_choice: string | null;
  changed: boolean | null;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Only the SQLSTATE is read. Message, details and hint are never touched. */
function sqlstateOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export async function finalizeClaimReceiptSaleHeader(
  receiptSubmissionId: string,
  input: NormalizedSaleFinalization,
): Promise<SaleFinalizationWriteResult> {
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
    supabase.rpc("finalize_claim_receipt_sale_header", {
      p_submission_id: receiptSubmissionId,
      p_dst_ambiguity_choice: input.dstAmbiguityChoice,
    }),
  ).catch(() => null);

  if (result === null) {
    console.error("finalize-sale-header: write did not complete");
    return { status: "unavailable" };
  }

  if (result.error) {
    switch (sqlstateOf(result.error)) {
      case "42501":
        // Authorization OR eligibility. Merged on purpose.
        console.error("finalize-sale-header: refused by the database");
        return { status: "refused" };
      case "22007":
        console.error("finalize-sale-header: local time does not exist");
        return { status: "nonexistent-time" };
      case "22023":
        console.error("finalize-sale-header: daylight-saving choice rejected");
        return { status: "invalid-choice" };
      case "55000":
        console.error("finalize-sale-header: shop time zone unavailable");
        return { status: "no-timezone" };
      default:
        console.error("finalize-sale-header: write failed");
        return { status: "unavailable" };
    }
  }

  const rows = (result.data ?? []) as FinalizationRpcRow[];
  const row = rows.length > 0 ? rows[0] : null;

  // A successful call that returned no recognizable outcome is unavailable, NOT
  // success. Reporting an immutable financial write on an unreadable answer would
  // be the worst lie this module could tell.
  if (row === null || !isSaleFinalizationOutcome(row.outcome)) {
    console.error("finalize-sale-header: outcome was unreadable");
    return { status: "unavailable" };
  }

  return {
    status: "ok",
    outcome: row.outcome,
    saleTimePrecision: optionalText(row.sale_time_precision),
    saleAt: optionalText(row.sale_at),
    dstAmbiguityChoice: optionalText(row.dst_ambiguity_choice),
    changed: row.changed === true,
  };
}
