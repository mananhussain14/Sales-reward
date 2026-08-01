-- Migration: retailer_shop_timezone_and_sale_instant
-- Purpose: Makes "what exact UTC instant does this printed shop-local sale date and time
--          correspond to?" answerable. It adds, and only adds:
--            1. public.retailer_shops.timezone_name -- a nullable IANA zone.
--            2. Its shape CHECK and its catalogue-validation trigger.
--            3. public.resolve_sale_instant(...) -- the INTERNAL authoritative resolver.
--          Plus default-deny privilege posture on the new function.
--
-- WHY THE RESOLVER LIVES HERE RATHER THAN IN ITS OWN MIGRATION. It reads
-- retailer_shops.timezone_name and cannot exist without it; splitting them would create a
-- migration that is broken until the next one runs. This is the same pairing
-- 20260814210000 used when it shipped the assignment timeline and its three resolvers
-- together.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
-- public.receipt_confirmations records transaction_date as a CIVIL `date` and
-- transaction_time as an OPTIONAL `time without time zone`. Migration 20260812210000 explains
-- why -- "a printed receipt date is a CIVIL DATE with no zone; storing it with a zone would
-- silently shift it by a day for half the world" -- and that reasoning is right.
--
-- But public.campaign_versions.starts_at and ends_at are timestamptz, and every temporal
-- resolver in this schema takes a timestamptz. A civil date cannot be compared with an
-- instant without a zone, and public.retailer_shops has never had one: its columns are name,
-- code, four address lines, city, region, postal_code, country_code and status.
--
-- So today there is NO defensible way to decide whether a sale printed "15 March" fell inside
-- a campaign that started at a particular instant. This migration supplies the missing fact
-- and the one function that applies it, so that every later caller gets the same answer.
--
-- ============================================================================
-- WHY country_code CANNOT BACKFILL THIS, AND WHY NO ROW IS GUESSED
-- ============================================================================
-- public.iso_country_codes has exactly ONE column -- `code` -- so the schema carries no
-- country-to-timezone data at all. Deriving one would mean hard-coding a mapping into a
-- migration, and a country is not a timezone: the United States, Australia, Brazil, Mexico,
-- Indonesia, Canada, Russia and Kazakhstan each span several, and a shop's correct zone is a
-- fact about the SHOP, not about its country.
--
-- A wrong zone is not a cosmetic defect here. It moves the sale instant by hours, which
-- changes whether a sale fell inside a campaign window, which changes what somebody is paid.
-- So NOTHING is backfilled: every existing shop keeps timezone_name NULL, and the resolver
-- REFUSES rather than assuming. An operator sets the zone deliberately, per shop, and the
-- refusal is what makes that a visible requirement instead of a silent default.
--
-- THE COLUMN IS THEREFORE NULLABLE AND STAYS NULLABLE. Making it NOT NULL would require
-- inventing a value for every existing row, which is precisely what must not happen. A later
-- milestone may tighten it once every shop has been set deliberately.
--
-- NOTHING WRITES THE COLUMN YET, and that is deliberate. This milestone adds no RPC, no
-- server action and no UI for setting a shop's timezone; add_vendor_retailer_shop and every
-- other shop writer are byte-untouched. Phase 1 must add a Vendor-side setter alongside the
-- reviewer workflow, and until it does the column can only be populated by the table owner.
--
-- ============================================================================
-- WHY A FIXED OFFSET IS REFUSED
-- ============================================================================
-- 'UTC+3' and 'GMT+3' are not IANA zone names and pg_timezone_names does not contain them, so
-- the trigger below rejects them already. But pg_timezone_names DOES contain 'UTC', 'EST',
-- 'Etc/GMT+3' and similar fixed-offset entries, and any of those would be accepted by a bare
-- catalogue lookup while being wrong for a physical shop: a fixed offset cannot follow the
-- daylight-saving rules of the place the shop actually stands, so a sale printed in summer
-- would resolve to the wrong instant.
--
-- The shape CHECK therefore additionally requires the REGION/CITY form -- at least one '/' --
-- and forbids the 'Etc/' prefix. 'Asia/Kuwait', 'Europe/London', 'Europe/Paris',
-- 'America/New_York' and 'America/Argentina/Buenos_Aires' all pass; 'UTC', 'EST',
-- 'Etc/GMT+3' and 'UTC+3' are all refused. A shop is somewhere, and its zone must say where.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--   No receipt_verifications table and no verified sale item -- the resolver RETURNS the three
--   values Phase 1 will persist, and persists nothing itself.
--   No reward, coin, ledger, balance, claim or payout object.
--   No timezone-management RPC, server action or UI.
--   No change to any existing shop RPC, policy, grant or trigger. retailer_shops keeps its
--   existing authenticated SELECT grant and retailer_shops_select_vendor_authorized exactly as
--   they are; adding a nullable column changes neither.
--   No change to receipt_confirmations, whose civil-date storage is correct and stays.
--
-- Idempotency posture: plain ALTER / CREATE (no IF NOT EXISTS, no CREATE OR REPLACE). A
--   conflicting existing object FAILS the migration. No fixed UUIDs. No dynamic SQL. All
--   identifiers are <= 63 bytes. Every reference is schema-qualified because every function
--   runs with an EMPTY search_path.
--
-- SQLSTATE taxonomy, matching the project's existing vocabulary:
--   42501  unauthenticated / unauthorized / foreign or unknown id. Deliberately generic.
--   23514  a supplied value is invalid.
--   55000  the target is not in a state this operation can act on.
--   22007  the supplied local date/time does not exist in the shop's zone.
--   22023  the supplied local date/time is ambiguous in the shop's zone.
--
-- Dependencies: 20260717094520 (retailer_shops), 20260812210000 (receipt_confirmations, whose
--   transaction_date / transaction_time shape this resolver is built to consume).

-- ============================================================================
-- PART 1 -- the column
-- ============================================================================
alter table public.retailer_shops
  add column timezone_name text;

comment on column public.retailer_shops.timezone_name is
  'The shop''s IANA time zone, in Region/City form. NULL until an operator sets it deliberately; resolve_sale_instant refuses rather than assuming a zone.';

-- Shape only. A CHECK cannot query pg_timezone_names -- the catalogue lookup is the trigger
-- in PART 2 -- but it can insist on the FORM, which is what excludes fixed offsets.
--
-- COLLATE "C" so the bracket ranges mean exactly ASCII on every host, matching
-- retailer_shops_country_code_format and vendor_products_code_shape.
alter table public.retailer_shops
  add constraint retailer_shops_timezone_name_shape
  check (
    timezone_name is null
    or (
      timezone_name = btrim(timezone_name)
      and length(timezone_name) between 3 and 64
      -- Region/City, with at least one '/' and no empty segment. The second and later
      -- segments admit '.' so names like 'America/Port-au-Prince' and
      -- 'America/Argentina/Buenos_Aires' pass.
      and (timezone_name collate "C") ~ '^[A-Za-z][A-Za-z0-9+_-]*(/[A-Za-z0-9+._-]+)+$'
      -- Etc/* are fixed offsets wearing a region-shaped name. A shop never has one.
      and timezone_name not like 'Etc/%'
    )
  );

-- ============================================================================
-- PART 2 -- catalogue validation
-- ============================================================================
-- The shape CHECK proves the name LOOKS like a zone; only pg_timezone_names proves it IS one.
-- Both are needed: the CHECK rejects 'UTC+3' without a catalogue lookup, and this rejects
-- 'Europe/Atlantis', which is shaped perfectly and does not exist.
--
-- Mirrors campaign_version_assert_timezone() (migration 20260815090000) exactly, including
-- its message style: the error names the RULE and never a row.
create function public.retailer_shops_assert_timezone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- NULL is the legitimate "not set yet" state for every shop that predates this migration.
  -- It is refused at USE time by resolve_sale_instant, not at write time here.
  if new.timezone_name is null then
    return new;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone_name
  ) then
    raise exception 'Choose a valid shop time zone'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Split into INSERT and UPDATE, and the UPDATE narrowed twice over -- by UPDATE OF and by a
-- WHEN clause -- so an ordinary status or address change performs no catalogue lookup. This
-- is the idiom retailer_shops already uses for its organization-type validators.
create trigger retailer_shops_assert_timezone_on_insert
  before insert on public.retailer_shops
  for each row execute function public.retailer_shops_assert_timezone();

create trigger retailer_shops_assert_timezone_on_update
  before update of timezone_name on public.retailer_shops
  for each row
  when (new.timezone_name is distinct from old.timezone_name)
  execute function public.retailer_shops_assert_timezone();

revoke all on function public.retailer_shops_assert_timezone() from public;

-- ============================================================================
-- PART 3 -- the authoritative sale-instant resolver (INTERNAL)
-- ============================================================================
-- ONE function, so every caller that ever needs "when did this sale happen?" gets the same
-- answer. The instant is DERIVED from the shop; there is no timezone parameter anywhere, so
-- no caller -- browser, mobile or server -- can nominate the zone a sale is read in.
--
-- INTERNAL: granted to no browser role. It accepts a shop id and resolves no tenant of its
-- own, so exposing it directly would let a caller probe another Retailer's estate one id at a
-- time. It is reachable only from SECURITY DEFINER contracts that have already resolved the
-- caller from auth.uid() -- the posture resolve_retailer_member_organization uses.
--
-- ---- THE DATE-ONLY RULE -----------------------------------------------------
-- receipt_confirmations.transaction_time is nullable, so a confirmed receipt may carry only a
-- date. Such a sale resolves to 12:00 NOON in the shop's zone, and the returned precision is
-- 'DATE_ONLY' so a caller can never mistake the noon for something that was printed.
--
-- WHY NOON RATHER THAN MIDNIGHT. Midnight sits on the day boundary, so any zone offset at all
-- pushes it into the adjacent day -- exactly the error the civil-date storage was chosen to
-- avoid. Noon is the furthest point from both boundaries, so a date-only sale stays on its
-- printed day in every zone on earth. It is also, as a second benefit, the safest point with
-- respect to daylight saving: real transitions occur in the small hours, so the DATE_ONLY path
-- is in practice never ambiguous and never nonexistent.
--
-- NOON IS NOT A CLAIM ABOUT WHEN THE SALE HAPPENED. It is a documented convention for placing
-- an otherwise-unplaceable sale on its own day, and 'DATE_ONLY' is what keeps that visible.
--
-- ---- DAYLIGHT SAVING: BOTH BAD CASES ARE REFUSED, NOT GUESSED ---------------
-- Two local wall-clock times cannot be resolved to one instant:
--
--   NONEXISTENT (spring forward). The clock jumps 01:00 -> 02:00, so 01:30 never occurs.
--     PostgreSQL does NOT raise for this; `AT TIME ZONE` silently returns the instant the
--     pre-transition offset would have produced, which reads back as a DIFFERENT local time.
--     Detected here by round-tripping local -> instant -> local and comparing. The check is
--     exact and independent of how large the shift is.
--
--   AMBIGUOUS (autumn back). The clock repeats 02:00 -> 01:00, so 01:30 occurs twice.
--     PostgreSQL picks one without saying which. Detected here by probing whether a
--     neighbouring instant maps to the SAME local time; if it does, two instants share it.
--
-- Both RAISE. Choosing one silently would embed an undocumented financial policy -- an hour
-- either way can move a sale across a campaign boundary -- and the project's rule is to fail
-- closed rather than invent one.
--
-- THE PROBE'S BOUND, STATED RATHER THAN HIDDEN: it tests 30 minutes, 1 hour and 2 hours,
-- which covers every daylight-saving shift in current and historical IANA data (Lord Howe
-- uses 30 minutes; almost everywhere else uses 1 hour; 2 hours occurs historically). A zone
-- adopting some other shift would go undetected and would resolve to PostgreSQL's unstated
-- choice. THE FOLLOW-UP DECISION THIS REQUIRES is named in the Phase 0 design note: whether
-- an ambiguous or nonexistent sale time should be (a) refused and sent back to a reviewer to
-- retype, (b) resolved to the earlier instant by published policy, or (c) resolved to the
-- later one. Phase 1 must answer it before a reviewer can encounter one.
create function public.resolve_sale_instant(
  p_retailer_shop_id  uuid,
  p_transaction_date  date,
  p_transaction_time  time without time zone default null
)
returns table (
  sale_at             timestamptz,
  timezone_name       text,
  sale_time_precision text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop_id   uuid;
  v_tz        text;
  v_time      time without time zone;
  v_precision text;
  v_local     timestamp without time zone;
  v_instant   timestamptz;
  v_back      timestamp without time zone;
  v_delta     interval;
begin
  -- ---- 1. The supplied civil date ------------------------------------------
  if p_transaction_date is null then
    raise exception 'A sale instant requires a transaction date'
      using errcode = 'check_violation';
  end if;

  -- The same floor receipt_confirmations_transaction_date_floor enforces, so a date this
  -- resolver would accept is always a date that table would have stored.
  if p_transaction_date < date '2000-01-01' then
    raise exception 'That transaction date could not be accepted'
      using errcode = 'check_violation';
  end if;

  -- ---- 2. The shop, and its zone -------------------------------------------
  select s.id, s.timezone_name
    into v_shop_id, v_tz
  from public.retailer_shops s
  where s.id = p_retailer_shop_id;

  -- DELIBERATELY 42501, and deliberately the same refusal a caller would get for a shop
  -- belonging to another Retailer. A Phase 1 contract that lets this bubble therefore says
  -- "not authorized" for an unknown id and for a foreign id alike, and cannot be used to
  -- discover which shop ids exist.
  if v_shop_id is null then
    raise exception 'Not authorized to resolve a sale instant for that shop'
      using errcode = 'insufficient_privilege';
  end if;

  -- 55000 -- "the target is not in a state this operation can act on". Distinct from the
  -- refusal above ON PURPOSE: this one is actionable (an operator sets the zone), and a
  -- reviewer queue must be able to tell the two apart to say so.
  --
  -- NO FALLBACK. Not UTC, not the database server's timezone, not the caller's session
  -- timezone. Every one of those would produce an instant that looks authoritative and is
  -- silently wrong for the place the sale happened.
  if v_tz is null then
    raise exception 'That shop has no time zone recorded, so a sale instant cannot be resolved'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- ---- 3. The local wall-clock time ----------------------------------------
  if p_transaction_time is null then
    v_time      := time '12:00';
    v_precision := 'DATE_ONLY';
  else
    -- Truncated to the minute, matching both receipt_extractions_transaction_time_minute and
    -- the identical date_trunc in confirm_receipt_extraction, so a stray second cannot make
    -- two equal times compare unequal.
    v_time      := date_trunc('minute', p_transaction_time::interval)::time without time zone;
    v_precision := 'MINUTE';
  end if;

  v_local := p_transaction_date + v_time;

  -- ---- 4. Local -> instant, with both daylight-saving failures refused ------
  v_instant := v_local at time zone v_tz;
  v_back    := v_instant at time zone v_tz;

  -- NONEXISTENT: the instant does not read back as the local time we asked for.
  if v_back is distinct from v_local then
    raise exception 'That local sale time does not exist in the shop time zone'
      using errcode = 'invalid_datetime_format';
  end if;

  -- AMBIGUOUS: some neighbouring instant maps to the SAME local time, so two instants share
  -- it. A normal local time cannot match here -- the offset is locally constant, so a
  -- neighbouring instant always reads back as a different local time.
  foreach v_delta in array array[
    interval '30 minutes',
    interval '1 hour',
    interval '2 hours'
  ] loop
    if ((v_instant + v_delta) at time zone v_tz) = v_local
       or ((v_instant - v_delta) at time zone v_tz) = v_local then
      raise exception 'That local sale time is ambiguous in the shop time zone'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  -- ---- 5. The three values Phase 1 will persist ----------------------------
  -- The zone is returned alongside the instant so a verification row can record WHICH zone
  -- produced it. A shop that is later corrected must not silently re-interpret sales that
  -- were already resolved under the old one.
  return query select v_instant, v_tz, v_precision;
end;
$$;

revoke all     on function public.resolve_sale_instant(uuid, date, time without time zone) from public;
revoke execute on function public.resolve_sale_instant(uuid, date, time without time zone) from anon;
revoke execute on function public.resolve_sale_instant(uuid, date, time without time zone) from authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One nullable column, one CHECK, two functions, two triggers. No backfill, by design.
--
-- No existing table, constraint, index, policy, grant, role, permission or mapping is
-- altered, and no shop RPC is touched. retailer_shops keeps its existing authenticated SELECT
-- and its existing read policy, both unchanged.
--
-- Nothing here verifies a receipt, matches a product, evaluates a campaign or credits a coin.
-- It records WHERE a shop is in time, and computes WHEN a printed sale happened.
