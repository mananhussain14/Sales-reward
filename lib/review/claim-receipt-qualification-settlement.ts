/**
 * PURE MODULE — no imports, no I/O, no Supabase client, no `next/*`.
 *
 * Maps one authoritative database outcome to the state the qualification panel
 * renders, and owns every sentence the reviewer reads about it.
 *
 * ============================================================================
 * WHY THIS IS A SEPARATE, PURE MODULE
 * ============================================================================
 * The Server Action cannot be invoked from a test — it is a `"use server"` file
 * that opens a Supabase client. Before this module existed, the only way to
 * check "does CONFLICT settle without claiming success?" was to read the
 * action's source and grep for a string, which proves the text exists somewhere
 * rather than that the mapping is right.
 *
 * Extracting the mapping makes every outcome a real assertion: call it, read the
 * result. The Server Action keeps the decisions that need a server (validation,
 * the RPC, the refusal path) and delegates the copy.
 *
 * ============================================================================
 * SETTLED IS NOT THE SAME AS SUCCEEDED
 * ============================================================================
 * Five outcomes end this form and only two of them wrote anything. All five mean
 * "the database has answered, stop offering to submit"; `outcome` carries which
 * one happened. `uncertain` is the opposite case and the reason this module
 * exists at all — see below.
 */

/** The five authoritative answers `record_claim_receipt_qualification` returns. */
export const QUALIFICATION_OUTCOMES = [
  "EXCLUDED",
  "ALREADY_EXCLUDED",
  "REINSTATED",
  "ALREADY_REINSTATED",
  "CONFLICT",
] as const;

export type QualificationSubmissionOutcome =
  (typeof QUALIFICATION_OUTCOMES)[number];

export function isQualificationOutcome(
  value: unknown,
): value is QualificationSubmissionOutcome {
  return (
    typeof value === "string" &&
    (QUALIFICATION_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * The reviewer could not be told what the database did.
 *
 * Deliberately NOT "nothing was recorded". A request that did not complete may
 * still have committed — the transaction is decided by the database, not by
 * whether the reply reached us. Telling a reviewer their exclusion definitely
 * failed, when it may have succeeded, is the one sentence most likely to produce
 * a duplicate attempt. So this says what is actually known, and points at the
 * only safe next step.
 */
export const UNCERTAIN_RESULT_MESSAGE =
  "We could not confirm whether this was recorded. Refresh the qualification " +
  "status below before trying again — if it already went through, submitting " +
  "again will not create a second event.";

/** The database refused: not a reviewer, lost the permission, or not classifiable. */
export const REFUSED_MESSAGE =
  "This receipt is no longer available for you to classify. Return to the queue and reload.";

/** A malformed id never reaches an RPC; the form only ever renders a server-supplied one. */
export const MALFORMED_REQUEST_MESSAGE =
  "Something went wrong on our side and nothing was sent. Please reload and try again.";

/**
 * Shown while the request is in flight and taking longer than usual.
 *
 * PRESENTATION ONLY. It cancels nothing, retries nothing and claims nothing —
 * it exists so a reviewer waiting on a slow round trip is told to wait rather
 * than left guessing and pressing the button again.
 */
export const SLOW_REQUEST_MESSAGE =
  "Still recording. Do not submit again. The result will be checked before another attempt.";

/** How long the request may run before the reviewer is told it is merely slow. */
export const SLOW_REQUEST_NOTICE_MS = 4000;

/** Shown once the outcome is on screen and the panel is re-reading the database. */
export const REFRESHING_MESSAGE =
  "Recorded. Refreshing the latest qualification status…";

/** What the panel renders after one authoritative answer. */
export type QualificationSettlement = {
  outcome: QualificationSubmissionOutcome;
  message: string;
  /** Always true here: every one of the five is a final answer. */
  settled: true;
  /** True only for outcomes that actually wrote an immutable event. */
  changed: boolean;
};

/**
 * The exact sentence for each authoritative outcome.
 *
 * Every one of them states what is now true rather than what the reviewer did,
 * because two of the five ("already…") describe a state somebody else's earlier
 * click produced, and CONFLICT describes one this click deliberately did not
 * touch. None of them promises a sale, a reward or a coin — none of those exist.
 */
export function settleQualificationOutcome(
  outcome: QualificationSubmissionOutcome,
): QualificationSettlement {
  switch (outcome) {
    case "EXCLUDED":
      return {
        outcome,
        settled: true,
        changed: true,
        message:
          "Recorded. This receipt cannot become an authoritative sale or earn a reward. Its VERIFIED review decision is unchanged.",
      };

    case "ALREADY_EXCLUDED":
      return {
        outcome,
        settled: true,
        changed: false,
        message:
          "You had already recorded this exclusion. Nothing was changed and no second event was created.",
      };

    case "REINSTATED":
      return {
        outcome,
        settled: true,
        changed: true,
        message:
          "Recorded as a new reversal event. The original exclusion remains in history. This does not create a sale or a reward.",
      };

    case "ALREADY_REINSTATED":
      return {
        outcome,
        settled: true,
        changed: false,
        message:
          "You had already reversed this exclusion. Nothing was changed and no second event was created.",
      };

    case "CONFLICT":
      // Nothing was written and nothing was overwritten. The other reviewer's
      // identity is never part of this sentence.
      return {
        outcome,
        settled: true,
        changed: false,
        message:
          "The qualification of this receipt was changed elsewhere, so nothing was recorded. The current state is shown below.",
      };
  }
}

/**
 * Whether the panel should re-read the server after this state.
 *
 * Only once the database has given a final answer. A validation failure has not
 * touched the database, and a request still in flight has not finished —
 * refreshing in either case would either waste a round trip or race the answer.
 */
export function shouldRefreshAfterSettlement(state: {
  settled: boolean;
  uncertain: boolean;
}): boolean {
  return state.settled && !state.uncertain;
}
