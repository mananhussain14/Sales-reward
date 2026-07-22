// SERVER-ONLY MODULE.
//
// The request-scoped read/clear of the short-lived HttpOnly cookie that carries the
// existing-user invitation TOKEN HASH (never the raw token) from the intake route to
// the acceptance page/action. The cookie's NAME and ATTRIBUTES live in the pure
// ./existing-user-cookie-options.ts (so they can be unit-tested without `next/headers`)
// and are RE-EXPORTED here, so existing importers of this module are unaffected.
import { cookies } from "next/headers";
import { isValidTokenHash } from "@/lib/invitations/existing-user-token";
import {
  EXISTING_USER_INVITE_COOKIE,
  existingUserInviteCookieOptions,
} from "@/lib/invitations/existing-user-cookie-options";

// Re-export the full pure cookie surface so callers keep a single import site.
export {
  EXISTING_USER_INVITE_COOKIE,
  EXISTING_USER_INVITE_COOKIE_PATH,
  EXISTING_USER_INVITE_COOKIE_MAX_AGE,
  existingUserInviteCookieOptions,
  type ExistingUserInviteCookieOptions,
} from "@/lib/invitations/existing-user-cookie-options";

/**
 * Reads the invitation hash from the cookie, or null if absent or malformed. Usable
 * from a Server Component (read-only) or a Server Action. A stored value that is not
 * a well-formed 64-hex hash is treated as absent, never trusted.
 */
export async function readExistingUserInviteHash(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(EXISTING_USER_INVITE_COOKIE)?.value;
  return isValidTokenHash(value) ? value : null;
}

/**
 * Clears the cookie. Only valid in a Server Action / Route Handler context (a Server
 * Component render cannot modify cookies). Uses the same name/path so the browser
 * actually drops it.
 */
export async function clearExistingUserInviteCookie(): Promise<void> {
  const store = await cookies();
  store.set(EXISTING_USER_INVITE_COOKIE, "", {
    ...existingUserInviteCookieOptions(),
    maxAge: 0,
  });
}
