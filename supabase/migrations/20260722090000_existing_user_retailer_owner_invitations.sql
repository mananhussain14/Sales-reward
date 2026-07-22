-- ============================================================================
-- Migration: existing_user_retailer_owner_invitations
-- ============================================================================
-- Purpose: give the Retailer Owner invitation lifecycle a SECOND, safe path for
-- an invitee who ALREADY has a Supabase Auth account — the case the new-user flow
-- cannot serve (inviteUserByEmail refuses an existing address, classified
-- EXISTING_ACCOUNT).
--
-- SECURITY MODEL — an APPLICATION-OWNED TOKEN that is a NON-AUTHENTICATING POINTER.
--   Acceptance requires BOTH, together:
--     1. a valid, live invitation identified by SHA-256(raw token); AND
--     2. an authenticated Supabase user whose VERIFIED, normalized email equals the
--        invitation email.
--   The token never authenticates anyone and never grants membership by itself: a
--   leaked/forwarded link is inert unless the holder is ALSO signed in as the
--   invited address. The raw token is generated later by the server, may appear in
--   the recipient's URL, and is NEVER stored, logged, or audited. PostgreSQL stores
--   only SHA-256(raw token) as exactly 64 lowercase hex characters.
--
-- ADDITIVE AND TABLE-PRESERVING. Two nullable-friendly columns + constraints + one
-- partial unique index on public.retailer_invitations; four new functions; three
-- CREATE OR REPLACEs (failure writer, revoke, expire) reproduced verbatim with a
-- minimal addition; one dependency-checked DROP+recreate of the owner-status RPC to
-- add one safe output column. No browser table grant and no RLS policy changes.
--
-- COMPATIBILITY. The merged application ignores extra owner-status output columns
-- (lib/retailers/owner-status-normalization.ts reads only its seven named fields
-- and enforces exactly one ROW, not an exact column set), so adding invitation_kind
-- does not break main. No live EXISTING_USER row and no EXISTING_USER_EMAIL_FAILED
-- classification can exist until a later application stage wires the orchestration;
-- until then every row remains NEW_USER with one of the three previously-known
-- failure codes, so the current normalizer keeps working unchanged.
--
-- The new-user flow (reserve -> inviteUserByEmail -> finalize -> TokenHash accept ->
-- password completion) is UNCHANGED: reserve, finalize, and the zero-argument
-- accept_retailer_owner_invitation() are not touched.
-- ============================================================================


-- ============================================================================
-- PART 1 — Columns, constraints, index, failure-code extension
-- ============================================================================
-- invitation_kind distinguishes the two flows on a single row. Historical rows take
-- the default NEW_USER; the same row can be CONVERTED to EXISTING_USER by the
-- preparation function below, so no second table is needed.
alter table public.retailer_invitations
  add column invitation_kind text not null default 'NEW_USER';

alter table public.retailer_invitations
  add constraint retailer_invitations_invitation_kind_allowed
    check (invitation_kind in ('NEW_USER', 'EXISTING_USER'));

-- token_hash stores ONLY SHA-256(raw token) as 64 lowercase hex chars. NULL for
-- every NEW_USER row and for any terminal invitation.
alter table public.retailer_invitations
  add column token_hash text null;

-- Format: null, or exactly 64 lowercase hex. COLLATE "C" is load-bearing (as in
-- retailer_invitations_email_shape): under a locale-aware collation a bracket range
-- can admit characters outside the intended ASCII set, so the operand is pinned to
-- the C collation to mean exactly what it reads as on every host.
alter table public.retailer_invitations
  add constraint retailer_invitations_token_hash_format
    check (token_hash is null or token_hash collate "C" ~ '^[0-9a-f]{64}$');

-- A token may exist ONLY on a live EXISTING_USER invitation. This is what
-- guarantees no ACCEPTED, EXPIRED, or REVOKED invitation — and no NEW_USER row —
-- can ever retain a usable token: the transition that changes status/kind must also
-- null the hash in the same UPDATE or the row is rejected.
alter table public.retailer_invitations
  add constraint retailer_invitations_token_hash_context
    check (
      token_hash is null
      or (invitation_kind = 'EXISTING_USER' and status = 'PENDING')
    );

-- One live token per hash. Partial, so it indexes only rows that carry a token and
-- stays small; settled history contributes nothing.
create unique index retailer_invitations_token_hash_unique_idx
  on public.retailer_invitations (token_hash)
  where token_hash is not null;

-- Extend the approved failure vocabulary with EXISTING_USER_EMAIL_FAILED (the
-- application-owned invitation email could not be sent immediately). A CHECK cannot
-- be altered in place, so it is dropped and recreated under the SAME name with the
-- SAME three prior codes plus the new one — their meanings are unchanged.
alter table public.retailer_invitations
  drop constraint retailer_invitations_failure_code_allowed;

alter table public.retailer_invitations
  add constraint retailer_invitations_failure_code_allowed
    check (
      failure_code is null
      or failure_code in (
        'EXISTING_ACCOUNT',
        'AUTH_DISPATCH_FAILED',
        'FINALIZATION_FAILED',
        'EXISTING_USER_EMAIL_FAILED'
      )
    );


-- ============================================================================
-- PART 2 — prepare_existing_user_retailer_owner_invitation()  [service_role]
-- ============================================================================
-- Converts a live PENDING invitation to the EXISTING_USER flow and stores a token
-- hash. Called by the trusted server AFTER it has generated the raw token and
-- computed its SHA-256 — the RAW TOKEN NEVER REACHES THIS FUNCTION.
--
-- LIFECYCLE HONESTY. This step never asserts that an email was delivered. It does
-- NOT set sent_at, and it RESETS any existing sent_at to null — a rotation must not
-- inherit a prior send. sent_at is written only by
-- record_existing_user_retailer_owner_invitation_sent() (Part 3) after the
-- application confirms the send. This keeps the owner-status split correct — a
-- prepared-but-not-yet-emailed EXISTING_USER invitation reads DELIVERY_FAILED, and
-- only a prepared-AND-emailed one reads PENDING.
--
-- RESEND ROTATES THE HASH ATOMICALLY. Re-preparing the same row replaces token_hash
-- with a new value, refreshes the 24-hour window, clears sent_at, and clears
-- failure_code / failure_recorded_at — all in ONE update. This INVALIDATES the
-- previous token (its hash matches no row) and returns the invitation to the
-- "not yet sent" state until the new send succeeds. Membership, profile, and roles
-- are NOT touched here.
create function public.prepare_existing_user_retailer_owner_invitation(
  p_invitation_id uuid,
  p_token_hash    text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv public.retailer_invitations%rowtype;
begin
  if p_invitation_id is null then
    raise exception 'Invitation could not be prepared' using errcode = 'check_violation';
  end if;

  -- Validate the hash shape server-side too (defence in depth; the column
  -- constraint is the final authority). A malformed hash never reaches the table.
  if p_token_hash is null or p_token_hash collate "C" !~ '^[0-9a-f]{64}$' then
    raise exception 'Invitation could not be prepared' using errcode = 'check_violation';
  end if;

  select * into v_inv
  from public.retailer_invitations
  where id = p_invitation_id
  for update;

  if v_inv.id is null then
    raise exception 'Invitation could not be prepared' using errcode = 'check_violation';
  end if;

  -- Only a live PENDING invitation may be prepared or converted.
  if v_inv.status <> 'PENDING' then
    raise exception 'Invitation could not be prepared' using errcode = 'check_violation';
  end if;

  -- Refuse a FINALIZED new-user invitation (both membership and sent present): that
  -- is a successfully dispatched new-user invite awaiting acceptance, not a
  -- candidate for existing-user conversion. A NEW_USER + EXISTING_ACCOUNT row (no
  -- membership, no sent_at) IS allowed — that is the primary conversion case.
  if v_inv.organization_member_id is not null and v_inv.sent_at is not null then
    raise exception 'Invitation could not be prepared' using errcode = 'check_violation';
  end if;

  update public.retailer_invitations
  set
    invitation_kind     = 'EXISTING_USER',
    token_hash          = p_token_hash,
    expires_at          = now() + interval '24 hours',
    -- sent_at is RESET so a rotation cannot inherit a prior successful send. A
    -- previously accepted-then-resent, or successfully-sent-then-resent, invitation
    -- may already carry sent_at; leaving it set would make the owner-status RPC
    -- report the replacement invitation as PENDING (delivered) before its new email
    -- has actually been sent. record_existing_user_..._sent() re-sets it only after
    -- the fresh send succeeds.
    sent_at             = null,
    failure_code        = null,
    failure_recorded_at = null
  where id = v_inv.id;
end;
$$;

-- Privileges. service_role only, matching finalize() and the failure writer: it
-- writes tenant data keyed by an invitation id and makes no auth.uid() check, so a
-- browser session must never reach it.
revoke all     on function public.prepare_existing_user_retailer_owner_invitation(uuid, text) from public;
revoke execute on function public.prepare_existing_user_retailer_owner_invitation(uuid, text) from anon;
revoke execute on function public.prepare_existing_user_retailer_owner_invitation(uuid, text) from authenticated;
grant  execute on function public.prepare_existing_user_retailer_owner_invitation(uuid, text) to service_role;


-- ============================================================================
-- PART 3 — record_existing_user_retailer_owner_invitation_sent()  [service_role]
-- ============================================================================
-- The honest "email handed off successfully" step. Sets sent_at on a prepared
-- EXISTING_USER invitation and clears any prior email-failure classification. This
-- is what promotes the owner-status from DELIVERY_FAILED (prepared, not emailed) to
-- PENDING (emailed, awaiting acceptance). It does NOT touch the token — the same
-- token remains valid until acceptance, expiry, revocation, or a resend rotation.
create function public.record_existing_user_retailer_owner_invitation_sent(
  p_invitation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv public.retailer_invitations%rowtype;
begin
  if p_invitation_id is null then
    raise exception 'Invitation send could not be recorded' using errcode = 'check_violation';
  end if;

  select * into v_inv
  from public.retailer_invitations
  where id = p_invitation_id
  for update;

  if v_inv.id is null then
    raise exception 'Invitation send could not be recorded' using errcode = 'check_violation';
  end if;

  -- Only a live, prepared EXISTING_USER invitation (PENDING, kind set, token
  -- present) may be marked sent.
  if v_inv.status <> 'PENDING'
     or v_inv.invitation_kind <> 'EXISTING_USER'
     or v_inv.token_hash is null then
    raise exception 'Invitation send could not be recorded' using errcode = 'check_violation';
  end if;

  update public.retailer_invitations
  set
    sent_at             = now(),
    failure_code        = null,
    failure_recorded_at = null
  where id = v_inv.id;
end;
$$;

revoke all     on function public.record_existing_user_retailer_owner_invitation_sent(uuid) from public;
revoke execute on function public.record_existing_user_retailer_owner_invitation_sent(uuid) from anon;
revoke execute on function public.record_existing_user_retailer_owner_invitation_sent(uuid) from authenticated;
grant  execute on function public.record_existing_user_retailer_owner_invitation_sent(uuid) to service_role;


-- ============================================================================
-- PART 4 — record_retailer_owner_invitation_failure()  [CREATE OR REPLACE]
-- ============================================================================
-- Reproduced verbatim from migration 20260721190000, with ONE change: the accepted
-- code list gains EXISTING_USER_EMAIL_FAILED. Every existing restriction is
-- preserved — PENDING only, refuse a finalized row, no raw error text, service_role
-- only. Recording EXISTING_USER_EMAIL_FAILED does NOT touch token_hash, so the token
-- stays valid for in-app recovery; a Vendor resend rotates it.
create or replace function public.record_retailer_owner_invitation_failure(
  p_invitation_id uuid,
  p_failure_code  text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv public.retailer_invitations%rowtype;
begin
  if p_invitation_id is null then
    raise exception 'Invitation failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  if p_failure_code is null
     or p_failure_code not in (
       'EXISTING_ACCOUNT',
       'AUTH_DISPATCH_FAILED',
       'FINALIZATION_FAILED',
       'EXISTING_USER_EMAIL_FAILED'
     ) then
    raise exception 'Invitation failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  select * into v_inv
  from public.retailer_invitations
  where id = p_invitation_id
  for update;

  if v_inv.id is null then
    raise exception 'Invitation failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  if v_inv.status <> 'PENDING' then
    raise exception 'Invitation failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  if v_inv.organization_member_id is not null and v_inv.sent_at is not null then
    raise exception 'Invitation failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  update public.retailer_invitations
  set
    failure_code        = p_failure_code,
    failure_recorded_at = now()
  where id = v_inv.id;
end;
$$;

revoke all     on function public.record_retailer_owner_invitation_failure(uuid, text) from public;
revoke execute on function public.record_retailer_owner_invitation_failure(uuid, text) from anon;
revoke execute on function public.record_retailer_owner_invitation_failure(uuid, text) from authenticated;
grant  execute on function public.record_retailer_owner_invitation_failure(uuid, text) to service_role;


-- ============================================================================
-- PART 5 — get_pending_existing_user_retailer_invitation()  [authenticated]
-- ============================================================================
-- Resolves the invitation identified by a SERVER-CALCULATED token hash, for the
-- acceptance page. The application computes SHA-256(raw token) server-side; the raw
-- token never reaches this function.
--
-- DISCLOSURE DISCIPLINE. A positive match (retailer_name, expires_at, email_matches
-- = true) is returned ONLY when the caller's email is confirmed AND equals the
-- invitation email. A wrong or unverified caller gets email_matches = false with
-- NULL retailer_name and NULL expires_at — learning neither the invited email nor
-- the Retailer, only that they must sign in as the invited address. An invalid,
-- expired, revoked, or accepted token returns ZERO rows. No invitation id, token
-- hash, Auth user id, or foreign email is ever returned.
create function public.get_pending_existing_user_retailer_invitation(
  p_token_hash text
)
returns table (
  retailer_name text,
  expires_at    timestamptz,
  email_matches boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid        uuid;
  v_inv        public.retailer_invitations%rowtype;
  v_auth_email text;
  v_confirmed  timestamptz;
begin
  v_uid := auth.uid();
  if v_uid is null then
    return;  -- zero rows
  end if;

  if p_token_hash is null or p_token_hash collate "C" !~ '^[0-9a-f]{64}$' then
    return;  -- zero rows for a malformed hash
  end if;

  select * into v_inv
  from public.retailer_invitations ri
  where ri.token_hash = p_token_hash
    and ri.invitation_kind = 'EXISTING_USER'
    and ri.status = 'PENDING'
    and ri.expires_at > now()
    and ri.revoked_at is null
    and ri.accepted_at is null;

  if v_inv.id is null then
    return;  -- generic: invalid / expired / revoked / accepted all look identical
  end if;

  select lower(btrim(u.email)), u.email_confirmed_at
    into v_auth_email, v_confirmed
  from auth.users u
  where u.id = v_uid;

  if v_confirmed is not null and v_auth_email is not null and v_auth_email = v_inv.email then
    return query
      select o.name, v_inv.expires_at, true
      from public.organizations o
      where o.id = v_inv.retailer_organization_id;
  else
    -- Valid token, wrong or unverified caller: reveal nothing but the mismatch.
    return query select null::text, null::timestamptz, false;
  end if;
end;
$$;

revoke all     on function public.get_pending_existing_user_retailer_invitation(text) from public;
revoke execute on function public.get_pending_existing_user_retailer_invitation(text) from anon;
grant  execute on function public.get_pending_existing_user_retailer_invitation(text) to authenticated;


-- ============================================================================
-- PART 6 — accept_existing_user_retailer_owner_invitation()  [authenticated]
-- ============================================================================
-- Accepts an EXISTING_USER invitation as the currently authenticated user. The
-- security decision requires BOTH a live token hash AND a verified email match.
-- Unlike the new-user acceptance (which activates a membership finalize() already
-- created), this creates-or-reuses the profile, membership, and RETAILER_OWNER role
-- itself, because no finalize step ran for an existing user.
--
-- The existing zero-argument accept_retailer_owner_invitation() is NOT modified.
create function public.accept_existing_user_retailer_owner_invitation(
  p_token_hash text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid           uuid;
  v_inv           public.retailer_invitations%rowtype;
  v_auth_email    text;
  v_confirmed     timestamptz;
  v_profile_stat  text;
  v_member_id     uuid;
  v_member_stat   text;
  v_role_code     text;
  v_retailer_name text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  if p_token_hash is null or p_token_hash collate "C" !~ '^[0-9a-f]{64}$' then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 1. Resolve and lock the live token. FOR UPDATE serializes concurrent
  --    acceptances of the same token: the first commits (status -> ACCEPTED, token
  --    cleared), and the second re-qualifies its `status = 'PENDING'` filter, finds
  --    no row, and fails closed. Token reuse after acceptance therefore denies
  --    generically WITHOUT any duplicate write.
  -- --------------------------------------------------------------------------
  select * into v_inv
  from public.retailer_invitations
  where token_hash = p_token_hash
    and invitation_kind = 'EXISTING_USER'
    and status = 'PENDING'
  for update;

  if v_inv.id is null then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  if v_inv.expires_at <= now() then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Verify the caller's email is CONFIRMED and matches the invitation email.
  --    This is the whole binding: the token says which invitation, the session
  --    says who, and only a verified match may proceed. A different signed-in
  --    account, or an unverified email, lands on the same generic refusal.
  -- --------------------------------------------------------------------------
  select lower(btrim(u.email)), u.email_confirmed_at
    into v_auth_email, v_confirmed
  from auth.users u
  where u.id = v_uid;

  if v_confirmed is null or v_auth_email is null or v_auth_email <> v_inv.email then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Re-verify the relationship and Retailer are still ACTIVE.
  -- --------------------------------------------------------------------------
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
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. Block when ANY active Retailer Owner already exists for this Retailer —
  --    INCLUDING when that owner is the caller. A Retailer has one owner; a live
  --    PENDING invitation must not be accepted merely because auth.uid() is already
  --    the active owner. This is NOT a path to idempotency: the invitation that made
  --    someone an owner is already ACCEPTED with its token cleared, so it can never
  --    reach this code again (the FOR UPDATE lookup above requires a PENDING token).
  --    A live PENDING invitation reaching here while the caller already owns the
  --    Retailer is an unrelated, redundant invitation and is refused.
  -- --------------------------------------------------------------------------
  if exists (
    select 1
    from public.organization_members m
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    where m.organization_id = v_inv.retailer_organization_id
      and m.status = 'ACTIVE'
      and r.code = 'RETAILER_OWNER'
  ) then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. Profile — create if absent, promote INVITED, reuse ACTIVE, refuse retired.
  --    A SUSPENDED or DEACTIVATED profile is an administrative state and is NEVER
  --    silently reactivated by accepting an invitation.
  -- --------------------------------------------------------------------------
  select p.status into v_profile_stat
  from public.profiles p
  where p.id = v_uid;

  if v_profile_stat is null then
    -- No profile yet: create one ACTIVE, with the names from the invitation (the
    -- invitation's own non-empty/trimmed constraints guarantee these satisfy
    -- profiles' constraints). An existing profile's names are never overwritten.
    insert into public.profiles (id, first_name, last_name, status)
    values (v_uid, v_inv.first_name, v_inv.last_name, 'ACTIVE');
  elsif v_profile_stat = 'INVITED' then
    update public.profiles set status = 'ACTIVE'
    where id = v_uid and status = 'INVITED';
  elsif v_profile_stat <> 'ACTIVE' then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  select p.status into v_profile_stat from public.profiles p where p.id = v_uid;
  if v_profile_stat is distinct from 'ACTIVE' then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 6. Membership — create ACTIVE or safely reuse. ON CONFLICT DO NOTHING against
  --    organization_members_unique_membership prevents a duplicate under
  --    concurrency and preserves an existing membership (another role's) untouched.
  --    An INVITED membership is promoted; SUSPENDED/DEACTIVATED is refused.
  -- --------------------------------------------------------------------------
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (v_inv.retailer_organization_id, v_uid, 'ACTIVE', now())
  on conflict (organization_id, user_id) do nothing;

  select m.id, m.status into v_member_id, v_member_stat
  from public.organization_members m
  where m.organization_id = v_inv.retailer_organization_id
    and m.user_id = v_uid;

  if v_member_id is null then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  if v_member_stat = 'INVITED' then
    update public.organization_members
    set status = 'ACTIVE', joined_at = coalesce(joined_at, now())
    where id = v_member_id and status = 'INVITED';
  elsif v_member_stat <> 'ACTIVE' then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  select m.status into v_member_stat from public.organization_members m where m.id = v_member_id;
  if v_member_stat is distinct from 'ACTIVE' then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 7. Grant RETAILER_OWNER, ADDING to any existing roles. The role id is the one
  --    reserve() resolved onto the invitation; its code is re-verified (defence in
  --    depth, matching finalize()). ON CONFLICT DO NOTHING against member_roles_pkey
  --    prevents a duplicate assignment and removes no existing role.
  -- --------------------------------------------------------------------------
  select r.code into v_role_code from public.roles r where r.id = v_inv.role_id;
  if v_role_code is distinct from 'RETAILER_OWNER' then
    raise exception 'This invitation could not be accepted' using errcode = 'insufficient_privilege';
  end if;

  insert into public.member_roles (organization_member_id, role_id, assigned_by)
  values (v_member_id, v_inv.role_id, v_inv.invited_by_profile_id)
  on conflict (organization_member_id, role_id) do nothing;

  -- --------------------------------------------------------------------------
  -- 8. Mark accepted, link the produced rows, and clear the token + classification.
  --    token_hash and status change in ONE UPDATE so the row is only ever observed
  --    as (ACCEPTED, token null) — retailer_invitations_token_hash_context holds.
  --    accepted_has_member / accepted_has_auth_user are satisfied by the two ids.
  --    The WHERE re-asserts PENDING so a concurrent transition cannot be overwritten.
  -- --------------------------------------------------------------------------
  update public.retailer_invitations
  set
    status                 = 'ACCEPTED',
    accepted_at            = now(),
    auth_user_id           = v_uid,
    organization_member_id = v_member_id,
    token_hash             = null,
    failure_code           = null,
    failure_recorded_at    = null
  where id = v_inv.id
    and status = 'PENDING';

  select o.name into v_retailer_name
  from public.organizations o
  where o.id = v_inv.retailer_organization_id;

  -- --------------------------------------------------------------------------
  -- 9. Audit — same shape as the new-user acceptance record; no token, no ids, no
  --    email, no request metadata.
  -- --------------------------------------------------------------------------
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
    v_uid,
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

revoke all     on function public.accept_existing_user_retailer_owner_invitation(text) from public;
revoke execute on function public.accept_existing_user_retailer_owner_invitation(text) from anon;
grant  execute on function public.accept_existing_user_retailer_owner_invitation(text) to authenticated;


-- ============================================================================
-- PART 7 — revoke_retailer_owner_invitation()  [CREATE OR REPLACE]
-- ============================================================================
-- Reproduced verbatim from migration 20260720092755, with ONE addition: the
-- REVOKED update also clears token_hash, so no revoked invitation can retain a
-- usable token. failure_code is left as-is (the owner-status RPC already hides it on
-- terminal states), matching the established lifecycle. Signature, authorization,
-- membership handling, audit, and grants are unchanged.
create or replace function public.revoke_retailer_owner_invitation(
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

  if not public.has_organization_permission(v_vendor_org_id, 'RETAILER_OWNERS_INVITE') then
    raise exception 'Not authorized to revoke this invitation'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_inv
  from public.retailer_invitations
  where id = p_invitation_id
    and vendor_organization_id = v_vendor_org_id
  for update;

  if v_inv.id is null or v_inv.status <> 'PENDING' then
    raise exception 'Not authorized to revoke this invitation'
      using errcode = 'insufficient_privilege';
  end if;

  if v_inv.organization_member_id is not null then
    update public.organization_members
    set
      status         = 'DEACTIVATED',
      deactivated_at = now()
    where id = v_inv.organization_member_id
      and status = 'INVITED';
  end if;

  update public.retailer_invitations
  set
    status     = 'REVOKED',
    revoked_at = now(),
    token_hash = null
  where id = v_inv.id
    and status = 'PENDING';

  select o.name into v_retailer_name
  from public.organizations o
  where o.id = v_inv.retailer_organization_id;

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
-- PART 8 — expire_stale_retailer_invitations()  [CREATE OR REPLACE]
-- ============================================================================
-- Reproduced verbatim from migration 20260721150000, with ONE addition: the
-- EXPIRED update also clears token_hash, so no expired invitation retains a usable
-- token. Signature, atomicity, membership deactivation, and grants are unchanged.
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
    set
      status     = 'EXPIRED',
      token_hash = null
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

revoke all on function public.expire_stale_retailer_invitations(uuid) from public;
revoke execute on function public.expire_stale_retailer_invitations(uuid) from anon;
revoke execute on function public.expire_stale_retailer_invitations(uuid) from authenticated;


-- ============================================================================
-- PART 9 — get_vendor_retailer_owner_status()  [DROP + recreate]
-- ============================================================================
-- Reproduced verbatim from migration 20260721190000 with TWO additions: one new
-- output column, invitation_kind, and a kind-aware PENDING/DELIVERY_FAILED split.
-- The return type changes, which CREATE OR REPLACE cannot do, so a dependency-safe
-- DROP + recreate is used — no database object depends on this function (its only
-- caller is the application over PostgREST), so no CASCADE is needed and nothing
-- else is removed. Name, input signature, Vendor authorization, precedence,
-- SECURITY DEFINER, STABLE, empty search_path, owner, and grants are preserved.
--
-- KIND-AWARE COMPLETION. A NEW_USER invitation is genuinely "sent" only once
-- finalize() left both a membership and sent_at. An EXISTING_USER invitation has no
-- membership before acceptance, so its completion proof is sent_at alone (written by
-- record_existing_user_retailer_owner_invitation_sent). invitation_kind is exposed
-- for the relevant invitation states, and null for NONE and the profile-only ACTIVE
-- fallback. No token hash and no invitation id is returned.
drop function public.get_vendor_retailer_owner_status(uuid);

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
  accepted_at      timestamptz,
  failure_code     text,
  invitation_kind  text
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
  -- Authorization — identical chain to reserve()/revoke(), read-only permission
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

  if not public.has_organization_permission(v_vendor_org_id, 'RETAILERS_READ') then
    raise exception 'Not authorized to view this Retailer''s owner status'
      using errcode = 'insufficient_privilege';
  end if;

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

  -- 1. ACTIVE — a qualifying ACTIVE RETAILER_OWNER membership wins outright
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
               v_inv.sent_at, v_inv.expires_at, v_inv.accepted_at,
               null::text, v_inv.invitation_kind;
      return;
    end if;

    select p.first_name, p.last_name
      into v_first_name, v_last_name
    from public.profiles p
    where p.id = v_active_user_id;

    return query
      select 'ACTIVE'::text,
             v_first_name, v_last_name, null::text,
             null::timestamptz, null::timestamptz, null::timestamptz,
             null::text, null::text;
    return;
  end if;

  -- 2. PENDING / DELIVERY_FAILED — the newest current, unexpired PENDING row
  select *
    into v_inv
  from public.retailer_invitations ri
  where ri.retailer_organization_id = v_retailer_org_id
    and ri.status = 'PENDING'
    and ri.expires_at > now()
  order by ri.created_at desc, ri.id desc
  limit 1;

  if v_inv.id is not null then
    -- Completion proof depends on the flow: a NEW_USER invitation needs both a
    -- membership and sent_at; an EXISTING_USER invitation needs sent_at alone (it
    -- has no membership before acceptance).
    if (v_inv.invitation_kind = 'NEW_USER'
          and v_inv.organization_member_id is not null and v_inv.sent_at is not null)
       or (v_inv.invitation_kind = 'EXISTING_USER'
          and v_inv.sent_at is not null) then
      return query
        select 'PENDING'::text,
               v_inv.first_name, v_inv.last_name, v_inv.email,
               v_inv.sent_at, v_inv.expires_at, null::timestamptz,
               null::text, v_inv.invitation_kind;
    else
      return query
        select 'DELIVERY_FAILED'::text,
               v_inv.first_name, v_inv.last_name, v_inv.email,
               v_inv.sent_at, v_inv.expires_at, null::timestamptz,
               v_inv.failure_code, v_inv.invitation_kind;
    end if;
    return;
  end if;

  -- 3. EXPIRED — the newest applicable expired invitation, deterministically.
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
             v_inv.sent_at, v_inv.expires_at, null::timestamptz,
             null::text, v_inv.invitation_kind;
    return;
  end if;

  -- 4. NONE — no active owner and no invitation state worth displaying
  return query
    select 'NONE'::text,
           null::text, null::text, null::text,
           null::timestamptz, null::timestamptz, null::timestamptz,
           null::text, null::text;
  return;
end;
$$;

revoke all     on function public.get_vendor_retailer_owner_status(uuid) from public;
revoke execute on function public.get_vendor_retailer_owner_status(uuid) from anon;
grant  execute on function public.get_vendor_retailer_owner_status(uuid) to authenticated;
