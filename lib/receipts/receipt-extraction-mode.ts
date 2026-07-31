/**
 * PURE MODULE — no imports, no I/O, no side effects.
 *
 * THE EDGE-RUNTIME GATE for fake receipt extraction, and the second of two independent
 * fail-closed switches.
 *
 * WHY TWO GATES
 *   Gate 1 is in the DATABASE: public.receipt_extraction_runtime.mode, seeded 'DISABLED'.
 *   Applying the Milestone A migrations to any project — including production — therefore
 *   leaves extraction off, and no function at any privilege level can turn it on; only a
 *   deliberate operator UPDATE can.
 *
 *   Gate 2 is HERE: the RECEIPT_EXTRACTION_MODE environment variable read by the Edge
 *   Functions. It is what stops a deployed function fabricating fixture values even if the
 *   database row were flipped.
 *
 *   One gate is not a boundary. request_receipt_extraction is granted to `authenticated`,
 *   so a client with a valid session reaches it through PostgREST whether or not any Edge
 *   Function is deployed — which is exactly why the database gate exists. And a database
 *   row is one UPDATE away from wrong — which is exactly why this one does too. Two
 *   independent blocks, matching the "no policy AND no privilege" posture every table in
 *   this schema already uses.
 *
 * FAIL CLOSED, BY EXACT LITERAL COMPARISON
 *   The comparison is `rawValue === "fake"` and nothing else. Absent, empty, "FAKE",
 *   "Fake", " fake", "fake ", "1", "true", "enabled", a number, an object — every one of
 *   them is disabled. This mirrors isStaffInvitationSendingEnabled in
 *   lib/staff/staff-invitation-delivery-contract.ts, which the shipped
 *   send-retailer-staff-invitation function already relies on for the same reason: a
 *   permissive parse of a feature flag is a feature that turns itself on by accident.
 *
 * A CLIENT CANNOT ENABLE FAKE MODE
 *   The only argument these functions are ever passed is `Deno.env.get(...)`. No request
 *   body field, query parameter, request header, JWT claim, role, permission, submission
 *   id, file hash, filename, MIME type or receipt metadata is read here or anywhere in the
 *   decision. receipt-extraction-safety.test.ts asserts the call sites.
 */

/** The exact and only value that enables fake extraction. Lower case, no whitespace. */
export const RECEIPT_EXTRACTION_MODE_FAKE = "fake" as const;

/** The environment variable name. Declared once so the safety test has a single anchor. */
export const RECEIPT_EXTRACTION_MODE_ENV = "RECEIPT_EXTRACTION_MODE" as const;

/** The environment variable naming a specific fixture. Integration/local use only. */
export const RECEIPT_EXTRACTION_FIXTURE_ENV = "RECEIPT_EXTRACTION_FIXTURE" as const;

/** The environment variable holding the fake's simulated pending period, in milliseconds. */
export const RECEIPT_EXTRACTION_FAKE_PENDING_MS_ENV = "RECEIPT_EXTRACTION_FAKE_PENDING_MS" as const;

/**
 * How long the fake reports PENDING before it will resolve, when unset.
 *
 * NON-ZERO ON PURPOSE. With a zero default the request function would claim, submit and
 * complete in one invocation, the PENDING branch would never execute, and the polling path
 * would be dead code until a genuinely asynchronous provider arrived — at which point it
 * would be discovered broken. A non-zero default makes the asynchronous shape the ONLY
 * path, exercised in every environment including CI.
 */
export const DEFAULT_FAKE_PENDING_MS = 1500;

/** The largest pending period the environment may request, so a typo cannot wedge a job. */
export const MAX_FAKE_PENDING_MS = 60_000;

/**
 * True only for the exact string "fake".
 *
 * `rawValue` is `unknown` rather than `string | undefined` deliberately: `Deno.env.get`
 * returns `string | undefined`, but typing the parameter loosely means no caller can
 * accidentally satisfy the signature by coercing something else first.
 */
export function isFakeExtractionEnabled(rawValue: unknown): boolean {
  return rawValue === RECEIPT_EXTRACTION_MODE_FAKE;
}

/**
 * Parses the configured pending period.
 *
 * Fails SAFE rather than closed here, and the distinction matters: an unparseable value
 * falls back to the default rather than disabling extraction, because this variable
 * controls timing and not authorization. Anything negative, non-integer, non-finite or
 * above the ceiling is ignored.
 */
export function resolveFakePendingMs(rawValue: unknown): number {
  if (typeof rawValue !== "string") return DEFAULT_FAKE_PENDING_MS;
  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_FAKE_PENDING_MS;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_FAKE_PENDING_MS) {
    return DEFAULT_FAKE_PENDING_MS;
  }
  return parsed;
}
