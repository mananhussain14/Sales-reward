import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  parseVerifiedSaleItems,
  type VerifiedSaleItemRpcRow,
  type VerifiedSaleItems,
} from "@/lib/review/claim-product-context";

/**
 * The authoritative sale items, once a product list has been accepted.
 *
 * SERVER-ONLY. ONE RPC: `get_verified_sale_items(p_submission_id)`, which takes
 * the receipt id and nothing else and resolves the Vendor in SQL from auth.uid().
 *
 * ============================================================================
 * THE ACCEPTED STATE IS READ, NOT RECONSTRUCTED
 * ============================================================================
 * Once a decision is ACCEPTED, the panel must show what the `verified_sale_items`
 * rows actually say — not the proposal it was accepted from. The two are copied
 * byte for byte by the database and a trigger forbids either from being edited,
 * so they will agree; but rebuilding the authoritative record from the proposal
 * would make the display a claim about what SHOULD have been written rather than
 * a report of what WAS.
 *
 * Zero rows unless an ACCEPTED decision and its items exist for a receipt this
 * reviewer may read. No sale, no decision, foreign and unauthorized all return
 * zero rows and become the single `not-found`, so this cannot be used to discover
 * which receipts have accepted products.
 *
 * The function returns no internal foreign key — no Vendor, Retailer, shop,
 * product, profile, confirmation, sale or decision id. The only person named is
 * the reviewer who decided, by display name, which the page already shows for the
 * review decision.
 *
 * Bounded and read-only: one call, no polling, no automatic re-read.
 */

export type {
  VerifiedSaleItem,
  VerifiedSaleItems,
} from "@/lib/review/claim-product-context";

export type VerifiedSaleItemsResult =
  | { status: "authorized"; sale: VerifiedSaleItems }
  /** No accepted items, foreign, or unreadable by this caller. */
  | { status: "not-found" }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

async function resolveVerifiedSaleItems(
  receiptSubmissionId: string,
): Promise<VerifiedSaleItemsResult> {
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
    supabase.rpc("get_verified_sale_items", {
      p_submission_id: receiptSubmissionId,
    }),
  ).catch(() => null);

  if (result === null || result.error) {
    console.error("verified-sale-items: read failed");
    return { status: "unavailable" };
  }

  const rows = (result.data ?? []) as VerifiedSaleItemRpcRow[];
  if (rows.length === 0) {
    return { status: "not-found" };
  }

  const sale = parseVerifiedSaleItems(rows);
  if (sale === null) {
    console.error("verified-sale-items: rows were unusable");
    return { status: "unavailable" };
  }

  return { status: "authorized", sale };
}

/** Request-scoped React `cache` only. Never a persistent, cross-user cache. */
export const getVerifiedSaleItems = cache(resolveVerifiedSaleItems);
