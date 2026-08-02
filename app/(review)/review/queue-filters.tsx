import Link from "next/link";
import {
  QUEUE_PARAM,
  type ClaimReviewQueueFilterInputs,
} from "@/lib/review/claim-review-queue-filters";
import {
  distinctRetailers,
  shopsForRetailer,
  type ClaimReviewFilterOption,
} from "@/lib/review/claim-review-queue";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import {
  inputClasses as controlInputClasses,
  Label,
  selectClasses,
  SelectChevron,
} from "@/components/ui/field";

/**
 * The queue's filter controls: Retailer, shop and a submitted-date range.
 *
 * A PLAIN HTML FORM with `method="get"`, deliberately — no client component, no
 * JavaScript, no Server Action. The whole state of this page already lives in the
 * query string, so a GET form is exactly the right shape: submitting it navigates to
 * a new URL, which re-renders the Server Component with new filters. It works with
 * JavaScript disabled, makes every filtered view linkable and back-button friendly,
 * and adds no client bundle.
 *
 * ============================================================================
 * THE DEPENDENT PAIR, WITHOUT JAVASCRIPT
 * ============================================================================
 * Shop options are already narrowed to the SELECTED Retailer on the server, so the
 * two controls cannot be combined into a pair that matches nothing. Picking a
 * different Retailer and submitting re-renders with that Retailer's shops.
 *
 * The incompatible-shop case is handled where it belongs — in the page's parser,
 * which drops a shop that does not belong to the chosen Retailer before either value
 * reaches the RPC. Doing it there rather than here means a hand-typed URL is
 * corrected too, not just a form submission.
 *
 * NO CURSOR IS CARRIED. Changing any filter must return to the first page: a cursor
 * from the previous filter set points into a different, now-meaningless ordering.
 */
export function QueueFilters({
  inputs,
  options,
  hasActiveFilters,
}: {
  inputs: ClaimReviewQueueFilterInputs;
  /** `null` means the options could not be read — NOT that there are none. */
  options: ClaimReviewFilterOption[] | null;
  hasActiveFilters: boolean;
}) {
  const optionsUnavailable = options === null;
  const safeOptions = options ?? [];
  const retailers = distinctRetailers(safeOptions);
  const shops = shopsForRetailer(safeOptions, inputs.retailerId);

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

      {optionsUnavailable ? (
        // Disabled with retry copy, never an empty picker. An empty <select> and a
        // broken one look identical, and only one of them is true.
        <Alert tone="warning" className="mt-3">
          Retailer and shop filters are temporarily unavailable. Refresh to try
          again — the date filters below still work.
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <div className="space-y-2">
          <Label htmlFor="queue-retailer">Retailer</Label>
          <div className="relative">
            <select
              id="queue-retailer"
              name={QUEUE_PARAM.retailer}
              defaultValue={inputs.retailerId ?? ""}
              disabled={optionsUnavailable}
              className={selectClasses()}
            >
              <option value="">All Retailers</option>
              {retailers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <SelectChevron />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="queue-shop">Shop</Label>
          <div className="relative">
            <select
              id="queue-shop"
              name={QUEUE_PARAM.shop}
              defaultValue={inputs.shopId ?? ""}
              disabled={optionsUnavailable}
              aria-describedby="queue-shop-hint"
              className={selectClasses()}
            >
              <option value="">All shops</option>
              {shops.map((s) => (
                <option key={s.shopId} value={s.shopId}>
                  {s.shopCode ? `${s.shopName} (${s.shopCode})` : s.shopName}
                  {/* The state in text, not colour alone — a deactivated shop can
                      still hold reviewable receipts (decision D7). */}
                  {s.shopStatus !== "ACTIVE" ? ` — ${s.shopStatus.toLowerCase()}` : ""}
                </option>
              ))}
            </select>
            <SelectChevron />
          </div>
        </div>

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
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="submit" className={buttonClasses({ variant: "primary" })}>
          Apply filters
        </button>
        {hasActiveFilters ? (
          <Link href="/review" className={buttonClasses({ variant: "secondary" })}>
            Clear filters
          </Link>
        ) : null}
      </div>

      <p id="queue-shop-hint" className="mt-3 text-xs text-slate-500">
        Choosing a Retailer narrows the shop list to that Retailer.
      </p>
      <p id="queue-date-hint" className="mt-1 text-xs text-slate-500">
        Both dates are inclusive and read in UTC, matching the submitted times shown
        below.
      </p>
    </form>
  );
}
