import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import {
  getMyCampaignEarningsSummary,
  getMyCampaignRewards,
} from "@/lib/earnings/staff-earnings";
import type { CampaignRewardEntry } from "@/lib/earnings/earnings-normalization";
import {
  EARNINGS_UNAVAILABLE_MESSAGE,
  NOT_A_WALLET_NOTICE,
  NO_REWARDS_MESSAGE,
  REWARDS_PAGE_SIZE,
  capReduction,
  formatCoins,
  formatEarningsDate,
  formatEarningsTimestamp,
  formatUnits,
  nextRewardCursor,
  parseRewardCursor,
  receiptReference,
  rewardCursorHref,
  rewardRuleLabel,
} from "@/lib/earnings/earnings-presentation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cardClasses } from "@/components/ui/card";
import { DetailStat } from "@/components/ui/detail-stat";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import {
  CalendarIcon,
  CampaignsIcon,
  ReceiptIcon,
  RewardIcon,
  TrendingUpIcon,
} from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "My campaign earnings · Retailer Portal",
  description: "Campaign rewards earned from your verified sales.",
};

/**
 * What the signed-in Sales Staff member has EARNED.
 *
 * ============================================================================
 * THIS IS NOT A WALLET, AND THE PAGE SAYS SO
 * ============================================================================
 * Every figure is a stored campaign_rewards amount or a sum SQL performed over them.
 * Nothing here is a balance, an available amount, a redeemable amount or a payout, no
 * heading or label uses any of those words, and a visible notice states that wallet and
 * redemption features do not exist yet. Saying nothing would invite a seller to assume
 * the number is spendable.
 *
 * ============================================================================
 * NOTHING IS CALCULATED
 * ============================================================================
 * No coin figure on this page is derived. `capReduction` subtracts two values the
 * database stored on the SAME row, purely to label a difference already visible in both.
 *
 * ============================================================================
 * A FAILED SECOND PAGE DOES NOT DESTROY THE FIRST
 * ============================================================================
 * The summary and the history are separate reads with separate outcomes. A history
 * failure leaves the totals rendered and reports only the history; a summary failure
 * leaves the history rendered. Clearing good data because an unrelated read failed would
 * make the page look like the rewards had gone.
 */

const thClasses =
  "px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500";
const tdClasses = "px-5 py-3.5 text-sm text-slate-600";

/** The reward amount, plus the cap explanation when a cap visibly bit. */
function RewardAmount({ reward }: { reward: CampaignRewardEntry }) {
  const reduction = capReduction(reward);

  return (
    <div>
      <span className="font-semibold tabular-nums text-slate-900">
        {formatCoins(reward.rewardCoins)} coins
      </span>
      {reduction !== null && reward.coinsUncapped !== null && (
        <span className="mt-1 block text-xs text-amber-700">
          {/* Both stored values are shown. The reduction is labelled, never presented
              as remaining headroom — the accumulator is not readable here and its
              headroom is nobody's business on this screen. */}
          Reduced by the campaign maximum: {formatCoins(reward.coinsUncapped)} earned,{" "}
          {formatCoins(reduction)} above the cap.
        </span>
      )}
    </div>
  );
}

/** The rule-specific detail line. Per-unit and target bonus read differently. */
function RewardBasis({ reward }: { reward: CampaignRewardEntry }) {
  if (reward.ruleType === "TARGET_BONUS") {
    return (
      <span className="text-xs text-slate-500">
        {reward.thresholdUnits === null
          ? "Target bonus"
          : `Target of ${formatUnits(reward.thresholdUnits)} units`}
        {reward.configuredRewardCoins !== null &&
          ` · bonus ${formatCoins(reward.configuredRewardCoins)}`}
      </span>
    );
  }

  return (
    <span className="text-xs text-slate-500">
      {formatUnits(reward.qualifyingUnits)}{" "}
      {reward.qualifyingUnits === 1 ? "unit" : "units"}
      {reward.coinsUncapped !== null &&
        ` · ${formatCoins(reward.coinsUncapped)} before any cap`}
    </span>
  );
}

function RewardRows({ rewards }: { rewards: CampaignRewardEntry[] }) {
  return (
    <>
      {/* Wide screens: the responsive table pattern the portal already uses. */}
      <div className={cardClasses("standard", "hidden overflow-x-auto lg:block")}>
        <table className="w-full min-w-[52rem] border-collapse">
          <thead className="border-b border-slate-200 bg-slate-50">
            <tr>
              <th className={thClasses} scope="col">
                Campaign
              </th>
              <th className={thClasses} scope="col">
                Sale
              </th>
              <th className={thClasses} scope="col">
                Receipt
              </th>
              <th className={thClasses} scope="col">
                Qualifying
              </th>
              <th className={thClasses} scope="col">
                Earned
              </th>
              <th className={thClasses} scope="col">
                Awarded
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rewards.map((reward) => (
              <tr key={reward.rewardId}>
                <td className={tdClasses}>
                  <span className="font-medium break-words text-slate-800">
                    {reward.campaignName ?? "Campaign"}
                  </span>
                  <span className="mt-1 block">
                    <Badge tone="slate">{rewardRuleLabel(reward.ruleType)}</Badge>
                  </span>
                </td>
                <td className={tdClasses}>
                  {formatEarningsDate(reward.saleAt) ?? "—"}
                  {reward.shopName !== null && (
                    <span className="block text-xs text-slate-500">
                      {reward.shopName}
                    </span>
                  )}
                </td>
                {/* The receipt REFERENCE, not the id, and never a verified sale id. */}
                <td className={`${tdClasses} font-mono text-xs`}>
                  {receiptReference(reward.receiptSubmissionId)}
                </td>
                <td className={tdClasses}>
                  <span className="tabular-nums">
                    {formatUnits(reward.qualifyingUnits)} units
                  </span>
                  <span className="block text-xs text-slate-500">
                    {formatUnits(reward.qualifyingItemCount)}{" "}
                    {reward.qualifyingItemCount === 1 ? "product" : "products"}
                  </span>
                </td>
                <td className={tdClasses}>
                  <RewardAmount reward={reward} />
                  <RewardBasis reward={reward} />
                </td>
                <td className={`${tdClasses} whitespace-nowrap`}>
                  {formatEarningsDate(reward.awardedAt) ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Narrow screens: cards carrying every field the table carries. */}
      <ul className="flex flex-col gap-3 lg:hidden">
        {rewards.map((reward) => (
          <li key={reward.rewardId} className={cardClasses("standard", "p-4")}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="font-medium break-words text-slate-800">
                {reward.campaignName ?? "Campaign"}
              </span>
              <Badge tone="slate">{rewardRuleLabel(reward.ruleType)}</Badge>
            </div>

            <div className="mt-3">
              <RewardAmount reward={reward} />
              <RewardBasis reward={reward} />
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
              <div>
                <dt className="text-slate-500">Sale date</dt>
                <dd className="text-slate-700">
                  {formatEarningsDate(reward.saleAt) ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Awarded</dt>
                {/* The precise instant here: the card has room the table does not, and
                    two rewards on one day are easier to tell apart with the time. */}
                <dd className="text-slate-700">
                  {formatEarningsTimestamp(reward.awardedAt) ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Receipt</dt>
                <dd className="font-mono text-slate-700">
                  {receiptReference(reward.receiptSubmissionId)}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Qualifying</dt>
                <dd className="text-slate-700">
                  {formatUnits(reward.qualifyingUnits)} units ·{" "}
                  {formatUnits(reward.qualifyingItemCount)}{" "}
                  {reward.qualifyingItemCount === 1 ? "product" : "products"}
                </dd>
              </div>
              {reward.shopName !== null && (
                <div className="col-span-2">
                  <dt className="text-slate-500">Shop</dt>
                  <dd className="break-words text-slate-700">{reward.shopName}</dd>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function StaffEarningsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
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

  const resolvedParams = await searchParams;

  // An invalid or half-supplied cursor becomes null and the first page is shown. It is
  // never forwarded: a malformed timestamp would raise in SQL, and a raise on a
  // hand-edited URL is a worse answer than simply showing the newest rewards.
  const cursor = parseRewardCursor(resolvedParams);

  const [summaryResult, rewardsResult] = await Promise.all([
    getMyCampaignEarningsSummary(),
    getMyCampaignRewards({
      beforeAwardedAt: cursor?.beforeAwardedAt ?? null,
      beforeRewardId: cursor?.beforeRewardId ?? null,
    }),
  ]);

  // One condition per redirect, matching every other portal page. Either read being
  // refused means the caller is not an authorized Sales Staff member, and both go to the
  // same destination — but the two decisions stay separate so neither is hidden behind
  // the other.
  if (summaryResult.status === "denied") {
    redirect("/retailer-access-denied");
  }

  if (rewardsResult.status === "denied") {
    redirect("/retailer-access-denied");
  }

  const nextCursor =
    rewardsResult.status === "ok"
      ? nextRewardCursor(rewardsResult.rewards, REWARDS_PAGE_SIZE)
      : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        eyebrow="Earnings"
        title="My campaign earnings"
        description="Campaign rewards earned from verified sales. Wallet and redemption features are not available yet."
      />

      {/* ---- Summary ------------------------------------------------------- */}
      {summaryResult.status === "unavailable" ? (
        <Alert tone="warning" role="alert" title="Earnings summary unavailable">
          {EARNINGS_UNAVAILABLE_MESSAGE}
        </Alert>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* "Coins earned", never "balance". A seller with no rewards sees 0. */}
            <DetailStat
              icon={<RewardIcon className="h-5 w-5" />}
              tone="indigo"
              label="Total campaign coins earned"
              value={
                <span className="tabular-nums">
                  {formatCoins(summaryResult.summary.totalRewardCoins)}
                </span>
              }
            />
            <DetailStat
              icon={<TrendingUpIcon className="h-5 w-5" />}
              tone="emerald"
              label="Coins earned this month"
              value={
                <span className="tabular-nums">
                  {formatCoins(summaryResult.summary.currentMonthRewardCoins)}
                </span>
              }
            />
            <DetailStat
              icon={<ReceiptIcon className="h-5 w-5" />}
              tone="slate"
              label="Rewarded sales"
              value={
                <span className="tabular-nums">
                  {formatUnits(summaryResult.summary.rewardedSaleCount)}
                </span>
              }
            />
            <DetailStat
              icon={<CampaignsIcon className="h-5 w-5" />}
              tone="slate"
              label="Rewarded campaigns"
              value={
                <span className="tabular-nums">
                  {formatUnits(summaryResult.summary.rewardedCampaignCount)}
                </span>
              }
            />
            <DetailStat
              icon={<CalendarIcon className="h-5 w-5" />}
              tone="slate"
              label="Latest reward date"
              value={
                formatEarningsDate(summaryResult.summary.latestRewardAt) ?? "—"
              }
            />
          </div>

          <Alert tone="info" role="status" title="About these figures">
            {NOT_A_WALLET_NOTICE}
          </Alert>
        </>
      )}

      {/* ---- History ------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <SectionHeader
          title="Reward history"
          description="Newest first. Each row is one campaign reward from one verified sale."
        />

        {rewardsResult.status === "unavailable" ? (
          <Alert tone="warning" role="alert" title="Reward history unavailable">
            {EARNINGS_UNAVAILABLE_MESSAGE}
          </Alert>
        ) : rewardsResult.rewards.length === 0 ? (
          <EmptyState
            icon={<RewardIcon className="h-6 w-6" />}
            title={cursor === null ? "No rewards yet" : "No older rewards"}
            description={
              cursor === null
                ? NO_REWARDS_MESSAGE
                : "You have reached the end of your reward history."
            }
            action={
              cursor === null ? undefined : (
                <Link
                  href="/retailer/my-earnings"
                  className="rounded-lg px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
                >
                  Back to newest rewards
                </Link>
              )
            }
          />
        ) : (
          <>
            <RewardRows rewards={rewardsResult.rewards} />

            {/* Keyset paging. A plain link, so it works without JavaScript and is
                reachable by keyboard like any other link. Never auto-loading. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              {cursor !== null ? (
                <Link
                  href="/retailer/my-earnings"
                  className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
                >
                  Newest rewards
                </Link>
              ) : (
                <span />
              )}

              {nextCursor !== null && (
                <Link
                  href={rewardCursorHref("/retailer/my-earnings", nextCursor)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
                >
                  Load older rewards
                </Link>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
