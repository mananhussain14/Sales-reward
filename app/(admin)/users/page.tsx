import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import {
  getVendorOrganizationMembers,
  type VendorOrganizationMember,
} from "@/lib/members/vendor-organization-members";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { UsersIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Users · SalesReward Admin",
};

/** Shown in place of a role list when a member holds no active role. */
function RoleNames({ roleNames }: { roleNames: string[] }) {
  if (roleNames.length === 0) {
    return <span className="text-slate-400">No active role</span>;
  }

  return <span>{roleNames.join(", ")}</span>;
}

/** Wide-screen presentation. Hidden below `md`, where the cards take over. */
function MemberTable({ members }: { members: VendorOrganizationMember[] }) {
  return (
    <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card md:block">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold">
              Name
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Membership
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Profile
            </th>
            <th scope="col" className="px-4 py-3 font-semibold">
              Roles
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {members.map((member, index) => (
            // The directory carries no ids by design, so there is no natural key:
            // two members may legitimately share a display name. The index is
            // stable here because this list is server-rendered in a fixed sort
            // order and never reordered, filtered, or mutated on the client.
            <tr key={index} className="transition-colors hover:bg-slate-50">
              <td className="px-4 py-3 font-medium text-slate-900">
                {member.displayName}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={member.membershipStatus} />
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={member.profileStatus} />
              </td>
              <td className="px-4 py-3 text-slate-600">
                <RoleNames roleNames={member.roleNames} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Small-screen presentation. A four-column table cannot stay readable at phone
 * widths, so each member becomes a labelled card rather than a horizontally
 * scrolling row.
 */
function MemberCards({ members }: { members: VendorOrganizationMember[] }) {
  return (
    <ul className="space-y-3 md:hidden">
      {members.map((member, index) => (
        // Index key for the same reason as the table above: no id, fixed order.
        <li
          key={index}
          className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card"
        >
          <p className="font-medium text-slate-900">{member.displayName}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={member.membershipStatus} />
            <StatusBadge status={member.profileStatus} />
          </div>
          <p className="mt-2 text-sm text-slate-600">
            <RoleNames roleNames={member.roleNames} />
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Read-only member directory for the authorized Vendor organization. A Server
 * Component: the queries, the organization id, and the session all stay on the
 * server, and only display strings reach the browser.
 */
export default async function UsersPage() {
  const directory = await getVendorOrganizationMembers();

  // As on the dashboard, this page does not assume the layout already guarded
  // it — the rule must hold for this module regardless of the route tree it is
  // composed into. Both call the same function, so they cannot disagree.
  if (directory.status === "unauthenticated") {
    redirect("/login");
  }

  if (directory.status === "unauthorized") {
    redirect("/access-denied");
  }

  const { organizationName, members } = directory;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Users"
        description={
          <>
            Members of{" "}
            <span className="font-medium text-slate-700">{organizationName}</span>
            , with their membership state, profile state, and assigned roles.
          </>
        }
      />

      {members === null ? (
        // Deliberately generic and reason-free: the only cause is a database
        // failure, whose detail must never reach a browser. Distinct from the
        // empty state below — unknown is not the same as none.
        <EmptyState
          icon={<UsersIcon className="h-6 w-6" />}
          title="Directory unavailable"
          description="The member directory could not be loaded. Please try again shortly."
        />
      ) : members.length === 0 ? (
        <EmptyState
          icon={<UsersIcon className="h-6 w-6" />}
          tone="indigo"
          title="No members yet"
          description="This organization has no members on record."
        />
      ) : (
        <section aria-label="Organization members">
          <MemberTable members={members} />
          <MemberCards members={members} />
        </section>
      )}
    </div>
  );
}
