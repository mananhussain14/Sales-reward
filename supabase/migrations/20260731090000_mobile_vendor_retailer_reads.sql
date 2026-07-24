-- Migration: mobile_vendor_retailer_reads
-- Purpose: The reads a Vendor Super Admin needs to list their Retailers and open ONE of
--          them from a mobile client, and nothing else. It adds, and only adds:
--            1. public.vendor_retailer_owner_state(uuid)          [INTERNAL — no grants]
--            2. public.list_vendor_retailers()                    [authenticated]
--            3. public.get_vendor_retailer_detail(uuid)           [authenticated]
--            4. public.list_vendor_retailer_shops(uuid)           [authenticated]
--
-- THIS MIGRATION CHANGES NOTHING THAT IS ALREADY DEPLOYED. No table, column, constraint,
--   index, trigger, RLS policy, role, permission, or permission mapping is created,
--   altered or dropped. No existing function is edited, dropped, or replaced. In
--   particular public.get_vendor_retailer_owner_status(uuid) is UNTOUCHED — the web
--   Retailer detail page keeps calling exactly the function it calls today, with the same
--   signature and the same behaviour, and the new functions below neither replace nor
--   shadow it. No new permission is seeded: RETAILERS_READ already exists and is already
--   mapped to VENDOR_SUPER_ADMIN (20260717115211), and it is the permission every function
--   below requires.
--
-- WHY THESE FUNCTIONS EXIST — THE GAP THE AUDIT FOUND
--   The web assembles the Retailer directory in TypeScript
--   (lib/retailers/vendor-retailers.ts): one authorization RPC, then three table reads —
--   vendor_retailers, then organizations `in (…)`, then EVERY retailer_shops ROW for those
--   Retailers `in (…)`, selected purely so that JavaScript can count them with a Map. The
--   count is correct and the query count is fixed, but the ROW count is not: a Vendor with
--   fifty Retailers of forty shops each transfers two thousand rows to render fifty
--   integers. On a mobile connection that is the whole cost of the screen.
--
--   The detail page (lib/retailers/vendor-retailer-detail.ts) does the same thing in
--   miniature: one authorization RPC, a relationship read, an organizations read, a shops
--   read, and a fourth call to get_vendor_retailer_owner_status() — five round trips, four
--   of which a client-side join has to reassemble.
--
--   Neither is reusable by Flutter without reimplementing that join, and a join
--   reimplemented in a second client is a second place for tenant scoping to be got wrong.
--   The functions below do the joining and the counting in SQL, where the aggregation
--   belongs and where the Vendor is derived rather than supplied.
--
-- NO TENANT INPUT, ANYWHERE
--   list_vendor_retailers() takes NO arguments at all. The other two take exactly one: the
--   vendor_retailers row id, which SELECTS which already-authorized relationship is read
--   and never decides WHETHER anything may be read. There is no user id, profile id,
--   Vendor organization id, membership id, role, permission code, tenant id, or Retailer
--   organization id parameter on any function here. The Vendor is derived from auth.uid()
--   via public.get_vendor_super_admin_context(), exactly as every other Vendor RPC in this
--   schema derives it, and the relationship is then matched on BOTH its own id AND that
--   derived Vendor.
--
--   The Retailer organization id is deliberately an OUTPUT and never an INPUT. It is
--   returned so a Flutter Retailer screen can cross-link to the product-assignment API,
--   which already addresses the same tenant that way and already returns the same id to
--   the same role (list_vendor_product_retailer_assignments, 20260727210000) — the
--   two-address-space problem docs/mobile-backend-contract.md § 6.8 asks to close. It is
--   refused as an input because vendor_retailers.id is the narrower selector: it names one
--   Vendor's view of one Retailer, so a foreign value matches nothing rather than
--   selecting a Retailer some other Vendor manages.
--
-- MULTI-VENDOR BEHAVIOUR IS PRESERVED, NOT CHANGED
--   get_vendor_super_admin_context() returns one row per qualifying VENDOR organization,
--   ordered by organization id, and every existing Vendor RPC takes the first. A caller
--   who is a Super Admin of two Vendors therefore sees the lowest-id Vendor's Retailers,
--   deterministically and on every request. That is the shipped behaviour of
--   list_vendor_product_retailer_assignments(), get_vendor_retailer_owner_status(),
--   onboard_vendor_retailer() and the web itself. It is reproduced here verbatim rather
--   than "fixed", because changing it would change which Retailers an existing Vendor sees
--   as a side effect of a mobile read. It is documented as a limitation in
--   docs/mobile-backend-contract.md instead.
--
-- Idempotency posture: plain CREATE (no IF NOT EXISTS, no CREATE OR REPLACE). A conflicting
--   existing object FAILS the migration. No dynamic SQL. No fixed UUIDs. Every reference is
--   schema-qualified because every function runs with an EMPTY search_path. All identifiers
--   are <= 63 bytes.
--
-- Dependencies: 20260716124419 (organizations, profiles, organization_members),
--   20260716125559 (roles, member_roles), 20260716131104 (has_organization_permission),
--   20260717083515 (get_vendor_super_admin_context), 20260717094520 (vendor_retailers,
--   retailer_shops), 20260717115211 (the RETAILERS_READ permission and its mapping),
--   20260720092755 (retailer_invitations, the RETAILER_OWNER role),
--   20260721190000 (failure_code), 20260722090000 (invitation_kind).


-- ============================================================================
-- FUNCTION 1 — vendor_retailer_owner_state(uuid)   [INTERNAL; NOT GRANTED]
-- ============================================================================
-- The single derivation of "where has this Retailer's owner got to", reduced to one of
-- five words, set-based and cheap enough to evaluate once per row of a directory.
--
-- WHY THIS IS A FUNCTION RATHER THAN INLINE SQL IN BOTH READS. The precedence below is
-- not obvious — an ACTIVE owner outranks any invitation, a live PENDING invitation is
-- DELIVERY_FAILED until its flow's own completion proof exists, and an expired one is
-- EXPIRED whatever else is on file. Written out twice it would be two definitions free to
-- drift, and only one of them could be right. Written once it is one fact with two
-- readers.
--
-- IT MIRRORS public.get_vendor_retailer_owner_status(uuid) EXACTLY, and deliberately so:
-- the Flutter detail screen calls that function for the owner CARD (recipient name, email,
-- timestamps, failure classification, invitation kind), while these reads carry only the
-- state word for a badge. Two answers to one question would be a bug the moment they
-- disagreed, so the pgTAP suite asserts row-for-row equality between this function's
-- output and that function's owner_state across every fixture state. That assertion is
-- what keeps the mirror honest; this comment only explains why it exists.
--
-- WHAT IT DOES NOT DO. It performs NO authorization of its own and must never be reachable
-- by a browser role — it takes a Retailer organization id and reports, by its answer,
-- facts about that Retailer's owner and invitations. Granted to authenticated it would be
-- an oracle for probing any organization id. It is called ONLY from the two SECURITY
-- DEFINER reads below, which have already derived the Vendor from auth.uid() and already
-- proved the Retailer is one of that Vendor's own. The revokes at the end of this section
-- are what make that a boundary rather than a convention.
--
-- NO NAME, EMAIL, TIMESTAMP, TOKEN, HASH, ID, OR FAILURE CODE LEAVES THIS FUNCTION. It
-- returns one text value out of a closed set of five.
create function public.vendor_retailer_owner_state(
  p_retailer_organization_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv public.retailer_invitations%rowtype;
begin
  -- A null id names no Retailer. NONE is the honest answer and keeps every caller free of
  -- a null branch; it can only arise from a caller bug, since both readers pass a value
  -- read from a NOT NULL column.
  if p_retailer_organization_id is null then
    return 'NONE';
  end if;

  -- 1. ACTIVE — a qualifying ACTIVE RETAILER_OWNER membership wins outright, whatever
  --    invitation history exists. EXISTS rather than the owner-status function's
  --    ordered LIMIT 1: that function needs WHICH member, this one needs only WHETHER.
  if exists (
    select 1
    from public.organization_members m
    join public.member_roles mr on mr.organization_member_id = m.id
    join public.roles r on r.id = mr.role_id
    where m.organization_id = p_retailer_organization_id
      and m.status = 'ACTIVE'
      and r.code = 'RETAILER_OWNER'
      and r.status = 'ACTIVE'
  ) then
    return 'ACTIVE';
  end if;

  -- 2. PENDING / DELIVERY_FAILED — the newest current, unexpired PENDING invitation.
  --    Ordered exactly as get_vendor_retailer_owner_status orders it, so both functions
  --    pick the same row when a Retailer has several.
  select *
    into v_inv
  from public.retailer_invitations ri
  where ri.retailer_organization_id = p_retailer_organization_id
    and ri.status = 'PENDING'
    and ri.expires_at > now()
  order by ri.created_at desc, ri.id desc
  limit 1;

  if v_inv.id is not null then
    -- Completion proof depends on the flow. A NEW_USER invitation is genuinely sent only
    -- once finalize() left BOTH a membership and sent_at; an EXISTING_USER invitation has
    -- no membership before acceptance, so sent_at alone is its proof. Anything short of
    -- that is a reserved-but-undelivered row, which reads as DELIVERY_FAILED.
    if (v_inv.invitation_kind = 'NEW_USER'
          and v_inv.organization_member_id is not null
          and v_inv.sent_at is not null)
       or (v_inv.invitation_kind = 'EXISTING_USER'
          and v_inv.sent_at is not null) then
      return 'PENDING';
    end if;

    return 'DELIVERY_FAILED';
  end if;

  -- 3. EXPIRED — an invitation marked EXPIRED, or a PENDING one whose clock has run out
  --    before the sweep got to it. Which row is newest does not matter here: the state is
  --    the same either way, so EXISTS is enough.
  if exists (
    select 1
    from public.retailer_invitations ri
    where ri.retailer_organization_id = p_retailer_organization_id
      and (
        ri.status = 'EXPIRED'
        or (ri.status = 'PENDING' and ri.expires_at <= now())
      )
  ) then
    return 'EXPIRED';
  end if;

  -- 4. NONE — no active owner and no invitation state worth displaying. REVOKED and
  --    ACCEPTED-but-no-longer-active rows land here, exactly as they do today.
  return 'NONE';
end;
$$;

-- Privileges. PostgreSQL grants EXECUTE to PUBLIC on every new function by default, and
-- PUBLIC is inherited by every role — so without the first revoke, anon and authenticated
-- would hold EXECUTE on a SECURITY DEFINER function that reports on any organization id
-- handed to it. The anon and authenticated revokes are belt and braces, matching
-- public.assert_organization_type (20260717094520).
--
-- The two readers below keep working regardless: they are SECURITY DEFINER and owned by
-- the same role that owns this function, so they invoke it as its owner and not as the
-- browser role that called them.
revoke all     on function public.vendor_retailer_owner_state(uuid) from public;
revoke execute on function public.vendor_retailer_owner_state(uuid) from anon;
revoke execute on function public.vendor_retailer_owner_state(uuid) from authenticated;


-- ============================================================================
-- FUNCTION 2 — list_vendor_retailers()
-- ============================================================================
-- Every Retailer the calling Vendor Super Admin's own Vendor organization manages, with
-- the list-level facts a directory screen renders and nothing else.
--
-- ZERO ARGUMENTS. There is no Vendor id, Retailer id, user id, or filter to pass, so no
-- URL segment, form field, header, or cookie can nominate whose directory is returned.
--
-- UNAUTHORIZED IS AN EXCEPTION; NO RETAILERS IS AN EMPTY SET. A denial and "this Vendor
-- has not onboarded a Retailer yet" are different facts and a client renders them
-- differently; collapsing them would show a brand-new Vendor a permission error, and would
-- show a Retailer Owner an empty directory instead of a refusal.
--
-- EVERY LIFECYCLE STATE IS LISTED. Relationship status and Retailer status are both
-- returned and neither is filtered: a Vendor that could not see the relationship it
-- suspended would have no way to review or resume it, and hiding a DEACTIVATED row would
-- make ending a relationship look like deleting one. This matches the web directory, the
-- RLS policies, and the product-assignment list, all of which filter neither.
--
-- COUNTS ARE COMPUTED IN SQL, NOT TRANSFERRED. One lateral aggregate per Retailer inside a
-- single statement, so the wire carries one row per Retailer instead of one row per shop.
-- shop_count counts EVERY shop, matching the number the web directory shows today so the
-- two clients cannot disagree; active_shop_count is the ACTIVE subset, which the web has
-- no column for but a mobile summary line does.
--
-- NOT RETURNED, and the reason each is withheld:
--   vendor_organization_id                the caller already knows which Vendor they are;
--                                         an id in a payload is one a form could echo back.
--   owner name, email, timestamps         list-level PII with no use in a directory row.
--                                         The detail screen's owner card gets them from
--                                         get_vendor_retailer_owner_status(), which the
--                                         Vendor already calls today.
--   invitation id, token, token_hash,     never returned by anything, anywhere. The
--     failure_code, invitation_kind       invitations table stays default-deny with zero
--                                         policies and zero browser privileges.
--   shop rows, shop ids, addresses        a directory row needs a count, not an inventory.
--   membership ids, role ids, permissions authorization internals are not display data.
--   audit metadata, updated_at            administration trivia; created_at is the one
--                                         timestamp a directory legitimately sorts or
--                                         reports on ("onboarded when").
create function public.list_vendor_retailers()
returns table (
  relationship_id         uuid,
  retailer_organization_id uuid,
  retailer_name           text,
  retailer_status         text,
  relationship_status     text,
  relationship_created_at timestamptz,
  shop_count              integer,
  active_shop_count       integer,
  owner_state             text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  -- Identity and Vendor, from auth.uid() alone. get_vendor_super_admin_context() accepts
  -- no arguments and evaluates the whole chain — ACTIVE profile owned by auth.uid(),
  -- ACTIVE membership, ACTIVE VENDOR organization, ACTIVE VENDOR_SUPER_ADMIN role. A
  -- signed-out caller, a Retailer Owner, a Retailer Manager, a Sales Staff member, a
  -- suspended profile and a suspended membership all resolve to zero rows here.
  --
  -- ORDER BY / LIMIT 1 reproduces the shipped multi-Vendor rule; see the header.
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  -- Fail closed, and generically. The message names no table, column, policy, Vendor, or
  -- Retailer: one refusal for "not signed in", "not a Vendor Super Admin", and "this
  -- Vendor's role does not hold RETAILERS_READ" alike.
  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'RETAILERS_READ') then
    raise exception 'Not authorized to view Retailers'
      using errcode = 'insufficient_privilege';
  end if;

  -- ONE statement, whatever the Retailer count. The lateral is an aggregate over an
  -- indexed range (retailer_shops_org_status_idx leads on retailer_organization_id), not
  -- a second round trip, and the owner-state call is a per-row scalar over two indexed
  -- lookups — not a per-row authorization, which was resolved once above and is never
  -- re-derived inside the loop.
  --
  -- Row multiplicity is fixed by the schema rather than by a DISTINCT: vendor_retailers
  -- has at most one row per (vendor, retailer) pair (vendor_retailers_unique_pair), the
  -- organizations join is on a primary key, and the lateral returns exactly one row. A
  -- Retailer therefore cannot appear twice, and a Retailer with no shops still appears —
  -- LEFT JOIN LATERAL keeps the row and coalesce turns its absent counts into 0.
  --
  -- Ordering is by name then relationship id: deterministic and total, so a paginated or
  -- re-fetched client sees a stable sequence and two Retailers sharing a name cannot swap
  -- places between requests. Same ordering shape as
  -- list_vendor_product_retailer_assignments().
  return query
  select
    vr.id,
    o.id,
    o.name,
    o.status,
    vr.status,
    vr.created_at,
    coalesce(sc.shop_total, 0)::integer,
    coalesce(sc.active_total, 0)::integer,
    public.vendor_retailer_owner_state(o.id)
  from public.vendor_retailers vr
  join public.organizations o
    on o.id = vr.retailer_organization_id
   and o.organization_type = 'RETAILER'
  left join lateral (
    select
      count(*)                                          as shop_total,
      count(*) filter (where s.status = 'ACTIVE')       as active_total
    from public.retailer_shops s
    where s.retailer_organization_id = o.id
  ) sc on true
  where vr.vendor_organization_id = v_vendor
  order by o.name, vr.id;
end;
$$;

revoke all     on function public.list_vendor_retailers() from public;
revoke execute on function public.list_vendor_retailers() from anon;
grant  execute on function public.list_vendor_retailers() to authenticated;


-- ============================================================================
-- FUNCTION 3 — get_vendor_retailer_detail(uuid)
-- ============================================================================
-- ONE of the calling Vendor's own Retailer relationships, addressed by the relationship
-- id — the same id list_vendor_retailers() returned and the same id the web detail route
-- already carries in its URL.
--
-- THE RELATIONSHIP ID IS AN ADDRESS, NOT AUTHORIZATION. Holding one grants nothing: the
-- Vendor is derived above it from auth.uid(), and the row is matched on BOTH its own id
-- AND that derived Vendor, so another Vendor's relationship id matches nothing here.
--
-- AN ID THAT IS NOT YOURS RETURNS ZERO ROWS, NOT AN ERROR — and so does an id that no row
-- owns, and so does null. This is the important difference from the authorization raise
-- above. The caller IS an authorized Vendor Super Admin; they have simply named a
-- relationship they may not read. A distinguishable refusal would confirm that another
-- Vendor's relationship EXISTS, and by sweeping ids, roughly how many. "Zero rows" is
-- byte-identical for a nonexistent id, another Vendor's id, and null.
--
--   This deliberately DIFFERS from get_vendor_retailer_owner_status(uuid), which raises
--   42501 for a foreign or unknown relationship — a refusal indistinguishable from "you
--   are not a Vendor at all", but also one that tells a caller their id was rejected.
--   That function is not modified here (the web depends on it exactly as it is); the new
--   contract simply does not repeat the pattern.
--
-- ONE ROW, FIXED SIZE. Shops are NOT nested here. A Retailer's shop list is unbounded, and
-- a detail payload that grows with it would be neither cacheable nor predictable on a
-- mobile connection; the counts below answer the summary question, and
-- list_vendor_retailer_shops() answers the inventory question when the screen actually
-- scrolls to it. That is the one companion operation this milestone adds.
--
-- THE COLUMN SET IS list_vendor_retailers() PLUS the two Retailer profile fields the web
-- detail page displays and the list does not (country_code, default_currency). Every other
-- column is byte-identical in name, type, and meaning, so one Flutter model deserializes
-- both and a future addition has to be made to both or to neither.
--
-- NOT RETURNED: the owner's name, email, or timestamps (the detail screen's owner card
-- calls get_vendor_retailer_owner_status() for those, exactly as the web does); any
-- invitation id, token, token_hash, or failure classification; vendor_organization_id;
-- membership, role, or permission internals; any Retailer staff; any receipt; and
-- updated_at.
create function public.get_vendor_retailer_detail(
  p_relationship_id uuid
)
returns table (
  relationship_id          uuid,
  retailer_organization_id uuid,
  retailer_name            text,
  retailer_status          text,
  country_code             text,
  default_currency         text,
  relationship_status      text,
  relationship_created_at  timestamptz,
  shop_count               integer,
  active_shop_count        integer,
  owner_state              text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'RETAILERS_READ') then
    raise exception 'Not authorized to view Retailers'
      using errcode = 'insufficient_privilege';
  end if;

  -- A null id names no row, and returning zero rows keeps it indistinguishable from every
  -- other id that names no row this caller may read.
  if p_relationship_id is null then
    return;
  end if;

  -- The vendor_organization_id predicate is what makes a foreign relationship id inert.
  -- It is compared against the Vendor derived above — never against a parameter.
  return query
  select
    vr.id,
    o.id,
    o.name,
    o.status,
    o.country_code,
    o.default_currency,
    vr.status,
    vr.created_at,
    coalesce(sc.shop_total, 0)::integer,
    coalesce(sc.active_total, 0)::integer,
    public.vendor_retailer_owner_state(o.id)
  from public.vendor_retailers vr
  join public.organizations o
    on o.id = vr.retailer_organization_id
   and o.organization_type = 'RETAILER'
  left join lateral (
    select
      count(*)                                    as shop_total,
      count(*) filter (where s.status = 'ACTIVE') as active_total
    from public.retailer_shops s
    where s.retailer_organization_id = o.id
  ) sc on true
  where vr.id = p_relationship_id
    and vr.vendor_organization_id = v_vendor;
end;
$$;

revoke all     on function public.get_vendor_retailer_detail(uuid) from public;
revoke execute on function public.get_vendor_retailer_detail(uuid) from anon;
grant  execute on function public.get_vendor_retailer_detail(uuid) to authenticated;


-- ============================================================================
-- FUNCTION 4 — list_vendor_retailer_shops(uuid)
-- ============================================================================
-- The shops of ONE of the calling Vendor's own Retailers — the companion read
-- get_vendor_retailer_detail() deliberately does not nest.
--
-- SAME SELECTOR, SAME AUTHORIZATION, SAME NON-LEAKING RESULT. It is addressed by the
-- relationship id, not by a Retailer organization id, so the two operations cannot drift
-- into two address spaces and a foreign id is inert here for exactly the reason it is
-- inert there. An unknown or foreign relationship yields zero rows — the same answer a
-- genuinely shop-less Retailer of the caller's own gives. That ambiguity is in the safe
-- direction and is why a client calls the detail read first: zero rows THERE is the
-- authoritative "this relationship is not addressable by you".
--
-- COLUMNS ARE THE FIVE THE WEB DETAIL PAGE ALREADY DISPLAYS, PLUS shop_id. The web
-- payload carries no id and keys its rows by array index, which docs/mobile-backend-
-- contract.md § 6.3 flags as the reason a mobile list cannot key a widget, deduplicate,
-- or navigate; the sibling reads list_retailer_staff_assignable_shops() and
-- list_my_assigned_receipt_shops() both already return shop_id to their own roles. It is
-- returned here for the same reason and is safe for the same reason: this Vendor is
-- already authorized over these exact shops by retailer_shops_select_vendor_authorized.
--
-- NOT RETURNED: address_line1, address_line2, region, postal_code (the Vendor UI displays
-- none of them and a shop's street address is not needed to identify it), created_at,
-- updated_at, and retailer_organization_id — the caller supplied the relationship and the
-- detail read already told them the Retailer.
--
-- NO STATUS FILTER, matching the web: a SUSPENDED or DEACTIVATED shop stays listed, so
-- this list and the shop_count in the two reads above can never contradict each other.
create function public.list_vendor_retailer_shops(
  p_relationship_id uuid
)
returns table (
  shop_id      uuid,
  shop_name    text,
  shop_code    text,
  city         text,
  country_code text,
  shop_status  text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'RETAILERS_READ') then
    raise exception 'Not authorized to view Retailers'
      using errcode = 'insufficient_privilege';
  end if;

  if p_relationship_id is null then
    return;
  end if;

  -- The Retailer is reached THROUGH the caller's own relationship row, never named
  -- directly, so a shop can only be returned when the relationship joining it to this
  -- Vendor exists. Cross-tenant shops have no such row and are therefore unreachable.
  --
  -- Ordering by name then id is deterministic and total, matching the web's alphabetical
  -- shop list while remaining stable for two shops that share a name.
  return query
  select
    s.id,
    s.name,
    s.code,
    s.city,
    s.country_code,
    s.status
  from public.vendor_retailers vr
  join public.organizations o
    on o.id = vr.retailer_organization_id
   and o.organization_type = 'RETAILER'
  join public.retailer_shops s
    on s.retailer_organization_id = o.id
  where vr.id = p_relationship_id
    and vr.vendor_organization_id = v_vendor
  order by s.name, s.id;
end;
$$;

revoke all     on function public.list_vendor_retailer_shops(uuid) from public;
revoke execute on function public.list_vendor_retailer_shops(uuid) from anon;
grant  execute on function public.list_vendor_retailer_shops(uuid) to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- One internal derivation and three read functions. Nothing else exists in this migration.
-- No table, column, constraint, index, trigger, RLS policy, role, permission, or mapping
-- is created or altered; no existing function is touched; and no table privilege is
-- granted to any browser role — public.retailer_invitations in particular stays default-
-- deny with zero policies and zero privileges for anon and authenticated, and the
-- migration-9 read policies on public.vendor_retailers, public.organizations and
-- public.retailer_shops are unchanged. No index is added: every predicate above is served
-- by an existing one (vendor_retailers_vendor_status_idx,
-- retailer_shops_org_status_idx, retailer_invitations_retailer_status_idx, and the
-- organization_members unique key on (organization_id, user_id)), and a speculative index
-- would be a cost with no measured cause.
--
-- service_role is granted nothing here. All three reads derive their authority from
-- auth.uid(), which a service-role connection does not have, so granting it would produce
-- a function that can only ever refuse.
