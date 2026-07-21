"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveAuthenticatedLanding } from "@/lib/auth/authenticated-landing";
import type { LoginState } from "@/app/login/login-state";

/**
 * Server Action backing the Vendor Admin sign-in form.
 *
 * The password is only ever handled here, on the server: the form posts to this
 * action, so the credential travels in the request body and never touches the
 * browser Supabase client, a URL, a query parameter, or localStorage. Session
 * state lives entirely in the httpOnly cookies that @supabase/ssr manages.
 *
 * Nothing in this module logs the submitted email or password.
 *
 * Because of the "use server" directive above, `signIn` must be this module's
 * only runtime export — every export here is exposed as a callable server
 * endpoint, so Next.js rejects anything that is not an async function. The
 * LoginState type and INITIAL_LOGIN_STATE therefore live in ./login-state.
 * `import type` below is erased at compile time and adds no export.
 */

/**
 * The single message used for every authentication failure.
 *
 * Deliberately indistinguishable across "no such user", "wrong password",
 * "email not confirmed", and "user banned". Varying the text would let an
 * unauthenticated caller enumerate which email addresses have accounts.
 */
const GENERIC_AUTH_ERROR = "Unable to sign in with those credentials.";

/**
 * Shown ONLY after authentication has already succeeded, when the landing
 * resolver cannot be reached (a transient database or network fault). It is safe
 * to be distinct from GENERIC_AUTH_ERROR: by this point the caller has proven
 * valid credentials, so there is no account-enumeration signal left to protect —
 * and the retry-safe wording invites the one action that fixes it. The session
 * is NOT torn down; re-submitting simply re-runs the resolver.
 */
const LANDING_UNAVAILABLE_ERROR =
  "You're signed in, but we couldn't load your workspace just now. Please try again.";

/**
 * Pragmatic email shape check: something, an @, something, a dot, something —
 * with no whitespace. This is a typo guard, not an RFC 5322 implementation;
 * the Auth server remains the real authority on whether an address exists.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Defensive bound: the maximum length of an email address per RFC 5321. */
const MAX_EMAIL_LENGTH = 254;

export async function signIn(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const rawEmail = formData.get("email");
  const rawPassword = formData.get("password");

  // FormData entries are `string | File`; a File here means a malformed request.
  const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";

  // Shape validation describes the INPUT, never the account, so specific
  // messages here carry no enumeration risk and are far kinder than a blanket
  // rejection. Only the credential check below is made deliberately vague.
  if (email.length === 0) {
    return { error: "Enter your email address." };
  }
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    return { error: "Enter a valid email address." };
  }
  if (password.length === 0) {
    return { error: "Enter your password." };
  }

  const supabase = await createClient();

  // Both failure modes are handled here and collapse to the same message:
  //   * a returned `error`  — bad credentials, unconfirmed email, banned user;
  //   * a thrown exception  — the Auth server being unreachable, a DNS failure,
  //     a timeout, or a malformed response.
  //
  // The try block is kept as tight as possible: it wraps ONLY the network call,
  // so it cannot accidentally swallow control flow from anything else.
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      // The raw Supabase error is intentionally swallowed rather than
      // forwarded: its message and status distinguish failure modes and would
      // leak account existence. It is not logged either, since these objects can
      // echo back the submitted identifier.
      return { error: GENERIC_AUTH_ERROR };
    }
  } catch {
    // The thrown value is deliberately not bound, inspected, or logged. A
    // transport-level exception can carry the request body — including the
    // password — so even a debug log here would be a credential leak. The user
    // sees the same generic message either way, which also keeps a network
    // outage indistinguishable from a wrong password to an enumerating caller.
    return { error: GENERIC_AUTH_ERROR };
  }

  // Reaching here means sign-in succeeded. Everything below is intentionally
  // OUTSIDE the credential try/catch above.

  // Where the user lands is no longer hardcoded to the Vendor route. The
  // server-only resolver reads the just-established session and decides:
  //   * Vendor Super Admin      -> "/"          (existing Vendor landing, first
  //                                              priority — dual-role users keep it)
  //   * Retailer Owner only     -> "/retailer"
  //   * authenticated, neither  -> "/access-denied" (the generic denial route;
  //                                              NOT /retailer-access-denied)
  //   * operationally unavailable -> a retry-safe message, session preserved
  //
  // The resolver derives everything from auth.uid() via the two existing secure
  // access functions; nothing the form submitted influences the destination, and
  // every returned route is a fixed internal literal, so there is no open-redirect
  // surface. This call is INSIDE a try/catch because it is not a redirect: an
  // unexpected throw must become a safe message, not a 500 or a lost session.
  let landing;
  try {
    landing = await resolveAuthenticatedLanding();
  } catch {
    // The thrown value is deliberately not bound or logged — it could carry
    // request or session detail. The user keeps their session and can retry.
    return { error: LANDING_UNAVAILABLE_ERROR };
  }

  // An operational failure inside the resolver (e.g. the Retailer RPC was
  // unreachable) is NOT an authorization denial. Surface a retry message rather
  // than redirecting the authenticated user anywhere.
  if (landing.kind === "unavailable") {
    return { error: LANDING_UNAVAILABLE_ERROR };
  }

  // Drop any cached render produced while logged out so the authenticated shell
  // renders fresh.
  revalidatePath("/", "layout");

  // Must stay outside any try/catch: redirect() signals by throwing a special
  // NEXT_REDIRECT error, and catching it would silently swallow the navigation —
  // turning a successful login into a spurious "unable to sign in" message.
  // `landing.destination` is one of the fixed LANDING_ROUTES literals.
  redirect(landing.destination);
}
