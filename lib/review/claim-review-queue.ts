import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

/**
 * The Claim Reviewer receipt QUEUE — the read side of Phase 1C-B.
 *
 * SERVER-ONLY. The `server-only` import makes a client-side import a build error
 * rather than a runtime surprise, matching @/lib/review/claim-reviewer-access.
 *
 * ============================================================================
 * WHAT THIS READS, AND HOW
 * ============================================================================
 * Exactly three RPCs:
 *
 *   public.list_claim_review_queue(...)         the page of eligible receipts
 *   public.count_claim_review_queue(...)        the total behind that page
 *   public.list_claim_review_filter_options()   the Retailer/shop picker choices
 *
 * The first two shipped in migration 20260819090000, the third in 20260819210000 —
 * added because the queue function types its Retailer and shop filters as `uuid` but
 * returns only display names, so a picker had no values to offer.
 *
 * It NEVER queries public.receipt_submissions, public.receipt_review_decisions or
 * any other table directly. It could not: all of them have RLS enabled with zero
 * policies, so `authenticated` can read none of them. Every rule about who may see
 * which receipt lives in SQL, and this module only asks.
 *
 * NONE OF THE THREE TAKES A VENDOR. The database resolves the reviewer's Vendor from
 * auth.uid() through the Phase 1B resolver, so there is no organization id for this
 * module to hold, pass, or accidentally let a query string supply. That is the whole
 * tenant boundary, and it is not restated here — restating it in TypeScript would
 * create a second, weaker copy that could drift.
 *
 * The ordinary authenticated server client is used. service_role appears nowhere in
 * this module's graph, and the queue functions are revoked from it anyway.
 *
 * ============================================================================
 * WHAT NEVER CROSSES INTO THE BROWSER
 * ============================================================================
 * The RPC already withholds the storage bucket, object path and file hash — its
 * return type has no such columns. This module withholds more: it maps each row
 * field by field into `ClaimReviewQueueRow` rather than spreading the RPC result, so
 * a column added to the function later cannot silently reach a page. There is no
 * email, phone, profile id, membership id or organization id in the output; the only
 * identifier is the opaque receipt submission id the detail route will need.
 */

/**
 * One browser-safe queue row.
 *
 * Every field here is displayed. Nothing is carried "just in case", because a value
 * that is not needed cannot leak.
 */
export type ClaimReviewQueueRow = {
  /** The only identifier that crosses to the browser. Needed for deep-linking. */
  receiptSubmissionId: string;
  retailerName: string;
  shopName: string;
  /** Optional in the schema (`retailer_shops.code` is nullable). */
  shopCode: string | null;
  /** The shop's state TODAY. Context, not a filter — see D7. */
  shopStatus: string;
  submitterName: string;
  /** The submitter's membership state TODAY. Context, not a filter — see D7. */
  submitterStatus: string;
  /** ISO 8601 UTC, straight from the database. Formatted at the edge. */
  submittedAt: string;
  mimeType: string;
  fileSizeBytes: number;
  originalFileName: string;
  /** True when the same bytes were submitted more than once. A flag, never a hash. */
  hasDuplicateHash: boolean;
};

/**
 * The keyset cursor for the next page.
 *
 * Both halves or neither — that is the contract `list_claim_review_queue` enforces,
 * and it raises `22023` on a half-supplied pair rather than silently skipping rows.
 */
export type ClaimReviewQueueCursor = {
  submittedAt: string;
  receiptSubmissionId: string;
};

/**
 * The filters a caller may apply. All optional, all nullable.
 *
 * There is deliberately NO vendor field. Adding one would be the single most
 * dangerous change possible to this module.
 */
export type ClaimReviewQueueFilters = {
  retailerId: string | null;
  shopId: string | null;
  submittedFrom: string | null;
  submittedTo: string | null;
};

/**
 * One Retailer/shop pair the reviewer may filter by.
 *
 * THE ONLY PLACE tenant identifiers cross into the browser, and they are here for
 * one reason: `list_claim_review_queue` types its Retailer and shop parameters as
 * `uuid`, so a picker cannot work without the values it requires. They are used as
 * form values and compared against the query string — never rendered.
 *
 * What that discloses is nothing the reviewer cannot already read: these name
 * Retailers and shops whose receipts are sitting in their own queue. And the queue
 * re-derives the Vendor from auth.uid() on every call, so a forged or foreign id
 * matches zero rows rather than widening anything.
 */
export type ClaimReviewFilterOption = {
  retailerId: string;
  retailerName: string;
  shopId: string;
  shopName: string;
  shopCode: string | null;
  shopStatus: string;
};

export type ClaimReviewQueueResult =
  | {
      status: "authorized";
      /**
       * `[]` means nothing is waiting — a real, expected state.
       * `null` means the queue could not be read. NEVER render null as empty: an
       * outage that looks like an empty queue tells a reviewer their work is done
       * when it is not.
       */
      rows: ClaimReviewQueueRow[] | null;
      /** Total matching the same filters, or null when it could not be read. */
      totalCount: number | null;
      /** Present only when a further page exists. */
      nextCursor: ClaimReviewQueueCursor | null;
      /**
       * `[]` means the reviewer genuinely has no Retailer or shop to choose from —
       * which is the honest answer when nothing is pending.
       * `null` means the options could not be read. The pickers are then DISABLED
       * with retry copy rather than rendered empty, because an empty picker and a
       * broken picker look identical and only one of them is true.
       */
      filterOptions: ClaimReviewFilterOption[] | null;
    }
  | { status: "unauthenticated" }
  | { status: "unauthorized" }
  | { status: "unavailable" };

/** Page size. Fixed at 25 by decision D9; the RPC clamps anything out of range. */
export const CLAIM_REVIEW_PAGE_SIZE = 25;

/**
 * One row of `list_claim_review_queue`, declared explicitly.
 *
 * An untyped rpc() call yields `any` and would silently accept a shape change.
 * These twelve columns are the function's entire output.
 */
type QueueRpcRow = {
  receipt_submission_id: string;
  retailer_name: string | null;
  shop_name: string | null;
  shop_code: string | null;
  shop_status: string | null;
  submitter_name: string | null;
  submitter_status: string | null;
  submitted_at: string;
  mime_type: string | null;
  file_size_bytes: number | string | null;
  original_file_name: string | null;
  has_duplicate_hash: boolean | null;
};

/** One row of `list_claim_review_filter_options`, declared explicitly. */
type FilterOptionRpcRow = {
  retailer_organization_id: string;
  retailer_name: string | null;
  retailer_shop_id: string;
  shop_name: string | null;
  shop_code: string | null;
  shop_status: string | null;
};

/** A trimmed non-empty string, or the supplied fallback. Never returns null. */
function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

/** A trimmed non-empty string, or null. Used only where the schema allows null. */
function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * `bigint` arrives as a string from PostgREST once it exceeds 2^53, and as a number
 * below that. Both are accepted; anything else becomes 0 rather than NaN, because a
 * NaN would render as "NaN" in the size column.
 */
function byteCount(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Maps one RPC row, field by field.
 *
 * Deliberately NOT a spread. A column added to the function in a later milestone
 * must be added here consciously before it can reach a page.
 *
 * Returns null for a row with no usable id — such a row cannot be opened, and
 * rendering it would produce a dead link.
 */
function toQueueRow(row: QueueRpcRow): ClaimReviewQueueRow | null {
  const id = optionalText(row.receipt_submission_id);
  const submittedAt = optionalText(row.submitted_at);
  if (id === null || submittedAt === null) {
    return null;
  }

  return {
    receiptSubmissionId: id,
    // Defensive fallbacks: these come from NOT NULL columns joined on foreign keys,
    // so they cannot be null today. A blank cell would be a worse answer than a
    // neutral word if that ever changed.
    retailerName: text(row.retailer_name, "Unknown retailer"),
    shopName: text(row.shop_name, "Unknown shop"),
    shopCode: optionalText(row.shop_code),
    shopStatus: text(row.shop_status, "UNKNOWN"),
    submitterName: text(row.submitter_name, "Unknown staff member"),
    submitterStatus: text(row.submitter_status, "UNKNOWN"),
    submittedAt,
    mimeType: text(row.mime_type, "unknown"),
    fileSizeBytes: byteCount(row.file_size_bytes),
    originalFileName: text(row.original_file_name, "receipt"),
    hasDuplicateHash: row.has_duplicate_hash === true,
  };
}

/**
 * Maps one filter-option row, field by field. Never a spread, for the same reason
 * `toQueueRow` is not one: a column added later must be admitted consciously.
 *
 * Returns null when either id is unusable — an option that cannot be submitted as a
 * filter value is worse than no option, because selecting it would silently do
 * nothing.
 */
function toFilterOption(row: FilterOptionRpcRow): ClaimReviewFilterOption | null {
  const retailerId = optionalText(row.retailer_organization_id);
  const shopId = optionalText(row.retailer_shop_id);
  if (retailerId === null || shopId === null) {
    return null;
  }
  return {
    retailerId,
    retailerName: text(row.retailer_name, "Unknown retailer"),
    shopId,
    shopName: text(row.shop_name, "Unknown shop"),
    shopCode: optionalText(row.shop_code),
    shopStatus: text(row.shop_status, "UNKNOWN"),
  };
}

async function resolveClaimReviewQueue(
  filters: ClaimReviewQueueFilters,
  cursor: ClaimReviewQueueCursor | null,
): Promise<ClaimReviewQueueResult> {
  const supabase = await createClient();

  // ---------------------------------------------------------------------------
  // 1. Identity — verified with the Auth server, never read from a cookie alone.
  // ---------------------------------------------------------------------------
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims?.sub) {
      return { status: "unauthenticated" };
    }
  } catch {
    // The thrown value is deliberately not bound or logged: auth exceptions can
    // carry token material.
    return { status: "unauthenticated" };
  }

  // ---------------------------------------------------------------------------
  // 2. The two reads, concurrently
  // ---------------------------------------------------------------------------
  // ONE extra row is requested. If it comes back, a further page exists — which is
  // how the presence of a next page is known without a second count query, and
  // without ever showing a "next" control that leads nowhere.
  //
  // Promise.resolve() because the PostgREST builder is a thenable rather than a real
  // Promise, matching the shape used throughout this codebase.
  const [listResult, countResult, optionsResult] = await Promise.all([
    Promise.resolve(
      supabase.rpc("list_claim_review_queue", {
        p_limit: CLAIM_REVIEW_PAGE_SIZE + 1,
        p_after_submitted_at: cursor?.submittedAt ?? null,
        p_after_submission_id: cursor?.receiptSubmissionId ?? null,
        p_retailer_id: filters.retailerId,
        p_shop_id: filters.shopId,
        p_submitted_from: filters.submittedFrom,
        p_submitted_to: filters.submittedTo,
      }),
    ).catch(() => null),
    Promise.resolve(
      supabase.rpc("count_claim_review_queue", {
        p_retailer_id: filters.retailerId,
        p_shop_id: filters.shopId,
        p_submitted_from: filters.submittedFrom,
        p_submitted_to: filters.submittedTo,
      }),
    ).catch(() => null),
    // Options take NO arguments at all — not even the filters. They describe what the
    // reviewer may choose from, which must not itself narrow as choices are made, or
    // selecting a shop would erase every other shop from the picker.
    Promise.resolve(supabase.rpc("list_claim_review_filter_options")).catch(
      () => null,
    ),
  ]);

  // A throw or a reported error on the LIST is fatal for this render. It is
  // `rows: null`, never `[]` — an outage must not read as "nothing to review".
  //
  // The error object is never bound, inspected or logged: a PostgREST error names
  // schemas, tables, columns, functions and policies, and none of that may reach a
  // browser. Note the RPC does not raise for an unauthorized caller — it returns
  // zero rows — so a reported error genuinely means the call did not complete.
  if (listResult === null || listResult.error) {
    console.error("claim-review-queue: queue read failed");
    return {
      status: "authorized",
      rows: null,
      totalCount: null,
      nextCursor: null,
      filterOptions: null,
    };
  }

  const rpcRows = (listResult.data ?? []) as QueueRpcRow[];

  // The count is independently degradable: a page of receipts with an unknown total
  // is still useful, so a failure here does not discard the rows.
  let totalCount: number | null = null;
  if (countResult !== null && !countResult.error) {
    const raw = countResult.data;
    const parsed =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number.parseInt(raw, 10)
          : Number.NaN;
    totalCount = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } else {
    console.error("claim-review-queue: count read failed");
  }

  // ---------------------------------------------------------------------------
  // 3. Page boundary and normalization
  // ---------------------------------------------------------------------------
  const hasMore = rpcRows.length > CLAIM_REVIEW_PAGE_SIZE;
  const pageRows = hasMore ? rpcRows.slice(0, CLAIM_REVIEW_PAGE_SIZE) : rpcRows;

  // filter(Boolean) drops any row too malformed to open. Ordering is preserved
  // exactly as the database returned it — oldest first — and is never re-sorted
  // here, so the cursor below always matches the last row actually rendered.
  const rows = pageRows
    .map(toQueueRow)
    .filter((row): row is ClaimReviewQueueRow => row !== null);

  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const nextCursor =
    hasMore && last !== null
      ? {
          submittedAt: last.submittedAt,
          receiptSubmissionId: last.receiptSubmissionId,
        }
      : null;

  // Options degrade independently of both other reads: a working queue with unusable
  // pickers is still a usable page, and `null` is what tells the UI to disable them
  // with retry copy instead of rendering an empty, silently-broken control.
  let filterOptions: ClaimReviewFilterOption[] | null = null;
  if (optionsResult !== null && !optionsResult.error) {
    filterOptions = ((optionsResult.data ?? []) as FilterOptionRpcRow[])
      .map(toFilterOption)
      .filter((o): o is ClaimReviewFilterOption => o !== null);
  } else {
    console.error("claim-review-queue: filter options read failed");
  }

  return { status: "authorized", rows, totalCount, nextCursor, filterOptions };
}

/**
 * The distinct Retailers in an option set, in the order the database returned them.
 *
 * Deduplicated by id: a Retailer with four shops contributes four option rows but one
 * Retailer choice. Pure, so the page and its tests share one definition.
 */
export function distinctRetailers(
  options: ClaimReviewFilterOption[],
): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const o of options) {
    if (!seen.has(o.retailerId)) seen.set(o.retailerId, o.retailerName);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

/**
 * The shop options visible for a given Retailer selection.
 *
 * With no Retailer chosen, every shop the reviewer may filter by. With one chosen,
 * only that Retailer's — so the two pickers cannot be combined into a pair that
 * matches nothing.
 */
export function shopsForRetailer(
  options: ClaimReviewFilterOption[],
  retailerId: string | null,
): ClaimReviewFilterOption[] {
  return retailerId === null
    ? options
    : options.filter((o) => o.retailerId === retailerId);
}

/**
 * The queue for the current reviewer, for one set of filters and one cursor.
 *
 * React `cache` here is REQUEST-SCOPED memoization for a single Server Component
 * render and nothing more — so the page and any component beneath it that asks the
 * same question pay for one round trip. It is NOT a persistent cache and must never
 * become one: this is per-user data, and a shared cache would be a cross-tenant leak.
 * The cache key is the argument tuple, so a different filter set is a different call.
 */
export const getClaimReviewQueue = cache(resolveClaimReviewQueue);
