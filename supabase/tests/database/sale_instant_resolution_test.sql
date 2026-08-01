-- pgTAP behavioural tests for the AUTHORITATIVE SALE-INSTANT RESOLVER:
--
--   public.resolve_sale_instant(uuid, date, time without time zone)   [20260817210000]
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- A printed receipt carries a CIVIL date and, sometimes, a civil time. A campaign period is
-- a pair of instants. Turning the first into the second is the single most consequential
-- conversion in the reward engine: an hour either way can move a sale across a campaign
-- boundary and change what somebody is paid.
--
-- The claims proved here:
--   * an explicit time resolves through the SHOP's zone, and the zone is never a parameter
--     (Section B);
--   * a date-only receipt resolves to NOON local, reported as DATE_ONLY so it can never be
--     mistaken for something that was printed (Section C);
--   * the caller's session timezone cannot change the answer (Section D);
--   * both daylight-saving failures are REFUSED rather than silently resolved, in a
--     one-hour zone AND in a thirty-minute zone (Section E);
--   * a shop with no zone, and an unknown shop, each fail safely and differently (Section F);
--   * nothing is reachable by a browser role (Section A).
--
-- ============================================================================
-- WHY THE DAYLIGHT-SAVING CASES MATTER
-- ============================================================================
-- PostgreSQL does NOT raise for either bad case. For a nonexistent local time it silently
-- returns the instant the pre-transition offset would have produced; for an ambiguous one it
-- silently picks an interpretation. Both would embed an undocumented financial policy, so
-- resolve_sale_instant detects and refuses them. Section E is the regression test for that,
-- and the transition instants it uses were verified against pg_timezone_names rather than
-- assumed.
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

create function pg_temp.new_shop(p_ret uuid, p_name text, p_tz text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.retailer_shops (retailer_organization_id, name, timezone_name)
  values (p_ret, p_name, p_tz) returning id into v_id;
  return v_id;
end;
$$;

create table pg_temp.f (k text primary key, v uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select v from pg_temp.f where k = p
$$;

-- The resolved instant alone, for the many assertions that care about nothing else.
create function pg_temp.at(p_shop text, p_date date, p_time time default null)
returns timestamptz
language sql as $$
  select r.sale_at from public.resolve_sale_instant(pg_temp.id(p_shop), p_date, p_time) r
$$;

-- The SQLSTATE a call raises, or null when it succeeds.
create function pg_temp.err(p_shop uuid, p_date date, p_time time default null)
returns text
language plpgsql as $$
declare v timestamptz;
begin
  select r.sale_at into v from public.resolve_sale_instant(p_shop, p_date, p_time) r;
  return null;
exception when others then
  return sqlstate;
end;
$$;

do $$
declare v_ret uuid;
begin
  v_ret := pg_temp.new_org('Retailer Alpha', 'RETAILER');
  insert into pg_temp.f values
    ('ret',      v_ret),
    ('kuwait',   pg_temp.new_shop(v_ret, 'Kuwait Shop',    'Asia/Kuwait')),
    ('london',   pg_temp.new_shop(v_ret, 'London Shop',    'Europe/London')),
    ('newyork',  pg_temp.new_shop(v_ret, 'New York Shop',  'America/New_York')),
    ('lordhowe', pg_temp.new_shop(v_ret, 'Lord Howe Shop', 'Australia/Lord_Howe')),
    ('nozone',   pg_temp.new_shop(v_ret, 'Unset Shop',     null));
end;
$$;

-- ============================================================================
-- SECTION A — the privilege surface
-- ============================================================================
select ok(
  not has_function_privilege('authenticated',
    'public.resolve_sale_instant(uuid, date, time without time zone)', 'EXECUTE'),
  'A1. the resolver is not reachable by an authenticated browser caller'
);

select ok(
  not has_function_privilege('anon',
    'public.resolve_sale_instant(uuid, date, time without time zone)', 'EXECUTE'),
  'A2. nor by anon'
);

-- It takes a shop id and resolves no tenant of its own, so it must stay behind a contract
-- that has already resolved the caller from auth.uid().
select is(
  (select p.prosecdef from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resolve_sale_instant'),
  true,
  'A3. it is SECURITY DEFINER, like every other resolver in this schema'
);

select ok(
  (select 'search_path=""' = any (p.proconfig) from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resolve_sale_instant'),
  'A4. and runs with an EMPTY search_path'
);

-- ============================================================================
-- SECTION B — an explicit time resolves through the SHOP's zone
-- ============================================================================
-- Asia/Kuwait is UTC+3 all year and observes no daylight saving, so the arithmetic is
-- checkable by eye: 14:30 local is 11:30 UTC.
select is(
  pg_temp.at('kuwait', date '2026-03-15', time '14:30'),
  timestamptz '2026-03-15 11:30:00+00',
  'B1. Asia/Kuwait 14:30 local resolves to 11:30 UTC'
);

select is(
  (select sale_time_precision from public.resolve_sale_instant(
     pg_temp.id('kuwait'), date '2026-03-15', time '14:30')),
  'MINUTE',
  'B2. and the precision is MINUTE'
);

select is(
  (select timezone_name from public.resolve_sale_instant(
     pg_temp.id('kuwait'), date '2026-03-15', time '14:30')),
  'Asia/Kuwait',
  'B3. and the zone that produced it is returned, so Phase 1 can record WHICH zone was used'
);

-- The SAME civil date and time in three different shops must give three different instants.
-- This is the whole point of deriving the zone from the shop.
select isnt(
  pg_temp.at('kuwait', date '2026-06-15', time '12:00'),
  pg_temp.at('london', date '2026-06-15', time '12:00'),
  'B4. the same printed time in a different shop is a different instant'
);

select is(
  pg_temp.at('london', date '2026-06-15', time '12:00'),
  timestamptz '2026-06-15 11:00:00+00',
  'B5. Europe/London in June is UTC+1 — the zone follows summer time, an offset could not'
);

select is(
  pg_temp.at('london', date '2026-01-15', time '12:00'),
  timestamptz '2026-01-15 12:00:00+00',
  'B6. and UTC+0 in January — the SAME shop, a different offset, correctly'
);

select is(
  pg_temp.at('newyork', date '2026-06-15', time '12:00'),
  timestamptz '2026-06-15 16:00:00+00',
  'B7. America/New_York in June is UTC-4'
);

-- Seconds are truncated to the minute, matching receipt_extractions_transaction_time_minute
-- and the identical date_trunc in confirm_receipt_extraction.
select is(
  pg_temp.at('kuwait', date '2026-03-15', time '14:30:59'),
  pg_temp.at('kuwait', date '2026-03-15', time '14:30:00'),
  'B8. a stray second is truncated away rather than shifting the instant'
);

-- ============================================================================
-- SECTION C — a date-only receipt resolves to NOON
-- ============================================================================
-- receipt_confirmations.transaction_time is nullable, so this is the ordinary case for a
-- receipt whose printed time could not be read.
select is(
  pg_temp.at('kuwait', date '2026-03-15', null),
  timestamptz '2026-03-15 09:00:00+00',
  'C1. a date-only sale in Asia/Kuwait resolves to 12:00 local = 09:00 UTC'
);

select is(
  (select sale_time_precision from public.resolve_sale_instant(
     pg_temp.id('kuwait'), date '2026-03-15', null)),
  'DATE_ONLY',
  'C2. and reports DATE_ONLY — the noon is a convention, never a printed time'
);

select isnt(
  (select sale_time_precision from public.resolve_sale_instant(
     pg_temp.id('kuwait'), date '2026-03-15', null)),
  (select sale_time_precision from public.resolve_sale_instant(
     pg_temp.id('kuwait'), date '2026-03-15', time '12:00')),
  'C3. DATE_ONLY stays DISTINGUISHABLE from a receipt that genuinely printed 12:00'
);

select is(
  pg_temp.at('kuwait', date '2026-03-15', null),
  pg_temp.at('kuwait', date '2026-03-15', time '12:00'),
  'C4. even though the two resolve to the same instant — only the precision tells them apart'
);

-- WHY NOON RATHER THAN MIDNIGHT: noon is the furthest point from both day boundaries, so a
-- date-only sale stays on its printed day in every zone on earth. Midnight would not.
select is(
  (pg_temp.at('lordhowe', date '2026-06-15', null) at time zone 'Australia/Lord_Howe')::date,
  date '2026-06-15',
  'C5. a date-only sale stays on its printed local day in a UTC+10:30 zone'
);

select is(
  (pg_temp.at('newyork', date '2026-06-15', null) at time zone 'America/New_York')::date,
  date '2026-06-15',
  'C6. and in a UTC-4 zone — noon survives both directions, midnight would not'
);

-- ============================================================================
-- SECTION D — the caller's session timezone cannot change the answer
-- ============================================================================
-- The resolver converts with an explicit AT TIME ZONE against the SHOP's zone, so the
-- server's configured zone and the caller's session zone are both irrelevant. Proved by
-- moving the session to the far side of the world and re-asking.
set local timezone = 'Pacific/Kiritimati';

select is(
  pg_temp.at('kuwait', date '2026-03-15', time '14:30'),
  timestamptz '2026-03-15 11:30:00+00',
  'D1. an explicit time is unaffected by a UTC+14 session timezone'
);

select is(
  pg_temp.at('kuwait', date '2026-03-15', null),
  timestamptz '2026-03-15 09:00:00+00',
  'D2. and so is the date-only noon rule'
);

set local timezone = 'America/Anchorage';

select is(
  pg_temp.at('kuwait', date '2026-03-15', time '14:30'),
  timestamptz '2026-03-15 11:30:00+00',
  'D3. and by a UTC-9 session timezone'
);

set local timezone = 'UTC';

-- ============================================================================
-- SECTION E — both daylight-saving failures are refused
-- ============================================================================
-- NONEXISTENT: Europe/London springs forward on 2026-03-29, 01:00 -> 02:00, so 01:30 never
-- occurs. PostgreSQL would silently return 02:30's instant.
select is(
  pg_temp.err(pg_temp.id('london'), date '2026-03-29', time '01:30'),
  '22007',
  'E1. a NONEXISTENT local time is refused, not silently shifted forward'
);

-- AMBIGUOUS: Europe/London falls back on 2026-10-25, 02:00 -> 01:00, so 01:30 occurs twice.
-- PostgreSQL would silently pick one of the two instants.
select is(
  pg_temp.err(pg_temp.id('london'), date '2026-10-25', time '01:30'),
  '22023',
  'E2. an AMBIGUOUS local time is refused, not silently disambiguated'
);

select isnt(
  pg_temp.err(pg_temp.id('london'), date '2026-03-29', time '01:30'),
  pg_temp.err(pg_temp.id('london'), date '2026-10-25', time '01:30'),
  'E3. the two failures carry DIFFERENT SQLSTATEs, so Phase 1 can route them separately'
);

-- The same two failures in a zone whose shift is THIRTY minutes, which is the arm of the
-- ambiguity probe most likely to be got wrong. Lord Howe: 2026-10-04 02:00 -> 02:30 (gap),
-- 2026-04-05 02:00 -> 01:30 (ambiguous).
select is(
  pg_temp.err(pg_temp.id('lordhowe'), date '2026-10-04', time '02:15'),
  '22007',
  'E4. a nonexistent time in a THIRTY-MINUTE shift zone is refused too'
);

select is(
  pg_temp.err(pg_temp.id('lordhowe'), date '2026-04-05', time '01:45'),
  '22023',
  'E5. and so is an ambiguous one — the probe covers 30-minute shifts, not just hourly'
);

-- America/New_York, to prove it is not a Europe-specific accident.
select is(
  pg_temp.err(pg_temp.id('newyork'), date '2026-03-08', time '02:30'),
  '22007',
  'E6. and the nonexistent case in America/New_York'
);

select is(
  pg_temp.err(pg_temp.id('newyork'), date '2026-11-01', time '01:30'),
  '22023',
  'E7. and the ambiguous case there'
);

-- ORDINARY TIMES ON THE SAME DAYS MUST STILL RESOLVE. A refusal that swallowed every sale on
-- a transition day would be far worse than the problem it solves.
select is(
  pg_temp.err(pg_temp.id('london'), date '2026-03-29', time '14:00'),
  null,
  'E8. an ordinary afternoon on the spring-forward day resolves normally'
);

select is(
  pg_temp.err(pg_temp.id('london'), date '2026-10-25', time '14:00'),
  null,
  'E9. and on the fall-back day'
);

select is(
  pg_temp.err(pg_temp.id('london'), date '2026-10-25', time '00:30'),
  null,
  'E10. and an unambiguous time BEFORE the fall-back window'
);

select is(
  pg_temp.err(pg_temp.id('london'), date '2026-10-25', time '02:30'),
  null,
  'E11. and one AFTER it — the refusal is narrow, not a blanket'
);

-- THE DATE-ONLY PATH IS DAYLIGHT-SAVING SAFE BY CONSTRUCTION. Real transitions happen in the
-- small hours, so noon is never in a gap and never ambiguous. This is a deliberate second
-- benefit of the noon rule, and it is asserted rather than assumed.
select is(
  pg_temp.err(pg_temp.id('london'), date '2026-03-29', null),
  null,
  'E12. a DATE-ONLY sale on the spring-forward day resolves — noon is never in the gap'
);

select is(
  pg_temp.err(pg_temp.id('london'), date '2026-10-25', null),
  null,
  'E13. and on the fall-back day — noon is never ambiguous'
);

select is(
  pg_temp.err(pg_temp.id('lordhowe'), date '2026-10-04', null),
  null,
  'E14. and in the thirty-minute zone too'
);

-- ============================================================================
-- SECTION F — failing safely
-- ============================================================================
-- A shop with no zone is an ACTIONABLE problem: an operator sets it. 55000 says "the target
-- is not in a state this operation can act on", which is the project's code for exactly that.
select is(
  pg_temp.err(pg_temp.id('nozone'), date '2026-03-15', time '14:30'),
  '55000',
  'F1. a shop with no zone refuses with a domain-specific error'
);

select is(
  pg_temp.err(pg_temp.id('nozone'), date '2026-03-15', null),
  '55000',
  'F2. and refuses the date-only path identically — noon needs a zone as much as any time'
);

-- The most important negative in the suite: it must RAISE rather than fall back to
-- ANYTHING. A function that returned a UTC-based instant here would look authoritative and
-- be silently wrong for the place the sale happened, which is the whole failure this column
-- exists to prevent. Asserted against the exact message so a future edit cannot quietly
-- replace the refusal with a default.
select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-03-15', time '14:30') $$,
         pg_temp.id('nozone')),
  '55000', 'That shop has no time zone recorded, so a sale instant cannot be resolved',
  'F3. it REFUSES rather than falling back to UTC, the server zone or the session zone'
);

-- An unknown shop is reported with the SAME generic refusal a caller would get for a shop
-- belonging to another Retailer, so the resolver cannot be used to discover which ids exist.
select is(
  pg_temp.err(gen_random_uuid(), date '2026-03-15', time '14:30'),
  '42501',
  'F4. an unknown shop id refuses as "not authorized", not as "not found"'
);

select is(
  pg_temp.err(null, date '2026-03-15', time '14:30'),
  '42501',
  'F5. and a null shop id is refused the same way'
);

select is(
  pg_temp.err(pg_temp.id('kuwait'), null, time '14:30'),
  '23514',
  'F6. a missing transaction date is refused — there is nothing to place'
);

select is(
  pg_temp.err(pg_temp.id('kuwait'), date '1999-12-31', time '14:30'),
  '23514',
  'F7. and a date below the floor receipt_confirmations already enforces'
);

select * from finish();
rollback;
