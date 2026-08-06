/**
 * PURE MODULE — the only imports are the decision vocabularies, which are data.
 * No I/O, no Supabase client, no `next/*`, no `server-only`.
 *
 * The shapes a Claim Reviewer reads about a receipt's products, and the parsing
 * of every row the database returns for them.
 *
 * ============================================================================
 * WHY THE PARSING LIVES HERE AND NOT IN THE ADAPTER
 * ============================================================================
 * The adapters are `server-only`: they cannot be imported by a test process, so
 * anything inside them can only be checked by reading their source. The rules
 * below are the ones this milestone most needs exercised by CALLING them — an
 * unknown decision word must not become "no decision yet", a partial line list
 * must not become "the complete list", and a mismatched count must not be
 * quietly accepted. So they live in a module a test can import and run.
 *
 * The adapters keep what only they can do: authenticate, call one RPC, and turn
 * a null from here into `unavailable`.
 *
 * ============================================================================
 * NO INTERNAL IDENTIFIER CROSSES THIS BOUNDARY
 * ============================================================================
 * Neither RPC returns a proposal-line id, decision id, sale id, confirmation id,
 * Vendor id, Retailer id, shop id, product id or profile id, and no type in this
 * file has a field for one. The receipt submission id is the single identifier
 * present, and it is the one the browser already has in its URL.
 */
import {
  isProductDecision,
  isProductRejectionReason,
  type ProductDecision,
  type ProductRejectionReason,
} from "./claim-product-decision-input.ts";

// ============================================================================
// THE PRODUCT CONTEXT
// ============================================================================

/** One immutable proposal line, as the reviewer sees it. */
export type ClaimProductProposalLine = {
  lineNumber: number;
  quantity: number;
  /** FROZEN at proposal time. Never re-read from the catalogue. */
  productCode: string | null;
  productName: string | null;
  barcode: string | null;
  brand: string | null;
  statusAtProposal: string | null;
  /** CURRENT catalogue state. Informational; never blocks a decision. */
  statusCurrent: string | null;
  assignedCurrently: boolean | null;
};

export type ClaimReceiptProductContext = {
  receiptSubmissionId: string;
  hasProductProposal: boolean;
  proposalLineCount: number;
  /** Phase 1D-A must have finished: no header, no product decision. */
  hasVerifiedSaleHeader: boolean;
  isQualificationExcluded: boolean;
  /** Only when excluded: TEST_DATA, NON_QUALIFYING or DUPLICATE. */
  exclusionReason: string | null;

  /** The one immutable decision, when one exists. */
  decision: ProductDecision | null;
  rejectionReason: ProductRejectionReason | null;
  reviewerNote: string | null;
  decidedAt: string | null;
  decidedByDisplayName: string | null;
  alreadyAccepted: boolean;
  alreadyRejected: boolean;

  /** Ordered by line number, exactly as the database returned them. */
  lines: ClaimProductProposalLine[];
};

/**
 * One row of `get_claim_receipt_product_context`, declared explicitly.
 *
 * These twenty-two columns are its entire output. There is no proposal-line id,
 * decision id, sale id, confirmation id, Vendor id, Retailer id, shop id, product
 * id, profile id, email, filename, storage path or hash to receive — the function
 * does not return them, and this type could not carry them if it wanted to.
 */
export type ProductContextRpcRow = {
  receipt_submission_id: string;
  has_product_proposal: boolean | null;
  proposal_line_count: number | string | null;
  has_verified_sale_header: boolean | null;
  is_qualification_excluded: boolean | null;
  exclusion_reason: string | null;
  product_decision: string | null;
  rejection_reason: string | null;
  reviewer_note: string | null;
  decided_at: string | null;
  decided_by_display_name: string | null;
  already_accepted: boolean | null;
  already_rejected: boolean | null;
  line_number: number | string | null;
  quantity: number | string | null;
  product_code_at_proposal: string | null;
  product_name_at_proposal: string | null;
  barcode_at_proposal: string | null;
  brand_at_proposal: string | null;
  product_status_at_proposal: string | null;
  product_status_current: string | null;
  product_assigned_currently: boolean | null;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** PostgREST may return an integer as a string; a silent NaN would render blank. */
function optionalInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Maps the rows, field by field. Deliberately NOT a spread: a column added to the
 * function later must be admitted here consciously before it can reach a page.
 *
 * Returns null — which the adapter turns into `unavailable` — when a vocabulary
 * is unrecognised or a line is unusable, so an unreadable proposal can never
 * present as decidable.
 */
export function parseClaimProductContext(
  rows: readonly ProductContextRpcRow[],
  fallbackId: string,
): ClaimReceiptProductContext | null {
  if (rows.length === 0) return null;
  const head = rows[0];

  // FAIL CLOSED on an unknown decision. "Not one of the two words I know" must
  // never become "no decision yet", which is the only state that renders the
  // accept and reject controls.
  const rawDecision = optionalText(head.product_decision);
  if (rawDecision !== null && !isProductDecision(rawDecision)) return null;
  const decision: ProductDecision | null = rawDecision;

  const rawReason = optionalText(head.rejection_reason);
  if (rawReason !== null && !isProductRejectionReason(rawReason)) return null;

  // A reason without a rejection, or a rejection whose reason did not come back,
  // is a row this module cannot describe truthfully.
  if (rawReason !== null && decision !== "REJECTED") return null;
  if (decision === "REJECTED" && rawReason === null) return null;

  // The booleans and the word must agree. If they do not, the row is unreadable
  // rather than resolved in favour of either.
  const alreadyAccepted = head.already_accepted === true;
  const alreadyRejected = head.already_rejected === true;
  if (alreadyAccepted && alreadyRejected) return null;
  if (alreadyAccepted !== (decision === "ACCEPTED")) return null;
  if (alreadyRejected !== (decision === "REJECTED")) return null;

  const hasProductProposal = head.has_product_proposal === true;

  const lines: ClaimProductProposalLine[] = [];
  if (hasProductProposal) {
    for (const row of rows) {
      const lineNumber = optionalInteger(row.line_number);
      const quantity = optionalInteger(row.quantity);
      // A line the reviewer cannot read cannot be judged, and a partial list must
      // never be presented as the complete one they are accepting.
      if (lineNumber === null || quantity === null) return null;

      lines.push({
        lineNumber,
        quantity,
        productCode: optionalText(row.product_code_at_proposal),
        productName: optionalText(row.product_name_at_proposal),
        barcode: optionalText(row.barcode_at_proposal),
        brand: optionalText(row.brand_at_proposal),
        // FROZEN and CURRENT are read from different columns into different
        // fields and are never merged, defaulted to one another, or reconciled.
        statusAtProposal: optionalText(row.product_status_at_proposal),
        statusCurrent: optionalText(row.product_status_current),
        assignedCurrently: optionalBoolean(row.product_assigned_currently),
      });
    }

    if (lines.length === 0) return null;
  }

  const declaredCount = optionalInteger(head.proposal_line_count) ?? 0;
  // The count the database reported and the lines it sent must agree, or the
  // reviewer would be accepting a list they were not shown in full.
  if (hasProductProposal && declaredCount !== lines.length) return null;
  if (!hasProductProposal && declaredCount !== 0) return null;

  return {
    receiptSubmissionId: optionalText(head.receipt_submission_id) ?? fallbackId,
    hasProductProposal,
    proposalLineCount: lines.length,
    hasVerifiedSaleHeader: head.has_verified_sale_header === true,
    isQualificationExcluded: head.is_qualification_excluded === true,
    // Guarded on the excluded state rather than copied blindly, so a malformed
    // row cannot render a reason beside a "not excluded" heading.
    exclusionReason:
      head.is_qualification_excluded === true
        ? optionalText(head.exclusion_reason)
        : null,

    decision,
    rejectionReason: decision === "REJECTED" ? rawReason : null,
    reviewerNote: decision === null ? null : optionalText(head.reviewer_note),
    decidedAt: decision === null ? null : optionalText(head.decided_at),
    decidedByDisplayName:
      decision === null ? null : optionalText(head.decided_by_display_name),
    alreadyAccepted,
    alreadyRejected,

    lines,
  };
}

// ============================================================================
// THE AUTHORITATIVE ITEMS
// ============================================================================

/** One authoritative line. Every product value is FROZEN at proposal time. */
export type VerifiedSaleItem = {
  lineNumber: number;
  quantity: number;
  productCode: string | null;
  productName: string | null;
  barcode: string | null;
  brand: string | null;
  statusAtProposal: string | null;
};

export type VerifiedSaleItems = {
  items: VerifiedSaleItem[];
  /** Always ACCEPTED — the RPC returns nothing for a rejected decision. */
  decision: string | null;
  decidedAt: string | null;
  decidedByDisplayName: string | null;
};

/**
 * One row of `get_verified_sale_items`, declared explicitly.
 *
 * These ten columns are its entire output. There is no lineage id, bucket, path,
 * hash, email or phone to receive.
 */
export type VerifiedSaleItemRpcRow = {
  line_number: number | string | null;
  quantity: number | string | null;
  product_code_at_proposal: string | null;
  product_name_at_proposal: string | null;
  barcode_at_proposal: string | null;
  brand_at_proposal: string | null;
  product_status_at_proposal: string | null;
  decision: string | null;
  decided_at: string | null;
  decided_by_display_name: string | null;
};

/**
 * Maps the rows, field by field. Deliberately NOT a spread.
 *
 * A line with no readable number or quantity makes the whole set unusable rather
 * than partially shown — an authoritative item list that silently drops a line is
 * worse than one that says it could not be read.
 */
export function parseVerifiedSaleItems(
  rows: readonly VerifiedSaleItemRpcRow[],
): VerifiedSaleItems | null {
  const items: VerifiedSaleItem[] = [];

  for (const row of rows) {
    const lineNumber = optionalInteger(row.line_number);
    const quantity = optionalInteger(row.quantity);
    if (lineNumber === null || quantity === null) return null;

    items.push({
      lineNumber,
      quantity,
      productCode: optionalText(row.product_code_at_proposal),
      productName: optionalText(row.product_name_at_proposal),
      barcode: optionalText(row.barcode_at_proposal),
      brand: optionalText(row.brand_at_proposal),
      statusAtProposal: optionalText(row.product_status_at_proposal),
    });
  }

  if (items.length === 0) return null;

  return {
    items,
    decision: optionalText(rows[0].decision),
    decidedAt: optionalText(rows[0].decided_at),
    decidedByDisplayName: optionalText(rows[0].decided_by_display_name),
  };
}
