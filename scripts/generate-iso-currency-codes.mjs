#!/usr/bin/env node
// Generates BOTH ISO 4217 artefacts from ONE pinned input, in ONE run.
//
//   supabase/migrations/20260812090000_iso_currency_codes.sql
//   lib/reference/iso-currency-codes.ts
//
// WHY A GENERATOR RATHER THAN TWO HAND-MAINTAINED LISTS
//   The database is the enforcement boundary (receipt_extractions.currency_code and
//   receipt_confirmations.currency_code both carry a foreign key to
//   public.iso_currency_codes) and the TypeScript list is what lets the application
//   render a minor-unit-correct amount without a round trip. Two hand-maintained copies
//   of the same 180-odd rows would drift the first time either was edited, and the drift
//   would surface as a foreign-key violation on a real receipt. Generating both from one
//   input in one run makes equivalence a property of the process, and
//   lib/reference/iso-currency-codes.test.ts re-proves it on every `npm test`.
//
// THE INCLUSION RULE IS MECHANICAL, AND THAT IS THE POINT
//   Include a code iff:
//     * it appears in the official ACTIVE list (list-one.xml), and
//     * its alphabetic code is exactly three uppercase ASCII letters, and
//     * its CcyMnrUnts value parses as exactly one of 0, 2, 3, 4.
//   Everything else is excluded BY THE RULE, not by a curated list:
//     * CcyMnrUnts of "N.A."      -> excluded (metals, fund codes, XXX, XTS, ...)
//     * no CcyMnrUnts element     -> excluded (entries such as ANTARCTICA)
//     * any other numeric value   -> excluded (the schema CHECK admits 0/2/3/4 only)
//   There is NO hand-maintained X-prefix exclusion list, and a code is never excluded
//   merely for starting with X. XCD, XOF, XAF and XPF are real circulating currencies
//   with numeric minor units and are therefore included, exactly as the rule requires.
//   A curated list would be a second definition of "which currencies exist", free to
//   drift from the standard and impossible to re-derive.
//
// HISTORIC ENTRIES ARE NEVER READ. Only list-one.xml (active) is an input. list-three.xml
//   (historic) is deliberately not consulted: a withdrawn currency must not become
//   writable on a new receipt.
//
// DETERMINISM. The output contains no clock reading. Every provenance value —
//   publication date, source URL, source SHA-256, fetch date — is an explicit ARGUMENT,
//   so running this twice with the same arguments over the same bytes produces
//   byte-identical files. `new Date()` is never called.
//
// ATOMICITY. Both outputs are built completely in memory and validated before either is
//   written, then each is written via a temporary file and renamed. A parse failure, a
//   conflicting duplicate, or an empty result aborts with a non-zero exit and leaves both
//   existing files untouched — never a half-updated pair.
//
// THE DOWNLOADED SOURCE NEVER ENTERS THE REPOSITORY. --source points at a path outside
//   the working tree (a mktemp directory). This script reads it and does not copy it.
//
// Usage:
//   node scripts/generate-iso-currency-codes.mjs \
//     --source /tmp/iso4217.XXXX/list-one.xml \
//     --source-url https://www.six-group.com/dam/download/... \
//     --fetched-on 2026-07-30

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SQL_OUT = resolve(REPO_ROOT, "supabase/migrations/20260812090000_iso_currency_codes.sql");
const TS_OUT = resolve(REPO_ROOT, "lib/reference/iso-currency-codes.ts");

/** The only minor-unit values this project's schema admits. */
const SUPPORTED_MINOR_UNITS = new Set([0, 2, 3, 4]);

/** Exactly three uppercase ASCII letters. */
const CODE_SHAPE = /^[A-Z]{3}$/;

/** ISO 8601 calendar date, used for both provenance dates. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Lowercase hexadecimal SHA-256. */
const SHA256_SHAPE = /^[0-9a-f]{64}$/;

function fail(message) {
  process.stderr.write(`generate-iso-currency-codes: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) fail(`unexpected argument "${token}"`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`missing value for ${token}`);
    args.set(token.slice(2), next);
    i += 1;
  }
  return args;
}

/**
 * Reads one child element's text from a <CcyNtry> block.
 *
 * A regex parser is used deliberately: this project installs no dependencies without an
 * explicit decision, and list-one.xml is a flat, machine-generated, attribute-free
 * document with no namespaces, no CDATA and no nesting below one level. The shape is
 * validated below rather than assumed — an entry that does not match the expected
 * structure is counted and skipped, never guessed at.
 */
function childText(block, tag) {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
  return match === null ? null : match[1].trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const sourcePath = args.get("source");
  const sourceUrl = args.get("source-url");
  const fetchedOn = args.get("fetched-on");

  if (!sourcePath) fail("--source is required");
  if (!sourceUrl) fail("--source-url is required");
  if (!fetchedOn) fail("--fetched-on is required (YYYY-MM-DD; an argument, not a clock read)");
  if (!DATE_SHAPE.test(fetchedOn)) fail("--fetched-on must be YYYY-MM-DD");

  if (!/^https:\/\/www\.six-group\.com\//.test(sourceUrl)) {
    fail("--source-url must be an official SIX Group URL (the ISO 4217 maintenance agency)");
  }

  const resolvedSource = resolve(sourcePath);
  if (resolvedSource.startsWith(`${REPO_ROOT}/`)) {
    fail("the downloaded source must live OUTSIDE the repository; it is never committed");
  }

  let bytes;
  try {
    bytes = readFileSync(resolvedSource);
  } catch {
    fail("could not read --source");
    return;
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!SHA256_SHAPE.test(sha256)) fail("could not compute a source digest");

  const xml = bytes.toString("utf8");

  // ---- Shape validation, before anything is extracted --------------------------------
  if (!xml.startsWith("<?xml")) fail("source is not an XML document");
  if (!xml.includes("<ISO_4217")) fail("source is not an ISO 4217 document");
  if (xml.includes("<HstrcCcyNtry>")) {
    fail("source contains historic entries; only the ACTIVE list (list-one.xml) is an input");
  }

  const published = /<ISO_4217[^>]*\bPblshd="([^"]+)"/.exec(xml);
  if (published === null) fail("source carries no Pblshd publication date");
  const publicationDate = published[1].trim();
  if (!DATE_SHAPE.test(publicationDate)) fail("source Pblshd is not an ISO 8601 date");

  const blocks = xml.match(/<CcyNtry>[\s\S]*?<\/CcyNtry>/g);
  if (blocks === null || blocks.length === 0) fail("source contains no currency entries");

  // ---- Apply the mechanical rule -----------------------------------------------------
  /** @type {Map<string, number>} */
  const included = new Map();
  let skippedNoCode = 0;
  let skippedNonNumericMinorUnit = 0;
  let skippedMissingMinorUnit = 0;
  let skippedUnsupportedMinorUnit = 0;
  let skippedMalformedCode = 0;

  for (const block of blocks) {
    const code = childText(block, "Ccy");
    if (code === null || code === "") {
      // An entry with no currency at all (e.g. ANTARCTICA). Counted, not guessed at.
      skippedNoCode += 1;
      continue;
    }
    if (!CODE_SHAPE.test(code)) {
      skippedMalformedCode += 1;
      continue;
    }

    const rawMinorUnit = childText(block, "CcyMnrUnts");
    if (rawMinorUnit === null || rawMinorUnit === "") {
      skippedMissingMinorUnit += 1;
      continue;
    }
    if (!/^\d+$/.test(rawMinorUnit)) {
      // "N.A." and anything else non-numeric. This is the rule that removes the metals,
      // the fund and bond codes, XXX and XTS — without naming any of them.
      skippedNonNumericMinorUnit += 1;
      continue;
    }

    const minorUnit = Number.parseInt(rawMinorUnit, 10);
    if (!SUPPORTED_MINOR_UNITS.has(minorUnit)) {
      skippedUnsupportedMinorUnit += 1;
      continue;
    }

    const existing = included.get(code);
    if (existing === undefined) {
      included.set(code, minorUnit);
      continue;
    }
    if (existing !== minorUnit) {
      // The active list repeats a currency once per country. Repetition is expected and
      // deduplicated; DISAGREEMENT is not, and is never silently resolved by picking one.
      fail(
        `conflicting minor units for ${code}: ${existing} and ${minorUnit}. ` +
          "Refusing to choose one; the source must be reviewed.",
      );
    }
  }

  if (included.size === 0) fail("the inclusion rule produced no currencies");

  const entries = [...included.entries()]
    .map(([code, minorUnit]) => ({ code, minorUnit }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  const skippedTotal =
    skippedNoCode +
    skippedMalformedCode +
    skippedMissingMinorUnit +
    skippedNonNumericMinorUnit +
    skippedUnsupportedMinorUnit;

  // ---- Build BOTH outputs in memory, before writing either ---------------------------
  const provenance = [
    `--   Source:          ${sourceUrl}`,
    `--   Maintained by:   SIX Group, the ISO 4217 Maintenance Agency`,
    `--   Publication date ${publicationDate}   (the Pblshd attribute of the source)`,
    `--   Source SHA-256:  ${sha256}`,
    `--   Fetched on:      ${fetchedOn}`,
    `--   Entries read:    ${blocks.length}`,
    `--   Codes seeded:    ${entries.length}`,
    `--   Excluded:        ${skippedTotal} ` +
      `(${skippedNonNumericMinorUnit} non-numeric minor unit, ` +
      `${skippedMissingMinorUnit} no minor unit, ` +
      `${skippedUnsupportedMinorUnit} unsupported minor unit, ` +
      `${skippedNoCode} no currency code, ` +
      `${skippedMalformedCode} malformed code)`,
  ].join("\n");

  const sql = buildSql(entries, provenance);
  const ts = buildTypeScript(entries, {
    sourceUrl,
    publicationDate,
    sha256,
    fetchedOn,
    read: blocks.length,
    skippedTotal,
    skippedNonNumericMinorUnit,
    skippedMissingMinorUnit,
    skippedUnsupportedMinorUnit,
    skippedNoCode,
    skippedMalformedCode,
  });

  if (sql.length === 0 || ts.length === 0) fail("refusing to write an empty artefact");

  writeAtomic(SQL_OUT, sql);
  writeAtomic(TS_OUT, ts);

  process.stdout.write(
    [
      "generate-iso-currency-codes: wrote both artefacts",
      `  publication date  ${publicationDate}`,
      `  source sha256     ${sha256}`,
      `  entries read      ${blocks.length}`,
      `  codes seeded      ${entries.length}`,
      `  excluded total    ${skippedTotal}`,
      `    non-numeric minor unit  ${skippedNonNumericMinorUnit}`,
      `    no minor unit element   ${skippedMissingMinorUnit}`,
      `    unsupported minor unit  ${skippedUnsupportedMinorUnit}`,
      `    no currency code        ${skippedNoCode}`,
      `    malformed code          ${skippedMalformedCode}`,
      `  minor-unit spread ${summariseMinorUnits(entries)}`,
      "",
    ].join("\n"),
  );
}

function summariseMinorUnits(entries) {
  const counts = new Map();
  for (const { minorUnit } of entries) {
    counts.set(minorUnit, (counts.get(minorUnit) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([unit, count]) => `${unit}:${count}`)
    .join(" ");
}

function writeAtomic(target, contents) {
  const temporary = `${target}.generating`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o644 });
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not exist; its absence is the desired end state.
    }
    throw error;
  }
}

function buildSql(entries, provenance) {
  const rows = entries.map(({ code, minorUnit }) => `  ('${code}', ${minorUnit})`).join(",\n");

  return `-- Migration: iso_currency_codes
-- GENERATED FILE — do not edit by hand.
--   Regenerate with scripts/generate-iso-currency-codes.mjs from the pinned source below.
--   lib/reference/iso-currency-codes.ts is generated from the SAME input in the SAME run,
--   and lib/reference/iso-currency-codes.test.ts fails the build if the two disagree.
--
-- PROVENANCE
${provenance}
--
-- THE MECHANICAL INCLUSION RULE, AND WHY IT IS MECHANICAL
--   A code is seeded if and only if it appears in the official ACTIVE list, its
--   alphabetic code is exactly three uppercase ASCII letters, and its CcyMnrUnts value
--   parses as exactly one of 0, 2, 3, 4.
--
--   Everything else is excluded BY THE RULE and not by a curated list. A "N.A." minor
--   unit removes the precious metals, the fund and bond codes, XXX and the testing code;
--   a missing element removes entries such as ANTARCTICA that name no currency. NO CODE
--   IS EXCLUDED FOR STARTING WITH X: XCD, XOF, XAF and XPF are real circulating
--   currencies with numeric minor units and are seeded like any other. A hand-maintained
--   exclusion list would be a second definition of "which currencies exist", free to
--   drift from the standard and impossible to re-derive from the source.
--
--   Historic entries are never read. Only list-one.xml is an input, so a withdrawn
--   currency can never become writable on a new receipt.
--
-- WHY minor_unit IS HERE WHEN iso_country_codes CARRIES NO NAME
--   Migration 20260719201514 deliberately holds codes and nothing else, because nothing
--   renders a country name. minor_unit is not decoration: it is required to convert a
--   printed amount into integer minor units and to render one back, so a currency row
--   without it would be unusable for the only purpose this table has.
--
-- Purpose: the integrity reference for every currency this system may record.
--   public.receipt_extractions.currency_code and public.receipt_confirmations.currency_code
--   both carry a foreign key to it (migration 20260812210000). Without the seed, no
--   confirmation can be written at all — the column is NOT NULL.
--
-- Idempotency posture: ON CONFLICT (code) DO NOTHING, matching the convention every seed
--   migration in this project uses. A re-run is a no-op, no row is rewritten, and NOTHING
--   IS EVER DELETED here — a code removed from this statement in a future regeneration
--   would remain in the table until a migration removes it deliberately, which is the
--   safe direction for a table that foreign keys depend on.
--
-- Dependencies: none. This migration reads no existing table and alters nothing.

-- ============================================================================
-- PART 1 — public.iso_currency_codes
-- ============================================================================
-- An integrity reference, not application data. \`code\` IS the primary key, so it is
-- unique and indexed by definition and the foreign keys reference it directly. The column
-- is \`text\` to match the referencing columns exactly; a char(3) key would introduce a
-- type difference across every foreign key for no benefit.
create table public.iso_currency_codes (
  code text not null,

  -- 0, 2, 3 or 4. The four values ISO 4217 actually uses for circulating currencies, and
  -- the four this project's amount parser understands. A fifth value would silently
  -- change what "minor unit" means for every stored amount, so it is refused here rather
  -- than discovered later.
  minor_unit smallint not null,

  constraint iso_currency_codes_pkey primary key (code),

  -- Exactly three uppercase ASCII letters. COLLATE "C" is load-bearing rather than
  -- decorative: PostgreSQL evaluates regex bracket ranges like [A-Z] according to the
  -- database collation, so under a locale-aware collation the range can admit characters
  -- well outside ASCII. Pinning the operand to the C collation makes [A-Z] mean exactly
  -- the 26 ASCII letters, on every host. This matches iso_country_codes_format from
  -- migration 20260719201514.
  --
  -- This guards the TABLE's own contents: it is what stops a future migration seeding
  -- 'usd', 'U1' or '' into the reference set and thereby widening what every referencing
  -- column accepts.
  constraint iso_currency_codes_format
    check (code collate "C" ~ '^[A-Z]{3}$'),

  constraint iso_currency_codes_minor_unit_allowed
    check (minor_unit in (0, 2, 3, 4))
);

comment on table public.iso_currency_codes is
  'ISO 4217 active alphabetic currency codes and their minor units. Generated from the official SIX Group active list; see the migration header for source, publication date and digest.';

-- ============================================================================
-- PART 2 — Seed
-- ============================================================================
insert into public.iso_currency_codes (code, minor_unit)
values
${rows}
on conflict (code) do nothing;

-- ============================================================================
-- PART 3 — Row Level Security and privileges
-- ============================================================================
-- RLS enabled with ZERO POLICIES: default-deny for the anon/authenticated
-- (publishable-key) roles, reads and writes alike. No policy is added because no browser
-- code has any reason to enumerate this table — the application ships its own copy of the
-- list in lib/reference/iso-currency-codes.ts, so a client-side read would be a redundant
-- round trip for data the bundle already contains.
--
-- No table privilege is granted to anon or authenticated either. Together with the
-- missing policies that is two independent blocks, matching the posture every table in
-- this schema uses. service_role receives no grant either: it reaches this table only
-- through SECURITY DEFINER functions, exactly as it reaches public.receipt_submissions.
--
-- FOREIGN KEY ENFORCEMENT IS UNAFFECTED BY BOTH OF THOSE. PostgreSQL performs referential
-- integrity checks with the referencing table's owner rights and with row security
-- bypassed, so the foreign keys in migration 20260812210000 work regardless.
alter table public.iso_currency_codes enable row level security;

revoke all on table public.iso_currency_codes from public;
revoke all on table public.iso_currency_codes from anon;
revoke all on table public.iso_currency_codes from authenticated;

-- service_role TOO, and that is a deliberate step BEYOND the posture the older tables were
-- left in. Supabase's default privileges grant ALL on a new public table to service_role, and
-- a bare \`revoke ... from public/anon/authenticated\` leaves REFERENCES, TRIGGER and TRUNCATE
-- behind. TRUNCATE is the one that matters: it BYPASSES ROW TRIGGERS, so on the tables this
-- milestone adds it would defeat the never-delete and immutability guards outright. Revoking
-- it costs nothing — service_role reaches every one of these tables through SECURITY DEFINER
-- functions, which run as the owner and are unaffected.
revoke all on table public.iso_currency_codes from service_role;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One table and one seed. No existing table, column, constraint, index, trigger, policy,
-- function, role, permission or mapping is created, altered or dropped, and no table
-- privilege is granted to any role.
`;
}

function buildTypeScript(entries, meta) {
  const rows = entries
    .map(({ code, minorUnit }) => `  { code: "${code}", minorUnit: ${minorUnit} },`)
    .join("\n");

  return `/**
 * ISO 4217 active alphabetic currency codes and their minor units.
 *
 * GENERATED FILE — do not edit by hand.
 *   Regenerate with scripts/generate-iso-currency-codes.mjs from the pinned source below.
 *   supabase/migrations/20260812090000_iso_currency_codes.sql is generated from the SAME
 *   input in the SAME run, and ./iso-currency-codes.test.ts fails the build if the two
 *   ever disagree by code or by minor unit.
 *
 * PROVENANCE
 *   Source:           ${meta.sourceUrl}
 *   Maintained by:    SIX Group, the ISO 4217 Maintenance Agency
 *   Publication date: ${meta.publicationDate}   (the Pblshd attribute of the source)
 *   Source SHA-256:   ${meta.sha256}
 *   Fetched on:       ${meta.fetchedOn}
 *   Entries read:     ${meta.read}
 *   Codes included:   ${entries.length}
 *   Excluded:         ${meta.skippedTotal} (${meta.skippedNonNumericMinorUnit} non-numeric minor unit, ${meta.skippedMissingMinorUnit} no minor unit, ${meta.skippedUnsupportedMinorUnit} unsupported minor unit, ${meta.skippedNoCode} no currency code, ${meta.skippedMalformedCode} malformed code)
 *
 * THE MECHANICAL INCLUSION RULE
 *   A code is included if and only if it appears in the official ACTIVE list, its
 *   alphabetic code is exactly three uppercase ASCII letters, and its minor-unit value
 *   parses as exactly one of 0, 2, 3, 4.
 *
 *   Everything else is excluded BY THE RULE and not by a curated list. NO CODE IS
 *   EXCLUDED FOR STARTING WITH X — XCD, XOF, XAF and XPF are real circulating currencies
 *   and are included like any other. Historic entries are never read.
 *
 * BROWSER-SAFE AND DEPENDENCY-FREE. This module imports nothing, reads no environment,
 * touches no network and has no side effects, so it is safe in a Client Component, a
 * Server Component, a Server Action, an Edge Function and a test alike.
 *
 * THE DATABASE IS THE ENFORCEMENT BOUNDARY. public.iso_currency_codes seeds exactly these
 * rows and both currency_code columns carry a foreign key to it. This module exists so
 * the application can render a minor-unit-correct amount and produce a clear per-field
 * message without a round trip — never as a substitute for that constraint.
 */

/** One active ISO 4217 currency: its alphabetic code and its minor-unit exponent. */
export type IsoCurrency = {
  /** Three uppercase ASCII letters. */
  readonly code: string;
  /** The number of decimal places the currency subdivides into: 0, 2, 3 or 4. */
  readonly minorUnit: 0 | 2 | 3 | 4;
};

/** The active ISO 4217 currencies with a supported minor unit, sorted by code. */
export const ISO_CURRENCIES: readonly IsoCurrency[] = [
${rows}
];

/** Every included code, sorted, uppercase. */
export const ISO_CURRENCY_CODES: readonly string[] = ISO_CURRENCIES.map(
  (currency) => currency.code,
);

const BY_CODE: ReadonlyMap<string, IsoCurrency> = new Map(
  ISO_CURRENCIES.map((currency) => [currency.code, currency]),
);

/**
 * True when \`value\` is an active ISO 4217 code this project accepts.
 *
 * Case-sensitive on purpose: the database CHECK is \`^[A-Z]{3}$\` under the C collation, so
 * a lower-case value is not a currency code here either. Callers normalise before asking.
 */
export function isIsoCurrencyCode(value: string): boolean {
  return BY_CODE.has(value);
}

/**
 * The minor-unit exponent for \`code\`, or null when the code is not an accepted currency.
 *
 * Returning null rather than defaulting to 2 is deliberate: assuming two decimal places
 * for an unknown code would silently misread every JPY, KWD and BHD amount by a factor of
 * 100 or 10, and a wrong amount is worse than a refused one.
 */
export function isoCurrencyMinorUnit(code: string): 0 | 2 | 3 | 4 | null {
  return BY_CODE.get(code)?.minorUnit ?? null;
}
`;
}

main();
