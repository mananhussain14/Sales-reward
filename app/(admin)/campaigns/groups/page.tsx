import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getRetailerGroups } from "@/lib/campaigns/retailer-groups";
import { getVendorRetailers } from "@/lib/retailers/vendor-retailers";
import { CreateGroupForm } from "@/app/(admin)/campaigns/groups/group-forms";
import type { SelectableRetailer } from "@/app/(admin)/campaigns/campaign-wizard";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SectionCard, cardClasses } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { BackLink, PageHeader, SectionHeader } from "@/components/ui/page-header";
import { ChevronRightIcon, GroupsIcon, StoreIcon } from "@/components/ui/icons";

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
 * CREATION IS ONE FLOW. The form below takes the name, the description and the Retailers
 * together and lands the operator on the finished group. It previously created an empty
 * group and left them to find it, open it and save a second time.
 *
 * Every group shown belongs to the calling Vendor. list_vendor_retailer_groups() derives
 * the Vendor from auth.uid() and takes no arguments, so there is no id to tamper with.
 */
export default async function RetailerGroupsPage() {
  const [result, retailerResult] = await Promise.all([
    getRetailerGroups(),
    getVendorRetailers(),
  ]);

  // Directly addressable, so it re-resolves rather than trusting the layout. A caller
  // whose role lacks RETAILER_GROUPS_MANAGE is refused here — fails closed.
  if (result.status === "denied") {
    redirect("/access-denied");
  }

  // `retailers: null` means the directory could not be read — never treated as empty,
  // because an empty list would silently offer a group with nobody in it.
  const retailerRows =
    retailerResult.status === "authorized" && retailerResult.retailers !== null
      ? retailerResult.retailers
      : null;

  const selectable: SelectableRetailer[] = (retailerRows ?? []).map((retailer) => {
    const inactive =
      retailer.relationshipStatus !== "ACTIVE" || retailer.retailerStatus !== "ACTIVE";
    return {
      vendorRetailerId: retailer.relationshipId,
      retailerName: retailer.retailerName,
      isSelectable: !inactive,
      statusNote: inactive ? "Inactive — cannot be added" : null,
    };
  });

  const groups = result.status === "ok" ? result.groups : [];
  const activeCount = groups.filter((group) => group.status === "ACTIVE").length;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <BackLink href="/campaigns">Campaigns</BackLink>

      <PageHeader
        className="mt-3"
        title="Retailer groups"
        description="Reusable sets of your connected Retailers. Target a campaign at a group instead of picking Retailers one at a time."
      />

      <SectionCard
        className="mt-6"
        title="New group"
        description="Name it and choose its Retailers together — you will land on the finished group."
      >
        <CreateGroupForm retailers={selectable} optionsReady={retailerRows !== null} />
      </SectionCard>

      <SectionHeader
        className="mt-10"
        title="Your groups"
        description="Editing a group never changes a campaign that is already published through it."
        action={
          groups.length > 0 ? (
            <span className="text-sm text-slate-500">
              {activeCount} active of {groups.length}
            </span>
          ) : undefined
        }
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
      ) : groups.length === 0 ? (
        <EmptyState
          className="mt-4"
          icon={<GroupsIcon className="h-6 w-6" />}
          tone="indigo"
          title="No groups yet"
          description="Create a group above to target several Retailers at once, and reuse it on every campaign that should reach the same shops."
        />
      ) : (
        <ul className="mt-4 grid gap-3 sm:grid-cols-2">
          {groups.map((group) => (
            <li key={group.groupId}>
              {/* The WHOLE card is the link, so the target is large, obvious and a single
                  keyboard stop rather than several. */}
              <Link
                href={`/campaigns/groups/${group.groupId}`}
                className={cardClasses(
                  "interactive",
                  "flex h-full flex-col p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-slate-900">
                      {group.name}
                    </h3>
                    {group.description ? (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-slate-500">
                        {group.description}
                      </p>
                    ) : (
                      <p className="mt-1 text-xs italic text-slate-400">
                        No description
                      </p>
                    )}
                  </div>
                  {group.status === "ARCHIVED" ? (
                    <Badge tone="slate">Archived</Badge>
                  ) : (
                    <Badge tone="emerald">Active</Badge>
                  )}
                </div>

                <div className="mt-auto flex items-end justify-between gap-3 pt-4">
                  <div className="min-w-0">
                    <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                      <StoreIcon
                        className="h-4 w-4 text-slate-400"
                        aria-hidden="true"
                      />
                      {group.memberCount}{" "}
                      <span className="font-normal text-slate-500">
                        {group.memberCount === 1 ? "Retailer" : "Retailers"}
                      </span>
                    </p>
                    {/* The number an operator needs BEFORE they change the Retailers. */}
                    <p className="mt-0.5 text-xs text-slate-500">
                      {group.campaignRefCount === 0
                        ? "Not used by a campaign"
                        : `Used by ${group.campaignRefCount} campaign ${
                            group.campaignRefCount === 1 ? "version" : "versions"
                          }`}
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-semibold text-indigo-600">
                    View
                    <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
