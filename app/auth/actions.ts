"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { SignOutState } from "@/app/auth/sign-out-state";

/**
 * Server Action backing the Vendor Admin sign-out button.
 *
 * Sign-out runs on the server for the same reason sign-in does: the session
 * lives in httpOnly cookies that browser JavaScript cannot read or clear. Only
 * the server client — which holds the cookie adapter from lib/supabase/server.ts
 * — can both revoke the refresh token upstream and expire the cookies in the
 * response. The browser Supabase client is never used here; it would clear its
 * own in-memory copy and leave the cookies that actually authenticate requests
 * fully intact.
 *
 * Deliberately NOT authorization-gated. Sign-out is the one admin capability
 * that must work for any authenticated caller, including one who fails the
 * VENDOR_SUPER_ADMIN check — that user is stranded on /access-denied and
 * discarding their own session is precisely the remedy. There is nothing to
 * protect: the action's entire effect is to destroy the caller's own session,
 * which they could equivalently achieve by clearing their own cookies. It reads
 * no input and touches no other account, so there is no parameter to tamper
 * with and no other user to reach.
 *
 * Because of the "use server" directive above, `signOut` must be this module's
 * only runtime export. The SignOutState type and INITIAL_SIGN_OUT_STATE
 * therefore live in ./sign-out-state; `import type` above is erased at compile
 * time and adds no export.
 *
 * Nothing in this module logs tokens, cookies, emails, or account information.
 */

/**
 * The single message used for every sign-out failure.
 *
 * The raw Supabase error is never forwarded: it distinguishes failure modes and
 * can echo back session details. The user can only usefully do one thing about
 * any of them — try again — so they all collapse to one message.
 */
const GENERIC_SIGN_OUT_ERROR = "Unable to sign out. Please try again.";

/**
 * Takes no parameters at all. `useActionState` invokes its action with
 * (previousState, formData) and React ignores the arguments a shorter function
 * declines to accept — and this action has genuinely nothing to read. It needs
 * no form fields, and the session it ends is identified solely by the request's
 * own cookies. An unused `_prevState` parameter would only imply otherwise.
 */
export async function signOut(): Promise<SignOutState> {
  const supabase = await createClient();

  // Both failure modes are handled here and collapse to the same message:
  //   * a returned `error`  — the Auth server rejecting the revocation;
  //   * a thrown exception  — the Auth server being unreachable, a DNS failure,
  //     a timeout, or a malformed response.
  //
  // The try block is kept as tight as possible: it wraps ONLY the network call,
  // so it cannot accidentally swallow control flow from anything else.
  try {
    // scope: "local" ends only THIS browser session. The default ("global")
    // would revoke every refresh token for the account and silently sign the
    // same admin out of their other devices — a surprising side effect for what
    // the user asked to be a single sign-out. "others" would do the inverse and
    // leave this session alive.
    //
    // This revokes the refresh token upstream AND expires the auth cookies via
    // the server client's setAll adapter. A Server Action can write cookies (a
    // Server Component cannot), so the expiry actually reaches the browser.
    const { error } = await supabase.auth.signOut({ scope: "local" });

    if (error) {
      // The raw error object is intentionally swallowed rather than forwarded or
      // logged — it can carry session and account details.
      return { error: GENERIC_SIGN_OUT_ERROR };
    }
  } catch {
    // The thrown value is deliberately not bound, inspected, or logged: a
    // transport-level exception can carry the request headers, which include the
    // session cookie. Even a debug log here would be a token leak.
    return { error: GENERIC_SIGN_OUT_ERROR };
  }

  // Reaching here means sign-out succeeded. Everything below is intentionally
  // OUTSIDE the try/catch.

  // Drop any cached render produced while authenticated, so nothing from the
  // signed-in shell can be served to the now-anonymous browser.
  revalidatePath("/", "layout");

  // Must stay outside any try/catch: redirect() signals by throwing a special
  // NEXT_REDIRECT error, and catching it would swallow the navigation — turning
  // a successful sign-out into a spurious "unable to sign out" message while the
  // session was, in fact, already gone.
  redirect("/login");
}
