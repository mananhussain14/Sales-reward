// SERVER-ONLY MODULE.
//
// This module must never be imported into a Client Component. It transitively
// imports `next/headers` (via @/lib/supabase/server), which throws at build time
// if it ever reaches the browser bundle — the same guard lib/supabase/server.ts
// relies on. The `server-only` package would state this more directly, but no
// new dependency is added for it.
import { cache } from "react";
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
 *
 * The chain itself lives in public.get_vendor_super_admin_context(), which
 * evaluates every condition in one round trip. The role code, the VENDOR
 * organization type, and the ACTIVE requirements on profile, membership,
 * organization, and role are therefore SQL literals in that function rather than
 * TypeScript constants here — there is deliberately no second copy of them to
 * drift out of step with the database.
 */

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

/**
 * One row of public.get_vendor_super_admin_context(). Declared explicitly rather
 * than inferred, because an untyped rpc() call yields `any` and would silently
 * accept whatever the function returned — including, if the SQL ever drifted, a
 * column this module has no business receiving.
 *
 * These five columns are the function's entire output. There are no permission
 * details, no role codes or names, no membership id, no email, and no status
 * columns: the statuses are conditions inside the SQL, not values it hands back.
 */
type VendorSuperAdminContextRow = {
  user_id: string;
  first_name: string;
  last_name: string;
  organization_id: string;
  organization_name: string;
};

/** Joins the stored name parts into one display string, ignoring blank parts. */
function buildUserDisplayName(profile: {
  first_name: string;
  last_name: string;
}): string {
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
 *
 * Private: every caller goes through the cached getVendorSuperAdminAccess()
 * export at the bottom of this module.
 */
async function resolveVendorSuperAdminAccess(): Promise<VendorSuperAdminAccess> {
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
  // 2. Authorization — the whole chain, in one round trip.
  // ---------------------------------------------------------------------------
  // public.get_vendor_super_admin_context() is the single source of truth for
  // this decision, exactly as has_organization_role() was before it. It is
  // SECURITY DEFINER with search_path = '', identifies the caller solely via
  // auth.uid() (it accepts NO arguments at all), and evaluates the full chain in
  // one query: ACTIVE profile owned by auth.uid(), ACTIVE membership, ACTIVE
  // VENDOR organization, ACTIVE VENDOR_SUPER_ADMIN role reached through that
  // membership. Zero rows means not authorized.
  //
  // This replaces four sequential remote calls — profile and memberships, then
  // organizations, then one role RPC per candidate organization — with one. The
  // conditions did not change; only the number of network round trips did. The
  // joins are the same joins, and reassembling any part of them in TypeScript
  // would let the application and the RLS policies drift apart, with only one of
  // the two being right.
  //
  // Still the ordinary authenticated client: the caller's own token is what
  // auth.uid() resolves inside the function. service_role is not used here or
  // anywhere in this codebase — it would bypass RLS entirely and make the
  // caller's identity a parameter rather than a fact.
  //
  // Promise.resolve() because the PostgREST builder is a thenable, not a real
  // Promise — it implements `then` and has no `.catch()` of its own. Adopting it
  // gives a genuine Promise to attach the rejection handler to, without altering
  // when the request fires or what it returns.
  const contextResult = await Promise.resolve(
    supabase.rpc("get_vendor_super_admin_context"),
  ).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. Reduced
  // to `null` here, and the thrown value is deliberately not bound, inspected, or
  // logged — it may carry request URLs, headers, or token material. A chain that
  // could not be evaluated can only ever deny.
  if (contextResult === null) {
    return { status: "unauthorized" };
  }

  // A reported PostgREST/RPC error. Swallowed unbound for the same reason as
  // every read this module ever made: its message can name tables, columns,
  // functions, and policies. The caller is authenticated, so "unauthorized" (not
  // "unauthenticated") is the honest fail-closed answer — it sends them to
  // /access-denied rather than looping them through /login. A database failure
  // never downgrades a verified caller to "unauthenticated".
  if (contextResult.error || !contextResult.data) {
    return { status: "unauthorized" };
  }

  // rpc() is untyped here — this project has no generated database types, so the
  // client cannot know this function's shape and infers `any` (the same reason
  // the has_organization_role() call this replaced was untyped, and why it
  // compared `=== true` rather than trusting a truthy value). The assertion below
  // names the shape for the code that follows; it is a claim about the SQL, NOT a
  // check of it, and TypeScript erases it at runtime. That is precisely why the
  // subject equality below is verified rather than assumed.
  const contextRows = contextResult.data as VendorSuperAdminContextRow[];

  // The function returns rows ordered by organization id, so this is a stable
  // choice rather than whatever the planner emitted: a caller holding the role in
  // two vendor organizations lands in the same one on every request.
  //
  // Zero rows is the ordinary deny — an authenticated caller who is not an ACTIVE
  // VENDOR_SUPER_ADMIN in an ACTIVE VENDOR organization. It is also where a
  // suspended profile, a suspended membership, a suspended or retailer
  // organization, and an inactive role all land. The function does not
  // distinguish them, and neither does this.
  const context = contextRows[0];

  if (!context) {
    return { status: "unauthorized" };
  }

  // Defense in depth. The function derives its subject from auth.uid() and can
  // only ever return the caller's own row, so this cannot fail today — auth.uid()
  // and the claims subject are both read from the same verified token. It is
  // checked anyway because the alternative to checking is trusting: if the SQL
  // were ever edited to accept a parameter, join loosely, or return another
  // user's profile, that bug would otherwise become a silent identity swap, with
  // this module rendering one user's name and organization to a different signed-
  // in user. A mismatch is not a scenario to explain — it is a reason to deny.
  if (context.user_id !== userId) {
    return { status: "unauthorized" };
  }

  // Past this point the caller is authorized. `userId` is the verified claims
  // subject — the same value the function matched on, and still never anything
  // the caller supplied.
  return {
    status: "authorized",
    userId,
    userDisplayName: buildUserDisplayName(context),
    organizationId: context.organization_id,
    organizationName: context.organization_name,
  };
}

/**
 * Shared Vendor Super Admin authorization check — the only export.
 *
 * React `cache` here is REQUEST-SCOPED memoization for a single Server Component
 * render, and nothing more. React allocates a fresh cache per request, so the
 * (admin) layout and the /users data module — which both call this while
 * rendering the same request — run the authorization chain once and share its
 * result, instead of verifying claims and calling the authorization RPC twice.
 *
 * It is NOT a cache in the persistent sense, and it must never become one. An
 * authorization result belongs to exactly one caller for exactly one request:
 * carrying it across requests would serve one user's access decision to another,
 * and holding it beyond the request would keep a stale `authorized` alive after a
 * role, membership, or organization was suspended. Nothing about this call is
 * durable — no unstable_cache, no "use cache", no revalidation window, no module
 * global, no browser caching. The lifetime is the render, and the render ends.
 *
 * cache() is called exactly once, at module scope: calling it inside a function
 * would build a new cache per call and memoize nothing. The function takes no
 * arguments, so there is no cache key — deliberately. A key derived from a user
 * id, organization id, token, cookie, or email would mean accepting the caller's
 * identity as input, which is exactly the vulnerability the chain avoids by
 * reading its subject from the verified token instead.
 *
 * Behavior is unchanged: same queries, same filters, same ACTIVE requirements,
 * same RPC, same authenticated client under RLS, same fail-closed results.
 */
export const getVendorSuperAdminAccess = cache(resolveVendorSuperAdminAccess);
