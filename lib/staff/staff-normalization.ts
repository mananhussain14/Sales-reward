/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * The single place where the staff RPCs' snake_case output becomes the application's
 * camelCase types, where their runtime shape is validated, and where every
 * state-dependent presentation decision is derived. Free of side effects so it can be
 * exercised directly by ./staff-normalization.test.ts; the server modules that call
 * the RPCs cannot be tested that way, because importing them pulls in `next/headers`.
 *
 * WHY VALIDATE AT ALL. `supabase.rpc()` is untyped in this project (there are no
 * generated database types — see lib/retailer-portal/retailer-owner-portal.ts), so its
 * result is `any`. A type assertion would be a claim about the SQL, not a check of it,
 * and TypeScript erases it at runtime. Everything below is a real check: if a
 * migration is edited or a column renamed, this layer refuses the row rather than
 * rendering `undefined` into a Retailer Owner's page.
 *
 * FAIL CLOSED. Every normalizer returns a discriminated result, never a throw and
 * never a partially-populated row.
 *
 * NOTHING UNSAFE PASSES THROUGH. The RPCs return no token, token hash, Auth user id,
 * invited-by profile id, internal role UUID, organization id, or audit metadata — so
 * there is nothing of that kind here to drop. The one identifier that does cross is
 * the membership id (a stable React key for the caller's OWN tenant, released by an
 * RPC that already required RETAILER_STAFF_READ) and the invitation id (the address a
 * resend or revoke names, which the revoke RPC re-checks against the Retailer it
 * derives for itself).
 */

/* ---------------------------------------------------------------------------
 * Assignable shops — public.list_retailer_staff_assignable_shops()
 * ------------------------------------------------------------------------- */

export type AssignableShop = {
  shopId: string;
  shopName: string;
  shopCode: string | null;
  city: string | null;
};

export type AssignableShopsNormalization =
  | { status: "ok"; shops: AssignableShop[] }
  | { status: "malformed"; reason: string };

/** A non-empty string, or null. Used for every genuinely nullable text column. */
function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A required non-empty string, or null when the column is missing/blank. */
function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** An ISO timestamp string, or null. Never parsed here — formatting is the page's job. */
function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** A uuid[] column, normalized to lower-case strings. Non-arrays become []. */
function uuidArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** A text[] column. Non-arrays become []. */
function textArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function normalizeAssignableShops(
  data: unknown,
): AssignableShopsNormalization {
  if (!Array.isArray(data)) {
    return { status: "malformed", reason: "not-an-array" };
  }

  const shops: AssignableShop[] = [];

  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      return { status: "malformed", reason: "row-not-an-object" };
    }
    const record = row as Record<string, unknown>;

    const shopId = requiredText(record.shop_id);
    const shopName = requiredText(record.shop_name);

    // A shop with no id is unusable — the whole point of this RPC is the id — and a
    // shop with no name is unrenderable. Either means drift, so the read fails rather
    // than offering a blank checkbox that would submit an empty value.
    if (shopId === null) return { status: "malformed", reason: "shop_id" };
    if (shopName === null) return { status: "malformed", reason: "shop_name" };

    shops.push({
      shopId: shopId.toLowerCase(),
      shopName,
      shopCode: optionalText(record.shop_code),
      city: optionalText(record.city),
    });
  }

  return { status: "ok", shops };
}

/* ---------------------------------------------------------------------------
 * Staff roster — public.list_retailer_staff_members()
 * ------------------------------------------------------------------------- */

export type StaffMember = {
  membershipId: string;
  firstName: string;
  lastName: string;
  roleCode: string;
  roleName: string | null;
  membershipStatus: string;
  shopIds: string[];
  shopNames: string[];
  joinedAt: string | null;
  createdAt: string | null;
};

export type StaffMembersNormalization =
  | { status: "ok"; members: StaffMember[] }
  | { status: "malformed"; reason: string };

export function normalizeStaffMembers(data: unknown): StaffMembersNormalization {
  if (!Array.isArray(data)) {
    return { status: "malformed", reason: "not-an-array" };
  }

  const members: StaffMember[] = [];

  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      return { status: "malformed", reason: "row-not-an-object" };
    }
    const record = row as Record<string, unknown>;

    const membershipId = requiredText(record.membership_id);
    const firstName = requiredText(record.first_name);
    const lastName = requiredText(record.last_name);
    const roleCode = requiredText(record.role_code);
    const membershipStatus = requiredText(record.membership_status);

    if (membershipId === null) return { status: "malformed", reason: "membership_id" };
    if (firstName === null) return { status: "malformed", reason: "first_name" };
    if (lastName === null) return { status: "malformed", reason: "last_name" };
    if (roleCode === null) return { status: "malformed", reason: "role_code" };
    if (membershipStatus === null) {
      return { status: "malformed", reason: "membership_status" };
    }

    members.push({
      membershipId,
      firstName,
      lastName,
      roleCode,
      roleName: optionalText(record.role_name),
      membershipStatus,
      shopIds: uuidArray(record.shop_ids),
      shopNames: textArray(record.shop_names),
      joinedAt: optionalTimestamp(record.joined_at),
      createdAt: optionalTimestamp(record.created_at),
    });
  }

  return { status: "ok", members };
}

/* ---------------------------------------------------------------------------
 * Invitations — public.list_retailer_staff_invitations()
 * ------------------------------------------------------------------------- */

/**
 * The derived states the backend emits, verbatim. Exhaustive: the SQL CASE in
 * list_retailer_staff_invitations produces exactly these six and nothing else. An
 * unrecognized value is treated as drift and fails the read, rather than rendering an
 * unknown badge or — worse — defaulting into a state that offers an action.
 */
export const STAFF_INVITATION_STATES = [
  "RESERVED",
  "PENDING",
  "DELIVERY_FAILED",
  "EXPIRED",
  "REVOKED",
  "ACCEPTED",
] as const;

export type StaffInvitationState = (typeof STAFF_INVITATION_STATES)[number];

export type StaffInvitation = {
  invitationId: string;
  firstName: string;
  lastName: string;
  email: string;
  roleCode: string;
  state: StaffInvitationState;
  createdAt: string | null;
  sentAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  /** True when the backend recorded EMAIL_DISPATCH_FAILED for the current token. */
  deliveryFailed: boolean;
  shopIds: string[];
};

export type StaffInvitationsNormalization =
  | { status: "ok"; invitations: StaffInvitation[] }
  | { status: "malformed"; reason: string };

function isStaffInvitationState(value: unknown): value is StaffInvitationState {
  return (
    typeof value === "string" &&
    (STAFF_INVITATION_STATES as readonly string[]).includes(value)
  );
}

export function normalizeStaffInvitations(
  data: unknown,
): StaffInvitationsNormalization {
  if (!Array.isArray(data)) {
    return { status: "malformed", reason: "not-an-array" };
  }

  const invitations: StaffInvitation[] = [];

  for (const row of data) {
    if (typeof row !== "object" || row === null) {
      return { status: "malformed", reason: "row-not-an-object" };
    }
    const record = row as Record<string, unknown>;

    const invitationId = requiredText(record.invitation_id);
    const firstName = requiredText(record.first_name);
    const lastName = requiredText(record.last_name);
    const email = requiredText(record.email);
    const roleCode = requiredText(record.role_code);

    if (invitationId === null) return { status: "malformed", reason: "invitation_id" };
    if (firstName === null) return { status: "malformed", reason: "first_name" };
    if (lastName === null) return { status: "malformed", reason: "last_name" };
    if (email === null) return { status: "malformed", reason: "email" };
    if (roleCode === null) return { status: "malformed", reason: "role_code" };
    if (!isStaffInvitationState(record.derived_state)) {
      return { status: "malformed", reason: "derived_state" };
    }

    // The failure CODE itself is never surfaced. Only the fact that delivery failed
    // reaches the UI — the code is an internal classification, and the one value the
    // column may hold (EMAIL_DISPATCH_FAILED) says nothing an operator can act on
    // beyond "it did not send".
    const deliveryFailed = record.failure_code !== null && record.failure_code !== undefined;

    invitations.push({
      invitationId: invitationId.toLowerCase(),
      firstName,
      lastName,
      email: email.toLowerCase(),
      roleCode,
      state: record.derived_state,
      createdAt: optionalTimestamp(record.created_at),
      sentAt: optionalTimestamp(record.sent_at),
      acceptedAt: optionalTimestamp(record.accepted_at),
      revokedAt: optionalTimestamp(record.revoked_at),
      expiresAt: optionalTimestamp(record.expires_at),
      deliveryFailed,
      shopIds: uuidArray(record.shop_ids),
    });
  }

  return { status: "ok", invitations };
}

/* ---------------------------------------------------------------------------
 * Derived presentation rules
 * ------------------------------------------------------------------------- */

/**
 * The three states in which the invitation row is still LIVE — status PENDING in the
 * database, within its expiry window. Only these may be resent or revoked.
 *
 *   RESERVED         reserved but never delivered (no sent_at, no failure).
 *   PENDING          delivered and awaiting the recipient.
 *   DELIVERY_FAILED  the provider refused the last attempt; the token is retained.
 *
 * These mirror the backend exactly: prepare_retailer_staff_invitation and
 * revoke_retailer_staff_invitation both require status = 'PENDING' and
 * expires_at > now(), and revoke additionally sweeps stale rows to EXPIRED first. The
 * database is the authority; hiding a button only removes the accident, and the
 * Server Actions re-check nothing themselves precisely because the RPC does.
 */
const LIVE_STATES: readonly StaffInvitationState[] = [
  "RESERVED",
  "PENDING",
  "DELIVERY_FAILED",
];

/** Whether a resend may be offered for this state. */
export function canResendInvitation(state: StaffInvitationState): boolean {
  return LIVE_STATES.includes(state);
}

/** Whether a revoke may be offered for this state. */
export function canRevokeInvitation(state: StaffInvitationState): boolean {
  return LIVE_STATES.includes(state);
}

/** Whether the row is history — no action of any kind is offered. */
export function isHistoricalInvitation(state: StaffInvitationState): boolean {
  return !LIVE_STATES.includes(state);
}

/** The label shown for each derived state. Presentation only; nothing branches on it. */
const STATE_LABELS: Record<StaffInvitationState, string> = {
  RESERVED: "Not sent yet",
  PENDING: "Awaiting acceptance",
  DELIVERY_FAILED: "Delivery failed",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
  ACCEPTED: "Accepted",
};

export function staffInvitationStateLabel(state: StaffInvitationState): string {
  return STATE_LABELS[state];
}

/**
 * Resolves the shop NAMES for a set of intended shop ids.
 *
 * list_retailer_staff_invitations returns the invitation's shop IDS but no names, and
 * list_retailer_staff_assignable_shops is the only source of names the Owner has. An
 * id with no match is a shop that has since been suspended, deactivated, or moved —
 * so it is reported as a count of unavailable shops rather than as a fabricated name
 * or a raw UUID. A UUID in the markup would be an internal identifier on screen for
 * no benefit.
 */
export function describeIntendedShops(
  shopIds: readonly string[],
  assignable: readonly AssignableShop[],
): { names: string[]; unavailableCount: number } {
  const byId = new Map(assignable.map((shop) => [shop.shopId, shop.shopName]));
  const names: string[] = [];
  let unavailableCount = 0;

  for (const id of shopIds) {
    const name = byId.get(id.toLowerCase());
    if (name === undefined) {
      unavailableCount += 1;
    } else {
      names.push(name);
    }
  }

  names.sort((a, b) => a.localeCompare(b, "en"));
  return { names, unavailableCount };
}

/* ---------------------------------------------------------------------------
 * Recipient resolution — public.get_retailer_staff_invitation_for_recipient()
 * ------------------------------------------------------------------------- */

export type RecipientInvitation = {
  firstName: string;
  lastName: string;
  email: string;
  retailerName: string;
  roleCode: string;
  roleName: string | null;
  shopNames: string[];
  expiresAt: string | null;
};

export type RecipientInvitationNormalization =
  | { status: "ok"; invitation: RecipientInvitation }
  /** Zero rows: unknown / malformed / expired / terminal / wrong account — identical. */
  | { status: "unavailable" }
  | { status: "malformed"; reason: string };

/**
 * Normalizes the recipient resolver's single row.
 *
 * ZERO ROWS IS NOT AN ERROR AND NOT A DENIAL MESSAGE — it is the one generic
 * "unavailable" outcome the RPC produces for every unavailable case, and the page
 * renders one screen for it. The invitation_id the RPC also returns is deliberately
 * NOT carried into the type: the acceptance action addresses the invitation by token
 * hash read from an HttpOnly cookie, so an id in the page would be an identifier
 * rendered for no purpose.
 */
export function normalizeRecipientInvitation(
  data: unknown,
): RecipientInvitationNormalization {
  if (!Array.isArray(data)) {
    return { status: "malformed", reason: "not-an-array" };
  }
  if (data.length === 0) {
    return { status: "unavailable" };
  }

  const row = data[0];
  if (typeof row !== "object" || row === null) {
    return { status: "malformed", reason: "row-not-an-object" };
  }
  const record = row as Record<string, unknown>;

  const firstName = requiredText(record.first_name);
  const lastName = requiredText(record.last_name);
  const email = requiredText(record.email);
  const retailerName = requiredText(record.retailer_name);
  const roleCode = requiredText(record.role_code);

  if (firstName === null) return { status: "malformed", reason: "first_name" };
  if (lastName === null) return { status: "malformed", reason: "last_name" };
  if (email === null) return { status: "malformed", reason: "email" };
  if (retailerName === null) return { status: "malformed", reason: "retailer_name" };
  if (roleCode === null) return { status: "malformed", reason: "role_code" };

  return {
    status: "ok",
    invitation: {
      firstName,
      lastName,
      email: email.toLowerCase(),
      retailerName,
      roleCode,
      roleName: optionalText(record.role_name),
      shopNames: textArray(record.shop_names),
      expiresAt: optionalTimestamp(record.expires_at),
    },
  };
}
