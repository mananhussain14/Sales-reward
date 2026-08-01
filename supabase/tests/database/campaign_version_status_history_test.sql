-- pgTAP behavioural tests for the TEMPORAL CAMPAIGN STATUS TIMELINE:
--
--   public.campaign_version_status_history                       [20260816210000]
--   public.campaign_status_record_history()               (trigger)
--   public.campaign_status_history_assert_no_overlap()    (trigger)
--   public.campaign_status_history_assert_append_only()   (trigger)
--   public.campaign_version_status_at(uuid, timestamptz)
--   public.campaign_versions_in_force_for_retailer_at(uuid, timestamptz)
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- public.campaigns overwrites `status` and `published_version_id` IN PLACE, so before
-- migration 20260816210000 "was this campaign paused when the sale happened?" was
-- unanswerable and a reward would have depended on when the calculation happened to run.
--
-- The claims proved here:
--   * every lifecycle act -- publish, pause, resume, republish, cancel -- lands on the
--     timeline, and lands there through the SHIPPED RPCs rather than through a second
--     implementation this suite invented (Section B);
--   * the intervals partition time exactly: contiguous, non-overlapping, one open (Section C);
--   * the boundary is half-open, so an instant belongs to exactly one interval (Section D);
--   * the timeline cannot be rewritten (Section E);
--   * the resolvers answer for a PAST instant and never consult now() (Section F);
--   * nothing is reachable by a browser role (Section A).
--
-- ============================================================================
-- HOW TIME IS CONTROLLED
-- ============================================================================
-- The trigger stamps boundaries with clock_timestamp(), which ADVANCES inside a transaction,
-- so a sequence of lifecycle calls produces a sequence of distinct, correctly-ordered
-- intervals in one rolled-back transaction. Sections D and F therefore read the boundaries
-- the trigger actually produced rather than asserting hand-picked calendar dates -- which is
-- the only way to test a timeline whose instants are generated rather than supplied.
--
-- Everything runs inside one transaction and is rolled back. no_plan(), per the convention
-- every suite in this directory follows.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers and fixture
-- ============================================================================
create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text)::text, true);
end;
$$;

create function pg_temp.new_person(p_first text, p_last text) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || lower(p_last) || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, 'ACTIVE');
  return v_id;
end;
$$;

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

create function pg_temp.add_member(p_user uuid, p_org uuid) returns uuid
language plpgsql as $$
declare v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, 'ACTIVE', now() - interval '30 days')
  returning id into v_member;
  return v_member;
end;
$$;

create function pg_temp.add_role(p_member uuid, p_role_code text) returns void
language plpgsql as $$
begin
  insert into public.member_roles (organization_member_id, role_id)
  select p_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;
end;
$$;

create table pg_temp.f (k text primary key, v uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select v from pg_temp.f where k = p
$$;

-- The nth interval of the campaign, oldest first -- the access pattern almost every
-- assertion below needs.
create function pg_temp.ival(p_n integer)
returns public.campaign_version_status_history
language sql stable as $$
  select h.* from public.campaign_version_status_history h
  where h.campaign_id = pg_temp.id('campaign')
  order by h.valid_from
  offset (p_n - 1) limit 1
$$;

create function pg_temp.n_intervals() returns integer
language sql stable as $$
  select count(*)::integer from public.campaign_version_status_history
  where campaign_id = pg_temp.id('campaign')
$$;

do $$
declare
  v_vendor uuid; v_ada uuid; v_member uuid; v_ret uuid; v_rel uuid;
begin
  v_vendor := pg_temp.new_org('Vendor A', 'VENDOR');
  v_ret    := pg_temp.new_org('Retailer Alpha', 'RETAILER');
  v_ada    := pg_temp.new_person('Ada', 'Admin');
  v_member := pg_temp.add_member(v_ada, v_vendor);
  perform pg_temp.add_role(v_member, 'VENDOR_SUPER_ADMIN');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (v_vendor, v_ret, 'ACTIVE')
  returning id into v_rel;

  insert into pg_temp.f values
    ('vendor', v_vendor), ('ret', v_ret), ('ada', v_ada), ('rel', v_rel);
end;
$$;

-- ============================================================================
-- SECTION A — the privilege surface
-- ============================================================================
select ok(
  (select relrowsecurity from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'campaign_version_status_history'),
  'A1. the timeline has row level security enabled'
);

select is(
  (select count(*)::integer from pg_catalog.pg_policy p
   join pg_catalog.pg_class c on c.oid = p.polrelid
   where c.relname = 'campaign_version_status_history'),
  0,
  'A2. and carries no policy — default deny is the whole design'
);

select ok(
  not has_table_privilege('authenticated', 'public.campaign_version_status_history', 'SELECT')
  and not has_table_privilege('authenticated', 'public.campaign_version_status_history', 'INSERT')
  and not has_table_privilege('authenticated', 'public.campaign_version_status_history', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.campaign_version_status_history', 'DELETE')
  and not has_table_privilege('anon', 'public.campaign_version_status_history', 'SELECT'),
  'A3. no browser role can read or write the timeline directly'
);

select ok(
  not has_table_privilege('service_role', 'public.campaign_version_status_history', 'TRUNCATE'),
  'A4. service_role cannot TRUNCATE it either — TRUNCATE bypasses the append-only triggers'
);

select ok(
  not has_function_privilege('authenticated',
    'public.campaign_version_status_at(uuid, timestamptz)', 'EXECUTE'),
  'A5. the status resolver is not reachable by a browser'
);

select ok(
  not has_function_privilege('authenticated',
    'public.campaign_versions_in_force_for_retailer_at(uuid, timestamptz)', 'EXECUTE'),
  'A6. nor the in-force resolver — it takes a Retailer id and resolves no tenant of its own'
);

-- ============================================================================
-- SECTION B — every lifecycle act lands, through the SHIPPED RPCs
-- ============================================================================
-- Driven entirely through the real contracts. A trigger that only works when this suite
-- writes the campaigns table by hand would prove nothing about production.
select pg_temp.act_as(pg_temp.id('ada'));

do $$
declare v_campaign uuid;
begin
  v_campaign := public.create_vendor_campaign_draft(
    'Timeline Campaign', null,
    now() - interval '1 hour', now() + interval '365 days', 'Asia/Dubai',
    'SELECTED_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
    'STACKABLE', null, 0,
    'PER_UNIT_COINS', 10, null, null, null,
    array[pg_temp.id('rel')], null, null);
  insert into pg_temp.f values ('campaign', v_campaign);
end;
$$;

select is(pg_temp.n_intervals(), 0,
  'B1. a DRAFT campaign records nothing — there is no version in force to record');

select is((select public.campaign_version_status_at(
             (select draft_version_id from public.campaigns where id = pg_temp.id('campaign')),
             now())),
  null,
  'B2. and its draft version resolves to no status at all');

-- --- publish ----------------------------------------------------------------
do $$ begin perform public.publish_vendor_campaign(pg_temp.id('campaign')); end; $$;

select is(pg_temp.n_intervals(), 1, 'B3. publishing opens the first interval');
select is((pg_temp.ival(1)).lifecycle_status, 'PUBLISHED', 'B4. and it records PUBLISHED');
select ok((pg_temp.ival(1)).is_version_in_force,
  'B5. and is_version_in_force is true');
select is((pg_temp.ival(1)).history_source, 'OBSERVED',
  'B6. and it is marked OBSERVED, not backfilled');
select ok((pg_temp.ival(1)).valid_to is null, 'B7. and it is open');

do $$
begin
  insert into pg_temp.f values
    ('v1', (select published_version_id from public.campaigns where id = pg_temp.id('campaign')));
end;
$$;

-- --- pause ------------------------------------------------------------------
do $$ begin perform public.set_vendor_campaign_lifecycle(pg_temp.id('campaign'), 'PAUSE'); end; $$;

select is(pg_temp.n_intervals(), 2, 'B8. pausing closes one interval and opens another');
select is((pg_temp.ival(2)).lifecycle_status, 'PAUSED', 'B9. the new one records PAUSED');
select ok(not (pg_temp.ival(2)).is_version_in_force,
  'B10. and is_version_in_force is FALSE — a paused campaign rewards nothing');
select is((pg_temp.ival(2)).campaign_version_id, pg_temp.id('v1'),
  'B11. while still naming the same version — pausing changes status, not configuration');

-- --- resume -----------------------------------------------------------------
do $$ begin perform public.set_vendor_campaign_lifecycle(pg_temp.id('campaign'), 'RESUME'); end; $$;

select is(pg_temp.n_intervals(), 3, 'B12. resuming opens a third interval');
select is((pg_temp.ival(3)).lifecycle_status, 'PUBLISHED', 'B13. back to PUBLISHED');

-- A no-op lifecycle call reports status_changed = false and must not split the interval.
do $$ begin perform public.set_vendor_campaign_lifecycle(pg_temp.id('campaign'), 'RESUME'); end; $$;

select is(pg_temp.n_intervals(), 3,
  'B14. a NO-OP resume records nothing — the timeline only moves when the state does');

-- --- publish a new version --------------------------------------------------
do $$
declare v_draft uuid;
begin
  v_draft := public.create_vendor_campaign_version(pg_temp.id('campaign'));
  insert into pg_temp.f values ('v2_draft', v_draft);
  perform public.publish_vendor_campaign(pg_temp.id('campaign'));
end;
$$;

select is(pg_temp.n_intervals(), 4, 'B15. publishing a NEW version opens a fourth interval');
select is((pg_temp.ival(4)).campaign_version_id, pg_temp.id('v2_draft'),
  'B16. which names the new version');
select ok((pg_temp.ival(3)).valid_to is not null,
  'B17. and the previous version''s interval is now CLOSED — that is when it stopped being current');

-- --- cancel -----------------------------------------------------------------
do $$ begin perform public.set_vendor_campaign_lifecycle(pg_temp.id('campaign'), 'CANCEL'); end; $$;

select is(pg_temp.n_intervals(), 5, 'B18. cancelling opens a fifth interval');
select is((pg_temp.ival(5)).lifecycle_status, 'CANCELLED', 'B19. recording CANCELLED');
select ok(not (pg_temp.ival(5)).is_version_in_force,
  'B20. with is_version_in_force false — a cancelled campaign rewards nothing');

-- ============================================================================
-- SECTION C — the intervals partition time
-- ============================================================================
select is(
  (select count(*)::integer from public.campaign_version_status_history
   where campaign_id = pg_temp.id('campaign') and valid_to is null),
  1,
  'C1. exactly ONE interval is open'
);

select is(
  (select count(*)::integer from (
     select h.valid_to, lead(h.valid_from) over (order by h.valid_from) as next_from
     from public.campaign_version_status_history h
     where h.campaign_id = pg_temp.id('campaign')) t
   where t.next_from is not null and t.valid_to is distinct from t.next_from),
  0,
  'C2. every interval ends exactly where the next begins — no gap, no leap'
);

select is(
  (select count(*)::integer
   from public.campaign_version_status_history a
   join public.campaign_version_status_history b
     on b.campaign_id = a.campaign_id and b.id <> a.id
    and tstzrange(a.valid_from, a.valid_to, '[)') && tstzrange(b.valid_from, b.valid_to, '[)')
   where a.campaign_id = pg_temp.id('campaign')),
  0,
  'C3. and no two intervals overlap'
);

select is(
  (select count(*)::integer from public.campaign_version_status_history
   where campaign_id = pg_temp.id('campaign') and valid_to is not null and valid_to <= valid_from),
  0,
  'C4. no interval is zero-length or inverted'
);

-- is_version_in_force is GENERATED, so it can never disagree with the status it derives from.
select is(
  (select count(*)::integer from public.campaign_version_status_history
   where campaign_id = pg_temp.id('campaign')
     and is_version_in_force <> (lifecycle_status = 'PUBLISHED')),
  0,
  'C5. is_version_in_force agrees with lifecycle_status on every row, by construction'
);

-- ============================================================================
-- SECTION D — half-open boundary semantics
-- ============================================================================
-- [valid_from, valid_to): the instant an interval BEGINS is inside it; the instant it ENDS
-- is not. This is what makes an instant belong to exactly one interval.
select is(
  public.campaign_version_status_at(pg_temp.id('v1'), (pg_temp.ival(1)).valid_from),
  'PUBLISHED',
  'D1. the instant an interval begins is INSIDE it'
);

select is(
  public.campaign_version_status_at(pg_temp.id('v1'), (pg_temp.ival(1)).valid_to),
  'PAUSED',
  'D2. the instant it ends is NOT — that instant belongs to the next interval'
);

select is(
  public.campaign_version_status_at(pg_temp.id('v1'),
    (pg_temp.ival(1)).valid_to - interval '1 microsecond'),
  'PUBLISHED',
  'D3. and the last instant before the boundary is still inside the first'
);

select is(
  (select count(*)::integer from public.campaign_version_status_history h
   where h.campaign_id = pg_temp.id('campaign')
     and h.valid_from <= (pg_temp.ival(2)).valid_from
     and (h.valid_to is null or (pg_temp.ival(2)).valid_from < h.valid_to)),
  1,
  'D4. every instant is covered by exactly one interval, never two'
);

-- ============================================================================
-- SECTION E — append-only
-- ============================================================================
select throws_ok(
  format($$ update public.campaign_version_status_history set lifecycle_status = 'PUBLISHED'
            where campaign_id = %L and valid_to is not null $$, pg_temp.id('campaign')),
  '23514', 'A closed campaign status history interval is immutable',
  'E1. a CLOSED interval cannot be changed'
);

select throws_ok(
  format($$ delete from public.campaign_version_status_history where campaign_id = %L $$,
         pg_temp.id('campaign')),
  '23514', 'Campaign status history is append-only and cannot be deleted',
  'E2. no interval can be deleted, ever'
);

select throws_ok(
  format($$ update public.campaign_version_status_history set valid_from = now()
            where campaign_id = %L and valid_to is null $$, pg_temp.id('campaign')),
  '23514', 'Campaign status history identity is immutable',
  'E3. even an OPEN interval cannot have its start re-dated'
);

select throws_ok(
  format($$ update public.campaign_version_status_history set lifecycle_status = 'PUBLISHED'
            where campaign_id = %L and valid_to is null $$, pg_temp.id('campaign')),
  '23514', 'Campaign status history identity is immutable',
  'E4. nor can an open interval have its recorded status rewritten'
);

-- A GENUINE change of the provenance marker. Relabelling an observation as a backfill (or
-- the reverse) would let a row lie about how much the engine may trust it.
select throws_ok(
  format($$ update public.campaign_version_status_history
            set history_source = 'BACKFILL_CURRENT_STATE'
            where campaign_id = %L and valid_to is null $$, pg_temp.id('campaign')),
  '23514', 'Campaign status history identity is immutable',
  'E5. nor can the provenance marker be rewritten'
);

-- An UPDATE that changes nothing is refused by the OTHER arm of the guard: an open interval
-- may only be CLOSED, and a touch that leaves valid_to null is not a close. Both refusals are
-- correct, and asserting each against its own message keeps them from being confused later.
select throws_ok(
  format($$ update public.campaign_version_status_history set history_source = history_source
            where campaign_id = %L and valid_to is null $$, pg_temp.id('campaign')),
  '23514', 'An open campaign status history interval may only be closed',
  'E5b. and a NO-OP touch of an open interval is refused as "may only be closed"'
);

-- The ONE permitted mutation: closing the open interval.
select lives_ok(
  format($$ update public.campaign_version_status_history set valid_to = now() + interval '1 second'
            where campaign_id = %L and valid_to is null $$, pg_temp.id('campaign')),
  'E6. closing the OPEN interval is the one permitted update'
);

-- ...and once closed, it is frozen like every other closed interval.
select throws_ok(
  format($$ update public.campaign_version_status_history set valid_to = now() + interval '2 seconds'
            where campaign_id = %L
              and valid_from = (select max(valid_from) from public.campaign_version_status_history
                                where campaign_id = %L) $$,
         pg_temp.id('campaign'), pg_temp.id('campaign')),
  '23514', 'A closed campaign status history interval is immutable',
  'E7. and closing it again is refused — the exemption is one direction wide'
);

-- Overlap is refused even for a hand-written row, built from a real interval's own bounds.
select throws_ok(
  format($$ insert into public.campaign_version_status_history
            (campaign_id, campaign_version_id, lifecycle_status, valid_from, valid_to)
            values (%L, %L, 'PUBLISHED', %L::timestamptz, %L::timestamptz) $$,
         pg_temp.id('campaign'), pg_temp.id('v1'),
         (pg_temp.ival(1)).valid_from, (pg_temp.ival(1)).valid_to),
  '23514', 'Campaign status history intervals cannot overlap',
  'E8. an interval overlapping an existing one is refused'
);

select throws_ok(
  format($$ insert into public.campaign_version_status_history
            (campaign_id, campaign_version_id, lifecycle_status, valid_from, valid_to)
            values (%L, %L, 'PUBLISHED', now(), now() - interval '1 day') $$,
         pg_temp.id('campaign'), pg_temp.id('v1')),
  '23514', null,
  'E9. an inverted interval is refused BY THE CONSTRAINT, not by a range-construction error'
);

select throws_ok(
  format($$ insert into public.campaign_version_status_history
            (campaign_id, campaign_version_id, lifecycle_status, valid_from)
            values (%L, %L, 'DRAFT', now() + interval '900 days') $$,
         pg_temp.id('campaign'), pg_temp.id('v1')),
  '23514', null,
  'E10. DRAFT is not a value this timeline admits — it has no version in force to record'
);

-- ============================================================================
-- SECTION F — the resolvers answer for a PAST instant
-- ============================================================================
-- This section is the whole reason the migration exists. Every assertion asks about an
-- instant that is NOT now, and the answers must reflect what was true THEN.
select is(
  public.campaign_version_status_at(pg_temp.id('v1'), (pg_temp.ival(2)).valid_from),
  'PAUSED',
  'F1. version 1 reads PAUSED at an instant inside the paused interval'
);

select is(
  public.campaign_version_status_at(pg_temp.id('v1'), (pg_temp.ival(3)).valid_from),
  'PUBLISHED',
  'F2. and PUBLISHED again after the resume'
);

select is(
  public.campaign_version_status_at(pg_temp.id('v2_draft'), (pg_temp.ival(1)).valid_from),
  null,
  'F3. version 2 resolves to NOTHING at an instant before it existed'
);

select is(
  public.campaign_version_status_at(pg_temp.id('v1'), (pg_temp.ival(4)).valid_from),
  null,
  'F4. and version 1 resolves to nothing once version 2 superseded it'
);

select is(
  public.campaign_version_status_at(pg_temp.id('v1'), timestamptz '2001-01-01'),
  null,
  'F5. an instant before any record resolves to NULL — "we have no record", not "not published"'
);

-- --- the in-force resolver ---------------------------------------------------
select is(
  (select count(*)::integer from public.campaign_versions_in_force_for_retailer_at(
     pg_temp.id('ret'), (pg_temp.ival(1)).valid_from)),
  1,
  'F6. the Retailer had one campaign in force during the first PUBLISHED interval'
);

select is(
  (select campaign_version_id from public.campaign_versions_in_force_for_retailer_at(
     pg_temp.id('ret'), (pg_temp.ival(1)).valid_from)),
  pg_temp.id('v1'),
  'F7. and it was version 1'
);

select is(
  (select count(*)::integer from public.campaign_versions_in_force_for_retailer_at(
     pg_temp.id('ret'), (pg_temp.ival(2)).valid_from)),
  0,
  'F8. NOTHING was in force while the campaign was PAUSED — the sale-time question, answered'
);

select is(
  (select count(*)::integer from public.campaign_versions_in_force_for_retailer_at(
     pg_temp.id('ret'), (pg_temp.ival(5)).valid_from)),
  0,
  'F9. and nothing is in force once it is CANCELLED'
);

select is(
  (select campaign_version_id from public.campaign_versions_in_force_for_retailer_at(
     pg_temp.id('ret'), (pg_temp.ival(4)).valid_from)),
  pg_temp.id('v2_draft'),
  'F10. version 2 is the one in force during the fourth interval'
);

-- A Retailer the campaign was never published to sees nothing at any instant, because the
-- resolver joins the FROZEN publication snapshot rather than today's group membership.
do $$
declare v_other uuid;
begin
  v_other := pg_temp.new_org('Retailer Bravo', 'RETAILER');
  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (pg_temp.id('vendor'), v_other, 'ACTIVE');
  insert into pg_temp.f values ('ret_other', v_other);
end;
$$;

select is(
  (select count(*)::integer from public.campaign_versions_in_force_for_retailer_at(
     pg_temp.id('ret_other'), (pg_temp.ival(1)).valid_from)),
  0,
  'F11. a Retailer outside the frozen publication snapshot has nothing in force, ever'
);

-- The period test is half-open and comes from the IMMUTABLE version row, not from the clock.
select is(
  (select count(*)::integer from public.campaign_versions_in_force_for_retailer_at(
     pg_temp.id('ret'), timestamptz '2001-01-01')),
  0,
  'F12. an instant before the campaign period returns nothing'
);

select * from finish();
rollback;
