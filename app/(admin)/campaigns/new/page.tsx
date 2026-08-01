import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { getWizardOptions } from "@/app/(admin)/campaigns/wizard-options";
import { CampaignWizard } from "@/app/(admin)/campaigns/campaign-wizard";
import { createCampaignDraftAction } from "@/app/(admin)/campaigns/actions";
import { BackLink, PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "New campaign · Vendor Admin",
  description: "Create a campaign draft.",
};

/**
 * The campaign creation wizard.
 *
 * This route CREATES A DRAFT AND NOTHING ELSE. There is no publish control anywhere on
 * it: a new campaign has no version to resolve eligibility against until it is saved, so
 * the true publication preview does not exist yet, and offering a publish button that
 * silently saved first would make the two acts indistinguishable in the audit trail. The
 * wizard hands off to the campaign's own page, where publication has its own
 * confirmation.
 *
 * Access is re-resolved here even though the layout already did it: this route is
 * directly addressable and must not depend on that.
 */
export default async function NewCampaignPage() {
  const access = await getVendorSuperAdminAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  const options = await getWizardOptions();

  return (
    <div className="mx-auto w-full max-w-4xl">
      <BackLink href="/campaigns">Campaigns</BackLink>

      <PageHeader
        className="mt-3"
        title="New campaign"
        description="Six steps. Nothing is visible to a Retailer until you publish, and no coins are calculated in this milestone."
      />

      <CampaignWizard
        mode="create"
        retailers={options.retailers}
        groups={options.groups}
        products={options.products}
        optionsReady={options.optionsReady}
        timeZones={options.timeZones}
        // A campaign that does not exist yet has no version, so there is nothing to
        // resolve a preview against. The campaign page shows one after the draft is saved.
        preview={null}
        action={createCampaignDraftAction}
      />
    </div>
  );
}
