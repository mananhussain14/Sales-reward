"use server";

import { recordClaimReceiptQualification } from "@/lib/review/claim-receipt-qualification-write";
import { validateQualificationInput } from "@/lib/review/claim-receipt-qualification-input";
import { isReceiptSubmissionId } from "@/lib/review/claim-review-queue-filters";
import {
  settleQualificationOutcome,
  MALFORMED_REQUEST_MESSAGE,
  REFUSED_MESSAGE,
  UNCERTAIN_RESULT_MESSAGE,
} from "@/lib/review/claim-receipt-qualification-settlement";
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
 * WHY THIS ACTION DOES NOT REVALIDATE THE ROUTE IT WAS CALLED FROM
 * ============================================================================
 * It used to call `revalidatePath('/review/{id}')` here, and that is what left a
 * reviewer watching "Recording…" after the database had already committed.
 *
 * Next.js documents the reason plainly: "The mutation, the cache invalidation,
 * and the page re-render all complete in a single roundtrip", and revalidating a
 * path the caller is currently viewing "Updates the UI immediately". So the
 * action's reply was not sent until this route had been re-rendered — and this
 * route re-runs the reviewer layout's auth and permission checks, then
 * `get_claim_review_detail`, then `get_claim_receipt_qualification`, each a
 * separate round trip to a database in another region. `useActionState` keeps
 * `pending` true for that entire window, so a committed, audited, immutable
 * write looked indistinguishable from a hung request.
 *
 * The same document states the fix: "An action that does none of the above
 * carries only its return value, and the current route is not re-rendered." So
 * this action now returns the authoritative outcome and nothing else. The panel
 * renders that outcome first, then asks for fresh server data itself with
 * a client router refresh — which merges the new payload without discarding the
 * outcome the reviewer is reading.
 *
 * NOTHING is lost by dropping it. Revalidation only ever refreshed the page the
 * reviewer was already on; no other route reads qualification state, and a
 * decided receipt is already absent from the queue.
 *
 * ============================================================================
 * NOTHING RAW IS LOGGED
 * ============================================================================
 * A reviewer note is free text about a real receipt. Nothing here logs the note,
 * the reason, the id or any provider error — only fixed strings.
 */

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

  // A malformed id never reaches an RPC. Reported as a generic problem rather
  // than "no such receipt", because the form is only ever rendered with an id the
  // server itself put there — a bad one means something is wrong, not missing.
  if (!isReceiptSubmissionId(receiptSubmissionId)) {
    return { ...base, formError: MALFORMED_REQUEST_MESSAGE };
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
    // The database answered, and the answer was no. Not uncertain.
    return { ...base, formError: REFUSED_MESSAGE };
  }

  if (result.status === "unavailable") {
    // NOT settled and NOT a claim of failure. The call did not complete, so the
    // write may or may not have committed — only the database knows, and the
    // reviewer is told to look there before trying again.
    return { ...base, formError: UNCERTAIN_RESULT_MESSAGE, uncertain: true };
  }

  // The database has spoken. Return immediately: the panel renders this outcome
  // and then refreshes the route itself, so the reply is never held behind a
  // re-render of the page the reviewer is already looking at.
  return { ...base, ...settleQualificationOutcome(result.outcome) };
}
