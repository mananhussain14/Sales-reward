/**
 * PURE MODULE — no I/O, no `next/headers`, no Supabase client, no crypto, no Deno API,
 * no Node API. Its ONE import is the sibling contract module, which is equally pure, so
 * this file loads unchanged in Deno (from the Edge Function) and in Node (from
 * ./staff-invite-flow.test.ts).
 *
 * THE ORDER of the staff-invitation delivery sequence, expressed once, with every effect
 * injected. The runtime that supplies the real ports —
 * supabase/functions/send-retailer-staff-invitation/index.ts — cannot be unit-tested
 * (it calls `Deno.serve`, reads `Deno.env`, and imports from `npm:`), so the sequence
 * itself lives here and is exercised directly by ./staff-invite-flow.test.ts against
 * fake ports that record what was called, in what order, with what arguments.
 *
 * ONE SEQUENCE FOR BOTH CLIENTS. The web Retailer portal and the Flutter app both reach
 * it through the same Edge Function, so neither can execute a different order, skip a
 * step, or classify an outcome its own way.
 *
 * THE SEQUENCE, and why each step is where it is:
 *
 *   1. reserve      — under the CALLER'S OWN token. Obtains (or reuses) the invitation
 *                     id and the canonical email. This is the authorization step: the
 *                     RPC derives the Retailer from auth.uid(), requires
 *                     RETAILER_STAFF_MANAGE, validates every shop against that Retailer,
 *                     and refuses a recipient who already holds any membership there.
 *                     Nothing has been sent yet, so a refusal costs nothing.
 *   2. generateToken— a fresh cryptographically random raw token and its SHA-256 hash.
 *                     EVERY send, including a resend and a retry after a delivery
 *                     failure, mints a NEW token here. There is no branch that reuses
 *                     one: the previous token is invalidated by step 3.
 *   3. prepare      — under the SERVICE-ROLE client. Stores ONLY the hash, rotates the
 *                     token, refreshes the 24-hour window, and clears prior delivery
 *                     state. It returns the display fields for the email, so the message
 *                     is built from DATABASE values rather than from anything a client
 *                     submitted.
 *   4. sendEmail    — Resend delivers the app-owned link containing the RAW token.
 *   5. record       — recordSent on success, recordFailure otherwise. Both are keyed by
 *                     the EXPECTED hash, so a callback for a superseded token is refused
 *                     by the database rather than overwriting newer state.
 *
 * THE INVITATION ID USED BY STEPS 3 AND 5 COMES ONLY FROM STEP 1. There is no parameter
 * for it and no way for a client to supply one: `StaffInviteReserveInput` has no such
 * field, and the value passed to `prepare`, `recordSent` and `recordFailure` is read
 * from the reservation result in this file.
 *
 * THE RAW TOKEN. It is produced in step 2, used in step 4, and never leaves this
 * sequence: it is not returned to the caller, not placed in the result, not passed to
 * record*, and not logged. Only the HASH travels to the database, and the hash is
 * likewise absent from every result below — nothing here can reach a client.
 *
 * NO AUTOMATIC RETRY. There is no loop and no second attempt at any step. A failed send
 * is reported; whether to try again is the operator's decision, and a deliberate retry
 * re-runs the whole sequence with a fresh token.
 *
 * ============================================================================
 * WHY RECORDING THE SEND IS NO LONGER "BEST EFFORT"
 * ============================================================================
 * An earlier revision treated a failed recordSent as a plain success, on the reasoning
 * that the email had gone out and reporting a failure would invite a duplicate. The
 * first half of that is right and the second half is what this milestone fixes: telling
 * the operator "sent" when `sent_at` was never written means the invitation history they
 * are about to re-read will disagree with the message they were just shown, and a client
 * that treats the two as interchangeable can neither explain the gap nor avoid it.
 *
 * So the outcome is now distinct — DELIVERY_ACCEPTED_STATUS_UNCONFIRMED — and it is
 * deliberately NOT an error: the recipient's link works (see the code's own note in
 * ./staff-invitation-delivery-contract.ts), so the client must re-read the invitation
 * history rather than repeat the write.
 */

import type { StaffInvitationCode } from "./staff-invitation-delivery-contract.ts";

/** What the reservation step needs. Every value is already validated and canonical. */
export type StaffInviteReserveInput = {
  email: string;
  firstName: string;
  lastName: string;
  roleCode: string;
  shopIds: string[];
};

export type StaffInviteReserveResult =
  | {
      status: "ok";
      invitationId: string;
      normalizedEmail: string;
      /** True when an existing live PENDING invitation was reused. */
      isResend: boolean;
    }
  /**
   * A live PENDING invitation exists for this address whose role or shop set differs
   * from what was submitted. The database refuses to mutate either, so the operator must
   * revoke and re-issue. Distinct from `denied` because the remedy is specific and
   * actionable, and it discloses nothing the operator cannot already see in their own
   * invitation list.
   */
  | { status: "conflict" }
  /** Not authorized to invite staff for any Retailer. SQLSTATE 42501. */
  | { status: "denied" }
  /** The caller's Retailer is not ACTIVE. SQLSTATE 55000. */
  | { status: "retailer-inactive" }
  /** The database refused the values. One generic outcome. SQLSTATE 23514. */
  | { status: "invalid" }
  /** Transport, or an unexpected failure. */
  | { status: "unavailable" };

export type StaffInvitePrepareResult =
  | {
      status: "ok";
      /** Server-derived display values for the email. Never client input. */
      normalizedEmail: string;
      firstName: string;
      retailerName: string;
      roleCode: string;
    }
  | { status: "unavailable" };

export type StaffInviteEmailResult = { status: "sent" } | { status: "failed" };

/** Whether a bookkeeping write landed. Its failure changes the OUTCOME, not the truth. */
export type StaffInviteRecordResult = { status: "ok" } | { status: "failed" };

/** Everything the sequence needs from the outside world. */
export type StaffInviteFlowPorts = {
  reserve(input: StaffInviteReserveInput): Promise<StaffInviteReserveResult>;
  /** Must be cryptographically secure and must return a NEW token on every call. */
  generateToken(): { rawToken: string; tokenHash: string };
  prepare(input: {
    invitationId: string;
    tokenHash: string;
  }): Promise<StaffInvitePrepareResult>;
  sendEmail(input: {
    toEmail: string;
    firstName: string;
    retailerName: string;
    roleDisplayName: string;
    rawToken: string;
  }): Promise<StaffInviteEmailResult>;
  recordSent(input: {
    invitationId: string;
    tokenHash: string;
  }): Promise<StaffInviteRecordResult>;
  /**
   * Still best effort, and correctly so: nothing was delivered, `sent_at` is null and
   * the token is still current, so the invitation is retryable whether or not the
   * failure was written down. The outcome is DELIVERY_FAILED either way.
   */
  recordFailure(input: { invitationId: string; tokenHash: string }): Promise<void>;
  /** Presentation only — turns a role code into the label used in the subject/body. */
  roleDisplayName(roleCode: string): string;
};

/**
 * The closed set of outcomes, expressed directly in the wire contract's vocabulary so
 * there is no second mapping layer to drift. No id, email, token, hash, provider detail,
 * or backend text appears in any of them.
 */
export type StaffInviteFlowCode = Extract<
  StaffInvitationCode,
  | "SENT"
  | "RESENT"
  | "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED"
  | "DELIVERY_FAILED"
  | "ACCESS_DENIED"
  | "INVITATION_CONFLICT"
  | "RETAILER_INACTIVE"
  | "INVALID_REQUEST"
  | "INTERNAL_ERROR"
>;

/**
 * Runs the invite/resend sequence.
 *
 * The same function serves a fresh invitation and a resend: the ONLY difference is
 * whether the reservation reported `isResend`, which affects the reported code and
 * nothing else. A resend therefore takes exactly the same path — including step 2 —
 * which is what guarantees a rotated token rather than a re-sent stale link.
 */
export async function runStaffInviteFlow(
  input: StaffInviteReserveInput,
  ports: StaffInviteFlowPorts,
): Promise<StaffInviteFlowCode> {
  // 1. Reserve, under the caller's own token.
  const reserved = await ports.reserve(input);

  if (reserved.status === "conflict") return "INVITATION_CONFLICT";
  if (reserved.status === "denied") return "ACCESS_DENIED";
  if (reserved.status === "retailer-inactive") return "RETAILER_INACTIVE";
  if (reserved.status === "invalid") return "INVALID_REQUEST";
  if (reserved.status !== "ok") return "INTERNAL_ERROR";

  // 2. A fresh token for THIS attempt. Never reused, never conditional.
  const { rawToken, tokenHash } = ports.generateToken();

  // 3. Prepare (service-role): store the hash, rotate the token, read back the display
  //    fields. Any prior token for this invitation is now dead. The id is the one the
  //    reservation returned, and there is no other source for it.
  const prepared = await ports.prepare({
    invitationId: reserved.invitationId,
    tokenHash,
  });

  if (prepared.status !== "ok") {
    // Nothing was emailed, so there is no delivery outcome to record. The invitation
    // remains whatever prepare left it as, and a deliberate retry re-runs the whole
    // sequence with a new token.
    return "INTERNAL_ERROR";
  }

  // 4. Send. Every dynamic value comes from the database (prepare), not from the client.
  const email = await ports.sendEmail({
    toEmail: prepared.normalizedEmail,
    firstName: prepared.firstName,
    retailerName: prepared.retailerName,
    roleDisplayName: ports.roleDisplayName(prepared.roleCode),
    rawToken,
  });

  // 5. Record the outcome against the EXPECTED hash.
  if (email.status === "sent") {
    const recorded = await ports.recordSent({
      invitationId: reserved.invitationId,
      tokenHash,
    });

    // The message is in flight either way. What differs is whether the invitation's own
    // record agrees, and the client is told which — see this module's header.
    if (recorded.status !== "ok") return "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED";

    return reserved.isResend ? "RESENT" : "SENT";
  }

  await ports.recordFailure({ invitationId: reserved.invitationId, tokenHash });

  return "DELIVERY_FAILED";
}
