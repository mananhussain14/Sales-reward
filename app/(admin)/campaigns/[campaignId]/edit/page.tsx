import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import {
  getCampaignVersion,
  getCampaignVersionGroups,
  getCampaignVersionProducts,
  getCampaignVersionRetailers,
  getPublicationPreview,
  getVendorCampaign,
} from "@/lib/campaigns/vendor-campaigns";
import { getWizardOptions } from "@/app/(admin)/campaigns/wizard-options";
import { CampaignWizard } from "@/app/(admin)/campaigns/campaign-wizard";
import { updateCampaignDraftAction } from "@/app/(admin)/campaigns/actions";
import { isoToWallClock, type CampaignFormValues } from "@/lib/campaigns/campaign-input";
import { BackLink, PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";

export const metadata: Metadata = {
  title: "Edit draft · Vendor Admin",
  description: "Edit a campaign draft before publishing it.",
};

/**
 * The draft editor.
 *
 * ONLY A DRAFT CAN BE EDITED. A published version is immutable — enforced by triggers on
 * every table that describes it, not merely by this page — so a campaign with no draft is
 * sent back to its detail page, where "Create new version" is the correct next step.
 * update_vendor_campaign_draft() refuses the same case independently.
 *
 * The wizard is seeded from the DATABASE'S current draft, never from anything the browser
 * carried between pages: a canonical read is the only source of what the draft says.
 */
export default async function EditCampaignDraftPage({
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
  // An unknown id and another Vendor's id are the same answer here, exactly as they are
  // in SQL — the route cannot be used to probe which campaigns exist.
  if (campaignResult.status === "not-found") {
    notFound();
  }
  if (campaignResult.status !== "ok") {
    throw new Error("Campaign is temporarily unavailable.");
  }

  const campaign = campaignResult.campaign;

  if (campaign.draftVersionId === null) {
    // Nothing to edit. The detail page explains why and offers the right action.
    redirect(`/campaigns/${campaign.campaignId}`);
  }

  const draftVersionId = campaign.draftVersionId;

  const [version, retailers, groups, products, preview, options] = await Promise.all([
    getCampaignVersion(draftVersionId),
    getCampaignVersionRetailers(draftVersionId),
    getCampaignVersionGroups(draftVersionId),
    getCampaignVersionProducts(draftVersionId),
    getPublicationPreview(draftVersionId),
    getWizardOptions(),
  ]);

  if (version.status === "denied") {
    redirect("/access-denied");
  }
  if (version.status !== "ok") {
    throw new Error("Campaign draft is temporarily unavailable.");
  }

  const config = version.version;

  // The wall-clock values the form shows are rendered IN THE CAMPAIGN'S OWN ZONE, so an
  // operator sees the times they typed rather than the same instants translated into
  // whichever zone the server happens to run in.
  const initialValues: CampaignFormValues = {
    name: campaign.name,
    description: campaign.description ?? "",
    audienceMode: config.audienceMode,
    vendorRetailerIds:
      retailers.status === "ok"
        ? retailers.retailers.map((retailer) => retailer.vendorRetailerId)
        : [],
    groupIds: groups.status === "ok" ? groups.groups.map((group) => group.groupId) : [],
    performanceScope: config.performanceScope,
    productScope: config.productScope,
    productIds:
      products.status === "ok" ? products.products.map((product) => product.productId) : [],
    ruleType: config.reward.ruleType ?? "PER_UNIT_COINS",
    coinsPerUnit: config.reward.coinsPerUnit?.toString() ?? "",
    thresholdUnits: config.reward.thresholdUnits?.toString() ?? "",
    rewardCoins: config.reward.rewardCoins?.toString() ?? "",
    maxRewardCoins: config.reward.maxRewardCoins?.toString() ?? "",
    timezoneName: config.timezoneName,
    startsAt: isoToWallClock(config.startsAt, config.timezoneName),
    endsAt:
      config.endsAt === null ? "" : isoToWallClock(config.endsAt, config.timezoneName),
    stackingMode: config.stackingMode,
    exclusivityKey: config.exclusivityKey ?? "",
    priority: config.priority.toString(),
  };

  // A target list that failed to load would silently drop that selection on save, because
  // the wizard submits what it holds. The wizard is told options are not ready, which
  // disables saving entirely.
  const targetsLoaded =
    retailers.status === "ok" && groups.status === "ok" && products.status === "ok";

  return (
    <div className="mx-auto w-full max-w-4xl">
      <BackLink href={`/campaigns/${campaign.campaignId}`}>{campaign.name}</BackLink>

      <PageHeader
        className="mt-3"
        eyebrow={`Version ${campaign.draftVersionNumber ?? ""}`}
        title="Edit draft"
        description={
          campaign.publishedVersionId === null
            ? "This campaign has never been published. Changes stay invisible to Retailers until you publish."
            : "The published version keeps running until you publish this draft."
        }
      />

      {!targetsLoaded && (
        <Alert tone="warning" role="alert" title="Some of this draft could not be loaded" className="mt-6">
          Refresh before saving. Saving now could drop a selection that is not shown.
        </Alert>
      )}

      <CampaignWizard
        mode="edit"
        campaignId={campaign.campaignId}
        initialValues={initialValues}
        retailers={options.retailers}
        groups={options.groups}
        products={options.products}
        optionsReady={options.optionsReady && targetsLoaded}
        timeZones={options.timeZones}
        preview={preview.status === "ok" ? preview.rows : null}
        action={updateCampaignDraftAction}
      />
    </div>
  );
}
