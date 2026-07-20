-- Migration: retailer_owner_portal_foundation
-- Purpose: The read-only database foundation for the Retailer Owner Portal.
--          It adds exactly three things:
--
--            1. Two narrowly scoped READ permissions, mapped ONLY to the
--               RETAILER_OWNER role: RETAILER_PORTAL_READ and
--               RETAILER_SHOPS_READ.
--            2. One internal, un-granted resolver that answers "which single
--               Retailer organization does the caller own, for this permission?"
--            3. Two zero-argument, read-only RPCs the future portal will call:
--               get_retailer_owner_portal_context() and
--               list_retailer_owner_portal_shops().
--
--          Migration 15 (retailer_owner_invitation_foundation) seeded the
--          RETAILER_OWNER role ACTIVE with ZERO permissions, deliberately: an
--          invited owner could be assigned the role before anything existed for
--          them to read. This migration is the other half of that decision — it
--          gives the role the two read permissions the portal needs, and
--          nothing else. The role still holds no mutation permission of any
--          kind after this migration.
--
-- What this migration deliberately does NOT do:
--   * It does not touch the invitation feature. No invitation table, function,
--     policy, grant, or flag is read, altered, or enabled here. The paused
--     invitation work stays exactly as paused as it was.
--   * It adds NO RLS policy. The portal's browser contract is the narrow RPC
--     result, not table reads. public.retailer_shops keeps exactly the one
--     vendor-scoped SELECT policy from migration 9, which returns zero rows to a
--     Retailer Owner — and that is correct and stays that way. Adding a
--     retailer-owner SELECT policy would widen direct table access to satisfy a
--     requirement the RPC already satisfies more narrowly.
--   * It adds NO table GRANT. Nothing gains SELECT on organizations, profiles,
--     organization_members, roles, permissions, role_permissions, member_roles,
--     vendor_retailers, retailer_shops, or retailer_invitations.
--   * It creates NO organization, profile, membership, role assignment,
--     retailer, shop, or invitation row. Catalogue data only, exactly as
--     migrations 6, 11, and 15 did.
--   * It modifies no existing migration, function, policy, table, or column.
--
-- Dependencies: migration 1 (identity), 2 (rbac), 8 (retailer_shops), and
--   15 (the seeded RETAILER_OWNER role these permissions map to).

-- ============================================================================
-- PART 1 — Permissions
-- ============================================================================
-- Two permissions, not one. They are separated because they gate genuinely
-- different reads and will diverge: RETAILER_PORTAL_READ gates the owner's view
-- of their own organization (name, status, country, currency, counts), while
-- RETAILER_SHOPS_READ gates the shop list. A future RETAILER_STAFF role that may
-- see the portal shell but not the full shop estate needs the first without the
-- second, and that must be a role_permissions row rather than a function
-- rewrite. Collapsing them into one code now would make that impossible to
-- express later without a migration that widens an existing grant.
--
-- These are NEW codes rather than a reuse of RETAILERS_READ (migration 11).
-- RETAILERS_READ is deliberately not reused: it is the VENDOR-side permission,
-- evaluated through public.has_vendor_retailer_permission(), which authorizes a
-- Vendor member to read EVERY Retailer their vendor organization manages. Its
-- whole meaning is cross-tenant. Granting it to RETAILER_OWNER would not merely
-- be untidy — it would make every existing migration-9 policy
-- (organizations_select_vendor_managed_retailers,
--  vendor_retailers_select_vendor_authorized,
--  retailer_shops_select_vendor_authorized) start returning rows to Retailer
-- Owners, because those policies test that exact code. The isolation this
-- milestone is built to preserve would be gone in one INSERT. A Retailer Owner's
-- permission to read their OWN retailer is a different fact from a Vendor's
-- permission to read the retailers it MANAGES, and the two must not share a
-- code.
--
-- `module` is RETAILER_PORTAL, following the one-module-per-domain convention
-- alongside ORGANIZATION_MEMBERS, RBAC, AUDIT_LOGS, and RETAILERS.
--
-- Idempotency: upsert on the unique `code` (permissions_code_unique), matching
-- migrations 6, 11, and 15 exactly. Only the human-readable fields and module
-- are refreshed; `id` is never rewritten, so any role_permissions FK already
-- pointing at these rows survives a re-run. Nothing is deleted.
insert into public.permissions (code, name, description, module)
values
  (
    'RETAILER_PORTAL_READ',
    'Read Own Retailer Portal',
    'Read the authenticated Retailer Owner''s own Retailer organization context.',
    'RETAILER_PORTAL'
  ),
  (
    'RETAILER_SHOPS_READ',
    'Read Own Retailer Shops',
    'Read the shop locations belonging to the authenticated Retailer Owner''s own Retailer organization.',
    'RETAILER_PORTAL'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- ============================================================================
-- PART 2 — Precondition: the target role must exist
-- ============================================================================
-- The mapping in Part 3 resolves its role by code. If RETAILER_OWNER were
-- missing, that SELECT would return no rows: the INSERT would write nothing, the
-- migration would report success, and both permissions would sit in the
-- catalogue assigned to nobody. Every portal RPC would then return no rows to
-- everyone, and the only symptom would be a portal that looks empty rather than
-- broken — fail-closed, but silently. Migration 15 seeds RETAILER_OWNER, so this
-- cannot fire in a correctly ordered history, which is exactly why it is worth
-- stating: it fires only when an assumption this migration depends on has
-- already broken.
--
-- This reads one row and writes nothing.
do $$
begin
  if not exists (
    select 1
    from public.roles r
    where r.code = 'RETAILER_OWNER'
  ) then
    raise exception 'Seed precondition failed: role RETAILER_OWNER does not exist, so the Retailer Owner portal permissions cannot be assigned';
  end if;
end;
$$;

-- ============================================================================
-- PART 3 — Role -> permission mapping
-- ============================================================================
-- Both permissions go to RETAILER_OWNER, and only to it. The WHERE clause names
-- exactly one role code, so no mapping row can reach VENDOR_SUPER_ADMIN,
-- CLAIM_REVIEWER, FINANCE_ADMIN, or any role added later. A future role that
-- should hold these needs its own deliberate migration.
--
-- The ids are resolved by joining on code rather than written literally, keeping
-- the migration independent of generated UUIDs. roles.code and permissions.code
-- are both unique, so this cross join yields precisely 1 x 2 = 2 rows.
--
-- ON CONFLICT DO NOTHING targets role_permissions_pkey (role_id, permission_id):
-- a re-run is a no-op and an existing mapping is left exactly as it is rather
-- than rewritten. No existing role_permissions row is updated or deleted by this
-- migration, so every permission every other role already holds is preserved.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'RETAILER_OWNER'
  and p.code in ('RETAILER_PORTAL_READ', 'RETAILER_SHOPS_READ')
on conflict (role_id, permission_id) do nothing;

-- ============================================================================
-- PART 4 — Internal resolver
-- ============================================================================
-- resolve_retailer_owner_organization(target_permission_code text) -> uuid
--
-- Resolves the ONE Retailer organization the caller owns and holds
-- target_permission_code in, or NULL. Both portal RPCs call this, so the
-- authorization chain is written once and cannot drift between them — the
-- failure mode this exists to prevent is the context RPC and the shop RPC
-- disagreeing about who is authorized, which would be invisible until it
-- mattered.
--
-- The chain, in full, mirrors public.has_organization_permission() condition for
-- condition and adds two:
--
--   auth.uid() is not null                          -- signed in
--   -> public.profiles p.id = auth.uid()            -- profile IS the auth user id
--   -> p.status = 'ACTIVE'                          -- INVITED/SUSPENDED/DEACTIVATED denied
--   -> public.organization_members m.user_id = p.id
--   -> m.status = 'ACTIVE'                          -- INVITED membership denied
--   -> public.organizations o.id = m.organization_id
--   -> o.status = 'ACTIVE'                          -- suspended/deactivated retailer denied
--   -> o.organization_type = 'RETAILER'             -- ADDED: a VENDOR org never qualifies
--   -> public.member_roles mr.organization_member_id = m.id
--   -> public.roles r.id = mr.role_id
--   -> r.status = 'ACTIVE'                          -- inactive role assignment denied
--   -> r.code = 'RETAILER_OWNER'                    -- ADDED: wrong role denied
--   -> public.role_permissions rp.role_id = r.id
--   -> public.permissions perm.code = target_permission_code
--
-- Nothing is loosened relative to the existing helper. The two additions only
-- narrow.
--
-- A note on "active role assignment": public.member_roles carries no status
-- column (migration 2) — it has only (organization_member_id, role_id,
-- assigned_by, assigned_at). Assignment liveness in this schema is therefore
-- expressed by public.roles.status, which is what r.status = 'ACTIVE' tests, and
-- by deleting the member_roles row. This function does not invent a per-
-- assignment status the schema does not have.
--
-- Vendor Super Admin alone can never qualify here, for three independent
-- reasons: their organization is organization_type = 'VENDOR'; they hold
-- VENDOR_SUPER_ADMIN, not RETAILER_OWNER; and they are deliberately NOT a member
-- of any Retailer they manage (see migration 8's rationale). A role or
-- membership held in ANY other organization cannot authorize this one either —
-- every join is chained off the SAME membership row m, so the role, the
-- permission, and the organization all come from one membership. There is no
-- path by which a role attached in organization A satisfies the check for
-- organization B.
--
-- MVP AMBIGUITY RULE — TEMPORARY LIMITATION:
-- The portal resolves AT MOST ONE Retailer context. When the caller qualifies in
-- exactly one organization, that organization is returned. When they qualify in
-- ZERO, the result is NULL. When they qualify in MORE THAN ONE, the result is
-- also NULL — the function FAILS CLOSED rather than silently picking an
-- arbitrary organization, because there is no user interface yet in which the
-- owner could see which one was chosen or switch away from it, and a portal that
-- quietly shows one of a person's two retailers is worse than one that shows
-- neither. This is an MVP constraint, NOT a security boundary: a future
-- organization switcher should replace this with an explicit, caller-chosen
-- organization that is still verified against this same chain, at which point
-- the count check below can be removed.
--
-- Security: SECURITY DEFINER because every table in the chain is RLS
-- default-deny to browser roles; the query is hard-filtered to auth.uid(), so it
-- can only ever report on the caller's own authorization and cannot be used to
-- probe another user. auth.uid() keeps working across the definer boundary
-- because it reads the request JWT claims from a GUC, not current_user — the
-- same reason the migration-4 helpers work inside RLS policies. search_path is
-- pinned to '' and every reference is fully qualified, so nothing resolves from
-- an attacker-controlled schema. No dynamic SQL, no writes.
--
-- This function returns a UUID and is therefore granted to NOBODY — see the
-- revokes below. It is an internal building block for the two RPCs, which are
-- SECURITY DEFINER and so execute it as this migration's role (its owner). No
-- browser role can call it, and no UUID it resolves ever reaches a client: the
-- two public RPCs consume it as a join key and return none of it.
create function public.resolve_retailer_owner_organization(
  target_permission_code text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with qualifying as (
    select distinct o.id
    from public.profiles p
    join public.organization_members m on m.user_id = p.id
    join public.organizations o on o.id = m.organization_id
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions perm on perm.id = rp.permission_id
    where target_permission_code is not null
      and auth.uid() is not null
      and p.id = auth.uid()
      and p.status = 'ACTIVE'
      and m.status = 'ACTIVE'
      and o.status = 'ACTIVE'
      and o.organization_type = 'RETAILER'
      and r.status = 'ACTIVE'
      and r.code = 'RETAILER_OWNER'
      and perm.code = target_permission_code
  )
  -- Exactly one qualifying organization, or nothing. The row is emitted only
  -- when the qualifying set holds precisely one member; the guard is a count
  -- over the same CTE, so it sees exactly what the outer select sees.
  --
  -- The rule is total across all three cases, and every case ends in NULL except
  -- the unambiguous one:
  --   * one qualifying organization  -> the guard holds, one row, that UUID.
  --   * zero qualifying organizations -> no candidate rows to emit. A scalar SQL
  --     function that returns no row yields NULL, so the callers' `id = NULL`
  --     comparison matches nothing.
  --   * two or more                   -> the guard is false for every candidate,
  --     so no row is emitted and the function again yields NULL. Failing closed
  --     is deliberate: there is no portal UI yet in which an owner could see
  --     which retailer was chosen or switch away from it.
  --
  -- No ordering aggregate is applied to the UUID itself. PostgreSQL defines
  -- none for the uuid type, and casting the id to text purely to make such an
  -- aggregate typecheck would be a silent arbitrary pick dressed up as
  -- arithmetic — the lexical ordering of a UUID is meaningless, so "the smallest
  -- one" is not a decision anyone made. Only count(*) is aggregated here, and it
  -- counts rows rather than inspecting ids.
  --
  -- The candidate set is likewise never truncated to a single row, deliberately:
  -- taking the first of several would be exactly the silent arbitrary choice the
  -- rule above forbids.
  select q.id
  from qualifying q
  where (select count(*) from qualifying) = 1;
$$;

-- Privileges. PostgreSQL grants EXECUTE to PUBLIC on every new function by
-- default, and PUBLIC is inherited by every role, so the first revoke is what
-- actually removes anon's and authenticated's access; the explicit per-role
-- revokes are belt and braces. NOTHING is granted back. This function is
-- reachable only from the two SECURITY DEFINER RPCs below, which run as its
-- owner.
revoke all     on function public.resolve_retailer_owner_organization(text) from public;
revoke execute on function public.resolve_retailer_owner_organization(text) from anon;
revoke execute on function public.resolve_retailer_owner_organization(text) from authenticated;

-- ============================================================================
-- PART 5 — get_retailer_owner_portal_context()
-- ============================================================================
-- Zero arguments, by design. There is no organization id, relationship id,
-- membership id, profile id, user id, email, role id, or permission id
-- parameter — the caller cannot nominate whose authorization is evaluated or
-- whose data is returned. Identity comes solely from auth.uid(), resolved inside
-- the Part 4 resolver.
--
-- Returns AT MOST ONE row. Zero rows is the single answer given to every
-- unauthorized caller: signed out, suspended profile, INVITED membership,
-- inactive membership, suspended or deactivated Retailer organization, missing
-- RETAILER_OWNER role, inactive role, missing RETAILER_PORTAL_READ permission,
-- Vendor Super Admin without a Retailer Owner membership, and the ambiguous
-- multi-retailer case all produce exactly the same empty result. The function
-- never distinguishes them to the caller, so it cannot be used as an oracle to
-- learn why access failed or whether a given account exists.
--
-- RETURNED COLUMNS — all seven are display data, and NONE is an identifier:
--   retailer_name      public.organizations.name
--   retailer_status    public.organizations.status
--   country_code       public.organizations.country_code      (nullable)
--   default_currency   public.organizations.default_currency  (nullable)
--   membership_status  public.organization_members.status
--   total_shop_count   count of the org's shops, all statuses
--   active_shop_count  count of the org's shops with status = 'ACTIVE'
--
-- NOT returned, deliberately: any UUID (organization, membership, profile, role,
-- permission, shop, relationship, invitation), the auth user id, any email
-- address, first/last name, mobile number, role codes, permission codes,
-- invitation state, audit metadata, timestamps, and service configuration. The
-- statuses that gate access are CONDITIONS, not output — retailer_status and
-- membership_status are returned because the portal shell displays them, and
-- both are necessarily 'ACTIVE' for any row that exists, since the resolver
-- would have returned NULL otherwise. They are honest, not informative, and that
-- is intentional: this migration follows migration 7's precedent of returning
-- only what the shell renders.
--
-- The shop counts are computed here rather than left to the client precisely so
-- the client never needs a shop id to count. They are scalar subqueries keyed on
-- the RESOLVED organization id, never a caller-supplied one.
create function public.get_retailer_owner_portal_context()
returns table (
  retailer_name     text,
  retailer_status   text,
  country_code      text,
  default_currency  text,
  membership_status text,
  total_shop_count  bigint,
  active_shop_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.name             as retailer_name,
    o.status           as retailer_status,
    o.country_code,
    o.default_currency,
    m.status           as membership_status,
    (
      select count(*)
      from public.retailer_shops s
      where s.retailer_organization_id = o.id
    )                  as total_shop_count,
    (
      select count(*)
      from public.retailer_shops s
      where s.retailer_organization_id = o.id
        and s.status = 'ACTIVE'
    )                  as active_shop_count
  from public.organizations o
  join public.organization_members m
    on m.organization_id = o.id
   and m.user_id = auth.uid()
  -- The single point of authorization. A NULL from the resolver — unauthorized,
  -- or ambiguous — makes this equality null-comparing, which matches no row, so
  -- the function returns nothing. There is no branch to get wrong.
  where o.id = public.resolve_retailer_owner_organization('RETAILER_PORTAL_READ');
$$;

-- Privileges: no implicit PUBLIC EXECUTE, nothing for anon, EXECUTE for
-- authenticated only — matching migration 7 exactly. The revoke of authenticated
-- before the grant is deliberate: the grant that follows is this migration's own
-- explicit decision rather than a privilege quietly inherited from PUBLIC.
--
-- anon is left with nothing and therefore cannot execute this at all. Note that
-- the function would ALSO return zero rows to anon on its own merits, because
-- auth.uid() is null for an unauthenticated request — the missing grant and the
-- fail-closed body are two independent defences, and neither relies on the
-- other.
revoke all     on function public.get_retailer_owner_portal_context() from public;
revoke execute on function public.get_retailer_owner_portal_context() from anon;
revoke execute on function public.get_retailer_owner_portal_context() from authenticated;
grant  execute on function public.get_retailer_owner_portal_context() to authenticated;

-- ============================================================================
-- PART 6 — list_retailer_owner_portal_shops()
-- ============================================================================
-- Zero arguments, for the same reason as Part 5: there is no caller-supplied
-- Retailer id, relationship id, or any other identifier to abuse. The shop scope
-- is the organization the RESOLVER returned, never anything the browser sent.
--
-- SHOP OWNERSHIP CHAIN. Shops are owned DIRECTLY by the Retailer organization:
-- public.retailer_shops.retailer_organization_id references
-- public.organizations(id) (migration 8). Ownership does NOT run through
-- public.vendor_retailers — that table records which VENDOR manages a retailer,
-- which is a separate fact and irrelevant to a Retailer Owner reading their own
-- estate. This function therefore joins shops to the resolved organization id
-- directly and never reads vendor_retailers at all. A Retailer Owner's view of
-- their own shops does not depend on, and is not filtered by, whether a vendor
-- relationship is ACTIVE, SUSPENDED, or DEACTIVATED — an owner does not stop
-- owning their shops because a vendor paused the commercial relationship.
--
-- SHOP STATUS IS NOT FILTERED. All of ACTIVE, SUSPENDED, and DEACTIVATED are
-- returned. This matches the existing Vendor detail behaviour exactly: the
-- migration-9 policy retailer_shops_select_vendor_authorized does not filter
-- status ("a closed or suspended shop stays visible to an authorized Vendor
-- user"), and lib/retailers/vendor-retailer-detail.ts selects shops with no
-- status predicate. Hiding non-ACTIVE shops from the OWNER — the party who
-- actually operates them — while showing them to the Vendor would be the wrong
-- way round, and would make a suspended shop indistinguishable from a deleted
-- one to the person best placed to notice the difference. The status column is
-- returned so the portal can render the distinction rather than imply every shop
-- is trading. active_shop_count in Part 5 is what surfaces the ACTIVE subset.
--
-- RETURNED COLUMNS — the same five the Vendor detail view renders
-- (lib/retailers/vendor-retailer-detail.ts selects "name, code, city,
-- country_code, status"), and no id:
--   shop_name     public.retailer_shops.name
--   shop_code     public.retailer_shops.code          (nullable)
--   city          public.retailer_shops.city          (nullable)
--   country_code  public.retailer_shops.country_code  (nullable)
--   shop_status   public.retailer_shops.status
--
-- No shop id is returned. The first portal milestone is read-only and has no
-- shop-detail route, so no identifier is needed; emitting one would create a
-- client contract that a later milestone has to keep. Address lines, region,
-- postal code, timestamps, and the owning organization id are all withheld —
-- the first three because the list does not render them, the last because it is
-- a UUID the client must never need.
--
-- Deterministic ordering. name is the display sort, code breaks ties between
-- same-named shops, and id is the final tiebreak that makes the order TOTAL —
-- without it, two shops sharing a name and a null code could swap places between
-- requests. id is used purely as a sort key inside the function; it is not
-- selected and never leaves. NULLS LAST is stated explicitly rather than left to
-- the default so the placement of code-less shops does not depend on the sort
-- direction's default null ordering.
--
-- No writes, no audit rows, no side effects: this is a plain SELECT in a STABLE
-- function, which the database will not permit to write. It reads exactly two
-- tables — public.retailer_shops here and, inside the resolver, the identity and
-- RBAC tables. It never touches public.retailer_invitations or any auth schema
-- object.
create function public.list_retailer_owner_portal_shops()
returns table (
  shop_name    text,
  shop_code    text,
  city         text,
  country_code text,
  shop_status  text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.name   as shop_name,
    s.code   as shop_code,
    s.city,
    s.country_code,
    s.status as shop_status
  from public.retailer_shops s
  -- Same single point of authorization as Part 5, with the permission that
  -- gates THIS read. A caller holding RETAILER_PORTAL_READ but not
  -- RETAILER_SHOPS_READ resolves NULL here and receives no shops, even though
  -- the context RPC answers them. NULL matches no row, so an unauthorized or
  -- ambiguous caller gets an empty list rather than another retailer's estate.
  where s.retailer_organization_id
        = public.resolve_retailer_owner_organization('RETAILER_SHOPS_READ')
  order by s.name, s.code nulls last, s.id;
$$;

-- Privileges: identical posture to Part 5 and migration 7.
revoke all     on function public.list_retailer_owner_portal_shops() from public;
revoke execute on function public.list_retailer_owner_portal_shops() from anon;
revoke execute on function public.list_retailer_owner_portal_shops() from authenticated;
grant  execute on function public.list_retailer_owner_portal_shops() to authenticated;

-- ============================================================================
-- PART 7 — Function ownership
-- ============================================================================
-- No ALTER FUNCTION ... OWNER TO statement appears here, matching every existing
-- migration in this repository (none of the 20 SECURITY DEFINER functions
-- created so far sets an explicit owner). All three functions above are owned by
-- the role that runs the migration, which is the same role that owns the tables
-- they read — which is precisely what makes SECURITY DEFINER work here.
--
-- This is deliberate rather than an omission. Hard-coding an owner would pin
-- these functions to a role name that differs between a hosted Supabase project
-- and any other environment, and a wrong owner on a SECURITY DEFINER function is
-- either a broken function or a privilege escalation — neither is worth risking
-- to restate the default. The verifier asserts the resulting owner matches the
-- existing functions' owner instead, which checks the property that actually
-- matters without hard-coding it.
