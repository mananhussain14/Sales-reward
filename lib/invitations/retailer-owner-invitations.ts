// SERVER-ONLY MODULE.
//
// This module orchestrates the two-phase Retailer Owner invitation across two
// systems that share no transaction: PostgreSQL and Supabase Auth (GoTrue).
//
// It transitively imports @/lib/supabase/admin, which throws on module evaluation
// if it ever reaches a browser, and @/lib/supabase/server, which imports
// `next/headers` and fails the build in a Client Component. Either guard alone
// would be sufficient; both apply.
//
// THE SEQUENCE, AND WHY IT IS THIS ORDER
//
//   1. reserve_retailer_owner_invitation()   [caller's own token, RLS-governed]
//        Authorizes the Vendor, verifies the relationship, canonicalizes the
//        email, requires both names, refuses duplicates and existing owners, and
//        writes ONE pending row.
//   2. auth.admin.inviteUserByEmail()        [service-role key]
//        Mints the Auth user and sends the invitation email.
//   3. finalize_retailer_owner_invitation()  [service-role key]
//        Creates the profile from the STORED names, creates the membership as
//        INVITED, assigns RETAILER_OWNER, links the invitation, records delivery,
//        and audits — atomically.
//
// The database row is written FIRST because a database row with no email sent is
// recoverable and invisible, whereas an email sent with no database row is
// unrecoverable and confusing. Steps 1 and 3 are both idempotent, so any failure
// in the seam is repaired by re-running the whole operation rather than by hand.
//
// NOTE ON WHAT THIS DOES *NOT* DO
//   It does not accept or activate anything. Finalization leaves the membership
//   INVITED; it becomes ACTIVE only when the invitee sets a password and the
//   acceptance RPC runs under their own session. No password value passes through
//   this module, and none is ever sent to PostgreSQL.
//
// WHAT NEVER CROSSES THE BOUNDARY BACK TO THE BROWSER
//   No invitation id, no Auth user id, no profile id, no organization id, no
//   membership id, no token, no confirmation URL, and no raw Auth or PostgREST
//   error. The result union below carries a status and nothing else. The
//   invitation id returned by step 1 is used to address step 3 and is then
//   discarded within this function's scope — it is never returned, never logged,
//   and never placed in a URL.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient, SupabaseAdminConfigurationError } from "@/lib/supabase/admin";
import type { RetailerOwnerFailureCode } from "@/lib/retailers/owner-status-normalization";

/**
 * The path GoTrue sends the invitee to after they click the emailed link.
 *
 * A module constant rather than a parameter: a caller-supplied destination is an
 * open-redirect vector, and this value ends up inside an email that this
 * application cannot recall once sent.
 */
const ACCEPT_PATH = "/invitations/accept";

/**
 * The environment variable naming this application's own public origin.
 *
 * Read from configuration and NEVER from a request header. `Host`,
 * `X-Forwarded-Host`, and `Origin` are all attacker-controllable on an ordinary
 * request; deriving the invitation link from one of them would let a caller
 * redirect the emailed link to a host they control, turning a legitimate
 * invitation into a credential-harvesting page carrying a real Supabase token.
 *
 * The value must additionally be registered in Supabase Auth's redirect allow-list
 * (`additional_redirect_urls` locally, the Dashboard's URL Configuration when
 * hosted), or GoTrue refuses the redirect — a second, independent check that this
 * module cannot bypass even if this variable were somehow wrong.
 */
const APP_ORIGIN_VAR = "APP_ORIGIN";

/**
 * PostgreSQL SQLSTATEs raised by reserve_retailer_owner_invitation().
 *
 * Matched on CODE, never on message text: the codes are a stable documented
 * contract, whereas a message is one refactor away from surfacing raw SQL. Nothing
 * from the error object is ever rendered — these only select which of THIS
 * codebase's own strings the caller shows.
 */
const SQLSTATE = {
  /** Not authorized, or an unknown/foreign/malformed relationship. Indistinguishable by design. */
  INSUFFICIENT_PRIVILEGE: "42501",
  /** The Retailer or the relationship is not ACTIVE. */
  NOT_IN_PREREQUISITE_STATE: "55000",
  /** The Retailer already has an owner. */
  UNIQUE_VIOLATION: "23505",
  /** A name or email failed the database's own validation. */
  CHECK_VIOLATION: "23514",
} as const;

/**
 * The outcome of an invitation attempt.
 *
 * A closed union of plain statuses. Deliberately carries no ids, no email, no
 * error object, and no message from Auth or PostgREST — the Server Action maps
 * these to its own user-facing strings, exactly as the existing Retailer actions
 * map RPC failures to their own constants.
 */
export type InviteRetailerOwnerResult =
  /** Reserved, dispatched, and finalized. */
  | { status: "sent" }
  /** Same, but against an invitation that was already live. */
  | { status: "resent" }
  /**
   * The address already has a Supabase Auth account. NOT an error and NOT a
   * security failure — a capability gap, reported honestly. See the note below.
   */
  | { status: "already-registered" }
  /**
   * Refused by the database's authorization or addressing checks: not authorized,
   * or an unknown, foreign, or malformed relationship. These are deliberately NOT
   * distinguished, because the RPC itself refuses all of them with one
   * byte-identical exception specifically so it cannot be used as an existence
   * oracle. Re-separating them in TypeScript would reintroduce exactly the
   * disclosure the database went out of its way to prevent.
   */
  | { status: "refused" }
  /**
   * The Retailer or the relationship is not ACTIVE. Safe to distinguish: this is
   * reachable only AFTER ownership has been proven, so the admin already manages
   * this Retailer and can already see both statuses on its detail page.
   */
  | { status: "inactive" }
  /** The Retailer already has an owner. Safe to distinguish, for the same reason. */
  | { status: "existing-owner" }
  /** A name or email was rejected by the database's own validation. */
  | { status: "invalid" }
  /** The service-role key or APP_ORIGIN is missing or malformed. */
  | { status: "misconfigured" }
  /** Anything else: a transport failure, an Auth outage, a finalization failure. */
  | { status: "unavailable" };

/** One row of public.reserve_retailer_owner_invitation(). */
type ReservationRow = {
  invitation_id: string;
  normalized_email: string;
  is_resend: boolean;
};

/**
 * Resolves and validates this application's own origin.
 *
 * Rejects anything that is not an absolute http(s) URL. Plain `http` is permitted
 * only for loopback development hosts: an invitation link is a bearer credential
 * in transit, and shipping one over cleartext to a real host would expose it to
 * anyone on the path.
 */
function resolveAppOrigin(): string {
  const configured = process.env.APP_ORIGIN;

  if (typeof configured !== "string" || configured.trim().length === 0) {
    throw new SupabaseAdminConfigurationError(
      `Missing ${APP_ORIGIN_VAR}. Set it to this application's own origin (for example http://127.0.0.1:3000) and restart the dev server.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(configured.trim());
  } catch {
    // The configured value is deliberately not echoed: it is operator input and
    // this message may be surfaced in a server log.
    throw new SupabaseAdminConfigurationError(
      `${APP_ORIGIN_VAR} is set but is not a valid absolute URL.`,
    );
  }

  const isLoopback =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]";

  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new SupabaseAdminConfigurationError(
      `${APP_ORIGIN_VAR} must use https, except for loopback development hosts.`,
    );
  }

  // `origin` discards any path, query, or fragment the operator may have included,
  // so the redirect target below is always built from a clean scheme+host+port.
  return parsed.origin;
}

/** Maps a reservation SQLSTATE to a safe result. Nothing from the error is rendered. */
function mapReservationFailure(code: string | undefined): InviteRetailerOwnerResult {
  switch (code) {
    case SQLSTATE.UNIQUE_VIOLATION:
      return { status: "existing-owner" };
    case SQLSTATE.NOT_IN_PREREQUISITE_STATE:
      return { status: "inactive" };
    case SQLSTATE.CHECK_VIOLATION:
      return { status: "invalid" };
    case SQLSTATE.INSUFFICIENT_PRIVILEGE:
      return { status: "refused" };
    default:
      // An unrecognized code, or a transport failure with no code at all. Treated
      // as an outage rather than a refusal: claiming "not authorized" for what may
      // be a network blip would send an admin chasing a permissions problem that
      // does not exist.
      return { status: "unavailable" };
  }
}

/**
 * Persists a safe delivery-failure classification for one invitation, best-effort.
 *
 * SERVER-ROLE, SERVER-DERIVED ONLY. The invitation id is the one the trusted
 * reservation RPC returned in this same call — never a browser value. The code is
 * one of the three fixed, display-safe strings; NO provider error, HTTP status,
 * SMTP response, Resend id, or thrown value is passed. The RPC is granted to
 * service_role only, so this runs on the admin client.
 *
 * BEST-EFFORT, AND DELIBERATELY SO. If the recording itself fails (transport or a
 * reported error), the user-facing result of the surrounding operation is NOT
 * changed: the delivery failure already happened, and the classification is an
 * annotation on it, not the outcome. Only a static category is logged — never the
 * error object, which could name tables, policies, or carry the service-role key.
 *
 * OBSERVABILITY LIMITATION: when recording fails, the invitation keeps whatever
 * classification it already had (for a fresh failure, that is null). The owner-
 * status UI then treats it as the historical/unclassified DELIVERY_FAILED — a
 * retryable "Invitation not sent" — rather than the specific reason. That is the
 * safe fallback: it never blocks a genuinely retryable case, and a subsequent
 * attempt records a current classification.
 */
async function recordInvitationFailure(
  admin: ReturnType<typeof createAdminClient>,
  invitationId: string,
  code: RetailerOwnerFailureCode,
): Promise<void> {
  const result = await Promise.resolve(
    admin.rpc("record_retailer_owner_invitation_failure", {
      p_invitation_id: invitationId,
      p_failure_code: code,
    }),
  ).catch(() => null);

  if (result === null || result.error) {
    // Static category only. No error object, no email, no id.
    console.error(
      `inviteRetailerOwner: could not record failure classification (${code})`,
    );
  }
}

/**
 * Invites the first Retailer Owner for one Vendor-managed Retailer.
 *
 * @param relationshipId The vendor_retailers row id. An ADDRESS, not
 *   authorization: it says WHICH of the caller's own Retailers, and the RPC
 *   re-verifies it against the Vendor it derives from auth.uid(). An id belonging
 *   to another Vendor selects nothing there.
 * @param email Raw admin input. Canonicalized by the database, and the canonical
 *   form returned by the reservation is what is sent to Auth.
 * @param firstName Required. Stored on the invitation and written verbatim to the
 *   invitee's profile at finalization — never derived, never defaulted.
 * @param lastName Required, same treatment.
 */
export async function inviteRetailerOwner(
  relationshipId: string,
  email: string,
  firstName: string,
  lastName: string,
): Promise<InviteRetailerOwnerResult> {
  // ---------------------------------------------------------------------------
  // 0. Configuration, before anything is written anywhere
  // ---------------------------------------------------------------------------
  // Resolved first so a misconfigured deployment fails BEFORE reserving an
  // invitation it could never dispatch. Reserving and then discovering there is no
  // key would leave a pending row blocking a retry for 24 hours.
  let appOrigin: string;
  let admin: ReturnType<typeof createAdminClient>;
  try {
    appOrigin = resolveAppOrigin();
    admin = createAdminClient();
  } catch (error) {
    if (error instanceof SupabaseAdminConfigurationError) {
      // Static log. Names the failure kind and nothing else — no variable value,
      // no key, no email, no relationship id.
      console.error("inviteRetailerOwner: invitation configuration is incomplete");
      return { status: "misconfigured" };
    }
    console.error("inviteRetailerOwner: invitation setup failed");
    return { status: "unavailable" };
  }

  // ---------------------------------------------------------------------------
  // 1. Reserve — under the CALLER'S own token, never the service-role key
  // ---------------------------------------------------------------------------
  // This is the step that authorizes the whole operation, and it deliberately
  // runs as the signed-in Vendor admin. Using the admin client here would remove
  // auth.uid() from the RPC entirely, so its context and permission checks would
  // fail closed — and if they somehow did not, this module rather than the
  // database would become the thing standing between one Vendor and another.
  //
  // Promise.resolve() because the PostgREST builder is a thenable, not a real
  // Promise: it implements `then` and has no `.catch()` of its own. Adopting it
  // gives a genuine Promise to attach the rejection handler to, matching the shape
  // used by lib/auth/vendor-admin-access.ts and the two Retailer actions.
  const supabase = await createClient();

  const reservation = await Promise.resolve(
    supabase.rpc("reserve_retailer_owner_invitation", {
      p_relationship_id: relationshipId,
      p_email: email,
      p_first_name: firstName,
      p_last_name: lastName,
    }),
  ).catch(() => null);

  if (reservation === null || reservation.error || !reservation.data) {
    // ONLY the SQLSTATE is inspected, and only to choose between this codebase's
    // own messages. The error's message, details, and hint are never bound,
    // rendered, or logged: they name tables, columns, functions, and policies, and
    // this request body contains the invitee's name and email address.
    console.error("inviteRetailerOwner: reservation was refused");
    return mapReservationFailure(reservation?.error?.code);
  }

  // rpc() is untyped — this project has no generated database types — so the shape
  // is asserted rather than inferred. This is a claim about the SQL, not a check
  // of it, which is why the guard below verifies rather than assumes.
  const rows = reservation.data as ReservationRow[];
  const reserved = rows[0];

  if (
    !reserved ||
    typeof reserved.invitation_id !== "string" ||
    typeof reserved.normalized_email !== "string"
  ) {
    console.error("inviteRetailerOwner: reservation returned an unusable result");
    return { status: "unavailable" };
  }

  // ---------------------------------------------------------------------------
  // 2. Dispatch — the ONE service-role call in this codebase
  // ---------------------------------------------------------------------------
  // The CANONICAL email from the database is sent, not the raw admin input. If
  // Auth minted a user under a different casing than the invitation recorded,
  // finalize()'s email equality check would correctly refuse it and the
  // invitation would be undeliverable for reasons nobody could see.
  //
  // NO user metadata is supplied. supabase/templates/invite.html interpolates only
  // {{ .SiteURL }} and {{ .TokenHash }}, so there is nothing the template needs —
  // and user_metadata is attacker-visible in the invitee's own JWT and writable by
  // them after sign-in, which makes it the wrong home for the invitee's name or
  // anything else this flow depends on. The names live in the invitation row,
  // which only trusted server code can read.
  //
  // redirectTo is built from configuration only. No request header contributes to
  // it, and no caller-supplied `next`/`redirectTo` value is read anywhere in this
  // module — an emailed redirect target is not somewhere a user-controlled string
  // may appear.
  let invitedUserId: string;
  try {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(
      reserved.normalized_email,
      { redirectTo: `${appOrigin}${ACCEPT_PATH}` },
    );

    if (error) {
      // THE EXISTING-USER CASE, and the one place this module inspects an Auth
      // error.
      //
      // GoTrue refuses to invite an address that already has an Auth account.
      // That is a capability gap in the current development flow, and it is
      // reported honestly rather than worked around.
      //
      // Why no workaround is attempted: resolving an existing user's id would
      // require either admin.listUsers() paginated across the entire user table
      // (which does not scale and races with concurrent signups) or
      // admin.generateLink({ type: 'magiclink' }), which returns a link this
      // application would then have to deliver itself — and no SMTP is configured,
      // so it could not. Both also change the semantics of the email the invitee
      // receives. Fabricating either would trade a clear, contained limitation for
      // a subtle one.
      //
      // Matched on the error CODE where GoTrue provides one, with a narrow status
      // fallback. Never on message text, which is one upgrade away from changing.
      // Neither the code nor the message is returned to the caller or logged.
      const code = (error as { code?: string }).code;
      const status = (error as { status?: number }).status;

      if (code === "email_exists" || code === "user_already_exists" || status === 422) {
        // The reserved invitation is left PENDING deliberately. It expires on its
        // own in 24 hours, and until then it is the record that this Vendor
        // attempted to invite this person — which a Vendor admin will want when
        // they ask why nothing arrived. It also blocks a pointless retry loop.
        //
        // Classified EXISTING_ACCOUNT so the UI can stop offering a futile Retry.
        // The `already-registered` result is deliberately unchanged — this is not
        // silently converted into a retryable outcome.
        console.error("inviteRetailerOwner: address already has an account; invitation deferred");
        await recordInvitationFailure(admin, reserved.invitation_id, "EXISTING_ACCOUNT");
        return { status: "already-registered" };
      }

      // Any other reported dispatch error: the handoff failed before completing and
      // may be retryable. Classified AUTH_DISPATCH_FAILED; the safe result is
      // unchanged.
      console.error("inviteRetailerOwner: auth dispatch failed");
      await recordInvitationFailure(admin, reserved.invitation_id, "AUTH_DISPATCH_FAILED");
      return { status: "unavailable" };
    }

    const userId = data?.user?.id;

    if (typeof userId !== "string" || userId.length === 0) {
      // Dispatch returned no usable user: treat as a dispatch failure, retryable.
      console.error("inviteRetailerOwner: auth dispatch returned no user");
      await recordInvitationFailure(admin, reserved.invitation_id, "AUTH_DISPATCH_FAILED");
      return { status: "unavailable" };
    }

    invitedUserId = userId;
  } catch {
    // The thrown value is deliberately not bound, inspected, or logged. A
    // transport-level exception from the Auth client can carry request headers —
    // which on THIS client include the service-role key. Classified as a dispatch
    // failure using ONLY the id and the fixed code — the thrown value never travels
    // to the recorder.
    console.error("inviteRetailerOwner: auth dispatch threw");
    await recordInvitationFailure(admin, reserved.invitation_id, "AUTH_DISPATCH_FAILED");
    return { status: "unavailable" };
  }

  // ---------------------------------------------------------------------------
  // 3. Finalize — service-role, because there is no invitee session yet
  // ---------------------------------------------------------------------------
  // The Auth user now exists but has never signed in, so there is no auth.uid()
  // for a normal RPC to resolve. finalize_retailer_owner_invitation() is granted
  // to service_role only, and this is its sole caller.
  //
  // Both ids passed here were produced by the two steps above, never by a browser.
  // The RPC nonetheless re-validates both: the invitation must be live and belong
  // to a still-active relationship, and the Auth user's email must equal the
  // invitation's canonical email.
  //
  // The profile it creates uses the names stored on the invitation row — the ones
  // the Vendor admin typed. Nothing is derived here or there.
  const finalization = await Promise.resolve(
    admin.rpc("finalize_retailer_owner_invitation", {
      p_invitation_id: reserved.invitation_id,
      p_auth_user_id: invitedUserId,
    }),
  ).catch(() => null);

  if (finalization === null || finalization.error) {
    // The Auth user and the email now exist while the database provisioning does
    // not. This is the one genuinely partial state the design admits, and it is
    // recoverable rather than corrupt: the invitation is still PENDING with no
    // sent_at, so re-running this whole function resolves the same reservation
    // (is_resend = true) and retries finalization. Nothing is left half-granted —
    // the RPC is one transaction, so it either provisioned everything or nothing.
    //
    // Classified FINALIZATION_FAILED — distinct from a dispatch failure because an
    // Auth user was already created, so a naive retry would now meet that account.
    // The UI therefore does NOT offer a re-send for this state. No compensation or
    // Auth-user deletion is performed in this milestone.
    console.error("inviteRetailerOwner: finalization failed after dispatch");
    await recordInvitationFailure(admin, reserved.invitation_id, "FINALIZATION_FAILED");
    return { status: "unavailable" };
  }

  // Reaching here means all three steps committed: the invitation is PENDING with
  // a recorded dispatch, the profile and INVITED membership exist, the
  // RETAILER_OWNER role is assigned, and the audit record was written in the same
  // transaction as the rows it describes. The membership is NOT yet active — that
  // happens when the invitee sets their password and acceptance runs.
  return reserved.is_resend === true ? { status: "resent" } : { status: "sent" };
}
