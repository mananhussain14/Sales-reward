-- pgTAP behavioural tests for AUDIT-LOG APPEND-ONLY HARDENING:
--
--   public.audit_logs_guard_change()    (trigger)   [20260816090000]
--   public.audit_logs_guard_truncate()  (trigger)   [20260816090000]
--   the service_role privilege revoke               [20260816090000]
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- WHAT THIS SUITE IS FOR
-- ============================================================================
-- Migration 20260716130351 described audit_logs as "append-only by design", but nothing
-- enforced it: no trigger refused an UPDATE or a DELETE, and service_role retained TRUNCATE,
-- which bypasses row triggers entirely. The reward-evaluation milestones will lean on this
-- table to explain why a coin was credited, so the claim has to be a property of the schema.
--
-- The suite proves FOUR things, and the fourth is the one most likely to be got wrong:
--
--   1. an existing authorized operation can still WRITE an audit row;
--   2. UPDATE and DELETE are refused, including a no-op UPDATE;
--   3. TRUNCATE is refused, and no application runtime role holds the privilege anyway;
--   4. THE FOREIGN-KEY ATTRIBUTION CLEAR STILL WORKS. audit_logs.organization_id and
--      audit_logs.actor_profile_id are both ON DELETE SET NULL, so deleting a user or an
--      organization performs an ORDINARY UPDATE on audit rows. A guard that refused every
--      UPDATE would make deleting a user impossible and would silently break a deliberate,
--      already-tested schema decision (vendor_audit_log_reads_test Section L).
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from request.jwt.claims, so setting that GUC
-- transaction-locally IS signing in as far as every authorization helper is concerned.
-- pg_temp.act_as() does exactly that, mirroring every other suite in this directory.
--
-- Everything runs inside one transaction and is rolled back. no_plan() rather than plan(N):
-- a hard-coded count that drifts turns an added test into a confusing failure about
-- arithmetic rather than about behaviour.

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

create function pg_temp.new_person(p_first text, p_last text) returns uuid
language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || lower(p_last) || '@test.invalid');
  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, 'ACTIVE');
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

create function pg_temp.add_member(p_user uuid, p_org uuid) returns uuid
language plpgsql as $$
declare v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, 'ACTIVE', now() - interval '30 days')
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

do $$
declare
  v_vendor uuid; v_ada uuid; v_member uuid;
  v_doomed uuid; v_doomed_org uuid;
begin
  v_vendor := pg_temp.new_org('Vendor A', 'VENDOR');
  v_ada    := pg_temp.new_person('Ada', 'Admin');
  v_member := pg_temp.add_member(v_ada, v_vendor);
  perform pg_temp.add_role(v_member, 'VENDOR_SUPER_ADMIN');

  -- A person and an organization that exist only to be hard-deleted in Section E, so the
  -- SET NULL path is exercised without disturbing anything else in the suite.
  v_doomed     := pg_temp.new_person('Doomed', 'Actor');
  v_doomed_org := pg_temp.new_org('Doomed Org', 'VENDOR');

  insert into pg_temp.f values
    ('vendor', v_vendor), ('ada', v_ada),
    ('doomed', v_doomed), ('doomed_org', v_doomed_org);
end;
$$;

-- A row written directly, standing in for any of the 33 SECURITY DEFINER writers. Section B
-- separately proves a REAL operation still writes.
do $$
declare v_id uuid;
begin
  insert into public.audit_logs (organization_id, actor_profile_id, action, entity_type, entity_id, metadata)
  values (pg_temp.id('vendor'), pg_temp.id('ada'), 'FIXTURE_EVENT', 'THING', 'x', '{"a":1}'::jsonb)
  returning id into v_id;
  insert into pg_temp.f values ('row', v_id);

  -- Attributed to the doomed person AND the doomed organization, so one delete of each
  -- exercises both SET NULL columns.
  insert into public.audit_logs (organization_id, actor_profile_id, action, entity_type)
  values (pg_temp.id('doomed_org'), pg_temp.id('doomed'), 'DOOMED_EVENT', 'THING')
  returning id into v_id;
  insert into pg_temp.f values ('doomed_row', v_id);
end;
$$;

-- ============================================================================
-- SECTION A — the privilege surface
-- ============================================================================
select ok(
  (select relrowsecurity from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'audit_logs'),
  'A1. audit_logs still has row level security enabled'
);

-- The existing read policy is LOAD-BEARING: lib/audit/vendor-audit-logs.ts and
-- lib/dashboard/vendor-admin-summary.ts both select from this table with the user-scoped
-- client. The hardening migration must not have disturbed it.
select is(
  (select count(*)::integer from pg_catalog.pg_policy p
   join pg_catalog.pg_class c on c.oid = p.polrelid
   where c.relname = 'audit_logs' and p.polname = 'audit_logs_select_authorized'),
  1,
  'A2. audit_logs_select_authorized survives the hardening migration'
);

select ok(
  has_table_privilege('authenticated', 'public.audit_logs', 'SELECT'),
  'A3. authenticated keeps SELECT — the browser read path is untouched'
);

select ok(
  not has_table_privilege('service_role', 'public.audit_logs', 'TRUNCATE'),
  'A4. service_role cannot TRUNCATE — the one privilege that bypasses row triggers'
);

select ok(
  not has_table_privilege('service_role', 'public.audit_logs', 'UPDATE')
  and not has_table_privilege('service_role', 'public.audit_logs', 'DELETE'),
  'A5. service_role holds neither UPDATE nor DELETE'
);

select ok(
  not has_table_privilege('service_role', 'public.audit_logs', 'INSERT')
  and not has_table_privilege('service_role', 'public.audit_logs', 'SELECT'),
  'A6. service_role holds no INSERT and no SELECT either — every audit path is SECURITY DEFINER'
);

-- The application runtime roles, checked together and explicitly for TRUNCATE.
select ok(
  not has_table_privilege('authenticated', 'public.audit_logs', 'TRUNCATE')
  and not has_table_privilege('anon',      'public.audit_logs', 'TRUNCATE')
  and not has_table_privilege('service_role', 'public.audit_logs', 'TRUNCATE'),
  'A7. NO application runtime role holds direct TRUNCATE authority'
);

select ok(
  not has_table_privilege('authenticated', 'public.audit_logs', 'INSERT')
  and not has_table_privilege('authenticated', 'public.audit_logs', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.audit_logs', 'DELETE'),
  'A8. authenticated can read and nothing else'
);

select ok(
  not has_table_privilege('anon', 'public.audit_logs', 'SELECT'),
  'A9. anon cannot read audit history at all'
);

-- ============================================================================
-- SECTION B — a real authorized operation still writes an audit row
-- ============================================================================
-- The whole point of the revoke analysis: all 33 audit writers are SECURITY DEFINER and run
-- as the table owner, so no role-level revoke can reach them. Proved with a genuine RPC
-- rather than a direct INSERT, because a direct INSERT would run as the test's own role and
-- would prove nothing about the shipped path.
select pg_temp.act_as(pg_temp.id('ada'));

select lives_ok(
  $$ select public.create_vendor_product('AUD-1', 'Audited Product', null, null, null) $$,
  'B1. an authorized Vendor operation still succeeds after the hardening'
);

select is(
  (select count(*)::integer from public.audit_logs a
   where a.organization_id = pg_temp.id('vendor')
     and a.action = 'PRODUCT_CREATED'),
  1,
  'B2. and it wrote its audit row — the SECURITY DEFINER path is unaffected by the revoke'
);

-- The read path the browser actually uses, exercised end to end.
select ok(
  (select count(*) from public.list_vendor_audit_logs(100, null, null)) >= 2::bigint,
  'B3. an authorized audit READ still returns rows'
);

-- ============================================================================
-- SECTION C — UPDATE and DELETE are refused
-- ============================================================================
select throws_ok(
  format($$ update public.audit_logs set action = 'TAMPERED' where id = %L $$, pg_temp.id('row')),
  '23514', 'An audit log record is immutable',
  'C1. an audit row''s action cannot be rewritten'
);

select throws_ok(
  format($$ update public.audit_logs set metadata = '{"a":2}'::jsonb where id = %L $$, pg_temp.id('row')),
  '23514', 'An audit log record is immutable',
  'C2. nor its metadata'
);

select throws_ok(
  format($$ update public.audit_logs set created_at = now() where id = %L $$, pg_temp.id('row')),
  '23514', 'An audit log record is immutable',
  'C3. nor its timestamp — back-dating an event is exactly what this prevents'
);

-- A no-op UPDATE is not a foreign-key attribution clear; it is a probe. Letting it succeed
-- would mean "this row accepted an UPDATE", which is the one answer the table must never give.
select throws_ok(
  format($$ update public.audit_logs set action = action where id = %L $$, pg_temp.id('row')),
  '23514', 'An audit log record is immutable',
  'C4. a NO-OP update is refused too'
);

select throws_ok(
  format($$ delete from public.audit_logs where id = %L $$, pg_temp.id('row')),
  '23514', 'An audit log record is append-only and cannot be deleted',
  'C5. an audit row cannot be deleted'
);

select throws_ok(
  $$ delete from public.audit_logs $$,
  '23514', 'An audit log record is append-only and cannot be deleted',
  'C6. nor can the whole table be emptied row by row'
);

-- ============================================================================
-- SECTION D — TRUNCATE is refused by the database, not merely unprivileged
-- ============================================================================
-- Row triggers do NOT fire on TRUNCATE, so the guard in Section C is completely bypassed by
-- one TRUNCATE statement. This is the second, independent defence, and it binds the table
-- OWNER as well — which is what makes it worth having alongside the revoke.
select throws_ok(
  $$ truncate public.audit_logs $$,
  '23514', 'An audit log record is append-only and cannot be truncated',
  'D1. TRUNCATE is refused even for the table owner'
);

select throws_ok(
  $$ truncate table public.audit_logs cascade $$,
  '23514', 'An audit log record is append-only and cannot be truncated',
  'D2. and the CASCADE form is refused identically'
);

-- ============================================================================
-- SECTION E — the ONE update that must still work
-- ============================================================================
-- audit_logs.actor_profile_id REFERENCES profiles ON DELETE SET NULL, and
-- audit_logs.organization_id  REFERENCES organizations ON DELETE SET NULL.
--
-- Deleting an auth user cascades to public.profiles, and PostgreSQL then UPDATEs every audit
-- row that named that profile. If the guard refused it, deleting a user would become
-- impossible — so this section is the regression test for the guard's single exemption.
select lives_ok(
  format($$ delete from auth.users where id = %L $$, pg_temp.id('doomed')),
  'E1. deleting an auth user still succeeds — the SET NULL update is permitted'
);

select is(
  (select actor_profile_id from public.audit_logs where id = pg_temp.id('doomed_row')),
  null,
  'E2. and the audit row''s actor was cleared'
);

select is(
  (select action from public.audit_logs where id = pg_temp.id('doomed_row')),
  'DOOMED_EVENT',
  'E3. while the row itself and its content survive intact'
);

select lives_ok(
  format($$ delete from public.organizations where id = %L $$, pg_temp.id('doomed_org')),
  'E4. deleting an organization still succeeds — the other SET NULL column'
);

select is(
  (select organization_id from public.audit_logs where id = pg_temp.id('doomed_row')),
  null,
  'E5. and the audit row''s organization was cleared'
);

-- The exemption is exactly one direction wide. Attribution is given up permanently; it is
-- never restored, and never moved to somebody else.
select throws_ok(
  format($$ update public.audit_logs set actor_profile_id = %L where id = %L $$,
         pg_temp.id('ada'), pg_temp.id('doomed_row')),
  '23514', 'An audit log record is immutable',
  'E6. a cleared actor cannot be RESTORED'
);

select throws_ok(
  format($$ update public.audit_logs set organization_id = %L where id = %L $$,
         pg_temp.id('vendor'), pg_temp.id('doomed_row')),
  '23514', 'An audit log record is immutable',
  'E7. nor can a cleared organization'
);

select throws_ok(
  format($$ update public.audit_logs set actor_profile_id = %L where id = %L $$,
         pg_temp.id('doomed'), pg_temp.id('row')),
  '23514', 'An audit log record is immutable',
  'E8. and a LIVE attribution cannot be re-pointed at somebody else'
);

-- A clear must also not smuggle any other change alongside it.
select throws_ok(
  format($$ update public.audit_logs
            set actor_profile_id = null, action = 'SMUGGLED' where id = %L $$,
         pg_temp.id('row')),
  '23514', 'An audit log record is immutable',
  'E9. a legitimate clear cannot carry an illegitimate edit with it'
);

select * from finish();
rollback;
