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
  progressAriaLabel,
  progressByCampaignId,
  progressPercent,
  progressScopeExplanation,
  progressScopeLabel,
  targetStatement,
} from "@/lib/earnings/earnings-presentation";
import {
  formatCoins,
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
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cardClasses } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { BackLink, PageHeader, SectionHeader } from "@/components/ui/page-header";
import { ProgressBar } from "@/components/ui/progress-bar";
import { ProductsIcon } from "@/components/ui/icons";

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
  const statement = targetStatement(progress);

  return (
    <section className={cardClasses("standard", "p-5")}>
      <SectionHeader
        title={progressScopeLabel(progress.performanceScope)}
        description={progressScopeExplanation(progress.performanceScope)}
      />
      <div className="mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-slate-600">Progress towards target</span>
          <span className="text-sm tabular-nums text-slate-700">
            {formatUnits(progress.progressUnits)} of{" "}
            {formatUnits(progress.targetUnits)} units
          </span>
        </div>
        <ProgressBar
          className="mt-2"
          percent={progressPercent(progress)}
          label={progressAriaLabel(progress)}
          valueNow={progress.progressUnits}
          valueMax={progress.targetUnits}
          tone={statement.tone}
        />
        <div className="mt-3">
          <Badge tone={statement.tone}>{statement.label}</Badge>
        </div>
        <p className="mt-2 text-sm text-slate-600">{statement.detail}</p>
      </div>
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

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <BackLink href="/retailer/my-campaigns">Back to current campaigns</BackLink>

      <PageHeader
        eyebrow="Campaign"
        title={campaign.campaignName}
        description={campaign.description ?? undefined}
        actions={<CampaignStateBadge state={campaign.derivedState} />}
      />

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
              {formatCoins(campaign.reward.coinsPerUnit)}
            </Fact>
          )}
          {campaign.reward.thresholdUnits !== null && (
            <Fact label="Target">
              {formatUnits(campaign.reward.thresholdUnits)} units
            </Fact>
          )}
          {campaign.reward.rewardCoins !== null && (
            <Fact label="Target bonus">
              {formatCoins(campaign.reward.rewardCoins)} coins
            </Fact>
          )}
          {campaign.reward.maxRewardCoins !== null && (
            <Fact label="Maximum reward">
              {formatCoins(campaign.reward.maxRewardCoins)} coins
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
        </dl>
      </section>

      {progress !== undefined && <TargetProgressPanel progress={progress} />}

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
    </div>
  );
}
