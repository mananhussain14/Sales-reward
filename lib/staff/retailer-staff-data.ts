// SERVER-ONLY MODULE.
//
// The three authorized READS behind the Retailer staff-management experience, each a
// thin wrapper over one zero-argument SECURITY DEFINER RPC called under the CALLER'S
// OWN token (the ordinary publishable-key server client — never service-role).
//
// AUTHORIZATION LIVES ENTIRELY IN THE DATABASE, exactly as in
// lib/retailer-portal/retailer-owner-portal.ts. Every RPC below takes NO ARGUMENTS and
// resolves the Retailer itself from auth.uid() through
// public.resolve_retailer_member_organization(<permission>):
//
//   list_retailer_staff_members()            RETAILER_STAFF_READ         Owner + Manager
//   list_retailer_staff_invitations()        RETAILER_STAFF_MANAGE       Owner only
//   list_retailer_staff_assignable_shops()   RETAILER_STAFF_SHOP_ASSIGN  Owner only
//
// There is no organization id, retailer id, membership id, role id, or permission
// constant in this file — deliberately. A TypeScript copy of those conditions would be
// a second definition free to drift from the migrations, and only one of the two could
// be right. No URL segment, query parameter, form field, header, or cookie can
// nominate whose data is returned, because none of these functions accepts anything.
//
// NO DIRECT TABLE READS. This module contains zero `.from(` calls. Retailer members
// are denied `public.retailer_shops` outright by RLS (its only policy is
// Vendor-scoped), and the staff tables deny every browser role; that is intentional and
// must stay true.
//
// ERROR DISCIPLINE. Supabase/PostgREST errors are never returned to a caller and never
// rendered — their messages can name tables, columns, functions, and policies. Every
// failure collapses to a generic discriminated status; only a sanitized category is
// logged, without the error object, the session, the token, or any row data.
//
// DENIED IS NOT EMPTY. Each RPC raises insufficient_privilege (SQLSTATE 42501) for an
// unauthorized caller rather than returning zero rows, and this module preserves that
// distinction. Collapsing them would let a Manager's "you may not see invitations" be
// rendered as "this Retailer has no invitations".
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  normalizeAssignableShops,
  normalizeStaffInvitations,
  normalizeStaffMembers,
  type AssignableShop,
  type StaffInvitation,
  type StaffMember,
} from "@/lib/staff/staff-normalization";

/**
 * The only RPC names this module may call. Declared as constants so the security
 * review has a single, greppable place to confirm the surface, and so a typo becomes a
 * build error rather than a silent runtime failure. All three are zero-argument.
 */
const MEMBERS_RPC = "list_retailer_staff_members" as const;
const INVITATIONS_RPC = "list_retailer_staff_invitations" as const;
const ASSIGNABLE_SHOPS_RPC = "list_retailer_staff_assignable_shops" as const;

/** The PostgreSQL SQLSTATE every staff RPC raises for an unauthorized caller. */
const INSUFFICIENT_PRIVILEGE = "42501";

export type StaffMembersResult =
  | { status: "ok"; members: StaffMember[] }
  /** The caller does not hold RETAILER_STAFF_READ for any single Retailer. */
  | { status: "denied" }
  | { status: "unavailable" };

export type StaffInvitationsResult =
  | { status: "ok"; invitations: StaffInvitation[] }
  /** The caller does not hold RETAILER_STAFF_MANAGE. A Manager lands here. */
  | { status: "denied" }
  | { status: "unavailable" };

export type AssignableShopsResult =
  | { status: "ok"; shops: AssignableShop[] }
  /** The caller does not hold RETAILER_STAFF_SHOP_ASSIGN. A Manager lands here. */
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * Logs a sanitized failure category for operators.
 *
 * What is deliberately NOT logged: the Supabase/PostgREST error object, its message,
 * the session, the access token, cookies, headers, the caller's user id, and any row
 * returned by the database. A log line is a place data leaks to as readily as a page
 * is, and this one is read far more casually.
 */
function logStaffFailure(operation: string, category: string): void {
  console.error(`[retailer-staff] ${operation} failed: ${category}`);
}

/** The shape every RPC call in this module collapses to before normalization. */
type RawRead =
  | { kind: "ok"; data: unknown }
  | { kind: "denied" }
  | { kind: "unavailable" };

/**
 * Calls a zero-argument RPC and classifies the outcome without ever surfacing an error
 * object.
 *
 * Promise.resolve() because the PostgREST builder is a thenable, not a real Promise —
 * it implements `then` and has no `.catch()` of its own. Adopting it gives a genuine
 * Promise to attach the rejection handler to, without altering when the request fires
 * or what it returns. This matches the existing pattern throughout this codebase.
 */
async function readRpc(operation: string, rpcName: string): Promise<RawRead> {
  const supabase = await createClient();

  const result = await Promise.resolve(supabase.rpc(rpcName)).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The thrown
  // value is deliberately not bound, inspected, or logged — it may carry request URLs,
  // headers, or token material.
  if (result === null) {
    logStaffFailure(operation, "transport");
    return { kind: "unavailable" };
  }

  if (result.error) {
    // Only the SQLSTATE is read, and only to tell a DENIAL from a FAILURE. The
    // message is never bound, returned, or logged: it can name tables, columns,
    // functions, and policies.
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) {
      return { kind: "denied" };
    }
    logStaffFailure(operation, "rpc-error");
    return { kind: "unavailable" };
  }

  return { kind: "ok", data: result.data as unknown };
}

/**
 * The authorized Retailer's staff roster.
 *
 * REQUEST-SCOPED CACHE ONLY. React allocates a fresh cache per request, so the portal
 * layout (which uses this read as its authorization probe for a non-owner) and the
 * staff page resolve it once instead of calling the RPC twice. It is NOT a cache in
 * the persistent sense and must never become one: an authorization-bearing result
 * belongs to exactly one caller for exactly one request. No unstable_cache, no
 * "use cache", no revalidation window, no module global. The function takes no
 * arguments, so there is no cache key — deliberately, since a key derived from a user
 * id or token would mean accepting the caller's identity as input.
 */
export const getRetailerStaffMembers = cache(
  async function getRetailerStaffMembers(): Promise<StaffMembersResult> {
    const raw = await readRpc("members", MEMBERS_RPC);
    if (raw.kind === "denied") return { status: "denied" };
    if (raw.kind === "unavailable") return { status: "unavailable" };

    const normalized = normalizeStaffMembers(raw.data);
    if (normalized.status === "malformed") {
      // The reason names only field names — never values — so it is safe to log.
      logStaffFailure("members", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    return { status: "ok", members: normalized.members };
  },
);

/** The authorized Retailer's staff invitations. Owner-only by permission mapping. */
export async function getRetailerStaffInvitations(): Promise<StaffInvitationsResult> {
  const raw = await readRpc("invitations", INVITATIONS_RPC);
  if (raw.kind === "denied") return { status: "denied" };
  if (raw.kind === "unavailable") return { status: "unavailable" };

  const normalized = normalizeStaffInvitations(raw.data);
  if (normalized.status === "malformed") {
    logStaffFailure("invitations", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", invitations: normalized.invitations };
}

/**
 * The ACTIVE shops that may be attached to a Sales Staff invitation, WITH their ids.
 *
 * THE ONLY SOURCE OF SHOP IDS IN THE APPLICATION. The invite form renders its checkbox
 * options from this result and nothing else, and the Server Action re-reads it and
 * accepts a submitted id only if it appears here (see
 * lib/staff/staff-invite-input.ts). Owner-only by permission mapping — a Manager
 * receives `denied` and never sees a shop id.
 */
export async function getRetailerStaffAssignableShops(): Promise<AssignableShopsResult> {
  const raw = await readRpc("assignable-shops", ASSIGNABLE_SHOPS_RPC);
  if (raw.kind === "denied") return { status: "denied" };
  if (raw.kind === "unavailable") return { status: "unavailable" };

  const normalized = normalizeAssignableShops(raw.data);
  if (normalized.status === "malformed") {
    logStaffFailure("assignable-shops", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", shops: normalized.shops };
}
