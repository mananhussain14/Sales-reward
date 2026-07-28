/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * The closed vocabulary returned by public.get_my_lifecycle_access_state(), and the ONE
 * mapping from a state to the copy the access-denied page renders.
 *
 * It lives here, separate from the server module that calls the RPC, so the mapping can be
 * exercised directly by ./lifecycle-access-state.test.ts — importing
 * ./my-lifecycle-access-state.ts pulls in `next/headers` and cannot be unit-tested at all.
 * Same split as ./staff-account-state.ts.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Every protected Retailer RPC refuses an inactive member with the same generic 42501 that
 * a wrong-role caller gets. That uniformity is a security property and is PRESERVED — it
 * is what stops a caller probing the schema — but it left the application unable to write
 * honest copy. "You do not have access to this page" is the wrong sentence for someone
 * whose account was deactivated this morning.
 *
 * public.get_my_lifecycle_access_state() answers that, and only that: zero arguments, the
 * subject derived solely from auth.uid(), one word out. It discloses nothing a caller does
 * not already know about themselves.
 *
 * ============================================================================
 * ⚠️ THIS IS DIAGNOSTIC ONLY. IT IS NOT AN AUTHORIZATION GATE.
 * ============================================================================
 * The authoritative resolvers behind every protected route and RPC remain the only things
 * that decide whether access is granted. A state of ACTIVE here is NOT permission to do
 * anything — it is a description of why the real gate said no, read AFTER the real gate
 * said no. Nothing in this codebase may branch on these values to admit a request; they
 * choose a SENTENCE, never a capability.
 */

/**
 * The six words the database may return. Exhaustive: the SQL returns exactly these and
 * nothing else.
 *
 *   ACTIVE                 exactly one supported Retailer context, everything about it
 *                          ACTIVE. No lifecycle reason explains the refusal.
 *   PROFILE_INACTIVE       the caller's own profile is not ACTIVE — blocked everywhere.
 *   MEMBERSHIP_INACTIVE    their one Retailer is ACTIVE, their membership of it is not.
 *   ORGANIZATION_INACTIVE  their one Retailer organization is not ACTIVE.
 *   NO_SUPPORTED_ACCESS    no supported Retailer membership context exists at all.
 *   AMBIGUOUS              more than one qualifying Retailer context.
 *
 * An unrecognized value — including one from a future migration this build predates — is
 * treated as unknown and falls back to the ordinary access-denied experience, rather than
 * rendering a blank card or inventing a reason.
 */
export const LIFECYCLE_ACCESS_STATES = [
  "ACTIVE",
  "PROFILE_INACTIVE",
  "MEMBERSHIP_INACTIVE",
  "ORGANIZATION_INACTIVE",
  "NO_SUPPORTED_ACCESS",
  "AMBIGUOUS",
] as const;

export type LifecycleAccessState = (typeof LIFECYCLE_ACCESS_STATES)[number];

/** Whether a value from the database is one of the six declared states. */
export function isLifecycleAccessState(
  value: unknown,
): value is LifecycleAccessState {
  return (
    typeof value === "string" &&
    (LIFECYCLE_ACCESS_STATES as readonly string[]).includes(value)
  );
}

/**
 * The copy shown for a lifecycle state that has something specific and safe to say.
 *
 * Every string is a fixed local literal. None interpolates a name, an id, an organization,
 * a role, a raw status, a SQLSTATE or a backend message — there is nothing available here
 * to interpolate, because the RPC returns one word and nothing else.
 */
export type LifecycleNotice = {
  title: string;
  message: string;
};

/**
 * The three lifecycle causes plus the ambiguous case, each with its own sentence.
 *
 * Deliberately NOT keyed on every member of LIFECYCLE_ACCESS_STATES: `ACTIVE` and
 * `NO_SUPPORTED_ACCESS` are absent because both must keep the ORDINARY access-denied
 * experience, for different reasons stated at resolveLifecycleNotice.
 */
const NOTICES: Partial<Record<LifecycleAccessState, LifecycleNotice>> = {
  MEMBERSHIP_INACTIVE: {
    title: "Account inactive",
    message:
      "Your access to this Retailer is inactive. Contact your Retailer administrator.",
  },
  ORGANIZATION_INACTIVE: {
    title: "Retailer inactive",
    message:
      "This Retailer is currently inactive. Contact the Vendor or your Retailer administrator.",
  },
  PROFILE_INACTIVE: {
    title: "Account unavailable",
    message:
      "Your SalesReward account is currently inactive. Contact support or your administrator.",
  },
  AMBIGUOUS: {
    title: "Account setup needs attention",
    message:
      "More than one Retailer context is available for this account. Contact support.",
  },
};

/**
 * The notice to render for a diagnostic result, or null to keep the ordinary access-denied
 * card.
 *
 * NULL IS RETURNED FOR THREE CASES, and each is deliberate:
 *
 *   ACTIVE               nothing about this person's lifecycle explains the refusal, so
 *                        some OTHER condition did — a missing permission, a wrong role, a
 *                        route they are simply not entitled to. Saying anything specific
 *                        would be a guess, and a wrong one.
 *   NO_SUPPORTED_ACCESS  the ordinary "you are signed in but this is not for you" case,
 *                        which is exactly what the existing card already says. Giving it
 *                        distinct copy would tell an unauthorized (possibly hostile)
 *                        account that it has no Retailer membership at all — a fact the
 *                        current page deliberately does not disclose.
 *   unknown / unavailable  the diagnostic could not be read, or returned a word this build
 *                        does not recognize. The honest fallback is to show no more than
 *                        the denial already does.
 *
 * @param state The parsed diagnostic result, or null when the read failed or the value was
 *   not one of the six declared words.
 */
export function resolveLifecycleNotice(
  state: LifecycleAccessState | null,
): LifecycleNotice | null {
  if (state === null) return null;
  return NOTICES[state] ?? null;
}
