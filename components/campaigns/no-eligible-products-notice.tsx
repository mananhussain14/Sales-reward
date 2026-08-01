import { cn } from "@/components/ui/cn";
import { AlertTriangleIcon } from "@/components/ui/icons";
import type {
  CampaignState,
  ProductScope,
} from "@/lib/campaigns/campaign-vocabulary";

/**
 * The warning a Retailer sees when a campaign that is running — or about to — currently
 * covers none of their products.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Browser testing found an ACTIVE campaign presenting a large, confident reward offer
 * beside a quiet "0 products". Every figure on the card was correct, and the card as a
 * whole still told the Retailer the wrong thing: it advertised coins they cannot earn.
 * A count of zero is not a small number — it is a different state — and it has to be
 * stated, not left to be inferred from a numeral in a supporting row.
 *
 * ============================================================================
 * WHAT IT IS CAREFUL NOT TO SAY
 * ============================================================================
 *   * NOT "this campaign is broken". It is configured exactly as the Vendor intended;
 *     the Retailer simply has none of the products it covers.
 *   * NOT anything the reader can act on themselves. Product assignment is a Vendor
 *     capability and no Retailer role holds it, so an instruction here would send them
 *     looking for a control that does not exist for them.
 *   * NOT a hidden campaign. The campaign stays visible with its real product count of
 *     zero — suppressing it would leave an unexplained gap in a list the Vendor can see.
 *
 * MEANING IS NEVER CARRIED BY COLOUR: the amber surface is accompanied by a warning icon
 * and by the sentence itself, so the state survives greyscale, colour blindness and a
 * screen reader.
 *
 * A Server Component. It renders a decision the caller already made and computes nothing.
 */

/** The approved sentence, defined once so the list and the detail page cannot diverge. */
export const NO_ELIGIBLE_PRODUCTS_MESSAGE =
  "No eligible products are currently assigned to your Retailer for this campaign. Sales cannot earn coins until an eligible product is available.";

/**
 * Whether the warning applies.
 *
 * ONLY for a campaign that is running or about to run. A paused, ended or cancelled
 * campaign earns nothing regardless of its product coverage, so the warning would be
 * noise there and would imply a problem where the state already explains itself.
 *
 * The count is whatever the read contract returned for THIS Retailer — the RPC scopes it
 * to the caller's own Retailer, and nothing here recomputes eligibility.
 */
export function hasNoEligibleProducts(
  derivedState: CampaignState,
  eligibleProductCount: number,
): boolean {
  if (derivedState !== "ACTIVE" && derivedState !== "SCHEDULED") return false;
  return eligibleProductCount === 0;
}

export function NoEligibleProductsNotice({
  derivedState,
  productScope,
  className,
}: {
  derivedState: CampaignState;
  /**
   * Only used to word the second line. It changes what the Retailer should expect next,
   * not whether the warning applies.
   */
  productScope: ProductScope;
  className?: string;
}) {
  const scheduled = derivedState === "SCHEDULED";

  return (
    <div
      // `alert` would interrupt a screen reader on every card in a list. `status` places
      // it in the reading order with its heading intact, which is what a standing fact
      // about a campaign needs.
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3.5",
        className,
      )}
    >
      <AlertTriangleIcon
        className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-sm font-semibold text-amber-900">
          {scheduled
            ? "Nothing to earn on when this starts"
            : "Nothing to earn on right now"}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-amber-900/90">
          {NO_ELIGIBLE_PRODUCTS_MESSAGE}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-amber-800">
          {productScope === "ALL_ELIGIBLE_PRODUCTS"
            ? "This campaign covers whatever your Vendor has assigned to you at the time of each sale, so it will start counting as soon as they assign one."
            : "This campaign covers a fixed list of products chosen when it was published. Your Vendor assigns which of them reach your Retailer."}
        </p>
      </div>
    </div>
  );
}
