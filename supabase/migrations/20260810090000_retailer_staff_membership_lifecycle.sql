-- Migration: retailer_staff_membership_lifecycle
-- Purpose: Adds exactly TWO functions and nothing else:
--
--            public.set_retailer_staff_membership_status(uuid, text)
--              the Retailer Owner's deactivate / reactivate write for an existing
--              RETAILER_MANAGER or SALES_STAFF membership.
--
--            public.get_my_lifecycle_access_state()
--              a zero-argument, self-only, read-only diagnostic that tells the SIGNED-IN
--              CALLER, and nobody else, why their own access is currently refused.
--
-- WHY THIS EXISTS — the gap it closes
--   Until now a Retailer Owner had no way to stand a staff member down. The recorded
--   alternatives were all wrong in a different way: revoking an invitation does nothing to
--   someone who has already accepted it; emptying a shop list is refused by
--   set_retailer_staff_shop_assignments (and was refused there deliberately, with a comment
--   naming THIS milestone as the operation that would own it); and deleting the membership
--   would destroy the person's receipt history, their Shop history and their audit trail.
--
--   So an Owner whose Sales Staff member left the business had exactly two real options:
--   leave a working account in the hands of someone who no longer works there, or ask the
--   Vendor to intervene out of band. This is the missing operation, and it is the whole of
--   this milestone.
--
-- DEACTIVATION IS A MEMBERSHIP FACT, NOT AN IDENTITY FACT
--   The entire lifecycle change is ONE COLUMN PAIR on ONE ROW:
--
--       organization_members.status         'ACTIVE' <-> 'DEACTIVATED'
--       organization_members.deactivated_at  now()   <-> null
--
--   Nothing else moves. Specifically, and by design, this function does NOT touch:
--
--     * auth.users            — no ban, no delete, no update, no metadata write. See the
--                               dedicated note below; this is the single most important
--                               decision in the file.
--     * public.profiles       — including profiles.status. A profile is the PERSON; a
--                               membership is their EMPLOYMENT AT ONE RETAILER. The same
--                               person may be Sales Staff at two Retailers, and one Owner
--                               standing them down must not sign them out of the other.
--                               Deactivating the profile would let one tenant disable an
--                               identity that another tenant depends on.
--     * public.member_roles   — the role assignment survives untouched, which is what makes
--                               reactivation a one-column write rather than a rebuild.
--     * public.retailer_shop_members — live rows stay live, retired rows stay retired.
--     * retailer_staff_invitations, receipt_submissions, audit_logs history — all preserved.
--
--   REACTIVATION THEREFORE RESTORES EVERYTHING AUTOMATICALLY, because nothing was ever
--   removed. That is not a convenience; it is the reason the operation is safe to expose to
--   a Retailer Owner at all. An operation that DELETED roles and Shop assignments on the way
--   down would be unrecoverable in the hands of someone who clicked it by mistake, and this
--   schema has no restore path for either table.
--
-- WHY auth.users IS NOT BANNED AND NOT DELETED
--   Supabase offers `banned_until` and a soft delete on auth.users, and both are the wrong
--   instrument here:
--
--     1. auth.users is GLOBAL and a membership is PER-TENANT. Banning the Auth row would
--        take effect at every Retailer the person works for and at the Vendor, from a button
--        pressed by one Retailer Owner. That is a cross-tenant action wearing a single-tenant
--        label.
--     2. It is not this schema's authorization model. Every protected RPC already refuses an
--        inactive membership through the resolvers (which require m.status = 'ACTIVE'), so a
--        deactivated member is blocked on their VERY NEXT protected request even though their
--        JWT is still valid and unexpired — the session is not the authority, the membership
--        row is. Banning would add a second, redundant authority that could disagree with the
--        first.
--     3. It is unrecoverable in practice. 20260808090000 and the account-recovery work exist
--        precisely because half-built and blocked auth.users rows are extremely hard to reason
--        about after the fact. This milestone does not create more of them.
--     4. auth is not ours to write. No function in this schema writes auth.users, and the one
--        place that reads it (get_retailer_staff_registration_context) is read-only.
--
--   The consequence a client must understand: A DEACTIVATED PERSON CAN STILL SIGN IN. They
--   will simply have no Retailer context — get_my_portal_context() reports 'NONE', every
--   protected RPC refuses, and get_my_lifecycle_access_state() (below) tells them why in
--   words that are safe to render.
--
-- WHY THE SECOND FUNCTION EXISTS AT ALL
--   The activation/deactivation audit found that the existing protected RPCs block an
--   inactive user CORRECTLY but INDISTINGUISHABLY: the resolver returns NULL for a
--   deactivated membership, an inactive Retailer, a wrong-role caller and a caller who was
--   never provisioned, and every one of those becomes the same generic 42501. That
--   uniformity is a security property and is deliberately PRESERVED — it is what stops a
--   caller probing the schema — but it leaves the application unable to write honest copy.
--   "You do not have access to this page" is the wrong sentence for someone whose account
--   was deactivated this morning, and there was no safe way to tell the difference.
--
--   get_my_lifecycle_access_state() closes that gap without weakening anything, because it
--   answers a question that discloses NOTHING A CALLER DOES NOT ALREADY KNOW ABOUT THEMSELVES:
--   it takes no arguments, derives the person solely from auth.uid(), and returns a single
--   word from a closed vocabulary. No id, no name, no email, no role, no organization, no
--   timestamp, no database message. It is a DIAGNOSTIC, never a gate — see its own header.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * No table, column, constraint, index, trigger, policy, role, permission, or
--     role-permission mapping is created, altered, or dropped. RETAILER_STAFF_MANAGE and its
--     RETAILER_OWNER mapping already exist (20260722210000) and are the authority; no NEW
--     staff permission is introduced. organization_members.status and .deactivated_at already
--     exist (20260716124419) and their CHECK constraint already permits both values written
--     here.
--   * No existing function is touched. get_my_portal_context() in particular is byte-identical
--     to what 20260729090000 left, keeps context_version 1, and keeps its generic-denial
--     behaviour. Portal routing does not change in this milestone.
--   * No VENDOR-side Retailer lifecycle permission, RPC, or write is created. Deactivating a
--     whole Retailer organization remains a separate, later milestone.
--   * No table privilege is granted to any browser role, and no RLS policy is added. Neither
--     function widens direct table access by one row.
--   * No hard delete, anywhere.
--   * No service_role grant on either function. The entire authority of both is auth.uid(),
--     which a service-role connection does not have.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE).
--   A conflicting existing object FAILS the migration, matching every function migration in
--   this repository. No fixed UUIDs. No dynamic SQL. All identifiers are <= 63 bytes. Every
--   reference is schema-qualified because both functions run with an EMPTY search_path.
--
-- Dependencies:
--   * 20260716124419 (profiles, organizations, organization_members and its status CHECK,
--     deactivated_at, set_updated_at()).
--   * 20260716125559 (roles, member_roles).
--   * 20260716130351 (audit_logs).
--   * 20260722210000 (RETAILER_STAFF_MANAGE and its RETAILER_OWNER mapping;
--     retailer_shop_members).
--   * 20260723090000 (resolve_retailer_member_organization).
--   * 20260809090000 (set_retailer_staff_shop_assignments — the authorization, locking,
--     role-set, audit and refusal patterns reused below, unchanged).


-- ============================================================================
-- FUNCTION 1 — set_retailer_staff_membership_status(uuid, text)
-- ============================================================================
-- TWO ARGUMENTS, AND NOTHING ELSE. A membership to address and the state to put it in. There
-- is no Retailer id, organization id, actor id, profile id, auth user id, role code,
-- permission code, current status, audit action, or timestamp in this signature — so no URL
-- segment, form field, header, or cookie can nominate whose staff are changed, on whose
-- authority, or from what assumed starting state. Everything that decides WHETHER the write
-- may happen is derived from auth.uid().
--
-- THE TARGET IS A MEMBERSHIP ID, and that is the canonical, safe identifier, for exactly the
-- reasons set_retailer_staff_shop_assignments states:
--   * it is already in the roster contract (list_retailer_staff_members.membership_id),
--     released only to a holder of RETAILER_STAFF_READ, so this introduces no new disclosure;
--   * organization_members is UNIQUE (organization_id, user_id), so a membership id names
--     exactly one person IN EXACTLY ONE ORGANIZATION. That is what makes the single
--     `m.organization_id = v_retailer` predicate below a complete cross-tenant boundary. A
--     profile id or an Auth user id could not do this — one person may be staff at several
--     Retailers, so neither addresses a membership on its own, and accepting one would force
--     this function to GUESS which employment the caller meant.
--
-- WHY THE STATUS IS A STRING AND NOT A BOOLEAN. `deactivate: true` reads well until the day a
-- third state exists, at which point every caller has to be found and changed. The closed
-- vocabulary {ACTIVE, DEACTIVATED} is checked here, is the same vocabulary the column's own
-- CHECK constraint uses, and is the same vocabulary the audit rows record. INVITED and
-- SUSPENDED are members of the COLUMN's vocabulary but are deliberately NOT members of THIS
-- FUNCTION's — see the transition rules in step 6.
--
-- RETURNS ONE ROW OF FOUR FIELDS. The membership addressed, the status it now holds, the role
-- it was proved to hold, and whether this call actually changed anything. status_changed is
-- what lets a client tell "saved" from "already in that state" without a second read and
-- without treating a double-tap as an error. No email, no name, no timestamp, no organization
-- and no audit detail crosses this boundary.
--
-- REFUSALS ARE GENERIC AND UNIFORM. An unauthenticated caller, a Manager, a Sales Staff
-- member, a Vendor, a caller who resolves to zero or to several Retailers, and a null /
-- unknown / another Retailer's / Owner / multi-role / role-less / INVITED / SUSPENDED / SELF
-- target all receive the SAME 42501 and the SAME message. That is what stops a caller
-- sweeping membership ids to learn which ones exist somewhere else, and what stops the
-- refusal itself disclosing another Retailer's org chart.
create function public.set_retailer_staff_membership_status(
  p_membership_id uuid,
  p_status        text
)
returns table (
  membership_id     uuid,
  membership_status text,
  role_code         text,
  status_changed    boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor        uuid;
  v_retailer     uuid;
  v_org_status   text;
  v_org_type     text;
  v_member_id    uuid;
  v_target_user  uuid;
  v_current      text;
  v_role_codes   text[];
  v_role_code    text;
  v_updated      integer;
  v_action       text;
begin
  -- --------------------------------------------------------------------------
  -- 1. Authorization — identity and Retailer, never browser-supplied
  -- --------------------------------------------------------------------------
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not authorized to change this staff member''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- The permission is the gate, and the MAPPING is the authority — not this function.
  -- RETAILER_STAFF_MANAGE is currently mapped to RETAILER_OWNER alone, so a
  -- RETAILER_MANAGER (who holds RETAILER_STAFF_READ but not this) and a SALES_STAFF member
  -- both resolve to NULL here and are refused. NO CALLER ROLE CODE IS NAMED BELOW: if a
  -- future migration grants this permission to another role, that role gains this operation
  -- without this file being edited. This is the EXISTING permission the milestone was told to
  -- use; no new staff permission is created anywhere in this migration.
  --
  -- The resolver also fails closed on zero or on MORE THAN ONE qualifying Retailer, and
  -- independently requires an ACTIVE profile, an ACTIVE membership, an ACTIVE organization of
  -- type RETAILER, and an ACTIVE role. A deactivated Owner therefore cannot reactivate
  -- themselves through this function — they hold no qualifying context to act from.
  v_retailer := public.resolve_retailer_member_organization('RETAILER_STAFF_MANAGE');
  if v_retailer is null then
    raise exception 'Not authorized to change this staff member''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- Re-affirm the actor's profile, so the actor_profile_id written below is a valid, ACTIVE
  -- actor id. auth.uid() IS the profile's primary key. Matches
  -- set_retailer_staff_shop_assignments step 1 and reserve_retailer_staff_invitation step 1.
  if not exists (
    select 1 from public.profiles p where p.id = v_actor and p.status = 'ACTIVE'
  ) then
    raise exception 'Not authorized to change this staff member''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Pin the acting Retailer's lifecycle
  -- --------------------------------------------------------------------------
  -- Lock the resolved Retailer against a concurrent lifecycle change and re-verify. The
  -- resolver already required ACTIVE + RETAILER, so in the ordinary case this is defence in
  -- depth and 55000 is UNREACHABLE through it; it becomes reachable only if the organization
  -- changes between the resolver's read and this lock. FOR SHARE (not FOR UPDATE) because
  -- this function only needs the row to HOLD STILL — it never writes it, and the Vendor-side
  -- Retailer lifecycle write that would contend for it is a later milestone.
  --
  -- This is the same clause, in the same position, as
  -- set_retailer_staff_shop_assignments step 1. It is deliberately taken BEFORE the target is
  -- resolved, so a suspended Retailer cannot be used as an oracle for which membership ids
  -- exist inside it.
  select o.status, o.organization_type
    into v_org_status, v_org_type
  from public.organizations o
  where o.id = v_retailer
  for share;

  if v_org_type is distinct from 'RETAILER' or v_org_status is distinct from 'ACTIVE' then
    raise exception 'This Retailer is not active'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. The requested status — a closed vocabulary of exactly two words
  -- --------------------------------------------------------------------------
  -- Checked AFTER authorization, so an unauthenticated or unauthorized caller learns nothing
  -- from the shape of their own bad input — they are refused with 42501 before this line is
  -- ever reached, exactly as a stranger should be.
  --
  -- The comparison is EXACT and CASE-SENSITIVE. 'active', ' ACTIVE', '' and null are all
  -- rejected rather than coerced: this value is written verbatim into a column whose CHECK
  -- constraint is case-sensitive and into an audit row that is read later by a human, and a
  -- silent upper() here would mean the audit trail and the client disagreed about what was
  -- asked for.
  --
  -- INVITED AND SUSPENDED ARE REJECTED HERE, not further down, and that is the point:
  --   * INVITED is not a state an Owner may CONFER. A membership becomes ACTIVE by the
  --     recipient ACCEPTING their invitation (accept_retailer_staff_invitation), which is the
  --     only place consent is recorded and the only place Shop rows are created. Letting this
  --     RPC promote an INVITED membership would manufacture an accepted employment that the
  --     person never accepted, with no Shop assignments and no acceptance audit row.
  --   * SUSPENDED is reserved for a punitive/administrative state this milestone does not
  --     define an owner for. Nothing here may set it, and nothing here may clear it.
  if p_status is null or p_status not in ('ACTIVE', 'DEACTIVATED') then
    raise exception 'That staff status is not valid'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. The target membership — locked, and proved to be ours
  -- --------------------------------------------------------------------------
  -- FOR UPDATE IS THE SERIALIZATION POINT of this whole function. Two concurrent calls
  -- against the same staff member queue here, so the second reads the first's COMMITTED
  -- status rather than a stale snapshot — which is what makes the idempotency test in step 7
  -- meaningful under concurrency instead of merely under single-user conditions. It also
  -- blocks a concurrent set_retailer_staff_shop_assignments against the same member for the
  -- duration, so a Shop edit and a lifecycle change cannot interleave.
  --
  -- TWO predicates, and only two: `id` says WHICH membership, `organization_id` says it must
  -- be one of the caller's own. Note what is NOT here — there is deliberately no
  -- `status = 'ACTIVE'` filter, because a DEACTIVATED membership is precisely what
  -- reactivation must be able to address. The permitted CURRENT states are checked
  -- explicitly in step 6 instead, where the rule can be stated once and read.
  --
  -- A null, unknown, or cross-tenant target all fall out as NULL here and are refused
  -- IDENTICALLY below. p_membership_id = null yields no row without a special case, because
  -- `m.id = null` is never true.
  select m.id, m.user_id, m.status
    into v_member_id, v_target_user, v_current
  from public.organization_members m
  where m.id = p_membership_id
    and m.organization_id = v_retailer
  for update;

  if v_member_id is null then
    raise exception 'Not authorized to change this staff member''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. The caller may not address their own membership
  -- --------------------------------------------------------------------------
  -- Today this is belt and braces: RETAILER_STAFF_MANAGE is mapped to RETAILER_OWNER alone,
  -- and step 6 refuses every RETAILER_OWNER target, so a caller's own membership is already
  -- unreachable by the role rule. It is written explicitly ANYWAY, because the role rule is
  -- about WHO MAY BE A TARGET and this is about WHO IS ASKING — two different questions that
  -- happen to have the same answer under today's mapping and would stop having it the moment
  -- RETAILER_STAFF_MANAGE were granted to RETAILER_MANAGER. On that day a Manager could
  -- deactivate themselves, be locked out mid-request, and need a second person to undo it.
  --
  -- Compared on user_id rather than on membership id, so it holds regardless of how the
  -- caller's own membership was addressed.
  --
  -- The refusal is the SAME 42501 and the SAME message as every other target refusal: a
  -- caller who supplies their own membership id already knows it is theirs, so there is
  -- nothing to disclose by being specific — but keeping one message means there is one fewer
  -- branch for a future edit to make disclosive.
  if v_target_user = v_actor then
    raise exception 'Not authorized to change this staff member''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 6. The target must be exactly one eligible staff role
  -- --------------------------------------------------------------------------
  -- The WHOLE ACTIVE role set is read and compared to a single-element array, rather than
  -- testing "holds RETAILER_MANAGER or SALES_STAFF". That is deliberate and stricter. It
  -- refuses, in one comparison:
  --
  --   * EVERY RETAILER_OWNER TARGET. This is the headline exclusion of the milestone. An
  --     Owner is the tenant's root of authority: their membership is what
  --     resolve_retailer_owner_organization resolves, so deactivating one can strand a
  --     Retailer with no one able to reactivate anybody — including the person just
  --     deactivated. Owner lifecycle belongs to the Vendor-side milestone, which has an actor
  --     OUTSIDE the tenant and can therefore never lock the tenant out of itself.
  --   * A MULTI-ROLE TARGET, e.g. someone holding RETAILER_OWNER alongside SALES_STAFF, or
  --     RETAILER_MANAGER alongside SALES_STAFF. Such a member is not described by the single
  --     role_code this function returns and audits, and "deactivate the Sales Staff half of
  --     someone" is not a thing this schema models.
  --   * A ROLE-LESS TARGET — a membership row with no ACTIVE role at all, which is a
  --     half-built or partially-revoked state, not a staff member.
  --
  -- member_roles is keyed on (organization_member_id, role_id), so this array cannot contain
  -- a duplicate. The role is captured into v_role_code so that everything returned and
  -- audited below is a value this function PROVED, never one it was handed.
  select coalesce(array_agg(r.code order by r.code), '{}'::text[])
    into v_role_codes
  from public.member_roles mr
  join public.roles r on r.id = mr.role_id
  where mr.organization_member_id = v_member_id
    and r.status = 'ACTIVE';

  if v_role_codes = array['RETAILER_MANAGER']::text[] then
    v_role_code := 'RETAILER_MANAGER';
  elsif v_role_codes = array['SALES_STAFF']::text[] then
    v_role_code := 'SALES_STAFF';
  else
    raise exception 'Not authorized to change this staff member''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- THE CURRENT STATE MUST ALSO BE ONE THIS FUNCTION OWNS.
  -- An INVITED membership has not been accepted and must not be promoted here (step 3 states
  -- why at length). A SUSPENDED membership is in a state this milestone does not define an
  -- owner for, and quietly converting it to ACTIVE or DEACTIVATED would discard whatever
  -- decision put it there. Both are refused with the generic 42501 rather than a distinct
  -- code, so a caller cannot use the response to read another Retailer's roster states.
  if v_current not in ('ACTIVE', 'DEACTIVATED') then
    raise exception 'Not authorized to change this staff member''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 7. Already in the requested state — write NOTHING, including no audit row
  -- --------------------------------------------------------------------------
  -- An identical repeat request performs no UPDATE, so deactivated_at keeps its ORIGINAL
  -- value and the record of when this person was actually stood down survives a double-tap.
  -- Re-running the UPDATE "harmlessly" would silently move that timestamp forward and destroy
  -- exactly the fact the column exists to hold.
  --
  -- No audit row either. This matches set_retailer_staff_shop_assignments step 10 and
  -- reserve_retailer_staff_invitation's resend path: a no-op is not an event, and an audit
  -- trail that logs one per double-tap is a trail nobody can read.
  --
  -- The row is still RETURNED, with status_changed = false, so a client can tell "already
  -- deactivated" from "denied" and render the truth rather than an error.
  if v_current = p_status then
    return query select v_member_id, v_current, v_role_code, false;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 8. The one write
  -- --------------------------------------------------------------------------
  -- ONE ROW, TWO COLUMNS. deactivated_at is SET on the way down and CLEARED on the way back
  -- up, in the same statement as the status, so the pair can never disagree — there is no
  -- window in which a row is DEACTIVATED with a null timestamp or ACTIVE with a stale one.
  -- The column already exists (20260716124419) and is already written this way by the
  -- Retailer Owner invitation lifecycle (20260721150000), so this introduces no new
  -- convention.
  --
  -- updated_at advances through the table's own set_updated_at trigger; it is not written
  -- here.
  --
  -- The `status = v_current` predicate makes this a compare-and-set. Under the FOR UPDATE
  -- lock from step 4 it cannot fail, which is exactly why the row count is checked
  -- immediately below rather than assumed: if it EVER fails, the assumption this function is
  -- built on has been broken by something outside it, and the only safe response is to abort
  -- the whole transaction rather than write an audit row describing a change that did not
  -- happen.
  update public.organization_members m
  set status         = p_status,
      deactivated_at = case when p_status = 'DEACTIVATED' then now() else null end
  where m.id = v_member_id
    and m.organization_id = v_retailer
    and m.status = v_current;

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    -- Unexpected drift. Raising here rolls back this UPDATE and everything else in the
    -- transaction, so no partial state and no orphan audit row can survive. Reported as the
    -- same generic 42501 as every other refusal — a caller has no use for the distinction and
    -- an attacker would.
    raise exception 'Not authorized to change this staff member''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 9. Audit — exactly one safe event, in the same transaction as its row
  -- --------------------------------------------------------------------------
  -- The action names the DIRECTION, so the trail reads as a sequence of decisions rather than
  -- a sequence of updates. Both actions share the entity_type the staff-management family
  -- already uses, so a Retailer's staff history is one queryable stream.
  --
  -- organization_id is the RETAILER's, so the entry lands in the tenant's own activity feed.
  -- It is therefore INVISIBLE to the Vendor-side audit reader added in 20260804090000, which
  -- filters on `organization_id = <the caller's Vendor>`; no Vendor can read a Retailer's
  -- staff lifecycle decisions through it.
  --
  -- METADATA CARRIES EXACTLY THREE KEYS, and every one of them is a value this function
  -- PROVED above rather than one it was handed: the role set was read in step 6, the before
  -- status was read under lock in step 4, and the after status was validated in step 3.
  -- Deliberately absent: every email address, every Auth user id, every profile id (the ACTOR
  -- is actor_profile_id, a first-class column whose reader already has authority over it, and
  -- the TARGET is entity_id — neither belongs in free-form metadata), every Shop id, every
  -- invitation id, every receipt id, every token, hash, provider message, and every
  -- caller-supplied value.
  v_action := case p_status
    when 'DEACTIVATED' then 'STAFF_MEMBERSHIP_DEACTIVATED'
    when 'ACTIVE'      then 'STAFF_MEMBERSHIP_REACTIVATED'
  end;

  insert into public.audit_logs (
    organization_id,
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  values (
    v_retailer,
    v_actor,
    v_action,
    'RETAILER_STAFF_MEMBER',
    v_member_id::text,
    jsonb_build_object(
      'role_code',                v_role_code,
      'membership_status_before', v_current,
      'membership_status_after',  p_status
    )
  );

  return query select v_member_id, p_status, v_role_code, true;
end;
$$;


-- ============================================================================
-- FUNCTION 2 — get_my_lifecycle_access_state()
-- ============================================================================
-- ZERO ARGUMENTS. That is the whole security design, not a convenience. A function that
-- accepted a profile id, a membership id, an email or an organization id would be a lookup
-- service for other people's lifecycle states wearing a self-service label; with no
-- arguments at all there is nothing for a caller to substitute, no tenant to select, and no
-- id to sweep. The subject is auth.uid() and can only ever be auth.uid().
--
-- ONE COLUMN, ONE ROW, ONE WORD FROM A CLOSED VOCABULARY:
--
--   ACTIVE                 exactly one supported Retailer context, and everything about it
--                          is ACTIVE. Access should be working.
--   PROFILE_INACTIVE       the caller's own profile is not ACTIVE. Nothing they do at any
--                          Retailer will work until that is resolved.
--   MEMBERSHIP_INACTIVE    their one Retailer is ACTIVE, but their membership of it is not.
--                          This is the state THIS MIGRATION's first function creates.
--   ORGANIZATION_INACTIVE  their one Retailer organization is not ACTIVE.
--   NO_SUPPORTED_ACCESS    no supported Retailer membership context exists at all.
--   AMBIGUOUS              more than one qualifying Retailer context, so no single
--                          lifecycle story can be told and none is invented.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN: no profile id, membership id, organization id,
-- organization name, email address, role code, raw profile/membership/organization status,
-- timestamp, or database message. A UI may map the word above to a sentence; it can learn
-- nothing else here.
--
-- ⚠️ THIS IS A DIAGNOSTIC, NOT AN AUTHORIZATION GATE, AND MUST NEVER BECOME ONE.
--   The authoritative resolvers — resolve_retailer_member_organization,
--   resolve_retailer_owner_organization, get_vendor_super_admin_context — remain the only
--   things that decide whether an operation may proceed, and each protected RPC calls them
--   for ITSELF, server-side, on every request. This function returning 'ACTIVE' is not
--   permission to do anything; it is a description of why the real gate said no, computed
--   AFTER the real gate said no. A client that branched on this value INSTEAD of calling the
--   operation would be trusting a read to authorize a write, which is precisely the mistake
--   this schema's whole design avoids.
--
-- ⚠️ IT IS ALSO NOT A SECOND get_my_portal_context(). That function decides ROUTING and its
--   contract (context_version 1, portal_kind, vendor, retailer, capabilities) is consumed by
--   shipped clients; this one explains DENIAL. Merging them would have meant editing a live
--   read contract to carry a field only the error path uses, and would have forced every
--   application boot to pay for a computation only a refusal needs. They stay separate, and
--   get_my_portal_context() is not modified by this migration in any way.
--
-- WHY IT NAMES ROLE CODES, WHEN ALMOST NOTHING ELSE IN THIS SCHEMA DOES. Every authorization
-- path deliberately resolves by PERMISSION so a future mapping change moves behaviour without
-- a migration. This function is not an authorization path — it is a description of the three
-- RETAILER-SIDE roles whose lifecycle an end user might need explained. There is no
-- permission that means "is a Retailer person of the kind this feature is about", and
-- inventing one would be inventing an authorization concept for a function that authorizes
-- nothing. The list is stated here, in one place, and is asserted by both test suites.
--
-- STABLE, not VOLATILE: it performs no write of any kind — no audit row, no last-seen
-- timestamp, nothing. Logging every refusal diagnosis would add a high-volume, low-value
-- write path to a table the Vendor reads, exactly as get_my_portal_context() declines to.
create function public.get_my_lifecycle_access_state()
returns table (
  access_state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid            uuid;
  v_profile_status text;
  v_has_profile    boolean;
  v_contexts       integer;
  v_org_status     text;
  v_member_status  text;
begin
  -- --------------------------------------------------------------------------
  -- 1. Signed out
  -- --------------------------------------------------------------------------
  -- Defence in depth: this function is granted to `authenticated` and to nothing else, so a
  -- caller with no JWT is the `anon` role and is refused EXECUTE by Postgres before a single
  -- line here runs. The guard exists because every authorization helper in this schema
  -- carries the same explicit test, and because 42501 — rather than a vocabulary word — is
  -- the honest answer: "you are not signed in" is not a lifecycle state, and returning one
  -- would let an unauthenticated caller treat this as a probe.
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'Not authorized to read access state'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. The caller's own profile
  -- --------------------------------------------------------------------------
  -- Addressed by auth.uid(), which IS the profile's primary key, so this SELECT performs no
  -- access decision of its own and cannot return a row for anybody else.
  --
  -- A MISSING PROFILE IS 'NO_SUPPORTED_ACCESS', NOT 'PROFILE_INACTIVE'. An auth.users row
  -- with no profile is not a deactivated person — it is a person who was never provisioned
  -- here at all (the half-built shells that 20260808090000 and the account-recovery work
  -- exist to reason about). Reporting PROFILE_INACTIVE would put "your account has been
  -- deactivated" in front of someone whose account was never activated, which is both wrong
  -- and alarming. It is also unreachable through NO_SUPPORTED_ACCESS's other cause, so the
  -- two never contradict each other: with no profile there is certainly no membership.
  select p.status
    into v_profile_status
  from public.profiles p
  where p.id = v_uid;

  v_has_profile := found;

  if not v_has_profile then
    return query select 'NO_SUPPORTED_ACCESS'::text;
    return;
  end if;

  -- PROFILE FIRST, because it is the broadest cause. A person whose profile is not ACTIVE is
  -- blocked everywhere — at every Retailer and at the Vendor — so naming a single
  -- membership or organization as the reason would send them to fix the wrong thing.
  if v_profile_status is distinct from 'ACTIVE' then
    return query select 'PROFILE_INACTIVE'::text;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 3. The caller's supported Retailer contexts
  -- --------------------------------------------------------------------------
  -- Deliberately NOT resolved through resolve_retailer_member_organization: that resolver
  -- requires an ACTIVE membership in an ACTIVE organization and returns NULL otherwise, so
  -- every state this function exists to DISTINGUISH would collapse into one NULL. This reads
  -- the rows directly, filtered ONLY to the caller's own memberships.
  --
  -- The ROLE must still be ACTIVE, matching every resolver in the schema: a retired role
  -- grants nothing, so it cannot be the basis of a lifecycle story either. The MEMBERSHIP and
  -- the ORGANIZATION statuses are deliberately NOT filtered — they are the answer, not the
  -- filter.
  --
  -- `distinct` collapses a member who holds two supported roles in the same organization into
  -- ONE context; without it such a person would be reported AMBIGUOUS on the strength of
  -- their own role list alone. THE MEMBERSHIP ID IS IN THE SELECT LIST FOR THAT REASON AND
  -- MUST STAY THERE, even though nothing reads it: it is what keeps two genuinely different
  -- contexts distinct when their statuses happen to match. Dropping it would collapse two
  -- ACTIVE memberships at two Retailers into one row and report ACTIVE where the honest
  -- answer is AMBIGUOUS. (organization_members is UNIQUE (organization_id, user_id), so one
  -- membership is one organization and the count below is a count of both.)
  with contexts as (
    select distinct
      m.id     as membership_id,
      m.status as membership_status,
      o.status as organization_status
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    where m.user_id = v_uid
      and o.organization_type = 'RETAILER'
      and r.status = 'ACTIVE'
      and r.code in ('RETAILER_OWNER', 'RETAILER_MANAGER', 'SALES_STAFF')
  )
  select
    count(*)::integer,
    -- min() over a one-row set is that row's value; over a larger set the values are
    -- discarded unread, because the count branch below returns before they are consulted.
    min(c.organization_status),
    min(c.membership_status)
    into v_contexts, v_org_status, v_member_status
  from contexts c;

  -- No supported Retailer context at all: a Vendor-only user, an invited-but-never-accepted
  -- person with no role yet, or somebody whose roles are all retired. There is no lifecycle
  -- story to tell, and inventing one ("your membership is inactive") would name a membership
  -- that does not exist.
  if v_contexts = 0 then
    return query select 'NO_SUPPORTED_ACCESS'::text;
    return;
  end if;

  -- More than one qualifying Retailer: the schema permits it, this diagnostic cannot
  -- summarize it, and it will not GUESS. Reported honestly as AMBIGUOUS rather than by
  -- silently picking the first row — the same fail-closed instinct the Retailer resolvers
  -- have, which return NULL rather than choose. A client should treat this as "we cannot
  -- explain it, contact support", never as a denial reason to render as fact.
  if v_contexts > 1 then
    return query select 'AMBIGUOUS'::text;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 4. The single context, in precedence order
  -- --------------------------------------------------------------------------
  -- ORGANIZATION BEFORE MEMBERSHIP, and the order matters when BOTH are non-ACTIVE. The
  -- Retailer-wide block is the broader cause and the one that has to be resolved first:
  -- telling a Sales Staff member "your membership was deactivated" when their entire Retailer
  -- is suspended would send them to an Owner who is themselves locked out and can do nothing
  -- about it. Naming the Retailer-level cause sends the question to the only party who can
  -- actually act on it.
  if v_org_status is distinct from 'ACTIVE' then
    return query select 'ORGANIZATION_INACTIVE'::text;
    return;
  end if;

  if v_member_status is distinct from 'ACTIVE' then
    return query select 'MEMBERSHIP_INACTIVE'::text;
    return;
  end if;

  -- Everything checked is ACTIVE. Note again what this does NOT mean: it is not a grant, and
  -- it does not promise that any particular operation will succeed — only that no LIFECYCLE
  -- reason explains a refusal. A caller who sees ACTIVE and is still refused is being refused
  -- for an ordinary authorization reason (wrong role, wrong tenant, wrong target), which is
  -- exactly the generic 42501 the protected RPCs already return and which this function
  -- deliberately does not elaborate on.
  return query select 'ACTIVE'::text;
end;
$$;


-- ============================================================================
-- Privileges
-- ============================================================================
-- PostgreSQL grants EXECUTE to PUBLIC on every new function by default, and PUBLIC is
-- inherited by every role — so without the first revoke on each, anon would hold EXECUTE on a
-- SECURITY DEFINER writer and on a self-disclosure read despite nothing here granting it.
-- anon is revoked explicitly as well, so the intent survives a future re-grant to PUBLIC.
--
-- service_role is granted NOTHING on either function, deliberately. The entire authority of
-- both is auth.uid(), which a service-role connection does not have: the write would have no
-- actor to attribute the audit row to, and the read would have no subject and could only ever
-- describe nobody. A grant would produce a path that can only ever refuse — while inviting
-- someone to try to use it.
revoke all     on function public.set_retailer_staff_membership_status(uuid, text) from public;
revoke execute on function public.set_retailer_staff_membership_status(uuid, text) from anon;
grant  execute on function public.set_retailer_staff_membership_status(uuid, text) to authenticated;

revoke all     on function public.get_my_lifecycle_access_state() from public;
revoke execute on function public.get_my_lifecycle_access_state() from anon;
grant  execute on function public.get_my_lifecycle_access_state() to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- Two functions added; nothing else exists in this migration. No table, column, constraint,
-- index, trigger, RLS policy, role, permission, or role-permission mapping is created,
-- altered, or dropped, and NO EXISTING FUNCTION IS TOUCHED — get_my_portal_context() keeps
-- context_version 1 and its generic-denial behaviour byte for byte, both Retailer resolvers
-- and get_vendor_super_admin_context are unchanged, and every list_*, invitation, acceptance,
-- receipt and Shop-assignment function is exactly what its own migration left.
--
-- public.organization_members keeps the posture 20260716124419 and 20260716131930 left it in:
-- RLS enabled, read-only policies only, and NO insert/update/delete privilege of any kind
-- held by anon or authenticated. This function is the only way a browser session can change a
-- staff membership status. profiles, member_roles, retailer_shop_members, retailer_shops,
-- retailer_staff_invitations, receipt_submissions, organizations and auth.users are neither
-- written nor re-privileged anywhere above.
--
-- The two audit vocabulary entries this adds — actions 'STAFF_MEMBERSHIP_DEACTIVATED' and
-- 'STAFF_MEMBERSHIP_REACTIVATED' — need no catalogue row: audit_logs.action and .entity_type
-- are free text with only a not-empty check, exactly as every existing code in those columns
-- is. entity_type 'RETAILER_STAFF_MEMBER' is the one 20260809090000 already established.
--
-- The VENDOR-side Retailer organization lifecycle — deactivating a whole Retailer, and the
-- permission and RPC that would do it — is a LATER MILESTONE and is not begun here. This
-- migration only READS organizations.status, and only to refuse (55000) or to describe
-- (ORGANIZATION_INACTIVE).
