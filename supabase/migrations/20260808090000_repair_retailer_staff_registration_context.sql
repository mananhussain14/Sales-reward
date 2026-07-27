-- Migration: repair_retailer_staff_registration_context
-- Purpose: Repairs ONE function and adds TWO, to fix a defect that dead-ends an invited
--          staff member who cannot sign in:
--            1. public.retailer_staff_invitation_gate(text)              [new, internal]
--            2. public.get_retailer_staff_registration_context(text)     [REPAIRED]
--            3. public.resolve_retailer_staff_invitation_recipient(text) [new]
--
-- ============================================================================
-- THE DEFECT
-- ============================================================================
-- The shipped get_retailer_staff_registration_context (migration 20260728090000)
-- classified the invited address with a PRESENCE TEST and nothing more:
--
--     exists (select 1 from auth.users u where lower(btrim(u.email)) = v_inv.email)
--
-- returned as `has_auth_account`, which the application turned into "show ordinary
-- sign-in". Any auth.users row counted, regardless of whether that row can actually be
-- signed in to.
--
-- An address invited earlier through the Retailer Owner NEW_USER flow
-- (auth.admin.inviteUserByEmail, lib/invitations/retailer-owner-invitations.ts) has a
-- row that is UNCONFIRMED and carries NO PASSWORD until that invitation is completed.
-- Invite such an address as staff and the person is offered a sign-in they cannot
-- perform, while the activation form that would let them set a password is never shown.
-- There is no supported way out of that screen. That is the bug.
--
-- ============================================================================
-- WHY THE OBVIOUS FIX IS UNSAFE, AND WHAT THIS MIGRATION DOES INSTEAD
-- ============================================================================
-- The tempting repair is "if it cannot sign in, let the staff invitation set the first
-- password". That is WRONG, and the reason is public.finalize_retailer_owner_invitation
-- (migration 20260720092755): immediately after inviteUserByEmail it creates a
-- public.profiles row, an INVITED public.organization_members row, and a RETAILER_OWNER
-- public.member_roles assignment — all bound to that unconfirmed, password-less auth
-- user. A stranded invited row is therefore NOT an empty shell; in the owner case it is
-- a pre-provisioned Retailer Owner identity waiting to be claimed.
--
-- Letting a STAFF invitation token set the first password on such a row would let
-- whoever holds that token take over that identity, and then accept the still-live
-- OWNER invitation. It would convert the invitation token from a DISCOVERY POINTER
-- (which is inert on its own, because acceptance separately requires a confirmed
-- session whose email matches) into an account CREDENTIAL. That property is relied on
-- throughout this codebase and must not be given up.
--
-- So this function distinguishes FIVE states instead of two, and the dangerous case
-- gets its own: RECOVERY_REQUIRED, which the application answers with an emailed
-- password-recovery link. Recovery proves CURRENT control of the invited inbox, which a
-- possibly-old invitation token does not.
--
-- ============================================================================
-- WHAT IS RETURNED, AND WHAT IS NOT
-- ============================================================================
-- The classification function returns ONLY `account_state` and `expires_at`. It no
-- longer returns the invited email at all — the address is now resolved by a SEPARATE
-- function (3) that exists solely for the two operations that must act on the mailbox,
-- so the page's path cannot carry an address even by accident.
--
-- Neither function returns: an auth user id, any password or encrypted-password
-- information, a profile id, a membership id, an organization id, a role id, a token, or
-- a token hash. The classification reads all of those and discloses none of them: the
-- entire disclosure is one of five fixed words.
--
-- Both are service_role ONLY, for the same reason the original was: (3) maps a token to
-- an email, and (2) tells the holder of a token something about an account. Neither may
-- ever be reachable by a browser role.
--
-- ============================================================================
-- FAIL-SAFE DIRECTION
-- ============================================================================
-- Uncertainty resolves toward SIGN_IN or ACCOUNT_BLOCKED, never toward
-- ACTIVATION_REQUIRED. Misclassifying a usable or provisioned identity as "safe
-- first-time activation" is an account takeover; misclassifying a shell as "sign in" is
-- merely the inconvenience this migration exists to fix. Ambiguity (more than one
-- auth.users row for the address) is ACCOUNT_BLOCKED rather than a guess.
--
-- ONE GENERIC FAILURE, PRESERVED
--   Unknown, malformed, expired, revoked, accepted, terminal and foreign tokens — and an
--   invitation whose Retailer, role or intended shops have since become invalid — all
--   raise the SAME message and SQLSTATE, exactly as before.
--
-- READ-ONLY, AND SILENT. All three are STABLE, contain no INSERT/UPDATE/DELETE, and
--   write no audit event. Acceptance is what gets audited, and it already is.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No table, column, constraint, index, trigger, policy, role, permission or mapping is
--   created or altered. No OTHER function is touched — in particular
--   accept_retailer_staff_invitation, get_retailer_staff_invitation_for_recipient,
--   reserve/prepare/record and the owner invitation functions are all unchanged. It
--   creates no Auth user and sets no password: that is Supabase Auth's job.
--
-- Idempotency posture: an explicit DROP of the function this migration repairs, then
--   plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE). The DROP is required
--   because the return TYPE changes, which CREATE OR REPLACE cannot do. A conflicting
--   existing object for the two NEW functions FAILS the migration. No dynamic SQL. Every
--   reference is schema-qualified because all three run with an EMPTY search_path.
--
-- Dependencies: 20260716124419 (profiles, organization_members), 20260716125559
--   (member_roles, roles), 20260717094520 (retailer_shops), 20260723090000
--   (retailer_staff_invitations, retailer_invitation_shop_assignments), 20260728090000
--   (the function this repairs).

-- ============================================================================
-- Remove the defective function
-- ============================================================================
-- Its return type changes (has_auth_account boolean + invited_email are both gone), so
-- it must be dropped rather than replaced. Nothing else depends on it in SQL — its only
-- caller is application code, which is updated in the same change.
drop function public.get_retailer_staff_registration_context(text);

-- ============================================================================
-- FUNCTION 1 — retailer_staff_invitation_gate(text)  [INTERNAL]
-- ============================================================================
-- The shared validity gate. Returns the invitation row's id for a live, valid,
-- still-actionable invitation, and raises the single generic exception otherwise.
--
-- Factored out so functions 2 and 3 cannot drift: if the classification said "activate"
-- for an invitation that recipient-resolution would refuse, the application would create
-- an account for an invitation that acceptance then rejects.
--
-- SECURITY INVOKER (the default), deliberately. It is called only from inside the two
-- SECURITY DEFINER functions below, where the effective user is already this function's
-- owner, so it needs no elevation of its own. EXECUTE is revoked from every role
-- including service_role, so it is not directly callable — the owner retains the
-- privilege implicitly, which is all the two callers need.
--
-- The preconditions are the SAME set get_retailer_staff_invitation_for_recipient
-- applies, minus the identity checks that cannot apply before an account exists.
create function public.retailer_staff_invitation_gate(
  p_token_hash text
)
returns uuid
language plpgsql
stable
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

  -- 1. The live token. token_hash is UNIQUE where not null, so this matches at most one
  --    row. The status / expiry / revoked / accepted filters are stated explicitly.
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

  -- 2. The Retailer must still be a live Retailer.
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

  -- 3. The target role must still be an active staff role. RETAILER_OWNER and every
  --    Vendor role are absent from the allow-set, so this path can never activate or
  --    recover an account against one.
  select r.code into v_role_code
  from public.roles r
  where r.id = v_inv.role_id
    and r.status = 'ACTIVE'
    and r.code in ('RETAILER_MANAGER', 'SALES_STAFF');

  if v_role_code is null then
    raise exception 'This invitation is not available'
      using errcode = 'check_violation';
  end if;

  -- 4. The intended shops must still be valid. Counting the total and the valid subset
  --    separately distinguishes "an intended shop was deactivated or moved" from "there
  --    were none to begin with".
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

  return v_inv.id;
end;
$$;

revoke all     on function public.retailer_staff_invitation_gate(text) from public;
revoke execute on function public.retailer_staff_invitation_gate(text) from anon;
revoke execute on function public.retailer_staff_invitation_gate(text) from authenticated;
revoke execute on function public.retailer_staff_invitation_gate(text) from service_role;

-- ============================================================================
-- FUNCTION 2 — get_retailer_staff_registration_context(text)  [REPAIRED]
-- ============================================================================
-- Classifies the invited address into exactly one of five states, and returns that word
-- and the invitation's expiry. NOTHING ELSE.
--
--   NO_ACCOUNT           no auth.users row for the invited address.
--                        -> create the account with the first-password activation flow.
--
--   ACTIVATION_REQUIRED  a row exists, cannot sign in, has NO password, and carries NO
--                        provisioned identity (no profile, no membership, no role
--                        assignment).
--                        -> first-password activation is safe: the row is an empty
--                           shell, so setting its first password is equivalent to
--                           creating the account.
--
--   SIGN_IN              the address has a CONFIRMED, password-capable, non-blocked
--                        account.
--                        -> ordinary sign-in.
--
--   RECOVERY_REQUIRED    the account cannot currently sign in, but it already carries a
--                        password or a provisioned identity.
--                        -> send an emailed password-recovery link. NEVER set the
--                           password from the invitation token; see the header.
--
--   ACCOUNT_BLOCKED      banned, soft-deleted, or ambiguous (more than one auth.users
--                        row for the address).
--                        -> neutral support message; the reason is never disclosed.
create function public.get_retailer_staff_registration_context(
  p_token_hash text
)
returns table (
  account_state text,
  expires_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_invitation_id  uuid;
  v_email          text;
  v_expires_at     timestamptz;
  v_match_count    integer;
  v_user_id        uuid;
  v_confirmed      boolean;
  v_has_password   boolean;
  v_blocked        boolean;
  v_provisioned    boolean;
  v_state          text;
begin
  -- The shared gate raises the single generic exception for every unusable invitation.
  v_invitation_id := public.retailer_staff_invitation_gate(p_token_hash);

  select ri.email, ri.expires_at
    into v_email, v_expires_at
  from public.retailer_staff_invitations ri
  where ri.id = v_invitation_id;

  -- --------------------------------------------------------------------------
  -- Classify the Auth account for that address
  -- --------------------------------------------------------------------------
  -- The invitation's email is already canonical (lower + trimmed) by
  -- retailer_staff_invitations_email_canonical, so the comparison is against the same
  -- string acceptance will later require the confirmed Auth email to equal.
  select count(*) into v_match_count
  from auth.users u
  where lower(btrim(u.email)) = v_email;

  if v_match_count = 0 then
    v_state := 'NO_ACCOUNT';

  elsif v_match_count > 1 then
    -- Ambiguous. Two rows for one address means the app cannot know which identity a
    -- password would be set on, so it sets none. Fail-safe, not a guess.
    v_state := 'ACCOUNT_BLOCKED';

  else
    select
      u.id,
      u.email_confirmed_at is not null,
      -- The ONLY thing read about the password is whether one exists. The value is
      -- never selected into a returnable column, never compared, and never disclosed;
      -- GoTrue writes '' rather than NULL in some versions, so both are handled.
      coalesce(u.encrypted_password, '') <> '',
      (u.banned_until is not null and u.banned_until > now())
        or u.deleted_at is not null
        or coalesce(u.is_anonymous, false)
      into v_user_id, v_confirmed, v_has_password, v_blocked
    from auth.users u
    where lower(btrim(u.email)) = v_email;

    if v_blocked then
      v_state := 'ACCOUNT_BLOCKED';

    elsif v_confirmed and v_has_password then
      -- The only state that can actually sign in today.
      v_state := 'SIGN_IN';

    else
      -- Cannot sign in. Whether first-password activation is SAFE depends entirely on
      -- whether this auth row already stands for a provisioned identity.
      --
      -- profiles, organization_members and member_roles are checked because
      -- finalize_retailer_owner_invitation creates all three before the person has ever
      -- confirmed or set a password. Any one of them means the row is somebody's
      -- half-built account, not an empty shell.
      select
        exists (select 1 from public.profiles p where p.id = v_user_id)
        or exists (
          select 1 from public.organization_members m where m.user_id = v_user_id
        )
        or exists (
          select 1
          from public.member_roles mr
          join public.organization_members m2 on m2.id = mr.organization_member_id
          where m2.user_id = v_user_id
        )
        into v_provisioned;

      -- ACTIVATION_REQUIRED is the NARROWEST possible definition of "empty shell":
      -- unconfirmed AND password-less AND unprovisioned. Everything else that cannot
      -- sign in is RECOVERY_REQUIRED, because each of the remaining shapes is evidence
      -- that the row is not untouched:
      --
      --   * a password exists — setup was completed once, so overwriting it from an
      --     invitation token is the same takeover risk;
      --   * the address is CONFIRMED — somebody proved control of that mailbox at some
      --     point, and a confirmed password-less row is what a magic-link or
      --     OAuth-style identity looks like. Neither is used by this application today,
      --     which is exactly why classifying one is a guess, and the instruction is to
      --     fail safe rather than guess;
      --   * a profile, membership or role assignment exists.
      --
      -- Recovery still unblocks every one of these people; it just proves CURRENT
      -- control of the mailbox first, which the invitation token cannot.
      if v_provisioned or v_has_password or v_confirmed then
        v_state := 'RECOVERY_REQUIRED';
      else
        v_state := 'ACTIVATION_REQUIRED';
      end if;
    end if;
  end if;

  return query select v_state, v_expires_at;
end;
$$;

revoke all     on function public.get_retailer_staff_registration_context(text) from public;
revoke execute on function public.get_retailer_staff_registration_context(text) from anon;
revoke execute on function public.get_retailer_staff_registration_context(text) from authenticated;
grant  execute on function public.get_retailer_staff_registration_context(text) to service_role;

-- ============================================================================
-- FUNCTION 3 — resolve_retailer_staff_invitation_recipient(text)
-- ============================================================================
-- The invitation's canonical address, and nothing else.
--
-- Split out from the classification deliberately. Two operations genuinely need the
-- mailbox — creating the account for NO_ACCOUNT / ACTIVATION_REQUIRED, and sending the
-- recovery email for RECOVERY_REQUIRED — and both are server-only. Every OTHER caller,
-- including the page that decides which screen to render, now uses function 2 and
-- cannot obtain an address at all. That is a narrowing: the previous design returned the
-- email to every caller of the context lookup.
--
-- The address is the ONLY address an account may be created for, or a recovery email
-- sent to, on this path. No parameter carries an address, so no caller can nominate one.
create function public.resolve_retailer_staff_invitation_recipient(
  p_token_hash text
)
returns table (
  invited_email text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_invitation_id uuid;
begin
  -- The SAME gate, so an address is resolvable exactly when the invitation is live and
  -- valid. There is no path that yields an address for an invitation the classification
  -- would have refused.
  v_invitation_id := public.retailer_staff_invitation_gate(p_token_hash);

  return query
  select ri.email
  from public.retailer_staff_invitations ri
  where ri.id = v_invitation_id;
end;
$$;

revoke all     on function public.resolve_retailer_staff_invitation_recipient(text) from public;
revoke execute on function public.resolve_retailer_staff_invitation_recipient(text) from anon;
revoke execute on function public.resolve_retailer_staff_invitation_recipient(text) from authenticated;
grant  execute on function public.resolve_retailer_staff_invitation_recipient(text) to service_role;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One function repaired and two added; nothing else exists in this migration. All three
-- read, none writes, none audits, and none is reachable by a browser role. No table,
-- column, constraint, index, trigger, policy, role, permission or mapping is created or
-- altered, and no other existing function is touched. No Auth user is created and no
-- password is set or read here — only the EXISTENCE of a password is inspected, and even
-- that is never returned.
