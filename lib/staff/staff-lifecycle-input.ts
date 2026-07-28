/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * Every decision the staff activation/deactivation control makes, separated from both the
 * Server Action and the Client Component so it can be exercised directly by
 * ./staff-lifecycle-input.test.ts. Neither of those can be unit-tested that way: the
 * action pulls in `next/headers`, and the component needs a DOM this repository has no
 * harness for. So the RULES live here and the two callers stay thin — the same split
 * ./staff-shop-assignment-input.ts and ./portal-access-decision.ts already use.
 *
 * WHAT THIS IS NOT. It is NOT the enforcement boundary. Every rule below is applied again,
 * independently, by public.set_retailer_staff_membership_status() under the caller's own
 * token: it derives the Retailer from auth.uid() through
 * resolve_retailer_member_organization('RETAILER_STAFF_MANAGE'), locks the target row,
 * reads the target's COMPLETE ACTIVE role set and requires it to be exactly
 * {RETAILER_MANAGER} or {SALES_STAFF}, refuses the caller's own membership by user id, and
 * refuses any current status that is not ACTIVE or DEACTIVATED. This module exists so an
 * operator sees a useful message before a round trip, and so a control that cannot succeed
 * is never rendered — not so the browser can be trusted.
 *
 * ============================================================================
 * THE SELF-TARGET RULE, AND HOW IT IS ACTUALLY ACHIEVED HERE
 * ============================================================================
 * public.list_retailer_staff_members() returns no `user_id` and no "this row is you" flag,
 * so the Web layer CANNOT identify the caller's own roster row directly — and nothing here
 * pretends otherwise.
 *
 * It does not need to. RETAILER_STAFF_MANAGE is mapped to RETAILER_OWNER alone, so every
 * caller who can reach this operation is an Owner, and `isEligibleLifecycleTarget` refuses
 * EVERY RETAILER_OWNER row — including, necessarily, the caller's own. The self case is
 * therefore covered transitively by the Owner exclusion, which is the strictly wider rule.
 *
 * The database does NOT rely on that coincidence: it compares the target's user id to
 * auth.uid() as a separate, explicit check, so the rule still holds on the day
 * RETAILER_STAFF_MANAGE is granted to RETAILER_MANAGER. On that day this module's Owner
 * exclusion would stop covering self, and the RPC would still refuse it — which is exactly
 * why the RPC, and not this file, is the authority.
 */

/* ---------------------------------------------------------------------------
 * The vocabulary
 * ------------------------------------------------------------------------- */

/**
 * The only two statuses public.set_retailer_staff_membership_status() accepts, and the
 * only two it permits as a CURRENT status.
 *
 * INVITED and SUSPENDED are members of the organization_members.status column's vocabulary
 * but deliberately NOT of this operation's, in either direction. A membership becomes
 * ACTIVE by the recipient ACCEPTING their invitation — the only place consent is recorded
 * and the only place shop rows are created — and SUSPENDED is reserved for a state this
 * milestone defines no owner for.
 */
export const STAFF_LIFECYCLE_STATUSES = ["ACTIVE", "DEACTIVATED"] as const;

export type StaffLifecycleStatus = (typeof STAFF_LIFECYCLE_STATUSES)[number];

export function isStaffLifecycleStatus(
  value: unknown,
): value is StaffLifecycleStatus {
  return (
    typeof value === "string" &&
    (STAFF_LIFECYCLE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The two role codes whose lifecycle this control manages.
 *
 * RETAILER_OWNER is deliberately absent. An Owner is the tenant's root of authority —
 * their membership is what resolve_retailer_owner_organization resolves — so deactivating
 * one can strand a Retailer with nobody able to reactivate anybody, including the person
 * just deactivated. Owner lifecycle belongs to the Vendor-side milestone, whose actor sits
 * OUTSIDE the tenant and therefore cannot lock the tenant out of itself.
 */
export const ELIGIBLE_LIFECYCLE_ROLES = [
  "RETAILER_MANAGER",
  "SALES_STAFF",
] as const;

export type EligibleLifecycleRole = (typeof ELIGIBLE_LIFECYCLE_ROLES)[number];

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------------------------------------------------------------------
 * Eligibility — which roster rows may be acted on at all
 * ------------------------------------------------------------------------- */

/**
 * The subset of a roster row this decision needs. Structural rather than importing
 * StaffMember, so a change to the roster's other fields cannot silently change this rule,
 * and so the test can construct a row without inventing timestamps.
 */
export type StaffLifecycleTarget = {
  roleCode: string;
  membershipStatus: string;
};

/**
 * Whether the activation/deactivation control is offered for a roster row.
 *
 * TWO CONDITIONS, both mirroring what the RPC independently enforces:
 *   * the row's role is exactly RETAILER_MANAGER or SALES_STAFF. The RPC compares the
 *     target's COMPLETE ACTIVE role set to a single-element array, which refuses an Owner,
 *     a multi-role member and a member with no role at all in one comparison. The roster
 *     exposes only ONE role_code per row, so a genuinely multi-role member cannot be
 *     distinguished here — the RPC refuses them and this module does not pretend to.
 *   * the membership is ACTIVE or DEACTIVATED. An INVITED membership has not been accepted
 *     and must not be promoted by this operation; a SUSPENDED one is not this milestone's
 *     to convert. Both are refused by the RPC with the same generic 42501.
 *
 * THIS IS PRESENTATION ONLY. Hiding the control removes the accident, not the capability:
 * the Server Action re-resolves access, re-reads the canonical roster and re-checks this
 * predicate, and the RPC re-derives every one of these facts from the database under the
 * caller's own token. Nothing downstream may treat a `true` here as permission to write.
 *
 * See the module header for why "this is not the caller's own row" is not tested here and
 * does not need to be.
 */
export function isEligibleLifecycleTarget(target: StaffLifecycleTarget): boolean {
  return (
    (ELIGIBLE_LIFECYCLE_ROLES as readonly string[]).includes(target.roleCode) &&
    (STAFF_LIFECYCLE_STATUSES as readonly string[]).includes(
      target.membershipStatus,
    )
  );
}

/* ---------------------------------------------------------------------------
 * Membership-level eligibility — the rule the UI and the action both apply
 * ------------------------------------------------------------------------- */

/**
 * The eligible MEMBERSHIP ids in a roster.
 *
 * ============================================================================
 * WHY A ROW PREDICATE IS NOT ENOUGH, AND MUST NOT BE USED ALONE
 * ============================================================================
 * public.list_retailer_staff_members() joins member_roles and roles WITHOUT a DISTINCT, so
 * a membership holding two ACTIVE roles is emitted as TWO ROWS sharing one membership_id —
 * each carrying a single role_code. Judging such a row on its own is therefore wrong in the
 * most dangerous direction: the SALES_STAFF row of a Manager+Sales member looks perfectly
 * eligible, and the control would be offered for a target
 * public.set_retailer_staff_membership_status refuses outright, because it compares the
 * COMPLETE ACTIVE role set to a single-element array.
 *
 * It is also wrong for a member holding RETAILER_OWNER alongside another role: the Owner
 * row is excluded by isEligibleLifecycleTarget, but the OTHER row would not be — so the
 * Owner exclusion, which is the headline rule of this feature, would be defeated by an
 * extra role assignment.
 *
 * So eligibility is decided PER MEMBERSHIP, over the whole roster, and a membership is
 * eligible only when:
 *
 *   1. it is represented by EXACTLY ONE row — any duplicate hides the control for every
 *      occurrence, whatever the other row says; and
 *   2. that row is itself an eligible target (role RETAILER_MANAGER or SALES_STAFF, status
 *      ACTIVE or DEACTIVATED).
 *
 * Rule 1 is deliberately blind to WHY a membership appears twice. A second role, a
 * historical duplicate, or malformed data all produce the same answer — hidden — because
 * the Web layer cannot tell them apart and the only safe reading of an ambiguous roster is
 * that the operation is not offered.
 *
 * THIS IS PRESENTATION AND PRE-FLIGHT VALIDATION, NOT ENFORCEMENT. The RPC re-reads the
 * target's complete ACTIVE role set from the database under a row lock and refuses anything
 * that is not exactly {RETAILER_MANAGER} or {SALES_STAFF}. This function exists so a control
 * that could only ever fail is never rendered, and so a tampered submission is refused
 * before a round trip.
 *
 * @returns The set of membership ids (lower-cased) for which the control may be offered.
 */
export function buildLifecycleEligibleMemberships(
  roster: readonly StaffLifecycleRosterEntry[],
): ReadonlySet<string> {
  const rowsById = new Map<string, StaffLifecycleRosterEntry[]>();

  for (const entry of roster) {
    const id = entry.membershipId.trim().toLowerCase();
    // A blank id cannot address anything and must never become a key that a later lookup
    // could match by accident.
    if (id.length === 0) continue;

    const existing = rowsById.get(id);
    if (existing === undefined) rowsById.set(id, [entry]);
    else existing.push(entry);
  }

  const eligible = new Set<string>();

  for (const [id, rows] of rowsById) {
    if (rows.length !== 1) continue;
    if (!isEligibleLifecycleTarget(rows[0])) continue;
    eligible.add(id);
  }

  return eligible;
}

/**
 * Whether the control may be offered for one roster ROW, given the projection above.
 *
 * A thin convenience so a page never has to remember to lower-case the id before asking.
 * Callers must pass a set produced by buildLifecycleEligibleMemberships over the SAME
 * roster they are rendering — a set built from a different read would answer a different
 * question.
 */
export function isLifecycleControlOffered(
  membershipId: string,
  eligibleMemberships: ReadonlySet<string>,
): boolean {
  return eligibleMemberships.has(membershipId.trim().toLowerCase());
}

/**
 * The status the control would move an eligible row TO.
 *
 * ACTIVE -> DEACTIVATED (the Deactivate action) and DEACTIVATED -> ACTIVE (Reactivate).
 * Returns null for any other current status, so a caller cannot derive a target status for
 * a row this operation does not own.
 */
export function nextLifecycleStatus(
  membershipStatus: string,
): StaffLifecycleStatus | null {
  if (membershipStatus === "ACTIVE") return "DEACTIVATED";
  if (membershipStatus === "DEACTIVATED") return "ACTIVE";
  return null;
}

/* ---------------------------------------------------------------------------
 * Canonicalization
 * ------------------------------------------------------------------------- */

/** Reads one FormData-like entry as a string, treating a File as absent. */
function readString(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

/**
 * Canonicalizes a submitted requested status: trimmed, and NOTHING ELSE.
 *
 * DELIBERATELY NOT UPPER-CASED. public.set_retailer_staff_membership_status compares
 * p_status exactly and case-sensitively, and raises 23514 for 'active'. Silently
 * upper-casing here would make this layer accept a request the database would refuse — and
 * worse, would let a tampered submission decide the case of a value written verbatim into
 * an audit row a human reads later. A malformed value survives this call so
 * validateStaffLifecycleInput can refuse it explicitly.
 */
export function normalizeRequestedStatus(raw: unknown): string {
  return readString(raw).trim();
}

/**
 * Canonicalizes a submitted membership id: trimmed and lower-cased.
 *
 * Not validated here — validation reports, canonicalization only shapes.
 */
export function normalizeLifecycleMembershipId(raw: unknown): string {
  return readString(raw).trim().toLowerCase();
}

/* ---------------------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------------------- */

/**
 * Why a submission was refused before the RPC was reached.
 *
 * Kept as discriminants rather than messages so this module stays free of copy, and so the
 * test asserts the DECISION rather than the wording.
 *
 *   invalid-target      the membership id is missing or not a UUID. Reachable only from a
 *                       tampered submission — the control carries a value the page read
 *                       from the roster.
 *   invalid-status      the requested status is not exactly ACTIVE or DEACTIVATED.
 *   unknown-target      the membership id is not in the roster the server just read for
 *                       THIS caller. Covers a cross-tenant id, a deleted row, and a
 *                       fabricated one — reported identically, because distinguishing them
 *                       would confirm whether some other membership exists.
 *   ineligible-target   the row IS in the caller's roster but may not be acted on: a
 *                       RETAILER_OWNER (including the caller themselves), an INVITED or
 *                       SUSPENDED membership, or an unsupported role.
 */
export type StaffLifecycleRejection =
  | "invalid-target"
  | "invalid-status"
  | "unknown-target"
  | "ineligible-target";

/** One roster row, reduced to what validation needs. */
export type StaffLifecycleRosterEntry = {
  membershipId: string;
  roleCode: string;
  membershipStatus: string;
};

export type StaffLifecycleValidation =
  | {
      ok: true;
      membershipId: string;
      requestedStatus: StaffLifecycleStatus;
      /** The row as the canonical roster reports it. Never taken from the browser. */
      target: StaffLifecycleRosterEntry;
    }
  | { ok: false; reason: StaffLifecycleRejection };

/**
 * Validates a canonicalized submission against the roster the server just read.
 *
 * THE ROSTER SUBSET CHECK IS THE ONE RULE THAT IS A SECURITY PROPERTY — the same shape as
 * `allowedShopIds` in ./staff-shop-assignment-input.ts. A submitted membership id is
 * accepted only if it appears in the list public.list_retailer_staff_members() just
 * returned for THIS caller. That RPC derives the Retailer from auth.uid(), so a
 * hand-crafted POST naming another Retailer's membership is rejected here as well as by
 * the write RPC.
 *
 * Order of checks is deliberate: FORMAT first, so a tampered id or status is refused
 * without the roster being consulted at all; then existence; then eligibility. Note that
 * "already in the requested status" is NOT rejected — that is the RPC's idempotent no-op,
 * which returns status_changed = false and writes nothing, and the operator is told the
 * status was already current rather than shown an error.
 */
export function validateStaffLifecycleInput(
  membershipId: string,
  requestedStatus: string,
  roster: readonly StaffLifecycleRosterEntry[],
): StaffLifecycleValidation {
  if (!UUID_PATTERN.test(membershipId)) {
    return { ok: false, reason: "invalid-target" };
  }

  if (!isStaffLifecycleStatus(requestedStatus)) {
    return { ok: false, reason: "invalid-status" };
  }

  // EVERY row for this membership, not the first one. `find` would silently pick one half
  // of a multi-role member and judge it in isolation — the exact mistake
  // buildLifecycleEligibleMemberships exists to prevent, and the one that would let the
  // SALES_STAFF row of a Manager+Sales member through a check the RPC then refuses.
  const matches = roster.filter(
    (entry) => entry.membershipId.trim().toLowerCase() === membershipId,
  );

  if (matches.length === 0) {
    return { ok: false, reason: "unknown-target" };
  }

  // More than one row for one membership id: the member holds more than one ACTIVE role,
  // or the roster carries a duplicate. Either way this operation is undefined for them —
  // the RPC requires the complete ACTIVE role set to be exactly one element — and the Web
  // layer cannot tell the two causes apart, so it refuses both.
  //
  // Reported as `ineligible-target`, which the Server Action maps to the same generic
  // message as every other target refusal, so a caller cannot use the response to learn
  // how many roles somebody holds.
  if (matches.length > 1) {
    return { ok: false, reason: "ineligible-target" };
  }

  const target = matches[0];

  if (!isEligibleLifecycleTarget(target)) {
    return { ok: false, reason: "ineligible-target" };
  }

  return { ok: true, membershipId, requestedStatus, target };
}

/* ---------------------------------------------------------------------------
 * Copy
 * ------------------------------------------------------------------------- */

/**
 * The success sentence for a committed CHANGE.
 *
 * Takes the person's display NAME — already on screen — and the status the operation moved
 * them to. Emits no membership id, no role code, no raw status value and no organization
 * name. `DEACTIVATED` becomes "no longer has access", not the enum.
 */
export function describeLifecycleOutcome(
  memberName: string,
  requestedStatus: StaffLifecycleStatus,
): string {
  return requestedStatus === "DEACTIVATED"
    ? `${memberName} is now inactive and no longer has access. Their roles, shops and history are unchanged.`
    : `${memberName} is now active again. Their previous roles and shop assignments are available.`;
}

/**
 * The sentence for a committed NO-OP — the RPC reported status_changed = false because the
 * membership was already in the requested state.
 *
 * Presented as an outcome rather than an error: nothing went wrong, and nothing was
 * written. Most often it means a second operator already made the change.
 */
export function describeLifecycleNoChange(
  memberName: string,
  requestedStatus: StaffLifecycleStatus,
): string {
  return requestedStatus === "DEACTIVATED"
    ? `No change was needed — ${memberName} was already inactive.`
    : `No change was needed — ${memberName} was already active.`;
}

/**
 * Whether the confirm button may be enabled.
 *
 * Every condition in one place, so the button and the tests cannot drift apart.
 * `alreadyCommitted` is what stops an ordinary second click resubmitting a change that has
 * already happened — the RPC is idempotent, so a repeat would be a harmless no-op, but it
 * would also produce a confusing "no change was needed" for an operator who just succeeded.
 */
export function canSubmitLifecycleChange(input: {
  submitting: boolean;
  alreadyCommitted: boolean;
  targetStatus: StaffLifecycleStatus | null;
}): boolean {
  return (
    !input.submitting && !input.alreadyCommitted && input.targetStatus !== null
  );
}
