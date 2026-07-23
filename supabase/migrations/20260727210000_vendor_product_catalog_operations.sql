-- Migration: vendor_product_catalog_operations
-- Purpose: The eight operations over the product-catalog foundation (migration
--          20260727090000). Adds exactly EIGHT functions and nothing else:
--            Vendor (all authenticated, all gated on a PRODUCTS_* permission)
--              1. list_vendor_products()
--              2. create_vendor_product(text, text, text, text, text)
--              3. update_vendor_product(uuid, text, text, text, text)
--              4. set_vendor_product_status(uuid, text)
--              5. list_vendor_product_retailer_assignments(uuid)
--              6. assign_vendor_product_to_retailer(uuid, uuid)
--              7. unassign_vendor_product_from_retailer(uuid, uuid)
--            Retailer
--              8. list_retailer_assigned_products()
--
-- HOW THE VENDOR IS DERIVED, EVERY TIME
--   select ctx.organization_id from public.get_vendor_super_admin_context() ctx
--   order by ctx.organization_id limit 1
--
--   This is the established pattern from onboard_vendor_retailer and
--   add_vendor_retailer_shop, reproduced exactly rather than reimplemented. That
--   context function takes no arguments and filters on auth.uid() internally, so no
--   call here can nominate a Vendor; the deterministic order reproduces the
--   application's own tie-break for a caller holding the role in two Vendors. Holding
--   the role is then NOT by itself permission to act: each operation additionally
--   requires the specific permission through has_organization_permission, so a future
--   role gains a capability by acquiring a role_permissions row rather than by an edit
--   to this file.
--
-- CALLER-SUPPLIED IDS ARE ADDRESSES, NEVER AUTHORIZATION
--   A product id and a Retailer organization id do arrive from the browser. Each is
--   filtered on TWO columns — the id itself, and the Vendor this function derived —
--   so an id belonging to another Vendor matches zero rows and can select nothing. The
--   refusal is byte-identical to "you are not authorized", so a caller cannot sweep
--   ids to learn what exists.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No OCR, no receipt matching, no campaign, incentive, reward, coin or payout logic,
--   and no Vendor reporting. No shop-level assignment. No DELETE of an assignment: a
--   withdrawal sets INACTIVE so the pairing's history survives for downstream sales
--   data. No table, column, constraint, index, trigger, policy, role, permission or
--   mapping is created or altered here, and no existing function is touched.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE).
--   A conflicting existing object FAILS the migration. No fixed UUIDs. No dynamic SQL.
--   All identifiers are <= 63 bytes. Every reference is schema-qualified because every
--   function runs with an EMPTY search_path.
--
-- Dependencies: 20260716130351 (audit_logs), 20260717083515
--   (get_vendor_super_admin_context), 20260716131104 (has_organization_permission),
--   20260718181835 (vendor_retailers), 20260723090000
--   (resolve_retailer_member_organization), 20260727090000 (the two tables and the
--   four permissions).

-- ============================================================================
-- FUNCTION 1 — list_vendor_products()
-- ============================================================================
-- The calling Vendor's own catalog, newest first, with a count of how many Retailers
-- currently hold an ACTIVE assignment of each product.
--
-- Zero arguments: there is no Vendor id to pass, so no URL segment, form field, header
-- or cookie can nominate whose catalog is returned. Returns no creator identity, no
-- audit metadata and no organization membership internals — only the product's own
-- display fields plus a count.
create function public.list_vendor_products()
returns table (
  product_id              uuid,
  product_code            text,
  barcode                 text,
  product_name            text,
  brand                   text,
  description             text,
  status                  text,
  active_assignment_count bigint,
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
  select ctx.organization_id into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCTS_READ') then
    raise exception 'Not authorized to view products'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    vp.id,
    vp.product_code,
    vp.barcode,
    vp.product_name,
    vp.brand,
    vp.description,
    vp.status,
    (
      select count(*)
      from public.vendor_product_retailer_assignments a
      where a.vendor_product_id = vp.id
        and a.status = 'ACTIVE'
    ),
    vp.created_at,
    vp.updated_at
  from public.vendor_products vp
  where vp.vendor_organization_id = v_vendor
  order by vp.created_at desc, vp.id desc;
end;
$$;

revoke all     on function public.list_vendor_products() from public;
revoke execute on function public.list_vendor_products() from anon;
grant  execute on function public.list_vendor_products() to authenticated;

-- ============================================================================
-- FUNCTION 2 — create_vendor_product(text, text, text, text, text)
-- ============================================================================
-- Creates one product in the calling Vendor's catalog and returns its id.
--
-- NORMALIZATION HAPPENS HERE, not only in the application. The stored product code is
-- upper-cased, trimmed and whitespace-collapsed, and the barcode is stripped of spaces
-- and hyphens, so the unique indexes compare like with like no matter which caller
-- wrote the row. An RPC granted to `authenticated` is a public endpoint reachable by a
-- hand-crafted call that never went near the form.
--
-- The two unique indexes are the concurrency authorities. Each is caught and reported
-- as its own safe message: both describe the CALLER'S OWN catalog — the indexes are
-- scoped per Vendor — so neither reveals anything about another Vendor's products.
create function public.create_vendor_product(
  p_product_code text,
  p_product_name text,
  p_barcode      text default null,
  p_brand        text default null,
  p_description  text default null
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
  v_code        text;
  v_name        text;
  v_barcode     text;
  v_brand       text;
  v_description text;
  v_id          uuid;
  v_constraint  text;
  v_vendor_name text;
begin
  v_actor := auth.uid();

  select ctx.organization_id into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_actor is null
     or v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCTS_MANAGE') then
    raise exception 'Not authorized to manage products'
      using errcode = 'insufficient_privilege';
  end if;

  -- Normalize. regexp_replace collapses internal whitespace runs to a single space so
  -- the stored value satisfies vendor_products_code_shape.
  v_code := upper(regexp_replace(btrim(coalesce(p_product_code, '')), '\s+', ' ', 'g'));
  v_name := regexp_replace(btrim(coalesce(p_product_name, '')), '\s+', ' ', 'g');

  -- A barcode is a number that people transcribe with separators. Strip them, then
  -- treat an empty result as "no barcode" rather than as an empty string.
  v_barcode := nullif(regexp_replace(coalesce(p_barcode, ''), '[\s-]', '', 'g'), '');

  v_brand       := nullif(regexp_replace(btrim(coalesce(p_brand, '')), '\s+', ' ', 'g'), '');
  v_description := nullif(btrim(coalesce(p_description, '')), '');

  if v_code = '' or length(v_code) > 64 or (v_code collate "C") !~ '^[A-Z0-9][A-Z0-9 ._/-]*$' then
    raise exception 'Enter a valid product code'
      using errcode = 'check_violation';
  end if;
  if v_name = '' or length(v_name) > 200 then
    raise exception 'Enter a product name'
      using errcode = 'check_violation';
  end if;
  if v_barcode is not null and (v_barcode collate "C") !~ '^[0-9]{8,14}$' then
    raise exception 'Enter a valid barcode, or leave it blank'
      using errcode = 'check_violation';
  end if;
  if v_brand is not null and length(v_brand) > 120 then
    raise exception 'Brand is too long'
      using errcode = 'check_violation';
  end if;
  if v_description is not null and length(v_description) > 2000 then
    raise exception 'Description is too long'
      using errcode = 'check_violation';
  end if;

  begin
    insert into public.vendor_products (
      vendor_organization_id,
      product_code,
      barcode,
      product_name,
      brand,
      description,
      status,
      created_by_profile_id
    )
    values (v_vendor, v_code, v_barcode, v_name, v_brand, v_description, 'ACTIVE', v_actor)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'vendor_products_code_unique_idx' then
      raise exception 'A product with that code already exists'
        using errcode = 'unique_violation';
    end if;
    if v_constraint = 'vendor_products_barcode_unique_idx' then
      raise exception 'A product with that barcode already exists'
        using errcode = 'unique_violation';
    end if;
    raise;
  end;

  select o.name into v_vendor_name from public.organizations o where o.id = v_vendor;

  -- Metadata carries display-only fields. No creator Auth metadata, no organization id,
  -- no membership internals, no secret, and no provider text. ip_address and user_agent
  -- are left null: this function cannot observe them truthfully.
  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor,
    v_actor,
    'PRODUCT_CREATED',
    'VENDOR_PRODUCT',
    v_id::text,
    jsonb_build_object(
      'product_code',   v_code,
      'product_name',   v_name,
      'product_status', 'ACTIVE',
      'vendor_name',    v_vendor_name
    )
  );

  return v_id;
end;
$$;

revoke all     on function public.create_vendor_product(text, text, text, text, text) from public;
revoke execute on function public.create_vendor_product(text, text, text, text, text) from anon;
grant  execute on function public.create_vendor_product(text, text, text, text, text) to authenticated;

-- ============================================================================
-- FUNCTION 3 — update_vendor_product(uuid, text, text, text, text)
-- ============================================================================
-- Edits a product's DISPLAY details: name, barcode, brand, description.
--
-- The product CODE is not a parameter. It is the canonical key that assignments are
-- made against and that a future receipt-matching step will resolve, so re-keying an
-- entry in place would silently change what every downstream reference means; the
-- storage migration enforces that with a trigger, and this function simply offers no
-- way to attempt it. A miscoded product is replaced, not renamed.
--
-- NO AUDIT WHEN NOTHING CHANGED. A submit that alters no value writes no row and
-- leaves updated_at alone — an audit trail whose entries do not correspond to changes
-- is worse than a shorter one.
create function public.update_vendor_product(
  p_product_id   uuid,
  p_product_name text,
  p_barcode      text default null,
  p_brand        text default null,
  p_description  text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor      uuid;
  v_actor       uuid;
  v_row         public.vendor_products%rowtype;
  v_name        text;
  v_barcode     text;
  v_brand       text;
  v_description text;
  v_constraint  text;
begin
  v_actor := auth.uid();

  select ctx.organization_id into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_actor is null
     or v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCTS_MANAGE') then
    raise exception 'Not authorized to manage products'
      using errcode = 'insufficient_privilege';
  end if;

  -- The two-column filter is the whole security boundary for the caller-supplied id.
  -- FOR UPDATE serializes concurrent edits of the same product.
  select * into v_row
  from public.vendor_products
  where id = p_product_id
    and vendor_organization_id = v_vendor
  for update;

  -- A null id, an id that names nothing, and an id owned by another Vendor all land
  -- here and are reported identically to "you are not authorized".
  if v_row.id is null then
    raise exception 'Not authorized to manage this product'
      using errcode = 'insufficient_privilege';
  end if;

  v_name        := regexp_replace(btrim(coalesce(p_product_name, '')), '\s+', ' ', 'g');
  v_barcode     := nullif(regexp_replace(coalesce(p_barcode, ''), '[\s-]', '', 'g'), '');
  v_brand       := nullif(regexp_replace(btrim(coalesce(p_brand, '')), '\s+', ' ', 'g'), '');
  v_description := nullif(btrim(coalesce(p_description, '')), '');

  if v_name = '' or length(v_name) > 200 then
    raise exception 'Enter a product name'
      using errcode = 'check_violation';
  end if;
  if v_barcode is not null and (v_barcode collate "C") !~ '^[0-9]{8,14}$' then
    raise exception 'Enter a valid barcode, or leave it blank'
      using errcode = 'check_violation';
  end if;
  if v_brand is not null and length(v_brand) > 120 then
    raise exception 'Brand is too long'
      using errcode = 'check_violation';
  end if;
  if v_description is not null and length(v_description) > 2000 then
    raise exception 'Description is too long'
      using errcode = 'check_violation';
  end if;

  -- Nothing meaningful changed: succeed silently, write nothing, audit nothing.
  if v_row.product_name is not distinct from v_name
     and v_row.barcode is not distinct from v_barcode
     and v_row.brand is not distinct from v_brand
     and v_row.description is not distinct from v_description then
    return;
  end if;

  begin
    update public.vendor_products
    set product_name = v_name,
        barcode      = v_barcode,
        brand        = v_brand,
        description  = v_description
    where id = v_row.id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'vendor_products_barcode_unique_idx' then
      raise exception 'A product with that barcode already exists'
        using errcode = 'unique_violation';
    end if;
    raise;
  end;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor,
    v_actor,
    'PRODUCT_UPDATED',
    'VENDOR_PRODUCT',
    v_row.id::text,
    jsonb_build_object(
      'product_code',   v_row.product_code,
      'product_name',   v_name,
      'product_status', v_row.status
    )
  );
end;
$$;

revoke all     on function public.update_vendor_product(uuid, text, text, text, text) from public;
revoke execute on function public.update_vendor_product(uuid, text, text, text, text) from anon;
grant  execute on function public.update_vendor_product(uuid, text, text, text, text) to authenticated;

-- ============================================================================
-- FUNCTION 4 — set_vendor_product_status(uuid, text)
-- ============================================================================
-- Activates or deactivates a product.
--
-- DEACTIVATION DOES NOT TOUCH EXISTING ASSIGNMENTS. It makes the product unavailable
-- for a NEW assignment (function 6 refuses an inactive product) and removes it from
-- the Retailer-facing list (function 8 requires an ACTIVE product), which is exactly
-- "unavailable for future receipt matching". Cascading a status change into assignment
-- rows would destroy the record of which Retailers held the product, and reactivating
-- could not restore it faithfully.
--
-- Setting the status it already has is an idempotent no-op: no write, no audit.
create function public.set_vendor_product_status(
  p_product_id uuid,
  p_status     text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
  v_actor  uuid;
  v_row    public.vendor_products%rowtype;
  v_status text;
begin
  v_actor := auth.uid();

  select ctx.organization_id into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_actor is null
     or v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCTS_MANAGE') then
    raise exception 'Not authorized to manage products'
      using errcode = 'insufficient_privilege';
  end if;

  v_status := upper(btrim(coalesce(p_status, '')));

  if v_status not in ('ACTIVE', 'INACTIVE') then
    raise exception 'Choose a valid product status'
      using errcode = 'check_violation';
  end if;

  select * into v_row
  from public.vendor_products
  where id = p_product_id
    and vendor_organization_id = v_vendor
  for update;

  if v_row.id is null then
    raise exception 'Not authorized to manage this product'
      using errcode = 'insufficient_privilege';
  end if;

  -- Already in that state.
  if v_row.status = v_status then
    return;
  end if;

  update public.vendor_products
  set status = v_status
  where id = v_row.id
    and status = v_row.status;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor,
    v_actor,
    case when v_status = 'ACTIVE' then 'PRODUCT_ACTIVATED' else 'PRODUCT_DEACTIVATED' end,
    'VENDOR_PRODUCT',
    v_row.id::text,
    jsonb_build_object(
      'product_code',   v_row.product_code,
      'product_name',   v_row.product_name,
      'product_status', v_status
    )
  );
end;
$$;

revoke all     on function public.set_vendor_product_status(uuid, text) from public;
revoke execute on function public.set_vendor_product_status(uuid, text) from anon;
grant  execute on function public.set_vendor_product_status(uuid, text) to authenticated;

-- ============================================================================
-- FUNCTION 5 — list_vendor_product_retailer_assignments(uuid)
-- ============================================================================
-- Every Retailer this Vendor is related to, with this product's assignment status
-- against each.
--
-- ONE function rather than two — "eligible Retailers" and "current assignments" are the
-- same list seen from two angles, and splitting them would let the two answers
-- disagree between round trips. A Retailer with no row yet reports assignment_status
-- NULL; a withdrawn one reports 'INACTIVE'.
--
-- Only this Vendor's OWN Retailers appear: the join is anchored on vendor_retailers
-- rows whose vendor_organization_id is the derived Vendor, so no unrelated Retailer can
-- be returned. No membership internals, audit metadata or Retailer-internal data is
-- included.
create function public.list_vendor_product_retailer_assignments(
  p_product_id uuid
)
returns table (
  retailer_organization_id uuid,
  retailer_name            text,
  retailer_status          text,
  relationship_status      text,
  assignment_status        text,
  assigned_at              timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor  uuid;
  v_product uuid;
begin
  select ctx.organization_id into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCT_RETAILER_ASSIGN') then
    raise exception 'Not authorized to manage product assignments'
      using errcode = 'insufficient_privilege';
  end if;

  select vp.id into v_product
  from public.vendor_products vp
  where vp.id = p_product_id
    and vp.vendor_organization_id = v_vendor;

  if v_product is null then
    raise exception 'Not authorized to manage this product'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    o.id,
    o.name,
    o.status,
    vr.status,
    a.status,
    a.assigned_at
  from public.vendor_retailers vr
  join public.organizations o
    on o.id = vr.retailer_organization_id
   and o.organization_type = 'RETAILER'
  left join public.vendor_product_retailer_assignments a
    on a.retailer_organization_id = o.id
   and a.vendor_product_id = v_product
  where vr.vendor_organization_id = v_vendor
  order by o.name, o.id;
end;
$$;

revoke all     on function public.list_vendor_product_retailer_assignments(uuid) from public;
revoke execute on function public.list_vendor_product_retailer_assignments(uuid) from anon;
grant  execute on function public.list_vendor_product_retailer_assignments(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 6 — assign_vendor_product_to_retailer(uuid, uuid)
-- ============================================================================
-- Makes an ACTIVE product visible to one of this Vendor's ACTIVE Retailers.
--
-- Both ids are addresses. The product must belong to the derived Vendor AND be ACTIVE;
-- the Retailer must be linked to the derived Vendor by an ACTIVE vendor_retailers row
-- AND be an ACTIVE RETAILER organization. Every one of those is checked here, and the
-- storage triggers re-assert the structural half independently.
--
-- ONE ROW PER PAIRING, FOR ALL TIME. A previously withdrawn assignment is flipped back
-- to ACTIVE rather than duplicated, so the pairing's history survives.
-- vendor_product_retailer_assign_unique_idx is the concurrency authority: two
-- simultaneous assignments of the same pair cannot both insert.
--
-- Assigning something already ACTIVE is an idempotent no-op: no write, no audit.
create function public.assign_vendor_product_to_retailer(
  p_product_id              uuid,
  p_retailer_organization_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor        uuid;
  v_actor         uuid;
  v_product       public.vendor_products%rowtype;
  v_retailer_id   uuid;
  v_retailer_name text;
  v_existing      public.vendor_product_retailer_assignments%rowtype;
begin
  v_actor := auth.uid();

  select ctx.organization_id into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_actor is null
     or v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCT_RETAILER_ASSIGN') then
    raise exception 'Not authorized to manage product assignments'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_product
  from public.vendor_products
  where id = p_product_id
    and vendor_organization_id = v_vendor
  for update;

  if v_product.id is null then
    raise exception 'Not authorized to manage this product'
      using errcode = 'insufficient_privilege';
  end if;

  -- An INACTIVE product may not receive a NEW active assignment. Safe to name
  -- specifically: this is reachable only after ownership has been proven, and the
  -- Vendor can already see the product's status on their own catalog page.
  if v_product.status <> 'ACTIVE' then
    raise exception 'Activate this product before assigning it to a Retailer'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The Retailer must be ACTIVE and actively related to the derived Vendor. An
  -- unrelated Retailer, a suspended relationship, a suspended Retailer, and an id that
  -- names nothing are all reported identically.
  select o.id, o.name
    into v_retailer_id, v_retailer_name
  from public.vendor_retailers vr
  join public.organizations o
    on o.id = vr.retailer_organization_id
   and o.organization_type = 'RETAILER'
  where vr.vendor_organization_id = v_vendor
    and vr.retailer_organization_id = p_retailer_organization_id
    and vr.status = 'ACTIVE'
    and o.status = 'ACTIVE'
  for share of o;

  if v_retailer_id is null then
    raise exception 'Select one of your active Retailers'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_existing
  from public.vendor_product_retailer_assignments
  where vendor_product_id = v_product.id
    and retailer_organization_id = v_retailer_id
  for update;

  if v_existing.id is not null then
    -- Already assigned: nothing to do, and nothing to audit.
    if v_existing.status = 'ACTIVE' then
      return;
    end if;

    update public.vendor_product_retailer_assignments
    set status                 = 'ACTIVE',
        assigned_by_profile_id = v_actor,
        assigned_at            = now()
    where id = v_existing.id;
  else
    -- The unique index settles a concurrent duplicate. Its verdict is accepted and
    -- reported on the same generic path, having written nothing.
    begin
      insert into public.vendor_product_retailer_assignments (
        vendor_product_id,
        retailer_organization_id,
        status,
        assigned_by_profile_id
      )
      values (v_product.id, v_retailer_id, 'ACTIVE', v_actor);
    exception when unique_violation then
      raise exception 'That product is already assigned to this Retailer'
        using errcode = 'unique_violation';
    end;
  end if;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor,
    v_actor,
    'PRODUCT_ASSIGNED_TO_RETAILER',
    'VENDOR_PRODUCT',
    v_product.id::text,
    jsonb_build_object(
      'product_code',      v_product.product_code,
      'product_name',      v_product.product_name,
      'product_status',    v_product.status,
      'retailer_name',     v_retailer_name,
      'assignment_status', 'ACTIVE'
    )
  );
end;
$$;

revoke all     on function public.assign_vendor_product_to_retailer(uuid, uuid) from public;
revoke execute on function public.assign_vendor_product_to_retailer(uuid, uuid) from anon;
grant  execute on function public.assign_vendor_product_to_retailer(uuid, uuid) to authenticated;

-- ============================================================================
-- FUNCTION 7 — unassign_vendor_product_from_retailer(uuid, uuid)
-- ============================================================================
-- Withdraws a product from a Retailer.
--
-- NON-DESTRUCTIVE, ALWAYS. The row is set INACTIVE and never deleted, so the record
-- that this product was once available at this Retailer survives for downstream sales
-- data to be explained against. There is no DELETE statement in this file.
--
-- Withdrawing something already withdrawn — or never assigned — is an idempotent
-- no-op. The Retailer's own status is NOT required to be ACTIVE here: a Vendor must be
-- able to withdraw a product from a Retailer it has since suspended, which is exactly
-- when withdrawal matters most.
create function public.unassign_vendor_product_from_retailer(
  p_product_id              uuid,
  p_retailer_organization_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor        uuid;
  v_actor         uuid;
  v_product       public.vendor_products%rowtype;
  v_retailer_name text;
  v_existing      public.vendor_product_retailer_assignments%rowtype;
begin
  v_actor := auth.uid();

  select ctx.organization_id into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_actor is null
     or v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCT_RETAILER_ASSIGN') then
    raise exception 'Not authorized to manage product assignments'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_product
  from public.vendor_products
  where id = p_product_id
    and vendor_organization_id = v_vendor;

  if v_product.id is null then
    raise exception 'Not authorized to manage this product'
      using errcode = 'insufficient_privilege';
  end if;

  -- The relationship must exist (so a Vendor cannot poke at another Vendor's
  -- Retailers), but it need not be ACTIVE.
  select o.name into v_retailer_name
  from public.vendor_retailers vr
  join public.organizations o
    on o.id = vr.retailer_organization_id
   and o.organization_type = 'RETAILER'
  where vr.vendor_organization_id = v_vendor
    and vr.retailer_organization_id = p_retailer_organization_id;

  if v_retailer_name is null then
    raise exception 'Select one of your Retailers'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_existing
  from public.vendor_product_retailer_assignments
  where vendor_product_id = v_product.id
    and retailer_organization_id = p_retailer_organization_id
  for update;

  -- Never assigned, or already withdrawn: nothing to do, and nothing to audit.
  if v_existing.id is null or v_existing.status = 'INACTIVE' then
    return;
  end if;

  update public.vendor_product_retailer_assignments
  set status = 'INACTIVE'
  where id = v_existing.id
    and status = 'ACTIVE';

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_vendor,
    v_actor,
    'PRODUCT_UNASSIGNED_FROM_RETAILER',
    'VENDOR_PRODUCT',
    v_product.id::text,
    jsonb_build_object(
      'product_code',      v_product.product_code,
      'product_name',      v_product.product_name,
      'product_status',    v_product.status,
      'retailer_name',     v_retailer_name,
      'assignment_status', 'INACTIVE'
    )
  );
end;
$$;

revoke all     on function public.unassign_vendor_product_from_retailer(uuid, uuid) from public;
revoke execute on function public.unassign_vendor_product_from_retailer(uuid, uuid) from anon;
grant  execute on function public.unassign_vendor_product_from_retailer(uuid, uuid) to authenticated;

-- ============================================================================
-- FUNCTION 8 — list_retailer_assigned_products()
-- ============================================================================
-- The ACTIVE products actively assigned to the calling member's own Retailer.
--
-- Zero arguments. The Retailer is derived from auth.uid() through the established
-- resolver on RETAILER_PRODUCTS_READ — a permission mapped to RETAILER_OWNER and
-- RETAILER_MANAGER only. A SALES_STAFF member holds no such mapping and is refused, so
-- the full assigned catalog is not exposed to them; a future receipt-matching operation
-- will need its own narrowly-scoped access rather than this broad read.
--
-- BOTH sides must be live: an INACTIVE product and a withdrawn assignment are each
-- enough to hide a row. Nothing about the Vendor is returned beyond the product's own
-- display fields — no Vendor organization id, no Vendor name, no creator, no audit
-- metadata, no assignment id, and no other Retailer's data.
create function public.list_retailer_assigned_products()
returns table (
  product_id        uuid,
  product_code      text,
  barcode           text,
  product_name      text,
  brand             text,
  description       text,
  assignment_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('RETAILER_PRODUCTS_READ');

  if v_retailer is null then
    raise exception 'Not authorized to view assigned products'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    vp.id,
    vp.product_code,
    vp.barcode,
    vp.product_name,
    vp.brand,
    vp.description,
    a.status
  from public.vendor_product_retailer_assignments a
  join public.vendor_products vp on vp.id = a.vendor_product_id
  where a.retailer_organization_id = v_retailer
    and a.status = 'ACTIVE'
    and vp.status = 'ACTIVE'
  order by vp.product_name, vp.product_code, vp.id;
end;
$$;

revoke all     on function public.list_retailer_assigned_products() from public;
revoke execute on function public.list_retailer_assigned_products() from anon;
grant  execute on function public.list_retailer_assigned_products() to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- Eight functions added; nothing else exists in this migration. No table, column,
-- constraint, index, trigger, policy, role, permission or role-permission mapping is
-- created, altered or dropped, no existing function is touched, and no table privilege
-- is granted to any browser role — both product tables stay default-deny with zero
-- policies. service_role is granted none of the eight: every one derives its authority
-- from auth.uid(), and a service-role path would let a catalog be read or changed with
-- no session at all.
