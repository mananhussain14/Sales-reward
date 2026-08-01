import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getVendorCampaigns } from "@/lib/campaigns/vendor-campaigns";
import { CampaignList } from "@/app/(admin)/campaigns/campaign-list";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { CampaignsIcon, GroupsIcon, PlusIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Campaigns · Vendor Admin",
  description: "Create, publish and manage your incentive campaigns.",
};

/**
 * The Vendor campaign dashboard.
 *
 * WHAT THIS PAGE DOES NOT SHOW, and could not: any campaign belonging to another Vendor,
 * and any progress or coin figure. list_vendor_campaigns() derives the Vendor from
 * auth.uid() and takes no arguments, so there is no id to tamper with; and it returns
 * campaign CONFIGURATION only — units sold and coins earned are a later milestone and
 * have no column anywhere in this schema.
 *
 * The whole list is fetched and filtered in the browser. That is safe precisely because
 * the server already scoped it: a filter cannot widen a result, only narrow one.
 */
export default async function CampaignsPage() {
  const result = await getVendorCampaigns();

  // The layout has already resolved Vendor Admin access, but this page is directly
  // addressable and must not depend on that. A caller whose role lacks CAMPAIGNS_MANAGE
  // reaches the layout fine and is refused here — fails closed.
  if (result.status === "denied") {
    redirect("/access-denied");
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title="Campaigns"
        description="Reward rules you publish to your Retailers. Results and coin calculations arrive with the calculation engine."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/campaigns/groups"
              className={buttonClasses({ variant: "outline" })}
            >
              <GroupsIcon className="h-4 w-4" aria-hidden="true" />
              Retailer groups
            </Link>
            <Link href="/campaigns/new" className={buttonClasses({ variant: "primary" })}>
              <PlusIcon className="h-4 w-4" aria-hidden="true" />
              New campaign
            </Link>
          </div>
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
      ) : result.campaigns.length === 0 ? (
        <EmptyState
          className="mt-8"
          icon={<CampaignsIcon className="h-6 w-6" />}
          title="No campaigns yet"
          description="Create a campaign to offer your Retailers' Sales Staff coins for eligible sales. Nothing is visible to a Retailer until you publish it."
          action={
            <Link href="/campaigns/new" className={buttonClasses({ variant: "primary" })}>
              <PlusIcon className="h-4 w-4" aria-hidden="true" />
              New campaign
            </Link>
          }
        />
      ) : (
        <CampaignList campaigns={result.campaigns} />
      )}
    </div>
  );
}
