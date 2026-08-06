import Link from "next/link";
import { FeatureCard, StatPill } from "@/components/ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import {
  ArrowUpRightIcon,
  GaugeIcon,
  GroupsIcon,
  ProductsIcon,
  SparkleIcon,
  TrophyIcon,
  UsersIcon,
} from "@/components/ui/icons";
import { RewardTypeIcon } from "@/components/sales-staff/campaign-visuals";
import { TargetProgress } from "@/components/sales-staff/target-progress";
import {
  heroEyebrowKind,
  type HeroEyebrowKind,
  type SalesStaffOpportunity,
} from "@/lib/sales-staff/home-presentation";
import {
  HERO_ACTION,
  HERO_EYEBROW_NEXT,
  HERO_EYEBROW_REACHED,
  HERO_EYEBROW_RUNNING,
  HERO_EYEBROW_UPCOMING,
} from "@/lib/sales-staff/home-copy";
import {
  formatCoins,
  performanceLabel,
  rewardSummary,
  ruleTypeLabel,
} from "@/lib/campaigns/campaign-vocabulary";

/** The one place a decided eyebrow kind becomes words. */
const EYEBROW_COPY: Record<HeroEyebrowKind, string> = {
  next: HERO_EYEBROW_NEXT,
  reached: HERO_EYEBROW_REACHED,
  running: HERO_EYEBROW_RUNNING,
  upcoming: HERO_EYEBROW_UPCOMING,
};

/**
 * The Sales Staff Home's focal point: one campaign, how far along it is, and what
 * reaching it pays.
 *
 * ============================================================================
 * WHY A HERO AT ALL
 * ============================================================================
 * The screen this replaces led with a file picker. That answers "what can I upload?" —
 * not the question somebody standing behind a counter at the start of a shift is asking.
 * This card answers five, in the order they are asked: what is the opportunity, how close
 * am I, what does it pay, what do I do next, and where do I submit.
 *
 * ============================================================================
 * NOTHING ON IT IS A PROMISE
 * ============================================================================
 * The remaining-units line and the configured reward are stored values. The action opens
 * the campaign; it does not claim a reward is coming. The eyebrow is chosen from
 * `target_reached` and the lifecycle state alone, so it never says "your next reward" over
 * a target that has already been met.
 *
 * IT IS THE VISUAL BUDGET THE SCREEN SPENDS ONCE. There is exactly one `FeatureCard` on
 * the Home; a page with two would have neither.
 */
export function NextRewardHero({
  opportunity,
}: {
  opportunity: SalesStaffOpportunity;
}) {
  const { campaign, progress } = opportunity;
  const eyebrow = EYEBROW_COPY[heroEyebrowKind(opportunity)];
  const reached = progress?.targetReached ?? false;
  const tone = reached ? "emerald" : "indigo";
  const summary = rewardSummary(campaign.reward);
  const cap = campaign.reward.maxRewardCoins;
  const team = campaign.performanceScope === "RETAILER_TEAM";

  return (
    <FeatureCard tone={tone} className="p-6 sm:p-8">
      {/* -- Eyebrow and status ------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-3">
        <p
          className={`flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold uppercase tracking-wide ${
            reached ? "text-emerald-700" : "text-indigo-600"
          }`}
        >
          {reached ? (
            <TrophyIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <SparkleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{eyebrow}</span>
        </p>
        <CampaignStateBadge state={campaign.derivedState} />
      </div>

      {/* -- The campaign -------------------------------------------------- */}
      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
        {/* break-words so a long campaign name wraps instead of overflowing. */}
        <span className="break-words">{campaign.campaignName}</span>
      </h2>

      <div className="mt-3 flex flex-wrap gap-2">
        {campaign.reward.ruleType !== null && (
          <Badge tone={tone} icon={<RewardTypeIcon campaign={campaign} />}>
            {ruleTypeLabel(campaign.reward.ruleType)}
          </Badge>
        )}
        <Badge
          tone="slate"
          icon={
            team ? (
              <GroupsIcon className="h-3 w-3" />
            ) : (
              <UsersIcon className="h-3 w-3" />
            )
          }
        >
          {performanceLabel(campaign.performanceScope)}
        </Badge>
      </div>

      {/* -- The gauge, or the offer when there is no target ---------------- */}
      <div className="mt-6">
        {progress !== null ? (
          <TargetProgress
            progress={progress}
            variant="hero"
            idSuffix={`-hero-${campaign.campaignId}`}
          />
        ) : (
          <div>
            <p className="text-lg font-medium text-slate-900">
              {summary ?? "This campaign's reward is not available."}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <StatPill
                label="Eligible products"
                value={`${campaign.eligibleProductCount}`}
                tone="slate"
                icon={<ProductsIcon className="h-3.5 w-3.5" />}
              />
              {cap !== null && (
                <StatPill
                  label="Campaign maximum"
                  value={formatCoins(cap)}
                  tone="amber"
                  icon={<GaugeIcon className="h-3.5 w-3.5" />}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* -- The way in ----------------------------------------------------
          Left-aligned and content-width rather than a full-width slab: the
          Add receipt action is the screen's primary control, and two
          full-width buttons would compete for that role. */}
      <div className="mt-6">
        <Link
          href={`/retailer/my-campaigns/${campaign.campaignId}`}
          className={buttonClasses({ variant: "secondary" })}
        >
          {HERO_ACTION}
          <ArrowUpRightIcon className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </FeatureCard>
  );
}
