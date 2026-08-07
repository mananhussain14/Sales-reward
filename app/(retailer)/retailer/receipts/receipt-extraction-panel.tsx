"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  pollReceiptExtractionAction,
  readReceiptLineItemsAction,
  retryReceiptExtractionAction,
} from "@/app/(retailer)/retailer/receipts/extraction-actions";
import {
  EXTRACTION_CHECK_AGAIN_LABEL,
  EXTRACTION_FAILED_FALLBACK_MESSAGE,
  EXTRACTION_FAILED_TITLE,
  EXTRACTION_FAILURE_MESSAGES,
  EXTRACTION_ITEMS_LOADING_MESSAGE,
  EXTRACTION_ITEMS_UNAVAILABLE_MESSAGE,
  EXTRACTION_OFFLINE_MESSAGE,
  EXTRACTION_PROCESSING_BODY,
  EXTRACTION_PROCESSING_TITLE,
  EXTRACTION_QUEUED_BODY,
  EXTRACTION_QUEUED_TITLE,
  EXTRACTION_RETRY_LABEL,
  EXTRACTION_REVIEW_NEXT_STEP,
  EXTRACTION_SIGNED_OUT_MESSAGE,
  EXTRACTION_STILL_WORKING_BODY,
  EXTRACTION_STILL_WORKING_TITLE,
  EXTRACTION_SUCCEEDED_BODY,
  EXTRACTION_SUCCEEDED_TITLE,
  type ExtractionView,
} from "@/app/(retailer)/retailer/receipts/extraction-panel-state";
import { ReceiptLineItems } from "@/app/(retailer)/retailer/receipts/receipt-line-items";
import { runExtractionPollLoop } from "@/lib/receipts/receipt-extraction-poll-loop";
import { shouldOfferRetry } from "@/lib/receipts/receipt-extraction-polling";
import { formatMinorAmount } from "@/lib/receipts/receipt-extraction-display";
import { loadLineItemsForStatus } from "@/lib/receipts/receipt-line-item-load";
import {
  describeLineItems,
  lineItemsDetectedLabel,
} from "@/lib/receipts/receipt-line-item-view";
import type { LineItemView } from "@/lib/receipts/receipt-extraction-normalization";
import { Button } from "@/components/ui/button";
import { AlertTriangleIcon, CheckCircleIcon } from "@/components/ui/icons";

/**
 * The panel that follows one receipt's reading to a conclusion.
 *
 * ============================================================================
 * WHY THIS COMPONENT EXISTS AT ALL
 * ============================================================================
 * `get-receipt-extraction` is not a passive status endpoint: calling it is what polls the
 * provider for a PROCESSING attempt and records the terminal row. Before this component,
 * the web requested a reading and then stopped, so an attempt stayed open until the reaper
 * expired it as WORKER_ABANDONED. This panel is the web's half of that contract.
 *
 * ============================================================================
 * ALL DECISIONS LIVE OUTSIDE THIS FILE
 * ============================================================================
 * The cadence, the budget, whether to poll again, and whether a retry may be offered are
 * decided by two pure modules that are unit-tested directly. This component owns the
 * REFS and the RENDERING and nothing else, so a change to the polling rules cannot hide in
 * JSX.
 *
 * ============================================================================
 * ONE RUN AT A TIME, ENFORCED BY A GENERATION COUNTER
 * ============================================================================
 * `runRef` is incremented at the start of every effect run. A loop checks its own
 * generation at every suspension point through `isCancelled`, so a superseded run — a
 * Strict Mode double-mount, a Check again, a retry — cannot report into state or schedule
 * another poll. Combined with the loop's initial yield, the discarded Strict Mode run is
 * cancelled before it ever issues a request.
 *
 * ============================================================================
 * THE LINE-ITEM READ IS A SECOND, STRICTLY LATER REQUEST — NEVER A SECOND LOOP
 * ============================================================================
 * There is exactly one polling implementation here, and this milestone does not add another.
 * The items are read by a SINGLE request that is issued only after the loop has already
 * ENDED at SUCCEEDED, so the two can never be in flight together: the gate lives in
 * @/lib/receipts/receipt-line-item-load, which returns `skipped` without calling anything for
 * QUEUED, PROCESSING and FAILED. A second generation counter (`itemsRunRef`) protects that
 * request the way `runRef` protects the loop, so a Strict Mode double-mount or a retry cannot
 * leave two reads racing to set the same state.
 */

type ReceiptExtractionPanelProps = {
  /** The receipt to follow. Re-authorized on the server for every call it is used in. */
  readonly submissionId: string;
};

type PanelPhase =
  /** Polling, and the last poll told us the attempt is open. */
  | "watching"
  /** The reading finished, one way or the other. `view` carries which. */
  | "settled"
  /** The budget ran out while the attempt was still open. Not a failure. */
  | "budget-spent"
  /** The session lapsed. */
  | "signed-out"
  /** No attempt for this receipt, or not ours. */
  | "gone";

/**
 * The line-item read, as the panel holds it.
 *
 * `idle` and `loading` are DISTINCT from `unavailable`: a read still in flight must not be
 * rendered as one that failed, and a reading that has not settled yet has not been asked for
 * at all.
 */
type LineItemsState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ok"; readonly items: readonly LineItemView[] }
  | { readonly kind: "unavailable" };

export function ReceiptExtractionPanel({ submissionId }: ReceiptExtractionPanelProps) {
  const [view, setView] = useState<ExtractionView | null>(null);
  const [phase, setPhase] = useState<PanelPhase>("watching");
  const [lineItems, setLineItems] = useState<LineItemsState>({ kind: "idle" });
  /** True when the most recent poll could not reach the service. Cleared by the next one. */
  const [offline, setOffline] = useState(false);
  const [retrying, setRetrying] = useState(false);

  /**
   * Bumped to start a fresh run: Check again, and a successful retry.
   *
   * A number rather than a boolean so that a second Check again after a second budget
   * expiry is a DIFFERENT value and therefore actually re-runs the effect.
   */
  const [resumeToken, setResumeToken] = useState(0);

  /** The generation counter. See the component header. */
  const runRef = useRef(0);

  /** The same guarantee for the one line-item read. See the component header. */
  const itemsRunRef = useRef(0);

  useEffect(() => {
    const myRun = runRef.current + 1;
    runRef.current = myRun;

    // Two conditions, either of which ends the run. The cleanup below flips `cancelled`;
    // a newer effect run makes the generation check fail.
    let cancelled = false;
    const isCancelled = () => cancelled || runRef.current !== myRun;

    // NOTE: the phase is NOT reset here. Calling setState in an effect body causes a
    // cascading render, and it is unnecessary: a new receipt remounts this component (the
    // form keys it on the id), and the two things that resume a run — Check again and a
    // successful retry — are event handlers that reset the phase themselves, where a state
    // update is ordinary.
    void runExtractionPollLoop(
      {
        poll: () => pollReceiptExtractionAction(submissionId),
        delay: (ms) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            // Nothing to clear explicitly: the cancellation check after every await makes
            // a late-firing timer harmless, and the timer itself is garbage once resolved.
            void timer;
          }),
        isCancelled,
        onOutcome: (outcome) => {
          if (outcome.status === "ok") {
            setOffline(false);
            setView(outcome.view);
            return;
          }
          // A transient miss. The last known view is KEPT on screen rather than cleared —
          // blanking a receipt's details because one poll timed out would read as data
          // loss.
          if (outcome.status === "unavailable") setOffline(true);
        },
        onSettled: () => setPhase("settled"),
        onBudgetSpent: () => setPhase("budget-spent"),
        onStop: (reason) =>
          setPhase(reason === "unauthorized" ? "signed-out" : "gone"),
      },
      // A yield before the first poll, so a Strict Mode double-mount cancels the
      // discarded run before it sends anything.
      { beginDelayMs: 0 },
    );

    return () => {
      cancelled = true;
    };
  }, [submissionId, resumeToken]);

  /**
   * The status the loop SETTLED on, or null while it is still running.
   *
   * Derived rather than stored, and deliberately the only input the effect below keys on: it
   * changes exactly once per reading, so the read cannot be issued twice for one settlement,
   * and it is null for every open attempt, so nothing is issued while the loop is polling.
   */
  const settledStatus = phase === "settled" ? view?.status ?? null : null;

  useEffect(() => {
    // A reading that has not settled asks for nothing. FAILED settles too, and the gate in the
    // pure module answers `skipped` for it — there are no line items on a failed attempt.
    if (settledStatus === null) return;

    const myRun = itemsRunRef.current + 1;
    itemsRunRef.current = myRun;

    let cancelled = false;
    const isCancelled = () => cancelled || itemsRunRef.current !== myRun;

    void (async () => {
      const outcome = await loadLineItemsForStatus(settledStatus, {
        read: () => readReceiptLineItemsAction(submissionId),
      });

      // Checked after the await: this panel may have been superseded or unmounted while the
      // request was in flight, and reporting now would update a dead tree.
      if (isCancelled()) return;

      if (outcome.status === "skipped") {
        setLineItems({ kind: "idle" });
        return;
      }
      if (outcome.status === "ok") {
        setLineItems({ kind: "ok", items: outcome.lineItems });
        return;
      }
      // A lapsed session and a fault look identical here on purpose. The panel does not sign
      // the person out over a display read: the receipt is stored and was read, and the poll
      // path is the one that owns the signed-out state.
      setLineItems({ kind: "unavailable" });
    })();

    return () => {
      cancelled = true;
    };
  }, [settledStatus, submissionId, resumeToken]);

  const checkAgain = useCallback(() => {
    setOffline(false);
    setPhase("watching");
    setResumeToken((token) => token + 1);
  }, []);

  /**
   * The retry, and the ONE place an attempt can be created from this panel.
   *
   * `retrying` guards it so a double click cannot send two requests. The control is
   * rendered only when the backend's own `retry_allowed` is true, and the action does not
   * second-guess that flag — request_receipt_extraction is the authority and refuses every
   * case where another attempt must not exist.
   */
  const retry = useCallback(async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const result = await retryReceiptExtractionAction(submissionId);
      if (result.status === "requested") {
        // A fresh attempt exists, so the previous FAILED view must not linger behind the
        // progress state — nor may items read from an earlier attempt of this receipt.
        setView(null);
        setLineItems({ kind: "idle" });
        setPhase("watching");
        setResumeToken((token) => token + 1);
        return;
      }
      if (result.status === "unauthorized") {
        setPhase("signed-out");
        return;
      }
      setOffline(true);
    } finally {
      setRetrying(false);
    }
  }, [retrying, submissionId]);

  if (phase === "signed-out") {
    return <PanelShell tone="neutral">{EXTRACTION_SIGNED_OUT_MESSAGE}</PanelShell>;
  }

  // No attempt, or not ours. Nothing truthful can be said about a reading, so the panel
  // says nothing at all rather than inventing a state.
  if (phase === "gone") return null;

  if (settledStatus === "SUCCEEDED" && view !== null) {
    /* `loading` is DERIVED rather than stored: a succeeded reading whose items have not
       arrived yet is, by definition, the one still in flight. Storing it would mean calling
       setState synchronously from the effect above, which is a cascading render for a fact the
       existing state already implies. */
    return (
      <SucceededPanel
        view={view}
        lineItems={lineItems.kind === "idle" ? { kind: "loading" } : lineItems}
      />
    );
  }

  if (settledStatus === "FAILED" && view !== null) {
    return <FailedPanel view={view} onRetry={retry} retrying={retrying} />;
  }

  if (phase === "budget-spent") {
    return (
      <PanelShell tone="neutral" title={EXTRACTION_STILL_WORKING_TITLE}>
        <p className="text-sm text-slate-600">
          {offline ? EXTRACTION_OFFLINE_MESSAGE : EXTRACTION_STILL_WORKING_BODY}
        </p>
        <div className="mt-3">
          <Button type="button" variant="secondary" onClick={checkAgain}>
            {EXTRACTION_CHECK_AGAIN_LABEL}
          </Button>
        </div>
      </PanelShell>
    );
  }

  // Watching. QUEUED and PROCESSING get different sentences because they describe
  // genuinely different moments, and an unknown-yet attempt uses the QUEUED wording.
  const processing = view?.status === "PROCESSING";
  return (
    <PanelShell
      tone="busy"
      title={processing ? EXTRACTION_PROCESSING_TITLE : EXTRACTION_QUEUED_TITLE}
    >
      <p className="text-sm text-slate-600">
        {processing ? EXTRACTION_PROCESSING_BODY : EXTRACTION_QUEUED_BODY}
      </p>
    </PanelShell>
  );
}

/* ---------------------------------------------------------------------------
 * Presentation
 * ------------------------------------------------------------------------- */

function PanelShell({
  tone,
  title,
  children,
}: {
  tone: "busy" | "neutral" | "good" | "bad";
  title?: string;
  children: React.ReactNode;
}) {
  const toneClasses = {
    busy: "border-sky-200 bg-sky-50",
    neutral: "border-slate-200 bg-slate-50",
    good: "border-emerald-200 bg-emerald-50",
    bad: "border-amber-200 bg-amber-50",
  }[tone];

  return (
    <section
      role="status"
      aria-live="polite"
      className={`sr-animate-fade-in rounded-2xl border p-4 ${toneClasses}`}
    >
      {title && (
        <div className="flex items-center gap-2">
          {tone === "busy" && (
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-sky-300 border-t-sky-600"
            />
          )}
          {tone === "good" && <CheckCircleIcon className="h-5 w-5 text-emerald-600" />}
          {tone === "bad" && <AlertTriangleIcon className="h-5 w-5 text-amber-600" />}
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        </div>
      )}
      <div className={title ? "mt-1.5" : undefined}>{children}</div>
    </section>
  );
}

function SucceededPanel({
  view,
  lineItems,
}: {
  view: ExtractionView;
  lineItems: LineItemsState;
}) {
  const rows: Array<{ label: string; value: string }> = [];

  if (view.merchantName.value) rows.push({ label: "Merchant", value: view.merchantName.value });
  if (view.transactionDate.value)
    rows.push({ label: "Date", value: view.transactionDate.value });
  if (view.transactionTime.value)
    rows.push({ label: "Time", value: view.transactionTime.value });
  if (view.documentNumber.value)
    rows.push({ label: "Receipt no.", value: view.documentNumber.value });

  const money = (minor: number | null) =>
    formatMinorAmount(minor, view.currencyCode.value, view.currencyMinorUnit);

  const subtotal = money(view.subtotalMinor.value);
  const tax = money(view.taxTotalMinor.value);
  const total = money(view.totalMinor.value);

  if (subtotal) rows.push({ label: "Subtotal", value: subtotal });
  if (tax) rows.push({ label: "Tax", value: tax });
  if (total) rows.push({ label: "Total", value: total });

  return (
    <PanelShell tone="good" title={EXTRACTION_SUCCEEDED_TITLE}>
      <p className="text-sm text-emerald-900">{EXTRACTION_SUCCEEDED_BODY}</p>

      {rows.length > 0 ? (
        <dl className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-xs font-medium text-slate-500">{row.label}</dt>
              <dd className="text-sm font-semibold text-slate-900">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        // A SUCCEEDED attempt whose fields were all unreadable is a real outcome: the
        // provider answered, and nothing usable came back. Saying so is better than
        // rendering an empty list.
        <p className="mt-3 text-sm text-slate-600">
          We couldn&rsquo;t pick out any details from this one.
        </p>
      )}

      {/* THE ITEMS THEMSELVES, once the one authorized read has answered.
          Every line the contract returned is rendered — the count beside the heading is
          derived from that same array, so the number and the list cannot disagree. */}
      {lineItems.kind === "ok" && lineItems.items.length > 0 && (
        <ReceiptLineItems
          items={describeLineItems(
            lineItems.items,
            view.currencyCode.value,
            view.currencyMinorUnit,
          )}
        />
      )}

      {lineItems.kind === "loading" && view.lineItemCount > 0 && (
        <p className="mt-3 text-xs text-slate-500">{EXTRACTION_ITEMS_LOADING_MESSAGE}</p>
      )}

      {lineItems.kind === "unavailable" && (
        <p className="mt-3 text-xs text-slate-600">
          {EXTRACTION_ITEMS_UNAVAILABLE_MESSAGE}
        </p>
      )}

      {/* The stored count, for the two cases where the list itself is not on screen: the read
          could not be completed, or it answered with fewer than the attempt recorded. It states
          what the reader FOUND and never what the paper receipt contained. */}
      {view.lineItemCount > 0 &&
        (lineItems.kind === "unavailable" ||
          (lineItems.kind === "ok" && lineItems.items.length === 0)) && (
          <p className="mt-1 text-xs text-slate-500">
            {lineItemsDetectedLabel(view.lineItemCount)}
          </p>
        )}

      {view.warningCodes.length > 0 && (
        // The codes themselves are NOT rendered — they are an internal vocabulary. Their
        // presence is reported as a single, honest caution.
        <p className="mt-2 text-xs text-amber-700">
          Some values were unclear. Please double-check them against the paper receipt.
        </p>
      )}

      <p className="mt-3 text-xs text-slate-500">{EXTRACTION_REVIEW_NEXT_STEP}</p>
    </PanelShell>
  );
}

function FailedPanel({
  view,
  onRetry,
  retrying,
}: {
  view: ExtractionView;
  onRetry: () => void;
  retrying: boolean;
}) {
  const message =
    view.failureCode === null
      ? EXTRACTION_FAILED_FALLBACK_MESSAGE
      : EXTRACTION_FAILURE_MESSAGES[view.failureCode];

  return (
    <PanelShell tone="bad" title={EXTRACTION_FAILED_TITLE}>
      <p className="text-sm text-slate-700">{message}</p>

      {/* The ONLY condition. `retry_allowed` already encodes FAILED, capacity remaining,
          nothing active, nothing succeeded, no confirmation and an executable runtime —
          re-deriving any of that here would be a second, drifting copy of the rule. */}
      {shouldOfferRetry(view) && (
        <div className="mt-3">
          <Button
            type="button"
            variant="secondary"
            onClick={onRetry}
            loading={retrying}
            loadingLabel="Starting…"
          >
            {EXTRACTION_RETRY_LABEL}
          </Button>
        </div>
      )}

      <p className="mt-3 text-xs text-slate-500">{EXTRACTION_REVIEW_NEXT_STEP}</p>
    </PanelShell>
  );
}
