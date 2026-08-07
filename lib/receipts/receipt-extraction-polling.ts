/**
 * PURE MODULE — no I/O, no React, no timers, no environment, no Supabase client.
 * Its only import is a sibling type.
 *
 * THE POLLING DECISION, expressed once, so it can be tested without a browser.
 *
 * ============================================================================
 * WHY WEB HAS TO POLL AT ALL
 * ============================================================================
 * `get-receipt-extraction` is NOT a passive status endpoint. Calling it is what polls the
 * provider for a PROCESSING attempt and records the terminal SUCCEEDED or FAILED row. A
 * client that requests an extraction and then walks away leaves the attempt open until the
 * reaper expires it as WORKER_ABANDONED — the receipt is stored, but nothing our system
 * holds ever finishes the reading. Flutter already polls; the web did not, and that
 * asymmetry is the whole defect this module exists to close.
 *
 * So the loop below is not a convenience for the display. It is the mechanism by which a
 * reading completes at all, which is why the budget stops the LOOP and never the ATTEMPT:
 * see BUDGET below.
 *
 * ============================================================================
 * THE BUDGET DOES NOT FAIL ANYTHING
 * ============================================================================
 * A foreground loop must end — a tab left open for an hour must not hold a request
 * schedule forever — but "we stopped watching" and "the reading failed" are different
 * facts, and conflating them would tell a person their receipt could not be read when the
 * provider is still working on it and may yet succeed.
 *
 * `budget-spent` is therefore its own decision, distinct from `settled`. It carries no
 * failure code, sets no status, and the UI renders it as "still being read" with a
 * person-operated way to resume. Nothing about the attempt row changes when the budget
 * runs out, because this module cannot change anything.
 *
 * ============================================================================
 * ONLY THE BACKEND DECIDES A RETRY IS ALLOWED
 * ============================================================================
 * There is no attempt arithmetic here. `retryAllowed` is read from the response and obeyed;
 * this module never derives it from `attemptsRemaining`, never compares against
 * MAX_EXTRACTION_ATTEMPTS, and never offers a retry the backend did not offer. The database
 * conjunction behind that flag — FAILED, capacity, nothing active, nothing succeeded, no
 * confirmation, an executable runtime mode — is the authority, and re-deriving any part of
 * it on the client is how the two drift apart.
 */
import type { ExtractionStatus } from "./receipt-extraction-vocabulary.ts";

/**
 * How long to wait between polls, in milliseconds.
 *
 * Matches the Flutter client's 3-second cadence deliberately: one backend, one provider
 * and one rate profile, so two clients polling at different speeds would produce two
 * different load shapes against the same Azure operation for no reason.
 */
export const EXTRACTION_POLL_INTERVAL_MS = 3_000;

/**
 * The most polls one foreground run may spend.
 *
 * 40 × 3s ≈ two minutes, matching Flutter's `maxPolls`. It is a bound on ATTENTION, not on
 * the reading: see the module header.
 */
export const EXTRACTION_MAX_POLLS = 40;

/** The two statuses that mean the provider is still working. */
export const OPEN_POLL_STATUSES: readonly ExtractionStatus[] = ["QUEUED", "PROCESSING"];

/**
 * The closed result of one call to the poll port.
 *
 * `unavailable` is the union of every transient way a poll can fail — a dropped
 * connection, a gateway error, a 503, an unreadable body. It is deliberately NOT terminal:
 * a flaky network must not end the loop, and above all must not be mistaken for a failed
 * reading. See `decideAfterPoll`.
 */
export type ExtractionPollOutcome<TView extends PolledExtraction = PolledExtraction> =
  | { readonly status: "ok"; readonly view: TView }
  /** The caller is not signed in, or lost access. Terminal for this loop. */
  | { readonly status: "unauthorized" }
  /** No attempt exists for this receipt, or it is not the caller's. Terminal. */
  | { readonly status: "not-found" }
  /** Transport, gateway, or a body this build cannot read. NOT terminal. */
  | { readonly status: "unavailable" };

/**
 * The subset of the extraction view this decision needs.
 *
 * Structural, so the full `ExtractionView` satisfies it without a conversion. Nothing here
 * names a provider, an operation, a token, a path or a hash — those do not exist in the
 * client contract to begin with.
 */
export type PolledExtraction = {
  readonly status: ExtractionStatus;
  readonly retryAllowed: boolean;
};

/**
 * What the caller should do after one poll returns.
 *
 * `stop` means this loop is over and no further poll will help. `budget-spent` means the
 * attempt is still open and we have stopped WATCHING it.
 */
export type ExtractionPollDecision =
  | { readonly kind: "poll-again"; readonly delayMs: number }
  | { readonly kind: "settled"; readonly status: ExtractionStatus }
  | { readonly kind: "budget-spent" }
  | { readonly kind: "stop"; readonly reason: "unauthorized" | "not-found" };

export function isOpenExtractionStatus(status: ExtractionStatus): boolean {
  return OPEN_POLL_STATUSES.includes(status);
}

/**
 * Decides what follows one poll.
 *
 * @param outcome what the port returned.
 * @param pollsUsed how many polls this run has already SPENT, including the one whose
 *   outcome is being judged. The caller increments before asking.
 * @param maxPolls the budget, injected so tests need not spend two real minutes.
 *
 * A TRANSIENT FAILURE COSTS A POLL AND NOTHING ELSE. `unavailable` returns `poll-again`
 * while budget remains, so a tunnel or a dropped Wi-Fi frame does not end the run — and
 * critically, it does NOT request a new extraction. Creating an attempt is a separate,
 * person-initiated act; a retry loop that quietly consumed one of three attempts per
 * dropped packet is exactly the failure mode this branch is written to avoid.
 */
export function decideAfterPoll(
  outcome: ExtractionPollOutcome<PolledExtraction>,
  pollsUsed: number,
  maxPolls: number = EXTRACTION_MAX_POLLS,
): ExtractionPollDecision {
  if (outcome.status === "unauthorized") {
    return { kind: "stop", reason: "unauthorized" };
  }
  if (outcome.status === "not-found") {
    return { kind: "stop", reason: "not-found" };
  }

  // A terminal status ends the loop, and it is the ONLY thing that may.
  if (outcome.status === "ok" && !isOpenExtractionStatus(outcome.view.status)) {
    return { kind: "settled", status: outcome.view.status };
  }

  // Open, or a transient fault. Either way the question is only whether budget remains.
  if (pollsUsed >= maxPolls) {
    return { kind: "budget-spent" };
  }

  return { kind: "poll-again", delayMs: EXTRACTION_POLL_INTERVAL_MS };
}

/**
 * Whether a Retry control may be shown.
 *
 * ONE INPUT, AND IT IS THE BACKEND'S OWN FLAG. Written as a named function rather than
 * inlined at the call site so that the rule has one home and a future edit that tried to
 * widen it — `|| attemptsRemaining > 0`, say — has to be made here, in front of this
 * comment, rather than quietly in a JSX expression.
 */
export function shouldOfferRetry(view: PolledExtraction | null): boolean {
  return view !== null && view.retryAllowed === true;
}
