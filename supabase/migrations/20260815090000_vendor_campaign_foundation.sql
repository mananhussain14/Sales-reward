-- Migration: vendor_campaign_foundation
-- Purpose: The storage + authorization-root foundation for Vendor-owned incentive
--          CAMPAIGNS and the reusable RETAILER GROUPS they target. It adds, and only
--          adds:
--            1. Four permissions — CAMPAIGNS_MANAGE and RETAILER_GROUPS_MANAGE
--               (Vendor), CAMPAIGNS_VIEW_ASSIGNED (Retailer Owner) and
--               STAFF_CAMPAIGNS_VIEW (Sales Staff) — with their role mappings.
--            2. Eleven tables: two for Retailer groups, two for campaign identity and
--               its immutable versions, three for authoring targets, two for the typed
--               reward rule, and two for the published eligibility snapshot.
--          Plus the validation/immutability triggers, the named unique indexes that act
--          as concurrency authorities, and default-deny RLS + privilege hardening.
--
-- NOTHING COMPATIBLE EXISTED. Inspection before writing this found no campaign,
--   incentive, promotion, group, target, tier, reward-rule or eligibility-snapshot
--   table, function or permission anywhere in the schema. The only object whose name
--   resembles one — retailer_invitation_shop_assignments — is the staff invitation's
--   intended-shop set and is unrelated, as is vendor_product_retailer_assignments,
--   which is the catalogue visibility edge this migration READS but never redefines.
--   Nothing here competes with or supersedes an existing object.
--
-- ============================================================================
-- THE TWO WORDS THAT ARE NOT THE SAME WORD
-- ============================================================================
-- A RETAILER GROUP is a reusable, Vendor-owned collection of connected Retailers. It
-- answers "WHICH Retailers receive this campaign?" and is stored in
-- campaign_retailer_groups / campaign_retailer_group_members.
--
-- A RETAILER TEAM CAMPAIGN is a campaign whose eligible sales are aggregated per
-- Retailer. It answers "HOW is performance measured?" and is stored as one column,
-- campaign_versions.performance_scope = 'RETAILER_TEAM'.
--
-- They are orthogonal: a campaign may target a Retailer group and measure individually,
-- or target three directly-selected Retailers and measure by team. Nothing in this
-- schema couples them, and no column name uses "group" for the second concept.
--
-- Under RETAILER_TEAM each eligible Retailer is its own aggregate. That is a property
-- of the eligibility snapshot — one row per Retailer, never a row spanning two — so
-- there is structurally no place for a cross-Retailer total to be stored.
--
-- ============================================================================
-- WHY A VERSION TABLE AND NOT AN EDITABLE CAMPAIGN ROW
-- ============================================================================
-- A published campaign is a promise made to Retailers and their staff about how sales
-- will be rewarded. Editing that promise in place would silently rewrite what people
-- were told, and would make a historical reward impossible to explain. So the campaign
-- row carries only IDENTITY and management status, and every configuration fact —
-- dates, audience, product scope, performance scope, stacking, rules — lives in a
-- campaign_versions row that becomes IMMUTABLE the moment it is published. A material
-- change is a new version, never an UPDATE.
--
-- Authoring state is separated from effective-time state for the same reason. The
-- persisted campaigns.status is DRAFT / PUBLISHED / PAUSED / CANCELLED and changes only
-- when a human acts. SCHEDULED, ACTIVE and ENDED are DERIVED at read time by comparing
-- now() against starts_at / ends_at, so no scheduled job is required to move a campaign
-- from scheduled to active, and a clock that is merely queried can never be a clock
-- that drifts out of step with the truth.
--
-- ============================================================================
-- WHY THE GROUP EDGE POINTS AT vendor_retailers AND NOT AT organizations
-- ============================================================================
-- public.vendor_retailers.id is the canonical Vendor-to-Retailer RELATIONSHIP
-- identifier this project already uses as the client-facing handle: it is the
-- relationship_id returned by list_vendor_retailers(), the p_vendor_retailer_id taken
-- by set_vendor_retailer_status(), and the [relationshipId] segment in the Vendor web
-- routes. Pointing group membership at it means a membership row STRUCTURALLY names one
-- Vendor's relationship — a cross-Vendor addition is not merely rejected by a check, it
-- has no representation, because the relationship row itself carries the owning Vendor.
--
-- The published snapshot additionally denormalizes retailer_organization_id, because
-- that — not the relationship id — is the column
-- vendor_product_retailer_assignments and every Retailer-side resolver join on. Both
-- are recorded so neither side has to re-derive the other, and the pair is frozen at
-- publication like everything else in the snapshot.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
--   No progress, no evaluation, no receipt-to-campaign matching, no coin ledger, no
--   balance, no claim, no payout, no reversal and no reward CREDIT of any kind. Nothing
--   here computes what anybody has earned; it records only what a campaign OFFERS.
--   No percentage-of-value reward — coins are integers end to end and there is no
--   numeric/float column anywhere in this file.
--   No TIERED_TARGET rule type yet, though campaign_rule_tiers is shaped so adding one
--   is an INSERT of a permitted value rather than a table redesign.
--   No shop-level targeting: campaign eligibility is Retailer-level, matching the
--   product-assignment boundary established by 20260727090000.
--   No RPC — every operation lives in the ordered operations migration that follows.
--   No policy of any kind: all eleven tables are RPC-only and default-deny.
--   No change to any existing table, column, index, trigger, function, role, permission
--   or role-permission mapping.
--
-- RETAILER MANAGER RECEIVES NOTHING HERE, deliberately. No installed permission is a
--   safe reuse — RETAILER_PRODUCTS_READ is a catalogue read, not a campaign read — and
--   the milestone's approved scope grants campaign visibility to the Retailer Owner and
--   to Sales Staff only. A Manager gains it later by acquiring a role_permissions row,
--   not by an edit to any function in this project.
--
-- Idempotency posture: plain CREATE / INSERT (no IF NOT EXISTS, no CREATE OR REPLACE,
--   no ON CONFLICT). A conflicting existing object FAILS the migration. No fixed UUIDs —
--   permission rows take the table's gen_random_uuid() default and are joined by CODE.
--   All identifiers are <= 63 bytes.
--
-- Dependencies: 20260716124419 (profiles, organizations), 20260716125559 (roles,
--   permissions, role_permissions, set_updated_at), 20260717094520 (vendor_retailers),
--   20260722210000 (RETAILER_OWNER / SALES_STAFF roles), 20260727090000
--   (vendor_products), 20260814210000 (the assignment timeline that
--   product_eligibility_resolution = 'LIVE_TEMPORAL' is resolved against).

-- ============================================================================
-- PART 1 — permissions and their role mappings
-- ============================================================================
-- FOUR permissions rather than one, for the reason this project splits every other
-- capability: a future role gains the ability to read campaigns without gaining the
-- ability to author them by acquiring a role_permissions row, rather than by an edit to
-- a function. Managing groups is split from managing campaigns for the same reason — a
-- group is shared infrastructure that several campaigns reference, and widening who may
-- reshape it is a separate decision from widening who may publish.
insert into public.permissions (code, name, description, module)
values
  ('CAMPAIGNS_MANAGE',
   'Manage campaigns',
   'Create, edit, publish, pause, resume and cancel this Vendor''s incentive campaigns.',
   'CAMPAIGNS'),
  ('RETAILER_GROUPS_MANAGE',
   'Manage Retailer groups',
   'Create and edit the reusable Retailer groups this Vendor targets campaigns at.',
   'CAMPAIGNS'),
  ('CAMPAIGNS_VIEW_ASSIGNED',
   'View assigned campaigns',
   'View the published campaigns a Vendor has assigned to your Retailer.',
   'RETAILER_PORTAL'),
  ('STAFF_CAMPAIGNS_VIEW',
   'View my campaigns',
   'View the published campaigns that apply to the Retailer you work in.',
   'RETAILER_PORTAL');

-- Vendor authoring. Joined by CODE rather than by a literal UUID so this migration
-- depends on the seeded catalogue rather than restating it.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p
  on p.code in ('CAMPAIGNS_MANAGE', 'RETAILER_GROUPS_MANAGE')
where r.code = 'VENDOR_SUPER_ADMIN';

-- Retailer Owner read. RETAILER_OWNER ALONE — not RETAILER_MANAGER, per the header, and
-- not SALES_STAFF, whose read is a different and narrower contract below.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'CAMPAIGNS_VIEW_ASSIGNED'
where r.code = 'RETAILER_OWNER';

-- Sales Staff read. A SEPARATE permission rather than a SALES_STAFF mapping to
-- CAMPAIGNS_VIEW_ASSIGNED, following the precedent 20260730090000 set when it created
-- RECEIPT_PRODUCTS_READ rather than widening RETAILER_PRODUCTS_READ. The two reads
-- return different columns to different audiences: an Owner sees their Retailer's
-- campaign administration view, a staff member sees only what applies to their own
-- selling. One permission behind both would make widening either widen the other.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'STAFF_CAMPAIGNS_VIEW'
where r.code = 'SALES_STAFF';

-- ============================================================================
-- PART 2 — public.campaign_retailer_groups
-- ============================================================================
-- A reusable, named set of this Vendor's connected Retailers. "Premium Dubai
-- Retailers", "New stores 2026". Answers WHICH Retailers, never HOW performance is
-- measured.
create table public.campaign_retailer_groups (
  id uuid primary key default gen_random_uuid(),

  -- The owning Vendor. DERIVED by every operation from auth.uid() through
  -- get_vendor_super_admin_context(); never supplied by a browser. RESTRICT on delete,
  -- matching vendor_retailers and vendor_products: lifecycle in this schema is a status
  -- column, never a deleted row.
  vendor_organization_id uuid not null
    references public.organizations (id) on delete restrict,

  name text not null,
  description text,

  -- Two states and no more.
  --   ACTIVE    -- selectable when authoring a campaign
  --   ARCHIVED  -- retired; cannot be newly selected, but every PUBLISHED campaign that
  --               already resolved through it is completely unaffected, because
  --               publication copies membership into campaign_eligible_retailers and
  --               never reads the group again.
  status text not null default 'ACTIVE',

  created_by_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint campaign_retailer_groups_status_allowed
    check (status = any (array['ACTIVE'::text, 'ARCHIVED'::text])),

  -- Name and description follow the vendor_products convention exactly: stored trimmed,
  -- so the unique index below compares like with like no matter which caller wrote the
  -- row, and NOT NULL alone can never admit '' or '   '.
  constraint campaign_retailer_groups_name_trimmed
    check (name = btrim(name)),
  constraint campaign_retailer_groups_name_length
    check (length(name) between 1 and 120),
  constraint campaign_retailer_groups_description_shape
    check (
      description is null
      or (description = btrim(description) and length(description) between 1 and 500)
    )
);

comment on table public.campaign_retailer_groups is
  'A reusable Vendor-owned set of connected Retailers used as a campaign audience. Answers WHICH Retailers; never how performance is measured.';

-- THE GROUP-NAME CONCURRENCY AUTHORITY. One name per Vendor, case-insensitively, so
-- "Premium Dubai" and "premium dubai" are one group rather than two an operator cannot
-- tell apart. Scoped to the Vendor: two Vendors may each hold "Key accounts", and a
-- failed insert therefore cannot be used as an oracle for a competitor's group names.
--
-- Deliberately TOTAL rather than partial on status = 'ACTIVE'. Freeing a name by
-- archiving would let a second, differently-populated group inherit the identity of the
-- first in every list an operator has ever seen.
create unique index campaign_retailer_groups_name_unique_idx
  on public.campaign_retailer_groups (vendor_organization_id, lower(name));

-- The group listing: one Vendor's groups, by name.
create index campaign_retailer_groups_vendor_status_idx
  on public.campaign_retailer_groups (vendor_organization_id, status);

create trigger set_updated_at_on_campaign_retailer_groups
  before update on public.campaign_retailer_groups
  for each row execute function public.set_updated_at();

-- The owning organization must actually be a VENDOR.
--
-- Reachable despite the foreign key: BEFORE ROW triggers fire before FKs are checked
-- (foreign keys are AFTER ROW triggers), so this validator can run against an id no row
-- owns. The message names the RULE and never a row — an error string is not a safe place
-- to describe data the caller may not read. Same shape as
-- vendor_products_assert_vendor_type().
create function public.campaign_group_assert_vendor_type()
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
    raise exception 'A Retailer group must belong to a Vendor organization'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger campaign_group_assert_vendor_type_on_insert
  before insert on public.campaign_retailer_groups
  for each row execute function public.campaign_group_assert_vendor_type();

-- The owning Vendor and the creator are fixed at creation. A group cannot be handed to
-- another Vendor, because every campaign that ever resolved through it did so under the
-- authority of the Vendor that owned it at the time.
create function public.campaign_group_assert_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.vendor_organization_id is distinct from old.vendor_organization_id then
    raise exception 'A Retailer group cannot be moved to another Vendor'
      using errcode = 'check_violation';
  end if;
  if new.created_by_profile_id is distinct from old.created_by_profile_id then
    raise exception 'Retailer group creator is immutable'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger campaign_group_assert_immutable_on_update
  before update of vendor_organization_id, created_by_profile_id
  on public.campaign_retailer_groups
  for each row execute function public.campaign_group_assert_immutable();

-- ============================================================================
-- PART 3 — public.campaign_retailer_group_members
-- ============================================================================
-- Which of the Vendor's Retailer RELATIONSHIPS belong to a group. Soft-removal
-- semantics throughout, matching retailer_shop_members (20260722210000): a row is never
-- deleted, removal stamps removed_at, and re-adding inserts a NEW live row rather than
-- clearing the old one's removed_at. History survives, so "was Retailer A in this group
-- when campaign X published?" stays answerable — and that question has an answer that
-- matters, because a published campaign's audience was resolved from exactly this table
-- at exactly that moment.
create table public.campaign_retailer_group_members (
  id uuid primary key default gen_random_uuid(),

  campaign_retailer_group_id uuid not null
    references public.campaign_retailer_groups (id) on delete restrict,

  -- THE CANONICAL RELATIONSHIP IDENTIFIER. See the header: this structurally binds the
  -- membership to one Vendor's relationship rather than to a bare organization a caller
  -- could nominate.
  vendor_retailer_id uuid not null
    references public.vendor_retailers (id) on delete restrict,

  added_by_profile_id uuid not null
    references public.profiles (id) on delete restrict,
  added_at timestamptz not null default now(),

  removed_by_profile_id uuid
    references public.profiles (id) on delete restrict,
  removed_at timestamptz,

  -- A removal cannot predate the addition it removes, and the two stamps travel
  -- together: a row is either live (both null) or retired (both set).
  constraint campaign_group_members_removal_ordered
    check (removed_at is null or removed_at >= added_at),
  constraint campaign_group_members_removal_paired
    check ((removed_at is null) = (removed_by_profile_id is null))
);

comment on table public.campaign_retailer_group_members is
  'Live and historical membership of a Retailer group, keyed by the canonical vendor_retailers relationship id. Rows are never deleted; removal stamps removed_at.';

-- THE MEMBERSHIP CONCURRENCY AUTHORITY, and the reason removal is non-destructive. A
-- PARTIAL unique index: one LIVE membership per (group, relationship), with any number
-- of retired rows alongside it. Exactly the retailer_shop_members idiom.
create unique index campaign_group_members_live_unique_idx
  on public.campaign_retailer_group_members
     (campaign_retailer_group_id, vendor_retailer_id)
  where removed_at is null;

-- The membership read: one group's live members.
create index campaign_group_members_group_live_idx
  on public.campaign_retailer_group_members (campaign_retailer_group_id)
  where removed_at is null;

-- "Which groups is this Retailer in?", and the reverse lookup a group edit needs.
create index campaign_group_members_relationship_idx
  on public.campaign_retailer_group_members (vendor_retailer_id);

-- A group and its members must belong to the SAME Vendor.
--
-- This is the structural half of "cross-Vendor additions fail safely": the relationship
-- row carries its own owning Vendor, so a caller who somehow supplied another Vendor's
-- relationship id is refused here even if every layer above were bypassed. Defence in
-- depth over the operations migration, which additionally applies the eligibility rule
-- on relationship STATUS — a status rule belongs with the write path, because an
-- existing membership must remain REMOVABLE after a relationship has been suspended.
create function public.campaign_group_member_assert_same_vendor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group_vendor        uuid;
  v_relationship_vendor uuid;
begin
  select g.vendor_organization_id into v_group_vendor
  from public.campaign_retailer_groups g
  where g.id = new.campaign_retailer_group_id;

  if v_group_vendor is null then
    raise exception 'Referenced Retailer group does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  select vr.vendor_organization_id into v_relationship_vendor
  from public.vendor_retailers vr
  where vr.id = new.vendor_retailer_id;

  if v_relationship_vendor is null then
    raise exception 'Referenced Retailer relationship does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  if v_relationship_vendor <> v_group_vendor then
    raise exception 'A Retailer group can only contain its own Vendor''s Retailers'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger campaign_group_member_assert_same_vendor_on_insert
  before insert on public.campaign_retailer_group_members
  for each row execute function public.campaign_group_member_assert_same_vendor();

-- The pairing itself is fixed at creation, and a retired row stays retired. Only the
-- transition live -> removed is permitted, and only once: re-adding inserts a new row.
-- Without the second guard, clearing removed_at would erase the record that a Retailer
-- ever left a group — the exact history a published snapshot may need to explain.
create function public.campaign_group_member_assert_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.campaign_retailer_group_id is distinct from old.campaign_retailer_group_id
     or new.vendor_retailer_id is distinct from old.vendor_retailer_id then
    raise exception 'A group membership cannot be re-pointed; remove it and add another'
      using errcode = 'check_violation';
  end if;
  if new.added_at is distinct from old.added_at
     or new.added_by_profile_id is distinct from old.added_by_profile_id then
    raise exception 'Group membership creation facts are immutable'
      using errcode = 'check_violation';
  end if;
  if old.removed_at is not null and new.removed_at is distinct from old.removed_at then
    raise exception 'A removed group membership cannot be restored; add a new one'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger campaign_group_member_assert_immutable_on_update
  before update on public.campaign_retailer_group_members
  for each row execute function public.campaign_group_member_assert_immutable();

-- ============================================================================
-- PART 4 — public.campaigns  (identity and management status)
-- ============================================================================
-- The STABLE identity of a campaign across every version it ever has. Carries the name,
-- the description, the management status a human writes, and pointers to the version
-- currently being edited and the version currently in force. It carries no dates, no
-- audience, no products and no rules — all of those are version facts, and putting one
-- of them here would make it editable after publication.
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),

  vendor_organization_id uuid not null
    references public.organizations (id) on delete restrict,

  name text not null,
  description text,

  -- THE PERSISTED MANAGEMENT STATE. Four values, each the result of a human action:
  --   DRAFT      -- authored, never published; visible to Vendor campaign managers only
  --   PUBLISHED  -- a version is in force; effective-time state is DERIVED from its dates
  --   PAUSED     -- eligibility suspended, configuration and history preserved intact
  --   CANCELLED  -- terminal for the published version; remains visible historically
  --
  -- SCHEDULED, ACTIVE and ENDED are deliberately ABSENT. They are functions of now()
  -- against the in-force version's starts_at / ends_at, so they are computed at read
  -- time. Persisting them would require a scheduled job whose only achievement would be
  -- to sometimes disagree with the clock.
  status text not null default 'DRAFT',

  -- The version currently being edited, if any, and the version currently in force, if
  -- any. Both are nullable and both are set by the operations migration; the foreign
  -- keys are added after campaign_versions exists, immediately below.
  draft_version_id uuid,
  published_version_id uuid,

  created_by_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint campaigns_status_allowed
    check (status = any (array[
      'DRAFT'::text, 'PUBLISHED'::text, 'PAUSED'::text, 'CANCELLED'::text
    ])),

  constraint campaigns_name_trimmed
    check (name = btrim(name)),
  constraint campaigns_name_length
    check (length(name) between 1 and 150),
  constraint campaigns_description_shape
    check (
      description is null
      or (description = btrim(description) and length(description) between 1 and 2000)
    ),

  -- A DRAFT campaign has never had a version in force, and a campaign with a version in
  -- force is no longer a DRAFT. This is the one cross-column invariant worth stating
  -- structurally: every lifecycle RPC maintains it, and a bug that broke it would
  -- otherwise present as a campaign that is invisible to Retailers while claiming to be
  -- published.
  constraint campaigns_draft_has_no_published_version
    check ((status = 'DRAFT') = (published_version_id is null))
);

comment on table public.campaigns is
  'Stable campaign identity and the management status a human writes. Carries no dates, audience, products or rules: those are immutable campaign_versions facts.';

-- Deliberately NO unique index on the campaign name. A Vendor may legitimately run
-- "Q4 push" this year and next, and a name collision is a presentation concern the list
-- resolves with dates and status — not a data-integrity one worth refusing a write over.

create index campaigns_vendor_status_idx
  on public.campaigns (vendor_organization_id, status);

create index campaigns_vendor_created_idx
  on public.campaigns (vendor_organization_id, created_at desc);

create trigger set_updated_at_on_campaigns
  before update on public.campaigns
  for each row execute function public.set_updated_at();

create trigger campaigns_assert_vendor_type_on_insert
  before insert on public.campaigns
  for each row execute function public.campaign_group_assert_vendor_type();

-- The owning Vendor and the creator are fixed at creation, for the same reason a
-- product's are: everything downstream — snapshots, audit rows, Retailer visibility —
-- was authorized under the Vendor that owned it at the time.
create function public.campaigns_assert_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.vendor_organization_id is distinct from old.vendor_organization_id then
    raise exception 'A campaign cannot be moved to another Vendor'
      using errcode = 'check_violation';
  end if;
  if new.created_by_profile_id is distinct from old.created_by_profile_id then
    raise exception 'Campaign creator is immutable'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger campaigns_assert_immutable_on_update
  before update of vendor_organization_id, created_by_profile_id
  on public.campaigns
  for each row execute function public.campaigns_assert_immutable();

-- ============================================================================
-- PART 5 — public.campaign_versions  (immutable once published)
-- ============================================================================
-- ONE complete configuration of a campaign. Editable while published_at is null;
-- absolutely frozen afterwards, enforced by a trigger that rejects every column change.
--
-- Every dimension below is an INDEPENDENT setting. There is no "campaign type" column
-- and there is deliberately no such thing as a "normal", "special" or "group" campaign
-- in this schema: the three examples in the requirement are three points in the product
-- of audience_mode x performance_scope x product_scope x rule_type, and a fourth
-- combination nobody has asked for yet is already expressible.
create table public.campaign_versions (
  id uuid primary key default gen_random_uuid(),

  campaign_id uuid not null
    references public.campaigns (id) on delete restrict,

  version_number integer not null,

  -- ---- Duration ------------------------------------------------------------
  -- timestamptz throughout, so an instant is an instant regardless of where it was
  -- entered. ends_at NULL is the evergreen campaign — a first-class case, not a
  -- sentinel date far in the future that some later comparison would get wrong.
  starts_at timestamptz not null,
  ends_at timestamptz,

  -- The IANA zone the operator authored in. Not redundant with timestamptz: an instant
  -- says WHEN the campaign starts, this says which local midnight that instant WAS, and
  -- a reader in another zone needs both to be shown the campaign the way it was written.
  -- Validated against pg_catalog.pg_timezone_names by trigger — a CHECK cannot query.
  timezone_name text not null,

  -- ---- Audience ------------------------------------------------------------
  --   ALL_RETAILERS       -- every Retailer eligible at publication
  --   SELECTED_RETAILERS  -- the campaign_version_retailers rows
  --   RETAILER_GROUPS     -- the live members of the campaign_version_retailer_groups
  audience_mode text not null,

  -- ---- Performance ---------------------------------------------------------
  --   INDIVIDUAL_STAFF  -- each Sales Staff member measured on their own sales
  --   RETAILER_TEAM     -- all eligible staff sales inside ONE Retailer combined, with
  --                        a SEPARATE total per Retailer. See the header: the snapshot
  --                        holds one row per Retailer, so a cross-Retailer total has
  --                        nowhere to live.
  performance_scope text not null,

  -- Who a RETAILER_TEAM reward will eventually be paid to. Recorded now because it is
  -- part of the promise being published, and a campaign that ran without stating it
  -- could not be settled honestly later. CONTRIBUTING_STAFF is the only permitted value
  -- in this milestone and nothing distributes anything: no coin is credited anywhere in
  -- this schema.
  reward_recipient_scope text not null default 'CONTRIBUTING_STAFF',

  -- ---- Product scope -------------------------------------------------------
  --   ALL_ELIGIBLE_PRODUCTS  -- whatever is eligible for the Retailer at the moment that
  --                             matters, resolved from the assignment TIMELINE
  --   SELECTED_PRODUCTS      -- the campaign_version_products rows
  product_scope text not null,

  -- HOW the product scope is resolved. Made explicit rather than inferred, because the two
  -- scopes answer the eligibility question in genuinely different ways and a reader — or a
  -- reward engine — must never have to guess which one applies:
  --
  --   SNAPSHOT       -- publication resolved the eligible (Retailer, product) pairs once
  --                     and froze them into campaign_eligible_products. Later assignment
  --                     changes cannot alter them. This is what SELECTED_PRODUCTS means.
  --
  --   LIVE_TEMPORAL  -- eligibility is resolved AS OF a moment, from
  --                     vendor_product_retailer_assignment_history (migration
  --                     20260814210000). A product assigned after publication qualifies
  --                     for later sales; one withdrawn after publication stops qualifying
  --                     for later sales; and a sale that already happened keeps the answer
  --                     that was true when it happened. This is what ALL_ELIGIBLE_PRODUCTS
  --                     means.
  --
  -- LIVE_TEMPORAL IS NOT A MUTABLE CAMPAIGN. The version row stays frozen and its
  -- configured meaning never changes — "all products eligible at the relevant moment" says
  -- the same thing on day one and on day ninety. What moves is the external assignment
  -- timeline, which is business history recorded elsewhere, not campaign configuration.
  product_eligibility_resolution text not null default 'SNAPSHOT',

  -- ---- Stacking ------------------------------------------------------------
  --   STACKABLE  -- may pay alongside other campaigns; exclusivity_key must be NULL
  --   EXCLUSIVE  -- competes with other EXCLUSIVE campaigns sharing its key; the highest
  --                priority wins. The key and the priority are CONFIGURATION only: no
  --                exclusivity outcome is computed in this milestone.
  stacking_mode text not null,
  exclusivity_key text,
  priority integer not null default 0,

  published_at timestamptz,

  created_by_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  created_at timestamptz not null default now(),

  constraint campaign_versions_number_positive
    check (version_number >= 1),

  constraint campaign_versions_audience_allowed
    check (audience_mode = any (array[
      'ALL_RETAILERS'::text, 'SELECTED_RETAILERS'::text, 'RETAILER_GROUPS'::text
    ])),
  constraint campaign_versions_performance_allowed
    check (performance_scope = any (array[
      'INDIVIDUAL_STAFF'::text, 'RETAILER_TEAM'::text
    ])),
  constraint campaign_versions_recipient_allowed
    check (reward_recipient_scope = any (array['CONTRIBUTING_STAFF'::text])),
  constraint campaign_versions_product_scope_allowed
    check (product_scope = any (array[
      'ALL_ELIGIBLE_PRODUCTS'::text, 'SELECTED_PRODUCTS'::text
    ])),
  constraint campaign_versions_resolution_allowed
    check (product_eligibility_resolution = any (array[
      'SNAPSHOT'::text, 'LIVE_TEMPORAL'::text
    ])),
  -- THE PAIRING IS FIXED, so no inconsistent combination can be stored at all. Written as
  -- an equivalence rather than two implications: a SELECTED_PRODUCTS version that claimed
  -- LIVE_TEMPORAL would silently ignore its own frozen snapshot, and an
  -- ALL_ELIGIBLE_PRODUCTS version that claimed SNAPSHOT would freeze a list its own name
  -- says is open-ended. Both are refused here rather than in a function that could be
  -- edited around.
  constraint campaign_versions_resolution_matches_scope
    check (
      (product_scope = 'SELECTED_PRODUCTS')
      = (product_eligibility_resolution = 'SNAPSHOT')
    ),
  constraint campaign_versions_stacking_allowed
    check (stacking_mode = any (array['STACKABLE'::text, 'EXCLUSIVE'::text])),

  -- A campaign that ends before it starts is not a campaign. Strict >: a zero-length
  -- period can reward nothing, so admitting it would only produce a campaign that looks
  -- live in a list and is dead in every evaluation.
  constraint campaign_versions_period_ordered
    check (ends_at is null or ends_at > starts_at),

  -- EXCLUSIVE requires a key; STACKABLE forbids one. Both halves matter: a STACKABLE
  -- campaign carrying a key would look like it competes with something when it does
  -- not, and the future reward engine would have to guess which column to believe.
  constraint campaign_versions_exclusivity_paired
    check ((stacking_mode = 'EXCLUSIVE') = (exclusivity_key is not null)),
  -- Stored NORMALIZED — upper-cased and trimmed — so two campaigns written as
  -- "winter-bonus" and "WINTER_BONUS " do or do not compete by an unambiguous rule the
  -- DATABASE defines rather than the caller.
  constraint campaign_versions_exclusivity_key_shape
    check (
      exclusivity_key is null
      or (
        exclusivity_key = upper(btrim(exclusivity_key))
        and length(exclusivity_key) between 1 and 64
        and (exclusivity_key collate "C") ~ '^[A-Z0-9][A-Z0-9 ._-]*$'
        and exclusivity_key !~ '  '
      )
    ),

  -- A bounded, non-negative integer. Bounded so a caller cannot write a priority no
  -- other campaign could ever outrank, which would be an exclusivity lock rather than a
  -- precedence.
  constraint campaign_versions_priority_range
    check (priority between 0 and 1000),

  constraint campaign_versions_timezone_not_empty
    check (timezone_name = btrim(timezone_name) and length(timezone_name) between 1 and 64)
);

comment on table public.campaign_versions is
  'One complete, independently-dimensioned campaign configuration. Editable while published_at is null; wholly immutable afterwards.';

-- Version numbers are dense and unique per campaign.
create unique index campaign_versions_number_unique_idx
  on public.campaign_versions (campaign_id, version_number);

-- THE DRAFT CONCURRENCY AUTHORITY. At most ONE unpublished version per campaign, so
-- "the draft" is always a definite article and two concurrent create-version calls
-- cannot leave a campaign with two editable configurations that disagree.
create unique index campaign_versions_one_draft_idx
  on public.campaign_versions (campaign_id)
  where published_at is null;

-- The published-version reads: by campaign, newest first.
create index campaign_versions_campaign_published_idx
  on public.campaign_versions (campaign_id, published_at desc)
  where published_at is not null;

-- The effective-time scan the Retailer and staff reads perform.
create index campaign_versions_period_idx
  on public.campaign_versions (starts_at, ends_at)
  where published_at is not null;

-- Now that campaign_versions exists, close the loop on the campaigns pointers. Added as
-- constraints rather than inline because the two tables reference each other and one
-- had to be created first. RESTRICT so a version a campaign still points at cannot be
-- deleted out from under it.
alter table public.campaigns
  add constraint campaigns_draft_version_fkey
    foreign key (draft_version_id)
    references public.campaign_versions (id) on delete restrict;

alter table public.campaigns
  add constraint campaigns_published_version_fkey
    foreign key (published_version_id)
    references public.campaign_versions (id) on delete restrict;

-- The IANA timezone must be one this server actually knows.
--
-- A CHECK constraint cannot do this: it may not query a table, and pg_timezone_names is
-- a view over the server's zone database. A BEFORE trigger can, and putting the rule in
-- the database rather than in a TypeScript list is what stops a second client shipping
-- its own, staler set of zone names.
create function public.campaign_version_assert_timezone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone_name
  ) then
    raise exception 'Choose a valid campaign time zone'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger campaign_version_assert_timezone_on_write
  before insert or update of timezone_name on public.campaign_versions
  for each row execute function public.campaign_version_assert_timezone();

-- A PUBLISHED VERSION IS FROZEN. Every column, including published_at itself.
--
-- This is the structural guarantee behind the entire versioning design. Once a campaign
-- has been shown to Retailers and their staff, the only honest way to change it is a new
-- version — and this trigger is what makes "only" true, independently of whether every
-- RPC remembers to check. Pausing, resuming and cancelling deliberately write
-- campaigns.status and never touch a version, which is exactly why they remain possible
-- against a frozen row.
--
-- Publication itself is the one permitted transition: published_at moving from NULL to a
-- value, with nothing else changing in the same statement.
create function public.campaign_version_assert_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.published_at is not null then
    raise exception 'A published campaign version is immutable; create a new version'
      using errcode = 'check_violation';
  end if;

  -- Still a draft. Identity and lineage are fixed even so: renumbering a version or
  -- re-pointing it at another campaign would rewrite history that audit rows already
  -- name.
  if new.campaign_id is distinct from old.campaign_id
     or new.version_number is distinct from old.version_number
     or new.created_by_profile_id is distinct from old.created_by_profile_id
     or new.created_at is distinct from old.created_at then
    raise exception 'Campaign version identity is immutable'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger campaign_version_assert_immutable_on_update
  before update on public.campaign_versions
  for each row execute function public.campaign_version_assert_immutable();

-- A published version can never be deleted either. Without this, "immutable" would mean
-- "unchangeable, but erasable", and the snapshot rows that reference it would be the
-- only surviving evidence it had existed.
create function public.campaign_version_assert_undeletable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.published_at is not null then
    raise exception 'A published campaign version cannot be deleted'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

create trigger campaign_version_assert_undeletable_on_delete
  before delete on public.campaign_versions
  for each row execute function public.campaign_version_assert_undeletable();

-- ============================================================================
-- PART 6 — authoring targets
-- ============================================================================
-- What the operator SELECTED while authoring, as opposed to what publication RESOLVED.
-- Kept separate from the snapshot on purpose: "target the Premium Dubai group" and "the
-- four Retailers that group contained on 3 August" are different facts, and a campaign
-- detail screen must be able to show the first while a reward engine reads the second.
--
-- All three tables cascade on delete, unlike everything else in this migration. A
-- deleted DRAFT version should take its unpublished selections with it — they describe
-- nothing else and reference nothing downstream — while the published-version delete
-- guard above means a version with a snapshot cannot be deleted at all.

-- ---- Directly selected Retailers -------------------------------------------
create table public.campaign_version_retailers (
  id uuid primary key default gen_random_uuid(),

  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete cascade,

  vendor_retailer_id uuid not null
    references public.vendor_retailers (id) on delete restrict,

  created_at timestamptz not null default now()
);

comment on table public.campaign_version_retailers is
  'Retailers a campaign version targets directly, by canonical relationship id. Authoring intent, not resolved eligibility.';

create unique index campaign_version_retailers_unique_idx
  on public.campaign_version_retailers (campaign_version_id, vendor_retailer_id);

-- ---- Selected Retailer groups ----------------------------------------------
create table public.campaign_version_retailer_groups (
  id uuid primary key default gen_random_uuid(),

  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete cascade,

  campaign_retailer_group_id uuid not null
    references public.campaign_retailer_groups (id) on delete restrict,

  created_at timestamptz not null default now()
);

comment on table public.campaign_version_retailer_groups is
  'Retailer groups a campaign version targets. RESTRICT on the group: a group a campaign references cannot be deleted out from under it.';

create unique index campaign_version_groups_unique_idx
  on public.campaign_version_retailer_groups
     (campaign_version_id, campaign_retailer_group_id);

-- The "which campaigns currently reference this group?" lookup the group screen needs
-- before an operator edits membership.
create index campaign_version_groups_group_idx
  on public.campaign_version_retailer_groups (campaign_retailer_group_id);

-- ---- Selected products ------------------------------------------------------
create table public.campaign_version_products (
  id uuid primary key default gen_random_uuid(),

  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete cascade,

  vendor_product_id uuid not null
    references public.vendor_products (id) on delete restrict,

  created_at timestamptz not null default now()
);

comment on table public.campaign_version_products is
  'Products a campaign version targets when product_scope = SELECTED_PRODUCTS. Authoring intent; publication resolves these against each Retailer''s assignments.';

create unique index campaign_version_products_unique_idx
  on public.campaign_version_products (campaign_version_id, vendor_product_id);

-- ============================================================================
-- PART 7 — typed reward rules
-- ============================================================================
-- The reward is expressed RELATIONALLY and in INTEGERS, never as free-form JSON and
-- never as a float. JSON would move the business rule out of the database's reach —
-- nothing could constrain it, no index could serve it, and every client would re-parse
-- it into its own idea of what a reward means. Integer coins because money-like
-- quantities that round are money-like quantities that eventually disagree.
create table public.campaign_rules (
  id uuid primary key default gen_random_uuid(),

  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete cascade,

  --   PER_UNIT_COINS  -- coins_per_unit for every eligible unit, optionally capped
  --   TARGET_BONUS    -- one threshold in campaign_rule_tiers; reaching it pays its coins
  --
  -- TIERED_TARGET is the intended third value and is deliberately NOT permitted yet: the
  -- tier table below already supports several thresholds per rule, so adding it later
  -- widens this CHECK and relaxes one RPC guard rather than reshaping anything.
  rule_type text not null,

  -- What is counted. UNITS_SOLD is the only permitted metric: no percentage-of-value
  -- reward exists in this milestone, and admitting the vocabulary for one before the
  -- rounding, currency and reversal decisions are made would be a promise the schema
  -- cannot keep.
  metric_type text not null default 'UNITS_SOLD',

  -- Ordering within a version. The first UI writes exactly one rule at sequence 1; the
  -- column exists so a later multi-rule version has a deterministic evaluation order
  -- rather than whatever the planner emits.
  sequence integer not null default 1,

  -- PER_UNIT_COINS only. Integer coins per eligible unit sold.
  coins_per_unit bigint,

  -- Optional ceiling on what this rule may pay across the whole campaign period. NULL
  -- means uncapped. Applies to either rule type.
  max_reward_coins bigint,

  created_at timestamptz not null default now(),

  constraint campaign_rules_type_allowed
    check (rule_type = any (array['PER_UNIT_COINS'::text, 'TARGET_BONUS'::text])),
  constraint campaign_rules_metric_allowed
    check (metric_type = any (array['UNITS_SOLD'::text])),
  constraint campaign_rules_sequence_positive
    check (sequence >= 1),

  -- The typed half of the rule: PER_UNIT_COINS carries a positive rate, TARGET_BONUS
  -- carries none and puts its reward on its tier. Stated as an equivalence so neither
  -- direction can drift — a TARGET_BONUS row with a stray rate is refused just as firmly
  -- as a PER_UNIT_COINS row without one.
  constraint campaign_rules_rate_paired
    check ((rule_type = 'PER_UNIT_COINS') = (coins_per_unit is not null)),
  constraint campaign_rules_rate_positive
    check (coins_per_unit is null or coins_per_unit > 0),

  -- A cap of zero is a campaign that pays nothing, which no operator means to configure.
  constraint campaign_rules_cap_positive
    check (max_reward_coins is null or max_reward_coins > 0),

  -- ---- THE COIN CEILING ----------------------------------------------------
  -- 1,000,000,000 coins, on every configured amount in this schema.
  --
  -- WHY A CEILING AT ALL. bigint tempts you into thinking no bound is needed, but a
  -- reward engine multiplies a RATE by a QUANTITY, and an unbounded rate makes that
  -- product unbounded too. The arithmetic that has to stay safe is:
  --
  --     max coins_per_unit  x  max units a campaign could ever count
  --       = 1e9 x 2,147,483,647 (integer max)  =  2.147e18
  --       < bigint max                          =  9.223e18
  --
  -- So the largest configurable rate, multiplied by more units than any integer column in
  -- this schema can even hold, still cannot overflow. Without the ceiling, a hand-crafted
  -- RPC call could store bigint max and the engine's FIRST multiplication would raise
  -- `bigint out of range` — an error nobody could act on, discovered long after the
  -- campaign was published.
  --
  -- Enforced HERE as well as in the RPC deliberately. The RPC gives an operator a message
  -- they can act on; this makes the bound true for every writer, including a future one.
  constraint campaign_rules_rate_within_ceiling
    check (coins_per_unit is null or coins_per_unit <= 1000000000),
  constraint campaign_rules_cap_within_ceiling
    check (max_reward_coins is null or max_reward_coins <= 1000000000)
);

comment on table public.campaign_rules is
  'The typed reward rule for one campaign version. Integer coins only; no percentage-of-value reward and no evaluation logic.';

create unique index campaign_rules_sequence_unique_idx
  on public.campaign_rules (campaign_version_id, sequence);

create table public.campaign_rule_tiers (
  id uuid primary key default gen_random_uuid(),

  campaign_rule_id uuid not null
    references public.campaign_rules (id) on delete cascade,

  tier_number integer not null,

  -- The count of the rule's metric that must be reached. Integer: units are counted, not
  -- measured.
  threshold_units integer not null,

  -- What reaching the threshold pays. Integer coins.
  reward_coins bigint not null,

  created_at timestamptz not null default now(),

  constraint campaign_rule_tiers_number_positive
    check (tier_number >= 1),
  constraint campaign_rule_tiers_threshold_positive
    check (threshold_units >= 1),
  constraint campaign_rule_tiers_reward_positive
    check (reward_coins >= 1),
  -- The same 1,000,000,000 ceiling, for the same reason. See campaign_rules above.
  constraint campaign_rule_tiers_reward_within_ceiling
    check (reward_coins <= 1000000000)
);

comment on table public.campaign_rule_tiers is
  'Threshold/reward pairs for a TARGET_BONUS rule — one row today. Shaped for a later TIERED_TARGET with several rows per rule.';

create unique index campaign_rule_tiers_number_unique_idx
  on public.campaign_rule_tiers (campaign_rule_id, tier_number);

-- Two rules must not share a threshold ordering that makes evaluation ambiguous. Unique
-- per rule so a future tiered rule cannot list "10 units" twice with different rewards.
create unique index campaign_rule_tiers_threshold_unique_idx
  on public.campaign_rule_tiers (campaign_rule_id, threshold_units);

-- ============================================================================
-- PART 7b — "immutable" has to mean the WHOLE configuration
-- ============================================================================
-- campaign_version_assert_immutable() freezes the version ROW. On its own that would be
-- a hollow guarantee: the dates and the audience mode would be frozen while the selected
-- Retailers, the selected products and the reward rule — the five tables above, which
-- are just as much the published promise — stayed writable. These triggers close that
-- gap, so a published configuration is frozen in every table that describes it and not
-- merely in the one that heads it.
--
-- Defence in depth, not the primary control: the operations migration refuses to touch a
-- published version long before a statement reaches here. But the RPCs are code that can
-- be edited, and this is the invariant itself.
create function public.campaign_config_assert_version_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version   uuid;
  v_published timestamptz;
begin
  -- NEW is unassigned on DELETE, so the row under test is chosen by operation rather
  -- than by coalescing across a record that may not exist.
  if tg_op = 'DELETE' then
    v_version := old.campaign_version_id;
  else
    v_version := new.campaign_version_id;
  end if;

  select cv.published_at into v_published
  from public.campaign_versions cv
  where cv.id = v_version;

  if v_published is not null then
    raise exception 'A published campaign version is immutable; create a new version'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger campaign_version_retailers_draft_only
  before insert or update or delete on public.campaign_version_retailers
  for each row execute function public.campaign_config_assert_version_draft();

create trigger campaign_version_groups_draft_only
  before insert or update or delete on public.campaign_version_retailer_groups
  for each row execute function public.campaign_config_assert_version_draft();

create trigger campaign_version_products_draft_only
  before insert or update or delete on public.campaign_version_products
  for each row execute function public.campaign_config_assert_version_draft();

create trigger campaign_rules_draft_only
  before insert or update or delete on public.campaign_rules
  for each row execute function public.campaign_config_assert_version_draft();

-- A tier reaches its version through its rule, so it needs its own lookup rather than a
-- second copy of the one above.
create function public.campaign_tier_assert_version_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule      uuid;
  v_published timestamptz;
begin
  if tg_op = 'DELETE' then
    v_rule := old.campaign_rule_id;
  else
    v_rule := new.campaign_rule_id;
  end if;

  select cv.published_at into v_published
  from public.campaign_rules cr
  join public.campaign_versions cv on cv.id = cr.campaign_version_id
  where cr.id = v_rule;

  if v_published is not null then
    raise exception 'A published campaign version is immutable; create a new version'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger campaign_rule_tiers_draft_only
  before insert or update or delete on public.campaign_rule_tiers
  for each row execute function public.campaign_tier_assert_version_draft();

-- ============================================================================
-- PART 8 — published eligibility snapshots
-- ============================================================================
-- WHAT PUBLICATION RESOLVED, frozen at that instant. These two tables are the reason a
-- group edit or a product-assignment change made tomorrow cannot rewrite a campaign
-- published today: the resolution is COPIED here, and nothing reads the group or the
-- assignment table again for that version. A new version resolves afresh against
-- whatever is true then — which is precisely what "a new version may use the updated
-- group" means.
--
-- Both tables are append-only-at-publication and then wholly immutable: the triggers
-- below reject every UPDATE and every DELETE, without exception.

create table public.campaign_eligible_retailers (
  id uuid primary key default gen_random_uuid(),

  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete restrict,

  -- Both identifiers, per the header: the relationship id is the Vendor-facing handle,
  -- the organization id is what every Retailer-side resolver and the product-assignment
  -- table join on. Recording both freezes the pairing too.
  vendor_retailer_id uuid not null
    references public.vendor_retailers (id) on delete restrict,
  retailer_organization_id uuid not null
    references public.organizations (id) on delete restrict,

  -- WHY this Retailer is eligible. Enough to explain the resolution afterwards without
  -- re-running it:
  --   ALL_RETAILERS     -- audience_mode was ALL_RETAILERS
  --   DIRECT_SELECTION  -- named in campaign_version_retailers
  --   RETAILER_GROUP    -- a live member of source_group_id at publication
  --
  -- This column is Vendor-private. No Retailer-facing or staff-facing read returns it or
  -- source_group_id: telling a Retailer they were included "via Premium Dubai Retailers"
  -- would disclose a Vendor's segmentation and imply the existence of the other members.
  source text not null,
  source_group_id uuid
    references public.campaign_retailer_groups (id) on delete restrict,

  snapshot_at timestamptz not null default now(),

  constraint campaign_eligible_retailers_source_allowed
    check (source = any (array[
      'ALL_RETAILERS'::text, 'DIRECT_SELECTION'::text, 'RETAILER_GROUP'::text
    ])),
  constraint campaign_eligible_retailers_group_paired
    check ((source = 'RETAILER_GROUP') = (source_group_id is not null))
);

comment on table public.campaign_eligible_retailers is
  'Immutable per-version snapshot of which Retailers a published campaign applies to, and why. One row per Retailer: a RETAILER_TEAM total can never span two.';

-- THE SNAPSHOT CONCURRENCY AUTHORITY. One row per (version, Retailer) — which is both
-- what makes a duplicate publish unable to duplicate rows, and what structurally forbids
-- a RETAILER_TEAM aggregate that spans Retailers.
create unique index campaign_eligible_retailers_unique_idx
  on public.campaign_eligible_retailers (campaign_version_id, vendor_retailer_id);

-- The Retailer-side and staff-side read: "which published campaigns apply to me?"
create index campaign_eligible_retailers_org_idx
  on public.campaign_eligible_retailers (retailer_organization_id, campaign_version_id);

create table public.campaign_eligible_products (
  id uuid primary key default gen_random_uuid(),

  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete restrict,

  vendor_retailer_id uuid not null
    references public.vendor_retailers (id) on delete restrict,
  retailer_organization_id uuid not null
    references public.organizations (id) on delete restrict,

  vendor_product_id uuid not null
    references public.vendor_products (id) on delete restrict,

  -- Per-RETAILER product rows, not per-campaign. Two Retailers targeted by one campaign
  -- may hold different subsets of the selected products, because assignment is a
  -- Retailer-level fact; collapsing them would make the campaign claim a product is
  -- eligible somewhere it was never assigned. The unique index below is on the triple
  -- for exactly that reason.
  snapshot_at timestamptz not null default now()
);

comment on table public.campaign_eligible_products is
  'Immutable per-version, PER-RETAILER snapshot of eligible products. Written only when product_scope = SELECTED_PRODUCTS; ALL_ELIGIBLE_PRODUCTS resolves live by design.';

create unique index campaign_eligible_products_unique_idx
  on public.campaign_eligible_products
     (campaign_version_id, vendor_retailer_id, vendor_product_id);

create index campaign_eligible_products_org_idx
  on public.campaign_eligible_products
     (retailer_organization_id, campaign_version_id);

-- A SNAPSHOT IS WRITTEN ONCE AND NEVER AGAIN.
--
-- One function, two tables, four triggers. An UPDATE or a DELETE against either table is
-- refused unconditionally — there is no "unless the campaign is still draft" escape,
-- because a snapshot row only ever exists for a published version in the first place.
-- This is what makes "a later group edit does not alter the snapshot" a property of the
-- database rather than a property of the code that happens to run today.
create function public.campaign_snapshot_assert_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A published campaign eligibility snapshot is immutable'
    using errcode = 'check_violation';
end;
$$;

create trigger campaign_eligible_retailers_frozen_on_update
  before update on public.campaign_eligible_retailers
  for each row execute function public.campaign_snapshot_assert_frozen();

create trigger campaign_eligible_retailers_frozen_on_delete
  before delete on public.campaign_eligible_retailers
  for each row execute function public.campaign_snapshot_assert_frozen();

create trigger campaign_eligible_products_frozen_on_update
  before update on public.campaign_eligible_products
  for each row execute function public.campaign_snapshot_assert_frozen();

create trigger campaign_eligible_products_frozen_on_delete
  before delete on public.campaign_eligible_products
  for each row execute function public.campaign_snapshot_assert_frozen();

-- ============================================================================
-- PART 9 — RLS and privilege hardening
-- ============================================================================
-- RLS ON, and ZERO POLICIES, on all eleven tables. Default deny is the whole design:
-- every read and write goes through a SECURITY DEFINER RPC that resolves the caller from
-- auth.uid(). A "members may read their own rows" policy would be a second, independent
-- definition of who may see what — and getting it right here is strictly harder than for
-- products, because a campaign row is visible to a Vendor in full, to a Retailer Owner in
-- part, to a staff member in a smaller part, and to another Retailer not at all.
--
-- No privilege is granted to anon or authenticated on any of them, so a browser cannot
-- SELECT, INSERT, UPDATE or DELETE any campaign table even if a policy were added by
-- mistake. service_role is granted nothing either: every campaign operation derives its
-- authority from auth.uid(), and a service-role path would be a way to publish a campaign
-- with no session at all.
alter table public.campaign_retailer_groups          enable row level security;
alter table public.campaign_retailer_group_members   enable row level security;
alter table public.campaigns                         enable row level security;
alter table public.campaign_versions                 enable row level security;
alter table public.campaign_version_retailers        enable row level security;
alter table public.campaign_version_retailer_groups  enable row level security;
alter table public.campaign_version_products         enable row level security;
alter table public.campaign_rules                    enable row level security;
alter table public.campaign_rule_tiers               enable row level security;
alter table public.campaign_eligible_retailers       enable row level security;
alter table public.campaign_eligible_products        enable row level security;

revoke all on table public.campaign_retailer_groups          from public, anon, authenticated;
revoke all on table public.campaign_retailer_group_members   from public, anon, authenticated;
revoke all on table public.campaigns                         from public, anon, authenticated;
revoke all on table public.campaign_versions                 from public, anon, authenticated;
revoke all on table public.campaign_version_retailers        from public, anon, authenticated;
revoke all on table public.campaign_version_retailer_groups  from public, anon, authenticated;
revoke all on table public.campaign_version_products         from public, anon, authenticated;
revoke all on table public.campaign_rules                    from public, anon, authenticated;
revoke all on table public.campaign_rule_tiers               from public, anon, authenticated;
revoke all on table public.campaign_eligible_retailers       from public, anon, authenticated;
revoke all on table public.campaign_eligible_products        from public, anon, authenticated;

-- The trigger functions are internal; nothing but the tables' own triggers may call
-- them. Matches the posture of every other validator in this schema.
revoke all on function public.campaign_group_assert_vendor_type()        from public;
revoke all on function public.campaign_group_assert_immutable()          from public;
revoke all on function public.campaign_group_member_assert_same_vendor() from public;
revoke all on function public.campaign_group_member_assert_immutable()   from public;
revoke all on function public.campaigns_assert_immutable()               from public;
revoke all on function public.campaign_version_assert_timezone()         from public;
revoke all on function public.campaign_version_assert_immutable()        from public;
revoke all on function public.campaign_version_assert_undeletable()      from public;
revoke all on function public.campaign_config_assert_version_draft()     from public;
revoke all on function public.campaign_tier_assert_version_draft()       from public;
revoke all on function public.campaign_snapshot_assert_frozen()          from public;

-- ============================================================================
-- Closing note
-- ============================================================================
-- Four permissions, five role mappings, eleven tables with their indexes and triggers,
-- and eleven trigger functions. No RPC, no policy on any table in any schema, no change to
-- any existing table, function, role or permission mapping, and no privilege granted to
-- any browser role.
--
-- Nothing in this file computes progress, matches a receipt to a product, evaluates a
-- rule, resolves an exclusivity contest, credits a coin, moves a balance, or records a
-- claim or a payout. Those are later milestones, and the absence is deliberate: this
-- schema states what a campaign OFFERS, and nothing at all about what anyone has earned.
