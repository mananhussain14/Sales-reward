// PURE MODULE — no `next/headers`, no I/O, no imports.
//
// The NAME and ATTRIBUTES of the existing-user invitation-hash cookie, split out from
// the request-scoped read/clear helpers in ./existing-user-cookie.ts so they can be
// unit-tested under `node --experimental-strip-types` — which cannot resolve
// `next/headers`, and therefore cannot import the module that reads/writes cookies.
//
// ./existing-user-cookie.ts re-exports every symbol here, so callers import from
// either path without noticing the split. The cookie holds ONLY a 64-hex token hash
// (never the raw token); these attributes are what keep that hash invisible to client
// JS and off cleartext transport.

/** The stable cookie name. Opaque; carries only a hash. */
export const EXISTING_USER_INVITE_COOKIE = "ru_eu_inv_hash";

/**
 * The cookie's path — scoped to the acceptance routes only, so it is never sent to
 * unrelated routes. `/invitations/existing` also covers the acceptance Server Action
 * (which POSTs to that same page URL), so the hash is available exactly where it is
 * needed and nowhere else.
 */
export const EXISTING_USER_INVITE_COOKIE_PATH = "/invitations/existing";

/**
 * One hour: long enough to click the link, sign in, and accept, but far inside the
 * 24-hour invitation validity window. Re-clicking the email link re-sets it if it
 * lapses.
 */
export const EXISTING_USER_INVITE_COOKIE_MAX_AGE = 60 * 60;

/** The exact option shape written for the cookie. `httpOnly`/`sameSite` are fixed. */
export type ExistingUserInviteCookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
};

/**
 * The cookie options. `secure` is on outside development, so the hash never travels
 * over cleartext to a real host. `httpOnly` keeps it out of client JavaScript;
 * `SameSite=Lax` allows the top-level navigation from the email link while blocking
 * cross-site sends. Read `NODE_ENV` at CALL time so a process started in production
 * gets `secure: true` without a stale captured value.
 */
export function existingUserInviteCookieOptions(): ExistingUserInviteCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: EXISTING_USER_INVITE_COOKIE_PATH,
    maxAge: EXISTING_USER_INVITE_COOKIE_MAX_AGE,
  };
}
