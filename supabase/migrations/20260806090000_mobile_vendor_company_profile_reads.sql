-- Migration: mobile_vendor_company_profile_reads
-- Purpose: The ONE read that is genuinely missing before a Vendor Super Admin can be shown
--          their own company-and-profile screen on mobile. It adds, and only adds:
--            1. public.get_my_vendor_profile()  [authenticated]
--
--          It returns the calling administrator's OWN display name and OWN active Vendor role
--          names, and NOTHING ELSE. In particular it deliberately does NOT return the Vendor
--          organization's name, because public.get_my_portal_context() already returns exactly
--          that value with exactly the trusted semantics this screen needs, and a second source
--          for it would be a second thing to keep true.
--
-- THIS MIGRATION CHANGES NOTHING THAT IS ALREADY DEPLOYED. No table, column, constraint, index,
--   trigger, RLS policy, role, permission or permission mapping is created, altered or dropped.
--   No existing function is edited, dropped or replaced — get_my_portal_context() in particular
--   is untouched, because both the web sign-in path and the shipped Flutter routing already
--   consume it and an additive new function is strictly safer than editing a live contract. No
--   seed row is written. No audit row is written — reading one's own name is not an event.
--   public.profiles, public.organization_members, public.member_roles and public.roles all keep
--   the exact posture 20260716124419, 20260716125559 and 20260716131930 left them in: RLS
--   enabled, SELECT-only to `authenticated`, nothing at all to `anon`.
--
-- THE WEB IS NOT CHANGED AND HAS NOTHING TO MIGRATE. There is no /settings route, no /company
--   route, no /organization route, no /profile route and no /account route in this application.
--   The Settings item in components/admin/nav-items.tsx is `disabled: true` — a deliberate
--   "Coming soon" placeholder that renders as non-navigable text. Nothing in this migration is
--   consumed by the web today.
--
-- ============================================================================
-- WHAT THE AUDIT FOUND — THERE IS NO VENDOR COMPANY OR PROFILE SURFACE ON THE WEB
-- ============================================================================
-- The full audit is docs/mobile-vendor-company-profile-reads-audit.md. The three findings that
-- decide the shape of this migration:
--
-- FINDING 1 — THE ENTIRE COMPANY SURFACE IS ONE FIELD: THE ORGANIZATION NAME.
--   Every place the shipped web application displays anything about the Vendor's own company,
--   it displays `organizations.name` and nothing else:
--     * components/admin/admin-header.tsx  — the name, plus initials DERIVED from the name.
--     * app/(admin)/users/page.tsx         — "Members of <name>".
--     * app/(admin)/page.tsx, /products, /roles, /audit-logs — the name in a page description.
--   No web surface anywhere reads the Vendor's own organizations row directly. `country_code`,
--   `default_currency`, `status`, `created_at` and `updated_at` EXIST on public.organizations
--   and are NEVER displayed for the caller's own Vendor — lib/retailers/vendor-retailer-detail.ts
--   selects them, but for a RETAILER organization the Vendor administers, which is a different
--   screen about a different tenant. Returning them here would be inventing a product decision
--   inside a migration and freezing it into a pinned mobile contract before any web surface had
--   ever had to defend it.
--
--   AND THE COLUMNS FOR A "COMPANY PROFILE" DO NOT EXIST AT ALL. public.organizations has
--   exactly eight columns: id, name, organization_type, status, country_code, default_currency,
--   created_at, updated_at. There is NO legal name, NO trading name, NO registration
--   identifier, NO tax identifier, NO website, NO business phone, NO business email, NO postal
--   address and NO logo column anywhere in the schema. There is nothing to withhold, because
--   there is nothing stored.
--
--   Since get_my_portal_context() already returns `vendor.organization_name` — resolved through
--   get_vendor_super_admin_context(), i.e. the same authorization chain and the same column the
--   web header reads — THE COMPANY HALF OF THE MOBILE SCREEN NEEDS NO NEW BACKEND AT ALL.
--   Flutter must take the company name from PortalContext. This function does not return it,
--   and pgTAP asserts that it does not.
--
-- FINDING 2 — THE PERSONAL SURFACE IS THE CALLER'S NAME AND THE CALLER'S ROLES.
--   The web displays the signed-in administrator's own name in the header (assembled by
--   lib/auth/vendor-admin-access.ts from the first_name/last_name that
--   get_vendor_super_admin_context() returns), and it displays the caller's own membership
--   status, profile status and role names in ONE place: their own row inside the /users
--   directory, alongside every other member.
--
--   PortalContext does NOT return the caller's name — its `vendor` block is
--   {organization_id, organization_name} and nothing else — so the caller's own name is not a
--   PortalContext duplication. get_vendor_super_admin_context() returns the two raw name PARTS,
--   which would make a Dart client the THIRD place in this codebase to implement "trim the
--   parts, drop the empty ones, join with one space" (the other two being
--   lib/auth/vendor-admin-access.ts and list_vendor_users()/get_vendor_user_detail(), which
--   already moved that rule into SQL). The composed name is returned here, byte-identically to
--   those two functions, so the two clients cannot disagree about what a person is called.
--
-- FINDING 3 — THE REAL GAP IS SELF-IDENTIFICATION, AND IT IS THE ONLY GAP.
--   list_vendor_users() (20260801090000) already returns every Vendor user's display name,
--   statuses and role names — but it carries NO marker for which row is the CALLER, and its
--   only id is the membership id it did not tell the caller is theirs. So the only way a mobile
--   client could render "your role" today is to download the entire Vendor directory and guess
--   which row is itself by matching the display name it composed from
--   get_vendor_super_admin_context(). Two people who share a name break that, and it puts every
--   colleague's status on the wire to render one field about oneself. That is the anti-pattern
--   this function exists to remove, and it is the whole reason it exists.
--
--   The alternative considered and REJECTED was to return the caller's own membership_id so a
--   client could call get_vendor_user_detail() on itself. It is rejected because that function
--   is the DIRECTORY read — "one of the people I administer" — and reusing it as "me" would
--   conflate two different subjects behind one contract, while additionally putting a row id in
--   a payload for a navigation flow that does not exist. A self-read must not be addressed by a
--   selector at all; see "NO INPUT, ANYWHERE" below.
--
-- ============================================================================
-- WHY NO STATUS COLUMN IS RETURNED — THE STATUSES ARE CONDITIONS, NOT OUTPUT
-- ============================================================================
-- THIS IS THE SUBTLEST DECISION IN THIS MIGRATION AND IT IS DELIBERATE.
--
-- The obvious fields for a "my profile" screen are administrator_profile_status and
-- administrator_membership_status, and public.profiles.status / public.organization_members.
-- status are real columns the web genuinely renders (as badges, on /users). They are NOT
-- returned here, because for THIS caller they are not information:
-- get_vendor_super_admin_context() admits a caller only when p.status = 'ACTIVE' AND
-- m.status = 'ACTIVE' AND o.status = 'ACTIVE' AND r.status = 'ACTIVE'. An authorized caller of
-- this function is therefore ACTIVE in all three by construction, so the columns could only
-- ever hold the single literal 'ACTIVE'.
--
-- Shipping a column whose value is provably constant is worse than omitting it: it invites a
-- client to build a badge that can never change, and it implies a per-caller fact the contract
-- cannot actually vary. The installed convention says exactly this — get_vendor_super_admin_
-- context() (20260717083515) documents "no status columns: the statuses are CONDITIONS here, not
-- output", and get_vendor_admin_dashboard_summary() (20260805090000) repeats it. This function
-- follows that convention rather than inventing a third answer.
--
-- The consequence for Flutter is stated positively in the audit document: a caller who receives
-- a row from this function IS an active administrator of an active Vendor, and that is what the
-- screen may say. A caller who is not receives 42501 and has no profile screen to render at all.
-- The three statuses are NEVER combined into one "Account status" — they are simply not
-- returned, individually or together.
--
-- Nor is any timestamp returned. profiles.created_at, organization_members.created_at,
-- organization_members.joined_at, organizations.created_at and every updated_at are real
-- columns and NONE of them is displayed by any web surface in this product. get_vendor_user_
-- detail() returns two membership timestamps for a DIRECTORY subject, and that precedent is
-- deliberately not extended to the caller's own screen here: "Member since" is a product
-- decision no shipped surface has made, and it is additive later without breaking anyone.
--
-- ============================================================================
-- NO INPUT, ANYWHERE
-- ============================================================================
-- The function takes ZERO ARGUMENTS. There is no auth user id, profile id, membership id,
-- organization id, Vendor id, tenant id, role code, permission code, email, profile selector or
-- organization selector on it. There is nothing for a client to supply and therefore nothing for
-- a client to forge:
--
--   * WHOSE PROFILE — from auth.uid(), and from nothing else. `m.user_id = auth.uid()` is the
--     self predicate, and it is compared against the verified request claims rather than against
--     a parameter. No caller can ask for another person's profile, because there is no way to
--     name one.
--   * WHICH VENDOR — derived server-side through public.get_vendor_super_admin_context(),
--     exactly as every other Vendor RPC in this schema derives it. No caller can ask about
--     another Vendor, because there is no way to name one.
--
-- ============================================================================
-- MULTI-VENDOR BEHAVIOUR IS PRESERVED, NOT CHANGED
-- ============================================================================
-- get_vendor_super_admin_context() returns one row per qualifying VENDOR organization, ordered
-- by organization id, and every existing Vendor RPC takes the first. A caller who is a Super
-- Admin of two Vendors therefore sees the roles held in the LOWEST-ID Vendor, deterministically
-- and on every request — the shipped behaviour of get_my_portal_context(), list_vendor_users(),
-- list_vendor_retailers(), list_vendor_products(), list_vendor_audit_logs(),
-- get_vendor_admin_dashboard_summary() and of the web's own getVendorSuperAdminAccess(), which
-- takes contextRows[0] from the same ordered set. It is reproduced here verbatim rather than
-- "fixed": changing it would change which organization an existing operator is shown as a side
-- effect of a mobile read, and there is no organization switcher in which anyone could see or
-- change the choice. It is documented as a limitation in
-- docs/mobile-vendor-company-profile-reads-audit.md § 9 instead.
--
-- IT ALSO MEANS THE COMPANY AND THE PROFILE CANNOT DISAGREE. get_my_portal_context() resolves
-- its `vendor` block from the same function with the same `order by organization_id limit 1`, so
-- the organization name a Flutter screen shows from PortalContext and the roles it shows from
-- this function are always about the SAME Vendor for the same caller.
--
-- ============================================================================
-- Idempotency posture
-- ============================================================================
-- Plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE). A conflicting existing object
-- FAILS the migration. No dynamic SQL. No fixed UUIDs. Every reference is schema-qualified
-- because the function runs with an EMPTY search_path. All identifiers are <= 63 bytes.
--
-- Dependencies: 20260716124419 (profiles, organization_members and the unique
--   (organization_id, user_id) key), 20260716125559 (roles, member_roles),
--   20260716131104 (has_organization_permission), 20260716133023 (the RBAC_READ permission and
--   its VENDOR_SUPER_ADMIN mapping), 20260717083515 (get_vendor_super_admin_context).
--   20260729090000 (get_my_portal_context) is a COMPANION, not a dependency: this function does
--   not call it and is not called by it. They are composed by the client.


-- ============================================================================
-- FUNCTION — get_my_vendor_profile()
-- ============================================================================
-- Exactly one row about the CALLER THEMSELVES, for a caller who is an active Vendor Super Admin.
--
-- ----------------------------------------------------------------------------
-- AUTHORIZATION: THE VENDOR SUPER ADMIN ROLE *AND* RBAC_READ, WITH ONE GENERIC REFUSAL
-- ----------------------------------------------------------------------------
-- The caller must clear BOTH gates:
--   1. get_vendor_super_admin_context() must yield a Vendor — an ACTIVE profile owned by
--      auth.uid(), an ACTIVE membership, an ACTIVE organization of type VENDOR, and an ACTIVE
--      VENDOR_SUPER_ADMIN role. A signed-out caller, an authenticated caller with no
--      organization, a Vendor member with no role, a Retailer Owner, a Retailer Manager, a Sales
--      Staff member, a suspended profile, a suspended or deactivated membership and a suspended
--      or deactivated organization ALL resolve to zero rows here.
--   2. has_organization_permission(<that Vendor>, 'RBAC_READ') must be true.
--
-- RBAC_READ IS THE REAL, ALREADY-SEEDED CODE (20260716133023, module RBAC), already mapped to
-- VENDOR_SUPER_ADMIN, and it is exactly the permission the migration-5 policy
-- roles_select_rbac_authorized requires of a browser client reading public.roles — which is
-- where the role NAMES below come from. Nothing is invented and no permission is seeded here.
--
-- WHY RBAC_READ AND *NOT* ORGANIZATION_MEMBERS_READ. This is a self-read, and the migration-5
-- policies are explicit that a person's OWN rows need no permission at all: profiles_select_self
-- _or_authorized_members admits `public.profiles.id = auth.uid()` unconditionally,
-- organization_members_select_self_or_authorized admits `user_id = auth.uid()` unconditionally,
-- and member_roles_select_self_or_rbac_authorized admits an assignment on the caller's own
-- membership unconditionally. Requiring ORGANIZATION_MEMBERS_READ would therefore assert
-- something untrue — that reading one's own name is a directory capability — and would refuse a
-- caller data RLS grants them by ownership. The ONLY fact here that the caller does not own is
-- the global role CATALOGUE row that supplies the display name, and RBAC_READ is precisely its
-- gate. So the requirement is the union of what the returned facts require, and no more.
--
-- REQUIRING THE ROLE *AND* THE PERMISSION IS NARROWER THAN THE RLS POLICIES, WHICH ARE `OR`s
-- (RBAC_READ **or** the VENDOR_SUPER_ADMIN role). Narrower is safe by construction: it can only
-- refuse callers the policies would have admitted, never admit one they would refuse.
-- Concretely, a Vendor Super Admin whose role has had RBAC_READ withdrawn is refused HERE while
-- the web /users page would still render their row — the correct direction, asserted in pgTAP by
-- removing the seeded mapping. It also means THIS READ CAN NEVER BE MORE PERMISSIVE THAN
-- list_vendor_users(), which requires RBAC_READ too: a client cannot learn a role name here that
-- the directory read would refuse it.
--
-- THE REFUSAL IS ONE GENERIC 42501 FOR EVERY FAILING CASE. The message names no table, column,
-- policy, permission, Vendor, person or row: "not signed in", "not a Vendor Super Admin", "your
-- membership is suspended", "your organization is suspended" and "your role no longer holds
-- RBAC_READ" are byte-identical to the client. It never reveals whether another organization or
-- profile exists, and it CANNOT be used to probe one, because it has no parameter naming one. An
-- authorization failure is never converted into an empty profile: a row of nulls, or a row whose
-- display name was a placeholder, would let a denied caller render a profile screen for an
-- identity they do not hold.
--
-- ----------------------------------------------------------------------------
-- EXACTLY ONE ROW, ALWAYS, AND NEVER A NULL FIELD
-- ----------------------------------------------------------------------------
-- Both properties are STRUCTURAL rather than guarded:
--
--   * ONE ROW. public.organization_members is UNIQUE on (organization_id, user_id)
--     (organization_members_unique_membership), so `organization_id = v_vendor AND user_id =
--     auth.uid()` matches AT MOST one row; and it matches AT LEAST one, because v_vendor was
--     itself derived by joining THROUGH that membership. The profiles join is on a primary key,
--     and the roles are a correlated scalar aggregate rather than a join, so nothing can
--     multiply the row. A caller cannot receive two rows by holding two roles, two memberships,
--     or a membership in another organization. Zero rows is not a reachable outcome for an
--     authorized caller, so a client never has to distinguish "no profile" from "an empty
--     profile" — and a denial is an exception, never zero rows.
--   * NEVER NULL. administrator_display_name is composed from two NOT NULL columns that each
--     carry a `length(trim(...)) > 0` CHECK (20260716124419), with a defensive floor below; and
--     administrator_role_names is coalesced to an empty array, which for an authorized caller is
--     itself unreachable — the ACTIVE VENDOR_SUPER_ADMIN role that authorized them is always in
--     it. NEITHER FIELD IS OPTIONAL, so neither is nullable, and there is no documented null
--     case to handle.
--
-- ----------------------------------------------------------------------------
-- THE TWO FIELDS, EXACTLY
-- ----------------------------------------------------------------------------
-- 1. administrator_display_name  — PERSONAL data. The caller's own name.
--      Source:     public.profiles.first_name and .last_name, for the row whose id IS
--                  auth.uid() (profiles.id is the auth user id, 1:1 — 20260716124419), reached
--                  through the caller's own membership in the derived Vendor.
--      Composition: trim each part, drop the empty ones, join with one space — byte-identical to
--                  list_vendor_users(), get_vendor_user_detail() and
--                  lib/auth/vendor-admin-access.ts, so no client composes it itself.
--      Fallback:   'Member', matching the two SQL functions above rather than the web header's
--                  'Vendor Admin'. Both floors are unreachable (see the CHECK constraints), and
--                  matching the SQL convention keeps ONE answer inside the database. Recorded in
--                  the audit document rather than reconciled, because changing the web header's
--                  literal would be a visible web change.
--      Live value: YES. It reflects the profile row as it stands, not a snapshot.
--      In PortalContext? NO. PortalContext returns no caller name at all.
--
-- 2. administrator_role_names  — the caller's role, as the product NAMES it.
--      Source:     public.roles.name, for the ACTIVE role definitions assigned to the caller's
--                  OWN membership in the derived Vendor (public.member_roles).
--      Why an array: member_roles is keyed by (organization_member_id, role_id), so one
--                  membership genuinely may hold several roles, and /users renders exactly that
--                  (comma-joined, with "No active role" when empty). A scalar would have to pick
--                  one and would be lying whenever there were two. Same type and same ordering
--                  as list_vendor_users().role_names, so ONE Flutter model deserializes both.
--      ACTIVE only: an INACTIVE role definition still assigned to someone is not advertised as a
--                  live role — the same filter the web applies.
--      NAMES, NOT CODES: 'Vendor Super Admin', never 'VENDOR_SUPER_ADMIN'. The codes are the
--                  literals the RLS policies match on; they are authorization vocabulary, not
--                  display data, and no read RPC in this schema returns one.
--      Tenant scope: the roles of the caller's membership IN THE DERIVED VENDOR only. A role the
--                  same person holds in a Retailer organization, or in a second Vendor, cannot
--                  appear — member_roles is reached only through that one membership row.
--      Ordering:   `order by r.name, r.id`, so the array is stable across requests and a client
--                  rendering it joined never sees it reshuffle.
--
-- ----------------------------------------------------------------------------
-- NOT RETURNED, and the reason each is withheld
-- ----------------------------------------------------------------------------
--   organization name, organization id  get_my_portal_context() already returns both, resolved
--                                       through the SAME authorization chain. Duplicating the
--                                       name would create a second source of truth for the one
--                                       company field the product has; returning the id would
--                                       put a tenant identifier in a payload that a form could
--                                       echo back as if it were authorization. Flutter takes the
--                                       company name from PortalContext — that is a REQUIREMENT
--                                       of this contract, not a suggestion.
--   organization status, country,       real columns, never displayed for the caller's own
--     currency, created_at, updated_at  Vendor by any web surface. See FINDING 1.
--   legal name, trading name,           NO SUCH COLUMN EXISTS anywhere in the schema. There is
--     registration id, tax id,          nothing stored to return, and inventing a field for a
--     website, business phone,          value the product does not hold would freeze a promise
--     business email, postal address    into a pinned mobile contract.
--   logo, avatar, image reference       NO SUCH COLUMN EXISTS, and the only Storage bucket in
--                                       this project is `receipts` (20260726090000), which is
--                                       PRIVATE with zero policies and unrelated to identity.
--                                       Both clients render initials derived from a name
--                                       (components/ui/avatar.tsx, admin-header.tsx). No image
--                                       path, public URL or signed URL is returned, and no Edge
--                                       Function is introduced for an image the product does not
--                                       display.
--   profile status, membership status,  ACTIVE by construction for every authorized caller — the
--     organization status               statuses are CONDITIONS in the chain above, not output.
--                                       See the dedicated section in the header.
--   any timestamp                       no web surface displays one for the caller. See above.
--   auth user id                        profiles.id IS the auth.users id. It is the subject
--                                       Supabase Auth mints tokens for; it is neither accepted
--                                       nor returned, under any column name.
--   profile id, membership id           no navigation flow addresses this screen, so no id is
--                                       needed. The membership id in particular is the selector
--                                       of the DIRECTORY contract, and handing it out here would
--                                       invite "my profile" to be re-fetched as a directory row.
--   email                               lives in auth.users, which this function does not read.
--                                       No Vendor web surface displays an email address.
--   mobile_number                       a private profile column the Vendor UI has never shown.
--   role codes, role ids,               internal authorization vocabulary. This function reads
--     permission codes, permission      public.permissions and public.role_permissions NOT AT
--     rows, module names                ALL — the one permission CHECK goes through the existing
--                                       helper, which returns a boolean and no rows.
--   other members' anything             the self predicate is `m.user_id = auth.uid()`. No other
--                                       person's name, status or role can appear in this row,
--                                       and there is no parameter through which one could be
--                                       requested. list_vendor_users() remains the ONLY read
--                                       that returns other people, under its own permissions.
--   raw metadata, app_metadata,         auth.users is never queried, and no jsonb column is read
--     user_metadata, provider data      or returned. Every output is a typed scalar or a text[].
--   tokens, hashes, invitations,        never returned by anything, anywhere. Neither invitation
--     passwords, sessions, MFA          table is read here, and both are Retailer-scoped anyway.
--   ip_address, user_agent              audit columns; public.audit_logs is not read.
--   billing, subscription, payment,     no such table exists in this schema.
--     invoice, tax or bank data
create function public.get_my_vendor_profile()
returns table (
  administrator_display_name text,
  administrator_role_names   text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  -- Identity and Vendor, from auth.uid() alone, ONCE per call. get_vendor_super_admin_context()
  -- accepts no arguments and evaluates the whole chain: ACTIVE profile owned by auth.uid(),
  -- ACTIVE membership, ACTIVE organization of type VENDOR, ACTIVE VENDOR_SUPER_ADMIN role.
  -- ORDER BY / LIMIT 1 reproduces the shipped multi-Vendor rule; see the header.
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  -- Fail closed, and generically. Both gates are evaluated as one condition so that no caller
  -- can tell WHICH one refused them — every failure is byte-identical.
  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'RBAC_READ') then
    raise exception 'Not authorized to view your Vendor administrator profile'
      using errcode = 'insufficient_privilege';
  end if;

  -- ONE statement. One row, structurally (see the header): the unique (organization_id, user_id)
  -- key bounds it above, and the derivation of v_vendor through this very membership bounds it
  -- below.
  --
  -- ACCESS PATHS — MEASURED, and reported as measured rather than as assumed. EXPLAIN (ANALYZE,
  -- BUFFERS) on a local reset with 5,000 profiles, 5,000 memberships split across two Vendors and
  -- 5,000 role assignments, with the caller's JWT claim set:
  --
  --   organization_members  Index Scan using ORGANIZATION_MEMBERS_USER_ID_IDX (user_id), with
  --                         `organization_id = v_vendor` applied as a FILTER on the one row it
  --                         returns. NOTE: this is NOT the unique (organization_id, user_id) key,
  --                         which is the index one would expect from the predicate pair — the
  --                         planner prefers the single-column user_id index because auth.uid()
  --                         already selects exactly one row, so leading on organization_id would
  --                         scan a whole tenant to find it. Both indexes are shipped
  --                         (20260716124419) and either outcome is correct; this is what was
  --                         actually chosen.
  --   profiles              Index Scan using profiles_pkey.
  --   member_roles          Index Only Scan using member_roles_pkey (leads on
  --                         organization_member_id), Heap Fetches: 1.
  --   roles                 Seq Scan of the single-digit catalogue, filtered on status. There is
  --                         a roles_status_idx, and the planner correctly declines it at this
  --                         size — reading six rows through an index is worse than reading them
  --                         directly.
  --
  --   Total: 10 shared buffers, 0.16 ms execution. Nested Loop throughout; no sort of any
  --   relation, no hash, no parallel plan, and no sequential scan of any table that grows.
  --
  -- NO INDEX IS ADDED BY THIS MIGRATION. Every predicate is served by an existing index and the
  -- measured cost is a fraction of a millisecond, so a speculative index would be a write cost
  -- paid on every membership and role change for no read benefit.
  return query
  select
    -- The same composition lib/auth/vendor-admin-access.ts, list_vendor_users() and
    -- get_vendor_user_detail() perform. Both columns are NOT NULL and both carry a
    -- `length(trim(...)) > 0` CHECK, so the fallback is a defensive floor rather than a reachable
    -- branch — it exists so a loosened constraint could never render a nameless profile, and it
    -- is the same literal the other two SQL functions use so the database cannot disagree with
    -- itself about what a nameless person is called.
    coalesce(
      nullif(btrim(btrim(p.first_name) || ' ' || btrim(p.last_name)), ''),
      'Member'
    ) as administrator_display_name,
    -- Byte-identical to list_vendor_users().role_names, including the ACTIVE filter and the
    -- ordering, so the roles the caller sees on their own profile screen are the roles they see
    -- on their own directory row. A correlated aggregate, not a join, so two roles cannot become
    -- two rows. A cross-organization assignment cannot appear: member_roles is keyed by
    -- organization_member_id, and the only membership reached here is the caller's own in the
    -- derived Vendor.
    coalesce(
      (
        select array_agg(r.name order by r.name, r.id)
        from public.member_roles mr
        join public.roles r on r.id = mr.role_id
        where mr.organization_member_id = m.id
          and r.status = 'ACTIVE'
      ),
      '{}'::text[]
    ) as administrator_role_names
  from public.organization_members m
  join public.profiles p on p.id = m.user_id
  -- THE TWO PREDICATES THAT MAKE THIS A SELF-READ INSIDE ONE TENANT, and neither is a parameter.
  -- The tenant predicate is compared against the Vendor derived above; the self predicate is
  -- compared against the verified request claims. Together they admit exactly one row and there
  -- is no input that could widen either.
  where m.organization_id = v_vendor
    and m.user_id = auth.uid();
end;
$$;

revoke all     on function public.get_my_vendor_profile() from public;
revoke execute on function public.get_my_vendor_profile() from anon;
grant  execute on function public.get_my_vendor_profile() to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- One read function. Nothing else exists in this migration. No table, column, constraint, index,
-- trigger, RLS policy, role, permission or mapping is created or altered; no existing function
-- is touched — get_my_portal_context() and get_vendor_super_admin_context() in particular are
-- consumed exactly as they already exist; no seed row is written; no audit row is written; and no
-- table privilege is granted to any browser role. public.profiles, public.organization_members,
-- public.member_roles and public.roles keep exactly the SELECT-only, RLS-governed posture
-- 20260716131930 left them in, and RLS is neither disabled nor weakened anywhere.
--
-- service_role is granted nothing here. This read derives its authority from auth.uid(), which a
-- service-role connection does not have, so granting it would produce a function that can only
-- ever refuse.
--
-- Nothing in this migration writes: there is no insert, update or delete anywhere in the
-- function, and it is declared STABLE, so it cannot create, edit, delete or clear any row.
--
-- WHAT THIS DOES NOT ENABLE, DELIBERATELY: there is no company edit, no profile edit, no name
-- change, no email change, no password change, no phone change, no address change, no logo or
-- avatar upload, no image deletion, no invitation, no activation or deactivation, no role
-- assignment, no permission assignment, no organization switch and no organization create or
-- delete anywhere in this migration or anywhere in this product. This milestone is read-only, and
-- the schema has no write path for company or profile data to expose even if it were not.
