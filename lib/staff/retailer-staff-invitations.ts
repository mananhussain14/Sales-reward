// SERVER-ONLY MODULE.
//
// The web portal's two staff-invitation effects. Since this milestone they do very
// different amounts of work:
//
//   sendRetailerStaffInvitation  — a thin client of the SHARED Edge Function
//                                  `send-retailer-staff-invitation`, called with the
//                                  signed-in operator's own access token.
//   revokeRetailerStaffInvitation — one RPC under the caller's own token, unchanged.
//
// ============================================================================
// WHY SENDING MOVED OUT OF THE WEB PROCESS
// ============================================================================
// The web and the Flutter app must send the same invitation, and "the same" has to mean
// one implementation rather than two that agree today. Everything privileged now lives
// behind one door: the service-role key, the Resend credential, APP_ORIGIN, the token
// generation, and the reserve -> prepare -> send -> record order. This module supplies
// none of them and can leak none of them.
//
// AFTER THE MIGRATION, THIS FILE NO LONGER:
//   * constructs a service-role Supabase client (there is no `createAdminClient` here);
//   * names prepare_retailer_staff_invitation, record_retailer_staff_invitation_sent, or
//     record_retailer_staff_invitation_failure;
//   * calls Resend, or reads RESEND_API_KEY / RESEND_FROM / APP_ORIGIN;
//   * generates or hashes an invitation token;
//   * knows the invitation id, the raw token, or the token hash — none of the three
//     appears in anything the Edge Function returns.
// lib/staff/staff-source-safety.test.ts asserts each of those as a rule, so a later edit
// that reintroduces a second delivery path fails the build rather than shipping.
//
// ============================================================================
// THE ACCESS TOKEN, AND WHY getSession() IS RIGHT HERE
// ============================================================================
// This module needs the caller's access token as a STRING to forward, not an
// authorization decision — so `getSession()` is the correct call, and the usual rule
// ("use getUser(), not getSession()") is not being bent. Nothing here trusts the token:
// the Edge Function's gateway verifies the JWT (`verify_jwt = true`), the function
// revalidates it with `auth.getUser()` against the Auth server, and
// reserve_retailer_staff_invitation() then decides every question about identity,
// Retailer, permission and shop ownership from `auth.uid()` in PostgreSQL. The Server
// Action has ALSO already resolved portal access with getUser() before reaching here.
// A forged or stale token forwarded from this line buys nothing: it fails at the
// boundary that acts on it.
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/env/supabase";
import {
  isStaffInvitationCode,
  STAFF_INVITATION_CONTRACT_VERSION,
  type StaffInvitationCode,
} from "@/lib/staff/staff-invitation-delivery-contract";

/**
 * What the portal hands this module.
 *
 * `roleCode` is a plain string rather than the contract's narrowed union deliberately:
 * the Server Action's validator has already restricted it to the two invitable codes,
 * but a TYPE is not a check, and this module is not the place to pretend otherwise. The
 * Edge Function re-validates the role against the same allow-set and the reservation RPC
 * resolves it against the database's own catalogue. Anything unexpected is refused
 * there, with a stable code, rather than being made unrepresentable here.
 */
export type SendStaffInvitationInput = {
  firstName: string;
  lastName: string;
  email: string;
  roleCode: string;
  shopIds: string[];
};

/** The RPC this module still calls directly, under the caller's own token. */
const REVOKE_RPC = "revoke_retailer_staff_invitation" as const;

/** The shared Edge Function's name, and the path shape the gateway serves it on. */
const SEND_FUNCTION = "send-retailer-staff-invitation" as const;

/** SQLSTATEs the staff RPCs raise. Only the CODE is ever inspected, never a message. */
const INSUFFICIENT_PRIVILEGE = "42501";

/** Sanitized operator logging. No ids, emails, tokens, hashes, or error objects. */
function logStaffInviteFailure(category: string): void {
  console.error(`[retailer-staff-invite] ${category}`);
}

/**
 * The outcomes the Retailer portal renders.
 *
 * A closed union of plain statuses, exactly as before: no invitation id, no email, no
 * token, no hash, no provider code, no HTTP status, no backend text. The Server Action
 * maps each to one of this codebase's own strings.
 */
export type StaffInviteSendResult =
  /** Reserved, prepared, and accepted by the provider — a first send. */
  | { status: "sent" }
  /** The same, for an invitation that already existed. */
  | { status: "resent" }
  /**
   * THE PARTIAL SUCCESS, new in this milestone. The provider accepted the message and
   * the accept link is live, but the write that records `sent_at` could not be
   * confirmed. Reported separately because the operator is about to re-read an
   * invitation history that may not yet say "sent", and because the ONE thing the UI
   * must not do is quietly resend — that would rotate the token and kill the link that
   * has already been delivered.
   */
  | { status: "sent-unconfirmed" }
  /** Prepared, but the provider did not accept it. The invitation stays live. */
  | { status: "delivery-failed" }
  /** The delivery service's own configuration is absent or invalid. */
  | { status: "misconfigured" }
  /** A live invitation exists with a different role or shop set. */
  | { status: "conflict" }
  /** Sending is switched off in the Edge Function's own environment. */
  | { status: "paused" }
  /** The database refused the reservation. Generic. */
  | { status: "rejected" }
  /** A transport, gateway, or unexpected failure at any step. */
  | { status: "unavailable" };

/**
 * Every contract code the Edge Function can return, mapped to what the portal shows.
 *
 * Written as an exhaustive record rather than a switch with a default so that adding a
 * code to the contract is a TYPE ERROR here until this file decides what it means. A
 * silently-defaulted new code is how a delivery outcome starts being rendered as a
 * generic failure without anyone noticing.
 */
const RESULT_FOR_CODE: Record<StaffInvitationCode, StaffInviteSendResult> = {
  SENT: { status: "sent" },
  RESENT: { status: "resent" },
  DELIVERY_ACCEPTED_STATUS_UNCONFIRMED: { status: "sent-unconfirmed" },
  DELIVERY_FAILED: { status: "delivery-failed" },
  INVITATION_CONFLICT: { status: "conflict" },
  FEATURE_DISABLED: { status: "paused" },
  NOT_CONFIGURED: { status: "misconfigured" },
  // Every refusal the operator cannot act on specifically collapses to one generic
  // outcome, exactly as before. The RPCs already refuse most of these with a single
  // byte-identical exception so they cannot be used as an existence oracle, and
  // distinguishing them in the UI would reintroduce that disclosure.
  ACCESS_DENIED: { status: "rejected" },
  RETAILER_INACTIVE: { status: "rejected" },
  INVALID_REQUEST: { status: "rejected" },
  INVALID_ROLE_SHOP_COMBINATION: { status: "rejected" },
  AUTH_REQUIRED: { status: "rejected" },
  // Neither should be reachable from this client: it always POSTs, and INTERNAL_ERROR
  // is the function's own opaque failure. Both are infrastructure, not user error.
  METHOD_NOT_ALLOWED: { status: "unavailable" },
  INTERNAL_ERROR: { status: "unavailable" },
};

/**
 * Sends (or resends) a Retailer staff invitation through the shared Edge Function.
 *
 * WHAT IS PUT ON THE WIRE, EXHAUSTIVELY: the five fields of `SendStaffInvitationInput`.
 * The body is built field-by-field from that type rather than by spreading the caller's
 * object, so a field added upstream cannot ride along unnoticed. There is no Retailer
 * organization id, actor id, profile id, membership id, permission, invitation id,
 * token, hash, audit field, invitation state, or expiry in it — and the Edge Function
 * would reject an unknown key anyway.
 *
 * Every value has already been canonicalized and validated by
 * @/lib/staff/staff-invite-input, INCLUDING the rule that each shop id came from
 * public.list_retailer_staff_assignable_shops(). The Edge Function re-validates the
 * whole request and the reservation RPC re-applies every rule again; both are ahead of
 * this module in authority, and neither trusts it.
 */
export async function sendRetailerStaffInvitation(
  input: SendStaffInvitationInput,
): Promise<StaffInviteSendResult> {
  let url: string;
  let publishableKey: string;
  try {
    ({ url, publishableKey } = getSupabaseEnv());
  } catch {
    // The thrown message names only the missing variable; it is not bound or forwarded.
    logStaffInviteFailure("supabase configuration is incomplete");
    return { status: "misconfigured" };
  }

  const supabase = await createClient();

  // See this module's header: the token is fetched to be FORWARDED, not believed.
  const sessionResult = await Promise.resolve(supabase.auth.getSession()).catch(
    () => null,
  );
  const accessToken = sessionResult?.data?.session?.access_token;

  if (typeof accessToken !== "string" || accessToken.length === 0) {
    // The session lapsed between the action's own getUser() check and this call.
    logStaffInviteFailure("no access token for the caller");
    return { status: "unavailable" };
  }

  let response: Response;
  try {
    response = await fetch(`${url}/functions/v1/${SEND_FUNCTION}`, {
      method: "POST",
      headers: {
        // The caller's own token. This is what makes auth.uid() the real operator.
        Authorization: `Bearer ${accessToken}`,
        // The publishable key the gateway expects. A public value; never the
        // service-role key, which this process does not read at all.
        apikey: publishableKey,
        "Content-Type": "application/json",
      },
      // No cookies: the send is a bearer-token request, deliberately.
      credentials: "omit",
      body: JSON.stringify({
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        roleCode: input.roleCode,
        shopIds: input.shopIds,
      }),
    });
  } catch {
    // A transport throw can carry the request headers, which include the access token.
    // Nothing is bound, inspected, or logged.
    logStaffInviteFailure("send transport");
    return { status: "unavailable" };
  }

  const body = await response.json().catch(() => null);

  if (
    body === null ||
    typeof body !== "object" ||
    (body as { version?: unknown }).version !== STAFF_INVITATION_CONTRACT_VERSION
  ) {
    // A body this build does not understand — a gateway error page, or a future
    // contract version. Treated as an outage rather than guessed at. Deliberately NOT
    // logged with its content: a gateway error page can name the project.
    logStaffInviteFailure("unrecognized delivery response");
    return { status: "unavailable" };
  }

  const code = (body as { code?: unknown }).code;

  if (!isStaffInvitationCode(code)) {
    logStaffInviteFailure("unrecognized delivery code");
    return { status: "unavailable" };
  }

  return RESULT_FOR_CODE[code];
}

export type RevokeStaffInvitationResult =
  | { status: "revoked" }
  /** Not authorized, not this Retailer's invitation, or no longer live. Generic. */
  | { status: "refused" }
  | { status: "unavailable" };

/**
 * Revokes one live PENDING staff invitation.
 *
 * UNCHANGED BY THIS MILESTONE, and deliberately still a direct RPC: it needs no
 * service-role key, no email, and no token, so there is nothing for an Edge Function to
 * hold on its behalf. It runs under the caller's own token like every other authorized
 * read and write in the portal.
 *
 * ONE identifier is sent, and it is an ADDRESS rather than authorization. The RPC
 * derives the Retailer from auth.uid() and filters on
 * `id = $1 AND retailer_organization_id = <derived> AND status = 'PENDING'`, so an
 * invitation id belonging to another Retailer selects nothing and is refused with the
 * same generic exception as an unauthorized caller. No table is written here — there is
 * no `.from(` in this module at all.
 *
 * NOT feature-flagged, deliberately: withdrawing an invitation is the safety valve, and
 * a kill switch that can itself be switched off is not one.
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
