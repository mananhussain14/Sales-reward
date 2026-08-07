/**
 * PURE MODULE — no React, no I/O, no environment, no locale lookups, no side effects.
 *
 * Turns the line items the extraction contract carries into the four strings a person can
 * compare against the paper receipt, one row at a time.
 *
 * ============================================================================
 * WHAT IS NOT HERE, AND WHY THAT MATTERS
 * ============================================================================
 * There is NO reference, product code or SKU field. `list_my_receipt_extraction_line_items`
 * returns ten columns — line_number, description, description_source_text, quantity,
 * quantity_source_text, unit_price_minor, unit_price_source_text, line_total_minor,
 * line_total_source_text and confidence — and none of them is a product reference. Inventing
 * one from a description, or adding a migration to make room for one, would both be this
 * milestone quietly becoming a different milestone. So a reference is not rendered, because
 * there is no reference to render.
 *
 * There is also nothing here that WRITES. This milestone is read-only evidence: the original
 * OCR values are what a reviewer and every later step work from, and a Sales Staff member
 * cannot amend them. Matching items to Vendor products, excluding a line, confirming and
 * rewarding are all later milestones, and none of them has a representation in this module.
 *
 * ============================================================================
 * ABSENCE IS RENDERED AS ABSENCE
 * ============================================================================
 * A missing quantity does NOT become 1, and a missing price does NOT become 0. Each of the
 * three amounts is null when the reader did not read it, and the row simply omits that fact.
 * A quantity of zero and an amount of zero, on the other hand, are VALUES and are rendered —
 * `0` is what the receipt says and hiding it would be a different receipt.
 */

import { formatMinorAmount } from "./receipt-extraction-display.ts";
import type { LineItemView } from "./receipt-extraction-normalization.ts";

/** The largest quantity worth rendering. Above this a receipt line is not a quantity. */
const MAX_QUANTITY = 1_000_000;

/** One line, reduced to what may be shown. Every field is nullable except the line number. */
export type LineItemDisplay = {
  readonly lineNumber: number;
  /** The read description, or null when the reader did not read one. */
  readonly description: string | null;
  /** A positional label for a line with no description. Never a guessed product name. */
  readonly fallbackLabel: string;
  readonly quantity: string | null;
  readonly unitPrice: string | null;
  readonly lineTotal: string | null;
};

/**
 * Formats a quantity the database stores as `numeric`.
 *
 * NULL STAYS NULL. "If quantity is absent, do not assume 1" is the rule this function
 * exists to keep: there is no fallback branch here at all.
 *
 * Trailing zeros are dropped by JavaScript's own number-to-string conversion, so a stored
 * `2.000` reads as `2` and a stored `1.500` reads as `1.5` — the way a person writes them.
 * An exponent form is refused rather than printed: `1e+21` on a receipt line is not a
 * quantity, and showing it would be showing a fault as data.
 */
export function formatLineItemQuantity(quantity: number | null): string | null {
  if (quantity === null || !Number.isFinite(quantity)) return null;
  if (quantity < 0 || quantity > MAX_QUANTITY) return null;

  const rendered = quantity.toString();
  return /[eE]/.test(rendered) ? null : rendered;
}

/** `Line 3`. A position, not a name — the line number is the backend's own value. */
export function lineItemFallbackLabel(lineNumber: number): string {
  return `Line ${lineNumber}`;
}

/**
 * Reduces one line item to display strings.
 *
 * THE CURRENCY AND ITS SCALE COME FROM THE EXTRACTION, not from this module and not from a
 * locale. Both amounts go through the shared `formatMinorAmount`, which returns null rather
 * than assuming two decimal places — so a JPY line is never shown as if it had cents, and an
 * unresolved scale omits the amount instead of misplacing its point.
 */
export function describeLineItem(
  item: LineItemView,
  currencyCode: string | null,
  currencyMinorUnit: number | null,
): LineItemDisplay {
  return {
    lineNumber: item.lineNumber,
    description: item.description,
    fallbackLabel: lineItemFallbackLabel(item.lineNumber),
    quantity: formatLineItemQuantity(item.quantity),
    unitPrice: formatMinorAmount(item.unitPriceMinor, currencyCode, currencyMinorUnit),
    lineTotal: formatMinorAmount(item.lineTotalMinor, currencyCode, currencyMinorUnit),
  };
}

/**
 * Every line, in the order the RPC returned them.
 *
 * NOTHING IS DROPPED, SORTED OR CAPPED. The RPC already orders by line_number, and a second
 * ordering here could disagree with the database's. There is no `slice`, no `filter` and no
 * "top N": if the reader found nine lines, nine are described, and a line with no readable
 * field at all is still a line the reader found.
 */
export function describeLineItems(
  items: readonly LineItemView[],
  currencyCode: string | null,
  currencyMinorUnit: number | null,
): LineItemDisplay[] {
  return items.map((item) => describeLineItem(item, currencyCode, currencyMinorUnit));
}

/**
 * `4 items detected`.
 *
 * IT COUNTS WHAT WAS RETURNED, never what the paper receipt contained. If the reader found
 * four lines on a five-line receipt, this says four — claiming five would be inventing a line
 * nobody read, and the person checking against the paper is exactly who needs to see the
 * discrepancy.
 */
export function lineItemsDetectedLabel(count: number): string {
  return `${count} item${count === 1 ? "" : "s"} detected`;
}
