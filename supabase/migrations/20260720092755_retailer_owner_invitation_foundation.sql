-- Migration: retailer_owner_invitation_foundation
-- Purpose: The database foundation for inviting the FIRST Retailer Owner of a
--          Vendor-managed Retailer organization. Five related parts:
--            1. The RETAILER_OWNERS_INVITE permission, seeded and mapped to
--               VENDOR_SUPER_ADMIN.
--            2. The RETAILER_OWNER role, seeded ACTIVE with ZERO permissions.
--            3. public.retailer_invitations — the pending-invitation record.
--            4. Six SECURITY DEFINER functions spanning the invitation lifecycle.
--            5. Default-deny RLS and privilege hardening on the new table.
--
-- THE IDENTITY LIFECYCLE THIS IMPLEMENTS
--   Auth user -> profile -> organization_members INVITED -> RETAILER_OWNER role
--     -> owner sets password -> organization_members ACTIVE -> invitation ACCEPTED
--
--   The password step belongs entirely to Supabase Auth and appears NOWHERE in
--   this file: no function takes a password argument, no column stores one, and no
--   audit record mentions one. The application sets it via auth.updateUser() and
--   only then calls accept_retailer_owner_invitation(), which is the transition
--   from INVITED to ACTIVE. PostgreSQL never sees a credential.
--
-- NAMES ARE COLLECTED, NEVER INVENTED
--   The Vendor admin supplies the invitee's first and last name, both required and
--   both non-empty after trimming. finalize() writes them to public.profiles
--   verbatim. There is no placeholder surname, no name derived from an email local
--   part, and no generated value anywhere in this migration.
--
-- WHY AN INVITATION TABLE EXISTS AT ALL
--   public.organization_members.user_id references public.profiles(id), which
--   references auth.users(id). A membership therefore CANNOT be created before
--   the Auth user exists. Migration 8 anticipated expressing "invited but not yet
--   accepted" as organization_members.status = 'INVITED', and that remains the
--   model — but it can only be written AFTER Supabase Auth has minted the user.
--   Something durable must record the Vendor's decision BEFORE that call is made,
--   or a failed Auth dispatch leaves no trace, no idempotency key, and no way to
--   prevent a duplicate. This table is that record.
--
-- THE TWO-SYSTEM PROBLEM, AND WHY THE ORDER IS WHAT IT IS
--   PostgreSQL and Supabase Auth (GoTrue) are separate systems with NO shared
--   transaction. Postgres cannot roll back an email that has been sent, and
--   GoTrue cannot roll back a committed row. The lifecycle is therefore split
--   into two RPCs around the Auth call:
--
--     reserve_retailer_owner_invitation()   -- DB first: records intent, dedupes
--       -> [application calls Supabase Auth Admin]
--     finalize_retailer_owner_invitation()  -- DB second: profile + membership
--                                              + role + audit, atomically
--
--   Reserve-then-dispatch is chosen over dispatch-then-record because a database
--   row with no email sent is recoverable and invisible, while an email sent with
--   no database row is unrecoverable and confusing. Both RPCs are idempotent, so
--   a failure anywhere in the seam is retried rather than repaired by hand.
--
-- WHY NO RLS POLICY IS ADDED FOR THE NEW TABLE
--   public.retailer_invitations gets RLS enabled with ZERO policies and ZERO
--   privileges for anon/authenticated — the posture audit_logs and
--   iso_country_codes hold today. Browser clients cannot read, insert, update, or
--   delete an invitation by any route. The reserve RPC returns the one opaque
--   identifier the server needs and nothing else, so nothing about this table has
--   to be exposed merely to make a future form convenient. A read policy (gated
--   on a future RETAILER_INVITATIONS_READ permission) belongs with the UI batch
--   that actually needs to list invitations; adding it now would be widening
--   access ahead of a consumer.
--
-- Scope notes:
--   * No existing table, column, constraint, index, trigger, policy, function,
--     role, permission, or mapping is created, altered, or dropped. This
--     migration adds one permission row, one mapping row, one role row, one
--     table, two trigger functions' worth of triggers, six indexes, and five
--     functions.
--   * No organizations, retailers, shops, profiles, memberships, member_roles,
--     invitations, or auth users are created. Nothing here grants any HUMAN
--     access to anything.
--   * No Vendor administrator becomes a member of any Retailer organization, and
--     no invitee ever receives a Vendor role or a Vendor membership.
--   * No RETAILER_STAFF role. That belongs with Retailer staff invitations, which
--     this milestone deliberately does not build.
--   * No earlier migration is modified.
--
-- Dependencies: migration 1 (organizations, profiles, organization_members,
--   set_updated_at), 2 (roles, permissions, role_permissions, member_roles),
--   3 (audit_logs), 4 (has_organization_permission), 6 (seeded
--   VENDOR_SUPER_ADMIN), 7 (get_vendor_super_admin_context), 8 (vendor_retailers,
--   assert_organization_type).

-- ============================================================================
-- PART 1 — RETAILER_OWNERS_INVITE permission
-- ============================================================================
-- A separate permission from RETAILERS_READ, RETAILERS_CREATE, and
-- RETAILER_SHOPS_CREATE, for the reason migration 12 gives for splitting create
-- from read: inviting a human being who will hold administrative authority over a
-- Retailer organization is a different risk from creating the organization
-- itself. A future reporting or support role could reasonably be given the
-- Retailer directory, or even the ability to add shops, without ever being able
-- to mint an owner. Folding this into an existing permission would remove that
-- choice permanently.
--
-- Idempotency: upserts on permissions.code (the unique constraint migration 2
-- established), matching migrations 6, 11, 12, and 13 exactly. Re-running
-- refreshes only the human-readable catalogue fields and updated_at, leaving `id`
-- untouched — so the role_permissions row created below, and any future FK
-- pointing at this permission, survives a re-run intact. No fixed UUIDs; the id
-- comes from the table's own default. Nothing is deleted.
insert into public.permissions (code, name, description, module)
values
  (
    'RETAILER_OWNERS_INVITE',
    'Invite Retailer Owners',
    'Invite the first owner of a Vendor-managed Retailer organization.',
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
-- the migration would report success with RETAILER_OWNERS_INVITE assigned to
-- nobody — fail-closed, but silently. Inviting an owner would then raise "not
-- authorized" for a correctly configured Super Admin and nothing would explain
-- why. This raises instead. It reads one row and writes nothing.
do $$
begin
  if not exists (
    select 1
    from public.roles r
    where r.code = 'VENDOR_SUPER_ADMIN'
  ) then
    raise exception 'Seed precondition failed: role VENDOR_SUPER_ADMIN does not exist, so RETAILER_OWNERS_INVITE cannot be assigned';
  end if;
end;
$$;

-- Role -> permission mapping. RETAILER_OWNERS_INVITE goes to VENDOR_SUPER_ADMIN
-- and only to it: the WHERE clause names exactly one role code, so no other
-- existing or future role receives it without its own deliberate migration. In
-- particular RETAILER_OWNER, seeded in Part 2 below, does NOT receive it — a
-- Retailer Owner cannot invite anybody.
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
  and p.code = 'RETAILER_OWNERS_INVITE'
on conflict (role_id, permission_id) do nothing;

-- ============================================================================
-- PART 2 — RETAILER_OWNER role
-- ============================================================================
-- Seeded ACTIVE with ZERO permissions, exactly as migration 6 seeded
-- CLAIM_REVIEWER and FINANCE_ADMIN. That migration's reasoning applies verbatim:
-- "An ACTIVE role with no mapped permissions authorizes nothing --
-- has_organization_permission() joins through role_permissions and finds no row
-- -- so seeding them now is inert, not a latent grant."
--
-- This is deliberate and not an oversight. The role's job in THIS milestone is to
-- IDENTIFY the owner of a Retailer organization, not to open anything to them:
-- the Retailer portal does not exist, so there is nothing for a permission to
-- unlock. Granting business permissions now would be defining access for pages
-- nobody can visit, and every one of those grants would be live from the moment
-- the first owner accepts.
--
-- Guard before the upsert. "Idempotent" must not mean "silently overwrite
-- something incompatible". Two conditions are checked:
--
--   1. An existing RETAILER_OWNER that already holds permission mappings. This
--      migration's contract is a zero-permission role; upserting over a role that
--      someone has since granted permissions to would leave the catalogue saying
--      one thing and role_permissions another, and the upsert below (which
--      touches only name/description/status) would not even reveal it.
--   2. An existing RETAILER_OWNER that is currently assigned to live members.
--      Rewriting the definition of a role people already hold is a change to
--      their access, not a seed.
--
-- Neither can occur in a correctly ordered history — no earlier migration creates
-- this role — which is exactly why the check is worth stating. It fires only when
-- an assumption this migration depends on has already broken. It reads rows and
-- writes nothing.
do $$
declare
  v_role_id            uuid;
  v_permission_count   integer;
  v_assignment_count   integer;
begin
  select r.id into v_role_id
  from public.roles r
  where r.code = 'RETAILER_OWNER';

  if v_role_id is null then
    return;  -- The ordinary case: the role does not exist yet.
  end if;

  select count(*) into v_permission_count
  from public.role_permissions rp
  where rp.role_id = v_role_id;

  if v_permission_count > 0 then
    raise exception 'Seed precondition failed: role RETAILER_OWNER already exists with % permission mapping(s); this migration seeds it with zero permissions and will not overwrite an incompatible definition', v_permission_count;
  end if;

  select count(*) into v_assignment_count
  from public.member_roles mr
  where mr.role_id = v_role_id;

  if v_assignment_count > 0 then
    raise exception 'Seed precondition failed: role RETAILER_OWNER already exists and is assigned to % member(s); this migration will not redefine a role that is already held', v_assignment_count;
  end if;
end;
$$;

-- ON CONFLICT (code) targets roles_code_unique, matching migration 6's convention
-- exactly. The upsert refreshes the human-readable fields and status so this
-- migration stays the single source of truth for the catalogue entry, while
-- leaving id untouched (any member_roles FK already pointing at the role stays
-- valid across a re-run).
--
-- No role_permissions INSERT follows. That absence IS the "zero permissions"
-- requirement, and it is stated here rather than implied: there is deliberately
-- no statement anywhere in this migration that maps any permission to
-- RETAILER_OWNER.
insert into public.roles (code, name, description, status)
values
  (
    'RETAILER_OWNER',
    'Retailer Owner',
    'Primary owner and administrator of a Retailer organization.',
    'ACTIVE'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  status      = excluded.status,
  updated_at  = now();

-- ============================================================================
-- PART 3 — retailer_invitations
-- ============================================================================
-- One row per invitation ever issued. Rows are RETIRED BY STATUS AND NEVER
-- DELETED, matching how this schema treats organizations, memberships,
-- relationships, and shops. An accepted, expired, or revoked invitation stays on
-- record permanently: it is the evidence of who was offered administrative
-- authority over a Retailer, when, and by whom, and deleting it would destroy
-- precisely the history the audit trail exists to corroborate.
--
-- WHAT IS DELIBERATELY NOT STORED
--   * No token, token hash, confirmation URL, or OTP. Supabase Auth owns the
--     invitation credential end to end. Duplicating it into an application table
--     would create a second copy of a bearer secret, in a table read by more code
--     than GoTrue's own storage, with no expiry semantics of its own. Nothing in
--     this schema ever needs it: acceptance is proven by the invitee arriving
--     with a verified session whose auth.uid() matches auth_user_id below.
--   * No password, no email delivery status beyond sent_at, no message body.
create table public.retailer_invitations (
  id                       uuid        primary key default gen_random_uuid(),

  -- Both sides of the relationship are stored, not just the Retailer. The Vendor
  -- is what every authorization check filters on and what the audit records name
  -- as the acting tenant; deriving it through vendor_retailers on every read
  -- would make authorization depend on a relationship row that can later be
  -- deactivated, retroactively changing who may see a historical invitation.
  -- ON DELETE RESTRICT for both, matching vendor_retailers: an organization with
  -- invitations on record cannot be hard-deleted and must be DEACTIVATED instead.
  vendor_organization_id   uuid        not null
                             references public.organizations (id) on delete restrict,
  retailer_organization_id uuid        not null
                             references public.organizations (id) on delete restrict,

  -- Stored ALREADY canonical: trimmed and lower-cased. See the check constraint
  -- below, which enforces that rather than trusting callers to have done it.
  email                    text        not null,

  -- REQUIRED. The invitee's real name, supplied by the Vendor admin who knows who
  -- they are inviting, and carried here so that finalize() can create the profile
  -- from FACTS rather than from guesses.
  --
  -- An earlier draft of this migration accepted an optional display name and, when
  -- none was given, derived a first name from the email local part and wrote the
  -- literal 'Owner' as a surname. That was invented data: it satisfied profiles'
  -- NOT NULL constraints while asserting something nobody had said. A person's
  -- name is not a value this system may fabricate, so it is now collected at the
  -- point where it is actually known.
  --
  -- `text` with no length ceiling, matching public.profiles.first_name and
  -- last_name exactly. Those columns impose no maximum, so imposing one here would
  -- reject names the profiles table would happily store — and the failure would
  -- land at finalization, after the email had already gone out.
  first_name               text        not null,
  last_name                text        not null,

  -- The role this invitation confers. Stored as an FK rather than a literal code
  -- so the assignment in finalize_retailer_owner_invitation() cannot drift from
  -- what the invitation promised, and so a renamed role code does not silently
  -- change the meaning of historical rows. RESTRICT follows member_roles.role_id:
  -- a role still referenced by an invitation cannot be deleted.
  role_id                  uuid        not null
                             references public.roles (id) on delete restrict,

  status                   text        not null default 'PENDING',

  -- NULL until the Auth dispatch succeeds and finalize records it. This column is
  -- what acceptance matches on, which is why it is the only link between a
  -- signed-in invitee and their invitation. ON DELETE SET NULL so removing an
  -- Auth user preserves the invitation record.
  auth_user_id             uuid        null
                             references auth.users (id) on delete set null,

  -- NULL until finalize creates (or reuses) the Retailer membership. Its presence
  -- is what makes finalize's effect observable and therefore retry-detectable.
  organization_member_id   uuid        null
                             references public.organization_members (id) on delete set null,

  -- Who issued it. SET NULL rather than RESTRICT, following member_roles
  -- .assigned_by: removing the inviting profile must not erase the invitation.
  invited_by_profile_id    uuid        null
                             references public.profiles (id) on delete set null,

  -- 24 hours, per the approved product decision. This is the INVITATION's own
  -- clock and is deliberately independent of the emailed link's lifetime, which
  -- belongs to GoTrue (auth.email.otp_expiry). They are two different questions —
  -- "may this person still become the owner" versus "is this particular email
  -- still clickable" — and conflating them is how a resend ends up requiring a
  -- fresh authorization.
  expires_at               timestamptz not null default (now() + interval '24 hours'),

  -- Set by finalize when the Auth dispatch is recorded as succeeded. NULL means
  -- the invitation was reserved but never dispatched, which is exactly the state
  -- a retry must be able to recognize.
  sent_at                  timestamptz null,
  accepted_at              timestamptz null,
  revoked_at               timestamptz null,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  -- An organization cannot invite an owner to itself. Both columns are NOT NULL,
  -- so this comparison is never null and the check can never be skipped. Mirrors
  -- vendor_retailers_distinct_organizations.
  constraint retailer_invitations_distinct_organizations
    check (vendor_organization_id <> retailer_organization_id),

  -- THE canonicalization rule, enforced by the database rather than assumed of
  -- callers. 'Owner@Shop.com' and 'owner@shop.com' are the same mailbox and the
  -- same GoTrue identity, but would be two distinct rows under a naive column —
  -- which would defeat the partial unique index below entirely and allow two live
  -- invitations to the same person. Stating it as a constraint means no future
  -- writer, RPC or otherwise, can store a non-canonical address even by accident.
  -- The length ceiling is RFC 5321's maximum.
  constraint retailer_invitations_email_canonical
    check (
      email = lower(btrim(email))
      and length(email) > 0
      and length(email) <= 254
    ),

  -- A pragmatic shape check, not an RFC 5322 implementation: something, an @,
  -- something, a dot, something, with no whitespace. It matches EMAIL_PATTERN in
  -- app/login/actions.ts deliberately, so the form and the database agree on what
  -- they will accept. GoTrue remains the real authority on deliverability.
  --
  -- COLLATE "C" is load-bearing rather than decorative, for the same reason
  -- migration 8 pins retailer_shops_country_code_format: PostgreSQL evaluates
  -- regex bracket expressions according to the database collation, so under a
  -- locale-aware collation a character class can admit characters well outside
  -- the intended set. Pinning the operand to the C collation makes this mean
  -- exactly what it reads as, on every host.
  constraint retailer_invitations_email_shape
    check (email collate "C" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),

  -- Both names must be non-empty AFTER trimming, exactly mirroring
  -- profiles_first_name_not_empty and profiles_last_name_not_empty. NOT NULL alone
  -- would still admit '' and '   ', which would satisfy this table and then fail
  -- against profiles at finalization — after the invitation email had already been
  -- sent. Enforcing the same rule here means a name that cannot become a profile
  -- can never become an invitation either.
  constraint retailer_invitations_first_name_not_empty
    check (length(btrim(first_name)) > 0),
  constraint retailer_invitations_last_name_not_empty
    check (length(btrim(last_name)) > 0),

  -- Stored already trimmed, so the value written to public.profiles is byte-for-
  -- byte the value stored here and there is no second normalization step that
  -- could disagree. Same posture as retailer_invitations_email_canonical below:
  -- the database enforces canonical form rather than trusting callers to have
  -- produced it.
  constraint retailer_invitations_names_trimmed
    check (first_name = btrim(first_name) and last_name = btrim(last_name)),

  constraint retailer_invitations_status_allowed
    check (status in ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED')),

  -- Status and its timestamp move together or not at all. Written as an
  -- equivalence (=) rather than an implication so BOTH directions are covered: an
  -- ACCEPTED row without accepted_at is rejected, and so is a non-ACCEPTED row
  -- that carries one. A one-directional check would let a revoked row keep a
  -- stale acceptance timestamp and quietly read as accepted to anything that
  -- inspects timestamps rather than status.
  constraint retailer_invitations_accepted_consistent
    check ((status = 'ACCEPTED') = (accepted_at is not null)),

  constraint retailer_invitations_revoked_consistent
    check ((status = 'REVOKED') = (revoked_at is not null)),

  -- An ACCEPTED invitation must name the membership it produced. Without this an
  -- acceptance could commit while leaving no link to the member it created, and
  -- the invitation would claim an outcome nothing corroborates.
  constraint retailer_invitations_accepted_has_member
    check (status <> 'ACCEPTED' or organization_member_id is not null),

  -- An ACCEPTED invitation must name the Auth user that accepted it, for the same
  -- reason.
  constraint retailer_invitations_accepted_has_auth_user
    check (status <> 'ACCEPTED' or auth_user_id is not null)
);

-- ============================================================================
-- PART 3b — Organization type validation
-- ============================================================================
-- A foreign key guarantees that a referenced organization EXISTS. It cannot
-- guarantee anything about that organization's TYPE — nothing stops a row from
-- naming a RETAILER as its vendor, or a VENDOR as its retailer, and both would
-- satisfy the FK while being nonsense. A check constraint cannot close the gap
-- either: it may only read the row being written. Trigger validation can, and
-- this reuses public.assert_organization_type() from migration 8 rather than
-- reimplementing the lookup — so all three tables that carry an organization type
-- invariant (vendor_retailers, retailer_shops, and now this one) enforce it with
-- exactly the same code.
create function public.retailer_invitations_assert_organization_types()
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

-- Privileges: identical reasoning to migration 8's trigger validators.
-- PostgreSQL grants EXECUTE to PUBLIC on every new function by default, and
-- PUBLIC is inherited by every role — so without the revoke below, anon and
-- authenticated would hold EXECUTE on a SECURITY DEFINER function despite this
-- migration never granting them anything.
--
-- The triggers created below keep working regardless: PostgreSQL checks EXECUTE
-- on a trigger function at CREATE TRIGGER time, against the migration role which
-- owns it, and NOT when the trigger fires.
revoke all on function
  public.retailer_invitations_assert_organization_types()
from public;

revoke execute on function
  public.retailer_invitations_assert_organization_types()
from anon;

revoke execute on function
  public.retailer_invitations_assert_organization_types()
from authenticated;

-- BEFORE ROW, so validation runs before the row is written and before the foreign
-- key is checked. Split into INSERT and UPDATE triggers because the UPDATE
-- variant needs a WHEN clause referencing OLD, which does not exist during
-- INSERT. The UPDATE trigger is narrowed twice over — UPDATE OF limits it to
-- statements that mention an organization column, and WHEN limits it further to
-- statements that actually change one — so an ordinary status transition performs
-- no extra lookups.
create trigger retailer_invitations_assert_types_on_insert
  before insert on public.retailer_invitations
  for each row execute function public.retailer_invitations_assert_organization_types();

create trigger retailer_invitations_assert_types_on_update
  before update of vendor_organization_id, retailer_organization_id
  on public.retailer_invitations
  for each row
  when (
    new.vendor_organization_id is distinct from old.vendor_organization_id
    or new.retailer_organization_id is distinct from old.retailer_organization_id
  )
  execute function public.retailer_invitations_assert_organization_types();

-- Reuses public.set_updated_at() from migration 1.
create trigger set_updated_at_on_retailer_invitations
  before update on public.retailer_invitations
  for each row execute function public.set_updated_at();

-- ============================================================================
-- PART 3c — Indexes
-- ============================================================================
-- THE duplicate guard, and the reason the email canonicalization constraint above
-- is not merely tidiness. Partial on status = 'PENDING', which is what allows
-- history to accumulate: one Retailer/mailbox pair may hold at most ONE live
-- invitation, while any number of ACCEPTED, EXPIRED, or REVOKED rows for that
-- same pair coexist freely. A plain unique constraint could express neither the
-- WHERE clause nor the partiality, which is why this is an index.
--
-- This is the ENFORCEMENT mechanism. The duplicate pre-check inside
-- reserve_retailer_owner_invitation() exists only to produce a predictable,
-- idempotent outcome; a concurrent transaction that slips past it still fails
-- here, and still rolls the whole call back.
create unique index retailer_invitations_pending_unique_idx
  on public.retailer_invitations (retailer_organization_id, email)
  where status = 'PENDING';

-- The Vendor's own question — "which invitations have I issued, and in what
-- state?" — newest first. Not redundant against the partial index above, whose
-- leading column is retailer_organization_id and which excludes every non-pending
-- row.
create index retailer_invitations_vendor_status_created_idx
  on public.retailer_invitations (vendor_organization_id, status, created_at desc);

-- Per-Retailer lookup across every status, which the partial unique index cannot
-- serve because it omits non-pending rows entirely.
create index retailer_invitations_retailer_status_idx
  on public.retailer_invitations (retailer_organization_id, status);

-- THE acceptance path. accept_retailer_owner_invitation() resolves the caller's
-- invitation solely by auth_user_id, so this index serves the single hottest
-- lookup in the whole lifecycle. Partial because a reserved-but-undispatched
-- invitation has no Auth user and can never be found this way.
create unique index retailer_invitations_auth_user_pending_idx
  on public.retailer_invitations (auth_user_id)
  where auth_user_id is not null and status = 'PENDING';

-- Deliberately UNIQUE and deliberately partial: one Auth user may hold at most
-- ONE pending invitation across the entire system at a time. That is what makes
-- the zero-argument acceptance function unambiguous — it can never find two
-- candidates and have to choose. Accepted/expired/revoked rows are excluded, so a
-- person may be invited to a second Retailer after settling the first.

-- Email lookup across Retailers, used by the "does this person already hold a
-- live invitation elsewhere" checks and by future support tooling.
create index retailer_invitations_email_idx
  on public.retailer_invitations (email);

-- The expiry sweep inside reserve_retailer_owner_invitation(). Partial, so it
-- indexes only the rows a sweep could ever act on and stays small permanently
-- rather than growing with settled history.
create index retailer_invitations_pending_expiry_idx
  on public.retailer_invitations (expires_at)
  where status = 'PENDING';

-- ============================================================================
-- PART 3d — Row Level Security and privilege hardening
-- ============================================================================
-- RLS enabled with ZERO policies: default-deny for anon and authenticated,
-- reads and writes alike. This is the posture audit_logs (migration 3) and
-- iso_country_codes (migration 14) hold, and it is deliberate rather than
-- provisional — see the header note. A browser client cannot read one byte of
-- this table by any route; everything it legitimately needs comes back from the
-- reserve RPC as a return value.
alter table public.retailer_invitations enable row level security;

-- RLS decides WHICH ROWS a role may touch; GRANTs decide whether the role may
-- attempt the statement at all. The two are independent, and the gap is not
-- theoretical: Supabase ships ALTER DEFAULT PRIVILEGES for the public schema that
-- grant table privileges to anon and authenticated automatically as tables are
-- created. Left alone, this table would hand the browser roles privileges this
-- migration never intended — which is exactly what migrations 5 and 8 had to undo.
--
-- TRUNCATE is the reason this cannot be left to RLS: it bypasses row security
-- entirely, so the privilege alone would let a browser role empty the invitation
-- history despite the default-deny policy set. REFERENCES would allow foreign
-- keys that probe row existence, and TRIGGER would allow attaching code.
--
-- Nothing here grants anything, to anyone. No SELECT either: there is no SELECT
-- policy, and a privilege without a policy would be a dead grant that a future
-- policy could silently activate.
--
-- postgres and service_role are untouched: they hold their privileges directly
-- (and service_role additionally BYPASSRLS), so the trusted finalization path is
-- unaffected.
revoke all on table public.retailer_invitations from public;
revoke all on table public.retailer_invitations from anon;
revoke all on table public.retailer_invitations from authenticated;

-- ============================================================================
-- PART 4a — expire_stale_retailer_invitations() [internal]
-- ============================================================================
-- Moves PENDING invitations whose expires_at has passed to EXPIRED, scoped to one
-- Retailer organization.
--
-- WHY THIS IS SCOPED AND INTERNAL RATHER THAN A GLOBAL SWEEP
--   This project has no scheduler and should not grow one for this. Correctness
--   therefore cannot depend on a job running: every function that reads an
--   invitation's liveness re-checks expires_at directly, so an un-swept row is
--   already inert. This function exists only to keep the STORED status honest and
--   — critically — to free the partial unique index so a lapsed invitation does
--   not block a legitimate re-invitation of the same person forever.
--
--   It is called from reserve_retailer_owner_invitation() at exactly the moment
--   that matters, and takes a Retailer id so a single invitation attempt never
--   sweeps the entire table.
--
-- NO AUDIT EVENT IS WRITTEN. Expiry is the absence of an action, not an action:
-- nobody did it, so there is no actor to record and audit_logs.actor_profile_id
-- would be null on a row describing a thing no one performed. The invitation's own
-- status and expires_at are the complete record of what happened.
--
-- No arguments come from a browser: the only caller passes an id it has already
-- verified belongs to the calling Vendor.
create function public.expire_stale_retailer_invitations(
  p_retailer_organization_id uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.retailer_invitations
  set status = 'EXPIRED'
  where p_retailer_organization_id is not null
    and retailer_organization_id = p_retailer_organization_id
    and status = 'PENDING'
    and expires_at <= now();
$$;

-- Privileges: NOT granted to any browser role, matching migration 8's treatment
-- of assert_organization_type(). Every function in the public schema is a
-- candidate PostgREST RPC endpoint, and this one mutates rows and takes an
-- organization id — granted to authenticated it would let any caller sweep any
-- Retailer's invitations, which is both a write they have no right to and a
-- timing oracle for whether a given organization has pending invitations at all.
-- Its only caller is a SECURITY DEFINER function that invokes it as its owner, so
-- no browser role needs EXECUTE and none is given.
revoke all on function public.expire_stale_retailer_invitations(uuid) from public;
revoke execute on function public.expire_stale_retailer_invitations(uuid) from anon;
revoke execute on function public.expire_stale_retailer_invitations(uuid) from authenticated;

-- ============================================================================
-- PART 4b — reserve_retailer_owner_invitation()
-- ============================================================================
-- STEP ONE of two. Authorizes the Vendor, verifies the relationship, validates
-- and canonicalizes the email, refuses duplicates and existing owners, and writes
-- exactly ONE row: the PENDING invitation.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   It creates no auth user, no profile, no membership, and no member_roles row,
--   and it writes no audit event. All of those describe an invitation that has
--   been DELIVERED, and nothing has been delivered when this returns — the Auth
--   call has not happened yet. Writing them here would mean a failed dispatch
--   leaves a person half-provisioned in the database and an audit log asserting
--   an invitation that was never sent. Both belong to finalize().
--
-- WHY IT RETURNS A VALUE, unlike onboard_vendor_retailer() and
-- add_vendor_retailer_shop(), which deliberately return void
--   Those two complete their whole job in one call, so a returned id could only
--   ever be a convenience — and handing the browser an identifier whose only use
--   is addressing a row directly is not a convenience worth having. This function
--   is different in kind: it is one half of a two-phase operation across two
--   systems, and the server physically cannot perform the second half without
--   knowing which invitation it reserved. The id is not returned for the caller's
--   benefit; it is returned because the protocol does not close without it.
--
--   It is nonetheless treated as a secret in transit: the application never sends
--   it to the browser, never logs it, and never places it in a URL. See
--   lib/invitations/retailer-owner-invitations.ts.
--
--   normalized_email is returned because the Auth Admin call must use the exact
--   canonical string the database stored, not the raw one the admin typed —
--   otherwise GoTrue could mint a user under a different casing than the
--   invitation records, and finalize()'s email equality check would correctly but
--   uselessly reject it.
--
--   is_resend distinguishes a fresh reservation from an idempotent retry so the
--   UI can say "invitation re-sent" truthfully rather than claiming a new one.
--
-- ACCEPTS NO TENANT OR ACTOR IDS. There is no vendor organization id, retailer
-- organization id, actor/profile id, role id, membership id, auth user id,
-- status, or expiry parameter in the signature — because any such parameter is a
-- value the caller controls, and a caller-controlled tenant id is exactly how a
-- cross-tenant write happens. The caller says WHICH of its own relationships and
-- WHO to invite; it can never say who it is, which Vendor it acts for, or which
-- Retailer organization is written.
create function public.reserve_retailer_owner_invitation(
  p_relationship_id uuid,
  p_email           text,
  p_first_name      text,
  p_last_name       text
)
returns table (
  invitation_id    uuid,
  normalized_email text,
  is_resend        boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id    uuid;
  v_vendor_org_id       uuid;
  v_retailer_org_id     uuid;
  v_retailer_status     text;
  v_relationship_status text;
  v_role_id             uuid;
  v_email               text;
  v_first_name          text;
  v_last_name           text;
  v_existing_id         uuid;
  v_invitation_id       uuid;
begin
  -- --------------------------------------------------------------------------
  -- 1. Authorization
  -- --------------------------------------------------------------------------
  -- Identity comes from the JWT and nowhere else.
  v_actor_profile_id := auth.uid();

  if v_actor_profile_id is null then
    raise exception 'Not authorized to invite an owner for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  -- Resolve the Vendor through the existing context function rather than
  -- reimplementing its joins. Calling it is what guarantees the chain here is the
  -- SAME chain the application shell, migration 12, and migration 13 authorize
  -- against — profile, membership, organization type and status, and the ACTIVE
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

  if v_vendor_org_id is null then
    raise exception 'Not authorized to invite an owner for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  -- Holding VENDOR_SUPER_ADMIN is not by itself permission to invite owners; the
  -- permission mapping seeded in Part 1 is. Checking the permission rather than
  -- the role keeps this consistent with every RLS policy and RPC in the project:
  -- authorization is permission-based end to end, so a future RETAILER_MANAGER
  -- needs a role_permissions row, not an edit to this function.
  if not public.has_organization_permission(v_vendor_org_id, 'RETAILER_OWNERS_INVITE') then
    raise exception 'Not authorized to invite an owner for this Retailer'
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
  -- over migration 8's BEFORE-row trigger.
  select vr.retailer_organization_id, vr.status, o.status
    into v_retailer_org_id, v_relationship_status, v_retailer_status
  from public.vendor_retailers vr
  join public.organizations o
    on o.id = vr.retailer_organization_id
  where vr.id = p_relationship_id
    and vr.vendor_organization_id = v_vendor_org_id
    and o.organization_type = 'RETAILER';

  -- The SAME message and SQLSTATE as the three authorization raises above, and
  -- deliberately so. A null p_relationship_id, a well-typed id that names
  -- nothing, an id owned by a different Vendor, and an id whose organization is
  -- somehow not a RETAILER all land here and are reported identically to "you are
  -- not authorized". Distinguishing them would let a caller confirm that a
  -- relationship they may not touch nevertheless exists, and by sweeping ids,
  -- roughly how many there are. "I will not tell you whether that exists" is the
  -- only safe answer, so it is the only answer given.
  if v_retailer_org_id is null then
    raise exception 'Not authorized to invite an owner for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Active write gate
  -- --------------------------------------------------------------------------
  -- Reads across this project deliberately do NOT filter by status — a suspended
  -- Retailer must stay visible and reviewable. Writes are the opposite: a Vendor
  -- that has paused or ended a relationship must not be able to keep building it
  -- out, and installing a NEW administrator on a suspended Retailer is the
  -- clearest possible case of that. Same rule migration 13 applies to shops.
  --
  -- These two messages are specific rather than generic, and that is safe: they
  -- are reachable only AFTER ownership has been proven, so the caller already
  -- manages this Retailer and can already see both statuses on its detail page.
  -- Nothing is disclosed that the caller did not already have.
  --
  -- Both statuses are conditions, never parameters. There is no status argument
  -- in the signature, so a caller cannot assert its way past this gate.
  -- SQLSTATE 55000 (object_not_in_prerequisite_state) rather than check_violation,
  -- deliberately. The application needs to tell "this Retailer is paused" apart
  -- from "that name or email is malformed" so it can show the admin the right
  -- thing, and it must do so by matching a stable SQLSTATE rather than by
  -- string-matching a PostgreSQL message. Reusing check_violation for both would
  -- have forced exactly that fragile text comparison. The validation raises below
  -- keep check_violation, so the two classes never collide.
  if v_relationship_status <> 'ACTIVE' then
    raise exception 'This Retailer relationship is not active'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_retailer_status <> 'ACTIVE' then
    raise exception 'This Retailer organization is not active'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. Input normalization and validation
  -- --------------------------------------------------------------------------
  -- Canonicalization happens HERE, once, and the constraint on the column
  -- enforces that it happened. Lower-casing is not cosmetic: it is what makes the
  -- partial unique index a real duplicate guard rather than a decoration, and it
  -- is what makes finalize()'s comparison against the Auth user's email a
  -- meaningful equality test.
  --
  -- Nothing is truncated. An over-long address is REJECTED, not silently
  -- shortened. Validation runs AFTER authorization and ownership, deliberately:
  -- an unauthorized caller must not learn whether their input would have been
  -- valid.
  v_email      := lower(btrim(coalesce(p_email, '')));
  v_first_name := btrim(coalesce(p_first_name, ''));
  v_last_name  := btrim(coalesce(p_last_name, ''));

  if v_email = '' then
    raise exception 'An email address is required'
      using errcode = 'check_violation';
  end if;

  -- Both names are REQUIRED, and neither may be blank after trimming. There is no
  -- fallback, no derivation from the email, and no placeholder: if the Vendor
  -- admin does not know who they are inviting, this function refuses rather than
  -- inventing a person.
  if v_first_name = '' then
    raise exception 'A first name is required'
      using errcode = 'check_violation';
  end if;

  if v_last_name = '' then
    raise exception 'A last name is required'
      using errcode = 'check_violation';
  end if;

  if length(v_email) > 254 then
    raise exception 'Email address is too long'
      using errcode = 'check_violation';
  end if;

  -- The same shape rule as the column constraint and as app/login/actions.ts.
  -- Validating here converts a raw constraint violation into a clear message
  -- without weakening or duplicating the constraint, which still has the final say.
  if v_email collate "C" !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email address'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. Expire stale invitations for this Retailer
  -- --------------------------------------------------------------------------
  -- Before any duplicate check. A PENDING row whose 24 hours have elapsed still
  -- occupies the partial unique index, so without this sweep a lapsed invitation
  -- would block re-inviting the same person forever — the failure would look like
  -- "duplicate" when the truth is "expired". The id passed is the one verified in
  -- section 2, never the caller's argument.
  perform public.expire_stale_retailer_invitations(v_retailer_org_id);

  -- --------------------------------------------------------------------------
  -- 6. Refuse when this Retailer already has an owner
  -- --------------------------------------------------------------------------
  -- This function invites the FIRST owner. Both ACTIVE and INVITED memberships
  -- count as "already has one": an INVITED owner is a dispatched invitation
  -- awaiting acceptance, and admitting a second one under a different email would
  -- produce two owners racing to accept. Fail closed on both.
  --
  -- Scoped to this Retailer's own memberships holding the RETAILER_OWNER role.
  -- The message is specific and safe for the same reason as section 3: ownership
  -- has already been proven.
  if exists (
    select 1
    from public.organization_members m
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    where m.organization_id = v_retailer_org_id
      and m.status in ('ACTIVE', 'INVITED')
      and r.code = 'RETAILER_OWNER'
  ) then
    raise exception 'This Retailer already has an owner'
      using errcode = 'unique_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 7. Idempotent retry for a still-live invitation
  -- --------------------------------------------------------------------------
  -- A still-PENDING, unexpired invitation to the SAME mailbox for the SAME
  -- Retailer is a RESEND, not a duplicate and not an error. Returning it lets the
  -- caller re-run the Auth dispatch against the invitation that already exists —
  -- which is precisely what must happen when the previous attempt committed this
  -- row and then failed to reach GoTrue, or reached it and lost the response.
  --
  -- FOR UPDATE takes a row lock, so two admins submitting simultaneously
  -- serialize here rather than racing to the unique index. The expiry window is
  -- refreshed: a resend restarts the 24 hours, because the invitee is about to
  -- receive a brand-new email and dating their deadline from the first attempt
  -- would shorten it for reasons they cannot see. sent_at is deliberately NOT
  -- cleared — it records that a delivery once succeeded, and finalize() rewrites
  -- it on the next successful dispatch.
  --
  -- The NAMES are overwritten unconditionally, unlike the old optional display
  -- name which was coalesced. Both are required on every call now, so the values
  -- supplied here are always real input — and a resend is exactly how an admin
  -- corrects a name they mistyped the first time. Coalescing would make that
  -- correction silently impossible.
  select ri.id
    into v_existing_id
  from public.retailer_invitations ri
  where ri.retailer_organization_id = v_retailer_org_id
    and ri.email = v_email
    and ri.status = 'PENDING'
  for update;

  if v_existing_id is not null then
    update public.retailer_invitations
    set
      expires_at = now() + interval '24 hours',
      first_name = v_first_name,
      last_name  = v_last_name
    where id = v_existing_id;

    return query select v_existing_id, v_email, true;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 8. The reservation
  -- --------------------------------------------------------------------------
  -- The role is resolved by CODE, never supplied. There is no role parameter in
  -- the signature, so this function can only ever reserve a RETAILER_OWNER
  -- invitation — it cannot be pointed at VENDOR_SUPER_ADMIN or any other role.
  select r.id into v_role_id
  from public.roles r
  where r.code = 'RETAILER_OWNER'
    and r.status = 'ACTIVE';

  if v_role_id is null then
    -- Not reachable in a correctly ordered history — Part 2 seeds this role — so
    -- this fires only when an assumption has already broken. Generic message: the
    -- caller cannot act on a catalogue problem and must not be told about one.
    raise exception 'Not authorized to invite an owner for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  -- Every id written here is DERIVED: the Vendor from the caller's own
  -- authorization context, the Retailer from the verified relationship row, the
  -- role from the catalogue by code, and the actor from auth.uid(). Not one comes
  -- from an argument. status, expires_at, auth_user_id, organization_member_id,
  -- and sent_at all take their column defaults or stay null — this row asserts
  -- only that an invitation was DECIDED, never that anything was delivered.
  insert into public.retailer_invitations (
    vendor_organization_id,
    retailer_organization_id,
    email,
    first_name,
    last_name,
    role_id,
    invited_by_profile_id,
    status
  )
  values (
    v_vendor_org_id,
    v_retailer_org_id,
    v_email,
    v_first_name,
    v_last_name,
    v_role_id,
    v_actor_profile_id,
    'PENDING'
  )
  returning id into v_invitation_id;

  return query select v_invitation_id, v_email, false;
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
-- The full argument-type list is repeated in every statement because a function
-- is identified by its signature: naming it without the types would fail to match,
-- and would silently miss the function if an overload ever existed.
revoke all     on function public.reserve_retailer_owner_invitation(uuid, text, text, text) from public;
revoke execute on function public.reserve_retailer_owner_invitation(uuid, text, text, text) from anon;
grant  execute on function public.reserve_retailer_owner_invitation(uuid, text, text, text) to authenticated;

-- ============================================================================
-- PART 4c — finalize_retailer_owner_invitation()  [service_role ONLY]
-- ============================================================================
-- STEP TWO of two, called by trusted server-side code after Supabase Auth has
-- minted (or resolved) the invitee's Auth user. Creates or reuses the profile,
-- creates or reuses the Retailer membership as INVITED, assigns RETAILER_OWNER,
-- links the invitation to both, records delivery, and writes the audit event —
-- all in ONE transaction.
--
-- WHY THIS ONE IS service_role AND NOT authenticated
--   Every other RPC in this project derives its actor from auth.uid(). This one
--   cannot: it runs on behalf of the Vendor admin, but the row it provisions
--   belongs to a DIFFERENT person — the invitee — whose Auth user was just
--   created by an admin API call that has no session at all. There is no
--   auth.uid() to resolve, and inventing one would mean accepting an actor id as
--   a parameter, which is the exact vulnerability every other function here
--   avoids.
--
--   The honest answer is that this function's authorization was already performed:
--   reserve_retailer_owner_invitation() proved, under the caller's own token, that
--   this Vendor may invite an owner to this Retailer, and wrote the invitation row
--   as the durable evidence. This function does not re-decide that; it CARRIES OUT
--   a decision already recorded and already audited by its inputs. Restricting it
--   to service_role is what keeps that reasoning sound: only trusted server code
--   holding the secret key can reach it, so the invitation row cannot be
--   weaponized by whoever happens to learn its id.
--
--   p_auth_user_id is caller-supplied and is therefore NEVER treated as
--   authorization. It is validated three ways — the user must exist, must be
--   confirmed-or-invited, and its email must equal the invitation's canonical
--   email — before it is recorded. It selects nothing and authorizes nothing.
--
-- IDEMPOTENCY, in detail. Every write below is safe to repeat:
--   * The profile is created only if absent.
--   * The membership uses ON CONFLICT DO NOTHING against
--     organization_members_unique_membership.
--   * The role assignment uses ON CONFLICT DO NOTHING against member_roles_pkey.
--   * The invitation update is a straight assignment of the same values.
--   * The AUDIT event is guarded on sent_at having been null, so a retry after a
--     lost response does not append a second "invited" record for one invitation.
--   * A second call naming a DIFFERENT Auth user is refused outright rather than
--     silently relinking, because that is not a retry — it is a different fact.
create function public.finalize_retailer_owner_invitation(
  p_invitation_id uuid,
  p_auth_user_id  uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv            public.retailer_invitations%rowtype;
  v_retailer_name  text;
  v_role_code      text;
  v_auth_email     text;
  v_profile_id     uuid;
  v_member_id      uuid;
  v_already_sent   boolean;
begin
  if p_invitation_id is null or p_auth_user_id is null then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 1. Load and lock the invitation
  -- --------------------------------------------------------------------------
  -- FOR UPDATE serializes concurrent finalizations of the same invitation, so two
  -- retries racing each other cannot both pass the sent_at guard and write two
  -- audit rows.
  select * into v_inv
  from public.retailer_invitations
  where id = p_invitation_id
  for update;

  if v_inv.id is null then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- Only a live invitation may be finalized. An accepted one is already complete;
  -- an expired or revoked one must never spring back to life through a delayed
  -- retry of a dispatch that should no longer take effect.
  if v_inv.status <> 'PENDING' then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  if v_inv.expires_at <= now() then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- A retry must name the SAME Auth user. A different one is a different fact,
  -- not a repeat, and relinking would silently transfer a reserved ownership to
  -- another person.
  if v_inv.auth_user_id is not null and v_inv.auth_user_id <> p_auth_user_id then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  v_already_sent := v_inv.sent_at is not null;

  -- --------------------------------------------------------------------------
  -- 2. Verify the Auth user and its email
  -- --------------------------------------------------------------------------
  -- THE check that binds the two systems together. Without it, a bug or a
  -- misordered call in the application layer could hand this function an Auth user
  -- belonging to somebody else entirely, and that person would silently become the
  -- owner of a Retailer they were never invited to.
  --
  -- auth.users.email is normalized the same way the invitation's is, so this is a
  -- true equality test rather than a case-sensitive near-miss. Reading auth.users
  -- is possible here only because the function is SECURITY DEFINER and owned by
  -- the migration role.
  select lower(btrim(u.email)) into v_auth_email
  from auth.users u
  where u.id = p_auth_user_id;

  if v_auth_email is null then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  if v_auth_email <> v_inv.email then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Re-verify the relationship and Retailer are still active
  -- --------------------------------------------------------------------------
  -- Re-checked here rather than trusted from reserve(): time passes between the
  -- two calls, and a Vendor that suspended a Retailer in that window must not end
  -- up with a provisioned owner on it anyway.
  if not exists (
    select 1
    from public.vendor_retailers vr
    join public.organizations o on o.id = vr.retailer_organization_id
    where vr.vendor_organization_id = v_inv.vendor_organization_id
      and vr.retailer_organization_id = v_inv.retailer_organization_id
      and vr.status = 'ACTIVE'
      and o.status = 'ACTIVE'
      and o.organization_type = 'RETAILER'
  ) then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  select o.name into v_retailer_name
  from public.organizations o
  where o.id = v_inv.retailer_organization_id;

  select r.code into v_role_code
  from public.roles r
  where r.id = v_inv.role_id;

  -- Defence in depth against a corrupted invitation row: this function provisions
  -- Retailer OWNERS and nothing else. Even though reserve() resolves the role by
  -- code and no parameter can influence it, the assignment below is the single
  -- most consequential write in the milestone, so the role is re-verified
  -- immediately before it is granted rather than assumed from a column.
  if v_role_code is distinct from 'RETAILER_OWNER' then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. Profile — create or safely reuse
  -- --------------------------------------------------------------------------
  -- public.profiles.id IS the auth user id (1:1, FK to auth.users), so there is
  -- nothing to look up by email and no way for two profiles to describe one Auth
  -- user.
  --
  -- An EXISTING profile is reused completely untouched — no name, status, or
  -- mobile number is overwritten. That matters for the existing-user case: a
  -- person who already has an account (perhaps as a Vendor admin, perhaps as an
  -- owner of a different Retailer) must not have their own profile rewritten
  -- because somebody invited them somewhere new. status in particular is left
  -- alone: downgrading an ACTIVE profile to INVITED would be a live account
  -- regression.
  select p.id into v_profile_id
  from public.profiles p
  where p.id = p_auth_user_id;

  if v_profile_id is null then
    -- The names are written STRAIGHT FROM THE INVITATION. There is no derivation,
    -- no splitting, no fallback, and no placeholder anywhere in this function.
    --
    -- That is the whole point of making both names required at reservation time.
    -- profiles.first_name and last_name are NOT NULL and constrained non-empty,
    -- so something must be written here — and the only acceptable something is
    -- what a human actually told us. The invitation's own constraints
    -- (retailer_invitations_first_name_not_empty,
    -- retailer_invitations_last_name_not_empty, and
    -- retailer_invitations_names_trimmed) guarantee these values already satisfy
    -- what profiles will demand, so this INSERT cannot fail on them.
    --
    -- status = 'INVITED', which migration 1 explicitly allows. The profile exists
    -- but its person has not yet set a password or accepted, and that is exactly
    -- what the value means.
    insert into public.profiles (id, first_name, last_name, status)
    values (p_auth_user_id, v_inv.first_name, v_inv.last_name, 'INVITED');

    v_profile_id := p_auth_user_id;
  end if;

  -- --------------------------------------------------------------------------
  -- 5. Membership — INVITED, in the RETAILER organization only
  -- --------------------------------------------------------------------------
  -- organization_id is the RETAILER's, read from the invitation row. There is no
  -- statement anywhere in this function that inserts a membership into the Vendor
  -- organization, and no path by which v_inv.vendor_organization_id could reach
  -- this INSERT. An invitee never becomes a member of the Vendor.
  --
  -- status is 'INVITED' and joined_at stays null: the person has been provisioned
  -- but has not accepted, and joined_at is the record of when they actually did.
  -- accept_retailer_owner_invitation() is the only thing that sets either.
  --
  -- ON CONFLICT DO NOTHING against organization_members_unique_membership makes a
  -- retry a no-op AND correctly handles the existing-member case: a person who
  -- somehow already belongs to this Retailer keeps their existing membership row
  -- and its status untouched rather than being reset to INVITED.
  insert into public.organization_members (organization_id, user_id, status)
  values (v_inv.retailer_organization_id, p_auth_user_id, 'INVITED')
  on conflict (organization_id, user_id) do nothing;

  select m.id into v_member_id
  from public.organization_members m
  where m.organization_id = v_inv.retailer_organization_id
    and m.user_id = p_auth_user_id;

  if v_member_id is null then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 6. Role assignment — RETAILER_OWNER, exactly once
  -- --------------------------------------------------------------------------
  -- The role id comes from the invitation row, which reserve() resolved by code
  -- and section 3 re-verified is still RETAILER_OWNER. assigned_by is the Vendor
  -- admin who issued the invitation, which is the truthful answer to "who granted
  -- this" and is what member_roles.assigned_by exists to record.
  --
  -- ON CONFLICT DO NOTHING against member_roles_pkey (organization_member_id,
  -- role_id) makes this idempotent: the PK itself guarantees a member holds a
  -- given role at most once, so a retry cannot double-assign.
  --
  -- No other role is inserted. There is exactly one INSERT into member_roles in
  -- this function and its role_id is v_inv.role_id, so no Vendor role — and no
  -- role of any kind other than the invited one — can be granted here.
  insert into public.member_roles (organization_member_id, role_id, assigned_by)
  values (v_member_id, v_inv.role_id, v_inv.invited_by_profile_id)
  on conflict (organization_member_id, role_id) do nothing;

  -- --------------------------------------------------------------------------
  -- 7. Link the invitation to what it produced, and record delivery
  -- --------------------------------------------------------------------------
  -- Straight assignment of values already validated above, so repeating it writes
  -- the same row. sent_at is refreshed on every successful dispatch, because a
  -- resend genuinely did send another email and the column should say when the
  -- most recent one went out.
  update public.retailer_invitations
  set
    auth_user_id           = p_auth_user_id,
    organization_member_id = v_member_id,
    sent_at                = now()
  where id = v_inv.id;

  -- --------------------------------------------------------------------------
  -- 8. Audit — in the same transaction as the rows it describes
  -- --------------------------------------------------------------------------
  -- An audit row that can outlive a rolled-back write, or be lost while the write
  -- survives, is worse than none — both are silent lies about what happened. Being
  -- in-line here makes the log and the facts inseparable.
  --
  -- GUARDED on the invitation not having been dispatched before, so a retry after
  -- a lost response does not append a second RETAILER_OWNER_INVITED record for a
  -- single invitation. The retry still repairs every other column; only the log
  -- entry is suppressed, because the event it describes happened once.
  --
  -- Naming: `action` is RETAILER_OWNER_INVITED, past tense, describing what
  -- occurred rather than the RPC that did it, so the log stays readable if the
  -- entry point is ever renamed. `entity_type` is RETAILER_INVITATION — the
  -- invitation is the subject of this event. organization_id is the VENDOR's,
  -- matching the audit convention that the organization column names the tenant
  -- whose activity feed the entry belongs in: the Vendor performed this action.
  -- actor_profile_id is the inviting admin, carried from the invitation row.
  --
  -- entity_id is the audit table's designated column for the subject's id and is
  -- the only place the invitation id appears. It is never returned to a browser
  -- and lib/audit/vendor-audit-logs.ts reads neither entity_id nor metadata.
  --
  -- metadata carries display information ONLY: the Retailer's name, the role code,
  -- and the status. There is deliberately NO email in it. Migration 13 states the
  -- rule this follows verbatim — "No profile id, organization id, relationship id,
  -- shop id, email, role, permission, token, IP address, or user agent" — and an
  -- invitation is not a reason to weaken it. The role CODE is included because it
  -- is a static catalogue literal rather than tenant data, and without it the
  -- record would not say what was actually granted. ip_address and user_agent stay
  -- null: this function cannot observe them truthfully, and a guessed value would
  -- be worse than an absent one.
  if not v_already_sent then
    insert into public.audit_logs (
      organization_id,
      actor_profile_id,
      action,
      entity_type,
      entity_id,
      metadata
    )
    values (
      v_inv.vendor_organization_id,
      v_inv.invited_by_profile_id,
      'RETAILER_OWNER_INVITED',
      'RETAILER_INVITATION',
      v_inv.id::text,
      jsonb_build_object(
        'retailer_name',     v_retailer_name,
        'role_code',         'RETAILER_OWNER',
        'invitation_status', 'PENDING',
        'membership_status', 'INVITED'
      )
    );
  end if;
end;
$$;

-- Privileges. THE most restricted function in this project, and the only one in
-- the codebase granted to service_role rather than authenticated.
--
-- Revoking from `authenticated` is not belt and braces here — it is the control.
-- This function provisions a membership and an owner role for an arbitrary Auth
-- user id, and it does so without an auth.uid() check because it has none to make
-- (see the header). Reachable by a browser session, it would let any signed-in
-- caller who learned an invitation id complete somebody else's provisioning.
-- Every browser role is therefore stripped explicitly, and only the secret-key
-- role that trusted server code holds is granted.
revoke all     on function public.finalize_retailer_owner_invitation(uuid, uuid) from public;
revoke execute on function public.finalize_retailer_owner_invitation(uuid, uuid) from anon;
revoke execute on function public.finalize_retailer_owner_invitation(uuid, uuid) from authenticated;
grant  execute on function public.finalize_retailer_owner_invitation(uuid, uuid) to service_role;

-- ============================================================================
-- PART 4d — accept_retailer_owner_invitation()
-- ============================================================================
-- Called by the INVITEE, authenticated as themselves, after Supabase Auth has
-- verified their invitation token and established a session. Activates the
-- INVITED membership finalize() created, marks the invitation ACCEPTED, and
-- audits — atomically.
--
-- ZERO ARGUMENTS, and this is the single most important design decision in the
-- function. The invitation is resolved solely by `auth_user_id = auth.uid()`,
-- exactly as get_vendor_super_admin_context() resolves the caller's own
-- authorization. There is no invitation id, token, email, or organization
-- parameter, so there is nothing a caller could substitute to accept an
-- invitation that is not theirs — the vulnerability is absent rather than
-- defended against.
--
-- (The batch brief described this as taking an "opaque invitation address". It
-- deliberately does not: the acceptance callback has no channel by which to learn
-- an invitation id without that id travelling through a URL or an email body,
-- which the audit and email rules both forbid. A parameterless function is both
-- safer and the only shape the callback can actually use. This matches the
-- architecture report.)
--
-- The unique partial index retailer_invitations_auth_user_pending_idx guarantees
-- at most one PENDING invitation per Auth user, so the lookup is unambiguous by
-- construction rather than by an ORDER BY tie-break.
create function public.accept_retailer_owner_invitation()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id       uuid;
  v_inv           public.retailer_invitations%rowtype;
  v_retailer_name text;
  v_member_status text;
begin
  -- Identity comes from the JWT and nowhere else.
  v_user_id := auth.uid();

  if v_user_id is null then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 1. Idempotency — an already-accepted invitation for THIS user succeeds
  -- --------------------------------------------------------------------------
  -- Checked BEFORE the pending lookup. A double-submitted acceptance form, a
  -- retried callback, or a refreshed success page must not present the invitee
  -- with an error for something that already worked. Scoped to auth.uid(), so
  -- this can only ever report on the caller's own invitation.
  if exists (
    select 1
    from public.retailer_invitations ri
    where ri.auth_user_id = v_user_id
      and ri.status = 'ACCEPTED'
  ) then
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Resolve the caller's own pending invitation
  -- --------------------------------------------------------------------------
  -- FOR UPDATE serializes concurrent acceptances of the same invitation.
  select * into v_inv
  from public.retailer_invitations
  where auth_user_id = v_user_id
    and status = 'PENDING'
  for update;

  -- ONE message for every failure below, and deliberately so. No pending
  -- invitation, an expired one, a revoked one, a Retailer that has since been
  -- suspended, and a caller who was never invited at all are reported
  -- identically. Distinguishing them would confirm to an arbitrary signed-in
  -- caller that an invitation for them exists but is in some particular state,
  -- which is information about a record they have no right to enumerate.
  if v_inv.id is null then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- Belt and braces over the status filter above: a REVOKED invitation is never
  -- PENDING, so this cannot fire today. It is checked anyway because the
  -- alternative to checking is trusting, and the cost of being wrong here is an
  -- owner activated on a Retailer whose invitation was withdrawn.
  if v_inv.revoked_at is not null then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- Expiry is evaluated against expires_at directly rather than against the
  -- stored status, so a lapsed invitation that no sweep has reached yet is still
  -- refused. This is what makes correctness independent of any scheduled job.
  if v_inv.expires_at <= now() then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- The membership must be the one this invitation produced. A PENDING invitation
  -- with no membership was reserved but never finalized, so there is nothing to
  -- activate.
  if v_inv.organization_member_id is null then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. The relationship and Retailer must still be active
  -- --------------------------------------------------------------------------
  -- Re-checked at acceptance, not merely at invitation. Hours may have passed,
  -- and a Vendor that suspended the Retailer in the meantime must not acquire an
  -- active owner on it.
  if not exists (
    select 1
    from public.vendor_retailers vr
    join public.organizations o on o.id = vr.retailer_organization_id
    where vr.vendor_organization_id = v_inv.vendor_organization_id
      and vr.retailer_organization_id = v_inv.retailer_organization_id
      and vr.status = 'ACTIVE'
      and o.status = 'ACTIVE'
      and o.organization_type = 'RETAILER'
  ) then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. Activate the membership
  -- --------------------------------------------------------------------------
  -- The INVITED -> ACTIVE transition, per the approved membership lifecycle. The
  -- WHERE clause requires the row to still be INVITED and to belong to this
  -- caller, so a membership that was suspended between finalization and
  -- acceptance is not silently reactivated.
  --
  -- joined_at is set here and only here: it records when the person actually
  -- joined, which is now, not when they were provisioned.
  update public.organization_members
  set
    status    = 'ACTIVE',
    joined_at = now()
  where id = v_inv.organization_member_id
    and user_id = v_user_id
    and organization_id = v_inv.retailer_organization_id
    and status = 'INVITED';

  select m.status into v_member_status
  from public.organization_members m
  where m.id = v_inv.organization_member_id;

  -- Fail closed if the membership did not end up ACTIVE — including the case
  -- where it was already SUSPENDED or DEACTIVATED and the UPDATE matched nothing.
  -- An invitation must never be marked ACCEPTED while the membership it claims to
  -- have activated is in some other state.
  if v_member_status is distinct from 'ACTIVE' then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. Mark the invitation accepted
  -- --------------------------------------------------------------------------
  -- status and accepted_at move together, which
  -- retailer_invitations_accepted_consistent requires. The WHERE clause re-asserts
  -- PENDING so a concurrent transition cannot be overwritten.
  update public.retailer_invitations
  set
    status      = 'ACCEPTED',
    accepted_at = now()
  where id = v_inv.id
    and status = 'PENDING';

  select o.name into v_retailer_name
  from public.organizations o
  where o.id = v_inv.retailer_organization_id;

  -- --------------------------------------------------------------------------
  -- 6. Audit
  -- --------------------------------------------------------------------------
  -- organization_id is the RETAILER's here, NOT the Vendor's — a deliberate
  -- switch from the RETAILER_OWNER_INVITED record above. The audit convention is
  -- that the organization column names the tenant whose activity feed the entry
  -- belongs in, and this event was performed BY the invitee, who is now a member
  -- of the Retailer. The Vendor issued the invitation; the Retailer's new owner
  -- accepted it.
  --
  -- actor_profile_id is the invitee's own profile id (= auth.uid() = their
  -- profile's primary key). metadata carries no email, no ids, and no request
  -- metadata, for the same reasons as the invited record.
  insert into public.audit_logs (
    organization_id,
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  values (
    v_inv.retailer_organization_id,
    v_user_id,
    'RETAILER_OWNER_INVITATION_ACCEPTED',
    'RETAILER_INVITATION',
    v_inv.id::text,
    jsonb_build_object(
      'retailer_name',     v_retailer_name,
      'role_code',         'RETAILER_OWNER',
      'invitation_status', 'ACCEPTED',
      'membership_status', 'ACTIVE'
    )
  );
end;
$$;

revoke all     on function public.accept_retailer_owner_invitation() from public;
revoke execute on function public.accept_retailer_owner_invitation() from anon;
grant  execute on function public.accept_retailer_owner_invitation() to authenticated;

-- ============================================================================
-- PART 4e — get_my_pending_retailer_invitation()
-- ============================================================================
-- The password-completion page needs to answer two questions before it renders:
-- does this signed-in person actually have a pending Retailer Owner invitation,
-- and which Retailer is it for? This returns exactly that and nothing else.
--
-- It exists because public.retailer_invitations has RLS enabled with ZERO
-- policies and ZERO grants — the browser cannot read one byte of it directly, by
-- design. Rather than weakening that posture with a read policy, this function
-- projects the single display-safe field the page is allowed to show.
--
-- ZERO ARGUMENTS, resolved solely from auth.uid(), exactly like
-- accept_retailer_owner_invitation() and get_vendor_super_admin_context(). There
-- is no invitation id, email, or organization parameter, so a caller cannot ask
-- about anybody else's invitation — the capability is absent rather than guarded.
--
-- WHAT IT RETURNS, and what it deliberately does not:
--   retailer_name  the Retailer the invitee is joining. Display-safe: the invitee
--                  is about to become its owner, so it is theirs to see.
--   expires_at     so the page can say the invitation is still live.
--
-- NOT returned: the invitation id, the Vendor organization id or name, the
-- Retailer organization id, the membership id, the role id, the Auth user id, the
-- inviting admin's identity, the invitee's own email, or any token. The page has
-- no use for any of them, and a value that never leaves the database cannot leak
-- from a page, an RSC payload, or a log.
--
-- Zero rows means "no live invitation", which is the same answer for a caller who
-- was never invited, whose invitation expired, whose invitation was revoked, and
-- who has already accepted. The page treats them identically.
create function public.get_my_pending_retailer_invitation()
returns table (
  retailer_name text,
  expires_at    timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.name as retailer_name,
    ri.expires_at
  from public.retailer_invitations ri
  join public.organizations o
    on o.id = ri.retailer_organization_id
  where auth.uid() is not null
    and ri.auth_user_id = auth.uid()
    and ri.status = 'PENDING'
    -- Expiry is evaluated against the timestamp directly rather than against the
    -- stored status, so a lapsed invitation that no sweep has reached is already
    -- invisible here. This keeps the page's answer consistent with what
    -- accept_retailer_owner_invitation() will actually permit.
    and ri.expires_at > now()
    -- The membership must exist, i.e. finalize() completed. A reserved-but-
    -- undispatched invitation is not completable and must not render a form that
    -- would fail on submit.
    and ri.organization_member_id is not null;
$$;

revoke all     on function public.get_my_pending_retailer_invitation() from public;
revoke execute on function public.get_my_pending_retailer_invitation() from anon;
grant  execute on function public.get_my_pending_retailer_invitation() to authenticated;

-- ============================================================================
-- PART 4e — revoke_retailer_owner_invitation()
-- ============================================================================
-- Withdraws a live invitation before it is accepted. Marks it REVOKED, retires
-- the INVITED membership it provisioned, and audits — atomically.
--
-- WHY REVOCATION IS IN THIS BATCH RATHER THAN DEFERRED
--   Not for completeness. finalize() provisions a real Auth user, a real profile,
--   a real membership, and a real owner role BEFORE the invitee ever clicks
--   anything. Without revocation, an invitation sent to the wrong address would
--   leave a provisioned owner-in-waiting that a Vendor admin has no supported way
--   to withdraw — and the only alternative would be manual database surgery on a
--   production tenant. A capability that provisions must ship with the capability
--   that un-provisions it.
--
-- WHAT REVOCATION DOES NOT DO
--   It does not delete anything. The invitation row, the profile, the membership,
--   and the member_roles assignment all remain on record; the membership is moved
--   to DEACTIVATED, which is how this schema retires everything. It also does not
--   touch the Auth user — GoTrue owns that lifecycle, and deleting an Auth account
--   that may be shared with another Retailer or with the Vendor would be
--   destructive far beyond this invitation's scope.
--
--   Because the membership is DEACTIVATED rather than deleted, and because
--   accept() requires status = 'INVITED' to activate, a revoked invitation can
--   never subsequently produce an active member — even if the invitee still holds
--   a valid emailed link.
create function public.revoke_retailer_owner_invitation(
  p_invitation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_vendor_org_id    uuid;
  v_inv              public.retailer_invitations%rowtype;
  v_retailer_name    text;
begin
  -- --------------------------------------------------------------------------
  -- 1. Authorization — identical chain to reserve()
  -- --------------------------------------------------------------------------
  v_actor_profile_id := auth.uid();

  if v_actor_profile_id is null then
    raise exception 'Not authorized to revoke this invitation'
      using errcode = 'insufficient_privilege';
  end if;

  select ctx.organization_id
    into v_vendor_org_id
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor_org_id is null then
    raise exception 'Not authorized to revoke this invitation'
      using errcode = 'insufficient_privilege';
  end if;

  -- The same permission that authorizes issuing an invitation authorizes
  -- withdrawing one. A separate RETAILER_OWNERS_REVOKE would let a role be
  -- granted the power to invite without the power to correct its own mistake,
  -- which is a worse outcome than the coarser grant.
  if not public.has_organization_permission(v_vendor_org_id, 'RETAILER_OWNERS_INVITE') then
    raise exception 'Not authorized to revoke this invitation'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Ownership — the invitation must belong to the DERIVED Vendor
  -- --------------------------------------------------------------------------
  -- The two-column filter is the security boundary for the caller-supplied id,
  -- exactly as in reserve(): `id = p_invitation_id` says WHICH row and
  -- `vendor_organization_id = v_vendor_org_id` says it must be one of the
  -- caller's own. Another Vendor's invitation id matches zero rows.
  select * into v_inv
  from public.retailer_invitations
  where id = p_invitation_id
    and vendor_organization_id = v_vendor_org_id
  for update;

  -- One generic message for a null id, an unknown id, another Vendor's id, and an
  -- invitation that is no longer PENDING alike. No foreign-invitation oracle: a
  -- caller cannot learn that an invitation they may not touch exists, nor what
  -- state it is in.
  if v_inv.id is null or v_inv.status <> 'PENDING' then
    raise exception 'Not authorized to revoke this invitation'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Retire the provisioned membership, if finalize() created one
  -- --------------------------------------------------------------------------
  -- Only an INVITED membership is touched. An ACTIVE one would mean the person
  -- has already accepted, which the PENDING check above has already excluded —
  -- but the status filter is stated anyway so this can never downgrade a live
  -- member as a side effect of revoking a stale invitation row.
  --
  -- The member_roles assignment is deliberately left in place. It is a historical
  -- record of what was granted, and the DEACTIVATED membership is what makes it
  -- inert: every authorization helper in this project requires an ACTIVE
  -- membership, so a role attached to a deactivated one authorizes nothing.
  if v_inv.organization_member_id is not null then
    update public.organization_members
    set
      status         = 'DEACTIVATED',
      deactivated_at = now()
    where id = v_inv.organization_member_id
      and status = 'INVITED';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. Mark the invitation revoked
  -- --------------------------------------------------------------------------
  -- status and revoked_at move together, which
  -- retailer_invitations_revoked_consistent requires. Leaving PENDING also frees
  -- the partial unique index, so the Vendor can immediately re-invite the correct
  -- address — which is the whole point of being able to revoke a typo.
  update public.retailer_invitations
  set
    status     = 'REVOKED',
    revoked_at = now()
  where id = v_inv.id
    and status = 'PENDING';

  select o.name into v_retailer_name
  from public.organizations o
  where o.id = v_inv.retailer_organization_id;

  -- --------------------------------------------------------------------------
  -- 5. Audit
  -- --------------------------------------------------------------------------
  -- organization_id is the VENDOR's: the Vendor performed this action, matching
  -- the RETAILER_OWNER_INVITED record. Same metadata rules — no email, no ids, no
  -- request metadata.
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
    'RETAILER_OWNER_INVITATION_REVOKED',
    'RETAILER_INVITATION',
    v_inv.id::text,
    jsonb_build_object(
      'retailer_name',     v_retailer_name,
      'role_code',         'RETAILER_OWNER',
      'invitation_status', 'REVOKED',
      'membership_status', 'DEACTIVATED'
    )
  );
end;
$$;

revoke all     on function public.revoke_retailer_owner_invitation(uuid) from public;
revoke execute on function public.revoke_retailer_owner_invitation(uuid) from anon;
grant  execute on function public.revoke_retailer_owner_invitation(uuid) to authenticated;

-- ============================================================================
-- Closing note on the privilege model
-- ============================================================================
-- No table privilege is granted to anon or authenticated anywhere in this
-- migration, and no RLS policy is created, altered, or dropped on any table.
-- public.retailer_invitations is unreadable and unwritable by every browser role;
-- organizations, profiles, organization_members, member_roles, roles,
-- permissions, role_permissions, audit_logs, vendor_retailers, and retailer_shops
-- all keep exactly the posture migrations 5, 9, and 14 left them in.
--
-- Access to the invitation domain exists only through the five functions above:
-- three for the Vendor admin under their own token, one for the invitee under
-- theirs, and one reachable only by trusted server-side code holding the secret
-- key. One audited door each, no windows.
