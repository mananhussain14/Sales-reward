-- Migration: vendor_retailer_onboarding
-- Purpose: The first WRITE path in the Retailer domain. Two related parts:
--            1. The RETAILERS_CREATE permission, seeded and mapped to
--               VENDOR_SUPER_ADMIN.
--            2. public.onboard_vendor_retailer(), an atomic SECURITY DEFINER RPC
--               that creates a Retailer organization, its Vendor relationship,
--               its first shop, and the audit record — all in one transaction.
--
-- Why a separate permission from RETAILERS_READ:
--   Reading the Retailer directory and CREATING tenant organizations are
--   different risks. RETAILERS_READ exposes rows that already exist;
--   RETAILERS_CREATE mints new organizations, new vendor relationships, and new
--   shop records, and is the only permission in this domain that can change what
--   the Vendor manages. Folding create into read would mean every future
--   read-only role (a reporting or support role, say) silently gained the
--   ability to create tenants the moment it was given the directory. Splitting
--   them keeps the two decisions independent: a role can be granted one without
--   the other, and widening read never widens write.
--
-- Why the RPC accepts no tenant or actor IDs:
--   Every id the function needs is DERIVED, never supplied. There is no vendor
--   organization id, actor/user/profile id, relationship id, role code,
--   permission code, or status parameter in the signature — because any such
--   parameter is a value the caller controls, and a caller-controlled tenant id
--   is exactly how a cross-tenant write happens. The caller can say WHAT to
--   create; it can never say WHO it is creating it for, or AS.
--
-- The authorization chain (evaluated inside the function, in this order):
--   auth.uid()
--     -> public.get_vendor_super_admin_context()
--          (ACTIVE profile -> ACTIVE membership -> ACTIVE organization of
--           organization_type = 'VENDOR' -> ACTIVE VENDOR_SUPER_ADMIN role)
--     -> first row by organization id  (the same deterministic tie-break the
--        application context already uses)
--     -> public.has_organization_permission(<that vendor>, 'RETAILERS_CREATE')
--   Both steps must pass. Either failing raises ONE generic message, so the
--   caller cannot tell "you are not a Vendor Super Admin" from "you lack
--   RETAILERS_CREATE" — an error string is not a place to describe the
--   authorization state of an account.
--
-- Why direct browser writes remain blocked:
--   Nothing in this migration grants the browser roles any table privilege, and
--   no RLS policy is added, altered, or dropped. organizations, vendor_retailers,
--   retailer_shops, audit_logs, roles, permissions, role_permissions, and
--   member_roles all keep their default-deny write posture. The ONLY way an
--   authenticated client can write any of these rows is by calling this
--   function, which validates and authorizes first and writes all four rows or
--   none. The privilege model is unchanged: one audited door, no windows.
--
-- Scope notes:
--   * No table, column, constraint, index, trigger, policy, or existing function
--     is created or altered. This migration adds one permission row, one mapping
--     row, and one function.
--   * No human membership and no member_roles row is created. A person can call
--     this only if trusted code already made them an ACTIVE VENDOR_SUPER_ADMIN.
--   * No earlier migration is modified.
--
-- Dependencies: migration 1 (organizations, profiles, organization_members),
--   2 (roles, permissions, role_permissions, member_roles), 3 (audit_logs),
--   4 (has_organization_permission), 6 (seeded VENDOR_SUPER_ADMIN),
--   7 (get_vendor_super_admin_context), 8 (vendor_retailers, retailer_shops).

-- ============================================================================
-- PART 1 — RETAILERS_CREATE permission
-- ============================================================================

-- Idempotency: this statement upserts on permissions.code (the unique constraint
-- migration 2 established), matching migrations 6 and 10 exactly. Re-running the
-- migration refreshes only the human-readable catalogue fields and updated_at,
-- and leaves `id` untouched — so the role_permissions row created below, and any
-- future FK pointing at this permission, survives a re-run intact. No fixed
-- UUIDs; the id comes from the table's own default. Nothing is deleted.
insert into public.permissions (code, name, description, module)
values
  (
    'RETAILERS_CREATE',
    'Create Retailers',
    'Create Vendor-managed Retailer organizations, their initial relationship, and first shop location.',
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
-- the migration would report success with RETAILERS_CREATE assigned to nobody —
-- fail-closed, but silently. Onboarding would raise "not authorized" for a
-- correctly configured Super Admin and nothing would explain why. This raises
-- instead. It reads one row and writes nothing.
do $$
begin
  if not exists (
    select 1
    from public.roles r
    where r.code = 'VENDOR_SUPER_ADMIN'
  ) then
    raise exception 'Seed precondition failed: role VENDOR_SUPER_ADMIN does not exist, so RETAILERS_CREATE cannot be assigned';
  end if;
end;
$$;

-- Role -> permission mapping. RETAILERS_CREATE goes to VENDOR_SUPER_ADMIN and
-- only to it: the WHERE clause names exactly one role code, so no other existing
-- or future role receives it without its own deliberate migration.
--
-- Ids are resolved by joining on code rather than written literally, keeping this
-- independent of generated UUIDs. Both codes are unique, so the cross join yields
-- precisely 1 x 1 = 1 row. ON CONFLICT DO NOTHING targets the composite primary
-- key (role_id, permission_id) — a re-run is a no-op and an existing mapping is
-- left exactly as it is.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN'
  and p.code = 'RETAILERS_CREATE'
on conflict (role_id, permission_id) do nothing;

-- ============================================================================
-- PART 2 — onboard_vendor_retailer()
-- ============================================================================
-- Returns void. The generated Retailer, relationship, and shop UUIDs are
-- deliberately NOT returned: the caller did not choose them, does not need them
-- to render a success message, and every subsequent read of those rows already
-- goes through the RETAILERS_READ policies. Returning internal ids for
-- convenience would hand the browser a set of identifiers whose only use is
-- addressing rows directly.
--
-- SECURITY DEFINER is what makes the four inserts possible at all: all four
-- tables are RLS default-deny with no write privileges for authenticated. The
-- function therefore carries the entire authorization decision itself, before it
-- writes anything.
--
-- No dynamic SQL anywhere, every reference fully schema-qualified, and
-- search_path = '' — so nothing in this body can be resolved from an
-- attacker-controlled schema.
create function public.onboard_vendor_retailer(
  p_retailer_name   text,
  p_shop_name       text,
  p_country_code    text default null,
  p_default_currency text default null,
  p_shop_code       text default null,
  p_shop_city       text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id  uuid;
  v_vendor_org_id     uuid;
  v_retailer_org_id   uuid;
  v_retailer_name     text;
  v_shop_name         text;
  v_country_code      text;
  v_default_currency  text;
  v_shop_code         text;
  v_shop_city         text;
begin
  -- --------------------------------------------------------------------------
  -- 1. Authorization
  -- --------------------------------------------------------------------------
  -- Identity comes from the JWT and nowhere else.
  v_actor_profile_id := auth.uid();

  if v_actor_profile_id is null then
    raise exception 'Not authorized to onboard retailers'
      using errcode = 'insufficient_privilege';
  end if;

  -- Resolve the Vendor through the existing context function rather than
  -- reimplementing its joins. Calling it is what guarantees the chain here is
  -- the SAME chain the application shell authorizes against — profile,
  -- membership, organization type and status, and the ACTIVE VENDOR_SUPER_ADMIN
  -- role — and that it cannot drift from it later. That function takes no
  -- arguments and filters on auth.uid() internally, so this call cannot nominate
  -- a vendor either.
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
  -- write. The permission check below is evaluated against the id resolved here,
  -- so there is no window in which an unresolved vendor reaches an insert.
  if v_vendor_org_id is null then
    raise exception 'Not authorized to onboard retailers'
      using errcode = 'insufficient_privilege';
  end if;

  -- Holding VENDOR_SUPER_ADMIN is not by itself permission to create tenants;
  -- the permission mapping seeded in Part 1 is. Checking the permission (rather
  -- than the role) keeps this consistent with every RLS policy in the project:
  -- authorization is permission-based end to end, so a future RETAILER_MANAGER
  -- needs a role_permissions row, not an edit to this function.
  if not public.has_organization_permission(v_vendor_org_id, 'RETAILERS_CREATE') then
    raise exception 'Not authorized to onboard retailers'
      using errcode = 'insufficient_privilege';
  end if;
  -- Note the three raises above are byte-identical. A caller learns only that it
  -- may not do this — not whether it failed on authentication, context, or
  -- permission.

  -- --------------------------------------------------------------------------
  -- 2. Input normalization and validation
  -- --------------------------------------------------------------------------
  -- Every text input is trimmed; optional fields that trim to empty become NULL,
  -- so '' and '   ' are stored as "absent" rather than as a blank string that
  -- would satisfy NOT NULL while meaning nothing. Country code and currency are
  -- upper-cased, because the stored form is canonical and 'ae' and 'AE' are the
  -- same country.
  --
  -- Nothing is truncated. An over-long country code or currency is REJECTED, not
  -- silently shortened — quietly turning 'USDD' into 'USD' invents data the
  -- caller never supplied. The length rules below are the same ones the
  -- organizations_country_code_len and organizations_default_currency_len
  -- constraints enforce; validating here converts a raw constraint violation into
  -- a clear message without weakening or duplicating the constraint, which still
  -- has the final say.
  v_retailer_name    := btrim(p_retailer_name);
  v_shop_name        := btrim(p_shop_name);
  v_country_code     := upper(nullif(btrim(p_country_code), ''));
  v_default_currency := upper(nullif(btrim(p_default_currency), ''));
  v_shop_code        := nullif(btrim(p_shop_code), '');
  v_shop_city        := nullif(btrim(p_shop_city), '');

  if v_retailer_name is null or v_retailer_name = '' then
    raise exception 'Retailer name is required'
      using errcode = 'check_violation';
  end if;

  if v_shop_name is null or v_shop_name = '' then
    raise exception 'Shop name is required'
      using errcode = 'check_violation';
  end if;

  -- COLLATE "C" is load-bearing, not decorative: PostgreSQL evaluates regex
  -- bracket ranges like [A-Z] according to the database collation, so under a
  -- locale-aware collation the range can admit characters outside ASCII. Pinning
  -- the operand to the C collation makes [A-Z] mean exactly the 26 ASCII letters
  -- on every host. This matches retailer_shops_country_code_format from
  -- migration 8.
  if v_country_code is not null
     and v_country_code collate "C" !~ '^[A-Z]{2}$' then
    raise exception 'Country code must be exactly two letters'
      using errcode = 'check_violation';
  end if;

  if v_default_currency is not null
     and v_default_currency collate "C" !~ '^[A-Z]{3}$' then
    raise exception 'Default currency must be exactly three letters'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Atomic writes
  -- --------------------------------------------------------------------------
  -- All four inserts happen inside this one function call, which PostgreSQL runs
  -- inside a single statement's transaction context. There is no BEGIN/COMMIT
  -- here, no autonomous transaction, no dblink, and no EXCEPTION handler — so any
  -- failure at any point (validation, authorization, a check constraint, the
  -- organization-type triggers on vendor_retailers and retailer_shops, the shop
  -- code unique index, the audit insert) aborts the whole call and rolls back
  -- everything already written by it. Partial state is therefore impossible by
  -- construction rather than by cleanup code, which is why no cleanup code
  -- exists. Exceptions propagate to the caller untouched; nothing is swallowed.

  -- 3a. The Retailer organization. organization_type and status are written
  -- explicitly rather than relying on defaults: organizations.organization_type
  -- defaults to 'VENDOR', so omitting it here would create a second Vendor.
  insert into public.organizations (
    name,
    organization_type,
    status,
    country_code,
    default_currency
  )
  values (
    v_retailer_name,
    'RETAILER',
    'ACTIVE',
    v_country_code,
    v_default_currency
  )
  returning id into v_retailer_org_id;

  -- 3b. The managing relationship. The vendor side is the id resolved from the
  -- caller's own authorization context — never an argument.
  insert into public.vendor_retailers (
    vendor_organization_id,
    retailer_organization_id,
    status
  )
  values (
    v_vendor_org_id,
    v_retailer_org_id,
    'ACTIVE'
  );

  -- 3c. The first shop. country_code is deliberately left unset: this function
  -- takes no shop-country input, and copying the Retailer's country onto the shop
  -- would be an assumption, not a fact — a retailer registered in one country can
  -- trade in another, and there is no project convention that says otherwise. A
  -- null country is recordable by design (migration 8 makes every shop address
  -- field nullable) and can be filled in later by the shop-editing module.
  -- No other address fields are set for the same reason.
  insert into public.retailer_shops (
    retailer_organization_id,
    name,
    code,
    city,
    status
  )
  values (
    v_retailer_org_id,
    v_shop_name,
    v_shop_code,
    v_shop_city,
    'ACTIVE'
  );

  -- 3d. The audit record, written in the same transaction as the rows it
  -- describes. An audit row that can outlive a rolled-back write, or be lost
  -- while the write survives, is worse than none — both are silent lies about
  -- what happened. Being in-line here makes the log and the facts inseparable.
  --
  -- Naming: `action` is RETAILER_ONBOARDED, past tense, describing what occurred
  -- rather than the RPC that did it, so the log stays readable if the entry point
  -- is ever renamed or replaced. `entity_type` is RETAILER_ORGANIZATION — the
  -- Retailer organization is the subject of the event; the relationship and shop
  -- are consequences of it, recorded here as one event rather than three.
  -- organization_id is the VENDOR's, matching the audit convention that the
  -- organization column names the tenant whose activity feed the entry belongs
  -- in: the Vendor performed this action.
  --
  -- metadata carries display information only. No profile ids, organization ids,
  -- relationship id, shop id, tokens, IP address, or user agent — the actor is
  -- already in actor_profile_id and the Retailer already in entity_id, and a
  -- metadata blob is read by more code, and more people, than the columns are.
  -- ip_address and user_agent are left null: this function cannot observe them
  -- truthfully, and a value it guessed would be worse than an absent one.
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
    'RETAILER_ONBOARDED',
    'RETAILER_ORGANIZATION',
    v_retailer_org_id::text,
    jsonb_build_object(
      'retailer_name',       v_retailer_name,
      'first_shop_name',     v_shop_name,
      'retailer_status',     'ACTIVE',
      'relationship_status', 'ACTIVE',
      'shop_status',         'ACTIVE'
    )
  );
end;
$$;

-- Privileges. PostgreSQL grants EXECUTE to PUBLIC on every new function by
-- default, and PUBLIC is inherited by every role — on a SECURITY DEFINER function
-- that writes tenant data, that default is exactly wrong. Revoking from PUBLIC is
-- what actually removes it; the anon revoke is explicit belt and braces. Only
-- `authenticated` may call it, and only a caller who then passes the in-function
-- context and permission checks gets past the first few lines.
--
-- The full argument-type list is repeated in every statement below because a
-- function is identified by its signature: naming it without the types would fail
-- to match, and would silently miss the function if an overload ever existed.
revoke all on function public.onboard_vendor_retailer(text, text, text, text, text, text) from public;
revoke execute on function public.onboard_vendor_retailer(text, text, text, text, text, text) from anon;
grant execute on function public.onboard_vendor_retailer(text, text, text, text, text, text) to authenticated;

-- No table privilege is granted to anon or authenticated on organizations,
-- vendor_retailers, retailer_shops, audit_logs, roles, permissions,
-- role_permissions, or member_roles, and no RLS policy is created, altered, or
-- dropped anywhere in this migration. Write access to the Retailer domain exists
-- only through the function above.
