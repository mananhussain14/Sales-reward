// SERVER-ONLY MODULE.
//
// The two recipient operations for the staff acceptance page, each a thin wrapper over
// one SECURITY DEFINER RPC called under the CALLER'S OWN token (the ordinary
// publishable-key server client — never service-role). The RPCs perform the real
// authorization: they resolve auth.uid(), require a CONFIRMED Auth email that exactly
// matches the invitation's canonical address, and never return a foreign email or
// Retailer to a wrong signed-in user.
//
// The token HASH is supplied by the caller (read from the HttpOnly cookie server-side).
// The RAW token never reaches these functions or the database, and neither value is
// logged. No table is read or written directly — `.from(` appears nowhere here, and
// acceptance performs no profile, membership, member-role or shop write in application
// code: public.accept_retailer_staff_invitation does all of it atomically.
import { createClient } from "@/lib/supabase/server";
import { isValidTokenHash } from "@/lib/invitations/existing-user-token";
import {
  normalizeRecipientInvitation,
  type RecipientInvitation,
} from "@/lib/staff/staff-normalization";

const RESOLVE_RPC = "get_retailer_staff_invitation_for_recipient" as const;
const ACCEPT_RPC = "accept_retailer_staff_invitation" as const;

/** SQLSTATE the acceptance RPC raises for every refusal. */
const INSUFFICIENT_PRIVILEGE = "42501";

export type ResolveStaffInvitationResult =
  /** Live, and the caller's verified email matches. Display-safe fields only. */
  | { status: "match"; invitation: RecipientInvitation }
  /**
   * ONE generic outcome for every unavailable case: unknown, malformed, expired,
   * revoked, already accepted, wrong signed-in account, unverified email, an inactive
   * Retailer or role, or an intended shop that is no longer valid. The RPC returns
   * zero rows for all of them and never says which — so neither does this.
   */
  | { status: "unavailable" };

export type AcceptStaffInvitationResult =
  | { status: "accepted" }
  /** The database refused. Generic — see above. */
  | { status: "refused" }
  /** A transport/database failure. Retrying is worthwhile. */
  | { status: "unavailable" };

/** Sanitized operator logging. Never the hash, the error object, or any row. */
function logAcceptanceFailure(category: string): void {
  console.error(`[retailer-staff-acceptance] ${category}`);
}

/**
 * Resolves the invitation named by a server-calculated token hash for the current
 * signed-in user.
 *
 * A malformed hash short-circuits to `unavailable` without a round trip — and lands on
 * the same outcome as a wrong account or an expired invitation, so the caller cannot
 * tell the cases apart.
 */
export async function resolveStaffInvitation(
  tokenHash: string,
): Promise<ResolveStaffInvitationResult> {
  if (!isValidTokenHash(tokenHash)) return { status: "unavailable" };

  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(RESOLVE_RPC, { p_token_hash: tokenHash }),
  ).catch(() => null);

  if (result === null) {
    logAcceptanceFailure("resolve transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    // The RPC is declared to return zero rows rather than raise, so an error here is
    // operational. Its message can name tables, columns, functions and policies and is
    // never bound or surfaced.
    logAcceptanceFailure("resolve rpc-error");
    return { status: "unavailable" };
  }

  const normalized = normalizeRecipientInvitation(result.data as unknown);

  if (normalized.status === "malformed") {
    // The reason names only field names — never values — so it is safe to log. The
    // recipient sees the ordinary generic screen.
    logAcceptanceFailure(`resolve malformed:${normalized.reason}`);
    return { status: "unavailable" };
  }
  if (normalized.status === "unavailable") {
    return { status: "unavailable" };
  }

  return { status: "match", invitation: normalized.invitation };
}

/**
 * Accepts the invitation named by a server-calculated token hash, as the current
 * signed-in user.
 *
 * THE ONLY WRITE THIS FLOW PERFORMS, and it is one RPC call. Profile creation or
 * permitted activation, the ACTIVE membership, the single member-role edge, the Sales
 * Staff shop rows, the invitation finalization, the token clearing and the audit event
 * all happen inside public.accept_retailer_staff_invitation, atomically. None of it is
 * duplicated here, and a partial failure rolls the whole thing back in the database.
 *
 * Every database refusal — wrong account, unverified email, expired, revoked, already
 * accepted, an existing membership, a retired profile, an inactive shop — arrives as
 * insufficient_privilege and collapses to `refused`.
 */
export async function acceptStaffInvitation(
  tokenHash: string,
): Promise<AcceptStaffInvitationResult> {
  if (!isValidTokenHash(tokenHash)) return { status: "refused" };

  const supabase = await createClient();
  const result = await Promise.resolve(
    supabase.rpc(ACCEPT_RPC, { p_token_hash: tokenHash }),
  ).catch(() => null);

  if (result === null) {
    logAcceptanceFailure("accept transport");
    return { status: "unavailable" };
  }
  if (result.error) {
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) return { status: "refused" };
    logAcceptanceFailure("accept rpc-error");
    return { status: "unavailable" };
  }

  return { status: "accepted" };
}
