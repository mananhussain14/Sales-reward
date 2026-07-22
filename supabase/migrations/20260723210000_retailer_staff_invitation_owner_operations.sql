-- Migration: retailer_staff_invitation_owner_operations
-- Purpose: The authenticated Retailer Owner operations over the staff-invitation
--          storage foundation (migration 20260723090000). Adds exactly FOUR
--          functions and nothing else:
--            1. expire_stale_retailer_staff_invitations(uuid)  [internal, no grant]
--            2. reserve_retailer_staff_invitation(text,text,text,text,uuid[])
--            3. revoke_retailer_staff_invitation(uuid)
--            4. list_retailer_staff_invitations()
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No service-role token/delivery RPC (prepare/record_sent/record_failure — those
--   are the next migration), no recipient-resolution or acceptance RPC, no profile /
--   membership / member_role / retailer_shop_members write, no new table / column /
--   constraint / index / trigger / policy, no application code, no feature flag, no
--   email. Storage stays exactly as migration 20260723090000 left it; access to the
--   two staff tables is only through the functions below.
--
-- AUTHORIZATION ROOT
--   Every owner operation authorizes from the AUTHENTICATED RETAILER MEMBER via
--   public.resolve_retailer_member_organization('RETAILER_STAFF_MANAGE'), which
--   under the current mappings admits only RETAILER_OWNER. It derives auth.uid()
--   internally and returns the caller's single Retailer or NULL (fail closed on
--   zero or multiple). No browser-supplied Retailer id, role UUID, invited-by id,
--   status, token, Auth user id, membership id, or delivery field is ever accepted.
--
-- SECURITY POSTURE (all four)
--   language plpgsql, SECURITY DEFINER, set search_path = '', fully qualified, no
--   dynamic SQL. reserve/revoke/expire are VOLATILE; list is STABLE. Owned by the
--   migration role (same as every existing hardened helper), so the SECURITY
--   DEFINER chain lets reserve/revoke call the internal expire function even though
--   it is granted to nobody. Generic SQLSTATEs (42501 authz/not-found, 23514 input,
--   55000 inactive Retailer) reveal no cross-tenant detail.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR
--   REPLACE). A conflicting existing object FAILS the migration. No fixed UUIDs.
--   All identifiers are <= 63 bytes.
--
-- Dependencies: 20260716124419 (profiles, organization_members, organizations,
--   set_updated_at), 20260716125559 (roles), 20260716130351 (audit_logs),
--   20260717094520 (retailer_shops), 20260722210000 (RETAILER_MANAGER, SALES_STAFF,
--   RETAILER_STAFF_MANAGE), 20260723090000 (retailer_staff_invitations,
--   retailer_invitation_shop_assignments, resolve_retailer_member_organization).

-- ============================================================================
-- FUNCTION 1 — expire_stale_retailer_staff_invitations(uuid)  [internal]
-- ============================================================================
-- Moves this Retailer's lapsed PENDING invitations to EXPIRED and clears their
-- token + failure fields, preserving sent_at (historical delivery evidence),
-- invitation identity, and shop-assignment history. updated_at advances through the
-- storage table's set_updated_at trigger. No audit row: expiry is the absence of an
-- action, so there is no actor to record (matching expire_stale_retailer_invitations).
--
-- Correctness does not depend on this running: reserve and revoke call it, and the
-- read/derived-state logic evaluates expires_at directly. It exists to keep the
-- stored status honest and to free the pending-unique index for re-invitation.
create function public.expire_stale_retailer_staff_invitations(
  p_retailer_organization_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.retailer_staff_invitations
  set
    status              = 'EXPIRED',
    token_hash          = null,
    failure_code        = null,
    failure_recorded_at = null
  where p_retailer_organization_id is not null
    and retailer_organization_id = p_retailer_organization_id
    and status = 'PENDING'
    and expires_at <= now();
end;
$$;

-- Privileges: internal only. Reachable solely from the owner functions below, which
-- run as this function's owner. Not granted to any browser role, nor to service_role.
revoke all     on function public.expire_stale_retailer_staff_invitations(uuid) from public;
revoke execute on function public.expire_stale_retailer_staff_invitations(uuid) from anon;
revoke execute on function public.expire_stale_retailer_staff_invitations(uuid) from authenticated;

-- ============================================================================
-- FUNCTION 2 — reserve_retailer_staff_invitation(text,text,text,text,uuid[])
-- ============================================================================
-- STEP ONE of the staff invitation lifecycle. Authorizes the Retailer Owner,
-- validates and canonicalizes input, enforces the role/shop and recipient-state
-- rules, and either creates a fresh PENDING invitation (with its immutable
-- SALES_STAFF shop rows and one audit event) or, when a live PENDING invitation to
-- the same person already exists, returns it idempotently as a resend.
--
-- It does NOT touch token_hash, sent_at, failure_code, failure_recorded_at, or
-- expires_at — those belong to the service-role prepare/record functions. A resend
-- may correct only first_name/last_name; changing the role or shop set requires
-- revoke + a new invitation.
create function public.reserve_retailer_staff_invitation(
  p_email      text,
  p_first_name text,
  p_last_name  text,
  p_role_code  text,
  p_shop_ids   uuid[]
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
  v_actor          uuid;
  v_retailer       uuid;
  v_org_status     text;
  v_org_type       text;
  v_retailer_name  text;
  v_email          text;
  v_first          text;
  v_last           text;
  v_role_code      text;
  v_role_id        uuid;
  v_shop_ids       uuid[];
  v_shop_count     integer;
  v_locked_count   integer;
  v_shop_id        uuid;
  v_recipient_auth uuid;
  v_profile_status text;
  v_existing_id    uuid;
  v_existing_role  uuid;
  v_existing_shops uuid[];
  v_new_id         uuid;
  v_constraint     text;
begin
  -- --------------------------------------------------------------------------
  -- 1. Authorization (identity + Retailer, never browser-supplied)
  -- --------------------------------------------------------------------------
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not authorized to invite staff'
      using errcode = 'insufficient_privilege';
  end if;

  v_retailer := public.resolve_retailer_member_organization('RETAILER_STAFF_MANAGE');
  if v_retailer is null then
    raise exception 'Not authorized to invite staff'
      using errcode = 'insufficient_privilege';
  end if;

  -- The resolver already requires an ACTIVE profile; re-affirm so invited_by is a
  -- valid, ACTIVE actor id (auth.uid() IS the profile's primary key).
  if not exists (
    select 1 from public.profiles p where p.id = v_actor and p.status = 'ACTIVE'
  ) then
    raise exception 'Not authorized to invite staff'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock the resolved Retailer against a concurrent lifecycle change and re-verify.
  select o.status, o.organization_type, o.name
    into v_org_status, v_org_type, v_retailer_name
  from public.organizations o
  where o.id = v_retailer
  for share;

  if v_org_type is distinct from 'RETAILER' or v_org_status is distinct from 'ACTIVE' then
    raise exception 'This Retailer is not active'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Input normalization and validation
  -- --------------------------------------------------------------------------
  v_email     := lower(btrim(coalesce(p_email, '')));
  v_first     := btrim(coalesce(p_first_name, ''));
  v_last      := btrim(coalesce(p_last_name, ''));
  v_role_code := upper(btrim(coalesce(p_role_code, '')));

  if v_email = '' then
    raise exception 'An email address is required' using errcode = 'check_violation';
  end if;
  if length(v_email) > 254 then
    raise exception 'Email address is too long' using errcode = 'check_violation';
  end if;
  -- Same canonical shape rule the storage constraint enforces (COLLATE "C" so the
  -- bracket classes mean exactly ASCII on every host).
  if v_email collate "C" !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email address' using errcode = 'check_violation';
  end if;
  if v_first = '' then
    raise exception 'A first name is required' using errcode = 'check_violation';
  end if;
  if v_last = '' then
    raise exception 'A last name is required' using errcode = 'check_violation';
  end if;
  if v_role_code = '' then
    raise exception 'A role is required' using errcode = 'check_violation';
  end if;

  -- Shop normalization: NULL and empty array are the same zero-shop input; a NULL
  -- element is rejected; the result is a distinct, UUID-ordered array (empty, not
  -- NULL, when there are no shops).
  if p_shop_ids is not null and exists (
    select 1 from unnest(p_shop_ids) s where s is null
  ) then
    raise exception 'Shop selection is invalid' using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(distinct s order by s), '{}'::uuid[])
    into v_shop_ids
  from unnest(coalesce(p_shop_ids, '{}'::uuid[])) s;
  v_shop_count := coalesce(array_length(v_shop_ids, 1), 0);

  -- --------------------------------------------------------------------------
  -- 3. Role validation (by code; never a UUID) and shop cardinality
  -- --------------------------------------------------------------------------
  select r.id
    into v_role_id
  from public.roles r
  where r.code = v_role_code
    and r.status = 'ACTIVE';

  if v_role_id is null or v_role_code not in ('RETAILER_MANAGER', 'SALES_STAFF') then
    raise exception 'Staff role must be an active Retailer Manager or Sales Staff role'
      using errcode = 'check_violation';
  end if;

  if v_role_code = 'RETAILER_MANAGER' and v_shop_count <> 0 then
    raise exception 'Retailer Manager invitations cannot include shop assignments'
      using errcode = 'check_violation';
  end if;
  if v_role_code = 'SALES_STAFF' and v_shop_count < 1 then
    raise exception 'Sales Staff invitations require at least one shop'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. Lock and validate the selected shops (SALES_STAFF only)
  -- --------------------------------------------------------------------------
  -- Locked in deterministic UUID order to avoid lock-order deadlocks, and only the
  -- selected shops are locked. Each must exist, be ACTIVE, and belong to the
  -- resolved Retailer; if fewer than the requested count qualify, one is invalid.
  -- Locking happens in a loop (not inside an aggregate) to avoid FOR SHARE/aggregate
  -- syntax conflicts. The storage-table INSERT trigger is defence in depth over this.
  if v_shop_count > 0 then
    v_locked_count := 0;
    for v_shop_id in
      select s.id
      from public.retailer_shops s
      where s.id = any(v_shop_ids)
        and s.retailer_organization_id = v_retailer
        and s.status = 'ACTIVE'
      order by s.id
      for share
    loop
      v_locked_count := v_locked_count + 1;
    end loop;

    if v_locked_count <> v_shop_count then
      raise exception 'One or more selected shops are invalid for this Retailer'
        using errcode = 'check_violation';
    end if;
  end if;

  -- --------------------------------------------------------------------------
  -- 5. Recipient account and membership rules
  -- --------------------------------------------------------------------------
  -- The recipient's Auth user is resolved by canonical email under definer rights.
  -- The result and errors NEVER reveal whether that account exists. A retired
  -- profile (SUSPENDED/DEACTIVATED) is refused generically; any same-Retailer
  -- membership in ANY status is refused (own-tenant fact the owner may know); no
  -- profile or membership is created or reactivated here.
  select u.id into v_recipient_auth
  from auth.users u
  where lower(btrim(u.email)) = v_email;

  if v_recipient_auth is not null then
    select p.status into v_profile_status
    from public.profiles p
    where p.id = v_recipient_auth;

    if v_profile_status in ('SUSPENDED', 'DEACTIVATED') then
      raise exception 'This email address cannot be invited'
        using errcode = 'check_violation';
    end if;

    if exists (
      select 1 from public.organization_members m
      where m.user_id = v_recipient_auth
        and m.organization_id = v_retailer
    ) then
      raise exception 'This person is already associated with this Retailer'
        using errcode = 'check_violation';
    end if;
  end if;

  -- --------------------------------------------------------------------------
  -- 6. Expire stale, then find an existing live PENDING invitation
  -- --------------------------------------------------------------------------
  -- Expiry runs first so a lapsed PENDING row becomes EXPIRED and frees the
  -- pending-unique index; a stale invitation therefore leads to a FRESH reservation
  -- rather than a resend. The id passed is the verified resolved Retailer.
  perform public.expire_stale_retailer_staff_invitations(v_retailer);

  select ri.id, ri.role_id
    into v_existing_id, v_existing_role
  from public.retailer_staff_invitations ri
  where ri.retailer_organization_id = v_retailer
    and ri.email = v_email
    and ri.status = 'PENDING'
  for update;

  -- --------------------------------------------------------------------------
  -- 7. Fresh reservation (with concurrency fallback to resend)
  -- --------------------------------------------------------------------------
  if v_existing_id is null then
    begin
      -- Every id is DERIVED: Retailer from the resolver, role from the catalogue by
      -- code, invited_by from auth.uid(). status/token/timestamps take defaults/null.
      insert into public.retailer_staff_invitations (
        retailer_organization_id,
        email,
        first_name,
        last_name,
        role_id,
        invited_by_profile_id,
        status
      )
      values (
        v_retailer, v_email, v_first, v_last, v_role_id, v_actor, 'PENDING'
      )
      returning id into v_new_id;

      -- Immutable intended-shop rows (SALES_STAFF only; none for RETAILER_MANAGER).
      if v_shop_count > 0 then
        insert into public.retailer_invitation_shop_assignments (
          retailer_staff_invitation_id,
          retailer_shop_id
        )
        select v_new_id, s from unnest(v_shop_ids) s;
      end if;

      -- One reserved audit event, in the same transaction as the rows it describes.
      -- Metadata is display-only: no email, token, hash, Auth id, membership id, or
      -- shop UUID array.
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
        'STAFF_INVITATION_RESERVED',
        'RETAILER_STAFF_INVITATION',
        v_new_id::text,
        jsonb_build_object(
          'retailer_name',     v_retailer_name,
          'role_code',         v_role_code,
          'invitation_status', 'PENDING',
          'shop_count',        v_shop_count
        )
      );

      return query select v_new_id, v_email, false;
      return;

    exception when unique_violation then
      -- Only the pending-unique index means "a concurrent reservation won"; every
      -- other unique violation (e.g. a duplicate shop pair) is a real error and is
      -- re-raised unchanged.
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'retailer_staff_invitations_pending_unique_idx' then
        raise;
      end if;

      -- Re-read and lock the winning PENDING invitation; fall through to the resend
      -- path below. (Not finding it here would be a genuine anomaly, so re-raise.)
      select ri.id, ri.role_id
        into v_existing_id, v_existing_role
      from public.retailer_staff_invitations ri
      where ri.retailer_organization_id = v_retailer
        and ri.email = v_email
        and ri.status = 'PENDING'
      for update;

      if v_existing_id is null then
        raise;
      end if;
    end;
  end if;

  -- --------------------------------------------------------------------------
  -- 8. Resend path (existing live PENDING invitation)
  -- --------------------------------------------------------------------------
  -- Role and shop set are immutable on an invitation: a mismatch requires revoke +
  -- replacement. Names may be corrected. Nothing else is touched, and no second
  -- RESERVED audit is written.
  if v_existing_role is distinct from v_role_id then
    raise exception 'Revoke and re-issue this invitation to change its role or shops'
      using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(sa.retailer_shop_id order by sa.retailer_shop_id), '{}'::uuid[])
    into v_existing_shops
  from public.retailer_invitation_shop_assignments sa
  where sa.retailer_staff_invitation_id = v_existing_id;

  if v_existing_shops is distinct from v_shop_ids then
    raise exception 'Revoke and re-issue this invitation to change its role or shops'
      using errcode = 'check_violation';
  end if;

  update public.retailer_staff_invitations
  set first_name = v_first,
      last_name  = v_last
  where id = v_existing_id
    and (first_name is distinct from v_first or last_name is distinct from v_last);

  return query select v_existing_id, v_email, true;
  return;
end;
$$;

revoke all     on function public.reserve_retailer_staff_invitation(text, text, text, text, uuid[]) from public;
revoke execute on function public.reserve_retailer_staff_invitation(text, text, text, text, uuid[]) from anon;
grant  execute on function public.reserve_retailer_staff_invitation(text, text, text, text, uuid[]) to authenticated;

-- ============================================================================
-- FUNCTION 3 — revoke_retailer_staff_invitation(uuid)
-- ============================================================================
-- Withdraws a live PENDING staff invitation for the caller's own Retailer. Marks it
-- REVOKED, clears the token and failure fields, preserves sent_at / names / role /
-- intended shop rows (history), and audits. No membership is deactivated: the staff
-- token flow provisions no membership before acceptance. Not idempotent-success —
-- a second revoke (row no longer PENDING) receives the same generic error, and a
-- null / unknown / foreign / terminal id is indistinguishable from "not yours".
create function public.revoke_retailer_staff_invitation(
  p_invitation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor         uuid;
  v_retailer      uuid;
  v_inv_id        uuid;
  v_role_id       uuid;
  v_role_code     text;
  v_retailer_name text;
  v_shop_count    integer;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not authorized to revoke this invitation'
      using errcode = 'insufficient_privilege';
  end if;

  v_retailer := public.resolve_retailer_member_organization('RETAILER_STAFF_MANAGE');
  if v_retailer is null then
    raise exception 'Not authorized to revoke this invitation'
      using errcode = 'insufficient_privilege';
  end if;

  perform public.expire_stale_retailer_staff_invitations(v_retailer);

  -- The two-column filter is the whole security boundary: id says WHICH row and the
  -- Retailer says it must be one of the caller's own. PENDING gates state.
  select ri.id, ri.role_id
    into v_inv_id, v_role_id
  from public.retailer_staff_invitations ri
  where ri.id = p_invitation_id
    and ri.retailer_organization_id = v_retailer
    and ri.status = 'PENDING'
  for update;

  if v_inv_id is null then
    raise exception 'Not authorized to revoke this invitation'
      using errcode = 'insufficient_privilege';
  end if;

  update public.retailer_staff_invitations
  set status              = 'REVOKED',
      revoked_at          = now(),
      token_hash          = null,
      failure_code        = null,
      failure_recorded_at = null
  where id = v_inv_id
    and status = 'PENDING';

  select o.name into v_retailer_name from public.organizations o where o.id = v_retailer;
  select r.code into v_role_code   from public.roles r         where r.id = v_role_id;
  select count(*) into v_shop_count
  from public.retailer_invitation_shop_assignments sa
  where sa.retailer_staff_invitation_id = v_inv_id;

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
    'STAFF_INVITATION_REVOKED',
    'RETAILER_STAFF_INVITATION',
    v_inv_id::text,
    jsonb_build_object(
      'retailer_name',     v_retailer_name,
      'role_code',         v_role_code,
      'invitation_status', 'REVOKED',
      'shop_count',        v_shop_count
    )
  );
end;
$$;

revoke all     on function public.revoke_retailer_staff_invitation(uuid) from public;
revoke execute on function public.revoke_retailer_staff_invitation(uuid) from anon;
grant  execute on function public.revoke_retailer_staff_invitation(uuid) to authenticated;

-- ============================================================================
-- FUNCTION 4 — list_retailer_staff_invitations()
-- ============================================================================
-- The Retailer Owner's invitation roster. Gated on RETAILER_STAFF_MANAGE, so an
-- unauthorized caller, a Retailer Manager, a caller with no membership, or a
-- multi-Retailer owner all raise the SAME generic 42501 — an authorization failure
-- is never silently converted into an empty list. An authorized owner with no
-- invitations receives zero rows.
--
-- Returns only display-safe columns; NEVER token_hash, role_id, auth_user_id,
-- organization_member_id, invited_by_profile_id, or audit metadata. The derived
-- state is computed inline with a total, mutually-exclusive precedence, so every
-- structurally valid row maps to exactly one non-null state (a prepared-but-unsent
-- invitation is RESERVED).
create function public.list_retailer_staff_invitations()
returns table (
  invitation_id  uuid,
  first_name     text,
  last_name      text,
  email          text,
  role_code      text,
  derived_state  text,
  created_at     timestamptz,
  sent_at        timestamptz,
  accepted_at    timestamptz,
  revoked_at     timestamptz,
  expires_at     timestamptz,
  failure_code   text,
  shop_ids       uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('RETAILER_STAFF_MANAGE');
  if v_retailer is null then
    raise exception 'Not authorized to view staff invitations'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select
    ri.id,
    ri.first_name,
    ri.last_name,
    ri.email,
    r.code,
    case
      when ri.status = 'REVOKED'  then 'REVOKED'
      when ri.status = 'ACCEPTED' then 'ACCEPTED'
      when ri.status = 'EXPIRED'
        or (ri.status = 'PENDING' and ri.expires_at <= now()) then 'EXPIRED'
      when ri.status = 'PENDING' and ri.expires_at > now()
        and ri.failure_code = 'EMAIL_DISPATCH_FAILED'
        and ri.failure_recorded_at is not null then 'DELIVERY_FAILED'
      when ri.status = 'PENDING' and ri.expires_at > now()
        and ri.sent_at is not null and ri.failure_code is null then 'PENDING'
      when ri.status = 'PENDING' and ri.expires_at > now()
        and ri.sent_at is null and ri.failure_code is null then 'RESERVED'
    end,
    ri.created_at,
    ri.sent_at,
    ri.accepted_at,
    ri.revoked_at,
    ri.expires_at,
    ri.failure_code,
    coalesce(
      (
        select array_agg(sa.retailer_shop_id order by sa.retailer_shop_id)
        from public.retailer_invitation_shop_assignments sa
        where sa.retailer_staff_invitation_id = ri.id
      ),
      '{}'::uuid[]
    )
  from public.retailer_staff_invitations ri
  join public.roles r on r.id = ri.role_id
  where ri.retailer_organization_id = v_retailer
  order by ri.created_at desc, ri.id desc;
end;
$$;

revoke all     on function public.list_retailer_staff_invitations() from public;
revoke execute on function public.list_retailer_staff_invitations() from anon;
grant  execute on function public.list_retailer_staff_invitations() to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- No table, column, constraint, index, trigger, policy, role, permission, mapping,
-- or existing function is created, altered, or dropped by this migration. The staff
-- invitation tables keep exactly the default-deny posture migration 20260723090000
-- left them in; no table privilege is granted to any browser role here. The
-- service-role token/delivery operations (prepare/record_sent/record_failure) and
-- the recipient resolve/accept operations are deliberately NOT in this migration.
