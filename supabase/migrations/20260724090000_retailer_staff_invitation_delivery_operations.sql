-- Migration: retailer_staff_invitation_delivery_operations
-- Purpose: The service-role delivery operations over the staff-invitation storage
--          (migration 20260723090000) and owner operations (20260723210000). Adds
--          exactly THREE functions and nothing else:
--            1. prepare_retailer_staff_invitation(uuid, text)
--            2. record_retailer_staff_invitation_sent(uuid, text)
--            3. record_retailer_staff_invitation_failure(uuid, text)
--
-- THE TOKEN MODEL
--   The application generates a raw token, hashes it (SHA-256), and calls prepare
--   with only the HASH. The raw token is never stored, logged, or audited; it lives
--   only in the recipient's emailed URL. prepare rotates token_hash (invalidating any
--   prior token), refreshes the 24-hour window, and clears delivery state. The email
--   delivery callback then calls record_sent or record_failure with the EXPECTED
--   hash; a callback for a superseded token (a newer prepare rotated it) is rejected,
--   so a stale delivery result can never overwrite newer state. Every retry after a
--   failure re-runs prepare with a freshly generated token hash.
--
-- WHY service_role ONLY
--   These functions run on behalf of trusted server-side code with no auth.uid():
--   the delivery callback has no browser session. They are keyed by an invitation id
--   the server already reserved and prepared, and they carry the entire decision
--   themselves. Reachable by a browser role, they would let any caller who learned an
--   invitation id and token hash manipulate delivery state. Every browser role is
--   stripped explicitly and only service_role is granted.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No recipient-resolution or acceptance RPC, no profile / membership / member_role /
--   retailer_shop_members write, no change to owner reserve/revoke/list/expire, no new
--   table / column / constraint / index / trigger / policy, no application code, no
--   Server Action, no feature flag, and no actual email send. Storage stays exactly as
--   migration 20260723090000 left it.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE).
--   A conflicting existing object FAILS the migration. No fixed UUIDs. All identifiers
--   are <= 63 bytes.
--
-- Dependencies: 20260716130351 (audit_logs), 20260716124419 (profiles, organizations),
--   20260716125559 (roles), 20260723090000 (retailer_staff_invitations,
--   retailer_invitation_shop_assignments, token/failure constraints and the
--   token_hash unique index), 20260723210000 (owner operations, unchanged here).

-- ============================================================================
-- FUNCTION 1 — prepare_retailer_staff_invitation(uuid, text)
-- ============================================================================
-- Converts a live PENDING invitation to a token-bearing, freshly-dated state and
-- returns the safe fields the server needs to build the invitation email. Rotates the
-- hash so any prior token is invalidated. Writes no audit event (nothing was
-- delivered yet). Returns NO token, NO token_hash, and no Auth/membership/shop detail.
create function public.prepare_retailer_staff_invitation(
  p_invitation_id uuid,
  p_token_hash    text
)
returns table (
  invitation_id    uuid,
  normalized_email text,
  first_name       text,
  last_name        text,
  retailer_name    text,
  role_code        text,
  expires_at       timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv           public.retailer_staff_invitations%rowtype;
  v_retailer_name text;
  v_role_code     text;
begin
  -- Validate the hash shape server-side too (the column constraint is the final
  -- authority). A malformed hash never reaches the table.
  if p_invitation_id is null
     or p_token_hash is null
     or p_token_hash collate "C" !~ '^[0-9a-f]{64}$' then
    raise exception 'Invitation could not be prepared' using errcode = 'check_violation';
  end if;

  -- Lock the invitation; concurrent prepares serialize here.
  select * into v_inv
  from public.retailer_staff_invitations
  where id = p_invitation_id
  for update;

  -- One generic message for a null/unknown id, a terminal (ACCEPTED/EXPIRED/REVOKED)
  -- invitation, and a lapsed (still-PENDING but expired) invitation alike. A lapsed
  -- invitation must be revoked and re-reserved by the owner, not silently revived by
  -- the delivery layer. Nothing about internal state is disclosed.
  if v_inv.id is null
     or v_inv.status <> 'PENDING'
     or v_inv.expires_at <= now() then
    raise exception 'Invitation could not be prepared' using errcode = 'check_violation';
  end if;

  -- Rotate the token hash and refresh the window; clear any prior delivery state.
  -- Recipient, role, and shop rows are untouched. The token_hash_unique index is the
  -- global collision authority: a hash already live on another invitation raises
  -- unique_violation, which is caught and reported generically so no other
  -- invitation's existence leaks. Any OTHER unique violation is re-raised unchanged.
  begin
    update public.retailer_staff_invitations
    set
      token_hash          = p_token_hash,
      expires_at          = now() + interval '24 hours',
      sent_at             = null,
      failure_code        = null,
      failure_recorded_at = null
    where id = v_inv.id;
  exception when unique_violation then
    declare v_constraint text;
    begin
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'retailer_staff_invitations_token_hash_unique_idx' then
        raise exception 'Invitation could not be prepared' using errcode = 'check_violation';
      end if;
      raise;
    end;
  end;

  select o.name into v_retailer_name
  from public.organizations o
  where o.id = v_inv.retailer_organization_id;

  select r.code into v_role_code
  from public.roles r
  where r.id = v_inv.role_id;

  return query select
    v_inv.id,
    v_inv.email,
    v_inv.first_name,
    v_inv.last_name,
    v_retailer_name,
    v_role_code,
    (now() + interval '24 hours')::timestamptz;
end;
$$;

revoke all     on function public.prepare_retailer_staff_invitation(uuid, text) from public;
revoke execute on function public.prepare_retailer_staff_invitation(uuid, text) from anon;
revoke execute on function public.prepare_retailer_staff_invitation(uuid, text) from authenticated;
grant  execute on function public.prepare_retailer_staff_invitation(uuid, text) to service_role;

-- ============================================================================
-- FUNCTION 2 — record_retailer_staff_invitation_sent(uuid, text)
-- ============================================================================
-- The honest "email handed off successfully" callback. Applies only when the named
-- token is still the current one, so a stale callback after a newer prepare is
-- refused. A duplicate callback for the current, already-sent token is an idempotent
-- no-op (no mutation, no second audit). Promotes the invitation to delivered.
create function public.record_retailer_staff_invitation_sent(
  p_invitation_id       uuid,
  p_expected_token_hash text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv           public.retailer_staff_invitations%rowtype;
  v_retailer_name text;
  v_role_code     text;
  v_shop_count    integer;
  v_is_resend     boolean;
begin
  if p_invitation_id is null
     or p_expected_token_hash is null
     or p_expected_token_hash collate "C" !~ '^[0-9a-f]{64}$' then
    raise exception 'Invitation send could not be recorded' using errcode = 'check_violation';
  end if;

  select * into v_inv
  from public.retailer_staff_invitations
  where id = p_invitation_id
  for update;

  -- Generic refusal for unknown id, terminal/expired state, missing token, or a
  -- token that does not match the caller's expected (current) hash — a stale callback
  -- for a superseded token lands here.
  if v_inv.id is null
     or v_inv.status <> 'PENDING'
     or v_inv.expires_at <= now()
     or v_inv.token_hash is null
     or v_inv.token_hash <> p_expected_token_hash then
    raise exception 'Invitation send could not be recorded' using errcode = 'check_violation';
  end if;

  -- Duplicate callback for the current token: already recorded as sent. Idempotent
  -- no-op — no mutation, no second audit row.
  if v_inv.sent_at is not null then
    return;
  end if;

  -- A failure was recorded for the CURRENT token; a success cannot arrive for the same
  -- attempt. The retry path is a fresh prepare (new hash), not a sent callback on the
  -- failed one. Refused generically.
  if v_inv.failure_code is not null then
    raise exception 'Invitation send could not be recorded' using errcode = 'check_violation';
  end if;

  update public.retailer_staff_invitations
  set
    sent_at             = now(),
    failure_code        = null,
    failure_recorded_at = null
  where id = v_inv.id;

  -- SENT vs RESENT: RESENT when a prior send audit exists for this invitation. The
  -- FOR UPDATE lock above serializes concurrent callbacks for this invitation, so the
  -- decision and the insert are atomic. audit_logs itself is not locked.
  v_is_resend := exists (
    select 1 from public.audit_logs a
    where a.entity_type = 'RETAILER_STAFF_INVITATION'
      and a.entity_id = v_inv.id::text
      and a.action in ('STAFF_INVITATION_SENT', 'STAFF_INVITATION_RESENT')
  );

  select o.name into v_retailer_name from public.organizations o where o.id = v_inv.retailer_organization_id;
  select r.code into v_role_code     from public.roles r         where r.id = v_inv.role_id;
  select count(*) into v_shop_count
  from public.retailer_invitation_shop_assignments sa
  where sa.retailer_staff_invitation_id = v_inv.id;

  -- actor_profile_id follows the service-role convention (the inviting owner from the
  -- invitation row). organization_id is the invitation's Retailer. Metadata carries
  -- display-only fields — no email, token, token hash, or provider information.
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
    v_inv.invited_by_profile_id,
    case when v_is_resend then 'STAFF_INVITATION_RESENT' else 'STAFF_INVITATION_SENT' end,
    'RETAILER_STAFF_INVITATION',
    v_inv.id::text,
    jsonb_build_object(
      'retailer_name',     v_retailer_name,
      'role_code',         v_role_code,
      'invitation_status', 'PENDING',
      'shop_count',        v_shop_count
    )
  );
end;
$$;

revoke all     on function public.record_retailer_staff_invitation_sent(uuid, text) from public;
revoke execute on function public.record_retailer_staff_invitation_sent(uuid, text) from anon;
revoke execute on function public.record_retailer_staff_invitation_sent(uuid, text) from authenticated;
grant  execute on function public.record_retailer_staff_invitation_sent(uuid, text) to service_role;

-- ============================================================================
-- FUNCTION 3 — record_retailer_staff_invitation_failure(uuid, text)
-- ============================================================================
-- The "email dispatch failed" callback. Applies only for the current token; retains
-- the token so the delivery can be retried without a fresh reservation, and clears
-- sent_at. The failure code is a fixed literal — no caller-supplied code or provider
-- error string is accepted or stored. A duplicate failure for the current token is an
-- idempotent no-op.
create function public.record_retailer_staff_invitation_failure(
  p_invitation_id       uuid,
  p_expected_token_hash text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv           public.retailer_staff_invitations%rowtype;
  v_retailer_name text;
  v_role_code     text;
  v_shop_count    integer;
begin
  if p_invitation_id is null
     or p_expected_token_hash is null
     or p_expected_token_hash collate "C" !~ '^[0-9a-f]{64}$' then
    raise exception 'Invitation failure could not be recorded' using errcode = 'check_violation';
  end if;

  select * into v_inv
  from public.retailer_staff_invitations
  where id = p_invitation_id
  for update;

  if v_inv.id is null
     or v_inv.status <> 'PENDING'
     or v_inv.expires_at <= now()
     or v_inv.token_hash is null
     or v_inv.token_hash <> p_expected_token_hash then
    raise exception 'Invitation failure could not be recorded' using errcode = 'check_violation';
  end if;

  -- Duplicate failure callback for the current token: idempotent no-op.
  if v_inv.failure_code is not null then
    return;
  end if;

  -- A success was recorded for the CURRENT token; a failure cannot arrive for the same
  -- attempt. Refused generically. The retry path is a fresh prepare.
  if v_inv.sent_at is not null then
    raise exception 'Invitation failure could not be recorded' using errcode = 'check_violation';
  end if;

  update public.retailer_staff_invitations
  set
    failure_code        = 'EMAIL_DISPATCH_FAILED',
    failure_recorded_at = now(),
    sent_at             = null
  where id = v_inv.id;

  select o.name into v_retailer_name from public.organizations o where o.id = v_inv.retailer_organization_id;
  select r.code into v_role_code     from public.roles r         where r.id = v_inv.role_id;
  select count(*) into v_shop_count
  from public.retailer_invitation_shop_assignments sa
  where sa.retailer_staff_invitation_id = v_inv.id;

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
    v_inv.invited_by_profile_id,
    'STAFF_INVITATION_DELIVERY_FAILED',
    'RETAILER_STAFF_INVITATION',
    v_inv.id::text,
    jsonb_build_object(
      'retailer_name',     v_retailer_name,
      'role_code',         v_role_code,
      'invitation_status', 'PENDING',
      'shop_count',        v_shop_count
    )
  );
end;
$$;

revoke all     on function public.record_retailer_staff_invitation_failure(uuid, text) from public;
revoke execute on function public.record_retailer_staff_invitation_failure(uuid, text) from anon;
revoke execute on function public.record_retailer_staff_invitation_failure(uuid, text) from authenticated;
grant  execute on function public.record_retailer_staff_invitation_failure(uuid, text) to service_role;

-- ============================================================================
-- Closing note
-- ============================================================================
-- No table, column, constraint, index, trigger, policy, role, permission, mapping, or
-- existing function is created, altered, or dropped by this migration. The staff
-- invitation storage and owner operations keep exactly the posture migrations
-- 20260723090000 and 20260723210000 left them in; no table privilege is granted to any
-- browser role here. Recipient resolution, acceptance, membership provisioning, and
-- all application/email work are deliberately NOT in this migration.
