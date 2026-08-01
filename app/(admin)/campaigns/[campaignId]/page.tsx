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
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { SectionCard, cardClasses } from "@/components/ui/card";
import { BackLink, PageHeader } from "@/components/ui/page-header";
import {
  audienceLabel,
  performanceExplanation,
  performanceLabel,
  productScopeLabel,
  rewardSummary,
  stackingExplanation,
  stackingLabel,
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

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">{label}</dt>
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
  const conflicts = preview.status === "ok" ? preview.rows.filter((r) => r.missingProductCount > 0) : [];

  const canPublish = campaign.draftVersionId !== null && campaign.campaignStatus !== "CANCELLED";
  const canPause = campaign.campaignStatus === "PUBLISHED";
  const canResume = campaign.campaignStatus === "PAUSED";
  const canCancel =
    campaign.campaignStatus === "PUBLISHED" || campaign.campaignStatus === "PAUSED";
  const canVersion =
    campaign.publishedVersionId !== null &&
    campaign.draftVersionId === null &&
    campaign.campaignStatus !== "CANCELLED";

  return (
    <div className="mx-auto w-full max-w-5xl">
      <BackLink href="/campaigns">Campaigns</BackLink>

      <PageHeader
        className="mt-3"
        eyebrow={
          isPublishedView
            ? `Version ${campaign.publishedVersionNumber ?? ""} · in force`
            : `Version ${campaign.draftVersionNumber ?? ""} · draft`
        }
        title={campaign.name}
        description={campaign.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <CampaignStateBadge state={campaign.derivedState} />
            {campaign.draftVersionId !== null && (
              <Link
                href={`/campaigns/${campaign.campaignId}/edit`}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                Edit draft
              </Link>
            )}
            {canPublish && (
              <CampaignLifecycleDialog campaignId={campaign.campaignId} kind="PUBLISH" />
            )}
            {canVersion && (
              <CampaignLifecycleDialog
                campaignId={campaign.campaignId}
                kind="NEW_VERSION"
              />
            )}
            {canPause && (
              <CampaignLifecycleDialog campaignId={campaign.campaignId} kind="PAUSE" />
            )}
            {canResume && (
              <CampaignLifecycleDialog campaignId={campaign.campaignId} kind="RESUME" />
            )}
            {canCancel && (
              <CampaignLifecycleDialog campaignId={campaign.campaignId} kind="CANCEL" />
            )}
          </div>
        }
      />

      {campaign.campaignStatus === "CANCELLED" && (
        <Alert tone="warning" className="mt-6" title="This campaign is cancelled">
          It no longer applies to any sale. Its configuration and history are kept, and
          Retailers can still see that it ran.
        </Alert>
      )}

      {campaign.draftVersionId !== null && campaign.publishedVersionId !== null && (
        <Alert tone="info" className="mt-6" title="A draft version is waiting">
          Version {campaign.publishedVersionNumber} keeps running and stays visible to
          Retailers until you publish version {campaign.draftVersionNumber}.
        </Alert>
      )}

      {conflicts.length > 0 && (
        <Alert
          tone="warning"
          className="mt-6"
          title="Some Retailers are missing selected products"
        >
          <ul className="mt-1 space-y-0.5 text-sm">
            {conflicts.map((row) => (
              <li key={row.vendorRetailerId}>
                {row.retailerName} — {row.missingProductCount} of the selected products is
                not assigned to them.
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm">
            Publishing includes only the products actually assigned to each Retailer.
            Nothing unassigned is ever silently included.
          </p>
        </Alert>
      )}

      {/* ---- Summary tiles ---- */}
      <dl className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className={cardClasses("standard", "p-4")}>
          <Detail label="Audience">{audienceLabel(config.audienceMode)}</Detail>
        </div>
        <div className={cardClasses("standard", "p-4")}>
          <Detail label="Measured">{performanceLabel(config.performanceScope)}</Detail>
        </div>
        <div className={cardClasses("standard", "p-4")}>
          <Detail label="Products">{productScopeLabel(config.productScope)}</Detail>
        </div>
        <div className={cardClasses("standard", "p-4")}>
          <Detail label="Reward">{reward ?? "—"}</Detail>
        </div>
      </dl>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* ---- Schedule and stacking ---- */}
        <SectionCard
          title="Schedule and stacking"
          description="Times are shown in the campaign's own time zone."
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail label="Starts">{formatInstant(config.startsAt, zone)}</Detail>
            <Detail label="Ends">
              {config.endsAt === null ? "No end date" : formatInstant(config.endsAt, zone)}
            </Detail>
            <Detail label="Time zone">{zone}</Detail>
            <Detail label="Stacking">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={config.stackingMode === "EXCLUSIVE" ? "amber" : "slate"}>
                  {stackingLabel(config.stackingMode)}
                </Badge>
              </span>
              <span className="mt-1 block text-xs text-slate-500">
                {stackingExplanation(config.stackingMode)}
              </span>
            </Detail>
            {config.stackingMode === "EXCLUSIVE" && (
              <>
                {/* VENDOR-PRIVATE. No assigned-visibility RPC returns either of these. */}
                <Detail label="Exclusivity key">{config.exclusivityKey ?? "—"}</Detail>
                <Detail label="Priority">{config.priority}</Detail>
              </>
            )}
          </dl>
          <p className="mt-4 text-xs text-slate-500">
            {performanceExplanation(config.performanceScope)}
          </p>
        </SectionCard>

        {/* ---- Targeting ---- */}
        <SectionCard
          title="Targeting"
          description="What was selected when this version was authored."
        >
          <dl className="space-y-4">
            <Detail label="Audience mode">{audienceLabel(config.audienceMode)}</Detail>

            {config.audienceMode === "SELECTED_RETAILERS" && (
              <Detail label="Selected Retailers">
                {retailers.status === "ok" && retailers.retailers.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {retailers.retailers.map((retailer) => (
                      <li key={retailer.vendorRetailerId} className="text-sm">
                        {retailer.retailerName}
                        {(retailer.retailerStatus !== "ACTIVE" ||
                          retailer.relationshipStatus !== "ACTIVE") && (
                          <span className="ml-1 text-xs text-amber-700">(inactive)</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
              </Detail>
            )}

            {config.audienceMode === "RETAILER_GROUPS" && (
              <Detail label="Retailer groups">
                {groups.status === "ok" && groups.groups.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {groups.groups.map((group) => (
                      <li key={group.groupId} className="text-sm">
                        <Link
                          href={`/campaigns/groups/${group.groupId}`}
                          className="font-medium text-indigo-600 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                        >
                          {group.name}
                        </Link>
                        <span className="ml-1 text-xs text-slate-500">
                          {group.memberCount} now
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
              </Detail>
            )}

            <Detail label="Product scope">
              {productScopeLabel(config.productScope)}
              {config.productScope === "SELECTED_PRODUCTS" &&
                products.status === "ok" && (
                  <ul className="mt-1 space-y-0.5">
                    {products.products.map((product) => (
                      <li key={product.productId} className="text-sm">
                        {product.productName}
                        <span className="ml-1 font-mono text-xs text-slate-500">
                          {product.productCode}
                        </span>
                        {product.productStatus !== "ACTIVE" && (
                          <span className="ml-1 text-xs text-amber-700">(inactive)</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
            </Detail>
          </dl>

          {config.audienceMode === "RETAILER_GROUPS" && isPublishedView && (
            <p className="mt-4 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Changing a group now does <strong>not</strong> change this published
              campaign. Its eligibility was frozen at publication. Create a new version to
              pick up the change.
            </p>
          )}
        </SectionCard>
      </div>

      {/* ---- Eligibility snapshot ---- */}
      {isPublishedView && (
        <SectionCard
          className="mt-6"
          title="Eligibility at publication"
          description="Frozen when this version was published. Later group and product-assignment changes do not alter it."
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
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">
                  Retailers this campaign version applies to
                </caption>
                <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Retailer
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Included via
                    </th>
                    <th scope="col" className="px-3 py-2 font-semibold">
                      Eligible products
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {eligible.retailers.map((row) => (
                    <tr key={row.vendorRetailerId}>
                      <td className="px-3 py-2 font-medium text-slate-900">
                        {row.retailerName}
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {row.source === "ALL_RETAILERS"
                          ? "All Retailers"
                          : row.source === "DIRECT_SELECTION"
                            ? "Direct selection"
                            : (row.sourceGroupName ?? "Retailer group")}
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {config.productScope === "ALL_ELIGIBLE_PRODUCTS"
                          ? "All assigned products"
                          : row.eligibleProductCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}

      <SectionCard className="mt-6" title="History" description="Server-recorded facts.">
        <dl className="grid gap-4 sm:grid-cols-3">
          <Detail label="Versions">{campaign.versionCount}</Detail>
          <Detail label="Created">{formatInstant(campaign.createdAt, zone)}</Detail>
          <Detail label="Last updated">{formatInstant(campaign.updatedAt, zone)}</Detail>
        </dl>
        <p className="mt-4 text-xs text-slate-500">
          Every campaign action is recorded in{" "}
          <Link
            href="/audit-logs"
            className="font-medium text-indigo-600 hover:text-indigo-700"
          >
            Audit Logs
          </Link>
          . Campaign results and coin calculations will appear when the calculation engine
          is connected — nothing on this page is a sales or reward total.
        </p>
      </SectionCard>
    </div>
  );
}
