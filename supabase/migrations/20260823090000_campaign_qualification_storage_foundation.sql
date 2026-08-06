-- Migration: campaign_qualification_storage_foundation
-- Purpose: Phase 2A-A. The STORAGE FOUNDATION for campaign qualification and
--          reward evidence. Tables, constraints, guards, indexes and posture —
--          and deliberately no matching, no arithmetic and no RPC.
--
--   3 evidence tables  campaign_sale_evaluations        (append-only)
--                      campaign_sale_item_qualifications (append-only)
--                      campaign_rewards                 (append-only)
--   1 derived cache    campaign_subject_accumulators    (mutable by design)
--   9 guards           3 x change guard, 3 x truncate guard, 3 x insert assertion
--   1 helper           campaign_evaluation_has_complete_items (fail-closed, internal)
--   2 constraint trgs  DEFERRABLE INITIALLY DEFERRED complete-item-evidence checks
--   1 maintenance      set_updated_at on the accumulator
--  15 indexes          incl. 4 uniqueness keys and 1 partial exclusivity index
--
--   0 RPCs. 0 permissions. 0 role grants. 0 RLS policies. 0 grants to anon,
--   authenticated or service_role. No coin, ledger, balance or payout object.
--
-- ============================================================================
-- WHAT THIS MIGRATION IS, AND WHAT THE NEXT ONE IS
-- ============================================================================
-- This migration decides WHERE a qualification and a reward are written, WHAT
-- shape they may take, and WHICH shapes are impossible. It decides nothing about
-- which campaign matches a sale, how many coins that is worth, or who may ask.
--
-- The separation is deliberate. Every rule this file encodes is a CONSTRAINT or a
-- TRIGGER — true for every writer, including the next migration, including a
-- future one nobody has written yet, and including a direct INSERT by the table
-- owner. Rules that live only in an RPC are true only for callers of that RPC.
-- So the invariants go in first, alone, and the matching logic arrives in a later
-- migration that cannot violate them.
--
-- ============================================================================
-- WHY THERE ARE THREE EVIDENCE TABLES AND NOT ONE
-- ============================================================================
-- A sale is finalized ATOMICALLY: finalize_claim_receipt_sale_items writes the
-- ACCEPTED decision and EVERY proposal line in one transaction, and
-- receipt_has_finalized_sale_items asserts the bijection. There is no such thing
-- as a partially finalized sale. So the (campaign version, sale) pair is the
-- natural transaction boundary, and campaign_sale_evaluations is one row per pair
-- — written whether the sale qualified or not, because "this campaign was
-- considered and said no, for this reason" is the answer a Sales Staff member
-- will eventually ask for, and an absent row cannot distinguish "said no" from
-- "was never asked".
--
-- Product scope and quantity, however, are per ITEM. campaign_sale_item_
-- qualifications carries the per-item detail and the eligibility evidence that
-- admitted each item, so a qualification can be re-checked years later without
-- re-deriving anything.
--
-- campaign_rewards is separate from both because a QUALIFIED evaluation and a
-- PAID reward are different facts. Locked decision 6 makes that concrete: when a
-- cap is exhausted the qualification is entirely real and the reward is zero.
-- Collapsing the two would make that state unrepresentable, and it is a state
-- this system will genuinely reach.
--
-- ============================================================================
-- WHY THESE ROWS COPY VALUES THAT COULD BE JOINED
-- ============================================================================
-- verified_sales deliberately has NO seller column, and its migration explains
-- why: the seller already has exactly one answer in receipt_submissions, and "a
-- second answer is exactly what drifts".
--
-- This migration copies beneficiary_profile_id, sale_at, the tenant ids and the
-- whole campaign-version configuration into its rows anyway. That is a departure,
-- and it is justified by a different requirement rather than by preference:
-- reward evidence must stay readable and re-checkable on its own terms, after the
-- campaign version it came from has been superseded and after the staff member
-- has left. What makes the copy safe is that it is not TRUSTED — every copied
-- value is proven equal to its authoritative source by the insert assertions
-- below, on every insert, for every writer. A copy that is asserted cannot drift;
-- a copy that is merely written can. The verified_sales objection applies to the
-- second kind.
--
-- ============================================================================
-- THE OWNER-LEVEL INCOMPLETE-DECISION LIMITATION
-- ============================================================================
-- receipt_product_review_decisions_assert_decision() cannot check that authoritative
-- items exist: verified_sale_items has a foreign key TO the decision, so the
-- decision row must be inserted first. Item completeness is verified only inside
-- finalize_claim_receipt_sale_items, which a direct writer bypasses. A row reading
-- decision = 'ACCEPTED' therefore does NOT mean the sale has a complete item set.
--
-- receipt_has_finalized_sale_items() is the function that fails closed: it requires
-- an ACCEPTED decision AND at least one item AND item count = proposal line count
-- AND a bijection between them. But it is a STABLE read function, not a constraint,
-- so nothing forces a reader to call it.
--
-- Both insert assertions in this file call it. decision = 'ACCEPTED' is never
-- treated as sufficient anywhere in this migration, and a direct insert against an
-- incomplete ACCEPTED decision is refused by the table.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
-- No campaign matching. No reward calculation. No cap arithmetic. No accumulator
-- update logic. No evaluation, read or write RPC. No permission and no role grant.
-- No coin, ledger, balance or payout table. No Web UI and no Flutter. No change to
-- campaigns, campaign_versions, campaign_rules, campaign_rule_tiers, verified_sales,
-- verified_sale_items, receipt_product_review_decisions or receipt_qualification_events.


-- ============================================================================
-- PART 1 — campaign_sale_evaluations
-- ============================================================================
-- One row per (campaign version, verified sale). The envelope: what was considered,
-- what was decided, and — when the answer was no — why.
create table public.campaign_sale_evaluations (
  id uuid primary key default gen_random_uuid(),

  -- ---- Campaign lineage ----------------------------------------------------
  -- The VERSION is the authoritative configuration, not the campaign: versions are
  -- immutable and undeletable, so a row pointing at one can never be reinterpreted
  -- by a later edit. campaign_id is carried alongside for reporting and is asserted
  -- to be the version's own campaign.
  campaign_id uuid not null
    references public.campaigns (id) on delete restrict,
  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete restrict,

  -- ---- Sale lineage --------------------------------------------------------
  verified_sale_id uuid not null
    references public.verified_sales (id) on delete restrict,
  receipt_submission_id uuid not null
    references public.receipt_submissions (id) on delete restrict,

  -- ---- Tenant lineage ------------------------------------------------------
  vendor_organization_id uuid not null
    references public.organizations (id) on delete restrict,
  retailer_organization_id uuid not null
    references public.organizations (id) on delete restrict,
  retailer_shop_id uuid not null
    references public.retailer_shops (id) on delete restrict,

  -- The Sales Staff member who submitted the receipt. RESTRICT, never CASCADE:
  -- locked decision 7 says a departed member's historical rewards still exist, so
  -- the profile row must survive as long as the evidence referencing it does.
  beneficiary_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  -- ---- The instant every temporal question is asked at ----------------------
  -- Copied from verified_sales.sale_at, which was itself proven against
  -- resolve_sale_instant by verified_sales_assert_lineage. Never now(), never the
  -- upload, confirmation, review or decision time: those are operational timestamps
  -- and would let queue latency change what somebody is paid.
  sale_at timestamptz not null,

  -- ---- The campaign version's configuration, frozen into the row ------------
  -- Asserted equal to the version on insert. Present so the evidence explains
  -- itself without joining a table whose meaning a reader would have to reconstruct.
  performance_scope text not null,
  reward_recipient_scope text not null,
  product_scope text not null,
  product_eligibility_resolution text not null,
  stacking_mode text not null,
  exclusivity_key text,

  -- ---- The approved total ordering, stored not computed ---------------------
  -- Locked decision 1: highest priority, then earliest campaign_starts_at, then
  -- lowest campaign_version_id. All three components live here so the ordering that
  -- selected a winner is reproducible from the evidence alone, years later, without
  -- reading campaign_versions. THE SELECTION QUERY ITSELF IS NOT IN THIS MIGRATION.
  priority integer not null,
  campaign_starts_at timestamptz not null,

  -- ---- The finding ---------------------------------------------------------
  --   QUALIFIED      this campaign version applies and produced qualifying items
  --   NOT_QUALIFIED  it was evaluated and the answer is no
  --   NOT_EVALUABLE  it could not be decided, because an authoritative record is
  --                  absent. NULL from a temporal resolver means "we do not know",
  --                  and this system refuses rather than guessing.
  outcome text not null,
  non_qualification_reason text,

  qualifying_item_count integer not null default 0,
  qualifying_units integer not null default 0,

  evaluated_at timestamptz not null default now(),
  evaluated_by_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  created_at timestamptz not null default now(),

  constraint campaign_sale_evaluations_outcome_allowed
    check (outcome = any (array['QUALIFIED'::text, 'NOT_QUALIFIED'::text, 'NOT_EVALUABLE'::text])),

  -- The closed reason vocabulary. Deliberately a fixed list rather than free text:
  -- a reason a screen must render, a report must group by and an operator must act
  -- on is a value, not prose.
  --
  -- EXCLUDED is reserved and, as this migration stands, UNREACHABLE for a stored
  -- row: the insert assertion refuses any evidence for a receipt carrying an active
  -- exclusion, so an excluded receipt produces no evaluation row at all rather than
  -- one saying EXCLUDED. The token exists so the vocabulary is complete for the
  -- matching migration and so nothing has to widen this CHECK to say the obvious.
  constraint campaign_sale_evaluations_reason_allowed
    check (non_qualification_reason is null or non_qualification_reason = any (array[
      'NO_QUALIFYING_ITEMS'::text,
      'CAMPAIGN_NOT_IN_FORCE'::text,
      'RETAILER_NOT_TARGETED'::text,
      'PRODUCT_NOT_ELIGIBLE'::text,
      'NO_TEMPORAL_RECORD'::text,
      'EXCLUDED'::text,
      'SUPPRESSED_BY_EXCLUSIVITY'::text
    ])),

  -- Stated as an equivalence so neither direction can drift: a QUALIFIED row with a
  -- stray reason is refused just as firmly as a NOT_QUALIFIED row without one.
  constraint campaign_sale_evaluations_reason_paired
    check ((outcome = 'QUALIFIED') = (non_qualification_reason is null)),

  -- A QUALIFIED evaluation qualified SOMETHING; a refusal counted nothing. Without
  -- this, "qualified with zero units" and "not qualified with three units" are both
  -- storable, and both are incoherent.
  constraint campaign_sale_evaluations_counts_match_outcome
    check (
      (outcome = 'QUALIFIED' and qualifying_item_count >= 1 and qualifying_units >= 1)
      or
      (outcome <> 'QUALIFIED' and qualifying_item_count = 0 and qualifying_units = 0)
    ),

  -- Ceilings from the deployed sale shape: verified_sale_items allows 1..50 lines
  -- (verified_sale_items_line_number_range) each of 1..100 units
  -- (verified_sale_items_quantity_range), so 50 lines and 5000 units bound any one
  -- sale. A larger value did not come from a sale.
  constraint campaign_sale_evaluations_item_count_range
    check (qualifying_item_count >= 0 and qualifying_item_count <= 50),
  constraint campaign_sale_evaluations_units_range
    check (qualifying_units >= 0 and qualifying_units <= 5000),
  constraint campaign_sale_evaluations_units_cover_items
    check (qualifying_units >= qualifying_item_count),

  -- The copied vocabularies, repeated verbatim from campaign_versions. Repeated
  -- rather than referenced because this row must remain interpretable on its own.
  constraint campaign_sale_evaluations_performance_allowed
    check (performance_scope = any (array['INDIVIDUAL_STAFF'::text, 'RETAILER_TEAM'::text])),
  constraint campaign_sale_evaluations_recipient_allowed
    check (reward_recipient_scope = any (array['CONTRIBUTING_STAFF'::text])),
  constraint campaign_sale_evaluations_product_scope_allowed
    check (product_scope = any (array['ALL_ELIGIBLE_PRODUCTS'::text, 'SELECTED_PRODUCTS'::text])),
  constraint campaign_sale_evaluations_resolution_allowed
    check (product_eligibility_resolution = any (array['SNAPSHOT'::text, 'LIVE_TEMPORAL'::text])),

  -- The same equivalence campaign_versions_resolution_matches_scope enforces
  -- upstream. Enforced again here so a hand-written row cannot record a combination
  -- the campaign schema forbids.
  constraint campaign_sale_evaluations_resolution_matches_scope
    check ((product_scope = 'SELECTED_PRODUCTS') = (product_eligibility_resolution = 'SNAPSHOT')),

  constraint campaign_sale_evaluations_stacking_allowed
    check (stacking_mode = any (array['STACKABLE'::text, 'EXCLUSIVE'::text])),
  constraint campaign_sale_evaluations_exclusivity_paired
    check ((stacking_mode = 'EXCLUSIVE') = (exclusivity_key is not null)),
  constraint campaign_sale_evaluations_exclusivity_key_shape
    check (exclusivity_key is null or (
      exclusivity_key = upper(btrim(exclusivity_key))
      and length(exclusivity_key) >= 1 and length(exclusivity_key) <= 64
      and (exclusivity_key collate "C") ~ '^[A-Z0-9][A-Z0-9 ._-]*$'
      and exclusivity_key !~ '  ')),

  constraint campaign_sale_evaluations_priority_range
    check (priority >= 0 and priority <= 1000),

  constraint campaign_sale_evaluations_evaluated_at_sane
    check (evaluated_at >= created_at - interval '1 minute'
       and evaluated_at <= created_at + interval '1 minute')
);

-- ---- Uniqueness ------------------------------------------------------------
-- One evaluation per campaign version per sale. This is the idempotency key: a
-- re-evaluation that would write a second row is refused by the table, so locked
-- decision 5 (idempotent same-result only) does not depend on the evaluator
-- checking first.
create unique index campaign_sale_evaluations_version_sale_unique_idx
  on public.campaign_sale_evaluations (campaign_version_id, verified_sale_id);

-- ---- THE EXCLUSIVITY GUARANTEE ---------------------------------------------
-- Locked decision 2: exclusivity applies per complete verified sale, per
-- exclusivity_key. One sale may therefore pay at most ONE campaign within a key.
--
-- This is a partial unique index rather than a rule in the evaluator because the
-- two are not equivalent. An evaluator that computes the winner correctly produces
-- the right answer; an index makes the WRONG answer unstorable. Double payment
-- within an exclusivity group is the failure that would be discovered last and
-- cost the most, so it is made structurally impossible rather than merely avoided.
--
-- Scoped to qualified rows: several campaigns in one key may each record a
-- NOT_QUALIFIED / SUPPRESSED_BY_EXCLUSIVITY row for the same sale, which is exactly
-- the audit trail explaining why the loser lost.
create unique index campaign_sale_evaluations_exclusivity_unique_idx
  on public.campaign_sale_evaluations (verified_sale_id, exclusivity_key)
  where exclusivity_key is not null and outcome = 'QUALIFIED';

-- ---- Read paths ------------------------------------------------------------
-- "Why did this sale earn nothing?" — every campaign considered, one lookup.
create index campaign_sale_evaluations_sale_idx
  on public.campaign_sale_evaluations (verified_sale_id);

-- Vendor reporting over an evaluation window.
create index campaign_sale_evaluations_vendor_evaluated_idx
  on public.campaign_sale_evaluations (vendor_organization_id, evaluated_at desc);

-- Campaign-level reporting, and the anti-join the matching migration needs to find
-- sales a given version has not yet been evaluated against.
create index campaign_sale_evaluations_version_idx
  on public.campaign_sale_evaluations (campaign_version_id, evaluated_at desc);

-- The receipt is the identifier every claim-review screen already holds.
create index campaign_sale_evaluations_submission_idx
  on public.campaign_sale_evaluations (receipt_submission_id);


-- ============================================================================
-- PART 2 — campaign_sale_item_qualifications
-- ============================================================================
-- One row per qualifying authoritative sale item, under one evaluation. Only
-- qualifying items are recorded: a non-qualifying item's reason belongs to the
-- envelope, and writing a row per (campaign x item x reason) would multiply storage
-- by the campaign count to say something the envelope already says.
create table public.campaign_sale_item_qualifications (
  id uuid primary key default gen_random_uuid(),

  campaign_sale_evaluation_id uuid not null
    references public.campaign_sale_evaluations (id) on delete restrict,

  -- Denormalized from the evaluation and asserted equal to it. Present so an item
  -- row can be filtered by campaign or sale without a join.
  campaign_id uuid not null
    references public.campaigns (id) on delete restrict,
  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete restrict,
  verified_sale_id uuid not null
    references public.verified_sales (id) on delete restrict,

  verified_sale_item_id uuid not null
    references public.verified_sale_items (id) on delete restrict,

  -- The product IDENTITY, and the only product column here. verified_sale_items
  -- already froze product_code_at_proposal, product_name_at_proposal,
  -- barcode_at_proposal and brand_at_proposal at proposal time, byte-for-byte, and
  -- verified_sale_items_assert_item proves the copy. Copying them again would create
  -- a second frozen answer to a question that already has one, and eligibility was
  -- never matched on any of them — it was matched on this uuid.
  vendor_product_id uuid not null
    references public.vendor_products (id) on delete restrict,

  qualifying_units integer not null,

  -- ---- Which rule admitted this item, and the evidence for it ---------------
  --   SNAPSHOT       the frozen campaign_eligible_products set decided
  --   LIVE_TEMPORAL  the assignment and status timelines at sale_at decided
  product_source text not null,

  -- Resolved ONLY under LIVE_TEMPORAL, and NULL under SNAPSHOT. That asymmetry is
  -- locked decision 4 made structural: a SNAPSHOT campaign does not consult product
  -- status or assignment at sale time at all, because the snapshot was validated at
  -- publish and frozen. Recording a sale-time status for a SNAPSHOT row would imply
  -- a check that never happened, and a later reader would believe it.
  product_status_at_sale text,
  assignment_status_at_sale text,

  created_at timestamptz not null default now(),

  constraint campaign_sale_item_qualifications_source_allowed
    check (product_source = any (array['SNAPSHOT'::text, 'LIVE_TEMPORAL'::text])),

  constraint campaign_sale_item_qualifications_status_allowed
    check (product_status_at_sale is null
       or product_status_at_sale = any (array['ACTIVE'::text, 'INACTIVE'::text])),
  constraint campaign_sale_item_qualifications_assignment_allowed
    check (assignment_status_at_sale is null
       or assignment_status_at_sale = any (array['ACTIVE'::text, 'INACTIVE'::text])),

  constraint campaign_sale_item_qualifications_live_evidence_paired
    check ((product_source = 'LIVE_TEMPORAL') = (product_status_at_sale is not null)),
  constraint campaign_sale_item_qualifications_live_assignment_paired
    check ((product_source = 'LIVE_TEMPORAL') = (assignment_status_at_sale is not null)),

  -- A LIVE_TEMPORAL item that qualified was ACTIVE and assigned at sale_at. Storing
  -- a qualifying item alongside evidence that it was ineligible would be a row that
  -- contradicts itself.
  constraint campaign_sale_item_qualifications_live_must_be_active
    check (product_source <> 'LIVE_TEMPORAL'
       or (product_status_at_sale = 'ACTIVE' and assignment_status_at_sale = 'ACTIVE')),

  -- The deployed per-line bound: verified_sale_items_quantity_range is 1..100.
  constraint campaign_sale_item_qualifications_units_range
    check (qualifying_units >= 1 and qualifying_units <= 100)
);

-- One qualification per campaign version per item. With the deployed
-- verified_sale_items_product_unique_idx (verified_sale_id, vendor_product_id), this
-- is what makes "one sale item counted twice for the same campaign" impossible.
create unique index campaign_sale_item_qualifications_version_item_unique_idx
  on public.campaign_sale_item_qualifications (campaign_version_id, verified_sale_item_id);

-- The evaluation's own item list — the dominant read.
create index campaign_sale_item_qualifications_evaluation_idx
  on public.campaign_sale_item_qualifications (campaign_sale_evaluation_id);

-- Per-product campaign performance reporting.
create index campaign_sale_item_qualifications_product_idx
  on public.campaign_sale_item_qualifications (campaign_version_id, vendor_product_id);

-- Reaching every campaign that counted a given sale's items.
create index campaign_sale_item_qualifications_sale_idx
  on public.campaign_sale_item_qualifications (verified_sale_id);


-- ============================================================================
-- PART 3 — campaign_rewards
-- ============================================================================
-- One row per (campaign version, sale, beneficiary). What was actually earned, and
-- the complete rule evidence explaining the number.
create table public.campaign_rewards (
  id uuid primary key default gen_random_uuid(),

  campaign_sale_evaluation_id uuid not null
    references public.campaign_sale_evaluations (id) on delete restrict,

  campaign_id uuid not null
    references public.campaigns (id) on delete restrict,
  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete restrict,
  verified_sale_id uuid not null
    references public.verified_sales (id) on delete restrict,
  receipt_submission_id uuid not null
    references public.receipt_submissions (id) on delete restrict,

  vendor_organization_id uuid not null
    references public.organizations (id) on delete restrict,
  retailer_organization_id uuid not null
    references public.organizations (id) on delete restrict,
  retailer_shop_id uuid not null
    references public.retailer_shops (id) on delete restrict,

  -- reward_recipient_scope admits CONTRIBUTING_STAFF alone, so the beneficiary is
  -- always the Sales Staff member who submitted the receipt — including under
  -- performance_scope = 'RETAILER_TEAM', where locked decision 3 pays the crossing
  -- sale's own submitter the full bonus once. RETAILER_TEAM changes what is COUNTED,
  -- never who is PAID.
  beneficiary_profile_id uuid not null
    references public.profiles (id) on delete restrict,

  -- ---- Cap subject ---------------------------------------------------------
  -- The subject max_reward_coins is measured against. Not a foreign key: it is a
  -- profile under INDIVIDUAL_STAFF and an organization under RETAILER_TEAM, and a
  -- polymorphic FK would be a lie in one of the two cases. The CHECK below binds it
  -- to a column that IS a foreign key, which gives the same guarantee honestly.
  performance_scope text not null,
  cap_subject_type text not null,
  cap_subject_id uuid not null,

  -- ---- The rule, copied from the immutable campaign version -----------------
  -- Asserted equal to campaign_rules / campaign_rule_tiers on insert. Versions are
  -- immutable so a join would be safe today; copying keeps the row auditable on its
  -- own and survives any later relaxation of that immutability.
  rule_type text not null,
  metric_type text not null,
  coins_per_unit bigint,
  threshold_units integer,
  configured_reward_coins bigint,
  max_reward_coins bigint,

  -- ---- The arithmetic, recorded in full -------------------------------------
  --   units_counted   what this sale contributed
  --   coins_uncapped  what the rule alone produced
  --   coins_capped_to the ceiling remaining headroom allowed, or NULL if no cap bit
  --   reward_coins    the authoritative payable amount
  --
  -- Locked decision 6: a partial award is legal, and reward_coins may be 0 when the
  -- qualification is real and the cap is exhausted. Keeping coins_uncapped alongside
  -- reward_coins is what lets a screen explain the shortfall instead of a staff
  -- member discovering an unexplained number.
  units_counted integer not null,
  coins_uncapped bigint not null,
  coins_capped_to bigint,
  reward_coins bigint not null,

  awarded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- ---- Vocabularies --------------------------------------------------------
  constraint campaign_rewards_performance_allowed
    check (performance_scope = any (array['INDIVIDUAL_STAFF'::text, 'RETAILER_TEAM'::text])),
  constraint campaign_rewards_cap_subject_allowed
    check (cap_subject_type = any (array['SALES_STAFF_PROFILE'::text, 'RETAILER_ORGANIZATION'::text])),

  -- The subject is DERIVED from the scope, never chosen. Binding cap_subject_id to
  -- a column that is itself a RESTRICT foreign key recovers the referential
  -- guarantee the polymorphic column cannot carry.
  constraint campaign_rewards_cap_subject_matches_scope
    check (
      (performance_scope = 'INDIVIDUAL_STAFF'
        and cap_subject_type = 'SALES_STAFF_PROFILE'
        and cap_subject_id = beneficiary_profile_id)
      or
      (performance_scope = 'RETAILER_TEAM'
        and cap_subject_type = 'RETAILER_ORGANIZATION'
        and cap_subject_id = retailer_organization_id)
    ),

  constraint campaign_rewards_rule_type_allowed
    check (rule_type = any (array['PER_UNIT_COINS'::text, 'TARGET_BONUS'::text])),
  constraint campaign_rewards_metric_allowed
    check (metric_type = any (array['UNITS_SOLD'::text])),

  -- The typed half of the rule, mirroring campaign_rules_rate_paired. PER_UNIT_COINS
  -- carries a rate and no tier; TARGET_BONUS carries a tier and no rate.
  constraint campaign_rewards_rate_paired
    check ((rule_type = 'PER_UNIT_COINS') = (coins_per_unit is not null)),
  constraint campaign_rewards_tier_paired
    check ((rule_type = 'TARGET_BONUS') = (threshold_units is not null)),
  constraint campaign_rewards_tier_reward_paired
    check ((rule_type = 'TARGET_BONUS') = (configured_reward_coins is not null)),

  -- ---- The deployed campaign-rule bounds, repeated ---------------------------
  -- Identical to campaign_rules_rate_within_ceiling, campaign_rules_cap_within_ceiling
  -- and campaign_rule_tiers_reward_within_ceiling. Repeated so a reward row cannot
  -- record a rate the campaign schema would have refused.
  constraint campaign_rewards_rate_range
    check (coins_per_unit is null or (coins_per_unit >= 1 and coins_per_unit <= 1000000000)),
  constraint campaign_rewards_configured_reward_range
    check (configured_reward_coins is null
       or (configured_reward_coins >= 1 and configured_reward_coins <= 1000000000)),
  constraint campaign_rewards_cap_range
    check (max_reward_coins is null
       or (max_reward_coins >= 1 and max_reward_coins <= 1000000000)),
  constraint campaign_rewards_threshold_positive
    check (threshold_units is null or threshold_units >= 1),

  -- ---- Arithmetic bounds ----------------------------------------------------
  -- units_counted is what THIS sale contributed, so it is bounded by one sale:
  -- 50 lines x 100 units = 5000. The uncapped ceiling follows directly —
  -- 1,000,000,000 coins/unit x 5,000 units = 5e12, far inside bigint (9.223e18), so
  -- no reward arithmetic this schema permits can overflow.
  constraint campaign_rewards_units_range
    check (units_counted >= 1 and units_counted <= 5000),
  constraint campaign_rewards_uncapped_range
    check (coins_uncapped >= 0 and coins_uncapped <= 5000000000000),

  -- ---- THE ROW'S OWN ARITHMETIC MUST BE TRUE OF ITSELF ----------------------
  -- Without these, a reward could record 1 unit at a rate of 5 and an uncapped
  -- amount of 999,999. Every value needed to check that is already in the row, so
  -- the contradiction is refusable here and nothing about it needs the evaluator's
  -- cooperation. This is deliberately NOT a reward calculation: it constrains what
  -- a stored row may claim, and computes nothing.
  --
  -- Overflow is unreachable rather than merely unlikely. coins_per_unit is bounded
  -- to 1e9 by campaign_rewards_rate_range and units_counted to 5000, so the largest
  -- product this CHECK can evaluate is 5e12 — inside both the uncapped ceiling above
  -- and bigint's 9.223e18. PostgreSQL raises 22003 on bigint overflow rather than
  -- wrapping, so even an unreachable case fails loudly instead of silently.
  constraint campaign_rewards_uncapped_matches_rate
    check (rule_type <> 'PER_UNIT_COINS'
       or coins_uncapped = coins_per_unit * units_counted::bigint),

  -- A TARGET_BONUS row IS the one threshold-crossing award, so its uncapped amount
  -- is the configured bonus exactly. Sales before and after the crossing produce no
  -- reward row at all; they are not recorded as a zero-coin award.
  constraint campaign_rewards_uncapped_matches_tier
    check (rule_type <> 'TARGET_BONUS'
       or coins_uncapped = configured_reward_coins),

  -- A reward is never negative, and never more than the rule produced.
  constraint campaign_rewards_reward_non_negative
    check (reward_coins >= 0),
  constraint campaign_rewards_reward_within_uncapped
    check (reward_coins <= coins_uncapped),

  -- coins_capped_to exists only where a cap exists, and is only recorded when it
  -- actually bit. A capped_to that is not below the uncapped amount records a cap
  -- that changed nothing, which is indistinguishable from no cap and so is refused.
  constraint campaign_rewards_capped_requires_cap
    check (coins_capped_to is null or max_reward_coins is not null),
  constraint campaign_rewards_capped_range
    check (coins_capped_to is null
       or (coins_capped_to >= 0 and coins_capped_to < coins_uncapped)),
  constraint campaign_rewards_capped_within_cap
    check (coins_capped_to is null or coins_capped_to <= max_reward_coins),

  -- The single arithmetic identity this table exists to keep true.
  constraint campaign_rewards_reward_is_derived
    check (reward_coins = coalesce(coins_capped_to, coins_uncapped)),

  -- No cap can ever be exceeded, whatever the evaluator computed.
  constraint campaign_rewards_reward_within_cap
    check (max_reward_coins is null or reward_coins <= max_reward_coins),

  constraint campaign_rewards_awarded_at_sane
    check (awarded_at >= created_at - interval '1 minute'
       and awarded_at <= created_at + interval '1 minute')
);

-- One reward per campaign version per sale per beneficiary.
create unique index campaign_rewards_version_sale_beneficiary_unique_idx
  on public.campaign_rewards (campaign_version_id, verified_sale_id, beneficiary_profile_id);

-- A staff member's own earnings, newest first.
create index campaign_rewards_beneficiary_awarded_idx
  on public.campaign_rewards (beneficiary_profile_id, awarded_at desc);

-- Cap reconstruction: sum reward_coins per subject and compare with the accumulator.
create index campaign_rewards_version_subject_idx
  on public.campaign_rewards (campaign_version_id, cap_subject_id);

-- The evaluation's reward, and the anti-join a later ledger uses to find unposted
-- rewards without adding a column to this table.
create index campaign_rewards_evaluation_idx
  on public.campaign_rewards (campaign_sale_evaluation_id);

-- Vendor-side financial reporting.
create index campaign_rewards_vendor_awarded_idx
  on public.campaign_rewards (vendor_organization_id, awarded_at desc);

-- Reaching a reward from the receipt a reviewer is looking at.
create index campaign_rewards_submission_idx
  on public.campaign_rewards (receipt_submission_id);


-- ============================================================================
-- PART 4 — campaign_subject_accumulators
-- ============================================================================
-- THE ONLY MUTABLE TABLE IN THIS MIGRATION, AND THE ONLY ONE THAT IS NOT EVIDENCE.
--
-- It exists because two of the deployed reward semantics are not computable from a
-- single sale. campaign_rules.max_reward_coins applies PER SUBJECT across the whole
-- campaign period, and TARGET_BONUS pays when CUMULATIVE units cross
-- threshold_units. Both need a running total, and both need it read and written
-- under one lock so two concurrent evaluations for the same subject cannot each
-- believe there is headroom.
--
-- The subject granularity is deliberate and was settled before this milestone: a
-- campaign-wide budget was rejected because it would serialize every evaluation of a
-- campaign across all Retailers, making the reward a race the first receipt verified
-- wins. One row per (version, subject) serializes exactly as far as correctness
-- requires and no further.
--
-- ============================================================================
-- THIS TABLE IS A CACHE. IT MUST ALWAYS BE RECONSTRUCTIBLE.
-- ============================================================================
-- Both totals are derivable from immutable rows, and those identities are the thing
-- that keeps this table honest. THE TWO TOTALS DO NOT COME FROM THE SAME TABLE, and
-- getting that wrong is the easiest mistake available here:
--
--   units_counted_total  =  sum(campaign_sale_evaluations.qualifying_units)
--                           where outcome = 'QUALIFIED' and qualifying_units > 0
--                           for the same campaign_version_id and cap subject
--
--   coins_awarded_total  =  sum(campaign_rewards.reward_coins)
--                           for the same campaign_version_id and cap subject
--
--   target_bonus_awarded =  exists(campaign_rewards where rule_type = 'TARGET_BONUS')
--                           for that version and subject
--
-- WHY UNITS COME FROM EVALUATIONS AND COINS COME FROM REWARDS.
-- Under TARGET_BONUS a reward row exists ONLY for the sale that crosses the threshold.
-- Every qualifying sale before it contributes units towards that threshold and creates
-- no reward row at all. Summing campaign_rewards.units_counted would therefore
-- understate the total by every pre-crossing sale — a campaign with three qualifying
-- sales of 3, 4 and 3 units reconstructs as 3 instead of 10, and the threshold could
-- never be shown to have been reached. campaign_sale_evaluations is the record of what
-- was COUNTED; campaign_rewards is the record of what was PAID. The accumulator needs
-- one of each.
--
-- The equality asserted by campaign_rewards_assert_reward — units_counted equals the
-- evaluation's qualifying_units — is what keeps the two consistent wherever a reward
-- does exist, so neither source can drift from the other.
--
-- THE CAP SUBJECT IS DERIVED, NOT STORED, ON AN EVALUATION.
-- campaign_sale_evaluations carries no cap_subject columns, so a reconstruction reads
-- it from performance_scope exactly as campaign_rewards_cap_subject_matches_scope does:
--
--   INDIVIDUAL_STAFF -> ('SALES_STAFF_PROFILE',   beneficiary_profile_id)
--   RETAILER_TEAM    -> ('RETAILER_ORGANIZATION', retailer_organization_id)
--
-- If this table is ever lost, corrupted or found to disagree, the evidence tables
-- are authoritative and it is rebuilt from them — never the other way round. It must
-- never be read as proof that somebody was paid; campaign_rewards is that proof.
-- The suite asserts both identities, including the TARGET_BONUS case where the two
-- sources genuinely disagree, so a future writer that reconstructs units from the
-- wrong table is caught.
--
-- NO UPDATE LOGIC IS INSTALLED HERE. This migration creates the shape and the
-- constraints; the maintenance belongs with the arithmetic, in a later migration.
create table public.campaign_subject_accumulators (
  campaign_version_id uuid not null
    references public.campaign_versions (id) on delete restrict,

  -- Polymorphic for the same reason as campaign_rewards.cap_subject_id, and left
  -- without a foreign key for the same honesty. The reward rows that feed a given
  -- accumulator each carry the CHECK binding the subject to a real FK column.
  cap_subject_type text not null,
  cap_subject_id uuid not null,

  units_counted_total bigint not null default 0,
  coins_awarded_total bigint not null default 0,

  -- TARGET_BONUS pays once per subject per campaign version. This is the flag that
  -- makes "once" cheap to enforce under the subject lock rather than a scan.
  target_bonus_awarded boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The lock target and the uniqueness guarantee in one object.
  constraint campaign_subject_accumulators_pkey
    primary key (campaign_version_id, cap_subject_type, cap_subject_id),

  constraint campaign_subject_accumulators_subject_allowed
    check (cap_subject_type = any (array['SALES_STAFF_PROFILE'::text, 'RETAILER_ORGANIZATION'::text])),

  -- A running total that has gone negative is a maintenance bug, and it must be
  -- caught at the write that caused it rather than at the reward it later distorts.
  constraint campaign_subject_accumulators_units_non_negative
    check (units_counted_total >= 0),
  constraint campaign_subject_accumulators_coins_non_negative
    check (coins_awarded_total >= 0),

  -- The same overflow reasoning as campaign_rewards, extended across a campaign:
  -- the ceiling is well inside bigint and a total beyond it is arithmetic that has
  -- already gone wrong.
  constraint campaign_subject_accumulators_coins_ceiling
    check (coins_awarded_total <= 1000000000000000)
);

-- Finding every campaign a subject has accumulated against — the read a staff
-- earnings summary and a Retailer progress view both need.
create index campaign_subject_accumulators_subject_idx
  on public.campaign_subject_accumulators (cap_subject_type, cap_subject_id);

create trigger set_updated_at_on_campaign_subject_accumulators
  before update on public.campaign_subject_accumulators
  for each row execute function public.set_updated_at();


-- ============================================================================
-- PART 5 — immutability guards
-- ============================================================================
-- Matching verified_sales_guard_change / verified_sales_guard_truncate exactly.
-- TRUNCATE needs its own STATEMENT-level trigger: row triggers do not fire on
-- TRUNCATE, so a row-level guard alone would never see it — the same gap
-- audit_logs_guard_truncate and verified_sale_items_guard_truncate exist to close.

create function public.campaign_sale_evaluations_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A campaign sale evaluation is immutable; it cannot be edited or deleted'
    using errcode = 'check_violation';
end;
$$;

create trigger campaign_sale_evaluations_guard_change
  before update or delete on public.campaign_sale_evaluations
  for each row execute function public.campaign_sale_evaluations_guard_change();

create function public.campaign_sale_evaluations_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Campaign sale evaluations are append-only and cannot be truncated'
    using errcode = 'check_violation';
end;
$$;

create trigger campaign_sale_evaluations_guard_truncate
  before truncate on public.campaign_sale_evaluations
  for each statement execute function public.campaign_sale_evaluations_guard_truncate();


create function public.campaign_sale_item_qualifications_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A campaign sale item qualification is immutable; it cannot be edited or deleted'
    using errcode = 'check_violation';
end;
$$;

create trigger campaign_sale_item_qualifications_guard_change
  before update or delete on public.campaign_sale_item_qualifications
  for each row execute function public.campaign_sale_item_qualifications_guard_change();

create function public.campaign_sale_item_qualifications_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Campaign sale item qualifications are append-only and cannot be truncated'
    using errcode = 'check_violation';
end;
$$;

create trigger campaign_sale_item_qualifications_guard_truncate
  before truncate on public.campaign_sale_item_qualifications
  for each statement execute function public.campaign_sale_item_qualifications_guard_truncate();


create function public.campaign_rewards_guard_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'A campaign reward is immutable; it cannot be edited or deleted'
    using errcode = 'check_violation';
end;
$$;

create trigger campaign_rewards_guard_change
  before update or delete on public.campaign_rewards
  for each row execute function public.campaign_rewards_guard_change();

create function public.campaign_rewards_guard_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Campaign rewards are append-only and cannot be truncated'
    using errcode = 'check_violation';
end;
$$;

create trigger campaign_rewards_guard_truncate
  before truncate on public.campaign_rewards
  for each statement execute function public.campaign_rewards_guard_truncate();


-- ============================================================================
-- PART 6 — insert assertions
-- ============================================================================
-- Every copied value is proven equal to its authoritative source, and every gate is
-- re-checked at the last possible moment. These run for EVERY writer — the matching
-- migration that does not exist yet, and a direct INSERT by the table owner alike.

create function public.campaign_sale_evaluations_assert_evaluation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale       public.verified_sales%rowtype;
  v_submission public.receipt_submissions%rowtype;
  v_version    public.campaign_versions%rowtype;
  v_campaign   public.campaigns%rowtype;
begin
  -- ---- 1. The sale, and that it is the submission's own sale ----------------
  select * into v_sale
  from public.verified_sales v
  where v.id = new.verified_sale_id;

  if v_sale.id is null then
    raise exception 'A campaign sale evaluation requires an existing authoritative sale'
      using errcode = 'foreign_key_violation';
  end if;

  if v_sale.receipt_submission_id is distinct from new.receipt_submission_id then
    raise exception 'A campaign sale evaluation must name the sale''s own receipt'
      using errcode = 'check_violation';
  end if;

  -- ---- 2. Tenant lineage, taken from the sale and never from the row --------
  if v_sale.vendor_organization_id   is distinct from new.vendor_organization_id
     or v_sale.retailer_organization_id is distinct from new.retailer_organization_id
     or v_sale.retailer_shop_id         is distinct from new.retailer_shop_id then
    raise exception 'A campaign sale evaluation must copy the sale''s own Vendor, Retailer and shop'
      using errcode = 'check_violation';
  end if;

  -- ---- 3. The sale instant, byte for byte -----------------------------------
  -- verified_sales_assert_lineage already proved sale_at against resolve_sale_instant.
  -- This proves the evaluation did not invent a different one.
  if new.sale_at is distinct from v_sale.sale_at then
    raise exception 'A campaign sale evaluation must copy the sale''s own instant'
      using errcode = 'check_violation';
  end if;

  -- ---- 4. The beneficiary is the SUBMITTER, not a claim ---------------------
  select * into v_submission
  from public.receipt_submissions s
  where s.id = new.receipt_submission_id;

  if v_submission.id is null then
    raise exception 'A campaign sale evaluation requires an existing receipt submission'
      using errcode = 'foreign_key_violation';
  end if;

  if v_submission.submitted_by_profile_id is distinct from new.beneficiary_profile_id then
    raise exception 'A campaign sale evaluation beneficiary must be the receipt submitter'
      using errcode = 'check_violation';
  end if;

  if v_submission.retailer_organization_id is distinct from new.retailer_organization_id
     or v_submission.retailer_shop_id      is distinct from new.retailer_shop_id then
    raise exception 'A campaign sale evaluation must copy the receipt''s own Retailer and shop'
      using errcode = 'check_violation';
  end if;

  -- ---- 5. Campaign lineage --------------------------------------------------
  select * into v_version
  from public.campaign_versions cv
  where cv.id = new.campaign_version_id;

  if v_version.id is null then
    raise exception 'A campaign sale evaluation requires an existing campaign version'
      using errcode = 'foreign_key_violation';
  end if;

  if v_version.campaign_id is distinct from new.campaign_id then
    raise exception 'A campaign sale evaluation must name the version''s own campaign'
      using errcode = 'check_violation';
  end if;

  -- A draft was never in force, so it can never have been evaluated against.
  if v_version.published_at is null then
    raise exception 'A campaign sale evaluation requires a published campaign version'
      using errcode = 'check_violation';
  end if;

  select * into v_campaign
  from public.campaigns c
  where c.id = new.campaign_id;

  -- THE TENANT BOUNDARY. campaign_versions_in_force_for_retailer_at answers by
  -- Retailer and does not filter by Vendor, so a second Vendor targeting the same
  -- Retailer would otherwise have its campaigns evaluated against this Vendor's sale.
  if v_campaign.vendor_organization_id is distinct from new.vendor_organization_id then
    raise exception 'A campaign sale evaluation must belong to the sale''s own Vendor'
      using errcode = 'check_violation';
  end if;

  -- ---- 6. The frozen configuration matches the immutable version -------------
  if v_version.performance_scope             is distinct from new.performance_scope
     or v_version.reward_recipient_scope     is distinct from new.reward_recipient_scope
     or v_version.product_scope              is distinct from new.product_scope
     or v_version.product_eligibility_resolution
                                             is distinct from new.product_eligibility_resolution
     or v_version.stacking_mode              is distinct from new.stacking_mode
     or v_version.exclusivity_key            is distinct from new.exclusivity_key
     or v_version.priority                   is distinct from new.priority
     or v_version.starts_at                  is distinct from new.campaign_starts_at then
    raise exception 'A campaign sale evaluation must copy its campaign version''s configuration exactly'
      using errcode = 'check_violation';
  end if;

  -- ---- 7. THE COMPLETENESS GATE ---------------------------------------------
  -- decision = 'ACCEPTED' is NOT sufficient and is never consulted directly. The
  -- owner-level limitation described in this file's header is closed here: an
  -- ACCEPTED decision carrying no items, or a subset of them, fails this check.
  if not public.receipt_has_finalized_sale_items(new.receipt_submission_id) then
    raise exception 'A campaign sale evaluation requires a receipt with a complete finalized item set'
      using errcode = 'check_violation';
  end if;

  -- ---- 8. Fail closed --------------------------------------------------------
  if public.receipt_qualification_is_excluded(new.receipt_submission_id) then
    raise exception 'An excluded receipt cannot be evaluated for campaign qualification'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger campaign_sale_evaluations_assert_evaluation
  before insert on public.campaign_sale_evaluations
  for each row execute function public.campaign_sale_evaluations_assert_evaluation();


create function public.campaign_sale_item_qualifications_assert_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eval public.campaign_sale_evaluations%rowtype;
  v_item public.verified_sale_items%rowtype;
begin
  select * into v_eval
  from public.campaign_sale_evaluations e
  where e.id = new.campaign_sale_evaluation_id;

  if v_eval.id is null then
    raise exception 'A campaign sale item qualification requires an existing evaluation'
      using errcode = 'foreign_key_violation';
  end if;

  -- Only a QUALIFIED evaluation has qualifying items. Anything else is a row that
  -- contradicts its own envelope.
  if v_eval.outcome <> 'QUALIFIED' then
    raise exception 'A campaign sale item qualification requires a QUALIFIED evaluation'
      using errcode = 'check_violation';
  end if;

  if v_eval.campaign_id         is distinct from new.campaign_id
     or v_eval.campaign_version_id is distinct from new.campaign_version_id
     or v_eval.verified_sale_id   is distinct from new.verified_sale_id then
    raise exception 'A campaign sale item qualification must copy its evaluation''s campaign and sale'
      using errcode = 'check_violation';
  end if;

  -- ---- The item belongs to the evaluation's own sale -------------------------
  select * into v_item
  from public.verified_sale_items i
  where i.id = new.verified_sale_item_id;

  if v_item.id is null then
    raise exception 'A campaign sale item qualification requires an existing authoritative sale item'
      using errcode = 'foreign_key_violation';
  end if;

  if v_item.verified_sale_id is distinct from v_eval.verified_sale_id then
    raise exception 'A campaign sale item qualification must name an item of the evaluated sale'
      using errcode = 'check_violation';
  end if;

  if v_item.vendor_product_id is distinct from new.vendor_product_id then
    raise exception 'A campaign sale item qualification must copy the item''s own product'
      using errcode = 'check_violation';
  end if;

  if v_item.vendor_organization_id is distinct from v_eval.vendor_organization_id then
    raise exception 'A campaign sale item qualification must stay within the evaluation''s Vendor'
      using errcode = 'check_violation';
  end if;

  -- Units are the item's own quantity. An evaluator cannot count a line twice, and
  -- cannot count part of one.
  if new.qualifying_units is distinct from v_item.quantity then
    raise exception 'A campaign sale item qualification must count the item''s own quantity'
      using errcode = 'check_violation';
  end if;

  -- The rule that admitted the item must be the rule the campaign version declares.
  if new.product_source is distinct from v_eval.product_eligibility_resolution then
    raise exception 'A campaign sale item qualification must record its version''s own eligibility resolution'
      using errcode = 'check_violation';
  end if;

  -- ---- The same two gates, again, at the last possible moment -----------------
  if not public.receipt_has_finalized_sale_items(v_eval.receipt_submission_id) then
    raise exception 'A campaign sale item qualification requires a receipt with a complete finalized item set'
      using errcode = 'check_violation';
  end if;

  if public.receipt_qualification_is_excluded(v_eval.receipt_submission_id) then
    raise exception 'An excluded receipt cannot receive campaign sale item qualifications'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger campaign_sale_item_qualifications_assert_item
  before insert on public.campaign_sale_item_qualifications
  for each row execute function public.campaign_sale_item_qualifications_assert_item();


-- ============================================================================
-- PART 6B — THE COMPLETE-ITEM-EVIDENCE INVARIANT
-- ============================================================================
-- THE SAME LIMITATION AS MIGRATION 64, ONE LEVEL UP, AND WHY IT IS CLOSED HERE.
--
-- campaign_sale_item_qualifications holds a foreign key TO campaign_sale_evaluations,
-- so the envelope must be inserted before its detail rows can exist. That is exactly
-- the ordering that leaves receipt_product_review_decisions able to say ACCEPTED with
-- no items behind it — and without the triggers below, a QUALIFIED evaluation could
-- likewise claim qualifying_item_count = 2 and qualifying_units = 5 while carrying no
-- item evidence at all, and a reward could be paid on it.
--
-- Migration 64 could only supply a fail-closed READ helper and require every writer to
-- call it. A DEFERRABLE INITIALLY DEFERRED constraint trigger does better: it lets the
-- transaction insert in the only sensible order — envelope, items, reward — and then
-- refuses to COMMIT unless the evidence is exactly what the envelope promised. The
-- rule stops depending on the writer's cooperation, which is the whole reason this
-- storage migration ships before the matching logic.
--
-- Two triggers are needed, not one. The evaluation-side trigger catches an envelope
-- that never received its items. The item-side trigger catches the opposite: an extra
-- item appended in a LATER transaction to an evaluation that was already complete and
-- is already immutable.

-- EXACT-SET semantics, stated once and used by both triggers and by the reward
-- assertion. Returns false — never null — for a missing evaluation, so a caller
-- cannot accidentally treat "unknown" as "fine".
create function public.campaign_evaluation_has_complete_items(
  p_campaign_sale_evaluation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.campaign_sale_evaluations e
    where e.id = p_campaign_sale_evaluation_id
      and case
        when e.outcome = 'QUALIFIED' then
          -- Declared counts are positive...
          e.qualifying_item_count >= 1
          and e.qualifying_units >= 1
          -- ...the row count is EXACTLY what was declared, so a missing item and an
          -- extra item are both refused rather than only the missing one...
          and (select count(*)
               from public.campaign_sale_item_qualifications q
               where q.campaign_sale_evaluation_id = e.id) = e.qualifying_item_count
          -- ...the units agree in total, so two items cannot silently stand in for
          -- three by carrying the same sum...
          and (select coalesce(sum(q.qualifying_units), 0)
               from public.campaign_sale_item_qualifications q
               where q.campaign_sale_evaluation_id = e.id) = e.qualifying_units
          -- ...and every item really belongs to this evaluation's campaign, version
          -- and sale. The immediate trigger already asserts this per row; repeating it
          -- here means the SET is verified as a set, not just row by row.
          and not exists (
            select 1
            from public.campaign_sale_item_qualifications q
            where q.campaign_sale_evaluation_id = e.id
              and (q.campaign_id         is distinct from e.campaign_id
                or q.campaign_version_id is distinct from e.campaign_version_id
                or q.verified_sale_id    is distinct from e.verified_sale_id))
        else
          -- NOT_QUALIFIED and NOT_EVALUABLE counted nothing and must carry nothing.
          e.qualifying_item_count = 0
          and e.qualifying_units = 0
          and not exists (
            select 1
            from public.campaign_sale_item_qualifications q
            where q.campaign_sale_evaluation_id = e.id)
      end
  );
$$;

-- Internal only, matching every other helper in this schema: PostgreSQL grants
-- EXECUTE on a new function to PUBLIC by default, and leaving that in place would
-- expose an evidence-completeness oracle to every browser session.
revoke all     on function public.campaign_evaluation_has_complete_items(uuid) from public;
revoke execute on function public.campaign_evaluation_has_complete_items(uuid) from anon;
revoke execute on function public.campaign_evaluation_has_complete_items(uuid) from authenticated;
revoke execute on function public.campaign_evaluation_has_complete_items(uuid) from service_role;

comment on function public.campaign_evaluation_has_complete_items(uuid) is
  'True only when an evaluation carries EXACTLY the item evidence it declares: for QUALIFIED, the row count and unit sum both equal the declared values and every item belongs to the same campaign, version and sale; for NOT_QUALIFIED and NOT_EVALUABLE, zero declared counts and zero item rows. Returns false for a missing evaluation. Does NOT evaluate receipt finalization or qualification exclusion; those are checked separately.';

create function public.campaign_sale_evaluations_assert_complete_items()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.campaign_evaluation_has_complete_items(new.id) then
    raise exception 'A campaign sale evaluation must carry exactly the item evidence it declares'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

-- DEFERRABLE INITIALLY DEFERRED, so the items may legitimately arrive after the
-- envelope within the same transaction and the check happens once, at COMMIT.
create constraint trigger campaign_sale_evaluations_assert_complete_items
  after insert on public.campaign_sale_evaluations
  deferrable initially deferred
  for each row execute function public.campaign_sale_evaluations_assert_complete_items();

create function public.campaign_sale_item_qualifications_assert_parent_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.campaign_evaluation_has_complete_items(new.campaign_sale_evaluation_id) then
    raise exception 'A campaign sale item qualification must leave its evaluation''s item evidence exactly as declared'
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

-- The evaluation-side trigger fires only for evaluations inserted in THIS
-- transaction, so an extra item appended to an older, already-complete evaluation
-- would otherwise pass unnoticed. This closes that.
create constraint trigger campaign_sale_item_qualifications_assert_parent_complete
  after insert on public.campaign_sale_item_qualifications
  deferrable initially deferred
  for each row execute function public.campaign_sale_item_qualifications_assert_parent_complete();


create function public.campaign_rewards_assert_reward()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eval public.campaign_sale_evaluations%rowtype;
  v_rule public.campaign_rules%rowtype;
  v_tier public.campaign_rule_tiers%rowtype;
begin
  select * into v_eval
  from public.campaign_sale_evaluations e
  where e.id = new.campaign_sale_evaluation_id;

  if v_eval.id is null then
    raise exception 'A campaign reward requires an existing evaluation'
      using errcode = 'foreign_key_violation';
  end if;

  -- A reward without a qualification is a payment without a reason.
  if v_eval.outcome <> 'QUALIFIED' then
    raise exception 'A campaign reward requires a QUALIFIED evaluation'
      using errcode = 'check_violation';
  end if;

  -- ---- outcome = 'QUALIFIED' IS NOT SUFFICIENT ------------------------------
  -- The same rule this migration applies to receipt_product_review_decisions, applied
  -- to its own envelope. A QUALIFIED evaluation whose item rows are missing, short,
  -- over-counted or mismatched has declared a qualification it cannot evidence, and
  -- coins must not be paid from it.
  --
  -- Checked IMMEDIATELY here rather than left to the deferred trigger, because a
  -- reward is only ever correct after its evidence exists. The consequence is an
  -- ordering requirement on any future writer — envelope, then items, then reward —
  -- which is the order a reward is computed in anyway.
  if not public.campaign_evaluation_has_complete_items(new.campaign_sale_evaluation_id) then
    raise exception 'A campaign reward requires an evaluation carrying exactly the item evidence it declares'
      using errcode = 'check_violation';
  end if;

  -- ---- THE UNIT COUNT IS THE EVALUATION'S, NOT THE WRITER'S -----------------
  -- Both deployed rule types count every unit the sale qualified. PER_UNIT_COINS pays
  -- coins_per_unit for each of them; TARGET_BONUS contributes all of them to the
  -- subject's running total. Nothing in the approved semantics counts a subset:
  -- max_reward_coins caps COINS, and a partial cap award reduces coins_capped_to and
  -- reward_coins while leaving the units untouched. A cap-exhausted award of zero coins
  -- still records the full qualifying unit count.
  --
  -- Without this, a reward could count 1 of 5 qualifying units with arithmetic that is
  -- internally consistent and every other constraint satisfied — paying a fifth of what
  -- was earned, undetectably. There is no cross-table CHECK in PostgreSQL, so the
  -- equality is asserted here, against the authoritative parent row.
  if new.units_counted is distinct from v_eval.qualifying_units then
    raise exception 'A campaign reward must count exactly the units its evaluation qualified'
      using errcode = 'check_violation';
  end if;

  -- ---- Every lineage column is the evaluation's own --------------------------
  if v_eval.campaign_id              is distinct from new.campaign_id
     or v_eval.campaign_version_id   is distinct from new.campaign_version_id
     or v_eval.verified_sale_id      is distinct from new.verified_sale_id
     or v_eval.receipt_submission_id is distinct from new.receipt_submission_id
     or v_eval.vendor_organization_id   is distinct from new.vendor_organization_id
     or v_eval.retailer_organization_id is distinct from new.retailer_organization_id
     or v_eval.retailer_shop_id         is distinct from new.retailer_shop_id
     or v_eval.beneficiary_profile_id   is distinct from new.beneficiary_profile_id
     or v_eval.performance_scope        is distinct from new.performance_scope then
    raise exception 'A campaign reward must copy its evaluation''s lineage exactly'
      using errcode = 'check_violation';
  end if;

  -- ---- The rule evidence is the campaign version's own -----------------------
  -- campaign_apply_draft_config writes exactly one rule at sequence 1, and at most
  -- one tier at tier_number 1. Reading those two directly is therefore complete for
  -- every version this schema can currently produce.
  select * into v_rule
  from public.campaign_rules r
  where r.campaign_version_id = new.campaign_version_id
    and r.sequence = 1;

  if v_rule.id is null then
    raise exception 'A campaign reward requires the campaign version to carry a rule'
      using errcode = 'check_violation';
  end if;

  if v_rule.rule_type         is distinct from new.rule_type
     or v_rule.metric_type    is distinct from new.metric_type
     or v_rule.coins_per_unit is distinct from new.coins_per_unit
     or v_rule.max_reward_coins is distinct from new.max_reward_coins then
    raise exception 'A campaign reward must copy its campaign version''s rule exactly'
      using errcode = 'check_violation';
  end if;

  if new.rule_type = 'TARGET_BONUS' then
    select * into v_tier
    from public.campaign_rule_tiers t
    where t.campaign_rule_id = v_rule.id
      and t.tier_number = 1;

    if v_tier.id is null then
      raise exception 'A TARGET_BONUS reward requires the rule to carry a tier'
        using errcode = 'check_violation';
    end if;

    if v_tier.threshold_units is distinct from new.threshold_units
       or v_tier.reward_coins is distinct from new.configured_reward_coins then
      raise exception 'A campaign reward must copy its campaign version''s tier exactly'
        using errcode = 'check_violation';
    end if;
  end if;

  -- ---- The same two gates, again ---------------------------------------------
  -- Repeated rather than inherited from the evaluation: an exclusion recorded
  -- BETWEEN the evaluation and the reward must stop the reward, and the evaluation
  -- row cannot know about it.
  if not public.receipt_has_finalized_sale_items(new.receipt_submission_id) then
    raise exception 'A campaign reward requires a receipt with a complete finalized item set'
      using errcode = 'check_violation';
  end if;

  if public.receipt_qualification_is_excluded(new.receipt_submission_id) then
    raise exception 'An excluded receipt cannot receive a campaign reward'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

create trigger campaign_rewards_assert_reward
  before insert on public.campaign_rewards
  for each row execute function public.campaign_rewards_assert_reward();


-- ============================================================================
-- PART 7 — RLS and grants
-- ============================================================================
-- The deployed posture, matched exactly: RLS enabled, ZERO policies, and every
-- privilege revoked. `authenticated` holds SELECT on only the ten tables that carry
-- a policy, and holds no DML anywhere in this schema; `service_role` holds no DML
-- either. There is no path to these rows except SECURITY DEFINER functions, and
-- this migration adds none — nothing outside the database can reach these tables at
-- all until the matching migration provides an RPC.
alter table public.campaign_sale_evaluations         enable row level security;
alter table public.campaign_sale_item_qualifications enable row level security;
alter table public.campaign_rewards                  enable row level security;
alter table public.campaign_subject_accumulators     enable row level security;

revoke all on table public.campaign_sale_evaluations         from public;
revoke all on table public.campaign_sale_evaluations         from anon;
revoke all on table public.campaign_sale_evaluations         from authenticated;
revoke all on table public.campaign_sale_evaluations         from service_role;

revoke all on table public.campaign_sale_item_qualifications from public;
revoke all on table public.campaign_sale_item_qualifications from anon;
revoke all on table public.campaign_sale_item_qualifications from authenticated;
revoke all on table public.campaign_sale_item_qualifications from service_role;

revoke all on table public.campaign_rewards                  from public;
revoke all on table public.campaign_rewards                  from anon;
revoke all on table public.campaign_rewards                  from authenticated;
revoke all on table public.campaign_rewards                  from service_role;

revoke all on table public.campaign_subject_accumulators     from public;
revoke all on table public.campaign_subject_accumulators     from anon;
revoke all on table public.campaign_subject_accumulators     from authenticated;
revoke all on table public.campaign_subject_accumulators     from service_role;
