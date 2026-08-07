"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  pollReceiptExtractionAction,
  retryReceiptExtractionAction,
} from "@/app/(retailer)/retailer/receipts/extraction-actions";
import {
  EXTRACTION_CHECK_AGAIN_LABEL,
  EXTRACTION_FAILED_FALLBACK_MESSAGE,
  EXTRACTION_FAILED_TITLE,
  EXTRACTION_FAILURE_MESSAGES,
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
import { runExtractionPollLoop } from "@/lib/receipts/receipt-extraction-poll-loop";
import { shouldOfferRetry } from "@/lib/receipts/receipt-extraction-polling";
import { formatMinorAmount } from "@/lib/receipts/receipt-extraction-display";
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

export function ReceiptExtractionPanel({ submissionId }: ReceiptExtractionPanelProps) {
  const [view, setView] = useState<ExtractionView | null>(null);
  const [phase, setPhase] = useState<PanelPhase>("watching");
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
        // progress state.
        setView(null);
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

  const settledStatus = phase === "settled" ? view?.status ?? null : null;

  if (settledStatus === "SUCCEEDED" && view !== null) {
    return <SucceededPanel view={view} />;
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

function SucceededPanel({ view }: { view: ExtractionView }) {
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

      {view.lineItemCount > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          {view.lineItemCount} item{view.lineItemCount === 1 ? "" : "s"} were read from this
          receipt.
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
