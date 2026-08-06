import Link from "next/link";
import { cardClasses } from "@/components/ui/card";
import { CountUp } from "@/components/ui/count-up";
import { IconDisc, StatPill } from "@/components/ui/surfaces";
import {
  CalendarIcon,
  ChevronRightIcon,
  ReceiptIcon,
  RewardIcon,
} from "@/components/ui/icons";
import {
  NOT_A_WALLET_NOTICE,
  formatCoins,
} from "@/lib/earnings/earnings-presentation";
import {
  COINS_TITLE,
  COINS_UNAVAILABLE,
  REWARDED_SALES_LABEL,
  THIS_MONTH_LABEL,
} from "@/lib/sales-staff/home-copy";
import type { EarningsSummary } from "@/lib/earnings/earnings-normalization";

/**
 * The campaign coins a seller has EARNED, as a compact strip.
 *
 * ============================================================================
 * WHY THIS IS NOT THE HERO
 * ============================================================================
 * Giving this figure the full-width panel and the 30px numeral would make "what have I
 * already earned?" the loudest question on a screen whose job is "what should I do next?".
 * It is a single row below the next-reward hero, and deliberately quieter than it.
 *
 * ============================================================================
 * EARNED, AND SAID SO
 * ============================================================================
 * The strip carries the same notice the earnings screen shows, stating that wallet,
 * payout and redemption do not exist yet. Nothing here is netted off anything, because
 * there is nothing to net: the figure is a sum over immutable reward rows, computed by
 * the summary RPC and never in TypeScript.
 *
 * ============================================================================
 * ZERO IS A REAL ANSWER; UNAVAILABLE IS A DIFFERENT ONE
 * ============================================================================
 * A seller who has earned nothing sees `0 coins`, with the same wording as everybody
 * else. A summary that could not be READ says so instead — "you earned nothing" and "we
 * could not tell" are opposite claims, and rendering the second as zeros would be a lie
 * about money.
 */
export function CoinsPanel({
  summary,
  unavailable,
}: {
  summary: EarningsSummary | null;
  unavailable: boolean;
}) {
  return (
    <div className={cardClasses("interactive", "relative p-5")}>
      <div className="flex items-center gap-3">
        <IconDisc
          tone="indigo"
          size={44}
          icon={<RewardIcon className="h-5 w-5" />}
        />

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-slate-500">{COINS_TITLE}</p>

          {summary === null ? (
            <p className="mt-0.5 text-sm font-medium text-slate-400">
              {COINS_UNAVAILABLE}
            </p>
          ) : (
            <p className="mt-0.5 truncate text-lg font-semibold tabular-nums tracking-tight text-slate-900">
              {/* One accessible utterance for the whole figure: a count-up announced
                  frame by frame would read out a dozen numbers on the way to the real
                  one. The visible text animates; the label does not. */}
              <span className="sr-only">
                {COINS_TITLE}: {formatCoins(summary.totalRewardCoins)} coins
              </span>
              <span aria-hidden="true">
                <CountUp value={summary.totalRewardCoins} suffix=" coins" />
              </span>
            </p>
          )}
        </div>

        <ChevronRightIcon
          className="h-5 w-5 shrink-0 text-slate-400"
          aria-hidden="true"
        />
      </div>

      {summary !== null && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <StatPill
            label={THIS_MONTH_LABEL}
            value={`${formatCoins(summary.currentMonthRewardCoins)} coins`}
            icon={<CalendarIcon className="h-3.5 w-3.5" />}
          />
          <StatPill
            label={REWARDED_SALES_LABEL}
            value={`${formatCoins(summary.rewardedSaleCount)}`}
            icon={<ReceiptIcon className="h-3.5 w-3.5" />}
          />
        </div>
      )}

      {/* The qualifying notice, so nobody reads a coin total before learning there is
          nowhere to spend it yet. */}
      <p className="mt-3 text-xs text-slate-500">{NOT_A_WALLET_NOTICE}</p>

      {/* The whole card opens the earnings screen. Placed last so the visible order and
          the tab order agree, and covering the card via `after:inset-0`. */}
      <Link
        href="/retailer/my-earnings"
        className="mt-3 inline-flex items-center gap-1 rounded text-sm font-medium text-indigo-600 outline-none after:absolute after:inset-0 hover:text-indigo-700 focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        View my earnings
      </Link>

      {/* Unavailability is stated inside the panel rather than as a screen-wide failure:
          the campaigns above came from a different contract and are unaffected. */}
      {unavailable && summary === null && (
        <p className="sr-only" role="status">
          {COINS_UNAVAILABLE}
        </p>
      )}
    </div>
  );
}
