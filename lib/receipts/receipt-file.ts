// SERVER-ONLY MODULE (imports node:crypto), and otherwise dependency-free.
//
// Validates an uploaded receipt file and computes its hash. It is imported only by
// server code — the Server Action and the submission orchestration — and never by a
// Client Component. Like lib/invitations/existing-user-token.ts it uses only Node
// built-ins and no `@/` alias imports, so its unit test can load it under
// `node --experimental-strip-types`.
//
// THE DECLARED CONTENT TYPE IS NEVER TRUSTED.
//   `File.type` in a multipart submission is whatever the client chose to send. It is
//   not read anywhere in this module. The accepted type is DERIVED from the file's own
//   leading bytes, and the derived value is what is stored, what is sent to Storage,
//   and what the database records. A file named `.jpg`, declared `image/jpeg`, whose
//   bytes are a ZIP archive, is rejected here rather than being stored under a type
//   that misdescribes it.
//
//   Signature sniffing for these three formats is a handful of byte comparisons, so no
//   package is added for it. Deeper inspection (full image decoding, EXIF stripping,
//   re-encoding) would need a dependency and is deliberately out of scope for this MVP;
//   what protects the system is that the bucket is private, the object is never served
//   to a browser, and the recorded type comes from the bytes rather than the caller.
//
// THE FILENAME NEVER SHAPES THE STORAGE PATH.
//   The sanitized name is display data only. The object key is generated in SQL from
//   ids the database derived, so nothing an uploader types can traverse, collide, or
//   escape a prefix.
import { createHash } from "node:crypto";

/** The MVP ceiling. No prior convention existed in this repository, so 10 MB it is. */
export const MAX_RECEIPT_FILE_BYTES = 10 * 1024 * 1024;

/**
 * The accepted types, in one place. Byte-identical to the
 * receipt_submissions_mime_type_allowed CHECK and to the bucket's allowed_mime_types.
 *
 * PDF is absent deliberately: no existing product requirement or storage convention in
 * this repository supports it, and a format this module cannot verify by signature
 * would put the declared type back in charge.
 */
export const SUPPORTED_RECEIPT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type ReceiptMimeType = (typeof SUPPORTED_RECEIPT_MIME_TYPES)[number];

/** The longest filename the database will store. */
const MAX_FILE_NAME_LENGTH = 255;

/** Matches any ASCII control character (U+0000–U+001F, U+007F). */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/** Runs of whitespace, including the exotic kinds a paste can carry. */
const WHITESPACE_RUN = /\s+/g;

function startsWithBytes(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

/**
 * The file's real type, derived from its leading bytes, or null when it is not one of
 * the three supported formats.
 *
 *   JPEG  FF D8 FF
 *   PNG   89 50 4E 47 0D 0A 1A 0A
 *   WebP  "RIFF" at 0 and "WEBP" at 8 (a RIFF container whose form type is WEBP)
 */
export function sniffReceiptMimeType(bytes: Uint8Array): ReceiptMimeType | null {
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (
    startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * A safe display filename, or null when nothing usable remains.
 *
 * Takes the last path segment (so `../../etc/passwd` and `C:\x\y.jpg` reduce to
 * `passwd` and `y.jpg`), removes control characters, collapses whitespace runs, trims,
 * and caps the length. The result is stored only to help the submitter recognise their
 * own row in the history list.
 */
export function sanitizeReceiptFileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const lastSegment = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = lastSegment
    .replace(CONTROL_CHARS, "")
    .replace(WHITESPACE_RUN, " ")
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH)
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

/** The lowercase SHA-256 hex digest of the file's bytes. */
export function hashReceiptFile(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Why a file was refused. One value per distinct, user-actionable cause. */
export type ReceiptFileRejection =
  | "missing"
  | "empty"
  | "too-large"
  | "unsupported-type"
  | "invalid-name"
  | "too-many-files";

export type ValidatedReceiptFile = {
  fileName: string;
  /** Derived from the bytes — never the declared type. */
  mimeType: ReceiptMimeType;
  sizeBytes: number;
  /** Lowercase SHA-256 hex. */
  sha256: string;
};

export type ReceiptFileValidation =
  | { ok: true; file: ValidatedReceiptFile }
  | { ok: false; reason: ReceiptFileRejection };

/**
 * Validates one receipt file.
 *
 * ONE FILE PER SUBMISSION. `fileCount` is checked because a multipart body can carry
 * several parts under one field name; multi-page receipts are not a requirement of this
 * MVP, and silently keeping the first part would store something other than what the
 * person believed they submitted.
 *
 * Order matters: size is checked before the bytes are examined, so an oversized upload
 * is refused without sniffing it, and the hash is computed last — only for a file that
 * has already been accepted.
 */
export function validateReceiptFile(input: {
  fileName: unknown;
  bytes: Uint8Array | null | undefined;
  fileCount?: number;
}): ReceiptFileValidation {
  if (typeof input.fileCount === "number" && input.fileCount > 1) {
    return { ok: false, reason: "too-many-files" };
  }

  if (!input.bytes) {
    return { ok: false, reason: "missing" };
  }

  const sizeBytes = input.bytes.byteLength;

  if (sizeBytes === 0) {
    return { ok: false, reason: "empty" };
  }
  if (sizeBytes > MAX_RECEIPT_FILE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  const mimeType = sniffReceiptMimeType(input.bytes);
  if (mimeType === null) {
    return { ok: false, reason: "unsupported-type" };
  }

  const fileName = sanitizeReceiptFileName(input.fileName);
  if (fileName === null) {
    return { ok: false, reason: "invalid-name" };
  }

  return {
    ok: true,
    file: { fileName, mimeType, sizeBytes, sha256: hashReceiptFile(input.bytes) },
  };
}

/** A human file size for the history list and the picker's feedback. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
