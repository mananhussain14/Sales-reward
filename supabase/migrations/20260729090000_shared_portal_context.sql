-- Migration: shared_portal_context
-- Purpose: ONE trusted, read-only operation that resolves the authenticated
--          caller into the application experience they are entitled to, so that
--          neither the Next.js application nor the future Flutter application
--          has to infer authorization from which RPC happened to raise 42501.
--
--          Today the answer is assembled by PROBING: the web calls
--          get_retailer_owner_portal_context(), then list_retailer_staff_members(),
--          then list_my_assigned_receipt_shops(), and reads the ROLE OFF THE ERROR
--          CODE of whichever one refused it (see lib/staff/retailer-staff-access.ts
--          and lib/staff/portal-access-decision.ts). That works, but it is
--          authorization decided by error handling: it costs up to four round trips
--          on every cold start, and two independent clients reproducing the same
--          probe order will drift apart the first time either is edited. This
--          function makes the decision once, in the database, and hands both
--          clients the same answer.
--
--          This is item #1 on the "new Postgres RPCs" list in
--          docs/mobile-feature-matrix.md § 8 (high priority, phase 1), and the
--          resolution it implements is the one already specified in
--          docs/mobile-role-flow-map.md § 2.3.
--
-- WHAT THIS MIGRATION DOES NOT DO. It adds exactly one function. No table,
--   column, constraint, index, trigger, RLS policy, role, permission,
--   role-permission mapping, grant on any table, or existing function is
--   created, altered, or dropped. Every resolver, helper, and RPC named below is
--   consumed exactly as it already exists. Nothing about who may do what changes:
--   this function reports an authorization decision, it does not make a new one.
--
-- Dependencies (all consumed, none modified):
--   20260716124419  profiles, organizations, organization_members
--   20260716125559  roles, permissions, role_permissions, member_roles
--   20260717083515  get_vendor_super_admin_context()
--   20260720215500  resolve_retailer_owner_organization(text)
--   20260723090000  resolve_retailer_member_organization(text)
--   20260722210000  RETAILER_OWNER / RETAILER_MANAGER / SALES_STAFF + their permissions
--   20260726090000  RECEIPT_SUBMIT -> SALES_STAFF
--   20260727090000  RETAILER_PRODUCTS_READ -> RETAILER_OWNER, RETAILER_MANAGER


-- ============================================================================
-- WHY THE RETURN TYPE IS jsonb AND NOT `returns table (...)`
-- ============================================================================
-- Every other read RPC in this schema returns a typed row set, and that is right
-- for a result whose columns are settled. This one is different in a way that has
-- already bitten this project once.
--
-- A `returns table (...)` function cannot gain a column. PostgreSQL requires
-- DROP FUNCTION + CREATE FUNCTION to change a return type, and a DROP is a
-- breaking change for every client pinned to the old shape. The audit records the
-- consequence: get_vendor_retailer_owner_status has been "dropped and recreated
-- three times with a growing column list" (docs/mobile-feature-matrix.md § 6),
-- which is survivable while the only client ships from the same repository as the
-- migration, and is not survivable once a RELEASED mobile binary is calling it.
-- An installed app cannot be redeployed in step with a migration.
--
-- This function is explicitly specified as a cross-client contract, so it is
-- built for additive evolution from the start: a single jsonb value. A new key
-- can be added without touching the signature, without a DROP, and without
-- breaking a client that does not know the key exists. Clients read the keys they
-- understand and ignore the rest, which is the ordinary JSON contract discipline.
--
-- The cost is that the shape is documented here rather than declared in the
-- catalogue, so this comment IS the schema. It is exhaustive, and the test suite
-- (lib/portal/portal-context-contract.test.ts) asserts the parts of it that a
-- careless edit could silently break.
--
-- ============================================================================
-- THE CONTRACT
-- ============================================================================
-- public.get_my_portal_context() -> jsonb
--
-- Zero arguments. Exactly one jsonb value, NEVER SQL NULL, never zero rows.
--
-- {
--   "context_version": 1,
--
--   "portal_kind": "VENDOR_SUPER_ADMIN" | "RETAILER_OWNER" | "RETAILER_MANAGER"
--                  | "SALES_STAFF" | "NONE",
--
--   "vendor": null | {
--     "organization_id":   uuid,
--     "organization_name": text
--   },
--
--   "retailer": null | {
--     "kind":              "RETAILER_OWNER" | "RETAILER_MANAGER" | "SALES_STAFF",
--     "organization_id":   uuid,
--     "organization_name": text,
--     "capabilities": {
--       "view_retailer_overview": boolean,
--       "view_shops":             boolean,
--       "view_staff":             boolean,
--       "manage_staff":           boolean,
--       "assign_staff_shops":     boolean,
--       "view_assigned_products": boolean,
--       "submit_receipts":        boolean
--     }
--   }
-- }
--
-- context_version
--   Increments ONLY on a breaking change — a key removed, renamed, or given a new
--   meaning. ADDING a key does not increment it, because adding a key breaks
--   nobody. A client should treat an unrecognised (higher) version as "this
--   backend is newer than me" and fall back conservatively rather than guessing.
--
-- portal_kind
--   The ROUTING decision: which experience the application should open. It applies
--   VENDOR-FIRST PRECEDENCE, reproducing public.selectLanding() in
--   lib/auth/landing-decision.ts exactly:
--
--     vendor context present            -> "VENDOR_SUPER_ADMIN"
--     else retailer kind present        -> that kind
--     else                              -> "NONE"
--
--   The literals are the role codes from public.roles.code, so they are already
--   stable, already machine-readable, and already the vocabulary the rest of the
--   schema uses. "NONE" is not a role code; it is the explicit absence of one, and
--   it is deliberately the SAME answer for every unauthorized case (see the
--   generic-denial note below).
--
-- vendor / retailer — BOTH ARE RESOLVED INDEPENDENTLY, and this is deliberate.
--   portal_kind collapses them into one routing answer, but the two blocks are
--   computed separately and BOTH are populated for a caller who genuinely holds
--   both. That is not a hypothetical: lib/auth/landing-decision.ts documents that
--   "a user who legitimately holds both roles keeps their established Vendor
--   landing and does not silently get moved to /retailer; the portal stays
--   reachable directly at /retailer."
--
--   If this function returned only the winning block, such a caller could never
--   learn their Retailer experience from it, and the Retailer portal shell would
--   be forced straight back to probing — which is the entire problem this function
--   exists to remove. So: portal_kind answers "where do I open?", and the two
--   blocks answer "what am I, in each organization?". A shell that is already
--   inside the Retailer portal reads `retailer`, ignores precedence, and matches
--   today's getRetailerPortalAccess() behaviour, which likewise applies no Vendor
--   precedence.
--
-- retailer.capabilities — PRESENTATION HINTS. NOT AUTHORIZATION.
--   See the long note above the capability block below. Every one of these is
--   computed by calling the SAME resolver, with the SAME permission code, that the
--   operation it describes calls — so a hint cannot drift from its gate. It is
--   still only a hint: the database decides again, in SQL, on every single call.
--
-- ============================================================================
-- WHY THE CAPABILITIES ARE RESOLVER-DERIVED AND NOT PERMISSION-DERIVED
-- ============================================================================
-- This is the one genuinely non-obvious thing in this migration, and getting it
-- wrong would ship a lie to both clients.
--
-- The obvious implementation of "can this caller see the Shops screen?" is
-- has_organization_permission(org, 'RETAILER_SHOPS_READ'). It is WRONG.
-- RETAILER_SHOPS_READ is mapped to RETAILER_MANAGER (20260722210000), so that test
-- returns TRUE for a Manager — but the screen is served by
-- list_retailer_owner_portal_shops(), which resolves through
-- resolve_retailer_owner_organization('RETAILER_SHOPS_READ'), and THAT resolver
-- hard-filters r.code = 'RETAILER_OWNER'. A Manager holds the permission and is
-- still refused the operation. A permission-derived hint would tell both clients
-- to render a screen the database will empty-handedly refuse.
--
-- The same trap applies to RETAILER_PORTAL_READ, which SALES_STAFF also holds
-- (20260722210000, "so the portal shell renders") while being refused the Overview
-- screen for exactly the same reason.
--
-- So each capability below calls the resolver its operation actually calls:
--
--   capability               operation                                  resolver / permission
--   ----------------------------------------------------------------------------------------
--   view_retailer_overview   get_retailer_owner_portal_context()        owner  / RETAILER_PORTAL_READ
--   view_shops               list_retailer_owner_portal_shops()         owner  / RETAILER_SHOPS_READ
--   view_staff               list_retailer_staff_members()              member / RETAILER_STAFF_READ
--   manage_staff             list_retailer_staff_invitations()          member / RETAILER_STAFF_MANAGE
--   assign_staff_shops       list_retailer_staff_assignable_shops()     member / RETAILER_STAFF_SHOP_ASSIGN
--   view_assigned_products   list_retailer_assigned_products()          member / RETAILER_PRODUCTS_READ
--   submit_receipts          list_my_assigned_receipt_shops()           member / RECEIPT_SUBMIT
--
-- Because the hint and the gate are the same call, a future mapping change moves
-- both together and this migration does not need editing. That is the same reason
-- lib/staff/retailer-staff-access.ts probes with the real read rather than a
-- bespoke "am I staff?" call: "using the real operation as the gate means the page
-- can never render for someone the operation would refuse. There is no second
-- definition to drift."
--
-- NO VENDOR CAPABILITIES ARE RETURNED. The Vendor navigation is static — every
-- item in components/admin/nav-items.tsx is unconditional — so no shell gates on a
-- Vendor permission today, and returning the Vendor permission set would be
-- disclosure with no consumer. jsonb makes adding them later a non-breaking change
-- if a Vendor screen ever needs one, which is precisely why the return type is
-- jsonb.
--
-- ============================================================================
-- SECURITY POSTURE
-- ============================================================================
-- * ZERO ARGUMENTS. There is no user id, organization id, retailer id, membership
--   id, role id, role code, permission code, email, or token parameter. A caller
--   cannot nominate whose authorization is evaluated, cannot name a tenant, and
--   cannot widen the answer. Identity comes from auth.uid() and from nothing else.
--
-- * AUTHORIZATION IS DELEGATED, NEVER REIMPLEMENTED. This function contains no
--   join over public.profiles, public.organization_members, public.member_roles,
--   public.role_permissions, or public.permissions. Every authorization decision
--   is made by an existing, already-reviewed resolver:
--     public.get_vendor_super_admin_context()
--     public.resolve_retailer_owner_organization(text)
--     public.resolve_retailer_member_organization(text)
--   It therefore INHERITS, and cannot contradict, every rule those resolvers
--   enforce: ACTIVE profile, ACTIVE membership, ACTIVE organization, ACTIVE role,
--   the organization_type filter, the role-code filter on the owner path, the
--   role->permission mapping, and the multi-organization ambiguity rule. This is
--   the same delegation discipline as has_vendor_retailer_permission (20260717100208):
--   "Reassembling any of that chain here would let the policies drift apart, and
--   only one of the two would be right."
--
--   The single table this function reads on its own account is public.organizations,
--   and only ever by an id a resolver has ALREADY authorized, purely to fetch the
--   display name. It performs no authorization with that read.
--
-- * AMBIGUOUS MULTI-ORGANIZATION MEMBERSHIP FAILS CLOSED, inherited. Both retailer
--   resolvers return NULL when the caller qualifies in more than one Retailer
--   (20260720215500's "MVP AMBIGUITY RULE"). A caller who owns two Retailers
--   therefore resolves owner -> NULL, then manager -> NULL, then submitter -> NULL,
--   and receives portal_kind "NONE". That is exactly what the web produces today:
--   all three probes raise, selectPortalAccess returns "unauthorized", and the user
--   reaches /access-denied. This function does not soften that, and must not — the
--   ambiguity rule is a deliberate MVP constraint with a documented reason (there
--   is no organization switcher in which a person could see or change which
--   Retailer was chosen), and quietly picking one here would defeat it in both
--   clients at once.
--
-- * TENANT ISOLATION IS STRUCTURAL. Every returned organization id comes from a
--   resolver that chained it off the caller's OWN membership row. There is no code
--   path that reads an organization the caller is not an ACTIVE member of, and no
--   parameter through which one could be named.
--
-- * GENERIC DENIAL / NOT AN ORACLE. Every unauthorized case produces the identical
--   value: portal_kind "NONE", vendor null, retailer null. Signed out, no profile
--   row, INVITED profile, SUSPENDED profile, DEACTIVATED profile, INVITED
--   membership, SUSPENDED membership, DEACTIVATED membership, suspended or
--   deactivated organization, a role that is INACTIVE, a membership with no role at
--   all, a role holding none of the relevant permissions, a Vendor-shaped account
--   with no Retailer role, and the ambiguous multi-Retailer case are ALL "NONE".
--   The function never says why, never says whether an account, organization, or
--   role exists, and never distinguishes "you are not allowed" from "there is
--   nothing there". It cannot be used to probe another user, because it has no
--   parameter naming one.
--
-- * OPERATIONAL FAILURE IS NOT DENIAL. This function raises no exception of its
--   own. It has no RAISE, and no branch that turns a missing row into an error —
--   an unauthorized caller gets a value, not a failure. A genuine operational
--   failure (the database is unreachable, a resolver errors) therefore surfaces to
--   the client as a transport or SQL error and is DISTINGUISHABLE from "NONE":
--
--     exception raised  -> "unavailable"  (operational; keep the session, retry)
--     portal_kind NONE  -> "unauthorized" (a decision; send to access-denied)
--
--   That distinction already exists on the web (RetailerAccessStatus carries
--   "unavailable" separately from "unauthorized", and LandingDecision's
--   "unavailable" deliberately carries NO destination because "an operational
--   failure is not a place to send someone"). Preserving it is why this function
--   must not convert an error into a NONE, or a NONE into an error.
--
-- * SECURITY DEFINER IS LOAD-BEARING, NOT HABITUAL. public.organizations is
--   RLS-enabled, and the two resolve_* resolvers are granted to NOBODY — they are
--   internal building blocks reachable only from a definer function running as
--   their owner. Under invoker rights this function could call neither, and would
--   answer "NONE" for everyone, always. Definer rights are what let it consult the
--   resolvers; they grant the caller nothing, because every decision those
--   resolvers make is still made against the ORIGINAL caller's identity —
--   auth.uid() reads the request JWT claims from a GUC rather than current_user,
--   which is the same reason the migration-4 helpers work inside RLS policies.
--
-- * set search_path = '' with every reference fully schema-qualified, so nothing
--   resolves from an attacker-controlled schema. STABLE, no dynamic SQL, no writes.
--
-- * NO AUDIT ROW. This function reads, and resolving one's own session is not a
--   sensitive administrative action. The existing model audits state CHANGES
--   (RETAILER_ONBOARDED, PRODUCT_CREATED, RETAILER_OWNER_INVITED, …) and audits no
--   read anywhere — get_vendor_super_admin_context, the portal context, and every
--   list_* RPC write nothing. Logging a row on every application boot for every
--   user would add a high-volume, low-value write path to a table the Vendor reads,
--   and would make a STABLE function volatile. Consistency with the installed model
--   means: no audit here.
--
-- ============================================================================


create function public.get_my_portal_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- Vendor branch.
  v_vendor_organization_id   uuid;
  v_vendor_organization_name text;

  -- Retailer branch. Exactly one of these three resolvers may win; the first
  -- non-null, in precedence order, decides the kind.
  v_retailer_organization_id   uuid;
  v_retailer_organization_name text;
  v_retailer_kind              text;

  -- One variable per gate, each holding the organization id that gate resolved
  -- to, or NULL. These are BOTH the precedence inputs and the capability values —
  -- resolved once, read twice — so a capability can never disagree with the
  -- precedence decision that was taken from the same call.
  v_owner_portal_org  uuid;
  v_owner_shops_org   uuid;
  v_staff_read_org    uuid;
  v_staff_manage_org  uuid;
  v_shop_assign_org   uuid;
  v_products_read_org uuid;
  v_receipt_org       uuid;

  v_portal_kind text;
  v_vendor      jsonb := null;
  v_retailer    jsonb := null;
begin
  -- ------------------------------------------------------------------------
  -- Step 0 — signed out.
  --
  -- Defence in depth only. This function is granted to `authenticated` and to
  -- nothing else, so a caller with no JWT is the `anon` role and is refused
  -- EXECUTE by Postgres before a single line here runs. The guard exists because
  -- every authorization helper in this schema carries the same explicit
  -- `auth.uid() is not null` test rather than relying on null-comparison
  -- semantics alone (20260716131104), and because returning the ordinary
  -- unauthorized value here keeps "signed out" indistinguishable from every other
  -- denial should this ever be reachable another way.
  -- ------------------------------------------------------------------------
  if auth.uid() is null then
    -- The nulls are cast explicitly. jsonb_build_object() is VARIADIC "any", and an
    -- untyped NULL literal in that position relies on unknown-type resolution;
    -- `null::jsonb` states the intent and produces a JSON null unambiguously. It
    -- also makes this value byte-identical to the one the main return produces
    -- when v_vendor and v_retailer are both NULL, which is what keeps every
    -- denial indistinguishable.
    return jsonb_build_object(
      'context_version', 1,
      'portal_kind',     'NONE',
      'vendor',          null::jsonb,
      'retailer',        null::jsonb
    );
  end if;

  -- ------------------------------------------------------------------------
  -- Step 1 — the Vendor context.
  --
  -- get_vendor_super_admin_context() returns one row per ACTIVE VENDOR
  -- organization in which the caller holds the ACTIVE VENDOR_SUPER_ADMIN role,
  -- already ordered by organization id so "the first row" is a stable choice
  -- rather than whatever the planner emitted. `order by ... limit 1` here is not
  -- a second opinion about that ordering — it restates it explicitly so this
  -- function does not depend on an ORDER BY inside another function's body, which
  -- is an implementation detail rather than part of its contract.
  --
  -- NOTE THE ASYMMETRY WITH THE RETAILER PATH, WHICH IS DELIBERATE AND PRESERVED:
  -- the Vendor resolver does NOT fail closed on multiple qualifying organizations
  -- — it picks the lowest organization id — whereas both Retailer resolvers return
  -- NULL. That difference is not introduced here; it is exactly what
  -- lib/auth/vendor-admin-access.ts does today when it reads contextRows[0].
  -- Making the Vendor path fail closed would be a behaviour change to the shipped
  -- web application, smuggled in under a mobile-enablement migration. It is called
  -- out as an open question in the accompanying documentation instead.
  --
  -- The `user_id = auth.uid()` filter is redundant — the function already
  -- hard-filters on auth.uid() internally — and mirrors the equivalent
  -- defence-in-depth re-assertion the web client performs on the same row
  -- ("Re-assert row.user_id == session.user.id, as the web client does",
  -- docs/mobile-feature-matrix.md § 1).
  -- ------------------------------------------------------------------------
  select ctx.organization_id, ctx.organization_name
    into v_vendor_organization_id, v_vendor_organization_name
  from public.get_vendor_super_admin_context() as ctx
  where ctx.user_id = auth.uid()
  order by ctx.organization_id
  limit 1;

  if v_vendor_organization_id is not null then
    v_vendor := jsonb_build_object(
      'organization_id',   v_vendor_organization_id,
      'organization_name', v_vendor_organization_name
    );
  end if;

  -- ------------------------------------------------------------------------
  -- Step 2 — the Retailer experience, in precedence order.
  --
  -- This reproduces public.selectPortalAccess() from
  -- lib/staff/portal-access-decision.ts condition for condition: owner, then the
  -- roster reader, then the receipt submitter. Each step calls the SAME resolver
  -- with the SAME permission code as the RPC the web probes with, so the answer
  -- here and the answer the real operation gives cannot disagree:
  --
  --   owner      resolve_retailer_owner_organization('RETAILER_PORTAL_READ')
  --                = the resolver behind get_retailer_owner_portal_context()
  --   reader     resolve_retailer_member_organization('RETAILER_STAFF_READ')
  --                = the resolver behind list_retailer_staff_members()
  --   submitter  resolve_retailer_member_organization('RECEIPT_SUBMIT')
  --                = the resolver behind list_my_assigned_receipt_shops()
  --
  -- The order matters and is not arbitrary. A RETAILER_OWNER also holds
  -- RETAILER_STAFF_READ, so the owner test MUST come first or every owner would be
  -- reported as a manager. RECEIPT_SUBMIT is mapped to SALES_STAFF alone, which is
  -- why an owner or a manager can never fall through to the submitter branch.
  --
  -- No role code is compared anywhere in this function. Which permission maps to
  -- which role is a decision that lives in SQL seed data, and a future mapping
  -- change moves the experience without this migration being edited — the same
  -- property lib/staff/retailer-staff-access.ts relies on ("no role name appears
  -- here — a mapping change in SQL changes who gets which experience without this
  -- file being edited").
  -- ------------------------------------------------------------------------
  -- All seven gates are resolved unconditionally, exactly once each, BEFORE any
  -- precedence is applied. Resolving them up front rather than lazily inside the
  -- precedence branches is deliberate: a lazy version would have to reason about
  -- which probes an earlier branch had already short-circuited past, and that
  -- reasoning is precisely where a later edit would introduce a capability that
  -- silently reports false because nobody ever asked. Seven small indexed joins,
  -- once per application boot, is the right price for a function whose whole
  -- purpose is to be the answer both clients trust.
  v_owner_portal_org :=
    public.resolve_retailer_owner_organization('RETAILER_PORTAL_READ');
  v_owner_shops_org :=
    public.resolve_retailer_owner_organization('RETAILER_SHOPS_READ');
  v_staff_read_org :=
    public.resolve_retailer_member_organization('RETAILER_STAFF_READ');
  v_staff_manage_org :=
    public.resolve_retailer_member_organization('RETAILER_STAFF_MANAGE');
  v_shop_assign_org :=
    public.resolve_retailer_member_organization('RETAILER_STAFF_SHOP_ASSIGN');
  v_products_read_org :=
    public.resolve_retailer_member_organization('RETAILER_PRODUCTS_READ');
  v_receipt_org :=
    public.resolve_retailer_member_organization('RECEIPT_SUBMIT');

  if v_owner_portal_org is not null then
    v_retailer_kind            := 'RETAILER_OWNER';
    v_retailer_organization_id := v_owner_portal_org;
  elsif v_staff_read_org is not null then
    v_retailer_kind            := 'RETAILER_MANAGER';
    v_retailer_organization_id := v_staff_read_org;
  elsif v_receipt_org is not null then
    v_retailer_kind            := 'SALES_STAFF';
    v_retailer_organization_id := v_receipt_org;
  end if;

  -- ------------------------------------------------------------------------
  -- Step 3 — the Retailer block: display name plus the capability hints.
  --
  -- Only built when a Retailer experience was resolved. Each capability is simply
  -- `<gate> is not null` over the values resolved in Step 2 — a resolver yields
  -- the organization id when the caller qualifies unambiguously, and NULL
  -- otherwise — so a hint is literally the same fact the operation it describes
  -- will re-derive when called.
  --
  -- THE ORGANIZATION NAME IS READ FOR ALL THREE KINDS, INCLUDING A MANAGER AND A
  -- SALES STAFF MEMBER. This is a deliberate, documented widening relative to the
  -- installed schema, and it closes a gap the audit already recorded: "a Manager
  -- currently has no way to read their own Retailer's name" (Q3 /
  -- docs/mobile-role-flow-map.md D-6), because get_retailer_owner_portal_context()
  -- hard-filters RETAILER_OWNER. It is safe: the id was produced by a resolver
  -- that already proved this caller is an ACTIVE member of an ACTIVE Retailer
  -- organization through an ACTIVE role, so the name being returned is the name of
  -- the tenant the caller demonstrably belongs to. No caller learns the name of an
  -- organization they are not a member of, and the id cannot be supplied from
  -- outside. What is widened is what a member may read about their OWN tenant,
  -- never whose tenant may be read.
  --
  -- Note for the web: adopting this in the Retailer shell WOULD change what a
  -- Manager sees (their header currently omits the name, deliberately, because no
  -- installed RPC could supply it). That is a user-visible change and is therefore
  -- NOT made in this migration's pull request — see the integration assessment in
  -- the PR description.
  -- ------------------------------------------------------------------------
  if v_retailer_kind is not null then
    -- Display name only. The row is addressed by an id a resolver already
    -- authorized, so this SELECT performs no access decision of its own; it cannot
    -- return a row for an organization the caller does not belong to, because no
    -- such id can reach this line.
    select o.name
      into v_retailer_organization_name
    from public.organizations o
    where o.id = v_retailer_organization_id;

    v_retailer := jsonb_build_object(
      'kind',              v_retailer_kind,
      'organization_id',   v_retailer_organization_id,
      'organization_name', v_retailer_organization_name,
      'capabilities', jsonb_build_object(
        'view_retailer_overview', v_owner_portal_org  is not null,
        'view_shops',             v_owner_shops_org   is not null,
        'view_staff',             v_staff_read_org    is not null,
        'manage_staff',           v_staff_manage_org  is not null,
        'assign_staff_shops',     v_shop_assign_org   is not null,
        'view_assigned_products', v_products_read_org is not null,
        'submit_receipts',        v_receipt_org       is not null
      )
    );
  end if;

  -- ------------------------------------------------------------------------
  -- Step 4 — the routing decision.
  --
  -- Vendor-first, matching selectLanding() exactly. A caller who holds both keeps
  -- the Vendor landing, and their Retailer block is still returned above so the
  -- portal remains reachable without a second resolution.
  -- ------------------------------------------------------------------------
  if v_vendor_organization_id is not null then
    v_portal_kind := 'VENDOR_SUPER_ADMIN';
  elsif v_retailer_kind is not null then
    v_portal_kind := v_retailer_kind;
  else
    v_portal_kind := 'NONE';
  end if;

  return jsonb_build_object(
    'context_version', 1,
    'portal_kind',     v_portal_kind,
    'vendor',          v_vendor,
    'retailer',        v_retailer
  );
end;
$$;


-- ============================================================================
-- Privileges
-- ============================================================================
-- PostgreSQL grants EXECUTE to PUBLIC on every new function by default, and PUBLIC
-- is inherited by every role — so the first REVOKE is what actually removes anon's
-- access, and the per-role revokes are belt and braces. Revoking from
-- `authenticated` immediately before granting to it is the established convention
-- in this schema (20260717100208): it makes the grant this migration's own
-- explicit decision rather than a privilege quietly inherited from PUBLIC.
--
-- `anon` is granted NOTHING, deliberately. A signed-out caller has no context to
-- resolve, and refusing EXECUTE is a stronger, cheaper answer than computing
-- "NONE" for an anonymous request. It also means an unauthenticated client sees a
-- transport-level refusal rather than a well-formed body, which is the same shape
-- every other authenticated RPC in this schema presents.
--
-- `service_role` is granted NOTHING. This function resolves auth.uid(), and a
-- service-role connection has no auth.uid() to resolve — it would always compute
-- "NONE". There is no server-side use for it, so there is no grant.
revoke all     on function public.get_my_portal_context() from public;
revoke execute on function public.get_my_portal_context() from anon;
revoke execute on function public.get_my_portal_context() from authenticated;

grant  execute on function public.get_my_portal_context() to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- One function added. No table, column, constraint, index, trigger, RLS policy,
-- role, permission, role-permission mapping, or existing function was created,
-- altered, or dropped. public.get_vendor_super_admin_context,
-- public.resolve_retailer_owner_organization,
-- public.resolve_retailer_member_organization, every list_* RPC, every helper from
-- 20260716131104, and every RLS policy from 20260716131930 and 20260717114028 all
-- keep exactly the posture their own migrations left them in. No table privilege
-- is granted to anon or authenticated anywhere in this migration.
