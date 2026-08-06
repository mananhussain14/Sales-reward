import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { CampaignQualifyingItem } from "@/lib/review/campaign-evaluation-display";

/**
 * The qualifying products behind each campaign result — Phase 2A-F.
 *
 * SERVER-ONLY. ONE RPC: `get_receipt_campaign_qualifying_items(p_submission_id)`, the
 * Migration 69 receipt-keyed wrapper. Receipt id and nothing else; the Vendor is
 * resolved in SQL and the verified sale internally.
 *
 * ============================================================================
 * THE ORDER IS THE DATABASE'S, AND IT IS NOT RE-SORTED
 * ============================================================================
 * Rows arrive ordered by campaign priority, then receipt line number, then item id.
 * That order is deterministic and reproducible; a client-side sort on a display field
 * would make the list jump whenever a product was renamed. Nothing here reorders.
 *
 * ============================================================================
 * ONLY QUALIFIED CAMPAIGNS HAVE ITEMS
 * ============================================================================
 * Migration 68 writes item evidence for a final QUALIFIED campaign and nothing else,
 * so a NOT_QUALIFIED, NOT_EVALUABLE or exclusivity-suppressed campaign simply has no
 * rows here. The display layer checks the outcome as well, so a stray row could never
 * be rendered under a campaign that did not qualify.
 *
 * SNAPSHOT rows carry NULL sale-time statuses BY DESIGN — no temporal check happened,
 * and Migration 65's live_evidence_paired CHECK refuses a row that claims otherwise.
 * Those nulls are never an error and are never displayed as missing data.
 */

export type { CampaignQualifyingItem };

export type ReceiptCampaignQualifyingItemsResult =
  | { status: "authorized"; items: CampaignQualifyingItem[] }
  | { status: "unauthenticated" }
  | { status: "unavailable" };

/** One row of the RPC, declared explicitly — the exact deployed 11 columns. */
type QualifyingItemRpcRow = {
  campaign_id: string | null;
  campaign_version_id: string | null;
  verified_sale_item_id: string | null;
  vendor_product_id: string | null;
  product_code_at_proposal: string | null;
  product_name_at_proposal: string | null;
  line_number: number | string | null;
  qualifying_units: number | string | null;
  product_source: string | null;
  product_status_at_sale: string | null;
  assignment_status_at_sale: string | null;
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function optionalWholeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Field by field, never a spread — see receipt-campaign-results. */
function toItem(row: QualifyingItemRpcRow): CampaignQualifyingItem | null {
  const campaignId = optionalText(row.campaign_id);
  const campaignVersionId = optionalText(row.campaign_version_id);
  const verifiedSaleItemId = optionalText(row.verified_sale_item_id);
  const vendorProductId = optionalText(row.vendor_product_id);

  // Without the campaign key an item cannot be grouped, and attaching it to the wrong
  // campaign is the one failure that would be invisible and wrong at once.
  if (
    campaignId === null ||
    campaignVersionId === null ||
    verifiedSaleItemId === null ||
    vendorProductId === null
  ) {
    return null;
  }

  return {
    campaignId,
    campaignVersionId,
    verifiedSaleItemId,
    vendorProductId,
    productCodeAtProposal: optionalText(row.product_code_at_proposal),
    productNameAtProposal: optionalText(row.product_name_at_proposal),
    lineNumber: optionalWholeNumber(row.line_number),
    qualifyingUnits: optionalWholeNumber(row.qualifying_units) ?? 0,
    productSource: optionalText(row.product_source),
    // NULL under SNAPSHOT, by design. Preserved as null, never defaulted.
    productStatusAtSale: optionalText(row.product_status_at_sale),
    assignmentStatusAtSale: optionalText(row.assignment_status_at_sale),
  };
}

async function resolveReceiptCampaignQualifyingItems(
  receiptSubmissionId: string,
): Promise<ReceiptCampaignQualifyingItemsResult> {
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
    supabase.rpc("get_receipt_campaign_qualifying_items", {
      p_submission_id: receiptSubmissionId,
    }),
  ).catch(() => null);

  if (result === null || result.error) {
    console.error("receipt-campaign-qualifying-items: read failed");
    return { status: "unavailable" };
  }

  const rows = (result.data ?? []) as QualifyingItemRpcRow[];
  const items: CampaignQualifyingItem[] = [];
  let dropped = 0;

  for (const row of rows) {
    const mapped = toItem(row);
    if (mapped === null) {
      dropped += 1;
      continue;
    }
    items.push(mapped);
  }

  if (dropped > 0) {
    console.error(
      `receipt-campaign-qualifying-items: ${dropped} row(s) were unusable and were not displayed`,
    );
  }

  return { status: "authorized", items };
}

/** Request-scoped React `cache` only. Never a persistent, cross-user cache. */
export const getReceiptCampaignQualifyingItems = cache(
  resolveReceiptCampaignQualifyingItems,
);
