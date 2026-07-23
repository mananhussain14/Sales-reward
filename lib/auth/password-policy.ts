/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * THE ONE PLACE the application's password rules are stated. Both account-creation
 * flows — Retailer Owner activation (app/invitations/complete) and invited staff
 * activation (app/invitations/staff) — and both of their forms import from here, so a
 * change to the policy is one edit rather than six, and the `minLength` a browser
 * enforces can never drift from the length the server requires.
 *
 * SUPABASE AUTH IS THE FINAL AUTHORITY. These checks run first so a person gets a
 * clear, specific message instead of a generic auth failure, but Auth applies its own
 * rules afterwards and its refusal stands. This module is therefore never looser than
 * Supabase: `supabase/config.toml` sets auth.minimum_password_length = 6, and
 * MIN_PASSWORD_LENGTH below is 6 — the two agree exactly, which is the requirement.
 *
 * It is safe to import into a Client Component: it holds two numbers and two pure
 * functions, reads no environment variable, and touches nothing server-only.
 */

/**
 * The minimum password length, matching auth.minimum_password_length = 6 in
 * supabase/config.toml. Changing one without the other would either reject passwords
 * Auth accepts, or promise a floor Auth does not enforce.
 */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Defensive upper bound. bcrypt silently truncates beyond 72 bytes, so a longer
 * password would be accepted while only its first 72 bytes ever mattered — which is
 * worse than refusing it, because the person believes they chose a longer one.
 */
export const MAX_PASSWORD_LENGTH = 72;

/** Why a password was refused. One value per distinct, user-actionable cause. */
export type PasswordRejection = "too-short" | "too-long" | "mismatch";

export type PasswordValidation =
  | { ok: true }
  | { ok: false; reason: PasswordRejection; message: string };

/**
 * The user-facing message for each rejection.
 *
 * None of them echoes the submitted password, its length, or any part of it — an error
 * string is rendered, logged by the browser, and read over shoulders.
 */
const MESSAGES: Record<PasswordRejection, string> = {
  "too-short": `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
  "too-long": `Use ${MAX_PASSWORD_LENGTH} characters or fewer.`,
  mismatch: "Both passwords must match.",
};

/** The hint shown under a password field. Same source as the rule it describes. */
export const PASSWORD_HINT = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;

/**
 * Validates a password, and — when a confirmation is supplied — that the two match.
 *
 * Order matters: length is checked before the match, so someone who typed the same
 * too-short password twice is told the useful thing rather than "they match".
 *
 * `confirmation` is optional because one of the two flows (Retailer Owner activation)
 * has a single password field today. Passing `undefined` skips only the match check;
 * it never relaxes the length rules.
 */
export function validatePassword(
  password: unknown,
  confirmation?: unknown,
): PasswordValidation {
  const value = typeof password === "string" ? password : "";

  if (value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: "too-short", message: MESSAGES["too-short"] };
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: "too-long", message: MESSAGES["too-long"] };
  }

  if (confirmation !== undefined) {
    const confirmed = typeof confirmation === "string" ? confirmation : "";
    if (value !== confirmed) {
      return { ok: false, reason: "mismatch", message: MESSAGES.mismatch };
    }
  }

  return { ok: true };
}
