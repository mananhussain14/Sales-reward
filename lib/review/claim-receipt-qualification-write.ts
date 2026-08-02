import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { NormalizedQualification } from "@/lib/review/claim-receipt-qualification-input";

/**
 * Recording one append-only qualification event — the write side of Phase 1D-0.
 *
 * SERVER-ONLY. One RPC and nothing else:
 *
 *   public.record_claim_receipt_qualification(
 *     p_submission_id, p_action, p_exclusion_reason, p_reviewer_note)
 *
 * ============================================================================
 * FOUR ARGUMENTS, AND NOT ONE MORE
 * ============================================================================
 * No Vendor, reviewer, actor, member, role, event id, timestamp, audit action or
 * idempotency key — and this module could not supply one if it wanted to. The
 * function derives the Vendor from the Phase 1B resolver and the actor from
 * `auth.uid()`, takes its own timestamp, resolves the reversal target server-side
 * under a row lock, and writes its own audit event in the same transaction.
 *
 * THE REVERSAL TARGET IS NEVER SENT FROM HERE. A stale page holding an old
 * exclusion's id could otherwise reverse an exclusion recorded after it loaded.
 * The database resolves whatever is active under the lock, so a stale page
 * reverses the current exclusion or nothing at all.
 *
 * ============================================================================
 * THE FIVE OUTCOMES
 * ============================================================================
 *   EXCLUDED            this call recorded the exclusion. changed = true.
 *   ALREADY_EXCLUDED    the same reviewer already recorded the identical one.
 *   REINSTATED          this call reversed the active exclusion. changed = true.
 *   ALREADY_REINSTATED  the same reviewer already reversed it.
 *   CONFLICT            the stored state is not what this call assumed. Nothing
 *                       was written and nothing was overwritten.
 *
 * All five are SUCCESSFUL calls describing different truths, so all five come
 * back as data. Only a transport or permission failure is an error.
 */

export type QualificationOutcome =
  | "EXCLUDED"
  | "ALREADY_EXCLUDED"
  | "REINSTATED"
  | "ALREADY_REINSTATED"
  | "CONFLICT";

export type QualificationWriteResult =
  | {
      status: "ok";
      outcome: QualificationOutcome;
      /** What the database says is now true, whoever wrote it. */
      qualificationState: string | null;
      exclusionReason: string | null;
      classifiedAt: string | null;
      /** True only when THIS call wrote an event. */
      changed: boolean;
    }
  | { status: "unauthenticated" }
  /**
   * The database refused: not a reviewer, lost the permission, the receipt is
   * not classifiable, or an argument failed its own validation. Deliberately not
   * split further — the RPC raises `insufficient_privilege` for "not yours" and
   * "does not exist" alike, and separating them here would rebuild the oracle
   * the function is careful not to be.
   */
  | { status: "refused" }
  | { status: "unavailable" };

type QualificationRpcRow = {
  outcome: string | null;
  qualification_state: string | null;
  exclusion_reason: string | null;
  classified_at: string | null;
  changed: boolean | null;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isOutcome(v: unknown): v is QualificationOutcome {
  return (
    v === "EXCLUDED" ||
    v === "ALREADY_EXCLUDED" ||
    v === "REINSTATED" ||
    v === "ALREADY_REINSTATED" ||
    v === "CONFLICT"
  );
}

/**
 * PostgREST reports a raised exception as an error, and the SQLSTATE is the only
 * thing worth reading from it. `42501` and `22023` are the two this function
 * raises deliberately; both mean "the database refused", a different user-facing
 * story from "the call did not complete". Only the code is touched — the
 * message, details and hint name schemas and functions and are never read.
 */
function isRefusalCode(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "42501" || code === "22023";
}

export async function recordClaimReceiptQualification(
  receiptSubmissionId: string,
  input: NormalizedQualification,
): Promise<QualificationWriteResult> {
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
    supabase.rpc("record_claim_receipt_qualification", {
      p_submission_id: receiptSubmissionId,
      p_action: input.action,
      p_exclusion_reason: input.exclusionReason,
      p_reviewer_note: input.reviewerNote,
    }),
  ).catch(() => null);

  if (result === null) {
    console.error("claim-receipt-qualification: write did not complete");
    return { status: "unavailable" };
  }

  if (result.error) {
    if (isRefusalCode(result.error)) {
      console.error("claim-receipt-qualification: write refused by the database");
      return { status: "refused" };
    }
    console.error("claim-receipt-qualification: write failed");
    return { status: "unavailable" };
  }

  const rows = (result.data ?? []) as QualificationRpcRow[];
  const row = rows.length > 0 ? rows[0] : null;

  // A successful call that returned no recognizable outcome is unavailable, NOT
  // success. Reporting a state change on an unreadable answer would be the worst
  // lie this module could tell.
  if (row === null || !isOutcome(row.outcome)) {
    console.error("claim-receipt-qualification: outcome was unreadable");
    return { status: "unavailable" };
  }

  return {
    status: "ok",
    outcome: row.outcome,
    qualificationState: optionalText(row.qualification_state),
    exclusionReason: optionalText(row.exclusion_reason),
    classifiedAt: optionalText(row.classified_at),
    changed: row.changed === true,
  };
}
