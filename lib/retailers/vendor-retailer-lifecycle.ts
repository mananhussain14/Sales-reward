// SERVER-ONLY MODULE.
//
// The Vendor's Retailer DEACTIVATE / REACTIVATE write: a thin wrapper over one SECURITY
// DEFINER RPC, called under the CALLER'S OWN token (the ordinary publishable-key server
// client — never service-role).
//
//   public.set_vendor_retailer_status(p_relationship_id uuid, p_status text)
//     -> (relationship_id uuid, retailer_status text, relationship_status text,
//         status_changed boolean)
//
// ============================================================================
// AUTHORIZATION LIVES ENTIRELY IN THE DATABASE
// ============================================================================
// This module contains no Vendor organization id, Retailer organization id, actor id, role
// code or permission constant — deliberately, exactly as
// @/lib/staff/retailer-staff-membership-status.ts does not. The RPC derives the acting
// Vendor from auth.uid() through get_vendor_super_admin_context(), requires RETAILERS_MANAGE
// through has_organization_permission(), matches the relationship on `id AND
// vendor_organization_id`, locks the relationship row and then the Retailer organization row
// in that fixed order, requires the organization to be a RETAILER, refuses a Retailer any
// other Vendor still holds a live relationship with, and requires the current pair to be
// exactly ACTIVE/ACTIVE or SUSPENDED/SUSPENDED. A TypeScript copy of those conditions would
// be a second definition free to drift from the migration, and only one of the two could be
// right.
//
// THE ONLY TWO VALUES THAT CROSS: a relationship id and a requested status. No Vendor
// organization id, Retailer organization id, caller user id, actor profile id, role code,
// permission code, current status, audit action or timestamp is sent — none is accepted by
// the function, and none is available here to send.
//
// TWO ROWS MOVE, ATOMICALLY, AND THAT IS WHY THIS IS ONE CALL. The RPC writes
// vendor_retailers.status AND the Retailer's organizations.status in one transaction, each
// with a compare-and-set predicate and a checked row count. Writing either from here would
// be impossible in any case: see the next paragraph.
//
// NO DIRECT TABLE ACCESS. This module contains zero `.from(` calls. public.organizations and
// public.vendor_retailers are SELECT-only for the browser with read-only policies and no
// INSERT/UPDATE/DELETE privilege of any kind, so there is no route to a status change but
// this RPC; that is intentional and must stay true.
//
// NO SERVICE ROLE, NO EDGE FUNCTION. This write holds no secret, sends no email and needs no
// privileged step: its entire authority is the caller's session. The RPC is granted to
// `authenticated` and to nothing else — not `anon`, not `PUBLIC`, not `service_role`.
//
// NOTHING IS DESTROYED BY THIS WRITE. Deactivation changes two status columns and nothing
// else: memberships, roles, Shops, live and retired Shop assignments, product assignments,
// receipts, both invitation tables, profiles, the Auth identities and the audit history are
// all preserved, which is why reactivation restores access without recreating anything.
//
// ERROR DISCIPLINE. Supabase/PostgREST errors are never returned to a caller and never
// rendered — their messages can name tables, columns, functions and policies. Only the
// SQLSTATE is inspected, and only to choose which of this codebase's own strings the Server
// Action will show. Nothing from PostgreSQL reaches a screen.
import { createClient } from "@/lib/supabase/server";
import {
  readVendorRetailerLifecycleRow,
  type VendorRetailerLifecycleStatus,
} from "@/lib/retailers/vendor-retailer-lifecycle-input";

/**
 * The only RPC name this module may call. Declared as a constant so the security review has
 * a single, greppable place to confirm the surface, and so a typo becomes a build error
 * rather than a silent runtime failure.
 */
const SET_VENDOR_RETAILER_STATUS_RPC = "set_vendor_retailer_status" as const;

/**
 * The SQLSTATEs this RPC raises, and the ONLY thing ever read off an error.
 *
 * Mapped by CODE and never by message substring: the messages are not an API, and the
 * migration that shipped this function deliberately gave every disclosure-sensitive refusal
 * ONE byte-identical wording so a caller cannot use them as an existence oracle.
 *
 *   42501  insufficient_privilege — not signed in; no Vendor context; lacks
 *          RETAILERS_MANAGE; or a target that is null, unknown, another Vendor's, or whose
 *          organization is not a RETAILER. ALL ONE MESSAGE in SQL.
 *   23514  check_violation — the requested status was not exactly ACTIVE or SUSPENDED.
 *   55000  object_not_in_prerequisite_state — the lifecycle change is unavailable. FOUR
 *          causes share this code and one message: the current pair is inconsistent, either
 *          row is DEACTIVATED, ANOTHER VENDOR still holds a live relationship with this
 *          Retailer, or a compare-and-set row count drifted. They are indistinguishable on
 *          purpose — the multi-Vendor case must not disclose that another tenant exists.
 *   22P02  invalid_text_representation — a malformed UUID. Raised by PostgreSQL before the
 *          function body runs, so it can only come from a tampered submission.
 */
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const NOT_IN_PREREQUISITE_STATE = "55000";
const INVALID_TEXT_REPRESENTATION = "22P02";

/** Sanitized operator logging. No ids, names, error objects, sessions or row data. */
function logLifecycleFailure(category: string): void {
  console.error(`[vendor-retailer-lifecycle] set failed: ${category}`);
}

/**
 * The outcomes the Vendor Retailer detail page renders.
 *
 * A closed union of plain statuses. On a described success it carries the CONFIRMED statuses
 * the database reported — never the one that was requested — so the page states what the
 * database now holds rather than what the browser asked for. No relationship id, organization
 * id, Retailer name, timestamp, SQLSTATE, PostgREST detail or backend text is carried.
 *
 * `changed` and `unchanged` are kept APART because they mean different things to an
 * administrator: one is "you did that", the other is "somebody already had". Collapsing them
 * would claim an event that did not happen — the RPC writes no audit row for a no-op.
 */
export type SetVendorRetailerStatusResult =
  /** Committed, and both rows actually moved. Exactly one audit row was written. */
  | {
      status: "changed";
      retailerStatus: VendorRetailerLifecycleStatus;
      relationshipStatus: VendorRetailerLifecycleStatus;
    }
  /**
   * Committed as a NO-OP. Both rows were already in the requested state, so the RPC
   * performed no UPDATE, wrote no audit row, and left `updated_at` exactly as it was.
   */
  | {
      status: "unchanged";
      retailerStatus: VendorRetailerLifecycleStatus;
      relationshipStatus: VendorRetailerLifecycleStatus;
    }
  /**
   * THE PARTIAL SUCCESS. PostgREST reported no error — so the transaction committed — but
   * the response did not carry a row this module can describe. Kept DISTINCT from
   * `unavailable` because the two demand opposite behaviour from an administrator: this one
   * must never be presented as a failed write, and must never invite a retry, because there
   * is nothing left to retry.
   */
  | { status: "saved-unconfirmed" }
  /** 42501 — access, session, or an unknown / foreign / wrong-type target. */
  | { status: "denied" }
  /** 23514 — the requested status was not one this operation accepts. */
  | { status: "invalid" }
  /**
   * 55000 — the lifecycle change is unavailable. The CAUSE is deliberately not carried:
   * inconsistent rows, a DEACTIVATED row, another Vendor's live relationship and row-count
   * drift all arrive here identically, and the page must not distinguish them either.
   */
  | { status: "retailer-unavailable" }
  /** 22P02 — malformed identifier. Tampered submission only. */
  | { status: "malformed" }
  /** Transport failure, unexpected SQLSTATE, or a response that did not parse. */
  | { status: "unavailable" };

/**
 * RESPONSE PARSING LIVES IN THE PURE MODULE.
 *
 * readVendorRetailerLifecycleRow() validates ALL FOUR returned columns — the relationship id
 * (present, well-formed, and EQUAL TO THE ROW THAT WAS ADDRESSED), both statuses against the
 * closed vocabulary and against each other, and the boolean change flag — plus the row COUNT.
 * It lives in @/lib/retailers/vendor-retailer-lifecycle-input because that module has no
 * imports and no I/O, which is what lets every one of those rules be exercised directly by
 * ./vendor-retailer-lifecycle-input.test.ts. This module cannot be unit-tested that way: it
 * transitively imports `next/headers`.
 *
 * The parser returns null for anything it cannot trust, and this module maps null to
 * `saved-unconfirmed` — never to `unchanged`, and never to `unavailable`. See the call site.
 */

/**
 * Deactivates or reactivates one connected Retailer.
 *
 * IDEMPOTENT BY CONSTRUCTION. Requesting the status a Retailer already holds performs no
 * UPDATE, writes no audit row and does not move `updated_at`; it reports `unchanged`. So a
 * retried request is a no-op rather than a double application, and a second administrator who
 * acted first is reported honestly rather than as a conflict.
 *
 * THERE IS NO RETRY IN THIS MODULE. Exactly one call is issued, and a failure of any kind is
 * returned to the caller to decide about. An automatic retry after a committed write would be
 * indistinguishable, from here, from a retry after a failed one.
 *
 * @param relationshipId The canonical target: `vendor_retailers.id`, exactly as the detail
 *   route addresses it. Not a Retailer organization id — the schema permits several Vendors
 *   to manage one Retailer, so an organization id does not identify whose relationship is
 *   meant and the RPC does not accept one.
 * @param requestedStatus Exactly `ACTIVE` or `SUSPENDED`. Typed to the closed union so a free
 *   string cannot reach the RPC from this module, and so the display word `INACTIVE` is not
 *   representable here; the database re-validates it case-sensitively and raises 23514 for
 *   anything else.
 */
export async function setVendorRetailerStatus(
  relationshipId: string,
  requestedStatus: VendorRetailerLifecycleStatus,
): Promise<SetVendorRetailerStatusResult> {
  const supabase = await createClient();

  // Promise.resolve() because the PostgREST builder is a thenable, not a real Promise — it
  // implements `then` and has no `.catch()` of its own. Adopting it gives a genuine Promise
  // to attach the rejection handler to, without altering when the request fires or what it
  // returns. This matches the existing pattern throughout this codebase.
  const result = await Promise.resolve(
    supabase.rpc(SET_VENDOR_RETAILER_STATUS_RPC, {
      p_relationship_id: relationshipId,
      p_status: requestedStatus,
    }),
  ).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The thrown value is
  // deliberately not bound, inspected or logged — it may carry request URLs, headers or token
  // material.
  if (result === null) {
    logLifecycleFailure("transport");
    return { status: "unavailable" };
  }

  if (result.error) {
    // Only the SQLSTATE is read. The message is never bound, returned or logged: it can name
    // tables, columns, functions and policies.
    const code = (result.error as { code?: string }).code;

    switch (code) {
      case INSUFFICIENT_PRIVILEGE:
        return { status: "denied" };
      case CHECK_VIOLATION:
        return { status: "invalid" };
      case NOT_IN_PREREQUISITE_STATE:
        return { status: "retailer-unavailable" };
      case INVALID_TEXT_REPRESENTATION:
        return { status: "malformed" };
      default:
        // An unexpected SQLSTATE is a genuine fault, not a refusal, and is reported as one.
        // The code itself is not logged: it is small, but it is still a detail of the
        // database's internals and the category is what an operator can act on.
        logLifecycleFailure("rpc-error");
        return { status: "unavailable" };
    }
  }

  // THE SUBMITTED TARGET IS PASSED IN, so the parser can prove the response describes the row
  // this call addressed — not merely a well-shaped row. A response naming a DIFFERENT
  // relationship is rejected here rather than rendered as this Retailer's outcome.
  const row = readVendorRetailerLifecycleRow(
    result.data as unknown,
    relationshipId,
  );

  if (row === null) {
    // The write COMMITTED — the error field was empty — but this process cannot describe what
    // it did. EVERY parse failure lands here: zero rows, several rows, a missing, malformed or
    // WRONG relationship id, an out-of-vocabulary status, two statuses that disagree, and a
    // non-boolean change flag.
    //
    // Never a described success with an invented status; never `unchanged`, which would claim
    // nothing happened when an entire Retailer may have just been deactivated; and never
    // `unavailable`, which would report a committed change as a failure and invite a retry of
    // something that has already happened.
    //
    // The response itself is NOT logged — it may carry a relationship id, and a wrong id is
    // exactly the kind of value that must not be written to an operator log or returned. Only
    // the category is recorded.
    logLifecycleFailure("malformed-response");
    return { status: "saved-unconfirmed" };
  }

  return {
    status: row.changed ? "changed" : "unchanged",
    retailerStatus: row.retailerStatus,
    relationshipStatus: row.relationshipStatus,
  };
}
