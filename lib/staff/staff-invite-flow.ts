/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client, no crypto.
 *
 * The ORDER of the staff-invitation delivery sequence, expressed once, with every
 * effect injected. The server module that supplies the real ports
 * (lib/staff/retailer-staff-invitations.ts) cannot be unit-tested — importing it pulls
 * in `next/headers` and the service-role client — so the sequence itself lives here
 * and is exercised directly by ./staff-invite-flow.test.ts against fake ports that
 * record what was called, in what order, with what arguments.
 *
 * THE SEQUENCE, and why each step is where it is:
 *
 *   1. reserve      — under the CALLER'S OWN token. Obtains (or reuses) the invitation
 *                     id and the canonical email. This is the authorization step: the
 *                     RPC derives the Retailer from auth.uid(), requires
 *                     RETAILER_STAFF_MANAGE, and refuses a recipient who already holds
 *                     any membership there. Nothing has been sent yet, so a refusal
 *                     costs nothing.
 *   2. generateToken— a fresh cryptographically random raw token and its SHA-256 hash.
 *                     EVERY send, including a resend and a retry after a delivery
 *                     failure, mints a NEW token here. There is no branch that reuses
 *                     one: the previous token is invalidated by step 3.
 *   3. prepare      — under the SERVICE-ROLE client. Stores ONLY the hash, rotates the
 *                     token, refreshes the 24-hour window, and clears prior delivery
 *                     state. It returns the display fields for the email, so the
 *                     message is built from DATABASE values rather than from anything
 *                     the browser submitted.
 *   4. sendEmail    — Resend delivers the app-owned link containing the RAW token.
 *   5. record       — recordSent on success, recordFailure otherwise. Both are keyed by
 *                     the EXPECTED hash, so a callback for a superseded token is
 *                     refused by the database rather than overwriting newer state.
 *
 * THE RAW TOKEN. It is produced in step 2, used in step 4, and never leaves this
 * sequence: it is not returned to the caller, not placed in the result, not passed to
 * record*, and not logged. Only the HASH travels to the database, and the hash is
 * likewise absent from every result variant below — nothing here can reach a browser.
 *
 * RECORDING IS BEST-EFFORT AND NEVER CHANGES THE USER-FACING OUTCOME. If the email was
 * accepted by the provider, the operator is told it sent, even if the bookkeeping call
 * failed; the invitation is still live and still resendable. Reporting a send as a
 * failure because a follow-up write did not land would invite a duplicate email.
 */

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
   * from what was submitted. The database refuses to mutate either, so the operator
   * must revoke and re-issue. Distinct from `rejected` because the remedy is specific
   * and actionable, and it discloses nothing they cannot already see in their own
   * invitation list.
   */
  | { status: "conflict" }
  /** The database refused for any other reason. One generic outcome. */
  | { status: "rejected" }
  /** Transport or an unexpected failure. */
  | { status: "unavailable" };

export type StaffInvitePrepareResult =
  | {
      status: "ok";
      /** Server-derived display values for the email. Never browser input. */
      normalizedEmail: string;
      firstName: string;
      retailerName: string;
      roleCode: string;
    }
  | { status: "unavailable" };

export type StaffInviteEmailResult =
  | { status: "sent" }
  | { status: "misconfigured" }
  | { status: "failed" };

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
  recordSent(input: { invitationId: string; tokenHash: string }): Promise<void>;
  recordFailure(input: { invitationId: string; tokenHash: string }): Promise<void>;
  /** Presentation only — turns a role code into the label used in the subject/body. */
  roleDisplayName(roleCode: string): string;
};

/** The closed set of outcomes. No id, email, token, hash, or provider detail. */
export type StaffInviteFlowResult =
  /** Reserved, prepared, and accepted by the provider — a first send. */
  | { status: "sent" }
  /** The same, for an invitation that already existed. */
  | { status: "resent" }
  /** Prepared, but the provider did not accept it. The invitation stays live. */
  | { status: "delivery-failed" }
  /** Resend/Auth/origin configuration is absent or invalid. */
  | { status: "misconfigured" }
  /** A live invitation exists with a different role or shop set. */
  | { status: "conflict" }
  /** The database refused the reservation. Generic. */
  | { status: "rejected" }
  /** A transport or database failure at any step before the send. */
  | { status: "unavailable" };

/**
 * Runs the invite/resend sequence.
 *
 * The same function serves a fresh invitation and a resend: the ONLY difference is
 * whether the reservation reported `isResend`, which affects the reported status and
 * nothing else. A resend therefore takes exactly the same path — including step 2 —
 * which is what guarantees a rotated token rather than a re-sent stale link.
 */
export async function runStaffInviteFlow(
  input: StaffInviteReserveInput,
  ports: StaffInviteFlowPorts,
): Promise<StaffInviteFlowResult> {
  // 1. Reserve, under the caller's own token.
  const reserved = await ports.reserve(input);

  if (reserved.status === "conflict") return { status: "conflict" };
  if (reserved.status === "rejected") return { status: "rejected" };
  if (reserved.status !== "ok") return { status: "unavailable" };

  // 2. A fresh token for THIS attempt. Never reused, never conditional.
  const { rawToken, tokenHash } = ports.generateToken();

  // 3. Prepare (service-role): store the hash, rotate the token, read back the
  //    display fields. Any prior token for this invitation is now dead.
  const prepared = await ports.prepare({
    invitationId: reserved.invitationId,
    tokenHash,
  });

  if (prepared.status !== "ok") {
    // Nothing was emailed, so there is no delivery outcome to record. The invitation
    // remains whatever prepare left it as, and a retry re-runs the whole sequence with
    // a new token.
    return { status: "unavailable" };
  }

  // 4. Send. Every dynamic value comes from the database (prepare), not the form.
  const email = await ports.sendEmail({
    toEmail: prepared.normalizedEmail,
    firstName: prepared.firstName,
    retailerName: prepared.retailerName,
    roleDisplayName: ports.roleDisplayName(prepared.roleCode),
    rawToken,
  });

  // 5. Record the outcome against the EXPECTED hash.
  if (email.status === "sent") {
    await ports.recordSent({ invitationId: reserved.invitationId, tokenHash });
    return reserved.isResend ? { status: "resent" } : { status: "sent" };
  }

  await ports.recordFailure({ invitationId: reserved.invitationId, tokenHash });

  // A configuration gap and a provider refusal are both recorded as a delivery
  // failure — the invitation is live and retryable either way — but they are reported
  // differently, because only one of them is something the operator can retry out of.
  return email.status === "misconfigured"
    ? { status: "misconfigured" }
    : { status: "delivery-failed" };
}
