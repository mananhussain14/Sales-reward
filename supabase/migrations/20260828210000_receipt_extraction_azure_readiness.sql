-- Migration: receipt_extraction_azure_readiness
-- Purpose: Allow a claimed extraction attempt to record provider failures that occur
--          BEFORE the provider issues an operation identifier.
--
-- WHY THIS IS REQUIRED
--   A real asynchronous provider may fail while accepting a document: network failure,
--   timeout, quota exhaustion, unsupported input or an internal service error. In those
--   cases no operation identifier exists. The original fake-only contract admitted only
--   OBJECT_UNREADABLE without an operation identifier, which would leave a legitimate
--   submit failure stuck in PROCESSING until the reaper expired it.
--
-- THE OPERATION-ID PROOF IS PRESERVED
--
--   PATH A — NO OPERATION ISSUED
--     The supplied operation id must be NULL.
--     The stored operation id must still be NULL.
--     Only failures that can occur before an operation is issued are accepted.
--
--   PATH B — OPERATION ISSUED
--     The supplied operation id must be non-empty.
--     The stored operation id must be non-null.
--     The supplied and stored operation ids must match exactly.
--
-- PROVIDER_REJECTED_DOCUMENT and NORMALIZATION_FAILED remain PATH B only. They describe
-- the result of an analysis operation and therefore cannot truthfully exist before an
-- operation identifier has been registered.
--
-- WORKER_ABANDONED and NEVER_CLAIMED remain reaper-only.
--
-- No provider error body, message, request id, URL or payload is accepted or stored.

create or replace function public.record_receipt_extraction_failure(
  p_extraction_id         uuid,
  p_claim_token           uuid,
  p_provider_operation_id text,
  p_failure_code          text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_updated    integer;
  v_retailer   uuid;
  v_attempt    integer;
  v_used       integer;
  v_submission uuid;
begin
  if p_extraction_id is null
     or p_claim_token is null
     or p_failure_code is null then
    raise exception 'Receipt extraction failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- Reaper-only outcomes can never be written by a worker.
  if p_failure_code in ('WORKER_ABANDONED', 'NEVER_CLAIMED') then
    raise exception 'Receipt extraction failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- Closed worker-writable vocabulary.
  if p_failure_code not in (
    'OBJECT_UNREADABLE',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_QUOTA_EXCEEDED',
    'PROVIDER_TIMEOUT',
    'PROVIDER_REJECTED_DOCUMENT',
    'UNSUPPORTED_IMAGE',
    'NORMALIZATION_FAILED',
    'INTERNAL'
  ) then
    raise exception 'Receipt extraction failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  if p_provider_operation_id is null then
    -- PATH A: no operation identifier was issued.
    --
    -- PROVIDER_REJECTED_DOCUMENT and NORMALIZATION_FAILED are deliberately absent:
    -- both require an analysis operation to have existed.
    if p_failure_code not in (
      'OBJECT_UNREADABLE',
      'PROVIDER_UNAVAILABLE',
      'PROVIDER_QUOTA_EXCEEDED',
      'PROVIDER_TIMEOUT',
      'UNSUPPORTED_IMAGE',
      'INTERNAL'
    ) then
      raise exception 'Receipt extraction failure could not be recorded'
        using errcode = 'check_violation';
    end if;

    update public.receipt_extractions
    set
      status       = 'FAILED',
      failure_code = p_failure_code,
      completed_at = now(),
      updated_at   = now()
    where id = p_extraction_id
      and status = 'PROCESSING'
      and worker_claim_token = p_claim_token
      and provider_operation_id is null
    returning
      retailer_organization_id,
      attempt_number,
      receipt_submission_id
    into
      v_retailer,
      v_attempt,
      v_submission;
  else
    -- PATH B: an operation identifier exists and must match exactly.
    if btrim(p_provider_operation_id) = ''
       or p_failure_code not in (
         'PROVIDER_UNAVAILABLE',
         'PROVIDER_QUOTA_EXCEEDED',
         'PROVIDER_TIMEOUT',
         'PROVIDER_REJECTED_DOCUMENT',
         'UNSUPPORTED_IMAGE',
         'NORMALIZATION_FAILED',
         'INTERNAL'
       ) then
      raise exception 'Receipt extraction failure could not be recorded'
        using errcode = 'check_violation';
    end if;

    update public.receipt_extractions
    set
      status       = 'FAILED',
      failure_code = p_failure_code,
      completed_at = now(),
      updated_at   = now()
    where id = p_extraction_id
      and status = 'PROCESSING'
      and worker_claim_token = p_claim_token
      and provider_operation_id is not null
      and provider_operation_id = btrim(p_provider_operation_id)
    returning
      retailer_organization_id,
      attempt_number,
      receipt_submission_id
    into
      v_retailer,
      v_attempt,
      v_submission;
  end if;

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'Receipt extraction failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  select count(*)
  into v_used
  from public.receipt_extractions x
  where x.receipt_submission_id = v_submission;

  insert into public.audit_logs (
    organization_id,
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  values (
    v_retailer,
    null,
    'RECEIPT_EXTRACTION_FAILED',
    'RECEIPT_EXTRACTION',
    p_extraction_id::text,
    jsonb_build_object(
      'actor_kind', 'SYSTEM_WORKER',
      'attempt_number', v_attempt,
      'failure_code', p_failure_code,
      'attempts_remaining', greatest(0, 3 - v_used)
    )
  );
end;
$$;

revoke all
  on function public.record_receipt_extraction_failure(uuid, uuid, text, text)
  from public;

revoke execute
  on function public.record_receipt_extraction_failure(uuid, uuid, text, text)
  from anon;

revoke execute
  on function public.record_receipt_extraction_failure(uuid, uuid, text, text)
  from authenticated;

grant execute
  on function public.record_receipt_extraction_failure(uuid, uuid, text, text)
  to service_role;

comment on function public.record_receipt_extraction_failure(uuid, uuid, text, text) is
  'Completes one claimed receipt extraction failure. Before an operation is issued, accepts only the closed pre-operation failure set with a NULL operation id. After registration, requires the exact stored operation id.';

-- ============================================================================
-- PART 2 — AZURE DATABASE READINESS
-- ============================================================================
-- The row remains DISABLED. This migration only makes AZURE an allowed,
-- deliberate operator-selected value.
alter table public.receipt_extraction_runtime
  drop constraint receipt_extraction_runtime_mode_allowed,
  add constraint receipt_extraction_runtime_mode_allowed
    check (
      mode = any (
        array[
          'DISABLED'::text,
          'FAKE'::text,
          'AZURE'::text
        ]
      )
    );

-- Provider and model are persisted operational metadata. No endpoint, key,
-- response payload or provider error text is stored.
alter table public.receipt_extractions
  drop constraint receipt_extractions_provider_allowed,
  add constraint receipt_extractions_provider_allowed
    check (
      provider is null
      or provider = any (
        array[
          'FAKE'::text,
          'AZURE_DOCUMENT_INTELLIGENCE'::text
        ]
      )
    ),
  add constraint receipt_extractions_provider_model_pair_allowed
    check (
      (provider is null and provider_model is null)
      or (
        provider = 'FAKE'
        and provider_model = 'fake-receipt-v1'
      )
      or (
        provider = 'AZURE_DOCUMENT_INTELLIGENCE'
        and provider_model = any (
          array[
            'prebuilt-receipt'::text,
            'prebuilt-invoice'::text
          ]
        )
      )
    );

-- The authenticated request may queue work when either real runtime is
-- deliberately enabled. DISABLED and every unknown value still fail closed.
create or replace function public.request_receipt_extraction(
  p_submission_id uuid
)
returns table (
  outcome                     text,
  extraction_id               uuid,
  attempt_number              integer,
  attempts_used               integer,
  attempts_remaining          integer,
  retry_allowed               boolean,
  manual_confirmation_allowed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_retailer      uuid;
  v_uid           uuid;
  v_used          integer;
  v_remaining     integer;
  v_active        public.receipt_extractions%rowtype;
  v_succeeded     public.receipt_extractions%rowtype;
  v_latest        public.receipt_extractions%rowtype;
  v_confirmation  uuid;
  v_mode          text;
  v_new_id        uuid;
  v_attempt       integer;
begin
  if not public.assert_my_receipt_extraction_access(p_submission_id) then
    return;  -- zero rows: unknown, not yours, another Retailer's, or not SUBMITTED
  end if;

  v_uid := auth.uid();
  v_retailer := public.resolve_retailer_member_organization('RECEIPT_EXTRACTION_REVIEW');

  -- Counters, computed once and reported unchanged on every branch below.
  select count(*) into v_used
  from public.receipt_extractions x
  where x.receipt_submission_id = p_submission_id;
  v_remaining := greatest(0, 3 - v_used);

  -- ---- 2. An existing confirmation makes extraction moot --------------------
  select c.id into v_confirmation
  from public.receipt_confirmations c
  where c.receipt_submission_id = p_submission_id;

  if v_confirmation is not null then
    return query select 'ALREADY_CONFIRMED'::text, null::uuid, null::integer,
                        v_used, v_remaining, false, false;
    return;
  end if;

  -- ---- 3. An active attempt --------------------------------------------------
  select * into v_active
  from public.receipt_extractions x
  where x.receipt_submission_id = p_submission_id
    and x.status in ('QUEUED', 'PROCESSING');

  if v_active.id is not null then
    return query select 'ACTIVE'::text, v_active.id, v_active.attempt_number,
                        v_used, v_remaining, false, false;
    return;
  end if;

  -- ---- 4. A successful attempt -----------------------------------------------
  select * into v_succeeded
  from public.receipt_extractions x
  where x.receipt_submission_id = p_submission_id
    and x.status = 'SUCCEEDED';

  if v_succeeded.id is not null then
    return query select 'SUCCEEDED'::text, v_succeeded.id, v_succeeded.attempt_number,
                        v_used, v_remaining, false, true;
    return;
  end if;

  -- ---- 5. Exhausted ----------------------------------------------------------
  if v_used >= 3 then
    select * into v_latest
    from public.receipt_extractions x
    where x.receipt_submission_id = p_submission_id
    order by x.attempt_number desc
    limit 1;

    return query select 'EXHAUSTED'::text, v_latest.id, v_latest.attempt_number,
                        v_used, 0, false, true;
    return;
  end if;

  -- ---- 6. The runtime gate, guarding the INSERT and nothing else -------------
  select r.mode into v_mode
  from public.receipt_extraction_runtime r
  where r.id;

  if coalesce(v_mode, 'DISABLED') not in ('FAKE', 'AZURE') then
    -- Indistinguishable from an outage, a dead worker or a timeout, deliberately: the
    -- action is identical in every one of those cases. The counters remain FACTUAL.
    return query select 'EXTRACTION_UNAVAILABLE'::text, null::uuid, null::integer,
                        v_used, v_remaining, false, true;
    return;
  end if;

  -- ---- 7. Create the attempt --------------------------------------------------
  v_attempt := v_used + 1;

  begin
    insert into public.receipt_extractions (
      receipt_submission_id, retailer_organization_id, requested_by_profile_id,
      attempt_number, status, expires_at
    )
    values (
      p_submission_id, v_retailer, v_uid,
      v_attempt, 'QUEUED',
      -- The QUEUE deadline. A literal, never a parameter. The claim resets it to the
      -- shorter work deadline.
      now() + interval '15 minutes'
    )
    returning id into v_new_id;
  exception when unique_violation then
    -- receipt_extractions_active_attempt_unique_idx or ..._submission_attempt_unique_idx:
    -- a concurrent caller won. Re-read and report the winner's closed state rather than a
    -- raw 23505, which is not something a client can act on.
    declare
      v_inner text;
    begin
      get stacked diagnostics v_inner = constraint_name;
      if v_inner in (
        'receipt_extractions_active_attempt_unique_idx',
        'receipt_extractions_submission_attempt_unique_idx',
        'receipt_extractions_succeeded_unique_idx'
      ) then
        select count(*) into v_used
        from public.receipt_extractions x
        where x.receipt_submission_id = p_submission_id;
        v_remaining := greatest(0, 3 - v_used);

        select * into v_active
        from public.receipt_extractions x
        where x.receipt_submission_id = p_submission_id
          and x.status in ('QUEUED', 'PROCESSING');

        if v_active.id is not null then
          return query select 'ACTIVE'::text, v_active.id, v_active.attempt_number,
                              v_used, v_remaining, false, false;
          return;
        end if;

        select * into v_succeeded
        from public.receipt_extractions x
        where x.receipt_submission_id = p_submission_id
          and x.status = 'SUCCEEDED';

        if v_succeeded.id is not null then
          return query select 'SUCCEEDED'::text, v_succeeded.id, v_succeeded.attempt_number,
                              v_used, v_remaining, false, true;
          return;
        end if;

        return query select 'EXTRACTION_UNAVAILABLE'::text, null::uuid, null::integer,
                            v_used, v_remaining, false, true;
        return;
      end if;
      raise;
    end;
  end;

  -- The only audit event this function writes, and only when a row was actually created.
  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_retailer, v_uid, 'RECEIPT_EXTRACTION_REQUESTED', 'RECEIPT_EXTRACTION',
    v_new_id::text,
    jsonb_build_object('attempt_number', v_attempt)
  );

  return query select 'QUEUED'::text, v_new_id, v_attempt,
                      v_used + 1, greatest(0, 3 - (v_used + 1)), false, false;
end;
$$;

revoke all     on function public.request_receipt_extraction(uuid) from public;
revoke execute on function public.request_receipt_extraction(uuid) from anon;
grant  execute on function public.request_receipt_extraction(uuid) to authenticated;

-- Claiming is stricter than merely accepting a provider name: the provider,
-- model and current database runtime mode must all agree.
create or replace function public.claim_receipt_extraction_job(
  p_extraction_id  uuid,
  p_provider       text,
  p_provider_model text
)
returns table (
  extraction_id       uuid,
  claim_token         uuid,
  storage_bucket      text,
  storage_object_path text,
  mime_type           text,
  attempt_number      integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_submission_id uuid;
  v_token         uuid;
  v_attempt       integer;
  v_retailer      uuid;
  v_claimed       integer;
  v_mode          text;
begin
  if p_extraction_id is null then
    raise exception 'Receipt extraction job could not be claimed'
      using errcode = 'check_violation';
  end if;

  -- Provider and model form one closed pair, and that pair must match the
  -- database runtime mode. This prevents a misconfigured Edge environment from
  -- claiming an AZURE job with the fake provider, or a FAKE job with Azure.
  if p_provider_model is null
     or btrim(p_provider_model) = ''
     or length(btrim(p_provider_model)) > 100 then
    raise exception 'Receipt extraction job could not be claimed'
      using errcode = 'check_violation';
  end if;

  select r.mode into v_mode
  from public.receipt_extraction_runtime r
  where r.id;

  if not (
    (
      coalesce(v_mode, 'DISABLED') = 'FAKE'
      and p_provider = 'FAKE'
      and btrim(p_provider_model) = 'fake-receipt-v1'
    )
    or
    (
      coalesce(v_mode, 'DISABLED') = 'AZURE'
      and p_provider = 'AZURE_DOCUMENT_INTELLIGENCE'
      and btrim(p_provider_model) in (
        'prebuilt-receipt',
        'prebuilt-invoice'
      )
    )
  ) then
    raise exception 'Receipt extraction job could not be claimed'
      using errcode = 'check_violation';
  end if;

  -- THE CLAIM. The token is generated HERE, by the database, from a CSPRNG; there is no
  -- parameter through which a worker could propose one. The deadline is a literal for the
  -- same reason — a worker must not choose how long it may hold a job.
  update public.receipt_extractions
  set
    status             = 'PROCESSING',
    provider           = p_provider,
    provider_model     = btrim(p_provider_model),
    worker_claim_token = gen_random_uuid(),
    started_at         = now(),
    expires_at         = now() + interval '5 minutes',
    updated_at         = now()
  where id = p_extraction_id
    and status = 'QUEUED'
  returning receipt_submission_id, worker_claim_token, receipt_extractions.attempt_number,
            retailer_organization_id
       into v_submission_id, v_token, v_attempt, v_retailer;

  get diagnostics v_claimed = row_count;

  -- Lost the race, or there was no such job. Both are normal; both return zero rows.
  if v_claimed <> 1 then
    return;
  end if;

  -- Recorded as a SYSTEM WORKER action: no actor profile, and a metadata discriminator that
  -- makes the null actor provably a machine rather than merely an absent identity. The
  -- provider name and model are literals, not secrets. The operation id is NOT recorded —
  -- it does not exist yet, and it is forbidden metadata in any case.
  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_retailer,
    null,
    'RECEIPT_EXTRACTION_CLAIMED',
    'RECEIPT_EXTRACTION',
    p_extraction_id::text,
    jsonb_build_object(
      'actor_kind', 'SYSTEM_WORKER',
      'attempt_number', v_attempt,
      'provider', p_provider,
      'provider_model', btrim(p_provider_model)
    )
  );

  return query
  select
    p_extraction_id,
    v_token,
    s.storage_bucket,
    s.storage_object_path,
    s.mime_type,
    v_attempt
  from public.receipt_submissions s
  where s.id = v_submission_id;
end;
$$;

revoke all     on function public.claim_receipt_extraction_job(uuid, text, text) from public;
revoke execute on function public.claim_receipt_extraction_job(uuid, text, text) from anon;
revoke execute on function public.claim_receipt_extraction_job(uuid, text, text) from authenticated;
grant  execute on function public.claim_receipt_extraction_job(uuid, text, text) to service_role;

-- Polling occurs in a later invocation, so provider selection must come from
-- the attempt's immutable stored metadata rather than the current environment.
drop function public.get_receipt_extraction_worker_state(uuid);

create function public.get_receipt_extraction_worker_state(
  p_extraction_id uuid
)
returns table (
  status                text,
  provider              text,
  provider_model        text,
  worker_claim_token    uuid,
  provider_operation_id text,
  expires_at            timestamptz,
  started_at            timestamptz,
  attempt_number        integer,
  storage_bucket        text,
  storage_object_path   text,
  mime_type             text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_extraction_id is null then
    return;
  end if;

  return query
  select
    x.status,
    x.provider,
    x.provider_model,
    x.worker_claim_token,
    x.provider_operation_id,
    x.expires_at,
    x.started_at,
    x.attempt_number,
    s.storage_bucket,
    s.storage_object_path,
    s.mime_type
  from public.receipt_extractions x
  join public.receipt_submissions s on s.id = x.receipt_submission_id
  where x.id = p_extraction_id;
end;
$$;

revoke all     on function public.get_receipt_extraction_worker_state(uuid) from public;
revoke execute on function public.get_receipt_extraction_worker_state(uuid) from anon;
revoke execute on function public.get_receipt_extraction_worker_state(uuid) from authenticated;
grant  execute on function public.get_receipt_extraction_worker_state(uuid) to service_role;
