// SERVER-ONLY MODULE.
//
// The two authorized READS behind the receipt experience, each a thin wrapper over one
// zero-argument SECURITY DEFINER RPC called under the CALLER'S OWN token (the ordinary
// publishable-key server client — never service-role).
//
// AUTHORIZATION LIVES ENTIRELY IN THE DATABASE. Both RPCs take NO ARGUMENTS and resolve
// the Retailer themselves from auth.uid() through
// public.resolve_retailer_member_organization('RECEIPT_SUBMIT') — a permission mapped
// to SALES_STAFF alone. There is no organization id, membership id, profile id, role
// id, or permission constant in this file, deliberately: a TypeScript copy of those
// conditions would be a second definition free to drift from the migrations.
//
// NO DIRECT TABLE READS. This module contains zero `.from(` calls.
// public.receipt_submissions has RLS enabled with zero policies and no privilege
// granted to any browser role, so the RPC is the only way in — and that is intentional.
//
// DENIED IS NOT EMPTY. Each RPC raises insufficient_privilege (42501) for an
// unauthorized caller rather than returning zero rows, and this module preserves that
// distinction. Collapsing them would render "you may not submit receipts" as "you have
// no shops assigned".
//
// ERROR DISCIPLINE. Supabase/PostgREST errors are never returned or rendered — their
// messages can name tables, columns, functions and policies. Every failure collapses to
// a generic discriminated status; only a sanitized category is logged.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  normalizeAssignedShops,
  normalizeReceiptSubmissions,
  type AssignedReceiptShop,
  type ReceiptSubmission,
} from "@/lib/receipts/receipt-normalization";

/**
 * The only RPC names this module may call. Declared as constants so the security review
 * has a single, greppable place to confirm the surface. Both are zero-argument.
 */
const ASSIGNED_SHOPS_RPC = "list_my_assigned_receipt_shops" as const;
const SUBMISSIONS_RPC = "list_my_receipt_submissions" as const;

/** The SQLSTATE every receipt RPC raises for an unauthorized caller. */
const INSUFFICIENT_PRIVILEGE = "42501";

export type AssignedShopsResult =
  | { status: "ok"; shops: AssignedReceiptShop[] }
  /** Not an authorized Sales Staff member. Owners and Managers land here. */
  | { status: "denied" }
  | { status: "unavailable" };

export type ReceiptSubmissionsResult =
  | { status: "ok"; submissions: ReceiptSubmission[] }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * Logs a sanitized failure category for operators.
 *
 * Deliberately NOT logged: the Supabase/PostgREST error object, its message, the
 * session, the access token, cookies, headers, the caller's user id, and any row. A log
 * line is a place data leaks to as readily as a page is.
 */
function logReceiptFailure(operation: string, category: string): void {
  console.error(`[receipts] ${operation} failed: ${category}`);
}

type RawRead =
  | { kind: "ok"; data: unknown }
  | { kind: "denied" }
  | { kind: "unavailable" };

/**
 * Calls a zero-argument RPC and classifies the outcome without surfacing an error.
 *
 * Promise.resolve() because the PostgREST builder is a thenable, not a real Promise —
 * adopting it gives a genuine Promise to attach the rejection handler to, without
 * altering when the request fires. This matches the pattern used throughout this
 * codebase.
 */
async function readRpc(operation: string, rpcName: string): Promise<RawRead> {
  const supabase = await createClient();

  const result = await Promise.resolve(supabase.rpc(rpcName)).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The thrown
  // value is deliberately not bound, inspected, or logged — it may carry request URLs,
  // headers, or token material.
  if (result === null) {
    logReceiptFailure(operation, "transport");
    return { kind: "unavailable" };
  }

  if (result.error) {
    // Only the SQLSTATE is read, and only to tell a DENIAL from a FAILURE.
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) {
      return { kind: "denied" };
    }
    logReceiptFailure(operation, "rpc-error");
    return { kind: "unavailable" };
  }

  return { kind: "ok", data: result.data as unknown };
}

/**
 * The ACTIVE shops the caller is ACTIVELY assigned to.
 *
 * THE ONLY SOURCE OF SHOP IDS IN THE RECEIPT EXPERIENCE. The selector renders its
 * options from this result and nothing else, and the Server Action re-reads it and
 * accepts a submitted shop id only if it appears here — before the reservation RPC
 * independently proves the same thing in SQL.
 *
 * REQUEST-SCOPED CACHE ONLY. React allocates a fresh cache per request, so the portal
 * layout (which uses this read as its authorization probe for a non-owner, non-reader)
 * and the receipts page resolve it once. It is NOT a persistent cache and must never
 * become one: an authorization-bearing result belongs to exactly one caller for exactly
 * one request. The function takes no arguments, so there is no cache key — deliberately.
 */
export const getMyAssignedReceiptShops = cache(
  async function getMyAssignedReceiptShops(): Promise<AssignedShopsResult> {
    const raw = await readRpc("assigned-shops", ASSIGNED_SHOPS_RPC);
    if (raw.kind === "denied") return { status: "denied" };
    if (raw.kind === "unavailable") return { status: "unavailable" };

    const normalized = normalizeAssignedShops(raw.data);
    if (normalized.status === "malformed") {
      // The reason names only field names — never values — so it is safe to log.
      logReceiptFailure("assigned-shops", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    return { status: "ok", shops: normalized.shops };
  },
);

/** The caller's OWN receipt submissions, newest first. Never anyone else's. */
export async function getMyReceiptSubmissions(): Promise<ReceiptSubmissionsResult> {
  const raw = await readRpc("submissions", SUBMISSIONS_RPC);
  if (raw.kind === "denied") return { status: "denied" };
  if (raw.kind === "unavailable") return { status: "unavailable" };

  const normalized = normalizeReceiptSubmissions(raw.data);
  if (normalized.status === "malformed") {
    logReceiptFailure("submissions", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", submissions: normalized.submissions };
}
