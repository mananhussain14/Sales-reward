import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import {
  getCampaignEligibleRetailers,
  getCampaignVersion,
  getCampaignVersionGroups,
  getCampaignVersionProducts,
  getCampaignVersionRetailers,
  getPublicationPreview,
  getVendorCampaign,
} from "@/lib/campaigns/vendor-campaigns";
import { CampaignLifecycleDialog } from "@/app/(admin)/campaigns/[campaignId]/campaign-lifecycle-dialog";
import { CampaignStateBadge } from "@/components/campaigns/campaign-state-badge";
import {
  CalculationEngineNotice,
  DetailPanel,
  FactTile,
} from "@/components/campaigns/campaign-facts";
import { EligibilityPanel } from "@/components/campaigns/eligibility-panel";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { cardClasses } from "@/components/ui/card";
import { BackLink } from "@/components/ui/page-header";
import {
  CalendarIcon,
  CampaignsIcon,
  ProductsIcon,
  RetailersIcon,
  RewardIcon,
  UsersIcon,
} from "@/components/ui/icons";
import {
  audienceLabel,
  performanceExplanation,
  performancePlainLabel,
  productResolutionExplanation,
  productResolutionLabel,
  productScopePlainLabel,
  rewardPreviewSentence,
  rewardSummary,
  stackingExplanation,
  stackingLabel,
  RETAILER_TEAM_INDEPENDENCE,
} from "@/lib/campaigns/campaign-vocabulary";

export const metadata: Metadata = {
  title: "Campaign · Vendor Admin",
  description: "Campaign configuration, eligibility and lifecycle controls.",
};

/**
 * The campaign detail screen: what this campaign offers, who it reached, and the controls
 * that change its lifecycle.
 *
 * THE VERSION IN VIEW is the published one when there is one, otherwise the draft. That
 * matters because a campaign can hold both at once — a published version still running
 * while a new one is prepared — and showing the draft's dates under a "published" heading
 * would describe a campaign nobody is actually being offered.
 *
 * ============================================================================
 * ONE STATUS VOCABULARY (the confusion this redesign removes)
 * ============================================================================
 * The page previously carried an eyebrow reading "VERSION 1 · IN FORCE" directly above a
 * badge reading "Scheduled", which are two different dimensions printed as though they
 * were one: "in force" described the VERSION POINTER (this version is the published one),
 * while "Scheduled" described the CAMPAIGN'S EFFECTIVE-TIME STATE (its period has not
 * begun). A reader has no way to know that, and the two look like a contradiction.
 *
 * There is now exactly ONE status vocabulary on this page — Draft, Scheduled, Active,
 * Paused, Ended, Cancelled, computed in SQL by public.campaign_derived_state(). Version
 * and publication are demoted to clearly-labelled secondary metadata that says what it
 * means: "Version 2 · published" or "Version 3 · draft, not yet published". The phrase
 * "in force" is gone.
 *
 * WHAT THIS PAGE SHOWS THAT NO RETAILER-FACING SURFACE DOES: the eligibility SOURCE and
 * the group each Retailer came through, the exclusivity key and priority, every targeted
 * Retailer by name, and the version history. Those are Vendor-private, and the
 * assigned-visibility RPCs do not return any of them.
 *
 * WHAT IT DOES NOT SHOW, because it does not exist: progress, units sold, coins earned,
 * balances, claims or payouts. Every number here is configuration or a frozen eligibility
 * count.
 */

function formatInstant(iso: string | null, timeZone: string): string {
  if (iso === null) return "—";
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(instant));
  } catch {
    return "—";
  }
}

function formatDay(iso: string | null, timeZone: string): string {
  if (iso === null) return "—";
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(instant));
  } catch {
    return "—";
  }
}

/** A labelled fact inside a detail panel. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{children}</dd>
    </div>
  );
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const access = await getVendorSuperAdminAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  const { campaignId } = await params;
  const campaignResult = await getVendorCampaign(campaignId);

  if (campaignResult.status === "denied") {
    redirect("/access-denied");
  }
  // An unknown id and another Vendor's id are the same answer, exactly as in SQL.
  if (campaignResult.status === "not-found") {
    notFound();
  }
  if (campaignResult.status !== "ok") {
    throw new Error("Campaign is temporarily unavailable.");
  }

  const campaign = campaignResult.campaign;
  const viewVersionId = campaign.publishedVersionId ?? campaign.draftVersionId;

  if (viewVersionId === null) {
    // Structurally impossible — create_vendor_campaign_draft writes a version in the same
    // transaction — but the type admits it, and a blank page would be worse than a notice.
    throw new Error("Campaign has no version.");
  }

  const isPublishedView = campaign.publishedVersionId !== null;

  const [version, retailers, groups, products, eligible, preview] = await Promise.all([
    getCampaignVersion(viewVersionId),
    getCampaignVersionRetailers(viewVersionId),
    getCampaignVersionGroups(viewVersionId),
    getCampaignVersionProducts(viewVersionId),
    isPublishedView
      ? getCampaignEligibleRetailers(viewVersionId)
      : Promise.resolve({ status: "ok" as const, retailers: [] }),
    // The pre-publication preview only means anything for a DRAFT — once published, the
    // frozen snapshot is the answer and a live re-resolution would contradict it.
    isPublishedView
      ? Promise.resolve({ status: "ok" as const, rows: [] })
      : getPublicationPreview(viewVersionId),
  ]);

  if (version.status === "denied") {
    redirect("/access-denied");
  }
  if (version.status !== "ok") {
    throw new Error("Campaign version is temporarily unavailable.");
  }

  const config = version.version;
  const zone = config.timezoneName;
  const reward = rewardSummary(config.reward);
  const rewardSentence = rewardPreviewSentence({
    ruleType: config.reward.ruleType,
    performanceScope: config.performanceScope,
    coinsPerUnit: config.reward.coinsPerUnit,
    thresholdUnits: config.reward.thresholdUnits,
    rewardCoins: config.reward.rewardCoins,
    maxRewardCoins: config.reward.maxRewardCoins,
  });
  const previewRows = preview.status === "ok" ? preview.rows : [];

  const canPublish =
    campaign.draftVersionId !== null && campaign.campaignStatus !== "CANCELLED";
  const canPause = campaign.campaignStatus === "PUBLISHED";
  const canResume = campaign.campaignStatus === "PAUSED";
  const canCancel =
    campaign.campaignStatus === "PUBLISHED" || campaign.campaignStatus === "PAUSED";
  const canVersion =
    campaign.publishedVersionId !== null &&
    campaign.draftVersionId === null &&
    campaign.campaignStatus !== "CANCELLED";

  // ONE version line, in words. Never a second status vocabulary.
  const versionLine = isPublishedView
    ? `Version ${campaign.publishedVersionNumber ?? "—"} · published`
    : `Version ${campaign.draftVersionNumber ?? "—"} · draft, not yet published`;

  const periodLine =
    config.startsAt === null
      ? "No schedule set"
      : `${formatDay(config.startsAt, zone)} — ${
          config.endsAt === null ? "no end date" : formatDay(config.endsAt, zone)
        }`;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <BackLink href="/campaigns">Campaigns</BackLink>

      {/* ================= HEADER ================= */}
      <header className="mt-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {/* THE authoritative status. There is no second one on this page. */}
              <CampaignStateBadge state={campaign.derivedState} />
              {campaign.draftVersionId !== null && isPublishedView && (
                <Badge tone="indigo">Draft changes waiting</Badge>
              )}
            </div>

            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
              {campaign.name}
            </h1>

            {campaign.description && (
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-600">
                {campaign.description}
              </p>
            )}

            {/* Secondary metadata — labelled as what it is, so it cannot be read as a
                second status. */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>{versionLine}</span>
              <span aria-hidden="true">·</span>
              <span>{periodLine}</span>
              {zone && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{zone}</span>
                </>
              )}
            </div>
          </div>

          {/* ONE primary action, ONE secondary. The destructive action is not here — it
              lives in its own area at the foot of the page. */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {canPublish && (
              <CampaignLifecycleDialog
                campaignId={campaign.campaignId}
                kind="PUBLISH"
              />
            )}
            {canResume && (
              <CampaignLifecycleDialog campaignId={campaign.campaignId} kind="RESUME" />
            )}
            {canPause && (
              <CampaignLifecycleDialog campaignId={campaign.campaignId} kind="PAUSE" />
            )}
            {campaign.draftVersionId !== null && (
              <Link
                href={`/campaigns/${campaign.campaignId}/edit`}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                Edit draft
              </Link>
            )}
            {canVersion && (
              <CampaignLifecycleDialog
                campaignId={campaign.campaignId}
                kind="NEW_VERSION"
              />
            )}
          </div>
        </div>
      </header>

      {/* ================= NOTICES ================= */}
      {campaign.campaignStatus === "CANCELLED" && (
        <Alert tone="warning" className="mt-6" title="This campaign is cancelled">
          It no longer applies to any sale. Its configuration and history are kept, and
          Retailers can still see that it ran.
        </Alert>
      )}

      {campaign.draftVersionId !== null && campaign.publishedVersionId !== null && (
        <Alert tone="info" className="mt-6" title="A newer version is being prepared">
          Version {campaign.publishedVersionNumber} keeps running and stays visible to
          Retailers until you publish version {campaign.draftVersionNumber}.
        </Alert>
      )}

      {/* The eligibility answer for a draft, with the correct blocked/partial wording and
          a route back to the step that fixes it. */}
      {previewRows.length > 0 && (
        <EligibilityPanel
          className="mt-6"
          rows={previewRows}
          productScope={config.productScope}
          selectedProductCount={
            products.status === "ok" ? products.products.length : 0
          }
        />
      )}

      {/* ================= SUMMARY ================= */}
      <section className="mt-6">
        <h2 className="sr-only">Campaign summary</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FactTile
            icon={<RewardIcon className="h-4 w-4" />}
            tone="indigo"
            label="Reward"
            value={reward ?? "Not set"}
          />
          <FactTile
            icon={<UsersIcon className="h-4 w-4" />}
            label="Measured"
            value={performancePlainLabel(config.performanceScope)}
            detail={performanceExplanation(config.performanceScope)}
          />
          <FactTile
            icon={<RetailersIcon className="h-4 w-4" />}
            label="Audience"
            value={audienceLabel(config.audienceMode)}
            detail={
              isPublishedView
                ? `${config.eligibleRetailerCount} ${
                    config.eligibleRetailerCount === 1 ? "Retailer" : "Retailers"
                  } frozen at publication`
                : "Frozen when you publish"
            }
          />
          <FactTile
            icon={<ProductsIcon className="h-4 w-4" />}
            label="Products"
            value={productScopePlainLabel(config.productScope)}
            detail={productResolutionLabel(config.productEligibilityResolution)}
          />
          <FactTile
            icon={<CalendarIcon className="h-4 w-4" />}
            label="Schedule"
            value={periodLine}
            detail={zone}
          />
          <FactTile
            icon={<CampaignsIcon className="h-4 w-4" />}
            tone={config.stackingMode === "EXCLUSIVE" ? "amber" : "slate"}
            label="Stacking"
            value={stackingLabel(config.stackingMode)}
            detail={stackingExplanation(config.stackingMode)}
          />
        </div>

        {rewardSentence && (
          <p className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-3 text-sm font-medium leading-relaxed text-indigo-950">
            {rewardSentence}
          </p>
        )}

        {config.performanceScope === "RETAILER_TEAM" && (
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {RETAILER_TEAM_INDEPENDENCE}
          </p>
        )}

        <CalculationEngineNotice className="mt-3" />
      </section>

      {/* ================= DETAIL PANELS ================= */}
      <div className="mt-6 space-y-3">
        <DetailPanel
          title="Audience and targeting"
          description="What was selected when this version was authored."
          count={
            config.audienceMode === "SELECTED_RETAILERS"
              ? `${config.eligibleRetailerCount} eligible`
              : undefined
          }
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label="Audience mode">{audienceLabel(config.audienceMode)}</Fact>
            <Fact label="Eligible Retailers">
              {isPublishedView
                ? `${config.eligibleRetailerCount} frozen at publication`
                : "Resolved when you publish"}
            </Fact>
          </dl>

          {config.audienceMode === "SELECTED_RETAILERS" && (
            <div className="mt-4">
              <p className="text-xs font-medium text-slate-500">Selected Retailers</p>
              {retailers.status === "ok" && retailers.retailers.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {retailers.retailers.map((retailer) => {
                    const inactive =
                      retailer.retailerStatus !== "ACTIVE" ||
                      retailer.relationshipStatus !== "ACTIVE";
                    return (
                      <li key={retailer.vendorRetailerId}>
                        <span
                          className={
                            inactive
                              ? "inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1 text-sm text-amber-900 ring-1 ring-inset ring-amber-600/20"
                              : "inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 text-sm text-slate-700"
                          }
                        >
                          {retailer.retailerName}
                          {inactive && (
                            <span className="text-xs font-medium">Inactive</span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-slate-500">
                  No Retailers were selected.
                </p>
              )}
            </div>
          )}

          {config.audienceMode === "RETAILER_GROUPS" && (
            <div className="mt-4">
              <p className="text-xs font-medium text-slate-500">Retailer groups</p>
              {groups.status === "ok" && groups.groups.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {groups.groups.map((group) => (
                    <li
                      key={group.groupId}
                      className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"
                    >
                      <Link
                        href={`/campaigns/groups/${group.groupId}`}
                        className="text-sm font-medium text-indigo-600 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        {group.name}
                      </Link>
                      <span className="text-xs text-slate-500">
                        {group.memberCount}{" "}
                        {group.memberCount === 1 ? "Retailer" : "Retailers"} today
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-slate-500">No groups were selected.</p>
              )}

              {isPublishedView && (
                <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                  Changing a group now does <strong>not</strong> change this published
                  campaign — its eligibility was frozen at publication. Create a new
                  version to pick the change up.
                </p>
              )}
            </div>
          )}
        </DetailPanel>

        <DetailPanel
          title="Product eligibility"
          description={productResolutionLabel(config.productEligibilityResolution)}
          count={
            config.productScope === "SELECTED_PRODUCTS" && products.status === "ok"
              ? `${products.products.length} selected`
              : undefined
          }
        >
          <p className="text-sm leading-relaxed text-slate-700">
            {productResolutionExplanation(config.productEligibilityResolution)}
          </p>

          {config.productScope === "SELECTED_PRODUCTS" && products.status === "ok" && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-md border-collapse text-left text-sm">
                <caption className="sr-only">
                  Products selected for this campaign version
                </caption>
                <thead className="border-b border-slate-200 text-xs font-medium text-slate-500">
                  <tr>
                    <th scope="col" className="px-2 py-2">
                      Product
                    </th>
                    <th scope="col" className="px-2 py-2">
                      Code
                    </th>
                    <th scope="col" className="px-2 py-2">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {products.products.map((product) => (
                    <tr key={product.productId}>
                      <td className="px-2 py-2 font-medium text-slate-900">
                        {product.productName}
                        {product.brand && (
                          <span className="ml-1.5 font-normal text-slate-500">
                            {product.brand}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 font-mono text-xs text-slate-500">
                        {product.productCode}
                      </td>
                      <td className="px-2 py-2">
                        {product.productStatus === "ACTIVE" ? (
                          <Badge tone="emerald">Active</Badge>
                        ) : (
                          <Badge tone="amber">Inactive</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DetailPanel>

        <DetailPanel title="Rules and reward">
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label="Reward">{reward ?? "Not set"}</Fact>
            <Fact label="Measured">
              {performancePlainLabel(config.performanceScope)}
            </Fact>
            <Fact label="Rewarded to">Contributing Sales Staff</Fact>
            <Fact label="Counting">Eligible units sold</Fact>
          </dl>
          {rewardSentence && (
            <p className="mt-4 text-sm leading-relaxed text-slate-700">
              {rewardSentence}
            </p>
          )}
          <CalculationEngineNotice className="mt-3" />
        </DetailPanel>

        <DetailPanel
          title="Schedule and stacking"
          description="Times are shown in the campaign's own time zone."
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label="Starts">{formatInstant(config.startsAt, zone)}</Fact>
            <Fact label="Ends">
              {config.endsAt === null
                ? "No end date"
                : formatInstant(config.endsAt, zone)}
            </Fact>
            <Fact label="Time zone">{zone}</Fact>
            <Fact label="Stacking">
              {stackingLabel(config.stackingMode)}
              <span className="mt-0.5 block text-xs text-slate-500">
                {stackingExplanation(config.stackingMode)}
              </span>
            </Fact>
            {config.stackingMode === "EXCLUSIVE" && (
              <>
                {/* VENDOR-PRIVATE. No assigned-visibility RPC returns either of these. */}
                <Fact label="Exclusivity key">{config.exclusivityKey ?? "—"}</Fact>
                <Fact label="Priority">{config.priority}</Fact>
              </>
            )}
          </dl>
        </DetailPanel>

        {isPublishedView && (
          <DetailPanel
            title="Eligibility at publication"
            description={
              config.productEligibilityResolution === "SNAPSHOT"
                ? "Retailers and products were both frozen when this version was published."
                : "Retailers were frozen at publication. Products are not: this campaign covers whatever is eligible at the time of each verified sale."
            }
            count={
              eligible.status === "ok"
                ? `${eligible.retailers.length} ${
                    eligible.retailers.length === 1 ? "Retailer" : "Retailers"
                  }`
                : undefined
            }
          >
            {eligible.status !== "ok" ? (
              <Alert tone="warning" role="alert">
                The eligibility snapshot could not be loaded. The campaign itself is
                unaffected.
              </Alert>
            ) : eligible.retailers.length === 0 ? (
              <p className="text-sm text-slate-500">No Retailers were resolved.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-md border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Retailers this campaign version applies to
                  </caption>
                  <thead className="border-b border-slate-200 text-xs font-medium text-slate-500">
                    <tr>
                      <th scope="col" className="px-2 py-2">
                        Retailer
                      </th>
                      <th scope="col" className="px-2 py-2">
                        Included via
                      </th>
                      <th scope="col" className="px-2 py-2">
                        Eligible products
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {eligible.retailers.map((row) => (
                      <tr key={row.vendorRetailerId}>
                        <td className="px-2 py-2 font-medium text-slate-900">
                          {row.retailerName}
                        </td>
                        <td className="px-2 py-2 text-slate-600">
                          {row.source === "ALL_RETAILERS"
                            ? "All Retailers"
                            : row.source === "DIRECT_SELECTION"
                              ? "Direct selection"
                              : (row.sourceGroupName ?? "Retailer group")}
                        </td>
                        <td className="px-2 py-2 text-slate-600">
                          {/* A LIVE_TEMPORAL campaign has no frozen per-Retailer count,
                              and printing the snapshot's zero would read as "no
                              products". */}
                          {config.productEligibilityResolution === "LIVE_TEMPORAL" ? (
                            <span className="text-slate-500">
                              Eligible at time of sale
                            </span>
                          ) : row.eligibleProductCount === 0 ? (
                            <span className="font-medium text-amber-800">
                              0 — nothing to earn on
                            </span>
                          ) : (
                            row.eligibleProductCount
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DetailPanel>
        )}

        <DetailPanel title="History" description="Server-recorded facts.">
          <dl className="grid gap-4 sm:grid-cols-3">
            <Fact label="Versions">{campaign.versionCount}</Fact>
            <Fact label="Created">{formatInstant(campaign.createdAt, zone)}</Fact>
            <Fact label="Last updated">{formatInstant(campaign.updatedAt, zone)}</Fact>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-slate-500">
            Every campaign action is recorded in{" "}
            <Link
              href="/audit-logs"
              className="font-medium text-indigo-600 hover:text-indigo-700"
            >
              Audit Logs
            </Link>
            . Nothing on this page is a sales or reward total.
          </p>
        </DetailPanel>
      </div>

      {/* ================= DANGER AREA =================
          Cancellation is terminal, so it is kept out of the header entirely rather than
          sitting a few pixels from Publish with the same visual weight. */}
      {canCancel && (
        <section
          className={cardClasses(
            "standard",
            "mt-8 flex flex-col gap-3 border-red-200 p-4 sm:flex-row sm:items-center sm:justify-between",
          )}
        >
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">Cancel this campaign</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-600">
              Stops it applying to any further sale. This cannot be undone, and the
              campaign cannot be resumed or versioned afterwards.
            </p>
          </div>
          <div className="shrink-0">
            <CampaignLifecycleDialog campaignId={campaign.campaignId} kind="CANCEL" />
          </div>
        </section>
      )}
    </div>
  );
}
