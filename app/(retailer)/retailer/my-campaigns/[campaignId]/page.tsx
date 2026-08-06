import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import {
  getMyStaffCampaign,
  listMyStaffCampaignProducts,
} from "@/lib/campaigns/staff-campaigns";
import { getMyCampaignTargetProgress } from "@/lib/earnings/staff-earnings";
import type { CampaignTargetProgress } from "@/lib/earnings/earnings-normalization";
import {
  CAMPAIGNS_UNAVAILABLE_MESSAGE,
  NO_PRODUCTS_MESSAGE,
  formatEarningsDate,
  formatUnits,
  progressByCampaignId,
} from "@/lib/earnings/earnings-presentation";
import {
  // ALIASED DELIBERATELY. The campaign vocabulary's formatCoins ALREADY appends the
  // unit and pluralises it ("1 coin" / "500 coins"), while formatUnits imported above
  // from earnings-presentation returns bare grouped digits ("500"). Two functions with
  // the same name and different contracts is what produced "500 coins coins" here, so
  // the one that carries its own unit now says so at every call site.
  formatCoins as formatCoinsWithUnit,
  performanceExplanation,
  performancePlainLabel,
  productResolutionExplanation,
  productResolutionLabel,
  productScopePlainLabel,
  rewardSummary,
  ruleTypeExplanation,
  ruleTypeLabel,
  stackingExplanation,
  stackingLabel,
} from "@/lib/campaigns/campaign-vocabulary";
import Link from "next/link";
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import { TargetProgress } from "@/components/sales-staff/target-progress";
import { CampaignQualifiers, RewardTypeIcon } from "@/components/sales-staff/campaign-visuals";
import { AddReceiptAction } from "@/components/sales-staff/add-receipt";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { cardClasses } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { BackLink, SectionHeader } from "@/components/ui/page-header";
import { FeatureCard, IconDisc, Reveal, SoftBackdrop } from "@/components/ui/surfaces";
import {
  ArrowUpRightIcon,
  ClockIcon,
  ProductsIcon,
  RewardIcon,
} from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Campaign · Retailer Portal",
  description: "Campaign rules and the products that qualify.",
};

/**
 * One campaign, as a Sales Staff member sees it.
 *
 * ============================================================================
 * A MISSING CAMPAIGN AND SOMEONE ELSE'S CAMPAIGN ARE THE SAME ANSWER
 * ============================================================================
 * get_my_staff_campaign() returns ZERO ROWS for an unknown id, another Retailer's
 * campaign, a draft, a paused or ended campaign and a campaign whose frozen snapshot
 * does not name this Retailer — all of them identically. This page renders notFound()
 * for that single answer and does not branch on why, so the route cannot be used to
 * discover which campaigns exist.
 *
 * The id in the URL is a CAMPAIGN id, not a version id: Migration 30 keys on
 * p_campaign_id and resolves the in-force published version in SQL.
 */

const thClasses =
  "px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500";
const tdClasses = "px-5 py-3.5 text-sm text-slate-600";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 text-sm break-words text-slate-800">{children}</dd>
    </div>
  );
}

function TargetProgressPanel({ progress }: { progress: CampaignTargetProgress }) {
  return (
    <section className={cardClasses("standard", "p-5 sm:p-6")}>
      <SectionHeader title="Target progress" />
      <div className="mt-5">
        <TargetProgress
          progress={progress}
          variant="detail"
          idSuffix={`-detail-${progress.campaignId}`}
        />
      </div>
    </section>
  );
}

/**
 * What a seller actually has to do, in the order it happens on a shop floor.
 *
 * A numbered restatement of the eligibility, reward and scope rules the cards above
 * already carry as labels. It invents nothing: every line is one of the shared
 * vocabulary's explanations, which the Vendor surfaces render from the same source.
 */
function WhatYouNeedToDo({
  steps,
}: {
  steps: string[];
}) {
  return (
    <section className={cardClasses("standard", "p-5 sm:p-6")}>
      <SectionHeader title="What you need to do" />
      <ol className="mt-4 flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-semibold text-indigo-700"
            >
              {index + 1}
            </span>
            <p className="text-sm text-slate-700">{step}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default async function StaffCampaignDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const access = await getRetailerPortalAccess();

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

  // Concurrent: the product and progress reads do not depend on the campaign read's
  // result, and SQL authorizes each of them independently anyway.
  const [campaignResult, productsResult, progressResult] = await Promise.all([
    getMyStaffCampaign(campaignId),
    listMyStaffCampaignProducts(campaignId),
    getMyCampaignTargetProgress(),
  ]);

  if (campaignResult.status === "denied") {
    redirect("/retailer-access-denied");
  }

  if (campaignResult.status === "not-found") {
    notFound();
  }

  if (campaignResult.status === "unavailable") {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <BackLink href="/retailer/my-campaigns">Back to current campaigns</BackLink>
        <Alert tone="warning" role="alert" title="Campaign unavailable">
          {CAMPAIGNS_UNAVAILABLE_MESSAGE}
        </Alert>
      </div>
    );
  }

  const { campaign } = campaignResult;
  const summary = rewardSummary(campaign.reward);

  const progress =
    progressResult.status === "ok"
      ? progressByCampaignId(progressResult.progress).get(campaign.campaignId)
      : undefined;

  const isSnapshot = campaign.productEligibilityResolution === "SNAPSHOT";

  /**
   * The steps, restated from the shared vocabulary. Order matters: a sale happens, then
   * it is verified, then the campaign is evaluated.
   */
  const steps = [
    productScopePlainLabel(campaign.productScope) +
      (isSnapshot
        ? " — the list below was frozen when this campaign was published."
        : " — the list below can change, because eligibility is checked when a sale is verified."),
    performanceExplanation(campaign.performanceScope),
    campaign.reward.ruleType === null
      ? "This campaign's reward rule is not available."
      : ruleTypeExplanation(campaign.reward.ruleType),
    stackingExplanation(campaign.stackingMode),
  ];

  return (
    <SoftBackdrop>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <BackLink href="/retailer/my-campaigns">Back to current campaigns</BackLink>

      {/* ---- Hero ---------------------------------------------------------
          Re-recognises the campaign from the list: the same disc tone, the same
          status pill, and the reward sentence a seller came to read. */}
      <Reveal>
        <FeatureCard tone={progress?.targetReached ? "emerald" : "indigo"} className="p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">
              Campaign
            </p>
            <CampaignStateBadge state={campaign.derivedState} />
          </div>

          <h1 className="mt-2 text-2xl font-semibold tracking-tight break-words text-slate-900">
            {campaign.campaignName}
          </h1>
          {campaign.description !== null && (
            <p className="mt-2 max-w-2xl text-sm break-words text-slate-600">
              {campaign.description}
            </p>
          )}

          {summary !== null && (
            <div className="mt-5 flex items-start gap-3 rounded-2xl bg-white/70 px-4 py-3">
              <IconDisc
                tone={progress?.targetReached ? "emerald" : "indigo"}
                size={40}
                icon={<RewardIcon className="h-5 w-5" />}
              />
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500">Reward</p>
                <p className="text-lg font-semibold tracking-tight text-slate-900">
                  {summary}
                </p>
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {campaign.reward.ruleType !== null && (
              <Badge tone="indigo" icon={<RewardTypeIcon campaign={campaign} />}>
                {ruleTypeLabel(campaign.reward.ruleType)}
              </Badge>
            )}
          </div>

          <CampaignQualifiers
            campaign={campaign}
            className="mt-3 flex flex-wrap gap-1.5"
          />
        </FeatureCard>
      </Reveal>

      {/* ---- The offer ---------------------------------------------------- */}
      <section className={cardClasses("standard", "p-5")}>
        <SectionHeader
          title="How this campaign rewards"
          description={
            campaign.reward.ruleType === null
              ? undefined
              : ruleTypeExplanation(campaign.reward.ruleType)
          }
        />
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          {campaign.reward.ruleType !== null && (
            <Fact label="Reward rule">{ruleTypeLabel(campaign.reward.ruleType)}</Fact>
          )}
          {summary !== null && <Fact label="Reward">{summary}</Fact>}
          {campaign.reward.coinsPerUnit !== null && (
            <Fact label="Coins per unit">
              {formatCoinsWithUnit(campaign.reward.coinsPerUnit)}
            </Fact>
          )}
          {campaign.reward.thresholdUnits !== null && (
            <Fact label="Target">
              {formatUnits(campaign.reward.thresholdUnits)} units
            </Fact>
          )}
          {/* No literal " coins" after these two: the formatter supplies it, and
              supplying it twice is exactly the defect this fixes. */}
          {campaign.reward.rewardCoins !== null && (
            <Fact label="Target bonus">
              {formatCoinsWithUnit(campaign.reward.rewardCoins)}
            </Fact>
          )}
          {campaign.reward.maxRewardCoins !== null && (
            <Fact label="Maximum reward">
              {formatCoinsWithUnit(campaign.reward.maxRewardCoins)}
            </Fact>
          )}
          <Fact label="Counts towards">
            {performancePlainLabel(campaign.performanceScope)}
          </Fact>
          {campaign.rewardRecipientScope !== null && (
            <Fact label="Rewarded to">The staff member whose sale qualified</Fact>
          )}
        </dl>
        <p className="mt-4 text-sm text-slate-600">
          {performanceExplanation(campaign.performanceScope)}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          {stackingExplanation(campaign.stackingMode)}
        </p>
      </section>

      {/* ---- When it runs -------------------------------------------------- */}
      <section className={cardClasses("standard", "p-5")}>
        <SectionHeader title="When it runs" />
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <Fact label="Starts">{formatEarningsDate(campaign.startsAt) ?? "—"}</Fact>
          <Fact label="Ends">{formatEarningsDate(campaign.endsAt) ?? "—"}</Fact>
          <Fact label="Stacking">{stackingLabel(campaign.stackingMode)}</Fact>
          {campaign.timezoneName !== null && (
            <Fact label="Campaign time zone">{campaign.timezoneName}</Fact>
          )}
        </dl>

        {/* Dates above are rendered in UTC; the campaign's own period is evaluated in
            the zone below. Saying so is what keeps "starts 6 Jun" from being read as a
            promise about the reader's local midnight. */}
        <p className="mt-4 flex items-start gap-2 text-xs text-slate-500">
          <ClockIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Dates are shown in UTC.
            {campaign.timezoneName !== null
              ? ` This campaign's period is evaluated in ${campaign.timezoneName}.`
              : ""}
          </span>
        </p>
      </section>

      {progress !== undefined && (
        <Reveal index={1}>
          <TargetProgressPanel progress={progress} />
        </Reveal>
      )}

      <Reveal index={2}>
        <WhatYouNeedToDo steps={steps} />
      </Reveal>

      {progressResult.status === "unavailable" && (
        <Alert tone="warning" role="status" title="Target progress unavailable">
          Campaign details are shown, but progress towards the target could not be
          loaded. Try again in a moment.
        </Alert>
      )}

      {/* ---- Eligible products --------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Eligible products"
          description={productScopePlainLabel(campaign.productScope)}
        />

        {/* THE SNAPSHOT / LIVE_TEMPORAL DISTINCTION, said explicitly. A reader who
            cannot tell them apart cannot read the list below correctly: one is a
            promise, the other is a current best guess. */}
        <Alert
          tone="info"
          role="status"
          title={
            isSnapshot
              ? "Published campaign product selection"
              : "Eligibility checked at sale time"
          }
        >
          <p>{productResolutionExplanation(campaign.productEligibilityResolution)}</p>
          <p className="mt-2">
            {isSnapshot
              ? "This campaign uses the product list captured when it was published, so it does not change while the campaign runs."
              : "Whether a product finally qualifies depends on its status and your Retailer's assignment at the moment the sale is verified, so this list can change."}
          </p>
        </Alert>

        <div className="flex flex-wrap gap-2">
          <Badge tone="slate">
            {productResolutionLabel(campaign.productEligibilityResolution)}
          </Badge>
        </div>

        {productsResult.status !== "ok" ? (
          <Alert tone="warning" role="alert" title="Products unavailable">
            {CAMPAIGNS_UNAVAILABLE_MESSAGE}
          </Alert>
        ) : productsResult.products.length === 0 ? (
          <EmptyState
            icon={<ProductsIcon className="h-6 w-6" />}
            title="No products listed"
            description={NO_PRODUCTS_MESSAGE}
          />
        ) : (
          <>
            {/* Wide screens: the table the portal already uses elsewhere. */}
            <div
              className={cardClasses("standard", "hidden overflow-x-auto sm:block")}
            >
              <table className="w-full min-w-[32rem] border-collapse">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr>
                    <th className={thClasses} scope="col">
                      Product
                    </th>
                    <th className={thClasses} scope="col">
                      Code
                    </th>
                    <th className={thClasses} scope="col">
                      Barcode
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {/* The database's order is preserved — nothing here re-sorts. */}
                  {productsResult.products.map((product) => (
                    <tr key={product.productId}>
                      <td className={tdClasses}>
                        <span className="font-medium break-words text-slate-800">
                          {product.productName}
                        </span>
                        {product.brand !== null && (
                          <span className="block text-xs text-slate-500">
                            {product.brand}
                          </span>
                        )}
                      </td>
                      <td className={`${tdClasses} font-mono text-xs`}>
                        {product.productCode}
                      </td>
                      <td className={`${tdClasses} font-mono text-xs`}>
                        {product.barcode ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Narrow screens: cards, same order, same fields. */}
            <ul className="flex flex-col gap-3 sm:hidden">
              {productsResult.products.map((product) => (
                <li
                  key={product.productId}
                  className={cardClasses("standard", "p-4")}
                >
                  <p className="font-medium break-words text-slate-800">
                    {product.productName}
                  </p>
                  {product.brand !== null && (
                    <p className="text-xs text-slate-500">{product.brand}</p>
                  )}
                  <p className="mt-2 font-mono text-xs text-slate-600">
                    {product.productCode}
                  </p>
                  {product.barcode !== null && (
                    <p className="font-mono text-xs text-slate-500">
                      {product.barcode}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ---- The way to what this campaign has already paid ------------------
          Offered to a SELLER only. This whole route is gated on the Sales Staff
          portal kind, and STAFF_EARNINGS_VIEW is mapped to SALES_STAFF alone, so
          there is no other reader to withhold it from. */}
      <section
        className={cardClasses(
          "standard",
          "flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6",
        )}
      >
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">
            Rewards you have already earned
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Rewards from this campaign are listed with the rest of your reward history.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-3">
          <AddReceiptAction compact />
          <Link
            href="/retailer/my-earnings"
            className={buttonClasses({ variant: "outline" })}
          >
            My campaign earnings
            <ArrowUpRightIcon className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </section>
      </div>
    </SoftBackdrop>
  );
}
