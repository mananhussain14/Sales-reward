"use client";

import { useActionState, useCallback, useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { evaluateReceiptCampaignsAction } from "@/app/(review)/review/[receiptSubmissionId]/campaign-evaluation-actions";
import {
  type CampaignEvaluationActionState,
  INITIAL_CAMPAIGN_EVALUATION_ACTION_STATE,
} from "@/app/(review)/review/[receiptSubmissionId]/campaign-evaluation-action-state";
import {
  panelState,
  shouldRefreshAfterEvaluation,
  NO_CAMPAIGNS_MESSAGE,
  PENDING_MESSAGE,
  REFRESHING_MESSAGE,
} from "@/lib/review/campaign-evaluation-settlement";
import {
  capReduction,
  formatAwardedAt,
  formatCoins,
  groupQualifyingItems,
  hasReward,
  isQualifiedWithoutReward,
  itemsForResult,
  outcomeLabel,
  outcomeTone,
  productSourceLabel,
  reasonLabel,
  ruleTypeLabel,
  saleTimeStatusLabel,
  CAP_REDUCED_MESSAGE,
  TARGET_BONUS_NOT_AWARDED_MESSAGE,
  type CampaignQualifyingItem,
  type CampaignResult,
} from "@/lib/review/campaign-evaluation-display";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonClasses } from "@/components/ui/button";

/**
 * What this sale earned — Phase 2A-F.
 *
 * ============================================================================
 * A FIFTH SEPARATE FACT ON ONE PAGE
 * ============================================================================
 * The decision panel says the IMAGE was verified. The qualification panel says the
 * record is not excluded. The sale-header panel says WHEN and FOR HOW MUCH. The
 * product panel says WHAT was sold. This one says WHAT IT EARNED. All five are true
 * at once and none overwrites another.
 *
 * ============================================================================
 * NOTHING HERE COMPUTES A REWARD
 * ============================================================================
 * Every coin value shown is read from `get_receipt_campaign_results`, which returns
 * the immutable `campaign_rewards` row. This component multiplies nothing and
 * compares no threshold. It also never sees a verified sale id: the whole feature is
 * keyed on the receipt, which is what the route already holds.
 *
 * ============================================================================
 * EVALUATION IS DELIBERATE, AND REPEATABLE
 * ============================================================================
 * It never runs on page load — a reviewer presses the button. Pressing it again is
 * safe and expected: Migration 68 is same-result idempotent, and the second press
 * says so in words rather than reporting a new reward.
 */
export function CampaignEvaluationPanel({
  receiptSubmissionId,
  canEvaluate,
  blockedReason,
  results,
  items,
}: {
  receiptSubmissionId: string;
  /** Whether the receipt currently offers the action. Usability only — the database re-checks everything. */
  canEvaluate: boolean;
  /** Why the action is not offered, when it is not. */
  blockedReason: "no-sale" | "excluded" | null;
  /** `null` when the read FAILED — never "no campaigns". */
  results: CampaignResult[] | null;
  /** `null` when the read failed. */
  items: CampaignQualifyingItem[] | null;
}) {
  const [state, formAction, pending] = useActionState<
    CampaignEvaluationActionState,
    FormData
  >(
    evaluateReceiptCampaignsAction,
    INITIAL_CAMPAIGN_EVALUATION_ACTION_STATE,
  );

  // ==========================================================================
  // SETTLEMENT: outcome first, refresh second
  // ==========================================================================
  // The action revalidates nothing, so `pending` clears as soon as the database
  // answers. The panel shows that answer, and only then asks the server for fresh
  // data. `router.refresh()` merges the new payload without discarding client state,
  // so the message the reviewer is reading survives it.
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
  const refreshRequested = useRef(false);

  const refreshCampaignResults = useCallback(() => {
    startRefresh(() => {
      router.refresh();
    });
  }, [router]);

  useEffect(() => {
    // A FAILED attempt must not refresh: it changed nothing, and re-rendering would
    // replace the error the reviewer is reading with a page that looks untouched.
    if (!shouldRefreshAfterEvaluation(state)) return;
    if (refreshRequested.current) return;
    refreshRequested.current = true;
    refreshCampaignResults();
  }, [state, refreshCampaignResults]);

  // A second deliberate press is legitimate, so the guard is re-armed once a refresh
  // has completed rather than latched forever.
  useEffect(() => {
    if (state.outcome === null) refreshRequested.current = false;
  }, [state.outcome]);

  const view = panelState({
    storedResults: results,
    lastOutcome: state.outcome,
    canEvaluate,
  });

  const grouped = groupQualifyingItems(results ?? [], items ?? []);

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
      aria-labelledby="campaign-evaluation-heading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="campaign-evaluation-heading"
          className="text-sm font-semibold text-slate-900"
        >
          Campaign evaluation
        </h2>
        {view === "evaluated" ? (
          <Badge tone="slate">
            {results?.length === 1
              ? "1 campaign"
              : `${results?.length ?? 0} campaigns`}
          </Badge>
        ) : null}
        {view === "zero-campaigns" ? (
          <Badge tone="slate">No campaigns</Badge>
        ) : null}
      </div>

      {/* ---------------- The read failed ---------------------------------- */}
      {view === "unavailable" ? (
        <>
          <Alert tone="warning" className="mt-3">
            Campaign results for this receipt are temporarily unavailable. Nothing
            has changed, and no evaluation is assumed either way. The review
            decision, qualification state, sale header and products above are
            unaffected.
          </Alert>
          <div className="mt-3">
            <button
              type="button"
              onClick={refreshCampaignResults}
              disabled={isRefreshing}
              className={buttonClasses({ variant: "secondary" })}
            >
              {isRefreshing ? "Checking…" : "Check campaign results"}
            </button>
          </div>
        </>
      ) : null}

      {/* THE AUTHORITATIVE ANSWER, rendered before anything is re-fetched. */}
      {state.settled && state.message ? (
        <>
          <Alert
            tone={state.outcome === "EVALUATED" ? "success" : "info"}
            className="mt-3"
          >
            {state.message}
          </Alert>
          {isRefreshing ? (
            <p role="status" className="mt-3 text-xs text-slate-500">
              {REFRESHING_MESSAGE}
            </p>
          ) : null}
        </>
      ) : null}

      {/* A failure never clears the stored results below it. */}
      {state.formError ? (
        <Alert tone="error" role="alert" className="mt-3">
          {state.formError}
        </Alert>
      ) : null}

      {/* ---------------- Not offered yet ---------------------------------- */}
      {view === "not-ready" ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-slate-600">
            {blockedReason === "excluded" ? (
              <>
                <strong className="font-semibold text-slate-900">
                  Campaign evaluation is blocked.
                </strong>{" "}
                This receipt has an active qualification exclusion, so it cannot
                enter campaign qualification and cannot earn a reward.
              </>
            ) : (
              <>
                <strong className="font-semibold text-slate-900">
                  Finalize the sale first.
                </strong>{" "}
                Campaigns can only be evaluated once this receipt has an
                authoritative sale and an accepted product list.
              </>
            )}
          </p>
          <p className="text-xs text-slate-500">
            Nothing has been evaluated for this receipt, and no reward or coins
            exist for it.
          </p>
        </div>
      ) : null}

      {/* ---------------- Ready ------------------------------------------- */}
      {view === "ready" ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-slate-600">
            This sale has not been evaluated against any campaign in this session.
            Evaluating checks every campaign that was in force when the sale
            happened and records what it earned.
          </p>
          <p className="text-xs text-slate-500">
            Evaluation is safe to repeat: running it again returns the stored
            result and never creates a second reward.
          </p>
        </div>
      ) : null}

      {/* ---------------- Zero campaigns ---------------------------------- */}
      {view === "zero-campaigns" ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-slate-600">{NO_CAMPAIGNS_MESSAGE}</p>
          <p className="text-xs text-slate-500">
            No campaign was in force for this Retailer at the time of the sale, or
            none covered its products. This is a normal result, not a problem with
            the receipt.
          </p>
        </div>
      ) : null}

      {/* ---------------- The stored results ------------------------------ */}
      {view === "evaluated" && results !== null ? (
        <ol className="mt-4 space-y-3">
          {results.map((result) => (
            <CampaignResultCard
              key={`${result.campaignId}:${result.campaignVersionId}`}
              result={result}
              items={itemsForResult(result, grouped)}
            />
          ))}
        </ol>
      ) : null}

      {/* ---------------- The action -------------------------------------- */}
      {canEvaluate && view !== "unavailable" ? (
        <form
          action={formAction}
          className="mt-4 border-t border-slate-200 pt-4"
        >
          <input
            type="hidden"
            name="receiptSubmissionId"
            value={receiptSubmissionId}
          />
          <Button
            type="submit"
            variant="secondary"
            loading={pending}
            loadingLabel="Evaluating…"
            disabled={pending}
            aria-label="Evaluate campaigns for this verified sale"
          >
            {view === "evaluated" || view === "zero-campaigns"
              ? "Re-evaluate campaigns"
              : "Evaluate campaigns"}
          </Button>

          {pending ? (
            <p role="status" className="mt-3 text-sm text-slate-600">
              {PENDING_MESSAGE}
            </p>
          ) : null}

          <p className="mt-3 text-xs text-slate-500">
            Evaluation records what this sale earned. It creates no coin balance,
            no payout and no redemption, and it never changes the receipt&rsquo;s
            review decision.
          </p>
        </form>
      ) : null}
    </section>
  );
}

/** One campaign, its result, its reward and the products behind it. */
function CampaignResultCard({
  result,
  items,
}: {
  result: CampaignResult;
  items: CampaignQualifyingItem[];
}) {
  const reason = reasonLabel(result.nonQualificationReason);
  const rule = ruleTypeLabel(result.ruleType);
  const reduction = capReduction(result);
  const awarded = formatAwardedAt(result.awardedAt);

  return (
    <li className="rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="min-w-0 break-words font-medium text-slate-900">
          {result.campaignName ?? "Campaign name not recorded"}
        </h3>
        {/* The WORD carries the meaning; the tone only reinforces it. */}
        <Badge tone={outcomeTone(result.outcome)}>
          {outcomeLabel(result.outcome)}
        </Badge>
      </div>

      {reason ? <p className="mt-2 text-sm text-slate-600">{reason}</p> : null}

      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Cell label="Qualifying products">{result.qualifyingItemCount}</Cell>
        <Cell label="Qualifying units">{result.qualifyingUnits}</Cell>
        {rule ? <Cell label="Reward rule">{rule}</Cell> : null}
        {result.thresholdUnits !== null ? (
          <Cell label="Target threshold">{result.thresholdUnits} units</Cell>
        ) : null}
      </dl>

      {/* ---------------- The reward ------------------------------------- */}
      {hasReward(result) ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {result.coinsUncapped !== null ? (
              <Cell label="Coins earned">
                {formatCoins(result.coinsUncapped)}
              </Cell>
            ) : null}
            {reduction !== null ? (
              <Cell label="Reduced by cap">
                −{formatCoins(reduction)}
              </Cell>
            ) : null}
            <Cell label="Reward">
              <span className="font-semibold break-words">
                {formatCoins(result.rewardCoins)} coins
              </span>
            </Cell>
            {awarded ? <Cell label="Awarded">{awarded}</Cell> : null}
          </dl>
          {reduction !== null ? (
            <p className="mt-2 text-xs text-slate-500">{CAP_REDUCED_MESSAGE}</p>
          ) : null}
        </div>
      ) : null}

      {/* A QUALIFIED campaign with no reward is CORRECT for a target bonus that was
          not crossed by this sale. Never an error, never a missing value. */}
      {isQualifiedWithoutReward(result) ? (
        <p className="mt-3 text-sm text-slate-600">
          {TARGET_BONUS_NOT_AWARDED_MESSAGE}
        </p>
      ) : null}

      {/* ---------------- The qualifying products ------------------------ */}
      {items.length > 0 ? (
        <div className="mt-3 border-t border-slate-200 pt-3">
          <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Qualifying products
          </h4>
          <ul className="mt-2 space-y-2">
            {items.map((item) => (
              <QualifyingItemRow key={item.verifiedSaleItemId} item={item} />
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

/** One qualifying product, with the evidence that admitted it. */
function QualifyingItemRow({ item }: { item: CampaignQualifyingItem }) {
  const productStatus = saleTimeStatusLabel(item.productStatusAtSale);
  const assignmentStatus = saleTimeStatusLabel(item.assignmentStatusAtSale);

  return (
    <li className="rounded-lg border border-slate-200 p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 break-words text-sm text-slate-900">
          {item.lineNumber !== null ? (
            <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Line {item.lineNumber}
            </span>
          ) : null}
          {item.productNameAtProposal ?? "Product name not recorded"}
        </p>
        <p className="shrink-0 text-sm text-slate-800">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Units
          </span>{" "}
          <span className="font-semibold">{item.qualifyingUnits}</span>
        </p>
      </div>

      {item.productCodeAtProposal ? (
        <p className="mt-1 break-words text-xs text-slate-600">
          Product code: {item.productCodeAtProposal}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        <Badge tone="slate">{productSourceLabel(item.productSource)}</Badge>
        {/* Present only for LIVE_TEMPORAL. A SNAPSHOT row legitimately carries no
            sale-time status, and its absence is never rendered as missing data. */}
        {productStatus ? (
          <Badge tone="slate">Product {productStatus.toLowerCase()} at sale</Badge>
        ) : null}
        {assignmentStatus ? (
          <Badge tone="slate">
            Assignment {assignmentStatus.toLowerCase()} at sale
          </Badge>
        ) : null}
      </div>
    </li>
  );
}

function Cell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-slate-800">{children}</dd>
    </div>
  );
}
