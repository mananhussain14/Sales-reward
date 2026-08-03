/**
 * Tests for Phase 1D-0: append-only receipt qualification exclusions (Web side).
 *
 * Run with:  npm test
 *
 * Two kinds, matching the other review suites:
 *
 *   1. REAL UNIT TESTS of lib/review/claim-receipt-qualification-input.ts, a pure
 *      module with no imports and no I/O. Every action, reason and note rule is
 *      exercised by calling the validator rather than by reading its source.
 *
 *   2. SOURCE-SCANNING CONTRACT TESTS of the adapters, the Server Action and the
 *      panel. Those are `server-only` modules, a `"use server"` file and a Client
 *      Component: they cannot be invoked here. What they must NOT do is still
 *      checkable, and for this milestone the most valuable property is a NEGATIVE
 *      one — nothing in the whole flow may touch the review decision.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY SOURCE RULE, so no comment can satisfy a
 * security test. These files explain at length the identifiers the rules forbid.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  EXCLUSION_REASON_HINTS,
  EXCLUSION_REASON_LABELS,
  EXCLUSION_REASONS,
  isExclusionReason,
  isQualificationAction,
  QUALIFICATION_ACTIONS,
  QUALIFICATION_NOTE_MAX_LENGTH,
  reasonRequiresNote,
  REASONS_REQUIRING_NOTE,
  validateQualificationInput,
} from "./claim-receipt-qualification-input.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DETAIL_DIR = join(ROOT, "app", "(review)", "review", "[receiptSubmissionId]");

const READ_ADAPTER = join(ROOT, "lib", "review", "claim-receipt-qualification.ts");
const WRITE_ADAPTER = join(ROOT, "lib", "review", "claim-receipt-qualification-write.ts");
const INPUT_MOD = join(ROOT, "lib", "review", "claim-receipt-qualification-input.ts");
const ACTIONS = join(DETAIL_DIR, "qualification-actions.ts");
const ACTION_STATE = join(DETAIL_DIR, "qualification-action-state.ts");
const PANEL = join(DETAIL_DIR, "qualification-panel.tsx");
const DETAIL_PAGE = join(DETAIL_DIR, "page.tsx");
const MIGRATION = join(
  ROOT, "supabase", "migrations", "20260820090000_receipt_qualification_exclusions.sql",
);

function read(p: string): string {
  return readFileSync(p, "utf8");
}
function codeOf(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const PHASE_1D_0_FILES = [
  READ_ADAPTER, WRITE_ADAPTER, INPUT_MOD, ACTIONS, ACTION_STATE, PANEL,
];

// ============================================================================
describe("1. the read adapter", () => {
  const src = codeOf(READ_ADAPTER);

  test("1.1 it is server-only", () => {
    assert.match(src, /^import "server-only";/m);
  });

  test("1.2 it calls get_claim_receipt_qualification and nothing else", () => {
    const rpcs = [...src.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)], ["get_claim_receipt_qualification"]);
  });

  test("1.3 ordinary authenticated client, never service role", () => {
    assert.match(src, /from "@\/lib\/supabase\/server"/);
    assert.ok(!/supabase\/admin|createAdminClient|SERVICE_ROLE/.test(src));
  });

  test("1.4 it passes only the submission id", () => {
    const call = src.match(/\.rpc\("get_claim_receipt_qualification",\s*\{([^}]*)\}/);
    assert.ok(call);
    assert.match(call[1], /p_submission_id/);
    assert.ok(!/vendor|actor|reviewer|member|role|organization/i.test(call[1]));
  });

  test("1.5 no direct query of the event table or any table", () => {
    assert.ok(!/\.from\("/.test(src));
    assert.ok(!/receipt_qualification_events/.test(src));
  });

  test("1.6 rows are mapped field by field, never spread", () => {
    assert.ok(!/\.\.\.row/.test(src));
    assert.match(src, /function toQualification\(/);
  });

  test("1.7 the browser-safe type carries no private identifier", () => {
    const t = src.match(/export type ClaimReceiptQualification = \{[\s\S]*?\n\};/);
    assert.ok(t);
    for (const forbidden of [
      "vendorId", "vendorOrganizationId", "retailerId", "shopId", "profileId",
      "membershipId", "roleId", "authUserId", "eventId", "reversesEventId",
      "storageBucket", "objectPath", "fileSha256", "email", "phone",
    ]) {
      assert.ok(!t[0].includes(forbidden), `${forbidden} must not be a field`);
    }
  });

  test("1.8 missing, foreign and unauthorized collapse into one result", () => {
    const returns = [...src.matchAll(/return \{ status: "not-found" \};/g)];
    assert.equal(returns.length, 1);
  });

  test("1.9 raw provider errors are never bound or logged", () => {
    assert.ok(!/error\.(message|details|hint|code)/.test(src));
    for (const [, , arg] of src.matchAll(/console\.(error|warn|log)\(([^)]*)\)/g)) {
      assert.match(arg.trim(), /^"[^"]*"$/);
    }
  });

  test("1.10 request-scoped React cache, not a global one", () => {
    assert.match(src, /import \{ cache \} from "react"/);
    assert.ok(!/unstable_cache|revalidate:|force-cache/.test(src));
  });
});

// ============================================================================
describe("2. the write adapter and Server Action", () => {
  const w = codeOf(WRITE_ADAPTER);
  const a = codeOf(ACTIONS);

  test("2.1 the write adapter calls record_claim_receipt_qualification only", () => {
    const rpcs = [...w.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)], ["record_claim_receipt_qualification"]);
  });

  test("2.2 ordinary authenticated client, never service role", () => {
    assert.match(w, /from "@\/lib\/supabase\/server"/);
    assert.ok(!/supabase\/admin|createAdminClient|SERVICE_ROLE/.test(w));
  });

  test("2.3 exactly four RPC parameters, none an identity or event id", () => {
    const call = w.match(/\.rpc\("record_claim_receipt_qualification",\s*\{([\s\S]*?)\}\)/);
    assert.ok(call);
    const params = [...call[1].matchAll(/(p_[a-z_]+):/g)].map((m) => m[1]);
    assert.deepEqual(params.sort(), [
      "p_action", "p_exclusion_reason", "p_reviewer_note", "p_submission_id",
    ]);
  });

  test("2.4 the action reads exactly four form fields", () => {
    const reads = [...a.matchAll(/field\(formData, "([A-Za-z]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(reads)].sort(), [
      "action", "exclusionReason", "receiptSubmissionId", "reviewerNote",
    ]);
  });

  test("2.5 no Vendor, actor, event id or return URL is accepted anywhere", () => {
    for (const f of PHASE_1D_0_FILES) {
      const s = codeOf(f);
      assert.ok(!/formData\.get\("(vendor|actor|reviewer|member|role|event)/i.test(s));
      assert.ok(!/reverses_event_id|reversesEventId/.test(s), `${f}`);
      assert.ok(!/[?&](returnTo|redirect|next)=/.test(s));
    }
  });

  test("2.6 the id shape is validated before any RPC", () => {
    assert.match(a, /isReceiptSubmissionId\(receiptSubmissionId\)/);
    assert.ok(
      a.indexOf("isReceiptSubmissionId") < a.indexOf("recordClaimReceiptQualification("),
    );
  });

  test("2.7 no Web-side Audit Log insert anywhere", () => {
    for (const f of PHASE_1D_0_FILES) {
      assert.ok(!/audit_log|auditLog/i.test(codeOf(f)), `${f}`);
    }
  });

  test("2.8 nothing touches the review decision or the receipt row", () => {
    for (const f of PHASE_1D_0_FILES) {
      const s = codeOf(f);
      assert.ok(!/receipt_review_decisions/.test(s), `${f}`);
      assert.ok(!/receipt_submissions/.test(s), `${f}`);
      assert.ok(!/\.update\(|\.delete\(|\.upsert\(/.test(s), `${f}`);
    }
  });

  test("2.9 no raw form value or note text is logged", () => {
    assert.ok(!/console\.[a-z]+\([^)]*(formData|reviewerNote|validated|receiptSubmissionId)/.test(a));
    for (const [, , arg] of (w + a).matchAll(/console\.(error|warn|log)\(([^)]*)\)/g)) {
      assert.match(arg.trim(), /^"[^"]*"$/);
    }
  });

  test("2.10 only the detail path is revalidated, not the queue", () => {
    assert.match(a, /revalidatePath\(`\/review\/\$\{receiptSubmissionId\}`\)/);
    assert.ok(
      !/revalidatePath\("\/review"\)/.test(a),
      "a decided receipt is already absent from the queue",
    );
  });

  test("2.11 revalidation happens only after an authoritative outcome", () => {
    const rev = a.indexOf("revalidatePath(");
    assert.ok(a.indexOf('result.status === "unavailable"') < rev);
    assert.ok(a.indexOf('result.status === "refused"') < rev);
  });

  test("2.12 a settled state short-circuits a resubmission", () => {
    assert.match(a, /if \(prevState\.settled\)\s*\{\s*return prevState;/);
  });

  test("2.13 all five outcomes are handled, and an outage never settles", () => {
    for (const o of ["EXCLUDED", "ALREADY_EXCLUDED", "REINSTATED", "ALREADY_REINSTATED", "CONFLICT"]) {
      assert.ok(a.includes(o), `${o} must be handled`);
    }
    const outage = a.match(/result\.status === "unavailable"[\s\S]*?\n  \}/);
    assert.ok(outage);
    assert.ok(!/settled: true/.test(outage[0]));
  });

  test("2.14 an unreadable outcome is unavailable, never success", () => {
    assert.match(w, /!isOutcome\(row\.outcome\)[\s\S]{0,200}status: "unavailable"/);
  });
});

// ============================================================================
describe("3. input validation (real unit tests)", () => {
  const ok = (r: ReturnType<typeof validateQualificationInput>) => {
    assert.ok(r.ok, `expected valid, got ${JSON.stringify(r)}`);
    return r.ok ? r.value : null!;
  };
  const bad = (r: ReturnType<typeof validateQualificationInput>) => {
    assert.ok(!r.ok, "expected invalid");
    return r.ok ? null! : r.fieldErrors;
  };

  test("3.1 exactly two actions and three reasons exist", () => {
    assert.deepEqual([...QUALIFICATION_ACTIONS], ["EXCLUDE", "REINSTATE"]);
    assert.deepEqual([...EXCLUSION_REASONS], ["TEST_DATA", "NON_QUALIFYING", "DUPLICATE"]);
    assert.ok(!(EXCLUSION_REASONS as readonly string[]).includes("ADMINISTRATIVE_EXCLUSION"));
  });

  test("3.2 every reason has a label and a hint", () => {
    for (const r of EXCLUSION_REASONS) {
      assert.ok(EXCLUSION_REASON_LABELS[r]?.length > 0);
      assert.ok(EXCLUSION_REASON_HINTS[r]?.length > 0);
    }
    assert.equal(EXCLUSION_REASON_LABELS.TEST_DATA, "Test data");
  });

  test("3.3 EXCLUDE with each reason is accepted", () => {
    assert.equal(ok(validateQualificationInput({ action: "EXCLUDE", exclusionReason: "TEST_DATA" })).exclusionReason, "TEST_DATA");
    assert.equal(ok(validateQualificationInput({ action: "EXCLUDE", exclusionReason: "DUPLICATE" })).exclusionReason, "DUPLICATE");
    assert.equal(ok(validateQualificationInput({ action: "EXCLUDE", exclusionReason: "NON_QUALIFYING", reviewerNote: "why" })).exclusionReason, "NON_QUALIFYING");
  });

  test("3.4 EXCLUDE requires a reason", () => {
    assert.match(bad(validateQualificationInput({ action: "EXCLUDE" })).exclusionReason!, /Choose a reason/);
  });

  test("3.5 an unknown reason is refused", () => {
    for (const r of ["FRAUD", "test_data", "ADMINISTRATIVE_EXCLUSION", "OTHER"]) {
      assert.match(
        bad(validateQualificationInput({ action: "EXCLUDE", exclusionReason: r })).exclusionReason!,
        /not recognised/,
      );
    }
  });

  test("3.6 an unknown action is refused", () => {
    for (const x of ["DELETE", "exclude", "", null, 7, ["EXCLUDE"]]) {
      assert.ok(bad(validateQualificationInput({ action: x })).action);
    }
    assert.ok(isQualificationAction("EXCLUDE"));
    assert.ok(!isQualificationAction("DELETE"));
  });

  test("3.7 REINSTATE takes no reason", () => {
    assert.ok(validateQualificationInput({ action: "REINSTATE" }).ok);
    assert.match(
      bad(validateQualificationInput({ action: "REINSTATE", exclusionReason: "TEST_DATA" })).exclusionReason!,
      /cannot carry an exclusion reason/,
    );
  });

  test("3.8 NON_QUALIFYING requires a note; whitespace does not satisfy it", () => {
    assert.match(
      bad(validateQualificationInput({ action: "EXCLUDE", exclusionReason: "NON_QUALIFYING" })).reviewerNote!,
      /note is required/,
    );
    assert.match(
      bad(validateQualificationInput({ action: "EXCLUDE", exclusionReason: "NON_QUALIFYING", reviewerNote: "   " })).reviewerNote!,
      /note is required/,
    );
    assert.deepEqual([...REASONS_REQUIRING_NOTE], ["NON_QUALIFYING"]);
    assert.ok(reasonRequiresNote("NON_QUALIFYING"));
  });

  test("3.9 TEST_DATA and DUPLICATE notes are optional", () => {
    for (const r of ["TEST_DATA", "DUPLICATE"] as const) {
      assert.ok(validateQualificationInput({ action: "EXCLUDE", exclusionReason: r }).ok);
      assert.ok(!reasonRequiresNote(r));
    }
    assert.ok(!reasonRequiresNote(null));
  });

  test("3.10 the note is trimmed and blank becomes absent", () => {
    assert.equal(
      ok(validateQualificationInput({ action: "EXCLUDE", exclusionReason: "TEST_DATA", reviewerNote: "  desktop  " })).reviewerNote,
      "desktop",
    );
    assert.equal(
      ok(validateQualificationInput({ action: "EXCLUDE", exclusionReason: "TEST_DATA", reviewerNote: " \n\t " })).reviewerNote,
      null,
    );
  });

  test("3.11 500 accepted, 501 refused, measured after trimming", () => {
    const at = "x".repeat(QUALIFICATION_NOTE_MAX_LENGTH);
    assert.ok(validateQualificationInput({ action: "EXCLUDE", exclusionReason: "TEST_DATA", reviewerNote: at }).ok);
    assert.ok(validateQualificationInput({ action: "EXCLUDE", exclusionReason: "TEST_DATA", reviewerNote: `  ${at}  ` }).ok);
    assert.match(
      bad(validateQualificationInput({ action: "EXCLUDE", exclusionReason: "TEST_DATA", reviewerNote: "x".repeat(501) })).reviewerNote!,
      /at most 500 characters/,
    );
    assert.equal(QUALIFICATION_NOTE_MAX_LENGTH, 500);
  });

  test("3.12 non-string inputs never coerce into a match", () => {
    assert.ok(!validateQualificationInput({ action: { toString: () => "EXCLUDE" } }).ok);
    assert.ok(!isExclusionReason(["TEST_DATA"]));
  });
});

// ============================================================================
describe("4. the qualification panel", () => {
  const p = codeOf(PANEL);
  const page = codeOf(DETAIL_PAGE);

  test("4.1 the panel renders only for a VERIFIED decision", () => {
    assert.match(page, /d\.decision === "VERIFIED" \? \(/);
    assert.match(page, /<QualificationPanel/);
    // and the read is also gated on VERIFIED, so a rejected receipt costs no RPC
    assert.match(page, /d\.decision === "VERIFIED"\s*\?\s*await getClaimReceiptQualification/);
  });

  test("4.2 the unclassified copy does not claim reward eligibility", () => {
    assert.match(p, /Not excluded from future qualification/);
    assert.match(p, /does <strong>not<\/strong> mean the receipt is reward-eligible/);
    assert.match(p, /No sale\s*\n?\s*and no reward exists/);
  });

  test("4.3 exactly the three reasons are offered", () => {
    assert.match(p, /EXCLUSION_REASONS\.map/);
    assert.ok(!/ADMINISTRATIVE/.test(p));
  });

  test("4.4 the required-note state is stated in words with a live count", () => {
    assert.match(p, /A note is required for/);
    assert.match(p, /\{trimmedNote\.length\} of \{QUALIFICATION_NOTE_MAX_LENGTH\}/);
  });

  test("4.5 the confirmation states the review decision does not change", () => {
    assert.match(p, /The VERIFIED review decision will not change/);
    assert.match(p, /stays visible in review history/);
  });

  test("4.6 the confirmation states what exclusion actually blocks", () => {
    assert.match(p, /will not be\s*\n?\s*able to become an authoritative sale/);
    assert.match(p, /append-only, audited event/);
    assert.match(p, /cannot\s*\n?\s*be edited or deleted/);
  });

  test("4.7 the excluded state shows reason, note, time and reviewer", () => {
    assert.match(p, /<Row label="Reason">/);
    assert.match(p, /<Row label="Note">/);
    assert.match(p, /<Row label="Recorded">/);
    assert.match(p, /<Row label="Recorded by">/);
    assert.match(p, /Its VERIFIED review decision is unchanged/);
  });

  test("4.8 reinstatement is described as append-only reversal, never deletion", () => {
    assert.match(p, /Reconsider this exclusion/);
    assert.match(p, /new append-only reversal event/);
    assert.match(p, /original exclusion is not deleted/);
    for (const forbidden of [/\bDelete exclusion\b/i, /\bEdit exclusion\b/i, /\bRemove exclusion\b/i, /\bUndo exclusion\b/i]) {
      assert.ok(!forbidden.test(p), `${forbidden}`);
    }
  });

  test("4.9 reinstating is not presented as creating a reward", () => {
    assert.match(p, /does not by itself create a sale, a reward or any coins/);
  });

  test("4.10 the dialog is accessible and focus-managed", () => {
    assert.match(p, /role="dialog"/);
    assert.match(p, /aria-modal="true"/);
    assert.match(p, /aria-labelledby=\{headingId\}/);
    assert.match(p, /aria-describedby=\{descriptionId\}/);
    assert.match(p, /tabIndex=\{-1\}/);
    assert.match(p, /dialogRef\.current\?\.focus\(\)/);
    assert.match(p, /event\.key === "Escape" && !pending/);
  });

  test("4.11 exactly one submit, inside the dialog, disabled while pending", () => {
    const submits = [...p.matchAll(/type="submit"/g)];
    assert.equal(submits.length, 1);
    assert.ok(submits[0].index! > p.indexOf('role="dialog"'));
    assert.match(p, /loading=\{pending\}/);
    assert.match(p, /disabled=\{pending\}/);
  });

  test("4.12 pending is announced and nothing is optimistic", () => {
    assert.match(p, /role="status"/);
    assert.ok(!/useOptimistic|setExcluded/.test(p));
    // The panel gates in JSX rather than by early return: the form renders only
    // while NOT settled, and the outcome Alert renders only once it is. Either way
    // `state.settled` — set solely by the database's answer — is the authority.
    assert.match(p, /!unavailable && !state\.settled \? \(/);
    assert.match(p, /\{state\.settled \? \(/);
  });

  test("4.13 badges carry text, not colour alone", () => {
    assert.match(p, /Excluded from qualification[\s\S]*:[\s\S]*Not excluded/);
  });

  test("4.14 an unreadable state says so rather than showing 'not excluded'", () => {
    assert.match(p, /const unavailable = qualification === null/);
    assert.match(p, /temporarily unavailable/);
  });
});

// ============================================================================
describe("5. migration and milestone boundaries", () => {
  test("5.1 exactly one migration was added — 62 total, no 63", () => {
    const dir = join(ROOT, "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    assert.equal(files.length, 62);
    assert.equal(files[61], "20260820090000_receipt_qualification_exclusions.sql");
  });

  test("5.2 the migration is additive: no drop, alter-of-existing, update or delete", () => {
    const sql = read(MIGRATION)
      .replace(/^\s*--.*$/gm, "");
    assert.equal((sql.match(/^\s*drop\s/gim) ?? []).length, 0);
    assert.equal((sql.match(/^\s*truncate\s/gim) ?? []).length, 0);
    assert.equal((sql.match(/^\s*delete\s+from\s/gim) ?? []).length, 0);
    // No UPDATE STATEMENT against any table. The three `update` tokens in this file
    // are all legitimate and none of them mutates a row: the ON CONFLICT upsert of
    // the permission catalogue, the `before update or delete` trigger declaration,
    // and the `for update` row lock.
    assert.equal((sql.match(/^\s*update\s+\w+[\s\S]{0,80}?\bset\b/gim) ?? []).length, 0);
    assert.match(sql, /on conflict \(code\) do update/);
    assert.match(sql, /before update or delete on public\.receipt_qualification_events/);
    assert.match(sql, /for update;/);
    assert.ok(!/alter table public\.receipt_review_decisions/i.test(sql));
    assert.ok(!/alter table public\.receipt_submissions/i.test(sql));
  });

  test("5.3 it creates exactly one table and one permission", () => {
    const sql = read(MIGRATION).replace(/^\s*--.*$/gm, "");
    assert.equal((sql.match(/^create table /gim) ?? []).length, 1);
    assert.match(sql, /'RECEIPT_QUALIFICATION_CLASSIFY'/);
    assert.equal((sql.match(/insert into public\.permissions/gi) ?? []).length, 1);
    assert.equal((sql.match(/insert into public\.role_permissions/gi) ?? []).length, 1);
  });

  test("5.4 the permission maps to CLAIM_REVIEWER only", () => {
    const sql = read(MIGRATION).replace(/^\s*--.*$/gm, "");
    const map = sql.match(/insert into public\.role_permissions[\s\S]*?;/);
    assert.ok(map);
    assert.match(map[0], /r\.code = 'CLAIM_REVIEWER'/);
    for (const role of ["VENDOR_SUPER_ADMIN", "FINANCE_ADMIN", "RETAILER_OWNER", "RETAILER_MANAGER", "RETAILER_SALES_STAFF"]) {
      assert.ok(!map[0].includes(role), `${role} must not be mapped`);
    }
  });

  test("5.5 RLS on, zero policies, revoked from every browser role", () => {
    const sql = read(MIGRATION).replace(/^\s*--.*$/gm, "");
    assert.match(sql, /alter table public\.receipt_qualification_events enable row level security/);
    assert.ok(!/create policy/i.test(sql));
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.match(
        sql,
        new RegExp(`revoke all on table public\\.receipt_qualification_events from ${role}`),
      );
    }
  });

  test("5.6 the internal fail-closed helper is revoked from authenticated", () => {
    const sql = read(MIGRATION).replace(/^\s*--.*$/gm, "");
    assert.match(sql, /revoke execute on function public\.receipt_qualification_is_excluded\(uuid\) from authenticated/);
    assert.ok(!/grant\s+execute on function public\.receipt_qualification_is_excluded/.test(sql));
  });

  test("5.7 no sale, reward, coin or ledger object is created", () => {
    const sql = read(MIGRATION).replace(/^\s*--.*$/gm, "");
    for (const forbidden of ["verified_sale", "reward_award", "coin_ledger", "wallet", "payout"]) {
      assert.ok(!new RegExp(`create table[^;]*${forbidden}`, "i").test(sql), forbidden);
    }
  });

  test("5.8 nothing hard-codes a hosted receipt, reviewer or filename", () => {
    for (const f of [...PHASE_1D_0_FILES, MIGRATION, join(ROOT, "docs", "receipt-qualification-exclusions.md")]) {
      if (!existsSync(f)) continue;
      const s = read(f);
      const uuids = [...s.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)].map((m) => m[0]);
      assert.deepEqual(uuids, [], `hard-coded UUID in ${f}`);
      assert.ok(!/@(gmail|yahoo|outlook|hotmail)\./i.test(s), `email in ${f}`);
      assert.ok(!/eyJ[A-Za-z0-9_-]{10,}|sb_(secret|publishable)_/.test(s), `credential in ${f}`);
    }
  });

  test("5.9 no service-role client anywhere in this milestone", () => {
    for (const f of PHASE_1D_0_FILES) {
      assert.ok(!/createAdminClient|supabase\/admin|SERVICE_ROLE/.test(codeOf(f)), f);
    }
  });

  test("5.10 documentation exists and explains the separation", () => {
    const doc = join(ROOT, "docs", "receipt-qualification-exclusions.md");
    assert.ok(existsSync(doc));
    const s = read(doc);
    assert.match(s, /VERIFIED/);
    assert.match(s, /append-only/i);
    assert.match(s, /TEST_DATA/);
    assert.match(s, /fail closed/i);
    assert.match(s, /Phase 1D-A/);
  });

  test("5.11 the Phase 1C-C document notes the separate qualification state", () => {
    const doc = read(join(ROOT, "docs", "claim-reviewer-receipt-detail-and-decision.md"));
    assert.match(doc, /qualification/i);
  });
});
