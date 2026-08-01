import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { getMyRetailerCampaigns } from "@/lib/campaigns/retailer-campaigns";
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cardClasses } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { CampaignsIcon } from "@/components/ui/icons";
import type { AssignedCampaign } from "@/lib/campaigns/campaign-normalization";
import {
  performanceExplanation,
  performanceLabel,
  productResolutionExplanation,
  productResolutionLabel,
  productScopeLabel,
  rewardSummary,
  stackingExplanation,
  stackingLabel,
  type CampaignState,
} from "@/lib/campaigns/campaign-vocabulary";

export const metadata: Metadata = {
  title: "Campaigns · Retailer Portal",
  description: "The campaigns your Vendor has assigned to your Retailer.",
};

/**
 * The Retailer's READ-ONLY view of the campaigns assigned to them.
 *
 * NO MANAGEMENT CONTROLS OF ANY KIND. There is no form, no button that mutates, and no
 * Server Action imported by this route — creating, editing, publishing, pausing, resuming
 * and cancelling are Vendor capabilities, and no Retailer role holds the permission behind
 * any of them. The single read is gated on CAMPAIGNS_VIEW_ASSIGNED, mapped to
 * RETAILER_OWNER alone.
 *
 * WHY A RETAILER MANAGER DOES NOT SEE THIS PAGE. They hold no CAMPAIGNS_VIEW_ASSIGNED
 * mapping, so list_my_retailer_campaigns() refuses them and the page redirects. The portal
 * navigation does not offer them the link either. Their visibility is deferred for this
 * milestone, not accidentally omitted.
 *
 * WHY A SALES STAFF MEMBER DOES NOT SEE IT EITHER. They hold their own, narrower
 * permission — STAFF_CAMPAIGNS_VIEW — behind a different contract that shows only active
 * and upcoming campaigns and withholds the Vendor's name. That contract exists for the
 * Flutter client; this milestone builds no Sales Staff campaign surface on the Web.
 *
 * WHAT IS NEVER RENDERED, because the RPC does not return it: any other Retailer targeted
 * by the same campaign, or a count of them; the Vendor group this Retailer was included
 * through; the campaign's exclusivity key or priority; its internal version number; and
 * any audit metadata.
 *
 * AND NO PROGRESS. Every figure here is what the campaign OFFERS — coins per unit, a unit
 * target, a bonus, a cap. Nothing on this page is units sold, coins earned or a balance,
 * and no field on the type behind it could hold one.
 */

/**
 * The order the sections appear in, and the states each collects.
 *
 * Deliberately mirrors what a Retailer Owner needs in priority order: what is paying now,
 * what is coming, what has been suspended, and what has finished. Cancelled campaigns are
 * kept with ended ones rather than hidden — a campaign that ran and was stopped is part
 * of the Retailer's history, and removing it would make an unexplained gap.
 */
const SECTIONS: {
  key: string;
  title: string;
  description: string;
  states: CampaignState[];
}[] = [
  {
    key: "active",
    title: "Active campaigns",
    description: "Running now. Eligible sales made today count towards these.",
    states: ["ACTIVE"],
  },
  {
    key: "upcoming",
    title: "Upcoming campaigns",
    description: "Published and starting soon.",
    states: ["SCHEDULED"],
  },
  {
    key: "paused",
    title: "Paused campaigns",
    description: "Temporarily suspended by your Vendor. They may resume.",
    states: ["PAUSED"],
  },
  {
    key: "finished",
    title: "Ended and cancelled campaigns",
    description: "Kept for your records.",
    states: ["ENDED", "CANCELLED"],
  },
];

function formatDate(iso: string | null, timeZone: string | null): string {
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

function CampaignCard({ campaign }: { campaign: AssignedCampaign }) {
  const reward = rewardSummary(campaign.reward);

  return (
    <li className={cardClasses("standard", "p-5")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900">
              {campaign.campaignName}
            </h3>
            <CampaignStateBadge state={campaign.derivedState} />
          </div>
          {campaign.vendorName && (
            <p className="mt-0.5 text-xs text-slate-500">From {campaign.vendorName}</p>
          )}
          {campaign.description && (
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              {campaign.description}
            </p>
          )}
        </div>
        <Badge tone={campaign.stackingMode === "EXCLUSIVE" ? "amber" : "slate"}>
          {stackingLabel(campaign.stackingMode)}
        </Badge>
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Reward</dt>
          {/* A dash, never a guess: an invented reward is a promise nobody made. */}
          <dd className="mt-0.5 font-medium text-slate-900">{reward ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Measured</dt>
          <dd className="mt-0.5 text-slate-700">
            {performanceLabel(campaign.performanceScope)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Products</dt>
          <dd className="mt-0.5 text-slate-700">
            {campaign.productScope === "ALL_ELIGIBLE_PRODUCTS"
              ? productScopeLabel("ALL_ELIGIBLE_PRODUCTS")
              : `${campaign.eligibleProductCount} ${
                  campaign.eligibleProductCount === 1 ? "product" : "products"
                }`}
            {/* WHICH products, then HOW they are decided. A Retailer reading "all eligible
                products" must know the set moves with their assignments; one reading a
                frozen selection must know it does not. */}
            <span className="mt-0.5 block text-xs text-slate-500">
              {productResolutionLabel(campaign.productEligibilityResolution)}
            </span>
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Period</dt>
          <dd className="mt-0.5 text-slate-700">
            {formatDate(campaign.startsAt, campaign.timezoneName)}
            {campaign.endsAt === null
              ? " — no end date"
              : ` — ${formatDate(campaign.endsAt, campaign.timezoneName)}`}
          </dd>
        </div>
      </dl>

      {/* The wording the requirement asks for on a team campaign, stated once in
          @/lib/campaigns/campaign-vocabulary so every surface says it identically. */}
      <p className="mt-4 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
        {performanceExplanation(campaign.performanceScope)}{" "}
        {productResolutionExplanation(campaign.productEligibilityResolution)}{" "}
        {stackingExplanation(campaign.stackingMode)}
        {campaign.timezoneName && ` Dates are shown in ${campaign.timezoneName}.`}
      </p>
    </li>
  );
}

export default async function RetailerCampaignsPage() {
  const access = await getRetailerPortalAccess();

  // The layout has already handled these, but this page is directly addressable and must
  // not depend on that.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }
  if (access.status === "unavailable") {
    throw new Error("Retailer portal context is temporarily unavailable.");
  }

  const result = await getMyRetailerCampaigns();

  // A Retailer Manager, a Sales Staff member, or anyone else without the mapping is
  // refused by the RPC and sent to the same generic denial as every other portal denial.
  // Fails closed.
  if (result.status === "denied") {
    redirect("/retailer-access-denied");
  }

  const campaigns = result.status === "ok" ? result.campaigns : [];

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Campaigns"
        description="The reward campaigns your Vendor has assigned to your Retailer. This view is read-only."
      />

      {result.status !== "ok" ? (
        <Alert
          tone="warning"
          role="alert"
          title="Campaigns could not be loaded"
          className="mt-8"
        >
          Something went wrong while loading your campaigns. Please try again in a moment.
        </Alert>
      ) : campaigns.length === 0 ? (
        /* Worded so it cannot be mistaken for a permission problem: the reader IS
           authorized — that is why they can see this page — their Vendor simply has not
           published a campaign to them yet. */
        <EmptyState
          className="mt-8"
          icon={<CampaignsIcon className="h-6 w-6" />}
          title="No campaigns yet"
          description="Campaigns your Vendor publishes to your Retailer will appear here automatically."
        />
      ) : (
        <div className="mt-8 space-y-10">
          {SECTIONS.map((section) => {
            const rows = campaigns.filter((campaign) =>
              section.states.includes(campaign.derivedState),
            );
            if (rows.length === 0) return null;
            return (
              <section key={section.key}>
                <SectionHeader
                  title={section.title}
                  description={section.description}
                />
                <ul className="mt-4 flex flex-col gap-3">
                  {rows.map((campaign) => (
                    <CampaignCard key={campaign.campaignId} campaign={campaign} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {/* The honest statement the requirement asks for. It is not a disclaimer bolted on:
          nothing in this milestone computes progress, and saying so is the only way a
          Retailer can read the numbers above correctly. */}
      <p className="mt-10 rounded-2xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500">
        Campaign results and coin calculations will appear here when the calculation engine
        is connected. Nothing on this page is a sales total or a coin balance. For a
        campaign that covers all eligible products, the product list shows what is eligible
        today while the campaign is running, and what was eligible when it ended once it
        has finished.
      </p>
    </div>
  );
}
