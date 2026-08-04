/**
 * PURE MODULE — no imports, no I/O, no Supabase client, no `next/*`.
 *
 * Maps one authoritative product-decision outcome to what the reviewer reads, and
 * owns every sentence about it.
 *
 * Follows `claim-sale-finalization-settlement.ts` deliberately. That module's
 * comment said a third consumer would make the shared shape obvious; this is the
 * third, and the shape it shares is smaller than it looked — the vocabularies,
 * the copy and the "does it settle" rule all differ, and only the outcome-first
 * ordering is genuinely common. That ordering is documented once, in
 * docs/server-action-authoritative-settlement.md, rather than abstracted into a
 * generic helper that would have to be parameterised on all three.
 *
 * ============================================================================
 * EVERY OUTCOME HERE IS AN ENDING
 * ============================================================================
 * Unlike the sale header, whose ambiguous-time answer is a question, all five
 * product outcomes settle. The database is never asking the reviewer anything —
 * the decision is one immutable yes or no about a list nobody may edit.
 */

/** The five answers `finalize_claim_receipt_sale_items` returns. */
export const PRODUCT_DECISION_OUTCOMES = [
  "ACCEPTED",
  "REJECTED",
  "ALREADY_ACCEPTED",
  "ALREADY_REJECTED",
  "CONFLICT",
] as const;

export type ProductDecisionOutcome = (typeof PRODUCT_DECISION_OUTCOMES)[number];

export function isProductDecisionOutcome(
  value: unknown,
): value is ProductDecisionOutcome {
  return (
    typeof value === "string" &&
    (PRODUCT_DECISION_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * The request did not complete, so what the database did is UNKNOWN.
 *
 * Deliberately NOT "nothing was decided". A request that did not complete may
 * still have committed, and telling a reviewer their decision definitely failed —
 * when it may have succeeded — is the sentence most likely to produce a second
 * attempt at a permanent record.
 */
export const UNCERTAIN_RESULT_MESSAGE =
  "We could not confirm whether this product decision was recorded. Check the " +
  "product decision status below before trying again — if it already went " +
  "through, submitting again will not create a second decision.";

/** The database refused: not a reviewer, not eligible, or no longer available. */
export const REFUSED_MESSAGE =
  "This receipt is no longer available for a product decision. Return to the queue and reload.";

/**
 * The database rejected the decision inputs themselves.
 *
 * The client validator mirrors the same rules, so reaching this means the two
 * disagreed — and the database is the one that is right.
 */
export const INVALID_INPUT_MESSAGE =
  "That product decision was not accepted. Check the reason and note, then try again. Nothing was recorded.";

/** A malformed id never reaches an RPC; the form only renders a server id. */
export const MALFORMED_REQUEST_MESSAGE =
  "Something went wrong on our side and nothing was sent. Please reload and try again.";

/** Shown while the request is in flight and taking longer than usual. */
export const SLOW_REQUEST_MESSAGE =
  "This is taking longer than expected. Do not submit again.";

/** Shown for the whole time the request is in flight. */
export const PENDING_REQUEST_MESSAGE =
  "Saving the permanent product decision…";

/** How long before the reviewer is told the request is merely slow. */
export const SLOW_REQUEST_NOTICE_MS = 4000;

/** Shown once the outcome is on screen and the panel is re-reading the database. */
export const REFRESHING_MESSAGE =
  "Product decision recorded. Refreshing the current product state…";

export type ProductDecisionSettlement = {
  outcome: ProductDecisionOutcome;
  message: string;
  /** True for every outcome: none of them asks the reviewer a question. */
  settled: boolean;
  /** True only when THIS call created the decision. */
  changed: boolean;
};

/**
 * The exact sentence for each authoritative outcome.
 *
 * Every one states what is now true rather than what the reviewer did, and none
 * promises a campaign result, a reward or a coin — none of those exist in this
 * milestone, and a product decision creates none of them.
 *
 * The two ALREADY_ outcomes are idempotent successes and say so plainly: they
 * must never be worded as though this request created the decision, because it
 * did not.
 */
export function settleProductDecisionOutcome(
  outcome: ProductDecisionOutcome,
): ProductDecisionSettlement {
  switch (outcome) {
    case "ACCEPTED":
      return {
        outcome,
        settled: true,
        changed: true,
        message:
          "The complete product list was accepted. Every proposal line is now an authoritative sale item and cannot be edited, reordered or deleted. The receipt's VERIFIED review decision is unchanged, and no campaign was evaluated and no reward or coins were created.",
      };

    case "REJECTED":
      return {
        outcome,
        settled: true,
        changed: true,
        message:
          "The complete product list was rejected. No authoritative sale items exist for this receipt, and none can be added later. The receipt's VERIFIED review decision is unchanged, and no campaign was evaluated and no reward or coins were created.",
      };

    case "ALREADY_ACCEPTED":
      return {
        outcome,
        settled: true,
        changed: false,
        message:
          "You had already accepted this product list. Nothing was changed by this request, and no second decision, sale item or Audit Log event was created.",
      };

    case "ALREADY_REJECTED":
      return {
        outcome,
        settled: true,
        changed: false,
        message:
          "You had already rejected this product list. Nothing was changed by this request, and no second decision or Audit Log event was created.",
      };

    case "CONFLICT":
      // Nothing was written and nothing was overwritten. The other reviewer's
      // identity is never part of this sentence.
      return {
        outcome,
        settled: true,
        changed: false,
        message:
          "The product decision stored for this receipt is not the one you submitted. Nothing was changed, and the decision cannot be reopened or replaced. Refresh to read the stored decision below.",
      };
  }
}

/**
 * Whether the panel should re-read the server after this state.
 *
 * Only once the database has given a FINAL answer. A validation failure has not
 * touched the database; an uncertain result is refreshed deliberately by the
 * reviewer instead; and a request still in flight has not finished.
 */
export function shouldRefreshAfterProductDecisionSettlement(state: {
  settled: boolean;
  uncertain: boolean;
}): boolean {
  return state.settled && !state.uncertain;
}
