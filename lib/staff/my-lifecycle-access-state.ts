// SERVER-ONLY MODULE.
//
// The self-only lifecycle diagnostic: a thin wrapper over one zero-argument SECURITY
// DEFINER RPC, called under the CALLER'S OWN token (the ordinary publishable-key server
// client — never service-role).
//
//   public.get_my_lifecycle_access_state() -> (access_state text)
//
// ============================================================================
// ⚠️ DIAGNOSTIC ONLY. THIS IS NOT AN AUTHORIZATION GATE, AND MUST NEVER BECOME ONE.
// ============================================================================
// The authoritative resolvers — the ones behind getRetailerPortalAccess(),
// getRetailerOwnerPortalAccess() and every protected RPC — remain the only things that
// decide whether a request may proceed, and each re-derives its answer from auth.uid() on
// every call. This function returning ACTIVE is NOT permission to do anything; it is a
// description of why the real gate said no, read AFTER the real gate said no.
//
// So this module is called from exactly one place — the access-denied page, once the
// ordinary authorization check has ALREADY refused — and its result chooses a SENTENCE,
// never a capability. Nothing may branch on it to admit a request, and nothing may cache it
// beyond the request that read it.
//
// ============================================================================
// WHAT CROSSES, AND WHAT CANNOT
// ============================================================================
// ZERO ARGUMENTS GO OUT. There is no membership id, profile id, email, organization id or
// tenant selector to send, because the function accepts none: the subject is auth.uid() and
// can only ever be auth.uid(). A caller cannot ask about anybody else, and this module
// could not express the question if it wanted to.
//
// ONE WORD COMES BACK. No profile id, membership id, organization id, organization name,
// email, role code, raw profile/membership/organization status, timestamp or database
// message is returned by the function, so there is nothing of that kind here to drop.
//
// NO DIRECT TABLE ACCESS. This module contains zero `.from(` calls — the RPC is the only
// read, and it is granted to `authenticated` and to nothing else.
//
// ERROR DISCIPLINE. Nothing from PostgREST is inspected, returned or logged beyond the fact
// that the read did not succeed. There is deliberately no SQLSTATE branching here: the only
// error this function raises is 42501 for an unauthenticated caller, and a page that
// already refused access has no use for the distinction. Every failure — transport, denial,
// drift — becomes one `unavailable`, which the copy layer maps to the ORDINARY
// access-denied experience.
import { createClient } from "@/lib/supabase/server";
import {
  isLifecycleAccessState,
  type LifecycleAccessState,
} from "@/lib/staff/lifecycle-access-state";

/**
 * The only RPC name this module may call. Declared as a constant so the security review has
 * a single, greppable place to confirm the surface.
 */
const LIFECYCLE_ACCESS_STATE_RPC = "get_my_lifecycle_access_state" as const;

/** Sanitized operator logging. No ids, names, error objects, sessions or row data. */
function logDiagnosticFailure(category: string): void {
  console.error(`[retailer-lifecycle-state] read failed: ${category}`);
}

/**
 * The diagnostic outcome.
 *
 * `unavailable` covers every failure identically — not signed in, transport, an unexpected
 * SQLSTATE, and a value this build does not recognize. The page renders the ordinary
 * access-denied card for it, which is the honest fallback: the caller could not be
 * described, so saying no more than the denial already does is correct.
 */
export type MyLifecycleAccessStateResult =
  | { status: "ok"; accessState: LifecycleAccessState }
  | { status: "unavailable" };

/**
 * Reads the single word off the RPC's response.
 *
 * PostgREST returns a `returns table (...)` function as an ARRAY of row objects, and
 * `supabase.rpc()` is untyped in this project, so its result is `any`. This is a real
 * runtime check against the CLOSED vocabulary rather than a type assertion: a word from a
 * future migration this build predates is treated as unknown and falls back to the ordinary
 * denial, instead of being rendered as an unrecognized state or — worse — defaulting into
 * copy that names the wrong cause.
 */
function readAccessState(data: unknown): LifecycleAccessState | null {
  const row = Array.isArray(data) ? data[0] : data;

  if (typeof row !== "object" || row === null) return null;

  const value = (row as Record<string, unknown>).access_state;

  return isLifecycleAccessState(value) ? value : null;
}

/**
 * Asks the database why THIS caller's access is refused.
 *
 * Called only after an authorization check has already denied the request. The result is
 * used to choose one of this codebase's own fixed sentences and for nothing else.
 *
 * Never cached. The answer describes a lifecycle state that a Retailer Owner can change at
 * any moment, and caching it across requests would show someone "your account is inactive"
 * after it had been reactivated — or, far worse, let a stale ACTIVE influence a later
 * decision. There is no `unstable_cache`, no `use cache` and no memo here by design.
 */
export async function getMyLifecycleAccessState(): Promise<MyLifecycleAccessStateResult> {
  const supabase = await createClient();

  // Promise.resolve() because the PostgREST builder is a thenable, not a real Promise. Same
  // pattern as every other RPC wrapper in this codebase.
  const result = await Promise.resolve(
    supabase.rpc(LIFECYCLE_ACCESS_STATE_RPC),
  ).catch(() => null);

  if (result === null) {
    logDiagnosticFailure("transport");
    return { status: "unavailable" };
  }

  if (result.error) {
    // Deliberately not branched on. The only declared error is 42501 for an
    // unauthenticated caller, and a page that has already refused access gains nothing from
    // telling that apart from a transport failure. The message is never bound or logged.
    logDiagnosticFailure("rpc-error");
    return { status: "unavailable" };
  }

  const accessState = readAccessState(result.data as unknown);

  if (accessState === null) {
    logDiagnosticFailure("malformed-response");
    return { status: "unavailable" };
  }

  return { status: "ok", accessState };
}
