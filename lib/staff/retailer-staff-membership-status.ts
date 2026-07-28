// SERVER-ONLY MODULE.
//
// The Retailer portal's staff ACTIVATION / DEACTIVATION write: a thin wrapper over one
// SECURITY DEFINER RPC, called under the CALLER'S OWN token (the ordinary
// publishable-key server client — never service-role).
//
//   public.set_retailer_staff_membership_status(p_membership_id uuid, p_status text)
//     -> (membership_id uuid, membership_status text, role_code text,
//         status_changed boolean)
//
// ============================================================================
// AUTHORIZATION LIVES ENTIRELY IN THE DATABASE
// ============================================================================
// This module contains no organization id, retailer id, role code or permission constant —
// deliberately, exactly as lib/staff/retailer-staff-shop-assignments.ts does not. The RPC
// derives the Retailer from auth.uid() through
// resolve_retailer_member_organization('RETAILER_STAFF_MANAGE'), locks the target row,
// reads its COMPLETE ACTIVE role set and requires exactly {RETAILER_MANAGER} or
// {SALES_STAFF}, refuses the caller's own membership by user id, and refuses any current
// status that is not ACTIVE or DEACTIVATED. A TypeScript copy of those conditions would be
// a second definition free to drift from the migration, and only one of the two could be
// right.
//
// THE ONLY TWO VALUES THAT CROSS: a membership id and a requested status. No Retailer
// organization id, caller user id, actor profile id, role code, permission code, current
// status, audit action or timestamp is sent — none is accepted by the function, and none is
// available here to send.
//
// NO DIRECT TABLE ACCESS. This module contains zero `.from(` calls. public.
// organization_members is SELECT-only for the browser with a single read policy and no
// INSERT/UPDATE/DELETE privilege of any kind, so there is no route to a status change but
// this RPC; that is intentional and must stay true.
//
// NO SERVICE ROLE, NO EDGE FUNCTION. This write holds no secret, sends no email and needs
// no privileged step: its entire authority is the caller's session. The RPC is granted to
// `authenticated` and to nothing else — not `anon`, not `PUBLIC`, not `service_role`.
//
// NOTHING IS DESTROYED BY THIS WRITE. Deactivation changes organization_members.status and
// deactivated_at and nothing else: the profile, the Auth identity, the roles, the live and
// retired shop assignments, the receipts, the invitations and the audit history are all
// preserved, which is why reactivation restores access without recreating anything.
//
// ERROR DISCIPLINE. Supabase/PostgREST errors are never returned to a caller and never
// rendered — their messages can name tables, columns, functions and policies. Only the
// SQLSTATE is inspected, and only to choose which of this codebase's own strings the Server
// Action will show. Nothing from PostgreSQL reaches a screen.
import { createClient } from "@/lib/supabase/server";
import {
  isStaffLifecycleStatus,
  type StaffLifecycleStatus,
} from "@/lib/staff/staff-lifecycle-input";

/**
 * The only RPC name this module may call. Declared as a constant so the security review has
 * a single, greppable place to confirm the surface, and so a typo becomes a build error
 * rather than a silent runtime failure.
 */
const SET_MEMBERSHIP_STATUS_RPC =
  "set_retailer_staff_membership_status" as const;

/**
 * The SQLSTATEs this RPC raises, and the ONLY thing ever read off an error.
 *
 * Mapped by CODE and never by message substring: the messages are not an API, and the
 * migration that shipped this function deliberately gave every disclosure-sensitive refusal
 * ONE byte-identical wording so a caller cannot use them as an existence oracle.
 *
 *   42501  insufficient_privilege — not signed in; lacks RETAILER_STAFF_MANAGE; resolves to
 *          zero or several Retailers; or a target that is unknown, another Retailer's, the
 *          caller themselves, a RETAILER_OWNER, multi-role, role-less, INVITED or
 *          SUSPENDED. ALL ONE MESSAGE in SQL.
 *   23514  check_violation — the requested status was not exactly ACTIVE or DEACTIVATED.
 *   55000  object_not_in_prerequisite_state — the acting Retailer stopped being ACTIVE
 *          between the authorization resolve and the row lock.
 *   22P02  invalid_text_representation — a malformed UUID. Raised by PostgreSQL before the
 *          function body runs, so it can only come from a tampered submission.
 */
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const NOT_IN_PREREQUISITE_STATE = "55000";
const INVALID_TEXT_REPRESENTATION = "22P02";

/** Sanitized operator logging. No ids, names, error objects, sessions or row data. */
function logStatusFailure(category: string): void {
  console.error(`[retailer-staff-lifecycle] set failed: ${category}`);
}

/**
 * The outcomes the Retailer portal renders.
 *
 * A closed union of plain statuses. On a described success it carries the CONFIRMED status
 * the database reported — never the one that was requested — so the page states what the
 * database now holds rather than what the browser asked for. No membership id, role code,
 * timestamp, SQLSTATE, PostgREST detail or backend text is carried.
 *
 * `changed` and `unchanged` are kept APART because they mean different things to an
 * operator: one is "you did that", the other is "somebody already had". Collapsing them
 * would claim an event that did not happen — the RPC writes no audit row for a no-op.
 */
export type SetStaffMembershipStatusResult =
  /** Committed, and the status actually moved. Exactly one audit row was written. */
  | { status: "changed"; membershipStatus: StaffLifecycleStatus }
  /**
   * Committed as a NO-OP. The membership was already in the requested state, so the RPC
   * performed no UPDATE, wrote no audit row, and left deactivated_at exactly as it was.
   */
  | { status: "unchanged"; membershipStatus: StaffLifecycleStatus }
  /**
   * THE PARTIAL SUCCESS. PostgREST reported no error — so the transaction committed — but
   * the response did not carry a row this module can describe. Kept DISTINCT from
   * `unavailable` because the two demand opposite behaviour from an operator: this one must
   * never be presented as a failed write, and must never invite a retry, because there is
   * nothing left to retry.
   */
  | { status: "saved-unconfirmed" }
  /** 42501 — access, session, or an unavailable / ineligible / cross-tenant target. */
  | { status: "denied" }
  /** 23514 — the requested status was not one this operation accepts. */
  | { status: "invalid" }
  /** 55000 — the Retailer became unavailable during the operation. */
  | { status: "retailer-unavailable" }
  /** 22P02 — malformed identifier or request format. Tampered submission only. */
  | { status: "malformed" }
  /** Transport failure, unexpected SQLSTATE, or a response that did not parse. */
  | { status: "unavailable" };

/**
 * Reads the confirmed status and the change flag off the RPC's response.
 *
 * PostgREST returns a `returns table (...)` function as an ARRAY of row objects, and
 * `supabase.rpc()` is untyped in this project (there are no generated database types), so
 * its result is `any`. A type assertion would be a claim about the SQL rather than a check
 * of it, and TypeScript erases it at runtime. This is a real check: if the migration is
 * edited or a column renamed, the write is reported as unconfirmed rather than rendering
 * `undefined` into a success message.
 *
 * THE STATUS IS RE-VALIDATED AGAINST THE CLOSED VOCABULARY, not merely typed as a string.
 * The RPC can only return ACTIVE or DEACTIVATED, so anything else is drift — and accepting
 * it would let an unexpected value reach the copy layer, which maps exactly two.
 *
 * `role_code` is present in the response and is deliberately NOT read: nothing this
 * application renders needs it, the roster already carries the row's display role, and a
 * role code has no business travelling further than it must.
 *
 * The function is structurally guaranteed to return exactly one row on success, so a shape
 * that is not "one object with a known status and a boolean" is drift, not a variant to
 * accommodate.
 */
function readStatusRow(
  data: unknown,
): { membershipStatus: StaffLifecycleStatus; changed: boolean } | null {
  const row = Array.isArray(data) ? data[0] : data;

  if (typeof row !== "object" || row === null) return null;

  const record = row as Record<string, unknown>;

  if (!isStaffLifecycleStatus(record.membership_status)) return null;
  if (typeof record.status_changed !== "boolean") return null;

  return {
    membershipStatus: record.membership_status,
    changed: record.status_changed,
  };
}

/**
 * Deactivates or reactivates one Retailer staff membership.
 *
 * IDEMPOTENT BY CONSTRUCTION. Requesting the status a membership already holds performs no
 * UPDATE and writes no audit row; it reports `unchanged`. So a retried request is a no-op
 * rather than a double application, and a second operator who acted first is reported
 * honestly rather than as a conflict.
 *
 * @param membershipId The canonical target: `organization_members.id`, exactly as
 *   list_retailer_staff_members() returns it as `membership_id`. Not an Auth user id, not a
 *   profile id, not an email — none of which could address a membership at all, since one
 *   person may be staff at several Retailers.
 * @param requestedStatus Exactly `ACTIVE` or `DEACTIVATED`. Typed to the closed union so a
 *   free string cannot reach the RPC from this module; the database re-validates it
 *   case-sensitively and raises 23514 for anything else.
 */
export async function setRetailerStaffMembershipStatus(
  membershipId: string,
  requestedStatus: StaffLifecycleStatus,
): Promise<SetStaffMembershipStatusResult> {
  const supabase = await createClient();

  // Promise.resolve() because the PostgREST builder is a thenable, not a real Promise — it
  // implements `then` and has no `.catch()` of its own. Adopting it gives a genuine Promise
  // to attach the rejection handler to, without altering when the request fires or what it
  // returns. This matches the existing pattern throughout this codebase.
  const result = await Promise.resolve(
    supabase.rpc(SET_MEMBERSHIP_STATUS_RPC, {
      p_membership_id: membershipId,
      p_status: requestedStatus,
    }),
  ).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The thrown value
  // is deliberately not bound, inspected or logged — it may carry request URLs, headers or
  // token material.
  if (result === null) {
    logStatusFailure("transport");
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
        // An unexpected SQLSTATE is a genuine fault, not a refusal, and is reported as one.
        // The code itself is not logged: it is small, but it is still a detail of the
        // database's internals and the category is what an operator can act on.
        logStatusFailure("rpc-error");
        return { status: "unavailable" };
    }
  }

  const row = readStatusRow(result.data as unknown);

  if (row === null) {
    // The write COMMITTED — the error field was empty — but this process cannot describe
    // what it did. Never a described success with an invented status, and never
    // `unavailable`: that would report a committed change as a failure and invite a retry
    // of something that has already happened.
    logStatusFailure("malformed-response");
    return { status: "saved-unconfirmed" };
  }

  return {
    status: row.changed ? "changed" : "unchanged",
    membershipStatus: row.membershipStatus,
  };
}
