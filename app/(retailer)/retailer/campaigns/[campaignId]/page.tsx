import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import {
  getMyRetailerCampaign,
  getMyRetailerCampaignProducts,
} from "@/lib/campaigns/retailer-campaigns";
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import { CalculationEngineNotice, FactTile } from "@/components/campaigns/campaign-facts";
import {
  NoEligibleProductsNotice,
  hasNoEligibleProducts,
} from "@/components/campaigns/no-eligible-products-notice";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SectionCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { BackLink } from "@/components/ui/page-header";
import {
  CalendarIcon,
  CampaignsIcon,
  ProductsIcon,
  RewardIcon,
  UsersIcon,
} from "@/components/ui/icons";
import {
  performanceExplanation,
  performancePlainLabel,
  productResolutionExplanation,
  productResolutionLabel,
  productScopePlainLabel,
  rewardPreviewSentence,
  rewardSummary,
  stackingExplanation,
  stackingLabel,
} from "@/lib/campaigns/campaign-vocabulary";

export const metadata: Metadata = {
  title: "Campaign · Retailer Portal",
  description: "A campaign your Vendor has assigned to your Retailer.",
};

/**
 * ONE assigned campaign, READ-ONLY.
 *
 * ============================================================================
 * WHY THIS ROUTE EXISTS
 * ============================================================================
 * Browser testing found the Retailer campaign cards unopenable — no link, no affordance,
 * nothing to click. The cause was not a broken handler: this route had simply never been
 * built, so there was nowhere for a card to lead. Its read contract already existed and
 * was unused — get_my_retailer_campaign and list_my_retailer_campaign_products are both
 * gated on CAMPAIGNS_VIEW_ASSIGNED and both derive the Retailer from auth.uid().
 *
 * ============================================================================
 * IT IS NOT A VENDOR PAGE WITH THE BUTTONS REMOVED
 * ============================================================================
 * NO MANAGEMENT CONTROL OF ANY KIND. No form, no Server Action import, no lifecycle
 * dialog. Publishing, pausing, resuming, versioning and cancelling are Vendor
 * capabilities behind CAMPAIGNS_MANAGE, which no Retailer role holds — every one of those
 * RPCs refuses this caller in SQL, and none of them is reachable from this file.
 *
 * WHAT IS NEVER RENDERED, because the RPCs do not return it: any other Retailer targeted
 * by the same campaign or a count of them, the Vendor group this Retailer was included
 * through, the eligibility source, the exclusivity key, the priority, the internal
 * version number, the snapshot rows, and any audit metadata. The guarantee is the
 * contract's, not this component's — there is no field here to filter.
 *
 * THE CAMPAIGN ID IN THE URL IS AN ADDRESS, NEVER AN AUTHORIZATION. The RPC re-derives
 * the Retailer from auth.uid() and returns zero rows for a campaign not assigned to them,
 * which is byte-identical to the answer for an id that does not exist. So the route
 * cannot be used to discover which campaigns exist, and a Retailer cannot read another
 * Retailer's campaign by typing its id.
 *
 * AND NO PROGRESS. Every figure is what the campaign OFFERS. Nothing here is units sold,
 * coins earned or a balance, and no field on the types behind it could hold one.
 */

function formatDay(iso: string | null, timeZone: string | null): string {
  if (iso === null) return "—";
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      // The CAMPAIGN's zone, not the reader's: a campaign written as "1 September, Dubai"
      // must read that way to everyone who sees it.
      timeZone: timeZone ?? "UTC",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(instant));
  } catch {
    return "—";
  }
}

export default async function RetailerCampaignDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const access = await getRetailerPortalAccess();

  // The layout has already handled these, but this route is directly addressable and must
  // not depend on that. Fails closed.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }
  if (access.status === "unavailable") {
    throw new Error("Retailer portal context is temporarily unavailable.");
  }

  const { campaignId } = await params;

  const [campaignResult, productsResult] = await Promise.all([
    getMyRetailerCampaign(campaignId),
    getMyRetailerCampaignProducts(campaignId),
  ]);

  // A Retailer Manager, a Sales Staff member, or anyone else without the mapping is
  // refused by the RPC and sent to the same generic denial as every other portal denial.
  if (campaignResult.status === "denied") {
    redirect("/retailer-access-denied");
  }
  // An unknown campaign and one assigned to a different Retailer are the SAME answer,
  // exactly as in SQL.
  if (campaignResult.status === "not-found") {
    notFound();
  }
  if (campaignResult.status !== "ok") {
    throw new Error("Campaign is temporarily unavailable.");
  }

  const campaign = campaignResult.campaign;
  const reward = rewardSummary(campaign.reward);
  const rewardSentence = rewardPreviewSentence({
    ruleType: campaign.reward.ruleType,
    performanceScope: campaign.performanceScope,
    coinsPerUnit: campaign.reward.coinsPerUnit,
    thresholdUnits: campaign.reward.thresholdUnits,
    rewardCoins: campaign.reward.rewardCoins,
    maxRewardCoins: campaign.reward.maxRewardCoins,
  });

  const period = `${formatDay(campaign.startsAt, campaign.timezoneName)} — ${
    campaign.endsAt === null
      ? "no end date"
      : formatDay(campaign.endsAt, campaign.timezoneName)
  }`;

  // The count comes from the campaign read, which the RPC already scoped to this
  // Retailer. The product LIST is a separate read of the same scope.
  const nothingEligible = hasNoEligibleProducts(
    campaign.derivedState,
    campaign.eligibleProductCount,
  );

  return (
    <div className="mx-auto w-full max-w-4xl">
      <BackLink href="/retailer/campaigns">Campaigns</BackLink>

      {/* ================= HEADER ================= */}
      <header className="mt-3">
        <div className="flex flex-wrap items-center gap-2">
          <CampaignStateBadge state={campaign.derivedState} />
          <Badge tone={campaign.stackingMode === "EXCLUSIVE" ? "amber" : "slate"}>
            {stackingLabel(campaign.stackingMode)}
          </Badge>
        </div>

        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
          {campaign.campaignName}
        </h1>

        {/* The Vendor's name IS returned to an Owner and is theirs to see. */}
        {campaign.vendorName && (
          <p className="mt-1 text-sm text-slate-500">from {campaign.vendorName}</p>
        )}

        {campaign.description && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
            {campaign.description}
          </p>
        )}
      </header>

      {/* The warning sits directly ABOVE the offer, so the offer is never read on its own. */}
      {nothingEligible && (
        <NoEligibleProductsNotice
          className="mt-6"
          derivedState={campaign.derivedState}
          productScope={campaign.productScope}
        />
      )}

      {/* ================= THE OFFER ================= */}
      <section className="mt-4 rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
          What this offers
        </h2>
        <p className="mt-1 text-base font-semibold leading-relaxed text-indigo-950">
          {/* A dash, never a guess: an invented reward is a promise nobody made. */}
          {rewardSentence ?? reward ?? "—"}
        </p>
        <p className="mt-1.5 text-sm leading-relaxed text-indigo-900/80">
          {performanceExplanation(campaign.performanceScope)}
        </p>
      </section>

      {/* ================= SUMMARY ================= */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <FactTile
          icon={<RewardIcon className="h-4 w-4" />}
          tone="indigo"
          label="Reward"
          value={reward ?? "—"}
        />
        <FactTile
          icon={<UsersIcon className="h-4 w-4" />}
          label="Measured"
          value={performancePlainLabel(campaign.performanceScope)}
        />
        <FactTile
          icon={<ProductsIcon className="h-4 w-4" />}
          tone={nothingEligible ? "amber" : "slate"}
          label="Eligible products"
          // The real count, preserved. Zero is stated as zero.
          value={`${campaign.eligibleProductCount} ${
            campaign.eligibleProductCount === 1 ? "product" : "products"
          }`}
          detail={productResolutionLabel(campaign.productEligibilityResolution)}
        />
        <FactTile
          icon={<CalendarIcon className="h-4 w-4" />}
          label="Period"
          value={period}
          detail={campaign.timezoneName}
        />
      </div>

      {/* ================= PRODUCTS ================= */}
      <SectionCard
        className="mt-6"
        title="Products that count"
        description={productScopePlainLabel(campaign.productScope)}
      >
        <p className="text-sm leading-relaxed text-slate-700">
          {productResolutionExplanation(campaign.productEligibilityResolution)}
        </p>

        {productsResult.status !== "ok" ? (
          <Alert tone="warning" role="alert" className="mt-4">
            The product list could not be loaded. The campaign itself is unaffected.
          </Alert>
        ) : productsResult.products.length === 0 ? (
          <EmptyState
            className="mt-4"
            icon={<ProductsIcon className="h-6 w-6" />}
            tone="amber"
            title="No products for your Retailer"
            description="Your Vendor decides which products reach your Retailer. This campaign will start counting for you as soon as one of them does."
          />
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-md border-collapse text-left text-sm">
              <caption className="sr-only">
                Products this campaign covers for your Retailer
              </caption>
              <thead className="border-b border-slate-200 text-xs font-medium text-slate-500">
                <tr>
                  <th scope="col" className="px-2 py-2">
                    Product
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Code
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Barcode
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {productsResult.products.map((product) => (
                  <tr key={product.productId}>
                    <td className="px-2 py-2 font-medium text-slate-900">
                      {product.productName}
                      {product.brand && (
                        <span className="ml-1.5 font-normal text-slate-500">
                          {product.brand}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs text-slate-500">
                      {product.productCode}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs text-slate-500">
                      {product.barcode ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* ================= HOW IT COMBINES ================= */}
      <SectionCard
        className="mt-4"
        title="How this campaign combines with others"
        description={stackingLabel(campaign.stackingMode)}
      >
        <p className="text-sm leading-relaxed text-slate-700">
          {/* Deliberately does NOT name the exclusivity key or the priority. Those are the
              Vendor's configuration for how its own campaigns compete, no
              assigned-visibility RPC returns them, and describing the ranking would
              disclose the shape of a portfolio this reader cannot see. */}
          {stackingExplanation(campaign.stackingMode)}
        </p>
      </SectionCard>

      {/* ================= THE HONEST FOOTER ================= */}
      <div className="mt-6 space-y-2">
        <CalculationEngineNotice />
        <p className="flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs leading-relaxed text-slate-600">
          <CampaignsIcon
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400"
            aria-hidden="true"
          />
          <span>
            This page is read-only. Your Vendor sets and changes campaigns; nothing here
            is a sales total or a coin balance.
          </span>
        </p>
      </div>
    </div>
  );
}
