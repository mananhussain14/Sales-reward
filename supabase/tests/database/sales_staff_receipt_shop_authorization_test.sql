-- pgTAP behavioural tests for the SERVER SIDE of receipt shop selection:
--
--   public.list_my_assigned_receipt_shops()
--   public.reserve_receipt_submission(uuid, text, text, bigint, text)
--
-- both from migration 20260726210000_receipt_submission_operations.sql.
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHY THIS SUITE EXISTS
-- ============================================================================
-- The web form now decides WHEN a file picker is usable from the number of shops it was
-- handed. That is a convenience, and a convenience is worth nothing unless the capability it
-- hides is genuinely absent. This suite is the proof that it is: every assertion below is made
-- by a hand-crafted call that never went near a form, with a shop id the browser was never
-- given, in a session whose only identity is auth.uid().
--
-- THE FOUR WAYS A SHOP CAN BE WRONG, and they must be INDISTINGUISHABLE from one another:
--   1. a shop of this Retailer the caller is not assigned to;
--   2. a shop whose assignment was REMOVED (removed_at is not null);
--   3. a shop that is no longer ACTIVE — SUSPENDED or DEACTIVATED — even with a live
--      assignment;
--   4. another Retailer's shop, and a shop id that does not exist at all.
-- All four raise the same 42501, because a distinguishable refusal would let one staff member
-- enumerate another Retailer's estate one id at a time.
--
-- NOTHING HERE DEPENDS ON THE APPLICATION. No Server Action, no Edge Function and no HTTP
-- request is involved: if these functions are correct, a tampered browser gains nothing, and
-- if they are wrong, no amount of client-side gating would save the tenant boundary.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file turns
-- an added test into a confusing failure about arithmetic rather than about behaviour.
--
-- Everything runs in one transaction and is rolled back, so no fixture survives the run.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers
-- ============================================================================
-- Setting `request.jwt.claims` IS signing in, as far as every authorization helper in this
-- schema is concerned: auth.uid() reads the `sub` claim out of that GUC and nothing else. The
-- idiom is copied from sales_staff_receipt_reads_test.sql deliberately — two impersonation
-- idioms in one directory would be two different claims about what "signed in" means.
create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user::text)::text,
    true  -- transaction-local
  );
end;
$$;

create function pg_temp.sign_out() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

/* An auth user + an ACTIVE profile. profiles.id is a FK to auth.users(id). */
create function pg_temp.new_user(p_label text) returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v_id, p_label || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_label, 'Tester', 'ACTIVE');
  return v_id;
end;
$$;

create function pg_temp.grant_role(
  p_user uuid,
  p_org uuid,
  p_role_code text,
  p_membership_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status)
  values (p_org, p_user, p_membership_status)
  on conflict (organization_id, user_id) do update set status = excluded.status
  returning id into v_member;

  insert into public.member_roles (organization_member_id, role_id)
  select v_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;

  return v_member;
end;
$$;

/* The shop NAMES the current caller may submit against, ordered, as an array. */
create function pg_temp.my_shop_names() returns text[]
language sql as $$
  select coalesce(array_agg(s.shop_name order by s.shop_name), '{}')
  from public.list_my_assigned_receipt_shops() s;
$$;

/* How many shops the current caller may submit against. */
create function pg_temp.my_shop_count() returns bigint
language sql as $$
  select count(*) from public.list_my_assigned_receipt_shops();
$$;

/*
 * The SQLSTATE raised when the current caller tries to RESERVE against one shop, or NULL when
 * the reservation succeeded.
 *
 * Sequenced in plpgsql rather than through throws_ok() because the claim being tested is that
 * several DIFFERENT wrong shops produce the SAME state — which is a comparison of SQLSTATEs,
 * not an assertion that one call threw.
 *
 * Each call uses a DISTINCT file hash, derived from the seed by two md5s, so that the
 * active-duplicate index can never be what refuses a call this suite intends to succeed — and
 * so that every hash is genuinely 64 lowercase hex characters. A hash that failed the RPC's own
 * `^[0-9a-f]{64}$` check would raise 23514 and quietly mask the 42501 being tested.
 */
create function pg_temp.reserve_sqlstate(p_shop uuid, p_hash_seed text) returns text
language plpgsql as $$
begin
  perform * from public.reserve_receipt_submission(
    p_shop, 'receipt.jpg', 'image/jpeg', 2048,
    md5(p_hash_seed) || md5(p_hash_seed || '-tail')
  );
  return null;
exception when others then
  return sqlstate;
end;
$$;

-- ============================================================================
-- Fixtures
-- ============================================================================
-- DETERMINISTIC: every organization, shop, membership and assignment below is created by this
-- file. Nothing depends on seed data other than the roles and permissions catalogue the
-- migrations install.
create temporary table t_ids (label text primary key, id uuid not null);

do $$
declare
  v_retailer_a uuid := gen_random_uuid();
  v_retailer_b uuid := gen_random_uuid();
begin
  insert into public.organizations (id, name, organization_type, status) values
    (v_retailer_a, 'Shop Auth Retailer A', 'RETAILER', 'ACTIVE'),
    (v_retailer_b, 'Shop Auth Retailer B', 'RETAILER', 'ACTIVE');

  insert into t_ids values ('retailer_a', v_retailer_a), ('retailer_b', v_retailer_b);

  insert into t_ids values
    -- One shop assigned. The `fixed` case the form chooses automatically.
    ('u_one',    pg_temp.new_user('shopauth_one')),
    -- Three shops assigned. The `choose` case.
    ('u_many',   pg_temp.new_user('shopauth_many')),
    -- Sales Staff of Retailer A with NO live assignment. The `unassigned` case.
    ('u_none',   pg_temp.new_user('shopauth_none')),
    -- Sales Staff of the OTHER Retailer, for the cross-tenant assertions.
    ('u_other',  pg_temp.new_user('shopauth_other')),
    ('owner_a',  pg_temp.new_user('shopauth_owner'));
end;
$$;

do $$
declare
  v_a uuid := (select id from t_ids where label = 'retailer_a');
  v_b uuid := (select id from t_ids where label = 'retailer_b');

  v_shop_solo     uuid := gen_random_uuid();  -- u_one's only shop
  v_shop_1        uuid := gen_random_uuid();  -- u_many, live
  v_shop_2        uuid := gen_random_uuid();  -- u_many, live
  v_shop_3        uuid := gen_random_uuid();  -- u_many, live
  v_shop_unassign uuid := gen_random_uuid();  -- Retailer A's, assigned to NOBODY
  v_shop_removed  uuid := gen_random_uuid();  -- assignment REMOVED
  v_shop_deact    uuid := gen_random_uuid();  -- DEACTIVATED shop, LIVE assignment
  v_shop_susp     uuid := gen_random_uuid();  -- SUSPENDED shop, LIVE assignment
  v_shop_other    uuid := gen_random_uuid();  -- Retailer B's

  v_m_one  uuid;
  v_m_many uuid;
begin
  insert into public.retailer_shops (id, retailer_organization_id, name, code, status) values
    (v_shop_solo,     v_a, 'Shop Solo',      'SA-SOLO', 'ACTIVE'),
    (v_shop_1,        v_a, 'Shop One',       'SA-1',    'ACTIVE'),
    (v_shop_2,        v_a, 'Shop Two',       'SA-2',    'ACTIVE'),
    (v_shop_3,        v_a, 'Shop Three',     'SA-3',    'ACTIVE'),
    (v_shop_unassign, v_a, 'Shop Unassigned','SA-UN',   'ACTIVE'),
    (v_shop_removed,  v_a, 'Shop Removed',   'SA-RM',   'ACTIVE'),
    -- Neither shop is ACTIVE. Both ASSIGNMENTS below are LIVE, which is the point: the shop's
    -- own status has to be what refuses them. retailer_shops.status admits exactly ACTIVE,
    -- SUSPENDED and DEACTIVATED, so both non-active states are covered rather than one.
    (v_shop_deact,    v_a, 'Shop Closed',    'SA-DE',   'DEACTIVATED'),
    (v_shop_susp,     v_a, 'Shop Suspended', 'SA-SU',   'SUSPENDED'),
    (v_shop_other,    v_b, 'Shop Other',     'SB-1',    'ACTIVE');

  insert into t_ids values
    ('shop_solo', v_shop_solo),
    ('shop_1', v_shop_1), ('shop_2', v_shop_2), ('shop_3', v_shop_3),
    ('shop_unassigned', v_shop_unassign),
    ('shop_removed', v_shop_removed),
    ('shop_deactivated', v_shop_deact),
    ('shop_suspended', v_shop_susp),
    ('shop_other', v_shop_other);

  perform pg_temp.grant_role((select id from t_ids where label='owner_a'), v_a, 'RETAILER_OWNER');

  v_m_one  := pg_temp.grant_role((select id from t_ids where label='u_one'),  v_a, 'SALES_STAFF');
  v_m_many := pg_temp.grant_role((select id from t_ids where label='u_many'), v_a, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='u_none'),  v_a, 'SALES_STAFF');
  perform pg_temp.grant_role((select id from t_ids where label='u_other'), v_b, 'SALES_STAFF');

  insert into t_ids values ('m_one', v_m_one), ('m_many', v_m_many);

  -- LIVE assignments.
  insert into public.retailer_shop_members (retailer_shop_id, organization_member_id) values
    (v_shop_solo, v_m_one),
    (v_shop_1, v_m_many),
    (v_shop_2, v_m_many),
    (v_shop_3, v_m_many),
    -- Live assignments to shops that are NOT active. The shops' own status must refuse them.
    (v_shop_deact, v_m_many),
    (v_shop_susp, v_m_many);

  -- A REMOVED assignment: the row exists, and removed_at makes it dead.
  insert into public.retailer_shop_members
    (retailer_shop_id, organization_member_id, removed_at)
  values (v_shop_removed, v_m_many, now());
end;
$$;

-- ============================================================================
-- SECTION A — the assigned-shop list is the whole basis of the form's shape
-- ============================================================================
-- The three cases the web form distinguishes are the three counts this function can return,
-- and each is asserted as a COUNT rather than inferred from a rendering.

select pg_temp.act_as((select id from t_ids where label='u_one'));

select is(pg_temp.my_shop_count(), 1::bigint,
  'one shop: the caller is assigned to exactly one active shop — the form fixes it');
select is(pg_temp.my_shop_names(), array['Shop Solo'],
  'one shop: and it is the shop that was assigned');

select pg_temp.act_as((select id from t_ids where label='u_many'));

select is(pg_temp.my_shop_count(), 3::bigint,
  'many shops: three live assignments to ACTIVE shops — the form must ask');
select is(pg_temp.my_shop_names(), array['Shop One','Shop Three','Shop Two'],
  'many shops: the DEACTIVATED shop, the SUSPENDED shop and the REMOVED assignment are all absent');

select pg_temp.act_as((select id from t_ids where label='u_none'));

select is(pg_temp.my_shop_count(), 0::bigint,
  'no shops: an authorized submitter with no live assignment sees an EMPTY list, not an error');

-- A denial is NOT an empty list. An Owner cannot resolve RECEIPT_SUBMIT at all, and the
-- difference is what stops "you have no shops yet" being shown to somebody who is simply not a
-- submitter.
select pg_temp.act_as((select id from t_ids where label='owner_a'));
select throws_ok(
  'select * from public.list_my_assigned_receipt_shops()',
  '42501',
  null,
  'denial: a Retailer Owner is REFUSED rather than shown an empty shop list');

-- ============================================================================
-- SECTION B — a crafted submission cannot name a shop the caller is not assigned to
-- ============================================================================
-- Every call below is exactly the call a tampered browser would make: the reservation RPC
-- directly, with a shop id chosen by the caller. No form, no Server Action, no gate.

select pg_temp.act_as((select id from t_ids where label='u_many'));

-- The control: a shop they ARE assigned to succeeds, so the refusals below cannot be explained
-- by the fixture being broken.
select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_1'), 'a'),
  null,
  'assigned: reserving against a live assignment to an ACTIVE shop succeeds');

select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_unassigned'), 'b'),
  '42501',
  'UNASSIGNED SHOP: a shop of their own Retailer they were never assigned to is refused');

select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_removed'), 'c'),
  '42501',
  'REMOVED ASSIGNMENT: an assignment with removed_at set cannot be used');

select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_deactivated'), 'd'),
  '42501',
  'DEACTIVATED SHOP: a LIVE assignment to a closed shop cannot be used either');

select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_suspended'), 'd2'),
  '42501',
  'SUSPENDED SHOP: nor can a live assignment to a suspended one');

select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_other'), 'e'),
  '42501',
  'CROSS-TENANT: another Retailer''s shop is refused');

select is(
  pg_temp.reserve_sqlstate(gen_random_uuid(), 'f'),
  '42501',
  'NONEXISTENT: a shop id that does not exist is refused');

-- THE SECURITY PROPERTY, stated as an equality rather than as four separate facts: all five
-- wrong shops are indistinguishable, so the endpoint cannot be used to discover which shops
-- exist or who is assigned to them.
select is(
  array[
    pg_temp.reserve_sqlstate((select id from t_ids where label='shop_unassigned'), 'g'),
    pg_temp.reserve_sqlstate((select id from t_ids where label='shop_removed'), 'h'),
    pg_temp.reserve_sqlstate((select id from t_ids where label='shop_deactivated'), 'i'),
    pg_temp.reserve_sqlstate((select id from t_ids where label='shop_suspended'), 'i2'),
    pg_temp.reserve_sqlstate((select id from t_ids where label='shop_other'), 'j'),
    pg_temp.reserve_sqlstate(gen_random_uuid(), 'k')
  ],
  array['42501','42501','42501','42501','42501','42501'],
  'indistinguishable: unassigned, removed, closed, suspended, cross-tenant and nonexistent are ONE answer');

-- ============================================================================
-- SECTION C — the shop the browser was handed is not the authorization
-- ============================================================================
-- A person with exactly one assigned shop has that shop's id in a hidden input. This section
-- proves the hidden value is worth nothing on its own: the SAME id fails for a different
-- caller, and stops working for its own owner the moment the assignment is withdrawn.

select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_solo'), 'l'),
  '42501',
  'hidden value: u_many cannot use the shop id u_one''s form would have carried');

select pg_temp.act_as((select id from t_ids where label='u_none'));
select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_solo'), 'm'),
  '42501',
  'hidden value: nor can an unassigned submitter of the same Retailer');

-- WITHDRAWAL TAKES EFFECT ON THE VERY NEXT REQUEST. The session is never re-issued: the only
-- thing that changes is removed_at on one row.
select pg_temp.act_as((select id from t_ids where label='u_one'));
select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_solo'), 'n'),
  null,
  'withdrawal: while assigned, u_one can submit for their one shop');

update public.retailer_shop_members
   set removed_at = now()
 where organization_member_id = (select id from t_ids where label='m_one')
   and retailer_shop_id = (select id from t_ids where label='shop_solo');

select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_solo'), 'o'),
  '42501',
  'withdrawal: the very next request is refused — same session, no sign-out');
select is(pg_temp.my_shop_count(), 0::bigint,
  'withdrawal: and the shop list is now empty, so the form falls to its unassigned state');

-- CLOSING THE SHOP HAS THE SAME EFFECT, through the shop's status rather than the assignment.
select pg_temp.act_as((select id from t_ids where label='u_many'));
update public.retailer_shops
   set status = 'DEACTIVATED'
 where id = (select id from t_ids where label='shop_1');

select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_1'), 'p'),
  '42501',
  'closure: a shop that has just been deactivated can no longer be submitted against');
select is(pg_temp.my_shop_count(), 2::bigint,
  'closure: and it leaves the assigned-shop list immediately');

-- ============================================================================
-- SECTION D — an unauthenticated caller reserves nothing
-- ============================================================================
select pg_temp.sign_out();

select is(
  pg_temp.reserve_sqlstate((select id from t_ids where label='shop_2'), 'q'),
  '42501',
  'signed out: no shop id is enough on its own — auth.uid() is the authority');

select throws_ok(
  'select * from public.list_my_assigned_receipt_shops()',
  '42501',
  null,
  'signed out: and the shop list itself is refused');

select * from finish();
rollback;
