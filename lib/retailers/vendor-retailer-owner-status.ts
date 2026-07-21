// SERVER-ONLY MODULE.
//
// Like @/lib/retailers/vendor-retailer-detail and @/lib/retailer-portal/
// retailer-owner-portal, this must never be imported into a Client Component. It
// transitively imports `next/headers` (via @/lib/supabase/server), which throws
// at build time if it ever reaches the browser bundle.
import { createClient } from "@/lib/supabase/server";
import {
  normalizeOwnerStatusResult,
  type VendorRetailerOwnerStatus,
} from "@/lib/retailers/owner-status-normalization";

/**
 * Server data access for the Vendor-authorized Retailer Owner status.
 *
 * ONE RPC, NOTHING ELSE. This module calls exactly one function —
 * public.get_vendor_retailer_owner_status — and contains zero `.from(` table
 * reads. That RPC is SECURITY DEFINER and performs its OWN Vendor authorization:
 * it derives the Vendor from auth.uid(), requires the RETAILERS_READ authority,
 * and verifies that the supplied relationship belongs to that Vendor before
 * returning one display-safe row. This wrapper therefore neither re-implements nor
 * supplements that decision — a TypeScript copy of it would be a second definition
 * free to drift from the migration.
 *
 * ORDINARY AUTHENTICATED CLIENT ONLY. The call goes through @/lib/supabase/server,
 * which uses the publishable key and the caller's own token. service_role is not
 * used here or anywhere in this codebase, and the Supabase Auth Admin API is never
 * touched — this is a read, under the caller's identity, and nothing more.
 *
 * ONE INPUT, AND IT IS AN ADDRESS. `relationshipId` says WHICH of the caller's own
 * relationships to report on. It is the same route segment the detail page already
 * holds; it is not authorization, and the RPC re-verifies it against the Vendor it
 * derives. No organization id, user id, email, or any other tenant value is
 * accepted or sent.
 *
 * ERROR DISCIPLINE. A transport failure, a reported RPC error (including the RPC's
 * own authorization raise), and a malformed row all collapse to a single
 * "unavailable" result. The Supabase/PostgREST error object is never bound,
 * returned, or logged — its message can name tables, columns, functions, and
 * policies. Only a sanitized category is logged. "unavailable" is deliberately its
 * own outcome and is NEVER coerced to a NONE state: a failed read must not read as
 * "this Retailer has no owner".
 */

/**
 * The only RPC this module may call. A constant so the security review has a
 * single greppable place to confirm the surface and a typo is a build error.
 */
const OWNER_STATUS_RPC = "get_vendor_retailer_owner_status" as const;

export type VendorRetailerOwnerStatusResult =
  | { status: "ok"; ownerStatus: VendorRetailerOwnerStatus }
  /** The read could not be completed. Distinct from any owner state, never NONE. */
  | { status: "unavailable" };

/**
 * Logs a sanitized failure category for operators. Deliberately NOT logged: the
 * Supabase/PostgREST error object, its message, the session, the token, the
 * relationship id, or any row data.
 */
function logOwnerStatusFailure(category: string): void {
  console.error(`[owner-status] read failed: ${category}`);
}

/**
 * Resolves the Vendor-authorized owner status for one relationship.
 *
 * Never throws: every failure mode returns { status: "unavailable" }, so a caller
 * composing this alongside other reads cannot be broken by an owner-status
 * problem.
 */
export async function getVendorRetailerOwnerStatus(
  relationshipId: string,
): Promise<VendorRetailerOwnerStatusResult> {
  const supabase = await createClient();

  // Promise.resolve() because the PostgREST builder is a thenable, not a real
  // Promise — it implements `then` and has no `.catch()` of its own. Adopting it
  // gives a genuine Promise to attach the rejection handler to, matching the
  // pattern in @/lib/retailer-portal/retailer-owner-portal and the invitation
  // service.
  const result = await Promise.resolve(
    supabase.rpc(OWNER_STATUS_RPC, { p_relationship_id: relationshipId }),
  ).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The
  // thrown value is not bound or logged — it may carry request URLs, headers, or
  // token material.
  if (result === null) {
    logOwnerStatusFailure("transport");
    return { status: "unavailable" };
  }

  // A reported PostgREST/RPC error — including the RPC's own authorization raise.
  // Swallowed unbound: its message can name tables, columns, functions, policies.
  if (result.error) {
    logOwnerStatusFailure("rpc-error");
    return { status: "unavailable" };
  }

  // Passed as `unknown`, not asserted. The pure normalization layer does the real
  // checking — see ./owner-status-normalization.ts.
  const normalized = normalizeOwnerStatusResult(result.data as unknown);

  if (normalized.status === "malformed") {
    // Schema drift or a genuinely broken row. The reason names only field names —
    // never values — so it is safe to log.
    logOwnerStatusFailure(`malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }

  return { status: "ok", ownerStatus: normalized.value };
}
