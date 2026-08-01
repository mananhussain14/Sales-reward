-- pgTAP behavioural tests for the TEMPORAL PRODUCT-ASSIGNMENT TIMELINE:
--
--   public.vendor_product_retailer_assignment_history           [20260814210000]
--   public.vendor_product_assignment_record_history()            (trigger)
--   public.vendor_product_assign_history_assert_no_overlap()     (trigger)
--   public.vendor_product_assign_history_assert_append_only()    (trigger)
--   public.vendor_product_assignment_state_at(uuid, uuid, timestamptz)
--   public.vendor_product_eligible_for_retailer_at(uuid, uuid, timestamptz)
--   public.vendor_retailer_eligible_products_at(uuid, uuid, timestamptz)
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- The campaign milestone's ALL_ELIGIBLE_PRODUCTS scope means "every product eligible for
-- that Retailer AT THE RELEVANT MOMENT". Before migration 20260814210000 that question was
-- unanswerable: public.vendor_product_retailer_assignments holds one row per pair for all
-- time and overwrites `status` in place, so yesterday's answer was destroyed the moment it
-- changed.
--
-- Everything below exists to prove one claim: the timeline records what was true when, it
-- cannot be rewritten, and it cannot disagree with itself.
--
-- THE ACCEPTANCE SCENARIO in Section E is the one from the requirement, verbatim:
--
--     A eligible 1 Aug, B eligible 10 Aug, A withdrawn 20 Aug
--       5 Aug -> A yes, B no      15 Aug -> A and B      25 Aug -> A no, B yes
--
-- ============================================================================
-- HOW TIME IS CONTROLLED IN THESE TESTS
-- ============================================================================
-- The trigger stamps boundaries with clock_timestamp(), which ADVANCES inside a
-- transaction, so a sequence of writes produces a sequence of distinct, correctly-ordered
-- intervals in a single rolled-back transaction. Where a test needs a specific calendar
-- date rather than "a moment ago", it writes the interval directly: INSERT into the
-- history table is permitted, and CLOSING an open interval by setting valid_to is
-- permitted. Neither is a back door — Section D proves a CLOSED interval is frozen and
-- Section D proves nothing can be deleted at all.
--
-- Everything runs inside one transaction and is rolled back. no_plan() rather than
-- plan(N): a hard-coded count that drifts turns an added test into a confusing failure
-- about arithmetic rather than about behaviour.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers and fixture
-- ============================================================================
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

create table pg_temp.f (k text primary key, v uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select v from pg_temp.f where k = p
$$;

do $$
declare
  v_vendor uuid; v_vendor_b uuid; v_ret uuid; v_ret_other uuid; v_actor uuid;
begin
  v_vendor    := pg_temp.new_org('Vendor A', 'VENDOR');
  v_vendor_b  := pg_temp.new_org('Vendor B', 'VENDOR');
  v_ret       := pg_temp.new_org('Retailer Alpha', 'RETAILER');
  v_ret_other := pg_temp.new_org('Retailer Bravo', 'RETAILER');
  v_actor     := pg_temp.new_person('Ada', 'Admin');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (v_vendor, v_ret, 'ACTIVE'), (v_vendor, v_ret_other, 'ACTIVE');

  insert into pg_temp.f values
    ('vendor', v_vendor), ('vendor_b', v_vendor_b),
    ('ret', v_ret), ('ret_other', v_ret_other), ('actor', v_actor);
end;
$$;

do $$
declare v_id uuid;
begin
  insert into public.vendor_products (vendor_organization_id, product_code, product_name, status, created_by_profile_id)
  values (pg_temp.id('vendor'), 'P-A', 'Product A', 'ACTIVE', pg_temp.id('actor')) returning id into v_id;
  insert into pg_temp.f values ('p_a', v_id);

  insert into public.vendor_products (vendor_organization_id, product_code, product_name, status, created_by_profile_id)
  values (pg_temp.id('vendor'), 'P-B', 'Product B', 'ACTIVE', pg_temp.id('actor')) returning id into v_id;
  insert into pg_temp.f values ('p_b', v_id);

  -- An INACTIVE product: assigned, but never eligible.
  insert into public.vendor_products (vendor_organization_id, product_code, product_name, status, created_by_profile_id)
  values (pg_temp.id('vendor'), 'P-C', 'Product C', 'INACTIVE', pg_temp.id('actor')) returning id into v_id;
  insert into pg_temp.f values ('p_c', v_id);
end;
$$;

-- ============================================================================
-- SECTION A — the privilege surface
-- ============================================================================
select ok(
  (select relrowsecurity from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'vendor_product_retailer_assignment_history'),
  'A1. the history table has row level security enabled'
);

select is(
  (select count(*)::integer from pg_catalog.pg_policy p
   join pg_catalog.pg_class c on c.oid = p.polrelid
   where c.relname = 'vendor_product_retailer_assignment_history'),
  0,
  'A2. and carries no policy — default deny is the whole design'
);

select is(
  (select count(*)::integer
   from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'vendor_product_retailer_assignment_history'
     and (has_table_privilege('authenticated', c.oid, 'SELECT')
       or has_table_privilege('authenticated', c.oid, 'INSERT')
       or has_table_privilege('authenticated', c.oid, 'UPDATE')
       or has_table_privilege('authenticated', c.oid, 'DELETE')
       or has_table_privilege('anon', c.oid, 'SELECT'))),
  0,
  'A3. no browser role can read or write history directly'
);

-- The resolvers are INTERNAL. They take a Retailer id and resolve no tenant of their own,
-- so exposing one would let a caller ask about a Retailer they have no relationship with.
select ok(
  not has_function_privilege('authenticated',
    'public.vendor_product_eligible_for_retailer_at(uuid, uuid, timestamptz)', 'EXECUTE'),
  'A4. the point-in-time resolver is not reachable by a browser'
);

select ok(
  not has_function_privilege('authenticated',
    'public.vendor_retailer_eligible_products_at(uuid, uuid, timestamptz)', 'EXECUTE'),
  'A5. neither is the set-returning resolver'
);

select ok(
  not has_function_privilege('authenticated',
    'public.vendor_product_assignment_state_at(uuid, uuid, timestamptz)', 'EXECUTE'),
  'A6. nor the raw state resolver'
);

select is(
  (select count(*)::integer
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('vendor_product_assignment_state_at',
                       'vendor_product_eligible_for_retailer_at',
                       'vendor_retailer_eligible_products_at',
                       'vendor_product_assignment_record_history',
                       'vendor_product_assign_history_assert_no_overlap',
                       'vendor_product_assign_history_assert_append_only')
     -- proconfig stores the setting verbatim, and an EMPTY search_path is recorded as
     -- `search_path=""` — the quotes are part of the stored value.
     and (not p.prosecdef or p.proconfig is null
          or not exists (select 1 from unnest(p.proconfig) cfg where cfg = 'search_path=""'))),
  0,
  'A7. every history function is SECURITY DEFINER with an empty search_path'
);

-- ============================================================================
-- SECTION B — the backfill
-- ============================================================================
-- The migration ran before this suite, so any assignment row that existed then already has
-- exactly one open interval. This asserts the INVARIANT the backfill establishes rather
-- than re-running it.
select is(
  (select count(*)::integer
   from public.vendor_product_retailer_assignments a
   where not exists (
     select 1 from public.vendor_product_retailer_assignment_history h
     where h.vendor_product_id = a.vendor_product_id
       and h.retailer_organization_id = a.retailer_organization_id
   )),
  0,
  'B1. every assignment row has at least one interval — nothing was left unrecorded'
);

select is(
  (select count(*)::integer from (
     select vendor_product_id, retailer_organization_id
     from public.vendor_product_retailer_assignment_history
     where valid_to is null
     group by 1, 2 having count(*) > 1) d),
  0,
  'B2. no pair has two open intervals'
);

-- ============================================================================
-- SECTION C — the maintenance trigger
-- ============================================================================
do $$
declare v_id uuid;
begin
  insert into public.vendor_product_retailer_assignments
    (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id)
  values (pg_temp.id('p_a'), pg_temp.id('ret'), 'ACTIVE', pg_temp.id('actor'))
  returning id into v_id;
  insert into pg_temp.f values ('assign_a', v_id);
end;
$$;

create function pg_temp.intervals(p_product uuid, p_retailer uuid) returns bigint
language sql stable as $$
  select count(*) from public.vendor_product_retailer_assignment_history
  where vendor_product_id = p_product and retailer_organization_id = p_retailer
$$;

select is(
  pg_temp.intervals(pg_temp.id('p_a'), pg_temp.id('ret')), 1::bigint,
  'C1. an INSERT opens exactly one interval'
);

select is(
  (select assignment_status from public.vendor_product_retailer_assignment_history
   where vendor_product_id = pg_temp.id('p_a') and retailer_organization_id = pg_temp.id('ret')),
  'ACTIVE',
  'C2. carrying the row''s own status'
);

select is(
  (select valid_from from public.vendor_product_retailer_assignment_history
   where vendor_product_id = pg_temp.id('p_a') and retailer_organization_id = pg_temp.id('ret')),
  (select assigned_at from public.vendor_product_retailer_assignments
   where id = pg_temp.id('assign_a')),
  'C3. and starting at the row''s own assigned_at, not at "now"'
);

-- A status change closes the interval in force and opens its successor.
do $$
begin
  update public.vendor_product_retailer_assignments
  set status = 'INACTIVE' where id = pg_temp.id('assign_a');
end;
$$;

select is(
  pg_temp.intervals(pg_temp.id('p_a'), pg_temp.id('ret')), 2::bigint,
  'C4. a status change closes the old interval and opens a new one'
);

select is(
  (select count(*)::integer from public.vendor_product_retailer_assignment_history
   where vendor_product_id = pg_temp.id('p_a') and retailer_organization_id = pg_temp.id('ret')
     and valid_to is null),
  1,
  'C5. leaving exactly one interval in force'
);

-- The boundary is SHARED, so the two intervals partition time with no gap and no overlap.
select is(
  (select count(*)::integer from (
     select valid_to, lead(valid_from) over (order by valid_from) as next_from
     from public.vendor_product_retailer_assignment_history
     where vendor_product_id = pg_temp.id('p_a') and retailer_organization_id = pg_temp.id('ret')) t
   where valid_to is not null and valid_to is distinct from next_from),
  0,
  'C6. adjacent intervals share a boundary exactly — no gap, no overlap'
);

-- A NO-OP writes nothing. A timeline whose entries do not correspond to changes in what it
-- describes is worse than a shorter one.
do $$
begin
  update public.vendor_product_retailer_assignments
  set status = 'INACTIVE' where id = pg_temp.id('assign_a');
end;
$$;

select is(
  pg_temp.intervals(pg_temp.id('p_a'), pg_temp.id('ret')), 2::bigint,
  'C7. re-writing the SAME status creates no interval'
);

-- An update that touches only administration metadata is also a no-op for the timeline.
do $$
begin
  update public.vendor_product_retailer_assignments
  set assigned_by_profile_id = pg_temp.id('actor') where id = pg_temp.id('assign_a');
end;
$$;

select is(
  pg_temp.intervals(pg_temp.id('p_a'), pg_temp.id('ret')), 2::bigint,
  'C8. changing non-eligibility metadata creates no interval either'
);

-- Reactivation is a third interval, not a revival of the first.
do $$
begin
  update public.vendor_product_retailer_assignments
  set status = 'ACTIVE' where id = pg_temp.id('assign_a');
end;
$$;

select is(
  pg_temp.intervals(pg_temp.id('p_a'), pg_temp.id('ret')), 3::bigint,
  'C9. reactivation opens a THIRD interval rather than reopening the first'
);

select is(
  (select array_agg(assignment_status order by valid_from)
   from public.vendor_product_retailer_assignment_history
   where vendor_product_id = pg_temp.id('p_a') and retailer_organization_id = pg_temp.id('ret')),
  array['ACTIVE', 'INACTIVE', 'ACTIVE'],
  'C10. and the sequence of states is recorded in order'
);

-- ============================================================================
-- SECTION D — append-only
-- ============================================================================
select throws_ok(
  $$ update public.vendor_product_retailer_assignment_history
     set assignment_status = 'ACTIVE' where valid_to is not null $$,
  '23514', 'A closed assignment history interval is immutable',
  'D1. a CLOSED interval cannot be changed'
);

select throws_ok(
  $$ delete from public.vendor_product_retailer_assignment_history $$,
  '23514', 'Assignment history is append-only and cannot be deleted',
  'D2. no history row can be deleted, ever'
);

select throws_ok(
  format($$ update public.vendor_product_retailer_assignment_history
            set valid_from = now() where vendor_product_id = %L and valid_to is null $$,
         pg_temp.id('p_a')),
  '23514', 'Assignment history identity is immutable',
  'D3. even an OPEN interval cannot have its start re-dated'
);

-- Built from the FIRST closed interval's own boundaries, so it genuinely overlaps.
-- A range that merely abuts an existing one does NOT overlap under half-open semantics —
-- that is the point of the '[)' bound — so a hand-picked "100 days ago until now" would
-- have proven nothing.
select throws_ok(
  format($$ insert into public.vendor_product_retailer_assignment_history
            (assignment_id, vendor_product_id, retailer_organization_id,
             assignment_status, valid_from, valid_to)
            values (%L, %L, %L, 'ACTIVE', %L::timestamptz, %L::timestamptz) $$,
         pg_temp.id('assign_a'), pg_temp.id('p_a'), pg_temp.id('ret'),
         (select valid_from from public.vendor_product_retailer_assignment_history
          where vendor_product_id = pg_temp.id('p_a')
            and retailer_organization_id = pg_temp.id('ret')
          order by valid_from limit 1),
         (select valid_to from public.vendor_product_retailer_assignment_history
          where vendor_product_id = pg_temp.id('p_a')
            and retailer_organization_id = pg_temp.id('ret')
            and valid_to is not null
          order by valid_from limit 1)),
  '23514', 'Assignment history intervals cannot overlap',
  'D4. an interval overlapping an existing one is refused'
);

select throws_ok(
  format($$ insert into public.vendor_product_retailer_assignment_history
            (assignment_id, vendor_product_id, retailer_organization_id,
             assignment_status, valid_from, valid_to)
            values (%L, %L, %L, 'ACTIVE', now(), now() - interval '1 day') $$,
         pg_temp.id('assign_a'), pg_temp.id('p_a'), pg_temp.id('ret')),
  '23514', null,
  'D5. an inverted interval is refused BY THE CONSTRAINT, not by a range-construction error'
);

select throws_ok(
  format($$ insert into public.vendor_product_retailer_assignment_history
            (assignment_id, vendor_product_id, retailer_organization_id,
             assignment_status, valid_from, valid_to)
            values (%L, %L, %L, 'WITHDRAWN', now() + interval '900 days', null) $$,
         pg_temp.id('assign_a'), pg_temp.id('p_a'), pg_temp.id('ret')),
  '23514', null,
  'D6. a status outside the source table''s own vocabulary is refused'
);

-- DELETING AN ASSIGNMENT IS NOW IMPOSSIBLE, which is the rule migration 20260727090000
-- stated in prose and never enforced. The history reference is what enforces it.
select throws_ok(
  format($$ delete from public.vendor_product_retailer_assignments where id = %L $$,
         pg_temp.id('assign_a')),
  '23503', null,
  'D7. an assignment row with history cannot be deleted — soft-status-only is now enforced'
);

select ok(
  pg_temp.intervals(pg_temp.id('p_a'), pg_temp.id('ret')) = 3::bigint,
  'D8. and the refused delete destroyed nothing'
);

-- ============================================================================
-- SECTION E — point-in-time resolution, and the requirement's own scenario
-- ============================================================================
-- Written directly so the dates are the requirement's dates rather than "a moment ago".
do $$
declare v_assign_b uuid;
begin
  insert into public.vendor_product_retailer_assignments
    (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id, assigned_at, updated_at)
  values (pg_temp.id('p_b'), pg_temp.id('ret_other'), 'ACTIVE', pg_temp.id('actor'),
          timestamptz '2026-08-10 00:00:00+00', timestamptz '2026-08-10 00:00:00+00')
  returning id into v_assign_b;
  insert into pg_temp.f values ('assign_b', v_assign_b);

  -- Product A at the OTHER Retailer: eligible 1 Aug, withdrawn 20 Aug.
  insert into public.vendor_product_retailer_assignments
    (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id, assigned_at, updated_at)
  values (pg_temp.id('p_a'), pg_temp.id('ret_other'), 'ACTIVE', pg_temp.id('actor'),
          timestamptz '2026-08-01 00:00:00+00', timestamptz '2026-08-01 00:00:00+00');

  update public.vendor_product_retailer_assignment_history
  set valid_to = timestamptz '2026-08-20 00:00:00+00'
  where vendor_product_id = pg_temp.id('p_a')
    and retailer_organization_id = pg_temp.id('ret_other')
    and valid_to is null;

  insert into public.vendor_product_retailer_assignment_history
    (assignment_id, vendor_product_id, retailer_organization_id, assignment_status, valid_from, valid_to)
  select a.id, pg_temp.id('p_a'), pg_temp.id('ret_other'), 'INACTIVE',
         timestamptz '2026-08-20 00:00:00+00', null
  from public.vendor_product_retailer_assignments a
  where a.vendor_product_id = pg_temp.id('p_a')
    and a.retailer_organization_id = pg_temp.id('ret_other');
end;
$$;

create function pg_temp.eligible(p_product uuid, p_at timestamptz) returns boolean
language sql stable as $$
  select public.vendor_product_eligible_for_retailer_at(
    p_product, pg_temp.id('ret_other'), p_at)
$$;

select ok(pg_temp.eligible(pg_temp.id('p_a'), timestamptz '2026-08-05'),
  'E1. 5 Aug — product A is eligible');
select ok(not pg_temp.eligible(pg_temp.id('p_b'), timestamptz '2026-08-05'),
  'E2. 5 Aug — product B is NOT yet eligible');
select ok(pg_temp.eligible(pg_temp.id('p_a'), timestamptz '2026-08-15'),
  'E3. 15 Aug — product A is still eligible');
select ok(pg_temp.eligible(pg_temp.id('p_b'), timestamptz '2026-08-15'),
  'E4. 15 Aug — product B is now eligible too');
select ok(not pg_temp.eligible(pg_temp.id('p_a'), timestamptz '2026-08-25'),
  'E5. 25 Aug — product A is no longer eligible');
select ok(pg_temp.eligible(pg_temp.id('p_b'), timestamptz '2026-08-25'),
  'E6. 25 Aug — product B remains eligible');

-- HALF-OPEN BOUNDARIES: [valid_from, valid_to).
select ok(
  not pg_temp.eligible(pg_temp.id('p_a'), timestamptz '2026-08-01 00:00:00+00' - interval '1 microsecond'),
  'E7. an instant BEFORE valid_from is outside the interval'
);
select ok(
  pg_temp.eligible(pg_temp.id('p_a'), timestamptz '2026-08-01 00:00:00+00'),
  'E8. the instant AT valid_from is INSIDE it'
);
select ok(
  pg_temp.eligible(pg_temp.id('p_a'), timestamptz '2026-08-20 00:00:00+00' - interval '1 microsecond'),
  'E9. the instant immediately before valid_to is still inside'
);
select ok(
  not pg_temp.eligible(pg_temp.id('p_a'), timestamptz '2026-08-20 00:00:00+00'),
  'E10. the instant AT valid_to is OUTSIDE it'
);

-- "No record" and "withdrawn" are different facts and must not be collapsed.
select is(
  public.vendor_product_assignment_state_at(
    pg_temp.id('p_a'), pg_temp.id('ret_other'), timestamptz '2020-01-01'),
  null,
  'E11. an instant before any interval returns NULL, not INACTIVE'
);

select is(
  public.vendor_product_assignment_state_at(
    pg_temp.id('p_a'), pg_temp.id('ret_other'), timestamptz '2026-08-25'),
  'INACTIVE',
  'E12. a withdrawn pair reports INACTIVE, which is a different answer'
);

-- The set-returning resolver agrees with the per-product one.
create function pg_temp.eligible_set(p_at timestamptz) returns text
language sql stable as $$
  select coalesce(string_agg(vp.product_code, ',' order by vp.product_code), '(none)')
  from public.vendor_retailer_eligible_products_at(
         pg_temp.id('ret_other'), pg_temp.id('vendor'), p_at) e
  join public.vendor_products vp on vp.id = e.vendor_product_id
$$;

select is(pg_temp.eligible_set(timestamptz '2026-08-05'), 'P-A',
  'E13. the set resolver returns only A on 5 Aug');
select is(pg_temp.eligible_set(timestamptz '2026-08-15'), 'P-A,P-B',
  'E14. both on 15 Aug');
select is(pg_temp.eligible_set(timestamptz '2026-08-25'), 'P-B',
  'E15. only B on 25 Aug');

-- ============================================================================
-- SECTION F — tenancy and product status
-- ============================================================================
select is(
  (select count(*)::integer from public.vendor_retailer_eligible_products_at(
     pg_temp.id('ret_other'), pg_temp.id('vendor_b'), timestamptz '2026-08-15')),
  0,
  'F1. narrowing to a DIFFERENT Vendor returns none of this Vendor''s products'
);

select is(
  (select count(*)::integer from public.vendor_retailer_eligible_products_at(
     pg_temp.id('ret'), pg_temp.id('vendor'), timestamptz '2026-08-15')
   e join public.vendor_products vp on vp.id = e.vendor_product_id
   where vp.product_code = 'P-B'),
  0,
  'F2. one Retailer''s timeline never leaks into another Retailer''s answer'
);

-- An INACTIVE product is not eligible even with a live assignment interval. This is the
-- second, NON-temporal eligibility axis the migration documents as a known limitation.
do $$
begin
  insert into public.vendor_product_retailer_assignments
    (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id, assigned_at, updated_at)
  values (pg_temp.id('p_c'), pg_temp.id('ret_other'), 'ACTIVE', pg_temp.id('actor'),
          timestamptz '2026-08-01 00:00:00+00', timestamptz '2026-08-01 00:00:00+00');
end;
$$;

select is(
  (select count(*)::integer from public.vendor_retailer_eligible_products_at(
     pg_temp.id('ret_other'), pg_temp.id('vendor'), timestamptz '2026-08-15')
   e join public.vendor_products vp on vp.id = e.vendor_product_id
   where vp.product_code = 'P-C'),
  0,
  'F3. an INACTIVE product is excluded even though its assignment interval is live'
);

select ok(
  public.vendor_product_eligible_for_retailer_at(
    pg_temp.id('p_c'), pg_temp.id('ret_other'), timestamptz '2026-08-15'),
  'F4. but the ASSIGNMENT resolver still reports it assigned — the two axes are distinct, and product status is documented as not yet temporal'
);

select is(
  public.vendor_product_eligible_for_retailer_at(
    gen_random_uuid(), pg_temp.id('ret_other'), timestamptz '2026-08-15'),
  false,
  'F5. an unknown product resolves to false rather than raising'
);

-- ============================================================================
-- SECTION G — the timeline computes nothing about rewards
-- ============================================================================
select is(
  (select count(*)::integer
   from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
   where n.nspname = 'public'
     and c.relname = 'vendor_product_retailer_assignment_history'
     and a.attname ~* '(coin|reward|earned|progress|balance|payout|claim|units)'),
  0,
  'G1. the history table holds no coin, reward, progress, balance, payout or claim column'
);

select is(
  (select count(*)::integer
   from pg_catalog.pg_proc p
   join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname ~ 'assignment_history' or p.proname ~ 'eligible_for_retailer_at'
          or p.proname ~ 'eligible_products_at' or p.proname ~ 'assignment_state_at')
     and (pg_catalog.pg_get_function_result(p.oid) ~* '(coin|reward|earned|progress|balance)'
       or pg_catalog.pg_get_function_arguments(p.oid) ~* '(coin|reward|earned|progress|balance)')),
  0,
  'G2. no temporal function accepts or returns a reward quantity'
);

select * from finish();

rollback;
