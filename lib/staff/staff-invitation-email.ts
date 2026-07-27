/**
 * PURE-ISH MODULE — no imports at all, and no environment access. Its only effect is
 * the `fetch` it is handed. It therefore loads unchanged in Deno (from the Edge
 * Function, which is now its ONLY production caller) and in Node (from
 * ./staff-invitation-email.test.ts).
 *
 * The application's outbound email path for the Retailer STAFF invitation. Like the
 * existing-user Retailer Owner invitation (lib/invitations/resend-email.ts), this is an
 * APPLICATION-OWNED message — a link to an app route, not a Supabase Auth email — so the
 * app sends it itself, through the Resend REST API using a plain `fetch`. No `resend`
 * npm package is added.
 *
 * SECRETS ARE PASSED IN, NEVER READ HERE. `RESEND_API_KEY`, `RESEND_FROM` and
 * `APP_ORIGIN` used to be `process.env` reads in this file. They are now supplied by the
 * caller as a validated `StaffInvitationEmailConfig`, for two reasons: the only caller
 * is a Deno Edge Function, which has no `process.env`; and a module with no ambient
 * configuration cannot leak configuration it never sees. The key is used only for the
 * Authorization header of the POST. It is never returned, logged, or interpolated into a
 * message.
 *
 * THIS MODULE OWNS THE ACCEPTANCE URL. It validates the origin and builds
 * `${APP_ORIGIN}/invitations/staff/enter?token=<raw>` itself; the caller passes only the
 * raw token, never a URL. No production domain is hard-coded anywhere.
 *
 * WHAT THE MESSAGE MAY CONTAIN, AND WHAT IT MAY NOT.
 *   May:  SalesReward branding, the Retailer's display name, the invited role's display
 *         name, the recipient's first name, the accept link, the expiry, and guidance to
 *         sign in (or create an account) with the invited address.
 *   May NOT, and does not: the token hash, the invitation id, any shop UUID, any Auth
 *         user id, any membership id, any profile id, or any provider/system detail. The
 *         RAW token exists only inside the accept URL.
 */

/** The env var names — for MESSAGES and documentation only. Nothing is read here. */
export const RESEND_API_KEY_VAR = "RESEND_API_KEY";
export const RESEND_FROM_VAR = "RESEND_FROM";
export const APP_ORIGIN_VAR = "APP_ORIGIN";

/** The Resend transactional-email endpoint. */
const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * The intake route the emailed link points at. It exchanges the raw token for an
 * HttpOnly hash cookie and redirects to the clean acceptance page, so the raw token
 * lives in the URL for exactly one hop. Unchanged by this milestone.
 */
export const STAFF_INVITE_ENTER_PATH = "/invitations/staff/enter";

/** The validated configuration this module needs to send. */
export type StaffInvitationEmailConfig = {
  apiKey: string;
  from: string;
  /** An already-canonicalized origin, e.g. "https://app.example.com". No path. */
  appOrigin: string;
};

export type StaffInvitationEmailConfigResult =
  | { ok: true; config: StaffInvitationEmailConfig }
  /**
   * Something is absent, blank, or invalid. WHICH variable is deliberately not
   * reported: the result crosses a runtime boundary and the caller turns it into a
   * client-visible `NOT_CONFIGURED`, where naming a variable would describe the
   * deployment to whoever asked.
   */
  | { ok: false };

/**
 * Validates APP_ORIGIN and returns its canonical origin. Must be an absolute URL and
 * must use https, except on a loopback dev host where plain http is allowed.
 */
function canonicalAppOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const isLoopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    return null;
  }
  return parsed.origin;
}

/**
 * Validates the three required values, trimmed.
 *
 * Called by the Edge Function at REQUEST time, before anything is reserved, so a
 * deployment gap is refused before any database write, any token is minted, and any
 * provider request is made — and is reported as a configuration problem rather than as
 * a delivery failure against an invitation that now exists.
 */
export function validateStaffInvitationEmailConfig(raw: {
  apiKey?: unknown;
  from?: unknown;
  appOrigin?: unknown;
}): StaffInvitationEmailConfigResult {
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const from = typeof raw.from === "string" ? raw.from.trim() : "";
  const appOriginRaw = typeof raw.appOrigin === "string" ? raw.appOrigin.trim() : "";

  if (apiKey.length === 0 || from.length === 0 || appOriginRaw.length === 0) {
    return { ok: false };
  }

  const appOrigin = canonicalAppOrigin(appOriginRaw);
  if (appOrigin === null) return { ok: false };

  return { ok: true, config: { apiKey, from, appOrigin } };
}

/**
 * Builds the accept URL from the validated origin and the raw token. The token is
 * percent-encoded defensively: a well-formed base64url token needs no encoding, so this
 * is a no-op for real tokens and neutralizes any unexpected input rather than letting it
 * alter the URL's structure.
 */
export function buildStaffAcceptUrl(appOrigin: string, rawToken: string): string {
  return `${appOrigin}${STAFF_INVITE_ENTER_PATH}?token=${encodeURIComponent(rawToken)}`;
}

/** The result of an attempted send. Carries no provider error, status, body, or id. */
export type StaffInvitationEmailResult =
  | { status: "sent" }
  /** The send did not complete (transport, non-2xx, malformed response, thrown). */
  | { status: "failed" };

/** Everything the message needs. All values are trusted server-derived strings. */
export type StaffInvitationEmailInput = {
  /** Canonical recipient address — the invitation's own email, from the database. */
  toEmail: string;
  /** Recipient's first name, from the invitation row. */
  firstName: string;
  /** Retailer display name, from prepare_retailer_staff_invitation. */
  retailerName: string;
  /** Invited role's display name, e.g. "Sales Staff". */
  roleDisplayName: string;
  /** The fresh raw invitation token. Used ONLY to build the accept URL; never logged. */
  rawToken: string;
};

/** The subject line. Fixed wording; names no id and no address. */
function subjectFor(retailerName: string, roleDisplayName: string): string {
  return `You've been invited to join ${retailerName} as ${roleDisplayName} on SalesReward`;
}

/** Minimal HTML escape for the display strings placed in the body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function staffInvitationTextBody(
  input: StaffInvitationEmailInput,
  acceptUrl: string,
): string {
  return [
    `Hi ${input.firstName},`,
    "",
    `You've been invited to join ${input.retailerName} on SalesReward as ${input.roleDisplayName}.`,
    "",
    "To accept, open the link below:",
    acceptUrl,
    "",
    `Sign in with ${input.toEmail}, or create your SalesReward account using that same address — the invitation can only be accepted by it.`,
    "",
    "This invitation expires, so please accept it soon.",
    "",
    "If you did not expect this invitation, you can ignore this email.",
  ].join("\n");
}

export function staffInvitationHtmlBody(
  input: StaffInvitationEmailInput,
  acceptUrl: string,
): string {
  const firstName = escapeHtml(input.firstName);
  const retailerName = escapeHtml(input.retailerName);
  const roleName = escapeHtml(input.roleDisplayName);
  const email = escapeHtml(input.toEmail);
  const url = escapeHtml(acceptUrl);

  return [
    `<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#18181b;max-width:560px">`,
    `<p style="font-size:18px;font-weight:600;margin:0 0 24px">SalesReward</p>`,
    `<p>Hi ${firstName},</p>`,
    `<p>You&rsquo;ve been invited to join <strong>${retailerName}</strong> on SalesReward as <strong>${roleName}</strong>.</p>`,
    `<p style="margin:28px 0"><a href="${url}" style="background:#4f46e5;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:6px;display:inline-block;font-weight:600">Accept invitation</a></p>`,
    `<p>Sign in with <strong>${email}</strong>, or create your SalesReward account using that same address &mdash; the invitation can only be accepted by it.</p>`,
    `<p style="color:#71717a;font-size:13px">This invitation expires, so please accept it soon.</p>`,
    `<p style="color:#71717a;font-size:12px">If you did not expect this invitation, you can ignore this email.</p>`,
    `</div>`,
  ].join("");
}

/**
 * Sends the staff invitation email through Resend.
 *
 * `fetchImpl` is injectable so tests exercise this without a network call and without a
 * package. In production it defaults to the global `fetch`.
 *
 * NEVER returns or logs a provider error, status code, response body, recipient, the raw
 * token, or the API key. Every non-success collapses to `failed`.
 *
 * NO RETRY. One attempt, whatever happens. A retry inside the request would risk two
 * messages for one submission, and the decision to try again belongs to the operator.
 */
export async function sendStaffInvitationEmail(
  input: StaffInvitationEmailInput,
  config: StaffInvitationEmailConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<StaffInvitationEmailResult> {
  const acceptUrl = buildStaffAcceptUrl(config.appOrigin, input.rawToken);

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
        subject: subjectFor(input.retailerName, input.roleDisplayName),
        text: staffInvitationTextBody(input, acceptUrl),
        html: staffInvitationHtmlBody(input, acceptUrl),
      }),
    });

    // A malformed or absent response object is treated as a failed send rather than
    // being trusted — `response.ok` must be a real boolean before it is read.
    if (!response || typeof response.ok !== "boolean") {
      console.error("staff-invitation-email: provider response was malformed");
      return { status: "failed" };
    }

    if (!response.ok) {
      // The status and body can name the provider, the recipient, and rate-limit
      // detail. None is bound, read, returned, or logged.
      console.error("staff-invitation-email: send was not accepted");
      return { status: "failed" };
    }

    return { status: "sent" };
  } catch {
    // A transport-level throw can carry request headers — which here include the API
    // key — and the request body, which contains the accept URL and therefore the raw
    // token. Nothing is bound, inspected, or logged.
    console.error("staff-invitation-email: send threw");
    return { status: "failed" };
  }
}
