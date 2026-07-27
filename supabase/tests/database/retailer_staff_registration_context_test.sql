-- pgTAP behavioural tests for the repaired staff registration context
-- (migration 20260808090000_repair_retailer_staff_registration_context.sql)
--
--   public.get_retailer_staff_registration_context(text)
--   public.resolve_retailer_staff_invitation_recipient(text)
--   public.retailer_staff_invitation_gate(text)            [internal]
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT IS BEING PROVEN, AND WHY IT MATTERS
-- ============================================================================
-- The shipped function classified the invited address with a PRESENCE TEST — any
-- auth.users row meant "show sign-in" — which dead-ended an invited person whose row
-- exists but cannot be signed in to.
--
-- The repair distinguishes five states, and the DANGEROUS one is RECOVERY_REQUIRED: an
-- account that cannot sign in but already carries a provisioned identity. Sections D and
-- E are the heart of this file. If a row with a profile, a membership or a role
-- assignment were ever classified ACTIVATION_REQUIRED, a staff invitation token could set
-- its first password and claim an identity that is midway through becoming a Retailer
-- Owner — turning the token from a discovery pointer into an account credential.
--
-- HOW THE FIXTURES WORK
-- Everything runs inside one transaction and is rolled back, so nothing survives. The
-- functions under test are SECURITY DEFINER and take no identity from the session — they
-- are keyed entirely by a token hash — so no impersonation helper is needed. EXECUTE
-- privilege is asserted directly against the catalogue in Section A, which is a stronger
-- check than "it did not error for me".
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file
-- turns an added test into a confusing failure about arithmetic rather than behaviour.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers
-- ============================================================================

-- A 64-lowercase-hex token hash derived from a label, so every fixture gets a distinct,
-- well-formed hash without any real token material appearing in this file.
create function pg_temp.hash_for(p_label text) returns text
language sql immutable as $$
  select encode(extensions.digest(p_label, 'sha256'), 'hex');
$$;

-- One Retailer organization, ACTIVE.
create function pg_temp.make_retailer(p_label text) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.organizations (id, name, organization_type, status)
  values (v_id, p_label, 'RETAILER', 'ACTIVE');
  return v_id;
end;
$$;

-- An auth.users row with precisely controlled sign-in capability.
--
--   p_confirmed  whether email_confirmed_at is set
--   p_password   whether encrypted_password holds anything
--   p_banned     whether banned_until is in the future
--   p_deleted    whether deleted_at is set
create function pg_temp.make_auth_user(
  p_email     text,
  p_confirmed boolean,
  p_password  boolean,
  p_banned    boolean default false,
  p_deleted   boolean default false
) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    id, email, email_confirmed_at, encrypted_password, banned_until, deleted_at
  )
  values (
    v_id,
    p_email,
    case when p_confirmed then now() - interval '1 day' else null end,
    -- A bcrypt-shaped placeholder. Never a real hash, and never read by the function
    -- under test, which only asks whether the column is non-empty.
    case when p_password then '$2a$10$0000000000000000000000000000000000000000000000000000' else '' end,
    case when p_banned then now() + interval '1 day' else null end,
    case when p_deleted then now() - interval '1 hour' else null end
  );
  return v_id;
end;
$$;

-- A live PENDING RETAILER_MANAGER invitation carrying the given token hash.
create function pg_temp.make_manager_invitation(
  p_retailer   uuid,
  p_email      text,
  p_token_hash text
) returns uuid
language plpgsql as $$
declare
  v_id      uuid := gen_random_uuid();
  v_role_id uuid;
begin
  select r.id into v_role_id from public.roles r where r.code = 'RETAILER_MANAGER';

  insert into public.retailer_staff_invitations (
    id, retailer_organization_id, email, first_name, last_name, role_id,
    status, token_hash, expires_at
  )
  values (
    v_id, p_retailer, p_email, 'Ada', 'Lovelace', v_role_id,
    'PENDING', p_token_hash, now() + interval '24 hours'
  );
  return v_id;
end;
$$;

-- Gives an auth user a provisioned identity of the requested kind.
--   'profile'    a profiles row only
--   'membership' a profiles row and an organization_members row
--   'role'       both of the above plus a member_roles edge
create function pg_temp.provision(
  p_user uuid, p_org uuid, p_kind text
) returns void
language plpgsql as $$
declare
  v_member_id uuid;
  v_role_id   uuid;
begin
  insert into public.profiles (id, first_name, last_name, status)
  values (p_user, 'Ada', 'Lovelace', 'INVITED');

  if p_kind = 'profile' then
    return;
  end if;

  insert into public.organization_members (organization_id, user_id, status)
  values (p_org, p_user, 'INVITED')
  returning id into v_member_id;

  if p_kind = 'membership' then
    return;
  end if;

  select r.id into v_role_id from public.roles r where r.code = 'RETAILER_MANAGER';
  insert into public.member_roles (organization_member_id, role_id)
  values (v_member_id, v_role_id);
end;
$$;

-- The single value under test, for a token hash.
create function pg_temp.state_for(p_token_hash text) returns text
language sql stable as $$
  select account_state
  from public.get_retailer_staff_registration_context(p_token_hash);
$$;

-- ============================================================================
-- SECTION A — grants and shape
-- ============================================================================

select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'get_retailer_staff_registration_context'),
  1,
  'A1. the context function exists exactly once'
);

select is(
  (select count(*)::int from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'resolve_retailer_staff_invitation_recipient'),
  1,
  'A2. the recipient function exists exactly once'
);

-- service_role may execute both; no browser role may.
select ok(
  has_function_privilege('service_role', 'public.get_retailer_staff_registration_context(text)', 'EXECUTE'),
  'A3. service_role may execute the context function'
);
select ok(
  not has_function_privilege('anon', 'public.get_retailer_staff_registration_context(text)', 'EXECUTE'),
  'A4. anon may NOT execute the context function'
);
select ok(
  not has_function_privilege('authenticated', 'public.get_retailer_staff_registration_context(text)', 'EXECUTE'),
  'A5. authenticated may NOT execute the context function'
);
select ok(
  has_function_privilege('service_role', 'public.resolve_retailer_staff_invitation_recipient(text)', 'EXECUTE'),
  'A6. service_role may execute the recipient function'
);
select ok(
  not has_function_privilege('anon', 'public.resolve_retailer_staff_invitation_recipient(text)', 'EXECUTE'),
  'A7. anon may NOT execute the recipient function — it maps a token to an address'
);
select ok(
  not has_function_privilege('authenticated', 'public.resolve_retailer_staff_invitation_recipient(text)', 'EXECUTE'),
  'A8. authenticated may NOT execute the recipient function'
);
select ok(
  not has_function_privilege('service_role', 'public.retailer_staff_invitation_gate(text)', 'EXECUTE'),
  'A9. even service_role may NOT call the internal gate directly'
);

-- The output is exactly two columns, and neither is an address or an id.
select set_eq(
  $$ select unnest(proargnames[array_length(proargmodes,1) - 1:])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'get_retailer_staff_registration_context' $$,
  $$ values ('account_state'), ('expires_at') $$,
  'A10. the context function returns only account_state and expires_at'
);

-- ============================================================================
-- SECTION B — NO_ACCOUNT
-- ============================================================================

-- The fixture is built by its own statement, never in a FROM clause alongside the
-- assertion: PostgreSQL does not guarantee that a set-returning fixture in FROM is
-- evaluated before the SELECT list that depends on it.
create function pg_temp.setup_b() returns void language plpgsql as $$
begin
  perform pg_temp.make_manager_invitation(
    pg_temp.make_retailer('B Retail'),
    'b-nobody@test.invalid',
    pg_temp.hash_for('b-no-account')
  );
end;
$$;
select pg_temp.setup_b();

select is(
  pg_temp.state_for(pg_temp.hash_for('b-no-account')),
  'NO_ACCOUNT',
  'B1. an invited address with no auth.users row is NO_ACCOUNT'
);

-- ============================================================================
-- SECTION C — ACTIVATION_REQUIRED
-- ============================================================================
-- The ONLY state that permits a staff invitation token to set a first password: a row
-- that is unconfirmed, password-less, and carries no provisioned identity at all.

create function pg_temp.setup_c() returns void language plpgsql as $$
declare v_org uuid := pg_temp.make_retailer('C Retail');
begin
  perform pg_temp.make_auth_user('c-shell@test.invalid', false, false);
  perform pg_temp.make_manager_invitation(v_org, 'c-shell@test.invalid', pg_temp.hash_for('c-shell'));
end;
$$;
select pg_temp.setup_c();

select is(
  pg_temp.state_for(pg_temp.hash_for('c-shell')),
  'ACTIVATION_REQUIRED',
  'C1. an invited, unconfirmed, password-less row with NO provisioned identity is ACTIVATION_REQUIRED'
);

-- ============================================================================
-- SECTION D — RECOVERY_REQUIRED, forced by a provisioned identity
-- ============================================================================
-- THE HEART OF THIS SUITE. Each row below is identical to Section C's except for the
-- provisioned identity, and each must therefore flip to RECOVERY_REQUIRED. This is what
-- finalize_retailer_owner_invitation leaves behind for an owner invitation that was never
-- completed, and it is exactly the shape that must never be offered activation.

create function pg_temp.setup_d(p_label text, p_kind text) returns void
language plpgsql as $$
declare
  v_org  uuid := pg_temp.make_retailer('D Retail ' || p_label);
  v_user uuid;
begin
  v_user := pg_temp.make_auth_user(p_label || '@test.invalid', false, false);
  perform pg_temp.provision(v_user, v_org, p_kind);
  perform pg_temp.make_manager_invitation(v_org, p_label || '@test.invalid', pg_temp.hash_for(p_label));
end;
$$;

select pg_temp.setup_d('d-profile', 'profile');
select is(
  pg_temp.state_for(pg_temp.hash_for('d-profile')),
  'RECOVERY_REQUIRED',
  'D1. a password-less row with a PROFILE is RECOVERY_REQUIRED, never ACTIVATION_REQUIRED'
);

select pg_temp.setup_d('d-membership', 'membership');
select is(
  pg_temp.state_for(pg_temp.hash_for('d-membership')),
  'RECOVERY_REQUIRED',
  'D2. a password-less row with an ORGANIZATION MEMBERSHIP is RECOVERY_REQUIRED'
);

select pg_temp.setup_d('d-role', 'role');
select is(
  pg_temp.state_for(pg_temp.hash_for('d-role')),
  'RECOVERY_REQUIRED',
  'D3. a password-less row with a ROLE ASSIGNMENT is RECOVERY_REQUIRED'
);

-- ============================================================================
-- SECTION E — RECOVERY_REQUIRED, forced by an unusable password
-- ============================================================================

create function pg_temp.setup_e(
  p_label text, p_confirmed boolean, p_password boolean
) returns void
language plpgsql as $$
declare v_org uuid := pg_temp.make_retailer('E Retail ' || p_label);
begin
  perform pg_temp.make_auth_user(p_label || '@test.invalid', p_confirmed, p_password);
  perform pg_temp.make_manager_invitation(v_org, p_label || '@test.invalid', pg_temp.hash_for(p_label));
end;
$$;

select pg_temp.setup_e('e-unconfirmed-with-password', false, true);
select is(
  pg_temp.state_for(pg_temp.hash_for('e-unconfirmed-with-password')),
  'RECOVERY_REQUIRED',
  'E1. an UNCONFIRMED account that already has a password is RECOVERY_REQUIRED — setup was completed once, so overwriting it is the same takeover risk'
);

-- The FAIL-SAFE case, and the one this suite caught. A confirmed address with no
-- password meets the literal definition of "empty shell" (cannot sign in, no password,
-- nothing provisioned) — but confirmation means somebody proved control of that mailbox
-- at some point, and that is the shape a magic-link or OAuth identity has. Classifying it
-- as safe first-time activation would be a guess, so it is RECOVERY_REQUIRED instead.
select pg_temp.setup_e('e-confirmed-no-password', true, false);
select is(
  pg_temp.state_for(pg_temp.hash_for('e-confirmed-no-password')),
  'RECOVERY_REQUIRED',
  'E2. a CONFIRMED account with no password is RECOVERY_REQUIRED, not activation — uncertainty fails safe'
);

-- ============================================================================
-- SECTION F — SIGN_IN
-- ============================================================================

select pg_temp.setup_e('f-usable', true, true);
select is(
  pg_temp.state_for(pg_temp.hash_for('f-usable')),
  'SIGN_IN',
  'F1. a confirmed, password-capable, non-blocked account is SIGN_IN'
);

-- A provisioned identity does NOT downgrade a usable account: it can still sign in.
create function pg_temp.setup_f2() returns void language plpgsql as $$
declare
  v_org  uuid := pg_temp.make_retailer('F2 Retail');
  v_user uuid;
begin
  v_user := pg_temp.make_auth_user('f2-usable@test.invalid', true, true);
  perform pg_temp.provision(v_user, v_org, 'role');
  perform pg_temp.make_manager_invitation(v_org, 'f2-usable@test.invalid', pg_temp.hash_for('f2-usable'));
end;
$$;
select pg_temp.setup_f2();
select is(
  pg_temp.state_for(pg_temp.hash_for('f2-usable')),
  'SIGN_IN',
  'F2. a usable account with a provisioned identity is still SIGN_IN'
);

-- ============================================================================
-- SECTION G — ACCOUNT_BLOCKED
-- ============================================================================

create function pg_temp.setup_g(
  p_label text, p_banned boolean, p_deleted boolean
) returns void
language plpgsql as $$
declare v_org uuid := pg_temp.make_retailer('G Retail ' || p_label);
begin
  perform pg_temp.make_auth_user(p_label || '@test.invalid', true, true, p_banned, p_deleted);
  perform pg_temp.make_manager_invitation(v_org, p_label || '@test.invalid', pg_temp.hash_for(p_label));
end;
$$;

select pg_temp.setup_g('g-banned', true, false);
select is(
  pg_temp.state_for(pg_temp.hash_for('g-banned')),
  'ACCOUNT_BLOCKED',
  'G1. a banned account is ACCOUNT_BLOCKED even though it is otherwise usable'
);

select pg_temp.setup_g('g-deleted', false, true);
select is(
  pg_temp.state_for(pg_temp.hash_for('g-deleted')),
  'ACCOUNT_BLOCKED',
  'G2. a soft-deleted account is ACCOUNT_BLOCKED'
);

-- Ambiguity: two auth rows for one address. The function must refuse to guess.
-- auth.users carries a PARTIAL unique index on email covering non-SSO rows, so two
-- ordinary rows for one address cannot exist. The real shape of this ambiguity is an SSO
-- identity alongside a password identity, which the index permits — and which leaves the
-- function unable to know which one a password would land on.
create function pg_temp.setup_g3() returns void language plpgsql as $$
declare
  v_org uuid := pg_temp.make_retailer('G3 Retail');
  v_sso uuid := gen_random_uuid();
begin
  perform pg_temp.make_auth_user('g3-ambiguous@test.invalid', true, true);
  insert into auth.users (id, email, email_confirmed_at, encrypted_password, is_sso_user)
  values (v_sso, 'g3-ambiguous@test.invalid', now(), '', true);
  perform pg_temp.make_manager_invitation(v_org, 'g3-ambiguous@test.invalid', pg_temp.hash_for('g3-ambiguous'));
end;
$$;
select pg_temp.setup_g3();
select is(
  pg_temp.state_for(pg_temp.hash_for('g3-ambiguous')),
  'ACCOUNT_BLOCKED',
  'G3. two auth rows for one address is ACCOUNT_BLOCKED — the function does not guess which identity a password would land on'
);

-- ============================================================================
-- SECTION H — the invitation must be live, and every refusal is identical
-- ============================================================================

select throws_ok(
  $$ select public.get_retailer_staff_registration_context(
       'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff') $$,
  '23514',
  'This invitation is not available',
  'H1. an unknown token raises the single generic exception'
);

select throws_ok(
  $$ select public.get_retailer_staff_registration_context('not-a-hash') $$,
  '23514',
  'This invitation is not available',
  'H2. a malformed token hash raises the SAME exception'
);

select throws_ok(
  $$ select public.get_retailer_staff_registration_context(null) $$,
  '23514',
  'This invitation is not available',
  'H3. a null token hash raises the SAME exception'
);

-- Expired.
create function pg_temp.setup_h_expired() returns void language plpgsql as $$
declare
  v_org uuid := pg_temp.make_retailer('H Expired');
  v_inv uuid;
begin
  v_inv := pg_temp.make_manager_invitation(v_org, 'h-expired@test.invalid', pg_temp.hash_for('h-expired'));
  update public.retailer_staff_invitations
    set expires_at = now() - interval '1 hour'
    where id = v_inv;
end;
$$;
select pg_temp.setup_h_expired();
select throws_ok(
  format(
    $$ select public.get_retailer_staff_registration_context(%L) $$,
    pg_temp.hash_for('h-expired')
  ),
  '23514',
  'This invitation is not available',
  'H4. an EXPIRED invitation raises the SAME exception'
);

-- Revoked.
create function pg_temp.setup_h_revoked() returns void language plpgsql as $$
declare
  v_org uuid := pg_temp.make_retailer('H Revoked');
  v_inv uuid;
begin
  v_inv := pg_temp.make_manager_invitation(v_org, 'h-revoked@test.invalid', pg_temp.hash_for('h-revoked'));
  update public.retailer_staff_invitations
    set status = 'REVOKED', revoked_at = now(), token_hash = null
    where id = v_inv;
end;
$$;
select pg_temp.setup_h_revoked();
select throws_ok(
  format(
    $$ select public.get_retailer_staff_registration_context(%L) $$,
    pg_temp.hash_for('h-revoked')
  ),
  '23514',
  'This invitation is not available',
  'H5. a REVOKED invitation raises the SAME exception'
);

-- Accepted.
-- An ACCEPTED invitation must record BOTH its Auth user and its membership
-- (retailer_staff_invitations_assert_acceptance_references), so the fixture provisions a
-- real acceptance rather than faking the status alone.
create function pg_temp.setup_h_accepted() returns void language plpgsql as $$
declare
  v_org    uuid := pg_temp.make_retailer('H Accepted');
  v_inv    uuid;
  v_user   uuid;
  v_member uuid;
begin
  v_inv  := pg_temp.make_manager_invitation(v_org, 'h-accepted@test.invalid', pg_temp.hash_for('h-accepted'));
  v_user := pg_temp.make_auth_user('h-accepted@test.invalid', true, true);

  insert into public.profiles (id, first_name, last_name, status)
  values (v_user, 'Ada', 'Lovelace', 'ACTIVE');

  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (v_org, v_user, 'ACTIVE', now())
  returning id into v_member;

  update public.retailer_staff_invitations
    set status = 'ACCEPTED',
        accepted_at = now(),
        token_hash = null,
        auth_user_id = v_user,
        organization_member_id = v_member
    where id = v_inv;
end;
$$;
select pg_temp.setup_h_accepted();
select throws_ok(
  format(
    $$ select public.get_retailer_staff_registration_context(%L) $$,
    pg_temp.hash_for('h-accepted')
  ),
  '23514',
  'This invitation is not available',
  'H6. an ACCEPTED invitation raises the SAME exception'
);

-- An inactive Retailer.
create function pg_temp.setup_h_inactive() returns void language plpgsql as $$
declare v_org uuid := pg_temp.make_retailer('H Inactive');
begin
  perform pg_temp.make_manager_invitation(v_org, 'h-inactive@test.invalid', pg_temp.hash_for('h-inactive'));
  -- organizations_status_allowed permits ACTIVE / SUSPENDED / DEACTIVATED.
  update public.organizations set status = 'SUSPENDED' where id = v_org;
end;
$$;
select pg_temp.setup_h_inactive();
select throws_ok(
  format(
    $$ select public.get_retailer_staff_registration_context(%L) $$,
    pg_temp.hash_for('h-inactive')
  ),
  '23514',
  'This invitation is not available',
  'H7. an invitation whose Retailer is no longer ACTIVE (SUSPENDED) raises the SAME exception'
);

-- ============================================================================
-- SECTION I — the recipient function
-- ============================================================================

select is(
  (select invited_email
   from public.resolve_retailer_staff_invitation_recipient(pg_temp.hash_for('c-shell'))),
  'c-shell@test.invalid',
  'I1. the recipient function returns the invitation''s canonical address'
);

select throws_ok(
  $$ select public.resolve_retailer_staff_invitation_recipient(
       'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff') $$,
  '23514',
  'This invitation is not available',
  'I2. it refuses an unknown token with the SAME generic exception as the context function'
);

select throws_ok(
  format(
    $$ select public.resolve_retailer_staff_invitation_recipient(%L) $$,
    pg_temp.hash_for('h-expired')
  ),
  '23514',
  'This invitation is not available',
  'I3. it applies the same liveness gate — no address is resolvable for a dead invitation'
);

-- ============================================================================
-- SECTION J — the output carries nothing else
-- ============================================================================

select is(
  (select expires_at is not null
   from public.get_retailer_staff_registration_context(pg_temp.hash_for('c-shell'))),
  true,
  'J1. the expiry is returned'
);

select is(
  (select count(*)::int
   from public.get_retailer_staff_registration_context(pg_temp.hash_for('c-shell'))),
  1,
  'J2. exactly one row is returned for a live invitation'
);

-- Every state the function can emit is one of the five declared words. A sixth would
-- reach the application as an unrecognized value and collapse to "unavailable", hiding a
-- real classification behind a dead screen.
select ok(
  (select bool_and(s = any (array[
     'NO_ACCOUNT', 'ACTIVATION_REQUIRED', 'SIGN_IN', 'RECOVERY_REQUIRED', 'ACCOUNT_BLOCKED'
   ]))
   from (
     select pg_temp.state_for(pg_temp.hash_for(label)) as s
     from unnest(array[
       'b-no-account', 'c-shell', 'd-profile', 'd-membership', 'd-role',
       'e-unconfirmed-with-password', 'e-confirmed-no-password',
       'f-usable', 'f2-usable', 'g-banned', 'g-deleted', 'g3-ambiguous'
     ]) as label
   ) as observed),
  'J3. every observed state is one of the five declared words'
);

-- And all five are actually reachable, so none of the rules above passes vacuously.
select set_eq(
  $$ select distinct pg_temp.state_for(pg_temp.hash_for(label))
     from unnest(array[
       'b-no-account', 'c-shell', 'd-profile',
       'e-unconfirmed-with-password', 'f-usable', 'g-banned'
     ]) as label $$,
  $$ values ('NO_ACCOUNT'), ('ACTIVATION_REQUIRED'), ('RECOVERY_REQUIRED'),
            ('SIGN_IN'), ('ACCOUNT_BLOCKED') $$,
  'J4. all five states are reachable from these fixtures'
);

-- ============================================================================
-- SECTION K — nothing was written
-- ============================================================================
-- The functions are STABLE and must not have created an audit row while classifying.

select is(
  (select count(*)::int from public.audit_logs
   where entity_type = 'RETAILER_STAFF_INVITATION'),
  0,
  'K1. classifying an invitation writes no audit event'
);

select * from finish();
rollback;
