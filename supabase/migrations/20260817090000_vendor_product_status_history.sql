-- Migration: vendor_product_status_history
-- Purpose: Makes "was this product ACTIVE when the sale happened?" answerable. It adds, and
--          only adds:
--            1. public.vendor_product_status_history -- an append-only interval table
--               recording every state public.vendor_products.status has held.
--            2. The trigger that maintains it automatically on public.vendor_products.
--            3. A conservative backfill of every product that exists today.
--            4. One INTERNAL point-in-time resolver.
--          Plus the immutability and non-overlap guards, and default-deny RLS.
--
-- ============================================================================
-- WHY THIS EXISTS -- IT CLOSES A LIMITATION THIS PROJECT ALREADY NAMED
-- ============================================================================
-- Migration 20260814210000 made the product/Retailer ASSIGNMENT edge temporal, and its
-- vendor_product_eligible_for_retailer_at() header states the gap it deliberately left:
--
--     "public.vendor_products.status is a SECOND eligibility axis and it is NOT yet temporal
--      -- it is still overwritten in place, exactly as the assignment status was before this
--      migration. [...] Making product status temporal is the same shape of change as this
--      migration and is deliberately out of scope here; the reward engine milestone must
--      either add it or state that it evaluates product status currently."
--
-- This migration is that follow-up, and it chooses ADD rather than state-the-limitation. A
-- product deactivated in November must not change the answer for a September sale: the
-- campaign was offered, the product was live, the sale happened. Evaluating today's status
-- against a past sale would silently withdraw a reward that was genuinely earned.
--
-- update_vendor_product (migration 20260727210000) writes `status` in place, so the previous
-- answer is destroyed the moment it changes -- the same defect, in the same shape, that the
-- assignment timeline already fixed for the other axis.
--
-- ============================================================================
-- WHY A TRIGGER RATHER THAN A SHARED WRITER FUNCTION
-- ============================================================================
-- Verbatim the reason 20260814210000 gives: a helper only records what its callers remember
-- to call; a trigger records what actually happened. The shipped writer, update_vendor_product,
-- is untouched by this migration and gains history for free, and so does any future RPC,
-- repair migration or trusted server-side correction. The history cannot be bypassed by
-- writing the table a different way.
--
-- ============================================================================
-- THE TWO AXES ARE SEPARATE, AND BOTH ARE REQUIRED
-- ============================================================================
-- After this migration a reward engine answers "was this product eligible for this Retailer
-- at instant T?" from TWO independent timelines:
--
--     public.vendor_product_eligible_for_retailer_at(product, retailer, T)   -- assignment
--     public.vendor_product_status_at(product, T) = 'ACTIVE'                 -- catalogue
--
-- They are deliberately NOT merged into one resolver. The assignment edge is a
-- Vendor-to-Retailer fact and the status is a catalogue-wide fact; collapsing them would
-- produce a single boolean that cannot explain WHICH axis refused, and a support conversation
-- needs to know that.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--   No reward, coin, ledger, balance, contribution, award, claim or payout object.
--   No change to vendor_products, to update_vendor_product, or to any catalogue RPC. Not a
--   column, constraint, index, trigger or grant on the source table is touched.
--   No merge into vendor_product_eligible_for_retailer_at, whose documented meaning stays
--   exactly as shipped so no existing caller silently changes behaviour.
--   No policy: the table is RPC-only and default-deny.
--
-- Idempotency posture: plain CREATE / INSERT (no IF NOT EXISTS, no CREATE OR REPLACE, no ON
--   CONFLICT). A conflicting existing object FAILS the migration. No fixed UUIDs. No dynamic
--   SQL. All identifiers are <= 63 bytes. Every reference is schema-qualified because every
--   function runs with an EMPTY search_path.
--
-- Dependencies: 20260727090000 (vendor_products and its ACTIVE/INACTIVE vocabulary),
--   20260814210000 (the assignment timeline this one sits beside, and whose conventions it
--   follows exactly).

-- ============================================================================
-- PART 1 -- the history table
-- ============================================================================
create table public.vendor_product_status_history (
  id uuid primary key default gen_random_uuid(),

  -- The product this interval describes. RESTRICT, like every other reference in this schema:
  -- a product with recorded history cannot be hard-deleted out from under it. This also makes
  -- deleting a product structurally impossible from this migration onward, which is a
  -- strengthening of the same kind 20260814210000 applied to assignment rows.
  vendor_product_id uuid not null
    references public.vendor_products (id) on delete restrict,

  -- The state held during this interval. The SAME vocabulary the source table permits, per
  -- vendor_products_status_allowed. No new vocabulary is invented here: a history table that
  -- spoke a different language than the table it records would need a mapping, and a mapping
  -- is a place for the two to disagree.
  product_status text not null,

  -- HALF-OPEN INTERVAL: [valid_from, valid_to).
  -- valid_to IS NULL means "still in force". See PART 5 for the boundary semantics.
  valid_from timestamptz not null,
  valid_to timestamptz,

  -- When this ROW was written, as opposed to when the fact it records began. They differ for
  -- the backfill in PART 4, and keeping both is what lets a reader tell a reconstructed
  -- interval from an observed one.
  recorded_at timestamptz not null default now(),

  -- HOW this row came to exist. Identical vocabulary and identical purpose to
  -- campaign_version_status_history.history_source (migration 20260816210000): without it, a
  -- backfilled interval starting at the migration instant is indistinguishable from a product
  -- genuinely created then, and the engine could not tell "unrecorded" from "observed".
  history_source text not null default 'OBSERVED',

  constraint vendor_product_status_history_status_allowed
    check (product_status = any (array['ACTIVE'::text, 'INACTIVE'::text])),

  constraint vendor_product_status_history_source_allowed
    check (history_source = any (array['OBSERVED'::text, 'BACKFILL_CURRENT_STATE'::text])),

  -- Strictly ordered. A zero-length interval would be invisible to every half-open query
  -- anyway, so admitting one would only create rows that mean nothing.
  constraint vendor_product_status_history_interval_ordered
    check (valid_to is null or valid_to > valid_from)
);

comment on table public.vendor_product_status_history is
  'Append-only half-open [valid_from, valid_to) intervals recording every state a Vendor product''s catalogue status has held. Authoritative from this migration''s deployment onward.';

-- ---- Indexes ---------------------------------------------------------------

-- THE OPEN-INTERVAL CONCURRENCY AUTHORITY. At most ONE interval may be in force for a product
-- at any moment. This is what makes "the current interval" a definite article, and it is
-- enforced by the database rather than by the trigger's good behaviour.
create unique index vendor_product_status_history_open_idx
  on public.vendor_product_status_history (vendor_product_id)
  where valid_to is null;

-- The point-in-time resolver's access path: one product, ordered by interval start.
create index vendor_product_status_history_product_idx
  on public.vendor_product_status_history (vendor_product_id, valid_from desc);

-- ---- Non-overlap -----------------------------------------------------------
-- The open-interval index above forbids two CURRENT intervals. This forbids two intervals
-- that overlap anywhere at all -- including two closed ones, which a mis-timed backfill or a
-- future repair could otherwise create. A trigger rather than an EXCLUDE constraint, for the
-- btree_gist reason 20260814210000 documents.
create function public.vendor_product_status_history_assert_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- An INVERTED interval is not this trigger's error to report; see the identical note in
  -- vendor_product_assign_history_assert_no_overlap.
  if new.valid_to is not null and new.valid_to <= new.valid_from then
    return new;
  end if;

  if exists (
    select 1
    from public.vendor_product_status_history h
    where h.vendor_product_id = new.vendor_product_id
      and h.id <> new.id
      -- '[)' matches the half-open reading every resolver uses, so two intervals that merely
      -- touch do NOT overlap.
      and tstzrange(h.valid_from, h.valid_to, '[)')
          && tstzrange(new.valid_from, new.valid_to, '[)')
  ) then
    raise exception 'Product status history intervals cannot overlap'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger vendor_product_status_history_no_overlap
  before insert or update on public.vendor_product_status_history
  for each row execute function public.vendor_product_status_history_assert_no_overlap();

-- ---- Immutability ----------------------------------------------------------
-- A CLOSED interval is frozen forever. An OPEN one may only be CLOSED. DELETE is refused
-- unconditionally.
--
-- As in campaign_version_status_history, there is no "correct an open interval's status"
-- branch: every boundary here is a clock_timestamp() reading taken by the trigger in PART 2,
-- which additionally guarantees a strictly increasing boundary, so a zero-length interval
-- cannot arise and there is nothing to correct.
create function public.vendor_product_status_history_assert_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Product status history is append-only and cannot be deleted'
      using errcode = 'check_violation';
  end if;

  if old.valid_to is not null then
    raise exception 'A closed product status history interval is immutable'
      using errcode = 'check_violation';
  end if;

  if new.id                is distinct from old.id
     or new.vendor_product_id is distinct from old.vendor_product_id
     or new.product_status    is distinct from old.product_status
     or new.valid_from        is distinct from old.valid_from
     or new.recorded_at       is distinct from old.recorded_at
     or new.history_source    is distinct from old.history_source then
    raise exception 'Product status history identity is immutable'
      using errcode = 'check_violation';
  end if;

  if new.valid_to is null then
    raise exception 'An open product status history interval may only be closed'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger vendor_product_status_history_append_only_on_update
  before update on public.vendor_product_status_history
  for each row execute function public.vendor_product_status_history_assert_append_only();

create trigger vendor_product_status_history_append_only_on_delete
  before delete on public.vendor_product_status_history
  for each row execute function public.vendor_product_status_history_assert_append_only();

-- ============================================================================
-- PART 2 -- the maintenance trigger
-- ============================================================================
-- AFTER, not BEFORE: set_updated_at, vendor_products_assert_vendor_type and
-- vendor_products_assert_immutable already run BEFORE on this table (migration
-- 20260727090000), so an AFTER trigger sees the row exactly as it will be stored.
--
-- ONLY `status` MOVES THE TIMELINE. vendor_organization_id, product_code and
-- created_by_profile_id are immutable on the source row; product_name, brand, description and
-- barcode are descriptions of a product rather than facts about whether it was sellable. An
-- update that leaves `status` alone therefore writes NO history row.
create function public.vendor_product_record_status_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- clock_timestamp(), NOT now(), for the reason 20260814210000 gives: now() is frozen for
  -- the whole transaction, so two status changes to one product inside one transaction would
  -- both want to close and open at the identical instant. Captured ONCE per invocation, so
  -- the interval that closes and the interval that opens share exactly one boundary.
  v_now       timestamptz := clock_timestamp();
  v_open_id   uuid;
  v_open_from timestamptz;
  v_boundary  timestamptz;
begin
  -- ---- INSERT: open the first interval -------------------------------------
  if tg_op = 'INSERT' then
    insert into public.vendor_product_status_history (
      vendor_product_id, product_status, valid_from, valid_to, history_source
    )
    -- valid_from is the row's OWN created_at, not now(): the product held this status from
    -- the moment it existed. For every shipped writer these are the same instant, because
    -- created_at defaults to now(). This mirrors the assignment timeline's use of the row's
    -- own assigned_at.
    values (new.id, new.status, new.created_at, null, 'OBSERVED');
    return new;
  end if;

  -- ---- UPDATE: close the open interval and open the next -------------------
  select h.id, h.valid_from
    into v_open_id, v_open_from
  from public.vendor_product_status_history h
  where h.vendor_product_id = new.id
    and h.valid_to is null
  for update;

  if v_open_id is not null then
    -- STRICTLY INCREASING BOUNDARY, for the reason given in 20260816210000: a boundary equal
    -- to valid_from would produce a zero-length interval that the interval CHECK rejects,
    -- turning an ordinary deactivation into a failed transaction.
    v_boundary := greatest(v_now, v_open_from + interval '1 microsecond');

    update public.vendor_product_status_history h
    set valid_to = v_boundary
    where h.id = v_open_id;
  else
    -- No open interval. Reachable only for a product that predates this migration and was
    -- somehow missed by the backfill, or for one whose history was never opened. Opening one
    -- now is strictly better than losing the change.
    v_boundary := v_now;
  end if;

  insert into public.vendor_product_status_history (
    vendor_product_id, product_status, valid_from, valid_to, history_source
  )
  values (new.id, new.status, v_boundary, null, 'OBSERVED');

  return new;
end;
$$;

create trigger vendor_products_record_status_history_on_insert
  after insert on public.vendor_products
  for each row execute function public.vendor_product_record_status_history();

create trigger vendor_products_record_status_history_on_update
  after update of status on public.vendor_products
  for each row
  when (new.status is distinct from old.status)
  execute function public.vendor_product_record_status_history();

-- ============================================================================
-- PART 3 -- RLS and privilege hardening
-- ============================================================================
-- RLS ON, and ZERO POLICIES. Every read goes through a SECURITY DEFINER contract that
-- resolves the caller from auth.uid(). service_role is revoked too: TRUNCATE bypasses row
-- triggers and would defeat the append-only guards outright.
alter table public.vendor_product_status_history enable row level security;

revoke all on table public.vendor_product_status_history from public;
revoke all on table public.vendor_product_status_history from anon;
revoke all on table public.vendor_product_status_history from authenticated;
revoke all on table public.vendor_product_status_history from service_role;

revoke all on function public.vendor_product_status_history_assert_no_overlap()  from public;
revoke all on function public.vendor_product_status_history_assert_append_only() from public;
revoke all on function public.vendor_product_record_status_history()             from public;

-- ============================================================================
-- PART 4 -- backfill
-- ============================================================================
-- CONSERVATIVE BY CONSTRUCTION, for exactly the reason PART 4 of 20260816210000 gives.
--
-- What can be reconstructed honestly: the status each product holds RIGHT NOW.
--
-- What is NOT invented here: every ACTIVE -> INACTIVE and INACTIVE -> ACTIVE transition that
-- has already happened. vendor_products.updated_at records when the row last changed, not
-- what it changed FROM, and a product whose name was edited yesterday carries an updated_at
-- that says nothing at all about its status history.
--
-- USING created_at WOULD BE THE TEMPTING MISTAKE. A product created ACTIVE and never touched
-- has held ACTIVE since created_at, so an interval from created_at would be right -- for that
-- product. For a product that was deactivated and reactivated it would CLAIM a continuous
-- interval that is false, and nothing in the row distinguishes the two cases. One rule that
-- is always honest beats a rule that is usually right, so every legacy product gets the same
-- conservative treatment: an open interval starting at the migration instant, marked
-- BACKFILL_CURRENT_STATE.
--
-- The resolver in PART 5 therefore returns NULL for every instant before this migration, and
-- NULL means "no authoritative record" -- deliberately NOT collapsed into 'INACTIVE'.
--
-- Products created AFTER this migration get an OBSERVED interval from their own created_at
-- via the INSERT trigger, so the conservative window applies only to the legacy set.
insert into public.vendor_product_status_history (
  vendor_product_id, product_status, valid_from, valid_to, history_source
)
select p.id, p.status, now(), null, 'BACKFILL_CURRENT_STATE'
from public.vendor_products p;

-- ============================================================================
-- PART 5 -- point-in-time resolver (INTERNAL)
-- ============================================================================
-- BOUNDARY SEMANTICS, identical to both sibling timelines:
--
--     valid_from <= as_of  AND  (valid_to IS NULL OR as_of < valid_to)
--
-- INTERNAL -- granted to no browser role. It accepts a product id and resolves no tenant of
-- its own, so exposing it directly would let a caller probe another Vendor's catalogue one id
-- at a time. It is reachable only from SECURITY DEFINER contracts that have already resolved
-- the caller from auth.uid().
--
-- NULL means "no interval covered that instant" -- the product did not exist yet, or (for an
-- instant before this migration) is simply not recorded. NULL is deliberately NOT collapsed
-- into 'INACTIVE': "we have no record" and "it was deactivated" are different facts, and a
-- reward engine must be able to tell them apart and refuse rather than guess.
create function public.vendor_product_status_at(
  p_vendor_product_id uuid,
  p_as_of             timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select h.product_status
  from public.vendor_product_status_history h
  where h.vendor_product_id = p_vendor_product_id
    and h.valid_from <= p_as_of
    and (h.valid_to is null or p_as_of < h.valid_to)
  limit 1;
$$;

revoke all     on function public.vendor_product_status_at(uuid, timestamptz) from public;
revoke execute on function public.vendor_product_status_at(uuid, timestamptz) from anon;
revoke execute on function public.vendor_product_status_at(uuid, timestamptz) from authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One table, two indexes, four functions, four triggers, one conservative backfill.
--
-- No existing table, column, constraint, index, policy, role, permission or mapping is
-- altered, and the shipped catalogue writers are untouched -- they gain history because the
-- trigger observes them, not because they were changed.
--
-- Nothing here evaluates a campaign, matches a receipt, computes progress or credits a coin.
-- It records WHEN a product was sellable, and nothing about what anyone earned.
