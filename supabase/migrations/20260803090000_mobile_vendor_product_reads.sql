-- Migration: mobile_vendor_product_reads
-- Purpose: The two reads a Vendor Super Admin needs to OPEN one product and to see which
--          of their Retailers currently hold it, from a mobile client. It adds, and only
--          adds:
--            1. public.get_vendor_product_detail(uuid)                [authenticated]
--            2. public.list_vendor_product_assigned_retailers(uuid)   [authenticated]
--
-- THE PRODUCT LIST IS NOT RE-ADDED. public.list_vendor_products() (20260727210000) already
--   is the mobile list contract: zero arguments, `authenticated`, PRODUCTS_READ, the Vendor
--   derived from auth.uid(), one row per product, the assignment count aggregated in SQL,
--   no Vendor organization id, no creator identity and no audit metadata. The audit found
--   nothing to fix in it, so this migration adds no second list — a duplicate catalogue
--   read would be a second definition of "this Vendor's products", free to drift from the
--   one the web already renders. It is NOT modified here either: its signature, body,
--   ordering and grants are exactly what is deployed today.
--
-- THIS MIGRATION CHANGES NOTHING THAT IS ALREADY DEPLOYED. No table, column, constraint,
--   index, trigger, RLS policy, role, permission or permission mapping is created, altered
--   or dropped. No existing function is edited, dropped or replaced. In particular
--   public.list_vendor_product_retailer_assignments(uuid) is UNTOUCHED — the web product
--   detail page keeps calling exactly the function it calls today, with the same signature,
--   the same permission and the same rows. No permission is seeded: PRODUCTS_READ
--   (20260727090000) and RETAILERS_READ (20260717115211) both already exist and are both
--   already mapped to VENDOR_SUPER_ADMIN.
--
-- WHY THESE TWO FUNCTIONS EXIST — THE TWO GAPS THE AUDIT PROVED
--
--   GAP 1 — there is no detail read at all. The web product detail page
--   (app/(admin)/products/[productId]/page.tsx) calls getVendorProducts(), which calls
--   list_vendor_products(), and then finds the product IN THAT ARRAY in TypeScript:
--
--       const product = catalog.products.find((entry) => entry.productId === normalizedId);
--
--   That is correct and safe on the web — the id in the URL selects from a set already
--   scoped to the caller's Vendor, so a foreign id is simply absent — but it means opening
--   ONE product transfers the WHOLE catalogue. A Vendor with two thousand products
--   transfers two thousand rows to render one, on every detail open, over a mobile
--   connection. Reimplementing that find() in Dart would also make a second client
--   responsible for a scoping decision that belongs in SQL. get_vendor_product_detail()
--   returns the one row, matched on BOTH the id AND the derived Vendor.
--
--   GAP 2 — the existing assignment read is an EDITOR contract, not a READ contract.
--   list_vendor_product_retailer_assignments(uuid) requires PRODUCT_RETAILER_ASSIGN — the
--   permission to CHANGE assignments — and returns EVERY Retailer the Vendor manages,
--   including those the product was never assigned to (assignment_status NULL), because the
--   web screen it serves is an assign/withdraw matrix. Three consequences for a read-only
--   mobile screen:
--     a. a Vendor role holding PRODUCTS_READ but not PRODUCT_RETAILER_ASSIGN is refused
--        outright, so a read-only product screen would demand a write permission;
--     b. the client must filter the never-assigned rows out itself to answer "which
--        Retailers is this assigned to", and a client-side filter is where an unassigned
--        Retailer eventually gets rendered as assigned;
--     c. it returns retailer_organization_id and no relationship id, while the shipped
--        Flutter Vendor Retailer detail screen is addressed by vendor_retailers.id
--        (list_vendor_retailers / get_vendor_retailer_detail, 20260731090000). That is
--        exactly the two-address-space problem docs/mobile-backend-contract.md § 6.8 and
--        docs/mobile-role-flow-map.md V-15 flag: a product's assignment row cannot
--        cross-link to the Retailer screen without a second lookup.
--   list_vendor_product_assigned_retailers() answers the read question directly: only rows
--   that actually exist in vendor_product_retailer_assignments, with the relationship id
--   the Retailer screens already use.
--
-- NO TENANT INPUT, ANYWHERE
--   Both functions take exactly ONE argument: the vendor_products row id. It SELECTS which
--   already-authorized product is read and never decides WHETHER anything may be read.
--   There is no user id, auth user id, profile id, Vendor organization id, membership id,
--   role code, permission code, tenant id, Retailer organization id, product status or
--   assignment status parameter on either function. The Vendor is derived from auth.uid()
--   through public.get_vendor_super_admin_context(), exactly as every other Vendor RPC in
--   this schema derives it, and the product is then matched on BOTH its own id AND that
--   derived Vendor.
--
--   The product id is the right selector because it IS the tenant boundary here:
--   vendor_products.vendor_organization_id is NOT NULL and immutable by trigger, so a
--   product belongs to exactly one Vendor for its whole life and an id from another
--   Vendor's catalogue matches nothing. The Retailer organization id is deliberately an
--   OUTPUT and never an INPUT, for the same reason it is in the Retailer reads: it names a
--   tenant some other Vendor may also manage, whereas a product id names one Vendor's own
--   row.
--
-- MULTI-VENDOR BEHAVIOUR IS PRESERVED, NOT CHANGED
--   get_vendor_super_admin_context() returns one row per qualifying VENDOR organization,
--   ordered by organization id, and every existing Vendor RPC takes the first. A caller who
--   is a Super Admin of two Vendors therefore reads the lowest-id Vendor's catalogue,
--   deterministically and on every request — the shipped behaviour of
--   list_vendor_products(), list_vendor_product_retailer_assignments(),
--   list_vendor_retailers() and the web itself. It is reproduced here verbatim rather than
--   "fixed": changing it would change which products an existing Vendor sees as a side
--   effect of a mobile read. It is documented as a limitation in
--   docs/mobile-vendor-product-reads-audit.md instead.
--
-- NO PRODUCT IMAGE FIELD, BECAUSE THERE IS NO PRODUCT IMAGE. The audit searched the whole
--   repository: public.vendor_products has no image, photo, media, asset or storage column;
--   no storage bucket holds product media (the only buckets are the receipt ones); the web
--   catalogue and detail pages render no image; and lib/products contains no storage call.
--   Option A of the milestone's image decision is therefore the only honest one — nothing
--   is returned, because nothing exists. Inventing a signed-URL path here would be building
--   an image system to decorate a screen, and the first thing it would have to sign is a
--   column that does not exist.
--
-- Idempotency posture: plain CREATE FUNCTION (no IF NOT EXISTS, no CREATE OR REPLACE). A
--   conflicting existing object FAILS the migration. No dynamic SQL. No fixed UUIDs. Every
--   reference is schema-qualified because both functions run with an EMPTY search_path. All
--   identifiers are <= 63 bytes.
--
-- Dependencies: 20260716124419 (organizations, profiles), 20260716131104
--   (has_organization_permission), 20260717083515 (get_vendor_super_admin_context),
--   20260717094520 (vendor_retailers), 20260717115211 (the RETAILERS_READ permission and its
--   mapping), 20260727090000 (vendor_products, vendor_product_retailer_assignments, the
--   PRODUCTS_READ permission and its mapping), 20260727210000 (list_vendor_products, whose
--   count semantics function 1 reproduces exactly).


-- ============================================================================
-- FUNCTION 1 — get_vendor_product_detail(uuid)
-- ============================================================================
-- ONE of the calling Vendor's own products, addressed by the product id — the same id
-- list_vendor_products() returns and the same id the web detail route already carries in
-- its URL.
--
-- THE PRODUCT ID IS AN ADDRESS, NOT AUTHORIZATION. Holding one grants nothing: the Vendor is
-- derived above it from auth.uid(), and the row is matched on BOTH its own id AND that
-- derived Vendor, so another Vendor's product id matches nothing here.
--
-- AN ID THAT IS NOT YOURS RETURNS ZERO ROWS, NOT AN ERROR — and so does an id that no row
-- owns, and so does null. This is the important difference from the authorization raise
-- below it. The caller IS an authorized Vendor Super Admin; they have simply named a product
-- they may not read. A distinguishable refusal would confirm that another Vendor's product
-- EXISTS, and by sweeping ids, roughly how large a competitor's catalogue is. "Zero rows" is
-- byte-identical for a nonexistent id, another Vendor's id, and null.
--
--   This deliberately DIFFERS from update_vendor_product(uuid, …), set_vendor_product_status
--   (uuid, text) and list_vendor_product_retailer_assignments(uuid), all of which raise
--   42501 for a foreign or unknown product id. Those are not modified here (the web depends
--   on them exactly as they are); the new read contract simply does not repeat the pattern.
--
-- THE COLUMN SET IS list_vendor_products() PLUS assignment_count. Every shared column is
-- byte-identical in NAME, TYPE and MEANING — including active_assignment_count, which is
-- `bigint` there and `bigint` here — so ONE Flutter model deserializes a list row and a
-- detail row, and a future addition has to be made to both or to neither.
--
--   assignment_count is the one addition, and it is the count the list has no column for:
--   EVERY assignment row for this product, ACTIVE and INACTIVE alike. It exists so a detail
--   screen can say "assigned to 3 of the 5 Retailers that have ever held this product"
--   without downloading the assignment list to find out. It is EXACTLY the number of rows
--   list_vendor_product_assigned_retailers() returns for the same product — that invariant
--   is asserted in pgTAP, and it is the reason the count is computed over the same table
--   with the same predicate rather than over a join that might filter differently.
--
-- COUNT SEMANTICS, STATED ONCE AND REPRODUCED NOWHERE ELSE:
--   * An assignment is a ROW in public.vendor_product_retailer_assignments. There is at most
--     one row per (product, Retailer) FOR ALL TIME — vendor_product_retailer_assign_unique_idx
--     — so a Retailer assigned, withdrawn and re-assigned is ONE row that flipped status
--     twice, and can never be counted twice. Neither count can therefore exceed the number
--     of Retailers this Vendor manages, and history cannot inflate either one.
--   * assignment_count counts every such row, whatever its status.
--   * active_assignment_count counts the rows with status = 'ACTIVE'. This is
--     list_vendor_products()' count, reproduced predicate-for-predicate so the list and the
--     detail of the same product can never disagree.
--   * NEITHER count consults the Vendor–Retailer relationship status or the Retailer
--     organization status. An ACTIVE assignment to a SUSPENDED or DEACTIVATED Retailer still
--     counts as active. That is the shipped meaning of the number the web catalogue prints
--     today, and narrowing it here would silently change a figure an operator already reads.
--     The companion read returns relationship_status per row so a client that wants the
--     narrower figure can compute it from data it can see, rather than from a number whose
--     rule it has to guess.
--   * NEITHER count consults the PRODUCT's own status. An INACTIVE product keeps its
--     assignment rows — set_vendor_product_status deliberately does not cascade — and keeps
--     reporting them.
--   * Shops do not enter into it. Assignment is Retailer-level in this schema; there is no
--     shop-level product assignment table, so there is no shop count to report and none is
--     invented here.
--
-- NOT RETURNED, and the reason each is withheld:
--   vendor_organization_id       the caller already knows which Vendor they are; an id in a
--                                payload is one a form could echo back as authorization.
--   created_by_profile_id        the creator's identity is audit data, not product data. It
--                                is returned by nothing, anywhere.
--   assignment rows              a product's Retailer list is bounded by the Vendor's
--                                Retailer count but is not fixed-size, and a detail payload
--                                that grows with it is neither predictable nor cacheable on
--                                a mobile connection. The two counts answer the summary
--                                question; function 2 answers the inventory question.
--   any image, media or storage  no such column exists (see the header).
--     reference
--   price, incentive, reward,    no such column exists anywhere in this schema.
--     campaign, coin, payout
--   audit metadata, policy       administration and authorization internals are not display
--     fields, membership ids     data.
create function public.get_vendor_product_detail(
  p_product_id uuid
)
returns table (
  product_id              uuid,
  product_code            text,
  barcode                 text,
  product_name            text,
  brand                   text,
  description             text,
  status                  text,
  assignment_count        bigint,
  active_assignment_count bigint,
  created_at              timestamptz,
  updated_at              timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  -- Identity and Vendor, from auth.uid() alone. get_vendor_super_admin_context() accepts no
  -- arguments and evaluates the whole chain — ACTIVE profile owned by auth.uid(), ACTIVE
  -- membership, ACTIVE VENDOR organization, ACTIVE VENDOR_SUPER_ADMIN role. A signed-out
  -- caller, a Retailer Owner, a Retailer Manager, a Sales Staff member, a suspended profile
  -- and a suspended membership all resolve to zero rows here.
  --
  -- ORDER BY / LIMIT 1 reproduces the shipped multi-Vendor rule; see the header.
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  -- Fail closed, and generically. The message names no table, column, policy, Vendor or
  -- product: one refusal for "not signed in", "not a Vendor Super Admin", and "this Vendor's
  -- role does not hold PRODUCTS_READ" alike. Same wording as list_vendor_products(), so the
  -- list and the detail cannot be told apart by their denials either.
  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCTS_READ') then
    raise exception 'Not authorized to view products'
      using errcode = 'insufficient_privilege';
  end if;

  -- A null id names no row, and returning zero rows keeps it indistinguishable from every
  -- other id that names no row this caller may read.
  if p_product_id is null then
    return;
  end if;

  -- The vendor_organization_id predicate is what makes a foreign product id inert. It is
  -- compared against the Vendor derived above — never against a parameter.
  --
  -- ONE statement. Both counts come from a single lateral aggregate over an indexed range
  -- (vendor_product_assign_product_status_idx leads on vendor_product_id), so the wire
  -- carries one row rather than one row per assignment, and the assignment table is scanned
  -- once rather than twice. LEFT JOIN LATERAL keeps the product row when it has no
  -- assignments at all; count(*) over an empty set is 0, never null, so no coalesce is
  -- needed and neither count can arrive as null.
  --
  -- Row multiplicity is fixed by the primary key: the lateral returns exactly one row, so a
  -- product cannot be duplicated by its assignments and no DISTINCT is required.
  return query
  select
    vp.id,
    vp.product_code,
    vp.barcode,
    vp.product_name,
    vp.brand,
    vp.description,
    vp.status,
    ac.total_count,
    ac.active_count,
    vp.created_at,
    vp.updated_at
  from public.vendor_products vp
  left join lateral (
    select
      count(*)                                     as total_count,
      count(*) filter (where a.status = 'ACTIVE')  as active_count
    from public.vendor_product_retailer_assignments a
    where a.vendor_product_id = vp.id
  ) ac on true
  where vp.id = p_product_id
    and vp.vendor_organization_id = v_vendor;
end;
$$;

revoke all     on function public.get_vendor_product_detail(uuid) from public;
revoke execute on function public.get_vendor_product_detail(uuid) from anon;
grant  execute on function public.get_vendor_product_detail(uuid) to authenticated;


-- ============================================================================
-- FUNCTION 2 — list_vendor_product_assigned_retailers(uuid)
-- ============================================================================
-- The Retailers ONE of the calling Vendor's own products is assigned to — the companion read
-- get_vendor_product_detail() deliberately does not nest.
--
-- WHAT A ROW IS. One row per EXISTING assignment row, and nothing else. A Retailer this
-- Vendor manages but has never assigned this product to has NO row here, which is the whole
-- difference from list_vendor_product_retailer_assignments(uuid): that function LEFT JOINs
-- from vendor_retailers so an unassigned Retailer appears with assignment_status NULL,
-- because it drives an assign/withdraw matrix. This one is driven FROM the assignment table,
-- so assignment_status is NEVER null and a client never has to decide which nulls mean "not
-- assigned". The row count equals get_vendor_product_detail().assignment_count exactly.
--
-- WITHDRAWN ASSIGNMENTS ARE RETURNED, AND MARKED. Withdrawal in this schema sets status
-- 'INACTIVE' and never deletes (unassign_vendor_product_from_retailer, 20260727210000), so
-- the row is the surviving record that this product was once available at this Retailer.
-- Hiding it would make ending an assignment look like erasing one, and would leave
-- assignment_count unexplainable — it counts those rows. The client distinguishes current
-- from historical by assignment_status alone; nothing is inferred from a date.
--
-- FOUR STATUSES TRAVEL, AND THEY ARE FOUR DIFFERENT FACTS. None is derived from another and
-- none is ever mapped to a default:
--   assignment_status    'ACTIVE' | 'INACTIVE' — is this product assigned to this Retailer
--                        now. NOT NULL by the table's constraint, and NOT NULL here.
--   relationship_status  'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' — the Vendor–Retailer
--                        relationship. NULLABLE here; see the LEFT JOIN note below.
--   retailer_status      'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' — the Retailer organization
--                        itself.
--   the PRODUCT's status is not repeated per row; it is a property of the product and is
--                        returned once, by function 1.
-- An ACTIVE assignment against a SUSPENDED relationship is a real and reachable state — a
-- Vendor may suspend a relationship without withdrawing its products, and
-- unassign_vendor_product_from_retailer deliberately does not require an ACTIVE
-- relationship. Both values are returned exactly as stored so a client can render that
-- honestly instead of guessing.
--
-- NO STATUS FILTER OF ANY KIND. Every assignment row for the product is returned whatever
-- the assignment, relationship, Retailer or product status. Filtering would put this list
-- and function 1's counts in permanent disagreement, and a Vendor that could not see the
-- assignment it withdrew would have no way to review or reverse it.
--
-- WHY THE RELATIONSHIP JOIN IS A LEFT JOIN. The insert trigger
-- vendor_product_assignment_assert_link() requires a vendor_retailers row to exist when an
-- assignment is created, so in practice every row here has one. It is joined LEFT anyway:
-- an INNER join would make an assignment row VANISH from this list if its relationship row
-- ever ceased to exist, while function 1's count — taken from the assignment table alone —
-- would keep counting it. A missing relationship must surface as a null relationship_id, not
-- as a silently shorter list that contradicts the count. relationship_id and
-- relationship_status are therefore documented NULLABLE, and a client must treat a null
-- relationship_id as "not cross-linkable" rather than as an error.
--
-- WHY relationship_id IS HERE. It is the address the shipped Flutter Vendor Retailer screens
-- already use — list_vendor_retailers() and get_vendor_retailer_detail() (20260731090000)
-- both return and accept vendor_retailers.id. Returning it lets a product's assignment row
-- open the Retailer detail screen directly, which closes the two-address-space gap
-- docs/mobile-backend-contract.md § 6.8 and docs/mobile-role-flow-map.md V-15 record against
-- the existing assignment read. It is safe to return for the same reason it is safe there:
-- it names THIS Vendor's own view of one of its own Retailers, and it is matched here on
-- vendor_organization_id = the derived Vendor, so no other Vendor's relationship id can
-- appear.
--
-- WHY THE PERMISSION REQUIREMENT IS SPLIT. This read returns Retailer identity and
-- relationship state, so it requires PRODUCTS_READ *and* RETAILERS_READ. Function 1 returns
-- neither and requires only PRODUCTS_READ. Both permissions already exist and are already
-- mapped to VENDOR_SUPER_ADMIN, so no shipped caller's access changes; what the split buys
-- is that a future products-only role cannot read the Retailer directory sideways through a
-- product screen, and gains that ability by acquiring a role_permissions row rather than by
-- an edit to this file. It is deliberately NOT the PRODUCT_RETAILER_ASSIGN that the existing
-- editor read demands: requiring the permission to CHANGE assignments in order to READ them
-- is what makes that function unusable as a read contract.
--
-- SAME SELECTOR, SAME NON-LEAKING RESULT AS FUNCTION 1. An unknown, foreign or null product
-- id yields zero rows — the same answer a genuinely unassigned product of the caller's own
-- gives. That ambiguity is in the safe direction and is why a client calls the detail read
-- first: zero rows THERE is the authoritative "this product is not addressable by you".
--
-- NOT RETURNED, and the reason each is withheld:
--   the assignment row id        it identifies nothing the client can act on — every
--                                assignment write is addressed by (product id, Retailer
--                                organization id), never by this id — and relationship_id
--                                together with retailer_organization_id already key a row
--                                uniquely, since there is at most one assignment per
--                                (product, Retailer).
--   assigned_by_profile_id       who assigned it is audit data, not assignment data.
--   vendor_organization_id       the caller already knows which Vendor they are.
--   owner name, email, phone,    Retailer PERSONAL data. An assignment list needs to name an
--     any contact field          organization, never a person.
--   invitation id, token,        never returned by anything, anywhere.
--     token_hash, failure_code
--   shops, shop ids, addresses   assignment is Retailer-level in this schema; a shop is not
--                                part of this fact.
--   staff, members, receipts,    unrelated entities.
--     sales, coins, claims
--   country_code, currency,      Retailer profile fields belonging to the Retailer detail
--     created_at of the org      screen, which the client can now reach via relationship_id.
create function public.list_vendor_product_assigned_retailers(
  p_product_id uuid
)
returns table (
  relationship_id          uuid,
  retailer_organization_id uuid,
  retailer_name            text,
  retailer_status          text,
  relationship_status      text,
  assignment_status        text,
  assigned_at              timestamptz,
  assignment_updated_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor  uuid;
  v_product uuid;
begin
  select ctx.organization_id
    into v_vendor
  from public.get_vendor_super_admin_context() ctx
  order by ctx.organization_id
  limit 1;

  -- Both permissions, one refusal. The message distinguishes neither which permission was
  -- missing nor whether the caller is a Vendor at all.
  if v_vendor is null
     or not public.has_organization_permission(v_vendor, 'PRODUCTS_READ')
     or not public.has_organization_permission(v_vendor, 'RETAILERS_READ') then
    raise exception 'Not authorized to view products'
      using errcode = 'insufficient_privilege';
  end if;

  if p_product_id is null then
    return;
  end if;

  -- Ownership is proved ONCE, here, against the derived Vendor — not re-derived per row and
  -- not re-checked inside the join below. A foreign or unknown id leaves v_product null and
  -- the function returns the same empty set an unassigned product of the caller's own
  -- returns.
  select vp.id
    into v_product
  from public.vendor_products vp
  where vp.id = p_product_id
    and vp.vendor_organization_id = v_vendor;

  if v_product is null then
    return;
  end if;

  -- ONE statement, driven from the assignment table so the row set IS the assignment set.
  -- a.vendor_product_id is the leading column of vendor_product_assign_product_status_idx,
  -- so the driving scan is an index range over one product's assignments; the organizations
  -- join is on a primary key and the vendor_retailers join is on its unique pair key
  -- (vendor_retailers_unique_pair), so each contributes at most one row and no assignment can
  -- be duplicated. No aggregate, no DISTINCT, no per-row authorization.
  --
  -- Ordering is by Retailer name then Retailer organization id: deterministic and total, so
  -- a re-fetching client sees a stable sequence and two Retailers sharing a name cannot swap
  -- places between requests. Same ordering shape as list_vendor_product_retailer_assignments()
  -- and list_vendor_retailers(); the tie-break is the organization id rather than the
  -- relationship id because the latter is nullable here.
  return query
  select
    vr.id,
    o.id,
    o.name,
    o.status,
    vr.status,
    a.status,
    a.assigned_at,
    a.updated_at
  from public.vendor_product_retailer_assignments a
  join public.organizations o
    on o.id = a.retailer_organization_id
  left join public.vendor_retailers vr
    on vr.retailer_organization_id = a.retailer_organization_id
   and vr.vendor_organization_id = v_vendor
  where a.vendor_product_id = v_product
  order by o.name, o.id;
end;
$$;

revoke all     on function public.list_vendor_product_assigned_retailers(uuid) from public;
revoke execute on function public.list_vendor_product_assigned_retailers(uuid) from anon;
grant  execute on function public.list_vendor_product_assigned_retailers(uuid) to authenticated;


-- ============================================================================
-- Closing note
-- ============================================================================
-- Two read functions. Nothing else exists in this migration. No table, column, constraint,
-- index, trigger, RLS policy, role, permission or mapping is created or altered; no existing
-- function is touched; no seed row is written; and no table privilege is granted to any
-- browser role — public.vendor_products and public.vendor_product_retailer_assignments in
-- particular stay default-deny with zero policies and zero privileges for anon and
-- authenticated, exactly as 20260727090000 left them.
--
-- No index is added. Every predicate above is served by an existing one:
-- vendor_products' primary key for the detail lookup,
-- vendor_product_assign_product_status_idx (vendor_product_id, status) for both the count
-- lateral and the assignment scan, organizations' primary key for the Retailer join, and
-- vendor_retailers_unique_pair (vendor_organization_id, retailer_organization_id) for the
-- relationship join. A speculative index would be a write cost with no measured cause.
--
-- service_role is granted nothing here. Both reads derive their authority from auth.uid(),
-- which a service-role connection does not have, so granting it would produce a function
-- that can only ever refuse.
--
-- Nothing in this migration writes: there is no insert, update, delete, or audit_logs row in
-- either function, and both are declared STABLE, so neither can be used to change a product,
-- an assignment, or anything else.
