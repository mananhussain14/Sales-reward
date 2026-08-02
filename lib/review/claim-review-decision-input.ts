/**
 * PURE MODULE — no imports, no I/O, no Supabase client, no `next/*`.
 *
 * Normalizes and validates one Claim Reviewer decision before it reaches
 * `public.decide_claim_receipt`.
 *
 * ============================================================================
 * THIS IS NOT THE AUTHORITY, AND MUST NEVER BECOME IT
 * ============================================================================
 * Every rule below is ALREADY enforced inside the RPC, which raises
 * `invalid_parameter_value` on each one. This module exists so a reviewer gets a
 * field-level message instead of a generic failure — it is a better error
 * experience layered over the real check, not a replacement for it.
 *
 * That ordering matters. If these two ever disagree, the database wins and the
 * reviewer sees the generic error; nothing here can widen what the database
 * accepts, because a value this module passes still has to survive the RPC.
 *
 * ============================================================================
 * THE RULES, AND WHERE THEY COME FROM
 * ============================================================================
 * Transcribed from the deployed function body (migration 20260819090000), not
 * from the brief, so the copy cannot drift from what actually runs:
 *
 *   decision            must be VERIFIED or REJECTED
 *   VERIFIED            must NOT carry a rejection reason
 *   REJECTED            must carry one of exactly five reasons
 *   note                trimmed; empty-after-trim is absent; max 500 characters
 *   INVALID_RECEIPT     require a note
 *   DUPLICATE_RECEIPT   require a note
 *   OTHER               require a note
 *
 * A note is optional for UNREADABLE_RECEIPT, MISSING_REQUIRED_INFORMATION and
 * VERIFIED.
 */

export const CLAIM_REVIEW_DECISIONS = ["VERIFIED", "REJECTED"] as const;
export type ClaimReviewDecision = (typeof CLAIM_REVIEW_DECISIONS)[number];

/**
 * The five approved rejection reasons, in the order the form presents them:
 * most common and most objective first, `OTHER` last.
 */
export const CLAIM_REVIEW_REJECTION_REASONS = [
  "UNREADABLE_RECEIPT",
  "MISSING_REQUIRED_INFORMATION",
  "INVALID_RECEIPT",
  "DUPLICATE_RECEIPT",
  "OTHER",
] as const;
export type ClaimReviewRejectionReason =
  (typeof CLAIM_REVIEW_REJECTION_REASONS)[number];

/** The maximum note length the database accepts. */
export const CLAIM_REVIEW_NOTE_MAX_LENGTH = 500;

/**
 * The reasons whose note is MANDATORY.
 *
 * Each of these makes a factual claim the reviewer cannot support from the image
 * alone — "this is invalid", "this is a duplicate of something", "something else
 * is wrong" — so the note is where the evidence goes. The two that are optional
 * describe the image itself, which the receipt already evidences.
 */
export const REASONS_REQUIRING_NOTE: readonly ClaimReviewRejectionReason[] = [
  "INVALID_RECEIPT",
  "DUPLICATE_RECEIPT",
  "OTHER",
];

/** Human labels. Kept beside the codes so a new code cannot ship unlabelled. */
export const REJECTION_REASON_LABELS: Record<ClaimReviewRejectionReason, string> =
  {
    UNREADABLE_RECEIPT: "Unreadable receipt",
    MISSING_REQUIRED_INFORMATION: "Missing required information",
    INVALID_RECEIPT: "Invalid receipt",
    DUPLICATE_RECEIPT: "Duplicate receipt",
    OTHER: "Other",
  };

export const DECISION_LABELS: Record<ClaimReviewDecision, string> = {
  VERIFIED: "Verified",
  REJECTED: "Rejected",
};

export function isClaimReviewDecision(v: unknown): v is ClaimReviewDecision {
  return (
    typeof v === "string" &&
    (CLAIM_REVIEW_DECISIONS as readonly string[]).includes(v)
  );
}

export function isRejectionReason(v: unknown): v is ClaimReviewRejectionReason {
  return (
    typeof v === "string" &&
    (CLAIM_REVIEW_REJECTION_REASONS as readonly string[]).includes(v)
  );
}

/** True when choosing this reason obliges the reviewer to write a note. */
export function reasonRequiresNote(
  reason: ClaimReviewRejectionReason | null,
): boolean {
  return reason !== null && REASONS_REQUIRING_NOTE.includes(reason);
}

export type DecisionFieldErrors = {
  decision?: string;
  rejectionReason?: string;
  reviewerNote?: string;
};

/** Exactly the three values the RPC takes, beyond the receipt id. */
export type NormalizedDecision = {
  decision: ClaimReviewDecision;
  /** null for VERIFIED — the RPC rejects a reason on a verified receipt. */
  rejectionReason: ClaimReviewRejectionReason | null;
  /** Trimmed, or null. Never an empty string. */
  reviewerNote: string | null;
};

export type DecisionValidationResult =
  | { ok: true; value: NormalizedDecision }
  | { ok: false; fieldErrors: DecisionFieldErrors };

/**
 * A single string from a form, trimmed, or null when absent or blank.
 *
 * A repeated field arrives as an array and a file as an object; neither is a
 * meaningful decision input, so both become null rather than being coerced into
 * a string like "[object Object]" that might accidentally match something.
 */
function single(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validates one submitted decision.
 *
 * Returns EVERY field error at once rather than stopping at the first, so a
 * reviewer who picked a reason and forgot the note is not told about one problem,
 * fixes it, and then discovers the other.
 *
 * The note is validated against the trimmed value, matching the RPC's
 * `nullif(btrim(...), '')` exactly — a 500-character note padded with spaces is
 * accepted by both, and a note of 500 spaces is absent to both.
 */
export function validateDecisionInput(raw: {
  decision?: unknown;
  rejectionReason?: unknown;
  reviewerNote?: unknown;
}): DecisionValidationResult {
  const fieldErrors: DecisionFieldErrors = {};

  const decisionRaw = single(raw.decision);
  const decision = isClaimReviewDecision(decisionRaw) ? decisionRaw : null;
  if (decision === null) {
    fieldErrors.decision = "Choose whether to verify or reject this receipt.";
  }

  // Read the reason for BOTH decisions. A verified receipt carrying one is an
  // error the reviewer should see, not something to silently discard — silently
  // dropping it would let a mis-wired form verify a receipt the reviewer meant
  // to reject.
  const reasonRaw = single(raw.rejectionReason);
  let rejectionReason: ClaimReviewRejectionReason | null = null;

  if (decision === "VERIFIED") {
    if (reasonRaw !== null) {
      fieldErrors.rejectionReason =
        "A verified receipt cannot carry a rejection reason.";
    }
  } else if (decision === "REJECTED") {
    if (reasonRaw === null) {
      fieldErrors.rejectionReason = "Choose a reason for rejecting this receipt.";
    } else if (!isRejectionReason(reasonRaw)) {
      fieldErrors.rejectionReason = "That rejection reason is not recognised.";
    } else {
      rejectionReason = reasonRaw;
    }
  }

  const noteRaw = single(raw.reviewerNote);
  let reviewerNote: string | null = noteRaw;
  if (noteRaw !== null && noteRaw.length > CLAIM_REVIEW_NOTE_MAX_LENGTH) {
    fieldErrors.reviewerNote = `A note may be at most ${CLAIM_REVIEW_NOTE_MAX_LENGTH} characters. This one is ${noteRaw.length}.`;
    reviewerNote = null;
  }

  // Only meaningful once the reason itself is valid; otherwise the reviewer would
  // be told to write a note for a reason that will not be accepted anyway.
  if (
    decision === "REJECTED" &&
    rejectionReason !== null &&
    reasonRequiresNote(rejectionReason) &&
    reviewerNote === null &&
    fieldErrors.reviewerNote === undefined
  ) {
    fieldErrors.reviewerNote = `A note is required when the reason is “${REJECTION_REASON_LABELS[rejectionReason]}”.`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    value: {
      decision: decision as ClaimReviewDecision,
      rejectionReason,
      reviewerNote,
    },
  };
}
