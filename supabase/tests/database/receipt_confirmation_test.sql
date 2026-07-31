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

/*
 * Confirms with the canonical values, overriding exactly one of them.
 *
 * p_minor defaults to 2, the minor unit AED actually has, so every pre-existing scenario
 * states the correct scale and exercises the same paths it always did. The minor-unit rule
 * itself is driven explicitly in SECTION K.
 */
create function pg_temp.confirm(
  p_submission uuid,
  p_date date default date '2026-07-12',
  p_currency text default 'AED',
  p_minor smallint default 2::smallint,
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
    p_submission, p_date, p_currency, p_minor, p_total, p_merchant, p_document, p_time,
    p_subtotal, p_tax);
$$;

create function pg_temp.confirm_sqlstate(
  p_submission uuid, p_date date, p_currency text, p_total bigint,
  p_minor smallint default 2::smallint
) returns text language plpgsql as $$
begin
  perform * from public.confirm_receipt_extraction(
    p_submission, p_date, p_currency, p_minor, p_total);
  return null;
exception when others then return sqlstate;
end;
$$;

/* The minor unit an authorized caller is told to use, or '-' when no row comes back. */
create function pg_temp.lookup_minor(p_code text) returns text
language sql stable as $$
  select coalesce(
    (select currency_code || '|' || minor_unit
     from public.get_receipt_currency_minor_unit(p_code)),
    '-');
$$;

create function pg_temp.lookup_sqlstate(p_code text) returns text
language plpgsql as $$
begin
  perform * from public.get_receipt_currency_minor_unit(p_code);
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
  from generate_series(1, 30) g;

  insert into t_ids values ('sub_other', pg_temp.new_submission(v_retailer, v_shop, v_other));
end;
$$;

update public.receipt_extraction_runtime set mode = 'FAKE' where id;

-- ============================================================================
-- SECTION A — the parameter list
-- ============================================================================
select is(
  pg_temp.input_args('confirm_receipt_extraction'),
  array['p_submission_id', 'p_transaction_date', 'p_currency_code', 'p_currency_minor_unit',
        'p_total_minor', 'p_merchant_name', 'p_document_number', 'p_transaction_time',
        'p_subtotal_minor', 'p_tax_total_minor'],
  'exactly ten parameters — no org, shop, profile, membership, extraction, entry mode, changed fields or duplicate signal'
);

select ok(
  not (pg_temp.input_args('confirm_receipt_extraction') && array[
    'p_entry_mode', 'p_changed_fields', 'p_source_extraction_id', 'p_organization_id',
    'p_retailer_shop_id', 'p_profile_id', 'p_is_duplicate'
  ]),
  'and none of the forbidden ones exists'
);

-- The minor unit is REQUIRED. A default would let a caller omit the one value this whole
-- change exists to obtain, which is the defect rather than a mitigation of it.
select is(
  (select p.pronargdefaults::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'confirm_receipt_extraction'),
  5,
  'exactly five parameters carry defaults — p_currency_minor_unit is not one of them'
);

-- The smallest integer type the schema uses for a minor unit, matching
-- public.iso_currency_codes.minor_unit and get_my_receipt_extraction.currency_minor_unit.
select is(
  (select pg_catalog.format_type(p.proargtypes[3], null) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'confirm_receipt_extraction'),
  'smallint',
  'p_currency_minor_unit is a smallint'
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
     (select id from t_ids where label='sub_other'), date '2026-07-12', 'AED',
     2::smallint, 100)),
  0,
  'confirming ANOTHER staff member''s receipt returns zero rows'
);
select is(
  (select count(*)::int from public.confirm_receipt_extraction(
     gen_random_uuid(), date '2026-07-12', 'AED', 2::smallint, 100)),
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

-- ============================================================================
-- SECTION K — the currency minor-unit contract
-- ============================================================================
-- Every monetary value here is an integer number of MINOR units, and how many minor units
-- make a major one is a property of the CURRENCY: 2 for EUR, 0 for JPY, 3 for KWD, 4 for CLF.
-- The shipped nine-parameter contract took the integer and the code and never asked which
-- scale the client had used, so a client assuming two decimals stored a JPY total 100x too
-- large into an immutable row. These tests pin the fix: the client must STATE the scale, and
-- the backend refuses any statement that is not the official one.
--
-- The runtime gate is still DISABLED from SECTION I, which is deliberate — manual
-- confirmation never consults it, and these confirmations prove that stays true.

-- ---- The lookup RPC --------------------------------------------------------
select pg_temp.sign_out();
select is(pg_temp.lookup_sqlstate('EUR'), '42501',
          'an UNAUTHENTICATED caller cannot resolve a minor unit');

select pg_temp.act_as((select id from t_ids where label='sales'));

select is(pg_temp.lookup_minor('EUR'), 'EUR|2', 'EUR resolves to 2');
select is(pg_temp.lookup_minor('JPY'), 'JPY|0', 'JPY resolves to 0 — no minor unit at all');
select is(pg_temp.lookup_minor('KWD'), 'KWD|3', 'KWD resolves to 3');
select is(pg_temp.lookup_minor('CLF'), 'CLF|4', 'CLF resolves to 4');

select is(pg_temp.lookup_minor('  jpy  '), 'JPY|0',
          'the lookup normalises with trim + upper, exactly as confirmation does');

select is(pg_temp.lookup_minor('ZZZ'), '-', 'an unsupported code yields NO ROW, not an error');
select is(pg_temp.lookup_minor(''),    '-', 'a blank code is byte-identical');
select is(pg_temp.lookup_minor('   '), '-', 'whitespace only, likewise');
select is(pg_temp.lookup_minor(null),  '-', 'and NULL, likewise');

select is(
  pg_temp.input_args('get_receipt_currency_minor_unit'), array['p_currency_code'],
  'the lookup takes one currency code and nothing else'
);

-- It is not a list endpoint: two columns out, and no way to ask for the whole table.
select is(
  (select array_agg(x.name order by x.ord)
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   cross join lateral unnest(p.proargnames, p.proargmodes) with ordinality as x(name, mode, ord)
   where n.nspname = 'public' and p.proname = 'get_receipt_currency_minor_unit'
     and x.mode = 't'),
  array['currency_code', 'minor_unit'],
  'and returns exactly the normalized code and its minor unit'
);

-- ---- Grants ----------------------------------------------------------------
select ok(
  has_function_privilege('authenticated',
    'public.get_receipt_currency_minor_unit(text)', 'EXECUTE'),
  'authenticated may call the lookup'
);
select ok(
  not has_function_privilege('anon',
    'public.get_receipt_currency_minor_unit(text)', 'EXECUTE'),
  'anon may NOT call the lookup'
);
-- The lookup is a NARROW WINDOW, not a table grant. Both independent blocks on
-- public.iso_currency_codes are still in place.
select ok(
  not has_table_privilege('authenticated', 'public.iso_currency_codes', 'SELECT'),
  'authenticated STILL cannot read iso_currency_codes directly'
);
select ok(
  not has_table_privilege('anon', 'public.iso_currency_codes', 'SELECT'),
  'nor can anon'
);
select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'iso_currency_codes'),
  0,
  'and no RLS policy was added to it'
);

-- ---- The old signature is gone, not overloaded ------------------------------
-- An overload would have kept its grant to `authenticated` and left the insecure call path
-- reachable by name forever. This is the assertion that it did not survive.
select is(
  to_regprocedure('public.confirm_receipt_extraction(uuid, date, text, bigint, text, text, time without time zone, bigint, bigint)')::text,
  null,
  'THE OLD NINE-ARGUMENT CONFIRMATION NO LONGER EXISTS'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'confirm_receipt_extraction'),
  1,
  'exactly ONE confirmation function exists — no overload was left behind'
);
select ok(
  has_function_privilege('authenticated',
    'public.confirm_receipt_extraction(uuid, date, text, smallint, bigint, text, text, time without time zone, bigint, bigint)',
    'EXECUTE'),
  'the new signature is granted to authenticated'
);
select ok(
  not has_function_privilege('anon',
    'public.confirm_receipt_extraction(uuid, date, text, smallint, bigint, text, text, time without time zone, bigint, bigint)',
    'EXECUTE'),
  'and revoked from anon'
);

-- ---- The four scales confirm ------------------------------------------------
select is(
  pg_temp.confirm((select id from t_ids where label='sub23'),
                  p_currency := 'EUR', p_minor := 2::smallint),
  'CONFIRMED|MANUAL|',
  'EUR with 2 confirms'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub24'),
                  p_currency := 'JPY', p_minor := 0::smallint),
  'CONFIRMED|MANUAL|',
  'JPY with 0 confirms — a currency with NO minor unit is not a special case'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub25'),
                  p_currency := 'KWD', p_minor := 3::smallint),
  'CONFIRMED|MANUAL|',
  'KWD with 3 confirms'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub26'),
                  p_currency := 'CLF', p_minor := 4::smallint),
  'CONFIRMED|MANUAL|',
  'CLF with 4 confirms'
);

-- The stored row reads back with the minor unit the backend resolved, not one the client sent.
select is(
  (select currency_code || '|' || currency_minor_unit || '|' || total_minor
   from public.get_my_receipt_confirmation((select id from t_ids where label='sub24'))),
  'JPY|0|123456',
  'and the confirmation reads back as ¥123456, unscaled, with minor unit 0'
);

-- ---- A wrong scale is REFUSED, with its own stable SQLSTATE ------------------
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           date '2026-07-12', 'JPY', 123456, 2::smallint),
  '22023',
  'JPY with 2 IS REFUSED — the exact silent 100x error this migration exists to stop'
);
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           date '2026-07-12', 'KWD', 123456, 2::smallint),
  '22023',
  'KWD with 2 is refused'
);
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           date '2026-07-12', 'CLF', 123456, 2::smallint),
  '22023',
  'CLF with 2 is refused'
);
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           date '2026-07-12', 'EUR', 123456, 0::smallint),
  '22023',
  'and EUR with 0 is refused just the same — the rule is symmetric, not a JPY special case'
);
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           date '2026-07-12', 'AED', 123456, null::smallint),
  '22023',
  'a NULL minor unit is refused — stating nothing is the same defect as stating the wrong thing'
);

select is(
  (select count(*)::int from public.receipt_confirmations
   where receipt_submission_id = (select id from t_ids where label='sub27')),
  0,
  'and NOTHING was written by any of them'
);

-- ---- 22023 means ONE thing, so Flutter can map it without reading English -----
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           date '2026-07-12', 'ZZZ', 123456, 2::smallint),
  '23514',
  'an UNSUPPORTED currency is still 23514 — resolved before the scale is considered'
);
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           date '2026-07-12', 'JPY', -1, 0::smallint),
  '23514',
  'an INVALID AMOUNT is still 23514'
);
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           date '1999-12-31', 'JPY', 100, 0::smallint),
  '23514',
  'an out-of-range DATE is still 23514'
);
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           null, 'JPY', 100, 0::smallint),
  '23514',
  'a MISSING required value is still 23514'
);

-- An unsupported code paired with a wrong scale reports the currency, not the scale: there is
-- no official minor unit to have disagreed with.
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           date '2026-07-12', 'ZZZ', 100, 9::smallint),
  '23514',
  'an unsupported code with a nonsense scale is an unsupported CODE, unambiguously'
);

-- The other four refusal shapes, each distinguishable from 22023 without parsing text.
select pg_temp.sign_out();
select is(
  pg_temp.confirm_sqlstate((select id from t_ids where label='sub27'),
                           date '2026-07-12', 'JPY', 100, 2::smallint),
  '42501',
  'UNAUTHENTICATED is 42501, raised before the scale is ever examined'
);
select pg_temp.act_as((select id from t_ids where label='other'));
select is(
  (select count(*)::int from public.confirm_receipt_extraction(
     (select id from t_ids where label='sub27'), date '2026-07-12', 'JPY',
     2::smallint, 100)),
  0,
  'ANOTHER member''s receipt is ZERO ROWS, not 22023 — ownership still outranks validation'
);

-- EXTRACTION_IN_PROGRESS is an OUTCOME ROW, so it is not an error code at all.
select pg_temp.sign_out();
update public.receipt_extraction_runtime set mode = 'FAKE' where id;
select pg_temp.act_as((select id from t_ids where label='sales'));
select (select outcome from public.request_receipt_extraction(
          (select id from t_ids where label='sub28'))) as queued_28;
select is(
  pg_temp.confirm((select id from t_ids where label='sub28'),
                  p_currency := 'JPY', p_minor := 2::smallint),
  'EXTRACTION_IN_PROGRESS|-|-',
  'an in-flight attempt still blocks FIRST — a wrong scale is never reported mid-flight'
);

-- ---- The submitter-only and immutability guarantees are untouched -------------
select is(
  (select count(*)::int from public.get_my_receipt_confirmation(
     (select id from t_ids where label='sub24'))),
  1,
  'the submitter reads their own JPY confirmation'
);
select pg_temp.act_as((select id from t_ids where label='other'));
select is(
  (select count(*)::int from public.get_my_receipt_confirmation(
     (select id from t_ids where label='sub24'))),
  0,
  'and another Sales Staff member at the SAME Retailer cannot'
);

select pg_temp.act_as((select id from t_ids where label='sales'));
select is(
  pg_temp.confirm((select id from t_ids where label='sub24'),
                  p_currency := 'JPY', p_minor := 0::smallint, p_total := 1),
  'ALREADY_CONFIRMED|MANUAL|',
  'a JPY confirmation is still immutable through the RPC'
);
select is(
  (select total_minor from public.receipt_confirmations
   where receipt_submission_id = (select id from t_ids where label='sub24')),
  123456::bigint,
  'and the stored total is untouched'
);

select pg_temp.sign_out();
select throws_ok(
  format($q$update public.receipt_confirmations set currency_code = 'EUR' where receipt_submission_id = %L$q$,
         (select id from t_ids where label='sub24')),
  '23514', null, 'nor can its currency be rewritten to one with a different scale');

-- ---- entry_mode and changed_fields are derived exactly as before --------------
-- The minor unit is a FUNCTION of currency_code, so changing the currency produces
-- 'currency_code' and nothing more. A second entry would double-count one act.
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub29')) is not null as e29;
select pg_temp.extract_for((select id from t_ids where label='sales'),
                           (select id from t_ids where label='sub30')) is not null as e30;
select pg_temp.act_as((select id from t_ids where label='sales'));

select is(
  pg_temp.confirm((select id from t_ids where label='sub29')),
  'CONFIRMED|EXTRACTED|',
  'an unchanged AED confirmation is still EXTRACTED with no changed fields'
);
select is(
  pg_temp.confirm((select id from t_ids where label='sub30'),
                  p_currency := 'JPY', p_minor := 0::smallint),
  'CONFIRMED|MIXED|currency_code',
  'switching an AED extraction to JPY reports currency_code ONCE — no currency_minor_unit entry'
);
select ok(
  not exists (
    select 1 from public.receipt_confirmations
    where 'currency_minor_unit' = any(changed_fields)
       or 'minor_unit' = any(changed_fields)),
  'and no confirmation anywhere names a minor unit in changed_fields'
);

-- Nothing about the minor unit reaches the audit trail either.
select pg_temp.sign_out();
select is(
  (select count(*)::int from public.audit_logs
   where action = 'RECEIPT_CONFIRMED'
     and (metadata ? 'currency_minor_unit' or metadata ? 'minor_unit'
          or metadata::text like '%JPY%' or metadata::text like '%KWD%'
          or metadata::text like '%CLF%')),
  0,
  'the audit event carries no minor unit and still no currency'
);

-- Leave the gate as SECTION I found it.
update public.receipt_extraction_runtime set mode = 'DISABLED' where id;

select * from finish();

rollback;
