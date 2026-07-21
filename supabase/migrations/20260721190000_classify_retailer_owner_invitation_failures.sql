-- ============================================================================
-- Migration: classify_retailer_owner_invitation_failures
-- ============================================================================
-- Purpose: give the Retailer Owner invitation lifecycle a small, constrained,
-- display-safe classification for WHY a delivery did not complete, so the Vendor
-- UI can eventually stop offering "Retry" for a failure the current new-user-only
-- flow can never resolve (an email that already belongs to a Supabase Auth user).
--
-- This migration is ADDITIVE and TABLE-PRESERVING in spirit: it adds two nullable
-- columns and two check constraints to public.retailer_invitations, adds one
-- server-only failure-recording RPC, CREATE OR REPLACEs reserve() and finalize()
-- to clear a stale classification (on a fresh attempt and on success), and
-- DROP-and-recreates get_vendor_retailer_owner_status() to surface the new
-- failure_code (a return-type change CREATE OR REPLACE cannot make). No browser
-- table grant and no RLS policy is added or changed anywhere.
--
-- WHAT WAS BROKEN
--   DELIVERY_FAILED conflates three distinct outcomes that the server-only
--   invitation service (lib/invitations/retailer-owner-invitations.ts) already
--   tells apart at runtime but the database never persisted:
--     * the address already has an Auth account (inviteUserByEmail refused) —
--       NON-retryable through the new-user flow;
--     * the Auth dispatch failed for another reason — potentially retryable;
--     * Auth succeeded but the database finalization step failed — retryable, but
--       the retry's inviteUserByEmail will now meet the Auth account the FIRST
--       attempt created, because the service performs NO Auth-user compensation.
--   Because nothing was stored, a page refresh could not distinguish them and the
--   UI offered a futile Retry. This migration persists a safe reason so a later
--   application milestone can render the right action.
--
-- WHAT IS NOT DONE HERE
--   No application file is changed (this is the database stage). The service is
--   not yet wired to call the new RPC; existing-user invitation acceptance remains
--   out of scope. No enum type is created — the repository classifies text columns
--   with CHECK constraints (retailer_invitations_status_allowed is the model), and
--   an enum would be a heavier, less local contract for three values.
-- ============================================================================


-- ============================================================================
-- PART 1 — Failure classification columns and constraints
-- ============================================================================
-- Two nullable columns. Existing rows keep both null, which every constraint below
-- admits, so no historical row is invalidated and none is backfilled with a guess.
alter table public.retailer_invitations
  add column failure_code        text        null,
  add column failure_recorded_at timestamptz null;

-- The approved safe vocabulary, and nothing else. A CHECK rather than an enum, for
-- the reasons in the header. NULL is admitted (an invitation with no recorded
-- failure), matching how retailer_invitations_accepted_consistent admits the
-- not-yet-accepted state.
--
--   EXISTING_ACCOUNT      inviteUserByEmail refused because the normalized email
--                         already belongs to an Auth user. Non-retryable through
--                         the current new-user-only flow.
--   AUTH_DISPATCH_FAILED  Auth dispatch did not complete for another safe,
--                         non-specific reason. Potentially retryable.
--   FINALIZATION_FAILED   Auth dispatch succeeded (or may have) but the database
--                         finalization did not complete. A retry's inviteUserByEmail
--                         may now meet the Auth account the first attempt created.
alter table public.retailer_invitations
  add constraint retailer_invitations_failure_code_allowed
    check (
      failure_code is null
      or failure_code in ('EXISTING_ACCOUNT', 'AUTH_DISPATCH_FAILED', 'FINALIZATION_FAILED')
    );

-- The code and its timestamp move together or not at all. Written as an equivalence
-- so BOTH directions are covered: a code without a timestamp is rejected, and so is
-- a timestamp without a code. This mirrors retailer_invitations_accepted_consistent
-- and retailer_invitations_revoked_consistent exactly.
alter table public.retailer_invitations
  add constraint retailer_invitations_failure_consistent
    check ((failure_code is null) = (failure_recorded_at is null));

-- No index is added: failure_code is read only alongside a row already located by
-- the owner-status RPC's existing filters (retailer_organization_id + status), and
-- is never itself a search key. No table grant and no RLS policy is touched — the
-- browser still cannot read one byte of this table directly.


-- ============================================================================
-- PART 2 — record_retailer_owner_invitation_failure()  [service_role ONLY]
-- ============================================================================
-- The ONLY writer of the classification. Called by the trusted server-only
-- invitation service after a dispatch or finalization step fails, with an id it
-- produced itself — never a browser-supplied id.
--
-- INVARIANTS.
--   * Only the three approved codes are accepted; anything else is refused with a
--     generic error and the row is left unchanged.
--   * Only a still-PENDING invitation may be classified. ACCEPTED, EXPIRED, and
--     REVOKED are terminal and must never gain a delivery-failure reason.
--   * A FINALIZED invitation (both organization_member_id AND sent_at present) is
--     refused for EVERY code. This is correct for all three: finalize() sets those
--     two columns together in one UPDATE, so a row that has them did complete
--     finalization and is not a delivery failure — and FINALIZATION_FAILED, by
--     definition, is recorded when finalize did NOT complete, so its target never
--     has them either.
--   * failure_code and failure_recorded_at are set atomically in one UPDATE, which
--     the Part 1 consistency constraint also enforces.
--
-- No raw error text is accepted or stored: the only inputs are an id and one of
-- three fixed codes. FOR UPDATE serializes a failure record against a concurrent
-- reserve()/finalize() on the same row. Generic errors only — a caller learns
-- nothing about a row it may not touch.
create function public.record_retailer_owner_invitation_failure(
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

  -- Only the approved safe codes. Checked before the row is touched so an invalid
  -- code can never reach the table, and reported generically so the vocabulary is
  -- not enumerable by probing.
  if p_failure_code is null
     or p_failure_code not in ('EXISTING_ACCOUNT', 'AUTH_DISPATCH_FAILED', 'FINALIZATION_FAILED') then
    raise exception 'Invitation failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- Lock the row so a failure record and a concurrent reserve()/finalize() on the
  -- same invitation serialize rather than racing.
  select * into v_inv
  from public.retailer_invitations
  where id = p_invitation_id
  for update;

  if v_inv.id is null then
    raise exception 'Invitation failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- Only a live PENDING invitation may be classified. A terminal one (ACCEPTED,
  -- EXPIRED, REVOKED) must never gain a delivery-failure reason.
  if v_inv.status <> 'PENDING' then
    raise exception 'Invitation failure could not be recorded'
      using errcode = 'check_violation';
  end if;

  -- Refuse a finalized invitation. Both columns present means finalize() completed,
  -- so this is not a delivery failure. See the header invariant.
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

-- Privileges. Identical posture to finalize_retailer_owner_invitation(): the only
-- database function in this domain granted to service_role rather than
-- authenticated. It writes tenant data keyed by an invitation id and makes NO
-- auth.uid() check, so a browser session must never reach it — every browser role
-- is stripped explicitly and only the secret-key role the trusted server holds is
-- granted. There is deliberately no authenticated/browser-callable failure writer.
revoke all     on function public.record_retailer_owner_invitation_failure(uuid, text) from public;
revoke execute on function public.record_retailer_owner_invitation_failure(uuid, text) from anon;
revoke execute on function public.record_retailer_owner_invitation_failure(uuid, text) from authenticated;
grant  execute on function public.record_retailer_owner_invitation_failure(uuid, text) to service_role;


-- ============================================================================
-- PART 3 — reserve_retailer_owner_invitation()  [CREATE OR REPLACE]
-- ============================================================================
-- Reproduced verbatim from migration 20260721150000, with ONE addition: the
-- same-email resend branch (section 7) now CLEARS failure_code and
-- failure_recorded_at. Beginning a new dispatch attempt must not leave the previous
-- failure classification on the row, or the UI would show a stale reason while a
-- fresh attempt is in flight. Signature, return columns, volatility, security
-- context, search_path, ownership, privileges, locking, and every other check are
-- unchanged.
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
  -- 1. Authorization
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

  -- 2. Ownership — the relationship must belong to the DERIVED Vendor
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

  -- 3. Active write gate
  if v_relationship_status <> 'ACTIVE' then
    raise exception 'This Retailer relationship is not active'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_retailer_status <> 'ACTIVE' then
    raise exception 'This Retailer organization is not active'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- 4. Input normalization and validation
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

  -- 5. Expire stale invitations for this Retailer (also deactivates linked members)
  perform public.expire_stale_retailer_invitations(v_retailer_org_id);

  -- 6. Block an existing ACTIVE Retailer Owner
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

  -- 7. Idempotent resend for a still-live SAME-EMAIL invitation
  -- A resend restarts the clock and refreshes the names. It ALSO clears any
  -- previously recorded failure classification: a new attempt is beginning, and the
  -- old reason must not linger on the row (or the UI would show a stale failure
  -- while the fresh dispatch is in flight). sent_at is still deliberately NOT
  -- cleared — finalize() rewrites it on the next successful dispatch.
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
      expires_at          = now() + interval '24 hours',
      first_name          = v_first_name,
      last_name           = v_last_name,
      failure_code        = null,
      failure_recorded_at = null
    where id = v_existing_id;

    return query select v_existing_id, v_email, true;
    return;
  end if;

  -- 7b. Block a conflicting DIFFERENT-email owner state
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

  -- 8. The reservation
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
-- PART 4 — finalize_retailer_owner_invitation()  [CREATE OR REPLACE]
-- ============================================================================
-- Reproduced verbatim from migration 20260720092755, with ONE addition: the
-- delivery-recording UPDATE (section 7) now CLEARS failure_code and
-- failure_recorded_at. A successful finalization is the definitive proof that the
-- earlier failure is resolved, so any classification left by a prior FINALIZATION_
-- FAILED record must not survive. Signature, return type, membership/profile
-- creation, role assignment, sent_at behavior, authorization, service-role posture,
-- locking, idempotency, and the audit guard are all unchanged.
--
-- accept_retailer_owner_invitation() is deliberately NOT changed: it acts only on a
-- finalized invitation (organization_member_id present), and finalize() below
-- already clears the classification before acceptance can run, so acceptance never
-- inherits a stale failure to clear.
create or replace function public.finalize_retailer_owner_invitation(
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

  -- 1. Load and lock the invitation
  select * into v_inv
  from public.retailer_invitations
  where id = p_invitation_id
  for update;

  if v_inv.id is null then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  if v_inv.status <> 'PENDING' then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  if v_inv.expires_at <= now() then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  if v_inv.auth_user_id is not null and v_inv.auth_user_id <> p_auth_user_id then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  v_already_sent := v_inv.sent_at is not null;

  -- 2. Verify the Auth user and its email
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

  -- 3. Re-verify the relationship and Retailer are still active
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

  if v_role_code is distinct from 'RETAILER_OWNER' then
    raise exception 'Invitation could not be finalized'
      using errcode = 'check_violation';
  end if;

  -- 4. Profile — create or safely reuse
  select p.id into v_profile_id
  from public.profiles p
  where p.id = p_auth_user_id;

  if v_profile_id is null then
    insert into public.profiles (id, first_name, last_name, status)
    values (p_auth_user_id, v_inv.first_name, v_inv.last_name, 'INVITED');

    v_profile_id := p_auth_user_id;
  end if;

  -- 5. Membership — INVITED, in the RETAILER organization only
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

  -- 6. Role assignment — RETAILER_OWNER, exactly once
  insert into public.member_roles (organization_member_id, role_id, assigned_by)
  values (v_member_id, v_inv.role_id, v_inv.invited_by_profile_id)
  on conflict (organization_member_id, role_id) do nothing;

  -- 7. Link the invitation to what it produced, record delivery, and CLEAR any
  -- prior failure classification. A successful finalization resolves the earlier
  -- failure, so failure_code / failure_recorded_at are reset here alongside the
  -- delivery record. sent_at is refreshed on every successful dispatch.
  update public.retailer_invitations
  set
    auth_user_id           = p_auth_user_id,
    organization_member_id = v_member_id,
    sent_at                = now(),
    failure_code           = null,
    failure_recorded_at    = null
  where id = v_inv.id;

  -- 8. Audit — in the same transaction as the rows it describes
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

-- Privileges: UNCHANGED. service_role only, matching the original. Re-stated as
-- belt and braces; CREATE OR REPLACE preserves the existing grants.
revoke all     on function public.finalize_retailer_owner_invitation(uuid, uuid) from public;
revoke execute on function public.finalize_retailer_owner_invitation(uuid, uuid) from anon;
revoke execute on function public.finalize_retailer_owner_invitation(uuid, uuid) from authenticated;
grant  execute on function public.finalize_retailer_owner_invitation(uuid, uuid) to service_role;


-- ============================================================================
-- PART 5 — get_vendor_retailer_owner_status()  [DROP + recreate]
-- ============================================================================
-- The return type gains a column (failure_code), which CREATE OR REPLACE cannot do
-- — PostgreSQL forbids changing a function's OUT columns in place. A DROP and
-- recreate is therefore required, and it is safe: no database object depends on
-- this function (its only caller is the application over PostgREST), so the DROP
-- needs no CASCADE and removes nothing else. Both statements run inside this one
-- migration transaction, so the function is never absent to a concurrent caller
-- once the migration commits.
--
-- The merged application tolerates the added column: lib/retailers/
-- owner-status-normalization.ts reads only the seven fields it names and ignores
-- any others (it enforces exactly one ROW, not an exact column set), so surfacing
-- failure_code does not break the currently deployed main branch.
--
-- Everything else is preserved byte-for-byte from migration 20260721150000: the
-- name, the (uuid) input signature, the Vendor authorization chain, the state
-- precedence (ACTIVE > PENDING/DELIVERY_FAILED > EXPIRED > NONE), SECURITY DEFINER,
-- STABLE, empty search_path, the established owner, and the grants (revoke
-- PUBLIC/anon, grant authenticated).
--
-- failure_code is non-null ONLY on the DELIVERY_FAILED branch, and even there only
-- when a classification was recorded — a historical or unclassified incomplete
-- reservation returns DELIVERY_FAILED with a null failure_code. PENDING, EXPIRED,
-- ACTIVE, and NONE always return null failure_code: a settled or successful state
-- carries no delivery-failure reason.
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
  failure_code     text
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
               null::text;
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
             null::text;
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
    if v_inv.organization_member_id is not null and v_inv.sent_at is not null then
      -- Genuinely sent: PENDING, and never a failure reason.
      return query
        select 'PENDING'::text,
               v_inv.first_name, v_inv.last_name, v_inv.email,
               v_inv.sent_at, v_inv.expires_at, null::timestamptz,
               null::text;
    else
      -- Not delivered: DELIVERY_FAILED, carrying the recorded classification when
      -- present. A historical or unclassified incomplete row returns null here.
      return query
        select 'DELIVERY_FAILED'::text,
               v_inv.first_name, v_inv.last_name, v_inv.email,
               v_inv.sent_at, v_inv.expires_at, null::timestamptz,
               v_inv.failure_code;
    end if;
    return;
  end if;

  -- 3. EXPIRED — the newest applicable expired invitation, deterministically.
  -- failure_code is deliberately NOT surfaced for a settled EXPIRED row: expiry is
  -- a lifecycle outcome, not a delivery failure to act on.
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
             null::text;
    return;
  end if;

  -- 4. NONE — no active owner and no invitation state worth displaying
  return query
    select 'NONE'::text,
           null::text, null::text, null::text,
           null::timestamptz, null::timestamptz, null::timestamptz,
           null::text;
  return;
end;
$$;

-- Privileges: restored exactly as before the DROP. A recreated function gets the
-- default PUBLIC EXECUTE, which on a SECURITY DEFINER function reading identity
-- tables is exactly wrong; the revokes remove it and only authenticated is granted.
revoke all     on function public.get_vendor_retailer_owner_status(uuid) from public;
revoke execute on function public.get_vendor_retailer_owner_status(uuid) from anon;
grant  execute on function public.get_vendor_retailer_owner_status(uuid) to authenticated;
