/**
 * PURE MODULE — no imports, no I/O, no Supabase client, no `next/*`.
 *
 * Normalizes and validates one qualification classification before it reaches
 * `public.record_claim_receipt_qualification`.
 *
 * Every rule below is ALREADY enforced inside the RPC, which raises
 * `invalid_parameter_value` on each one, and again by the table's CHECK
 * constraints beneath that. This module exists so a reviewer gets a field-level
 * message instead of a generic failure. It is a better error experience layered
 * over the real check, never a replacement — nothing here can widen what the
 * database accepts.
 *
 * Transcribed from the deployed function body rather than from a brief, so the
 * copy cannot drift from what actually runs.
 */

export const QUALIFICATION_ACTIONS = ["EXCLUDE", "REINSTATE"] as const;
export type QualificationAction = (typeof QUALIFICATION_ACTIONS)[number];

/**
 * The three approved reasons, in the order the form presents them: the two
 * self-describing ones first, the one that needs an argument last.
 */
export const EXCLUSION_REASONS = [
  "TEST_DATA",
  "NON_QUALIFYING",
  "DUPLICATE",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const QUALIFICATION_NOTE_MAX_LENGTH = 500;

/**
 * The one reason whose note is MANDATORY.
 *
 * NON_QUALIFYING asserts a judgement the image alone cannot evidence — "this is
 * real but does not count" — so the reasoning has to be written down. TEST_DATA
 * and DUPLICATE describe what the record IS, which the receipt already shows.
 */
export const REASONS_REQUIRING_NOTE: readonly ExclusionReason[] = [
  "NON_QUALIFYING",
];

export const EXCLUSION_REASON_LABELS: Record<ExclusionReason, string> = {
  TEST_DATA: "Test data",
  NON_QUALIFYING: "Non-qualifying",
  DUPLICATE: "Duplicate",
};

/** Shown under each option so a reviewer picks by meaning, not by guess. */
export const EXCLUSION_REASON_HINTS: Record<ExclusionReason, string> = {
  TEST_DATA:
    "Not a real customer purchase — a development, demo or placeholder image.",
  NON_QUALIFYING:
    "A real receipt that should not count toward any campaign. Explain why.",
  DUPLICATE: "The same purchase has already been submitted.",
};

export function isQualificationAction(v: unknown): v is QualificationAction {
  return (
    typeof v === "string" &&
    (QUALIFICATION_ACTIONS as readonly string[]).includes(v)
  );
}

export function isExclusionReason(v: unknown): v is ExclusionReason {
  return (
    typeof v === "string" && (EXCLUSION_REASONS as readonly string[]).includes(v)
  );
}

export function reasonRequiresNote(reason: ExclusionReason | null): boolean {
  return reason !== null && REASONS_REQUIRING_NOTE.includes(reason);
}

export type QualificationFieldErrors = {
  action?: string;
  exclusionReason?: string;
  reviewerNote?: string;
};

/** Exactly the three values the RPC takes, beyond the receipt id. */
export type NormalizedQualification = {
  action: QualificationAction;
  /** null for REINSTATE — the RPC rejects a reason on a reinstatement. */
  exclusionReason: ExclusionReason | null;
  /** Trimmed, or null. Never an empty string. */
  reviewerNote: string | null;
};

export type QualificationValidationResult =
  | { ok: true; value: NormalizedQualification }
  | { ok: false; fieldErrors: QualificationFieldErrors };

/**
 * A single string from a form, trimmed, or null when absent or blank.
 *
 * A repeated field arrives as an array and a file as an object; neither is a
 * meaningful input, so both become null rather than being coerced into a string
 * that might accidentally match something.
 */
function single(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validates one submitted classification.
 *
 * Returns EVERY field error at once rather than stopping at the first, so a
 * reviewer who picked a reason and forgot the note is not told about one
 * problem, fixes it, and then discovers the other.
 *
 * The note is validated after trimming, matching the RPC's
 * `nullif(btrim(...), '')` exactly.
 */
export function validateQualificationInput(raw: {
  action?: unknown;
  exclusionReason?: unknown;
  reviewerNote?: unknown;
}): QualificationValidationResult {
  const fieldErrors: QualificationFieldErrors = {};

  const actionRaw = single(raw.action);
  const action = isQualificationAction(actionRaw) ? actionRaw : null;
  if (action === null) {
    fieldErrors.action = "Choose whether to exclude or reinstate this receipt.";
  }

  // Read the reason for BOTH actions. A reinstatement carrying one is an error
  // the reviewer should see, not something to silently discard.
  const reasonRaw = single(raw.exclusionReason);
  let exclusionReason: ExclusionReason | null = null;

  if (action === "REINSTATE") {
    if (reasonRaw !== null) {
      fieldErrors.exclusionReason =
        "A reinstatement cannot carry an exclusion reason.";
    }
  } else if (action === "EXCLUDE") {
    if (reasonRaw === null) {
      fieldErrors.exclusionReason = "Choose a reason for excluding this receipt.";
    } else if (!isExclusionReason(reasonRaw)) {
      fieldErrors.exclusionReason = "That exclusion reason is not recognised.";
    } else {
      exclusionReason = reasonRaw;
    }
  }

  const noteRaw = single(raw.reviewerNote);
  let reviewerNote: string | null = noteRaw;
  if (noteRaw !== null && noteRaw.length > QUALIFICATION_NOTE_MAX_LENGTH) {
    fieldErrors.reviewerNote = `A note may be at most ${QUALIFICATION_NOTE_MAX_LENGTH} characters. This one is ${noteRaw.length}.`;
    reviewerNote = null;
  }

  // Only meaningful once the reason itself is valid; otherwise the reviewer
  // would be told to write a note for a reason that will not be accepted anyway.
  if (
    action === "EXCLUDE" &&
    exclusionReason !== null &&
    reasonRequiresNote(exclusionReason) &&
    reviewerNote === null &&
    fieldErrors.reviewerNote === undefined
  ) {
    fieldErrors.reviewerNote = `A note is required when the reason is “${EXCLUSION_REASON_LABELS[exclusionReason]}”.`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    value: {
      action: action as QualificationAction,
      exclusionReason,
      reviewerNote,
    },
  };
}
