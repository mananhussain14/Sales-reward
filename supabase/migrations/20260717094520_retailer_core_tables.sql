-- Migration: retailer_core_tables
-- Purpose: Storage and integrity rules for Retailers — the relationship through
--          which a Vendor organization manages a Retailer organization, and the
--          physical shop locations a Retailer operates. Creates tables,
--          constraints, indexes, type-validation triggers, and default-deny RLS
--          only.
--
-- Model notes:
--   * Retailers are NOT a new kind of entity. A Retailer is an ordinary
--     public.organizations row with organization_type = 'RETAILER' — a value the
--     migration-1 check constraint already allows. Reusing organizations is what
--     lets every existing authorization helper (is_active_organization_member,
--     has_organization_role, has_organization_permission) apply to a Retailer
--     unchanged: all three are organization-scoped and accept any organization
--     id. A separate retailers table would have forked that model.
--   * What organizations cannot express is WHO manages a Retailer. That is the
--     only genuinely new fact, and public.vendor_retailers is the one place it
--     lives.
--   * The vendor is deliberately NOT denormalized onto retailer_shops. A shop's
--     vendor is derived: retailer_shops.retailer_organization_id ->
--     vendor_retailers.retailer_organization_id -> vendor_organization_id.
--     Storing it twice would create a second source of truth that can drift, and
--     stale authorization data is a cross-tenant leak rather than a cosmetic bug.
--     This mirrors member_roles, which carries no organization_id and resolves it
--     through organization_members instead.
--
-- Scope notes:
--   * No RLS policies. Both tables are RLS-enabled with zero policies, which is
--     default-deny for browser (publishable-key) clients — the same posture
--     migrations 1-3 established for the identity, RBAC, and audit tables before
--     migration 5 opened precise reads. Policies for these tables arrive in their
--     own later migration.
--   * No authorization helpers, no permissions, no roles, no seed data, and no
--     tenant data: no organizations, retailers, shops, profiles, memberships, or
--     users are created here. Nothing in this migration grants anyone access to
--     anything.
--   * No existing table, policy, function, role, or permission is altered. The
--     only reference into existing schema is the foreign keys from the two new
--     tables to public.organizations, plus reuse of public.set_updated_at().
--   * Uses built-in gen_random_uuid(); pgcrypto is NOT enabled.
--
-- Dependencies: migration 1 (organizations, public.set_updated_at()).

-- ============================================================================
-- 1. Organization type validation
-- ============================================================================
-- A foreign key can guarantee that a referenced organization EXISTS. It cannot
-- guarantee anything about that organization's TYPE — nothing stops a row from
-- naming a RETAILER as its vendor, or a VENDOR as its retailer, and both would
-- satisfy the FK while being nonsense. A check constraint cannot close the gap
-- either: it may only read the row being written, never another table. Trigger
-- validation is the mechanism that can.
--
-- SECURITY DEFINER is required here, not merely preferred: public.organizations
-- is RLS-enabled. A validator running with the inserter's rights would see only
-- the organizations that caller's policies admit, so a legitimate Retailer that
-- happened to be invisible to the writer would be indistinguishable from a
-- missing one. Type is a schema invariant and must be evaluated against the
-- table as it really is, not as one caller can see it. Reading with definer
-- rights bypasses RLS for that lookup and nothing else.
--
-- search_path = '' with fully qualified references throughout, matching the
-- migration-4 helpers: nothing can be resolved from an attacker-controlled
-- schema.

-- Raises if the organization is missing or is not of the required type.
-- Returns normally — and silently — only when the organization exists AND
-- matches. Fails CLOSED in both directions: a missing organization raises rather
-- than being treated as acceptable.
--
-- Organization status is deliberately NOT considered. Type and lifecycle are
-- separate concerns: a SUSPENDED vendor is still a VENDOR, and refusing to
-- record a relationship for one would conflate "this is the wrong kind of
-- organization" with "this organization is currently paused". The active-chain
-- requirements already live in the authorization helpers, which is where
-- lifecycle belongs.
create function public.assert_organization_type(
  target_organization_id uuid,
  expected_organization_type text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actual_organization_type text;
begin
  select o.organization_type
    into actual_organization_type
  from public.organizations o
  where o.id = target_organization_id;

  -- Reachable, despite the foreign key: BEFORE ROW triggers fire before the FK
  -- is checked (foreign keys are implemented as AFTER ROW triggers), so this
  -- validator can run against an id no organization owns. Denying here is both
  -- correct and earlier than the FK would be.
  if actual_organization_type is null then
    raise exception 'Referenced organization does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  -- The message names the RULE that was broken, never the organization. The
  -- actual type, name, status, and every other column stay unmentioned: an error
  -- string is not a safe place to describe a row the caller may have no right to
  -- read.
  if actual_organization_type <> expected_organization_type then
    raise exception 'Referenced organization must be of type %',
      expected_organization_type
      using errcode = 'check_violation';
  end if;
end;
$$;

-- Privileges. This function differs from the migration-4 helpers in one
-- deliberate way: those are GRANTed to authenticated because the RLS policies
-- call them as that role. This one is called only from the trigger functions
-- below, which are themselves SECURITY DEFINER and therefore invoke it as its
-- owner — so no browser role needs EXECUTE, and none is given.
--
-- Withholding it matters. Every function in the public schema is a candidate
-- PostgREST RPC endpoint, and this one takes arguments and reports, by raising
-- or not raising, whether an arbitrary organization id exists and what type it
-- is. Granted to authenticated, it would be an oracle for probing organizations
-- the caller cannot read. It is not granted.
revoke all on function public.assert_organization_type(uuid, text) from public;
revoke execute on function public.assert_organization_type(uuid, text) from anon;
revoke execute on function public.assert_organization_type(uuid, text) from authenticated;

-- Trigger validator for public.vendor_retailers: both sides at once.
create function public.vendor_retailers_assert_organization_types()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_organization_type(new.vendor_organization_id, 'VENDOR');
  perform public.assert_organization_type(new.retailer_organization_id, 'RETAILER');
  return new;
end;
$$;

-- Privileges. PostgreSQL grants EXECUTE to PUBLIC on every new function by
-- default, and PUBLIC is inherited by every role — so without the revokes below,
-- anon and authenticated would hold EXECUTE on a SECURITY DEFINER function
-- despite this migration never granting them anything. Revoking from PUBLIC is
-- what actually removes it; the anon and authenticated revokes are belt and
-- braces, matching the shape used for assert_organization_type above.
--
-- The triggers created later in this migration keep working. PostgreSQL checks
-- EXECUTE on a trigger function at CREATE TRIGGER time — against the migration
-- role, which owns the function and therefore always holds it — and NOT when the
-- trigger fires. Firing is done by the executor on behalf of the table, not by a
-- function call made as the writing role, so a browser role's lack of EXECUTE
-- cannot stop validation from running. Revoking removes only the ability to call
-- the function DIRECTLY, which nothing legitimate ever does.
--
-- Direct calls are already unattractive — a trigger function reads NEW, so
-- invoking it outside a trigger raises immediately, and PostgREST does not expose
-- functions returning `trigger` as RPC endpoints. Neither of those is a privilege
-- boundary, though: they are reasons an attack would be awkward, not reasons it
-- is denied. The revokes make it denied.
revoke all on function
  public.vendor_retailers_assert_organization_types()
from public;

revoke execute on function
  public.vendor_retailers_assert_organization_types()
from anon;

revoke execute on function
  public.vendor_retailers_assert_organization_types()
from authenticated;

-- Trigger validator for public.retailer_shops.
create function public.retailer_shops_assert_organization_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_organization_type(new.retailer_organization_id, 'RETAILER');
  return new;
end;
$$;

-- Privileges: same reasoning as the validator above. The triggers on
-- public.retailer_shops continue to invoke this function regardless, because
-- EXECUTE on a trigger function is checked when the trigger is created, not when
-- it fires.
revoke all on function
  public.retailer_shops_assert_organization_type()
from public;

revoke execute on function
  public.retailer_shops_assert_organization_type()
from anon;

revoke execute on function
  public.retailer_shops_assert_organization_type()
from authenticated;

-- ============================================================================
-- 2. vendor_retailers
-- ============================================================================
-- The relationship through which a Vendor organization manages a Retailer
-- organization. Modelled as its own table rather than a parent column on
-- organizations for two reasons:
--
--   1. Lifecycle. "This vendor has suspended this retailer" and "this retailer
--      company is deactivated" are different facts. A parent column would force
--      them to share the retailer's own organizations.status, so a vendor
--      pausing a retailer would have to mutate the retailer's own record. The
--      status column here belongs to the RELATIONSHIP and moves independently of
--      either organization's status.
--   2. A link table is the natural home for a link, matching how the schema
--      already separates identity (organizations, profiles) from linkage
--      (organization_members) from assignment (member_roles). This table is the
--      same shape as organization_members.
--
-- The unique constraint below makes the pair the real key, so today's one-vendor
-- deployment is a strict subset of a future multi-vendor one: nothing here
-- assumes a Retailer has exactly one Vendor, and nothing needs to change if that
-- stops being true.
create table public.vendor_retailers (
  id                       uuid        primary key default gen_random_uuid(),
  -- ON DELETE RESTRICT, not CASCADE. Lifecycle in this schema is expressed by a
  -- status column, never by deleting rows: organizations, profiles, and
  -- memberships all carry DEACTIVATED for exactly that reason. A CASCADE here
  -- would mean that hard-deleting an organization silently erases the record
  -- that it ever managed, or was managed by, anyone — destroying history that
  -- audit and payout reconstruction will later depend on. RESTRICT states the
  -- invariant instead: an organization that still holds retailer relationships
  -- cannot be deleted out from under them, and must be DEACTIVATED instead.
  -- This follows the existing member_roles.role_id convention, which uses
  -- RESTRICT so a role still assigned to members cannot be deleted.
  --
  -- SET NULL is not an option on either column: both are NOT NULL, and a
  -- relationship missing one of its two sides would be meaningless.
  vendor_organization_id   uuid        not null
                             references public.organizations (id) on delete restrict,
  retailer_organization_id uuid        not null
                             references public.organizations (id) on delete restrict,
  status                   text        not null default 'ACTIVE',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- An organization cannot manage itself. Both columns are NOT NULL, so this
  -- comparison is never null and the check can never be skipped.
  constraint vendor_retailers_distinct_organizations
    check (vendor_organization_id <> retailer_organization_id),

  -- One relationship per (vendor, retailer) pair. Re-adding a retailer a vendor
  -- once dropped updates the existing row's status rather than accumulating
  -- duplicates with conflicting states.
  constraint vendor_retailers_unique_pair
    unique (vendor_organization_id, retailer_organization_id),

  -- Mirrors organizations_status_allowed exactly. No PENDING state: "the vendor
  -- created this retailer but no owner has accepted yet" is already expressed by
  -- organization_members.status = 'INVITED' on the owner's membership, and
  -- duplicating that fact here would create two columns that can disagree.
  --   ACTIVE      -- managed normally; also the state a new relationship starts in
  --   SUSPENDED   -- temporarily paused by the vendor, expected to resume
  --   DEACTIVATED -- permanently ended, retained for history
  constraint vendor_retailers_status_allowed
    check (status in ('ACTIVE', 'SUSPENDED', 'DEACTIVATED'))
);

-- ============================================================================
-- 3. retailer_shops
-- ============================================================================
-- Physical shop locations owned by a Retailer organization. Address fields are
-- all nullable: a shop is identified by its name and its owning retailer, and a
-- bootstrapped or partially-known location must be recordable without inventing
-- an address.
create table public.retailer_shops (
  id                       uuid        primary key default gen_random_uuid(),
  -- RESTRICT for the same reason as vendor_retailers above: shops are closed by
  -- status, not erased. A retailer with shops on record cannot be hard-deleted.
  retailer_organization_id uuid        not null
                             references public.organizations (id) on delete restrict,
  name                     text        not null,
  code                     text        null,
  address_line1            text        null,
  address_line2            text        null,
  city                     text        null,
  region                   text        null,
  postal_code              text        null,
  country_code             text        null,
  status                   text        not null default 'ACTIVE',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- Matches the organizations_name_not_empty / profiles_*_name_not_empty
  -- convention: NOT NULL alone would still admit '' and '   '.
  constraint retailer_shops_name_not_empty
    check (length(trim(name)) > 0),

  -- code is optional, but a stored code must be meaningful. '' and '   ' are
  -- rejected; NULL (no code) remains allowed.
  constraint retailer_shops_code_not_empty
    check (code is null or length(trim(code)) > 0),

  -- Exactly two uppercase ASCII letters. The COLLATE "C" is load-bearing rather
  -- than decorative: PostgreSQL evaluates regex bracket RANGES like [A-Z]
  -- according to the database collation, so under a locale-aware collation the
  -- range can admit characters well outside ASCII. Pinning the operand to the C
  -- collation makes [A-Z] mean exactly the 26 ASCII letters, on every host, for
  -- good.
  --
  -- This is deliberately stricter than organizations_country_code_len, which
  -- only checks the length. That constraint is not touched here.
  constraint retailer_shops_country_code_format
    check (
      country_code is null
      or country_code collate "C" ~ '^[A-Z]{2}$'
    ),

  -- Mirrors organizations_status_allowed and vendor_retailers_status_allowed.
  --   ACTIVE      -- trading; also the state a new shop starts in
  --   SUSPENDED   -- temporarily closed, expected to reopen
  --   DEACTIVATED -- permanently closed, retained for history
  constraint retailer_shops_status_allowed
    check (status in ('ACTIVE', 'SUSPENDED', 'DEACTIVATED'))
);

-- ============================================================================
-- 4. Shop code uniqueness
-- ============================================================================
-- A partial, case-insensitive unique index — deliberately an index rather than a
-- table constraint, because a UNIQUE constraint can express neither an
-- expression (lower(code)) nor a WHERE clause. It enforces exactly three rules:
--
--   * One retailer cannot hold both 'DXB01' and 'dxb01'. lower(code) collapses
--     the two into one key.
--   * Different retailers may reuse the same code. retailer_organization_id
--     leads the index, so uniqueness is per retailer and never global.
--   * Any number of shops may have code = NULL. The WHERE clause omits those
--     rows from the index entirely, so they are not compared at all. (A plain
--     unique index would also permit repeated NULLs, since NULLs never conflict
--     — the partial clause states the intent and keeps the index smaller.)
--
-- Note: this normalizes case, not whitespace. 'DXB01' and ' DXB01' would remain
-- distinct. Trimming on write belongs in the module that eventually creates
-- shops; it is not added here, where nothing writes yet.
create unique index retailer_shops_org_code_unique_idx
  on public.retailer_shops (retailer_organization_id, lower(code))
  where code is not null;

-- ============================================================================
-- 5. Type-validation triggers
-- ============================================================================
-- BEFORE ROW, so validation runs before the row is written and before the
-- foreign key is checked. Split into INSERT and UPDATE triggers rather than one
-- combined trigger because the UPDATE variant needs a WHEN clause referencing
-- OLD, which does not exist during INSERT.
--
-- The UPDATE triggers are narrowed twice over: UPDATE OF limits them to
-- statements that mention an organization column at all, and the WHEN clause
-- limits them further to statements that actually change one. An ordinary status
-- change therefore performs no extra lookups.

create trigger vendor_retailers_assert_types_on_insert
  before insert on public.vendor_retailers
  for each row execute function public.vendor_retailers_assert_organization_types();

create trigger vendor_retailers_assert_types_on_update
  before update of vendor_organization_id, retailer_organization_id
  on public.vendor_retailers
  for each row
  when (
    new.vendor_organization_id is distinct from old.vendor_organization_id
    or new.retailer_organization_id is distinct from old.retailer_organization_id
  )
  execute function public.vendor_retailers_assert_organization_types();

create trigger retailer_shops_assert_type_on_insert
  before insert on public.retailer_shops
  for each row execute function public.retailer_shops_assert_organization_type();

create trigger retailer_shops_assert_type_on_update
  before update of retailer_organization_id
  on public.retailer_shops
  for each row
  when (new.retailer_organization_id is distinct from old.retailer_organization_id)
  execute function public.retailer_shops_assert_organization_type();

-- ============================================================================
-- 6. updated_at triggers (reusing public.set_updated_at())
-- ============================================================================
create trigger set_updated_at_on_vendor_retailers
  before update on public.vendor_retailers
  for each row execute function public.set_updated_at();

create trigger set_updated_at_on_retailer_shops
  before update on public.retailer_shops
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 7. Indexes
-- ============================================================================
-- vendor_retailers(vendor_organization_id, status): the Vendor Admin's own
-- question — "which retailers do I manage, and which are live?". Not redundant
-- against vendor_retailers_unique_pair: that index's second column is
-- retailer_organization_id, so it cannot serve status filtering.
create index vendor_retailers_vendor_status_idx
  on public.vendor_retailers (vendor_organization_id, status);

-- vendor_retailers(retailer_organization_id, status): the reverse lookup —
-- "which vendors manage this retailer?". This is the direction future RLS will
-- travel when authorizing a retailer row, and the unique pair index cannot serve
-- it at all, since its leading column is vendor_organization_id.
create index vendor_retailers_retailer_status_idx
  on public.vendor_retailers (retailer_organization_id, status);

-- retailer_shops(retailer_organization_id, status): list one retailer's shops by
-- state. The partial code index cannot serve this — it is restricted to rows
-- with a non-null code and its second column is lower(code).
create index retailer_shops_org_status_idx
  on public.retailer_shops (retailer_organization_id, status);

-- ============================================================================
-- 8. Row Level Security (default-deny; no policies)
-- ============================================================================
-- With RLS enabled and no policies, the anon/authenticated (publishable-key)
-- roles are denied ALL row access, reads and writes alike. Browser users
-- therefore cannot see, create, modify, or delete retailer relationships or
-- shops. Reads will be opened by a precise SELECT-only policy set in a later
-- migration; writes stay default-deny and will happen only through trusted
-- server-side code.
alter table public.vendor_retailers enable row level security;
alter table public.retailer_shops   enable row level security;

-- ============================================================================
-- 9. Privilege hardening
-- ============================================================================
-- RLS decides WHICH ROWS a role may touch; GRANTs decide whether the role may
-- attempt the statement at all. The two are independent, and the gap between
-- them is not theoretical here: Supabase ships ALTER DEFAULT PRIVILEGES for the
-- public schema that grant table privileges to anon and authenticated
-- automatically as tables are created. Left alone, these two tables would hand
-- the browser roles privileges this migration never intended — which is exactly
-- what migration 5 had to undo for the identity, RBAC, and audit tables.
--
-- TRUNCATE is the reason this cannot be left to RLS: it bypasses row security
-- entirely, so a privilege alone would let a browser role empty either table
-- despite the default-deny policy set above. REFERENCES would allow foreign keys
-- that probe row existence, and TRIGGER would allow attaching code to these
-- tables.
--
-- Nothing here grants anything. No SELECT is granted either, because no SELECT
-- policy exists yet — the migration that adds the read policies is where the
-- matching grant belongs, so that privilege and policy arrive together and
-- neither can outlive the other.
--
-- postgres and service_role are untouched: they hold their privileges directly
-- (and service_role additionally BYPASSRLS), so trusted server-side access is
-- unaffected.

-- PUBLIC is inherited by every role, so any privilege left here would leak to
-- anon and authenticated regardless.
revoke all on table
  public.vendor_retailers,
  public.retailer_shops
from public;

revoke all on table
  public.vendor_retailers,
  public.retailer_shops
from anon;

revoke all on table
  public.vendor_retailers,
  public.retailer_shops
from authenticated;
