-- Migration: activate_retailer_owner_profile_on_acceptance
-- Purpose: Close the one gap between invitation acceptance and portal access.
--
--          finalize_retailer_owner_invitation() (migration 15) provisions the
--          invitee's profile as status = 'INVITED'. The original
--          accept_retailer_owner_invitation() then activated the MEMBERSHIP
--          (INVITED -> ACTIVE) and marked the invitation ACCEPTED, but never
--          touched profiles.status. The Retailer Owner Portal resolver
--          public.resolve_retailer_owner_organization() (migration 16) requires
--          profiles.status = 'ACTIVE', so a fully-accepted owner was left with an
--          INVITED profile and denied at /retailer.
--
--          This migration REPLACES accept_retailer_owner_invitation() with a
--          version that additionally activates the caller's own profile, in the
--          same transaction, fail-closed. Nothing else about the function
--          changes: same name, no arguments, void return, SECURITY DEFINER,
--          VOLATILE, search_path = '', same owner, same grants, same generic
--          errors, same audit event, same row locking, same eligibility checks.
--
-- WHY CREATE OR REPLACE, NOT A NEW FUNCTION
--   The application (app/invitations/complete/actions.ts) already calls
--   accept_retailer_owner_invitation(). Replacing the body in place keeps that
--   contract intact — no app change is part of this stage — and is why the whole
--   original body is reproduced verbatim below with exactly two additions marked
--   "PROFILE ACTIVATION". The migration is additive: it introduces no table,
--   column, policy, grant surface, role, or permission, and it does not drop the
--   function (which would momentarily remove the grant).
--
-- SCOPE NOTES
--   * No applied migration is edited. Migrations 15 and 16 are immutable and
--     untouched.
--   * No ALTER TABLE, no GRANT on any table, no RLS policy, no new public
--     function, no service-role browser access.
--   * The two portal RPCs and every other invitation function are unchanged.
--
-- Dependencies: migration 1 (profiles + profiles_status_allowed), migration 15
--   (the function being replaced, and the invitation lifecycle it belongs to),
--   migration 16 (the portal resolver whose profiles.status = 'ACTIVE'
--   requirement this satisfies).

-- ============================================================================
-- accept_retailer_owner_invitation()  [REPLACED]
-- ============================================================================
create or replace function public.accept_retailer_owner_invitation()
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
  -- PROFILE ACTIVATION: holds the caller's profile status after the promotion
  -- attempt, so the invariant "the caller has exactly one ACTIVE profile" can be
  -- asserted before the function is allowed to succeed. profiles.id is the
  -- primary key and equals auth.uid(), so a lookup by it returns at most one row;
  -- "exactly one ACTIVE" therefore reduces to "this one row exists and is ACTIVE".
  v_profile_status text;
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
    -- PROFILE ACTIVATION (replay / repair path).
    -- The EXISTS above proves an ACCEPTED invitation is securely bound to THIS
    -- caller (ri.auth_user_id = auth.uid()), which is exactly the condition under
    -- which an INVITED profile may be promoted. This heals an owner who accepted
    -- under the ORIGINAL function — membership and invitation already ACTIVE /
    -- ACCEPTED, but profile still INVITED — the next time acceptance is invoked
    -- for them, without any broad data-repair sweep: the WHERE clause names this
    -- one profile and no other.
    --
    --   INVITED     -> promoted to ACTIVE by the UPDATE, then verified ACTIVE.
    --   ACTIVE      -> UPDATE matches nothing (no-op); the SELECT reads ACTIVE and
    --                  the replay stays idempotently successful.
    --   SUSPENDED / DEACTIVATED / absent -> UPDATE matches nothing; the SELECT
    --                  reads a non-ACTIVE status (or NULL), and the function fails
    --                  closed rather than admitting a retired account.
    update public.profiles
    set status = 'ACTIVE'
    where id = v_user_id
      and status = 'INVITED';

    select p.status into v_profile_status
    from public.profiles p
    where p.id = v_user_id;

    if v_profile_status is distinct from 'ACTIVE' then
      raise exception 'This invitation could not be accepted'
        using errcode = 'insufficient_privilege';
    end if;

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
  -- 4b. Activate the caller's own profile   [PROFILE ACTIVATION — main path]
  -- --------------------------------------------------------------------------
  -- The INVITED -> ACTIVE transition for the profile, the missing half of what
  -- makes an accepted owner satisfy the portal resolver's profiles.status =
  -- 'ACTIVE' requirement. It sits here, after the membership is confirmed ACTIVE
  -- and before the invitation is marked ACCEPTED, so all three moves live in one
  -- transaction: if this step or the audit below fails, PostgreSQL rolls back the
  -- membership activation too, and nothing is left half-done.
  --
  -- Scoped to id = v_user_id, which IS auth.uid() and IS the profile's primary
  -- key, so this can only ever touch the caller's own row — never another user's,
  -- and never more than one row. The `and status = 'INVITED'` filter is what
  -- keeps this a promotion and not a reactivation:
  --
  --   INVITED     -> set ACTIVE (the ordinary new-owner case).
  --   ACTIVE      -> UPDATE matches nothing; the row is already correct. This is
  --                  the existing-account case — a person who already had an
  --                  ACTIVE profile (perhaps a Vendor admin, or an owner of
  --                  another Retailer) accepting a new invitation. Their profile
  --                  is left exactly as it was.
  --   SUSPENDED / DEACTIVATED / absent -> UPDATE matches nothing; the verify below
  --                  reads a non-ACTIVE status (or NULL) and the whole acceptance
  --                  fails closed. A retired or missing account is never
  --                  reactivated as a side effect of accepting an invitation.
  update public.profiles
  set status = 'ACTIVE'
  where id = v_user_id
    and status = 'INVITED';

  -- Verify the invariant before proceeding: exactly one ACTIVE profile for the
  -- caller. A lookup by the primary key returns at most one row, so a single
  -- ACTIVE status here IS "exactly one ACTIVE profile". `is distinct from`
  -- treats a missing profile (NULL) as a failure, not a match.
  select p.status into v_profile_status
  from public.profiles p
  where p.id = v_user_id;

  if v_profile_status is distinct from 'ACTIVE' then
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
  --
  -- The audit event is UNCHANGED from the original: one RETAILER_OWNER_INVITATION_
  -- ACCEPTED row, same columns, same metadata. Profile activation is an internal
  -- state change of the acceptance it already records, not a separate event —
  -- exactly as finalize() created the INVITED profile without a distinct profile
  -- audit entry. Adding a second event, or mutating this record's shape, would be
  -- the "duplicate acceptance audit" the design forbids.
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

-- Privileges. Re-stated verbatim from migration 15 so the final privilege state
-- is guaranteed by THIS migration rather than merely inherited. CREATE OR REPLACE
-- preserves the existing ACL, so these are belt and braces — but a replaced
-- function that silently lost its revokes would be a privilege regression, and
-- restating them is cheap insurance against that. PostgreSQL grants EXECUTE to
-- PUBLIC by default on a newly CREATED function; on a REPLACE the prior ACL is
-- kept, so PUBLIC never regains it here — the revoke keeps that true regardless.
revoke all     on function public.accept_retailer_owner_invitation() from public;
revoke execute on function public.accept_retailer_owner_invitation() from anon;
grant  execute on function public.accept_retailer_owner_invitation() to authenticated;
