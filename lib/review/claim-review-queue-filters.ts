/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * Parses the Claim Reviewer queue's query string into the exact shapes
 * public.list_claim_review_queue and public.count_claim_review_queue expect, and
 * builds the URLs that carry them.
 *
 * Pure so it can be unit-tested directly, and so the same code produces the links
 * the page renders and reads the parameters the page receives — a link that cannot
 * be parsed by its own reader is a bug this shape makes impossible.
 *
 * ============================================================================
 * WHAT THE QUERY STRING MAY AND MAY NOT SAY
 * ============================================================================
 * It may narrow: a Retailer, a shop, a submitted-date range, and a page cursor.
 *
 * It may NOT widen. There is deliberately no `vendor` parameter and no code here
 * that could produce one — the database derives the Vendor from auth.uid(), and a
 * caller who invents `?vendor=…` is simply ignored. A supplied Retailer or shop that
 * belongs to someone else is not rejected either; it is passed through and matches
 * nothing, because the RPC has already constrained the candidate set to this
 * reviewer's Vendor. Refusing it would be an existence oracle; matching nothing is
 * the truth.
 *
 * ============================================================================
 * DATE-BOUNDARY SEMANTICS — both bounds INCLUSIVE
 * ============================================================================
 * The RPC compares `submitted_at >= p_submitted_from` and
 * `submitted_at <= p_submitted_to`, so both ends are inclusive.
 *
 * The form submits plain dates (`YYYY-MM-DD`). A bare date parsed as a timestamp is
 * midnight, so an inclusive "to" of `2026-08-02` would otherwise exclude everything
 * that happened during 2 August. `submittedTo` is therefore widened to the LAST
 * instant of that day, and `submittedFrom` to the first. Both are anchored in UTC,
 * matching `submitted_at`'s storage and the UTC formatting used throughout the
 * portal — a reviewer filtering "2 August" gets the whole of 2 August UTC.
 */

/** The four filters, in the shape the RPC parameters take. */
export type ClaimReviewQueueFilterValues = {
  retailerId: string | null;
  shopId: string | null;
  /** ISO instant, start of the chosen day (UTC). */
  submittedFrom: string | null;
  /** ISO instant, END of the chosen day (UTC) — inclusive. */
  submittedTo: string | null;
};

/** The raw date strings the form fields display, before widening. */
export type ClaimReviewQueueFilterInputs = {
  retailerId: string | null;
  shopId: string | null;
  /** `YYYY-MM-DD` or null — what the date input shows. */
  submittedFromDate: string | null;
  submittedToDate: string | null;
};

export type ClaimReviewQueueCursorValues = {
  submittedAt: string;
  receiptSubmissionId: string;
} | null;

export type ParsedClaimReviewQueueParams = {
  filters: ClaimReviewQueueFilterValues;
  inputs: ClaimReviewQueueFilterInputs;
  cursor: ClaimReviewQueueCursorValues;
  /** True when any filter narrows the queue — drives the filtered empty state. */
  hasActiveFilters: boolean;
  /**
   * True when a cursor was supplied but unusable. The page resets to the first page
   * and says so, rather than passing a half-pair to the RPC (which raises 22023) or
   * silently dropping rows.
   */
  cursorWasReset: boolean;
};

/** The query-string keys this page understands. Nothing else is read. */
export const QUEUE_PARAM = {
  retailer: "retailer",
  shop: "shop",
  submittedFrom: "submittedFrom",
  submittedTo: "submittedTo",
  cursorSubmittedAt: "cursorSubmittedAt",
  cursorReceiptId: "cursorReceiptId",
} as const;

/** A repeated parameter arrives as an array; only a single string is meaningful. */
function single(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A UUID-shaped value, or null.
 *
 * Shape-checked rather than existence-checked. A malformed value would make
 * PostgREST reject the whole call with a type error, so it is dropped here and the
 * filter simply does not apply — the page still renders.
 */
function uuid(value: string | string[] | undefined): string | null {
  const raw = single(value);
  return raw !== null && UUID_RE.test(raw) ? raw : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date that really exists, or null. Rejects 2026-02-31 and 2026-13-01. */
function calendarDate(value: string | string[] | undefined): string | null {
  const raw = single(value);
  if (raw === null || !DATE_RE.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip check: Date rolls 2026-02-31 forward to 2026-03-03 rather than
  // failing, so the only reliable test is whether it comes back unchanged.
  return parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

/** Start of the given UTC day. */
function startOfDayUtc(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/** End of the given UTC day — inclusive upper bound. */
function endOfDayUtc(date: string): string {
  return `${date}T23:59:59.999Z`;
}

/**
 * An ISO instant, or null. Used only for the cursor, whose value this page
 * generated itself from a previous RPC response.
 */
function isoInstant(value: string | string[] | undefined): string | null {
  const raw = single(value);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : raw;
}

/**
 * Parses the whole query string.
 *
 * The cursor is ALL-OR-NOTHING, mirroring the RPC's own contract: a half-supplied
 * pair is not passed through to raise `22023`, it resets to the first page with
 * `cursorWasReset` set so the page can say what happened. Silently ignoring one half
 * would skip or repeat rows without anyone noticing.
 */
export function parseClaimReviewQueueParams(
  params: Record<string, string | string[] | undefined>,
): ParsedClaimReviewQueueParams {
  const retailerId = uuid(params[QUEUE_PARAM.retailer]);
  const shopId = uuid(params[QUEUE_PARAM.shop]);
  const fromDate = calendarDate(params[QUEUE_PARAM.submittedFrom]);
  const toDate = calendarDate(params[QUEUE_PARAM.submittedTo]);

  const rawCursorAt = params[QUEUE_PARAM.cursorSubmittedAt];
  const rawCursorId = params[QUEUE_PARAM.cursorReceiptId];
  const cursorSuppliedAtAll =
    single(rawCursorAt) !== null || single(rawCursorId) !== null;

  const cursorAt = isoInstant(rawCursorAt);
  const cursorId = uuid(rawCursorId);
  const cursorUsable = cursorAt !== null && cursorId !== null;

  return {
    filters: {
      retailerId,
      shopId,
      submittedFrom: fromDate === null ? null : startOfDayUtc(fromDate),
      submittedTo: toDate === null ? null : endOfDayUtc(toDate),
    },
    inputs: {
      retailerId,
      shopId,
      submittedFromDate: fromDate,
      submittedToDate: toDate,
    },
    cursor: cursorUsable
      ? { submittedAt: cursorAt, receiptSubmissionId: cursorId }
      : null,
    hasActiveFilters:
      retailerId !== null ||
      shopId !== null ||
      fromDate !== null ||
      toDate !== null,
    cursorWasReset: cursorSuppliedAtAll && !cursorUsable,
  };
}

/**
 * Builds a queue URL carrying the given filters and (optionally) a cursor.
 *
 * The path is the fixed literal `/review` — never a value read from input — so there
 * is no caller-controlled destination and an open redirect is impossible. Only the
 * six known keys are ever written, so an unrecognized parameter a visitor invented
 * is dropped on the next navigation rather than propagated.
 */
export function buildClaimReviewQueueHref(
  inputs: ClaimReviewQueueFilterInputs,
  cursor: ClaimReviewQueueCursorValues = null,
): string {
  const search = new URLSearchParams();
  if (inputs.retailerId) search.set(QUEUE_PARAM.retailer, inputs.retailerId);
  if (inputs.shopId) search.set(QUEUE_PARAM.shop, inputs.shopId);
  if (inputs.submittedFromDate)
    search.set(QUEUE_PARAM.submittedFrom, inputs.submittedFromDate);
  if (inputs.submittedToDate)
    search.set(QUEUE_PARAM.submittedTo, inputs.submittedToDate);
  if (cursor) {
    search.set(QUEUE_PARAM.cursorSubmittedAt, cursor.submittedAt);
    search.set(QUEUE_PARAM.cursorReceiptId, cursor.receiptSubmissionId);
  }
  const qs = search.toString();
  return qs.length > 0 ? `/review?${qs}` : "/review";
}

/** Formats a byte count for display. Never throws, never returns NaN. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * A human word for the stored MIME type.
 *
 * `receipt_submissions_mime_type_allowed` permits exactly these three, so the
 * fallback is genuinely unreachable today — it exists so a future format widening
 * degrades to something readable instead of printing a raw content type.
 */
export function formatMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "JPEG image";
    case "image/png":
      return "PNG image";
    case "image/webp":
      return "WebP image";
    default:
      return "Image";
  }
}

/**
 * Formats an ISO instant for display, deterministically and in UTC.
 *
 * UTC, not local: a Server Component renders on the server, and a locale-dependent
 * or timezone-dependent string would differ between the server render and any later
 * client render of the same value. Matches the audit-log reader's formatting.
 */
export function formatSubmittedAt(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Unknown date";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-` +
    `${pad(parsed.getUTCDate())} ${pad(parsed.getUTCHours())}:` +
    `${pad(parsed.getUTCMinutes())} UTC`
  );
}
