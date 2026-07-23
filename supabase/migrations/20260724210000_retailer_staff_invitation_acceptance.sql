-- Migration: retailer_staff_invitation_acceptance
-- Purpose: The RECIPIENT half of the Retailer staff invitation domain, plus the safe
--          staff roster read. Adds exactly THREE functions and nothing else:
--            1. get_retailer_staff_invitation_for_recipient(text)
--                 — signed-in recipient resolution of a token hash to safe display
--                   fields, and only after a verified-email match.
--            2. accept_retailer_staff_invitation(text)
--                 — the atomic acceptance: profile, ACTIVE membership, exactly one
--                   member-role edge, the immutable intended-shop set for Sales Staff,
--                   invitation finalization, and one safe audit event.
--            3. list_retailer_staff_members()
--                 — the read-only staff roster for RETAILER_STAFF_READ holders.
--
-- WHERE THIS SITS
--   Migration 20260723090000 created the storage (retailer_staff_invitations,
--   retailer_invitation_shop_assignments) and the authorization resolver
--   public.resolve_retailer_member_organization(text). Migration 20260723210000 added
--   the OWNER operations (reserve / revoke / list / expire). Migration 20260724090000
--   added the SERVICE-ROLE delivery operations (prepare / record sent / record
--   failure). This migration adds the RECIPIENT operations and the roster, completing
--   the backend lifecycle. It touches no existing object.
--
-- THE TOKEN MODEL (unchanged)
--   The application generates a raw token, hashes it (SHA-256, lowercase hex), and
--   stores only the HASH via prepare_retailer_staff_invitation. The raw token exists
--   only in the recipient's emailed URL. Both functions here accept the
--   APPLICATION-COMPUTED hash and never the raw token; no raw token is stored, logged,
--   returned, or audited by anything in this migration.
--
-- THE BINDING RULE
--   A token alone never identifies a person. Resolution and acceptance BOTH require
--   that the signed-in Auth user has a CONFIRMED email and that this email equals the
--   invitation's canonical email exactly. The token says WHICH invitation; the session
--   says WHO; only a verified match may see anything or accept anything. A correct
--   token presented by the wrong signed-in account is indistinguishable, in the
--   response, from a token that never existed.
--
-- GENERIC FAILURE, DELIBERATELY
--   Unknown, malformed, expired, terminal (ACCEPTED / EXPIRED / REVOKED), revoked,
--   already-accepted, wrong-account and token-mismatch all produce the SAME outcome:
--   zero rows from resolution, one identical exception from acceptance. Distinguishing
--   them would let any signed-in caller probe for the existence and state of an
--   invitation record they have no right to enumerate.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No table, column, constraint, index, trigger, policy, role, permission or
--   role-permission mapping is created, altered or dropped. No owner, delivery,
--   portal, or storage function is modified. No table privilege is granted to any
--   browser role — direct browser writes to profiles, organization_members,
--   member_roles, retailer_shop_members, retailer_staff_invitations and
--   retailer_invitation_shop_assignments stay denied exactly as they were. No page, no
--   React component, no Server Action, no Resend call, no email template, no feature
--   flag, no application code at all. No staff deactivate / reactivate / role-change /
--   shop-change operation: Retailer Managers remain strictly read-only, and this
--   milestone adds no staff mutation beyond acceptance itself.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE).
--   A conflicting existing object FAILS the migration. No fixed UUIDs. No dynamic SQL.
--   All identifiers are <= 63 bytes. Every reference is schema-qualified because every
--   function runs with an EMPTY search_path.
--
-- Dependencies: 20260716124419 (profiles, organizations, organization_members,
--   member_roles), 20260716125559 (roles, permissions, role_permissions),
--   20260716130351 (audit_logs), 20260717094520 (retailer_shops,
--   retailer_shop_members, vendor_retailers), 20260722210000 (RETAILER_MANAGER /
--   SALES_STAFF roles and the RETAILER_STAFF_READ / RETAILER_STAFF_MANAGE mappings),
--   20260723090000 (staff invitation storage + resolve_retailer_member_organization),
--   20260723210000 and 20260724090000 (owner and delivery operations, unchanged here).

-- ============================================================================
-- FUNCTION 1 — get_retailer_staff_invitation_for_recipient(text)
-- ============================================================================
-- Resolves an application-computed token hash to the safe display fields the
-- acceptance page needs, and ONLY after the signed-in Auth user's confirmed email
-- matches the invitation's canonical email exactly.
--
-- Returns ZERO ROWS — never an error, never a partial row, never a "wrong account"
-- marker — for every unavailable case. A caller therefore learns exactly one bit:
-- "there is an invitation here that is yours and live", or nothing.
--
-- Returned: invitation id, recipient first/last name, canonical email, Retailer name,
-- target role code and display name, the intended ACTIVE shop names for Sales Staff,
-- and the expiry timestamp.
--
-- NOT returned, at any point: the token hash, the Auth user id, the membership id, the
-- internal role UUID, the invited-by profile id, shop UUIDs, delivery/failure state,
-- audit information, or any other Retailer's data. The Retailer is read from the
-- invitation row the token resolved, so a caller can never steer it.
create function public.get_retailer_staff_invitation_for_recipient(
  p_token_hash text
)
returns table (
  invitation_id uuid,
  first_name    text,
  last_name     text,
  email         text,
  retailer_name text,
  role_code     text,
  role_name     text,
  shop_names    text[],
  expires_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid           uuid;
  v_inv           public.retailer_staff_invitations%rowtype;
  v_auth_email    text;
  v_confirmed     timestamptz;
  v_retailer_name text;
  v_role_code     text;
  v_role_name     text;
  v_shop_names    text[];
  v_shop_total    integer;
  v_shop_valid    integer;
begin
  -- Identity comes from the JWT and nowhere else.
  v_uid := auth.uid();
  if v_uid is null then
    return;  -- zero rows
  end if;

  -- Shape-validate the hash here as well as at the column. A malformed value can
  -- never match a stored hash, so it exits on the same generic path as a wrong one.
  if p_token_hash is null or p_token_hash collate "C" !~ '^[0-9a-f]{64}$' then
    return;  -- zero rows
  end if;

  -- --------------------------------------------------------------------------
  -- 1. Resolve the live token
  -- --------------------------------------------------------------------------
  -- token_hash is UNIQUE where not null, so this matches at most one row. The status /
  -- expiry / revoked / accepted filters are all stated explicitly even though the
  -- storage constraints already imply most of them: a terminal invitation has its
  -- token cleared, so this lookup cannot see one, and asserting it anyway costs
  -- nothing and survives any future relaxation of those constraints.
  select * into v_inv
  from public.retailer_staff_invitations ri
  where ri.token_hash = p_token_hash
    and ri.status = 'PENDING'
    and ri.expires_at > now()
    and ri.revoked_at is null
    and ri.accepted_at is null;

  if v_inv.id is null then
    return;  -- unknown / expired / terminal / revoked / accepted — all identical
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Verified-email binding — nothing is revealed before this succeeds
  -- --------------------------------------------------------------------------
  -- An unconfirmed email, a missing Auth row, and a signed-in account whose address
  -- differs from the invitation's all land here, and all return zero rows — the same
  -- result as an invitation that does not exist. Comparison is against the canonical
  -- form (lower + trim) that the invitation's own email constraint already guarantees.
  select lower(btrim(u.email)), u.email_confirmed_at
    into v_auth_email, v_confirmed
  from auth.users u
  where u.id = v_uid;

  if v_confirmed is null
     or v_auth_email is null
     or v_auth_email <> v_inv.email then
    return;  -- zero rows
  end if;

  -- --------------------------------------------------------------------------
  -- 3. The Retailer must still be a live Retailer
  -- --------------------------------------------------------------------------
  select o.name into v_retailer_name
  from public.organizations o
  where o.id = v_inv.retailer_organization_id
    and o.organization_type = 'RETAILER'
    and o.status = 'ACTIVE';

  if v_retailer_name is null then
    return;  -- zero rows
  end if;

  -- --------------------------------------------------------------------------
  -- 4. The target role must still be an active staff role
  -- --------------------------------------------------------------------------
  -- Restated here rather than trusted from reservation time: hours may have passed and
  -- a role may have been retired. RETAILER_OWNER and every Vendor role are absent from
  -- the allow-set, so a staff invitation can never resolve onto one.
  select r.code, r.name into v_role_code, v_role_name
  from public.roles r
  where r.id = v_inv.role_id
    and r.status = 'ACTIVE'
    and r.code in ('RETAILER_MANAGER', 'SALES_STAFF');

  if v_role_code is null then
    return;  -- zero rows
  end if;

  -- --------------------------------------------------------------------------
  -- 5. The intended shops must still be valid
  -- --------------------------------------------------------------------------
  -- The page must not offer an acceptance that acceptance itself would refuse, so the
  -- same shop rules are evaluated here: every intended shop must still be ACTIVE and
  -- still belong to the invitation's Retailer, a Sales Staff invitation must have at
  -- least one, and a Manager invitation must have none. Counting the total and the
  -- valid subset separately is what distinguishes "an intended shop was deactivated or
  -- moved" from "there were none to begin with".
  --
  -- Only NAMES are returned. Shop UUIDs are internal identifiers the acceptance page
  -- has no use for; the immutable set on the invitation is the only thing acceptance
  -- ever copies, and it is read from the invitation, never from the caller.
  select count(*) into v_shop_total
  from public.retailer_invitation_shop_assignments sa
  where sa.retailer_staff_invitation_id = v_inv.id;

  select count(*), coalesce(array_agg(s.name order by s.name, s.id), '{}'::text[])
    into v_shop_valid, v_shop_names
  from public.retailer_invitation_shop_assignments sa
  join public.retailer_shops s on s.id = sa.retailer_shop_id
  where sa.retailer_staff_invitation_id = v_inv.id
    and s.retailer_organization_id = v_inv.retailer_organization_id
    and s.status = 'ACTIVE';

  if v_shop_valid <> v_shop_total then
    return;  -- an intended shop is no longer ACTIVE or no longer this Retailer's
  end if;

  if v_role_code = 'SALES_STAFF' and v_shop_total < 1 then
    return;  -- a Sales Staff invitation with no shops can never be accepted
  end if;

  if v_role_code = 'RETAILER_MANAGER' and v_shop_total <> 0 then
    return;  -- a Manager invitation must carry no shops
  end if;

  -- --------------------------------------------------------------------------
  -- 6. Safe display payload
  -- --------------------------------------------------------------------------
  -- The email echoed back is the invitation's own canonical address, which step 2 just
  -- proved equals the caller's own verified address. It tells the recipient nothing
  -- they do not already know about themselves.
  --
  -- Membership eligibility (no existing membership in this Retailer, profile not
  -- retired) is deliberately NOT evaluated here. Those are facts about the CALLER's
  -- account rather than about the invitation, acceptance re-checks every one of them
  -- under a lock, and the scope for this milestone fixes the resolution preconditions
  -- exactly as implemented above. Resolution stays a question about the invitation.
  return query select
    v_inv.id,
    v_inv.first_name,
    v_inv.last_name,
    v_inv.email,
    v_retailer_name,
    v_role_code,
    v_role_name,
    coalesce(v_shop_names, '{}'::text[]),
    v_inv.expires_at;
end;
$$;

revoke all     on function public.get_retailer_staff_invitation_for_recipient(text) from public;
revoke execute on function public.get_retailer_staff_invitation_for_recipient(text) from anon;
grant  execute on function public.get_retailer_staff_invitation_for_recipient(text) to authenticated;

-- ============================================================================
-- FUNCTION 2 — accept_retailer_staff_invitation(text)
-- ============================================================================
-- The one atomic transition from "invited" to "staff member". Either every one of the
-- profile row, the ACTIVE membership, the single member-role edge, the Sales Staff
-- shop rows, the invitation finalization and the audit event exists when this returns,
-- or none of them does. There is no partial state: PostgreSQL rolls the whole function
-- back on any exception, and every refusal below IS an exception.
--
-- LOCKING ORDER (fixed, and the same on every path)
--   1. the invitation           FOR UPDATE
--   2. recipient profile / membership checks
--   3. Retailer and target role validation
--   4. intended shops           FOR SHARE, in ascending UUID order
--   5. membership creation
--   6. member-role creation
--   7. retailer-shop membership creation
--   8. invitation finalization
--   9. audit insertion
--
-- CONCURRENCY
--   Two simultaneous acceptances of the same token serialize on step 1. The winner
--   commits with status ACCEPTED and token_hash NULL; the loser's FOR UPDATE re-checks
--   its `token_hash = $1 and status = 'PENDING'` predicate against the updated row
--   under READ COMMITTED, matches nothing, and fails generically having written
--   nothing. Exactly one complete acceptance, no duplicate membership / role / shop
--   rows, no partial rows from the loser.
--
--   The unique constraints are the FINAL authorities and are relied on as such rather
--   than as backstops that should never fire: organization_members_unique_membership
--   (one membership per person per organization), member_roles_pkey (one edge per
--   membership+role), and retailer_shop_members_live_unique_idx (one live assignment
--   per membership+shop). Each is caught below and reported on the same generic path.
create function public.accept_retailer_staff_invitation(
  p_token_hash text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid            uuid;
  v_inv            public.retailer_staff_invitations%rowtype;
  v_auth_email     text;
  v_confirmed      timestamptz;
  v_profile_status text;
  v_retailer_name  text;
  v_role_code      text;
  v_member_id      uuid;
  v_member_status  text;
  v_shop_ids       uuid[];
  v_shop_count     integer;
  v_shop_valid     integer;
  v_shop_id        uuid;
  v_finalized      integer;
begin
  -- Identity comes from the JWT and nowhere else.
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  if p_token_hash is null or p_token_hash collate "C" !~ '^[0-9a-f]{64}$' then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 1. Lock the live invitation
  -- --------------------------------------------------------------------------
  select * into v_inv
  from public.retailer_staff_invitations
  where token_hash = p_token_hash
    and status = 'PENDING'
  for update;

  -- ONE message for every refusal in this function, and deliberately so. Unknown
  -- token, malformed token, stale token from a superseded prepare, expired, revoked,
  -- already-accepted, wrong signed-in account, unverified email, retired profile, an
  -- existing membership, a deactivated shop — all identical. Any distinction here
  -- would be an oracle over records the caller may not enumerate.
  if v_inv.id is null then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- Expiry is evaluated against expires_at directly, not against the stored status, so
  -- a lapsed invitation that no sweep has reached yet is still refused. Correctness
  -- does not depend on any scheduled job. revoked_at / accepted_at are belt and braces
  -- over the PENDING filter.
  if v_inv.expires_at <= now()
     or v_inv.revoked_at is not null
     or v_inv.accepted_at is not null then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. Recipient — verified email, then profile and membership eligibility
  -- --------------------------------------------------------------------------
  -- Re-verified INSIDE acceptance rather than inherited from resolution. Resolution is
  -- a separate, earlier, unauthenticated-with-respect-to-this-transaction request; the
  -- only checks that protect this write are the ones this function performs itself.
  select lower(btrim(u.email)), u.email_confirmed_at
    into v_auth_email, v_confirmed
  from auth.users u
  where u.id = v_uid;

  if v_confirmed is null
     or v_auth_email is null
     or v_auth_email <> v_inv.email then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- The recipient's profile, if any. A SUSPENDED or DEACTIVATED profile is an
  -- administrative decision and is NEVER silently reactivated by accepting an
  -- invitation; the whole acceptance is refused instead.
  select p.status into v_profile_status
  from public.profiles p
  where p.id = v_uid;

  if v_profile_status in ('SUSPENDED', 'DEACTIVATED') then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- ANY membership of the invitation's Retailer, in ANY status, blocks acceptance.
  -- This invitation provisions a NEW staff member; it is not a role-change, a
  -- reactivation, or a repair path, and none of those exist in this milestone. A
  -- membership of a DIFFERENT Retailer is irrelevant and does not block: the filter
  -- names this Retailer only, so a person may legitimately be staff at several.
  if exists (
    select 1
    from public.organization_members m
    where m.organization_id = v_inv.retailer_organization_id
      and m.user_id = v_uid
  ) then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Retailer and target role validation
  -- --------------------------------------------------------------------------
  select o.name into v_retailer_name
  from public.organizations o
  where o.id = v_inv.retailer_organization_id
    and o.organization_type = 'RETAILER'
    and o.status = 'ACTIVE'
  for share;

  if v_retailer_name is null then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- The role must be ACTIVE and must be EXACTLY one of the two staff roles. This is
  -- what makes it impossible for this function to grant RETAILER_OWNER or any Vendor
  -- role: the allow-set is a literal, checked against the catalogue by code, and the
  -- role UUID used for the edge below is the one already fixed on the invitation (and
  -- immutable there by trigger) rather than anything the caller supplied.
  select r.code into v_role_code
  from public.roles r
  where r.id = v_inv.role_id
    and r.status = 'ACTIVE'
    and r.code in ('RETAILER_MANAGER', 'SALES_STAFF');

  if v_role_code is null then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. Intended shops — read, then lock in ascending UUID order
  -- --------------------------------------------------------------------------
  -- The set comes from the invitation's immutable shop rows and from nowhere else, so
  -- no caller can widen it. Ordering the locks by UUID gives every acceptance the same
  -- lock order and removes the deadlock that arbitrary ordering would allow. FOR SHARE
  -- holds each shop against a concurrent status change until this transaction ends.
  select coalesce(array_agg(sa.retailer_shop_id order by sa.retailer_shop_id), '{}'::uuid[])
    into v_shop_ids
  from public.retailer_invitation_shop_assignments sa
  where sa.retailer_staff_invitation_id = v_inv.id;

  v_shop_count := coalesce(array_length(v_shop_ids, 1), 0);

  -- A Retailer Manager receives NO shop rows at all. A Sales Staff member must have at
  -- least one intended shop; an invitation that somehow reached acceptance without one
  -- is refused rather than completed as an unassigned member.
  if v_role_code = 'RETAILER_MANAGER' and v_shop_count <> 0 then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  if v_role_code = 'SALES_STAFF' and v_shop_count < 1 then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  if v_shop_count > 0 then
    -- Locking runs in a loop rather than inside an aggregate: FOR SHARE cannot be
    -- combined with an aggregate query. Each shop must still exist, still be ACTIVE,
    -- and still belong to the INVITATION's Retailer. If fewer rows qualify than the
    -- invitation names, at least one intended shop is inactive or has moved, and the
    -- whole acceptance is refused — never silently narrowed to the survivors.
    v_shop_valid := 0;
    for v_shop_id in
      select s.id
      from public.retailer_shops s
      where s.id = any(v_shop_ids)
        and s.retailer_organization_id = v_inv.retailer_organization_id
        and s.status = 'ACTIVE'
      order by s.id
      for share
    loop
      v_shop_valid := v_shop_valid + 1;
    end loop;

    if v_shop_valid <> v_shop_count then
      raise exception 'This invitation could not be accepted'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- --------------------------------------------------------------------------
  -- 4b. Profile — create, promote, or preserve
  -- --------------------------------------------------------------------------
  -- Sits immediately before membership creation because organization_members.user_id
  -- references profiles(id): the row must exist first. Retired states were already
  -- refused in step 2, so only three cases remain.
  --
  --   absent   -> create ACTIVE, with the invitation's names. The invitation's own
  --               trimmed/non-empty constraints guarantee they satisfy profiles'.
  --   INVITED  -> promote to ACTIVE. The `and status = 'INVITED'` filter keeps this a
  --               promotion and not a reactivation.
  --   ACTIVE   -> preserved untouched.
  --
  -- Names on an existing profile are NEVER overwritten from an invitation, and there
  -- is no missing-name case to repair: profiles.first_name and last_name are NOT NULL
  -- and constrained non-empty, so an existing profile always has both. That is the
  -- whole of the "explicitly safe missing-name behavior" — there is nothing safe to do
  -- because there is nothing missing, and overwriting a person's own name with an
  -- inviter's spelling of it would not be safe.
  if v_profile_status is null then
    insert into public.profiles (id, first_name, last_name, status)
    values (v_uid, v_inv.first_name, v_inv.last_name, 'ACTIVE');
  elsif v_profile_status = 'INVITED' then
    update public.profiles
    set status = 'ACTIVE'
    where id = v_uid
      and status = 'INVITED';
  end if;

  -- Fail closed unless the caller now has exactly one ACTIVE profile. profiles.id is
  -- the primary key and equals auth.uid(), so a lookup by it returns at most one row;
  -- "exactly one ACTIVE" therefore reduces to "this row exists and is ACTIVE".
  select p.status into v_profile_status
  from public.profiles p
  where p.id = v_uid;

  if v_profile_status is distinct from 'ACTIVE' then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. Membership — exactly one, ACTIVE
  -- --------------------------------------------------------------------------
  -- A plain INSERT, not an upsert. Step 2 established that no membership of this
  -- Retailer exists for this person, so a unique violation here means a concurrent
  -- transaction created one between that check and this write. That is precisely the
  -- race organization_members_unique_membership exists to settle, and its verdict is
  -- accepted: the acceptance is refused on the same generic path, having written
  -- nothing.
  begin
    insert into public.organization_members (organization_id, user_id, status, joined_at)
    values (v_inv.retailer_organization_id, v_uid, 'ACTIVE', now())
    returning id, status into v_member_id, v_member_status;
  exception when unique_violation then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end;

  if v_member_id is null or v_member_status is distinct from 'ACTIVE' then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 6. Member-role — exactly one edge, for the invitation's role only
  -- --------------------------------------------------------------------------
  -- One INSERT of one row. There is no loop and no second role: an invitation carries
  -- a single immutable role_id, and step 3 proved its code is RETAILER_MANAGER or
  -- SALES_STAFF. assigned_by records the inviting owner from the invitation, matching
  -- the convention the owner-acceptance path already uses; it is nullable and may be
  -- null if that profile was since removed.
  begin
    insert into public.member_roles (organization_member_id, role_id, assigned_by)
    values (v_member_id, v_inv.role_id, v_inv.invited_by_profile_id);
  exception when unique_violation then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end;

  -- --------------------------------------------------------------------------
  -- 7. Retailer shop membership — the immutable intended set, copied atomically
  -- --------------------------------------------------------------------------
  -- One INSERT ... SELECT over the array built and validated in step 4, so the copied
  -- set is exactly the invitation's set: no shop added, none dropped, none from
  -- another Retailer (step 4 required each to belong to the invitation's Retailer, and
  -- the retailer_shop_members_assert_same_retailer trigger is defence in depth over
  -- that). The array is DISTINCT by construction — the invitation-shop rows are unique
  -- per (invitation, shop) — and the membership was created moments ago with no shop
  -- rows, so retailer_shop_members_live_unique_idx cannot collide except under a
  -- concurrent duplicate, which it settles by raising.
  --
  -- RETAILER_MANAGER never reaches an INSERT here: step 4 forced v_shop_count = 0 for
  -- that role, so the guard below skips the statement entirely and zero rows exist.
  if v_shop_count > 0 then
    begin
      insert into public.retailer_shop_members (
        organization_member_id,
        retailer_shop_id,
        assigned_by,
        assigned_at
      )
      select v_member_id, s, v_inv.invited_by_profile_id, now()
      from unnest(v_shop_ids) s;
    exception when unique_violation then
      raise exception 'This invitation could not be accepted'
        using errcode = 'insufficient_privilege';
    end;
  end if;

  -- --------------------------------------------------------------------------
  -- 8. Invitation finalization
  -- --------------------------------------------------------------------------
  -- status, accepted_at, auth_user_id, organization_member_id and the cleared token /
  -- failure fields all move in ONE statement. That is required, not stylistic:
  --   * retailer_staff_invitations_accepted_consistent ties status to accepted_at;
  --   * ..._auth_user_context and ..._member_context permit those ids only on an
  --     ACCEPTED row;
  --   * the assert_acceptance_references trigger demands both ids as status becomes
  --     ACCEPTED;
  --   * ..._token_hash_context permits a token only on a PENDING row.
  -- Split across two statements, each ordering would violate one of them.
  --
  -- sent_at is not in the SET list and is therefore preserved, as is every
  -- retailer_invitation_shop_assignments row: the intended-shop history stays readable
  -- after acceptance and is never deleted. created_at, invited_by_profile_id, email,
  -- names and role_id are likewise untouched (the last three are immutable by trigger).
  --
  -- The WHERE re-asserts PENDING so a concurrent transition can never be overwritten,
  -- and the affected-row count is checked rather than assumed.
  update public.retailer_staff_invitations
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

  get diagnostics v_finalized = row_count;

  if v_finalized <> 1 then
    raise exception 'This invitation could not be accepted'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 9. Audit — exactly one safe event
  -- --------------------------------------------------------------------------
  -- organization_id is the RETAILER's: the audit convention is that this column names
  -- the tenant whose activity feed the entry belongs in, and this event was performed
  -- BY the invitee, who is now a member of that Retailer. actor_profile_id is the
  -- invitee's own profile id (= auth.uid() = that profile's primary key).
  --
  -- metadata carries display-only fields and NOTHING else — no raw token, no token
  -- hash, no email address, no email body, no provider response, no secret, no private
  -- error text, no Auth credential, no id of any kind. shop_count is a count, not the
  -- shop ids. The entity_id is the invitation's own id, which the reader of this log
  -- already has authority over.
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
    'STAFF_INVITATION_ACCEPTED',
    'RETAILER_STAFF_INVITATION',
    v_inv.id::text,
    jsonb_build_object(
      'retailer_name',     v_retailer_name,
      'role_code',         v_role_code,
      'invitation_status', 'ACCEPTED',
      'membership_status', 'ACTIVE',
      'shop_count',        v_shop_count
    )
  );
end;
$$;

revoke all     on function public.accept_retailer_staff_invitation(text) from public;
revoke execute on function public.accept_retailer_staff_invitation(text) from anon;
grant  execute on function public.accept_retailer_staff_invitation(text) to authenticated;

-- ============================================================================
-- FUNCTION 3 — list_retailer_staff_members()
-- ============================================================================
-- The safe, strictly READ-ONLY staff roster for one Retailer.
--
-- AUTHORIZATION
--   The Retailer is DERIVED from the caller's own membership through the established
--   resolver, exactly as every other staff operation does. No Retailer id is accepted
--   from the browser, so there is no parameter through which a caller could name
--   another tenant. The permission is RETAILER_STAFF_READ, whose current mappings are:
--     RETAILER_OWNER    — has RETAILER_STAFF_READ and RETAILER_STAFF_MANAGE
--     RETAILER_MANAGER  — has RETAILER_STAFF_READ
--     SALES_STAFF       — has neither, and therefore cannot list the roster
--   Sales Staff are refused by the mapping itself rather than by a special case here;
--   if a future mapping grants them the permission, this function follows that
--   decision without being edited.
--
-- VISIBILITY
--   A RETAILER_STAFF_MANAGE holder (the Owner) additionally sees non-ACTIVE
--   memberships, so the person who manages staff can see who is suspended or
--   deactivated. A read-only RETAILER_STAFF_READ holder (the Manager) sees the ACTIVE
--   roster only. This is a narrowing of what is READ; it grants no mutation to anyone.
--
-- READ-ONLY, AND ONLY READ
--   Declared STABLE and containing no INSERT / UPDATE / DELETE. This milestone adds no
--   deactivate, reactivate, role-change or shop-change operation, so a Retailer Manager
--   who can call this function still has nothing to call that changes anything.
--
-- NOT RETURNED
--   * Email addresses. The only source of a member's email is auth.users, and Auth
--     metadata is out of scope for this roster; no current product requirement states
--     that a Manager may read a colleague's address, so it is omitted rather than
--     sourced from Auth on the assumption that it would be welcome.
--   * Auth user ids, email-confirmation or sign-in timestamps, or any other Auth field.
--   * Invitation token hashes, tokens, delivery or failure state.
--   * Audit metadata.
--   * Any membership of any other Retailer — every row is filtered on the resolved
--     organization id.
--   * Vendor organizations, Vendor members, or Vendor roles — the resolver admits only
--     RETAILER organizations, and the role filter admits only the three Retailer roles.
--
-- ROWS AND KEYS
--   membership_id is returned because a roster is a list and a list needs a stable
--   identity per row; it is a UUID belonging to the caller's own tenant, released only
--   to a holder of an explicit RETAILER_STAFF_READ grant, and it is the key any future
--   roster UI will render against.
--
--   One row per (membership, Retailer role) edge. Today that is one row per person:
--   staff acceptance grants exactly one role, and owner acceptance grants exactly one.
--   Should a person ever hold two Retailer roles, they appear once per role rather than
--   having one of the two silently dropped by an arbitrary pick.
create function public.list_retailer_staff_members()
returns table (
  membership_id     uuid,
  first_name        text,
  last_name         text,
  role_code         text,
  role_name         text,
  membership_status text,
  shop_ids          uuid[],
  shop_names        text[],
  joined_at         timestamptz,
  created_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer  uuid;
  v_can_manage boolean;
begin
  v_retailer := public.resolve_retailer_member_organization('RETAILER_STAFF_READ');
  if v_retailer is null then
    raise exception 'Not authorized to view staff'
      using errcode = 'insufficient_privilege';
  end if;

  -- Whether the caller may additionally see non-ACTIVE memberships. Evaluated against
  -- the RESOLVED Retailer, so it can only ever describe the caller's own tenant.
  v_can_manage := public.has_organization_permission(v_retailer, 'RETAILER_STAFF_MANAGE');

  return query
  select
    m.id,
    p.first_name,
    p.last_name,
    r.code,
    r.name,
    m.status,
    -- Assigned shops: live assignments (removed_at is null) to shops that are still
    -- ACTIVE and still belong to THIS Retailer. Ordered by name then id so the two
    -- arrays are positionally aligned and the output is deterministic. Empty for a
    -- Manager or Owner, who hold no shop rows.
    coalesce(
      (
        select array_agg(s.id order by s.name, s.id)
        from public.retailer_shop_members sm
        join public.retailer_shops s on s.id = sm.retailer_shop_id
        where sm.organization_member_id = m.id
          and sm.removed_at is null
          and s.status = 'ACTIVE'
          and s.retailer_organization_id = v_retailer
      ),
      '{}'::uuid[]
    ),
    coalesce(
      (
        select array_agg(s.name order by s.name, s.id)
        from public.retailer_shop_members sm
        join public.retailer_shops s on s.id = sm.retailer_shop_id
        where sm.organization_member_id = m.id
          and sm.removed_at is null
          and s.status = 'ACTIVE'
          and s.retailer_organization_id = v_retailer
      ),
      '{}'::text[]
    ),
    m.joined_at,
    m.created_at
  from public.organization_members m
  join public.profiles p on p.id = m.user_id
  join public.member_roles mr on mr.organization_member_id = m.id
  join public.roles r on r.id = mr.role_id
  where m.organization_id = v_retailer
    and r.status = 'ACTIVE'
    and r.code in ('RETAILER_OWNER', 'RETAILER_MANAGER', 'SALES_STAFF')
    and (v_can_manage or m.status = 'ACTIVE')
  order by p.last_name, p.first_name, m.id, r.code;
end;
$$;

revoke all     on function public.list_retailer_staff_members() from public;
revoke execute on function public.list_retailer_staff_members() from anon;
grant  execute on function public.list_retailer_staff_members() to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- Three functions added; nothing else exists in this migration. No table, column,
-- constraint, index, trigger, policy, role, permission or role-permission mapping is
-- created, altered or dropped. No existing function — storage, authorization helper,
-- owner operation, delivery operation, or Retailer Owner portal / acceptance — is
-- touched. No table privilege is granted to any browser role, so direct browser writes
-- to every protected table remain denied and the RLS posture is byte-identical to what
-- migration 20260724090000 left behind.
--
-- service_role is granted execute on none of the three: recipient resolution and
-- acceptance are browser operations that derive their entire authority from auth.uid(),
-- and the roster derives its Retailer from the caller's own membership. None has an
-- internal dependency that would justify a service-role path, and granting one would
-- create a way to accept an invitation or read a roster with no session at all.
