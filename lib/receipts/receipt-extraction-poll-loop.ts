/**
 * PURE MODULE — no React, no timers of its own, no I/O, no environment.
 *
 * THE LOOP ITSELF, with every effect injected, so that the behaviour this milestone is
 * judged on can be tested in Node against a fake clock and a fake port rather than against
 * a rendered tree and two real minutes of wall time.
 *
 * ============================================================================
 * SEQUENTIAL BY CONSTRUCTION, NOT BY CAREFUL BOOKKEEPING
 * ============================================================================
 * There is no `setInterval` here and there is deliberately none in the component either.
 * The next poll is scheduled only after the previous one has RESOLVED, because an interval
 * fires on a schedule regardless of whether the last request came back — and against a
 * slow network that produces overlapping in-flight polls, out-of-order responses, and a
 * display that flickers backwards from PROCESSING to QUEUED. A sequential await cannot
 * overlap with itself, so the property is structural rather than defended.
 *
 * ============================================================================
 * ONE CANCELLATION SIGNAL, CHECKED AT EVERY SUSPENSION POINT
 * ============================================================================
 * `isCancelled()` is consulted before the loop starts, after every await, and before every
 * callback. A React effect cleanup, a navigation, or a superseding run flips it, and the
 * loop then returns without polling again and WITHOUT calling any callback — which is what
 * stops a state update landing on an unmounted component.
 *
 * It is checked before the FIRST poll too, and that is the part that makes React Strict
 * Mode safe: Strict Mode mounts, cleans up, and mounts again, so the discarded first run
 * is cancelled before its request is ever issued provided the caller yields once before
 * polling — which `beginDelayMs` exists to guarantee.
 *
 * ============================================================================
 * THE LOOP NEVER CREATES AN ATTEMPT
 * ============================================================================
 * There is no port here that requests an extraction. The only effect this module can have
 * on the world is calling `poll`, which reads. A transient failure therefore costs one
 * poll from the budget and nothing else — it can never consume one of the three attempts a
 * receipt gets, because nothing reachable from here is able to.
 */
import {
  EXTRACTION_MAX_POLLS,
  decideAfterPoll,
  type ExtractionPollOutcome,
  type PolledExtraction,
} from "./receipt-extraction-polling.ts";
import type { ExtractionStatus } from "./receipt-extraction-vocabulary.ts";

/**
 * What the loop reports as it goes. Every one of these is skipped once cancelled.
 *
 * `onOutcome` fires for EVERY poll including the failures, so the display can distinguish
 * "still reading" from "we couldn't reach the service just now" without the loop having to
 * decide what that looks like.
 */
export type ExtractionPollLoopPorts<TView extends PolledExtraction = PolledExtraction> = {
  /** Performs one poll. Must not throw; a fault is an `unavailable` outcome. */
  poll(): Promise<ExtractionPollOutcome<TView>>;
  /** Waits. Injected so tests need not spend real seconds. */
  delay(ms: number): Promise<void>;
  /** True once this run has been superseded, unmounted, or navigated away from. */
  isCancelled(): boolean;
  /** Every poll's result, in order. */
  onOutcome(outcome: ExtractionPollOutcome<TView>): void;
  /** A terminal status was reached. The loop has ended. */
  onSettled(status: ExtractionStatus): void;
  /** The budget ran out with the attempt still open. NOT a failure. */
  onBudgetSpent(): void;
  /** The loop ended because polling again cannot help. */
  onStop(reason: "unauthorized" | "not-found"): void;
};

export type ExtractionPollLoopOptions = {
  readonly maxPolls?: number;
  /**
   * How long to yield before the first poll.
   *
   * Non-zero by default so that a Strict Mode double-mount cancels the discarded run
   * BEFORE it issues a request, rather than after. Zero would still be correct — the
   * cancellation check would discard the response — but it would send a duplicate request
   * every mount in development, which is exactly the symptom this option removes.
   */
  readonly beginDelayMs?: number;
};

export const DEFAULT_BEGIN_DELAY_MS = 0;

/**
 * Polls until the reading settles, the budget is spent, or the run is cancelled.
 *
 * Resolves when the loop is over. It never rejects: `poll` is required not to throw, and
 * every branch below either returns or awaits.
 */
export async function runExtractionPollLoop<TView extends PolledExtraction>(
  ports: ExtractionPollLoopPorts<TView>,
  options: ExtractionPollLoopOptions = {},
): Promise<void> {
  const maxPolls = options.maxPolls ?? EXTRACTION_MAX_POLLS;
  const beginDelayMs = options.beginDelayMs ?? DEFAULT_BEGIN_DELAY_MS;

  // The yield that makes a superseded run harmless. See ExtractionPollLoopOptions.
  await ports.delay(beginDelayMs);
  if (ports.isCancelled()) return;

  let pollsUsed = 0;

  // `while (true)` with every exit written explicitly, rather than a condition that would
  // have to restate the decision function's rules a second time.
  for (;;) {
    const outcome = await ports.poll();
    pollsUsed += 1;

    // Checked immediately after the await: the component may have unmounted while the
    // request was in flight, and reporting now would update a dead tree.
    if (ports.isCancelled()) return;

    ports.onOutcome(outcome);

    const decision = decideAfterPoll(outcome, pollsUsed, maxPolls);

    if (decision.kind === "settled") {
      ports.onSettled(decision.status);
      return;
    }
    if (decision.kind === "budget-spent") {
      ports.onBudgetSpent();
      return;
    }
    if (decision.kind === "stop") {
      ports.onStop(decision.reason);
      return;
    }

    await ports.delay(decision.delayMs);
    if (ports.isCancelled()) return;
  }
}
