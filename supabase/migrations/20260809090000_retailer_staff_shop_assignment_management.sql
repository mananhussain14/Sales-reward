-- Migration: retailer_staff_shop_assignment_management
-- Purpose: Adds exactly ONE function and nothing else:
--            public.set_retailer_staff_shop_assignments(uuid, uuid[])
--          the Retailer Owner's POST-ACCEPTANCE replacement of an existing Sales
--          Staff member's assigned shops.
--
-- WHY THIS EXISTS — the gap it closes
--   Shop assignments were writable at exactly one moment in a staff member's life:
--   public.accept_retailer_staff_invitation(text) copies the invitation's immutable
--   intended-shop rows into public.retailer_shop_members and nothing has been able to
--   change them since. An Owner whose staff member moved between shops had no
--   operation at all — not a partial one, not an unsafe one, none. The only recorded
--   alternative was to revoke and re-issue an invitation, which the recipient has
--   already accepted and cannot accept twice.
--
--   This is that missing operation, and it is the whole of this milestone. It does NOT
--   invite, resend, revoke, change a role, activate, deactivate, touch credentials,
--   manage Retailer Managers, or let staff change their own assignments.
--
-- REPLACEMENT SEMANTICS, SCOPED TO THE ACTIVE-SHOP PROJECTION
--   The caller sends the COMPLETE requested shop set, not a list of additions and
--   removals. Add/keep/remove is computed here, from the caller's request against the
--   rows as they actually are, so no client claim about the current state is ever
--   trusted and a retried request is a no-op rather than a double-application.
--
--   The replacement is deliberately scoped to shops that are currently ACTIVE, because
--   that is EXACTLY what the client can see. public.list_retailer_staff_members()
--   filters its shop_ids/shop_names to `s.status = 'ACTIVE'`, so a live assignment to a
--   SUSPENDED or DEACTIVATED shop is INVISIBLE in the only roster the application has.
--   A naive "retire every live row not in the request" would therefore silently destroy
--   an assignment the Owner was never shown and did not intend to touch — and, because
--   this table is history-preserving rather than restorable, would destroy it for good
--   the moment the shop was reactivated.
--
--   So:
--     * every requested shop must be ACTIVE and belong to this Retailer;
--     * a requested shop with no live assignment      -> a NEW row is inserted;
--     * a requested shop with a live assignment       -> the row is left ALONE;
--     * a live assignment to an ACTIVE shop that was
--       NOT requested                                 -> retired (removed_at = now());
--     * a live assignment to a NON-ACTIVE shop        -> PRESERVED, untouched, and
--                                                        counted in none of the three
--                                                        returned totals.
--
--   The pair (roster shop_ids, list_retailer_staff_assignable_shops) is therefore a
--   complete and honest basis for the edit: everything the client can see is exactly
--   everything this function will change, and nothing it cannot see can be destroyed
--   by it.
--
-- AT LEAST ONE SHOP, ALWAYS
--   An empty (or null) requested set is REFUSED. The rule already existed at both
--   invitation choke points — reserve_retailer_staff_invitation raises 23514 and
--   accept_retailer_staff_invitation raises 42501 for a zero-shop SALES_STAFF — and
--   this is the third and final write that could have broken it. There is deliberately
--   no "stand this person down" path here: emptying a shop list is not a lifecycle
--   decision, and staff activation/deactivation is a separate future milestone that
--   will own it. Until then an Owner who wants someone off the floor leaves one shop
--   assigned and deactivates the membership when that milestone ships.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * No table, column, constraint, index, trigger, policy, role, permission, or
--     role-permission mapping is created, altered, or dropped. RETAILER_STAFF_SHOP_ASSIGN
--     and its RETAILER_OWNER mapping already exist (migration 20260722210000) and are the
--     authority; no role code appears in the function body.
--   * No existing function is touched. list_retailer_staff_members(),
--     list_retailer_staff_assignable_shops(), and every invitation / acceptance /
--     delivery / portal function are byte-identical to what their own migrations left.
--     No read contract changes, so no shipped client can break.
--   * No table privilege is granted to any browser role. public.retailer_shop_members
--     keeps RLS enabled with ZERO policies and REVOKE ALL from public / anon /
--     authenticated; this function is the only way in.
--   * No hard delete, anywhere. Retirement is `removed_at = now()` and history
--     accumulates, exactly as the table was designed for.
--   * No service_role grant. The entire authority of this write is auth.uid(); a
--     service-role path would let one Retailer's staff assignments be rewritten with no
--     session at all.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE).
--   A conflicting existing object FAILS the migration, matching every function migration
--   in this repository. No fixed UUIDs. No dynamic SQL. All identifiers are <= 63 bytes.
--   Every reference is schema-qualified because the function runs with an EMPTY
--   search_path.
--
-- Dependencies:
--   * 20260716124419 (profiles, organizations, organization_members, set_updated_at()).
--   * 20260716125559 (roles, member_roles).
--   * 20260716130351 (audit_logs).
--   * 20260717094520 (retailer_shops and its status domain).
--   * 20260722210000 (retailer_shop_members, its live-unique index and tenant trigger;
--     the RETAILER_STAFF_SHOP_ASSIGN permission and its RETAILER_OWNER mapping).
--   * 20260723090000 (resolve_retailer_member_organization).
--   * 20260724210000 (accept_retailer_staff_invitation — the shop-locking and
--     all-or-nothing validation patterns reused below; list_retailer_staff_members,
--     whose ACTIVE-shop projection this function is scoped to match).

-- ============================================================================
-- FUNCTION — set_retailer_staff_shop_assignments(uuid, uuid[])
-- ============================================================================
-- TWO ARGUMENTS, AND NOTHING ELSE. A membership to address and the complete shop set to
-- assign. There is no Retailer id, organization id, actor id, profile id, auth user id,
-- role code, permission code, status, timestamp, current-assignment list, add/remove
-- pair, or audit field in this signature — so no URL segment, form field, header, or
-- cookie can nominate whose staff are changed, on whose authority, or into what state.
-- Everything that decides WHETHER the write may happen is derived from auth.uid().
--
-- THE TARGET IS A MEMBERSHIP ID, and that is the canonical, safe identifier:
--   * it is the exact FK target of retailer_shop_members.organization_member_id, so no
--     resolution step stands between what the caller names and what is written;
--   * it is already in the roster contract (list_retailer_staff_members.membership_id),
--     released only to a holder of RETAILER_STAFF_READ, so this introduces no new
--     disclosure of any kind;
--   * organization_members is UNIQUE (organization_id, user_id), so a membership id
--     names exactly one person IN EXACTLY ONE ORGANIZATION. That is what makes the
--     single `m.organization_id = v_retailer` predicate below a complete cross-tenant
--     boundary. A profile id or an Auth user id could not do this — one person may be
--     staff at several Retailers, so neither addresses a membership on its own.
--
-- RETURNS ONE ROW OF THREE COUNTS. shops_added / shops_removed / shops_unchanged, all
-- non-null and >= 0, describing only the ACTIVE-shop projection. No id, no name, no
-- timestamp, no status, no audit detail, and above all no hidden non-ACTIVE assignment
-- crosses this boundary — the counts let a client render honest feedback ("nothing to
-- save", "2 added, 1 removed") without a second read and without learning anything the
-- roster would not already have told it.
--
-- REFUSALS ARE GENERIC AND UNIFORM. An unauthenticated caller, a Manager, a Sales Staff
-- member, a Vendor, a caller who resolves to zero or to several Retailers, a null /
-- unknown / another Retailer's / inactive / non-Sales-Staff target all receive the SAME
-- 42501 and the SAME message. That is what stops a caller sweeping membership ids to
-- learn which ones exist somewhere else.
create function public.set_retailer_staff_shop_assignments(
  p_membership_id uuid,
  p_shop_ids      uuid[]
)
returns table (
  shops_added     integer,
  shops_removed   integer,
  shops_unchanged integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor         uuid;
  v_retailer      uuid;
  v_org_status    text;
  v_org_type      text;
  v_retailer_name text;
  v_member_id     uuid;
  v_role_codes    text[];
  v_shop_ids      uuid[];
  v_shop_count    integer;
  v_locked_count  integer;
  v_shop_id       uuid;
  v_added         integer := 0;
  v_removed       integer := 0;
  v_unchanged     integer := 0;
  v_added_names   text[]  := '{}'::text[];
  v_removed_names text[]  := '{}'::text[];
begin
  -- --------------------------------------------------------------------------
  -- 1. Authorization — identity and Retailer, never browser-supplied
  -- --------------------------------------------------------------------------
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not authorized to update shop assignments'
      using errcode = 'insufficient_privilege';
  end if;

  -- The permission is the gate, and the MAPPING is the authority — not this function.
  -- RETAILER_STAFF_SHOP_ASSIGN is currently mapped to RETAILER_OWNER alone, so a
  -- RETAILER_MANAGER (who holds RETAILER_STAFF_READ and RETAILER_SHOPS_READ) and a
  -- SALES_STAFF member both resolve to NULL here and are refused. No role code is named
  -- below: if a future migration grants this permission to another role, that role gains
  -- this operation without this file being edited.
  --
  -- The resolver also fails closed on zero or on MORE THAN ONE qualifying Retailer, and
  -- independently requires an ACTIVE profile, an ACTIVE membership, an ACTIVE
  -- organization of type RETAILER, and an ACTIVE role.
  v_retailer := public.resolve_retailer_member_organization('RETAILER_STAFF_SHOP_ASSIGN');
  if v_retailer is null then
    raise exception 'Not authorized to update shop assignments'
      using errcode = 'insufficient_privilege';
  end if;

  -- Re-affirm the actor's profile, so the assigned_by written below is a valid, ACTIVE
  -- actor id. auth.uid() IS the profile's primary key. Matches
  -- reserve_retailer_staff_invitation step 1.
  if not exists (
    select 1 from public.profiles p where p.id = v_actor and p.status = 'ACTIVE'
  ) then
    raise exception 'Not authorized to update shop assignments'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock the resolved Retailer against a concurrent lifecycle change and re-verify.
  -- The resolver already required ACTIVE + RETAILER, so in the ordinary case this is
  -- defence in depth and 55000 is unreachable through it; it becomes reachable only if
  -- the organization changes between the resolver's read and this lock. The Retailer
  -- name is also read here, for the audit row.
  select o.status, o.organization_type, o.name
    into v_org_status, v_org_type, v_retailer_name
  from public.organizations o
  where o.id = v_retailer
  for share;

  if v_org_type is distinct from 'RETAILER' or v_org_status is distinct from 'ACTIVE' then
    raise exception 'This Retailer is not active'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Input canonicalization
  -- --------------------------------------------------------------------------
  -- A NULL element is REJECTED: it is malformed input, not a redundant one, and there is
  -- no shop it could mean. NULL and '{}' as the array ITSELF are the same zero-shop
  -- input and are refused together in step 5 — matching how
  -- reserve_retailer_staff_invitation treats them.
  if exists (
    select 1 from unnest(coalesce(p_shop_ids, '{}'::uuid[])) s where s is null
  ) then
    raise exception 'Shop selection is invalid'
      using errcode = 'check_violation';
  end if;

  -- DUPLICATES ARE CANONICALIZED, NOT REJECTED. Under complete-replacement semantics
  -- {A, A, B} and {A, B} denote the same final state, so there is no ambiguity for the
  -- caller to resolve and nothing unsafe to prevent; refusing would fail a form that
  -- posted a repeated checkbox value for a reason its user could not act on. This is
  -- exactly what reserve_retailer_staff_invitation does with the same input.
  select coalesce(array_agg(distinct s order by s), '{}'::uuid[])
    into v_shop_ids
  from unnest(coalesce(p_shop_ids, '{}'::uuid[])) s;

  v_shop_count := coalesce(array_length(v_shop_ids, 1), 0);

  -- --------------------------------------------------------------------------
  -- 3. The target membership — locked, and proved to be ours
  -- --------------------------------------------------------------------------
  -- FOR UPDATE IS THE SERIALIZATION POINT of this whole function. Two concurrent calls
  -- against the same staff member queue here, so the second computes its diff against
  -- the first's COMMITTED state rather than against a stale snapshot. It also blocks a
  -- concurrent membership status change for the duration.
  --
  -- The three predicates are the entire target boundary: `id` says WHICH membership,
  -- `organization_id` says it must be one of the caller's own, and `status` says it must
  -- be manageable. A null, unknown, cross-tenant, INVITED, SUSPENDED, or DEACTIVATED
  -- target all fall out as NULL and are refused IDENTICALLY below.
  select m.id
    into v_member_id
  from public.organization_members m
  where m.id = p_membership_id
    and m.organization_id = v_retailer
    and m.status = 'ACTIVE'
  for update;

  if v_member_id is null then
    raise exception 'Not authorized to update shop assignments'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. The target must be Sales Staff, and ONLY Sales Staff
  -- --------------------------------------------------------------------------
  -- The whole ACTIVE role set is read and compared to the single-element array, rather
  -- than testing "holds SALES_STAFF". That is deliberate and stricter: it refuses a
  -- RETAILER_MANAGER target, a RETAILER_OWNER target, a member with no role at all, and
  -- a member holding SALES_STAFF ALONGSIDE another Retailer role. Managers and Owners
  -- are retailer-wide BY ROLE and hold no retailer_shop_members rows by design
  -- (migration 20260722210000), so writing shop rows for one would invent a shape the
  -- rest of the schema does not model. member_roles is keyed on
  -- (organization_member_id, role_id), so this array cannot contain a duplicate.
  select coalesce(array_agg(r.code order by r.code), '{}'::text[])
    into v_role_codes
  from public.member_roles mr
  join public.roles r on r.id = mr.role_id
  where mr.organization_member_id = v_member_id
    and r.status = 'ACTIVE';

  if v_role_codes is distinct from array['SALES_STAFF']::text[] then
    raise exception 'Not authorized to update shop assignments'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. The zero-shop rule
  -- --------------------------------------------------------------------------
  -- Checked AFTER the target is known to be Sales Staff, so the message is only ever
  -- shown to someone whose target really is subject to the rule, and BEFORE any shop is
  -- locked or any row is written.
  if v_shop_count = 0 then
    raise exception 'Sales Staff must be assigned to at least one shop'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 6. The requested shops — locked in ascending UUID order, all-or-nothing
  -- --------------------------------------------------------------------------
  -- Ordering the locks by UUID gives every caller the same lock order and removes the
  -- deadlock that arbitrary ordering would allow between two requests over overlapping
  -- shop sets. FOR SHARE holds each shop against a concurrent status change until this
  -- transaction ends, so a shop cannot be deactivated between this check and the insert.
  -- Locking runs in a loop rather than inside an aggregate: FOR SHARE cannot be combined
  -- with an aggregate query. This is accept_retailer_staff_invitation step 4, unchanged.
  --
  -- Each shop must exist, be ACTIVE, and belong to the RESOLVED Retailer. If fewer rows
  -- qualify than were requested, at least one shop is unknown, inactive, or another
  -- Retailer's — and the WHOLE operation is refused rather than silently narrowed to the
  -- survivors. Nothing has been written at this point, so the refusal costs no rollback.
  --
  -- An unknown shop and another Retailer's shop are refused IDENTICALLY; distinguishing
  -- them would let a caller probe another Retailer's estate one id at a time.
  v_locked_count := 0;
  for v_shop_id in
    select s.id
    from public.retailer_shops s
    where s.id = any(v_shop_ids)
      and s.retailer_organization_id = v_retailer
      and s.status = 'ACTIVE'
    order by s.id
    for share
  loop
    v_locked_count := v_locked_count + 1;
  end loop;

  if v_locked_count <> v_shop_count then
    raise exception 'One or more selected shops are invalid for this Retailer'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 7. KEEP — the requested shops that already have a live assignment
  -- --------------------------------------------------------------------------
  -- Counted BEFORE anything is written, and deliberately never touched: an unchanged
  -- assignment keeps its original assigned_at, assigned_by, and updated_at, so the
  -- record of when this person actually started at this shop survives an unrelated edit
  -- to a different shop. Every requested shop was proved ACTIVE and same-Retailer in
  -- step 6, so a live row for one of them is necessarily part of the ACTIVE projection.
  select count(*)::integer
    into v_unchanged
  from public.retailer_shop_members sm
  where sm.organization_member_id = v_member_id
    and sm.removed_at is null
    and sm.retailer_shop_id = any(v_shop_ids);

  -- --------------------------------------------------------------------------
  -- 8. REMOVE — live ACTIVE-shop assignments absent from the request
  -- --------------------------------------------------------------------------
  -- Retirement, never deletion: removed_at is set and the row stays on record for all
  -- time, which is the entire lifecycle this table was built around. set_updated_at
  -- advances updated_at through the table's own trigger. The
  -- retailer_shop_members_assert_same_retailer_on_update trigger does NOT fire — it is
  -- declared UPDATE OF (organization_member_id, retailer_shop_id) and this statement
  -- mentions neither.
  --
  -- THE `s.status = 'ACTIVE'` JOIN PREDICATE IS THE R-1 PROTECTION. Without it this
  -- statement would retire live assignments to SUSPENDED and DEACTIVATED shops, which
  -- the client cannot see in list_retailer_staff_members() and therefore cannot have
  -- meant to omit. With it, those rows are invisible to this statement exactly as they
  -- are to the roster, and survive untouched.
  with retired as (
    update public.retailer_shop_members sm
    set removed_at = now()
    from public.retailer_shops s
    where s.id = sm.retailer_shop_id
      and sm.organization_member_id = v_member_id
      and sm.removed_at is null
      and s.status = 'ACTIVE'
      and s.retailer_organization_id = v_retailer
      and not (sm.retailer_shop_id = any(v_shop_ids))
    returning s.name as shop_name
  )
  select
    count(*)::integer,
    coalesce(array_agg(retired.shop_name order by retired.shop_name), '{}'::text[])
    into v_removed, v_removed_names
  from retired;

  -- --------------------------------------------------------------------------
  -- 9. ADD — requested shops with no live assignment
  -- --------------------------------------------------------------------------
  -- A NEW ROW, never a resurrected one. The table's design states that reassignment
  -- creates a new row so history is preserved by accumulation; clearing removed_at on a
  -- retired row would instead erase the fact that this person was ever off that shop.
  -- The partial unique index permits this precisely because it constrains only live
  -- rows: any number of retired rows for the same (member, shop) pair coexist freely.
  --
  -- assigned_by is the ACTING OWNER (auth.uid()), not the original inviter — this is a
  -- new decision by a new actor, and recording the inviter would misattribute it.
  --
  -- unique_violation is caught and re-raised on the generic path, matching
  -- accept_retailer_staff_invitation step 7. It is very nearly unreachable: the FOR
  -- UPDATE membership lock from step 3 means no other caller of this function can be
  -- inserting rows for this member concurrently. It remains the last-resort guard for a
  -- direct privileged write racing this one, and a raise here rolls back the retirement
  -- in step 8 along with everything else.
  begin
    with added as (
      insert into public.retailer_shop_members (
        organization_member_id,
        retailer_shop_id,
        assigned_by,
        assigned_at
      )
      select v_member_id, s.id, v_actor, now()
      from public.retailer_shops s
      where s.id = any(v_shop_ids)
        and not exists (
          select 1
          from public.retailer_shop_members sm
          where sm.organization_member_id = v_member_id
            and sm.retailer_shop_id = s.id
            and sm.removed_at is null
        )
      returning retailer_shop_id
    )
    select
      count(*)::integer,
      coalesce(array_agg(s.name order by s.name), '{}'::text[])
      into v_added, v_added_names
    from added
    join public.retailer_shops s on s.id = added.retailer_shop_id;
  exception when unique_violation then
    raise exception 'Not authorized to update shop assignments'
      using errcode = 'insufficient_privilege';
  end;

  -- --------------------------------------------------------------------------
  -- 10. A no-op writes nothing at all — including no audit row
  -- --------------------------------------------------------------------------
  -- An identical repeat request retires nothing and inserts nothing, so there is no
  -- event to record. This matches reserve_retailer_staff_invitation's resend path, which
  -- deliberately writes no second RESERVED audit row: a no-op is not an event, and an
  -- audit trail that logs one per double-tap is a trail nobody can read.
  --
  -- The counts are still returned, so a client can tell "nothing to save" from "denied".
  if v_added = 0 and v_removed = 0 then
    return query select 0::integer, 0::integer, v_unchanged;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 11. Audit — exactly one safe event, in the same transaction as its rows
  -- --------------------------------------------------------------------------
  -- organization_id is the RETAILER's, so the entry lands in the tenant's own activity
  -- feed. It is therefore INVISIBLE to the Vendor-side audit reader added in migration
  -- 20260804090000, which filters on `organization_id = <the caller's Vendor>`; no Vendor
  -- can read a Retailer's staff movements through it.
  --
  -- The before/after picture is stated in COUNTS and SHOP NAMES. Names are display
  -- values the Owner already reads on the roster, and they are what makes this entry
  -- answerable after the fact ("which shop did she come off?"). Deliberately absent:
  -- every shop UUID, every membership/profile/Auth id inside metadata (the membership id
  -- is entity_id, which the reader already has authority over), every email address,
  -- every token, hash, delivery field, secret, and every caller-supplied value — the
  -- role code and membership status below are the ones this function PROVED in steps 3
  -- and 4, not ones it was handed.
  insert into public.audit_logs (
    organization_id,
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  values (
    v_retailer,
    v_actor,
    'STAFF_SHOP_ASSIGNMENTS_UPDATED',
    'RETAILER_STAFF_MEMBER',
    v_member_id::text,
    jsonb_build_object(
      'retailer_name',     v_retailer_name,
      'role_code',         'SALES_STAFF',
      'membership_status', 'ACTIVE',
      'shop_count_before', v_unchanged + v_removed,
      'shop_count_after',  v_unchanged + v_added,
      'shops_added',       to_jsonb(v_added_names),
      'shops_removed',     to_jsonb(v_removed_names)
    )
  );

  return query select v_added, v_removed, v_unchanged;
end;
$$;

-- Privileges. PostgreSQL grants EXECUTE to PUBLIC on every new function by default, and
-- PUBLIC is inherited by every role — so without the first revoke, anon would hold
-- EXECUTE on a SECURITY DEFINER writer despite nothing here granting it. anon is revoked
-- explicitly as well, so the intent survives a future re-grant to PUBLIC.
--
-- service_role is granted NOTHING, deliberately: this function's entire authority is
-- auth.uid(), which a service-role connection does not have, so a grant would produce a
-- path that can only ever refuse — while inviting someone to try to use it.
revoke all     on function public.set_retailer_staff_shop_assignments(uuid, uuid[]) from public;
revoke execute on function public.set_retailer_staff_shop_assignments(uuid, uuid[]) from anon;
grant  execute on function public.set_retailer_staff_shop_assignments(uuid, uuid[]) to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One function added; nothing else exists in this migration. No table, column,
-- constraint, index, trigger, policy, role, permission, or role-permission mapping is
-- created, altered, or dropped, and no existing function is touched.
-- public.retailer_shop_members keeps exactly the posture migration 20260722210000 left
-- it in: RLS enabled, ZERO policies, and no privilege of any kind held by public, anon,
-- or authenticated. retailer_shops, organization_members, member_roles, profiles,
-- organizations, audit_logs, and both staff-invitation tables are likewise untouched.
--
-- The two audit vocabulary entries this adds — action 'STAFF_SHOP_ASSIGNMENTS_UPDATED'
-- and entity_type 'RETAILER_STAFF_MEMBER' — need no catalogue row: audit_logs.action and
-- .entity_type are free text with only a not-empty check, exactly as every existing code
-- in those columns is.
