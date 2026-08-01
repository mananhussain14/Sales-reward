// SERVER-ONLY MODULE.
//
// The thirteen Vendor campaign operations, each a thin wrapper over one SECURITY DEFINER
// RPC called under the CALLER'S OWN token (the ordinary publishable-key server client —
// never service-role; this module does not import one).
//
// AUTHORIZATION LIVES ENTIRELY IN THE DATABASE. Every RPC derives the Vendor itself from
// auth.uid() and then requires CAMPAIGNS_MANAGE. There is no Vendor organization id,
// membership id, role id or permission constant in this file, deliberately.
//
// THE ONLY IDS THAT TRAVEL ARE ADDRESSES. A campaign id, a version id, relationship ids,
// group ids and product ids are passed. Each is filtered in SQL on the id AND the derived
// Vendor, so an id belonging to another Vendor selects nothing and is refused identically
// to "you are not authorized".
//
// NO DIRECT TABLE ACCESS. This module contains zero `.from(` calls. All eleven campaign
// tables have RLS enabled with zero policies and no privilege granted to any browser
// role, so the RPCs are the only way in.
//
// NOTHING HERE COMPUTES A REWARD. The reward fields are carried as the OFFER a campaign
// makes. No function in this module multiplies a rate, accumulates a total, or returns
// anything that could be presented as progress, a balance or a coin credit.
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { CampaignRpcArgs } from "@/lib/campaigns/campaign-input";
import {
  normalizeCampaignHeader,
  normalizeEligibleRetailers,
  normalizeLifecycleOutcome,
  normalizePublicationPreview,
  normalizePublishOutcome,
  normalizeTargetGroups,
  normalizeTargetProducts,
  normalizeTargetRetailers,
  normalizeVendorCampaigns,
  normalizeVersionConfig,
  type CampaignEligibleRetailer,
  type CampaignTargetGroup,
  type CampaignTargetProduct,
  type CampaignTargetRetailer,
  type CampaignVersionConfig,
  type LifecycleOutcome,
  type PublicationPreviewRow,
  type PublishOutcome,
  type VendorCampaignHeader,
  type VendorCampaignSummary,
} from "@/lib/campaigns/campaign-normalization";

const LIST_CAMPAIGNS_RPC = "list_vendor_campaigns" as const;
const GET_CAMPAIGN_RPC = "get_vendor_campaign" as const;
const GET_VERSION_RPC = "get_vendor_campaign_version" as const;
const LIST_VERSION_RETAILERS_RPC = "list_vendor_campaign_version_retailers" as const;
const LIST_VERSION_GROUPS_RPC = "list_vendor_campaign_version_groups" as const;
const LIST_VERSION_PRODUCTS_RPC = "list_vendor_campaign_version_products" as const;
const LIST_ELIGIBLE_RPC = "list_vendor_campaign_eligible_retailers" as const;
const PREVIEW_RPC = "preview_vendor_campaign_publication" as const;
const CREATE_DRAFT_RPC = "create_vendor_campaign_draft" as const;
const UPDATE_DRAFT_RPC = "update_vendor_campaign_draft" as const;
const PUBLISH_RPC = "publish_vendor_campaign" as const;
const LIFECYCLE_RPC = "set_vendor_campaign_lifecycle" as const;
const CREATE_VERSION_RPC = "create_vendor_campaign_version" as const;

/** SQLSTATEs the campaign RPCs raise. Only the CODE is ever read. */
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const NOT_IN_PREREQUISITE_STATE = "55000";

function logCampaignFailure(operation: string, category: string): void {
  console.error(`[vendor-campaigns] ${operation} failed: ${category}`);
}

type ReadOutcome =
  | { status: "ok"; data: unknown }
  | { status: "denied" }
  | { status: "unavailable" };

async function runRead(
  rpcName: string,
  params?: Record<string, unknown>,
): Promise<ReadOutcome> {
  const supabase = await createClient();
  // Promise.resolve() because the PostgREST builder is a thenable, not a real Promise.
  const result = await Promise.resolve(
    params === undefined ? supabase.rpc(rpcName) : supabase.rpc(rpcName, params),
  ).catch(() => null);

  // A throw: fetch-level TypeError, aborted request, DNS or TLS failure. The thrown value
  // is deliberately not bound, inspected or logged — it may carry request URLs, headers
  // or token material.
  if (result === null) {
    logCampaignFailure(rpcName, "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
    logCampaignFailure(rpcName, "rpc-error");
    return { status: "unavailable" };
  }
  return { status: "ok", data: result.data as unknown };
}

/* ---------------------------------------------------------------------------
 * Reads
 * ------------------------------------------------------------------------- */

export type VendorCampaignsResult =
  | { status: "ok"; campaigns: VendorCampaignSummary[] }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * Every campaign this Vendor owns.
 *
 * REQUEST-SCOPED CACHE ONLY — a fresh cache per request, never a persistent one: an
 * authorization-bearing result belongs to exactly one caller for exactly one request.
 * Zero arguments, so there is no cache key, deliberately.
 *
 * The list is unfiltered by design. Filtering happens in the UI over a result the caller
 * is already authorized to hold whole, so no filter value ever becomes a request
 * parameter.
 */
export const getVendorCampaigns = cache(
  async function getVendorCampaigns(): Promise<VendorCampaignsResult> {
    const result = await runRead(LIST_CAMPAIGNS_RPC);
    if (result.status !== "ok") return result;

    const normalized = normalizeVendorCampaigns(result.data);
    if (normalized.status === "malformed") {
      logCampaignFailure("list", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    return { status: "ok", campaigns: normalized.campaigns };
  },
);

export type CampaignHeaderResult =
  | { status: "ok"; campaign: VendorCampaignHeader }
  /** Unknown id, or another Vendor's — the database does not distinguish them. */
  | { status: "not-found" }
  | { status: "denied" }
  | { status: "unavailable" };

export async function getVendorCampaign(
  campaignId: string,
): Promise<CampaignHeaderResult> {
  const result = await runRead(GET_CAMPAIGN_RPC, { p_campaign_id: campaignId });
  if (result.status !== "ok") return result;

  const normalized = normalizeCampaignHeader(result.data);
  if (normalized.status === "malformed") {
    logCampaignFailure("get", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  if (normalized.status === "not-found") return { status: "not-found" };
  return { status: "ok", campaign: normalized.campaign };
}

export type VersionConfigResult =
  | { status: "ok"; version: CampaignVersionConfig }
  | { status: "not-found" }
  | { status: "denied" }
  | { status: "unavailable" };

export async function getCampaignVersion(
  versionId: string,
): Promise<VersionConfigResult> {
  const result = await runRead(GET_VERSION_RPC, { p_campaign_version_id: versionId });
  if (result.status !== "ok") return result;

  const normalized = normalizeVersionConfig(result.data);
  if (normalized.status === "malformed") {
    logCampaignFailure("version", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  if (normalized.status === "not-found") return { status: "not-found" };
  return { status: "ok", version: normalized.version };
}

export type TargetRetailersResult =
  | { status: "ok"; retailers: CampaignTargetRetailer[] }
  | { status: "denied" }
  | { status: "unavailable" };

export async function getCampaignVersionRetailers(
  versionId: string,
): Promise<TargetRetailersResult> {
  const result = await runRead(LIST_VERSION_RETAILERS_RPC, {
    p_campaign_version_id: versionId,
  });
  if (result.status !== "ok") return result;

  const normalized = normalizeTargetRetailers(result.data);
  if (normalized.status === "malformed") {
    logCampaignFailure("version-retailers", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", retailers: normalized.retailers };
}

export type TargetGroupsResult =
  | { status: "ok"; groups: CampaignTargetGroup[] }
  | { status: "denied" }
  | { status: "unavailable" };

export async function getCampaignVersionGroups(
  versionId: string,
): Promise<TargetGroupsResult> {
  const result = await runRead(LIST_VERSION_GROUPS_RPC, {
    p_campaign_version_id: versionId,
  });
  if (result.status !== "ok") return result;

  const normalized = normalizeTargetGroups(result.data);
  if (normalized.status === "malformed") {
    logCampaignFailure("version-groups", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", groups: normalized.groups };
}

export type TargetProductsResult =
  | { status: "ok"; products: CampaignTargetProduct[] }
  | { status: "denied" }
  | { status: "unavailable" };

export async function getCampaignVersionProducts(
  versionId: string,
): Promise<TargetProductsResult> {
  const result = await runRead(LIST_VERSION_PRODUCTS_RPC, {
    p_campaign_version_id: versionId,
  });
  if (result.status !== "ok") return result;

  const normalized = normalizeTargetProducts(result.data);
  if (normalized.status === "malformed") {
    logCampaignFailure("version-products", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", products: normalized.products };
}

export type EligibleRetailersResult =
  | { status: "ok"; retailers: CampaignEligibleRetailer[] }
  | { status: "denied" }
  | { status: "unavailable" };

/** The frozen publication snapshot. VENDOR-ONLY: it carries the eligibility source. */
export async function getCampaignEligibleRetailers(
  versionId: string,
): Promise<EligibleRetailersResult> {
  const result = await runRead(LIST_ELIGIBLE_RPC, { p_campaign_version_id: versionId });
  if (result.status !== "ok") return result;

  const normalized = normalizeEligibleRetailers(result.data);
  if (normalized.status === "malformed") {
    logCampaignFailure("eligible", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", retailers: normalized.retailers };
}

export type PublicationPreviewResult =
  | { status: "ok"; rows: PublicationPreviewRow[] }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * What publication WOULD resolve to, right now, writing nothing.
 *
 * This is how the review step shows assignment conflicts before the operator commits. It
 * is a READ: a failure here must never be reported as a publish failure, and must never
 * block the operator from seeing the rest of the review.
 */
export async function getPublicationPreview(
  versionId: string,
): Promise<PublicationPreviewResult> {
  const result = await runRead(PREVIEW_RPC, { p_campaign_version_id: versionId });
  if (result.status !== "ok") return result;

  const normalized = normalizePublicationPreview(result.data);
  if (normalized.status === "malformed") {
    logCampaignFailure("preview", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", rows: normalized.rows };
}

/* ---------------------------------------------------------------------------
 * Writes
 * ------------------------------------------------------------------------- */

/**
 * The outcome of any campaign WRITE.
 *
 * `denied` covers an unauthorized caller, a foreign campaign id, a foreign Retailer id
 * and a foreign product id identically, exactly as the database does — the RPCs refuse
 * all of them with a single byte-identical exception so they cannot be used as an
 * existence oracle.
 *
 * `not-allowed` is the state refusal: a cancelled campaign, a campaign with no draft, a
 * campaign that resolves to no Retailer. It is separated from `invalid` because an
 * operator fixes the two in completely different ways.
 */
export type CampaignWriteResult =
  | { status: "ok" }
  | { status: "invalid" }
  | { status: "not-allowed"; reason: CampaignStateRefusal }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * Which state refusal occurred, resolved from the database's OWN fixed literals.
 *
 * These are the only place a database message is inspected, and only this repository's
 * own strings from migration 20260815210000 are matched — each describes the CALLER'S OWN
 * campaign, so none can reveal anything about another Vendor's. An unrecognized message
 * degrades to `unknown` rather than being echoed.
 */
export type CampaignStateRefusal =
  | "cancelled"
  | "no-draft"
  | "already-drafted"
  | "not-published"
  | "no-eligible-retailer"
  | "no-eligible-product"
  | "no-rule"
  | "unknown";

function classifyRefusal(message: string): CampaignStateRefusal {
  if (message.includes("cancelled campaign")) return "cancelled";
  if (message.includes("no draft to edit")) return "no-draft";
  if (message.includes("already has a draft")) return "already-drafted";
  if (message.includes("has not been published")) return "not-published";
  if (message.includes("does not currently apply to any active Retailer")) {
    return "no-eligible-retailer";
  }
  if (message.includes("None of the selected products")) return "no-eligible-product";
  if (message.includes("no reward rule")) return "no-rule";
  return "unknown";
}

function classifyWriteError(error: { code?: string; message?: string }): CampaignWriteResult {
  if (error.code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
  if (error.code === CHECK_VIOLATION) return { status: "invalid" };
  if (error.code === NOT_IN_PREREQUISITE_STATE) {
    const message = typeof error.message === "string" ? error.message : "";
    return { status: "not-allowed", reason: classifyRefusal(message) };
  }
  logCampaignFailure("write", "rpc-error");
  return { status: "unavailable" };
}

/** Creates a campaign and its version 1. Returns the new campaign id. */
export async function createCampaignDraft(
  args: CampaignRpcArgs,
): Promise<CampaignWriteResult & { campaignId?: string }> {
  const supabase = await createClient();
  const result = await Promise.resolve(supabase.rpc(CREATE_DRAFT_RPC, args)).catch(
    () => null,
  );

  if (result === null) {
    logCampaignFailure("create-draft", "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    return classifyWriteError(result.error as { code?: string; message?: string });
  }

  const campaignId = typeof result.data === "string" ? result.data.toLowerCase() : undefined;
  return { status: "ok", campaignId };
}

/** Rewrites the campaign's draft version whole. */
export async function updateCampaignDraft(
  campaignId: string,
  args: CampaignRpcArgs,
): Promise<CampaignWriteResult> {
  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(UPDATE_DRAFT_RPC, { p_campaign_id: campaignId, ...args }),
  ).catch(() => null);

  if (result === null) {
    logCampaignFailure("update-draft", "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    return classifyWriteError(result.error as { code?: string; message?: string });
  }
  return { status: "ok" };
}

export type PublishResult =
  | { status: "ok"; outcome: PublishOutcome }
  | { status: "invalid" }
  | { status: "not-allowed"; reason: CampaignStateRefusal }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * Publishes the draft version.
 *
 * IDEMPOTENT AT THE DATABASE. A second call finds no draft and returns
 * `outcome.published === false` — an explicit no-op, not an error. The caller reports
 * that plainly and MUST NOT retry: the first call already committed.
 *
 * A malformed response to a call that did NOT error is treated as `ok` with a synthesized
 * no-op outcome for the same reason: the write committed, and reporting a read problem as
 * a write failure would invite exactly the duplicate publish the design forbids.
 */
export async function publishCampaign(campaignId: string): Promise<PublishResult> {
  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(PUBLISH_RPC, { p_campaign_id: campaignId }),
  ).catch(() => null);

  if (result === null) {
    logCampaignFailure("publish", "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    const classified = classifyWriteError(result.error as { code?: string; message?: string });
    if (classified.status === "ok") return { status: "unavailable" };
    return classified;
  }

  const normalized = normalizePublishOutcome(result.data as unknown);
  if (normalized.status === "malformed") {
    logCampaignFailure("publish", `malformed:${normalized.reason}`);
    return {
      status: "ok",
      outcome: {
        campaignId,
        campaignVersionId: null,
        versionNumber: null,
        campaignStatus: null,
        eligibleRetailerCount: 0,
        eligibleProductCount: 0,
        published: true,
      },
    };
  }
  return { status: "ok", outcome: normalized.outcome };
}

export type LifecycleResult =
  | { status: "ok"; outcome: LifecycleOutcome }
  | { status: "invalid" }
  | { status: "not-allowed"; reason: CampaignStateRefusal }
  | { status: "denied" }
  | { status: "unavailable" };

/**
 * Pauses, resumes or cancels a published campaign.
 *
 * `outcome.statusChanged === false` is a no-op — pausing something already paused. The UI
 * reports it as "already paused" rather than as a success that changed nothing, and the
 * database wrote no duplicate audit event for it.
 */
export async function setCampaignLifecycle(
  campaignId: string,
  action: "PAUSE" | "RESUME" | "CANCEL",
): Promise<LifecycleResult> {
  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(LIFECYCLE_RPC, { p_campaign_id: campaignId, p_action: action }),
  ).catch(() => null);

  if (result === null) {
    logCampaignFailure("lifecycle", "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    const classified = classifyWriteError(result.error as { code?: string; message?: string });
    if (classified.status === "ok") return { status: "unavailable" };
    return classified;
  }

  const normalized = normalizeLifecycleOutcome(result.data as unknown);
  if (normalized.status === "malformed") {
    // THE WRITE COMMITTED. Reported as a read problem, never as a failed mutation.
    logCampaignFailure("lifecycle", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", outcome: normalized.outcome };
}

/** Opens a new editable version by copying the one in force. Returns the version id. */
export async function createCampaignVersion(
  campaignId: string,
): Promise<CampaignWriteResult & { versionId?: string }> {
  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(CREATE_VERSION_RPC, { p_campaign_id: campaignId }),
  ).catch(() => null);

  if (result === null) {
    logCampaignFailure("create-version", "transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    return classifyWriteError(result.error as { code?: string; message?: string });
  }

  const versionId = typeof result.data === "string" ? result.data.toLowerCase() : undefined;
  return { status: "ok", versionId };
}
