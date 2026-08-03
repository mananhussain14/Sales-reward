-- Phase 1D-B: the receipt product proposal, the whole-list product decision, and
-- the authoritative sale items.
--
-- ============================================================================
-- WHAT THIS MIGRATION IS FOR
-- ============================================================================
-- Phase 1D-A gave a receipt an authoritative sale HEADER: when the sale happened,
-- in which currency, for how much. It deliberately said nothing about WHAT was
-- sold, because nothing in the schema could answer that — no table anywhere
-- related a receipt to a product.
--
-- This migration adds that relationship, in three records rather than one:
--
--   1. public.receipt_confirmation_products
--      The immutable Sales Staff proposal. Which products, and how many of each.
--      A child of the one immutable receipt_confirmations row, written in the
--      same transaction as it.
--
--   2. public.receipt_product_review_decisions
--      One immutable Claim Reviewer decision about the WHOLE list: ACCEPTED or
--      REJECTED, with a reason when rejected.
--
--   3. public.verified_sale_items
--      The authoritative lines. Created ONLY when the whole list is accepted, and
--      copied from the proposal byte for byte.
--
-- ============================================================================
-- WHY THREE TABLES AND NOT TWO
-- ============================================================================
-- A rejected proposal creates ZERO authoritative items. If the decision lived
-- only in the item table, "rejected" and "not yet reviewed" would be the same
-- observable state — an empty set — and the only record that a reviewer had
-- looked at all would be an Audit Log.
--
-- Audit Logs are evidence. They are not the authoritative record, they are not
-- queried for business state anywhere in this system, and reconstructing a
-- financial decision from them would make the log load-bearing. So the decision
-- gets its own immutable row, and it is the single source of truth for whether
-- this receipt's products were accepted, rejected, or never judged.
--
-- ============================================================================
-- THE REVIEWER ACCEPTS OR DECLINES. THEY DO NOT EDIT.
-- ============================================================================
-- The reviewer cannot add a line, remove a line, change a product or change a
-- quantity. One wrong line rejects the whole list. That is the same shape as the
-- sale header in Phase 1D-A, and for the same reason: a reviewer who can
-- assemble a line set can assemble a sale, and then the "authoritative" record
-- is an assertion by whoever reviewed it rather than a finding about what the
-- staff proposed.
--
-- There is no corrected re-proposal in this milestone. A rejected receipt stays
-- rejected; a correction would be a separate, separately-audited event, and it
-- does not exist yet.
--
-- ============================================================================
-- SNAPSHOTS ARE COPIED SERVER-SIDE, NEVER SUPPLIED
-- ============================================================================
-- The browser sends a product id and a quantity. Every piece of product text on
-- these rows — code, name, barcode, brand, status — is read out of
-- public.vendor_products by the database at proposal time. The RPC has no
-- parameter for any of it, and the table's insert assertion re-reads the
-- catalogue and refuses a row whose snapshot does not match. A client cannot
-- name a product something it is not.
--
-- The product id stays a real RESTRICT foreign key, so identity is never lost;
-- the text is frozen, so a later rename, rebrand, barcode reassignment or
-- deactivation cannot rewrite what was sold.
--
-- ============================================================================
-- WHAT THIS MIGRATION STILL DOES NOT DO
-- ============================================================================
-- No campaign is evaluated. No reward, coin, ledger, balance or payout exists or
-- is referenced. No OCR is involved and receipt extraction remains DISABLED. A
-- verified sale header with no accepted items remains a perfectly legal state —
-- it is simply not campaign-eligible, and public.receipt_has_finalized_sale_items
-- exists so that a future campaign engine has a correct oracle for that instead
-- of inferring eligibility from the header's existence.
--
-- ACTIVE QUALIFICATION EXCLUSION FAILS CLOSED at every write here, checked under
-- the receipt row lock AND again in each table's insert assertion. The future
-- campaign and reward engines must re-check it themselves; the presence of a
-- sale, or of sale items, is NOT eligibility.
--
-- Dependencies: 20260716125559 (RBAC), 20260716130351 (audit_logs),
--   20260722090000 (vendor_products), 20260724090000 (vendor_product assignments),
--   20260812210000 (receipt_submissions), 20260813210000
--   (assert_my_receipt_extraction_access), 20260814090000
--   (confirm_receipt_extraction), 20260818210000
--   (resolve_claim_reviewer_organization), 20260819090000
--   (receipt_review_decisions, receipt_confirmations), 20260820090000
--   (receipt_qualification_is_excluded), 20260821090000 (verified_sales).


-- ============================================================================
-- 0. PREREQUISITE ROLES
-- ============================================================================
-- Fail loud rather than silently creating unreachable permissions.
do $$
begin
  if not exists (select 1 from public.roles where code = 'CLAIM_REVIEWER') then
    raise exception 'CLAIM_REVIEWER role is missing; migration 20260818210000 must run first';
  end if;
  if not exists (select 1 from public.roles where code = 'SALES_STAFF') then
    raise exception 'SALES_STAFF role is missing; migration 20260716125559 must run first';
  end if;
end;
$$;


-- ============================================================================
-- 1. THE TWO PERMISSIONS
-- ============================================================================
-- RECEIPT_PRODUCT_PROPOSE is a WRITE of a business assertion and is deliberately
-- NOT the existing RECEIPT_PRODUCTS_READ, which only lets staff browse the
-- catalogue. Holding it alone grants nothing: the combined RPC still requires the
-- existing header-confirmation authorization (RECEIPT_EXTRACTION_REVIEW, via
-- assert_my_receipt_extraction_access), so this permission cannot become a back
-- door to writing a transaction date, time or amount.
--
-- RECEIPT_SALE_ITEMS_FINALIZE mirrors RECEIPT_SALE_HEADER_FINALIZE. It is
-- separate so item finalization can be granted or revoked without touching a
-- reviewer's ability to finalize headers.
--
-- RECEIPT_EXTRACTION_REVIEW is NOT overloaded for the reviewer decision: it means
-- "review OCR output", which is a Sales Staff act in a disabled subsystem.
insert into public.permissions (code, name, description, module)
values
  (
    'RECEIPT_PRODUCT_PROPOSE',
    'Propose receipt products and quantities',
    'Permits a Sales Staff member to submit ONE immutable product-and-quantity proposal alongside the receipt transaction confirmation. Grants no ability to confirm transaction values on its own, to review or judge a proposal, to create an authoritative sale or sale item, or to create a campaign result, reward, coin, balance or payout.',
    'RECEIPTS'
  ),
  (
    'RECEIPT_SALE_ITEMS_FINALIZE',
    'Accept or reject a receipt product proposal',
    'Permits a Claim Reviewer to accept or reject the COMPLETE Sales Staff product proposal for a verified, confirmed and non-excluded receipt, creating one immutable decision and, on acceptance, the authoritative sale items. Grants no ability to add, remove, replace or edit a proposed product or quantity, to reopen a decision, or to evaluate a campaign or create a reward, coin, balance or payout.',
    'CLAIM_REVIEW'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- Each permission goes to exactly one role.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where (r.code = 'SALES_STAFF'    and p.code = 'RECEIPT_PRODUCT_PROPOSE')
   or (r.code = 'CLAIM_REVIEWER' and p.code = 'RECEIPT_SALE_ITEMS_FINALIZE')
on conflict do nothing;


-- ============================================================================
-- 2. THE STAFF PROPOSAL
-- ============================================================================
-- A child of receipt_confirmations, which is already one-per-receipt and already
-- immutable. Attaching here rather than inventing a proposal header avoids
-- restating a one-per-receipt identity that the system already has, and means
-- verified_sales.receipt_confirmation_id already carries the proposal's lineage
-- into the authoritative header.
create table public.receipt_confirmation_products (
  id                        uuid primary key default gen_random_uuid(),
  receipt_confirmation_id   uuid not null
                              references public.receipt_confirmations(id) on delete restrict,
  vendor_product_id         uuid not null
                              references public.vendor_products(id) on delete restrict,
  -- Denormalized tenant guard, matching how verified_sales carries it. Lets the
  -- insert assertion refuse a cross-Vendor row without a join at write time.
  vendor_organization_id    uuid not null
                              references public.organizations(id) on delete restrict,

  -- Order is the array order the staff submitted, so the proposal reads back
  -- exactly as it was entered.
  line_number               integer not null,
  -- WHOLE NUMBERS ONLY. These are discrete barcoded SKUs; an integer removes
  -- every rounding and float-equality argument from later campaign arithmetic.
  quantity                  integer not null,

  -- ---- Frozen product identity ---------------------------------------------
  -- Copied from public.vendor_products by the database, never supplied.
  product_code_at_proposal   text not null,
  product_name_at_proposal   text not null,
  barcode_at_proposal        text,
  brand_at_proposal          text,
  product_status_at_proposal text not null,

  created_at                timestamptz not null default now(),

  constraint receipt_confirmation_products_line_number_range
    check (line_number >= 1 and line_number <= 50),
  constraint receipt_confirmation_products_quantity_range
    check (quantity >= 1 and quantity <= 100),

  -- Text shapes mirror public.vendor_products, so a snapshot can never hold a
  -- value the catalogue itself would have refused.
  constraint receipt_confirmation_products_code_shape
    check (
      product_code_at_proposal = upper(btrim(product_code_at_proposal))
      and length(product_code_at_proposal) between 1 and 64
    ),
  constraint receipt_confirmation_products_name_shape
    check (
      product_name_at_proposal = btrim(product_name_at_proposal)
      and length(product_name_at_proposal) between 1 and 200
    ),
  constraint receipt_confirmation_products_barcode_shape
    check (
      barcode_at_proposal is null
      or (barcode_at_proposal collate "C") ~ '^[0-9]{8,14}$'
    ),
  constraint receipt_confirmation_products_brand_shape
    check (
      brand_at_proposal is null
      or (brand_at_proposal = btrim(brand_at_proposal)
          and length(brand_at_proposal) between 1 and 120)
    ),
  constraint receipt_confirmation_products_status_allowed
    check (product_status_at_proposal in ('ACTIVE', 'INACTIVE'))
);

-- Deterministic ordering, and no duplicate product in one proposal. Duplicates
-- are REFUSED rather than merged: two lines for one product is a mistake worth
-- surfacing, and silently summing them would rewrite what the staff asserted.
create unique index receipt_confirmation_products_line_unique_idx
  on public.receipt_confirmation_products (receipt_confirmation_id, line_number);
create unique index receipt_confirmation_products_product_unique_idx
  on public.receipt_confirmation_products (receipt_confirmation_id, vendor_product_id);

comment on table public.receipt_confirmation_products is
  'Immutable Sales Staff product-and-quantity proposal lines for one receipt confirmation. Snapshots are copied server-side from vendor_products and are never client-supplied.';


-- ---- Append-only protection -------------------------------------------------
create function public.receipt_confirmation_products_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A receipt product proposal line is immutable; it cannot be edited or deleted'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_confirmation_products_guard_change
  before update or delete on public.receipt_confirmation_products
  for each row execute function public.receipt_confirmation_products_guard_change();

-- Row triggers do not fire on TRUNCATE, so the guard above would not see it.
create function public.receipt_confirmation_products_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Receipt product proposals are append-only and cannot be truncated'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_confirmation_products_guard_truncate
  before truncate on public.receipt_confirmation_products
  for each statement execute function public.receipt_confirmation_products_guard_truncate();


-- ---- The insert assertion ---------------------------------------------------
-- confirm_receipt_with_products already checks all of this. This trigger checks
-- it AGAIN, at the table, so a future bug in that RPC — or a second writer nobody
-- has written yet — still cannot record an illegal proposal line. The function
-- decides WHETHER to write; the trigger decides whether the row is legal.
--
-- Deliberately NOT checked: whether the receipt's shop or submitting staff member
-- is still ACTIVE. A receipt is proposed against once, at submission time, and a
-- historical record must stay writable through its own transaction.
create function public.receipt_confirmation_products_assert_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_confirmation public.receipt_confirmations%rowtype;
  v_submission   public.receipt_submissions%rowtype;
  v_product      public.vendor_products%rowtype;
begin
  select * into v_confirmation
  from public.receipt_confirmations c
  where c.id = new.receipt_confirmation_id;

  if v_confirmation.id is null then
    raise exception 'A product proposal line requires an existing receipt confirmation'
      using errcode = 'foreign_key_violation';
  end if;

  select * into v_submission
  from public.receipt_submissions s
  where s.id = v_confirmation.receipt_submission_id;

  if v_submission.id is null then
    raise exception 'A product proposal line requires an existing receipt'
      using errcode = 'foreign_key_violation';
  end if;

  select * into v_product
  from public.vendor_products p
  where p.id = new.vendor_product_id;

  if v_product.id is null then
    raise exception 'A product proposal line requires an existing product'
      using errcode = 'foreign_key_violation';
  end if;

  -- The line's Vendor must be the product's Vendor, and that Vendor must have an
  -- ACTIVE relationship with the receipt's Retailer. A foreign-Vendor product can
  -- therefore never be attached to another Vendor's receipt.
  if new.vendor_organization_id is distinct from v_product.vendor_organization_id then
    raise exception 'A product proposal line must name the product''s own Vendor'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1
    from public.vendor_retailers vr
    where vr.vendor_organization_id = new.vendor_organization_id
      and vr.retailer_organization_id = v_submission.retailer_organization_id
      and vr.status = 'ACTIVE'
  ) then
    raise exception 'A product proposal line requires an active Vendor relationship with the receipt Retailer'
      using errcode = 'check_violation';
  end if;

  -- The snapshot must be the catalogue, exactly. A client-substituted name, code,
  -- barcode or brand cannot survive this even if it reached the table directly.
  if new.product_code_at_proposal   is distinct from v_product.product_code
     or new.product_name_at_proposal is distinct from v_product.product_name
     or new.barcode_at_proposal      is distinct from v_product.barcode
     or new.brand_at_proposal        is distinct from v_product.brand
     or new.product_status_at_proposal is distinct from v_product.status then
    raise exception 'A product proposal snapshot must match the product catalogue exactly'
      using errcode = 'check_violation';
  end if;

  -- Eligibility is judged at PROPOSAL TIME. A product deactivated or unassigned
  -- later does not invalidate a line that already exists — the sale already
  -- happened — but a line cannot be created for one that is ineligible now.
  if v_product.status <> 'ACTIVE' then
    raise exception 'A product proposal line requires an active product'
      using errcode = 'check_violation';
  end if;

  if not public.vendor_product_eligible_for_retailer_at(
       new.vendor_product_id, v_submission.retailer_organization_id, now()) then
    raise exception 'A product proposal line requires a product assigned to the receipt Retailer'
      using errcode = 'check_violation';
  end if;

  -- Fail closed. An excluded receipt can never acquire a proposal, whichever
  -- writer is trying.
  if public.receipt_qualification_is_excluded(v_confirmation.receipt_submission_id) then
    raise exception 'An excluded receipt cannot receive a product proposal'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger receipt_confirmation_products_assert_line
  before insert on public.receipt_confirmation_products
  for each row execute function public.receipt_confirmation_products_assert_line();


-- ============================================================================
-- 3. THE WHOLE-LIST PRODUCT DECISION
-- ============================================================================
-- One immutable row per receipt. This is the authoritative answer to "were this
-- receipt's products accepted?" — including when the answer is no and there are
-- therefore no authoritative items to find.
create table public.receipt_product_review_decisions (
  id                       uuid primary key default gen_random_uuid(),
  receipt_submission_id    uuid not null
                             references public.receipt_submissions(id) on delete restrict,
  receipt_confirmation_id  uuid not null
                             references public.receipt_confirmations(id) on delete restrict,
  verified_sale_id         uuid not null
                             references public.verified_sales(id) on delete restrict,
  vendor_organization_id   uuid not null
                             references public.organizations(id) on delete restrict,

  decision                 text not null,
  rejection_reason         text,
  reviewer_note            text,

  decided_by_profile_id    uuid not null
                             references public.profiles(id) on delete restrict,
  decided_at               timestamptz not null default now(),
  created_at               timestamptz not null default now(),

  constraint receipt_product_review_decisions_decision_allowed
    check (decision in ('ACCEPTED', 'REJECTED')),
  constraint receipt_product_review_decisions_reason_allowed
    check (
      rejection_reason is null
      or rejection_reason in (
        'PRODUCT_NOT_ON_RECEIPT', 'WRONG_PRODUCT', 'QUANTITY_MISMATCH',
        'ILLEGIBLE', 'OTHER'
      )
    ),
  -- An acceptance carries no reason and no note: there is nothing to explain, and
  -- a note on an acceptance would invite it to be read as a caveat on an
  -- otherwise unqualified finding.
  constraint receipt_product_review_decisions_accepted_is_bare
    check (
      decision <> 'ACCEPTED'
      or (rejection_reason is null and reviewer_note is null)
    ),
  constraint receipt_product_review_decisions_rejected_has_reason
    check (decision <> 'REJECTED' or rejection_reason is not null),
  -- OTHER means "none of the four named reasons", which says nothing on its own.
  -- Same rule the qualification table already applies to NON_QUALIFYING.
  constraint receipt_product_review_decisions_other_requires_note
    check (
      rejection_reason is distinct from 'OTHER'
      or (reviewer_note is not null and length(btrim(reviewer_note)) >= 1)
    ),
  constraint receipt_product_review_decisions_note_shape
    check (
      reviewer_note is null
      or (reviewer_note = btrim(reviewer_note)
          and length(reviewer_note) between 1 and 500)
    ),
  constraint receipt_product_review_decisions_decided_at_sane
    check (decided_at >= created_at - interval '1 minute')
);

-- One decision per receipt, per confirmation and per sale. Three separate
-- uniqueness facts because all three lineages must stay one-to-one: a second
-- decision must be impossible even if it named a different one of the three.
create unique index receipt_product_review_decisions_submission_unique_idx
  on public.receipt_product_review_decisions (receipt_submission_id);
create unique index receipt_product_review_decisions_confirmation_unique_idx
  on public.receipt_product_review_decisions (receipt_confirmation_id);
create unique index receipt_product_review_decisions_sale_unique_idx
  on public.receipt_product_review_decisions (verified_sale_id);

comment on table public.receipt_product_review_decisions is
  'One immutable Claim Reviewer decision about the COMPLETE receipt product proposal. Authoritative for accepted-versus-rejected; Audit Logs are evidence, not this state.';


create function public.receipt_product_review_decisions_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A receipt product review decision is immutable; it cannot be edited, reopened or deleted'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_product_review_decisions_guard_change
  before update or delete on public.receipt_product_review_decisions
  for each row execute function public.receipt_product_review_decisions_guard_change();

create function public.receipt_product_review_decisions_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Receipt product review decisions are append-only and cannot be truncated'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_product_review_decisions_guard_truncate
  before truncate on public.receipt_product_review_decisions
  for each statement execute function public.receipt_product_review_decisions_guard_truncate();


-- ---- The insert assertion ---------------------------------------------------
-- Every precondition the RPC checks, re-checked at the table.
--
-- Deliberately NOT checked: whether the receipt's shop or its submitting Sales
-- Staff member is still ACTIVE, and whether the proposed products are still
-- active or still assigned. A receipt reviewed weeks after submission is the
-- normal case, and refusing it because a shop closed or a product was retired
-- would strand exactly the records most likely to need judging.
create function public.receipt_product_review_decisions_assert_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission   public.receipt_submissions%rowtype;
  v_confirmation public.receipt_confirmations%rowtype;
  v_sale         public.verified_sales%rowtype;
  v_decision     public.receipt_review_decisions%rowtype;
  v_lines        integer;
begin
  select * into v_submission
  from public.receipt_submissions s
  where s.id = new.receipt_submission_id;

  if v_submission.id is null or v_submission.status <> 'SUBMITTED' then
    raise exception 'A product review decision requires a submitted receipt'
      using errcode = 'check_violation';
  end if;

  select * into v_confirmation
  from public.receipt_confirmations c
  where c.id = new.receipt_confirmation_id;

  if v_confirmation.id is null
     or v_confirmation.receipt_submission_id is distinct from new.receipt_submission_id then
    raise exception 'A product review decision must name the receipt''s own confirmation'
      using errcode = 'check_violation';
  end if;

  select * into v_sale
  from public.verified_sales v
  where v.id = new.verified_sale_id;

  if v_sale.id is null
     or v_sale.receipt_submission_id is distinct from new.receipt_submission_id
     or v_sale.receipt_confirmation_id is distinct from new.receipt_confirmation_id
     or v_sale.vendor_organization_id is distinct from new.vendor_organization_id then
    raise exception 'A product review decision must name the receipt''s own authoritative sale'
      using errcode = 'check_violation';
  end if;

  -- The image decision and the product decision are separate questions, but a
  -- product decision only exists for a receipt whose image was VERIFIED.
  select * into v_decision
  from public.receipt_review_decisions d
  where d.receipt_submission_id = new.receipt_submission_id;

  if v_decision.id is null or v_decision.decision <> 'VERIFIED' then
    raise exception 'A product review decision requires a VERIFIED receipt review decision'
      using errcode = 'check_violation';
  end if;

  if v_decision.vendor_organization_id is distinct from new.vendor_organization_id then
    raise exception 'A product review decision must be recorded by the deciding Vendor'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1
    from public.vendor_retailers vr
    where vr.vendor_organization_id = new.vendor_organization_id
      and vr.retailer_organization_id = v_submission.retailer_organization_id
      and vr.status = 'ACTIVE'
  ) then
    raise exception 'A product review decision requires an active Vendor relationship with the Retailer'
      using errcode = 'check_violation';
  end if;

  -- There must be something to judge.
  select count(*) into v_lines
  from public.receipt_confirmation_products rcp
  where rcp.receipt_confirmation_id = new.receipt_confirmation_id;

  if v_lines < 1 or v_lines > 50 then
    raise exception 'A product review decision requires a proposal of 1 to 50 lines'
      using errcode = 'check_violation';
  end if;

  -- The acting reviewer must be the authenticated caller, must hold an ACTIVE
  -- Claim Reviewer membership in the deciding Vendor, and must hold both the read
  -- and the finalize permission. Identity is never taken from the row.
  if new.decided_by_profile_id is distinct from auth.uid() then
    raise exception 'A product review decision must be recorded by the acting reviewer'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1
    from public.organization_members om
    join public.member_roles mr on mr.organization_member_id = om.id
    join public.role_permissions rp on rp.role_id = mr.role_id
    join public.permissions p on p.id = rp.permission_id
    join public.roles r on r.id = mr.role_id
    where om.user_id = new.decided_by_profile_id
      and om.organization_id = new.vendor_organization_id
      and om.status = 'ACTIVE'
      and r.code = 'CLAIM_REVIEWER'
      and p.code = 'RECEIPT_SALE_ITEMS_FINALIZE'
  ) then
    raise exception 'A product review decision requires an active CLAIM_REVIEWER holding RECEIPT_SALE_ITEMS_FINALIZE in the deciding Vendor'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1
    from public.organization_members om
    join public.member_roles mr on mr.organization_member_id = om.id
    join public.role_permissions rp on rp.role_id = mr.role_id
    join public.permissions p on p.id = rp.permission_id
    where om.user_id = new.decided_by_profile_id
      and om.organization_id = new.vendor_organization_id
      and om.status = 'ACTIVE'
      and p.code = 'RECEIPT_REVIEW_READ'
  ) then
    raise exception 'A product review decision requires RECEIPT_REVIEW_READ in the deciding Vendor'
      using errcode = 'insufficient_privilege';
  end if;

  -- Fail closed.
  if public.receipt_qualification_is_excluded(new.receipt_submission_id) then
    raise exception 'An excluded receipt cannot receive a product review decision'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger receipt_product_review_decisions_assert_decision
  before insert on public.receipt_product_review_decisions
  for each row execute function public.receipt_product_review_decisions_assert_decision();


-- ============================================================================
-- 4. THE AUTHORITATIVE SALE ITEMS
-- ============================================================================
-- Created only by an ACCEPTED decision, and copied from the proposal exactly.
-- Reviewer identity and decision time are reachable through
-- product_review_decision_id and are deliberately NOT duplicated onto every line:
-- one decision covers the whole set by construction, so per-row copies could only
-- ever disagree with it.
create table public.verified_sale_items (
  id                              uuid primary key default gen_random_uuid(),
  verified_sale_id                uuid not null
                                    references public.verified_sales(id) on delete restrict,
  product_review_decision_id      uuid not null
                                    references public.receipt_product_review_decisions(id) on delete restrict,
  receipt_confirmation_product_id uuid not null
                                    references public.receipt_confirmation_products(id) on delete restrict,
  vendor_product_id               uuid not null
                                    references public.vendor_products(id) on delete restrict,
  vendor_organization_id          uuid not null
                                    references public.organizations(id) on delete restrict,

  line_number                     integer not null,
  quantity                        integer not null,

  product_code_at_proposal        text not null,
  product_name_at_proposal        text not null,
  barcode_at_proposal             text,
  brand_at_proposal               text,
  product_status_at_proposal      text not null,

  created_at                      timestamptz not null default now(),

  constraint verified_sale_items_line_number_range
    check (line_number >= 1 and line_number <= 50),
  constraint verified_sale_items_quantity_range
    check (quantity >= 1 and quantity <= 100),
  constraint verified_sale_items_code_shape
    check (
      product_code_at_proposal = upper(btrim(product_code_at_proposal))
      and length(product_code_at_proposal) between 1 and 64
    ),
  constraint verified_sale_items_name_shape
    check (
      product_name_at_proposal = btrim(product_name_at_proposal)
      and length(product_name_at_proposal) between 1 and 200
    ),
  constraint verified_sale_items_barcode_shape
    check (
      barcode_at_proposal is null
      or (barcode_at_proposal collate "C") ~ '^[0-9]{8,14}$'
    ),
  constraint verified_sale_items_brand_shape
    check (
      brand_at_proposal is null
      or (brand_at_proposal = btrim(brand_at_proposal)
          and length(brand_at_proposal) between 1 and 120)
    ),
  constraint verified_sale_items_status_allowed
    check (product_status_at_proposal in ('ACTIVE', 'INACTIVE'))
);

create unique index verified_sale_items_line_unique_idx
  on public.verified_sale_items (verified_sale_id, line_number);
create unique index verified_sale_items_product_unique_idx
  on public.verified_sale_items (verified_sale_id, vendor_product_id);
-- A proposal line may be promoted at most once, ever.
create unique index verified_sale_items_proposal_unique_idx
  on public.verified_sale_items (receipt_confirmation_product_id);
-- The future campaign engine scans "which sales contained product X", so this one
-- index is provisioned now rather than as an emergency later.
create index verified_sale_items_product_idx
  on public.verified_sale_items (vendor_product_id);

comment on table public.verified_sale_items is
  'Immutable authoritative sale item lines, created only from an ACCEPTED whole-list product decision and copied from the staff proposal exactly.';


create function public.verified_sale_items_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'An authoritative sale item is immutable; it cannot be edited or deleted'
    using errcode = 'check_violation';
end;
$$;

create trigger verified_sale_items_guard_change
  before update or delete on public.verified_sale_items
  for each row execute function public.verified_sale_items_guard_change();

create function public.verified_sale_items_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Authoritative sale items are append-only and cannot be truncated'
    using errcode = 'check_violation';
end;
$$;

create trigger verified_sale_items_guard_truncate
  before truncate on public.verified_sale_items
  for each statement execute function public.verified_sale_items_guard_truncate();


-- ---- The insert assertion ---------------------------------------------------
-- An authoritative item must be a faithful copy of one proposal line, under an
-- ACCEPTED decision, for the same receipt and Vendor. Nothing may be invented.
--
-- Deliberately NOT checked: the product's CURRENT status or assignment. The
-- proposal-time status is authoritative here; re-checking now would make a
-- historical record depend on today's catalogue.
create function public.verified_sale_items_assert_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision public.receipt_product_review_decisions%rowtype;
  v_line     public.receipt_confirmation_products%rowtype;
begin
  select * into v_decision
  from public.receipt_product_review_decisions d
  where d.id = new.product_review_decision_id;

  if v_decision.id is null then
    raise exception 'An authoritative sale item requires an existing product review decision'
      using errcode = 'foreign_key_violation';
  end if;

  if v_decision.decision <> 'ACCEPTED' then
    raise exception 'An authoritative sale item requires an ACCEPTED product review decision'
      using errcode = 'check_violation';
  end if;

  if v_decision.verified_sale_id is distinct from new.verified_sale_id
     or v_decision.vendor_organization_id is distinct from new.vendor_organization_id then
    raise exception 'An authoritative sale item must belong to the decision''s own sale and Vendor'
      using errcode = 'check_violation';
  end if;

  select * into v_line
  from public.receipt_confirmation_products rcp
  where rcp.id = new.receipt_confirmation_product_id;

  if v_line.id is null then
    raise exception 'An authoritative sale item requires an existing proposal line'
      using errcode = 'foreign_key_violation';
  end if;

  if v_line.receipt_confirmation_id is distinct from v_decision.receipt_confirmation_id then
    raise exception 'An authoritative sale item must copy a line from the decided proposal'
      using errcode = 'check_violation';
  end if;

  -- Byte-for-byte. A reviewer cannot change a product, a quantity, an order or a
  -- single character of the frozen snapshot.
  if new.vendor_product_id           is distinct from v_line.vendor_product_id
     or new.vendor_organization_id   is distinct from v_line.vendor_organization_id
     or new.line_number              is distinct from v_line.line_number
     or new.quantity                 is distinct from v_line.quantity
     or new.product_code_at_proposal is distinct from v_line.product_code_at_proposal
     or new.product_name_at_proposal is distinct from v_line.product_name_at_proposal
     or new.barcode_at_proposal      is distinct from v_line.barcode_at_proposal
     or new.brand_at_proposal        is distinct from v_line.brand_at_proposal
     or new.product_status_at_proposal is distinct from v_line.product_status_at_proposal then
    raise exception 'An authoritative sale item must copy its proposal line exactly'
      using errcode = 'check_violation';
  end if;

  -- Fail closed, again, at the last possible moment.
  if public.receipt_qualification_is_excluded(v_decision.receipt_submission_id) then
    raise exception 'An excluded receipt cannot receive authoritative sale items'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger verified_sale_items_assert_item
  before insert on public.verified_sale_items
  for each row execute function public.verified_sale_items_assert_item();


-- ============================================================================
-- 5. ROW LEVEL SECURITY AND DIRECT PRIVILEGES
-- ============================================================================
-- RLS is enabled with ZERO policies on all three tables, and every direct
-- privilege is revoked. There is no path to these rows except the SECURITY
-- DEFINER functions below, which are the only place the rules live.
alter table public.receipt_confirmation_products    enable row level security;
alter table public.receipt_product_review_decisions enable row level security;
alter table public.verified_sale_items              enable row level security;

revoke all on table public.receipt_confirmation_products    from public;
revoke all on table public.receipt_confirmation_products    from anon;
revoke all on table public.receipt_confirmation_products    from authenticated;
revoke all on table public.receipt_confirmation_products    from service_role;

revoke all on table public.receipt_product_review_decisions from public;
revoke all on table public.receipt_product_review_decisions from anon;
revoke all on table public.receipt_product_review_decisions from authenticated;
revoke all on table public.receipt_product_review_decisions from service_role;

revoke all on table public.verified_sale_items              from public;
revoke all on table public.verified_sale_items              from anon;
revoke all on table public.verified_sale_items              from authenticated;
revoke all on table public.verified_sale_items              from service_role;

revoke all on function public.receipt_confirmation_products_guard_change()      from public;
revoke all on function public.receipt_confirmation_products_guard_truncate()    from public;
revoke all on function public.receipt_confirmation_products_assert_line()       from public;
revoke all on function public.receipt_product_review_decisions_guard_change()   from public;
revoke all on function public.receipt_product_review_decisions_guard_truncate() from public;
revoke all on function public.receipt_product_review_decisions_assert_decision() from public;
revoke all on function public.verified_sale_items_guard_change()                from public;
revoke all on function public.verified_sale_items_guard_truncate()              from public;
revoke all on function public.verified_sale_items_assert_item()                 from public;


-- ============================================================================
-- 6. THE FUTURE CAMPAIGN ORACLE
-- ============================================================================
-- Phase 2A must NOT infer eligibility from the existence of a verified_sales row.
-- A header with no accepted items is a legal, non-eligible state, and this
-- function is the only correct way to ask the question.
--
-- It answers ONE question — "does this receipt have a complete, accepted
-- authoritative item set?" — and deliberately does not evaluate exclusion. The
-- campaign engine must check BOTH this AND
-- public.receipt_qualification_is_excluded(...) = false. Folding the two together
-- would let a future caller forget one of them.
--
-- Internal only: no browser role may execute it.
create function public.receipt_has_finalized_sale_items(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.receipt_product_review_decisions d
    join public.verified_sales v on v.id = d.verified_sale_id
    where d.receipt_submission_id = p_submission_id
      and d.decision = 'ACCEPTED'
      and (select count(*) from public.verified_sale_items i
           where i.product_review_decision_id = d.id) >= 1
      -- Every proposal line promoted, and nothing beyond them.
      and (select count(*) from public.verified_sale_items i
           where i.product_review_decision_id = d.id)
          = (select count(*) from public.receipt_confirmation_products rcp
             where rcp.receipt_confirmation_id = d.receipt_confirmation_id)
      and not exists (
        select 1
        from public.receipt_confirmation_products rcp
        where rcp.receipt_confirmation_id = d.receipt_confirmation_id
          and not exists (
            select 1 from public.verified_sale_items i
            where i.product_review_decision_id = d.id
              and i.receipt_confirmation_product_id = rcp.id
          )
      )
  );
$$;

revoke all     on function public.receipt_has_finalized_sale_items(uuid) from public;
revoke execute on function public.receipt_has_finalized_sale_items(uuid) from anon;
revoke execute on function public.receipt_has_finalized_sale_items(uuid) from authenticated;

comment on function public.receipt_has_finalized_sale_items(uuid) is
  'True only when a receipt has an ACCEPTED product decision and a complete authoritative item set. Does NOT evaluate qualification exclusion; a campaign engine must check receipt_qualification_is_excluded separately.';


-- ============================================================================
-- 7. THE COMBINED STAFF CONFIRMATION AND PROPOSAL
-- ============================================================================
-- public.confirm_receipt_extraction is NOT replaced. It stays exactly as
-- deployed, and this function calls it inside the outer transaction so that its
-- authorization, its normalization, its changed-field derivation and its
-- ALREADY_CONFIRMED behaviour are reused rather than reimplemented. A distinct
-- name — never an overload — because two same-named functions previously broke
-- regprocedure-pinned assertions during Phase 1D-A.
--
-- ATOMICITY. The receipt row is locked FIRST, every line is validated BEFORE the
-- confirmation is created, and the confirmation, all proposal lines and the Audit
-- Log are written in this one transaction. Any failure anywhere rolls back the
-- whole thing, so a header can never survive a bad line.
--
-- THE BROWSER SENDS IDENTITY AND QUANTITY, NOTHING ELSE. p_lines elements carry
-- exactly `product_id` and `quantity`. There is no parameter for a product name,
-- code, barcode, brand, line number, Vendor, Retailer, shop, actor, campaign or
-- reward — line numbers come from array order, and every snapshot is read from
-- the catalogue by this function.
create function public.confirm_receipt_with_products(
  p_submission_id       uuid,
  p_transaction_date    date,
  p_currency_code       text,
  p_currency_minor_unit smallint,
  p_total_minor         bigint,
  p_lines               jsonb,
  p_merchant_name       text                   default null,
  p_document_number     text                   default null,
  p_transaction_time    time without time zone default null,
  p_subtotal_minor      bigint                 default null,
  p_tax_total_minor     bigint                 default null
)
returns table (
  outcome         text,
  confirmation_id uuid,
  line_count      integer,
  changed         boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_retailer     uuid;
  v_submission   public.receipt_submissions%rowtype;
  v_existing     public.receipt_confirmations%rowtype;
  v_product      public.vendor_products%rowtype;
  v_elem         jsonb;
  v_idx          integer := 0;
  v_len          integer;
  v_qty_text     text;
  v_qty          numeric;
  v_product_id   uuid;
  v_seen         uuid[] := array[]::uuid[];
  v_inner        record;
  v_conf_id      uuid;
  v_total_qty    bigint;
  v_stored_lines integer;
  v_same_lines   boolean;
  v_merchant     text;
  v_document     text;
  v_currency     text;
  v_time         time without time zone;
begin
  -- ---- 1. Role authorization -------------------------------------------------
  -- Holding RECEIPT_PRODUCT_PROPOSE is necessary but never sufficient: the
  -- existing header-confirmation authorization is enforced below by
  -- assert_my_receipt_extraction_access, so this permission alone can never write
  -- a transaction date, time or amount.
  v_retailer := public.resolve_retailer_member_organization('RECEIPT_PRODUCT_PROPOSE');
  if v_retailer is null then
    raise exception 'Not authorized to propose receipt products'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- 2. Receipt access -----------------------------------------------------
  -- Missing, foreign, someone else's, and wrong-status all return ZERO ROWS, the
  -- established staff-side oracle behaviour.
  if not public.assert_my_receipt_extraction_access(p_submission_id) then
    return;
  end if;

  -- ---- 3. Serialize on the receipt row --------------------------------------
  -- The same row decide_claim_receipt, record_claim_receipt_qualification and
  -- finalize_claim_receipt_sale_header lock. That shared choice is what makes
  -- exclusion and confirmation deterministically ordered rather than racy.
  select * into v_submission
  from public.receipt_submissions s
  where s.id = p_submission_id
  for update;

  if v_submission.id is null or v_submission.status <> 'SUBMITTED' then
    return;
  end if;

  -- ---- 4. Fail closed on an active exclusion --------------------------------
  if public.receipt_qualification_is_excluded(p_submission_id) then
    raise exception 'This receipt is excluded from qualification and cannot receive a product proposal'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- 5. Validate the product list STRICTLY, before anything is written -----
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'The product list must be a JSON array'
      using errcode = 'invalid_parameter_value';
  end if;

  v_len := jsonb_array_length(p_lines);
  if v_len < 1 then
    raise exception 'A receipt product proposal must contain at least one product'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_len > 50 then
    raise exception 'A receipt product proposal may contain at most 50 products'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_elem in select jsonb_array_elements(p_lines) loop
    v_idx := v_idx + 1;

    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'Each product line must be a JSON object'
        using errcode = 'invalid_parameter_value';
    end if;

    -- Exactly two keys, and exactly these two. An unknown key is refused rather
    -- than ignored: silently dropping a field a client believed in is how a
    -- client comes to believe it set something it did not.
    if (select count(*) from jsonb_object_keys(v_elem)) <> 2
       or not (v_elem ? 'product_id')
       or not (v_elem ? 'quantity') then
      raise exception 'Each product line must have exactly product_id and quantity'
        using errcode = 'invalid_parameter_value';
    end if;

    if jsonb_typeof(v_elem -> 'product_id') <> 'string' then
      raise exception 'product_id must be a string'
        using errcode = 'invalid_parameter_value';
    end if;

    if (v_elem ->> 'product_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'product_id must be a UUID'
        using errcode = 'invalid_parameter_value';
    end if;
    v_product_id := (v_elem ->> 'product_id')::uuid;

    -- A quantity must be a JSON NUMBER with no fractional part. A string, a
    -- boolean and 2.5 are all refused.
    if jsonb_typeof(v_elem -> 'quantity') <> 'number' then
      raise exception 'quantity must be a whole number'
        using errcode = 'invalid_parameter_value';
    end if;
    v_qty_text := v_elem ->> 'quantity';
    v_qty := v_qty_text::numeric;
    if v_qty <> trunc(v_qty) then
      raise exception 'quantity must be a whole number'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_qty < 1 or v_qty > 100 then
      raise exception 'quantity must be between 1 and 100'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_product_id = any (v_seen) then
      raise exception 'A product may appear only once in a proposal'
        using errcode = 'invalid_parameter_value';
    end if;
    v_seen := v_seen || v_product_id;

    -- The product must exist, be ACTIVE, and be actively assigned to this
    -- Retailer right now. A foreign Vendor's product fails the assignment test,
    -- so this refusal does not disclose whether it exists.
    select * into v_product
    from public.vendor_products vp
    where vp.id = v_product_id;

    if v_product.id is null
       or v_product.status <> 'ACTIVE'
       or not public.vendor_product_eligible_for_retailer_at(
            v_product_id, v_submission.retailer_organization_id, now()) then
      raise exception 'That product is not available for this receipt'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  -- ---- 6. An existing confirmation decides the outcome -----------------------
  select * into v_existing
  from public.receipt_confirmations c
  where c.receipt_submission_id = p_submission_id;

  if v_existing.id is not null then
    -- Normalize exactly as confirm_receipt_extraction does, so "same header"
    -- means the same thing in both functions.
    v_merchant := nullif(btrim(regexp_replace(coalesce(p_merchant_name, ''), '\s+', ' ', 'g')), '');
    v_document := nullif(btrim(coalesce(p_document_number, '')), '');
    v_currency := nullif(upper(btrim(coalesce(p_currency_code, ''))), '');
    v_time := case
      when p_transaction_time is null then null
      else date_trunc('minute', p_transaction_time::interval)::time without time zone
    end;

    select count(*) into v_stored_lines
    from public.receipt_confirmation_products rcp
    where rcp.receipt_confirmation_id = v_existing.id;

    -- Same ordered product list, position by position?
    select coalesce(bool_and(match), false) and count(*) = v_len
      into v_same_lines
    from (
      select rcp.line_number,
             (rcp.vendor_product_id = (req.elem ->> 'product_id')::uuid
              and rcp.quantity = (req.elem ->> 'quantity')::integer) as match
      from public.receipt_confirmation_products rcp
      join (
        select ordinality::integer as pos, elem
        from jsonb_array_elements(p_lines) with ordinality as t(elem, ordinality)
      ) req on req.pos = rcp.line_number
      where rcp.receipt_confirmation_id = v_existing.id
    ) cmp;

    if v_stored_lines = 0 then
      -- A header confirmed before Phase 1D-B, or through the old header-only RPC.
      -- It cannot be topped up with a proposal: the proposal is part of the same
      -- immutable staff assertion, not an afterthought.
      outcome := 'CONFLICT';
      confirmation_id := null;
      line_count := 0;
      changed := false;
      return next;
      return;
    end if;

    if v_stored_lines = v_len
       and coalesce(v_same_lines, false)
       and v_existing.transaction_date is not distinct from p_transaction_date
       and v_existing.transaction_time is not distinct from v_time
       and v_existing.currency_code    is not distinct from v_currency
       and v_existing.total_minor      is not distinct from p_total_minor
       and v_existing.subtotal_minor   is not distinct from p_subtotal_minor
       and v_existing.tax_total_minor  is not distinct from p_tax_total_minor
       and coalesce(upper(v_existing.merchant_name), '') = coalesce(upper(v_merchant), '')
       and upper(regexp_replace(coalesce(v_existing.document_number, ''), '[^0-9A-Za-z]', '', 'g'))
           = upper(regexp_replace(coalesce(v_document, ''), '[^0-9A-Za-z]', '', 'g'))
    then
      outcome := 'ALREADY_CONFIRMED';
      confirmation_id := v_existing.id;
      line_count := v_stored_lines;
      changed := false;
      return next;
      return;
    end if;

    -- Anything else — a different header, a different list, a different order —
    -- is a CONFLICT. Replacing an immutable proposal is forbidden, and returning
    -- "ok" for values that were not stored would be a lie.
    outcome := 'CONFLICT';
    confirmation_id := null;
    line_count := v_stored_lines;
    changed := false;
    return next;
    return;
  end if;

  -- ---- 7. Create the confirmation through the deployed function --------------
  select * into v_inner
  from public.confirm_receipt_extraction(
    p_submission_id, p_transaction_date, p_currency_code, p_currency_minor_unit,
    p_total_minor, p_merchant_name, p_document_number, p_transaction_time,
    p_subtotal_minor, p_tax_total_minor
  );

  if v_inner is null or v_inner.outcome is null then
    -- The inner function declined without a row; say nothing more than it did.
    return;
  end if;

  if v_inner.outcome <> 'CONFIRMED' then
    -- ALREADY_CONFIRMED cannot happen here (section 6 returned), and
    -- EXTRACTION_IN_PROGRESS means the header could not be written, so no
    -- proposal may exist either.
    outcome := 'CONFLICT';
    confirmation_id := null;
    line_count := 0;
    changed := false;
    return next;
    return;
  end if;

  v_conf_id := v_inner.confirmation_id;

  -- ---- 8. Write the proposal lines ------------------------------------------
  -- Line number is the array position. Every snapshot is read from the catalogue
  -- here, inside the database, at one consistent moment.
  insert into public.receipt_confirmation_products (
    receipt_confirmation_id, vendor_product_id, vendor_organization_id,
    line_number, quantity,
    product_code_at_proposal, product_name_at_proposal,
    barcode_at_proposal, brand_at_proposal, product_status_at_proposal
  )
  select
    v_conf_id,
    vp.id,
    vp.vendor_organization_id,
    req.pos,
    (req.elem ->> 'quantity')::integer,
    vp.product_code, vp.product_name, vp.barcode, vp.brand, vp.status
  from (
    select ordinality::integer as pos, elem
    from jsonb_array_elements(p_lines) with ordinality as t(elem, ordinality)
  ) req
  join public.vendor_products vp on vp.id = (req.elem ->> 'product_id')::uuid;

  select count(*), coalesce(sum(rcp.quantity), 0)
    into v_stored_lines, v_total_qty
  from public.receipt_confirmation_products rcp
  where rcp.receipt_confirmation_id = v_conf_id;

  if v_stored_lines <> v_len then
    raise exception 'The product proposal did not store every submitted line'
      using errcode = 'check_violation';
  end if;

  -- ---- 9. One Audit Log, in this same transaction ---------------------------
  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_submission.retailer_organization_id,
    auth.uid(),
    'RECEIPT_PRODUCTS_PROPOSED',
    'RECEIPT_SUBMISSION',
    p_submission_id::text,
    jsonb_build_object(
      'line_count', v_stored_lines,
      'total_quantity', v_total_qty,
      'distinct_product_count', v_stored_lines
    )
  );

  outcome := 'CONFIRMED';
  confirmation_id := v_conf_id;
  line_count := v_stored_lines;
  changed := true;
  return next;
end;
$$;

revoke all     on function public.confirm_receipt_with_products(uuid, date, text, smallint, bigint, jsonb, text, text, time without time zone, bigint, bigint) from public;
revoke execute on function public.confirm_receipt_with_products(uuid, date, text, smallint, bigint, jsonb, text, text, time without time zone, bigint, bigint) from anon;
grant  execute on function public.confirm_receipt_with_products(uuid, date, text, smallint, bigint, jsonb, text, text, time without time zone, bigint, bigint) to authenticated;


-- ============================================================================
-- 8. THE STAFF PROPOSAL READ
-- ============================================================================
-- Sales Staff read back their own immutable proposal. The acting staff member and
-- their Retailer are derived from auth.uid(); there is no Vendor, Retailer or
-- staff parameter. Missing, foreign and unauthorized all return zero rows.
create function public.get_my_receipt_product_proposal(p_submission_id uuid)
returns table (
  line_number                integer,
  quantity                   integer,
  product_code_at_proposal   text,
  product_name_at_proposal   text,
  barcode_at_proposal        text,
  brand_at_proposal          text,
  product_status_at_proposal text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('RECEIPT_PRODUCT_PROPOSE');
  if v_retailer is null or p_submission_id is null then
    return;
  end if;

  return query
  select rcp.line_number, rcp.quantity,
         rcp.product_code_at_proposal, rcp.product_name_at_proposal,
         rcp.barcode_at_proposal, rcp.brand_at_proposal,
         rcp.product_status_at_proposal
  from public.receipt_confirmation_products rcp
  join public.receipt_confirmations c on c.id = rcp.receipt_confirmation_id
  join public.receipt_submissions s on s.id = c.receipt_submission_id
  where s.id = p_submission_id
    and s.submitted_by_profile_id = auth.uid()
    and s.retailer_organization_id = v_retailer
  order by rcp.line_number;
end;
$$;

revoke all     on function public.get_my_receipt_product_proposal(uuid) from public;
revoke execute on function public.get_my_receipt_product_proposal(uuid) from anon;
grant  execute on function public.get_my_receipt_product_proposal(uuid) to authenticated;


-- ============================================================================
-- 9. THE CLAIM REVIEWER PRODUCT CONTEXT
-- ============================================================================
-- Everything a future reviewer panel needs, and nothing more. One row per
-- proposal line, with the receipt-level context repeated on each; when there is
-- no proposal a SINGLE row is returned with the line columns null, so a caller
-- can distinguish "no proposal" from "unreadable" (which returns no rows at all).
--
-- The frozen proposal-time status and the product's CURRENT status are returned
-- SEPARATELY and deliberately: a reviewer must be able to see that a product has
-- since been deactivated without that fact rewriting what was proposed.
--
-- No proposal-line id, decision id, sale id, Vendor id, Retailer id, shop id,
-- email, filename, storage path or hash is returned. The function has no column
-- for one.
create function public.get_claim_receipt_product_context(p_submission_id uuid)
returns table (
  receipt_submission_id       uuid,
  has_product_proposal        boolean,
  proposal_line_count         integer,
  has_verified_sale_header    boolean,
  is_qualification_excluded   boolean,
  exclusion_reason            text,
  product_decision            text,
  rejection_reason            text,
  reviewer_note               text,
  decided_at                  timestamptz,
  decided_by_display_name     text,
  already_accepted            boolean,
  already_rejected            boolean,
  line_number                 integer,
  quantity                    integer,
  product_code_at_proposal    text,
  product_name_at_proposal    text,
  barcode_at_proposal         text,
  brand_at_proposal           text,
  product_status_at_proposal  text,
  product_status_current      text,
  product_assigned_currently   boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor     uuid;
  v_submission public.receipt_submissions%rowtype;
  v_conf       public.receipt_confirmations%rowtype;
  v_decision   public.receipt_product_review_decisions%rowtype;
  v_excluded   boolean;
  v_reason     text;
  v_count      integer := 0;
  v_has_sale   boolean;
  v_name       text;
begin
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ');
  if v_vendor is null or p_submission_id is null then
    return;
  end if;

  -- Missing, foreign, and outside an active Vendor relationship are all one
  -- silent empty result.
  select * into v_submission
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

  select * into v_conf
  from public.receipt_confirmations c
  where c.receipt_submission_id = p_submission_id;

  if v_conf.id is not null then
    select count(*) into v_count
    from public.receipt_confirmation_products rcp
    where rcp.receipt_confirmation_id = v_conf.id;
  end if;

  v_has_sale := exists (
    select 1 from public.verified_sales v
    where v.receipt_submission_id = p_submission_id
  );

  v_excluded := public.receipt_qualification_is_excluded(p_submission_id);
  if v_excluded then
    select e.exclusion_reason into v_reason
    from public.receipt_qualification_events e
    where e.receipt_submission_id = p_submission_id
      and e.event_type = 'EXCLUDED'
    order by e.classified_at desc
    limit 1;
  end if;

  select * into v_decision
  from public.receipt_product_review_decisions d
  where d.receipt_submission_id = p_submission_id;

  if v_decision.id is not null then
    select btrim(pr.first_name || ' ' || pr.last_name) into v_name
    from public.profiles pr
    where pr.id = v_decision.decided_by_profile_id;
  end if;

  if v_count = 0 then
    -- One row, no line columns: "there is no proposal" is a state, not silence.
    return query
    select p_submission_id, false, 0, v_has_sale, v_excluded, v_reason,
           v_decision.decision, v_decision.rejection_reason, v_decision.reviewer_note,
           v_decision.decided_at, v_name,
           coalesce(v_decision.decision = 'ACCEPTED', false),
           coalesce(v_decision.decision = 'REJECTED', false),
           null::integer, null::integer, null::text, null::text, null::text,
           null::text, null::text, null::text, null::boolean;
    return;
  end if;

  return query
  select p_submission_id, true, v_count, v_has_sale, v_excluded, v_reason,
         v_decision.decision, v_decision.rejection_reason, v_decision.reviewer_note,
         v_decision.decided_at, v_name,
         coalesce(v_decision.decision = 'ACCEPTED', false),
         coalesce(v_decision.decision = 'REJECTED', false),
         rcp.line_number, rcp.quantity,
         rcp.product_code_at_proposal, rcp.product_name_at_proposal,
         rcp.barcode_at_proposal, rcp.brand_at_proposal,
         rcp.product_status_at_proposal,
         vp.status,
         public.vendor_product_eligible_for_retailer_at(
           rcp.vendor_product_id, v_submission.retailer_organization_id, now())
  from public.receipt_confirmation_products rcp
  join public.vendor_products vp on vp.id = rcp.vendor_product_id
  where rcp.receipt_confirmation_id = v_conf.id
  order by rcp.line_number;
end;
$$;

revoke all     on function public.get_claim_receipt_product_context(uuid) from public;
revoke execute on function public.get_claim_receipt_product_context(uuid) from anon;
grant  execute on function public.get_claim_receipt_product_context(uuid) to authenticated;


-- ============================================================================
-- 10. THE CLAIM REVIEWER FINALIZATION
-- ============================================================================
-- Accept or reject the COMPLETE proposal. There is no parameter for a product, a
-- quantity, a line number, a sale, a confirmation, a decision, a Vendor, a
-- Retailer, a shop or an actor: the reviewer is answering yes or no about a list
-- they cannot touch, and every id is derived here.
create function public.finalize_claim_receipt_sale_items(
  p_submission_id     uuid,
  p_decision          text,
  p_rejection_reason  text default null,
  p_reviewer_note     text default null
)
returns table (
  outcome    text,
  line_count integer,
  changed    boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor     uuid;
  v_actor      uuid;
  v_submission public.receipt_submissions%rowtype;
  v_review     public.receipt_review_decisions%rowtype;
  v_conf       public.receipt_confirmations%rowtype;
  v_sale       public.verified_sales%rowtype;
  v_existing   public.receipt_product_review_decisions%rowtype;
  v_decision   text;
  v_reason     text;
  v_note       text;
  v_lines      integer;
  v_total_qty  bigint;
  v_new_id     uuid;
  v_items      integer;
begin
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_SALE_ITEMS_FINALIZE');
  if v_vendor is null then
    raise exception 'Not authorized to finalize receipt sale items'
      using errcode = 'insufficient_privilege';
  end if;

  -- Reading the proposal is a precondition for judging it.
  if public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ') is distinct from v_vendor then
    raise exception 'Not authorized to finalize receipt sale items'
      using errcode = 'insufficient_privilege';
  end if;

  v_actor := auth.uid();

  -- ---- Normalize the decision inputs before anything is read -----------------
  v_decision := upper(btrim(coalesce(p_decision, '')));
  if v_decision not in ('ACCEPTED', 'REJECTED') then
    raise exception 'A product decision must be ACCEPTED or REJECTED'
      using errcode = 'invalid_parameter_value';
  end if;

  v_reason := nullif(upper(btrim(coalesce(p_rejection_reason, ''))), '');
  v_note   := nullif(btrim(coalesce(p_reviewer_note, '')), '');

  if v_decision = 'ACCEPTED' then
    if v_reason is not null or v_note is not null then
      raise exception 'An accepted product proposal takes no rejection reason and no note'
        using errcode = 'invalid_parameter_value';
    end if;
  else
    if v_reason is null then
      raise exception 'A rejected product proposal requires a rejection reason'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_reason not in ('PRODUCT_NOT_ON_RECEIPT', 'WRONG_PRODUCT',
                        'QUANTITY_MISMATCH', 'ILLEGIBLE', 'OTHER') then
      raise exception 'That rejection reason is not recognised'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_reason = 'OTHER' and v_note is null then
      raise exception 'A rejection reason of OTHER requires a note'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_note is not null and length(v_note) > 500 then
      raise exception 'A reviewer note may be at most 500 characters'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- ---- Serialize on the receipt row -----------------------------------------
  select * into v_submission
  from public.receipt_submissions s
  where s.id = p_submission_id
  for update;

  -- Missing, wrong-status, foreign and ineligible all raise the SAME refusal, so
  -- this cannot be used to discover receipts.
  if v_submission.id is null or v_submission.status <> 'SUBMITTED' then
    raise exception 'This receipt is not available for a product decision'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.vendor_retailers vr
    where vr.vendor_organization_id = v_vendor
      and vr.retailer_organization_id = v_submission.retailer_organization_id
      and vr.status = 'ACTIVE'
  ) then
    raise exception 'This receipt is not available for a product decision'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_review
  from public.receipt_review_decisions d
  where d.receipt_submission_id = p_submission_id;

  if v_review.id is null
     or v_review.decision <> 'VERIFIED'
     or v_review.vendor_organization_id is distinct from v_vendor then
    raise exception 'This receipt is not available for a product decision'
      using errcode = 'insufficient_privilege';
  end if;

  if public.receipt_qualification_is_excluded(p_submission_id) then
    raise exception 'This receipt is not available for a product decision'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_conf
  from public.receipt_confirmations c
  where c.receipt_submission_id = p_submission_id;

  if v_conf.id is null then
    raise exception 'This receipt is not available for a product decision'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_sale
  from public.verified_sales v
  where v.receipt_submission_id = p_submission_id;

  if v_sale.id is null or v_sale.receipt_confirmation_id is distinct from v_conf.id then
    raise exception 'This receipt is not available for a product decision'
      using errcode = 'insufficient_privilege';
  end if;

  select count(*), coalesce(sum(rcp.quantity), 0)
    into v_lines, v_total_qty
  from public.receipt_confirmation_products rcp
  where rcp.receipt_confirmation_id = v_conf.id;

  if v_lines < 1 or v_lines > 50 then
    raise exception 'This receipt is not available for a product decision'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- Idempotency, under the lock ------------------------------------------
  select * into v_existing
  from public.receipt_product_review_decisions d
  where d.receipt_submission_id = p_submission_id;

  if v_existing.id is not null then
    -- Same reviewer, same normalized answer: nothing happened, and say so.
    -- Anyone else, or any different answer: CONFLICT, with no identity disclosed.
    if v_existing.decided_by_profile_id = v_actor
       and v_existing.decision = v_decision
       and v_existing.rejection_reason is not distinct from v_reason
       and v_existing.reviewer_note is not distinct from v_note then
      outcome := case when v_decision = 'ACCEPTED'
                      then 'ALREADY_ACCEPTED' else 'ALREADY_REJECTED' end;
      line_count := case when v_existing.decision = 'ACCEPTED' then v_lines else 0 end;
      changed := false;
      return next;
      return;
    end if;

    outcome := 'CONFLICT';
    line_count := case when v_existing.decision = 'ACCEPTED' then v_lines else 0 end;
    changed := false;
    return next;
    return;
  end if;

  -- ---- The one immutable decision -------------------------------------------
  insert into public.receipt_product_review_decisions (
    receipt_submission_id, receipt_confirmation_id, verified_sale_id,
    vendor_organization_id, decision, rejection_reason, reviewer_note,
    decided_by_profile_id
  )
  values (
    p_submission_id, v_conf.id, v_sale.id, v_vendor, v_decision, v_reason, v_note, v_actor
  )
  returning id into v_new_id;

  if v_decision = 'ACCEPTED' then
    -- Every proposal line, exactly once, copied verbatim. The set comes from the
    -- proposal itself, so no line can be omitted and none can be invented.
    insert into public.verified_sale_items (
      verified_sale_id, product_review_decision_id, receipt_confirmation_product_id,
      vendor_product_id, vendor_organization_id, line_number, quantity,
      product_code_at_proposal, product_name_at_proposal,
      barcode_at_proposal, brand_at_proposal, product_status_at_proposal
    )
    select v_sale.id, v_new_id, rcp.id,
           rcp.vendor_product_id, rcp.vendor_organization_id,
           rcp.line_number, rcp.quantity,
           rcp.product_code_at_proposal, rcp.product_name_at_proposal,
           rcp.barcode_at_proposal, rcp.brand_at_proposal,
           rcp.product_status_at_proposal
    from public.receipt_confirmation_products rcp
    where rcp.receipt_confirmation_id = v_conf.id
    order by rcp.line_number;

    select count(*) into v_items
    from public.verified_sale_items i
    where i.product_review_decision_id = v_new_id;

    if v_items <> v_lines then
      raise exception 'The authoritative item set did not copy every proposal line'
        using errcode = 'check_violation';
    end if;

    insert into public.audit_logs (
      organization_id, actor_profile_id, action, entity_type, entity_id, metadata
    )
    values (
      v_vendor, v_actor, 'SALE_ITEMS_ACCEPTED', 'RECEIPT_SUBMISSION',
      p_submission_id::text,
      jsonb_build_object('line_count', v_lines, 'total_quantity', v_total_qty)
    );

    outcome := 'ACCEPTED';
    line_count := v_lines;
    changed := true;
    return next;
    return;
  end if;

  -- REJECTED: the decision stands alone. No authoritative item is created, and
  -- the receipt's VERIFIED image decision is untouched.
  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor, v_actor, 'SALE_ITEMS_REJECTED', 'RECEIPT_SUBMISSION',
    p_submission_id::text,
    jsonb_build_object('rejection_reason', v_reason, 'line_count', v_lines)
  );

  outcome := 'REJECTED';
  line_count := 0;
  changed := true;
  return next;
end;
$$;

revoke all     on function public.finalize_claim_receipt_sale_items(uuid, text, text, text) from public;
revoke execute on function public.finalize_claim_receipt_sale_items(uuid, text, text, text) from anon;
grant  execute on function public.finalize_claim_receipt_sale_items(uuid, text, text, text) to authenticated;


-- ============================================================================
-- 11. THE AUTHORITATIVE ITEM READ
-- ============================================================================
-- Zero rows unless an ACCEPTED decision and its items exist for a receipt this
-- reviewer may read. No internal foreign key is returned.
create function public.get_verified_sale_items(p_submission_id uuid)
returns table (
  line_number                integer,
  quantity                   integer,
  product_code_at_proposal   text,
  product_name_at_proposal   text,
  barcode_at_proposal        text,
  brand_at_proposal          text,
  product_status_at_proposal text,
  decision                   text,
  decided_at                 timestamptz,
  decided_by_display_name    text
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
  select i.line_number, i.quantity,
         i.product_code_at_proposal, i.product_name_at_proposal,
         i.barcode_at_proposal, i.brand_at_proposal, i.product_status_at_proposal,
         d.decision, d.decided_at,
         btrim(pr.first_name || ' ' || pr.last_name)
  from public.verified_sale_items i
  join public.receipt_product_review_decisions d on d.id = i.product_review_decision_id
  join public.receipt_submissions s on s.id = d.receipt_submission_id
  join public.vendor_retailers vr
    on vr.retailer_organization_id = s.retailer_organization_id
   and vr.vendor_organization_id = v_vendor
   and vr.status = 'ACTIVE'
  left join public.profiles pr on pr.id = d.decided_by_profile_id
  where d.receipt_submission_id = p_submission_id
    and d.decision = 'ACCEPTED'
    and d.vendor_organization_id = v_vendor
  order by i.line_number;
end;
$$;

revoke all     on function public.get_verified_sale_items(uuid) from public;
revoke execute on function public.get_verified_sale_items(uuid) from anon;
grant  execute on function public.get_verified_sale_items(uuid) to authenticated;
