import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { listMyStaffCampaigns } from "@/lib/campaigns/staff-campaigns";
import { getMyCampaignTargetProgress } from "@/lib/earnings/staff-earnings";
import type { AssignedCampaign } from "@/lib/campaigns/campaign-normalization";
import type { CampaignTargetProgress } from "@/lib/earnings/earnings-normalization";
import {
  CAMPAIGNS_UNAVAILABLE_MESSAGE,
  NO_CAMPAIGNS_MESSAGE,
  progressByCampaignId,
} from "@/lib/earnings/earnings-presentation";
import { buildOpportunities } from "@/lib/sales-staff/home-presentation";
import { CampaignListCard } from "@/components/sales-staff/campaign-list-card";
import { AddReceiptAction } from "@/components/sales-staff/add-receipt";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { IconDisc, Reveal, SoftBackdrop } from "@/components/ui/surfaces";
import { CalendarIcon, CampaignsIcon } from "@/components/ui/icons";
import type { SurfaceTone } from "@/components/ui/surfaces";

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
 *
 * Each section leads with the SAME tinted disc and tone its cards' status pills carry, a
 * count, and a line saying what belonging to the group means for a sale. Three channels —
 * a glyph, a hue and a sentence — and the hue is never a necessary one.
 */
const SECTIONS: {
  key: string;
  title: string;
  description: string;
  tone: SurfaceTone;
  states: AssignedCampaign["derivedState"][];
}[] = [
  {
    key: "active",
    title: "Running now",
    description: "Qualifying sales you make today count towards these.",
    tone: "emerald",
    states: ["ACTIVE"],
  },
  {
    key: "upcoming",
    title: "Starting soon",
    description:
      "These have been published but have not started yet. Eligible sales will count from their start date.",
    tone: "blue",
    states: ["SCHEDULED"],
  },
];

/** The section heading: a disc, the title, the count, and what the group means. */
function SectionHeading({
  title,
  description,
  tone,
  count,
  icon,
}: {
  title: string;
  description: string;
  tone: SurfaceTone;
  count: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <IconDisc tone={tone} size={44} icon={icon} />
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          {title}{" "}
          <span className="text-sm font-medium tabular-nums text-slate-500">
            ({count})
          </span>
        </h2>
        <p className="text-sm text-slate-600">{description}</p>
      </div>
    </div>
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
      actions={<AddReceiptAction compact />}
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
  // still worth showing; only the gauges are missing, and the notice below says so.
  const progressById =
    progressResult.status === "ok"
      ? progressByCampaignId(progressResult.progress)
      : new Map<string, CampaignTargetProgress>();

  const opportunities = buildOpportunities(campaigns, progressById);

  const sections = SECTIONS.map((section) => ({
    ...section,
    opportunities: opportunities.filter((opportunity) =>
      section.states.includes(opportunity.campaign.derivedState),
    ),
  })).filter((section) => section.opportunities.length > 0);

  return (
    <SoftBackdrop>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <Reveal>{header}</Reveal>

        {progressResult.status === "unavailable" && (
          <Alert tone="warning" role="status" title="Target progress unavailable">
            Campaign details are shown below, but progress towards targets could not be
            loaded. Try again in a moment.
          </Alert>
        )}

        {campaigns.length === 0 ? (
          <Reveal index={1}>
            <EmptyState
              icon={<CampaignsIcon className="h-6 w-6" />}
              title="No campaigns right now"
              description={NO_CAMPAIGNS_MESSAGE}
              action={<AddReceiptAction compact />}
            />
          </Reveal>
        ) : (
          sections.map((section, sectionIndex) => (
            <section key={section.key} className="flex flex-col gap-4">
              <Reveal index={sectionIndex}>
                <SectionHeading
                  title={section.title}
                  description={section.description}
                  tone={section.tone}
                  count={section.opportunities.length}
                  icon={
                    section.key === "upcoming" ? (
                      <CalendarIcon className="h-5 w-5" />
                    ) : (
                      <CampaignsIcon className="h-5 w-5" />
                    )
                  }
                />
              </Reveal>

              {/* One column on a phone, two from `md` up. A third column would make
                  each card too narrow for a gauge and its facts side by side. */}
              <ul className="grid gap-4 md:grid-cols-2">
                {section.opportunities.map((opportunity, index) => (
                  <Reveal
                    as="li"
                    key={opportunity.campaign.campaignId}
                    index={index}
                    className="flex"
                  >
                    <CampaignListCard opportunity={opportunity} />
                  </Reveal>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </SoftBackdrop>
  );
}
