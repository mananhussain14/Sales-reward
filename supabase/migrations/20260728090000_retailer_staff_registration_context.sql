-- Migration: retailer_staff_registration_context
-- Purpose: Adds exactly ONE function and nothing else:
--            public.get_retailer_staff_registration_context(text)
--          the server-only lookup that turns an invitation token hash into the
--          CANONICAL INVITED EMAIL, so an invited staff member can activate their
--          account by choosing a password alone.
--
-- WHY IT IS NEEDED — the gap it closes
--   public.get_retailer_staff_invitation_for_recipient (migration 20260724210000)
--   deliberately requires auth.uid() and a CONFIRMED Auth email that already matches
--   the invitation. That is exactly right for a signed-in recipient, and exactly wrong
--   for someone who has no account yet: they cannot sign in, so they can never reach
--   it, and the activation form would have to ask them to type the invited address —
--   which is both a worse experience and a way to probe which addresses were invited.
--
--   This function answers the one question the activation page needs BEFORE any account
--   exists: "for this token, what address should the account be created for, and does
--   one already exist?" It answers it to the SERVER ONLY.
--
-- WHY service_role ONLY, AND WHY THAT IS THE WHOLE SECURITY MODEL
--   This function maps a token to an email address. Reachable by anon or authenticated,
--   it would let anyone holding (or guessing at) a token learn who was invited, and it
--   would turn the browser into the thing deciding which address an account is created
--   for. It is therefore granted to service_role and stripped from every other role,
--   and its result is consumed only by server-side code that immediately uses the email
--   to call Supabase Auth. The email never reaches a Client Component, a prop, an RSC
--   payload, a URL, a log line, or an error message.
--
-- READ-ONLY, AND SILENT
--   STABLE, and it contains no INSERT, UPDATE or DELETE. It writes no audit event
--   either: looking up an invitation in order to render a form is not an action anyone
--   took against the invitation, and an audit row per page render would drown the
--   events that matter. Acceptance is what gets audited, and it already is.
--
-- ONE GENERIC FAILURE
--   Unknown, malformed, expired, revoked, accepted, terminal and stale tokens — and an
--   invitation whose Retailer, role or intended shops have since become invalid — all
--   raise the SAME message and SQLSTATE. The caller cannot tell them apart, so the
--   activation page cannot either, and its "this invitation is not available" screen is
--   byte-identical in every case.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No table, column, constraint, index, trigger, policy, role, permission or mapping
--   is created or altered. No existing function is touched. It mutates nothing, audits
--   nothing, and grants nothing to any browser role. It does not create Auth users —
--   that is Supabase Auth's job, called by the application with the email this returns.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE).
--   A conflicting existing object FAILS the migration. No dynamic SQL. The identifier
--   is 38 bytes. Every reference is schema-qualified because the function runs with an
--   EMPTY search_path.
--
-- Dependencies: 20260716124419 (organizations), 20260716125559 (roles),
--   20260717094520 (retailer_shops), 20260723090000 (retailer_staff_invitations,
--   retailer_invitation_shop_assignments).

-- ============================================================================
-- FUNCTION — get_retailer_staff_registration_context(text)
-- ============================================================================
-- Returns exactly one row for a live, valid invitation, and raises otherwise.
--
--   invited_email      the invitation's own canonical address. The ONLY address an
--                      account may be created for on this path.
--   has_auth_account   whether that address already has a Supabase Auth user. The
--                      activation page branches on this: false -> offer password
--                      creation; true -> offer sign-in instead.
--   expires_at         the invitation's expiry, for the server's own messaging.
--
-- The preconditions below are the SAME set get_retailer_staff_invitation_for_recipient
-- applies, minus the identity checks it makes that cannot apply before an account
-- exists. Keeping them aligned is what stops this function offering activation for an
-- invitation that acceptance would then refuse.
create function public.get_retailer_staff_registration_context(
  p_token_hash text
)
returns table (
  invited_email    text,
  has_auth_account boolean,
  expires_at       timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv        public.retailer_staff_invitations%rowtype;
  v_role_code  text;
  v_shop_total integer;
  v_shop_valid integer;
begin
  -- Shape-validate the hash. A malformed value can never match a stored hash, so it
  -- exits on the same generic path as a wrong one.
  if p_token_hash is null or p_token_hash collate "C" !~ '^[0-9a-f]{64}$' then
    raise exception 'This invitation is not available'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 1. The live token
  -- --------------------------------------------------------------------------
  -- token_hash is UNIQUE where not null, so this matches at most one row. The status /
  -- expiry / revoked / accepted filters are all stated explicitly even though the
  -- storage constraints already imply most of them: a terminal invitation has its token
  -- cleared, so this lookup cannot see one, and asserting it anyway costs nothing and
  -- survives any future relaxation of those constraints.
  select * into v_inv
  from public.retailer_staff_invitations ri
  where ri.token_hash = p_token_hash
    and ri.status = 'PENDING'
    and ri.expires_at > now()
    and ri.revoked_at is null
    and ri.accepted_at is null;

  if v_inv.id is null then
    raise exception 'This invitation is not available'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. The Retailer must still be a live Retailer
  -- --------------------------------------------------------------------------
  if not exists (
    select 1
    from public.organizations o
    where o.id = v_inv.retailer_organization_id
      and o.organization_type = 'RETAILER'
      and o.status = 'ACTIVE'
  ) then
    raise exception 'This invitation is not available'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. The target role must still be an active staff role
  -- --------------------------------------------------------------------------
  -- RETAILER_OWNER and every Vendor role are absent from the allow-set, so this path
  -- can never activate an account against one.
  select r.code into v_role_code
  from public.roles r
  where r.id = v_inv.role_id
    and r.status = 'ACTIVE'
    and r.code in ('RETAILER_MANAGER', 'SALES_STAFF');

  if v_role_code is null then
    raise exception 'This invitation is not available'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. The intended shops must still be valid
  -- --------------------------------------------------------------------------
  -- Counting the total and the valid subset separately is what distinguishes "an
  -- intended shop was deactivated or moved" from "there were none to begin with".
  -- Offering activation for an invitation whose shops have gone stale would produce an
  -- account that acceptance then refuses.
  select count(*) into v_shop_total
  from public.retailer_invitation_shop_assignments sa
  where sa.retailer_staff_invitation_id = v_inv.id;

  select count(*) into v_shop_valid
  from public.retailer_invitation_shop_assignments sa
  join public.retailer_shops s on s.id = sa.retailer_shop_id
  where sa.retailer_staff_invitation_id = v_inv.id
    and s.retailer_organization_id = v_inv.retailer_organization_id
    and s.status = 'ACTIVE';

  if v_shop_valid <> v_shop_total then
    raise exception 'This invitation is not available'
      using errcode = 'check_violation';
  end if;

  if v_role_code = 'SALES_STAFF' and v_shop_total < 1 then
    raise exception 'This invitation is not available'
      using errcode = 'check_violation';
  end if;

  if v_role_code = 'RETAILER_MANAGER' and v_shop_total <> 0 then
    raise exception 'This invitation is not available'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. The server-only answer
  -- --------------------------------------------------------------------------
  -- The email is the invitation's OWN canonical address — already lower-cased and
  -- trimmed by retailer_staff_invitations_email_canonical — so the comparison below and
  -- the value returned are the same string the acceptance RPC will later require the
  -- confirmed Auth email to equal.
  --
  -- No role code, Retailer name, shop list, invitation id, invited-by profile id or
  -- token material is returned. The activation page needs none of them: it renders two
  -- password fields, and everything else is shown only after the person has signed in
  -- and the authenticated recipient RPC has verified them.
  return query
  select
    v_inv.email,
    exists (
      select 1
      from auth.users u
      where lower(btrim(u.email)) = v_inv.email
    ),
    v_inv.expires_at;
end;
$$;

revoke all     on function public.get_retailer_staff_registration_context(text) from public;
revoke execute on function public.get_retailer_staff_registration_context(text) from anon;
revoke execute on function public.get_retailer_staff_registration_context(text) from authenticated;
grant  execute on function public.get_retailer_staff_registration_context(text) to service_role;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One function added; nothing else exists in this migration. It reads, it never writes,
-- it audits nothing, and it is reachable only by service_role. No table, column,
-- constraint, index, trigger, policy, role, permission or mapping is created or
-- altered, and no existing function is touched.
