"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import { Badge } from "@/components/ui/badge";
import { cardClasses } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/components/ui/cn";
import { CampaignsIcon } from "@/components/ui/icons";
import type { VendorCampaignSummary } from "@/lib/campaigns/campaign-normalization";
import {
  audienceLabel,
  performanceLabel,
  productScopeLabel,
  rewardSummary,
  stackingLabel,
  type CampaignState,
  type PerformanceScope,
} from "@/lib/campaigns/campaign-vocabulary";

/**
 * The Vendor campaign list, with its filters.
 *
 * A Client Component for ONE reason: the filters are interactive. The data is fetched on
 * the server and passed in whole — filtering happens over a result this caller is already
 * authorized to hold, so no filter value ever becomes a request parameter and no filter
 * can widen what was returned. Selecting "Active" cannot reveal a campaign the server
 * withheld, because the server withheld nothing it was entitled to send.
 *
 * NO PROGRESS AND NO TOTALS. Every number on a row is configuration — how many Retailers
 * a published version resolved to, how many products were selected, what the reward
 * offers. Nothing here is units sold or coins earned; there is no such field to render.
 */

const STATE_FILTERS: { key: CampaignState | "ALL"; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "DRAFT", label: "Draft" },
  { key: "SCHEDULED", label: "Scheduled" },
  { key: "ACTIVE", label: "Active" },
  { key: "PAUSED", label: "Paused" },
  { key: "ENDED", label: "Ended" },
  { key: "CANCELLED", label: "Cancelled" },
];

const SCOPE_FILTERS: { key: PerformanceScope | "ALL"; label: string }[] = [
  { key: "ALL", label: "All types" },
  { key: "INDIVIDUAL_STAFF", label: "Individual" },
  { key: "RETAILER_TEAM", label: "Retailer team" },
];

/**
 * A campaign period, rendered in the campaign's OWN time zone.
 *
 * Not the reader's: a campaign authored as "1 September, Dubai" must read that way to
 * everyone, or two people looking at the same row will disagree about when it starts. The
 * zone is named alongside so the reading is unambiguous.
 */
function formatPeriod(
  startsAt: string | null,
  endsAt: string | null,
  timeZone: string | null,
): string {
  if (startsAt === null) return "—";

  const zone = timeZone ?? "UTC";
  const format = (iso: string) => {
    const instant = Date.parse(iso);
    if (Number.isNaN(instant)) return "—";
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(instant));
    } catch {
      return "—";
    }
  };

  const start = format(startsAt);
  // An absent end is the evergreen case — a first-class configuration, not missing data.
  return endsAt === null ? `${start} — no end date` : `${start} — ${format(endsAt)}`;
}

/** "All Retailers", "4 Retailers", "2 groups" — never the Retailers' names. */
function audienceSummary(campaign: VendorCampaignSummary): string {
  if (campaign.audienceMode === null) return "—";
  if (campaign.audienceMode === "ALL_RETAILERS") return audienceLabel("ALL_RETAILERS");
  if (campaign.audienceMode === "SELECTED_RETAILERS") {
    const count = campaign.selectedRetailerCount;
    return `${count} selected ${count === 1 ? "Retailer" : "Retailers"}`;
  }
  const count = campaign.selectedGroupCount;
  return `${count} ${count === 1 ? "group" : "groups"}`;
}

export function CampaignList({ campaigns }: { campaigns: VendorCampaignSummary[] }) {
  const [state, setState] = useState<CampaignState | "ALL">("ALL");
  const [scope, setScope] = useState<PerformanceScope | "ALL">("ALL");

  const visible = useMemo(
    () =>
      campaigns.filter(
        (campaign) =>
          (state === "ALL" || campaign.derivedState === state) &&
          (scope === "ALL" || campaign.performanceScope === scope),
      ),
    [campaigns, state, scope],
  );

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const campaign of campaigns) {
      map.set(campaign.derivedState, (map.get(campaign.derivedState) ?? 0) + 1);
    }
    return map;
  }, [campaigns]);

  return (
    <>
      {/* Filters. Radio semantics, so a screen reader announces the group and the
          selected member rather than seven unrelated buttons. */}
      <div className="mt-8 flex flex-col gap-3">
        <div
          role="radiogroup"
          aria-label="Filter by campaign status"
          className="flex flex-wrap gap-2"
        >
          {STATE_FILTERS.map((filter) => {
            const selected = state === filter.key;
            const count =
              filter.key === "ALL" ? campaigns.length : (counts.get(filter.key) ?? 0);
            return (
              <button
                key={filter.key}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setState(filter.key)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
                  selected
                    ? "bg-indigo-600 text-white ring-indigo-600"
                    : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50 hover:text-slate-900",
                )}
              >
                {filter.label}
                <span className={selected ? "text-indigo-100" : "text-slate-400"}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div
          role="radiogroup"
          aria-label="Filter by performance type"
          className="flex flex-wrap gap-2"
        >
          {SCOPE_FILTERS.map((filter) => {
            const selected = scope === filter.key;
            return (
              <button
                key={filter.key}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setScope(filter.key)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
                  selected
                    ? "bg-slate-900 text-white ring-slate-900"
                    : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50",
                )}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* The live region announces the result of a filter change to a screen reader,
          which would otherwise get no feedback at all from a purely visual update. */}
      <p className="mt-4 text-sm text-slate-500" aria-live="polite">
        {visible.length === campaigns.length
          ? `${campaigns.length} ${campaigns.length === 1 ? "campaign" : "campaigns"}`
          : `${visible.length} of ${campaigns.length} campaigns`}
      </p>

      {visible.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={<CampaignsIcon className="h-6 w-6" />}
          title="No campaigns match these filters"
          description="Clear a filter to see the rest of your campaigns."
        />
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {visible.map((campaign) => {
            const reward = rewardSummary(campaign.reward);
            return (
              <li key={campaign.campaignId}>
                {/* The WHOLE card is the link, so the target is large, obvious and
                    keyboard-reachable as one stop rather than several. */}
                <Link
                  href={`/campaigns/${campaign.campaignId}`}
                  className={cardClasses(
                    "interactive",
                    "block p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-slate-900">
                          {campaign.name}
                        </h3>
                        <CampaignStateBadge state={campaign.derivedState} />
                        {campaign.hasDraft && (
                          <Badge tone="indigo">Draft changes</Badge>
                        )}
                      </div>
                      {campaign.description && (
                        <p className="mt-1 max-w-2xl text-sm text-slate-500">
                          {campaign.description}
                        </p>
                      )}
                    </div>
                    {campaign.versionNumber !== null && (
                      <span className="shrink-0 text-xs font-medium text-slate-400">
                        Version {campaign.versionNumber}
                      </span>
                    )}
                  </div>

                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">
                        Audience
                      </dt>
                      <dd className="mt-0.5 text-slate-700">
                        {audienceSummary(campaign)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">
                        Measured
                      </dt>
                      <dd className="mt-0.5 text-slate-700">
                        {campaign.performanceScope === null
                          ? "—"
                          : performanceLabel(campaign.performanceScope)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">
                        Products
                      </dt>
                      <dd className="mt-0.5 text-slate-700">
                        {campaign.productScope === null
                          ? "—"
                          : campaign.productScope === "ALL_ELIGIBLE_PRODUCTS"
                            ? productScopeLabel("ALL_ELIGIBLE_PRODUCTS")
                            : `${campaign.selectedProductCount} selected`}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">
                        Reward
                      </dt>
                      {/* A missing rule renders a dash. It never renders a guess: an
                          invented reward is a promise nobody made. */}
                      <dd className="mt-0.5 text-slate-700">{reward ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-slate-400">
                        Period
                      </dt>
                      <dd className="mt-0.5 text-slate-700">
                        {formatPeriod(
                          campaign.startsAt,
                          campaign.endsAt,
                          campaign.timezoneName,
                        )}
                      </dd>
                    </div>
                  </dl>

                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {campaign.stackingMode !== null && (
                      <Badge
                        tone={campaign.stackingMode === "EXCLUSIVE" ? "amber" : "slate"}
                      >
                        {stackingLabel(campaign.stackingMode)}
                      </Badge>
                    )}
                    {campaign.derivedState !== "DRAFT" && (
                      <span className="text-xs text-slate-400">
                        {campaign.eligibleRetailerCount}{" "}
                        {campaign.eligibleRetailerCount === 1
                          ? "eligible Retailer"
                          : "eligible Retailers"}
                      </span>
                    )}
                    {campaign.timezoneName && (
                      <span className="text-xs text-slate-400">
                        {campaign.timezoneName}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
