"use server";

import { finalizeClaimReceiptSaleItems } from "@/lib/review/finalize-claim-receipt-sale-items";
import { validateProductDecisionInput } from "@/lib/review/claim-product-decision-input";
import { isReceiptSubmissionId } from "@/lib/review/claim-review-queue-filters";
import {
  settleProductDecisionOutcome,
  INVALID_INPUT_MESSAGE,
  MALFORMED_REQUEST_MESSAGE,
  REFUSED_MESSAGE,
  UNCERTAIN_RESULT_MESSAGE,
} from "@/lib/review/claim-product-decision-settlement";
import {
  type ProductDecisionActionState,
  INITIAL_PRODUCT_DECISION_ACTION_STATE,
} from "@/app/(review)/review/[receiptSubmissionId]/product-decision-action-state";

/**
 * The Server Action behind "Accept complete product list" and "Reject complete
 * product list".
 *
 * ============================================================================
 * WHAT IT READS, AND WHAT IT REFUSES TO
 * ============================================================================
 * Exactly four fields: receiptSubmissionId, decision, rejectionReason and
 * reviewerNote.
 *
 * NO product id, quantity, line number, product name, code, barcode or brand. NO
 * sale id, confirmation id, proposal-line id or decision id. NO Vendor, Retailer,
 * shop, reviewer, actor or membership. NO campaign, reward or coin. NO Audit Log
 * action. NO return URL. None would be usable if a crafted request supplied them,
 * because `finalize_claim_receipt_sale_items` has no parameter for any of it — the
 * database copies every authoritative item from the immutable Sales Staff
 * proposal and derives every id itself.
 *
 * ============================================================================
 * IT REVALIDATES NOTHING
 * ============================================================================
 * Next.js completes the mutation, the cache invalidation and the page re-render
 * in a single roundtrip, so revalidating this route here would hold the reply
 * behind a re-render of the very page the reviewer is on. This action returns its
 * outcome and nothing else; the panel renders it and then re-reads the route
 * itself. See docs/server-action-authoritative-settlement.md.
 *
 * ============================================================================
 * NOTHING RAW IS LOGGED
 * ============================================================================
 * Nothing here logs a product, a note, a receipt id or any provider error.
 */

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function decideReceiptProductsAction(
  prevState: ProductDecisionActionState,
  formData: FormData,
): Promise<ProductDecisionActionState> {
  // Already settled: a double click, a reload, an impatient second press. Return
  // the previous state rather than calling the RPC again. The RPC is idempotent
  // regardless — this removes the accident as well as the consequence, and every
  // product outcome settles, so nothing legitimate is short-circuited.
  if (prevState.settled) {
    return prevState;
  }

  const receiptSubmissionId = field(formData, "receiptSubmissionId").trim();
  const base: ProductDecisionActionState = {
    ...INITIAL_PRODUCT_DECISION_ACTION_STATE,
  };

  // A malformed id never reaches an RPC. Reported as a generic problem rather
  // than "no such receipt", because the form is only ever rendered with an id the
  // server itself put there — a bad one means something is wrong, not missing.
  if (!isReceiptSubmissionId(receiptSubmissionId)) {
    return { ...base, formError: MALFORMED_REQUEST_MESSAGE };
  }

  const validated = validateProductDecisionInput({
    decision: field(formData, "decision"),
    rejectionReason: field(formData, "rejectionReason"),
    reviewerNote: field(formData, "reviewerNote"),
  });

  if (!validated.ok) {
    return { ...base, fieldErrors: validated.fieldErrors };
  }

  const result = await finalizeClaimReceiptSaleItems(
    receiptSubmissionId,
    validated.value,
  );

  if (result.status === "unauthenticated" || result.status === "refused") {
    // The database answered, and the answer was no. Not uncertain.
    return { ...base, formError: REFUSED_MESSAGE };
  }

  if (result.status === "invalid-input") {
    // The client validator and the database disagreed; the database wins. Nothing
    // was written, so this is not uncertain either.
    return { ...base, formError: INVALID_INPUT_MESSAGE };
  }

  if (result.status === "unavailable") {
    // NOT settled and NOT a claim of failure. The call did not complete, so the
    // decision may or may not have been recorded — only the database knows.
    return { ...base, formError: UNCERTAIN_RESULT_MESSAGE, uncertain: true };
  }

  // The database has spoken. Return immediately: the panel renders this outcome
  // and then refreshes the route itself, so the reply is never held behind a
  // re-render of the page the reviewer is already looking at.
  const settlement = settleProductDecisionOutcome(result.outcome);
  return {
    ...base,
    outcome: settlement.outcome,
    message: settlement.message,
    settled: settlement.settled,
  };
}
