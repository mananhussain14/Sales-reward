/**
 * PURE MODULE — no imports, no I/O. Validates a login `next` return destination.
 *
 * A `next` value travels from the browser through the login form to the sign-in
 * action, so it is fully attacker-controlled and must never be trusted as a
 * redirect target without validation. The whole class of bug here is the OPEN
 * REDIRECT: a value like `//evil.com`, `https://evil.com`, `/\evil.com`, or an
 * encoded variant that the browser normalizes to an off-site URL.
 *
 * THE RULE. A safe destination is an application-INTERNAL absolute path: it begins
 * with exactly one `/`, is not protocol-relative, carries no scheme, no backslash,
 * no control/whitespace, and — parsed against a throwaway origin — resolves to that
 * same origin. Anything else yields null, and the caller substitutes a safe
 * default. This never decides authorization; it only decides "is this a same-site
 * path we may navigate to".
 */

/**
 * Matches a backslash, any whitespace, or any ASCII control character
 * (U+0000–U+001F, U+007F). Hyphens, letters, digits, and ordinary path punctuation
 * are NOT matched. Built with the RegExp constructor from a printable-only string
 * (double-escaped) so the source file carries no literal control bytes.
 */
const UNSAFE_PATH_CHARS = new RegExp("[\\\\\\s\\u0000-\\u001f\\u007f]");

/**
 * Returns the value unchanged if it is a safe internal path, otherwise null.
 *
 * Rejects, in order: non-strings/empty; anything not starting with `/`; protocol-
 * relative (`//`) and backslash tricks (`/\`, and their percent-encoded forms);
 * any backslash, whitespace, or control character anywhere; any `:` (which would
 * admit a scheme); and finally anything that does not resolve to the throwaway
 * same origin when parsed by the WHATWG URL parser.
 */
export function resolveSafeNextPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;

  // Must be an internal absolute path.
  if (value[0] !== "/") return null;

  // Protocol-relative and backslash-to-slash normalization tricks, raw and encoded.
  const lowered = value.toLowerCase();
  if (
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    lowered.startsWith("/%2f") ||
    lowered.startsWith("/%5c")
  ) {
    return null;
  }

  // No backslash, whitespace, or control character anywhere.
  if (UNSAFE_PATH_CHARS.test(value)) return null;

  // No scheme separator. Internal app paths never need a colon, and forbidding it
  // removes `javascript:`-style and `foo:bar` ambiguities outright.
  if (value.includes(":")) return null;

  // Belt and braces: parse against a throwaway origin and require it to stay there.
  try {
    const parsed = new URL(value, "http://internal.invalid");
    if (parsed.origin !== "http://internal.invalid") return null;
    if (!parsed.pathname.startsWith("/")) return null;
  } catch {
    return null;
  }

  return value;
}
