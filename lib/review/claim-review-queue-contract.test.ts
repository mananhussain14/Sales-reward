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
  sanitizeFilterSelection,
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

describe("2. the adapter uses only the three approved read RPCs", () => {
  const code = codeOf(ADAPTER);

  test("2.1 calls list_claim_review_queue", () => {
    assert.match(code, /supabase\.rpc\("list_claim_review_queue"/);
  });

  test("2.2 calls count_claim_review_queue", () => {
    assert.match(code, /supabase\.rpc\("count_claim_review_queue"/);
  });

  test("2.2b calls list_claim_review_filter_options", () => {
    assert.match(code, /supabase\.rpc\("list_claim_review_filter_options"\)/);
  });

  test("2.3 calls no other RPC", () => {
    const calls = [...code.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(calls)].sort(),
      [
        "count_claim_review_queue",
        "list_claim_review_filter_options",
        "list_claim_review_queue",
      ],
    );
  });

  test("2.3b the filter-options RPC takes no arguments", () => {
    // Not even the filters: the option set describes what MAY be chosen, so
    // narrowing it by the current choice would erase every alternative.
    assert.match(code, /rpc\("list_claim_review_filter_options"\)/);
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
  test("3.1 the adapter carries no bucket, path, hash, email or personal id", () => {
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
      "decided_by_profile_id",
      "organization_member",
    ]) {
      assert.ok(!c.includes(leak), `adapter must not carry ${leak}`);
    }
  });

  test("3.1b the two tenant ids appear ONLY in the filter-option shapes", () => {
    // retailer_organization_id and retailer_shop_id are approved in the option type
    // because the queue RPC types its filters as uuid. They must NOT leak into the
    // per-receipt row, which is rendered for every receipt on the page.
    const c = codeOf(ADAPTER);
    const queueRowType = c.slice(
      c.indexOf("type QueueRpcRow"),
      c.indexOf("type FilterOptionRpcRow"),
    );
    assert.ok(queueRowType.length > 0);
    for (const id of ["retailer_organization_id", "retailer_shop_id"]) {
      assert.ok(
        !queueRowType.includes(id),
        `the queue row must not carry ${id} — only the option row may`,
      );
    }
    const browserRowType = c.slice(
      c.indexOf("export type ClaimReviewQueueRow"),
      c.indexOf("export type ClaimReviewQueueCursor"),
    );
    for (const id of ["retailerId", "shopId"]) {
      assert.ok(
        !browserRowType.includes(id),
        `the browser row type must not carry ${id}`,
      );
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

  // SUPERSEDED BY PHASE 1C-C, WHICH BUILT THE DETAIL ROUTE.
  //
  // The original pinned that the open action was DISABLED and linked nowhere,
  // because the route did not exist and a link to it would have been a 404 with
  // extra steps. That route exists now.
  //
  // The property worth keeping was never "disabled" — it was that this action goes
  // somewhere real and carries nothing but the receipt id. The successor asserts
  // exactly that, and adds a requirement the original never had: no return URL or
  // filter state may ride along, so no caller-supplied destination can appear.
  test("7.8 the open action links to the detail route, carrying only the id", () => {
    assert.match(page, /Review receipt/);
    assert.match(page, /href=\{`\/review\/\$\{row\.receiptSubmissionId\}`\}/);
    assert.ok(
      !/aria-disabled="true"/.test(page),
      "the action must no longer be a disabled placeholder",
    );
    assert.ok(!/Soon/.test(page), "the Soon badge must be gone");
    assert.ok(
      !/[?&](returnTo|redirect|next|from)=/.test(page),
      "no return-URL parameter may be attached",
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
  // SUPERSEDED BY PHASE 1D-0, WHICH ADDED MIGRATION 62.
  //
  // The original asserted a total count of 61. That number belonged to Phase 1C-B
  // and every later approved migration would break it, which makes it a calendar
  // rather than a contract. What this file actually owns is that THIS milestone's
  // migration exists and was not renamed or removed — so the successor pins that,
  // and leaves the running total to whichever milestone last changed it.
  test("9.1 the filter-options migration is present and unrenamed", () => {
    const migrations = readdirSync(join(ROOT, "supabase", "migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    assert.ok(
      migrations.includes("20260819210000_claim_review_filter_options.sql"),
      "and it is the filter-options migration",
    );
  });

  // SUPERSEDED BY PHASE 1C-C, WHICH CREATED THE DETAIL ROUTE.
  //
  // The original forbade any dynamic child of /review, because the detail route
  // was the NEXT milestone's work and building it early would have shipped an
  // unreviewed image path. It exists now, and its own suite
  // (claim-review-detail-contract.test.ts) pins every property it must hold.
  //
  // What this file still owns is that the QUEUE did not grow a second architecture
  // while that happened: these four queue files must remain free of any image,
  // decision or service-role work, whatever the detail route now does.
  test("9.2 the queue itself gained no image, decision or service-role work", () => {
    for (const file of QUEUE_FILES) {
      const c = codeOf(file);
      for (const forbidden of [
        "createSignedUrl",
        "decide_claim_receipt",
        "get_claim_review_detail",
        "get_claim_review_object_reference",
        "createAdminClient",
        "supabase/admin",
        "<img",
      ]) {
        assert.ok(
          !c.includes(forbidden),
          `${forbidden} must not appear in the queue file ${file}`,
        );
      }
    }
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

/* ===========================================================================
 * 10. Retailer and shop pickers — the approved Phase 1C-B follow-up
 * ======================================================================== */
const R1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const R2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const S1A = "cccccccc-3333-4333-8333-cccccccccccc";
const S1B = "dddddddd-4444-4444-8444-dddddddddddd";
const S2A = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const UNKNOWN = "ffffffff-6666-4666-8666-ffffffffffff";

/** Two Retailers; the first has two shops. */
const ALLOWED = [
  { retailerId: R1, shopId: S1A },
  { retailerId: R1, shopId: S1B },
  { retailerId: R2, shopId: S2A },
];

describe("10. the filter-options migration and function", () => {
  const MIGRATION = join(
    ROOT,
    "supabase",
    "migrations",
    "20260819210000_claim_review_filter_options.sql",
  );

  test("10.1 the migration exists and adds exactly one function", () => {
    assert.ok(existsSync(MIGRATION));
    const sql = read(MIGRATION).replace(/--[^\n]*/g, "");
    assert.equal((sql.match(/^create function/gim) ?? []).length, 1);
    assert.match(sql, /create function public\.list_claim_review_filter_options\(\)/);
  });

  test("10.2 it is additive — no table, permission, mapping, policy or write", () => {
    const sql = read(MIGRATION).replace(/--[^\n]*/g, "");
    for (const forbidden of [
      "create table",
      "create policy",
      "alter table",
      "drop ",
      "truncate",
      "insert into public.permissions",
      "insert into public.role_permissions",
      "update public.",
      "delete from public.",
      "create or replace",
    ]) {
      assert.ok(
        !new RegExp(forbidden, "i").test(sql),
        `the migration must not contain: ${forbidden}`,
      );
    }
  });

  test("10.3 SECURITY DEFINER, STABLE, empty search_path, correct grants", () => {
    const sql = read(MIGRATION);
    assert.match(sql, /security definer/);
    assert.match(sql, /\bstable\b/);
    assert.match(sql, /set search_path = ''/);
    assert.match(sql, /revoke all\s+on function public\.list_claim_review_filter_options\(\) from public/);
    assert.match(sql, /revoke execute on function public\.list_claim_review_filter_options\(\) from anon/);
    assert.match(sql, /grant\s+execute on function public\.list_claim_review_filter_options\(\) to authenticated/);
    assert.ok(
      !/grant .*list_claim_review_filter_options.* to service_role/i.test(sql),
      "service_role has no use for a filter list",
    );
  });

  test("10.4 it repeats every queue eligibility predicate", () => {
    const sql = read(MIGRATION).replace(/--[^\n]*/g, "");
    for (const predicate of [
      /resolve_claim_reviewer_organization\('RECEIPT_REVIEW_READ'\)/,
      /s\.status = 'SUBMITTED'/,
      /s\.submitted_at is not null/,
      /vendor_retailers/,
      /vr\.status = 'ACTIVE'/,
      /storage\.objects/,
      /not exists[\s\S]{0,120}receipt_review_decisions/,
    ]) {
      assert.match(sql, predicate);
    }
  });

  test("10.5 it accepts no argument and returns only the six approved columns", () => {
    const sql = read(MIGRATION);
    assert.match(sql, /list_claim_review_filter_options\(\)\s*\nreturns table \(/);
    const returns = sql.slice(sql.indexOf("returns table ("), sql.indexOf("language plpgsql"));
    for (const col of [
      "retailer_organization_id",
      "retailer_name",
      "retailer_shop_id",
      "shop_name",
      "shop_code",
      "shop_status",
    ]) {
      assert.ok(returns.includes(col), `missing column ${col}`);
    }
    for (const forbidden of [
      "storage_bucket",
      "storage_object_path",
      "file_sha256",
      "email",
      "phone",
      "receipt_submission_id",
      "profile_id",
    ]) {
      assert.ok(!returns.includes(forbidden), `must not return ${forbidden}`);
    }
  });
});

describe("11. picker selection is validated against the authorized set", () => {
  test("11.1 a permitted Retailer and shop survive", () => {
    const r = sanitizeFilterSelection(R1, S1A, ALLOWED);
    assert.deepEqual(r, { retailerId: R1, shopId: S1A, changed: false });
  });

  test("11.2 an unknown Retailer is dropped", () => {
    const r = sanitizeFilterSelection(UNKNOWN, null, ALLOWED);
    assert.equal(r.retailerId, null);
    assert.equal(r.changed, true);
  });

  test("11.3 an unknown shop is dropped", () => {
    const r = sanitizeFilterSelection(null, UNKNOWN, ALLOWED);
    assert.equal(r.shopId, null);
    assert.equal(r.changed, true);
  });

  test("11.4 a shop belonging to a DIFFERENT Retailer is dropped", () => {
    const r = sanitizeFilterSelection(R1, S2A, ALLOWED);
    assert.equal(r.retailerId, R1, "the valid Retailer is kept");
    assert.equal(r.shopId, null, "the incompatible shop is not forwarded");
    assert.equal(r.changed, true);
  });

  test("11.5 an unknown Retailer does not drag down a valid shop's own Retailer", () => {
    // Retailer unknown -> cleared; the shop is then judged against all pairs.
    const r = sanitizeFilterSelection(UNKNOWN, S1A, ALLOWED);
    assert.equal(r.retailerId, null);
    assert.equal(r.shopId, S1A);
  });

  test("11.6 an empty option set clears any selection", () => {
    const r = sanitizeFilterSelection(R1, S1A, []);
    assert.deepEqual(r, { retailerId: null, shopId: null, changed: true });
  });

  test("11.7 nothing distinguishes 'foreign' from 'no longer pending'", () => {
    // Both revert identically, so the outcome cannot be used to probe existence.
    const foreign = sanitizeFilterSelection(UNKNOWN, null, ALLOWED);
    const gone = sanitizeFilterSelection(R2, null, [{ retailerId: R1, shopId: S1A }]);
    assert.deepEqual(
      { r: foreign.retailerId, c: foreign.changed },
      { r: gone.retailerId, c: gone.changed },
    );
  });

  test("11.8 no selection at all is never 'changed'", () => {
    assert.deepEqual(sanitizeFilterSelection(null, null, ALLOWED), {
      retailerId: null,
      shopId: null,
      changed: false,
    });
  });
});

describe("12. picker rendering and dependent behaviour", () => {
  const ui = codeOf(QUEUE_FILTERS_UI);

  test("12.1 both pickers exist with default 'All' options", () => {
    assert.match(ui, /<option value="">All Retailers<\/option>/);
    assert.match(ui, /<option value="">All shops<\/option>/);
  });

  test("12.2 values use the two filter ids, labels use names", () => {
    assert.match(ui, /value=\{r\.id\}/);
    assert.match(ui, /\{r\.name\}/);
    assert.match(ui, /value=\{s\.shopId\}/);
    assert.match(ui, /s\.shopCode \? `\$\{s\.shopName\} \(\$\{s\.shopCode\}\)` : s\.shopName/);
  });

  test("12.3 Retailer choices are deduplicated", () => {
    assert.match(ui, /distinctRetailers\(safeOptions\)/);
    const adapter = codeOf(ADAPTER);
    assert.match(adapter, /export function distinctRetailers/);
    assert.match(adapter, /new Map<string, string>\(\)/);
  });

  test("12.4 shop choices narrow to the selected Retailer", () => {
    assert.match(ui, /shopsForRetailer\(safeOptions, inputs\.retailerId\)/);
    const adapter = codeOf(ADAPTER);
    assert.match(adapter, /export function shopsForRetailer/);
    assert.match(adapter, /o\.retailerId === retailerId/);
  });

  test("12.5 selections persist via defaultValue from the query string", () => {
    assert.match(ui, /defaultValue=\{inputs\.retailerId \?\? ""\}/);
    assert.match(ui, /defaultValue=\{inputs\.shopId \?\? ""\}/);
  });

  test("12.6 an options failure disables the pickers with retry copy", () => {
    assert.match(ui, /optionsUnavailable/);
    assert.match(ui, /disabled=\{optionsUnavailable\}/);
    assert.match(ui, /temporarily unavailable/i);
    assert.ok(
      !/options \?\? \[\]\s*;[\s\S]{0,80}<option/.test(ui) || ui.includes("optionsUnavailable"),
      "an empty picker must never stand in for a broken one",
    );
  });

  test("12.7 the filter form still carries no cursor", () => {
    assert.ok(!ui.includes(QUEUE_PARAM.cursorSubmittedAt));
    assert.ok(!ui.includes(QUEUE_PARAM.cursorReceiptId));
  });

  test("12.8 shop status is shown in text, not colour alone", () => {
    assert.match(ui, /s\.shopStatus !== "ACTIVE"/);
  });
});

describe("13. the page corrects an impossible selection", () => {
  const page = codeOf(QUEUE_PAGE);

  test("13.1 it sanitizes only when options were actually read", () => {
    assert.match(page, /filterOptions !== null && \(inputs\.retailerId \|\| inputs\.shopId\)/);
  });

  test("13.2 a changed selection redirects to a truthful URL", () => {
    assert.match(page, /sanitizeFilterSelection\(/);
    assert.match(page, /if \(safe\.changed\)/);
    assert.match(page, /redirect\(\s*buildClaimReviewQueueHref\(/);
  });

  test("13.3 the correction drops the cursor but keeps the dates", () => {
    // Bounded to the correction block itself. Slicing to end-of-file would sweep in
    // the next-page link further down, which legitimately DOES carry a cursor.
    const start = page.indexOf("if (safe.changed)");
    const block = page.slice(start, page.indexOf("return (", start));
    assert.ok(block.length > 0 && block.length < 800);
    assert.match(block, /submittedFromDate: inputs\.submittedFromDate/);
    assert.match(block, /submittedToDate: inputs\.submittedToDate/);
    // One argument only, so no cursor rides along into the corrected URL.
    assert.ok(
      !block.includes("nextCursor") && !block.includes("cursor"),
      "a corrected URL must not carry the old page cursor",
    );
  });

  test("13.4 options are passed to the filter component", () => {
    assert.match(page, /options=\{filterOptions\}/);
  });

  test("13.5 filtered-empty detection already covers all four filters", () => {
    const filters = codeOf(FILTERS_MOD);
    assert.match(
      filters,
      /hasActiveFilters:\s*\n?\s*retailerId !== null \|\|\s*\n?\s*shopId !== null \|\|\s*\n?\s*fromDate !== null \|\|\s*\n?\s*toDate !== null/,
    );
  });

  test("13.6 Clear filters returns to the bare path, dropping all four and the cursor", () => {
    assert.match(page, /href="\/review"/);
    assert.match(ui_clear(), /href="\/review"/);
  });
});

function ui_clear(): string {
  return codeOf(QUEUE_FILTERS_UI);
}
