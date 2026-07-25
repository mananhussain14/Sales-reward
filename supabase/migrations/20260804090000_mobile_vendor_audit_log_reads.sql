-- Migration: mobile_vendor_audit_log_reads
-- Purpose: The ONE read a Vendor Super Admin needs to page through their organization's
--          recorded administrative history from a mobile client. It adds, and only adds:
--            1. public.list_vendor_audit_logs(integer, timestamptz, uuid)  [authenticated]
--
-- THIS MIGRATION CHANGES NOTHING THAT IS ALREADY DEPLOYED. No table, column, constraint,
--   index, trigger, RLS policy, role, permission or permission mapping is created, altered or
--   dropped. No existing function is edited, dropped or replaced. No seed row is written. In
--   particular public.audit_logs keeps the exact posture 20260716130351 and 20260716131930
--   left it in: RLS enabled, one SELECT policy (audit_logs_select_authorized), SELECT and
--   nothing else granted to `authenticated`, nothing at all to `anon`. No audit trigger is
--   added, altered or removed, no existing write path is touched, and this function writes
--   no audit row of its own — reading a history is not an event in it.
--
-- THE WEB AUDIT LOGS PAGE IS NOT MIGRATED HERE. app/(admin)/audit-logs/page.tsx and
--   lib/audit/vendor-audit-logs.ts are untouched and keep issuing exactly the two direct
--   table reads they issue today. This migration only makes the same history reachable
--   through one shared, paginated, privacy-filtered contract that Flutter can call and that
--   the web may adopt later.
--
-- ============================================================================
-- WHY THIS FUNCTION EXISTS — THE THREE GAPS THE AUDIT PROVED
-- ============================================================================
-- The Vendor Audit Logs page is REAL and DATABASE-BACKED, not a placeholder. It renders
-- public.audit_logs through lib/audit/vendor-audit-logs.ts. Three properties of that
-- implementation make it unusable as a mobile contract, and each is a gap this function
-- closes rather than a defect in the web:
--
--   GAP 1 — THERE IS NO PAGINATION AT ALL. getVendorAuditLogs() takes a fixed
--   AUDIT_LOG_LIMIT = 100 and stops. There is no cursor, no offset, no "older" affordance,
--   and the module's own comment records why the cap exists: audit_logs is append-only and
--   never pruned, so an uncapped read gets slower every day. On a phone that cap is the whole
--   feature — record 101 is unreachable forever. A mobile history screen needs to scroll, and
--   scrolling an INDEFINITELY GROWING security log is precisely the case where OFFSET is the
--   wrong tool: offset N re-walks N rows on every page, and a single new event arriving
--   between page 1 and page 2 shifts every subsequent window by one, which duplicates one row
--   and skips none — or skips one and duplicates none — depending on direction. Keyset
--   pagination over the full sort key is the fix, and it is what this function implements.
--
--   GAP 2 — THE ACTOR NAME IS RESOLVED IN TYPESCRIPT, OVER A SECOND ROUND TRIP.
--   loadAuditLogs() reads audit_logs, collects the distinct actor_profile_id values in JS,
--   issues a second `profiles ... in (...)` query, builds a Map, and joins in memory. That is
--   a good implementation — it is set-based and it is two queries regardless of row count,
--   never one per row — but it is a JOIN WRITTEN IN TYPESCRIPT, and rebuilding it in Dart
--   would make a second client responsible for the same privacy decision. Worse, the two
--   clients would make that decision DIFFERENTLY: the web's second query is subject to the
--   profiles RLS policy, so which actors resolve to a name depends on a policy predicate
--   evaluated per caller, whereas a Flutter client issuing the same query under a different
--   session would resolve a different subset. One SQL function that answers "who did this,
--   as far as this Vendor is entitled to know" identically for every client is the point.
--
--   GAP 3 — THE AFFECTED ENTITY IS NOT NAMED, ONLY TYPED. The web renders entity_type
--   ("Vendor product") and nothing else, because entity_id is an opaque id and metadata is
--   unrestricted jsonb it deliberately never selects. So the page can say a product was
--   updated but not WHICH product — the single most useful fact on an audit line. The audit
--   found that the answer is already stored: every writer in this schema puts a NAME SNAPSHOT
--   in metadata at the moment of the event. This function extracts exactly those snapshots,
--   through a closed per-entity-type key whitelist, and returns nothing else from metadata.
--
-- ============================================================================
-- NO DETAIL FUNCTION IS ADDED, AND THAT IS A FINDING, NOT AN OMISSION
-- ============================================================================
-- The audit searched the whole repository for an audit-log detail surface: a drawer, a modal,
-- a [auditLogId] route, an expandable row, a "view details" action. There is NONE.
-- app/(admin)/audit-logs/ contains exactly two files — page.tsx and loading.tsx — and the
-- page renders one flat table and one card list over four preformatted strings. There is no
-- second web read to share, and therefore no shipped notion of what audit "detail" even
-- means in this product.
--
-- The only thing a detail read could add over the list is the part of an audit row this
-- contract deliberately withholds: metadata as a whole, entity_id, ip_address, user_agent.
-- Adding a function to expose those would not be sharing an existing capability — it would be
-- INVENTING a new and more sensitive one, on a table the milestone explicitly scopes to
-- read-only reuse. So this milestone is LIST-ONLY by decision, and the reason is recorded in
-- docs/mobile-vendor-audit-log-reads-audit.md § 6 rather than left as an absence.
--
-- ============================================================================
-- NO TENANT INPUT, ANYWHERE
-- ============================================================================
-- The three parameters are a page size and a two-part cursor. NONE of them is authorization
-- context and none of them can widen what is visible:
--
--   * There is no user id, auth user id, profile id, membership id, Vendor organization id,
--     tenant id, role code, permission code, actor id, entity owner id or organization
--     selector on this function.
--   * The Vendor is derived from auth.uid() through public.get_vendor_super_admin_context(),
--     exactly as every other Vendor RPC in this schema derives it.
--   * The cursor selects a POSITION IN AN ALREADY-AUTHORIZED SEQUENCE. It is applied AFTER
--     the organization_id predicate, never instead of it, so a cursor copied from another
--     Vendor's page — or invented outright — moves the window within the caller's OWN history
--     and can never reach across the tenant boundary. An audit_log_id belonging to another
--     Vendor names a row this caller's predicate already excludes; the only effect of
--     supplying one is a differently-positioned page of the caller's own events. This is
--     asserted directly in pgTAP rather than argued.
--
-- ============================================================================
-- MULTI-VENDOR BEHAVIOUR IS PRESERVED, NOT CHANGED
-- ============================================================================
-- get_vendor_super_admin_context() returns one row per qualifying VENDOR organization,
-- ordered by organization id, and every existing Vendor RPC takes the first. A caller who is
-- a Super Admin of two Vendors therefore reads the lowest-id Vendor's history,
-- deterministically and on every request — the shipped behaviour of list_vendor_retailers(),
-- list_vendor_users(), list_vendor_products() and of the web's own getVendorSuperAdminAccess(),
-- which takes contextRows[0] from the same ordered set. It is reproduced here verbatim rather
-- than "fixed": changing it would change which organization's history an existing operator
-- sees as a side effect of a mobile read. It is documented as a limitation in
-- docs/mobile-vendor-audit-log-reads-audit.md § 4.4 instead.
--
-- ============================================================================
-- Idempotency posture
-- ============================================================================
-- Plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE). A conflicting existing
-- object FAILS the migration. No dynamic SQL. No fixed UUIDs. Every reference is
-- schema-qualified because the function runs with an EMPTY search_path. All identifiers are
-- <= 63 bytes.
--
-- Dependencies: 20260716124419 (profiles, organization_members), 20260716130351 (audit_logs
--   and audit_logs_org_created_idx), 20260716131104 (has_organization_permission),
--   20260716133023 (the AUDIT_LOGS_READ permission and its VENDOR_SUPER_ADMIN mapping),
--   20260717083515 (get_vendor_super_admin_context).


-- ============================================================================
-- FUNCTION — list_vendor_audit_logs(integer, timestamptz, uuid)
-- ============================================================================
-- One keyset-paginated page of the calling Vendor organization's recorded administrative
-- history, newest first.
--
-- ----------------------------------------------------------------------------
-- AUTHORIZATION: THE ROLE *AND* THE PERMISSION, AND ONE REFUSAL FOR EVERY FAILURE
-- ----------------------------------------------------------------------------
-- The caller must clear BOTH gates:
--   1. get_vendor_super_admin_context() must yield a Vendor — an ACTIVE profile owned by
--      auth.uid(), an ACTIVE membership, an ACTIVE organization of type VENDOR, and an ACTIVE
--      VENDOR_SUPER_ADMIN role. A signed-out caller, a Retailer Owner, a Retailer Manager, a
--      Sales Staff member, a Vendor member with no role, a suspended profile and a suspended
--      membership all resolve to zero rows here.
--   2. has_organization_permission(<that Vendor>, 'AUDIT_LOGS_READ') must be true.
--
-- AUDIT_LOGS_READ IS THE REAL, ALREADY-SEEDED CODE — read from
-- 20260716133023_seed_vendor_admin_roles_permissions.sql (module 'AUDIT_LOGS'), where it is
-- already mapped to VENDOR_SUPER_ADMIN, and already named by the audit_logs_select_authorized
-- RLS policy. Nothing is invented and no permission is seeded here; no shipped caller's
-- access changes.
--
-- REQUIRING BOTH IS DELIBERATELY NARROWER THAN THE RLS POLICY, WHICH IS AN `OR`. The policy
-- admits a row on AUDIT_LOGS_READ *or* the VENDOR_SUPER_ADMIN role. This function demands the
-- role *and* the permission, matching the shape of every other mobile Vendor read and of the
-- milestone's requirement. Narrower is safe by construction: it can only refuse callers the
-- policy would have admitted, never admit one the policy would refuse. Concretely, a Vendor
-- Super Admin whose role has had AUDIT_LOGS_READ withdrawn is refused HERE while the web page
-- would still render — which is the correct direction, and is asserted in pgTAP by removing
-- the seeded mapping.
--
-- The refusal is one generic 42501 for every failing case. The message names no table, column,
-- policy, permission, Vendor or row: "not signed in", "not a Vendor Super Admin", "this
-- Vendor's role does not hold AUDIT_LOGS_READ" and "your membership is suspended" are
-- byte-identical to the client. A denial is never converted to an empty page, because "you may
-- not read this history" and "this Vendor has recorded nothing" are opposite claims, and on an
-- audit surface confusing them would be a serious misstatement.
--
-- ----------------------------------------------------------------------------
-- WHAT A ROW IS, AND WHICH ROWS ARE VISIBLE
-- ----------------------------------------------------------------------------
-- One row per public.audit_logs row whose organization_id IS the derived Vendor. That single
-- column is the whole tenant boundary and there is no second one: audit_logs.organization_id
-- is a scalar FK to public.organizations, so AN AUDIT ROW BELONGS TO EXACTLY ONE
-- ORGANIZATION AND CANNOT BE SHARED. Another Vendor's rows are absent — not refused, not
-- counted, not hinted at — and the function reveals nothing about whether another Vendor has
-- any history at all.
--
-- ROWS WITH A NULL organization_id ARE INVISIBLE HERE, exactly as they are to the web. The
-- column is nullable (ON DELETE SET NULL, and a global record may be written with no
-- organization), and audit_logs_select_authorized excludes such rows from BOTH of its
-- branches deliberately: a row with no organization has no tenant to authorize against. The
-- `organization_id = v_vendor` predicate below reproduces that exclusion — null never equals
-- anything — so a Vendor whose organization row was deleted does not have its orphaned
-- history silently re-attributed to whoever reads next.
--
-- NO FILTERS. Not by action, not by entity type, not by actor, not by date range. The audit
-- found the web offers none, so there is no shipped filter semantics to share, and a filter
-- invented here would be a new product decision made in a migration. A first Flutter history
-- screen needs to scroll and refresh, both of which the cursor already provides. Adding one
-- later is additive; guessing one now and having clients depend on it is not.
--
-- ----------------------------------------------------------------------------
-- ORDERING AND THE CURSOR
-- ----------------------------------------------------------------------------
-- ORDER BY created_at DESC, id DESC. Both columns, always — and the cursor is built from BOTH.
--
-- THE TIE-BREAKER IS LOAD-BEARING, NOT DEFENSIVE. created_at defaults to now(), which in
-- PostgreSQL is TRANSACTION timestamp, not statement timestamp: two audit rows written inside
-- one transaction carry byte-identical created_at values. A timestamp-only cursor over a tied
-- pair either re-emits both rows on the next page or skips both, and there is no third
-- outcome. `id` breaks every tie totally (it is the primary key), so the composite sort key is
-- UNIQUE, the ordering is total, and the page boundary falls at exactly one place. pgTAP
-- asserts this against a deliberately-constructed group of rows sharing one timestamp.
--
-- THE CURSOR IS THE SAME TWO COLUMNS, AND MUST BE SUPPLIED WHOLE. Both null means "the newest
-- page". Both non-null means "strictly older than this exact position". Exactly one non-null
-- is a MALFORMED cursor and raises 22023 rather than being silently completed with a default —
-- a half cursor is a client bug, and quietly treating it as "newest page" would present a
-- rewound list as a continuation, which is how a paginating client silently loses rows.
--
-- WHY NEW EVENTS CANNOT CORRUPT TRAVERSAL. The predicate is strictly-less-than against a
-- fixed position in a DESCENDING order, so every row a later page can return is OLDER than the
-- cursor. Events arriving after page 1 are all NEWER than page 1's last row, so they land
-- outside every subsequent page's range by construction. They are not skipped either — they
-- appear the moment the client refreshes with a null cursor, which is exactly what
-- pull-to-refresh does. Under OFFSET the same insert would have shifted every window.
--
-- A cursor older than every row returns an EMPTY LIST, not an error: the client has reached
-- the end of the history, which is a normal terminal state and the signal to stop paging.
--
-- ----------------------------------------------------------------------------
-- THE LIMIT IS BOUNDED AT BOTH ENDS, AND OUT-OF-RANGE IS AN ERROR
-- ----------------------------------------------------------------------------
--   * null           -> 50. The default is deliberately smaller than the web's 100: a phone
--                      renders a shorter viewport and pays for every byte, and the client can
--                      always ask for another page.
--   * 1 .. 100       -> honoured exactly. 100 is the hard server-side maximum, chosen to match
--                      the web's existing AUDIT_LOG_LIMIT so no client can pull a larger
--                      single read than the product already performs.
--   * anything else  -> 22023. That covers 0, every negative value, and every value above 100.
--
-- OUT-OF-RANGE RAISES RATHER THAN CLAMPING, and the choice matters. A client that asks for 500
-- and silently receives 100 has been told nothing, and the natural (wrong) inference — "fewer
-- rows came back than I asked for, so I have reached the end" — terminates its paging loop
-- early and hides the rest of the history. Refusing makes the bound impossible to misread. A
-- zero or negative limit is likewise refused rather than coerced: LIMIT 0 would be an empty
-- page indistinguishable from the end of the history, and a negative LIMIT is unbounded in
-- PostgreSQL, which on an append-only table that grows forever is the one outcome this
-- function exists to prevent.
--
-- ----------------------------------------------------------------------------
-- ACTION AND ENTITY CODES ARE RETURNED EXACTLY AS STORED
-- ----------------------------------------------------------------------------
-- action_code and entity_type are the raw stored strings. Nothing is mapped, normalized,
-- defaulted, humanized, hidden or inferred.
--
-- NO LABEL COLUMN IS RETURNED, BECAUSE NO TRUSTED MAPPING EXISTS TO RETURN. Both columns are
-- plain `text` with only a non-empty CHECK — no enum, no lookup table, no reference data
-- anywhere in the schema. The web's toReadableLabel() is a GENERIC humanizer (underscores to
-- spaces, sentence case), and its own comment states that it is a temporary stand-in to be
-- replaced by an explicit map once the vocabulary exists. Promoting a placeholder into a
-- shared database contract would freeze a stop-gap into an API. Clients map known codes to
-- friendly labels, humanize unknown codes neutrally, and MAKE NO SECURITY DECISION ON A LABEL.
--
-- The vocabulary as written by the shipped functions, recorded so clients can map it and so a
-- future writer can see what it is joining (see docs § 5.2 for the full table). Actions:
-- RETAILER_ONBOARDED, RETAILER_SHOP_ADDED, RETAILER_OWNER_INVITED,
-- RETAILER_OWNER_INVITATION_ACCEPTED, RETAILER_OWNER_INVITATION_REVOKED,
-- STAFF_INVITATION_RESERVED, STAFF_INVITATION_SENT, STAFF_INVITATION_RESENT,
-- STAFF_INVITATION_REVOKED, STAFF_INVITATION_DELIVERY_FAILED, STAFF_INVITATION_ACCEPTED,
-- PRODUCT_CREATED, PRODUCT_UPDATED, PRODUCT_ACTIVATED, PRODUCT_DEACTIVATED,
-- PRODUCT_ASSIGNED_TO_RETAILER, PRODUCT_UNASSIGNED_FROM_RETAILER. Entity types:
-- RETAILER_ORGANIZATION, RETAILER_SHOP, RETAILER_INVITATION, RETAILER_STAFF_INVITATION,
-- VENDOR_PRODUCT.
--
-- AN UNKNOWN CODE STAYS VISIBLE. A code this list does not contain — one a future migration
-- writes — is returned unchanged and its row is returned in full. It is never dropped, never
-- coerced to a known code, and never inferred from entity_type. A history that hid the events
-- its reader did not recognise would be worse than useless on exactly the day it mattered.
--
-- THERE IS NO OUTCOME OR RESULT COLUMN, AND NONE IS FABRICATED. public.audit_logs has no
-- success/failure column. Outcome is encoded in the ACTION ITSELF where it is recorded at all
-- — STAFF_INVITATION_DELIVERY_FAILED is the only failure event this schema writes — and every
-- other action denotes a completed change. Failed authorization attempts are NOT recorded
-- anywhere: an audit row is written inside the transaction that succeeded, so a refusal
-- produces no row. Synthesising a `result` column here would assert a fact the table does not
-- hold.
--
-- ----------------------------------------------------------------------------
-- ACTOR SEMANTICS — THREE HONEST STATES, AND WHY THE JOIN IS SCOPED
-- ----------------------------------------------------------------------------
-- actor_type is exactly one of 'USER', 'SYSTEM', 'UNKNOWN'. actor_display_name is non-null if
-- and only if actor_type = 'USER'.
--
--   'USER'    — actor_profile_id names a profile that holds a membership IN THIS SAME VENDOR
--               ORGANIZATION. actor_display_name is that profile's "first last" as it is NOW.
--   'SYSTEM'  — actor_profile_id IS NULL: no actor was recorded for this event.
--   'UNKNOWN' — actor_profile_id is present but does not resolve to a member of this Vendor.
--
-- THE MEMBERSHIP SCOPE ON THE JOIN IS A PRIVACY BOUNDARY, NOT AN OPTIMIZATION. This function
-- is SECURITY DEFINER, so an unscoped join to public.profiles would bypass the profiles RLS
-- policy entirely and could print the real name of a person in a DIFFERENT organization onto a
-- Vendor's audit screen. Requiring an organization_members row in the audit row's own
-- organization means the only names that can ever appear are the Vendor's own people — which
-- is both the right boundary and a slightly tighter one than the web's, whose profiles policy
-- also admits the caller's own row. No caller loses a name they can legitimately see, because
-- every actor on a Vendor-scoped row written by the shipped functions IS a member of that
-- Vendor.
--
-- MEMBERSHIP STATUS IS NOT REQUIRED TO BE ACTIVE. A suspended or deactivated member's past
-- actions still deserve attribution — they are precisely the history an operator reviews after
-- suspending someone — and demanding ACTIVE would turn a named actor into 'UNKNOWN' the moment
-- their access was revoked, silently rewriting history as a side effect of an unrelated
-- administrative act.
--
-- 'SYSTEM' IS THE TRUTHFUL READING OF NULL TODAY, WITH ONE DOCUMENTED CAVEAT. Null is
-- reachable now: retailer_invitations.invited_by_profile_id and
-- retailer_staff_invitations.invited_by_profile_id are both nullable, and audit rows copy them
-- straight through. Separately, actor_profile_id is ON DELETE SET NULL, so deleting a profile
-- WOULD also produce null — making a deleted actor indistinguishable from a system action at
-- the schema level. The audit found NO profile-deletion path anywhere in this repository (no
-- SQL delete, no admin.deleteUser call, nothing), so that branch is unreachable today; it is
-- recorded as a limitation in docs § 7.2 rather than papered over, because the correct fix is
-- an actor-name snapshot column on audit_logs, which is a schema change this read-only
-- milestone must not make.
--
-- A ROW IS NEVER DROPPED FOR LACK OF AN ACTOR. Both joins below are LEFT joins for exactly
-- this reason: an audit log that discards records whose context is incomplete is not an audit
-- log. A missing actor is reported as a state, never as an absence.
--
-- ----------------------------------------------------------------------------
-- ENTITY SEMANTICS — A HISTORICAL SNAPSHOT, NOT A LIVE LOOKUP
-- ----------------------------------------------------------------------------
-- entity_display_name is read from the NAME SNAPSHOT the writing function stored in metadata
-- at the moment of the event, through a CLOSED WHITELIST of one key per known entity type:
--
--     VENDOR_PRODUCT            -> metadata ->> 'product_name'
--     RETAILER_ORGANIZATION     -> metadata ->> 'retailer_name'
--     RETAILER_SHOP             -> metadata ->> 'shop_name'
--     RETAILER_INVITATION       -> metadata ->> 'retailer_name'
--     RETAILER_STAFF_INVITATION -> metadata ->> 'retailer_name'
--     anything else             -> null
--
-- THERE IS NO LIVE JOIN TO ANY ENTITY TABLE, AND THAT IS THE POINT. Four properties follow
-- from reading the snapshot instead:
--   a. A DELETED ENTITY STILL HAS A NAME. "Product X was deactivated" survives the product's
--      deletion, which is the entire purpose of an audit trail. A live join would degrade the
--      record precisely when it became evidence.
--   b. A RENAMED ENTITY KEEPS ITS HISTORICAL NAME. The row says what the thing was called when
--      the action happened, not what it is called today.
--   c. NO EXISTENCE ORACLE. A live join by (entity_type, entity_id) would answer "does this id
--      still exist" for any id, across tenants. Reading a snapshot cannot leak that.
--   d. NO N+1, AND NO PER-ROW TENANT CHECK. The name travels with the row already.
--
-- TWO GUARDS MAKE THE EXTRACTION SAFE AGAINST A FUTURE WRITER. metadata is `jsonb` with only a
-- `jsonb_typeof(metadata) = 'object'` CHECK — its CONTENTS are unconstrained — so this
-- function trusts the key names it whitelists and nothing else:
--   * jsonb_typeof(...) = 'string' — if a key ever held an object or array, `->>` would return
--     that value's raw JSON TEXT, which is exactly the raw-metadata leak this contract
--     forbids. A non-string value yields null instead.
--   * nullif(btrim(...), '') — a blank snapshot reads as unavailable rather than as an empty
--     name, so a client's null check is the only check it needs.
--
-- entity_display_name IS NULLABLE and a client must treat null as "target not named" — never
-- as an error, and never as a reason to hide the row. It is null for an unknown entity type,
-- for a missing or blank key, and for a non-string value.
--
-- entity_id IS DELIBERATELY NOT RETURNED. It is an opaque text id whose meaning depends on
-- entity_type, and for RETAILER_INVITATION / RETAILER_STAFF_INVITATION rows it identifies an
-- INVITATION — a row that also carries an email and a token hash. This milestone adds no
-- entity navigation (there is no shipped web navigation from an audit row to mirror), so the
-- id would be an unused identifier of a sensitive row travelling to a phone. entity_type plus
-- the name snapshot answers "what was affected" without it. Cross-linking, if it is ever
-- wanted, is additive: VENDOR_PRODUCT and RETAILER_ORGANIZATION ids would map cleanly onto the
-- already-shipped product and Retailer detail reads, and the invitation types would stay
-- unlinked. See docs § 7.3.
--
-- ----------------------------------------------------------------------------
-- NOT RETURNED, and the reason each is withheld
-- ----------------------------------------------------------------------------
--   metadata (as a whole)        unrestricted jsonb. Only the five whitelisted NAME keys above
--                                are read, and only when they hold a string. The raw object is
--                                never returned, never partially returned, and never returned
--                                for an unrecognised entity type.
--   ip_address                   personal data about the actor's network. Never written by any
--   user_agent                   shipped function (every insert omits both columns, so they are
--                                null in every existing row) and never read here regardless —
--                                a column that is not selected cannot leak from a future
--                                refactor, a log line, or a payload.
--   entity_id                    see above.
--   actor_profile_id             public.profiles.id IS THE AUTH USER ID (1:1 FK to
--                                auth.users), so returning it would return an auth identifier
--                                under a friendlier name. The actor travels as a name and a
--                                type, never as an id.
--   organization_id              the caller already knows which Vendor they are; an id in a
--                                payload is one a form could echo back as authorization.
--   membership id, role id,      authorization internals are not display data.
--     permission codes
--   actor email, mobile number   the web Audit Logs page shows neither, and auth.users is
--                                never queried by anything in this schema. Nothing in this
--                                product requires an actor's email on an audit line, so no
--                                privacy justification exists to weigh.
--   invitation token, token      never returned by anything, anywhere.
--     hash, invitation email
--   old/new value JSON           no such column exists on public.audit_logs. Nothing is
--                                fabricated to fill the gap.
--   request id, correlation id   no such column exists either. A synthetic one would be an
--                                identifier a client could not correlate with anything.
--   storage paths, signed URLs,  no audit row references storage, and none is joined to.
--     receipt references
--   total row count              an exact COUNT over an append-only table that grows forever
--                                costs a full scan per page and is stale the moment it is
--                                computed. Keyset paging needs no total: the end of the
--                                history is a short or empty page.
create function public.list_vendor_audit_logs(
  p_limit               integer     default 50,
  p_before_occurred_at  timestamptz default null,
  p_before_audit_log_id uuid        default null
)
returns table (
  audit_log_id        uuid,
  occurred_at         timestamptz,
  action_code         text,
  entity_type         text,
  entity_display_name text,
  actor_type          text,
  actor_display_name  text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
  v_limit  integer;
begin
  -- Identity and Vendor, from auth.uid() alone, ONCE per call — never per row.
  -- get_vendor_super_admin_context() accepts no arguments and evaluates the whole chain.
  -- ORDER BY / LIMIT 1 reproduces the shipped multi-Vendor rule; see the header.
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  -- Fail closed, and generically. Evaluated before any parameter is inspected, so an
  -- unauthorized caller cannot learn the limit bounds or the cursor rules by probing.
  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'AUDIT_LOGS_READ') then
    raise exception 'Not authorized to view audit logs'
      using errcode = 'insufficient_privilege';
  end if;

  -- Page size: default, then a hard range. See the header for why this raises.
  v_limit := coalesce(p_limit, 50);

  if v_limit < 1 or v_limit > 100 then
    raise exception 'Audit log page size must be between 1 and 100'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The cursor is one value in two columns. Half of it is a client bug, not a default.
  if (p_before_occurred_at is null) <> (p_before_audit_log_id is null) then
    raise exception 'Audit log cursor requires both a timestamp and an id'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ONE statement. One index range scan, two LEFT joins that each contribute at most one row,
  -- no aggregate, no DISTINCT, no per-row authorization and no correlated lookup into any
  -- entity table.
  --
  -- INDEX USE, AND WHY THE RANGE BOUND IS WRITTEN SEPARATELY. audit_logs_org_created_idx
  -- (organization_id, created_at desc) serves this query exactly: equality on the leading
  -- column, a range on the second, and the DESC ordering already materialised. The
  -- `created_at <= coalesce(cursor, 'infinity')` line exists so that bound is UNCONDITIONAL
  -- and therefore usable as an index qual — written as `cursor is null or created_at <=
  -- cursor` the planner could not use it at all, and every page would walk the whole
  -- organization's history from the newest row. 'infinity' is a real timestamptz value that no
  -- stored created_at can equal (the column defaults to now()), so the no-cursor case is a
  -- no-op bound rather than a special case. The row comparison on the next line then does the
  -- tie-breaking, over the already-narrowed rows.
  --
  -- Within a group of rows sharing one created_at the index cannot order by id, so PostgreSQL
  -- finishes the sort — an incremental sort bounded by the size of one timestamp group, which
  -- is the number of audit rows a single transaction wrote. No index is added for it; see the
  -- closing note.
  return query
  select
    a.id,
    a.created_at,
    a.action,
    a.entity_type,
    -- The snapshot, whitelisted by key and guarded by type. See the header.
    case
      when jsonb_typeof(a.metadata -> snap.key) = 'string'
        then nullif(btrim(a.metadata ->> snap.key), '')
    end,
    case
      when a.actor_profile_id is null then 'SYSTEM'
      when actor.first_name is null   then 'UNKNOWN'
      else                                 'USER'
    end,
    -- Non-null if and only if the branch above yielded 'USER'. public.profiles constrains
    -- both name columns NOT NULL and non-empty after trimming, so a resolved actor always has
    -- a printable name and the concatenation cannot produce null or a bare separator.
    case
      when actor.first_name is null then null
      else actor.first_name || ' ' || actor.last_name
    end
  from public.audit_logs a
  -- The whitelist itself, as data rather than as five repeated expressions. CROSS JOIN
  -- LATERAL over a single-row SELECT always yields exactly one row, so it cannot change the
  -- row count; an entity type not listed leaves key null, and `metadata -> null` is null, so
  -- the guard above falls through to a null name.
  cross join lateral (
    select case a.entity_type
             when 'VENDOR_PRODUCT'            then 'product_name'
             when 'RETAILER_ORGANIZATION'     then 'retailer_name'
             when 'RETAILER_SHOP'             then 'shop_name'
             when 'RETAILER_INVITATION'       then 'retailer_name'
             when 'RETAILER_STAFF_INVITATION' then 'retailer_name'
           end as key
  ) snap
  -- The actor, scoped to THIS Vendor's members. LEFT, so a row with no actor, a foreign actor
  -- or an unresolvable actor survives with a null name rather than vanishing.
  -- organization_members is UNIQUE on (organization_id, user_id) and profiles is keyed by id,
  -- so this lateral returns at most one row and cannot duplicate an audit row. A null
  -- actor_profile_id matches nothing (null = anything is null), so the SYSTEM branch costs no
  -- lookup.
  left join lateral (
    select p.first_name, p.last_name
    from public.organization_members m
    join public.profiles p on p.id = m.user_id
    where m.user_id = a.actor_profile_id
      and m.organization_id = v_vendor
  ) actor on true
  -- The tenant boundary. Compared against the Vendor derived above — never against a
  -- parameter. A null organization_id never equals it, so orphaned rows stay invisible.
  where a.organization_id = v_vendor
    and a.created_at <= coalesce(p_before_occurred_at, 'infinity'::timestamptz)
    and (
      p_before_occurred_at is null
      or (a.created_at, a.id) < (p_before_occurred_at, p_before_audit_log_id)
    )
  order by a.created_at desc, a.id desc
  limit v_limit;
end;
$$;

revoke all     on function public.list_vendor_audit_logs(integer, timestamptz, uuid) from public;
revoke execute on function public.list_vendor_audit_logs(integer, timestamptz, uuid) from anon;
grant  execute on function public.list_vendor_audit_logs(integer, timestamptz, uuid) to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- One read function. Nothing else exists in this migration. No table, column, constraint,
-- index, trigger, RLS policy, role, permission or mapping is created or altered; no existing
-- function is touched; no seed row is written; no audit row is written or modified; no audit
-- trigger exists to change and none is added; retention is untouched (there was never any
-- pruning to change); and no table privilege is granted to any browser role —
-- public.audit_logs, public.profiles and public.organization_members in particular keep
-- exactly the SELECT-only, RLS-governed posture 20260716131930 left them in.
--
-- NO INDEX IS ADDED, and that is a MEASURED conclusion rather than an omission. The final
-- query needs equality on organization_id, a descending range on created_at, and DESC output
-- order. audit_logs_org_created_idx (organization_id, created_at desc), created by
-- 20260716130351, provides all three.
--
-- Measured on a local reset with 200,000 audit rows spread over 40 Vendor organizations —
-- EXPLAIN (ANALYZE) of both the null-cursor page and a cursor 90,000 rows deep:
--
--     Limit
--       -> Incremental Sort   (Sort Key: created_at DESC, id DESC; Presorted Key: created_at)
--            -> Index Scan using audit_logs_org_created_idx
--                 Index Cond: (organization_id = $1 AND created_at <= $2)
--
--   * Both predicates are INDEX CONDITIONS, not filters: `Rows Removed by Filter: 0`.
--   * 51 rows were read to return 50, at BOTH depths. Page cost is proportional to the PAGE,
--     not to how far into the history the cursor sits — which is the entire difference from
--     OFFSET, whose deep page would have walked 90,000 rows.
--   * The Incremental Sort is the id tie-break, and it is presorted on created_at, so it sorts
--     one timestamp group at a time rather than the result set. Peak memory 27 kB.
--
-- The only work the index cannot do is order by id WITHIN one created_at value, and that group
-- is as large as the number of audit rows one transaction wrote — one, for every shipped
-- writer. A covering (organization_id, created_at desc, id desc) index would remove a sort of
-- a one-element group, at the cost of a second index to maintain on every audit insert: a
-- permanent write cost on every administrative action, and additional storage on the largest
-- append-only table in the schema, for no measured read benefit. A speculative index would be
-- a write cost with no measured cause.
--
-- (At very LOW Vendor cardinality the planner may instead pick audit_logs_created_idx and
-- filter organization_id afterwards — measured at 2 organizations, also 51 rows read. Both
-- plans are bounded by the limit; the org-leading index is the one that keeps that true as the
-- number of Vendors grows, which is why it is the one this contract relies on.)
--
-- The actor lateral uses organization_members_unique_membership (organization_id, user_id) and
-- the profiles primary key; the entity snapshot uses no index because it reads a column already
-- on the row.
--
-- service_role is granted nothing here. This read derives its authority from auth.uid(), which
-- a service-role connection does not have, so granting it would produce a function that can
-- only ever refuse.
--
-- Nothing in this migration writes: there is no insert, update or delete anywhere in the
-- function, and it is declared STABLE, so it cannot create, edit, delete or clear an audit
-- record, and cannot be used to change anything else either.
