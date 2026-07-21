"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import {
  isRetailerOwnerInvitationsEnabled,
  RETAILER_OWNER_INVITATIONS_PAUSED_MESSAGE,
} from "@/lib/features/retailer-owner-invitations";
import { inviteRetailerOwner } from "@/lib/invitations/retailer-owner-invitations";
import { getVendorRetailerOwnerStatus } from "@/lib/retailers/vendor-retailer-owner-status";
import {
  planInvitationSubmit,
  resolveOwnerInvitedCode,
} from "@/lib/retailers/owner-status-normalization";
import type {
  InviteOwnerState,
  InviteOwnerValues,
} from "@/app/(admin)/retailers/[relationshipId]/owner/invite/invite-owner-state";

/**
 * Server Action backing the Invite Retailer Owner form.
 *
 * The work itself is NOT performed here. This action validates, authorizes, and
 * then delegates to lib/invitations/retailer-owner-invitations.ts, which runs the
 * three-step sequence: reserve in PostgreSQL under the caller's own token,
 * dispatch through the Supabase Auth Admin API, finalize in PostgreSQL. There is
 * deliberately no table write and no service-role client in this module.
 *
 * ONE identifier is sent, and it is an ADDRESS rather than authorization.
 * `relationshipId` says WHICH of the caller's own Retailers to invite an owner
 * for. It does not say who the caller is, which Vendor they act for, or which
 * Retailer organization is written — the RPC derives all three itself, from
 * auth.uid(), and re-verifies the relationship against the Vendor it derived. A
 * relationship id belonging to another Vendor selects nothing there. Nothing else
 * about the tenant or the actor is sent: the RPC's signature has no Vendor
 * organization id, Retailer organization id, actor/profile id, role id, membership
 * id, Auth user id, or status parameter.
 *
 * Because of the "use server" directive, `inviteRetailerOwnerAction` must be this
 * module's only runtime export — every export here is exposed as a callable server
 * endpoint, so Next.js rejects anything that is not an async function. The state
 * types live in ./invite-owner-state; `import type` above is erased at compile
 * time and adds no export.
 */

/**
 * The single message used for every failure that is not a field problem.
 *
 * This ONE message covers: a malformed relationship id, a nonexistent one, one
 * belonging to another Vendor, one the caller may not read, a missing permission,
 * and a database or Auth outage. Collapsing them is deliberate — the RPC already
 * refuses all of the addressing cases with a single byte-identical exception so it
 * cannot be used as an existence oracle, and distinguishing them here would
 * reintroduce exactly the disclosure the database went out of its way to prevent.
 */
const GENERIC_INVITE_ERROR =
  "We couldn't send the invitation. Please check the details and try again.";

/**
 * Shown when the Retailer or the relationship is not ACTIVE.
 *
 * Safe to name specifically: this outcome is reachable only AFTER the database has
 * proven the caller manages this Retailer, so the admin can already see both
 * statuses on its detail page. Nothing is disclosed that they did not already have,
 * and telling them the real reason is what lets them act on it.
 */
const INACTIVE_RETAILER_ERROR =
  "This Retailer is not active, so an owner cannot be invited right now.";

/** Shown when the environment is missing its invitation configuration. */
const CONFIGURATION_ERROR =
  "Invitations are not configured on this environment yet. Please contact support.";

/**
 * Shown when the address already has a Supabase Auth account.
 *
 * The wording is the approved one. It describes a limitation of the CURRENT
 * development flow rather than making a claim about the address — which matters,
 * because saying "this person already has an account" to a Vendor admin would
 * confirm the existence of an account they may have no relationship with. It
 * exposes no Auth error code, status, or message.
 */
const ALREADY_REGISTERED_ERROR =
  "This address cannot be invited through the current development invitation flow.";

/** Shown when the Retailer already has an owner. */
const EXISTING_OWNER_ERROR = "This Retailer already has an owner.";

/**
 * Shown when the current owner status is DELIVERY_FAILED classified EXISTING_ACCOUNT.
 * The address already has an Auth account and the current new-user flow cannot
 * invite it, so no dispatch is attempted. Same approved wording as the field-level
 * already-registered message; exposes no Auth code, status, or account existence
 * beyond the address the Vendor already submitted.
 */
const EXISTING_ACCOUNT_ERROR =
  "This address cannot be invited through the current development invitation flow.";

/**
 * Shown when the current owner status is DELIVERY_FAILED classified
 * FINALIZATION_FAILED. Auth setup may have partly completed, so re-sending the
 * email invitation is not offered for this state.
 */
const FINALIZATION_INCOMPLETE_ERROR =
  "The account setup did not finish. Retrying the email invitation is not available for this state.";

/**
 * Shown when the owner status changed between the page rendering and this submit,
 * or could not be re-read. Deliberately generic and actionable: it tells the admin
 * to refresh and retry without describing which transition occurred or leaking any
 * internal state.
 */
const STATE_CHANGED_ERROR =
  "The owner status changed. Refresh the page and try again.";

/**
 * Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. The
 * same shape lib/retailers/vendor-retailer-detail.ts and the Add Shop action
 * screen with.
 *
 * Validating before the call keeps a malformed value out of the request entirely.
 * It is also what makes the redirect and revalidate targets below safe: an
 * unvalidated segment interpolated into a path is a path-injection vector.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pragmatic email shape check, byte-identical to the rule in app/login/actions.ts
 * and to retailer_invitations_email_shape in the migration: something, an @,
 * something, a dot, something, with no whitespace. A typo guard, not an RFC 5322
 * implementation — the database re-validates and the Auth server remains the real
 * authority on whether an address can receive mail.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Defensive bound: the maximum length of an email address per RFC 5321. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Reads one FormData entry as a trimmed string.
 *
 * FormData entries are `string | File`; a File here means a malformed or
 * hand-crafted request, and is treated as absent rather than coerced — the
 * "[object File]" a naive String() would produce is not something to store.
 */
function readTrimmed(
  formData: FormData,
  // The three form fields, plus the one hidden routing field. Typed as a union
  // rather than `string` so a typo in a field name is a compile error instead of a
  // silently empty value that would read as "the admin left it blank".
  field: "firstName" | "lastName" | "email" | "relationshipId",
): string {
  const raw = formData.get(field);
  return typeof raw === "string" ? raw.trim() : "";
}

export async function inviteRetailerOwnerAction(
  _prevState: InviteOwnerState,
  formData: FormData,
): Promise<InviteOwnerState> {
  // ---------------------------------------------------------------------------
  // 1. Read and canonicalize
  // ---------------------------------------------------------------------------
  // Every text input is trimmed. The email is additionally lower-cased, so the
  // value validated here, the value sent onward, and the value echoed back into
  // the form are all the same canonical string — an admin who typed "Owner@X.com"
  // sees "owner@x.com" rather than having a valid input silently stored under a
  // different key than they saw. This matches the database's own
  // retailer_invitations_email_canonical constraint exactly.
  //
  // The NAMES are trimmed but never case-folded: a person's name is theirs, and
  // "de Silva" is not "De Silva". Nothing is truncated anywhere.
  const values: InviteOwnerValues = {
    firstName: readTrimmed(formData, "firstName"),
    lastName: readTrimmed(formData, "lastName"),
    email: readTrimmed(formData, "email").toLowerCase(),
  };

  // The one identifier the browser supplies. Read here but deliberately NOT placed
  // in `values` — it is a routing address, not a form field to echo back, and the
  // form already holds it as a prop.
  const relationshipId = readTrimmed(formData, "relationshipId");

  // ---------------------------------------------------------------------------
  // 2. Feature gate — BEFORE anything else touches PostgreSQL or Auth
  // ---------------------------------------------------------------------------
  // Retailer Owner invitations are paused until custom SMTP and the TokenHash
  // invite template are in place and the end-to-end invite-link test passes. See
  // lib/features/retailer-owner-invitations.ts for the full condition.
  //
  // THIS CHECK IS THE ENFORCEMENT BOUNDARY, not the disabled button on the form.
  // A Server Action is a public endpoint: it is reachable by a hand-crafted POST
  // from any client, regardless of what the page rendered or whether it rendered
  // at all. Hiding the control removes the accident; only this line removes the
  // capability.
  //
  // Placed FIRST, ahead of validation and authorization, deliberately. Everything
  // below it — the access lookup, the reservation RPC, the Auth Admin client, and
  // inviteUserByEmail() — is unreachable on the disabled path, so the paused
  // state makes exactly ZERO database queries and ZERO Auth calls rather than
  // merely zero mutations. There is no ordering here in which a gate placed later
  // would be safer, and one placed later would be one more thing to re-verify
  // every time this action grows a step.
  //
  // The submitted values ride back so a returning admin does not lose their work
  // when the feature is switched on. Nothing else is disclosed: no variable name,
  // no configuration detail, no field errors that would reveal the form still
  // validates.
  if (!isRetailerOwnerInvitationsEnabled()) {
    return {
      fieldErrors: {},
      formError: RETAILER_OWNER_INVITATIONS_PAUSED_MESSAGE,
      values,
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Name validation (email is validated later, once the mode is known)
  // ---------------------------------------------------------------------------
  // The names are required in every mode — a first invite, a resend, a retry, and
  // an expiry replacement all need them, and a resend/retry is exactly where an
  // admin may CORRECT a mistyped name (the reservation RPC overwrites them). The
  // email is deliberately NOT validated here: whether the submitted value even
  // matters depends on the authoritative owner state resolved in section 5, so its
  // check lives there.
  //
  // No maximum length is imposed on the names. public.profiles puts none on
  // first_name or last_name — only non-empty checks — and inventing a ceiling here
  // would reject input the database accepts.
  const fieldErrors: InviteOwnerState["fieldErrors"] = {};

  if (values.firstName.length === 0) {
    fieldErrors.firstName = "Enter the owner's first name.";
  }

  if (values.lastName.length === 0) {
    fieldErrors.lastName = "Enter the owner's last name.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    // The submitted values ride back so the admin does not retype the fields that
    // were fine.
    return { fieldErrors, formError: null, values };
  }

  // ---------------------------------------------------------------------------
  // 4. Authorization
  // ---------------------------------------------------------------------------
  // A Server Action is a public endpoint. It is reachable directly, by any caller,
  // regardless of which page rendered the form or whether that page guarded
  // itself — so the check is repeated here rather than assumed from the route. The
  // decision is delegated in full to the shared function, never re-implemented, so
  // this action and the (admin) layout cannot disagree.
  //
  // This is defense in depth, not the enforcement boundary. The RPC evaluates the
  // same chain again from auth.uid(), then requires RETAILER_OWNERS_INVITE, then
  // re-verifies that the relationship belongs to the Vendor it derived, and only
  // then checks that both the relationship and the Retailer are ACTIVE. Those
  // checks — inside the database, under the caller's own token — are what actually
  // stop an unauthorized or cross-tenant invitation.
  const access = await getVendorSuperAdminAccess();

  // Both redirects sit outside every try/catch in this module: redirect() signals
  // by throwing NEXT_REDIRECT, and catching it would swallow the navigation.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  // `access` is used for nothing else. Its organizationId is deliberately NOT read
  // and NOT sent: the RPC resolves the Vendor itself, from the caller's own
  // verified token, and accepts no organization parameter at all.

  // A malformed relationship id returns the SAME generic message as a nonexistent,
  // foreign, or inaccessible one. The browser must not be able to tell these apart.
  // A malformed id can only mean a tampered form, so there is no legitimate
  // submission this costs.
  if (!UUID_PATTERN.test(relationshipId)) {
    return { fieldErrors: {}, formError: GENERIC_INVITE_ERROR, values };
  }

  // ---------------------------------------------------------------------------
  // 5. Re-resolve the owner status IMMEDIATELY before dispatch
  // ---------------------------------------------------------------------------
  // The page that rendered this form may be stale: the invitation could have been
  // accepted, expired, revoked, or replaced by another admin since it loaded. The
  // authoritative state is re-read here, under the caller's own token, and it — not
  // any hidden form field — decides what happens next. This is what makes the
  // recipient un-tamperable and the concurrency window safe.
  const statusResult = await getVendorRetailerOwnerStatus(relationshipId);

  if (statusResult.status === "unavailable") {
    // Could not confirm the current state, so we refuse to dispatch blindly. Fail
    // closed with the actionable, generic message.
    return { fieldErrors: {}, formError: STATE_CHANGED_ERROR, values };
  }

  const currentState = statusResult.ownerStatus.state;
  const plan = planInvitationSubmit(
    currentState,
    statusResult.ownerStatus.failureCode,
    statusResult.ownerStatus.email,
  );

  if (plan.kind === "blocked-active") {
    // The Retailer gained an active owner while the form was open.
    return { fieldErrors: {}, formError: EXISTING_OWNER_ERROR, values };
  }

  if (plan.kind === "blocked-existing-account") {
    // The address already has an Auth account (classified EXISTING_ACCOUNT). No
    // dispatch is attempted; the safe approved message explains the limitation.
    return { fieldErrors: {}, formError: EXISTING_ACCOUNT_ERROR, values };
  }

  if (plan.kind === "blocked-finalization") {
    // Auth setup may have partly completed (classified FINALIZATION_FAILED). A
    // re-send is not offered, so no inviteUserByEmail is attempted here.
    return { fieldErrors: {}, formError: FINALIZATION_INCOMPLETE_ERROR, values };
  }

  if (plan.kind === "state-unavailable") {
    // A resend/retry state whose recipient email is somehow missing: fail closed
    // rather than guess a recipient.
    return { fieldErrors: {}, formError: STATE_CHANGED_ERROR, values };
  }

  // The email actually dispatched. For a resend/retry it is the RPC's OWN value,
  // never the submitted one — a browser cannot substitute a different address. For
  // a new/replacement invite it is the admin's submitted email, which is validated
  // here (the one place a submitted email is trusted).
  let dispatchEmail: string;

  if (plan.kind === "resend") {
    dispatchEmail = plan.email;
  } else {
    // plan.kind === "new" (NONE or EXPIRED): validate the submitted email.
    if (values.email.length === 0) {
      return {
        fieldErrors: { email: "Enter the owner's email address." },
        formError: null,
        values,
      };
    }
    if (values.email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(values.email)) {
      return {
        fieldErrors: { email: "Enter a valid email address." },
        formError: null,
        values,
      };
    }
    dispatchEmail = values.email;
  }

  // ---------------------------------------------------------------------------
  // 6. Delegate
  // ---------------------------------------------------------------------------
  // The service returns a closed union of plain statuses — no ids, no email, no
  // error object, no Auth code, no SQLSTATE. Everything below maps those statuses
  // to this codebase's own strings; nothing from Supabase or PostgreSQL is
  // rendered. The reservation RPC is the FINAL authority: it independently blocks
  // an active owner and a different-email pending, so even if the state changed
  // again between section 5 and here, a wrong action cannot commit.
  const result = await inviteRetailerOwner(
    relationshipId,
    dispatchEmail,
    values.firstName,
    values.lastName,
  );

  switch (result.status) {
    case "sent":
    case "resent":
      break;

    case "already-registered":
      // A field error rather than a form error: the address is the thing the admin
      // must change, and attaching the message to the input tells them so.
      return {
        fieldErrors: { email: ALREADY_REGISTERED_ERROR },
        formError: null,
        values,
      };

    case "existing-owner":
      return {
        fieldErrors: { email: EXISTING_OWNER_ERROR },
        formError: null,
        values,
      };

    case "inactive":
      return { fieldErrors: {}, formError: INACTIVE_RETAILER_ERROR, values };

    case "misconfigured":
      return { fieldErrors: {}, formError: CONFIGURATION_ERROR, values };

    case "invalid":
      // The database rejected a name or email that passed the checks above. Not
      // reachable through the form as written, so it is reported against the email
      // field with the generic input message rather than inventing a new one.
      return {
        fieldErrors: { email: "Enter a valid email address." },
        formError: null,
        values,
      };

    case "refused":
    case "unavailable":
    default:
      // A refused authorization, an unowned or nonexistent relationship, and a
      // database or Auth outage alike. Their causes differ, and none of that may
      // reach a browser — the RPC's authorization raises are byte-identical for
      // exactly this reason, and this collapses the rest to match.
      //
      // Nothing is logged here: the service already emitted a static diagnostic
      // for whichever step failed, and repeating it with the submitted values in
      // scope would be an opportunity to leak them.
      return { fieldErrors: {}, formError: GENERIC_INVITE_ERROR, values };
  }

  // ---------------------------------------------------------------------------
  // 7. Success
  // ---------------------------------------------------------------------------
  // The invitation is reserved, dispatched, and finalized: the profile and INVITED
  // membership exist, RETAILER_OWNER is assigned, and the audit record was written
  // in the same transaction as the rows it describes. The membership is NOT active
  // — that happens when the invitee sets their password.

  // The detail page now has an owner invitation to reflect. Deliberately not
  // revalidatePath("/", "layout"), which is reserved for session transitions where
  // the whole authenticated shell must be dropped. Revalidating before the
  // redirect is what makes the banner and the changed state visible on arrival.
  //
  // `relationshipId` is the value validated above, so these paths cannot be
  // poisoned by the submitted string.
  revalidatePath("/retailers");
  revalidatePath(`/retailers/${relationshipId}`);

  // The success flag is a short code from a FIXED vocabulary — `sent`, `resent`, or
  // `new` — chosen from the state observed just before dispatch, never from free
  // text or a submitted value. The detail page maps it back through
  // resolveOwnerInvitedMessage(), which renders only known codes, so nothing
  // arbitrary can be shown. No id, email, or database value travels in the URL.
  const successCode = resolveOwnerInvitedCode(currentState);

  // The destination is built only from the validated relationship id and the fixed
  // code. No redirectTo/next form field or search parameter is read anywhere in
  // this module — a caller-supplied redirect target is an open-redirect vector.
  //
  // Outside any try/catch, and nothing follows it: redirect() throws NEXT_REDIRECT,
  // so no success state is returned or could be. Swallowing that throw would turn a
  // sent invitation into a spurious failure message — and prompt a resend.
  redirect(`/retailers/${relationshipId}?ownerInvited=${successCode}`);
}
