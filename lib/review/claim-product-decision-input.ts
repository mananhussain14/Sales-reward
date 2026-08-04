/**
 * PURE MODULE — no imports, no I/O, no Supabase client, no `next/*`.
 *
 * Normalizes and validates the ONE judgement a Claim Reviewer may make about a
 * receipt's product list before it reaches
 * `public.finalize_claim_receipt_sale_items`.
 *
 * ============================================================================
 * THE REVIEWER ANSWERS YES OR NO ABOUT A LIST THEY CANNOT TOUCH
 * ============================================================================
 * There is no field here for a product, a quantity, a line number, a product
 * snapshot, a sale, a confirmation, a decision, a Vendor, a Retailer, a shop or
 * an actor — not because they are filtered out, but because the RPC has no
 * parameter for any of them and this module has no type that could carry one.
 * Every authoritative item is copied from the immutable Sales Staff proposal by
 * the database itself.
 *
 * The complete list is accepted or rejected TOGETHER. One wrong line means the
 * whole list may be rejected; there is no line-specific verdict, and adding one
 * would require a database column that deliberately does not exist.
 *
 * ============================================================================
 * THIS IS NOT THE AUTHORITY, AND MUST NEVER BECOME IT
 * ============================================================================
 * Every rule below is ALREADY enforced inside the RPC, which raises
 * `invalid_parameter_value` on each one. This module exists so a reviewer gets a
 * field-level message instead of a generic failure. If the two ever disagree the
 * database wins — nothing here can widen what it accepts.
 *
 * Transcribed from the deployed function body (migration 20260822090000):
 *
 *   decision   must be ACCEPTED or REJECTED
 *   ACCEPTED   must carry NO rejection reason and NO note
 *   REJECTED   must carry one of exactly five reasons
 *   note       trimmed; empty-after-trim is absent; max 500 characters
 *   OTHER      requires a note
 */

export const PRODUCT_DECISIONS = ["ACCEPTED", "REJECTED"] as const;
export type ProductDecision = (typeof PRODUCT_DECISIONS)[number];

/**
 * The five approved rejection reasons, in the order the form presents them:
 * the most objective and most common first, `OTHER` last.
 */
export const PRODUCT_REJECTION_REASONS = [
  "PRODUCT_NOT_ON_RECEIPT",
  "WRONG_PRODUCT",
  "QUANTITY_MISMATCH",
  "ILLEGIBLE",
  "OTHER",
] as const;
export type ProductRejectionReason = (typeof PRODUCT_REJECTION_REASONS)[number];

/** The maximum note length the database accepts. */
export const PRODUCT_NOTE_MAX_LENGTH = 500;

/**
 * The reasons whose note is MANDATORY.
 *
 * Only `OTHER`, which by definition says nothing on its own. The other four name
 * the problem precisely enough that the note adds detail rather than meaning.
 */
export const PRODUCT_REASONS_REQUIRING_NOTE: readonly ProductRejectionReason[] = [
  "OTHER",
];

/** Human labels. Kept beside the codes so a new code cannot ship unlabelled. */
export const PRODUCT_REJECTION_REASON_LABELS: Record<
  ProductRejectionReason,
  string
> = {
  PRODUCT_NOT_ON_RECEIPT: "Product not shown on receipt",
  WRONG_PRODUCT: "Wrong product selected",
  QUANTITY_MISMATCH: "Quantity does not match",
  ILLEGIBLE: "Receipt too unclear to verify products",
  OTHER: "Other",
};

export const PRODUCT_DECISION_LABELS: Record<ProductDecision, string> = {
  ACCEPTED: "Products accepted",
  REJECTED: "Products rejected",
};

export function isProductDecision(v: unknown): v is ProductDecision {
  return (
    typeof v === "string" && (PRODUCT_DECISIONS as readonly string[]).includes(v)
  );
}

export function isProductRejectionReason(
  v: unknown,
): v is ProductRejectionReason {
  return (
    typeof v === "string" &&
    (PRODUCT_REJECTION_REASONS as readonly string[]).includes(v)
  );
}

/** True when choosing this reason obliges the reviewer to write a note. */
export function productReasonRequiresNote(
  reason: ProductRejectionReason | null,
): boolean {
  return reason !== null && PRODUCT_REASONS_REQUIRING_NOTE.includes(reason);
}

export type ProductDecisionFieldErrors = {
  decision?: string;
  rejectionReason?: string;
  reviewerNote?: string;
};

/**
 * Exactly the three values the RPC takes, beyond the receipt id.
 *
 * Both nullable fields are null for an acceptance, which is what the database
 * requires — it refuses an accepted proposal that carries either.
 */
export type NormalizedProductDecision = {
  decision: ProductDecision;
  rejectionReason: ProductRejectionReason | null;
  /** Trimmed, or null. Never an empty string. */
  reviewerNote: string | null;
};

export type ProductDecisionValidationResult =
  | { ok: true; value: NormalizedProductDecision }
  | { ok: false; fieldErrors: ProductDecisionFieldErrors };

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
 * Validates one submitted product decision.
 *
 * Returns EVERY field error at once rather than stopping at the first, so a
 * reviewer who picked `Other` and forgot the note is not told about one problem,
 * fixes it, and then discovers the other.
 *
 * The note is validated against the TRIMMED value, matching the RPC's
 * `nullif(btrim(...), '')` exactly — a 500-character note padded with spaces is
 * accepted by both, and a note of 500 spaces is absent to both.
 */
export function validateProductDecisionInput(raw: {
  decision?: unknown;
  rejectionReason?: unknown;
  reviewerNote?: unknown;
}): ProductDecisionValidationResult {
  const fieldErrors: ProductDecisionFieldErrors = {};

  const decisionRaw = single(raw.decision);
  const decision = isProductDecision(decisionRaw) ? decisionRaw : null;
  if (decision === null) {
    fieldErrors.decision =
      "Choose whether to accept or reject the complete product list.";
  }

  // Read the reason for BOTH decisions. An acceptance carrying one is an error
  // the reviewer should see rather than something silently discarded — quietly
  // dropping it would let a mis-wired form accept a list meant to be rejected.
  const reasonRaw = single(raw.rejectionReason);
  let rejectionReason: ProductRejectionReason | null = null;

  if (decision === "ACCEPTED") {
    if (reasonRaw !== null) {
      fieldErrors.rejectionReason =
        "An accepted product list cannot carry a rejection reason.";
    }
  } else if (decision === "REJECTED") {
    if (reasonRaw === null) {
      fieldErrors.rejectionReason =
        "Choose a reason for rejecting the complete product list.";
    } else if (!isProductRejectionReason(reasonRaw)) {
      fieldErrors.rejectionReason = "That rejection reason is not recognised.";
    } else {
      rejectionReason = reasonRaw;
    }
  }

  const noteRaw = single(raw.reviewerNote);
  let reviewerNote: string | null = noteRaw;

  if (noteRaw !== null && noteRaw.length > PRODUCT_NOTE_MAX_LENGTH) {
    fieldErrors.reviewerNote = `A note may be at most ${PRODUCT_NOTE_MAX_LENGTH} characters. This one is ${noteRaw.length}.`;
    reviewerNote = null;
  }

  if (decision === "ACCEPTED" && reviewerNote !== null) {
    // The database refuses it outright, so saying so is more honest than
    // dropping the reviewer's words without telling them.
    fieldErrors.reviewerNote = "An accepted product list cannot carry a note.";
  }

  // Only meaningful once the reason itself is valid; otherwise the reviewer would
  // be told to write a note for a reason that will not be accepted anyway.
  if (
    decision === "REJECTED" &&
    rejectionReason !== null &&
    productReasonRequiresNote(rejectionReason) &&
    reviewerNote === null &&
    fieldErrors.reviewerNote === undefined
  ) {
    fieldErrors.reviewerNote = `A note is required when the reason is “${PRODUCT_REJECTION_REASON_LABELS[rejectionReason]}”.`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    value: {
      decision: decision as ProductDecision,
      // Belt and braces: an acceptance forwards null for both, which is the only
      // shape the database accepts for one.
      rejectionReason: decision === "ACCEPTED" ? null : rejectionReason,
      reviewerNote: decision === "ACCEPTED" ? null : reviewerNote,
    },
  };
}
