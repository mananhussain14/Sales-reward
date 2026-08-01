-- Migration: audit_log_append_only_hardening
-- Purpose: Makes public.audit_logs append-only in the DATABASE rather than by convention.
--          It adds, and only adds:
--            1. public.audit_logs_guard_change()   -- BEFORE UPDATE OR DELETE, per row
--            2. public.audit_logs_guard_truncate() -- BEFORE TRUNCATE, per statement
--            3. A revoke of every remaining service_role privilege on the table.
--
-- WHY NOW. Migration 20260716130351 created audit_logs and described it as "append-only by
--   design: no updated_at column, no updated_at trigger". That was a statement about how the
--   table would be USED, and nothing enforced it: no trigger refused an UPDATE or a DELETE,
--   and service_role retained TRUNCATE. The reward-evaluation milestones that follow will
--   lean on this table to explain why a coin was credited, so "append-only" has to become a
--   property of the schema before anything financial references it.
--
-- ============================================================================
-- THE ONE UPDATE THAT MUST STILL BE PERMITTED
-- ============================================================================
-- audit_logs carries two nullable foreign keys that are BOTH declared ON DELETE SET NULL:
--
--     organization_id  REFERENCES public.organizations (id) ON DELETE SET NULL
--     actor_profile_id REFERENCES public.profiles      (id) ON DELETE SET NULL
--
-- Deleting an auth user cascades to public.profiles, and PostgreSQL then performs an
-- ORDINARY UPDATE on every audit row that named that profile in order to null the column.
-- An unconditional "reject every UPDATE" trigger would therefore make it IMPOSSIBLE to
-- delete a user or an organization at all -- turning a deliberate, tested schema decision
-- ("losing an actor costs the record its attribution, never its existence or its content",
-- vendor_audit_log_reads_test Section L) into a hard failure.
--
-- So the guard permits EXACTLY that transition and nothing else:
--
--     organization_id  : a value -> NULL        permitted
--     actor_profile_id : a value -> NULL        permitted
--     either one       : NULL -> a value        REFUSED (attribution cannot be restored)
--     either one       : value -> another value REFUSED (attribution cannot be moved)
--     every other column                        REFUSED
--     an UPDATE that changes nothing at all     REFUSED (see below)
--
-- This is the same shape campaign_version_assert_immutable() uses: permit one structurally
-- necessary transition, name it, and refuse everything else. It is deliberately NOT written
-- as "allow updates that only touch these two columns", because that phrasing would also
-- admit re-pointing an audit row at a different organization.
--
-- WHY A NO-OP UPDATE IS REFUSED TOO. An UPDATE that changes nothing is not a foreign-key
-- attribution clear; it is a probe. Letting it succeed would mean "this row accepted an
-- UPDATE", which is exactly the answer this table must never give. The trigger therefore
-- requires that at least one of the two clears actually happened.
--
-- ============================================================================
-- WHY A SEPARATE TRUNCATE TRIGGER
-- ============================================================================
-- TRUNCATE does not fire row-level triggers. A BEFORE UPDATE OR DELETE FOR EACH ROW guard is
-- therefore completely bypassed by one TRUNCATE statement, which is the single fastest way
-- to destroy an audit trail. Two independent defences are installed:
--
--   * the statement-level trigger below, which refuses TRUNCATE for EVERY role including the
--     table owner; and
--   * the privilege revoke, which removes TRUNCATE from service_role.
--
-- Either alone would be sufficient today. Both are installed because they fail differently:
-- a privilege can be re-granted by a future migration that does not realise what it is
-- undoing, and a trigger can be disabled only by the table owner in a deliberate,
-- superuser-level act.
--
-- ============================================================================
-- WHAT THE REVOKE CAN AND CANNOT BREAK -- verified before writing
-- ============================================================================
-- Every writer of this table was inspected. There are 39 INSERT statements across 33
-- functions; ALL 33 are SECURITY DEFINER and owned by `postgres`, so they execute with the
-- table owner's privileges and are completely unaffected by any role-level revoke.
--   * NOT ONE of them performs an UPDATE, a DELETE or a TRUNCATE of audit_logs.
--   * NO Edge Function references audit_logs at all, so there is no direct service-role
--     audit writer to preserve.
--   * service_role currently holds Dxtm (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) and does
--     NOT hold INSERT or SELECT, so removing its privileges cannot break an insert path that
--     never existed.
--   * The application reads audit_logs through the USER-SCOPED SSR client
--     (lib/audit/vendor-audit-logs.ts and lib/dashboard/vendor-admin-summary.ts both use
--     @/lib/supabase/server), which authenticates as `authenticated`, never as service_role.
--
-- THE authenticated SELECT GRANT IS DELIBERATELY LEFT ALONE. Migration 20260716131930
-- granted SELECT to authenticated and created audit_logs_select_authorized to narrow it row
-- by row. Both remain exactly as they were: this migration adds no policy, drops no policy,
-- and revokes nothing from authenticated.
--
-- FINAL PRIVILEGE MATRIX for public.audit_logs after this migration:
--
--   role           SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER MAINTAIN
--   postgres        yes    yes   trigger trigger trigger   yes       yes      yes
--   authenticated   yes*   no    no      no      no        no        no       yes**
--   anon            no     no    no      no      no        no        no       no
--   service_role    no     no    no      no      no        no        no       no
--
--   *  further narrowed row-by-row by audit_logs_select_authorized.
--   ** MAINTAIN is a PostgreSQL 17 privilege (VACUUM / ANALYZE / REINDEX / CLUSTER). It
--      predates nothing and grants no ability to read or change a row's contents, so it is
--      left as-is rather than altered by a migration whose subject is immutability.
--      "trigger" means the privilege is held but every statement using it is refused by the
--      guards below -- the owner is not exempt.
--
-- Idempotency posture: plain CREATE (no IF NOT EXISTS, no CREATE OR REPLACE). A conflicting
--   existing object FAILS the migration. No fixed UUIDs. No dynamic SQL. All identifiers are
--   <= 63 bytes. Every reference is schema-qualified because every function runs with an
--   EMPTY search_path.
--
-- Dependencies: 20260716130351 (audit_logs), 20260716131930 (the authenticated SELECT grant
--   and audit_logs_select_authorized, both left untouched).

-- ============================================================================
-- PART 1 -- the row guard
-- ============================================================================
create function public.audit_logs_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clears_org   boolean;
  v_clears_actor boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'An audit log record is append-only and cannot be deleted'
      using errcode = 'check_violation';
  end if;

  -- The two permitted attribution clears, each requiring the column to have held a value.
  v_clears_org   := old.organization_id  is not null and new.organization_id  is null;
  v_clears_actor := old.actor_profile_id is not null and new.actor_profile_id is null;

  -- Every other column must be byte-identical, and neither foreign key may move to a
  -- DIFFERENT value or be restored from NULL. `is distinct from` is used throughout so a
  -- NULL on either side compares correctly.
  if new.id           is distinct from old.id
     or new.action      is distinct from old.action
     or new.entity_type is distinct from old.entity_type
     or new.entity_id   is distinct from old.entity_id
     or new.metadata    is distinct from old.metadata
     or new.ip_address  is distinct from old.ip_address
     or new.user_agent  is distinct from old.user_agent
     or new.created_at  is distinct from old.created_at
     or (new.organization_id  is distinct from old.organization_id  and not v_clears_org)
     or (new.actor_profile_id is distinct from old.actor_profile_id and not v_clears_actor)
  then
    raise exception 'An audit log record is immutable'
      using errcode = 'check_violation';
  end if;

  -- Nothing was cleared, so this UPDATE is not a foreign-key attribution clear. Refusing it
  -- is what stops "immutable" being probed with a touch that appears to succeed.
  if not v_clears_org and not v_clears_actor then
    raise exception 'An audit log record is immutable'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger audit_logs_guard_change
  before update or delete on public.audit_logs
  for each row execute function public.audit_logs_guard_change();

-- ============================================================================
-- PART 2 -- the TRUNCATE guard
-- ============================================================================
create function public.audit_logs_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'An audit log record is append-only and cannot be truncated'
    using errcode = 'check_violation';
end;
$$;

create trigger audit_logs_guard_truncate
  before truncate on public.audit_logs
  for each statement execute function public.audit_logs_guard_truncate();

-- ============================================================================
-- PART 3 -- privilege hardening
-- ============================================================================
-- service_role reaches every legitimate audit path through SECURITY DEFINER functions, which
-- run as the owner and are unaffected by this revoke. It holds no INSERT and no SELECT today,
-- so this removes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN and nothing that is in use.
--
-- TRUNCATE is the one that matters: it bypasses the row trigger in PART 1 outright.
revoke all on table public.audit_logs from service_role;

-- The guard functions are internal; nothing but the table's own triggers may call them.
-- Matches the posture of every other validator in this schema.
revoke all on function public.audit_logs_guard_change()   from public;
revoke all on function public.audit_logs_guard_truncate() from public;

-- ============================================================================
-- Closing note
-- ============================================================================
-- Two functions, two triggers, one revoke.
--
-- No table, column, constraint, index or policy is created, altered or dropped. The
-- authenticated SELECT grant and audit_logs_select_authorized are byte-untouched, so every
-- existing authorized audit read behaves exactly as it did. No existing function is
-- modified, so all 33 audit writers continue to insert exactly as they did.
--
-- Nothing here evaluates a campaign, matches a receipt, computes progress or credits a coin.
