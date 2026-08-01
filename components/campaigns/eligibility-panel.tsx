"use client";

import { cn } from "@/components/ui/cn";
import { AlertTriangleIcon, CheckCircleIcon } from "@/components/ui/icons";
import type { PublicationPreviewRow } from "@/lib/campaigns/campaign-normalization";
import {
  classifyPublicationEligibility,
  publicationEligibilityCopy,
  type ProductScope,
} from "@/lib/campaigns/campaign-vocabulary";

/**
 * The product / Retailer eligibility panel.
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHY ITS WORDING WAS CHECKED AGAINST THE DATABASE
 * ============================================================================
 * The previous surface showed one sentence — "Some Retailers are missing selected
 * products" — followed by "Publishing will include only the products actually assigned to
 * each Retailer". That is true for one of the two outcomes and silent about the other, and
 * it never told an operator the consequence that actually matters.
 *
 * public.publish_vendor_campaign freezes one row per (eligible Retailer, ACTIVE
 * assignment) pair and raises `object_not_in_prerequisite_state` ONLY when that whole set
 * is empty. So:
 *
 *   PARTIAL   at least one pair resolves — publication SUCCEEDS. Every targeted Retailer
 *             is still frozen into the audience, including any that matched no product at
 *             all, and such a Retailer is in the campaign with nothing it can earn on.
 *             That is the fact this panel leads with.
 *   BLOCKED   no pair resolves anywhere — publication is REFUSED outright.
 *
 * Both branches were confirmed against the hosted development database before this copy
 * was written. The classification itself lives in the pure vocabulary module so it is
 * covered by unit tests rather than asserted here.
 *
 * WHICH products are missing for a given Retailer is deliberately NOT claimed:
 * preview_vendor_campaign_publication returns counts, not the per-Retailer product
 * breakdown, and inventing one on the client would be a second implementation of the
 * resolution rule — free to disagree with the database it is describing. Counts are exact;
 * the panel says only what it can prove.
 */

export function EligibilityPanel({
  rows,
  productScope,
  selectedProductCount,
  onReviewProducts,
  onChangeAudience,
  className,
}: {
  rows: PublicationPreviewRow[];
  productScope: ProductScope | null;
  /** How many products the operator picked, so "3 of 5" can be stated exactly. */
  selectedProductCount: number;
  /** Jumps to the product step. Omitted where there is no step to jump to. */
  onReviewProducts?: () => void;
  onChangeAudience?: () => void;
  className?: string;
}) {
  const eligibility = classifyPublicationEligibility(rows, productScope);
  const copy = publicationEligibilityCopy(eligibility);

  // Nothing to warn about: either everything resolves, or this campaign resolves live and
  // has no frozen pairs to be missing in the first place.
  if (copy === null) {
    if (rows.length === 0) return null;
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4",
          className,
        )}
      >
        <CheckCircleIcon
          className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600"
          aria-hidden="true"
        />
        <div className="min-w-0 text-sm">
          <p className="font-semibold text-emerald-900">
            Every targeted Retailer resolves
          </p>
          <p className="mt-0.5 text-emerald-800">
            {rows.length} {rows.length === 1 ? "Retailer" : "Retailers"} would be included
            if you published now.
          </p>
        </div>
      </div>
    );
  }

  const blocked = eligibility === "BLOCKED";
  const affected = rows.filter((row) => row.missingProductCount > 0);

  return (
    <section
      // Blocked is a refusal the operator must act on, so it is announced; partial is
      // advisory and is not, to avoid interrupting on every keystroke of a wizard step.
      role={blocked ? "alert" : undefined}
      className={cn(
        "overflow-hidden rounded-xl border",
        blocked ? "border-red-300 bg-red-50/50" : "border-amber-300 bg-amber-50/50",
        className,
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <AlertTriangleIcon
          className={cn(
            "mt-0.5 h-5 w-5 shrink-0",
            blocked ? "text-red-600" : "text-amber-600",
          )}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <h3
            className={cn(
              "text-sm font-semibold",
              blocked ? "text-red-900" : "text-amber-900",
            )}
          >
            {copy.title}
          </h3>
          <p
            className={cn(
              "mt-1 text-sm leading-relaxed",
              blocked ? "text-red-800" : "text-amber-900/90",
            )}
          >
            {copy.body}
          </p>
        </div>
      </div>

      {affected.length > 0 && (
        <div className="border-t border-white/60 bg-white/70 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Affected Retailers
          </p>
          <ul className="mt-2 space-y-1.5">
            {affected.map((row) => {
              const none = row.eligibleProductCount === 0;
              return (
                <li
                  key={row.vendorRetailerId}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm"
                >
                  <span className="font-medium text-slate-900">{row.retailerName}</span>
                  <span
                    className={cn(
                      "text-xs font-medium",
                      none ? "text-red-700" : "text-amber-800",
                    )}
                  >
                    {row.eligibleProductCount} of {selectedProductCount} selected products
                    assigned
                    {none && " — nothing to earn on"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {(onReviewProducts || onChangeAudience) && (
        <div className="flex flex-wrap gap-2 border-t border-white/60 bg-white/70 px-4 py-3">
          {onReviewProducts && (
            <button
              type="button"
              onClick={onReviewProducts}
              className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              Review products
            </button>
          )}
          {onChangeAudience && (
            <button
              type="button"
              onClick={onChangeAudience}
              className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              Change audience
            </button>
          )}
        </div>
      )}
    </section>
  );
}
