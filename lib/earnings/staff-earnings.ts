import "server-only";

/**
 * SERVER-ONLY MODULE.
 *
 * What the signed-in Sales Staff member has EARNED — the Migration 70 contract
 * (20260828090000_sales_staff_campaigns_earnings_reads), gated on STAFF_EARNINGS_VIEW.
 *
 * ============================================================================
 * THREE READS. NO WRITE ANYWHERE IN THIS FILE.
 * ============================================================================
 *   get_my_campaign_rewards(p_limit, p_before_awarded_at, p_before_reward_id)
 *   get_my_campaign_earnings_summary()
 *   get_my_campaign_target_progress()
 *
 * ============================================================================
 * THERE IS NO ARGUMENT THAT NAMES A PERSON
 * ============================================================================
 * The only three parameters in the whole contract are a page size and a two-part page
 * cursor. No profile, Retailer, Vendor, shop, campaign or beneficiary id can be supplied
 * to any of them, so this module could not read another seller's earnings if it tried.
 * Every row is filtered in SQL on campaign_rewards.beneficiary_profile_id resolved from
 * auth.uid() — which is also why the AUTHENTICATED session client is used below and the
 * service-role client is not: service-role would bypass exactly that derivation.
 *
 * ============================================================================
 * NO TABLE IS READ DIRECTLY
 * ============================================================================
 * campaign_rewards, campaign_subject_accumulators, campaign_sale_evaluations,
 * campaign_sale_item_qualifications and verified_sales are never named in a `.from()`
 * here or anywhere else in the Web app. `authenticated` holds no SELECT on any of them
 * and they carry RLS with no policy, so the browser could not read them regardless —
 * but the point is that this module does not try. Three RPCs, and nothing else.
 *
 * ============================================================================
 * NOTHING IS RECALCULATED, AND EARNED IS NOT A BALANCE
 * ============================================================================
 * Every coin figure is a stored value from an immutable campaign_rewards row, or a sum
 * SQL performed over those rows. No rate is multiplied, no cap is applied and no total
 * is derived from evaluations. Nothing is subtracted either: there is no ledger and no
 * redemption model, so there is nothing to subtract from and no balance to report.
 */
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  normalizeEarningsSummary,
  normalizeRewardEntries,
  normalizeTargetProgress,
  type CampaignRewardEntry,
  type CampaignTargetProgress,
  type EarningsSummary,
} from "@/lib/earnings/earnings-normalization";
import { REWARDS_PAGE_SIZE } from "@/lib/earnings/earnings-presentation";

const REWARDS_RPC = "get_my_campaign_rewards" as const;
const SUMMARY_RPC = "get_my_campaign_earnings_summary" as const;
const PROGRESS_RPC = "get_my_campaign_target_progress" as const;

const INSUFFICIENT_PRIVILEGE = "42501";

/** Server-side only, and only ever a CATEGORY — never a database message. */
function logFailure(operation: string, category: string): void {
  console.error(`[staff-earnings] ${operation} failed: ${category}`);
}

export type RewardHistoryResult =
  | { status: "ok"; rewards: CampaignRewardEntry[] }
  | { status: "denied" }
  | { status: "unavailable" };

export type EarningsSummaryResult =
  | { status: "ok"; summary: EarningsSummary }
  /**
   * Zero rows. The RPC returns none for a caller it does not authorize — which is a
   * DENIAL, not an empty history: an authorized seller with no rewards still gets one
   * row of zeroes.
   */
  | { status: "denied" }
  | { status: "unavailable" };

export type TargetProgressResult =
  | { status: "ok"; progress: CampaignTargetProgress[] }
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
 * One page of the caller's OWN reward history, newest first.
 *
 * ---- THE PAGE SIZE IS NOT A PARAMETER OF THIS FUNCTION ----------------------
 * `REWARDS_PAGE_SIZE` is a module constant, passed to every call. The RPC clamps to
 * 1..100 itself, but the UI must not offer a caller-controlled limit at all: a `?limit=`
 * a visitor could edit would let one request walk an entire history for no benefit to
 * any screen here.
 *
 * ---- KEYSET, NEVER OFFSET ---------------------------------------------------
 * Rewards are append-only and arrive while a seller is reading, so an OFFSET page 2
 * would repeat or skip rows the moment a new reward landed. The cursor is the
 * (awarded_at, reward id) pair the ORDER BY uses, so no row can be visited twice and
 * none can be missed.
 *
 * Both cursor halves are sent or neither is. A partial cursor is meaningless to the
 * keyset comparison, and the caller (parseRewardCursor) has already refused one.
 */
export async function getMyCampaignRewards(options?: {
  beforeAwardedAt?: string | null;
  beforeRewardId?: string | null;
}): Promise<RewardHistoryResult> {
  const beforeAwardedAt = options?.beforeAwardedAt ?? null;
  const beforeRewardId = options?.beforeRewardId ?? null;
  const paired =
    beforeAwardedAt !== null && beforeRewardId !== null
      ? { p_before_awarded_at: beforeAwardedAt, p_before_reward_id: beforeRewardId }
      : { p_before_awarded_at: null, p_before_reward_id: null };

  const result = await runRead(REWARDS_RPC, {
    p_limit: REWARDS_PAGE_SIZE,
    ...paired,
  });
  if (result.status !== "ok") return result;

  const normalized = normalizeRewardEntries(result.data);
  if (normalized.status === "malformed") {
    logFailure("rewards", `malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  return { status: "ok", rewards: normalized.rewards };
}

/**
 * The caller's own earnings totals.
 *
 * REQUEST-SCOPED CACHE ONLY. A persistent cache here would be a cross-user data leak of
 * the most direct kind, and there is none.
 */
export const getMyCampaignEarningsSummary = cache(
  async function getMyCampaignEarningsSummary(): Promise<EarningsSummaryResult> {
    const result = await runRead(SUMMARY_RPC);
    if (result.status !== "ok") return result;

    const normalized = normalizeEarningsSummary(result.data);
    if (normalized.status === "malformed") {
      logFailure("summary", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    // Zero rows means the RPC did not authorize the caller. An authorized seller with no
    // rewards receives a row of zeroes instead, so this is never an empty history.
    if (normalized.status === "not-found") return { status: "denied" };
    return { status: "ok", summary: normalized.summary };
  },
);

/**
 * Progress towards every TARGET_BONUS campaign the caller can currently see.
 *
 * Returns the NORMALIZED contract only — units, target, reached, and whether the bonus
 * went to this caller. The accumulator's subject type, subject id, coin total and its
 * own per-subject target flag are not in the RPC's result and cannot be requested.
 */
export const getMyCampaignTargetProgress = cache(
  async function getMyCampaignTargetProgress(): Promise<TargetProgressResult> {
    const result = await runRead(PROGRESS_RPC);
    if (result.status !== "ok") return result;

    const normalized = normalizeTargetProgress(result.data);
    if (normalized.status === "malformed") {
      logFailure("progress", `malformed:${normalized.reason}`);
      return { status: "unavailable" };
    }
    return { status: "ok", progress: normalized.progress };
  },
);
