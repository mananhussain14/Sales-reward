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

/** Renders a state label as a neutral pill. Not StatusBadge — different vocabulary. */
function InvitationStateBadge({ invitation }: { invitation: StaffInvitation }) {
  const tone =
    invitation.state === "ACCEPTED"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
      : invitation.state === "DELIVERY_FAILED"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
        : invitation.state === "PENDING" || invitation.state === "RESERVED"
          ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300"
          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {staffInvitationStateLabel(invitation.state)}
    </span>
  );
}

/** The shops a roster row is assigned to, or an em dash. */
function ShopList({ names }: { names: string[] }) {
  if (names.length === 0) {
    return (
      <span className="text-zinc-400 dark:text-zinc-600" aria-label="No shops assigned">
        —
      </span>
    );
  }
  return <>{names.join(", ")}</>;
}

/** A generic, retry-safe panel for a read that failed. Never names a cause. */
function ReadUnavailable({ heading }: { heading: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-900/60 dark:bg-amber-950/40"
    >
      <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
        {heading}
      </h3>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
        Something went wrong while loading this. Please try again in a moment.
      </p>
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-950">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{title}</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
        {body}
      </p>
    </div>
  );
}

const thClasses =
  "px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
const tdClasses = "px-5 py-3.5 text-sm text-zinc-600 dark:text-zinc-400";

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
      <header>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Staff
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {isOwner
            ? "The people who work at your Retailer, and the invitations you have sent."
            : "The people who work at your Retailer."}
        </p>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Active staff                                                      */}
      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="roster-heading" className="mt-8">
        <h3
          id="roster-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Active staff
        </h3>

        {members.status !== "ok" ? (
          <div className="mt-3">
            <ReadUnavailable heading="Staff could not be loaded" />
          </div>
        ) : members.members.length === 0 ? (
          <div className="mt-3">
            <EmptyPanel
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
            <div className="mt-3 hidden overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm sm:block dark:border-zinc-800 dark:bg-zinc-950">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
                  <caption className="sr-only">
                    Staff members at your Retailer
                  </caption>
                  <thead className="bg-zinc-50 dark:bg-zinc-900/50">
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
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {/* Rendered in the RPC's own order. Nothing is re-sorted here —
                        a second, locale-dependent ordering could disagree with the
                        database's. The membership id is the stable key. */}
                    {members.members.map((member) => (
                      <tr key={member.membershipId}>
                        <td className="whitespace-nowrap px-5 py-3.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {memberName(member)}
                        </td>
                        <td className={`whitespace-nowrap ${tdClasses}`}>
                          {retailerRoleDisplayName(member.roleCode, member.roleName)}
                        </td>
                        <td className={tdClasses}>
                          <ShopList names={member.shopNames} />
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5">
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
                <li
                  key={member.membershipId}
                  className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {memberName(member)}
                    </p>
                    <StatusBadge status={member.membershipStatus} />
                  </div>
                  <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-500 dark:text-zinc-400">Role</dt>
                      <dd className="text-zinc-700 dark:text-zinc-300">
                        {retailerRoleDisplayName(member.roleCode, member.roleName)}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-500 dark:text-zinc-400">Shops</dt>
                      <dd className="text-right text-zinc-700 dark:text-zinc-300">
                        <ShopList names={member.shopNames} />
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-500 dark:text-zinc-400">Joined</dt>
                      <dd className="text-zinc-700 dark:text-zinc-300">
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
          <h3
            id="invitations-heading"
            className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
          >
            Invitations
          </h3>

          {invitations.status !== "ok" ? (
            <div className="mt-3">
              <ReadUnavailable heading="Invitations could not be loaded" />
            </div>
          ) : invitations.invitations.length === 0 ? (
            <div className="mt-3">
              <EmptyPanel
                title="No invitations yet"
                body="Invitations you send will appear here, along with their status."
              />
            </div>
          ) : (
            <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
                  <caption className="sr-only">
                    Staff invitations for your Retailer
                  </caption>
                  <thead className="bg-zinc-50 dark:bg-zinc-900/50">
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
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {invitations.invitations.map((invitation) => {
                      const shops = describeIntendedShops(
                        invitation.shopIds,
                        assignableShops,
                      );
                      const label = invitationName(invitation);

                      return (
                        <tr key={invitation.invitationId}>
                          <td className="px-5 py-3.5 text-sm">
                            <span className="block font-medium text-zinc-900 dark:text-zinc-100">
                              {label}
                            </span>
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                              {invitation.email}
                            </span>
                          </td>
                          <td className={`whitespace-nowrap ${tdClasses}`}>
                            {retailerRoleDisplayName(invitation.roleCode)}
                          </td>
                          <td className={tdClasses}>
                            {shops.names.length === 0 &&
                            shops.unavailableCount === 0 ? (
                              <span
                                className="text-zinc-400 dark:text-zinc-600"
                                aria-label="No shops"
                              >
                                —
                              </span>
                            ) : (
                              <>
                                {shops.names.join(", ")}
                                {shops.unavailableCount > 0 && (
                                  <span className="block text-xs text-amber-700 dark:text-amber-400">
                                    {shops.unavailableCount} shop
                                    {shops.unavailableCount === 1 ? "" : "s"} no longer
                                    available
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3.5">
                            <InvitationStateBadge invitation={invitation} />
                          </td>
                          <td className="whitespace-nowrap px-5 py-3.5 text-xs text-zinc-500 dark:text-zinc-400">
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
                          <td className="whitespace-nowrap px-5 py-3.5">
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
          <h3
            id="invite-heading"
            className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
          >
            Invite staff
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Send an invitation to join your Retailer. They will accept it by signing in
            with the email address you enter.
          </p>

          <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6 dark:border-zinc-800 dark:bg-zinc-950">
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
