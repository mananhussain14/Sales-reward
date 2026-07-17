import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import {
  getVendorOrganizationMembers,
  type VendorOrganizationMember,
} from "@/lib/members/vendor-organization-members";

export const metadata: Metadata = {
  title: "Users · SalesReward Admin",
};

/** Shown in place of a role list when a member holds no active role. */
function RoleNames({ roleNames }: { roleNames: string[] }) {
  if (roleNames.length === 0) {
    return (
      <span className="text-zinc-400 dark:text-zinc-500">No active role</span>
    );
  }

  return <span>{roleNames.join(", ")}</span>;
}

/** Wide-screen presentation. Hidden below `md`, where the cards take over. */
function MemberTable({ members }: { members: VendorOrganizationMember[] }) {
  return (
    <div className="hidden overflow-hidden rounded-xl border border-zinc-200 md:block dark:border-zinc-800">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Name
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Membership
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Profile
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-zinc-500 dark:text-zinc-400">
              Roles
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
          {members.map((member, index) => (
            // The directory carries no ids by design, so there is no natural key:
            // two members may legitimately share a display name. The index is
            // stable here because this list is server-rendered in a fixed sort
            // order and never reordered, filtered, or mutated on the client.
            <tr key={index}>
              <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-50">
                {member.displayName}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={member.membershipStatus} />
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={member.profileStatus} />
              </td>
              <td className="px-4 py-3 text-zinc-600 dark:text-zinc-300">
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
          className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <p className="font-medium text-zinc-900 dark:text-zinc-50">
            {member.displayName}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={member.membershipStatus} />
            <StatusBadge status={member.profileStatus} />
          </div>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
            <RoleNames roleNames={member.roleNames} />
          </p>
        </li>
      ))}
    </ul>
  );
}

/** Neutral panel used for both the empty and the unavailable states. */
function NoticePanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{title}</p>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{body}</p>
    </div>
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
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Users
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Members of{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {organizationName}
          </span>
          , with their membership state, profile state, and assigned roles.
        </p>
      </div>

      {members === null ? (
        // Deliberately generic and reason-free: the only cause is a database
        // failure, whose detail must never reach a browser. Distinct from the
        // empty state below — unknown is not the same as none.
        <NoticePanel
          title="Directory unavailable"
          body="The member directory could not be loaded. Please try again shortly."
        />
      ) : members.length === 0 ? (
        <NoticePanel
          title="No members yet"
          body="This organization has no members on record."
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
