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
import { getRetailerStaffMembers } from "@/lib/staff/retailer-staff-data";
import { setRetailerStaffShopAssignments } from "@/lib/staff/retailer-staff-shop-assignments";
import { setRetailerStaffMembershipStatus } from "@/lib/staff/retailer-staff-membership-status";
import {
  describeLifecycleNoChange,
  describeLifecycleOutcome,
  normalizeLifecycleMembershipId,
  normalizeRequestedStatus,
  validateStaffLifecycleInput,
  type StaffLifecycleRosterEntry,
} from "@/lib/staff/staff-lifecycle-input";
import {
  normalizeStaffInviteInput,
  validateStaffInviteInput,
} from "@/lib/staff/staff-invite-input";
import {
  describeSaveOutcome,
  normalizeMembershipId,
  normalizeShopSelection,
  validateShopAssignmentInput,
} from "@/lib/staff/staff-shop-assignment-input";
import { canResendInvitation } from "@/lib/staff/staff-normalization";
import {
  EMPTY_INVITE_STAFF_VALUES,
  type InviteStaffState,
} from "@/app/(retailer)/retailer/staff/invite-staff-state";
import type { InvitationActionState } from "@/app/(retailer)/retailer/staff/invitation-action-state";
import type { ManageShopsState } from "@/app/(retailer)/retailer/staff/manage-shops-state";
import type { StaffLifecycleState } from "@/app/(retailer)/retailer/staff/staff-lifecycle-state";

/**
 * Server Actions for the Retailer staff-management page.
 *
 * NO TABLE IS WRITTEN HERE, AND NO SERVICE-ROLE CLIENT IS CONSTRUCTED HERE. Every
 * effect is delegated to @/lib/staff/retailer-staff-invitations: revoke is one RPC under
 * the caller's own token, and SENDING now goes to the shared
 * `send-retailer-staff-invitation` Edge Function, which the Flutter app calls too, so
 * the reserve → prepare → send → record sequence exists in exactly one place for both
 * clients. `.from(` appears nowhere in this module.
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

/**
 * Shown for the PARTIAL SUCCESS: the email provider accepted the message — so the
 * accept link is live and may already be in the recipient's inbox — but the write that
 * records the send could not be confirmed.
 *
 * It is a SUCCESS message, not an error, and the wording is chosen to stop exactly one
 * reaction: sending again straight away. A resend rotates the token and would kill the
 * link that was just delivered. So it says the invitation went out, and points at the
 * list below rather than at the button above.
 */
const DELIVERY_UNCONFIRMED_MESSAGE =
  "The invitation email was accepted for delivery, but we couldn't confirm the invitation's latest status. Check the invitation list below — there is no need to send it again unless it is missing.";

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
  // `paused` joins the two that did not: the Edge Function refused before reserving.
  if (
    result.status !== "rejected" &&
    result.status !== "unavailable" &&
    result.status !== "paused"
  ) {
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
    case "sent-unconfirmed":
      // Treated as a success — because it is one — and the form is cleared like any
      // other send. Leaving the values in place would present a filled, ready-to-submit
      // form next to a message about uncertainty, which is an invitation to resend.
      return {
        fieldErrors: {},
        formError: null,
        successMessage: DELIVERY_UNCONFIRMED_MESSAGE,
        values: EMPTY_INVITE_STAFF_VALUES,
      };
    case "paused":
      return {
        fieldErrors: {},
        formError: RETAILER_STAFF_INVITATIONS_PAUSED_MESSAGE,
        successMessage: null,
        values,
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

  if (
    result.status !== "rejected" &&
    result.status !== "unavailable" &&
    result.status !== "paused"
  ) {
    revalidatePath(STAFF_PATH);
  }

  switch (result.status) {
    case "sent":
    case "resent":
      return { error: null, success: `Invitation re-sent to ${invitation.email}.` };
    case "sent-unconfirmed":
      return { error: null, success: DELIVERY_UNCONFIRMED_MESSAGE };
    case "paused":
      return { error: RETAILER_STAFF_INVITATIONS_PAUSED_MESSAGE, success: null };
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

/* ---------------------------------------------------------------------------
 * Manage Shops — post-acceptance shop assignment for existing Sales Staff
 * ------------------------------------------------------------------------- */

/**
 * The one message for every refusal that is about ACCESS or the TARGET.
 *
 * It covers a signed-out caller, a Manager, a Sales Staff member, an unknown membership
 * id, another Retailer's staff member, a suspended or deactivated membership, and a
 * target who is not Sales Staff. Collapsing them is deliberate and mirrors the database:
 * set_retailer_staff_shop_assignments raises ONE byte-identical 42501 for all of them
 * precisely so a caller cannot sweep membership ids to learn which exist somewhere else.
 * Distinguishing them here would reintroduce exactly the disclosure SQL went out of its
 * way to prevent.
 */
const SHOP_ASSIGNMENT_DENIED =
  "You can't update this person's shops. Refresh the page and try again.";

/** Shown when the selection itself is the problem — the operator can fix this one. */
const SHOP_ASSIGNMENT_EMPTY =
  "Select at least one shop. Sales Staff must be assigned to a shop.";

/**
 * Shown when a shop is no longer valid. Names no shop and no id: an unknown shop and
 * another Retailer's shop are indistinguishable in SQL, and must stay so here.
 */
const SHOP_ASSIGNMENT_INVALID =
  "Some of the selected shops are no longer available. Review the shops and try again.";

/** 55000 — the Retailer stopped being active mid-operation. Distinct, and retryable. */
const SHOP_ASSIGNMENT_RETAILER_UNAVAILABLE =
  "Your Retailer is not available right now, so shops could not be updated. Try again in a moment.";

/** The generic service failure. Deliberately NOT "check your connection". */
const SHOP_ASSIGNMENT_UNAVAILABLE =
  "We couldn't update those shop assignments. Please try again in a moment.";

/**
 * THE PARTIAL SUCCESS: the write committed, but the roster could not be re-read (or the
 * response did not carry the counts).
 *
 * It is a SUCCESS message and the wording is chosen to stop exactly one reaction —
 * saving again. Nothing is lost by not retrying: the change is committed, and the RPC is
 * idempotent anyway, so a retry would be a no-op that writes no audit row. The editor
 * disables Save on this outcome for the same reason.
 */
const SHOP_ASSIGNMENT_SAVED_UNCONFIRMED =
  "Shop assignments were updated, but the latest staff details could not be refreshed. Refresh the page to see them.";

/**
 * Shown when a selected shop vanished from the assignable set between the page render
 * and the submission. NOTHING was sent to the database on this path.
 */
const SHOP_ASSIGNMENT_STALE =
  "Shop availability changed while you were editing. Review the shops below, then save.";

/**
 * Replaces an existing Sales Staff member's ACTIVE shop assignments.
 *
 * A SERVER ACTION IS A PUBLIC ENDPOINT — reachable by a hand-crafted POST from any
 * client, regardless of which page rendered the control or whether that page rendered at
 * all. So this re-establishes its own footing exactly as the invite and revoke actions
 * do: portal access is re-resolved from the verified session, and the assignable shop set
 * is re-read from the database for THIS caller before a single id is accepted.
 *
 * WHAT THE BROWSER MAY INFLUENCE, EXHAUSTIVELY: one membership id, and a set of shop ids
 * that must each appear in the list list_retailer_staff_assignable_shops() just returned.
 * Nothing else is read from the form — no Retailer organization id, caller id, actor
 * profile id, role code, permission code, current-assignment list, audit actor, status or
 * timestamp — and no such field would be honoured if one were posted, because none is
 * read. The RPC accepts only two arguments in any case.
 *
 * THE MEMBERSHIP ID IS AN ADDRESS, NOT AUTHORIZATION. The RPC derives the Retailer from
 * auth.uid() and matches the target on `id AND organization_id AND status = 'ACTIVE'`
 * plus an exact SALES_STAFF role, so an id from another tenant selects nothing and is
 * refused with the same generic exception as an unauthorized caller.
 *
 * ⚠️ THE REPLACEMENT IS SCOPED TO THE ACTIVE-SHOP PROJECTION. The submitted set is the
 * complete desired set of the shops the operator can SEE. A live assignment to a
 * suspended or deactivated shop is invisible in list_retailer_staff_members(), is
 * PRESERVED by the RPC, and is in none of the returned counts. This action therefore
 * never claims that the submitted set is the member's whole assignment set, and the
 * canonical roster re-read below — not the submitted ids — is what the page displays.
 */
export async function updateStaffShopAssignmentsAction(
  _prevState: ManageShopsState,
  formData: FormData,
): Promise<ManageShopsState> {
  // 1. Read and canonicalize. ONLY these two fields are read; any other key a tampered
  //    POST carried is never looked at, so it cannot influence anything.
  //    `getAll` because the shop selection is a checkbox group.
  const membershipId = normalizeMembershipId(formData.get("membershipId"));
  const shopIds = normalizeShopSelection(formData.getAll("shopIds"));

  // 2. Authorization, re-resolved from the verified session. Defence in depth: the RPC
  //    evaluates the same chain again from auth.uid() and is what actually stops an
  //    unauthorized or cross-tenant write.
  //
  //    Deliberately NOT feature-gated. RETAILER_STAFF_INVITATIONS_ENABLED gates
  //    INVITATIONS — creating accounts and sending email. Correcting an existing
  //    employee's shops is neither, and coupling it to the invitation kill switch would
  //    strand an Owner who needs to move someone between shops while sending is paused.
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
      outcome: "error",
      error: SHOP_ASSIGNMENT_UNAVAILABLE,
      success: null,
      refreshedShops: null,
    };
  }

  // 3. The assignable shop set, re-read from the database for THIS caller.
  //
  //    Both the source of truth for validation and a second authorization gate:
  //    list_retailer_staff_assignable_shops() is granted only to holders of
  //    RETAILER_STAFF_SHOP_ASSIGN, so a Manager — or anyone else — lands on `denied` here
  //    and can never get a shop id accepted. The browser never supplies this set.
  const assignable = await getRetailerStaffAssignableShops();

  if (assignable.status === "denied") {
    return {
      outcome: "error",
      error: SHOP_ASSIGNMENT_DENIED,
      success: null,
      refreshedShops: null,
    };
  }
  if (assignable.status === "unavailable") {
    // A READ failure. Reported as a service problem rather than as a rejected write,
    // because nothing about the submission was wrong and nothing was attempted.
    return {
      outcome: "error",
      error: SHOP_ASSIGNMENT_UNAVAILABLE,
      success: null,
      refreshedShops: null,
    };
  }

  const allowedShopIds = assignable.shops.map((shop) => shop.shopId);

  // 4. Validate, including the subset check against the ids just read.
  const validation = validateShopAssignmentInput(
    membershipId,
    shopIds,
    allowedShopIds,
  );

  if (!validation.ok) {
    switch (validation.reason) {
      case "empty":
        return {
          outcome: "error",
          error: SHOP_ASSIGNMENT_EMPTY,
          success: null,
          refreshedShops: null,
        };
      case "unavailable-shop":
        // A selected shop is no longer assignable — most often because it was
        // deactivated while the editor was open. NOTHING is submitted; the fresh options
        // ride back so the operator can review, and the editor re-renders its picker
        // from them rather than from the list it opened with.
        return {
          outcome: "stale-shops",
          error: SHOP_ASSIGNMENT_STALE,
          success: null,
          refreshedShops: assignable.shops,
        };
      case "too-many":
        return {
          outcome: "error",
          error: SHOP_ASSIGNMENT_INVALID,
          success: null,
          refreshedShops: null,
        };
      case "invalid-target":
      default:
        // Reachable only from a tampered submission: the control carries a membership id
        // the page read from the roster. Reported exactly like an unauthorized or
        // cross-tenant target, so the two cannot be told apart.
        return {
          outcome: "error",
          error: SHOP_ASSIGNMENT_DENIED,
          success: null,
          refreshedShops: null,
        };
    }
  }

  // 5. The write. Exactly one RPC, exactly two arguments, under the caller's own token.
  const result = await setRetailerStaffShopAssignments(
    validation.membershipId,
    validation.shopIds,
  );

  switch (result.status) {
    case "denied":
      return {
        outcome: "error",
        error: SHOP_ASSIGNMENT_DENIED,
        success: null,
        refreshedShops: null,
      };
    case "invalid":
      return {
        outcome: "error",
        error: SHOP_ASSIGNMENT_INVALID,
        success: null,
        refreshedShops: null,
      };
    case "retailer-unavailable":
      return {
        outcome: "error",
        error: SHOP_ASSIGNMENT_RETAILER_UNAVAILABLE,
        success: null,
        refreshedShops: null,
      };
    case "malformed":
      // 22P02. Only a tampered submission reaches this, since step 4 already required
      // canonical UUIDs; reported as a denial so it is indistinguishable from one.
      return {
        outcome: "error",
        error: SHOP_ASSIGNMENT_DENIED,
        success: null,
        refreshedShops: null,
      };
    case "unavailable":
      return {
        outcome: "error",
        error: SHOP_ASSIGNMENT_UNAVAILABLE,
        success: null,
        refreshedShops: null,
      };
    case "saved-unconfirmed":
      // Committed, but undescribable. The page is still revalidated — the data DID
      // change — and the operator is told plainly not to save again.
      revalidatePath(STAFF_PATH);
      return {
        outcome: "saved-unconfirmed",
        error: null,
        success: SHOP_ASSIGNMENT_SAVED_UNCONFIRMED,
        refreshedShops: null,
      };
    case "saved":
    default:
      break;
  }

  // 6. Committed. Revalidate, then RE-READ THE CANONICAL ROSTER.
  //
  //    The re-read is the display authority. The page must never be updated from the ids
  //    that were just submitted: those describe the visible ACTIVE set only, and the
  //    database — which alone can see the preserved non-ACTIVE assignments — is the only
  //    honest source for what this member is now assigned to.
  revalidatePath(STAFF_PATH);

  const refreshed = await getRetailerStaffMembers();

  if (refreshed.status !== "ok") {
    // THE WRITE STILL SUCCEEDED. A failed re-read is never presented as a failed write,
    // and never leaves Save enabled in a state where an ordinary retry would resubmit a
    // change that is already committed.
    return {
      outcome: "saved-unconfirmed",
      error: null,
      success: SHOP_ASSIGNMENT_SAVED_UNCONFIRMED,
      refreshedShops: null,
    };
  }

  return {
    outcome: "saved",
    error: null,
    // Describes the CHANGE only. describeSaveOutcome never emits a total, because the
    // counts cannot see the preserved non-ACTIVE assignments.
    success: describeSaveOutcome({
      added: result.added,
      removed: result.removed,
      unchanged: result.unchanged,
    }),
    refreshedShops: null,
  };
}

/* ---------------------------------------------------------------------------
 * Staff activation / deactivation
 * ------------------------------------------------------------------------- */

/**
 * The one message every disclosure-sensitive refusal shares.
 *
 * An unknown membership, another Retailer's membership, a RETAILER_OWNER target, the
 * caller's own membership, a multi-role or role-less target, and an INVITED or SUSPENDED
 * membership are ALL reported with this single string.
 * set_retailer_staff_membership_status raises ONE byte-identical 42501 for all of them
 * precisely so a caller cannot sweep membership ids to learn which exist somewhere else.
 * Distinguishing them here would reintroduce exactly the disclosure SQL went out of its way
 * to prevent.
 */
const LIFECYCLE_DENIED =
  "You can't change this person's status. Refresh the page and try again.";

/**
 * 23514 — the requested status was not one this operation accepts. Reachable only from a
 * tampered submission, since the control posts a value this application produced.
 */
const LIFECYCLE_INVALID =
  "That status change isn't valid. Refresh the page and try again.";

/** 55000 — the Retailer stopped being active mid-operation. Distinct, and retryable. */
const LIFECYCLE_RETAILER_UNAVAILABLE =
  "Your Retailer is not available right now, so the status could not be changed. Try again in a moment.";

/**
 * The generic service failure. Deliberately NOT "check your connection", and deliberately
 * explicit that nothing was changed — an operator who does not know whether a write landed
 * will click again, which is exactly what this wording prevents.
 */
const LIFECYCLE_UNAVAILABLE =
  "We couldn't change that status, and nothing was changed. Please try again in a moment.";

/**
 * THE PARTIAL SUCCESS: the write committed, but the response could not be described or the
 * roster could not be re-read.
 *
 * It is a SUCCESS message and the wording is chosen to stop exactly one reaction —
 * submitting again. Nothing is lost by not retrying: the change is committed, and the RPC
 * is idempotent anyway, so a repeat would be a no-op that writes no audit row. The dialog
 * hides its confirm button on this outcome for the same reason.
 */
const LIFECYCLE_SAVED_UNCONFIRMED =
  "The status change may have been saved, but the staff list could not be refreshed. Refresh the page to see the current status.";

/**
 * Deactivates or reactivates one Retailer staff membership.
 *
 * A SERVER ACTION IS A PUBLIC ENDPOINT — reachable by a hand-crafted POST from any client,
 * regardless of which page rendered the control or whether that page rendered at all. So
 * this re-establishes its own footing exactly as the invite, revoke and shop-assignment
 * actions do: portal access is re-resolved from the verified session, the caller's
 * MANAGEMENT capability is re-proved against the database, and the canonical roster is
 * re-read for THIS caller before a single id is accepted.
 *
 * WHAT THE BROWSER MAY INFLUENCE, EXHAUSTIVELY: one membership id that must appear in the
 * roster public.list_retailer_staff_members() just returned, and one requested status that
 * must be exactly ACTIVE or DEACTIVATED. Nothing else is read from the form — no Retailer
 * organization id, caller id, actor profile id, role code, permission code, current status,
 * audit actor or timestamp — and no such field would be honoured if one were posted,
 * because none is read. The RPC accepts only two arguments in any case.
 *
 * THE MEMBERSHIP ID IS AN ADDRESS, NOT AUTHORIZATION. The RPC derives the Retailer from
 * auth.uid() and matches the target on `id AND organization_id`, then re-reads its complete
 * ACTIVE role set and its current status, so an id from another tenant selects nothing and
 * is refused with the same generic exception as an unauthorized caller.
 *
 * NOTHING IS DESTROYED. The RPC changes organization_members.status and deactivated_at and
 * nothing else — roles, live and retired shop assignments, receipts, invitations and audit
 * history are all preserved, which is why the copy promises exactly that and why
 * reactivation needs no rebuild.
 */
export async function setStaffMembershipStatusAction(
  _prevState: StaffLifecycleState,
  formData: FormData,
): Promise<StaffLifecycleState> {
  // 1. Read and canonicalize. ONLY these two fields are read; any other key a tampered POST
  //    carried is never looked at, so it cannot influence anything.
  const membershipId = normalizeLifecycleMembershipId(formData.get("membershipId"));
  const requestedStatus = normalizeRequestedStatus(formData.get("requestedStatus"));

  // 2. Authorization, re-resolved from the verified session. Defence in depth: the RPC
  //    evaluates the same chain again from auth.uid() and is what actually stops an
  //    unauthorized or cross-tenant write.
  //
  //    Deliberately NOT feature-gated. RETAILER_STAFF_INVITATIONS_ENABLED gates INVITATIONS
  //    — creating accounts and sending email. Standing an existing employee down is
  //    neither, and coupling it to the invitation kill switch would strand an Owner who
  //    needs to revoke someone's access while sending is paused. That is the one case where
  //    speed matters most.
  const access = await getRetailerPortalAccess();

  // redirect() signals by throwing NEXT_REDIRECT, so both calls sit outside any try/catch.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }
  if (access.status === "unavailable") {
    return { outcome: "error", error: LIFECYCLE_UNAVAILABLE, success: null };
  }

  // 3. The canonical roster AND the management-capability probe, read together.
  //
  //    THE ROSTER IS NOT A CAPABILITY CHECK. list_retailer_staff_members() requires only
  //    RETAILER_STAFF_READ, which a RETAILER_MANAGER holds — so a Manager would pass it.
  //    list_retailer_staff_invitations() is gated on RETAILER_STAFF_MANAGE, the exact
  //    permission this write RPC requires, so it is the probe that proves the caller may
  //    manage staff at all. A Manager lands on `denied` here and can never get a membership
  //    id accepted, which is the same shape the shop-assignment action uses with
  //    list_retailer_staff_assignable_shops().
  //
  //    Issued in parallel because neither depends on the other.
  const [roster, manageCapability] = await Promise.all([
    getRetailerStaffMembers(),
    getRetailerStaffInvitations(),
  ]);

  if (manageCapability.status === "denied") {
    return { outcome: "error", error: LIFECYCLE_DENIED, success: null };
  }
  if (manageCapability.status === "unavailable") {
    // A READ failure. Reported as a service problem rather than as a rejected write,
    // because nothing about the submission was wrong and nothing was attempted.
    return { outcome: "error", error: LIFECYCLE_UNAVAILABLE, success: null };
  }

  if (roster.status === "denied") {
    return { outcome: "error", error: LIFECYCLE_DENIED, success: null };
  }
  if (roster.status !== "ok") {
    return { outcome: "error", error: LIFECYCLE_UNAVAILABLE, success: null };
  }

  const rosterEntries: StaffLifecycleRosterEntry[] = roster.members.map(
    (member) => ({
      membershipId: member.membershipId,
      roleCode: member.roleCode,
      membershipStatus: member.membershipStatus,
    }),
  );

  // 4. Validate: format first, then existence in the caller's OWN roster, then eligibility.
  //
  //    Every rejection below maps to the SAME message an unauthorized caller receives.
  //    `invalid-status` is the one exception, because a malformed status is the caller's
  //    own input rather than a fact about somebody else's row, and telling them apart
  //    discloses nothing.
  const validation = validateStaffLifecycleInput(
    membershipId,
    requestedStatus,
    rosterEntries,
  );

  if (!validation.ok) {
    return {
      outcome: "error",
      error:
        validation.reason === "invalid-status"
          ? LIFECYCLE_INVALID
          : LIFECYCLE_DENIED,
      success: null,
    };
  }

  // The display name comes from the roster row the server just read — never from the
  // browser — so the confirmation copy names the person the database actually addressed.
  const targetMember = roster.members.find(
    (member) => member.membershipId === validation.membershipId,
  );
  const memberName = targetMember
    ? `${targetMember.firstName} ${targetMember.lastName}`.trim()
    : "This staff member";

  // 5. The write. EXACTLY ONE RPC call, exactly two arguments, under the caller's own
  //    token. There is no retry loop anywhere below this line.
  const result = await setRetailerStaffMembershipStatus(
    validation.membershipId,
    validation.requestedStatus,
  );

  switch (result.status) {
    case "denied":
      return { outcome: "error", error: LIFECYCLE_DENIED, success: null };
    case "invalid":
      return { outcome: "error", error: LIFECYCLE_INVALID, success: null };
    case "retailer-unavailable":
      return {
        outcome: "error",
        error: LIFECYCLE_RETAILER_UNAVAILABLE,
        success: null,
      };
    case "malformed":
      // 22P02. Only a tampered submission reaches this, since step 4 already required a
      // canonical UUID; reported as a denial so it is indistinguishable from one.
      return { outcome: "error", error: LIFECYCLE_DENIED, success: null };
    case "unavailable":
      return { outcome: "error", error: LIFECYCLE_UNAVAILABLE, success: null };
    case "saved-unconfirmed":
      // Committed, but undescribable. The page is still revalidated — the data MAY have
      // changed — and the operator is told plainly to refresh rather than to try again.
      revalidatePath(STAFF_PATH);
      return {
        outcome: "saved-unconfirmed",
        error: null,
        success: LIFECYCLE_SAVED_UNCONFIRMED,
      };
    case "changed":
    case "unchanged":
    default:
      break;
  }

  // 6. Committed. Revalidate, then RE-READ THE CANONICAL ROSTER.
  //
  //    revalidatePath alone is what refreshes the rendered page; the re-read below is a
  //    CONFIRMATION that the canonical source now answers, so a roster that has become
  //    unreadable is reported as "refresh to see the current status" rather than as a
  //    confident success the page cannot actually show.
  revalidatePath(STAFF_PATH);

  const refreshed = await getRetailerStaffMembers();

  if (refreshed.status !== "ok") {
    // THE WRITE STILL SUCCEEDED. A failed re-read is never presented as a failed write, and
    // never leaves the control in a state where an ordinary retry would resubmit a change
    // that is already committed.
    return {
      outcome: "saved-unconfirmed",
      error: null,
      success: LIFECYCLE_SAVED_UNCONFIRMED,
    };
  }

  // The CONFIRMED status is the one the database reported, never the one that was
  // requested. They agree in practice; using the database's answer means the sentence
  // describes what is true rather than what was asked for.
  if (result.status === "unchanged") {
    return {
      outcome: "unchanged",
      error: null,
      success: describeLifecycleNoChange(memberName, result.membershipStatus),
    };
  }

  return {
    outcome: "changed",
    error: null,
    success: describeLifecycleOutcome(memberName, result.membershipStatus),
  };
}
