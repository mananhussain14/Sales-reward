-- Migration: vendor_campaign_operations
-- Purpose: The operations over the campaign foundation (migration 20260815090000).
--          Adds two internal helpers and twenty-one SECURITY DEFINER functions:
--
--            Internal (granted to NO browser role)
--              public.resolve_campaign_vendor_organization(text)
--              public.campaign_derived_state(text, timestamptz, timestamptz)
--
--            Retailer groups — RETAILER_GROUPS_MANAGE
--               1. list_vendor_retailer_groups()
--               2. get_vendor_retailer_group(uuid)
--               3. list_vendor_retailer_group_members(uuid)
--               4. create_vendor_retailer_group(text, text)
--               5. update_vendor_retailer_group(uuid, text, text, text)
--               6. set_vendor_retailer_group_members(uuid, uuid[])
--
--            Vendor campaigns — CAMPAIGNS_MANAGE
--               7. list_vendor_campaigns()
--               8. get_vendor_campaign(uuid)
--               9. get_vendor_campaign_version(uuid)
--              10. list_vendor_campaign_version_retailers(uuid)
--              11. list_vendor_campaign_version_groups(uuid)
--              12. list_vendor_campaign_version_products(uuid)
--              13. list_vendor_campaign_eligible_retailers(uuid)
--              14. preview_vendor_campaign_publication(uuid)
--              15. create_vendor_campaign_draft(...)
--              16. update_vendor_campaign_draft(...)
--              17. publish_vendor_campaign(uuid)
--              18. set_vendor_campaign_lifecycle(uuid, text)
--              19. create_vendor_campaign_version(uuid)
--
--            Assigned visibility — CAMPAIGNS_VIEW_ASSIGNED / STAFF_CAMPAIGNS_VIEW
--              20. list_my_retailer_campaigns()
--              21. get_my_retailer_campaign(uuid)
--              22. list_my_retailer_campaign_products(uuid)
--              23. list_my_staff_campaigns()
--              24. get_my_staff_campaign(uuid)
--              25. list_my_staff_campaign_products(uuid)
--
-- ============================================================================
-- HOW THE VENDOR IS DERIVED, EVERY TIME
-- ============================================================================
--   public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE')
--
-- One internal helper rather than the same eight lines repeated nineteen times. It
-- wraps the established pattern verbatim — get_vendor_super_admin_context() ordered by
-- organization id, limit 1, then has_organization_permission() — and exists for exactly
-- the reason resolve_retailer_member_organization() exists on the Retailer side: a rule
-- restated nineteen times is a rule that can be tightened in eighteen places.
--
-- It takes NO Vendor id. The context function accepts no arguments and filters on
-- auth.uid() internally, so no call anywhere in this file can nominate a Vendor.
-- Holding the role is then NOT by itself permission to act: the permission code is a
-- required argument, so authoring campaigns and reshaping groups stay separable.
--
-- CALLER-SUPPLIED IDS ARE ADDRESSES, NEVER AUTHORIZATION
--   A campaign id, a version id, a group id, a relationship id and a product id do
--   arrive from the browser. Each is filtered on TWO things — the id itself, and the
--   Vendor this function derived — so an id belonging to another Vendor matches zero
--   rows and can select nothing. The refusal is byte-identical to "you are not
--   authorized", so a caller cannot sweep ids to learn what exists.
--
-- ============================================================================
-- WHY ONE ATOMIC TYPED DRAFT SAVE INSTEAD OF FIVE SETTERS
-- ============================================================================
-- A campaign version has NOT NULL dates, an audience mode, a product scope, a
-- performance scope, a stacking mode and a rule. Separate set_audience / set_products /
-- set_rule contracts would each have to admit a version that is momentarily incoherent —
-- SELECTED_RETAILERS with no Retailers, EXCLUSIVE with no key, TARGET_BONUS with no
-- threshold — and every reader would then need to cope with a half-configured row.
--
-- So the draft is written whole: create_vendor_campaign_draft and
-- update_vendor_campaign_draft each take the complete configuration as TYPED arguments —
-- never one free-form JSON payload — validate every one of them, and write the version,
-- its audience, its products and its rule in a single transaction. A draft in this
-- schema is therefore always a publishable shape; the only thing publication adds is the
-- resolution against Retailers and assignments that exist at that moment.
--
-- The cost is stated honestly: a wizard cannot persist a half-finished campaign
-- server-side. Step state lives in the browser until the operator explicitly saves, and
-- "Save draft" is offered only once the configuration is complete.
--
-- ============================================================================
-- THE PUBLICATION RESOLUTION RULE — ONE RULE, WRITTEN DOWN ONCE
-- ============================================================================
-- A RETAILER is eligible when, at the instant of publication:
--   * the vendor_retailers relationship is ACTIVE, and
--   * the Retailer organization is ACTIVE, and
--   * the audience admits it — every relationship for ALL_RETAILERS, the selected rows
--     for SELECTED_RETAILERS, the LIVE members (removed_at IS NULL) of the selected
--     groups for RETAILER_GROUPS.
-- A suspended relationship or a suspended Retailer is therefore excluded from the
-- snapshot rather than frozen into it — the campaign was never offered to them.
--
-- A (RETAILER, PRODUCT) pair is eligible when, at that same instant:
--   * the product belongs to this Vendor and is ACTIVE, and
--   * an ACTIVE vendor_product_retailer_assignments row links it to that Retailer.
-- A selected product that is NOT assigned to a given eligible Retailer is EXCLUDED for
-- that Retailer — never silently included. The exclusion is visible before publication
-- through preview_vendor_campaign_publication(), so the operator sees every conflict
-- while they can still act on it.
--
-- Publication is REFUSED, rather than producing an empty promise, when the resolution
-- yields zero eligible Retailers, or when product_scope = SELECTED_PRODUCTS and it
-- yields zero eligible (Retailer, product) pairs.
--
-- Product pairs are snapshotted ONLY for SELECTED_PRODUCTS, whose
-- product_eligibility_resolution is 'SNAPSHOT'. ALL_ELIGIBLE_PRODUCTS carries
-- 'LIVE_TEMPORAL' and is resolved AS OF a moment from
-- vendor_product_retailer_assignment_history (migration 20260814210000): freezing a list
-- would contradict the words, and would mean a product added to a Retailer next week was
-- excluded from an evergreen campaign that says it includes everything.
--
-- WHY PUBLICATION AND PREVIEW STILL READ THE LIVE ASSIGNMENT TABLE, deliberately.
-- Both answer a question about RIGHT NOW — "which pairs are eligible at this instant?" —
-- and for that question vendor_product_retailer_assignments is the authoritative source
-- and cannot be incomplete. The history table answers a question about a PAST instant, and
-- is authoritative only from its own migration onward. Using the timeline for the "now"
-- question would gain nothing and would make publication depend on a backfill. The two
-- agree by construction: the trigger opens an interval for every row, so the open interval
-- always carries the row's current status.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--   No progress, no receipt-to-campaign matching, no rule evaluation, no exclusivity
--   contest, no coin credit, no balance, no ledger, no claim, no payout, no reversal.
--   Nothing here computes what anybody earned. The reward columns are read and returned
--   as CONFIGURATION so a client can display the offer, and no function multiplies,
--   accumulates or settles any of them.
--   No table, column, constraint, index, trigger, policy, role, permission or mapping is
--   created or altered here, and no existing function is touched.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE).
--   A conflicting existing object FAILS the migration. No fixed UUIDs. No dynamic SQL.
--   All identifiers are <= 63 bytes. Every reference is schema-qualified because every
--   function runs with an EMPTY search_path.
--
-- SQLSTATE taxonomy, matching the project's existing vocabulary:
--   42501  unauthenticated / unauthorized / foreign or unknown id. Deliberately generic.
--   23514  a supplied value is invalid.
--   23505  a name already exists in the caller's OWN Vendor.
--   55000  the target is not in a state this operation can act on.
--
-- Dependencies: 20260716130351 (audit_logs), 20260716131104
--   (has_organization_permission), 20260717083515 (get_vendor_super_admin_context),
--   20260717094520 (vendor_retailers), 20260723090000
--   (resolve_retailer_member_organization), 20260727090000 (vendor_products,
--   vendor_product_retailer_assignments), 20260815090000 (the eleven campaign tables and
--   the four permissions).

-- ============================================================================
-- INTERNAL HELPER 1 — resolve_campaign_vendor_organization(text)
-- ============================================================================
-- The calling Vendor organization, or NULL when the caller is not an authorized Vendor
-- Super Admin holding the named permission in it. NULL is the single answer for
-- "signed out", "not a Vendor Super Admin", "a Retailer member", "a suspended profile"
-- and "this role does not hold that permission" alike.
--
-- Not granted to any browser role: it is reachable only from the SECURITY DEFINER
-- functions below, which run as this function's owner. Mirrors the privilege posture of
-- resolve_retailer_member_organization().
create function public.resolve_campaign_vendor_organization(
  target_permission_code text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select v.organization_id
  from (
    select ctx.organization_id
    from public.get_vendor_super_admin_context() ctx
    order by ctx.organization_id
    limit 1
  ) v
  where target_permission_code is not null
    and public.has_organization_permission(v.organization_id, target_permission_code);
$$;

revoke all     on function public.resolve_campaign_vendor_organization(text) from public;
revoke execute on function public.resolve_campaign_vendor_organization(text) from anon;
revoke execute on function public.resolve_campaign_vendor_organization(text) from authenticated;

-- ============================================================================
-- INTERNAL HELPER 2 — campaign_derived_state(text, timestamptz, timestamptz)
-- ============================================================================
-- The effective-time state a reader should see, computed from the persisted management
-- status and the in-force version's period. THE reason no scheduled job is needed to
-- move a campaign from SCHEDULED to ACTIVE or from ACTIVE to ENDED.
--
-- PRECEDENCE, and why it is this order:
--   DRAFT      -- never published; time is not yet meaningful
--   CANCELLED  -- terminal; a cancelled campaign is cancelled whatever the clock says
--   ENDED      -- the period is over. Wins over PAUSED deliberately: a paused campaign
--                 whose end date has passed cannot resume into anything, and calling it
--                 "Paused" would imply it still could.
--   PAUSED     -- a human suspended eligibility inside a period that is still running
--   SCHEDULED  -- published, period not yet started
--   ACTIVE     -- published, inside the period, not paused or cancelled
--
-- STABLE, not IMMUTABLE: it reads now(). Marking it immutable would let the planner fold
-- the clock into a cached plan, which is precisely how a derived state silently stops
-- deriving.
create function public.campaign_derived_state(
  p_status    text,
  p_starts_at timestamptz,
  p_ends_at   timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_status = 'DRAFT'     then 'DRAFT'
    when p_status = 'CANCELLED' then 'CANCELLED'
    when p_starts_at is null    then 'DRAFT'
    when p_ends_at is not null and now() > p_ends_at then 'ENDED'
    when p_status = 'PAUSED'    then 'PAUSED'
    when now() < p_starts_at    then 'SCHEDULED'
    else 'ACTIVE'
  end;
$$;

revoke all     on function public.campaign_derived_state(text, timestamptz, timestamptz) from public;
revoke execute on function public.campaign_derived_state(text, timestamptz, timestamptz) from anon;
revoke execute on function public.campaign_derived_state(text, timestamptz, timestamptz) from authenticated;

-- ============================================================================
-- INTERNAL HELPER 2b — campaign_product_eligibility_as_of(timestamptz, timestamptz)
-- ============================================================================
-- THE ONE DOCUMENTED INSTANT a LIVE_TEMPORAL campaign's product list is resolved at, so
-- every read that shows such a list shows the same list.
--
--     least(now(), coalesce(ends_at, 'infinity'))
--
--   * A campaign that is still running, scheduled, paused, or evergreen resolves at
--     now() — "what is eligible for this Retailer today".
--   * A campaign whose period has PASSED resolves at its own ends_at — "what was eligible
--     when it stopped". Without this, an ended campaign would silently show today's
--     catalogue, which is the one thing the requirement forbids: a historical campaign
--     must not be described by a present-day product list.
--
-- BOUNDARY: resolution is half-open, so an assignment interval that closed exactly at
-- ends_at is NOT included at ends_at. The last instant the campaign could reward is the
-- instant before it ended, and that is the reading applied.
--
-- KNOWN LIMITATION, stated rather than hidden: a CANCELLED campaign that had not yet
-- reached its end date resolves at now(), because the exact cancellation instant is not
-- persisted on the campaign row — it exists only in the audit trail. The list is
-- informational and the campaign rewards nothing once cancelled, so this is acceptable
-- here; a reward engine must use the verified SALE timestamp regardless, never this.
create function public.campaign_product_eligibility_as_of(
  p_starts_at timestamptz,
  p_ends_at   timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select least(now(), coalesce(p_ends_at, 'infinity'::timestamptz));
$$;

revoke all     on function public.campaign_product_eligibility_as_of(timestamptz, timestamptz) from public;
revoke execute on function public.campaign_product_eligibility_as_of(timestamptz, timestamptz) from anon;
revoke execute on function public.campaign_product_eligibility_as_of(timestamptz, timestamptz) from authenticated;

-- ============================================================================
-- FUNCTION 1 — list_vendor_retailer_groups()
-- ============================================================================
-- The calling Vendor's Retailer groups, with a live member count and a count of how many
-- campaign versions currently reference each — the number an operator needs before they
-- change a group's membership.
--
-- Zero arguments: no Vendor id to pass, so nothing can nominate whose groups are
-- returned.
create function public.list_vendor_retailer_groups()
returns table (
  group_id          uuid,
  name              text,
  description       text,
  status            text,
  member_count      integer,
  campaign_ref_count integer,
  created_at        timestamptz,
  updated_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_campaign_vendor_organization('RETAILER_GROUPS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view Retailer groups'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    g.id,
    g.name,
    g.description,
    g.status,
    (
      select count(*)::integer
      from public.campaign_retailer_group_members m
      where m.campaign_retailer_group_id = g.id
        and m.removed_at is null
    ),
    (
      select count(*)::integer
      from public.campaign_version_retailer_groups vg
      where vg.campaign_retailer_group_id = g.id
    ),
    g.created_at,
    g.updated_at
  from public.campaign_retailer_groups g
  where g.vendor_organization_id = v_vendor
  order by g.name, g.id;
end;
$$;

revoke all     on function public.list_vendor_retailer_groups() from public;
revoke execute on function public.list_vendor_retailer_groups() from anon;
grant  execute on function public.list_vendor_retailer_groups() to authenticated;

-- ============================================================================
-- FUNCTION 2 — get_vendor_retailer_group(uuid)
-- ============================================================================
-- One group's header. Returns zero rows for an unknown id and for another Vendor's id
-- alike — the WHERE clause filters on the group id AND the derived Vendor, so a foreign
-- id is indistinguishable from a nonexistent one.
create function public.get_vendor_retailer_group(
  p_group_id uuid
)
returns table (
  group_id           uuid,
  name               text,
  description        text,
  status             text,
  member_count       integer,
  campaign_ref_count integer,
  created_at         timestamptz,
  updated_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_campaign_vendor_organization('RETAILER_GROUPS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view Retailer groups'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    g.id,
    g.name,
    g.description,
    g.status,
    (
      select count(*)::integer
      from public.campaign_retailer_group_members m
      where m.campaign_retailer_group_id = g.id
        and m.removed_at is null
    ),
    (
      select count(*)::integer
      from public.campaign_version_retailer_groups vg
      where vg.campaign_retailer_group_id = g.id
    ),
    g.created_at,
    g.updated_at
  from public.campaign_retailer_groups g
  where g.id = p_group_id
    and g.vendor_organization_id = v_vendor;
end;
$$;

revoke all     on function public.get_vendor_retailer_group(uuid) from public;
revoke execute on function public.get_vendor_retailer_group(uuid) from anon;
grant  execute on function public.get_vendor_retailer_group(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 3 — list_vendor_retailer_group_members(uuid)
-- ============================================================================
-- One group's LIVE members, by Retailer name. Retired rows are not returned: the screen
-- edits membership, and showing a Retailer that left alongside the ones that remain
-- would invite an operator to "remove" a row that is already gone.
--
-- Returns the relationship's and the organization's current statuses so the editor can
-- show that a member has since been suspended — a fact that matters, because a suspended
-- Retailer stays in the group but will not be resolved into any future publication.
create function public.list_vendor_retailer_group_members(
  p_group_id uuid
)
returns table (
  vendor_retailer_id  uuid,
  retailer_name       text,
  retailer_status     text,
  relationship_status text,
  added_at            timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_campaign_vendor_organization('RETAILER_GROUPS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view Retailer groups'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    m.vendor_retailer_id,
    o.name,
    o.status,
    vr.status,
    m.added_at
  from public.campaign_retailer_group_members m
  join public.campaign_retailer_groups g
    on g.id = m.campaign_retailer_group_id
  join public.vendor_retailers vr
    on vr.id = m.vendor_retailer_id
  join public.organizations o
    on o.id = vr.retailer_organization_id
  where m.campaign_retailer_group_id = p_group_id
    and m.removed_at is null
    and g.vendor_organization_id = v_vendor
  order by o.name, m.vendor_retailer_id;
end;
$$;

revoke all     on function public.list_vendor_retailer_group_members(uuid) from public;
revoke execute on function public.list_vendor_retailer_group_members(uuid) from anon;
grant  execute on function public.list_vendor_retailer_group_members(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 4 — create_vendor_retailer_group(text, text)
-- ============================================================================
-- Creates one empty group and returns its id. Membership is set separately, so a group
-- and its members are never half-written by one failed call.
--
-- NORMALIZATION HAPPENS HERE, not only in the application. An RPC granted to
-- `authenticated` is a public endpoint reachable by a hand-crafted call that never went
-- near the form, so the whitespace rule the unique index depends on is applied in SQL.
create function public.create_vendor_retailer_group(
  p_name        text,
  p_description text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor      uuid;
  v_actor       uuid;
  v_name        text;
  v_description text;
  v_id          uuid;
begin
  v_actor  := auth.uid();
  v_vendor := public.resolve_campaign_vendor_organization('RETAILER_GROUPS_MANAGE');

  if v_actor is null or v_vendor is null then
    raise exception 'Not authorized to manage Retailer groups'
      using errcode = 'insufficient_privilege';
  end if;

  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_description := nullif(btrim(coalesce(p_description, '')), '');

  if v_name = '' or length(v_name) > 120 then
    raise exception 'Enter a group name'
      using errcode = 'check_violation';
  end if;
  if v_description is not null and length(v_description) > 500 then
    raise exception 'Description is too long'
      using errcode = 'check_violation';
  end if;

  begin
    insert into public.campaign_retailer_groups (
      vendor_organization_id, name, description, status, created_by_profile_id
    )
    values (v_vendor, v_name, v_description, 'ACTIVE', v_actor)
    returning id into v_id;
  exception when unique_violation then
    -- The index is scoped per Vendor, so this describes the CALLER'S OWN groups and
    -- reveals nothing about another Vendor's.
    raise exception 'A group with that name already exists'
      using errcode = 'unique_violation';
  end;

  -- Metadata carries server-derived display facts only. No actor identity beyond the
  -- audit row's own actor column, no organization id, no membership internals.
  -- ip_address and user_agent stay null: this function cannot observe them truthfully.
  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor, v_actor, 'RETAILER_GROUP_CREATED', 'CAMPAIGN_RETAILER_GROUP', v_id::text,
    jsonb_build_object('group_name', v_name, 'group_status', 'ACTIVE', 'member_count', 0)
  );

  return v_id;
end;
$$;

revoke all     on function public.create_vendor_retailer_group(text, text) from public;
revoke execute on function public.create_vendor_retailer_group(text, text) from anon;
grant  execute on function public.create_vendor_retailer_group(text, text) to authenticated;

-- ============================================================================
-- FUNCTION 5 — update_vendor_retailer_group(uuid, text, text, text)
-- ============================================================================
-- Renames, re-describes, or archives/restores one group.
--
-- NO AUDIT WHEN NOTHING CHANGED. A submit that alters no value writes no row and leaves
-- updated_at alone — an audit trail whose entries do not correspond to changes is worse
-- than a shorter one. The returned `changed` flag tells the client which happened.
--
-- ARCHIVING DOES NOT TOUCH A PUBLISHED CAMPAIGN. Publication copied membership into
-- campaign_eligible_retailers and never reads the group again, so an archived group's
-- past campaigns are completely unaffected. It only stops the group being selected for a
-- new version.
create function public.update_vendor_retailer_group(
  p_group_id    uuid,
  p_name        text,
  p_description text default null,
  p_status      text default null
)
returns table (
  group_id uuid,
  changed  boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor      uuid;
  v_actor       uuid;
  v_name        text;
  v_description text;
  v_status      text;
  v_old         public.campaign_retailer_groups%rowtype;
  v_changed     boolean;
begin
  v_actor  := auth.uid();
  v_vendor := public.resolve_campaign_vendor_organization('RETAILER_GROUPS_MANAGE');

  if v_actor is null or v_vendor is null then
    raise exception 'Not authorized to manage Retailer groups'
      using errcode = 'insufficient_privilege';
  end if;

  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_description := nullif(btrim(coalesce(p_description, '')), '');
  v_status := nullif(btrim(upper(coalesce(p_status, ''))), '');

  if v_name = '' or length(v_name) > 120 then
    raise exception 'Enter a group name'
      using errcode = 'check_violation';
  end if;
  if v_description is not null and length(v_description) > 500 then
    raise exception 'Description is too long'
      using errcode = 'check_violation';
  end if;
  if v_status is not null and v_status not in ('ACTIVE', 'ARCHIVED') then
    raise exception 'Invalid group status'
      using errcode = 'check_violation';
  end if;

  -- FOR UPDATE: the row is locked before it is compared, so two concurrent renames
  -- cannot both read the old value and both decide they changed something.
  select g.* into v_old
  from public.campaign_retailer_groups g
  where g.id = p_group_id
    and g.vendor_organization_id = v_vendor
  for update;

  -- Unknown id and another Vendor's id are refused identically.
  if v_old.id is null then
    raise exception 'Not authorized to manage Retailer groups'
      using errcode = 'insufficient_privilege';
  end if;

  v_status := coalesce(v_status, v_old.status);

  v_changed :=
    v_old.name is distinct from v_name
    or v_old.description is distinct from v_description
    or v_old.status is distinct from v_status;

  if not v_changed then
    return query select v_old.id, false;
    return;
  end if;

  begin
    update public.campaign_retailer_groups g
    set name = v_name, description = v_description, status = v_status
    where g.id = v_old.id;
  exception when unique_violation then
    raise exception 'A group with that name already exists'
      using errcode = 'unique_violation';
  end;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor, v_actor, 'RETAILER_GROUP_UPDATED', 'CAMPAIGN_RETAILER_GROUP', v_old.id::text,
    jsonb_build_object(
      'group_name',    v_name,
      'name_changed',  v_old.name is distinct from v_name,
      'status_before', v_old.status,
      'status_after',  v_status
    )
  );

  return query select v_old.id, true;
end;
$$;

revoke all     on function public.update_vendor_retailer_group(uuid, text, text, text) from public;
revoke execute on function public.update_vendor_retailer_group(uuid, text, text, text) from anon;
grant  execute on function public.update_vendor_retailer_group(uuid, text, text, text) to authenticated;

-- ============================================================================
-- FUNCTION 6 — set_vendor_retailer_group_members(uuid, uuid[])
-- ============================================================================
-- ATOMIC REPLACEMENT of a group's live membership, in the shape
-- set_retailer_staff_shop_assignments() established: the caller sends the set they want,
-- the database computes the difference, and the counts come back so the client can
-- report what actually happened without re-deriving it.
--
-- An EMPTY array is permitted here, unlike the shop-assignment contract. Emptying a
-- group is a meaningful act — it is how a group is wound down without archiving it — and
-- there is no rule that a group must be non-empty. Publication, not membership, is where
-- "this resolves to nobody" is refused.
--
-- ELIGIBILITY: only ACTIVE relationships may be ADDED. A suspended relationship already
-- in the group can still be REMOVED, because a status rule that blocked removal would
-- trap a member in a group the operator is trying to clean up.
--
-- Duplicate ids in the input are canonicalized by `distinct`; a foreign or unknown
-- relationship id is refused for the whole call rather than silently dropped, so the
-- operator never believes they saved a set they did not.
create function public.set_vendor_retailer_group_members(
  p_group_id           uuid,
  p_vendor_retailer_ids uuid[]
)
returns table (
  members_added     integer,
  members_removed   integer,
  members_unchanged integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor    uuid;
  v_actor     uuid;
  v_group     public.campaign_retailer_groups%rowtype;
  v_requested uuid[];
  v_added     integer := 0;
  v_removed   integer := 0;
  v_unchanged integer := 0;
begin
  v_actor  := auth.uid();
  v_vendor := public.resolve_campaign_vendor_organization('RETAILER_GROUPS_MANAGE');

  if v_actor is null or v_vendor is null then
    raise exception 'Not authorized to manage Retailer groups'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock the group first, so two concurrent saves serialize on it rather than racing to
  -- compute a difference against the same starting membership.
  select g.* into v_group
  from public.campaign_retailer_groups g
  where g.id = p_group_id
    and g.vendor_organization_id = v_vendor
  for update;

  if v_group.id is null then
    raise exception 'Not authorized to manage Retailer groups'
      using errcode = 'insufficient_privilege';
  end if;

  -- Canonicalize: NULL becomes the empty set, duplicates collapse, NULL elements drop.
  select coalesce(array_agg(distinct x), array[]::uuid[])
    into v_requested
  from unnest(coalesce(p_vendor_retailer_ids, array[]::uuid[])) as x
  where x is not null;

  -- Every requested id must be one of THIS Vendor's relationships. Checked before any
  -- write, so a bad id changes nothing at all. The refusal is the generic one: a
  -- relationship id that belongs to another Vendor and one that belongs to nobody are
  -- the same answer, so this cannot be used to probe for existence.
  if exists (
    select 1
    from unnest(v_requested) as req(id)
    where not exists (
      select 1 from public.vendor_retailers vr
      where vr.id = req.id
        and vr.vendor_organization_id = v_vendor
    )
  ) then
    raise exception 'Not authorized to manage Retailer groups'
      using errcode = 'insufficient_privilege';
  end if;

  -- A relationship that is not ACTIVE cannot be ADDED. Already-live members are exempt:
  -- the guard is on the addition, not on the continued membership.
  if exists (
    select 1
    from unnest(v_requested) as req(id)
    join public.vendor_retailers vr on vr.id = req.id
    join public.organizations o on o.id = vr.retailer_organization_id
    where (vr.status <> 'ACTIVE' or o.status <> 'ACTIVE')
      and not exists (
        select 1 from public.campaign_retailer_group_members m
        where m.campaign_retailer_group_id = v_group.id
          and m.vendor_retailer_id = req.id
          and m.removed_at is null
      )
  ) then
    raise exception 'Only active Retailers can be added to a group'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- RETIRE what is no longer wanted. Soft removal: removed_at is stamped, the row stays.
  with retired as (
    update public.campaign_retailer_group_members m
    set removed_at = now(), removed_by_profile_id = v_actor
    where m.campaign_retailer_group_id = v_group.id
      and m.removed_at is null
      and not (m.vendor_retailer_id = any (v_requested))
    returning 1
  )
  select count(*)::integer into v_removed from retired;

  -- ADD what is newly wanted. The partial unique index is the concurrency authority: a
  -- concurrent duplicate add fails the statement rather than creating a second live row.
  with added as (
    insert into public.campaign_retailer_group_members (
      campaign_retailer_group_id, vendor_retailer_id, added_by_profile_id
    )
    select v_group.id, req.id, v_actor
    from unnest(v_requested) as req(id)
    where not exists (
      select 1 from public.campaign_retailer_group_members m
      where m.campaign_retailer_group_id = v_group.id
        and m.vendor_retailer_id = req.id
        and m.removed_at is null
    )
    returning 1
  )
  select count(*)::integer into v_added from added;

  v_unchanged := coalesce(array_length(v_requested, 1), 0) - v_added;

  -- NO AUDIT FOR A NO-OP. Re-saving an unchanged set writes nothing.
  if v_added > 0 or v_removed > 0 then
    insert into public.audit_logs (
      organization_id, actor_profile_id, action, entity_type, entity_id, metadata
    )
    values (
      v_vendor, v_actor, 'RETAILER_GROUP_MEMBERS_CHANGED', 'CAMPAIGN_RETAILER_GROUP',
      v_group.id::text,
      jsonb_build_object(
        'group_name',        v_group.name,
        'members_added',     v_added,
        'members_removed',   v_removed,
        'members_unchanged', v_unchanged,
        'member_count_after', v_unchanged + v_added
      )
    );
  end if;

  return query select v_added, v_removed, v_unchanged;
end;
$$;

revoke all     on function public.set_vendor_retailer_group_members(uuid, uuid[]) from public;
revoke execute on function public.set_vendor_retailer_group_members(uuid, uuid[]) from anon;
grant  execute on function public.set_vendor_retailer_group_members(uuid, uuid[]) to authenticated;

-- ============================================================================
-- FUNCTION 7 — list_vendor_campaigns()
-- ============================================================================
-- Every campaign this Vendor owns, with the configuration of the version IN VIEW —
-- the published version when there is one, otherwise the draft — plus its derived state.
--
-- ZERO ARGUMENTS, and no filter parameters, deliberately. Every list_* contract in this
-- schema is zero-argument or takes one canonical id, and the filters this screen needs
-- (status, performance scope) are over a set one Vendor can hold in a single page. A
-- filter argument would add a parameter surface for no capability the client does not
-- already have, and the client filters a result it is already authorized to hold whole.
create function public.list_vendor_campaigns()
returns table (
  campaign_id            uuid,
  name                   text,
  description            text,
  campaign_status        text,
  derived_state          text,
  version_id             uuid,
  version_number         integer,
  has_draft              boolean,
  starts_at              timestamptz,
  ends_at                timestamptz,
  timezone_name          text,
  audience_mode          text,
  performance_scope      text,
  product_scope          text,
  product_eligibility_resolution text,
  stacking_mode          text,
  exclusivity_key        text,
  priority               integer,
  reward_recipient_scope text,
  rule_type              text,
  metric_type            text,
  coins_per_unit         bigint,
  max_reward_coins       bigint,
  threshold_units        integer,
  reward_coins           bigint,
  eligible_retailer_count integer,
  selected_retailer_count integer,
  selected_group_count    integer,
  selected_product_count  integer,
  created_at             timestamptz,
  updated_at             timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    c.id,
    c.name,
    c.description,
    c.status,
    public.campaign_derived_state(c.status, cv.starts_at, cv.ends_at),
    cv.id,
    cv.version_number,
    c.draft_version_id is not null,
    cv.starts_at,
    cv.ends_at,
    cv.timezone_name,
    cv.audience_mode,
    cv.performance_scope,
    cv.product_scope,
    cv.product_eligibility_resolution,
    cv.stacking_mode,
    cv.exclusivity_key,
    cv.priority,
    cv.reward_recipient_scope,
    r.rule_type,
    r.metric_type,
    r.coins_per_unit,
    r.max_reward_coins,
    t.threshold_units,
    t.reward_coins,
    (
      select count(*)::integer from public.campaign_eligible_retailers er
      where er.campaign_version_id = cv.id
    ),
    (
      select count(*)::integer from public.campaign_version_retailers vrl
      where vrl.campaign_version_id = cv.id
    ),
    (
      select count(*)::integer from public.campaign_version_retailer_groups vg
      where vg.campaign_version_id = cv.id
    ),
    (
      select count(*)::integer from public.campaign_version_products vp
      where vp.campaign_version_id = cv.id
    ),
    c.created_at,
    c.updated_at
  from public.campaigns c
  -- The version in view. coalesce, not a join on both: a campaign has at most one of
  -- each and this picks the published one whenever it exists.
  left join public.campaign_versions cv
    on cv.id = coalesce(c.published_version_id, c.draft_version_id)
  left join public.campaign_rules r
    on r.campaign_version_id = cv.id and r.sequence = 1
  left join public.campaign_rule_tiers t
    on t.campaign_rule_id = r.id and t.tier_number = 1
  where c.vendor_organization_id = v_vendor
  order by c.created_at desc, c.id desc;
end;
$$;

revoke all     on function public.list_vendor_campaigns() from public;
revoke execute on function public.list_vendor_campaigns() from anon;
grant  execute on function public.list_vendor_campaigns() to authenticated;

-- ============================================================================
-- FUNCTION 8 — get_vendor_campaign(uuid)
-- ============================================================================
-- One campaign's identity, management status and version pointers. Deliberately narrow:
-- it says WHICH versions exist and what state the campaign is in, and the configuration
-- of a particular version is fetched by get_vendor_campaign_version(). Splitting them is
-- what lets the detail screen show the published version while the edit screen shows the
-- draft, without either of them receiving the other's data.
create function public.get_vendor_campaign(
  p_campaign_id uuid
)
returns table (
  campaign_id             uuid,
  name                    text,
  description             text,
  campaign_status         text,
  derived_state           text,
  draft_version_id        uuid,
  draft_version_number    integer,
  published_version_id    uuid,
  published_version_number integer,
  version_count           integer,
  created_at              timestamptz,
  updated_at              timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    c.id,
    c.name,
    c.description,
    c.status,
    public.campaign_derived_state(c.status, pv.starts_at, pv.ends_at),
    c.draft_version_id,
    dv.version_number,
    c.published_version_id,
    pv.version_number,
    (
      select count(*)::integer from public.campaign_versions av
      where av.campaign_id = c.id
    ),
    c.created_at,
    c.updated_at
  from public.campaigns c
  left join public.campaign_versions dv on dv.id = c.draft_version_id
  left join public.campaign_versions pv on pv.id = c.published_version_id
  where c.id = p_campaign_id
    and c.vendor_organization_id = v_vendor;
end;
$$;

revoke all     on function public.get_vendor_campaign(uuid) from public;
revoke execute on function public.get_vendor_campaign(uuid) from anon;
grant  execute on function public.get_vendor_campaign(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 9 — get_vendor_campaign_version(uuid)
-- ============================================================================
-- The complete configuration of ONE version, addressed by its own id and filtered
-- through its campaign's Vendor. A version id belonging to another Vendor selects
-- nothing.
create function public.get_vendor_campaign_version(
  p_campaign_version_id uuid
)
returns table (
  version_id             uuid,
  campaign_id            uuid,
  version_number         integer,
  is_published           boolean,
  published_at           timestamptz,
  starts_at              timestamptz,
  ends_at                timestamptz,
  timezone_name          text,
  audience_mode          text,
  performance_scope      text,
  product_scope          text,
  product_eligibility_resolution text,
  stacking_mode          text,
  exclusivity_key        text,
  priority               integer,
  reward_recipient_scope text,
  rule_type              text,
  metric_type            text,
  coins_per_unit         bigint,
  max_reward_coins       bigint,
  threshold_units        integer,
  reward_coins           bigint,
  eligible_retailer_count integer,
  eligible_product_count  integer,
  created_at             timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    cv.id,
    cv.campaign_id,
    cv.version_number,
    cv.published_at is not null,
    cv.published_at,
    cv.starts_at,
    cv.ends_at,
    cv.timezone_name,
    cv.audience_mode,
    cv.performance_scope,
    cv.product_scope,
    cv.product_eligibility_resolution,
    cv.stacking_mode,
    cv.exclusivity_key,
    cv.priority,
    cv.reward_recipient_scope,
    r.rule_type,
    r.metric_type,
    r.coins_per_unit,
    r.max_reward_coins,
    t.threshold_units,
    t.reward_coins,
    (
      select count(*)::integer from public.campaign_eligible_retailers er
      where er.campaign_version_id = cv.id
    ),
    -- (Retailer, product) PAIRS, not distinct products — the same quantity
    -- publish_vendor_campaign() reports and the same rows the snapshot table holds, so
    -- the two can never disagree about what was frozen. It is 0 for an
    -- ALL_ELIGIBLE_PRODUCTS version by design: that scope writes no snapshot rows
    -- because it resolves live, and a client must read product_scope before presenting
    -- this number rather than rendering "0 products".
    (
      select count(*)::integer
      from public.campaign_eligible_products ep
      where ep.campaign_version_id = cv.id
    ),
    cv.created_at
  from public.campaign_versions cv
  join public.campaigns c on c.id = cv.campaign_id
  left join public.campaign_rules r
    on r.campaign_version_id = cv.id and r.sequence = 1
  left join public.campaign_rule_tiers t
    on t.campaign_rule_id = r.id and t.tier_number = 1
  where cv.id = p_campaign_version_id
    and c.vendor_organization_id = v_vendor;
end;
$$;

revoke all     on function public.get_vendor_campaign_version(uuid) from public;
revoke execute on function public.get_vendor_campaign_version(uuid) from anon;
grant  execute on function public.get_vendor_campaign_version(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 10 — list_vendor_campaign_version_retailers(uuid)
-- ============================================================================
-- The Retailers a version targets DIRECTLY. Authoring intent, so the edit screen can
-- re-open the wizard with the operator's own selection rather than with what publication
-- later resolved.
create function public.list_vendor_campaign_version_retailers(
  p_campaign_version_id uuid
)
returns table (
  vendor_retailer_id  uuid,
  retailer_name       text,
  retailer_status     text,
  relationship_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    vrl.vendor_retailer_id,
    o.name,
    o.status,
    vr.status
  from public.campaign_version_retailers vrl
  join public.campaign_versions cv on cv.id = vrl.campaign_version_id
  join public.campaigns c on c.id = cv.campaign_id
  join public.vendor_retailers vr on vr.id = vrl.vendor_retailer_id
  join public.organizations o on o.id = vr.retailer_organization_id
  where vrl.campaign_version_id = p_campaign_version_id
    and c.vendor_organization_id = v_vendor
  order by o.name, vrl.vendor_retailer_id;
end;
$$;

revoke all     on function public.list_vendor_campaign_version_retailers(uuid) from public;
revoke execute on function public.list_vendor_campaign_version_retailers(uuid) from anon;
grant  execute on function public.list_vendor_campaign_version_retailers(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 11 — list_vendor_campaign_version_groups(uuid)
-- ============================================================================
create function public.list_vendor_campaign_version_groups(
  p_campaign_version_id uuid
)
returns table (
  group_id     uuid,
  name         text,
  status       text,
  member_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    g.id,
    g.name,
    g.status,
    (
      select count(*)::integer
      from public.campaign_retailer_group_members m
      where m.campaign_retailer_group_id = g.id
        and m.removed_at is null
    )
  from public.campaign_version_retailer_groups vg
  join public.campaign_versions cv on cv.id = vg.campaign_version_id
  join public.campaigns c on c.id = cv.campaign_id
  join public.campaign_retailer_groups g on g.id = vg.campaign_retailer_group_id
  where vg.campaign_version_id = p_campaign_version_id
    and c.vendor_organization_id = v_vendor
  order by g.name, g.id;
end;
$$;

revoke all     on function public.list_vendor_campaign_version_groups(uuid) from public;
revoke execute on function public.list_vendor_campaign_version_groups(uuid) from anon;
grant  execute on function public.list_vendor_campaign_version_groups(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 12 — list_vendor_campaign_version_products(uuid)
-- ============================================================================
create function public.list_vendor_campaign_version_products(
  p_campaign_version_id uuid
)
returns table (
  product_id     uuid,
  product_code   text,
  product_name   text,
  brand          text,
  product_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    vp.id,
    vp.product_code,
    vp.product_name,
    vp.brand,
    vp.status
  from public.campaign_version_products cvp
  join public.campaign_versions cv on cv.id = cvp.campaign_version_id
  join public.campaigns c on c.id = cv.campaign_id
  join public.vendor_products vp on vp.id = cvp.vendor_product_id
  where cvp.campaign_version_id = p_campaign_version_id
    and c.vendor_organization_id = v_vendor
  order by vp.product_name, vp.product_code, vp.id;
end;
$$;

revoke all     on function public.list_vendor_campaign_version_products(uuid) from public;
revoke execute on function public.list_vendor_campaign_version_products(uuid) from anon;
grant  execute on function public.list_vendor_campaign_version_products(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 13 — list_vendor_campaign_eligible_retailers(uuid)
-- ============================================================================
-- The PUBLISHED snapshot: which Retailers a version actually resolved to, why, and how
-- many products are eligible for each. Vendor-only — `source` and the group name are
-- Vendor-private segmentation facts that no Retailer-facing read returns.
create function public.list_vendor_campaign_eligible_retailers(
  p_campaign_version_id uuid
)
returns table (
  vendor_retailer_id    uuid,
  retailer_name         text,
  source                text,
  source_group_name     text,
  eligible_product_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    er.vendor_retailer_id,
    o.name,
    er.source,
    g.name,
    (
      select count(*)::integer
      from public.campaign_eligible_products ep
      where ep.campaign_version_id = er.campaign_version_id
        and ep.vendor_retailer_id = er.vendor_retailer_id
    )
  from public.campaign_eligible_retailers er
  join public.campaign_versions cv on cv.id = er.campaign_version_id
  join public.campaigns c on c.id = cv.campaign_id
  join public.organizations o on o.id = er.retailer_organization_id
  left join public.campaign_retailer_groups g on g.id = er.source_group_id
  where er.campaign_version_id = p_campaign_version_id
    and c.vendor_organization_id = v_vendor
  order by o.name, er.vendor_retailer_id;
end;
$$;

revoke all     on function public.list_vendor_campaign_eligible_retailers(uuid) from public;
revoke execute on function public.list_vendor_campaign_eligible_retailers(uuid) from anon;
grant  execute on function public.list_vendor_campaign_eligible_retailers(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 14 — preview_vendor_campaign_publication(uuid)
-- ============================================================================
-- WHAT PUBLICATION WOULD RESOLVE TO, right now, WITHOUT WRITING ANYTHING.
--
-- This is how the wizard shows assignment conflicts BEFORE the operator commits: one row
-- per Retailer the audience admits, with how many of the selected products that Retailer
-- actually holds and how many it does not. A Retailer with `missing_product_count` above
-- zero is the conflict — the campaign will run there for fewer products than the
-- operator chose, and they can fix the assignment or narrow the selection first.
--
-- It applies EXACTLY the rule publish_vendor_campaign() applies, described once in this
-- file's header. Being a separate read it can drift from that rule, so the pgTAP suite
-- pins the two against each other rather than trusting the comment.
--
-- STABLE and writes nothing: safe to call on every render of the review step.
create function public.preview_vendor_campaign_publication(
  p_campaign_version_id uuid
)
returns table (
  vendor_retailer_id     uuid,
  retailer_name          text,
  source                 text,
  eligible_product_count integer,
  missing_product_count  integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor  uuid;
  v_version public.campaign_versions%rowtype;
  v_selected_products integer;
begin
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_vendor is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  select cv.* into v_version
  from public.campaign_versions cv
  join public.campaigns c on c.id = cv.campaign_id
  where cv.id = p_campaign_version_id
    and c.vendor_organization_id = v_vendor;

  if v_version.id is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  select count(*)::integer into v_selected_products
  from public.campaign_version_products cvp
  where cvp.campaign_version_id = v_version.id;

  return query
  with admitted as (
    -- ALL_RETAILERS: every relationship this Vendor holds.
    select vr.id as vendor_retailer_id,
           vr.retailer_organization_id,
           'ALL_RETAILERS'::text as source
    from public.vendor_retailers vr
    where v_version.audience_mode = 'ALL_RETAILERS'
      and vr.vendor_organization_id = v_vendor

    union all

    -- SELECTED_RETAILERS: the directly named rows.
    select vr.id, vr.retailer_organization_id, 'DIRECT_SELECTION'::text
    from public.campaign_version_retailers vrl
    join public.vendor_retailers vr on vr.id = vrl.vendor_retailer_id
    where v_version.audience_mode = 'SELECTED_RETAILERS'
      and vrl.campaign_version_id = v_version.id
      and vr.vendor_organization_id = v_vendor

    union all

    -- RETAILER_GROUPS: the LIVE members of the selected groups.
    select vr.id, vr.retailer_organization_id, 'RETAILER_GROUP'::text
    from public.campaign_version_retailer_groups vg
    join public.campaign_retailer_group_members m
      on m.campaign_retailer_group_id = vg.campaign_retailer_group_id
     and m.removed_at is null
    join public.vendor_retailers vr on vr.id = m.vendor_retailer_id
    where v_version.audience_mode = 'RETAILER_GROUPS'
      and vg.campaign_version_id = v_version.id
      and vr.vendor_organization_id = v_vendor
  ),
  -- A Retailer named by two groups appears once. DISTINCT ON with a deterministic order
  -- so the surviving row is always the same one rather than whatever arrived first.
  deduped as (
    select distinct on (a.vendor_retailer_id)
      a.vendor_retailer_id, a.retailer_organization_id, a.source
    from admitted a
    join public.vendor_retailers vr on vr.id = a.vendor_retailer_id
    join public.organizations o on o.id = a.retailer_organization_id
    where vr.status = 'ACTIVE'
      and o.status = 'ACTIVE'
    order by a.vendor_retailer_id, a.source
  )
  select
    d.vendor_retailer_id,
    o.name,
    d.source,
    case
      when v_version.product_scope = 'ALL_ELIGIBLE_PRODUCTS' then (
        select count(*)::integer
        from public.vendor_product_retailer_assignments pa
        join public.vendor_products vp on vp.id = pa.vendor_product_id
        where pa.retailer_organization_id = d.retailer_organization_id
          and pa.status = 'ACTIVE'
          and vp.status = 'ACTIVE'
          and vp.vendor_organization_id = v_vendor
      )
      else (
        select count(*)::integer
        from public.campaign_version_products cvp
        join public.vendor_products vp on vp.id = cvp.vendor_product_id
        join public.vendor_product_retailer_assignments pa
          on pa.vendor_product_id = cvp.vendor_product_id
         and pa.retailer_organization_id = d.retailer_organization_id
         and pa.status = 'ACTIVE'
        where cvp.campaign_version_id = v_version.id
          and vp.status = 'ACTIVE'
          and vp.vendor_organization_id = v_vendor
      )
    end,
    case
      when v_version.product_scope = 'ALL_ELIGIBLE_PRODUCTS' then 0
      else v_selected_products - (
        select count(*)::integer
        from public.campaign_version_products cvp
        join public.vendor_products vp on vp.id = cvp.vendor_product_id
        join public.vendor_product_retailer_assignments pa
          on pa.vendor_product_id = cvp.vendor_product_id
         and pa.retailer_organization_id = d.retailer_organization_id
         and pa.status = 'ACTIVE'
        where cvp.campaign_version_id = v_version.id
          and vp.status = 'ACTIVE'
          and vp.vendor_organization_id = v_vendor
      )
    end
  from deduped d
  join public.organizations o on o.id = d.retailer_organization_id
  order by o.name, d.vendor_retailer_id;
end;
$$;

revoke all     on function public.preview_vendor_campaign_publication(uuid) from public;
revoke execute on function public.preview_vendor_campaign_publication(uuid) from anon;
grant  execute on function public.preview_vendor_campaign_publication(uuid) to authenticated;

-- ============================================================================
-- INTERNAL HELPER 3 — campaign_apply_draft_config(...)
-- ============================================================================
-- Validates the complete typed configuration and writes it onto ONE DRAFT version:
-- the version's own columns, its audience rows, its product rows and its single rule
-- with its tier. Shared verbatim by create_vendor_campaign_draft and
-- update_vendor_campaign_draft so the two cannot validate differently — which is the
-- whole reason it exists rather than being copied twice.
--
-- EVERY ARGUMENT IS TYPED AND EVERY ARGUMENT IS CHECKED. There is no JSON payload
-- anywhere in this contract: a jsonb column would move the business rule beyond the
-- database's reach, and a caller could then write a shape no constraint refuses.
--
-- REPLACE, NOT MERGE. The audience, product and rule rows for the version are deleted
-- and rewritten from the arguments, so the stored draft is always exactly what was last
-- submitted. A partial save that left yesterday's Retailers alongside today's would be a
-- configuration nobody chose.
--
-- ARRAYS ARE CLEARED WHEN THE MODE DOES NOT USE THEM, deliberately. An ALL_RETAILERS
-- version stores no selected Retailers even if the caller sent some, so switching a
-- draft from SELECTED_RETAILERS to ALL_RETAILERS cannot leave orphan rows that a later
-- switch back would silently resurrect.
--
-- Internal only: not granted to any browser role. It performs no authorization of its
-- own and must never be reachable directly — the two public callers resolve the Vendor
-- and lock the campaign before invoking it.
create function public.campaign_apply_draft_config(
  p_version_id          uuid,
  p_vendor              uuid,
  p_starts_at           timestamptz,
  p_ends_at             timestamptz,
  p_timezone_name       text,
  p_audience_mode       text,
  p_performance_scope   text,
  p_product_scope       text,
  p_stacking_mode       text,
  p_exclusivity_key     text,
  p_priority            integer,
  p_rule_type           text,
  p_coins_per_unit      bigint,
  p_threshold_units     integer,
  p_reward_coins        bigint,
  p_max_reward_coins    bigint,
  p_vendor_retailer_ids uuid[],
  p_group_ids           uuid[],
  p_product_ids         uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_audience    text;
  v_performance text;
  v_scope       text;
  v_stacking    text;
  v_key         text;
  v_priority    integer;
  v_rule_type   text;
  v_timezone    text;
  v_retailers   uuid[];
  v_groups      uuid[];
  v_products    uuid[];
  v_rule_id     uuid;
begin
  -- ---- Normalize the closed vocabularies ----------------------------------
  -- Upper-cased and trimmed here so a caller that sent "selected_retailers" is treated
  -- the same as one that sent the canonical form, rather than being refused for a
  -- difference that carries no meaning.
  v_audience    := nullif(btrim(upper(coalesce(p_audience_mode, ''))), '');
  v_performance := nullif(btrim(upper(coalesce(p_performance_scope, ''))), '');
  v_scope       := nullif(btrim(upper(coalesce(p_product_scope, ''))), '');
  v_stacking    := nullif(btrim(upper(coalesce(p_stacking_mode, ''))), '');
  v_rule_type   := nullif(btrim(upper(coalesce(p_rule_type, ''))), '');
  v_timezone    := nullif(btrim(coalesce(p_timezone_name, '')), '');
  v_priority    := coalesce(p_priority, 0);

  if v_audience is null or v_audience not in
     ('ALL_RETAILERS', 'SELECTED_RETAILERS', 'RETAILER_GROUPS') then
    raise exception 'Choose who this campaign applies to'
      using errcode = 'check_violation';
  end if;
  if v_performance is null or v_performance not in
     ('INDIVIDUAL_STAFF', 'RETAILER_TEAM') then
    raise exception 'Choose how performance is measured'
      using errcode = 'check_violation';
  end if;
  if v_scope is null or v_scope not in
     ('ALL_ELIGIBLE_PRODUCTS', 'SELECTED_PRODUCTS') then
    raise exception 'Choose which products are included'
      using errcode = 'check_violation';
  end if;
  if v_stacking is null or v_stacking not in ('STACKABLE', 'EXCLUSIVE') then
    raise exception 'Choose whether this campaign stacks with others'
      using errcode = 'check_violation';
  end if;
  if v_rule_type is null or v_rule_type not in ('PER_UNIT_COINS', 'TARGET_BONUS') then
    raise exception 'Choose a reward type'
      using errcode = 'check_violation';
  end if;

  -- ---- Schedule ------------------------------------------------------------
  if p_starts_at is null then
    raise exception 'Enter a start date'
      using errcode = 'check_violation';
  end if;
  if p_ends_at is not null and p_ends_at <= p_starts_at then
    raise exception 'The end date must be after the start date'
      using errcode = 'check_violation';
  end if;
  if v_timezone is null or length(v_timezone) > 64 then
    raise exception 'Choose a valid campaign time zone'
      using errcode = 'check_violation';
  end if;

  -- ---- Stacking ------------------------------------------------------------
  -- The key is normalized the way the table's CHECK requires, so the equality that
  -- decides whether two campaigns compete is one the DATABASE defines.
  if v_stacking = 'EXCLUSIVE' then
    v_key := upper(regexp_replace(btrim(coalesce(p_exclusivity_key, '')), '\s+', ' ', 'g'));
    if v_key = '' or length(v_key) > 64
       or (v_key collate "C") !~ '^[A-Z0-9][A-Z0-9 ._-]*$' then
      raise exception 'Enter an exclusivity key for an exclusive campaign'
        using errcode = 'check_violation';
    end if;
  else
    -- Forced to NULL rather than merely ignored: a STACKABLE version carrying a key
    -- would look like it competes with something when it does not.
    v_key := null;
  end if;

  if v_priority < 0 or v_priority > 1000 then
    raise exception 'Priority must be between 0 and 1000'
      using errcode = 'check_violation';
  end if;

  -- ---- Reward --------------------------------------------------------------
  -- THE COIN CEILING is 1,000,000,000 on every configured amount, and it is checked here
  -- as well as by the CHECK constraints in 20260815090000. The constraint makes the bound
  -- true for every writer; this raises a message an operator can act on rather than a
  -- constraint name. See the storage migration for the overflow arithmetic it protects.
  if p_max_reward_coins is not null
     and (p_max_reward_coins <= 0 or p_max_reward_coins > 1000000000) then
    raise exception 'The maximum coins must be between 1 and 1,000,000,000'
      using errcode = 'check_violation';
  end if;

  if v_rule_type = 'PER_UNIT_COINS' then
    if p_coins_per_unit is null
       or p_coins_per_unit <= 0 or p_coins_per_unit > 1000000000 then
      raise exception 'Enter coins per unit between 1 and 1,000,000,000'
        using errcode = 'check_violation';
    end if;
  else
    if p_threshold_units is null or p_threshold_units < 1 then
      raise exception 'Enter the unit target'
        using errcode = 'check_violation';
    end if;
    if p_reward_coins is null
       or p_reward_coins < 1 or p_reward_coins > 1000000000 then
      raise exception 'Enter bonus coins between 1 and 1,000,000,000'
        using errcode = 'check_violation';
    end if;
  end if;

  -- ---- Audience and product sets ------------------------------------------
  -- Canonicalized the same way the group-membership contract canonicalizes: NULL becomes
  -- empty, duplicates collapse, NULL elements drop. Then cleared entirely when the mode
  -- does not use them.
  select coalesce(array_agg(distinct x), array[]::uuid[]) into v_retailers
  from unnest(coalesce(p_vendor_retailer_ids, array[]::uuid[])) as x where x is not null;

  select coalesce(array_agg(distinct x), array[]::uuid[]) into v_groups
  from unnest(coalesce(p_group_ids, array[]::uuid[])) as x where x is not null;

  select coalesce(array_agg(distinct x), array[]::uuid[]) into v_products
  from unnest(coalesce(p_product_ids, array[]::uuid[])) as x where x is not null;

  if v_audience <> 'SELECTED_RETAILERS' then v_retailers := array[]::uuid[]; end if;
  if v_audience <> 'RETAILER_GROUPS'    then v_groups    := array[]::uuid[]; end if;
  if v_scope    <> 'SELECTED_PRODUCTS'  then v_products  := array[]::uuid[]; end if;

  if v_audience = 'SELECTED_RETAILERS' and coalesce(array_length(v_retailers, 1), 0) = 0 then
    raise exception 'Select at least one Retailer'
      using errcode = 'check_violation';
  end if;
  if v_audience = 'RETAILER_GROUPS' and coalesce(array_length(v_groups, 1), 0) = 0 then
    raise exception 'Select at least one Retailer group'
      using errcode = 'check_violation';
  end if;
  if v_scope = 'SELECTED_PRODUCTS' and coalesce(array_length(v_products, 1), 0) = 0 then
    raise exception 'Select at least one product'
      using errcode = 'check_violation';
  end if;

  -- EVERY supplied id must belong to THIS Vendor. Checked before any write, so a foreign
  -- id changes nothing at all, and refused with the generic authorization message so a
  -- caller cannot distinguish "belongs to someone else" from "does not exist".
  if exists (
    select 1 from unnest(v_retailers) as req(id)
    where not exists (
      select 1 from public.vendor_retailers vr
      where vr.id = req.id and vr.vendor_organization_id = p_vendor
    )
  ) then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from unnest(v_groups) as req(id)
    where not exists (
      select 1 from public.campaign_retailer_groups g
      where g.id = req.id and g.vendor_organization_id = p_vendor
    )
  ) then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from unnest(v_products) as req(id)
    where not exists (
      select 1 from public.vendor_products vp
      where vp.id = req.id and vp.vendor_organization_id = p_vendor
    )
  ) then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- Write the version row ----------------------------------------------
  -- The foundation's triggers refuse this outright if the version has been published,
  -- so a published version cannot be reached through this path even by mistake.
  update public.campaign_versions cv
  set starts_at              = p_starts_at,
      ends_at                = p_ends_at,
      timezone_name          = v_timezone,
      audience_mode          = v_audience,
      performance_scope      = v_performance,
      product_scope          = v_scope,
      -- DERIVED, never accepted from the caller. There is no p_product_eligibility_resolution
      -- argument anywhere in this contract: the pairing is a property of the product scope,
      -- and campaign_versions_resolution_matches_scope refuses any other combination.
      product_eligibility_resolution =
        case when v_scope = 'SELECTED_PRODUCTS' then 'SNAPSHOT' else 'LIVE_TEMPORAL' end,
      stacking_mode          = v_stacking,
      exclusivity_key        = v_key,
      priority               = v_priority,
      reward_recipient_scope = 'CONTRIBUTING_STAFF'
  where cv.id = p_version_id;

  -- ---- Replace the target sets --------------------------------------------
  delete from public.campaign_version_retailers       where campaign_version_id = p_version_id;
  delete from public.campaign_version_retailer_groups where campaign_version_id = p_version_id;
  delete from public.campaign_version_products        where campaign_version_id = p_version_id;

  insert into public.campaign_version_retailers (campaign_version_id, vendor_retailer_id)
  select p_version_id, req.id from unnest(v_retailers) as req(id);

  insert into public.campaign_version_retailer_groups (campaign_version_id, campaign_retailer_group_id)
  select p_version_id, req.id from unnest(v_groups) as req(id);

  insert into public.campaign_version_products (campaign_version_id, vendor_product_id)
  select p_version_id, req.id from unnest(v_products) as req(id);

  -- ---- Replace the rule ----------------------------------------------------
  -- One rule at sequence 1. The schema permits several; this milestone's UI writes one,
  -- and the guard lives here rather than in a constraint so a later multi-rule contract
  -- relaxes a function instead of migrating a table.
  delete from public.campaign_rules where campaign_version_id = p_version_id;

  insert into public.campaign_rules (
    campaign_version_id, rule_type, metric_type, sequence, coins_per_unit, max_reward_coins
  )
  values (
    p_version_id,
    v_rule_type,
    'UNITS_SOLD',
    1,
    case when v_rule_type = 'PER_UNIT_COINS' then p_coins_per_unit else null end,
    p_max_reward_coins
  )
  returning id into v_rule_id;

  if v_rule_type = 'TARGET_BONUS' then
    insert into public.campaign_rule_tiers (
      campaign_rule_id, tier_number, threshold_units, reward_coins
    )
    values (v_rule_id, 1, p_threshold_units, p_reward_coins);
  end if;
end;
$$;

revoke all     on function public.campaign_apply_draft_config(
  uuid, uuid, timestamptz, timestamptz, text, text, text, text, text, text, integer,
  text, bigint, integer, bigint, bigint, uuid[], uuid[], uuid[]) from public;
revoke execute on function public.campaign_apply_draft_config(
  uuid, uuid, timestamptz, timestamptz, text, text, text, text, text, text, integer,
  text, bigint, integer, bigint, bigint, uuid[], uuid[], uuid[]) from anon;
revoke execute on function public.campaign_apply_draft_config(
  uuid, uuid, timestamptz, timestamptz, text, text, text, text, text, text, integer,
  text, bigint, integer, bigint, bigint, uuid[], uuid[], uuid[]) from authenticated;

-- ============================================================================
-- FUNCTION 15 — create_vendor_campaign_draft(...)
-- ============================================================================
-- Creates a campaign and its version 1 in one transaction, and returns the campaign id.
--
-- The campaign is DRAFT and NOTHING IS PUBLISHED. No Retailer and no staff member can
-- see it; no eligibility is resolved; no snapshot row is written. Publication is a
-- separate, explicit act.
create function public.create_vendor_campaign_draft(
  p_name                text,
  p_description         text,
  p_starts_at           timestamptz,
  p_ends_at             timestamptz,
  p_timezone_name       text,
  p_audience_mode       text,
  p_performance_scope   text,
  p_product_scope       text,
  p_stacking_mode       text,
  p_exclusivity_key     text,
  p_priority            integer,
  p_rule_type           text,
  p_coins_per_unit      bigint,
  p_threshold_units     integer,
  p_reward_coins        bigint,
  p_max_reward_coins    bigint,
  p_vendor_retailer_ids uuid[],
  p_group_ids           uuid[],
  p_product_ids         uuid[]
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor      uuid;
  v_actor       uuid;
  v_name        text;
  v_description text;
  v_campaign_id uuid;
  v_version_id  uuid;
begin
  v_actor  := auth.uid();
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_actor is null or v_vendor is null then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_description := nullif(btrim(coalesce(p_description, '')), '');

  if v_name = '' or length(v_name) > 150 then
    raise exception 'Enter a campaign name'
      using errcode = 'check_violation';
  end if;
  if v_description is not null and length(v_description) > 2000 then
    raise exception 'Description is too long'
      using errcode = 'check_violation';
  end if;

  insert into public.campaigns (
    vendor_organization_id, name, description, status, created_by_profile_id
  )
  values (v_vendor, v_name, v_description, 'DRAFT', v_actor)
  returning id into v_campaign_id;

  -- Placeholder values for the NOT NULL columns, replaced immediately by the shared
  -- config writer below inside this same transaction. Nothing observes the intermediate
  -- row: the insert and the update are one statement pair in one transaction, and no
  -- other session can see either until it commits.
  insert into public.campaign_versions (
    campaign_id, version_number, starts_at, timezone_name,
    audience_mode, performance_scope, product_scope, product_eligibility_resolution,
    stacking_mode, created_by_profile_id
  )
  values (
    v_campaign_id, 1, coalesce(p_starts_at, now()), 'UTC',
    'ALL_RETAILERS', 'INDIVIDUAL_STAFF', 'ALL_ELIGIBLE_PRODUCTS',
    -- Stated explicitly rather than left to the column default, because
    -- campaign_versions_resolution_matches_scope requires the pair to agree and the
    -- placeholder scope above is ALL_ELIGIBLE_PRODUCTS. The shared config writer replaces
    -- both consistently in the same transaction.
    'LIVE_TEMPORAL',
    'STACKABLE', v_actor
  )
  returning id into v_version_id;

  perform public.campaign_apply_draft_config(
    v_version_id, v_vendor, p_starts_at, p_ends_at, p_timezone_name,
    p_audience_mode, p_performance_scope, p_product_scope, p_stacking_mode,
    p_exclusivity_key, p_priority, p_rule_type, p_coins_per_unit,
    p_threshold_units, p_reward_coins, p_max_reward_coins,
    p_vendor_retailer_ids, p_group_ids, p_product_ids
  );

  update public.campaigns c
  set draft_version_id = v_version_id
  where c.id = v_campaign_id;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor, v_actor, 'CAMPAIGN_DRAFT_CREATED', 'CAMPAIGN', v_campaign_id::text,
    jsonb_build_object(
      'campaign_name',     v_name,
      'version_number',    1,
      'audience_mode',     upper(btrim(coalesce(p_audience_mode, ''))),
      'performance_scope', upper(btrim(coalesce(p_performance_scope, ''))),
      'product_scope',     upper(btrim(coalesce(p_product_scope, ''))),
      'stacking_mode',     upper(btrim(coalesce(p_stacking_mode, ''))),
      'rule_type',         upper(btrim(coalesce(p_rule_type, ''))),
      'campaign_status',   'DRAFT'
    )
  );

  return v_campaign_id;
end;
$$;

revoke all     on function public.create_vendor_campaign_draft(
  text, text, timestamptz, timestamptz, text, text, text, text, text, text, integer,
  text, bigint, integer, bigint, bigint, uuid[], uuid[], uuid[]) from public;
revoke execute on function public.create_vendor_campaign_draft(
  text, text, timestamptz, timestamptz, text, text, text, text, text, text, integer,
  text, bigint, integer, bigint, bigint, uuid[], uuid[], uuid[]) from anon;
grant  execute on function public.create_vendor_campaign_draft(
  text, text, timestamptz, timestamptz, text, text, text, text, text, text, integer,
  text, bigint, integer, bigint, bigint, uuid[], uuid[], uuid[]) to authenticated;

-- ============================================================================
-- FUNCTION 16 — update_vendor_campaign_draft(...)
-- ============================================================================
-- Rewrites the campaign's DRAFT version whole. Refused when the campaign has no draft —
-- which is the case for a published campaign until create_vendor_campaign_version() has
-- been called, and permanently for a cancelled one.
create function public.update_vendor_campaign_draft(
  p_campaign_id         uuid,
  p_name                text,
  p_description         text,
  p_starts_at           timestamptz,
  p_ends_at             timestamptz,
  p_timezone_name       text,
  p_audience_mode       text,
  p_performance_scope   text,
  p_product_scope       text,
  p_stacking_mode       text,
  p_exclusivity_key     text,
  p_priority            integer,
  p_rule_type           text,
  p_coins_per_unit      bigint,
  p_threshold_units     integer,
  p_reward_coins        bigint,
  p_max_reward_coins    bigint,
  p_vendor_retailer_ids uuid[],
  p_group_ids           uuid[],
  p_product_ids         uuid[]
)
returns table (
  campaign_id         uuid,
  campaign_version_id uuid,
  version_number      integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor      uuid;
  v_actor       uuid;
  v_name        text;
  v_description text;
  v_campaign    public.campaigns%rowtype;
  v_version_no  integer;
begin
  v_actor  := auth.uid();
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_actor is null or v_vendor is null then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  v_name := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_description := nullif(btrim(coalesce(p_description, '')), '');

  if v_name = '' or length(v_name) > 150 then
    raise exception 'Enter a campaign name'
      using errcode = 'check_violation';
  end if;
  if v_description is not null and length(v_description) > 2000 then
    raise exception 'Description is too long'
      using errcode = 'check_violation';
  end if;

  -- Lock the campaign, so a concurrent publish cannot land between the check that a
  -- draft exists and the write that changes it.
  select c.* into v_campaign
  from public.campaigns c
  where c.id = p_campaign_id
    and c.vendor_organization_id = v_vendor
  for update;

  if v_campaign.id is null then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  if v_campaign.status = 'CANCELLED' then
    raise exception 'A cancelled campaign cannot be edited'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_campaign.draft_version_id is null then
    raise exception 'This campaign has no draft to edit; create a new version first'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update public.campaigns c
  set name = v_name, description = v_description
  where c.id = v_campaign.id;

  perform public.campaign_apply_draft_config(
    v_campaign.draft_version_id, v_vendor, p_starts_at, p_ends_at, p_timezone_name,
    p_audience_mode, p_performance_scope, p_product_scope, p_stacking_mode,
    p_exclusivity_key, p_priority, p_rule_type, p_coins_per_unit,
    p_threshold_units, p_reward_coins, p_max_reward_coins,
    p_vendor_retailer_ids, p_group_ids, p_product_ids
  );

  select cv.version_number into v_version_no
  from public.campaign_versions cv where cv.id = v_campaign.draft_version_id;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor, v_actor, 'CAMPAIGN_DRAFT_UPDATED', 'CAMPAIGN', v_campaign.id::text,
    jsonb_build_object(
      'campaign_name',     v_name,
      'version_number',    v_version_no,
      'audience_mode',     upper(btrim(coalesce(p_audience_mode, ''))),
      'performance_scope', upper(btrim(coalesce(p_performance_scope, ''))),
      'product_scope',     upper(btrim(coalesce(p_product_scope, ''))),
      'stacking_mode',     upper(btrim(coalesce(p_stacking_mode, ''))),
      'rule_type',         upper(btrim(coalesce(p_rule_type, ''))),
      'campaign_status',   v_campaign.status
    )
  );

  return query select v_campaign.id, v_campaign.draft_version_id, v_version_no;
end;
$$;

revoke all     on function public.update_vendor_campaign_draft(
  uuid, text, text, timestamptz, timestamptz, text, text, text, text, text, text,
  integer, text, bigint, integer, bigint, bigint, uuid[], uuid[], uuid[]) from public;
revoke execute on function public.update_vendor_campaign_draft(
  uuid, text, text, timestamptz, timestamptz, text, text, text, text, text, text,
  integer, text, bigint, integer, bigint, bigint, uuid[], uuid[], uuid[]) from anon;
grant  execute on function public.update_vendor_campaign_draft(
  uuid, text, text, timestamptz, timestamptz, text, text, text, text, text, text,
  integer, text, bigint, integer, bigint, bigint, uuid[], uuid[], uuid[]) to authenticated;

-- ============================================================================
-- FUNCTION 17 — publish_vendor_campaign(uuid)
-- ============================================================================
-- Resolves the draft version's audience and products AS THEY ARE AT THIS INSTANT,
-- freezes the result into the two snapshot tables, stamps the version published, and
-- moves the campaign into PUBLISHED — all in one transaction.
--
-- IDEMPOTENT BY CONSTRUCTION. Publication clears draft_version_id, so a second call
-- finds no draft and returns `published = false` with the version that is already in
-- force. It does not raise, does not create a second version, and cannot write a second
-- snapshot row — the unique index on (campaign_version_id, vendor_retailer_id) is the
-- final authority on that even under concurrency. A double-clicked publish button is a
-- no-op, not a duplicate campaign.
--
-- NO AUDIT ON THE NO-OP, for the same reason no other operation in this project audits
-- one: an audit trail whose entries do not correspond to changes is worse than a shorter
-- one.
--
-- THE RESOLUTION RULE IS THE ONE IN THIS FILE'S HEADER, applied here and mirrored by
-- preview_vendor_campaign_publication(). Publication is REFUSED rather than producing an
-- empty promise when it resolves to no Retailer, or to no eligible pair under
-- SELECTED_PRODUCTS.
create function public.publish_vendor_campaign(
  p_campaign_id uuid
)
returns table (
  campaign_id             uuid,
  campaign_version_id     uuid,
  version_number          integer,
  campaign_status         text,
  eligible_retailer_count integer,
  eligible_product_count  integer,
  published               boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor         uuid;
  v_actor          uuid;
  v_campaign       public.campaigns%rowtype;
  v_version        public.campaign_versions%rowtype;
  v_rule           public.campaign_rules%rowtype;
  v_retailer_count integer := 0;
  v_product_count  integer := 0;
  v_current_number integer;
begin
  v_actor  := auth.uid();
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_actor is null or v_vendor is null then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  -- FOR UPDATE is what makes publication lock deterministically: two concurrent calls
  -- serialize on the campaign row, and the second sees draft_version_id already cleared.
  select c.* into v_campaign
  from public.campaigns c
  where c.id = p_campaign_id
    and c.vendor_organization_id = v_vendor
  for update;

  if v_campaign.id is null then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  if v_campaign.status = 'CANCELLED' then
    raise exception 'A cancelled campaign cannot be published'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- THE EXPLICIT NO-OP. Nothing to publish, so nothing happens and the caller is told
  -- so plainly rather than by an error it would have to interpret.
  if v_campaign.draft_version_id is null then
    select cv.version_number into v_current_number
    from public.campaign_versions cv where cv.id = v_campaign.published_version_id;

    return query
    select v_campaign.id,
           v_campaign.published_version_id,
           v_current_number,
           v_campaign.status,
           (select count(*)::integer from public.campaign_eligible_retailers er
             where er.campaign_version_id = v_campaign.published_version_id),
           -- PAIRS, matching what the publishing branch below returns, so a caller that
           -- publishes twice is told the same two numbers both times.
           (select count(*)::integer
              from public.campaign_eligible_products ep
             where ep.campaign_version_id = v_campaign.published_version_id),
           false;
    return;
  end if;

  select cv.* into v_version
  from public.campaign_versions cv where cv.id = v_campaign.draft_version_id;

  -- A draft without a rule cannot be published. Only reachable if a future contract
  -- writes a version without going through campaign_apply_draft_config().
  select r.* into v_rule
  from public.campaign_rules r
  where r.campaign_version_id = v_version.id and r.sequence = 1;

  if v_rule.id is null then
    raise exception 'This campaign has no reward rule yet'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- ---- Resolve and freeze the eligible Retailers ---------------------------
  with admitted as (
    select vr.id as vendor_retailer_id, vr.retailer_organization_id,
           'ALL_RETAILERS'::text as source, null::uuid as source_group_id
    from public.vendor_retailers vr
    where v_version.audience_mode = 'ALL_RETAILERS'
      and vr.vendor_organization_id = v_vendor

    union all

    select vr.id, vr.retailer_organization_id, 'DIRECT_SELECTION'::text, null::uuid
    from public.campaign_version_retailers vrl
    join public.vendor_retailers vr on vr.id = vrl.vendor_retailer_id
    where v_version.audience_mode = 'SELECTED_RETAILERS'
      and vrl.campaign_version_id = v_version.id
      and vr.vendor_organization_id = v_vendor

    union all

    select vr.id, vr.retailer_organization_id, 'RETAILER_GROUP'::text,
           vg.campaign_retailer_group_id
    from public.campaign_version_retailer_groups vg
    join public.campaign_retailer_group_members m
      on m.campaign_retailer_group_id = vg.campaign_retailer_group_id
     and m.removed_at is null
    join public.vendor_retailers vr on vr.id = m.vendor_retailer_id
    where v_version.audience_mode = 'RETAILER_GROUPS'
      and vg.campaign_version_id = v_version.id
      and vr.vendor_organization_id = v_vendor
  ),
  -- A Retailer named by two groups is ONE eligible Retailer. DISTINCT ON with a total
  -- order so the group recorded as the source is deterministic rather than incidental.
  eligible as (
    select distinct on (a.vendor_retailer_id)
      a.vendor_retailer_id, a.retailer_organization_id, a.source, a.source_group_id
    from admitted a
    join public.vendor_retailers vr on vr.id = a.vendor_retailer_id
    join public.organizations o on o.id = a.retailer_organization_id
    where vr.status = 'ACTIVE'
      and o.status = 'ACTIVE'
    order by a.vendor_retailer_id, a.source, a.source_group_id
  ),
  inserted as (
    insert into public.campaign_eligible_retailers (
      campaign_version_id, vendor_retailer_id, retailer_organization_id,
      source, source_group_id
    )
    select v_version.id, e.vendor_retailer_id, e.retailer_organization_id,
           e.source, e.source_group_id
    from eligible e
    returning 1
  )
  select count(*)::integer into v_retailer_count from inserted;

  if v_retailer_count = 0 then
    raise exception 'This campaign does not currently apply to any active Retailer'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- ---- Resolve and freeze the eligible (Retailer, product) pairs -----------
  -- ONLY for SELECTED_PRODUCTS. ALL_ELIGIBLE_PRODUCTS resolves live by design; see the
  -- file header for why freezing it would contradict the words.
  if v_version.product_scope = 'SELECTED_PRODUCTS' then
    with pairs as (
      insert into public.campaign_eligible_products (
        campaign_version_id, vendor_retailer_id, retailer_organization_id,
        vendor_product_id
      )
      select er.campaign_version_id, er.vendor_retailer_id, er.retailer_organization_id,
             cvp.vendor_product_id
      from public.campaign_eligible_retailers er
      join public.campaign_version_products cvp
        on cvp.campaign_version_id = er.campaign_version_id
      join public.vendor_products vp
        on vp.id = cvp.vendor_product_id
       and vp.status = 'ACTIVE'
       and vp.vendor_organization_id = v_vendor
      -- THE EXCLUSION. A selected product with no ACTIVE assignment to this Retailer
      -- produces no row: it is excluded for that Retailer, never silently included.
      join public.vendor_product_retailer_assignments pa
        on pa.vendor_product_id = cvp.vendor_product_id
       and pa.retailer_organization_id = er.retailer_organization_id
       and pa.status = 'ACTIVE'
      where er.campaign_version_id = v_version.id
      returning 1
    )
    select count(*)::integer into v_product_count from pairs;

    if v_product_count = 0 then
      raise exception 'None of the selected products is assigned to an eligible Retailer'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  -- ---- Stamp the version published, then move the campaign ------------------
  -- published_at moving from NULL to a value is the single transition
  -- campaign_version_assert_immutable() permits; every later UPDATE is refused.
  update public.campaign_versions cv
  set published_at = now()
  where cv.id = v_version.id;

  -- One statement, so campaigns_draft_has_no_published_version is never momentarily
  -- violated. A re-publish of a later version leaves status PUBLISHED and simply moves
  -- the pointer.
  update public.campaigns c
  set status = 'PUBLISHED',
      published_version_id = v_version.id,
      draft_version_id = null
  where c.id = v_campaign.id;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor, v_actor, 'CAMPAIGN_PUBLISHED', 'CAMPAIGN', v_campaign.id::text,
    jsonb_build_object(
      'campaign_name',           v_campaign.name,
      'version_number',          v_version.version_number,
      'status_before',           v_campaign.status,
      'status_after',            'PUBLISHED',
      'audience_mode',           v_version.audience_mode,
      'performance_scope',       v_version.performance_scope,
      'product_scope',           v_version.product_scope,
      'stacking_mode',           v_version.stacking_mode,
      'rule_type',               v_rule.rule_type,
      'eligible_retailer_count', v_retailer_count,
      'eligible_product_count',  v_product_count
    )
  );

  return query
  select v_campaign.id, v_version.id, v_version.version_number, 'PUBLISHED'::text,
         v_retailer_count, v_product_count, true;
end;
$$;

revoke all     on function public.publish_vendor_campaign(uuid) from public;
revoke execute on function public.publish_vendor_campaign(uuid) from anon;
grant  execute on function public.publish_vendor_campaign(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 18 — set_vendor_campaign_lifecycle(uuid, text)
-- ============================================================================
-- PAUSE, RESUME or CANCEL one published campaign. One contract rather than three, in the
-- shape set_vendor_retailer_status() and set_retailer_staff_membership_status()
-- established: a canonical target id, a closed action vocabulary, and a `status_changed`
-- flag so a no-op is reported as a no-op instead of as a success that changed nothing.
--
-- NOTHING HERE TOUCHES A VERSION. Pausing preserves the published configuration and its
-- snapshot completely; resuming restores eligibility against the ORIGINAL dates, because
-- the dates were never altered. That is why a published version can stay immutable while
-- its campaign remains controllable.
--
-- CANCEL IS TERMINAL for the published version: no later action moves a CANCELLED
-- campaign, and the schema keeps it visible historically rather than deleting anything.
create function public.set_vendor_campaign_lifecycle(
  p_campaign_id uuid,
  p_action      text
)
returns table (
  campaign_id     uuid,
  campaign_status text,
  status_changed  boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor   uuid;
  v_actor    uuid;
  v_campaign public.campaigns%rowtype;
  v_action   text;
  v_next     text;
  v_event    text;
begin
  v_actor  := auth.uid();
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_actor is null or v_vendor is null then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  v_action := nullif(btrim(upper(coalesce(p_action, ''))), '');

  if v_action is null or v_action not in ('PAUSE', 'RESUME', 'CANCEL') then
    raise exception 'Invalid campaign action'
      using errcode = 'check_violation';
  end if;

  select c.* into v_campaign
  from public.campaigns c
  where c.id = p_campaign_id
    and c.vendor_organization_id = v_vendor
  for update;

  if v_campaign.id is null then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  -- A DRAFT has nothing to pause, resume or cancel: it was never offered to anyone.
  if v_campaign.status = 'DRAFT' then
    raise exception 'This campaign has not been published yet'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_action = 'PAUSE' then
    if v_campaign.status = 'PAUSED' then
      return query select v_campaign.id, v_campaign.status, false;
      return;
    end if;
    if v_campaign.status <> 'PUBLISHED' then
      raise exception 'Only a published campaign can be paused'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    v_next := 'PAUSED'; v_event := 'CAMPAIGN_PAUSED';

  elsif v_action = 'RESUME' then
    if v_campaign.status = 'PUBLISHED' then
      return query select v_campaign.id, v_campaign.status, false;
      return;
    end if;
    if v_campaign.status <> 'PAUSED' then
      raise exception 'Only a paused campaign can be resumed'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
    v_next := 'PUBLISHED'; v_event := 'CAMPAIGN_RESUMED';

  else
    if v_campaign.status = 'CANCELLED' then
      return query select v_campaign.id, v_campaign.status, false;
      return;
    end if;
    v_next := 'CANCELLED'; v_event := 'CAMPAIGN_CANCELLED';
  end if;

  update public.campaigns c set status = v_next where c.id = v_campaign.id;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor, v_actor, v_event, 'CAMPAIGN', v_campaign.id::text,
    jsonb_build_object(
      'campaign_name', v_campaign.name,
      'status_before', v_campaign.status,
      'status_after',  v_next
    )
  );

  return query select v_campaign.id, v_next, true;
end;
$$;

revoke all     on function public.set_vendor_campaign_lifecycle(uuid, text) from public;
revoke execute on function public.set_vendor_campaign_lifecycle(uuid, text) from anon;
grant  execute on function public.set_vendor_campaign_lifecycle(uuid, text) to authenticated;

-- ============================================================================
-- FUNCTION 19 — create_vendor_campaign_version(uuid)
-- ============================================================================
-- Opens a new EDITABLE version by copying the version currently in force — its columns,
-- its selected Retailers, its selected groups, its selected products and its rule with
-- its tier. Returns the new draft version's id.
--
-- The published version stays in force and stays visible to Retailers until the new one
-- is published. That is the point: a material change is prepared alongside the running
-- campaign rather than by interrupting it.
--
-- Refused when a draft already exists — campaign_versions_one_draft_idx would refuse it
-- anyway, and a clear message is better than a unique-violation — and refused for a
-- CANCELLED campaign, which is terminal.
create function public.create_vendor_campaign_version(
  p_campaign_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor     uuid;
  v_actor      uuid;
  v_campaign   public.campaigns%rowtype;
  v_source     public.campaign_versions%rowtype;
  v_new_id     uuid;
  v_new_number integer;
  v_rule_id    uuid;
  v_new_rule   uuid;
begin
  v_actor  := auth.uid();
  v_vendor := public.resolve_campaign_vendor_organization('CAMPAIGNS_MANAGE');

  if v_actor is null or v_vendor is null then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  select c.* into v_campaign
  from public.campaigns c
  where c.id = p_campaign_id
    and c.vendor_organization_id = v_vendor
  for update;

  if v_campaign.id is null then
    raise exception 'Not authorized to manage campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  if v_campaign.status = 'CANCELLED' then
    raise exception 'A cancelled campaign cannot be versioned'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_campaign.published_version_id is null then
    raise exception 'This campaign has not been published yet'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_campaign.draft_version_id is not null then
    raise exception 'This campaign already has a draft version'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select cv.* into v_source
  from public.campaign_versions cv where cv.id = v_campaign.published_version_id;

  -- Dense numbering from the highest that exists, so a version number is never reused
  -- even if an unpublished draft was once deleted.
  select coalesce(max(cv.version_number), 0) + 1 into v_new_number
  from public.campaign_versions cv where cv.campaign_id = v_campaign.id;

  insert into public.campaign_versions (
    campaign_id, version_number, starts_at, ends_at, timezone_name,
    audience_mode, performance_scope, product_scope, product_eligibility_resolution,
    stacking_mode, exclusivity_key, priority, reward_recipient_scope, created_by_profile_id
  )
  values (
    v_campaign.id, v_new_number, v_source.starts_at, v_source.ends_at,
    v_source.timezone_name, v_source.audience_mode, v_source.performance_scope,
    v_source.product_scope, v_source.product_eligibility_resolution,
    v_source.stacking_mode, v_source.exclusivity_key,
    v_source.priority, v_source.reward_recipient_scope, v_actor
  )
  returning id into v_new_id;

  -- Copy the authoring targets. Not the SNAPSHOT: the new version will resolve its own
  -- eligibility when it publishes, against whatever the groups and assignments say then.
  insert into public.campaign_version_retailers (campaign_version_id, vendor_retailer_id)
  select v_new_id, s.vendor_retailer_id
  from public.campaign_version_retailers s
  where s.campaign_version_id = v_source.id;

  insert into public.campaign_version_retailer_groups (campaign_version_id, campaign_retailer_group_id)
  select v_new_id, s.campaign_retailer_group_id
  from public.campaign_version_retailer_groups s
  where s.campaign_version_id = v_source.id;

  insert into public.campaign_version_products (campaign_version_id, vendor_product_id)
  select v_new_id, s.vendor_product_id
  from public.campaign_version_products s
  where s.campaign_version_id = v_source.id;

  select r.id into v_rule_id
  from public.campaign_rules r
  where r.campaign_version_id = v_source.id and r.sequence = 1;

  if v_rule_id is not null then
    insert into public.campaign_rules (
      campaign_version_id, rule_type, metric_type, sequence, coins_per_unit, max_reward_coins
    )
    select v_new_id, r.rule_type, r.metric_type, r.sequence, r.coins_per_unit, r.max_reward_coins
    from public.campaign_rules r where r.id = v_rule_id
    returning id into v_new_rule;

    insert into public.campaign_rule_tiers (
      campaign_rule_id, tier_number, threshold_units, reward_coins
    )
    select v_new_rule, t.tier_number, t.threshold_units, t.reward_coins
    from public.campaign_rule_tiers t where t.campaign_rule_id = v_rule_id;
  end if;

  update public.campaigns c
  set draft_version_id = v_new_id
  where c.id = v_campaign.id;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor, v_actor, 'CAMPAIGN_VERSION_CREATED', 'CAMPAIGN', v_campaign.id::text,
    jsonb_build_object(
      'campaign_name',        v_campaign.name,
      'version_number',       v_new_number,
      'source_version_number', v_source.version_number,
      'campaign_status',      v_campaign.status
    )
  );

  return v_new_id;
end;
$$;

revoke all     on function public.create_vendor_campaign_version(uuid) from public;
revoke execute on function public.create_vendor_campaign_version(uuid) from anon;
grant  execute on function public.create_vendor_campaign_version(uuid) to authenticated;

-- ============================================================================
-- ASSIGNED VISIBILITY — what a Retailer Owner and a Sales Staff member may see
-- ============================================================================
-- The four reads below share one rule and differ in exactly two ways.
--
-- THE SHARED RULE: a campaign is visible only when it has a version IN FORCE
-- (campaigns.published_version_id) whose FROZEN SNAPSHOT contains the caller's own
-- Retailer. A DRAFT is invisible because it has no published version; a superseded
-- version is invisible because it is no longer the one in force; another Retailer's
-- campaign is invisible because its snapshot names a different organization. There is no
-- argument anywhere in these four contracts that could widen any of that.
--
-- WHAT IS NEVER RETURNED, and why each is withheld:
--   any other Retailer's identity, or a count of them    the campaign is presented as
--                                                        "yours"; a count would let a
--                                                        Retailer infer the Vendor's
--                                                        reach and their place in it.
--   eligibility source, source group name                Vendor-private segmentation.
--                                                        Naming the group would also
--                                                        imply the existence of its
--                                                        other members.
--   exclusivity_key, priority                            the Vendor's competition
--                                                        configuration between its own
--                                                        campaigns. The stacking MODE is
--                                                        returned because it changes what
--                                                        a seller can expect to earn;
--                                                        the key and the ranking do not.
--   version_number, version ids, draft state             internal campaign versioning.
--   created_by, timestamps, audit metadata               administration internals.
--
-- THE TWO DIFFERENCES:
--   1. The Owner read is gated on CAMPAIGNS_VIEW_ASSIGNED and returns the Vendor's name,
--      which the requirement names explicitly. The staff read is gated on
--      STAFF_CAMPAIGNS_VIEW and withholds it, following list_my_receipt_products():
--      naming the Vendor to a shop-floor seller leaks the supply relationship.
--   2. The Owner sees the whole history — active, upcoming, paused, ended and cancelled —
--      because managing a Retailer means knowing what ran. A staff member sees only
--      ACTIVE and SCHEDULED campaigns: what they can sell into now or soon. A paused,
--      ended or cancelled campaign offers them nothing and showing it would invite the
--      belief that it does.
--
-- NO PROGRESS AND NO BALANCE IS RETURNED BY ANY OF THEM. The reward columns are the
-- OFFER — coins per unit, target, bonus, cap. Nothing in this file computes what has
-- been sold, earned, or credited, and no client can fabricate it from these fields.

-- ============================================================================
-- FUNCTION 20 — list_my_retailer_campaigns()
-- ============================================================================
create function public.list_my_retailer_campaigns()
returns table (
  campaign_id            uuid,
  campaign_name          text,
  description            text,
  vendor_name            text,
  derived_state          text,
  campaign_status        text,
  starts_at              timestamptz,
  ends_at                timestamptz,
  timezone_name          text,
  performance_scope      text,
  product_scope          text,
  product_eligibility_resolution text,
  stacking_mode          text,
  reward_recipient_scope text,
  rule_type              text,
  metric_type            text,
  coins_per_unit         bigint,
  max_reward_coins       bigint,
  threshold_units        integer,
  reward_coins           bigint,
  eligible_product_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('CAMPAIGNS_VIEW_ASSIGNED');

  if v_retailer is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    c.id,
    c.name,
    c.description,
    vo.name,
    public.campaign_derived_state(c.status, cv.starts_at, cv.ends_at),
    c.status,
    cv.starts_at,
    cv.ends_at,
    cv.timezone_name,
    cv.performance_scope,
    cv.product_scope,
    cv.product_eligibility_resolution,
    cv.stacking_mode,
    cv.reward_recipient_scope,
    r.rule_type,
    r.metric_type,
    r.coins_per_unit,
    r.max_reward_coins,
    t.threshold_units,
    t.reward_coins,
    -- THIS Retailer's eligible product count, never the campaign's total across
    -- Retailers. For an ALL_ELIGIBLE_PRODUCTS campaign it is resolved live, which is
    -- what "all eligible products" means.
    case
      when cv.product_scope = 'SELECTED_PRODUCTS' then (
        select count(*)::integer from public.campaign_eligible_products ep
        where ep.campaign_version_id = cv.id
          and ep.retailer_organization_id = v_retailer
      )
      else (
        -- LIVE_TEMPORAL: resolved from the ASSIGNMENT TIMELINE at the documented instant,
        -- not from current assignment status. An ended campaign therefore reports what was
        -- eligible when it ended rather than what happens to be assigned today.
        select count(*)::integer
        from public.vendor_retailer_eligible_products_at(
               v_retailer,
               c.vendor_organization_id,
               public.campaign_product_eligibility_as_of(cv.starts_at, cv.ends_at)) e
      )
    end
  from public.campaign_eligible_retailers er
  join public.campaign_versions cv on cv.id = er.campaign_version_id
  join public.campaigns c
    on c.id = cv.campaign_id
   -- IN FORCE, not merely published: a superseded version's snapshot is history, and
   -- showing it would present an offer that has been replaced.
   and c.published_version_id = cv.id
  join public.organizations vo on vo.id = c.vendor_organization_id
  left join public.campaign_rules r
    on r.campaign_version_id = cv.id and r.sequence = 1
  left join public.campaign_rule_tiers t
    on t.campaign_rule_id = r.id and t.tier_number = 1
  where er.retailer_organization_id = v_retailer
  order by cv.starts_at desc, c.name, c.id;
end;
$$;

revoke all     on function public.list_my_retailer_campaigns() from public;
revoke execute on function public.list_my_retailer_campaigns() from anon;
grant  execute on function public.list_my_retailer_campaigns() to authenticated;

-- ============================================================================
-- FUNCTION 21 — get_my_retailer_campaign(uuid)
-- ============================================================================
-- ONE assigned campaign, addressed by id. THE SHAPE IS DELIBERATELY IDENTICAL to
-- list_my_retailer_campaigns() — same column names, same order, same types, same
-- withheld fields — so one client-side model deserializes both and a future column has
-- to be added to both or to neither. Same idiom as get_my_receipt_submission().
--
-- A campaign id that is not assigned to this Retailer returns ZERO ROWS, exactly as an
-- unknown id does.
create function public.get_my_retailer_campaign(
  p_campaign_id uuid
)
returns table (
  campaign_id            uuid,
  campaign_name          text,
  description            text,
  vendor_name            text,
  derived_state          text,
  campaign_status        text,
  starts_at              timestamptz,
  ends_at                timestamptz,
  timezone_name          text,
  performance_scope      text,
  product_scope          text,
  product_eligibility_resolution text,
  stacking_mode          text,
  reward_recipient_scope text,
  rule_type              text,
  metric_type            text,
  coins_per_unit         bigint,
  max_reward_coins       bigint,
  threshold_units        integer,
  reward_coins           bigint,
  eligible_product_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('CAMPAIGNS_VIEW_ASSIGNED');

  if v_retailer is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    c.id, c.name, c.description, vo.name,
    public.campaign_derived_state(c.status, cv.starts_at, cv.ends_at),
    c.status, cv.starts_at, cv.ends_at, cv.timezone_name,
    cv.performance_scope, cv.product_scope, cv.product_eligibility_resolution,
    cv.stacking_mode, cv.reward_recipient_scope,
    r.rule_type, r.metric_type, r.coins_per_unit, r.max_reward_coins,
    t.threshold_units, t.reward_coins,
    case
      when cv.product_scope = 'SELECTED_PRODUCTS' then (
        select count(*)::integer from public.campaign_eligible_products ep
        where ep.campaign_version_id = cv.id
          and ep.retailer_organization_id = v_retailer
      )
      else (
        -- LIVE_TEMPORAL: resolved from the ASSIGNMENT TIMELINE at the documented instant,
        -- not from current assignment status. An ended campaign therefore reports what was
        -- eligible when it ended rather than what happens to be assigned today.
        select count(*)::integer
        from public.vendor_retailer_eligible_products_at(
               v_retailer,
               c.vendor_organization_id,
               public.campaign_product_eligibility_as_of(cv.starts_at, cv.ends_at)) e
      )
    end
  from public.campaign_eligible_retailers er
  join public.campaign_versions cv on cv.id = er.campaign_version_id
  join public.campaigns c
    on c.id = cv.campaign_id and c.published_version_id = cv.id
  join public.organizations vo on vo.id = c.vendor_organization_id
  left join public.campaign_rules r
    on r.campaign_version_id = cv.id and r.sequence = 1
  left join public.campaign_rule_tiers t
    on t.campaign_rule_id = r.id and t.tier_number = 1
  where er.retailer_organization_id = v_retailer
    and c.id = p_campaign_id;
end;
$$;

revoke all     on function public.get_my_retailer_campaign(uuid) from public;
revoke execute on function public.get_my_retailer_campaign(uuid) from anon;
grant  execute on function public.get_my_retailer_campaign(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 22 — list_my_retailer_campaign_products(uuid)
-- ============================================================================
-- The products this campaign covers FOR THIS RETAILER.
--
-- SELECTED_PRODUCTS reads the frozen snapshot, so the list is exactly what was resolved
-- at publication and a later assignment change cannot alter it. ALL_ELIGIBLE_PRODUCTS
-- reads the live assignments, because that is what the phrase means — and both sides
-- must be live, matching list_retailer_assigned_products() so the two reads cannot
-- disagree about which products exist.
create function public.list_my_retailer_campaign_products(
  p_campaign_id uuid
)
returns table (
  product_id   uuid,
  product_code text,
  barcode      text,
  product_name text,
  brand        text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
  v_version  uuid;
  v_scope    text;
  v_vendor   uuid;
  -- The single documented instant this list is resolved at. See
  -- campaign_product_eligibility_as_of().
  v_as_of    timestamptz;
begin
  v_retailer := public.resolve_retailer_member_organization('CAMPAIGNS_VIEW_ASSIGNED');

  if v_retailer is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  -- Resolved through the snapshot, so an unassigned campaign yields nothing to read
  -- rather than a different error.
  select cv.id, cv.product_scope, c.vendor_organization_id,
         public.campaign_product_eligibility_as_of(cv.starts_at, cv.ends_at)
    into v_version, v_scope, v_vendor, v_as_of
  from public.campaign_eligible_retailers er
  join public.campaign_versions cv on cv.id = er.campaign_version_id
  join public.campaigns c
    on c.id = cv.campaign_id and c.published_version_id = cv.id
  where er.retailer_organization_id = v_retailer
    and c.id = p_campaign_id;

  if v_version is null then
    return;
  end if;

  if v_scope = 'SELECTED_PRODUCTS' then
    return query
    select vp.id, vp.product_code, vp.barcode, vp.product_name, vp.brand
    from public.campaign_eligible_products ep
    join public.vendor_products vp on vp.id = ep.vendor_product_id
    where ep.campaign_version_id = v_version
      and ep.retailer_organization_id = v_retailer
    order by vp.product_name, vp.product_code, vp.id;
  else
    -- LIVE_TEMPORAL: the assignment TIMELINE at the documented instant. Identical to the
    -- current assignment set while the campaign is still running, and correctly frozen to
    -- what was eligible at the end once it has ended.
    return query
    select vp.id, vp.product_code, vp.barcode, vp.product_name, vp.brand
    from public.vendor_retailer_eligible_products_at(v_retailer, v_vendor, v_as_of) e
    join public.vendor_products vp on vp.id = e.vendor_product_id
    order by vp.product_name, vp.product_code, vp.id;
  end if;
end;
$$;

revoke all     on function public.list_my_retailer_campaign_products(uuid) from public;
revoke execute on function public.list_my_retailer_campaign_products(uuid) from anon;
grant  execute on function public.list_my_retailer_campaign_products(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 23 — list_my_staff_campaigns()
-- ============================================================================
-- THE SALES STAFF CONTRACT THE FLUTTER CLIENT WILL CONSUME. No Web portal calls it:
-- there is no Sales Staff campaign surface on the Web in this milestone, and the
-- contract exists here because the backend is shared and a second client must not
-- reimplement the rule.
--
-- ACTIVE AND SCHEDULED ONLY, filtered on the derived state rather than on the stored
-- status, so an ended campaign disappears from a seller's list the moment its end passes
-- without any job having to sweep it.
create function public.list_my_staff_campaigns()
returns table (
  campaign_id            uuid,
  campaign_name          text,
  description            text,
  derived_state          text,
  starts_at              timestamptz,
  ends_at                timestamptz,
  timezone_name          text,
  performance_scope      text,
  product_scope          text,
  product_eligibility_resolution text,
  stacking_mode          text,
  reward_recipient_scope text,
  rule_type              text,
  metric_type            text,
  coins_per_unit         bigint,
  max_reward_coins       bigint,
  threshold_units        integer,
  reward_coins           bigint,
  eligible_product_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('STAFF_CAMPAIGNS_VIEW');

  if v_retailer is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    c.id, c.name, c.description,
    public.campaign_derived_state(c.status, cv.starts_at, cv.ends_at),
    cv.starts_at, cv.ends_at, cv.timezone_name,
    cv.performance_scope, cv.product_scope, cv.product_eligibility_resolution,
    cv.stacking_mode, cv.reward_recipient_scope,
    r.rule_type, r.metric_type, r.coins_per_unit, r.max_reward_coins,
    t.threshold_units, t.reward_coins,
    case
      when cv.product_scope = 'SELECTED_PRODUCTS' then (
        select count(*)::integer from public.campaign_eligible_products ep
        where ep.campaign_version_id = cv.id
          and ep.retailer_organization_id = v_retailer
      )
      else (
        -- LIVE_TEMPORAL: resolved from the ASSIGNMENT TIMELINE at the documented instant,
        -- not from current assignment status. An ended campaign therefore reports what was
        -- eligible when it ended rather than what happens to be assigned today.
        select count(*)::integer
        from public.vendor_retailer_eligible_products_at(
               v_retailer,
               c.vendor_organization_id,
               public.campaign_product_eligibility_as_of(cv.starts_at, cv.ends_at)) e
      )
    end
  from public.campaign_eligible_retailers er
  join public.campaign_versions cv on cv.id = er.campaign_version_id
  join public.campaigns c
    on c.id = cv.campaign_id and c.published_version_id = cv.id
  left join public.campaign_rules r
    on r.campaign_version_id = cv.id and r.sequence = 1
  left join public.campaign_rule_tiers t
    on t.campaign_rule_id = r.id and t.tier_number = 1
  where er.retailer_organization_id = v_retailer
    and public.campaign_derived_state(c.status, cv.starts_at, cv.ends_at)
        in ('ACTIVE', 'SCHEDULED')
  order by cv.starts_at, c.name, c.id;
end;
$$;

revoke all     on function public.list_my_staff_campaigns() from public;
revoke execute on function public.list_my_staff_campaigns() from anon;
grant  execute on function public.list_my_staff_campaigns() to authenticated;

-- ============================================================================
-- FUNCTION 24 — get_my_staff_campaign(uuid)
-- ============================================================================
-- Shape identical to list_my_staff_campaigns(), for the same reason function 21's is
-- identical to function 20's.
create function public.get_my_staff_campaign(
  p_campaign_id uuid
)
returns table (
  campaign_id            uuid,
  campaign_name          text,
  description            text,
  derived_state          text,
  starts_at              timestamptz,
  ends_at                timestamptz,
  timezone_name          text,
  performance_scope      text,
  product_scope          text,
  product_eligibility_resolution text,
  stacking_mode          text,
  reward_recipient_scope text,
  rule_type              text,
  metric_type            text,
  coins_per_unit         bigint,
  max_reward_coins       bigint,
  threshold_units        integer,
  reward_coins           bigint,
  eligible_product_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('STAFF_CAMPAIGNS_VIEW');

  if v_retailer is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    c.id, c.name, c.description,
    public.campaign_derived_state(c.status, cv.starts_at, cv.ends_at),
    cv.starts_at, cv.ends_at, cv.timezone_name,
    cv.performance_scope, cv.product_scope, cv.product_eligibility_resolution,
    cv.stacking_mode, cv.reward_recipient_scope,
    r.rule_type, r.metric_type, r.coins_per_unit, r.max_reward_coins,
    t.threshold_units, t.reward_coins,
    case
      when cv.product_scope = 'SELECTED_PRODUCTS' then (
        select count(*)::integer from public.campaign_eligible_products ep
        where ep.campaign_version_id = cv.id
          and ep.retailer_organization_id = v_retailer
      )
      else (
        -- LIVE_TEMPORAL: resolved from the ASSIGNMENT TIMELINE at the documented instant,
        -- not from current assignment status. An ended campaign therefore reports what was
        -- eligible when it ended rather than what happens to be assigned today.
        select count(*)::integer
        from public.vendor_retailer_eligible_products_at(
               v_retailer,
               c.vendor_organization_id,
               public.campaign_product_eligibility_as_of(cv.starts_at, cv.ends_at)) e
      )
    end
  from public.campaign_eligible_retailers er
  join public.campaign_versions cv on cv.id = er.campaign_version_id
  join public.campaigns c
    on c.id = cv.campaign_id and c.published_version_id = cv.id
  left join public.campaign_rules r
    on r.campaign_version_id = cv.id and r.sequence = 1
  left join public.campaign_rule_tiers t
    on t.campaign_rule_id = r.id and t.tier_number = 1
  where er.retailer_organization_id = v_retailer
    and c.id = p_campaign_id
    and public.campaign_derived_state(c.status, cv.starts_at, cv.ends_at)
        in ('ACTIVE', 'SCHEDULED');
end;
$$;

revoke all     on function public.get_my_staff_campaign(uuid) from public;
revoke execute on function public.get_my_staff_campaign(uuid) from anon;
grant  execute on function public.get_my_staff_campaign(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 25 — list_my_staff_campaign_products(uuid)
-- ============================================================================
-- The products a campaign covers, for the caller's own Retailer. Same resolution rule as
-- function 22, and the same ACTIVE/SCHEDULED restriction as the other two staff reads —
-- so a seller cannot enumerate the product scope of a campaign they are not currently
-- selling into.
create function public.list_my_staff_campaign_products(
  p_campaign_id uuid
)
returns table (
  product_id   uuid,
  product_code text,
  barcode      text,
  product_name text,
  brand        text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
  v_version  uuid;
  v_scope    text;
  v_vendor   uuid;
  -- The single documented instant this list is resolved at. See
  -- campaign_product_eligibility_as_of().
  v_as_of    timestamptz;
begin
  v_retailer := public.resolve_retailer_member_organization('STAFF_CAMPAIGNS_VIEW');

  if v_retailer is null then
    raise exception 'Not authorized to view campaigns'
      using errcode = 'insufficient_privilege';
  end if;

  select cv.id, cv.product_scope, c.vendor_organization_id,
         public.campaign_product_eligibility_as_of(cv.starts_at, cv.ends_at)
    into v_version, v_scope, v_vendor, v_as_of
  from public.campaign_eligible_retailers er
  join public.campaign_versions cv on cv.id = er.campaign_version_id
  join public.campaigns c
    on c.id = cv.campaign_id and c.published_version_id = cv.id
  where er.retailer_organization_id = v_retailer
    and c.id = p_campaign_id
    and public.campaign_derived_state(c.status, cv.starts_at, cv.ends_at)
        in ('ACTIVE', 'SCHEDULED');

  if v_version is null then
    return;
  end if;

  if v_scope = 'SELECTED_PRODUCTS' then
    return query
    select vp.id, vp.product_code, vp.barcode, vp.product_name, vp.brand
    from public.campaign_eligible_products ep
    join public.vendor_products vp on vp.id = ep.vendor_product_id
    where ep.campaign_version_id = v_version
      and ep.retailer_organization_id = v_retailer
    order by vp.product_name, vp.product_code, vp.id;
  else
    -- LIVE_TEMPORAL: the assignment TIMELINE at the documented instant. Identical to the
    -- current assignment set while the campaign is still running, and correctly frozen to
    -- what was eligible at the end once it has ended.
    return query
    select vp.id, vp.product_code, vp.barcode, vp.product_name, vp.brand
    from public.vendor_retailer_eligible_products_at(v_retailer, v_vendor, v_as_of) e
    join public.vendor_products vp on vp.id = e.vendor_product_id
    order by vp.product_name, vp.product_code, vp.id;
  end if;
end;
$$;

revoke all     on function public.list_my_staff_campaign_products(uuid) from public;
revoke execute on function public.list_my_staff_campaign_products(uuid) from anon;
grant  execute on function public.list_my_staff_campaign_products(uuid) to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- Three internal helpers and twenty-five granted functions. No table, column, constraint,
-- index, trigger, policy, role, permission or role-permission mapping is created, altered
-- or dropped here, no existing function is touched, and no table privilege is granted to
-- any browser role — all eleven campaign tables stay default-deny with zero policies.
-- service_role is granted none of the twenty-five: every one derives its authority from
-- auth.uid(), and a service-role path would let a campaign be published, paused or read
-- with no session at all.
--
-- Nothing in this file matches a receipt to a product, evaluates a rule, resolves an
-- exclusivity contest, computes progress, credits a coin, moves a balance, or records a
-- claim or a payout. The reward columns are read and returned as the OFFER a campaign
-- makes; what anyone has actually earned is a later milestone and is absent here by
-- design.
