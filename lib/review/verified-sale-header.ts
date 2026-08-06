import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * The immutable authoritative sale header, once one exists.
 *
 * SERVER-ONLY. ONE RPC: `get_verified_sale_header(p_submission_id)`, which takes
 * the receipt id and nothing else and resolves the Vendor in SQL from auth.uid().
 *
 * Missing, foreign and unauthorized all return zero rows and become the single
 * `not-found`, so this cannot be used to discover which receipts have sales.
 *
 * The function returns no internal foreign key — no Vendor, Retailer, shop,
 * profile, confirmation or decision id — and no proposal actor identity. The
 * only person named is the reviewer who finalized it, by display name, which the
 * page already shows for the review decision.
 */

/** What the reviewer may be told about a finalized sale. */
export type VerifiedSaleHeader = {
  receiptSubmissionId: string;
  transactionDate: string | null;
  transactionTime: string | null;
  saleAt: string | null;
  timezoneName: string | null;
  saleTimePrecision: string | null;
  dstAmbiguityChoice: string | null;
  currencyCode: string | null;
  totalMinor: number | null;
  subtotalMinor: number | null;
  taxTotalMinor: number | null;
  merchantName: string | null;
  documentNumber: string | null;
  finalizedAt: string | null;
  finalizedByDisplayName: string | null;
};

export type VerifiedSaleHeaderResult =
  | { status: "authorized"; header: VerifiedSaleHeader }
  /** No sale, foreign, or unreadable by this caller — indistinguishable. */
  | { status: "not-found" }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

/**
 * One row of the RPC, declared explicitly.
 *
 * These fifteen columns are its entire output. There is no lineage id, bucket,
 * path, hash, email or phone to receive.
 */
type VerifiedSaleRpcRow = {
  receipt_submission_id: string;
  transaction_date: string | null;
  transaction_time: string | null;
  sale_at: string | null;
  timezone_name: string | null;
  sale_time_precision: string | null;
  dst_ambiguity_choice: string | null;
  currency_code: string | null;
  total_minor: number | string | null;
  subtotal_minor: number | string | null;
  tax_total_minor: number | string | null;
  merchant_name: string | null;
  document_number: string | null;
  finalized_at: string | null;
  finalized_by_display_name: string | null;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function optionalBigint(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Maps one row, field by field. Deliberately NOT a spread.
 *
 * A header with no resolved instant is unreadable rather than partially shown —
 * the instant is the whole point of the record.
 */
function toHeader(
  row: VerifiedSaleRpcRow,
  fallbackId: string,
): VerifiedSaleHeader | null {
  const saleAt = optionalText(row.sale_at);
  if (saleAt === null) return null;

  return {
    receiptSubmissionId: optionalText(row.receipt_submission_id) ?? fallbackId,
    transactionDate: optionalText(row.transaction_date),
    transactionTime: optionalText(row.transaction_time),
    saleAt,
    timezoneName: optionalText(row.timezone_name),
    saleTimePrecision: optionalText(row.sale_time_precision),
    dstAmbiguityChoice: optionalText(row.dst_ambiguity_choice),
    currencyCode: optionalText(row.currency_code),
    totalMinor: optionalBigint(row.total_minor),
    subtotalMinor: optionalBigint(row.subtotal_minor),
    taxTotalMinor: optionalBigint(row.tax_total_minor),
    merchantName: optionalText(row.merchant_name),
    documentNumber: optionalText(row.document_number),
    finalizedAt: optionalText(row.finalized_at),
    finalizedByDisplayName: optionalText(row.finalized_by_display_name),
  };
}

async function resolveVerifiedSaleHeader(
  receiptSubmissionId: string,
): Promise<VerifiedSaleHeaderResult> {
  const supabase = await createClient();

  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims?.sub) {
      return { status: "unauthenticated" };
    }
  } catch {
    return { status: "unauthenticated" };
  }

  const result = await Promise.resolve(
    supabase.rpc("get_verified_sale_header", {
      p_submission_id: receiptSubmissionId,
    }),
  ).catch(() => null);

  if (result === null || result.error) {
    console.error("verified-sale-header: read failed");
    return { status: "unavailable" };
  }

  const rows = (result.data ?? []) as VerifiedSaleRpcRow[];
  if (rows.length === 0) {
    return { status: "not-found" };
  }

  const header = toHeader(rows[0], receiptSubmissionId);
  if (header === null) {
    console.error("verified-sale-header: row was unusable");
    return { status: "unavailable" };
  }

  return { status: "authorized", header };
}

/** Request-scoped React `cache` only. Never a persistent, cross-user cache. */
export const getVerifiedSaleHeader = cache(resolveVerifiedSaleHeader);
