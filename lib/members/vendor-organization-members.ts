// SERVER-ONLY MODULE.
//
// Like @/lib/auth/vendor-admin-access, this must never be imported into a Client
// Component. It transitively imports `next/headers` (via @/lib/supabase/server),
// which throws at build time if it ever reaches the browser bundle.
import { createClient } from "@/lib/supabase/server";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";

/**
 * Read-only member directory for the authorized Vendor organization.
 *
 * Authorization is delegated in full to getVendorSuperAdminAccess() — not
 * re-implemented — and this function takes no arguments, so no caller can
 * nominate which organization's members are listed.
 *
 * The rows this returns are display-only projections: every internal id
 * (membership, profile, role) is used to join on the server and then dropped, so
 * no UUID crosses into the RSC payload.
 *
 * Two failure kinds stay strictly apart, as in the dashboard summary:
 *
 *   - Authorization failure -> a non-authorized status for the WHOLE directory.
 *   - Data query failure    -> `members: null`, still authorized.
 */

/** The lifecycle state a role definition must hold to be shown. */
const ACTIVE_STATUS = "ACTIVE";

/** Used only if a profile's stored names unexpectedly produce nothing. */
const FALLBACK_DISPLAY_NAME = "Member";

/** One rendered directory row. Deliberately carries no ids. */
export type VendorOrganizationMember = {
  displayName: string;
  membershipStatus: string;
  profileStatus: string;
  roleNames: string[];
};

export type VendorOrganizationMembersResult =
  | {
      status: "authorized";
      organizationName: string;
      /**
       * `[]` means the organization genuinely has no members.
       * `null` means the directory could not be loaded — never treat it as empty.
       */
      members: VendorOrganizationMember[] | null;
    }
  | { status: "unauthenticated" }
  | { status: "unauthorized" };

// Shapes of the columns read from each table. Selected narrowly: no email (which
// lives in auth.users and is never queried), no mobile number, no role codes.
type MembershipRow = { id: string; user_id: string; status: string };
type ProfileRow = { id: string; first_name: string; last_name: string; status: string };
type MemberRoleRow = { organization_member_id: string; role_id: string };
type RoleRow = { id: string; name: string };

/** Joins the stored name parts into one display string, ignoring blank parts. */
function buildDisplayName(profile: ProfileRow): string {
  const displayName = [profile.first_name, profile.last_name]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");

  return displayName || FALLBACK_DISPLAY_NAME;
}

/**
 * Thrown when a read returns a PostgREST error, so the single catch below can
 * treat reported errors and thrown errors identically. The Supabase error is
 * deliberately NOT attached: it can name tables, columns, and policies, and
 * nothing here may reach a browser.
 */
class MemberDirectoryUnavailableError extends Error {}

/** Rejects a reported PostgREST error; otherwise yields the rows (never null). */
function unwrap<Row>(result: { data: Row[] | null; error: unknown }): Row[] {
  if (result.error || !result.data) throw new MemberDirectoryUnavailableError();
  return result.data;
}

/**
 * Loads and assembles the directory. Four queries TOTAL, regardless of member
 * count — never one per member. Each is a set-based read keyed by ids collected
 * from the previous step, and the joining happens in memory here.
 */
async function loadMembers(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
): Promise<VendorOrganizationMember[]> {
  // ---------------------------------------------------------------------------
  // 1. Memberships of the authorized organization — every lifecycle state.
  // ---------------------------------------------------------------------------
  // Deliberately NOT filtered by status: a directory that hid suspended or
  // deactivated members would misrepresent what is stored. The status is shown
  // per row instead. The organization_members policy independently confines this
  // to organizations the caller may read.
  const memberships = unwrap<MembershipRow>(
    await supabase
      .from("organization_members")
      .select("id, user_id, status")
      .eq("organization_id", organizationId),
  );

  // No members is a legitimate answer, and it also means every `.in()` below
  // would receive an empty array — which PostgREST would turn into a match-
  // nothing filter, wasting three round trips to learn what is already known.
  if (memberships.length === 0) return [];

  // Deduplicated because `.in()` takes a set, and the unique(organization_id,
  // user_id) constraint makes duplicate user_ids impossible today — this simply
  // does not depend on that constraint holding.
  const profileIds = [...new Set(memberships.map((membership) => membership.user_id))];
  const membershipIds = memberships.map((membership) => membership.id);

  // ---------------------------------------------------------------------------
  // 2 + 3. Profiles and role assignments — independent, so concurrent.
  // ---------------------------------------------------------------------------
  // Both are keyed by ids gathered above, so each is a single set-based read
  // rather than one query per member. Promise.all is safe against rejection here
  // because the whole function is wrapped in one try/catch by the caller: a
  // failure of either means the directory as a whole is unavailable, which is
  // exactly the intended outcome (unlike the dashboard's independent counts,
  // where one failure must not sink the others).
  const [profiles, memberRoles] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, first_name, last_name, status")
      .in("id", profileIds)
      .then(unwrap<ProfileRow>),
    supabase
      .from("member_roles")
      .select("organization_member_id, role_id")
      .in("organization_member_id", membershipIds)
      .then(unwrap<MemberRoleRow>),
  ]);

  // ---------------------------------------------------------------------------
  // 4. Role definitions — names for the assignments found above.
  // ---------------------------------------------------------------------------
  // member_roles carries only role_id, so the names come from the global role
  // catalogue. Filtered to ACTIVE, so an INACTIVE definition still assigned to
  // someone is not advertised as a live role. `name` is selected, never `code` —
  // the codes are internal.
  const roleIds = [...new Set(memberRoles.map((memberRole) => memberRole.role_id))];
  const roles =
    roleIds.length === 0
      ? []
      : unwrap<RoleRow>(
          await supabase
            .from("roles")
            .select("id, name")
            .in("id", roleIds)
            .eq("status", ACTIVE_STATUS),
        );

  // ---------------------------------------------------------------------------
  // 5. Assemble — ids are used here and then discarded.
  // ---------------------------------------------------------------------------
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const roleNamesById = new Map(roles.map((role) => [role.id, role.name]));

  // Role names per membership. A role_id with no entry in roleNamesById was
  // filtered out as INACTIVE (or is not readable) and is simply omitted.
  const roleNamesByMembershipId = new Map<string, string[]>();
  for (const memberRole of memberRoles) {
    const roleName = roleNamesById.get(memberRole.role_id);
    if (roleName === undefined) continue;

    const existing = roleNamesByMembershipId.get(memberRole.organization_member_id);
    if (existing) existing.push(roleName);
    else roleNamesByMembershipId.set(memberRole.organization_member_id, [roleName]);
  }

  const members: VendorOrganizationMember[] = [];
  for (const membership of memberships) {
    const profile = profilesById.get(membership.user_id);

    // A membership whose profile is not visible cannot be rendered truthfully —
    // there is no name and no profile status to show, and inventing either would
    // be worse than omitting the row. The FK is NOT NULL and the profiles policy
    // admits a VENDOR_SUPER_ADMIN for their own organization's members, so this
    // is an anomaly rather than an expected branch.
    if (!profile) continue;

    members.push({
      displayName: buildDisplayName(profile),
      membershipStatus: membership.status,
      profileStatus: profile.status,
      // Fixed locale so ordering does not vary by host.
      roleNames: (roleNamesByMembershipId.get(membership.id) ?? []).sort((a, b) =>
        a.localeCompare(b, "en"),
      ),
    });
  }

  // Sorted by display name for a stable, predictable directory.
  return members.sort((a, b) => a.displayName.localeCompare(b.displayName, "en"));
}

export async function getVendorOrganizationMembers(): Promise<VendorOrganizationMembersResult> {
  // ---------------------------------------------------------------------------
  // Authorization — the single source of truth, not repeated here.
  // ---------------------------------------------------------------------------
  const access = await getVendorSuperAdminAccess();

  if (access.status !== "authorized") {
    // Propagated unchanged so the page maps "unauthenticated" -> /login and
    // "unauthorized" -> /access-denied. No directory query runs on this path.
    return access;
  }

  const supabase = await createClient();

  try {
    return {
      status: "authorized",
      organizationName: access.organizationName,
      // The ONLY organization id used: from the authorized result, never from a
      // parameter, URL, form field, or browser state.
      members: await loadMembers(supabase, access.organizationId),
    };
  } catch {
    // One catch for every failure mode — a reported PostgREST error (rethrown as
    // MemberDirectoryUnavailableError above) and a genuine throw (fetch-level
    // TypeError, aborted request, DNS or TLS failure) alike. The value is not
    // bound or logged: it may carry request URLs, headers, or token material.
    //
    // Still `status: "authorized"` — a data failure must never read as a denial,
    // and can never grant access either, since authorization was settled above.
    return {
      status: "authorized",
      organizationName: access.organizationName,
      members: null,
    };
  }
}
