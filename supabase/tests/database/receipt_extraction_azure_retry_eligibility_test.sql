-- pgTAP tests for migration 20260829090000.
--
-- Run with: npx supabase test db
--
-- THE ONE THING UNDER TEST is the last conjunct of retry_allowed in
-- get_my_receipt_extraction: the executable runtime modes are a SET, and AZURE is in it.
--
-- Everything else in this file exists to prove that widening that conjunct widened NOTHING
-- ELSE. Each of the five other conditions is exercised with the runtime in AZURE — the mode
-- that now passes — so that a regression which collapsed the conjunction into "mode is
-- executable" would fail here rather than ship a retry after a success or a confirmation.
--
-- Proves:
--   1.  FAILED + FAKE     + capacity            -> retry_allowed true   (unchanged behavior)
--   2.  FAILED + AZURE    + capacity            -> retry_allowed true   (the fix)
--   3.  FAILED + DISABLED + capacity            -> retry_allowed false  (still fail-closed)
--   4.  FAILED + AZURE    + attempts exhausted  -> retry_allowed false
--   5.  FAILED + AZURE    + an active attempt   -> retry_allowed false
--   6.  FAILED + AZURE    + a SUCCEEDED attempt -> retry_allowed false
--   7.  FAILED + AZURE    + a confirmation      -> retry_allowed false
--   8.  QUEUED                                  -> retry_allowed false
--   9.  PROCESSING                              -> retry_allowed false
--   10. SUCCEEDED                               -> retry_allowed false
--   11. the three-attempt budget is unchanged
--   12. an unknown runtime mode remains unrepresentable
--   13. a non-owner cannot read another submitter's extraction through this function
--   14. no service-role-only state is exposed, and the grants are unchanged

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers
-- ============================================================================
create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user::text)::text,
    true
  );
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
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_label || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_label, 'Tester', 'ACTIVE');
  return v_id;
end;
$$;

create function pg_temp.grant_role(p_user uuid, p_org uuid, p_role_code text) returns void
language plpgsql as $$
declare
  v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status)
  values (p_org, p_user, 'ACTIVE')
  returning id into v_member;

  insert into public.member_roles (organization_member_id, role_id)
  select v_member, r.id from public.roles r where r.code = p_role_code;
end;
$$;

create function pg_temp.new_submission(p_retailer uuid, p_shop uuid, p_submitter uuid)
returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.receipt_submissions (
    id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
    storage_bucket, storage_object_path, original_file_name, mime_type,
    file_size_bytes, file_sha256, status, submitted_at
  )
  values (
    v_id, p_retailer, p_shop, p_submitter,
    'receipts',
    p_retailer::text || '/' || p_submitter::text || '/' || v_id::text || '/original.jpg',
    'receipt.jpg', 'image/jpeg', 2048,
    md5(v_id::text) || md5(v_id::text || 'x'),
    'SUBMITTED', now()
  );
  return v_id;
end;
$$;

create function pg_temp.set_mode(p_mode text) returns void
language sql as $$ update public.receipt_extraction_runtime set mode = p_mode where id; $$;

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

/* Claims an attempt with the pair the CURRENT runtime mode admits, and returns the token. */
create function pg_temp.claim_attempt(p_extraction uuid) returns uuid
language plpgsql as $$
declare
  v_mode  text;
  v_token uuid;
begin
  select mode into v_mode from public.receipt_extraction_runtime where id;

  if v_mode = 'AZURE' then
    select claim_token into v_token
    from public.claim_receipt_extraction_job(
      p_extraction, 'AZURE_DOCUMENT_INTELLIGENCE', 'prebuilt-receipt'
    );
  else
    select claim_token into v_token
    from public.claim_receipt_extraction_job(p_extraction, 'FAKE', 'fake-receipt-v1');
  end if;

  return v_token;
end;
$$;

/* Drives one attempt to FAILED through the worker contract, in whichever mode is set. */
create function pg_temp.fail_attempt(p_extraction uuid) returns void
language plpgsql as $$
declare
  v_token uuid;
  v_op    text := 'op:' || gen_random_uuid()::text;
begin
  v_token := pg_temp.claim_attempt(p_extraction);
  perform public.record_receipt_extraction_operation(p_extraction, v_token, v_op);
  perform public.record_receipt_extraction_failure(
    p_extraction, v_token, v_op, 'PROVIDER_TIMEOUT'
  );
end;
$$;

/* Drives one attempt to SUCCEEDED through the worker contract. */
create function pg_temp.complete_attempt(p_extraction uuid) returns void
language plpgsql as $$
declare
  v_token uuid;
  v_op    text := 'op:' || gen_random_uuid()::text;
begin
  v_token := pg_temp.claim_attempt(p_extraction);
  perform public.record_receipt_extraction_operation(p_extraction, v_token, v_op);
  perform public.record_receipt_extraction_success(
    p_extraction, v_token, v_op,
    jsonb_build_object(
      'merchant_name', 'Lulu Hypermarket',
      'transaction_date', '2026-07-12',
      'currency_code', 'AED',
      'total_minor', 123456
    ),
    jsonb_build_array(jsonb_build_object(
      'line_number', 1, 'description', 'Basmati Rice 5kg',
      'quantity', 2, 'unit_price_minor', 4400, 'line_total_minor', 8800, 'confidence', 0.97
    ))
  );
end;
$$;

/*
 * Writes a terminal FAILED attempt directly.
 *
 * WHY THE TABLE AND NOT THE RPCs. Cases 5 and 6 need the LATEST attempt to be FAILED while
 * an active — or a succeeded — attempt also exists, and the client RPC cannot produce that
 * ordering: a request refuses to create anything while an attempt is open or has succeeded.
 * Those two conjuncts are documented as redundant-but-written-out precisely because "latest
 * is FAILED" implies them under the partial unique indexes; the only way to test them at all
 * is to construct the state they defend against. Nothing here is a permitted client action,
 * and no guard is disabled: this is an INSERT of a terminal row, which the table's own
 * BEFORE INSERT tenant trigger and every CHECK still validate in full.
 */
create function pg_temp.insert_failed_attempt(p_submission uuid, p_attempt integer)
returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.receipt_extractions (
    receipt_submission_id, retailer_organization_id, requested_by_profile_id,
    attempt_number, status, expires_at, completed_at, failure_code
  )
  select
    p_submission, s.retailer_organization_id, s.submitted_by_profile_id,
    p_attempt, 'FAILED', now() + interval '15 minutes', now(), 'PROVIDER_TIMEOUT'
  from public.receipt_submissions s
  where s.id = p_submission
  returning id into v_id;

  return v_id;
end;
$$;

/* retry_allowed as read by a signed-in caller. NULL when the function returns no row. */
create function pg_temp.retry_as(p_user uuid, p_submission uuid) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.act_as(p_user);
  select retry_allowed::text into v from public.get_my_receipt_extraction(p_submission);
  perform pg_temp.sign_out();
  return v;
end;
$$;

/* status | attempts_used | attempts_remaining | retry_allowed | confirmation_exists */
create function pg_temp.counters_as(p_user uuid, p_submission uuid) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.act_as(p_user);
  select status || '|' || attempts_used || '|' || attempts_remaining
         || '|' || retry_allowed || '|' || confirmation_exists
    into v
  from public.get_my_receipt_extraction(p_submission);
  perform pg_temp.sign_out();
  return v;
end;
$$;

create function pg_temp.rows_as(p_user uuid, p_submission uuid) returns bigint
language plpgsql as $$
declare v bigint;
begin
  perform pg_temp.act_as(p_user);
  select count(*) into v from public.get_my_receipt_extraction(p_submission);
  perform pg_temp.sign_out();
  return v;
end;
$$;

/* The SQLSTATE the read raises for the given caller, or NULL when it returns normally. */
create function pg_temp.get_sqlstate_as(p_user uuid, p_submission uuid) returns text
language plpgsql as $$
begin
  if p_user is null then
    perform pg_temp.sign_out();
  else
    perform pg_temp.act_as(p_user);
  end if;

  perform * from public.get_my_receipt_extraction(p_submission);
  perform pg_temp.sign_out();
  return null;
exception when others then
  return sqlstate;
end;
$$;

create function pg_temp.mode_sqlstate(p_mode text) returns text
language plpgsql as $$
begin
  perform pg_temp.set_mode(p_mode);
  return null;
exception when others then
  return sqlstate;
end;
$$;

/* The declared OUTPUT columns of a `returns table` function. */
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

/* The declared INPUT arguments of a function. */
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

/* Confirms a receipt as its submitter, and returns the outcome. */
create function pg_temp.confirm_as(p_user uuid, p_submission uuid) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.act_as(p_user);
  select outcome into v
  from public.confirm_receipt_extraction(
    p_submission, date '2026-07-12', 'AED', 2::smallint, 123456::bigint
  );
  perform pg_temp.sign_out();
  return v;
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
  v_other    uuid;
  v_owner    uuid;
begin
  insert into public.organizations (id, name, organization_type, status)
  values (v_retailer, 'Azure Retry Test Retailer', 'RETAILER', 'ACTIVE');

  insert into public.retailer_shops (id, retailer_organization_id, name, code, status)
  values (v_shop, v_retailer, 'Azure Retry Test Shop', 'ART1', 'ACTIVE');

  v_sales := pg_temp.new_user('azure_retry_sales');
  v_other := pg_temp.new_user('azure_retry_other_sales');
  v_owner := pg_temp.new_user('azure_retry_owner');

  perform pg_temp.grant_role(v_sales, v_retailer, 'SALES_STAFF');
  perform pg_temp.grant_role(v_other, v_retailer, 'SALES_STAFF');
  perform pg_temp.grant_role(v_owner, v_retailer, 'RETAILER_OWNER');

  insert into t_ids values
    ('retailer', v_retailer),
    ('shop', v_shop),
    ('sales', v_sales),
    ('other', v_other),
    ('owner', v_owner);
end;
$$;

do $$
declare
  v_label text;
begin
  foreach v_label in array array[
    'sub_fake', 'sub_azure', 'sub_exhausted', 'sub_open', 'sub_success', 'sub_confirm'
  ]
  loop
    insert into t_ids values (
      v_label,
      pg_temp.new_submission(
        (select id from t_ids where label = 'retailer'),
        (select id from t_ids where label = 'shop'),
        (select id from t_ids where label = 'sales')
      )
    );
  end loop;
end;
$$;

-- The deployed state, before any test touches it.
select is(
  (select mode from public.receipt_extraction_runtime),
  'DISABLED',
  'the runtime is DISABLED before this suite changes it'
);

-- ============================================================================
-- SECTION A — FAKE is unchanged
-- ============================================================================
select pg_temp.set_mode('FAKE');
select pg_temp.fail_attempt(pg_temp.queue_attempt(
  (select id from t_ids where label = 'sales'),
  (select id from t_ids where label = 'sub_fake')
));

select is(
  pg_temp.counters_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_fake')
  ),
  'FAILED|1|2|true|false',
  'FAILED + FAKE + capacity remaining -> retry_allowed is TRUE'
);

-- ============================================================================
-- SECTION B — AZURE is the fix
-- ============================================================================
select pg_temp.set_mode('AZURE');
select pg_temp.fail_attempt(pg_temp.queue_attempt(
  (select id from t_ids where label = 'sales'),
  (select id from t_ids where label = 'sub_azure')
));

select is(
  pg_temp.counters_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_azure')
  ),
  'FAILED|1|2|true|false',
  'FAILED + AZURE + capacity remaining -> retry_allowed is TRUE'
);

-- The SAME row, read with the gate shut. Only the mode differs.
select pg_temp.set_mode('DISABLED');
select is(
  pg_temp.retry_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_azure')
  ),
  'false',
  'the SAME row with the runtime DISABLED -> retry_allowed is FALSE'
);

-- And the counters stay FACTUAL while the gate is shut: only availability moved.
select is(
  pg_temp.counters_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_azure')
  ),
  'FAILED|1|2|false|false',
  'DISABLED changes retry_allowed and nothing else'
);

select pg_temp.set_mode('AZURE');
select is(
  pg_temp.retry_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_azure')
  ),
  'true',
  'restoring AZURE restores the retry: the mode is the only thing that moved'
);

select is(
  pg_temp.mode_sqlstate('GEMINI'),
  '23514',
  'an unknown runtime mode remains unrepresentable, so the read cannot meet one'
);

select is(
  (select mode from public.receipt_extraction_runtime),
  'AZURE',
  'and the refused mode change left the runtime row untouched'
);

-- ============================================================================
-- SECTION C — every other conjunct still blocks, with AZURE set
-- ============================================================================

-- ---- Attempts exhausted -----------------------------------------------------
do $$
declare
  v_sub uuid := (select id from t_ids where label = 'sub_exhausted');
  v_who uuid := (select id from t_ids where label = 'sales');
  i     integer;
begin
  for i in 1..3 loop
    perform pg_temp.fail_attempt(pg_temp.queue_attempt(v_who, v_sub));
  end loop;
end;
$$;

select is(
  pg_temp.counters_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_exhausted')
  ),
  'FAILED|3|0|false|false',
  'FAILED + AZURE + attempts exhausted -> retry_allowed is FALSE'
);

-- The budget itself is unchanged: a fourth request creates nothing and says so.
select pg_temp.act_as((select id from t_ids where label = 'sales'));
select is(
  (select outcome || '|' || attempts_used || '|' || attempts_remaining
   from public.request_receipt_extraction(
     (select id from t_ids where label = 'sub_exhausted')
   )),
  'EXHAUSTED|3|0',
  'the three-attempt budget still holds in AZURE'
);
select is(
  (select count(*) from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label = 'sub_exhausted')),
  3::bigint,
  'and no fourth row was written'
);
select pg_temp.sign_out();

-- ---- QUEUED, then PROCESSING, then an active attempt beside a FAILED latest --
select is(
  pg_temp.retry_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_open')
  ),
  null,
  'no attempt at all -> no row, so nothing to retry'
);

select pg_temp.queue_attempt(
  (select id from t_ids where label = 'sales'),
  (select id from t_ids where label = 'sub_open')
) is not null as queued;

select is(
  pg_temp.counters_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_open')
  ),
  'QUEUED|1|2|false|false',
  'QUEUED in AZURE -> retry_allowed is FALSE'
);

select pg_temp.claim_attempt(
  (select id from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label = 'sub_open'))
) is not null as claimed;

select is(
  pg_temp.counters_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_open')
  ),
  'PROCESSING|1|2|false|false',
  'PROCESSING in AZURE -> retry_allowed is FALSE'
);

select pg_temp.insert_failed_attempt(
  (select id from t_ids where label = 'sub_open'), 2
) is not null as forced;

select is(
  pg_temp.counters_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_open')
  ),
  'FAILED|2|1|false|false',
  'FAILED latest + AZURE + capacity, but an ACTIVE attempt exists -> FALSE'
);

-- ---- SUCCEEDED, then a FAILED latest beside it ------------------------------
select pg_temp.complete_attempt(pg_temp.queue_attempt(
  (select id from t_ids where label = 'sales'),
  (select id from t_ids where label = 'sub_success')
));

select is(
  pg_temp.counters_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_success')
  ),
  'SUCCEEDED|1|2|false|false',
  'SUCCEEDED in AZURE -> retry_allowed is FALSE'
);

select pg_temp.insert_failed_attempt(
  (select id from t_ids where label = 'sub_success'), 2
) is not null as forced;

select is(
  pg_temp.counters_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_success')
  ),
  'FAILED|2|1|false|false',
  'FAILED latest + AZURE + capacity, but a SUCCEEDED attempt exists -> FALSE'
);

-- ---- A confirmation ---------------------------------------------------------
select pg_temp.fail_attempt(pg_temp.queue_attempt(
  (select id from t_ids where label = 'sales'),
  (select id from t_ids where label = 'sub_confirm')
));

select is(
  pg_temp.retry_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_confirm')
  ),
  'true',
  'the retry is offered before the receipt is confirmed'
);

select is(
  pg_temp.confirm_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_confirm')
  ),
  'CONFIRMED',
  'the submitter confirms the receipt manually'
);

select is(
  pg_temp.counters_as(
    (select id from t_ids where label = 'sales'),
    (select id from t_ids where label = 'sub_confirm')
  ),
  'FAILED|1|2|false|true',
  'FAILED + AZURE + capacity, but the receipt is CONFIRMED -> FALSE'
);

-- ============================================================================
-- SECTION D — authorization is untouched
-- ============================================================================
select is(
  pg_temp.rows_as(
    (select id from t_ids where label = 'other'),
    (select id from t_ids where label = 'sub_azure')
  ),
  0::bigint,
  'another SALES_STAFF member at the SAME Retailer sees zero rows'
);

select is(
  pg_temp.retry_as(
    (select id from t_ids where label = 'other'),
    (select id from t_ids where label = 'sub_azure')
  ),
  null,
  'and therefore learns nothing about that receipt''s retry eligibility'
);

select is(
  pg_temp.get_sqlstate_as(
    (select id from t_ids where label = 'owner'),
    (select id from t_ids where label = 'sub_azure')
  ),
  '42501',
  'a Retailer Owner is refused outright'
);

select is(
  pg_temp.get_sqlstate_as(
    null,
    (select id from t_ids where label = 'sub_azure')
  ),
  '42501',
  'an unauthenticated caller is refused outright'
);

select is(
  pg_temp.input_args('get_my_receipt_extraction'),
  array['p_submission_id'],
  'no caller-identity parameter was introduced: the submission id is the only argument'
);

-- ============================================================================
-- SECTION E — the exposed surface is unchanged
-- ============================================================================
select ok(
  not (pg_temp.table_columns('get_my_receipt_extraction') && array[
    'provider', 'provider_model', 'provider_operation_id', 'worker_claim_token',
    'expires_at', 'storage_bucket', 'object_path', 'storage_object_path',
    'file_sha256', 'retailer_organization_id', 'requested_by_profile_id'
  ]),
  'no service-role-only or storage column is returned to the client'
);

select is(
  array_length(pg_temp.table_columns('get_my_receipt_extraction'), 1),
  39,
  'the returned column count is exactly what it was before this migration'
);

select ok(
  has_function_privilege(
    'authenticated', 'public.get_my_receipt_extraction(uuid)', 'EXECUTE'
  ),
  'authenticated still executes the read'
);

select ok(
  not has_function_privilege(
    'anon', 'public.get_my_receipt_extraction(uuid)', 'EXECUTE'
  ),
  'anon still does not'
);

select ok(
  not has_table_privilege('authenticated', 'public.receipt_extractions', 'SELECT'),
  'and no direct client access to the extraction table was added'
);

select ok(
  not has_table_privilege('authenticated', 'public.receipt_extraction_runtime', 'SELECT'),
  'the runtime table remains unreadable by authenticated'
);

select ok(
  not has_table_privilege('authenticated', 'public.receipt_extraction_runtime', 'UPDATE'),
  'and unwritable by authenticated'
);

select * from finish();

rollback;
