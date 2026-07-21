-- ============================================================================
-- Migration: repair_retailer_owner_invitation_lifecycle
-- ============================================================================
-- Purpose: close two confirmed lifecycle defects in the Retailer Owner invitation
-- domain, and add the single read-only owner-status RPC the Vendor UI will later
-- consume. This migration is ADDITIVE and TABLE-PRESERVING: it CREATE OR REPLACEs
-- two existing functions whose bodies were already released in migration
-- 20260720092755, and it CREATEs one new function. No table, column, constraint,
-- index, trigger, policy, grant, or RLS posture on any table is altered.
--
-- WHAT WAS BROKEN
--
--   Defect 1 — a pending invitation could not be resent.
--     finalize_retailer_owner_invitation() creates an INVITED RETAILER_OWNER
--     membership as its normal, successful outcome. reserve_retailer_owner_
--     invitation() then refused any call that found an ACTIVE *or INVITED* owner
--     membership BEFORE it reached the same-email resend branch. So the ordinary
--     "resend this person's invitation" case tripped the existing-owner guard on
--     the very membership its own finalization had created, and was reported as
--     "This Retailer already has an owner". The fix reorders the checks so a
--     same-email, still-live PENDING invitation is recognised as a RESEND before
--     any INVITED-membership guard runs.
--
--   Defect 2 — expiration left a stale membership behind.
--     expire_stale_retailer_invitations() moved a lapsed invitation PENDING ->
--     EXPIRED but left the INVITED membership finalize() had created untouched.
--     That orphaned INVITED membership then kept tripping the existing-owner guard
--     forever, so a Retailer whose only invitation had expired could never be
--     invited again. The fix expires the invitation and DEACTIVATEs its linked
--     INVITED membership atomically, in one statement.
--
-- WHAT IS ADDED
--
--   get_vendor_retailer_owner_status(p_relationship_id uuid) — a SECURITY DEFINER,
--   STABLE, read-only RPC that returns exactly one display-safe owner state for a
--   Vendor-managed Retailer relationship: NONE, DELIVERY_FAILED, PENDING, EXPIRED,
--   or ACTIVE. It derives the Vendor from auth.uid(), requires the established
--   RETAILERS_READ authority, verifies the relationship belongs to that Vendor, and
--   returns no id, token, or cross-tenant value of any kind.
--
-- No enum type is created for the five display states: they are a projection this
-- one function computes, not a stored column, and a type would couple the schema
-- to a UI vocabulary. No browser table grant and no RLS policy is added anywhere.
-- ============================================================================


-- ============================================================================
-- PART 1 — expire_stale_retailer_invitations()  [internal, CREATE OR REPLACE]
-- ============================================================================
-- The signature (uuid) -> void, language, volatility, security context,
-- search_path, ownership, and privilege set are all UNCHANGED from migration
-- 20260720092755. Only the body changes: it now retires the linked membership in
-- the same statement that expires the invitation.
--
-- ATOMICITY. Both writes live in ONE statement via a data-modifying CTE, so the
-- invitation transition and the membership transition commit or roll back
-- together — an expired invitation can never be observed with a still-INVITED
-- membership, and a deactivated membership can never be observed with a still-
-- PENDING invitation. The invitation UPDATE runs in the CTE and the membership
-- UPDATE is the primary statement; both execute exactly once against one snapshot.
--
-- LOCK ORDER. Invitations are locked (by the CTE UPDATE) before memberships (by
-- the outer UPDATE), the same order revoke_retailer_owner_invitation() uses. A
-- consistent invitation-before-membership order across every writer in this domain
-- is what keeps concurrent expiry, reservation, and revocation from deadlocking.
--
-- SCOPE AND SAFETY.
--   * Only invitations for the passed Retailer are touched — the same p_retailer_
--     organization_id guard as before, so a single invitation attempt never sweeps
--     another tenant's rows.
--   * Only the membership LINKED to an expired invitation (by organization_member_
--     id) is considered; there is no broad cleanup of every INVITED membership.
--   * Only an INVITED membership is deactivated. An ACTIVE, SUSPENDED, or already-
--     DEACTIVATED membership is left exactly as it was — the status = 'INVITED'
--     filter is what guarantees expiry can never downgrade a live owner or disturb
--     a membership some other action already retired.
--   * An invitation with no linked membership (organization_member_id IS NULL) still
--     expires correctly; it simply contributes no membership id to the second
--     UPDATE.
--
-- NO AUDIT EVENT, unchanged from before. Expiry is the absence of an action, not an
-- action: there is no actor to record, and audit_logs.actor_profile_id would be
-- null on a row describing a thing no one performed. The invitation's status and
-- the membership's status are the complete record of what happened.
create or replace function public.expire_stale_retailer_invitations(
  p_retailer_organization_id uuid
)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  with expired as (
    update public.retailer_invitations
    set status = 'EXPIRED'
    where p_retailer_organization_id is not null
      and retailer_organization_id = p_retailer_organization_id
      and status = 'PENDING'
      and expires_at <= now()
    returning organization_member_id
  )
  update public.organization_members m
  set
    status         = 'DEACTIVATED',
    deactivated_at = now()
  where m.status = 'INVITED'
    and m.id in (
      select e.organization_member_id
      from expired e
      where e.organization_member_id is not null
    );
$$;

-- Privileges: UNCHANGED. Re-stated as belt and braces so a future reader sees the
-- posture in the same file that defines the body. CREATE OR REPLACE preserves the
-- existing grants regardless; these revokes assert them rather than alter them.
revoke all on function public.expire_stale_retailer_invitations(uuid) from public;
revoke execute on function public.expire_stale_retailer_invitations(uuid) from anon;
revoke execute on function public.expire_stale_retailer_invitations(uuid) from authenticated;


-- ============================================================================
-- PART 2 — reserve_retailer_owner_invitation()  [CREATE OR REPLACE]
-- ============================================================================
-- Signature (uuid, text, text, text) -> table(invitation_id uuid,
-- normalized_email text, is_resend boolean), language, volatility, security
-- context, search_path, ownership, and privilege set are all UNCHANGED. The
-- application contract in lib/invitations/retailer-owner-invitations.ts — the
-- three returned columns, the four SQLSTATEs, the resend semantics — is preserved
-- byte for byte.
--
-- ONLY the ordering of the post-validation checks changes, to the sequence the
-- lifecycle actually requires:
--
--   1. Expire stale PENDING invitations for this Retailer and DEACTIVATE their
--      linked INVITED memberships  (Part 1, called here).
--   2. Block an existing ACTIVE Retailer Owner.
--   3. Recognise a still-live PENDING invitation to the SAME canonical email as a
--      RESEND, and reuse it — BEFORE any INVITED-membership guard.
--   4. Block a still-live PENDING invitation to a DIFFERENT email.
--   5. Block any other conflicting INVITED owner membership.
--   6. Otherwise create a new reservation.
--
-- Sections 1-4 below (authorization, ownership, active-write gate, input
-- normalization) are carried over verbatim from migration 20260720092755. Only
-- sections 5-8 are restructured.
create or replace function public.reserve_retailer_owner_invitation(
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
  -- 1. Authorization  (UNCHANGED)
  -- --------------------------------------------------------------------------
  v_actor_profile_id := auth.uid();

  if v_actor_profile_id is null then
    raise exception 'Not authorized to invite an owner for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  select ctx.organization_id
    into v_vendor_org_id
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor_org_id is null then
    raise exception 'Not authorized to invite an owner for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  if not public.has_organization_permission(v_vendor_org_id, 'RETAILER_OWNERS_INVITE') then
    raise exception 'Not authorized to invite an owner for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Ownership — the relationship must belong to the DERIVED Vendor  (UNCHANGED)
  -- --------------------------------------------------------------------------
  select vr.retailer_organization_id, vr.status, o.status
    into v_retailer_org_id, v_relationship_status, v_retailer_status
  from public.vendor_retailers vr
  join public.organizations o
    on o.id = vr.retailer_organization_id
  where vr.id = p_relationship_id
    and vr.vendor_organization_id = v_vendor_org_id
    and o.organization_type = 'RETAILER';

  if v_retailer_org_id is null then
    raise exception 'Not authorized to invite an owner for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Active write gate  (UNCHANGED)
  -- --------------------------------------------------------------------------
  if v_relationship_status <> 'ACTIVE' then
    raise exception 'This Retailer relationship is not active'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_retailer_status <> 'ACTIVE' then
    raise exception 'This Retailer organization is not active'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. Input normalization and validation  (UNCHANGED)
  -- --------------------------------------------------------------------------
  v_email      := lower(btrim(coalesce(p_email, '')));
  v_first_name := btrim(coalesce(p_first_name, ''));
  v_last_name  := btrim(coalesce(p_last_name, ''));

  if v_email = '' then
    raise exception 'An email address is required'
      using errcode = 'check_violation';
  end if;

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

  if v_email collate "C" !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email address'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. Expire stale invitations for this Retailer  (UNCHANGED CALL)
  -- --------------------------------------------------------------------------
  -- Runs before ANY owner-state check below. It now also DEACTIVATEs the INVITED
  -- membership linked to each expired invitation (Part 1), which is what stops a
  -- lapsed invitation's orphaned membership from tripping the existing-owner guard
  -- in section 7 — Defect 2. The id passed is the one verified in section 2, never
  -- the caller's argument.
  perform public.expire_stale_retailer_invitations(v_retailer_org_id);

  -- --------------------------------------------------------------------------
  -- 6. Block an existing ACTIVE Retailer Owner  (REORDERED — ACTIVE only)
  -- --------------------------------------------------------------------------
  -- This used to also block INVITED memberships, which is precisely what broke the
  -- resend path (Defect 1): a finalized pending invitation's own INVITED membership
  -- looked like "already has an owner" before the same-email resend branch could
  -- run. The INVITED case is now handled AFTER the resend branch, in section 7b, so
  -- that a same-email resend reaches its reuse path first.
  --
  -- An ACTIVE RETAILER_OWNER, by contrast, has already accepted: there is nothing
  -- to resend, and this must fail closed regardless of the email supplied. Same
  -- specific-but-safe message and SQLSTATE as before (ownership is already proven).
  if exists (
    select 1
    from public.organization_members m
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    where m.organization_id = v_retailer_org_id
      and m.status = 'ACTIVE'
      and r.code = 'RETAILER_OWNER'
  ) then
    raise exception 'This Retailer already has an owner'
      using errcode = 'unique_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 7. Idempotent resend for a still-live SAME-EMAIL invitation  (REORDERED)
  -- --------------------------------------------------------------------------
  -- Moved AHEAD of the INVITED-membership guard. A still-PENDING, unexpired
  -- invitation to the SAME canonical mailbox for the SAME Retailer is a RESEND, not
  -- a duplicate and not an error — whether or not finalize() already created its
  -- INVITED membership. Returning it lets the caller re-run the Auth dispatch and
  -- finalization against the invitation that already exists, which is exactly the
  -- DELIVERY_FAILED recovery path and the ordinary "send it again" path alike.
  --
  -- The expiry sweep in section 5 has already demoted any lapsed same-email PENDING
  -- row to EXPIRED, so status = 'PENDING' cannot match a stale one here; the
  -- expires_at guard is belt and braces. FOR UPDATE serializes two admins resending
  -- at once. The 24-hour window is refreshed and the names are overwritten with the
  -- supplied input, so a resend both restarts the clock and lets an admin correct a
  -- mistyped name. sent_at is deliberately NOT touched — finalize() rewrites it on
  -- the next successful dispatch.
  select ri.id
    into v_existing_id
  from public.retailer_invitations ri
  where ri.retailer_organization_id = v_retailer_org_id
    and ri.email = v_email
    and ri.status = 'PENDING'
    and ri.expires_at > now()
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
  -- 7b. Block a conflicting DIFFERENT-email owner state  (REORDERED)
  -- --------------------------------------------------------------------------
  -- Reaching here means there is no same-email invitation to resend. If the
  -- Retailer nonetheless already has an owner-in-waiting under a DIFFERENT email,
  -- admitting this call would create a second owner racing to accept. Two shapes of
  -- that state are blocked:
  --
  --   * A still-live PENDING invitation to a different email (necessarily different,
  --     since a same-email one would have returned above). This covers a DELIVERY_
  --     FAILED reservation that has no membership yet.
  --   * An INVITED RETAILER_OWNER membership — a finalized different-email
  --     invitation whose membership section 5's sweep did not retire because that
  --     invitation is still live. This is the guard that used to sit in section 6.
  --
  -- Both raise the same specific-but-safe message as an ACTIVE owner would.
  if exists (
    select 1
    from public.retailer_invitations ri
    where ri.retailer_organization_id = v_retailer_org_id
      and ri.status = 'PENDING'
      and ri.expires_at > now()
  ) then
    raise exception 'This Retailer already has an owner'
      using errcode = 'unique_violation';
  end if;

  if exists (
    select 1
    from public.organization_members m
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    where m.organization_id = v_retailer_org_id
      and m.status = 'INVITED'
      and r.code = 'RETAILER_OWNER'
  ) then
    raise exception 'This Retailer already has an owner'
      using errcode = 'unique_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 8. The reservation  (UNCHANGED)
  -- --------------------------------------------------------------------------
  select r.id into v_role_id
  from public.roles r
  where r.code = 'RETAILER_OWNER'
    and r.status = 'ACTIVE';

  if v_role_id is null then
    raise exception 'Not authorized to invite an owner for this Retailer'
      using errcode = 'insufficient_privilege';
  end if;

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

-- Privileges: UNCHANGED. Re-stated as belt and braces; CREATE OR REPLACE preserves
-- the existing grants.
revoke all     on function public.reserve_retailer_owner_invitation(uuid, text, text, text) from public;
revoke execute on function public.reserve_retailer_owner_invitation(uuid, text, text, text) from anon;
grant  execute on function public.reserve_retailer_owner_invitation(uuid, text, text, text) to authenticated;


-- ============================================================================
-- PART 3 — get_vendor_retailer_owner_status()  [NEW, read-only]
-- ============================================================================
-- The single owner state the Vendor retailer-detail UI will consume. It answers
-- "what is the owner situation for THIS relationship?" with exactly one of five
-- display-safe states and a small set of display fields — and nothing else.
--
-- IDENTIFIER AND AUTHORIZATION. p_relationship_id is the vendor_retailers.id, the
-- same ADDRESS the retailer-detail route (lib/retailers/vendor-retailer-detail.ts)
-- already uses. It is not authorization: the Vendor is derived from auth.uid() via
-- get_vendor_super_admin_context(), the caller must hold the established
-- RETAILERS_READ authority for that Vendor, and the relationship must belong to it.
-- A missing, foreign, or malformed id, an unauthenticated caller, and an ordinary
-- authenticated user without the role all fail closed with one generic raise — the
-- same non-oracle posture as reserve() and the retailer-detail route.
--
-- SECURITY. SECURITY DEFINER so it can read across the identity and invitation
-- tables that RLS keeps closed to the browser; STABLE because it only reads;
-- SET search_path = '' so every reference is schema-qualified and no caller search
-- path can redirect a lookup. EXECUTE is revoked from PUBLIC and anon and granted
-- only to authenticated. No table grant and no RLS policy is created.
--
-- WHAT IT RETURNS. owner_state plus display-only fields. It NEVER returns the
-- invitation id, Auth user id, membership id, organization id, relationship id,
-- role id, permission id, token/token hash, or any audit metadata. owner_email is
-- the invitee's own address for a live/expired invitation the caller issued, or the
-- accepted owner's address — never a value from another tenant.
--
-- STATE PRECEDENCE (highest wins):
--   1. ACTIVE          — a qualifying ACTIVE RETAILER_OWNER membership exists.
--   2. PENDING /        — a current, unexpired PENDING invitation exists;
--      DELIVERY_FAILED    PENDING if finalize() completed (membership + sent_at both
--                         present), DELIVERY_FAILED otherwise.
--   3. EXPIRED         — an EXPIRED invitation, or a PENDING one already past its
--                        expires_at that no sweep has reached, is the newest
--                        applicable record.
--   4. NONE            — none of the above; also the answer for a Retailer whose only
--                        history is REVOKED or ACCEPTED-but-no-longer-active rows.
--
-- Expiry is evaluated against expires_at directly, exactly as accept_retailer_owner_
-- invitation() and get_my_pending_retailer_invitation() do, so the answer is correct
-- whether or not the stored status has been swept. A PENDING row whose deadline has
-- passed is never reported as PENDING or DELIVERY_FAILED; it falls to the EXPIRED
-- tier. A finalize()-incomplete row (member/sent_at missing) is classified DELIVERY_
-- FAILED rather than PENDING — failing closed on any inconsistent row.
create function public.get_vendor_retailer_owner_status(
  p_relationship_id uuid
)
returns table (
  owner_state      text,
  owner_first_name text,
  owner_last_name  text,
  owner_email      text,
  sent_at          timestamptz,
  expires_at       timestamptz,
  accepted_at      timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor_org_id   uuid;
  v_retailer_org_id uuid;
  v_active_user_id  uuid;
  v_inv             public.retailer_invitations%rowtype;
  v_first_name      text;
  v_last_name       text;
begin
  -- --------------------------------------------------------------------------
  -- Authorization — identical chain to reserve()/revoke(), read-only permission
  -- --------------------------------------------------------------------------
  if auth.uid() is null then
    raise exception 'Not authorized to view this Retailer''s owner status'
      using errcode = 'insufficient_privilege';
  end if;

  select ctx.organization_id
    into v_vendor_org_id
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor_org_id is null then
    raise exception 'Not authorized to view this Retailer''s owner status'
      using errcode = 'insufficient_privilege';
  end if;

  -- The Vendor RETAILER-READ authority, the same permission the retailer-detail
  -- route's RLS policies require. Reading owner status is a read, so it is gated by
  -- the read permission rather than RETAILER_OWNERS_INVITE.
  if not public.has_organization_permission(v_vendor_org_id, 'RETAILERS_READ') then
    raise exception 'Not authorized to view this Retailer''s owner status'
      using errcode = 'insufficient_privilege';
  end if;

  -- Ownership — the relationship must belong to the DERIVED Vendor. A foreign,
  -- unknown, or malformed id selects nothing and falls through to the same generic
  -- raise, so this cannot be used to confirm another Vendor's relationship exists.
  select vr.retailer_organization_id
    into v_retailer_org_id
  from public.vendor_retailers vr
  join public.organizations o
    on o.id = vr.retailer_organization_id
  where vr.id = p_relationship_id
    and vr.vendor_organization_id = v_vendor_org_id
    and o.organization_type = 'RETAILER';

  if v_retailer_org_id is null then
    raise exception 'Not authorized to view this Retailer''s owner status'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 1. ACTIVE — a qualifying ACTIVE RETAILER_OWNER membership wins outright
  -- --------------------------------------------------------------------------
  -- Deterministic pick if more than one somehow qualifies (the reservation guards
  -- make that unreachable, but the RPC must be total regardless).
  select m.user_id
    into v_active_user_id
  from public.organization_members m
  join public.member_roles mr on mr.organization_member_id = m.id
  join public.roles r on r.id = mr.role_id
  where m.organization_id = v_retailer_org_id
    and m.status = 'ACTIVE'
    and r.code = 'RETAILER_OWNER'
    and r.status = 'ACTIVE'
  order by m.created_at asc, m.id asc
  limit 1;

  if v_active_user_id is not null then
    -- Prefer the accepted invitation this owner actually accepted, as the safest
    -- source of display data. Tied to auth_user_id so it is unambiguously theirs.
    select *
      into v_inv
    from public.retailer_invitations ri
    where ri.retailer_organization_id = v_retailer_org_id
      and ri.status = 'ACCEPTED'
      and ri.auth_user_id = v_active_user_id
    order by ri.accepted_at desc nulls last, ri.created_at desc, ri.id desc
    limit 1;

    if v_inv.id is not null then
      return query
        select 'ACTIVE'::text,
               v_inv.first_name, v_inv.last_name, v_inv.email,
               v_inv.sent_at, v_inv.expires_at, v_inv.accepted_at;
      return;
    end if;

    -- No usable accepted invitation on record (case F): the owner is still ACTIVE.
    -- Fall back to the profile for the name; email/timestamps are null because no
    -- invitation history exists to source them from. A real active owner must never
    -- read as absent for want of an invitation row.
    select p.first_name, p.last_name
      into v_first_name, v_last_name
    from public.profiles p
    where p.id = v_active_user_id;

    return query
      select 'ACTIVE'::text,
             v_first_name, v_last_name, null::text,
             null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 2. PENDING / DELIVERY_FAILED — the newest current, unexpired PENDING row
  -- --------------------------------------------------------------------------
  select *
    into v_inv
  from public.retailer_invitations ri
  where ri.retailer_organization_id = v_retailer_org_id
    and ri.status = 'PENDING'
    and ri.expires_at > now()
  order by ri.created_at desc, ri.id desc
  limit 1;

  if v_inv.id is not null then
    -- PENDING only when finalize() genuinely completed: BOTH the linked membership
    -- and sent_at are present. Anything short of that — a reserved-but-undispatched
    -- row, an Auth failure, a finalization failure, or any inconsistent half-state —
    -- is DELIVERY_FAILED. Failing closed here is deliberate: a not-yet-delivered
    -- invitation must never be shown as successfully sent.
    if v_inv.organization_member_id is not null and v_inv.sent_at is not null then
      return query
        select 'PENDING'::text,
               v_inv.first_name, v_inv.last_name, v_inv.email,
               v_inv.sent_at, v_inv.expires_at, null::timestamptz;
    else
      return query
        select 'DELIVERY_FAILED'::text,
               v_inv.first_name, v_inv.last_name, v_inv.email,
               v_inv.sent_at, v_inv.expires_at, null::timestamptz;
    end if;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 3. EXPIRED — the newest applicable expired invitation, deterministically
  -- --------------------------------------------------------------------------
  -- Includes both a stored-EXPIRED row and a PENDING row already past its deadline
  -- that no sweep has reached. REVOKED and ACCEPTED rows are excluded: a withdrawn
  -- invitation is not a UI owner state, and an accepted-but-inactive owner is not
  -- "expired". The tie-breaker id orders the pick but is never returned.
  select *
    into v_inv
  from public.retailer_invitations ri
  where ri.retailer_organization_id = v_retailer_org_id
    and (
      ri.status = 'EXPIRED'
      or (ri.status = 'PENDING' and ri.expires_at <= now())
    )
  order by ri.expires_at desc, ri.created_at desc, ri.id desc
  limit 1;

  if v_inv.id is not null then
    return query
      select 'EXPIRED'::text,
             v_inv.first_name, v_inv.last_name, v_inv.email,
             v_inv.sent_at, v_inv.expires_at, null::timestamptz;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 4. NONE — no active owner and no invitation state worth displaying
  -- --------------------------------------------------------------------------
  return query
    select 'NONE'::text,
           null::text, null::text, null::text,
           null::timestamptz, null::timestamptz, null::timestamptz;
  return;
end;
$$;

-- Privileges. Same posture as every Vendor-facing RPC in this domain: no implicit
-- PUBLIC EXECUTE, nothing for anon, EXECUTE for authenticated only. A caller who
-- reaches the body still passes the in-function context, permission, and ownership
-- checks before learning anything. No table grant and no policy is added.
revoke all     on function public.get_vendor_retailer_owner_status(uuid) from public;
revoke execute on function public.get_vendor_retailer_owner_status(uuid) from anon;
grant  execute on function public.get_vendor_retailer_owner_status(uuid) to authenticated;
