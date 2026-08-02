/**
 * Tests for the Claim Reviewer receipt QUEUE — Phase 1C-B.
 *
 * Run with:  npm test
 *
 * Two kinds, deliberately:
 *
 *   1. REAL UNIT TESTS of lib/review/claim-review-queue-filters.ts, which is a pure
 *      module with no imports and no I/O. Filter parsing, cursor handling and URL
 *      building are exercised by calling them.
 *
 *   2. SOURCE-SCANNING CONTRACT TESTS of the adapter, page and components. Those are
 *      Server Components and a `server-only` module: they import `next/headers`
 *      transitively and throw outside a request, so they cannot be invoked here.
 *      What they must NOT do is still checkable, and that is the more valuable half —
 *      "never imports a service-role client", "never queries a receipt table", "never
 *      renders an image" are properties a future edit could silently break.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY SOURCE RULE. These files explain the very
 * identifiers the rules forbid, so an unstripped scan would fail on the prose that
 * documents the rule.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildClaimReviewQueueHref,
  formatFileSize,
  formatMimeType,
  formatSubmittedAt,
  parseClaimReviewQueueParams,
  QUEUE_PARAM,
} from "./claim-review-queue-filters.ts";

const ROOT = join(import.meta.dirname, "..", "..");

const ADAPTER = join(ROOT, "lib", "review", "claim-review-queue.ts");
const FILTERS_MOD = join(ROOT, "lib", "review", "claim-review-queue-filters.ts");
const QUEUE_PAGE = join(ROOT, "app", "(review)", "review", "page.tsx");
const QUEUE_LOADING = join(ROOT, "app", "(review)", "review", "loading.tsx");
const QUEUE_FILTERS_UI = join(ROOT, "app", "(review)", "review", "queue-filters.tsx");
const QUEUE_ROW_UI = join(ROOT, "app", "(review)", "review", "receipt-queue-row.tsx");
const NAV_ITEMS = join(ROOT, "components", "review", "review-nav-items.tsx");
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

/** Every file this milestone added or changed under the review portal. */
const QUEUE_FILES = [
  ADAPTER,
  FILTERS_MOD,
  QUEUE_PAGE,
  QUEUE_LOADING,
  QUEUE_FILTERS_UI,
  QUEUE_ROW_UI,
];

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";

describe("1. routing and navigation", () => {
  test("1.1 /review is the queue page and no duplicate route was added", () => {
    assert.ok(existsSync(QUEUE_PAGE));
    assert.ok(
      !existsSync(join(ROOT, "app", "(review)", "review", "queue")),
      "the queue must live at /review, not a nested duplicate",
    );
  });

  test("1.2 the Review queue nav item is enabled", () => {
    const nav = codeOf(NAV_ITEMS);
    assert.match(nav, /label: "Review queue"/);
    assert.match(nav, /disabled: false/);
    assert.ok(!/disabled: true/.test(nav), "no nav item may still be disabled");
  });

  test("1.3 the shell computes an active state", () => {
    const shell = codeOf(SHELL);
    assert.match(shell, /usePathname\(\)/);
    assert.match(shell, /aria-current=\{active \? "page" : undefined\}/);
  });

  test("1.4 a future /review/[id] keeps the queue item active", () => {
    // The helper is not exported, so its behaviour is pinned by shape: a prefix
    // match with a boundary, never a bare startsWith.
    const shell = codeOf(SHELL);
    assert.match(shell, /pathname === href \|\| pathname\.startsWith\(`\$\{href\}\/`\)/);
  });

  test("1.5 no Phase 1C-C navigation was introduced", () => {
    const nav = read(NAV_ITEMS);
    for (const forbidden of ["history", "Rewards", "Campaigns", "Settings", "Payouts", "OCR"]) {
      assert.ok(!nav.includes(`label: "${forbidden}`), `unexpected nav item: ${forbidden}`);
    }
    assert.equal((nav.match(/label: "/g) ?? []).length, 1, "exactly one nav item");
  });
});

describe("2. the adapter uses only the two approved read RPCs", () => {
  const code = codeOf(ADAPTER);

  test("2.1 calls list_claim_review_queue", () => {
    assert.match(code, /supabase\.rpc\("list_claim_review_queue"/);
  });

  test("2.2 calls count_claim_review_queue", () => {
    assert.match(code, /supabase\.rpc\("count_claim_review_queue"/);
  });

  test("2.3 calls no other RPC", () => {
    const calls = [...code.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(calls)].sort(),
      ["count_claim_review_queue", "list_claim_review_queue"],
    );
  });

  test("2.4 never calls the detail, decision or object-reference functions", () => {
    for (const file of QUEUE_FILES) {
      const c = codeOf(file);
      for (const fn of [
        "get_claim_review_detail",
        "decide_claim_receipt",
        "get_claim_review_object_reference",
      ]) {
        assert.ok(!c.includes(fn), `${file} must not call ${fn} in Phase 1C-B`);
      }
    }
  });

  test("2.5 uses the ordinary authenticated server client", () => {
    assert.match(read(ADAPTER), /from "@\/lib\/supabase\/server"/);
    assert.match(code, /createClient\(\)/);
    assert.match(read(ADAPTER), /^import "server-only";/m);
  });

  test("2.6 no service-role or Admin client anywhere in the milestone", () => {
    for (const file of QUEUE_FILES) {
      const c = codeOf(file);
      for (const forbidden of [
        "supabase/admin",
        "createAdminClient",
        "SERVICE_ROLE",
        "service_role",
      ]) {
        assert.ok(!c.includes(forbidden), `${file} must not reach ${forbidden}`);
      }
    }
  });

  test("2.7 queries no receipt table directly", () => {
    for (const file of QUEUE_FILES) {
      const c = codeOf(file);
      for (const tbl of [
        "receipt_submissions",
        "receipt_review_decisions",
        "receipt_confirmations",
        "receipt_extractions",
        "storage.objects",
        'from("',
      ]) {
        assert.ok(!c.includes(tbl), `${file} must not touch ${tbl}`);
      }
    }
  });

  test("2.8 sends no Vendor id to either RPC", () => {
    const args = code.slice(code.indexOf('rpc("list_claim_review_queue"'));
    for (const forbidden of ["p_vendor", "vendor_organization_id", "vendorId"]) {
      assert.ok(!args.includes(forbidden), `must not send ${forbidden}`);
    }
  });

  test("2.9 requests one extra row to detect a further page", () => {
    assert.match(code, /p_limit: CLAIM_REVIEW_PAGE_SIZE \+ 1/);
    assert.match(read(ADAPTER), /CLAIM_REVIEW_PAGE_SIZE = 25/);
  });
});

describe("3. nothing private crosses into the browser", () => {
  test("3.1 the row type carries no bucket, path, hash, email or private id", () => {
    const c = codeOf(ADAPTER);
    for (const leak of [
      "storage_bucket",
      "storageBucket",
      "storage_object_path",
      "objectPath",
      "file_sha256",
      "fileSha256",
      "email",
      "phone",
      "submitted_by_profile_id",
      "retailer_organization_id",
      "organizationId",
    ]) {
      assert.ok(!c.includes(leak), `adapter must not carry ${leak}`);
    }
  });

  test("3.2 rows are mapped field by field, never spread", () => {
    const c = codeOf(ADAPTER);
    assert.ok(!/\.\.\.row/.test(c), "spreading an RPC row would leak a future column");
    assert.match(c, /function toQueueRow/);
  });

  test("3.3 no raw Supabase error is returned or logged", () => {
    const c = codeOf(ADAPTER);
    for (const leak of [
      "error.message",
      "error.code",
      "error.details",
      "JSON.stringify(",
    ]) {
      assert.ok(!c.includes(leak), `raw provider detail leaked: ${leak}`);
    }
    const logs = [...c.matchAll(/console\.(error|log|warn)\(([^)]*)\)/g)];
    assert.ok(logs.length > 0);
    for (const [, , arg] of logs) {
      assert.match(arg.trim(), /^"[^"]*"$/, "log arguments must be fixed strings");
    }
  });

  test("3.4 the page renders no receipt image", () => {
    for (const file of [QUEUE_PAGE, QUEUE_ROW_UI, QUEUE_LOADING]) {
      const c = codeOf(file);
      assert.ok(!/<img\b/.test(c), `${file} must not render an image`);
      assert.ok(!c.includes("next/image"), `${file} must not import next/image`);
      assert.ok(!c.includes("createSignedUrl"), `${file} must not sign a URL`);
    }
  });

  test("3.5 no unsupported transaction or reward field is displayed", () => {
    for (const file of [QUEUE_PAGE, QUEUE_ROW_UI]) {
      const c = codeOf(file);
      // FIELD ACCESS, not any mention: the page's honest disclaimer names these
      // very concepts to say they are unavailable, and that sentence must not trip
      // the rule that stops them being rendered as data.
      for (const invented of [
        "totalMinor",
        "amount",
        "currency",
        "merchant",
        "transactionDate",
        "productName",
        "campaign",
        "reward",
        "coin",
        "payout",
      ]) {
        assert.ok(
          !new RegExp(`row\\.${invented}|\\{\\s*${invented}\\s*\\}`, "i").test(c),
          `${file} must not render ${invented} as data — no such value exists`,
        );
      }
    }
  });

  test("3.6 no decision control exists anywhere in this milestone", () => {
    for (const file of QUEUE_FILES) {
      const c = codeOf(file);
      for (const forbidden of ["VERIFIED", "REJECTED", "rejection_reason", "rejectionReason"]) {
        assert.ok(!c.includes(forbidden), `${file} must not offer a decision`);
      }
    }
  });
});

describe("4. filter parsing", () => {
  test("4.1 an empty query string yields all-null filters", () => {
    const p = parseClaimReviewQueueParams({});
    assert.deepEqual(p.filters, {
      retailerId: null,
      shopId: null,
      submittedFrom: null,
      submittedTo: null,
    });
    assert.equal(p.hasActiveFilters, false);
    assert.equal(p.cursor, null);
    assert.equal(p.cursorWasReset, false);
  });

  test("4.2 retailer and shop map through when UUID-shaped", () => {
    const p = parseClaimReviewQueueParams({ retailer: UUID_A, shop: UUID_B });
    assert.equal(p.filters.retailerId, UUID_A);
    assert.equal(p.filters.shopId, UUID_B);
    assert.equal(p.hasActiveFilters, true);
  });

  test("4.3 a non-UUID retailer or shop is dropped, never forwarded", () => {
    const p = parseClaimReviewQueueParams({ retailer: "'; drop table--", shop: "42" });
    assert.equal(p.filters.retailerId, null);
    assert.equal(p.filters.shopId, null);
  });

  test("4.4 dates widen to inclusive UTC day bounds", () => {
    const p = parseClaimReviewQueueParams({
      submittedFrom: "2026-08-01",
      submittedTo: "2026-08-02",
    });
    assert.equal(p.filters.submittedFrom, "2026-08-01T00:00:00.000Z");
    assert.equal(
      p.filters.submittedTo,
      "2026-08-02T23:59:59.999Z",
      "an inclusive 'to' must cover the whole day, not stop at midnight",
    );
  });

  test("4.5 an impossible or malformed date never reaches the RPC", () => {
    for (const bad of ["2026-02-31", "2026-13-01", "not-a-date", "2026/08/01", ""]) {
      const p = parseClaimReviewQueueParams({ submittedFrom: bad, submittedTo: bad });
      assert.equal(p.filters.submittedFrom, null, `rejected: ${bad}`);
      assert.equal(p.filters.submittedTo, null, `rejected: ${bad}`);
    }
  });

  test("4.6 a repeated parameter is ignored rather than guessed at", () => {
    const p = parseClaimReviewQueueParams({ retailer: [UUID_A, UUID_B] });
    assert.equal(p.filters.retailerId, null);
  });

  test("4.7 a complete cursor pair maps through", () => {
    const p = parseClaimReviewQueueParams({
      cursorSubmittedAt: "2026-08-01T10:00:00.000Z",
      cursorReceiptId: UUID_A,
    });
    assert.deepEqual(p.cursor, {
      submittedAt: "2026-08-01T10:00:00.000Z",
      receiptSubmissionId: UUID_A,
    });
    assert.equal(p.cursorWasReset, false);
  });

  test("4.8 a half cursor resets to the first page and says so", () => {
    for (const half of [
      { cursorSubmittedAt: "2026-08-01T10:00:00.000Z" },
      { cursorReceiptId: UUID_A },
      { cursorSubmittedAt: "nonsense", cursorReceiptId: UUID_A },
      { cursorSubmittedAt: "2026-08-01T10:00:00.000Z", cursorReceiptId: "nope" },
    ]) {
      const p = parseClaimReviewQueueParams(half);
      assert.equal(p.cursor, null, "no half pair may reach the RPC");
      assert.equal(p.cursorWasReset, true, "and the page must be able to say so");
    }
  });

  test("4.9 a cursor alone is not an active filter", () => {
    const p = parseClaimReviewQueueParams({
      cursorSubmittedAt: "2026-08-01T10:00:00.000Z",
      cursorReceiptId: UUID_A,
    });
    assert.equal(
      p.hasActiveFilters,
      false,
      "page two of an unfiltered queue must not show the filtered empty state",
    );
  });

  test("4.10 there is no vendor parameter and one cannot be smuggled in", () => {
    assert.ok(!Object.values(QUEUE_PARAM).includes("vendor" as never));
    const p = parseClaimReviewQueueParams({
      vendor: UUID_A,
      organization: UUID_B,
    } as Record<string, string>);
    assert.equal(p.hasActiveFilters, false);
    assert.deepEqual(Object.keys(p.filters).sort(), [
      "retailerId",
      "shopId",
      "submittedFrom",
      "submittedTo",
    ]);
  });
});

describe("5. URL building", () => {
  test("5.1 no filters yields the bare path", () => {
    assert.equal(
      buildClaimReviewQueueHref({
        retailerId: null,
        shopId: null,
        submittedFromDate: null,
        submittedToDate: null,
      }),
      "/review",
    );
  });

  test("5.2 the next-page URL carries BOTH cursor values and every filter", () => {
    const href = buildClaimReviewQueueHref(
      {
        retailerId: UUID_A,
        shopId: UUID_B,
        submittedFromDate: "2026-08-01",
        submittedToDate: "2026-08-02",
      },
      { submittedAt: "2026-08-01T10:00:00.000Z", receiptSubmissionId: UUID_A },
    );
    assert.match(href, /^\/review\?/);
    for (const key of Object.values(QUEUE_PARAM)) {
      assert.ok(href.includes(`${key}=`), `next page must carry ${key}`);
    }
  });

  test("5.3 round-trips: a built URL parses back to what built it", () => {
    const inputs = {
      retailerId: UUID_A,
      shopId: null,
      submittedFromDate: "2026-08-01",
      submittedToDate: null,
    };
    const href = buildClaimReviewQueueHref(inputs);
    const params = Object.fromEntries(new URL(href, "http://x").searchParams);
    assert.deepEqual(parseClaimReviewQueueParams(params).inputs, inputs);
  });

  test("5.4 no OFFSET-style paging parameter exists", () => {
    const href = buildClaimReviewQueueHref(
      { retailerId: null, shopId: null, submittedFromDate: null, submittedToDate: null },
      { submittedAt: "2026-08-01T10:00:00.000Z", receiptSubmissionId: UUID_A },
    );
    for (const forbidden of ["offset", "page=", "skip", "pageNumber"]) {
      assert.ok(!href.toLowerCase().includes(forbidden), `no ${forbidden} paging`);
    }
  });

  test("5.5 the path is a fixed literal — no open redirect is possible", () => {
    const code = codeOf(FILTERS_MOD);
    assert.match(code, /qs\.length > 0 \? `\/review\?\$\{qs\}` : "\/review"/);
    for (const forbidden of ["http://", "https://", "//"]) {
      assert.ok(
        !new RegExp(`return .*${forbidden.replace("/", "\\/")}`).test(code),
        "no absolute destination may be produced",
      );
    }
  });
});

describe("6. display formatting is safe", () => {
  test("6.1 file sizes format without NaN", () => {
    assert.equal(formatFileSize(512), "512 B");
    assert.equal(formatFileSize(2048), "2 KB");
    assert.equal(formatFileSize(7_340_032), "7.0 MB");
    assert.equal(formatFileSize(Number.NaN), "Unknown size");
    assert.equal(formatFileSize(-1), "Unknown size");
  });

  test("6.2 MIME types are humanized and never printed raw", () => {
    assert.equal(formatMimeType("image/jpeg"), "JPEG image");
    assert.equal(formatMimeType("image/png"), "PNG image");
    assert.equal(formatMimeType("image/webp"), "WebP image");
    assert.equal(formatMimeType("application/x-evil"), "Image");
  });

  test("6.3 timestamps format deterministically in UTC", () => {
    assert.equal(formatSubmittedAt("2026-08-01T09:05:00.000Z"), "2026-08-01 09:05 UTC");
    assert.equal(formatSubmittedAt("nonsense"), "Unknown date");
  });
});

describe("7. page behaviour and states", () => {
  const page = codeOf(QUEUE_PAGE);

  test("7.1 a failed read is never rendered as an empty queue", () => {
    assert.match(page, /rows === null/);
    const branch = page.slice(page.indexOf("rows === null"));
    assert.ok(
      branch.indexOf("Alert") < branch.indexOf("EmptyState"),
      "the null-rows branch must render an alert before any empty state",
    );
    assert.match(page, /countIsKnown=\{rows !== null && totalCount !== null\}/);
  });

  test("7.2 both empty states exist and differ", () => {
    assert.match(page, /No receipts are waiting for review/);
    assert.match(page, /No receipts match these filters/);
  });

  test("7.3 Clear filters appears only on the filtered empty state", () => {
    const filtered = page.slice(
      page.indexOf("No receipts match these filters"),
      page.indexOf("No receipts are waiting for review"),
    );
    assert.match(filtered, /Clear filters/);
    const unfiltered = page.slice(page.indexOf("No receipts are waiting for review"));
    assert.ok(!unfiltered.slice(0, 400).includes("Clear filters"));
  });

  test("7.4 unauthorized and unavailable are not collapsed", () => {
    assert.match(page, /redirect\("\/review-access-denied"\)/);
    assert.match(page, /status === "unavailable"/);
    assert.match(page, /redirect\("\/login"\)/);
  });

  test("7.5 the page re-checks authorization rather than trusting the layout", () => {
    assert.match(page, /getClaimReviewQueue\(/);
    assert.match(page, /status === "unauthenticated"/);
  });

  test("7.6 a reset cursor is explained rather than silently applied", () => {
    assert.match(page, /cursorWasReset/);
    assert.match(page, /Showing the first page/);
  });

  test("7.7 the next-page control appears only when a further page exists", () => {
    assert.match(page, /nextCursor \?/);
    assert.match(page, /buildClaimReviewQueueHref\(inputs, nextCursor\)/);
  });

  test("7.8 the open action is disabled and explains why", () => {
    assert.match(page, /aria-disabled="true"/);
    assert.match(page, /Review receipt/);
    assert.ok(
      !/<Link[^>]*href=\{`\/review\/\$\{/.test(page),
      "no link to the unbuilt detail route",
    );
  });

  test("7.9 the page is a Server Component with no client directive", () => {
    for (const file of [QUEUE_PAGE, QUEUE_FILTERS_UI, QUEUE_ROW_UI, QUEUE_LOADING]) {
      assert.ok(!read(file).startsWith('"use client"'), `${file} must stay server-side`);
    }
  });

  test("7.10 filters submit by GET, carrying no cursor", () => {
    const ui = codeOf(QUEUE_FILTERS_UI);
    assert.match(ui, /method="get"/);
    assert.match(ui, /action="\/review"/);
    assert.ok(
      !ui.includes(QUEUE_PARAM.cursorSubmittedAt),
      "changing a filter must return to page one",
    );
  });
});

describe("8. accessibility and presentation", () => {
  test("8.1 exactly one H1, via the shared PageHeader", () => {
    const page = codeOf(QUEUE_PAGE);
    assert.match(page, /PageHeader/);
    assert.ok(!/<h1\b/.test(page), "the H1 comes from PageHeader, not a second one");
    assert.match(codeOf(QUEUE_FILTERS_UI), /<h2/);
  });

  test("8.2 every filter control has a label", () => {
    const ui = codeOf(QUEUE_FILTERS_UI);
    // Only form CONTROLS need a label. The panel's <h2 id> is not a control.
    const ids = [...ui.matchAll(/<input\s+id="(queue-[a-z-]+)"/g)].map((m) => m[1]);
    for (const id of ids) {
      assert.ok(ui.includes(`htmlFor="${id}"`), `missing label for ${id}`);
    }
    assert.ok(ids.length >= 2);
  });

  test("8.3 status is conveyed in text, not colour alone", () => {
    const row = codeOf(QUEUE_ROW_UI);
    assert.match(row, /Shop \{row\.shopStatus\.toLowerCase\(\)\}/);
    assert.match(row, /Staff \{row\.submitterStatus\.toLowerCase\(\)\}/);
    assert.match(row, /Possible duplicate/);
  });

  test("8.4 the loading skeleton is hidden from assistive technology and announces", () => {
    const l = codeOf(QUEUE_LOADING);
    assert.match(l, /aria-busy="true"/);
    assert.match(l, /aria-hidden="true"/);
    assert.match(l, /role="status"/);
  });

  test("8.5 the skeleton invents no value", () => {
    const l = codeOf(QUEUE_LOADING);
    assert.ok(!/\d+ waiting/.test(l), "no fabricated count");
    assert.ok(!/Retailer|Shop [A-Z]/.test(l), "no fabricated names");
  });

  test("8.6 the duplicate badge renders only when the flag is true", () => {
    assert.match(codeOf(QUEUE_ROW_UI), /row\.hasDuplicateHash \?/);
  });

  test("8.7 inactive shop and staff states are rendered as context", () => {
    const row = codeOf(QUEUE_ROW_UI);
    assert.match(row, /shopInactive/);
    assert.match(row, /submitterInactive/);
  });
});

describe("9. milestone boundaries", () => {
  test("9.1 no migration was added by Phase 1C-B", () => {
    const migrations = readdirSync(join(ROOT, "supabase", "migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    assert.equal(migrations.length, 60, "Phase 1C-B is Web-only");
  });

  test("9.2 no Phase 1C-C detail route was created", () => {
    const reviewDir = join(ROOT, "app", "(review)", "review");
    const entries = readdirSync(reviewDir);
    assert.ok(
      !entries.some((e) => e.startsWith("[")),
      "the dynamic detail route belongs to Phase 1C-C",
    );
  });

  test("9.3 no OCR, extraction or reward work appears", () => {
    for (const file of QUEUE_FILES) {
      const c = codeOf(file);
      for (const forbidden of ["extraction", "ocr", "azure", "balance", "payout"]) {
        assert.ok(
          !new RegExp(`\\b${forbidden}\\b`, "i").test(c),
          `${file} must not reference ${forbidden}`,
        );
      }
    }
  });

  test("9.4 no email-shaped literal or UUID literal is committed", () => {
    const emailShaped = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const file of QUEUE_FILES) {
      const text = read(file);
      assert.equal(text.match(emailShaped), null, `${file} contains an address`);
      assert.equal(text.match(uuid), null, `${file} contains a UUID literal`);
    }
  });

  test("9.5 the Phase 1B access adapter is untouched by this milestone", () => {
    const access = read(join(ROOT, "lib", "review", "claim-reviewer-access.ts"));
    assert.match(access, /get_claim_reviewer_context/);
    assert.ok(!access.includes("list_claim_review_queue"));
  });
});
