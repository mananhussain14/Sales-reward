-- Migration: mobile_vendor_user_reads
-- Purpose: The reads a Vendor Super Admin needs to list the users of their own Vendor
--          organization and open ONE of them from a mobile client, and nothing else. It
--          adds, and only adds:
--            1. public.list_vendor_users()                    [authenticated]
--            2. public.get_vendor_user_detail(uuid)           [authenticated]
--
-- THIS MIGRATION CHANGES NOTHING THAT IS ALREADY DEPLOYED. No table, column, constraint,
--   index, trigger, RLS policy, role, permission, or permission mapping is created,
--   altered or dropped. No existing function is edited, dropped, or replaced. No new
--   permission is seeded: ORGANIZATION_MEMBERS_READ and RBAC_READ already exist and are
--   already mapped to VENDOR_SUPER_ADMIN (20260716133023), and they are the two
--   permissions both functions below require.
--
-- WHY THESE FUNCTIONS EXIST — THE GAP THE AUDIT FOUND
--   The web assembles the Vendor user directory in TypeScript
--   (lib/members/vendor-organization-members.ts): one authorization RPC, then FOUR table
--   reads — organization_members, then profiles `in (…)`, then member_roles `in (…)`, then
--   roles `in (…)` — with the join, the role grouping, and the sort all performed in
--   JavaScript. The query count is fixed rather than per-member, but the join is business
--   shape, not presentation, and Flutter reimplementing it in Dart would be a second place
--   for the tenant scoping and the ACTIVE-role filter to be got wrong.
--
--   There is also NO web user-detail page at all. `app/(admin)/users/` contains only
--   page.tsx and loading.tsx; there is no `[…]/page.tsx` route and no detail data module.
--   So the detail read below has no web assembly to reproduce — it is specified as the
--   list row plus the two membership lifecycle timestamps that only a single-user screen
--   has room to show, and nothing more.
--
-- THERE IS NO VENDOR USER INVITATION TABLE, AND THIS MIGRATION DOES NOT INVENT ONE.
--   The schema has exactly two invitation tables. public.retailer_invitations
--   (20260720092755) is constrained by public.retailer_invitations_assert_organization_types
--   to a VENDOR inviter and a RETAILER target, and
--   public.retailer_staff_invitations (20260723090000) carries no vendor_organization_id at
--   all and is asserted RETAILER-only. Both create their membership in a RETAILER
--   organization. NOTHING in this schema invites a user into a VENDOR organization.
--
--   The "invited" state of a Vendor user is therefore not an invitation row: it is
--   public.organization_members.status = 'INVITED' and public.profiles.status = 'INVITED',
--   both of which are ordinary columns of the rows these functions already return. So there
--   is no combined typed list to build, no invitation id space to keep apart from the
--   membership id space, no token or token hash that could be leaked, and no companion
--   invitation-detail operation to justify. A row kind discriminator would be a field with
--   exactly one possible value, which is a promise about a table that does not exist.
--   Section "Status semantics" of docs/mobile-vendor-user-reads-audit.md records this in
--   full; if Vendor user invitations are ever built, they arrive as their own operation.
--
-- NO TENANT INPUT, ANYWHERE
--   list_vendor_users() takes NO arguments at all. get_vendor_user_detail() takes exactly
--   one: the public.organization_members row id, which SELECTS which already-authorized
--   membership is read and never decides WHETHER anything may be read. There is no user id,
--   auth user id, profile id, Vendor organization id, role, permission code, tenant id, or
--   email parameter on either function.
--
--   THE MEMBERSHIP ID IS THE SELECTOR, NOT THE PROFILE ID OR THE AUTH USER ID. A membership
--   row is the tenant boundary itself: it names one person IN ONE ORGANIZATION, so scoping
--   it to the caller's Vendor is a predicate on the same row. A profile id is not — one
--   profile may hold memberships in several organizations, so a profile id names a person
--   globally and would have to be narrowed back down to a membership before it could be
--   authorized. An auth user id is worse still: it is the identity Supabase Auth issues
--   tokens for, and it is neither returned nor accepted anywhere below.
--
-- MULTI-VENDOR BEHAVIOUR IS PRESERVED, NOT CHANGED
--   get_vendor_super_admin_context() returns one row per qualifying VENDOR organization,
--   ordered by organization id, and every existing Vendor RPC takes the first. A caller who
--   is a Super Admin of two Vendors therefore sees the lowest-id Vendor's users,
--   deterministically and on every request — the same rule list_vendor_retailers(),
--   list_vendor_products() and the web itself already follow. It is reproduced here
--   verbatim rather than "fixed", because changing it would change which users an existing
--   Vendor sees as a side effect of a mobile read. It is documented as a limitation in
--   docs/mobile-vendor-user-reads-audit.md instead.
--
-- Idempotency posture: plain CREATE (no IF NOT EXISTS, no CREATE OR REPLACE). A conflicting
--   existing object FAILS the migration. No dynamic SQL. No fixed UUIDs. Every reference is
--   schema-qualified because both functions run with an EMPTY search_path. All identifiers
--   are <= 63 bytes.
--
-- Dependencies: 20260716124419 (organizations, profiles, organization_members),
--   20260716125559 (roles, member_roles), 20260716131104 (has_organization_permission),
--   20260716133023 (the ORGANIZATION_MEMBERS_READ and RBAC_READ permissions and their
--   mappings to VENDOR_SUPER_ADMIN), 20260717083515 (get_vendor_super_admin_context).


-- ============================================================================
-- FUNCTION 1 — list_vendor_users()
-- ============================================================================
-- Every user of the calling Vendor Super Admin's own Vendor organization, with the
-- list-level facts the directory screen renders and nothing else.
--
-- ZERO ARGUMENTS. There is no Vendor id, membership id, user id, or filter to pass, so no
-- URL segment, form field, header, or cookie can nominate whose directory is returned.
--
-- UNAUTHORIZED IS AN EXCEPTION; A DIRECTORY WITH NOTHING IN IT IS AN EMPTY SET. A denial
-- and "this Vendor has no other users" are different facts and a client renders them
-- differently. Note the honest consequence of the authorization chain, which the audit
-- document states as a contract guarantee rather than an accident: an authorized caller is
-- BY DEFINITION an ACTIVE member of the Vendor they are listing, so their own row is always
-- present and the result is never actually empty. A Vendor with one administrator and no
-- one else returns exactly one row. The empty set remains the documented answer for a
-- match-nothing query; it is simply not reachable while the caller is authorized.
--
-- EVERY LIFECYCLE STATE IS LISTED. Membership status and profile status are both returned
-- and NEITHER is filtered, exactly as the web directory does not filter them: a directory
-- that hid SUSPENDED or DEACTIVATED people would misrepresent what is stored, and an
-- INVITED row is precisely how a not-yet-active Vendor user appears. The status is shown
-- per row instead.
--
-- ROLES ARE AGGREGATED IN SQL, ONE ARRAY PER USER. member_roles is keyed by
-- (organization_member_id, role_id), so one membership may hold several roles. A join would
-- therefore emit one row per role and duplicate the user; the correlated array_agg below
-- cannot, because it is evaluated once per membership row. Only ACTIVE role definitions are
-- included — the same filter lib/members/vendor-organization-members.ts applies, so an
-- INACTIVE definition still assigned to someone is not advertised as a live role. A user
-- with no qualifying role gets an EMPTY ARRAY, never NULL and never a fabricated default:
-- an unknown role must never be reported as VENDOR_SUPER_ADMIN, and the web renders exactly
-- this case as "No active role".
--
-- NOT RETURNED, and the reason each is withheld:
--   auth user id                   profiles.id IS the auth.users id (20260716124419). It is
--                                  the subject Supabase Auth mints tokens for, it is the
--                                  selector this contract deliberately refuses, and it has
--                                  no use on a directory screen. Neither function returns
--                                  it, under any column name.
--   email                          it lives in auth.users, the web Vendor Users page does
--                                  not query it and does not display it, and this milestone
--                                  is not the place to widen what the Vendor may see about
--                                  a person. Recorded as a known limitation.
--   mobile_number                  a private profile field the Vendor UI has never shown.
--   organization_id, user_id       the caller already knows which Vendor they are, and the
--                                  profile id is the identifier this contract does not use.
--   role ids, role codes           names are what a screen renders; codes are internal
--                                  authorization vocabulary.
--   permission rows and codes      authorization internals are not display data. Nothing
--                                  below reads public.permissions or role_permissions at
--                                  all — the two permission CHECKS go through the existing
--                                  helper, which returns a boolean and no rows.
--   invitation anything            there are no Vendor user invitations (see the header).
--   password or provider metadata  never read; auth.users is not touched by either function.
--   updated_at, deactivated_at     administration trivia at list level. deactivated_at is
--                                  returned by the DETAIL read, where a single-user screen
--                                  has room for it and a reason to want it.
create function public.list_vendor_users()
returns table (
  membership_id         uuid,
  display_name          text,
  profile_status        text,
  membership_status     text,
  membership_created_at timestamptz,
  joined_at             timestamptz,
  role_names            text[]
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
  -- organization at all, a suspended profile and a suspended membership all resolve to zero
  -- rows here.
  --
  -- ORDER BY / LIMIT 1 reproduces the shipped multi-Vendor rule; see the header.
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  -- BOTH permissions, because this read returns both kinds of fact. The web page needs
  -- ORGANIZATION_MEMBERS_READ to see organization_members and profiles, and RBAC_READ to
  -- see member_roles and roles — those are the exact permissions the migration-5 policies
  -- require of it (profiles_select_self_or_authorized_members,
  -- organization_members_select_self_or_authorized, member_roles_select_self_or_rbac_
  -- authorized, roles_select_rbac_authorized). This function is SECURITY DEFINER and so
  -- runs outside those policies; requiring both here is what keeps it from being a way to
  -- read role assignments that RLS would have refused.
  --
  -- Fail closed, and generically. The message names no table, column, policy, Vendor, or
  -- user: one refusal for "not signed in", "not a Vendor Super Admin", and "this Vendor's
  -- role does not hold the permissions" alike.
  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'ORGANIZATION_MEMBERS_READ')
     or not public.has_organization_permission(v_vendor, 'RBAC_READ') then
    raise exception 'Not authorized to view Vendor users'
      using errcode = 'insufficient_privilege';
  end if;

  -- ONE statement, whatever the user count, and one row per user whatever the role count.
  --
  -- Row multiplicity is fixed by the schema rather than by a DISTINCT: organization_members
  -- has at most one row per (organization_id, user_id) pair
  -- (organization_members_unique_membership), and the profiles join is on a primary key. The
  -- roles are a scalar subquery, not a join, so they cannot multiply anything.
  --
  -- The membership scan is served by organization_members_org_status_idx, whose leading
  -- column is organization_id; the profile lookup is a primary-key probe; each role
  -- aggregate is a primary-key range scan of member_roles (its PK leads on
  -- organization_member_id) followed by primary-key probes of roles. No index is added by
  -- this migration because none of those predicates needs one.
  --
  -- The inner select computes display_name once so the ORDER BY can sort on it without
  -- repeating the expression, and every reference below is alias-qualified so no identifier
  -- can be read as one of this function's OUT parameters.
  return query
  select
    u.membership_id,
    u.display_name,
    u.profile_status,
    u.membership_status,
    u.membership_created_at,
    u.joined_at,
    u.role_names
  from (
    select
      m.id                                            as membership_id,
      -- The same composition lib/members/vendor-organization-members.ts performs: trim the
      -- parts, drop the empty ones, join with a single space. Both columns are NOT NULL and
      -- both carry a `length(trim(...)) > 0` CHECK (20260716124419), so the fallback is a
      -- defensive floor rather than a reachable branch — it exists so that a loosened
      -- constraint could never render a nameless row, and it is the same literal the web
      -- uses so the two clients cannot disagree about what a nameless row is called.
      coalesce(
        nullif(btrim(btrim(p.first_name) || ' ' || btrim(p.last_name)), ''),
        'Member'
      )                                               as display_name,
      p.status                                        as profile_status,
      m.status                                        as membership_status,
      m.created_at                                    as membership_created_at,
      m.joined_at                                     as joined_at,
      coalesce(
        (
          select array_agg(r.name order by r.name, r.id)
          from public.member_roles mr
          join public.roles r on r.id = mr.role_id
          where mr.organization_member_id = m.id
            and r.status = 'ACTIVE'
        ),
        '{}'::text[]
      )                                               as role_names
    from public.organization_members m
    join public.profiles p on p.id = m.user_id
    -- The ONLY tenant predicate, and it is compared against the Vendor derived above —
    -- never against a parameter. A profile with memberships in several organizations
    -- contributes exactly the one membership that belongs to this Vendor, so no
    -- cross-organization row can appear.
    where m.organization_id = v_vendor
  ) u
  -- Deterministic and total: two users sharing a display name cannot swap places between
  -- requests, because the membership id breaks the tie. Same ordering shape as
  -- list_vendor_retailers(). The name comparison uses the database collation rather than the
  -- web's localeCompare(…, "en"); the two agree on ordinary names and the web is unchanged
  -- either way, which is why this is documented rather than reconciled.
  order by u.display_name, u.membership_id;
end;
$$;

revoke all     on function public.list_vendor_users() from public;
revoke execute on function public.list_vendor_users() from anon;
grant  execute on function public.list_vendor_users() to authenticated;


-- ============================================================================
-- FUNCTION 2 — get_vendor_user_detail(uuid)
-- ============================================================================
-- ONE user of the calling Vendor's own organization, addressed by the membership id — the
-- same id list_vendor_users() returned.
--
-- THE MEMBERSHIP ID IS AN ADDRESS, NOT AUTHORIZATION. Holding one grants nothing: the
-- Vendor is derived above it from auth.uid(), and the row is matched on BOTH its own id AND
-- that derived Vendor, so another Vendor's membership id matches nothing here.
--
-- AN ID THAT IS NOT YOURS RETURNS ZERO ROWS, NOT AN ERROR — and so does an id that no row
-- owns, and so does null. This is the important difference from the authorization raise
-- above. The caller IS an authorized Vendor Super Admin; they have simply named a
-- membership they may not read. A distinguishable refusal would confirm that another
-- Vendor's user EXISTS, and by sweeping ids, roughly how many. "Zero rows" is byte-
-- identical for a nonexistent id, another Vendor's id, a Retailer membership id, and null.
--
-- ONE ROW, FIXED SIZE. The column set is list_vendor_users() PLUS exactly one column:
-- deactivated_at, the membership lifecycle timestamp a single-user screen has room to show
-- and a directory row does not. Every other column is byte-identical in name, type, and
-- meaning, so one Flutter model deserializes both and a future addition has to be made to
-- both or to neither.
--
-- NO STATUS FILTER. A SUSPENDED, DEACTIVATED or INVITED membership is readable here for the
-- same reason it is listed above: the detail screen is where a Vendor goes to understand a
-- state, so refusing to open the very rows that need explaining would be backwards.
--
-- NOT RETURNED: the auth user id; email; mobile number; password, provider, session or
-- login metadata of any kind; role ids, role codes, permission rows or permission codes;
-- the Vendor organization id; the profile id; any membership in another organization; any
-- invitation field, token or hash (there are no Vendor user invitations at all); any
-- receipt, reward, sales or audit data.
create function public.get_vendor_user_detail(
  p_membership_id uuid
)
returns table (
  membership_id         uuid,
  display_name          text,
  profile_status        text,
  membership_status     text,
  membership_created_at timestamptz,
  joined_at             timestamptz,
  deactivated_at        timestamptz,
  role_names            text[]
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
     or not public.has_organization_permission(v_vendor, 'ORGANIZATION_MEMBERS_READ')
     or not public.has_organization_permission(v_vendor, 'RBAC_READ') then
    raise exception 'Not authorized to view Vendor users'
      using errcode = 'insufficient_privilege';
  end if;

  -- A null id names no row, and returning zero rows keeps it indistinguishable from every
  -- other id that names no row this caller may read.
  if p_membership_id is null then
    return;
  end if;

  -- The organization_id predicate is what makes a foreign membership id inert. It is
  -- compared against the Vendor derived above — never against a parameter. Note that it also
  -- makes a RETAILER membership id inert: those rows exist, but not in this organization.
  return query
  select
    u.membership_id,
    u.display_name,
    u.profile_status,
    u.membership_status,
    u.membership_created_at,
    u.joined_at,
    u.deactivated_at,
    u.role_names
  from (
    select
      m.id                                            as membership_id,
      coalesce(
        nullif(btrim(btrim(p.first_name) || ' ' || btrim(p.last_name)), ''),
        'Member'
      )                                               as display_name,
      p.status                                        as profile_status,
      m.status                                        as membership_status,
      m.created_at                                    as membership_created_at,
      m.joined_at                                     as joined_at,
      m.deactivated_at                                as deactivated_at,
      -- Byte-identical to the list's aggregate, including the ACTIVE filter and the
      -- ordering, so the roles a user shows in the directory are the roles they show when
      -- opened. A cross-organization assignment cannot appear: member_roles is keyed by
      -- organization_member_id, and the only membership reached here is this Vendor's own.
      coalesce(
        (
          select array_agg(r.name order by r.name, r.id)
          from public.member_roles mr
          join public.roles r on r.id = mr.role_id
          where mr.organization_member_id = m.id
            and r.status = 'ACTIVE'
        ),
        '{}'::text[]
      )                                               as role_names
    from public.organization_members m
    join public.profiles p on p.id = m.user_id
    where m.id = p_membership_id
      and m.organization_id = v_vendor
  ) u;
end;
$$;

revoke all     on function public.get_vendor_user_detail(uuid) from public;
revoke execute on function public.get_vendor_user_detail(uuid) from anon;
grant  execute on function public.get_vendor_user_detail(uuid) to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- Two read functions. Nothing else exists in this migration. No table, column, constraint,
-- index, trigger, RLS policy, role, permission, or mapping is created or altered; no
-- existing function is touched; and no table privilege is granted to any browser role — the
-- migration-5 read policies on public.profiles, public.organization_members,
-- public.member_roles and public.roles are unchanged, and public.retailer_invitations and
-- public.retailer_staff_invitations remain default-deny with zero privileges for anon and
-- authenticated. No index is added: every predicate above is served by an existing one
-- (organization_members_org_status_idx, the organization_members unique key on
-- (organization_id, user_id), the profiles primary key, the member_roles primary key on
-- (organization_member_id, role_id), and the roles primary key), and a speculative index
-- would be a cost with no measured cause.
--
-- service_role is granted nothing here. Both reads derive their authority from auth.uid(),
-- which a service-role connection does not have, so granting it would produce a function
-- that can only ever refuse.
--
-- The web is untouched. lib/members/vendor-organization-members.ts keeps performing its own
-- four reads and app/(admin)/users/page.tsx renders exactly what it rendered before; these
-- functions are additive and have no caller in this repository yet.
