// SERVER-ONLY MODULE.
//
// Wires the REAL effects into the pure delivery sequence in
// @/lib/staff/staff-invite-flow. It transitively imports the service-role admin client
// and `next/headers`, so it can only ever run on the server, and it is never imported
// by a Client Component.
//
// WHICH CLIENT DOES WHAT, and why:
//   reserve   — the CALLER'S OWN token (publishable key). This is the authorization
//               step; it must run as the Retailer Owner so the RPC can resolve them
//               from auth.uid() and refuse anyone without RETAILER_STAFF_MANAGE.
//   revoke    — likewise the caller's own token, for the same reason.
//   prepare / record sent / record failure — the SERVICE-ROLE client, because those
//               three RPCs are granted to service_role ONLY (migration 20260724090000
//               revokes them from anon and authenticated). They carry the entire
//               decision themselves and are keyed by an invitation id the server just
//               reserved plus the expected token hash.
//
// THE RAW TOKEN. Generated here by @/lib/invitations/existing-user-token (Node crypto,
// 32 random bytes, base64url) and handed to the email sender, which is the only thing
// that ever sees it. It is never stored, never logged, never returned, and never
// placed in a result. Only its SHA-256 hash reaches PostgreSQL, and the hash is absent
// from every value this module returns — nothing here can reach a browser.
import { createClient } from "@/lib/supabase/server";
import {
  createAdminClient,
  SupabaseAdminConfigurationError,
} from "@/lib/supabase/admin";
import { generateInvitationToken } from "@/lib/invitations/existing-user-token";
import { sendStaffInvitationEmail } from "@/lib/staff/staff-invitation-email";
import { retailerRoleDisplayName } from "@/lib/staff/staff-roles";
import {
  runStaffInviteFlow,
  type StaffInviteFlowPorts,
  type StaffInviteFlowResult,
  type StaffInvitePrepareResult,
  type StaffInviteReserveInput,
  type StaffInviteReserveResult,
} from "@/lib/staff/staff-invite-flow";

const RESERVE_RPC = "reserve_retailer_staff_invitation" as const;
const PREPARE_RPC = "prepare_retailer_staff_invitation" as const;
const RECORD_SENT_RPC = "record_retailer_staff_invitation_sent" as const;
const RECORD_FAILURE_RPC = "record_retailer_staff_invitation_failure" as const;
const REVOKE_RPC = "revoke_retailer_staff_invitation" as const;

/** SQLSTATEs the staff RPCs raise. Only the CODE is ever inspected, never a message. */
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * The one exception to "never read an error message" in this codebase, and a narrow
 * one.
 *
 * public.reserve_retailer_staff_invitation raises this EXACT literal — defined in
 * migration 20260723210000, in this repository — when a live PENDING invitation exists
 * for the address whose role or shop set differs from what was submitted. It is our
 * own string, not a provider's, it is compared rather than parsed, and it is never
 * forwarded to the browser: matching it only selects which of THIS codebase's messages
 * to render. If the migration's wording ever changes, the match fails and the outcome
 * degrades to the generic rejection — never to a wrong action.
 */
const ROLE_OR_SHOP_CONFLICT_MESSAGE =
  "Revoke and re-issue this invitation to change its role or shops";

/** Sanitized operator logging. No ids, emails, tokens, hashes, or error objects. */
function logStaffInviteFailure(category: string): void {
  console.error(`[retailer-staff-invite] ${category}`);
}

/** One row of reserve_retailer_staff_invitation(). */
type ReservationRow = {
  invitation_id?: unknown;
  normalized_email?: unknown;
  is_resend?: unknown;
};

/** One row of prepare_retailer_staff_invitation(). */
type PreparationRow = {
  normalized_email?: unknown;
  first_name?: unknown;
  retailer_name?: unknown;
  role_code?: unknown;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Sends (or resends) a Retailer staff invitation.
 *
 * Every value in `input` has already been canonicalized and validated by
 * @/lib/staff/staff-invite-input, INCLUDING the rule that each shop id came from
 * public.list_retailer_staff_assignable_shops(). The reservation RPC re-applies every
 * one of those rules and is the final authority.
 */
export async function sendRetailerStaffInvitation(
  input: StaffInviteReserveInput,
): Promise<StaffInviteFlowResult> {
  // The service-role client is built FIRST so a missing key fails before anything is
  // written. A configuration gap is reported as `misconfigured`, never as a throw.
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    if (error instanceof SupabaseAdminConfigurationError) {
      logStaffInviteFailure("configuration is incomplete");
      return { status: "misconfigured" };
    }
    logStaffInviteFailure("setup failed");
    return { status: "unavailable" };
  }

  const supabase = await createClient();

  const ports: StaffInviteFlowPorts = {
    async reserve(reserveInput): Promise<StaffInviteReserveResult> {
      const result = await Promise.resolve(
        supabase.rpc(RESERVE_RPC, {
          p_email: reserveInput.email,
          p_first_name: reserveInput.firstName,
          p_last_name: reserveInput.lastName,
          p_role_code: reserveInput.roleCode,
          // An empty array, never null: the RPC treats both as "no shops", and an
          // explicit [] is what a Retailer Manager invitation must send.
          p_shop_ids: reserveInput.shopIds,
        }),
      ).catch(() => null);

      if (result === null) {
        logStaffInviteFailure("reserve transport");
        return { status: "unavailable" };
      }

      if (result.error) {
        const error = result.error as { code?: string; message?: string };
        if (error.code === INSUFFICIENT_PRIVILEGE) {
          return { status: "rejected" };
        }
        if (
          typeof error.message === "string" &&
          error.message.includes(ROLE_OR_SHOP_CONFLICT_MESSAGE)
        ) {
          return { status: "conflict" };
        }
        // Every other refusal — an inactive Retailer, a retired recipient profile, an
        // address already a member, an invalid shop, a malformed input the database
        // caught — collapses to one generic outcome. The message is not logged.
        return { status: "rejected" };
      }

      const rows = result.data as unknown;
      const row: ReservationRow | undefined = Array.isArray(rows) ? rows[0] : undefined;
      const invitationId = nonEmptyString(row?.invitation_id);
      const normalizedEmail = nonEmptyString(row?.normalized_email);

      if (!row || invitationId === null || normalizedEmail === null) {
        logStaffInviteFailure("reserve returned an unusable result");
        return { status: "unavailable" };
      }

      return {
        status: "ok",
        invitationId,
        normalizedEmail,
        isResend: row.is_resend === true,
      };
    },

    generateToken() {
      // 32 cryptographically random bytes, base64url-encoded, plus its lowercase
      // SHA-256 hex digest. A NEW pair on every call — which is what makes a resend
      // and a post-failure retry rotate the token rather than replay a stale link.
      return generateInvitationToken();
    },

    async prepare({ invitationId, tokenHash }): Promise<StaffInvitePrepareResult> {
      const result = await Promise.resolve(
        admin.rpc(PREPARE_RPC, {
          p_invitation_id: invitationId,
          p_token_hash: tokenHash,
        }),
      ).catch(() => null);

      if (result === null || result.error) {
        logStaffInviteFailure("prepare failed");
        return { status: "unavailable" };
      }

      const rows = result.data as unknown;
      const row: PreparationRow | undefined = Array.isArray(rows) ? rows[0] : undefined;
      const normalizedEmail = nonEmptyString(row?.normalized_email);
      const firstName = nonEmptyString(row?.first_name);
      const retailerName = nonEmptyString(row?.retailer_name);
      const roleCode = nonEmptyString(row?.role_code);

      if (
        !row ||
        normalizedEmail === null ||
        firstName === null ||
        retailerName === null ||
        roleCode === null
      ) {
        logStaffInviteFailure("prepare returned an unusable result");
        return { status: "unavailable" };
      }

      return { status: "ok", normalizedEmail, firstName, retailerName, roleCode };
    },

    async sendEmail(emailInput) {
      // The sender owns APP_ORIGIN and builds the accept URL from the raw token
      // itself. The raw token leaves this process only inside that emailed URL.
      return sendStaffInvitationEmail({
        toEmail: emailInput.toEmail,
        firstName: emailInput.firstName,
        retailerName: emailInput.retailerName,
        roleDisplayName: emailInput.roleDisplayName,
        rawToken: emailInput.rawToken,
      });
    },

    async recordSent({ invitationId, tokenHash }) {
      // Best-effort: a failure here never changes the user-facing outcome (see the
      // sequence's own note). Nothing about the error is bound or logged.
      const result = await Promise.resolve(
        admin.rpc(RECORD_SENT_RPC, {
          p_invitation_id: invitationId,
          p_expected_token_hash: tokenHash,
        }),
      ).catch(() => null);
      if (result === null || result.error) {
        logStaffInviteFailure("could not record send success");
      }
    },

    async recordFailure({ invitationId, tokenHash }) {
      const result = await Promise.resolve(
        admin.rpc(RECORD_FAILURE_RPC, {
          p_invitation_id: invitationId,
          p_expected_token_hash: tokenHash,
        }),
      ).catch(() => null);
      if (result === null || result.error) {
        logStaffInviteFailure("could not record delivery failure");
      }
    },

    roleDisplayName(roleCode) {
      return retailerRoleDisplayName(roleCode);
    },
  };

  return runStaffInviteFlow(input, ports);
}

export type RevokeStaffInvitationResult =
  | { status: "revoked" }
  /** Not authorized, not this Retailer's invitation, or no longer live. Generic. */
  | { status: "refused" }
  | { status: "unavailable" };

/**
 * Revokes one live PENDING staff invitation.
 *
 * ONE identifier is sent, and it is an ADDRESS rather than authorization. The RPC
 * derives the Retailer from auth.uid() and filters on
 * `id = $1 AND retailer_organization_id = <derived> AND status = 'PENDING'`, so an
 * invitation id belonging to another Retailer selects nothing and is refused with the
 * same generic exception as an unauthorized caller. No table is written here — there
 * is no `.from(` in this module at all.
 *
 * NOT feature-flagged, deliberately: withdrawing an invitation is the safety valve,
 * and a kill switch that can itself be switched off is not one.
 */
export async function revokeRetailerStaffInvitation(
  invitationId: string,
): Promise<RevokeStaffInvitationResult> {
  const supabase = await createClient();

  const result = await Promise.resolve(
    supabase.rpc(REVOKE_RPC, { p_invitation_id: invitationId }),
  ).catch(() => null);

  if (result === null) {
    logStaffInviteFailure("revoke transport");
    return { status: "unavailable" };
  }

  if (result.error) {
    // The RPC raises insufficient_privilege for every refusal — unauthorized, wrong
    // tenant, unknown id, already terminal. The message is never bound or surfaced.
    const code = (result.error as { code?: string }).code;
    if (code === INSUFFICIENT_PRIVILEGE) {
      return { status: "refused" };
    }
    logStaffInviteFailure("revoke rpc-error");
    return { status: "unavailable" };
  }

  return { status: "revoked" };
}
