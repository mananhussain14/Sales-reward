// SERVER-ONLY MODULE.
//
// Like @/lib/auth/vendor-admin-access, this must never be imported into a Client
// Component. It transitively imports `next/headers` (via @/lib/supabase/server),
// which throws at build time if it ever reaches the browser bundle.
import { createClient } from "@/lib/supabase/server";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";

/**
 * Read-only Roles & Permissions catalogue for the Vendor Admin.
 *
 * Authorization is delegated in full to getVendorSuperAdminAccess() — not
 * re-implemented — and this function takes no arguments, so no caller can
 * nominate which roles, permissions, or mappings are listed.
 *
 * WHY THE CATALOGUE IS GLOBAL, NOT ORGANIZATION-SCOPED
 * ----------------------------------------------------
 * public.roles, public.permissions, and public.role_permissions carry no
 * organization_id column (see migration 2). They are a single catalogue of role
 * and permission DEFINITIONS shared by every organization; what is per-
 * organization is the ASSIGNMENT of a role to a member, which lives in
 * member_roles and is not read here. So there is nothing to scope these reads
 * by, and inventing a scope would misrepresent the schema.
 *
 * That is not a hole in the model: the RLS policies gate the catalogue
 * wholesale rather than per row, admitting a caller who holds RBAC_READ or
 * VENDOR_SUPER_ADMIN in at least one of their own organizations. The
 * organizationName below is therefore context for the reader — whose
 * authorization opened this page — and NOT a filter that was applied.
 *
 * Two failure kinds stay strictly apart, as in the dashboard summary and the
 * member directory:
 *
 *   - Authorization failure -> a non-authorized status for the WHOLE catalogue.
 *   - Data query failure    -> `null` for THAT section only, still authorized.
 */

/** One rendered permission row. Deliberately carries no id and no code. */
export type VendorPermissionSummary = {
  name: string;
  description: string | null;
};

/** One rendered role row. Deliberately carries no id and no code. */
export type VendorRoleSummary = {
  name: string;
  description: string | null;
  /** The stored lifecycle state — 'ACTIVE' or 'INACTIVE' per the roles check constraint. */
  status: string;
  /** `[]` means the role genuinely has no permission mappings. */
  permissions: VendorPermissionSummary[];
};

export type VendorRbacCatalog =
  | {
      status: "authorized";
      organizationName: string;
      /**
       * `[]` means the catalogue genuinely contains no roles.
       * `null` means the roles could not be loaded — never treat it as empty.
       */
      roles: VendorRoleSummary[] | null;
      /**
       * `[]` means the catalogue genuinely contains no permissions.
       * `null` means the permissions could not be loaded — never treat it as empty.
       */
      permissions: VendorPermissionSummary[] | null;
    }
  | { status: "unauthenticated" }
  | { status: "unauthorized" };

// Shapes of the columns read from each table, matching migration 2 exactly.
// `code` is deliberately never selected from either catalogue table: the codes
// (VENDOR_SUPER_ADMIN, RBAC_READ, ...) are the internal literals the RLS policies
// match on, and they have no business in a page. `module` exists on permissions
// but is not selected either — it is not part of the rendered shape.
//
// The ids ARE selected, because role_permissions joins on them and nothing else
// can. They are used to join in memory below and then dropped; see the note on
// the assembled result.
type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
};
type PermissionRow = {
  id: string;
  name: string;
  description: string | null;
};
type RolePermissionRow = {
  role_id: string;
  permission_id: string;
};

/** Fixed locale so ordering does not vary by host. */
function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, "en");
}

/**
 * Awaits one catalogue read and reduces every failure mode to `null`.
 *
 * This covers both failure kinds in one place: the ones the client REPORTS as
 * `{ error }`, and the ones that THROW (a fetch-level TypeError, an aborted
 * request, a DNS or TLS failure). Reducing both to `null` here is what makes the
 * Promise.all below safe — a single throw would otherwise reject the whole batch
 * and take down the sections that loaded fine.
 *
 * Neither the reported error nor the thrown value is bound or logged. A
 * PostgREST message can name tables, columns, and policies; a thrown value can
 * carry request URLs, headers, or token material. Neither may reach a browser,
 * and a log is no safer a home for them.
 */
async function safelyRead<Row>(
  query: PromiseLike<{ data: Row[] | null; error: unknown }>,
): Promise<Row[] | null> {
  try {
    const result = await query;
    if (result.error || !result.data) return null;
    return result.data;
  } catch {
    return null;
  }
}

/**
 * Joins roles to their permissions through role_permissions, in memory.
 *
 * Three queries TOTAL, regardless of how many roles or permissions exist —
 * never one per role. Each is a whole-table read of a small global catalogue, so
 * there is no id set to pass to `.in()` and therefore no empty-array filter to
 * guard against: the mapping table is read in full and matched against the two
 * lookup maps here.
 */
function assembleRoles(
  roleRows: RoleRow[],
  permissionRows: PermissionRow[],
  mappingRows: RolePermissionRow[],
): VendorRoleSummary[] {
  const permissionsById = new Map(permissionRows.map((row) => [row.id, row]));

  // Permission summaries per role id. A permission_id with no entry in
  // permissionsById is not readable (or is dangling) and is simply omitted —
  // there is no name or description to render, and inventing either would be
  // worse than leaving it out.
  const permissionsByRoleId = new Map<string, VendorPermissionSummary[]>();
  for (const mapping of mappingRows) {
    const permission = permissionsById.get(mapping.permission_id);
    if (permission === undefined) continue;

    const summary: VendorPermissionSummary = {
      name: permission.name,
      description: permission.description,
    };

    const existing = permissionsByRoleId.get(mapping.role_id);
    if (existing) existing.push(summary);
    else permissionsByRoleId.set(mapping.role_id, [summary]);
  }

  // The ids are used here and then discarded: every id read above is consumed by
  // the joins and none of them survives into the returned shape.
  const roles = roleRows.map((role) => ({
    name: role.name,
    description: role.description,
    status: role.status,
    // `[]` for a role with no mappings — a real, correct answer (CLAIM_REVIEWER
    // and FINANCE_ADMIN are seeded exactly this way), and distinct from the
    // `roles: null` a failed read produces.
    permissions: (permissionsByRoleId.get(role.id) ?? []).sort(byName),
  }));

  return roles.sort(byName);
}

export async function getVendorRbacCatalog(): Promise<VendorRbacCatalog> {
  // ---------------------------------------------------------------------------
  // Authorization — the single source of truth, not repeated here.
  // ---------------------------------------------------------------------------
  const access = await getVendorSuperAdminAccess();

  if (access.status !== "authorized") {
    // Propagated unchanged so the page maps "unauthenticated" -> /login and
    // "unauthorized" -> /access-denied. No catalogue query runs on this path.
    return access;
  }

  const supabase = await createClient();

  // ---------------------------------------------------------------------------
  // The catalogue — three independent reads, so concurrent.
  // ---------------------------------------------------------------------------
  // Every query uses the ordinary authenticated client, so the caller's own RLS
  // policies apply underneath: roles_select_rbac_authorized,
  // permissions_select_rbac_authorized, and role_permissions_select_rbac_authorized
  // each independently confirm RBAC_READ or VENDOR_SUPER_ADMIN before a single
  // row is returned. The authorization check above and RLS agree rather than
  // either standing alone. service_role is never used — it would bypass RLS
  // entirely.
  //
  // roles is deliberately NOT filtered by status: a catalogue that hid INACTIVE
  // definitions would misrepresent what is stored. The status is shown per row
  // instead. (This differs from the member directory, which filters roles to
  // ACTIVE — there an inactive definition must not be advertised as a live role
  // someone holds; here the definition itself is the subject.)
  //
  // Promise.all is safe against rejection because each read is wrapped in
  // safelyRead(), which can no longer reject: one unreadable table degrades its
  // own section rather than the page.
  const [roleRows, permissionRows, mappingRows] = await Promise.all([
    safelyRead<RoleRow>(supabase.from("roles").select("id, name, description, status")),
    safelyRead<PermissionRow>(supabase.from("permissions").select("id, name, description")),
    safelyRead<RolePermissionRow>(
      supabase.from("role_permissions").select("role_id, permission_id"),
    ),
  ]);

  // The permissions section needs only its own read.
  const permissions =
    permissionRows === null ? null : [...permissionRows].map(toSummary).sort(byName);

  // The roles section needs all three: roles for the definitions, mappings for
  // the edges, and permissions for the names those edges point at. If ANY of the
  // three failed, the roles are unknown rather than empty — a role rendered
  // without its permissions would read as "no permissions assigned", which is a
  // different and false statement. Fail the section instead.
  const roles =
    roleRows === null || permissionRows === null || mappingRows === null
      ? null
      : assembleRoles(roleRows, permissionRows, mappingRows);

  // Still `status: "authorized"` on every path — a data failure must never read
  // as a denial, and can never grant access either, since authorization was
  // settled above and nothing here revisits it.
  return {
    status: "authorized",
    organizationName: access.organizationName,
    roles,
    permissions,
  };
}

/** Drops the id, keeping only what the page may render. */
function toSummary(permission: PermissionRow): VendorPermissionSummary {
  return { name: permission.name, description: permission.description };
}
