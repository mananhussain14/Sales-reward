-- Migration: receipt_extraction_worker_operations
-- Purpose: The SEVEN service-role operations over the extraction foundation. Adds exactly
--          seven functions and nothing else:
--            1. claim_receipt_extraction_job(uuid, text, text)
--            2. record_receipt_extraction_operation(uuid, uuid, text)
--            3. record_receipt_extraction_success(uuid, uuid, text, jsonb, jsonb)
--            4. record_receipt_extraction_failure(uuid, uuid, text, text)
--            5. expire_stale_receipt_extraction_claims(uuid default null)
--            6. get_receipt_object_reference(uuid)
--            7. get_receipt_extraction_worker_state(uuid)
--
-- THE NON-CIRCULAR CLAIM SEQUENCE
--   A worker cannot supply a provider operation identifier before it has claimed the job,
--   received the storage reference, downloaded the object and submitted it — so a claim
--   function that demanded one would be impossible to call. The sequence is therefore:
--
--     claim(extraction, provider, model)  -> PROCESSING + a server-generated claim token
--                                            + the storage coordinates
--     ... the worker downloads and submits ...
--     record_operation(extraction, token, operation_id)   -> PROCESSING -> PROCESSING, once
--     record_success / record_failure(extraction, token, operation_id, ...)
--
--   Every step after the claim proves possession of the TOKEN, and the token is generated
--   inside PostgreSQL by gen_random_uuid() and is never accepted as an argument.
--
-- WHY A TOKEN AND NOT RE-ASSERTED FACTS. finalize_receipt_submission_upload (migration
--   20260726210000) defends against a stale callback by re-asserting the hash and path the
--   reservation recorded, which works because that sequence has no rival. Extraction's
--   threat model IS a rival: a second worker. Any caller able to read the row can restate
--   its facts, so re-assertion identifies the ROW and not the WORKER. Only a nonce issued
--   at claim time does that.
--
-- A LOST CLAIM IS ZERO ROWS, NOT AN ERROR. Losing a race is a normal outcome for a worker;
--   raising would make every loser log a fault. "Already claimed" and "no such job" are
--   deliberately indistinguishable, because the correct response to both is to do nothing.
--   An INVALID TOKEN, by contrast, RAISES 23514 — a worker that believes it holds a job
--   must not proceed on a false belief.
--
-- STATUS IS CHECKED IN ADDITION TO THE TOKEN, NEVER INSTEAD OF IT. Every mutating predicate
--   below requires `status = 'PROCESSING'` as well as the matching token, which is what
--   makes a late worker harmless: once the reaper has moved the row to FAILED, a correct
--   token and a correct operation id still match zero rows and still raise.
--
-- NO AZURE. No endpoint, credential, SDK, region or service name appears here.
--   `receipt_extractions_provider_allowed` restricts provider to 'FAKE', and this migration
--   re-validates the argument before writing it.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE). No
--   fixed UUIDs. No dynamic SQL. Every reference is schema-qualified because every function
--   runs with an EMPTY search_path.
--
-- Dependencies: 20260726090000 (receipt_submissions), 20260812090000 (iso_currency_codes),
--   20260812210000 (the extraction foundation), 20260716130351 (audit_logs).

-- ============================================================================
-- FUNCTION 1 — claim_receipt_extraction_job(uuid, text, text)
-- ============================================================================
-- Atomically takes a QUEUED attempt to PROCESSING and hands the claiming worker everything
-- it needs: a claim token, the storage coordinates, and the MIME type.
--
-- THE SINGLE CONDITIONAL UPDATE IS THE CONCURRENCY AUTHORITY. Under READ COMMITTED, a
-- second worker's identical UPDATE blocks on the first worker's row lock, then re-evaluates
-- its WHERE clause against the committed new version, finds PROCESSING, and updates zero
-- rows. This is the same idiom finalize_receipt_submission_upload already uses; a
-- SELECT-then-UPDATE would have a window between the two statements.
--
-- THE STORAGE COORDINATES GO ONLY TO service_role. This function is not executable by anon
-- or authenticated, and no authenticated RPC in this milestone returns a bucket or a path.
create function public.claim_receipt_extraction_job(
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
begin
  if p_extraction_id is null then
    raise exception 'Receipt extraction job could not be claimed'
      using errcode = 'check_violation';
  end if;

  -- Milestone A admits one provider. Re-validated here as well as by the table CHECK so a
  -- misconfigured worker is refused before it writes anything.
  if p_provider is distinct from 'FAKE' then
    raise exception 'Receipt extraction job could not be claimed'
      using errcode = 'check_violation';
  end if;

  if p_provider_model is null
     or btrim(p_provider_model) = ''
     or length(btrim(p_provider_model)) > 100 then
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

-- ============================================================================
-- FUNCTION 2 — record_receipt_extraction_operation(uuid, uuid, text)
-- ============================================================================
-- Registers the provider's operation identifier against a claimed attempt. This is the
-- PROCESSING -> PROCESSING transition, and it is permitted EXACTLY ONCE.
--
-- IT RAISES RATHER THAN RETURNING QUIETLY. A worker holding a claim that cannot register
-- must not go on to treat the provider's answer as its own — so unlike the claim, failure
-- here is an exception.
--
-- `provider_operation_id is null` IN THE PREDICATE IS THE ONCE-ONLY RULE. The write-once
-- clause in receipt_extractions_guard_update is the second, independent guarantee, and
-- receipt_extractions_operation_unique_idx is a third across rows.
--
-- NO AUDIT EVENT. The only new fact this records is the provider operation identifier,
-- which is forbidden audit metadata; an event carrying nothing else would be noise.
create function public.record_receipt_extraction_operation(
  p_extraction_id         uuid,
  p_claim_token           uuid,
  p_provider_operation_id text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_extraction_id is null
     or p_claim_token is null
     or p_provider_operation_id is null
     or btrim(p_provider_operation_id) = ''
     or length(btrim(p_provider_operation_id)) > 200 then
    raise exception 'Receipt extraction operation could not be recorded'
      using errcode = 'check_violation';
  end if;

  update public.receipt_extractions
  set
    provider_operation_id = btrim(p_provider_operation_id),
    updated_at            = now()
  where id = p_extraction_id
    and status = 'PROCESSING'
    and worker_claim_token = p_claim_token
    and provider_operation_id is null;

  get diagnostics v_updated = row_count;

  -- Zero rows means one of: no such attempt, not PROCESSING (the reaper may have expired
  -- it), the token does not match, or an operation is already registered. All four are
  -- refused identically and generically — the message names the rule, never the row.
  if v_updated <> 1 then
    raise exception 'Receipt extraction operation could not be recorded'
      using errcode = 'check_violation';
  end if;
end;
$$;

revoke all     on function public.record_receipt_extraction_operation(uuid, uuid, text) from public;
revoke execute on function public.record_receipt_extraction_operation(uuid, uuid, text) from anon;
revoke execute on function public.record_receipt_extraction_operation(uuid, uuid, text) from authenticated;
grant  execute on function public.record_receipt_extraction_operation(uuid, uuid, text) to service_role;

-- ============================================================================
-- FUNCTION 3 — record_receipt_extraction_success(uuid, uuid, text, jsonb, jsonb)
-- ============================================================================
-- Completes a claimed attempt with a normalized result and its informational line items.
--
-- SUCCESS REQUIRES A REGISTERED OPERATION, ON BOTH SIDES. The stored operation id must be
-- non-null, the supplied one must be non-null and nonblank, and the two must be EXACTLY
-- equal after btrim. An earlier draft used `is not distinct from`, which would have
-- accepted NULL = NULL and let a success be recorded for an attempt that never registered
-- anything; that is now impossible, and receipt_extractions_succeeded_shape refuses it a
-- second time at the table level.
--
-- WHY TWO jsonb DOCUMENTS RATHER THAN ~29 POSITIONAL ARGUMENTS. This is a machine-to-machine
-- call whose shape grows in a later milestone, and a 29-argument positional call from
-- TypeScript is a defect waiting to happen. The safety of the loose type is bought back by
-- a CLOSED KEY ALLOWLIST — an unknown key is 23514, not an ignored extra — plus a
-- jsonb_typeof check on every value BEFORE any cast, plus a guarded cast block that turns
-- any residual conversion error into 23514 rather than a raw 22P02. The allowlist is the
-- type check, and it lives in exactly one greppable place.
--
-- NO RAW ANYTHING. There is no key in either allowlist for a provider payload, an HTTP
-- response, a provider error string, or an unstructured receipt-text blob. A document
-- carrying one is refused by the allowlist.
--
-- THE PARENT TRANSITIONS FIRST, THEN THE LINE ITEMS INSERT. In that order because
-- receipt_extraction_line_items_assert_parent requires the parent to already be SUCCEEDED,
-- and both happen in one transaction so a partial result cannot be observed.
create function public.record_receipt_extraction_success(
  p_extraction_id         uuid,
  p_claim_token           uuid,
  p_provider_operation_id text,
  p_normalized            jsonb,
  p_line_items            jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_updated       integer;
  v_retailer      uuid;
  v_attempt       integer;
  v_key           text;
  v_item          jsonb;
  v_index         integer := 0;
  v_line_count    integer;
  v_warnings      text[];
  -- Scalars, extracted after shape validation.
  v_merchant      text;
  v_merchant_src  text;
  v_merchant_conf numeric;
  v_document      text;
  v_document_src  text;
  v_document_conf numeric;
  v_date          date;
  v_date_src      text;
  v_date_conf     numeric;
  v_time          time without time zone;
  v_time_src      text;
  v_time_conf     numeric;
  v_currency      text;
  v_currency_src  text;
  v_currency_conf numeric;
  v_total         bigint;
  v_total_src     text;
  v_total_conf    numeric;
  v_subtotal      bigint;
  v_subtotal_src  text;
  v_subtotal_conf numeric;
  v_tax           bigint;
  v_tax_src       text;
  v_tax_conf      numeric;
  v_fields        text[] := array[]::text[];
begin
  if p_extraction_id is null
     or p_claim_token is null
     or p_provider_operation_id is null
     or btrim(p_provider_operation_id) = '' then
    raise exception 'Receipt extraction result could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- ---- 1. Document shape --------------------------------------------------
  if p_normalized is null or jsonb_typeof(p_normalized) <> 'object' then
    raise exception 'Receipt extraction result could not be recorded'
      using errcode = 'check_violation';
  end if;
  if p_line_items is null or jsonb_typeof(p_line_items) <> 'array' then
    raise exception 'Receipt extraction result could not be recorded'
      using errcode = 'check_violation';
  end if;
  if jsonb_array_length(p_line_items) > 200 then
    raise exception 'Receipt extraction result could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- ---- 2. The closed key allowlist ----------------------------------------
  for v_key in select jsonb_object_keys(p_normalized) loop
    if v_key not in (
      'merchant_name', 'merchant_name_source_text', 'merchant_name_confidence',
      'document_number', 'document_number_source_text', 'document_number_confidence',
      'transaction_date', 'transaction_date_source_text', 'transaction_date_confidence',
      'transaction_time', 'transaction_time_source_text', 'transaction_time_confidence',
      'currency_code', 'currency_code_source_text', 'currency_code_confidence',
      'total_minor', 'total_source_text', 'total_confidence',
      'subtotal_minor', 'subtotal_source_text', 'subtotal_confidence',
      'tax_total_minor', 'tax_source_text', 'tax_confidence',
      'warning_codes'
    ) then
      raise exception 'Receipt extraction result could not be recorded'
        using errcode = 'check_violation';
    end if;
  end loop;

  -- ---- 3. Strict scalar typing, BEFORE any cast ---------------------------
  -- Every string-valued key must be a JSON string or null; every numeric key a JSON number
  -- or null. A value of the wrong JSON type is refused here rather than being coerced.
  foreach v_key in array array[
    'merchant_name', 'merchant_name_source_text',
    'document_number', 'document_number_source_text',
    'transaction_date', 'transaction_date_source_text',
    'transaction_time', 'transaction_time_source_text',
    'currency_code', 'currency_code_source_text',
    'total_source_text', 'subtotal_source_text', 'tax_source_text'
  ] loop
    if p_normalized ? v_key
       and jsonb_typeof(p_normalized -> v_key) not in ('string', 'null') then
      raise exception 'Receipt extraction result could not be recorded'
        using errcode = 'check_violation';
    end if;
  end loop;

  foreach v_key in array array[
    'merchant_name_confidence', 'document_number_confidence',
    'transaction_date_confidence', 'transaction_time_confidence',
    'currency_code_confidence', 'total_confidence', 'subtotal_confidence', 'tax_confidence',
    'total_minor', 'subtotal_minor', 'tax_total_minor'
  ] loop
    if p_normalized ? v_key
       and jsonb_typeof(p_normalized -> v_key) not in ('number', 'null') then
      raise exception 'Receipt extraction result could not be recorded'
        using errcode = 'check_violation';
    end if;
  end loop;

  if p_normalized ? 'warning_codes'
     and jsonb_typeof(p_normalized -> 'warning_codes') not in ('array', 'null') then
    raise exception 'Receipt extraction result could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- ---- 4. Guarded extraction ----------------------------------------------
  -- Any conversion that still fails — an unparseable date, a time with a bad shape, a
  -- numeric out of bigint range — becomes 23514 rather than escaping as 22P02 or 22003.
  begin
    v_merchant      := nullif(btrim(coalesce(p_normalized ->> 'merchant_name', '')), '');
    v_merchant_src  := nullif(btrim(coalesce(p_normalized ->> 'merchant_name_source_text', '')), '');
    v_merchant_conf := (p_normalized ->> 'merchant_name_confidence')::numeric;
    v_document      := nullif(btrim(coalesce(p_normalized ->> 'document_number', '')), '');
    v_document_src  := nullif(btrim(coalesce(p_normalized ->> 'document_number_source_text', '')), '');
    v_document_conf := (p_normalized ->> 'document_number_confidence')::numeric;
    v_date          := (p_normalized ->> 'transaction_date')::date;
    v_date_src      := nullif(btrim(coalesce(p_normalized ->> 'transaction_date_source_text', '')), '');
    v_date_conf     := (p_normalized ->> 'transaction_date_confidence')::numeric;
    -- Forced to MINUTE precision on the way in, so the stored value already satisfies
    -- receipt_extractions_transaction_time_minute and matches the comparison rule the
    -- confirmation uses. Truncated via interval because date_trunc has no `time` overload.
    v_time          := date_trunc(
                         'minute',
                         (p_normalized ->> 'transaction_time')::time without time zone::interval
                       )::time without time zone;
    v_time_src      := nullif(btrim(coalesce(p_normalized ->> 'transaction_time_source_text', '')), '');
    v_time_conf     := (p_normalized ->> 'transaction_time_confidence')::numeric;
    v_currency      := nullif(upper(btrim(coalesce(p_normalized ->> 'currency_code', ''))), '');
    v_currency_src  := nullif(btrim(coalesce(p_normalized ->> 'currency_code_source_text', '')), '');
    v_currency_conf := (p_normalized ->> 'currency_code_confidence')::numeric;
    v_total         := (p_normalized ->> 'total_minor')::bigint;
    v_total_src     := nullif(btrim(coalesce(p_normalized ->> 'total_source_text', '')), '');
    v_total_conf    := (p_normalized ->> 'total_confidence')::numeric;
    v_subtotal      := (p_normalized ->> 'subtotal_minor')::bigint;
    v_subtotal_src  := nullif(btrim(coalesce(p_normalized ->> 'subtotal_source_text', '')), '');
    v_subtotal_conf := (p_normalized ->> 'subtotal_confidence')::numeric;
    v_tax           := (p_normalized ->> 'tax_total_minor')::bigint;
    v_tax_src       := nullif(btrim(coalesce(p_normalized ->> 'tax_source_text', '')), '');
    v_tax_conf      := (p_normalized ->> 'tax_confidence')::numeric;

    if p_normalized ? 'warning_codes'
       and jsonb_typeof(p_normalized -> 'warning_codes') = 'array' then
      select coalesce(array_agg(distinct value order by value), array[]::text[])
        into v_warnings
      from jsonb_array_elements_text(p_normalized -> 'warning_codes') as t(value);
    else
      v_warnings := array[]::text[];
    end if;
  exception when others then
    raise exception 'Receipt extraction result could not be recorded'
      using errcode = 'check_violation';
  end;

  -- ---- 5. The completion ---------------------------------------------------
  -- One UPDATE carrying every precondition. `status = 'PROCESSING'` is present ALONGSIDE
  -- the token, never instead of it: that is what makes a late worker whose claim has been
  -- reaped fail here even with the correct token and operation id.
  update public.receipt_extractions
  set
    status                       = 'SUCCEEDED',
    completed_at                 = now(),
    updated_at                   = now(),
    merchant_name                = v_merchant,
    merchant_name_source_text    = v_merchant_src,
    merchant_name_confidence     = v_merchant_conf,
    document_number              = v_document,
    document_number_source_text  = v_document_src,
    document_number_confidence   = v_document_conf,
    transaction_date             = v_date,
    transaction_date_source_text = v_date_src,
    transaction_date_confidence  = v_date_conf,
    transaction_time             = v_time,
    transaction_time_source_text = v_time_src,
    transaction_time_confidence  = v_time_conf,
    currency_code                = v_currency,
    currency_code_source_text    = v_currency_src,
    currency_code_confidence     = v_currency_conf,
    total_minor                  = v_total,
    total_source_text            = v_total_src,
    total_confidence             = v_total_conf,
    subtotal_minor               = v_subtotal,
    subtotal_source_text         = v_subtotal_src,
    subtotal_confidence          = v_subtotal_conf,
    tax_total_minor              = v_tax,
    tax_source_text              = v_tax_src,
    tax_confidence               = v_tax_conf,
    warning_codes                = v_warnings
  where id = p_extraction_id
    and status = 'PROCESSING'
    and worker_claim_token = p_claim_token
    and provider_operation_id is not null
    and provider_operation_id = btrim(p_provider_operation_id)
  returning retailer_organization_id, attempt_number into v_retailer, v_attempt;

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'Receipt extraction result could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- ---- 6. Line items, after the parent is SUCCEEDED ------------------------
  for v_item in select jsonb_array_elements(p_line_items) loop
    v_index := v_index + 1;

    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Receipt extraction result could not be recorded'
        using errcode = 'check_violation';
    end if;

    for v_key in select jsonb_object_keys(v_item) loop
      if v_key not in (
        'line_number', 'description', 'description_source_text',
        'quantity', 'quantity_source_text',
        'unit_price_minor', 'unit_price_source_text',
        'line_total_minor', 'line_total_source_text',
        'confidence'
      ) then
        raise exception 'Receipt extraction result could not be recorded'
          using errcode = 'check_violation';
      end if;
    end loop;

    begin
      insert into public.receipt_extraction_line_items (
        receipt_extraction_id, line_number,
        description, description_source_text,
        quantity, quantity_source_text,
        unit_price_minor, unit_price_source_text,
        line_total_minor, line_total_source_text,
        confidence
      )
      values (
        p_extraction_id,
        -- The ordinal is SERVER-DERIVED from position, so the sequence is always dense and
        -- starts at 1 regardless of what the caller numbered its array.
        v_index,
        nullif(btrim(coalesce(v_item ->> 'description', '')), ''),
        nullif(btrim(coalesce(v_item ->> 'description_source_text', '')), ''),
        (v_item ->> 'quantity')::numeric,
        nullif(btrim(coalesce(v_item ->> 'quantity_source_text', '')), ''),
        (v_item ->> 'unit_price_minor')::bigint,
        nullif(btrim(coalesce(v_item ->> 'unit_price_source_text', '')), ''),
        (v_item ->> 'line_total_minor')::bigint,
        nullif(btrim(coalesce(v_item ->> 'line_total_source_text', '')), ''),
        (v_item ->> 'confidence')::numeric
      );
    exception when others then
      raise exception 'Receipt extraction result could not be recorded'
        using errcode = 'check_violation';
    end;
  end loop;

  select count(*) into v_line_count
  from public.receipt_extraction_line_items li
  where li.receipt_extraction_id = p_extraction_id;

  -- ---- 7. Audit ------------------------------------------------------------
  -- FIELD NAMES AND COUNTS ONLY. No merchant name, no document number, no amount, no
  -- currency, no receipt text, no object path, no file hash, no provider operation id and
  -- no provider error appears here — an audit row is read by people who are not the
  -- submitter, and none of those values is theirs to see.
  if v_merchant is not null then v_fields := v_fields || 'merchant_name'::text; end if;
  if v_document is not null then v_fields := v_fields || 'document_number'::text; end if;
  if v_date is not null then v_fields := v_fields || 'transaction_date'::text; end if;
  if v_time is not null then v_fields := v_fields || 'transaction_time'::text; end if;
  if v_currency is not null then v_fields := v_fields || 'currency_code'::text; end if;
  if v_total is not null then v_fields := v_fields || 'total_minor'::text; end if;
  if v_subtotal is not null then v_fields := v_fields || 'subtotal_minor'::text; end if;
  if v_tax is not null then v_fields := v_fields || 'tax_total_minor'::text; end if;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_retailer,
    null,
    'RECEIPT_EXTRACTION_SUCCEEDED',
    'RECEIPT_EXTRACTION',
    p_extraction_id::text,
    jsonb_build_object(
      'actor_kind', 'SYSTEM_WORKER',
      'attempt_number', v_attempt,
      'fields_extracted', to_jsonb(v_fields),
      'line_item_count', v_line_count,
      'warning_codes', to_jsonb(v_warnings)
    )
  );
end;
$$;

revoke all     on function public.record_receipt_extraction_success(uuid, uuid, text, jsonb, jsonb) from public;
revoke execute on function public.record_receipt_extraction_success(uuid, uuid, text, jsonb, jsonb) from anon;
revoke execute on function public.record_receipt_extraction_success(uuid, uuid, text, jsonb, jsonb) from authenticated;
grant  execute on function public.record_receipt_extraction_success(uuid, uuid, text, jsonb, jsonb) to service_role;

-- ============================================================================
-- FUNCTION 4 — record_receipt_extraction_failure(uuid, uuid, text, text)
-- ============================================================================
-- Completes a claimed attempt with a failure. TWO PATHS, selected by the failure code, and
-- each one pins the state the row must actually be in:
--
--   A. PRE-PROVIDER  — OBJECT_UNREADABLE only. The stored operation id must be NULL and the
--                      supplied one must be NULL. The image never reached a provider.
--   B. POST-PROVIDER — the seven provider-reported codes. The stored operation id must be
--                      non-null, the supplied one non-null, and the two exactly equal.
--
-- The pairing is what makes the recorded reason and the row's actual provider progress
-- structurally consistent: OBJECT_UNREADABLE cannot be recorded for an attempt that reached
-- the provider, and a provider error cannot be recorded for one that never got there.
--
-- WORKER_ABANDONED AND NEVER_CLAIMED ARE REFUSED HERE. They belong to
-- expire_stale_receipt_extraction_claims alone, so a reaped row can always be trusted to
-- mean the deadline genuinely passed rather than that a worker said so.
--
-- IT ACCEPTS NO PROVIDER ERROR TEXT. There is no parameter through which a provider message,
-- status line or request id could be stored — the classification is a closed vocabulary.
create function public.record_receipt_extraction_failure(
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
  v_updated   integer;
  v_retailer  uuid;
  v_attempt   integer;
  v_used      integer;
  v_submission uuid;
  v_pre_provider boolean;
begin
  if p_extraction_id is null or p_claim_token is null or p_failure_code is null then
    raise exception 'Receipt extraction failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- Reaper-only codes are refused before anything else is considered.
  if p_failure_code in ('WORKER_ABANDONED', 'NEVER_CLAIMED') then
    raise exception 'Receipt extraction failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  if p_failure_code = 'OBJECT_UNREADABLE' then
    v_pre_provider := true;
  elsif p_failure_code in (
    'PROVIDER_UNAVAILABLE', 'PROVIDER_QUOTA_EXCEEDED', 'PROVIDER_TIMEOUT',
    'PROVIDER_REJECTED_DOCUMENT', 'UNSUPPORTED_IMAGE', 'NORMALIZATION_FAILED', 'INTERNAL'
  ) then
    v_pre_provider := false;
  else
    raise exception 'Receipt extraction failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  if v_pre_provider then
    -- PATH A. No operation exists, and none may be supplied.
    if p_provider_operation_id is not null then
      raise exception 'Receipt extraction failure could not be recorded'
        using errcode = 'check_violation';
    end if;

    update public.receipt_extractions
    set status = 'FAILED', failure_code = p_failure_code,
        completed_at = now(), updated_at = now()
    where id = p_extraction_id
      and status = 'PROCESSING'
      and worker_claim_token = p_claim_token
      and provider_operation_id is null
    returning retailer_organization_id, attempt_number, receipt_submission_id
         into v_retailer, v_attempt, v_submission;
  else
    -- PATH B. An operation exists and must be proven.
    if p_provider_operation_id is null or btrim(p_provider_operation_id) = '' then
      raise exception 'Receipt extraction failure could not be recorded'
        using errcode = 'check_violation';
    end if;

    update public.receipt_extractions
    set status = 'FAILED', failure_code = p_failure_code,
        completed_at = now(), updated_at = now()
    where id = p_extraction_id
      and status = 'PROCESSING'
      and worker_claim_token = p_claim_token
      and provider_operation_id is not null
      and provider_operation_id = btrim(p_provider_operation_id)
    returning retailer_organization_id, attempt_number, receipt_submission_id
         into v_retailer, v_attempt, v_submission;
  end if;

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'Receipt extraction failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  select count(*) into v_used
  from public.receipt_extractions x
  where x.receipt_submission_id = v_submission;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
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

revoke all     on function public.record_receipt_extraction_failure(uuid, uuid, text, text) from public;
revoke execute on function public.record_receipt_extraction_failure(uuid, uuid, text, text) from anon;
revoke execute on function public.record_receipt_extraction_failure(uuid, uuid, text, text) from authenticated;
grant  execute on function public.record_receipt_extraction_failure(uuid, uuid, text, text) to service_role;

-- ============================================================================
-- FUNCTION 5 — expire_stale_receipt_extraction_claims(uuid default null)
-- ============================================================================
-- The reaper, and the ONLY writer of WORKER_ABANDONED and NEVER_CLAIMED.
--
-- WHY IT EXISTS. Both open states can strand. A crash between the request RPC and the claim
-- leaves a QUEUED row; a crash between the claim and the completion leaves a PROCESSING row.
-- Either holds receipt_extractions_active_attempt_unique_idx and would otherwise block that
-- receipt forever. The receipt is never lost — manual confirmation stays open — but the row
-- would be unrecoverable, so a bounded deadline plus this function is the recovery path.
--
-- TWO SCOPES, ONE DEFINITION OF "EXPIRED":
--   p_extraction_id NOT NULL — that row only. This is the HOT PATH, called by the Edge
--                              Functions with an id obtained from a caller-authorized read.
--   p_extraction_id NULL     — every expired row. Reserved for an explicit operator call
--                              and for a future scheduled worker. NO EDGE FUNCTION MAY PASS
--                              NULL: a user-triggered global sweep is an unbounded write on
--                              a request path.
--
-- IT DOES NOT UN-CONSUME AN ATTEMPT. The row already carries its attempt_number and every
-- persisted row counts, so a reaped attempt is a spent attempt. That is a real cost when the
-- fault was ours; manual confirmation is the safety valve, and Milestone B must revisit the
-- accounting before real provider charges make the trade different.
--
-- IDEMPOTENT. A second call expires nothing and returns 0, which is a normal result.
create function public.expire_stale_receipt_extraction_claims(
  p_extraction_id uuid default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_expired integer := 0;
  v_row     record;
begin
  for v_row in
    update public.receipt_extractions
    set
      status = 'FAILED',
      failure_code = case when status = 'PROCESSING' then 'WORKER_ABANDONED'
                          else 'NEVER_CLAIMED' end,
      completed_at = now(),
      updated_at = now()
    where status in ('QUEUED', 'PROCESSING')
      and expires_at < now()
      and (p_extraction_id is null or id = p_extraction_id)
    returning id, retailer_organization_id, attempt_number, failure_code,
              receipt_submission_id
  loop
    v_expired := v_expired + 1;

    insert into public.audit_logs (
      organization_id, actor_profile_id, action, entity_type, entity_id, metadata
    )
    values (
      v_row.retailer_organization_id,
      null,
      -- The same action as any other failure, because it IS one. A separate action would
      -- imply a separate operational response that does not exist.
      'RECEIPT_EXTRACTION_FAILED',
      'RECEIPT_EXTRACTION',
      v_row.id::text,
      jsonb_build_object(
        'actor_kind', 'SYSTEM_WORKER',
        'attempt_number', v_row.attempt_number,
        'failure_code', v_row.failure_code,
        'attempts_remaining', greatest(0, 3 - (
          select count(*) from public.receipt_extractions x
          where x.receipt_submission_id = v_row.receipt_submission_id
        ))
      )
    );
  end loop;

  return v_expired;
end;
$$;

revoke all     on function public.expire_stale_receipt_extraction_claims(uuid) from public;
revoke execute on function public.expire_stale_receipt_extraction_claims(uuid) from anon;
revoke execute on function public.expire_stale_receipt_extraction_claims(uuid) from authenticated;
grant  execute on function public.expire_stale_receipt_extraction_claims(uuid) to service_role;

-- ============================================================================
-- FUNCTION 6 — get_receipt_object_reference(uuid)
-- ============================================================================
-- The storage coordinates of one SUBMITTED receipt, for the image-preview function to mint a
-- short-lived signed URL from.
--
-- IT PERFORMS NO AUTHORIZATION AND IS NOT MEANT TO. Ownership is proved beforehand by
-- assert_my_receipt_extraction_access, running UNDER THE CALLER'S OWN TOKEN, and this
-- function is unreachable by any browser role. Splitting the two is what keeps the bucket
-- and path out of every authenticated return type: no function granted to `authenticated`
-- in this milestone has a storage column in its signature at all.
create function public.get_receipt_object_reference(
  p_submission_id uuid
)
returns table (
  storage_bucket      text,
  storage_object_path text,
  mime_type           text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_submission_id is null then
    return;
  end if;

  return query
  select s.storage_bucket, s.storage_object_path, s.mime_type
  from public.receipt_submissions s
  where s.id = p_submission_id
    and s.status = 'SUBMITTED';
end;
$$;

revoke all     on function public.get_receipt_object_reference(uuid) from public;
revoke execute on function public.get_receipt_object_reference(uuid) from anon;
revoke execute on function public.get_receipt_object_reference(uuid) from authenticated;
grant  execute on function public.get_receipt_object_reference(uuid) to service_role;

-- ============================================================================
-- FUNCTION 7 — get_receipt_extraction_worker_state(uuid)
-- ============================================================================
-- The worker-side view of one attempt: its claim token, its registered operation, and its
-- deadline.
--
-- WHY IT IS NEEDED. A poll happens in a DIFFERENT invocation from the claim, and completing
-- the attempt requires both the claim token and the operation id. The client projection
-- deliberately withholds both. Without this function either the token would have to leak
-- into a client response — unacceptable — or a PROCESSING attempt could never be completed
-- by a later poll, which would break the asynchronous shape the whole design exists to
-- preserve.
--
-- service_role ONLY. Nothing it returns may ever reach a browser.
create function public.get_receipt_extraction_worker_state(
  p_extraction_id uuid
)
returns table (
  status                text,
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

-- ============================================================================
-- Closing note
-- ============================================================================
-- Seven functions added; nothing else exists in this migration. No table, column,
-- constraint, index, trigger, policy, role, permission or mapping is created, altered or
-- dropped, no existing function is touched, and no table privilege is granted to any role.
-- Not one of these seven is executable by anon or by authenticated.
