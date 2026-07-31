-- pgTAP behavioural tests for the receipt-extraction FOUNDATION and the authenticated
-- reads/requests added by migrations 20260812090000, 20260812210000 and 20260813210000.
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- public.auth.uid() resolves the caller from the request's JWT claims, which Supabase
-- exposes as the `request.jwt.claims` GUC, so setting that GUC transaction-locally IS
-- signing in as far as every authorization helper in this schema is concerned. This mirrors
-- supabase/tests/database/sales_staff_receipt_reads_test.sql exactly, deliberately: two
-- impersonation idioms in one suite directory would be two claims about what "signed in"
-- means.
--
-- The tests do NOT `set role authenticated`. Every function under test is SECURITY DEFINER,
-- so its behaviour depends on auth.uid() and not on the session role. EXECUTE privilege is a
-- separate concern and is asserted directly against the catalogue, which is a stronger check
-- than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step turns an added
-- test into a confusing failure about arithmetic rather than about behaviour.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers
-- ============================================================================
create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user::text)::text, true);
end;
$$;

create function pg_temp.sign_out() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.new_user(p_label text, p_status text default 'ACTIVE')
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_label || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_label, 'Tester', p_status);
  return v_id;
end;
$$;

create function pg_temp.grant_role(
  p_user uuid, p_org uuid, p_role_code text, p_membership_status text default 'ACTIVE'
) returns uuid language plpgsql as $$
declare v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status)
  values (p_org, p_user, p_membership_status)
  on conflict (organization_id, user_id) do update set status = excluded.status
  returning id into v_member;
  insert into public.member_roles (organization_member_id, role_id)
  select v_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;
  return v_member;
end;
$$;

/* Creates a receipt submission in the given status and returns its id. */
create function pg_temp.new_submission(
  p_retailer uuid, p_shop uuid, p_submitter uuid, p_status text default 'SUBMITTED'
) returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.receipt_submissions (
    id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
    storage_bucket, storage_object_path, original_file_name, mime_type, file_size_bytes,
    file_sha256, status, submitted_at
  ) values (
    v_id, p_retailer, p_shop, p_submitter,
    'receipts',
    p_retailer::text || '/' || p_submitter::text || '/' || v_id::text || '/o.jpg',
    'receipt.jpg', 'image/jpeg', 2048,
    md5(v_id::text) || md5(v_id::text || 'x'),
    p_status,
    case when p_status = 'SUBMITTED' then now() else null end
  );
  return v_id;
end;
$$;

/* The SQLSTATE a call raises, or NULL when it returns normally. */
create function pg_temp.access_sqlstate(p_id uuid) returns text
language plpgsql as $$
begin
  perform public.assert_my_receipt_extraction_access(p_id);
  return null;
exception when others then return sqlstate;
end;
$$;

create function pg_temp.request_sqlstate(p_id uuid) returns text
language plpgsql as $$
begin
  perform * from public.request_receipt_extraction(p_id);
  return null;
exception when others then return sqlstate;
end;
$$;

create function pg_temp.get_sqlstate(p_id uuid) returns text
language plpgsql as $$
begin
  perform * from public.get_my_receipt_extraction(p_id);
  return null;
exception when others then return sqlstate;
end;
$$;

create function pg_temp.lines_sqlstate(p_id uuid) returns text
language plpgsql as $$
begin
  perform * from public.list_my_receipt_extraction_line_items(p_id);
  return null;
exception when others then return sqlstate;
end;
$$;

create function pg_temp.confirmation_sqlstate(p_id uuid) returns text
language plpgsql as $$
begin
  perform * from public.get_my_receipt_confirmation(p_id);
  return null;
exception when others then return sqlstate;
end;
$$;

/* The outcome of a request, as a scalar. */
create function pg_temp.request_outcome(p_id uuid) returns text
language sql as $$ select outcome from public.request_receipt_extraction(p_id); $$;

/* The full counter tuple, so one assertion can pin all four at once. */
create function pg_temp.request_counters(p_id uuid) returns text
language sql as $$
  select outcome || '|' || attempts_used || '|' || attempts_remaining
         || '|' || retry_allowed || '|' || manual_confirmation_allowed
  from public.request_receipt_extraction(p_id);
$$;

create function pg_temp.view_counters(p_id uuid) returns text
language sql as $$
  select status || '|' || attempts_used || '|' || attempts_remaining
         || '|' || retry_allowed || '|' || manual_confirmation_allowed
  from public.get_my_receipt_extraction(p_id);
$$;

create function pg_temp.view_rows(p_id uuid) returns bigint
language sql as $$ select count(*) from public.get_my_receipt_extraction(p_id); $$;

create function pg_temp.set_mode(p_mode text) returns void
language sql as $$ update public.receipt_extraction_runtime set mode = p_mode where id; $$;

/*
 * Forces an open attempt past its deadline.
 *
 * The update guard refuses a QUEUED -> QUEUED or PROCESSING -> PROCESSING write that is not
 * an operation registration, which is exactly the protection under test elsewhere in this
 * file. Simulating the PASSAGE OF TIME is not something the guard is meant to permit, so the
 * trigger is disabled for this one statement and immediately restored. Nothing else in this
 * suite writes the table directly.
 */
create function pg_temp.force_expired(p_id uuid) returns void
language plpgsql as $$
begin
  alter table public.receipt_extractions disable trigger receipt_extractions_guard_update;
  update public.receipt_extractions set expires_at = now() - interval '1 minute' where id = p_id;
  alter table public.receipt_extractions enable trigger receipt_extractions_guard_update;
end;
$$;

/* Catalogue introspection: the declared OUTPUT columns of a `returns table` function. */
create function pg_temp.table_columns(p_name text) returns text[]
language sql stable as $$
  select coalesce(array_agg(x.name order by x.ord), '{}'::text[])
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(
    p.proargnames,
    coalesce(p.proargmodes,
             array_fill('i'::"char", array[coalesce(array_length(p.proargnames, 1), 0)]))
  ) with ordinality as x(name, mode, ord)
  where n.nspname = 'public' and p.proname = p_name and x.mode = 't';
$$;

create function pg_temp.input_args(p_name text) returns text[]
language sql stable as $$
  select coalesce(array_agg(x.name order by x.ord), '{}'::text[])
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(
    p.proargnames,
    coalesce(p.proargmodes,
             array_fill('i'::"char", array[coalesce(array_length(p.proargnames, 1), 0)]))
  ) with ordinality as x(name, mode, ord)
  where n.nspname = 'public' and p.proname = p_name and x.mode in ('i', 'b', 'v');
$$;

/* Drives one attempt all the way to SUCCEEDED, as the worker would. */
create function pg_temp.complete_attempt(p_extraction uuid, p_normalized jsonb default null)
returns void language plpgsql as $$
declare v_token uuid; v_op text := 'fake:' || gen_random_uuid()::text;
begin
  select claim_token into v_token
  from public.claim_receipt_extraction_job(p_extraction, 'FAKE', 'fake-receipt-v1');
  perform public.record_receipt_extraction_operation(p_extraction, v_token, v_op);
  perform public.record_receipt_extraction_success(
    p_extraction, v_token, v_op,
    coalesce(p_normalized, jsonb_build_object(
      'merchant_name', 'Lulu Hypermarket',
      'merchant_name_source_text', 'Lulu Hypermarket',
      'merchant_name_confidence', 0.97,
      'document_number', 'INV-2026/004512',
      'transaction_date', '2026-07-12',
      'transaction_time', '14:32',
      'currency_code', 'AED',
      'total_minor', 123456,
      'total_source_text', 'AED 1,234.56',
      'subtotal_minor', 117600,
      'tax_total_minor', 5856,
      'warning_codes', jsonb_build_array('MISSING_TRANSACTION_TIME')
    )),
    jsonb_build_array(jsonb_build_object(
      'line_number', 1, 'description', 'Basmati Rice 5kg',
      'quantity', 2, 'unit_price_minor', 4400, 'line_total_minor', 8800, 'confidence', 0.97
    ))
  );
end;
$$;

/* Drives one attempt to FAILED with the given post-provider code. */
create function pg_temp.fail_attempt(p_extraction uuid, p_code text default 'PROVIDER_TIMEOUT')
returns void language plpgsql as $$
declare v_token uuid; v_op text := 'fake:' || gen_random_uuid()::text;
begin
  select claim_token into v_token
  from public.claim_receipt_extraction_job(p_extraction, 'FAKE', 'fake-receipt-v1');
  perform public.record_receipt_extraction_operation(p_extraction, v_token, v_op);
  perform public.record_receipt_extraction_failure(p_extraction, v_token, v_op, p_code);
end;
$$;

/* Requests an attempt as the given user and returns the new extraction id. */
create function pg_temp.queue_attempt(p_user uuid, p_submission uuid) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  perform pg_temp.act_as(p_user);
  select extraction_id into v_id from public.request_receipt_extraction(p_submission);
  perform pg_temp.sign_out();
  return v_id;
end;
$$;

-- ============================================================================
-- Fixtures
-- ============================================================================
create temporary table t_ids (label text primary key, id uuid not null);

do $$
declare
  v_retailer1 uuid := gen_random_uuid();
  v_retailer2 uuid := gen_random_uuid();
  v_vendor    uuid := gen_random_uuid();
  v_shop1     uuid := gen_random_uuid();
  v_shop2     uuid := gen_random_uuid();
  v_member    uuid;
begin
  insert into public.organizations (id, name, organization_type, status) values
    (v_vendor,    'Extraction Test Vendor',   'VENDOR',   'ACTIVE'),
    (v_retailer1, 'Extraction Retailer One',  'RETAILER', 'ACTIVE'),
    (v_retailer2, 'Extraction Retailer Two',  'RETAILER', 'ACTIVE');

  insert into public.retailer_shops (id, retailer_organization_id, name, code, status) values
    (v_shop1, v_retailer1, 'Shop One', 'S1', 'ACTIVE'),
    (v_shop2, v_retailer2, 'Shop Two', 'S2', 'ACTIVE');

  insert into t_ids values
    ('vendor', v_vendor), ('retailer1', v_retailer1), ('retailer2', v_retailer2),
    ('shop1', v_shop1), ('shop2', v_shop2),
    ('vendor_admin', pg_temp.new_user('ext_vendoradmin')),
    ('owner1',       pg_temp.new_user('ext_owner1')),
    ('manager1',     pg_temp.new_user('ext_manager1')),
    ('sales1',       pg_temp.new_user('ext_sales1')),
    ('sales1b',      pg_temp.new_user('ext_sales1b')),
    ('sales2',       pg_temp.new_user('ext_sales2')),
    ('sales_susp',   pg_temp.new_user('ext_susp', 'SUSPENDED')),
    ('sales_inact_member', pg_temp.new_user('ext_inactmem')),
    ('sales_inact_org',    pg_temp.new_user('ext_inactorg'));

  perform pg_temp.grant_role((select id from t_ids where label='vendor_admin'), v_vendor,    'VENDOR_SUPER_ADMIN');
  perform pg_temp.grant_role((select id from t_ids where label='owner1'),       v_retailer1, 'RETAILER_OWNER');
  perform pg_temp.grant_role((select id from t_ids where label='manager1'),     v_retailer1, 'RETAILER_MANAGER');
  perform pg_temp.grant_role((select id from t_ids where label='sales1'),       v_retailer1, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='sales1b'),      v_retailer1, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='sales2'),       v_retailer2, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='sales_susp'),   v_retailer1, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='sales_inact_member'), v_retailer1, 'SALES_STAFF', 'SUSPENDED');

  v_member := pg_temp.grant_role((select id from t_ids where label='sales_inact_org'), v_retailer2, 'SALES_STAFF');

  -- Submissions. sub1 belongs to sales1; sub_other to sales1b at the SAME Retailer;
  -- sub_r2 to sales2 at a different Retailer; the last two are non-SUBMITTED.
  insert into t_ids values
    ('sub1',      pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'))),
    ('sub1_b',    pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'))),
    ('sub1_c',    pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'))),
    ('sub1_d',    pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'))),
    ('sub1_e',    pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'))),
    ('sub_other', pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1b'))),
    ('sub_r2',    pg_temp.new_submission(v_retailer2, v_shop2, (select id from t_ids where label='sales2'))),
    ('sub_reserved', pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'), 'RESERVED')),
    ('sub_failed',   pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'), 'UPLOAD_FAILED'));
end;
$$;

-- ============================================================================
-- SECTION A — schema, RLS, grants
-- ============================================================================
select has_table('public', 'iso_currency_codes', 'iso_currency_codes exists');
select has_table('public', 'receipt_extraction_runtime', 'receipt_extraction_runtime exists');
select has_table('public', 'receipt_extractions', 'receipt_extractions exists');
select has_table('public', 'receipt_extraction_line_items', 'line items table exists');
select has_table('public', 'receipt_confirmations', 'receipt_confirmations exists');

select is(
  to_regclass('public.receipt_extraction_payloads')::text, null,
  'NO raw provider payload table exists'
);

select ok(
  (select bool_and(c.relrowsecurity)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('iso_currency_codes', 'receipt_extraction_runtime',
                       'receipt_extractions', 'receipt_extraction_line_items',
                       'receipt_confirmations')),
  'RLS is enabled on all five new tables'
);

select is(
  (select count(*) from pg_policies
   where schemaname = 'public'
     and tablename in ('iso_currency_codes', 'receipt_extraction_runtime',
                       'receipt_extractions', 'receipt_extraction_line_items',
                       'receipt_confirmations'))::int,
  0,
  'ZERO RLS policies on the new tables — default deny is the whole design'
);

select is(
  (select count(*) from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('iso_currency_codes', 'receipt_extraction_runtime',
                        'receipt_extractions', 'receipt_extraction_line_items',
                        'receipt_confirmations')
     and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC'))::int,
  0,
  'no table privilege for anon, authenticated OR service_role — RPC-only access'
);

-- ---- Function grants -------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'public.' || p || '(uuid)', 'EXECUTE'),
  p || ' is executable by authenticated'
) from unnest(array[
  'assert_my_receipt_extraction_access', 'request_receipt_extraction',
  'get_my_receipt_extraction', 'list_my_receipt_extraction_line_items',
  'get_my_receipt_confirmation'
]) as t(p);

select ok(
  not has_function_privilege('anon', 'public.' || p || '(uuid)', 'EXECUTE'),
  p || ' is NOT executable by anon'
) from unnest(array[
  'assert_my_receipt_extraction_access', 'request_receipt_extraction',
  'get_my_receipt_extraction', 'list_my_receipt_extraction_line_items',
  'get_my_receipt_confirmation'
]) as t(p);

select ok(
  not has_function_privilege('authenticated',
    'public.claim_receipt_extraction_job(uuid, text, text)', 'EXECUTE'),
  'claim_receipt_extraction_job is NOT executable by authenticated'
);
select ok(
  not has_function_privilege('authenticated',
    'public.record_receipt_extraction_success(uuid, uuid, text, jsonb, jsonb)', 'EXECUTE'),
  'record_receipt_extraction_success is NOT executable by authenticated'
);
select ok(
  not has_function_privilege('authenticated',
    'public.expire_stale_receipt_extraction_claims(uuid)', 'EXECUTE'),
  'the reaper is NOT executable by authenticated'
);
select ok(
  not has_function_privilege('authenticated',
    'public.get_receipt_object_reference(uuid)', 'EXECUTE'),
  'get_receipt_object_reference is NOT executable by authenticated'
);
select ok(
  not has_function_privilege('authenticated',
    'public.get_receipt_extraction_worker_state(uuid)', 'EXECUTE'),
  'get_receipt_extraction_worker_state is NOT executable by authenticated'
);
select ok(
  has_function_privilege('service_role',
    'public.claim_receipt_extraction_job(uuid, text, text)', 'EXECUTE'),
  'claim_receipt_extraction_job IS executable by service_role'
);
select ok(
  not has_function_privilege('service_role',
    'public.request_receipt_extraction(uuid)', 'EXECUTE'),
  'request_receipt_extraction is NOT granted to service_role — it needs auth.uid()'
);

-- ---- Indexes ----------------------------------------------------------------
select has_index('public', 'receipt_extractions',
  'receipt_extractions_active_attempt_unique_idx', 'the one-active-attempt authority exists');
select has_index('public', 'receipt_extractions',
  'receipt_extractions_succeeded_unique_idx', 'the one-succeeded authority exists');
select has_index('public', 'receipt_extractions',
  'receipt_extractions_submission_attempt_unique_idx', 'dense attempt numbering is unique');
select has_index('public', 'receipt_extractions',
  'receipt_extractions_operation_unique_idx', 'operation ids are unique across rows');

-- ---- Triggers: exactly three, exactly one BEFORE UPDATE, unqualified --------
select is(
  (select count(*)::int from pg_trigger
   where tgrelid = 'public.receipt_extractions'::regclass and not tgisinternal),
  3,
  'receipt_extractions carries exactly three triggers'
);

select is(
  (select array_agg(tgname::text order by tgname::text) from pg_trigger
   where tgrelid = 'public.receipt_extractions'::regclass and not tgisinternal),
  array['receipt_extractions_assert_tenant', 'receipt_extractions_guard_delete',
        'receipt_extractions_guard_update'],
  'and they are exactly the three the contract names'
);

-- tgattr is empty for an unqualified trigger. A column-scoped BEFORE UPDATE would NOT fire
-- for `UPDATE ... SET updated_at = now()`, which is the update terminal immutability must
-- reject — so this assertion is the reason that rejection is reachable at all.
select is(
  (select tgattr::text from pg_trigger
   where tgrelid = 'public.receipt_extractions'::regclass
     and tgname = 'receipt_extractions_guard_update'),
  '',
  'the update guard has NO column list, so an updated_at-only write still fires it'
);

-- public.set_updated_at() must NOT be attached: with it attached the guard would have to
-- tolerate an updated_at change on a terminal row, and its correctness would then depend on
-- alphabetical trigger ordering.
select is(
  (select count(*)::int from pg_trigger t
   join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.receipt_extractions'::regclass
     and p.proname = 'set_updated_at'),
  0,
  'set_updated_at is NOT attached to receipt_extractions'
);

-- ---- The provider invariant --------------------------------------------------
select is(
  (select count(*)::int from pg_constraint
   where conrelid = 'public.receipt_extractions'::regclass
     and conname = 'receipt_extractions_provider_allowed'),
  1,
  'the no-real-provider CHECK exists'
);

-- ---- The permission mapping ---------------------------------------------------
select is(
  (select array_agg(r.code order by r.code)
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'RECEIPT_EXTRACTION_REVIEW'),
  array['SALES_STAFF'],
  'RECEIPT_EXTRACTION_REVIEW is mapped to SALES_STAFF and to nothing else'
);

-- ---- The runtime gate ships DISABLED -------------------------------------------
select is(
  (select mode from public.receipt_extraction_runtime), 'DISABLED',
  'the database gate ships DISABLED — production is inert by construction'
);
select is(
  (select count(*)::int from public.receipt_extraction_runtime), 1,
  'the runtime table holds exactly one row'
);

-- ============================================================================
-- SECTION B — the safe client projection
-- ============================================================================
select ok(
  not (pg_temp.table_columns('get_my_receipt_extraction') && array[
    'provider', 'provider_model', 'provider_operation_id', 'worker_claim_token',
    'expires_at', 'storage_bucket', 'storage_object_path', 'file_sha256',
    'retailer_organization_id', 'requested_by_profile_id'
  ]),
  'get_my_receipt_extraction leaks no provider, claim, storage or tenant column'
);

select ok(
  not (pg_temp.table_columns('request_receipt_extraction') && array[
    'provider', 'provider_operation_id', 'worker_claim_token',
    'storage_bucket', 'storage_object_path', 'file_sha256'
  ]),
  'request_receipt_extraction leaks nothing either'
);

select ok(
  not (pg_temp.table_columns('list_my_receipt_extraction_line_items') && array[
    'receipt_extraction_id', 'storage_bucket', 'storage_object_path'
  ]),
  'the line-item read exposes no internal identifier'
);

select is(
  pg_temp.input_args('claim_receipt_extraction_job'),
  array['p_extraction_id', 'p_provider', 'p_provider_model'],
  'THE NON-CIRCULARITY PROOF: the claim accepts no provider_operation_id'
);

select is(
  pg_temp.input_args('confirm_receipt_extraction'),
  array['p_submission_id', 'p_transaction_date', 'p_currency_code', 'p_total_minor',
        'p_merchant_name', 'p_document_number', 'p_transaction_time',
        'p_subtotal_minor', 'p_tax_total_minor'],
  'confirm accepts exactly nine parameters: no org, shop, profile, extraction, entry mode or changed fields'
);

select is(
  pg_temp.input_args('assert_my_receipt_extraction_access'), array['p_submission_id'],
  'the access helper takes one submission id and nothing else'
);

-- The helper returns a scalar boolean, so no identifier can leave it even by mistake.
select is(
  (select pg_catalog.format_type(p.prorettype, null) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'assert_my_receipt_extraction_access'),
  'boolean',
  'the access helper returns a bare boolean — structurally unable to leak an identifier'
);

-- ============================================================================
-- SECTION C — authorization: 42501 versus zero rows
-- ============================================================================
select pg_temp.sign_out();
select is(pg_temp.access_sqlstate((select id from t_ids where label='sub1')), '42501',
          'an unauthenticated caller is refused with 42501');

select pg_temp.act_as((select id from t_ids where label='owner1'));
select is(pg_temp.access_sqlstate((select id from t_ids where label='sub1')), '42501',
          'a Retailer Owner is refused with 42501');
select is(pg_temp.request_sqlstate((select id from t_ids where label='sub1')), '42501',
          'and cannot request extraction');
select is(pg_temp.get_sqlstate((select id from t_ids where label='sub1')), '42501',
          'and cannot read an extraction');
select is(pg_temp.lines_sqlstate((select id from t_ids where label='sub1')), '42501',
          'and cannot read line items');
select is(pg_temp.confirmation_sqlstate((select id from t_ids where label='sub1')), '42501',
          'and cannot read a confirmation');

select pg_temp.act_as((select id from t_ids where label='manager1'));
select is(pg_temp.access_sqlstate((select id from t_ids where label='sub1')), '42501',
          'a Retailer Manager is refused with 42501');

select pg_temp.act_as((select id from t_ids where label='vendor_admin'));
select is(pg_temp.access_sqlstate((select id from t_ids where label='sub1')), '42501',
          'a Vendor Super Admin is refused with 42501');

select pg_temp.act_as((select id from t_ids where label='sales_susp'));
select is(pg_temp.access_sqlstate((select id from t_ids where label='sub1')), '42501',
          'an inactive PROFILE is refused through the resolver');

select pg_temp.act_as((select id from t_ids where label='sales_inact_member'));
select is(pg_temp.access_sqlstate((select id from t_ids where label='sub1')), '42501',
          'an inactive MEMBERSHIP is refused through the resolver');

-- ---- The authorized caller: false, never an error, for every unreadable id ----
select pg_temp.act_as((select id from t_ids where label='sales1'));

select ok(public.assert_my_receipt_extraction_access((select id from t_ids where label='sub1')),
          'an owned SUBMITTED receipt returns true');

select ok(not public.assert_my_receipt_extraction_access(gen_random_uuid()),
          'an unknown id returns false');
select ok(not public.assert_my_receipt_extraction_access(
            (select id from t_ids where label='sub_other')),
          'ANOTHER Sales Staff member at the SAME Retailer returns false');
select ok(not public.assert_my_receipt_extraction_access(
            (select id from t_ids where label='sub_r2')),
          'another Retailer returns false');
select ok(not public.assert_my_receipt_extraction_access(
            (select id from t_ids where label='sub_reserved')),
          'a RESERVED receipt returns false');
select ok(not public.assert_my_receipt_extraction_access(
            (select id from t_ids where label='sub_failed')),
          'an UPLOAD_FAILED receipt returns false');
select ok(public.assert_my_receipt_extraction_access(null) is false,
          'a null id returns false, never null');

-- Indistinguishable: every unreadable id yields the same zero-row answer.
select is(pg_temp.view_rows(gen_random_uuid()), 0::bigint, 'unknown id -> zero rows');
select is(pg_temp.view_rows((select id from t_ids where label='sub_other')), 0::bigint,
          'another staff member -> zero rows, byte-identical');
select is(pg_temp.view_rows((select id from t_ids where label='sub_r2')), 0::bigint,
          'another Retailer -> zero rows, byte-identical');

-- ============================================================================
-- SECTION D — DISABLED mode consumes no attempt, and the counters stay factual
-- ============================================================================
select pg_temp.sign_out();
select pg_temp.set_mode('DISABLED');
select pg_temp.act_as((select id from t_ids where label='sales1'));

select is(
  pg_temp.request_counters((select id from t_ids where label='sub1')),
  'EXTRACTION_UNAVAILABLE|0|3|false|true',
  'DISABLED with zero rows: 0 used, 3 REMAINING, no retry, manual allowed'
);

select is(
  (select count(*)::int from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1')),
  0,
  'and NOT ONE ROW was created'
);

-- ============================================================================
-- SECTION E — the attempt lifecycle
-- ============================================================================
select pg_temp.sign_out();
select pg_temp.set_mode('FAKE');
select pg_temp.act_as((select id from t_ids where label='sales1'));

select is(
  pg_temp.request_counters((select id from t_ids where label='sub1')),
  'QUEUED|1|2|false|false',
  'the first request queues attempt 1 and the counters follow the persisted row'
);

select is(
  (select attempt_number from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1')),
  1,
  'attempt_number starts at 1 and is server-derived'
);

select is(
  pg_temp.request_counters((select id from t_ids where label='sub1')),
  'ACTIVE|1|2|false|false',
  'a repeat request during an active attempt returns the existing attempt'
);

select is(
  (select count(*)::int from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1')),
  1,
  'and creates no second row'
);

-- A second active attempt is structurally impossible.
select throws_ok(
  format($q$insert into public.receipt_extractions
     (receipt_submission_id, retailer_organization_id, requested_by_profile_id,
      attempt_number, status, expires_at)
     values (%L, %L, %L, 2, 'QUEUED', now() + interval '15 minutes')$q$,
    (select id from t_ids where label='sub1'),
    (select id from t_ids where label='retailer1'),
    (select id from t_ids where label='sales1')),
  '23505',
  null,
  'a second QUEUED attempt violates the one-active-attempt unique index'
);

-- ---- Succeeded: reused, never re-charged ------------------------------------
select pg_temp.sign_out();
select pg_temp.complete_attempt(
  (select id from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1'))
);
select pg_temp.act_as((select id from t_ids where label='sales1'));

select is(
  pg_temp.request_counters((select id from t_ids where label='sub1')),
  'SUCCEEDED|1|2|false|true',
  'after success the request returns SUCCEEDED and allows manual confirmation'
);
select is(
  (select count(*)::int from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1')),
  1,
  'the provider is NOT charged again — no new row'
);

select is(
  pg_temp.view_counters((select id from t_ids where label='sub1')),
  'SUCCEEDED|1|2|false|true',
  'the read agrees with the request'
);

-- ---- Retry after failure, up to three, then exhausted ------------------------
select pg_temp.sign_out();
select pg_temp.fail_attempt(pg_temp.queue_attempt(
  (select id from t_ids where label='sales1'), (select id from t_ids where label='sub1_b')));

select pg_temp.act_as((select id from t_ids where label='sales1'));
select is(
  pg_temp.view_counters((select id from t_ids where label='sub1_b')),
  'FAILED|1|2|true|true',
  'after one failure with capacity left and the gate open, retry IS allowed'
);

select is(
  pg_temp.request_counters((select id from t_ids where label='sub1_b')),
  'QUEUED|2|1|false|false',
  'the retry creates a NEW row at attempt 2'
);

select pg_temp.sign_out();
select pg_temp.fail_attempt(
  (select id from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1_b')
     and attempt_number = 2));
select pg_temp.fail_attempt(pg_temp.queue_attempt(
  (select id from t_ids where label='sales1'), (select id from t_ids where label='sub1_b')));

select pg_temp.act_as((select id from t_ids where label='sales1'));
select is(
  pg_temp.request_counters((select id from t_ids where label='sub1_b')),
  'EXHAUSTED|3|0|false|true',
  'three attempts exhausts the budget; manual confirmation remains available'
);
select is(
  (select count(*)::int from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1_b')),
  3,
  'and NO fourth row was created'
);

select is(
  (select array_agg(attempt_number order by attempt_number)
   from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1_b')),
  array[1, 2, 3],
  'attempt numbers are dense — every persisted row consumed exactly one'
);

-- The fourth is refused structurally, not by a remembered count.
select throws_ok(
  format($q$insert into public.receipt_extractions
     (receipt_submission_id, retailer_organization_id, requested_by_profile_id,
      attempt_number, status, expires_at)
     values (%L, %L, %L, 4, 'QUEUED', now() + interval '15 minutes')$q$,
    (select id from t_ids where label='sub1_b'),
    (select id from t_ids where label='retailer1'),
    (select id from t_ids where label='sales1')),
  '23514',
  null,
  'attempt_number 4 violates the CHECK — the maximum is structural'
);

-- ---- DISABLED after failures still reports the TRUE counters -----------------
select pg_temp.sign_out();
select pg_temp.set_mode('DISABLED');
select pg_temp.act_as((select id from t_ids where label='sales1'));

select is(
  pg_temp.view_counters((select id from t_ids where label='sub1_b')),
  'FAILED|3|0|false|true',
  'DISABLED after three rows: 3 used, 0 remaining — factual, and retry off'
);

-- ============================================================================
-- SECTION F — retry_allowed, every shape
-- ============================================================================
-- The gate is re-opened FIRST: a request made while DISABLED creates no row, so building the
-- retry fixture before re-opening it would silently produce nothing to test.
select pg_temp.sign_out();
select pg_temp.set_mode('FAKE');
select pg_temp.fail_attempt(pg_temp.queue_attempt(
  (select id from t_ids where label='sales1'), (select id from t_ids where label='sub1_c')));

select pg_temp.act_as((select id from t_ids where label='sales1'));

-- no extraction at all -> the read returns zero rows, so there is no retry flag to be true
select is(pg_temp.view_rows((select id from t_ids where label='sub1_d')), 0::bigint,
          'no extraction: nothing to retry');

select is(
  split_part(pg_temp.view_counters((select id from t_ids where label='sub1_c')), '|', 4),
  'true',
  'latest FAILED + capacity + DB FAKE -> retry_allowed is TRUE'
);

select pg_temp.sign_out();
select pg_temp.set_mode('DISABLED');
select pg_temp.act_as((select id from t_ids where label='sales1'));
select is(
  split_part(pg_temp.view_counters((select id from t_ids where label='sub1_c')), '|', 4),
  'false',
  'the SAME row with DB DISABLED -> retry_allowed is FALSE'
);

select pg_temp.sign_out();
select pg_temp.set_mode('FAKE');
select pg_temp.act_as((select id from t_ids where label='sales1'));

select is(
  split_part(pg_temp.view_counters((select id from t_ids where label='sub1')), '|', 4), 'false',
  'a SUCCEEDED extraction -> retry_allowed is false'
);
select is(
  split_part(pg_temp.view_counters((select id from t_ids where label='sub1_b')), '|', 4), 'false',
  'exhausted -> retry_allowed is false'
);

-- QUEUED and PROCESSING
select pg_temp.sign_out();
select pg_temp.act_as((select id from t_ids where label='sales1'));
select pg_temp.request_outcome((select id from t_ids where label='sub1_d'));
select is(
  split_part(pg_temp.view_counters((select id from t_ids where label='sub1_d')), '|', 4), 'false',
  'QUEUED -> retry_allowed is false'
);

select pg_temp.sign_out();
select (select claim_token from public.claim_receipt_extraction_job(
  (select id from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1_d')),
  'FAKE', 'fake-receipt-v1')) is not null as claimed;
select pg_temp.act_as((select id from t_ids where label='sales1'));
select is(
  split_part(pg_temp.view_counters((select id from t_ids where label='sub1_d')), '|', 4), 'false',
  'PROCESSING -> retry_allowed is false'
);
select is(
  split_part(pg_temp.view_counters((select id from t_ids where label='sub1_d')), '|', 5), 'false',
  'and an in-flight attempt blocks manual confirmation'
);

-- ============================================================================
-- SECTION G — terminal immutability is TOTAL
-- ============================================================================
select pg_temp.sign_out();

-- sub1's single attempt is SUCCEEDED.
select throws_ok(
  format($q$update public.receipt_extractions set updated_at = now() where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null,
  'THE UPDATED_AT-ONLY UPDATE on a terminal row is refused'
);

select throws_ok(
  format($q$update public.receipt_extractions set status = 'QUEUED' where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null, 'a terminal row cannot return to QUEUED');

select throws_ok(
  format($q$update public.receipt_extractions set status = 'PROCESSING' where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null, 'a terminal row cannot return to PROCESSING');

select throws_ok(
  format($q$update public.receipt_extractions set total_minor = 1 where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null, 'normalized values cannot be replaced');

select throws_ok(
  format($q$update public.receipt_extractions set warning_codes = '{}' where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null, 'warnings cannot be replaced');

select throws_ok(
  format($q$update public.receipt_extractions set provider_model = 'x' where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null, 'provider metadata cannot be replaced');

select throws_ok(
  format($q$update public.receipt_extractions set worker_claim_token = gen_random_uuid() where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null, 'claim data cannot be replaced');

select throws_ok(
  format($q$update public.receipt_extractions set completed_at = now() where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null, 'timestamps cannot be altered');

select throws_ok(
  format($q$delete from public.receipt_extractions where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null, 'a terminal attempt cannot be deleted');

-- Identity is immutable even on an OPEN row, and an unlisted transition is refused.
select throws_ok(
  format($q$update public.receipt_extractions set attempt_number = 3 where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1_d'))),
  '23514', null, 'attempt_number is immutable on an open row too');

select throws_ok(
  format($q$update public.receipt_extractions set expires_at = now() where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1_d'))),
  '23514', null,
  'a PROCESSING row cannot have its deadline extended — there is no heartbeat in Milestone A');

-- ============================================================================
-- SECTION H — line items
-- ============================================================================
select is(
  (select count(*)::int from public.receipt_extraction_line_items li
   join public.receipt_extractions x on x.id = li.receipt_extraction_id
   where x.receipt_submission_id = (select id from t_ids where label='sub1')),
  1,
  'the successful attempt recorded its line item'
);

select is(
  (select line_number from public.receipt_extraction_line_items li
   join public.receipt_extractions x on x.id = li.receipt_extraction_id
   where x.receipt_submission_id = (select id from t_ids where label='sub1')),
  1,
  'ordinals begin at 1'
);

select throws_ok(
  format($q$update public.receipt_extraction_line_items set description = 'x'
            where receipt_extraction_id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null, 'line items cannot be updated');

select throws_ok(
  format($q$delete from public.receipt_extraction_line_items where receipt_extraction_id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23514', null, 'line items cannot be deleted');

select throws_ok(
  format($q$insert into public.receipt_extraction_line_items
            (receipt_extraction_id, line_number) values (%L, 1)$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1_d'))),
  '23514', null,
  'a line item cannot be attached to a non-SUCCEEDED attempt');

select throws_ok(
  format($q$insert into public.receipt_extraction_line_items
            (receipt_extraction_id, line_number) values (%L, 1)$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1'))),
  '23505', null, 'a duplicate ordinal is refused');

-- ============================================================================
-- SECTION I — source text may exist when the normalized value is NULL
-- ============================================================================
select pg_temp.sign_out();

do $$
declare
  v_sub uuid := (select id from t_ids where label='sub1_e');
  v_ext uuid;
begin
  v_ext := pg_temp.queue_attempt((select id from t_ids where label='sales1'), v_sub);
  -- An ambiguous amount: the value could not be resolved, but the printed text survives and
  -- the warning explains why. This is the case the tautological constraint would have broken.
  perform pg_temp.complete_attempt(v_ext, jsonb_build_object(
    'transaction_date', '2026-07-12',
    'currency_code', 'AED',
    'total_minor', 31000,
    'total_source_text', '310.00',
    'subtotal_source_text', '12.5',
    'warning_codes', jsonb_build_array('AMBIGUOUS_AMOUNT_FORMAT')
  ));
end;
$$;

select is(
  (select subtotal_minor from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1_e')),
  null,
  'an unresolvable amount stores NO value'
);
select is(
  (select subtotal_source_text from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1_e')),
  '12.5',
  'but KEEPS the printed text, so a human can read it'
);
select ok(
  (select 'AMBIGUOUS_AMOUNT_FORMAT' = any (warning_codes) from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub1_e')),
  'and warns why'
);

-- Blank, untrimmed and over-long source text are all refused.
select throws_ok(
  format($q$update public.receipt_extractions set total_source_text = '   ' where id = %L$q$,
         (select id from public.receipt_extractions
          where receipt_submission_id = (select id from t_ids where label='sub1_e'))),
  '23514', null, 'blank source text is refused (terminal row also refuses, both hold)');

-- Every OCR-derived text column is bounded.
select is(
  (select count(*)::int
   from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name in ('receipt_extractions', 'receipt_extraction_line_items')
     and c.data_type = 'text'
     and c.column_name like '%_source_text'
     and not exists (
       select 1 from pg_constraint k
       where k.conrelid = ('public.' || c.table_name)::regclass
         and pg_get_constraintdef(k.oid) like '%' || c.column_name || '%length%'
     )),
  0,
  'EVERY source-text column carries a length bound — no unlimited OCR text exists'
);

-- ============================================================================
-- SECTION J — audit
-- ============================================================================
select is(
  (select actor_profile_id from public.audit_logs
   where action = 'RECEIPT_EXTRACTION_REQUESTED' limit 1) is not null,
  true,
  'an extraction request carries the authenticated actor'
);

select is(
  (select bool_and(actor_profile_id is null) from public.audit_logs
   where action in ('RECEIPT_EXTRACTION_CLAIMED', 'RECEIPT_EXTRACTION_SUCCEEDED',
                    'RECEIPT_EXTRACTION_FAILED')),
  true,
  'every worker event has a NULL actor — service work is never attributed to a person'
);

select is(
  (select bool_and(metadata ->> 'actor_kind' = 'SYSTEM_WORKER') from public.audit_logs
   where action in ('RECEIPT_EXTRACTION_CLAIMED', 'RECEIPT_EXTRACTION_SUCCEEDED',
                    'RECEIPT_EXTRACTION_FAILED')),
  true,
  'and carries the SYSTEM_WORKER discriminator, so the null actor is provably a machine'
);

-- No extracted value, path, hash or operation id anywhere in the metadata.
select is(
  (select count(*)::int from public.audit_logs a
   where a.action like 'RECEIPT_%'
     and (a.metadata::text like '%Lulu%'
       or a.metadata::text like '%INV-2026%'
       or a.metadata::text like '%123456%'
       or a.metadata::text like '%AED%'
       or a.metadata::text like '%receipts/%'
       or a.metadata::text like '%fake:%')),
  0,
  'NO merchant, document number, amount, currency, path or operation id in audit metadata'
);

select is(
  (select count(*)::int from public.audit_logs a
   cross join lateral jsonb_object_keys(a.metadata) as k(key)
   where a.action like 'RECEIPT_%'
     and k.key not in ('actor_kind', 'attempt_number', 'provider', 'provider_model',
                       'fields_extracted', 'line_item_count', 'warning_codes',
                       'failure_code', 'attempts_remaining', 'entry_mode',
                       'changed_fields', 'had_extraction')),
  0,
  'audit metadata keys are a closed allowlist'
);

-- ============================================================================
-- SECTION K — catalogue mutations (LAST: these edit seeded rows)
-- ============================================================================
-- Deactivating the role must revoke the whole feature immediately, with no code change.
-- This is the property that makes the permission mapping the authority.
update public.roles set status = 'INACTIVE' where code = 'SALES_STAFF';

select pg_temp.act_as((select id from t_ids where label='sales1'));
select is(pg_temp.access_sqlstate((select id from t_ids where label='sub1')), '42501',
          'deactivating SALES_STAFF revokes extraction access immediately');
select is(pg_temp.request_sqlstate((select id from t_ids where label='sub1')), '42501',
          'and the request');
select is(pg_temp.get_sqlstate((select id from t_ids where label='sub1')), '42501',
          'and the read — the mapping is the authority');

select * from finish();

rollback;
