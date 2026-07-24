-- Migration: sales_staff_receipt_product_and_submission_reads
-- Purpose: The two reads a Sales Staff member needs to prepare and confirm a receipt
--          submission from a mobile client, and nothing else. It adds, and only adds:
--            1. The RECEIPT_PRODUCTS_READ permission, mapped to SALES_STAFF and to no
--               other role.
--            2. public.list_my_receipt_products()        [authenticated]
--            3. public.get_my_receipt_submission(uuid)   [authenticated]
--
-- THIS MIGRATION CHANGES NOTHING THAT IS ALREADY DEPLOYED. No table, column, constraint,
--   index, trigger, RLS policy, bucket, role, or existing permission mapping is created,
--   altered or dropped. No existing function is edited, dropped, or replaced. In
--   particular public.receipt_submissions is untouched: no product is attached to a
--   submission here, because receipts and products are related only in the future
--   OCR/matching step and inventing that link now would fix a shape before the
--   requirement is known.
--
-- WHY A NEW PERMISSION RATHER THAN MAPPING SALES_STAFF TO RETAILER_PRODUCTS_READ
--   RETAILER_PRODUCTS_READ already gates public.list_retailer_assigned_products()
--   (20260727210000), a DEPLOYED function that returns `description` and
--   `assignment_status` as well. Adding SALES_STAFF to that mapping would silently widen
--   that function for every Sales Staff member at once, as a side effect of a seed-data
--   change. A separate permission means the two reads can never drift into each other and
--   revoking one does not touch the other.
--
--   This is exactly the operation 20260727090000 anticipated when it excluded SALES_STAFF:
--   "A future receipt-matching operation will need its own narrowly-scoped access, and
--   giving it this broad read now would be exactly the over-exposure to avoid."
--
-- WHY NO NEW RESOLVER
--   public.resolve_retailer_member_organization(text) (20260723090000) already evaluates
--   the whole chain in SQL — ACTIVE profile owned by auth.uid(), ACTIVE membership, ACTIVE
--   RETAILER organization, ACTIVE role reached through that membership, and the named
--   permission — and fails closed when a caller resolves to zero or to more than one
--   qualifying Retailer. A second resolver would be a second definition free to drift, and
--   only one of the two could be right.
--
-- NO ROLE CODE APPEARS ANYWHERE BELOW. Which permission maps to which role is a decision
--   that lives in seed data; both functions ask the resolver, never the roles table.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   No OCR, no receipt parsing, no product or SKU matching, no reviewer queue, no approval
--   or rejection state, no incentive, campaign, reward, coin or payout object, and no
--   Vendor reporting. No receipt IMAGE read of any kind: there is still no signed-URL
--   function, no download RPC and no storage policy, and
--   docs/mobile-backend-contract.md § 7 Q1 stays open. No change to
--   public.get_my_portal_context() — RECEIPT_PRODUCTS_READ and RECEIPT_SUBMIT are both
--   mapped to SALES_STAFF alone, so the capability hint that function already returns
--   (`submit_receipts`) states both facts, and adding a key would change a deployed
--   function's output for no new information.
--
-- Idempotency posture: plain CREATE / INSERT (no IF NOT EXISTS, no CREATE OR REPLACE, no
--   ON CONFLICT). A conflicting existing object FAILS the migration. No fixed UUIDs — the
--   permission row takes the table's gen_random_uuid() default and is joined by CODE
--   below. No dynamic SQL. All identifiers are <= 63 bytes. Every reference is
--   schema-qualified because every function runs with an EMPTY search_path.
--
-- Dependencies: 20260716125559 (roles, permissions, role_permissions), 20260717094520
--   (retailer_shops), 20260723090000 (resolve_retailer_member_organization),
--   20260726090000 (receipt_submissions, the RECEIPT_SUBMIT permission),
--   20260727090000 (vendor_products, vendor_product_retailer_assignments).

-- ============================================================================
-- PART 1 — the RECEIPT_PRODUCTS_READ permission and its single role mapping
-- ============================================================================
insert into public.permissions (code, name, description, module)
values (
  'RECEIPT_PRODUCTS_READ',
  'View products for receipt submission',
  'View the active products this Vendor has assigned to your Retailer, in order to submit a receipt.',
  'RECEIPTS'
);

-- Mapped to SALES_STAFF and to nothing else, mirroring RECEIPT_SUBMIT exactly. Joined by
-- CODE rather than by a literal UUID so this migration depends on the seeded catalogue
-- rather than restating it.
--
-- A RETAILER_OWNER or RETAILER_MANAGER is deliberately NOT given this mapping: they
-- already hold RETAILER_PRODUCTS_READ and therefore already have the richer
-- list_retailer_assigned_products() read. Granting both would give them two different
-- answers to one question.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'RECEIPT_PRODUCTS_READ'
where r.code = 'SALES_STAFF';

-- ============================================================================
-- FUNCTION 1 — list_my_receipt_products()
-- ============================================================================
-- The ACTIVE products actively assigned to the calling Sales Staff member's own Retailer.
--
-- NO TENANT INPUT. Zero arguments: there is no Retailer id, membership id or profile id to
-- pass, so no URL segment, form field, header or cookie can nominate whose catalogue is
-- returned. The Retailer is derived from auth.uid() through the established resolver on
-- RECEIPT_PRODUCTS_READ — a permission mapped to SALES_STAFF alone.
--
-- UNAUTHORIZED IS AN EXCEPTION, NOT AN EMPTY LIST, matching
-- list_my_assigned_receipt_shops(). A denial and "this Retailer has no products assigned
-- yet" are different facts and a client renders them differently; collapsing them would
-- tell a staff member at a product-less Retailer that they lack permission.
--
-- BOTH SIDES MUST BE LIVE: an INACTIVE product and a withdrawn assignment are each enough
-- to hide a row. Identical to list_retailer_assigned_products(), so the two reads cannot
-- disagree about which products exist.
--
-- NOT RETURNED, and the reason each is withheld:
--   vendor_organization_id, Vendor name    the Vendor is not this caller's tenant, and
--                                          naming it would leak the supply relationship.
--   created_by_profile_id, timestamps      catalogue-administration metadata with no use
--                                          on a receipt screen.
--   assignment id, assignment_status       an assignment is a Vendor/Owner concern; a row
--                                          appearing at all already means it is ACTIVE.
--   description                            catalogue prose. product_code, barcode,
--                                          product_name and brand identify a product
--                                          completely for a submitter.
--   any other Retailer's rows              the WHERE clause is scoped to the resolved
--                                          Retailer and there is no parameter to widen it.
create function public.list_my_receipt_products()
returns table (
  product_id   uuid,
  product_code text,
  barcode      text,
  product_name text,
  brand        text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('RECEIPT_PRODUCTS_READ');

  if v_retailer is null then
    raise exception 'Not authorized to view receipt products'
      using errcode = 'insufficient_privilege';
  end if;

  -- Ordering is deterministic so a picker's option order is stable across renders and a
  -- paginated client cannot see a row twice.
  return query
  select
    vp.id,
    vp.product_code,
    vp.barcode,
    vp.product_name,
    vp.brand
  from public.vendor_product_retailer_assignments a
  join public.vendor_products vp on vp.id = a.vendor_product_id
  where a.retailer_organization_id = v_retailer
    and a.status = 'ACTIVE'
    and vp.status = 'ACTIVE'
  order by vp.product_name, vp.product_code, vp.id;
end;
$$;

revoke all     on function public.list_my_receipt_products() from public;
revoke execute on function public.list_my_receipt_products() from anon;
grant  execute on function public.list_my_receipt_products() to authenticated;

-- ============================================================================
-- FUNCTION 2 — get_my_receipt_submission(uuid)
-- ============================================================================
-- ONE of the calling staff member's OWN submissions, addressed by id.
--
-- WHY THIS EXISTS WHEN list_my_receipt_submissions() ALREADY DOES. After a submission the
-- client needs the result of THAT submission. Re-fetching the entire history to find one
-- row is wasteful on a mobile connection and grows without bound; this returns exactly the
-- row that was just created.
--
-- THE SHAPE IS DELIBERATELY IDENTICAL to list_my_receipt_submissions() — same column
-- names, same column order, same types, same withheld fields — so one client-side model
-- deserializes both, and a future column addition has to be made to both or to neither.
--
-- AN ID THAT IS NOT YOURS RETURNS ZERO ROWS, NOT AN ERROR. This is the important
-- difference from the exception raised on the authorization failure above. The caller IS
-- an authorized Sales Staff member; they have simply named a row they may not read. A
-- distinguishable refusal ("that submission exists but is not yours") would confirm the
-- existence of another person's submission, and a submission id is guessable in exactly
-- the way that matters: it is a uuid that some other client legitimately holds. "Zero
-- rows" is byte-identical for a nonexistent id, another person's id, and another
-- Retailer's id.
--
-- The predicate is the same conjunction the list applies: submitted_by_profile_id =
-- auth.uid() AND the resolved Retailer. Either alone would be sufficient today; both are
-- applied because they answer different questions — "is this mine?" and "is this the
-- Retailer I am authorized for?" — and a person may legitimately be staff at more than one
-- Retailer over time.
--
-- NO IMAGE, NO SIGNED URL, NO OBJECT PATH. storage_bucket, storage_object_path and
-- file_sha256 are withheld for the same reasons the list withholds them: a private object
-- location is not display data and would let a holder attempt a direct fetch, and the hash
-- would let one person test whether a file they hold matches a submission.
create function public.get_my_receipt_submission(
  p_submission_id uuid
)
returns table (
  submission_id      uuid,
  shop_name          text,
  shop_code          text,
  status             text,
  original_file_name text,
  mime_type          text,
  file_size_bytes    bigint,
  submitted_at       timestamptz,
  created_at         timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_retailer uuid;
begin
  v_retailer := public.resolve_retailer_member_organization('RECEIPT_SUBMIT');

  if v_retailer is null then
    raise exception 'Not authorized to view receipt submissions'
      using errcode = 'insufficient_privilege';
  end if;

  -- A null id is not an error: it names no row, and returning zero rows keeps it
  -- indistinguishable from every other id that names no row the caller may read.
  if p_submission_id is null then
    return;
  end if;

  return query
  select
    rs.id,
    s.name,
    s.code,
    rs.status,
    rs.original_file_name,
    rs.mime_type,
    rs.file_size_bytes,
    rs.submitted_at,
    rs.created_at
  from public.receipt_submissions rs
  join public.retailer_shops s on s.id = rs.retailer_shop_id
  where rs.id = p_submission_id
    and rs.submitted_by_profile_id = auth.uid()
    and rs.retailer_organization_id = v_retailer;
end;
$$;

revoke all     on function public.get_my_receipt_submission(uuid) from public;
revoke execute on function public.get_my_receipt_submission(uuid) from anon;
grant  execute on function public.get_my_receipt_submission(uuid) to authenticated;

-- ============================================================================
-- Closing note
-- ============================================================================
-- One permission, one role mapping, and two read functions. Nothing else exists in this
-- migration. No table, column, constraint, index, trigger, RLS policy, storage bucket or
-- storage policy is created or altered; no existing function is touched; no existing
-- permission mapping is changed; and no table privilege is granted to any browser role —
-- public.receipt_submissions, public.vendor_products and
-- public.vendor_product_retailer_assignments all stay default-deny with zero policies, and
-- the `receipts` bucket stays private with no storage policy at all. service_role is
-- granted neither function: both derive their authority from auth.uid(), which a
-- service-role connection does not have.
