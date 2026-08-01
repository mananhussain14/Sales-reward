-- Migration: campaign_version_status_history
-- Purpose: Makes "which campaign version was in force, and was it paused, when the sale
--          happened?" answerable. It adds, and only adds:
--            1. public.campaign_version_status_history -- an append-only interval table
--               recording every (in-force version, lifecycle status) pair a campaign held.
--            2. The triggers that maintain it automatically on public.campaigns.
--            3. A conservative backfill of every campaign that has a version in force today.
--            4. Two INTERNAL point-in-time resolvers.
--          Plus the immutability and non-overlap guards, and default-deny RLS.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
-- public.campaigns holds `status` and `published_version_id` and BOTH are overwritten in
-- place. set_vendor_campaign_lifecycle (migration 20260815210000) does
-- `update public.campaigns set status = ...`, and publish_vendor_campaign moves
-- published_version_id to the newly published version. Each write destroys the previous
-- answer at the instant it changes it.
--
-- That was correct for the question those RPCs ask ("what should a Retailer see NOW?"), and
-- the effective-time reads deliberately compute their answer from now() through
-- campaign_derived_state(). But a reward engine asks a question about a PAST instant, and
-- campaign_product_eligibility_as_of() already says so in its own header: "a reward engine
-- must use the verified SALE timestamp regardless, never this."
--
-- Without this table, a sale made while a campaign was PAUSED would be rewarded or refused
-- depending only on when the calculation happened to run, and a recalculation would not be
-- reproducible. Both are unacceptable for money.
--
-- THE VERSION POINTER IS PARTLY RECOVERABLE WITHOUT THIS TABLE; THE STATUS IS NOT.
-- campaign_versions.published_at is immutable once set, so "which version had been published
-- by instant T" can be inferred by ordering. Nothing anywhere records when a campaign was
-- paused, resumed or cancelled except public.audit_logs, which is a narrative record whose
-- organization_id is ON DELETE SET NULL -- not a reconstruction source a financial engine
-- should depend on. This table records both facts in one interval so they can never disagree.
--
-- ============================================================================
-- WHY ONE OPEN INTERVAL PER CAMPAIGN, NOT PER VERSION
-- ============================================================================
-- At any instant a campaign has exactly ONE version in force, or none. Keying the open
-- interval on the CAMPAIGN therefore makes "the state of this campaign right now" a definite
-- article, enforced by a partial unique index rather than by a convention.
--
-- A version that is superseded simply has its interval CLOSED, so "when did version 1 stop
-- being current?" is read off valid_to, and "when did version 2 become current?" is read off
-- the next interval's valid_from. The two are the same instant by construction, because one
-- clock_timestamp() reading closes the old row and opens the new one.
--
-- A campaign that is paused and resumed produces THREE intervals naming the SAME version.
-- That is the point: the version did not change, but whether it was rewarding did.
--
-- ============================================================================
-- WHY is_version_in_force IS GENERATED
-- ============================================================================
-- The reward engine needs one boolean: "was this version actually in force -- that is, the
-- campaign's current configuration AND not suspended -- during this interval?" That is
-- exactly `lifecycle_status = 'PUBLISHED'`, because PAUSED suspends eligibility and CANCELLED
-- is terminal.
--
-- Storing it as an ordinary column would create two places that can disagree about one fact.
-- GENERATED ALWAYS ... STORED makes disagreement structurally impossible while still giving
-- callers an indexable column, which is the same instinct every equivalence CHECK in this
-- schema follows.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--   No reward, coin, ledger, balance, contribution, award, claim or payout object. Nothing
--   here computes what anybody earned; it records what was TRUE, and nothing about what
--   anyone is owed.
--   No change to any campaign RPC. The five lifecycle writers are byte-untouched and gain
--   history because a trigger OBSERVES them, not because they were edited -- the same reason
--   20260814210000 chose a trigger over a shared writer function. A second lifecycle
--   implementation would be a second definition free to drift, and only one could be right.
--   No user-facing behaviour change of any kind: no RPC returns a new column, and no read
--   consults this table.
--   No policy: the table is RPC-only and default-deny, like every campaign table.
--
-- Idempotency posture: plain CREATE / INSERT (no IF NOT EXISTS, no CREATE OR REPLACE, no ON
--   CONFLICT). A conflicting existing object FAILS the migration. No fixed UUIDs. No dynamic
--   SQL. All identifiers are <= 63 bytes. Every reference is schema-qualified because every
--   function runs with an EMPTY search_path.
--
-- Dependencies: 20260716124419 (organizations), 20260815090000 (campaigns,
--   campaign_versions, campaign_eligible_retailers and the DRAFT/PUBLISHED/PAUSED/CANCELLED
--   vocabulary), 20260815210000 (the lifecycle writers this trigger observes).

-- ============================================================================
-- PART 1 -- the history table
-- ============================================================================
create table public.campaign_version_status_history (
  id uuid primary key default gen_random_uuid(),

  -- The interval key. RESTRICT, like every other reference in this schema: a campaign with
  -- recorded history cannot be hard-deleted out from under it.
  campaign_id uuid not null
    references public.campaigns (id) on delete restrict,

  -- The version in force during this interval. NOT NULL: an interval only ever exists from a
  -- campaign's first publication onward, and a campaign with no version in force has no row
  -- rather than a row with a null version.
  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete restrict,

  -- The SAME vocabulary public.campaigns permits, minus DRAFT. A history table that spoke a
  -- different language than the table it records would need a mapping, and a mapping is a
  -- place for the two to disagree. DRAFT is excluded because a DRAFT campaign has, by
  -- campaigns_draft_has_no_published_version, no version in force to record.
  lifecycle_status text not null,

  -- See the header. Generated, so it can never contradict lifecycle_status.
  is_version_in_force boolean not null
    generated always as (lifecycle_status = 'PUBLISHED') stored,

  -- HALF-OPEN INTERVAL: [valid_from, valid_to).
  -- valid_to IS NULL means "still in force". See PART 5 for the boundary semantics every
  -- resolver applies -- identical to vendor_product_retailer_assignment_history.
  valid_from timestamptz not null,
  valid_to timestamptz,

  -- When this ROW was written, as opposed to when the fact it records began. They differ for
  -- the backfill in PART 4, and keeping both is what lets a reader tell a reconstructed
  -- interval from an observed one.
  recorded_at timestamptz not null default now(),

  -- HOW this row came to exist, and the reason a reward engine can trust it.
  --   OBSERVED                -- a trigger watched the change happen.
  --   BACKFILL_CURRENT_STATE  -- PART 4 recorded the state that was true at migration time
  --                              and claims NOTHING about any earlier instant.
  -- This is not decoration. Without it, a backfilled interval whose valid_from is the
  -- migration instant is indistinguishable from a campaign genuinely published at that
  -- instant, and the engine would have no way to know that the silence before it is
  -- "unrecorded" rather than "not published".
  history_source text not null default 'OBSERVED',

  constraint campaign_version_status_history_status_allowed
    check (lifecycle_status = any (array['PUBLISHED'::text, 'PAUSED'::text, 'CANCELLED'::text])),

  constraint campaign_version_status_history_source_allowed
    check (history_source = any (array['OBSERVED'::text, 'BACKFILL_CURRENT_STATE'::text])),

  -- Strictly ordered. A zero-length interval would be invisible to every half-open query
  -- anyway, so admitting one would only create rows that mean nothing.
  constraint campaign_version_status_history_interval_ordered
    check (valid_to is null or valid_to > valid_from)
);

comment on table public.campaign_version_status_history is
  'Append-only half-open [valid_from, valid_to) intervals recording which campaign version was in force and under which lifecycle status. Authoritative from this migration''s deployment onward.';

-- ---- Indexes ---------------------------------------------------------------

-- THE OPEN-INTERVAL CONCURRENCY AUTHORITY. At most ONE interval may be in force for a
-- campaign at any moment. This is what makes "the current interval" a definite article, and
-- it is enforced by the database rather than by the trigger's good behaviour.
create unique index campaign_version_status_history_open_idx
  on public.campaign_version_status_history (campaign_id)
  where valid_to is null;

-- The per-campaign point-in-time path: one campaign, ordered by interval start.
create index campaign_version_status_history_campaign_idx
  on public.campaign_version_status_history (campaign_id, valid_from desc);

-- The per-version resolver's path -- "what status did THIS version hold at T?".
create index campaign_version_status_history_version_idx
  on public.campaign_version_status_history (campaign_version_id, valid_from desc);

-- ---- Non-overlap -----------------------------------------------------------
-- The open-interval index above forbids two CURRENT intervals. This forbids two intervals
-- that overlap anywhere at all -- including two closed ones, which a mis-timed backfill or a
-- future repair could otherwise create.
--
-- Implemented as a trigger rather than an EXCLUDE constraint for the reason 20260814210000
-- states: an EXCLUDE over (uuid, tstzrange) needs btree_gist, which is available on this
-- platform but NOT installed, and enabling an extension is a heavier act than this project
-- has taken in any migration so far. The guarantee is identical.
create function public.campaign_status_history_assert_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- An INVERTED interval is not this trigger's error to report. tstzrange() raises SQLSTATE
  -- 22000 when asked to build one, which would surface an internal range-construction failure
  -- instead of the constraint that actually states the rule. Returning early lets
  -- campaign_version_status_history_interval_ordered reject it with a message that names the
  -- rule, and an inverted interval can overlap nothing in any case.
  if new.valid_to is not null and new.valid_to <= new.valid_from then
    return new;
  end if;

  if exists (
    select 1
    from public.campaign_version_status_history h
    where h.campaign_id = new.campaign_id
      and h.id <> new.id
      -- '[)' matches the half-open reading every resolver uses, so two intervals that merely
      -- touch (one ends exactly where the next begins) do NOT overlap.
      and tstzrange(h.valid_from, h.valid_to, '[)')
          && tstzrange(new.valid_from, new.valid_to, '[)')
  ) then
    raise exception 'Campaign status history intervals cannot overlap'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger campaign_status_history_no_overlap
  before insert or update on public.campaign_version_status_history
  for each row execute function public.campaign_status_history_assert_no_overlap();

-- ---- Immutability ----------------------------------------------------------
-- A CLOSED interval is frozen forever. An OPEN one may only be CLOSED. DELETE is refused
-- unconditionally: history is never destroyed, not even when the campaign it describes is
-- cancelled.
--
-- Unlike vendor_product_assign_history_assert_append_only, there is NO "correct the status of
-- an open interval" branch here. That branch exists on the assignment timeline to defend
-- against a row carrying an assigned_at in the future; this timeline's boundaries are always
-- clock_timestamp() readings taken by the trigger in PART 2, which additionally guarantees a
-- strictly increasing boundary, so a zero-length interval cannot arise and there is nothing
-- to correct. Admitting a mutation that no path can need would only widen what "immutable"
-- means.
create function public.campaign_status_history_assert_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Campaign status history is append-only and cannot be deleted'
      using errcode = 'check_violation';
  end if;

  if old.valid_to is not null then
    raise exception 'A closed campaign status history interval is immutable'
      using errcode = 'check_violation';
  end if;

  -- Identity, lineage and the recorded fact are all fixed even while the interval is open:
  -- re-pointing an interval at another campaign, another version or another status would
  -- rewrite a fact rather than record one. valid_to is the ONLY column that may move, and
  -- only from NULL to a value.
  if new.id                  is distinct from old.id
     or new.campaign_id         is distinct from old.campaign_id
     or new.campaign_version_id is distinct from old.campaign_version_id
     or new.lifecycle_status    is distinct from old.lifecycle_status
     or new.valid_from          is distinct from old.valid_from
     or new.recorded_at         is distinct from old.recorded_at
     or new.history_source      is distinct from old.history_source then
    raise exception 'Campaign status history identity is immutable'
      using errcode = 'check_violation';
  end if;

  if new.valid_to is null then
    raise exception 'An open campaign status history interval may only be closed'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger campaign_status_history_append_only_on_update
  before update on public.campaign_version_status_history
  for each row execute function public.campaign_status_history_assert_append_only();

create trigger campaign_status_history_append_only_on_delete
  before delete on public.campaign_version_status_history
  for each row execute function public.campaign_status_history_assert_append_only();

-- ============================================================================
-- PART 2 -- the maintenance trigger
-- ============================================================================
-- AFTER, not BEFORE: set_updated_at and campaigns_assert_immutable already run BEFORE on
-- public.campaigns (migration 20260815090000), so an AFTER trigger sees the row exactly as it
-- will be stored rather than as it was proposed.
--
-- ONLY `status` AND `published_version_id` MOVE THIS TIMELINE. name, description,
-- draft_version_id and updated_at are authoring metadata that change nothing about what was
-- in force, so an update that leaves both watched columns alone writes NO history row -- a
-- timeline whose entries do not correspond to changes in what it describes is worse than a
-- shorter one.
--
-- WHY BOTH AN INSERT AND AN UPDATE TRIGGER. Every shipped path creates a campaign as DRAFT
-- with published_version_id NULL and publishes it later, so the UPDATE trigger carries all
-- real traffic. The INSERT trigger exists because campaigns_draft_has_no_published_version
-- permits a row to be created already published, and a future migration or repair that did so
-- must not silently open a campaign with no history at all.
create function public.campaign_status_record_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- clock_timestamp(), NOT now(), for the reason 20260814210000 gives: now() is the
  -- TRANSACTION start and is frozen for its whole duration, so two lifecycle changes to one
  -- campaign inside a single transaction would both want to close and open at the identical
  -- instant. clock_timestamp() advances, so each change gets its own ordered boundary and the
  -- timeline records when a change actually happened rather than when its transaction began.
  -- Captured ONCE per invocation, so the interval that closes and the interval that opens
  -- share exactly one boundary and leave no gap between them.
  v_now       timestamptz := clock_timestamp();
  v_open_id   uuid;
  v_open_from timestamptz;
  v_open_ver  uuid;
  v_open_stat text;
  v_boundary  timestamptz;
begin
  -- A campaign with nothing in force records nothing. This is the DRAFT case, and it is also
  -- why cancelling a never-published campaign is impossible (set_vendor_campaign_lifecycle
  -- refuses it) and therefore cannot reach here with a null version.
  if new.published_version_id is null then
    return new;
  end if;

  -- The campaign row is already locked FOR UPDATE by every shipped lifecycle RPC, so this
  -- read is serialized per campaign. FOR UPDATE here as well, so a path that did not take the
  -- campaign lock still cannot interleave two closes against one open interval.
  select h.id, h.valid_from, h.campaign_version_id, h.lifecycle_status
    into v_open_id, v_open_from, v_open_ver, v_open_stat
  from public.campaign_version_status_history h
  where h.campaign_id = new.id
    and h.valid_to is null
  for update;

  if v_open_id is not null then
    -- Nothing this timeline records actually moved. Writing a row here would split one
    -- interval into two identical halves and claim a change that did not happen.
    if v_open_ver = new.published_version_id and v_open_stat = new.status then
      return new;
    end if;

    -- STRICTLY INCREASING BOUNDARY. clock_timestamp() advances in practice, but it carries no
    -- guarantee of doing so between two statements, and a boundary equal to valid_from would
    -- produce a zero-length interval that campaign_version_status_history_interval_ordered
    -- rejects -- turning an ordinary pause into a failed transaction. One microsecond is
    -- below the resolution of anything this timeline is asked about and keeps the intervals
    -- strictly ordered.
    v_boundary := greatest(v_now, v_open_from + interval '1 microsecond');

    update public.campaign_version_status_history h
    set valid_to = v_boundary
    where h.id = v_open_id;
  else
    v_boundary := v_now;
  end if;

  insert into public.campaign_version_status_history (
    campaign_id, campaign_version_id, lifecycle_status,
    valid_from, valid_to, history_source
  )
  values (
    new.id, new.published_version_id, new.status,
    v_boundary, null, 'OBSERVED'
  );

  return new;
end;
$$;

create trigger campaigns_record_status_history_on_insert
  after insert on public.campaigns
  for each row
  when (new.published_version_id is not null)
  execute function public.campaign_status_record_history();

create trigger campaigns_record_status_history_on_update
  after update of status, published_version_id on public.campaigns
  for each row
  when (
    new.status is distinct from old.status
    or new.published_version_id is distinct from old.published_version_id
  )
  execute function public.campaign_status_record_history();

-- ============================================================================
-- PART 3 -- RLS and privilege hardening
-- ============================================================================
-- RLS ON, and ZERO POLICIES, matching all eleven campaign tables. Every read goes through a
-- SECURITY DEFINER contract that resolves the caller from auth.uid(). No privilege is granted
-- to anon or authenticated, so a browser cannot touch this table even if a policy were added
-- by mistake. service_role is revoked TOO: TRUNCATE bypasses row triggers, so leaving it
-- would defeat the append-only guards outright.
alter table public.campaign_version_status_history enable row level security;

revoke all on table public.campaign_version_status_history from public;
revoke all on table public.campaign_version_status_history from anon;
revoke all on table public.campaign_version_status_history from authenticated;
revoke all on table public.campaign_version_status_history from service_role;

revoke all on function public.campaign_status_history_assert_no_overlap()  from public;
revoke all on function public.campaign_status_history_assert_append_only() from public;
revoke all on function public.campaign_status_record_history()             from public;

-- ============================================================================
-- PART 4 -- backfill
-- ============================================================================
-- CONSERVATIVE BY CONSTRUCTION, and this is the most important paragraph in the migration.
--
-- What can be reconstructed honestly: the state that is true RIGHT NOW. campaigns.status and
-- campaigns.published_version_id are authoritative for the present instant and for no other.
--
-- What CANNOT be reconstructed, and is therefore NOT invented here:
--   * when each campaign was first published -- campaign_versions.published_at records when a
--     VERSION was stamped, which is not the same as the campaign having been continuously in
--     that state since; a campaign published in July, paused in August and resumed in
--     September has a July published_at and has been PUBLISHED for only part of the time
--     since. Writing valid_from = published_at would therefore CLAIM a continuous PUBLISHED
--     interval that is false exactly when it matters most.
--   * every pause, resume, cancellation and version supersession that has already happened.
--     public.audit_logs holds a narrative of some of them, but reconstructing intervals from
--     it would mean trusting a table whose organization_id is ON DELETE SET NULL and which
--     nothing prevented from being incomplete.
--
-- So each affected campaign gets ONE open interval starting at the migration instant, marked
-- BACKFILL_CURRENT_STATE. The resolvers in PART 5 return NULL for every instant before it,
-- and NULL means "no authoritative record" -- deliberately NOT collapsed into "not
-- published", exactly as vendor_product_assignment_state_at refuses to collapse "we have no
-- record" into "it was withdrawn".
--
-- THE CONSEQUENCE, STATED PLAINLY: a sale that happened before this migration ran CANNOT be
-- evaluated against campaign status, and the reward engine must refuse rather than guess.
-- That is the correct outcome. No receipt has ever been verified, no coin has ever been
-- credited, and no campaign result exists, so nothing is lost by refusing -- whereas a
-- fabricated interval would be wrong forever and impossible to detect afterwards.
insert into public.campaign_version_status_history (
  campaign_id, campaign_version_id, lifecycle_status,
  valid_from, valid_to, history_source
)
select
  c.id,
  c.published_version_id,
  c.status,
  now(),
  null,
  'BACKFILL_CURRENT_STATE'
from public.campaigns c
where c.published_version_id is not null;

-- ============================================================================
-- PART 5 -- point-in-time resolvers (INTERNAL)
-- ============================================================================
-- BOUNDARY SEMANTICS, applied identically by both and by every caller, and identical to
-- vendor_product_retailer_assignment_history:
--
--     valid_from <= as_of  AND  (valid_to IS NULL OR as_of < valid_to)
--
-- Half-open [valid_from, valid_to). The instant an interval BEGINS is inside it; the instant
-- it ENDS is not. That is what makes two adjacent intervals partition time without a gap and
-- without an instant belonging to both.
--
-- BOTH ARE INTERNAL -- granted to no browser role. They accept a Retailer id and resolve no
-- tenant of their own, so exposing one directly would let a caller ask about a Retailer they
-- have no relationship with. They are reachable only from SECURITY DEFINER contracts that
-- have already resolved the caller from auth.uid().
--
-- NEITHER READS now(). The instant is always an explicit argument, which is the whole reason
-- they exist: campaign_derived_state() and campaign_product_eligibility_as_of() answer a
-- present-tense question for display, and a reward engine must never inherit that.

-- ---- The lifecycle status a VERSION held at an instant ----------------------
-- NULL means "no interval covered that instant for THIS version" -- the version was not the
-- one in force then, or (for an instant before this migration) is simply not recorded. NULL
-- is deliberately NOT collapsed into 'CANCELLED' or into false: "we have no record", "a
-- different version was in force" and "it was cancelled" are different facts, and a reward
-- engine must be able to tell them apart.
create function public.campaign_version_status_at(
  p_campaign_version_id uuid,
  p_as_of               timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select h.lifecycle_status
  from public.campaign_version_status_history h
  where h.campaign_version_id = p_campaign_version_id
    and h.valid_from <= p_as_of
    and (h.valid_to is null or p_as_of < h.valid_to)
  limit 1;
$$;

revoke all     on function public.campaign_version_status_at(uuid, timestamptz) from public;
revoke execute on function public.campaign_version_status_at(uuid, timestamptz) from anon;
revoke execute on function public.campaign_version_status_at(uuid, timestamptz) from authenticated;

-- ---- Every campaign version in force for a Retailer at an instant -----------
-- THE function a reward engine will call. Three independent facts must all hold, and each
-- comes from the source that is authoritative for it:
--
--   1. the version was in force and not suspended at that instant  -- this timeline;
--   2. the Retailer was eligible for that version                  -- the FROZEN publication
--      snapshot campaign_eligible_retailers, which a later group edit cannot rewrite;
--   3. the instant fell inside the version's own period            -- the IMMUTABLE
--      campaign_versions row.
--
-- The period test is half-open for the same reason the interval test is: the last instant a
-- campaign can reward is the instant before it ends.
create function public.campaign_versions_in_force_for_retailer_at(
  p_retailer_organization_id uuid,
  p_as_of                    timestamptz
)
returns table (
  campaign_id         uuid,
  campaign_version_id uuid,
  lifecycle_status    text
)
language sql
stable
security definer
set search_path = ''
as $$
  select h.campaign_id, h.campaign_version_id, h.lifecycle_status
  from public.campaign_version_status_history h
  join public.campaign_eligible_retailers er
    on er.campaign_version_id = h.campaign_version_id
   and er.retailer_organization_id = p_retailer_organization_id
  join public.campaign_versions cv
    on cv.id = h.campaign_version_id
  where h.is_version_in_force
    and h.valid_from <= p_as_of
    and (h.valid_to is null or p_as_of < h.valid_to)
    and cv.starts_at <= p_as_of
    and (cv.ends_at is null or p_as_of < cv.ends_at);
$$;

revoke all     on function public.campaign_versions_in_force_for_retailer_at(uuid, timestamptz) from public;
revoke execute on function public.campaign_versions_in_force_for_retailer_at(uuid, timestamptz) from anon;
revoke execute on function public.campaign_versions_in_force_for_retailer_at(uuid, timestamptz) from authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One table, three indexes, five functions, four triggers, one conservative backfill.
--
-- No existing table, column, constraint, index, policy, role, permission or mapping is
-- altered, and no campaign RPC is touched -- they gain history because a trigger observes
-- them, not because they were changed. No user-facing behaviour changes.
--
-- Nothing here evaluates a campaign, matches a receipt, computes progress, credits a coin or
-- records a claim or a payout. It records WHICH configuration was in force and whether it was
-- suspended, and nothing about what anyone earned.
