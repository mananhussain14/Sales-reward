// Supabase Edge Function: submit-receipt
//
// THE MOBILE ENTRY POINT FOR SS-02. One authenticated Sales Staff member submits one
// receipt image for one shop they are actively assigned to.
//
// WHY THIS FUNCTION EXISTS AT ALL
//   The `receipts` bucket is private and `storage.objects` has RLS enabled with ZERO
//   policies, so only a service-role client can write an object. Two of the three RPCs in
//   the sequence — finalize and record-failure — are granted to `service_role` alone,
//   deliberately: a browser-reachable finalize would let anyone who learned a submission
//   id mark a receipt complete without ever uploading a file. A Flutter client therefore
//   cannot complete a submission on its own, and must not be given a key that would let
//   it. This function holds that key on the server and exposes one narrow door.
//
//   This is Option A of docs/mobile-backend-contract.md § 4.4. Option B (a signed upload
//   URL) was rejected because it moves MIME sniffing to the client, where it is not
//   trustworthy. A `storage.objects` INSERT policy was rejected because it would be the
//   first write policy in the entire schema and would make orphan cleanup impossible.
//
// IT RE-USES THE WEB IMPLEMENTATION RATHER THAN RESTATING IT
//   `validateReceiptFile` and `runReceiptSubmissionFlow` are imported from lib/receipts/,
//   which is where the Next.js Server Action gets them too. Both modules were written
//   dependency-free for exactly this: receipt-submission-flow.ts has no imports at all,
//   and receipt-file.ts imports only `node:crypto`, which Deno 2 supports. A second Deno
//   implementation of magic-byte sniffing, SHA-256 and filename sanitization is precisely
//   the drift docs/mobile-backend-contract.md § 4.2 warns about — the two clients would
//   define "a valid receipt" differently the first time one of them was edited.
//   lib/receipts/receipt-edge-function-safety.test.ts fails the build if this file starts
//   re-implementing any of it.
//
// WHAT THE CLIENT MAY INFLUENCE, EXHAUSTIVELY
//   One shop id, and one file. There is no parameter for a Retailer organization id, a
//   profile id, a membership id, a role id, a storage bucket, an object path, a file hash,
//   or a status. The hash is computed here from the bytes, the bucket and path are
//   generated in SQL from ids the database derived, and the status is set by the database.
//
// THE DECLARED CONTENT TYPE IS NEVER TRUSTED. The multipart part's own `type` is not read.
//   The accepted MIME type is derived from the file's leading bytes, and that derived value
//   is what is hashed, uploaded, and recorded.
//
// WHAT NEVER LEAVES THIS FUNCTION. The storage bucket, the object path, the file hash, the
//   service-role key and the publishable key are consumed here and appear in no response
//   body, no header, and no log line. Provider errors are never bound, echoed, or logged.
//
// WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
//   No OCR, no receipt parsing, no product or SKU matching, no reviewer queue, no approval
//   or rejection, no incentive, campaign, reward, coin or payout logic, and no receipt
//   image retrieval — there is still no signed-URL path anywhere in this system.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.6";

import { validateReceiptFile } from "../../../lib/receipts/receipt-file.ts";
import {
  runReceiptSubmissionFlow,
  type ReceiptReserveResult,
  type ReceiptSubmissionPorts,
} from "../../../lib/receipts/receipt-submission-flow.ts";

/** The RPCs this function calls, and which privilege level each runs at. */
const RESERVE_RPC = "reserve_receipt_submission" as const; // caller's own token
const FINALIZE_RPC = "finalize_receipt_submission_upload" as const; // service role
const RECORD_FAILURE_RPC = "record_receipt_submission_upload_failure" as const; // service role

/** SQLSTATEs the receipt RPCs raise. Only the CODE is inspected, never a message. */
const INSUFFICIENT_PRIVILEGE = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/** The multipart field names, fixed literals. */
const SHOP_ID_FIELD = "shop_id";
const FILE_FIELD = "file";

/**
 * CORS. Safe to allow any origin here because this endpoint carries NO ambient authority:
 * it authenticates from an `Authorization: Bearer` header that a cross-site request cannot
 * cause a browser to attach, and it reads no cookie. A Flutter mobile client never sends a
 * preflight; this exists so a Flutter Web build is not blocked by one.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Sanitized operator logging. No ids, paths, hashes, buckets, tokens, or error objects —
 * identical posture to `logSubmissionFailure` in lib/receipts/receipt-submissions.ts.
 */
function logFailure(category: string): void {
  console.error(`[submit-receipt] ${category}`);
}

/** The closed response vocabulary. Nothing else is ever returned. */
type ResponseStatus =
  | "submitted"
  | "invalid"
  | "unauthenticated"
  | "denied"
  | "duplicate"
  | "upload-failed"
  | "unavailable";

function json(
  status: ResponseStatus,
  httpStatus: number,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ status, ...extra }), {
    status: httpStatus,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

/**
 * The 8-4-4-4-12 hexadecimal shape of a uuid.
 *
 * Checked here only so a malformed id produces a clean `invalid` rather than a PostgREST
 * cast error (SQLSTATE 22P02) that the flow would report as `unavailable`. It is NOT an
 * authorization check: whether the shop is ACTIVE, belongs to the caller's Retailer, and is
 * actively assigned to this person is decided by `reserve_receipt_submission`, under the
 * caller's own token, and by nothing here.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One row of reserve_receipt_submission(). */
type ReservationRow = {
  submission_id?: unknown;
  storage_bucket?: unknown;
  storage_object_path?: unknown;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The publishable key.
 *
 * Supabase injects `SUPABASE_ANON_KEY` into every Edge Function. This project is on the
 * NEW API key scheme, whose counterpart is named `SUPABASE_PUBLISHABLE_KEY`, so that is
 * preferred and the legacy name is the fallback. Either is a public value; neither is ever
 * logged or returned.
 */
function readPublishableKey(): string | null {
  return (
    nonEmptyString(Deno.env.get("SUPABASE_PUBLISHABLE_KEY")) ??
    nonEmptyString(Deno.env.get("SUPABASE_ANON_KEY"))
  );
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return json("invalid", 405);
  }

  // --------------------------------------------------------------------------
  // 1. Configuration. Read FIRST so a deployment gap fails before anything is
  //    reserved, and is reported as `unavailable` rather than as an auth error.
  // --------------------------------------------------------------------------
  const supabaseUrl = nonEmptyString(Deno.env.get("SUPABASE_URL"));
  const publishableKey = readPublishableKey();
  const serviceRoleKey = nonEmptyString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  if (supabaseUrl === null || publishableKey === null || serviceRoleKey === null) {
    // Names nothing. An operator reads the deployment's secrets; a caller learns only
    // that the endpoint is not usable right now.
    logFailure("configuration is incomplete");
    return json("unavailable", 503);
  }

  // --------------------------------------------------------------------------
  // 2. Authentication.
  //
  // The gateway already verifies the JWT (`verify_jwt = true` in supabase/config.toml).
  // This is the second, independent check, and it is the one that matters: getUser()
  // REVALIDATES the token with the Auth server rather than trusting its claims, exactly as
  // lib/supabase/server.ts requires of the web ("use getUser(), not getSession()").
  // --------------------------------------------------------------------------
  const authorization = request.headers.get("Authorization");
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");

  if (bearer === null) {
    return json("unauthenticated", 401);
  }

  const accessToken = bearer[1];

  // The caller's own client. Every request it makes runs as that user, so auth.uid() means
  // something and `reserve` can prove the shop assignment. It holds the PUBLISHABLE key —
  // it is subject to RLS, and it is never given the service-role key.
  const asCaller: SupabaseClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  // The token is passed EXPLICITLY rather than relying on `getUser()` finding a stored
  // session. `persistSession: false` means this client has no session to find, so the
  // argument-less form would ask the Auth server about nobody. This is also the shape
  // Supabase documents for Edge Functions.
  //
  // getUser() REVALIDATES with the Auth server; it does not merely decode the token. That
  // is what makes a revoked or expired session fail here, and it is the same rule
  // lib/supabase/server.ts states for the web ("use getUser(), not getSession()").
  const userResult = await asCaller.auth.getUser(accessToken).catch(() => null);

  if (userResult === null || userResult.error || !userResult.data?.user) {
    // A token that the gateway accepted but Auth rejects — expired, revoked, or for
    // another project. Not logged: an auth failure names a user.
    return json("unauthenticated", 401);
  }

  // --------------------------------------------------------------------------
  // 3. The request body.
  // --------------------------------------------------------------------------
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Not multipart, malformed, or larger than the runtime accepts. The parse error can
    // quote the body, so it is not bound or logged.
    return json("invalid", 400, { reason: "malformed-body" });
  }

  const shopId = nonEmptyString(form.get(SHOP_ID_FIELD));

  if (shopId === null || !UUID_SHAPE.test(shopId)) {
    return json("invalid", 400, { reason: "invalid-shop" });
  }

  // getAll, not get: a multipart body can carry several parts under one field name, and
  // silently keeping the first would store something other than what the person believed
  // they submitted. validateReceiptFile refuses a count above one.
  const parts = form.getAll(FILE_FIELD);
  const first = parts[0];
  const file = first instanceof File ? first : null;

  let bytes: Uint8Array | null = null;
  if (file !== null) {
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      logFailure("could not read the uploaded part");
      return json("invalid", 400, { reason: "missing" });
    }
  }

  // Magic-byte sniffing, size limits, SHA-256 and filename sanitization — the SAME
  // implementation the web Server Action uses. `file.type` is deliberately not passed:
  // the declared content type is attacker-controlled and is never read.
  const validated = validateReceiptFile({
    fileName: file?.name,
    bytes,
    fileCount: parts.length,
  });

  if (!validated.ok) {
    // The rejection reason is a fixed vocabulary from lib/receipts/receipt-file.ts
    // ("empty", "too-large", "unsupported-type", …) and describes only the caller's own
    // file, so returning it discloses nothing about anyone else's data.
    return json("invalid", 400, { reason: validated.reason });
  }

  const receipt = validated.file;

  // Unreachable: validateReceiptFile returns `missing` for absent bytes, so `ok` implies
  // they are present. Stated as a guard rather than an assertion so the bytes uploaded
  // below are a `const` the type checker has proven non-null, with no `!` anywhere.
  if (bytes === null) {
    return json("invalid", 400, { reason: "missing" });
  }
  const fileBytes: Uint8Array = bytes;

  // --------------------------------------------------------------------------
  // 4. The service-role client.
  //
  // Sessions are fully disabled for the same reasons lib/supabase/admin.ts disables them:
  // a client that persisted or refreshed a session could write service-role credentials
  // into shared state or onto a response.
  // --------------------------------------------------------------------------
  const asService: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // The submission id, captured from the reservation.
  //
  // runReceiptSubmissionFlow's result union carries a status and nothing else, by design —
  // so that nothing it returns can carry an object path or a hash toward a client. The id
  // is not secret (list_my_receipt_submissions returns it for the caller's own rows) and
  // the mobile client needs it, so it is recorded HERE rather than by widening that shared
  // module's contract. It is only ever put in a response on the `submitted` outcome.
  let reservedSubmissionId: string | null = null;

  const ports: ReceiptSubmissionPorts = {
    async reserve(reserveInput): Promise<ReceiptReserveResult> {
      const result = await Promise.resolve(
        asCaller.rpc(RESERVE_RPC, {
          p_shop_id: reserveInput.shopId,
          p_original_file_name: reserveInput.fileName,
          p_mime_type: reserveInput.mimeType,
          p_file_size_bytes: reserveInput.sizeBytes,
          p_file_sha256: reserveInput.sha256,
        }),
      ).catch(() => null);

      if (result === null) {
        logFailure("reserve transport");
        return { status: "unavailable" };
      }

      if (result.error) {
        // Only the SQLSTATE is read. The message is never bound, returned, or logged —
        // 42501 covers an unauthorized caller, an unassigned shop, an inactive shop,
        // another Retailer's shop and a nonexistent shop with one identical exception, and
        // that indistinguishability is what stops the endpoint being used to probe another
        // Retailer's estate one id at a time.
        const code = (result.error as { code?: string }).code;
        if (code === UNIQUE_VIOLATION) return { status: "duplicate" };
        if (code === INSUFFICIENT_PRIVILEGE) return { status: "denied" };
        if (code === CHECK_VIOLATION) return { status: "invalid" };
        logFailure("reserve rpc-error");
        return { status: "unavailable" };
      }

      const rows = result.data as unknown;
      const row: ReservationRow | undefined = Array.isArray(rows) ? rows[0] : undefined;
      const submissionId = nonEmptyString(row?.submission_id);
      const bucket = nonEmptyString(row?.storage_bucket);
      const objectPath = nonEmptyString(row?.storage_object_path);

      if (!row || submissionId === null || bucket === null || objectPath === null) {
        logFailure("reserve returned an unusable result");
        return { status: "unavailable" };
      }

      reservedSubmissionId = submissionId;
      return { status: "ok", submissionId, bucket, objectPath };
    },

    async upload({ bucket, objectPath }) {
      // `upsert: false` so a collision is an error rather than a silent overwrite: the
      // path carries a fresh random component, so a collision would mean a defect.
      // `contentType` is the SNIFFED type — the client's declared value is never used.
      const result = await Promise.resolve(
        asService.storage.from(bucket).upload(objectPath, fileBytes, {
          contentType: receipt.mimeType,
          upsert: false,
        }),
      ).catch(() => null);

      if (result === null) {
        logFailure("upload transport");
        return { status: "failed" };
      }
      if (result.error) {
        // A Storage error can name the bucket, the key, the account and a request id. It
        // is not bound, returned, or logged.
        logFailure("upload rejected");
        return { status: "failed" };
      }
      return { status: "ok" };
    },

    async finalize({ submissionId, sha256, objectPath, mimeType, sizeBytes }) {
      const result = await Promise.resolve(
        asService.rpc(FINALIZE_RPC, {
          p_submission_id: submissionId,
          p_expected_file_sha256: sha256,
          p_storage_object_path: objectPath,
          p_mime_type: mimeType,
          p_file_size_bytes: sizeBytes,
        }),
      ).catch(() => null);

      if (result === null || result.error) {
        logFailure("finalize failed");
        return { status: "failed" };
      }
      return { status: "ok" };
    },

    async removeObject({ bucket, objectPath }) {
      // Best effort. A failure here leaves an orphaned object, which is undesirable but
      // harmless — the bucket is private and nothing references it. It must never change
      // the outcome the submitter is told.
      const result = await Promise.resolve(
        asService.storage.from(bucket).remove([objectPath]),
      ).catch(() => null);
      if (result === null || result.error) {
        logFailure("could not remove the orphaned object");
      }
    },

    async recordFailure({ submissionId, sha256 }) {
      // Best effort, and it accepts no provider text — the classification is a fixed
      // literal chosen inside the RPC.
      const result = await Promise.resolve(
        asService.rpc(RECORD_FAILURE_RPC, {
          p_submission_id: submissionId,
          p_expected_file_sha256: sha256,
        }),
      ).catch(() => null);
      if (result === null || result.error) {
        logFailure("could not record the upload failure");
      }
    },
  };

  // --------------------------------------------------------------------------
  // 5. reserve -> upload -> finalize. The ORDER lives in the shared pure module, so the
  //    mobile and web clients cannot execute a different sequence.
  // --------------------------------------------------------------------------
  const outcome = await runReceiptSubmissionFlow(
    {
      shopId,
      fileName: receipt.fileName,
      mimeType: receipt.mimeType,
      sizeBytes: receipt.sizeBytes,
      sha256: receipt.sha256,
    },
    ports,
  );

  switch (outcome.status) {
    case "submitted":
      // The id is present because a `submitted` outcome is only reachable through a
      // successful reservation, which sets it. The guard is defence against a future edit
      // to the flow, not against a reachable state today.
      return reservedSubmissionId === null
        ? json("unavailable", 503)
        : json("submitted", 200, { submission_id: reservedSubmissionId });
    case "duplicate":
      return json("duplicate", 409);
    case "denied":
      return json("denied", 403);
    case "invalid":
      return json("invalid", 400, { reason: "rejected" });
    case "upload-failed":
      // Reserved, but the object did not land, or could not be confirmed. Retryable: the
      // row is UPLOAD_FAILED and is excluded from the duplicate-protection index, so the
      // same photo may be submitted again immediately.
      return json("upload-failed", 502);
    default:
      return json("unavailable", 503);
  }
});
