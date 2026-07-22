// SERVER-ONLY MODULE.
//
// Orchestrates the EXISTING-USER Retailer Owner invitation across PostgreSQL and
// Resend. It transitively imports the service-role admin client and `next/headers`,
// so it can only ever run on the server.
//
// THE SEQUENCE, and why:
//   1. getVendorRetailerDetail()  [caller token]  — authorizes the Vendor, reads the
//        canonical Retailer name and the authoritative owner status. Nothing the
//        browser submitted influences the recipient or names.
//   2. classifyOwnerAction()      — permits ONLY an existing-user action kind
//        (send/resend/retry-existing). ACTIVE and terminal states are refused.
//   3. reserve_retailer_owner_invitation()  [caller token]  — obtains or reuses the
//        invitation id with the CANONICAL email + names (same-email reuse; it also
//        clears any prior failure classification).
//   4. generateInvitationToken()  — a fresh cryptographically random raw token +
//        its SHA-256 hash. Every send ROTATES the token.
//   5. prepare_existing_user_retailer_owner_invitation()  [service-role]  — converts
//        the row to EXISTING_USER, stores ONLY the hash, clears sent_at.
//   6. sendExistingUserInvitationEmail()  — Resend delivers the app-owned link.
//   7. record_existing_user_..._sent() on success, or
//      record_retailer_owner_invitation_failure(EXISTING_USER_EMAIL_FAILED) on
//      failure — both service-role, both best-effort.
//
// inviteUserByEmail() is NEVER called on this path. The raw token exists only in
// the emailed URL and is never stored, logged, or returned to the browser.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, SupabaseAdminConfigurationError } from "@/lib/supabase/admin";
import { getVendorRetailerDetail } from "@/lib/retailers/vendor-retailer-detail";
import {
  classifyOwnerAction,
  isExistingUserActionPlan,
} from "@/lib/retailers/owner-status-normalization";
import { generateInvitationToken } from "@/lib/invitations/existing-user-token";
import { sendExistingUserInvitationEmail } from "@/lib/invitations/resend-email";

/** The closed set of safe outcomes. No id, email, token, or provider detail. */
export type SendExistingUserInvitationResult =
  /** Reserved, prepared, and emailed. */
  | { status: "sent" }
  /** Prepared, but the email did not send (transient). Classified EXISTING_USER_EMAIL_FAILED. */
  | { status: "email-failed" }
  /** The Retailer already has an active owner. */
  | { status: "blocked-active" }
  /** The current state does not permit an existing-user send (e.g. it became a new-user or terminal state). */
  | { status: "blocked" }
  /** Service-role key / APP_ORIGIN / Resend configuration missing or malformed. */
  | { status: "misconfigured" }
  /** A transport/database/authorization failure. Nothing specific is surfaced. */
  | { status: "unavailable" };

/** One row of reserve_retailer_owner_invitation(). */
type ReservationRow = { invitation_id: string; normalized_email: string; is_resend: boolean };

/** Best-effort service-role failure recording. Never changes the user-facing result. */
async function recordSendFailure(
  admin: ReturnType<typeof createAdminClient>,
  invitationId: string,
): Promise<void> {
  const result = await Promise.resolve(
    admin.rpc("record_retailer_owner_invitation_failure", {
      p_invitation_id: invitationId,
      p_failure_code: "EXISTING_USER_EMAIL_FAILED",
    }),
  ).catch(() => null);
  if (result === null || result.error) {
    console.error("existing-user-invite: could not record EXISTING_USER_EMAIL_FAILED");
  }
}

/**
 * Sends (or resends) an existing-user Retailer Owner invitation for one relationship.
 *
 * @param relationshipId The vendor_retailers row id. An ADDRESS: the reads and RPCs
 *   below re-derive the Vendor from auth.uid() and re-verify ownership.
 */
export async function sendExistingUserRetailerOwnerInvitation(
  relationshipId: string,
): Promise<SendExistingUserInvitationResult> {
  // 0. Service-role client first, so a missing service-role key fails before writing.
  //    APP_ORIGIN and the Resend key/sender are validated by the email sender at step
  //    5; a gap there returns "misconfigured" (and records a best-effort failure)
  //    rather than throwing, so no configuration gap becomes an uncaught error.
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (error) {
    if (error instanceof SupabaseAdminConfigurationError) {
      console.error("existing-user-invite: configuration is incomplete");
      return { status: "misconfigured" };
    }
    console.error("existing-user-invite: setup failed");
    return { status: "unavailable" };
  }

  // 1. Authorize + read the canonical Retailer name and owner status (caller token).
  const detail = await getVendorRetailerDetail(relationshipId);
  if (detail.status !== "authorized") {
    // unauthenticated / unauthorized / not-found / unavailable all collapse here:
    // the caller cannot act, and the specific cause must not leak.
    return { status: "unavailable" };
  }
  if (detail.ownerStatus.status !== "ok") {
    return { status: "unavailable" };
  }

  const status = detail.ownerStatus.ownerStatus;
  const plan = classifyOwnerAction(status);

  if (plan.kind === "none") {
    return status.state === "ACTIVE" ? { status: "blocked-active" } : { status: "blocked" };
  }
  if (!isExistingUserActionPlan(plan)) {
    // The state is a new-user one; this action does not handle it. Narrowing `plan`
    // (not just its kind) is what lets `plan.email` below be read without a cast.
    return { status: "blocked" };
  }

  const firstName = status.firstName ?? "";
  const lastName = status.lastName ?? "";
  if (firstName.length === 0 || lastName.length === 0) {
    return { status: "unavailable" };
  }

  // 2. Reserve (or reuse) under the caller's token, with canonical values.
  const supabase = await createClient();
  const reservation = await Promise.resolve(
    supabase.rpc("reserve_retailer_owner_invitation", {
      p_relationship_id: relationshipId,
      p_email: plan.email,
      p_first_name: firstName,
      p_last_name: lastName,
    }),
  ).catch(() => null);

  if (reservation === null || reservation.error || !reservation.data) {
    // The RPC blocks an active owner and cross-tenant / inactive states with generic
    // exceptions; nothing from it is surfaced.
    console.error("existing-user-invite: reservation was refused");
    return { status: "unavailable" };
  }

  const reserved = (reservation.data as ReservationRow[])[0];
  if (
    !reserved ||
    typeof reserved.invitation_id !== "string" ||
    typeof reserved.normalized_email !== "string"
  ) {
    console.error("existing-user-invite: reservation returned an unusable result");
    return { status: "unavailable" };
  }

  // 3. Fresh token + hash. The RAW token is used only for the URL below.
  const { rawToken, tokenHash } = generateInvitationToken();

  // 4. Prepare (service-role): convert to EXISTING_USER and store the hash.
  const prepared = await Promise.resolve(
    admin.rpc("prepare_existing_user_retailer_owner_invitation", {
      p_invitation_id: reserved.invitation_id,
      p_token_hash: tokenHash,
    }),
  ).catch(() => null);

  if (prepared === null || prepared.error) {
    console.error("existing-user-invite: preparation failed");
    return { status: "unavailable" };
  }

  // 5. Send through Resend. The sender reads APP_ORIGIN and builds the accept URL
  //    from this raw token itself; the raw token leaves this process only inside that
  //    emailed URL and is never stored or logged.
  const email = await sendExistingUserInvitationEmail({
    toEmail: reserved.normalized_email,
    retailerName: detail.retailer.retailerName,
    rawToken,
  });

  if (email.status === "sent") {
    // 6a. Record the successful send (best-effort). It promotes DELIVERY_FAILED to
    // PENDING and clears the classification.
    const recorded = await Promise.resolve(
      admin.rpc("record_existing_user_retailer_owner_invitation_sent", {
        p_invitation_id: reserved.invitation_id,
      }),
    ).catch(() => null);
    if (recorded === null || recorded.error) {
      console.error("existing-user-invite: could not record send success");
    }
    return { status: "sent" };
  }

  // 6b. Not sent — classify EXISTING_USER_EMAIL_FAILED (best-effort) either way.
  await recordSendFailure(admin, reserved.invitation_id);
  return email.status === "misconfigured"
    ? { status: "misconfigured" }
    : { status: "email-failed" };
}
