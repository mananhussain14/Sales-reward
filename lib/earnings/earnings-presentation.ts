/**
 * PURE MODULE — no imports beyond sibling types, no I/O, no Supabase client.
 *
 * How the Sales Staff campaign and earnings screens SAY things. Every function is
 * total, deterministic and unit-tested by being called.
 *
 * ============================================================================
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 * ============================================================================
 * A seller must never be told they earned something they did not. Under RETAILER_TEAM
 * the progress figure is the whole team's, and the bonus goes once to whoever's sale
 * crossed the threshold. Those two facts together make it very easy to render a screen
 * that reads "9 / 8 units — target reached!" next to a seller who received nothing.
 * `targetStatement` is the single place that decision is made, and it separates
 * "the team reached it" from "you were awarded it" in every combination.
 */
import type {
  CampaignRewardEntry,
  CampaignTargetProgress,
  EarningPerformanceScope,
  RewardRuleType,
} from "@/lib/earnings/earnings-normalization";

/* ---------------------------------------------------------------------------
 * Fixed copy — declared once so a test can assert the exact words
 * ------------------------------------------------------------------------- */

/** Shown wherever a total appears. The absence of a wallet is stated, not implied. */
export const NOT_A_WALLET_NOTICE =
  "These are campaign rewards earned. Wallet, payout and redemption features are not available yet.";

export const NO_CAMPAIGNS_MESSAGE =
  "No active or upcoming campaigns are available for your shop.";

export const NO_PRODUCTS_MESSAGE =
  "No product list is available for this campaign.";

export const NO_REWARDS_MESSAGE =
  "You have not earned any campaign rewards yet.";

export const CAMPAIGNS_UNAVAILABLE_MESSAGE =
  "Campaign information could not be loaded. Try again.";

export const EARNINGS_UNAVAILABLE_MESSAGE =
  "Earnings information could not be loaded. Try again.";

/** Team progress, said plainly so no seller reads the number as their own. */
export const TEAM_PROGRESS_EXPLANATION =
  "This total counts qualifying units sold by everyone at your Retailer, not only yours.";

export const INDIVIDUAL_PROGRESS_EXPLANATION =
  "This total counts your own qualifying units.";

/* ---------------------------------------------------------------------------
 * Labels
 * ------------------------------------------------------------------------- */

export function rewardRuleLabel(rule: RewardRuleType | null): string {
  switch (rule) {
    case "PER_UNIT_COINS":
      return "Coins per unit";
    case "TARGET_BONUS":
      return "Target bonus";
    default:
      return "Reward";
  }
}

export function progressScopeLabel(scope: EarningPerformanceScope): string {
  return scope === "RETAILER_TEAM" ? "Team progress" : "Your progress";
}

export function progressScopeExplanation(scope: EarningPerformanceScope): string {
  return scope === "RETAILER_TEAM"
    ? TEAM_PROGRESS_EXPLANATION
    : INDIVIDUAL_PROGRESS_EXPLANATION;
}

/* ---------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------- */

/** Grouped digits so a six-figure coin total stays readable. */
export function formatCoins(coins: number): string {
  return coins.toLocaleString("en-US");
}

export function formatUnits(units: number): string {
  return units.toLocaleString("en-US");
}

/**
 * A date, in a fixed locale and an explicit UTC zone.
 *
 * UTC deliberately: a reward's award instant is a database fact, and rendering it in the
 * server's incidental zone would make the same reward read differently on two machines.
 * Returns null for an absent or unparseable value rather than "Invalid Date".
 */
export function formatEarningsDate(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatEarningsTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })}, ${parsed.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

/**
 * A short, safe reference for a receipt.
 *
 * The Sales Staff portal has no receipt-detail route, so the id is shown as a stub
 * rather than linked — and a stub is all a seller needs to match a row against their own
 * submission list. The full uuid is never printed: it is an internal key, and a
 * shortened form cannot be pasted anywhere it would act as one.
 */
export function receiptReference(receiptSubmissionId: string): string {
  return receiptSubmissionId.slice(0, 8).toUpperCase();
}

/* ---------------------------------------------------------------------------
 * Cap reduction
 * ------------------------------------------------------------------------- */

/**
 * How many coins a cap removed from this reward, or null when it removed none.
 *
 * SUBTRACTION OF TWO STORED VALUES ON ONE ROW — not a recalculation. The database
 * already decided both numbers; this only labels the gap between them. Returns null when
 * either is absent, and when the difference is zero or negative, so a screen never
 * announces a "reduction" of nothing.
 */
export function capReduction(reward: {
  coinsUncapped: number | null;
  rewardCoins: number;
}): number | null {
  if (reward.coinsUncapped === null) return null;
  const difference = reward.coinsUncapped - reward.rewardCoins;
  return difference > 0 ? difference : null;
}

/** Whether a cap visibly bit on this reward. */
export function wasCapped(reward: {
  coinsUncapped: number | null;
  rewardCoins: number;
}): boolean {
  return capReduction(reward) !== null;
}

/* ---------------------------------------------------------------------------
 * Target progress
 * ------------------------------------------------------------------------- */

/**
 * Progress as a whole percentage, clamped to 0..100.
 *
 * Clamped at the top because progress may legitimately EXCEED the target — a team that
 * needed 8 units and sold 9 is at 112%, and a bar wider than its track is a rendering
 * bug. A zero or negative target yields 0 rather than a division by zero.
 */
export function progressPercent(progress: {
  progressUnits: number;
  targetUnits: number;
}): number {
  if (progress.targetUnits <= 0) return 0;
  const raw = (progress.progressUnits / progress.targetUnits) * 100;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(100, Math.round(raw));
}

/**
 * What the screen may truthfully say about one target campaign.
 *
 * FOUR OUTCOMES, AND THE THIRD IS THE WHOLE POINT:
 *
 *   not-reached  the threshold has not been crossed by whoever counts towards it.
 *   awarded      it was crossed AND this seller holds the bonus. The only case in
 *                which the words "you earned" are permitted.
 *   reached-not-yours
 *                it was crossed and this seller does NOT hold the bonus. Under
 *                RETAILER_TEAM that is the ordinary case for everyone except the one
 *                colleague whose sale crossed it. The copy congratulates the team and
 *                is explicit that the bonus went elsewhere, because a seller who reads
 *                "target reached" and finds nothing in their earnings will conclude the
 *                app lost their money.
 *   reached-pending
 *                crossed, not awarded to this seller, and the campaign is INDIVIDUAL —
 *                so it should have been theirs. The honest reading is "not recorded
 *                yet": evaluation happens when a reviewer verifies the sale, which may
 *                not have run. Never phrased as a denial.
 */
export type TargetOutcome =
  | "not-reached"
  | "awarded"
  | "reached-not-yours"
  | "reached-pending";

export function targetOutcome(progress: {
  performanceScope: EarningPerformanceScope;
  targetReached: boolean;
  bonusAwardedToMe: boolean;
}): TargetOutcome {
  if (progress.bonusAwardedToMe) return "awarded";
  if (!progress.targetReached) return "not-reached";
  return progress.performanceScope === "RETAILER_TEAM"
    ? "reached-not-yours"
    : "reached-pending";
}

export type TargetStatement = {
  outcome: TargetOutcome;
  label: string;
  detail: string;
  tone: "emerald" | "amber" | "slate";
};

export function targetStatement(progress: {
  performanceScope: EarningPerformanceScope;
  targetReached: boolean;
  bonusAwardedToMe: boolean;
}): TargetStatement {
  const outcome = targetOutcome(progress);

  switch (outcome) {
    case "awarded":
      return {
        outcome,
        label: "Bonus awarded to you",
        detail: "You received this campaign's target bonus.",
        tone: "emerald",
      };
    case "reached-not-yours":
      return {
        outcome,
        label: "Team target reached",
        // Says plainly that the bonus is not theirs. Anything vaguer reads as a promise.
        detail:
          "Your team reached this target. The bonus for crossing it was awarded to another team member.",
        tone: "amber",
      };
    case "reached-pending":
      return {
        outcome,
        label: "Target reached",
        detail:
          "This target has been reached. Any bonus appears in your earnings once the sale that crossed it has been verified.",
        tone: "amber",
      };
    case "not-reached":
    default:
      return {
        outcome: "not-reached",
        label: "Target not reached yet",
        detail: "Keep selling qualifying products to reach this target.",
        tone: "slate",
      };
  }
}

/**
 * The accessible label for a progress bar.
 *
 * Names the SUBJECT as well as the numbers, so a screen-reader user hears "Team
 * progress: 9 of 8 units" rather than a bare ratio they would reasonably assume was
 * personal.
 */
export function progressAriaLabel(progress: {
  performanceScope: EarningPerformanceScope;
  progressUnits: number;
  targetUnits: number;
}): string {
  return `${progressScopeLabel(progress.performanceScope)}: ${formatUnits(
    progress.progressUnits,
  )} of ${formatUnits(progress.targetUnits)} units`;
}

/* ---------------------------------------------------------------------------
 * Joining progress to campaigns
 * ------------------------------------------------------------------------- */

/**
 * Index progress rows by CAMPAIGN ID.
 *
 * The Migration 30 staff campaign contract returns `campaign_id` and NO version id, so
 * campaign_id is the only authoritative key the two reads share. It is sufficient:
 * get_my_campaign_target_progress returns the in-force published version only, so a
 * campaign appears at most once.
 *
 * NOT BY NAME. Two campaigns may share a display name, and a name may be edited between
 * the two reads; either would silently attach one campaign's progress to another.
 */
export function progressByCampaignId(
  progress: CampaignTargetProgress[],
): Map<string, CampaignTargetProgress> {
  const byId = new Map<string, CampaignTargetProgress>();
  for (const row of progress) {
    // First wins. A duplicate campaign_id would be drift; overwriting would hide it and
    // pick arbitrarily, and neither row is more trustworthy than the other.
    if (!byId.has(row.campaignId)) byId.set(row.campaignId, row);
  }
  return byId;
}

/* ---------------------------------------------------------------------------
 * Reward-history pagination
 * ------------------------------------------------------------------------- */

/**
 * The fixed page size.
 *
 * A CONSTANT, never a caller-supplied value. The RPC clamps to 1..100 itself, but the UI
 * must not offer an arbitrary limit at all: a `?limit=` a visitor could set would let one
 * request walk an entire history, and no screen here needs that.
 */
export const REWARDS_PAGE_SIZE = 20;

/** Search-parameter names, declared once so page and tests cannot drift apart. */
export const CURSOR_AWARDED_AT_PARAM = "before" as const;
export const CURSOR_REWARD_ID_PARAM = "beforeId" as const;

export type RewardCursor = {
  beforeAwardedAt: string;
  beforeRewardId: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a keyset cursor from URL search parameters.
 *
 * BOTH HALVES OR NEITHER. The keyset comparison is `(awarded_at, id) < (a, b)`; supplying
 * one half is meaningless, and Migration 70 ignores a partial cursor rather than
 * refusing it — which would silently return page one while the URL claimed otherwise.
 * Validating here makes that state unreachable.
 *
 * An invalid cursor returns null, and the caller falls back to the first page. It is
 * never passed through to the RPC: a malformed timestamp would raise, and a raise on a
 * hand-edited URL is a worse experience than simply showing the newest rewards.
 */
export function parseRewardCursor(params: {
  [key: string]: string | string[] | undefined;
}): RewardCursor | null {
  const rawAwardedAt = params[CURSOR_AWARDED_AT_PARAM];
  const rawRewardId = params[CURSOR_REWARD_ID_PARAM];

  // A repeated parameter (?before=a&before=b) arrives as an array. Ambiguous, so refused.
  if (typeof rawAwardedAt !== "string" || typeof rawRewardId !== "string") {
    return null;
  }

  const awardedAt = rawAwardedAt.trim();
  const rewardId = rawRewardId.trim();

  if (awardedAt.length === 0 || rewardId.length === 0) return null;
  if (!UUID_PATTERN.test(rewardId)) return null;

  const parsed = new Date(awardedAt);
  if (Number.isNaN(parsed.getTime())) return null;

  return { beforeAwardedAt: awardedAt, beforeRewardId: rewardId.toLowerCase() };
}

/**
 * The cursor for the page AFTER this one, or null when there is no older page.
 *
 * Taken from the LAST row, which — under `order by awarded_at desc, id desc` — is the
 * oldest on the page. A page shorter than the requested size is the final page, so no
 * cursor is offered and the "Load older rewards" control does not render.
 */
export function nextRewardCursor(
  rewards: CampaignRewardEntry[],
  pageSize: number = REWARDS_PAGE_SIZE,
): RewardCursor | null {
  if (rewards.length < pageSize || rewards.length === 0) return null;
  const last = rewards[rewards.length - 1];
  return { beforeAwardedAt: last.awardedAt, beforeRewardId: last.rewardId };
}

/** The href for the next page, preserving nothing else — there is nothing else. */
export function rewardCursorHref(
  basePath: string,
  cursor: RewardCursor,
): string {
  const search = new URLSearchParams({
    [CURSOR_AWARDED_AT_PARAM]: cursor.beforeAwardedAt,
    [CURSOR_REWARD_ID_PARAM]: cursor.beforeRewardId,
  });
  return `${basePath}?${search.toString()}`;
}
