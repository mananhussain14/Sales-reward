-- pgTAP behavioural tests for RETAILER SHOP TIME ZONE MANAGEMENT:
--
--   the SHOP_TIMEZONE_MANAGE permission and its single role mapping [20260818090000]
--   public.set_retailer_shop_timezone(uuid, text)
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- Migration 20260817210000 added retailer_shops.timezone_name and made
-- resolve_sale_instant refuse while it is null, but added no writer. This is the writer,
-- and it configures the setting that decides WHICH INSTANT a printed sale time refers to
-- — and therefore which campaign window a sale falls into. So the suite is weighted
-- towards the two things that would cost money if they were wrong:
--
--   * exactly one role may do it, and no other role can reach it (Section B); and
--   * a foreign shop is indistinguishable from one that does not exist (Section C).
--
-- Section E is the other half of the milestone's promise: the Phase 0 validation rules
-- are the SOLE authority and this function did not quietly loosen any of them.
--
-- Everything runs inside one transaction and is rolled back. no_plan(), per the
-- convention every suite in this directory follows.

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers and fixture
-- ============================================================================
create function pg_temp.act_as(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text)::text, true);
end;
$$;

create function pg_temp.sign_out() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create function pg_temp.new_person(
  p_first text, p_last text, p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || lower(p_last) || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, p_status);
  return v_id;
end;
$$;

create function pg_temp.new_org(p_name text, p_type text) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  insert into public.organizations (name, organization_type, status, country_code, default_currency)
  values (p_name, p_type, 'ACTIVE', 'AE', 'AED')
  returning id into v_id;
  return v_id;
end;
$$;

create function pg_temp.add_member(
  p_user uuid, p_org uuid, p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, p_status, now() - interval '30 days')
  returning id into v_member;
  return v_member;
end;
$$;

create function pg_temp.add_role(p_member uuid, p_role_code text) returns void
language plpgsql as $$
begin
  insert into public.member_roles (organization_member_id, role_id)
  select p_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;
end;
$$;

create table pg_temp.f (k text primary key, v uuid);
create function pg_temp.id(p text) returns uuid language sql stable as $$
  select v from pg_temp.f where k = p
$$;

/* The stored zone of the primary fixture shop. */
create function pg_temp.tz_of(p_shop uuid) returns text
language sql stable as $$
  select s.timezone_name from public.retailer_shops s where s.id = p_shop
$$;

/* Attempts the setter and reports the SQLSTATE, or null when it succeeded. Lets the
   accept/reject tables below stay readable, and keeps a refusal from aborting the suite. */
create function pg_temp.try_set(p_shop uuid, p_tz text) returns text
language plpgsql as $$
declare v text;
begin
  select r.timezone_name into v
  from public.set_retailer_shop_timezone(p_shop, p_tz) r;
  return null;
exception when others then
  return sqlstate;
end;
$$;

create function pg_temp.audit_count(p_shop uuid) returns integer
language sql stable as $$
  select count(*)::integer from public.audit_logs a
  where a.entity_type = 'RETAILER_SHOP' and a.entity_id = p_shop::text
    and a.action in ('SHOP_TIMEZONE_CONFIGURED', 'SHOP_TIMEZONE_CHANGED')
$$;

do $$
declare
  v_vendor uuid; v_vendor_b uuid; v_ret uuid; v_ret_b uuid;
  v_ada uuid; v_member uuid;
  v_shop uuid; v_shop_two uuid; v_foreign_shop uuid;
begin
  v_vendor   := pg_temp.new_org('Vendor A', 'VENDOR');
  v_vendor_b := pg_temp.new_org('Vendor B', 'VENDOR');
  v_ret      := pg_temp.new_org('Retailer Alpha', 'RETAILER');
  v_ret_b    := pg_temp.new_org('Retailer Bravo', 'RETAILER');

  insert into public.vendor_retailers (vendor_organization_id, retailer_organization_id, status)
  values (v_vendor, v_ret, 'ACTIVE'), (v_vendor_b, v_ret_b, 'ACTIVE');

  -- The authorized operator.
  v_ada    := pg_temp.new_person('Ada', 'Admin');
  v_member := pg_temp.add_member(v_ada, v_vendor);
  perform pg_temp.add_role(v_member, 'VENDOR_SUPER_ADMIN');

  insert into public.retailer_shops (retailer_organization_id, name, city, country_code)
  values (v_ret, 'Alpha Shop One', 'Dubai', 'AE') returning id into v_shop;
  insert into public.retailer_shops (retailer_organization_id, name)
  values (v_ret, 'Alpha Shop Two') returning id into v_shop_two;
  -- Vendor B's shop: a real row this caller must never be able to touch.
  insert into public.retailer_shops (retailer_organization_id, name)
  values (v_ret_b, 'Bravo Shop') returning id into v_foreign_shop;

  insert into pg_temp.f values
    ('vendor', v_vendor), ('vendor_b', v_vendor_b),
    ('ret', v_ret), ('ret_b', v_ret_b),
    ('ada', v_ada),
    ('shop', v_shop), ('shop_two', v_shop_two), ('foreign_shop', v_foreign_shop);
end;
$$;

-- ============================================================================
-- SECTION A — the permission and its mapping
-- ============================================================================
select is(
  (select count(*)::integer from public.permissions where code = 'SHOP_TIMEZONE_MANAGE'),
  1,
  'A1. the SHOP_TIMEZONE_MANAGE permission exists'
);

select is(
  (select module from public.permissions where code = 'SHOP_TIMEZONE_MANAGE'),
  'RETAILERS',
  'A2. and is filed under the RETAILERS module'
);

-- The whole separation-of-duties claim in one assertion.
select is(
  (select coalesce(string_agg(r.code, ',' order by r.code), '(none)')
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'SHOP_TIMEZONE_MANAGE'),
  'VENDOR_SUPER_ADMIN',
  'A3. it is mapped to VENDOR_SUPER_ADMIN and to NOTHING else'
);

-- Named individually so a future mapping mistake says exactly who gained it.
select is(
  (select count(*)::integer
   from public.role_permissions rp
   join public.roles r on r.id = rp.role_id
   join public.permissions p on p.id = rp.permission_id
   where p.code = 'SHOP_TIMEZONE_MANAGE'
     and r.code in ('CLAIM_REVIEWER', 'FINANCE_ADMIN', 'RETAILER_OWNER',
                    'RETAILER_MANAGER', 'SALES_STAFF')),
  0,
  'A4. no reviewer, finance, owner, manager or staff role holds it'
);

select ok(
  not has_table_privilege('authenticated', 'public.retailer_shops', 'UPDATE'),
  'A5. `authenticated` still has NO direct UPDATE on retailer_shops — the RPC is the only door'
);

select ok(
  not has_table_privilege('service_role', 'public.retailer_shops', 'UPDATE')
  and not has_function_privilege('service_role',
        'public.set_retailer_shop_timezone(uuid, text)', 'EXECUTE'),
  'A6. service_role gains no direct timezone-management authority'
);

select ok(
  has_function_privilege('authenticated',
    'public.set_retailer_shop_timezone(uuid, text)', 'EXECUTE'),
  'A7. `authenticated` may call the setter — which then decides for itself'
);

select ok(
  not has_function_privilege('anon',
    'public.set_retailer_shop_timezone(uuid, text)', 'EXECUTE'),
  'A8. anon may not call it at all'
);

-- ============================================================================
-- SECTION B — who may configure a time zone
-- ============================================================================
-- Every refusal below must be SQLSTATE 42501 and must be byte-identical, so no caller
-- can tell "you are not authorized" from "no such shop".
select pg_temp.sign_out();
select is(pg_temp.try_set(pg_temp.id('shop'), 'Asia/Dubai'), '42501',
  'B1. a signed-out caller is refused');

select pg_temp.act_as(pg_temp.id('ada'));
select is(pg_temp.try_set(pg_temp.id('shop'), 'Asia/Dubai'), null,
  'B2. the Vendor Super Admin MAY configure a shop in their own Vendor scope');

select is(pg_temp.tz_of(pg_temp.id('shop')), 'Asia/Dubai',
  'B3. and the value is stored');

select is(pg_temp.try_set(pg_temp.id('shop'), 'Europe/London'), null,
  'B4. and may CHANGE it afterwards');

select is(pg_temp.tz_of(pg_temp.id('shop')), 'Europe/London',
  'B5. with the new value stored');

-- --- every other role is refused --------------------------------------------
-- Each is a real, ACTIVE member of the SAME Vendor organization holding ONLY the named
-- role, so the refusal is attributable to the missing permission and to nothing else.
do $$
declare v_p uuid; v_m uuid; v_code text;
begin
  foreach v_code in array array['CLAIM_REVIEWER','FINANCE_ADMIN','RETAILER_OWNER',
                                'RETAILER_MANAGER','SALES_STAFF'] loop
    v_p := pg_temp.new_person('Role', replace(initcap(lower(v_code)), '_', ''));
    v_m := pg_temp.add_member(v_p, pg_temp.id('vendor'));
    perform pg_temp.add_role(v_m, v_code);
    insert into pg_temp.f values ('actor_' || v_code, v_p);
  end loop;
end;
$$;

select pg_temp.act_as(pg_temp.id('actor_CLAIM_REVIEWER'));
select is(pg_temp.try_set(pg_temp.id('shop'), 'Asia/Kuwait'), '42501',
  'B6. a CLAIM_REVIEWER is refused — a reviewer reports a wrong zone, never sets it');

select pg_temp.act_as(pg_temp.id('actor_FINANCE_ADMIN'));
select is(pg_temp.try_set(pg_temp.id('shop'), 'Asia/Kuwait'), '42501',
  'B7. a FINANCE_ADMIN is refused');

select pg_temp.act_as(pg_temp.id('actor_RETAILER_OWNER'));
select is(pg_temp.try_set(pg_temp.id('shop'), 'Asia/Kuwait'), '42501',
  'B8. a RETAILER_OWNER is refused — the beneficiary must not set the financial clock');

select pg_temp.act_as(pg_temp.id('actor_RETAILER_MANAGER'));
select is(pg_temp.try_set(pg_temp.id('shop'), 'Asia/Kuwait'), '42501',
  'B9. a RETAILER_MANAGER is refused');

select pg_temp.act_as(pg_temp.id('actor_SALES_STAFF'));
select is(pg_temp.try_set(pg_temp.id('shop'), 'Asia/Kuwait'), '42501',
  'B10. a SALES_STAFF member is refused');

select is(pg_temp.tz_of(pg_temp.id('shop')), 'Europe/London',
  'B11. and after all five refusals the stored zone is untouched');

-- --- an authorized role whose account or membership is not ACTIVE ------------
do $$
declare v_p uuid; v_m uuid;
begin
  -- SUSPENDED profile, ACTIVE membership, correct role.
  v_p := pg_temp.new_person('Sus', 'Pended', 'SUSPENDED');
  v_m := pg_temp.add_member(v_p, pg_temp.id('vendor'));
  perform pg_temp.add_role(v_m, 'VENDOR_SUPER_ADMIN');
  insert into pg_temp.f values ('inactive_profile', v_p);

  -- ACTIVE profile, DEACTIVATED membership, correct role.
  v_p := pg_temp.new_person('Ex', 'Member');
  v_m := pg_temp.add_member(v_p, pg_temp.id('vendor'), 'DEACTIVATED');
  perform pg_temp.add_role(v_m, 'VENDOR_SUPER_ADMIN');
  insert into pg_temp.f values ('inactive_member', v_p);
end;
$$;

select pg_temp.act_as(pg_temp.id('inactive_profile'));
select is(pg_temp.try_set(pg_temp.id('shop'), 'Asia/Kuwait'), '42501',
  'B12. an INACTIVE PROFILE holding the role is refused');

select pg_temp.act_as(pg_temp.id('inactive_member'));
select is(pg_temp.try_set(pg_temp.id('shop'), 'Asia/Kuwait'), '42501',
  'B13. a DEACTIVATED MEMBERSHIP holding the role is refused');

-- ============================================================================
-- SECTION C — a foreign shop is indistinguishable from a missing one
-- ============================================================================
select pg_temp.act_as(pg_temp.id('ada'));

select is(pg_temp.try_set(pg_temp.id('foreign_shop'), 'Asia/Dubai'), '42501',
  'C1. another Vendor''s shop is refused');

select is(pg_temp.try_set(gen_random_uuid(), 'Asia/Dubai'), '42501',
  'C2. an unknown shop id is refused');

-- The claim that matters: the two are the SAME refusal, so the function cannot be swept
-- to discover which shop ids are real.
select is(
  pg_temp.try_set(pg_temp.id('foreign_shop'), 'Asia/Dubai'),
  pg_temp.try_set(gen_random_uuid(), 'Asia/Dubai'),
  'C3. a foreign shop and an unknown id produce the IDENTICAL failure'
);

select throws_ok(
  format($$ select * from public.set_retailer_shop_timezone(%L, 'Asia/Dubai') $$,
         pg_temp.id('foreign_shop')),
  '42501', 'Not authorized to configure this shop time zone',
  'C4. and the message names no shop, no Vendor and no reason'
);

select is(pg_temp.tz_of(pg_temp.id('foreign_shop')), null,
  'C5. the foreign shop''s zone was never written');

select is(pg_temp.try_set(null, 'Asia/Dubai'), '42501',
  'C6. a null shop id is refused the same way');

-- ============================================================================
-- SECTION D — the no-op
-- ============================================================================
-- Currently Europe/London from B4.
select is(
  (select changed from public.set_retailer_shop_timezone(pg_temp.id('shop'), 'Europe/London')),
  false,
  'D1. re-submitting the SAME zone reports changed = false'
);

select is(
  (select r.timezone_name from public.set_retailer_shop_timezone(pg_temp.id('shop'), 'Europe/London') r),
  'Europe/London',
  'D2. and still returns the authoritative stored value'
);

-- The audit trail must record CHANGES, not attempts. B2 wrote one CONFIGURED row and B4
-- one CHANGED row; the two no-ops above must have added nothing.
select is(pg_temp.audit_count(pg_temp.id('shop')), 2,
  'D3. a no-op writes NO audit row — the trail records changes, not submissions');

-- The early return is proved PHYSICALLY, via ctid. Every UPDATE writes a new tuple and
-- moves a row's ctid, even one that sets a column to the value it already holds — so an
-- unchanged ctid across the call means the UPDATE genuinely never ran.
--
-- updated_at cannot be used for this: set_updated_at() stamps now(), which is frozen for
-- the whole transaction, so it would read identically whether the row was rewritten or
-- not. ctid is the only signal here that distinguishes the two.
do $$
declare v_before tid; v_after tid; v_changed tid;
begin
  select s.ctid into v_before from public.retailer_shops s where s.id = pg_temp.id('shop');
  perform public.set_retailer_shop_timezone(pg_temp.id('shop'), 'Europe/London'); -- no-op
  select s.ctid into v_after from public.retailer_shops s where s.id = pg_temp.id('shop');
  perform public.set_retailer_shop_timezone(pg_temp.id('shop'), 'Asia/Kuwait');   -- real
  select s.ctid into v_changed from public.retailer_shops s where s.id = pg_temp.id('shop');
  create temporary table _ctid as select v_before as before, v_after as after, v_changed as changed;
end;
$$;

select is(
  (select (after = before) from _ctid),
  true,
  'D4. a no-op does not rewrite the row at all — its physical tuple is untouched'
);

select is(
  (select (changed <> after) from _ctid),
  true,
  'D5. while a real change does rewrite it — proving D4 is not a false negative'
);

-- Restore the zone the later sections expect.
select is(
  (select r.timezone_name from public.set_retailer_shop_timezone(pg_temp.id('shop'), 'Europe/London') r),
  'Europe/London',
  'D6. and the fixture zone is restored for the sections below'
);

-- ============================================================================
-- SECTION E — validation is the PHASE 0 contract, unchanged
-- ============================================================================
-- Every rejection below is 23514, raised by retailer_shops_timezone_name_shape or by
-- retailer_shops_assert_timezone(). The setter restates neither rule; these assertions
-- exist to prove it did not loosen them either.
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'UTC+3'), '23514',
  'E1. UTC+3 is refused — an offset is not a place');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'GMT+3'), '23514',
  'E2. GMT+3 likewise');
select is(pg_temp.try_set(pg_temp.id('shop_two'), '+04:00'), '23514',
  'E3. and a bare numeric offset');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'UTC'), '23514',
  'E4. bare UTC is refused — a retail shop is somewhere, and UTC is nowhere');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'EST'), '23514',
  'E5. and a bare abbreviation PostgreSQL would otherwise accept');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'Etc/GMT+3'), '23514',
  'E6. Etc/GMT+3 is refused — a fixed offset wearing a region-shaped name');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'Etc/UTC'), '23514',
  'E7. and every other Etc/ entry');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'Europe/Atlantis'), '23514',
  'E8. a well-shaped name that does not exist is refused by the catalogue');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'asia/dubai'), '23514',
  'E9. the catalogue is case-sensitive — a lower-cased name is not a real zone');
select is(pg_temp.try_set(pg_temp.id('shop_two'), '  Asia/Dubai  '), '23514',
  'E10. an untrimmed value is refused rather than silently trimmed');
select is(pg_temp.try_set(pg_temp.id('shop_two'), ''), '23514',
  'E11. the empty string is refused');
select is(pg_temp.try_set(pg_temp.id('shop_two'), null), '23514',
  'E12. a NULL zone is refused — unsetting is not this operation');

select is(pg_temp.tz_of(pg_temp.id('shop_two')), null,
  'E13. after twelve refusals the shop is still unconfigured — no partial write');

select is(pg_temp.audit_count(pg_temp.id('shop_two')), 0,
  'E14. and no audit row was written for any of them');

-- --- and the values that must be accepted -----------------------------------
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'Asia/Dubai'), null,
  'E15. Asia/Dubai is accepted');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'Asia/Kuwait'), null,
  'E16. Asia/Kuwait is accepted');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'Europe/Paris'), null,
  'E17. Europe/Paris is accepted');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'America/New_York'), null,
  'E18. America/New_York is accepted — underscores and all');
select is(pg_temp.try_set(pg_temp.id('shop_two'), 'America/Argentina/Buenos_Aires'), null,
  'E19. a THREE-segment name is accepted');

select is(pg_temp.tz_of(pg_temp.id('shop_two')), 'America/Argentina/Buenos_Aires',
  'E20. and the stored value is the identifier verbatim');

-- ============================================================================
-- SECTION F — the audit trail
-- ============================================================================
do $$
declare v_shop uuid;
begin
  insert into public.retailer_shops (retailer_organization_id, name)
  values (pg_temp.id('ret'), 'Audit Shop') returning id into v_shop;
  insert into pg_temp.f values ('audit_shop', v_shop);
end;
$$;

select is((select changed from public.set_retailer_shop_timezone(pg_temp.id('audit_shop'), 'Asia/Dubai')),
  true, 'F1. configuring a fresh shop reports changed = true');

select is(
  (select action from public.audit_logs
   where entity_type = 'RETAILER_SHOP' and entity_id = pg_temp.id('audit_shop')::text),
  'SHOP_TIMEZONE_CONFIGURED',
  'F2. NULL -> value writes SHOP_TIMEZONE_CONFIGURED'
);

select is(
  (select metadata from public.audit_logs
   where entity_type = 'RETAILER_SHOP' and entity_id = pg_temp.id('audit_shop')::text),
  jsonb_build_object('timezone_name', 'Asia/Dubai'),
  'F3. and its metadata carries the zone and NOTHING else'
);

select is(
  (select a.organization_id from public.audit_logs a
   where a.entity_type = 'RETAILER_SHOP' and a.entity_id = pg_temp.id('audit_shop')::text),
  pg_temp.id('vendor'),
  'F4. attributed to the DERIVED Vendor organization'
);

select is(
  (select a.actor_profile_id from public.audit_logs a
   where a.entity_type = 'RETAILER_SHOP' and a.entity_id = pg_temp.id('audit_shop')::text),
  pg_temp.id('ada'),
  'F5. and to the acting profile'
);

select is((select changed from public.set_retailer_shop_timezone(pg_temp.id('audit_shop'), 'Europe/Paris')),
  true, 'F6. changing it reports changed = true');

select is(
  (select action from public.audit_logs
   where entity_type = 'RETAILER_SHOP' and entity_id = pg_temp.id('audit_shop')::text
     and action = 'SHOP_TIMEZONE_CHANGED'),
  'SHOP_TIMEZONE_CHANGED',
  'F7. value -> value writes SHOP_TIMEZONE_CHANGED'
);

select is(
  (select metadata from public.audit_logs
   where entity_type = 'RETAILER_SHOP' and entity_id = pg_temp.id('audit_shop')::text
     and action = 'SHOP_TIMEZONE_CHANGED'),
  jsonb_build_object('timezone_before', 'Asia/Dubai', 'timezone_after', 'Europe/Paris'),
  'F8. carrying only the before and after zones'
);

-- The privacy claim, asserted rather than argued: no metadata key on ANY event this
-- migration writes may name a shop, a Retailer, a person, an address or a receipt.
select is(
  (select count(*)::integer
   from public.audit_logs a, lateral jsonb_object_keys(a.metadata) k
   where a.action in ('SHOP_TIMEZONE_CONFIGURED', 'SHOP_TIMEZONE_CHANGED')
     and k not in ('timezone_name', 'timezone_before', 'timezone_after')),
  0,
  'F9. no other metadata key appears on any timezone event, ever'
);

-- Audit rows are written in the SAME transaction as the change: a refused write leaves
-- neither. E13/E14 proved the pair for a rejected value; this proves it for a rejected
-- CALLER, where the function raises before reaching the update at all.
select pg_temp.act_as(pg_temp.id('actor_SALES_STAFF'));
select is(pg_temp.try_set(pg_temp.id('audit_shop'), 'Asia/Kuwait'), '42501',
  'F10. an unauthorized change is refused');
select pg_temp.act_as(pg_temp.id('ada'));
select is(pg_temp.audit_count(pg_temp.id('audit_shop')), 2,
  'F11. and wrote no audit row — the count is unchanged');
select is(pg_temp.tz_of(pg_temp.id('audit_shop')), 'Europe/Paris',
  'F12. and left the stored zone alone');

-- ============================================================================
-- SECTION G — the point of the whole milestone
-- ============================================================================
-- Before configuration resolve_sale_instant refuses; after it, a sale resolves. This is
-- the property every later verification milestone depends on.
do $$
declare v_shop uuid;
begin
  insert into public.retailer_shops (retailer_organization_id, name)
  values (pg_temp.id('ret'), 'Resolver Shop') returning id into v_shop;
  insert into pg_temp.f values ('resolver_shop', v_shop);
end;
$$;

select throws_ok(
  format($$ select * from public.resolve_sale_instant(%L, date '2026-03-15', time '14:30') $$,
         pg_temp.id('resolver_shop')),
  '55000', 'That shop has no time zone recorded, so a sale instant cannot be resolved',
  'G1. before configuration, a sale instant cannot be resolved'
);

select is((select changed from public.set_retailer_shop_timezone(pg_temp.id('resolver_shop'), 'Asia/Dubai')),
  true, 'G2. the operator configures the shop');

select is(
  (select r.sale_at from public.resolve_sale_instant(
     pg_temp.id('resolver_shop'), date '2026-03-15', time '14:30') r),
  timestamptz '2026-03-15 10:30:00+00',
  'G3. and 14:30 in Asia/Dubai now resolves to 10:30 UTC'
);

select is(
  (select r.sale_time_precision from public.resolve_sale_instant(
     pg_temp.id('resolver_shop'), date '2026-03-15', null) r),
  'DATE_ONLY',
  'G4. and a date-only sale resolves at noon, reported DATE_ONLY'
);

-- ============================================================================
-- SECTION H — nothing else moved
-- ============================================================================
-- The setter touches ONE column. A shop's identity, address and lifecycle are not its
-- business, and neither is any other table.
select is(
  (select s.name || '|' || coalesce(s.city, '~') || '|' || coalesce(s.country_code, '~')
          || '|' || s.status || '|' || s.retailer_organization_id::text
   from public.retailer_shops s where s.id = pg_temp.id('shop')),
  'Alpha Shop One|Dubai|AE|ACTIVE|' || pg_temp.id('ret')::text,
  'H1. name, city, country, status and owning Retailer are all unchanged'
);

select is(
  (select count(*)::integer from public.campaign_version_status_history),
  0,
  'H2. no campaign status history row was written'
);

select is(
  (select count(*)::integer from public.vendor_product_status_history),
  0,
  'H3. and no product status history row — a timezone change rewrites no timeline'
);

select is(
  (select mode from public.receipt_extraction_runtime),
  'DISABLED',
  'H4. receipt extraction is still DISABLED'
);

select * from finish();
rollback;
