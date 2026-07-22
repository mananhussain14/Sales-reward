// SERVER-ONLY MODULE.
//
// Generates and hashes the application-owned existing-user invitation token, using
// Node's crypto. It is imported only by server code (route handlers, server
// actions, the orchestration service); it never reaches a Client Component.
//
// THE TOKEN IS A DISCOVERY POINTER, NOT A CREDENTIAL. It says WHICH invitation a
// clicker is acting on; it authenticates no one. Acceptance additionally requires
// an authenticated Supabase session whose verified email matches the invitation.
// So a leaked/forwarded token is inert on its own.
//
// WHAT IS STORED WHERE:
//   - The RAW token appears only in the emailed URL and, for one redirect hop, in
//     the intake route's request. It is NEVER stored in PostgreSQL, never logged,
//     never placed in a `next` value, and never returned to the browser as data.
//   - Only SHA-256(raw) as 64 lowercase hex is persisted (in retailer_invitations
//     .token_hash by the DB, and briefly in an HttpOnly cookie for acceptance).
import { createHash, randomBytes } from "node:crypto";

/**
 * The number of random bytes in a raw token. 32 bytes = 256 bits of entropy,
 * comfortably beyond guessing, and the minimum this module will emit.
 */
const TOKEN_BYTES = 32;

/**
 * The exact shape of a SHA-256 hex digest: 64 lowercase hexadecimal characters.
 * Byte-identical to the database's retailer_invitations_token_hash_format CHECK.
 */
export const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The shape of a raw token as base64url. `randomBytes(32)` base64url-encodes to 43
 * characters, all in the URL-safe alphabet with no padding. Validated before any
 * hashing of an INCOMING (URL-supplied) value, so a malformed or oversized string
 * never reaches the hasher or the database.
 */
export const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,}$/;

/** A cap so a hostile URL cannot feed an unbounded string into the hasher. */
const RAW_TOKEN_MAX_LENGTH = 512;

/**
 * SHA-256 of the raw token, as 64 lowercase hex characters. Deterministic and
 * standard, so the value computed here equals the one the intake route computes
 * for the same token, and equals what the database stores.
 */
export function hashInvitationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Whether an incoming raw token has the expected URL-safe shape and bound. */
export function isValidRawToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= RAW_TOKEN_MAX_LENGTH &&
    RAW_TOKEN_PATTERN.test(value)
  );
}

/** Whether a value is a well-formed token hash (64 lowercase hex). */
export function isValidTokenHash(value: unknown): value is string {
  return typeof value === "string" && TOKEN_HASH_PATTERN.test(value);
}

/**
 * Generates a fresh invitation token.
 *
 * Cryptographically secure: `crypto.randomBytes` only, never Math.random. Returns
 * the raw token (URL-safe, to be emailed) and its hash (to be stored). The caller
 * must treat `rawToken` as a secret in transit and never persist or log it.
 */
export function generateInvitationToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
  return { rawToken, tokenHash: hashInvitationToken(rawToken) };
}
