/**
 * PURE MODULE — no imports, no I/O, no Supabase client, no `next/*`.
 *
 * Words for the product panel.
 *
 * ============================================================================
 * FROZEN AND CURRENT ARE DIFFERENT SENTENCES, NOT DIFFERENT COLOURS
 * ============================================================================
 * A proposal line carries the product's status AT PROPOSAL TIME, frozen forever,
 * and the panel also shows what that product's status is RIGHT NOW. Those two
 * facts are routinely different and must never be blended: a product deactivated
 * after the proposal does not retroactively change what was proposed, and it does
 * not block the decision either.
 *
 * So each has its own labelling function, and each label names WHICH of the two
 * it is describing. "Inactive" alone would be ambiguous the moment the two
 * disagree.
 */

/** The two statuses a catalogue product may have, now or at proposal time. */
export const PRODUCT_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export function isProductStatus(v: unknown): v is ProductStatus {
  return (
    typeof v === "string" && (PRODUCT_STATUSES as readonly string[]).includes(v)
  );
}

/** How the frozen proposal-time status reads. Always says "when submitted". */
export function proposalStatusLabel(status: string | null): string {
  if (status === "ACTIVE") return "Status when submitted: Active";
  if (status === "INACTIVE") return "Status when submitted: Inactive";
  return "Status when submitted: Not recorded";
}

/** How the product's status today reads. Always says "current". */
export function currentStatusLabel(status: string | null): string {
  if (status === "ACTIVE") return "Current catalogue status: Active";
  if (status === "INACTIVE") return "Current catalogue status: Inactive";
  return "Current catalogue status: Not available";
}

/**
 * Whether this product is assigned to this Retailer right now.
 *
 * `null` means the answer could not be read, which is stated rather than guessed
 * — "No" would accuse the Retailer of something unproven.
 */
export function currentAssignmentLabel(assigned: boolean | null): string {
  if (assigned === true) return "Currently assigned to this retailer: Yes";
  if (assigned === false) return "Currently assigned to this retailer: No";
  return "Currently assigned to this retailer: Not available";
}

/**
 * True when the CURRENT state of a product differs from what was proposed in a
 * way worth pointing out.
 *
 * Informational only. Nothing that returns true here may disable acceptance —
 * the frozen proposal-time values remain authoritative, and the database does
 * not re-check current status when finalizing.
 */
export function hasCurrentStateWarning(line: {
  statusAtProposal: string | null;
  statusCurrent: string | null;
  assignedCurrently: boolean | null;
}): boolean {
  return line.statusCurrent === "INACTIVE" || line.assignedCurrently === false;
}

/** The exclusion vocabulary, in words. Unknown codes are shown as recorded. */
export function exclusionReasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  if (reason === "TEST_DATA") return "Test data";
  if (reason === "NON_QUALIFYING") return "Non-qualifying";
  if (reason === "DUPLICATE") return "Duplicate";
  return reason;
}

/**
 * The sum of every line's quantity.
 *
 * A display total only. The database computes its own from the stored proposal
 * and never reads a number sent by a browser.
 */
export function totalProposedQuantity(
  lines: readonly { quantity: number }[],
): number {
  let total = 0;
  for (const line of lines) {
    if (Number.isFinite(line.quantity)) total += line.quantity;
  }
  return total;
}
