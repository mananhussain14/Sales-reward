// SERVER-ONLY MODULE.
//
// This module must never be imported into a Client Component. It transitively
// imports `next/headers` (via @/lib/supabase/server), which throws at build time
// if it ever reaches the browser bundle — the same guard lib/supabase/server.ts
// relies on. The `server-only` package would state this more directly, but no
// new dependency is added for it.
import { createClient } from "@/lib/supabase/server";

/**
 * Shared Vendor Super Admin authorization check.
 *
 * Authentication (proving WHO a caller is) already happens via Supabase Auth.
 * This module answers the separate question of WHETHER that verified identity is
 * an active VENDOR_SUPER_ADMIN in an active VENDOR organization. A valid Auth
 * account is not, on its own, permission to render the admin.
 *
 * Every route and future Server Action that guards a Vendor Admin capability
 * must call this function rather than re-implementing the queries, so the
 * decision has exactly one definition.
 *
 * Fails CLOSED throughout: a database error, an RPC error, a transport failure,
 * or an unverifiable token can only ever produce a non-authorized result. No
 * branch here can turn an error into access.
 */

/** The role code that grants Vendor Admin dashboard access. */
const VENDOR_SUPER_ADMIN_ROLE_CODE = "VENDOR_SUPER_ADMIN";

/** Only organizations of this type can host Vendor Super Admins. */
const VENDOR_ORGANIZATION_TYPE = "VENDOR";

/** The lifecycle state required of profiles, memberships, and organizations. */
const ACTIVE_STATUS = "ACTIVE";

/**
 * Shown when a profile's stored names unexpectedly produce an empty string.
 * public.profiles constrains both name columns to be NOT NULL and non-empty
 * after trimming, so this is a defensive floor rather than a reachable branch —
 * the header must never render a blank identity even if that schema loosens.
 */
const FALLBACK_USER_DISPLAY_NAME = "Vendor Admin";

export type VendorSuperAdminAccess =
  | {
      status: "authorized";
      userId: string;
      userDisplayName: string;
      organizationId: string;
      organizationName: string;
    }
  | { status: "unauthenticated" }
  | { status: "unauthorized" };

/** Shape of the two columns read from public.profiles. */
type ProfileRow = { first_name: string; last_name: string };

/** Shape of the single column read from public.organization_members. */
type MembershipRow = { organization_id: string };

/** Shape of the two columns read from public.organizations. */
type VendorOrganizationRow = { id: string; name: string };

/** Joins the stored name parts into one display string, ignoring blank parts. */
function buildUserDisplayName(profile: ProfileRow): string {
  const displayName = [profile.first_name, profile.last_name]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");

  return displayName || FALLBACK_USER_DISPLAY_NAME;
}

/**
 * Resolves the caller's Vendor Super Admin access from their own verified
 * session. Takes no arguments by design — see the note on the claims subject
 * below.
 */
export async function getVendorSuperAdminAccess(): Promise<VendorSuperAdminAccess> {
  const supabase = await createClient();

  // ---------------------------------------------------------------------------
  // 1. Identity — from the verified token, never from application input.
  // ---------------------------------------------------------------------------
  // getClaims() cryptographically verifies the JWT signature (against the cached
  // JWKS, or the Auth server for symmetric keys) and refreshes the token if it is
  // near expiry. getSession() is never used anywhere in this codebase: it returns
  // the cookie's contents unverified, so a tampered cookie would be believed.
  //
  // On no session it returns { data: null, error: null }, so the presence of
  // `claims` — not the absence of `error` — is the condition to test.
  let claimsSubject: string | undefined;
  try {
    const { data } = await supabase.auth.getClaims();
    claimsSubject = data?.claims?.sub;
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can
    // carry token material. An identity we cannot verify is treated as no
    // identity at all.
    return { status: "unauthenticated" };
  }

  // `sub` is typed as string, but an empty or whitespace-only value would still
  // satisfy the type while being useless as a filter — reject it explicitly
  // rather than querying with it.
  if (typeof claimsSubject !== "string" || claimsSubject.trim().length === 0) {
    return { status: "unauthenticated" };
  }

  // The ONLY user id used below. It is derived from the verified token subject
  // and is never accepted as a parameter and never resolved from an email
  // address — either would let a caller nominate whose authorization is
  // evaluated, which is exactly the vulnerability this function exists to avoid.
  const userId = claimsSubject;

  // ---------------------------------------------------------------------------
  // 2. Profile — the caller's own row, for display only.
  // ---------------------------------------------------------------------------
  // public.profiles.id IS the auth user id (1:1 with auth.users), so the
  // verified token subject addresses this row directly and auth.users is never
  // queried. `supabase` is the ordinary authenticated client, so the
  // profiles_select_self_or_authorized_members policy applies underneath: its
  // first branch (profiles.id = auth.uid()) is what makes this read legal, and
  // it would still scope the result to the caller even without the explicit
  // filter. Only the two name columns are selected — no email, no id, no
  // mobile number.
  //
  // The ACTIVE filter is an authorization condition, not a cosmetic one: a
  // SUSPENDED or DEACTIVATED profile must not reach the dashboard, and
  // has_organization_role() re-checks the same ACTIVE profile requirement in
  // step 4, so the two agree rather than either standing alone.
  const profileResult = await supabase
    .from("profiles")
    .select("first_name, last_name")
    .eq("id", userId)
    .eq("status", ACTIVE_STATUS)
    .maybeSingle<ProfileRow>();

  // maybeSingle() returns data: null rather than erroring on zero rows, so a
  // missing, inactive, or RLS-invisible profile lands here and denies. The raw
  // PostgREST error is swallowed for the same reason as every other read below:
  // its message can name tables, columns, and policies.
  if (profileResult.error || !profileResult.data) {
    return { status: "unauthorized" };
  }

  const userDisplayName = buildUserDisplayName(profileResult.data);

  // ---------------------------------------------------------------------------
  // 3. Candidate organizations — discovered only from the caller's own rows.
  // ---------------------------------------------------------------------------
  // Organization ids are never guessed, enumerated, or taken from the request.
  // The search space starts as the caller's own ACTIVE memberships and can only
  // narrow from there, so an organization the caller has no membership in can
  // never even be tested. `supabase` is the ordinary authenticated client, so
  // the organization_members RLS policy applies to this read as well — the
  // explicit user_id filter and RLS agree rather than either standing alone.
  const membershipsResult = await supabase
    .from("organization_members")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("status", ACTIVE_STATUS)
    .returns<MembershipRow[]>();

  if (membershipsResult.error || !membershipsResult.data) {
    // The raw PostgREST error is swallowed, not surfaced or logged: its message
    // can name tables, columns, and policies. The caller is authenticated, so
    // "unauthorized" (not "unauthenticated") is the honest fail-closed answer —
    // it sends them to /access-denied rather than looping them through /login.
    return { status: "unauthorized" };
  }

  // A user may hold several memberships in one organization. Deduplicate so the
  // RPC below is called once per distinct organization rather than once per row.
  const organizationIds = [
    ...new Set(membershipsResult.data.map((membership) => membership.organization_id)),
  ];

  if (organizationIds.length === 0) {
    return { status: "unauthorized" };
  }

  // ---------------------------------------------------------------------------
  // 4. Narrow to ACTIVE VENDOR organizations.
  // ---------------------------------------------------------------------------
  // Still the authenticated client, so the organizations RLS policy
  // (is_active_organization_member) remains in force underneath these filters.
  // A membership in a RETAILER organization, or in a suspended vendor, is
  // discarded here before any role check is attempted.
  const organizationsResult = await supabase
    .from("organizations")
    .select("id, name")
    .in("id", organizationIds)
    .eq("organization_type", VENDOR_ORGANIZATION_TYPE)
    .eq("status", ACTIVE_STATUS)
    .returns<VendorOrganizationRow[]>();

  if (organizationsResult.error || !organizationsResult.data) {
    return { status: "unauthorized" };
  }

  // ---------------------------------------------------------------------------
  // 5. Role decision — delegated to the database helper.
  // ---------------------------------------------------------------------------
  // public.has_organization_role() is the single source of truth for this
  // decision. It is SECURITY DEFINER with search_path = '', identifies the caller
  // solely via auth.uid() (it accepts no user id), and re-checks the full active
  // chain: ACTIVE profile, ACTIVE membership, ACTIVE organization, ACTIVE role,
  // matching role code. The roles and member_roles tables are deliberately not
  // read here — reassembling that logic in TypeScript would let the dashboard and
  // the RLS policies drift apart, and only one of the two would be right.
  for (const organization of organizationsResult.data) {
    const { data: hasRole, error } = await supabase.rpc("has_organization_role", {
      target_organization_id: organization.id,
      target_role_code: VENDOR_SUPER_ADMIN_ROLE_CODE,
    });

    if (error) {
      // Fail closed for THIS organization only, and keep checking the rest: a
      // transient error on one row must not silently revoke access granted by
      // another. It can never grant access, because only an explicit `true`
      // below does that.
      continue;
    }

    // Strict `=== true`. The helper returns a plain boolean (EXISTS is never
    // null), but a truthy check would also accept a non-empty error string or an
    // unexpected object were the contract ever to change.
    if (hasRole === true) {
      return {
        status: "authorized",
        userId,
        userDisplayName,
        organizationId: organization.id,
        organizationName: organization.name,
      };
    }
  }

  // Authenticated, but holding no ACTIVE VENDOR_SUPER_ADMIN role in any ACTIVE
  // vendor organization. This is also the landing point for every fail-closed
  // path above.
  return { status: "unauthorized" };
}
