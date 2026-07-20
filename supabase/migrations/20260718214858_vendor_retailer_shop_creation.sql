-- Migration: vendor_retailer_shop_creation
-- Purpose: The second WRITE path in the Retailer domain. Two related parts:
--            1. The RETAILER_SHOPS_CREATE permission, seeded and mapped to
--               VENDOR_SUPER_ADMIN.
--            2. public.add_vendor_retailer_shop(), an atomic SECURITY DEFINER RPC
--               that adds ONE shop to an EXISTING Vendor-managed Retailer, and
--               writes the audit record, in one transaction.
--
-- Why a separate permission from RETAILERS_CREATE:
--   RETAILERS_CREATE mints tenants — a new Retailer organization, a new managing
--   relationship, and that Retailer's first location. Adding a shop to a Retailer
--   the Vendor already manages is a smaller act against an existing tenant. They
--   are plausibly held by different roles: a future RETAILER_MANAGER should be
--   able to open a new branch without being able to create Retailer companies.
--   Folding the two together would make that split impossible later without
--   re-cutting a permission that rows already depend on. This follows migration
--   12's own reasoning for splitting create from read.
--
-- Why the RPC accepts ONE id and no others:
--   p_relationship_id is an ADDRESS, not authorization. It says WHICH of the
--   caller's own Retailers to add a shop to; it can never say WHO the caller is,
--   WHICH Vendor they act for, or WHICH Retailer organization is written. There is
--   no vendor organization id, retailer organization id, actor/user/profile id,
--   shop id, role code, permission code, or status parameter in the signature,
--   because any such parameter is a value the caller controls — and a
--   caller-controlled tenant id is exactly how a cross-tenant write happens.
--
--   The relationship id is re-verified against the internally derived Vendor
--   before it is used for anything, and the Retailer organization id is then read
--   OUT of that verified row. A relationship id belonging to another Vendor
--   therefore selects nothing at all.
--
-- The authorization chain (evaluated inside the function, in this order):
--   auth.uid()
--     -> public.get_vendor_super_admin_context()
--          (ACTIVE profile -> ACTIVE membership -> ACTIVE organization of
--           organization_type = 'VENDOR' -> ACTIVE VENDOR_SUPER_ADMIN role)
--     -> first row by organization id  (the same deterministic tie-break the
--        application context and migration 12 already use)
--     -> public.has_organization_permission(<that vendor>, 'RETAILER_SHOPS_CREATE')
--     -> the relationship row, matched on BOTH its id AND that vendor id
--   Every one of those steps raises ONE byte-identical message. A caller cannot
--   tell "you are not a Vendor Super Admin" from "you lack RETAILER_SHOPS_CREATE"
--   from "that relationship belongs to someone else" from "that relationship does
--   not exist". The function is deliberately not an existence oracle: a caller who
--   may not read a relationship must not be able to learn, by sweeping ids,
--   whether one is there.
--
-- Why direct browser writes remain blocked:
--   Nothing in this migration grants any table privilege, and no RLS policy is
--   added, altered, or dropped. retailer_shops and audit_logs keep their
--   default-deny write posture — `authenticated` holds SELECT on retailer_shops
--   (migration 9) and nothing at all on audit_logs. The ONLY way an authenticated
--   client can write either row is by calling this function, which authorizes
--   first and writes both rows or neither. One audited door, no windows.
--
-- Scope notes:
--   * No table, column, constraint, index, trigger, policy, or existing function
--     is created or altered. This migration adds one permission row, one mapping
--     row, and one function.
--   * retailer_shops_org_code_unique_idx (migration 8) is NOT modified, replaced,
--     or dropped. It remains the final authority on shop-code uniqueness.
--   * No existing shop, Retailer, relationship, or audit row is read for
--     modification, updated, or deleted anywhere in this migration.
--   * No earlier migration is modified.
--
-- Dependencies: migration 1 (organizations, profiles), 2 (roles, permissions,
--   role_permissions), 3 (audit_logs), 4 (has_organization_permission),
--   6 (seeded VENDOR_SUPER_ADMIN), 7 (get_vendor_super_admin_context),
--   8 (vendor_retailers, retailer_shops and their constraints/indexes/triggers).

-- ============================================================================
-- PART 1 — RETAILER_SHOPS_CREATE permission
-- ============================================================================

-- Idempotency: this statement upserts on permissions.code (the unique constraint
-- migration 2 established), matching migrations 6, 11, and 12 exactly. Re-running
-- the migration refreshes only the human-readable catalogue fields and
-- updated_at, and leaves `id` untouched — so the role_permissions row created
-- below, and any future FK pointing at this permission, survives a re-run intact.
-- No fixed UUIDs; the id comes from the table's own default. Nothing is deleted.
insert into public.permissions (code, name, description, module)
values
  (
    'RETAILER_SHOPS_CREATE',
    'Create Retailer Shops',
    'Create shop locations for Vendor-managed Retailer organizations.',
    'RETAILERS'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- Precondition: the target role must exist.
-- The mapping below resolves its role by code. If VENDOR_SUPER_ADMIN were
-- missing, that SELECT would return no rows, the INSERT would write nothing, and
-- the migration would report success with RETAILER_SHOPS_CREATE assigned to
-- nobody — fail-closed, but silently. Adding a shop would then raise "not
-- authorized" for a correctly configured Super Admin and nothing would explain
-- why. This raises instead. It reads one row and writes nothing.
do $$
begin
  if not exists (
    select 1
    from public.roles r
    where r.code = 'VENDOR_SUPER_ADMIN'
  ) then
    raise exception 'Seed precondition failed: role VENDOR_SUPER_ADMIN does not exist, so RETAILER_SHOPS_CREATE cannot be assigned';
  end if;
end;
$$;

-- Role -> permission mapping. RETAILER_SHOPS_CREATE goes to VENDOR_SUPER_ADMIN
-- and only to it: the WHERE clause names exactly one role code, so no other
-- existing or future role receives it without its own deliberate migration.
--
-- Ids are resolved by joining on code rather than written literally, keeping this
-- independent of generated UUIDs. Both codes are unique, so the cross join yields
-- precisely 1 x 1 = 1 row. ON CONFLICT DO NOTHING targets the composite primary
-- key (role_id, permission_id) — a re-run is a no-op and an existing mapping is
-- left exactly as it is rather than rewritten. No mapping is ever deleted here.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN'
  and p.code = 'RETAILER_SHOPS_CREATE'
on conflict (role_id, permission_id) do nothing;

-- ============================================================================
-- PART 2 — add_vendor_retailer_shop()
-- ============================================================================
-- Returns void. The generated shop UUID is deliberately NOT returned: the caller
-- did not choose it, it does not need it (the page it returns to is addressed by
-- the relationship id it already holds), and every subsequent read of that row
-- already goes through retailer_shops_select_vendor_authorized. Returning an
-- internal id for convenience would hand the browser an identifier whose only use
-- is addressing the row directly. The id is captured internally for one purpose —
-- the audit entity_id — and never leaves the function.
--
-- SECURITY DEFINER is what makes the two inserts possible at all: retailer_shops
-- is RLS default-deny for writes with only SELECT granted, and audit_logs has RLS
-- enabled with zero policies and no grant whatsoever. The function therefore
-- carries the entire authorization decision itself, before it writes anything.
--
-- No dynamic SQL anywhere, every reference fully schema-qualified, and
-- search_path = '' — so nothing in this body can be resolved from an
-- attacker-controlled schema.
create function public.add_vendor_retailer_shop(
  p_relationship_id uuid,
  p_shop_name       text,
  p_shop_code       text default null,
  p_shop_city       text default null,
  p_country_code    text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id    uuid;
  v_vendor_org_id       uuid;
  v_retailer_org_id     uuid;
  v_retailer_name       text;
  v_retailer_status     text;
  v_relationship_status text;
  v_shop_id             uuid;
  v_shop_name           text;
  v_shop_code           text;
  v_shop_city           text;
  v_country_code        text;
begin
  -- --------------------------------------------------------------------------
  -- 1. Authorization
  -- --------------------------------------------------------------------------
  -- Identity comes from the JWT and nowhere else.
  v_actor_profile_id := auth.uid();

  if v_actor_profile_id is null then
    raise exception 'Not authorized to add shops for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  -- Resolve the Vendor through the existing context function rather than
  -- reimplementing its joins. Calling it is what guarantees the chain here is the
  -- SAME chain the application shell and migration 12 authorize against —
  -- profile, membership, organization type and status, and the ACTIVE
  -- VENDOR_SUPER_ADMIN role — and that it cannot drift from them later. That
  -- function takes no arguments and filters on auth.uid() internally, so this
  -- call cannot nominate a vendor either.
  --
  -- `order by organization_id limit 1` reproduces the application's own
  -- deterministic tie-break for a caller who holds the role in more than one
  -- Vendor organization: the same Vendor on every request, never planner-dependent.
  select ctx.organization_id
    into v_vendor_org_id
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  -- Fail closed: no qualifying context means no Vendor, and no Vendor means no
  -- write. Every check below is evaluated against the id resolved here, so there
  -- is no window in which an unresolved vendor reaches a lookup or an insert.
  if v_vendor_org_id is null then
    raise exception 'Not authorized to add shops for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  -- Holding VENDOR_SUPER_ADMIN is not by itself permission to create shops; the
  -- permission mapping seeded in Part 1 is. Checking the permission (rather than
  -- the role) keeps this consistent with every RLS policy in the project:
  -- authorization is permission-based end to end, so a future RETAILER_MANAGER
  -- needs a role_permissions row, not an edit to this function.
  if not public.has_organization_permission(v_vendor_org_id, 'RETAILER_SHOPS_CREATE') then
    raise exception 'Not authorized to add shops for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Ownership — the relationship must belong to the DERIVED Vendor
  -- --------------------------------------------------------------------------
  -- The two-column filter is the whole security boundary for the caller-supplied
  -- id: `vr.id = p_relationship_id` says WHICH row, and
  -- `vr.vendor_organization_id = v_vendor_org_id` says it must be one of the
  -- caller's own. The vendor side is never an argument, so a relationship id
  -- belonging to another Vendor matches zero rows here and can select nothing.
  --
  -- The Retailer organization id is read OUT of this verified row and is the only
  -- source of it anywhere in this function. It is never supplied and never
  -- guessed. The organization_type = 'RETAILER' join condition is belt and braces
  -- over migration 8's BEFORE-row trigger, which already forbids a non-RETAILER
  -- from occupying vendor_retailers.retailer_organization_id; stating it here
  -- keeps this correct even if that trigger were ever dropped.
  --
  -- The statuses are read now and gated below rather than filtered in the WHERE
  -- clause. Filtering them here would collapse "not yours / does not exist" and
  -- "yours but suspended" into one outcome, and those deserve different answers:
  -- the first must stay opaque, the second is something the caller can see on
  -- their own Retailer page and can act on.
  select vr.retailer_organization_id, vr.status, o.status, o.name
    into v_retailer_org_id, v_relationship_status, v_retailer_status, v_retailer_name
  from public.vendor_retailers vr
  join public.organizations o
    on o.id = vr.retailer_organization_id
  where vr.id = p_relationship_id
    and vr.vendor_organization_id = v_vendor_org_id
    and o.organization_type = 'RETAILER';

  -- The SAME message and SQLSTATE as the three authorization raises above, and
  -- deliberately so. A null p_relationship_id, a malformed-but-well-typed id that
  -- names nothing, an id owned by a different Vendor, and an id whose
  -- organization is somehow not a RETAILER all land here and are reported
  -- identically to "you are not authorized". Distinguishing them would let a
  -- caller confirm that a relationship they may not touch nevertheless exists,
  -- and by sweeping ids, roughly how many there are. "I will not tell you whether
  -- that exists" is the only safe answer, so it is the only answer given.
  if v_retailer_org_id is null then
    raise exception 'Not authorized to add shops for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Active write gate
  -- --------------------------------------------------------------------------
  -- Migration 10 anticipated exactly this: "Operational WRITES will need a
  -- stricter, active-only rule (a vendor should not edit a retailer it has
  -- suspended). That is a separate decision and belongs with the write path."
  -- This is that write path. READS deliberately remain unfiltered by status — a
  -- suspended Retailer must stay visible and reviewable — but a Vendor that has
  -- paused or ended a relationship must not be able to keep building it out.
  --
  -- These two messages are specific rather than generic, and that is safe: they
  -- are reachable only AFTER ownership has been proven, so the caller already
  -- manages this Retailer and can already see both statuses on its detail page.
  -- Nothing is disclosed that the caller did not already have. Telling them the
  -- real reason is what lets them fix it; the generic message would strand them.
  --
  -- Both statuses are conditions, never parameters. There is no status argument
  -- in the signature, so a caller cannot assert its way past this gate.
  if v_relationship_status <> 'ACTIVE' then
    raise exception 'This Retailer relationship is not active'
      using errcode = 'check_violation';
  end if;

  if v_retailer_status <> 'ACTIVE' then
    raise exception 'This Retailer organization is not active'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. Input normalization and validation
  -- --------------------------------------------------------------------------
  -- Every text input is trimmed; optional fields that trim to empty become NULL,
  -- so '' and '   ' are stored as "absent" rather than as a blank string that
  -- would satisfy a nullable column while meaning nothing. The country code is
  -- upper-cased, because the stored form is canonical and 'ae' and 'AE' are the
  -- same country.
  --
  -- The shop code is trimmed but NOT upper-cased. A shop code is the Retailer's
  -- own label and its case is theirs to choose; migration 8's unique index
  -- normalizes case for COMPARISON (lower(code)) without rewriting what is
  -- stored, and this matches that. Trimming closes the gap migration 8 explicitly
  -- left open — "this normalizes case, not whitespace ... trimming on write
  -- belongs in the module that eventually creates shops" — which is this one.
  -- Existing rows are neither read for modification nor backfilled.
  --
  -- Nothing is truncated. An over-long country code is REJECTED, not silently
  -- shortened — quietly turning 'ARE' into 'AR' would invent data the caller
  -- never supplied. The rule below is the same one
  -- retailer_shops_country_code_format enforces; validating here converts a raw
  -- constraint violation into a clear message without weakening or duplicating
  -- the constraint, which still has the final say.
  --
  -- Validation runs AFTER authorization and ownership, deliberately: an
  -- unauthorized caller must not learn whether their input would have been valid.
  v_shop_name    := btrim(p_shop_name);
  v_shop_code    := nullif(btrim(p_shop_code), '');
  v_shop_city    := nullif(btrim(p_shop_city), '');
  v_country_code := upper(nullif(btrim(p_country_code), ''));

  if v_shop_name is null or v_shop_name = '' then
    raise exception 'Shop name is required'
      using errcode = 'check_violation';
  end if;

  -- COLLATE "C" is load-bearing, not decorative: PostgreSQL evaluates regex
  -- bracket ranges like [A-Z] according to the database collation, so under a
  -- locale-aware collation the range can admit characters outside ASCII. Pinning
  -- the operand to the C collation makes [A-Z] mean exactly the 26 ASCII letters
  -- on every host. This matches retailer_shops_country_code_format from
  -- migration 8 and the equivalent check in migration 12.
  if v_country_code is not null
     and v_country_code collate "C" !~ '^[A-Z]{2}$' then
    raise exception 'Country code must be exactly two letters'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. Duplicate shop code
  -- --------------------------------------------------------------------------
  -- Scoped to the VERIFIED Retailer and compared case-insensitively, matching
  -- retailer_shops_org_code_unique_idx exactly: one Retailer cannot hold both
  -- 'DXB01' and 'dxb01', different Retailers may reuse a code freely, and any
  -- number of shops may have no code at all (the check is skipped entirely when
  -- the normalized code is null, exactly as the partial index excludes those
  -- rows).
  --
  -- This pre-check exists for ONE reason: to raise a predictable SQLSTATE. The
  -- application maps 23505 to a field-level error on the shop code input, so an
  -- admin is told which field to fix instead of receiving a generic failure. It
  -- is NOT the enforcement mechanism and must never be mistaken for one — between
  -- this SELECT and the INSERT below there is a window in which a concurrent
  -- transaction can insert the same code, and closing that window is the unique
  -- INDEX's job. That index is untouched by this migration and remains the final
  -- authority; a race that slips past this check still fails there, with the same
  -- SQLSTATE, and still rolls the whole call back.
  --
  -- The message names the RULE that was broken and nothing else: no constraint
  -- name, no index name, no shop id, no Retailer id, no SQL text. An error string
  -- is not a safe place to describe rows or schema.
  if v_shop_code is not null and exists (
    select 1
    from public.retailer_shops s
    where s.retailer_organization_id = v_retailer_org_id
      and lower(s.code) = lower(v_shop_code)
  ) then
    raise exception 'A shop with this code already exists for this Retailer'
      using errcode = 'unique_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 6. Atomic writes
  -- --------------------------------------------------------------------------
  -- Both inserts happen inside this one function call, which PostgreSQL runs
  -- inside a single statement's transaction context. There is no BEGIN/COMMIT
  -- here, no autonomous transaction, no dblink, and no EXCEPTION handler — so any
  -- failure at any point (validation, authorization, the active gate, a check
  -- constraint, the organization-type trigger on retailer_shops, the shop code
  -- unique index, the audit insert) aborts the whole call and rolls back
  -- everything already written by it. Partial state is therefore impossible by
  -- construction rather than by cleanup code, which is why no cleanup code
  -- exists. Exceptions propagate to the caller untouched; nothing is swallowed.

  -- 6a. The shop. retailer_organization_id comes from the verified relationship
  -- row and from nowhere else. status is written explicitly rather than relying
  -- on the column default, so this function's behaviour does not change if that
  -- default ever does. No address_line1/2, region, or postal_code is written:
  -- this function takes no input for them, and inventing values would be worse
  -- than leaving the nullable columns absent.
  insert into public.retailer_shops (
    retailer_organization_id,
    name,
    code,
    city,
    country_code,
    status
  )
  values (
    v_retailer_org_id,
    v_shop_name,
    v_shop_code,
    v_shop_city,
    v_country_code,
    'ACTIVE'
  )
  returning id into v_shop_id;

  -- 6b. The audit record, written in the same transaction as the row it
  -- describes. An audit row that can outlive a rolled-back write, or be lost
  -- while the write survives, is worse than none — both are silent lies about
  -- what happened. Being in-line here makes the log and the fact inseparable.
  --
  -- Naming: `action` is RETAILER_SHOP_ADDED, past tense, describing what occurred
  -- rather than the RPC that did it, so the log stays readable if the entry point
  -- is ever renamed or replaced. `entity_type` is RETAILER_SHOP — the shop is the
  -- subject of this event, unlike migration 12's RETAILER_ORGANIZATION, where the
  -- shop was a consequence of onboarding a tenant. organization_id is the
  -- VENDOR's, matching the audit convention that the organization column names
  -- the tenant whose activity feed the entry belongs in: the Vendor performed
  -- this action.
  --
  -- entity_id is the ONLY place the new shop's id appears. It is the audit
  -- table's designated column for exactly that, it is never selected by the audit
  -- reader (lib/audit/vendor-audit-logs.ts reads neither entity_id nor metadata),
  -- and it is never returned to the caller.
  --
  -- metadata carries display information only — the six approved fields, all of
  -- them values the caller either typed or can already see. No profile id,
  -- organization id, relationship id, shop id, email, role, permission, token, IP
  -- address, or user agent: the actor is already in actor_profile_id and the shop
  -- already in entity_id, and a metadata blob is read by more code, and more
  -- people, than the columns are. Nullable display values stay JSON null rather
  -- than being coerced to '' — "no code recorded" and "code recorded as empty"
  -- are different facts. ip_address and user_agent are left null: this function
  -- cannot observe them truthfully, and a value it guessed would be worse than an
  -- absent one.
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
    'RETAILER_SHOP_ADDED',
    'RETAILER_SHOP',
    v_shop_id::text,
    jsonb_build_object(
      'retailer_name',     v_retailer_name,
      'shop_name',         v_shop_name,
      'shop_code',         v_shop_code,
      'shop_city',         v_shop_city,
      'shop_country_code', v_country_code,
      'shop_status',       'ACTIVE'
    )
  );
end;
$$;

-- Privileges. PostgreSQL grants EXECUTE to PUBLIC on every new function by
-- default, and PUBLIC is inherited by every role — on a SECURITY DEFINER function
-- that writes tenant data, that default is exactly wrong. Revoking from PUBLIC is
-- what actually removes it; the anon revoke is explicit belt and braces. Only
-- `authenticated` may call it, and only a caller who then passes the in-function
-- context, permission, ownership, and active-state checks gets past its first
-- section.
--
-- The full argument-type list is repeated in every statement below because a
-- function is identified by its signature: naming it without the types would fail
-- to match, and would silently miss the function if an overload ever existed.
revoke all on function public.add_vendor_retailer_shop(uuid, text, text, text, text) from public;
revoke execute on function public.add_vendor_retailer_shop(uuid, text, text, text, text) from anon;
grant execute on function public.add_vendor_retailer_shop(uuid, text, text, text, text) to authenticated;

-- No table privilege is granted, changed, or revoked anywhere in this migration,
-- and no RLS policy is created, altered, or dropped. retailer_shops keeps exactly
-- the SELECT grant migration 9 gave it, audit_logs keeps none, and both keep
-- their default-deny write posture. Write access to shops exists only through the
-- function above.
