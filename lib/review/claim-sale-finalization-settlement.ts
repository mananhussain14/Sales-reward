/**
 * PURE MODULE — no imports, no I/O, no Supabase client, no `next/*`.
 *
 * Maps one authoritative finalization outcome to what the reviewer reads, and
 * owns every sentence about it.
 *
 * Follows `claim-receipt-qualification-settlement.ts` deliberately and without
 * abstracting over it. Two consumers is not yet a framework; when a third
 * arrives, the shared shape will be obvious from three real examples rather than
 * guessed from two. See docs/server-action-authoritative-settlement.md.
 *
 * ============================================================================
 * NOT EVERY OUTCOME IS AN ENDING
 * ============================================================================
 * `AMBIGUOUS_TIME_REQUIRES_CHOICE` is the one authoritative answer that does NOT
 * settle. The database refused to guess between two real instants and is asking
 * the reviewer a question; the form must stay open so it can be answered. Every
 * other outcome ends the form.
 */

/** The four answers `finalize_claim_receipt_sale_header` returns. */
export const SALE_FINALIZATION_OUTCOMES = [
  "FINALIZED",
  "ALREADY_FINALIZED",
  "AMBIGUOUS_TIME_REQUIRES_CHOICE",
  "CONFLICT",
] as const;

export type SaleFinalizationOutcome =
  (typeof SALE_FINALIZATION_OUTCOMES)[number];

export function isSaleFinalizationOutcome(
  value: unknown,
): value is SaleFinalizationOutcome {
  return (
    typeof value === "string" &&
    (SALE_FINALIZATION_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * The request did not complete, so what the database did is UNKNOWN.
 *
 * Deliberately NOT "nothing was finalized". A request that did not complete may
 * still have committed, and telling a reviewer their sale definitely failed —
 * when it may have succeeded — is the sentence most likely to produce a second
 * attempt at an immutable financial record.
 */
export const UNCERTAIN_RESULT_MESSAGE =
  "We could not confirm whether this sale was finalized. Refresh the sale " +
  "status below before trying again — if it already went through, submitting " +
  "again will not create a second sale.";

/** The database refused: not a reviewer, not eligible, or no longer available. */
export const REFUSED_MESSAGE =
  "This receipt is no longer available for you to finalize. Return to the queue and reload.";

/** The shop's local time never existed, because a clock change skipped it. */
export const NONEXISTENT_TIME_MESSAGE =
  "The time printed on this receipt did not exist in the shop's time zone — the " +
  "clocks moved forward past it. This receipt cannot be finalized until the " +
  "transaction details are corrected.";

/** The shop has no IANA zone, so no instant can be resolved. */
export const NO_TIMEZONE_MESSAGE =
  "This shop has no time zone recorded, so the sale instant cannot be resolved. " +
  "An operator must set the shop's time zone first.";

/** A choice that was invalid, unnecessary, or no longer applies. */
export const INVALID_CHOICE_MESSAGE =
  "That daylight-saving selection is not valid for this receipt any more. " +
  "Refresh the sale status and try again.";

/** A malformed id never reaches an RPC; the form only renders a server id. */
export const MALFORMED_REQUEST_MESSAGE =
  "Something went wrong on our side and nothing was sent. Please reload and try again.";

/** Shown while the request is in flight and taking longer than usual. */
export const SLOW_REQUEST_MESSAGE =
  "Still finalizing. Do not submit again. The result will be checked before another attempt.";

/** How long before the reviewer is told the request is merely slow. */
export const SLOW_REQUEST_NOTICE_MS = 4000;

/** Shown once the outcome is on screen and the panel is re-reading the database. */
export const REFRESHING_MESSAGE =
  "Sale result recorded. Refreshing the current sale header…";

export type SaleFinalizationSettlement = {
  outcome: SaleFinalizationOutcome;
  message: string;
  /** False only for AMBIGUOUS_TIME_REQUIRES_CHOICE, which is a question. */
  settled: boolean;
  /** True only when this call actually created the immutable sale. */
  changed: boolean;
};

/**
 * The exact sentence for each authoritative outcome.
 *
 * Every one states what is now true rather than what the reviewer did, and none
 * promises a product, a campaign result, a reward or a coin — none of those
 * exist, and a sale header creates none of them.
 */
export function settleSaleFinalizationOutcome(
  outcome: SaleFinalizationOutcome,
): SaleFinalizationSettlement {
  switch (outcome) {
    case "FINALIZED":
      return {
        outcome,
        settled: true,
        changed: true,
        message:
          "Sale header finalized. The resolved sale time and time zone are now frozen and cannot be edited or deleted. The receipt's VERIFIED review decision is unchanged, and no products, campaign result, reward or coins were created.",
      };

    case "ALREADY_FINALIZED":
      return {
        outcome,
        settled: true,
        changed: false,
        message:
          "You had already finalized this sale. Nothing was changed, and no second sale header or Audit Log event was created.",
      };

    case "AMBIGUOUS_TIME_REQUIRES_CHOICE":
      // NOT settled. The database is asking a question only a person can answer.
      return {
        outcome,
        settled: false,
        changed: false,
        message:
          "That local time happened twice on the day of this receipt, when the clocks went back. Choose which of the two instants the sale actually happened at. No sale header was created.",
      };

    case "CONFLICT":
      // Nothing was written and nothing was overwritten. The other reviewer's
      // identity is never part of this sentence.
      return {
        outcome,
        settled: true,
        changed: false,
        message:
          "The sale header for this receipt was finalized elsewhere, or your daylight-saving selection no longer matches what was recorded. Nothing was changed. The current sale header is shown below.",
      };
  }
}

/**
 * Whether the panel should re-read the server after this state.
 *
 * Only once the database has given a FINAL answer. A validation failure has not
 * touched the database; an ambiguity prompt is still awaiting the reviewer; an
 * uncertain result is refreshed deliberately by the reviewer instead; and a
 * request still in flight has not finished.
 */
export function shouldRefreshAfterSaleFinalizationSettlement(state: {
  settled: boolean;
  uncertain: boolean;
}): boolean {
  return state.settled && !state.uncertain;
}
