-- Migration: receipt_extraction_client_operations
-- Purpose: The SIX authenticated operations over the extraction foundation. Adds exactly
--          six functions and nothing else:
--            1. assert_my_receipt_extraction_access(uuid)      -> boolean
--            2. request_receipt_extraction(uuid)
--            3. get_my_receipt_extraction(uuid)
--            4. list_my_receipt_extraction_line_items(uuid)
--            5. confirm_receipt_extraction(uuid, date, text, bigint, text, text, time, bigint, bigint)
--            6. get_my_receipt_confirmation(uuid)
--
--          With migration 20260813090000's seven worker functions, thirteen RPCs in total.
--
-- ONE AUTHORIZATION PREDICATE, USED BY ALL SIX. assert_my_receipt_extraction_access is the
--   single definition of "may this caller act on this receipt", and the other five open by
--   calling it. Five separate copies of the same conjunction would be five things free to
--   drift. Each function ALSO restates the ownership and tenant predicate in its own WHERE
--   clause, because they answer different questions — "may you?" and "is this yours?" — and
--   this schema already applies both in list_my_receipt_submissions for the same reason.
--
-- WHAT THE CALLER MAY INFLUENCE, EXHAUSTIVELY. One submission id, and — on confirmation
--   alone — the eight confirmed values. There is NO parameter anywhere in this file for an
--   organization id, a profile id, a membership id, a shop id, a role id, an extraction id,
--   a claim token, a provider, a storage bucket, an object path, a file hash, an entry mode,
--   a changed-fields list, a duplicate signal, a runtime mode, or a provider fixture.
--
-- ATTEMPT COUNTERS ARE FACTS, NEVER SIGNALS. attempts_used is count(*) over the persisted
--   attempts and attempts_remaining is greatest(0, 3 - attempts_used), on EVERY outcome
--   including EXTRACTION_UNAVAILABLE. Neither is ever adjusted to communicate that the
--   provider is unavailable; retry_allowed is the only field that carries availability.
--   Reporting "0 remaining" for a receipt that has consumed nothing would tell a staff
--   member their capacity was spent and would be permanently wrong the moment the gate
--   re-opened.
--
-- Idempotency posture: plain CREATE FUNCTION. No fixed UUIDs, no dynamic SQL, empty
--   search_path, every reference schema-qualified.
--
-- Dependencies: 20260723090000 (resolve_retailer_member_organization), 20260726090000
--   (receipt_submissions), 20260812090000 (iso_currency_codes), 20260812210000 (the
--   extraction foundation), 20260716130351 (audit_logs).

-- ============================================================================
-- FUNCTION 1 — assert_my_receipt_extraction_access(uuid) -> boolean
-- ============================================================================
-- THE shared read-only authorization predicate for requesting extraction, reading extraction
-- state, reading line items, previewing the receipt image, and confirming the receipt.
--
-- TWO DIFFERENT REFUSALS, AND THE DIFFERENCE IS THE SECURITY PROPERTY:
--   42501 — the caller is not an authorized Sales Staff member AT ALL. Unauthenticated, no
--           permission, inactive profile, inactive membership, inactive role, inactive
--           Retailer, or resolving to more than one Retailer all land here, via the shared
--           resolver's own conditions rather than a restatement of them.
--   false — the caller IS authorized, and has named a receipt they may not read. Unknown id,
--           another Sales Staff member's receipt, another Retailer's receipt, a RESERVED
--           receipt, an UPLOAD_FAILED receipt and a null id are BYTE-IDENTICAL to one
--           another. A distinguishable refusal would confirm that some other person's
--           submission exists, and a submission id is a uuid another client legitimately
--           holds.
--
-- IT RETURNS A BOOLEAN AND NOTHING ELSE. No organization id, profile id, shop id, extraction
-- id, storage bucket, object path, file hash or provider field can leave this function,
-- because its return type has no room for one. That is a structural guarantee rather than a
-- reviewed omission, and it is why the image-preview path can call this under the caller's
-- own token and still keep storage coordinates entirely inside service_role.
--
-- Never returns NULL: a null id is `false`, not "unknown".
create function public.assert_my_receipt_extraction_access(
  p_submission_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
  v_exists   boolean;
begin
  v_retailer := public.resolve_retailer_member_organization('RECEIPT_EXTRACTION_REVIEW');

  if v_retailer is null then
    raise exception 'Not authorized to review receipt extraction'
      using errcode = 'insufficient_privilege';
  end if;

  if p_submission_id is null then
    return false;
  end if;

  select true into v_exists
  from public.receipt_submissions s
  where s.id = p_submission_id
    and s.submitted_by_profile_id = auth.uid()
    and s.retailer_organization_id = v_retailer
    and s.status = 'SUBMITTED';

  return coalesce(v_exists, false);
end;
$$;

revoke all     on function public.assert_my_receipt_extraction_access(uuid) from public;
revoke execute on function public.assert_my_receipt_extraction_access(uuid) from anon;
grant  execute on function public.assert_my_receipt_extraction_access(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 2 — request_receipt_extraction(uuid)
-- ============================================================================
-- Creates, or reports, the applicable extraction attempt.
--
-- BRANCH ORDER IS LOAD-BEARING. The runtime-mode gate sits IMMEDIATELY ABOVE THE INSERT and
-- nowhere earlier, because its only job is to prevent CREATION of a provider job:
--
--   1. authorization            -> 42501 / zero rows
--   2. an existing confirmation -> ALREADY_CONFIRMED
--   3. an active attempt        -> ACTIVE          (returns the extraction id)
--   4. a succeeded attempt      -> SUCCEEDED       (provider is NOT charged again)
--   5. three attempts used      -> EXHAUSTED
--   6. runtime mode DISABLED    -> EXTRACTION_UNAVAILABLE, nothing written
--   7. insert                   -> QUEUED
--
-- Steps 2-5 report EXISTING STATE and create nothing, so answering them while the gate is
-- shut leaks no configuration — each of those outcomes is identical whether extraction is
-- enabled or not. Putting the gate above them, as an earlier draft did, meant that disabling
-- the mode while an attempt was open returned EXTRACTION_UNAVAILABLE WITHOUT the extraction
-- id, leaving the caller unable to scope the reaper and the row stranded against
-- receipt_extractions_active_attempt_unique_idx forever.
--
-- DISABLED CONSUMES NO ATTEMPT. No row is inserted, attempts_used is untouched, and the
-- counters reported are the true ones.
--
-- THE PROVIDER IS NEVER CHARGED TWICE. A repeat request during an active attempt returns
-- that attempt; a repeat after success returns the success. Neither creates a row.
create function public.request_receipt_extraction(
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

  if coalesce(v_mode, 'DISABLED') <> 'FAKE' then
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

-- ============================================================================
-- FUNCTION 3 — get_my_receipt_extraction(uuid)
-- ============================================================================
-- THE SAFE CLIENT PROJECTION of the latest attempt.
--
-- NOT RETURNED, and the reason each is withheld:
--   provider, provider_model         operational metadata with no client meaning.
--   provider_operation_id            correlates to an external system; useless and unsafe.
--   worker_claim_token               a capability. Holding it would let a caller complete
--                                    somebody's job if it ever reached a worker RPC.
--   expires_at                       an internal scheduling detail.
--   storage_bucket, object_path      a private object location is not display data.
--   file_sha256                      would let a holder test whether a file they have
--                                    matches a receipt.
--   the INTERNAL failure code        mapped to a three-value client vocabulary below.
--   retailer_organization_id,
--   requested_by_profile_id          internal identifiers with no use on the page.
--
-- THE FAILURE VOCABULARY SHRINKS FROM TEN TO THREE. Two stored codes describe THE CALLER'S
-- OWN FILE and are actionable: retake the photo. The other eight describe our
-- infrastructure, where the action is identical in every case (retry, or type it in) — so a
-- finer distinction buys the caller nothing while telling them whether our provider is
-- healthy, whether a billing quota is exhausted and whether a storage read failed. That is
-- an availability oracle on an endpoint every Sales Staff member can call.
--
-- retry_allowed IS THE ONLY FIELD CARRYING AVAILABILITY, and it is true only when ALL of:
-- a latest attempt exists; it is FAILED; capacity remains; no attempt is QUEUED or
-- PROCESSING; no attempt SUCCEEDED; no confirmation exists; and the runtime mode is FAKE.
-- The three "no active / no succeeded" conjuncts are implied by "latest is FAILED" given the
-- partial unique indexes, and are written out anyway: they cost an index probe each and keep
-- the rule correct if "latest" is ever redefined.
create function public.get_my_receipt_extraction(
  p_submission_id uuid
)
returns table (
  submission_id                uuid,
  extraction_id                uuid,
  status                       text,
  attempt_number               integer,
  attempts_used                integer,
  attempts_remaining           integer,
  retry_allowed                boolean,
  manual_confirmation_allowed  boolean,
  confirmation_exists          boolean,
  failure_code                 text,
  requested_at                 timestamptz,
  completed_at                 timestamptz,
  merchant_name                text,
  merchant_name_source_text    text,
  merchant_name_confidence     numeric,
  document_number              text,
  document_number_source_text  text,
  document_number_confidence   numeric,
  transaction_date             date,
  transaction_date_source_text text,
  transaction_date_confidence  numeric,
  transaction_time             time without time zone,
  transaction_time_source_text text,
  transaction_time_confidence  numeric,
  currency_code                text,
  currency_code_source_text    text,
  currency_code_confidence     numeric,
  currency_minor_unit          smallint,
  total_minor                  bigint,
  total_source_text            text,
  total_confidence             numeric,
  subtotal_minor               bigint,
  subtotal_source_text         text,
  subtotal_confidence          numeric,
  tax_total_minor              bigint,
  tax_source_text              text,
  tax_confidence               numeric,
  warning_codes                text[],
  line_item_count              integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row           public.receipt_extractions%rowtype;
  v_used          integer;
  v_remaining     integer;
  v_confirmed     boolean;
  v_has_active    boolean;
  v_has_succeeded boolean;
  v_mode          text;
  v_retry         boolean;
  v_manual        boolean;
  v_client_code   text;
  v_minor_unit    smallint;
  v_lines         integer;
begin
  if not public.assert_my_receipt_extraction_access(p_submission_id) then
    return;
  end if;

  select * into v_row
  from public.receipt_extractions x
  where x.receipt_submission_id = p_submission_id
  order by x.attempt_number desc
  limit 1;

  if v_row.id is null then
    return;  -- no attempt yet; indistinguishable from an unreadable receipt, and harmless
  end if;

  select count(*) into v_used
  from public.receipt_extractions x
  where x.receipt_submission_id = p_submission_id;
  v_remaining := greatest(0, 3 - v_used);

  v_confirmed := exists (
    select 1 from public.receipt_confirmations c
    where c.receipt_submission_id = p_submission_id
  );
  v_has_active := exists (
    select 1 from public.receipt_extractions x
    where x.receipt_submission_id = p_submission_id
      and x.status in ('QUEUED', 'PROCESSING')
  );
  v_has_succeeded := exists (
    select 1 from public.receipt_extractions x
    where x.receipt_submission_id = p_submission_id
      and x.status = 'SUCCEEDED'
  );

  select r.mode into v_mode from public.receipt_extraction_runtime r where r.id;

  v_retry :=
        v_row.status = 'FAILED'
    and v_remaining > 0
    and not v_has_active
    and not v_has_succeeded
    and not v_confirmed
    and coalesce(v_mode, 'DISABLED') = 'FAKE';

  -- Manual confirmation is blocked by exactly two things, and NEITHER is a mode gate: an
  -- existing confirmation, and an attempt still in flight (confirming mid-flight would race
  -- the success write and derive the wrong entry mode).
  v_manual := not v_confirmed and not v_has_active;

  -- The ten stored codes collapse to three. Written as searched CASE rather than simple
  -- CASE because `case x when null` never matches — NULL = NULL is unknown, not true — and
  -- "no failure" must map to no code rather than falling into the generic bucket.
  v_client_code := case
    when v_row.failure_code is null then null
    when v_row.failure_code = 'PROVIDER_REJECTED_DOCUMENT' then 'IMAGE_NOT_A_RECEIPT'
    when v_row.failure_code = 'UNSUPPORTED_IMAGE' then 'IMAGE_UNUSABLE'
    else 'EXTRACTION_UNAVAILABLE'
  end;

  select c.minor_unit into v_minor_unit
  from public.iso_currency_codes c
  where c.code = v_row.currency_code;

  select count(*) into v_lines
  from public.receipt_extraction_line_items li
  where li.receipt_extraction_id = v_row.id;

  return query select
    p_submission_id,
    v_row.id,
    v_row.status,
    v_row.attempt_number,
    v_used,
    v_remaining,
    v_retry,
    v_manual,
    v_confirmed,
    v_client_code,
    v_row.requested_at,
    v_row.completed_at,
    v_row.merchant_name,
    v_row.merchant_name_source_text,
    v_row.merchant_name_confidence,
    v_row.document_number,
    v_row.document_number_source_text,
    v_row.document_number_confidence,
    v_row.transaction_date,
    v_row.transaction_date_source_text,
    v_row.transaction_date_confidence,
    v_row.transaction_time,
    v_row.transaction_time_source_text,
    v_row.transaction_time_confidence,
    v_row.currency_code,
    v_row.currency_code_source_text,
    v_row.currency_code_confidence,
    v_minor_unit,
    v_row.total_minor,
    v_row.total_source_text,
    v_row.total_confidence,
    v_row.subtotal_minor,
    v_row.subtotal_source_text,
    v_row.subtotal_confidence,
    v_row.tax_total_minor,
    v_row.tax_source_text,
    v_row.tax_confidence,
    v_row.warning_codes,
    v_lines;
end;
$$;

revoke all     on function public.get_my_receipt_extraction(uuid) from public;
revoke execute on function public.get_my_receipt_extraction(uuid) from anon;
grant  execute on function public.get_my_receipt_extraction(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 4 — list_my_receipt_extraction_line_items(uuid)
-- ============================================================================
-- The informational line items of the SUCCEEDED attempt for one of the caller's receipts.
--
-- IT TAKES THE SUBMISSION ID, NOT AN EXTRACTION ID. The client never needs to hold an
-- extraction id to read its own receipt, and an endpoint keyed on a submission is one fewer
-- identifier to authorize.
--
-- ZERO ROWS covers "not your receipt" and "no successful extraction" alike, and the collapse
-- is correct: in both cases there is nothing to show.
create function public.list_my_receipt_extraction_line_items(
  p_submission_id uuid
)
returns table (
  line_number             integer,
  description             text,
  description_source_text text,
  quantity                numeric,
  quantity_source_text    text,
  unit_price_minor        bigint,
  unit_price_source_text  text,
  line_total_minor        bigint,
  line_total_source_text  text,
  confidence              numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.assert_my_receipt_extraction_access(p_submission_id) then
    return;
  end if;

  return query
  select
    li.line_number, li.description, li.description_source_text,
    li.quantity, li.quantity_source_text,
    li.unit_price_minor, li.unit_price_source_text,
    li.line_total_minor, li.line_total_source_text,
    li.confidence
  from public.receipt_extraction_line_items li
  join public.receipt_extractions x on x.id = li.receipt_extraction_id
  where x.receipt_submission_id = p_submission_id
    and x.status = 'SUCCEEDED'
  order by li.line_number;
end;
$$;

revoke all     on function public.list_my_receipt_extraction_line_items(uuid) from public;
revoke execute on function public.list_my_receipt_extraction_line_items(uuid) from anon;
grant  execute on function public.list_my_receipt_extraction_line_items(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 5 — confirm_receipt_extraction(...)
-- ============================================================================
-- Records the one immutable confirmation for a receipt.
--
-- NINE PARAMETERS: the submission, three required values, five optional values. There is no
-- parameter for an organization id, a shop id, a profile id, a membership id, an extraction
-- id, an entry mode, a changed-fields list or a duplicate signal. Every one of those is
-- derived here.
--
-- ONE RULE BLOCKS CONFIRMATION, not five. An attempt that is QUEUED or PROCESSING yields
-- EXTRACTION_IN_PROGRESS, because confirming mid-flight would race the success write and
-- derive the wrong entry mode. Everything else confirms: a success, a failure, exhausted
-- attempts, a disabled gate, and no extraction at all.
--
-- ENTRY MODE AND CHANGED FIELDS ARE DERIVED BY COMPARISON, and the comparison rules are
-- chosen so that changed_fields means "a human corrected this" rather than "the strings
-- differ":
--   merchant_name    whitespace-collapsed and compared CASE-INSENSITIVELY. OCR casing is a
--                    provider artefact; counting it would make nearly every confirmation
--                    MIXED and render the signal useless. NULL and blank are the same value.
--   document_number  compared with all non-alphanumerics removed and upper-cased, so
--                    INV-2026/004512 and inv2026004512 are the same number.
--   transaction_time compared at MINUTE precision, so a provider emitting :00 seconds does
--                    not read as a correction.
--   amounts          exact integer equality, and NULL IS NOT ZERO — a zero tax is a fact,
--                    an unknown tax is not.
--
-- A DUPLICATE CALL RETURNS THE EXISTING CONFIRMATION AND COMPARES NOTHING. Returning "ok"
-- when the resubmitted values differ from the stored ones would be a lie, and replacing them
-- is forbidden, so the honest answer is to report that one already exists.
create function public.confirm_receipt_extraction(
  p_submission_id    uuid,
  p_transaction_date date,
  p_currency_code    text,
  p_total_minor      bigint,
  p_merchant_name    text                   default null,
  p_document_number  text                   default null,
  p_transaction_time time without time zone default null,
  p_subtotal_minor   bigint                 default null,
  p_tax_total_minor  bigint                 default null
)
returns table (
  outcome         text,
  confirmation_id uuid,
  entry_mode      text,
  changed_fields  text[]
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_retailer     uuid;
  v_uid          uuid;
  v_submission   public.receipt_submissions%rowtype;
  v_existing     public.receipt_confirmations%rowtype;
  v_extraction   public.receipt_extractions%rowtype;
  v_merchant     text;
  v_document     text;
  v_time         time without time zone;
  v_currency     text;
  v_changed      text[] := array[]::text[];
  v_mode         text;
  v_source       uuid;
  v_new_id       uuid;
begin
  if not public.assert_my_receipt_extraction_access(p_submission_id) then
    return;
  end if;

  v_uid := auth.uid();
  v_retailer := public.resolve_retailer_member_organization('RECEIPT_EXTRACTION_REVIEW');

  select * into v_submission
  from public.receipt_submissions s
  where s.id = p_submission_id;

  -- ---- 1. Already confirmed --------------------------------------------------
  select * into v_existing
  from public.receipt_confirmations c
  where c.receipt_submission_id = p_submission_id;

  if v_existing.id is not null then
    return query select 'ALREADY_CONFIRMED'::text, v_existing.id,
                        v_existing.entry_mode, v_existing.changed_fields;
    return;
  end if;

  -- ---- 2. An attempt still in flight blocks -----------------------------------
  if exists (
    select 1 from public.receipt_extractions x
    where x.receipt_submission_id = p_submission_id
      and x.status in ('QUEUED', 'PROCESSING')
  ) then
    return query select 'EXTRACTION_IN_PROGRESS'::text, null::uuid, null::text, null::text[];
    return;
  end if;

  -- ---- 3. Normalize and validate the supplied values --------------------------
  v_merchant := nullif(btrim(regexp_replace(coalesce(p_merchant_name, ''), '\s+', ' ', 'g')), '');
  v_document := nullif(btrim(coalesce(p_document_number, '')), '');
  v_currency := nullif(upper(btrim(coalesce(p_currency_code, ''))), '');
  v_time := case
    when p_transaction_time is null then null
    else date_trunc('minute', p_transaction_time::interval)::time without time zone
  end;

  if p_transaction_date is null
     or v_currency is null
     or p_total_minor is null then
    raise exception 'Receipt confirmation requires a date, a currency and a total'
      using errcode = 'check_violation';
  end if;
  if p_transaction_date < date '2000-01-01' then
    raise exception 'That receipt date could not be accepted'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.iso_currency_codes c where c.code = v_currency) then
    raise exception 'That currency could not be accepted'
      using errcode = 'check_violation';
  end if;
  if p_total_minor < 0 or p_total_minor > 1000000000000 then
    raise exception 'That receipt total could not be accepted'
      using errcode = 'check_violation';
  end if;
  if p_subtotal_minor is not null
     and (p_subtotal_minor < 0 or p_subtotal_minor > 1000000000000) then
    raise exception 'That receipt subtotal could not be accepted'
      using errcode = 'check_violation';
  end if;
  if p_tax_total_minor is not null
     and (p_tax_total_minor < 0 or p_tax_total_minor > 1000000000000) then
    raise exception 'That receipt tax could not be accepted'
      using errcode = 'check_violation';
  end if;
  if v_merchant is not null and length(v_merchant) > 255 then
    raise exception 'That merchant name could not be accepted'
      using errcode = 'check_violation';
  end if;
  if v_document is not null and length(v_document) > 100 then
    raise exception 'That document number could not be accepted'
      using errcode = 'check_violation';
  end if;

  -- NOTE: subtotal + tax is NOT compared to the total, and neither is derived from the
  -- others. Real receipts round independently; enforcing the identity would reject valid
  -- receipts.

  -- ---- 4. Derive the evidence, the entry mode and the changed fields ----------
  select * into v_extraction
  from public.receipt_extractions x
  where x.receipt_submission_id = p_submission_id
    and x.status = 'SUCCEEDED'
  order by x.attempt_number desc
  limit 1;

  if v_extraction.id is null then
    v_mode := 'MANUAL';
    v_source := null;
  else
    v_source := v_extraction.id;

    if upper(coalesce(v_merchant, '')) is distinct from
       upper(coalesce(nullif(btrim(regexp_replace(coalesce(v_extraction.merchant_name, ''), '\s+', ' ', 'g')), ''), '')) then
      v_changed := v_changed || 'merchant_name'::text;
    end if;

    if upper(regexp_replace(coalesce(v_document, ''), '[^0-9A-Za-z]', '', 'g')) is distinct from
       upper(regexp_replace(coalesce(v_extraction.document_number, ''), '[^0-9A-Za-z]', '', 'g')) then
      v_changed := v_changed || 'document_number'::text;
    end if;

    if p_transaction_date is distinct from v_extraction.transaction_date then
      v_changed := v_changed || 'transaction_date'::text;
    end if;

    if v_time is distinct from v_extraction.transaction_time then
      v_changed := v_changed || 'transaction_time'::text;
    end if;

    if v_currency is distinct from v_extraction.currency_code then
      v_changed := v_changed || 'currency_code'::text;
    end if;

    -- NULL and 0 are DIFFERENT here, which `is distinct from` gives us exactly.
    if p_total_minor is distinct from v_extraction.total_minor then
      v_changed := v_changed || 'total_minor'::text;
    end if;
    if p_subtotal_minor is distinct from v_extraction.subtotal_minor then
      v_changed := v_changed || 'subtotal_minor'::text;
    end if;
    if p_tax_total_minor is distinct from v_extraction.tax_total_minor then
      v_changed := v_changed || 'tax_total_minor'::text;
    end if;

    v_mode := case when cardinality(v_changed) = 0 then 'EXTRACTED' else 'MIXED' end;
  end if;

  -- Sorted so two identical confirmations produce byte-identical arrays.
  select coalesce(array_agg(f order by f), array[]::text[]) into v_changed
  from unnest(v_changed) as t(f);

  -- ---- 5. Insert -------------------------------------------------------------
  begin
    insert into public.receipt_confirmations (
      receipt_submission_id, retailer_organization_id, retailer_shop_id,
      confirmed_by_profile_id, source_extraction_id,
      entry_mode, changed_fields,
      transaction_date, transaction_time, currency_code,
      total_minor, subtotal_minor, tax_total_minor,
      merchant_name, document_number
    )
    values (
      p_submission_id, v_submission.retailer_organization_id, v_submission.retailer_shop_id,
      v_uid, v_source,
      v_mode, v_changed,
      p_transaction_date, v_time, v_currency,
      p_total_minor, p_subtotal_minor, p_tax_total_minor,
      v_merchant, v_document
    )
    returning id into v_new_id;
  exception when unique_violation then
    -- receipt_confirmations_submission_unique is the concurrency authority. The loser
    -- re-reads and reports the winner rather than raising a raw 23505.
    select * into v_existing
    from public.receipt_confirmations c
    where c.receipt_submission_id = p_submission_id;

    if v_existing.id is not null then
      return query select 'ALREADY_CONFIRMED'::text, v_existing.id,
                          v_existing.entry_mode, v_existing.changed_fields;
      return;
    end if;
    raise;
  end;

  -- FIELD NAMES ONLY. No merchant, no document number, no amount, no currency.
  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_retailer, v_uid, 'RECEIPT_CONFIRMED', 'RECEIPT_CONFIRMATION', v_new_id::text,
    jsonb_build_object(
      'entry_mode', v_mode,
      'changed_fields', to_jsonb(v_changed),
      'had_extraction', v_source is not null,
      'attempt_number', v_extraction.attempt_number
    )
  );

  return query select 'CONFIRMED'::text, v_new_id, v_mode, v_changed;
end;
$$;

revoke all     on function public.confirm_receipt_extraction(uuid, date, text, bigint, text, text, time without time zone, bigint, bigint) from public;
revoke execute on function public.confirm_receipt_extraction(uuid, date, text, bigint, text, text, time without time zone, bigint, bigint) from anon;
grant  execute on function public.confirm_receipt_extraction(uuid, date, text, bigint, text, text, time without time zone, bigint, bigint) to authenticated;

-- ============================================================================
-- FUNCTION 6 — get_my_receipt_confirmation(uuid)
-- ============================================================================
-- The caller's own confirmation for one of their receipts. Readable regardless of any mode
-- gate: a confirmation is stored evidence, and disabling extraction must never hide it.
create function public.get_my_receipt_confirmation(
  p_submission_id uuid
)
returns table (
  confirmation_id      uuid,
  entry_mode           text,
  changed_fields       text[],
  source_extraction_id uuid,
  transaction_date     date,
  transaction_time     time without time zone,
  currency_code        text,
  currency_minor_unit  smallint,
  total_minor          bigint,
  subtotal_minor       bigint,
  tax_total_minor      bigint,
  merchant_name        text,
  document_number      text,
  confirmed_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.assert_my_receipt_extraction_access(p_submission_id) then
    return;
  end if;

  return query
  select
    c.id, c.entry_mode, c.changed_fields, c.source_extraction_id,
    c.transaction_date, c.transaction_time, c.currency_code, cur.minor_unit,
    c.total_minor, c.subtotal_minor, c.tax_total_minor,
    c.merchant_name, c.document_number, c.confirmed_at
  from public.receipt_confirmations c
  join public.iso_currency_codes cur on cur.code = c.currency_code
  where c.receipt_submission_id = p_submission_id;
end;
$$;

revoke all     on function public.get_my_receipt_confirmation(uuid) from public;
revoke execute on function public.get_my_receipt_confirmation(uuid) from anon;
grant  execute on function public.get_my_receipt_confirmation(uuid) to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- Six functions added; nothing else exists in this migration. No table, column, constraint,
-- index, trigger, policy, role, permission or mapping is created, altered or dropped, no
-- existing function is touched, and no table privilege is granted to any role. None of the
-- six is granted to service_role: every one derives its authority from auth.uid(), which a
-- service-role connection does not have.
