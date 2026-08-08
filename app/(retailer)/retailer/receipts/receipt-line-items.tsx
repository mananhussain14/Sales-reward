"use client";

import {
  EXTRACTION_ITEMS_READ_ONLY_NOTE,
  EXTRACTION_ITEMS_TITLE,
} from "@/app/(retailer)/retailer/receipts/extraction-panel-state";
import {
  lineItemsDetectedLabel,
  type LineItemDisplay,
} from "@/lib/receipts/receipt-line-item-view";

/**
 * The extracted line items, rendered.
 *
 * ============================================================================
 * IT IS A LIST, NOT A FORM. DELIBERATELY, AND STRUCTURALLY.
 * ============================================================================
 * There is no <input>, <select>, <textarea>, <button>, contentEditable or change handler
 * anywhere in this file, and lib/receipts/receipt-line-item-safety.test.ts fails the build if
 * one appears. That is the whole business rule made physical: Sales Staff do not edit receipt
 * facts. What the reader read is EVIDENCE — a reviewer, the product matching that comes later,
 * and every reward derived from it all work from these values, so a submitter who could amend
 * them could amend the basis of their own reward.
 *
 * Matching a line to a Vendor product, excluding an unrelated line, confirming, approving and
 * calculating coins are all later milestones. None of them has a control here, because none of
 * them exists yet.
 *
 * ============================================================================
 * EVERY LINE RETURNED IS RENDERED
 * ============================================================================
 * The array is mapped whole. There is no slice, no "show more", no truncation and no filter
 * that could drop a line for having no description or no price: a line the reader found is a
 * line the person needs to see, and a list that quietly shows eight of nine would be worse
 * than showing none, because it looks complete.
 *
 * ============================================================================
 * NOTHING IS INVENTED TO FILL A GAP
 * ============================================================================
 * A field the reader did not read is OMITTED rather than defaulted. No quantity becomes 1, no
 * missing price becomes 0.00, and there is no reference or SKU line at all —
 * list_my_receipt_extraction_line_items has no such column, so there is nothing to render.
 * Zero, on the other hand, is a value and is shown: `AED 0.00` is what some receipt lines say.
 */

type ReceiptLineItemsProps = {
  /** Already reduced to display strings by @/lib/receipts/receipt-line-item-view. */
  readonly items: readonly LineItemDisplay[];
};

const dtClasses = "text-xs font-medium text-slate-500";
const ddClasses = "text-sm font-semibold text-slate-900";

export function ReceiptLineItems({ items }: ReceiptLineItemsProps) {
  if (items.length === 0) return null;

  return (
    <section className="mt-4" aria-labelledby="extracted-items-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4
          id="extracted-items-heading"
          className="text-sm font-semibold text-slate-900"
        >
          {EXTRACTION_ITEMS_TITLE}
        </h4>
        {/* The count of what was RETURNED, never a claim about the paper receipt. */}
        <p className="text-xs font-medium text-slate-500">
          {lineItemsDetectedLabel(items.length)}
        </p>
      </div>

      <ul className="mt-2 flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.lineNumber}
            className="rounded-xl border border-emerald-200/70 bg-white/70 p-3"
          >
            {/* The description when the reader read one; otherwise the line's own position.
                `Line 3` is the backend's line_number, not a guessed product name. */}
            <p className="text-sm font-medium text-slate-900">
              {item.description ?? (
                <span className="text-slate-500">{item.fallbackLabel}</span>
              )}
            </p>

            <dl className="mt-1.5 flex flex-wrap items-baseline gap-x-5 gap-y-1">
              {item.quantity !== null && (
                <div className="flex items-baseline gap-1.5">
                  <dt className={dtClasses}>Qty</dt>
                  <dd className={ddClasses}>{item.quantity}</dd>
                </div>
              )}
              {item.unitPrice !== null && (
                <div className="flex items-baseline gap-1.5">
                  <dt className={dtClasses}>Unit</dt>
                  <dd className={ddClasses}>{item.unitPrice}</dd>
                </div>
              )}
              {item.lineTotal !== null && (
                <div className="flex items-baseline gap-1.5">
                  <dt className={dtClasses}>Amount</dt>
                  <dd className={ddClasses}>{item.lineTotal}</dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs text-slate-500">{EXTRACTION_ITEMS_READ_ONLY_NOTE}</p>
    </section>
  );
}
