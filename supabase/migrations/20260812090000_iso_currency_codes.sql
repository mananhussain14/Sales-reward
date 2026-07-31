-- Migration: iso_currency_codes
-- GENERATED FILE — do not edit by hand.
--   Regenerate with scripts/generate-iso-currency-codes.mjs from the pinned source below.
--   lib/reference/iso-currency-codes.ts is generated from the SAME input in the SAME run,
--   and lib/reference/iso-currency-codes.test.ts fails the build if the two disagree.
--
-- PROVENANCE
--   Source:          https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
--   Maintained by:   SIX Group, the ISO 4217 Maintenance Agency
--   Publication date 2026-01-01   (the Pblshd attribute of the source)
--   Source SHA-256:  838dfb991648cf36df939edd5fe3811737962b75a32252847d239cedd1e291c9
--   Fetched on:      2026-07-30
--   Entries read:    280
--   Codes seeded:    165
--   Excluded:        16 (13 non-numeric minor unit, 0 no minor unit, 0 unsupported minor unit, 3 no currency code, 0 malformed code)
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
-- An integrity reference, not application data. `code` IS the primary key, so it is
-- unique and indexed by definition and the foreign keys reference it directly. The column
-- is `text` to match the referencing columns exactly; a char(3) key would introduce a
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
  ('AED', 2),
  ('AFN', 2),
  ('ALL', 2),
  ('AMD', 2),
  ('AOA', 2),
  ('ARS', 2),
  ('AUD', 2),
  ('AWG', 2),
  ('AZN', 2),
  ('BAM', 2),
  ('BBD', 2),
  ('BDT', 2),
  ('BHD', 3),
  ('BIF', 0),
  ('BMD', 2),
  ('BND', 2),
  ('BOB', 2),
  ('BOV', 2),
  ('BRL', 2),
  ('BSD', 2),
  ('BTN', 2),
  ('BWP', 2),
  ('BYN', 2),
  ('BZD', 2),
  ('CAD', 2),
  ('CDF', 2),
  ('CHE', 2),
  ('CHF', 2),
  ('CHW', 2),
  ('CLF', 4),
  ('CLP', 0),
  ('CNY', 2),
  ('COP', 2),
  ('COU', 2),
  ('CRC', 2),
  ('CUP', 2),
  ('CVE', 2),
  ('CZK', 2),
  ('DJF', 0),
  ('DKK', 2),
  ('DOP', 2),
  ('DZD', 2),
  ('EGP', 2),
  ('ERN', 2),
  ('ETB', 2),
  ('EUR', 2),
  ('FJD', 2),
  ('FKP', 2),
  ('GBP', 2),
  ('GEL', 2),
  ('GHS', 2),
  ('GIP', 2),
  ('GMD', 2),
  ('GNF', 0),
  ('GTQ', 2),
  ('GYD', 2),
  ('HKD', 2),
  ('HNL', 2),
  ('HTG', 2),
  ('HUF', 2),
  ('IDR', 2),
  ('ILS', 2),
  ('INR', 2),
  ('IQD', 3),
  ('IRR', 2),
  ('ISK', 0),
  ('JMD', 2),
  ('JOD', 3),
  ('JPY', 0),
  ('KES', 2),
  ('KGS', 2),
  ('KHR', 2),
  ('KMF', 0),
  ('KPW', 2),
  ('KRW', 0),
  ('KWD', 3),
  ('KYD', 2),
  ('KZT', 2),
  ('LAK', 2),
  ('LBP', 2),
  ('LKR', 2),
  ('LRD', 2),
  ('LSL', 2),
  ('LYD', 3),
  ('MAD', 2),
  ('MDL', 2),
  ('MGA', 2),
  ('MKD', 2),
  ('MMK', 2),
  ('MNT', 2),
  ('MOP', 2),
  ('MRU', 2),
  ('MUR', 2),
  ('MVR', 2),
  ('MWK', 2),
  ('MXN', 2),
  ('MXV', 2),
  ('MYR', 2),
  ('MZN', 2),
  ('NAD', 2),
  ('NGN', 2),
  ('NIO', 2),
  ('NOK', 2),
  ('NPR', 2),
  ('NZD', 2),
  ('OMR', 3),
  ('PAB', 2),
  ('PEN', 2),
  ('PGK', 2),
  ('PHP', 2),
  ('PKR', 2),
  ('PLN', 2),
  ('PYG', 0),
  ('QAR', 2),
  ('RON', 2),
  ('RSD', 2),
  ('RUB', 2),
  ('RWF', 0),
  ('SAR', 2),
  ('SBD', 2),
  ('SCR', 2),
  ('SDG', 2),
  ('SEK', 2),
  ('SGD', 2),
  ('SHP', 2),
  ('SLE', 2),
  ('SOS', 2),
  ('SRD', 2),
  ('SSP', 2),
  ('STN', 2),
  ('SVC', 2),
  ('SYP', 2),
  ('SZL', 2),
  ('THB', 2),
  ('TJS', 2),
  ('TMT', 2),
  ('TND', 3),
  ('TOP', 2),
  ('TRY', 2),
  ('TTD', 2),
  ('TWD', 2),
  ('TZS', 2),
  ('UAH', 2),
  ('UGX', 0),
  ('USD', 2),
  ('USN', 2),
  ('UYI', 0),
  ('UYU', 2),
  ('UYW', 4),
  ('UZS', 2),
  ('VED', 2),
  ('VES', 2),
  ('VND', 0),
  ('VUV', 0),
  ('WST', 2),
  ('XAD', 2),
  ('XAF', 0),
  ('XCD', 2),
  ('XCG', 2),
  ('XOF', 0),
  ('XPF', 0),
  ('YER', 2),
  ('ZAR', 2),
  ('ZMW', 2),
  ('ZWG', 2)
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
-- a bare `revoke ... from public/anon/authenticated` leaves REFERENCES, TRIGGER and TRUNCATE
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
