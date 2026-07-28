// SERVER-ONLY MODULE.
//
// The Retailer portal's post-acceptance shop-assignment WRITE: a thin wrapper over one
// SECURITY DEFINER RPC, called under the CALLER'S OWN token (the ordinary
// publishable-key server client — never service-role).
//
//   public.set_retailer_staff_shop_assignments(p_membership_id uuid, p_shop_ids uuid[])
//     -> (shops_added integer, shops_removed integer, shops_unchanged integer)
//
// ============================================================================
// AUTHORIZATION LIVES ENTIRELY IN THE DATABASE
// ============================================================================
// This module contains no organization id, retailer id, role code or permission constant
// — deliberately, exactly as lib/staff/retailer-staff-data.ts does not. The RPC derives
// the Retailer from auth.uid() through
// resolve_retailer_member_organization('RETAILER_STAFF_SHOP_ASSIGN'), re-reads the
// target's role and membership status, and re-validates every shop against that Retailer.
// A TypeScript copy of those conditions would be a second definition free to drift from
// the migration, and only one of the two could be right.
//
// THE ONLY TWO VALUES THAT CROSS: a membership id and a shop-id array. No Retailer
// organization id, caller user id, actor profile id, role code, permission code, current
// assignment list, audit actor, status or timestamp is sent — none is accepted by the
// function, and none is available here to send.
//
// NO DIRECT TABLE ACCESS. This module contains zero `.from(` calls.
// public.retailer_shop_members has RLS enabled with ZERO policies and REVOKE ALL from
// every browser role, so there is no route to it but this RPC; that is intentional and
// must stay true.
//
// NO SERVICE ROLE, NO EDGE FUNCTION. Unlike invitation delivery, this write holds no
// secret, sends no email and needs no privileged step: its entire authority is the
// caller's session. The RPC is granted to `authenticated` and to nothing else — not
// `anon`, not `PUBLIC`, not `service_role`.
//
// ERROR DISCIPLINE. Supabase/PostgREST errors are never returned to a caller and never
// rendered — their messages can name tables, columns, functions and policies. Only the
// SQLSTATE is inspected, and only to choose which of this codebase's own strings the
// Server Action will show. Nothing from PostgreSQL reaches a screen.
import { createClient } from "@/lib/supabase/server";

/**
 * The only RPC name this module may call. Declared as a constant so the security review
 * has a single, greppable place to confirm the surface, and so a typo becomes a build
 * error rather than a silent runtime failure.
 */
const SET_SHOP_ASSIGNMENTS_RPC = "set_retailer_staff_shop_assignments" as const;

/**
 * The SQLSTATEs this RPC raises, and the ONLY thing ever read off an error.
 *
 * Mapped by CODE and never by message substring: the messages are not an API, and the
 * milestone that shipped this function deliberately gave every refusal in a class one
 * identical wording so a caller cannot use them as an existence oracle.
 *
 *   42501  insufficient_privilege — not signed in; lacks RETAILER_STAFF_SHOP_ASSIGN;
 *          resolves to zero or several Retailers; or a target that is unknown, another
 *          Retailer's, not ACTIVE, or not exactly SALES_STAFF. ALL ONE MESSAGE in SQL.
 *   23514  check_violation — an empty or null shop set, a null element, or a shop that is
 *          unknown, inactive or another Retailer's.
 *   55000  object_not_in_prerequisite_state — the Retailer stopped being ACTIVE between
 *          the authorization resolve and the row lock.
 *   22P02  invalid_text_representation — a malformed UUID. Raised by PostgreSQL before
 *          the function body runs, so it can only come from a tampered submission.
 */
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const NOT_IN_PREREQUISITE_STATE = "55000";
const INVALID_TEXT_REPRESENTATION = "22P02";

/** Sanitized operator logging. No ids, names, error objects, sessions or row data. */
function logAssignmentFailure(category: string): void {
  console.error(`[retailer-staff-shops] set failed: ${category}`);
}

/**
 * The outcomes the Retailer portal renders.
 *
 * A closed union of plain statuses plus, on success, the three integer counts the RPC
 * itself returned. No membership id, shop id, shop name, timestamp, SQLSTATE, PostgREST
 * detail or backend text is carried — the Server Action maps each status to one of this
 * codebase's own strings.
 *
 * `denied` and `invalid` are kept APART even though both are refusals, because they mean
 * different things to an operator: one is "you may not do this / that person is not
 * yours", the other is "the shops you picked are no longer valid — look again".
 * Collapsing them into "something went wrong" would be the failure mode the brief calls
 * out, and collapsing them into each other would misdirect the fix.
 */
export type SetStaffShopAssignmentsResult =
  /** Committed. The counts describe the ACTIVE VISIBLE replacement only. */
  | { status: "saved"; added: number; removed: number; unchanged: number }
  /**
   * THE PARTIAL SUCCESS. PostgREST reported no error — so the transaction committed —
   * but the response did not carry the three counts this module can describe. Kept
   * DISTINCT from `unavailable` because the two demand opposite behaviour from an
   * operator: this one must never be presented as a failed write, and must never invite
   * a retry, because there is nothing left to retry.
   */
  | { status: "saved-unconfirmed" }
  /** 42501 — access, session, or an unavailable / cross-tenant target. */
  | { status: "denied" }
  /** 23514 — no shops, or a shop that is invalid, inactive, foreign or unavailable. */
  | { status: "invalid" }
  /** 55000 — the Retailer became unavailable during the operation. */
  | { status: "retailer-unavailable" }
  /** 22P02 — malformed identifier or request format. Tampered submission only. */
  | { status: "malformed" }
  /** Transport failure, unexpected SQLSTATE, or a response that did not parse. */
  | { status: "unavailable" };

/**
 * Reads the three counts off the RPC's response.
 *
 * PostgREST returns a `returns table (...)` function as an ARRAY of row objects, and
 * `supabase.rpc()` is untyped in this project (there are no generated database types),
 * so its result is `any`. A type assertion would be a claim about the SQL rather than a
 * check of it, and TypeScript erases it at runtime. This is a real check: if the
 * migration is edited or a column renamed, the write is reported as `unavailable` rather
 * than rendering `undefined` into a success message.
 *
 * The function is structurally guaranteed to return exactly one row on success, so a
 * shape that is not "one object with three finite non-negative integers" is drift, not a
 * variant to accommodate.
 */
function readCounts(
  data: unknown,
): { added: number; removed: number; unchanged: number } | null {
  const row = Array.isArray(data) ? data[0] : data;

  if (typeof row !== "object" || row === null) return null;

  const record = row as Record<string, unknown>;

  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : null;

  const added = count(record.shops_added);
  const removed = count(record.shops_removed);
  const unchanged = count(record.shops_unchanged);

  if (added === null || removed === null || unchanged === null) return null;

  return { added, removed, unchanged };
}

/**
 * Replaces a Sales Staff member's ACTIVE shop assignments with exactly `shopIds`.
 *
 * COMPLETE REPLACEMENT, and the diff is the database's to compute. This module sends the
 * whole desired set and never an "add these / remove those" pair, so no client claim
 * about the current state is ever trusted and a retried request is a no-op rather than a
 * double application.
 *
 * ⚠️ THE REPLACEMENT IS SCOPED TO SHOPS THAT ARE CURRENTLY ACTIVE. A live assignment to a
 * suspended or deactivated shop is invisible to every client, is PRESERVED by the RPC,
 * and is counted in none of the three totals. The counts returned here therefore describe
 * a change to the visible set — they are not, and must never be presented as, the
 * member's shop count.
 *
 * @param membershipId The canonical target: `organization_members.id`, exactly as
 *   list_retailer_staff_members() returns it as `membership_id`. Not an Auth user id, not
 *   a profile id, not an email, not a member-role id — none of which could address a
 *   membership at all, since one person may be staff at several Retailers.
 */
export async function setRetailerStaffShopAssignments(
  membershipId: string,
  shopIds: readonly string[],
): Promise<SetStaffShopAssignmentsResult> {
  const supabase = await createClient();

  // Promise.resolve() because the PostgREST builder is a thenable, not a real Promise —
  // it implements `then` and has no `.catch()` of its own. Adopting it gives a genuine
  // Promise to attach the rejection handler to, without altering when the request fires
  // or what it returns. This matches the existing pattern throughout this codebase.
  const result = await Promise.resolve(
    supabase.rpc(SET_SHOP_ASSIGNMENTS_RPC, {
      p_membership_id: membershipId,
      p_shop_ids: shopIds,
    }),
  ).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The thrown value
  // is deliberately not bound, inspected or logged — it may carry request URLs, headers
  // or token material.
  if (result === null) {
    logAssignmentFailure("transport");
    return { status: "unavailable" };
  }

  if (result.error) {
    // Only the SQLSTATE is read. The message is never bound, returned or logged: it can
    // name tables, columns, functions and policies.
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
        // An unexpected SQLSTATE is a genuine fault, not a refusal, and is reported as
        // one. The code itself is not logged: it is small, but it is still a detail of
        // the database's internals and the category is what an operator can act on.
        logAssignmentFailure("rpc-error");
        return { status: "unavailable" };
    }
  }

  const counts = readCounts(result.data as unknown);

  if (counts === null) {
    // The write COMMITTED — the error field was empty — but this process cannot describe
    // what it did. Never `saved` with invented numbers, and never `unavailable`: that
    // would report a committed change as a failure and invite a retry of something that
    // has already happened.
    logAssignmentFailure("malformed-response");
    return { status: "saved-unconfirmed" };
  }

  return { status: "saved", ...counts };
}
