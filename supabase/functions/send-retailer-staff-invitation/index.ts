// Supabase Edge Function: send-retailer-staff-invitation
//
// THE SHARED DELIVERY ENTRY POINT for Retailer staff invitations. One authenticated
// Retailer Owner invites one person as RETAILER_MANAGER or SALES_STAFF; the web portal
// and the Flutter app both reach it here, so there is exactly one implementation of
// "send a staff invitation" in the system.
//
// WHY THIS FUNCTION EXISTS AT ALL
//   Three of the four RPCs in the sequence are granted to `service_role` ALONE
//   (migration 20260724090000 revokes them from anon and authenticated):
//   prepare_retailer_staff_invitation, record_retailer_staff_invitation_sent and
//   record_retailer_staff_invitation_failure. They are keyed by an invitation id plus a
//   token hash and carry the whole decision themselves, so a browser-reachable prepare
//   would let anyone who learned an invitation id rotate its token — and therefore mint
//   a link to somebody else's invitation. A Flutter client cannot be given a key that
//   would let it call them. This function holds that key on the server and exposes one
//   narrow door. It also holds the Resend credential, which no client may ever see.
//
// IT RE-USES THE WEB IMPLEMENTATION RATHER THAN RESTATING IT
//   The request contract, the response vocabulary, the delivery ORDER, the email content
//   and the token/hash construction are all imported from lib/, which is where the
//   Next.js side gets them too. Every one of those modules was written dependency-free
//   (or `node:crypto`-only, which Deno 2 supports) for exactly this. A second Deno
//   implementation of any of them is the drift docs/mobile-backend-contract.md § 4.2
//   warns about — the two clients would define "a valid invitation request", "a rotated
//   token" or "sent" differently the first time one of them was edited.
//   lib/staff/staff-invitation-edge-function-safety.test.ts fails the build if this file
//   starts re-implementing any of it.
//
// WHAT THE CLIENT MAY INFLUENCE, EXHAUSTIVELY
//   firstName, lastName, email, roleCode, shopIds. There is no parameter for a Retailer
//   organization id, an actor / user / profile / membership id, a permission, an
//   invitation id, a token, a token hash, audit data, an invitation state, an
//   expiration, a normalized email, or any Resend setting — and an unknown top-level key
//   is REJECTED rather than ignored, so none can be smuggled in against a later edit.
//
//   THE INVITATION ID COMES ONLY FROM THE RESERVATION. The three service-role RPCs are
//   called with the id reserve_retailer_staff_invitation() returned under the CALLER'S
//   OWN token, and lib/staff/staff-invite-flow.ts is the only thing that passes it.
//
// TWO CLIENTS, TWO KEYS, ONE JOB EACH
//   asCaller  — publishable key + the caller's own access token. Used for the RESERVATION
//               and nothing else. This is what makes auth.uid() the real person, resolves
//               the Retailer in PostgreSQL, enforces RETAILER_STAFF_MANAGE in PostgreSQL,
//               and validates every submitted shop against that Retailer. No organization
//               selector is accepted anywhere in this file.
//   asService — the service-role key. Built only AFTER a successful caller-authorized
//               reservation, and used only for prepare / record-sent / record-failure.
//
// THE RAW TOKEN is generated here, hashed here, and leaves only inside the emailed accept
//   URL. It is never returned, never logged, never persisted, and never placed in a
//   response — the response type has no field it could occupy.
//
// EVERY RESPONSE IS BUILT BY lib/staff/staff-invitation-cors.ts, INCLUDING THE PREFLIGHT
//   AND THE UNEXPECTED-ERROR REPLY. A Flutter Web build is a browser, so a reply this
//   function cannot make readable is a reply the client never sees. There is no
//   `new Response(` in this file, and the `Deno.serve` wrapper at the bottom catches
//   throws so the runtime never emits a header-less 500.
//
// WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
//   No invitation acceptance, no membership or shop-membership write, no post-acceptance
//   shop reassignment, no staff status or role change, no revoke, no invitation table
//   write of any kind, and no rate limiting — there is no rate limiter in this system, so
//   there is no RATE_LIMITED code in the contract.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.6";

import { generateInvitationToken } from "../../../lib/invitations/existing-user-token.ts";
import {
  corsJsonResponse,
  corsPreflightResponse,
} from "../../../lib/staff/staff-invitation-cors.ts";
import {
  isStaffInvitationSendingEnabled,
  MAX_REQUEST_BYTES,
  parseStaffInvitationRequest,
  staffInvitationResponse,
  STAFF_INVITATION_HTTP_STATUS,
  type StaffInvitationCode,
} from "../../../lib/staff/staff-invitation-delivery-contract.ts";
import {
  sendStaffInvitationEmail,
  validateStaffInvitationEmailConfig,
  type StaffInvitationEmailConfig,
} from "../../../lib/staff/staff-invitation-email.ts";
import {
  runStaffInviteFlow,
  type StaffInviteFlowPorts,
  type StaffInvitePrepareResult,
  type StaffInviteRecordResult,
  type StaffInviteReserveResult,
} from "../../../lib/staff/staff-invite-flow.ts";
import { retailerRoleDisplayName } from "../../../lib/staff/staff-roles.ts";

/** The RPCs this function calls, and which privilege level each runs at. */
const RESERVE_RPC = "reserve_retailer_staff_invitation" as const; // caller's own token
const PREPARE_RPC = "prepare_retailer_staff_invitation" as const; // service role
const RECORD_SENT_RPC = "record_retailer_staff_invitation_sent" as const; // service role
const RECORD_FAILURE_RPC = "record_retailer_staff_invitation_failure" as const; // service role

/** SQLSTATEs the staff RPCs raise. Only the CODE is inspected, never a message. */
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const OBJECT_NOT_IN_PREREQUISITE_STATE = "55000";

/**
 * The ONE place this system reads an error MESSAGE, and a narrow one — carried over
 * unchanged from lib/staff/retailer-staff-invitations.ts, where it was introduced.
 *
 * public.reserve_retailer_staff_invitation raises this EXACT literal — defined in
 * migration 20260723210000, in this repository — when a live PENDING invitation exists
 * for the address whose role or shop set differs from what was submitted. Every other
 * refusal it raises has a distinct SQLSTATE, so SQLSTATE alone separates authorization
 * (42501), an inactive Retailer (55000) and bad values (23514); what SQLSTATE cannot do
 * is separate THIS 23514 from the other 23514s.
 *
 * It is our own string, not a provider's; it is COMPARED rather than parsed; it is never
 * forwarded to a client. Matching it only chooses between two of this contract's own
 * codes. If the migration's wording ever changes the match fails and the outcome
 * degrades to INVALID_REQUEST — a safe, generic refusal, never a wrong action — so no
 * security property depends on it. Making the distinction structural instead would mean
 * a migration, which this milestone has no other reason to write.
 */
const ROLE_OR_SHOP_CONFLICT_MESSAGE =
  "Revoke and re-issue this invitation to change its role or shops";

/**
 * Sanitized operator logging, and the only console call in this file. No ids, emails,
 * names, tokens, hashes, URLs, email bodies, provider text, or error objects — identical
 * posture to lib/receipts/receipt-submissions.ts and the staff modules.
 */
function logFailure(category: string): void {
  console.error(`[send-retailer-staff-invitation] ${category}`);
}

/**
 * The ONLY way this function produces a reply.
 *
 * The body and the HTTP status both come from the shared contract, so a code cannot be
 * returned with the wrong status, and no reply can carry a field the contract does not
 * declare. lib/staff/staff-invitation-cors.ts adds the headers.
 */
function respond(code: StaffInvitationCode): Response {
  return corsJsonResponse(
    staffInvitationResponse(code),
    STAFF_INVITATION_HTTP_STATUS[code],
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** One row of reserve_retailer_staff_invitation(). */
type ReservationRow = {
  invitation_id?: unknown;
  normalized_email?: unknown;
  is_resend?: unknown;
};

/** One row of prepare_retailer_staff_invitation(). Extra columns are ignored. */
type PreparationRow = {
  normalized_email?: unknown;
  first_name?: unknown;
  retailer_name?: unknown;
  role_code?: unknown;
};

/**
 * The publishable key.
 *
 * Supabase injects `SUPABASE_ANON_KEY` into every Edge Function. This project is on the
 * NEW API key scheme, whose counterpart is named `SUPABASE_PUBLISHABLE_KEY`, so that is
 * preferred and the legacy name is the fallback. Either is a public value; neither is
 * ever logged or returned. Mirrors submit-receipt.
 */
function readPublishableKey(): string | null {
  return (
    nonEmptyString(Deno.env.get("SUPABASE_PUBLISHABLE_KEY")) ??
    nonEmptyString(Deno.env.get("SUPABASE_ANON_KEY"))
  );
}

/**
 * The request handler proper. It is a named function rather than the argument to
 * `Deno.serve` so the wrapper below can catch everything it throws — see there.
 */
async function handleRequest(request: Request): Promise<Response> {
  // Answered BEFORE authentication, and it must be: a browser sends a preflight with no
  // `Authorization` header, so refusing it would block every cross-origin caller before
  // the real request was ever attempted. It reveals only which methods and headers this
  // endpoint accepts, and is identical for every caller.
  if (request.method === "OPTIONS") {
    return corsPreflightResponse();
  }

  if (request.method !== "POST") {
    return respond("METHOD_NOT_ALLOWED");
  }

  // --------------------------------------------------------------------------
  // 1. Authenticate the caller.
  //
  // The gateway already verifies the JWT (`verify_jwt = true` in supabase/config.toml).
  // This is the second, independent check, and it is the one that matters: getUser()
  // REVALIDATES the token with the Auth server rather than trusting its claims, exactly
  // as lib/supabase/server.ts requires of the web ("use getUser(), not getSession()").
  //
  // Nothing about the deployment's configuration is disclosed before this succeeds.
  // --------------------------------------------------------------------------
  const supabaseUrl = nonEmptyString(Deno.env.get("SUPABASE_URL"));
  const publishableKey = readPublishableKey();

  if (supabaseUrl === null || publishableKey === null) {
    logFailure("platform configuration is incomplete");
    return respond("NOT_CONFIGURED");
  }

  const authorization = request.headers.get("Authorization");
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");

  if (bearer === null) {
    return respond("AUTH_REQUIRED");
  }

  const accessToken = bearer[1];

  // The caller's own client. Every request it makes runs as that user, so auth.uid()
  // means something and the reservation can prove the permission and the Retailer. It
  // holds the PUBLISHABLE key — it is subject to RLS, and it is never given the
  // service-role key.
  const asCaller: SupabaseClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  // The token is passed EXPLICITLY rather than relying on getUser() finding a stored
  // session: `persistSession: false` means this client has no session to find, so the
  // argument-less form would ask the Auth server about nobody.
  const userResult = await asCaller.auth.getUser(accessToken).catch(() => null);

  if (userResult === null || userResult.error || !userResult.data?.user) {
    // A token the gateway accepted but Auth rejects — expired, revoked, or for another
    // project. Not logged: an auth failure names a user.
    return respond("AUTH_REQUIRED");
  }

  // --------------------------------------------------------------------------
  // 2. The rest of the configuration, and the feature gate.
  //
  // Read BEFORE anything is reserved so a deployment gap fails before an invitation row
  // exists, before a token is minted, and before any provider request — and is reported
  // as a configuration problem rather than as a delivery failure against an invitation
  // that now exists and looks half-sent.
  // --------------------------------------------------------------------------
  const serviceRoleKey = nonEmptyString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  const emailConfigResult = validateStaffInvitationEmailConfig({
    apiKey: Deno.env.get("RESEND_API_KEY"),
    from: Deno.env.get("RESEND_FROM"),
    appOrigin: Deno.env.get("APP_ORIGIN"),
  });

  if (serviceRoleKey === null || !emailConfigResult.ok) {
    // Names nothing. An operator reads the deployment's secrets; a caller learns only
    // that the endpoint is not usable right now.
    logFailure("delivery configuration is incomplete");
    return respond("NOT_CONFIGURED");
  }

  const emailConfig: StaffInvitationEmailConfig = emailConfigResult.config;

  // THE FUNCTION ENFORCES THE FLAG ITSELF. The web portal also checks it before
  // rendering and before submitting, but a hidden button is not a security boundary: a
  // hand-crafted POST reaches this line regardless of what any UI decided.
  if (!isStaffInvitationSendingEnabled(Deno.env.get("RETAILER_STAFF_INVITATIONS_ENABLED"))) {
    return respond("FEATURE_DISABLED");
  }

  // --------------------------------------------------------------------------
  // 3. Parse and validate the request. Client-side validation is never trusted, and the
  //    reservation RPC re-applies every rule below and remains the final authority.
  // --------------------------------------------------------------------------
  const rawBody = await request.text().catch(() => null);

  if (rawBody === null) {
    logFailure("could not read the request body");
    return respond("INVALID_REQUEST");
  }

  // A byte bound before JSON.parse, so an oversized document is refused rather than
  // parsed. The blob is not logged and not echoed.
  if (rawBody.length > MAX_REQUEST_BYTES) {
    return respond("INVALID_REQUEST");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    // The parse error quotes the body. It is not bound, returned, or logged.
    return respond("INVALID_REQUEST");
  }

  const parsed = parseStaffInvitationRequest(decoded);

  if (!parsed.ok) {
    return respond(parsed.code);
  }

  // --------------------------------------------------------------------------
  // 4. The service-role client.
  //
  // Constructed only now — after the caller has been authenticated and their request
  // has been proven well-formed — and used only for the three service-only RPCs.
  // Sessions are fully disabled for the same reasons lib/supabase/admin.ts disables
  // them: a client that persisted or refreshed a session could write service-role
  // credentials into shared state or onto a response.
  // --------------------------------------------------------------------------
  const asService: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const ports: StaffInviteFlowPorts = {
    async reserve(reserveInput): Promise<StaffInviteReserveResult> {
      const result = await Promise.resolve(
        asCaller.rpc(RESERVE_RPC, {
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
        logFailure("reserve transport");
        return { status: "unavailable" };
      }

      if (result.error) {
        const error = result.error as { code?: string; message?: string };

        // 42501 covers an unauthenticated caller, a caller without
        // RETAILER_STAFF_MANAGE, and a caller who belongs to no Retailer, with one
        // identical exception. That indistinguishability is deliberate.
        if (error.code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };

        if (error.code === OBJECT_NOT_IN_PREREQUISITE_STATE) {
          return { status: "retailer-inactive" };
        }

        if (error.code === CHECK_VIOLATION) {
          // The one message comparison. See ROLE_OR_SHOP_CONFLICT_MESSAGE above: a
          // failed match degrades to the generic refusal, never to a wrong action.
          return typeof error.message === "string" &&
            error.message.includes(ROLE_OR_SHOP_CONFLICT_MESSAGE)
            ? { status: "conflict" }
            : { status: "invalid" };
        }

        logFailure("reserve rpc-error");
        return { status: "unavailable" };
      }

      const rows = result.data as unknown;
      const row: ReservationRow | undefined = Array.isArray(rows) ? rows[0] : undefined;
      const invitationId = nonEmptyString(row?.invitation_id);
      const normalizedEmail = nonEmptyString(row?.normalized_email);

      if (!row || invitationId === null || normalizedEmail === null) {
        logFailure("reserve returned an unusable result");
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
      // SHA-256 hex digest — the SAME implementation the intake route hashes with, so
      // the value stored and the value the accept route computes cannot diverge. A NEW
      // pair on every call, which is what makes a resend and a post-failure retry
      // rotate the token rather than replay a stale link.
      return generateInvitationToken();
    },

    async prepare({ invitationId, tokenHash }): Promise<StaffInvitePrepareResult> {
      const result = await Promise.resolve(
        asService.rpc(PREPARE_RPC, {
          p_invitation_id: invitationId,
          p_token_hash: tokenHash,
        }),
      ).catch(() => null);

      if (result === null || result.error) {
        logFailure("prepare failed");
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
        logFailure("prepare returned an unusable result");
        return { status: "unavailable" };
      }

      return { status: "ok", normalizedEmail, firstName, retailerName, roleCode };
    },

    async sendEmail(emailInput) {
      // The sender builds the accept URL from the validated origin and the raw token
      // itself. The raw token leaves this process only inside that emailed URL.
      return sendStaffInvitationEmail(emailInput, emailConfig);
    },

    async recordSent({ invitationId, tokenHash }): Promise<StaffInviteRecordResult> {
      const result = await Promise.resolve(
        asService.rpc(RECORD_SENT_RPC, {
          p_invitation_id: invitationId,
          p_expected_token_hash: tokenHash,
        }),
      ).catch(() => null);

      if (result === null || result.error) {
        // NOT retried here. The email is already in flight; a second attempt at the
        // bookkeeping would be safe (the RPC is idempotent for the current token) but a
        // retry loop inside a request is how a slow database becomes a timeout, and the
        // honest answer to the client is that the status is unconfirmed.
        logFailure("could not record send success");
        return { status: "failed" };
      }
      return { status: "ok" };
    },

    async recordFailure({ invitationId, tokenHash }) {
      // Best effort, and correctly so: nothing was delivered, so the invitation is
      // retryable whether or not the failure was written down.
      const result = await Promise.resolve(
        asService.rpc(RECORD_FAILURE_RPC, {
          p_invitation_id: invitationId,
          p_expected_token_hash: tokenHash,
        }),
      ).catch(() => null);
      if (result === null || result.error) {
        logFailure("could not record delivery failure");
      }
    },

    roleDisplayName(roleCode) {
      return retailerRoleDisplayName(roleCode);
    },
  };

  // --------------------------------------------------------------------------
  // 5. reserve -> token -> prepare -> send -> record. The ORDER lives in the shared pure
  //    module, so the mobile and web clients cannot execute a different sequence, and
  //    the code it returns IS the wire code — there is no mapping layer to drift.
  // --------------------------------------------------------------------------
  return respond(await runStaffInviteFlow(parsed.request, ports));
}

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    return await handleRequest(request);
  } catch {
    // THE LAST RESPONSE THAT COULD HAVE ESCAPED THE POLICY. An uncaught throw becomes a
    // runtime-generated 500 carrying no CORS headers, which a browser discards without
    // ever showing the client a status or a body. It is reported as the same opaque
    // INTERNAL_ERROR every other unexpected failure returns, so a caller learns nothing
    // new from a crash.
    //
    // The error is not bound, echoed, or logged: it can quote a request body, an accept
    // URL — and therefore a raw token — or a provider message.
    logFailure("unexpected error");
    return respond("INTERNAL_ERROR");
  }
});
