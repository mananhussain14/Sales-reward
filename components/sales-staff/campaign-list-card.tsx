import Link from "next/link";
import { cardClasses } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { IconDisc } from "@/components/ui/surfaces";
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import {
  CalendarIcon,
  ChevronRightIcon,
  GroupsIcon,
  UsersIcon,
} from "@/components/ui/icons";
import {
  CampaignFaceIcon,
  CampaignQualifiers,
  RewardTypeIcon,
} from "@/components/sales-staff/campaign-visuals";
import { TargetProgress } from "@/components/sales-staff/target-progress";
import { campaignFace } from "@/lib/sales-staff/campaign-face";
import {
  performanceLabel,
  rewardSummary,
  ruleTypeLabel,
} from "@/lib/campaigns/campaign-vocabulary";
import { formatEarningsDate } from "@/lib/earnings/earnings-presentation";
import type { SalesStaffOpportunity } from "@/lib/sales-staff/home-presentation";

/**
 * One campaign on the Sales Staff campaign list.
 *
 * ============================================================================
 * IDENTITY, THEN OFFER, THEN FACTS
 * ============================================================================
 * A rule-type disc and the name; the scope and rule as badges; the REWARD SENTENCE on its
 * own recessed surface, because that is the sentence a seller came to read; the target
 * gauge where the contract returned one; then the qualifier chips.
 *
 * The recessed surface is what stops the offer from disappearing into a paragraph. It is
 * the one piece of a card that is deliberately not white.
 *
 * ============================================================================
 * NOTHING HERE IS COMPUTED
 * ============================================================================
 * The reward sentence comes from the shared campaign vocabulary that the Vendor and
 * Retailer surfaces already use, so one campaign reads identically everywhere. It returns
 * null when the rule is absent or incomplete, and a missing offer is simply NOT STATED
 * rather than rendered as an empty line or invented.
 */
export function CampaignListCard({
  opportunity,
}: {
  opportunity: SalesStaffOpportunity;
}) {
  const { campaign, progress } = opportunity;
  const face = campaignFace(campaign, progress);
  const summary = rewardSummary(campaign.reward);
  const team = campaign.performanceScope === "RETAILER_TEAM";
  const starts = formatEarningsDate(campaign.startsAt);
  const ends = formatEarningsDate(campaign.endsAt);

  return (
    <div
      className={cardClasses(
        "interactive",
        "relative flex flex-1 flex-col overflow-hidden",
      )}
    >
      <div className="flex flex-1 flex-col p-5 sm:p-6">
        {/* -- Identity --------------------------------------------------- */}
        <div className="flex items-start gap-3">
          <IconDisc
            tone={face.tone}
            size={44}
            icon={<CampaignFaceIcon face={face} className="h-5 w-5" />}
          />

          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold leading-snug text-slate-900">
              <Link
                href={`/retailer/my-campaigns/${campaign.campaignId}`}
                className="rounded outline-none after:absolute after:inset-0 hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {/* break-words so a long campaign name wraps instead of overflowing. */}
                <span className="break-words">{campaign.campaignName}</span>
              </Link>
            </h3>
            {campaign.description !== null && (
              <p className="mt-1 line-clamp-2 break-words text-sm text-slate-600">
                {campaign.description}
              </p>
            )}
          </div>

          <CampaignStateBadge state={campaign.derivedState} />
        </div>

        {/* -- Badges ------------------------------------------------------ */}
        <div className="mt-4 flex flex-wrap gap-2">
          {campaign.reward.ruleType !== null && (
            <Badge tone={face.tone} icon={<RewardTypeIcon campaign={campaign} />}>
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

        {/* -- The offer, on its own surface ------------------------------- */}
        {summary !== null && (
          <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium text-slate-500">Reward</p>
            <p className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900">
              {summary}
            </p>
          </div>
        )}

        {/* -- Progress, where the contract returned a row ------------------ */}
        {progress !== null && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <TargetProgress
              progress={progress}
              variant="compact"
              idSuffix={`-list-${campaign.campaignId}`}
            />
          </div>
        )}

        {/* -- Dates ------------------------------------------------------- */}
        {(starts !== null || ends !== null) && (
          <p className="mt-4 flex items-center gap-1.5 text-sm text-slate-500">
            <CalendarIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              {starts ?? "—"} to {ends ?? "—"}
            </span>
          </p>
        )}

        {/* -- Qualifiers, pushed to the foot so cards in a row align ------- */}
        <CampaignQualifiers
          campaign={campaign}
          className="mt-4 flex flex-wrap gap-1.5"
        />
      </div>

      <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/70 px-5 py-3 sm:px-6">
        <span className="text-sm font-medium text-indigo-700">
          View campaign and eligible products
        </span>
        <ChevronRightIcon className="h-4 w-4 text-indigo-700" aria-hidden="true" />
      </div>
    </div>
  );
}
