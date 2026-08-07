import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  EXTRACTION_MAX_POLLS,
  EXTRACTION_POLL_INTERVAL_MS,
  decideAfterPoll,
  isOpenExtractionStatus,
  shouldOfferRetry,
  type ExtractionPollOutcome,
  type PolledExtraction,
} from "./receipt-extraction-polling.ts";
import {
  runExtractionPollLoop,
  type ExtractionPollLoopPorts,
} from "./receipt-extraction-poll-loop.ts";
import type { ExtractionStatus } from "./receipt-extraction-vocabulary.ts";

/**
 * The polling decision and the loop that obeys it.
 *
 * EVERY EFFECT IS INJECTED, so these tests run in milliseconds against a fake clock rather
 * than spending the two real minutes a full budget would take. Nothing here touches a
 * network, a Supabase client, a database or a rendered tree.
 *
 * The properties under test are the ones that make the difference between a reading that
 * completes and one that silently rots into WORKER_ABANDONED — and, on the other side,
 * between a bounded loop and a client that hammers an endpoint forever.
 */

function view(
  status: ExtractionStatus,
  retryAllowed = false,
): ExtractionPollOutcome<PolledExtraction> {
  return { status: "ok", view: { status, retryAllowed } };
}

/** A recording harness: a scripted sequence of outcomes and a clock that never sleeps. */
function harness(script: ExtractionPollOutcome<PolledExtraction>[], maxPolls?: number) {
  const calls: string[] = [];
  const delays: number[] = [];
  let cancelled = false;
  let polls = 0;
  /** Counts polls that were in flight simultaneously; must never exceed 1. */
  let inFlight = 0;
  let maxInFlight = 0;

  const ports: ExtractionPollLoopPorts<PolledExtraction> = {
    poll: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A real await, so an overlapping caller would be observable here.
      await Promise.resolve();
      inFlight -= 1;
      const next = script[polls] ?? script[script.length - 1];
      polls += 1;
      return next;
    },
    delay: async (ms) => {
      delays.push(ms);
    },
    isCancelled: () => cancelled,
    onOutcome: (outcome) => calls.push(`outcome:${outcome.status}`),
    onSettled: (status) => calls.push(`settled:${status}`),
    onBudgetSpent: () => calls.push("budget-spent"),
    onStop: (reason) => calls.push(`stop:${reason}`),
  };

  return {
    ports,
    calls,
    delays,
    cancel: () => {
      cancelled = true;
    },
    pollCount: () => polls,
    maxInFlight: () => maxInFlight,
    run: (options = {}) => runExtractionPollLoop(ports, { maxPolls, ...options }),
  };
}

describe("the poll cadence and budget are the Flutter client's", () => {
  test("the interval is three seconds", () => {
    assert.equal(EXTRACTION_POLL_INTERVAL_MS, 3_000);
  });

  test("the budget is forty polls, which is about two minutes", () => {
    assert.equal(EXTRACTION_MAX_POLLS, 40);
    assert.equal((EXTRACTION_MAX_POLLS * EXTRACTION_POLL_INTERVAL_MS) / 1000, 120);
  });

  test("QUEUED and PROCESSING are the open states, and only those", () => {
    assert.equal(isOpenExtractionStatus("QUEUED"), true);
    assert.equal(isOpenExtractionStatus("PROCESSING"), true);
    assert.equal(isOpenExtractionStatus("SUCCEEDED"), false);
    assert.equal(isOpenExtractionStatus("FAILED"), false);
  });
});

describe("decideAfterPoll", () => {
  test("QUEUED polls again, on the shared interval", () => {
    assert.deepEqual(decideAfterPoll(view("QUEUED"), 1, 40), {
      kind: "poll-again",
      delayMs: EXTRACTION_POLL_INTERVAL_MS,
    });
  });

  test("PROCESSING polls again", () => {
    assert.deepEqual(decideAfterPoll(view("PROCESSING"), 5, 40), {
      kind: "poll-again",
      delayMs: EXTRACTION_POLL_INTERVAL_MS,
    });
  });

  test("SUCCEEDED settles and stops", () => {
    assert.deepEqual(decideAfterPoll(view("SUCCEEDED"), 2, 40), {
      kind: "settled",
      status: "SUCCEEDED",
    });
  });

  test("FAILED settles and stops", () => {
    assert.deepEqual(decideAfterPoll(view("FAILED"), 2, 40), {
      kind: "settled",
      status: "FAILED",
    });
  });

  test("a spent budget on an OPEN attempt is budget-spent, never a failure", () => {
    const decision = decideAfterPoll(view("PROCESSING"), 40, 40);
    assert.deepEqual(decision, { kind: "budget-spent" });
    // The distinction this whole milestone turns on: it is not `settled`, and it carries
    // no status, so nothing downstream can render it as a failed reading.
    assert.notEqual(decision.kind, "settled");
  });

  test("a terminal status still settles even when the budget is exactly spent", () => {
    assert.deepEqual(decideAfterPoll(view("SUCCEEDED"), 40, 40), {
      kind: "settled",
      status: "SUCCEEDED",
    });
  });

  test("unauthorized stops the loop", () => {
    assert.deepEqual(decideAfterPoll({ status: "unauthorized" }, 1, 40), {
      kind: "stop",
      reason: "unauthorized",
    });
  });

  test("not-found stops the loop", () => {
    assert.deepEqual(decideAfterPoll({ status: "not-found" }, 1, 40), {
      kind: "stop",
      reason: "not-found",
    });
  });

  test("a transient failure keeps polling rather than ending the run", () => {
    assert.deepEqual(decideAfterPoll({ status: "unavailable" }, 3, 40), {
      kind: "poll-again",
      delayMs: EXTRACTION_POLL_INTERVAL_MS,
    });
  });

  test("a transient failure at the end of the budget is budget-spent, not failed", () => {
    assert.deepEqual(decideAfterPoll({ status: "unavailable" }, 40, 40), {
      kind: "budget-spent",
    });
  });
});

describe("shouldOfferRetry trusts the backend and nothing else", () => {
  test("retry is offered when retry_allowed is true", () => {
    assert.equal(shouldOfferRetry({ status: "FAILED", retryAllowed: true }), true);
  });

  test("retry is hidden when retry_allowed is false", () => {
    assert.equal(shouldOfferRetry({ status: "FAILED", retryAllowed: false }), false);
  });

  test("retry is hidden when there is no view at all", () => {
    assert.equal(shouldOfferRetry(null), false);
  });

  test("the decision reads ONE field, so no attempt arithmetic can creep in", () => {
    // A view carrying a tempting `attemptsRemaining` must still be refused when the
    // backend said no. The extra field is ignored because the function cannot see it.
    const tempting = {
      status: "FAILED" as const,
      retryAllowed: false,
      attemptsRemaining: 2,
    };
    assert.equal(shouldOfferRetry(tempting), false);
  });
});

describe("the loop", () => {
  test("QUEUED -> PROCESSING -> SUCCEEDED polls three times and then stops", async () => {
    const h = harness([view("QUEUED"), view("PROCESSING"), view("SUCCEEDED")]);
    await h.run();

    assert.equal(h.pollCount(), 3);
    assert.deepEqual(h.calls, [
      "outcome:ok",
      "outcome:ok",
      "outcome:ok",
      "settled:SUCCEEDED",
    ]);
  });

  test("PROCESSING -> FAILED stops on the failure", async () => {
    const h = harness([view("PROCESSING"), view("FAILED")]);
    await h.run();

    assert.equal(h.pollCount(), 2);
    assert.equal(h.calls.at(-1), "settled:FAILED");
  });

  test("SUCCEEDED on the first poll stops immediately", async () => {
    const h = harness([view("SUCCEEDED")]);
    await h.run();

    assert.equal(h.pollCount(), 1);
    assert.deepEqual(h.calls, ["outcome:ok", "settled:SUCCEEDED"]);
  });

  test("an attempt that never settles spends exactly the budget and no more", async () => {
    const h = harness([view("PROCESSING")], 5);
    await h.run();

    assert.equal(h.pollCount(), 5);
    assert.equal(h.calls.at(-1), "budget-spent");
    // Never fabricated into a failure.
    assert.equal(
      h.calls.some((call) => call.startsWith("settled:")),
      false,
    );
  });

  test("waits the shared interval between polls, and only between them", async () => {
    const h = harness([view("QUEUED"), view("QUEUED"), view("SUCCEEDED")]);
    await h.run({ beginDelayMs: 0 });

    // One opening yield, then one wait after each non-terminal poll. The terminal poll
    // is not followed by a wait.
    assert.deepEqual(h.delays, [0, EXTRACTION_POLL_INTERVAL_MS, EXTRACTION_POLL_INTERVAL_MS]);
  });

  test("polls are strictly sequential — never two in flight", async () => {
    const h = harness([view("QUEUED"), view("QUEUED"), view("QUEUED"), view("SUCCEEDED")]);
    await h.run();

    assert.equal(h.maxInFlight(), 1);
  });

  test("cancelling before the first poll sends no request at all", async () => {
    const h = harness([view("QUEUED")]);
    h.cancel();
    await h.run();

    // This is the React Strict Mode property: the discarded run never reaches the network.
    assert.equal(h.pollCount(), 0);
    assert.deepEqual(h.calls, []);
  });

  test("cancelling mid-flight reports nothing and schedules nothing", async () => {
    const h = harness([view("QUEUED"), view("QUEUED")]);
    const running = h.run();
    h.cancel();
    await running;

    // At most the one poll that was already in flight; no callback, so no state update
    // can land on an unmounted component.
    assert.ok(h.pollCount() <= 1);
    assert.deepEqual(h.calls, []);
  });

  test("unauthorized ends the run without spending the rest of the budget", async () => {
    const h = harness([{ status: "unauthorized" }], 40);
    await h.run();

    assert.equal(h.pollCount(), 1);
    assert.deepEqual(h.calls, ["outcome:unauthorized", "stop:unauthorized"]);
  });

  test("not-found ends the run", async () => {
    const h = harness([{ status: "not-found" }], 40);
    await h.run();

    assert.equal(h.pollCount(), 1);
    assert.deepEqual(h.calls, ["outcome:not-found", "stop:not-found"]);
  });

  test("a network blip is survived and the reading still completes", async () => {
    const h = harness([
      view("QUEUED"),
      { status: "unavailable" },
      { status: "unavailable" },
      view("SUCCEEDED"),
    ]);
    await h.run();

    assert.equal(h.pollCount(), 4);
    assert.equal(h.calls.at(-1), "settled:SUCCEEDED");
  });

  test("the loop has NO port that could create an extraction attempt", () => {
    // Structural, and the point of the whole design: a transient failure cannot consume
    // one of a receipt's three attempts because nothing reachable from the loop can ask
    // for one. The port surface is exactly these seven names.
    const h = harness([view("SUCCEEDED")]);
    assert.deepEqual(Object.keys(h.ports).sort(), [
      "delay",
      "isCancelled",
      "onBudgetSpent",
      "onOutcome",
      "onSettled",
      "onStop",
      "poll",
    ]);
  });

  test("a persistent outage never settles and never retries — it spends the budget", async () => {
    const h = harness([{ status: "unavailable" }], 4);
    await h.run();

    assert.equal(h.pollCount(), 4);
    assert.equal(h.calls.at(-1), "budget-spent");
    assert.equal(
      h.calls.some((call) => call.startsWith("settled:")),
      false,
    );
  });
});
