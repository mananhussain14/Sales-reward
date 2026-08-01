-- Migration: vendor_product_assignment_history
-- Purpose: Makes "was this product eligible for this Retailer when the sale happened?"
--          answerable. Adds, and only adds:
--            1. public.vendor_product_retailer_assignment_history — an append-only
--               interval table recording every state the assignment edge has held.
--            2. The trigger that maintains it automatically on
--               public.vendor_product_retailer_assignments.
--            3. A backfill of every assignment row that exists today.
--            4. Three INTERNAL point-in-time resolvers.
--          Plus the immutability and non-overlap guards, and default-deny RLS.
--
-- ============================================================================
-- WHY THIS EXISTS
-- ============================================================================
-- public.vendor_product_retailer_assignments holds ONE row per (product, Retailer) pair
-- FOR ALL TIME — vendor_product_retailer_assign_unique_idx, migration 20260727090000 —
-- and withdrawal flips `status` from 'ACTIVE' to 'INACTIVE' IN PLACE. That was correct
-- for the question the catalogue asks ("may this Retailer see this product NOW?"), but it
-- destroys the previous answer the moment it changes.
--
-- A campaign whose product scope is ALL_ELIGIBLE_PRODUCTS means, deliberately, "every
-- product eligible for that Retailer AT THE RELEVANT MOMENT". A product assigned after
-- publication qualifies for later sales; one withdrawn after publication stops qualifying
-- for later sales. Neither is a change to the published campaign — the campaign version
-- stays byte-for-byte immutable and its configured MEANING is unchanged. What moves is the
-- assignment timeline, which is business history and belongs in a history table.
--
-- Without this table the future reward engine would have to evaluate a September sale
-- against October's assignment status, and would be silently wrong. With it, the engine
-- resolves eligibility AS OF the verified sale timestamp.
--
-- ============================================================================
-- WHAT "APPEND-ONLY" MEANS HERE, PRECISELY
-- ============================================================================
-- A CLOSED interval (valid_to IS NOT NULL) is a historical fact and can never be updated
-- or deleted — the trigger refuses both, unconditionally.
--
-- The OPEN interval (valid_to IS NULL) is not history yet; it is the present. Exactly two
-- things may happen to it: it is closed by setting valid_to, or — only while it is still
-- open and only when closing it would produce a zero-length or inverted interval — its
-- status is corrected in place. The second case is defence against a row carrying an
-- assigned_at in the future; it cannot arise from the ordinary path, because the trigger
-- stamps boundaries with clock_timestamp() rather than the frozen transaction time.
--
-- DELETING AN ASSIGNMENT ROW IS NOW STRUCTURALLY IMPOSSIBLE, and that is a strengthening
-- rather than a side effect. Migration 20260727090000 states the rule in prose — "a DELETE
-- would erase the record that a product was once available at a Retailer, and with it the
-- ability to explain a historical receipt match" — but nothing enforced it: no trigger
-- refused a delete, and only the absence of any browser privilege stood in the way. The
-- history table's assignment_id foreign key is ON DELETE RESTRICT and the trigger opens an
-- interval for every row at insert, so from this migration onward every assignment row is
-- permanently referenced and the delete is refused by the database itself.
--
-- The trigger's DELETE branch is therefore UNREACHABLE through any path that exists today —
-- the foreign key rejects the statement first. It is kept deliberately: should a future
-- migration ever relax that constraint, history must be CLOSED rather than left with a
-- dangling open interval, and the branch that does so should already be there and already
-- be understood. Section 11's suite asserts the refusal, not the branch.
--
-- ============================================================================
-- WHY A TRIGGER RATHER THAN A SHARED WRITER FUNCTION
-- ============================================================================
-- A helper only records what its callers remember to call. A trigger records what actually
-- happened. The two shipped writers — assign_vendor_product_to_retailer and
-- unassign_vendor_product_from_retailer, migration 20260727210000 — are untouched by this
-- migration and gain history for free, and so does any future RPC, repair migration or
-- trusted server-side correction. That is the whole point: the history cannot be bypassed
-- by writing the table a different way.
--
-- Idempotency posture: plain CREATE / INSERT (no IF NOT EXISTS, no CREATE OR REPLACE, no
--   ON CONFLICT), matching every migration in this repository. A conflicting existing
--   object FAILS the migration. No fixed UUIDs. No dynamic SQL. All identifiers are <= 63
--   bytes. Every reference is schema-qualified because every function runs with an EMPTY
--   search_path.
--
-- Dependencies: 20260716124419 (organizations), 20260727090000
--   (vendor_products, vendor_product_retailer_assignments and its ACTIVE/INACTIVE status
--   vocabulary).

-- ============================================================================
-- PART 1 — the history table
-- ============================================================================
create table public.vendor_product_retailer_assignment_history (
  id uuid primary key default gen_random_uuid(),

  -- The assignment row this interval describes. RESTRICT, like every other reference in
  -- this schema: an assignment with recorded history cannot be hard-deleted out from
  -- under it.
  assignment_id uuid not null
    references public.vendor_product_retailer_assignments (id) on delete restrict,

  -- Denormalized from the assignment row, and deliberately so. The pair is what every
  -- point-in-time query filters on, and copying it here means a resolver never has to
  -- join back to a table whose current state is precisely what this one exists to
  -- outlive. Both are immutable on the source row (vendor_product_assignment_assert_immutable,
  -- migration 20260727090000), so the copy can never drift.
  vendor_product_id uuid not null
    references public.vendor_products (id) on delete restrict,
  retailer_organization_id uuid not null
    references public.organizations (id) on delete restrict,

  -- The state held during this interval. The SAME vocabulary the source table permits —
  -- ACTIVE / INACTIVE, per vendor_product_assignments_status_allowed. No new vocabulary is
  -- invented here: a history table that spoke a different language than the table it
  -- records would need a mapping, and a mapping is a place for the two to disagree.
  assignment_status text not null,

  -- HALF-OPEN INTERVAL: [valid_from, valid_to).
  -- valid_to IS NULL means "still in force". See PART 5 for the boundary semantics every
  -- resolver applies.
  valid_from timestamptz not null,
  valid_to timestamptz,

  -- When this ROW was written, as opposed to when the fact it records began. They differ
  -- for the backfill in PART 4, and keeping both is what lets a reader tell a reconstructed
  -- interval from an observed one.
  recorded_at timestamptz not null default now(),

  constraint vendor_product_assign_history_status_allowed
    check (assignment_status = any (array['ACTIVE'::text, 'INACTIVE'::text])),

  -- Strictly ordered. A zero-length interval would be invisible to every half-open query
  -- anyway, so admitting one would only create rows that mean nothing.
  constraint vendor_product_assign_history_interval_ordered
    check (valid_to is null or valid_to > valid_from)
);

comment on table public.vendor_product_retailer_assignment_history is
  'Append-only half-open [valid_from, valid_to) intervals recording every state a Vendor product/Retailer assignment has held. Authoritative from this migration''s deployment onward.';

-- ---- Indexes ---------------------------------------------------------------

-- THE OPEN-INTERVAL CONCURRENCY AUTHORITY. At most ONE interval may be in force for a
-- pair at any moment. This is what makes "the current interval" a definite article, and
-- it is enforced by the database rather than by the trigger's good behaviour.
create unique index vendor_product_assign_history_open_idx
  on public.vendor_product_retailer_assignment_history
     (vendor_product_id, retailer_organization_id)
  where valid_to is null;

-- The point-in-time resolvers' access path: one pair, ordered by interval start.
create index vendor_product_assign_history_pair_idx
  on public.vendor_product_retailer_assignment_history
     (vendor_product_id, retailer_organization_id, valid_from desc);

-- "Every product eligible for this Retailer at T" — the set-returning resolver's path.
create index vendor_product_assign_history_retailer_idx
  on public.vendor_product_retailer_assignment_history
     (retailer_organization_id, valid_from desc);

-- ---- Non-overlap -----------------------------------------------------------
-- The open-interval index above forbids two CURRENT intervals. This forbids two intervals
-- that overlap anywhere at all — including two closed ones, which a mis-timed backfill or
-- a future repair could otherwise create.
--
-- Implemented as a trigger rather than an EXCLUDE constraint because an EXCLUDE over
-- (uuid, uuid, tstzrange) needs btree_gist, which is available on this platform but NOT
-- installed. Enabling an extension is a heavier, harder-to-reverse act than this project
-- has taken in any migration so far, and the guarantee is identical.
create function public.vendor_product_assign_history_assert_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- An INVERTED interval is not this trigger's error to report. tstzrange() raises SQLSTATE
  -- 22000 ("range lower bound must be less than or equal to range upper bound") when asked
  -- to build one, which would surface an internal range-construction failure instead of the
  -- constraint that actually states the rule. Returning early lets
  -- vendor_product_assign_history_interval_ordered reject it with a message that names the
  -- rule, and an inverted interval can overlap nothing in any case.
  if new.valid_to is not null and new.valid_to <= new.valid_from then
    return new;
  end if;

  if exists (
    select 1
    from public.vendor_product_retailer_assignment_history h
    where h.vendor_product_id = new.vendor_product_id
      and h.retailer_organization_id = new.retailer_organization_id
      and h.id <> new.id
      -- '[)' matches the half-open reading every resolver uses, so two intervals that
      -- merely touch (one ends exactly where the next begins) do NOT overlap.
      and tstzrange(h.valid_from, h.valid_to, '[)')
          && tstzrange(new.valid_from, new.valid_to, '[)')
  ) then
    raise exception 'Assignment history intervals cannot overlap'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger vendor_product_assign_history_no_overlap
  before insert or update on public.vendor_product_retailer_assignment_history
  for each row execute function public.vendor_product_assign_history_assert_no_overlap();

-- ---- Immutability ----------------------------------------------------------
-- A CLOSED interval is frozen forever. An OPEN one may be closed, or corrected while it is
-- still open. DELETE is refused unconditionally: history is never destroyed, not even when
-- the assignment row it describes is.
create function public.vendor_product_assign_history_assert_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Assignment history is append-only and cannot be deleted'
      using errcode = 'check_violation';
  end if;

  if old.valid_to is not null then
    raise exception 'A closed assignment history interval is immutable'
      using errcode = 'check_violation';
  end if;

  -- Identity and lineage are fixed even while the interval is open: re-pointing an
  -- interval at another pair would rewrite a fact rather than record one.
  if new.assignment_id is distinct from old.assignment_id
     or new.vendor_product_id is distinct from old.vendor_product_id
     or new.retailer_organization_id is distinct from old.retailer_organization_id
     or new.valid_from is distinct from old.valid_from then
    raise exception 'Assignment history identity is immutable'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger vendor_product_assign_history_append_only_on_update
  before update on public.vendor_product_retailer_assignment_history
  for each row execute function public.vendor_product_assign_history_assert_append_only();

create trigger vendor_product_assign_history_append_only_on_delete
  before delete on public.vendor_product_retailer_assignment_history
  for each row execute function public.vendor_product_assign_history_assert_append_only();

-- ============================================================================
-- PART 2 — the maintenance trigger
-- ============================================================================
-- AFTER, not BEFORE: set_updated_at and the two link/immutability validators already run
-- BEFORE on this table (migration 20260727090000), so an AFTER trigger sees the row
-- exactly as it will be stored rather than as it was proposed.
--
-- ONLY `status` MOVES THE TIMELINE. vendor_product_id and retailer_organization_id are
-- immutable on the source row, and assigned_by_profile_id / updated_at are administration
-- metadata that change nothing about eligibility. An update that leaves `status` alone
-- therefore writes NO history row — a timeline whose entries do not correspond to changes
-- in what it describes is worse than a shorter one.
create function public.vendor_product_assignment_record_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- clock_timestamp(), NOT now().
  --
  -- now() is the TRANSACTION start and is frozen for its whole duration, so two state
  -- changes to the same pair inside one transaction would both want to close and open at
  -- the identical instant — producing a zero-length interval that the interval check
  -- rejects, and forcing every such change to collapse into the previous one.
  -- clock_timestamp() advances, so each change gets its own ordered boundary and the
  -- timeline records when a change actually happened rather than when its transaction
  -- began. Captured ONCE per trigger invocation, so the interval that closes and the
  -- interval that opens share exactly one boundary and leave no gap between them.
  v_now       timestamptz := clock_timestamp();
  v_open_id   uuid;
  v_open_from timestamptz;
begin
  -- ---- INSERT: open the first interval ------------------------------------
  if tg_op = 'INSERT' then
    insert into public.vendor_product_retailer_assignment_history (
      assignment_id, vendor_product_id, retailer_organization_id,
      assignment_status, valid_from, valid_to
    )
    -- valid_from is the row's OWN assigned_at, not now(): the assignment began when the
    -- row says it began. For every shipped writer these are the same instant, because
    -- assigned_at defaults to now().
    values (new.id, new.vendor_product_id, new.retailer_organization_id,
            new.status, new.assigned_at, null);
    return new;
  end if;

  -- ---- DELETE: close the interval, destroy nothing -------------------------
  -- Unreachable today: assignment_id is ON DELETE RESTRICT and every assignment row has an
  -- interval, so the foreign key refuses the statement before this can run. Retained so a
  -- future migration that relaxes the constraint closes history instead of orphaning it.
  if tg_op = 'DELETE' then
    update public.vendor_product_retailer_assignment_history h
    set valid_to = v_now
    where h.vendor_product_id = old.vendor_product_id
      and h.retailer_organization_id = old.retailer_organization_id
      and h.valid_to is null
      -- Guard against the degenerate same-transaction insert-then-delete, which would
      -- otherwise produce a zero-length interval and abort a legitimate write.
      and h.valid_from < v_now;
    return old;
  end if;

  -- ---- UPDATE: only a status change moves the timeline ---------------------
  if new.status is not distinct from old.status then
    return new;
  end if;

  -- SELECT ... FOR UPDATE, so two concurrent status changes on the same pair serialize on
  -- the interval row rather than both closing it and both opening a successor. The
  -- open-interval unique index is the final authority if they somehow raced past this.
  select h.id, h.valid_from into v_open_id, v_open_from
  from public.vendor_product_retailer_assignment_history h
  where h.vendor_product_id = new.vendor_product_id
    and h.retailer_organization_id = new.retailer_organization_id
    and h.valid_to is null
  for update;

  if v_open_id is null then
    -- No interval in force. Reachable only for a row that predates this migration's
    -- backfill or whose history was never opened; recording the new state is strictly
    -- better than recording nothing.
    insert into public.vendor_product_retailer_assignment_history (
      assignment_id, vendor_product_id, retailer_organization_id,
      assignment_status, valid_from, valid_to
    )
    values (new.id, new.vendor_product_id, new.retailer_organization_id,
            new.status, v_now, null);
    return new;
  end if;

  if v_open_from >= v_now then
    -- The open interval starts at or after this instant, so closing it here would create a
    -- zero-length or inverted interval. With clock_timestamp() this is no longer the
    -- ordinary same-transaction case — it is reachable only when a row carries an
    -- assigned_at in the future — but it is kept as defence: the still-open, never-observed
    -- row is corrected in place rather than the write being aborted.
    update public.vendor_product_retailer_assignment_history h
    set assignment_status = new.status
    where h.id = v_open_id;
    return new;
  end if;

  update public.vendor_product_retailer_assignment_history h
  set valid_to = v_now
  where h.id = v_open_id;

  insert into public.vendor_product_retailer_assignment_history (
    assignment_id, vendor_product_id, retailer_organization_id,
    assignment_status, valid_from, valid_to
  )
  values (new.id, new.vendor_product_id, new.retailer_organization_id,
          new.status, v_now, null);

  return new;
end;
$$;

create trigger vendor_product_assignment_history_on_write
  after insert or update or delete on public.vendor_product_retailer_assignments
  for each row execute function public.vendor_product_assignment_record_history();

-- ============================================================================
-- PART 3 — RLS and privilege hardening
-- ============================================================================
-- RLS ON, ZERO POLICIES, and no privilege for any browser role — the same posture the
-- assignment table itself uses. This table is read only by SECURITY DEFINER resolvers and
-- written only by the trigger above, which runs as its owner.
alter table public.vendor_product_retailer_assignment_history enable row level security;

revoke all on table public.vendor_product_retailer_assignment_history
  from public, anon, authenticated;

revoke all on function public.vendor_product_assign_history_assert_no_overlap()   from public;
revoke all on function public.vendor_product_assign_history_assert_append_only()  from public;
revoke all on function public.vendor_product_assignment_record_history()          from public;

-- ============================================================================
-- PART 4 — backfill
-- ============================================================================
-- THE HONEST STATEMENT OF WHAT THIS DOES AND DOES NOT GIVE YOU
--
--   Temporal assignment history is AUTHORITATIVE FROM THIS MIGRATION'S DEPLOYMENT
--   TIMESTAMP ONWARD. Existing assignment rows are backfilled as their current known
--   state.
--
-- Every existing pair gets exactly one OPEN interval carrying its CURRENT status.
--
-- valid_from is the row's own `updated_at`, and that choice is deliberate. `updated_at` is
-- maintained by set_updated_at (migration 20260716125559) on every UPDATE, so for a row
-- that has been withdrawn it is the instant the withdrawal was written — which is exactly
-- when the current interval began. For a row that has never changed it equals
-- `assigned_at`, so an untouched assignment is dated from its assignment. Using
-- `assigned_at` for every row would have been WRONG for withdrawn rows: it would assert
-- that a product had been INACTIVE since the day it was assigned, which is the opposite of
-- what happened.
--
-- WHAT IS NOT RECOVERABLE, stated plainly: any state change that happened BEFORE this
-- migration ran. A pair that was assigned, withdrawn and re-assigned appears here as a
-- single interval beginning at its last change. The intervening states were overwritten in
-- place by the pre-history schema and are gone. NOTHING BELOW FABRICATES THEM.
--
-- This is acceptable because no campaign has been published anywhere yet — the campaign
-- tables do not exist on the hosted database at the time of writing — so no reward has
-- ever depended on an interval earlier than this one.
insert into public.vendor_product_retailer_assignment_history (
  assignment_id, vendor_product_id, retailer_organization_id,
  assignment_status, valid_from, valid_to
)
select a.id, a.vendor_product_id, a.retailer_organization_id,
       a.status, a.updated_at, null
from public.vendor_product_retailer_assignments a;

-- ============================================================================
-- PART 5 — point-in-time resolvers (INTERNAL)
-- ============================================================================
-- BOUNDARY SEMANTICS, applied identically by all three and by every caller:
--
--     valid_from <= as_of  AND  (valid_to IS NULL OR as_of < valid_to)
--
-- Half-open [valid_from, valid_to). The instant an interval BEGINS is inside it; the
-- instant it ENDS is not. That is what makes two adjacent intervals partition time without
-- a gap and without an instant belonging to both.
--
-- ALL THREE ARE INTERNAL — granted to no browser role. They accept a Retailer id and
-- resolve no tenant of their own, so exposing one directly would let a caller ask about a
-- Retailer they have no relationship with. They are reachable only from SECURITY DEFINER
-- contracts that have already resolved the caller from auth.uid(), which is the same
-- posture resolve_retailer_member_organization uses.

-- ---- The assignment state a pair held at an instant ------------------------
-- NULL means "no interval covered that instant" — the pair had not been assigned yet, or
-- (for an instant before this migration) is simply not recorded. NULL is deliberately NOT
-- collapsed into 'INACTIVE': "we have no record" and "it was withdrawn" are different
-- facts, and a reward engine must be able to tell them apart.
create function public.vendor_product_assignment_state_at(
  p_vendor_product_id        uuid,
  p_retailer_organization_id uuid,
  p_as_of                    timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select h.assignment_status
  from public.vendor_product_retailer_assignment_history h
  where h.vendor_product_id = p_vendor_product_id
    and h.retailer_organization_id = p_retailer_organization_id
    and h.valid_from <= p_as_of
    and (h.valid_to is null or p_as_of < h.valid_to)
  limit 1;
$$;

revoke all     on function public.vendor_product_assignment_state_at(uuid, uuid, timestamptz) from public;
revoke execute on function public.vendor_product_assignment_state_at(uuid, uuid, timestamptz) from anon;
revoke execute on function public.vendor_product_assignment_state_at(uuid, uuid, timestamptz) from authenticated;

-- ---- Was a product eligible for a Retailer at an instant? ------------------
-- Eligibility here means the ASSIGNMENT edge was ACTIVE at that instant.
--
-- KNOWN LIMITATION, stated rather than hidden: public.vendor_products.status is a SECOND
-- eligibility axis and it is NOT yet temporal — it is still overwritten in place, exactly
-- as the assignment status was before this migration. So this answers "was it assigned and
-- live to that Retailer then", and a product that has since been deactivated will still
-- report true for an instant when it was assigned. Making product status temporal is the
-- same shape of change as this migration and is deliberately out of scope here; the reward
-- engine milestone must either add it or state that it evaluates product status currently.
create function public.vendor_product_eligible_for_retailer_at(
  p_vendor_product_id        uuid,
  p_retailer_organization_id uuid,
  p_as_of                    timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.vendor_product_assignment_state_at(
      p_vendor_product_id, p_retailer_organization_id, p_as_of) = 'ACTIVE',
    false);
$$;

revoke all     on function public.vendor_product_eligible_for_retailer_at(uuid, uuid, timestamptz) from public;
revoke execute on function public.vendor_product_eligible_for_retailer_at(uuid, uuid, timestamptz) from anon;
revoke execute on function public.vendor_product_eligible_for_retailer_at(uuid, uuid, timestamptz) from authenticated;

-- ---- Every product eligible for a Retailer at an instant -------------------
-- The set-returning form the campaign reads use, so a caller never has to loop a
-- per-product resolver over a catalogue.
--
-- p_vendor_organization_id narrows the answer to ONE Vendor's catalogue. It is a filter,
-- not an authorization: the caller has already resolved both the Vendor and the Retailer
-- before it may reach this function at all.
create function public.vendor_retailer_eligible_products_at(
  p_retailer_organization_id uuid,
  p_vendor_organization_id   uuid,
  p_as_of                    timestamptz
)
returns table (vendor_product_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select h.vendor_product_id
  from public.vendor_product_retailer_assignment_history h
  join public.vendor_products vp on vp.id = h.vendor_product_id
  where h.retailer_organization_id = p_retailer_organization_id
    and h.assignment_status = 'ACTIVE'
    and h.valid_from <= p_as_of
    and (h.valid_to is null or p_as_of < h.valid_to)
    and vp.vendor_organization_id = p_vendor_organization_id
    -- The non-temporal product-status axis, per the limitation documented above.
    and vp.status = 'ACTIVE';
$$;

revoke all     on function public.vendor_retailer_eligible_products_at(uuid, uuid, timestamptz) from public;
revoke execute on function public.vendor_retailer_eligible_products_at(uuid, uuid, timestamptz) from anon;
revoke execute on function public.vendor_retailer_eligible_products_at(uuid, uuid, timestamptz) from authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One table, three indexes, five functions, four triggers, one backfill.
--
-- No existing table, column, constraint, index, policy, role, permission or mapping is
-- altered, and neither shipped assignment writer is touched — they gain history because
-- the trigger observes them, not because they were changed.
--
-- Nothing here evaluates a campaign, matches a receipt, computes progress, credits a coin
-- or records a claim or a payout. It records WHEN a product was available at a Retailer,
-- and nothing about what anyone earned.
