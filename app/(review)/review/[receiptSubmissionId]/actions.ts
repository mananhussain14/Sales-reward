"use server";

import { revalidatePath } from "next/cache";
import { submitClaimReviewDecision } from "@/lib/review/claim-review-decision";
import { validateDecisionInput } from "@/lib/review/claim-review-decision-input";
import { isReceiptSubmissionId } from "@/lib/review/claim-review-queue-filters";
import {
  type DecisionActionState,
  INITIAL_DECISION_ACTION_STATE,
} from "@/app/(review)/review/[receiptSubmissionId]/decision-action-state";

/**
 * The Server Action behind Verify and Reject.
 *
 * ============================================================================
 * WHAT IT READS FROM THE FORM, AND WHAT IT REFUSES TO
 * ============================================================================
 * Exactly four fields: receiptSubmissionId, decision, rejectionReason,
 * reviewerNote.
 *
 * It reads NO Vendor, reviewer, member, role or actor id, NO decided-at
 * timestamp, NO audit action, NO idempotency key and NO return URL — and could
 * not use them if a crafted request supplied them, because `decide_claim_receipt`
 * has no parameters for any of it. The Vendor comes from the Phase 1B resolver,
 * the actor from auth.uid(), the timestamp from the database, and the single
 * audit row is written inside the same transaction as the decision.
 *
 * The receipt id is an ADDRESS the server re-validates, not a capability: the
 * RPC re-derives the Vendor and re-checks the ACTIVE tenant link before writing.
 *
 * ============================================================================
 * VALIDATION IS A COURTESY, NOT THE GATE
 * ============================================================================
 * `validateDecisionInput` reproduces the RPC's own rules so a reviewer gets a
 * field-level message. It cannot widen anything: a value it lets through still
 * has to survive the database, and the database's refusal is what actually
 * protects the row.
 *
 * ============================================================================
 * NO RAW FORM VALUES ARE LOGGED
 * ============================================================================
 * A reviewer note is free text about a real receipt. Nothing here logs the note,
 * the reason, the id or any provider error object — only fixed strings.
 */

const GENERIC_ERROR =
  "Something went wrong on our side and the decision was not recorded. Please try again.";
const REFUSED_ERROR =
  "This receipt is no longer available for you to review. Return to the queue and reload.";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function decideReceiptAction(
  prevState: DecisionActionState,
  formData: FormData,
): Promise<DecisionActionState> {
  // Already settled: a double submit, a reload, an impatient second press. Return
  // the previous state untouched rather than calling the RPC again. The RPC is
  // idempotent regardless — this removes the accident as well as the consequence.
  if (prevState.settled) {
    return prevState;
  }

  const receiptSubmissionId = field(formData, "receiptSubmissionId").trim();
  const rawNote = field(formData, "reviewerNote");

  const base: DecisionActionState = { ...INITIAL_DECISION_ACTION_STATE };

  // A malformed id never reaches an RPC. Reported as the generic error rather
  // than "no such receipt", because the form is only ever rendered with an id the
  // server itself put there — a bad one means something is wrong, not missing.
  if (!isReceiptSubmissionId(receiptSubmissionId)) {
    return { ...base, formError: GENERIC_ERROR };
  }

  const validated = validateDecisionInput({
    decision: field(formData, "decision"),
    rejectionReason: field(formData, "rejectionReason"),
    reviewerNote: rawNote,
  });

  if (!validated.ok) {
    return { ...base, fieldErrors: validated.fieldErrors };
  }

  const result = await submitClaimReviewDecision(
    receiptSubmissionId,
    validated.value,
  );

  if (result.status === "unauthenticated" || result.status === "refused") {
    return { ...base, formError: REFUSED_ERROR };
  }

  if (result.status === "unavailable") {
    // NOT settled. The decision may not have been recorded, so the reviewer must
    // be able to try again — and must not be told it worked.
    return { ...base, formError: GENERIC_ERROR };
  }

  // From here the database has spoken, so the receipt has a final decision by one
  // of three routes and the form must stop offering to submit.
  const detailPath = `/review/${receiptSubmissionId}`;
  revalidatePath("/review");
  revalidatePath(detailPath);

  if (result.outcome === "DECIDED") {
    return {
      ...base,
      outcome: "DECIDED",
      settled: true,
      message:
        validated.value.decision === "VERIFIED"
          ? "Receipt verified. This decision is final and cannot be changed."
          : "Receipt rejected. This decision is final and cannot be changed.",
    };
  }

  if (result.outcome === "ALREADY_DECIDED") {
    // An idempotent retry — the same reviewer, the same decision, already
    // recorded. A success message would overstate it and an error would be a
    // false failure, so it is reported as exactly what it is.
    return {
      ...base,
      outcome: "ALREADY_DECIDED",
      settled: true,
      message:
        "You had already recorded this decision. Nothing was changed and no second decision was created.",
    };
  }

  // CONFLICT — a decision already existed that this call did not make. Nothing
  // was overwritten and nothing is retried. The stored decision is authoritative
  // and the page re-reads it; the other reviewer's internal id is never exposed.
  return {
    ...base,
    outcome: "CONFLICT",
    settled: true,
    message:
      "This receipt was already decided by another reviewer. Your decision was not recorded and the existing one stands.",
  };
}
