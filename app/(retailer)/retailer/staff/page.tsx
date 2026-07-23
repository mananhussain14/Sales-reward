import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import {
  getRetailerStaffAssignableShops,
  getRetailerStaffInvitations,
} from "@/lib/staff/retailer-staff-data";
import { getRetailerStaffMembers } from "@/lib/staff/retailer-staff-data";
import {
  canResendInvitation,
  canRevokeInvitation,
  describeIntendedShops,
  staffInvitationStateLabel,
  type AssignableShop,
  type StaffInvitation,
  type StaffMember,
} from "@/lib/staff/staff-normalization";
import { retailerRoleDisplayName } from "@/lib/staff/staff-roles";
import {
  showsInvitationSection,
  showsInviteForm,
  showsInviteSection,
} from "@/lib/staff/portal-access-decision";
import { formatOwnerTimestamp } from "@/lib/retailers/owner-status-normalization";
import { StatusBadge } from "@/components/admin/status-badge";
import { InviteStaffForm } from "@/app/(retailer)/retailer/staff/invite-staff-form";
import {
  ResendInvitationForm,
  RevokeInvitationForm,
} from "@/app/(retailer)/retailer/staff/invitation-controls";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { cardClasses } from "@/components/ui/card";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import {
  CheckIcon,
  ClockIcon,
  InboxIcon,
  LocationIcon,
  StaffIcon,
} from "@/components/ui/icons";
import { InitialsAvatar } from "@/components/ui/avatar";

export const metadata: Metadata = {
  title: "Staff · Retailer Portal",
  description: "Your Retailer's staff roster and invitations on SalesReward.",
};

/**
 * The Retailer staff-management experience: Active Staff, Invitations, Invite Staff.
 *
 * AUTHORIZATION IS RESOLVED HERE, AT THIS PAGE'S OWN SERVER BOUNDARY, and again by
 * every RPC behind every section. The page is directly addressable, so its state must
 * come from the verified session rather than from how the caller arrived. React
 * `cache` makes the repeat resolution free — the layout and this page share one.
 *
 * WHAT EACH ROLE SEES, AND WHY IT IS NOT A ROLE CHECK IN THIS FILE.
 *   Owner    roster + invitations + invite form. Holds RETAILER_STAFF_READ,
 *            RETAILER_STAFF_MANAGE and RETAILER_STAFF_SHOP_ASSIGN.
 *   Manager  roster only. Holds RETAILER_STAFF_READ; the other two RPCs answer
 *            `denied`, so the invitation list and the invite form are not rendered —
 *            because the DATA is refused, not because a role string was compared.
 *   Sales    no access at all: neither mapping, so the layout has already redirected.
 * There is no role name in any branch below. Each section renders if and only if its
 * own authorized read succeeded, which is why a permission-mapping change in SQL
 * changes this page's behaviour without this file being edited.
 */

/** A member's display name. Both parts are NOT NULL in the database. */
function memberName(member: StaffMember): string {
  return `${member.firstName} ${member.lastName}`;
}

function invitationName(invitation: StaffInvitation): string {
  return `${invitation.firstName} ${invitation.lastName}`;
}

/**
 * Renders a state label as a status pill. Not StatusBadge — different vocabulary.
 * The label comes from the single centralized map (staffInvitationStateLabel); the
 * tone and icon are presentation only and nothing branches on them.
 */
function InvitationStateBadge({ invitation }: { invitation: StaffInvitation }) {
  const tone: BadgeTone =
    invitation.state === "ACCEPTED"
      ? "emerald"
      : invitation.state === "DELIVERY_FAILED"
        ? "amber"
        : invitation.state === "PENDING" || invitation.state === "RESERVED"
          ? "indigo"
          : "slate";

  const icon =
    invitation.state === "ACCEPTED" ? (
      <CheckIcon className="h-3 w-3" />
    ) : invitation.state === "PENDING" || invitation.state === "RESERVED" ? (
      <ClockIcon className="h-3 w-3" />
    ) : undefined;

  return (
    <Badge tone={tone} icon={icon}>
      {staffInvitationStateLabel(invitation.state)}
    </Badge>
  );
}

/** A role shown as a subtle pill. Presentation only — nothing branches on it. */
function RoleBadge({ label }: { label: string }) {
  return <Badge tone="indigo">{label}</Badge>;
}

/** The shops a roster row is assigned to, rendered as chips, or an em dash. */
function ShopBadges({ names }: { names: string[] }) {
  if (names.length === 0) {
    return (
      <span className="text-slate-400" aria-label="No shops assigned">
        —
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {names.map((name, index) => (
        <Badge key={`${name}-${index}`} tone="slate">
          <LocationIcon className="h-3 w-3" />
          {name}
        </Badge>
      ))}
    </span>
  );
}

/** A generic, retry-safe panel for a read that failed. Never names a cause. */
function ReadUnavailable({ heading }: { heading: string }) {
  return (
    <Alert tone="warning" role="alert" title={heading}>
      Something went wrong while loading this. Please try again in a moment.
    </Alert>
  );
}

function EmptyPanel({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon?: React.ReactNode;
}) {
  return <EmptyState icon={icon} title={title} description={body} />;
}

const thClasses = "px-4 py-3 font-semibold";
const tdClasses = "px-4 py-3 text-slate-600";

export default async function RetailerStaffPage() {
  const access = await getRetailerPortalAccess();

  // The layout has already handled each of these, but this page is directly
  // addressable and must not depend on that. The branches are identical, so the two
  // boundaries can never disagree.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }
  if (access.status === "unavailable") {
    throw new Error("Retailer portal context is temporarily unavailable.");
  }

  const isOwner = access.kind === "owner";

  // The roster is read for everyone the layout admitted. The other two reads are
  // issued only for an owner — not to hide anything (they would answer `denied`
  // anyway), but because issuing a call whose refusal is already known is a wasted
  // round trip on every page load.
  const [members, invitations, assignable] = await Promise.all([
    getRetailerStaffMembers(),
    isOwner
      ? getRetailerStaffInvitations()
      : Promise.resolve({ status: "denied" } as const),
    isOwner
      ? getRetailerStaffAssignableShops()
      : Promise.resolve({ status: "denied" } as const),
  ]);

  const assignableShops: AssignableShop[] =
    assignable.status === "ok" ? assignable.shops : [];

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader
        title="Staff"
        description={
          isOwner
            ? "The people who work at your Retailer, and the invitations you have sent."
            : "The people who work at your Retailer."
        }
      />

      {/* ---------------------------------------------------------------- */}
      {/* Active staff                                                      */}
      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="roster-heading" className="mt-8">
        <SectionHeader
          title={
            <span id="roster-heading" className="inline-flex items-center gap-2.5">
              Active staff
              {members.status === "ok" && members.members.length > 0 && (
                <Badge tone="slate">{members.members.length}</Badge>
              )}
            </span>
          }
        />

        {members.status !== "ok" ? (
          <div className="mt-3">
            <ReadUnavailable heading="Staff could not be loaded" />
          </div>
        ) : members.members.length === 0 ? (
          <div className="mt-3">
            <EmptyPanel
              icon={<StaffIcon className="h-6 w-6" />}
              title="No staff yet"
              body={
                isOwner
                  ? "Invite your first Retailer Manager or Sales Staff member below."
                  : "No one has joined this Retailer yet."
              }
            />
          </div>
        ) : (
          <>
            {/* Desktop table. Horizontally scrollable rather than wrapping. */}
            <div className={cardClasses("standard", "mt-3 hidden overflow-hidden sm:block")}>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Staff members at your Retailer
                  </caption>
                  <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className={thClasses}>
                        Name
                      </th>
                      <th scope="col" className={thClasses}>
                        Role
                      </th>
                      <th scope="col" className={thClasses}>
                        Shops
                      </th>
                      <th scope="col" className={thClasses}>
                        Status
                      </th>
                      <th scope="col" className={thClasses}>
                        Joined
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {/* Rendered in the RPC's own order. Nothing is re-sorted here —
                        a second, locale-dependent ordering could disagree with the
                        database's. The membership id is the stable key. */}
                    {members.members.map((member) => (
                      <tr key={member.membershipId} className="transition-colors hover:bg-slate-50">
                        <td className="whitespace-nowrap px-4 py-3">
                          <span className="flex items-center gap-3">
                            <InitialsAvatar name={memberName(member)} size="sm" />
                            <span className="font-medium text-slate-900">
                              {memberName(member)}
                            </span>
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <RoleBadge
                            label={retailerRoleDisplayName(member.roleCode, member.roleName)}
                          />
                        </td>
                        <td className={tdClasses}>
                          <ShopBadges names={member.shopNames} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <StatusBadge status={member.membershipStatus} />
                        </td>
                        <td className={`whitespace-nowrap ${tdClasses}`}>
                          {formatOwnerTimestamp(member.joinedAt ?? member.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile: stacked cards. A five-column table is unreadable below `sm`. */}
            <ul className="mt-3 flex flex-col gap-3 sm:hidden">
              {members.members.map((member) => (
                <li key={member.membershipId} className={cardClasses("standard", "p-4")}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <InitialsAvatar name={memberName(member)} size="md" />
                      <p className="min-w-0 flex-1 text-sm font-medium text-slate-900">
                        {memberName(member)}
                      </p>
                    </div>
                    <StatusBadge status={member.membershipStatus} />
                  </div>
                  <dl className="mt-3 flex flex-col gap-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-slate-500">Role</dt>
                      <dd>
                        <RoleBadge
                          label={retailerRoleDisplayName(member.roleCode, member.roleName)}
                        />
                      </dd>
                    </div>
                    <div className="flex items-start justify-between gap-3">
                      <dt className="text-slate-500">Shops</dt>
                      <dd className="flex justify-end text-right">
                        <ShopBadges names={member.shopNames} />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Joined</dt>
                      <dd className="text-slate-700">
                        {formatOwnerTimestamp(member.joinedAt ?? member.createdAt)}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Invitations — owner only, because only an owner's read succeeds    */}
      {/* ---------------------------------------------------------------- */}
      {showsInvitationSection(invitations.status) && (
        <section aria-labelledby="invitations-heading" className="mt-10">
          <SectionHeader
            title={
              <span id="invitations-heading" className="inline-flex items-center gap-2.5">
                Invitations
                {invitations.status === "ok" && invitations.invitations.length > 0 && (
                  <Badge tone="amber">{invitations.invitations.length}</Badge>
                )}
              </span>
            }
          />

          {invitations.status !== "ok" ? (
            <div className="mt-3">
              <ReadUnavailable heading="Invitations could not be loaded" />
            </div>
          ) : invitations.invitations.length === 0 ? (
            <div className="mt-3">
              <EmptyPanel
                icon={<InboxIcon className="h-6 w-6" />}
                title="No invitations yet"
                body="Invitations you send will appear here, along with their status."
              />
            </div>
          ) : (
            <div className={cardClasses("standard", "mt-3 overflow-hidden")}>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-sm">
                  <caption className="sr-only">
                    Staff invitations for your Retailer
                  </caption>
                  <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className={thClasses}>
                        Recipient
                      </th>
                      <th scope="col" className={thClasses}>
                        Role
                      </th>
                      <th scope="col" className={thClasses}>
                        Shops
                      </th>
                      <th scope="col" className={thClasses}>
                        State
                      </th>
                      <th scope="col" className={thClasses}>
                        Dates
                      </th>
                      <th scope="col" className={thClasses}>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {invitations.invitations.map((invitation) => {
                      const shops = describeIntendedShops(
                        invitation.shopIds,
                        assignableShops,
                      );
                      const label = invitationName(invitation);

                      return (
                        <tr
                          key={invitation.invitationId}
                          className="transition-colors hover:bg-slate-50"
                        >
                          <td className="px-4 py-3">
                            <span className="block font-medium text-slate-900">
                              {label}
                            </span>
                            <span className="block text-xs text-slate-500">
                              {invitation.email}
                            </span>
                          </td>
                          <td className={`whitespace-nowrap ${tdClasses}`}>
                            {retailerRoleDisplayName(invitation.roleCode)}
                          </td>
                          <td className={tdClasses}>
                            {shops.names.length === 0 &&
                            shops.unavailableCount === 0 ? (
                              <span className="text-slate-400" aria-label="No shops">
                                —
                              </span>
                            ) : (
                              <>
                                {shops.names.join(", ")}
                                {shops.unavailableCount > 0 && (
                                  <span className="block text-xs text-amber-700">
                                    {shops.unavailableCount} shop
                                    {shops.unavailableCount === 1 ? "" : "s"} no longer
                                    available
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <InvitationStateBadge invitation={invitation} />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">
                            <span className="block">
                              Created {formatOwnerTimestamp(invitation.createdAt)}
                            </span>
                            {invitation.state === "ACCEPTED" ? (
                              <span className="block">
                                Accepted {formatOwnerTimestamp(invitation.acceptedAt)}
                              </span>
                            ) : invitation.state === "REVOKED" ? (
                              <span className="block">
                                Revoked {formatOwnerTimestamp(invitation.revokedAt)}
                              </span>
                            ) : (
                              <>
                                {invitation.sentAt && (
                                  <span className="block">
                                    Sent {formatOwnerTimestamp(invitation.sentAt)}
                                  </span>
                                )}
                                <span className="block">
                                  Expires {formatOwnerTimestamp(invitation.expiresAt)}
                                </span>
                              </>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            {/* Accepted, expired and revoked rows are history: no
                                control is rendered at all. The RPCs refuse those
                                states independently. */}
                            <div className="flex items-start gap-2">
                              {canResendInvitation(invitation.state) && (
                                <ResendInvitationForm
                                  invitationId={invitation.invitationId}
                                  recipientLabel={label}
                                />
                              )}
                              {canRevokeInvitation(invitation.state) && (
                                <RevokeInvitationForm
                                  invitationId={invitation.invitationId}
                                  recipientLabel={label}
                                />
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Invite staff — owner only, for the same reason                     */}
      {/* ---------------------------------------------------------------- */}
      {showsInviteSection(assignable.status) && (
        <section aria-labelledby="invite-heading" className="mt-10">
          <SectionHeader
            title={<span id="invite-heading">Invite staff</span>}
            description="Send an invitation to join your Retailer. They will accept it by signing in with the email address you enter."
          />

          <div className={cardClasses("standard", "mt-3 p-5 sm:p-6")}>
            {showsInviteForm(assignable.status) ? (
              <InviteStaffForm shops={assignableShops} />
            ) : (
              <ReadUnavailable heading="The invite form could not be loaded" />
            )}
          </div>
        </section>
      )}
    </div>
  );
}
