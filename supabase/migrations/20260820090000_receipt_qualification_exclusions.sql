-- Migration: receipt_qualification_exclusions
-- Purpose: Phase 1D-0. An append-only, audited way to say "this receipt may not
--          proceed toward a sale or a reward" WITHOUT touching its review decision.
--
--   1 permission   RECEIPT_QUALIFICATION_CLASSIFY   -> CLAIM_REVIEWER only
--   1 table        public.receipt_qualification_events   (append-only)
--   4 functions    2 guards + 1 tenant assertion + 1 internal effective-state helper
--   2 RPCs         get_claim_receipt_qualification, record_claim_receipt_qualification
--   3 indexes
--
-- ============================================================================
-- TWO DIFFERENT QUESTIONS, TWO DIFFERENT RECORDS
-- ============================================================================
-- public.receipt_review_decisions answers ONE question:
--
--     "Was the submitted IMAGE accepted or rejected during image review?"
--
-- This table answers a DIFFERENT one:
--
--     "May this record proceed toward an authoritative sale, campaign
--      qualification and a reward?"
--
-- They are deliberately not the same column, the same row or the same table. The
-- immediate reason is concrete: a receipt in the hosted project carries a VERIFIED
-- decision, and the image turned out to be a desktop screenshot rather than a
-- customer receipt. That decision is immutable and correct as history — a reviewer
-- did look at the image and did accept it — and it must stay visible exactly as it
-- is. What must change is only what happens NEXT.
--
-- Collapsing the two into one status would force a choice between rewriting review
-- history and letting test data earn coins. This table refuses that choice.
--
-- An effective exclusion means, precisely:
--   * the review decision remains VERIFIED and remains visible;
--   * the receipt remains in immutable review history;
--   * no authoritative sale may be finalized from it;
--   * no campaign qualification may evaluate it;
--   * no reward, coin, balance or payout may be created from it.
--
-- ============================================================================
-- WHY EVENTS RATHER THAN A STATUS COLUMN
-- ============================================================================
-- A mutable `is_excluded` column would answer "is it excluded now" and destroy
-- "who excluded it, when, why, and did anyone change their mind". For a control
-- whose entire job is to keep test data out of a financial calculation, the second
-- question is the one an auditor asks.
--
-- So the table stores EVENTS and the current state is DERIVED: an exclusion is
-- active exactly while no reinstatement references it. Reversal is another event,
-- never an UPDATE and never a DELETE. Nothing here can be rewritten.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
-- No verified_sales. No reward, coin, ledger, balance or payout object. No campaign
-- evaluation. No OCR. Phase 1D-0 builds the gate BEFORE the thing it guards, so the
-- exclusion already exists on the day sale finalization is written and there is
-- never a window in which test data could qualify.
--
-- Idempotency posture: plain CREATE for every object (no CREATE OR REPLACE) so a
--   conflicting existing object FAILS the migration rather than being silently
--   replaced. Permission seeding uses the established ON CONFLICT upsert. No
--   existing object is altered. No existing row is modified or deleted. No dynamic
--   SQL. Every reference is schema-qualified because the functions run with an
--   EMPTY search_path.
--
-- Dependencies: 20260716125559 (RBAC), 20260716130351 (audit_logs),
--   20260812210000 (receipt_submissions), 20260818210000
--   (resolve_claim_reviewer_organization), 20260819090000
--   (receipt_review_decisions).


-- ============================================================================
-- 1. THE PERMISSION
-- ============================================================================
-- Fail loud if the role is missing. A silent no-op here would leave the permission
-- created but unreachable, and the first symptom would be a reviewer being denied
-- with no explanation.
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
    'RECEIPT_QUALIFICATION_CLASSIFY',
    'Classify a receipt for qualification',
    'Record or reverse an append-only exclusion that stops a receipt proceeding toward an authoritative sale, campaign qualification or reward. Does not change the receipt review decision, and grants no ability to create a sale, reward, coin, balance or payout.',
    'CLAIM_REVIEW'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- CLAIM_REVIEWER and nothing else. Not Vendor Super Admin: deciding that a receipt
-- is test data is a claim-review judgement about an image somebody looked at, and
-- the reviewer is the only role that has already seen it. Not Finance Admin either
-- — this is not a money operation, it is a statement about evidence.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'RECEIPT_QUALIFICATION_CLASSIFY'
where r.code = 'CLAIM_REVIEWER'
on conflict (role_id, permission_id) do nothing;


-- ============================================================================
-- 2. THE EVENT TABLE
-- ============================================================================
create table public.receipt_qualification_events (
  id                      uuid        primary key default gen_random_uuid(),

  receipt_submission_id   uuid        not null
                            references public.receipt_submissions (id) on delete restrict,

  -- The Vendor whose reviewer made the classification. RESTRICT everywhere: a
  -- financial-control record must never disappear because a parent row was removed.
  vendor_organization_id  uuid        not null
                            references public.organizations (id) on delete restrict,

  event_type              text        not null,
  exclusion_reason        text        null,
  reviewer_note           text        null,

  -- Set only on a REINSTATED event, naming the exclusion it reverses.
  reverses_event_id       uuid        null
                            references public.receipt_qualification_events (id) on delete restrict,

  classified_by_profile_id uuid       not null
                            references public.profiles (id) on delete restrict,

  classified_at           timestamptz not null default now(),
  created_at              timestamptz not null default now(),

  constraint receipt_qualification_events_type_allowed
    check (event_type in ('EXCLUDED', 'REINSTATED')),

  constraint receipt_qualification_events_reason_allowed
    check (
      exclusion_reason is null
      or exclusion_reason in ('TEST_DATA', 'NON_QUALIFYING', 'DUPLICATE')
    ),

  -- The two event shapes, stated as biconditionals so neither can drift:
  --   EXCLUDED   carries a reason and never a reversal target
  --   REINSTATED carries a reversal target and never a reason
  constraint receipt_qualification_events_reason_shape
    check ((event_type = 'EXCLUDED') = (exclusion_reason is not null)),

  constraint receipt_qualification_events_reversal_shape
    check ((event_type = 'REINSTATED') = (reverses_event_id is not null)),

  constraint receipt_qualification_events_note_shape
    check (
      reviewer_note is null
      or (
        reviewer_note = btrim(reviewer_note)
        and length(reviewer_note) between 1 and 500
      )
    ),

  -- NON_QUALIFYING asserts a judgement the image alone cannot evidence — "this is
  -- real but does not count" — so the reasoning has to be written down. TEST_DATA
  -- and DUPLICATE are self-describing and the note stays optional.
  constraint receipt_qualification_events_note_required
    check (exclusion_reason is distinct from 'NON_QUALIFYING' or reviewer_note is not null),

  constraint receipt_qualification_events_classified_at_sane
    check (classified_at >= created_at - interval '1 minute')
);

-- ONE reversal per exclusion, enforced by the database rather than by whoever calls
-- it. A plain UNIQUE permits many NULLs, which is exactly right: every EXCLUDED row
-- has a NULL here and only REINSTATED rows compete.
create unique index receipt_qualification_events_one_reversal_idx
  on public.receipt_qualification_events (reverses_event_id)
  where reverses_event_id is not null;

comment on table public.receipt_qualification_events is
  'Append-only record of whether a receipt may proceed toward an authoritative sale and reward. Separate from receipt_review_decisions, which records only the image decision and is never changed by this table.';


-- ============================================================================
-- 3. IMMUTABILITY
-- ============================================================================
create function public.receipt_qualification_events_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A receipt qualification event is immutable; record a reversing event instead'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_qualification_events_guard_change
  before update or delete on public.receipt_qualification_events
  for each row execute function public.receipt_qualification_events_guard_change();

-- TRUNCATE needs its own STATEMENT-level trigger: row triggers do not fire on
-- TRUNCATE, so the guard above would not see it. Same gap public.audit_logs_guard_truncate
-- and public.receipt_review_decisions_guard_truncate exist to close.
create function public.receipt_qualification_events_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Receipt qualification events are append-only and cannot be truncated'
    using errcode = 'check_violation';
end;
$$;

create trigger receipt_qualification_events_guard_truncate
  before truncate on public.receipt_qualification_events
  for each statement execute function public.receipt_qualification_events_guard_truncate();


-- ============================================================================
-- 4. TENANT AND ACTOR ASSERTION — THE LAST LINE, NOT THE FIRST
-- ============================================================================
-- record_claim_receipt_qualification already checks all of this. This trigger checks
-- it AGAIN, at the table, so a future bug in that function — or a second writer
-- nobody has written yet — still cannot record an illegal classification. The
-- function decides WHETHER to write; the trigger decides whether the row is legal.
--
-- Deliberately NOT checked: whether the receipt's shop or submitting staff member is
-- still ACTIVE. A receipt submitted months ago by someone who has since left is
-- exactly the kind of record most likely to need classifying, and refusing it would
-- strand it permanently.
create function public.receipt_qualification_events_assert_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submission public.receipt_submissions%rowtype;
  v_decision   public.receipt_review_decisions%rowtype;
  v_prior      public.receipt_qualification_events%rowtype;
begin
  -- 1 & 2. The receipt exists and is a real submission.
  select * into v_submission
  from public.receipt_submissions s
  where s.id = new.receipt_submission_id;

  if v_submission.id is null or v_submission.status <> 'SUBMITTED' then
    raise exception 'That receipt cannot be classified'
      using errcode = 'check_violation';
  end if;

  -- 3 & 4. It has a final review decision and that decision is VERIFIED. A REJECTED
  -- receipt is already out of the reward path by virtue of being rejected; excluding
  -- it would add a second, redundant control and imply the rejection was not enough.
  select * into v_decision
  from public.receipt_review_decisions rd
  where rd.receipt_submission_id = new.receipt_submission_id;

  if v_decision.id is null or v_decision.decision <> 'VERIFIED' then
    raise exception 'Only a receipt with a VERIFIED review decision can be classified'
      using errcode = 'check_violation';
  end if;

  -- 5. The named Vendor is a real, ACTIVE Vendor organization.
  if not exists (
    select 1 from public.organizations o
    where o.id = new.vendor_organization_id
      and o.organization_type = 'VENDOR'
      and o.status = 'ACTIVE'
  ) then
    raise exception 'That receipt cannot be classified'
      using errcode = 'check_violation';
  end if;

  -- 6. THE TENANT BOUNDARY. receipt_submissions has no Vendor column, so the only
  -- path from a receipt to a Vendor is this relationship, and it must be ACTIVE now.
  if not exists (
    select 1 from public.vendor_retailers vr
    where vr.vendor_organization_id = new.vendor_organization_id
      and vr.retailer_organization_id = v_submission.retailer_organization_id
      and vr.status = 'ACTIVE'
  ) then
    raise exception 'That receipt cannot be classified'
      using errcode = 'check_violation';
  end if;

  -- 7, 8 & 9. The actor is an ACTIVE member of that same Vendor, holding an ACTIVE
  -- CLAIM_REVIEWER role, and that role carries the classify permission.
  if not exists (
    select 1
    from public.organization_members m
    join public.profiles pr on pr.id = m.user_id
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
    where m.user_id = new.classified_by_profile_id
      and m.organization_id = new.vendor_organization_id
      and m.status = 'ACTIVE'
      and pr.status = 'ACTIVE'
      and r.status = 'ACTIVE'
      and r.code = 'CLAIM_REVIEWER'
      and p.code = 'RECEIPT_QUALIFICATION_CLASSIFY'
  ) then
    raise exception 'That receipt cannot be classified'
      using errcode = 'insufficient_privilege';
  end if;

  -- 10. A reversal must name a real, unreversed EXCLUDED event on the SAME receipt
  -- and the SAME Vendor. The unique index already stops two reversals racing; this
  -- stops a reversal pointing at the wrong receipt or across a tenant.
  if new.event_type = 'REINSTATED' then
    select * into v_prior
    from public.receipt_qualification_events e
    where e.id = new.reverses_event_id;

    if v_prior.id is null
       or v_prior.event_type <> 'EXCLUDED'
       or v_prior.receipt_submission_id <> new.receipt_submission_id
       or v_prior.vendor_organization_id <> new.vendor_organization_id then
      raise exception 'That exclusion cannot be reversed'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

create trigger receipt_qualification_events_assert_tenant
  before insert on public.receipt_qualification_events
  for each row execute function public.receipt_qualification_events_assert_tenant();


-- ============================================================================
-- 5. TABLE PRIVILEGES AND RLS
-- ============================================================================
-- RLS enabled with ZERO policies, matching every receipt table. There is no policy
-- to get wrong and no direct read or write for any browser role: everything goes
-- through the SECURITY DEFINER functions below, which run as the owner.
alter table public.receipt_qualification_events enable row level security;

revoke all on table public.receipt_qualification_events from public;
revoke all on table public.receipt_qualification_events from anon;
revoke all on table public.receipt_qualification_events from authenticated;
-- service_role TOO. Supabase's default privileges grant ALL on a new public table to
-- service_role, and revoking only from public/anon/authenticated leaves REFERENCES,
-- TRIGGER and TRUNCATE behind. TRUNCATE is the one that matters: it BYPASSES ROW
-- TRIGGERS and would defeat the immutability guard outright. The statement-level
-- truncate trigger above closes that too; both together is the shipped pattern.
revoke all on table public.receipt_qualification_events from service_role;

revoke all on function public.receipt_qualification_events_guard_change() from public;
revoke all on function public.receipt_qualification_events_guard_truncate() from public;
revoke all on function public.receipt_qualification_events_assert_tenant() from public;


-- ============================================================================
-- 6. INDEXES
-- ============================================================================
-- Reversal lookup is already served by receipt_qualification_events_one_reversal_idx
-- above, and the primary key serves id. These two cover the only other access paths
-- the functions actually use.

-- The effective-state query: newest events for one receipt.
create index receipt_qualification_events_receipt_idx
  on public.receipt_qualification_events (receipt_submission_id, classified_at desc);

-- Vendor-wide classification history, for a future report. Cheap, and the alternative
-- is a sequential scan the day somebody asks "what have we excluded this month".
create index receipt_qualification_events_vendor_idx
  on public.receipt_qualification_events (vendor_organization_id, classified_at desc);


-- ============================================================================
-- 7. THE FAIL-CLOSED CONTRACT
-- ============================================================================
-- ****************************************************************************
-- EVERY FUTURE SALE-FINALIZATION AND REWARD PATH MUST CALL THIS.
-- ****************************************************************************
-- Phase 1D-0 builds no sale and no reward, so nothing calls this yet. It exists now,
-- with its meaning fixed and its tests written, so that Phase 1D-B has one obvious
-- predicate to depend on instead of re-deriving the anti-join and getting it subtly
-- wrong.
--
-- The predicate, stated once: a receipt is EXCLUDED while at least one EXCLUDED
-- event exists for it that no REINSTATED event references.
--
--     exists (
--       select 1 from public.receipt_qualification_events x
--       where x.receipt_submission_id = <receipt>
--         and x.event_type = 'EXCLUDED'
--         and not exists (
--           select 1 from public.receipt_qualification_events rv
--           where rv.reverses_event_id = x.id
--         )
--     )
--
-- NOT granted to any browser role. It is an internal helper for other SECURITY
-- DEFINER functions, so it adds no executable surface: `authenticated` cannot call
-- it, exactly like public.resolve_claim_reviewer_organization.
--
-- It takes no Vendor and performs NO authorization, because it answers a question
-- about a receipt rather than about a caller. Its callers must already have
-- established the tenant boundary — the same contract
-- get_claim_review_object_reference operates under.
create function public.receipt_qualification_is_excluded(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.receipt_qualification_events x
    where x.receipt_submission_id = p_submission_id
      and x.event_type = 'EXCLUDED'
      and not exists (
        select 1
        from public.receipt_qualification_events rv
        where rv.reverses_event_id = x.id
      )
  );
$$;

revoke all     on function public.receipt_qualification_is_excluded(uuid) from public;
revoke execute on function public.receipt_qualification_is_excluded(uuid) from anon;
revoke execute on function public.receipt_qualification_is_excluded(uuid) from authenticated;

comment on function public.receipt_qualification_is_excluded(uuid) is
  'Internal. True while the receipt has an unreversed exclusion. Every future sale finalization and reward calculation must fail closed on this. Not callable by any browser role.';


-- ============================================================================
-- 8. READ — get_claim_receipt_qualification
-- ============================================================================
-- Takes the receipt id and NOTHING else. The Vendor is resolved from auth.uid()
-- through the Phase 1B resolver, so there is no tenant identifier for a caller to
-- supply. Gated on RECEIPT_REVIEW_READ, the same permission that opens the receipt
-- in the first place: a reviewer who can see the receipt can see whether it is
-- excluded, and one who cannot see it learns nothing.
--
-- Zero rows for missing, foreign, ineligible and unauthorized alike — the same
-- single answer get_claim_review_detail gives, so this cannot be used to probe.
create function public.get_claim_receipt_qualification(
  p_submission_id uuid
)
returns table (
  receipt_submission_id     uuid,
  qualification_state       text,
  exclusion_reason          text,
  reviewer_note             text,
  classified_at             timestamptz,
  classified_by_display_name text,
  can_reinstate             boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
  v_active public.receipt_qualification_events%rowtype;
begin
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ');
  if v_vendor is null or p_submission_id is null then
    return;
  end if;

  -- The receipt must be reachable through THIS reviewer's ACTIVE Vendor-to-Retailer
  -- relationship. Same predicate the queue and detail use.
  if not exists (
    select 1
    from public.receipt_submissions s
    join public.vendor_retailers vr
      on vr.retailer_organization_id = s.retailer_organization_id
     and vr.vendor_organization_id = v_vendor
     and vr.status = 'ACTIVE'
    where s.id = p_submission_id
      and s.status = 'SUBMITTED'
  ) then
    return;
  end if;

  -- The active exclusion, if any. At most one can exist: the write function holds a
  -- lock on the receipt row, and a reinstatement is unique per exclusion.
  select * into v_active
  from public.receipt_qualification_events x
  where x.receipt_submission_id = p_submission_id
    and x.event_type = 'EXCLUDED'
    and not exists (
      select 1 from public.receipt_qualification_events rv
      where rv.reverses_event_id = x.id
    )
  order by x.classified_at desc
  limit 1;

  if v_active.id is null then
    -- Not excluded. Deliberately NOT "eligible" — no sale exists, no reward exists,
    -- and nothing here has evaluated a campaign. This states the absence of one
    -- specific block, nothing more.
    return query
    select
      p_submission_id,
      'QUALIFICATION_NOT_EXCLUDED'::text,
      null::text,
      null::text,
      null::timestamptz,
      null::text,
      false;
    return;
  end if;

  return query
  select
    p_submission_id,
    'QUALIFICATION_EXCLUDED'::text,
    v_active.exclusion_reason,
    v_active.reviewer_note,
    v_active.classified_at,
    (dp.first_name || ' ' || dp.last_name)::text,
    true
  from public.profiles dp
  where dp.id = v_active.classified_by_profile_id;
end;
$$;

revoke all     on function public.get_claim_receipt_qualification(uuid) from public;
revoke execute on function public.get_claim_receipt_qualification(uuid) from anon;
grant  execute on function public.get_claim_receipt_qualification(uuid) to authenticated;


-- ============================================================================
-- 9. WRITE — record_claim_receipt_qualification
-- ============================================================================
-- Four arguments and not one more. No Vendor, actor, reviewer, member, event id,
-- timestamp, audit action or idempotency key: the Vendor comes from the resolver,
-- the actor from auth.uid(), the timestamp from the database, the reversal target is
-- resolved server-side under the lock, and the audit row is written here.
--
-- THE BROWSER NEVER SUPPLIES THE EVENT ID TO REVERSE. A stale page holding an old
-- exclusion's id could otherwise reverse an exclusion that was recorded after it
-- loaded. Resolving it under the receipt lock makes that impossible.
create function public.record_claim_receipt_qualification(
  p_submission_id    uuid,
  p_action           text,
  p_exclusion_reason text default null,
  p_reviewer_note    text default null
)
returns table (
  outcome             text,
  qualification_state text,
  exclusion_reason    text,
  classified_at       timestamptz,
  changed             boolean
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
  v_decision   public.receipt_review_decisions%rowtype;
  v_active     public.receipt_qualification_events%rowtype;
  v_new        public.receipt_qualification_events%rowtype;
  v_last_rev   public.receipt_qualification_events%rowtype;
begin
  -- ------------------------------------------------------------------------
  -- Authorization and argument validation, before anything is locked
  -- ------------------------------------------------------------------------
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_QUALIFICATION_CLASSIFY');
  if v_vendor is null then
    raise exception 'That receipt is not available for classification'
      using errcode = 'insufficient_privilege';
  end if;

  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'That receipt is not available for classification'
      using errcode = 'insufficient_privilege';
  end if;

  if p_submission_id is null then
    raise exception 'A receipt must be supplied'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_action is null or p_action not in ('EXCLUDE', 'REINSTATE') then
    raise exception 'An action must be EXCLUDE or REINSTATE'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_action = 'REINSTATE' and p_exclusion_reason is not null then
    raise exception 'A reinstatement must not carry an exclusion reason'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_action = 'EXCLUDE' then
    if p_exclusion_reason is null then
      raise exception 'An exclusion requires a reason'
        using errcode = 'invalid_parameter_value';
    end if;
    if p_exclusion_reason not in ('TEST_DATA', 'NON_QUALIFYING', 'DUPLICATE') then
      raise exception 'That exclusion reason is not recognised'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- Normalized exactly like decide_claim_receipt normalizes its note, so the two
  -- behave identically on whitespace and length.
  v_note := nullif(btrim(coalesce(p_reviewer_note, '')), '');
  if v_note is not null and length(v_note) > 500 then
    raise exception 'A note may be at most 500 characters'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_action = 'EXCLUDE'
     and p_exclusion_reason = 'NON_QUALIFYING'
     and v_note is null then
    raise exception 'That exclusion reason requires a note'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ------------------------------------------------------------------------
  -- THE LOCK. Everything below reads and writes under it.
  -- ------------------------------------------------------------------------
  -- The receipt row is the serialization point, exactly as in decide_claim_receipt.
  -- Two reviewers classifying the same receipt at the same moment queue here, so the
  -- second one reads the first one's event rather than racing past it — which is what
  -- makes "at most one active exclusion" true rather than merely likely.
  select * into v_submission
  from public.receipt_submissions s
  where s.id = p_submission_id
  for update;

  if v_submission.id is null or v_submission.status <> 'SUBMITTED' then
    raise exception 'That receipt is not available for classification'
      using errcode = 'insufficient_privilege';
  end if;

  -- Rechecked under the lock, not merely at the start.
  if not exists (
    select 1 from public.vendor_retailers vr
    where vr.vendor_organization_id = v_vendor
      and vr.retailer_organization_id = v_submission.retailer_organization_id
      and vr.status = 'ACTIVE'
  ) then
    raise exception 'That receipt is not available for classification'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_decision
  from public.receipt_review_decisions rd
  where rd.receipt_submission_id = p_submission_id;

  if v_decision.id is null or v_decision.decision <> 'VERIFIED' then
    raise exception 'Only a receipt with a VERIFIED review decision can be classified'
      using errcode = 'insufficient_privilege';
  end if;

  -- The current effective state, read under the lock.
  select * into v_active
  from public.receipt_qualification_events x
  where x.receipt_submission_id = p_submission_id
    and x.event_type = 'EXCLUDED'
    and not exists (
      select 1 from public.receipt_qualification_events rv
      where rv.reverses_event_id = x.id
    )
  order by x.classified_at desc
  limit 1;

  -- ------------------------------------------------------------------------
  -- EXCLUDE
  -- ------------------------------------------------------------------------
  if p_action = 'EXCLUDE' then
    if v_active.id is not null then
      -- An identical retry — same reviewer, same reason, same normalized note — is a
      -- double click or a reload, not an error. Anything else is a genuine conflict:
      -- somebody already excluded this receipt for a different stated reason, and
      -- silently keeping theirs while reporting success would misrepresent both.
      if v_active.classified_by_profile_id = v_actor
         and v_active.exclusion_reason = p_exclusion_reason
         and v_active.reviewer_note is not distinct from v_note then
        outcome             := 'ALREADY_EXCLUDED';
        qualification_state := 'QUALIFICATION_EXCLUDED';
        exclusion_reason    := v_active.exclusion_reason;
        classified_at       := v_active.classified_at;
        changed             := false;
        return next;
        return;
      end if;

      outcome             := 'CONFLICT';
      qualification_state := 'QUALIFICATION_EXCLUDED';
      exclusion_reason    := v_active.exclusion_reason;
      classified_at       := v_active.classified_at;
      changed             := false;
      return next;
      return;
    end if;

    insert into public.receipt_qualification_events (
      receipt_submission_id, vendor_organization_id, event_type,
      exclusion_reason, reviewer_note, classified_by_profile_id
    )
    values (
      p_submission_id, v_vendor, 'EXCLUDED',
      p_exclusion_reason, v_note, v_actor
    )
    returning * into v_new;

    -- Exactly one audit row, in the SAME transaction as the event. No note text and
    -- no UUID in metadata: `note_present` says whether one was written without
    -- copying a reviewer's free text into a second, differently-governed table.
    insert into public.audit_logs (
      organization_id, actor_profile_id, action, entity_type, entity_id, metadata
    )
    values (
      v_vendor,
      v_actor,
      'RECEIPT_QUALIFICATION_EXCLUDED',
      'RECEIPT_SUBMISSION',
      p_submission_id::text,
      jsonb_build_object(
        'qualification_action', 'EXCLUDE',
        'exclusion_reason', p_exclusion_reason,
        'note_present', (v_note is not null)
      )
    );

    outcome             := 'EXCLUDED';
    qualification_state := 'QUALIFICATION_EXCLUDED';
    exclusion_reason    := v_new.exclusion_reason;
    classified_at       := v_new.classified_at;
    changed             := true;
    return next;
    return;
  end if;

  -- ------------------------------------------------------------------------
  -- REINSTATE
  -- ------------------------------------------------------------------------
  if v_active.id is null then
    -- Nothing to reverse. Distinguish "you already reversed it" from "there was never
    -- anything here": a reinstatement this reviewer previously recorded is an
    -- idempotent retry, and no prior exclusion at all is a conflict with a stale page.
    select * into v_last_rev
    from public.receipt_qualification_events e
    where e.receipt_submission_id = p_submission_id
      and e.event_type = 'REINSTATED'
    order by e.classified_at desc
    limit 1;

    if v_last_rev.id is not null and v_last_rev.classified_by_profile_id = v_actor then
      outcome             := 'ALREADY_REINSTATED';
      qualification_state := 'QUALIFICATION_NOT_EXCLUDED';
      exclusion_reason    := null;
      classified_at       := v_last_rev.classified_at;
      changed             := false;
      return next;
      return;
    end if;

    outcome             := 'CONFLICT';
    qualification_state := 'QUALIFICATION_NOT_EXCLUDED';
    exclusion_reason    := null;
    classified_at       := v_last_rev.classified_at;
    changed             := false;
    return next;
    return;
  end if;

  -- The target is the exclusion that is active RIGHT NOW, under this lock — never an
  -- id the browser supplied. A stale page therefore reverses whatever is currently
  -- in force, or nothing, and can never reach past a newer exclusion.
  insert into public.receipt_qualification_events (
    receipt_submission_id, vendor_organization_id, event_type,
    reviewer_note, reverses_event_id, classified_by_profile_id
  )
  values (
    p_submission_id, v_vendor, 'REINSTATED',
    v_note, v_active.id, v_actor
  )
  returning * into v_new;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor,
    v_actor,
    'RECEIPT_QUALIFICATION_REINSTATED',
    'RECEIPT_SUBMISSION',
    p_submission_id::text,
    jsonb_build_object(
      'qualification_action', 'REINSTATE',
      'previous_exclusion_reason', v_active.exclusion_reason,
      'note_present', (v_note is not null)
    )
  );

  outcome             := 'REINSTATED';
  qualification_state := 'QUALIFICATION_NOT_EXCLUDED';
  exclusion_reason    := null;
  classified_at       := v_new.classified_at;
  changed             := true;
  return next;
end;
$$;

revoke all     on function public.record_claim_receipt_qualification(uuid, text, text, text) from public;
revoke execute on function public.record_claim_receipt_qualification(uuid, text, text, text) from anon;
grant  execute on function public.record_claim_receipt_qualification(uuid, text, text, text) to authenticated;

comment on function public.record_claim_receipt_qualification(uuid, text, text, text) is
  'Records one append-only receipt qualification event. Never changes the receipt review decision. Returns EXCLUDED, ALREADY_EXCLUDED, REINSTATED, ALREADY_REINSTATED or CONFLICT.';
