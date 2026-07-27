/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client, no crypto,
 * no Deno API, no Node API.
 *
 * THE ONE WIRE CONTRACT for the `send-retailer-staff-invitation` Edge Function, shared
 * by every caller. Written dependency-free for the same reason lib/receipts/receipt-cors.ts
 * and lib/staff/staff-invite-flow.ts are: Deno imports it directly from
 * supabase/functions/send-retailer-staff-invitation/index.ts, Next.js imports it from
 * lib/staff/retailer-staff-invitations.ts, and Node imports it from
 * ./staff-invitation-delivery-contract.test.ts — so the contract that ships is the
 * contract that is tested, and the web and Flutter clients cannot hold different
 * opinions about what a valid request or a stable outcome is.
 *
 * ============================================================================
 * WHAT A CLIENT MAY SEND, EXHAUSTIVELY
 * ============================================================================
 *   firstName, lastName, email, roleCode, shopIds
 *
 * And nothing else. `parseStaffInvitationRequest` REJECTS any unknown top-level key
 * rather than ignoring it, which is what makes the following impossible to smuggle in:
 * a Retailer organization id, an actor / user / profile / membership id, a permission,
 * an invitation id, a token, a token hash, audit data, an invitation state, an
 * expiration, a normalized email, Resend configuration, or a service-role credential.
 * A silently-ignored field is a field a future edit might start honouring; a rejected
 * one cannot become load-bearing by accident.
 *
 * THIS IS NOT THE ENFORCEMENT BOUNDARY. Every rule below is applied again, and
 * independently, by public.reserve_retailer_staff_invitation() under the CALLER'S OWN
 * token: it re-canonicalizes the email, re-checks the names, resolves the role by code
 * against the catalogue, enforces "Managers carry no shops / Sales Staff carry at least
 * one", and locks each shop and requires it to be ACTIVE and to belong to the Retailer
 * it derived from auth.uid(). The reservation RPC is the final authority. This module
 * exists so a malformed or hostile request is refused cheaply, with a stable machine
 * code, before anything is reserved — not so a client can be trusted.
 *
 * ============================================================================
 * THE RESPONSE VOCABULARY IS CLOSED, AND IT IS THE WHOLE RESPONSE
 * ============================================================================
 * Every reply is exactly `{ version, outcome, code }`. There is no field for a SQL
 * message, a SQLSTATE, a PostgREST payload, a provider response body, a stack trace,
 * Supabase project information, an invitation id, an email address, a raw token, or a
 * token hash — so none of those can leave the function through a response, whatever a
 * later edit does to the handler.
 *
 * `outcome` answers the ONE question a client must never get wrong: MIGHT AN EMAIL HAVE
 * BEEN DELIVERED? `NOT_SENT` means nothing was handed to the provider and the request
 * may be repeated as-is. The other four mean it was, and repeating the whole write would
 * rotate the token (invalidating a link that may already be in the recipient's inbox)
 * and send a second email. `code` refines the reason without ever widening what is
 * disclosed.
 */

/**
 * The contract version, pinned in every response.
 *
 * A client may refuse a version it does not understand. It is bumped only for a
 * BREAKING change — a removed field, a changed field meaning, or a repurposed outcome.
 * Adding a new `code` to an existing `outcome` is NOT breaking: clients are required to
 * treat an unrecognized code as its outcome's generic case, which is why the outcome
 * vocabulary is deliberately tiny and the code vocabulary is allowed to grow.
 */
export const STAFF_INVITATION_CONTRACT_VERSION = 1;

/* ---------------------------------------------------------------------------
 * Roles
 * ------------------------------------------------------------------------- */

/** The two roles a staff invitation may target. Mirrors the database allow-set. */
export const RETAILER_MANAGER_ROLE = "RETAILER_MANAGER";
export const SALES_STAFF_ROLE = "SALES_STAFF";

export const STAFF_INVITATION_ROLE_CODES = [
  RETAILER_MANAGER_ROLE,
  SALES_STAFF_ROLE,
] as const;

export type StaffInvitationRoleCode = (typeof STAFF_INVITATION_ROLE_CODES)[number];

/* ---------------------------------------------------------------------------
 * Bounds
 * ------------------------------------------------------------------------- */

/** The maximum length of an email address per RFC 5321. The database checks it too. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * A defensive bound on a submitted name. NOT a product rule — the database imposes no
 * length limit on first_name / last_name — but an unbounded string from a hand-crafted
 * POST would become an unbounded `text` parameter. 200 characters is far beyond any
 * real name and far below anything worth storing by accident.
 */
export const MAX_NAME_LENGTH = 200;

/**
 * A defensive cap on how many shops one submission may name, byte-identical to the one
 * in lib/staff/staff-invite-input.ts. The reservation RPC already bounds the ACCEPTED
 * set to the Retailer's own active shops; this bounds the work done before that runs.
 */
export const MAX_SHOP_SELECTION = 200;

/**
 * The largest request body the function will read. A JSON document of two names, an
 * address, a role code and 200 uuids is a few kilobytes; 64 KiB leaves generous room
 * and still refuses a body designed to exhaust the runtime before validation begins.
 */
export const MAX_REQUEST_BYTES = 64 * 1024;

/* ---------------------------------------------------------------------------
 * The feature flag
 * ------------------------------------------------------------------------- */

/** The environment variable's name — for MESSAGES and documentation only. */
export const RETAILER_STAFF_INVITATIONS_FLAG_VAR =
  "RETAILER_STAFF_INVITATIONS_ENABLED";

/**
 * The ONE value that enables sending, defined once for every runtime that reads the
 * flag — the Next.js server (lib/features/retailer-staff-invitations.ts, via
 * `process.env`) and the Edge Function (via `Deno.env`). Compared byte-for-byte: "1",
 * "yes", "on", "TRUE", " true " and "True" are all DISABLED. A flag guarding a
 * service-role code path and an outbound email provider fails closed, and accepting a
 * family of spellings is how a deployment typo silently arms a feature.
 */
export const RETAILER_STAFF_INVITATIONS_ENABLED_VALUE = "true";

/** Whether a raw flag value enables sending. The single comparison, shared. */
export function isStaffInvitationSendingEnabled(rawValue: unknown): boolean {
  return rawValue === RETAILER_STAFF_INVITATIONS_ENABLED_VALUE;
}

/* ---------------------------------------------------------------------------
 * The request
 * ------------------------------------------------------------------------- */

/** The exact top-level keys a request body may carry. Anything else is refused. */
export const STAFF_INVITATION_REQUEST_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "roleCode",
  "shopIds",
] as const;

/** The canonical, validated request. Every value is trimmed and case-normalized. */
export type StaffInvitationRequest = {
  /** Trimmed. Never case-folded: a person's name is theirs. */
  firstName: string;
  lastName: string;
  /** Trimmed and lower-cased, matching the database's canonical-email constraint. */
  email: string;
  roleCode: StaffInvitationRoleCode;
  /** Lower-cased, de-duplicated, sorted. Always empty for a Retailer Manager. */
  shopIds: string[];
};

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pragmatic email shape check — byte-identical to the rule in
 * lib/staff/staff-invite-input.ts, in app/login/actions.ts, and to
 * retailer_staff_invitations_email_shape in migration 20260723090000: something, an @,
 * something, a dot, something, with no whitespace.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------------------------------------------------------------------------
 * The response
 * ------------------------------------------------------------------------- */

/**
 * THE SAFETY-CRITICAL CLASSIFICATION. A client must be able to decide, from this field
 * alone, whether repeating the request could send a second email or invalidate a link
 * already in someone's inbox.
 *
 *   SENT                                 first delivery; provider accepted; recorded.
 *   RESENT                               the same, for an invitation that already existed.
 *   DELIVERY_ACCEPTED_STATUS_UNCONFIRMED the provider ACCEPTED the message, but the
 *                                        bookkeeping write that records it could not be
 *                                        confirmed. The link is live and acceptable —
 *                                        see the note on the code of the same name.
 *   DELIVERY_FAILED                      the provider did not accept it. The invitation
 *                                        is live and retryable.
 *   NOT_SENT                             nothing was handed to the provider. Safe to
 *                                        repeat the request unchanged once the reason
 *                                        in `code` is addressed.
 */
export type StaffInvitationOutcome =
  | "SENT"
  | "RESENT"
  | "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED"
  | "DELIVERY_FAILED"
  | "NOT_SENT";

/**
 * The stable machine codes. Each maps to exactly one HTTP status (below) and to exactly
 * one outcome, and none of them carries or implies backend text.
 */
export type StaffInvitationCode =
  /* --- outcomes that reached the provider --------------------------------- */
  | "SENT"
  | "RESENT"
  /**
   * THE PARTIAL SUCCESS. Resend accepted the message and the accept link is already in
   * flight, but public.record_retailer_staff_invitation_sent() did not confirm.
   *
   * THE INVITATION IS STILL ACCEPTABLE. prepare_retailer_staff_invitation() had already
   * stored the token hash, set `expires_at = now() + 24 hours` and left the row PENDING
   * before the email went out, and NEITHER
   * public.get_retailer_staff_invitation_for_recipient() NOR
   * public.accept_retailer_staff_invitation() reads `sent_at` (migration
   * 20260724210000). What is unconfirmed is the bookkeeping — `sent_at` and the
   * STAFF_INVITATION_SENT / STAFF_INVITATION_RESENT audit row — not the recipient's
   * ability to accept.
   *
   * SO THE CLIENT MUST NOT AUTOMATICALLY REPEAT THE WRITE. Repeating it re-reserves,
   * mints a NEW token and rotates the hash, which kills the link that was just
   * delivered and sends a second email. The correct response is to re-read the
   * invitation history and show the operator its current state; a deliberate,
   * human-initiated resend afterwards is fine, and is what the resend control already
   * does.
   */
  | "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED"
  /** The provider rejected the message, or the transport failed. Retryable. */
  | "DELIVERY_FAILED"
  /* --- nothing was sent ---------------------------------------------------- */
  /** The request was not a POST (and not the OPTIONS preflight). */
  | "METHOD_NOT_ALLOWED"
  /** Malformed JSON, a missing/blank/oversized field, or an unknown top-level key. */
  | "INVALID_REQUEST"
  /**
   * The role and the shop selection contradict each other: shops for a Retailer
   * Manager, or none for Sales Staff. Structurally valid, semantically impossible.
   */
  | "INVALID_ROLE_SHOP_COMBINATION"
  /** No access token, or one the Auth server does not accept. */
  | "AUTH_REQUIRED"
  /** Authenticated, but not permitted to invite staff for any Retailer. */
  | "ACCESS_DENIED"
  /** A live invitation exists for this address with a different role or shop set. */
  | "INVITATION_CONFLICT"
  /** The caller's Retailer is not ACTIVE, so it may not invite anyone. */
  | "RETAILER_INACTIVE"
  /** Sending is switched off for this deployment. */
  | "FEATURE_DISABLED"
  /** A required server-side secret is absent or invalid. Nothing was attempted. */
  | "NOT_CONFIGURED"
  /** Anything else. Deliberately opaque. */
  | "INTERNAL_ERROR";

/**
 * Code -> HTTP status. One status per code, so a client can branch on either and never
 * see the two disagree.
 *
 * 202 for DELIVERY_ACCEPTED_STATUS_UNCONFIRMED is load-bearing: it is a SUCCESS status,
 * so no HTTP client library, proxy, or retry policy will resubmit the write on its own.
 * A 5xx there would invite exactly the duplicate delivery the outcome exists to prevent.
 *
 * 502 for DELIVERY_FAILED says an upstream provider refused, which is true and is
 * retryable. 503 covers the two states an operator (not a caller) must fix.
 */
export const STAFF_INVITATION_HTTP_STATUS: Record<StaffInvitationCode, number> = {
  SENT: 200,
  RESENT: 200,
  DELIVERY_ACCEPTED_STATUS_UNCONFIRMED: 202,
  DELIVERY_FAILED: 502,
  METHOD_NOT_ALLOWED: 405,
  INVALID_REQUEST: 400,
  INVALID_ROLE_SHOP_COMBINATION: 422,
  AUTH_REQUIRED: 401,
  ACCESS_DENIED: 403,
  INVITATION_CONFLICT: 409,
  RETAILER_INACTIVE: 422,
  FEATURE_DISABLED: 503,
  NOT_CONFIGURED: 503,
  INTERNAL_ERROR: 500,
};

/** The four codes that mean the message reached Resend. Everything else is NOT_SENT. */
const DELIVERY_ATTEMPTED_CODES = new Set<string>([
  "SENT",
  "RESENT",
  "DELIVERY_ACCEPTED_STATUS_UNCONFIRMED",
  "DELIVERY_FAILED",
]);

/** The coarse classification for a code. */
export function staffInvitationOutcomeFor(
  code: StaffInvitationCode,
): StaffInvitationOutcome {
  return DELIVERY_ATTEMPTED_CODES.has(code)
    ? (code as StaffInvitationOutcome)
    : "NOT_SENT";
}

/** The entire response body. Three fields, and there is no way to add a fourth. */
export type StaffInvitationResponse = {
  version: typeof STAFF_INVITATION_CONTRACT_VERSION;
  outcome: StaffInvitationOutcome;
  code: StaffInvitationCode;
};

/** Builds the one and only response shape from a code. */
export function staffInvitationResponse(
  code: StaffInvitationCode,
): StaffInvitationResponse {
  return {
    version: STAFF_INVITATION_CONTRACT_VERSION,
    outcome: staffInvitationOutcomeFor(code),
    code,
  };
}

/** Whether a value is one of this contract's codes. Used by clients parsing a reply. */
export function isStaffInvitationCode(value: unknown): value is StaffInvitationCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(STAFF_INVITATION_HTTP_STATUS, value)
  );
}

/* ---------------------------------------------------------------------------
 * Request parsing
 * ------------------------------------------------------------------------- */

export type StaffInvitationRequestParse =
  | { ok: true; request: StaffInvitationRequest }
  | {
      ok: false;
      /** INVALID_REQUEST or INVALID_ROLE_SHOP_COMBINATION. Nothing else. */
      code: "INVALID_REQUEST" | "INVALID_ROLE_SHOP_COMBINATION";
    };

const INVALID: StaffInvitationRequestParse = { ok: false, code: "INVALID_REQUEST" };
const INVALID_COMBINATION: StaffInvitationRequestParse = {
  ok: false,
  code: "INVALID_ROLE_SHOP_COMBINATION",
};

/** A plain JSON object — not null, not an array, not a boxed primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and canonicalizes a decoded request body.
 *
 * Takes an already-decoded value rather than a string so the caller owns the byte
 * limit and the JSON.parse failure, and so this function has one job. `undefined` and
 * any non-object (including `null` and an array) are refused.
 *
 * WHAT IS DELIBERATELY NOT CHECKED HERE: whether each shop id belongs to the caller's
 * Retailer and is ACTIVE. That question can only be answered under the caller's own
 * identity, and it is answered by reserve_retailer_staff_invitation(), which locks each
 * shop row. Restating it here against anything a client supplied would be theatre.
 */
export function parseStaffInvitationRequest(
  body: unknown,
): StaffInvitationRequestParse {
  if (!isPlainObject(body)) return INVALID;

  // Unknown keys are REFUSED, not ignored — see this module's header.
  const allowed = new Set<string>(STAFF_INVITATION_REQUEST_FIELDS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return INVALID;
  }

  // Names. Trimmed, never case-folded, bounded, and required.
  if (typeof body.firstName !== "string" || typeof body.lastName !== "string") {
    return INVALID;
  }
  const firstName = body.firstName.trim();
  const lastName = body.lastName.trim();
  if (firstName.length === 0 || firstName.length > MAX_NAME_LENGTH) return INVALID;
  if (lastName.length === 0 || lastName.length > MAX_NAME_LENGTH) return INVALID;

  // Email. Trimmed AND lower-cased, so the value validated is the value sent.
  if (typeof body.email !== "string") return INVALID;
  const email = body.email.trim().toLowerCase();
  if (
    email.length === 0 ||
    email.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(email)
  ) {
    return INVALID;
  }

  // Role. Trimmed and upper-cased, then required to be one of exactly two codes —
  // the same normalization reserve_retailer_staff_invitation() performs in SQL.
  if (typeof body.roleCode !== "string") return INVALID;
  const roleCode = body.roleCode.trim().toUpperCase();
  if (roleCode !== RETAILER_MANAGER_ROLE && roleCode !== SALES_STAFF_ROLE) {
    return INVALID;
  }

  // Shops. The field is REQUIRED even for a Manager, who must send `[]` explicitly:
  // an absent array and an empty one would otherwise be the same request, and "I chose
  // no shops" must not be expressible as "I forgot the field".
  if (!Array.isArray(body.shopIds)) return INVALID;
  if (body.shopIds.length > MAX_SHOP_SELECTION) return INVALID;

  const seen = new Set<string>();
  const shopIds: string[] = [];
  for (const raw of body.shopIds) {
    if (typeof raw !== "string") return INVALID;
    const shopId = raw.trim().toLowerCase();
    if (!UUID_PATTERN.test(shopId)) return INVALID;
    // A duplicate is refused rather than de-duplicated. The database would collapse it
    // silently (array_agg(distinct …)), so a client that sends one has a defect, and
    // hiding it would let that defect reach production unnoticed.
    if (seen.has(shopId)) return INVALID;
    seen.add(shopId);
    shopIds.push(shopId);
  }
  shopIds.sort();

  // The role/shop rules, reported separately because they are the one class of failure
  // where the request is structurally perfect and semantically impossible.
  if (roleCode === RETAILER_MANAGER_ROLE && shopIds.length > 0) {
    return INVALID_COMBINATION;
  }
  if (roleCode === SALES_STAFF_ROLE && shopIds.length === 0) {
    return INVALID_COMBINATION;
  }

  return {
    ok: true,
    request: { firstName, lastName, email, roleCode, shopIds },
  };
}
