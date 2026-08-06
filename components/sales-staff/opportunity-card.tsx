import Link from "next/link";
import { cardClasses } from "@/components/ui/card";
import { IconDisc } from "@/components/ui/surfaces";
import { CalendarIcon } from "@/components/ui/icons";
import {
  CampaignFaceIcon,
  CampaignQualifiers,
} from "@/components/sales-staff/campaign-visuals";
import { TargetProgress } from "@/components/sales-staff/target-progress";
import { campaignFace } from "@/lib/sales-staff/campaign-face";
import { rewardSummary } from "@/lib/campaigns/campaign-vocabulary";
import { formatEarningsDate } from "@/lib/earnings/earnings-presentation";
import type { SalesStaffOpportunity } from "@/lib/sales-staff/home-presentation";

/**
 * One campaign in the Home's opportunity strip.
 *
 * ============================================================================
 * EIGHT CAMPAIGNS, EIGHT FACES
 * ============================================================================
 * A per-unit campaign leads with its RATE, because that is the whole offer and there is
 * no threshold to draw. A target campaign leads with a gauge and what is left to do. A
 * scheduled campaign has no progress to draw at all, so it shows WHEN instead. The
 * qualifiers underneath are additive and independent of all three.
 *
 * Every one of those branches is driven by a column the contract already returns. Nothing
 * on this card is computed from another campaign, and nothing is ranked.
 *
 * ============================================================================
 * ONE TARGET, ONE ANNOUNCEMENT
 * ============================================================================
 * The card is a single link covering the whole surface (`after:absolute after:inset-0`),
 * so a reader tabs to one control rather than three, and a pointer anywhere on the card
 * opens the campaign. The heading carries the link so the accessible name is the campaign
 * name; the gauge keeps its own `progressbar` announcement beside it.
 */
export function OpportunityCard({
  opportunity,
}: {
  opportunity: SalesStaffOpportunity;
}) {
  const { campaign, progress } = opportunity;
  const face = campaignFace(campaign, progress);
  const summary = rewardSummary(campaign.reward);
  const scheduled = campaign.derivedState === "SCHEDULED";
  const startsAt = formatEarningsDate(campaign.startsAt);

  return (
    <div
      className={cardClasses(
        "interactive",
        // Fixed width inside the mobile strip so the next card peeks in and the strip
        // visibly scrolls; full width once the layout becomes a grid.
        "relative flex w-[17rem] shrink-0 snap-start flex-col p-5 sm:w-auto sm:shrink",
      )}
    >
      <div className="flex items-start gap-3">
        <IconDisc
          tone={face.tone}
          size={40}
          icon={<CampaignFaceIcon face={face} className="h-5 w-5" />}
        />
        <h3 className="min-w-0 flex-1 text-sm font-semibold leading-snug text-slate-900">
          <Link
            href={`/retailer/my-campaigns/${campaign.campaignId}`}
            className="rounded outline-none after:absolute after:inset-0 hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {/* break-words so a long campaign name wraps instead of overflowing. */}
            <span className="line-clamp-2 break-words">{campaign.campaignName}</span>
          </Link>
        </h3>
      </div>

      <div className="mt-4 flex-1">
        {scheduled ? (
          /* No progress to draw — show when it starts. */
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-blue-700">
              <CalendarIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Starts
            </p>
            <p className="mt-0.5 text-base font-semibold text-slate-900">
              {startsAt ?? "Not scheduled"}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Eligible sales will count from this date.
            </p>
          </div>
        ) : progress !== null ? (
          <TargetProgress
            progress={progress}
            variant="compact"
            idSuffix={`-opportunity-${campaign.campaignId}`}
          />
        ) : (
          /* The rate IS the offer. Stated large, because there is nothing else to show. */
          <div>
            <p className="text-2xl font-semibold tracking-tight text-slate-900">
              {summary ?? "Reward unavailable"}
            </p>
            {summary !== null && (
              <p className="mt-0.5 text-xs text-slate-500">
                {campaign.reward.ruleType === "PER_UNIT_COINS"
                  ? "for every eligible unit"
                  : "when the target is reached"}
              </p>
            )}
          </div>
        )}
      </div>

      <CampaignQualifiers
        campaign={campaign}
        className="mt-4 flex flex-wrap gap-1.5"
      />
    </div>
  );
}
