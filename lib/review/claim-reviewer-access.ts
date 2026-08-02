import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * The authorization boundary for the Claim Review portal.
 *
 * SERVER-ONLY. The `server-only` import above makes a client-side import a build
 * error rather than a runtime surprise, matching @/lib/auth/vendor-admin-access.
 *
 * ============================================================================
 * WHY A SEPARATE MODULE RATHER THAN AN EXTENSION OF THE VENDOR ONE
 * ============================================================================
 * getVendorSuperAdminAccess() resolves through public.get_vendor_super_admin_context(),
 * whose SQL hard-codes `r.code = 'VENDOR_SUPER_ADMIN'` and which gates the entire
 * shipped Vendor Admin. Admitting a second role there would silently change who can
 * reach every existing Vendor page. This module is its mirror, resolving a
 * DIFFERENT function, so the two surfaces stay independent: a change to reviewer
 * access cannot widen Vendor Admin, and vice versa.
 *
 * It deliberately does NOT use public.get_my_portal_context(). That function is
 * consumed by the Flutter client and by nothing on the web, and Phase 1B leaves it
 * byte-untouched for mobile compatibility.
 *
 * ============================================================================
 * WHAT THIS DOES AND DOES NOT AUTHORIZE
 * ============================================================================
 * `authorized` here means exactly one thing: this caller may OPEN the reviewer
 * portal. It is backed by CLAIM_REVIEW_PORTAL_READ, which grants no receipt queue,
 * no receipt detail, no receipt image, no verification and no financial data. Those
 * arrive in Phase 1C behind their own permission, and every one of them will
 * authorize itself again in SQL regardless of what this module returned.
 */

/**
 * The four outcomes, kept apart because they lead to four different places.
 *
 * `unavailable` is the one that matters most and is the reason this union has four
 * members rather than the three @/lib/auth/vendor-admin-access uses. A database or
 * network failure is NOT a denial: collapsing it into `unauthorized` would tell an
 * authorized reviewer they have lost access because of a transient outage, and
 * would bounce them to a denial page they cannot act on. It is modelled on
 * RetailerPortalAccess, which draws the same distinction for the same reason.
 *
 * No id of any kind is carried: no organization id, no profile id, no membership
 * id, no role id, no permission id. The two display strings are the only values the
 * portal needs, and a field that does not exist cannot leak into a page or a log.
 */
export type ClaimReviewerAccess =
  | {
      status: "authorized";
      /** For the shell header. Approved for display to the authorized reviewer. */
      userDisplayName: string;
      /** The Vendor this reviewer acts for. Approved for display. */
      organizationName: string;
    }
  | { status: "unauthenticated" }
  | { status: "unauthorized" }
  | { status: "unavailable" };

/**
 * One row of public.get_claim_reviewer_context(). Declared explicitly rather than
 * inferred, because an untyped rpc() call yields `any` and would silently accept a
 * shape change. These five columns are the function's entire output — there is no
 * membership id, role id, permission id, email, phone or Retailer id to read,
 * because the function does not return one.
 */
type ClaimReviewerContextRow = {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  organization_id: string;
  organization_name: string;
};

/**
 * A display name from the two name parts, or a neutral fallback.
 *
 * Both parts are nullable in public.profiles, and an empty header is worse than a
 * generic one. The fallback never reveals an email or an id.
 */
function buildUserDisplayName(row: ClaimReviewerContextRow): string {
  const parts = [row.first_name, row.last_name]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join(" ") : "Claim Reviewer";
}

async function resolveClaimReviewerAccess(): Promise<ClaimReviewerAccess> {
  const supabase = await createClient();

  // ---------------------------------------------------------------------------
  // 1. Identity — verified with the Auth server, never read from a cookie alone.
  // ---------------------------------------------------------------------------
  let claimsSubject: unknown;

  try {
    const { data, error } = await supabase.auth.getClaims();

    if (error || !data?.claims) {
      return { status: "unauthenticated" };
    }

    claimsSubject = data.claims.sub;
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can
    // carry token material. An identity we cannot verify is no identity at all.
    return { status: "unauthenticated" };
  }

  // A non-string or blank subject satisfies the type while being useless as a
  // filter. Reject it rather than continuing with it.
  if (typeof claimsSubject !== "string" || claimsSubject.trim().length === 0) {
    return { status: "unauthenticated" };
  }

  // ---------------------------------------------------------------------------
  // 2. Authorization — the whole chain, in one round trip, decided in SQL.
  // ---------------------------------------------------------------------------
  // public.get_claim_reviewer_context() is the single source of truth. It is
  // SECURITY DEFINER with search_path = '', identifies the caller solely through
  // auth.uid(), and TAKES NO ARGUMENTS — so this call cannot nominate an
  // organization, a profile, a role or a permission. Zero rows means not
  // authorized, for every cause alike: signed out, wrong role, inactive profile,
  // inactive membership, inactive organization, inactive role, a Retailer
  // organization, no qualifying Vendor, or MORE THAN ONE qualifying Vendor.
  //
  // The verified subject above is deliberately NOT sent. auth.uid() inside the
  // function is the same identity, established from the caller's own token, and
  // passing it as a parameter would turn a fact into something a caller supplies.
  //
  // Still the ordinary authenticated client. service_role is not used here or
  // anywhere in this codebase: it bypasses RLS and would make the caller's
  // identity a parameter rather than a fact.
  //
  // Promise.resolve() because the PostgREST builder is a thenable rather than a
  // real Promise — adopting it gives something to attach a rejection handler to
  // without changing when the request fires.
  const contextResult = await Promise.resolve(
    supabase.rpc("get_claim_reviewer_context"),
  ).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The
  // thrown value is deliberately not bound, inspected or logged — it may carry
  // request URLs, headers or token material.
  //
  // This is `unavailable`, NOT `unauthorized`. The caller's identity is verified;
  // what failed is the transport. Denying them here would be a lie the layout
  // would render as a permanent-looking refusal.
  if (contextResult === null) {
    return { status: "unavailable" };
  }

  // A reported PostgREST/RPC error. Swallowed unbound because its message can name
  // schemas, tables, columns, functions and policies, and none of that may reach a
  // browser. Also `unavailable`: the function itself never raises for an
  // unauthorized caller — it returns zero rows — so a reported error means the
  // call did not complete, not that the answer was no.
  if (contextResult.error) {
    return { status: "unavailable" };
  }

  const rows = (contextResult.data ?? []) as ClaimReviewerContextRow[];

  // Zero rows is the authoritative DENIAL, and the only one. The function collapses
  // every cause into it deliberately, so this branch must not try to guess which
  // applied — there is nothing here to distinguish them with, by design.
  if (rows.length !== 1) {
    return { status: "unauthorized" };
  }

  const row = rows[0];

  // Defence in depth over a function that already filters on auth.uid(): if the
  // returned row ever named a different subject, the honest answer is to refuse.
  // The web client performs the same re-assertion on the Vendor context.
  if (row.user_id !== claimsSubject) {
    return { status: "unauthorized" };
  }

  return {
    status: "authorized",
    userDisplayName: buildUserDisplayName(row),
    organizationName: row.organization_name,
  };
}

/**
 * The caller's Claim Review access — the single authorization export for the portal.
 *
 * React `cache` here is REQUEST-SCOPED memoization for one Server Component render,
 * and nothing more: the layout and every page beneath it resolve it once. It is NOT
 * a persistent cache and must never become one — an authorization result belongs to
 * exactly one caller for exactly one request. cache() is called once at module
 * scope; the function takes no arguments, so there is no cache key, deliberately.
 */
export const getClaimReviewerAccess = cache(resolveClaimReviewerAccess);
