import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { NormalizedDecision } from "@/lib/review/claim-review-decision-input";

/**
 * Recording one Claim Reviewer decision — the write side of Phase 1C-C.
 *
 * SERVER-ONLY. One RPC and nothing else:
 *
 *   public.decide_claim_receipt(p_submission_id, p_decision,
 *                               p_rejection_reason, p_reviewer_note)
 *
 * ============================================================================
 * FOUR ARGUMENTS, AND NOT ONE MORE
 * ============================================================================
 * There is no Vendor, reviewer, member, role, actor or decided-at parameter, and
 * this module could not supply one if it wanted to. The function derives the
 * Vendor from `resolve_claim_reviewer_organization('RECEIPT_REVIEW_DECIDE')` and
 * the actor from `auth.uid()`, takes its own timestamp, and writes its own audit
 * event inside the same transaction.
 *
 * THAT LAST POINT IS WHY THERE IS NO AUDIT WRITE HERE. The database inserts
 * exactly one `RECEIPT_VERIFIED`/`RECEIPT_REJECTED` row, in the same transaction
 * as the decision, guarded by `GET DIAGNOSTICS ROW_COUNT` so a losing concurrent
 * caller writes none. A second audit write from the Web would be a duplicate on
 * the happy path and a lie on the conflict path.
 *
 * ============================================================================
 * THE THREE OUTCOMES
 * ============================================================================
 * The RPC never overwrites. It inserts `ON CONFLICT DO NOTHING` against a UNIQUE
 * constraint on the receipt, checks the affected row count, and reports:
 *
 *   DECIDED          this call wrote the decision. changed = true.
 *   ALREADY_DECIDED  the same reviewer already recorded the identical decision.
 *                    An idempotent retry — a double submit, a reload. Not an error.
 *   CONFLICT         a decision already exists that this call did not make.
 *                    Somebody else got there first, or the same reviewer is
 *                    trying to record something different. Nothing was changed.
 *
 * All three are SUCCESSFUL calls describing different truths, so all three are
 * returned as data. Only a transport or permission failure is an error.
 */

export type ClaimReviewDecisionOutcome =
  | "DECIDED"
  | "ALREADY_DECIDED"
  | "CONFLICT";

/** What the database says is now true of this receipt, whoever wrote it. */
export type ClaimReviewDecisionResult =
  | {
      status: "ok";
      outcome: ClaimReviewDecisionOutcome;
      /** The decision now stored — this caller's, or the winner's. */
      decision: string | null;
      rejectionReason: string | null;
      decidedAt: string | null;
      /** True only when THIS call wrote the row. */
      changed: boolean;
    }
  | { status: "unauthenticated" }
  /**
   * The database refused: not a reviewer, lost the permission, the receipt is
   * not reviewable, or an argument failed its own validation. Deliberately not
   * split further — the RPC raises `insufficient_privilege` for "not yours" and
   * "does not exist" alike, and separating them here would rebuild the oracle
   * the function is careful not to be.
   */
  | { status: "refused" }
  | { status: "unavailable" };

type DecisionRpcRow = {
  outcome: string | null;
  decision: string | null;
  rejection_reason: string | null;
  decided_at: string | null;
  changed: boolean | null;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isOutcome(v: unknown): v is ClaimReviewDecisionOutcome {
  return v === "DECIDED" || v === "ALREADY_DECIDED" || v === "CONFLICT";
}

/**
 * PostgREST reports a raised exception as an error, and the SQLSTATE is the only
 * thing worth reading from it. `42501` (insufficient_privilege) and `22023`
 * (invalid_parameter_value) are the two the function raises deliberately; both
 * mean "the database refused", which is a different user-facing story from "the
 * call did not complete".
 *
 * Only the code is ever touched. The message, details and hint name schemas,
 * tables and functions and are never read, logged or returned.
 */
function isRefusalCode(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "42501" || code === "22023";
}

/**
 * Submits one decision.
 *
 * Takes an ALREADY-NORMALIZED input so the shape the RPC receives is decided by
 * the pure validator and pinned by its own tests, not assembled here from raw
 * form strings.
 */
export async function submitClaimReviewDecision(
  receiptSubmissionId: string,
  input: NormalizedDecision,
): Promise<ClaimReviewDecisionResult> {
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
    supabase.rpc("decide_claim_receipt", {
      p_submission_id: receiptSubmissionId,
      p_decision: input.decision,
      p_rejection_reason: input.rejectionReason,
      p_reviewer_note: input.reviewerNote,
    }),
  ).catch(() => null);

  if (result === null) {
    console.error("claim-review-decision: decision call did not complete");
    return { status: "unavailable" };
  }

  if (result.error) {
    if (isRefusalCode(result.error)) {
      console.error("claim-review-decision: decision refused by the database");
      return { status: "refused" };
    }
    console.error("claim-review-decision: decision call failed");
    return { status: "unavailable" };
  }

  const rows = (result.data ?? []) as DecisionRpcRow[];
  const row = rows.length > 0 ? rows[0] : null;

  // A successful call that returned no recognizable outcome is treated as
  // unavailable, NOT as success. Reporting "decided" on an unreadable answer
  // would be the single worst lie this module could tell.
  if (row === null || !isOutcome(row.outcome)) {
    console.error("claim-review-decision: decision outcome was unreadable");
    return { status: "unavailable" };
  }

  return {
    status: "ok",
    outcome: row.outcome,
    decision: optionalText(row.decision),
    rejectionReason: optionalText(row.rejection_reason),
    decidedAt: optionalText(row.decided_at),
    changed: row.changed === true,
  };
}
