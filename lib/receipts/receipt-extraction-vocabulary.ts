/**
 * PURE MODULE — no imports, no I/O, no environment, no side effects.
 *
 * THE CLOSED VOCABULARIES of receipt extraction, stated once. Every literal the database,
 * the Edge Functions, the web and the Flutter client exchange lives here, so there is one
 * place to read to know the whole surface — and one place a reviewer can diff.
 *
 * WHY A SHARED MODULE RATHER THAN LITERALS AT EACH SITE. The same vocabularies are
 * enforced by CHECK constraints in migration 20260812210000 and consumed by three Deno
 * Edge Functions and the Next.js app. Restating them inline would create four definitions
 * free to drift, and the drift would surface as a constraint violation on a real receipt.
 * The SQL is the enforcement boundary; this module is what stops a caller reaching it with
 * a value it will refuse.
 *
 * THE TWO FAILURE VOCABULARIES ARE DELIBERATELY DIFFERENT SIZES. Ten codes are STORED; a
 * client is ever shown one of three. See CLIENT_EXTRACTION_FAILURE_CODES below for the
 * reasoning — collapsing an outage, a quota exhaustion, a dead worker and an unreadable
 * object into one code is not laziness, it is the removal of an availability oracle from
 * an endpoint any authenticated user can call.
 */

/* ---------------------------------------------------------------------------
 * Attempt lifecycle
 * ------------------------------------------------------------------------- */

/** The four extraction-attempt statuses. QUEUED and PROCESSING are the only open states. */
export const EXTRACTION_STATUSES = ["QUEUED", "PROCESSING", "SUCCEEDED", "FAILED"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

/** Open states. At most one attempt per submission may be in one of these at a time. */
export const OPEN_EXTRACTION_STATUSES = ["QUEUED", "PROCESSING"] as const;

/**
 * The maximum number of provider attempts per receipt submission.
 *
 * Enforced structurally by `check (attempt_number between 1 and 3)`: a fourth row cannot
 * be inserted at all, so this constant is a mirror of the constraint and never the
 * authority. EVERY persisted row consumes one attempt, whatever its status or failure
 * code — there is no second counter and no exempt failure.
 */
export const MAX_EXTRACTION_ATTEMPTS = 3;

/* ---------------------------------------------------------------------------
 * Runtime mode — the DATABASE gate
 * ------------------------------------------------------------------------- */

/**
 * public.receipt_extraction_runtime.mode.
 *
 * Seeded DISABLED, so applying these migrations to any project leaves extraction off. No
 * function at any privilege level writes this column; changing it is a deliberate operator
 * UPDATE. See receipt-extraction-mode.ts for the second, independent Edge gate.
 */
export const EXTRACTION_RUNTIME_MODES = ["DISABLED", "FAKE"] as const;
export type ExtractionRuntimeMode = (typeof EXTRACTION_RUNTIME_MODES)[number];

/* ---------------------------------------------------------------------------
 * Provider — locked to the fake in Milestone A
 * ------------------------------------------------------------------------- */

/**
 * The only provider name Milestone A admits.
 *
 * `check (provider is null or provider = 'FAKE')` in migration 20260812210000 makes "no
 * real provider was called" a DATABASE INVARIANT rather than a promise: a row naming any
 * other provider cannot exist. A later milestone widens that CHECK in its own migration,
 * which is a visible, reviewable act.
 */
export const FAKE_PROVIDER_NAME = "FAKE" as const;
export const FAKE_PROVIDER_MODEL = "fake-receipt-v1" as const;

/**
 * The prefix every fake operation identifier carries.
 *
 * Asserted by receipt-extraction-safety.test.ts and by the pgTAP worker suite, so a stored
 * operation id can always be proven to have come from the fake and never from a network
 * call. It is never returned to a client.
 */
export const FAKE_OPERATION_ID_PREFIX = "fake:" as const;

/** The database bound on provider_operation_id. */
export const MAX_PROVIDER_OPERATION_ID_LENGTH = 200;

/* ---------------------------------------------------------------------------
 * Failure codes — STORED (ten)
 * ------------------------------------------------------------------------- */

/**
 * The ten failure codes public.receipt_extractions.failure_code admits.
 *
 * These are internal. None is ever returned to a client; get_my_receipt_extraction maps
 * them through CLIENT_EXTRACTION_FAILURE_CODES first.
 */
export const EXTRACTION_FAILURE_CODES = [
  /** The provider could not be reached. */
  "PROVIDER_UNAVAILABLE",
  /** The provider refused for billing/quota reasons — operationally distinct from an outage. */
  "PROVIDER_QUOTA_EXCEEDED",
  /** The provider accepted the job and did not answer in time. */
  "PROVIDER_TIMEOUT",
  /** The provider read the image and did not consider it a receipt. */
  "PROVIDER_REJECTED_DOCUMENT",
  /** The stored object could not be read — a pre-provider failure. */
  "OBJECT_UNREADABLE",
  /** The image format or dimensions are unusable. */
  "UNSUPPORTED_IMAGE",
  /** The provider answered and the answer could not be normalized. */
  "NORMALIZATION_FAILED",
  /** A claimed attempt whose worker never completed it. Written ONLY by the reaper. */
  "WORKER_ABANDONED",
  /** A queued attempt no worker ever claimed. Written ONLY by the reaper. */
  "NEVER_CLAIMED",
  /** Anything else. */
  "INTERNAL",
] as const;
export type ExtractionFailureCode = (typeof EXTRACTION_FAILURE_CODES)[number];

/**
 * Writable only by expire_stale_receipt_extraction_claims.
 *
 * record_receipt_extraction_failure refuses both, so a worker can never fabricate the
 * appearance of having been reaped — and a reaped row can always be trusted to mean the
 * deadline actually passed.
 */
export const REAPER_ONLY_FAILURE_CODES = ["WORKER_ABANDONED", "NEVER_CLAIMED"] as const;

/**
 * The single failure code permitted BEFORE the image reaches the provider.
 *
 * record_receipt_extraction_failure enforces the pairing: this code requires the stored
 * operation id to be NULL, and every other code requires it to be present. That makes the
 * recorded reason and the row's actual provider progress structurally consistent.
 */
export const PRE_PROVIDER_FAILURE_CODES = ["OBJECT_UNREADABLE"] as const;

/** The failure codes permitted only AFTER an operation id has been registered. */
export const POST_PROVIDER_FAILURE_CODES = [
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_QUOTA_EXCEEDED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_REJECTED_DOCUMENT",
  "UNSUPPORTED_IMAGE",
  "NORMALIZATION_FAILED",
  "INTERNAL",
] as const;

/* ---------------------------------------------------------------------------
 * Failure codes — CLIENT-VISIBLE (three)
 * ------------------------------------------------------------------------- */

/**
 * The only failure codes a client ever sees.
 *
 * WHY THREE AND NOT TEN. Two of the stored codes describe THE CALLER'S OWN FILE and are
 * actionable — retake the photo. The other eight describe OUR infrastructure and are not:
 * the action in every one of those cases is identical (retry, or type the values in), so a
 * finer distinction buys the caller nothing while telling them whether our provider is
 * healthy, whether we have exhausted a billing quota, and whether a storage read failed.
 * That is an availability oracle on an endpoint every Sales Staff member can call.
 */
export const CLIENT_EXTRACTION_FAILURE_CODES = [
  /** The provider read it and it is not a receipt. Actionable: retake the photo. */
  "IMAGE_NOT_A_RECEIPT",
  /** The image itself cannot be used. Actionable: retake the photo. */
  "IMAGE_UNUSABLE",
  /** Everything else. Not actionable beyond retry-or-type-it-in. */
  "EXTRACTION_UNAVAILABLE",
] as const;
export type ClientExtractionFailureCode = (typeof CLIENT_EXTRACTION_FAILURE_CODES)[number];

/**
 * The stored -> client mapping. Total over EXTRACTION_FAILURE_CODES.
 *
 * The same mapping is implemented in SQL inside get_my_receipt_extraction; the pgTAP suite
 * asserts the two agree for all ten inputs.
 */
export const CLIENT_FAILURE_CODE_BY_STORED: Readonly<
  Record<ExtractionFailureCode, ClientExtractionFailureCode>
> = {
  PROVIDER_REJECTED_DOCUMENT: "IMAGE_NOT_A_RECEIPT",
  UNSUPPORTED_IMAGE: "IMAGE_UNUSABLE",
  PROVIDER_UNAVAILABLE: "EXTRACTION_UNAVAILABLE",
  PROVIDER_QUOTA_EXCEEDED: "EXTRACTION_UNAVAILABLE",
  PROVIDER_TIMEOUT: "EXTRACTION_UNAVAILABLE",
  OBJECT_UNREADABLE: "EXTRACTION_UNAVAILABLE",
  NORMALIZATION_FAILED: "EXTRACTION_UNAVAILABLE",
  WORKER_ABANDONED: "EXTRACTION_UNAVAILABLE",
  NEVER_CLAIMED: "EXTRACTION_UNAVAILABLE",
  INTERNAL: "EXTRACTION_UNAVAILABLE",
};

/* ---------------------------------------------------------------------------
 * Warning codes
 * ------------------------------------------------------------------------- */

/**
 * Safe review hints attached to a SUCCEEDED extraction. Codes only — never values.
 *
 * SUBTOTAL_TAX_TOTAL_MISMATCH NEVER BLOCKS ANYTHING. Real receipts round their lines
 * independently of their total, so `subtotal + tax = total` is not a fact about receipts
 * and there is deliberately no CHECK constraint asserting it. The warning exists so a
 * reviewer's eye is drawn to the figure, and for no other purpose.
 */
export const EXTRACTION_WARNING_CODES = [
  "LOW_CONFIDENCE_TOTAL",
  "LOW_CONFIDENCE_DATE",
  "MISSING_MERCHANT_NAME",
  "MISSING_DOCUMENT_NUMBER",
  "MISSING_TRANSACTION_TIME",
  "SUBTOTAL_TAX_TOTAL_MISMATCH",
  /** An amount whose decimal separator could not be resolved. The value is NOT guessed. */
  "AMBIGUOUS_AMOUNT_FORMAT",
  /** The provider produced a negative amount. Refused; the field is left null. */
  "NEGATIVE_AMOUNT_REJECTED",
  "ZERO_TOTAL",
  "DATE_IN_FUTURE",
  "CURRENCY_INFERRED_FROM_DEFAULT",
  "MULTIPLE_TOTALS_FOUND",
] as const;
export type ExtractionWarningCode = (typeof EXTRACTION_WARNING_CODES)[number];

/* ---------------------------------------------------------------------------
 * Confirmation
 * ------------------------------------------------------------------------- */

/**
 * How a confirmation's values came to be. SERVER-DERIVED — there is no parameter for it.
 *
 *   MANUAL    no successful extraction existed.
 *   EXTRACTED a successful extraction existed and every compared value matched it.
 *   MIXED     a successful extraction existed and at least one compared value differs.
 */
export const CONFIRMATION_ENTRY_MODES = ["MANUAL", "EXTRACTED", "MIXED"] as const;
export type ConfirmationEntryMode = (typeof CONFIRMATION_ENTRY_MODES)[number];

/**
 * The eight comparable fields, and therefore the only values `changed_fields` may contain.
 *
 * Declared in sorted order because the derivation sorts: two identical confirmations must
 * produce byte-identical arrays.
 */
export const CONFIRMATION_COMPARABLE_FIELDS = [
  "currency_code",
  "document_number",
  "merchant_name",
  "subtotal_minor",
  "tax_total_minor",
  "total_minor",
  "transaction_date",
  "transaction_time",
] as const;
export type ConfirmationComparableField = (typeof CONFIRMATION_COMPARABLE_FIELDS)[number];

/* ---------------------------------------------------------------------------
 * RPC outcomes
 * ------------------------------------------------------------------------- */

/**
 * request_receipt_extraction outcomes.
 *
 * EXTRACTION_UNAVAILABLE is returned both when a gate is closed and when the
 * infrastructure is broken, and the client cannot tell which. That indistinguishability is
 * the point: the action is identical in both cases, and a client able to distinguish them
 * would be reading our configuration.
 */
export const EXTRACTION_REQUEST_OUTCOMES = [
  "ALREADY_CONFIRMED",
  "ACTIVE",
  "SUCCEEDED",
  "EXHAUSTED",
  "EXTRACTION_UNAVAILABLE",
  "QUEUED",
] as const;
export type ExtractionRequestOutcome = (typeof EXTRACTION_REQUEST_OUTCOMES)[number];

/** confirm_receipt_extraction outcomes. */
export const CONFIRMATION_OUTCOMES = [
  "CONFIRMED",
  "ALREADY_CONFIRMED",
  "EXTRACTION_IN_PROGRESS",
] as const;
export type ConfirmationOutcome = (typeof CONFIRMATION_OUTCOMES)[number];

/* ---------------------------------------------------------------------------
 * Currency minor unit — the scale contract
 * ------------------------------------------------------------------------- */

/**
 * The four minor units public.iso_currency_codes admits, and therefore the only values
 * `p_currency_minor_unit` may carry. ISO 4217 uses no others for a circulating currency.
 *
 * A CLIENT MUST NEVER ASSUME 2. EUR has two decimal places, JPY has none, KWD has three and
 * CLF has four, and the printed digits on a receipt mean different integers under each. The
 * authority is the database, reached through the lookup RPC below — this list exists to
 * validate a value, never to derive one.
 */
export const CURRENCY_MINOR_UNITS = [0, 2, 3, 4] as const;
export type CurrencyMinorUnit = (typeof CURRENCY_MINOR_UNITS)[number];

/** The authenticated RPC that resolves one ISO 4217 code to its official minor unit. */
export const CURRENCY_MINOR_UNIT_RPC = "get_receipt_currency_minor_unit" as const;

/**
 * The STABLE SQLSTATE `confirm_receipt_extraction` raises when the caller's stated
 * `p_currency_minor_unit` is NULL or is not the minor unit the confirmed currency has.
 *
 * WHY A CODE AND NOT A MESSAGE. It is the one refusal a client must act on programmatically
 * — re-resolve the scale and re-send — and it must be separable from every neighbouring
 * refusal without parsing English. Within that function 22023 is raised by this rule and
 * nothing else: an unsupported currency, an out-of-range amount, an out-of-range date and a
 * missing required value are all 23514, an unauthorized caller is 42501, an unknown or
 * foreign receipt is zero rows, and an in-flight attempt is an EXTRACTION_IN_PROGRESS row
 * rather than an error at all. The pgTAP suite pins every one of those separations.
 *
 * PostgREST maps SQLSTATE class 22 to HTTP 400 and carries the code in the response body,
 * so a client reads `error.code === "22023"`.
 */
export const CONFIRMATION_MINOR_UNIT_MISMATCH_SQLSTATE = "22023" as const;

/** Whether a value is one of the four minor units this system supports. */
export function isCurrencyMinorUnit(value: unknown): value is CurrencyMinorUnit {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (CURRENCY_MINOR_UNITS as readonly number[]).includes(value)
  );
}

/* ---------------------------------------------------------------------------
 * Monetary bounds — mirrored by CHECK constraints
 * ------------------------------------------------------------------------- */

/**
 * The upper bound on any stored minor-unit amount: 10^12.
 *
 * For a two-minor currency that is ten billion major units — far above any retail receipt,
 * comfortably inside bigint, and low enough that a barcode misread as an amount fails
 * loudly instead of being stored.
 */
export const MAX_MINOR_AMOUNT = 1_000_000_000_000;

/** Amounts are non-negative. A refund or credit note is out of scope for Milestone A. */
export const MIN_MINOR_AMOUNT = 0;

/** The maximum number of line items one extraction may record. */
export const MAX_LINE_ITEMS = 200;

/* ---------------------------------------------------------------------------
 * Text bounds — mirrored by CHECK constraints
 * ------------------------------------------------------------------------- */

/**
 * Every OCR-derived text column is bounded. No unlimited provider-derived text column
 * exists anywhere in Milestone A; the pgTAP suite walks information_schema and fails if
 * one appears.
 */
export const TEXT_BOUNDS = {
  merchant_name: 255,
  document_number: 100,
  line_item_description: 500,

  merchant_name_source_text: 500,
  document_number_source_text: 250,
  transaction_date_source_text: 100,
  transaction_time_source_text: 100,
  currency_code_source_text: 50,
  total_source_text: 100,
  subtotal_source_text: 100,
  tax_source_text: 100,

  line_item_description_source_text: 1000,
  line_item_quantity_source_text: 100,
  line_item_unit_price_source_text: 100,
  line_item_line_total_source_text: 100,
} as const;

/* ---------------------------------------------------------------------------
 * Membership helpers
 * ------------------------------------------------------------------------- */

function isMember(list: readonly string[], value: unknown): boolean {
  return typeof value === "string" && list.includes(value);
}

export function isExtractionStatus(value: unknown): value is ExtractionStatus {
  return isMember(EXTRACTION_STATUSES, value);
}

export function isExtractionRuntimeMode(value: unknown): value is ExtractionRuntimeMode {
  return isMember(EXTRACTION_RUNTIME_MODES, value);
}

export function isExtractionFailureCode(value: unknown): value is ExtractionFailureCode {
  return isMember(EXTRACTION_FAILURE_CODES, value);
}

export function isExtractionWarningCode(value: unknown): value is ExtractionWarningCode {
  return isMember(EXTRACTION_WARNING_CODES, value);
}

export function isConfirmationEntryMode(value: unknown): value is ConfirmationEntryMode {
  return isMember(CONFIRMATION_ENTRY_MODES, value);
}

export function isExtractionRequestOutcome(value: unknown): value is ExtractionRequestOutcome {
  return isMember(EXTRACTION_REQUEST_OUTCOMES, value);
}

export function isClientExtractionFailureCode(
  value: unknown,
): value is ClientExtractionFailureCode {
  return isMember(CLIENT_EXTRACTION_FAILURE_CODES, value);
}

/** Maps a stored failure code to the client vocabulary. Unknown input collapses safely. */
export function toClientFailureCode(value: unknown): ClientExtractionFailureCode | null {
  if (value === null || value === undefined) return null;
  if (!isExtractionFailureCode(value)) {
    // A code this build does not know about must not leak through as-is, and must not be
    // dropped either: an unrecognised failure is still a failure.
    return "EXTRACTION_UNAVAILABLE";
  }
  return CLIENT_FAILURE_CODE_BY_STORED[value];
}

/**
 * The factual unused capacity for a submission.
 *
 * NEVER used to communicate provider availability. A disabled gate, a dead provider and a
 * reaped claim all leave this value exactly as the persisted rows make it; `retry_allowed`
 * is the only field that carries availability.
 */
export function attemptsRemaining(attemptsUsed: number): number {
  return Math.max(0, MAX_EXTRACTION_ATTEMPTS - attemptsUsed);
}
