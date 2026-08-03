"use server";

import { finalizeClaimReceiptSaleHeader } from "@/lib/review/finalize-claim-receipt-sale-header";
import { validateSaleFinalizationInput } from "@/lib/review/claim-sale-finalization-input";
import { isReceiptSubmissionId } from "@/lib/review/claim-review-queue-filters";
import {
  settleSaleFinalizationOutcome,
  INVALID_CHOICE_MESSAGE,
  MALFORMED_REQUEST_MESSAGE,
  NONEXISTENT_TIME_MESSAGE,
  NO_TIMEZONE_MESSAGE,
  REFUSED_MESSAGE,
  UNCERTAIN_RESULT_MESSAGE,
} from "@/lib/review/claim-sale-finalization-settlement";
import {
  type SaleFinalizationActionState,
  INITIAL_SALE_FINALIZATION_ACTION_STATE,
} from "@/app/(review)/review/[receiptSubmissionId]/sale-finalization-action-state";

/**
 * The Server Action behind "Finalize sale header".
 *
 * ============================================================================
 * WHAT IT READS, AND WHAT IT REFUSES TO
 * ============================================================================
 * Exactly two fields: receiptSubmissionId and dstAmbiguityChoice.
 *
 * NO transaction date, time, currency, total, subtotal, tax, merchant or
 * document number. NO timezone. NO resolved sale instant. NO Vendor, Retailer,
 * shop, reviewer, membership, confirmation or decision id. NO return URL. None
 * would be usable if a crafted request supplied them, because
 * `finalize_claim_receipt_sale_header` has no parameter for any of it — the
 * database copies every figure from the immutable Sales Staff proposal.
 *
 * ============================================================================
 * IT REVALIDATES NOTHING
 * ============================================================================
 * Next.js completes "the mutation, the cache invalidation, and the page
 * re-render all ... in a single roundtrip", so revalidating this route here would
 * hold the reply behind a re-render of the very page the reviewer is on — the
 * failure that left a committed qualification event showing "Recording…". This
 * action returns its outcome and nothing else; the panel renders it and then
 * re-reads the route itself. See docs/server-action-authoritative-settlement.md.
 *
 * ============================================================================
 * NOTHING RAW IS LOGGED
 * ============================================================================
 * Nothing here logs a transaction value, a merchant, a receipt id or any provider
 * error — only fixed strings.
 */

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function finalizeSaleHeaderAction(
  prevState: SaleFinalizationActionState,
  formData: FormData,
): Promise<SaleFinalizationActionState> {
  // Already settled: a double click, a reload, an impatient second press. Return
  // the previous state rather than calling the RPC again. The RPC is idempotent
  // regardless — this removes the accident as well as the consequence.
  //
  // Note this does NOT short-circuit an ambiguity prompt, which is unsettled on
  // purpose so the reviewer can answer it.
  if (prevState.settled) {
    return prevState;
  }

  const receiptSubmissionId = field(formData, "receiptSubmissionId").trim();
  const base: SaleFinalizationActionState = {
    ...INITIAL_SALE_FINALIZATION_ACTION_STATE,
  };

  // A malformed id never reaches an RPC. Reported as a generic problem rather
  // than "no such receipt", because the form is only ever rendered with an id the
  // server itself put there — a bad one means something is wrong, not missing.
  if (!isReceiptSubmissionId(receiptSubmissionId)) {
    return { ...base, formError: MALFORMED_REQUEST_MESSAGE };
  }

  const validated = validateSaleFinalizationInput({
    dstAmbiguityChoice: field(formData, "dstAmbiguityChoice"),
  });

  if (!validated.ok) {
    return { ...base, fieldErrors: validated.fieldErrors };
  }

  const result = await finalizeClaimReceiptSaleHeader(
    receiptSubmissionId,
    validated.value,
  );

  if (result.status === "unauthenticated" || result.status === "refused") {
    // The database answered, and the answer was no. Not uncertain.
    return { ...base, formError: REFUSED_MESSAGE };
  }

  if (result.status === "nonexistent-time") {
    return { ...base, formError: NONEXISTENT_TIME_MESSAGE };
  }

  if (result.status === "no-timezone") {
    return { ...base, formError: NO_TIMEZONE_MESSAGE };
  }

  if (result.status === "invalid-choice") {
    // The selection was rejected — unnecessary, unrecognised or stale. Not
    // settled, so the reviewer can refresh and act on the current state.
    return {
      ...base,
      formError: INVALID_CHOICE_MESSAGE,
      needsDstChoice: true,
    };
  }

  if (result.status === "unavailable") {
    // NOT settled and NOT a claim of failure. The call did not complete, so the
    // sale may or may not have been created — only the database knows.
    return { ...base, formError: UNCERTAIN_RESULT_MESSAGE, uncertain: true };
  }

  // The database has spoken. Return immediately: the panel renders this outcome
  // and then refreshes the route itself, so the reply is never held behind a
  // re-render of the page the reviewer is already looking at.
  const settlement = settleSaleFinalizationOutcome(result.outcome);
  return {
    ...base,
    outcome: settlement.outcome,
    message: settlement.message,
    settled: settlement.settled,
    needsDstChoice: result.outcome === "AMBIGUOUS_TIME_REQUIRES_CHOICE",
  };
}
