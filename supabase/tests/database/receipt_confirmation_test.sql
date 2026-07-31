-- pgTAP behavioural tests for confirm_receipt_extraction and public.receipt_confirmations.
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- A confirmation is the one thing in this milestone a human asserts to be TRUE about a
-- receipt, and it is immutable. Three properties carry that weight:
--
--   1. EVERYTHING THAT MATTERS IS SERVER-DERIVED. Retailer, shop, profile, source extraction,
--      entry mode and changed_fields are computed here; there is no parameter for any of them.
--   2. changed_fields MEANS "A HUMAN CORRECTED THIS", not "the strings differ". The
--      comparison rules below are what make it a usable signal rather than noise: OCR casing,
--      document-number punctuation and second-precision on a time are all provider artefacts,
--      and counting them would make nearly every confirmation MIXED.
--   3. NULL IS NOT ZERO for a monetary field. A zero tax is a fact; an unknown tax is not.
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

/*
 * Drives one attempt to SUCCEEDED with the canonical extracted values.
 *
 * merchant "Lulu  Hypermarket" (double space) and document "INV-2026/004512" are chosen so
 * the whitespace-collapse and punctuation-stripping rules are genuinely exercised rather
 * than trivially satisfied.
 */
create function pg_temp.extract_for(p_user uuid, p_submission uuid) returns uuid
language plpgsql as $$
declare v_ext uuid; v_token uuid; v_op text := 'fake:' || gen_random_uuid()::text;
begin
  perform pg_temp.act_as(p_user);
  select extraction_id into v_ext from public.request_receipt_extraction(p_submission);
  perform pg_temp.sign_out();

  select claim_token into v_token
  from public.claim_receipt_extraction_job(v_ext, 'FAKE', 'fake-receipt-v1');
  perform public.record_receipt_extraction_operation(v_ext, v_token, v_op);
  perform public.record_receipt_extraction_success(
    v_ext, v_token, v_op,
    jsonb_build_object(
      'merchant_name', 'Lulu  Hypermarket',
      'document_number', 'INV-2026/004512',
      'transaction_date', '2026-07-12',
      'transaction_time', '14:32',
      'currency_code', 'AED',
      'total_minor', 123456,
      'subtotal_minor', 117600,
      'tax_total_minor', 5856
    ),
    '[]'::jsonb);
  return v_ext;
end;
$$;

/* Confirms with the canonical values, overriding exactly one of them. */
create function pg_temp.confirm(
  p_submission uuid,
  p_date date default date '2026-07-12',
  p_currency text default 'AED',
  p_total bigint default 123456,
  p_merchant text default 'Lulu Hypermarket',
  p_document text default 'INV-2026/004512',
  p_time time default time '14:32',
  p_subtotal bigint default 117600,
  p_tax bigint default 5856
) returns text language sql as $$
  select outcome || '|' || coalesce(entry_mode, '-') || '|'
         || coalesce(array_to_string(changed_fields, ','), '-')
  from public.confirm_receipt_extraction(
    p_submission, p_date, p_currency, p_total, p_merchant, p_document, p_time,
    p_subtotal, p_tax);
$$;

create function pg_temp.confirm_sqlstate(
  p_submission uuid, p_date date, p_currency text, p_total bigint
) returns text language plpgsql as $$
begin
  perform * from public.confirm_receipt_extraction(p_submission, p_date, p_currency, p_total);
  return null;
exception when others then return sqlstate;
end;
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

-- ============================================================================
-- Fixtures — one submission per scenario, so no test depends on another's writes
-- ============================================================================
create temporary table t_ids (label text primary key, id uuid not null);

do $$
declare
  v_retailer uuid := gen_random_uuid();
  v_shop     uuid := gen_random_uuid();
  v_sales    uuid;
  v_other    uuid;
begin
  insert into public.organizations (id, name, organization_type, status)
  values (v_retailer, 'Confirmation Test Retailer', 'RETAILER', 'ACTIVE');
  insert into public.retailer_shops (id, retailer_organization_id, name, code, status)
  values (v_shop, v_retailer, 'Confirmation Shop', 'C1', 'ACTIVE');

  v_sales := pg_temp.new_user('cnf_sales');
  v_other := pg_temp.new_user('cnf_other');
  perform pg_temp.grant_role(v_sales, v_retailer, 'SALES_STAFF');
  perform pg_temp.grant_role(v_other, v_retailer, 'SALES_STAFF');

  insert into t_ids values ('retailer', v_retailer), ('shop', v_shop),
                           ('sales', v_sales), ('other', v_other);

  insert into t_ids
  select 'sub' || g, pg_temp.new_submission(v_retailer, v_shop, v_sales)
  from generate_series(1, 22) g;

  insert into t_ids values ('sub_other', pg_temp.new_submission(v_retailer, v_shop, v_other));
end;
$$;

update public.receipt_extraction_runtime set mode = 'FAKE' where id;

-- ============================================================================
-- SECTION A — the parameter list
-- ============================================================================
select is(
  pg_temp.input_args('confirm_receipt_extraction'),
  array['p_submission_id', 'p_transaction_date', 'p_currency_code', 'p_total_minor',
        'p_merchant_name', 'p_document_number', 'p_transaction_time',
        'p_subtotal_minor', 'p_tax_total_minor'],
  'exactly nine parameters — no org, shop, profile, membership, extraction, entry mode, changed fields or duplicate signal'
);

select ok(
  not (pg_temp.input_args('confirm_receipt_extraction') && array[
    'p_entry_mode', 'p_changed_fields', 'p_source_extraction_id', 'p_organization_id',
    'p_retailer_shop_id', 'p_profile_id', 'p_is_duplicate'
  ]),
  'and none of the forbidden ones exists'
);

-- No duplicate-signal column was added to the table either.
select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name = 'receipt_confirmations'
     and (column_name like '%duplicate%' or column_name like '%line_item%')),
  0,
  'the confirmation carries no duplicate signal and no line-item column'
);

-- ============================================================================
-- SECTION B — MANUAL: no extraction, after a failure, after exhaustion
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label='sales'));

select is(
  pg_temp.confirm((select id from t_ids where label='sub1')),
  'CONFIRMED|MANUAL|',
  'with NO extraction at all, the confirmation is MANUAL with no changed fields'
);
select is(
  (select source_extraction_id from public.receipt_confirmations
   where receipt_submission_id = (select id from t_ids where label='sub1')),
  null,
  'and no source extraction'
);

-- After a single failure.
select pg_temp.sign_out();
do $$
declare v_ext uuid; v_token uuid; v_op text := 'fake:' || gen_random_uuid()::text;
begin
  perform pg_temp.act_as((select id from t_ids where label='sales'));
  select extraction_id into v_ext
  from public.request_receipt_extraction((select id from t_ids where label='sub2'));
  perform pg_temp.sign_out();
  select claim_token into v_token
  from public.claim_receipt_extraction_job(v_ext, 'FAKE', 'fake-receipt-v1');
  perform public.record_receipt_extraction_operation(v_ext, v_token, v_op);
  perform public.record_receipt_extraction_failure(v_ext, v_token, v_op, 'PROVIDER_TIMEOUT');
end;
$$;
select pg_temp.act_as((select id from t_ids where label='sales'));
select is(
  pg_temp.confirm((select id from t_ids where label='sub2')),
  'CONFIRMED|MANUAL|',
  'after a FAILED attempt, manual confirmation still works'
);

-- After three failures.
select pg_temp.sign_out();
do $$
declare v_ext uuid; v_token uuid; v_op text; i int;
begin
  for i in 1..3 loop
    perform pg_temp.act_as((select id from t_ids where label='sales'));
    select extraction_id into v_ext
    from public.request_receipt_extraction((select id from t_ids where label='sub3'));
    perform pg_temp.sign_out();
    v_op := 'fake:' || gen_random_uuid()::text;
    select claim_token into v_token
    from public.claim_receipt_extraction_job(v_ext, 'FAKE', 'fake-receipt-v1');
    perform public.record_receipt_extraction_operation(v_ext, v_token, v_op);
    perform public.record_receipt_extraction_failure(v_ext, v_token, v_op, 'PROVIDER_TIMEOUT');
  end loop;
end;
$$;
select pg_temp.act_as((select id from t_ids where label='sales'));
select is(
  pg_temp.confirm((select id from t_ids where label='sub3')),
  'CONFIRMED|MANUAL|',
  'after EXHAUSTING all three attempts, manual confirmation still works'
);

-- ============================================================================
-- SECTION C — an in-flight attempt is the ONE thing that blocks
-- ============================================================================
select pg_temp.sign_out();
select pg_temp.act_as((select id from t_ids where label='sales'));
select (select outcome from public.request_receipt_extraction(
          (select id from t_ids where label='sub4'))) as queued;

select is(
  pg_temp.confirm((select id from t_ids where label='sub4')),
  'EXTRACTION_IN_PROGRESS|-|-',
  'a QUEUED attempt blocks confirmation'
);
select is(
  (select count(*)::int from public.receipt_confirmations
   where receipt_submission_id = (select id from t_ids where label='sub4')),
  0,
  'and nothing is written'
);

select pg_temp.sign_out();
select (select count(*) from public.claim_receipt_extraction_job(
  (select id from public.receipt_extractions
   where receipt_submission_id = (select id from t_ids where label='sub4')),
  'FAKE', 'fake-receipt-v1')) as claimed;
select pg_temp.act_as((select id from t_ids where label='sales'));
select is(
  pg_temp.confirm((select id from t_ids where label='sub4')),
  'EXTRACTION_IN_PROGRESS|-|-',
  'a PROCESSING attempt blocks it too'
);

-- ============================================================================
-- SECTION D — EXTRACTED: every value matches
-- ============================================================================
select pg_temp.sign_out();
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub5')) is not null as extracted;
select pg_temp.act_as((select id from t_ids where label='sales'));

select is(
  pg_temp.confirm((select id from t_ids where label='sub5')),
  'CONFIRMED|EXTRACTED|',
  'an unchanged confirmation is EXTRACTED with no changed fields'
);
select ok(
  (select source_extraction_id is not null from public.receipt_confirmations
   where receipt_submission_id = (select id from t_ids where label='sub5')),
  'and records the extraction it was compared against'
);

-- ============================================================================
-- SECTION E — MIXED: each of the eight fields, one at a time
-- ============================================================================
select pg_temp.sign_out();
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub6')) is not null as e6;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub7')) is not null as e7;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub8')) is not null as e8;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub9')) is not null as e9;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub10')) is not null as e10;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub11')) is not null as e11;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub12')) is not null as e12;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub13')) is not null as e13;
select pg_temp.act_as((select id from t_ids where label='sales'));

select is(
  pg_temp.confirm((select id from t_ids where label='sub6'), p_merchant := 'Spinneys'),
  'CONFIRMED|MIXED|merchant_name',
  'a corrected merchant name yields MIXED with exactly that field'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub7'), p_document := 'INV-2026/999999'),
  'CONFIRMED|MIXED|document_number',
  'a corrected document number'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub8'), p_date := date '2026-07-13'),
  'CONFIRMED|MIXED|transaction_date',
  'a corrected date'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub9'), p_time := time '15:00'),
  'CONFIRMED|MIXED|transaction_time',
  'a corrected time'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub10'), p_currency := 'USD'),
  'CONFIRMED|MIXED|currency_code',
  'a corrected currency'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub11'), p_total := 999999),
  'CONFIRMED|MIXED|total_minor',
  'a corrected total'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub12'), p_subtotal := 111111),
  'CONFIRMED|MIXED|subtotal_minor',
  'a corrected subtotal'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub13'), p_tax := 1),
  'CONFIRMED|MIXED|tax_total_minor',
  'a corrected tax'
);

-- Several at once, SORTED.
select pg_temp.sign_out();
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub14')) is not null as e14;
select pg_temp.act_as((select id from t_ids where label='sales'));
select is(
  pg_temp.confirm((select id from t_ids where label='sub14'),
                  p_total := 1, p_merchant := 'Other', p_date := date '2026-01-01'),
  'CONFIRMED|MIXED|merchant_name,total_minor,transaction_date',
  'several corrections are reported together, SORTED, so two identical confirmations agree'
);

-- ============================================================================
-- SECTION F — the comparison rules: what is NOT a human correction
-- ============================================================================
select pg_temp.sign_out();
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub15')) is not null as e15;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub16')) is not null as e16;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub17')) is not null as e17;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub18')) is not null as e18;
select pg_temp.act_as((select id from t_ids where label='sales'));

select is(
  pg_temp.confirm((select id from t_ids where label='sub15'), p_merchant := 'LULU HYPERMARKET'),
  'CONFIRMED|EXTRACTED|',
  'CASE alone is not a correction — OCR casing is a provider artefact'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub16'), p_merchant := 'Lulu   Hypermarket'),
  'CONFIRMED|EXTRACTED|',
  'collapsed WHITESPACE is not a correction either'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub17'), p_document := 'inv2026004512'),
  'CONFIRMED|EXTRACTED|',
  'document-number PUNCTUATION and case are not corrections'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub18'), p_time := time '14:32:45'),
  'CONFIRMED|EXTRACTED|',
  'SECONDS on a time are not a correction — receipts print HH:MM'
);

-- NULL is not zero.
select pg_temp.sign_out();
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub19')) is not null as e19;
select pg_temp.act_as((select id from t_ids where label='sales'));
select is(
  pg_temp.confirm((select id from t_ids where label='sub19'), p_tax := null),
  'CONFIRMED|MIXED|tax_total_minor',
  'clearing a tax that WAS read IS a correction — NULL and 0 are different values'
);

-- And a null merchant against a read merchant is a correction.
select pg_temp.sign_out();
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub20')) is not null as e20;
select pg_temp.act_as((select id from t_ids where label='sales'));
select is(
  pg_temp.confirm((select id from t_ids where label='sub20'), p_merchant := '   '),
  'CONFIRMED|MIXED|merchant_name',
  'blanking a merchant name that was read is a correction (blank normalises to NULL)'
);

-- ============================================================================
-- SECTION G — immutability and the single confirmation
-- ============================================================================
select is(
  pg_temp.confirm((select id from t_ids where label='sub5'), p_total := 42),
  'ALREADY_CONFIRMED|EXTRACTED|',
  'a duplicate call returns the EXISTING confirmation and does not compare the new values'
);
select is(
  (select total_minor from public.receipt_confirmations
   where receipt_submission_id = (select id from t_ids where label='sub5')),
  123456::bigint,
  'and the stored total is untouched'
);
select is(
  (select count(*)::int from public.receipt_confirmations
   where receipt_submission_id = (select id from t_ids where label='sub5')),
  1,
  'exactly one confirmation exists'
);

select pg_temp.sign_out();
select throws_ok(
  format($q$update public.receipt_confirmations set total_minor = 1 where receipt_submission_id = %L$q$,
         (select id from t_ids where label='sub5')),
  '23514', null, 'a confirmation cannot be UPDATED');
select throws_ok(
  format($q$update public.receipt_confirmations set confirmed_at = now() where receipt_submission_id = %L$q$,
         (select id from t_ids where label='sub5')),
  '23514', null, 'not even its timestamp');
select throws_ok(
  format($q$delete from public.receipt_confirmations where receipt_submission_id = %L$q$,
         (select id from t_ids where label='sub5')),
  '23514', null, 'and it cannot be DELETED');

select throws_ok(
  format($q$insert into public.receipt_confirmations
     (receipt_submission_id, retailer_organization_id, retailer_shop_id,
      confirmed_by_profile_id, entry_mode, transaction_date, currency_code, total_minor)
     values (%L, %L, %L, %L, 'MANUAL', date '2026-07-12', 'AED', 1)$q$,
    (select id from t_ids where label='sub5'),
    (select id from t_ids where label='retailer'),
    (select id from t_ids where label='shop'),
    (select id from t_ids where label='sales')),
  '23505', null,
  'a second confirmation row violates the unique constraint');

-- The tenant/actor trigger refuses a mis-attributed confirmation.
select throws_ok(
  format($q$insert into public.receipt_confirmations
     (receipt_submission_id, retailer_organization_id, retailer_shop_id,
      confirmed_by_profile_id, entry_mode, transaction_date, currency_code, total_minor)
     values (%L, %L, %L, %L, 'MANUAL', date '2026-07-12', 'AED', 1)$q$,
    (select id from t_ids where label='sub21'),
    (select id from t_ids where label='retailer'),
    (select id from t_ids where label='shop'),
    (select id from t_ids where label='other')),
  '23514', null,
  'a confirmation cannot be attributed to anyone but the receipt submitter');

-- ============================================================================
-- SECTION H — value validation and access
-- ============================================================================
select pg_temp.act_as((select id from t_ids where label='sales'));

select is(pg_temp.confirm_sqlstate((select id from t_ids where label='sub21'),
                                   date '2026-07-12', 'ZZZ', 100),
          '23514', 'an unknown currency is refused');
select is(pg_temp.confirm_sqlstate((select id from t_ids where label='sub21'),
                                   date '2026-07-12', 'AED', -1),
          '23514', 'a negative total is refused');
select is(pg_temp.confirm_sqlstate((select id from t_ids where label='sub21'),
                                   date '2026-07-12', 'AED', 1000000000001),
          '23514', 'a total above the ceiling is refused');
select is(pg_temp.confirm_sqlstate((select id from t_ids where label='sub21'),
                                   date '1999-12-31', 'AED', 100),
          '23514', 'a date before 2000 is refused');
select is(pg_temp.confirm_sqlstate((select id from t_ids where label='sub21'),
                                   null, 'AED', 100),
          '23514', 'a missing date is refused');
select is(pg_temp.confirm_sqlstate((select id from t_ids where label='sub21'),
                                   date '2026-07-12', 'AED', null),
          '23514', 'a missing total is refused');

select is(pg_temp.confirm_sqlstate((select id from t_ids where label='sub21'),
                                   date '2026-07-12', 'AED', 0),
          null, 'a ZERO total is accepted — a fully discounted receipt is real');

-- subtotal + tax need not equal total.
select pg_temp.sign_out();
select pg_temp.act_as((select id from t_ids where label='sales'));
select is(
  pg_temp.confirm((select id from t_ids where label='sub22'),
                  p_total := 10501, p_subtotal := 10000, p_tax := 500),
  'CONFIRMED|MANUAL|',
  'subtotal + tax NEED NOT equal the total — real receipts round independently'
);

-- Access: someone else's receipt is invisible, not an error.
select is(
  (select count(*)::int from public.confirm_receipt_extraction(
     (select id from t_ids where label='sub_other'), date '2026-07-12', 'AED', 100)),
  0,
  'confirming ANOTHER staff member''s receipt returns zero rows'
);
select is(
  (select count(*)::int from public.confirm_receipt_extraction(
     gen_random_uuid(), date '2026-07-12', 'AED', 100)),
  0,
  'and an unknown id is byte-identical'
);
select is(
  (select count(*)::int from public.get_my_receipt_confirmation(
     (select id from t_ids where label='sub_other'))),
  0,
  'and another member''s confirmation is unreadable'
);

-- The caller's own confirmation reads back, with its minor unit.
select is(
  (select entry_mode || '|' || currency_code || '|' || currency_minor_unit || '|' || total_minor
   from public.get_my_receipt_confirmation((select id from t_ids where label='sub5'))),
  'EXTRACTED|AED|2|123456',
  'the caller reads their own confirmation, minor unit included'
);

-- ============================================================================
-- SECTION I — a confirmation is readable, and blocks a further request
-- ============================================================================
select is(
  (select outcome from public.request_receipt_extraction(
     (select id from t_ids where label='sub5'))),
  'ALREADY_CONFIRMED',
  'once confirmed, a further extraction request is refused as ALREADY_CONFIRMED'
);

-- And that stays true with the gate shut: a confirmation is stored evidence.
select pg_temp.sign_out();
update public.receipt_extraction_runtime set mode = 'DISABLED' where id;
select pg_temp.act_as((select id from t_ids where label='sales'));
select is(
  (select count(*)::int from public.get_my_receipt_confirmation(
     (select id from t_ids where label='sub5'))),
  1,
  'an existing confirmation stays readable when extraction is DISABLED'
);
select is(
  (select outcome from public.request_receipt_extraction(
     (select id from t_ids where label='sub5'))),
  'ALREADY_CONFIRMED',
  'and ALREADY_CONFIRMED still takes precedence over the gate'
);

-- Manual confirmation itself is independent of the gate.
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub21'),
                           date '2026-07-12', 'AED', 500),
  null,
  'MANUAL CONFIRMATION WORKS WITH THE GATE SHUT — it never consults the runtime mode'
);

-- ============================================================================
-- SECTION J — audit
-- ============================================================================
select pg_temp.sign_out();
select ok(
  (select bool_and(actor_profile_id is not null) from public.audit_logs
   where action = 'RECEIPT_CONFIRMED'),
  'every confirmation is attributed to the confirming profile'
);

select is(
  (select count(*)::int from public.audit_logs
   where action = 'RECEIPT_CONFIRMED'
     and (metadata::text like '%Lulu%' or metadata::text like '%INV-2026%'
          or metadata::text like '%123456%' or metadata::text like '%AED%')),
  0,
  'and carries NO merchant, document number, amount or currency — field names only'
);

select ok(
  (select bool_and(metadata ? 'entry_mode' and metadata ? 'changed_fields')
   from public.audit_logs where action = 'RECEIPT_CONFIRMED'),
  'the metadata records the derived mode and the changed FIELD NAMES'
);

select * from finish();

rollback;
