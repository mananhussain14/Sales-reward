-- Migration: mobile_vendor_role_reads
-- Purpose: The reads a Vendor Super Admin needs to list the role catalogue, open ONE role,
--          and see the permissions that role grants, from a mobile client — and nothing
--          else. It adds, and only adds:
--            1. public.list_vendor_roles()                    [authenticated]
--            2. public.get_vendor_role_detail(uuid)           [authenticated]
--            3. public.list_vendor_role_permissions(uuid)     [authenticated]
--
-- THIS MIGRATION CHANGES NOTHING THAT IS ALREADY DEPLOYED. No table, column, constraint,
--   index, trigger, RLS policy, role, permission, or permission mapping is created,
--   altered or dropped. No existing function is edited, dropped, or replaced. No role seed
--   and no role→permission mapping is touched: the catalogue this migration reads is
--   exactly the catalogue 20260716133023, 20260720092755 and 20260722210000 seeded, and
--   this file adds not one row to it. No new permission is seeded either — RBAC_READ and
--   ORGANIZATION_MEMBERS_READ already exist and are already mapped to VENDOR_SUPER_ADMIN
--   (20260716133023), and they are the only permissions the functions below require.
--
-- ============================================================================
-- THE AUDIT FINDING THAT SHAPES EVERYTHING BELOW: ROLES ARE A GLOBAL CATALOGUE
-- ============================================================================
--   public.roles, public.permissions and public.role_permissions carry NO organization_id
--   (20260716125559). They are ONE catalogue of role and permission DEFINITIONS shared by
--   every organization in the platform. What is per-organization is the ASSIGNMENT of a
--   role to a member, which lives in public.member_roles and is keyed by
--   organization_member_id.
--
--   Three consequences follow, and each is a deliberate contract decision rather than an
--   oversight:
--
--   1. "The roles available within the trusted Vendor organization" resolves, under the
--      deployed schema, to THE WHOLE CATALOGUE. There is no Vendor-scoped subset to
--      return. The six seeded roles are VENDOR_SUPER_ADMIN, CLAIM_REVIEWER, FINANCE_ADMIN,
--      RETAILER_OWNER, RETAILER_MANAGER and SALES_STAFF, and app/(admin)/roles/page.tsx
--      shows a Vendor Super Admin ALL SIX today. list_vendor_roles() returns the same six.
--      Filtering to "Vendor roles" would require a scope or kind property that does not
--      exist, so it could only be inferred from the role CODE — which would be inventing a
--      taxonomy in a mobile read and would immediately disagree with the web.
--
--   2. THE ROLE CATALOGUE IS NOT TENANT-ISOLATED, AND THIS CONTRACT DOES NOT PRETEND IT IS.
--      Two Vendors see byte-identical role rows, because there is only one set of rows.
--      That is the shipped behaviour of roles_select_rbac_authorized (20260716131930),
--      which gates the catalogue WHOLESALE rather than per row. What IS tenant-isolated is
--      assigned_member_count: it counts memberships of the CALLER'S OWN Vendor and of no
--      other organization, so Vendor A and Vendor B read the same role names with different
--      counts. Section "assigned_member_count" below states the rule; the pgTAP suite
--      proves it in both directions.
--
--   3. There is therefore no "another Vendor's role" to leak. The non-leaking result the
--      detail read must deliver is the one for an id that names NO readable role at all:
--      unknown, null, or an id belonging to some other table. All three return zero rows.
--
-- ============================================================================
-- WHY THESE FUNCTIONS EXIST — THE GAP THE AUDIT FOUND
-- ============================================================================
--   The web assembles the Roles & Permissions page in TypeScript
--   (lib/rbac/vendor-rbac-catalog.ts): one authorization RPC, then THREE whole-table reads
--   — roles, permissions and role_permissions — with the role→permission join, the
--   permission grouping and both sorts performed in JavaScript. The query count is fixed
--   rather than per-role, so it is not N+1; but the join is business shape, not
--   presentation, and Flutter reimplementing it in Dart would be a second definition of
--   "which permissions does this role grant".
--
--   Worse for a mobile client, the web page returns rows carrying NO id of any kind — by
--   design, since it never navigates — so app/(admin)/roles/page.tsx keys both its role
--   list and its permission list by ARRAY INDEX. A mobile list can key nothing and open
--   nothing from that shape. This is the same defect docs/mobile-backend-contract.md § 6.3
--   records for the shop lists, and it is closed here the same way: role_id is returned,
--   and it is both the widget key and the detail selector.
--
--   There is also NO web role-detail page, and no role create, edit, delete or activate
--   page anywhere in the repository. app/(admin)/roles/ contains exactly page.tsx and
--   loading.tsx. The whole Roles surface is read-only in the shipped product, and no
--   Server Action, RPC or RLS policy exists that could write a role, a permission or a
--   role→permission mapping from a browser. So the detail read below has no web assembly
--   to reproduce: it is specified as the list row narrowed to one role, and nothing more.
--
-- NO TENANT INPUT, ANYWHERE
--   list_vendor_roles() takes NO arguments at all. get_vendor_role_detail() and
--   list_vendor_role_permissions() take exactly one: the public.roles row id, which SELECTS
--   which catalogue role is read and never decides WHETHER anything may be read. There is
--   no user id, auth user id, profile id, membership id, Vendor organization id, tenant id,
--   role CODE, permission id, permission CODE, permission set, or organization-context
--   parameter on any of the three.
--
--   THE ROLE ID IS THE SELECTOR, NOT THE ROLE CODE. roles.code is unique and would address
--   a role just as precisely — and that is exactly why it is refused. The codes
--   (VENDOR_SUPER_ADMIN, RBAC_READ, …) are the literals the migration-5 RLS policies and
--   the migration-4 helpers match on; accepting one as input would put authorization
--   vocabulary in a client's hands and invite a client to reason about it. The uuid is
--   opaque, is what the list already returned, and means nothing anywhere else.
--
-- MULTI-VENDOR BEHAVIOUR IS PRESERVED, NOT CHANGED
--   get_vendor_super_admin_context() returns one row per qualifying VENDOR organization,
--   ordered by organization id, and every existing Vendor RPC takes the first. A caller who
--   is a Super Admin of two Vendors therefore has their assigned_member_count computed
--   against the lowest-id Vendor, deterministically and on every request — the same rule
--   list_vendor_retailers(), list_vendor_users(), list_vendor_products() and the web itself
--   already follow. It is reproduced here verbatim rather than "fixed", because changing it
--   would change which organization an existing Vendor's numbers describe as a side effect
--   of a mobile read. It is documented as a limitation in
--   docs/mobile-vendor-role-reads-audit.md instead. Note that the role ROWS are unaffected
--   by the tie-break, since the catalogue is global; only the counts are.
--
-- Idempotency posture: plain CREATE (no IF NOT EXISTS, no CREATE OR REPLACE). A conflicting
--   existing object FAILS the migration. No dynamic SQL. No fixed UUIDs. Every reference is
--   schema-qualified because all three functions run with an EMPTY search_path. All
--   identifiers are <= 63 bytes.
--
-- Dependencies: 20260716124419 (organizations, profiles, organization_members),
--   20260716125559 (roles, permissions, role_permissions, member_roles and their indexes),
--   20260716131104 (has_organization_permission), 20260716133023 (the RBAC_READ and
--   ORGANIZATION_MEMBERS_READ permissions and their mappings to VENDOR_SUPER_ADMIN),
--   20260717083515 (get_vendor_super_admin_context).


-- ============================================================================
-- FUNCTION 1 — list_vendor_roles()
-- ============================================================================
-- Every role definition in the catalogue the calling Vendor Super Admin is authorized to
-- see, with the list-level facts a roles screen renders and nothing else.
--
-- ZERO ARGUMENTS. There is no Vendor id, role id, role code, permission code, or filter to
-- pass, so no URL segment, form field, header, or cookie can nominate what is returned.
--
-- UNAUTHORIZED IS AN EXCEPTION; A CATALOGUE WITH NOTHING IN IT IS AN EMPTY SET. A denial
-- and "there are no role definitions on record" are different facts and a client renders
-- them differently — app/(admin)/roles/page.tsx already distinguishes exactly these three
-- states (unavailable / none / rows), and this contract keeps them distinguishable. The
-- empty set is reachable only in a database whose role seeds have been removed, since a
-- caller cannot be authorized without holding VENDOR_SUPER_ADMIN, which is itself a row of
-- this catalogue; it remains the documented answer for a match-nothing query.
--
-- EVERY LIFECYCLE STATE IS LISTED, AND MARKED. role_status is returned and NOT filtered,
-- exactly as lib/rbac/vendor-rbac-catalog.ts does not filter it: "a catalogue that hid
-- INACTIVE definitions would misrepresent what is stored", and the definition itself is the
-- subject of this screen. (This is the opposite of list_vendor_users(), which DOES filter
-- role_names to ACTIVE — there an inactive definition must not be advertised as a live role
-- someone holds. The two are consistent, not contradictory: one describes the definition,
-- the other describes an assignment.)
--
-- COUNTS ARE COMPUTED IN SQL, NOT TRANSFERRED. Two correlated scalar aggregates inside a
-- single statement, so the wire carries one row per role instead of one row per mapping and
-- one row per assignment. A scalar subquery is evaluated once per role row and therefore
-- CANNOT duplicate a role, which is why no DISTINCT appears anywhere below — a DISTINCT
-- here would hide a genuine duplication bug rather than prevent one.
--
-- ROLE STATUS AND PERMISSION STATUS ARE NOT THE SAME QUESTION, AND ONLY ONE OF THEM EXISTS.
-- public.roles has a status column constrained to ('ACTIVE','INACTIVE'). public.permissions
-- HAS NO STATUS COLUMN AT ALL (20260716125559) — the catalogue is counted whole, exactly as
-- lib/dashboard/vendor-admin-summary.ts counts it whole. There is therefore no
-- active_permission_count to return: it would be a field whose value is always equal to
-- permission_count, which is a promise about a distinction the schema does not make.
--
-- NOT RETURNED, and the reason each is withheld:
--   role_code                      the internal literal the RLS policies and the
--                                  authorization helpers match on. lib/rbac/
--                                  vendor-rbac-catalog.ts deliberately never selects it
--                                  ("the codes … have no business in a page"), and neither
--                                  does this contract.
--   role_kind, is_system,          THERE IS NO SUCH COLUMN. Built-in and custom roles are
--     is_custom, is_editable       not stored differently, because there are no custom
--                                  roles: nothing in this product can create one. Deriving
--                                  a kind from the role name or code would be inventing a
--                                  taxonomy, which this milestone explicitly must not do.
--                                  is_editable would be worse still — it would advertise a
--                                  write path that does not exist.
--   organization_id                roles carry none. Returning the CALLER'S Vendor id
--                                  instead would be an id in a payload that a form could
--                                  echo back, for a value the caller already knows.
--   role_updated_at                misleading rather than merely redundant: the seed
--                                  migration is an upsert that sets updated_at = now() on
--                                  every re-run, so the column records when the seed last
--                                  ran, not when the role last changed. role_created_at is
--                                  untouched by that upsert and is returned.
--   permission rows                a directory row needs a count, not an inventory. The
--                                  permissions of ONE role come from
--                                  list_vendor_role_permissions() below.
--   permission ids, codes,         authorization internals are not display data, and the
--     modules                      web shows none of them.
--   member names, ids, statuses    this is a role catalogue, not a member directory. Only
--                                  the COUNT crosses the boundary; not one personal field
--                                  does. The member directory is list_vendor_users()
--                                  (20260801090000), which is where a Vendor goes to learn
--                                  WHO holds a role.
--   the caller's own permissions   get_my_portal_context() already carries presentation
--                                  hints; they are hints, and they authorize nothing here.
--   policy names, function names,  never returned by anything, anywhere.
--     grant text
create function public.list_vendor_roles()
returns table (
  role_id               uuid,
  role_name             text,
  role_description      text,
  role_status           text,
  role_created_at       timestamptz,
  permission_count      integer,
  assigned_member_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  -- Identity and Vendor, from auth.uid() alone. get_vendor_super_admin_context() accepts no
  -- arguments and evaluates the whole chain — ACTIVE profile owned by auth.uid(), ACTIVE
  -- membership, ACTIVE VENDOR organization, ACTIVE VENDOR_SUPER_ADMIN role. A signed-out
  -- caller, a Retailer Owner, a Retailer Manager, a Sales Staff member, a caller with no
  -- organization at all, a suspended profile and a deactivated membership all resolve to
  -- zero rows here.
  --
  -- ORDER BY / LIMIT 1 reproduces the shipped multi-Vendor rule; see the header.
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  -- BOTH permissions, because this read returns both kinds of fact, and each one stands in
  -- for the migration-5 policy this SECURITY DEFINER function runs outside of:
  --
  --   RBAC_READ                  roles_select_rbac_authorized (the role rows) and
  --                              role_permissions_select_rbac_authorized (the mapping the
  --                              permission_count aggregates).
  --   ORGANIZATION_MEMBERS_READ  organization_members_select_self_or_authorized, which is
  --                              what gates the membership rows assigned_member_count is
  --                              computed over. member_roles alone would need only
  --                              RBAC_READ; the count also reads organization_members, so
  --                              it also requires that table's permission. Requiring both
  --                              is what keeps this function from being a way to learn the
  --                              size of a Vendor's membership that RLS would have refused.
  --
  -- Fail closed, and generically. The message names no table, column, policy, Vendor, role
  -- or permission: one refusal for "not signed in", "not a Vendor Super Admin", and "this
  -- Vendor's role does not hold the permissions" alike.
  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'RBAC_READ')
     or not public.has_organization_permission(v_vendor, 'ORGANIZATION_MEMBERS_READ') then
    raise exception 'Not authorized to view Vendor roles'
      using errcode = 'insufficient_privilege';
  end if;

  -- ONE statement, whatever the role count, and one row per role whatever the permission or
  -- member count.
  --
  -- Row multiplicity is fixed by the schema rather than by a DISTINCT: public.roles is
  -- scanned once and the two aggregates are scalar subqueries, not joins, so neither a role
  -- with twelve permissions nor a role held by forty members can emit more than one row. A
  -- role with no permissions and no members emits one row with two zeroes, because count(*)
  -- over an empty set is 0 and never NULL.
  --
  -- Expected access: a sequential scan of the six-row public.roles, then per role a
  -- primary-key range scan of role_permissions (its PK leads on role_id) and an index scan
  -- of member_roles_role_id_idx followed by primary-key probes of organization_members. No
  -- index is added by this migration because every predicate is already served.
  return query
  select
    r.id,
    r.name,
    r.description,
    r.status,
    r.created_at,
    (
      -- Joined to public.permissions rather than counted straight off the mapping table so
      -- that permission_count is BY CONSTRUCTION the number of rows
      -- list_vendor_role_permissions() returns for the same role. The two can never
      -- disagree. (The FK is ON DELETE CASCADE, so a dangling mapping cannot exist and the
      -- join drops nothing today; the point is that it could never drift if one did.)
      select count(*)
      from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
      where rp.role_id = r.id
    )::integer,
    (
      -- THE ONLY TENANT-SCOPED VALUE IN THIS CONTRACT, and the only reason a global
      -- catalogue means anything to one Vendor: how many of MY OWN members hold this role.
      -- m.organization_id is compared against the Vendor derived above — never against a
      -- parameter — so assignments in any other organization are invisible. A Retailer role
      -- therefore reads 0 for a Vendor, which is the true answer and not a hidden row.
      --
      -- Counting is set-wise and cannot double-count: member_roles is keyed by
      -- (organization_member_id, role_id), so one membership holds one role at most once,
      -- and organization_members is unique on (organization_id, user_id), so one person has
      -- at most one membership in this Vendor. A person holding three roles contributes 1
      -- to each of three counts, never 3 to one.
      --
      -- NO MEMBERSHIP OR PROFILE STATUS FILTER, matching the directory this number will be
      -- reconciled against: lib/members/vendor-organization-members.ts filters neither, and
      -- list_vendor_users() lists every lifecycle state. A count that silently excluded a
      -- SUSPENDED or INVITED member would contradict the very screen it sits next to. It is
      -- an assignment count, not a headcount of active staff.
      --
      -- NO ROLE STATUS FILTER EITHER, and deliberately: role_status is returned as its own
      -- column, so a retired definition still held by four people reports 4 — which is
      -- exactly what an administrator needs to see before retiring it further. Note the
      -- honest consequence: for an INACTIVE role this count and list_vendor_users()
      -- role_names disagree by design, because that list hides inactive DEFINITIONS. Both
      -- are documented; neither is a bug.
      select count(*)
      from public.member_roles mr
      join public.organization_members m
        on m.id = mr.organization_member_id
      where mr.role_id = r.id
        and m.organization_id = v_vendor
    )::integer
  from public.roles r
  -- Deterministic and total: two roles sharing a name cannot swap places between requests,
  -- because the role id breaks the tie. Same ordering shape as list_vendor_users() and
  -- list_vendor_retailers(). The name comparison uses the database collation rather than
  -- the web's localeCompare(…, "en"); the two agree on the seeded names and the web is
  -- unchanged either way, which is why this is documented rather than reconciled.
  order by r.name, r.id;
end;
$$;

revoke all     on function public.list_vendor_roles() from public;
revoke execute on function public.list_vendor_roles() from anon;
grant  execute on function public.list_vendor_roles() to authenticated;


-- ============================================================================
-- FUNCTION 2 — get_vendor_role_detail(uuid)
-- ============================================================================
-- ONE role of the catalogue, addressed by the role id — the same id list_vendor_roles()
-- returned.
--
-- THE COLUMN SET IS THE LIST'S, EXACTLY. Not a superset: public.roles has seven columns and
-- five of them are already in the list; the sixth is `code`, which this contract refuses,
-- and the seventh is `updated_at`, which the header explains is a record of the last seed
-- run. There is genuinely nothing further to show about a role definition, so inventing a
-- wider detail shape would mean inventing data. One Flutter model therefore deserializes
-- both reads, and a future column has to be added to both or to neither.
--
-- SO WHY DOES IT EXIST AT ALL, IF IT RETURNS A ROW THE LIST ALREADY RETURNED? Because a
-- detail SCREEN needs three things a list cannot give it: a refresh that costs one row
-- instead of the whole catalogue, a deep link that can be opened without first loading the
-- list, and — most importantly — an AUTHORITATIVE ANSWER to "is this id addressable by me",
-- which is what makes zero rows here the signal a client acts on when
-- list_vendor_role_permissions() also returns nothing. Without it, an empty permission list
-- would be ambiguous between "this role grants nothing" and "this role does not exist".
--
-- AN ID THAT NAMES NO ROLE RETURNS ZERO ROWS, NOT AN ERROR — and so does null. This is the
-- important difference from the authorization raise. The caller IS an authorized Vendor
-- Super Admin; they have simply named something that is not a role. "Zero rows" is
-- byte-identical for an unknown uuid, a uuid belonging to some other table, and null.
--
-- THERE IS NO "ANOTHER VENDOR'S ROLE" TO REFUSE. The catalogue is global (see the header),
-- so every role readable by one authorized Vendor is readable by all of them, and the
-- tenant-sensitive value — assigned_member_count — is recomputed against the CALLING
-- Vendor. Vendor A and Vendor B opening the same role id get the same name, description and
-- status, and their own member counts. That is the shipped web behaviour, stated precisely
-- rather than quietly narrowed.
create function public.get_vendor_role_detail(
  p_role_id uuid
)
returns table (
  role_id               uuid,
  role_name             text,
  role_description      text,
  role_status           text,
  role_created_at       timestamptz,
  permission_count      integer,
  assigned_member_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'RBAC_READ')
     or not public.has_organization_permission(v_vendor, 'ORGANIZATION_MEMBERS_READ') then
    raise exception 'Not authorized to view Vendor roles'
      using errcode = 'insufficient_privilege';
  end if;

  -- A null id names no role, and returning zero rows keeps it indistinguishable from every
  -- other id that names no role.
  if p_role_id is null then
    return;
  end if;

  -- Byte-identical to the list's projection, including both aggregates and their scoping,
  -- so a role's numbers on the detail screen are the numbers it showed in the list. The
  -- only difference is the WHERE clause.
  return query
  select
    r.id,
    r.name,
    r.description,
    r.status,
    r.created_at,
    (
      select count(*)
      from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
      where rp.role_id = r.id
    )::integer,
    (
      select count(*)
      from public.member_roles mr
      join public.organization_members m
        on m.id = mr.organization_member_id
      where mr.role_id = r.id
        and m.organization_id = v_vendor
    )::integer
  from public.roles r
  where r.id = p_role_id;
end;
$$;

revoke all     on function public.get_vendor_role_detail(uuid) from public;
revoke execute on function public.get_vendor_role_detail(uuid) from anon;
grant  execute on function public.get_vendor_role_detail(uuid) to authenticated;


-- ============================================================================
-- FUNCTION 3 — list_vendor_role_permissions(uuid)
-- ============================================================================
-- The permissions granted by ONE role — the companion read get_vendor_role_detail()
-- deliberately does not nest.
--
-- WHY A COMPANION RATHER THAN AN ARRAY OR A JSON BLOB IN THE DETAIL ROW.
--   A permission is a PAIR (name, description), so it cannot be carried by a typed
--   text[] — the shape this schema's other aggregate contracts use (list_vendor_users()
--   role_names). The remaining single-call options are a jsonb array or a text[] of names
--   with the descriptions dropped. Dropping the descriptions would return LESS than the web
--   page shows today, and a jsonb array would make the field the one part of this
--   milestone's contract with no column types, no catalogue-level assertion of its shape,
--   and nothing to stop a later edit adding a key.
--
--   The catalogue is also open-ended in the direction that matters: it has grown with every
--   module built so far (RBAC and members, then retailers, shops, owner invitations,
--   staff, receipts, products), and each future module — campaigns, claims, coins,
--   payouts — seeds more. A role that eventually grants all of them would make the detail
--   row grow without bound, which is precisely the condition under which nesting is wrong.
--
--   The cost is one extra round trip on a detail screen, and it is the same trade
--   list_vendor_retailer_shops() (20260731090000) already made for shops, for the same
--   reason. A client may issue both reads concurrently; the detail read is the
--   authoritative one for existence.
--
-- SAME SELECTOR, SAME AUTHORIZATION SHAPE, SAME NON-LEAKING RESULT. It is addressed by the
-- role id, so the two operations cannot drift into two address spaces. An unknown or null
-- role yields zero rows — the same answer a genuinely permission-less role of the catalogue
-- gives. That ambiguity is in the safe direction, and it is why a client calls the detail
-- read: zero rows THERE is the authoritative "this id is not a role".
--
-- ONE PERMISSION REQUIREMENT, NOT TWO. This read touches public.roles, public.permissions
-- and public.role_permissions and NOTHING else — no membership, no profile, no assignment.
-- The migration-5 policies over exactly those three tables require RBAC_READ, so RBAC_READ
-- is what this function requires. Demanding ORGANIZATION_MEMBERS_READ as well would be
-- asking for a permission the read has no use for; the two functions above ask for it only
-- because they return a count derived from organization_members.
--
-- THE COLUMNS ARE THE TWO THE WEB ROLES PAGE ALREADY DISPLAYS, AND NO MORE.
-- app/(admin)/roles/page.tsx renders exactly `permission.name` over
-- `permission.description` — one component, used for both the per-role list and the whole
-- catalogue section.
--
-- PERMISSION CODES ARE NOT RETURNED. The milestone rule is that a code may appear only when
-- the existing product intentionally shows it as a user-facing catalogue value. It does
-- not: lib/rbac/vendor-rbac-catalog.ts states in terms that `code` is "deliberately never
-- selected from either catalogue table" because the codes are "the internal literals the
-- RLS policies match on". They are authorization vocabulary — the same strings
-- has_organization_permission() matches — and publishing them to a mobile client would
-- invite the client to reason about authorization it must never compute.
--
-- MODULE IS NOT RETURNED EITHER, and this is the one candidate field that was genuinely
-- arguable. public.permissions.module is a real NOT NULL column ('RBAC',
-- 'ORGANIZATION_MEMBERS', 'RETAILERS', …), and grouping a long permission list by module
-- would be a better screen. But the web neither displays nor groups by it, the stored
-- values are SCREAMING_CASE internal category labels rather than display strings, and this
-- milestone is read-only and additive. Returning it would mean shipping a field with no
-- user-facing precedent and no screen asking for it. When a Flutter design actually groups
-- permissions, module is added deliberately, with a display mapping — not inferred now.
--
-- NOT RETURNED: permission id; permission code; module; created_at / updated_at; the
-- role_permissions mapping row (it has no id of its own — its primary key IS the pair); the
-- assigning actor (there is no such column); any policy name, function name, RLS expression
-- or grant text; and any permission NOT mapped to the selected role. In particular the
-- whole-catalogue permission list that app/(admin)/roles/page.tsx renders in its second
-- section is NOT reachable through this operation, which answers only "what does THIS role
-- grant".
create function public.list_vendor_role_permissions(
  p_role_id uuid
)
returns table (
  permission_name        text,
  permission_description text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'RBAC_READ') then
    raise exception 'Not authorized to view Vendor roles'
      using errcode = 'insufficient_privilege';
  end if;

  if p_role_id is null then
    return;
  end if;

  -- The permissions are reached THROUGH the mapping row, never named directly, so only the
  -- selected role's grants can be returned: there is no permission id, code or set in the
  -- signature that could widen this to the rest of the catalogue.
  --
  -- No DISTINCT is needed and none is used: role_permissions is keyed by (role_id,
  -- permission_id), so a role maps a permission at most once, and the join to permissions
  -- is on a primary key. A duplicate permission row here would be a real bug and this query
  -- would expose it rather than mask it.
  --
  -- Ordering by name then id is deterministic and total, matching the web's alphabetical
  -- permission list while remaining stable for two permissions that share a display name.
  -- The id is ordered ON but never returned — a tie-break does not have to be visible to be
  -- effective.
  return query
  select
    p.name,
    p.description
  from public.role_permissions rp
  join public.permissions p on p.id = rp.permission_id
  where rp.role_id = p_role_id
  order by p.name, p.id;
end;
$$;

revoke all     on function public.list_vendor_role_permissions(uuid) from public;
revoke execute on function public.list_vendor_role_permissions(uuid) from anon;
grant  execute on function public.list_vendor_role_permissions(uuid) to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- Three read functions. Nothing else exists in this migration. No table, column,
-- constraint, index, trigger, RLS policy, role, permission, or mapping is created or
-- altered; no existing function is touched; no role seed or role→permission assignment is
-- changed by so much as one row; and no table privilege is granted to any browser role —
-- the migration-5 read policies on public.roles, public.permissions,
-- public.role_permissions, public.member_roles and public.organization_members are
-- unchanged, and authenticated still holds SELECT and nothing more on each of them.
--
-- No index is added: every predicate above is served by an existing one (the
-- role_permissions primary key on (role_id, permission_id), member_roles_role_id_idx, the
-- organization_members and permissions primary keys), and a speculative index would be a
-- cost with no measured cause. roles is a six-row table scanned once per call.
--
-- service_role is granted nothing here. All three reads derive their authority from
-- auth.uid(), which a service-role connection does not have, so granting it would produce
-- functions that can only ever refuse.
--
-- The web is untouched. lib/rbac/vendor-rbac-catalog.ts keeps performing its own three
-- reads and app/(admin)/roles/page.tsx renders exactly what it rendered before; these
-- functions are additive and have no caller in this repository yet.
