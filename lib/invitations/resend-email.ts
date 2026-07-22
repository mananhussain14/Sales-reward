// SERVER-ONLY MODULE.
//
// The application's ONLY outbound email path for the existing-user invitation.
// Unlike the new-user flow (which lets Supabase Auth send via configured SMTP),
// this invitation is an APPLICATION-OWNED message — a link to an app route, not an
// Auth email — so the app sends it itself, through the Resend REST API using a
// server-only `fetch`. No `resend` npm package is added.
//
// SECRETS STAY SERVER-SIDE. RESEND_API_KEY is a plain `process.env` read (never
// NEXT_PUBLIC_), used only for the Authorization header of the POST. It is never
// returned, logged, or interpolated into a message. This module never runs in the
// browser (it is imported only by the server orchestration).
//
// This module OWNS the invitation URL. It reads APP_ORIGIN, validates it, and builds
// `${APP_ORIGIN}/invitations/existing/enter?token=<raw>` itself — the caller passes
// only the raw token, never a URL. The recipient email, the Retailer display name,
// and that URL are the ONLY dynamic values in the message; there is no database id,
// Auth user id, or relationship id anywhere in the body. The raw token appears only
// inside the accept URL.
//
// NO NON-RELATIVE ("@/…") IMPORTS. This module must stay resolvable by Node's plain
// ESM loader so its unit test can import it under `node --experimental-strip-types`,
// which does not honor tsconfig path aliases. It is therefore kept dependency-free.

/** The env var names — for MESSAGES only. The lookups below are literal for Next. */
export const RESEND_API_KEY_VAR = "RESEND_API_KEY";
export const RESEND_FROM_VAR = "RESEND_FROM";
export const APP_ORIGIN_VAR = "APP_ORIGIN";

/** The Resend transactional-email endpoint. */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * The intake route the emailed link points at. It exchanges the raw token for an
 * HttpOnly hash cookie and redirects to the clean acceptance page, so the raw token
 * lives in the URL for exactly one hop.
 */
const EXISTING_INVITE_ENTER_PATH = "/invitations/existing/enter";

/** The validated configuration this module needs to send. */
type ResendConfig = { apiKey: string; from: string; appOrigin: string };

/**
 * Validates APP_ORIGIN and returns its canonical origin. Must be an absolute URL and
 * must use https, except on a loopback dev host where plain http is allowed. Throws
 * (message names only the variable) so the caller maps the gap to `misconfigured`.
 */
function validateAppOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${APP_ORIGIN_VAR} is not a valid absolute URL.`);
  }
  const isLoopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error(`${APP_ORIGIN_VAR} must use https except on loopback.`);
  }
  return parsed.origin;
}

/**
 * Reads and validates the three required server-only variables, trimmed. Throws (with
 * a message naming only the variable) when any is absent or blank, so the caller can
 * map a configuration gap to `misconfigured`. Literal `process.env.FOO` expressions,
 * because Next.js only statically replaces literals.
 */
function readConfig(): ResendConfig {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  const appOrigin = process.env.APP_ORIGIN;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error(`Missing ${RESEND_API_KEY_VAR}.`);
  }
  if (typeof from !== "string" || from.trim().length === 0) {
    throw new Error(`Missing ${RESEND_FROM_VAR}.`);
  }
  if (typeof appOrigin !== "string" || appOrigin.trim().length === 0) {
    throw new Error(`Missing ${APP_ORIGIN_VAR}.`);
  }
  return {
    apiKey: apiKey.trim(),
    from: from.trim(),
    appOrigin: validateAppOrigin(appOrigin.trim()),
  };
}

/**
 * Builds the accept URL from the validated origin and the raw token. The token is
 * percent-encoded defensively: a well-formed base64url token needs no encoding, so
 * this is a no-op for real tokens and neutralizes any unexpected input rather than
 * letting it alter the URL's structure.
 */
function buildAcceptUrl(appOrigin: string, rawToken: string): string {
  return `${appOrigin}${EXISTING_INVITE_ENTER_PATH}?token=${encodeURIComponent(rawToken)}`;
}

/** The result of an attempted send. Carries no provider error, status, or id. */
export type ExistingUserInvitationEmailResult =
  | { status: "sent" }
  /** Configuration is missing/blank/invalid (key, sender, or origin). Distinct so callers can tell a setup gap from a transient failure. */
  | { status: "misconfigured" }
  /** The send did not complete (transport, non-2xx, malformed/absent response, thrown). Nothing provider-specific is surfaced. */
  | { status: "failed" };

/** Everything the message needs. All values are trusted server-derived strings. */
export type ExistingUserInvitationEmailInput = {
  /** Canonical recipient address (the invitation's own email). */
  toEmail: string;
  /** Retailer display name, from a trusted server read. */
  retailerName: string;
  /** The fresh raw invitation token. Used ONLY to build the accept URL; never logged. */
  rawToken: string;
};

/** The subject line. Fixed wording; names no id and no address. */
function subjectFor(retailerName: string): string {
  return `You've been invited to own ${retailerName} on SalesReward`;
}

/** Minimal HTML escape for the two dynamic display strings placed in the body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function textBody(retailerName: string, acceptUrl: string): string {
  return [
    `You've been invited to become the Retailer Owner of ${retailerName} on SalesReward.`,
    "",
    "To accept, open the link below and sign in to your existing SalesReward account:",
    acceptUrl,
    "",
    "If you did not expect this invitation, you can ignore this email.",
  ].join("\n");
}

function htmlBody(retailerName: string, acceptUrl: string): string {
  const name = escapeHtml(retailerName);
  const url = escapeHtml(acceptUrl);
  return [
    `<p>You've been invited to become the Retailer Owner of <strong>${name}</strong> on SalesReward.</p>`,
    `<p>To accept, open the link below and sign in to your existing SalesReward account:</p>`,
    `<p><a href="${url}">Accept your Retailer Owner invitation</a></p>`,
    `<p style="color:#71717a;font-size:12px">If you did not expect this invitation, you can ignore this email.</p>`,
  ].join("");
}

/**
 * Sends the existing-user invitation email through Resend.
 *
 * `fetchImpl` is injectable so tests exercise this without a network call and
 * without a package. In production it defaults to the global `fetch`.
 *
 * NEVER returns or logs a provider error, status code, response body, recipient, the
 * raw token, or the API key. Every non-success collapses to `failed` (or
 * `misconfigured` when the configuration itself is absent or invalid).
 */
export async function sendExistingUserInvitationEmail(
  input: ExistingUserInvitationEmailInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ExistingUserInvitationEmailResult> {
  let config: ResendConfig;
  try {
    config = readConfig();
  } catch {
    // The thrown value names only the missing/invalid variable; it is not forwarded.
    console.error("resend-email: configuration is incomplete");
    return { status: "misconfigured" };
  }

  const acceptUrl = buildAcceptUrl(config.appOrigin, input.rawToken);

  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [input.toEmail],
        subject: subjectFor(input.retailerName),
        text: textBody(input.retailerName, acceptUrl),
        html: htmlBody(input.retailerName, acceptUrl),
      }),
    });

    // A malformed or absent response object is treated as a failed send rather than
    // being trusted — `response.ok` must be a real boolean before it is read.
    if (!response || typeof response.ok !== "boolean") {
      console.error("resend-email: provider response was malformed");
      return { status: "failed" };
    }

    if (!response.ok) {
      // The status and body can name the provider, the recipient, and rate-limit
      // detail. None is bound, read, returned, or logged.
      console.error("resend-email: send was not accepted");
      return { status: "failed" };
    }

    return { status: "sent" };
  } catch {
    // A transport-level throw can carry request headers — which here include the
    // API key. Nothing is bound, inspected, or logged.
    console.error("resend-email: send threw");
    return { status: "failed" };
  }
}
