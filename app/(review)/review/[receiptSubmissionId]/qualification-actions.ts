"use server";

import { revalidatePath } from "next/cache";
import { recordClaimReceiptQualification } from "@/lib/review/claim-receipt-qualification-write";
import { validateQualificationInput } from "@/lib/review/claim-receipt-qualification-input";
import { isReceiptSubmissionId } from "@/lib/review/claim-review-queue-filters";
import {
  type QualificationActionState,
  INITIAL_QUALIFICATION_ACTION_STATE,
} from "@/app/(review)/review/[receiptSubmissionId]/qualification-action-state";

/**
 * The Server Action behind Exclude and Reinstate.
 *
 * ============================================================================
 * WHAT IT READS, AND WHAT IT REFUSES TO
 * ============================================================================
 * Exactly four fields: receiptSubmissionId, action, exclusionReason,
 * reviewerNote.
 *
 * NO Vendor, reviewer, actor, member, role or organization id, NO event id, NO
 * timestamp, NO audit action, NO idempotency key, NO return URL — and none would
 * be usable if a crafted request supplied them, because
 * `record_claim_receipt_qualification` has no parameter for any of it.
 *
 * The event id to reverse is deliberately absent: the database resolves the
 * active exclusion under a row lock, so a stale page cannot reach past a newer
 * exclusion it never saw.
 *
 * ============================================================================
 * NOTHING RAW IS LOGGED
 * ============================================================================
 * A reviewer note is free text about a real receipt. Nothing here logs the note,
 * the reason, the id or any provider error — only fixed strings.
 */

const GENERIC_ERROR =
  "Something went wrong on our side and nothing was recorded. Please try again.";
const REFUSED_ERROR =
  "This receipt is no longer available for you to classify. Return to the queue and reload.";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function classifyReceiptQualificationAction(
  prevState: QualificationActionState,
  formData: FormData,
): Promise<QualificationActionState> {
  // Already settled: a double click, a reload, an impatient second press. Return
  // the previous state rather than calling the RPC again. The RPC is idempotent
  // regardless — this removes the accident as well as the consequence.
  if (prevState.settled) {
    return prevState;
  }

  const receiptSubmissionId = field(formData, "receiptSubmissionId").trim();
  const base: QualificationActionState = {
    ...INITIAL_QUALIFICATION_ACTION_STATE,
  };

  // A malformed id never reaches an RPC. Reported as the generic error rather
  // than "no such receipt", because the form is only ever rendered with an id the
  // server itself put there — a bad one means something is wrong, not missing.
  if (!isReceiptSubmissionId(receiptSubmissionId)) {
    return { ...base, formError: GENERIC_ERROR };
  }

  const validated = validateQualificationInput({
    action: field(formData, "action"),
    exclusionReason: field(formData, "exclusionReason"),
    reviewerNote: field(formData, "reviewerNote"),
  });

  if (!validated.ok) {
    return { ...base, fieldErrors: validated.fieldErrors };
  }

  const result = await recordClaimReceiptQualification(
    receiptSubmissionId,
    validated.value,
  );

  if (result.status === "unauthenticated" || result.status === "refused") {
    return { ...base, formError: REFUSED_ERROR };
  }

  if (result.status === "unavailable") {
    // NOT settled. Nothing may have been recorded, so the reviewer must be able
    // to try again — and must not be told it worked.
    return { ...base, formError: GENERIC_ERROR };
  }

  // The database has spoken. Revalidate the DETAIL path only: a decided receipt
  // is already absent from the active queue, so the queue cannot change here and
  // revalidating it would be a wasted round trip claiming otherwise.
  revalidatePath(`/review/${receiptSubmissionId}`);

  if (result.outcome === "EXCLUDED") {
    return {
      ...base,
      outcome: "EXCLUDED",
      settled: true,
      message:
        "Recorded. This receipt cannot become an authoritative sale or earn a reward. Its VERIFIED review decision is unchanged.",
    };
  }

  if (result.outcome === "ALREADY_EXCLUDED") {
    return {
      ...base,
      outcome: "ALREADY_EXCLUDED",
      settled: true,
      message:
        "You had already recorded this exclusion. Nothing was changed and no second event was created.",
    };
  }

  if (result.outcome === "REINSTATED") {
    return {
      ...base,
      outcome: "REINSTATED",
      settled: true,
      message:
        "Recorded as a new reversal event. The original exclusion remains in history. This does not create a sale or a reward.",
    };
  }

  if (result.outcome === "ALREADY_REINSTATED") {
    return {
      ...base,
      outcome: "ALREADY_REINSTATED",
      settled: true,
      message:
        "You had already reversed this exclusion. Nothing was changed and no second event was created.",
    };
  }

  // CONFLICT — the stored state is not what this submission assumed. Nothing was
  // written, nothing is retried, and no other reviewer's identifiers are exposed.
  return {
    ...base,
    outcome: "CONFLICT",
    settled: true,
    message:
      "The qualification of this receipt was changed elsewhere, so nothing was recorded. Reload to see the current state.",
  };
}
