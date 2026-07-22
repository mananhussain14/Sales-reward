// SERVER-ONLY MODULE.
//
// The two read/accept operations for the existing-user acceptance page, each a thin
// wrapper over one SECURITY DEFINER RPC called under the CALLER'S OWN token (the
// ordinary publishable-key server client — never service-role). The RPCs perform
// the real authorization: they resolve auth.uid(), require a verified matching Auth
// email, and never return a foreign email or Retailer to a wrong signed-in user.
//
// The token HASH is supplied by the caller (read from the HttpOnly cookie server-
// side). The RAW token never reaches these functions or the database. No table is
// read directly (`.from(` appears nowhere here).
import { createClient } from "@/lib/supabase/server";
import { isValidTokenHash } from "@/lib/invitations/existing-user-token";

const RESOLVE_RPC = "get_pending_existing_user_retailer_invitation" as const;
const ACCEPT_RPC = "accept_existing_user_retailer_owner_invitation" as const;

/** The outcome of resolving an invitation by hash for the current signed-in user. */
export type ResolveExistingUserInvitationResult =
  /** Valid, live, and the caller's verified email matches. Display-safe fields only. */
  | { status: "match"; retailerName: string; expiresAt: string | null }
  /** Valid token, but the caller is signed in as a different / unverified account. */
  | { status: "mismatch" }
  /** Invalid, expired, revoked, accepted, or unreadable. One generic outcome. */
  | { status: "unavailable" };

/** The outcome of accepting. */
export type AcceptExistingUserInvitationResult =
  | { status: "accepted" }
  /** The database refused (wrong account, expired, revoked, active owner, …). Generic. */
  | { status: "refused" }
  /** A transport/database failure. */
  | { status: "unavailable" };

/**
 * Resolves the invitation named by a server-calculated token hash for the current
 * signed-in user. A wrong or unverified caller receives `mismatch` with NO Retailer
 * name and NO email; an invalid/expired/revoked hash receives `unavailable`.
 */
export async function resolveExistingUserInvitation(
  tokenHash: string,
): Promise<ResolveExistingUserInvitationResult> {
  if (!isValidTokenHash(tokenHash)) return { status: "unavailable" };

  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(RESOLVE_RPC, { p_token_hash: tokenHash }),
  ).catch(() => null);

  if (result === null || result.error) return { status: "unavailable" };

  const rows = result.data as unknown;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Zero rows: invalid / expired / revoked / accepted — indistinguishable.
    return { status: "unavailable" };
  }

  const row = rows[0] as { retailer_name?: unknown; expires_at?: unknown; email_matches?: unknown };
  if (row.email_matches !== true) {
    // Valid token, wrong/unverified account. Reveal nothing about the invitation.
    return { status: "mismatch" };
  }

  const retailerName = typeof row.retailer_name === "string" ? row.retailer_name.trim() : "";
  if (retailerName.length === 0) {
    // A positive match must carry a Retailer name; anything else is drift.
    return { status: "unavailable" };
  }
  const expiresAt =
    typeof row.expires_at === "string" && row.expires_at.trim().length > 0
      ? row.expires_at
      : null;

  return { status: "match", retailerName, expiresAt };
}

/**
 * Accepts the invitation named by a server-calculated token hash, as the current
 * signed-in user. Every database refusal (wrong account, expired, revoked, active
 * owner already present, unverified email) collapses to `refused`.
 */
export async function acceptExistingUserInvitation(
  tokenHash: string,
): Promise<AcceptExistingUserInvitationResult> {
  if (!isValidTokenHash(tokenHash)) return { status: "refused" };

  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(ACCEPT_RPC, { p_token_hash: tokenHash }),
  ).catch(() => null);

  if (result === null) return { status: "unavailable" };
  if (result.error) {
    // The RPC raises insufficient_privilege for every refusal; the message is never
    // surfaced. A non-privilege error is treated as a transient failure.
    const code = (result.error as { code?: string }).code;
    return code === "42501" ? { status: "refused" } : { status: "unavailable" };
  }
  return { status: "accepted" };
}
