-- Migration: claim_review_filter_options
-- Purpose: Phase 1C-B follow-up. Adds ONE function and nothing else:
--            public.list_claim_review_filter_options()   [authenticated]
--
-- ============================================================================
-- THE GAP THIS CLOSES
-- ============================================================================
-- public.list_claim_review_queue accepts `p_retailer_id uuid` and `p_shop_id uuid`,
-- but its RETURN type carries only display names — there is no retailer_organization_id
-- or retailer_shop_id column. So the Web queue could parse and forward those filters,
-- yet had no way to populate a picker with the values they require: the ids simply
-- were not available to it.
--
-- ============================================================================
-- WHY A DEDICATED FUNCTION RATHER THAN WIDENING THE QUEUE
-- ============================================================================
-- Adding the two ids to every queue row would have put tenant identifiers into the
-- browser on EVERY receipt, for a need that arises once per page render. This
-- function returns them once, in the only place they are actually used, and the
-- queue's row shape stays as narrow as it was.
--
-- It also keeps the two concerns honestly separate. The queue answers "what should I
-- review next"; this answers "what may I narrow by". A change to one cannot silently
-- reshape the other.
--
-- ============================================================================
-- ELIGIBILITY IS THE QUEUE'S, EXACTLY
-- ============================================================================
-- Every predicate below is the same one list_claim_review_queue applies, in the same
-- order, for the same reason:
--
--   reviewer authorization   resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ')
--   Vendor resolution        from auth.uid(), never an argument
--   tenant link              vendor_retailers ... status = 'ACTIVE'
--   receipt status           status = 'SUBMITTED'
--   submission completeness  submitted_at is not null
--   stored object            a matching row in storage.objects
--   not already decided      no row in receipt_review_decisions
--
-- The two are deliberately NOT refactored into a shared helper. A shared SQL function
-- would have to either take the Vendor as an argument — a new executable surface that
-- bypasses the permission check, exactly the thing that must not exist — or repeat the
-- resolver anyway. Instead the duplication is pinned by tests that fail if the two
-- predicates ever disagree, so drift is loud rather than silent.
--
-- A consequence worth stating: an option only appears while at least one PENDING
-- receipt sits behind it. Decide the last receipt for a shop and that shop leaves the
-- picker, because a filter that can only ever return nothing is not a useful choice.
--
-- ============================================================================
-- WHAT IT RETURNS, AND WHAT IT REFUSES TO
-- ============================================================================
-- Exactly two identifiers — retailer_organization_id and retailer_shop_id — and they
-- are here ONLY because they are the values `list_claim_review_queue` requires as
-- filter parameters. Both name organizations and shops the reviewer is already
-- reading receipts from, neither is personal data, and the queue re-derives the
-- Vendor from auth.uid() on every call, so a forged or foreign id matches zero rows
-- rather than widening anything.
--
-- No profile id, membership id, role id, permission id or Auth id. No storage bucket,
-- object path or file hash. No email or phone. No receipt id: an option is a choice,
-- not a receipt.
--
-- Idempotency posture: plain CREATE FUNCTION (no CREATE OR REPLACE) so a conflicting
--   existing object FAILS the migration rather than being silently replaced. No table,
--   permission, role mapping, policy or trigger is created. No existing object is
--   altered. No row of business data is read for modification, written or deleted.
--   No dynamic SQL. Every reference is schema-qualified because the function runs with
--   an EMPTY search_path.
--
-- Dependencies: 20260811090000 (vendor_retailers), 20260812210000
--   (receipt_submissions), 20260818210000 (resolve_claim_reviewer_organization),
--   20260819090000 (RECEIPT_REVIEW_READ, receipt_review_decisions).


create function public.list_claim_review_filter_options()
returns table (
  retailer_organization_id uuid,
  retailer_name            text,
  retailer_shop_id         uuid,
  shop_name                text,
  shop_code                text,
  shop_status              text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  -- ------------------------------------------------------------------------
  -- Authorization — the SAME permission the queue requires, resolved the same way
  -- ------------------------------------------------------------------------
  -- RECEIPT_REVIEW_READ rather than the portal permission: a caller who may open the
  -- reviewer portal but not read receipts must not learn which Retailers have work
  -- waiting, because that is itself receipt information.
  --
  -- The function takes NO arguments at all, so there is nothing for a caller to
  -- nominate. NULL means "not a reviewer, or not one with this permission, or
  -- ambiguous" — all of which return zero rows rather than an error, so this cannot
  -- be used to probe.
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ');
  if v_vendor is null then
    return;
  end if;

  return query
  -- DISTINCT over the pair, so a Retailer with three pending receipts in one shop
  -- yields one option rather than three. The unit is the choice a reviewer makes,
  -- not the receipts behind it.
  select distinct
    ro.id,
    ro.name,
    sh.id,
    sh.name,
    sh.code,
    sh.status
  from public.receipt_submissions s
  join public.organizations ro on ro.id = s.retailer_organization_id
  join public.retailer_shops sh on sh.id = s.retailer_shop_id
  where
    -- Queue predicate 1 & 2: a submitted receipt whose upload actually landed.
    s.status = 'SUBMITTED'
    and s.submitted_at is not null

    -- Queue predicate 3: THE TENANT BOUNDARY. receipt_submissions has no Vendor
    -- column, so the only path from a receipt to a Vendor is this relationship, and
    -- it must be ACTIVE right now. Deactivate the link and its Retailer disappears
    -- from the picker at the same moment its receipts leave the queue.
    and exists (
      select 1
      from public.vendor_retailers vr
      where vr.vendor_organization_id = v_vendor
        and vr.retailer_organization_id = s.retailer_organization_id
        and vr.status = 'ACTIVE'
    )

    -- Queue predicate 4: the stored object must really exist.
    and exists (
      select 1
      from storage.objects so
      where so.bucket_id = s.storage_bucket
        and so.name = s.storage_object_path
    )

    -- Queue predicate 5: already-decided receipts leave the active queue, so they
    -- must not keep a Retailer or shop alive in the picker either.
    and not exists (
      select 1
      from public.receipt_review_decisions rd
      where rd.receipt_submission_id = s.id
    )

  -- Deliberately NOT filtered on the shop's or submitter's current status: decision
  -- D7 keeps a historical receipt reviewable when its shop or staff member has since
  -- been deactivated, so the option that reaches it must survive too. `shop_status`
  -- is returned instead, and the picker labels it.

  -- Deterministic and total. The trailing id breaks ties between two shops that share
  -- a name within one Retailer, which the schema permits (the unique index is on
  -- lower(code), not name).
  order by ro.name asc, sh.name asc, sh.id asc;
end;
$$;

revoke all     on function public.list_claim_review_filter_options() from public;
revoke execute on function public.list_claim_review_filter_options() from anon;
grant  execute on function public.list_claim_review_filter_options() to authenticated;

-- service_role is deliberately NOT granted. Nothing server-side needs this: the Web
-- proxy pattern reserved for private receipt objects has no use for a filter list,
-- and the ordinary authenticated client is the only intended caller.

comment on function public.list_claim_review_filter_options() is
  'Retailer and shop options for the Claim Review queue filters, scoped to the calling reviewer''s Vendor and to receipts currently eligible for review.';
