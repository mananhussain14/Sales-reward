// SERVER-ONLY MODULE.
//
// The request-scoped read/clear of the short-lived HttpOnly cookie that carries the
// STAFF invitation TOKEN HASH (never the raw token) from the intake route to the
// acceptance page/action. The cookie's NAME and ATTRIBUTES live in the pure
// ./staff-invite-cookie-options.ts (so they can be unit-tested without `next/headers`)
// and are RE-EXPORTED here, so callers keep a single import site.
import { cookies } from "next/headers";
import { isValidTokenHash } from "@/lib/invitations/existing-user-token";
import {
  STAFF_INVITE_COOKIE,
  staffInviteCookieOptions,
} from "@/lib/staff/staff-invite-cookie-options";

export {
  STAFF_INVITE_COOKIE,
  STAFF_INVITE_COOKIE_PATH,
  STAFF_INVITE_COOKIE_MAX_AGE,
  staffInviteCookieOptions,
  type StaffInviteCookieOptions,
} from "@/lib/staff/staff-invite-cookie-options";

/**
 * Reads the invitation hash from the cookie, or null if absent or malformed. Usable
 * from a Server Component (read-only) or a Server Action. A stored value that is not a
 * well-formed 64-hex hash is treated as absent, never trusted — and the hash itself is
 * never logged or rendered.
 */
export async function readStaffInviteHash(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(STAFF_INVITE_COOKIE)?.value;
  return isValidTokenHash(value) ? value : null;
}

/**
 * Clears the cookie. Only valid in a Server Action / Route Handler context (a Server
 * Component render cannot modify cookies). Uses the same name/path so the browser
 * actually drops it.
 */
export async function clearStaffInviteCookie(): Promise<void> {
  const store = await cookies();
  store.set(STAFF_INVITE_COOKIE, "", {
    ...staffInviteCookieOptions(),
    maxAge: 0,
  });
}
