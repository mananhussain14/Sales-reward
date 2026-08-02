-- pgTAP behavioural tests for the RECEIPT REVIEW DATABASE FOUNDATION:
--
--   RECEIPT_REVIEW_READ / RECEIPT_REVIEW_DECIDE and their role mappings [20260819090000]
--   public.receipt_review_decisions and its three triggers
--   public.list_claim_review_queue(...)
--   public.count_claim_review_queue(...)
--   public.get_claim_review_detail(uuid)
--   public.decide_claim_receipt(uuid, text, text, text)
--   public.get_claim_review_object_reference(uuid)
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS WEIGHTED TOWARDS
-- ============================================================================
-- A decision here is immutable and will one day gate money, so the suite spends most of
-- its assertions on the four ways that could go wrong irreversibly:
--
--   * a decision reaching the wrong tenant (Sections C, E, G) -- a reviewer must never
--     see, let alone judge, another Vendor's receipt;
--   * the wrong ROLE deciding (Section B) -- above all VENDOR_SUPER_ADMIN, whose
--     separation from reviewing is the reason the Claim Reviewer role exists;
--   * two decisions for one receipt (Section H) -- the retry, the stale page and the
--     second reviewer must all resolve to exactly one verdict and one audit event;
--   * the foundation quietly widening something else (Section K) -- the Flutter portal
--     contract, extraction, existing receipt rows, or reward objects that must not exist.
--
-- Everything runs inside one transaction and is rolled back. no_plan(), per the
-- convention every suite in this directory follows. The six real hosted receipts are
-- never touched: every receipt below is synthetic and disappears with the rollback.

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

create function pg_temp.new_person(
  p_first text, p_last text, p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || lower(p_last) || '.' || left(v_id::text, 8) || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, p_status);
  return v_id;
end;
$$;

create function pg_temp.new_org(
  p_name text, p_type text, p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.organizations (name, organization_type, status, country_code, default_currency)
  values (p_name, p_type, p_status, 'AE', 'AED')
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.add_member(
  p_user uuid, p_org uuid, p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, p_status, now() - interval '30 days')
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

create function pg_temp.link(p_vendor uuid, p_retailer uuid, p_status text default 'ACTIVE')
returns void language plpgsql as $$
begin
  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (p_vendor, p_retailer, p_status);
end;
$$;

create function pg_temp.new_shop(p_retailer uuid, p_name text, p_code text, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into public.retailer_shops (retailer_organization_id, name, code, status, timezone_name)
  values (p_retailer, p_name, p_code, p_status, 'Asia/Dubai')
  returning id into v_id;
  return v_id;
end;
$$;

/* A receipt plus its storage object. The object is what makes it queue-eligible. */
create function pg_temp.new_receipt(
  p_retailer uuid, p_shop uuid, p_submitter uuid,
  p_status text default 'SUBMITTED',
  p_when timestamptz default null,
  p_sha text default null,
  p_with_object boolean default true
) returns uuid
language plpgsql as $$
declare
  v_id   uuid := gen_random_uuid();
  v_sha  text := coalesce(p_sha, encode(gen_random_bytes(32), 'hex'));
  v_path text := 'r/' || v_id::text || '.png';
  v_at   timestamptz := coalesce(p_when, now() - interval '1 day');
begin
  insert into public.receipt_submissions (
    id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
    storage_bucket, storage_object_path, original_file_name, mime_type,
    file_size_bytes, file_sha256, status, submitted_at
  ) values (
    v_id, p_retailer, p_shop, p_submitter,
    'receipts', v_path, 'receipt.png', 'image/png',
    123456, v_sha, p_status,
    case when p_status = 'SUBMITTED' then v_at else null end
  );

  if p_with_object then
    insert into storage.objects (bucket_id, name, owner) values ('receipts', v_path, null);
  end if;

  return v_id;
end;
$$;

create table pg_temp.f (k text primary key, v uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select v from pg_temp.f where k = p
$$;

/* Rows the queue returns for the CURRENT caller. */
create function pg_temp.queue_rows() returns integer
language sql stable as $$
  select count(*)::integer from public.list_claim_review_queue()
$$;

/* Whether a specific receipt is in the CURRENT caller's queue. */
create function pg_temp.in_queue(p_receipt uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.list_claim_review_queue(100) q
    where q.receipt_submission_id = p_receipt
  )
$$;

create function pg_temp.detail_rows(p_receipt uuid) returns integer
language sql stable as $$
  select count(*)::integer from public.get_claim_review_detail(p_receipt)
$$;

/* Audit events for one receipt, by action. */
create function pg_temp.audit_count(p_receipt uuid, p_action text default null)
returns integer language sql stable as $$
  select count(*)::integer from public.audit_logs a
  where a.entity_type = 'RECEIPT_SUBMISSION'
    and a.entity_id = p_receipt::text
    and (p_action is null or a.action = p_action)
$$;

do $$
declare
  v_m uuid;
begin
  insert into pg_temp.f values
    ('vendor_a',   pg_temp.new_org('Vendor A', 'VENDOR')),
    ('vendor_b',   pg_temp.new_org('Vendor B', 'VENDOR')),
    ('retailer_a', pg_temp.new_org('Retailer A', 'RETAILER')),
    ('retailer_b', pg_temp.new_org('Retailer B', 'RETAILER')),
    ('retailer_x', pg_temp.new_org('Retailer X', 'RETAILER'));

  -- Vendor A works with Retailer A (active) and Retailer X (DEACTIVATED link).
  -- Vendor B works with Retailer B. No Vendor reaches another's Retailer.
  perform pg_temp.link(pg_temp.id('vendor_a'), pg_temp.id('retailer_a'), 'ACTIVE');
  perform pg_temp.link(pg_temp.id('vendor_a'), pg_temp.id('retailer_x'), 'DEACTIVATED');
  perform pg_temp.link(pg_temp.id('vendor_b'), pg_temp.id('retailer_b'), 'ACTIVE');

  insert into pg_temp.f values
    ('shop_a',      pg_temp.new_shop(pg_temp.id('retailer_a'), 'Shop A', 'SHOPA')),
    ('shop_a_gone', pg_temp.new_shop(pg_temp.id('retailer_a'), 'Shop Closed', 'SHOPC', 'DEACTIVATED')),
    ('shop_b',      pg_temp.new_shop(pg_temp.id('retailer_b'), 'Shop B', 'SHOPB')),
    ('shop_x',      pg_temp.new_shop(pg_temp.id('retailer_x'), 'Shop X', 'SHOPX'));

  -- Reviewer for Vendor A, and a second one for the same Vendor.
  insert into pg_temp.f values ('reviewer', pg_temp.new_person('Rita', 'Reviewer'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer'), pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  insert into pg_temp.f values ('reviewer2', pg_temp.new_person('Raj', 'Reviewer'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer2'), pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  -- A reviewer for the OTHER Vendor.
  insert into pg_temp.f values ('reviewer_b', pg_temp.new_person('Bea', 'Reviewer'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer_b'), pg_temp.id('vendor_b'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  -- A reviewer whose membership is INACTIVE.
  insert into pg_temp.f values ('reviewer_off', pg_temp.new_person('Ivan', 'Inactive'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer_off'), pg_temp.id('vendor_a'), 'DEACTIVATED');
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  -- Every other role, in Vendor A or Retailer A as appropriate.
  insert into pg_temp.f values ('vsa', pg_temp.new_person('Vic', 'Admin'));
  v_m := pg_temp.add_member(pg_temp.id('vsa'), pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, 'VENDOR_SUPER_ADMIN');

  insert into pg_temp.f values ('owner', pg_temp.new_person('Ola', 'Owner'));
  v_m := pg_temp.add_member(pg_temp.id('owner'), pg_temp.id('retailer_a'));
  perform pg_temp.add_role(v_m, 'RETAILER_OWNER');

  insert into pg_temp.f values ('manager', pg_temp.new_person('Mo', 'Manager'));
  v_m := pg_temp.add_member(pg_temp.id('manager'), pg_temp.id('retailer_a'));
  perform pg_temp.add_role(v_m, 'RETAILER_MANAGER');

  insert into pg_temp.f values ('staff', pg_temp.new_person('Sam', 'Staff'));
  v_m := pg_temp.add_member(pg_temp.id('staff'), pg_temp.id('retailer_a'));
  perform pg_temp.add_role(v_m, 'SALES_STAFF');

  -- A submitter who has since LEFT — decision D7's subject.
  insert into pg_temp.f values ('staff_gone', pg_temp.new_person('Gus', 'Gone'));
  v_m := pg_temp.add_member(pg_temp.id('staff_gone'), pg_temp.id('retailer_a'), 'DEACTIVATED');
  perform pg_temp.add_role(v_m, 'SALES_STAFF');

  -- Receipts. r1 oldest .. r3 newest, all eligible for Vendor A.
  insert into pg_temp.f values
    ('r1', pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'),
                               'SUBMITTED', now() - interval '10 days')),
    ('r2', pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'),
                               'SUBMITTED', now() - interval '5 days')),
    ('r3', pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'),
                               'SUBMITTED', now() - interval '1 day')),
    -- Ineligible shapes.
    ('r_reserved', pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'), 'RESERVED')),
    ('r_failed',   pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'), 'UPLOAD_FAILED')),
    ('r_noobject', pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a'), pg_temp.id('staff'),
                                       'SUBMITTED', now() - interval '3 days', null, false)),
    -- Historical: deactivated shop, deactivated submitter. Must STILL be reviewable (D7).
    ('r_hist', pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a_gone'), pg_temp.id('staff_gone'),
                                   'SUBMITTED', now() - interval '20 days')),
    -- Another Vendor's receipt, and one behind an INACTIVE link.
    ('r_foreign', pg_temp.new_receipt(pg_temp.id('retailer_b'), pg_temp.id('shop_b'), pg_temp.id('staff'),
                                      'SUBMITTED', now() - interval '2 days')),
    ('r_offlink', pg_temp.new_receipt(pg_temp.id('retailer_x'), pg_temp.id('shop_x'), pg_temp.id('staff'),
                                      'SUBMITTED', now() - interval '4 days'));
end;
$$;

-- ============================================================================
-- SECTION A — permissions and mappings
-- ============================================================================
select is(
  (select count(*)::integer from public.permissions
    where code in ('RECEIPT_REVIEW_READ', 'RECEIPT_REVIEW_DECIDE')),
  2,
  'A1. both review permissions exist'
);

select is(
  (select count(*)::integer from public.permissions
    where code in ('RECEIPT_REVIEW_READ', 'RECEIPT_REVIEW_DECIDE') and module = 'CLAIM_REVIEW'),
  2,
  'A2. and both are filed under the CLAIM_REVIEW module, not RECEIPTS'
);

-- The whole separation-of-duties claim for the new permissions, in one assertion.
select is(
  (select coalesce(string_agg(distinct r.code, ',' order by r.code), '(none)')
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code in ('RECEIPT_REVIEW_READ', 'RECEIPT_REVIEW_DECIDE')),
  'CLAIM_REVIEWER',
  'A3. and CLAIM_REVIEWER is the ONLY role holding either of them'
);

select is(
  (select count(*)::integer from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   where r.code = 'CLAIM_REVIEWER'),
  4,
  'A4. CLAIM_REVIEWER now holds exactly four permissions'
);

select is(
  (select string_agg(p.code, ',' order by p.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'CLAIM_REVIEWER'),
  'CLAIM_REVIEW_PORTAL_READ,RECEIPT_QUALIFICATION_CLASSIFY,RECEIPT_REVIEW_DECIDE,RECEIPT_REVIEW_READ',
  'A5. and they are exactly the portal, review and classify permissions'
);

-- The submission-side permissions belong to Sales Staff and must not have moved.
select is(
  (select coalesce(string_agg(distinct r.code, ',' order by r.code), '(none)')
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code in ('RECEIPT_SUBMIT', 'RECEIPT_PRODUCTS_READ', 'RECEIPT_EXTRACTION_REVIEW')),
  'SALES_STAFF',
  'A6. and no submission permission leaked to the reviewer'
);

select is(
  (select count(*)::integer from public.permissions
    where code in ('WRONG_VENDOR_OR_PRODUCT', 'AMOUNT_MISMATCH', 'RECEIPT_OUTSIDE_ALLOWED_PERIOD')),
  0,
  'A7. the three data-dependent reasons were not smuggled in as permissions'
);

-- ============================================================================
-- SECTION B — who may read, and who may decide
-- ============================================================================
select pg_temp.act_as(pg_temp.id('reviewer'));
select ok(pg_temp.queue_rows() > 0, 'B1. the Vendor A reviewer can read their queue');

select pg_temp.act_as(pg_temp.id('vsa'));
select is(pg_temp.queue_rows(), 0,
  'B2. a Vendor Super Admin reads nothing through that role alone');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'VERIFIED') $q$, pg_temp.id('r1')),
  '42501',
  null,
  'B3. and a Vendor Super Admin cannot decide -- the separation this milestone exists for'
);

select pg_temp.act_as(pg_temp.id('owner'));
select is(pg_temp.queue_rows(), 0, 'B4. a Retailer Owner reads nothing');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'VERIFIED') $q$, pg_temp.id('r1')),
  '42501', null, 'B5. and cannot decide');

select pg_temp.act_as(pg_temp.id('manager'));
select is(pg_temp.queue_rows(), 0, 'B6. a Retailer Manager reads nothing');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'VERIFIED') $q$, pg_temp.id('r1')),
  '42501', null, 'B7. and cannot decide');

select pg_temp.act_as(pg_temp.id('staff'));
select is(pg_temp.queue_rows(), 0, 'B8. the submitting Sales Staff reads nothing');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'VERIFIED') $q$, pg_temp.id('r1')),
  '42501', null, 'B9. and cannot judge their own submission');

select pg_temp.act_as(pg_temp.id('reviewer_off'));
select is(pg_temp.queue_rows(), 0, 'B10. a DEACTIVATED reviewer membership reads nothing');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'VERIFIED') $q$, pg_temp.id('r1')),
  '42501', null, 'B11. and cannot decide');

select pg_temp.sign_out();
select is(pg_temp.queue_rows(), 0, 'B12. a signed-out caller reads nothing');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'VERIFIED') $q$, pg_temp.id('r1')),
  '42501', null, 'B13. and cannot decide');
select is(pg_temp.detail_rows(pg_temp.id('r1')), 0, 'B14. and sees no detail');
select is(public.count_claim_review_queue(), 0::bigint, 'B15. and counts zero');

-- ============================================================================
-- SECTION C — tenant isolation
-- ============================================================================
select pg_temp.act_as(pg_temp.id('reviewer'));
select ok(not pg_temp.in_queue(pg_temp.id('r_foreign')),
  'C1. another Vendor''s receipt is not in the queue');
select is(pg_temp.detail_rows(pg_temp.id('r_foreign')), 0,
  'C2. and its detail returns zero rows');
select is(pg_temp.detail_rows(gen_random_uuid()), 0,
  'C3. as does a receipt that does not exist -- the two are indistinguishable');

select ok(not pg_temp.in_queue(pg_temp.id('r_offlink')),
  'C4. a DEACTIVATED vendor_retailers link removes its receipts from the queue');
select is(pg_temp.detail_rows(pg_temp.id('r_offlink')), 0,
  'C5. and closes their detail too');

select pg_temp.act_as(pg_temp.id('reviewer_b'));
select ok(pg_temp.in_queue(pg_temp.id('r_foreign')),
  'C6. the other Vendor''s own reviewer does see it');
select ok(not pg_temp.in_queue(pg_temp.id('r1')),
  'C7. and cannot see Vendor A''s receipts -- isolation runs both ways');

-- A caller cannot widen their view by naming a foreign Retailer.
select pg_temp.act_as(pg_temp.id('reviewer'));
select is(
  (select count(*)::integer from public.list_claim_review_queue(100, null, null, pg_temp.id('retailer_b'))),
  0,
  'C8. filtering by a foreign Retailer returns nothing rather than leaking it'
);
select is(
  (select count(*)::integer from public.list_claim_review_queue(100, null, null, null, pg_temp.id('shop_b'))),
  0,
  'C9. and neither does a foreign shop filter'
);

-- ============================================================================
-- SECTION D — queue eligibility (D6, D7)
-- ============================================================================
select pg_temp.act_as(pg_temp.id('reviewer'));
select ok(pg_temp.in_queue(pg_temp.id('r1')), 'D1. a SUBMITTED receipt with an object appears');
select ok(not pg_temp.in_queue(pg_temp.id('r_reserved')), 'D2. a RESERVED receipt does not');
select ok(not pg_temp.in_queue(pg_temp.id('r_failed')),   'D3. an UPLOAD_FAILED receipt does not');
select ok(not pg_temp.in_queue(pg_temp.id('r_noobject')),
  'D4. and neither does one whose stored object is missing');

-- D7 in two assertions: history stays reviewable, and its state is shown as context.
select ok(pg_temp.in_queue(pg_temp.id('r_hist')),
  'D5. a receipt from a since-deactivated shop and submitter is STILL reviewable');
select is(
  (select q.shop_status from public.list_claim_review_queue(100) q
    where q.receipt_submission_id = pg_temp.id('r_hist')),
  'DEACTIVATED',
  'D6. and the shop''s current state is reported as context'
);
select is(
  (select q.submitter_status from public.list_claim_review_queue(100) q
    where q.receipt_submission_id = pg_temp.id('r_hist')),
  'DEACTIVATED',
  'D7. as is the submitter''s'
);

-- ============================================================================
-- SECTION E — ordering, pagination and filters (D2, D9)
-- ============================================================================
select is(
  (select array_agg(q.receipt_submission_id order by ord)
   from (select receipt_submission_id, row_number() over () ord
         from public.list_claim_review_queue(100)) q),
  (select array_agg(s.id order by s.submitted_at asc, s.id asc)
   from public.receipt_submissions s
   where s.id in (pg_temp.id('r_hist'), pg_temp.id('r1'), pg_temp.id('r2'), pg_temp.id('r3'))),
  'E1. the queue is ordered oldest-first, exactly as (submitted_at, id) sorts'
);

select is(
  (select q.receipt_submission_id from public.list_claim_review_queue(1) q),
  pg_temp.id('r_hist'),
  'E2. the first page returns the oldest receipt'
);

-- Keyset paging: page 1 then page 2 must cover the set with no repeat and no gap.
select is(
  (select count(distinct x)::integer from (
     select q.receipt_submission_id x from public.list_claim_review_queue(2) q
     union all
     select q2.receipt_submission_id from public.list_claim_review_queue(
       2,
       (select max(a.submitted_at) from (select q3.submitted_at from public.list_claim_review_queue(2) q3) a),
       (select q4.receipt_submission_id from public.list_claim_review_queue(2) q4
         order by q4.submitted_at desc limit 1)
     ) q2
   ) u),
  4,
  'E3. two keyset pages of 2 return four distinct receipts -- no duplicate, no gap'
);

select throws_ok(
  $q$ select public.list_claim_review_queue(25, now(), null) $q$,
  '22023', null,
  'E4. a half-supplied cursor is refused rather than silently skipping rows'
);
select throws_ok(
  $q$ select public.list_claim_review_queue(25, null, gen_random_uuid()) $q$,
  '22023', null,
  'E5. in either direction'
);

select is(
  (select count(*)::integer from public.list_claim_review_queue()),
  4,
  'E6. the default limit returns every eligible receipt when fewer than 25 exist'
);
select is(
  (select count(*)::integer from public.list_claim_review_queue(1000000)),
  4,
  'E7. an absurd limit is clamped rather than refused'
);
select is(
  (select count(*)::integer from public.list_claim_review_queue(0)),
  1,
  'E8. and a zero limit is clamped up to one rather than returning nothing'
);

select is(
  (select count(*)::integer from public.list_claim_review_queue(100, null, null, null, pg_temp.id('shop_a'))),
  3,
  'E9. the shop filter narrows to that shop'
);
select is(
  (select count(*)::integer
   from public.list_claim_review_queue(100, null, null, null, null, now() - interval '6 days')),
  2,
  'E10. the submitted-from filter narrows by date'
);
select is(
  (select count(*)::integer
   from public.list_claim_review_queue(100, null, null, null, null, null, now() - interval '6 days')),
  2,
  'E11. and the submitted-to filter narrows the other way'
);

-- The count and the listing must not drift.
select is(
  public.count_claim_review_queue(),
  (select count(*)::bigint from public.list_claim_review_queue(1000)),
  'E12. the count function agrees with the listing'
);
select is(
  public.count_claim_review_queue(null, pg_temp.id('shop_a')),
  (select count(*)::bigint from public.list_claim_review_queue(1000, null, null, null, pg_temp.id('shop_a'))),
  'E13. and agrees under a filter too'
);

-- ============================================================================
-- SECTION F — detail output
-- ============================================================================
select is(pg_temp.detail_rows(pg_temp.id('r1')), 1, 'F1. a reviewer can open their receipt');

select is(
  (select d.decision from public.get_claim_review_detail(pg_temp.id('r1')) d),
  null,
  'F2. an undecided receipt reports no decision'
);
select is(
  (select d.extraction_status from public.get_claim_review_detail(pg_temp.id('r1')) d),
  'NONE',
  'F3. extraction availability is NONE while extraction is disabled'
);
select is(
  (select d.has_retailer_confirmation from public.get_claim_review_detail(pg_temp.id('r1')) d),
  false,
  'F4. and no Retailer confirmation exists'
);

-- Nothing private may appear in the output type of either read function.
select is(
  (select count(*)::integer
   from pg_proc p, unnest(p.proargnames) n
   where p.proname in ('list_claim_review_queue', 'get_claim_review_detail')
     and p.pronamespace = 'public'::regnamespace
     and n in ('storage_bucket', 'storage_object_path', 'file_sha256',
               'submitter_email', 'submitter_phone', 'submitted_by_profile_id',
               'retailer_organization_id', 'decided_by_profile_id')),
  0,
  'F5. neither read function returns a bucket, path, hash, email or private id'
);

-- ============================================================================
-- SECTION G — decisions (D3, D4)
-- ============================================================================
select pg_temp.act_as(pg_temp.id('reviewer'));

select is(
  (select d.outcome from public.decide_claim_receipt(pg_temp.id('r1'), 'VERIFIED') d),
  'DECIDED',
  'G1. VERIFY succeeds'
);
select ok(not pg_temp.in_queue(pg_temp.id('r1')),
  'G2. and the receipt leaves the active queue');
select is(pg_temp.detail_rows(pg_temp.id('r1')), 1,
  'G3. while remaining readable through detail');
select is(
  (select d.decision from public.get_claim_review_detail(pg_temp.id('r1')) d),
  'VERIFIED',
  'G4. which now reports the decision'
);

select is(
  (select d.outcome from public.decide_claim_receipt(
      pg_temp.id('r2'), 'REJECTED', 'UNREADABLE_RECEIPT') d),
  'DECIDED',
  'G5. REJECT succeeds, and UNREADABLE_RECEIPT needs no note'
);

select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'REJECTED') $q$, pg_temp.id('r3')),
  '22023', null, 'G6. REJECT without a reason is refused');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'VERIFIED', 'UNREADABLE_RECEIPT') $q$, pg_temp.id('r3')),
  '22023', null, 'G7. VERIFY with a reason is refused');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'REJECTED', 'AMOUNT_MISMATCH', 'x') $q$, pg_temp.id('r3')),
  '22023', null, 'G8. a reason outside the approved five is refused');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'MAYBE') $q$, pg_temp.id('r3')),
  '22023', null, 'G9. a decision outside VERIFIED/REJECTED is refused');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'REJECTED', 'OTHER', %L) $q$,
         pg_temp.id('r3'), repeat('x', 501)),
  '22023', null, 'G10. a note over 500 characters is refused');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'REJECTED', 'INVALID_RECEIPT', '   ') $q$, pg_temp.id('r3')),
  '22023', null, 'G11. a whitespace-only note cannot satisfy a mandatory-note reason');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'REJECTED', 'DUPLICATE_RECEIPT') $q$, pg_temp.id('r3')),
  '22023', null, 'G12. DUPLICATE_RECEIPT requires a note');
select throws_ok(
  format($q$ select public.decide_claim_receipt(%L, 'REJECTED', 'OTHER') $q$, pg_temp.id('r3')),
  '22023', null, 'G13. OTHER requires a note');

select is(
  (select d.outcome from public.decide_claim_receipt(
      pg_temp.id('r3'), 'REJECTED', 'MISSING_REQUIRED_INFORMATION') d),
  'DECIDED',
  'G14. MISSING_REQUIRED_INFORMATION needs no note'
);
select is(
  (select d.outcome from public.decide_claim_receipt(
      pg_temp.id('r_hist'), 'REJECTED', 'INVALID_RECEIPT', 'Handwritten, not a till receipt.') d),
  'DECIDED',
  'G15. INVALID_RECEIPT succeeds when a note is supplied'
);

-- ============================================================================
-- SECTION H — idempotency, conflict and concurrency
-- ============================================================================
select is(
  (select d.outcome from public.decide_claim_receipt(pg_temp.id('r1'), 'VERIFIED') d),
  'ALREADY_DECIDED',
  'H1. the same reviewer repeating the identical request gets ALREADY_DECIDED'
);
select is(
  (select d.changed from public.decide_claim_receipt(pg_temp.id('r1'), 'VERIFIED') d),
  false,
  'H2. and changed is false'
);
select is(
  (select count(*)::integer from public.receipt_review_decisions
    where receipt_submission_id = pg_temp.id('r1')),
  1,
  'H3. with no second decision row'
);
select is(pg_temp.audit_count(pg_temp.id('r1')), 1,
  'H4. and no second audit event');

select is(
  (select d.outcome from public.decide_claim_receipt(
      pg_temp.id('r1'), 'REJECTED', 'UNREADABLE_RECEIPT') d),
  'CONFLICT',
  'H5. the same reviewer changing their mind gets CONFLICT, not an overwrite'
);
select is(
  (select d.decision from public.decide_claim_receipt(
      pg_temp.id('r1'), 'REJECTED', 'UNREADABLE_RECEIPT') d),
  'VERIFIED',
  'H6. and is told the ORIGINAL decision'
);
select is(
  (select rd.decision from public.receipt_review_decisions rd
    where rd.receipt_submission_id = pg_temp.id('r1')),
  'VERIFIED',
  'H7. which is unchanged in the table'
);

-- A second reviewer must never inherit the first one's idempotency.
select pg_temp.act_as(pg_temp.id('reviewer2'));
select is(
  (select d.outcome from public.decide_claim_receipt(pg_temp.id('r1'), 'VERIFIED') d),
  'CONFLICT',
  'H8. a DIFFERENT reviewer submitting the identical verdict gets CONFLICT, not ALREADY_DECIDED'
);
select is(
  (select rd.decided_by_profile_id from public.receipt_review_decisions rd
    where rd.receipt_submission_id = pg_temp.id('r1')),
  pg_temp.id('reviewer'),
  'H9. and attribution still belongs to the first reviewer'
);
select is(pg_temp.audit_count(pg_temp.id('r1')), 1,
  'H10. still exactly one audit event for that receipt');

-- ============================================================================
-- SECTION I — audit
-- ============================================================================
select is(pg_temp.audit_count(pg_temp.id('r1'), 'RECEIPT_VERIFIED'), 1,
  'I1. a verify writes exactly one RECEIPT_VERIFIED event');
select is(pg_temp.audit_count(pg_temp.id('r2'), 'RECEIPT_REJECTED'), 1,
  'I2. a reject writes exactly one RECEIPT_REJECTED event');

select is(
  (select a.entity_type from public.audit_logs a
    where a.entity_id = pg_temp.id('r1')::text limit 1),
  'RECEIPT_SUBMISSION',
  'I3. the entity type is RECEIPT_SUBMISSION'
);
select is(
  (select a.organization_id from public.audit_logs a
    where a.entity_id = pg_temp.id('r1')::text limit 1),
  pg_temp.id('vendor_a'),
  'I4. attributed to the reviewer''s Vendor'
);
select is(
  (select a.actor_profile_id from public.audit_logs a
    where a.entity_id = pg_temp.id('r1')::text limit 1),
  pg_temp.id('reviewer'),
  'I5. and to the deciding reviewer'
);
select is(
  (select string_agg(k, ',' order by k)
   from public.audit_logs a, jsonb_object_keys(a.metadata) k
   where a.entity_id = pg_temp.id('r1')::text),
  'decision,note_present,rejection_reason',
  'I6. metadata carries exactly the three approved keys'
);
select is(
  (select a.metadata->>'note_present' from public.audit_logs a
    where a.entity_id = pg_temp.id('r_hist')::text),
  'true',
  'I7. note_present records THAT a note exists'
);
select is(
  (select count(*)::integer from public.audit_logs a
    where a.entity_id = pg_temp.id('r_hist')::text
      and a.metadata::text like '%Handwritten%'),
  0,
  'I8. but the note TEXT is never logged'
);
select is(
  (select count(*)::integer from public.audit_logs a
    where a.entity_type = 'RECEIPT_SUBMISSION'
      and (a.metadata::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
        or a.metadata::text like '%receipts/%'
        or a.metadata::text like '%storage%')),
  0,
  'I9. and metadata contains no UUID, bucket or storage path'
);

-- ============================================================================
-- SECTION J — immutability and privileges
-- ============================================================================
select throws_ok(
  format($q$ update public.receipt_review_decisions set decision = 'REJECTED'
             where receipt_submission_id = %L $q$, pg_temp.id('r1')),
  '23514', null, 'J1. a decision cannot be updated');
select throws_ok(
  format($q$ delete from public.receipt_review_decisions
             where receipt_submission_id = %L $q$, pg_temp.id('r1')),
  '23514', null, 'J2. a decision cannot be deleted');
select throws_ok(
  $q$ truncate public.receipt_review_decisions $q$,
  null, null, 'J3. and the table cannot be truncated');

select is(
  (select count(*)::integer from pg_policy p
    where p.polrelid = 'public.receipt_review_decisions'::regclass),
  0,
  'J4. the decision table has RLS enabled with zero policies'
);
select ok(
  (select c.relrowsecurity from pg_class c where c.oid = 'public.receipt_review_decisions'::regclass),
  'J5. row level security is enabled on it'
);

select ok(not has_table_privilege('authenticated', 'public.receipt_review_decisions', 'SELECT'),
  'J6. authenticated cannot read the table directly');
select ok(not has_table_privilege('authenticated', 'public.receipt_review_decisions', 'INSERT'),
  'J7. nor write it');
select ok(not has_table_privilege('service_role', 'public.receipt_review_decisions', 'TRUNCATE'),
  'J8. and service_role cannot truncate around the row guard');

select ok(has_function_privilege('authenticated',
  'public.list_claim_review_queue(integer,timestamptz,uuid,uuid,uuid,timestamptz,timestamptz)', 'EXECUTE'),
  'J9. authenticated may call the queue');
select ok(not has_function_privilege('anon',
  'public.list_claim_review_queue(integer,timestamptz,uuid,uuid,uuid,timestamptz,timestamptz)', 'EXECUTE'),
  'J10. anon may not');
select ok(not has_function_privilege('anon', 'public.decide_claim_receipt(uuid,text,text,text)', 'EXECUTE'),
  'J11. nor decide');
select ok(has_function_privilege('service_role',
  'public.get_claim_review_object_reference(uuid)', 'EXECUTE'),
  'J12. service_role may resolve the private object reference');
select ok(not has_function_privilege('authenticated',
  'public.get_claim_review_object_reference(uuid)', 'EXECUTE'),
  'J13. authenticated may NOT -- the bucket and path never reach a browser role');
select ok(not has_function_privilege('anon',
  'public.get_claim_review_object_reference(uuid)', 'EXECUTE'),
  'J14. and neither may anon');

-- The Phase 1B internal resolver keeps its boundary.
select ok(not has_function_privilege('authenticated',
  'public.resolve_claim_reviewer_organization(text)', 'EXECUTE'),
  'J15. the internal resolver is still unreachable by authenticated');

-- The stored form is search_path="" (with the empty-string literal), not a bare
-- "search_path=". Matching the exact stored value rather than a prefix, so a function
-- that set search_path to something NON-empty would still fail this.
select is(
  (select count(*)::integer from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('list_claim_review_queue','count_claim_review_queue',
                       'get_claim_review_detail','decide_claim_receipt',
                       'get_claim_review_object_reference')
     and (p.prosecdef = false or p.proconfig is null
          or not ('search_path=""' = any(p.proconfig)))),
  0,
  'J16. every new function is SECURITY DEFINER with an empty search_path'
);

select is(
  (select count(*)::integer from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('receipt_review_decisions_guard_change',
                       'receipt_review_decisions_guard_truncate',
                       'receipt_review_decisions_assert_tenant')
     and (p.prosecdef = false or not ('search_path=""' = any(coalesce(p.proconfig, array[]::text[]))))),
  0,
  'J17. and so is every new trigger function'
);

-- ============================================================================
-- SECTION K — nothing else moved
-- ============================================================================
select is(
  (select mode from public.receipt_extraction_runtime),
  'DISABLED',
  'K1. receipt extraction is still DISABLED'
);
select is(
  (select count(*)::integer from public.receipt_extractions),
  0,
  'K2. no extraction row was created'
);
select is(
  (select count(*)::integer from public.receipt_confirmations),
  0,
  'K3. no Retailer confirmation was created'
);

-- No reward machinery may have appeared.
select is(
  (select count(*)::integer from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and (c.relname like '%reward%' or c.relname like '%coin%'
       or c.relname like '%balance%' or c.relname like '%payout%'
       or c.relname like '%verified_sale%')),
  0,
  'K4. no reward, coin, balance, payout or verified-sale table exists'
);

-- The Flutter contract is untouched.
select is(
  (select count(*)::integer from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'get_my_portal_context'),
  1,
  'K5. get_my_portal_context still exists exactly once'
);
select is(
  (select public.get_my_portal_context()->>'context_version'),
  '1',
  'K6. and context_version is still 1'
);
select is(
  (select string_agg(k, ',' order by k) from jsonb_object_keys(public.get_my_portal_context()) k),
  'context_version,portal_kind,retailer,vendor',
  'K7. with an unchanged key set'
);
select is(
  (select count(*)::integer from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosrc like '%CLAIM_REVIEWER%'
      and p.proname = 'get_my_portal_context'),
  0,
  'K8. and no reviewer portal kind was added to it'
);

-- Existing receipt-submission functions are still callable by their established caller.
select pg_temp.act_as(pg_temp.id('staff'));
select lives_ok(
  $q$ select * from public.list_my_receipt_submissions() $q$,
  'K9. Sales Staff can still read their own submissions'
);
select lives_ok(
  $q$ select * from public.list_my_assigned_receipt_shops() $q$,
  'K10. and their assigned shops'
);

select pg_temp.sign_out();

select * from finish();
rollback;
