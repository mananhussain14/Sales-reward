/**
 * THE TEST THE ORIGINAL DEFECT WOULD HAVE FAILED.
 *
 * Run with:  npm test
 *
 * Every unit test in this repository passed while receipt uploads above 1 MB were
 * broken, because they all measured the APPLICATION's opinion of a file and the thing
 * that was wrong was the FRAMEWORK's. Next.js rejected the request at its own boundary,
 * before a single line of lib/receipts ran, so no amount of testing validateReceiptFile
 * could ever have noticed.
 *
 * These tests therefore assert against the real configuration and the real framework
 * code, not against the application's constants:
 *
 *   1. CONFIGURATION CONTRACT — next.config.ts is IMPORTED and its effective values are
 *      read. Not grepped: the numbers asserted here are the numbers Next.js will use.
 *   2. REAL ENCODED PAYLOADS — the request bodies measured below are produced by the
 *      platform's own multipart encoder (FormData -> Request -> arrayBuffer), so the
 *      framing overhead in them is real overhead, not an estimate.
 *   3. REAL FRAMEWORK CODE — the Proxy body-clone gate is exercised by calling Next's
 *      own getCloneableBody from node_modules, at the configured limit and at the
 *      default, proving both what the fix does and what the defect did.
 *   4. AN AUDIT GUARD — a file that handles upload bytes cannot appear in the web
 *      application without declaring an upload policy that fits under these limits, and
 *      naming the tests that cover it. It bounds uploads; it does not ban them, and it
 *      says nothing at all about endpoints that carry no upload.
 *
 * ---------------------------------------------------------------------------
 * THE LIMITATION, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * The Server Action gate itself (the `sizeLimitTransform` inside
 * next/dist/server/app-render/action-handler.js) is created inline inside the request
 * handler and is not exported, so it cannot be invoked from a unit test. Reaching it for
 * real needs a running server, an authenticated Sales Staff session and a live Supabase
 * project — an end-to-end test this repository has no harness for, and one that must not
 * be pointed at production data.
 *
 * What is asserted instead is everything that determines that gate's behaviour: the
 * exact limit Next.js will read (imported from the real config), parsed by NEXT'S OWN
 * bytes module, compared against REAL encoded request bodies at 1.5 MB and at the 10 MB
 * ceiling, using the same `size > limit` predicate the handler applies. That is the
 * strongest executable contract available here; the remaining gap is the manual
 * reproduction recorded in the pull request.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import nextConfig from "../../next.config.ts";
import {
  DECLARED_UPLOAD_SURFACES,
  detectUploadSignals,
  isAuditableUploadSourceFile,
  isWithinUploadAuditScope,
  UPLOAD_AUDIT_ROOTS,
  MAX_RECEIPT_FILE_BYTES,
  MAX_UPLOADED_FILE_BYTES,
  NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_BYTES,
  NEXT_DEFAULT_SERVER_ACTION_BODY_LIMIT_BYTES,
  PROXY_CLIENT_MAX_BODY_BYTES,
  SERVER_ACTION_BODY_SIZE_LIMIT_BYTES,
} from "./upload-policy.ts";

const require = createRequire(import.meta.url);

/** The repository root, derived from this file's own location (lib/uploads/). */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * An upper bound on what this application may ever accept as a request body.
 *
 * Not a Next.js number and not a product requirement — a test-only sanity ceiling, so
 * that "raise the limit until it works" can never quietly become "accept anything". A
 * change that legitimately needs more than this should have to edit this line and say
 * why.
 */
const SANITY_CEILING_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The effective configuration, read from the real next.config.ts
// ---------------------------------------------------------------------------
const experimental = nextConfig.experimental ?? {};
const configuredActionLimit = experimental.serverActions?.bodySizeLimit;
const configuredProxyLimit = experimental.proxyClientMaxBodySize;

/**
 * Next.js resolves a configured limit through its own bundled `bytes` module
 * (action-handler.js passes it to `bytes.parse`, config.js accepts a number as-is), so
 * the test resolves it the same way rather than assuming.
 */
function resolveLimit(value: unknown): number {
  const bytes = require("next/dist/compiled/bytes") as {
    parse: (input: string | number) => number | null;
  };
  const parsed =
    typeof value === "number" || typeof value === "string" ? bytes.parse(value) : null;
  assert.ok(
    parsed !== null && Number.isFinite(parsed),
    `next.config.ts declares a limit Next.js cannot parse: ${String(value)}`,
  );
  return parsed as number;
}

describe("1. the configured Server Action body limit", () => {
  test("1. is declared at all — an absent value IS the 1 MB default", () => {
    // This is the assertion that would have failed before the fix. next.config.ts was
    // an empty object, so Next.js used `defaultBodySizeLimit = '1 MB'` and every receipt
    // over 1 MB was refused with a 413 the application never saw.
    assert.notEqual(
      configuredActionLimit,
      undefined,
      "experimental.serverActions.bodySizeLimit is unset, so Next.js falls back to 1 MB",
    );
  });

  test("2. is the value the policy derives, and Next.js parses it to that number", () => {
    assert.equal(configuredActionLimit, SERVER_ACTION_BODY_SIZE_LIMIT_BYTES);
    assert.equal(resolveLimit(configuredActionLimit), SERVER_ACTION_BODY_SIZE_LIMIT_BYTES);
  });

  test("3. is strictly greater than the 10 MB application file maximum", () => {
    // Strictly greater, not equal: a request body is the file PLUS multipart framing, so
    // a limit equal to the file maximum would refuse a file at the advertised ceiling.
    assert.ok(
      resolveLimit(configuredActionLimit) > MAX_RECEIPT_FILE_BYTES,
      `the transport limit must exceed the ${MAX_RECEIPT_FILE_BYTES}-byte file maximum`,
    );
  });

  test("4. has not regressed to the Next.js default", () => {
    assert.notEqual(
      resolveLimit(configuredActionLimit),
      NEXT_DEFAULT_SERVER_ACTION_BODY_LIMIT_BYTES,
    );
  });

  test("5. remains finite and bounded — no unlimited request body", () => {
    const limit = resolveLimit(configuredActionLimit);
    assert.ok(Number.isFinite(limit), "the limit is not finite");
    assert.ok(limit > 0, "the limit is not positive");
    assert.ok(
      limit <= SANITY_CEILING_BYTES,
      `the limit ${limit} exceeds the sanity ceiling; unbounded bodies are a DoS surface`,
    );
  });
});

describe("2. the configured Proxy body-clone limit", () => {
  test("6. is declared, and Next.js parses it to the policy's number", () => {
    assert.notEqual(configuredProxyLimit, undefined);
    assert.equal(resolveLimit(configuredProxyLimit), PROXY_CLIENT_MAX_BODY_BYTES);
  });

  test("7. has not regressed to the Next.js default, which equals the file maximum", () => {
    // The default is 10,485,760 bytes — numerically identical to MAX_RECEIPT_FILE_BYTES,
    // leaving zero room for multipart framing. That is what made it a latent defect
    // rather than an obvious one, so it is asserted from both directions.
    assert.equal(NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_BYTES, MAX_RECEIPT_FILE_BYTES);
    assert.notEqual(
      resolveLimit(configuredProxyLimit),
      NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_BYTES,
    );
  });

  test("8. sits strictly above the Server Action limit", () => {
    // So an over-sized body is refused by the Server Action boundary — cleanly, with a
    // 413 — rather than silently TRUNCATED by the Proxy's body clone and handed to
    // busboy as a short multipart body.
    assert.ok(
      resolveLimit(configuredProxyLimit) > resolveLimit(configuredActionLimit),
      "the Proxy would truncate a body before the Server Action could refuse it",
    );
  });

  test("9. remains finite and bounded", () => {
    const limit = resolveLimit(configuredProxyLimit);
    assert.ok(Number.isFinite(limit) && limit > 0);
    assert.ok(limit <= SANITY_CEILING_BYTES);
  });
});

// ---------------------------------------------------------------------------
// Real encoded request bodies
// ---------------------------------------------------------------------------

/**
 * Deterministic filler bytes carrying a real JPEG signature. Generated, never a fixture.
 *
 * The backing store is declared explicitly so the result satisfies `BlobPart`, which
 * does not accept a Uint8Array over a possibly-shared buffer.
 */
function generateJpegBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  for (let index = 10; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

/**
 * The REAL wire bytes of a receipt submission carrying a file of `size` bytes.
 *
 * Encoded by the platform's own multipart serializer, with fields shaped like the ones a
 * Server Action submission actually carries: the form's own `shopId` and `receipt`, plus
 * the action id and serialized previous state React adds. No large binary fixture is
 * committed — the bytes are generated in memory and discarded with the test.
 */
async function encodeSubmissionBody(size: number): Promise<Uint8Array> {
  const form = new FormData();
  form.append("1_$ACTION_ID_" + "0".repeat(40), "");
  form.append("0", JSON.stringify([{ fieldErrors: {}, formError: null }]));
  form.append("shopId", "6f1d5f0a-6a1e-4d2b-9c3f-1a2b3c4d5e6f");
  form.append(
    "receipt",
    new Blob([generateJpegBytes(size)], { type: "image/jpeg" }),
    "generated-test-receipt.jpg",
  );

  const request = new Request("http://localhost/retailer/receipts", {
    method: "POST",
    body: form,
  });

  return new Uint8Array(await request.arrayBuffer());
}

describe("3. real encoded bodies fit the configured Server Action limit", () => {
  test("10. a 1.5 MB receipt — the size that used to fail — is now well inside it", async () => {
    const body = await encodeSubmissionBody(Math.floor(1.5 * 1024 * 1024));

    // The defect, restated as an assertion: this exact body exceeded the old default.
    assert.ok(
      body.byteLength > NEXT_DEFAULT_SERVER_ACTION_BODY_LIMIT_BYTES,
      "the 1.5 MB case no longer reproduces the original overflow",
    );
    // And is accepted now. `>` is Next.js's own predicate (`size > bodySizeLimitBytes`).
    assert.ok(
      !(body.byteLength > resolveLimit(configuredActionLimit)),
      "a 1.5 MB receipt would still be refused at the request boundary",
    );
  });

  test("11. a receipt at the exact 10 MB maximum fits, framing included", async () => {
    const body = await encodeSubmissionBody(MAX_RECEIPT_FILE_BYTES);

    // Overhead is real and measured, not assumed — this is the whole reason the
    // transport limit is above the file limit rather than equal to it.
    assert.ok(
      body.byteLength > MAX_RECEIPT_FILE_BYTES,
      "the encoder added no framing, so this test proves nothing",
    );
    assert.ok(
      !(body.byteLength > resolveLimit(configuredActionLimit)),
      `a maximum-size receipt encodes to ${body.byteLength} bytes, above the configured limit`,
    );
  });

  test("12. the measured framing overhead is far inside the allowance", async () => {
    const body = await encodeSubmissionBody(MAX_RECEIPT_FILE_BYTES);
    const overhead = body.byteLength - MAX_RECEIPT_FILE_BYTES;

    assert.ok(overhead > 0, "no overhead was measured");
    assert.ok(
      overhead < SERVER_ACTION_BODY_SIZE_LIMIT_BYTES - MAX_RECEIPT_FILE_BYTES,
      `measured overhead ${overhead} exceeds the configured allowance`,
    );
  });

  test("13. a body above the transport limit is still refused", async () => {
    // The ceiling is a ceiling. Application validation refuses anything over 10 MB long
    // before this, but if the browser is bypassed the framework must still say no.
    const body = await encodeSubmissionBody(
      resolveLimit(configuredActionLimit) + 1024 * 1024,
    );
    assert.ok(
      body.byteLength > resolveLimit(configuredActionLimit),
      "an over-sized body would be accepted",
    );
  });
});

// ---------------------------------------------------------------------------
// Next.js's own Proxy body-clone code, executed
// ---------------------------------------------------------------------------

/** Splits a body into realistic ~64 KiB socket chunks. */
function chunked(body: Uint8Array): Buffer[] {
  const CHUNK = 64 * 1024;
  const out: Buffer[] = [];
  for (let offset = 0; offset < body.byteLength; offset += CHUNK) {
    out.push(Buffer.from(body.subarray(offset, Math.min(offset + CHUNK, body.byteLength))));
  }
  return out;
}

/**
 * Runs a body through Next.js's REAL getCloneableBody at `limit` and reports how many
 * bytes survived. Below the limit the clone is complete; above it, Next.js truncates the
 * stream and warns rather than failing (next/dist/server/body-streams.js).
 */
async function clonedByteLength(body: Uint8Array, limit: number): Promise<number> {
  const { getCloneableBody } = require("next/dist/server/body-streams.js") as {
    getCloneableBody: (
      readable: Readable,
      sizeLimit?: number,
    ) => { cloneBodyStream: () => NodeJS.ReadableStream };
  };

  const cloneable = getCloneableBody(Readable.from(chunked(body)), limit);

  // Next.js warns on truncation. The warning is the framework's, not a failure, and
  // silencing it keeps the intent of the test readable in the output.
  const warn = console.warn;
  console.warn = () => {};
  try {
    let total = 0;
    for await (const chunk of cloneable.cloneBodyStream()) {
      total += (chunk as Buffer).length;
    }
    return total;
  } finally {
    console.warn = warn;
  }
}

describe("4. Next.js's own Proxy body clone, at both limits", () => {
  test("14. the Next.js DEFAULT truncates a maximum-size receipt — the latent defect", async () => {
    const body = await encodeSubmissionBody(MAX_RECEIPT_FILE_BYTES);
    const survived = await clonedByteLength(
      body,
      NEXT_DEFAULT_PROXY_CLIENT_MAX_BODY_BYTES,
    );

    assert.ok(
      survived < body.byteLength,
      "the default no longer truncates, so this regression guard is meaningless",
    );
  });

  test("15. the CONFIGURED limit passes the same body through intact", async () => {
    const body = await encodeSubmissionBody(MAX_RECEIPT_FILE_BYTES);
    const survived = await clonedByteLength(body, resolveLimit(configuredProxyLimit));

    assert.equal(
      survived,
      body.byteLength,
      "the Proxy still truncates a maximum-size receipt at the configured limit",
    );
  });

  test("16. a 1.5 MB receipt passes intact at the configured limit", async () => {
    const body = await encodeSubmissionBody(Math.floor(1.5 * 1024 * 1024));
    const survived = await clonedByteLength(body, resolveLimit(configuredProxyLimit));

    assert.equal(survived, body.byteLength);
  });
});

// ---------------------------------------------------------------------------
// The audit guard
// ---------------------------------------------------------------------------

/**
 * WHAT THIS SECTION ENFORCES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * The transport limits at the top of this file are APPLICATION-WIDE. They are derived
 * from the largest thing the application accepts, which only means anything if the set
 * of things that accept uploads is known. So the invariant is:
 *
 *   every source file that handles UPLOAD BYTES must be declared in
 *   DECLARED_UPLOAD_SURFACES, with a maximum that fits under the transport limits and
 *   with size-validation and operational-error tests named against it.
 *
 * IT DOES NOT FORBID NEW UPLOADS, and it does not forbid new endpoints. An earlier
 * version of this section failed whenever ANY route handler exported POST, PUT or PATCH.
 * That prohibited unrelated JSON endpoints, webhooks and ordinary API development, none
 * of which carries an upload — a rule about HTTP verbs standing in for a rule about
 * bytes. It was also easy to walk past, since `export function POST`,
 * `export const POST = …` and `export { handler as POST }` all evaded its regex.
 *
 * Detection is now CONTENT-based (see detectUploadSignals in ./upload-policy.ts), so the
 * export style of a handler is irrelevant: what a file does with the request body is
 * what decides whether it needs a policy.
 *
 * THE SCOPE IT WALKS is UPLOAD_AUDIT_ROOTS — app/, components/ and lib/receipts/ — with
 * isWithinUploadAuditScope deciding which files inside them are production source. An
 * earlier version walked only app/ and components/, which left the server-side half of
 * the receipt upload (lib/receipts/receipt-submissions.ts, the one module that hands
 * bytes to Storage) outside a rule that claimed to cover everything. Both the roots and
 * the file filter live in ./upload-policy.ts so this test uses the SAME rule it documents,
 * and section 6 below proves each half of that filter independently.
 */

/**
 * Every production source file inside an audited root.
 *
 * The filter is the exported one, not a copy: a test that decided its own scope could
 * quietly stop agreeing with the policy module about what "production source" means.
 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const full = join(ROOT, dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(join(dir, entry)));
    else if (isWithinUploadAuditScope(join(dir, entry))) out.push(join(dir, entry));
  }
  return out;
}

/** The audited files, read once. */
function auditedSources(): { path: string; source: string }[] {
  return UPLOAD_AUDIT_ROOTS.flatMap((dir) => listSourceFiles(dir)).map((path) => ({
    path,
    source: readFileSync(join(ROOT, path), "utf8"),
  }));
}

const DECLARED_PATHS = new Set(DECLARED_UPLOAD_SURFACES.map((surface) => surface.path));

/**
 * THE AUDIT RULE ITSELF: which of these files handle upload bytes without a declared
 * policy.
 *
 * A named function rather than an inline filter so the fixture tests below can run the
 * REAL rule over generated sources, instead of a copy of it that could drift.
 */
function undeclaredUploadSurfaces(
  files: readonly { path: string; source: string }[],
  declared: ReadonlySet<string> = DECLARED_PATHS,
): { path: string; signals: string[] }[] {
  return files
    .map((file) => ({ path: file.path, signals: detectUploadSignals(file.source) }))
    .filter((file) => file.signals.length > 0 && !declared.has(file.path));
}

describe("5. every upload surface declares a policy that fits the transport", () => {
  test("17. every file handling upload bytes is declared in the registry", () => {
    // The audit that keeps the numbers above meaningful. A new upload feature is welcome
    // here; it just has to say how big it is and be tested, instead of silently
    // inheriting a policy written for 10 MB receipt photographs.
    const undeclared = undeclaredUploadSurfaces(auditedSources());

    assert.deepEqual(
      undeclared,
      [],
      "these files handle upload bytes but declare no upload policy. Add each to " +
        "DECLARED_UPLOAD_SURFACES in lib/uploads/upload-policy.ts with its own maxBytes " +
        "and its size-validation and operational-error tests:\n" +
        undeclared.map((f) => `  ${f.path} — ${f.signals.join(", ")}`).join("\n"),
    );
  });

  test("18. the registry is not vacuous and every declared surface exists", () => {
    assert.ok(
      DECLARED_UPLOAD_SURFACES.length > 0,
      "no upload surface is declared, so test 17 would pass vacuously",
    );

    for (const surface of DECLARED_UPLOAD_SURFACES) {
      const source = readFileSync(join(ROOT, surface.path), "utf8");
      assert.ok(
        detectUploadSignals(source).length > 0,
        `${surface.path} is declared as an upload surface but handles no upload bytes; ` +
          "remove the stale declaration",
      );
      assert.ok(surface.purpose.length > 0, `${surface.path} declares no purpose`);
    }
  });

  test("19. every declared maximum fits under both transport limits", () => {
    // The ordering that makes the whole file work, applied per surface rather than to one
    // global number — so a future 25 MB upload cannot be declared without the transport
    // limits being raised to carry it.
    for (const surface of DECLARED_UPLOAD_SURFACES) {
      assert.ok(
        Number.isFinite(surface.maxBytes) && surface.maxBytes > 0,
        `${surface.path} declares a maximum that is not a positive, finite byte count`,
      );
      assert.ok(
        surface.maxBytes < SERVER_ACTION_BODY_SIZE_LIMIT_BYTES,
        `${surface.path} accepts ${surface.maxBytes} bytes, which the Server Action ` +
          `limit of ${SERVER_ACTION_BODY_SIZE_LIMIT_BYTES} would refuse`,
      );
      assert.ok(
        surface.maxBytes < PROXY_CLIENT_MAX_BODY_BYTES,
        `${surface.path} accepts ${surface.maxBytes} bytes, which the Proxy would truncate`,
      );
      assert.ok(
        surface.maxBytes <= MAX_UPLOADED_FILE_BYTES,
        `${surface.path} accepts more than MAX_UPLOADED_FILE_BYTES; raise that constant ` +
          "(and the transport limits derived from it) rather than exceeding it quietly",
      );
    }
  });

  test("20. every declared surface names real size and error tests that cover it", () => {
    for (const surface of DECLARED_UPLOAD_SURFACES) {
      const sizeTest = readFileSync(join(ROOT, surface.sizeValidationTest), "utf8");
      const errorTest = readFileSync(join(ROOT, surface.operationalErrorTest), "utf8");

      // Size coverage: the boundary itself is exercised, not merely mentioned.
      assert.ok(
        sizeTest.includes("MAX_RECEIPT_FILE_BYTES + 1") ||
          sizeTest.includes(`${surface.maxBytes + 1}`),
        `${surface.sizeValidationTest} does not exercise the byte above ` +
          `${surface.path}'s declared maximum`,
      );
      assert.ok(
        /\brefus|too-large\b/.test(sizeTest),
        `${surface.sizeValidationTest} never asserts an over-sized file is refused`,
      );

      // Operational coverage: the surface is named, and the file is about routing a
      // failure rather than a denial.
      assert.ok(
        errorTest.includes(surface.path),
        `${surface.operationalErrorTest} never references ${surface.path}`,
      );
      assert.ok(
        errorTest.includes("RECEIPT_TRANSPORT_ERROR"),
        `${surface.operationalErrorTest} does not cover the operational-failure message`,
      );
    }
  });

  test("21. the rule fires on uploads and stays quiet on ordinary endpoints", () => {
    // Generated fixtures, held in memory. This is the assertion that keeps the rule
    // honest in both directions: an earlier version of this section would have failed
    // the first two of these.
    const ALLOWED: [string, string][] = [
      [
        "an unrelated JSON POST route",
        `export async function POST(request: Request) {
           const body = await request.json();
           return Response.json({ ok: body.id });
         }`,
      ],
      [
        "an unrelated webhook route with a text body",
        `export const POST = async (request: Request) => {
           const raw = await request.text();
           return new Response(raw.length > 0 ? "ok" : "empty");
         };`,
      ],
      [
        "a PATCH handler updating a record",
        `export function PATCH(request: Request) {
           return Response.json({ patched: true });
         }`,
      ],
      [
        "a Server Action reading text out of a FormData",
        `export async function saveName(_prev: unknown, formData: FormData) {
           const name = formData.get("name");
           return typeof name === "string" ? name.trim() : "";
         }`,
      ],
      [
        "a file that only discusses uploads in comments",
        `// This module explains multipart/form-data and <input type="file"> uploads.
         /* It also mentions instanceof File and .arrayBuffer() in prose. */
         export const NOTE = "documentation only";`,
      ],
    ];

    for (const [label, source] of ALLOWED) {
      assert.deepEqual(
        detectUploadSignals(source),
        [],
        `${label} was mistaken for an upload surface`,
      );
      // And run the ACTUAL audit rule over it: adding this file to the application must
      // not fail the audit.
      assert.deepEqual(
        undeclaredUploadSurfaces([{ path: "app/api/example/route.ts", source }]),
        [],
        `adding ${label} would fail the upload audit`,
      );
    }

    const REFUSED: [string, string][] = [
      [
        "an undeclared multipart upload route (async function export)",
        `export async function POST(request: Request) {
           const form = await request.formData();
           const file = form.get("document");
           if (!(file instanceof File)) return new Response("no file", { status: 400 });
           return new Response("stored");
         }`,
      ],
      [
        "an undeclared upload route (const arrow export — the old rule missed this)",
        `export const PUT = async (request: Request) => {
           const bytes = new Uint8Array(await request.arrayBuffer());
           return Response.json({ size: bytes.byteLength });
         };`,
      ],
      [
        "an undeclared upload route (re-exported handler — the old rule missed this too)",
        `const handler = async (request: Request) => {
           const body = await request.arrayBuffer();
           return new Response(String(body.byteLength));
         };
         export { handler as POST };`,
      ],
      [
        "a second file input in a component",
        `export function AvatarPicker() {
           return <input type="file" name="avatar" accept="image/*" />;
         }`,
      ],
      [
        "a component pushing bytes at Storage",
        `export async function putLogo(client: Client, bytes: Uint8Array) {
           return client.storage.from("logos").upload("a/b.png", bytes);
         }`,
      ],
    ];

    for (const [label, source] of REFUSED) {
      assert.ok(
        detectUploadSignals(source).length > 0,
        `${label} slipped past the upload-surface detector`,
      );
      // And the ACTUAL audit rule refuses it while it is undeclared.
      assert.equal(
        undeclaredUploadSurfaces([{ path: "app/(admin)/branding/logo-form.tsx", source }])
          .length,
        1,
        `${label} would be allowed into the application with no upload policy`,
      );
    }
  });

  test("22. the same upload passes once it is declared with a bounded policy", () => {
    // Requirement, not a hypothetical: a future avatar upload capped well under the
    // receipt maximum must be able to exist. The rule asks for a declaration and tests,
    // not for the feature to be abandoned.
    const path = "app/(admin)/branding/logo-form.tsx";
    const source = `export function LogoPicker() {
      return <input type="file" name="logo" accept="image/png" />;
    }`;

    // Undeclared: refused.
    assert.equal(undeclaredUploadSurfaces([{ path, source }]).length, 1);

    // Declared: accepted by the SAME rule, driven with an extended declaration set rather
    // than a re-implementation of the filter that could drift from it.
    const declared = new Set([...DECLARED_PATHS, path]);
    assert.deepEqual(undeclaredUploadSurfaces([{ path, source }], declared), []);

    // And its declared maximum has to fit the transport, like every other surface.
    const proposedMaxBytes = 1024 * 1024;
    assert.ok(Number.isFinite(proposedMaxBytes) && proposedMaxBytes > 0);
    assert.ok(proposedMaxBytes < SERVER_ACTION_BODY_SIZE_LIMIT_BYTES);
    assert.ok(proposedMaxBytes < PROXY_CLIENT_MAX_BODY_BYTES);
    assert.ok(proposedMaxBytes <= MAX_UPLOADED_FILE_BYTES);
  });
});

// ---------------------------------------------------------------------------
// The scope the audit walks
// ---------------------------------------------------------------------------

/**
 * WHY THIS SECTION EXISTS.
 *
 * An audit is only as good as the set of files it reads, and the previous scope —
 * app/ and components/ — did not include the module that actually performs the receipt
 * upload. lib/receipts/receipt-submissions.ts is the one place in the web application
 * that hands bytes to Supabase Storage, and it sat outside a rule whose stated invariant
 * was "every file handling upload bytes is declared".
 *
 * Widening the walk is only safe if it stays narrow. The two failure modes are opposite
 * and both fatal to the rule's usefulness: too narrow and a real upload hides; too wide
 * and the audit flags its own test fixtures until someone deletes it. Each direction is
 * asserted below, against real repository files where one exists and against generated
 * sources where proving the rule needs a file this repository does not have.
 */
const RECEIPT_SUBMISSIONS_PATH = "lib/receipts/receipt-submissions.ts";

describe("6. the audit's scope is wide enough to matter and narrow enough to keep", () => {
  test("23. the server-side half of the receipt upload is covered and declared", () => {
    const audited = auditedSources();
    const submissions = audited.find((file) => file.path === RECEIPT_SUBMISSIONS_PATH);

    // In scope: the walk reaches it at all.
    assert.ok(
      submissions !== undefined,
      `${RECEIPT_SUBMISSIONS_PATH} is not inside UPLOAD_AUDIT_ROOTS, so the audit cannot ` +
        "see the module that uploads receipt bytes",
    );

    // Non-vacuous: it really does carry upload signals, so being declared is doing work.
    const signals = detectUploadSignals(submissions.source);
    assert.ok(
      signals.length > 0,
      `${RECEIPT_SUBMISSIONS_PATH} no longer looks like an upload surface; if the Storage ` +
        "call moved, follow it — do not drop the declaration",
    );

    // Declared, and therefore not reported by the audit.
    assert.ok(
      DECLARED_PATHS.has(RECEIPT_SUBMISSIONS_PATH),
      `${RECEIPT_SUBMISSIONS_PATH} handles upload bytes but declares no policy`,
    );

    // And it WOULD be reported if the declaration were removed — which is what makes the
    // assertion above meaningful rather than a restatement of the registry.
    const withoutIt = new Set(
      [...DECLARED_PATHS].filter((path) => path !== RECEIPT_SUBMISSIONS_PATH),
    );
    assert.deepEqual(
      undeclaredUploadSurfaces([submissions], withoutIt).map((file) => file.path),
      [RECEIPT_SUBMISSIONS_PATH],
    );
  });

  test("24. a NEW production upload helper under lib/receipts is caught", () => {
    // The gap this scope change closes, stated as the case that used to escape: an upload
    // written as a server-side lib module rather than as a page or a component.
    const helper = {
      path: "lib/receipts/receipt-attachment-uploads.ts",
      source: `export async function storeAttachment(client: Client, bytes: Uint8Array) {
        return client.storage.from("attachments").upload("a/b.bin", bytes);
      }`,
    };

    assert.ok(
      isWithinUploadAuditScope(helper.path),
      "a new lib/receipts module would not even be read by the audit",
    );
    assert.ok(detectUploadSignals(helper.source).length > 0);
    assert.deepEqual(
      undeclaredUploadSurfaces([helper]).map((file) => file.path),
      [helper.path],
      "an undeclared server-side upload helper would be allowed in with no policy",
    );
  });

  test("25. test files are ignored even when they are full of upload fixtures", () => {
    // A test that builds a 10 MiB multipart body is doing its job. Demanding an upload
    // policy for a fixture is how a rule earns its deletion.
    const fixture = {
      path: "lib/receipts/receipt-attachment-uploads.test.ts",
      source: `const form = new FormData();
        form.append("f", new Blob([new Uint8Array(16)]), "x.bin");
        const body = await new Request("http://x", { method: "POST", body: form }).arrayBuffer();
        const part = form.get("f");
        if (part instanceof File) { await part.arrayBuffer(); }`,
    };

    // Non-vacuous: this source is dense with signals. Only the scope filter spares it.
    assert.ok(
      detectUploadSignals(fixture.source).length >= 3,
      "the fixture carries no signals, so excluding it proves nothing",
    );
    assert.equal(isWithinUploadAuditScope(fixture.path), false);
    assert.equal(isAuditableUploadSourceFile(fixture.path), false);

    // And it never appears in the real walk.
    assert.ok(!auditedSources().some((file) => /\.test\.tsx?$/.test(file.path)));

    // The same is true of a REAL test file in this repository that trips a signal, so the
    // exclusion is not merely a rule about a hypothetical name.
    const realFixtureTest = "lib/ui/design-system.test.ts";
    assert.ok(
      detectUploadSignals(readFileSync(join(ROOT, realFixtureTest), "utf8")).length > 0,
      `${realFixtureTest} no longer trips a signal; pick another real example`,
    );
    assert.equal(isWithinUploadAuditScope(realFixtureTest), false);
  });

  test("26. unrelated library code stays outside the audit entirely", () => {
    // The reason `lib` was not added wholesale. Each of these is either unrelated to
    // uploads or is the policy module itself, whose signal TABLE contains the very strings
    // it searches for — as data, not as comments, so comment-stripping cannot spare it.
    for (const path of [
      "lib/uploads/upload-policy.ts",
      "lib/uploads/upload-request-boundary.test.ts",
      "lib/ui/design-system.ts",
      "lib/staff/retailer-staff-access.ts",
      "lib/supabase/admin.ts",
    ]) {
      assert.equal(
        isWithinUploadAuditScope(path),
        false,
        `${path} was pulled into the upload audit; the scope is meant to stay narrow`,
      );
    }

    // Stated as a property rather than a list: nothing outside the declared roots is read.
    for (const file of auditedSources()) {
      assert.ok(
        UPLOAD_AUDIT_ROOTS.some(
          (root) => file.path === root || file.path.startsWith(`${root}/`),
        ),
        `${file.path} is outside UPLOAD_AUDIT_ROOTS`,
      );
    }
  });

  test("27. the file filter excludes declarations, generated output and scaffolding", () => {
    for (const path of [
      "lib/receipts/receipt-types.d.ts",
      "lib/receipts/receipt-schema.generated.ts",
      "lib/receipts/__tests__/upload-helper.ts",
      "lib/receipts/__fixtures__/big-receipt.ts",
      "lib/receipts/__mocks__/storage.ts",
      "lib/receipts/notes.md",
    ]) {
      assert.equal(isAuditableUploadSourceFile(path), false, path);
    }

    // And keeps ordinary production source, including a plainly-named `fixtures` folder —
    // an exclusion wide enough to hide an upload behind a directory name would be worse
    // than the gap it closed.
    for (const path of [
      RECEIPT_SUBMISSIONS_PATH,
      "app/(retailer)/retailer/receipts/submit-receipt-form.tsx",
      "lib/receipts/fixtures/receipt-uploader.ts",
    ]) {
      assert.equal(isAuditableUploadSourceFile(path), true, path);
    }
  });

  test("28. all three receipt surfaces share ONE size policy, still bounded", () => {
    // The requirement that the widened scope must not quietly introduce a second receipt
    // limit: the client form, the Server Action and the server-side uploader are three
    // files participating in one policy, not three policies.
    const receiptSurfaces = DECLARED_UPLOAD_SURFACES.filter((surface) =>
      surface.path.includes("receipt"),
    );
    assert.equal(receiptSurfaces.length, 3);
    assert.ok(receiptSurfaces.some((surface) => surface.path === RECEIPT_SUBMISSIONS_PATH));

    for (const surface of receiptSurfaces) {
      assert.equal(
        surface.maxBytes,
        MAX_RECEIPT_FILE_BYTES,
        `${surface.path} declares its own receipt maximum instead of the shared one`,
      );
      assert.ok(surface.maxBytes < SERVER_ACTION_BODY_SIZE_LIMIT_BYTES);
      assert.ok(surface.maxBytes < PROXY_CLIENT_MAX_BODY_BYTES);
    }

    // One distinct number across the whole registry today, and 10 MiB is what it is.
    assert.deepEqual(
      [...new Set(DECLARED_UPLOAD_SURFACES.map((surface) => surface.maxBytes))],
      [10485760],
    );
  });
});
