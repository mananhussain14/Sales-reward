import Link from "next/link";
import {
  QUEUE_PARAM,
  type ClaimReviewQueueFilterInputs,
} from "@/lib/review/claim-review-queue-filters";
import { buttonClasses } from "@/components/ui/button";
import { inputClasses as controlInputClasses, Label } from "@/components/ui/field";

/**
 * The queue's filter controls.
 *
 * A PLAIN HTML FORM with `method="get"`, deliberately — no client component, no
 * JavaScript, no Server Action. The whole state of this page already lives in the
 * query string, so a GET form is exactly the right shape: submitting it navigates to
 * a new URL, which re-renders the Server Component with new filters. It works with
 * JavaScript disabled, it makes every filtered view linkable and back-button
 * friendly, and it adds no client bundle.
 *
 * ============================================================================
 * WHY THERE IS NO RETAILER OR SHOP PICKER YET
 * ============================================================================
 * `list_claim_review_queue` types its Retailer and shop parameters as `uuid`, but
 * its RETURN type carries only display names — there is no `retailer_id` or
 * `shop_id` column. So the options for a picker cannot be derived from the queue
 * rows, and no reviewer-authorized function exists that lists the permitted
 * Retailers and shops. Building a picker would need either a database change (out
 * of scope for this milestone) or a Vendor Admin RPC the reviewer must not hold.
 *
 * Rather than ship a control that cannot work, the date filters are complete and the
 * two id filters remain reachable by URL — the parser accepts and validates them,
 * and the RPC keeps them tenant-safe. See the Phase 1C-B document.
 *
 * Cursor parameters are intentionally NOT carried by this form: changing a filter
 * must return to the first page, because a cursor from the previous filter set would
 * point into a different, now-meaningless ordering.
 */
export function QueueFilters({
  inputs,
  hasActiveFilters,
}: {
  inputs: ClaimReviewQueueFilterInputs;
  hasActiveFilters: boolean;
}) {
  return (
    <form
      method="get"
      action="/review"
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
      aria-labelledby="queue-filters-heading"
    >
      <h2
        id="queue-filters-heading"
        className="text-sm font-semibold text-slate-900"
      >
        Filter the queue
      </h2>

      {/* A Retailer or shop id supplied by URL is preserved across a date-filter
          submit, so the two filter kinds compose instead of clearing each other. */}
      {inputs.retailerId ? (
        <input type="hidden" name={QUEUE_PARAM.retailer} value={inputs.retailerId} />
      ) : null}
      {inputs.shopId ? (
        <input type="hidden" name={QUEUE_PARAM.shop} value={inputs.shopId} />
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <div className="space-y-2">
          <Label htmlFor="queue-submitted-from">Submitted from</Label>
          <input
            id="queue-submitted-from"
            name={QUEUE_PARAM.submittedFrom}
            type="date"
            defaultValue={inputs.submittedFromDate ?? ""}
            aria-describedby="queue-date-hint"
            className={controlInputClasses()}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="queue-submitted-to">Submitted to</Label>
          <input
            id="queue-submitted-to"
            name={QUEUE_PARAM.submittedTo}
            type="date"
            defaultValue={inputs.submittedToDate ?? ""}
            aria-describedby="queue-date-hint"
            className={controlInputClasses()}
          />
        </div>

        <div className="flex gap-2 sm:col-span-2 lg:col-span-2 lg:justify-end">
          <button type="submit" className={buttonClasses({ variant: "primary" })}>
            Apply filters
          </button>
          {hasActiveFilters ? (
            <Link href="/review" className={buttonClasses({ variant: "secondary" })}>
              Clear filters
            </Link>
          ) : null}
        </div>
      </div>

      <p id="queue-date-hint" className="mt-3 text-xs text-slate-500">
        Both dates are inclusive and read in UTC, matching the submitted times shown
        below.
      </p>
    </form>
  );
}
