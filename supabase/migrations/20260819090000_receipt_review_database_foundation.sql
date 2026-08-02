-- Migration: receipt_review_database_foundation
-- Purpose: Phase 1C-A. The DATABASE foundation for Claim Reviewer receipt review.
--          Adds, and nothing else:
--            1. two permissions in module CLAIM_REVIEW, mapped to CLAIM_REVIEWER only
--            2. public.receipt_review_decisions            [new, append-only]
--            3. its immutability and tenant-assert triggers
--            4. three indexes
--            5. public.list_claim_review_queue(...)        [authenticated]
--            6. public.count_claim_review_queue(...)       [authenticated]
--            7. public.get_claim_review_detail(uuid)       [authenticated]
--            8. public.decide_claim_receipt(...)           [authenticated]
--            9. public.get_claim_review_object_reference(uuid) [service_role]
--
-- ============================================================================
-- THE SCOPE THIS MILESTONE DELIBERATELY HAS — DECISION D1
-- ============================================================================
-- Review is IMAGE-ONLY. That is not a simplification, it is what the data supports:
-- public.receipt_submissions carries a stored image, a shop, a submitter and file
-- metadata — and NO transaction data at all. There is no sale date, amount, currency,
-- merchant or product on a receipt. Those values live in public.receipt_confirmations
-- (entered by the RETAILER) or public.receipt_extractions (OCR), and both tables are
-- empty: extraction runtime mode is DISABLED and no Retailer has confirmed a receipt.
--
-- A reviewer can therefore honestly answer "is this a legible, plausible receipt?" and
-- cannot answer "does it match a campaign, product or amount?". The rejection-reason
-- vocabulary below is cut to exactly the questions the data can answer. Reasons that
-- would require guessing — WRONG_VENDOR_OR_PRODUCT, AMOUNT_MISMATCH,
-- RECEIPT_OUTSIDE_ALLOWED_PERIOD — are deliberately ABSENT rather than offered and
-- misused.
--
-- ============================================================================
-- WHY receipt_confirmations IS NOT REUSED AS THE DECISION
-- ============================================================================
-- It is the RETAILER's statement of what their own receipt says: confirmed_by_profile_id
-- is the submitting side, entry_mode is MANUAL/EXTRACTED/MIXED, changed_fields records
-- what they edited. A Vendor's VERIFY/REJECT is a different fact by a different party
-- with a different trust level. Overloading one table with both would make "the shop
-- says this is the total" and "the Vendor accepts this claim" indistinguishable, and the
-- unique-per-submission constraint already there would force them to collide.
--
-- ============================================================================
-- NO REWARD IS CREATED HERE
-- ============================================================================
-- A decision is a decision. It creates no coin, balance, payout, verified-sale or
-- reward contribution — none of those objects exist yet, and this migration creates
-- none. receipt_review_decisions carries vendor_organization_id and decided_at so a
-- later reward engine can join verified claims to campaign versions through the Phase 0
-- temporal foundation without a schema change, but that engine is a separate milestone.
--
-- Idempotency posture: plain CREATE TABLE / CREATE FUNCTION (no IF NOT EXISTS, no
--   CREATE OR REPLACE) so a conflicting existing object FAILS the migration rather than
--   being silently replaced. The two permission seeds use the established ON CONFLICT
--   pattern so a re-run is a no-op. No dynamic SQL. Every reference is schema-qualified
--   because every function runs with an EMPTY search_path.
--
-- Dependencies: 20260716124419 (profiles, organizations, organization_members),
--   20260716125559 (roles, member_roles, permissions, role_permissions),
--   20260716131104 (authorization helpers), 20260717094520 (retailer_shops),
--   20260811090000 (vendor_retailers), 20260812210000 (receipt_submissions,
--   receipt_confirmations, receipt_extractions), 20260818210000 (CLAIM_REVIEWER
--   portal access and public.resolve_claim_reviewer_organization).


-- ============================================================================
-- 1. PERMISSIONS
-- ============================================================================
-- TWO, not one and not three.
--
-- One would be too coarse: "may look at receipts" and "may decide their fate" are
-- different powers, and a future read-only auditor or a reviewer-in-training must be
-- expressible without a schema change.
--
-- Three would be too fine: splitting queue from detail buys nothing, because anything
-- listed in the queue is by definition openable, so the two would always be granted
-- together and the distinction would only add a way to misconfigure them.
--
-- Module CLAIM_REVIEW, joining CLAIM_REVIEW_PORTAL_READ. Deliberately NOT module
-- RECEIPTS: that module's three permissions (RECEIPT_SUBMIT, RECEIPT_PRODUCTS_READ,
-- RECEIPT_EXTRACTION_REVIEW) are all SALES_STAFF submission-side powers, and grouping
-- reviewer permissions there would make a future "grant the RECEIPTS module" mistake
-- catastrophic instead of merely wrong.
insert into public.permissions (code, name, description, module)
values
  (
    'RECEIPT_REVIEW_READ',
    'Read the Claim Review queue',
    'View the receipt review queue, open a submitted receipt, and view its stored image. Grants no ability to decide a receipt, and no access to rewards, coins, balances or payouts.',
    'CLAIM_REVIEW'
  ),
  (
    'RECEIPT_REVIEW_DECIDE',
    'Decide a submitted receipt',
    'Record the final verify or reject decision for a submitted receipt. A decision is immutable and creates no reward, coin, balance or payout.',
    'CLAIM_REVIEW'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- Precondition: the target role must exist. Without this a missing role would make the
-- mapping INSERT write zero rows, the migration would report success with the
-- permissions assigned to nobody, and a correctly configured reviewer would be refused
-- with nothing to explain why. Fail loudly instead. Reads one row, writes nothing.
do $$
begin
  if not exists (
    select 1 from public.roles r where r.code = 'CLAIM_REVIEWER'
  ) then
    raise exception 'Seed precondition failed: role CLAIM_REVIEWER does not exist, so the receipt review permissions cannot be assigned';
  end if;
end;
$$;

-- Role -> permission mapping. CLAIM_REVIEWER and ONLY it.
--
-- VENDOR_SUPER_ADMIN is excluded on purpose and it is the exclusion most likely to be
-- questioned. A Vendor Super Admin authors the campaigns that decide what a verified
-- sale is worth; a reviewer decides which sales qualify. One person holding both can
-- direct rewards to a chosen Retailer with no second party involved. That separation is
-- the entire reason the Claim Reviewer role exists.
--
-- RETAILER_OWNER, RETAILER_MANAGER and SALES_STAFF are excluded for the more obvious
-- reason: they are the claiming side. A Retailer approving its own claims is not review.
--
-- Ids resolved by joining on code rather than written literally. Both sides are unique,
-- so this yields exactly 1 x 2 = 2 rows. ON CONFLICT DO NOTHING targets the composite
-- primary key, so a re-run is a no-op and no mapping is ever deleted.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code in ('RECEIPT_REVIEW_READ', 'RECEIPT_REVIEW_DECIDE')
where r.code = 'CLAIM_REVIEWER'
on conflict (role_id, permission_id) do nothing;


-- ============================================================================
-- 2. THE DECISION TABLE
-- ============================================================================
-- One row per FINAL decision. Append-only, unique per receipt, tenant-asserted.
--
-- WHY A NEW TABLE RATHER THAN A STATUS ON receipt_submissions
--   receipt_submissions.status is a SUBMISSION lifecycle (RESERVED -> SUBMITTED /
--   UPLOAD_FAILED) already protected by immutability triggers and relied on by the
--   Flutter submission path. Threading a review lifecycle through it would entangle two
--   independent state machines and force a change to a table the mobile client writes.
--   A separate table leaves the submission untouched — which is also what lets this
--   whole migration be additive.
create table public.receipt_review_decisions (
  id                     uuid primary key default gen_random_uuid(),

  -- The receipt this decision is about. RESTRICT, not CASCADE: a decision is an audit
  -- record of a judgement that was made, and it must not silently vanish because
  -- something upstream was removed.
  receipt_submission_id  uuid not null
    references public.receipt_submissions (id) on delete restrict,

  -- The Vendor whose reviewer decided. Stored rather than derived because the
  -- vendor_retailers link can later be deactivated, and the decision must still record
  -- who judged it at the time. Also gives the reward engine its join key later.
  vendor_organization_id uuid not null
    references public.organizations (id) on delete restrict,

  decision               text not null,
  rejection_reason       text,
  reviewer_note          text,

  -- The reviewer's PROFILE, matching member_roles.assigned_by and
  -- audit_logs.actor_profile_id. RESTRICT so attribution cannot be erased.
  decided_by_profile_id  uuid not null
    references public.profiles (id) on delete restrict,

  decided_at             timestamptz not null default now(),
  created_at             timestamptz not null default now(),

  -- ------------------------------------------------------------------------
  -- DECISION D5 — ONE IMMUTABLE FINAL DECISION PER RECEIPT
  -- ------------------------------------------------------------------------
  -- This unique constraint is the CONCURRENCY AUTHORITY, not merely a data rule. It is
  -- what makes two simultaneous reviewers unable to record conflicting verdicts, and it
  -- is what makes a browser retry a no-op instead of a duplicate. decide_claim_receipt
  -- relies on it rather than on a read-then-write check.
  --
  -- A future correction milestone can relax this to a partial unique index over a
  -- `superseded_at is null` predicate without rewriting a single row of history. That
  -- is why the column set already reads as an event rather than a mutable record.
  constraint receipt_review_decisions_submission_unique
    unique (receipt_submission_id),

  -- Exactly two outcomes. text + CHECK, not an enum and not a reference table: every
  -- other vocabulary in this schema (receipt statuses, extraction statuses, failure
  -- codes, entry modes, membership statuses) is written this way, a CHECK is trivially
  -- extended by a later migration, and five values do not justify a join.
  constraint receipt_review_decisions_decision_allowed
    check (decision in ('VERIFIED', 'REJECTED')),

  -- ------------------------------------------------------------------------
  -- DECISION D3 — THE REJECTION VOCABULARY
  -- ------------------------------------------------------------------------
  -- Exactly the five reasons a reviewer can evidence from an image and submission
  -- metadata. See the header for why the three data-dependent reasons are absent.
  constraint receipt_review_decisions_reason_allowed
    check (
      rejection_reason is null
      or rejection_reason in (
        'UNREADABLE_RECEIPT',
        'MISSING_REQUIRED_INFORMATION',
        'INVALID_RECEIPT',
        'DUPLICATE_RECEIPT',
        'OTHER'
      )
    ),

  -- The reason and the decision must agree, in BOTH directions. Written as an
  -- equivalence rather than two one-way rules so neither half can be relaxed alone:
  -- a REJECTED row always carries a reason, and a VERIFIED row never does.
  constraint receipt_review_decisions_reason_matches_decision
    check ((decision = 'REJECTED') = (rejection_reason is not null)),

  -- ------------------------------------------------------------------------
  -- DECISION D4 — THE NOTE
  -- ------------------------------------------------------------------------
  -- Shape first: null, or trimmed and non-empty, and at most 500 characters. Stored
  -- trimmed so "   " can never masquerade as an explanation — the function normalises
  -- whitespace-only input to NULL before it reaches here, and this constraint makes
  -- that normalisation impossible to bypass by any other writer.
  constraint receipt_review_decisions_note_shape
    check (
      reviewer_note is null
      or (
        reviewer_note = btrim(reviewer_note)
        and length(reviewer_note) between 1 and 500
      )
    ),

  -- Then obligation: the three subjective reasons must be explained. INVALID_RECEIPT,
  -- DUPLICATE_RECEIPT and OTHER are judgements another person cannot reconstruct from
  -- the code alone — DUPLICATE especially, where the note is the only place the other
  -- receipt can be identified. UNREADABLE_RECEIPT and MISSING_REQUIRED_INFORMATION are
  -- self-evident from the image, so a note stays optional there.
  constraint receipt_review_decisions_note_required_for_reason
    check (
      rejection_reason is null
      or rejection_reason not in ('INVALID_RECEIPT', 'DUPLICATE_RECEIPT', 'OTHER')
      or reviewer_note is not null
    ),

  -- A VERIFIED decision MAY carry an optional note. It is Vendor-internal, subject to
  -- the same shape rule, and never shown to the Retailer in Phase 1C. Nothing forbids
  -- it and a reviewer occasionally needs to record why a marginal receipt was accepted.

  -- Timestamps must be coherent. decided_at is set by the function, created_at by the
  -- default; a row claiming to have been decided before it existed is nonsense.
  constraint receipt_review_decisions_timestamp_order
    check (decided_at >= created_at - interval '1 minute')
);

comment on table public.receipt_review_decisions is
  'Immutable final Claim Reviewer verdict for a submitted receipt. One row per receipt. Creates no reward, coin, balance or payout.';


-- ============================================================================
-- 3. IMMUTABILITY — DECISION D5
-- ============================================================================
-- A decision is a record of a judgement that was made at a moment. Editing it would
-- rewrite history, and deleting it would erase accountability for a call that may have
-- paid or refused money later.
--
-- UNQUALIFIED trigger (no `of column`), so no column and no no-op UPDATE slips through,
-- and DELETE is refused by the same function.
create function public.receipt_review_decisions_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A receipt review decision is immutable'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_review_decisions_guard_change
  before update or delete on public.receipt_review_decisions
  for each row execute function public.receipt_review_decisions_guard_change();

-- TRUNCATE needs its own STATEMENT-level trigger. Row triggers do not fire on TRUNCATE,
-- so the guard above would not see it — the same gap public.audit_logs_guard_truncate
-- exists to close.
create function public.receipt_review_decisions_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A receipt review decision is append-only and cannot be truncated'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_review_decisions_guard_truncate
  before truncate on public.receipt_review_decisions
  for each statement execute function public.receipt_review_decisions_guard_truncate();


-- ============================================================================
-- 4. TENANT ASSERTION — THE LAST LINE, NOT THE FIRST
-- ============================================================================
-- decide_claim_receipt already checks all of this. This trigger checks it AGAIN, at the
-- table, so that a future bug in that function — or a future second writer nobody has
-- written yet — still cannot record a cross-Vendor decision. Defence in depth is the
-- point: the function decides WHETHER to write, the trigger decides whether the row is
-- even legal.
create function public.receipt_review_decisions_assert_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission public.receipt_submissions%rowtype;
begin
  -- 1. The receipt must exist and be reviewable. RESERVED has no uploaded file and
  --    UPLOAD_FAILED has no usable one; neither can be judged.
  select * into v_submission
  from public.receipt_submissions s
  where s.id = new.receipt_submission_id;

  if v_submission.id is null then
    raise exception 'Referenced receipt submission does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  if v_submission.status <> 'SUBMITTED' then
    raise exception 'A receipt review decision requires a submitted receipt'
      using errcode = 'check_violation';
  end if;

  -- 2. The deciding Vendor must be an ACTIVE Vendor organization.
  if not exists (
    select 1
    from public.organizations o
    where o.id = new.vendor_organization_id
      and o.organization_type = 'VENDOR'
      and o.status = 'ACTIVE'
  ) then
    raise exception 'A receipt review decision requires an active Vendor organization'
      using errcode = 'check_violation';
  end if;

  -- 3. THE TENANT BOUNDARY. receipt_submissions has no Vendor column, so the only path
  --    from a receipt to a Vendor is the vendor_retailers relationship, and it must be
  --    ACTIVE at decision time. This is the check that makes a cross-Vendor decision
  --    impossible rather than merely unlikely.
  if not exists (
    select 1
    from public.vendor_retailers vr
    where vr.vendor_organization_id = new.vendor_organization_id
      and vr.retailer_organization_id = v_submission.retailer_organization_id
      and vr.status = 'ACTIVE'
  ) then
    raise exception 'The deciding Vendor has no active relationship with this receipt''s Retailer'
      using errcode = 'check_violation';
  end if;

  -- 4. The decider must be an ACTIVE member of that same Vendor, holding CLAIM_REVIEWER,
  --    and that role must actually carry RECEIPT_REVIEW_DECIDE. Checking the PERMISSION
  --    rather than only the role code means revoking the mapping is a real kill switch:
  --    remove it and no further decision can be written by anyone, from any path.
  if not exists (
    select 1
    from public.organization_members m
    join public.profiles p        on p.id = m.user_id
    join public.member_roles mr   on mr.organization_member_id = m.id
    join public.roles r           on r.id = mr.role_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions perm  on perm.id = rp.permission_id
    where m.user_id = new.decided_by_profile_id
      and m.organization_id = new.vendor_organization_id
      and m.status = 'ACTIVE'
      and p.status = 'ACTIVE'
      and r.status = 'ACTIVE'
      and r.code = 'CLAIM_REVIEWER'
      and perm.code = 'RECEIPT_REVIEW_DECIDE'
  ) then
    raise exception 'A receipt review decision requires an active CLAIM_REVIEWER holding RECEIPT_REVIEW_DECIDE in the deciding Vendor'
      using errcode = 'check_violation';
  end if;

  -- DECISION D7, stated as an absence: the receipt's submitting staff member and shop
  -- are NOT required to still be active. A receipt validly submitted by someone who has
  -- since left is still a real claim, and hiding it would strand it forever.

  return new;
end;
$$;

create trigger receipt_review_decisions_assert_tenant
  before insert on public.receipt_review_decisions
  for each row execute function public.receipt_review_decisions_assert_tenant();


-- ============================================================================
-- 5. TABLE PRIVILEGES AND RLS
-- ============================================================================
-- RLS enabled with ZERO policies, matching every receipt table. There is no policy to
-- get wrong, and no direct read or write for any browser role: everything goes through
-- the SECURITY DEFINER functions below, which run as the owner and are unaffected.
alter table public.receipt_review_decisions enable row level security;

revoke all on table public.receipt_review_decisions from public;
revoke all on table public.receipt_review_decisions from anon;
revoke all on table public.receipt_review_decisions from authenticated;
-- service_role TOO. Supabase's default privileges grant ALL on a new public table to
-- service_role, and revoking only from public/anon/authenticated leaves REFERENCES,
-- TRIGGER and TRUNCATE behind. TRUNCATE is the one that matters: it BYPASSES ROW
-- TRIGGERS, so it would defeat the immutability guard outright. The statement-level
-- truncate trigger above closes that too, but both together is the shipped pattern.
revoke all on table public.receipt_review_decisions from service_role;

revoke all on function public.receipt_review_decisions_guard_change() from public;
revoke all on function public.receipt_review_decisions_guard_truncate() from public;
revoke all on function public.receipt_review_decisions_assert_tenant() from public;


-- ============================================================================
-- 6. INDEXES
-- ============================================================================
-- Three, each earning its place. Nothing duplicates the primary key or the unique
-- constraint on receipt_submission_id (which already indexes the anti-join key and the
-- decision lookup by receipt).

-- (a) THE QUEUE. Partial on status so the index holds only reviewable receipts, and
--     ordered exactly as the queue reads — (submitted_at, id) is the keyset cursor pair,
--     so this serves the ORDER BY and the seek in one structure.
create index receipt_submissions_review_queue_idx
  on public.receipt_submissions (submitted_at asc, id asc)
  where status = 'SUBMITTED';

-- (b) VENDOR DECISION HISTORY. Newest first, the order any history view wants.
create index receipt_review_decisions_vendor_decided_idx
  on public.receipt_review_decisions (vendor_organization_id, decided_at desc);

-- (c) THE RETAILER JOIN. The queue resolves a Vendor to its Retailers on every read,
--     and only the ACTIVE links matter.
create index vendor_retailers_vendor_active_idx
  on public.vendor_retailers (vendor_organization_id, retailer_organization_id)
  where status = 'ACTIVE';

-- Deliberately NOT created: an index on receipt_review_decisions(receipt_submission_id)
-- — the unique constraint already provides it — and one on
-- receipt_submissions(retailer_organization_id) — receipt_submissions_retailer_created_idx
-- already leads with that column.


-- ============================================================================
-- 7. INTERNAL: THE REVIEWER'S VENDOR, FOR A SPECIFIC PERMISSION
-- ============================================================================
-- Phase 1B's public.resolve_claim_reviewer_organization(text) already does exactly this
-- job: it takes a permission code, resolves the caller from auth.uid() alone, and
-- returns the single qualifying ACTIVE Vendor or NULL. It is reused here rather than
-- reimplemented, so there is ONE definition of "which Vendor is this reviewer's" and a
-- change to that rule cannot apply to the portal but not the queue.
--
-- Its privilege boundary is preserved exactly: it remains revoked from PUBLIC, anon and
-- authenticated, reachable only from inside SECURITY DEFINER functions owned by the same
-- role. This migration does not touch its definition or its grants.
--
-- It fails closed in both directions that matter: zero qualifying Vendors returns NULL,
-- and MORE than one also returns NULL rather than picking one.


-- ============================================================================
-- 8. THE QUEUE
-- ============================================================================
create function public.list_claim_review_queue(
  p_limit               integer     default 25,
  p_after_submitted_at  timestamptz default null,
  p_after_submission_id uuid        default null,
  p_retailer_id         uuid        default null,
  p_shop_id             uuid        default null,
  p_submitted_from      timestamptz default null,
  p_submitted_to        timestamptz default null
)
returns table (
  receipt_submission_id uuid,
  retailer_name         text,
  shop_name             text,
  shop_code             text,
  shop_status           text,
  submitter_name        text,
  submitter_status      text,
  submitted_at          timestamptz,
  mime_type             text,
  file_size_bytes       bigint,
  original_file_name    text,
  has_duplicate_hash    boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
  v_limit  integer;
begin
  -- ------------------------------------------------------------------------
  -- Authorization. RECEIPT_REVIEW_READ, resolved from auth.uid() and nothing else.
  -- ------------------------------------------------------------------------
  -- The function takes NO Vendor argument, so a caller cannot nominate a tenant. NULL
  -- means "not a reviewer, or not one with this permission, or ambiguous" — all of which
  -- return zero rows rather than an error, so this cannot be used to probe.
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ');
  if v_vendor is null then
    return;
  end if;

  -- ------------------------------------------------------------------------
  -- The cursor pair is all-or-nothing.
  -- ------------------------------------------------------------------------
  -- A half-supplied cursor is a caller bug, and silently ignoring it would skip or
  -- repeat rows without anyone noticing. Refused loudly, with a message that names no
  -- data.
  if (p_after_submitted_at is null) <> (p_after_submission_id is null) then
    raise exception 'Both cursor values must be supplied together, or neither'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Limit clamped rather than rejected: 25 by default, never less than 1, never more
  -- than 100. A caller asking for a million rows gets a page, not an outage.
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);

  return query
  select
    s.id,
    ro.name,
    sh.name,
    sh.code,
    sh.status,
    -- Display name only. Never the submitter's email, phone or id.
    (sp.first_name || ' ' || sp.last_name)::text,
    -- DECISION D7: the current state is CONTEXT, not a filter. A receipt from a staff
    -- member who has since been deactivated stays in the queue, labelled.
    coalesce(sm.status, 'UNKNOWN'),
    s.submitted_at,
    s.mime_type,
    s.file_size_bytes,
    s.original_file_name,
    -- A duplicate INDICATOR, not the hash. True when the same bytes were submitted more
    -- than once anywhere; the reviewer is told there is something to look at without
    -- being handed a file-identity oracle.
    exists (
      select 1
      from public.receipt_submissions d
      where d.file_sha256 = s.file_sha256
        and d.id <> s.id
        and d.status <> 'UPLOAD_FAILED'
    )
  from public.receipt_submissions s
  join public.organizations ro on ro.id = s.retailer_organization_id
  join public.retailer_shops sh on sh.id = s.retailer_shop_id
  join public.profiles sp on sp.id = s.submitted_by_profile_id
  -- The submitter's membership in the receipt's own Retailer, for context only. LEFT so
  -- a removed membership does not remove the receipt.
  left join public.organization_members sm
    on sm.user_id = s.submitted_by_profile_id
   and sm.organization_id = s.retailer_organization_id
  where
    -- DECISION D6: only a submitted receipt, and only one whose file actually landed.
    s.status = 'SUBMITTED'
    and s.submitted_at is not null

    -- THE TENANT BOUNDARY, in the database. The receipt's Retailer must have an ACTIVE
    -- link to the reviewer's Vendor. Deactivate the link and the receipts leave the
    -- queue immediately.
    and exists (
      select 1
      from public.vendor_retailers vr
      where vr.vendor_organization_id = v_vendor
        and vr.retailer_organization_id = s.retailer_organization_id
        and vr.status = 'ACTIVE'
    )

    -- A stored object must really exist. A row whose upload silently vanished is not
    -- reviewable, and showing it would waste a reviewer's time on a blank image.
    and exists (
      select 1
      from storage.objects so
      where so.bucket_id = s.storage_bucket
        and so.name = s.storage_object_path
    )

    -- Already decided receipts leave the ACTIVE queue. They remain readable through
    -- get_claim_review_detail, which is where a decided receipt belongs.
    and not exists (
      select 1
      from public.receipt_review_decisions rd
      where rd.receipt_submission_id = s.id
    )

    -- Optional filters. Each is a plain equality against a value that has ALREADY been
    -- constrained to this Vendor's receipts by the clause above — so a caller who
    -- supplies a foreign Retailer or shop id simply matches nothing. They learn that
    -- zero receipts match, which is true, and nothing about whether that id exists.
    and (p_retailer_id is null or s.retailer_organization_id = p_retailer_id)
    and (p_shop_id is null or s.retailer_shop_id = p_shop_id)
    and (p_submitted_from is null or s.submitted_at >= p_submitted_from)
    and (p_submitted_to is null or s.submitted_at <= p_submitted_to)

    -- DECISION D2 + D9: keyset seek. Row-value comparison so the (submitted_at, id)
    -- pair is compared as one ordered tuple, which is exactly what the index provides
    -- and what makes the page boundary exact even when many receipts share a timestamp.
    and (
      p_after_submitted_at is null
      or (s.submitted_at, s.id) > (p_after_submitted_at, p_after_submission_id)
    )
  -- Oldest first so nothing starves, with the id as a total tiebreak. Without the
  -- tiebreak, receipts sharing a submitted_at could repeat or vanish across pages.
  order by s.submitted_at asc, s.id asc
  limit v_limit;
end;
$$;

revoke all     on function public.list_claim_review_queue(integer, timestamptz, uuid, uuid, uuid, timestamptz, timestamptz) from public;
revoke execute on function public.list_claim_review_queue(integer, timestamptz, uuid, uuid, uuid, timestamptz, timestamptz) from anon;
grant  execute on function public.list_claim_review_queue(integer, timestamptz, uuid, uuid, uuid, timestamptz, timestamptz) to authenticated;


-- ============================================================================
-- 9. THE QUEUE COUNT
-- ============================================================================
-- Separate from the listing so a page fetch does not pay for a full count, and so the
-- header can show a total without reading rows.
--
-- The eligibility predicate is REPEATED here rather than shared. That is a deliberate
-- trade: a shared SQL helper would either have to take the Vendor as an argument — a new
-- executable surface that bypasses the permission check, exactly what must not exist —
-- or repeat the resolver anyway. The two predicates are pinned identical by a test that
-- compares the count against the length of an unpaginated listing, so drift fails loudly
-- rather than silently under-reporting a reviewer's workload.
create function public.count_claim_review_queue(
  p_retailer_id    uuid        default null,
  p_shop_id        uuid        default null,
  p_submitted_from timestamptz default null,
  p_submitted_to   timestamptz default null
)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
  v_count  bigint;
begin
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ');
  if v_vendor is null then
    -- Zero, not NULL and not an error: an unauthorized caller sees an empty queue,
    -- which is indistinguishable from an authorized caller with nothing to do.
    return 0::bigint;
  end if;

  select count(*)
  into v_count
  from public.receipt_submissions s
  where s.status = 'SUBMITTED'
    and s.submitted_at is not null
    and exists (
      select 1 from public.vendor_retailers vr
      where vr.vendor_organization_id = v_vendor
        and vr.retailer_organization_id = s.retailer_organization_id
        and vr.status = 'ACTIVE'
    )
    and exists (
      select 1 from storage.objects so
      where so.bucket_id = s.storage_bucket
        and so.name = s.storage_object_path
    )
    and not exists (
      select 1 from public.receipt_review_decisions rd
      where rd.receipt_submission_id = s.id
    )
    and (p_retailer_id is null or s.retailer_organization_id = p_retailer_id)
    and (p_shop_id is null or s.retailer_shop_id = p_shop_id)
    and (p_submitted_from is null or s.submitted_at >= p_submitted_from)
    and (p_submitted_to is null or s.submitted_at <= p_submitted_to);

  return v_count;
end;
$$;

revoke all     on function public.count_claim_review_queue(uuid, uuid, timestamptz, timestamptz) from public;
revoke execute on function public.count_claim_review_queue(uuid, uuid, timestamptz, timestamptz) from anon;
grant  execute on function public.count_claim_review_queue(uuid, uuid, timestamptz, timestamptz) to authenticated;


-- ============================================================================
-- 10. THE DETAIL
-- ============================================================================
-- One receipt, if and only if the caller may see it.
--
-- ZERO ROWS IS THE ONLY REFUSAL, and it is returned for every cause alike: the receipt
-- does not exist, it belongs to another Vendor, the link was deactivated, the caller is
-- not a reviewer. A caller cannot tell which, so this cannot be used to discover whether
-- a given receipt id exists.
--
-- Unlike the queue, this DOES serve already-decided receipts — a reviewer must be able
-- to look back at what was decided, and a stale browser tab must render something
-- truthful rather than a blank page.
create function public.get_claim_review_detail(
  p_submission_id uuid
)
returns table (
  receipt_submission_id uuid,
  retailer_name         text,
  shop_name             text,
  shop_code             text,
  shop_status           text,
  submitter_name        text,
  submitter_status      text,
  submitted_at          timestamptz,
  mime_type             text,
  file_size_bytes       bigint,
  original_file_name    text,
  has_duplicate_hash    boolean,
  extraction_status     text,
  has_retailer_confirmation boolean,
  decision              text,
  rejection_reason      text,
  reviewer_note         text,
  decided_at            timestamptz,
  decided_by_name       text
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
    s.id,
    ro.name,
    sh.name,
    sh.code,
    sh.status,
    (sp.first_name || ' ' || sp.last_name)::text,
    coalesce(sm.status, 'UNKNOWN'),
    s.submitted_at,
    s.mime_type,
    s.file_size_bytes,
    s.original_file_name,
    exists (
      select 1 from public.receipt_submissions d
      where d.file_sha256 = s.file_sha256
        and d.id <> s.id
        and d.status <> 'UPLOAD_FAILED'
    ),
    -- Extraction AVAILABILITY, as a word. With runtime mode DISABLED this is 'NONE' for
    -- every receipt today; it is surfaced so the UI can say "no extracted data" honestly
    -- rather than implying data was read and rejected.
    coalesce(
      (
        select e.status
        from public.receipt_extractions e
        where e.receipt_submission_id = s.id
        order by e.attempt_number desc
        limit 1
      ),
      'NONE'
    ),
    -- Whether the RETAILER confirmed the transaction data. A boolean, not the data:
    -- with zero confirmations in existence there is nothing to show, and when there is,
    -- exposing it belongs to a milestone that has decided how a reviewer should weigh it.
    exists (
      select 1 from public.receipt_confirmations rc
      where rc.receipt_submission_id = s.id
    ),
    rd.decision,
    rd.rejection_reason,
    -- The note IS returned. It is Vendor-internal, written by a reviewer for reviewers,
    -- and withholding it would make an already-decided receipt unexplainable to the next
    -- person who opens it. It is never shown to the Retailer, and never logged.
    rd.reviewer_note,
    rd.decided_at,
    -- The deciding reviewer's display NAME, never their profile id.
    (dp.first_name || ' ' || dp.last_name)::text
  from public.receipt_submissions s
  join public.organizations ro on ro.id = s.retailer_organization_id
  join public.retailer_shops sh on sh.id = s.retailer_shop_id
  join public.profiles sp on sp.id = s.submitted_by_profile_id
  left join public.organization_members sm
    on sm.user_id = s.submitted_by_profile_id
   and sm.organization_id = s.retailer_organization_id
  left join public.receipt_review_decisions rd on rd.receipt_submission_id = s.id
  left join public.profiles dp on dp.id = rd.decided_by_profile_id
  where s.id = p_submission_id
    and s.status = 'SUBMITTED'
    and exists (
      select 1 from public.vendor_retailers vr
      where vr.vendor_organization_id = v_vendor
        and vr.retailer_organization_id = s.retailer_organization_id
        and vr.status = 'ACTIVE'
    );
end;
$$;

revoke all     on function public.get_claim_review_detail(uuid) from public;
revoke execute on function public.get_claim_review_detail(uuid) from anon;
grant  execute on function public.get_claim_review_detail(uuid) to authenticated;


-- ============================================================================
-- 11. THE DECISION
-- ============================================================================
-- The only way a verdict is ever written.
--
-- It accepts a receipt, a decision, a reason and a note — and NOTHING ELSE. No Vendor
-- id, no reviewer id, no membership id, no timestamp, no audit actor, no idempotency
-- key. Every one of those is derived server-side from auth.uid(), so there is no
-- parameter a caller could substitute to act as someone else, for someone else, or at
-- a time of their choosing.
create function public.decide_claim_receipt(
  p_submission_id    uuid,
  p_decision         text,
  p_rejection_reason text default null,
  p_reviewer_note    text default null
)
returns table (
  outcome          text,
  decision         text,
  rejection_reason text,
  decided_at       timestamptz,
  changed          boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor     uuid;
  v_actor      uuid;
  v_note       text;
  v_submission public.receipt_submissions%rowtype;
  v_existing   public.receipt_review_decisions%rowtype;
  v_rows       integer;
  v_action     text;
  v_new        public.receipt_review_decisions%rowtype;
begin
  -- ------------------------------------------------------------------------
  -- 1. Authorization — RECEIPT_REVIEW_DECIDE, not merely the portal permission
  -- ------------------------------------------------------------------------
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_DECIDE');
  if v_vendor is null then
    -- The SAME generic refusal a wrong-tenant receipt produces. It does not distinguish
    -- "you are not a reviewer" from "you may read but not decide".
    raise exception 'This receipt is not available for review'
      using errcode = 'insufficient_privilege';
  end if;

  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'This receipt is not available for review'
      using errcode = 'insufficient_privilege';
  end if;

  -- ------------------------------------------------------------------------
  -- 2. Validate the input — before any lock is taken
  -- ------------------------------------------------------------------------
  if p_submission_id is null then
    raise exception 'A receipt must be supplied'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_decision is null or p_decision not in ('VERIFIED', 'REJECTED') then
    raise exception 'A decision must be VERIFIED or REJECTED'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_decision = 'VERIFIED' and p_rejection_reason is not null then
    raise exception 'A verified receipt must not carry a rejection reason'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_decision = 'REJECTED' then
    if p_rejection_reason is null then
      raise exception 'A rejected receipt requires a rejection reason'
        using errcode = 'invalid_parameter_value';
    end if;
    if p_rejection_reason not in (
      'UNREADABLE_RECEIPT',
      'MISSING_REQUIRED_INFORMATION',
      'INVALID_RECEIPT',
      'DUPLICATE_RECEIPT',
      'OTHER'
    ) then
      raise exception 'That rejection reason is not recognised'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- Normalise the note ONCE, here. Whitespace-only becomes absent, so a reviewer cannot
  -- satisfy a mandatory-note rule by pressing the space bar.
  v_note := nullif(btrim(coalesce(p_reviewer_note, '')), '');

  if v_note is not null and length(v_note) > 500 then
    raise exception 'A reviewer note may be at most 500 characters'
      using errcode = 'invalid_parameter_value';
  end if;

  -- DECISION D4: the three subjective reasons must be explained.
  if p_decision = 'REJECTED'
     and p_rejection_reason in ('INVALID_RECEIPT', 'DUPLICATE_RECEIPT', 'OTHER')
     and v_note is null then
    raise exception 'That rejection reason requires a reviewer note'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ------------------------------------------------------------------------
  -- 3. LOCK THE RECEIPT — the serialization point
  -- ------------------------------------------------------------------------
  -- Two reviewers contend for the RECEIPT, so that is what is locked. The second one
  -- blocks here until the first commits, then re-reads and finds the existing decision
  -- in step 5 rather than racing it. Taken before any tenant check so the check itself
  -- cannot be raced.
  select * into v_submission
  from public.receipt_submissions s
  where s.id = p_submission_id
  for update;

  -- ------------------------------------------------------------------------
  -- 4. Re-check tenancy and state INSIDE the transaction
  -- ------------------------------------------------------------------------
  -- Not-found and wrong-tenant raise the SAME exception, so a caller cannot probe for
  -- the existence of a receipt id.
  if v_submission.id is null
     or v_submission.status <> 'SUBMITTED'
     or not exists (
       select 1
       from public.vendor_retailers vr
       where vr.vendor_organization_id = v_vendor
         and vr.retailer_organization_id = v_submission.retailer_organization_id
         and vr.status = 'ACTIVE'
     ) then
    raise exception 'This receipt is not available for review'
      using errcode = 'insufficient_privilege';
  end if;

  -- ------------------------------------------------------------------------
  -- 5. The immutable insert, and what its ROW_COUNT means
  -- ------------------------------------------------------------------------
  -- ON CONFLICT DO NOTHING against the unique constraint, then GET DIAGNOSTICS. The
  -- real row count is the ONLY signal used: a read-then-write check would have a window,
  -- and a flag derived from anything else could be wrong.
  insert into public.receipt_review_decisions (
    receipt_submission_id, vendor_organization_id, decision,
    rejection_reason, reviewer_note, decided_by_profile_id
  )
  values (
    p_submission_id, v_vendor, p_decision,
    p_rejection_reason, v_note, v_actor
  )
  on conflict (receipt_submission_id) do nothing
  returning * into v_new;

  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    -- A real, first decision. Audit it — exactly once, here, and nowhere else.
    v_action := case when p_decision = 'VERIFIED'
                     then 'RECEIPT_VERIFIED'
                     else 'RECEIPT_REJECTED' end;

    insert into public.audit_logs (
      organization_id, actor_profile_id, action, entity_type, entity_id, metadata
    )
    values (
      v_vendor,
      v_actor,
      v_action,
      'RECEIPT_SUBMISSION',
      p_submission_id::text,
      -- Three keys, all non-personal. The note's TEXT is deliberately absent — only
      -- whether one exists — because a note can quote a customer, a name or an amount,
      -- and the audit log is readable by everyone holding AUDIT_LOGS_READ. No image
      -- URL, bucket, path, hash, submitter identity or UUID appears here either.
      jsonb_build_object(
        'decision', p_decision,
        'rejection_reason', p_rejection_reason,
        'note_present', (v_note is not null)
      )
    );

    outcome          := 'DECIDED';
    decision         := v_new.decision;
    rejection_reason := v_new.rejection_reason;
    decided_at       := v_new.decided_at;
    changed          := true;
    return next;
    return;
  end if;

  -- ------------------------------------------------------------------------
  -- 6. A decision already exists — idempotent, or a genuine conflict
  -- ------------------------------------------------------------------------
  select * into v_existing
  from public.receipt_review_decisions rd
  where rd.receipt_submission_id = p_submission_id;

  if v_existing.id is null then
    -- Neither inserted nor found. Should be unreachable while the unique constraint
    -- exists; refused rather than guessed at.
    raise exception 'This receipt is not available for review'
      using errcode = 'insufficient_privilege';
  end if;

  -- ALREADY_DECIDED is granted only when this is genuinely the SAME request repeated:
  -- same reviewer, same decision, same reason, same note. A browser retry or a
  -- double-click lands here and is a safe no-op.
  --
  -- The same-reviewer requirement matters. Without it, a SECOND reviewer who happened to
  -- choose the identical verdict would be told "already decided" as though it were
  -- their own — quietly attributing to them a call they did not make, and hiding from
  -- them that someone else had already judged it.
  if v_existing.decided_by_profile_id = v_actor
     and v_existing.decision = p_decision
     and v_existing.rejection_reason is not distinct from p_rejection_reason
     and v_existing.reviewer_note is not distinct from v_note then
    outcome          := 'ALREADY_DECIDED';
    decision         := v_existing.decision;
    rejection_reason := v_existing.rejection_reason;
    decided_at       := v_existing.decided_at;
    changed          := false;
    return next;
    return;
  end if;

  -- Everything else is a CONFLICT: a different verdict, a different reason, a different
  -- note, or a different reviewer.
  --
  -- Returned as a ROW rather than raised as an exception, deliberately. This is the
  -- expected outcome of a stale detail page, and the caller needs to render "already
  -- decided as X" — which it cannot do from an error. The ORIGINAL decision is returned
  -- and is never touched; the deciding reviewer's identity is disclosed only as the
  -- decision itself, never as a profile id.
  outcome          := 'CONFLICT';
  decision         := v_existing.decision;
  rejection_reason := v_existing.rejection_reason;
  decided_at       := v_existing.decided_at;
  changed          := false;
  return next;
end;
$$;

revoke all     on function public.decide_claim_receipt(uuid, text, text, text) from public;
revoke execute on function public.decide_claim_receipt(uuid, text, text, text) from anon;
grant  execute on function public.decide_claim_receipt(uuid, text, text, text) to authenticated;


-- ============================================================================
-- 12. THE PRIVATE OBJECT REFERENCE — SERVICE ROLE ONLY
-- ============================================================================
-- The one place a bucket and an object path are ever returned, and it is unreachable
-- from a browser.
--
-- HOW IT IS MEANT TO BE USED, in a later milestone: a Web Route Handler authorizes the
-- signed-in reviewer through get_claim_review_detail() using the ordinary authenticated
-- client, and ONLY if that returns a row does it call this function through a
-- server-only service-role client, then streams the bytes. The browser receives image
-- data and never a bucket, a path or a URL it could replay.
--
-- WHY NOT A SIGNED URL: it is a bearer capability that outlives the authorization check
-- and lands in browser history and referrer headers. WHY NOT A storage.objects SELECT
-- POLICY: the `receipts` bucket has zero storage policies by design — the submit path
-- already rejected an INSERT policy on exactly these grounds — and adding a read policy
-- would make the private bucket readable by rules rather than by code.
--
-- It performs NO authorization of its own, and must not be relied on for any: it is
-- service-role-only precisely because its caller has already done that work. This
-- mirrors the shipped public.get_receipt_object_reference.
create function public.get_claim_review_object_reference(
  p_submission_id uuid
)
returns table (
  storage_bucket      text,
  storage_object_path text,
  mime_type           text,
  file_size_bytes     bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.storage_bucket, s.storage_object_path, s.mime_type, s.file_size_bytes
  from public.receipt_submissions s
  where s.id = p_submission_id
    and s.status = 'SUBMITTED';
$$;

revoke all     on function public.get_claim_review_object_reference(uuid) from public;
revoke execute on function public.get_claim_review_object_reference(uuid) from anon;
revoke execute on function public.get_claim_review_object_reference(uuid) from authenticated;
grant  execute on function public.get_claim_review_object_reference(uuid) to service_role;


-- ============================================================================
-- CLOSING NOTE
-- ============================================================================
-- One table, five callable functions, three trigger functions, three indexes, two
-- permissions and two mappings. Nothing else exists in this migration.
--
-- No existing receipt row is read for modification, updated or deleted. No receipt
-- confirmation, extraction or decision is created. receipt_extraction_runtime is not
-- touched, so extraction remains DISABLED. No storage policy is added and the receipts
-- bucket stays private. No reward, coin, balance or payout object is created — none
-- exists. public.get_my_portal_context, its context_version and the portal_kind
-- vocabulary are untouched, so the Flutter contract is unchanged.
--
-- KILL SWITCH: deleting the two role_permissions rows added above stops every read and
-- every decision immediately, from every path — the functions resolve through the
-- permission, and the tenant-assert trigger re-checks RECEIPT_REVIEW_DECIDE at the
-- table. Decisions already recorded, and their audit events, survive untouched.
