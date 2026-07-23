"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  isRetailerStaffInvitationsEnabled,
  RETAILER_STAFF_INVITATIONS_PAUSED_MESSAGE,
} from "@/lib/features/retailer-staff-invitations";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import {
  getRetailerStaffAssignableShops,
  getRetailerStaffInvitations,
} from "@/lib/staff/retailer-staff-data";
import {
  revokeRetailerStaffInvitation,
  sendRetailerStaffInvitation,
} from "@/lib/staff/retailer-staff-invitations";
import {
  normalizeStaffInviteInput,
  validateStaffInviteInput,
} from "@/lib/staff/staff-invite-input";
import { canResendInvitation } from "@/lib/staff/staff-normalization";
import {
  EMPTY_INVITE_STAFF_VALUES,
  type InviteStaffState,
} from "@/app/(retailer)/retailer/staff/invite-staff-state";
import type { InvitationActionState } from "@/app/(retailer)/retailer/staff/invitation-action-state";

/**
 * Server Actions for the Retailer staff-management page.
 *
 * NO TABLE IS WRITTEN HERE, AND NO SERVICE-ROLE CLIENT IS CONSTRUCTED HERE. Every
 * effect is delegated to @/lib/staff/retailer-staff-invitations, which runs the
 * reserve → prepare → send → record sequence. `.from(` appears nowhere in this module.
 *
 * A SERVER ACTION IS A PUBLIC ENDPOINT. It is reachable by a hand-crafted POST from
 * any client, regardless of which page rendered the form or whether that page rendered
 * at all. So every action below re-establishes its own footing rather than trusting
 * the route: the feature gate is re-applied, the portal access is re-resolved, and the
 * authoritative data is re-read from the database. Hiding a control removes the
 * accident; only these checks — and the RPCs behind them — remove the capability.
 *
 * WHAT THE BROWSER MAY INFLUENCE, exhaustively:
 *   invite  the recipient's names, email, role code, and a set of shop ids that must
 *           each appear in the list list_retailer_staff_assignable_shops() just
 *           returned for THIS caller.
 *   resend  one invitation id, and nothing else. The recipient, names, role and shop
 *           set are re-read from the database, never taken from the form — a browser
 *           cannot redirect a resend to a different address or widen its shops.
 *   revoke  one invitation id.
 * No Retailer organization id, role UUID, membership id, token, or token hash is
 * accepted from, or returned to, the browser anywhere in this module.
 *
 * Because of the "use server" directive, every runtime export here is exposed as a
 * callable server endpoint, so Next.js rejects anything that is not an async function.
 * The state types live in ./invite-staff-state and ./invitation-action-state;
 * `import type` above is erased at compile time and adds no export.
 */

/** The staff page path — the single revalidation target, a fixed literal. */
const STAFF_PATH = "/retailer/staff";

/**
 * The one message used for every failure that is not a field problem.
 *
 * It covers a refused reservation, an unauthorized caller, an unknown or foreign
 * invitation id, a recipient who is already a member, a retired recipient account, an
 * inactive shop, and a database outage. Collapsing them is deliberate: the RPCs
 * already refuse most of these with a single byte-identical exception so they cannot
 * be used as an existence oracle, and distinguishing them here would reintroduce
 * exactly the disclosure the database went out of its way to prevent.
 */
const GENERIC_INVITE_ERROR =
  "We couldn't send that invitation. Check the details and try again.";

/** Shown when delivery was attempted and the provider did not accept it. */
const DELIVERY_FAILED_MESSAGE =
  "The invitation was created but the email could not be delivered. You can try sending it again.";

/** Shown when the environment is missing its invitation configuration. */
const CONFIGURATION_ERROR =
  "Invitation email is not configured on this environment yet. Please contact support.";

/**
 * Shown when a live invitation exists for the address with a different role or shop
 * set. Safe to name specifically: this outcome is reachable only after the database
 * has proven the caller manages this Retailer, and the invitation is already visible
 * to them in their own list. Telling them the real reason is what lets them act on it.
 */
const CONFLICT_ERROR =
  "A live invitation already exists for this email address with a different role or shops. Revoke it, then create a replacement.";

/** The one message for every revoke failure — unauthorized, foreign id, or terminal. */
const GENERIC_REVOKE_ERROR =
  "We couldn't revoke that invitation. Refresh the page and try again.";

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads one FormData entry as a string, treating a File as absent. */
function readField(formData: FormData, field: string): string {
  const raw = formData.get(field);
  return typeof raw === "string" ? raw : "";
}

/* ---------------------------------------------------------------------------
 * Invite
 * ------------------------------------------------------------------------- */

export async function inviteStaffAction(
  _prevState: InviteStaffState,
  formData: FormData,
): Promise<InviteStaffState> {
  // 1. Read and canonicalize. `getAll` because shop selection is a checkbox group.
  const values = normalizeStaffInviteInput({
    firstName: readField(formData, "firstName"),
    lastName: readField(formData, "lastName"),
    email: readField(formData, "email"),
    roleCode: readField(formData, "roleCode"),
    shopIds: formData.getAll("shopIds"),
  });

  // 2. Feature gate — BEFORE anything touches PostgreSQL, Auth or Resend.
  //
  // Placed first, ahead of validation and authorization, deliberately: everything
  // below is then unreachable on the disabled path, so the paused state makes zero
  // database queries, zero service-role calls and zero provider requests rather than
  // merely zero mutations. The submitted values ride back so a returning operator does
  // not lose their work when the feature is switched on.
  if (!isRetailerStaffInvitationsEnabled()) {
    return {
      fieldErrors: {},
      formError: RETAILER_STAFF_INVITATIONS_PAUSED_MESSAGE,
      successMessage: null,
      values,
    };
  }

  // 3. Authorization, re-resolved from the verified session. Defence in depth: the
  //    reservation RPC evaluates the same chain again from auth.uid() and is what
  //    actually stops an unauthorized or cross-tenant invitation.
  const access = await getRetailerPortalAccess();

  // redirect() signals by throwing NEXT_REDIRECT, so both calls sit outside any
  // try/catch in this module.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }
  if (access.status === "unavailable") {
    return {
      fieldErrors: {},
      formError: GENERIC_INVITE_ERROR,
      successMessage: null,
      values,
    };
  }

  // 4. The assignable shop set, re-read from the database for THIS caller.
  //
  // This is both the source of truth for validation and a second authorization gate:
  // list_retailer_staff_assignable_shops() is granted only to holders of
  // RETAILER_STAFF_SHOP_ASSIGN, so a Manager — or anyone else — lands on `denied` here
  // and can never get a shop id accepted. The browser never supplies this set.
  const assignable = await getRetailerStaffAssignableShops();

  if (assignable.status === "denied") {
    return {
      fieldErrors: {},
      formError: GENERIC_INVITE_ERROR,
      successMessage: null,
      values,
    };
  }
  if (assignable.status === "unavailable") {
    return {
      fieldErrors: {},
      formError: GENERIC_INVITE_ERROR,
      successMessage: null,
      values,
    };
  }

  // 5. Validate, including the subset check against the ids just read.
  const validation = validateStaffInviteInput(
    values,
    assignable.shops.map((shop) => shop.shopId),
  );

  if (!validation.ok) {
    return {
      fieldErrors: validation.fieldErrors,
      formError: null,
      successMessage: null,
      values,
    };
  }

  // 6. Delegate. The service returns a closed union of plain statuses — no ids, no
  //    email, no token, no hash, no provider code. Everything below maps those to this
  //    codebase's own strings; nothing from Resend or PostgreSQL is rendered.
  const result = await sendRetailerStaffInvitation({
    email: values.email,
    firstName: values.firstName,
    lastName: values.lastName,
    roleCode: values.roleCode,
    shopIds: values.shopIds,
  });

  // The list and the roster both change on success and on a recorded delivery
  // failure, so the page is revalidated for every outcome that touched the database.
  if (result.status !== "rejected" && result.status !== "unavailable") {
    revalidatePath(STAFF_PATH);
  }

  switch (result.status) {
    case "sent":
      return {
        fieldErrors: {},
        formError: null,
        successMessage: `Invitation sent to ${values.email}.`,
        // Cleared on success so the next invitation starts from a blank form.
        values: EMPTY_INVITE_STAFF_VALUES,
      };
    case "resent":
      return {
        fieldErrors: {},
        formError: null,
        successMessage: `Invitation re-sent to ${values.email}.`,
        values: EMPTY_INVITE_STAFF_VALUES,
      };
    case "delivery-failed":
      return {
        fieldErrors: {},
        formError: DELIVERY_FAILED_MESSAGE,
        successMessage: null,
        values,
      };
    case "misconfigured":
      return {
        fieldErrors: {},
        formError: CONFIGURATION_ERROR,
        successMessage: null,
        values,
      };
    case "conflict":
      return {
        fieldErrors: {},
        formError: CONFLICT_ERROR,
        successMessage: null,
        values,
      };
    case "rejected":
    case "unavailable":
    default:
      return {
        fieldErrors: {},
        formError: GENERIC_INVITE_ERROR,
        successMessage: null,
        values,
      };
  }
}

/* ---------------------------------------------------------------------------
 * Resend
 * ------------------------------------------------------------------------- */

/**
 * Re-sends a live invitation.
 *
 * THE ONLY THING THE BROWSER SUPPLIES IS AN INVITATION ID. The recipient address,
 * names, role and shop set are re-read from list_retailer_staff_invitations() — which
 * is itself scoped to the Retailer the database derives from auth.uid() — so a
 * hand-crafted POST cannot redirect someone else's invitation to a new address, change
 * its role, or widen its shops. An id for another Retailer's invitation simply is not
 * in the list and is refused generically.
 *
 * The resend takes the SAME path as a first send, which is what guarantees a rotated
 * token: reserve returns is_resend, then a fresh token is generated and prepare
 * invalidates the previous one. No stale link is ever re-delivered.
 */
export async function resendStaffInvitationAction(
  _prevState: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const invitationId = readField(formData, "invitationId").trim();

  if (!isRetailerStaffInvitationsEnabled()) {
    return { error: RETAILER_STAFF_INVITATIONS_PAUSED_MESSAGE, success: null };
  }

  const access = await getRetailerPortalAccess();
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }
  if (access.status === "unavailable") {
    return { error: GENERIC_INVITE_ERROR, success: null };
  }

  // A malformed id gets the same generic message as an unknown or foreign one. It can
  // only come from a tampered form, so there is no legitimate submission this costs.
  if (!UUID_PATTERN.test(invitationId)) {
    return { error: GENERIC_INVITE_ERROR, success: null };
  }

  const invitations = await getRetailerStaffInvitations();
  if (invitations.status !== "ok") {
    // "denied" (not an owner) and "unavailable" are reported identically here: a
    // Manager forging this POST learns nothing about whether the id exists.
    return { error: GENERIC_INVITE_ERROR, success: null };
  }

  const invitation = invitations.invitations.find(
    (candidate) => candidate.invitationId === invitationId.toLowerCase(),
  );

  // Not this Retailer's invitation, or no longer in a state that may be re-sent
  // (accepted, expired, revoked). The database would refuse it too; refusing here
  // avoids a pointless reservation and reports it identically either way.
  if (!invitation || !canResendInvitation(invitation.state)) {
    return { error: GENERIC_INVITE_ERROR, success: null };
  }

  const result = await sendRetailerStaffInvitation({
    email: invitation.email,
    firstName: invitation.firstName,
    lastName: invitation.lastName,
    roleCode: invitation.roleCode,
    shopIds: invitation.shopIds,
  });

  if (result.status !== "rejected" && result.status !== "unavailable") {
    revalidatePath(STAFF_PATH);
  }

  switch (result.status) {
    case "sent":
    case "resent":
      return { error: null, success: `Invitation re-sent to ${invitation.email}.` };
    case "delivery-failed":
      return { error: DELIVERY_FAILED_MESSAGE, success: null };
    case "misconfigured":
      return { error: CONFIGURATION_ERROR, success: null };
    case "conflict":
      return { error: CONFLICT_ERROR, success: null };
    default:
      return { error: GENERIC_INVITE_ERROR, success: null };
  }
}

/* ---------------------------------------------------------------------------
 * Revoke
 * ------------------------------------------------------------------------- */

/**
 * Revokes a live invitation.
 *
 * Calls exactly one RPC — public.revoke_retailer_staff_invitation(uuid) — and writes
 * no table. The invitation id is an ADDRESS, not authorization: the RPC derives the
 * Retailer from auth.uid() and matches on `id AND retailer_organization_id AND status
 * = 'PENDING'`, so an id belonging to another Retailer selects nothing and is refused
 * with the same generic exception as an unauthorized caller.
 *
 * Deliberately NOT feature-gated. Withdrawing an invitation is the safety valve, and a
 * kill switch that can itself be switched off is not one.
 */
export async function revokeStaffInvitationAction(
  _prevState: InvitationActionState,
  formData: FormData,
): Promise<InvitationActionState> {
  const invitationId = readField(formData, "invitationId").trim();

  const access = await getRetailerPortalAccess();
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }
  if (access.status === "unavailable") {
    return { error: GENERIC_REVOKE_ERROR, success: null };
  }

  if (!UUID_PATTERN.test(invitationId)) {
    return { error: GENERIC_REVOKE_ERROR, success: null };
  }

  const result = await revokeRetailerStaffInvitation(invitationId);

  if (result.status === "revoked") {
    revalidatePath(STAFF_PATH);
    return { error: null, success: "Invitation revoked." };
  }

  return { error: GENERIC_REVOKE_ERROR, success: null };
}
