-- Migration: verified_sale_headers
-- Purpose: Phase 1D-A. The AUTHORITATIVE, IMMUTABLE sale header — the first record
--          in this system that says "this really was a sale", finalized by a Claim
--          Reviewer from an immutable Sales Staff proposal.
--
--   1 permission   RECEIPT_SALE_HEADER_FINALIZE   -> CLAIM_REVIEWER only
--   1 table        public.verified_sales          (append-only)
--   1 internal     inspect_sale_instant           (time classification + candidates)
--   1 overload     resolve_sale_instant(uuid, date, time, text)
--   2 read RPCs    get_claim_receipt_sale_context, get_verified_sale_header
--   1 write RPC    finalize_claim_receipt_sale_header
--   3 guards       change guard, truncate guard, insert assertion
--   5 indexes
--
-- ============================================================================
-- TWO RECORDS, TWO AUTHORS, TWO MEANINGS
-- ============================================================================
-- public.receipt_confirmations is what SALES STAFF say the receipt says. It is
-- already immutable, already one-per-receipt, already tenant-asserted. This
-- migration does not touch it, does not re-own it and does not re-open it.
--
-- public.verified_sales is what a CLAIM REVIEWER, independently, accepted as
-- authoritative. Separating them is the whole point: the proposal is evidence,
-- the sale is a finding, and a finding that could be edited by the person who
-- proposed it is not a finding.
--
-- In this first release the reviewer ACCEPTS or DECLINES. There is no editing,
-- so every financial value in verified_sales is copied verbatim from the
-- confirmation and the insert assertion proves it byte for byte.
--
-- ============================================================================
-- WHY THERE IS NO SELLER COLUMN
-- ============================================================================
-- The seller is public.receipt_submissions.submitted_by_profile_id: NOT NULL, a
-- RESTRICT foreign key to profiles, and explicitly frozen by
-- receipt_submissions_assert_immutable_on_update, whose BEFORE UPDATE OF list
-- names submitted_by_profile_id, retailer_organization_id and retailer_shop_id.
-- That lineage is stable and unambiguous, so copying a person id into this table
-- would create a second answer to a question that already has one — and a second
-- answer is exactly what drifts.
--
-- ============================================================================
-- TIME IS RESOLVED ONCE, HERE, FOREVER
-- ============================================================================
-- A shop's timezone can be corrected tomorrow. A sale that already happened must
-- not move when it is. So sale_at, timezone_name, sale_time_precision and
-- dst_ambiguity_choice are FROZEN into the row at finalization and are never
-- re-derived. Campaign evaluation, whenever it arrives, reads the stored instant.
--
-- PostgreSQL resolves an ambiguous local time SILENTLY, and it picks the LATER of
-- the two instants. For a fall-back hour that is a one-hour error in a financial
-- record, chosen by nobody. This migration refuses to guess: an ambiguous local
-- time requires an explicit FIRST or SECOND, and the word chosen is persisted.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
-- No product, quantity or line item (Phase 1D-B). No campaign evaluation. No
-- reward, coin, ledger, balance or payout. No Web UI. No change to
-- receipt_confirmations, receipt_review_decisions or receipt_qualification_events.
--
-- Idempotency posture: plain CREATE for every new object (no CREATE OR REPLACE),
--   so a conflicting existing object FAILS rather than being silently replaced.
--   The existing three-argument resolve_sale_instant is NOT modified — the new
--   behaviour is an additive overload, so every Phase 0 caller and test keeps its
--   exact contract. Permission seeding uses the established ON CONFLICT upsert.
--   No existing row is modified or deleted. No dynamic SQL. Every reference is
--   schema-qualified because the functions run with an EMPTY search_path.
--
-- Dependencies: 20260716125559 (RBAC), 20260716130351 (audit_logs),
--   20260812210000 (receipt_submissions), 20260817210000 (resolve_sale_instant),
--   20260818210000 (resolve_claim_reviewer_organization), 20260819090000
--   (receipt_review_decisions, receipt_confirmations), 20260820090000
--   (receipt_qualification_is_excluded).


-- ============================================================================
-- 1. THE PERMISSION
-- ============================================================================
-- Fail loud if the role is missing. A silent no-op would create the permission
-- unreachable, and the first symptom would be a reviewer denied with no reason.
do $$
begin
  if not exists (select 1 from public.roles where code = 'CLAIM_REVIEWER') then
    raise exception 'CLAIM_REVIEWER role is missing; migration 20260818210000 must run first';
  end if;
end;
$$;

insert into public.permissions (code, name, description, module)
values
  (
    'RECEIPT_SALE_HEADER_FINALIZE',
    'Finalize an authoritative sale header',
    'Permits a Claim Reviewer to finalize an immutable authoritative sale header from a verified, confirmed and non-excluded receipt. Grants no ability to edit the staff transaction proposal, evaluate a campaign, or create a product line, reward, coin, balance or payout.',
    'CLAIM_REVIEW'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- CLAIM_REVIEWER and nothing else. Not Sales Staff: the whole control is that the
-- person who proposed the figures is not the person who makes them authoritative.
-- Not Vendor Super Admin and not Finance Admin: finalization is a claim-review
-- judgement about evidence somebody looked at, not an administrative or money
-- operation.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'RECEIPT_SALE_HEADER_FINALIZE'
where r.code = 'CLAIM_REVIEWER'
on conflict (role_id, permission_id) do nothing;


-- ============================================================================
-- 2. TIME CLASSIFICATION — THE ONE PLACE DST IS DECIDED
-- ============================================================================
-- Every new caller in this migration asks this function what a local sale time
-- MEANS, so the four-argument resolver, the read context and the finalization RPC
-- can never disagree with each other about the same instant.
--
-- The existing three-argument resolve_sale_instant is deliberately left untouched:
-- it is the Phase 0 contract, it has its own tests, and rewriting it to delegate
-- would risk a behaviour change for zero benefit here.
--
-- Returns NULL for an unknown shop. It does not raise, because raising a
-- distinguishable error is how a helper becomes an existence oracle; the callers
-- decide what an unknown shop means in their own contract.
--
-- NOT granted to any browser role.
-- A named composite so every caller declares one variable of one type and cannot
-- drift out of column order. A function returning TABLE(...) has no %rowtype, so
-- this is what makes `v public.sale_instant_inspection` possible at all.
create type public.sale_instant_inspection as (
  time_status          text,
  timezone_name        text,
  sale_time_precision  text,
  sale_at              timestamptz,
  first_sale_at        timestamptz,
  second_sale_at       timestamptz
);

create function public.inspect_sale_instant(
  p_retailer_shop_id  uuid,
  p_transaction_date  date,
  p_transaction_time  time without time zone default null
)
returns public.sale_instant_inspection
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v           public.sale_instant_inspection;
  v_shop      uuid;
  v_tz        text;
  v_time      time without time zone;
  v_precision text;
  v_local     timestamp without time zone;
  v_base      timestamptz;
  v_delta     interval;
  v_candidate timestamptz;
  v_valid     timestamptz[] := array[]::timestamptz[];
begin
  if p_transaction_date is null then
    return null;
  end if;

  select s.id, s.timezone_name into v_shop, v_tz
  from public.retailer_shops s
  where s.id = p_retailer_shop_id;

  -- NULL, not an error: a distinguishable failure here is how a helper becomes an
  -- existence oracle. Callers decide what an unknown shop means.
  if v_shop is null then
    return null;
  end if;

  -- Precision is a property of what was PRINTED, so it is decided before any zone
  -- question and is unaffected by whether that zone is known.
  if p_transaction_time is null then
    v_time      := time '12:00';
    v_precision := 'DATE_ONLY';
  else
    v_time      := date_trunc('minute', p_transaction_time::interval)::time without time zone;
    v_precision := 'MINUTE';
  end if;

  -- NO FALLBACK ZONE. Not UTC, not the server's, not the session's. Each would
  -- produce an instant that looks authoritative and is silently wrong for the
  -- place the sale happened.
  if v_tz is null then
    v.time_status := 'NO_TIMEZONE';
    v.sale_time_precision := v_precision;
    return v;
  end if;

  v_local := p_transaction_date + v_time;
  v_base  := v_local at time zone v_tz;

  -- NONEXISTENT: the instant does not read back as the local time we asked for,
  -- because that local time was skipped by a spring-forward transition.
  if (v_base at time zone v_tz) is distinct from v_local then
    v.time_status := 'NONEXISTENT';
    v.timezone_name := v_tz;
    v.sale_time_precision := v_precision;
    return v;
  end if;

  -- Enumerate every UTC instant that reads back as this local time. Ordinary times
  -- yield exactly one; a fall-back hour yields two. The probe set matches the one
  -- the deployed three-argument resolver already uses, so both agree about which
  -- transitions count: 1 hour (most zones), 30 minutes (Lord Howe) and 2 hours
  -- (historical double summer time).
  v_valid := array[v_base];
  foreach v_delta in array array[
    interval '30 minutes',
    interval '1 hour',
    interval '2 hours'
  ] loop
    foreach v_candidate in array array[v_base - v_delta, v_base + v_delta] loop
      if (v_candidate at time zone v_tz) = v_local
         and not (v_candidate = any (v_valid)) then
        v_valid := v_valid || v_candidate;
      end if;
    end loop;
  end loop;

  if array_length(v_valid, 1) = 1 then
    v.time_status := 'OK';
    v.timezone_name := v_tz;
    v.sale_time_precision := v_precision;
    v.sale_at := v_base;
    return v;
  end if;

  -- AMBIGUOUS. FIRST is the chronologically earlier instant (still on the old,
  -- larger offset); SECOND is the later one. Never PostgreSQL's default pick.
  v.time_status := 'AMBIGUOUS';
  v.timezone_name := v_tz;
  v.sale_time_precision := v_precision;
  select min(x), max(x) into v.first_sale_at, v.second_sale_at from unnest(v_valid) x;
  return v;
end;
$$;

revoke all     on function public.inspect_sale_instant(uuid, date, time without time zone) from public;
revoke execute on function public.inspect_sale_instant(uuid, date, time without time zone) from anon;
revoke execute on function public.inspect_sale_instant(uuid, date, time without time zone) from authenticated;

comment on function public.inspect_sale_instant(uuid, date, time without time zone) is
  'Internal. Classifies a shop-local sale time as OK, AMBIGUOUS, NONEXISTENT or NO_TIMEZONE and returns the valid UTC candidates. NULL for an unknown shop. Not callable by any browser role.';


-- ============================================================================
-- 3. THE FOUR-ARGUMENT RESOLVER
-- ============================================================================
-- Same public shape as the Phase 0 resolver, plus the one thing Phase 1D-A needs:
-- a way to say WHICH of two ambiguous instants a human meant.
--
-- The three-argument function keeps its exact signature, body, grants and
-- behaviour. This is an overload, not a replacement.
create function public.resolve_sale_instant(
  p_retailer_shop_id      uuid,
  p_transaction_date      date,
  p_transaction_time      time without time zone,
  p_dst_ambiguity_choice  text
)
returns table (
  sale_at             timestamptz,
  timezone_name       text,
  sale_time_precision text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v public.sale_instant_inspection;
begin
  if p_transaction_date is null then
    raise exception 'A sale instant requires a transaction date'
      using errcode = 'check_violation';
  end if;

  if p_transaction_date < date '2000-01-01' then
    raise exception 'That transaction date could not be accepted'
      using errcode = 'check_violation';
  end if;

  if p_dst_ambiguity_choice is not null
     and p_dst_ambiguity_choice not in ('FIRST', 'SECOND') then
    raise exception 'A daylight-saving choice must be FIRST or SECOND'
      using errcode = 'invalid_parameter_value';
  end if;

  v := public.inspect_sale_instant(p_retailer_shop_id, p_transaction_date, p_transaction_time);

  -- Unknown and foreign shops are indistinguishable, exactly as in the Phase 0
  -- resolver, so this cannot be used to discover which shop ids exist.
  if v.time_status is null then
    raise exception 'Not authorized to resolve a sale instant for that shop'
      using errcode = 'insufficient_privilege';
  end if;

  if v.time_status = 'NO_TIMEZONE' then
    raise exception 'That shop has no time zone recorded, so a sale instant cannot be resolved'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- A choice cannot rescue a local time that never existed. Refused before the
  -- choice is even considered, so no caller can believe FIRST "fixed" it.
  if v.time_status = 'NONEXISTENT' then
    raise exception 'That local sale time does not exist in the shop time zone'
      using errcode = 'invalid_datetime_format';
  end if;

  if v.time_status = 'OK' then
    -- An UNNECESSARY choice is refused rather than ignored. Accepting it would let
    -- a stale page assert an interpretation of a time that has only one, and the
    -- next reader could not tell the assertion was meaningless.
    if p_dst_ambiguity_choice is not null then
      raise exception 'That local sale time is not ambiguous, so a daylight-saving choice must not be supplied'
        using errcode = 'invalid_parameter_value';
    end if;
    return query select v.sale_at, v.timezone_name, v.sale_time_precision;
    return;
  end if;

  -- AMBIGUOUS from here.
  if p_dst_ambiguity_choice is null then
    raise exception 'That local sale time is ambiguous in the shop time zone'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  select case p_dst_ambiguity_choice
           when 'FIRST'  then v.first_sale_at
           else               v.second_sale_at
         end,
         v.timezone_name,
         v.sale_time_precision;
end;
$$;

revoke all     on function public.resolve_sale_instant(uuid, date, time without time zone, text) from public;
revoke execute on function public.resolve_sale_instant(uuid, date, time without time zone, text) from anon;
revoke execute on function public.resolve_sale_instant(uuid, date, time without time zone, text) from authenticated;

comment on function public.resolve_sale_instant(uuid, date, time without time zone, text) is
  'Internal. As the three-argument resolver, plus an explicit FIRST/SECOND choice for an ambiguous local time. Refuses an unnecessary choice. Not callable by any browser role.';


-- ============================================================================
-- 4. THE AUTHORITATIVE SALE HEADER
-- ============================================================================
create table public.verified_sales (
  id                          uuid        primary key default gen_random_uuid(),

  -- LINEAGE. Three RESTRICT edges back to the immutable evidence this finding
  -- rests on. A financial record must never lose its provenance because a parent
  -- row was removed.
  receipt_submission_id       uuid        not null
                                references public.receipt_submissions (id) on delete restrict,
  receipt_review_decision_id  uuid        not null
                                references public.receipt_review_decisions (id) on delete restrict,
  receipt_confirmation_id     uuid        not null
                                references public.receipt_confirmations (id) on delete restrict,

  vendor_organization_id      uuid        not null
                                references public.organizations (id) on delete restrict,
  retailer_organization_id    uuid        not null
                                references public.organizations (id) on delete restrict,
  retailer_shop_id            uuid        not null
                                references public.retailer_shops (id) on delete restrict,
  finalized_by_profile_id     uuid        not null
                                references public.profiles (id) on delete restrict,

  -- WHAT THE RECEIPT SAID (copied verbatim from the confirmation).
  transaction_date            date        not null,
  transaction_time            time without time zone null,

  -- WHAT IT MEANS, FROZEN. Never re-derived from the shop's current zone.
  sale_at                     timestamptz not null,
  timezone_name               text        not null,
  sale_time_precision         text        not null,
  dst_ambiguity_choice        text        null,

  currency_code               text        not null
                                references public.iso_currency_codes (code) on delete restrict,
  total_minor                 bigint      not null,
  subtotal_minor              bigint      null,
  tax_total_minor             bigint      null,
  merchant_name               text        null,
  document_number             text        null,

  finalized_at                timestamptz not null default now(),
  created_at                  timestamptz not null default now(),

  -- ---- time vocabulary and shape ----------------------------------------
  constraint verified_sales_precision_allowed
    check (sale_time_precision in ('DATE_ONLY', 'MINUTE')),

  -- Biconditional, so neither half can drift: a sale with no printed time is
  -- DATE_ONLY and a sale with one is MINUTE. There is deliberately no DATE_TIME.
  constraint verified_sales_precision_shape
    check ((sale_time_precision = 'DATE_ONLY') = (transaction_time is null)),

  constraint verified_sales_dst_choice_allowed
    check (dst_ambiguity_choice is null or dst_ambiguity_choice in ('FIRST', 'SECOND')),

  -- A date-only sale resolves at local noon, which no transition has ever made
  -- ambiguous, so a choice there is always meaningless. The table can enforce
  -- THAT much structurally; whether a given MINUTE time was actually ambiguous is
  -- a zone question the table cannot answer, so the insert assertion and the
  -- finalization RPC enforce the semantic half.
  constraint verified_sales_date_only_has_no_choice
    check (sale_time_precision <> 'DATE_ONLY' or dst_ambiguity_choice is null),

  -- ---- money, mirroring receipt_confirmations exactly --------------------
  constraint verified_sales_total_range
    check (total_minor >= 0 and total_minor <= 1000000000000),
  constraint verified_sales_subtotal_range
    check (subtotal_minor is null or (subtotal_minor >= 0 and subtotal_minor <= 1000000000000)),
  constraint verified_sales_tax_range
    check (tax_total_minor is null or (tax_total_minor >= 0 and tax_total_minor <= 1000000000000)),
  -- Deliberately NO subtotal + tax = total rule: rounding, discounts and
  -- multi-rate tax legitimately break it, and a false refusal blocks a real sale.

  -- ---- text, mirroring receipt_confirmations exactly ---------------------
  constraint verified_sales_merchant_name_shape
    check (
      merchant_name is null
      or (merchant_name = btrim(merchant_name) and length(merchant_name) between 1 and 255)
    ),
  constraint verified_sales_document_number_shape
    check (
      document_number is null
      or (document_number = btrim(document_number) and length(document_number) between 1 and 100)
    ),

  -- ---- date and time, mirroring receipt_confirmations exactly ------------
  constraint verified_sales_transaction_date_floor
    check (transaction_date >= date '2000-01-01'),
  constraint verified_sales_transaction_time_minute
    check (transaction_time is null or date_part('second', transaction_time) = 0),

  constraint verified_sales_timezone_name_shape
    check (timezone_name = btrim(timezone_name) and length(timezone_name) between 1 and 100),

  -- ---- bookkeeping timestamps -------------------------------------------
  -- Same shape as receipt_qualification_events_classified_at_sane, plus an upper
  -- bound: both are written by the same statement, so a wide gap either way means
  -- something supplied a timestamp it should not have.
  constraint verified_sales_finalized_at_sane
    check (finalized_at between created_at - interval '1 minute' and created_at + interval '1 minute')
);

-- ONE authoritative sale per receipt. This is the invariant everything else
-- protects; the unique index is what makes it true under a race rather than
-- merely likely.
create unique index verified_sales_receipt_unique_idx
  on public.verified_sales (receipt_submission_id);

-- LINEAGE UNIQUENESS. receipt_review_decisions and receipt_confirmations are each
-- already UNIQUE per receipt, so with the index above these can only be violated
-- by a row whose lineage is wrong — which the insert assertion refuses. They are
-- added anyway because they cost one index each and they keep the 1:1:1 lineage
-- true declaratively: if a future migration ever loosened the assertion, the
-- schema would still refuse to attach one reviewer's decision, or one staff
-- proposal, to a second sale.
create unique index verified_sales_decision_unique_idx
  on public.verified_sales (receipt_review_decision_id);
create unique index verified_sales_confirmation_unique_idx
  on public.verified_sales (receipt_confirmation_id);

comment on table public.verified_sales is
  'Immutable authoritative sale header, finalized by a Claim Reviewer from an immutable Sales Staff transaction proposal. sale_at, timezone_name, sale_time_precision and dst_ambiguity_choice are frozen at finalization and are never re-derived from the shop''s current time zone.';


-- ============================================================================
-- 5. IMMUTABILITY
-- ============================================================================
-- Narrowly scoped guards rather than reuse: the Phase 1D-0 guards raise messages
-- about qualification events, and a reviewer who trips this one should be told
-- which record refused them.
create function public.verified_sales_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'An authoritative sale header is immutable; it cannot be edited or deleted'
    using errcode = 'check_violation';
end;
$$;

create trigger verified_sales_guard_change
  before update or delete on public.verified_sales
  for each row execute function public.verified_sales_guard_change();

-- TRUNCATE needs its own STATEMENT-level trigger: row triggers do not fire on
-- TRUNCATE, so the guard above would never see it. The same gap
-- public.audit_logs_guard_truncate and receipt_qualification_events_guard_truncate
-- exist to close.
create function public.verified_sales_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Authoritative sale headers are append-only and cannot be truncated'
    using errcode = 'check_violation';
end;
$$;

create trigger verified_sales_guard_truncate
  before truncate on public.verified_sales
  for each statement execute function public.verified_sales_guard_truncate();


-- ============================================================================
-- 6. THE INSERT ASSERTION — THE LAST LINE, NOT THE FIRST
-- ============================================================================
-- finalize_claim_receipt_sale_header already checks all of this. This trigger
-- checks it AGAIN, at the table, so a future bug in that function — or a second
-- writer nobody has written yet — still cannot record an illegitimate sale. The
-- function decides WHETHER to write; the trigger decides whether the row is legal.
--
-- Deliberately NOT checked: whether the shop or the submitting staff member is
-- still ACTIVE. A receipt from a shop that has since closed, or a person who has
-- since left, is exactly the record most likely to still need finalizing, and
-- refusing it would strand real money.
create function public.verified_sales_assert_lineage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission   public.receipt_submissions%rowtype;
  v_decision     public.receipt_review_decisions%rowtype;
  v_confirmation public.receipt_confirmations%rowtype;
  v_shop         public.retailer_shops%rowtype;
  v_time         public.sale_instant_inspection;
  v_expected     timestamptz;
begin
  -- 1 & 2. The receipt exists and is a real submission.
  select * into v_submission
  from public.receipt_submissions s
  where s.id = new.receipt_submission_id;

  if v_submission.id is null or v_submission.status <> 'SUBMITTED' then
    raise exception 'That receipt cannot be finalized into a sale'
      using errcode = 'check_violation';
  end if;

  -- The copied Retailer must be the receipt's Retailer.
  if v_submission.retailer_organization_id <> new.retailer_organization_id then
    raise exception 'That receipt cannot be finalized into a sale'
      using errcode = 'check_violation';
  end if;

  -- 3 & 4. The named decision belongs to this receipt and is VERIFIED.
  select * into v_decision
  from public.receipt_review_decisions rd
  where rd.id = new.receipt_review_decision_id;

  if v_decision.id is null
     or v_decision.receipt_submission_id <> new.receipt_submission_id
     or v_decision.decision <> 'VERIFIED' then
    raise exception 'Only a receipt with a VERIFIED review decision can be finalized into a sale'
      using errcode = 'check_violation';
  end if;

  -- 5, 6 & 7. The named confirmation belongs to this receipt, and its Retailer and
  -- shop agree with the receipt's.
  select * into v_confirmation
  from public.receipt_confirmations rc
  where rc.id = new.receipt_confirmation_id;

  if v_confirmation.id is null
     or v_confirmation.receipt_submission_id <> new.receipt_submission_id
     or v_confirmation.retailer_organization_id <> v_submission.retailer_organization_id
     or v_confirmation.retailer_shop_id <> v_submission.retailer_shop_id then
    raise exception 'That transaction proposal does not belong to that receipt'
      using errcode = 'check_violation';
  end if;

  -- 8. The named Vendor is a real, ACTIVE Vendor organization.
  if not exists (
    select 1 from public.organizations o
    where o.id = new.vendor_organization_id
      and o.organization_type = 'VENDOR'
      and o.status = 'ACTIVE'
  ) then
    raise exception 'That receipt cannot be finalized into a sale'
      using errcode = 'check_violation';
  end if;

  -- 9. THE TENANT BOUNDARY. receipt_submissions has no Vendor column, so the only
  -- path from a receipt to a Vendor is this relationship, and it must be ACTIVE now.
  if not exists (
    select 1 from public.vendor_retailers vr
    where vr.vendor_organization_id = new.vendor_organization_id
      and vr.retailer_organization_id = v_submission.retailer_organization_id
      and vr.status = 'ACTIVE'
  ) then
    raise exception 'That receipt cannot be finalized into a sale'
      using errcode = 'check_violation';
  end if;

  -- 10, 11 & 12. The actor is an ACTIVE member of that same Vendor, holding an
  -- ACTIVE CLAIM_REVIEWER role, and that role carries the finalize permission.
  if not exists (
    select 1
    from public.organization_members m
    join public.profiles pr on pr.id = m.user_id
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where m.user_id = new.finalized_by_profile_id
      and m.organization_id = new.vendor_organization_id
      and m.status = 'ACTIVE'
      and pr.status = 'ACTIVE'
      and r.status = 'ACTIVE'
      and r.code = 'CLAIM_REVIEWER'
      and p.code = 'RECEIPT_SALE_HEADER_FINALIZE'
  ) then
    raise exception 'That receipt cannot be finalized into a sale'
      using errcode = 'insufficient_privilege';
  end if;

  -- 13. The copied shop is the receipt's shop and belongs to the receipt's Retailer.
  select * into v_shop
  from public.retailer_shops s
  where s.id = new.retailer_shop_id;

  if v_shop.id is null
     or v_shop.id <> v_submission.retailer_shop_id
     or v_shop.retailer_organization_id <> v_submission.retailer_organization_id then
    raise exception 'That shop does not belong to that receipt'
      using errcode = 'check_violation';
  end if;

  -- 14. EVERY financial and descriptive value must equal the immutable proposal.
  -- In this release a reviewer accepts or declines; nothing is edited, so any
  -- difference here means a caller invented a number.
  if new.transaction_date is distinct from v_confirmation.transaction_date
     or new.transaction_time is distinct from v_confirmation.transaction_time
     or new.currency_code is distinct from v_confirmation.currency_code
     or new.total_minor is distinct from v_confirmation.total_minor
     or new.subtotal_minor is distinct from v_confirmation.subtotal_minor
     or new.tax_total_minor is distinct from v_confirmation.tax_total_minor
     or new.merchant_name is distinct from v_confirmation.merchant_name
     or new.document_number is distinct from v_confirmation.document_number then
    raise exception 'A sale header must copy the transaction proposal exactly'
      using errcode = 'check_violation';
  end if;

  -- 15. The frozen zone and instant must be what this date, time and choice
  -- actually resolve to. This is where an invented sale_at is caught.
  v_time := public.inspect_sale_instant(
    v_submission.retailer_shop_id,
    v_confirmation.transaction_date,
    v_confirmation.transaction_time
  );

  if v_time.time_status is null
     or v_time.time_status in ('NO_TIMEZONE', 'NONEXISTENT') then
    raise exception 'That sale time cannot be resolved in the shop time zone'
      using errcode = 'check_violation';
  end if;

  if new.timezone_name is distinct from v_time.timezone_name
     or new.sale_time_precision is distinct from v_time.sale_time_precision then
    raise exception 'A sale header must record the resolved time zone and precision'
      using errcode = 'check_violation';
  end if;

  if v_time.time_status = 'OK' then
    -- An unnecessary choice is refused here too, not only in the resolver.
    if new.dst_ambiguity_choice is not null then
      raise exception 'That local sale time is not ambiguous, so no daylight-saving choice may be stored'
        using errcode = 'check_violation';
    end if;
    v_expected := v_time.sale_at;
  else
    if new.dst_ambiguity_choice is null then
      raise exception 'That local sale time is ambiguous, so a daylight-saving choice must be stored'
        using errcode = 'check_violation';
    end if;
    v_expected := case new.dst_ambiguity_choice
                    when 'FIRST' then v_time.first_sale_at
                    else              v_time.second_sale_at
                  end;
  end if;

  if new.sale_at is distinct from v_expected then
    raise exception 'A sale header must record the resolved sale instant'
      using errcode = 'check_violation';
  end if;

  -- 16. The currency is a real ISO code (the foreign key proves existence; this
  -- keeps the failure message in the same voice as the rest).
  if not exists (
    select 1 from public.iso_currency_codes c where c.code = new.currency_code
  ) then
    raise exception 'That currency is not supported'
      using errcode = 'check_violation';
  end if;

  -- 17. FAIL CLOSED ON QUALIFICATION. The Phase 1D-0 contract, enforced for the
  -- first time. A receipt with an unreversed exclusion — the development
  -- TEST_DATA screenshot among them — can never become an authoritative sale.
  if public.receipt_qualification_is_excluded(new.receipt_submission_id) then
    raise exception 'That receipt is excluded from qualification and cannot become a sale'
      using errcode = 'check_violation';
  end if;

  -- 18. One sale per receipt. The unique index is the real guarantee under a
  -- race; this makes the refusal legible when it is not a race.
  if exists (
    select 1 from public.verified_sales vs
    where vs.receipt_submission_id = new.receipt_submission_id
  ) then
    raise exception 'That receipt already has an authoritative sale'
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$$;

create trigger verified_sales_assert_lineage
  before insert on public.verified_sales
  for each row execute function public.verified_sales_assert_lineage();


-- ============================================================================
-- 7. TABLE PRIVILEGES AND RLS
-- ============================================================================
-- RLS enabled with ZERO policies, matching every receipt table. There is no
-- policy to get wrong and no direct read or write for any browser role:
-- everything goes through the SECURITY DEFINER functions below.
--
-- Enabled explicitly even though the hosted project carries a platform-managed
-- rls_auto_enable event trigger, so local, rehearsal and hosted agree rather than
-- depending on a platform behaviour this migration does not own.
alter table public.verified_sales enable row level security;

revoke all on table public.verified_sales from public;
revoke all on table public.verified_sales from anon;
revoke all on table public.verified_sales from authenticated;
-- service_role TOO. Supabase's default privileges grant ALL on a new public table
-- to service_role, and revoking only from public/anon/authenticated leaves
-- REFERENCES, TRIGGER and TRUNCATE behind. TRUNCATE is the one that matters: it
-- BYPASSES ROW TRIGGERS and would defeat the immutability guard outright.
revoke all on table public.verified_sales from service_role;

revoke all on function public.verified_sales_guard_change() from public;
revoke all on function public.verified_sales_guard_truncate() from public;
revoke all on function public.verified_sales_assert_lineage() from public;


-- ============================================================================
-- 8. INDEXES
-- ============================================================================
-- The three unique indexes above already serve every lineage lookup. These two
-- cover the only other access paths this migration actually implements or that
-- Phase 1D-B will immediately need.

-- Vendor-wide finalization history, for a reviewer-facing report and for the
-- "what did we finalize this month" question a Vendor asks first.
create index verified_sales_vendor_finalized_idx
  on public.verified_sales (vendor_organization_id, finalized_at desc);

-- Campaign evaluation will ask "which sales happened in this shop between these
-- two instants". Without this it is a sequential scan the day that ships.
create index verified_sales_shop_sale_at_idx
  on public.verified_sales (retailer_shop_id, sale_at desc);

-- Deliberately NOT indexed: finalized_by_profile_id. No implemented query filters
-- by reviewer, and an index nothing reads is a write cost with no reader.


-- ============================================================================
-- 9. READ — get_claim_receipt_sale_context
-- ============================================================================
-- Everything the future Claim Reviewer page needs BEFORE finalizing, and nothing
-- else. Gated on RECEIPT_REVIEW_READ — the same permission that opens the receipt
-- — because a reviewer who can see the receipt may see whether it is ready.
--
-- Zero rows for missing, foreign and unauthorized alike, so this cannot be used
-- to probe which receipts exist.
create function public.get_claim_receipt_sale_context(
  p_submission_id uuid
)
returns table (
  receipt_submission_id      uuid,
  has_confirmation           boolean,
  is_qualification_excluded  boolean,
  exclusion_reason           text,
  already_finalized          boolean,
  transaction_date           date,
  transaction_time           time without time zone,
  currency_code              text,
  total_minor                bigint,
  subtotal_minor             bigint,
  tax_total_minor            bigint,
  merchant_name              text,
  document_number            text,
  entry_mode                 text,
  changed_fields             text[],
  time_status                text,
  timezone_name              text,
  sale_time_precision        text,
  resolved_sale_at_preview   timestamptz,
  first_sale_at_candidate    timestamptz,
  second_sale_at_candidate   timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor       uuid;
  v_submission   public.receipt_submissions%rowtype;
  v_confirmation public.receipt_confirmations%rowtype;
  v_time         public.sale_instant_inspection;
  v_excluded     boolean;
  v_reason       text;
  v_finalized    boolean;
begin
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ');
  if v_vendor is null or p_submission_id is null then
    return;
  end if;

  -- The receipt must be reachable through THIS reviewer's ACTIVE Vendor-to-Retailer
  -- relationship. Same predicate the queue, the detail and the qualification read use.
  select s.* into v_submission
  from public.receipt_submissions s
  join public.vendor_retailers vr
    on vr.retailer_organization_id = s.retailer_organization_id
   and vr.vendor_organization_id = v_vendor
   and vr.status = 'ACTIVE'
  where s.id = p_submission_id
    and s.status = 'SUBMITTED';

  if v_submission.id is null then
    return;
  end if;

  select * into v_confirmation
  from public.receipt_confirmations rc
  where rc.receipt_submission_id = p_submission_id;

  v_excluded  := public.receipt_qualification_is_excluded(p_submission_id);
  v_finalized := exists (
    select 1 from public.verified_sales vs where vs.receipt_submission_id = p_submission_id
  );

  -- The reason is shown only to a reviewer who has already been authorized for
  -- this receipt, and only when an exclusion is actually in force.
  if v_excluded then
    select x.exclusion_reason into v_reason
    from public.receipt_qualification_events x
    where x.receipt_submission_id = p_submission_id
      and x.event_type = 'EXCLUDED'
      and not exists (
        select 1 from public.receipt_qualification_events rv
        where rv.reverses_event_id = x.id
      )
    order by x.classified_at desc
    limit 1;
  end if;

  -- With no proposal there is nothing to resolve and nothing to preview.
  if v_confirmation.id is null then
    return query select
      p_submission_id, false, v_excluded, v_reason, v_finalized,
      null::date, null::time without time zone, null::text,
      null::bigint, null::bigint, null::bigint, null::text, null::text,
      null::text, null::text[],
      null::text, null::text, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  v_time := public.inspect_sale_instant(
    v_submission.retailer_shop_id,
    v_confirmation.transaction_date,
    v_confirmation.transaction_time
  );

  return query select
    p_submission_id,
    true,
    v_excluded,
    v_reason,
    v_finalized,
    v_confirmation.transaction_date,
    v_confirmation.transaction_time,
    v_confirmation.currency_code,
    v_confirmation.total_minor,
    v_confirmation.subtotal_minor,
    v_confirmation.tax_total_minor,
    v_confirmation.merchant_name,
    v_confirmation.document_number,
    v_confirmation.entry_mode,
    v_confirmation.changed_fields,
    v_time.time_status,
    v_time.timezone_name,
    v_time.sale_time_precision,
    v_time.sale_at,
    v_time.first_sale_at,
    v_time.second_sale_at;
end;
$$;

revoke all     on function public.get_claim_receipt_sale_context(uuid) from public;
revoke execute on function public.get_claim_receipt_sale_context(uuid) from anon;
grant  execute on function public.get_claim_receipt_sale_context(uuid) to authenticated;


-- ============================================================================
-- 10. READ — get_verified_sale_header
-- ============================================================================
-- The immutable header, once it exists. Same authorization as every other
-- reviewer read, and the same single answer for missing, foreign and unauthorized.
create function public.get_verified_sale_header(
  p_submission_id uuid
)
returns table (
  receipt_submission_id    uuid,
  transaction_date         date,
  transaction_time         time without time zone,
  sale_at                  timestamptz,
  timezone_name            text,
  sale_time_precision      text,
  dst_ambiguity_choice     text,
  currency_code            text,
  total_minor              bigint,
  subtotal_minor           bigint,
  tax_total_minor          bigint,
  merchant_name            text,
  document_number          text,
  finalized_at             timestamptz,
  finalized_by_display_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ');
  if v_vendor is null or p_submission_id is null then
    return;
  end if;

  return query
  select
    vs.receipt_submission_id,
    vs.transaction_date,
    vs.transaction_time,
    vs.sale_at,
    vs.timezone_name,
    vs.sale_time_precision,
    vs.dst_ambiguity_choice,
    vs.currency_code,
    vs.total_minor,
    vs.subtotal_minor,
    vs.tax_total_minor,
    vs.merchant_name,
    vs.document_number,
    vs.finalized_at,
    (fp.first_name || ' ' || fp.last_name)::text
  from public.verified_sales vs
  join public.receipt_submissions s on s.id = vs.receipt_submission_id
  join public.vendor_retailers vr
    on vr.retailer_organization_id = s.retailer_organization_id
   and vr.vendor_organization_id = v_vendor
   and vr.status = 'ACTIVE'
  join public.profiles fp on fp.id = vs.finalized_by_profile_id
  where vs.receipt_submission_id = p_submission_id
    and vs.vendor_organization_id = v_vendor;
end;
$$;

revoke all     on function public.get_verified_sale_header(uuid) from public;
revoke execute on function public.get_verified_sale_header(uuid) from anon;
grant  execute on function public.get_verified_sale_header(uuid) to authenticated;


-- ============================================================================
-- 11. WRITE — finalize_claim_receipt_sale_header
-- ============================================================================
-- Two arguments and not one more. No Vendor, Retailer, shop, staff, reviewer,
-- membership, decision id, confirmation id, timezone, sale_at, timestamp, audit
-- action, amount, currency, merchant, document number, campaign or idempotency
-- key: every one of those is derived here, from the receipt and the immutable
-- proposal, so a crafted request cannot assert a single financial fact.
--
-- THE REVIEWER SUPPLIES ONLY A JUDGEMENT: finalize this receipt, and — when the
-- printed local time is genuinely ambiguous — which of the two real instants was
-- meant.
create function public.finalize_claim_receipt_sale_header(
  p_submission_id        uuid,
  p_dst_ambiguity_choice text default null
)
returns table (
  outcome              text,
  sale_time_precision  text,
  sale_at              timestamptz,
  dst_ambiguity_choice text,
  changed              boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor       uuid;
  v_actor        uuid;
  v_submission   public.receipt_submissions%rowtype;
  v_decision     public.receipt_review_decisions%rowtype;
  v_confirmation public.receipt_confirmations%rowtype;
  v_time         public.sale_instant_inspection;
  v_existing     public.verified_sales%rowtype;
  v_new          public.verified_sales%rowtype;
  v_sale_at      timestamptz;
begin
  -- ------------------------------------------------------------------------
  -- 1. Argument vocabulary, before anything is read or locked
  -- ------------------------------------------------------------------------
  if p_dst_ambiguity_choice is not null
     and p_dst_ambiguity_choice not in ('FIRST', 'SECOND') then
    raise exception 'A daylight-saving choice must be FIRST or SECOND'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ------------------------------------------------------------------------
  -- 2. Reviewer and Vendor, from the session only
  -- ------------------------------------------------------------------------
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_SALE_HEADER_FINALIZE');
  if v_vendor is null then
    raise exception 'That receipt is not available for finalization'
      using errcode = 'insufficient_privilege';
  end if;

  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'That receipt is not available for finalization'
      using errcode = 'insufficient_privilege';
  end if;

  if p_submission_id is null then
    raise exception 'A receipt must be supplied'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ------------------------------------------------------------------------
  -- 3. THE LOCK. Everything below reads and writes under it.
  -- ------------------------------------------------------------------------
  -- The receipt row is the serialization point, the same one decide_claim_receipt
  -- and record_claim_receipt_qualification use. That shared choice is what makes
  -- finalization and exclusion order deterministic instead of racy: whichever
  -- commits first is seen by the other.
  select * into v_submission
  from public.receipt_submissions s
  where s.id = p_submission_id
  for update;

  -- 4. Receipt state. Missing, wrong-status, foreign and ineligible receipts all
  -- raise the SAME refusal, so this cannot be used to discover receipts.
  if v_submission.id is null or v_submission.status <> 'SUBMITTED' then
    raise exception 'That receipt is not available for finalization'
      using errcode = 'insufficient_privilege';
  end if;

  -- 8 (checked early, under the lock). The Vendor-to-Retailer relationship.
  if not exists (
    select 1 from public.vendor_retailers vr
    where vr.vendor_organization_id = v_vendor
      and vr.retailer_organization_id = v_submission.retailer_organization_id
      and vr.status = 'ACTIVE'
  ) then
    raise exception 'That receipt is not available for finalization'
      using errcode = 'insufficient_privilege';
  end if;

  -- 5. A final VERIFIED review decision.
  select * into v_decision
  from public.receipt_review_decisions rd
  where rd.receipt_submission_id = p_submission_id;

  if v_decision.id is null or v_decision.decision <> 'VERIFIED' then
    raise exception 'That receipt is not available for finalization'
      using errcode = 'insufficient_privilege';
  end if;

  -- 6. FAIL CLOSED ON QUALIFICATION, under the lock. An exclusion that committed
  -- a moment ago is seen here; one that is still waiting for this lock lands after
  -- the sale, which Phase 1D-0's append-only semantics already allow.
  if public.receipt_qualification_is_excluded(p_submission_id) then
    raise exception 'That receipt is not available for finalization'
      using errcode = 'insufficient_privilege';
  end if;

  -- 7. The immutable staff proposal, locked so it cannot be written beneath us.
  -- FOR SHARE rather than FOR UPDATE: this function never modifies it and must not
  -- block a concurrent reader of the same proposal.
  select * into v_confirmation
  from public.receipt_confirmations rc
  where rc.receipt_submission_id = p_submission_id
  for share;

  if v_confirmation.id is null then
    raise exception 'That receipt is not available for finalization'
      using errcode = 'insufficient_privilege';
  end if;

  -- 9. Reviewer membership, role and the finalize permission are already proven by
  -- the resolver above; the insert assertion proves them again at the table.

  -- ------------------------------------------------------------------------
  -- Already finalized?  Decided BEFORE the time question, because an existing
  -- sale makes the time question moot and a retry must not be told its
  -- (irrelevant) choice was wrong.
  -- ------------------------------------------------------------------------
  select * into v_existing
  from public.verified_sales vs
  where vs.receipt_submission_id = p_submission_id;

  if v_existing.id is not null then
    -- The same reviewer asking again, with a choice that agrees with what was
    -- stored, is a double click or a reload — not an error.
    if v_existing.finalized_by_profile_id = v_actor
       and p_dst_ambiguity_choice is not distinct from v_existing.dst_ambiguity_choice then
      outcome              := 'ALREADY_FINALIZED';
      sale_time_precision  := v_existing.sale_time_precision;
      sale_at              := v_existing.sale_at;
      dst_ambiguity_choice := v_existing.dst_ambiguity_choice;
      changed              := false;
      return next;
      return;
    end if;

    -- Anyone else, or the same reviewer asserting a different interpretation of an
    -- instant that is already frozen. Nothing is written and nothing is
    -- overwritten; the other reviewer's identity is never disclosed.
    outcome              := 'CONFLICT';
    sale_time_precision  := v_existing.sale_time_precision;
    sale_at              := v_existing.sale_at;
    dst_ambiguity_choice := v_existing.dst_ambiguity_choice;
    changed              := false;
    return next;
    return;
  end if;

  -- ------------------------------------------------------------------------
  -- 10 & 11. Freeze the zone and resolve the instant
  -- ------------------------------------------------------------------------
  v_time := public.inspect_sale_instant(
    v_submission.retailer_shop_id,
    v_confirmation.transaction_date,
    v_confirmation.transaction_time
  );

  if v_time.time_status is null then
    raise exception 'That receipt is not available for finalization'
      using errcode = 'insufficient_privilege';
  end if;

  if v_time.time_status = 'NO_TIMEZONE' then
    raise exception 'That shop has no time zone recorded, so a sale instant cannot be resolved'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_time.time_status = 'NONEXISTENT' then
    raise exception 'That local sale time does not exist in the shop time zone'
      using errcode = 'invalid_datetime_format';
  end if;

  if v_time.time_status = 'OK' then
    if p_dst_ambiguity_choice is not null then
      raise exception 'That local sale time is not ambiguous, so a daylight-saving choice must not be supplied'
        using errcode = 'invalid_parameter_value';
    end if;
    v_sale_at := v_time.sale_at;
  else
    -- AMBIGUOUS. The one question only a human can answer, asked as an outcome
    -- rather than an error because the reviewer is authorized and can act on it.
    if p_dst_ambiguity_choice is null then
      outcome              := 'AMBIGUOUS_TIME_REQUIRES_CHOICE';
      sale_time_precision  := v_time.sale_time_precision;
      sale_at              := null;
      dst_ambiguity_choice := null;
      changed              := false;
      return next;
      return;
    end if;
    v_sale_at := case p_dst_ambiguity_choice
                   when 'FIRST' then v_time.first_sale_at
                   else              v_time.second_sale_at
                 end;
  end if;

  -- ------------------------------------------------------------------------
  -- 12. One row. Every value copied or derived; none supplied by the caller.
  -- ------------------------------------------------------------------------
  insert into public.verified_sales (
    receipt_submission_id, receipt_review_decision_id, receipt_confirmation_id,
    vendor_organization_id, retailer_organization_id, retailer_shop_id,
    finalized_by_profile_id,
    transaction_date, transaction_time,
    sale_at, timezone_name, sale_time_precision, dst_ambiguity_choice,
    currency_code, total_minor, subtotal_minor, tax_total_minor,
    merchant_name, document_number
  )
  values (
    p_submission_id, v_decision.id, v_confirmation.id,
    v_vendor, v_submission.retailer_organization_id, v_submission.retailer_shop_id,
    v_actor,
    v_confirmation.transaction_date, v_confirmation.transaction_time,
    v_sale_at, v_time.timezone_name, v_time.sale_time_precision, p_dst_ambiguity_choice,
    v_confirmation.currency_code, v_confirmation.total_minor,
    v_confirmation.subtotal_minor, v_confirmation.tax_total_minor,
    v_confirmation.merchant_name, v_confirmation.document_number
  )
  returning * into v_new;

  -- 13. Exactly one audit row, in the SAME transaction as the sale. No amount, no
  -- merchant, no document number and no UUID: this table is readable by everyone
  -- holding AUDIT_LOGS_READ, and the sale itself is the record of the figures.
  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor,
    v_actor,
    'SALE_HEADER_FINALIZED',
    'RECEIPT_SUBMISSION',
    p_submission_id::text,
    jsonb_build_object(
      'sale_time_precision', v_new.sale_time_precision,
      'dst_ambiguity_choice', v_new.dst_ambiguity_choice,
      'currency_code', v_new.currency_code,
      'source_entry_mode', v_confirmation.entry_mode
    )
  );

  outcome              := 'FINALIZED';
  sale_time_precision  := v_new.sale_time_precision;
  sale_at              := v_new.sale_at;
  dst_ambiguity_choice := v_new.dst_ambiguity_choice;
  changed              := true;
  return next;
end;
$$;

revoke all     on function public.finalize_claim_receipt_sale_header(uuid, text) from public;
revoke execute on function public.finalize_claim_receipt_sale_header(uuid, text) from anon;
grant  execute on function public.finalize_claim_receipt_sale_header(uuid, text) to authenticated;

comment on function public.finalize_claim_receipt_sale_header(uuid, text) is
  'Finalizes one immutable authoritative sale header from a VERIFIED, confirmed and non-excluded receipt. Copies every figure from the immutable staff proposal and freezes the resolved sale instant. Returns FINALIZED, ALREADY_FINALIZED, AMBIGUOUS_TIME_REQUIRES_CHOICE or CONFLICT.';
