-- Migration: mobile_vendor_dashboard_summary
-- Purpose: The ONE read a Vendor Super Admin needs to render the dashboard summary counts
--          the web already shows, from a mobile client. It adds, and only adds:
--            1. public.get_vendor_admin_dashboard_summary()  [authenticated]
--
-- THIS MIGRATION CHANGES NOTHING THAT IS ALREADY DEPLOYED. No table, column, constraint,
--   index, trigger, RLS policy, role, permission or permission mapping is created, altered or
--   dropped. No existing function is edited, dropped or replaced. No seed row is written. No
--   audit row is written — reading a count is not an event. public.organization_members,
--   public.roles, public.permissions and public.audit_logs all keep the exact posture
--   20260716124419, 20260716125559, 20260716130351 and 20260716131930 left them in: RLS
--   enabled, SELECT-only to `authenticated`, nothing at all to `anon`.
--
-- THE WEB DASHBOARD IS NOT MIGRATED HERE. app/(admin)/page.tsx and
--   lib/dashboard/vendor-admin-summary.ts are untouched and keep issuing exactly the four
--   direct `head: true, count: "exact"` table reads they issue today, with exactly the same
--   labels and the same per-card "Unavailable" degradation. This migration only makes the
--   same four figures reachable through one shared contract that Flutter can call and that
--   the web may adopt later.
--
-- ============================================================================
-- WHAT THE AUDIT FOUND — THE DASHBOARD IS REAL, AND IT IS FOUR ROUND TRIPS
-- ============================================================================
-- The Vendor Admin dashboard at `/` is REAL and DATABASE-BACKED. There is no mocked card, no
-- sample figure and no zero placeholder anywhere on it: lib/dashboard/vendor-admin-summary.ts
-- issues four real counts and app/(admin)/page.tsx renders exactly those four, plus three
-- static navigation shortcuts (Retailers, Products, Audit logs) that are plain <Link>s
-- carrying no data at all. The page shows NO chart, NO trend, NO percentage, NO time series,
-- NO recent-activity feed and NO audit rows — only four scalars and the organization's name.
--
-- Two properties of that implementation make it unusable as a mobile contract, and each is a
-- gap this function closes rather than a defect in the web:
--
--   GAP 1 — FOUR ROUND TRIPS FOR FOUR SCALARS, PLUS A FIFTH FOR AUTHORIZATION.
--   getVendorAdminDashboardSummary() resolves the Vendor via get_vendor_super_admin_context()
--   and then issues four separate PostgREST requests, concurrently under Promise.all. On a
--   LAN that is four cheap requests; on a phone on mobile data it is four TLS round trips to
--   transfer four integers, and every one of them re-evaluates the same RLS predicates — each
--   of which calls has_organization_permission() or has_organization_role(), which re-walk the
--   profile → membership → organization → role → permission chain. Rebuilding that fan-out in
--   Dart would make a second client responsible for issuing it correctly, and would put the
--   authorization resolution on the wire five times per dashboard load. This function resolves
--   the Vendor ONCE and answers all four counts in ONE statement.
--
--   GAP 2 — THE METRIC DEFINITIONS LIVE IN TYPESCRIPT. Which table each card counts, which
--   status predicate applies, and — critically — WHICH OF THE FOUR ARE TENANT-SCOPED AT ALL
--   are decisions currently encoded in a Next.js module. A Flutter client would have to
--   re-derive them, and the two clients would then be free to drift. In particular two of the
--   four cards are NOT organization metrics at all (see below), which is exactly the kind of
--   fact a second client re-implementing "count the roles" would get wrong.
--
-- ============================================================================
-- TWO OF THE FOUR COUNTS ARE GLOBAL CATALOGUE FIGURES, NOT VENDOR METRICS
-- ============================================================================
-- THIS IS THE MOST IMPORTANT FINDING IN THE AUDIT, AND IT IS WHY TWO FIELDS BELOW ARE NAMED
-- `catalog_*`.
--
-- public.roles and public.permissions carry NO organization_id. They are a single global RBAC
-- catalogue seeded by 20260716133023 and extended by later module migrations — the same rows,
-- for every organization in the deployment. Their RLS policies
-- (roles_select_rbac_authorized, permissions_select_rbac_authorized) gate the catalogue
-- WHOLESALE on RBAC_READ or VENDOR_SUPER_ADMIN held in at least one of the caller's own
-- organizations; they do not, and cannot, scope rows to a tenant.
--
-- So the web's "Active Roles" and "Permissions" cards show the SAME NUMBER TO EVERY VENDOR.
-- They are deployment-wide configuration figures rendered on a page whose description reads
-- "Overview of your organization's members, access control, and recorded activity". That
-- wording is defensible — the catalogue IS the access-control vocabulary — but the two
-- figures are NOT properties of the caller's organization, and a mobile client that labelled
-- them "your roles" would be stating something false.
--
-- The web labels are NOT changed by this migration (that would be a visible web change, which
-- this milestone forbids). Instead the CONTRACT names the distinction, so no client can
-- inherit the ambiguity by accident:
--
--     active_member_count        -> tenant-scoped   (this Vendor's memberships)
--     catalog_active_role_count  -> GLOBAL          (deployment-wide role definitions)
--     catalog_permission_count   -> GLOBAL          (deployment-wide permission definitions)
--     audit_event_count          -> tenant-scoped   (this Vendor's recorded history)
--
-- THE TWO GLOBAL COUNTS LEAK NOTHING ABOUT ANOTHER VENDOR. They are counts of CATALOGUE
-- DEFINITIONS — role and permission rows written by migrations — not of any tenant's data,
-- usage, membership or activity. Two Vendors reading this function see identical values for
-- both fields precisely BECAUSE neither figure depends on either Vendor's rows. Nothing about
-- another Vendor's existence, size or activity is observable through them, and pgTAP asserts
-- exactly that by proving the two catalogue counts are equal across two Vendors with
-- deliberately different amounts of data.
--
-- ============================================================================
-- WHAT IS DELIBERATELY *NOT* COUNTED, AND WHY
-- ============================================================================
-- The schema can support many more counts than this function returns: vendor_retailers,
-- retailer_shops, vendor_products, vendor_product_assignments, retailer_invitations,
-- retailer_staff_invitations, receipt_submissions. NONE of them is counted here, because
-- NONE of them appears on the web dashboard. The audit checked every card on the page and
-- every value it renders; the page has exactly four figures and they are the four below.
--
-- Adding a Retailer count, a Product count, a shop count, an assignment count or a pending
-- invitation count would not be sharing an existing capability — it would be INVENTING a
-- product decision inside a migration, and freezing its semantics into a pinned mobile
-- contract before any web surface had ever had to defend them. Each is additive later, and
-- each should arrive with the web card that defines it. The reasoning is recorded per metric
-- in docs/mobile-vendor-dashboard-summary-audit.md § 3.4 rather than left as an absence.
--
-- THERE IS NO INVITATION COUNT, AND THERE COULD NOT HONESTLY BE A "VENDOR INVITATION" ONE.
-- Both invitation tables in this schema are RETAILER-scoped (retailer_invitations is
-- constrained to Retailer organizations by trigger; retailer_staff_invitations carries no
-- vendor_organization_id at all). Nothing invites a user into a VENDOR organization, so a
-- "pending Vendor user invitations" figure has no table to come from. A Vendor user's invited
-- state is organization_members.status = 'INVITED' — ordinary column data, already visible
-- through list_vendor_users(), and deliberately NOT folded into the ACTIVE member count below.
--
-- THE AUDIT COUNT IS ALL-TIME AND HAS NO WINDOW. The web card counts every audit row for the
-- organization with no date predicate whatsoever, and its label is "Audit Events" with the
-- hint "Recorded admin actions for this organization". There is no shipped notion of "today",
-- "this week" or "last 30 days" anywhere in this product, so inventing one here would be a
-- new product definition made in SQL. The field is named audit_event_count — not
-- recent_audit_event_count — for that reason.
--
-- ============================================================================
-- NO INPUT, ANYWHERE
-- ============================================================================
-- The function takes ZERO ARGUMENTS. There is no user id, auth user id, profile id,
-- membership id, Vendor organization id, tenant id, role code, permission code, status array,
-- date range, period selector or organization selector on it. There is nothing for a client
-- to supply and therefore nothing for a client to forge: the Vendor is derived from
-- auth.uid() through public.get_vendor_super_admin_context(), exactly as every other Vendor
-- RPC in this schema derives it.
--
-- ============================================================================
-- MULTI-VENDOR BEHAVIOUR IS PRESERVED, NOT CHANGED
-- ============================================================================
-- get_vendor_super_admin_context() returns one row per qualifying VENDOR organization,
-- ordered by organization id, and every existing Vendor RPC takes the first. A caller who is
-- a Super Admin of two Vendors therefore summarises the lowest-id Vendor,
-- deterministically and on every request — the shipped behaviour of list_vendor_retailers(),
-- list_vendor_users(), list_vendor_products(), list_vendor_audit_logs() and of the web's own
-- getVendorSuperAdminAccess(), which takes contextRows[0] from the same ordered set. It is
-- reproduced here verbatim rather than "fixed": changing it would change which organization's
-- figures an existing operator sees as a side effect of a mobile read. It is documented as a
-- limitation in docs/mobile-vendor-dashboard-summary-audit.md § 4.4 instead.
--
-- ============================================================================
-- Idempotency posture
-- ============================================================================
-- Plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE). A conflicting existing
-- object FAILS the migration. No dynamic SQL. No fixed UUIDs. Every reference is
-- schema-qualified because the function runs with an EMPTY search_path. All identifiers are
-- <= 63 bytes.
--
-- Dependencies: 20260716124419 (organization_members and organization_members_org_status_idx),
--   20260716125559 (roles, permissions, roles_status_idx), 20260716130351 (audit_logs and
--   audit_logs_org_created_idx), 20260716131104 (has_organization_permission),
--   20260716133023 (the ORGANIZATION_MEMBERS_READ, RBAC_READ and AUDIT_LOGS_READ permissions
--   and their VENDOR_SUPER_ADMIN mappings), 20260717083515 (get_vendor_super_admin_context).


-- ============================================================================
-- FUNCTION — get_vendor_admin_dashboard_summary()
-- ============================================================================
-- Exactly one row of four bigint counts for the calling Vendor Super Admin's organization.
--
-- ----------------------------------------------------------------------------
-- AUTHORIZATION: THE ROLE *AND* ALL THREE PERMISSIONS, AND ONE REFUSAL FOR EVERY FAILURE
-- ----------------------------------------------------------------------------
-- The caller must clear BOTH gates:
--   1. get_vendor_super_admin_context() must yield a Vendor — an ACTIVE profile owned by
--      auth.uid(), an ACTIVE membership, an ACTIVE organization of type VENDOR, and an ACTIVE
--      VENDOR_SUPER_ADMIN role. A signed-out caller, a Retailer Owner, a Retailer Manager, a
--      Sales Staff member, a Vendor member with no role, a suspended profile and a suspended
--      membership all resolve to zero rows here.
--   2. has_organization_permission(<that Vendor>, …) must be true for ALL THREE of
--      ORGANIZATION_MEMBERS_READ, RBAC_READ and AUDIT_LOGS_READ.
--
-- THESE ARE THE REAL, ALREADY-SEEDED CODES, and they are exactly the permissions the four
-- counted reads already require — read from 20260716133023 (modules ORGANIZATION_MEMBERS,
-- RBAC, AUDIT_LOGS), where all three are already mapped to VENDOR_SUPER_ADMIN, and already
-- named by the migration-5 RLS policies that gate the very tables counted below:
--
--     active_member_count        organization_members_select_self_or_authorized
--                                  -> ORGANIZATION_MEMBERS_READ
--     catalog_active_role_count  roles_select_rbac_authorized        -> RBAC_READ
--     catalog_permission_count   permissions_select_rbac_authorized  -> RBAC_READ
--     audit_event_count          audit_logs_select_authorized        -> AUDIT_LOGS_READ
--
-- Nothing is invented and no permission is seeded here; no shipped caller's access changes.
--
-- WHY *ALL* AND NOT *SOME* — THE CONTRACT IS DELIBERATELY NON-PARTIAL. The alternative
-- considered was returning each count only when its own permission is held, with the others
-- omitted or null. It is rejected for three reasons:
--   a. THE WEB HAS NO SUCH BEHAVIOUR TO MIRROR. Its cards degrade only on a DATABASE ERROR,
--      never on a permission — every RLS policy above is an OR that the VENDOR_SUPER_ADMIN
--      role branch already satisfies, so a Vendor Super Admin on the web receives all four
--      figures regardless of which permissions their role maps. There is no shipped notion of
--      a suppressed card to translate.
--   b. A NULLABLE COUNT IS A TRAP. `null` and `0` are one typo apart in every client, and a
--      summary field that is sometimes "not permitted" and sometimes "none" invites a
--      dashboard that renders "0 members" to someone who simply may not see members.
--      Returning bigint that is ALWAYS a real count removes the failure mode entirely.
--   c. IT MATCHES EVERY OTHER MOBILE VENDOR READ. list_vendor_users() requires
--      ORGANIZATION_MEMBERS_READ *and* RBAC_READ; list_vendor_audit_logs() requires
--      AUDIT_LOGS_READ. This function requires the union of what its constituent figures
--      require, so THE SUMMARY CAN NEVER BE MORE PERMISSIVE THAN THE SCREENS IT SUMMARISES —
--      a client cannot learn a member count here that list_vendor_users() would refuse it.
--
-- REQUIRING BOTH THE ROLE AND THE PERMISSIONS IS NARROWER THAN THE RLS POLICIES, WHICH ARE
-- `OR`s. Narrower is safe by construction: it can only refuse callers the policies would have
-- admitted, never admit one they would refuse. Concretely, a Vendor Super Admin whose role has
-- had AUDIT_LOGS_READ withdrawn is refused HERE while the web dashboard would still render all
-- four cards — the correct direction, and asserted in pgTAP by removing each seeded mapping in
-- turn.
--
-- The refusal is one generic 42501 for every failing case. The message names no table, column,
-- policy, permission, Vendor, count or row: "not signed in", "not a Vendor Super Admin", "this
-- Vendor's role does not hold RBAC_READ" and "your membership is suspended" are byte-identical
-- to the client. A denial is never converted to a row of zeros, because "you may not read this
-- summary" and "this Vendor has nothing" are opposite claims, and a dashboard that quietly
-- rendered four zeros to a denied caller would be actively misleading.
--
-- ----------------------------------------------------------------------------
-- EXACTLY ONE ROW, ALWAYS, AND NEVER A NULL COUNT
-- ----------------------------------------------------------------------------
-- The body is a single `select` with NO from-clause and four scalar subqueries. Both
-- properties below are STRUCTURAL — they follow from that shape rather than from a guard that
-- a later edit could drop:
--
--   * ONE ROW. A select without a from-clause produces exactly one row. An authorized Vendor
--     therefore ALWAYS receives one row — a brand-new Vendor with no members, no history and
--     an empty catalogue included. Zero rows is not a reachable outcome for an authorized
--     caller, so a client never has to distinguish "no summary" from "an empty summary".
--   * NEVER NULL. count(*) is bigint and is never null, and an aggregate scalar subquery with
--     no GROUP BY returns exactly one row EVEN WHEN IT MATCHES NOTHING — the aggregate over an
--     empty set is 0, not NULL and not "no row". No coalesce() is needed and none is written;
--     adding one would imply a null was possible. Counts are non-negative by construction, so
--     a negative value is likewise unrepresentable.
--
-- ----------------------------------------------------------------------------
-- THE FOUR METRIC DEFINITIONS, EXACTLY
-- ----------------------------------------------------------------------------
-- Each matches its web card byte-for-byte in table, predicate and status semantics.
--
-- 1. active_member_count  — "Active Members" on the web.
--      Relation:   public.organization_members.
--      Tenant:     organization_id = the derived Vendor. Scalar FK, so a membership belongs to
--                  exactly one organization and cannot be shared or double-counted.
--      Status:     status = 'ACTIVE' only. INVITED, SUSPENDED and DEACTIVATED memberships are
--                  EXCLUDED — the card says "Active Members" and it means it.
--      Rows or entities: ROWS, but the row IS the entity: organization_members is UNIQUE on
--                  (organization_id, user_id), so one person cannot hold two memberships in
--                  one Vendor and no duplicate is possible. No DISTINCT is needed, and none is
--                  written — a DISTINCT here would imply a duplication that the unique
--                  constraint already forbids.
--      Independence: does NOT depend on profiles.status. A SUSPENDED person holding an ACTIVE
--                  membership IS counted, exactly as the web counts them — the web's query
--                  filters organization_members.status alone and never joins profiles. Those
--                  are two independent facts and list_vendor_users() reports both separately.
--      Deleted rows: cannot count. The FKs are ON DELETE CASCADE from both organizations and
--                  profiles, so a deleted person or organization takes its membership rows
--                  with it. There is no soft-delete column on this table.
--      Zero:       a Vendor whose only member is the caller returns 1, never 0 — the caller's
--                  own ACTIVE membership is what authorized them. 0 is unreachable for an
--                  authorized caller and is nonetheless returned, not omitted, if it ever were.
--
-- 2. catalog_active_role_count  — "Active Roles" on the web. GLOBAL, NOT TENANT-SCOPED.
--      Relation:   public.roles — the deployment-wide catalogue. No organization_id exists on
--                  this table, so there is no tenant predicate to apply and none is applied.
--      Status:     status = 'ACTIVE' only. roles_status_allowed permits exactly ACTIVE and
--                  INACTIVE, so this is "every role definition that is not retired".
--      Rows or entities: ROWS. roles.code is UNIQUE, so a row IS a role definition.
--      Not counted: role ASSIGNMENTS. This is not a count of member_roles and it does not vary
--                  with how many people hold a role, or with whether any Vendor uses it at all.
--      Zero:       0 is unreachable in a migrated database (20260716133023 seeds three) but is
--                  returned honestly if the catalogue were ever emptied.
--
-- 3. catalog_permission_count  — "Permissions" on the web. GLOBAL, NOT TENANT-SCOPED.
--      Relation:   public.permissions — the deployment-wide catalogue. No organization_id.
--      Status:     NONE. public.permissions HAS NO STATUS COLUMN, so the whole catalogue is
--                  counted and there is no active/inactive distinction to make. The field is
--                  deliberately not named catalog_active_permission_count for that reason.
--      Rows or entities: ROWS. permissions.code is UNIQUE, so a row IS a permission
--                  definition. This is not a count of grants: role_permissions is not read.
--      Not counted: the caller's OWN permissions. This figure is identical for a Vendor Super
--                  Admin and for every other reader, and grows only when a migration adds a
--                  permission to the catalogue.
--
-- 4. audit_event_count  — "Audit Events" on the web.
--      Relation:   public.audit_logs.
--      Tenant:     organization_id = the derived Vendor. That single column is the whole
--                  boundary: it is a scalar FK, so an audit row belongs to exactly one
--                  organization and cannot be shared or double-counted.
--      Status:     NONE, and no window. public.audit_logs has no status, no soft-delete and no
--                  outcome column, and this count applies NO date predicate — it is the
--                  all-time total, exactly as the web card is.
--      Null org:   EXCLUDED. audit_logs.organization_id is nullable (ON DELETE SET NULL, and a
--                  global record may be written with no organization) and
--                  audit_logs_select_authorized excludes such rows from BOTH of its branches
--                  deliberately: a row with no organization has no tenant to authorize
--                  against. `organization_id = v_vendor` reproduces that exclusion exactly —
--                  null never equals anything — so orphaned history is never re-attributed to
--                  whoever reads next.
--      Historical: YES, and that is the point. Events whose actor's profile was later deleted
--                  (actor_profile_id ON DELETE SET NULL) still count; the row survives. The
--                  table is append-only and nothing in this schema prunes it, so this figure
--                  only ever grows.
--      Zero:       a Vendor that has recorded nothing returns 0, and 0 is a real answer — it
--                  is NOT how a denial is represented.
--
-- ----------------------------------------------------------------------------
-- WHY SECURITY DEFINER COUNTS EQUAL THE WEB'S RLS-FILTERED COUNTS
-- ----------------------------------------------------------------------------
-- The web issues these four counts through the ordinary authenticated client, so each is
-- computed over exactly the rows the caller's policies admit. This function is SECURITY
-- DEFINER and therefore computes them over the base tables. The two agree for every
-- authorized caller, and the reason is checked per table rather than assumed:
--
--   organization_members — the policy admits a row when it is the caller's own OR the caller
--     holds ORGANIZATION_MEMBERS_READ or VENDOR_SUPER_ADMIN for THAT ROW'S organization. The
--     caller here holds both the role and the permission in the derived Vendor, so every row
--     of that Vendor is admitted. Filtering to that Vendor gives the same set.
--   roles / permissions — the policies gate the catalogue WHOLESALE on RBAC_READ or
--     VENDOR_SUPER_ADMIN in any of the caller's own organizations. The caller holds both, so
--     the entire catalogue is admitted. Filtering by status alone gives the same set.
--   audit_logs — the policy admits non-null-organization rows for which the caller holds
--     AUDIT_LOGS_READ or VENDOR_SUPER_ADMIN. The caller holds both in the derived Vendor, and
--     the predicate below selects exactly that Vendor's non-null rows.
--
-- The definer rights are what let this function answer in ONE statement instead of paying the
-- policy predicates — each of which re-walks the authorization chain — once per counted table.
-- The chain is walked once, at the top, instead.
--
-- ----------------------------------------------------------------------------
-- NOT RETURNED, and the reason each is withheld
-- ----------------------------------------------------------------------------
--   organization_id, organization name  the caller already knows which Vendor they are, and an
--                                       id in a payload is one a form could echo back as
--                                       authorization. The web reads the NAME from the same
--                                       authorization context the client already has
--                                       (get_my_portal_context / the admin shell), not from
--                                       this summary. This function returns COUNTS ONLY.
--   any id at all                       nothing here addresses a row, so no id is needed and
--                                       none is emitted.
--   auth ids, profile ids, emails,      no person is identified by this function. It reads
--     phone numbers, display names      profiles NOT AT ALL — the member count needs only
--                                       organization_members.
--   role codes, role names,             the counted catalogue is returned as a NUMBER. Naming
--     permission codes, module names    its contents is what list_vendor_roles() is for.
--   audit rows, action codes,           this is a COUNT, not a feed. No audit row, no
--     entity types, actor names,        timestamp, no metadata and no entity reference is
--     metadata, ip_address, user_agent  read or returned. list_vendor_audit_logs() is the
--                                       paginated history read, and it stays the only one.
--   raw statuses                        statuses are PREDICATES here, not output. No status
--                                       string is emitted by any field.
--   invitation tokens or hashes         never returned by anything, anywhere — and neither
--                                       invitation table is read by this function at all.
--   percentages, deltas, trends,        no such figure exists on the web dashboard, so there
--     time series, "last N days"        is no shipped definition to share. Inventing one here
--                                       would be a product decision made in a migration.
--   Retailer, Product, shop,            not on the web dashboard. See the header.
--     assignment, invitation counts
create function public.get_vendor_admin_dashboard_summary()
returns table (
  active_member_count       bigint,
  catalog_active_role_count bigint,
  catalog_permission_count  bigint,
  audit_event_count         bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  -- Identity and Vendor, from auth.uid() alone, ONCE per call — never per count.
  -- get_vendor_super_admin_context() accepts no arguments and evaluates the whole chain.
  -- ORDER BY / LIMIT 1 reproduces the shipped multi-Vendor rule; see the header.
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  -- Fail closed, and generically. All four gates are evaluated as one condition so that no
  -- caller can tell WHICH one refused them — the four failures are byte-identical.
  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'ORGANIZATION_MEMBERS_READ')
     or not public.has_organization_permission(v_vendor, 'RBAC_READ')
     or not public.has_organization_permission(v_vendor, 'AUDIT_LOGS_READ') then
    raise exception 'Not authorized to view the dashboard summary'
      using errcode = 'insufficient_privilege';
  end if;

  -- ONE statement, four independent scalar subqueries, no from-clause, no join between the
  -- counted relations and therefore NO WAY FOR ONE COUNT TO INFLATE ANOTHER.
  --
  -- WHY SCALAR SUBQUERIES AND NOT A JOIN WITH `count(*) FILTER`. The four relations have no
  -- key in common — two are tenant-scoped and two are a global catalogue — so joining them
  -- would produce a cartesian product and every count would be multiplied by the cardinality
  -- of the others. Scalar subqueries keep the four definitions INDEPENDENT and separately
  -- readable, which is also what makes each one auditable against its web counterpart line by
  -- line. `count(*) FILTER` is the right tool for several counts over ONE relation; it is the
  -- wrong tool for four counts over four unrelated relations.
  --
  -- ACCESS PATHS (MEASURED — and the planner does NOT always use an index; see the closing
  -- note for the full EXPLAIN output and why that is the correct outcome rather than a
  -- missing-index finding):
  --   organization_members  organization_members_org_status_idx (organization_id, status) when
  --                         the organization predicate is SELECTIVE; a plain seq scan when the
  --                         Vendor owns most of the table, which is this product's actual shape.
  --   roles                 a catalogue of single-digit size. The plan VARIES between a seq
  --                         scan and a bitmap index scan on roles_status_idx depending on
  --                         table statistics; both were observed, and at this scale the
  --                         difference is immaterial (< 0.2 ms either way).
  --   permissions           seq scan of a small catalogue. No index exists on a status column
  --                         because there IS no status column.
  --   audit_logs            audit_logs_org_created_idx (organization_id, created_at desc) when
  --                         selective; a PARALLEL seq scan in the single-Vendor shape. This is
  --                         the only count that grows without bound, and it is the same exact
  --                         count the web already performs on every dashboard load.
  return query
  select
    (select count(*)
       from public.organization_members m
      where m.organization_id = v_vendor
        and m.status = 'ACTIVE'),

    (select count(*)
       from public.roles r
      where r.status = 'ACTIVE'),

    (select count(*)
       from public.permissions),

    (select count(*)
       from public.audit_logs a
      where a.organization_id = v_vendor);
end;
$$;

revoke all     on function public.get_vendor_admin_dashboard_summary() from public;
revoke execute on function public.get_vendor_admin_dashboard_summary() from anon;
grant  execute on function public.get_vendor_admin_dashboard_summary() to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- One read function. Nothing else exists in this migration. No table, column, constraint,
-- index, trigger, RLS policy, role, permission or mapping is created or altered; no existing
-- function is touched; no seed row is written; no audit row is written or modified; and no
-- table privilege is granted to any browser role — public.organization_members, public.roles,
-- public.permissions and public.audit_logs in particular keep exactly the SELECT-only,
-- RLS-governed posture 20260716131930 left them in.
--
-- NO INDEX IS ADDED, and that is a MEASURED conclusion rather than an omission. The
-- measurement is reported honestly below, INCLUDING THE CASES WHERE NO INDEX IS USED AT ALL —
-- because that outcome is the planner being right, not an index being missing.
--
-- EXPLAIN (ANALYZE, BUFFERS) on a local reset, 200,000 audit rows and 5,000 memberships.
--
--   SHAPE A — ONE VENDOR OWNS EVERYTHING. This is the shape SalesReward actually has: the
--   product is "controlled by a single vendor company", so the organization predicate matches
--   every row and selects nothing away. The planner correctly declines both indexes — reading
--   a whole table through an index is strictly worse than reading it directly:
--
--     organization_members  Aggregate -> Seq Scan  (4,038 of 5,000 rows ACTIVE)
--                           63 buffers, 1.2 ms
--     audit_logs            Finalize Aggregate -> Gather (2 workers) -> Parallel Seq Scan
--                           3,847 buffers, 28.6 ms for 200,000 rows
--     roles                 Aggregate -> Seq Scan  OR  Aggregate -> Bitmap Heap Scan
--                             -> Bitmap Index Scan on roles_status_idx
--                           BOTH plans were observed across runs, depending on whether the
--                           catalogue had been ANALYZEd. 6 rows, 0.05–0.18 ms either way.
--     permissions           Aggregate -> Seq Scan, 18 rows, 0.04 ms
--
--   SHAPE B — 40 VENDORS, THE TARGET HOLDING 1/40 OF THE ROWS. Now the predicate is selective
--   and both shipped indexes are used, without anything being added for them:
--
--     organization_members  Aggregate -> Bitmap Heap Scan
--                             -> Bitmap Index Scan on organization_members_org_status_idx
--                           101 rows, 62 buffers, 0.6 ms
--     audit_logs            Aggregate -> Bitmap Heap Scan
--                             -> Bitmap Index Scan on audit_logs_org_created_idx
--                           5,000 rows, 3,893 buffers, 6.4 ms
--
--   NOTE THE AUDIT BUFFER COUNT IN SHAPE B: 3,893 heap blocks to count 5,000 rows, essentially
--   the whole table, because a Vendor's events are INTERLEAVED with every other Vendor's in
--   physical order. The index narrows the ROWS but not the PAGES. That is inherent to counting
--   a slice of an append-only log and is not fixable with another btree; only a covering
--   index-only scan would avoid the heap, and the index would have to include no other
--   columns and the table be recently vacuumed for the visibility map to permit it. The
--   measured 6.4 ms does not justify a third index on the largest append-only table in the
--   schema, paid for on every administrative write.
--
-- THE AUDIT COUNT IS EXACT AND ITS COST IS PROPORTIONAL TO THE VENDOR'S HISTORY. That is
-- inherent to an exact COUNT over an append-only table that is never pruned, and it is
-- ACCEPTED HERE RATHER THAN OPTIMISED AWAY because it is precisely what the web card already
-- does — lib/dashboard/vendor-admin-summary.ts issues `count: "exact"` on the same table with
-- the same predicate. Substituting a planner estimate (reltuples), a materialised counter or a
-- time-windowed count would make the mobile figure DISAGREE WITH THE WEB FIGURE, which is a
-- worse defect than the scan: two clients showing different numbers for the same card is how
-- an operator stops trusting both. At 200,000 rows the measured cost is 28.6 ms (parallel seq
-- scan) or 6.4 ms (bitmap scan) depending on shape, which is well inside a dashboard budget
-- that today pays four network round trips for the same four numbers. If the history ever
-- outgrows that, the correct answer is a product decision about what the card should mean —
-- an explicit time window, or an approximate figure labelled as one, applied to BOTH clients
-- together — not a silent divergence introduced in a migration.
--
-- service_role is granted nothing here. This read derives its authority from auth.uid(), which
-- a service-role connection does not have, so granting it would produce a function that can
-- only ever refuse.
--
-- Nothing in this migration writes: there is no insert, update or delete anywhere in the
-- function, and it is declared STABLE, so it cannot create, edit, delete or clear any row, and
-- cannot be used to change anything else either.
