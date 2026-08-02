-- pgTAP behavioural tests for CLAIM REVIEW FILTER OPTIONS:
--
--   public.list_claim_review_filter_options()   [20260819210000]
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS WEIGHTED TOWARDS
-- ============================================================================
-- A filter option is a small thing that can leak a large one: it names a Retailer and
-- a shop, so a function that is even slightly too generous tells a reviewer who else
-- the Vendor trades with, or tells one Vendor about another's partners. The suite
-- therefore spends most of its assertions on:
--
--   * tenant isolation (Section C) -- a foreign Vendor's Retailer must never appear;
--   * role containment (Section B) -- nobody but a permitted reviewer gets options;
--   * ELIGIBILITY DRIFT (Section E) -- the whole point of the follow-up. Every option
--     must be backed by a receipt the queue would actually return, and Section F
--     compares the two functions directly so the duplicated predicates cannot
--     silently diverge.
--
-- Everything runs inside one transaction and is rolled back. The six real hosted
-- receipts are never touched: every receipt below is synthetic.

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
  p_status text default 'SUBMITTED',
  p_when timestamptz default null,
  p_with_object boolean default true
) returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
  v_path text := 'f/' || v_id::text || '.png';
begin
  insert into public.receipt_submissions (
    id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
    storage_bucket, storage_object_path, original_file_name, mime_type,
    file_size_bytes, file_sha256, status, submitted_at
  ) values (
    v_id, p_retailer, p_shop, p_submitter,
    'receipts', v_path, 'r.png', 'image/png', 1000,
    encode(gen_random_bytes(32), 'hex'), p_status,
    case when p_status = 'SUBMITTED' then coalesce(p_when, now() - interval '1 day') else null end
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

/* Option rows for the CURRENT caller. */
create function pg_temp.opt_rows() returns integer
language sql stable as $$
  select count(*)::integer from public.list_claim_review_filter_options()
$$;

/* Whether a given shop appears as an option for the CURRENT caller. */
create function pg_temp.has_shop(p_shop uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.list_claim_review_filter_options() o
    where o.retailer_shop_id = p_shop
  )
$$;

/* Whether a given Retailer appears. */
create function pg_temp.has_retailer(p_ret uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.list_claim_review_filter_options() o
    where o.retailer_organization_id = p_ret
  )
$$;

do $$
declare v_m uuid;
begin
  insert into pg_temp.f values
    ('vendor_a',   pg_temp.new_org('FO Vendor A', 'VENDOR')),
    ('vendor_b',   pg_temp.new_org('FO Vendor B', 'VENDOR')),
    ('retailer_a', pg_temp.new_org('FO Retailer A', 'RETAILER')),
    ('retailer_b', pg_temp.new_org('FO Retailer B', 'RETAILER')),
    ('retailer_x', pg_temp.new_org('FO Retailer X', 'RETAILER')),
    ('retailer_q', pg_temp.new_org('FO Retailer Quiet', 'RETAILER'));

  perform pg_temp.link(pg_temp.id('vendor_a'), pg_temp.id('retailer_a'), 'ACTIVE');
  perform pg_temp.link(pg_temp.id('vendor_a'), pg_temp.id('retailer_x'), 'DEACTIVATED');
  -- Linked and ACTIVE, but has NO pending receipt: must not appear.
  perform pg_temp.link(pg_temp.id('vendor_a'), pg_temp.id('retailer_q'), 'ACTIVE');
  perform pg_temp.link(pg_temp.id('vendor_b'), pg_temp.id('retailer_b'), 'ACTIVE');

  insert into pg_temp.f values
    ('shop_a1',   pg_temp.new_shop(pg_temp.id('retailer_a'), 'FO Shop One', 'FO1')),
    ('shop_a2',   pg_temp.new_shop(pg_temp.id('retailer_a'), 'FO Shop Two', 'FO2')),
    ('shop_gone', pg_temp.new_shop(pg_temp.id('retailer_a'), 'FO Shop Closed', 'FO3', 'DEACTIVATED')),
    ('shop_none', pg_temp.new_shop(pg_temp.id('retailer_a'), 'FO Shop Empty', 'FO4')),
    ('shop_b',    pg_temp.new_shop(pg_temp.id('retailer_b'), 'FO Shop B', 'FOB')),
    ('shop_x',    pg_temp.new_shop(pg_temp.id('retailer_x'), 'FO Shop X', 'FOX')),
    ('shop_q',    pg_temp.new_shop(pg_temp.id('retailer_q'), 'FO Shop Quiet', 'FOQ'));

  insert into pg_temp.f values ('reviewer', pg_temp.new_person('Fiona', 'Reviewer'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer'), pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  insert into pg_temp.f values ('reviewer_b', pg_temp.new_person('Bruno', 'Reviewer'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer_b'), pg_temp.id('vendor_b'));
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  insert into pg_temp.f values ('reviewer_off', pg_temp.new_person('Ida', 'Inactive'));
  v_m := pg_temp.add_member(pg_temp.id('reviewer_off'), pg_temp.id('vendor_a'), 'DEACTIVATED');
  perform pg_temp.add_role(v_m, 'CLAIM_REVIEWER');

  insert into pg_temp.f values ('vsa', pg_temp.new_person('Val', 'Admin'));
  v_m := pg_temp.add_member(pg_temp.id('vsa'), pg_temp.id('vendor_a'));
  perform pg_temp.add_role(v_m, 'VENDOR_SUPER_ADMIN');

  insert into pg_temp.f values ('owner', pg_temp.new_person('Omar', 'Owner'));
  v_m := pg_temp.add_member(pg_temp.id('owner'), pg_temp.id('retailer_a'));
  perform pg_temp.add_role(v_m, 'RETAILER_OWNER');

  insert into pg_temp.f values ('manager', pg_temp.new_person('Mia', 'Manager'));
  v_m := pg_temp.add_member(pg_temp.id('manager'), pg_temp.id('retailer_a'));
  perform pg_temp.add_role(v_m, 'RETAILER_MANAGER');

  insert into pg_temp.f values ('staff', pg_temp.new_person('Sami', 'Staff'));
  v_m := pg_temp.add_member(pg_temp.id('staff'), pg_temp.id('retailer_a'));
  perform pg_temp.add_role(v_m, 'SALES_STAFF');

  insert into pg_temp.f values ('staff_gone', pg_temp.new_person('Gil', 'Gone'));
  v_m := pg_temp.add_member(pg_temp.id('staff_gone'), pg_temp.id('retailer_a'), 'DEACTIVATED');
  perform pg_temp.add_role(v_m, 'SALES_STAFF');

  -- shop_a1: TWO pending receipts, to prove the pair is deduplicated.
  insert into pg_temp.f values
    ('r_a1_one', pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a1'), pg_temp.id('staff'),
                                     'SUBMITTED', now() - interval '9 days')),
    ('r_a1_two', pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a1'), pg_temp.id('staff'),
                                     'SUBMITTED', now() - interval '8 days')),
    -- shop_a2: one pending receipt.
    ('r_a2',     pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_a2'), pg_temp.id('staff'),
                                     'SUBMITTED', now() - interval '7 days')),
    -- shop_gone: deactivated shop, deactivated submitter, receipt still pending (D7).
    ('r_hist',   pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_gone'), pg_temp.id('staff_gone'),
                                     'SUBMITTED', now() - interval '20 days')),
    -- shop_none: only ineligible receipts, so the shop must not appear.
    ('r_reserved', pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_none'), pg_temp.id('staff'), 'RESERVED')),
    ('r_failed',   pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_none'), pg_temp.id('staff'), 'UPLOAD_FAILED')),
    ('r_noobj',    pg_temp.new_receipt(pg_temp.id('retailer_a'), pg_temp.id('shop_none'), pg_temp.id('staff'),
                                       'SUBMITTED', now() - interval '3 days', false)),
    -- Foreign Vendor, and a Retailer behind a DEACTIVATED link.
    ('r_foreign',  pg_temp.new_receipt(pg_temp.id('retailer_b'), pg_temp.id('shop_b'), pg_temp.id('staff'),
                                       'SUBMITTED', now() - interval '2 days')),
    ('r_offlink',  pg_temp.new_receipt(pg_temp.id('retailer_x'), pg_temp.id('shop_x'), pg_temp.id('staff'),
                                       'SUBMITTED', now() - interval '4 days'));
end;
$$;

-- ============================================================================
-- SECTION A — the function exists, with the approved shape
-- ============================================================================
select is(
  (select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'list_claim_review_filter_options'),
  1,
  'A1. the function exists exactly once — no overload'
);

select is(
  (select p.pronargs::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'list_claim_review_filter_options'),
  0,
  'A2. and takes no arguments — there is no Vendor to supply'
);

select is(
  (select string_agg(n, ',' order by ord)
   from pg_proc p, unnest(p.proargnames) with ordinality as a(n, ord)
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'list_claim_review_filter_options'),
  'retailer_organization_id,retailer_name,retailer_shop_id,shop_name,shop_code,shop_status',
  'A3. returning exactly the six approved columns, in order'
);

select ok(
  (select p.prosecdef from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname = 'list_claim_review_filter_options'),
  'A4. it is SECURITY DEFINER'
);

select ok(
  (select 'search_path=""' = any(p.proconfig) from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'list_claim_review_filter_options'),
  'A5. with an empty search_path'
);

select is(
  (select p.provolatile::text from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname = 'list_claim_review_filter_options'),
  's',
  'A6. and is STABLE — it reads and never writes'
);

-- ============================================================================
-- SECTION B — who may call it, and who gets nothing
-- ============================================================================
select ok(
  has_function_privilege('authenticated', 'public.list_claim_review_filter_options()', 'EXECUTE'),
  'B1. authenticated may execute it'
);
select ok(
  not has_function_privilege('anon', 'public.list_claim_review_filter_options()', 'EXECUTE'),
  'B2. anon may not'
);
select ok(
  not has_function_privilege('public', 'public.list_claim_review_filter_options()', 'EXECUTE'),
  'B3. and neither may PUBLIC'
);
select ok(
  not has_function_privilege('service_role', 'public.list_claim_review_filter_options()', 'EXECUTE'),
  'B4. service_role is not granted — nothing server-side needs a filter list'
);

select pg_temp.act_as(pg_temp.id('reviewer'));
select ok(pg_temp.opt_rows() > 0, 'B5. the Vendor A reviewer receives options');

select pg_temp.act_as(pg_temp.id('vsa'));
select is(pg_temp.opt_rows(), 0,
  'B6. a Vendor Super Admin receives none through that role alone');

select pg_temp.act_as(pg_temp.id('owner'));
select is(pg_temp.opt_rows(), 0, 'B7. a Retailer Owner receives none');

select pg_temp.act_as(pg_temp.id('manager'));
select is(pg_temp.opt_rows(), 0, 'B8. a Retailer Manager receives none');

select pg_temp.act_as(pg_temp.id('staff'));
select is(pg_temp.opt_rows(), 0, 'B9. the submitting Sales Staff receives none');

select pg_temp.act_as(pg_temp.id('reviewer_off'));
select is(pg_temp.opt_rows(), 0, 'B10. a DEACTIVATED reviewer membership receives none');

select pg_temp.sign_out();
select is(pg_temp.opt_rows(), 0, 'B11. a signed-out caller receives none');

-- The permission, not merely the role, is what admits a caller.
select is(
  (select count(*)::integer from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'CLAIM_REVIEWER' and p.code = 'RECEIPT_REVIEW_READ'),
  1,
  'B12. the options are gated on RECEIPT_REVIEW_READ, which CLAIM_REVIEWER holds'
);

-- ============================================================================
-- SECTION C — tenant isolation
-- ============================================================================
select pg_temp.act_as(pg_temp.id('reviewer'));

select ok(pg_temp.has_retailer(pg_temp.id('retailer_a')),
  'C1. the reviewer''s own Retailer appears');
select ok(not pg_temp.has_retailer(pg_temp.id('retailer_b')),
  'C2. a FOREIGN Vendor''s Retailer never appears');
select ok(not pg_temp.has_shop(pg_temp.id('shop_b')),
  'C3. nor does its shop');
select ok(not pg_temp.has_retailer(pg_temp.id('retailer_x')),
  'C4. a DEACTIVATED vendor_retailers link removes the Retailer');
select ok(not pg_temp.has_shop(pg_temp.id('shop_x')),
  'C5. and its shop with it');

select pg_temp.act_as(pg_temp.id('reviewer_b'));
select ok(pg_temp.has_retailer(pg_temp.id('retailer_b')),
  'C6. the other Vendor''s own reviewer does see their Retailer');
select ok(not pg_temp.has_retailer(pg_temp.id('retailer_a')),
  'C7. and cannot see Vendor A''s — isolation runs both ways');

-- ============================================================================
-- SECTION D — options are derived only from PENDING eligible receipts
-- ============================================================================
select pg_temp.act_as(pg_temp.id('reviewer'));

select ok(pg_temp.has_shop(pg_temp.id('shop_a1')),
  'D1. a shop with a pending receipt appears');
select ok(pg_temp.has_shop(pg_temp.id('shop_a2')),
  'D2. as does a second such shop');

select ok(not pg_temp.has_retailer(pg_temp.id('retailer_q')),
  'D3. an ACTIVE-linked Retailer with NO pending receipt does not appear');
select ok(not pg_temp.has_shop(pg_temp.id('shop_q')),
  'D4. nor its shop');

select ok(not pg_temp.has_shop(pg_temp.id('shop_none')),
  'D5. a shop whose only receipts are RESERVED, UPLOAD_FAILED or object-less does not appear');

-- D7: history stays reachable.
select ok(pg_temp.has_shop(pg_temp.id('shop_gone')),
  'D6. a DEACTIVATED shop still appears while its receipt is pending');
select is(
  (select o.shop_status from public.list_claim_review_filter_options() o
    where o.retailer_shop_id = pg_temp.id('shop_gone')),
  'DEACTIVATED',
  'D7. and its current state is reported so the picker can label it'
);

-- Deciding the last pending receipt for a shop removes its option.
do $$
declare v_v uuid; v_rev uuid;
begin
  select o.id into v_v from public.organizations o where o.name = 'FO Vendor A';
  select v into v_rev from pg_temp.f where k = 'reviewer';
  insert into public.receipt_review_decisions
    (receipt_submission_id, vendor_organization_id, decision, decided_by_profile_id)
  values (pg_temp.id('r_a2'), v_v, 'VERIFIED', v_rev);
end;
$$;

select ok(not pg_temp.has_shop(pg_temp.id('shop_a2')),
  'D8. once its only receipt is decided, the shop leaves the picker');
select ok(pg_temp.has_shop(pg_temp.id('shop_a1')),
  'D9. while a shop with receipts still pending remains');

-- ============================================================================
-- SECTION E — shape of the result
-- ============================================================================
select is(
  (select count(*)::integer from public.list_claim_review_filter_options() o
    where o.retailer_shop_id = pg_temp.id('shop_a1')),
  1,
  'E1. a shop with TWO pending receipts yields ONE option — the pair is deduplicated'
);

select is(
  (select o.shop_code from public.list_claim_review_filter_options() o
    where o.retailer_shop_id = pg_temp.id('shop_a1')),
  'FO1',
  'E2. the shop code is returned when present'
);

select is(
  (select array_agg(o.retailer_shop_id order by ord)
   from (select retailer_shop_id, row_number() over () ord
         from public.list_claim_review_filter_options()) o),
  (select array_agg(x.retailer_shop_id order by x.retailer_name, x.shop_name, x.retailer_shop_id)
   from public.list_claim_review_filter_options() x),
  'E3. ordering is retailer_name, shop_name, shop id — deterministic and total'
);

-- ============================================================================
-- SECTION F — NO DRIFT from the queue's eligibility
-- ============================================================================
-- The two functions repeat their predicates rather than sharing a helper, so this is
-- the assertion that makes the duplication safe: every option must be backed by a
-- receipt the QUEUE actually returns, and every queued receipt must have an option.
select is(
  (select coalesce(array_agg(distinct o.retailer_shop_id order by o.retailer_shop_id), '{}')
   from public.list_claim_review_filter_options() o),
  (select coalesce(array_agg(distinct s.retailer_shop_id order by s.retailer_shop_id), '{}')
   from public.receipt_submissions s
   where s.id in (select q.receipt_submission_id from public.list_claim_review_queue(1000) q)),
  'F1. the option set is exactly the set of shops the queue is currently showing'
);

select is(
  (select count(*)::integer from public.list_claim_review_filter_options() o
    where not exists (
      select 1 from public.list_claim_review_queue(1000) q
      join public.receipt_submissions s on s.id = q.receipt_submission_id
      where s.retailer_shop_id = o.retailer_shop_id)),
  0,
  'F2. no option exists for a shop with nothing in the queue'
);

-- ============================================================================
-- SECTION G — nothing else moved
-- ============================================================================
select is(
  (select count(*)::integer from pg_proc p, unnest(p.proargnames) n
   where p.pronamespace = 'public'::regnamespace
     and p.proname = 'list_claim_review_filter_options'
     and n in ('storage_bucket', 'storage_object_path', 'file_sha256',
               'email', 'phone', 'submitted_by_profile_id', 'receipt_submission_id')),
  0,
  'G1. the output carries no bucket, path, hash, email, phone, profile or receipt id'
);

select is(
  (select mode from public.receipt_extraction_runtime),
  'DISABLED',
  'G2. receipt extraction is still DISABLED'
);

select is(
  (select count(*)::integer from public.receipt_extractions),
  0,
  'G3. no extraction row was created'
);

select is(
  (select count(*)::integer from public.receipt_confirmations),
  0,
  'G4. no Retailer confirmation was created'
);

select is(
  (select count(*)::integer from pg_policy p
    where p.polrelid = 'public.receipt_review_decisions'::regclass),
  0,
  'G5. the decision table still has zero direct policies'
);

select is(
  (select count(*)::integer from public.permissions where code like 'RECEIPT_REVIEW%'),
  2,
  'G6. no new permission was added by this migration'
);

select is(
  (select string_agg(p.code, ',' order by p.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where r.code = 'CLAIM_REVIEWER'),
  'CLAIM_REVIEW_PORTAL_READ,RECEIPT_REVIEW_DECIDE,RECEIPT_REVIEW_READ',
  'G7. and CLAIM_REVIEWER still holds exactly its three permissions'
);

select ok(
  not has_function_privilege('authenticated',
    'public.resolve_claim_reviewer_organization(text)', 'EXECUTE'),
  'G8. the internal resolver keeps its privilege boundary'
);

select pg_temp.sign_out();

select * from finish();
rollback;
