// SERVER-ONLY MODULE.
//
// Like @/lib/auth/vendor-admin-access, this must never be imported into a Client
// Component. It transitively imports `next/headers` (via @/lib/supabase/server),
// which throws at build time if it ever reaches the browser bundle — the same
// guard the rest of this codebase relies on.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  normalizeContextResult,
  normalizeShopsResult,
  type RetailerOwnerPortalContext,
  type RetailerOwnerPortalShop,
} from "@/lib/retailer-portal/portal-normalization";

/**
 * Server data access for the Retailer Owner Portal.
 *
 * AUTHORIZATION LIVES ENTIRELY IN THE DATABASE. Both functions below call a
 * zero-argument SECURITY DEFINER RPC that resolves the caller from auth.uid()
 * and evaluates the whole chain in SQL: ACTIVE profile owned by auth.uid(),
 * ACTIVE membership, ACTIVE RETAILER organization, ACTIVE RETAILER_OWNER role
 * reached through that same membership, and the required read permission. Zero
 * rows means not authorized, and the SQL never distinguishes why.
 *
 * This module therefore does NOT re-implement, supplement, or second-guess that
 * decision. There is no organization filter, no role check, and no permission
 * constant in this file — deliberately. A TypeScript copy of those conditions
 * would be a second definition free to drift from the migration, and only one of
 * the two could be right.
 *
 * NO TENANT INPUT, ANYWHERE. Neither function takes arguments, and neither RPC
 * accepts any. There is no organization id, retailer id, relationship id,
 * membership id, profile id, user id, email, role id, or permission id to pass —
 * so no URL segment, query parameter, form field, header, or cookie value can
 * nominate whose data is returned. This is why the portal routes carry no
 * dynamic id: there is nothing for one to address.
 *
 * ORDINARY AUTHENTICATED CLIENT ONLY. Every call goes through
 * @/lib/supabase/server, which uses the publishable key and the caller's own
 * token. service_role is not used here or anywhere in this codebase — it would
 * bypass RLS and make this module, rather than the database, the thing standing
 * between one Retailer and another. The Supabase Auth Admin API is likewise
 * never touched.
 *
 * NO DIRECT TABLE READS. This module contains zero `.from(` calls. The portal's
 * browser contract is the narrow RPC result and nothing else: the underlying
 * tables either deny a Retailer Owner outright or return nothing to them under
 * RLS, and that is intentional and must stay true. Reading a table here to
 * "enrich" the portal would route around the very isolation the migration
 * establishes.
 *
 * ERROR DISCIPLINE. Supabase/PostgREST errors are never returned to a caller and
 * never rendered. Their messages can name tables, columns, functions, policies,
 * and constraints. Every failure below collapses to a generic discriminated
 * status; the sanitized category is logged server-side only, without the error
 * object, the session, the token, or any row data.
 */

/**
 * The only two RPC names this module may call. Declared as constants so the
 * security review has a single, greppable place to confirm the surface, and so a
 * typo becomes a build error rather than a silent runtime failure.
 *
 * Both are zero-argument. Neither is ever invoked with a parameter object.
 */
const CONTEXT_RPC = "get_retailer_owner_portal_context" as const;
const SHOPS_RPC = "list_retailer_owner_portal_shops" as const;

/**
 * NOTE ON GENERATED DATABASE TYPES.
 *
 * This project maintains no generated Supabase `Database` type (there is no
 * database.types.ts anywhere in the repository), so `supabase.rpc()` is untyped
 * and yields `any`. Rather than assert a shape — a claim TypeScript erases at
 * runtime — the raw result is passed as `unknown` into the pure normalization
 * layer, which checks every field for real.
 *
 * Regenerating database types is a separate, controlled step and is deliberately
 * not performed here: it would rewrite a file this milestone does not own, and
 * the command requires hosted project access.
 */

export type RetailerOwnerPortalAccess =
  | { status: "authorized"; context: RetailerOwnerPortalContext }
  | { status: "unauthenticated" }
  /** Authenticated, but not a single qualifying active Retailer Owner. */
  | { status: "unauthorized" }
  /** The read could not be completed. Distinct from "denied". */
  | { status: "unavailable" };

export type RetailerOwnerShopsResult =
  | { status: "ok"; shops: RetailerOwnerPortalShop[] }
  | { status: "unavailable" };

/**
 * Logs a sanitized failure category for operators.
 *
 * What is deliberately NOT logged: the Supabase/PostgREST error object, its
 * message, the session, the access token, cookies, headers, the caller's user
 * id, and any row returned by the database. A log line is a place data leaks to
 * as readily as a page is, and this one is read far more casually.
 */
function logPortalFailure(operation: string, category: string): void {
  console.error(
    `[retailer-portal] ${operation} failed: ${category}`,
  );
}

/**
 * Resolves the caller's Retailer Owner portal context from their own verified
 * session. Takes no arguments — see the module note above.
 *
 * Private: every caller goes through the cached export at the bottom.
 */
async function resolveRetailerOwnerPortalAccess(): Promise<RetailerOwnerPortalAccess> {
  const supabase = await createClient();

  // ---------------------------------------------------------------------------
  // 1. Identity — from the verified token, never from application input.
  // ---------------------------------------------------------------------------
  // getClaims() cryptographically verifies the JWT signature and refreshes a
  // near-expiry token. getSession() is never used anywhere in this codebase: it
  // returns the cookie's contents unverified, so a tampered cookie would be
  // believed.
  //
  // The subject is used ONLY to distinguish "signed out" (-> /login) from
  // "signed in but not authorized" (-> access denied). It is never sent to the
  // database: the RPC reads auth.uid() from the request's own JWT, so passing an
  // id would be both redundant and exactly the vulnerability the zero-argument
  // shape avoids.
  let claimsSubject: string | undefined;
  try {
    const { data } = await supabase.auth.getClaims();
    claimsSubject = data?.claims?.sub;
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can
    // carry token material. An identity we cannot verify is no identity.
    return { status: "unauthenticated" };
  }

  if (typeof claimsSubject !== "string" || claimsSubject.trim().length === 0) {
    return { status: "unauthenticated" };
  }

  // ---------------------------------------------------------------------------
  // 2. Authorization + context — one round trip, decided entirely in SQL.
  // ---------------------------------------------------------------------------
  // Promise.resolve() because the PostgREST builder is a thenable, not a real
  // Promise — it implements `then` and has no `.catch()` of its own. Adopting it
  // gives a genuine Promise to attach the rejection handler to, without altering
  // when the request fires or what it returns. This matches the existing pattern
  // in @/lib/auth/vendor-admin-access.
  const contextResult = await Promise.resolve(supabase.rpc(CONTEXT_RPC)).catch(
    () => null,
  );

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The
  // thrown value is deliberately not bound, inspected, or logged — it may carry
  // request URLs, headers, or token material.
  //
  // This is "unavailable", NOT "unauthorized". The distinction is the whole
  // reason both statuses exist: a transport failure is not a permission
  // decision, and telling an authorized Retailer Owner that they lack access
  // because a network hiccup occurred would be a lie that invites them to chase
  // a support ticket for a problem that fixes itself on retry.
  if (contextResult === null) {
    logPortalFailure("context", "transport");
    return { status: "unavailable" };
  }

  // A reported PostgREST/RPC error. Swallowed unbound: its message can name
  // tables, columns, functions, and policies.
  if (contextResult.error) {
    logPortalFailure("context", "rpc-error");
    return { status: "unavailable" };
  }

  // Passed as `unknown`, not asserted. The normalization layer does the real
  // checking — see ./portal-normalization.ts.
  const normalized = normalizeContextResult(contextResult.data as unknown);

  if (normalized.status === "no-context") {
    // The caller is authenticated but did not resolve exactly one qualifying
    // Retailer. Every denial case lands here identically: inactive profile,
    // INVITED or inactive membership, inactive Retailer, missing or inactive
    // RETAILER_OWNER role, missing permission, a Vendor Super Admin with no
    // Retailer Owner membership, zero qualifying retailers, and the ambiguous
    // multi-retailer case.
    //
    // They are NOT distinguished here because the SQL does not distinguish them
    // either — and must not. Reporting which condition failed would tell an
    // unauthorized (possibly hostile) account exactly what to acquire next, and
    // the ambiguous case would additionally confirm that a second Retailer
    // exists.
    return { status: "unauthorized" };
  }

  if (normalized.status === "malformed") {
    // Schema drift or a genuinely broken row. The reason is operator-facing and
    // names only field names — never values — so it is safe to log.
    logPortalFailure("context", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }

  return { status: "authorized", context: normalized.context };
}

/**
 * The caller's Retailer Owner portal context — the only authorization export.
 *
 * React `cache` here is REQUEST-SCOPED memoization for a single Server Component
 * render, and nothing more. React allocates a fresh cache per request, so the
 * portal layout and the overview page — which both need the context while
 * rendering the same request — resolve it once instead of calling the RPC twice.
 *
 * It is NOT a cache in the persistent sense and must never become one. An
 * authorization result belongs to exactly one caller for exactly one request:
 * carrying it across requests would serve one Retailer Owner's context to
 * another, and holding it beyond the request would keep a stale `authorized`
 * alive after a membership, role, or organization was suspended. No
 * unstable_cache, no "use cache", no revalidation window, no module global.
 *
 * cache() is called once at module scope — calling it inside a function would
 * build a new cache per call and memoize nothing. The function takes no
 * arguments, so there is no cache key, deliberately: a key derived from a user
 * id, token, cookie, or email would mean accepting the caller's identity as
 * input, which is exactly what the zero-argument chain avoids.
 */
export const getRetailerOwnerPortalAccess = cache(
  resolveRetailerOwnerPortalAccess,
);

/**
 * The authorized Retailer's shops.
 *
 * Takes no arguments and passes none. Scope comes from the RPC's own resolution
 * of auth.uid() — the same chain, re-evaluated independently in SQL against the
 * RETAILER_SHOPS_READ permission. It is NOT derived from the context call above,
 * and the two are deliberately not chained: the database is the authority for
 * each read, and a caller who somehow held one permission but not the other must
 * get the correct answer for each.
 *
 * Returns "unavailable" for every failure and never an error object. An empty
 * array is a valid, successful answer meaning the Retailer has no shops on
 * record — never a denial. Callers must not conflate the two.
 *
 * NOT request-cached: unlike the context, this is read by exactly one page.
 */
export async function getRetailerOwnerPortalShops(): Promise<RetailerOwnerShopsResult> {
  const supabase = await createClient();

  const shopsResult = await Promise.resolve(supabase.rpc(SHOPS_RPC)).catch(
    () => null,
  );

  if (shopsResult === null) {
    logPortalFailure("shops", "transport");
    return { status: "unavailable" };
  }

  if (shopsResult.error) {
    logPortalFailure("shops", "rpc-error");
    return { status: "unavailable" };
  }

  const normalized = normalizeShopsResult(shopsResult.data as unknown);

  if (normalized.status === "malformed") {
    logPortalFailure("shops", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }

  return { status: "ok", shops: normalized.shops };
}
