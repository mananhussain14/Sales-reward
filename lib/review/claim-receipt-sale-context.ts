import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * Whether a receipt may become an authoritative sale, and on what evidence.
 *
 * SERVER-ONLY, matching @/lib/review/claim-review-detail and
 * @/lib/review/claim-receipt-qualification.
 *
 * ONE RPC: `get_claim_receipt_sale_context(p_submission_id)`. It takes the
 * receipt id and nothing else; the Vendor is resolved in SQL from auth.uid()
 * through the Phase 1B resolver. The ordinary authenticated client is used —
 * this module must never reach for service role, and `verified_sales`,
 * `receipt_confirmations` and `receipt_qualification_events` are revoked from
 * every browser role anyway.
 *
 * Missing, foreign, ineligible and unauthorized all return zero rows and become
 * the single `not-found`, exactly as the detail adapter does.
 *
 * ============================================================================
 * AN UNREADABLE ROW IS NOT A FINALIZABLE ONE
 * ============================================================================
 * Every vocabulary this row carries is validated, and anything unrecognised
 * fails CLOSED as `unavailable`. The alternative — passing an unknown
 * `time_status` through and letting the panel fall through to "finalize" — would
 * turn a parsing gap into an immutable financial record.
 */

/** The four classifications the database gives a shop-local sale time. */
export const SALE_TIME_STATUSES = [
  "OK",
  "AMBIGUOUS",
  "NONEXISTENT",
  "NO_TIMEZONE",
] as const;
export type SaleTimeStatus = (typeof SALE_TIME_STATUSES)[number];

export const SALE_TIME_PRECISIONS = ["DATE_ONLY", "MINUTE"] as const;
export type SaleTimePrecision = (typeof SALE_TIME_PRECISIONS)[number];

/** What the reviewer may currently be told before finalizing. */
export type ClaimReceiptSaleContext = {
  receiptSubmissionId: string;
  hasConfirmation: boolean;
  isQualificationExcluded: boolean;
  /** Only when excluded: TEST_DATA, NON_QUALIFYING or DUPLICATE. */
  exclusionReason: string | null;
  alreadyFinalized: boolean;

  /** The immutable Sales Staff proposal. All null when there is none. */
  transactionDate: string | null;
  transactionTime: string | null;
  currencyCode: string | null;
  totalMinor: number | null;
  subtotalMinor: number | null;
  taxTotalMinor: number | null;
  merchantName: string | null;
  documentNumber: string | null;
  entryMode: string | null;
  changedFields: string[];

  /** The time answer. `null` status means there was nothing to resolve. */
  timeStatus: SaleTimeStatus | null;
  timezoneName: string | null;
  saleTimePrecision: SaleTimePrecision | null;
  resolvedSaleAtPreview: string | null;
  firstSaleAtCandidate: string | null;
  secondSaleAtCandidate: string | null;
};

export type ClaimReceiptSaleContextResult =
  | { status: "authorized"; context: ClaimReceiptSaleContext }
  /** Missing, foreign, or this caller may not read it — indistinguishable. */
  | { status: "not-found" }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

/**
 * One row of the RPC, declared explicitly.
 *
 * These twenty-one columns are its entire output. There is no Vendor id,
 * Retailer id, shop id, profile id, confirmation id, decision id, exclusion event
 * id, bucket, path, hash, email or phone to receive — the function does not
 * return them, and this type could not carry them if it wanted to.
 */
type SaleContextRpcRow = {
  receipt_submission_id: string;
  has_confirmation: boolean | null;
  is_qualification_excluded: boolean | null;
  exclusion_reason: string | null;
  already_finalized: boolean | null;
  transaction_date: string | null;
  transaction_time: string | null;
  currency_code: string | null;
  total_minor: number | string | null;
  subtotal_minor: number | string | null;
  tax_total_minor: number | string | null;
  merchant_name: string | null;
  document_number: string | null;
  entry_mode: string | null;
  changed_fields: string[] | null;
  time_status: string | null;
  timezone_name: string | null;
  sale_time_precision: string | null;
  resolved_sale_at_preview: string | null;
  first_sale_at_candidate: string | null;
  second_sale_at_candidate: string | null;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** PostgREST returns bigint as a string; a silent NaN would render as blank. */
function optionalBigint(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isSaleTimeStatus(v: unknown): v is SaleTimeStatus {
  return (
    typeof v === "string" && (SALE_TIME_STATUSES as readonly string[]).includes(v)
  );
}

function isSaleTimePrecision(v: unknown): v is SaleTimePrecision {
  return (
    typeof v === "string" &&
    (SALE_TIME_PRECISIONS as readonly string[]).includes(v)
  );
}

/**
 * Maps one row, field by field. Deliberately NOT a spread: a column added to the
 * function later must be admitted here consciously before it can reach a page.
 *
 * Returns null — which the caller turns into `unavailable` — when a vocabulary is
 * unrecognised, so an unreadable row can never present as finalizable.
 */
function toSaleContext(
  row: SaleContextRpcRow,
  fallbackId: string,
): ClaimReceiptSaleContext | null {
  const hasConfirmation = row.has_confirmation === true;

  const rawStatus = optionalText(row.time_status);
  if (rawStatus !== null && !isSaleTimeStatus(rawStatus)) return null;

  const rawPrecision = optionalText(row.sale_time_precision);
  if (rawPrecision !== null && !isSaleTimePrecision(rawPrecision)) return null;

  // A confirmation with no time answer at all would leave the panel unable to say
  // anything true about the instant, so it is treated as unreadable rather than
  // rendered as a finalizable state.
  if (hasConfirmation && rawStatus === null) return null;

  return {
    receiptSubmissionId: optionalText(row.receipt_submission_id) ?? fallbackId,
    hasConfirmation,
    isQualificationExcluded: row.is_qualification_excluded === true,
    // Guarded on the excluded state rather than copied blindly, so a malformed
    // row cannot render a reason beside a "not excluded" heading.
    exclusionReason:
      row.is_qualification_excluded === true
        ? optionalText(row.exclusion_reason)
        : null,
    alreadyFinalized: row.already_finalized === true,

    transactionDate: hasConfirmation ? optionalText(row.transaction_date) : null,
    transactionTime: hasConfirmation ? optionalText(row.transaction_time) : null,
    currencyCode: hasConfirmation ? optionalText(row.currency_code) : null,
    totalMinor: hasConfirmation ? optionalBigint(row.total_minor) : null,
    subtotalMinor: hasConfirmation ? optionalBigint(row.subtotal_minor) : null,
    taxTotalMinor: hasConfirmation ? optionalBigint(row.tax_total_minor) : null,
    merchantName: hasConfirmation ? optionalText(row.merchant_name) : null,
    documentNumber: hasConfirmation ? optionalText(row.document_number) : null,
    entryMode: hasConfirmation ? optionalText(row.entry_mode) : null,
    changedFields: Array.isArray(row.changed_fields)
      ? row.changed_fields.filter((f): f is string => typeof f === "string")
      : [],

    timeStatus: rawStatus,
    timezoneName: optionalText(row.timezone_name),
    saleTimePrecision: rawPrecision,
    resolvedSaleAtPreview: optionalText(row.resolved_sale_at_preview),
    firstSaleAtCandidate: optionalText(row.first_sale_at_candidate),
    secondSaleAtCandidate: optionalText(row.second_sale_at_candidate),
  };
}

async function resolveClaimReceiptSaleContext(
  receiptSubmissionId: string,
): Promise<ClaimReceiptSaleContextResult> {
  const supabase = await createClient();

  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims?.sub) {
      return { status: "unauthenticated" };
    }
  } catch {
    // Not bound or logged: auth exceptions can carry token material.
    return { status: "unauthenticated" };
  }

  const result = await Promise.resolve(
    supabase.rpc("get_claim_receipt_sale_context", {
      p_submission_id: receiptSubmissionId,
    }),
  ).catch(() => null);

  // The error object is never bound, inspected or logged — a PostgREST error
  // names schemas, tables, columns and functions.
  if (result === null || result.error) {
    console.error("claim-receipt-sale-context: read failed");
    return { status: "unavailable" };
  }

  const rows = (result.data ?? []) as SaleContextRpcRow[];
  if (rows.length === 0) {
    return { status: "not-found" };
  }

  const context = toSaleContext(rows[0], receiptSubmissionId);
  if (context === null) {
    console.error("claim-receipt-sale-context: row was unusable");
    return { status: "unavailable" };
  }

  return { status: "authorized", context };
}

/**
 * Request-scoped React `cache` only — the page and any component beneath it pay
 * for one round trip. NOT a persistent cache and must never become one: this is
 * per-user, per-tenant data.
 */
export const getClaimReceiptSaleContext = cache(resolveClaimReceiptSaleContext);
