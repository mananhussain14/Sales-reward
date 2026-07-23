-- Migration: vendor_product_catalog_foundation
-- Purpose: The storage + authorization-root foundation for the Vendor product catalog
--          and its Retailer assignments. It adds, and only adds:
--            1. Four permissions — PRODUCTS_READ, PRODUCTS_MANAGE,
--               PRODUCT_RETAILER_ASSIGN (Vendor) and RETAILER_PRODUCTS_READ
--               (Retailer) — with their role mappings.
--            2. public.vendor_products — the canonical product a Vendor owns.
--            3. public.vendor_product_retailer_assignments — which of that Vendor's
--               Retailers may see a product.
--          Plus the validation/immutability triggers, the named unique indexes that
--          act as concurrency authorities, and default-deny RLS + privilege hardening.
--
-- NOTHING COMPATIBLE EXISTED. Inspection before writing this found no product,
--   catalog, SKU, barcode, item, brand or product-assignment table or function
--   anywhere in the schema, and no product-related permission. The only object whose
--   name resembles one — retailer_invitation_shop_assignments — is the staff
--   invitation's intended-shop set and is unrelated. Nothing here competes with or
--   supersedes an existing object.
--
-- THE ASSIGNMENT BOUNDARY IS THE RETAILER, NOT THE SHOP
--   Receipt submissions already record which shop a receipt came from
--   (public.receipt_submissions.retailer_shop_id, migration 20260726090000), so
--   shop-level inventory can be added later without blocking product matching. No
--   installed schema or stated requirement asks for shop-level product assignment
--   today, so this migration does not invent one.
--
-- WHY FOUR PERMISSIONS AND NOT A ROLE CHECK
--   Authorization in this project is permission-based end to end. Splitting READ from
--   MANAGE from RETAILER_ASSIGN means a future role can be granted the ability to
--   browse the catalog without gaining the ability to change it or to expose it to a
--   Retailer, by adding a role_permissions row rather than editing a function.
--   RETAILER_PRODUCTS_READ is a separate, Retailer-side permission for exactly the same
--   reason, and it is mapped to RETAILER_OWNER and RETAILER_MANAGER only — never to
--   SALES_STAFF, and never to a Vendor role.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No price, incentive amount, campaign, reward, coin or payout column. No
--   receipt-derived sales data on the product row. No OCR or receipt-matching object.
--   No product image column or image bucket — no compatible product-image storage
--   exists and the current application does not require one. No shop-level assignment.
--   No RPC — every operation lives in the ordered operations migration that follows.
--   No policy of any kind: both tables are RPC-only and default-deny.
--
-- Idempotency posture: plain CREATE / INSERT (no IF NOT EXISTS, no CREATE OR REPLACE,
--   no ON CONFLICT). A conflicting existing object FAILS the migration. No fixed
--   UUIDs — permission rows take the table's gen_random_uuid() default and are joined
--   by CODE. All identifiers are <= 63 bytes.
--
-- Dependencies: 20260716124419 (profiles, organizations), 20260716125559 (roles,
--   permissions, role_permissions, set_updated_at), 20260718181835 (vendor_retailers).

-- ============================================================================
-- PART 1 — permissions and their role mappings
-- ============================================================================
insert into public.permissions (code, name, description, module)
values
  ('PRODUCTS_READ',
   'View products',
   'View the products in this Vendor''s own catalog.',
   'PRODUCTS'),
  ('PRODUCTS_MANAGE',
   'Manage products',
   'Create products, edit their display details, and activate or deactivate them.',
   'PRODUCTS'),
  ('PRODUCT_RETAILER_ASSIGN',
   'Assign products to Retailers',
   'Assign a Vendor product to one of this Vendor''s Retailers, and withdraw it again.',
   'PRODUCTS'),
  ('RETAILER_PRODUCTS_READ',
   'View assigned products',
   'View the active products this Vendor has assigned to your Retailer.',
   'RETAILER_PORTAL');

-- Vendor management. Joined by CODE rather than by a literal UUID so this migration
-- depends on the seeded catalogue rather than restating it.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p
  on p.code in ('PRODUCTS_READ', 'PRODUCTS_MANAGE', 'PRODUCT_RETAILER_ASSIGN')
where r.code = 'VENDOR_SUPER_ADMIN';

-- Retailer read. RETAILER_OWNER and RETAILER_MANAGER only — SALES_STAFF is absent, so
-- a Sales Staff member cannot enumerate the catalog assigned to their Retailer. A
-- future receipt-matching operation will need its own narrowly-scoped access, and
-- giving it this broad read now would be exactly the over-exposure to avoid.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'RETAILER_PRODUCTS_READ'
where r.code in ('RETAILER_OWNER', 'RETAILER_MANAGER');

-- ============================================================================
-- PART 2 — public.vendor_products
-- ============================================================================
create table public.vendor_products (
  id uuid primary key default gen_random_uuid(),

  -- The owning Vendor. DERIVED by every operation from auth.uid() through
  -- get_vendor_super_admin_context(); never supplied by a browser. RESTRICT on delete
  -- because a catalog is a record and must not vanish with its organization.
  vendor_organization_id uuid not null
    references public.organizations (id) on delete restrict,

  -- The canonical key a future receipt-matching step will resolve against. Stored
  -- NORMALIZED (upper-cased, trimmed, internal whitespace collapsed) so "ab 12",
  -- "AB  12" and " Ab 12 " are one product rather than three.
  product_code text not null,

  -- Optional. A GTIN-family barcode: 8, 12, 13 or 14 digits (EAN-8, UPC-A, EAN-13,
  -- GTIN-14). Digits only, so a scanned value with spaces or hyphens is normalized by
  -- the operation before it reaches here.
  barcode text,

  product_name text not null,
  brand text,
  description text,

  status text not null default 'ACTIVE',

  -- Who created it. ALWAYS auth.uid(); there is no parameter for it anywhere.
  created_by_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ---- Lifecycle -----------------------------------------------------------
  -- Two states and no more. There is deliberately NO draft, review, approval,
  -- discontinued or archived state: none of those workflows exists, and inventing the
  -- vocabulary now would fix a shape before the requirement is known.
  constraint vendor_products_status_allowed
    check (status = any (array['ACTIVE'::text, 'INACTIVE'::text])),

  -- ---- Product code --------------------------------------------------------
  -- The stored form IS the normalized form. Asserting it here means the database, not
  -- the caller, decides what "normalized" means, and the unique index below therefore
  -- compares like with like.
  constraint vendor_products_code_normalized
    check (product_code = upper(btrim(product_code))),
  constraint vendor_products_code_length
    check (length(product_code) between 1 and 64),
  -- Upper-case letters, digits, and a small set of separators. Starts with a letter or
  -- a digit, carries no control character, and holds no run of two spaces — which,
  -- together with the trimming above, is exactly what "whitespace collapsed" means.
  -- COLLATE "C" so the bracket class means exactly ASCII on every host.
  constraint vendor_products_code_shape
    check (
      (product_code collate "C") ~ '^[A-Z0-9][A-Z0-9 ._/-]*$'
      and product_code !~ '  '
    ),

  -- ---- Barcode -------------------------------------------------------------
  constraint vendor_products_barcode_shape
    check (barcode is null or (barcode collate "C") ~ '^[0-9]{8,14}$'),

  -- ---- Display fields ------------------------------------------------------
  constraint vendor_products_name_trimmed
    check (product_name = btrim(product_name)),
  constraint vendor_products_name_length
    check (length(product_name) between 1 and 200),

  constraint vendor_products_brand_shape
    check (brand is null or (brand = btrim(brand) and length(brand) between 1 and 120)),

  constraint vendor_products_description_shape
    check (
      description is null
      or (description = btrim(description) and length(description) between 1 and 2000)
    )
);

comment on table public.vendor_products is
  'One canonical product owned by one Vendor. Display and identity fields only: no price, incentive, campaign, reward or receipt-derived data.';

-- ---- Indexes ---------------------------------------------------------------

-- THE PRODUCT-CODE CONCURRENCY AUTHORITY. Unique per Vendor, so two Vendors may each
-- have a product coded "SR-100" and neither can have two. Scoped to the Vendor
-- deliberately: a globally unique code would let one Vendor's catalog block another's,
-- and would turn a failed insert into an oracle for a competitor's product codes.
create unique index vendor_products_code_unique_idx
  on public.vendor_products (vendor_organization_id, product_code);

-- THE BARCODE CONCURRENCY AUTHORITY. Also per Vendor, and only where a barcode was
-- given — a partial index, so any number of products may have no barcode at all.
create unique index vendor_products_barcode_unique_idx
  on public.vendor_products (vendor_organization_id, barcode)
  where barcode is not null;

-- The catalog listing: one Vendor's products, newest first.
create index vendor_products_vendor_created_idx
  on public.vendor_products (vendor_organization_id, created_at desc);

-- The future receipt-matching lookup: an ACTIVE product of one Vendor by barcode.
create index vendor_products_vendor_active_barcode_idx
  on public.vendor_products (vendor_organization_id, barcode)
  where status = 'ACTIVE' and barcode is not null;

-- ---- Triggers --------------------------------------------------------------

create trigger set_updated_at_on_vendor_products
  before update on public.vendor_products
  for each row execute function public.set_updated_at();

-- The owning organization must actually be a VENDOR.
--
-- Reachable despite the foreign key: BEFORE ROW triggers fire before FKs are checked
-- (foreign keys are AFTER ROW triggers), so this validator can run against an id no
-- row owns. The message names the RULE and never a row — an error string is not a safe
-- place to describe data the caller may not read.
create function public.vendor_products_assert_vendor_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
begin
  select o.organization_type into v_type
  from public.organizations o
  where o.id = new.vendor_organization_id;

  if v_type is null then
    raise exception 'Referenced organization does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  if v_type <> 'VENDOR' then
    raise exception 'A product must belong to a Vendor organization'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger vendor_products_assert_vendor_type_on_insert
  before insert on public.vendor_products
  for each row execute function public.vendor_products_assert_vendor_type();

-- The owning Vendor, the product code and the creator are fixed at creation.
--
-- The CODE is immutable on purpose. It is the canonical key that assignments are made
-- against and that a future receipt-matching step will resolve, so re-keying a catalog
-- entry in place would silently change what every downstream reference means. Display
-- fields — name, brand, description — and the barcode remain editable, because those
-- are corrections to how a product is described rather than to which product it is.
create function public.vendor_products_assert_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.vendor_organization_id is distinct from old.vendor_organization_id then
    raise exception 'A product cannot be moved to another Vendor'
      using errcode = 'check_violation';
  end if;
  if new.product_code is distinct from old.product_code then
    raise exception 'Product code is immutable; create a replacement product instead'
      using errcode = 'check_violation';
  end if;
  if new.created_by_profile_id is distinct from old.created_by_profile_id then
    raise exception 'Product creator is immutable'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger vendor_products_assert_immutable_on_update
  before update of vendor_organization_id, product_code, created_by_profile_id
  on public.vendor_products
  for each row execute function public.vendor_products_assert_immutable();

-- ============================================================================
-- PART 3 — public.vendor_product_retailer_assignments
-- ============================================================================
create table public.vendor_product_retailer_assignments (
  id uuid primary key default gen_random_uuid(),

  vendor_product_id uuid not null
    references public.vendor_products (id) on delete restrict,

  retailer_organization_id uuid not null
    references public.organizations (id) on delete restrict,

  status text not null default 'ACTIVE',

  assigned_by_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  assigned_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vendor_product_assignments_status_allowed
    check (status = any (array['ACTIVE'::text, 'INACTIVE'::text]))
);

comment on table public.vendor_product_retailer_assignments is
  'Which of a Vendor''s Retailers may see one of its products. Retailer-level, not shop-level. Withdrawing sets INACTIVE; rows are never deleted.';

-- ---- Indexes ---------------------------------------------------------------

-- THE ASSIGNMENT CONCURRENCY AUTHORITY, and the reason unassignment is non-destructive.
--
-- ONE row per (product, Retailer) FOR ALL TIME — not one per active pair. Withdrawing
-- an assignment sets status = 'INACTIVE' and re-assigning flips the same row back, so
-- the history of a pairing survives and can never be destroyed by a later
-- assign/unassign cycle. That matters because downstream sales data will reference
-- these pairings: a DELETE would erase the record that a product was once available at
-- a Retailer, and with it the ability to explain a historical receipt match.
create unique index vendor_product_retailer_assign_unique_idx
  on public.vendor_product_retailer_assignments
     (vendor_product_id, retailer_organization_id);

-- The Retailer's own read: the ACTIVE products assigned to one Retailer.
create index vendor_product_assign_retailer_status_idx
  on public.vendor_product_retailer_assignments
     (retailer_organization_id, status);

-- The Vendor's per-product assignment panel.
create index vendor_product_assign_product_status_idx
  on public.vendor_product_retailer_assignments
     (vendor_product_id, status);

-- ---- Triggers --------------------------------------------------------------

create trigger set_updated_at_on_vendor_product_assignments
  before update on public.vendor_product_retailer_assignments
  for each row execute function public.set_updated_at();

-- The product's Vendor and the Retailer must be related.
--
-- This is the structural half of "no cross-Vendor assignment": a vendor_retailers row
-- must link the product's owning Vendor to this Retailer, and the Retailer must
-- actually be a RETAILER organization. Defence in depth over the operations migration,
-- which additionally requires both to be ACTIVE — a STATUS rule belongs with the write
-- path, because an existing assignment must remain deactivatable after a relationship
-- has been suspended.
create function public.vendor_product_assignment_assert_link()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vendor_org   uuid;
  v_retailer_type text;
begin
  select vp.vendor_organization_id into v_vendor_org
  from public.vendor_products vp
  where vp.id = new.vendor_product_id;

  if v_vendor_org is null then
    raise exception 'Referenced product does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  select o.organization_type into v_retailer_type
  from public.organizations o
  where o.id = new.retailer_organization_id;

  if v_retailer_type is null then
    raise exception 'Referenced organization does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  if v_retailer_type <> 'RETAILER' then
    raise exception 'A product can only be assigned to a Retailer organization'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1
    from public.vendor_retailers vr
    where vr.vendor_organization_id = v_vendor_org
      and vr.retailer_organization_id = new.retailer_organization_id
  ) then
    raise exception 'A product can only be assigned to one of its own Vendor''s Retailers'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger vendor_product_assign_assert_link_on_insert
  before insert on public.vendor_product_retailer_assignments
  for each row execute function public.vendor_product_assignment_assert_link();

create trigger vendor_product_assign_assert_link_on_update
  before update of vendor_product_id, retailer_organization_id
  on public.vendor_product_retailer_assignments
  for each row
  when (
    new.vendor_product_id is distinct from old.vendor_product_id
    or new.retailer_organization_id is distinct from old.retailer_organization_id
  )
  execute function public.vendor_product_assignment_assert_link();

-- The pairing itself is fixed at creation. Only the status moves.
create function public.vendor_product_assignment_assert_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.vendor_product_id is distinct from old.vendor_product_id
     or new.retailer_organization_id is distinct from old.retailer_organization_id then
    raise exception 'An assignment cannot be re-pointed; withdraw it and create another'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger vendor_product_assign_assert_immutable_on_update
  before update of vendor_product_id, retailer_organization_id
  on public.vendor_product_retailer_assignments
  for each row execute function public.vendor_product_assignment_assert_immutable();

-- ============================================================================
-- PART 4 — RLS and privilege hardening
-- ============================================================================
-- RLS ON, and ZERO POLICIES, on both tables. Default deny is the whole design: every
-- read and write goes through a SECURITY DEFINER RPC that resolves the caller from
-- auth.uid(). A "members may read their own rows" policy would be a second,
-- independent definition of who may see what, and the RPCs already answer that
-- question correctly.
--
-- No privilege is granted to anon or authenticated, so a browser cannot SELECT,
-- INSERT, UPDATE or DELETE either table even if a policy were added by mistake.
alter table public.vendor_products enable row level security;
alter table public.vendor_product_retailer_assignments enable row level security;

revoke all on table public.vendor_products from public;
revoke all on table public.vendor_products from anon;
revoke all on table public.vendor_products from authenticated;

revoke all on table public.vendor_product_retailer_assignments from public;
revoke all on table public.vendor_product_retailer_assignments from anon;
revoke all on table public.vendor_product_retailer_assignments from authenticated;

-- The trigger functions are internal; nothing but the tables' own triggers may call
-- them. Matches the posture of every other validator in this schema.
revoke all on function public.vendor_products_assert_vendor_type() from public;
revoke all on function public.vendor_products_assert_immutable() from public;
revoke all on function public.vendor_product_assignment_assert_link() from public;
revoke all on function public.vendor_product_assignment_assert_immutable() from public;

-- ============================================================================
-- Closing note
-- ============================================================================
-- Four permissions, five role mappings, two tables with their indexes and triggers.
-- No RPC, no policy on any table in any schema, no change to any existing table,
-- function, role or permission mapping, and no privilege granted to any browser role.
-- OCR, receipt matching, campaigns, incentives, rewards, coins, payouts and Vendor
-- reporting are all deliberately absent.
