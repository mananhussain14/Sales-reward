import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import {
  getVendorRbacCatalog,
  type VendorPermissionSummary,
  type VendorRoleSummary,
} from "@/lib/rbac/vendor-rbac-catalog";

export const metadata: Metadata = {
  title: "Roles & Permissions · SalesReward Admin",
};

/** Neutral panel used for both the empty and the unavailable states. */
function NoticePanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 text-center dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{title}</p>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{body}</p>
    </div>
  );
}

/** A permission's name over its description. Shared by both sections. */
function PermissionLine({ permission }: { permission: VendorPermissionSummary }) {
  return (
    <>
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
        {permission.name}
      </p>
      {permission.description !== null && (
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
          {permission.description}
        </p>
      )}
    </>
  );
}

/**
 * One role: its name, stored status, description, and the permissions mapped to
 * it. A role with no mappings says so explicitly — that is a real answer about
 * the catalogue, not a gap.
 */
function RoleCard({ role }: { role: VendorRoleSummary }) {
  return (
    <li className="rounded-xl border border-zinc-200 bg-white p-4 sm:p-5 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          {role.name}
        </h3>
        <StatusBadge status={role.status} />
      </div>

      {role.description !== null && (
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {role.description}
        </p>
      )}

      <div className="mt-4 border-t border-zinc-100 pt-4 dark:border-zinc-800/80">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Permissions
        </h4>

        {role.permissions.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
            No permissions assigned
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {role.permissions.map((permission, index) => (
              // The catalogue carries no ids by design, so there is no natural
              // key. The index is stable here because this list is
              // server-rendered in a fixed sort order and never reordered,
              // filtered, or mutated on the client.
              <li key={index}>
                <PermissionLine permission={permission} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * Read-only Roles & Permissions catalogue. A Server Component: the queries, the
 * internal ids, and the session all stay on the server, and only display strings
 * reach the browser.
 */
export default async function RolesPage() {
  const catalog = await getVendorRbacCatalog();

  // As on the dashboard and the Users directory, this page does not assume the
  // layout already guarded it — the rule must hold for this module regardless of
  // the route tree it is composed into. All of them call the same function, so
  // they cannot disagree.
  if (catalog.status === "unauthenticated") {
    redirect("/login");
  }

  if (catalog.status === "unauthorized") {
    redirect("/access-denied");
  }

  const { organizationName, roles, permissions } = catalog;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Roles &amp; Permissions
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          The access-control catalogue available to{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {organizationName}
          </span>
          . These role and permission definitions are shared across the platform;
          this view is read-only.
        </p>
      </div>

      <section aria-labelledby="roles-heading" className="space-y-3">
        <h3
          id="roles-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Roles
        </h3>

        {roles === null ? (
          // Deliberately generic and reason-free: the only cause is a database
          // failure, whose detail must never reach a browser. Distinct from the
          // empty state below — unknown is not the same as none.
          <NoticePanel
            title="Roles unavailable"
            body="The role catalogue could not be loaded. Please try again shortly."
          />
        ) : roles.length === 0 ? (
          <NoticePanel
            title="No roles yet"
            body="The catalogue has no role definitions on record."
          />
        ) : (
          <ul className="space-y-3">
            {roles.map((role, index) => (
              // Index key for the same reason as the permissions above: no id,
              // fixed server-rendered order.
              <RoleCard key={index} role={role} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="permissions-heading" className="space-y-3">
        <h3
          id="permissions-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Permissions catalogue
        </h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Every permission on record, including any not currently assigned to a
          role.
        </p>

        {permissions === null ? (
          <NoticePanel
            title="Permissions unavailable"
            body="The permission catalogue could not be loaded. Please try again shortly."
          />
        ) : permissions.length === 0 ? (
          <NoticePanel
            title="No permissions yet"
            body="The catalogue has no permission definitions on record."
          />
        ) : (
          <ul className="divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
            {permissions.map((permission, index) => (
              <li key={index} className="px-4 py-3">
                <PermissionLine permission={permission} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
