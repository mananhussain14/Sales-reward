/**
 * Equivalence and provenance tests for the generated ISO 4217 artefacts.
 *
 * Run with:  npm test
 *
 * The migration and this TypeScript list are generated from ONE pinned input in ONE run, and
 * this file is what keeps that true. The database is the enforcement boundary — both
 * currency_code columns carry a foreign key to public.iso_currency_codes — so a TypeScript
 * list that drifted from the seed would present a currency the application offers and the
 * database then refuses, on a real receipt, at confirmation time.
 *
 * It also pins the MECHANICAL inclusion rule. There is no hand-maintained exclusion list: a
 * code is in if and only if it is active and its minor unit parses as 0, 2, 3 or 4. That is
 * why the X-prefixed circulating currencies are present, and why the metals and fund codes
 * are absent without anyone having named them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ISO_CURRENCIES,
  ISO_CURRENCY_CODES,
  isIsoCurrencyCode,
  isoCurrencyMinorUnit,
} from "./iso-currency-codes.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATION_PATH = "supabase/migrations/20260812090000_iso_currency_codes.sql";
const SQL = readFileSync(join(ROOT, MIGRATION_PATH), "utf8");

/** The seeded (code, minor_unit) pairs, read out of the migration's VALUES list. */
const SEEDED: { code: string; minorUnit: number }[] = [
  ...SQL.matchAll(/^\s*\('([A-Z]{3})',\s*(\d+)\)/gm),
].map((match) => ({ code: match[1], minorUnit: Number.parseInt(match[2], 10) }));

describe("the two artefacts are equivalent", () => {
  test("the migration actually contains a seed", () => {
    assert.ok(SEEDED.length > 100, `only ${SEEDED.length} codes parsed out of the migration`);
  });

  test("same number of entries", () => {
    assert.equal(SEEDED.length, ISO_CURRENCIES.length);
  });

  test("byte-equivalent by code and minor unit", () => {
    const sql = SEEDED.map((entry) => `${entry.code}:${entry.minorUnit}`);
    const ts = ISO_CURRENCIES.map((entry) => `${entry.code}:${entry.minorUnit}`);
    assert.deepEqual(sql, ts);
  });

  test("both are sorted by code, so regeneration is deterministic", () => {
    assert.deepEqual([...ISO_CURRENCY_CODES], [...ISO_CURRENCY_CODES].sort());
    assert.deepEqual(
      SEEDED.map((e) => e.code),
      [...SEEDED.map((e) => e.code)].sort(),
    );
  });

  test("no duplicate codes", () => {
    assert.equal(new Set(ISO_CURRENCY_CODES).size, ISO_CURRENCY_CODES.length);
  });
});

describe("the mechanical inclusion rule", () => {
  test("every minor unit is one of the four the schema admits", () => {
    for (const { code, minorUnit } of ISO_CURRENCIES) {
      assert.ok([0, 2, 3, 4].includes(minorUnit), `${code} has minor unit ${minorUnit}`);
    }
  });

  test("no N.A. entry survived into either artefact", () => {
    // The rule that removes the metals, the fund and bond codes, XXX and the testing code.
    assert.ok(!/\('[A-Z]{3}',\s*N\.A\./.test(SQL));
    assert.ok(!/,\s*'?N\.A\.'?/.test(SQL.replace(/^--.*$/gm, "")));
  });

  test("every code is exactly three uppercase ASCII letters", () => {
    for (const code of ISO_CURRENCY_CODES) {
      assert.match(code, /^[A-Z]{3}$/);
    }
  });

  test("representative circulating X-prefixed codes are INCLUDED", () => {
    // No code is excluded for beginning with X. These four are real circulating currencies
    // with numeric minor units, so the mechanical rule keeps them — as it must.
    for (const code of ["XCD", "XOF", "XAF", "XPF"]) {
      assert.ok(isIsoCurrencyCode(code), `${code} is missing`);
    }
  });

  test("the four minor-unit classes are all represented", () => {
    const units = new Set<number>(ISO_CURRENCIES.map((entry) => entry.minorUnit));
    for (const unit of [0, 2, 3, 4]) {
      assert.ok(units.has(unit), `no currency with ${unit} minor units was seeded`);
    }
  });

  test("the currencies this milestone's fixtures depend on are present and correct", () => {
    assert.equal(isoCurrencyMinorUnit("AED"), 2);
    assert.equal(isoCurrencyMinorUnit("EUR"), 2);
    assert.equal(isoCurrencyMinorUnit("USD"), 2);
    assert.equal(isoCurrencyMinorUnit("JPY"), 0);
    assert.equal(isoCurrencyMinorUnit("KWD"), 3);
    assert.equal(isoCurrencyMinorUnit("BHD"), 3);
  });
});

describe("provenance is recorded in both artefacts", () => {
  const TS = readFileSync(join(ROOT, "lib/reference/iso-currency-codes.ts"), "utf8");

  test("the pinned source digest appears in both, and is the same digest", () => {
    const sqlDigest = /Source SHA-256:\s+([0-9a-f]{64})/.exec(SQL);
    const tsDigest = /Source SHA-256:\s+([0-9a-f]{64})/.exec(TS);
    assert.ok(sqlDigest, "the migration records no source digest");
    assert.ok(tsDigest, "the reference module records no source digest");
    assert.equal(sqlDigest?.[1], tsDigest?.[1]);
  });

  test("the publication date appears in both, and is the same date", () => {
    const sqlDate = /Publication date\s+(\d{4}-\d{2}-\d{2})/.exec(SQL);
    const tsDate = /Publication date:\s+(\d{4}-\d{2}-\d{2})/.exec(TS);
    assert.ok(sqlDate, "the migration records no publication date");
    assert.ok(tsDate, "the reference module records no publication date");
    assert.equal(sqlDate?.[1], tsDate?.[1]);
  });

  test("the official source is SIX Group, and is recorded only in documentation", () => {
    assert.match(SQL, /six-group\.com/);
    assert.match(TS, /six-group\.com/);
    // Documentation only: the URL must not appear in executable source.
    const sqlCode = SQL.replace(/^--.*$/gm, "");
    assert.ok(!/six-group\.com/.test(sqlCode));
  });

  test("both are marked generated, so nobody edits them by hand", () => {
    assert.match(SQL, /GENERATED FILE/);
    assert.match(TS, /GENERATED FILE/);
  });
});

describe("the migration's schema posture", () => {
  test("code is the primary key and the format CHECK pins the C collation", () => {
    assert.match(SQL, /primary key \(code\)/);
    assert.match(SQL, /code collate "C" ~ '\^\[A-Z\]\{3\}\$'/);
  });

  test("minor_unit is constrained to the four supported values", () => {
    assert.match(SQL, /check \(minor_unit in \(0, 2, 3, 4\)\)/);
  });

  test("RLS is enabled with zero policies and no grants", () => {
    assert.match(SQL, /alter table public\.iso_currency_codes enable row level security/);
    assert.ok(!/create policy/i.test(SQL));
    assert.match(SQL, /revoke all on table public\.iso_currency_codes from anon/);
    assert.match(SQL, /revoke all on table public\.iso_currency_codes from authenticated/);
    assert.ok(!/grant .* on table public\.iso_currency_codes/i.test(SQL));
  });

  test("the seed is idempotent and deletes nothing", () => {
    // Comments are stripped: the privilege section explains, in prose, why TRUNCATE is
    // revoked from service_role, and that sentence must not trip the rule it records.
    const statements = SQL.replace(/^[ \t]*--.*$/gm, "");
    assert.match(statements, /on conflict \(code\) do nothing/);
    assert.ok(!/\bdelete\s+from\b/i.test(statements));
    assert.ok(!/\btruncate\s+table\b/i.test(statements));
  });

  test("service_role holds no privilege either — TRUNCATE bypasses row triggers", () => {
    assert.match(SQL, /revoke all on table public\.iso_currency_codes from service_role;/);
  });
});

describe("the lookup helpers", () => {
  test("unknown and mis-cased codes are not currencies", () => {
    for (const value of ["", "aed", "AE", "AEDD", "ZZZ", "123"]) {
      assert.equal(isIsoCurrencyCode(value), false, value);
    }
  });

  test("an unknown code has NO minor unit rather than a default of 2", () => {
    // Defaulting to 2 would misread every JPY, KWD and BHD amount by 100x or 10x.
    assert.equal(isoCurrencyMinorUnit("ZZZ"), null);
    assert.equal(isoCurrencyMinorUnit("aed"), null);
  });
});
