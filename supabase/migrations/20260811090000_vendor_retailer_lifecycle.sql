-- Migration: vendor_retailer_lifecycle
-- Purpose: Adds exactly ONE permission, ONE role mapping and ONE function:
--
--            public.RETAILERS_MANAGE                     (permission catalogue row)
--            VENDOR_SUPER_ADMIN -> RETAILERS_MANAGE      (one mapping, one role)
--
--            public.set_vendor_retailer_status(uuid, text)
--              the Vendor Super Admin's deactivate / reactivate write for a Retailer
--              organization the Vendor already manages.
--
-- WHY THIS EXISTS — the gap it closes
--   20260810090000 gave a Retailer Owner the power to stand ONE STAFF MEMBER down, and its
--   closing note named this milestone explicitly as the one still missing: "The VENDOR-side
--   Retailer organization lifecycle — deactivating a whole Retailer, and the permission and
--   RPC that would do it — is a LATER MILESTONE and is not begun here." This is that
--   milestone.
--
--   Until now a Vendor that needed to stop a Retailer trading had no operation at all. The
--   recorded alternatives were each wrong in a different way: revoking invitations does
--   nothing to owners and staff who already accepted; deactivating the Owner's membership is
--   both unreachable (set_retailer_staff_membership_status refuses every RETAILER_OWNER
--   target, deliberately) and insufficient (the Manager and every Sales Staff member would
--   keep working); and deleting anything would destroy receipt history, Shop history and the
--   audit trail this schema is built to preserve.
--
-- THE CENTRAL DECISION: BOTH LIFECYCLE ROWS MOVE TOGETHER, ATOMICALLY
--   A suspended Retailer is expressed by TWO rows, not one:
--
--       public.vendor_retailers.status      'ACTIVE' <-> 'SUSPENDED'
--       public.organizations.status         'ACTIVE' <-> 'SUSPENDED'   (the RETAILER org)
--
--   Both are required, and writing either one alone is a defect:
--
--     * vendor_retailers.status ALONE IS NOT ENOUGH — and this is the finding that shaped
--       the whole function. The relationship row is a VENDOR-SIDE fact. It gates the Vendor's
--       own writes (add_vendor_retailer_shop, reserve_retailer_owner_invitation,
--       assign_vendor_product_to_retailer all require vr.status = 'ACTIVE'), but NOTHING ON
--       THE RETAILER SIDE CONSULTS IT. resolve_retailer_owner_organization and
--       resolve_retailer_member_organization — the two resolvers every Retailer Owner,
--       Manager and Sales Staff request passes through — join profiles, organization_members,
--       organizations, member_roles, roles and role_permissions, and never once touch
--       vendor_retailers. Neither does accept_retailer_staff_invitation, nor
--       retailer_staff_invitation_gate, nor the receipt path. A Vendor that wrote only the
--       relationship row would have "suspended" a Retailer whose entire staff carried on
--       submitting receipts.
--
--     * organizations.status IS the block, for exactly the same reason. Every one of those
--       resolvers already requires `o.status = 'ACTIVE'`, so flipping this single column
--       refuses every Retailer Owner, Manager and Sales Staff request — INCLUDING REQUESTS
--       CARRYING AN ALREADY-ISSUED, STILL-VALID SESSION, on their very next call. The
--       membership row is the authority, not the JWT; nobody has to be signed out, and
--       nothing has to expire.
--
--     * the relationship row still has to move WITH it, because the Vendor-side gates listed
--       above read vendor_retailers.status and would otherwise let a Vendor keep building out
--       a Retailer it had just suspended — new Shops, new Owner invitations, new product
--       assignments into an organization nobody can sign in to.
--
--   So the two rows are written in ONE TRANSACTION, each with a compare-and-set predicate and
--   a checked row count, and any drift aborts the whole thing. There is no ordering in which
--   a caller observes one row moved and the other not.
--
-- ACTIVE <-> SUSPENDED, AND NOTHING ELSE
--   Both columns already permit ACTIVE / SUSPENDED / DEACTIVATED (organizations_status_allowed
--   from 20260716124419; vendor_retailers' own check from 20260717094520). This function owns
--   exactly TWO of those three words and will neither set nor clear the third:
--
--     ACTIVE      trading normally.
--     SUSPENDED   paused by the Vendor, expected to resume. THIS IS THE STATE THIS FUNCTION
--                 WRITES, and it is what a later Web/Flutter UI will label "Inactive" —
--                 see the terminology note below.
--     DEACTIVATED permanently ended, retained for history. NOT REQUESTABLE HERE. It is the
--                 terminal word in both columns' vocabularies, no operation in this schema
--                 sets it today, and no operation clears it. A function that could write it
--                 would be inventing an offboarding decision nobody has made; a function that
--                 could clear it would be quietly resurrecting a relationship somebody ended
--                 deliberately. Both are refused (23514 for a request, 55000 for a current
--                 row that already holds it).
--
--   USER-FACING TERMINOLOGY IS DELIBERATELY DIFFERENT FROM THE STORED VALUE. Clients will say
--   Deactivate / Inactive / Reactivate, because "suspend" reads as an accusation to a
--   Retailer who is simply paused between contracts. The STORED word stays SUSPENDED because
--   it is the word both CHECK constraints, every existing status filter and every existing
--   audit row already use, and because DEACTIVATED already means something else and stronger
--   in this schema. The mapping is one-to-one and belongs in the client:
--
--       stored SUSPENDED  <->  shown "Inactive"       (verb: "Deactivate")
--       stored ACTIVE     <->  shown "Active"         (verb: "Reactivate")
--
-- WHAT IS DELIBERATELY NOT CASCADED, AND WHY
--   SUSPENDED IS NOT PUSHED DOWN INTO organization_members. Not one membership row is
--   touched, and that is the property that makes this operation safe to expose at all:
--
--     * organization_members.status is the RETAILER OWNER's instrument. 20260810090000 gave
--       the Owner deactivate/reactivate over their own Manager and Sales Staff, and each of
--       those rows records a decision THE OWNER made. Overwriting them from the Vendor side
--       would destroy that record, and reactivation would then have to GUESS which staff were
--       deactivated by the Owner before the suspension and which by the suspension itself.
--       There is no column that could tell them apart afterwards.
--     * IT IS ALSO UNNECESSARY. The organizations row alone blocks every Retailer request,
--       because every resolver requires an ACTIVE organization. A cascade would add a second
--       authority that can disagree with the first, in exchange for nothing.
--     * REACTIVATION IS THEREFORE A ONE-WORD WRITE, not a rebuild. Memberships, roles, Shops,
--       Shop assignments (live and retired), product assignments, receipts, invitations and
--       audit history are all exactly where they were, so access returns the moment
--       organizations.status goes back to ACTIVE.
--
--   auth.users IS NEVER TOUCHED — not banned, not deleted, not updated, no metadata write.
--   The reasoning is 20260810090000's, unchanged and if anything stronger here because this
--   operation is Retailer-WIDE:
--     1. auth.users is GLOBAL. A person may be Sales Staff at this Retailer and an Owner at
--        another; banning their Auth row would take a Vendor's decision about ONE tenant and
--        apply it everywhere.
--     2. It is not this schema's authorization model. The membership/organization rows are
--        the authority on every protected request, so a suspended Retailer's staff are
--        blocked on their next call regardless of what their JWT says.
--     3. It is unrecoverable in practice, and this operation is explicitly expected to be
--        reversed.
--     4. auth is not ours to write. No function in this schema writes auth.users.
--
--   THE CONSEQUENCE A CLIENT MUST UNDERSTAND: everyone at a suspended Retailer CAN STILL SIGN
--   IN. They simply have no Retailer context — get_my_portal_context() reports no Retailer,
--   every protected RPC refuses with the generic 42501 it already used, and
--   get_my_lifecycle_access_state() (20260810090000, UNCHANGED here) already returns exactly
--   the right word for this state: ORGANIZATION_INACTIVE. That diagnostic was written for
--   this milestone before this milestone existed; it needs no edit, and gets none.
--
-- PENDING INVITATIONS ARE LEFT ALONE, AND THAT IS THE CORRECT BEHAVIOUR
--   Not one row of retailer_invitations or retailer_staff_invitations is read for
--   modification here. They keep their status, their token hash and their expiry. While the
--   Retailer is suspended they are UNUSABLE — retailer_staff_invitation_gate and
--   accept_retailer_staff_invitation both require `o.status = 'ACTIVE'`, and
--   accept_retailer_owner_invitation requires both `vr.status = 'ACTIVE'` and
--   `o.status = 'ACTIVE'` — and after reactivation any invitation that has not meanwhile
--   EXPIRED simply works again. Revoking them on the way down would be irreversible (there is
--   no un-revoke), would send mail to nobody, and would destroy the Owner's outstanding
--   hiring decisions on the Vendor's authority.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * No table, column, constraint, index, trigger or RLS policy is created, altered or
--     dropped. In particular NO LIFECYCLE TIMESTAMP is added to public.organizations: there
--     is no suspended_at / deactivated_at column here and none is wanted. audit_logs already
--     records when, by whom and in which direction, with a queryable history of every change
--     rather than only the most recent one, and adding a column would create a second source
--     of truth that can disagree with the first.
--   * NO EXISTING FUNCTION IS TOUCHED. get_my_portal_context() and
--     get_my_lifecycle_access_state() in particular are byte-identical to what 20260729090000
--     and 20260810090000 left. No read contract, diagnostic, invitation function, receipt
--     function or Edge Function changes, because none of them needs to: they all already
--     consult organizations.status, which is precisely why this function writes it.
--   * No new READ RPC. The Vendor's existing Retailer reads (list_vendor_retailers,
--     get_vendor_retailer_detail, list_vendor_retailer_shops) deliberately do NOT filter on
--     status and therefore keep showing a suspended Retailer — which is what makes it
--     findable and reactivatable. Nothing here narrows them.
--   * No table privilege is granted to any browser role, and no INSERT/UPDATE/DELETE policy
--     is added. `authenticated` gains no direct write on organizations or vendor_retailers;
--     this function is the only path.
--   * No hard delete, anywhere. No dynamic SQL. No service_role grant.
--
-- Idempotency posture: the catalogue seeds upsert (permissions on `code`, role_permissions
--   ON CONFLICT DO NOTHING) exactly as every seed in this repository does, with the same
--   precondition guards. The function is a plain CREATE FUNCTION — a conflicting existing
--   object FAILS the migration, matching every function migration here. No fixed UUIDs. All
--   identifiers are <= 63 bytes. Every reference is schema-qualified because the function
--   runs with an EMPTY search_path.
--
-- Dependencies:
--   * 20260716124419 (organizations and organizations_status_allowed, profiles).
--   * 20260716125559 (roles, permissions, role_permissions, member_roles).
--   * 20260716130351 (audit_logs).
--   * 20260716131104 (has_organization_permission).
--   * 20260716133023 (the seeded VENDOR_SUPER_ADMIN role).
--   * 20260717083515 (get_vendor_super_admin_context — the Vendor derivation reused below).
--   * 20260717094520 (vendor_retailers and its status CHECK).
--   * 20260810090000 (the staff-side lifecycle whose authorization, locking, idempotency,
--     audit and refusal patterns this file follows).


-- ============================================================================
-- PART A — Permission
-- ============================================================================
-- ONE NEW PERMISSION, AND A NEW ONE ON PURPOSE.
--
-- RETAILERS_READ is not reused: it is mapped for READING the Retailer directory and is
-- consumed verbatim by three RLS SELECT policies (20260717114028). Widening it to authorize a
-- write would silently turn every current and future holder of a read permission into someone
-- who can switch a Retailer off, and would do so through policies that were written to
-- describe visibility.
--
-- RETAILERS_CREATE is not reused either: onboarding a NEW Retailer and suspending an EXISTING
-- one are different decisions with different blast radii, and a deployment must be able to
-- grant one without the other.
--
-- ON CONFLICT (code) targets permissions_code_unique, matching every seed in this repository.
-- The upsert refreshes only the human-readable fields and the module, leaving `id` untouched
-- so any role_permissions FK already pointing at this row survives a re-run.
insert into public.permissions (code, name, description, module)
values
  (
    'RETAILERS_MANAGE',
    'Manage Retailer Lifecycle',
    'Deactivate and reactivate a connected Retailer.',
    'RETAILERS'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();


-- ============================================================================
-- PART B — Precondition
-- ============================================================================
-- The mapping below resolves both sides by code. If either were missing the INSERT would
-- write nothing, the migration would report success, and RETAILERS_MANAGE would sit in the
-- catalogue assigned to nobody — every lifecycle call would be refused with 42501 and the
-- only symptom would be a button that never works. Fail-closed, but silently, and silence is
-- the hard part to debug.
--
-- This raises instead. It reads rows and writes nothing. In a correctly ordered history it
-- cannot fire — VENDOR_SUPER_ADMIN comes from 20260716133023 and RETAILERS_MANAGE was just
-- seeded in Part A — which is exactly why it is worth stating: it fires only when an
-- assumption this migration depends on has already broken.
do $$
declare
  v_missing text;
begin
  select string_agg(needed.code, ', ' order by needed.code) into v_missing
  from (
    values
      ('VENDOR_SUPER_ADMIN')
  ) as needed(code)
  where not exists (
    select 1 from public.roles r where r.code = needed.code
  );

  if v_missing is not null then
    raise exception 'Seed precondition failed: required role(s) missing: %', v_missing;
  end if;

  select string_agg(needed.code, ', ' order by needed.code) into v_missing
  from (
    values
      ('RETAILERS_MANAGE')
  ) as needed(code)
  where not exists (
    select 1 from public.permissions p where p.code = needed.code
  );

  if v_missing is not null then
    raise exception 'Seed precondition failed: required permission(s) missing: %', v_missing;
  end if;
end;
$$;


-- ============================================================================
-- PART C — Role -> permission mapping
-- ============================================================================
-- RETAILERS_MANAGE goes to VENDOR_SUPER_ADMIN, and ONLY to it. The WHERE clause names exactly
-- one role code, so no mapping row can reach CLAIM_REVIEWER, FINANCE_ADMIN, RETAILER_OWNER,
-- RETAILER_MANAGER, SALES_STAFF or any role added later. A Retailer-side role must never hold
-- this: it would let a tenant suspend or un-suspend itself, which is the one thing a
-- Vendor-side lifecycle control exists to prevent.
--
-- The ids are resolved by joining on code rather than written literally, which keeps this
-- independent of the generated UUIDs. roles.code and permissions.code are both unique, so the
-- cross join yields precisely 1 x 1 = 1 row.
--
-- ON CONFLICT DO NOTHING targets role_permissions_pkey (role_id, permission_id) — a re-run is
-- a no-op. NO EXISTING MAPPING IS ALTERED OR REMOVED anywhere in this migration, and no
-- existing permission's meaning changes.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'VENDOR_SUPER_ADMIN'
  and p.code = 'RETAILERS_MANAGE'
on conflict (role_id, permission_id) do nothing;


-- ============================================================================
-- PART D — set_vendor_retailer_status(uuid, text)
-- ============================================================================
-- TWO ARGUMENTS, AND NOTHING ELSE. A relationship to address and the state to put it in.
-- There is no Vendor id, Retailer organization id, actor id, profile id, permission code,
-- current status, audit action or timestamp in this signature — so no URL segment, form
-- field, header or cookie can nominate whose Retailer is changed, on whose authority, or from
-- what assumed starting state. Everything that decides WHETHER the write may happen is
-- derived from auth.uid().
--
-- THE TARGET IS A vendor_retailers.id, and that is the canonical, safe identifier:
--   * it is already in the Vendor's read contract (list_vendor_retailers.relationship_id) and
--     is the identifier add_vendor_retailer_shop and reserve_retailer_owner_invitation
--     already accept, so this introduces no new address space and no new disclosure;
--   * vendor_retailers is UNIQUE (vendor_organization_id, retailer_organization_id), so a
--     relationship id names exactly one Retailer AS SEEN BY EXACTLY ONE VENDOR. That is what
--     makes the single `vr.vendor_organization_id = v_vendor` predicate below a complete
--     cross-tenant boundary. A RETAILER ORGANIZATION ID COULD NOT DO THIS: the schema permits
--     several Vendors to manage one Retailer, so an organization id does not identify whose
--     relationship is meant and accepting one would force this function to guess.
--
-- RETURNS ONE ROW OF FOUR FIELDS: the relationship addressed, the status BOTH rows now hold
-- (reported separately, so a client can see for itself that they agree), and whether this
-- call actually changed anything. status_changed is what lets a client tell "saved" from
-- "already in that state" without a second read and without treating a double-tap as an
-- error. No Retailer name, email, timestamp, member count or audit detail crosses this
-- boundary.
--
-- REFUSALS ARE GENERIC AND UNIFORM. An unauthenticated caller, a Retailer Owner, Manager or
-- Sales Staff member, a Vendor lacking RETAILERS_MANAGE, and a null / unknown / another
-- Vendor's / non-RETAILER target all receive the SAME 42501 and the SAME message. That is
-- what stops a caller sweeping relationship ids to learn which exist, and what stops the
-- refusal itself disclosing another Vendor's Retailer list.
create function public.set_vendor_retailer_status(
  p_relationship_id uuid,
  p_status          text
)
returns table (
  relationship_id     uuid,
  retailer_status     text,
  relationship_status text,
  status_changed      boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor         uuid;
  v_vendor        uuid;
  v_relationship  uuid;
  v_retailer_org  uuid;
  v_rel_status    text;
  v_org_status    text;
  v_org_type      text;
  v_retailer_name text;
  v_updated       integer;
  v_action        text;
begin
  -- --------------------------------------------------------------------------
  -- 1. Authorization — identity, Vendor and permission, never browser-supplied
  -- --------------------------------------------------------------------------
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'Not authorized to change this Retailer''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- Resolve the acting Vendor through the ESTABLISHED context function rather than
  -- reimplementing its joins, exactly as add_vendor_retailer_shop and
  -- reserve_retailer_owner_invitation do. Calling it guarantees the chain here is the SAME
  -- chain the admin shell authorizes against — an ACTIVE profile, an ACTIVE membership, an
  -- ACTIVE organization of type VENDOR, and the ACTIVE VENDOR_SUPER_ADMIN role — and that it
  -- cannot drift from it later. The function takes no arguments and filters on auth.uid()
  -- internally, so this call cannot nominate a Vendor either.
  --
  -- `order by organization_id limit 1` reproduces the deterministic tie-break every other
  -- Vendor write uses for an administrator who holds the role in more than one Vendor
  -- organization: the same Vendor on every request, never planner-dependent.
  --
  -- Because the resolved profile is proved ACTIVE by this call, the actor_profile_id written
  -- into the audit row below is a valid, active actor id without a second lookup.
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor is null then
    raise exception 'Not authorized to change this Retailer''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- THE PERMISSION IS THE GATE, AND THE MAPPING IS THE AUTHORITY — not this function. There
  -- is deliberately NO `r.code = 'VENDOR_SUPER_ADMIN'` test anywhere in this body: holding
  -- that role is what get_vendor_super_admin_context() above already established, and WHICH
  -- role may perform this operation is decided by the role_permissions row seeded in Part C.
  -- If a future migration grants RETAILERS_MANAGE to another Vendor-side role, that role gains
  -- this operation without this file being edited; if the mapping is revoked, every caller is
  -- refused without a code change. Naming a role here would put the authorization rule in two
  -- places that can disagree.
  if not public.has_organization_permission(v_vendor, 'RETAILERS_MANAGE') then
    raise exception 'Not authorized to change this Retailer''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 2. The requested status — a closed vocabulary of exactly two words
  -- --------------------------------------------------------------------------
  -- Checked AFTER authorization, so an unauthenticated or unauthorized caller learns nothing
  -- from the shape of their own bad input — they are refused with 42501 before this line is
  -- ever reached, exactly as a stranger should be.
  --
  -- The comparison is EXACT and CASE-SENSITIVE. 'active', ' ACTIVE', '' and null are all
  -- rejected rather than coerced: this value is written verbatim into two columns whose CHECK
  -- constraints are case-sensitive and into an audit row a human reads later, and a silent
  -- upper() here would mean the audit trail and the client disagreed about what was asked for.
  --
  -- DEACTIVATED IS REJECTED HERE, not further down, and that is the point. It is a member of
  -- BOTH columns' vocabularies and is deliberately not a member of THIS function's: see the
  -- header. Nothing here may set it, and nothing here may clear it.
  if p_status is null or p_status not in ('ACTIVE', 'SUSPENDED') then
    raise exception 'That Retailer status is not valid'
      using errcode = 'check_violation';
  end if;

  -- --------------------------------------------------------------------------
  -- 3. LOCK ORDER, STEP ONE — the relationship row, proved to be ours
  -- --------------------------------------------------------------------------
  -- THE LOCK ORDER IN THIS FUNCTION IS FIXED AND IS THE ONLY ONE USED ANYWHERE IN IT:
  --
  --       (1) public.vendor_retailers   -> (2) public.organizations
  --
  -- Two concurrent lifecycle calls against the same Retailer therefore queue at the SAME row
  -- in the SAME order and serialize, rather than each holding half of what the other needs.
  -- Nothing below re-orders it, and a future edit must not either: taking the organizations
  -- row first in one path and the relationship row first in another is the classic recipe for
  -- a deadlock between two callers doing the same thing.
  --
  -- FOR UPDATE, not FOR SHARE, because BOTH rows are written on the real-change path. This is
  -- also the serialization point that makes the idempotency test in step 7 meaningful under
  -- concurrency instead of merely under single-user conditions: the second caller reads the
  -- first's COMMITTED status rather than a stale snapshot.
  --
  -- TWO predicates, and only two: `id` says WHICH relationship, `vendor_organization_id` says
  -- it must be one of the caller's own. Note what is NOT here — there is deliberately no
  -- `status = 'ACTIVE'` filter, because a SUSPENDED relationship is precisely what
  -- reactivation must be able to address. The permitted CURRENT states are checked explicitly
  -- in step 6, where the rule can be stated once and read.
  --
  -- A null, unknown or cross-tenant target all fall out as NULL here and are refused
  -- IDENTICALLY below. p_relationship_id = null yields no row without a special case, because
  -- `vr.id = null` is never true. (A malformed uuid literal never reaches this function at
  -- all: PostgreSQL rejects it as 22P02 while parsing the argument.)
  select vr.id, vr.retailer_organization_id, vr.status
    into v_relationship, v_retailer_org, v_rel_status
  from public.vendor_retailers vr
  where vr.id = p_relationship_id
    and vr.vendor_organization_id = v_vendor
  for update;

  if v_relationship is null then
    raise exception 'Not authorized to change this Retailer''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 4. LOCK ORDER, STEP TWO — the Retailer organization row
  -- --------------------------------------------------------------------------
  -- The organization id is read OUT of the verified relationship row in step 3 and is the
  -- only source of it anywhere in this function. It is never supplied and never guessed.
  --
  -- Locked SECOND, always. Held from here to commit, so no concurrent lifecycle call and no
  -- concurrent organization write can move this row between the checks below and the UPDATE
  -- in step 8.
  select o.status, o.organization_type, o.name
    into v_org_status, v_org_type, v_retailer_name
  from public.organizations o
  where o.id = v_retailer_org
  for update;

  -- The type test is belt and braces over 20260717094520's BEFORE-row trigger, which already
  -- forbids a non-RETAILER from occupying vendor_retailers.retailer_organization_id; stating
  -- it here keeps this correct even if that trigger were ever dropped, and makes the rule
  -- legible at the point it matters. A missing organization row (impossible under the FK)
  -- leaves v_org_type null and lands in the same branch.
  --
  -- Reported as the SAME 42501 with the SAME message as every other target refusal: a caller
  -- who reached here already proved ownership, but keeping one message means there is one
  -- fewer branch for a future edit to make disclosive.
  if v_org_type is distinct from 'RETAILER' then
    raise exception 'Not authorized to change this Retailer''s status'
      using errcode = 'insufficient_privilege';
  end if;

  -- --------------------------------------------------------------------------
  -- 5. MULTI-VENDOR SAFETY GUARD
  -- --------------------------------------------------------------------------
  -- ⚠️ THIS IS A STOPGAP, NOT AN ARCHITECTURE. Read the limitation note in the closing
  -- section before extending it.
  --
  -- The schema PERMITS several Vendors to manage one Retailer: vendor_retailers is unique on
  -- (vendor, retailer), not on retailer alone. But the block this function performs is
  -- TENANT-WIDE — organizations.status is a single column on a single row shared by every
  -- Vendor that manages that Retailer. So if two Vendors both had live relationships, either
  -- one could switch the Retailer off underneath the other, and the second Vendor's
  -- reactivation would silently override the first Vendor's suspension. Neither would ever
  -- see the other in any read contract they hold.
  --
  -- Rather than pick a winner, this refuses. If ANY other relationship exists for this
  -- Retailer that is not DEACTIVATED — ACTIVE or SUSPENDED, it makes no difference — the
  -- lifecycle change is unavailable, in BOTH directions. A DEACTIVATED relationship is a
  -- relationship that has ENDED and is retained only for history, so it does not block; that
  -- is what keeps an ordinary single-Vendor Retailer working after a previous Vendor's
  -- relationship was wound up.
  --
  -- THE REFUSAL DISCLOSES NOTHING. It is `exists`, never a count, never an id, and it raises
  -- the SAME 55000 with the SAME generic message as an inconsistent current pair. A caller
  -- cannot learn from it that another Vendor exists, which Vendor it is, how many there are,
  -- what state their relationship is in, or even that the reason is multi-Vendor at all —
  -- which matters, because the other Vendor's identity is another tenant's data and this
  -- caller has no read contract that would ever show it to them.
  --
  -- No FOR UPDATE on the other rows, deliberately. This is an existence test, and locking
  -- rows belonging to relationships the caller may not touch would both widen the lock
  -- footprint and introduce a second lock order — exactly what step 3 forbids.
  if exists (
    select 1
    from public.vendor_retailers other
    where other.retailer_organization_id = v_retailer_org
      and other.vendor_organization_id <> v_vendor
      and other.status <> 'DEACTIVATED'
  ) then
    raise exception 'This Retailer cannot be changed right now'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- --------------------------------------------------------------------------
  -- 6. The CURRENT pair must be one this function owns
  -- --------------------------------------------------------------------------
  -- Exactly two current pairs are valid, and they are the two this function itself can
  -- produce:
  --
  --       relationship ACTIVE     + organization ACTIVE
  --       relationship SUSPENDED  + organization SUSPENDED
  --
  -- EVERYTHING ELSE IS REFUSED, INCLUDING — ESPECIALLY — A MISMATCH. An ACTIVE relationship
  -- against a SUSPENDED organization (or the reverse) is a state this function cannot have
  -- created; it means something wrote one of these rows outside this path. THE FUNCTION DOES
  -- NOT SILENTLY RECONCILE IT. "Reactivating" a mismatched pair would quietly overwrite
  -- whatever the other writer intended and would erase the only evidence that a second writer
  -- exists; repairing it is a deliberate, investigated operation, not a side effect of a
  -- button press.
  --
  -- Either row holding DEACTIVATED lands here too. That word is terminal (see the header):
  -- this function will not clear it on either row.
  --
  -- ONE GENERIC 55000 for every cause, shared verbatim with the multi-Vendor guard above and
  -- the row-count drift checks below, so the client-visible message never discriminates
  -- between "another Vendor is involved", "your two rows disagree", "this relationship was
  -- ended" and "something moved underneath us". A client should render it as "this Retailer
  -- cannot be changed right now, contact support" and nothing more specific.
  if not (
       (v_rel_status = 'ACTIVE'    and v_org_status = 'ACTIVE')
    or (v_rel_status = 'SUSPENDED' and v_org_status = 'SUSPENDED')
  ) then
    raise exception 'This Retailer cannot be changed right now'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- --------------------------------------------------------------------------
  -- 7. Already in the requested state — write NOTHING, including no audit row
  -- --------------------------------------------------------------------------
  -- Step 6 has just proved the two rows agree, so testing either one against p_status tests
  -- both; the organization status is compared as well rather than assumed, because a reader
  -- of this branch should not have to hold step 6 in their head to see that it is safe.
  --
  -- NO UPDATE MEANS NO updated_at. Both tables carry a set_updated_at trigger, so re-running
  -- the UPDATE "harmlessly" would move the timestamp on every double-tap and destroy the
  -- record of when this Retailer was actually suspended. No audit row either: a no-op is not
  -- an event, and an audit trail that logs one per double-tap is a trail nobody can read.
  -- This matches set_retailer_staff_membership_status step 7 exactly.
  --
  -- The row is still RETURNED, with status_changed = false, so a client can tell "already
  -- inactive" from "denied" and render the truth rather than an error.
  if v_rel_status = p_status and v_org_status = p_status then
    return query select v_relationship, v_org_status, v_rel_status, false;
    return;
  end if;

  -- --------------------------------------------------------------------------
  -- 8. The two writes — one transaction, compare-and-set, row counts verified
  -- --------------------------------------------------------------------------
  -- BOTH statements run in the caller's transaction. If the second fails, the first is rolled
  -- back with it and so is the audit row below; there is no commit point between them and no
  -- exception handler that could swallow one. A caller can therefore never observe — and a
  -- crash can never leave — one row moved and the other not.
  --
  -- The `status = <observed>` predicate on each makes both a COMPARE-AND-SET against the value
  -- read under the lock, not a blind overwrite. Under the FOR UPDATE locks from steps 3 and 4
  -- neither can fail, which is exactly why each row count is CHECKED rather than assumed: if
  -- one ever fails, an assumption this function is built on has been broken by something
  -- outside it, and the only safe response is to abort the whole transaction rather than write
  -- an audit row describing a change that did not happen.
  --
  -- Drift is reported as 55000 — the same generic lifecycle-unavailable message as steps 5 and
  -- 6 — and deliberately NOT as 42501. The caller's authorization was established in step 1
  -- and has not changed; misreporting an internal consistency failure as an authorization
  -- denial would send an operator to audit permissions for a problem that is not there.
  --
  -- updated_at advances on both rows through their own set_updated_at triggers; it is not
  -- written here.
  update public.vendor_retailers vr
  set status = p_status
  where vr.id = v_relationship
    and vr.vendor_organization_id = v_vendor
    and vr.status = v_rel_status;

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'This Retailer cannot be changed right now'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- The organization side. The type predicate is repeated so that even a drifted row cannot
  -- be flipped into a lifecycle state by this function unless it is still a RETAILER.
  update public.organizations o
  set status = p_status
  where o.id = v_retailer_org
    and o.organization_type = 'RETAILER'
    and o.status = v_org_status;

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'This Retailer cannot be changed right now'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- --------------------------------------------------------------------------
  -- 9. Audit — exactly one safe event, in the same transaction as its rows
  -- --------------------------------------------------------------------------
  -- The action names the DIRECTION in the words the PRODUCT uses, not the words the columns
  -- use: RETAILER_DEACTIVATED / RETAILER_REACTIVATED. An operator reading the trail sees the
  -- decision that was made ("this Retailer was deactivated"), and the stored status values are
  -- carried alongside in metadata for anyone who needs the mechanism.
  --
  -- entity_type is RETAILER_ORGANIZATION and entity_id is the RETAILER ORGANIZATION id, not
  -- the relationship id: the thing whose lifecycle changed is the organization. The
  -- relationship id travels in metadata, where it is additional context rather than the
  -- subject.
  --
  -- organization_id is the ACTING VENDOR's, so the entry lands in the Vendor's own activity
  -- feed and is readable through list_vendor_audit_logs (20260804090000), which filters on
  -- `organization_id = <the caller's Vendor>`. It is therefore invisible to the Retailer,
  -- which is correct: this is a Vendor decision about a Retailer, recorded where the Vendor
  -- can find it.
  --
  -- METADATA CARRIES EXACTLY SIX KEYS, and every one is a value this function PROVED above
  -- rather than one it was handed: the name and both "before" statuses were read under the
  -- locks in steps 3 and 4, the relationship id came from the verified row, and both "after"
  -- statuses are the validated p_status. Deliberately absent: every email address, every Auth
  -- user id, every profile id (the ACTOR is actor_profile_id, a first-class column whose
  -- reader already has authority over it, and the TARGET is entity_id — neither belongs in
  -- free-form metadata), every invitation id, Shop id, product id and receipt id, every OTHER
  -- Vendor's id, every other relationship id, every relationship count, every token, hash,
  -- provider message and raw database message, and every caller-supplied value. The only two
  -- values that came from the caller — the relationship id and the requested status — are
  -- recorded only AFTER being proved to name the caller's own relationship and to be a member
  -- of the closed vocabulary.
  v_action := case p_status
    when 'SUSPENDED' then 'RETAILER_DEACTIVATED'
    when 'ACTIVE'    then 'RETAILER_REACTIVATED'
  end;

  insert into public.audit_logs (
    organization_id,
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    metadata
  )
  values (
    v_vendor,
    v_actor,
    v_action,
    'RETAILER_ORGANIZATION',
    v_retailer_org::text,
    jsonb_build_object(
      'retailer_name',               v_retailer_name,
      'relationship_id',             v_relationship,
      'retailer_status_before',      v_org_status,
      'retailer_status_after',       p_status,
      'relationship_status_before',  v_rel_status,
      'relationship_status_after',   p_status
    )
  );

  return query select v_relationship, p_status, p_status, true;
end;
$$;


-- ============================================================================
-- Privileges
-- ============================================================================
-- PostgreSQL grants EXECUTE to PUBLIC on every new function by default, and PUBLIC is
-- inherited by every role — so without the first revoke, anon would hold EXECUTE on a
-- SECURITY DEFINER writer despite nothing here granting it. anon is revoked explicitly as
-- well, so the intent survives a future re-grant to PUBLIC.
--
-- service_role is granted NOTHING, deliberately. The entire authority of this function is
-- auth.uid(), which a service-role connection does not have: the derivation in step 1 would
-- resolve no Vendor, the write could never proceed, and the audit row would have no actor to
-- attribute. A grant would produce a path that can only ever refuse — while inviting someone
-- to try to use it. No existing verified technical requirement asks for one.
revoke all     on function public.set_vendor_retailer_status(uuid, text) from public;
revoke execute on function public.set_vendor_retailer_status(uuid, text) from anon;
grant  execute on function public.set_vendor_retailer_status(uuid, text) to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- One permission, one mapping and one function added; nothing else exists in this migration.
-- No table, column, constraint, index, trigger or RLS policy is created, altered or dropped;
-- no lifecycle timestamp column is added to public.organizations; NO EXISTING PERMISSION,
-- ROLE OR MAPPING IS MODIFIED OR REMOVED; and NO EXISTING FUNCTION IS TOUCHED —
-- get_my_portal_context() keeps context_version 1, get_my_lifecycle_access_state() keeps its
-- six-word vocabulary, both Retailer resolvers, get_vendor_super_admin_context, every
-- invitation, acceptance, receipt, Shop and product function and every Edge Function are
-- exactly what their own migrations left.
--
-- public.organizations and public.vendor_retailers keep the posture 20260716131930 and
-- 20260717114028 left them in: RLS enabled, read-only policies only, and NO insert/update/
-- delete privilege of any kind held by anon or authenticated. This function is the only way a
-- browser session can change either status. organization_members, member_roles, profiles,
-- retailer_shops, retailer_shop_members, vendor_product_retailer_assignments,
-- receipt_submissions, retailer_invitations, retailer_staff_invitations and auth.users are
-- neither written nor re-privileged anywhere above, and there is no DELETE on this path.
--
-- The two audit vocabulary entries this adds — actions 'RETAILER_DEACTIVATED' and
-- 'RETAILER_REACTIVATED', entity_type 'RETAILER_ORGANIZATION' — need no catalogue row:
-- audit_logs.action and .entity_type are free text with only a not-empty check, exactly as
-- every existing code in those columns is.
--
-- ⚠️ KNOWN LIMITATION — THE MULTI-VENDOR GUARD IS A STOPGAP.
--   Step 5 refuses the lifecycle change outright when a second, non-DEACTIVATED relationship
--   exists for the same Retailer. That is the SAFE answer, not a good one: it makes the
--   operation unavailable to both Vendors rather than letting either of them act on a shared
--   row. It is correct today because no shipped flow creates a second live relationship — the
--   Vendor Admin is single-tenant by design and onboard_vendor_retailer only ever creates the
--   acting Vendor's own row — so the guard is expected never to fire in production.
--
--   BEFORE THIS PRODUCT SUPPORTS MORE THAN ONE ACTIVE VENDOR RELATIONSHIP PER RETAILER,
--   TENANT BLOCKING MUST BE REDESIGNED. Extending this function is not enough and must not be
--   attempted: the problem is that "is this Retailer blocked?" is currently a single shared
--   column, so it cannot express "blocked by Vendor A but not by Vendor B". A real design has
--   to decide what a Retailer's staff may do when one of several Vendors has suspended them
--   (it is not obviously all-or-nothing), and then move the block to something per-
--   relationship that every Retailer-side resolver consults — which is a change to the
--   resolvers, the receipt path and the invitation path, not to this file. Until that work is
--   done, the guard is the honest boundary of what this operation can promise.
--
-- The VENDOR WEB UI and the FLUTTER client for this operation are LATER MILESTONES and are
-- not begun here: this migration adds no Server Action, no component, no route and no client
-- call site of any kind.
