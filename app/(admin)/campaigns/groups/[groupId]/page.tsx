import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import {
  getRetailerGroup,
  getRetailerGroupMembers,
} from "@/lib/campaigns/retailer-groups";
import { getVendorRetailers } from "@/lib/retailers/vendor-retailers";
import {
  EditGroupForm,
  GroupMembersForm,
} from "@/app/(admin)/campaigns/groups/group-forms";
import type { SelectableRetailer } from "@/app/(admin)/campaigns/campaign-wizard";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SectionCard } from "@/components/ui/card";
import { BackLink, PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Retailer group · Vendor Admin",
  description: "Edit a Retailer group and its membership.",
};

/**
 * One Retailer group: its details, and its live membership.
 *
 * MEMBERSHIP IS SHOWN LIVE, NOT HISTORICALLY. list_vendor_retailer_group_members() returns
 * only rows with removed_at IS NULL, because this screen EDITS membership and showing a
 * Retailer that has already left alongside the ones that remain would invite an operator
 * to "remove" a row that is already gone. The retired rows survive in the database — that
 * is what lets a published campaign's eligibility still be explained.
 *
 * An unknown group id and another Vendor's group id are the same answer, exactly as in
 * SQL: the route cannot be used to probe which groups exist.
 */
export default async function RetailerGroupDetailPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const access = await getVendorSuperAdminAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  const { groupId } = await params;

  const [groupResult, membersResult, retailerResult] = await Promise.all([
    getRetailerGroup(groupId),
    getRetailerGroupMembers(groupId),
    getVendorRetailers(),
  ]);

  if (groupResult.status === "denied") {
    redirect("/access-denied");
  }
  if (groupResult.status === "not-found") {
    notFound();
  }
  if (groupResult.status !== "ok") {
    throw new Error("Retailer group is temporarily unavailable.");
  }

  const group = groupResult.group;

  // `retailers: null` means the directory could not be loaded — never treated as empty,
  // because an empty list here would let a save wipe the membership.
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
      // An inactive Retailer cannot be ADDED — the database refuses it — but one already
      // in the group can still be removed. The note explains the asymmetry.
      statusNote: inactive ? "Inactive — cannot be added" : null,
    };
  });

  const currentMemberIds =
    membersResult.status === "ok"
      ? membersResult.members.map((member) => member.vendorRetailerId)
      : [];

  // Both reads must have succeeded before a REPLACEMENT is safe to offer: saving against
  // a partial view would remove members the operator never saw.
  const membershipEditable = membersResult.status === "ok" && retailerRows !== null;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <BackLink href="/campaigns/groups">Retailer groups</BackLink>

      <PageHeader
        className="mt-3"
        title={group.name}
        description={group.description ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {group.status === "ARCHIVED" && <Badge tone="slate">Archived</Badge>}
            <span className="text-sm text-slate-500">
              {group.memberCount} {group.memberCount === 1 ? "Retailer" : "Retailers"}
            </span>
          </div>
        }
      />

      {group.campaignRefCount > 0 && (
        <Alert tone="info" className="mt-6" title="This group is used by a campaign">
          {group.campaignRefCount} campaign{" "}
          {group.campaignRefCount === 1 ? "version references" : "versions reference"} this
          group. Changing its membership does <strong>not</strong> change any campaign
          already published through it — publication froze that campaign&apos;s
          eligibility. Create a new campaign version to pick the change up.
        </Alert>
      )}

      <SectionCard className="mt-6" title="Group details">
        <EditGroupForm
          groupId={group.groupId}
          name={group.name}
          description={group.description ?? ""}
          status={group.status}
        />
      </SectionCard>

      <SectionCard
        className="mt-6"
        title="Retailers in this group"
        description="Choose every Retailer this group should contain. Saving replaces the whole membership."
      >
        {membersResult.status !== "ok" && (
          <Alert tone="warning" role="alert" className="mb-4" title="Membership could not be loaded">
            The group details above are unaffected. Refresh before editing membership.
          </Alert>
        )}

        <GroupMembersForm
          // Keyed on the group, so navigating between two groups cannot carry one's
          // selection state into the other's editor.
          key={group.groupId}
          groupId={group.groupId}
          currentMemberIds={currentMemberIds}
          retailers={selectable}
          optionsReady={membershipEditable}
        />
      </SectionCard>
    </div>
  );
}
