-- Tests for Phase 1D-0: append-only receipt qualification exclusions.
--
-- Run with:  supabase test db
--
-- ============================================================================
-- WHAT THIS SUITE IS ACTUALLY PROTECTING
-- ============================================================================
-- One property matters more than the rest and every other test exists to support it:
--
--     A VERIFIED review decision and a qualification exclusion are SEPARATE FACTS,
--     and recording the second must never touch the first.
--
-- The rest follow from that: the exclusion is append-only (Section C), it is derived
-- from events rather than a status column (Section E), only a Claim Reviewer holding
-- the new permission may record one (Section B), it cannot cross a Vendor boundary
-- (Section D), a retry cannot double-post it or its audit row (Section F), and a
-- stale page cannot reverse an exclusion it never saw (Section G).
--
-- Everything runs inside one transaction and is rolled back. Every fixture is
-- synthetic; the six real hosted receipts and the one real decision are never
-- touched, and this suite runs only against the local database.

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

create function pg_temp.sign_out() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.new_person(p_first text, p_last text, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || left(v_id::text, 8) || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, p_status);
  return v_id;
end;
$$;

create function pg_temp.new_org(p_name text, p_type text, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.organizations (name, organization_type, status, country_code, default_currency)
  values (p_name, p_type, p_status, 'AE', 'AED') returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.add_member(p_user uuid, p_org uuid, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_m uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, p_status, now() - interval '30 days') returning id into v_m;
  return v_m;
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

create function pg_temp.link(p_vendor uuid, p_retailer uuid, p_status text default 'ACTIVE')
returns void language plpgsql as $$
begin
  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (p_vendor, p_retailer, p_status);
end;
$$;

create function pg_temp.new_shop(
  p_retailer uuid, p_name text, p_code text, p_status text default 'ACTIVE'
) returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (p_retailer, p_name, p_code, p_status, 'Asia/Dubai') returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.new_receipt(
  p_retailer uuid, p_shop uuid, p_submitter uuid,
  p_status text default 'SUBMITTED'
) returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
  v_path text := 'q/' || v_id::text || '.png';
begin
  insert into public.receipt_submissions (
    id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
    storage_bucket, storage_object_path, original_file_name, mime_type,
    file_size_bytes, file_sha256, status, submitted_at
  ) values (
    v_id, p_retailer, p_shop, p_submitter,
    'receipts', v_path, 'r.png', 'image/png', 1000,
    encode(gen_random_bytes(32), 'hex'), p_status,
    case when p_status = 'SUBMITTED' then now() - interval '1 day' else null end
  );
  insert into storage.objects (bucket_id, name, owner) values ('receipts', v_path, null);
  return v_id;
end;
$$;

/* Records a review decision directly, bypassing the RPC, so the fixture does not
   depend on who happens to be impersonated at setup time. */
create function pg_temp.decide(p_receipt uuid, p_vendor uuid, p_by uuid, p_decision text)
returns void language plpgsql as $$
begin
  insert into public.receipt_review_decisions
    (receipt_submission_id, vendor_organization_id, decision, rejection_reason,
     reviewer_note, decided_by_profile_id)
  values (p_receipt, p_vendor, p_decision,
          case when p_decision = 'REJECTED' then 'UNREADABLE_RECEIPT' else null end,
          null, p_by);
end;
$$;

create table pg_temp.f (k text primary key, v uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select v from pg_temp.f where k = p
$$;

/* The effective state the READ function reports for the CURRENT caller. */
create function pg_temp.state(p_receipt uuid) returns text
language sql stable as $$
  select q.qualification_state from public.get_claim_receipt_qualification(p_receipt) q
$$;

/* How many rows the read function returns — 0 means "not yours / not there". */
create function pg_temp.read_rows(p_receipt uuid) returns integer
language sql stable as $$
  select count(*)::integer from public.get_claim_receipt_qualification(p_receipt)
$$;

/* One classification call, returning just the outcome. */
create function pg_temp.classify(
  p_receipt uuid, p_action text, p_reason text default null, p_note text default null
) returns text language sql volatile as $$
  select r.outcome
  from public.record_claim_receipt_qualification(p_receipt, p_action, p_reason, p_note) r
$$;

create function pg_temp.event_count(p_receipt uuid) returns integer
language sql stable as $$
  select count(*)::integer from public.receipt_qualification_events
  where receipt_submission_id = p_receipt
$$;

create function pg_temp.audit_count(p_receipt uuid) returns integer
language sql stable as $$
  select count(*)::integer from public.audit_logs
  where entity_id = p_receipt::text
    and action in ('RECEIPT_QUALIFICATION_EXCLUDED', 'RECEIPT_QUALIFICATION_REINSTATED')
$$;

do $$
declare v_m uuid;
begin
  insert into pg_temp.f values
    ('vendor_a',   pg_temp.new_org('QE Vendor A', 'VENDOR')),
    ('vendor_b',   pg_temp.new_org('QE Vendor B', 'VENDOR')),
    ('retailer_a', pg_temp.new_org('QE Retailer A', 'RETAILER')),
    ('retailer_b', pg_temp.new_org('QE Retailer B', 'RETAILER')),
    ('retailer_x', pg_temp.new_org('QE Retailer X', 'RETAILER'));

  -- Vendor A's reviewer, holding the new permission through CLAIM_REVIEWER.
  insert into pg_temp.f values ('reviewer', pg_temp.new_person('Rev', 'Alpha'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer'), pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  -- A second Vendor A reviewer, for the "different reviewer" conflict cases.
  insert into pg_temp.f values ('reviewer2', pg_temp.new_person('Rev', 'Beta'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer2'), pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  -- A DEACTIVATED reviewer membership.
  insert into pg_temp.f values ('reviewer_off', pg_temp.new_person('Rev', 'Gone'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer_off'), pg_temp.id('vendor_a'), 'DEACTIVATED');
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  -- Vendor B's own reviewer, for isolation.
  insert into pg_temp.f values ('reviewer_b', pg_temp.new_person('Rev', 'Bee'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer_b'), pg_temp.id('vendor_b'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  -- Every other role, none of which may classify.
  insert into pg_temp.f values ('vsa', pg_temp.new_person('Vend', 'Admin'));
  v_m := pg_temp.add_member(pg_temp.id('vsa'), pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, 'VENDOR_SUPER_ADMIN');

  insert into pg_temp.f values ('finance', pg_temp.new_person('Fin', 'Admin'));
  v_m := pg_temp.add_member(pg_temp.id('finance'), pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, 'FINANCE_ADMIN');

  insert into pg_temp.f values ('owner', pg_temp.new_person('Own', 'Er'));
  v_m := pg_temp.add_member(pg_temp.id('owner'), pg_temp.id('retailer_a'));
  perform pg_temp.add_role(v_m, 'RETAILER_OWNER');

  insert into pg_temp.f values ('manager', pg_temp.new_person('Man', 'Ager'));
  v_m := pg_temp.add_member(pg_temp.id('manager'), pg_temp.id('retailer_a'));
  perform pg_temp.add_role(v_m, 'RETAILER_MANAGER');

  insert into pg_temp.f values ('staff', pg_temp.new_person('Sal', 'Staff'));
  v_m := pg_temp.add_member(pg_temp.id('staff'), pg_temp.id('retailer_a'));
  perform pg_temp.add_role(v_m, 'RETAILER_SALES_STAFF');

  -- A staff member whose membership is now DEACTIVATED, and a shop that is now
  -- DEACTIVATED: both must still allow classification of their historical receipt.
  insert into pg_temp.f values ('staff_gone', pg_temp.new_person('Old', 'Staff'));
  v_m := pg_temp.add_member(pg_temp.id('staff_gone'), pg_temp.id('retailer_a'), 'DEACTIVATED');
  perform pg_temp.add_role(v_m, 'RETAILER_SALES_STAFF');

  perform pg_temp.link(pg_temp.id('vendor_a'), pg_temp.id('retailer_a'), 'ACTIVE');
  perform pg_temp.link(pg_temp.id('vendor_b'), pg_temp.id('retailer_b'), 'ACTIVE');
  -- Retailer X starts ACTIVE so its receipt can be decided at all — the decision
  -- table's own tenant trigger refuses a decision across a dead link. It is
  -- deactivated further down, AFTER the decision exists, which is the realistic
  -- shape anyway: the relationship ended while a decided receipt stayed behind.
  perform pg_temp.link(pg_temp.id('vendor_a'), pg_temp.id('retailer_x'), 'ACTIVE');

  insert into pg_temp.f values
    ('shop_a',    pg_temp.new_shop(pg_temp.id('retailer_a'), 'QE Shop A', 'QEA')),
    ('shop_gone', pg_temp.new_shop(pg_temp.id('retailer_a'), 'QE Shop Gone', 'QEG', 'DEACTIVATED')),
    ('shop_b',    pg_temp.new_shop(pg_temp.id('retailer_b'), 'QE Shop B', 'QEB')),
    ('shop_x',    pg_temp.new_shop(pg_temp.id('retailer_x'), 'QE Shop X', 'QEX'));

  -- Receipts. `r_main` is the workhorse; the rest each isolate one refusal.
  insert into pg_temp.f values
    ('r_main',      pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'))),
    ('r_second',    pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'))),
    ('r_third',     pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'))),
    ('r_rejected',  pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'))),
    ('r_undecided', pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'))),
    ('r_reserved',  pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'), 'RESERVED')),
    ('r_foreign',   pg_temp.new_receipt(pg_temp.id('retailer_b'), pg_temp.id('shop_b'), pg_temp.id('staff'))),
    ('r_deadlink',  pg_temp.new_receipt(pg_temp.id('retailer_x'), pg_temp.id('shop_x'), pg_temp.id('staff'))),
    ('r_oldshop',   pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_gone'), pg_temp.id('staff_gone')));

  perform pg_temp.decide(pg_temp.id('r_main'),     pg_temp.id('vendor_a'), pg_temp.id('reviewer'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_second'),   pg_temp.id('vendor_a'), pg_temp.id('reviewer'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_third'),    pg_temp.id('vendor_a'), pg_temp.id('reviewer'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_rejected'), pg_temp.id('vendor_a'), pg_temp.id('reviewer'), 'REJECTED');
  perform pg_temp.decide(pg_temp.id('r_foreign'),  pg_temp.id('vendor_b'), pg_temp.id('reviewer_b'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_deadlink'), pg_temp.id('vendor_a'), pg_temp.id('reviewer'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_oldshop'),  pg_temp.id('vendor_a'), pg_temp.id('reviewer'), 'VERIFIED');

  -- NOW end the Vendor A <-> Retailer X relationship, leaving r_deadlink as a
  -- decided receipt behind a dead link.
  update public.vendor_retailers set status = 'DEACTIVATED'
  where vendor_organization_id = pg_temp.id('vendor_a')
    and retailer_organization_id = pg_temp.id('retailer_x');
end;
$$;


-- ============================================================================
-- SECTION A — the permission
-- ============================================================================
select is(
  (select count(*)::integer from public.permissions
    where code = 'RECEIPT_QUALIFICATION_CLASSIFY' and module = 'CLAIM_REVIEW'),
  1,
  'A1. RECEIPT_QUALIFICATION_CLASSIFY exists exactly once, in the CLAIM_REVIEW module'
);

select is(
  (select string_agg(r.code, ',' order by r.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RECEIPT_QUALIFICATION_CLASSIFY'),
  'CLAIM_REVIEWER',
  'A2. and maps to CLAIM_REVIEWER and nothing else'
);

select is(
  (select string_agg(p.code, ',' order by p.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'CLAIM_REVIEWER'),
  -- Phase 1D-B adds RECEIPT_SALE_ITEMS_FINALIZE by approval.
  'CLAIM_REVIEW_PORTAL_READ,RECEIPT_QUALIFICATION_CLASSIFY,RECEIPT_REVIEW_DECIDE,RECEIPT_REVIEW_READ,RECEIPT_SALE_HEADER_FINALIZE,RECEIPT_SALE_ITEMS_FINALIZE',
  'A3. CLAIM_REVIEWER now holds exactly its six approved permissions'
);

-- SUPERSEDED BY PHASE 1D-A, which added the approved RECEIPT_SALE_HEADER_FINALIZE.
-- The original forbade any SALE_ permission outright, which was right while no sale
-- object existed. The durable property is narrower and is asserted in two halves:
-- reward machinery is still forbidden entirely, and the ONLY sale permission that
-- may exist is the one Phase 1D-A approved.
select is(
  (select count(*)::integer from public.permissions
    where code ~ '(REWARD|COIN|BALANCE|PAYOUT|LEDGER)'),
  0,
  'A4. no reward, coin, balance, payout or ledger permission was added'
);

select is(
  (select coalesce(string_agg(code, ',' order by code), 'NONE')::text
   from public.permissions where code ~ 'SALE'),
  -- Phase 1D-B adds the approved item-finalize permission beside it. Reward
  -- machinery above stays forbidden entirely.
  'RECEIPT_SALE_HEADER_FINALIZE,RECEIPT_SALE_ITEMS_FINALIZE',
  'A4b. and the only sale permissions are the two approved finalize permissions'
);

select is(
  (select count(*)::integer from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RECEIPT_QUALIFICATION_CLASSIFY'
     and r.code in ('VENDOR_SUPER_ADMIN','FINANCE_ADMIN','RETAILER_OWNER',
                    'RETAILER_MANAGER','RETAILER_SALES_STAFF')),
  0,
  'A5. and no other role received it'
);


-- ============================================================================
-- SECTION B — who may read and who may classify
-- ============================================================================
select ok(
  has_function_privilege('authenticated', 'public.get_claim_receipt_qualification(uuid)', 'EXECUTE'),
  'B1. authenticated may execute the read function'
);
select ok(
  not has_function_privilege('anon', 'public.get_claim_receipt_qualification(uuid)', 'EXECUTE'),
  'B2. anon may not'
);
select ok(
  not has_function_privilege('public', 'public.get_claim_receipt_qualification(uuid)', 'EXECUTE'),
  'B3. and neither may PUBLIC'
);
select ok(
  has_function_privilege('authenticated', 'public.record_claim_receipt_qualification(uuid,text,text,text)', 'EXECUTE'),
  'B4. authenticated may execute the write function'
);
select ok(
  not has_function_privilege('anon', 'public.record_claim_receipt_qualification(uuid,text,text,text)', 'EXECUTE'),
  'B5. anon may not'
);
select ok(
  not has_function_privilege('public', 'public.record_claim_receipt_qualification(uuid,text,text,text)', 'EXECUTE'),
  'B6. and neither may PUBLIC'
);
select ok(
  not has_function_privilege('authenticated', 'public.receipt_qualification_is_excluded(uuid)', 'EXECUTE'),
  'B7. the internal fail-closed helper is NOT callable by authenticated'
);
select ok(
  not has_function_privilege('anon', 'public.receipt_qualification_is_excluded(uuid)', 'EXECUTE'),
  'B8. nor by anon'
);
select ok(
  not has_function_privilege('authenticated', 'public.resolve_claim_reviewer_organization(text)', 'EXECUTE'),
  'B9. the internal reviewer resolver keeps its privilege boundary'
);

-- Direct table access, for every browser role.
select ok(
  not has_table_privilege('authenticated', 'public.receipt_qualification_events', 'SELECT'),
  'B10. authenticated cannot read the event table directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.receipt_qualification_events', 'INSERT'),
  'B11. nor insert into it'
);
select ok(
  not has_table_privilege('anon', 'public.receipt_qualification_events', 'SELECT'),
  'B12. anon cannot read it'
);
select ok(
  not has_table_privilege('service_role', 'public.receipt_qualification_events', 'TRUNCATE'),
  'B13. service_role cannot truncate it'
);

-- The reviewer works.
select pg_temp.act_as(pg_temp.id('reviewer'));
select is(pg_temp.read_rows(pg_temp.id('r_main')), 1,
  'B14. an active Claim Reviewer can read qualification state');
select is(pg_temp.state(pg_temp.id('r_main')), 'QUALIFICATION_NOT_EXCLUDED',
  'B15. and a receipt with no events reads as not excluded');

-- Nobody else can read.
select pg_temp.act_as(pg_temp.id('vsa'));
select is(pg_temp.read_rows(pg_temp.id('r_main')), 0,
  'B16. a Vendor Super Admin reads nothing through that role alone');
select pg_temp.act_as(pg_temp.id('finance'));
select is(pg_temp.read_rows(pg_temp.id('r_main')), 0, 'B17. a Finance Admin reads nothing');
select pg_temp.act_as(pg_temp.id('owner'));
select is(pg_temp.read_rows(pg_temp.id('r_main')), 0, 'B18. a Retailer Owner reads nothing');
select pg_temp.act_as(pg_temp.id('manager'));
select is(pg_temp.read_rows(pg_temp.id('r_main')), 0, 'B19. a Retailer Manager reads nothing');
select pg_temp.act_as(pg_temp.id('staff'));
select is(pg_temp.read_rows(pg_temp.id('r_main')), 0, 'B20. Sales Staff read nothing');
select pg_temp.act_as(pg_temp.id('reviewer_off'));
select is(pg_temp.read_rows(pg_temp.id('r_main')), 0,
  'B21. a DEACTIVATED reviewer membership reads nothing');
select pg_temp.sign_out();
select is(pg_temp.read_rows(pg_temp.id('r_main')), 0, 'B22. a signed-out caller reads nothing');

-- And nobody else can classify. Each raises rather than returning a row.
select pg_temp.act_as(pg_temp.id('vsa'));
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_main'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'B23. a Vendor Super Admin cannot classify through that role alone');
select pg_temp.act_as(pg_temp.id('finance'));
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_main'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'B24. a Finance Admin cannot classify');
select pg_temp.act_as(pg_temp.id('owner'));
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_main'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'B25. a Retailer Owner cannot classify');
select pg_temp.act_as(pg_temp.id('manager'));
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_main'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'B26. a Retailer Manager cannot classify');
select pg_temp.act_as(pg_temp.id('staff'));
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_main'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'B27. Sales Staff cannot classify');
select pg_temp.act_as(pg_temp.id('reviewer_off'));
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_main'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'B28. a DEACTIVATED reviewer membership cannot classify');
select pg_temp.sign_out();
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_main'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'B29. a signed-out caller cannot classify');

select is(
  (select count(*)::integer from public.receipt_qualification_events),
  0,
  'B30. and none of those refused attempts wrote an event'
);


-- ============================================================================
-- SECTION C — the table is append-only
-- ============================================================================
select has_table('public', 'receipt_qualification_events', 'C1. the event table exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.receipt_qualification_events'::regclass),
  'C2. RLS is enabled'
);

select is(
  (select count(*)::integer from pg_policy
    where polrelid = 'public.receipt_qualification_events'::regclass),
  0,
  'C3. with ZERO direct policies'
);

select is(
  (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
    where t.tgrelid = 'public.receipt_qualification_events'::regclass and not t.tgisinternal),
  'receipt_qualification_events_assert_tenant,receipt_qualification_events_guard_change,receipt_qualification_events_guard_truncate',
  'C4. and exactly three guards: tenant assertion, change guard, truncate guard'
);

-- Write one event to have something to try to mutate.
select pg_temp.act_as(pg_temp.id('reviewer'));
select is(pg_temp.classify(pg_temp.id('r_main'), 'EXCLUDE', 'TEST_DATA'), 'EXCLUDED',
  'C5. the reviewer can exclude a VERIFIED receipt');

select throws_ok(
  $$ update public.receipt_qualification_events set exclusion_reason = 'DUPLICATE' $$,
  '23514', null, 'C6. UPDATE is refused');
select throws_ok(
  $$ delete from public.receipt_qualification_events $$,
  '23514', null, 'C7. DELETE is refused');
select throws_ok(
  $$ truncate public.receipt_qualification_events $$,
  '23514', null, 'C8. TRUNCATE is refused');


-- ============================================================================
-- SECTION D — eligibility and tenant isolation
-- ============================================================================
select pg_temp.act_as(pg_temp.id('reviewer'));

select throws_ok(
  $$ select pg_temp.classify(gen_random_uuid(), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'D1. a nonexistent receipt cannot be classified');
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_reserved'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'D2. a RESERVED receipt cannot be classified');
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_undecided'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'D3. a receipt with no review decision cannot be classified');
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_rejected'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'D4. a REJECTED receipt cannot be classified');
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_foreign'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'D5. another Vendor''s receipt cannot be classified');
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_deadlink'), 'EXCLUDE', 'TEST_DATA') $$,
  '42501', null, 'D6. a DEACTIVATED vendor_retailers link blocks classification');

select is(pg_temp.read_rows(pg_temp.id('r_foreign')), 0,
  'D7. and a foreign receipt reads as zero rows, exactly like a nonexistent one');
select is(pg_temp.read_rows(gen_random_uuid()), 0,
  'D8. a nonexistent receipt also reads as zero rows — the two are indistinguishable');

-- History stays reachable: neither a deactivated shop nor a departed submitter blocks it.
select is(pg_temp.classify(pg_temp.id('r_oldshop'), 'EXCLUDE', 'TEST_DATA'), 'EXCLUDED',
  'D9. a DEACTIVATED shop and a DEACTIVATED submitter do NOT block classification');

-- Isolation runs both ways.
select pg_temp.act_as(pg_temp.id('reviewer_b'));
select is(pg_temp.read_rows(pg_temp.id('r_main')), 0,
  'D10. Vendor B''s reviewer cannot read Vendor A''s receipt');
select is(pg_temp.read_rows(pg_temp.id('r_foreign')), 1,
  'D11. but can read their own');


-- ============================================================================
-- SECTION E — constraints and vocabularies
-- ============================================================================
-- Back to Vendor A's reviewer: Section D left Vendor B's reviewer impersonated, and
-- every classify() below is meant to test a CONSTRAINT rather than a tenant refusal.
select pg_temp.act_as(pg_temp.id('reviewer'));

select is(
  (select count(*)::integer from pg_constraint
    where conrelid = 'public.receipt_qualification_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%EXCLUDED%REINSTATED%'),
  1,
  'E1. the event-type vocabulary is exactly EXCLUDED / REINSTATED'
);

select ok(
  (select pg_get_constraintdef(oid) ~ 'TEST_DATA' and pg_get_constraintdef(oid) ~ 'NON_QUALIFYING'
          and pg_get_constraintdef(oid) ~ 'DUPLICATE'
   from pg_constraint
   where conrelid = 'public.receipt_qualification_events'::regclass
     and conname = 'receipt_qualification_events_reason_allowed'),
  'E2. the reason vocabulary is exactly TEST_DATA / NON_QUALIFYING / DUPLICATE'
);

select is(
  (select count(*)::integer from pg_constraint
    where conrelid = 'public.receipt_qualification_events'::regclass
      and pg_get_constraintdef(oid) ilike '%ADMINISTRATIVE%'),
  0,
  'E3. and no vague ADMINISTRATIVE_EXCLUSION reason was added'
);

-- The shape biconditionals, exercised directly against the table.
select throws_ok(
  $$ insert into public.receipt_qualification_events
       (receipt_submission_id, vendor_organization_id, event_type, classified_by_profile_id)
     select v, (select v from pg_temp.f where k='vendor_a'), 'EXCLUDED',
            (select v from pg_temp.f where k='reviewer')
     from pg_temp.f where k='r_second' $$,
  '23514', null, 'E4. an EXCLUDED event without a reason is refused');

select throws_ok(
  $$ insert into public.receipt_qualification_events
       (receipt_submission_id, vendor_organization_id, event_type, exclusion_reason,
        reverses_event_id, classified_by_profile_id)
     select v, (select v from pg_temp.f where k='vendor_a'), 'EXCLUDED', 'TEST_DATA',
            (select id from public.receipt_qualification_events limit 1),
            (select v from pg_temp.f where k='reviewer')
     from pg_temp.f where k='r_second' $$,
  '23514', null, 'E5. an EXCLUDED event carrying a reversal target is refused');

select throws_ok(
  $$ insert into public.receipt_qualification_events
       (receipt_submission_id, vendor_organization_id, event_type, classified_by_profile_id)
     select v, (select v from pg_temp.f where k='vendor_a'), 'REINSTATED',
            (select v from pg_temp.f where k='reviewer')
     from pg_temp.f where k='r_second' $$,
  '23514', null, 'E6. a REINSTATED event without a reversal target is refused');

select throws_ok(
  $$ insert into public.receipt_qualification_events
       (receipt_submission_id, vendor_organization_id, event_type, exclusion_reason,
        reverses_event_id, classified_by_profile_id)
     select v, (select v from pg_temp.f where k='vendor_a'), 'REINSTATED', 'TEST_DATA',
            (select id from public.receipt_qualification_events limit 1),
            (select v from pg_temp.f where k='reviewer')
     from pg_temp.f where k='r_second' $$,
  '23514', null, 'E7. a REINSTATED event carrying a reason is refused');

select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_second'),
                             'EXCLUDE', 'NON_QUALIFYING') $$,
  '22023', null, 'E8. NON_QUALIFYING without a note is refused');

-- A whitespace-only note is trimmed to NULL, so it fails the same requirement rather
-- than sneaking past it.
select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_second'),
                             'EXCLUDE', 'NON_QUALIFYING', '   ') $$,
  '22023', null, 'E9. and a whitespace-only note does not satisfy it either');

select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_second'),
                             'EXCLUDE', 'TEST_DATA', repeat('x', 501)) $$,
  '22023', null, 'E10. a note over 500 characters is refused');

select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_second'), 'EXCLUDE', 'FRAUD') $$,
  '22023', null, 'E11. an unrecognised reason is refused');

select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_second'), 'DELETE', 'TEST_DATA') $$,
  '22023', null, 'E12. an unrecognised action is refused');

select throws_ok(
  $$ select pg_temp.classify((select v from pg_temp.f where k='r_second'), 'REINSTATE', 'TEST_DATA') $$,
  '22023', null, 'E13. a reinstatement carrying a reason is refused');

-- TEST_DATA and DUPLICATE need no note; a 500-character note is accepted.
select is(pg_temp.classify(pg_temp.id('r_second'), 'EXCLUDE', 'DUPLICATE'), 'EXCLUDED',
  'E14. DUPLICATE needs no note');
select is(pg_temp.classify(pg_temp.id('r_third'), 'EXCLUDE', 'TEST_DATA', repeat('y', 500)), 'EXCLUDED',
  'E15. and a note of exactly 500 characters is accepted');


-- ============================================================================
-- SECTION F — effective state, idempotency and audit
-- ============================================================================
select pg_temp.act_as(pg_temp.id('reviewer'));

select is(pg_temp.state(pg_temp.id('r_main')), 'QUALIFICATION_EXCLUDED',
  'F1. after an exclusion the effective state is QUALIFICATION_EXCLUDED');
select is(pg_temp.event_count(pg_temp.id('r_main')), 1, 'F2. exactly one event exists');
select is(pg_temp.audit_count(pg_temp.id('r_main')), 1, 'F3. and exactly one Audit Log event');

-- Identical retry.
select is(pg_temp.classify(pg_temp.id('r_main'), 'EXCLUDE', 'TEST_DATA'), 'ALREADY_EXCLUDED',
  'F4. an identical retry returns ALREADY_EXCLUDED');
select is(pg_temp.event_count(pg_temp.id('r_main')), 1, 'F5. and creates no second event');
select is(pg_temp.audit_count(pg_temp.id('r_main')), 1, 'F6. and no second Audit Log event');

select is(
  (select r.changed::text from public.record_claim_receipt_qualification(
     pg_temp.id('r_main'), 'EXCLUDE', 'TEST_DATA') r),
  'false',
  'F7. the retry reports changed = false'
);

-- A different reason on an actively excluded receipt is a conflict, not an overwrite.
select is(pg_temp.classify(pg_temp.id('r_main'), 'EXCLUDE', 'DUPLICATE'), 'CONFLICT',
  'F8. a different reason against an active exclusion returns CONFLICT');
select is(pg_temp.event_count(pg_temp.id('r_main')), 1, 'F9. and writes nothing');
select is(pg_temp.audit_count(pg_temp.id('r_main')), 1, 'F10. and logs nothing');
select is(
  (select x.exclusion_reason from public.receipt_qualification_events x
    where x.receipt_submission_id = pg_temp.id('r_main')),
  'TEST_DATA',
  'F11. the original reason is untouched'
);

-- A DIFFERENT reviewer retrying the same values is also a conflict: idempotency is
-- per-actor, so one reviewer cannot silently adopt another's classification.
select pg_temp.act_as(pg_temp.id('reviewer2'));
select is(pg_temp.classify(pg_temp.id('r_main'), 'EXCLUDE', 'TEST_DATA'), 'CONFLICT',
  'F12. a second reviewer repeating the same values gets CONFLICT, not ALREADY_EXCLUDED');

-- Audit metadata.
select pg_temp.act_as(pg_temp.id('reviewer'));
select is(
  (select (select string_agg(k, ',' order by k) from jsonb_object_keys(a.metadata) k)
   from public.audit_logs a
   where a.entity_id = pg_temp.id('r_main')::text
     and a.action = 'RECEIPT_QUALIFICATION_EXCLUDED'),
  'exclusion_reason,note_present,qualification_action',
  'F13. exclusion metadata carries exactly the three approved keys'
);
select is(
  (select a.metadata->>'exclusion_reason' from public.audit_logs a
    where a.entity_id = pg_temp.id('r_main')::text
      and a.action = 'RECEIPT_QUALIFICATION_EXCLUDED'),
  'TEST_DATA',
  'F14. with the correct reason'
);
select is(
  (select a.entity_type from public.audit_logs a
    where a.entity_id = pg_temp.id('r_main')::text
      and a.action = 'RECEIPT_QUALIFICATION_EXCLUDED'),
  'RECEIPT_SUBMISSION',
  'F15. and entity_type RECEIPT_SUBMISSION'
);
select ok(
  (select a.organization_id is not null and a.actor_profile_id is not null
   from public.audit_logs a
   where a.entity_id = pg_temp.id('r_main')::text
     and a.action = 'RECEIPT_QUALIFICATION_EXCLUDED'),
  'F16. organization and actor are recorded'
);

-- The note text must not travel into audit metadata.
select is(
  (select count(*)::integer from public.audit_logs a
    where a.entity_id = pg_temp.id('r_third')::text
      and a.action = 'RECEIPT_QUALIFICATION_EXCLUDED'
      and a.metadata::text like '%' || repeat('y', 100) || '%'),
  0,
  'F17. the reviewer note text never appears in Audit Log metadata'
);
select is(
  (select a.metadata->>'note_present' from public.audit_logs a
    where a.entity_id = pg_temp.id('r_third')::text
      and a.action = 'RECEIPT_QUALIFICATION_EXCLUDED'),
  'true',
  'F18. only the note_present flag is recorded'
);
select is(
  (select count(*)::integer from public.audit_logs a
    where a.action in ('RECEIPT_QUALIFICATION_EXCLUDED','RECEIPT_QUALIFICATION_REINSTATED')
      and a.metadata::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'),
  0,
  'F19. and no UUID appears in any qualification metadata'
);


-- ============================================================================
-- SECTION G — reversal, and the stale-page guarantee
-- ============================================================================
select pg_temp.act_as(pg_temp.id('reviewer'));

select is(pg_temp.classify(pg_temp.id('r_main'), 'REINSTATE'), 'REINSTATED',
  'G1. an active exclusion can be reversed');
select is(pg_temp.state(pg_temp.id('r_main')), 'QUALIFICATION_NOT_EXCLUDED',
  'G2. and the effective state returns to not-excluded');
select is(pg_temp.event_count(pg_temp.id('r_main')), 2,
  'G3. the exclusion event is NOT deleted — a second event is appended');
select is(
  (select count(*)::integer from public.receipt_qualification_events
    where receipt_submission_id = pg_temp.id('r_main') and event_type = 'EXCLUDED'),
  1,
  'G4. the original EXCLUDED event is still there, intact'
);
select is(pg_temp.audit_count(pg_temp.id('r_main')), 2,
  'G5. and exactly one further Audit Log event was written');
select is(
  (select (select string_agg(k, ',' order by k) from jsonb_object_keys(a.metadata) k)
   from public.audit_logs a
   where a.entity_id = pg_temp.id('r_main')::text
     and a.action = 'RECEIPT_QUALIFICATION_REINSTATED'),
  'note_present,previous_exclusion_reason,qualification_action',
  'G6. reinstatement metadata carries exactly the three approved keys'
);
select is(
  (select a.metadata->>'previous_exclusion_reason' from public.audit_logs a
    where a.entity_id = pg_temp.id('r_main')::text
      and a.action = 'RECEIPT_QUALIFICATION_REINSTATED'),
  'TEST_DATA',
  'G7. naming the reason it reversed'
);

select is(pg_temp.classify(pg_temp.id('r_main'), 'REINSTATE'), 'ALREADY_REINSTATED',
  'G8. repeating the reinstatement is idempotent');
select is(pg_temp.event_count(pg_temp.id('r_main')), 2, 'G9. and creates no third event');
select is(pg_temp.audit_count(pg_temp.id('r_main')), 2, 'G10. and no third Audit Log event');

-- A new exclusion AFTER a reinstatement is allowed — the cycle can repeat.
select is(pg_temp.classify(pg_temp.id('r_main'), 'EXCLUDE', 'NON_QUALIFYING', 'reconsidered'), 'EXCLUDED',
  'G11. a NEW exclusion after a reinstatement is allowed');
select is(pg_temp.state(pg_temp.id('r_main')), 'QUALIFICATION_EXCLUDED',
  'G12. and takes effect');
select is(pg_temp.event_count(pg_temp.id('r_main')), 3, 'G13. three immutable events now exist');

-- THE STALE-PAGE GUARANTEE. A caller holding the FIRST exclusion's id cannot use it:
-- the browser never supplies one, and reversing it directly is refused because it is
-- already reversed. The unique index is the authority, not the caller's good behaviour.
select throws_ok(
  format(
    $$ insert into public.receipt_qualification_events
         (receipt_submission_id, vendor_organization_id, event_type,
          reverses_event_id, classified_by_profile_id)
       values (%L, %L, 'REINSTATED', %L, %L) $$,
    (select v from pg_temp.f where k='r_main'),
    (select v from pg_temp.f where k='vendor_a'),
    (select id from public.receipt_qualification_events
      where receipt_submission_id = (select v from pg_temp.f where k='r_main')
        and event_type = 'EXCLUDED' order by classified_at asc limit 1),
    (select v from pg_temp.f where k='reviewer')),
  '23505', null,
  'G14. an already-reversed exclusion cannot be reversed twice — the unique index refuses it');

-- And a reversal cannot be aimed at another receipt or another Vendor.
select throws_ok(
  format(
    $$ insert into public.receipt_qualification_events
         (receipt_submission_id, vendor_organization_id, event_type,
          reverses_event_id, classified_by_profile_id)
       values (%L, %L, 'REINSTATED', %L, %L) $$,
    (select v from pg_temp.f where k='r_second'),
    (select v from pg_temp.f where k='vendor_a'),
    (select id from public.receipt_qualification_events
      where receipt_submission_id = (select v from pg_temp.f where k='r_main')
        and event_type = 'EXCLUDED' order by classified_at desc limit 1),
    (select v from pg_temp.f where k='reviewer')),
  '23514', null,
  'G15. a reversal cannot target an exclusion belonging to a different receipt');

-- Only ever ONE active exclusion per receipt, whatever the event history.
select is(
  (select count(*)::integer from public.receipt_qualification_events x
    where x.receipt_submission_id = pg_temp.id('r_main')
      and x.event_type = 'EXCLUDED'
      and not exists (select 1 from public.receipt_qualification_events rv
                      where rv.reverses_event_id = x.id)),
  1,
  'G16. after exclude -> reinstate -> exclude there is exactly ONE active exclusion'
);


-- ============================================================================
-- SECTION H — the fail-closed contract future phases must use
-- ============================================================================
select has_function('public', 'receipt_qualification_is_excluded', array['uuid'],
  'H1. the internal fail-closed helper exists');

select ok(
  (select prosecdef from pg_proc where pronamespace='public'::regnamespace
    and proname='receipt_qualification_is_excluded'),
  'H2. it is SECURITY DEFINER'
);
select ok(
  (select 'search_path=""' = any(proconfig) from pg_proc
    where pronamespace='public'::regnamespace and proname='receipt_qualification_is_excluded'),
  'H3. with an empty search_path'
);

select ok(public.receipt_qualification_is_excluded(pg_temp.id('r_main')),
  'H4. it reports TRUE for a receipt with an active exclusion');
select ok(not public.receipt_qualification_is_excluded(pg_temp.id('r_undecided')),
  'H5. and FALSE for a receipt with no events at all');

-- The whole point: it tracks the EVENT history, not a status column.
select is(pg_temp.classify(pg_temp.id('r_main'), 'REINSTATE'), 'REINSTATED',
  'H6. reversing the active exclusion...');
select ok(not public.receipt_qualification_is_excluded(pg_temp.id('r_main')),
  'H7. ...flips the fail-closed helper back to FALSE');


-- ============================================================================
-- SECTION I — the read function's browser-safe shape
-- ============================================================================
select is(
  (select string_agg(n, ',' order by ord)
   from pg_proc p, unnest(p.proargnames) with ordinality as a(n, ord)
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'get_claim_receipt_qualification'
     and n <> 'p_submission_id'),
  'receipt_submission_id,qualification_state,exclusion_reason,reviewer_note,classified_at,classified_by_display_name,can_reinstate',
  'I1. the read function returns exactly the seven approved columns, in order'
);

select is(
  (select count(*)::integer from pg_proc p, unnest(p.proargnames) n
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'get_claim_receipt_qualification'
     and n in ('vendor_organization_id','retailer_organization_id','retailer_shop_id',
               'classified_by_profile_id','reverses_event_id','id','event_id',
               'storage_bucket','storage_object_path','file_sha256','email','phone')),
  0,
  'I2. and no Vendor, Retailer, shop, profile, event id, bucket, path, hash, email or phone'
);

select is(
  (select p.pronargs::integer from pg_proc p
    where p.pronamespace='public'::regnamespace and p.proname='get_claim_receipt_qualification'),
  1,
  'I3. it takes exactly one argument — there is no Vendor to supply'
);

select is(
  (select p.pronargs::integer from pg_proc p
    where p.pronamespace='public'::regnamespace and p.proname='record_claim_receipt_qualification'),
  4,
  'I4. the write function takes exactly four — no actor, event id or timestamp'
);

select is(
  (select string_agg(n, ',' order by ord)
   from pg_proc p, unnest(p.proargnames) with ordinality as a(n, ord)
   where p.pronamespace='public'::regnamespace
     and p.proname='record_claim_receipt_qualification'
     and n like 'p\_%'),
  'p_submission_id,p_action,p_exclusion_reason,p_reviewer_note',
  'I5. and they are exactly the four approved inputs'
);

select ok(
  (select prosecdef from pg_proc where pronamespace='public'::regnamespace
    and proname='record_claim_receipt_qualification'),
  'I6. the write function is SECURITY DEFINER'
);
select ok(
  (select 'search_path=""' = any(proconfig) from pg_proc
    where pronamespace='public'::regnamespace and proname='record_claim_receipt_qualification'),
  'I7. with an empty search_path'
);
select ok(
  (select not (prosrc ~* '\mexecute\M') from pg_proc
    where pronamespace='public'::regnamespace and proname='record_claim_receipt_qualification'),
  'I8. and no dynamic SQL'
);


-- ============================================================================
-- SECTION J — nothing else moved
-- ============================================================================
select is(
  (select decision from public.receipt_review_decisions
    where receipt_submission_id = pg_temp.id('r_main')),
  'VERIFIED',
  'J1. THE HEADLINE: the review decision is still VERIFIED after all of the above'
);

select is(
  (select count(*)::integer from public.receipt_review_decisions
    where receipt_submission_id = pg_temp.id('r_main')),
  1,
  'J2. and there is still exactly one decision for it'
);

select is(
  (select status from public.receipt_submissions where id = pg_temp.id('r_main')),
  'SUBMITTED',
  'J3. the receipt row itself is unchanged'
);

select is(
  (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
    where t.tgrelid = 'public.receipt_review_decisions'::regclass and not t.tgisinternal),
  'receipt_review_decisions_assert_tenant,receipt_review_decisions_guard_change,receipt_review_decisions_guard_truncate',
  'J4. the decision table keeps its own immutability guards'
);

select is(
  (select count(*)::integer from public.receipt_confirmations),
  0,
  'J5. no receipt confirmation was created'
);
select is(
  (select count(*)::integer from public.receipt_extractions),
  0,
  'J6. no extraction was created'
);
select is(
  (select mode from public.receipt_extraction_runtime),
  'DISABLED',
  'J7. extraction is still DISABLED'
);

-- SUPERSEDED BY PHASE 1D-A, which created public.verified_sales deliberately.
-- What THIS suite owns is that the qualification milestone created no reward
-- machinery, and that Phase 1D-A did not smuggle in a product line either — so the
-- successor still forbids every one of those, and pins the sale surface to exactly
-- the one approved header table.
select is(
  (select coalesce(string_agg(table_name, ','), 'NONE')::text
   from information_schema.tables
   where table_schema = 'public'
     and (table_name ilike '%reward%' or table_name ilike '%coin%'
          or table_name ilike '%ledger%' or table_name ilike '%wallet%'
          or table_name ilike '%balance%' or table_name ilike '%payout%'
          or table_name ilike '%campaign_qualification%')),
  'NONE',
  -- The sale-ITEM table is no longer forbidden: Phase 1D-B created
  -- public.verified_sale_items by approval, and J8b pins the sale surface exactly.
  'J8. no reward, coin, ledger, wallet, balance, payout or campaign-qualification table was created'
);

select is(
  (select coalesce(string_agg(table_name, ',' order by table_name), 'NONE')::text
   from information_schema.tables
   where table_schema = 'public' and table_name ilike '%verified_sale%'),
  'verified_sale_items,verified_sales',
  'J8b. and the only sale objects are the two approved tables'
);

select is(
  (select count(*)::integer from public.receipt_qualification_events x
    where not exists (select 1 from public.receipt_submissions s where s.id = x.receipt_submission_id)),
  0,
  'J9. every event still points at a real receipt'
);

select pg_temp.sign_out();

select * from finish();
rollback;
