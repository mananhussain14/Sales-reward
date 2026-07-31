-- Migration: receipt_confirmation_currency_minor_unit
-- Purpose: Closes a silent mis-scaling hole in the confirmation contract. Adds ONE function
--          and REPLACES ONE:
--            1. public.get_receipt_currency_minor_unit(text)   [new, authenticated]
--            2. public.confirm_receipt_extraction(...)         [REPLACED — new argument list]
--
-- ============================================================================
-- THE DEFECT
-- ============================================================================
-- Every monetary value crossing this boundary is an INTEGER NUMBER OF MINOR UNITS, and the
-- number of minor units in one major unit is a property OF THE CURRENCY: 2 for EUR, 0 for
-- JPY, 3 for KWD, 4 for CLF. public.iso_currency_codes has carried that number since
-- migration 20260812090000 and every one of the 165 seeded codes has it.
--
-- The shipped confirmation contract took `p_currency_code` and three integers, and NOTHING
-- ELSE. Given the integer 1000 and the code 'JPY' there is no way, at any point after the
-- call, to tell whether the client meant ¥1000 (correct: JPY has no minor unit) or ¥10.00
-- scaled as though JPY had two decimals. Both arrive as the same integer. The scale the
-- client used was simply not part of the request.
--
-- The Flutter client assumes two decimal places whenever the extraction carries no
-- currency_minor_unit, whenever staff change the currency, and whenever staff start a manual
-- confirmation. For EUR that assumption is right and nothing is wrong. For JPY it stores a
-- total 100x too large, for KWD 10x too small, and for CLF 100x too small — silently, into
-- an IMMUTABLE row with no correction path.
--
-- Fixing only the client would leave the same hole open for the next client. The scale has to
-- be part of the REQUEST, and the backend has to be the one that decides whether it is right.
--
-- ============================================================================
-- WHAT THIS MIGRATION CHANGES, AND WHAT IT DELIBERATELY DOES NOT
-- ============================================================================
-- It adds ONE required parameter, `p_currency_minor_unit`, and one rule: it must EQUAL the
-- minor unit public.iso_currency_codes records for the confirmed currency. A client that
-- states the scale it used can be checked; a client that states nothing cannot. That is the
-- whole of the change to confirmation.
--
-- The parameter is NOT a way to choose a scale. It is a DECLARATION the backend verifies and
-- then discards: nothing is stored from it, no amount is multiplied or divided anywhere in
-- this file, and the authority remains public.iso_currency_codes on both sides of the check.
-- A mismatched declaration is refused rather than honoured, so the only confirmations that
-- can exist are ones where client and backend agreed on what the integers meant.
--
-- UNCHANGED, and each of these is asserted by the pgTAP suite:
--   * every authorization, ownership, tenant and status check, byte for byte;
--   * ALREADY_CONFIRMED, EXTRACTION_IN_PROGRESS and the zero-row refusal;
--   * the derivation of entry_mode and changed_fields, including every comparison rule;
--   * immutability, the one-confirmation-per-receipt constraint and the audit event;
--   * the return shape — outcome, confirmation_id, entry_mode, changed_fields;
--   * the existing 23514 refusals and their messages;
--   * public.receipt_confirmations: no column, constraint, index or trigger is touched.
--
-- No table, column, constraint, index, trigger, policy, role, permission or mapping is
-- created, altered or dropped anywhere in this migration, and no table privilege is granted
-- to any role. In particular public.iso_currency_codes keeps RLS enabled with zero policies
-- and zero table grants: the new function reads it as its DEFINER and returns one row of two
-- values, which is not the same thing as letting a browser role read the table.
--
-- Idempotency posture: an explicit DROP of the old confirmation signature, then plain CREATE
--   FUNCTION for both. No CREATE OR REPLACE, no IF NOT EXISTS, no dynamic SQL, empty
--   search_path, every reference schema-qualified.
--
-- Dependencies: 20260723090000 (resolve_retailer_member_organization), 20260726090000
--   (receipt_submissions), 20260812090000 (iso_currency_codes), 20260812210000
--   (receipt_confirmations, receipt_extractions), 20260813210000 (the function replaced).

-- ============================================================================
-- Remove the old confirmation signature
-- ============================================================================
-- CREATE OR REPLACE CANNOT ADD A PARAMETER. Replacing a function whose argument list differs
-- creates a SECOND function by overloading, and the old one would keep its grant to
-- `authenticated` — leaving the exact insecure call path this migration exists to close,
-- reachable by name, forever. So the old signature is DROPPED, which removes its privileges
-- with it, and the new one is created and granted from scratch below.
--
-- The DROP is safe: no SQL object depends on this function. Its only callers are the Flutter
-- client and this project's own tests, and a client calling the nine-argument form after this
-- migration gets PostgREST's "function not found", which is a loud, immediate failure rather
-- than a silently mis-scaled amount. That is the intended outcome — the old contract cannot
-- express a correct JPY confirmation, so continuing to serve it would be the bug.
drop function public.confirm_receipt_extraction(
  uuid, date, text, bigint, text, text, time without time zone, bigint, bigint
);

-- ============================================================================
-- FUNCTION 1 — get_receipt_currency_minor_unit(text)
-- ============================================================================
-- The authoritative answer to "how many decimal places does this currency have", for the
-- Sales Staff member about to confirm a receipt.
--
-- WHY THE CLIENT NEEDS IT AT ALL. get_my_receipt_extraction already returns
-- currency_minor_unit for the currency the provider read. It is NULL when there is no
-- successful extraction, and it is the WRONG currency's minor unit the moment staff change
-- the currency on the review form. Those are exactly the three moments the Flutter review
-- names — no extraction, currency changed, manual entry — and in all three the client needs
-- to ask rather than assume. This function is that question, and nothing else.
--
-- IT RETURNS TWO VALUES AND NO MORE. The normalized code and its minor unit. No name, no
-- numeric code, no symbol, no seed provenance, no row count, no neighbouring row. The return
-- type has no room for one, which is a structural guarantee rather than a reviewed omission.
--
-- IT IS NOT A LIST ENDPOINT. One code in, at most one row out. There is deliberately no
-- parameterless form, no prefix search and no "all currencies" mode: the client ships its own
-- copy of the list in lib/reference/iso-currency-codes.ts for rendering a picker, and this
-- function exists to settle ONE code authoritatively, which is a far smaller thing to expose
-- than the table.
--
-- AN UNSUPPORTED CODE IS ZERO ROWS, NOT AN EXCEPTION. 'ZZZ', 'usd ', '' and NULL are all
-- byte-identical: no row. A currency this system will not accept and a currency that does not
-- exist are the same fact from the caller's side — "you cannot confirm in this" — and
-- collapsing them keeps the seed's exact membership, which is a deployment detail, out of the
-- answer. The caller distinguishes "supported" from "not" by whether a row came back.
--
-- SAME GATE AS EVERY OTHER AUTHENTICATED RECEIPT RPC. It resolves through
-- RECEIPT_EXTRACTION_REVIEW, so an unauthenticated caller, a Retailer Owner, a Vendor admin,
-- a suspended profile or an inactive membership is refused with 42501 exactly as they are on
-- the other six. No role code is named here; deactivating the role revokes this with the rest.
--
-- NO TENANT DATA IS READ OR REACHABLE. It touches public.iso_currency_codes and nothing else:
-- no submission, extraction, confirmation, organization, shop or profile row is read, and it
-- takes no identifier that could name one. The gate exists to keep the surface no wider than
-- the feature it serves, not because the answer is sensitive — ISO 4217 minor units are
-- published by the standard.
create function public.get_receipt_currency_minor_unit(
  p_currency_code text
)
returns table (
  currency_code text,
  minor_unit    smallint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
  v_code     text;
begin
  v_retailer := public.resolve_retailer_member_organization('RECEIPT_EXTRACTION_REVIEW');

  if v_retailer is null then
    raise exception 'Not authorized to review receipt extraction'
      using errcode = 'insufficient_privilege';
  end if;

  -- The SAME normalization confirmation applies, so the two can never disagree about which
  -- code a given input names.
  v_code := nullif(upper(btrim(coalesce(p_currency_code, ''))), '');

  if v_code is null then
    return;  -- null, blank or whitespace-only: no row, exactly as an unknown code is
  end if;

  return query
  select c.code, c.minor_unit
  from public.iso_currency_codes c
  where c.code = v_code;
end;
$$;

revoke all     on function public.get_receipt_currency_minor_unit(text) from public;
revoke execute on function public.get_receipt_currency_minor_unit(text) from anon;
grant  execute on function public.get_receipt_currency_minor_unit(text) to authenticated;

comment on function public.get_receipt_currency_minor_unit(text) is
  'Resolves one ISO 4217 alphabetic code to its minor unit for an authorized Sales Staff reviewer. Zero rows for an unsupported, blank or null code.';

-- ============================================================================
-- FUNCTION 2 — confirm_receipt_extraction(...)  [REPLACED]
-- ============================================================================
-- Records the one immutable confirmation for a receipt.
--
-- TEN PARAMETERS: the submission, FOUR required values, five optional values. The tenth is
-- p_currency_minor_unit, and it is the only change from migration 20260813210000's nine.
-- There is still no parameter for an organization id, a shop id, a profile id, a membership
-- id, an extraction id, an entry mode, a changed-fields list or a duplicate signal. Every one
-- of those is derived here.
--
-- p_currency_minor_unit SITS BESIDE THE CURRENCY IT QUALIFIES, and before the amounts it
-- scales, because it is a property of the currency and not a tenth independent value. It is
-- REQUIRED — no default — so the argument list itself is what makes "confirm without saying
-- what the integers mean" impossible to express. A default would have re-created the bug for
-- every caller that omitted it.
--
-- WHAT THE CHECK ACTUALLY GUARANTEES, AND WHAT IT CANNOT. It guarantees that the client and
-- this database agree on the scale of the integers in this request. It cannot verify that the
-- client then applied that scale correctly to the digits a human typed — no server-side rule
-- can, because 1000 minor units is a valid amount under every scale. What it removes is the
-- SILENT case: a client that hard-codes 2 now fails loudly and immediately on JPY, KWD and
-- CLF instead of writing a wrong immutable row, and the failure names the one thing to fix.
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
-- THE MINOR UNIT IS NOT A COMPARED FIELD. changed_fields still names exactly the same eight,
-- and 'currency_minor_unit' is not among them: the minor unit is a FUNCTION of currency_code,
-- so a staff member who changes the currency has already produced 'currency_code' and a
-- second entry would double-count one act. Nothing about the derivation changes.
--
-- A DUPLICATE CALL RETURNS THE EXISTING CONFIRMATION AND COMPARES NOTHING. Returning "ok"
-- when the resubmitted values differ from the stored ones would be a lie, and replacing them
-- is forbidden, so the honest answer is to report that one already exists.
create function public.confirm_receipt_extraction(
  p_submission_id      uuid,
  p_transaction_date   date,
  p_currency_code      text,
  p_currency_minor_unit smallint,
  p_total_minor        bigint,
  p_merchant_name      text                   default null,
  p_document_number    text                   default null,
  p_transaction_time   time without time zone default null,
  p_subtotal_minor     bigint                 default null,
  p_tax_total_minor    bigint                 default null
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
  v_minor_unit   smallint;
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

  -- THE CURRENCY IS RESOLVED, NOT MERELY TESTED FOR EXISTENCE. The same lookup that refuses
  -- an unsupported code produces the authoritative minor unit for a supported one, so the
  -- two can never be answered from different rows.
  select c.minor_unit into v_minor_unit
  from public.iso_currency_codes c
  where c.code = v_currency;

  if v_minor_unit is null then
    -- Unsupported code. 23514 and this message are UNCHANGED from the shipped contract: an
    -- unsupported currency is refused before the scale is considered at all, so the newer,
    -- narrower refusal below can only ever mean the one thing it names.
    raise exception 'That currency could not be accepted'
      using errcode = 'check_violation';
  end if;

  -- ---- 3a. THE SCALE THE CLIENT USED MUST BE THE OFFICIAL ONE ------------------
  -- 22023 (invalid_parameter_value) is the STABLE, MACHINE-MAPPABLE identity of this refusal
  -- and it is raised by nothing else in this function. Every other rejected value here raises
  -- 23514, an unauthorized caller gets 42501, an unknown receipt gets zero rows and an
  -- in-flight attempt gets an EXTRACTION_IN_PROGRESS row — so a client can act on this one
  -- case without parsing a single word of English.
  --
  -- NULL LANDS HERE TOO, and on purpose. "I did not state a scale" and "I stated the wrong
  -- scale" are the same defect from this function's side: in neither case is there a verified
  -- agreement about what the integers mean, and in both the fix is identical — ask
  -- get_receipt_currency_minor_unit and send what it returns.
  --
  -- The message names no table, no column and no expected value. A caller that wants the
  -- official number has a function for it.
  if p_currency_minor_unit is null or p_currency_minor_unit <> v_minor_unit then
    raise exception 'That confirmation did not state the currency minor unit this system uses'
      using errcode = 'invalid_parameter_value';
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

  -- FIELD NAMES ONLY. No merchant, no document number, no amount, no currency — and no minor
  -- unit either: it is a property of a currency this row deliberately does not name.
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

revoke all     on function public.confirm_receipt_extraction(uuid, date, text, smallint, bigint, text, text, time without time zone, bigint, bigint) from public;
revoke execute on function public.confirm_receipt_extraction(uuid, date, text, smallint, bigint, text, text, time without time zone, bigint, bigint) from anon;
grant  execute on function public.confirm_receipt_extraction(uuid, date, text, smallint, bigint, text, text, time without time zone, bigint, bigint) to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One function added, one replaced, one old signature dropped. No table, column, constraint,
-- index, trigger, policy, role, permission or mapping is created, altered or dropped, no
-- table privilege is granted to any role, and no OTHER function is touched — the five other
-- authenticated RPCs and all seven service-role RPCs are exactly as migration 20260813210000
-- and 20260813090000 left them. Neither function here is granted to service_role: both derive
-- their authority from auth.uid(), which a service-role connection does not have.
