// SERVER-ONLY MODULE.
//
// The Retailer Owner's READ-ONLY view of the campaigns assigned to their Retailer.
//
// THERE IS NO WRITE IN THIS FILE, and there is no write to add. Creating, editing,
// publishing, pausing, resuming, cancelling and versioning are Vendor capabilities gated
// on CAMPAIGNS_MANAGE, which no Retailer role holds. The three reads below are gated on
// CAMPAIGNS_VIEW_ASSIGNED, mapped to RETAILER_OWNER alone.
//
// WHY RETAILER MANAGER IS ABSENT. No installed permission is a safe reuse for campaign
// visibility, and this milestone's approved scope grants it to the Retailer Owner and to
// Sales Staff only. A Manager gains it later by acquiring a role_permissions row, not by
// an edit to this file — and until then every RPC below refuses them in SQL.
//
// WHAT NEVER ARRIVES HERE, so it can never be rendered: another Retailer's identity or a
// count of them, the eligibility source, the Retailer group a campaign was resolved
// through, the exclusivity key, the priority, the version number, and the campaign's
// total product count across Retailers. The RPCs do not return any of them. That is where
// the guarantee lives — not in a filter applied on this side.
//
// AND NO PROGRESS. `eligibleProductCount` is how many products the campaign COVERS for
// this Retailer. Nothing in this module returns units sold, coins earned, a balance or a
// payout, and no field on the returned types could hold one.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  normalizeAssignedCampaign,
  normalizeAssignedCampaigns,
  normalizeCampaignProducts,
  type AssignedCampaign,
  type CampaignProduct,
} from "@/lib/campaigns/campaign-normalization";

const LIST_RPC = "list_my_retailer_campaigns" as const;
const GET_RPC = "get_my_retailer_campaign" as const;
const LIST_PRODUCTS_RPC = "list_my_retailer_campaign_products" as const;

const INSUFFICIENT_PRIVILEGE = "42501";

function logFailure(operation: string, category: string): void {
  console.error(`[retailer-campaigns] ${operation} failed: ${category}`);
}

export type AssignedCampaignsResult =
  | { status: "ok"; campaigns: AssignedCampaign[] }
  /** Not an authorized Retailer Owner — including a Manager and a Sales Staff member. */
  | { status: "denied" }
  | { status: "unavailable" };

export type AssignedCampaignResult =
  | { status: "ok"; campaign: AssignedCampaign }
  /** Unknown id, or a campaign not assigned to this Retailer. Indistinguishable. */
  | { status: "not-found" }
  | { status: "denied" }
  | { status: "unavailable" };

export type CampaignProductsResult =
  | { status: "ok"; products: CampaignProduct[] }
  | { status: "denied" }
  | { status: "unavailable" };

type ReadOutcome =
  | { status: "ok"; data: unknown }
  | { status: "denied" }
  | { status: "unavailable" };

async function runRead(
  rpcName: string,
  params?: Record<string, unknown>,
): Promise<ReadOutcome> {
  const supabase = await createClient();
  const result = await Promise.resolve(
    params === undefined ? supabase.rpc(rpcName) : supabase.rpc(rpcName, params),
  ).catch(() => null);

  if (result === null) {
    logFailure(rpcName, "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
    logFailure(rpcName, "rpc-error");
    return { status: "unavailable" };
  }
  return { status: "ok", data: result.data as unknown };
}

/**
 * Every published campaign currently assigned to the caller's own Retailer — active,
 * upcoming, paused, ended and cancelled alike.
 *
 * The Owner sees the whole history because managing a Retailer means knowing what ran.
 * (The Sales Staff contract, which Flutter consumes, deliberately shows only ACTIVE and
 * SCHEDULED: a paused or ended campaign offers a seller nothing.)
 *
 * REQUEST-SCOPED CACHE ONLY — a fresh cache per request, never a persistent one.
 */
export const getMyRetailerCampaigns = cache(
  async function getMyRetailerCampaigns(): Promise<AssignedCampaignsResult> {
    const result = await runRead(LIST_RPC);
    if (result.status !== "ok") return result;

    const normalized = normalizeAssignedCampaigns(result.data);
    if (normalized.status === "malformed") {
      // The reason names only field names — never values — so it is safe to log.
      logFailure("list", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    return { status: "ok", campaigns: normalized.campaigns };
  },
);

/**
 * One assigned campaign.
 *
 * A campaign id this Retailer is not on returns zero rows, exactly as an unknown id does,
 * so the detail route cannot be used to probe which campaigns exist.
 */
export async function getMyRetailerCampaign(
  campaignId: string,
): Promise<AssignedCampaignResult> {
  const result = await runRead(GET_RPC, { p_campaign_id: campaignId });
  if (result.status !== "ok") return result;

  const normalized = normalizeAssignedCampaign(result.data);
  if (normalized.status === "malformed") {
    logFailure("get", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  if (normalized.status === "not-found") return { status: "not-found" };
  return { status: "ok", campaign: normalized.campaign };
}

/**
 * The products a campaign covers FOR THIS RETAILER.
 *
 * For a SELECTED_PRODUCTS campaign this is the frozen snapshot, so a later assignment
 * change cannot alter what was promised. For an ALL_ELIGIBLE_PRODUCTS campaign it
 * resolves live, because that is what the phrase means. Which of the two applies is
 * decided in SQL; this module does not branch on it.
 */
export async function getMyRetailerCampaignProducts(
  campaignId: string,
): Promise<CampaignProductsResult> {
  const result = await runRead(LIST_PRODUCTS_RPC, { p_campaign_id: campaignId });
  if (result.status !== "ok") return result;

  const normalized = normalizeCampaignProducts(result.data);
  if (normalized.status === "malformed") {
    logFailure("products", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", products: normalized.products };
}
