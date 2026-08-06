-- pgTAP behavioural tests for the RETAILER SHOP TIME ZONE:
--
--   public.retailer_shops.timezone_name                    [20260817210000]
--   retailer_shops_timezone_name_shape          (constraint)
--   public.retailer_shops_assert_timezone()        (trigger)
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- receipt_confirmations stores a CIVIL date and an optional CIVIL time, and campaign periods
-- are timestamptz. Without a per-shop zone the two cannot be compared, so this column is the
-- missing fact the reward engine needs -- and a WRONG value here moves a sale by hours and
-- changes what somebody is paid.
--
-- Two independent defences are proved:
--   * the SHAPE constraint, which insists on Region/City form and so excludes fixed offsets
--     without needing a catalogue lookup (Section B);
--   * the catalogue TRIGGER, which rejects a perfectly-shaped name that does not exist
--     (Section C).
--
-- Section D proves the column is genuinely optional and that legacy rows are left NULL rather
-- than guessed, and Section E proves the surrounding permissions were not disturbed.
--
-- Everything runs inside one transaction and is rolled back. no_plan(), per convention.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers and fixture
-- ============================================================================
create function pg_temp.new_org(p_name text, p_type text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.organizations (name, organization_type, status, country_code, default_currency)
  values (p_name, p_type, 'ACTIVE', 'AE', 'AED')
  returning id into v_id;
  return v_id;
end;
$$;

create table pg_temp.f (k text primary key, v uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select v from pg_temp.f where k = p
$$;

-- Attempts to set a zone on the scratch shop and reports the resulting SQLSTATE, or null when
-- it succeeded. One helper keeps the accept/reject tables below readable.
create function pg_temp.try_tz(p_tz text) returns text
language plpgsql as $$
begin
  update public.retailer_shops set timezone_name = p_tz where id = pg_temp.id('scratch');
  return null;
exception when others then
  return sqlstate;
end;
$$;

do $$
declare v_ret uuid; v_shop uuid;
begin
  v_ret := pg_temp.new_org('Retailer Alpha', 'RETAILER');
  insert into public.retailer_shops (retailer_organization_id, name)
  values (v_ret, 'Scratch Shop') returning id into v_shop;
  insert into pg_temp.f values ('ret', v_ret), ('scratch', v_shop);
end;
$$;

-- ============================================================================
-- SECTION A — the column exists and is optional
-- ============================================================================
select has_column('public', 'retailer_shops', 'timezone_name',
  'A1. retailer_shops carries a timezone_name column');

select col_type_is('public', 'retailer_shops', 'timezone_name', 'text',
  'A2. and it is text — an IANA identifier, never a numeric offset');

select col_is_null('public', 'retailer_shops', 'timezone_name',
  'A3. and it is NULLABLE — no existing shop could be backfilled honestly, so none was');

-- ============================================================================
-- SECTION B — real IANA names are accepted
-- ============================================================================
select is(pg_temp.try_tz('Asia/Kuwait'),      null, 'B1. Asia/Kuwait is accepted');
select is(pg_temp.try_tz('Europe/London'),    null, 'B2. Europe/London is accepted');
select is(pg_temp.try_tz('Europe/Paris'),     null, 'B3. Europe/Paris is accepted');
select is(pg_temp.try_tz('America/New_York'), null, 'B4. America/New_York is accepted — underscores and all');
select is(pg_temp.try_tz('Asia/Dubai'),       null, 'B5. Asia/Dubai is accepted');

-- Three-segment and hyphenated names are real and must not be excluded by an over-tight shape.
select is(pg_temp.try_tz('America/Argentina/Buenos_Aires'), null,
  'B6. a THREE-segment name is accepted');
select is(pg_temp.try_tz('America/Port-au-Prince'), null,
  'B7. and a hyphenated one');

select is(
  (select timezone_name from public.retailer_shops where id = pg_temp.id('scratch')),
  'America/Port-au-Prince',
  'B8. the stored value is the identifier verbatim — nothing is normalized or rewritten'
);

-- ============================================================================
-- SECTION C — fixed offsets and nonsense are refused
-- ============================================================================
-- A fixed offset cannot follow the daylight-saving rules of the place a shop stands, so a
-- summer sale would resolve to the wrong instant. These are refused by SHAPE, before any
-- catalogue lookup happens.
select is(pg_temp.try_tz('UTC+3'), '23514',
  'C1. UTC+3 is refused — an offset is not a place');
select is(pg_temp.try_tz('GMT+3'), '23514',
  'C2. GMT+3 likewise');
select is(pg_temp.try_tz('+04:00'), '23514',
  'C3. and a bare numeric offset');
select is(pg_temp.try_tz('UTC'), '23514',
  'C4. bare UTC is refused — a retail shop is somewhere, and UTC is nowhere');
select is(pg_temp.try_tz('EST'), '23514',
  'C5. and a bare abbreviation, which PostgreSQL would otherwise accept as a fixed offset');
select is(pg_temp.try_tz('Etc/GMT+3'), '23514',
  'C6. Etc/GMT+3 is refused too — a fixed offset wearing a region-shaped name');
select is(pg_temp.try_tz('Etc/UTC'), '23514',
  'C7. and every other Etc/ entry');

-- Shaped correctly, but no such place. Only the catalogue can catch this one.
select is(pg_temp.try_tz('Europe/Atlantis'), '23514',
  'C8. a well-shaped name that does not exist is refused by the catalogue trigger');

select is(pg_temp.try_tz('asia/kuwait'), '23514',
  'C9. and the catalogue is case-sensitive — a lower-cased name is not a real zone');

select is(pg_temp.try_tz(''), '23514',
  'C10. the empty string is refused');
select is(pg_temp.try_tz('  Asia/Kuwait  '), '23514',
  'C11. and an untrimmed name is refused rather than silently trimmed');

-- THE MOST IMPORTANT ONE. A rejected write must leave the previous value standing; silently
-- falling back to UTC is exactly the failure this column exists to prevent.
select is(
  (select timezone_name from public.retailer_shops where id = pg_temp.id('scratch')),
  'America/Port-au-Prince',
  'C12. after every refusal the previous zone still stands — there is NO silent UTC fallback'
);

-- ============================================================================
-- SECTION D — NULL is a legitimate state, and the default
-- ============================================================================
select is(pg_temp.try_tz(null), null,
  'D1. a zone can be cleared back to NULL — "not set yet" stays expressible');

select is(
  (select timezone_name from public.retailer_shops where id = pg_temp.id('scratch')),
  null,
  'D2. and the column really is null afterwards'
);

do $$
declare v_shop uuid;
begin
  insert into public.retailer_shops (retailer_organization_id, name)
  values (pg_temp.id('ret'), 'Fresh Shop') returning id into v_shop;
  insert into pg_temp.f values ('fresh', v_shop);
end;
$$;

select is(
  (select timezone_name from public.retailer_shops where id = pg_temp.id('fresh')),
  null,
  'D3. a NEWLY created shop has no zone — nothing is inferred from country_code'
);

-- The backfill deliberately guessed nothing, so no shop that predates the migration has a
-- zone. Stated as a property rather than a count, because the count depends on the fixture.
select is(
  (select count(*)::integer from public.retailer_shops
   where timezone_name is not null and id <> pg_temp.id('scratch')),
  0,
  'D4. no shop anywhere was backfilled with a guessed zone'
);

-- A shop can be created WITH a zone in one statement, and the INSERT trigger validates it.
select throws_ok(
  format($$ insert into public.retailer_shops (retailer_organization_id, name, timezone_name)
            values (%L, 'Bad Shop', 'Europe/Atlantis') $$, pg_temp.id('ret')),
  '23514', 'Choose a valid shop time zone',
  'D5. the validation also runs on INSERT, not only on UPDATE'
);

select lives_ok(
  format($$ insert into public.retailer_shops (retailer_organization_id, name, timezone_name)
            values (%L, 'Good Shop', 'Asia/Kuwait') $$, pg_temp.id('ret')),
  'D6. and a valid zone can be set at creation time'
);

-- ============================================================================
-- SECTION E — the surrounding permissions are unchanged
-- ============================================================================
-- Adding a nullable column must not have widened or narrowed anything. retailer_shops keeps
-- the read posture migration 20260717114028 gave it.
select ok(
  has_table_privilege('authenticated', 'public.retailer_shops', 'SELECT'),
  'E1. authenticated still holds SELECT on retailer_shops'
);

select ok(
  not has_table_privilege('authenticated', 'public.retailer_shops', 'INSERT')
  and not has_table_privilege('authenticated', 'public.retailer_shops', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.retailer_shops', 'DELETE'),
  'E2. and still holds no write privilege — the zone cannot be set from a browser'
);

select ok(
  (select relrowsecurity from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'retailer_shops'),
  'E3. row level security is still enabled'
);

select is(
  (select count(*)::integer from pg_catalog.pg_policy p
   join pg_catalog.pg_class c on c.oid = p.polrelid
   where c.relname = 'retailer_shops' and p.polname = 'retailer_shops_select_vendor_authorized'),
  1,
  'E4. and the existing read policy is untouched'
);

select * from finish();
rollback;
