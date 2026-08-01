import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getRetailerGroups } from "@/lib/campaigns/retailer-groups";
import { CreateGroupForm } from "@/app/(admin)/campaigns/groups/group-forms";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SectionCard, cardClasses } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { BackLink, PageHeader, SectionHeader } from "@/components/ui/page-header";
import { GroupsIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Retailer groups · Vendor Admin",
  description: "Reusable groups of Retailers to target campaigns at.",
};

/**
 * Retailer group management.
 *
 * A RETAILER GROUP ANSWERS "WHICH RETAILERS", NEVER "HOW PERFORMANCE IS MEASURED". The
 * second question is a campaign's performance scope — "Retailer team" — and this page is
 * worded so the two are never conflated: the phrase "group campaign" appears nowhere in
 * this product.
 *
 * Every group shown belongs to the calling Vendor. list_vendor_retailer_groups() derives
 * the Vendor from auth.uid() and takes no arguments, so there is no id to tamper with.
 */
export default async function RetailerGroupsPage() {
  const result = await getRetailerGroups();

  // Directly addressable, so it re-resolves rather than trusting the layout. A caller
  // whose role lacks RETAILER_GROUPS_MANAGE is refused here — fails closed.
  if (result.status === "denied") {
    redirect("/access-denied");
  }

  return (
    <div className="mx-auto w-full max-w-4xl">
      <BackLink href="/campaigns">Campaigns</BackLink>

      <PageHeader
        className="mt-3"
        title="Retailer groups"
        description="Reusable sets of your connected Retailers. Choose a group as a campaign's audience instead of picking Retailers one at a time."
      />

      <SectionCard
        className="mt-8"
        title="New group"
        description="Create the group first, then choose its Retailers."
      >
        <CreateGroupForm />
      </SectionCard>

      <SectionHeader
        className="mt-10"
        title="Your groups"
        description="Editing a group never changes a campaign that is already published through it."
      />

      {result.status !== "ok" ? (
        <Alert
          tone="warning"
          role="alert"
          title="Groups could not be loaded"
          className="mt-4"
        >
          Something went wrong while loading your Retailer groups. Please try again in a
          moment.
        </Alert>
      ) : result.groups.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={<GroupsIcon className="h-6 w-6" />}
          title="No groups yet"
          description="Create a group above to target several Retailers at once."
        />
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {result.groups.map((group) => (
            <li key={group.groupId}>
              <Link
                href={`/campaigns/groups/${group.groupId}`}
                className={cardClasses(
                  "interactive",
                  "block p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-900">
                        {group.name}
                      </h3>
                      {group.status === "ARCHIVED" && (
                        <Badge tone="slate">Archived</Badge>
                      )}
                    </div>
                    {group.description && (
                      <p className="mt-1 max-w-xl text-sm text-slate-500">
                        {group.description}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-medium text-slate-700">
                      {group.memberCount}{" "}
                      {group.memberCount === 1 ? "Retailer" : "Retailers"}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {/* The number an operator needs before they change membership. */}
                      {group.campaignRefCount === 0
                        ? "Used by no campaign"
                        : `Used by ${group.campaignRefCount} campaign ${
                            group.campaignRefCount === 1 ? "version" : "versions"
                          }`}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
