/**
 * PURE MODULE — no imports, no I/O, no `next/*`, no Supabase client, no Node built-in.
 *
 * THE ONE PLACE A REJECTED SERVER ACTION IS CLASSIFIED.
 *
 * A Server Action call can end in three different ways, and only one of them is a
 * failure:
 *
 *   it resolved                 the action ran and returned its own typed state
 *   it rejected with CONTROL    the framework is navigating — redirect(), notFound(),
 *     FLOW                      and their relatives signal by throwing
 *   it rejected for real        a dropped connection, a timeout, a request the framework
 *                               refused at its own boundary (HTTP 413), a server fault
 *
 * ⚠️ THE SECOND CASE IS WHY THIS MODULE EXISTS, AND IT IS EASY TO GET WRONG.
 *   In the installed Next.js (16.2.10) a Server Action that calls redirect() does NOT
 *   resolve its promise. `serverActionReducer` reads the redirect off the response and
 *   calls `reject(createRedirectErrorForAction(...))` — see the
 *   `if (redirectLocation !== undefined) { … reject(redirectError) }` branch in
 *   next/dist/client/components/router-reducer/reducers/server-action-reducer.js, whose
 *   own comment reads "the action promise will be rejected with a redirect".
 *
 *   So a bare `catch` around a Server Action swallows /login and
 *   /retailer-access-denied and reports them as an upload problem — an operational
 *   sentence shown for an authorization outcome, which is the exact class of
 *   mis-description the receipt milestone exists to remove.
 *
 * HOW IT IS AVOIDED, AND WHY NOT BY READING THE ERROR.
 *   `rethrowControlFlow` is called FIRST, before anything is classified. In production
 *   it is Next.js's own `unstable_rethrow` from next/navigation — the framework's
 *   documented helper for exactly this situation, which re-throws its internal errors
 *   (redirect, permanentRedirect, notFound/forbidden/unauthorized, bailout-to-CSR, and
 *   the dynamic-rendering interrupts) and returns silently for everything else. It also
 *   follows `error.cause`, so a control-flow error wrapped by another library still
 *   escapes.
 *
 *   Nothing here inspects a digest, a status code or a message. Matching Next.js
 *   internals by hand is how this breaks silently on an upgrade; the supported helper is
 *   the framework's promise to keep it working.
 *
 * WHY THE HELPER IS A PARAMETER RATHER THAN AN IMPORT.
 *   `next/navigation` has no Node-resolvable ESM entry point, so a module importing it
 *   cannot be loaded by this repository's `node --experimental-strip-types` test runner
 *   — the same constraint that already keeps lib/ modules dependency-free. Passing it in
 *   keeps this module pure AND lets the test drive it with the REAL `unstable_rethrow`
 *   and REAL redirect errors taken from the installed package, rather than a stand-in.
 *   That the browser wires up the genuine helper is pinned separately, at source level,
 *   by ./receipt-upload-error-routing.test.ts.
 *
 * THE THROWN VALUE IS NEVER BOUND INTO A RESULT. `operationalFailureState` is a value
 * the caller built before the call, from constants. This module has no way to put an
 * exception's message, stack or digest into what it returns, and it logs nothing —
 * which matters because this runs in the browser, where a console call would put
 * framework internals somewhere any extension can read.
 *
 * IT NEVER RETRIES. `submit` is invoked exactly once on every path. A receipt upload is
 * a mutation with no idempotency contract, so a second send is a second reservation.
 */

export type GuardedSubmissionOptions<TState> = {
  /** The Server Action call. Invoked exactly once. */
  readonly submit: () => Promise<TState | undefined>;
  /**
   * Re-throws framework control-flow errors and returns for everything else.
   *
   * In production this is `unstable_rethrow` from next/navigation, passed by value.
   */
  readonly rethrowControlFlow: (error: unknown) => void;
  /**
   * Returned when the action resolves with nothing.
   *
   * Defensive: a resolved-but-empty action result would otherwise render the form
   * against a missing state object.
   */
  readonly previousState: TState;
  /** Returned for a genuine operational failure. Built from constants by the caller. */
  readonly operationalFailureState: TState;
};

/**
 * Runs one Server Action call and turns its outcome into a state, without ever
 * absorbing a navigation the framework has begun.
 */
export async function runGuardedSubmission<TState>({
  submit,
  rethrowControlFlow,
  previousState,
  operationalFailureState,
}: GuardedSubmissionOptions<TState>): Promise<TState> {
  try {
    return (await submit()) ?? previousState;
  } catch (error) {
    // FIRST, and unconditionally. If this is the framework navigating, it throws here
    // and nothing below runs.
    rethrowControlFlow(error);

    // Only a genuine operational failure reaches this line. `error` is deliberately not
    // read, logged, or placed in the result.
    return operationalFailureState;
  }
}
