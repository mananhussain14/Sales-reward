/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * Every decision the Manage Shops editor makes, separated from both the Server Action
 * and the Client Component so it can be exercised directly by
 * ./staff-shop-assignment-input.test.ts. Neither of those can be unit-tested that way:
 * the action pulls in `next/headers`, and the component needs a DOM this repository has
 * no harness for. So the RULES live here and the two callers stay thin — the same split
 * ./staff-invite-input.ts and ./portal-access-decision.ts already use.
 *
 * WHAT THIS IS NOT. It is NOT the enforcement boundary. Every rule below is applied
 * again, independently, by public.set_retailer_staff_shop_assignments() under the
 * caller's own token: it derives the Retailer from auth.uid(), re-canonicalizes the shop
 * array, requires the target to be an ACTIVE membership of that Retailer holding exactly
 * the SALES_STAFF role, locks each requested shop and requires it to be ACTIVE and
 * same-Retailer, and refuses an empty set. This module exists so an operator sees a
 * useful message before a round trip, not so the browser can be trusted.
 *
 * THE ONE RULE THAT IS A SECURITY PROPERTY. `allowedShopIds` — see
 * validateShopAssignmentInput. A submitted shop id is accepted only if it appears in the
 * set the server just read from public.list_retailer_staff_assignable_shops(). That RPC
 * derives the Retailer from auth.uid() and is granted only to holders of
 * RETAILER_STAFF_SHOP_ASSIGN, so a hand-crafted POST naming another Retailer's shop — or
 * a suspended shop of the caller's own — is rejected here as well as by the RPC.
 *
 * ============================================================================
 * THE ACTIVE-SHOP PROJECTION, WHICH THIS MODULE MUST NOT MISREPRESENT
 * ============================================================================
 * public.list_retailer_staff_members() filters its shop_ids to shops that are currently
 * ACTIVE. A Sales Staff member may ALSO hold a live assignment to a suspended or
 * deactivated shop, which no client can see. The backend preserves those rows and counts
 * them in none of the three totals it returns.
 *
 * So the vocabulary here is deliberate and narrow:
 *   * `currentShopIds` means "the member's VISIBLE active assignments", never "all".
 *   * the counts are described as a CHANGE, never as a total (see describeSaveOutcome).
 * Nothing in this module may compute or emit an employee's total shop count, because
 * nothing in this module has the information to.
 */

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A defensive bound on how many shops one submission may name. Not a product rule — the
 * database imposes none — but an unbounded array from a hand-crafted POST would become
 * an unbounded `uuid[]` parameter. The subset check against `allowedShopIds` already
 * bounds the ACCEPTED set to the Retailer's own active shops; this bounds the work done
 * before that check runs. Same value and same reasoning as ./staff-invite-input.ts.
 */
export const MAX_SHOP_SELECTION = 200;

/** The one role this milestone's editor targets. Mirrors the database allow-set. */
const SALES_ROLE = "SALES_STAFF";

/** The only membership state the backend will accept as a target. */
const ACTIVE_MEMBERSHIP = "ACTIVE";

/* ---------------------------------------------------------------------------
 * Eligibility — which roster rows may be edited at all
 * ------------------------------------------------------------------------- */

/**
 * The subset of a roster row this decision needs. Structural rather than importing
 * StaffMember, so a change to the roster's other fields cannot silently change this
 * rule, and so the test can construct a row without inventing timestamps.
 */
export type ShopAssignmentTarget = {
  roleCode: string;
  membershipStatus: string;
};

/**
 * Whether the Manage Shops control is offered for a roster row.
 *
 * TWO CONDITIONS, both mirroring what the RPC independently enforces:
 *   * the row's role is SALES_STAFF. A RETAILER_MANAGER and a RETAILER_OWNER are
 *     retailer-wide BY ROLE and hold no shop-assignment rows at all, so the operation is
 *     undefined for them — the RPC refuses such a target with 42501.
 *   * the membership is ACTIVE. The RPC's target lookup filters on `status = 'ACTIVE'`,
 *     so an INVITED, SUSPENDED or DEACTIVATED membership is refused identically to an
 *     unknown one.
 *
 * THIS IS PRESENTATION ONLY. Hiding the control removes the accident, not the
 * capability: the Server Action re-resolves access and the RPC re-derives every one of
 * these facts from the database. Nothing downstream may treat a `true` here as
 * permission to write.
 *
 * Note there is no invitation branch. Invitations are a different list with different
 * identifiers, and no invitation row ever reaches this function.
 */
export function canManageStaffShops(target: ShopAssignmentTarget): boolean {
  return (
    target.roleCode === SALES_ROLE && target.membershipStatus === ACTIVE_MEMBERSHIP
  );
}

/* ---------------------------------------------------------------------------
 * Canonicalization
 * ------------------------------------------------------------------------- */

/** Reads one FormData-like entry as a string, treating a File as absent. */
function readString(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

/**
 * Canonicalizes a submitted membership id: trimmed and lower-cased.
 *
 * Not validated here — validation reports, canonicalization only shapes. A malformed
 * value survives this call so validateShopAssignmentInput can refuse it explicitly
 * rather than a blank string silently becoming "missing".
 */
export function normalizeMembershipId(raw: unknown): string {
  return readString(raw).trim().toLowerCase();
}

/**
 * Canonicalizes a submitted shop-id array: trimmed, lower-cased, DE-DUPLICATED and
 * sorted, so the array this produces is identical for any order the checkboxes were
 * submitted in.
 *
 * DUPLICATES ARE COLLAPSED, NOT REJECTED — matching what
 * set_retailer_staff_shop_assignments() itself does with `array_agg(distinct s order by
 * s)`, and what reserve_retailer_staff_invitation() has always done. Under complete
 * replacement `{A, A, B}` and `{A, B}` denote the same final state, so there is no
 * ambiguity to resolve and nothing unsafe to prevent; refusing would fail a form that
 * posted a repeated checkbox value for a reason its user could not act on.
 *
 * Blank entries are dropped. MALFORMED ones are KEPT, so validation can report them
 * rather than a tampered value being silently discarded into a shorter, valid-looking
 * request.
 */
export function normalizeShopSelection(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [];

  return Array.from(
    new Set(
      values
        .map((value) => readString(value).trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ).sort();
}

/* ---------------------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------------------- */

/**
 * Why a submission was refused before the RPC was reached.
 *
 * Each maps to one operator-facing string in the Server Action. They are kept as
 * discriminants rather than messages so this module stays free of copy, and so the test
 * asserts the DECISION rather than the wording.
 *
 *   invalid-target  the membership id is missing or not a UUID. Reachable only from a
 *                   tampered submission — the control carries a value the page read from
 *                   the roster — so it is reported like any other refusal.
 *   empty           no shop was selected. THE ZERO-SHOP RULE.
 *   too-many        more ids than MAX_SHOP_SELECTION.
 *   unavailable-shop  at least one id is malformed, or is not in the set the server just
 *                   read. Malformed and not-assignable are ONE outcome deliberately:
 *                   distinguishing them would confirm whether some other shop id exists.
 */
export type ShopAssignmentRejection =
  | "invalid-target"
  | "empty"
  | "too-many"
  | "unavailable-shop";

export type ShopAssignmentValidation =
  | { ok: true; membershipId: string; shopIds: string[] }
  | { ok: false; reason: ShopAssignmentRejection };

/**
 * Validates a canonicalized submission against the assignable-shop set the server just
 * read.
 *
 * @param allowedShopIds Shop ids from public.list_retailer_staff_assignable_shops(),
 *   compared case-insensitively. An EMPTY array means the caller has no assignable
 *   active shops at all — every selection is then `unavailable-shop`, and the editor
 *   never renders a picker in that state anyway.
 *
 * Order of checks is deliberate: the TARGET is validated first, so a tampered membership
 * id is refused without the shop set being consulted at all.
 */
export function validateShopAssignmentInput(
  membershipId: string,
  shopIds: readonly string[],
  allowedShopIds: readonly string[],
): ShopAssignmentValidation {
  if (!UUID_PATTERN.test(membershipId)) {
    return { ok: false, reason: "invalid-target" };
  }

  if (shopIds.length === 0) {
    return { ok: false, reason: "empty" };
  }

  if (shopIds.length > MAX_SHOP_SELECTION) {
    return { ok: false, reason: "too-many" };
  }

  const allowed = new Set(allowedShopIds.map((id) => id.trim().toLowerCase()));

  const everyShopAssignable = shopIds.every(
    (id) => UUID_PATTERN.test(id) && allowed.has(id.toLowerCase()),
  );

  if (!everyShopAssignable) {
    return { ok: false, reason: "unavailable-shop" };
  }

  return { ok: true, membershipId, shopIds: [...shopIds] };
}

/* ---------------------------------------------------------------------------
 * Selection reconciliation — what the editor opens with, and what it may offer
 * ------------------------------------------------------------------------- */

/**
 * The initial ticked set for an editor that is being opened.
 *
 * THE INTERSECTION IS THE POINT. The member's visible assignments come from the roster
 * and the options come from list_retailer_staff_assignable_shops(); the two are separate
 * reads and can disagree — a shop deactivated between them appears in the roster's
 * ACTIVE projection of a moment ago but not in today's assignable list. Preselecting an
 * id the picker cannot render would produce a checkbox that does not exist, and then
 * submit it.
 *
 * So the editor opens with exactly `current ∩ assignable`, which is by construction a
 * subset of what is on screen. A member whose only assignment just became unassignable
 * opens with nothing ticked and cannot save until the operator chooses — which is the
 * correct outcome, not a bug.
 *
 * Returned sorted, so the value is stable regardless of either input's order and two
 * equal selections compare equal (see hasSelectionChanged).
 */
export function reconcileSelection(
  currentShopIds: readonly string[],
  assignableShopIds: readonly string[],
): string[] {
  const assignable = new Set(
    assignableShopIds.map((id) => id.trim().toLowerCase()),
  );

  return Array.from(
    new Set(
      currentShopIds
        .map((id) => id.trim().toLowerCase())
        .filter((id) => assignable.has(id)),
    ),
  ).sort();
}

/**
 * Whether the operator has actually changed anything.
 *
 * Used to disable a no-op Save. Both sides are canonicalized first, so a difference in
 * order or case is not mistaken for a change — the write would be a no-op and the button
 * would lie about there being something to do.
 */
export function hasSelectionChanged(
  initialShopIds: readonly string[],
  selectedShopIds: readonly string[],
): boolean {
  const canonical = (ids: readonly string[]) =>
    Array.from(new Set(ids.map((id) => id.trim().toLowerCase())))
      .sort()
      .join(",");

  return canonical(initialShopIds) !== canonical(selectedShopIds);
}

/**
 * Whether Save may be enabled.
 *
 * Every condition that must hold, in one place, so the button and the tests cannot drift
 * apart. `optionsReady` is false while the assignable-shop read has not succeeded — an
 * editor with no options must not submit, and a picker failure is a READ failure that
 * must never be converted into a write attempt.
 */
export function canSaveSelection(input: {
  selectedCount: number;
  optionsReady: boolean;
  submitting: boolean;
  changed: boolean;
  alreadySaved: boolean;
}): boolean {
  return (
    input.optionsReady &&
    !input.submitting &&
    !input.alreadySaved &&
    input.changed &&
    input.selectedCount > 0 &&
    input.selectedCount <= MAX_SHOP_SELECTION
  );
}

/* ---------------------------------------------------------------------------
 * Success copy
 * ------------------------------------------------------------------------- */

/**
 * The three counts the RPC returns. They describe the ACTIVE VISIBLE replacement only.
 */
export type ShopAssignmentCounts = {
  added: number;
  removed: number;
  unchanged: number;
};

/**
 * Turns the counts into operator-facing copy.
 *
 * ⚠️ WHAT THIS DELIBERATELY NEVER SAYS. It never emits `added + unchanged` as the
 * member's shop count, and never uses the words "total" or "now has N shops". Those
 * numbers describe only the shops this call could see: a member with a live assignment
 * to a suspended shop has more rows than any arithmetic here would suggest, and stating
 * a total would be a confident false statement. The canonical roster re-read is the
 * display authority for what a member is assigned to; this string reports only the
 * CHANGE that was made. ./staff-shop-assignment-input.test.ts asserts the absence.
 */
export function describeSaveOutcome(counts: ShopAssignmentCounts): string {
  const parts: string[] = [];

  if (counts.added > 0) {
    parts.push(`${counts.added} added`);
  }
  if (counts.removed > 0) {
    parts.push(`${counts.removed} removed`);
  }

  if (parts.length === 0) {
    // added === 0 && removed === 0. The backend wrote nothing at all and recorded no
    // audit event; saying "updated" would claim an event that did not happen.
    return "No changes were needed — these shop assignments were already up to date.";
  }

  const change =
    parts.length === 1 ? parts[0] : `${parts[0]} and ${parts[1]}`;

  return `Shop assignments updated: ${change}.`;
}
