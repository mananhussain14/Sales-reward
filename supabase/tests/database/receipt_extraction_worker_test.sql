-- pgTAP behavioural tests for the SEVEN service-role worker operations added by migration
-- 20260813090000.
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- The worker contract exists to survive a SECOND WORKER and a LATE WORKER, and neither is
-- observable from the client side. Every assertion here is about one of four properties:
--
--   1. ONE WORKER WINS A CLAIM, and the loser is told nothing and does nothing.
--   2. THE SEQUENCE IS NOT CIRCULAR — the claim demands no operation identifier, because at
--      claim time none can exist.
--   3. AN OPERATION IS REGISTERED EXACTLY ONCE, and a result can only be recorded against it.
--   4. STATUS IS CHECKED ALONGSIDE THE TOKEN, NEVER INSTEAD OF IT — which is what makes a
--      late worker harmless after the reaper has closed its job.
--
-- These run as the suite's superuser session, which bypasses EXECUTE grants. That is
-- deliberate: privilege is asserted against the catalogue in receipt_extraction_test.sql,
-- and what is under test HERE is behaviour.
--
-- Everything runs inside one transaction and is rolled back.

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

create function pg_temp.new_user(p_label text) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_label || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_label, 'Tester', 'ACTIVE');
  return v_id;
end;
$$;

create function pg_temp.grant_role(p_user uuid, p_org uuid, p_role_code text) returns uuid
language plpgsql as $$
declare v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status)
  values (p_org, p_user, 'ACTIVE')
  on conflict (organization_id, user_id) do update set status = 'ACTIVE'
  returning id into v_member;
  insert into public.member_roles (organization_member_id, role_id)
  select v_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;
  return v_member;
end;
$$;

create function pg_temp.new_submission(p_retailer uuid, p_shop uuid, p_submitter uuid)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.receipt_submissions (
    id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
    storage_bucket, storage_object_path, original_file_name, mime_type, file_size_bytes,
    file_sha256, status, submitted_at
  ) values (
    v_id, p_retailer, p_shop, p_submitter, 'receipts',
    p_retailer::text || '/' || p_submitter::text || '/' || v_id::text || '/o.jpg',
    'receipt.jpg', 'image/jpeg', 2048,
    md5(v_id::text) || md5(v_id::text || 'x'), 'SUBMITTED', now()
  );
  return v_id;
end;
$$;

/* Queues one attempt as the submitter and returns its id. */
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

create function pg_temp.claim_rows(p_id uuid) returns bigint
language sql as $$
  select count(*) from public.claim_receipt_extraction_job(p_id, 'FAKE', 'fake-receipt-v1');
$$;

create function pg_temp.token_of(p_id uuid) returns uuid
language sql as $$ select worker_claim_token from public.receipt_extractions where id = p_id; $$;

create function pg_temp.operation_of(p_id uuid) returns text
language sql as $$ select provider_operation_id from public.receipt_extractions where id = p_id; $$;

create function pg_temp.status_of(p_id uuid) returns text
language sql as $$ select status from public.receipt_extractions where id = p_id; $$;

create function pg_temp.failure_of(p_id uuid) returns text
language sql as $$ select failure_code from public.receipt_extractions where id = p_id; $$;

/*
 * Forces an open attempt past its deadline.
 *
 * The update guard refuses any same-status write that is not an operation registration —
 * exactly the protection under test below. Simulating the PASSAGE OF TIME is not something
 * the guard is meant to permit, so it is disabled for this one statement and restored
 * immediately. Nothing else in this suite writes the table directly.
 */
create function pg_temp.force_expired(p_id uuid) returns void
language plpgsql as $$
begin
  alter table public.receipt_extractions disable trigger receipt_extractions_guard_update;
  update public.receipt_extractions set expires_at = now() - interval '1 minute' where id = p_id;
  alter table public.receipt_extractions enable trigger receipt_extractions_guard_update;
end;
$$;

/* SQLSTATE wrappers. */
create function pg_temp.op_sqlstate(p_id uuid, p_token uuid, p_op text) returns text
language plpgsql as $$
begin
  perform public.record_receipt_extraction_operation(p_id, p_token, p_op);
  return null;
exception when others then return sqlstate;
end;
$$;

create function pg_temp.success_sqlstate(p_id uuid, p_token uuid, p_op text) returns text
language plpgsql as $$
begin
  perform public.record_receipt_extraction_success(
    p_id, p_token, p_op,
    jsonb_build_object('transaction_date', '2026-07-12', 'currency_code', 'AED',
                       'total_minor', 1000),
    '[]'::jsonb);
  return null;
exception when others then return sqlstate;
end;
$$;

create function pg_temp.failure_sqlstate(p_id uuid, p_token uuid, p_op text, p_code text)
returns text language plpgsql as $$
begin
  perform public.record_receipt_extraction_failure(p_id, p_token, p_op, p_code);
  return null;
exception when others then return sqlstate;
end;
$$;

create function pg_temp.success_payload_sqlstate(p_id uuid, p_token uuid, p_op text,
                                                 p_normalized jsonb, p_lines jsonb)
returns text language plpgsql as $$
begin
  perform public.record_receipt_extraction_success(p_id, p_token, p_op, p_normalized, p_lines);
  return null;
exception when others then return sqlstate;
end;
$$;

-- ============================================================================
-- Fixtures
-- ============================================================================
create temporary table t_ids (label text primary key, id uuid not null);

do $$
declare
  v_retailer uuid := gen_random_uuid();
  v_shop     uuid := gen_random_uuid();
  v_sales    uuid;
begin
  insert into public.organizations (id, name, organization_type, status)
  values (v_retailer, 'Worker Test Retailer', 'RETAILER', 'ACTIVE');
  insert into public.retailer_shops (id, retailer_organization_id, name, code, status)
  values (v_shop, v_retailer, 'Worker Shop', 'W1', 'ACTIVE');

  v_sales := pg_temp.new_user('wrk_sales');
  perform pg_temp.grant_role(v_sales, v_retailer, 'SALES_STAFF');

  insert into t_ids values ('retailer', v_retailer), ('shop', v_shop), ('sales', v_sales);

  insert into t_ids
  select 'sub' || g, pg_temp.new_submission(v_retailer, v_shop, v_sales)
  from generate_series(1, 12) g;
end;
$$;

-- The gate must be open for the request RPC to create anything.
update public.receipt_extraction_runtime set mode = 'FAKE' where id;

-- ============================================================================
-- SECTION A — the claim is non-circular and single-winner
-- ============================================================================
select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(p.proargnames) as a(name)
   where n.nspname = 'public' and p.proname = 'claim_receipt_extraction_job'
     and a.name = 'p_provider_operation_id'),
  0,
  'THE NON-CIRCULARITY PROOF: the claim has no provider_operation_id parameter'
);

do $$
declare v_ext uuid := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                                            (select id from t_ids where label='sub1'));
begin
  insert into t_ids values ('ext1', v_ext);
end;
$$;

select is(pg_temp.claim_rows((select id from t_ids where label='ext1')), 1::bigint,
          'the first worker claims the job');
select is(pg_temp.status_of((select id from t_ids where label='ext1')), 'PROCESSING',
          'and the attempt is PROCESSING');
select ok(pg_temp.token_of((select id from t_ids where label='ext1')) is not null,
          'a claim token was generated INSIDE the database');
select ok(
  (select started_at is not null and expires_at > now()
   from public.receipt_extractions where id = (select id from t_ids where label='ext1')),
  'started_at is stamped and the work deadline is in the future'
);

select is(pg_temp.claim_rows((select id from t_ids where label='ext1')), 0::bigint,
          'THE SECOND WORKER LOSES: zero rows, and NOT an error');

select is(pg_temp.claim_rows(gen_random_uuid()), 0::bigint,
          'an unknown job is indistinguishable from a lost race');

-- Tokens are unpredictable: two claims on two jobs must not collide.
do $$
declare v_a uuid; v_b uuid;
begin
  v_a := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                               (select id from t_ids where label='sub2'));
  v_b := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                               (select id from t_ids where label='sub3'));
  perform pg_temp.claim_rows(v_a);
  perform pg_temp.claim_rows(v_b);
  insert into t_ids values ('ext2', v_a), ('ext3', v_b);
end;
$$;

select isnt(
  pg_temp.token_of((select id from t_ids where label='ext2')),
  pg_temp.token_of((select id from t_ids where label='ext3')),
  'claim tokens are distinct — they come from gen_random_uuid(), not a counter'
);

select throws_ok(
  format($q$select public.claim_receipt_extraction_job(%L, 'AZURE', 'x')$q$,
         (select id from t_ids where label='ext1')),
  '23514', null,
  'a provider other than FAKE is refused before anything is written'
);

-- ============================================================================
-- SECTION B — operation registration, exactly once
-- ============================================================================
select is(
  pg_temp.op_sqlstate((select id from t_ids where label='ext1'),
                      pg_temp.token_of((select id from t_ids where label='ext1')),
                      'fake:11111111-1111-1111-1111-111111111111'),
  null,
  'the operation registers on a claimed attempt (PROCESSING -> PROCESSING works)'
);

select is(pg_temp.operation_of((select id from t_ids where label='ext1')),
          'fake:11111111-1111-1111-1111-111111111111',
          'and is stored');
select is(pg_temp.status_of((select id from t_ids where label='ext1')), 'PROCESSING',
          'the status is unchanged by registration');

select is(
  pg_temp.op_sqlstate((select id from t_ids where label='ext1'),
                      pg_temp.token_of((select id from t_ids where label='ext1')),
                      'fake:22222222-2222-2222-2222-222222222222'),
  '23514',
  'a SECOND registration is refused, even with the correct token'
);

select is(pg_temp.operation_of((select id from t_ids where label='ext1')),
          'fake:11111111-1111-1111-1111-111111111111',
          'and the original operation is untouched');

select is(
  pg_temp.op_sqlstate((select id from t_ids where label='ext2'), gen_random_uuid(),
                      'fake:33333333-3333-3333-3333-333333333333'),
  '23514',
  'a WRONG token is refused'
);

select is(
  pg_temp.op_sqlstate((select id from t_ids where label='ext2'),
                      pg_temp.token_of((select id from t_ids where label='ext2')), '   '),
  '23514',
  'a blank operation id is refused'
);

-- A direct UPDATE cannot replace it either — the write-once trigger clause.
select throws_ok(
  format($q$update public.receipt_extractions set provider_operation_id = 'fake:x' where id = %L$q$,
         (select id from t_ids where label='ext1')),
  '23514', null,
  'a direct UPDATE cannot replace a registered operation'
);

-- ============================================================================
-- SECTION C — success requires a registered operation on BOTH sides
-- ============================================================================
select is(
  pg_temp.success_sqlstate((select id from t_ids where label='ext2'),
                           pg_temp.token_of((select id from t_ids where label='ext2')), null),
  '23514',
  'SUCCESS WITH BOTH OPERATION IDS NULL IS IMPOSSIBLE'
);

select is(
  pg_temp.success_sqlstate((select id from t_ids where label='ext1'),
                           pg_temp.token_of((select id from t_ids where label='ext1')),
                           'fake:99999999-9999-9999-9999-999999999999'),
  '23514',
  'a MISMATCHED operation id is refused'
);

select is(
  pg_temp.success_sqlstate((select id from t_ids where label='ext1'), gen_random_uuid(),
                           pg_temp.operation_of((select id from t_ids where label='ext1'))),
  '23514',
  'a wrong token is refused even with the right operation'
);

select is(
  pg_temp.success_sqlstate((select id from t_ids where label='ext1'),
                           pg_temp.token_of((select id from t_ids where label='ext1')),
                           pg_temp.operation_of((select id from t_ids where label='ext1'))),
  null,
  'the correct token AND the correct operation succeed'
);
select is(pg_temp.status_of((select id from t_ids where label='ext1')), 'SUCCEEDED',
          'the attempt is SUCCEEDED');

select is(
  pg_temp.success_sqlstate((select id from t_ids where label='ext1'),
                           pg_temp.token_of((select id from t_ids where label='ext1')),
                           pg_temp.operation_of((select id from t_ids where label='ext1'))),
  '23514',
  'A SECOND SUCCESS IS REFUSED — the result is write-once'
);

select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext1'),
                           pg_temp.token_of((select id from t_ids where label='ext1')),
                           pg_temp.operation_of((select id from t_ids where label='ext1')),
                           'PROVIDER_TIMEOUT'),
  '23514',
  'and a success cannot be overwritten by a failure'
);

-- ============================================================================
-- SECTION D — the two failure paths
-- ============================================================================
do $$
declare v_ext uuid;
begin
  v_ext := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                                 (select id from t_ids where label='sub4'));
  perform pg_temp.claim_rows(v_ext);
  insert into t_ids values ('ext_pre', v_ext);
end;
$$;

-- PATH A: pre-provider. No operation exists; none may be supplied.
select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_pre'),
                           pg_temp.token_of((select id from t_ids where label='ext_pre')),
                           'fake:44444444-4444-4444-4444-444444444444', 'OBJECT_UNREADABLE'),
  '23514',
  'OBJECT_UNREADABLE with an operation id supplied is refused'
);

select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_pre'),
                           pg_temp.token_of((select id from t_ids where label='ext_pre')),
                           null, 'PROVIDER_TIMEOUT'),
  '23514',
  'a POST-provider code with no registered operation is refused'
);

select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_pre'),
                           pg_temp.token_of((select id from t_ids where label='ext_pre')),
                           null, 'OBJECT_UNREADABLE'),
  null,
  'PATH A succeeds: OBJECT_UNREADABLE with both operation ids null'
);
select is(pg_temp.failure_of((select id from t_ids where label='ext_pre')), 'OBJECT_UNREADABLE',
          'and the code is stored');

-- PATH B: post-provider.
do $$
declare v_ext uuid; v_token uuid;
begin
  v_ext := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                                 (select id from t_ids where label='sub5'));
  perform pg_temp.claim_rows(v_ext);
  v_token := pg_temp.token_of(v_ext);
  perform public.record_receipt_extraction_operation(
    v_ext, v_token, 'fake:55555555-5555-5555-5555-555555555555');
  insert into t_ids values ('ext_post', v_ext);
end;
$$;

select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_post'),
                           pg_temp.token_of((select id from t_ids where label='ext_post')),
                           null, 'PROVIDER_TIMEOUT'),
  '23514',
  'a post-provider failure with a NULL operation id is refused once one is registered'
);

select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_post'),
                           pg_temp.token_of((select id from t_ids where label='ext_post')),
                           'fake:00000000-0000-0000-0000-000000000000', 'PROVIDER_TIMEOUT'),
  '23514',
  'and with a mismatched one'
);

select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_post'),
                           pg_temp.token_of((select id from t_ids where label='ext_post')),
                           'fake:55555555-5555-5555-5555-555555555555', 'OBJECT_UNREADABLE'),
  '23514',
  'and OBJECT_UNREADABLE is refused once the provider has been reached'
);

select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_post'),
                           pg_temp.token_of((select id from t_ids where label='ext_post')),
                           'fake:55555555-5555-5555-5555-555555555555', 'PROVIDER_TIMEOUT'),
  null,
  'PATH B succeeds with the exact operation id'
);

-- Reaper-only codes are refused by the worker RPC.
do $$
declare v_ext uuid; v_token uuid;
begin
  v_ext := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                                 (select id from t_ids where label='sub6'));
  perform pg_temp.claim_rows(v_ext);
  v_token := pg_temp.token_of(v_ext);
  perform public.record_receipt_extraction_operation(
    v_ext, v_token, 'fake:66666666-6666-6666-6666-666666666666');
  insert into t_ids values ('ext_reaper', v_ext);
end;
$$;

select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_reaper'),
                           pg_temp.token_of((select id from t_ids where label='ext_reaper')),
                           'fake:66666666-6666-6666-6666-666666666666', 'WORKER_ABANDONED'),
  '23514',
  'WORKER_ABANDONED is REAPER-ONLY and is refused here'
);
select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_reaper'),
                           pg_temp.token_of((select id from t_ids where label='ext_reaper')),
                           'fake:66666666-6666-6666-6666-666666666666', 'NEVER_CLAIMED'),
  '23514',
  'NEVER_CLAIMED likewise'
);
select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_reaper'),
                           pg_temp.token_of((select id from t_ids where label='ext_reaper')),
                           'fake:66666666-6666-6666-6666-666666666666', 'NOT_A_CODE'),
  '23514',
  'and an invented code is refused'
);

-- ============================================================================
-- SECTION E — the payload allowlist
-- ============================================================================
select is(
  pg_temp.success_payload_sqlstate(
    (select id from t_ids where label='ext_reaper'),
    pg_temp.token_of((select id from t_ids where label='ext_reaper')),
    'fake:66666666-6666-6666-6666-666666666666',
    jsonb_build_object('transaction_date', '2026-07-12', 'currency_code', 'AED',
                       'total_minor', 100, 'raw_payload', 'anything'),
    '[]'::jsonb),
  '23514',
  'AN UNKNOWN KEY IS REFUSED — a raw payload cannot be smuggled in'
);

select is(
  pg_temp.success_payload_sqlstate(
    (select id from t_ids where label='ext_reaper'),
    pg_temp.token_of((select id from t_ids where label='ext_reaper')),
    'fake:66666666-6666-6666-6666-666666666666',
    jsonb_build_object('total_minor', 'not a number'),
    '[]'::jsonb),
  '23514',
  'a wrong JSON type is refused before any cast'
);

select is(
  pg_temp.success_payload_sqlstate(
    (select id from t_ids where label='ext_reaper'),
    pg_temp.token_of((select id from t_ids where label='ext_reaper')),
    'fake:66666666-6666-6666-6666-666666666666',
    jsonb_build_object('transaction_date', 'not-a-date'),
    '[]'::jsonb),
  '23514',
  'an unparseable date becomes 23514, not a raw 22007'
);

select is(
  pg_temp.success_payload_sqlstate(
    (select id from t_ids where label='ext_reaper'),
    pg_temp.token_of((select id from t_ids where label='ext_reaper')),
    'fake:66666666-6666-6666-6666-666666666666',
    jsonb_build_object('merchant_name', jsonb_build_object('nested', true)),
    '[]'::jsonb),
  '23514',
  'a nested object is refused'
);

select is(
  pg_temp.success_payload_sqlstate(
    (select id from t_ids where label='ext_reaper'),
    pg_temp.token_of((select id from t_ids where label='ext_reaper')),
    'fake:66666666-6666-6666-6666-666666666666',
    jsonb_build_object('transaction_date', '2026-07-12', 'currency_code', 'AED',
                       'total_minor', 100),
    jsonb_build_object('not', 'an array')),
  '23514',
  'a non-array line-item document is refused'
);

select is(
  pg_temp.success_payload_sqlstate(
    (select id from t_ids where label='ext_reaper'),
    pg_temp.token_of((select id from t_ids where label='ext_reaper')),
    'fake:66666666-6666-6666-6666-666666666666',
    jsonb_build_object('transaction_date', '2026-07-12', 'currency_code', 'AED',
                       'total_minor', 100),
    (select jsonb_agg(jsonb_build_object('line_number', g)) from generate_series(1, 201) g)),
  '23514',
  'more than 200 line items is refused'
);

select is(
  pg_temp.success_payload_sqlstate(
    (select id from t_ids where label='ext_reaper'),
    pg_temp.token_of((select id from t_ids where label='ext_reaper')),
    'fake:66666666-6666-6666-6666-666666666666',
    jsonb_build_object('transaction_date', '2026-07-12', 'currency_code', 'AED',
                       'total_minor', 100),
    jsonb_build_array(jsonb_build_object('line_number', 1, 'provider_note', 'x'))),
  '23514',
  'an unknown line-item key is refused'
);

select is(pg_temp.status_of((select id from t_ids where label='ext_reaper')), 'PROCESSING',
          'and after every refusal the attempt is UNCHANGED');

-- A currency outside the seeded reference set cannot be stored.
select is(
  pg_temp.success_payload_sqlstate(
    (select id from t_ids where label='ext_reaper'),
    pg_temp.token_of((select id from t_ids where label='ext_reaper')),
    'fake:66666666-6666-6666-6666-666666666666',
    jsonb_build_object('transaction_date', '2026-07-12', 'currency_code', 'ZZZ',
                       'total_minor', 100),
    '[]'::jsonb),
  '23503',
  'an unseeded currency violates the foreign key'
);

-- The ordinal is server-derived from position, whatever the caller numbered its array.
do $$
declare v_ext uuid; v_token uuid; v_op text := 'fake:77777777-7777-7777-7777-777777777777';
begin
  v_ext := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                                 (select id from t_ids where label='sub7'));
  perform pg_temp.claim_rows(v_ext);
  v_token := pg_temp.token_of(v_ext);
  perform public.record_receipt_extraction_operation(v_ext, v_token, v_op);
  perform public.record_receipt_extraction_success(
    v_ext, v_token, v_op,
    jsonb_build_object('transaction_date', '2026-07-12', 'currency_code', 'AED',
                       'total_minor', 100),
    jsonb_build_array(
      jsonb_build_object('line_number', 900, 'description', 'A'),
      jsonb_build_object('line_number', 901, 'description', 'B')));
  insert into t_ids values ('ext_lines', v_ext);
end;
$$;

select is(
  (select array_agg(line_number order by line_number)
   from public.receipt_extraction_line_items
   where receipt_extraction_id = (select id from t_ids where label='ext_lines')),
  array[1, 2],
  'line ordinals are SERVER-DERIVED from position, dense and 1-based'
);

-- ============================================================================
-- SECTION F — the reaper, and the late worker
-- ============================================================================
do $$
declare v_ext uuid;
begin
  v_ext := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                                 (select id from t_ids where label='sub8'));
  insert into t_ids values ('ext_queued', v_ext);
end;
$$;

select is(public.expire_stale_receipt_extraction_claims(
            (select id from t_ids where label='ext_queued')), 0,
          'a FRESH queued attempt is not expired');

select pg_temp.force_expired((select id from t_ids where label='ext_queued'));

select is(public.expire_stale_receipt_extraction_claims(
            (select id from t_ids where label='ext_queued')), 1,
          'a STALE queued attempt is expired');
select is(pg_temp.status_of((select id from t_ids where label='ext_queued')), 'FAILED',
          'and becomes FAILED');
select is(pg_temp.failure_of((select id from t_ids where label='ext_queued')), 'NEVER_CLAIMED',
          'with NEVER_CLAIMED — no worker ever touched it');
select ok(
  (select started_at is null and worker_claim_token is null and provider is null
   from public.receipt_extractions where id = (select id from t_ids where label='ext_queued')),
  'and it carries no fabricated worker state'
);

select is(public.expire_stale_receipt_extraction_claims(
            (select id from t_ids where label='ext_queued')), 0,
          'the reaper is idempotent');

-- A stale PROCESSING attempt, and the LATE WORKER that still holds its token.
do $$
declare v_ext uuid; v_token uuid; v_op text := 'fake:88888888-8888-8888-8888-888888888888';
begin
  v_ext := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                                 (select id from t_ids where label='sub9'));
  perform pg_temp.claim_rows(v_ext);
  v_token := pg_temp.token_of(v_ext);
  perform public.record_receipt_extraction_operation(v_ext, v_token, v_op);
  insert into t_ids values ('ext_late', v_ext);
  -- The token and operation are captured BEFORE the reaper runs, exactly as a real worker
  -- that went away and came back would hold them.
  insert into t_ids values ('late_token', v_token);
end;
$$;

select pg_temp.force_expired((select id from t_ids where label='ext_late'));
select is(public.expire_stale_receipt_extraction_claims(
            (select id from t_ids where label='ext_late')), 1,
          'a stale PROCESSING attempt is expired');
select is(pg_temp.failure_of((select id from t_ids where label='ext_late')), 'WORKER_ABANDONED',
          'with WORKER_ABANDONED');

-- THE CENTRAL PROPERTY: a correct token and a correct operation id are NOT enough.
select is(
  pg_temp.op_sqlstate((select id from t_ids where label='ext_late'),
                      (select id from t_ids where label='late_token'),
                      'fake:aaaaaaaa-8888-8888-8888-888888888888'),
  '23514',
  'A LATE WORKER cannot register, even holding the correct old token'
);
select is(
  pg_temp.success_sqlstate((select id from t_ids where label='ext_late'),
                           (select id from t_ids where label='late_token'),
                           'fake:88888888-8888-8888-8888-888888888888'),
  '23514',
  'nor record a success with the correct token AND the correct operation id'
);
select is(
  pg_temp.failure_sqlstate((select id from t_ids where label='ext_late'),
                           (select id from t_ids where label='late_token'),
                           'fake:88888888-8888-8888-8888-888888888888', 'PROVIDER_TIMEOUT'),
  '23514',
  'nor a failure — status is checked ALONGSIDE the token, never instead of it'
);
select is(pg_temp.failure_of((select id from t_ids where label='ext_late')), 'WORKER_ABANDONED',
          'and the reaped result stands unaltered');

-- A reaped attempt frees the receipt for a retry. (The unauthenticated refusal is asserted in
-- receipt_extraction_test.sql; requesting one here would abort this transaction.)
select pg_temp.act_as((select id from t_ids where label='sales'));
select is(
  (select outcome from public.request_receipt_extraction((select id from t_ids where label='sub9'))),
  'QUEUED',
  'and once reaped, a NEW attempt may be created'
);
select is(
  (select count(*)::int from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub9')),
  2,
  'the reaped attempt still counts — every persisted row consumes one'
);
select pg_temp.sign_out();

-- The scoped form touches nothing else.
do $$
declare v_a uuid; v_b uuid;
begin
  v_a := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                               (select id from t_ids where label='sub10'));
  v_b := pg_temp.queue_attempt((select id from t_ids where label='sales'),
                               (select id from t_ids where label='sub11'));
  perform pg_temp.force_expired(v_a);
  perform pg_temp.force_expired(v_b);
  insert into t_ids values ('ext_scoped_a', v_a), ('ext_scoped_b', v_b);
end;
$$;

select is(public.expire_stale_receipt_extraction_claims(
            (select id from t_ids where label='ext_scoped_a')), 1,
          'the scoped reaper expires exactly one row');
select is(pg_temp.status_of((select id from t_ids where label='ext_scoped_b')), 'QUEUED',
          'and leaves the other stale row alone — no global sweep from a scoped call');

select ok(public.expire_stale_receipt_extraction_claims(null) >= 1,
          'the NULL form sweeps everything — operator and cron use only');
select is(pg_temp.status_of((select id from t_ids where label='ext_scoped_b')), 'FAILED',
          'and reaches the row the scoped call skipped');

-- ============================================================================
-- SECTION G — the worker-state and object-reference reads
-- ============================================================================
select is(
  (select storage_bucket from public.get_receipt_object_reference(
     (select id from t_ids where label='sub1'))),
  'receipts',
  'the object reference is available to service_role'
);
select is(
  (select count(*)::int from public.get_receipt_object_reference(gen_random_uuid())),
  0,
  'and returns nothing for an unknown submission'
);
select is(
  (select count(*)::int from public.get_receipt_object_reference(null)),
  0,
  'or a null id'
);

select is(
  (select status from public.get_receipt_extraction_worker_state(
     (select id from t_ids where label='ext1'))),
  'SUCCEEDED',
  'the worker-state read returns the attempt status'
);
select ok(
  (select worker_claim_token is not null and provider_operation_id is not null
   from public.get_receipt_extraction_worker_state((select id from t_ids where label='ext1'))),
  'along with the claim token and operation id a later poll needs'
);

select * from finish();

rollback;
