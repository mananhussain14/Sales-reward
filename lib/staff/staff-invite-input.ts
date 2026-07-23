/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * Normalization and validation for the Invite Staff form, separated from the Server
 * Action so it can be exercised directly by ./staff-invite-input.test.ts. The action
 * cannot be unit-tested that way: importing it pulls in `next/headers`.
 *
 * WHAT THIS IS NOT. It is NOT the enforcement boundary. Every rule below is applied
 * again, independently, by public.reserve_retailer_staff_invitation() under the
 * caller's own token: it re-canonicalizes the email, re-checks the names, resolves the
 * role by code against the catalogue, enforces "Managers carry no shops / Sales Staff
 * carry at least one", locks each shop and requires it to be ACTIVE and to belong to
 * the Retailer it derived from auth.uid(), and refuses a recipient who already has any
 * membership there. This module exists so an operator sees a useful message before a
 * round trip, not so the browser can be trusted.
 *
 * THE ONE RULE THAT IS A SECURITY PROPERTY. `allowedShopIds` — see
 * validateStaffInviteInput. A submitted shop id is accepted only if it appears in the
 * set the server just read from public.list_retailer_staff_assignable_shops(). That
 * RPC derives the Retailer from auth.uid() and is granted only to holders of
 * RETAILER_STAFF_SHOP_ASSIGN, so a hand-crafted POST naming a shop from another
 * Retailer — or a suspended shop of the caller's own — is rejected here as well as by
 * the reservation RPC. The browser never nominates the assignable set.
 *
 * The role codes and the email shape below are duplicated from the database rather
 * than imported, following this codebase's existing convention for pure modules (see
 * lib/retailers/owner-status-normalization.ts, and the identical EMAIL_PATTERN in
 * app/login/actions.ts). The database's own CHECK constraints remain the authority;
 * these are typo guards that must never be looser than SQL, and are not.
 */

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pragmatic email shape check — byte-identical to the rule in app/login/actions.ts
 * and to retailer_staff_invitations_email_shape in migration 20260723090000:
 * something, an @, something, a dot, something, with no whitespace.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Defensive bound: the maximum length of an email address per RFC 5321. */
const MAX_EMAIL_LENGTH = 254;

/**
 * A defensive cap on how many shops one submission may name. Not a product rule —
 * the database imposes none — but an unbounded array from a hand-crafted POST would
 * become an unbounded `uuid[]` parameter. The subset check against `allowedShopIds`
 * already bounds the ACCEPTED set to the Retailer's own active shops; this bounds the
 * work done before that check runs.
 */
const MAX_SHOP_SELECTION = 200;

/** The two roles a staff invitation may target. Mirrors the database allow-set. */
const MANAGER_ROLE = "RETAILER_MANAGER";
const SALES_ROLE = "SALES_STAFF";

/** The canonical, submitted-and-echoed form values. */
export type StaffInviteValues = {
  firstName: string;
  lastName: string;
  /** Lower-cased and trimmed, matching the database's canonical-email constraint. */
  email: string;
  /** "" when nothing was chosen; otherwise an upper-cased role code. */
  roleCode: string;
  /** De-duplicated, sorted, lower-cased UUIDs. Empty for a Manager. */
  shopIds: string[];
};

/** Per-field messages. A missing key means that field is fine. */
export type StaffInviteFieldErrors = {
  firstName?: string;
  lastName?: string;
  email?: string;
  roleCode?: string;
  shopIds?: string;
};

export type StaffInviteValidation =
  | { ok: true; values: StaffInviteValues }
  | { ok: false; fieldErrors: StaffInviteFieldErrors; values: StaffInviteValues };

/** Reads one FormData-like entry as a string, treating a File as absent. */
function readString(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

/**
 * Canonicalizes raw submitted values.
 *
 * The email is trimmed AND lower-cased so the value validated, the value sent, and
 * the value echoed back into the form are one string — the same canonicalization
 * retailer_staff_invitations_email_canonical performs. The NAMES are trimmed but
 * never case-folded: a person's name is theirs, and "de Silva" is not "De Silva".
 * Nothing is truncated.
 *
 * Shop ids are trimmed, lower-cased, de-duplicated and sorted, so the array this
 * produces is the same for any order the checkboxes were submitted in. Blank entries
 * are dropped; malformed ones are kept so validation can report them rather than
 * silently discarding a tampered value.
 */
export function normalizeStaffInviteInput(raw: {
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  roleCode?: unknown;
  shopIds?: unknown;
}): StaffInviteValues {
  const rawShopIds = Array.isArray(raw.shopIds) ? raw.shopIds : [];

  const shopIds = Array.from(
    new Set(
      rawShopIds
        .map((value) => readString(value).trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ).sort();

  return {
    firstName: readString(raw.firstName).trim(),
    lastName: readString(raw.lastName).trim(),
    email: readString(raw.email).trim().toLowerCase(),
    roleCode: readString(raw.roleCode).trim().toUpperCase(),
    shopIds,
  };
}

/**
 * Validates canonical values against the assignable-shop set the server just read.
 *
 * @param allowedShopIds Shop ids from public.list_retailer_staff_assignable_shops().
 *   Compared case-insensitively. An EMPTY array means the Retailer has no assignable
 *   active shops at all, which makes a Sales Staff invitation impossible — reported as
 *   its own message rather than as "select at least one shop", because there is
 *   nothing the operator could select.
 */
export function validateStaffInviteInput(
  values: StaffInviteValues,
  allowedShopIds: readonly string[],
): StaffInviteValidation {
  const fieldErrors: StaffInviteFieldErrors = {};

  if (values.firstName.length === 0) {
    fieldErrors.firstName = "Enter the person's first name.";
  }
  if (values.lastName.length === 0) {
    fieldErrors.lastName = "Enter the person's last name.";
  }

  if (values.email.length === 0) {
    fieldErrors.email = "Enter an email address.";
  } else if (
    values.email.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(values.email)
  ) {
    fieldErrors.email = "Enter a valid email address.";
  }

  if (values.roleCode.length === 0) {
    fieldErrors.roleCode = "Choose a role.";
  } else if (values.roleCode !== MANAGER_ROLE && values.roleCode !== SALES_ROLE) {
    // Reachable only from a tampered submission — the form offers two radio
    // options — so it gets the same neutral wording rather than naming the value.
    fieldErrors.roleCode = "Choose a role.";
  }

  // Shop rules. Evaluated only once the role is known, because the rule IS the role.
  const allowed = new Set(allowedShopIds.map((id) => id.trim().toLowerCase()));

  if (values.roleCode === MANAGER_ROLE) {
    if (values.shopIds.length > 0) {
      fieldErrors.shopIds = "Retailer Managers are not assigned to specific shops.";
    }
  } else if (values.roleCode === SALES_ROLE) {
    if (values.shopIds.length > MAX_SHOP_SELECTION) {
      fieldErrors.shopIds = "Select fewer shops.";
    } else if (allowed.size === 0) {
      fieldErrors.shopIds =
        "This Retailer has no active shops, so Sales Staff cannot be invited yet.";
    } else if (values.shopIds.length === 0) {
      fieldErrors.shopIds = "Select at least one shop.";
    } else if (
      values.shopIds.some(
        (id) => !UUID_PATTERN.test(id) || !allowed.has(id.toLowerCase()),
      )
    ) {
      // A malformed id and an id outside the assignable set are reported
      // identically. The second case can only come from a tampered submission, and
      // distinguishing it would confirm whether some other shop id exists.
      fieldErrors.shopIds = "Select shops from the list.";
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors, values };
  }

  return { ok: true, values };
}
