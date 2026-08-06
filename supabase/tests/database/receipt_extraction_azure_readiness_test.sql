-- pgTAP tests for migration 20260828210000.
--
-- Run with: npx supabase test db
--
-- Proves that:
--   1. legitimate provider submission failures can be recorded before an operation exists;
--   2. result-dependent failures still require a registered operation;
--   3. refused writes leave the attempt PROCESSING and unchanged;
--   4. no operation identifier is fabricated;
--   5. the database remains DISABLED after Azure readiness is applied;
--   6. runtime mode, provider and model form closed contracts;
--   7. polling can recover the immutable stored provider and model.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select is(
  (select mode from public.receipt_extraction_runtime),
  'DISABLED',
  'Azure readiness does not enable extraction'
);

create function pg_temp.act_as(p_user uuid)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user::text)::text,
    true
  );
end;
$$;

create function pg_temp.sign_out()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.new_user(p_label text)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, p_label || '@test.invalid');

  insert into public.profiles (
    id,
    first_name,
    last_name,
    status
  )
  values (
    v_id,
    p_label,
    'Tester',
    'ACTIVE'
  );

  return v_id;
end;
$$;

create function pg_temp.grant_role(
  p_user uuid,
  p_org uuid,
  p_role_code text
)
returns void
language plpgsql
as $$
declare
  v_member uuid;
begin
  insert into public.organization_members (
    organization_id,
    user_id,
    status
  )
  values (
    p_org,
    p_user,
    'ACTIVE'
  )
  returning id into v_member;

  insert into public.member_roles (
    organization_member_id,
    role_id
  )
  select
    v_member,
    r.id
  from public.roles r
  where r.code = p_role_code;
end;
$$;

create function pg_temp.new_submission(
  p_retailer uuid,
  p_shop uuid,
  p_submitter uuid
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.receipt_submissions (
    id,
    retailer_organization_id,
    retailer_shop_id,
    submitted_by_profile_id,
    storage_bucket,
    storage_object_path,
    original_file_name,
    mime_type,
    file_size_bytes,
    file_sha256,
    status,
    submitted_at
  )
  values (
    v_id,
    p_retailer,
    p_shop,
    p_submitter,
    'receipts',
    p_retailer::text || '/' ||
      p_submitter::text || '/' ||
      v_id::text || '/original.jpg',
    'receipt.jpg',
    'image/jpeg',
    2048,
    md5(v_id::text) || md5(v_id::text || 'x'),
    'SUBMITTED',
    now()
  );

  return v_id;
end;
$$;

create function pg_temp.queue_attempt(
  p_user uuid,
  p_submission uuid
)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  perform pg_temp.act_as(p_user);

  select extraction_id
  into v_id
  from public.request_receipt_extraction(p_submission);

  perform pg_temp.sign_out();

  return v_id;
end;
$$;

create function pg_temp.failure_sqlstate(
  p_id uuid,
  p_token uuid,
  p_operation text,
  p_code text
)
returns text
language plpgsql
as $$
begin
  perform public.record_receipt_extraction_failure(
    p_id,
    p_token,
    p_operation,
    p_code
  );

  return null;
exception
  when others then
    return sqlstate;
end;
$$;

create temporary table t_context (
  label text primary key,
  id uuid not null
);

do $$
declare
  v_retailer uuid := gen_random_uuid();
  v_shop uuid := gen_random_uuid();
  v_sales uuid;
begin
  insert into public.organizations (
    id,
    name,
    organization_type,
    status
  )
  values (
    v_retailer,
    'Pre-operation Failure Test Retailer',
    'RETAILER',
    'ACTIVE'
  );

  insert into public.retailer_shops (
    id,
    retailer_organization_id,
    name,
    code,
    status
  )
  values (
    v_shop,
    v_retailer,
    'Failure Test Shop',
    'POF1',
    'ACTIVE'
  );

  v_sales := pg_temp.new_user('pre_operation_sales');

  perform pg_temp.grant_role(
    v_sales,
    v_retailer,
    'SALES_STAFF'
  );

  insert into t_context values
    ('retailer', v_retailer),
    ('shop', v_shop),
    ('sales', v_sales);
end;
$$;

update public.receipt_extraction_runtime
set mode = 'FAKE'
where id;

create temporary table t_cases (
  failure_code text primary key,
  should_succeed boolean not null,
  extraction_id uuid,
  claim_token uuid
);

insert into t_cases (
  failure_code,
  should_succeed
)
values
  ('OBJECT_UNREADABLE', true),
  ('PROVIDER_UNAVAILABLE', true),
  ('PROVIDER_QUOTA_EXCEEDED', true),
  ('PROVIDER_TIMEOUT', true),
  ('UNSUPPORTED_IMAGE', true),
  ('INTERNAL', true),

  ('PROVIDER_REJECTED_DOCUMENT', false),
  ('NORMALIZATION_FAILED', false),
  ('WORKER_ABANDONED', false),
  ('NEVER_CLAIMED', false),
  ('NOT_A_FAILURE_CODE', false);

do $$
declare
  v_case record;
  v_submission uuid;
  v_extraction uuid;
  v_token uuid;
begin
  for v_case in
    select failure_code
    from t_cases
    order by failure_code
  loop
    v_submission := pg_temp.new_submission(
      (select id from t_context where label = 'retailer'),
      (select id from t_context where label = 'shop'),
      (select id from t_context where label = 'sales')
    );

    v_extraction := pg_temp.queue_attempt(
      (select id from t_context where label = 'sales'),
      v_submission
    );

    perform 1
    from public.claim_receipt_extraction_job(
      v_extraction,
      'FAKE',
      'fake-receipt-v1'
    );

    select worker_claim_token
    into v_token
    from public.receipt_extractions
    where id = v_extraction;

    update t_cases
    set
      extraction_id = v_extraction,
      claim_token = v_token
    where failure_code = v_case.failure_code;
  end loop;
end;
$$;

select is(
  pg_temp.failure_sqlstate(
    extraction_id,
    claim_token,
    null,
    failure_code
  ),
  null,
  format(
    '%s may be recorded before an operation id is issued',
    failure_code
  )
)
from t_cases
where should_succeed
order by failure_code;

select is(
  x.status,
  'FAILED',
  format('%s closes the attempt', c.failure_code)
)
from t_cases c
join public.receipt_extractions x
  on x.id = c.extraction_id
where c.should_succeed
order by c.failure_code;

select is(
  x.failure_code,
  c.failure_code,
  format('%s is stored exactly', c.failure_code)
)
from t_cases c
join public.receipt_extractions x
  on x.id = c.extraction_id
where c.should_succeed
order by c.failure_code;

select is(
  x.provider_operation_id,
  null,
  format('%s fabricates no operation id', c.failure_code)
)
from t_cases c
join public.receipt_extractions x
  on x.id = c.extraction_id
where c.should_succeed
order by c.failure_code;

select is(
  pg_temp.failure_sqlstate(
    extraction_id,
    claim_token,
    null,
    failure_code
  ),
  '23514',
  format(
    '%s is refused without a registered operation id',
    failure_code
  )
)
from t_cases
where not should_succeed
order by failure_code;

select is(
  x.status,
  'PROCESSING',
  format(
    'refused %s leaves the attempt PROCESSING',
    c.failure_code
  )
)
from t_cases c
join public.receipt_extractions x
  on x.id = c.extraction_id
where not c.should_succeed
order by c.failure_code;

select is(
  x.failure_code,
  null,
  format(
    'refused %s stores no failure',
    c.failure_code
  )
)
from t_cases c
join public.receipt_extractions x
  on x.id = c.extraction_id
where not c.should_succeed
order by c.failure_code;

-- ============================================================================
-- AZURE READINESS CONTRACT
-- ============================================================================

select is(
  (
    select count(*)::integer
    from supabase_migrations.schema_migrations
    where version = '20260828210000'
  ),
  1,
  'Migration 71 is recorded exactly once'
);

select is(
  (
    select count(*)::integer
    from pg_constraint
    where conrelid =
      'public.receipt_extraction_runtime'::regclass
      and conname =
        'receipt_extraction_runtime_mode_allowed'
  ),
  1,
  'the widened runtime-mode constraint exists exactly once'
);


update public.receipt_extraction_runtime
set mode = 'AZURE';

select is(
  (select mode from public.receipt_extraction_runtime),
  'AZURE',
  'AZURE is an explicitly admitted database runtime mode'
);

select throws_ok(
  $$update public.receipt_extraction_runtime
    set mode = 'UNRECOGNIZED'$$,
  '23514',
  null,
  'an unknown runtime mode remains impossible'
);

update public.receipt_extraction_runtime
set mode = 'DISABLED';

select ok(
  position(
    'AZURE_DOCUMENT_INTELLIGENCE'
    in (
      select pg_get_constraintdef(c.oid)
      from pg_constraint c
      where c.conrelid =
        'public.receipt_extractions'::regclass
        and c.conname =
          'receipt_extractions_provider_allowed'
    )
  ) > 0,
  'the provider constraint admits the exact Azure provider name'
);

select is(
  (
    select count(*)::integer
    from pg_constraint c
    where c.conrelid =
      'public.receipt_extractions'::regclass
      and c.conname =
        'receipt_extractions_provider_model_pair_allowed'
  ),
  1,
  'the provider/model pair constraint exists exactly once'
);

select ok(
  position(
    'fake-receipt-v1'
    in (
      select pg_get_constraintdef(c.oid)
      from pg_constraint c
      where c.conrelid =
        'public.receipt_extractions'::regclass
        and c.conname =
          'receipt_extractions_provider_model_pair_allowed'
    )
  ) > 0,
  'the fake provider remains tied to its exact model'
);

select ok(
  position(
    'prebuilt-receipt'
    in (
      select pg_get_constraintdef(c.oid)
      from pg_constraint c
      where c.conrelid =
        'public.receipt_extractions'::regclass
        and c.conname =
          'receipt_extractions_provider_model_pair_allowed'
    )
  ) > 0,
  'the Azure receipt model is admitted'
);

select ok(
  position(
    'prebuilt-invoice'
    in (
      select pg_get_constraintdef(c.oid)
      from pg_constraint c
      where c.conrelid =
        'public.receipt_extractions'::regclass
        and c.conname =
          'receipt_extractions_provider_model_pair_allowed'
    )
  ) > 0,
  'the Azure invoice model is admitted'
);

select ok(
  position(
    'receipt_extraction_runtime'
    in pg_get_functiondef(
      'public.request_receipt_extraction(uuid)'::regprocedure
    )
  ) > 0
  and position(
    'AZURE'
    in pg_get_functiondef(
      'public.request_receipt_extraction(uuid)'::regprocedure
    )
  ) > 0
  and position(
    'FAKE'
    in pg_get_functiondef(
      'public.request_receipt_extraction(uuid)'::regprocedure
    )
  ) > 0,
  'the authenticated request gate recognizes FAKE and AZURE'
);

select ok(
  position(
    'AZURE_DOCUMENT_INTELLIGENCE'
    in pg_get_functiondef(
      'public.claim_receipt_extraction_job(uuid,text,text)'::regprocedure
    )
  ) > 0
  and position(
    'prebuilt-receipt'
    in pg_get_functiondef(
      'public.claim_receipt_extraction_job(uuid,text,text)'::regprocedure
    )
  ) > 0
  and position(
    'prebuilt-invoice'
    in pg_get_functiondef(
      'public.claim_receipt_extraction_job(uuid,text,text)'::regprocedure
    )
  ) > 0
  and position(
    'receipt_extraction_runtime'
    in pg_get_functiondef(
      'public.claim_receipt_extraction_job(uuid,text,text)'::regprocedure
    )
  ) > 0,
  'claiming binds runtime mode, provider and model together'
);

select ok(
  position(
    'provider text'
    in pg_get_function_result(
      'public.get_receipt_extraction_worker_state(uuid)'::regprocedure
    )
  ) > 0
  and position(
    'provider_model text'
    in pg_get_function_result(
      'public.get_receipt_extraction_worker_state(uuid)'::regprocedure
    )
  ) > 0,
  'worker state returns the stored provider and model'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.get_receipt_extraction_worker_state(uuid)',
    'EXECUTE'
  ),
  'the provider-aware worker state remains executable by service_role'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_receipt_extraction_worker_state(uuid)',
    'EXECUTE'
  ),
  'the provider-aware worker state remains hidden from authenticated'
);

select * from finish();

rollback;
