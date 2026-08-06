"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import { Badge } from "@/components/ui/badge";
import { cardClasses } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/components/ui/cn";
import {
  CalendarIcon,
  CampaignsIcon,
  ChevronRightIcon,
  ProductsIcon,
  RetailersIcon,
} from "@/components/ui/icons";
import type { VendorCampaignSummary } from "@/lib/campaigns/campaign-normalization";
import {
  audienceLabel,
  performancePlainLabel,
  productResolutionLabel,
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
 *
 * ============================================================================
 * WHAT THE REDESIGN CHANGED, AND WHY
 * ============================================================================
 * The previous row printed six equally weighted definition-list cells, so a campaign's
 * NAME carried the same visual weight as its time zone and nothing could be scanned. The
 * row now has a deliberate order of importance:
 *
 *   1. name and state          — the two things a scanning eye looks for
 *   2. reward and measurement  — what the campaign actually offers
 *   3. audience and products   — who and what it covers
 *   4. dates and metadata      — supporting, and visually quietest
 *
 * The whole row is one link with a visible affordance, rather than a card that happened
 * to be clickable.
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
  if (startsAt === null) return "No schedule yet";

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
  if (campaign.audienceMode === null) return "Not set";
  if (campaign.audienceMode === "ALL_RETAILERS") return audienceLabel("ALL_RETAILERS");
  if (campaign.audienceMode === "SELECTED_RETAILERS") {
    const count = campaign.selectedRetailerCount;
    return `${count} selected ${count === 1 ? "Retailer" : "Retailers"}`;
  }
  const count = campaign.selectedGroupCount;
  return `${count} ${count === 1 ? "group" : "groups"}`;
}

function productSummary(campaign: VendorCampaignSummary): string {
  if (campaign.productScope === null) return "Not set";
  if (campaign.productScope === "ALL_ELIGIBLE_PRODUCTS") {
    return productScopeLabel("ALL_ELIGIBLE_PRODUCTS");
  }
  const count = campaign.selectedProductCount;
  return `${count} selected ${count === 1 ? "product" : "products"}`;
}

/** A quiet supporting fact: an icon, then a short value. */
function MetaFact({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-slate-600">
      <span className="shrink-0 text-slate-400" aria-hidden="true">
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </span>
  );
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

  const filtered = state !== "ALL" || scope !== "ALL";

  return (
    <>
      {/* Filters. Radio semantics, so a screen reader announces the group and the
          selected member rather than ten unrelated buttons. */}
      <div className="mt-6 space-y-2.5">
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
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
                  selected
                    ? "bg-indigo-600 text-white ring-indigo-600"
                    : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50 hover:text-slate-900",
                  // A state with nothing in it is dimmed but still reachable, so the
                  // absence is visible rather than the filter simply doing nothing.
                  !selected && count === 0 && "opacity-55",
                )}
              >
                {filter.label}
                <span
                  className={cn(
                    "tabular-nums",
                    selected ? "text-indigo-100" : "text-slate-400",
                  )}
                >
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
                  "rounded-lg px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors",
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
      <p className="mt-3 text-sm text-slate-500" aria-live="polite">
        {visible.length === campaigns.length
          ? `${campaigns.length} ${campaigns.length === 1 ? "campaign" : "campaigns"}`
          : `${visible.length} of ${campaigns.length} campaigns`}
      </p>

      {visible.length === 0 ? (
        <EmptyState
          className="mt-3"
          icon={<CampaignsIcon className="h-6 w-6" />}
          title="No campaigns match these filters"
          description={
            filtered
              ? "Clear a filter to see the rest of your campaigns."
              : "Create a campaign to get started."
          }
        />
      ) : (
        <ul className="mt-3 flex flex-col gap-2.5">
          {visible.map((campaign) => {
            const reward = rewardSummary(campaign.reward);
            return (
              <li key={campaign.campaignId}>
                {/* The WHOLE row is the link — one large target, one keyboard stop. */}
                <Link
                  href={`/campaigns/${campaign.campaignId}`}
                  className={cardClasses(
                    "interactive",
                    "group block p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 sm:p-5",
                  )}
                >
                  <div className="flex items-start gap-4">
                    <div className="min-w-0 flex-1">
                      {/* --- 1. Name and state --- */}
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-slate-900">
                          {campaign.name}
                        </h3>
                        <CampaignStateBadge state={campaign.derivedState} />
                        {campaign.hasDraft &&
                          campaign.derivedState !== "DRAFT" && (
                            <Badge tone="indigo">Draft changes</Badge>
                          )}
                      </div>

                      {campaign.description && (
                        <p className="mt-1 line-clamp-1 max-w-2xl text-sm text-slate-500">
                          {campaign.description}
                        </p>
                      )}

                      {/* --- 2. Reward and measurement: the loudest facts after the
                              name, because they are what the campaign IS. --- */}
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                        <span className="inline-flex items-center rounded-lg bg-indigo-50 px-2.5 py-1 text-sm font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-600/15">
                          {/* A dash, never a guess: an invented reward is a promise
                              nobody made. */}
                          {reward ?? "No reward set"}
                        </span>
                        <span className="text-xs font-medium text-slate-600">
                          {campaign.performanceScope === null
                            ? "Not set"
                            : performancePlainLabel(campaign.performanceScope)}
                        </span>
                        {campaign.stackingMode !== null && (
                          <Badge
                            tone={
                              campaign.stackingMode === "EXCLUSIVE" ? "amber" : "slate"
                            }
                          >
                            {stackingLabel(campaign.stackingMode)}
                          </Badge>
                        )}
                      </div>

                      {/* --- 3 and 4. Coverage, then dates. Quiet by design. --- */}
                      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                        <MetaFact icon={<RetailersIcon className="h-3.5 w-3.5" />}>
                          {audienceSummary(campaign)}
                        </MetaFact>
                        <MetaFact icon={<ProductsIcon className="h-3.5 w-3.5" />}>
                          {productSummary(campaign)}
                          {campaign.productEligibilityResolution !== null && (
                            <span className="text-slate-400">
                              {" · "}
                              {productResolutionLabel(
                                campaign.productEligibilityResolution,
                              )}
                            </span>
                          )}
                        </MetaFact>
                        <MetaFact icon={<CalendarIcon className="h-3.5 w-3.5" />}>
                          {formatPeriod(
                            campaign.startsAt,
                            campaign.endsAt,
                            campaign.timezoneName,
                          )}
                          {campaign.timezoneName && (
                            <span className="text-slate-400">
                              {" · "}
                              {campaign.timezoneName}
                            </span>
                          )}
                        </MetaFact>
                      </div>
                    </div>

                    {/* The affordance, stated rather than implied by a hover shadow. */}
                    <span className="flex shrink-0 flex-col items-end gap-2 pt-0.5">
                      {campaign.versionNumber !== null && (
                        <span className="text-xs text-slate-400">
                          Version {campaign.versionNumber}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-indigo-600">
                        <span className="hidden sm:inline">View details</span>
                        <ChevronRightIcon
                          className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                          aria-hidden="true"
                        />
                      </span>
                    </span>
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
