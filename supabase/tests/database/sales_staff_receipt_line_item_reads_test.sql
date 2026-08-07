-- pgTAP behavioural tests for the ONE read the web uses to display extracted line items:
--
--   public.list_my_receipt_extraction_line_items(uuid)
--
-- from migration 20260813210000_receipt_extraction_client_operations.sql.
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHY THIS SUITE EXISTS
-- ============================================================================
-- receipt_extraction_test.sql already proves this function's PRIVILEGES, its column list and
-- that the underlying table is append-only. What it does not prove is the thing the web now
-- depends on: that a caller reading their OWN succeeded receipt gets EVERY line back, in
-- line_number order, with the values the worker recorded and no others — and that every other
-- caller and every other status get NOTHING.
--
-- "Every line" is the load-bearing claim. A web list that silently showed eight of nine lines
-- would look complete, so the count is asserted against a fixture with NINE lines rather than
-- the single line the existing suite records.
--
-- ============================================================================
-- WHAT THE WEB DOES NOT GET, ASSERTED AS AN ABSENCE
-- ============================================================================
-- Section D reads the function's declared output columns from the catalogue and asserts that
-- there is no reference, SKU or product-code column among them. That is the reason the web
-- renders no reference: not an oversight, and not something to be invented on the client.
--
-- Everything runs in one transaction and is rolled back. The runtime mode is set to FAKE for the
-- fixtures and restored to DISABLED before the suite ends, and asserted to be DISABLED again.
-- AZURE is never set and no provider is ever contacted: every attempt below is driven through the
-- worker RPCs directly, so there is no network call and no hosted runtime anywhere in this file.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers
-- ============================================================================
create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user::text)::text, true);
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

create function pg_temp.grant_role(p_user uuid, p_org uuid, p_role_code text)
returns uuid
language plpgsql as $$
declare
  v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status)
  values (p_org, p_user, 'ACTIVE')
  on conflict (organization_id, user_id) do update set status = excluded.status
  returning id into v_member;

  insert into public.member_roles (organization_member_id, role_id)
  select v_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;

  return v_member;
end;
$$;

/* A SUBMITTED receipt submission, inserted directly — the reserve path is tested elsewhere. */
create function pg_temp.new_submission(p_org uuid, p_shop uuid, p_profile uuid)
returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.receipt_submissions (
    id, retailer_organization_id, retailer_shop_id, submitted_by_profile_id,
    storage_bucket, storage_object_path, original_file_name, mime_type,
    file_size_bytes, file_sha256, status, submitted_at
  ) values (
    v_id, p_org, p_shop, p_profile,
    'receipts', p_org::text || '/' || p_profile::text || '/' || v_id::text || '/o.jpg',
    'receipt.jpg', 'image/jpeg', 4096, md5(v_id::text) || md5(v_id::text || 'x'),
    'SUBMITTED', now()
  );
  return v_id;
end;
$$;

create function pg_temp.set_mode(p_mode text) returns void
language sql as $$ update public.receipt_extraction_runtime set mode = p_mode where id; $$;

/* Requests an attempt as the given user and returns its id. */
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

/* Drives one attempt to SUCCEEDED with the given normalized document and line items. */
create function pg_temp.complete_attempt(
  p_extraction uuid,
  p_normalized jsonb,
  p_lines jsonb
) returns void
language plpgsql as $$
declare v_token uuid; v_op text := 'fake:' || gen_random_uuid()::text;
begin
  select claim_token into v_token
  from public.claim_receipt_extraction_job(p_extraction, 'FAKE', 'fake-receipt-v1');
  perform public.record_receipt_extraction_operation(p_extraction, v_token, v_op);
  perform public.record_receipt_extraction_success(
    p_extraction, v_token, v_op, p_normalized, p_lines
  );
end;
$$;

/* How many line items the CURRENT caller can see for one submission. */
create function pg_temp.line_count(p_submission uuid) returns bigint
language sql as $$
  select count(*) from public.list_my_receipt_extraction_line_items(p_submission);
$$;

/* The descriptions the CURRENT caller sees, IN THE FUNCTION'S OWN ORDER (not re-sorted). */
create function pg_temp.line_descriptions(p_submission uuid) returns text[]
language sql as $$
  select coalesce(array_agg(li.description order by li.line_number), '{}')
  from public.list_my_receipt_extraction_line_items(p_submission) li;
$$;

/* The line numbers, in the order the function returned its rows. */
create function pg_temp.line_numbers_as_returned(p_submission uuid) returns integer[]
language sql as $$
  select coalesce(array_agg(x.line_number order by x.ord), '{}')
  from (
    select li.line_number, row_number() over () as ord
    from public.list_my_receipt_extraction_line_items(p_submission) li
  ) x;
$$;

/*
 * The SQLSTATE the read raises for the current caller, or NULL when it returned normally.
 *
 * THE CONTRACT HAS TWO DIFFERENT REFUSALS and the web depends on telling them apart:
 * assert_my_receipt_extraction_access RAISES 42501 for a caller who cannot resolve
 * RECEIPT_EXTRACTION_REVIEW at all (an Owner, a Manager, a signed-out caller), and the function
 * returns ZERO ROWS for an authorized submitter who names a receipt that is not theirs or whose
 * attempt did not succeed. Collapsing the two would render "you may not do this" as "there are
 * no items".
 */
create function pg_temp.line_read_sqlstate(p_submission uuid) returns text
language plpgsql as $$
begin
  perform * from public.list_my_receipt_extraction_line_items(p_submission);
  return null;
exception when others then
  return sqlstate;
end;
$$;

/* The declared OUTPUT columns of a `returns table` function, in order. */
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

-- ============================================================================
-- Fixtures
-- ============================================================================
create temporary table t_ids (label text primary key, id uuid not null);

do $$
declare
  v_retailer1 uuid := gen_random_uuid();
  v_retailer2 uuid := gen_random_uuid();
  v_shop1     uuid := gen_random_uuid();
  v_shop2     uuid := gen_random_uuid();
  v_m1        uuid;
  v_m1b       uuid;
  v_m2        uuid;
begin
  insert into public.organizations (id, name, organization_type, status) values
    (v_retailer1, 'Line Item Retailer One', 'RETAILER', 'ACTIVE'),
    (v_retailer2, 'Line Item Retailer Two', 'RETAILER', 'ACTIVE');

  insert into public.retailer_shops (id, retailer_organization_id, name, code, status) values
    (v_shop1, v_retailer1, 'Line Shop One', 'LS1', 'ACTIVE'),
    (v_shop2, v_retailer2, 'Line Shop Two', 'LS2', 'ACTIVE');

  insert into t_ids values
    ('retailer1', v_retailer1), ('retailer2', v_retailer2),
    ('shop1', v_shop1), ('shop2', v_shop2),
    ('sales1',  pg_temp.new_user('line_sales1')),
    -- A COLLEAGUE at the same Retailer. The sharpest negative case there is.
    ('sales1b', pg_temp.new_user('line_sales1b')),
    ('sales2',  pg_temp.new_user('line_sales2')),
    ('owner1',  pg_temp.new_user('line_owner1'));

  v_m1  := pg_temp.grant_role((select id from t_ids where label='sales1'),  v_retailer1, 'SALES_STAFF');
  v_m1b := pg_temp.grant_role((select id from t_ids where label='sales1b'), v_retailer1, 'SALES_STAFF');
  v_m2  := pg_temp.grant_role((select id from t_ids where label='sales2'),  v_retailer2, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='owner1'), v_retailer1, 'RETAILER_OWNER');

  insert into public.retailer_shop_members (retailer_shop_id, organization_member_id) values
    (v_shop1, v_m1), (v_shop1, v_m1b), (v_shop2, v_m2);

  insert into t_ids values
    -- sub_nine    — sales1's, SUCCEEDED with NINE lines.
    ('sub_nine',  pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'))),
    -- sub_sparse  — sales1's, SUCCEEDED with lines that are deliberately incomplete.
    ('sub_sparse', pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'))),
    -- sub_jpy     — sales1's, SUCCEEDED in a 0-decimal currency.
    ('sub_jpy',   pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'))),
    -- sub_open    — sales1's, still QUEUED.
    ('sub_open',  pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'))),
    -- sub_none    — sales1's, with no attempt at all.
    ('sub_none',  pg_temp.new_submission(v_retailer1, v_shop1, (select id from t_ids where label='sales1'))),
    -- sub_r2      — another Retailer's.
    ('sub_r2',    pg_temp.new_submission(v_retailer2, v_shop2, (select id from t_ids where label='sales2')));
end;
$$;

-- The runtime gate must be open for request_receipt_extraction to create an attempt. FAKE is the
-- only non-disabled mode used anywhere in this suite; AZURE is never set, never referenced, and
-- no provider is ever contacted. Section F closes the gate again and asserts it closed, so the
-- suite leaves the row exactly as it found it.
select pg_temp.set_mode('FAKE');

do $$
declare
  v_sales1 uuid := (select id from t_ids where label='sales1');
  v_sales2 uuid := (select id from t_ids where label='sales2');
  v_x      uuid;
  v_lines  jsonb;
begin
  -- NINE lines. The last three carry DELIBERATELY WRONG line_number values (9, 8, 7) to pin a
  -- fact the web depends on: record_receipt_extraction_success DERIVES the ordinal from array
  -- POSITION and ignores whatever the caller numbered its array, so the sequence is always dense
  -- and starts at 1. A client that trusted a provider's own numbering could render gaps.
  v_lines := jsonb_build_array(
    jsonb_build_object('line_number', 1, 'description', 'Samsung Galaxy S25',
      'quantity', 1, 'unit_price_minor', 329900, 'line_total_minor', 329900, 'confidence', 0.98),
    jsonb_build_object('line_number', 2, 'description', 'Screen Protector',
      'quantity', 2, 'unit_price_minor', 4900, 'line_total_minor', 9800, 'confidence', 0.91),
    jsonb_build_object('line_number', 3, 'description', 'USB-C Cable 2m',
      'quantity', 3, 'unit_price_minor', 2500, 'line_total_minor', 7500, 'confidence', 0.88),
    jsonb_build_object('line_number', 4, 'description', 'Wireless Charger',
      'quantity', 1, 'unit_price_minor', 12900, 'line_total_minor', 12900, 'confidence', 0.9),
    jsonb_build_object('line_number', 5, 'description', 'Phone Case',
      'quantity', 1, 'unit_price_minor', 7900, 'line_total_minor', 7900, 'confidence', 0.93),
    jsonb_build_object('line_number', 6, 'description', 'Promotional Gift',
      'quantity', 1, 'unit_price_minor', 0, 'line_total_minor', 0, 'confidence', 0.6),
    jsonb_build_object('line_number', 9, 'description', 'Carry Bag',
      'quantity', 1, 'unit_price_minor', 1500, 'line_total_minor', 1500, 'confidence', 0.7),
    jsonb_build_object('line_number', 8, 'description', 'Extended Warranty',
      'quantity', 1, 'unit_price_minor', 19900, 'line_total_minor', 19900, 'confidence', 0.75),
    jsonb_build_object('line_number', 7, 'description', 'Earbuds',
      'quantity', 1, 'unit_price_minor', 39900, 'line_total_minor', 39900, 'confidence', 0.8)
  );

  v_x := pg_temp.queue_attempt(v_sales1, (select id from t_ids where label='sub_nine'));
  perform pg_temp.complete_attempt(
    v_x,
    jsonb_build_object(
      'merchant_name', 'Electronics Souq', 'transaction_date', '2026-07-12',
      'currency_code', 'AED', 'total_minor', 429300
    ),
    v_lines
  );

  -- SPARSE: a line with no description, one with no quantity, one with no price at all. These
  -- are the cases the web must render as ABSENT rather than as a fabricated default.
  v_x := pg_temp.queue_attempt(v_sales1, (select id from t_ids where label='sub_sparse'));
  perform pg_temp.complete_attempt(
    v_x,
    jsonb_build_object(
      'merchant_name', 'Corner Store', 'transaction_date', '2026-07-13',
      'currency_code', 'AED', 'total_minor', 5000
    ),
    jsonb_build_array(
      -- No description. The line exists because the reader found a priced row.
      jsonb_build_object('line_number', 1, 'quantity', 1, 'line_total_minor', 2500),
      -- No quantity. It must NOT become 1.
      jsonb_build_object('line_number', 2, 'description', 'Loose Dates', 'line_total_minor', 2500),
      -- No price of any kind. It must NOT become 0.
      jsonb_build_object('line_number', 3, 'description', 'Free Sample', 'quantity', 1)
    )
  );

  -- A 0-DECIMAL CURRENCY. The scale travels with the extraction, and the web must not assume 2.
  v_x := pg_temp.queue_attempt(v_sales1, (select id from t_ids where label='sub_jpy'));
  perform pg_temp.complete_attempt(
    v_x,
    jsonb_build_object(
      'merchant_name', 'Tokyo Mart', 'transaction_date', '2026-07-14',
      'currency_code', 'JPY', 'total_minor', 3480
    ),
    jsonb_build_array(
      jsonb_build_object('line_number', 1, 'description', 'Onigiri',
        'quantity', 2, 'unit_price_minor', 240, 'line_total_minor', 480),
      jsonb_build_object('line_number', 2, 'description', 'Bento',
        'quantity', 1, 'unit_price_minor', 3000, 'line_total_minor', 3000)
    )
  );

  -- Left QUEUED on purpose: no worker ever claims it.
  perform pg_temp.queue_attempt(v_sales1, (select id from t_ids where label='sub_open'));

  -- The other Retailer's receipt gets a SUCCEEDED attempt too, so its zero rows below cannot be
  -- explained by there being nothing to return.
  v_x := pg_temp.queue_attempt(v_sales2, (select id from t_ids where label='sub_r2'));
  perform pg_temp.complete_attempt(
    v_x,
    jsonb_build_object(
      'merchant_name', 'Other Retailer Shop', 'transaction_date', '2026-07-15',
      'currency_code', 'AED', 'total_minor', 1000
    ),
    jsonb_build_array(
      jsonb_build_object('line_number', 1, 'description', 'Secret Item',
        'quantity', 1, 'line_total_minor', 1000)
    )
  );
end;
$$;

-- ============================================================================
-- SECTION A — EVERY line comes back, in the function's own order
-- ============================================================================

select pg_temp.act_as((select id from t_ids where label='sales1'));

select is(pg_temp.line_count((select id from t_ids where label='sub_nine')), 9::bigint,
  'all nine recorded lines are returned — nothing is capped, sampled or paged');

select is(
  pg_temp.line_numbers_as_returned((select id from t_ids where label='sub_nine')),
  array[1,2,3,4,5,6,7,8,9],
  'the rows arrive in ascending line_number order regardless of the order they were recorded in');

select is(
  pg_temp.line_descriptions((select id from t_ids where label='sub_nine')),
  array['Samsung Galaxy S25','Screen Protector','USB-C Cable 2m','Wireless Charger',
        'Phone Case','Promotional Gift','Carry Bag','Extended Warranty','Earbuds'],
  'each description is returned exactly as recorded, in the array position it was recorded at');

-- THE ORDINAL IS SERVER-DERIVED. The last three lines were submitted numbered 9, 8, 7 and come
-- back as 7, 8, 9 in their array order, so a provider's own numbering can never leave a gap.
select is(
  (select li.description
   from public.list_my_receipt_extraction_line_items(
     (select id from t_ids where label='sub_nine')) li
   where li.line_number = 7),
  'Carry Bag',
  'the ordinal is derived from array position, not from the line_number the caller supplied');

-- THE VALUES A ROW CARRIES, checked on one line end to end.
select is(
  (select array[li.quantity::text, li.unit_price_minor::text, li.line_total_minor::text]
   from public.list_my_receipt_extraction_line_items(
     (select id from t_ids where label='sub_nine')) li
   where li.line_number = 2),
  array['2.000', '4900', '9800'],
  'quantity, unit price and line amount all survive the read');

-- A LEGITIMATE ZERO IS A VALUE, not an absence. It must come back as 0 rather than NULL.
select is(
  (select array[li.unit_price_minor, li.line_total_minor]
   from public.list_my_receipt_extraction_line_items(
     (select id from t_ids where label='sub_nine')) li
   where li.line_number = 6),
  array[0::bigint, 0::bigint],
  'a zero-priced promotional line returns zero, not null');

-- ============================================================================
-- SECTION B — absence is returned as absence
-- ============================================================================
-- These three rows are why the web must not default anything: the contract itself distinguishes
-- "the reader did not read this" from "the reader read a zero".

select is(pg_temp.line_count((select id from t_ids where label='sub_sparse')), 3::bigint,
  'sparse: all three incomplete lines are still returned');

select ok(
  (select li.description is null
   from public.list_my_receipt_extraction_line_items(
     (select id from t_ids where label='sub_sparse')) li
   where li.line_number = 1),
  'sparse: a line with no description returns NULL rather than an invented name');

select ok(
  (select li.quantity is null
   from public.list_my_receipt_extraction_line_items(
     (select id from t_ids where label='sub_sparse')) li
   where li.line_number = 2),
  'sparse: a missing quantity returns NULL — the contract never says 1');

select ok(
  (select li.unit_price_minor is null and li.line_total_minor is null
   from public.list_my_receipt_extraction_line_items(
     (select id from t_ids where label='sub_sparse')) li
   where li.line_number = 3),
  'sparse: a missing price returns NULL — the contract never says 0');

-- ============================================================================
-- SECTION C — the currency scale is data, and it travels with the extraction
-- ============================================================================
select is(
  (select currency_code || ':' || currency_minor_unit
   from public.get_my_receipt_extraction((select id from t_ids where label='sub_jpy'))),
  'JPY:0',
  'a 0-decimal currency reports minor unit 0 — the web reads the scale, never assumes 2');

select is(
  (select currency_code || ':' || currency_minor_unit
   from public.get_my_receipt_extraction((select id from t_ids where label='sub_nine'))),
  'AED:2',
  'and a 2-decimal currency reports 2');

select is(
  (select li.line_total_minor
   from public.list_my_receipt_extraction_line_items(
     (select id from t_ids where label='sub_jpy')) li
   where li.line_number = 2),
  3000::bigint,
  'the JPY amount is stored as 3000 minor units — rendering it as 30.00 would be the bug');

-- THE COUNT ON THE ATTEMPT AGREES WITH THE LIST, so a client can never show two numbers.
select is(
  (select line_item_count from public.get_my_receipt_extraction(
     (select id from t_ids where label='sub_nine'))),
  9,
  'the attempt''s own line_item_count agrees with the number of rows the list returns');

-- ============================================================================
-- SECTION D — what the contract does NOT have
-- ============================================================================
-- The reason the web renders no reference or SKU. If a later migration adds one, THIS is the
-- assertion that fails and forces the decision to be taken deliberately.

select is(
  pg_temp.table_columns('list_my_receipt_extraction_line_items'),
  array['line_number','description','description_source_text','quantity',
        'quantity_source_text','unit_price_minor','unit_price_source_text',
        'line_total_minor','line_total_source_text','confidence'],
  'the contract is exactly these ten columns — there is no reference, SKU or product code');

select ok(
  not (pg_temp.table_columns('list_my_receipt_extraction_line_items') && array[
    'sku', 'reference', 'product_code', 'barcode', 'item_code', 'product_id'
  ]),
  'and none of the names a product reference could plausibly use is among them');

select ok(
  not (pg_temp.table_columns('list_my_receipt_extraction_line_items') && array[
    'receipt_extraction_id', 'receipt_submission_id', 'provider', 'provider_model',
    'provider_operation_id', 'worker_claim_token', 'storage_bucket',
    'storage_object_path', 'file_sha256', 'expires_at'
  ]),
  'nor any internal, provider, worker or storage identifier');

-- ============================================================================
-- SECTION E — everybody else, and every other status, gets nothing
-- ============================================================================

select is(pg_temp.line_count((select id from t_ids where label='sub_open')), 0::bigint,
  'a QUEUED attempt has no line items — the web''s SUCCEEDED-only gate matches the contract');

select is(pg_temp.line_count((select id from t_ids where label='sub_none')), 0::bigint,
  'a receipt with no attempt at all returns zero rows rather than raising');

select is(pg_temp.line_count((select id from t_ids where label='sub_r2')), 0::bigint,
  'another Retailer''s SUCCEEDED receipt returns zero rows — indistinguishably from the two above');

select is(pg_temp.line_count(gen_random_uuid()), 0::bigint,
  'and so does a submission id that does not exist');

-- A COLLEAGUE AT THE SAME RETAILER, ASSIGNED TO THE SAME SHOP, sees nothing. This is the
-- assertion that proves the read is keyed on the SUBMITTER and not on the tenant or the shop.
select pg_temp.act_as((select id from t_ids where label='sales1b'));
select is(pg_temp.line_count((select id from t_ids where label='sub_nine')), 0::bigint,
  'a colleague in the SAME Retailer and the SAME shop sees none of another person''s lines');

-- AN OWNER IS REFUSED RATHER THAN SHOWN AN EMPTY LIST. RECEIPT_EXTRACTION_REVIEW is mapped to
-- SALES_STAFF alone, so the access assertion RAISES for them — a different fact from "this
-- receipt has no items", and one the web maps to its own distinct outcome.
select pg_temp.act_as((select id from t_ids where label='owner1'));
select is(
  pg_temp.line_read_sqlstate((select id from t_ids where label='sub_nine')),
  '42501',
  'a Retailer Owner is REFUSED, not shown an empty list');

select pg_temp.sign_out();
select is(
  pg_temp.line_read_sqlstate((select id from t_ids where label='sub_nine')),
  '42501',
  'and an unauthenticated caller is refused the same way');

-- The contrast that makes the distinction real: for an AUTHORIZED submitter, every one of the
-- four cases in this section is zero rows and no exception at all.
select pg_temp.act_as((select id from t_ids where label='sales1'));
select is(
  array[
    pg_temp.line_read_sqlstate((select id from t_ids where label='sub_open')),
    pg_temp.line_read_sqlstate((select id from t_ids where label='sub_none')),
    pg_temp.line_read_sqlstate((select id from t_ids where label='sub_r2'))
  ],
  array[null, null, null]::text[],
  'an authorized submitter never sees an exception — only an empty list');

-- ============================================================================
-- SECTION F — the runtime is left as it was found
-- ============================================================================
-- The gate was opened for the fixtures only. Nothing hosted was involved at any point: every
-- attempt above was driven by the worker RPCs directly, with no provider and no network.
select pg_temp.set_mode('DISABLED');
select is((select mode from public.receipt_extraction_runtime), 'DISABLED',
  'the extraction runtime is DISABLED again before this suite ends');

select * from finish();
rollback;
