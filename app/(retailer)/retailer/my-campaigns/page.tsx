import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { listMyStaffCampaigns } from "@/lib/campaigns/staff-campaigns";
import { getMyCampaignTargetProgress } from "@/lib/earnings/staff-earnings";
import type { AssignedCampaign } from "@/lib/campaigns/campaign-normalization";
import type { CampaignTargetProgress } from "@/lib/earnings/earnings-normalization";
import {
  CAMPAIGNS_UNAVAILABLE_MESSAGE,
  NO_CAMPAIGNS_MESSAGE,
  formatCoins,
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
  performanceExplanation,
  productResolutionLabel,
  rewardSummary,
  stackingLabel,
} from "@/lib/campaigns/campaign-vocabulary";
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cardClasses } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ProgressBar } from "@/components/ui/progress-bar";
import {
  CalendarIcon,
  CampaignsIcon,
  ChevronRightIcon,
  ProductsIcon,
} from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Current campaigns · Retailer Portal",
  description: "Campaigns you can earn rewards from right now.",
};

/**
 * The Sales Staff view of what is running at their Retailer.
 *
 * TWO READS, JOINED ON AN AUTHORITATIVE KEY:
 *   list_my_staff_campaigns()          Migration 30 — what is offered
 *   get_my_campaign_target_progress()  Migration 70 — how far along the target is
 *
 * They are joined on campaign_id, the only authoritative identifier both contracts
 * return, NEVER on the display name — two campaigns may share a name, and a name may be
 * edited between the two reads.
 *
 * ============================================================================
 * AUTHORIZATION IS RE-RESOLVED HERE
 * ============================================================================
 * The layout has already decided, but this page is directly addressable so its state
 * must come from the verified session rather than from how the caller arrived. React
 * `cache` makes the repeat resolution free. Both RPCs decide again in SQL regardless.
 *
 * ============================================================================
 * NO CAMPAIGN VISIBILITY RULE IS APPLIED HERE
 * ============================================================================
 * There is no filter on state, on dates, on publication or on targeting in this file.
 * list_my_staff_campaigns() returns ACTIVE and SCHEDULED campaigns for the caller's own
 * Retailer and nothing else; this page renders exactly what it returns, in the sections
 * the returned `derivedState` puts them in. Nothing here can infer a draft, because a
 * draft never arrives.
 */

/**
 * The two sections, in the order a seller cares about.
 *
 * There is no "ended" section: the RPC does not return ended, paused or cancelled
 * campaigns to a seller, and inventing a permanently-empty heading would advertise a
 * history this contract does not provide.
 */
const SECTIONS: {
  key: string;
  title: string;
  description: string;
  states: AssignedCampaign["derivedState"][];
}[] = [
  {
    key: "active",
    title: "Running now",
    description: "Qualifying sales you make today count towards these.",
    states: ["ACTIVE"],
  },
  {
    key: "upcoming",
    title: "Starting soon",
    description: "These have been published but have not started yet.",
    states: ["SCHEDULED"],
  },
];

function CampaignDates({ campaign }: { campaign: AssignedCampaign }) {
  const starts = formatEarningsDate(campaign.startsAt);
  const ends = formatEarningsDate(campaign.endsAt);
  if (starts === null && ends === null) return null;

  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-500">
      <CalendarIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        {starts ?? "—"} to {ends ?? "—"}
      </span>
    </span>
  );
}

/**
 * The target block for one campaign, or nothing at all.
 *
 * A campaign with no progress row is a PER_UNIT_COINS campaign — it has no threshold to
 * track — and renders no bar, per the contract that only TARGET_BONUS campaigns appear
 * in get_my_campaign_target_progress().
 */
function TargetProgressBlock({ progress }: { progress: CampaignTargetProgress }) {
  const statement = targetStatement(progress);
  const percent = progressPercent(progress);

  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-slate-700">
          {progressScopeLabel(progress.performanceScope)}
        </span>
        <span className="text-sm tabular-nums text-slate-600">
          {formatUnits(progress.progressUnits)} of{" "}
          {formatUnits(progress.targetUnits)} units
        </span>
      </div>

      <ProgressBar
        className="mt-2"
        percent={percent}
        label={progressAriaLabel(progress)}
        valueNow={progress.progressUnits}
        valueMax={progress.targetUnits}
        tone={statement.tone}
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone={statement.tone}>{statement.label}</Badge>
      </div>

      {/* The status in words, never colour alone — and the sentence that keeps a team
          figure from reading as a personal one. */}
      <p className="mt-2 text-sm text-slate-600">{statement.detail}</p>
      <p className="mt-1 text-xs text-slate-500">
        {progressScopeExplanation(progress.performanceScope)}
      </p>
    </div>
  );
}

function CampaignCard({
  campaign,
  progress,
}: {
  campaign: AssignedCampaign;
  progress: CampaignTargetProgress | undefined;
}) {
  const summary = rewardSummary(campaign.reward);

  return (
    <li className={cardClasses("standard", "relative overflow-hidden")}>
      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {/* break-words so a long campaign name wraps instead of overflowing. */}
            <h3 className="text-base font-semibold break-words text-slate-900">
              <Link
                href={`/retailer/my-campaigns/${campaign.campaignId}`}
                className="rounded outline-none after:absolute after:inset-0 hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {campaign.campaignName}
              </Link>
            </h3>
            {campaign.description !== null && (
              <p className="mt-1 text-sm break-words text-slate-600">
                {campaign.description}
              </p>
            )}
          </div>
          <CampaignStateBadge state={campaign.derivedState} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <CampaignDates campaign={campaign} />
          <span className="inline-flex items-center gap-1.5 text-sm text-slate-500">
            <ProductsIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {campaign.eligibleProductCount === 1
              ? "1 eligible product"
              : `${formatCoins(campaign.eligibleProductCount)} eligible products`}
          </span>
        </div>

        {/* The OFFER. rewardSummary is the shared vocabulary the Vendor and Retailer
            surfaces already use, so one campaign reads identically everywhere. It
            returns null when the rule is absent or incomplete, and a missing offer is
            simply not stated rather than rendered as an empty line. */}
        {summary !== null && (
          <p className="mt-4 text-sm font-medium text-slate-800">{summary}</p>
        )}
        <p className="mt-1 text-sm text-slate-600">
          {performanceExplanation(campaign.performanceScope)}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone="slate">{productResolutionLabel(campaign.productEligibilityResolution)}</Badge>
          <Badge tone="slate">{stackingLabel(campaign.stackingMode)}</Badge>
        </div>

        {progress !== undefined && <TargetProgressBlock progress={progress} />}
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/70 px-5 py-3">
        <span className="text-sm font-medium text-indigo-700">
          View campaign and eligible products
        </span>
        <ChevronRightIcon className="h-4 w-4 text-indigo-700" aria-hidden="true" />
      </div>
    </li>
  );
}

export default async function StaffCampaignsPage() {
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

  // Concurrent: neither read depends on the other's result.
  const [campaignsResult, progressResult] = await Promise.all([
    listMyStaffCampaigns(),
    getMyCampaignTargetProgress(),
  ]);

  // A seller who is not authorized for this contract is sent to the same destination
  // every other portal denial uses. The page never says which condition failed.
  if (campaignsResult.status === "denied") {
    redirect("/retailer-access-denied");
  }

  const header = (
    <PageHeader
      eyebrow="Campaigns"
      title="Current campaigns"
      description="Campaigns running at your shop now, and the ones starting soon."
    />
  );

  if (campaignsResult.status === "unavailable") {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        {header}
        <Alert tone="warning" role="alert" title="Campaigns unavailable">
          {CAMPAIGNS_UNAVAILABLE_MESSAGE}
        </Alert>
      </div>
    );
  }

  const { campaigns } = campaignsResult;

  // A FAILED PROGRESS READ DOES NOT HIDE THE CAMPAIGNS. The offer is still true and
  // still worth showing; only the bars are missing, and the notice below says so.
  const progressById =
    progressResult.status === "ok"
      ? progressByCampaignId(progressResult.progress)
      : new Map<string, CampaignTargetProgress>();

  const sections = SECTIONS.map((section) => ({
    ...section,
    campaigns: campaigns.filter((campaign) =>
      section.states.includes(campaign.derivedState),
    ),
  })).filter((section) => section.campaigns.length > 0);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      {header}

      {progressResult.status === "unavailable" && (
        <Alert tone="warning" role="status" title="Target progress unavailable">
          Campaign details are shown below, but progress towards targets could not be
          loaded. Try again in a moment.
        </Alert>
      )}

      {campaigns.length === 0 ? (
        <EmptyState
          icon={<CampaignsIcon className="h-6 w-6" />}
          title="No campaigns right now"
          description={NO_CAMPAIGNS_MESSAGE}
        />
      ) : (
        sections.map((section) => (
          <section key={section.key} className="flex flex-col gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">
                {section.title}
              </h2>
              <p className="text-sm text-slate-600">{section.description}</p>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2">
              {section.campaigns.map((campaign) => (
                <CampaignCard
                  key={campaign.campaignId}
                  campaign={campaign}
                  progress={progressById.get(campaign.campaignId)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
