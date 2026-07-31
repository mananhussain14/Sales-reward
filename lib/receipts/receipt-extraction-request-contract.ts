/**
 * PURE MODULE — no imports, no I/O, no environment, no side effects.
 *
 * THE REQUEST AND RESPONSE SHAPE all three receipt-extraction Edge Functions share.
 *
 * ONE ALLOWED KEY, AND THE ALLOWLIST IS THE VALIDATION. A body may carry `submission_id`
 * and nothing else. An unknown key is a 400, not an ignored extra — silently dropping a
 * field a caller believed they sent is how a client comes to depend on a parameter the
 * server never read, and it is the shape in which a fixture selector or a mode override
 * would arrive if one were ever smuggled in. This mirrors STAFF_INVITATION_REQUEST_FIELDS
 * in lib/staff/staff-invitation-delivery-contract.ts, which the shipped invitation
 * function already parses the same way.
 *
 * THERE IS NO PARAMETER FOR ANYTHING ELSE, EXHAUSTIVELY. No fixture key, no outcome, no
 * provider, no mode, no organization id, profile id, membership id, shop id, extraction
 * id, claim token, storage bucket, object path, file hash, entry mode, changed_fields or
 * duplicate signal. Every one of those is derived server-side, and the parser below is the
 * structural reason a client cannot supply one.
 *
 * A BYTE BOUND IS APPLIED BEFORE JSON.parse, so an oversized document is refused rather
 * than parsed. The raw text is never bound to a logged variable, never echoed, and never
 * placed in a response: a parse error can quote the body.
 */

/** The exact top-level keys a request body may carry. Anything else is refused. */
export const EXTRACTION_REQUEST_FIELDS = ["submission_id"] as const;

/**
 * The maximum request body size, in bytes.
 *
 * A body carrying one UUID needs about 60 bytes. 4 KiB is generous enough that no
 * legitimate caller trips it and small enough that nothing worth parsing is ever
 * assembled from an unauthenticated-adjacent request.
 */
export const MAX_EXTRACTION_REQUEST_BYTES = 4096;

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The closed response vocabulary. Nothing outside this list is ever returned.
 *
 * `denied` is reserved for a caller who is not an authorized Sales Staff member at all
 * (SQLSTATE 42501). EVERY unreadable receipt id — unknown, another person's, another
 * Retailer's, RESERVED, UPLOAD_FAILED — is `not-found`, and they are byte-identical to
 * each other. A distinguishable refusal would confirm that some other person's submission
 * exists, and a submission id is a uuid some other client legitimately holds.
 */
export const EXTRACTION_RESPONSE_STATUSES = [
  "ok",
  "invalid",
  "unauthenticated",
  "denied",
  "not-found",
  "unavailable",
] as const;
export type ExtractionResponseStatus = (typeof EXTRACTION_RESPONSE_STATUSES)[number];

/** The reasons an `invalid` response may carry. A fixed vocabulary; never a parse message. */
export const EXTRACTION_INVALID_REASONS = [
  "method-not-allowed",
  "malformed-body",
  "body-too-large",
  "unknown-field",
  "invalid-submission-id",
] as const;
export type ExtractionInvalidReason = (typeof EXTRACTION_INVALID_REASONS)[number];

export type ExtractionRequest = {
  /** Lower-cased so the value handed to PostgREST is canonical. */
  readonly submissionId: string;
};

export type ExtractionRequestParse =
  | { readonly status: "ok"; readonly request: ExtractionRequest }
  | { readonly status: "invalid"; readonly reason: ExtractionInvalidReason };

/**
 * Parses a raw request body into the one value these endpoints accept.
 *
 * Takes the raw TEXT rather than a parsed object so the byte bound can be applied before
 * JSON.parse runs, and so this function — not its caller — owns every rejection path.
 */
export function parseExtractionRequest(rawBody: unknown): ExtractionRequestParse {
  if (typeof rawBody !== "string") {
    return { status: "invalid", reason: "malformed-body" };
  }

  // Byte length, not character length: a multi-byte body must be measured as it is sent.
  if (byteLength(rawBody) > MAX_EXTRACTION_REQUEST_BYTES) {
    return { status: "invalid", reason: "body-too-large" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return { status: "invalid", reason: "malformed-body" };
  }

  // `null` is typeof "object", and an array is too. Both are refused explicitly: the root
  // must be a plain JSON object.
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return { status: "invalid", reason: "malformed-body" };
  }

  const record = decoded as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(EXTRACTION_REQUEST_FIELDS as readonly string[]).includes(key)) {
      // Refused, not ignored. See the module header.
      return { status: "invalid", reason: "unknown-field" };
    }
  }

  const submissionId = record.submission_id;

  if (typeof submissionId !== "string") {
    return { status: "invalid", reason: "invalid-submission-id" };
  }

  const trimmed = submissionId.trim();

  if (!UUID_SHAPE.test(trimmed)) {
    // A shape check only, so a malformed id becomes a clean `invalid` rather than a
    // PostgREST cast error (SQLSTATE 22P02) reported as `unavailable`. It is NOT an
    // authorization check: whether the receipt is the caller's own is decided by
    // assert_my_receipt_extraction_access, under the caller's token, and by nothing here.
    return { status: "invalid", reason: "invalid-submission-id" };
  }

  return { status: "ok", request: { submissionId: trimmed.toLowerCase() } };
}

/** UTF-8 byte length, computed without allocating an encoder in environments that lack one. */
function byteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  // Deno and modern Node both provide TextEncoder; this branch exists so the module has no
  // hard runtime dependency and stays testable in isolation.
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    if (code > 0xffff) index += 1;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
