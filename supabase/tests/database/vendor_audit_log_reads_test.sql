-- pgTAP behavioural tests for the mobile Vendor Audit Log read contract:
--
--   public.list_vendor_audit_logs(integer, timestamptz, uuid)  [added by 20260804090000]
--
-- Run with:   supabase test db          (requires Docker + a local Supabase stack)
--
-- ============================================================================
-- HOW THESE TESTS IMPERSONATE A CALLER
-- ============================================================================
-- auth.uid() resolves the caller from the request's JWT claims, which Supabase exposes as the
-- `request.jwt.claims` GUC, so setting that GUC transaction-locally IS signing in as far as
-- every authorization helper in this schema is concerned. pg_temp.act_as() does exactly that
-- and pg_temp.sign_out() clears it. This mirrors portal_context_test.sql,
-- sales_staff_receipt_reads_test.sql, vendor_retailer_reads_test.sql, vendor_user_reads_test.sql,
-- vendor_role_reads_test.sql and vendor_product_reads_test.sql exactly, deliberately: seven
-- different impersonation idioms in one suite directory would be seven different claims about
-- what "signed in" means.
--
-- The tests deliberately do NOT `set role authenticated`. The function is SECURITY DEFINER, so
-- its behaviour depends on auth.uid() and not on the session role, and switching roles
-- mid-transaction would only make the fixture inserts fail. EXECUTE privilege is a separate
-- concern and is asserted directly against the catalogue in Section A, which is a stronger
-- check than "it did not error for me".
--
-- Everything runs inside one transaction and is rolled back, so no fixture survives — not the
-- audit rows inserted below, and not Section J, which temporarily removes a seeded
-- role→permission mapping.
--
-- no_plan() rather than plan(N): a hard-coded count that drifts out of step with the file
-- turns an added test into a confusing failure about arithmetic rather than about behaviour.
--
-- ============================================================================
-- WHY THE AUDIT ROWS ARE INSERTED DIRECTLY
-- ============================================================================
-- Not through create_vendor_product(), onboard_vendor_retailer() or any other writer. Three
-- reasons, all of them about what these tests are allowed to depend on:
--
--   1. Those functions derive the Vendor from auth.uid(), so seeding Vendor B's history would
--      mean signing in as Vendor B — making a read test depend on a write path it is not
--      testing, and on that write path continuing to emit exactly the same audit row.
--   2. created_at would be whatever now() returned. This suite needs EXACT, REPEATABLE
--      timestamps — including a group of rows that share one to the microsecond — because
--      cursor correctness at a tie is the single most important property here and it cannot be
--      asserted against timestamps the fixture did not choose.
--   3. No shipped writer produces a null actor, a foreign actor, a non-string metadata value,
--      a blank snapshot, an unknown entity type or a populated ip_address/user_agent column.
--      Those are exactly the states the contract must survive, and only a direct insert can
--      construct them.
--
-- The action codes, entity types and metadata KEYS used below are nonetheless the real ones,
-- copied from the shipped writers, so the whitelist is exercised against the vocabulary it was
-- built for rather than against invented names.
--
-- ============================================================================
-- WHAT "DENIED" MEANS HERE, AND WHY IT IS NEVER AN EMPTY PAGE
-- ============================================================================
-- The function RAISES 42501 for a caller who is not an authorized Vendor Super Admin holding
-- AUDIT_LOGS_READ, and 22023 for a malformed limit or a half-supplied cursor. It returns an
-- EMPTY LIST — never a raise — for an authorized Vendor with no history and for a cursor past
-- the oldest row. Sections B and I prove those three answers stay distinguishable, which is
-- what lets a client tell "you may not read this" from "there is nothing here" from "you have
-- reached the end".

begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ============================================================================
-- Helpers
-- ============================================================================
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

/* Creates an auth user + a profile with explicit name parts, and returns the id. */
create function pg_temp.new_person(
  p_first text,
  p_last text,
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email)
  values (v_id, lower(p_first) || '.' || lower(p_last) || '@test.invalid');

  insert into public.profiles (id, first_name, last_name, status)
  values (v_id, p_first, p_last, p_status);

  return v_id;
end;
$$;

create function pg_temp.new_org(
  p_name text,
  p_type text default 'VENDOR',
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.organizations (name, organization_type, status, country_code, default_currency)
  values (p_name, p_type, p_status, 'AE', 'AED')
  returning id into v_id;
  return v_id;
end;
$$;

/* Creates a membership of the given status and returns its id. No role is assigned. */
create function pg_temp.add_member(
  p_user uuid,
  p_org uuid,
  p_status text default 'ACTIVE'
) returns uuid
language plpgsql as $$
declare
  v_member uuid;
begin
  insert into public.organization_members (organization_id, user_id, status, joined_at)
  values (p_org, p_user, p_status,
          case when p_status = 'INVITED' then null else now() - interval '30 days' end)
  returning id into v_member;
  return v_member;
end;
$$;

/* Assigns one role, by code, to an existing membership. */
create function pg_temp.add_role(p_member uuid, p_role_code text) returns void
language plpgsql as $$
begin
  insert into public.member_roles (organization_member_id, role_id)
  select p_member, r.id from public.roles r where r.code = p_role_code
  on conflict do nothing;
end;
$$;

/*
 * Writes one audit row with EVERY column stated explicitly, and returns its id.
 *
 * p_at is required, not defaulted: a timestamp the fixture did not choose is a timestamp the
 * pagination assertions cannot reason about.
 */
create function pg_temp.new_audit(
  p_org uuid,
  p_actor uuid,
  p_action text,
  p_entity_type text,
  p_at timestamptz,
  p_metadata jsonb default '{}'::jsonb,
  p_entity_id text default null,
  p_ip inet default null,
  p_user_agent text default null
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id,
    metadata, ip_address, user_agent, created_at
  )
  values (
    p_org, p_actor, p_action, p_entity_type, p_entity_id,
    p_metadata, p_ip, p_user_agent, p_at
  )
  returning id into v_id;
  return v_id;
end;
$$;

/*
 * CATALOGUE INTROSPECTION FOR `RETURNS TABLE` FUNCTIONS.
 *
 * A set-returning `returns table (...)` function has prorettype = `record`, a pseudo-type with
 * no typrelid — so joining pg_type -> pg_class -> pg_attribute to read its columns silently
 * yields NOTHING, and an assertion written that way compares NULL to NULL and passes
 * vacuously. The column names live in proargnames alongside the INPUT parameter names,
 * distinguished only by proargmodes: 'i' (or 'b'/'v') for an input, 't' for a table column.
 * Both helpers below therefore filter on the mode.
 */
create function pg_temp.arg_names(p_name text, p_modes "char"[]) returns text[]
language sql stable as $$
  select coalesce(array_agg(x.name order by x.ord), '{}'::text[])
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(
    p.proargnames,
    coalesce(p.proargmodes,
             array_fill('i'::"char", array[coalesce(array_length(p.proargnames, 1), 0)]))
  ) with ordinality as x(name, mode, ord)
  where n.nspname = 'public'
    and p.proname = p_name
    and x.mode = any (p_modes);
$$;

create function pg_temp.table_columns(p_name text) returns text[]
language sql stable as $$
  select pg_temp.arg_names(p_name, array['t'::"char"]);
$$;

create function pg_temp.input_args(p_name text) returns text[]
language sql stable as $$
  select pg_temp.arg_names(p_name, array['i'::"char", 'b'::"char", 'v'::"char"]);
$$;

/*
 * The SQLSTATE raised when the current caller runs p_sql, or NULL if it returned normally.
 * Sequenced in plpgsql on purpose: throws_ok() cannot express the "zero rows here, raise
 * there" comparisons Sections B and I need, and comparing SQLSTATEs is what makes "these two
 * answers are indistinguishable" a testable claim rather than a comment.
 */
create function pg_temp.sqlstate_of(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading the function under test, IN ITS OWN ORDER.
-- ---------------------------------------------------------------------------
-- row_number() over () numbers rows in the order they arrive from the function, and the
-- aggregate then sorts by that number — so these capture what the function EMITTED rather than
-- re-sorting it. Aggregating `order by occurred_at desc` would sort the evidence into
-- agreement with the assertion.

/* The page's audit_log_ids, in emitted order. */
create function pg_temp.page_ids(
  p_limit integer default null,
  p_at timestamptz default null,
  p_id uuid default null
) returns uuid[]
language sql as $$
  select coalesce(array_agg(t.audit_log_id order by t.ord), '{}'::uuid[])
  from (
    select l.audit_log_id, row_number() over () as ord
    from public.list_vendor_audit_logs(
      coalesce(p_limit, 50), p_at, p_id
    ) l
  ) t;
$$;

/* The page's action codes, in emitted order. */
create function pg_temp.page_actions(
  p_limit integer default null,
  p_at timestamptz default null,
  p_id uuid default null
) returns text[]
language sql as $$
  select coalesce(array_agg(t.action_code order by t.ord), '{}'::text[])
  from (
    select l.action_code, row_number() over () as ord
    from public.list_vendor_audit_logs(
      coalesce(p_limit, 50), p_at, p_id
    ) l
  ) t;
$$;

create function pg_temp.page_size(
  p_limit integer default null,
  p_at timestamptz default null,
  p_id uuid default null
) returns bigint
language sql as $$
  select count(*) from public.list_vendor_audit_logs(coalesce(p_limit, 50), p_at, p_id);
$$;

/*
 * WALKS THE WHOLE HISTORY with the given page size, taking each page's LAST row as the next
 * cursor, and returns every id in the order it was seen — INCLUDING any duplicate.
 *
 * This is the function that makes "no duplicates and no skipped rows across pages" a single
 * assertion rather than a hand-written comparison of three hard-coded pages: the returned
 * array is compared against the id sequence of one unpaginated read, and any duplication,
 * omission or reordering shows up as an array mismatch.
 *
 * Both cursor parts are taken from the SAME emitted row, which is exactly what a client does.
 * The outer loop is bounded so a cursor bug that fails to advance terminates the test with a
 * comprehensible failure instead of hanging the connection.
 */
create function pg_temp.walk_all(p_page_size integer) returns uuid[]
language plpgsql as $$
declare
  v_all   uuid[] := '{}'::uuid[];
  v_at    timestamptz := null;
  v_id    uuid := null;
  v_seen  integer;
  v_guard integer := 0;
  v_row   record;
begin
  loop
    v_guard := v_guard + 1;
    exit when v_guard > 50;  -- far above any page count this fixture can produce

    v_seen := 0;

    for v_row in
      select l.audit_log_id, l.occurred_at
      from public.list_vendor_audit_logs(p_page_size, v_at, v_id) l
    loop
      v_all  := v_all || v_row.audit_log_id;
      v_at   := v_row.occurred_at;      -- ends up holding the LAST row of the page
      v_id   := v_row.audit_log_id;
      v_seen := v_seen + 1;
    end loop;

    exit when v_seen = 0;
  end loop;

  return v_all;
end;
$$;

/* Single columns of one emitted row, addressed by its audit_log_id. */
create function pg_temp.f_actor_type(p_id uuid) returns text
language sql as $$
  select l.actor_type from public.list_vendor_audit_logs(100, null, null) l
  where l.audit_log_id = p_id;
$$;

create function pg_temp.f_actor_name(p_id uuid) returns text
language sql as $$
  select l.actor_display_name from public.list_vendor_audit_logs(100, null, null) l
  where l.audit_log_id = p_id;
$$;

create function pg_temp.f_entity_name(p_id uuid) returns text
language sql as $$
  select l.entity_display_name from public.list_vendor_audit_logs(100, null, null) l
  where l.audit_log_id = p_id;
$$;

create function pg_temp.f_entity_type(p_id uuid) returns text
language sql as $$
  select l.entity_type from public.list_vendor_audit_logs(100, null, null) l
  where l.audit_log_id = p_id;
$$;

create function pg_temp.f_action(p_id uuid) returns text
language sql as $$
  select l.action_code from public.list_vendor_audit_logs(100, null, null) l
  where l.audit_log_id = p_id;
$$;

create function pg_temp.f_at(p_id uuid) returns timestamptz
language sql as $$
  select l.occurred_at from public.list_vendor_audit_logs(100, null, null) l
  where l.audit_log_id = p_id;
$$;

-- ============================================================================
-- Fixtures
-- ============================================================================
-- Deterministic: every organization, membership, role, audit row and TIMESTAMP below is
-- written explicitly. Nothing depends on the seed data except the role catalogue and its
-- permission mappings, which this suite reads and (in Section J only, transactionally) removes
-- a row from — it never adds a mapping, because proving a permission requirement by granting
-- it would prove nothing.

create table pg_temp.fx (k text primary key, v uuid);

create function pg_temp.fx(p_k text) returns uuid
language sql stable as $$ select v from pg_temp.fx where k = p_k; $$;

insert into pg_temp.fx (k, v) values
  ('vendor_a', pg_temp.new_org('Vendor A')),
  ('vendor_b', pg_temp.new_org('Vendor B')),
  ('vendor_c', pg_temp.new_org('Vendor C')),          -- a Vendor with NO history at all
  ('alpha',    pg_temp.new_org('Alpha Retail', 'RETAILER', 'ACTIVE'));

-- People.
--   ada   — Vendor A Super Admin. The primary caller.
--   bob   — Vendor A member whose MEMBERSHIP IS DEACTIVATED. He is an actor on a fixture row,
--           and his name must still resolve: revoking someone's access must not rewrite the
--           history of what they did.
--   cara  — Vendor A Super Admin whose PROFILE is SUSPENDED.
--   dan   — Vendor A Super Admin whose MEMBERSHIP is SUSPENDED.
--   gil   — Vendor A member with NO role at all.
--   eve   — Vendor B Super Admin, and the actor on one of Vendor A's rows, which is the
--           foreign-actor case: present, but not a member of the audit row's organization.
--   cleo  — Vendor C Super Admin (the empty-history caller).
--   owner / manager / staff — the three Retailer roles.
insert into pg_temp.fx (k, v) values
  ('ada',     pg_temp.new_person('Ada',   'Vendor')),
  ('bob',     pg_temp.new_person('Bob',   'Member')),
  ('cara',    pg_temp.new_person('Cara',  'Suspended', 'SUSPENDED')),
  ('dan',     pg_temp.new_person('Dan',   'Halted')),
  ('gil',     pg_temp.new_person('Gil',   'Roleless')),
  ('eve',     pg_temp.new_person('Eve',   'Other')),
  ('cleo',    pg_temp.new_person('Cleo',  'Empty')),
  ('owner',   pg_temp.new_person('Ozzy',  'Owner')),
  ('manager', pg_temp.new_person('Mia',   'Manager')),
  ('staff',   pg_temp.new_person('Sam',   'Staff'));

insert into pg_temp.fx (k, v) values
  ('m_ada',     pg_temp.add_member(pg_temp.fx('ada'),     pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_bob',     pg_temp.add_member(pg_temp.fx('bob'),     pg_temp.fx('vendor_a'), 'DEACTIVATED')),
  ('m_cara',    pg_temp.add_member(pg_temp.fx('cara'),    pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_dan',     pg_temp.add_member(pg_temp.fx('dan'),     pg_temp.fx('vendor_a'), 'SUSPENDED')),
  ('m_gil',     pg_temp.add_member(pg_temp.fx('gil'),     pg_temp.fx('vendor_a'), 'ACTIVE')),
  ('m_eve',     pg_temp.add_member(pg_temp.fx('eve'),     pg_temp.fx('vendor_b'), 'ACTIVE')),
  ('m_cleo',    pg_temp.add_member(pg_temp.fx('cleo'),    pg_temp.fx('vendor_c'), 'ACTIVE')),
  ('m_owner',   pg_temp.add_member(pg_temp.fx('owner'),   pg_temp.fx('alpha'),    'ACTIVE')),
  ('m_manager', pg_temp.add_member(pg_temp.fx('manager'), pg_temp.fx('alpha'),    'ACTIVE')),
  ('m_staff',   pg_temp.add_member(pg_temp.fx('staff'),   pg_temp.fx('alpha'),    'ACTIVE'));

select pg_temp.add_role(pg_temp.fx('m_ada'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_bob'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_cara'), 'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_dan'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_eve'),  'VENDOR_SUPER_ADMIN');
select pg_temp.add_role(pg_temp.fx('m_cleo'), 'VENDOR_SUPER_ADMIN');
-- gil gets NO role.
select pg_temp.add_role(pg_temp.fx('m_owner'),   'RETAILER_OWNER');
select pg_temp.add_role(pg_temp.fx('m_manager'), 'RETAILER_MANAGER');
select pg_temp.add_role(pg_temp.fx('m_staff'),   'SALES_STAFF');

-- ---------------------------------------------------------------------------
-- Vendor A's history: 12 rows, newest to oldest, with THREE sharing one timestamp.
-- ---------------------------------------------------------------------------
-- The base instant is fixed and in the past so nothing here can race a default of now().
-- Every timestamp below is base + a whole number of minutes, so the intended order is legible
-- from the offsets alone.
insert into pg_temp.fx (k, v) values
  -- t+9  a named product action by a fully-active Vendor A admin.
  ('e9', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('ada'),
     'PRODUCT_CREATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:09:00+00',
     jsonb_build_object('product_code', 'WID-1', 'product_name', 'Widget Pro',
                        'product_status', 'ACTIVE', 'vendor_name', 'Vendor A'))),

  -- t+8  NO ACTOR AT ALL -> 'SYSTEM'. Reachable today: both invitation tables have a nullable
  --      invited_by_profile_id and the audit writers copy it straight through.
  ('e8', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), null,
     'RETAILER_ONBOARDED', 'RETAILER_ORGANIZATION',
     timestamptz '2026-07-01 12:08:00+00',
     jsonb_build_object('retailer_name', 'Alpha Retail', 'retailer_status', 'ACTIVE',
                        'relationship_status', 'ACTIVE'))),

  -- t+7  actor whose MEMBERSHIP IS DEACTIVATED. Must still resolve to a name.
  ('e7', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('bob'),
     'RETAILER_SHOP_ADDED', 'RETAILER_SHOP',
     timestamptz '2026-07-01 12:07:00+00',
     jsonb_build_object('retailer_name', 'Alpha Retail', 'shop_name', 'Downtown Branch',
                        'shop_code', 'DT-1', 'shop_status', 'ACTIVE'))),

  -- t+6  FOREIGN ACTOR: a real profile, but a member of Vendor B only -> 'UNKNOWN', no name.
  ('e6', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('eve'),
     'RETAILER_OWNER_INVITED', 'RETAILER_INVITATION',
     timestamptz '2026-07-01 12:06:00+00',
     jsonb_build_object('retailer_name', 'Alpha Retail', 'role_code', 'RETAILER_OWNER',
                        'invitation_status', 'PENDING'))),

  -- t+5  the staff-invitation entity type, and the only FAILURE action this schema writes.
  ('e5', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('ada'),
     'STAFF_INVITATION_DELIVERY_FAILED', 'RETAILER_STAFF_INVITATION',
     timestamptz '2026-07-01 12:05:00+00',
     jsonb_build_object('retailer_name', 'Alpha Retail', 'role_code', 'SALES_STAFF',
                        'invitation_status', 'PENDING', 'shop_count', 2))),

  -- t+4  THE TIE GROUP: three rows sharing one created_at to the microsecond. This is the
  --      state now() produces for two audit rows written inside one transaction, and it is
  --      the state a timestamp-only cursor cannot page through correctly.
  ('t4a', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('ada'),
     'PRODUCT_UPDATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:04:00+00',
     jsonb_build_object('product_code', 'WID-1', 'product_name', 'Widget Pro'))),
  ('t4b', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('ada'),
     'PRODUCT_ACTIVATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:04:00+00',
     jsonb_build_object('product_code', 'GAD-1', 'product_name', 'Gadget Max'))),
  ('t4c', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('ada'),
     'PRODUCT_DEACTIVATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:04:00+00',
     jsonb_build_object('product_code', 'GIZ-1', 'product_name', 'Gizmo Lite'))),

  -- t+3  AN ACTION AND AN ENTITY TYPE THIS CONTRACT HAS NEVER HEARD OF, standing in for what
  --      a future migration will write. The row must survive intact; the name must be null,
  --      because the whitelist has no key for this entity type — even though the metadata
  --      happens to carry a `product_name`, which is exactly the inference that must NOT be
  --      made from a familiar-looking key on an unfamiliar type.
  ('e3', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('ada'),
     'SOMETHING_NOT_YET_INVENTED', 'FUTURE_ENTITY',
     timestamptz '2026-07-01 12:03:00+00',
     jsonb_build_object('product_name', 'Should Not Appear'))),

  -- t+2  the whitelisted key holds an OBJECT, not a string. `->>` would return its raw JSON
  --      text, which is precisely the raw-metadata leak the type guard exists to stop.
  ('e2', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('ada'),
     'PRODUCT_UPDATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:02:00+00',
     jsonb_build_object('product_name', jsonb_build_object('secret', 'leaked')))),

  -- t+1  a BLANK snapshot, and an entity_id naming a product that does not exist. Neither may
  --      remove the row, and the blank must read as "not named" rather than as an empty name.
  ('e1', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('ada'),
     'PRODUCT_UPDATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:01:00+00',
     jsonb_build_object('product_name', '   '),
     gen_random_uuid()::text)),

  -- t+0  THE HOSTILE ROW. Every kind of value this contract must never emit is present: an
  --      email, an invitation token and hash, a phone number, a storage path, an auth
  --      identifier and a service-role hint inside metadata, plus the ip_address and
  --      user_agent COLUMNS populated (no shipped writer sets them; this proves they are not
  --      merely absent by accident). Only the product name may come out.
  ('e0', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('ada'),
     'PRODUCT_CREATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:00:00+00',
     jsonb_build_object(
       'product_name',      'Secret Widget',
       'email',             'victim@example.com',
       'invitation_token',  'tok_live_should_never_appear',
       'token_hash',        'e3b0c44298fc1c149afbf4c8996fb924',
       'mobile_number',     '+971500000000',
       'storage_path',      'receipts/private/2026/secret.jpg',
       'auth_user_id',      '00000000-0000-0000-0000-000000000001',
       'service_role',      'true'),
     gen_random_uuid()::text,
     '203.0.113.7'::inet,
     'Mozilla/5.0 (SecretDevice) AuditProbe/1.0'));

-- ---------------------------------------------------------------------------
-- Vendor B's history, and one orphaned row.
-- ---------------------------------------------------------------------------
-- b_new is NEWER than every Vendor A row, and b_tie shares the tie group's exact timestamp.
-- Together they let Section H prove that a cursor lifted from another Vendor's page changes
-- WHERE Vendor A's window sits and never WHAT it may contain.
insert into pg_temp.fx (k, v) values
  ('b_new', pg_temp.new_audit(
     pg_temp.fx('vendor_b'), pg_temp.fx('eve'),
     'PRODUCT_CREATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:20:00+00',
     jsonb_build_object('product_name', 'Bravo Secret Product'))),
  ('b_tie', pg_temp.new_audit(
     pg_temp.fx('vendor_b'), pg_temp.fx('eve'),
     'PRODUCT_UPDATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:04:00+00',
     jsonb_build_object('product_name', 'Bravo Tied Product'))),

  -- organization_id NULL. audit_logs_select_authorized excludes these from both branches
  -- deliberately, and the function must reproduce that exclusion for every caller.
  ('orphan', pg_temp.new_audit(
     null, pg_temp.fx('ada'),
     'PRODUCT_CREATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:30:00+00',
     jsonb_build_object('product_name', 'Orphan Product')));

/*
 * Vendor A's 12 ids in the exact order the contract must emit them.
 *
 * Read from the TABLE, not from the function under test: an expectation derived from the
 * thing being tested would agree with it by construction. The three tied ids are sorted here
 * by id DESC — computed rather than hard-coded, because gen_random_uuid() decides which of
 * the three is largest — and everything else is stated positionally from the fixture keys.
 *
 * It is also caller-independent, so Section I can evaluate it while signed in as Vendor B to
 * assert that none of these ids appear there.
 */
create function pg_temp.expected_order() returns uuid[]
language sql stable as $$
  select array[
    pg_temp.fx('e9'), pg_temp.fx('e8'), pg_temp.fx('e7'), pg_temp.fx('e6'), pg_temp.fx('e5')
  ] || (
    select coalesce(array_agg(a.id order by a.id desc), '{}'::uuid[])
    from public.audit_logs a
    where a.organization_id = pg_temp.fx('vendor_a')
      and a.created_at = timestamptz '2026-07-01 12:04:00+00'
  ) || array[
    pg_temp.fx('e3'), pg_temp.fx('e2'), pg_temp.fx('e1'), pg_temp.fx('e0')
  ];
$$;


-- ============================================================================
-- SECTION A — the catalogue: signature, attributes, and privileges
-- ============================================================================
-- Asserted against pg_proc rather than inferred from behaviour. "It did not error for me" is
-- not the same claim as "anon holds no EXECUTE privilege".

select has_function('public', 'list_vendor_audit_logs',
  array['integer', 'timestamp with time zone', 'uuid'],
  'public.list_vendor_audit_logs(integer, timestamptz, uuid) exists');

select is(pg_temp.input_args('list_vendor_audit_logs'),
  array['p_limit', 'p_before_occurred_at', 'p_before_audit_log_id'],
  'the ONLY inputs are a page size and a two-part cursor');

-- The negative form of the same claim, stated explicitly because it is the security property:
-- no identity, tenant, role or permission may be nominated by the caller.
select is(
  (select count(*) from unnest(pg_temp.input_args('list_vendor_audit_logs')) a(n)
   where n ~* 'user|profile|member|organization|org_|tenant|vendor|role|permission|actor|auth'),
  0::bigint,
  'no input names a user, profile, membership, organization, tenant, role, permission or actor');

select is(pg_temp.table_columns('list_vendor_audit_logs'),
  array['audit_log_id', 'occurred_at', 'action_code', 'entity_type',
        'entity_display_name', 'actor_type', 'actor_display_name'],
  'the output contract is exactly the seven agreed columns, in order');

select is(
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'list_vendor_audit_logs'),
  true, 'it is SECURITY DEFINER');

select is(
  (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'list_vendor_audit_logs'),
  's'::"char", 'it is STABLE — it cannot write, and cannot create or alter an audit row');

select is(
  (select p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'list_vendor_audit_logs'),
  -- PostgreSQL normalises `set search_path = ''` to the quoted form in proconfig; asserting
  -- the raw literal would compare against text the catalogue never stores.
  array['search_path=""'], 'it runs with an empty search_path');

select ok(
  has_function_privilege('authenticated',
    'public.list_vendor_audit_logs(integer, timestamptz, uuid)', 'execute'),
  'authenticated may execute it');

select ok(
  not has_function_privilege('anon',
    'public.list_vendor_audit_logs(integer, timestamptz, uuid)', 'execute'),
  'anon may NOT execute it');

select ok(
  not has_function_privilege('public',
    'public.list_vendor_audit_logs(integer, timestamptz, uuid)', 'execute'),
  'PUBLIC holds no EXECUTE — the default grant was revoked');

-- The tables this read touches keep their default-deny posture. A new read function must not
-- have arrived alongside a new table grant.
select ok(not has_table_privilege('anon', 'public.audit_logs', 'select'),
  'anon still cannot select from audit_logs directly');
select ok(not has_table_privilege('authenticated', 'public.audit_logs', 'insert'),
  'authenticated still cannot insert into audit_logs');
select ok(not has_table_privilege('authenticated', 'public.audit_logs', 'update'),
  'authenticated still cannot update audit_logs');
select ok(not has_table_privilege('authenticated', 'public.audit_logs', 'delete'),
  'authenticated still cannot delete from audit_logs');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.audit_logs'::regclass),
  'RLS is still enabled on audit_logs');
select is(
  (select count(*) from pg_policies
   where schemaname = 'public' and tablename = 'audit_logs'),
  1::bigint, 'audit_logs still has exactly its one shipped SELECT policy');


-- ============================================================================
-- SECTION B — authorization and denial
-- ============================================================================
-- Every denial is the SAME 42501. A client cannot tell a signed-out caller from a Retailer
-- Owner from a Vendor member whose role lost the permission, and none of them can tell whether
-- Vendor A has any history.

select pg_temp.sign_out();
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs()'), '42501',
  'a signed-out caller is denied');

select pg_temp.act_as(pg_temp.fx('owner'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs()'), '42501',
  'a Retailer Owner is denied');

select pg_temp.act_as(pg_temp.fx('manager'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs()'), '42501',
  'a Retailer Manager is denied');

select pg_temp.act_as(pg_temp.fx('staff'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs()'), '42501',
  'a Sales Staff member is denied');

select pg_temp.act_as(pg_temp.fx('gil'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs()'), '42501',
  'a Vendor member with no role is denied');

select pg_temp.act_as(pg_temp.fx('cara'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs()'), '42501',
  'a Vendor Super Admin with a SUSPENDED profile is denied');

select pg_temp.act_as(pg_temp.fx('dan'));
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs()'), '42501',
  'a Vendor Super Admin with a SUSPENDED membership is denied');

select pg_temp.act_as(gen_random_uuid());
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs()'), '42501',
  'a JWT naming a user with no profile at all is denied');

-- And the authorized caller succeeds, so the denials above are about the caller and not about
-- the function being broken.
select pg_temp.act_as(pg_temp.fx('ada'));
select lives_ok('select * from public.list_vendor_audit_logs()',
  'the Vendor Super Admin holding AUDIT_LOGS_READ may list');


-- ============================================================================
-- SECTION C — the newest page, ordering, and the tie-break
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.page_size(100), 12::bigint,
  'Vendor A sees exactly its own 12 events — not Vendor B''s, not the orphan');

select is(pg_temp.page_ids(100), pg_temp.expected_order(),
  'the full history is emitted in (occurred_at DESC, audit_log_id DESC) order');

-- The tie group specifically: three rows, one timestamp, and a strictly descending id order
-- among them. Without the id tie-break this ordering would be whatever the plan emitted.
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.occurred_at = timestamptz '2026-07-01 12:04:00+00'),
  3::bigint, 'the three rows sharing one timestamp are all present');

-- The emitted order of the three tied rows, compared against those same three ids sorted
-- explicitly by id DESC.
--
-- NOT written with lag() over (): an unpartitioned window would compare the FIRST tied row
-- against the row BEFORE the group (e5), whose id is a random uuid — making the assertion a
-- coin flip that passes half the time and says nothing either way. Comparing the emitted
-- sequence against an independently-sorted one states the claim exactly and is deterministic.
select is(
  (select array_agg(t.id order by t.ord)
   from (
     select l.audit_log_id as id, l.occurred_at, row_number() over () as ord
     from public.list_vendor_audit_logs(100, null, null) l
   ) t
   where t.occurred_at = timestamptz '2026-07-01 12:04:00+00'),
  (select array_agg(a.id order by a.id desc)
   from public.audit_logs a
   where a.organization_id = pg_temp.fx('vendor_a')
     and a.created_at = timestamptz '2026-07-01 12:04:00+00'),
  'within the tie group the ids descend strictly — the tie-break is real, not incidental');

select is(pg_temp.f_at(pg_temp.fx('e9')), timestamptz '2026-07-01 12:09:00+00',
  'occurred_at is audit_logs.created_at, exact to the stored value');


-- ============================================================================
-- SECTION D — event accuracy: action, entity type, and the name snapshot
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.f_action(pg_temp.fx('e9')), 'PRODUCT_CREATED',
  'the action code is returned exactly as stored');
select is(pg_temp.f_entity_type(pg_temp.fx('e9')), 'VENDOR_PRODUCT',
  'the entity type is returned exactly as stored');

-- The whitelist, one entity type at a time, against the real key each shipped writer uses.
select is(pg_temp.f_entity_name(pg_temp.fx('e9')), 'Widget Pro',
  'VENDOR_PRODUCT resolves its name from metadata.product_name');
select is(pg_temp.f_entity_name(pg_temp.fx('e8')), 'Alpha Retail',
  'RETAILER_ORGANIZATION resolves its name from metadata.retailer_name');
select is(pg_temp.f_entity_name(pg_temp.fx('e7')), 'Downtown Branch',
  'RETAILER_SHOP resolves its name from metadata.shop_name — not the retailer_name beside it');
select is(pg_temp.f_entity_name(pg_temp.fx('e6')), 'Alpha Retail',
  'RETAILER_INVITATION resolves its name from metadata.retailer_name');
select is(pg_temp.f_entity_name(pg_temp.fx('e5')), 'Alpha Retail',
  'RETAILER_STAFF_INVITATION resolves its name from metadata.retailer_name');

-- The three ways a snapshot can be unusable. All three must read as null, and none may remove
-- the row or emit a partial value.
select is(pg_temp.f_entity_name(pg_temp.fx('e3')), null,
  'an UNKNOWN entity type yields a null name even when a familiar key is present');
select is(pg_temp.f_entity_name(pg_temp.fx('e2')), null,
  'a non-string metadata value yields null — its raw JSON is never emitted as a name');
select is(pg_temp.f_entity_name(pg_temp.fx('e1')), null,
  'a blank snapshot reads as "not named", not as an empty name');

-- ...and each of those rows is still THERE, with its own action and type intact.
select is(pg_temp.f_action(pg_temp.fx('e3')), 'SOMETHING_NOT_YET_INVENTED',
  'an unknown action code stays visible and unchanged — never mapped, never hidden');
select is(pg_temp.f_entity_type(pg_temp.fx('e3')), 'FUTURE_ENTITY',
  'an unknown entity type stays visible and unchanged');
select is(pg_temp.f_action(pg_temp.fx('e5')), 'STAFF_INVITATION_DELIVERY_FAILED',
  'the one failure action this schema writes is returned as itself, not as a result flag');

-- A row whose entity_id names a row that does not exist (and never did) is untouched: the
-- snapshot is historical, so a deleted target cannot degrade or remove the record.
select is(pg_temp.page_size(100), 12::bigint,
  'rows with missing snapshots, unknown types and dangling entity ids are all still counted');


-- ============================================================================
-- SECTION E — actor semantics
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.f_actor_type(pg_temp.fx('e9')), 'USER',
  'a resolvable Vendor member is actor_type USER');
select is(pg_temp.f_actor_name(pg_temp.fx('e9')), 'Ada Vendor',
  'the actor name is the profile''s first and last name');

select is(pg_temp.f_actor_type(pg_temp.fx('e8')), 'SYSTEM',
  'a null actor_profile_id is actor_type SYSTEM');
select is(pg_temp.f_actor_name(pg_temp.fx('e8')), null,
  'a SYSTEM row carries no actor name — none is fabricated');

select is(pg_temp.f_actor_type(pg_temp.fx('e7')), 'USER',
  'a DEACTIVATED membership still names its actor — revoking access does not rewrite history');
select is(pg_temp.f_actor_name(pg_temp.fx('e7')), 'Bob Member',
  'and the name is the real one');

select is(pg_temp.f_actor_type(pg_temp.fx('e6')), 'UNKNOWN',
  'an actor who is not a member of this Vendor is actor_type UNKNOWN');
select is(pg_temp.f_actor_name(pg_temp.fx('e6')), null,
  'and NO NAME LEAKS — Eve is a real person in Vendor B, and her name must not appear here');

-- The invariant, stated over the whole page rather than row by row.
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where (l.actor_type = 'USER') <> (l.actor_display_name is not null)),
  0::bigint,
  'actor_display_name is non-null if and only if actor_type is USER');

select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.actor_type not in ('USER', 'SYSTEM', 'UNKNOWN')),
  0::bigint, 'actor_type is only ever one of the three documented values');

-- Not one row was dropped for missing actor context.
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.actor_type <> 'USER'),
  2::bigint, 'both actor-less rows survived — an audit log never drops a record');

-- The caller is never assumed to be the actor.
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.actor_display_name = 'Ada Vendor'),
  9::bigint,
  'exactly the nine rows Ada actually wrote name her — the actor is never inferred from the caller');


-- ============================================================================
-- SECTION F — privacy: nothing sensitive travels
-- ============================================================================
-- The hostile fixture row (e0) carries an email, an invitation token, a token hash, a phone
-- number, a storage path, an auth identifier and a service-role hint in metadata, plus a
-- populated ip_address and user_agent. It is read back in full and every emitted text value is
-- searched.
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.f_entity_name(pg_temp.fx('e0')), 'Secret Widget',
  'only the whitelisted name key comes out of a metadata object full of secrets');

select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   cross join lateral (values
     (l.action_code), (l.entity_type), (l.entity_display_name), (l.actor_type),
     (l.actor_display_name), (l.audit_log_id::text), (l.occurred_at::text)
   ) as v(val)
   where v.val ~* 'victim@|@example\.com|tok_live|e3b0c442|\+9715|receipts/|service_role|SecretDevice|203\.0\.113|Mozilla'),
  0::bigint,
  'no emitted value contains an email, token, hash, phone number, storage path, service-role hint, user agent or IP');

-- The same claim aimed at the two columns that are personal data about a device and a network.
-- They are populated on e0, so their absence here is proof of non-selection, not of emptiness.
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.entity_display_name = '203.0.113.7'
      or l.actor_display_name = '203.0.113.7'),
  0::bigint, 'the ip_address column is never emitted through any field');

-- The raw metadata object itself, in any of its serialisations, appears nowhere.
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.entity_display_name like '{%' or l.entity_display_name like '[%'
      or l.actor_display_name like '{%'  or l.actor_display_name like '[%'),
  0::bigint, 'no field ever carries serialised JSON');

-- No auth identifier travels. actor_profile_id IS the auth user id (profiles.id is a 1:1 FK to
-- auth.users), so this checks the one field that could plausibly carry it.
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.actor_display_name in (
     pg_temp.fx('ada')::text, pg_temp.fx('bob')::text, pg_temp.fx('eve')::text)),
  0::bigint, 'no actor identifier is emitted under any column');

-- The output columns cannot grow a sensitive field without this failing.
select is(
  (select count(*) from unnest(pg_temp.table_columns('list_vendor_audit_logs')) c(n)
   where n ~* 'email|phone|mobile|token|hash|secret|ip_|ip$|user_agent|metadata|old_value|new_value|password|session|jwt|claim|storage|url|profile_id|user_id|organization_id|member'),
  0::bigint,
  'no output column is named for an email, phone, token, hash, IP, user agent, raw metadata, old/new values, credential, storage reference or identity id');


-- ============================================================================
-- SECTION G — pagination: limits, cursors, and traversal
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

-- --- the default and the bounds ---------------------------------------------
-- MOVED TO SECTION K2, and the reason is worth stating where the reader expects the block.
--
-- Proving the default page size requires MORE than 50 rows, and this suite's other sections
-- reason about the 12 named ones. The block therefore used to insert 60 filler rows and then
-- DELETE them again -- which migration 20260816090000 now correctly refuses, because
-- public.audit_logs is append-only in the database rather than by convention.
--
-- The fix is to stop needing the teardown at all: every assertion that grows the history now
-- runs at the END of the suite, after everything that depends on a smaller count. Nothing is
-- skipped and no coverage is lost -- see SECTION K2.

-- --- cursor validation ------------------------------------------------------
select is(
  pg_temp.sqlstate_of(format(
    'select * from public.list_vendor_audit_logs(5, %L, null)',
    timestamptz '2026-07-01 12:05:00+00')),
  '22023', 'a timestamp with no id is a malformed cursor and is refused');

select is(
  pg_temp.sqlstate_of(format(
    'select * from public.list_vendor_audit_logs(5, null, %L)', pg_temp.fx('e5'))),
  '22023', 'an id with no timestamp is a malformed cursor and is refused');

select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs(5, null, null)'),
  null, 'both cursor parts null is the newest page, not an error');

-- --- first page, second page, and no drift ---------------------------------
select is(pg_temp.page_ids(5), (pg_temp.expected_order())[1:5],
  'page one of size 5 is the five newest events');

select is(
  pg_temp.page_ids(5, pg_temp.f_at(pg_temp.fx('e5')), pg_temp.fx('e5')),
  (pg_temp.expected_order())[6:10],
  'page two continues exactly where page one stopped — through the tie group');

select is(
  pg_temp.page_size(5, pg_temp.f_at(pg_temp.fx('e1')), pg_temp.fx('e1')),
  1::bigint, 'the final page is short rather than padded');

-- The whole traversal, compared against one unpaginated read. Any duplicate, omission or
-- reordering at any page boundary — including inside the tie group — fails this.
select is(pg_temp.walk_all(5), pg_temp.expected_order(),
  'walking the history 5 at a time visits every row exactly once, in order');
select is(pg_temp.walk_all(1), pg_temp.expected_order(),
  'walking one row at a time does too — every boundary is a tie boundary at size 1');
select is(pg_temp.walk_all(3), pg_temp.expected_order(),
  'and a page size that lands mid-tie-group does too');
select is(pg_temp.walk_all(100), pg_temp.expected_order(),
  'a single oversized page returns the same sequence');

-- Repeated identical calls are identical. A read whose order drifts between calls would page
-- correctly once and wrongly thereafter.
select is(pg_temp.page_ids(100), pg_temp.page_ids(100),
  'repeated calls return the same rows in the same order');

-- --- the end of the history -------------------------------------------------
select is(
  pg_temp.page_size(5, pg_temp.f_at(pg_temp.fx('e0')), pg_temp.fx('e0')),
  0::bigint, 'a cursor at the OLDEST row returns an empty page, not an error');

select is(
  pg_temp.page_size(5, timestamptz '2020-01-01 00:00:00+00', gen_random_uuid()),
  0::bigint, 'a cursor older than every row returns an empty page');

select is(
  pg_temp.sqlstate_of(format(
    'select * from public.list_vendor_audit_logs(5, %L, %L)',
    timestamptz '2020-01-01 00:00:00+00', gen_random_uuid())),
  null, 'and reaching the end is a normal return, never a raise');


-- ============================================================================
-- SECTION H — new events, and foreign cursors
-- ============================================================================
select pg_temp.act_as(pg_temp.fx('ada'));

-- --- the arriving event -----------------------------------------------------
-- MOVED TO SECTION K2, for the same reason as Section G's page-size block: it used to insert
-- a newer event and then DELETE it to restore the fixture, and audit_logs is now append-only
-- in the database (migration 20260816090000). Growing the history at the END of the suite
-- removes the need for any teardown.

-- --- a cursor from another Vendor -------------------------------------------
-- b_new is NEWER than everything Vendor A has, so using it as a cursor must return Vendor A's
-- ENTIRE history: the cursor moved the window, and changed nothing about what may be in it.
select is(
  pg_temp.page_ids(100, timestamptz '2026-07-01 12:20:00+00', pg_temp.fx('b_new')),
  pg_temp.expected_order(),
  'a cursor lifted from another Vendor''s page positions the window and grants nothing');

-- b_tie shares the tie group's exact timestamp. Whatever its id compares as, the answer must
-- be a subset of Vendor A's own rows and must never include a Vendor B row.
select is(
  (select count(*) from public.list_vendor_audit_logs(
     100, timestamptz '2026-07-01 12:04:00+00', pg_temp.fx('b_tie')) l
   where l.audit_log_id in (pg_temp.fx('b_new'), pg_temp.fx('b_tie'), pg_temp.fx('orphan'))),
  0::bigint,
  'a foreign cursor at a tied timestamp still cannot pull a foreign or orphaned row in');

-- An invented cursor — an id belonging to no row at all — is inert for the same reason.
select ok(
  pg_temp.page_size(100, timestamptz '2026-07-01 12:04:00+00', gen_random_uuid()) <= 12::bigint,
  'a fabricated cursor id cannot widen the result beyond the caller''s own history');


-- ============================================================================
-- SECTION I — tenant isolation and the empty history
-- ============================================================================

-- Vendor B sees its own two rows and NOTHING of Vendor A's.
select pg_temp.act_as(pg_temp.fx('eve'));

select is(pg_temp.page_size(100), 2::bigint, 'Vendor B sees exactly its own two events');
select is(pg_temp.page_ids(100), array[pg_temp.fx('b_new'), pg_temp.fx('b_tie')],
  'and they are its own, newest first');
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.audit_log_id = any (pg_temp.expected_order())),
  0::bigint, 'not one of Vendor A''s rows is visible to Vendor B');
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.entity_display_name in ('Widget Pro', 'Secret Widget', 'Downtown Branch')),
  0::bigint, 'and none of Vendor A''s entity names leak either');

-- Symmetry: Vendor A cannot see Vendor B's, and cannot learn that Vendor B has any.
select pg_temp.act_as(pg_temp.fx('ada'));
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.entity_display_name in ('Bravo Secret Product', 'Bravo Tied Product')),
  0::bigint, 'Vendor A cannot see Vendor B''s events');

-- The orphaned (null-organization) row is invisible to BOTH, as the RLS policy intends.
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.audit_log_id = pg_temp.fx('orphan')),
  0::bigint, 'a null-organization row is invisible to Vendor A');
select pg_temp.act_as(pg_temp.fx('eve'));
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.audit_log_id = pg_temp.fx('orphan')),
  0::bigint, 'and to Vendor B — it belongs to no tenant, so it reaches no browser client');

-- A Vendor with NO history returns an EMPTY LIST, and that must be distinguishable from the
-- denial every unauthorized caller gets.
select pg_temp.act_as(pg_temp.fx('cleo'));
select is(pg_temp.page_size(100), 0::bigint,
  'a Vendor with no recorded activity gets an empty list');
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs()'), null,
  'an empty history RETURNS — it never raises, so "none" stays distinct from "denied"');
select is(pg_temp.sqlstate_of(format(
    'select * from public.list_vendor_audit_logs(5, %L, %L)',
    timestamptz '2026-07-01 12:09:00+00', pg_temp.fx('e9'))),
  null, 'and paging an empty history with a foreign cursor is still an empty return');


-- ============================================================================
-- SECTION J — the exact permission requirement
-- ============================================================================
-- Proved by REMOVING the seeded role→permission mapping, never by adding one: granting a
-- permission and observing success would prove only that the grant worked. Rolled back with
-- the transaction.
select pg_temp.act_as(pg_temp.fx('ada'));

select is(pg_temp.page_size(100), 12::bigint, 'with AUDIT_LOGS_READ, Ada can list (baseline)');

delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'AUDIT_LOGS_READ';

select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs()'), '42501',
  'without AUDIT_LOGS_READ the read is refused, even for a Vendor Super Admin');

-- The refusal is byte-identical to every other denial — a client cannot tell a missing
-- permission from a missing role, and cannot learn that the history exists.
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs(5, null, null)'),
  '42501', 'the refusal is the same regardless of the arguments supplied');

-- A DIFFERENT Vendor permission is not a substitute: removing AUDIT_LOGS_READ must not be
-- survivable by holding RETAILERS_READ or PRODUCTS_READ, both of which Ada still has.
select ok(
  public.has_organization_permission(pg_temp.fx('vendor_a'), 'RETAILERS_READ'),
  'Ada still holds RETAILERS_READ (so the refusal above is specific, not blanket)');

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN' and p.code = 'AUDIT_LOGS_READ';

select is(pg_temp.page_size(100), 12::bigint,
  'restoring AUDIT_LOGS_READ restores the read');


-- ============================================================================
-- SECTION K — the read writes nothing
-- ============================================================================
-- The strongest form of "read-only" available here: count every audit row before and after a
-- full traversal, and confirm the function cannot be used to create, edit or clear one.
select pg_temp.act_as(pg_temp.fx('ada'));

create table pg_temp.before_counts as
select
  (select count(*) from public.audit_logs)          as audits,
  (select count(*) from public.organization_members) as members,
  (select count(*) from public.profiles)             as profiles;

select is(array_length(pg_temp.walk_all(3), 1), 12,
  'a full paginated traversal ran (and is what the counts below bracket)');
select is(array_length(pg_temp.page_ids(100), 1), 12, 'and an unpaginated read ran');
select is(pg_temp.page_size(1), 1::bigint, 'and a single-row read ran');

select is(
  (select b.audits::text || '/' || b.members::text || '/' || b.profiles::text
   from pg_temp.before_counts b),
  ((select count(*) from public.audit_logs)::text || '/' ||
   (select count(*) from public.organization_members)::text || '/' ||
   (select count(*) from public.profiles)::text),
  'listing the history changed no audit row, no membership and no profile');

select is(
  (select count(*) from public.audit_logs a
   where a.action in ('AUDIT_LOG_READ', 'AUDIT_LOGS_READ', 'AUDIT_LOG_VIEWED')),
  0::bigint, 'reading the history is not itself recorded as an event');

-- ============================================================================
-- SECTION K2 — assertions that GROW the history
-- ============================================================================
-- Everything here adds audit rows and never removes any, so it runs after every section that
-- reasons about Vendor A's history being exactly 12 rows.
--
-- WHY THE BLOCKS LIVE HERE RATHER THAN IN SECTIONS G AND H. Both used to insert rows and then
-- DELETE them to restore the fixture. Migration 20260816090000 makes public.audit_logs
-- append-only in the database -- UPDATE, DELETE and TRUNCATE are all refused, for every role
-- including the owner -- so a teardown of that shape can no longer run, and should not: the
-- whole point of the milestone is that an audit row, once written, stays written.
--
-- Ordering inside this section matters and is deliberate: the single arriving event runs
-- FIRST, while the history is still 12 rows, and the 60 filler rows run SECOND. Reversing
-- them would make the arriving-event counts depend on the filler.
select pg_temp.act_as(pg_temp.fx('ada'));

-- --- the arriving event (was SECTION H) --------------------------------------
-- Write a NEWER event, then fetch page two with page one's cursor. Under OFFSET this insert
-- would shift every subsequent window by one row, duplicating one and skipping none.
insert into pg_temp.fx (k, v) values
  ('e_new', pg_temp.new_audit(
     pg_temp.fx('vendor_a'), pg_temp.fx('ada'),
     'PRODUCT_CREATED', 'VENDOR_PRODUCT',
     timestamptz '2026-07-01 12:59:00+00',
     jsonb_build_object('product_name', 'Arrived Later')));

select is(
  pg_temp.page_ids(5, pg_temp.f_at(pg_temp.fx('e5')), pg_temp.fx('e5')),
  (pg_temp.expected_order())[6:10],
  'an event arriving after page one does not shift, duplicate or skip anything on page two');

select ok(
  not (pg_temp.fx('e_new') = any (pg_temp.page_ids(5, pg_temp.f_at(pg_temp.fx('e5')), pg_temp.fx('e5')))),
  'and the new event does not appear on an older page — it is newer than the cursor');

-- Refresh: a null cursor is how a client pulls to refresh, and it is where the new event is.
select is((pg_temp.page_ids(5))[1], pg_temp.fx('e_new'),
  'refreshing with a null cursor returns the newest page, with the new event at its head');

select is(pg_temp.page_size(100), 13::bigint, 'the history has grown by exactly one');

-- --- the default and the bounds (was SECTION G) ------------------------------
-- The default is proved by exceeding it. Vendor A now has 13 rows, so a call with no
-- arguments still cannot distinguish 50 from 13; 60 extra rows push the count past it.
insert into public.audit_logs (organization_id, actor_profile_id, action, entity_type, created_at)
select pg_temp.fx('vendor_a'), pg_temp.fx('ada'), 'PRODUCT_UPDATED', 'VENDOR_PRODUCT',
       timestamptz '2026-06-01 00:00:00+00' + (g || ' seconds')::interval
from generate_series(1, 60) g;

select is((select count(*) from public.list_vendor_audit_logs()), 50::bigint,
  'the default page size is exactly 50 when no limit is given');
select is((select count(*) from public.list_vendor_audit_logs(null, null, null)), 50::bigint,
  'an explicit null limit also means 50');
-- 13 named + 60 filler. Was 72 before the arriving event moved ahead of this block.
select is((select count(*) from public.list_vendor_audit_logs(100, null, null)), 73::bigint,
  'the maximum of 100 is honoured and returns everything available below it');
select is((select count(*) from public.list_vendor_audit_logs(1, null, null)), 1::bigint,
  'a limit of 1 returns exactly one row');

select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs(101, null, null)'),
  '22023', 'a limit ABOVE the maximum is refused, not silently clamped');
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs(0, null, null)'),
  '22023', 'a zero limit is refused — it would be indistinguishable from the end of history');
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs(-1, null, null)'),
  '22023', 'a negative limit is refused — in PostgreSQL a negative LIMIT is unbounded');
select is(pg_temp.sqlstate_of('select * from public.list_vendor_audit_logs(-2147483648, null, null)'),
  '22023', 'the most negative integer is refused too');

-- The filler rows are OLDER than every named event, so newest-first pagination puts them
-- after the 13 -- which is why the cursor assertions above are unaffected by them and why
-- this block can safely run last.
-- e_new is at 12:59, newer than all twelve, so newest-first ordering puts it at the HEAD.
select is(
  (pg_temp.page_ids(100))[1:13], pg_temp.fx('e_new') || pg_temp.expected_order(),
  'the named events still lead the history, with the arriving event at its head');

-- ============================================================================
-- SECTION L — the actor ambiguity, proved by DELETION rather than argued
-- ============================================================================
-- Runs last and adds its own rows, so nothing above depends on the counts it changes.
--
-- WHY THIS SECTION EXISTS. 'SYSTEM' is the one value in this contract that cannot be read as
-- a fact about who acted, and the reason is a cascade the schema makes invisible:
--
--     public.profiles.id          REFERENCES auth.users ON DELETE CASCADE
--     audit_logs.actor_profile_id REFERENCES profiles   ON DELETE SET NULL
--
-- Deleting an auth user therefore erases the profile AND the membership, nulls the audit row's
-- actor, and leaves the audit row itself standing. The row then reads exactly like one that
-- never had an actor. Asserting that here turns a documented caveat into a tested property, so
-- a future actor-name snapshot column cannot be added without this section noticing.
select pg_temp.act_as(pg_temp.fx('ada'));

insert into pg_temp.fx (k, v) values
  -- A SUSPENDED profile that is still a member of Vendor A.
  ('suspended_actor', pg_temp.new_person('Suspended', 'Actor', 'SUSPENDED')),
  -- A real profile with NO membership in ANY organization.
  ('orphan_actor',    pg_temp.new_person('Orphan',    'Actor')),
  -- A normal Vendor A member who will be deleted mid-section.
  ('doomed_actor',    pg_temp.new_person('Doomed',    'Actor'));

select pg_temp.add_member(pg_temp.fx('suspended_actor'), pg_temp.fx('vendor_a'), 'ACTIVE');
select pg_temp.add_member(pg_temp.fx('doomed_actor'),    pg_temp.fx('vendor_a'), 'ACTIVE');
-- orphan_actor deliberately gets NO membership anywhere.

insert into pg_temp.fx (k, v) values
  ('l_susp',   pg_temp.new_audit(pg_temp.fx('vendor_a'), pg_temp.fx('suspended_actor'),
     'L_SUSPENDED_PROFILE', 'VENDOR_PRODUCT', timestamptz '2026-07-01 11:03:00+00')),
  ('l_orphan', pg_temp.new_audit(pg_temp.fx('vendor_a'), pg_temp.fx('orphan_actor'),
     'L_NO_MEMBERSHIP',     'VENDOR_PRODUCT', timestamptz '2026-07-01 11:02:00+00')),
  ('l_doomed', pg_temp.new_audit(pg_temp.fx('vendor_a'), pg_temp.fx('doomed_actor'),
     'L_WILL_BE_DELETED',   'VENDOR_PRODUCT', timestamptz '2026-07-01 11:01:00+00'));

-- --- state 5: an INACTIVE PROFILE still names its actor --------------------
-- Deliberate, and the same rule as the DEACTIVATED membership in Section E: suspending a
-- person must not retroactively strip their name off the actions they took.
select is(pg_temp.f_actor_type(pg_temp.fx('l_susp')), 'USER',
  'a SUSPENDED profile is still actor_type USER');
select is(pg_temp.f_actor_name(pg_temp.fx('l_susp')), 'Suspended Actor',
  'and it still resolves to the real name');

-- --- state 4: a profile with NO membership anywhere -> UNKNOWN -------------
-- The second, distinct route to UNKNOWN. Section E covers the first (a member of ANOTHER
-- Vendor); this one has no membership at all, and must not be confused with SYSTEM.
select is(pg_temp.f_actor_type(pg_temp.fx('l_orphan')), 'UNKNOWN',
  'an actor with no membership in ANY organization is UNKNOWN, not SYSTEM');
select is(pg_temp.f_actor_name(pg_temp.fx('l_orphan')), null,
  'and carries no name');

-- --- state 3 -> state 2: the cascade, observed ----------------------------
select is(pg_temp.f_actor_type(pg_temp.fx('l_doomed')), 'USER',
  'before deletion the doomed actor reads USER');
select is(pg_temp.f_actor_name(pg_temp.fx('l_doomed')), 'Doomed Actor',
  'and is fully named');

delete from auth.users where id = pg_temp.fx('doomed_actor');

-- The cascade did what the FKs say it does.
select ok(not exists (select 1 from public.profiles p where p.id = pg_temp.fx('doomed_actor')),
  'deleting the auth user cascaded away the profile');
select ok(not exists (select 1 from public.organization_members m
                      where m.user_id = pg_temp.fx('doomed_actor')),
  'and the membership');
select ok(exists (select 1 from public.audit_logs a where a.id = pg_temp.fx('l_doomed')),
  'but the AUDIT ROW SURVIVED — an audit record outlives the actor it names');
select is(
  (select a.actor_profile_id from public.audit_logs a where a.id = pg_temp.fx('l_doomed')),
  null,
  'and its actor_profile_id was set to null by ON DELETE SET NULL');

-- --- the ambiguity itself -------------------------------------------------
select is(pg_temp.f_actor_type(pg_temp.fx('l_doomed')), 'SYSTEM',
  'a DELETED actor now reads SYSTEM — identical to a genuine system event');
select is(pg_temp.f_actor_name(pg_temp.fx('l_doomed')), null,
  'and carries no name');

-- e8 was written with a null actor from the start. The deleted-actor row and the
-- never-had-an-actor row must now be indistinguishable in every emitted actor field. THIS IS
-- THE ASSERTION THAT PINS THE LIMITATION: if it ever fails, the schema gained the ability to
-- tell them apart, and docs § 5.5 / § 7.2 and the Flutter wording must be revisited.
select is(
  (select count(distinct (l.actor_type, coalesce(l.actor_display_name, '~')))
   from public.list_vendor_audit_logs(100, null, null) l
   where l.audit_log_id in (pg_temp.fx('e8'), pg_temp.fx('l_doomed'))),
  1::bigint,
  'a genuine system event and a deleted actor are BYTE-IDENTICAL — SYSTEM means "no actor identity remains", not "a system process acted"');

-- The row is still readable in full: losing an actor costs the record its attribution, never
-- its existence or its content.
select is(pg_temp.f_action(pg_temp.fx('l_doomed')), 'L_WILL_BE_DELETED',
  'the orphaned row keeps its action code');
select is(pg_temp.f_entity_type(pg_temp.fx('l_doomed')), 'VENDOR_PRODUCT',
  'and its entity type');
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where l.audit_log_id in (pg_temp.fx('l_susp'), pg_temp.fx('l_orphan'), pg_temp.fx('l_doomed'))),
  3::bigint,
  'all three rows remain visible — no actor state removes a record');

-- And the biconditional still holds across every actor state in the suite.
select is(
  (select count(*) from public.list_vendor_audit_logs(100, null, null) l
   where (l.actor_type = 'USER') <> (l.actor_display_name is not null)),
  0::bigint,
  'actor_display_name is non-null if and only if actor_type is USER, across all states');

select * from finish();
rollback;
