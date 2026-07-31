/**
 * PURE MODULE — no imports, no I/O, no `next/*`, no Supabase client, no Node built-in.
 *
 * THE AUTHORITATIVE UPLOAD SIZE POLICY. Every layer that has an opinion about how big
 * an upload may be reads it from here:
 *
 *   UI guidance             app/(retailer)/retailer/receipts/submit-receipt-form.tsx
 *   client pre-flight       lib/receipts/receipt-upload-preflight.ts
 *   shared error copy       app/(retailer)/retailer/receipts/submit-receipt-state.ts
 *   request boundary        next.config.ts
 *   tests                   lib/uploads/*.test.ts
 *
 * WHY THE FILE MAXIMUM IS RESTATED HERE RATHER THAN IMPORTED.
 *   The one module that already held it, lib/receipts/receipt-file.ts, imports
 *   node:crypto — it is the server-side validator — and next.config.ts must be able to
 *   read this policy without dragging a Node built-in and a hashing implementation into
 *   the configuration graph. It is also pinned byte-unchanged by the receipt-extraction
 *   milestone's scope guard (see lib/receipts/receipt-extraction-safety.test.ts).
 *
 *   So the value appears in two places on purpose, and DIVERGENCE IS MADE IMPOSSIBLE BY
 *   TEST rather than by import: lib/uploads/upload-policy.test.ts asserts this constant
 *   equals lib/receipts/receipt-file.ts's MAX_RECEIPT_FILE_BYTES, equals the
 *   receipt_submissions CHECK constraint in the migration, equals the private bucket's
 *   file_size_limit, and equals the guard inside reserve_receipt_submission(). That
 *   reaches three layers — SQL included — that a shared TypeScript constant never could,
 *   which is a better guarantee than an import would have bought.
 *
 * WHY THIS MODULE EXISTS — the defect it repairs.
 *   The receipt page advertised a 10 MB maximum, the Server Action enforced a 10 MB
 *   maximum, and the database CHECK enforced 10 MB — but nothing had told Next.js, whose
 *   Server Action body limit defaults to 1 MB. Any receipt above 1 MB was therefore
 *   rejected by the framework before a single line of application validation ran, as a
 *   413 that Next.js reports to the client as a 500. Three layers agreed with each other
 *   and all three were wrong about the fourth.
 *
 *   The rule this module encodes is that the TRANSPORT maximum is DERIVED from the
 *   APPLICATION maximum and can never sit below it. A future change to the file
 *   maximum moves the request boundary with it, and lib/uploads/upload-request-boundary.test.ts
 *   fails the build if next.config.ts ever stops agreeing.
 *
 * BINARY UNITS, DISPLAYED AS "MB".
 *   "10 MB" throughout this product means 10 MiB — 10 * 1024 * 1024 = 10,485,760 bytes.
 *   That is what the receipt_submissions CHECK constraint stores
 *   (file_size_bytes <= 10485760), what the private `receipts` bucket's file_size_limit
 *   is set to, and what reserve_receipt_submission() re-checks in SQL. This module does
 *   not change that convention; it names it so the next reader does not have to
 *   rediscover it. The user-facing copy says "MB" because that is what people write.
 *
 * WHAT IS NEVER ADVERTISED TO A USER: the transport numbers below. They exist so that a
 * file AT the application maximum still fits inside a request once multipart framing is
 * added; they are not a size anyone is allowed to upload, and quoting them to a user
 * would invite exactly the confusion this module exists to end.
 */

/**
 * The largest receipt image the application accepts, in bytes.
 *
 * 10 MiB. Byte-identical to lib/receipts/receipt-file.ts's MAX_RECEIPT_FILE_BYTES (the
 * server-side validator), to the receipt_submissions.file_size_bytes CHECK, to the
 * `receipts` bucket's file_size_limit, and to the guard inside
 * reserve_receipt_submission(). All five are asserted equal by
 * ./upload-policy.test.ts. Changing it here alone does not raise the ceiling — it breaks
 * the build, which is the point.
 */
export const MAX_RECEIPT_FILE_BYTES = 10 * 1024 * 1024;

/**
 * The same number expressed for display, so no component divides by 1024 twice.
 *
 * lib/uploads/upload-policy.test.ts asserts these two constants describe the same size,
 * which is what stops the copy and the enforcement from drifting apart.
 */
export const MAX_RECEIPT_FILE_MEGABYTES = 10;

/**
 * The largest file ANY web upload feature accepts, in bytes.
 *
 * Today the Retailer receipt image is the only file upload in the web application (see
 * DECLARED_UPLOAD_SURFACES below, and the audit in
 * lib/uploads/upload-request-boundary.test.ts), so this is simply the receipt maximum.
 * It is a SEPARATE name because the request boundary below is application-wide: a future
 * feature with a larger file must raise THIS value, and a future feature with a smaller
 * one must not lower it.
 */
export const MAX_UPLOADED_FILE_BYTES = MAX_RECEIPT_FILE_BYTES;

/**
 * Headroom for the bytes a request carries that are not the file itself.
 *
 * A multipart/form-data body wraps each part in a boundary delimiter, a
 * Content-Disposition header and a Content-Type header, and a Server Action submission
 * adds its own fields on top (the action id, the shop id, and React's serialized
 * previous state). For a two-field form that is on the order of a kilobyte; the Next.js
 * documentation for `serverActions.bodySizeLimit` suggests allowing 10–20 KB.
 *
 * 256 KiB is deliberately far above that estimate and still small in absolute terms. The
 * point of the margin is that a person uploading a photograph that is exactly at the
 * advertised limit must not be refused by arithmetic they cannot see; the point of
 * keeping it BOUNDED is that this number is also the denial-of-service surface.
 */
export const UPLOAD_REQUEST_OVERHEAD_BYTES = 256 * 1024;

/**
 * The value for `experimental.serverActions.bodySizeLimit` in next.config.ts.
 *
 * Next.js measures this against the RAW HTTP request body — file bytes plus every byte
 * of multipart framing — and answers a body above it with a 413 that its Server Action
 * handler reports to the browser as a 500 (see the `TODO` in
 * next/dist/server/app-render/action-handler.js, which notes the status code is
 * deliberately not converted). That is why this must sit above the application maximum
 * rather than at it: at it, a 10 MiB photograph would fail at the framework boundary
 * with an error the application never gets to explain.
 *
 * It is FINITE on purpose. Removing the ceiling — or setting it to something like a
 * gigabyte — would let an unauthenticated POST make the server buffer arbitrary amounts
 * of memory, which is precisely the attack the Next.js default exists to prevent.
 */
export const SERVER_ACTION_BODY_SIZE_LIMIT_BYTES =
  MAX_UPLOADED_FILE_BYTES + UPLOAD_REQUEST_OVERHEAD_BYTES;

/**
 * A small allowance so the Server Action boundary — not the Proxy — is the layer that
 * refuses an over-sized body.
 *
 * WHY THIS MATTERS, AND WHY IT IS NOT COSMETIC.
 *   proxy.ts matches /retailer/receipts, so every receipt submission is a non-GET
 *   request that Next.js must make readable TWICE: once for the Proxy and once for the
 *   route. It does that by cloning the body stream through
 *   next/dist/server/body-streams.js `getCloneableBody`, bounded by
 *   `experimental.proxyClientMaxBodySize`. When a body exceeds that bound the clone is
 *   TRUNCATED — `console.warn` and `push(null)`, not an error — so the Server Action
 *   would receive a silently short multipart body instead of a clear refusal.
 *
 *   That default is 10,485,760 bytes: EXACTLY the advertised file maximum, with no room
 *   for multipart framing. Raising only the Server Action limit would therefore have
 *   moved the failure rather than fixed it — a 10 MiB receipt would have been truncated
 *   by the Proxy at the very ceiling the product advertises.
 *
 * Keeping the Proxy bound strictly ABOVE the Server Action bound means an over-sized
 * body always reaches the Server Action boundary intact enough to be refused there,
 * cleanly and deterministically, instead of arriving corrupted.
 */
export const PROXY_BODY_CLONE_HEADROOM_BYTES = 64 * 1024;

/** The value for `experimental.proxyClientMaxBodySize` in next.config.ts. */
export const PROXY_CLIENT_MAX_BODY_BYTES =
  SERVER_ACTION_BODY_SIZE_LIMIT_BYTES + PROXY_BODY_CLONE_HEADROOM_BYTES;

/**
 * The Next.js default Server Action body limit, in bytes (1 MiB).
 *
 * Recorded here ONLY so the contract test can assert the configuration has not silently
 * regressed to it. Nothing reads it at runtime.
 */
export const NEXT_DEFAULT_SERVER_ACTION_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * The Next.js default Proxy body-clone limit, in bytes (10 MiB).
 *
 * Recorded for the same reason as the constant above, and worth stating plainly: this
 * default is not merely too small by a margin, it is numerically equal to
 * MAX_RECEIPT_FILE_BYTES, which is what made it a latent defect rather than an obvious
 * one.
 */
export const NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_BYTES = 10 * 1024 * 1024;

// ===========================================================================
// THE UPLOAD-SURFACE REGISTRY
// ===========================================================================

/**
 * One place in the web application that can receive binary upload bytes.
 *
 * A "surface" is a source file, because that is the unit a reviewer reads and the unit
 * the audit can find. A feature spanning a form and its Server Action declares both.
 */
export type UploadSurface = {
  /** Repository-relative source path. */
  readonly path: string;
  /** What this surface accepts, in bytes. Must fit under the transport limits. */
  readonly maxBytes: number;
  /** Why it exists, in one line, for whoever reads the audit failure. */
  readonly purpose: string;
  /**
   * The test that exercises this surface's size rule at its exact boundary.
   *
   * Named rather than inferred: a heuristic that guessed which test covered a surface
   * would be the least reliable part of the audit.
   */
  readonly sizeValidationTest: string;
  /** The test proving this surface's failures are reported as operational, not denial. */
  readonly operationalErrorTest: string;
};

/**
 * EVERY web binary-upload surface, with the limit each one claims.
 *
 * WHAT THIS IS FOR. The transport limits above are application-wide: whatever the
 * largest declared upload is, the Server Action and Proxy bounds must sit above it. That
 * only works if the set of uploads is KNOWN. So a surface that handles upload bytes has
 * to appear here, and lib/uploads/upload-request-boundary.test.ts fails — naming the file
 * — when one does not.
 *
 * IT DOES NOT FORBID NEW UPLOADS. Adding a second upload feature means adding a line
 * here with its own maximum and writing the tests the audit asks for. That is the whole
 * cost. The rule this replaces refused every new POST, PUT and PATCH route handler in
 * the application, including JSON endpoints and webhooks that carry no upload at all,
 * which is a prohibition on ordinary development rather than an upload policy.
 *
 * A surface's maxBytes may be SMALLER than MAX_UPLOADED_FILE_BYTES — a future avatar
 * upload capped at 1 MB is welcome. It may not exceed what the transport can carry;
 * that is asserted, not assumed.
 */
export const DECLARED_UPLOAD_SURFACES: readonly UploadSurface[] = [
  {
    path: "app/(retailer)/retailer/receipts/submit-receipt-form.tsx",
    maxBytes: MAX_RECEIPT_FILE_BYTES,
    purpose: "Sales Staff choose one receipt photograph and submit it.",
    sizeValidationTest: "lib/receipts/receipt-upload-preflight.test.ts",
    operationalErrorTest: "lib/receipts/receipt-upload-error-routing.test.ts",
  },
  {
    path: "app/(retailer)/retailer/receipts/actions.ts",
    maxBytes: MAX_RECEIPT_FILE_BYTES,
    purpose: "The Server Action that re-validates and stores that photograph.",
    sizeValidationTest: "lib/receipts/receipt-upload-preflight.test.ts",
    operationalErrorTest: "lib/receipts/receipt-upload-error-routing.test.ts",
  },
  {
    // The SERVER-SIDE HALF of the same feature, and the only module in the web
    // application that hands receipt bytes to Storage. It is declared under the SAME
    // maxBytes constant as the two surfaces above — one receipt policy, three files that
    // participate in it — because a second number here is exactly the drift this module
    // exists to prevent.
    //
    // Its size rule is not its own: by the time bytes reach it they have already been
    // through validateReceiptFile, whose 10 MiB boundary receipt-upload-preflight.test.ts
    // exercises at MAX, MAX-1 and MAX+1, and whose number upload-policy.test.ts pins to
    // the bucket's file_size_limit and to reserve_receipt_submission()'s own SQL guard —
    // the two layers this module actually calls.
    path: "lib/receipts/receipt-submissions.ts",
    maxBytes: MAX_RECEIPT_FILE_BYTES,
    purpose: "Server-only: reserves, uploads to private Storage, and finalizes.",
    sizeValidationTest: "lib/receipts/receipt-upload-preflight.test.ts",
    operationalErrorTest: "lib/receipts/receipt-upload-error-routing.test.ts",
  },
];

/**
 * The signals that say a source file handles UPLOAD BYTES, as opposed to form fields.
 *
 * Chosen so that ordinary work does not trip them. A JSON route handler, a webhook
 * receiver, and the twenty-odd Server Actions in this application that read text out of
 * a FormData match NOTHING here — `FormData` on its own is deliberately absent, because
 * every Server Action in the App Router receives one.
 *
 * Each entry is matched against COMMENT-STRIPPED source, so a file that merely discusses
 * uploads is not mistaken for one that performs them.
 */
const UPLOAD_SIGNALS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  // A file picker in the markup — the only way a browser offers bytes at all.
  { name: 'input type="file"', pattern: /type=\s*(?:"file"|'file'|\{\s*["'`]file["'`]\s*\})/ },
  // An explicit multipart body: the encoding binary uploads travel in.
  { name: "multipart/form-data", pattern: /multipart\/form-data/ },
  // A FormData part narrowed to binary. This is what separates an upload from a form.
  { name: "File/Blob part", pattern: /instanceof\s+(?:File|Blob)\b/ },
  { name: "new Blob", pattern: /new\s+Blob\s*\(/ },
  // Reading uploaded content into memory.
  { name: "arrayBuffer()", pattern: /\.arrayBuffer\s*\(\s*\)/ },
  // Handing bytes to Storage.
  {
    name: "Storage upload",
    pattern: /\.storage[\s\S]{0,120}?\.(?:upload|uploadToSignedUrl|createSignedUploadUrl)\s*\(/,
  },
];

/** Removes block and line comments so prose cannot look like an implementation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The upload signals present in one source file — empty for everything that is not an
 * upload surface.
 *
 * Content-based on purpose: it does not care whether a route handler is written
 * `export async function POST`, `export function PUT`, `export const PATCH = …` or
 * `export { handler as POST }`, because none of those tells you whether bytes are being
 * received. What the file DOES with the request is what tells you.
 */
export function detectUploadSignals(source: string): string[] {
  const code = stripComments(source);
  return UPLOAD_SIGNALS.filter((signal) => signal.pattern.test(code)).map(
    (signal) => signal.name,
  );
}

/** Whether a source file handles upload bytes and therefore needs a declared policy. */
export function isUploadSurfaceSource(source: string): boolean {
  return detectUploadSignals(source).length > 0;
}

// ===========================================================================
// THE AUDIT'S SCOPE
// ===========================================================================

/**
 * The directories the upload audit walks.
 *
 * WHY NOT ALL OF `lib`. Scanning `lib` wholesale flags three kinds of file that are not
 * upload surfaces, and each false positive is a reason someone eventually deletes the
 * rule:
 *
 *   this module          the signal TABLE above contains the strings it searches for
 *                        ('input type="file"', "multipart/form-data") as literal data,
 *                        not as comments, so comment-stripping cannot save it from
 *                        matching itself
 *   *.test.ts            tests generate File, Blob, multipart bodies and arrayBuffer()
 *                        calls ON PURPOSE — that is how they prove the rule works
 *   lib/ui, lib/staff, … unrelated modules that mention a file input in passing
 *
 * WHY `lib/receipts` IS IN. The receipt upload has a server-side half:
 * lib/receipts/receipt-submissions.ts is the module that actually hands bytes to
 * Storage. Leaving it outside the walk meant the audit's claim — every file handling
 * upload bytes is declared — was broader than what it checked, and a future upload
 * implemented as a lib/receipts helper would have gone undetected.
 *
 * This list is deliberately a LIST and not a heuristic. Adding an upload feature outside
 * these roots means adding its root here, which is a visible, reviewable line rather than
 * a silent gap.
 */
export const UPLOAD_AUDIT_ROOTS: readonly string[] = [
  "app",
  "components",
  "lib/receipts",
];

/** Path segments that only ever hold test scaffolding, never a production upload. */
const TEST_SCAFFOLDING_SEGMENTS: readonly string[] = [
  "__tests__",
  "__mocks__",
  "__fixtures__",
];

/** Normalizes a repository-relative path so the rules below are separator-agnostic. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Whether a file inside an audited root is PRODUCTION source the audit should read.
 *
 * Excluded, and why each exclusion is safe:
 *
 *   *.test.ts / *.test.tsx   a test that builds an over-sized multipart body is doing its
 *                            job; flagging it would demand a policy for a fixture. This is
 *                            the same exclusion lib/receipts/receipt-source-safety.test.ts
 *                            already applies to the receipt feature's own guards.
 *   *.d.ts                   declarations describe types and execute nothing.
 *   *.generated.ts(x)        generated output is not where an upload is authored.
 *   __tests__/__mocks__/     the double-underscore convention is unambiguously scaffolding.
 *   __fixtures__/
 *
 * A bare `fixtures/` directory is deliberately NOT excluded: it is an ordinary name a real
 * module could sit under, and an exclusion wide enough to hide an upload behind a folder
 * name would be worse than the gap it closed.
 */
export function isAuditableUploadSourceFile(path: string): boolean {
  const normalized = normalizePath(path);

  if (!/\.tsx?$/.test(normalized)) return false;
  if (/\.d\.ts$/.test(normalized)) return false;
  if (/\.test\.tsx?$/.test(normalized)) return false;
  if (/\.generated\.tsx?$/.test(normalized)) return false;

  const segments = normalized.split("/");
  return !segments.some((segment) => TEST_SCAFFOLDING_SEGMENTS.includes(segment));
}

/**
 * Whether a repository-relative path is production source the upload audit covers.
 *
 * Both halves matter: the root list is what keeps the audit narrow, and the file filter is
 * what keeps it from flagging its own test fixtures.
 */
export function isWithinUploadAuditScope(path: string): boolean {
  const normalized = normalizePath(path);
  const inRoot = UPLOAD_AUDIT_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
  return inRoot && isAuditableUploadSourceFile(normalized);
}
