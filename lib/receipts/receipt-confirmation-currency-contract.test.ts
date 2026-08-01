/**
 * SOURCE-LEVEL CONTRACT GUARDS for the currency minor-unit fix.
 *
 * Run with:  npm test
 *
 * The behaviour lives in pgTAP (supabase/tests/database/receipt_confirmation_test.sql), which
 * needs Docker. What this file pins is the set of STRUCTURAL properties a later edit could
 * quietly undo without any behavioural test noticing, because each would still leave a
 * working function behind:
 *
 *   1. THE OLD NINE-ARGUMENT CONFIRMATION IS DROPPED, NOT OVERLOADED. An overload keeps its
 *      grant to `authenticated` and leaves the mis-scaling call path reachable forever.
 *   2. p_currency_minor_unit IS REQUIRED. A default re-creates the defect for every caller
 *      that omits it.
 *   3. THE BACKEND IS THE AUTHORITY. The migration never multiplies or divides an amount, and
 *      the minor unit it compares against comes from public.iso_currency_codes.
 *   4. THE LOOKUP RPC IS A WINDOW, NOT A TABLE GRANT. No table privilege, no RLS policy, no
 *      list mode.
 *   5. THE REFUSAL HAS ONE STABLE, MACHINE-MAPPABLE IDENTITY, and the SQL and the shared
 *      vocabulary module agree on what it is.
 *   6. THIS IS A FORWARD MIGRATION. The four shipped milestone migrations are byte-unchanged.
 *
 * A grep-style test is a blunt instrument, and deliberately so: it fails loudly on the exact
 * shapes that would constitute a regression, naming the file.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIRMATION_MINOR_UNIT_MISMATCH_SQLSTATE,
  CURRENCY_MINOR_UNITS,
  CURRENCY_MINOR_UNIT_RPC,
  isCurrencyMinorUnit,
} from "./receipt-extraction-vocabulary.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const MIGRATION = "supabase/migrations/20260814090000_receipt_confirmation_currency_minor_unit.sql";
const CURRENCY_SEED = "supabase/migrations/20260812090000_iso_currency_codes.sql";
const CLIENT_OPS = "supabase/migrations/20260813210000_receipt_extraction_client_operations.sql";
const PGTAP = "supabase/tests/database/receipt_confirmation_test.sql";

/** The nine-argument list this change retires, exactly as the shipped migration declared it. */
const OLD_ARGS = "uuid, date, text, bigint, text, text, time without time zone, bigint, bigint";
/** The ten-argument list that replaces it. */
const NEW_ARGS =
  "uuid, date, text, smallint, bigint, text, text, time without time zone, bigint, bigint";

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Strips comments so prose describing a rule cannot trip the rule it describes. */
function stripSqlComments(source: string): string {
  return source.replace(/^[ \t]*--.*$/gm, "");
}

/** Git needs the Command Line Tools on PATH in this environment. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `/Library/Developer/CommandLineTools/usr/bin:${process.env.PATH ?? ""}`,
  };
}

const SQL = stripSqlComments(read(MIGRATION));

describe("1. the old confirmation signature is removed, not overloaded", () => {
  test("the migration exists", () => {
    assert.ok(existsSync(join(ROOT, MIGRATION)), `${MIGRATION} is missing`);
  });

  test("it drops exactly the nine-argument confirmation", () => {
    const drops = SQL.match(/drop\s+function[^;]*;/gi) ?? [];
    assert.equal(drops.length, 1, `expected one DROP FUNCTION, found ${drops.length}`);
    assert.match(drops[0], /public\.confirm_receipt_extraction/);
    assert.equal(
      drops[0].replace(/\s+/g, " ").includes(OLD_ARGS),
      true,
      `the DROP does not name the retired argument list:\n${drops[0]}`,
    );
  });

  test("it drops no table, trigger, index, policy or type", () => {
    for (const forbidden of [
      /drop\s+table/i,
      /drop\s+trigger/i,
      /drop\s+index/i,
      /drop\s+policy/i,
      /drop\s+type/i,
      /drop\s+constraint/i,
      /drop\s+column/i,
    ]) {
      assert.ok(!forbidden.test(SQL), `${MIGRATION} matches ${forbidden}`);
    }
  });

  test("the retired argument list is never granted again", () => {
    // A grant naming the old list would mean the overload came back.
    for (const grant of SQL.match(/grant\s+execute[^;]*;/gi) ?? []) {
      assert.ok(
        !grant.replace(/\s+/g, " ").includes(OLD_ARGS),
        `a grant still names the retired signature:\n${grant}`,
      );
    }
  });

  test("no CREATE OR REPLACE is used for the confirmation", () => {
    // CREATE OR REPLACE cannot change an argument list; using it here would silently create
    // the second function this test exists to forbid.
    assert.ok(!/create\s+or\s+replace\s+function/i.test(SQL), "CREATE OR REPLACE is used");
  });
});

describe("2. p_currency_minor_unit is required, typed and positioned deliberately", () => {
  const confirmAt = SQL.indexOf("create function public.confirm_receipt_extraction");
  const signature = SQL.slice(confirmAt, SQL.indexOf("returns table", confirmAt));

  test("it is declared as a smallint", () => {
    assert.match(SQL, /p_currency_minor_unit\s+smallint/);
  });

  test("it carries NO default", () => {
    const declaration = signature.match(/p_currency_minor_unit[^,)]*/)?.[0] ?? "";
    assert.ok(declaration.length > 0, "p_currency_minor_unit is not in the argument list");
    assert.ok(
      !/default/i.test(declaration),
      `p_currency_minor_unit must not be optional:\n${declaration}`,
    );
  });

  test("it sits beside the currency it qualifies, before the amounts it scales", () => {
    const currencyAt = signature.indexOf("p_currency_code");
    const minorAt = signature.indexOf("p_currency_minor_unit");
    const totalAt = signature.indexOf("p_total_minor");
    assert.ok(currencyAt >= 0 && minorAt >= 0 && totalAt >= 0, "a parameter is missing");
    assert.ok(currencyAt < minorAt, "the minor unit must follow the currency code");
    assert.ok(minorAt < totalAt, "the minor unit must precede the amounts");
  });

  test("the grants name the new ten-argument list", () => {
    const normalized = SQL.replace(/\s+/g, " ");
    assert.ok(
      normalized.includes(`grant execute on function public.confirm_receipt_extraction(${NEW_ARGS}) to authenticated`),
      "the new signature is not granted to authenticated",
    );
    assert.ok(
      normalized.includes(`revoke execute on function public.confirm_receipt_extraction(${NEW_ARGS}) from anon`),
      "the new signature is not revoked from anon",
    );
  });

  test("no other parameter was added or removed", () => {
    const declared = [...signature.matchAll(/\bp_[a-z_]+/g)].map((m) => m[0]);
    assert.deepEqual(declared, [
      "p_submission_id",
      "p_transaction_date",
      "p_currency_code",
      "p_currency_minor_unit",
      "p_total_minor",
      "p_merchant_name",
      "p_document_number",
      "p_transaction_time",
      "p_subtotal_minor",
      "p_tax_total_minor",
    ]);
  });

  test("still no parameter for anything the backend derives", () => {
    for (const forbidden of [
      "p_entry_mode",
      "p_changed_fields",
      "p_source_extraction_id",
      "p_organization_id",
      "p_retailer_shop_id",
      "p_profile_id",
      "p_is_duplicate",
      "p_runtime_mode",
      "p_provider",
    ]) {
      assert.ok(!SQL.includes(forbidden), `${MIGRATION} declares ${forbidden}`);
    }
  });
});

describe("3. the backend remains the authority on scale", () => {
  test("the stated minor unit is compared against iso_currency_codes", () => {
    assert.match(
      SQL,
      /select\s+c\.minor_unit\s+into\s+v_minor_unit\s+from\s+public\.iso_currency_codes/,
      "the confirmation does not resolve the minor unit from the reference table",
    );
    assert.match(
      SQL,
      /p_currency_minor_unit\s+is\s+null\s+or\s+p_currency_minor_unit\s*<>\s*v_minor_unit/,
      "the equality rule is not stated as null-or-mismatch",
    );
  });

  test("no amount is ever scaled in SQL", () => {
    // The parameter declares a scale; it never applies one. A multiplication or division
    // here would make the backend a second, competing converter.
    for (const forbidden of [
      /power\s*\(\s*10/i,
      /\*\s*100\b/,
      /\/\s*100\b/,
      /\*\s*10\s*\^/,
      /round\s*\(/i,
      /trunc\s*\(\s*p_/i,
      /::\s*numeric/i,
      /::\s*float/i,
      /::\s*double/i,
    ]) {
      assert.ok(!forbidden.test(SQL), `${MIGRATION} scales or floats an amount: ${forbidden}`);
    }
  });

  test("nothing derived from the parameter is stored", () => {
    const insert = SQL.slice(SQL.indexOf("insert into public.receipt_confirmations"));
    assert.ok(
      !insert.slice(0, insert.indexOf("returning id")).includes("p_currency_minor_unit"),
      "the stated minor unit reaches the stored row",
    );
    assert.ok(
      !SQL.includes("currency_minor_unit,") || !/insert\s+into\s+public\.receipt_confirmations[^;]*currency_minor_unit/i.test(SQL),
      "a currency_minor_unit column is written to receipt_confirmations",
    );
  });

  test("the eight comparable fields are unchanged and the minor unit is not among them", () => {
    for (const field of [
      "merchant_name",
      "document_number",
      "transaction_date",
      "transaction_time",
      "currency_code",
      "total_minor",
      "subtotal_minor",
      "tax_total_minor",
    ]) {
      assert.ok(
        SQL.includes(`v_changed := v_changed || '${field}'::text;`),
        `the derivation of changed_fields no longer appends ${field}`,
      );
    }
    assert.ok(
      !/v_changed\s*:=\s*v_changed\s*\|\|\s*'(currency_)?minor_unit'/.test(SQL),
      "changed_fields names a minor unit",
    );
  });

  test("the entry-mode derivation is untouched", () => {
    assert.match(SQL, /v_mode\s*:=\s*'MANUAL'/);
    assert.match(
      SQL,
      /v_mode\s*:=\s*case when cardinality\(v_changed\) = 0 then 'EXTRACTED' else 'MIXED' end/,
    );
  });
});

describe("4. the lookup RPC is a window, not a table grant", () => {
  test("it is declared with the expected name, hardening and grants", () => {
    const normalized = SQL.replace(/\s+/g, " ");
    assert.ok(
      normalized.includes(`create function public.${CURRENCY_MINOR_UNIT_RPC}( p_currency_code text )`),
      "the lookup is not declared with a single text parameter",
    );
    assert.ok(
      normalized.includes(`grant execute on function public.${CURRENCY_MINOR_UNIT_RPC}(text) to authenticated`),
      "the lookup is not granted to authenticated",
    );
    assert.ok(
      normalized.includes(`revoke execute on function public.${CURRENCY_MINOR_UNIT_RPC}(text) from anon`),
      "the lookup is not revoked from anon",
    );
    assert.ok(
      normalized.includes(`revoke all on function public.${CURRENCY_MINOR_UNIT_RPC}(text) from public`),
      "the lookup is not revoked from PUBLIC",
    );
  });

  test("every function in the migration is SECURITY DEFINER with an empty search_path", () => {
    const creates = SQL.match(/create function[\s\S]*?\$\$;/g) ?? [];
    assert.equal(creates.length, 2, `expected two functions, found ${creates.length}`);
    for (const body of creates) {
      assert.match(body, /security definer/, "a function is not SECURITY DEFINER");
      assert.match(body, /set search_path = ''/, "a function has a non-empty search_path");
    }
  });

  test("it is gated by the same permission as every other authenticated receipt RPC", () => {
    const lookup = SQL.slice(SQL.indexOf(`create function public.${CURRENCY_MINOR_UNIT_RPC}`));
    const body = lookup.slice(0, lookup.indexOf("$$;"));
    assert.match(
      body,
      /resolve_retailer_member_organization\('RECEIPT_EXTRACTION_REVIEW'\)/,
      "the lookup does not resolve through the shared permission",
    );
    assert.match(body, /errcode = 'insufficient_privilege'/, "the lookup does not raise 42501");
    assert.ok(!/'SALES_STAFF'/.test(body), "the lookup names a role code");
  });

  test("it reads only the currency reference and returns only two values", () => {
    const lookup = SQL.slice(SQL.indexOf(`create function public.${CURRENCY_MINOR_UNIT_RPC}`));
    const body = lookup.slice(0, lookup.indexOf("$$;"));
    for (const forbidden of [
      "receipt_submissions",
      "receipt_extractions",
      "receipt_confirmations",
      "organizations",
      "retailer_shops",
      "profiles",
      "audit_logs",
      "auth.users",
    ]) {
      assert.ok(!body.includes(forbidden), `the lookup reads ${forbidden}`);
    }
    assert.match(body, /returns table \(\s*currency_code text,\s*minor_unit\s+smallint\s*\)/);
  });

  test("it normalises exactly as confirmation does", () => {
    const normalization = "nullif(upper(btrim(coalesce(";
    assert.equal(
      SQL.split(normalization).length - 1,
      2,
      "the two functions do not share one normalization shape",
    );
  });

  test("no table privilege, RLS policy or storage object is created anywhere", () => {
    for (const forbidden of [
      /grant\s+(select|insert|update|delete|all)\s+on\s+table/i,
      /create\s+policy/i,
      /alter\s+table/i,
      /create\s+table/i,
      /storage\.objects/i,
      /storage\.buckets/i,
      /alter\s+.*enable\s+row\s+level\s+security/i,
    ]) {
      assert.ok(!forbidden.test(SQL), `${MIGRATION} matches ${forbidden}`);
    }
  });

  test("neither function is granted to service_role", () => {
    assert.ok(!/to\s+service_role/i.test(SQL), "a function is granted to service_role");
  });

  test("no dynamic SQL", () => {
    for (const forbidden of [/\bexecute\s+format/i, /\bexecute\s+'/i, /\bquote_ident/i]) {
      assert.ok(!forbidden.test(SQL), `${MIGRATION} matches ${forbidden}`);
    }
  });
});

describe("5. the refusal has one stable identity", () => {
  test("the shared vocabulary and the SQL agree on the SQLSTATE", () => {
    // 22023 is `invalid_parameter_value`; the SQL raises it by condition name.
    assert.equal(CONFIRMATION_MINOR_UNIT_MISMATCH_SQLSTATE, "22023");
    assert.match(SQL, /errcode = 'invalid_parameter_value'/);
  });

  test("it is raised exactly once, and only by the minor-unit rule", () => {
    const raises = SQL.match(/raise exception[\s\S]*?using errcode = '[a-z_]+';/g) ?? [];
    const mismatch = raises.filter((r) => r.includes("invalid_parameter_value"));
    assert.equal(mismatch.length, 1, `22023 is raised ${mismatch.length} times`);
    assert.match(mismatch[0], /currency minor unit/i);
  });

  test("every other refusal keeps its existing code", () => {
    const raises = SQL.match(/raise exception[\s\S]*?using errcode = '[a-z_]+';/g) ?? [];
    for (const raised of raises) {
      const isMinorUnit = raised.includes("invalid_parameter_value");
      const isAuth = raised.includes("insufficient_privilege");
      assert.ok(
        isMinorUnit || isAuth || raised.includes("check_violation"),
        `an unexpected errcode is raised:\n${raised}`,
      );
    }
    // The unsupported-currency refusal must stay 23514 so it cannot be confused with 22023.
    const currency = raises.find((r) => r.includes("That currency could not be accepted"));
    assert.ok(currency, "the unsupported-currency refusal is gone");
    assert.match(currency, /check_violation/);
  });

  test("the message exposes no table, column or expected value", () => {
    const raises = SQL.match(/raise exception '[^']*'/g) ?? [];
    for (const raised of raises) {
      for (const forbidden of [
        "iso_currency_codes",
        "receipt_confirmations",
        "receipt_extractions",
        "minor_unit ",
        "%",
      ]) {
        assert.ok(!raised.includes(forbidden), `a message leaks "${forbidden}":\n${raised}`);
      }
    }
  });

  test("the outcome vocabulary was not widened", () => {
    // The mismatch is a refusal, not a confirmation state. Adding an outcome would change
    // the shape every existing client parses.
    const outcomes = [...SQL.matchAll(/return query select '([A-Z_]+)'::text/g)].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(outcomes)].sort(),
      ["ALREADY_CONFIRMED", "CONFIRMED", "EXTRACTION_IN_PROGRESS"],
    );
  });

  test("ownership and in-flight checks still outrank validation", () => {
    const confirm = SQL.slice(SQL.indexOf("create function public.confirm_receipt_extraction"));
    const accessAt = confirm.indexOf("assert_my_receipt_extraction_access");
    const inFlightAt = confirm.indexOf("EXTRACTION_IN_PROGRESS");
    const minorAt = confirm.indexOf("p_currency_minor_unit is null");
    assert.ok(accessAt >= 0 && inFlightAt >= 0 && minorAt >= 0);
    assert.ok(accessAt < inFlightAt, "authorization must come first");
    assert.ok(inFlightAt < minorAt, "an in-flight attempt must be reported before a scale check");
  });
});

describe("6. the shared vocabulary describes the same four scales as the seed", () => {
  test("the four minor units match the reference table's CHECK constraint", () => {
    const seed = read(CURRENCY_SEED);
    assert.match(seed, /check \(minor_unit in \(0, 2, 3, 4\)\)/);
    assert.deepEqual([...CURRENCY_MINOR_UNITS], [0, 2, 3, 4]);
  });

  test("isCurrencyMinorUnit accepts exactly those and nothing else", () => {
    for (const value of CURRENCY_MINOR_UNITS) {
      assert.equal(isCurrencyMinorUnit(value), true, `${value} rejected`);
    }
    for (const value of [-1, 1, 5, 2.5, "2", null, undefined, NaN]) {
      assert.equal(isCurrencyMinorUnit(value), false, `${String(value)} accepted`);
    }
  });

  test("the currencies the review named are all seeded, with the scales it named", () => {
    const seed = read(CURRENCY_SEED);
    for (const [code, minor] of [
      ["EUR", 2],
      ["JPY", 0],
      ["KWD", 3],
      ["CLF", 4],
    ] as const) {
      assert.ok(
        new RegExp(`\\('${code}', ${minor}\\)`).test(seed),
        `${code} is not seeded with minor unit ${minor}`,
      );
    }
  });
});

describe("7. this is a forward migration, and the pgTAP suite follows the new contract", () => {
  test("the shipped client-operations migration still declares the old signature", () => {
    // Proof that nothing already on main was rewritten: the retired signature is still
    // exactly where it shipped, and this migration supersedes it forward.
    const shipped = read(CLIENT_OPS);
    assert.ok(shipped.includes("create function public.confirm_receipt_extraction"), CLIENT_OPS);
    assert.ok(!shipped.includes("p_currency_minor_unit"), `${CLIENT_OPS} was edited in place`);
  });

  /**
   * Lists migration paths that differ from origin/main under a given --diff-filter.
   *
   * Returns null when git cannot answer — no git, no origin/main, or a shallow checkout —
   * so a caller can skip rather than pass vacuously.
   */
  function migrationsDiffering(filter: string): string[] | null {
    try {
      return execFileSync(
        "git",
        [
          "diff",
          "--name-only",
          `--diff-filter=${filter}`,
          "origin/main",
          "--",
          "supabase/migrations",
        ],
        { cwd: ROOT, encoding: "utf8", env: gitEnv() },
      )
        .split("\n")
        .filter(Boolean);
    } catch {
      return null;
    }
  }

  test("no migration already on main was modified or deleted", () => {
    // --diff-filter=MD: MODIFIED or DELETED only.
    //
    // WHY THE FILTER IS LOAD-BEARING. This assertion used to run a bare
    // `git diff --name-only origin/main -- supabase/migrations`, which also reports ADDED
    // files. That made it forbid adding ANY new migration, ever — the opposite of what its
    // own name says, and a guard every future migration milestone would have had to
    // weaken or delete. It went unnoticed because `git diff` cannot see UNTRACKED files,
    // so a full run performed before `git add` passed while the very same tree failed once
    // the files were staged. Verification therefore has to run against the committed tree,
    // and this guard has to name the change KIND it actually cares about.
    //
    // Rewriting history that is already on main is the real hazard: a migration other
    // people have applied cannot be edited, because their database will never re-run it.
    // Adding a new one is ordinary forward progress and is what MD deliberately permits.
    const touched = migrationsDiffering("MD");
    if (touched === null) return;
    assert.deepEqual(
      touched,
      [],
      `migrations already on origin/main must not be modified or deleted:\n${touched.join("\n")}`,
    );
  });

  /**
   * Every migration this branch ADDS relative to origin/main — whether it has been staged
   * yet or not.
   *
   * `git diff` cannot see untracked files, so a tracked-only answer would change depending
   * on whether `git add` had been run. That is precisely the blind spot that let a broken
   * suite look green, so this unions the tracked additions with the untracked ones and
   * gives the same answer either way.
   */
  function addedMigrations(): string[] | null {
    const tracked = migrationsDiffering("A");
    if (tracked === null) return null;

    let untracked: string[];
    try {
      untracked = execFileSync(
        "git",
        ["ls-files", "--others", "--exclude-standard", "--", "supabase/migrations"],
        { cwd: ROOT, encoding: "utf8", env: gitEnv() },
      )
        .split("\n")
        .filter(Boolean);
    } catch {
      untracked = [];
    }

    return [...new Set([...tracked, ...untracked])].sort();
  }

  test("adding a new migration is permitted, and this branch does add some", () => {
    // The other half of the same rule, asserted rather than assumed. If a future refactor
    // reintroduced the over-broad command, this test would start failing — which is the
    // point: the two together pin the guard to "modified or deleted", not "different".
    const added = addedMigrations();
    if (added === null) return;

    for (const path of added) {
      assert.match(
        path,
        /^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/,
        `an added migration has a non-conforming name: ${path}`,
      );
    }

    // This branch adds the campaign work and the assignment timeline it rests on. Naming
    // them here means a reviewer can see exactly which additions the guard is tolerating.
    const names = added.map((path) => path.replace("supabase/migrations/", ""));
    for (const expected of [
      "20260814210000_vendor_product_assignment_history.sql",
      "20260815090000_vendor_campaign_foundation.sql",
      "20260815210000_vendor_campaign_operations.sql",
    ]) {
      assert.ok(names.includes(expected), `expected this branch to add ${expected}`);
    }
  });

  test("every migration on origin/main is still present and byte-identical", () => {
    // The strongest form of the rule, and the one that does not depend on --diff-filter
    // behaving as documented: read what origin/main has, and compare each file's bytes.
    // A deletion shows up as a missing file; an edit shows up as a hash mismatch.
    let mainFiles: string[];
    try {
      mainFiles = execFileSync(
        "git",
        ["ls-tree", "-r", "--name-only", "origin/main", "--", "supabase/migrations"],
        { cwd: ROOT, encoding: "utf8", env: gitEnv() },
      )
        .split("\n")
        .filter(Boolean);
    } catch {
      return;
    }

    assert.ok(mainFiles.length > 0, "origin/main should carry migrations");

    for (const path of mainFiles) {
      const onMain = execFileSync("git", ["show", `origin/main:${path}`], {
        cwd: ROOT,
        encoding: "utf8",
        env: gitEnv(),
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.ok(existsSync(join(ROOT, path)), `${path} was deleted from this branch`);
      assert.equal(
        readFileSync(join(ROOT, path), "utf8"),
        onMain,
        `${path} differs from origin/main; a migration already applied elsewhere cannot be edited`,
      );
    }
  });

  test("the pgTAP suite asserts the ten-parameter list and the old signature's absence", () => {
    const suite = read(PGTAP);
    assert.ok(suite.includes("'p_currency_minor_unit'"), "the parameter list is not asserted");
    assert.ok(
      suite.includes(`to_regprocedure('public.confirm_receipt_extraction(${OLD_ARGS})')`),
      "the old signature's absence is not asserted",
    );
    for (const expected of ["'EUR|2'", "'JPY|0'", "'KWD|3'", "'CLF|4'", "'22023'"]) {
      assert.ok(suite.includes(expected), `the suite does not cover ${expected}`);
    }
  });
});

describe("8. nothing out of scope was introduced", () => {
  test("no reward, incentive, campaign, payout, coin or approval vocabulary", () => {
    for (const forbidden of [
      /\breward/i,
      /\bincentive/i,
      /\bcampaign/i,
      /\bpayout/i,
      /\bcoin_/i,
      /review_queue/i,
      /\bapprove(d|_)/i,
      /product_match/i,
    ]) {
      assert.ok(!forbidden.test(SQL), `${MIGRATION} matches ${forbidden}`);
    }
  });

  test("no provider, endpoint, credential or storage coordinate", () => {
    for (const forbidden of [
      /azure/i,
      /openai/i,
      /textract/i,
      /https?:\/\//i,
      /api[_-]?key/i,
      /worker_claim_token/i,
      /storage_object_path/i,
      /file_sha256/i,
    ]) {
      assert.ok(!forbidden.test(SQL), `${MIGRATION} matches ${forbidden}`);
    }
  });
});
