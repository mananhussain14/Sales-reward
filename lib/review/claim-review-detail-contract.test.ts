/**
 * Tests for Claim Reviewer receipt DETAIL, private image streaming and DECISIONS —
 * Phase 1C-C.
 *
 * Run with:  npm test
 *
 * Two kinds, matching claim-review-queue-contract.test.ts:
 *
 *   1. REAL UNIT TESTS of lib/review/claim-review-decision-input.ts, a pure module
 *      with no imports and no I/O. Every decision, reason and note rule is exercised
 *      by calling the validator, not by reading its source.
 *
 *   2. SOURCE-SCANNING CONTRACT TESTS of the adapters, the Route Handler, the page
 *      and the components. Those are Server Components, `server-only` modules and a
 *      `"use server"` file: they import `next/headers` transitively and throw
 *      outside a request, so they cannot be invoked here. What they must NOT do is
 *      still checkable, and for this milestone that is the more valuable half — the
 *      single most important property in Phase 1C-C is an ORDERING (authorize as the
 *      reviewer, only then reach for service role) and an EXCLUSION (no other file
 *      touches service role at all).
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY SOURCE RULE. These files explain at length the
 * identifiers the rules forbid — "createSignedUrl", "storage_object_path",
 * "service_role" — so an unstripped scan would fail on the prose documenting the
 * rule rather than on a violation.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CLAIM_REVIEW_DECISIONS,
  CLAIM_REVIEW_NOTE_MAX_LENGTH,
  CLAIM_REVIEW_REJECTION_REASONS,
  isClaimReviewDecision,
  isRejectionReason,
  reasonRequiresNote,
  REASONS_REQUIRING_NOTE,
  REJECTION_REASON_LABELS,
  validateDecisionInput,
} from "./claim-review-decision-input.ts";
import { isReceiptSubmissionId } from "./claim-review-queue-filters.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DETAIL_DIR = join(ROOT, "app", "(review)", "review", "[receiptSubmissionId]");

const DETAIL_ADAPTER = join(ROOT, "lib", "review", "claim-review-detail.ts");
const DECISION_ADAPTER = join(ROOT, "lib", "review", "claim-review-decision.ts");
const DECISION_INPUT = join(ROOT, "lib", "review", "claim-review-decision-input.ts");
const OBJECT_HELPER = join(ROOT, "lib", "review", "claim-review-receipt-object.ts");
const DETAIL_PAGE = join(DETAIL_DIR, "page.tsx");
const DETAIL_LOADING = join(DETAIL_DIR, "loading.tsx");
const IMAGE_ROUTE = join(DETAIL_DIR, "image", "route.ts");
const DECISION_FORM = join(DETAIL_DIR, "decision-form.tsx");
const DECISION_STATE = join(DETAIL_DIR, "decision-action-state.ts");
const RECEIPT_IMAGE = join(DETAIL_DIR, "receipt-image.tsx");
const ACTIONS = join(DETAIL_DIR, "actions.ts");
const QUEUE_PAGE = join(ROOT, "app", "(review)", "review", "page.tsx");
const SHELL = join(ROOT, "components", "review", "review-shell.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}
function codeOf(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/** Every file this milestone added or changed. */
const PHASE_1C_C_FILES = [
  DETAIL_ADAPTER,
  DECISION_ADAPTER,
  DECISION_INPUT,
  OBJECT_HELPER,
  DETAIL_PAGE,
  DETAIL_LOADING,
  IMAGE_ROUTE,
  DECISION_FORM,
  DECISION_STATE,
  RECEIPT_IMAGE,
  ACTIONS,
];

/** The ONLY two files permitted to touch a service-role client. */
const SERVICE_ROLE_ALLOWED = [OBJECT_HELPER];

const UUID = "11111111-2222-4333-8444-555555555555";

// ============================================================================
describe("1. the detail route exists and the queue links to it", () => {
  test("1.1 the detail route file exists", () => {
    assert.ok(existsSync(DETAIL_PAGE), "detail page must exist");
    assert.ok(existsSync(DETAIL_LOADING), "detail loading state must exist");
  });

  test("1.2 the queue action is a real link to the detail route", () => {
    const page = codeOf(QUEUE_PAGE);
    assert.match(page, /href=\{`\/review\/\$\{row\.receiptSubmissionId\}`\}/);
  });

  test("1.3 the Soon badge and the disabled action are gone", () => {
    const page = codeOf(QUEUE_PAGE);
    assert.ok(!/Soon/.test(page), "no Soon badge may remain");
    assert.ok(
      !/aria-disabled="true"/.test(page),
      "the open action must no longer be disabled",
    );
  });

  test("1.4 the link has a specific accessible name, not just 'Review receipt'", () => {
    const page = codeOf(QUEUE_PAGE);
    assert.match(page, /aria-label=\{`Review receipt from \$\{row\.retailerName\}/);
  });

  test("1.5 the link carries the receipt id ALONE — no return URL, no filters", () => {
    const page = codeOf(QUEUE_PAGE);
    const m = page.match(/href=\{`\/review\/\$\{row\.receiptSubmissionId\}`\}/);
    assert.ok(m, "href must be exactly the receipt path");
    // No caller-supplied destination anywhere in the flow.
    assert.ok(
      !/[?&](returnTo|redirect|next|from)=/.test(page),
      "no return-URL parameter may exist",
    );
  });

  test("1.6 nav stays active on the nested detail route", () => {
    const shell = codeOf(SHELL);
    assert.match(shell, /pathname\.startsWith\(`\$\{href\}\/`\)/);
  });

  test("1.7 Back to queue goes to the bare queue path", () => {
    assert.match(codeOf(DETAIL_PAGE), /href="\/review"/);
    assert.match(codeOf(DECISION_FORM), /href="\/review"/);
  });
});

// ============================================================================
describe("2. the detail adapter reads one RPC as the ordinary reviewer", () => {
  const src = codeOf(DETAIL_ADAPTER);

  test("2.1 it is server-only", () => {
    assert.match(src, /^import "server-only";/m);
  });

  test("2.2 it calls exactly get_claim_review_detail and nothing else", () => {
    const rpcs = [...src.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)], ["get_claim_review_detail"]);
  });

  test("2.3 it uses the ordinary authenticated server client", () => {
    assert.match(src, /from "@\/lib\/supabase\/server"/);
    assert.ok(!/supabase\/admin/.test(src), "no admin client for metadata");
    assert.ok(!/service_role|SERVICE_ROLE/.test(src));
  });

  test("2.4 it passes ONLY the submission id — no vendor, reviewer or member", () => {
    const call = src.match(/\.rpc\("get_claim_review_detail",\s*\{([^}]*)\}/);
    assert.ok(call, "the rpc call must be findable");
    const args = call[1];
    assert.match(args, /p_submission_id/);
    assert.ok(
      !/vendor|reviewer|member|role|actor|organization/i.test(args),
      "no identity argument may be sent",
    );
  });

  test("2.5 no direct table query", () => {
    assert.ok(!/\.from\("/.test(src), "no direct table access");
  });

  test("2.6 missing, foreign and unauthorized collapse into one result", () => {
    // Zero rows -> not-found, with no branch that distinguishes the reasons.
    assert.match(src, /rows\.length === 0[\s\S]{0,120}status: "not-found"/);
    // Only RETURN statements are counted. The result type also declares
    // `| { status: "not-found" }`, which is the shape, not a branch.
    const returns = [...src.matchAll(/return \{ status: "not-found" \};/g)];
    assert.equal(
      returns.length,
      1,
      "exactly one not-found return, so the reasons cannot diverge",
    );
  });

  test("2.7 raw provider errors are never bound, logged or returned", () => {
    assert.ok(!/error\.(message|details|hint|code)/.test(src));
    const logs = [...src.matchAll(/console\.(error|warn|log)\(([^)]*)\)/g)];
    assert.ok(logs.length > 0, "failures are logged");
    for (const [, , arg] of logs) {
      assert.match(arg.trim(), /^"[^"]*"$/, "only fixed strings may be logged");
    }
  });

  test("2.8 rows are mapped field by field, never spread", () => {
    assert.ok(!/\.\.\.row/.test(src), "a spread would admit new columns silently");
    assert.match(src, /function toDetail\(row: DetailRpcRow\)/);
  });

  test("2.9 no bucket, path, hash, email or phone in the browser-safe type", () => {
    const typeBlock = src.match(/export type ClaimReviewDetail = \{[\s\S]*?\n\};/);
    assert.ok(typeBlock, "the detail type must be findable");
    for (const forbidden of [
      "storage_bucket",
      "storageBucket",
      "storage_object_path",
      "objectPath",
      "file_sha256",
      "fileSha256",
      "email",
      "phone",
      "profileId",
      "membershipId",
      "vendorId",
      "organizationId",
      "retailerOrganizationId",
      "shopId",
      "authUserId",
      "roleId",
    ]) {
      assert.ok(
        !typeBlock[0].includes(forbidden),
        `${forbidden} must not be a detail field`,
      );
    }
  });

  test("2.10 no transaction or reward field is carried", () => {
    const typeBlock = src.match(/export type ClaimReviewDetail = \{[\s\S]*?\n\};/);
    for (const forbidden of [
      "amount",
      "currency",
      "merchant",
      "saleDate",
      "product",
      "campaign",
      "reward",
      "coin",
      "balance",
      "payout",
    ]) {
      assert.ok(
        !new RegExp(forbidden, "i").test(typeBlock![0]),
        `${forbidden} must not be a detail field`,
      );
    }
  });

  test("2.11 the cache is request-scoped React cache, not a global one", () => {
    assert.match(src, /import \{ cache \} from "react"/);
    assert.ok(!/unstable_cache|revalidate:|force-cache/.test(src));
  });

  test("2.12 a half-populated decision is not treated as final", () => {
    assert.match(src, /decision !== null && decidedAt !== null/);
  });
});

// ============================================================================
describe("3. the image route authorizes before it ever reaches service role", () => {
  const src = codeOf(IMAGE_ROUTE);

  test("3.1 the route exists at the approved path", () => {
    assert.ok(existsSync(IMAGE_ROUTE));
    assert.match(src, /export async function GET/);
  });

  test("3.2 THE ORDERING: authenticated detail check precedes the service-role read", () => {
    const authorizeAt = src.indexOf("getClaimReviewDetail(");
    const serviceAt = src.indexOf("readClaimReviewReceiptImage(");
    assert.ok(authorizeAt > 0, "it must authorize via the ordinary detail RPC");
    assert.ok(serviceAt > 0, "it must read bytes via the service-role helper");
    assert.ok(
      authorizeAt < serviceAt,
      "reviewer authorization MUST come first — this ordering is the whole boundary",
    );
  });

  test("3.3 every non-authorized detail status returns before the byte read", () => {
    const serviceAt = src.indexOf("readClaimReviewReceiptImage(");
    const before = src.slice(0, serviceAt);
    for (const status of ["unauthenticated", "not-found", "unavailable"]) {
      assert.ok(
        before.includes(`detail.status === "${status}"`),
        `${status} must be handled before any service-role call`,
      );
    }
  });

  test("3.4 the id shape is validated before anything else", () => {
    const validateAt = src.indexOf("isReceiptSubmissionId(");
    const authorizeAt = src.indexOf("getClaimReviewDetail(");
    assert.ok(validateAt > 0 && validateAt < authorizeAt);
  });

  test("3.5 nothing is accepted from the browser but the id", () => {
    assert.ok(
      !/searchParams|request\.url|headers\(\)\.get|\.json\(\)|formData\(\)/.test(src),
      "no browser-supplied bucket, path, mime, filename or vendor",
    );
  });

  test("3.6 no signed URL and no redirect to storage", () => {
    assert.ok(!/createSignedUrl|getPublicUrl|signedUrl/.test(src));
    assert.ok(!/NextResponse\.redirect|Response\.redirect/.test(src));
  });

  test("3.7 private, no-store cache headers on EVERY response", () => {
    const responses = [...src.matchAll(/new NextResponse\([\s\S]*?\}\s*,?\s*\)/g)];
    assert.ok(responses.length >= 4, "every outcome constructs a response");
    for (const [body] of responses) {
      assert.match(
        body,
        /"Cache-Control": "private, no-store, max-age=0"/,
        "no response may be cacheable",
      );
      assert.match(body, /"X-Content-Type-Options": "nosniff"/);
    }
  });

  test("3.8 the served content type is the stored one, never a browser value", () => {
    assert.match(src, /"Content-Type": image\.image\.contentType/);
  });

  test("3.9 the filename is never reflected into a header", () => {
    assert.match(src, /"Content-Disposition": "inline"/);
    assert.ok(
      !/originalFileName|original_file_name|filename=/.test(src),
      "a stored filename must not reach a response header",
    );
  });

  test("3.10 refusals are indistinguishable and carry no body", () => {
    assert.match(src, /function notFound\(\): NextResponse/);
    assert.match(src, /new NextResponse\(null, \{\s*status: 404/);
    // missing and unsupported both collapse into the same 404.
    assert.match(
      src,
      /image\.status === "missing" \|\| image\.status === "unsupported"[\s\S]{0,200}return notFound\(\)/,
    );
  });

  test("3.11 no storage error, path or bucket reaches the response", () => {
    assert.ok(!/storage_object_path|storage_bucket|\.bucket\b/.test(src));
    assert.ok(!/error\.(message|details|hint)/.test(src));
  });
});

// ============================================================================
describe("4. the service-role boundary", () => {
  test("4.1 only the approved helper imports a service-role client", () => {
    for (const file of PHASE_1C_C_FILES) {
      const src = codeOf(file);
      const uses = /supabase\/admin|createAdminClient|SERVICE_ROLE_KEY/.test(src);
      if (SERVICE_ROLE_ALLOWED.includes(file)) {
        assert.ok(uses, `${file} is the approved service-role path and must use it`);
      } else {
        assert.ok(
          !uses,
          `${file} must NOT touch a service-role client`,
        );
      }
    }
  });

  test("4.2 the helper is server-only and cannot be imported by a client component", () => {
    const src = codeOf(OBJECT_HELPER);
    assert.match(src, /^import "server-only";/m);
    assert.ok(!/"use client"/.test(src));
  });

  test("4.3 no client component imports the helper or the route", () => {
    for (const file of [DECISION_FORM, RECEIPT_IMAGE]) {
      const src = codeOf(file);
      assert.match(src, /"use client"/);
      assert.ok(!/claim-review-receipt-object|image\/route/.test(src));
    }
  });

  test("4.4 the helper calls only the object-reference RPC and storage download", () => {
    const src = codeOf(OBJECT_HELPER);
    const rpcs = [...src.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)], ["get_claim_review_object_reference"]);
    assert.match(src, /\.storage\.from\(bucket\)\.download\(path\)/);
  });

  test("4.5 the helper never creates a signed or public URL", () => {
    const src = codeOf(OBJECT_HELPER);
    assert.ok(!/createSignedUrl|getPublicUrl|createSignedUrls/.test(src));
    assert.ok(!/updateBucket|createBucket|public: true/.test(src));
  });

  test("4.6 the helper never returns bucket, path or key", () => {
    const src = codeOf(OBJECT_HELPER);
    const resultType = src.match(/export type ReceiptImageResult =[\s\S]*?;\n/);
    assert.ok(resultType);
    assert.ok(!/bucket|path|key/i.test(resultType[0]));
    const bytesType = src.match(/export type ReceiptImageBytes = \{[\s\S]*?\};/);
    assert.ok(!/bucket|path/i.test(bytesType![0]));
  });

  test("4.7 the key is never logged, rendered or interpolated", () => {
    for (const file of PHASE_1C_C_FILES) {
      const src = codeOf(file);
      assert.ok(!/SUPABASE_SERVICE_ROLE_KEY/.test(src));
      assert.ok(!/serviceRoleKey/.test(src));
    }
  });

  test("4.8 only fixed strings are logged in the helper", () => {
    const src = codeOf(OBJECT_HELPER);
    const logs = [...src.matchAll(/console\.(error|warn|log)\(([^)]*)\)/g)];
    assert.ok(logs.length > 0);
    for (const [, , arg] of logs) {
      assert.match(arg.trim(), /^"[^"]*"$/);
    }
  });

  test("4.9 the image route is the helper's only caller", () => {
    const callers: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (read(p).includes("claim-review-receipt-object")) callers.push(p);
        }
      }
    }
    for (const d of ["app", "lib", "components"]) walk(join(ROOT, d));
    assert.deepEqual(
      callers.filter((c) => c !== OBJECT_HELPER).sort(),
      [IMAGE_ROUTE],
      "only the image Route Handler may import the service-role helper",
    );
  });

  test("4.10 stored MIME is validated against the upload allow-list", () => {
    const src = codeOf(OBJECT_HELPER);
    assert.match(src, /RECEIPT_IMAGE_MIME_TYPES = \[\s*"image\/jpeg",\s*"image\/png",\s*"image\/webp",?\s*\]/);
    assert.match(src, /if \(!isReceiptImageMimeType\(mimeType\)\)/);
    // and BEFORE the download, so a bad object is never even read.
    assert.ok(
      src.indexOf("isReceiptImageMimeType(mimeType)") <
        src.indexOf(".download(path)"),
    );
  });

  test("4.11 the read is size-bounded", () => {
    const src = codeOf(OBJECT_HELPER);
    assert.match(src, /RECEIPT_IMAGE_MAX_BYTES/);
    assert.match(src, /blob\.size > RECEIPT_IMAGE_MAX_BYTES/);
  });
});

// ============================================================================
describe("5. decision input validation (real unit tests)", () => {
  const ok = (r: ReturnType<typeof validateDecisionInput>) => {
    assert.ok(r.ok, `expected valid, got ${JSON.stringify(r)}`);
    return r.ok ? r.value : null!;
  };
  const bad = (r: ReturnType<typeof validateDecisionInput>) => {
    assert.ok(!r.ok, "expected invalid");
    return r.ok ? null! : r.fieldErrors;
  };

  test("5.1 VERIFIED with no reason and no note is accepted", () => {
    const v = ok(validateDecisionInput({ decision: "VERIFIED" }));
    assert.deepEqual(v, {
      decision: "VERIFIED",
      rejectionReason: null,
      reviewerNote: null,
    });
  });

  test("5.2 VERIFIED with an optional note is accepted", () => {
    const v = ok(
      validateDecisionInput({ decision: "VERIFIED", reviewerNote: "  legible  " }),
    );
    assert.equal(v.reviewerNote, "legible");
  });

  test("5.3 VERIFIED forbids a rejection reason", () => {
    const e = bad(
      validateDecisionInput({
        decision: "VERIFIED",
        rejectionReason: "UNREADABLE_RECEIPT",
      }),
    );
    assert.match(e.rejectionReason!, /cannot carry a rejection reason/);
  });

  test("5.4 REJECTED with a note-optional reason is accepted", () => {
    const v = ok(
      validateDecisionInput({
        decision: "REJECTED",
        rejectionReason: "UNREADABLE_RECEIPT",
      }),
    );
    assert.equal(v.rejectionReason, "UNREADABLE_RECEIPT");
    assert.equal(v.reviewerNote, null);
  });

  test("5.5 REJECTED requires a rejection reason", () => {
    const e = bad(validateDecisionInput({ decision: "REJECTED" }));
    assert.match(e.rejectionReason!, /Choose a reason/);
  });

  test("5.6 an unknown decision is refused", () => {
    for (const d of ["APPROVED", "verified", "", "PENDING", "DELETED", null, 7]) {
      const e = bad(validateDecisionInput({ decision: d }));
      assert.ok(e.decision, `${String(d)} must be refused`);
    }
  });

  test("5.7 exactly two decisions exist", () => {
    assert.deepEqual([...CLAIM_REVIEW_DECISIONS], ["VERIFIED", "REJECTED"]);
    assert.ok(isClaimReviewDecision("VERIFIED"));
    assert.ok(isClaimReviewDecision("REJECTED"));
    assert.ok(!isClaimReviewDecision("APPROVED"));
  });

  test("5.8 exactly five rejection reasons exist, and each has a label", () => {
    assert.deepEqual(
      [...CLAIM_REVIEW_REJECTION_REASONS],
      [
        "UNREADABLE_RECEIPT",
        "MISSING_REQUIRED_INFORMATION",
        "INVALID_RECEIPT",
        "DUPLICATE_RECEIPT",
        "OTHER",
      ],
    );
    for (const r of CLAIM_REVIEW_REJECTION_REASONS) {
      assert.ok(REJECTION_REASON_LABELS[r]?.length > 0);
    }
  });

  test("5.9 an unknown rejection reason is refused", () => {
    for (const r of ["FRAUD", "unreadable_receipt", "SOMETHING", "NONE"]) {
      const e = bad(
        validateDecisionInput({ decision: "REJECTED", rejectionReason: r }),
      );
      assert.match(e.rejectionReason!, /not recognised/);
    }
  });

  test("5.10 the note is trimmed", () => {
    const v = ok(
      validateDecisionInput({
        decision: "REJECTED",
        rejectionReason: "OTHER",
        reviewerNote: "   duplicate of an earlier claim   ",
      }),
    );
    assert.equal(v.reviewerNote, "duplicate of an earlier claim");
  });

  test("5.11 a whitespace-only note is absent, not empty string", () => {
    const v = ok(
      validateDecisionInput({ decision: "VERIFIED", reviewerNote: "     \n\t " }),
    );
    assert.equal(v.reviewerNote, null);
  });

  test("5.12 a note over 500 characters is refused, exactly 500 accepted", () => {
    const at = "x".repeat(CLAIM_REVIEW_NOTE_MAX_LENGTH);
    const over = "x".repeat(CLAIM_REVIEW_NOTE_MAX_LENGTH + 1);
    assert.ok(validateDecisionInput({ decision: "VERIFIED", reviewerNote: at }).ok);
    const e = bad(validateDecisionInput({ decision: "VERIFIED", reviewerNote: over }));
    assert.match(e.reviewerNote!, /at most 500 characters/);
  });

  test("5.13 length is measured AFTER trimming, matching the RPC's btrim", () => {
    const padded = `  ${"x".repeat(CLAIM_REVIEW_NOTE_MAX_LENGTH)}  `;
    assert.ok(
      validateDecisionInput({ decision: "VERIFIED", reviewerNote: padded }).ok,
    );
  });

  test("5.14 INVALID_RECEIPT, DUPLICATE_RECEIPT and OTHER require a note", () => {
    for (const reason of ["INVALID_RECEIPT", "DUPLICATE_RECEIPT", "OTHER"]) {
      const e = bad(
        validateDecisionInput({ decision: "REJECTED", rejectionReason: reason }),
      );
      assert.match(e.reviewerNote!, /note is required/);
      // and a whitespace-only note does not satisfy it
      const e2 = bad(
        validateDecisionInput({
          decision: "REJECTED",
          rejectionReason: reason,
          reviewerNote: "    ",
        }),
      );
      assert.match(e2.reviewerNote!, /note is required/);
      // with a real note it passes
      assert.ok(
        validateDecisionInput({
          decision: "REJECTED",
          rejectionReason: reason,
          reviewerNote: "because",
        }).ok,
      );
    }
    assert.deepEqual(
      [...REASONS_REQUIRING_NOTE],
      ["INVALID_RECEIPT", "DUPLICATE_RECEIPT", "OTHER"],
    );
  });

  test("5.15 UNREADABLE_RECEIPT and MISSING_REQUIRED_INFORMATION do not", () => {
    for (const reason of [
      "UNREADABLE_RECEIPT",
      "MISSING_REQUIRED_INFORMATION",
    ] as const) {
      assert.ok(
        validateDecisionInput({ decision: "REJECTED", rejectionReason: reason }).ok,
      );
      assert.ok(!reasonRequiresNote(reason));
    }
  });

  test("5.16 every field error is reported at once, not one at a time", () => {
    const e = bad(
      validateDecisionInput({
        decision: "REJECTED",
        rejectionReason: "OTHER",
        reviewerNote: "y".repeat(600),
      }),
    );
    assert.ok(e.reviewerNote, "the length problem is reported");
  });

  test("5.17 non-string inputs never coerce into a match", () => {
    for (const junk of [["VERIFIED"], { toString: () => "VERIFIED" }, 1, true]) {
      assert.ok(!validateDecisionInput({ decision: junk }).ok);
    }
  });

  test("5.18 isRejectionReason and reasonRequiresNote agree with the tables", () => {
    assert.ok(isRejectionReason("OTHER"));
    assert.ok(!isRejectionReason("OTHERS"));
    assert.ok(reasonRequiresNote("OTHER"));
    assert.ok(!reasonRequiresNote(null));
  });
});

// ============================================================================
describe("6. receipt id validation", () => {
  test("6.1 well-formed ids pass", () => {
    assert.ok(isReceiptSubmissionId(UUID));
    assert.ok(isReceiptSubmissionId(UUID.toUpperCase()));
  });

  test("6.2 malformed ids are refused", () => {
    for (const bad of [
      "",
      "abc",
      "1111",
      `${UUID}x`,
      `${UUID} `,
      "../../etc/passwd",
      "11111111-2222-4333-8444-55555555555",
      null,
      undefined,
      123,
      ["x"],
    ]) {
      assert.ok(!isReceiptSubmissionId(bad), `${String(bad)} must be refused`);
    }
  });

  test("6.3 both the page and the route validate before any RPC", () => {
    for (const file of [DETAIL_PAGE, IMAGE_ROUTE, ACTIONS]) {
      const src = codeOf(file);
      assert.match(src, /isReceiptSubmissionId\(/, `${file} must validate the id`);
    }
    const page = codeOf(DETAIL_PAGE);
    assert.ok(
      page.indexOf("isReceiptSubmissionId(") < page.indexOf("getClaimReviewDetail("),
    );
  });
});

// ============================================================================
describe("7. the Server Action sends only approved values", () => {
  const src = codeOf(ACTIONS);

  test("7.1 it is a server action", () => {
    assert.match(src, /^"use server";/m);
  });

  test("7.2 it calls only the decision adapter, which calls only decide_claim_receipt", () => {
    assert.match(src, /submitClaimReviewDecision\(/);
    const adapter = codeOf(DECISION_ADAPTER);
    const rpcs = [...adapter.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)], ["decide_claim_receipt"]);
  });

  test("7.3 the adapter uses the ordinary authenticated client", () => {
    const adapter = codeOf(DECISION_ADAPTER);
    assert.match(adapter, /from "@\/lib\/supabase\/server"/);
    assert.ok(!/supabase\/admin|createAdminClient/.test(adapter));
  });

  test("7.4 exactly four RPC parameters, none of them an identity", () => {
    const adapter = codeOf(DECISION_ADAPTER);
    const call = adapter.match(/\.rpc\("decide_claim_receipt",\s*\{([\s\S]*?)\}\)/);
    assert.ok(call);
    const params = [...call[1].matchAll(/(p_[a-z_]+):/g)].map((m) => m[1]);
    assert.deepEqual(params.sort(), [
      "p_decision",
      "p_rejection_reason",
      "p_reviewer_note",
      "p_submission_id",
    ]);
  });

  test("7.5 the form supplies no identity, timestamp, audit action or return URL", () => {
    const reads = [...src.matchAll(/field\(formData, "([A-Za-z]+)"\)/g)].map(
      (m) => m[1],
    );
    assert.deepEqual(
      [...new Set(reads)].sort(),
      ["decision", "receiptSubmissionId", "rejectionReason", "reviewerNote"],
    );
  });

  test("7.6 no client-side audit log insert anywhere", () => {
    for (const file of PHASE_1C_C_FILES) {
      const s = codeOf(file);
      assert.ok(!/audit_log|auditLog|AUDIT/i.test(s), `${file} must not write audit`);
    }
  });

  test("7.7 no direct decision-table query", () => {
    for (const file of PHASE_1C_C_FILES) {
      const s = codeOf(file);
      assert.ok(!/\.from\("receipt_/.test(s));
      assert.ok(!/receipt_review_decisions/.test(s));
    }
  });

  test("7.8 no raw provider error is returned or logged", () => {
    const adapter = codeOf(DECISION_ADAPTER);
    assert.ok(!/error\.(message|details|hint)/.test(adapter));
    // The SQLSTATE code alone may be read, and only to classify a refusal.
    assert.match(adapter, /function isRefusalCode/);
    const logs = [...(src + adapter).matchAll(/console\.(error|warn|log)\(([^)]*)\)/g)];
    for (const [, , arg] of logs) {
      assert.match(arg.trim(), /^"[^"]*"$/, "only fixed strings may be logged");
    }
  });

  test("7.9 no raw form value is logged", () => {
    assert.ok(!/console\.[a-z]+\([^)]*(rawNote|formData|validated|receiptSubmissionId)/.test(src));
  });
});

// ============================================================================
describe("8. RPC outcome handling is honest", () => {
  const src = codeOf(ACTIONS);

  test("8.1 all three outcomes are handled distinctly", () => {
    for (const o of ["DECIDED", "ALREADY_DECIDED", "CONFLICT"]) {
      assert.ok(src.includes(o), `${o} must be handled`);
    }
  });

  test("8.2 DECIDED reports success and revalidates both paths", () => {
    assert.match(src, /revalidatePath\("\/review"\)/);
    assert.match(src, /revalidatePath\(detailPath\)/);
    assert.match(src, /outcome: "DECIDED",\s*settled: true/);
  });

  test("8.3 revalidation happens ONLY after an authoritative outcome", () => {
    const revalidateAt = src.indexOf('revalidatePath("/review")');
    const unavailableAt = src.indexOf('result.status === "unavailable"');
    assert.ok(
      unavailableAt < revalidateAt,
      "an outage must return before anything is revalidated",
    );
  });

  test("8.4 ALREADY_DECIDED is idempotent, not a failure", () => {
    const block = src.match(
      /result\.outcome === "ALREADY_DECIDED"[\s\S]*?\n  \}/,
    );
    assert.ok(block);
    assert.ok(!/formError/.test(block[0]), "must not be reported as an error");
    assert.match(block[0], /Nothing was changed/);
    assert.match(block[0], /settled: true/);
  });

  test("8.5 CONFLICT says so plainly and overwrites nothing", () => {
    assert.match(src, /already decided by another reviewer/i);
    assert.match(src, /outcome: "CONFLICT"/);
    assert.ok(
      !/retry|retryCount|attempt/i.test(src),
      "there must be no automatic retry path",
    );
  });

  test("8.6 CONFLICT exposes no other reviewer's identity", () => {
    const block = src.slice(src.indexOf('outcome: "CONFLICT"'));
    assert.ok(!/profileId|decided_by|decidedBy|user_id/i.test(block));
  });

  test("8.7 an outage never implies success and never settles", () => {
    const block = src.match(
      /result\.status === "unavailable"[\s\S]*?\n  \}/,
    );
    assert.ok(block);
    assert.match(block[0], /formError: GENERIC_ERROR/);
    assert.ok(!/settled: true/.test(block[0]), "an outage must leave it retryable");
  });

  test("8.8 an unreadable outcome is unavailable, never success", () => {
    const adapter = codeOf(DECISION_ADAPTER);
    assert.match(
      adapter,
      /!isOutcome\(row\.outcome\)[\s\S]{0,200}status: "unavailable"/,
    );
  });

  test("8.9 a settled state short-circuits a resubmission", () => {
    assert.match(src, /if \(prevState\.settled\)\s*\{\s*return prevState;/);
  });
});

// ============================================================================
describe("9. the decision form", () => {
  const src = codeOf(DECISION_FORM);

  test("9.1 the decision is a radio group, so both cannot be held at once", () => {
    assert.match(src, /type="radio"\s*\n?\s*name="decision"/);
    assert.ok(
      !/type="submit"[\s\S]{0,200}name="decision"/.test(src),
      "two submit buttons would let Enter pick one invisibly",
    );
  });

  test("9.2 exactly one submit button exists, and it is inside the dialog", () => {
    const submits = [...src.matchAll(/type="submit"/g)];
    assert.equal(submits.length, 1, "exactly one submit");
    const dialogAt = src.indexOf('role="dialog"');
    assert.ok(dialogAt > 0 && submits[0].index! > dialogAt);
  });

  test("9.3 the confirmation names the decision and the reason", () => {
    assert.match(src, /You are about to record/);
    assert.match(src, /REJECTION_REASON_LABELS\[reason\]/);
    assert.match(src, /permanent/i);
    // \s+ because JSX wraps this sentence across lines.
    assert.match(src, /cannot be edited,\s+reopened\s+or\s+deleted/);
  });

  test("9.4 the dialog is accessible", () => {
    assert.match(src, /role="dialog"/);
    assert.match(src, /aria-modal="true"/);
    assert.match(src, /aria-labelledby=\{headingId\}/);
    assert.match(src, /aria-describedby=\{descriptionId\}/);
    assert.match(src, /tabIndex=\{-1\}/);
  });

  test("9.5 focus moves in on open and back to the trigger on close", () => {
    assert.match(src, /dialogRef\.current\?\.focus\(\)/);
    assert.match(src, /openerRef\.current\?\.focus\(\)/);
  });

  test("9.6 Escape closes, but never mid-submit", () => {
    assert.match(src, /event\.key === "Escape" && !pending/);
  });

  test("9.7 the confirm button has a specific accessible name", () => {
    assert.match(src, /Yes, verify this receipt/);
    assert.match(src, /Yes, reject this receipt/);
  });

  test("9.8 controls are disabled while pending", () => {
    assert.match(src, /disabled=\{pending\}/);
    assert.match(src, /loading=\{pending\}/);
    assert.match(src, /disabled=\{!canConfirm \|\| pending\}/);
  });

  test("9.9 nothing is marked decided optimistically", () => {
    assert.match(src, /if \(state\.settled\)/);
    assert.ok(
      !/setDecided|optimistic|useOptimistic/.test(src),
      "the RPC result is the only authority",
    );
  });

  test("9.10 the required-note state is stated in words", () => {
    assert.match(src, /A note is required for/);
    assert.match(src, /Optional\. /);
  });

  test("9.11 the character count is shown against the limit", () => {
    assert.match(src, /\{trimmedNote\.length\} of \{CLAIM_REVIEW_NOTE_MAX_LENGTH\}/);
  });

  test("9.12 verify and reject are distinguished by words, not colour alone", () => {
    assert.match(src, /Verify receipt/);
    assert.match(src, /Reject receipt/);
    assert.match(src, /Continue to reject receipt/);
  });

  test("9.13 fields carry labels and errors are associated", () => {
    assert.match(src, /<Label htmlFor=\{reasonId\}/);
    assert.match(src, /<Label htmlFor=\{noteId\}/);
    assert.match(src, /aria-describedby=/);
    assert.match(src, /<FieldError id=\{noteErrorId\}/);
  });

  test("9.14 pending progress is announced", () => {
    assert.match(src, /role="status"/);
    assert.match(src, /Recording your decision/);
  });

  test("9.15 verifying clears any reason before submitting", () => {
    assert.match(src, /if \(option\.value === "VERIFIED"\) setReason\(null\)/);
  });
});

// ============================================================================
describe("10. the detail page content", () => {
  const src = codeOf(DETAIL_PAGE);

  test("10.1 the image-only scope is stated", () => {
    assert.match(src, /This is an image-only review/);
    assert.match(src, /not recorded for this receipt/);
  });

  test("10.2 safe metadata renders", () => {
    for (const label of [
      "Retailer",
      "Shop",
      "Submitted by",
      "Submitted",
      "File",
      "Filename",
    ]) {
      assert.ok(src.includes(`label="${label}"`), `${label} must render`);
    }
  });

  test("10.3 the duplicate badge renders only when true", () => {
    assert.match(src, /d\.hasDuplicateHash \? \(/);
  });

  test("10.4 inactive shop and staff states render as text", () => {
    assert.match(src, /Shop \{d\.shopStatus\.toLowerCase\(\)\}/);
    assert.match(src, /Staff \{d\.submitterStatus\.toLowerCase\(\)\}/);
  });

  test("10.5 no transaction, product, campaign or reward VALUE is rendered", () => {
    // Checked as FIELD ACCESS, not as words. The page legitimately names these
    // concepts in its honest "not recorded for this receipt" copy, and a word
    // scan would forbid the very disclaimer that makes the page truthful. What
    // must not exist is a value read off the detail object.
    for (const forbidden of [
      "amount",
      "currency",
      "merchant",
      "saleDate",
      "sale_date",
      "product",
      "campaign",
      "reward",
      "coin",
      "payout",
      "balance",
    ]) {
      assert.ok(
        !new RegExp(`d\\.${forbidden}`, "i").test(src),
        `d.${forbidden} must never be read`,
      );
      assert.ok(
        !new RegExp(`detail\\.${forbidden}`, "i").test(src),
        `detail.${forbidden} must never be read`,
      );
    }
    // And the type itself has no such field, which 2.10 pins independently.
    assert.ok(!/<Row label="Amount"|<Row label="Total"|<Row label="Merchant"/.test(src));
  });

  test("10.6 the image comes from the protected route", () => {
    const img = codeOf(RECEIPT_IMAGE);
    assert.match(img, /`\/review\/\$\{receiptSubmissionId\}\/image`/);
    assert.ok(!/supabase\.co|storage\/v1|https?:\/\//.test(img));
  });

  test("10.7 next/image is not used for the private object", () => {
    const img = codeOf(RECEIPT_IMAGE);
    assert.ok(!/from "next\/image"/.test(img));
  });

  test("10.8 image loading and unavailable states exist", () => {
    const img = codeOf(RECEIPT_IMAGE);
    assert.match(img, /"loading" \| "loaded" \| "error"/);
    assert.match(img, /couldn’t load this receipt image/);
    assert.match(img, /onError=\{\(\) => setState\("error"\)\}/);
  });

  test("10.9 the image has useful alternative text", () => {
    const img = codeOf(RECEIPT_IMAGE);
    assert.match(img, /const alt = `Receipt image submitted by/);
    assert.match(img, /alt=\{alt\}/);
  });

  test("10.10 no OCR or extraction control", () => {
    for (const file of PHASE_1C_C_FILES) {
      const s = codeOf(file);
      assert.ok(!/\bocr\b/i.test(s), `${file} must not mention OCR`);
      assert.ok(!/runExtraction|extractionRun|enableExtraction/i.test(s));
    }
  });

  test("10.11 extraction availability is reported, never invented", () => {
    assert.match(src, /extractionStatus === "NONE"[\s\S]{0,60}not available/);
  });

  test("10.12 Back to queue exists on the page", () => {
    assert.match(src, /Back to queue/);
  });
});

// ============================================================================
describe("11. the decided receipt is read-only", () => {
  const src = codeOf(DETAIL_PAGE);

  test("11.1 the decision form renders only when undecided", () => {
    assert.match(src, /\{decided \? \(/);
    assert.match(src, /<DecisionForm receiptSubmissionId=\{d\.receiptSubmissionId\} \/>/);
    // the form is in the ELSE branch of `decided`
    const decidedAt = src.indexOf("{decided ? (");
    const formAt = src.indexOf("<DecisionForm");
    const elseAt = src.indexOf(") : (", decidedAt);
    assert.ok(decidedAt < elseAt && elseAt < formAt);
  });

  test("11.2 a final-decision badge and label render", () => {
    assert.match(src, /Final decision/);
    assert.match(src, /DECISION_LABELS\[/);
    assert.match(src, /<Badge tone=\{d\.decision === "VERIFIED" \? "emerald" : "red"\}/);
  });

  test("11.3 the rejection reason renders as a human label", () => {
    assert.match(src, /REJECTION_REASON_LABELS\[/);
    assert.match(src, /<Row label="Reason">/);
  });

  test("11.4 decided time and deciding reviewer render when present", () => {
    assert.match(src, /<Row label="Decided">/);
    assert.match(src, /<Row label="Decided by">/);
  });

  test("11.5 finality is stated", () => {
    assert.match(src, /This decision is final/);
    assert.match(src, /cannot be edited, reopened or deleted/);
  });

  test("11.6 there is no Edit, Reopen, Delete or Change action anywhere", () => {
    // Matched as CONTROLS and CALLS, not as words. The finality copy legitimately
    // says a decision "cannot be edited, reopened or deleted" — forbidding the
    // substring would forbid the sentence that states the guarantee.
    for (const file of PHASE_1C_C_FILES) {
      const s = codeOf(file);
      for (const forbidden of [
        /\bReopen\s+(decision|receipt)\b/i,
        /\bUndo\s+decision\b/i,
        /\bChange\s+decision\b/i,
        /\bDelete\s+decision\b/i,
        /\bEdit\s+decision\b/i,
        /reopenDecision|updateDecision|deleteDecision|editDecision/,
        /\.update\(|\.delete\(|\.upsert\(/,
      ]) {
        assert.ok(!forbidden.test(s), `${forbidden} must not exist in ${file}`);
      }
    }
  });

  test("11.7 the badge is never colour alone", () => {
    // The label text is always inside the badge.
    assert.match(src, /\{decisionLabel\}/);
  });
});

// ============================================================================
describe("12. safe routing and not-found behaviour", () => {
  const src = codeOf(DETAIL_PAGE);

  test("12.1 malformed, missing and foreign all reach notFound()", () => {
    assert.match(src, /if \(!isReceiptSubmissionId\(receiptSubmissionId\)\) \{\s*notFound\(\);/);
    assert.match(src, /result\.status === "not-found"[\s\S]{0,60}notFound\(\)/);
  });

  test("12.2 unauthenticated follows the established login flow", () => {
    assert.match(src, /result\.status === "unauthenticated"[\s\S]{0,60}redirect\("\/login"\)/);
  });

  test("12.3 the failure shell names no Retailer", () => {
    // The unavailable branch renders DetailShell with no retailerName prop.
    const block = src.match(/result\.status === "unavailable"[\s\S]*?<\/DetailShell>/);
    assert.ok(block);
    assert.ok(
      !/retailerName=/.test(block[0]),
      "an unavailable receipt must not disclose whose it is",
    );
  });

  test("12.4 no raw database detail can render", () => {
    assert.ok(!/SQLSTATE|sqlstate|\.stack|error\.message/.test(src));
  });

  test("12.5 there is no open redirect", () => {
    for (const file of PHASE_1C_C_FILES) {
      const s = codeOf(file);
      const redirects = [...s.matchAll(/redirect\(([^)]*)\)/g)].map((m) => m[1].trim());
      for (const target of redirects) {
        assert.ok(
          /^"\/[a-z-]*"$/.test(target),
          `redirect target ${target} must be a fixed internal path`,
        );
      }
    }
  });
});

// ============================================================================
describe("13. milestone boundaries and regression", () => {
  // SUPERSEDED BY PHASE 1D-0, WHICH ADDED MIGRATION 62.
  //
  // The original asserted "no migration exists after 20260819210000", which was the
  // right statement while Phase 1C-C was Web-only and is simply false now that an
  // approved later milestone has shipped one. The durable property is narrower and
  // is what this file actually owns: PHASE 1C-C'S OWN FILES contain no SQL and add
  // no migration of their own. A later milestone's migration cannot satisfy that,
  // and a stray .sql appearing among these files still fails.
  test("13.1 Phase 1C-C itself added no migration and no SQL", () => {
    for (const file of PHASE_1C_C_FILES) {
      assert.ok(!file.endsWith(".sql"), `${file} must not be SQL`);
    }
    const dir = join(ROOT, "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    assert.ok(
      !files.some((f) => /detail|decision|image/i.test(f)),
      "no migration bearing this milestone's name exists",
    );
  });

  test("13.2 migration 61 is untouched", () => {
    const m = read(
      join(ROOT, "supabase", "migrations", "20260819210000_claim_review_filter_options.sql"),
    );
    assert.match(m, /create function public\.list_claim_review_filter_options\(\)/);
    // BYTE length. The file contains em dashes and curly quotes, so a UTF-16
    // string length would not equal the byte count on disk.
    assert.equal(
      Buffer.byteLength(m, "utf8"),
      8652,
      "migration 61 must be byte-identical",
    );
  });

  test("13.3 no reward, coin, balance or payout work", () => {
    // Field access, RPC names and table names — never bare words. The pages say
    // truthfully that reward eligibility is not available, and that sentence is
    // the point of the milestone rather than a violation of it.
    for (const file of PHASE_1C_C_FILES) {
      const s = codeOf(file);
      for (const forbidden of ["reward", "coin", "balance", "payout"]) {
        assert.ok(
          !new RegExp(`(d|detail|row)\\.${forbidden}`, "i").test(s),
          `${forbidden} must never be read as a field in ${file}`,
        );
        assert.ok(
          !new RegExp(`\\.(rpc|from)\\("[a-z_]*${forbidden}`, "i").test(s),
          `no ${forbidden} table or RPC may be called in ${file}`,
        );
      }
    }
  });

  test("13.4 no product or campaign matching", () => {
    for (const file of PHASE_1C_C_FILES) {
      const s = codeOf(file);
      assert.ok(!/campaignId|productId|matchProduct|matchCampaign/.test(s));
    }
  });

  test("13.5 the queue's filters and pagination are untouched", () => {
    const page = codeOf(QUEUE_PAGE);
    assert.match(page, /<QueueFilters/);
    assert.match(page, /buildClaimReviewQueueHref\(inputs, nextCursor\)/);
    assert.match(page, /sanitizeFilterSelection\(/);
  });

  test("13.6 no real identifier or receipt id is committed", () => {
    for (const file of [...PHASE_1C_C_FILES, join(ROOT, "docs", "claim-reviewer-receipt-detail-and-decision.md")]) {
      if (!existsSync(file)) continue;
      const s = read(file);
      const uuids = [
        ...s.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi),
      ].map((m) => m[0]);
      for (const u of uuids) {
        assert.ok(
          /^(1{8}|0{8}|a{8}|6{8})/i.test(u),
          `${u} in ${file} looks like a real identifier`,
        );
      }
      assert.ok(!/@(gmail|yahoo|outlook|hotmail)\./i.test(s), `email in ${file}`);
      assert.ok(!/\beyJ[A-Za-z0-9_-]{10,}/.test(s), `token in ${file}`);
      assert.ok(!/sb_(secret|publishable)_/.test(s), `key in ${file}`);
    }
  });

  test("13.7 no storage path, bucket name or hash appears in shipped code", () => {
    for (const file of PHASE_1C_C_FILES) {
      const s = codeOf(file);
      if (SERVICE_ROLE_ALLOWED.includes(file)) continue;
      assert.ok(!/storage_object_path|storage_bucket|file_sha256/.test(s), file);
      assert.ok(!/"receipts"/.test(s), `bucket literal in ${file}`);
    }
  });

  test("13.8 the documentation exists and names no private value", () => {
    const doc = join(ROOT, "docs", "claim-reviewer-receipt-detail-and-decision.md");
    assert.ok(existsSync(doc), "Phase 1C-C documentation must exist");
    const s = read(doc);
    assert.match(s, /Phase 1C-C/);
    assert.match(s, /authorization/i);
    assert.match(s, /signed URL/i);
    assert.match(s, /ALREADY_DECIDED/);
    assert.match(s, /CONFLICT/);
  });

  test("13.9 the queue documentation no longer describes a disabled action", () => {
    const doc = read(join(ROOT, "docs", "claim-reviewer-receipt-queue.md"));
    assert.ok(
      !/Review receipt[^\n]{0,40}Soon/.test(doc),
      "the Soon description must be replaced",
    );
  });
});
