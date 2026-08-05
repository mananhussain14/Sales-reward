import "server-only";

/**
 * SERVER-ONLY MODULE.
 *
 * The Sales Staff view of the campaigns running at their Retailer — the Migration 30
 * contract (20260815210000_vendor_campaign_operations), gated on STAFF_CAMPAIGNS_VIEW.
 *
 * ============================================================================
 * THREE READS. NO WRITE, AND NONE TO ADD.
 * ============================================================================
 *   list_my_staff_campaigns()                ACTIVE and SCHEDULED only
 *   get_my_staff_campaign(p_campaign_id)     the same shape, for one campaign
 *   list_my_staff_campaign_products(p_campaign_id)
 *
 * ============================================================================
 * CAMPAIGN VISIBILITY IS NOT REPRODUCED HERE
 * ============================================================================
 * Which campaigns a seller may see is decided entirely in SQL: the caller's Retailer is
 * resolved from auth.uid() through resolve_retailer_member_organization, the frozen
 * campaign_eligible_retailers snapshot decides targeting, `published_version_id = cv.id`
 * excludes drafts structurally, and campaign_derived_state restricts the result to
 * ACTIVE and SCHEDULED. Not one of those rules is re-stated in TypeScript, and none may
 * be: a filter on this side could only ever disagree with the database, and a
 * disagreement that HID a campaign would be invisible.
 *
 * There is no argument on any of these functions that names a profile, Retailer, Vendor
 * or shop, so no caller can widen their own scope.
 *
 * ============================================================================
 * WHY THE ARGUMENT IS p_campaign_id AND NOT A VERSION ID
 * ============================================================================
 * Read off the deployed catalogue rather than assumed. Migration 30 keys both
 * single-campaign reads on `p_campaign_id uuid` and returns `campaign_id` — there is no
 * campaign_version_id anywhere in its contract. SQL resolves the in-force published
 * version internally, which is why a version id is neither needed nor accepted.
 *
 * ============================================================================
 * WHAT NEVER ARRIVES, so it can never be rendered
 * ============================================================================
 * The Vendor's name (withheld from a shop-floor seller by design — it would leak the
 * supply relationship), any other Retailer targeted by the same campaign or a count of
 * them, the eligibility source, the Retailer group, the exclusivity key, the priority,
 * the internal version number and all audit metadata. The RPCs return none of them.
 *
 * AND NO PROGRESS AND NO EARNINGS. Every figure from these three reads is what a
 * campaign OFFERS. Units sold and coins earned come from the separate Migration 70
 * contract in @/lib/earnings/staff-earnings, and the two are never mixed in one read.
 */
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  normalizeAssignedCampaign,
  normalizeAssignedCampaigns,
  normalizeCampaignProducts,
  type AssignedCampaign,
  type CampaignProduct,
} from "@/lib/campaigns/campaign-normalization";

const LIST_RPC = "list_my_staff_campaigns" as const;
const GET_RPC = "get_my_staff_campaign" as const;
const LIST_PRODUCTS_RPC = "list_my_staff_campaign_products" as const;

const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * Logged server-side only, and only ever a CATEGORY.
 *
 * The PostgREST error object names schemas, tables, columns and functions in its
 * message, details and hint; none of the three is read here and none reaches a browser.
 */
function logFailure(operation: string, category: string): void {
  console.error(`[staff-campaigns] ${operation} failed: ${category}`);
}

export type StaffCampaignsResult =
  | { status: "ok"; campaigns: AssignedCampaign[] }
  /** Not an authorized Sales Staff member of a single active Retailer. */
  | { status: "denied" }
  | { status: "unavailable" };

export type StaffCampaignResult =
  | { status: "ok"; campaign: AssignedCampaign }
  /**
   * Unknown id, another Retailer's campaign, a draft, or one that has ended — all
   * INDISTINGUISHABLE, because the RPC answers zero rows to every one of them. The
   * detail route therefore cannot be used to probe which campaigns exist.
   */
  | { status: "not-found" }
  | { status: "denied" }
  | { status: "unavailable" };

export type StaffCampaignProductsResult =
  | { status: "ok"; products: CampaignProduct[] }
  | { status: "denied" }
  | { status: "unavailable" };

type ReadOutcome =
  | { status: "ok"; data: unknown }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * One RPC call through the AUTHENTICATED user's session.
 *
 * `createClient()` is the cookie-bound server client — never the service-role client,
 * which would bypass exactly the auth.uid() derivation these functions depend on.
 */
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
    // Only the SQLSTATE is inspected. 42501 is the collapsed refusal every denial
    // shares, so it cannot be used to tell one cause from another.
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
    logFailure(rpcName, "rpc-error");
    return { status: "unavailable" };
  }
  return { status: "ok", data: result.data as unknown };
}

/**
 * Every campaign currently running or scheduled at the caller's own Retailer.
 *
 * Deliberately NOT the Owner's list: a seller is shown what they can sell into now or
 * soon. A paused, ended or cancelled campaign offers them nothing, and SQL withholds it.
 *
 * REQUEST-SCOPED CACHE ONLY — a fresh cache per request, never a persistent or
 * cross-user one.
 */
export const listMyStaffCampaigns = cache(
  async function listMyStaffCampaigns(): Promise<StaffCampaignsResult> {
    const result = await runRead(LIST_RPC);
    if (result.status !== "ok") return result;

    const normalized = normalizeAssignedCampaigns(result.data);
    if (normalized.status === "malformed") {
      // The reason names only a FIELD, never a value, so it is safe to log.
      logFailure("list", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    return { status: "ok", campaigns: normalized.campaigns };
  },
);

/** One campaign the caller may see. Zero rows becomes `not-found`, never an error. */
export const getMyStaffCampaign = cache(
  async function getMyStaffCampaign(
    campaignId: string,
  ): Promise<StaffCampaignResult> {
    const result = await runRead(GET_RPC, { p_campaign_id: campaignId });
    if (result.status !== "ok") return result;

    const normalized = normalizeAssignedCampaign(result.data);
    if (normalized.status === "malformed") {
      logFailure("get", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    if (normalized.status === "not-found") return { status: "not-found" };
    return { status: "ok", campaign: normalized.campaign };
  },
);

/**
 * The products this campaign covers for the caller's Retailer.
 *
 * SNAPSHOT campaigns resolve to the list frozen at publication; LIVE_TEMPORAL campaigns
 * resolve live. Which applies is decided in SQL from the campaign's own
 * product_eligibility_resolution, and this module does not branch on it — the page
 * explains the difference, but the DATA is whatever SQL returned.
 */
export const listMyStaffCampaignProducts = cache(
  async function listMyStaffCampaignProducts(
    campaignId: string,
  ): Promise<StaffCampaignProductsResult> {
    const result = await runRead(LIST_PRODUCTS_RPC, { p_campaign_id: campaignId });
    if (result.status !== "ok") return result;

    const normalized = normalizeCampaignProducts(result.data);
    if (normalized.status === "malformed") {
      logFailure("products", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    return { status: "ok", products: normalized.products };
  },
);
