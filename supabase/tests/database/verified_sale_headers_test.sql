-- Tests for Phase 1D-A: the authoritative, immutable verified sale header.
--
-- Run with:  supabase test db
--
-- ============================================================================
-- WHAT THIS SUITE IS ACTUALLY PROTECTING
-- ============================================================================
-- Three properties matter more than the rest, and everything else exists to
-- support them:
--
--   1. A sale is a CLAIM REVIEWER's finding, copied verbatim from an immutable
--      SALES STAFF proposal. Nobody can assert a financial figure through the
--      RPC, because the RPC has no parameter for one (Section G).
--
--   2. A receipt with an active qualification exclusion can NEVER become a sale.
--      That is the Phase 1D-0 promise, enforced here for the first time
--      (Section F). The hosted TEST_DATA screenshot is the reason it exists.
--
--   3. The sale instant is resolved ONCE and frozen. A later timezone correction
--      must not move a sale that already happened, and an ambiguous local time
--      must never be resolved by silent default (Sections D and H).
--
-- Everything runs inside one transaction and is rolled back. Every fixture is
-- synthetic; the six real hosted receipts, the one real decision and the one real
-- TEST_DATA exclusion are never touched, and this suite runs only locally.
--
-- pgTAP RUNS IN ONE TRANSACTION AND THEREFORE CANNOT PROVE A GENUINE RACE.
-- Section K states what is and is not proven here; the true two-session races are
-- run separately against a disposable database and reported with the milestone.

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

create table pg_temp.f (k text primary key, v uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select v from pg_temp.f where k = p
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

create function pg_temp.new_org(p_name text, p_type text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.organizations (name, organization_type, status, country_code, default_currency)
  values (p_name, p_type, 'ACTIVE', 'AE', 'AED') returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.add_member(p_user uuid, p_org uuid, p_role text, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_m uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, p_status, now() - interval '30 days') returning id into v_m;
  insert into public.member_roles (organization_member_id, role_id)
  select v_m, r.id from public.roles r where r.code = p_role on conflict do nothing;
  return v_m;
end;
$$;

/* One classification call, returning just the outcome. */
create function pg_temp.finalize(p_receipt uuid, p_choice text default null)
returns text language sql volatile as $$
  select r.outcome from public.finalize_claim_receipt_sale_header(p_receipt, p_choice) r
$$;

/* Same, but converting a refusal into a readable token so a test can assert it. */
create function pg_temp.try_finalize(p_receipt uuid, p_choice text default null)
returns text language plpgsql as $$
begin
  return pg_temp.finalize(p_receipt, p_choice);
exception when others then
  return 'REFUSED:' || sqlstate;
end;
$$;

create function pg_temp.try_sql(s text) returns text language plpgsql as $$
begin execute s; return 'ALLOWED';
exception when others then return 'REFUSED:' || sqlstate; end;
$$;

create function pg_temp.sale_count(p_receipt uuid) returns integer
language sql stable as $$
  select count(*)::integer from public.verified_sales where receipt_submission_id = p_receipt
$$;

create function pg_temp.audit_count(p_receipt uuid) returns integer
language sql stable as $$
  select count(*)::integer from public.audit_logs
  where entity_id = p_receipt::text and action = 'SALE_HEADER_FINALIZED'
$$;

/* Records a review decision directly, so the fixture does not depend on who
   happens to be impersonated at setup time. */
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

/* The staff proposal. confirmed_by MUST be the receipt's submitter — the deployed
   receipt_confirmations tenant assertion requires exactly that. */
create function pg_temp.propose(
  p_receipt uuid, p_date date, p_time time without time zone default null,
  p_total bigint default 12345, p_currency text default 'AED',
  p_merchant text default 'Test Merchant', p_doc text default 'DOC-1'
) returns void language plpgsql as $$
declare s public.receipt_submissions%rowtype;
begin
  select * into s from public.receipt_submissions where id = p_receipt;
  insert into public.receipt_confirmations (
    receipt_submission_id, retailer_organization_id, retailer_shop_id,
    confirmed_by_profile_id, entry_mode, changed_fields,
    transaction_date, transaction_time, currency_code, total_minor,
    subtotal_minor, tax_total_minor, merchant_name, document_number
  ) values (
    p_receipt, s.retailer_organization_id, s.retailer_shop_id,
    s.submitted_by_profile_id, 'MANUAL', '{}',
    p_date, p_time, p_currency, p_total, 10000, 2345, p_merchant, p_doc
  );
end;
$$;

create function pg_temp.new_receipt(p_retailer uuid, p_shop uuid, p_submitter uuid)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid(); v_path text;
begin
  v_path := 'vs/' || v_id::text || '.png';
  insert into public.receipt_submissions (
    id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
    storage_bucket, storage_object_path, original_file_name, mime_type,
    file_size_bytes, file_sha256, status, submitted_at
  ) values (
    v_id, p_retailer, p_shop, p_submitter, 'receipts', v_path, 'r.png', 'image/png',
    1000, encode(gen_random_bytes(32), 'hex'), 'SUBMITTED', now() - interval '1 day'
  );
  insert into storage.objects (bucket_id, name, owner) values ('receipts', v_path, null);
  return v_id;
end;
$$;

do $$
declare v_m uuid; t record;
begin
  insert into pg_temp.f values
    ('vendor_a',   pg_temp.new_org('VS Vendor A', 'VENDOR')),
    ('vendor_b',   pg_temp.new_org('VS Vendor B', 'VENDOR')),
    ('retailer_a', pg_temp.new_org('VS Retailer A', 'RETAILER')),
    ('retailer_b', pg_temp.new_org('VS Retailer B', 'RETAILER')),
    ('retailer_x', pg_temp.new_org('VS Retailer X', 'RETAILER'));

  -- People. rev/rev2 belong to Vendor A only; revfar belongs to Vendor B only,
  -- because resolve_claim_reviewer_organization deliberately fails closed for an
  -- actor who qualifies in more than one Vendor.
  insert into pg_temp.f values
    ('rev',        pg_temp.new_person('VS','Rev')),
    ('rev2',       pg_temp.new_person('VS','Rev2')),
    ('revfar',     pg_temp.new_person('VS','RevFar')),
    ('rev_off',    pg_temp.new_person('VS','RevOff')),
    ('vsa',        pg_temp.new_person('VS','Admin')),
    ('finance',    pg_temp.new_person('VS','Finance')),
    ('owner',      pg_temp.new_person('VS','Owner')),
    ('manager',    pg_temp.new_person('VS','Manager')),
    ('staff',      pg_temp.new_person('VS','Staff')),
    ('staff_gone', pg_temp.new_person('VS','Gone'));

  v_m := pg_temp.add_member(pg_temp.id('rev'),     pg_temp.id('vendor_a'), 'CLAIM_REVIEWER');
  v_m := pg_temp.add_member(pg_temp.id('rev2'),    pg_temp.id('vendor_a'), 'CLAIM_REVIEWER');
  v_m := pg_temp.add_member(pg_temp.id('revfar'),  pg_temp.id('vendor_b'), 'CLAIM_REVIEWER');
  v_m := pg_temp.add_member(pg_temp.id('rev_off'), pg_temp.id('vendor_a'), 'CLAIM_REVIEWER', 'DEACTIVATED');
  v_m := pg_temp.add_member(pg_temp.id('vsa'),     pg_temp.id('vendor_a'), 'VENDOR_SUPER_ADMIN');
  v_m := pg_temp.add_member(pg_temp.id('finance'), pg_temp.id('vendor_a'), 'FINANCE_ADMIN');
  v_m := pg_temp.add_member(pg_temp.id('owner'),   pg_temp.id('retailer_a'), 'RETAILER_OWNER');
  v_m := pg_temp.add_member(pg_temp.id('manager'), pg_temp.id('retailer_a'), 'RETAILER_MANAGER');
  v_m := pg_temp.add_member(pg_temp.id('staff'),   pg_temp.id('retailer_a'), 'SALES_STAFF');
  v_m := pg_temp.add_member(pg_temp.id('staff_gone'), pg_temp.id('retailer_a'), 'SALES_STAFF', 'DEACTIVATED');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (pg_temp.id('vendor_a'), pg_temp.id('retailer_a'), 'ACTIVE'),
         (pg_temp.id('vendor_b'), pg_temp.id('retailer_b'), 'ACTIVE'),
         -- Retailer X starts ACTIVE so its receipt can be decided at all; the link
         -- is ended further down, which is the realistic shape anyway.
         (pg_temp.id('vendor_a'), pg_temp.id('retailer_x'), 'ACTIVE');

  for t in select * from (values
      ('shop_dxb','retailer_a','VS Dubai','VSD','ACTIVE','Asia/Dubai'),
      ('shop_ny','retailer_a','VS NewYork','VSN','ACTIVE','America/New_York'),
      ('shop_lh','retailer_a','VS LordHowe','VSL','ACTIVE','Australia/Lord_Howe'),
      ('shop_notz','retailer_a','VS NoZone','VSZ','ACTIVE',null),
      ('shop_gone','retailer_a','VS Closed','VSC','DEACTIVATED','Asia/Dubai'),
      ('shop_b','retailer_b','VS ShopB','VSB','ACTIVE','Asia/Dubai'),
      ('shop_x','retailer_x','VS ShopX','VSX','ACTIVE','Asia/Dubai')
    ) x(k,org,nm,cd,st,tz) loop
    insert into public.retailer_shops (retailer_organization_id,name,code,status,timezone_name)
    values (pg_temp.id(t.org), t.nm, t.cd, t.st, t.tz) returning id into v_m;
    insert into pg_temp.f values (t.k, v_m);
  end loop;
end;
$$;

do $$
declare t record; v uuid;
begin
  for t in select * from (values
      ('r_main','retailer_a','shop_dxb','staff'),
      ('r_ny_amb','retailer_a','shop_ny','staff'),
      ('r_ny_amb2','retailer_a','shop_ny','staff'),
      ('r_ny_bad','retailer_a','shop_ny','staff'),
      ('r_lh_amb','retailer_a','shop_lh','staff'),
      ('r_dateonly','retailer_a','shop_dxb','staff'),
      ('r_excluded','retailer_a','shop_dxb','staff'),
      ('r_noconf','retailer_a','shop_dxb','staff'),
      ('r_rejected','retailer_a','shop_dxb','staff'),
      ('r_undecided','retailer_a','shop_dxb','staff'),
      ('r_notz','retailer_a','shop_notz','staff'),
      ('r_oldshop','retailer_a','shop_gone','staff_gone'),
      ('r_foreign','retailer_b','shop_b','staff'),
      ('r_deadlink','retailer_x','shop_x','staff'),
      ('r_tzmove','retailer_a','shop_dxb','staff'),
      ('r_race','retailer_a','shop_dxb','staff')
    ) x(k,org,shop,who) loop
    v := pg_temp.new_receipt(pg_temp.id(t.org), pg_temp.id(t.shop), pg_temp.id(t.who));
    insert into pg_temp.f values (t.k, v);
  end loop;

  -- Decisions
  perform pg_temp.decide(pg_temp.id('r_main'),      pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_ny_amb'),    pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_ny_amb2'),   pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_ny_bad'),    pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_lh_amb'),    pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_dateonly'),  pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_excluded'),  pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_noconf'),    pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_rejected'),  pg_temp.id('vendor_a'), pg_temp.id('rev'), 'REJECTED');
  perform pg_temp.decide(pg_temp.id('r_notz'),      pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_oldshop'),   pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_foreign'),   pg_temp.id('vendor_b'), pg_temp.id('revfar'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_deadlink'),  pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_tzmove'),    pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');
  perform pg_temp.decide(pg_temp.id('r_race'),      pg_temp.id('vendor_a'), pg_temp.id('rev'), 'VERIFIED');

  -- Staff proposals. Asia/Dubai has no DST at all, so those are always OK.
  perform pg_temp.propose(pg_temp.id('r_main'),     date '2026-06-15', time '14:30');
  perform pg_temp.propose(pg_temp.id('r_ny_amb'),   date '2026-11-01', time '01:30');
  perform pg_temp.propose(pg_temp.id('r_ny_amb2'),  date '2026-11-01', time '01:30');
  perform pg_temp.propose(pg_temp.id('r_ny_bad'),   date '2026-03-08', time '02:30');
  perform pg_temp.propose(pg_temp.id('r_lh_amb'),   date '2026-04-05', time '01:45');
  perform pg_temp.propose(pg_temp.id('r_dateonly'), date '2026-06-15', null);
  perform pg_temp.propose(pg_temp.id('r_excluded'), date '2026-06-15', time '10:00');
  perform pg_temp.propose(pg_temp.id('r_rejected'), date '2026-06-15', time '10:00');
  perform pg_temp.propose(pg_temp.id('r_notz'),     date '2026-06-15', time '10:00');
  perform pg_temp.propose(pg_temp.id('r_oldshop'),  date '2026-06-15', time '10:00');
  perform pg_temp.propose(pg_temp.id('r_foreign'),  date '2026-06-15', time '10:00');
  perform pg_temp.propose(pg_temp.id('r_deadlink'), date '2026-06-15', time '10:00');
  perform pg_temp.propose(pg_temp.id('r_tzmove'),   date '2026-06-15', time '14:30');
  perform pg_temp.propose(pg_temp.id('r_race'),     date '2026-06-15', time '14:30');
  -- r_undecided and r_noconf deliberately have no proposal / no decision.

  -- End the Vendor A <-> Retailer X relationship AFTER the decision exists.
  update public.vendor_retailers set status = 'DEACTIVATED'
  where vendor_organization_id = pg_temp.id('vendor_a')
    and retailer_organization_id = pg_temp.id('retailer_x');
end;
$$;

-- An active qualification exclusion on r_excluded, written through the deployed
-- Phase 1D-0 RPC so the fixture exercises the real contract rather than a
-- hand-made row.
select pg_temp.act_as(pg_temp.id('rev'));
select is(
  (select outcome from public.record_claim_receipt_qualification(
     pg_temp.id('r_excluded'), 'EXCLUDE', 'TEST_DATA', null)),
  'EXCLUDED',
  'FIXTURE. the exclusion used by the fail-closed tests was recorded by the real Phase 1D-0 RPC'
);
select pg_temp.sign_out();


-- ============================================================================
-- SECTION A — the permission
-- ============================================================================
select is(
  (select count(*)::integer from public.permissions
    where code = 'RECEIPT_SALE_HEADER_FINALIZE' and module = 'CLAIM_REVIEW'),
  1, 'A1. RECEIPT_SALE_HEADER_FINALIZE exists exactly once, in the CLAIM_REVIEW module');

select is(
  (select string_agg(r.code, ',' order by r.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RECEIPT_SALE_HEADER_FINALIZE'),
  'CLAIM_REVIEWER', 'A2. and maps to CLAIM_REVIEWER and nothing else');

select is(
  (select string_agg(p.code, ',' order by p.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'CLAIM_REVIEWER'),
  -- Phase 1D-B adds RECEIPT_SALE_ITEMS_FINALIZE by approval.
  'CLAIM_REVIEW_PORTAL_READ,RECEIPT_QUALIFICATION_CLASSIFY,RECEIPT_REVIEW_DECIDE,RECEIPT_REVIEW_READ,RECEIPT_SALE_HEADER_FINALIZE,RECEIPT_SALE_ITEMS_FINALIZE',
  'A3. CLAIM_REVIEWER now holds exactly its six approved permissions');

select is(
  (select count(*)::integer from public.permissions
    where code ~ '(REWARD|COIN|BALANCE|PAYOUT|LEDGER)'),
  0, 'A4. no reward, coin, balance, payout or ledger permission was added');

select is(
  (select count(*)::integer from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RECEIPT_SALE_HEADER_FINALIZE'
     and r.code <> 'CLAIM_REVIEWER'),
  0, 'A5. and no other role received it');

select is(
  (select string_agg(r.code, ',' order by r.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RECEIPT_EXTRACTION_REVIEW'),
  'SALES_STAFF',
  'A6. and the staff proposal permission still belongs to SALES_STAFF alone');


-- ============================================================================
-- SECTION B — the table
-- ============================================================================
select has_table('public', 'verified_sales', 'B1. verified_sales exists');

select is(
  (select string_agg(column_name, ',' order by ordinal_position)
   from information_schema.columns
   where table_schema='public' and table_name='verified_sales'),
  'id,receipt_submission_id,receipt_review_decision_id,receipt_confirmation_id,'
  || 'vendor_organization_id,retailer_organization_id,retailer_shop_id,finalized_by_profile_id,'
  || 'transaction_date,transaction_time,sale_at,timezone_name,sale_time_precision,'
  || 'dst_ambiguity_choice,currency_code,total_minor,subtotal_minor,tax_total_minor,'
  || 'merchant_name,document_number,finalized_at,created_at',
  'B2. with exactly the approved columns, in order');

select is(
  (select count(*)::integer from information_schema.columns
   where table_schema='public' and table_name='verified_sales'
     and column_name ~ '(product|quantity|campaign|reward|coin|balance|payout|status|entry_mode|changed_fields|source_extraction|offset|tzdata|algorithm)'),
  0, 'B3. and no product, campaign, reward, coin, mutable-status or duplicate-time column');

select is(
  (select count(*)::integer
   from information_schema.table_constraints tc
   join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
   where tc.table_name='verified_sales' and tc.constraint_type='FOREIGN KEY'
     and rc.delete_rule <> 'RESTRICT'),
  0, 'B4. every foreign key uses ON DELETE RESTRICT');

select is(
  (select count(*)::integer
   from information_schema.table_constraints tc
   where tc.table_name='verified_sales' and tc.constraint_type='FOREIGN KEY'),
  8, 'B5. and there are exactly eight of them');

select ok(
  (select relrowsecurity from pg_class where oid='public.verified_sales'::regclass),
  'B6. RLS is enabled');

select is(
  (select count(*)::integer from pg_policy where polrelid='public.verified_sales'::regclass),
  0, 'B7. with ZERO direct policies');

select ok(not has_table_privilege('authenticated','public.verified_sales','SELECT'),
  'B8. authenticated cannot read the table directly');
select ok(not has_table_privilege('authenticated','public.verified_sales','INSERT'),
  'B9. nor insert into it');
select ok(not has_table_privilege('anon','public.verified_sales','SELECT'),
  'B10. anon cannot read it');
select ok(not has_table_privilege('service_role','public.verified_sales','TRUNCATE'),
  'B11. service_role cannot truncate it');

select is(
  (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
    where t.tgrelid='public.verified_sales'::regclass and not t.tgisinternal),
  'verified_sales_assert_lineage,verified_sales_guard_change,verified_sales_guard_truncate',
  'B12. and exactly three guards: lineage assertion, change guard, truncate guard');


-- ============================================================================
-- SECTION C — constraints
-- ============================================================================
select ok(
  (select pg_get_constraintdef(oid) ~ 'DATE_ONLY' and pg_get_constraintdef(oid) ~ 'MINUTE'
   from pg_constraint where conrelid='public.verified_sales'::regclass
     and conname='verified_sales_precision_allowed'),
  'C1. the precision vocabulary is exactly DATE_ONLY / MINUTE');

select is(
  (select count(*)::integer from pg_constraint
   where conrelid='public.verified_sales'::regclass
     and pg_get_constraintdef(oid) ilike '%DATE_TIME%'),
  0, 'C2. and DATE_TIME was not introduced');

select ok(
  (select pg_get_constraintdef(oid) ~ 'FIRST' and pg_get_constraintdef(oid) ~ 'SECOND'
   from pg_constraint where conrelid='public.verified_sales'::regclass
     and conname='verified_sales_dst_choice_allowed'),
  'C3. the DST choice vocabulary is exactly FIRST / SECOND');

select is(
  (select count(*)::integer from pg_constraint
   where conrelid='public.verified_sales'::regclass and contype='c'
     and conname in ('verified_sales_total_range','verified_sales_subtotal_range',
                     'verified_sales_tax_range','verified_sales_merchant_name_shape',
                     'verified_sales_document_number_shape',
                     'verified_sales_transaction_date_floor',
                     'verified_sales_transaction_time_minute')),
  7, 'C4. money, text, date and time constraints mirroring receipt_confirmations all exist');

-- The money and text bounds must be IDENTICAL to the proposal's, so a value that
-- table accepted can never be one this table refuses.
select is(
  (select replace(pg_get_constraintdef(oid), 'verified_sales', 'receipt_confirmations')
   from pg_constraint where conrelid='public.verified_sales'::regclass
     and conname='verified_sales_total_range'),
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid='public.receipt_confirmations'::regclass
     and conname='receipt_confirmations_total_range'),
  'C5. the total bound is identical to receipt_confirmations');

select is(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid='public.verified_sales'::regclass and conname='verified_sales_merchant_name_shape'),
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid='public.receipt_confirmations'::regclass
     and conname='receipt_confirmations_merchant_name_shape'),
  'C6. the merchant-name shape is identical to receipt_confirmations');

select is(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid='public.verified_sales'::regclass and conname='verified_sales_document_number_shape'),
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid='public.receipt_confirmations'::regclass
     and conname='receipt_confirmations_document_number_shape'),
  'C7. the document-number shape is identical to receipt_confirmations');

select is(
  (select count(*)::integer from pg_constraint
   where conrelid='public.verified_sales'::regclass
     and pg_get_constraintdef(oid) ilike '%subtotal_minor + tax%'),
  0, 'C8. and subtotal + tax = total is deliberately NOT required');

select is(
  (select count(*)::integer from pg_indexes
   where schemaname='public' and tablename='verified_sales' and indexdef ilike '%UNIQUE%'),
  4, 'C9. four unique indexes exist: primary key plus receipt, decision and confirmation lineage');


-- ============================================================================
-- SECTION D — time inspection and the four-argument resolver
-- ============================================================================
select has_function('public','inspect_sale_instant',
  array['uuid','date','time without time zone'], 'D1. the internal inspector exists');
select ok(not has_function_privilege('authenticated',
  'public.inspect_sale_instant(uuid,date,time without time zone)','EXECUTE'),
  'D2. and is not callable by authenticated');
select ok(not has_function_privilege('anon',
  'public.inspect_sale_instant(uuid,date,time without time zone)','EXECUTE'),
  'D3. nor by anon');

select has_function('public','resolve_sale_instant',
  array['uuid','date','time without time zone'], 'D4. the EXISTING three-argument resolver still exists');
select has_function('public','resolve_sale_instant',
  array['uuid','date','time without time zone','text'], 'D5. and the four-argument overload was added');
select ok(not has_function_privilege('authenticated',
  'public.resolve_sale_instant(uuid,date,time without time zone,text)','EXECUTE'),
  'D6. the overload is not callable by authenticated');

-- The Phase 0 contract, unchanged.
select is(
  (select sale_time_precision from public.resolve_sale_instant(
     pg_temp.id('shop_dxb'), date '2026-06-15')),
  'DATE_ONLY', 'D7. three-argument date-only behaviour is unchanged');
select is(
  (select sale_at from public.resolve_sale_instant(
     pg_temp.id('shop_dxb'), date '2026-06-15')),
  timestamptz '2026-06-15 08:00:00+00', 'D8. and still resolves to local noon');
select is(
  (select sale_time_precision from public.resolve_sale_instant(
     pg_temp.id('shop_dxb'), date '2026-06-15', time '14:30')),
  'MINUTE', 'D9. three-argument minute behaviour is unchanged');
select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-03-08', time '02:30') $$,
         pg_temp.id('shop_ny')),
  '22007', null, 'D10. three-argument nonexistent refusal is unchanged');
select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-11-01', time '01:30') $$,
         pg_temp.id('shop_ny')),
  '22023', null, 'D11. three-argument ambiguous refusal is unchanged');

-- The overload.
select is(
  (select sale_time_precision from public.resolve_sale_instant(
     pg_temp.id('shop_dxb'), date '2026-06-15', null, null)),
  'DATE_ONLY', 'D12. date-only through the overload returns DATE_ONLY');
select is(
  (select sale_at from public.resolve_sale_instant(
     pg_temp.id('shop_dxb'), date '2026-06-15', null, null)),
  timestamptz '2026-06-15 08:00:00+00', 'D13. and resolves to local noon');
select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-06-15', null, 'FIRST') $$,
         pg_temp.id('shop_dxb')),
  '22023', null, 'D14. date-only rejects FIRST');
select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-06-15', null, 'SECOND') $$,
         pg_temp.id('shop_dxb')),
  '22023', null, 'D15. date-only rejects SECOND');

select is(
  (select sale_at from public.resolve_sale_instant(
     pg_temp.id('shop_dxb'), date '2026-06-15', time '14:30', null)),
  timestamptz '2026-06-15 10:30:00+00', 'D16. an unambiguous minute resolves correctly');
select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-06-15', time '14:30', 'FIRST') $$,
         pg_temp.id('shop_dxb')),
  '22023', null, 'D17. an unambiguous minute rejects an unnecessary FIRST');
select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-06-15', time '14:30', 'SECOND') $$,
         pg_temp.id('shop_dxb')),
  '22023', null, 'D18. and rejects an unnecessary SECOND');

select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-03-08', time '02:30', 'FIRST') $$,
         pg_temp.id('shop_ny')),
  '22007', null, 'D19. a nonexistent time is refused even WITH a choice');
select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-11-01', time '01:30', null) $$,
         pg_temp.id('shop_ny')),
  '22023', null, 'D20. an ambiguous time without a choice is refused');

-- THE HEADLINE DST PROOF. PostgreSQL's own default for this local time is the
-- LATER instant; nothing here may inherit that silently.
select is(
  (select sale_at from public.resolve_sale_instant(
     pg_temp.id('shop_ny'), date '2026-11-01', time '01:30', 'FIRST')),
  timestamptz '2026-11-01 05:30:00+00', 'D21. FIRST selects the EARLIER valid instant (EDT)');
select is(
  (select sale_at from public.resolve_sale_instant(
     pg_temp.id('shop_ny'), date '2026-11-01', time '01:30', 'SECOND')),
  timestamptz '2026-11-01 06:30:00+00', 'D22. SECOND selects the LATER valid instant (EST)');
select is(
  (select sale_at from public.resolve_sale_instant(pg_temp.id('shop_ny'), date '2026-11-01', time '01:30','SECOND'))
  - (select sale_at from public.resolve_sale_instant(pg_temp.id('shop_ny'), date '2026-11-01', time '01:30','FIRST')),
  interval '1 hour', 'D23. and they differ by exactly one hour in New York');

-- A 30-minute transition, which a naive one-hour-only probe would miss entirely.
select is(
  (select sale_at from public.resolve_sale_instant(pg_temp.id('shop_lh'), date '2026-04-05', time '01:45','SECOND'))
  - (select sale_at from public.resolve_sale_instant(pg_temp.id('shop_lh'), date '2026-04-05', time '01:45','FIRST')),
  interval '30 minutes', 'D24. Lord Howe ambiguity is handled and differs by exactly thirty minutes');

select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-06-15', time '10:00', 'THIRD') $$,
         pg_temp.id('shop_dxb')),
  '22023', null, 'D25. an invalid choice word is refused');
select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-06-15', time '10:00', null) $$,
         pg_temp.id('shop_notz')),
  '55000', null, 'D26. a shop with no time zone refuses with 55000');
select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-06-15', time '10:00', null) $$,
         gen_random_uuid()),
  '42501', null, 'D27. an unknown shop stays indistinguishable from a foreign one');


-- ============================================================================
-- SECTION E — who may finalize
-- ============================================================================
select ok(has_function_privilege('authenticated',
  'public.finalize_claim_receipt_sale_header(uuid,text)','EXECUTE'),
  'E1. authenticated may execute the finalization RPC');
select ok(not has_function_privilege('anon',
  'public.finalize_claim_receipt_sale_header(uuid,text)','EXECUTE'),
  'E2. anon may not');
select ok(not has_function_privilege('public',
  'public.finalize_claim_receipt_sale_header(uuid,text)','EXECUTE'),
  'E3. and neither may PUBLIC');

select pg_temp.act_as(pg_temp.id('vsa'));
select is(pg_temp.try_finalize(pg_temp.id('r_main')), 'REFUSED:42501',
  'E4. a Vendor Super Admin cannot finalize through that role alone');
select pg_temp.act_as(pg_temp.id('finance'));
select is(pg_temp.try_finalize(pg_temp.id('r_main')), 'REFUSED:42501',
  'E5. a Finance Admin cannot finalize');
select pg_temp.act_as(pg_temp.id('owner'));
select is(pg_temp.try_finalize(pg_temp.id('r_main')), 'REFUSED:42501',
  'E6. a Retailer Owner cannot finalize');
select pg_temp.act_as(pg_temp.id('manager'));
select is(pg_temp.try_finalize(pg_temp.id('r_main')), 'REFUSED:42501',
  'E7. a Retailer Manager cannot finalize');
select pg_temp.act_as(pg_temp.id('staff'));
select is(pg_temp.try_finalize(pg_temp.id('r_main')), 'REFUSED:42501',
  'E8. Sales Staff cannot finalize their own proposal');
select pg_temp.act_as(pg_temp.id('rev_off'));
select is(pg_temp.try_finalize(pg_temp.id('r_main')), 'REFUSED:42501',
  'E9. a DEACTIVATED reviewer membership cannot finalize');
select pg_temp.sign_out();
select is(pg_temp.try_finalize(pg_temp.id('r_main')), 'REFUSED:42501',
  'E10. a signed-out caller cannot finalize');

select is((select count(*)::integer from public.verified_sales), 0,
  'E11. and none of those refused attempts created a sale');


-- ============================================================================
-- SECTION F — eligibility gates, including the fail-closed exclusion
-- ============================================================================
select pg_temp.act_as(pg_temp.id('rev'));

select is(pg_temp.try_finalize(gen_random_uuid()), 'REFUSED:42501',
  'F1. a nonexistent receipt cannot be finalized');
select is(pg_temp.try_finalize(pg_temp.id('r_rejected')), 'REFUSED:42501',
  'F2. a REJECTED receipt cannot be finalized');
select is(pg_temp.try_finalize(pg_temp.id('r_undecided')), 'REFUSED:42501',
  'F3. a receipt with no review decision cannot be finalized');
select is(pg_temp.try_finalize(pg_temp.id('r_noconf')), 'REFUSED:42501',
  'F4. a receipt with no staff proposal cannot be finalized');
select is(pg_temp.try_finalize(pg_temp.id('r_foreign')), 'REFUSED:42501',
  'F5. another Vendor''s receipt cannot be finalized');
select is(pg_temp.try_finalize(pg_temp.id('r_deadlink')), 'REFUSED:42501',
  'F6. a DEACTIVATED vendor_retailers link blocks finalization');
select is(pg_temp.try_finalize(pg_temp.id('r_notz')), 'REFUSED:55000',
  'F7. a shop with no time zone refuses rather than assuming one');
select is(pg_temp.try_finalize(pg_temp.id('r_ny_bad')), 'REFUSED:22007',
  'F8. a nonexistent local sale time refuses');

-- THE HEADLINE. Phase 1D-0's promise, enforced.
select is(pg_temp.try_finalize(pg_temp.id('r_excluded')), 'REFUSED:42501',
  'F9. THE HEADLINE: an actively excluded (TEST_DATA) receipt can never become a sale');
select is(pg_temp.sale_count(pg_temp.id('r_excluded')), 0,
  'F10. and no sale row was created for it');
select is(pg_temp.audit_count(pg_temp.id('r_excluded')), 0,
  'F11. and no finalization Audit Log was written for it');
select ok(public.receipt_qualification_is_excluded(pg_temp.id('r_excluded')),
  'F12. the Phase 1D-0 fail-closed helper still reports it as excluded');

-- History stays finalizable.
select is(pg_temp.finalize(pg_temp.id('r_oldshop')), 'FINALIZED',
  'F13. a DEACTIVATED shop and a DEACTIVATED submitter do NOT block finalization');


-- ============================================================================
-- SECTION G — a successful finalization, and what it copies
-- ============================================================================
select is(pg_temp.finalize(pg_temp.id('r_main')), 'FINALIZED',
  'G1. a verified, confirmed, unexcluded receipt finalizes');
select is(pg_temp.sale_count(pg_temp.id('r_main')), 1, 'G2. exactly one sale exists');
select is(pg_temp.audit_count(pg_temp.id('r_main')), 1, 'G3. and exactly one Audit Log event');

select is(
  (select sale_time_precision from public.verified_sales where receipt_submission_id=pg_temp.id('r_main')),
  'MINUTE', 'G4. precision MINUTE is persisted');
select is(
  (select sale_at from public.verified_sales where receipt_submission_id=pg_temp.id('r_main')),
  timestamptz '2026-06-15 10:30:00+00', 'G5. and the resolved instant is stored');
select is(
  (select timezone_name from public.verified_sales where receipt_submission_id=pg_temp.id('r_main')),
  'Asia/Dubai', 'G6. with the zone that produced it');
select is(
  (select dst_ambiguity_choice from public.verified_sales where receipt_submission_id=pg_temp.id('r_main')),
  null, 'G7. and no DST choice, because the time was unambiguous');

-- EVERY figure equals the immutable proposal.
select is(
  (select (vs.transaction_date, vs.transaction_time, vs.currency_code, vs.total_minor,
           vs.subtotal_minor, vs.tax_total_minor, vs.merchant_name, vs.document_number)::text
   from public.verified_sales vs where vs.receipt_submission_id=pg_temp.id('r_main')),
  (select (rc.transaction_date, rc.transaction_time, rc.currency_code, rc.total_minor,
           rc.subtotal_minor, rc.tax_total_minor, rc.merchant_name, rc.document_number)::text
   from public.receipt_confirmations rc where rc.receipt_submission_id=pg_temp.id('r_main')),
  'G8. every transaction value equals the staff proposal exactly');

select is(
  (select vs.receipt_confirmation_id from public.verified_sales vs
    where vs.receipt_submission_id=pg_temp.id('r_main')),
  (select rc.id from public.receipt_confirmations rc where rc.receipt_submission_id=pg_temp.id('r_main')),
  'G9. and the sale names the proposal it came from');
select is(
  (select vs.receipt_review_decision_id from public.verified_sales vs
    where vs.receipt_submission_id=pg_temp.id('r_main')),
  (select rd.id from public.receipt_review_decisions rd where rd.receipt_submission_id=pg_temp.id('r_main')),
  'G10. and the decision it rests on');
select is(
  (select vs.finalized_by_profile_id from public.verified_sales vs
    where vs.receipt_submission_id=pg_temp.id('r_main')),
  pg_temp.id('rev'), 'G11. and the reviewer who finalized it');

-- The RPC takes two arguments, so no financial value can be asserted by a caller.
select is(
  (select p.pronargs::integer from pg_proc p
    where p.pronamespace='public'::regnamespace and p.proname='finalize_claim_receipt_sale_header'),
  2, 'G12. the finalization RPC takes exactly two arguments');
select is(
  (select string_agg(n, ',' order by ord)
   from pg_proc p, unnest(p.proargnames) with ordinality a(n, ord)
   where p.pronamespace='public'::regnamespace
     and p.proname='finalize_claim_receipt_sale_header' and n like 'p\_%'),
  'p_submission_id,p_dst_ambiguity_choice',
  'G13. and they are only the receipt and the daylight-saving judgement');
select ok(
  (select prosecdef from pg_proc where pronamespace='public'::regnamespace
    and proname='finalize_claim_receipt_sale_header'), 'G14. it is SECURITY DEFINER');
select ok(
  (select 'search_path=""' = any(proconfig) from pg_proc
    where pronamespace='public'::regnamespace and proname='finalize_claim_receipt_sale_header'),
  'G15. with an empty search_path');
select ok(
  (select not (prosrc ~* '\mexecute\M') from pg_proc
    where pronamespace='public'::regnamespace and proname='finalize_claim_receipt_sale_header'),
  'G16. and no dynamic SQL');


-- ============================================================================
-- SECTION H — date-only and daylight saving, end to end
-- ============================================================================
select is(pg_temp.finalize(pg_temp.id('r_dateonly')), 'FINALIZED',
  'H1. a date-only proposal finalizes');
select is(
  (select sale_time_precision from public.verified_sales where receipt_submission_id=pg_temp.id('r_dateonly')),
  'DATE_ONLY', 'H2. DATE_ONLY is persisted');
select is(
  (select sale_at from public.verified_sales where receipt_submission_id=pg_temp.id('r_dateonly')),
  timestamptz '2026-06-15 08:00:00+00', 'H3. and it resolves to local noon');
select is(
  (select dst_ambiguity_choice from public.verified_sales where receipt_submission_id=pg_temp.id('r_dateonly')),
  null, 'H4. with no DST choice');
select is(
  (select transaction_time from public.verified_sales where receipt_submission_id=pg_temp.id('r_dateonly')),
  null, 'H5. and no printed time');

select is(pg_temp.finalize(pg_temp.id('r_ny_amb')), 'AMBIGUOUS_TIME_REQUIRES_CHOICE',
  'H6. an ambiguous local time refuses to guess');
select is(pg_temp.sale_count(pg_temp.id('r_ny_amb')), 0, 'H7. and creates no sale');
select is(pg_temp.audit_count(pg_temp.id('r_ny_amb')), 0, 'H8. and no Audit Log');

select is(pg_temp.finalize(pg_temp.id('r_ny_amb'), 'FIRST'), 'FINALIZED',
  'H9. FIRST finalizes it');
select is(
  (select sale_at from public.verified_sales where receipt_submission_id=pg_temp.id('r_ny_amb')),
  timestamptz '2026-11-01 05:30:00+00', 'H10. at the EARLIER instant');
select is(
  (select dst_ambiguity_choice from public.verified_sales where receipt_submission_id=pg_temp.id('r_ny_amb')),
  'FIRST', 'H11. and the choice is persisted');

select is(pg_temp.finalize(pg_temp.id('r_ny_amb2'), 'SECOND'), 'FINALIZED',
  'H12. SECOND finalizes the twin receipt');
select is(
  (select sale_at from public.verified_sales where receipt_submission_id=pg_temp.id('r_ny_amb2')),
  timestamptz '2026-11-01 06:30:00+00', 'H13. at the LATER instant');
select is(
  (select dst_ambiguity_choice from public.verified_sales where receipt_submission_id=pg_temp.id('r_ny_amb2')),
  'SECOND', 'H14. and that choice is persisted too');

select is(pg_temp.finalize(pg_temp.id('r_lh_amb'), 'FIRST'), 'FINALIZED',
  'H15. a 30-minute Lord Howe ambiguity finalizes with FIRST');
select is(
  (select sale_at from public.verified_sales where receipt_submission_id=pg_temp.id('r_lh_amb')),
  timestamptz '2026-04-04 14:45:00+00', 'H16. at the earlier of the two half-hour candidates');

-- An unnecessary choice must be refused, not ignored.
select is(pg_temp.try_finalize(pg_temp.id('r_tzmove'), 'FIRST'), 'REFUSED:22023',
  'H17. an unnecessary DST choice on an unambiguous time is refused');
select is(pg_temp.sale_count(pg_temp.id('r_tzmove')), 0, 'H18. and creates no sale');

-- THE FREEZE. A later timezone correction must not move a sale that happened.
select is(pg_temp.finalize(pg_temp.id('r_tzmove')), 'FINALIZED',
  'H19. the same receipt finalizes without a choice');
select lives_ok(
  format($$ update public.retailer_shops set timezone_name = 'America/New_York' where id = %L $$,
         pg_temp.id('shop_dxb')),
  'H20. the shop time zone is then changed');
select is(
  (select timezone_name from public.verified_sales where receipt_submission_id=pg_temp.id('r_tzmove')),
  'Asia/Dubai', 'H21. the stored zone does NOT move');
select is(
  (select sale_at from public.verified_sales where receipt_submission_id=pg_temp.id('r_tzmove')),
  timestamptz '2026-06-15 10:30:00+00', 'H22. and neither does the stored instant');
select lives_ok(
  format($$ update public.retailer_shops set timezone_name = 'Asia/Dubai' where id = %L $$,
         pg_temp.id('shop_dxb')),
  'H23. (zone restored for the remaining tests)');


-- ============================================================================
-- SECTION I — immutability, idempotency and conflict
-- ============================================================================
select is(pg_temp.try_sql('update public.verified_sales set total_minor = 1'),
  'REFUSED:23514', 'I1. UPDATE is refused');
select is(pg_temp.try_sql('delete from public.verified_sales'),
  'REFUSED:23514', 'I2. DELETE is refused');
-- Phase 1D-B made verified_sales a foreign-key TARGET (verified_sale_items and
-- receipt_product_review_decisions both reference it), so PostgreSQL now refuses
-- TRUNCATE with 0A000 before the guard trigger can fire. The refusal is the
-- durable property; I3b pins the guard itself so it cannot be quietly dropped.
select matches(pg_temp.try_sql('truncate public.verified_sales'),
  '^REFUSED:', 'I3. TRUNCATE is refused');
select is(
  (select count(*)::integer from pg_trigger t
   where t.tgrelid = 'public.verified_sales'::regclass
     and t.tgname = 'verified_sales_guard_truncate' and not t.tgisinternal),
  1, 'I3b. and the TRUNCATE guard trigger is still installed');

select is(pg_temp.finalize(pg_temp.id('r_main')), 'ALREADY_FINALIZED',
  'I4. the same reviewer retrying gets ALREADY_FINALIZED');
select is(
  (select changed::text from public.finalize_claim_receipt_sale_header(pg_temp.id('r_main'), null)),
  'false', 'I5. and changed = false');
select is(pg_temp.sale_count(pg_temp.id('r_main')), 1, 'I6. with no second sale');
select is(pg_temp.audit_count(pg_temp.id('r_main')), 1, 'I7. and no second Audit Log');

select pg_temp.act_as(pg_temp.id('rev2'));
select is(pg_temp.finalize(pg_temp.id('r_main')), 'CONFLICT',
  'I8. a DIFFERENT reviewer gets CONFLICT, not ALREADY_FINALIZED');
select is(pg_temp.sale_count(pg_temp.id('r_main')), 1, 'I9. and still no second sale');
select is(pg_temp.audit_count(pg_temp.id('r_main')), 1, 'I10. and still no second Audit Log');
select pg_temp.act_as(pg_temp.id('rev'));

-- A stale interpretation of an instant that is already frozen is a conflict, not
-- a silent no-op.
select is(pg_temp.finalize(pg_temp.id('r_ny_amb'), 'SECOND'), 'CONFLICT',
  'I11. the original reviewer asserting the OTHER interpretation gets CONFLICT');
select is(
  (select dst_ambiguity_choice from public.verified_sales where receipt_submission_id=pg_temp.id('r_ny_amb')),
  'FIRST', 'I12. and the frozen choice is untouched');

-- Direct insertion cannot bypass the one-sale rule either.
-- A FAITHFUL duplicate: every value copied from the real proposal, so the only
-- thing wrong with this row is that the receipt already has a sale. Anything less
-- exact would be refused by an earlier assertion and would prove nothing about
-- the one-sale rule.
select is(
  pg_temp.try_sql(format(
    $$ insert into public.verified_sales (receipt_submission_id, receipt_review_decision_id,
         receipt_confirmation_id, vendor_organization_id, retailer_organization_id,
         retailer_shop_id, finalized_by_profile_id, transaction_date, transaction_time,
         sale_at, timezone_name, sale_time_precision, currency_code, total_minor,
         subtotal_minor, tax_total_minor, merchant_name, document_number)
       select %L, rd.id, rc.id, %L, %L, %L, %L, rc.transaction_date, rc.transaction_time,
              timestamptz '2026-06-15 10:30:00+00', 'Asia/Dubai', 'MINUTE', rc.currency_code,
              rc.total_minor, rc.subtotal_minor, rc.tax_total_minor, rc.merchant_name,
              rc.document_number
       from public.receipt_review_decisions rd, public.receipt_confirmations rc
       where rd.receipt_submission_id = %L and rc.receipt_submission_id = %L $$,
    pg_temp.id('r_main'), pg_temp.id('vendor_a'), pg_temp.id('retailer_a'),
    pg_temp.id('shop_dxb'), pg_temp.id('rev'), pg_temp.id('r_main'), pg_temp.id('r_main'))),
  'REFUSED:23505', 'I13. a second sale for the same receipt is refused as a duplicate');


-- ============================================================================
-- SECTION J — the insert assertion refuses what the RPC would never send
-- ============================================================================
-- These bypass the RPC entirely, which is the point: the table must not trust a
-- future writer that does not exist yet.
select is(
  pg_temp.try_sql(format(
    $$ insert into public.verified_sales (receipt_submission_id, receipt_review_decision_id,
         receipt_confirmation_id, vendor_organization_id, retailer_organization_id,
         retailer_shop_id, finalized_by_profile_id, transaction_date, transaction_time,
         sale_at, timezone_name, sale_time_precision, currency_code, total_minor)
       select %L, rd.id, rc.id, %L, %L, %L, %L, rc.transaction_date, rc.transaction_time,
              timestamptz '2026-06-15 10:30:00+00', 'Asia/Dubai', 'MINUTE', rc.currency_code,
              rc.total_minor + 1
       from public.receipt_review_decisions rd, public.receipt_confirmations rc
       where rd.receipt_submission_id = %L and rc.receipt_submission_id = %L $$,
    pg_temp.id('r_race'), pg_temp.id('vendor_a'), pg_temp.id('retailer_a'),
    pg_temp.id('shop_dxb'), pg_temp.id('rev'), pg_temp.id('r_race'), pg_temp.id('r_race'))),
  'REFUSED:23514', 'J1. an invented total is refused — the sale must copy the proposal');

select is(
  pg_temp.try_sql(format(
    $$ insert into public.verified_sales (receipt_submission_id, receipt_review_decision_id,
         receipt_confirmation_id, vendor_organization_id, retailer_organization_id,
         retailer_shop_id, finalized_by_profile_id, transaction_date, transaction_time,
         sale_at, timezone_name, sale_time_precision, currency_code, total_minor)
       select %L, rd.id, rc.id, %L, %L, %L, %L, rc.transaction_date, rc.transaction_time,
              timestamptz '2001-01-01 00:00:00+00', 'Asia/Dubai', 'MINUTE', rc.currency_code, rc.total_minor
       from public.receipt_review_decisions rd, public.receipt_confirmations rc
       where rd.receipt_submission_id = %L and rc.receipt_submission_id = %L $$,
    pg_temp.id('r_race'), pg_temp.id('vendor_a'), pg_temp.id('retailer_a'),
    pg_temp.id('shop_dxb'), pg_temp.id('rev'), pg_temp.id('r_race'), pg_temp.id('r_race'))),
  'REFUSED:23514', 'J2. an invented sale instant is refused');

select is(
  pg_temp.try_sql(format(
    $$ insert into public.verified_sales (receipt_submission_id, receipt_review_decision_id,
         receipt_confirmation_id, vendor_organization_id, retailer_organization_id,
         retailer_shop_id, finalized_by_profile_id, transaction_date, transaction_time,
         sale_at, timezone_name, sale_time_precision, currency_code, total_minor)
       select %L, rd.id, rc.id, %L, %L, %L, %L, rc.transaction_date, rc.transaction_time,
              timestamptz '2026-06-15 10:30:00+00', 'Asia/Dubai', 'MINUTE', rc.currency_code, rc.total_minor
       from public.receipt_review_decisions rd, public.receipt_confirmations rc
       where rd.receipt_submission_id = %L and rc.receipt_submission_id = %L $$,
    pg_temp.id('r_race'), pg_temp.id('vendor_a'), pg_temp.id('retailer_a'),
    pg_temp.id('shop_dxb'), pg_temp.id('staff'), pg_temp.id('r_race'), pg_temp.id('r_race'))),
  'REFUSED:42501', 'J3. a non-reviewer finalizer is refused by the table itself');

select is(
  pg_temp.try_sql(format(
    $$ insert into public.verified_sales (receipt_submission_id, receipt_review_decision_id,
         receipt_confirmation_id, vendor_organization_id, retailer_organization_id,
         retailer_shop_id, finalized_by_profile_id, transaction_date, transaction_time,
         sale_at, timezone_name, sale_time_precision, currency_code, total_minor)
       select %L, rd.id, rc.id, %L, %L, %L, %L, rc.transaction_date, rc.transaction_time,
              timestamptz '2026-06-15 06:00:00+00', 'Asia/Dubai', 'MINUTE', rc.currency_code, rc.total_minor
       from public.receipt_review_decisions rd, public.receipt_confirmations rc
       where rd.receipt_submission_id = %L and rc.receipt_submission_id = %L $$,
    pg_temp.id('r_excluded'), pg_temp.id('vendor_a'), pg_temp.id('retailer_a'),
    pg_temp.id('shop_dxb'), pg_temp.id('rev'), pg_temp.id('r_excluded'), pg_temp.id('r_excluded'))),
  'REFUSED:23514', 'J4. and an EXCLUDED receipt is refused by the table even without the RPC');


-- ============================================================================
-- SECTION K — the Audit Log
-- ============================================================================
select is(
  (select a.action from public.audit_logs a
    where a.entity_id = pg_temp.id('r_main')::text and a.action = 'SALE_HEADER_FINALIZED'),
  'SALE_HEADER_FINALIZED', 'K1. the action is SALE_HEADER_FINALIZED');
select is(
  (select a.entity_type from public.audit_logs a
    where a.entity_id = pg_temp.id('r_main')::text and a.action = 'SALE_HEADER_FINALIZED'),
  'RECEIPT_SUBMISSION', 'K2. and the entity type is RECEIPT_SUBMISSION');
select ok(
  (select a.organization_id is not null and a.actor_profile_id is not null
   from public.audit_logs a
   where a.entity_id = pg_temp.id('r_main')::text and a.action = 'SALE_HEADER_FINALIZED'),
  'K3. organization and actor are recorded');

select is(
  (select (select string_agg(k, ',' order by k) from jsonb_object_keys(a.metadata) k)
   from public.audit_logs a
   where a.entity_id = pg_temp.id('r_main')::text and a.action = 'SALE_HEADER_FINALIZED'),
  'currency_code,dst_ambiguity_choice,sale_time_precision,source_entry_mode',
  'K4. metadata carries exactly the four approved keys');
select is(
  (select a.metadata->>'sale_time_precision' from public.audit_logs a
    where a.entity_id = pg_temp.id('r_main')::text and a.action='SALE_HEADER_FINALIZED'),
  'MINUTE', 'K5. with the correct precision');
select is(
  (select a.metadata->>'source_entry_mode' from public.audit_logs a
    where a.entity_id = pg_temp.id('r_main')::text and a.action='SALE_HEADER_FINALIZED'),
  'MANUAL', 'K6. and the proposal''s entry mode');
select is(
  (select a.metadata->>'dst_ambiguity_choice' from public.audit_logs a
    where a.entity_id = pg_temp.id('r_ny_amb')::text and a.action='SALE_HEADER_FINALIZED'),
  'FIRST', 'K7. an ambiguous sale records the chosen interpretation');

select is(
  (select count(*)::integer from public.audit_logs a
    where a.action = 'SALE_HEADER_FINALIZED'
      and a.metadata::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'),
  0, 'K8. no UUID appears in any finalization metadata');
select is(
  (select count(*)::integer from public.audit_logs a
    where a.action = 'SALE_HEADER_FINALIZED'
      and (a.metadata::text like '%12345%' or a.metadata::text like '%10000%'
           or a.metadata::text ilike '%Test Merchant%' or a.metadata::text like '%DOC-1%')),
  0, 'K9. and no amount, merchant name or document number');


-- ============================================================================
-- SECTION L — the safe read RPCs
-- ============================================================================
select ok(has_function_privilege('authenticated','public.get_claim_receipt_sale_context(uuid)','EXECUTE'),
  'L1. authenticated may read sale context');
select ok(not has_function_privilege('anon','public.get_claim_receipt_sale_context(uuid)','EXECUTE'),
  'L2. anon may not');
select ok(has_function_privilege('authenticated','public.get_verified_sale_header(uuid)','EXECUTE'),
  'L3. authenticated may read a finalized header');
select ok(not has_function_privilege('anon','public.get_verified_sale_header(uuid)','EXECUTE'),
  'L4. anon may not');

select is(
  (select count(*)::integer from pg_proc p, unnest(p.proargnames) n
   where p.pronamespace='public'::regnamespace
     and p.proname in ('get_claim_receipt_sale_context','get_verified_sale_header')
     and n in ('vendor_organization_id','retailer_organization_id','retailer_shop_id',
               'finalized_by_profile_id','receipt_confirmation_id','receipt_review_decision_id',
               'id','storage_bucket','storage_object_path','file_sha256','email','phone')),
  0, 'L5. neither read function returns a Vendor, Retailer, shop, profile, lineage id, bucket, path, hash, email or phone');

select pg_temp.act_as(pg_temp.id('rev'));
select is((select count(*)::integer from public.get_claim_receipt_sale_context(pg_temp.id('r_noconf'))), 1,
  'L6. an authorized reviewer reads sale context');
select is((select has_confirmation::text from public.get_claim_receipt_sale_context(pg_temp.id('r_noconf'))),
  'false', 'L7. and a receipt with no proposal reports has_confirmation = false');
select is((select total_minor from public.get_claim_receipt_sale_context(pg_temp.id('r_noconf'))),
  null, 'L8. with no transaction values');

select is((select time_status from public.get_claim_receipt_sale_context(pg_temp.id('r_dateonly'))),
  'OK', 'L9. a date-only proposal reports OK');
select is((select resolved_sale_at_preview from public.get_claim_receipt_sale_context(pg_temp.id('r_dateonly'))),
  timestamptz '2026-06-15 08:00:00+00', 'L10. with a noon preview');
select is((select first_sale_at_candidate from public.get_claim_receipt_sale_context(pg_temp.id('r_dateonly'))),
  null, 'L11. and no candidates');

select is((select time_status from public.get_claim_receipt_sale_context(pg_temp.id('r_ny_amb2'))),
  'AMBIGUOUS', 'L12. an ambiguous proposal reports AMBIGUOUS');
select is((select first_sale_at_candidate from public.get_claim_receipt_sale_context(pg_temp.id('r_ny_amb2'))),
  timestamptz '2026-11-01 05:30:00+00', 'L13. with the FIRST candidate');
select is((select second_sale_at_candidate from public.get_claim_receipt_sale_context(pg_temp.id('r_ny_amb2'))),
  timestamptz '2026-11-01 06:30:00+00', 'L14. and the SECOND candidate');
select is((select resolved_sale_at_preview from public.get_claim_receipt_sale_context(pg_temp.id('r_ny_amb2'))),
  null, 'L15. and no single preview, because there is no single answer');

select is((select time_status from public.get_claim_receipt_sale_context(pg_temp.id('r_ny_bad'))),
  'NONEXISTENT', 'L16. a nonexistent time reports NONEXISTENT');
select is((select time_status from public.get_claim_receipt_sale_context(pg_temp.id('r_notz'))),
  'NO_TIMEZONE', 'L17. a shop with no zone reports NO_TIMEZONE');

select is((select is_qualification_excluded::text from public.get_claim_receipt_sale_context(pg_temp.id('r_excluded'))),
  'true', 'L18. an excluded receipt reports the exclusion');
select is((select exclusion_reason from public.get_claim_receipt_sale_context(pg_temp.id('r_excluded'))),
  'TEST_DATA', 'L19. with its reason, to an already-authorized reviewer');
select is((select already_finalized::text from public.get_claim_receipt_sale_context(pg_temp.id('r_main'))),
  'true', 'L20. a finalized receipt reports already_finalized');

select is((select count(*)::integer from public.get_claim_receipt_sale_context(gen_random_uuid())), 0,
  'L21. a nonexistent receipt returns zero rows');
select is((select count(*)::integer from public.get_claim_receipt_sale_context(pg_temp.id('r_foreign'))), 0,
  'L22. and a foreign receipt is indistinguishable from it');

select is((select count(*)::integer from public.get_verified_sale_header(pg_temp.id('r_main'))), 1,
  'L23. a finalized sale is readable');
select is((select sale_at from public.get_verified_sale_header(pg_temp.id('r_main'))),
  timestamptz '2026-06-15 10:30:00+00', 'L24. with its frozen instant');
select is((select finalized_by_display_name from public.get_verified_sale_header(pg_temp.id('r_main'))),
  'VS Rev', 'L25. and the finalizing reviewer''s display name');
select is((select count(*)::integer from public.get_verified_sale_header(pg_temp.id('r_foreign'))), 0,
  'L26. a foreign sale reads as zero rows');
select is((select count(*)::integer from public.get_verified_sale_header(pg_temp.id('r_noconf'))), 0,
  'L27. and a receipt with no sale reads as zero rows');

select pg_temp.act_as(pg_temp.id('staff'));
select is((select count(*)::integer from public.get_claim_receipt_sale_context(pg_temp.id('r_main'))), 0,
  'L28. Sales Staff read no sale context');
select is((select count(*)::integer from public.get_verified_sale_header(pg_temp.id('r_main'))), 0,
  'L29. and no sale header');
select pg_temp.sign_out();
select is((select count(*)::integer from public.get_claim_receipt_sale_context(pg_temp.id('r_main'))), 0,
  'L30. a signed-out caller reads nothing');


-- ============================================================================
-- SECTION M — nothing else moved
-- ============================================================================
select pg_temp.act_as(pg_temp.id('rev'));

select is(
  (select decision from public.receipt_review_decisions where receipt_submission_id=pg_temp.id('r_main')),
  'VERIFIED', 'M1. the review decision is still VERIFIED after all of the above');
select is(
  (select (rc.total_minor, rc.merchant_name)::text from public.receipt_confirmations rc
    where rc.receipt_submission_id=pg_temp.id('r_main')),
  '(12345,"Test Merchant")', 'M2. the staff proposal was not rewritten');
select is(
  (select count(*)::integer from public.receipt_qualification_events
    where receipt_submission_id=pg_temp.id('r_excluded')),
  1, 'M3. the qualification event count is unchanged');
select is(
  (select status from public.receipt_submissions where id=pg_temp.id('r_main')),
  'SUBMITTED', 'M4. the receipt row itself is unchanged');
select is((select mode from public.receipt_extraction_runtime), 'DISABLED',
  'M5. extraction is still DISABLED');
select is((select count(*)::integer from public.receipt_extractions), 0,
  'M6. no extraction was created');

select is(
  (select coalesce(string_agg(table_name, ','), 'NONE')::text
   from information_schema.tables
   where table_schema='public'
     and (table_name ilike '%reward%'
          or table_name ilike '%coin%' or table_name ilike '%ledger%'
          or table_name ilike '%wallet%' or table_name ilike '%balance%'
          or table_name ilike '%payout%' or table_name ilike '%campaign_qualification%')
     -- Phase 2A-A (migration 65) created qualification and reward EVIDENCE by
     -- approval. It computes nothing and pays nothing: no coin, ledger, wallet,
     -- balance or payout object exists, which is the rule this suite still owns.
     and table_name not in ('campaign_sale_evaluations',
                            'campaign_sale_item_qualifications',
                            'campaign_rewards',
                            'campaign_subject_accumulators')),
  'NONE',
  -- The sale-ITEM table is Phase 1D-B's approved work and is no longer forbidden
  -- here; this suite still owns the rule that NO reward machinery exists.
  'M7. no coin, ledger, wallet, balance or payout table was created (Phase 2A-A evidence excepted)');

select is(
  (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
    where t.tgrelid='public.receipt_qualification_events'::regclass and not t.tgisinternal),
  'receipt_qualification_events_assert_tenant,receipt_qualification_events_guard_change,receipt_qualification_events_guard_truncate',
  'M8. the Phase 1D-0 event table keeps its own guards');

-- ============================================================================
-- SECTION N — what this suite CANNOT prove
-- ============================================================================
-- pgTAP runs inside a single transaction, so nothing above proves behaviour under
-- genuine concurrency: two sessions never exist here, and the FOR UPDATE lock is
-- never actually contended. The finalization race, the two-reviewer race and both
-- finalization-versus-exclusion orders are proven separately against a disposable
-- database and reported with this milestone.
--
-- This assertion exists so the gap is visible in the suite's own output rather
-- than only in a report somebody may not read.
select ok(true,
  'N1. NOTE: concurrency is NOT proven here — pgTAP is single-transaction; see the two-session race results');

select pg_temp.sign_out();

select * from finish();
rollback;
