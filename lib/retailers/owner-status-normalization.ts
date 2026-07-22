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
 * The three approved, display-safe delivery-failure reasons stored by the database
 * (public.retailer_invitations.failure_code). They classify WHY a DELIVERY_FAILED
 * invitation did not complete:
 *
 *   EXISTING_ACCOUNT     the email already belongs to a Supabase Auth user; the
 *                        current new-user-only flow cannot invite it (NOT retryable).
 *   AUTH_DISPATCH_FAILED the Auth/email handoff failed before completing; may be
 *                        retryable to the same address.
 *   FINALIZATION_FAILED  Auth dispatch succeeded (or may have) but Retailer setup
 *                        did not finish; retrying inviteUserByEmail is not offered.
 *
 * These carry NO provider error, HTTP status, SMTP response, token, or id — they are
 * a fixed vocabulary the server maps failures onto, nothing more.
 */
export type RetailerOwnerFailureCode =
  | "EXISTING_ACCOUNT"
  | "AUTH_DISPATCH_FAILED"
  | "FINALIZATION_FAILED"
  /**
   * EXISTING-USER flow only: the application-owned invitation email (Resend) could
   * not be sent. Retryable — a resend rotates the token and tries again.
   */
  | "EXISTING_USER_EMAIL_FAILED";

/** The set form, exported so the server-only recorder shares one vocabulary. */
export const RETAILER_OWNER_FAILURE_CODES: readonly RetailerOwnerFailureCode[] = [
  "EXISTING_ACCOUNT",
  "AUTH_DISPATCH_FAILED",
  "FINALIZATION_FAILED",
  "EXISTING_USER_EMAIL_FAILED",
];

/**
 * Which invitation flow a row belongs to, from public.retailer_invitations
 * .invitation_kind. NEW_USER: the original inviteUserByEmail flow. EXISTING_USER:
 * the application-owned-token flow for an address that already has an Auth account.
 * Null for NONE and the profile-only ACTIVE fallback (no invitation row).
 */
export type RetailerOwnerInvitationKind = "NEW_USER" | "EXISTING_USER";

const OWNER_INVITATION_KINDS: readonly RetailerOwnerInvitationKind[] = [
  "NEW_USER",
  "EXISTING_USER",
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
  /**
   * The delivery-failure classification, non-null ONLY on DELIVERY_FAILED (and even
   * there, null for a historical/unclassified failure). The database guarantees this
   * and the normalizer re-checks it — a code on any other state fails closed.
   */
  failureCode: RetailerOwnerFailureCode | null;
  /**
   * Which flow this invitation belongs to. Null for NONE and the profile-only
   * ACTIVE fallback (no invitation row backs the state).
   */
  invitationKind: RetailerOwnerInvitationKind | null;
};

/**
 * Whether a DELIVERY_FAILED classification permits a locked-email retry through the
 * existing secure dispatch path. A null (historical/unclassified) failure and an
 * AUTH_DISPATCH_FAILED are retryable; EXISTING_ACCOUNT and FINALIZATION_FAILED are
 * terminal for this milestone and offer no retry.
 *
 * THE single source of truth for retryability, shared by the detail card, the
 * invite route, and the Server Action so none can disagree.
 */
export function isDeliveryFailureRetryable(
  failureCode: RetailerOwnerFailureCode | null,
): boolean {
  return failureCode === null || failureCode === "AUTH_DISPATCH_FAILED";
}

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

  // failure_code: null, or exactly one of the three approved codes. An unknown
  // value fails closed rather than reaching a `switch` with no matching branch.
  const rawFailure = row.failure_code;
  let failureCode: RetailerOwnerFailureCode | null;
  if (rawFailure === null || rawFailure === undefined) {
    failureCode = null;
  } else if (
    typeof rawFailure === "string" &&
    RETAILER_OWNER_FAILURE_CODES.includes(rawFailure as RetailerOwnerFailureCode)
  ) {
    failureCode = rawFailure as RetailerOwnerFailureCode;
  } else {
    return { status: "malformed", reason: "failure_code present but not an approved value" };
  }

  // A classification belongs ONLY to DELIVERY_FAILED. On NONE, PENDING, EXPIRED, or
  // ACTIVE it is a contradiction, so fail closed rather than render an actionable
  // failure onto a settled or successful state.
  if (failureCode !== null && state !== "DELIVERY_FAILED") {
    return { status: "malformed", reason: "failure_code present on a non-DELIVERY_FAILED state" };
  }

  // invitation_kind: null, or exactly one of the two approved kinds. Unknown fails
  // closed. Null is only valid where no invitation row backs the state — NONE, and
  // the profile-only ACTIVE fallback — so a null kind on any other state is drift.
  const rawKind = row.invitation_kind;
  let invitationKind: RetailerOwnerInvitationKind | null;
  if (rawKind === null || rawKind === undefined) {
    invitationKind = null;
  } else if (
    typeof rawKind === "string" &&
    OWNER_INVITATION_KINDS.includes(rawKind as RetailerOwnerInvitationKind)
  ) {
    invitationKind = rawKind as RetailerOwnerInvitationKind;
  } else {
    return { status: "malformed", reason: "invitation_kind present but not an approved value" };
  }

  // NONE never has an invitation, so it must not carry a kind.
  if (invitationKind !== null && state === "NONE") {
    return { status: "malformed", reason: "invitation_kind present on the NONE state" };
  }

  // EXISTING_USER_EMAIL_FAILED is an existing-user-flow code: it may appear ONLY on
  // a DELIVERY_FAILED row whose kind is EXISTING_USER. Any other pairing is drift.
  if (failureCode === "EXISTING_USER_EMAIL_FAILED" && invitationKind !== "EXISTING_USER") {
    return { status: "malformed", reason: "EXISTING_USER_EMAIL_FAILED on a non-EXISTING_USER invitation" };
  }

  // An ACTIONABLE DELIVERY_FAILED must carry a recipient email — every action
  // (new-user retry, existing-user conversion, existing-user resend) needs one.
  // Only FINALIZATION_FAILED is informational and needs no email.
  if (
    state === "DELIVERY_FAILED" &&
    failureCode !== "FINALIZATION_FAILED" &&
    email.value === null
  ) {
    return { status: "malformed", reason: "actionable DELIVERY_FAILED missing owner email" };
  }

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
      failureCode,
      invitationKind,
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

// ============================================================================
// Action classification — THE single source of truth for what a status offers
// ============================================================================

/**
 * The concrete action a status offers, and which flow carries it out. Derived only
 * from the authoritative status (state + kind + failure code + canonical email), so
 * the detail card, the invite route, and both Server Actions agree. Every `email`
 * is the RPC's own canonical value (lower/trimmed) — never a browser value.
 */
export type OwnerActionPlan =
  /** NONE / EXPIRED: an editable new-user invitation form. */
  | { kind: "invite-new" }
  /** NEW_USER PENDING: locked-email new-user resend. */
  | { kind: "resend-new"; email: string }
  /** NEW_USER DELIVERY_FAILED (null / AUTH_DISPATCH_FAILED): locked-email new-user retry. */
  | { kind: "retry-new"; email: string }
  /** NEW_USER DELIVERY_FAILED EXISTING_ACCOUNT: convert to and send an existing-user invitation. */
  | { kind: "send-existing"; email: string }
  /** EXISTING_USER PENDING: existing-user resend (rotates the token). */
  | { kind: "resend-existing"; email: string }
  /** EXISTING_USER DELIVERY_FAILED (null / EXISTING_USER_EMAIL_FAILED): existing-user retry. */
  | { kind: "retry-existing"; email: string }
  /** ACTIVE, FINALIZATION_FAILED, or any state offering no action. */
  | { kind: "none" };

function canonicalEmail(email: string | null): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Classifies the action a status offers. This is the ONLY place the (state, kind,
 * failureCode) combination is turned into an actionable decision.
 */
export function classifyOwnerAction(status: VendorRetailerOwnerStatus): OwnerActionPlan {
  const email = canonicalEmail(status.email);

  switch (status.state) {
    case "ACTIVE":
      return { kind: "none" };
    case "NONE":
    case "EXPIRED":
      return { kind: "invite-new" };
    case "PENDING":
      if (email === null) return { kind: "none" };
      return status.invitationKind === "EXISTING_USER"
        ? { kind: "resend-existing", email }
        : { kind: "resend-new", email };
    case "DELIVERY_FAILED":
    default:
      // FINALIZATION_FAILED is informational; anything without an email cannot act.
      if (status.failureCode === "FINALIZATION_FAILED" || email === null) {
        return { kind: "none" };
      }
      if (status.invitationKind === "EXISTING_USER") {
        // null or EXISTING_USER_EMAIL_FAILED -> retry the existing-user send.
        return { kind: "retry-existing", email };
      }
      // NEW_USER (or null kind, treated as new-user).
      if (status.failureCode === "EXISTING_ACCOUNT") {
        return { kind: "send-existing", email };
      }
      // null or AUTH_DISPATCH_FAILED.
      return { kind: "retry-new", email };
  }
}

/** Whether a plan KIND is carried out by the existing-user (token + Resend) flow. */
export function isExistingUserActionKind(
  kind: OwnerActionPlan["kind"],
): kind is "send-existing" | "resend-existing" | "retry-existing" {
  return (
    kind === "send-existing" || kind === "resend-existing" || kind === "retry-existing"
  );
}

/** The three existing-user plan variants — each carries a canonical `email`. */
export type ExistingUserActionPlan = Extract<
  OwnerActionPlan,
  { kind: "send-existing" | "resend-existing" | "retry-existing" }
>;

/**
 * Whether a PLAN is an existing-user action. Unlike isExistingUserActionKind (which
 * narrows only the kind string), this narrows the plan OBJECT, so callers can then
 * read `plan.email` — present on every existing-user variant — without a cast.
 */
export function isExistingUserActionPlan(
  plan: OwnerActionPlan,
): plan is ExistingUserActionPlan {
  return isExistingUserActionKind(plan.kind);
}

/** The primary action a state offers, or null when it offers none. */
export type OwnerStatusAction = { label: string };

/** The heading, safe description, and primary action for one owner status. */
export type OwnerStatusView = {
  heading: string;
  description: string;
  action: OwnerStatusAction | null;
};

/** The action-label for each plan kind. `none` carries a null action. */
const OWNER_ACTION_LABELS: Record<Exclude<OwnerActionPlan["kind"], "none">, string> = {
  "invite-new": "Invite Retailer Owner",
  "resend-new": "Resend invitation",
  "retry-new": "Retry invitation",
  "send-existing": "Send existing-user invitation",
  "resend-existing": "Resend invitation",
  "retry-existing": "Retry invitation",
};

/**
 * The heading, safe description, and primary-action label for a status. Branches on
 * state, invitation kind, and failure classification. EXISTING_ACCOUNT is no longer
 * a dead end — it offers the existing-user invitation. FINALIZATION_FAILED and
 * ACTIVE offer no action. Every string here is authored in this codebase — never a
 * provider error, id, or database term.
 */
export function buildOwnerStatusView(status: VendorRetailerOwnerStatus): OwnerStatusView {
  const plan = classifyOwnerAction(status);
  const action =
    plan.kind === "none" ? null : { label: OWNER_ACTION_LABELS[plan.kind] };

  switch (status.state) {
    case "NONE":
      return {
        heading: "No Retailer Owner",
        description: "No owner has been invited for this Retailer yet.",
        action,
      };
    case "EXPIRED":
      return {
        heading: "Invitation expired",
        description: "The last invitation expired before it was accepted. You can send a new one.",
        action,
      };
    case "ACTIVE":
      return {
        heading: "Retailer Owner active",
        description: "This Retailer has an active owner.",
        action: null,
      };
    case "PENDING":
      if (status.invitationKind === "EXISTING_USER") {
        return {
          heading: "Existing-user invitation sent",
          description:
            "An invitation was sent to an address that already has a SalesReward account. Resending sends a new link and refreshes the window; the previous link will no longer work.",
          action,
        };
      }
      return {
        heading: "Invitation pending",
        description: "An invitation is awaiting acceptance. Resending refreshes the invitation window.",
        action,
      };
    case "DELIVERY_FAILED":
    default:
      if (status.failureCode === "FINALIZATION_FAILED") {
        return {
          heading: "Owner setup incomplete",
          description:
            "The account setup did not finish. Retrying the email invitation is not available for this state.",
          action: null,
        };
      }
      if (status.invitationKind === "EXISTING_USER") {
        // null or EXISTING_USER_EMAIL_FAILED — the Resend email did not go out.
        return {
          heading: "Invitation email was not sent",
          description:
            "The existing-user invitation email could not be sent. You can retry — a new secure link is generated each time.",
          action,
        };
      }
      if (status.failureCode === "EXISTING_ACCOUNT") {
        return {
          heading: "This address already has a SalesReward account",
          description:
            "The new-user invitation can't be used for an address that already has an account. Send an existing-user invitation instead — they sign in and accept.",
          action,
        };
      }
      // NEW_USER, null or AUTH_DISPATCH_FAILED.
      return {
        heading: "Invitation not sent",
        description: "The invitation could not be sent. You can retry it to the same email address.",
        action,
      };
  }
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
  /** DELIVERY_FAILED + EXISTING_ACCOUNT: terminal for this flow, refuse. */
  | { kind: "blocked-existing-account" }
  /** DELIVERY_FAILED + FINALIZATION_FAILED: terminal for this flow, refuse. */
  | { kind: "blocked-finalization" }
  /** A resend/retry state whose recipient email is missing: fail closed. */
  | { kind: "state-unavailable" }
  /** Resend/retry: dispatch to THIS email, ignoring anything the browser sent. */
  | { kind: "resend"; email: string }
  /** New/replacement: dispatch to the admin's submitted email. */
  | { kind: "new" };

/**
 * Plans a submit from the current authoritative state AND failure classification.
 *
 * PENDING and a RETRYABLE DELIVERY_FAILED force the RPC-provided recipient — the
 * submitted email is discarded, so a browser cannot substitute a different address.
 * ACTIVE and the two terminal DELIVERY_FAILED classifications (EXISTING_ACCOUNT,
 * FINALIZATION_FAILED) refuse outright — no inviteUserByEmail is attempted for them.
 * NONE and EXPIRED accept the submitted email, the states where a new (possibly
 * different) recipient is valid.
 */
export function planInvitationSubmit(
  state: RetailerOwnerState,
  failureCode: RetailerOwnerFailureCode | null,
  currentEmail: string | null,
): InvitationSubmitPlan {
  switch (state) {
    case "ACTIVE":
      return { kind: "blocked-active" };
    case "DELIVERY_FAILED":
      if (failureCode === "EXISTING_ACCOUNT") return { kind: "blocked-existing-account" };
      if (failureCode === "FINALIZATION_FAILED") return { kind: "blocked-finalization" };
      // Retryable (null or AUTH_DISPATCH_FAILED): use the RPC's own email only.
      if (typeof currentEmail === "string" && currentEmail.trim().length > 0) {
        return { kind: "resend", email: currentEmail.trim().toLowerCase() };
      }
      return { kind: "state-unavailable" };
    case "PENDING":
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
