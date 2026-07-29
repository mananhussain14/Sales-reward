/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * Every decision the Vendor's Retailer deactivate/reactivate control makes, separated from
 * both the Server Action and the Client Component so it can be exercised directly by
 * ./vendor-retailer-lifecycle-input.test.ts. Neither of those can be unit-tested that way:
 * the action pulls in `next/headers`, and the component needs a DOM this repository has no
 * harness for. So the RULES live here and the two callers stay thin — the same split
 * @/lib/staff/staff-lifecycle-input.ts already uses for the Retailer-side staff control.
 *
 * WHAT THIS IS NOT. It is NOT the enforcement boundary. Every rule below is applied again,
 * independently, by public.set_vendor_retailer_status() under the caller's own token: it
 * derives the acting Vendor from auth.uid() through get_vendor_super_admin_context(),
 * requires RETAILERS_MANAGE through has_organization_permission(), matches the relationship
 * on `id AND vendor_organization_id`, locks both rows in a fixed order, requires the
 * organization to be a RETAILER, refuses a Retailer any other Vendor still has a live
 * relationship with, and refuses any current pair that is not exactly ACTIVE/ACTIVE or
 * SUSPENDED/SUSPENDED. This module exists so an operator sees a useful message before a
 * round trip, and so a control that could only ever fail is never rendered — not so the
 * browser can be trusted.
 *
 * ============================================================================
 * TWO VOCABULARIES, AND THEY ARE DELIBERATELY DIFFERENT
 * ============================================================================
 * The database stores ACTIVE and SUSPENDED. The product says Active and Inactive.
 *
 *   stored ACTIVE     -> shown "Active"     (verb: "Reactivate Retailer")
 *   stored SUSPENDED  -> shown "Inactive"   (verb: "Deactivate Retailer")
 *
 * "Suspend" reads as an accusation to a Retailer who is simply paused between contracts,
 * so it is not the word the product uses. The STORED word stays SUSPENDED because that is
 * what both CHECK constraints, every status filter and every audit row already hold, and
 * because DEACTIVATED already means something else and stronger in this schema — a
 * relationship that has ENDED, which this operation neither sets nor clears.
 *
 * THE TRANSLATION IS ONE-WAY. `INACTIVE` is a display word and is NEVER sent to the RPC:
 * public.set_vendor_retailer_status compares p_status exactly and case-sensitively and
 * raises 23514 for anything that is not ACTIVE or SUSPENDED. Nothing in this module can
 * produce a requested status outside that pair — see LIFECYCLE_TRANSITIONS below, which is
 * the single place a requested value is derived.
 */

/* ---------------------------------------------------------------------------
 * The stored vocabulary
 * ------------------------------------------------------------------------- */

/**
 * The only two statuses public.set_vendor_retailer_status() accepts, and the only two it
 * permits as a CURRENT status on either row.
 *
 * DEACTIVATED is a member of BOTH columns' CHECK constraints and deliberately NOT of this
 * operation's vocabulary, in either direction. It is terminal: a relationship that has been
 * wound up is retained for history, and an operation that could set it would be inventing an
 * offboarding decision nobody made, while one that could clear it would silently resurrect a
 * relationship somebody ended on purpose. Both are refused by the RPC — a REQUEST for it with
 * 23514, a current row holding it with 55000.
 */
export const VENDOR_RETAILER_LIFECYCLE_STATUSES = ["ACTIVE", "SUSPENDED"] as const;

export type VendorRetailerLifecycleStatus =
  (typeof VENDOR_RETAILER_LIFECYCLE_STATUSES)[number];

export function isVendorRetailerLifecycleStatus(
  value: unknown,
): value is VendorRetailerLifecycleStatus {
  return (
    typeof value === "string" &&
    (VENDOR_RETAILER_LIFECYCLE_STATUSES as readonly string[]).includes(value)
  );
}

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------------------------------------------------------------------
 * Capability
 * ------------------------------------------------------------------------- */

/**
 * Whether this caller holds RETAILERS_MANAGE, as the database answered.
 *
 * THREE STATES, and the distinction between the last two is load-bearing. `denied` is a
 * definite "no" from the database; `unavailable` is "we could not ask". They must never be
 * collapsed, because only one of them is a fact about the caller — but they DO produce the
 * same UI, because the only safe response to not knowing is to offer nothing.
 */
export type VendorRetailerManageCapability =
  | "confirmed"
  | "denied"
  | "unavailable";

/**
 * Whether the capability has been positively CONFIRMED.
 *
 * ============================================================================
 * WRITTEN AS POSITIVE EQUALITY, AND THAT IS THE WHOLE POINT
 * ============================================================================
 * This is `=== "confirmed"`, not `!== "denied"`. An exclusion list fails OPEN the moment a
 * new state is added to the union or a malformed value arrives from somewhere unexpected: a
 * future `"pending"`, a stray `undefined`, a typo'd `"confirmd"` would all satisfy
 * "not denied" and the control would render for a caller who may not use it.
 *
 * Positive equality fails CLOSED for every one of those without being edited. The parameter
 * is typed `unknown` rather than the union deliberately, so this stays true even for a
 * caller that has lost its types at a serialization boundary.
 */
export function isConfirmedManageCapability(value: unknown): boolean {
  return value === "confirmed";
}

/* ---------------------------------------------------------------------------
 * The lifecycle pair
 * ------------------------------------------------------------------------- */

/**
 * The two status columns this operation moves together, exactly as the canonical detail
 * read reports them.
 *
 * Structural rather than importing VendorRetailerDetail, so a change to that view's other
 * fields cannot silently change this rule, and so a test can construct a pair without
 * inventing a shop list.
 */
export type VendorRetailerLifecyclePair = {
  /** public.organizations.status for the Retailer organization. */
  retailerStatus: string;
  /** public.vendor_retailers.status for this Vendor's relationship. */
  relationshipStatus: string;
};

/**
 * What the control offers for one supported pair.
 *
 * `displayLabel` is the pill wording, `actionLabel` is the button, and `requestedStatus` is
 * the ONLY place a value destined for the RPC is produced. Keeping all three in one table
 * means the badge, the button and the request cannot drift apart.
 */
export type VendorRetailerLifecycleAction = {
  /** The user-facing label for the CURRENT state. */
  displayLabel: "Active" | "Inactive";
  /** The verb offered. */
  actionLabel: "Deactivate Retailer" | "Reactivate Retailer";
  /** The stored value that will be sent to the RPC. Never a display word. */
  requestedStatus: VendorRetailerLifecycleStatus;
};

/**
 * The complete transition table: the two synchronized pairs this operation owns, and what
 * each offers.
 *
 * Keyed by the SHARED status, because a supported pair is by definition one where both rows
 * hold the same value — that is what resolveVendorRetailerLifecycle proves before it reaches
 * this table.
 */
const LIFECYCLE_TRANSITIONS: Record<
  VendorRetailerLifecycleStatus,
  VendorRetailerLifecycleAction
> = {
  ACTIVE: {
    displayLabel: "Active",
    actionLabel: "Deactivate Retailer",
    requestedStatus: "SUSPENDED",
  },
  SUSPENDED: {
    displayLabel: "Inactive",
    actionLabel: "Reactivate Retailer",
    requestedStatus: "ACTIVE",
  },
};

/**
 * Resolves a current lifecycle pair to the action the control may offer, or null.
 *
 * VALID PAIRS ARE ONLY ACTIVE/ACTIVE AND SUSPENDED/SUSPENDED — the two this operation can
 * itself produce, and the two public.set_vendor_retailer_status accepts as a starting state.
 *
 * EVERYTHING ELSE RETURNS NULL, including — especially — a MISMATCH. An ACTIVE relationship
 * against a SUSPENDED organization (or the reverse) is a state this operation cannot have
 * created; it means something wrote one of those rows outside this path. The RPC refuses it
 * with 55000 and deliberately does NOT reconcile it, because quietly "repairing" it would
 * overwrite whatever the other writer intended and erase the only evidence that a second
 * writer exists. Offering a control that the database will refuse would be worse than
 * offering nothing, so nothing is offered.
 *
 * A DEACTIVATED value on either row also returns null: terminal, and not this operation's to
 * clear. So does any unrecognized or missing status — a value this module does not know is a
 * value it must not act on.
 */
export function resolveVendorRetailerLifecycle(
  pair: VendorRetailerLifecyclePair,
): VendorRetailerLifecycleAction | null {
  const { retailerStatus, relationshipStatus } = pair;

  // Both must be in the closed vocabulary. Checked before the equality test so an
  // unrecognized value that happens to appear on BOTH rows (a hypothetical future state
  // written by something else, matched on both sides) is still refused rather than treated
  // as a synchronized pair.
  if (!isVendorRetailerLifecycleStatus(retailerStatus)) return null;
  if (!isVendorRetailerLifecycleStatus(relationshipStatus)) return null;

  // Synchronized, or nothing.
  if (retailerStatus !== relationshipStatus) return null;

  return LIFECYCLE_TRANSITIONS[retailerStatus];
}

/**
 * Whether the lifecycle control may be rendered at all.
 *
 * BOTH conditions, positively: the capability is CONFIRMED, and the current pair is one this
 * operation owns. Either alone is insufficient, and neither is expressed as an exclusion.
 *
 * THIS IS PRESENTATION ONLY. Hiding the control removes the accident, not the capability:
 * the Server Action re-resolves Vendor access, re-proves RETAILERS_MANAGE against the
 * database, re-reads the canonical detail and re-checks this predicate before accepting a
 * single id, and the RPC re-derives every one of these facts from auth.uid() under its own
 * row locks. Nothing downstream may treat a `true` here as permission to write.
 */
export function isVendorRetailerLifecycleControlOffered(input: {
  capability: unknown;
  pair: VendorRetailerLifecyclePair;
}): boolean {
  if (!isConfirmedManageCapability(input.capability)) return false;
  return resolveVendorRetailerLifecycle(input.pair) !== null;
}

/* ---------------------------------------------------------------------------
 * Display
 * ------------------------------------------------------------------------- */

/**
 * The user-facing label for one stored Retailer lifecycle status.
 *
 * Returns null for a value outside this operation's vocabulary — including DEACTIVATED,
 * whose presentation belongs to the shared status pill rather than to this control. A caller
 * that receives null must render the shared badge, never the raw enum.
 */
export function formatRetailerLifecycleLabel(
  status: string,
): "Active" | "Inactive" | null {
  if (!isVendorRetailerLifecycleStatus(status)) return null;
  return LIFECYCLE_TRANSITIONS[status].displayLabel;
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
 * DELIBERATELY NOT UPPER-CASED. public.set_vendor_retailer_status compares p_status exactly
 * and case-sensitively and raises 23514 for 'active'. Silently upper-casing here would make
 * this layer accept a request the database would refuse — and worse, would let a tampered
 * submission decide the case of a value written verbatim into an audit row a human reads
 * later. A malformed value survives this call so validation can refuse it explicitly.
 */
export function normalizeVendorRetailerRequestedStatus(raw: unknown): string {
  return readString(raw).trim();
}

/**
 * Canonicalizes a submitted relationship id: trimmed and lower-cased.
 *
 * Not validated here — validation reports, canonicalization only shapes.
 */
export function normalizeVendorRetailerRelationshipId(raw: unknown): string {
  return readString(raw).trim().toLowerCase();
}

/* ---------------------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------------------- */

/**
 * Why a submission was refused before the RPC was reached.
 *
 * Kept as discriminants rather than messages so this module stays free of copy, and so the
 * tests assert the DECISION rather than the wording.
 *
 *   invalid-target      the relationship id is missing or not a UUID. Reachable only from a
 *                       tampered submission — the control carries a value the page read from
 *                       its own route params.
 *   invalid-status      the requested status is not exactly ACTIVE or SUSPENDED.
 *   unsupported-pair    the canonical current pair is not ACTIVE/ACTIVE or
 *                       SUSPENDED/SUSPENDED: a mismatch, a DEACTIVATED row, or an
 *                       unrecognized value.
 *   wrong-direction     the submitted status is not the valid opposite of the current pair.
 *                       A tampered submission asking to "deactivate" an already-inactive
 *                       Retailer lands here rather than being forwarded as a no-op.
 */
export type VendorRetailerLifecycleRejection =
  | "invalid-target"
  | "invalid-status"
  | "unsupported-pair"
  | "wrong-direction";

export type VendorRetailerLifecycleSubmission =
  | {
      ok: true;
      relationshipId: string;
      requestedStatus: VendorRetailerLifecycleStatus;
    }
  | { ok: false; reason: VendorRetailerLifecycleRejection };

/**
 * FORMAT validation only — no canonical data consulted.
 *
 * Deliberately separate from the transition check below, and deliberately FIRST, so a
 * tampered id or status is refused without a database read happening at all. An unauthorized
 * or malformed caller therefore learns nothing about whether the Retailer exists.
 */
export function validateVendorRetailerLifecycleSubmission(
  relationshipId: string,
  requestedStatus: string,
): VendorRetailerLifecycleSubmission {
  if (!UUID_PATTERN.test(relationshipId)) {
    return { ok: false, reason: "invalid-target" };
  }

  if (!isVendorRetailerLifecycleStatus(requestedStatus)) {
    return { ok: false, reason: "invalid-status" };
  }

  return { ok: true, relationshipId, requestedStatus };
}

export type VendorRetailerLifecycleTransition =
  | { ok: true; requestedStatus: VendorRetailerLifecycleStatus }
  | { ok: false; reason: VendorRetailerLifecycleRejection };

/**
 * Validates the requested transition against the CANONICAL current pair.
 *
 * THE PAIR MUST COME FROM A FRESH SERVER READ, never from the browser. The control posts no
 * status of its own beyond the direction it is asking for, and this function is what makes
 * that direction meaningful: it recomputes the only valid next status from what the database
 * says right now, and requires the submission to match it exactly.
 *
 * A submission asking for the status the Retailer ALREADY holds is refused here as
 * `wrong-direction` rather than forwarded. The RPC would treat it as an idempotent no-op and
 * report status_changed = false, which is correct behaviour for a genuine race — but a
 * submission that disagrees with a read taken microseconds earlier is a tampered request, not
 * a race, and there is nothing to gain by sending it.
 */
export function validateVendorRetailerLifecycleTransition(
  pair: VendorRetailerLifecyclePair,
  requestedStatus: string,
): VendorRetailerLifecycleTransition {
  const action = resolveVendorRetailerLifecycle(pair);

  if (action === null) {
    return { ok: false, reason: "unsupported-pair" };
  }

  if (requestedStatus !== action.requestedStatus) {
    return { ok: false, reason: "wrong-direction" };
  }

  return { ok: true, requestedStatus: action.requestedStatus };
}

/* ---------------------------------------------------------------------------
 * Response parsing
 * ------------------------------------------------------------------------- */

/**
 * The four columns public.set_vendor_retailer_status returns, reduced to what this
 * application uses.
 *
 * `relationship_id` is VALIDATED but not carried out of the parser — see
 * readVendorRetailerLifecycleRow. Validation and exposure are separate concerns: the id has
 * to be checked to know the response describes the row that was addressed, and once that is
 * established the page already has the id from its own route params, so passing it further
 * would move an identifier for no reason.
 */
export type VendorRetailerLifecycleRow = {
  retailerStatus: VendorRetailerLifecycleStatus;
  relationshipStatus: VendorRetailerLifecycleStatus;
  changed: boolean;
};

/**
 * Parses a SUCCESSFUL RPC response into a described outcome, or null.
 *
 * ============================================================================
 * NULL MEANS "COMMITTED, BUT UNDESCRIBABLE" — NEVER "NOTHING HAPPENED"
 * ============================================================================
 * This function is only ever reached when PostgREST reported NO error, which means the
 * transaction COMMITTED. So every rejection below describes a response this process cannot
 * trust — not a write that failed. The caller maps null to `saved-unconfirmed`, which is a
 * SUCCESS with a caveat: the operator is told to refresh, never invited to try again, and
 * nothing is retried automatically. Reporting any of these as `unchanged` would claim
 * nothing happened when the database may have just deactivated an entire Retailer.
 *
 * ============================================================================
 * ALL FOUR COLUMNS ARE CHECKED, INCLUDING THE IDENTIFIER
 * ============================================================================
 * `supabase.rpc()` is untyped in this project (there are no generated database types), so the
 * result is `any`. A type assertion would be a claim about the SQL rather than a check of it,
 * and TypeScript erases it at runtime. Every one of these is a real runtime check:
 *
 *   1. EXACTLY ONE ROW. PostgREST returns a `returns table (...)` function as an array. The
 *      function is structurally guaranteed to emit one row, so zero rows and two rows are
 *      both drift. Zero rows previously read as `undefined` and would have been rejected by
 *      the field checks anyway; two rows would have had the second SILENTLY DISCARDED, which
 *      is the more dangerous of the two and is now refused explicitly.
 *   2. relationship_id IS PRESENT AND IS A STRING.
 *   3. relationship_id IS A WELL-FORMED UUID.
 *   4. relationship_id IS THE ROW THAT WAS ADDRESSED. This is the check that makes the other
 *      three worth doing: a response describing a DIFFERENT relationship must never be
 *      rendered as the outcome of this request. It would attribute another Retailer's
 *      lifecycle change to the one on screen — the worst possible failure of this control,
 *      and one no status check could catch.
 *   5/6. BOTH STATUSES ARE IN THE CLOSED VOCABULARY, not merely strings. The RPC can only
 *      return ACTIVE or SUSPENDED, so anything else is drift, and accepting it would let an
 *      unexpected value reach the copy layer, which maps exactly two.
 *   7. THE TWO STATUSES AGREE. This operation moves both rows in one transaction, so a
 *      mismatched pair coming back contradicts the function's own guarantee.
 *   8. status_changed IS A BOOLEAN, not merely truthy — the difference between "you did that"
 *      and "somebody already had" is decided by this flag.
 *
 * Nothing is silently ignored, coerced or defaulted: every failed check returns null.
 *
 * @param data The raw `result.data` from a successful RPC call.
 * @param expectedRelationshipId The canonical target that was SUBMITTED. Compared
 *   case-insensitively, because a UUID's canonical form differs only in case and an
 *   upper-cased echo of the same id addresses the same row — this is a check that the right
 *   ROW came back, not a string-formatting check.
 */
export function readVendorRetailerLifecycleRow(
  data: unknown,
  expectedRelationshipId: string,
): VendorRetailerLifecycleRow | null {
  // 1. Exactly one row.
  let row: unknown;

  if (Array.isArray(data)) {
    if (data.length !== 1) return null;
    row = data[0];
  } else {
    row = data;
  }

  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;

  const record = row as Record<string, unknown>;

  // 2 + 3. The identifier is present, a string, and well-formed.
  const returnedId = record.relationship_id;

  if (typeof returnedId !== "string") return null;
  if (!UUID_PATTERN.test(returnedId)) return null;

  // 4. And it is the row that was addressed. The expected id is canonicalized here as well,
  //    so a caller that passed an upper-cased id is compared on equal terms rather than
  //    having its own input rejected.
  if (returnedId.toLowerCase() !== expectedRelationshipId.trim().toLowerCase()) {
    return null;
  }

  // 5 + 6. Both statuses are in the closed vocabulary.
  if (!isVendorRetailerLifecycleStatus(record.retailer_status)) return null;
  if (!isVendorRetailerLifecycleStatus(record.relationship_status)) return null;

  // 7. And they agree — the two rows move together or not at all.
  if (record.retailer_status !== record.relationship_status) return null;

  // 8. The change flag is a genuine boolean.
  if (typeof record.status_changed !== "boolean") return null;

  // The validated identifier is deliberately NOT returned. It has done its job.
  return {
    retailerStatus: record.retailer_status,
    relationshipStatus: record.relationship_status,
    changed: record.status_changed,
  };
}

/* ---------------------------------------------------------------------------
 * Copy
 * ------------------------------------------------------------------------- */

/**
 * The success sentence for a committed CHANGE.
 *
 * Takes the Retailer's display NAME — already on screen, and read by the server from the
 * canonical detail rather than from the browser — and the status the database confirmed.
 * Emits no relationship id, no organization id, no raw status value and no Vendor name, and
 * never the stored word SUSPENDED.
 */
export function describeVendorRetailerLifecycleOutcome(
  retailerName: string,
  confirmedStatus: VendorRetailerLifecycleStatus,
): string {
  return confirmedStatus === "SUSPENDED"
    ? `${retailerName} is now inactive. Everyone at this Retailer is blocked from the next request onward, and their accounts, Shops, assignments, receipts and invitations are unchanged.`
    : `${retailerName} is now active again. Preserved users, roles, Shops and assignments are available, and valid invitations can be used again.`;
}

/**
 * The sentence for a committed NO-OP — the RPC reported status_changed = false because both
 * rows were already in the requested state.
 *
 * Presented as an outcome rather than an error: nothing went wrong, and nothing was written.
 * Most often it means a second administrator got there first.
 */
export function describeVendorRetailerLifecycleNoChange(
  retailerName: string,
  confirmedStatus: VendorRetailerLifecycleStatus,
): string {
  return confirmedStatus === "SUSPENDED"
    ? `No change was needed — ${retailerName} was already inactive.`
    : `No change was needed — ${retailerName} was already active.`;
}

/**
 * Whether the confirm button may be enabled.
 *
 * Every condition in one place, so the button and the tests cannot drift apart.
 * `alreadyCommitted` is what stops an ordinary second click resubmitting a change that has
 * already happened — the RPC is idempotent, so a repeat would be a harmless no-op, but it
 * would also produce a confusing "no change was needed" for an administrator who just
 * succeeded.
 */
export function canSubmitVendorRetailerLifecycleChange(input: {
  submitting: boolean;
  alreadyCommitted: boolean;
  requestedStatus: VendorRetailerLifecycleStatus | null;
}): boolean {
  return (
    !input.submitting &&
    !input.alreadyCommitted &&
    input.requestedStatus !== null
  );
}
