-- Migration: receipt_extraction_azure_retry_eligibility
-- Purpose: Make retry eligibility agree with the modes the backend actually executes.
--
-- THE BUG
--   Migration 20260813210000 created get_my_receipt_extraction when FAKE was the only
--   executable runtime, and wrote the last conjunct of retry_allowed as:
--
--     and coalesce(v_mode, 'DISABLED') = 'FAKE'
--
--   Migration 20260828210000 then taught request_receipt_extraction and
--   claim_receipt_extraction_job about AZURE — but did not recreate this function. The
--   result is a contradiction between two functions in the same contract: with the runtime
--   in AZURE, a FAILED attempt with capacity remaining WOULD be accepted by
--   request_receipt_extraction, while get_my_receipt_extraction reported
--   retry_allowed = false. The client trusts retry_allowed alone — it is documented as the
--   only field carrying availability — so it correctly hid a retry the backend would have
--   honoured.
--
-- THE CORRECTION, AND ITS EXACT SIZE
--   One conjunct becomes:
--
--     and coalesce(v_mode, 'DISABLED') in ('FAKE', 'AZURE')
--
--   which is the same membership test request_receipt_extraction already applies at its own
--   gate, so the two functions now answer "may another attempt be created" identically. The
--   rest of the body is reproduced verbatim from 20260813210000. Nothing else moves: not the
--   three-attempt budget, not the status machine, not the failure vocabulary, not the manual
--   confirmation rule, not the returned columns, and not the grants.
--
-- STILL FAIL-CLOSED
--   DISABLED is not in the list, and coalesce(..., 'DISABLED') keeps a NULL runtime row —
--   and any future mode nobody has taught the workers about — on the false side of the test.
--   Widening this predicate is therefore a deliberate act per mode, not a default.
--
-- STILL NARROWER THAN THE REQUEST GATE
--   retry_allowed remains a conjunction of six conditions, and the mode is only the last of
--   them. A retry is offered only for a latest attempt that is FAILED, with capacity left,
--   with nothing QUEUED or PROCESSING, with no SUCCEEDED attempt, and with no confirmation.
--   This migration relaxes none of those.
--
-- NO AUTHORIZATION CHANGE
--   The function still gates on assert_my_receipt_extraction_access(p_submission_id) as its
--   first statement, still takes no caller identity parameter, still resolves the caller
--   through auth.uid(), and still returns exactly the columns it returned before. The
--   worker claim token, provider, provider model, operation id, storage location, file hash
--   and internal failure code remain unreturnable.
--
-- THIS MIGRATION DOES NOT ENABLE ANYTHING. public.receipt_extraction_runtime is not written
-- here; the row stays exactly as the deployment left it.

create or replace function public.get_my_receipt_extraction(
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

  -- THE ONLY LINE THIS MIGRATION CHANGES is the last conjunct: the executable modes are a
  -- SET, and it is the same set request_receipt_extraction gates its INSERT on. Every other
  -- conjunct is unchanged and still required.
  v_retry :=
        v_row.status = 'FAILED'
    and v_remaining > 0
    and not v_has_active
    and not v_has_succeeded
    and not v_confirmed
    and coalesce(v_mode, 'DISABLED') in ('FAKE', 'AZURE');

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

-- Re-asserted rather than assumed. `create or replace` preserves the existing privileges, so
-- these three statements are a restatement of the intended surface and not a change to it:
-- no role gains execute here that did not already hold it under 20260813210000.
revoke all     on function public.get_my_receipt_extraction(uuid) from public;
revoke execute on function public.get_my_receipt_extraction(uuid) from anon;
grant  execute on function public.get_my_receipt_extraction(uuid) to authenticated;
