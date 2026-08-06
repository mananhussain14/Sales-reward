/**
 * Tests for Phase 1D-A: the Claim Reviewer sale-header finalization Web UI.
 *
 * Run with:  npm test
 *
 * Two kinds, matching the other review suites:
 *
 *   1. REAL UNIT TESTS of the pure modules — the DST-choice validator, the
 *      settlement mapping and the money/time display. Every rule is exercised by
 *      CALLING the function rather than by reading its source.
 *
 *   2. SOURCE-SCANNING CONTRACT TESTS of the adapters, the Server Action and the
 *      panel. Those are `server-only` modules, a `"use server"` file and a Client
 *      Component: they cannot be invoked here. What they must NOT do is still
 *      checkable, and for this milestone the most valuable properties are
 *      NEGATIVE ones — no financial value may reach the database from a browser,
 *      and no unreadable state may present as finalizable.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY SOURCE RULE, so no comment can satisfy a
 * security test. These files explain at length the identifiers the rules forbid.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DST_AMBIGUITY_CHOICES,
  isDstAmbiguityChoice,
  validateSaleFinalizationInput,
} from "./claim-sale-finalization-input.ts";
import {
  isSaleFinalizationOutcome,
  SALE_FINALIZATION_OUTCOMES,
  settleSaleFinalizationOutcome,
  shouldRefreshAfterSaleFinalizationSettlement,
  INVALID_CHOICE_MESSAGE,
  NONEXISTENT_TIME_MESSAGE,
  NO_TIMEZONE_MESSAGE,
  REFRESHING_MESSAGE,
  SLOW_REQUEST_MESSAGE,
  SLOW_REQUEST_NOTICE_MS,
  UNCERTAIN_RESULT_MESSAGE,
} from "./claim-sale-finalization-settlement.ts";
import {
  changedFieldLabel,
  dstChoiceLabel,
  entryModeLabel,
  formatLocalPrinted,
  formatMinorAmount,
  formatUtcInstant,
  precisionLabel,
} from "./claim-sale-display.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DETAIL_DIR = join(ROOT, "app", "(review)", "review", "[receiptSubmissionId]");

const CONTEXT_ADAPTER = join(ROOT, "lib", "review", "claim-receipt-sale-context.ts");
const HEADER_ADAPTER = join(ROOT, "lib", "review", "verified-sale-header.ts");
const WRITE_ADAPTER = join(ROOT, "lib", "review", "finalize-claim-receipt-sale-header.ts");
const INPUT_MOD = join(ROOT, "lib", "review", "claim-sale-finalization-input.ts");
const SETTLEMENT_MOD = join(ROOT, "lib", "review", "claim-sale-finalization-settlement.ts");
const DISPLAY_MOD = join(ROOT, "lib", "review", "claim-sale-display.ts");
const ACTIONS = join(DETAIL_DIR, "sale-finalization-actions.ts");
const ACTION_STATE = join(DETAIL_DIR, "sale-finalization-action-state.ts");
const PANEL = join(DETAIL_DIR, "sale-header-panel.tsx");
const DETAIL_PAGE = join(DETAIL_DIR, "page.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}
function codeOf(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const PHASE_1D_A_WEB_FILES = [
  CONTEXT_ADAPTER, HEADER_ADAPTER, WRITE_ADAPTER, INPUT_MOD,
  SETTLEMENT_MOD, DISPLAY_MOD, ACTIONS, ACTION_STATE, PANEL,
];

/** Every financial or identity value a browser must never be able to assert. */
const FORBIDDEN_INPUTS = [
  "transactionDate", "transactionTime", "currencyCode", "totalMinor",
  "subtotalMinor", "taxTotalMinor", "merchantName", "documentNumber",
  "timezoneName", "saleAt", "vendorId", "vendorOrganizationId", "retailerId",
  "shopId", "profileId", "reviewerId", "membershipId", "confirmationId",
  "decisionId", "receiptConfirmationId", "receiptReviewDecisionId",
];

// ============================================================================
describe("1. the sale-context adapter", () => {
  const src = codeOf(CONTEXT_ADAPTER);

  test("1.1 it is server-only", () => {
    assert.match(src, /^import "server-only";/m);
  });

  test("1.2 it calls get_claim_receipt_sale_context and nothing else", () => {
    const rpcs = [...src.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)], ["get_claim_receipt_sale_context"]);
  });

  test("1.3 ordinary authenticated client, never service role", () => {
    assert.match(src, /from "@\/lib\/supabase\/server"/);
    assert.ok(!/supabase\/admin|createAdminClient|SERVICE_ROLE/.test(src));
  });

  test("1.4 it passes only the submission id", () => {
    const call = src.match(/\.rpc\("get_claim_receipt_sale_context",\s*\{([^}]*)\}/);
    assert.ok(call);
    assert.match(call[1], /p_submission_id/);
    assert.ok(!/vendor|actor|reviewer|member|role|organization/i.test(call[1]));
  });

  test("1.5 no direct table query of any kind", () => {
    assert.ok(!/\.from\("/.test(src));
    for (const t of ["verified_sales", "receipt_confirmations", "receipt_review_decisions", "receipt_qualification_events", "receipt_submissions"]) {
      assert.ok(!src.includes(t), `${t} must not be queried directly`);
    }
  });

  test("1.6 rows are mapped field by field, never spread", () => {
    assert.ok(!/\.\.\.row/.test(src));
    assert.match(src, /function toSaleContext\(/);
  });

  test("1.7 the browser-safe type carries no private identifier", () => {
    const t = src.match(/export type ClaimReceiptSaleContext = \{[\s\S]*?\n\};/);
    assert.ok(t);
    for (const forbidden of [
      "vendorId", "vendorOrganizationId", "retailerId", "shopId", "profileId",
      "membershipId", "roleId", "authUserId", "confirmationId", "decisionId",
      "exclusionEventId", "storageBucket", "objectPath", "fileSha256", "email", "phone",
    ]) {
      assert.ok(!t[0].includes(forbidden), `${forbidden} must not be a field`);
    }
  });

  test("1.8 missing, foreign and unauthorized collapse into one result", () => {
    assert.equal([...src.matchAll(/return \{ status: "not-found" \};/g)].length, 1);
  });

  test("1.9 an unusable row fails CLOSED as unavailable, never finalizable", () => {
    // The mapper returns null on unknown vocabulary, and the caller turns that
    // into `unavailable` — not into a default, finalizable context.
    assert.match(src, /if \(rawStatus !== null && !isSaleTimeStatus\(rawStatus\)\) return null;/);
    assert.match(src, /if \(rawPrecision !== null && !isSaleTimePrecision\(rawPrecision\)\) return null;/);
    assert.match(src, /if \(hasConfirmation && rawStatus === null\) return null;/);
    assert.match(src, /if \(context === null\)[\s\S]{0,140}status: "unavailable"/);
  });

  test("1.10 raw provider errors are never bound or logged", () => {
    assert.ok(!/error\.(message|details|hint|code)/.test(src));
    for (const [, , arg] of src.matchAll(/console\.(error|warn|log)\(([^)]*)\)/g)) {
      assert.match(arg.trim(), /^"[^"]*"$/);
    }
  });

  test("1.11 request-scoped React cache, not a global one", () => {
    assert.match(src, /import \{ cache \} from "react"/);
    assert.ok(!/unstable_cache|revalidate:|force-cache/.test(src));
  });
});

// ============================================================================
describe("2. the verified-sale-header adapter", () => {
  const src = codeOf(HEADER_ADAPTER);

  test("2.1 it is server-only and uses the ordinary client", () => {
    assert.match(src, /^import "server-only";/m);
    assert.match(src, /from "@\/lib\/supabase\/server"/);
    assert.ok(!/supabase\/admin|createAdminClient|SERVICE_ROLE/.test(src));
  });

  test("2.2 it calls get_verified_sale_header and nothing else", () => {
    const rpcs = [...src.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)], ["get_verified_sale_header"]);
  });

  test("2.3 it passes only the submission id", () => {
    const call = src.match(/\.rpc\("get_verified_sale_header",\s*\{([^}]*)\}/);
    assert.ok(call);
    assert.match(call[1], /p_submission_id/);
    assert.ok(!/vendor|actor|reviewer/i.test(call[1]));
  });

  test("2.4 it returns only safe immutable fields", () => {
    const t = src.match(/export type VerifiedSaleHeader = \{[\s\S]*?\n\};/);
    assert.ok(t);
    for (const forbidden of [
      "vendorOrganizationId", "retailerOrganizationId", "retailerShopId",
      "finalizedByProfileId", "receiptConfirmationId", "receiptReviewDecisionId",
      "storageBucket", "objectPath", "fileSha256", "email", "phone",
    ]) {
      assert.ok(!t[0].includes(forbidden), `${forbidden} must not be a field`);
    }
    assert.match(t[0], /finalizedByDisplayName/);
  });

  test("2.5 no direct table access, missing and foreign indistinguishable", () => {
    assert.ok(!/\.from\("/.test(src));
    assert.ok(!src.includes("verified_sales"));
    assert.equal([...src.matchAll(/return \{ status: "not-found" \};/g)].length, 1);
  });
});

// ============================================================================
describe("3. the finalization write adapter", () => {
  const w = codeOf(WRITE_ADAPTER);

  test("3.1 it is server-only and uses the ordinary client", () => {
    assert.match(w, /^import "server-only";/m);
    assert.match(w, /from "@\/lib\/supabase\/server"/);
    assert.ok(!/supabase\/admin|createAdminClient|SERVICE_ROLE/.test(w));
  });

  test("3.2 it calls finalize_claim_receipt_sale_header only", () => {
    const rpcs = [...w.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)], ["finalize_claim_receipt_sale_header"]);
  });

  test("3.3 exactly two RPC parameters", () => {
    const call = w.match(/\.rpc\("finalize_claim_receipt_sale_header",\s*\{([\s\S]*?)\}\)/);
    assert.ok(call);
    const params = [...call[1].matchAll(/(p_[a-z_]+):/g)].map((m) => m[1]);
    assert.deepEqual(params.sort(), ["p_dst_ambiguity_choice", "p_submission_id"]);
  });

  test("3.4 no financial value or identity is ever sent", () => {
    const call = w.match(/\.rpc\("finalize_claim_receipt_sale_header",\s*\{([\s\S]*?)\}\)/);
    assert.ok(call);
    assert.ok(!/total|subtotal|tax|currency|merchant|document|date|time|zone|vendor|actor|reviewer/i.test(call[1]));
  });

  test("3.5 no direct verified_sales query and no Web Audit Log", () => {
    assert.ok(!/\.from\("/.test(w));
    assert.ok(!w.includes("verified_sales"));
    assert.ok(!/audit_log|auditLog/i.test(w));
  });

  test("3.6 only the SQLSTATE is read from a provider error", () => {
    assert.ok(!/error\.(message|details|hint)/.test(w));
    assert.match(w, /function sqlstateOf\(/);
    for (const code of ["42501", "22007", "22023", "55000"]) {
      assert.ok(w.includes(code), `${code} must be mapped`);
    }
  });

  test("3.7 an unreadable outcome is unavailable, never success", () => {
    assert.match(w, /!isSaleFinalizationOutcome\(row\.outcome\)[\s\S]{0,200}status: "unavailable"/);
  });

  test("3.8 nothing raw is logged", () => {
    for (const [, , arg] of w.matchAll(/console\.(error|warn|log)\(([^)]*)\)/g)) {
      assert.match(arg.trim(), /^"[^"]*"$/);
    }
  });
});

// ============================================================================
describe("4. DST choice validation (real unit tests)", () => {
  const ok = (r: ReturnType<typeof validateSaleFinalizationInput>) => {
    assert.ok(r.ok, `expected valid, got ${JSON.stringify(r)}`);
    return r.ok ? r.value : null!;
  };
  const bad = (r: ReturnType<typeof validateSaleFinalizationInput>) => {
    assert.ok(!r.ok, "expected invalid");
    return r.ok ? null! : r.fieldErrors;
  };

  test("4.1 exactly two choices exist", () => {
    assert.deepEqual([...DST_AMBIGUITY_CHOICES], ["FIRST", "SECOND"]);
    assert.ok(isDstAmbiguityChoice("FIRST"));
    assert.ok(isDstAmbiguityChoice("SECOND"));
    assert.ok(!isDstAmbiguityChoice("THIRD"));
    assert.ok(!isDstAmbiguityChoice("first"));
  });

  test("4.2 an absent choice is valid — the normal case", () => {
    assert.equal(ok(validateSaleFinalizationInput({})).dstAmbiguityChoice, null);
    assert.equal(
      ok(validateSaleFinalizationInput({ dstAmbiguityChoice: "" })).dstAmbiguityChoice,
      null,
    );
  });

  test("4.3 FIRST and SECOND are accepted", () => {
    assert.equal(
      ok(validateSaleFinalizationInput({ dstAmbiguityChoice: "FIRST" })).dstAmbiguityChoice,
      "FIRST",
    );
    assert.equal(
      ok(validateSaleFinalizationInput({ dstAmbiguityChoice: "SECOND" })).dstAmbiguityChoice,
      "SECOND",
    );
  });

  test("4.4 whitespace-only becomes absent, not an error", () => {
    assert.equal(
      ok(validateSaleFinalizationInput({ dstAmbiguityChoice: "   \n\t " })).dstAmbiguityChoice,
      null,
    );
  });

  test("4.5 an unknown choice is rejected", () => {
    for (const v of ["THIRD", "first", "EARLIER", "0", "null"]) {
      assert.match(
        bad(validateSaleFinalizationInput({ dstAmbiguityChoice: v })).dstAmbiguityChoice!,
        /first or the second/,
      );
    }
  });

  test("4.6 non-string inputs never coerce into a match", () => {
    assert.equal(
      ok(validateSaleFinalizationInput({ dstAmbiguityChoice: ["FIRST"] })).dstAmbiguityChoice,
      null,
    );
    assert.equal(
      ok(validateSaleFinalizationInput({ dstAmbiguityChoice: { toString: () => "FIRST" } }))
        .dstAmbiguityChoice,
      null,
    );
  });

  test("4.7 the validator accepts no financial or identity field by construction", () => {
    const src = codeOf(INPUT_MOD);
    assert.ok(!/\bimport\b/.test(src), "the input module imported something");
    for (const f of FORBIDDEN_INPUTS) {
      assert.ok(!src.includes(f), `${f} must not be an input`);
    }
  });
});

// ============================================================================
describe("5. finalization settlement (real unit tests)", () => {
  test("5.1 exactly four authoritative outcomes exist", () => {
    assert.deepEqual(
      [...SALE_FINALIZATION_OUTCOMES],
      ["FINALIZED", "ALREADY_FINALIZED", "AMBIGUOUS_TIME_REQUIRES_CHOICE", "CONFLICT"],
    );
    assert.ok(isSaleFinalizationOutcome("FINALIZED"));
    assert.ok(!isSaleFinalizationOutcome("EXCLUDED"));
    assert.ok(!isSaleFinalizationOutcome("MISSING_CONFIRMATION"));
    assert.ok(!isSaleFinalizationOutcome("UNAVAILABLE"));
  });

  test("5.2 FINALIZED is the only outcome that changed anything", () => {
    assert.equal(settleSaleFinalizationOutcome("FINALIZED").changed, true);
    for (const o of ["ALREADY_FINALIZED", "AMBIGUOUS_TIME_REQUIRES_CHOICE", "CONFLICT"] as const) {
      assert.equal(settleSaleFinalizationOutcome(o).changed, false, o);
    }
  });

  test("5.3 only the ambiguity prompt stays unsettled", () => {
    assert.equal(settleSaleFinalizationOutcome("FINALIZED").settled, true);
    assert.equal(settleSaleFinalizationOutcome("ALREADY_FINALIZED").settled, true);
    assert.equal(settleSaleFinalizationOutcome("CONFLICT").settled, true);
    assert.equal(
      settleSaleFinalizationOutcome("AMBIGUOUS_TIME_REQUIRES_CHOICE").settled,
      false,
      "the reviewer must still be able to answer",
    );
  });

  test("5.4 FINALIZED states immutability, an unchanged decision and no reward", () => {
    const m = settleSaleFinalizationOutcome("FINALIZED").message;
    assert.match(m, /frozen/);
    assert.match(m, /cannot be edited or deleted/);
    assert.match(m, /VERIFIED review decision is unchanged/);
    assert.match(m, /no products, campaign result, reward or coins were created/i);
  });

  test("5.5 ALREADY_FINALIZED reads as idempotent, not as a failure", () => {
    const m = settleSaleFinalizationOutcome("ALREADY_FINALIZED").message;
    assert.match(m, /already/i);
    assert.match(m, /no second sale header or Audit Log/);
    assert.ok(!/error|failed|could not/i.test(m));
  });

  test("5.6 the ambiguity prompt asks a question and says no sale was created", () => {
    const m = settleSaleFinalizationOutcome("AMBIGUOUS_TIME_REQUIRES_CHOICE").message;
    assert.match(m, /happened twice/);
    assert.match(m, /No sale header was created/);
    assert.ok(!/error|failed/i.test(m));
  });

  test("5.7 CONFLICT names nobody and exposes no identifier", () => {
    const m = settleSaleFinalizationOutcome("CONFLICT").message;
    assert.match(m, /Nothing was changed/);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}/i.test(m));
    assert.ok(!/\breviewer [A-Z]|\bby [A-Z]/.test(m), "CONFLICT leaks an actor");
  });

  test("5.8 no outcome message promises a product, campaign, reward or coin", () => {
    for (const o of SALE_FINALIZATION_OUTCOMES) {
      const m = settleSaleFinalizationOutcome(o).message;
      assert.ok(
        !/(earned|awarded|granted) (a )?(reward|coin)|campaign qualified/i.test(m),
        o,
      );
    }
  });

  test("5.9 the uncertain message claims neither success nor failure", () => {
    assert.match(UNCERTAIN_RESULT_MESSAGE, /could not confirm/i);
    assert.match(UNCERTAIN_RESULT_MESSAGE, /Refresh/i);
    assert.match(UNCERTAIN_RESULT_MESSAGE, /will not create a second sale/);
    assert.ok(!/^Finalized|successfully|has been finalized/i.test(UNCERTAIN_RESULT_MESSAGE));
    assert.ok(
      UNCERTAIN_RESULT_MESSAGE.indexOf("could not confirm") <
        UNCERTAIN_RESULT_MESSAGE.indexOf("finalized"),
      "uncertainty must be stated before the word finalized appears",
    );
  });

  test("5.10 blocking time messages explain rather than blame", () => {
    assert.match(NONEXISTENT_TIME_MESSAGE, /did not exist/);
    assert.match(NONEXISTENT_TIME_MESSAGE, /clocks moved forward/);
    assert.match(NO_TIMEZONE_MESSAGE, /no time zone recorded/);
    assert.ok(!/UTC/.test(NO_TIMEZONE_MESSAGE), "must not suggest a UTC fallback");
    assert.match(INVALID_CHOICE_MESSAGE, /Refresh/);
  });

  test("5.11 refresh happens only after an authoritative, certain settlement", () => {
    assert.equal(
      shouldRefreshAfterSaleFinalizationSettlement({ settled: true, uncertain: false }),
      true,
    );
    // pending / validation failure
    assert.equal(
      shouldRefreshAfterSaleFinalizationSettlement({ settled: false, uncertain: false }),
      false,
    );
    // ambiguity prompt — unsettled on purpose
    assert.equal(
      shouldRefreshAfterSaleFinalizationSettlement({
        settled: settleSaleFinalizationOutcome("AMBIGUOUS_TIME_REQUIRES_CHOICE").settled,
        uncertain: false,
      }),
      false,
    );
    // uncertain transport failure
    assert.equal(
      shouldRefreshAfterSaleFinalizationSettlement({ settled: false, uncertain: true }),
      false,
    );
    assert.equal(
      shouldRefreshAfterSaleFinalizationSettlement({ settled: true, uncertain: true }),
      false,
    );
  });

  test("5.12 the slow notice tells the reviewer not to resubmit", () => {
    assert.match(SLOW_REQUEST_MESSAGE, /Do not submit again/i);
    assert.ok(!/failed|error|lost/i.test(SLOW_REQUEST_MESSAGE));
    assert.ok(SLOW_REQUEST_NOTICE_MS >= 2000 && SLOW_REQUEST_NOTICE_MS <= 10000);
  });

  test("5.13 the refreshing notice does not reopen the question", () => {
    assert.match(REFRESHING_MESSAGE, /recorded/i);
    assert.ok(!/may have|might|unknown/i.test(REFRESHING_MESSAGE));
  });

  test("5.14 the settlement module stays pure", () => {
    const src = codeOf(SETTLEMENT_MOD);
    assert.ok(!/\bimport\b/.test(src));
    assert.ok(!/next\/|supabase|fetch\(|process\.env|"use (server|client)"/.test(src));
  });
});

// ============================================================================
describe("6. money and time display (real unit tests)", () => {
  test("6.1 minor units come from the currency, never from a guess", () => {
    // AED has two, JPY none, KWD three. Dividing by 100 would be wrong twice.
    assert.equal(formatMinorAmount(12345, "AED")?.text, "AED 123.45");
    assert.equal(formatMinorAmount(1000, "JPY")?.text, "JPY 1,000");
    assert.equal(formatMinorAmount(12500, "KWD")?.text, "KWD 12.500");
  });

  test("6.2 exactness is reported, and an unknown currency is not scaled", () => {
    assert.equal(formatMinorAmount(12345, "AED")?.exact, true);
    const unknown = formatMinorAmount(12345, "ZZZ");
    assert.equal(unknown?.exact, false);
    assert.match(unknown!.text, /minor units/);
    assert.ok(!unknown!.text.includes("123.45"), "an unknown currency must not be scaled");
  });

  test("6.3 zero and small amounts pad correctly", () => {
    assert.equal(formatMinorAmount(0, "AED")?.text, "AED 0.00");
    assert.equal(formatMinorAmount(5, "AED")?.text, "AED 0.05");
    assert.equal(formatMinorAmount(5, "KWD")?.text, "KWD 0.005");
  });

  test("6.4 absent amounts and currencies render nothing", () => {
    assert.equal(formatMinorAmount(null, "AED"), null);
    assert.equal(formatMinorAmount(100, null), null);
  });

  test("6.5 instants render deterministically in UTC", () => {
    assert.equal(
      formatUtcInstant("2026-11-01T05:30:00+00:00"),
      "2026-11-01 05:30 UTC",
    );
    assert.equal(formatUtcInstant(null), null);
    assert.equal(formatUtcInstant("not a date"), null);
  });

  test("6.6 the printed local date and time are shown as printed", () => {
    assert.equal(formatLocalPrinted("2026-06-15", "14:30:00"), "2026-06-15 14:30");
    assert.equal(formatLocalPrinted("2026-06-15", null), "2026-06-15");
    assert.equal(formatLocalPrinted(null, "14:30:00"), null);
  });

  test("6.7 vocabularies are labelled, not echoed raw", () => {
    assert.match(entryModeLabel("MANUAL"), /Typed in/);
    assert.match(entryModeLabel("EXTRACTED"), /Read from the receipt/);
    assert.match(entryModeLabel("MIXED"), /corrections/);
    assert.equal(changedFieldLabel("total_minor"), "Total");
    assert.equal(changedFieldLabel("transaction_time"), "Time");
    assert.match(precisionLabel("DATE_ONLY")!, /no time was printed/i);
    assert.match(precisionLabel("MINUTE")!, /to the minute/);
    assert.match(dstChoiceLabel("FIRST")!, /earlier/);
    assert.match(dstChoiceLabel("SECOND")!, /later/);
    assert.equal(precisionLabel("DATE_TIME"), null, "DATE_TIME is not a vocabulary");
  });
});

// ============================================================================
describe("7. the Server Action", () => {
  const a = codeOf(ACTIONS);

  test("7.1 it reads exactly two form fields", () => {
    const reads = [...a.matchAll(/field\(formData, "([A-Za-z]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(reads)].sort(), [
      "dstAmbiguityChoice", "receiptSubmissionId",
    ]);
  });

  test("7.2 no financial value or identity is accepted anywhere", () => {
    for (const f of PHASE_1D_A_WEB_FILES) {
      const s = codeOf(f);
      assert.ok(
        !/formData\.get\("(total|subtotal|tax|currency|merchant|document|transaction|timezone|sale|vendor|actor|reviewer|member|confirmation|decision)/i.test(s),
        `${f} reads a forbidden form field`,
      );
      assert.ok(!/[?&](returnTo|redirect|next)=/.test(s), `${f} has a return URL`);
    }
  });

  test("7.3 the id shape is validated before any RPC", () => {
    assert.match(a, /isReceiptSubmissionId\(receiptSubmissionId\)/);
    assert.ok(a.indexOf("isReceiptSubmissionId") < a.indexOf("finalizeClaimReceiptSaleHeader("));
  });

  test("7.4 it revalidates nothing and never redirects", () => {
    assert.ok(!/revalidatePath/.test(a), "the action revalidates a path");
    assert.ok(!/from "next\/cache"/.test(a), "the action imports next/cache");
    assert.ok(!/redirect\(/.test(a), "the action redirects");
  });

  test("7.5 a settled state short-circuits a resubmission", () => {
    assert.match(a, /if \(prevState\.settled\)\s*\{\s*return prevState;/);
  });

  test("7.6 an outage never settles and never claims failure", () => {
    const outage = a.match(/result\.status === "unavailable"[\s\S]*?\n  \}/);
    assert.ok(outage);
    assert.ok(!/settled: true/.test(outage[0]));
    assert.match(outage[0], /uncertain: true/);
  });

  test("7.7 no Web-side Audit Log and no direct table access", () => {
    for (const f of PHASE_1D_A_WEB_FILES) {
      const s = codeOf(f);
      assert.ok(!/audit_log|auditLog/i.test(s), `${f}`);
      assert.ok(!/\.from\("/.test(s), `${f}`);
    }
  });

  test("7.8 nothing raw is logged", () => {
    assert.equal((a.match(/console\./g) ?? []).length, 0);
  });
});

// ============================================================================
describe("8. the sale-header panel", () => {
  const p = codeOf(PANEL);
  const page = codeOf(DETAIL_PAGE);

  test("8.1 the panel renders only for a VERIFIED decision", () => {
    assert.match(page, /d\.decision === "VERIFIED" \? \(\s*<SaleHeaderPanel/);
    assert.match(page, /d\.decision === "VERIFIED"[\s\S]{0,200}getClaimReceiptSaleContext/);
  });

  test("8.2 a failed context read renders unavailable, never finalizable", () => {
    assert.match(page, /saleContextResult\?\.status === "authorized" \? saleContextResult\.context : null/);
    assert.match(p, /const unavailable = context === null/);
    assert.match(p, /temporarily unavailable/);
    // The finalization affordance requires a readable context.
    assert.match(p, /const canOfferFinalization =\s*\n?\s*!unavailable && !excluded && !finalized && hasProposal && !timeBlocks/);
  });

  test("8.3 an excluded receipt offers no finalization control", () => {
    assert.match(p, /Sale finalization is blocked/);
    assert.match(p, /!unavailable && !finalized && excluded/);
    // The whole form block requires !excluded.
    assert.match(p, /!unavailable && !finalized && !excluded && hasProposal && context/);
  });

  test("8.4 the TEST_DATA reason is displayed in words", () => {
    assert.match(p, /"TEST_DATA"[\s\S]{0,60}"Test data"/);
    assert.match(p, /Exclusion reason/);
  });

  test("8.5 a missing staff proposal is a waiting state, not a failure", () => {
    assert.match(p, /Waiting for Sales Staff transaction details/);
    assert.match(p, /not a\s*\n?\s*problem with this receipt/);
  });

  test("8.6 a missing time zone blocks and never falls back to UTC", () => {
    assert.match(p, /timeStatus === "NO_TIMEZONE"/);
    assert.match(p, /no time zone recorded/);
    assert.match(p, /not\s*\n?\s*placed in UTC/);
  });

  test("8.7 a nonexistent local time blocks and is not silently adjusted", () => {
    assert.match(p, /timeStatus === "NONEXISTENT"/);
    assert.match(p, /did not exist/);
    assert.match(p, /not silently adjusted/);
    assert.match(p, /const timeBlocks =\s*\n?\s*timeStatus === "NONEXISTENT" \|\| timeStatus === "NO_TIMEZONE"/);
  });

  test("8.8 an ambiguous time offers both candidates and preselects neither", () => {
    assert.match(p, /const ambiguous = timeStatus === "AMBIGUOUS"/);
    assert.match(p, /First occurrence/);
    assert.match(p, /Second occurrence/);
    assert.match(p, /firstSaleAtCandidate/);
    assert.match(p, /secondSaleAtCandidate/);
    // The choice starts null and is only set by a real change event.
    assert.match(p, /useState<DstAmbiguityChoice \| null>\(null\)/);
    assert.match(p, /checked=\{choice === option\.code\}/);
    assert.ok(!/defaultChecked/.test(p), "a choice must never be preselected");
  });

  test("8.9 the ambiguous state cannot be confirmed without a choice", () => {
    assert.match(p, /const readyToConfirm = !ambiguous \|\| choice !== null/);
    assert.match(p, /disabled=\{!canOfferFinalization \|\| !readyToConfirm \|\| pending\}/);
  });

  test("8.10 date-only explains local noon and shows the preview", () => {
    assert.match(p, /Resolved to 12:00 local time/);
    assert.match(p, /resolvedSaleAtPreview/);
  });

  test("8.11 the finalized state is read-only with no correction control", () => {
    assert.match(p, /function FinalizedHeaderBody/);
    assert.match(p, /cannot be edited or deleted/);
    assert.match(p, /Finalized by/);
    // The form is not rendered at all once finalized.
    assert.match(p, /!unavailable && !finalized && !excluded && hasProposal/);
  });

  test("8.12 no product, campaign, reward or coin UI exists", () => {
    for (const f of PHASE_1D_A_WEB_FILES) {
      const s = codeOf(f);
      assert.ok(!/productId|quantity|lineItem|campaignId|rewardAmount|coinAmount|payout/i.test(s), `${f}`);
    }
    // The copy explicitly denies them.
    assert.match(p, /no reward or coins/i);
    assert.match(p, /No products are being confirmed/);
    assert.match(p, /no campaign is being\s*\n?\s*evaluated/i);
  });

  test("8.13 the proposal is read-only — no editable financial input", () => {
    const inputs = [...p.matchAll(/<input[^>]*name="([A-Za-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(inputs)].sort(), [
      "dstAmbiguityChoice", "receiptSubmissionId",
    ]);
    assert.ok(!/<textarea/.test(p), "no free-text field belongs on this panel");
  });

  test("8.14 exactly one submit control, inside the dialog", () => {
    const submits = [...p.matchAll(/type="submit"/g)];
    assert.equal(submits.length, 1);
    assert.ok(submits[0].index! > p.indexOf('role="dialog"'));
  });

  test("8.15 the confirmation dialog states every required consequence", () => {
    assert.match(p, /accepting the Sales Staff transaction details/);
    assert.match(p, /The VERIFIED review decision will not change/);
    assert.match(p, /frozen permanently/);
    assert.match(p, /will not move/);
    assert.match(p, /append-only and audited/);
    assert.match(p, /active qualification\s*\n?\s*exclusion is recorded first, this will be refused/);
  });

  test("8.16 outcome renders before any refresh is requested", () => {
    assert.ok(p.indexOf("state.settled ?") < p.indexOf("{REFRESHING_MESSAGE}"));
    assert.match(p, /useEffect\(\(\) => \{\s*if \(!shouldRefreshAfterSaleFinalizationSettlement\(state\)\) return;/);
  });

  test("8.17 the refresh is requested at most once, from one call site", () => {
    assert.equal((p.match(/router\.refresh\(/g) ?? []).length, 1);
    assert.match(p, /refreshRequested = useRef\(false\)/);
    assert.match(p, /if \(refreshRequested\.current\) return;/);
    assert.match(p, /refreshRequested\.current = true;/);
  });

  test("8.18 the slow notice is presentation only and there is no polling", () => {
    const slow = p.match(/slowTimer\.current = setTimeout\([\s\S]{0,120}/);
    assert.ok(slow);
    assert.match(slow[0], /setSlow\(true\)/);
    assert.ok(!/formAction|finalizeSaleHeaderAction/.test(slow[0]));
    assert.equal((p.match(/setTimeout\(/g) ?? []).length, 1);
    assert.equal((p.match(/setInterval\(/g) ?? []).length, 0);
    assert.match(p, /onSubmit=\{armSlowNotice\}/);
  });

  test("8.19 nothing retries or resubmits automatically", () => {
    for (const f of [PANEL, ACTIONS]) {
      const s = codeOf(f).replace(/attempt/gi, "");
      assert.ok(!/\bretry\b|\bresubmit\b/i.test(s), `${f}`);
    }
    assert.equal((p.match(/<form[\s\S]{0,80}?action=\{formAction\}/g) ?? []).length, 1);
  });

  test("8.20 an uncertain result offers a deliberate refresh, not a resubmit", () => {
    assert.match(p, /state\.uncertain \? \(/);
    assert.match(p, /Refresh sale status/);
    const btn = p.match(/onClick=\{refreshSaleStatus\}[\s\S]{0,200}/);
    assert.ok(btn);
    assert.ok(!/type="submit"/.test(btn[0]));
  });

  test("8.21 the ambiguity prompt returns focus to the choices and does not settle", () => {
    assert.match(p, /if \(state\.needsDstChoice\) choiceGroupRef\.current\?\.focus\(\)/);
    assert.match(p, /state\.outcome === "AMBIGUOUS_TIME_REQUIRES_CHOICE" && !state\.settled/);
  });

  test("8.22 statuses are announced and not colour-only", () => {
    assert.ok((p.match(/role="status"/g) ?? []).length >= 2);
    assert.match(p, /\{slow \? SLOW_REQUEST_MESSAGE : "Finalizing sale…"\}/);
    // Every badge carries a word.
    assert.match(p, /Finalized[\s\S]{0,120}Blocked by exclusion[\s\S]{0,120}Not yet finalized/);
  });

  test("8.23 the dialog is accessible and focus-managed", () => {
    assert.match(p, /role="dialog"/);
    assert.match(p, /aria-modal="true"/);
    assert.match(p, /aria-labelledby=\{headingId\}/);
    assert.match(p, /aria-describedby=\{descriptionId\}/);
    assert.match(p, /tabIndex=\{-1\}/);
    assert.match(p, /dialogRef\.current\?\.focus\(\)/);
    assert.match(p, /openerRef\.current\?\.focus\(\)/);
    assert.match(p, /event\.key === "Escape" && !pending/);
  });

  test("8.24 no optimistic sale state", () => {
    assert.ok(!/useOptimistic|setFinalized|setHeader/.test(p));
  });

  test("8.25 the panel never sees a Vendor, actor or lineage id", () => {
    for (const forbidden of ["vendorId", "vendorOrganizationId", "retailerOrganizationId", "confirmationId", "decisionId", "profileId", "membershipId"]) {
      assert.ok(!p.includes(forbidden), `${forbidden} must not reach the panel`);
    }
  });
});

// ============================================================================
describe("9. milestone boundaries", () => {
  // SUPERSEDED BY PHASE 1D-B, WHICH ADDED MIGRATION 64 BY APPROVAL.
  //
  // The durable property this Web milestone owns is that IT added no SQL — which
  // 9.2 asserts directly against its own files. The running total is pinned here
  // with the current number so it still fails loudly on an unapproved 65th.
  test("9.1 the Phase 1D-A migration is unrenamed, and 1D-B's is the only one after it", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    // SUPERSEDED BY MIGRATIONS 65-69. The original pinned a running total that every
    // later approved milestone falsifies, and it had been failing since Migration 65
    // because those units ran only the database suite. What THIS file owns is that its
    // OWN milestone still contributes exactly what it did, in its original position,
    // under its original name — so that is pinned, and the total is asserted as a
    // floor rather than as a number this file has no authority over.
    assert.ok(files.length >= 64, "migrations are never removed");
    assert.equal(files[62], "20260821090000_verified_sale_headers.sql");
    assert.equal(
      files[63],
      "20260822090000_receipt_product_proposals_and_sale_items.sql",
    );
  });

  test("9.2 this milestone adds no SQL of its own", () => {
    for (const f of PHASE_1D_A_WEB_FILES) {
      assert.ok(!f.endsWith(".sql"), `${f} must not be SQL`);
      const s = codeOf(f);
      assert.ok(!/create table|alter table|insert into|drop table/i.test(s), `${f} contains DDL`);
    }
  });

  test("9.3 no service-role client anywhere in this milestone", () => {
    for (const f of PHASE_1D_A_WEB_FILES) {
      assert.ok(!/createAdminClient|supabase\/admin|SERVICE_ROLE/.test(codeOf(f)), f);
    }
  });

  test("9.4 nothing hard-codes a receipt, reviewer, filename or credential", () => {
    for (const f of [...PHASE_1D_A_WEB_FILES, join(ROOT, "docs", "claim-reviewer-sale-header-finalization-web.md")]) {
      if (!existsSync(f)) continue;
      const s = read(f);
      const uuids = [...s.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)].map((m) => m[0]);
      assert.deepEqual(uuids, [], `hard-coded UUID in ${f}`);
      assert.ok(!/@(gmail|yahoo|outlook|hotmail)\./i.test(s), `email in ${f}`);
      assert.ok(!/eyJ[A-Za-z0-9_-]{10,}|sb_(secret|publishable)_/.test(s), `credential in ${f}`);
      assert.ok(!/dmyzdcnbeurlqiwozpae/.test(s), `hosted project ref in ${f}`);
    }
  });

  test("9.5 documentation exists and explains the reviewer model", () => {
    const doc = join(ROOT, "docs", "claim-reviewer-sale-header-finalization-web.md");
    assert.ok(existsSync(doc));
    const s = read(doc);
    assert.match(s, /accept/i);
    assert.match(s, /FIRST/);
    assert.match(s, /SECOND/);
    assert.match(s, /TEST_DATA/);
    assert.match(s, /migration 63/i);
  });
});
