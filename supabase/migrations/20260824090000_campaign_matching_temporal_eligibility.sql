-- Migration: campaign_matching_temporal_eligibility
-- Purpose: Phase 2A-B. Which campaigns a verified sale matched, resolved entirely
--          from history at the sale instant. Pure functions only — this migration
--          reads, and writes nothing.
--
--   Unit 66A
--     1 internal fn   campaign_versions_matching_sale(uuid)
--   Unit 66B
--     1 internal fn   campaign_sale_item_eligible_at(uuid, uuid)
--
--   0 tables. 0 RPCs. 0 permissions. 0 grants. 0 evidence writes.
--
-- ============================================================================
-- WHY THIS MIGRATION WRITES NOTHING
-- ============================================================================
-- Migration 65 owns the evidence tables and enforces, at the table, that an
-- evaluation carries exact item evidence, that its lineage matches the authoritative
-- sale, that the receipt has a complete finalized item set, and that no active
-- exclusion exists. Those rules run for every writer.
--
-- This migration supplies the ANSWER those writers need — which campaign versions a
-- sale matched — and deliberately does not persist it. Keeping it pure means the
-- resolver can be called twice, compared against stored evidence, and used to refuse a
-- conflicting recalculation, all without a transaction that has to be undone. The
-- writer arrives later, in one transaction that can satisfy Migration 65's deferred
-- completeness triggers in the only order they permit: envelope, items, reward.
--
-- ============================================================================
-- EVERY TEMPORAL QUESTION IS ASKED AT verified_sales.sale_at
-- ============================================================================
-- Never now(), never current_timestamp, never the upload, confirmation, review or
-- evaluation time, and never current campaign state. sale_at is the only instant that
-- makes a re-evaluation reproduce a historical answer, and it is already proven rather
-- than merely stored: verified_sales_assert_lineage recomputes it through
-- resolve_sale_instant and refuses a row whose sale_at was invented.
--
-- The three helpers that read now() — campaign_derived_state,
-- campaign_product_eligibility_as_of — are correct for the screens they were written
-- for and are NOT used here.
--
-- ============================================================================
-- WHY campaign_versions_in_force_for_retailer_at IS NOT THE RESOLVER
-- ============================================================================
-- That helper answers a narrower question and has two properties this one cannot
-- inherit, both verified against its deployed definition rather than assumed:
--
--   1. IT DOES NOT FILTER BY VENDOR. Its predicate names no vendor column at all. A
--      second Vendor whose campaign targets the same Retailer would be returned for
--      this Vendor's sale. Migration 65's insert assertion would ultimately refuse
--      such evidence, but only after a reward had been computed from it.
--
--   2. IT HAS NO ORDER BY. Its row order is whatever the planner emits, which cannot
--      support the approved exclusive tie-break.
--
-- It is left untouched — the Staff-facing surface depends on it. This function reads
-- the same authoritative sources directly and adds what a reward needs.
--
-- ============================================================================
-- WHAT "IN FORCE" MEANS, AND WHY OMISSION IS NOT THE SAME AS NOT_EVALUABLE
-- ============================================================================
-- campaign_version_status_history is a timeline PER CAMPAIGN, not per version: its
-- no-overlap trigger compares on campaign_id using a half-open '[)' range, and
-- campaign_version_status_history_open_idx is UNIQUE on (campaign_id) WHERE valid_to
-- IS NULL. So at any instant a campaign has AT MOST ONE covering interval, naming
-- exactly one version and one lifecycle status. A republish closes the old interval
-- and opens a new one sharing the same boundary, which is why an old sale still
-- resolves to the version that was genuinely in force then rather than to whatever
-- campaigns.published_version_id happens to point at today.
--
-- That gives three distinct answers, and collapsing any two of them would lose
-- information a reward decision depends on:
--
--   * The covering interval names THIS version and it was PUBLISHED
--       -> CANDIDATE.
--
--   * The covering interval names ANOTHER version, or names this one while PAUSED or
--     CANCELLED
--       -> OMITTED. The history is complete and the answer is a definite no. Saying so
--          for every campaign a Vendor ever ran would grow evidence without bound to
--          record something nobody asks for.
--
--   * There is NO covering interval
--       -> NOT_EVALUABLE / NO_TEMPORAL_RECORD, returned as a row. Silence here is
--          indistinguishable from "no such campaign", and this system refuses rather
--          than guesses. Reachable for any sale predating the status-history backfill.
--
-- ============================================================================
-- WHAT THIS FUNCTION DELIBERATELY DOES NOT CHECK
-- ============================================================================
-- No product eligibility (Unit 66B). No multi-item aggregation and no exclusive winner
-- selection (Unit 66C). No reward arithmetic, cap or accumulator (Migration 67). No
-- permission check and no application exposure (Migration 68).
--
-- It also does not consult receipt_has_finalized_sale_items or
-- receipt_qualification_is_excluded. Those are WRITE gates: Migration 65 enforces both
-- on every evidence insert, and the evaluator RPC will enforce them before writing.
-- Keeping them out of a pure resolver means "which campaigns would this sale have
-- matched?" stays answerable as a diagnostic question — including for a receipt that
-- was later excluded — without ever becoming a path to paying one.
--
-- Current account state is never consulted. A departed Sales Staff member, a
-- deactivated Retailer and a suspended relationship all leave a historical sale's
-- campaign match exactly as it was.


create function public.campaign_versions_matching_sale(
  p_verified_sale_id uuid
)
returns table (
  campaign_id                    uuid,
  campaign_version_id            uuid,
  vendor_organization_id         uuid,
  retailer_organization_id       uuid,
  retailer_shop_id               uuid,
  beneficiary_profile_id         uuid,
  sale_at                        timestamptz,
  performance_scope              text,
  reward_recipient_scope         text,
  product_scope                  text,
  product_eligibility_resolution text,
  stacking_mode                  text,
  exclusivity_key                text,
  priority                       integer,
  campaign_starts_at             timestamptz,
  campaign_ends_at               timestamptz,
  candidate_result               text,
  candidate_reason               text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sale public.verified_sales%rowtype;
  v_sub  public.receipt_submissions%rowtype;
begin
  -- ---- AUTHORITATIVE LINEAGE, DERIVED AND NEVER SUPPLIED ---------------------
  -- The caller passes one sale id. Vendor, Retailer, shop, beneficiary and the sale
  -- instant are all read from the authoritative rows, so a caller cannot widen its own
  -- match by asserting a different tenant.
  --
  -- Broken lineage RAISES rather than returning NOT_EVALUABLE. NOT_EVALUABLE means
  -- "the history does not record this"; a sale whose receipt is missing or whose
  -- tenants contradict each other is not an unknown, it is a corrupt input, and
  -- recording it as evidence would be recording a falsehood.
  if p_verified_sale_id is null then
    raise exception 'A verified sale id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_sale
  from public.verified_sales v
  where v.id = p_verified_sale_id;

  if v_sale.id is null then
    raise exception 'That authoritative sale does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  select * into v_sub
  from public.receipt_submissions s
  where s.id = v_sale.receipt_submission_id;

  if v_sub.id is null then
    raise exception 'That authoritative sale has no receipt submission'
      using errcode = 'foreign_key_violation';
  end if;

  -- verified_sales carries no seller column, deliberately: the submitter already has
  -- exactly one answer and a second copy is what drifts. The beneficiary is therefore
  -- always read from here.
  if v_sub.submitted_by_profile_id is null then
    raise exception 'That authoritative sale has no resolvable beneficiary'
      using errcode = 'foreign_key_violation';
  end if;

  if v_sub.retailer_organization_id is distinct from v_sale.retailer_organization_id
     or v_sub.retailer_shop_id is distinct from v_sale.retailer_shop_id then
    raise exception 'That authoritative sale contradicts its receipt''s Retailer or shop'
      using errcode = 'check_violation';
  end if;

  if v_sale.sale_at is null or v_sale.vendor_organization_id is null then
    raise exception 'That authoritative sale has incomplete lineage'
      using errcode = 'check_violation';
  end if;

  return query
  -- ---- THE RELEVANT UNIVERSE: non-temporal facts only ------------------------
  -- Column names are prefixed so no bare identifier collides with an OUT parameter of
  -- the same name inside WHERE or ORDER BY.
  with relevant as (
    select
      c.id                              as r_campaign_id,
      cv.id                             as r_version_id,
      c.vendor_organization_id          as r_vendor_id,
      cv.performance_scope              as r_performance_scope,
      cv.reward_recipient_scope         as r_recipient_scope,
      cv.product_scope                  as r_product_scope,
      cv.product_eligibility_resolution as r_resolution,
      cv.stacking_mode                  as r_stacking_mode,
      cv.exclusivity_key                as r_exclusivity_key,
      cv.priority                       as r_priority,
      cv.starts_at                      as r_starts_at,
      cv.ends_at                        as r_ends_at
    from public.campaign_eligible_retailers er
    join public.campaign_versions cv on cv.id = er.campaign_version_id
    join public.campaigns c          on c.id  = cv.campaign_id
    -- THE FROZEN TARGETING SNAPSHOT. campaign_eligible_retailers is written once at
    -- publication and guarded against UPDATE and DELETE, with ALL_RETAILERS, direct
    -- selection and group membership already flattened into it. So a later group edit,
    -- Retailer deactivation or suspended relationship cannot rewrite what a published
    -- version targeted. Targeting is never LIVE_TEMPORAL, and the shop plays no part:
    -- no campaign table carries a shop column.
    where er.retailer_organization_id = v_sale.retailer_organization_id
      -- THE VENDOR BOUNDARY, supplied here because the shipped in-force helper has none.
      and c.vendor_organization_id = v_sale.vendor_organization_id
      -- A draft was never in force. Publication is also what creates the snapshot row
      -- joined above, so this is belt-and-braces rather than the only guard.
      and cv.published_at is not null
      -- THE CAMPAIGN PERIOD, half-open [starts_at, ends_at), matching every deployed
      -- resolver: a sale exactly at starts_at is inside, one exactly at ends_at is not,
      -- and a null ends_at is open-ended.
      and cv.starts_at <= v_sale.sale_at
      and (cv.ends_at is null or v_sale.sale_at < cv.ends_at)
  ),
  -- ---- THE HISTORICAL VERDICT ------------------------------------------------
  -- One covering interval per campaign at most, so this LATERAL returns zero or one
  -- row. LIMIT 1 is safe rather than arbitrary: the no-overlap trigger, the unique
  -- open-interval index and the valid_to > valid_from CHECK together make two covering
  -- intervals unrepresentable.
  judged as (
    select
      r.*,
      st.h_version_id,
      st.h_in_force
    from relevant r
    left join lateral (
      select h.campaign_version_id as h_version_id,
             h.is_version_in_force as h_in_force
      from public.campaign_version_status_history h
      where h.campaign_id = r.r_campaign_id
        and h.valid_from <= v_sale.sale_at
        and (h.valid_to is null or v_sale.sale_at < h.valid_to)
      limit 1
    ) st on true
  )
  select
    j.r_campaign_id,
    j.r_version_id,
    j.r_vendor_id,
    v_sale.retailer_organization_id,
    v_sale.retailer_shop_id,
    v_sub.submitted_by_profile_id,
    v_sale.sale_at,
    j.r_performance_scope,
    j.r_recipient_scope,
    j.r_product_scope,
    j.r_resolution,
    j.r_stacking_mode,
    j.r_exclusivity_key,
    j.r_priority,
    j.r_starts_at,
    j.r_ends_at,
    case when j.h_version_id is null then 'NOT_EVALUABLE' else 'CANDIDATE' end,
    case when j.h_version_id is null then 'NO_TEMPORAL_RECORD' else null end
  from judged j
  where
    -- No covering interval at all: unknown, and said so rather than guessed.
    j.h_version_id is null
    -- Or the interval proves THIS version was the one in force, and in force means
    -- PUBLISHED: is_version_in_force is a stored generated column defined exactly as
    -- (lifecycle_status = 'PUBLISHED'), so PAUSED and CANCELLED are excluded by it.
    or (j.h_version_id = j.r_version_id and j.h_in_force)
  -- ---- DETERMINISTIC TOTAL ORDER ---------------------------------------------
  -- The approved exclusive tie-break: highest priority, then earliest campaign start,
  -- then lowest version id. All three columns are immutable on campaign_versions, and
  -- the third is a uuid, so the order is total and no tie can survive. Applied here so
  -- repeated calls are byte-equivalent; Unit 66C selects the winner.
  order by j.r_priority desc, j.r_starts_at asc, j.r_version_id asc;
end;
$$;

-- Internal only, matching every other helper in this schema: PostgreSQL grants EXECUTE
-- on a new function to PUBLIC by default, and this one reads across every tenant.
revoke all     on function public.campaign_versions_matching_sale(uuid) from public;
revoke execute on function public.campaign_versions_matching_sale(uuid) from anon;
revoke execute on function public.campaign_versions_matching_sale(uuid) from authenticated;
revoke execute on function public.campaign_versions_matching_sale(uuid) from service_role;

comment on function public.campaign_versions_matching_sale(uuid) is
  'Resolves the campaign versions one authoritative verified sale matched, entirely from history at verified_sales.sale_at. Derives all lineage from the sale id and raises on contradictory lineage. Returns CANDIDATE for a version the per-campaign status timeline proves was in force and PUBLISHED, and NOT_EVALUABLE / NO_TEMPORAL_RECORD where no covering interval exists; definite non-matches are omitted. Ordered by priority desc, campaign start asc, version id asc. Performs no writes and checks no product eligibility, receipt finalization or qualification exclusion.';


-- ============================================================================
-- UNIT 66B — PRODUCT ELIGIBILITY AT THE SALE INSTANT
-- ============================================================================
-- Unit 66A answered which campaign versions a sale matched. This answers, for ONE of
-- those versions and ONE authoritative sale item, whether that item's product was
-- eligible — and it answers it the way the campaign version itself declares.
--
-- ============================================================================
-- TWO RESOLUTIONS, AND WHY THE DISPATCH IS ON THE DECLARED MODE
-- ============================================================================
-- campaign_versions_resolution_matches_scope makes the pairing an equivalence:
-- SELECTED_PRODUCTS is always SNAPSHOT and ALL_ELIGIBLE_PRODUCTS is always
-- LIVE_TEMPORAL. So the dispatch reads product_eligibility_resolution and nothing else.
--
-- It must NEVER be inferred from whether campaign_eligible_products has rows.
-- publish_vendor_campaign writes that table ONLY for SELECTED_PRODUCTS, so a
-- LIVE_TEMPORAL version legitimately has none, and "no snapshot rows" would be read as
-- "nothing eligible" — silently disqualifying every item of every open-scope campaign.
--
--   SNAPSHOT       frozen membership in campaign_eligible_products decides, full stop.
--                  No temporal call is made, so later product deactivation, assignment
--                  removal, transfer, archival, rename or code change cannot disturb a
--                  historical match. The two sale-time status columns stay NULL because
--                  no such check happened, and Migration 65's
--                  campaign_sale_item_qualifications_live_evidence_paired CHECK enforces
--                  exactly that pairing at the table.
--
--   LIVE_TEMPORAL  the assignment timeline AND the product-status timeline are both
--                  resolved at verified_sales.sale_at, and both must say ACTIVE.
--
-- ============================================================================
-- WHY THE TWO COMPOSITE HELPERS ARE NOT USED
-- ============================================================================
-- Both were written for display surfaces and are wrong for a reward decision. Verified
-- against their deployed definitions, not assumed:
--
--   vendor_retailer_eligible_products_at  resolves the ASSIGNMENT axis temporally but
--     reads vp.status from the CURRENT vendor_products row — its own comment calls this
--     "the non-temporal product-status axis". Deactivating a product today would
--     retroactively disqualify a sale from last month.
--
--   vendor_product_eligible_for_retailer_at  wraps the assignment resolver in
--     coalesce(... = 'ACTIVE', false), collapsing NULL into false. That destroys the one
--     distinction this function exists to preserve: "explicitly ineligible" versus "the
--     history does not say".
--
-- So the two SAFE primitives are composed directly. Each returns NULL when no interval
-- covers the instant, and NULL is propagated as NOT_EVALUABLE rather than guessed.
--
-- ============================================================================
-- MISSING HISTORY OUTRANKS A PARTIAL ANSWER
-- ============================================================================
-- If either axis is unknown, the result is NOT_EVALUABLE — even when the other axis is
-- explicitly INACTIVE and would have produced NOT_ELIGIBLE anyway. The answers happen to
-- coincide today, but they are different claims: one says the product was not eligible,
-- the other says we cannot know. A reward engine that treats the second as the first has
-- guessed, and the guess is invisible afterwards.
--
-- ============================================================================
-- WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
-- ============================================================================
-- No campaign candidacy — Unit 66A owns that, and this function does not re-check
-- campaign status, period or Retailer targeting. No multi-item aggregation and no
-- exclusivity winner (Unit 66C). No reward arithmetic (Migration 67). No permission or
-- application exposure (Migration 68). No write of any kind. No current account state.


create function public.campaign_sale_item_eligible_at(
  p_campaign_version_id   uuid,
  p_verified_sale_item_id uuid
)
returns table (
  campaign_version_id       uuid,
  verified_sale_item_id     uuid,
  verified_sale_id          uuid,
  vendor_product_id         uuid,
  qualifying_units          integer,
  product_source            text,
  product_status_at_sale    text,
  assignment_status_at_sale text,
  eligibility_result        text,
  eligibility_reason        text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item       public.verified_sale_items%rowtype;
  v_sale       public.verified_sales%rowtype;
  v_version    public.campaign_versions%rowtype;
  v_campaign   public.campaigns%rowtype;
  v_product    public.vendor_products%rowtype;
  v_assignment text;
  v_status     text;
  v_in_snap    boolean;
begin
  -- ---- AUTHORITATIVE LINEAGE, DERIVED AND NEVER SUPPLIED ---------------------
  -- Broken lineage RAISES. NOT_EVALUABLE means "the history does not record this"; a
  -- sale item whose Vendor contradicts its sale is not an unknown, it is a corrupt
  -- input, and answering it at all would launder the contradiction into evidence.
  if p_campaign_version_id is null then
    raise exception 'A campaign version id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_verified_sale_item_id is null then
    raise exception 'A verified sale item id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_item
  from public.verified_sale_items i
  where i.id = p_verified_sale_item_id;

  if v_item.id is null then
    raise exception 'That authoritative sale item does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  select * into v_sale
  from public.verified_sales v
  where v.id = v_item.verified_sale_id;

  if v_sale.id is null then
    raise exception 'That authoritative sale item has no verified sale'
      using errcode = 'foreign_key_violation';
  end if;

  select * into v_version
  from public.campaign_versions cv
  where cv.id = p_campaign_version_id;

  if v_version.id is null then
    raise exception 'That campaign version does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  select * into v_campaign
  from public.campaigns c
  where c.id = v_version.campaign_id;

  -- THE VENDOR BOUNDARY, three ways. Unit 66A applies it to campaign candidacy; this
  -- applies it to the item and the product, so a caller cannot pair a foreign campaign,
  -- a foreign item or a foreign product with this sale.
  if v_campaign.vendor_organization_id is distinct from v_sale.vendor_organization_id then
    raise exception 'That campaign belongs to a different Vendor than the sale'
      using errcode = 'check_violation';
  end if;

  if v_item.vendor_organization_id is distinct from v_sale.vendor_organization_id then
    raise exception 'That sale item belongs to a different Vendor than the sale'
      using errcode = 'check_violation';
  end if;

  select * into v_product
  from public.vendor_products vp
  where vp.id = v_item.vendor_product_id;

  if v_product.id is null then
    raise exception 'That sale item has no vendor product'
      using errcode = 'foreign_key_violation';
  end if;

  if v_product.vendor_organization_id is distinct from v_sale.vendor_organization_id then
    raise exception 'That product belongs to a different Vendor than the sale'
      using errcode = 'check_violation';
  end if;

  -- The scope/resolution equivalence is enforced on campaign_versions, so a row that
  -- violates it cannot exist. Asserted anyway: the dispatch below is a two-way branch,
  -- and a third state would silently fall through it.
  if not ((v_version.product_scope = 'SELECTED_PRODUCTS'
             and v_version.product_eligibility_resolution = 'SNAPSHOT')
       or (v_version.product_scope = 'ALL_ELIGIBLE_PRODUCTS'
             and v_version.product_eligibility_resolution = 'LIVE_TEMPORAL')) then
    raise exception 'That campaign version has an unsupported product scope and resolution combination'
      using errcode = 'check_violation';
  end if;

  -- verified_sale_items_quantity_range already bounds this to 1..100 and the column is
  -- NOT NULL, so this can only fire if that contract is ever relaxed.
  if v_item.quantity is null or v_item.quantity < 1 then
    raise exception 'That authoritative sale item has no usable quantity'
      using errcode = 'check_violation';
  end if;

  if v_sale.sale_at is null or v_sale.retailer_organization_id is null then
    raise exception 'That authoritative sale has incomplete lineage'
      using errcode = 'check_violation';
  end if;

  -- Every returned row carries the same derived identity.
  campaign_version_id   := v_version.id;
  verified_sale_item_id := v_item.id;
  verified_sale_id      := v_sale.id;
  vendor_product_id     := v_item.vendor_product_id;

  -- ---- SNAPSHOT --------------------------------------------------------------
  if v_version.product_eligibility_resolution = 'SNAPSHOT' then
    product_source            := 'SNAPSHOT';
    -- No temporal check happened, so no temporal evidence is reported. Migration 65's
    -- live_evidence_paired CHECK refuses a SNAPSHOT row that claims otherwise.
    product_status_at_sale    := null;
    assignment_status_at_sale := null;

    -- The frozen publication set, keyed by this sale's own Retailer. Publication
    -- validated product status and assignment at that moment and froze the result; this
    -- reads the result and nothing else.
    select exists (
      select 1
      from public.campaign_eligible_products ep
      where ep.campaign_version_id      = v_version.id
        and ep.retailer_organization_id = v_sale.retailer_organization_id
        and ep.vendor_product_id        = v_item.vendor_product_id
    ) into v_in_snap;

    if v_in_snap then
      qualifying_units   := v_item.quantity;
      eligibility_result := 'ELIGIBLE';
      eligibility_reason := null;
    else
      qualifying_units   := 0;
      eligibility_result := 'NOT_ELIGIBLE';
      eligibility_reason := 'PRODUCT_NOT_ELIGIBLE';
    end if;

    return next;
    return;
  end if;

  -- ---- LIVE_TEMPORAL ---------------------------------------------------------
  -- Both axes resolved independently at the sale instant, using the primitives that
  -- return NULL for "no covering interval" rather than collapsing it to false.
  product_source := 'LIVE_TEMPORAL';

  v_assignment := public.vendor_product_assignment_state_at(
                    v_item.vendor_product_id,
                    v_sale.retailer_organization_id,
                    v_sale.sale_at);

  v_status := public.vendor_product_status_at(
                v_item.vendor_product_id,
                v_sale.sale_at);

  -- Recorded even when the answer is no, so the evidence explains itself. NULL here
  -- means the timeline had nothing to say, which is exactly what the next branch acts on.
  assignment_status_at_sale := v_assignment;
  product_status_at_sale    := v_status;

  -- MISSING HISTORY OUTRANKS EXPLICIT INACTIVITY. Checked first and on either axis, so
  -- an unknown assignment paired with an explicitly INACTIVE product still reports
  -- NOT_EVALUABLE rather than the confident-sounding NOT_ELIGIBLE.
  if v_assignment is null or v_status is null then
    qualifying_units   := 0;
    eligibility_result := 'NOT_EVALUABLE';
    eligibility_reason := 'NO_TEMPORAL_RECORD';
    return next;
    return;
  end if;

  if v_assignment = 'ACTIVE' and v_status = 'ACTIVE' then
    qualifying_units   := v_item.quantity;
    eligibility_result := 'ELIGIBLE';
    eligibility_reason := null;
  else
    qualifying_units   := 0;
    eligibility_result := 'NOT_ELIGIBLE';
    eligibility_reason := 'PRODUCT_NOT_ELIGIBLE';
  end if;

  return next;
  return;
end;
$$;

-- Internal only, for the same reason as every other helper here: PostgreSQL grants
-- EXECUTE on a new function to PUBLIC by default, and this one reads across tenants.
revoke all     on function public.campaign_sale_item_eligible_at(uuid, uuid) from public;
revoke execute on function public.campaign_sale_item_eligible_at(uuid, uuid) from anon;
revoke execute on function public.campaign_sale_item_eligible_at(uuid, uuid) from authenticated;
revoke execute on function public.campaign_sale_item_eligible_at(uuid, uuid) from service_role;

comment on function public.campaign_sale_item_eligible_at(uuid, uuid) is
  'Resolves whether one authoritative sale item was eligible for one campaign version, at verified_sales.sale_at. Dispatches on the version''s declared product_eligibility_resolution, never on whether snapshot rows exist: SNAPSHOT reads frozen campaign_eligible_products membership and reports NULL temporal evidence; LIVE_TEMPORAL composes vendor_product_assignment_state_at and vendor_product_status_at directly and requires both ACTIVE. Missing history on either axis yields NOT_EVALUABLE / NO_TEMPORAL_RECORD in preference to an explicit NOT_ELIGIBLE. Derives all lineage from the two ids and raises on contradictory lineage. Performs no writes and resolves no campaign candidacy.';
