-- Migration: enforce_iso_country_codes
-- Purpose: Make the database reject country codes that are not currently
--          assigned ISO 3166-1 alpha-2 values. Two parts:
--            1. public.iso_country_codes — a reference table holding exactly the
--               249 assigned codes.
--            2. NOT VALID foreign keys from public.organizations.country_code and
--               public.retailer_shops.country_code to that table.
--
-- The problem this fixes:
--   Both country_code columns previously admitted any two-letter string. The
--   organizations check only measures LENGTH
--   (organizations_country_code_len: char_length = 2), and the shops check only
--   measures SHAPE (retailer_shops_country_code_format: ^[A-Z]{2}$ under the C
--   collation). Neither asks whether the code names a real country, so 'DD'
--   (retired), 'II' (user-assigned range), and 'ZZ' (indeterminate) were all
--   storable. A country code that is merely well-shaped is not data — it is a
--   typo the schema agreed to keep.
--
-- Why a reference table and a foreign key, rather than a bigger CHECK:
--   A 249-element IN list inside a CHECK constraint would be unreadable, would
--   have to be repeated on both columns, and could not be amended without
--   rewriting a constraint on a live table. ISO 3166-1 does change — codes are
--   assigned and retired — so the allowed set is DATA, not a rule, and data
--   belongs in a table. Adding or retiring a code then becomes one INSERT or one
--   DELETE in a future migration, and every referencing column follows
--   automatically.
--
-- WHY NOT VALID, AND WHY THAT IS THE WHOLE POINT:
--   Existing rows already contain invalid codes — test data written before this
--   rule existed carries values such as 'DD' and 'II'. A validating foreign key
--   would fail to be created at all, and "fixing" those rows would mean silently
--   rewriting or deleting records this migration has no business touching.
--   NOT VALID skips the initial full-table scan while STILL ENFORCING the
--   constraint on every INSERT and every UPDATE from the moment it is added.
--   That is exactly the requirement: future writes are clean, history is left
--   alone.
--
--   These constraints are deliberately NOT validated here, and no later migration
--   should run `VALIDATE CONSTRAINT` until the offending rows have been reviewed
--   and corrected as a separate, deliberate data decision. Validation is a
--   one-line follow-up whenever that day comes.
--
-- NULL is still allowed. Both columns remain nullable and a foreign key ignores
-- NULL entirely (MATCH SIMPLE), so "no country recorded" stays a legitimate
-- state — which it must, since every shop address field is optional by design.
--
-- Scope notes:
--   * No existing row is read for modification, updated, or deleted. Nothing
--     repairs, rewrites, or removes 'DD', 'II', or any other stored value.
--   * No existing table, column, check constraint, index, trigger, policy,
--     function, or RPC is altered or replaced. In particular
--     onboard_vendor_retailer() and add_vendor_retailer_shop() are untouched:
--     their in-function shape checks remain correct as far as they go, and the
--     new foreign keys sit underneath them as the final enforcement boundary.
--     Neither RPC needs to know this table exists.
--   * No earlier migration is modified.
--
-- Dependencies: migration 1 (organizations), migration 8 (retailer_shops).

-- ============================================================================
-- PART 1 — public.iso_country_codes
-- ============================================================================
-- An integrity reference, not application data. It holds codes and nothing else:
-- no country names, no timestamps, no id column. A name column would be a second
-- thing to keep correct and translated, and nothing in this project renders one —
-- the forms take a code and the pages display a code. If display names are ever
-- needed they can be added then, by a migration that has a reason to.
--
-- `code` IS the primary key, so it is unique and indexed by definition, and the
-- foreign keys below reference it directly.
--
-- The column is `text` to match the referencing columns exactly. Both
-- organizations.country_code and retailer_shops.country_code are `text`; a
-- char(2) or varchar(2) key here would still work but would introduce a type
-- difference across the foreign key for no benefit.
create table public.iso_country_codes (
  code text primary key,

  -- Exactly two uppercase ASCII letters. COLLATE "C" is load-bearing rather than
  -- decorative: PostgreSQL evaluates regex bracket ranges like [A-Z] according to
  -- the database collation, so under a locale-aware collation the range can admit
  -- characters well outside ASCII. Pinning the operand to the C collation makes
  -- [A-Z] mean exactly the 26 ASCII letters, on every host. This matches
  -- retailer_shops_country_code_format from migration 8.
  --
  -- This guards the TABLE's own contents: it is what stops a future migration
  -- from seeding 'usa', 'U1', or '' into the reference set and thereby widening
  -- what every referencing column accepts.
  constraint iso_country_codes_format
    check (code collate "C" ~ '^[A-Z]{2}$')
);

-- ============================================================================
-- PART 2 — Seed the 249 currently assigned codes
-- ============================================================================
-- Officially assigned ISO 3166-1 alpha-2 codes only.
--
-- Deliberately absent, and each for a different reason:
--   * DD — transitionally reserved (former German Democratic Republic). Retired,
--          not assigned. Existing rows carrying it are left untouched by the
--          NOT VALID constraints below; it simply cannot be written again.
--   * II — inside the user-assigned range. ISO never assigns these to a country;
--          they exist for private use and mean nothing outside one system.
--   * ZZ — indeterminate/user-assigned, same reasoning.
--   * XK — Kosovo. Widely used in practice and NOT officially assigned; it lives
--          in the user-assigned range. Excluding it is a reviewed decision, not
--          an oversight. Admitting it later would be a product choice to accept a
--          non-ISO code, and should be its own migration saying so.
--
-- Idempotency: ON CONFLICT DO NOTHING against the primary key, matching the
-- convention every seed migration in this project uses. A re-run is a no-op, no
-- row is rewritten, and NOTHING IS EVER DELETED here — a code removed from this
-- statement in a future edit would remain in the table until a migration removes
-- it deliberately, which is the safe direction for a table that foreign keys
-- depend on.
--
-- This set is generated from the same source list as
-- lib/reference/iso-country-codes.ts and must stay byte-for-byte equivalent to
-- it. The application list produces a clear per-field error before a round trip;
-- this table is what actually enforces the rule.
insert into public.iso_country_codes (code)
values
  ('AD'), ('AE'), ('AF'), ('AG'), ('AI'), ('AL'), ('AM'), ('AO'),
  ('AQ'), ('AR'), ('AS'), ('AT'), ('AU'), ('AW'), ('AX'), ('AZ'),
  ('BA'), ('BB'), ('BD'), ('BE'), ('BF'), ('BG'), ('BH'), ('BI'),
  ('BJ'), ('BL'), ('BM'), ('BN'), ('BO'), ('BQ'), ('BR'), ('BS'),
  ('BT'), ('BV'), ('BW'), ('BY'), ('BZ'), ('CA'), ('CC'), ('CD'),
  ('CF'), ('CG'), ('CH'), ('CI'), ('CK'), ('CL'), ('CM'), ('CN'),
  ('CO'), ('CR'), ('CU'), ('CV'), ('CW'), ('CX'), ('CY'), ('CZ'),
  ('DE'), ('DJ'), ('DK'), ('DM'), ('DO'), ('DZ'), ('EC'), ('EE'),
  ('EG'), ('EH'), ('ER'), ('ES'), ('ET'), ('FI'), ('FJ'), ('FK'),
  ('FM'), ('FO'), ('FR'), ('GA'), ('GB'), ('GD'), ('GE'), ('GF'),
  ('GG'), ('GH'), ('GI'), ('GL'), ('GM'), ('GN'), ('GP'), ('GQ'),
  ('GR'), ('GS'), ('GT'), ('GU'), ('GW'), ('GY'), ('HK'), ('HM'),
  ('HN'), ('HR'), ('HT'), ('HU'), ('ID'), ('IE'), ('IL'), ('IM'),
  ('IN'), ('IO'), ('IQ'), ('IR'), ('IS'), ('IT'), ('JE'), ('JM'),
  ('JO'), ('JP'), ('KE'), ('KG'), ('KH'), ('KI'), ('KM'), ('KN'),
  ('KP'), ('KR'), ('KW'), ('KY'), ('KZ'), ('LA'), ('LB'), ('LC'),
  ('LI'), ('LK'), ('LR'), ('LS'), ('LT'), ('LU'), ('LV'), ('LY'),
  ('MA'), ('MC'), ('MD'), ('ME'), ('MF'), ('MG'), ('MH'), ('MK'),
  ('ML'), ('MM'), ('MN'), ('MO'), ('MP'), ('MQ'), ('MR'), ('MS'),
  ('MT'), ('MU'), ('MV'), ('MW'), ('MX'), ('MY'), ('MZ'), ('NA'),
  ('NC'), ('NE'), ('NF'), ('NG'), ('NI'), ('NL'), ('NO'), ('NP'),
  ('NR'), ('NU'), ('NZ'), ('OM'), ('PA'), ('PE'), ('PF'), ('PG'),
  ('PH'), ('PK'), ('PL'), ('PM'), ('PN'), ('PR'), ('PS'), ('PT'),
  ('PW'), ('PY'), ('QA'), ('RE'), ('RO'), ('RS'), ('RU'), ('RW'),
  ('SA'), ('SB'), ('SC'), ('SD'), ('SE'), ('SG'), ('SH'), ('SI'),
  ('SJ'), ('SK'), ('SL'), ('SM'), ('SN'), ('SO'), ('SR'), ('SS'),
  ('ST'), ('SV'), ('SX'), ('SY'), ('SZ'), ('TC'), ('TD'), ('TF'),
  ('TG'), ('TH'), ('TJ'), ('TK'), ('TL'), ('TM'), ('TN'), ('TO'),
  ('TR'), ('TT'), ('TV'), ('TW'), ('TZ'), ('UA'), ('UG'), ('UM'),
  ('US'), ('UY'), ('UZ'), ('VA'), ('VC'), ('VE'), ('VG'), ('VI'),
  ('VN'), ('VU'), ('WF'), ('WS'), ('YE'), ('YT'), ('ZA'), ('ZM'),
  ('ZW')
on conflict (code) do nothing;

-- ============================================================================
-- PART 3 — Row Level Security and privileges
-- ============================================================================
-- RLS enabled with ZERO policies: default-deny for the anon/authenticated
-- (publishable-key) roles, reads and writes alike. No policy is added because no
-- browser code has any reason to enumerate this table — the application ships its
-- own copy of the list in lib/reference/iso-country-codes.ts, so a client-side
-- read would be a redundant round trip for data the bundle already contains.
--
-- No table privilege is granted to anon or authenticated either. Together with
-- the missing policies that is two independent blocks, matching the posture
-- migrations 8 and 9 established for the Retailer tables.
--
-- FOREIGN KEY ENFORCEMENT IS UNAFFECTED BY BOTH OF THOSE. PostgreSQL performs
-- referential-integrity checks with the referencing table's owner rights and with
-- row security bypassed, precisely so that RLS on a referenced table cannot
-- silently turn a foreign key into a no-op. A caller therefore needs no SELECT
-- privilege and no policy on this table for the constraints below to hold against
-- them — which is exactly what an integrity reference should look like: invisible
-- and inescapable.
alter table public.iso_country_codes enable row level security;

-- PUBLIC is inherited by every role, so any privilege left here would leak to
-- anon and authenticated regardless. Revoking is what actually removes the
-- table privileges Supabase's default grants would otherwise hand out.
revoke all on table public.iso_country_codes from public;
revoke all on table public.iso_country_codes from anon;
revoke all on table public.iso_country_codes from authenticated;

-- ============================================================================
-- PART 4 — Future-write enforcement on the two country_code columns
-- ============================================================================
-- Explicit, stable constraint names on both, so a later migration can validate,
-- drop, or re-create them by name rather than by whatever PostgreSQL would have
-- generated.
--
-- ON DELETE / ON UPDATE are deliberately left at their NO ACTION defaults. A code
-- that is retired from ISO must not silently null out or rewrite the country of
-- every organization or shop that referenced it; the correct response to such a
-- retirement is a reviewed data migration, and NO ACTION is what forces that
-- conversation instead of quietly losing data.
--
-- NOT VALID on both: enforced for every future INSERT and UPDATE, while existing
-- rows — including the ones carrying 'DD' and 'II' — are neither checked, nor
-- read for modification, nor touched in any way.

alter table public.organizations
  add constraint organizations_country_code_iso_fkey
  foreign key (country_code)
  references public.iso_country_codes (code)
  not valid;

alter table public.retailer_shops
  add constraint retailer_shops_country_code_iso_fkey
  foreign key (country_code)
  references public.iso_country_codes (code)
  not valid;

-- No VALIDATE CONSTRAINT anywhere in this migration, by design. See the header.
