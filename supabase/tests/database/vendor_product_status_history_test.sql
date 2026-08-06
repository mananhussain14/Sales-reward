-- pgTAP behavioural tests for the TEMPORAL PRODUCT-STATUS TIMELINE:
--
--   public.vendor_product_status_history                           [20260817090000]
--   public.vendor_product_record_status_history()           (trigger)
--   public.vendor_product_status_history_assert_no_overlap()  (trigger)
--   public.vendor_product_status_history_assert_append_only() (trigger)
--   public.vendor_product_status_at(uuid, timestamptz)
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- Migration 20260814210000 made the product/Retailer ASSIGNMENT edge temporal and named the
-- gap it left in vendor_product_eligible_for_retailer_at's own header: vendor_products.status
-- "is a SECOND eligibility axis and it is NOT yet temporal [...] the reward engine milestone
-- must either add it or state that it evaluates product status currently."
--
-- Migration 20260817090000 adds it. This suite proves the second axis behaves exactly like
-- the first, and Section F proves the two compose into the answer the reward engine actually
-- needs: "was this product eligible for THIS Retailer at THAT instant?"
--
-- ============================================================================
-- HOW TIME IS CONTROLLED
-- ============================================================================
-- The trigger stamps boundaries with clock_timestamp(), which ADVANCES inside a transaction,
-- so a sequence of status flips produces distinct, correctly-ordered intervals in one
-- rolled-back transaction. Assertions read the boundaries the trigger produced rather than
-- asserting hand-picked calendar dates.
--
-- Everything runs inside one transaction and is rolled back. no_plan(), per convention.

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

-- The nth interval of product A, oldest first.
create function pg_temp.ival(p_n integer)
returns public.vendor_product_status_history
language sql stable as $$
  select h.* from public.vendor_product_status_history h
  where h.vendor_product_id = pg_temp.id('p_a')
  order by h.valid_from
  offset (p_n - 1) limit 1
$$;

create function pg_temp.n_intervals(p_product uuid) returns integer
language sql stable as $$
  select count(*)::integer from public.vendor_product_status_history
  where vendor_product_id = p_product
$$;

do $$
declare v_vendor uuid; v_ret uuid; v_actor uuid;
begin
  v_vendor := pg_temp.new_org('Vendor A', 'VENDOR');
  v_ret    := pg_temp.new_org('Retailer Alpha', 'RETAILER');
  v_actor  := pg_temp.new_person('Ada', 'Admin');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (v_vendor, v_ret, 'ACTIVE');

  insert into pg_temp.f values
    ('vendor', v_vendor), ('ret', v_ret), ('actor', v_actor);
end;
$$;

-- ============================================================================
-- SECTION A — the privilege surface
-- ============================================================================
select ok(
  (select relrowsecurity from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'vendor_product_status_history'),
  'A1. the timeline has row level security enabled'
);

select is(
  (select count(*)::integer from pg_catalog.pg_policy p
   join pg_catalog.pg_class c on c.oid = p.polrelid
   where c.relname = 'vendor_product_status_history'),
  0,
  'A2. and carries no policy — default deny is the whole design'
);

select ok(
  not has_table_privilege('authenticated', 'public.vendor_product_status_history', 'SELECT')
  and not has_table_privilege('authenticated', 'public.vendor_product_status_history', 'INSERT')
  and not has_table_privilege('authenticated', 'public.vendor_product_status_history', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.vendor_product_status_history', 'DELETE')
  and not has_table_privilege('anon', 'public.vendor_product_status_history', 'SELECT'),
  'A3. no browser role can read or write the timeline directly'
);

select ok(
  not has_table_privilege('service_role', 'public.vendor_product_status_history', 'TRUNCATE'),
  'A4. service_role cannot TRUNCATE it either'
);

select ok(
  not has_function_privilege('authenticated',
    'public.vendor_product_status_at(uuid, timestamptz)', 'EXECUTE'),
  'A5. the status resolver is not reachable by a browser'
);

-- ============================================================================
-- SECTION B — the timeline opens and moves
-- ============================================================================
do $$
declare v_id uuid;
begin
  insert into public.vendor_products
    (vendor_organization_id, product_code, product_name, status, created_by_profile_id)
  values (pg_temp.id('vendor'), 'P-A', 'Product A', 'ACTIVE', pg_temp.id('actor'))
  returning id into v_id;
  insert into pg_temp.f values ('p_a', v_id);

  -- A product born INACTIVE, to prove the first interval records the status the row actually
  -- had rather than assuming ACTIVE.
  insert into public.vendor_products
    (vendor_organization_id, product_code, product_name, status, created_by_profile_id)
  values (pg_temp.id('vendor'), 'P-B', 'Product B', 'INACTIVE', pg_temp.id('actor'))
  returning id into v_id;
  insert into pg_temp.f values ('p_b', v_id);
end;
$$;

select is(pg_temp.n_intervals(pg_temp.id('p_a')), 1,
  'B1. creating a product opens exactly one interval');
select is((pg_temp.ival(1)).product_status, 'ACTIVE', 'B2. recording the status it was created with');
select ok((pg_temp.ival(1)).valid_to is null, 'B3. and it is open');
select is((pg_temp.ival(1)).history_source, 'OBSERVED', 'B4. and marked OBSERVED');

select is(
  (pg_temp.ival(1)).valid_from,
  (select created_at from public.vendor_products where id = pg_temp.id('p_a')),
  'B5. the interval begins at the product''s OWN created_at, not at the trigger''s clock'
);

select is(
  (select product_status from public.vendor_product_status_history
   where vendor_product_id = pg_temp.id('p_b')),
  'INACTIVE',
  'B6. a product created INACTIVE opens an INACTIVE interval'
);

-- --- the flips ---------------------------------------------------------------
do $$
begin
  update public.vendor_products set status = 'INACTIVE' where id = pg_temp.id('p_a');
  update public.vendor_products set status = 'ACTIVE'   where id = pg_temp.id('p_a');
end;
$$;

select is(pg_temp.n_intervals(pg_temp.id('p_a')), 3,
  'B7. ACTIVE -> INACTIVE -> ACTIVE produces three intervals');
select is((pg_temp.ival(2)).product_status, 'INACTIVE', 'B8. the middle one is INACTIVE');
select is((pg_temp.ival(3)).product_status, 'ACTIVE',   'B9. and the last is ACTIVE again');
select ok((pg_temp.ival(3)).valid_to is null, 'B10. with only the last one open');

-- Only `status` moves the timeline. A description edit is not a change in sellability.
do $$
begin
  update public.vendor_products
  set product_name = 'Renamed Product A', brand = 'Acme', barcode = '01234567'
  where id = pg_temp.id('p_a');
end;
$$;

select is(pg_temp.n_intervals(pg_temp.id('p_a')), 3,
  'B11. editing name, brand and barcode writes NO interval — only status moves the timeline');

-- A write that sets status to the value it already holds is not a change.
do $$
begin
  update public.vendor_products set status = 'ACTIVE' where id = pg_temp.id('p_a');
end;
$$;

select is(pg_temp.n_intervals(pg_temp.id('p_a')), 3,
  'B12. and re-writing the SAME status writes nothing either');

-- ============================================================================
-- SECTION C — the intervals partition time
-- ============================================================================
select is(
  (select count(*)::integer from public.vendor_product_status_history
   where vendor_product_id = pg_temp.id('p_a') and valid_to is null),
  1,
  'C1. exactly ONE interval is open'
);

select is(
  (select count(*)::integer from (
     select h.valid_to, lead(h.valid_from) over (order by h.valid_from) as next_from
     from public.vendor_product_status_history h
     where h.vendor_product_id = pg_temp.id('p_a')) t
   where t.next_from is not null and t.valid_to is distinct from t.next_from),
  0,
  'C2. every interval ends exactly where the next begins — no gap, no leap'
);

select is(
  (select count(*)::integer
   from public.vendor_product_status_history a
   join public.vendor_product_status_history b
     on b.vendor_product_id = a.vendor_product_id and b.id <> a.id
    and tstzrange(a.valid_from, a.valid_to, '[)') && tstzrange(b.valid_from, b.valid_to, '[)')
   where a.vendor_product_id = pg_temp.id('p_a')),
  0,
  'C3. and no two intervals overlap'
);

-- ============================================================================
-- SECTION D — half-open boundary semantics
-- ============================================================================
select is(
  public.vendor_product_status_at(pg_temp.id('p_a'), (pg_temp.ival(2)).valid_from),
  'INACTIVE',
  'D1. the instant an interval begins is INSIDE it'
);

select is(
  public.vendor_product_status_at(pg_temp.id('p_a'), (pg_temp.ival(2)).valid_to),
  'ACTIVE',
  'D2. the instant it ends is NOT — that instant belongs to the next interval'
);

select is(
  public.vendor_product_status_at(pg_temp.id('p_a'),
    (pg_temp.ival(2)).valid_to - interval '1 microsecond'),
  'INACTIVE',
  'D3. and the last instant before the boundary is still inside it'
);

select is(
  public.vendor_product_status_at(pg_temp.id('p_a'), (pg_temp.ival(1)).valid_from),
  'ACTIVE',
  'D4. the very first instant of the product''s life resolves to its creation status'
);

-- NULL means "we have no record", deliberately NOT collapsed into INACTIVE.
select is(
  public.vendor_product_status_at(pg_temp.id('p_a'),
    (pg_temp.ival(1)).valid_from - interval '1 second'),
  null,
  'D5. an instant before the product existed resolves to NULL, not to INACTIVE'
);

select is(
  public.vendor_product_status_at(pg_temp.id('p_a'), timestamptz '2001-01-01'),
  null,
  'D6. and so does an instant long before any record'
);

-- ============================================================================
-- SECTION E — append-only
-- ============================================================================
select throws_ok(
  format($$ update public.vendor_product_status_history set product_status = 'ACTIVE'
            where vendor_product_id = %L and valid_to is not null $$, pg_temp.id('p_a')),
  '23514', 'A closed product status history interval is immutable',
  'E1. a CLOSED interval cannot be changed'
);

select throws_ok(
  format($$ delete from public.vendor_product_status_history where vendor_product_id = %L $$,
         pg_temp.id('p_a')),
  '23514', 'Product status history is append-only and cannot be deleted',
  'E2. no interval can be deleted, ever'
);

select throws_ok(
  format($$ update public.vendor_product_status_history set valid_from = now()
            where vendor_product_id = %L and valid_to is null $$, pg_temp.id('p_a')),
  '23514', 'Product status history identity is immutable',
  'E3. even an OPEN interval cannot have its start re-dated'
);

select throws_ok(
  format($$ update public.vendor_product_status_history set product_status = 'INACTIVE'
            where vendor_product_id = %L and valid_to is null $$, pg_temp.id('p_a')),
  '23514', 'Product status history identity is immutable',
  'E4. nor can an open interval have its recorded status rewritten'
);

select throws_ok(
  format($$ update public.vendor_product_status_history set product_status = product_status
            where vendor_product_id = %L and valid_to is null $$, pg_temp.id('p_a')),
  '23514', 'An open product status history interval may only be closed',
  'E5. and a NO-OP touch of an open interval is refused'
);

select throws_ok(
  format($$ insert into public.vendor_product_status_history
            (vendor_product_id, product_status, valid_from, valid_to)
            values (%L, 'ACTIVE', %L::timestamptz, %L::timestamptz) $$,
         pg_temp.id('p_a'), (pg_temp.ival(1)).valid_from, (pg_temp.ival(1)).valid_to),
  '23514', 'Product status history intervals cannot overlap',
  'E6. an interval overlapping an existing one is refused'
);

select throws_ok(
  format($$ insert into public.vendor_product_status_history
            (vendor_product_id, product_status, valid_from, valid_to)
            values (%L, 'ACTIVE', now(), now() - interval '1 day') $$, pg_temp.id('p_a')),
  '23514', null,
  'E7. an inverted interval is refused BY THE CONSTRAINT, not by a range-construction error'
);

select throws_ok(
  format($$ insert into public.vendor_product_status_history
            (vendor_product_id, product_status, valid_from)
            values (%L, 'DISCONTINUED', now() + interval '900 days') $$, pg_temp.id('p_a')),
  '23514', null,
  'E8. the timeline speaks the SAME vocabulary as vendor_products and no other'
);

-- The foreign key is ON DELETE RESTRICT, so a product with recorded history can no longer be
-- hard-deleted at all. That is a strengthening of the rule 20260727090000 stated in prose.
select throws_ok(
  format($$ delete from public.vendor_products where id = %L $$, pg_temp.id('p_a')),
  '23503', null,
  'E9. a product with recorded history cannot be hard-deleted'
);

-- ============================================================================
-- SECTION F — the two eligibility axes compose
-- ============================================================================
-- This is the question the reward engine actually asks. Neither resolver answers it alone:
-- the assignment timeline knows WHO may sell a product, and this timeline knows WHETHER it
-- was sellable at all.
do $$
begin
  insert into public.vendor_product_retailer_assignments
    (vendor_product_id, retailer_organization_id, status, assigned_by_profile_id)
  values (pg_temp.id('p_a'), pg_temp.id('ret'), 'ACTIVE', pg_temp.id('actor'));
end;
$$;

-- clock_timestamp(), NOT now(), throughout this section.
--
-- The trigger stamps every boundary with clock_timestamp(), which ADVANCES during a
-- transaction, while now() is frozen at the transaction's start. A same-transaction reader
-- asking about now() is therefore asking about an instant BEFORE the boundary it just
-- created, and would read the previous interval. That is not a defect -- it is the same
-- deliberate choice vendor_product_assignment_record_history made, for the same reason (two
-- changes inside one transaction must not collapse into a zero-length interval) -- but it
-- means a test that writes and reads in one transaction must use the clock the timeline
-- itself uses. In production the reward engine asks about a verified SALE instant, never
-- about now(), so the distinction never arises there.
select ok(
  public.vendor_product_eligible_for_retailer_at(pg_temp.id('p_a'), pg_temp.id('ret'), clock_timestamp())
  and public.vendor_product_status_at(pg_temp.id('p_a'), clock_timestamp()) = 'ACTIVE',
  'F1. assigned AND active right now — both axes say yes'
);

-- Deactivate the product WITHOUT touching the assignment. The assignment axis still says yes;
-- the catalogue axis now says no. Only reading both gives the right answer.
do $$
begin
  update public.vendor_products set status = 'INACTIVE' where id = pg_temp.id('p_a');
end;
$$;

select ok(
  public.vendor_product_eligible_for_retailer_at(pg_temp.id('p_a'), pg_temp.id('ret'), clock_timestamp()),
  'F2. after deactivation the ASSIGNMENT axis still says yes — it was never withdrawn'
);

select is(
  public.vendor_product_status_at(pg_temp.id('p_a'), clock_timestamp()),
  'INACTIVE',
  'F3. while the CATALOGUE axis now says no — which is why both must be consulted'
);

-- The whole point: a PAST sale keeps the answer that was true when it happened.
select is(
  public.vendor_product_status_at(pg_temp.id('p_a'), (pg_temp.ival(3)).valid_from),
  'ACTIVE',
  'F4. and a sale made before the deactivation still reads ACTIVE — today''s status does not reach back'
);

select * from finish();
rollback;
