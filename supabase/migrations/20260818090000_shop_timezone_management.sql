-- Migration: shop_timezone_management
-- Purpose: Makes public.retailer_shops.timezone_name WRITABLE, by an authorized Vendor
--          operator and by nobody else. It adds, and only adds:
--            1. The SHOP_TIMEZONE_MANAGE permission, mapped to VENDOR_SUPER_ADMIN alone.
--            2. public.set_retailer_shop_timezone(uuid, text) — the one audited door.
--          Plus its two audit events and its privilege posture.
--
-- WHY THIS EXISTS
--   Migration 20260817210000 added retailer_shops.timezone_name, its Region/City shape
--   CHECK and its pg_timezone_names validation trigger, and made
--   public.resolve_sale_instant refuse (55000) for a shop whose zone is unresolved. It
--   deliberately added NO writer: "Phase 1 must add a Vendor-side setter alongside the
--   reviewer workflow, and until it does the column can only be populated by the table
--   owner." This is that setter, and it is deliberately the FIRST piece of Phase 1 —
--   every later verification milestone is dead on arrival while every shop's zone is
--   null.
--
-- ============================================================================
-- WHY VENDOR_SUPER_ADMIN ALONE, AND NOT THE RETAILER OWNER
-- ============================================================================
-- A shop's time zone decides which campaign window a printed sale falls into, so it is
-- a financially load-bearing setting rather than an address detail. Three reasons put
-- it with the Vendor:
--
--   1. INCENTIVE. The Retailer is the BENEFICIARY of the rewards a sale earns. Letting
--      the beneficiary set the clock that decides whether a sale lands inside a campaign
--      is the same defect as letting a Sales Staff member confirm and verify their own
--      receipt. It is the reason receipt verification is going to CLAIM_REVIEWER, and
--      the same reasoning applies here.
--   2. PRECEDENT. Shops are already created Vendor-side by add_vendor_retailer_shop
--      (migration 20260718214858), which is addressed by a vendor_retailers relationship
--      id. The Retailer Owner holds RETAILER_SHOPS_READ — read, never write — and a
--      write here would be the first Retailer-side shop mutation in this schema.
--   3. SCALE. There are four shops. There is no operational pressure to delegate.
--
-- CLAIM_REVIEWER IS DELIBERATELY EXCLUDED TOO, and that is not an oversight. A reviewer
-- who could fix the clock could also move a sale across a campaign boundary while
-- verifying it — the two capabilities must stay in different hands. A reviewer reports
-- an unresolved or wrong zone; a Vendor operator sets it.
--
-- ============================================================================
-- WHY NO TIMEZONE HISTORY TABLE
-- ============================================================================
-- The two Phase 0 timelines (campaign status, product status) exist because those facts
-- are read AS OF a past instant. A shop's time zone is not: the future verification row
-- will FREEZE sale_at, sale_timezone_name and sale_time_precision at the moment it is
-- written, so a later correction here cannot reach back and move an already-verified
-- sale. What a correction affects is FUTURE resolutions, plus any already-verified sale
-- discovered to have used the wrong zone — and the answer to that is a verification
-- revision, not a retroactive re-read.
--
-- So the audit trail is the history: SHOP_TIMEZONE_CONFIGURED and SHOP_TIMEZONE_CHANGED
-- record every write, with the before and after zone, in the same transaction as the
-- change. A zone name is not personal data, so recording both is safe and makes a
-- wrong-zone incident fully reconstructable.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--   No Claim Reviewer permission, role mapping, table, RPC or route.
--   No receipt verification, verified sale, verified sale item or product matching.
--   No reward, contribution, award, coin, balance, claim or payout object.
--   No change to add_vendor_retailer_shop's signature — adding a timezone argument
--   would alter a shipped contract, and is a separate, later decision.
--   No change to list_vendor_retailer_shops, which the Flutter Vendor experience
--   consumes; widening its `returns table` would require DROP + CREATE and could break
--   that client's parser.
--   No second definition of "a valid time zone". The shape CHECK and
--   retailer_shops_assert_timezone() added by 20260817210000 remain the sole authority;
--   this function validates only that a value was supplied at all.
--   No RLS policy, and no table privilege granted, changed or revoked anywhere.
--
-- Idempotency posture: the permission upserts on `code` and the mapping is
--   ON CONFLICT DO NOTHING, matching migrations 6, 11, 12 and 20260718214858 exactly.
--   The function is a plain CREATE — a conflicting existing object FAILS the migration.
--   No fixed UUIDs. No dynamic SQL. All identifiers are <= 63 bytes. Every reference is
--   schema-qualified because the function runs with an EMPTY search_path.
--
-- Dependencies: 20260716125559 (permissions, role_permissions), 20260716130351
--   (audit_logs), 20260716131104 (has_organization_permission), 20260717083515
--   (get_vendor_super_admin_context), 20260717094520 (vendor_retailers,
--   retailer_shops), 20260817210000 (timezone_name, its CHECK and its validator).

-- ============================================================================
-- PART 1 — the SHOP_TIMEZONE_MANAGE permission
-- ============================================================================
-- A NEW code rather than a reuse of RETAILER_SHOPS_CREATE. Creating a shop and setting
-- the clock that prices its sales are different decisions with different blast radii,
-- and this project splits a capability every time that is true — RECEIPT_PRODUCTS_READ
-- was added rather than widening RETAILER_PRODUCTS_READ, and STAFF_CAMPAIGNS_VIEW rather
-- than widening CAMPAIGNS_VIEW_ASSIGNED. Keeping them separate means the financial clock
-- can be revoked without also revoking shop administration.
insert into public.permissions (code, name, description, module)
values
  (
    'SHOP_TIMEZONE_MANAGE',
    'Manage Retailer Shop Time Zones',
    'Configure the IANA time zone of a Vendor-managed Retailer shop, which determines the instant a printed sale time refers to.',
    'RETAILERS'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- Precondition: the target role must exist. Without this, a missing role would make the
-- mapping INSERT write zero rows, the migration would report success with the permission
-- assigned to nobody, and a correctly configured Super Admin would be refused with
-- nothing to explain why. Fail loudly instead. Reads one row, writes nothing.
do $$
begin
  if not exists (
    select 1
    from public.roles r
    where r.code = 'VENDOR_SUPER_ADMIN'
  ) then
    raise exception 'Seed precondition failed: role VENDOR_SUPER_ADMIN does not exist, so SHOP_TIMEZONE_MANAGE cannot be assigned';
  end if;
end;
$$;

-- Role -> permission mapping. VENDOR_SUPER_ADMIN and ONLY it: the WHERE clause names
-- exactly one role code, so CLAIM_REVIEWER, FINANCE_ADMIN, RETAILER_OWNER,
-- RETAILER_MANAGER and SALES_STAFF each receive nothing here and cannot acquire this
-- capability without their own deliberate, reviewable migration.
--
-- Ids resolved by joining on code rather than written literally. Both codes are unique,
-- so the cross join yields precisely 1 x 1 = 1 row. ON CONFLICT DO NOTHING targets the
-- composite primary key, so a re-run is a no-op and no mapping is ever deleted.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN'
  and p.code = 'SHOP_TIMEZONE_MANAGE'
on conflict (role_id, permission_id) do nothing;

-- ============================================================================
-- PART 2 — set_retailer_shop_timezone()
-- ============================================================================
-- ONE audited door. SECURITY DEFINER is what makes the write possible at all:
-- retailer_shops grants `authenticated` SELECT and nothing else, and audit_logs grants
-- it nothing whatsoever and is additionally append-only since 20260816090000. The
-- function therefore carries the entire authorization decision itself, before it writes.
--
-- THE SIGNATURE IS THE SECURITY BOUNDARY. It takes a shop id and a zone, and nothing
-- else. There is no Vendor organization id, no Retailer organization id, no relationship
-- id, no actor or profile id, no role code, no permission code and no resolved UTC
-- offset — because every one of those is a value the caller controls, and a
-- caller-controlled tenant id is exactly how a cross-tenant write happens.
--
-- THE SHOP ID IS AN ADDRESS, NEVER AUTHORIZATION. It says WHICH of the caller's own
-- shops to configure. Ownership is proved separately, by joining the shop through
-- vendor_retailers to the Vendor this function derived from auth.uid(). A shop id
-- belonging to another Vendor matches zero rows there, and is refused with the SAME
-- byte-identical exception as an id that does not exist at all — so this function cannot
-- be swept to discover which shop ids are real.
--
-- WHY IT RETURNS THE STORED VALUE. The caller learns what is now true rather than what
-- they asked for. The two differ in exactly the case that matters: a no-op, where
-- `changed` is false and the returned zone is the one that was already there.
create function public.set_retailer_shop_timezone(
  p_retailer_shop_id uuid,
  p_timezone_name    text
)
returns table (
  shop_id       uuid,
  timezone_name text,
  changed       boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_vendor_org_id    uuid;
  v_shop_id          uuid;
  v_current_timezone text;
  v_action           text;
  v_metadata         jsonb;
begin
  -- --------------------------------------------------------------------------
  -- 1. Authorization — identity from the JWT, Vendor derived, never supplied
  -- --------------------------------------------------------------------------
  v_actor_profile_id := auth.uid();

  if v_actor_profile_id is null then
    raise exception 'Not authorized to configure this shop time zone'
      using errcode = 'insufficient_privilege';
  end if;

  -- Resolved through the existing context function rather than by reimplementing its
  -- joins, exactly as add_vendor_retailer_shop does. Calling it is what guarantees the
  -- chain here is the SAME chain the application shell authorizes against — ACTIVE
  -- profile, ACTIVE membership, ACTIVE VENDOR organization, ACTIVE VENDOR_SUPER_ADMIN
  -- role — and that it cannot drift from it later. It takes no arguments and filters on
  -- auth.uid() internally, so this call cannot nominate a Vendor.
  --
  -- `order by organization_id limit 1` reproduces the application's own deterministic
  -- tie-break for a caller holding the role in more than one Vendor organization: the
  -- same Vendor on every request, never planner-dependent.
  select ctx.organization_id
    into v_vendor_org_id
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor_org_id is null then
    raise exception 'Not authorized to configure this shop time zone'
      using errcode = 'insufficient_privilege';
  end if;

  -- Holding the role is not by itself permission to act; the mapping seeded in PART 1
  -- is. Checking the PERMISSION rather than the role keeps this consistent with every
  -- policy and RPC in this project: a future role gains this capability by acquiring a
  -- role_permissions row, not by an edit to this function. No role code appears below.
  if not public.has_organization_permission(v_vendor_org_id, 'SHOP_TIMEZONE_MANAGE') then
    raise exception 'Not authorized to configure this shop time zone'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Input
  -- --------------------------------------------------------------------------
  -- A NULL zone is refused rather than treated as "clear it". Unsetting a configured
  -- shop would silently re-block every future verification for it, and nothing in the
  -- product asks for that; if it is ever wanted it should be its own named operation.
  --
  -- The value is NOT trimmed, upper-cased or otherwise normalized here. The Phase 0
  -- contract requires the stored form to be exactly the IANA identifier — the shape
  -- CHECK asserts `timezone_name = btrim(timezone_name)` and the trigger looks the name
  -- up in pg_timezone_names, which is case-sensitive. Silently repairing " Asia/Dubai "
  -- would make this function a second, more permissive definition of what a valid zone
  -- is, and the two would eventually disagree. An untrimmed value is refused by the
  -- CHECK, which is the correct authority.
  if p_timezone_name is null then
    raise exception 'A shop time zone is required'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Ownership — the shop must belong to the DERIVED Vendor
  -- --------------------------------------------------------------------------
  -- The join is the whole security boundary for the caller-supplied id: `s.id` says
  -- WHICH row, and `vr.vendor_organization_id = v_vendor_org_id` says it must be one of
  -- the caller's own. The Vendor side is never an argument, so a foreign shop matches
  -- zero rows here.
  --
  -- FOR UPDATE OF s holds the shop row for the rest of the transaction, so two
  -- concurrent configurations of one shop serialize and the second reads the first's
  -- result rather than racing it. It is applied to `s` alone — locking vendor_retailers
  -- or organizations would block unrelated Retailer administration for no benefit.
  --
  -- organizations is joined with organization_type = 'RETAILER' as belt and braces over
  -- the BEFORE-row trigger that already forbids a non-RETAILER occupying
  -- vendor_retailers.retailer_organization_id.
  select s.id, s.timezone_name
    into v_shop_id, v_current_timezone
  from public.retailer_shops s
  join public.organizations o
    on o.id = s.retailer_organization_id
   and o.organization_type = 'RETAILER'
  join public.vendor_retailers vr
    on vr.retailer_organization_id = s.retailer_organization_id
   and vr.vendor_organization_id = v_vendor_org_id
  where s.id = p_retailer_shop_id
  for update of s;

  -- ONE refusal for four different situations: the shop does not exist, it belongs to
  -- another Vendor, its Retailer is not linked to this Vendor, or the id is simply
  -- unknown. They are byte-identical on purpose — distinguishing them would let a caller
  -- probe another Vendor's estate one id at a time. It is also the same message the
  -- authorization failures above raise, so "you may not" and "no such shop" are
  -- indistinguishable from outside.
  if v_shop_id is null then
    raise exception 'Not authorized to configure this shop time zone'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. The no-op
  -- --------------------------------------------------------------------------
  -- Writing the same value again is not a change. Returning early keeps two promises:
  -- the shop's updated_at is not touched, so an untouched row does not look edited; and
  -- NO AUDIT ROW IS WRITTEN, so the audit trail records changes rather than attempts. A
  -- caller that resubmits an unchanged form therefore leaves no trace, which is what
  -- makes every SHOP_TIMEZONE_CHANGED row meaningful.
  --
  -- `is not distinct from` rather than `=` so the NULL-to-NULL case is handled too,
  -- though it is unreachable: a null p_timezone_name was refused in step 2.
  if v_current_timezone is not distinct from p_timezone_name then
    return query select v_shop_id, v_current_timezone, false;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 5. The write
  -- --------------------------------------------------------------------------
  -- VALIDATION HAPPENS HERE, IN THE CONSTRAINT AND THE TRIGGER, NOT ABOVE.
  -- retailer_shops_timezone_name_shape refuses a fixed offset, a bare abbreviation, an
  -- Etc/* entry, an untrimmed value and anything that is not Region/City;
  -- retailer_shops_assert_timezone() then refuses a well-shaped name that pg_timezone_names
  -- does not know. Both raise 23514, which is what a caller sees for an invalid zone.
  -- Restating either rule here would create a second definition free to drift.
  update public.retailer_shops s
  set timezone_name = p_timezone_name
  where s.id = v_shop_id;

  -- --------------------------------------------------------------------------
  -- 6. The audit row — same transaction as the change
  -- --------------------------------------------------------------------------
  -- Two actions rather than one, because the two events answer different questions.
  -- CONFIGURED is a shop becoming usable for verification for the first time; CHANGED is
  -- a correction to a shop that was already usable, and is the one that matters when a
  -- sale is later found to have been resolved in the wrong zone.
  --
  -- METADATA CARRIES ZONE NAMES AND NOTHING ELSE. No shop name, no Retailer name, no
  -- city or address, no staff or user identity, no email, no receipt data. A zone name
  -- is not personal data; everything else here would be. The shop is identified by
  -- entity_id, and the actor and organization travel in their own columns, per the
  -- convention every audited operation in this schema follows.
  if v_current_timezone is null then
    v_action   := 'SHOP_TIMEZONE_CONFIGURED';
    v_metadata := jsonb_build_object('timezone_name', p_timezone_name);
  else
    v_action   := 'SHOP_TIMEZONE_CHANGED';
    v_metadata := jsonb_build_object(
      'timezone_before', v_current_timezone,
      'timezone_after',  p_timezone_name
    );
  end if;

  insert into public.audit_logs (
    organization_id,
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  values (
    v_vendor_org_id,
    v_actor_profile_id,
    v_action,
    'RETAILER_SHOP',
    v_shop_id::text,
    v_metadata
  );

  -- The AUTHORITATIVE stored value, re-read rather than echoed, so the caller is told
  -- what the database now holds rather than what it was asked to hold.
  return query
  select s.id, s.timezone_name, true
  from public.retailer_shops s
  where s.id = v_shop_id;
end;
$$;

-- ---- Privileges --------------------------------------------------------------
-- `revoke all from public` is what actually removes the implicit EXECUTE every function
-- carries; the anon revoke is explicit belt and braces. Only `authenticated` may call
-- it, and the function then decides for itself whether the caller may act.
--
-- service_role is deliberately NOT granted. Every legitimate path here derives its
-- authority from auth.uid(), and a service-role path would be a way to change a shop's
-- financial clock with no session and no actor to record in the audit row.
revoke all     on function public.set_retailer_shop_timezone(uuid, text) from public;
revoke execute on function public.set_retailer_shop_timezone(uuid, text) from anon;
grant  execute on function public.set_retailer_shop_timezone(uuid, text) to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One permission, one role mapping, one function.
--
-- No table, column, constraint, index, trigger or policy is created, altered or dropped.
-- No table privilege is granted, changed or revoked. retailer_shops keeps its existing
-- authenticated SELECT and its existing read policy, and gains no write privilege for
-- any browser role — the RPC is the only door.
--
-- Nothing here verifies a receipt, matches a product, evaluates a campaign or credits a
-- coin, and no hosted shop is configured by this migration: the four existing shops stay
-- unresolved until an operator sets each one deliberately through this function.
