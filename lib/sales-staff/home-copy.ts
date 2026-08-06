/**
 * PURE MODULE — no imports, no I/O, no Supabase client.
 *
 * Every string the Sales Staff Home renders.
 *
 * ============================================================================
 * WHY THE COPY LIVES HERE AND NOT AT ITS CALL SITES
 * ============================================================================
 * No copy on this screen may be derived from a backend response. Each string is a fixed
 * literal or a function of parsed, validated numbers, so a Postgres message, a SQLSTATE,
 * a stack trace, a uuid or an internal enum token cannot reach a browser through any of
 * them. Declaring them once also lets a test assert the exact words.
 *
 * ============================================================================
 * ENCOURAGING, AND TRUE
 * ============================================================================
 * The screen is meant to feel motivating. That is a constraint on TONE, never on
 * accuracy — so nothing here invents a streak, a countdown, a rank, a league, a
 * prediction, a personal statistic or a promise about a future reward. The one
 * forward-looking sentence, GREETING_LINE, says a reward is *within reach*, which is true
 * of every seller with a running campaign and asserts nothing about any of them in
 * particular.
 *
 * ============================================================================
 * NOTHING HERE IS A BALANCE
 * ============================================================================
 * The coin figure is labelled as EARNED, and carries the same qualifying notice the
 * earnings screen shows. Not one string calls it a wallet, an available balance,
 * redeemable coins, paid coins or a payout, because none of those exists in the deployed
 * schema.
 */

/* ---------------------------------------------------------------------------
 * Welcome
 * ------------------------------------------------------------------------- */

/**
 * The greeting.
 *
 * Deliberately time-of-day-free. The browser's clock is not the campaign's clock, and
 * "Good morning" on a night shift is a small lie the screen does not need to tell.
 */
export const GREETING = "Welcome back";

/** The motivating line, and the only forward-looking sentence on the screen. */
export const GREETING_LINE = "Your next reward is within reach.";

/**
 * Shown instead when there is no running or upcoming campaign at all, so the
 * encouragement never contradicts an empty screen below it.
 */
export const GREETING_LINE_NO_CAMPAIGNS =
  "Keep submitting receipts — campaigns appear here as soon as a Vendor runs one for your Retailer.";

/** The Retailer context line. The name comes from the authorized portal context. */
export function sellingFor(retailerName: string): string {
  return `Selling for ${retailerName}`;
}

/* ---------------------------------------------------------------------------
 * The next-reward hero
 * ------------------------------------------------------------------------- */

/**
 * The hero's eyebrow, chosen from the stored `target_reached` boolean and the lifecycle
 * state — never from anything the client decides.
 *
 * It never says "next reward" over a target that has already been met, and never says
 * "reached" over one that has not.
 */
export const HERO_EYEBROW_NEXT = "YOUR NEXT REWARD";
export const HERO_EYEBROW_REACHED = "TARGET REACHED";
export const HERO_EYEBROW_RUNNING = "RUNNING NOW";
export const HERO_EYEBROW_UPCOMING = "STARTING SOON";

/** The action on the hero. It opens the campaign; it earns nothing. */
export const HERO_ACTION = "View campaign";

/** The label under the percentage inside the ring. */
export const HERO_OF_TARGET = "of target";

export const HERO_EMPTY_TITLE = "No campaign to aim at yet";
export const HERO_EMPTY_BODY =
  "When a Vendor runs a campaign for your Retailer it appears here, with your progress towards it.";

/* ---------------------------------------------------------------------------
 * Campaign coins
 * ------------------------------------------------------------------------- */

export const COINS_TITLE = "Campaign coins earned";
export const COINS_HINT = "Every campaign reward awarded to you, added up.";
export const COINS_ACTION = "View my earnings";

/**
 * The totals could not be read. Said inside the panel rather than as a screen-wide
 * failure: the campaigns below came from a different contract and are unaffected.
 *
 * Never rendered as zeros — "you earned nothing" and "we could not tell" are opposite
 * claims.
 */
export const COINS_UNAVAILABLE = "Your totals could not be loaded.";

export const THIS_MONTH_LABEL = "This month";
export const REWARDED_SALES_LABEL = "Rewarded sales";
export const REWARDED_CAMPAIGNS_LABEL = "Rewarded campaigns";

/* ---------------------------------------------------------------------------
 * Opportunities
 * ------------------------------------------------------------------------- */

/**
 * The section heading.
 *
 * "for you" is about TARGETING — these campaigns were assigned to this seller's
 * Retailer — and never about a ranking or a recommendation.
 */
export const OPPORTUNITIES_TITLE = "Opportunities for you";

export const OPPORTUNITIES_HINT = "Eligible sales count towards these.";

export const VIEW_ALL_CAMPAIGNS = "View all campaigns";

/** Stated so a truncated strip is never mistaken for the whole list. */
export function showingSome(shown: number, total: number): string {
  return `Showing ${shown} of ${total}.`;
}

export const CAMPAIGNS_DID_NOT_LOAD_TITLE = "Campaigns did not load";
export const CAMPAIGNS_DID_NOT_LOAD_BODY =
  "Your campaigns could not be loaded just now. Refresh to try again.";

/* ---------------------------------------------------------------------------
 * Latest receipt
 * ------------------------------------------------------------------------- */

/**
 * One row rather than a list: it answers "did that actually go through?" — the question
 * a person asks straight after submitting — and the history section owns everything
 * beyond it.
 */
export const LATEST_RECEIPT_TITLE = "Latest receipt";
export const LATEST_RECEIPT_ACTION = "View all";
export const LATEST_RECEIPT_EMPTY_TITLE = "No receipts yet";
export const LATEST_RECEIPT_EMPTY_BODY =
  "Receipts you submit will appear here straight away.";

/* ---------------------------------------------------------------------------
 * The primary action
 * ------------------------------------------------------------------------- */

export const ADD_RECEIPT = "Add receipt";

/** The accessible name, which has room for the phrase the two-word button does not. */
export const ADD_RECEIPT_SEMANTIC_LABEL = "Add a receipt to submit";

/**
 * The supporting line under the action.
 *
 * "to qualify" and NOT "to earn": submitting a receipt makes a sale eligible for
 * evaluation. Whether it earns anything is decided by verification and by the campaign,
 * neither of which this button performs.
 */
export const ADD_RECEIPT_HINT = "Submit your sale to qualify";
