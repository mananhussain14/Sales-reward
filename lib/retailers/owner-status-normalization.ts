/**
 * PURE MODULE — no Supabase client, no `next/headers`, no I/O, no imports at all.
 *
 * The single place where public.get_vendor_retailer_owner_status()'s snake_case
 * output becomes the application's camelCase type, where its runtime shape is
 * validated, and where every state-dependent presentation and submit decision is
 * derived. It is deliberately free of side effects so it can be exercised directly
 * by the unit tests in ./owner-status-normalization.test.ts — the server module
 * that calls the RPC cannot be tested that way, because importing it pulls in
 * `next/headers`.
 *
 * WHY VALIDATE AT ALL. `supabase.rpc()` is untyped in this project (there are no
 * generated database types — see lib/retailer-portal/retailer-owner-portal.ts), so
 * its result is `any`. A type assertion would be a claim about the SQL, not a
 * check of it, and TypeScript erases it at runtime. Everything below is a real
 * check: if the migration is ever edited, or a column renamed, or an unknown state
 * string returned, this layer refuses the row rather than rendering `undefined`
 * or an unrecognized state into a Vendor admin's page.
 *
 * FAIL CLOSED. normalizeOwnerStatusResult returns a discriminated result, never
 * throws, and never returns a partially-populated object. An unknown state, a
 * malformed timestamp, a missing row, or two rows are each rejected outright — the
 * server layer maps every rejection to "unavailable", and the page must never
 * render a rejected read as the (benign-looking) NONE state.
 *
 * NO IDENTIFIERS. Only the seven display-safe columns the RPC promises are read.
 * Any other field an errant RPC might return — an invitation id, Auth user id,
 * membership id, token, or token hash — is never read here and therefore can never
 * reach the application type or the browser.
 */

/** The five approved display states. THE ONLY values owner_state may hold. */
export type RetailerOwnerState =
  | "NONE"
  | "DELIVERY_FAILED"
  | "PENDING"
  | "EXPIRED"
  | "ACTIVE";

/** The set form, for a runtime membership test without a switch. */
const OWNER_STATES: readonly RetailerOwnerState[] = [
  "NONE",
  "DELIVERY_FAILED",
  "PENDING",
  "EXPIRED",
  "ACTIVE",
];

/**
 * The normalized owner status. Carries NO identifiers — not the invitation id,
 * Auth user id, membership id, organization id, relationship id, role id, or any
 * token. `email` is display-safe because the RPC returned it only after proving
 * the caller is the authorized Vendor for this Retailer.
 */
export type VendorRetailerOwnerStatus = {
  state: RetailerOwnerState;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  /** Raw ISO timestamp string, or null. Formatted for display by formatOwnerTimestamp. */
  sentAt: string | null;
  expiresAt: string | null;
  acceptedAt: string | null;
};

/**
 * The outcome of normalizing the RPC result. "malformed" carries a short,
 * non-sensitive reason for SERVER LOGS ONLY: it names the offending field, never a
 * value read from the database.
 */
export type OwnerStatusNormalization =
  | { status: "ok"; value: VendorRetailerOwnerStatus }
  | { status: "malformed"; reason: string };

/** Narrows an unknown value to an indexable object without using `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Requires a non-empty string after trimming. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A nullable text column: null/undefined normalizes to null; a present value must
 * be a non-empty string, returned trimmed. A present-but-blank value is a fault,
 * not an absence — it would render an empty cell that looks like data.
 */
function readNullableText(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (isNonEmptyString(value)) return { ok: true, value: value.trim() };
  return { ok: false };
}

/**
 * A nullable timestamp column: null/undefined normalizes to null; a present value
 * must be a string that Date can parse. The raw string is preserved for the
 * display formatter — this layer validates it, it does not reformat it. A present
 * but unparseable timestamp is a fault: rendering "Invalid Date" would be worse
 * than failing the whole read closed.
 */
function readNullableTimestamp(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string" || value.trim().length === 0) return { ok: false };
  if (Number.isNaN(new Date(value).getTime())) return { ok: false };
  return { ok: true, value };
}

/**
 * Normalizes ONE row of public.get_vendor_retailer_owner_status().
 *
 * Only the seven documented columns are read. owner_state must be one of the five
 * approved values or the row is rejected — an unknown state fails closed rather
 * than reaching a `switch` with no matching branch.
 */
export function normalizeOwnerStatusRow(
  row: unknown,
): OwnerStatusNormalization {
  if (!isRecord(row)) {
    return { status: "malformed", reason: "owner status row was not an object" };
  }

  const rawState = row.owner_state;
  if (typeof rawState !== "string" || !OWNER_STATES.includes(rawState as RetailerOwnerState)) {
    return { status: "malformed", reason: "owner_state missing or not an approved value" };
  }
  const state = rawState as RetailerOwnerState;

  const firstName = readNullableText(row.owner_first_name);
  if (!firstName.ok) return { status: "malformed", reason: "owner_first_name present but not a non-empty string" };

  const lastName = readNullableText(row.owner_last_name);
  if (!lastName.ok) return { status: "malformed", reason: "owner_last_name present but not a non-empty string" };

  const email = readNullableText(row.owner_email);
  if (!email.ok) return { status: "malformed", reason: "owner_email present but not a non-empty string" };

  const sentAt = readNullableTimestamp(row.sent_at);
  if (!sentAt.ok) return { status: "malformed", reason: "sent_at present but not a valid timestamp" };

  const expiresAt = readNullableTimestamp(row.expires_at);
  if (!expiresAt.ok) return { status: "malformed", reason: "expires_at present but not a valid timestamp" };

  const acceptedAt = readNullableTimestamp(row.accepted_at);
  if (!acceptedAt.ok) return { status: "malformed", reason: "accepted_at present but not a valid timestamp" };

  return {
    status: "ok",
    value: {
      state,
      firstName: firstName.value,
      lastName: lastName.value,
      email: email.value,
      sentAt: sentAt.value,
      expiresAt: expiresAt.value,
      acceptedAt: acceptedAt.value,
    },
  };
}

/**
 * Normalizes the FULL RPC result, enforcing the row-count rule.
 *
 * The RPC always returns EXACTLY one row (it projects a single computed state).
 * This layer therefore treats:
 *
 *   0 rows -> MALFORMED  (a real read returns one; zero means schema drift)
 *   1 row  -> normalize it
 *   2+     -> MALFORMED, never "pick the first"
 *
 * Missing and multiple rows both fail closed rather than being guessed at: the
 * server layer maps either to "unavailable", which the page renders as a generic
 * retry-safe notice — never as NONE.
 */
export function normalizeOwnerStatusResult(rows: unknown): OwnerStatusNormalization {
  if (!Array.isArray(rows)) {
    return { status: "malformed", reason: "owner status result was not an array" };
  }
  if (rows.length !== 1) {
    return { status: "malformed", reason: `owner status result returned ${rows.length} rows; expected exactly 1` };
  }
  return normalizeOwnerStatusRow(rows[0]);
}

// ============================================================================
// Presentation — pure view-model for the Retailer detail owner card
// ============================================================================

/** The primary action a state offers, or null when it offers none. */
export type OwnerStatusAction = { label: string };

/** The heading and primary action for one owner state. */
export type OwnerStatusView = {
  heading: string;
  action: OwnerStatusAction | null;
};

/**
 * The heading and primary-action label for each state. ACTIVE offers NO action in
 * this milestone — no Invite, Retry, Resend, Replace, Revoke, or Delete.
 */
const OWNER_STATUS_VIEWS: Record<RetailerOwnerState, OwnerStatusView> = {
  NONE: { heading: "No Retailer Owner", action: { label: "Invite Retailer Owner" } },
  DELIVERY_FAILED: { heading: "Invitation not sent", action: { label: "Retry invitation" } },
  PENDING: { heading: "Invitation pending", action: { label: "Resend invitation" } },
  EXPIRED: { heading: "Invitation expired", action: { label: "Send new invitation" } },
  ACTIVE: { heading: "Retailer Owner active", action: null },
};

export function buildOwnerStatusView(state: RetailerOwnerState): OwnerStatusView {
  return OWNER_STATUS_VIEWS[state];
}

// ============================================================================
// Display formatting — deterministic, host-independent, hydration-safe
// ============================================================================

/** Shown for a null or unparseable timestamp. Never "Invalid Date". */
export const DATE_NOT_AVAILABLE = "Not available";

/** Shown when an owner has no usable name on record. */
export const OWNER_NAME_FALLBACK = "Retailer Owner";

/**
 * Fixed locale AND fixed time zone, so the rendered string depends on neither the
 * host machine's locale nor its TZ, and server and client produce byte-identical
 * output — no hydration mismatch. UTC is explicit because a Server Component has
 * no access to the reader's zone; guessing would be worse than being clear. Mirrors
 * lib/audit/vendor-audit-logs.ts.
 */
const OWNER_DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Renders a stored timestamp deterministically, or the safe floor. The value was
 * already validated parseable by normalization; this is defensive anyway, because
 * Date yields NaN rather than throwing and "Invalid Date" must never appear.
 */
export function formatOwnerTimestamp(value: string | null): string {
  if (value === null) return DATE_NOT_AVAILABLE;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return DATE_NOT_AVAILABLE;
  return `${OWNER_DATE_FORMATTER.format(date)} UTC`;
}

/**
 * The owner's display name: first + last when both exist, whichever exists when
 * only one does, and the safe fallback when neither does. A real active owner must
 * never render as blank for want of a name.
 */
export function formatOwnerDisplayName(
  firstName: string | null,
  lastName: string | null,
): string {
  const parts = [firstName, lastName]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(" ") : OWNER_NAME_FALLBACK;
}

// ============================================================================
// Invitation form model — pure, for the direct invitation route
// ============================================================================

/** How the invitation form behaves for the current owner state. */
export type InviteFormMode = "new" | "retry" | "resend" | "replace";

/**
 * Everything the invitation form needs, derived from the owner state. `lockedEmail`
 * is non-null only for retry/resend, where the recipient must not change — the
 * email is the RPC's own value, and the Server Action re-derives it regardless of
 * what the browser submits.
 */
export type InviteFormModel = {
  mode: InviteFormMode;
  /** When non-null, the email is fixed to this recipient and not editable. */
  lockedEmail: string | null;
  submitLabel: string;
  pendingLabel: string;
  initialFirstName: string;
  initialLastName: string;
  initialEmail: string;
  /** Prior recipient shown as read-only context (EXPIRED only). */
  previousRecipient: { name: string; email: string | null } | null;
};

/**
 * Builds the form model for a non-ACTIVE state. ACTIVE is handled by the page,
 * which renders no form at all, so it is intentionally not a case here.
 */
export function buildInviteFormModel(
  status: VendorRetailerOwnerStatus,
): InviteFormModel {
  const firstName = status.firstName ?? "";
  const lastName = status.lastName ?? "";
  const email = status.email ?? "";

  switch (status.state) {
    case "DELIVERY_FAILED":
      return {
        mode: "retry",
        lockedEmail: status.email,
        submitLabel: "Retry invitation",
        pendingLabel: "Retrying invitation…",
        initialFirstName: firstName,
        initialLastName: lastName,
        initialEmail: email,
        previousRecipient: null,
      };
    case "PENDING":
      return {
        mode: "resend",
        lockedEmail: status.email,
        submitLabel: "Resend invitation",
        pendingLabel: "Resending invitation…",
        initialFirstName: firstName,
        initialLastName: lastName,
        initialEmail: email,
        previousRecipient: null,
      };
    case "EXPIRED":
      return {
        mode: "replace",
        lockedEmail: null,
        submitLabel: "Send new invitation",
        pendingLabel: "Sending invitation…",
        initialFirstName: firstName,
        initialLastName: lastName,
        initialEmail: email,
        previousRecipient: {
          name: formatOwnerDisplayName(status.firstName, status.lastName),
          email: status.email,
        },
      };
    case "NONE":
    default:
      return {
        mode: "new",
        lockedEmail: null,
        submitLabel: "Send invitation",
        pendingLabel: "Sending invitation…",
        initialFirstName: "",
        initialLastName: "",
        initialEmail: "",
        previousRecipient: null,
      };
  }
}

// ============================================================================
// Submit planning — pure, for the Server Action's tamper/concurrency guard
// ============================================================================

/**
 * The decision the Server Action carries out AFTER re-resolving the owner status
 * immediately before dispatch. It is derived ONLY from the authoritative server
 * state and the RPC's own email — never from a hidden form field or the submitted
 * email — which is what makes the recipient un-tamperable on a resend/retry.
 */
export type InvitationSubmitPlan =
  /** ACTIVE owner already exists: refuse. */
  | { kind: "blocked-active" }
  /** A resend/retry state whose recipient email is missing: fail closed. */
  | { kind: "state-unavailable" }
  /** Resend/retry: dispatch to THIS email, ignoring anything the browser sent. */
  | { kind: "resend"; email: string }
  /** New/replacement: dispatch to the admin's submitted email. */
  | { kind: "new" };

/**
 * Plans a submit from the current authoritative state.
 *
 * PENDING and DELIVERY_FAILED force the RPC-provided recipient — the submitted
 * email is discarded, so a browser cannot substitute a different address for a
 * resend. ACTIVE refuses. NONE and EXPIRED accept the submitted email, because
 * those are the states in which a new (possibly different) recipient is valid.
 */
export function planInvitationSubmit(
  state: RetailerOwnerState,
  currentEmail: string | null,
): InvitationSubmitPlan {
  switch (state) {
    case "ACTIVE":
      return { kind: "blocked-active" };
    case "PENDING":
    case "DELIVERY_FAILED":
      if (typeof currentEmail === "string" && currentEmail.trim().length > 0) {
        return { kind: "resend", email: currentEmail.trim().toLowerCase() };
      }
      return { kind: "state-unavailable" };
    case "NONE":
    case "EXPIRED":
    default:
      return { kind: "new" };
  }
}

// ============================================================================
// Success feedback — pure, fixed vocabulary only (no arbitrary text)
// ============================================================================

/** The closed set of success codes carried in the redirect flag. */
export type OwnerInvitedCode = "sent" | "resent" | "new";

/** The one message per code. No other string can be shown. */
const OWNER_INVITED_MESSAGES: Record<OwnerInvitedCode, string> = {
  sent: "Retailer Owner invitation sent.",
  resent: "Retailer Owner invitation resent.",
  new: "New Retailer Owner invitation sent.",
};

/**
 * Maps a success flag from the URL to a fixed message, or null when the flag is
 * absent, repeated, or not one of the known codes. `hasOwnProperty` — not `in` —
 * so an inherited key like "constructor" cannot select a message. `"1"` maps to
 * the plain "sent" message for backward compatibility with the earlier flag.
 * Nothing arbitrary from the query string can ever be rendered.
 */
export function resolveOwnerInvitedMessage(
  flag: string | string[] | undefined,
): string | null {
  if (typeof flag !== "string") return null;
  if (flag === "1") return OWNER_INVITED_MESSAGES.sent;
  if (Object.prototype.hasOwnProperty.call(OWNER_INVITED_MESSAGES, flag)) {
    return OWNER_INVITED_MESSAGES[flag as OwnerInvitedCode];
  }
  return null;
}

/**
 * Chooses the success code from the state observed immediately before dispatch.
 *
 *   PENDING          -> "resent"  (a live invitation was re-sent)
 *   EXPIRED          -> "new"     (a fresh invitation replaced an expired one)
 *   NONE / DELIVERY_FAILED -> "sent"  (first invite, or retry after a failed delivery)
 *
 * Driven by the pre-dispatch state rather than the reservation's is_resend flag,
 * because a DELIVERY_FAILED retry reuses the same reservation row (is_resend would
 * say "resent") yet is, to the admin, simply the invitation finally being sent.
 * ACTIVE never reaches here — it is refused before dispatch.
 */
export function resolveOwnerInvitedCode(
  preDispatchState: RetailerOwnerState,
): OwnerInvitedCode {
  if (preDispatchState === "PENDING") return "resent";
  if (preDispatchState === "EXPIRED") return "new";
  return "sent";
}
