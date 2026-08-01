import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import { getMyRetailerCampaigns } from "@/lib/campaigns/retailer-campaigns";
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import { CalculationEngineNotice } from "@/components/campaigns/campaign-facts";
import {
  NoEligibleProductsNotice,
  hasNoEligibleProducts,
} from "@/components/campaigns/no-eligible-products-notice";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cardClasses } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import {
  CalendarIcon,
  CampaignsIcon,
  ChevronRightIcon,
  ProductsIcon,
} from "@/components/ui/icons";
import type { AssignedCampaign } from "@/lib/campaigns/campaign-normalization";
import {
  performanceExplanation,
  performancePlainLabel,
  productResolutionExplanation,
  productResolutionLabel,
  rewardPreviewSentence,
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
    title: "Running now",
    description: "Eligible sales made today count towards these.",
    states: ["ACTIVE"],
  },
  {
    key: "upcoming",
    title: "Starting soon",
    description: "Published by your Vendor and not yet started.",
    states: ["SCHEDULED"],
  },
  {
    key: "paused",
    title: "Paused",
    description: "Temporarily suspended by your Vendor. They may resume.",
    states: ["PAUSED"],
  },
  {
    key: "finished",
    title: "Finished",
    description: "Ended or cancelled, kept for your records.",
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
  const rewardSentence = rewardPreviewSentence({
    ruleType: campaign.reward.ruleType,
    performanceScope: campaign.performanceScope,
    coinsPerUnit: campaign.reward.coinsPerUnit,
    thresholdUnits: campaign.reward.thresholdUnits,
    rewardCoins: campaign.reward.rewardCoins,
    maxRewardCoins: campaign.reward.maxRewardCoins,
  });

  const period = `${formatDate(campaign.startsAt, campaign.timezoneName)} — ${
    campaign.endsAt === null
      ? "no end date"
      : formatDate(campaign.endsAt, campaign.timezoneName)
  }`;

  const nothingEligible = hasNoEligibleProducts(
    campaign.derivedState,
    campaign.eligibleProductCount,
  );

  return (
    <li>
      {/*
        THE WHOLE CARD IS ONE REAL LINK.

        A `<Link>`, not a click handler on a div: it is keyboard-reachable, focusable,
        announced as a link, and openable in a new tab — none of which a div with onClick
        gives. The campaign title lives inside it, so the title IS a link.

        ONE interactive element, not several. The card is read-only, so there is nothing
        else on it that could be a control, and nesting a second link inside this one
        would be invalid HTML and an extra tab stop for no gain.

        The `aria-label` gives the link a short accessible NAME — otherwise a screen
        reader would announce the entire card, offer and all, as the link's name. The card
        content itself remains in the accessibility tree and readable as normal.
      */}
      <Link
        href={`/retailer/campaigns/${campaign.campaignId}`}
        aria-label={`View details for ${campaign.campaignName}`}
        className={cardClasses(
          "interactive",
          "group block p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
        )}
      >
        {/* --- Identity: what it is, who it is from, what state it is in --- */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CampaignStateBadge state={campaign.derivedState} />
              {/* The Vendor's name IS returned to an Owner and is theirs to see. */}
              {campaign.vendorName && (
                <span className="text-xs text-slate-500">from {campaign.vendorName}</span>
              )}
            </div>
            <h3 className="mt-1.5 text-base font-semibold text-slate-900">
              {campaign.campaignName}
            </h3>
            {campaign.description && (
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
                {campaign.description}
              </p>
            )}
          </div>
          <Badge tone={campaign.stackingMode === "EXCLUSIVE" ? "amber" : "slate"}>
            {stackingLabel(campaign.stackingMode)}
          </Badge>
        </div>

        {/* The warning sits ABOVE the offer, so the offer is never read on its own. A
            campaign advertising coins the Retailer cannot currently earn is exactly the
            misreading this prevents. */}
        {nothingEligible && (
          <NoEligibleProductsNotice
            className="mt-4"
            derivedState={campaign.derivedState}
            productScope={campaign.productScope}
          />
        )}

        {/* --- The offer, given the most weight on the card --- */}
        <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50/60 p-3.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
            What this offers
          </p>
          <p className="mt-1 text-sm font-semibold leading-relaxed text-indigo-950">
            {/* A dash, never a guess: an invented reward is a promise nobody made. */}
            {rewardSentence ?? reward ?? "—"}
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-indigo-900/80">
            {performanceExplanation(campaign.performanceScope)}
          </p>
        </div>

        {/* --- Supporting facts --- */}
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium text-slate-500">Measured</dt>
            <dd className="mt-0.5 text-slate-800">
              {performancePlainLabel(campaign.performanceScope)}
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <ProductsIcon className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              Eligible products
            </dt>
            <dd
              className={cn(
                "mt-0.5",
                nothingEligible ? "font-semibold text-amber-800" : "text-slate-800",
              )}
            >
              {/* THE REAL COUNT, ALWAYS — including zero, and for both product scopes.
                  It previously printed "All eligible products" for a live-temporal
                  campaign, which hid the fact that the live answer for this Retailer was
                  currently none. */}
              {campaign.eligibleProductCount}{" "}
              {campaign.eligibleProductCount === 1 ? "product" : "products"}
              {/* WHICH products, then HOW they are decided. A Retailer reading "all
                  eligible products" must know the set moves with their assignments; one
                  reading a frozen selection must know it does not. */}
              <span className="mt-0.5 block text-xs font-normal text-slate-500">
                {productResolutionLabel(campaign.productEligibilityResolution)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <CalendarIcon className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              Period
            </dt>
            <dd className="mt-0.5 text-slate-800">
              {period}
              {campaign.timezoneName && (
                <span className="mt-0.5 block text-xs text-slate-500">
                  {campaign.timezoneName}
                </span>
              )}
            </dd>
          </div>
        </dl>

        {/* The behaviour a Retailer must understand, stated once from the shared
            vocabulary so every surface says it identically. */}
        <p className="mt-4 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs leading-relaxed text-slate-600">
          {productResolutionExplanation(campaign.productEligibilityResolution)}{" "}
          {stackingExplanation(campaign.stackingMode)}
        </p>

        {/* The affordance, stated in words rather than implied by a hover shadow. */}
        <p className="mt-4 flex items-center justify-end gap-0.5 text-sm font-semibold text-indigo-600">
          View details
          <ChevronRightIcon
            className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </p>
      </Link>
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
  const runningNow = campaigns.filter(
    (campaign) => campaign.derivedState === "ACTIVE",
  ).length;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        title="Campaigns"
        description="The reward campaigns your Vendor has assigned to your Retailer. This view is read-only."
        actions={
          campaigns.length > 0 ? (
            <span className="text-sm text-slate-500">
              {runningNow} running now of {campaigns.length}
            </span>
          ) : undefined
        }
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
          tone="indigo"
          title="No campaigns yet"
          description="Campaigns your Vendor publishes to your Retailer will appear here automatically."
        />
      ) : (
        <div className="mt-8 space-y-8">
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
                  action={
                    <span className="text-sm text-slate-500">{rows.length}</span>
                  }
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
          Retailer can read the figures above correctly. */}
      <div className="mt-10 space-y-2">
        <CalculationEngineNotice />
        <p className="rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs leading-relaxed text-slate-600">
          Nothing on this page is a sales total or a coin balance. For a campaign that
          covers all eligible products, the product count shows what is eligible today
          while the campaign is running, and what was eligible when it ended once it has
          finished.
        </p>
      </div>
    </div>
  );
}
