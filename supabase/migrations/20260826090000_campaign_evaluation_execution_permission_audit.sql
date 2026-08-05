-- Migration: campaign_evaluation_execution_permission_audit
-- Purpose: Phase 2A-D. THE DOOR. Who may ask for a sale to be evaluated, the one
--          transaction that writes the answer down, and the audit record that says it
--          happened.
--
--   Unit 68A
--     1 permission    CAMPAIGN_EVALUATION_EXECUTE   -> CLAIM_REVIEWER, and nothing else
--   Unit 68B
--     1 internal fn   campaign_execute_evaluation_for_verified_sale(uuid)  VOLATILE
--   Unit 68C
--     1 browser RPC   evaluate_verified_sale_campaigns(uuid)               VOLATILE
--   Unit 68D
--     2 browser reads get_verified_sale_campaign_results(uuid)             STABLE
--                     get_verified_sale_campaign_qualifying_items(uuid)    STABLE
--
--   0 tables. 0 indexes. 0 policies. 0 coin, ledger, wallet, balance, payout or
--   redemption objects. No reward is posted anywhere, and no reward is calculated here.
--
-- ============================================================================
-- WHAT THIS MIGRATION IS, AND WHAT IT REFUSES TO REDO
-- ============================================================================
-- Migration 65 owns WHERE evidence lives and WHAT shape it may take.
-- Migration 66 owns WHICH campaigns a sale matched, resolved from history at sale_at.
-- Migration 67 owns HOW MANY COINS that is, and the locked accumulator write.
--
-- This migration owns WHO MAY ASK and WHEN IT IS WRITTEN DOWN. It composes the three
-- and re-derives none of them. There is no campaign matching here, no temporal
-- eligibility, no exclusivity resolution, no reward formula, no cap arithmetic and no
-- accumulator update — every one of those already has exactly one owner, and giving any
-- of them a second owner is how two code paths come to disagree about the same sale.
--
-- A source-level test asserts the absence: the evaluator's body names the Migration 66
-- and 67 functions and touches none of the tables they read.
--
-- ============================================================================
-- WHY AUTHORIZATION IS CURRENT STATE AND EVALUATION IS HISTORY
-- ============================================================================
-- These two questions look similar and must not share an answer:
--
--   "MAY THIS PERSON ASK?"      is about now. A reviewer whose membership was suspended
--                               this morning may not evaluate anything this afternoon, so
--                               resolve_claim_reviewer_organization is consulted live —
--                               exactly as every other Claim Review RPC does.
--
--   "WHAT DID THIS SALE EARN?"  is about the instant of the sale. Migration 66 answers it
--                               from frozen snapshots and status timelines at
--                               verified_sales.sale_at, and Migration 67 from immutable
--                               evidence. Nothing current reaches either.
--
-- THE TENANT CHECK USES THE SALE'S OWN FROZEN VENDOR, not the live vendor_retailers
-- relationship the receipt-review RPCs check. That is a deliberate difference and the one
-- place this migration departs from the shape of finalize_claim_receipt_sale_items:
--
--   * verified_sales.vendor_organization_id was already proven against the ACTIVE
--     relationship at finalization time by verified_sales_assert_lineage, so the
--     relationship check has happened — historically, at the only moment it was the right
--     question.
--
--   * Re-checking it live would mean a Vendor who stopped trading with a Retailer could
--     no longer evaluate the sales that Retailer already made for them, leaving earned
--     rewards permanently uncomputable. Locked rule 10 says a later Retailer state change
--     must not affect evaluation, and this is that rule applied to the gate rather than
--     only to the arithmetic.
--
-- The membership, profile, organization, role and permission checks are all still live,
-- inside resolve_claim_reviewer_organization. Only the Vendor-to-Retailer trading
-- relationship is taken from the frozen sale.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
-- No correction, supersession, replacement or delete-and-recreate flow: a stored
-- evaluation is immutable and a conflicting recalculation RAISES rather than replacing
-- anything. No reward reversal — an active exclusion prevents a NEW evaluation and a new
-- reward, and reversing a POSTED reward belongs to a ledger phase that does not exist.
-- No coin, ledger, wallet, balance, payout or redemption object, and no posting. No Web
-- and no Flutter change. No new table.


-- ============================================================================
-- UNIT 68A — THE PERMISSION
-- ============================================================================
-- One narrow permission, in the module the reviewer already works in.
--
-- WHY CLAIM_REVIEW AND NOT A NEW MODULE. Evaluating a sale is the last step of reviewing
-- the receipt that produced it: the same person, on the same screen, immediately after
-- finalizing the item set. A REWARDS module would suggest a separate surface that does
-- not exist and that this milestone does not build.
insert into public.permissions (code, name, description, module)
values
  (
    'CAMPAIGN_EVALUATION_EXECUTE',
    'Evaluate a sale for campaign qualification',
    'Run campaign qualification for one finalized authoritative sale and persist the immutable evaluation, qualifying-item and reward evidence it produces. Re-running is same-result only. Grants no ability to edit or delete stored evidence, to change a campaign, to reverse a reward, or to create any coin, balance, payout or redemption.',
    'CLAIM_REVIEW'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- CLAIM_REVIEWER AND NOTHING ELSE.
--
-- Not VENDOR_SUPER_ADMIN, for the reason migration 20260818210000 already recorded and
-- this migration makes sharper: a Vendor Super Admin AUTHORS campaigns. Someone who can
-- both write the rule and decide which sales it pays for can direct money to a chosen
-- Retailer, and that is the separation of duties this whole phase exists to establish.
--
-- Not FINANCE_ADMIN: this is not a money operation. It computes what was earned; nothing
-- is credited, held or paid anywhere in this schema.
--
-- Not SALES_STAFF, RETAILER_OWNER, RETAILER_MANAGER or any Retailer role: the
-- beneficiary of a reward must never be able to trigger its own calculation.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'CAMPAIGN_EVALUATION_EXECUTE'
where r.code = 'CLAIM_REVIEWER'
on conflict (role_id, permission_id) do nothing;


-- ============================================================================
-- UNIT 68B — THE PRIVATE TRANSACTIONAL EVALUATOR
-- ============================================================================
-- Internal and owner-execute-only. It performs no authorization of its own: the RPC above
-- it is the only intended caller and has already resolved the actor, the permission and
-- the Vendor. Putting the tenant check here as well would create a second authorization
-- model to keep in step with the first.
--
-- ---- THE ORDER, AND WHY EACH STEP IS WHERE IT IS ---------------------------
--   1. Reject a null or missing sale.
--   2. LOCK verified_sales FOR UPDATE — the serialization point, taken before anything is
--      read that a competitor could change. Not a table lock: one sale, one row.
--   3. Derive receipt, Vendor, Retailer, shop, beneficiary and sale_at from the locked
--      row and its receipt, and prove they agree.
--   4. RE-CHECK finalization and exclusion AFTER the lock. Checking before it would let an
--      exclusion recorded in the gap be evaluated straight past.
--   5. Ask Migration 66 for the matching result.
--   6. Insert or reconcile exactly one evaluation per campaign result.
--   7. Insert or reconcile item evidence for the QUALIFIED ones only.
--   8. Reconcile the stored item totals against what each envelope declared.
--   9. Ask Migration 67 to apply the reward for each QUALIFIED evaluation.
--  10. Return the stored result.
--
-- ---- WHY THE ITEM EVIDENCE IS WRITTEN BEFORE THE REWARD --------------------
-- campaign_rewards_assert_reward calls campaign_evaluation_has_complete_items IMMEDIATELY
-- on insert, so a reward inserted before its evaluation's items exist is refused. The
-- ordering envelope -> items -> reward is therefore not a preference; it is the only
-- order Migration 65 permits, and it is the order a reward is computed in anyway.
--
-- ---- IDEMPOTENCY -----------------------------------------------------------
-- Every field compared below is one Migration 66 determines from immutable or historical
-- sources, so a second run over an unchanged world reproduces them exactly. Equal means
-- "already done": the existing rows are returned, nothing is inserted, no accumulator
-- moves and no second reward appears. Unequal means the stored evidence and the current
-- derivation disagree about a historical fact, which is not something to reconcile
-- silently — it RAISES, and the transaction takes every partial write with it.
create function public.campaign_execute_evaluation_for_verified_sale(
  p_verified_sale_id uuid
)
returns table (
  verified_sale_id            uuid,
  receipt_submission_id       uuid,
  campaign_sale_evaluation_id uuid,
  campaign_id                 uuid,
  campaign_version_id         uuid,
  outcome                     text,
  non_qualification_reason    text,
  qualifying_item_count       integer,
  qualifying_units            integer,
  campaign_reward_id          uuid,
  reward_coins                bigint,
  reward_created              boolean,
  evaluation_created          boolean,
  application_result          text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sale        public.verified_sales%rowtype;
  v_sub         public.receipt_submissions%rowtype;
  v_actor       uuid;
  v_match       record;
  v_item        record;
  v_existing    public.campaign_sale_evaluations%rowtype;
  v_exist_item  public.campaign_sale_item_qualifications%rowtype;
  v_eval_id     uuid;
  v_apply       record;
  v_created_ids uuid[] := array[]::uuid[];
  v_app_ids     uuid[] := array[]::uuid[];
  v_app_results text[] := array[]::text[];
  v_result_cnt  integer := 0;
  v_stored_cnt  integer;
  v_item_rows   integer;
  v_item_units  integer;
begin
  -- ---- 1. THE SALE -----------------------------------------------------------
  if p_verified_sale_id is null then
    raise exception 'A verified sale id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The actor is DERIVED, never supplied. campaign_sale_evaluations.evaluated_by_profile_id
  -- is NOT NULL, and letting a caller nominate it would make the evidence attributable to
  -- somebody who never asked for it.
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'A campaign evaluation requires an authenticated actor'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- 2. THE LOCK -----------------------------------------------------------
  -- THE SERIALIZATION POINT. Two concurrent executions of the same sale queue here, so
  -- they cannot both find the evidence absent and both insert it. One row is locked, so
  -- there is no lock ordering to deadlock on, and unrelated sales never contend.
  select * into v_sale
  from public.verified_sales v
  where v.id = p_verified_sale_id
  for update;

  if v_sale.id is null then
    raise exception 'That authoritative sale does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  -- ---- 3. LINEAGE, DERIVED AND PROVEN ----------------------------------------
  select * into v_sub
  from public.receipt_submissions s
  where s.id = v_sale.receipt_submission_id;

  if v_sub.id is null then
    raise exception 'That authoritative sale has no receipt submission'
      using errcode = 'foreign_key_violation';
  end if;

  if v_sub.submitted_by_profile_id is null then
    raise exception 'That authoritative sale has no resolvable beneficiary'
      using errcode = 'foreign_key_violation';
  end if;

  if v_sub.retailer_organization_id is distinct from v_sale.retailer_organization_id
     or v_sub.retailer_shop_id      is distinct from v_sale.retailer_shop_id then
    raise exception 'That authoritative sale contradicts its receipt''s Retailer or shop'
      using errcode = 'check_violation';
  end if;

  if v_sale.vendor_organization_id is null
     or v_sale.retailer_organization_id is null
     or v_sale.retailer_shop_id is null
     or v_sale.sale_at is null then
    raise exception 'That authoritative sale has incomplete lineage'
      using errcode = 'check_violation';
  end if;

  -- ---- 4. THE TWO GATES, AFTER THE LOCK --------------------------------------
  -- Deliberately not checked before it. An exclusion or a definalization landing between
  -- a pre-lock check and the writes would be evaluated straight past, and the evidence
  -- would record a qualification the receipt no longer supports.
  if not public.receipt_has_finalized_sale_items(v_sale.receipt_submission_id) then
    raise exception 'That sale has no complete finalized item set and cannot be evaluated'
      using errcode = 'check_violation';
  end if;

  if public.receipt_qualification_is_excluded(v_sale.receipt_submission_id) then
    raise exception 'An excluded receipt cannot be evaluated for campaign qualification'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- 5/6. THE MATCHING RESULT, WRITTEN DOWN --------------------------------
  -- Every candidate is persisted, including the ones that earned nothing:
  --   NOT_QUALIFIED / NO_QUALIFYING_ITEMS       — considered, and the answer was no.
  --   NOT_QUALIFIED / SUPPRESSED_BY_EXCLUSIVITY — matched, and lost its exclusivity key.
  --   NOT_EVALUABLE / NO_TEMPORAL_RECORD        — the history does not say.
  -- An absent row cannot distinguish "said no" from "was never asked", and the difference
  -- is exactly what a Sales Staff member will eventually want explained.
  for v_match in
    select * from public.campaign_matching_result_for_sale(p_verified_sale_id)
  loop
    v_result_cnt := v_result_cnt + 1;

    select * into v_existing
    from public.campaign_sale_evaluations e
    where e.campaign_version_id = v_match.campaign_version_id
      and e.verified_sale_id = p_verified_sale_id;

    if v_existing.id is not null then
      -- ---- RECONCILE, OR RAISE ------------------------------------------------
      -- Every column below is one Migration 66 derives. A difference means the stored
      -- evidence and the current derivation disagree about a historical fact.
      if v_existing.campaign_id                is distinct from v_match.campaign_id
         or v_existing.vendor_organization_id  is distinct from v_match.vendor_organization_id
         or v_existing.retailer_organization_id is distinct from v_match.retailer_organization_id
         or v_existing.retailer_shop_id        is distinct from v_match.retailer_shop_id
         or v_existing.beneficiary_profile_id  is distinct from v_match.beneficiary_profile_id
         or v_existing.sale_at                 is distinct from v_match.sale_at
         or v_existing.performance_scope       is distinct from v_match.performance_scope
         or v_existing.reward_recipient_scope  is distinct from v_match.reward_recipient_scope
         or v_existing.product_scope           is distinct from v_match.product_scope
         or v_existing.product_eligibility_resolution
                                               is distinct from v_match.product_eligibility_resolution
         or v_existing.stacking_mode           is distinct from v_match.stacking_mode
         or v_existing.exclusivity_key         is distinct from v_match.exclusivity_key
         or v_existing.priority                is distinct from v_match.priority
         or v_existing.campaign_starts_at      is distinct from v_match.campaign_starts_at
         or v_existing.outcome                 is distinct from v_match.outcome
         or v_existing.non_qualification_reason is distinct from v_match.non_qualification_reason
         or v_existing.qualifying_item_count   is distinct from v_match.qualifying_item_count
         or v_existing.qualifying_units        is distinct from v_match.qualifying_units
         or v_existing.receipt_submission_id   is distinct from v_sale.receipt_submission_id then
        raise exception 'A conflicting campaign sale evaluation already exists for campaign version %',
          v_match.campaign_version_id
          using errcode = 'check_violation';
      end if;

      v_eval_id := v_existing.id;
    else
      insert into public.campaign_sale_evaluations (
        campaign_id, campaign_version_id, verified_sale_id, receipt_submission_id,
        vendor_organization_id, retailer_organization_id, retailer_shop_id,
        beneficiary_profile_id, sale_at,
        performance_scope, reward_recipient_scope, product_scope,
        product_eligibility_resolution, stacking_mode, exclusivity_key,
        priority, campaign_starts_at,
        outcome, non_qualification_reason, qualifying_item_count, qualifying_units,
        evaluated_by_profile_id
      )
      values (
        v_match.campaign_id, v_match.campaign_version_id, p_verified_sale_id,
        v_sale.receipt_submission_id,
        v_match.vendor_organization_id, v_match.retailer_organization_id,
        v_match.retailer_shop_id,
        v_match.beneficiary_profile_id, v_match.sale_at,
        v_match.performance_scope, v_match.reward_recipient_scope, v_match.product_scope,
        v_match.product_eligibility_resolution, v_match.stacking_mode,
        v_match.exclusivity_key,
        v_match.priority, v_match.campaign_starts_at,
        v_match.outcome, v_match.non_qualification_reason,
        v_match.qualifying_item_count, v_match.qualifying_units,
        v_actor
      )
      returning id into v_eval_id;

      v_created_ids := v_created_ids || v_eval_id;
    end if;
  end loop;

  -- The stored set must be exactly the derived set. A stored evaluation for a campaign the
  -- resolver no longer returns would be evidence nothing can explain, and it must not be
  -- quietly ignored by a second run.
  select count(*)::integer into v_stored_cnt
  from public.campaign_sale_evaluations e
  where e.verified_sale_id = p_verified_sale_id;

  if v_stored_cnt <> v_result_cnt then
    raise exception 'Stored evaluations (%) do not match the campaign matching result (%) for this sale',
      v_stored_cnt, v_result_cnt
      using errcode = 'check_violation';
  end if;

  -- ---- 7. ITEM EVIDENCE, FOR THE QUALIFIED ONLY ------------------------------
  -- campaign_matching_qualified_items_for_sale already filters to campaigns whose FINAL
  -- outcome is QUALIFIED and to items whose eligibility result is ELIGIBLE, so a
  -- suppressed loser, a poisoned evaluation and a campaign with no qualifying items all
  -- contribute nothing here. This loop does not decide that; it writes down what was
  -- decided.
  for v_item in
    select * from public.campaign_matching_qualified_items_for_sale(p_verified_sale_id)
  loop
    select e.id into v_eval_id
    from public.campaign_sale_evaluations e
    where e.campaign_version_id = v_item.campaign_version_id
      and e.verified_sale_id = p_verified_sale_id;

    if v_eval_id is null then
      raise exception 'A qualifying item names a campaign version with no stored evaluation'
        using errcode = 'check_violation';
    end if;

    select * into v_exist_item
    from public.campaign_sale_item_qualifications q
    where q.campaign_version_id = v_item.campaign_version_id
      and q.verified_sale_item_id = v_item.verified_sale_item_id;

    if v_exist_item.id is not null then
      if v_exist_item.campaign_sale_evaluation_id is distinct from v_eval_id
         or v_exist_item.campaign_id              is distinct from v_item.campaign_id
         or v_exist_item.verified_sale_id         is distinct from v_item.verified_sale_id
         or v_exist_item.vendor_product_id        is distinct from v_item.vendor_product_id
         or v_exist_item.qualifying_units         is distinct from v_item.qualifying_units
         or v_exist_item.product_source           is distinct from v_item.product_source
         or v_exist_item.product_status_at_sale   is distinct from v_item.product_status_at_sale
         or v_exist_item.assignment_status_at_sale
                                                  is distinct from v_item.assignment_status_at_sale then
        raise exception 'A conflicting campaign sale item qualification already exists for sale item %',
          v_item.verified_sale_item_id
          using errcode = 'check_violation';
      end if;
    else
      -- SNAPSHOT stores NULL temporal statuses and LIVE_TEMPORAL stores the resolved ones,
      -- copied verbatim from Migration 66. Nothing is defaulted here: Migration 65's
      -- live_evidence_paired CHECK refuses a row that claims a check which never happened.
      insert into public.campaign_sale_item_qualifications (
        campaign_sale_evaluation_id, campaign_id, campaign_version_id, verified_sale_id,
        verified_sale_item_id, vendor_product_id, qualifying_units, product_source,
        product_status_at_sale, assignment_status_at_sale
      )
      values (
        v_eval_id, v_item.campaign_id, v_item.campaign_version_id, v_item.verified_sale_id,
        v_item.verified_sale_item_id, v_item.vendor_product_id, v_item.qualifying_units,
        v_item.product_source, v_item.product_status_at_sale, v_item.assignment_status_at_sale
      );
    end if;
  end loop;

  -- ---- 8. THE TOTALS MUST RECONCILE ------------------------------------------
  -- campaign_evaluation_has_complete_items enforces this at COMMIT through a deferred
  -- constraint trigger. It is checked HERE as well, because a failure at COMMIT reports a
  -- trigger name and a failure here reports which campaign disagreed and by how much —
  -- and because a reward must not be applied on top of evidence that does not add up.
  for v_match in
    select e.id, e.campaign_version_id, e.outcome,
           e.qualifying_item_count, e.qualifying_units
    from public.campaign_sale_evaluations e
    where e.verified_sale_id = p_verified_sale_id
  loop
    select count(*)::integer, coalesce(sum(q.qualifying_units), 0)::integer
      into v_item_rows, v_item_units
    from public.campaign_sale_item_qualifications q
    where q.campaign_sale_evaluation_id = v_match.id;

    if v_item_rows <> v_match.qualifying_item_count
       or v_item_units <> v_match.qualifying_units then
      raise exception 'Stored item evidence (% rows, % units) does not reconcile with evaluation % (% rows, % units)',
        v_item_rows, v_item_units, v_match.campaign_version_id,
        v_match.qualifying_item_count, v_match.qualifying_units
        using errcode = 'check_violation';
    end if;

    -- ---- 9. THE REWARD, APPLIED BY MIGRATION 67 ONLY -------------------------
    -- No reward is created here and no reward arithmetic happens here. A non-QUALIFIED
    -- evaluation is never offered to the applier at all, which is what makes "no reward
    -- for anything but QUALIFIED" true by construction rather than by a later check.
    if v_match.outcome = 'QUALIFIED' then
      select * into v_apply
      from public.campaign_apply_reward_for_evaluation(v_match.id);

      if v_apply is null then
        raise exception 'The reward applier returned no result for evaluation %', v_match.id
          using errcode = 'internal_error';
      end if;

      if v_apply.application_result not in ('APPLIED', 'ALREADY_APPLIED') then
        raise exception 'The reward applier returned an unexpected result: %',
          v_apply.application_result
          using errcode = 'internal_error';
      end if;

      v_app_ids     := v_app_ids || v_match.id;
      v_app_results := v_app_results || v_apply.application_result;
    end if;
  end loop;

  -- ---- 10. THE STORED RESULT --------------------------------------------------
  -- Read back from the tables rather than assembled from what was just computed, so the
  -- caller is shown what is actually stored. Ordered exactly as Migration 66 ordered its
  -- candidates, so two calls agree byte for byte.
  return query
  select v_sale.id,
         v_sale.receipt_submission_id,
         e.id,
         e.campaign_id,
         e.campaign_version_id,
         e.outcome,
         e.non_qualification_reason,
         e.qualifying_item_count,
         e.qualifying_units,
         r.id,
         r.reward_coins,
         (r.id is not null),
         (e.id = any (v_created_ids)),
         case when array_position(v_app_ids, e.id) is null then null
              else v_app_results[array_position(v_app_ids, e.id)] end
  from public.campaign_sale_evaluations e
  left join public.campaign_rewards r on r.campaign_sale_evaluation_id = e.id
  where e.verified_sale_id = p_verified_sale_id
  order by e.priority desc, e.campaign_starts_at asc, e.campaign_version_id asc;
end;
$$;

revoke all     on function public.campaign_execute_evaluation_for_verified_sale(uuid) from public;
revoke execute on function public.campaign_execute_evaluation_for_verified_sale(uuid) from anon;
revoke execute on function public.campaign_execute_evaluation_for_verified_sale(uuid) from authenticated;
revoke execute on function public.campaign_execute_evaluation_for_verified_sale(uuid) from service_role;

comment on function public.campaign_execute_evaluation_for_verified_sale(uuid) is
  'Internal, owner-execute-only. The one transaction that persists campaign qualification for a finalized authoritative sale: locks the verified_sales row FOR UPDATE, re-checks receipt finalization and active exclusion after the lock, composes campaign_matching_result_for_sale and campaign_matching_qualified_items_for_sale, writes one immutable campaign_sale_evaluations row per candidate — including NOT_QUALIFIED and NOT_EVALUABLE — writes campaign_sale_item_qualifications for QUALIFIED campaigns only, reconciles the stored item totals against each envelope, and then calls campaign_apply_reward_for_evaluation for QUALIFIED evaluations alone. Re-running is same-result idempotent: matching evidence is returned untouched and any disagreement with stored immutable evidence raises. Performs no authorization, no campaign matching, no reward arithmetic, no accumulator update, no audit write and no ledger posting.';


-- ============================================================================
-- UNIT 68C — THE BROWSER RPC
-- ============================================================================
-- The one door. It takes a sale id and NOTHING else: there is no Vendor, Retailer, shop,
-- beneficiary, campaign, unit count, rate or reward parameter for a caller to supply, so
-- nothing about the tenant, the identity or the money can be nominated from a browser.
--
-- Two permissions are required, and the second is not redundant. Deciding what a sale
-- earned presupposes being allowed to read the receipt it came from, and
-- finalize_claim_receipt_sale_items already establishes exactly this pairing. Both must
-- resolve to the SAME Vendor, so a reviewer cannot combine an execute right in one tenant
-- with a read right in another.
create function public.evaluate_verified_sale_campaigns(
  p_verified_sale_id uuid
)
returns table (
  verified_sale_id            uuid,
  receipt_submission_id       uuid,
  campaign_sale_evaluation_id uuid,
  campaign_id                 uuid,
  campaign_version_id         uuid,
  outcome                     text,
  non_qualification_reason    text,
  qualifying_item_count       integer,
  qualifying_units            integer,
  campaign_reward_id          uuid,
  reward_coins                bigint,
  reward_created              boolean,
  evaluation_created          boolean,
  application_result          text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor       uuid;
  v_actor        uuid;
  v_sale         public.verified_sales%rowtype;
  v_row          record;
  v_evaluations  integer := 0;
  v_qualified    integer := 0;
  v_rewards      integer := 0;
  v_created      integer := 0;
  v_applied      integer := 0;
begin
  v_vendor := public.resolve_claim_reviewer_organization('CAMPAIGN_EVALUATION_EXECUTE');
  if v_vendor is null then
    raise exception 'Not authorized to evaluate campaign qualification'
      using errcode = 'insufficient_privilege';
  end if;

  if public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ') is distinct from v_vendor then
    raise exception 'Not authorized to evaluate campaign qualification'
      using errcode = 'insufficient_privilege';
  end if;

  v_actor := auth.uid();

  -- ---- THE TENANT BOUNDARY ---------------------------------------------------
  -- Missing, foreign and ineligible all raise the SAME refusal, so this cannot be used to
  -- discover which sales exist. The Vendor compared against is the sale's own frozen one;
  -- see this file's header for why the live trading relationship is deliberately not
  -- re-checked here.
  select * into v_sale
  from public.verified_sales v
  where v.id = p_verified_sale_id;

  if v_sale.id is null or v_sale.vendor_organization_id is distinct from v_vendor then
    raise exception 'This sale is not available for campaign evaluation'
      using errcode = 'insufficient_privilege';
  end if;

  for v_row in
    select * from public.campaign_execute_evaluation_for_verified_sale(p_verified_sale_id)
  loop
    v_evaluations := v_evaluations + 1;
    if v_row.outcome = 'QUALIFIED'          then v_qualified := v_qualified + 1; end if;
    if v_row.reward_created                 then v_rewards   := v_rewards + 1;   end if;
    if v_row.evaluation_created             then v_created   := v_created + 1;   end if;
    if v_row.application_result = 'APPLIED' and v_row.reward_created
                                            then v_applied   := v_applied + 1;   end if;

    verified_sale_id            := v_row.verified_sale_id;
    receipt_submission_id       := v_row.receipt_submission_id;
    campaign_sale_evaluation_id := v_row.campaign_sale_evaluation_id;
    campaign_id                 := v_row.campaign_id;
    campaign_version_id         := v_row.campaign_version_id;
    outcome                     := v_row.outcome;
    non_qualification_reason    := v_row.non_qualification_reason;
    qualifying_item_count       := v_row.qualifying_item_count;
    qualifying_units            := v_row.qualifying_units;
    campaign_reward_id          := v_row.campaign_reward_id;
    reward_coins                := v_row.reward_coins;
    reward_created              := v_row.reward_created;
    evaluation_created          := v_row.evaluation_created;
    application_result          := v_row.application_result;
    return next;
  end loop;

  -- ---- AUDIT -----------------------------------------------------------------
  -- THE PINNED CONTRACT, matching finalize_claim_receipt_sale_items exactly: work that
  -- happened is recorded, and a replay that changed nothing writes nothing. Three cases,
  -- and each is deliberate:
  --
  --   * Something was created -> one CAMPAIGN_EVALUATION_EXECUTED row.
  --   * Nothing was created because it all already existed -> NO row. A duplicate success
  --     entry would make the log say a sale was evaluated five times when it was evaluated
  --     once and looked at four more.
  --   * ZERO CANDIDATES -> one row, every time. There is no evidence for a replay to
  --     recognise itself by, and the alternative — a new execution table to remember that
  --     nothing happened — is a table this milestone does not need. Recording the
  --     execution is truthful and creates nothing else.
  --
  -- Failures are not audited, following the deployed convention: an unauthorized caller
  -- raises and the transaction is gone, so there is nothing to write it with.
  if v_created > 0 or v_applied > 0 or v_evaluations = 0 then
    insert into public.audit_logs (
      organization_id, actor_profile_id, action, entity_type, entity_id, metadata
    )
    values (
      v_vendor, v_actor, 'CAMPAIGN_EVALUATION_EXECUTED', 'RECEIPT_SUBMISSION',
      v_sale.receipt_submission_id::text,
      jsonb_build_object(
        'verified_sale_id',      v_sale.id,
        'evaluation_count',      v_evaluations,
        'qualified_count',       v_qualified,
        'reward_count',          v_rewards,
        'evaluations_created',   v_created,
        'rewards_applied',       v_applied,
        'zero_candidate',        (v_evaluations = 0)
      )
    );
  end if;

  return;
end;
$$;

revoke all     on function public.evaluate_verified_sale_campaigns(uuid) from public;
revoke execute on function public.evaluate_verified_sale_campaigns(uuid) from anon;
grant  execute on function public.evaluate_verified_sale_campaigns(uuid) to authenticated;

comment on function public.evaluate_verified_sale_campaigns(uuid) is
  'Browser RPC. Runs campaign qualification for one finalized authoritative sale and returns the stored result. Requires CAMPAIGN_EVALUATION_EXECUTE and RECEIPT_REVIEW_READ to resolve to the SAME Vendor through resolve_claim_reviewer_organization, and that Vendor to be the sale''s own frozen vendor_organization_id; missing, foreign and ineligible sales share one refusal. Takes a sale id and nothing else — no tenant, beneficiary, campaign, unit, rate or reward value may be supplied. Delegates every write to campaign_execute_evaluation_for_verified_sale, then records one CAMPAIGN_EVALUATION_EXECUTED audit entry when evidence was created or a reward applied, and one for a zero-candidate execution; a replay that created nothing writes no audit. Creates no coin, ledger, balance, payout or redemption record and posts nothing.';


-- ============================================================================
-- UNIT 68D — THE REVIEWER'S READ CONTRACT
-- ============================================================================
-- The four Migration 65 tables carry RLS with ZERO policies and every privilege revoked,
-- so `authenticated` cannot read a single row of stored qualification evidence by any
-- path. These two functions are that path, and they are the only one.
--
-- Gated on RECEIPT_REVIEW_READ rather than on a new read permission: a reviewer who may
-- open the receipt may see what it earned, which is the pairing get_verified_sale_items
-- already established. Minting a second permission for the same audience would be a
-- catalogue entry nobody would ever grant separately.
--
-- ZERO ROWS FOR EVERY DENIAL — signed out, no profile, suspended membership, missing
-- permission, wrong Vendor, unknown sale — matching every other read in this schema.
-- Reads raise nothing, so the refusal cannot be told apart from an empty result.
--
-- WHAT IS DELIBERATELY NOT RETURNED: no campaign_subject_accumulators row (it is a cache
-- and must never be read as proof that somebody was paid), no other tenant's anything, no
-- staff identity beyond the sale's own beneficiary, and no mutable campaign configuration
-- the reviewer does not need. The campaign NAME is returned because it is the Vendor's own
-- and is what a screen must show instead of a uuid.
create function public.get_verified_sale_campaign_results(
  p_verified_sale_id uuid
)
returns table (
  campaign_id              uuid,
  campaign_version_id      uuid,
  campaign_name            text,
  outcome                  text,
  non_qualification_reason text,
  qualifying_item_count    integer,
  qualifying_units         integer,
  rule_type                text,
  coins_per_unit           bigint,
  threshold_units          integer,
  configured_reward_coins  bigint,
  max_reward_coins         bigint,
  coins_uncapped           bigint,
  coins_capped_to          bigint,
  reward_coins             bigint,
  awarded_at               timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ');
  if v_vendor is null or p_verified_sale_id is null then
    return;
  end if;

  return query
  select e.campaign_id,
         e.campaign_version_id,
         c.name,
         e.outcome,
         e.non_qualification_reason,
         e.qualifying_item_count,
         e.qualifying_units,
         r.rule_type,
         r.coins_per_unit,
         r.threshold_units,
         r.configured_reward_coins,
         r.max_reward_coins,
         r.coins_uncapped,
         r.coins_capped_to,
         r.reward_coins,
         r.awarded_at
  from public.campaign_sale_evaluations e
  join public.verified_sales v on v.id = e.verified_sale_id
  join public.campaigns c on c.id = e.campaign_id
  left join public.campaign_rewards r on r.campaign_sale_evaluation_id = e.id
  where e.verified_sale_id = p_verified_sale_id
    -- BOTH sides of the tenant boundary. The evaluation's own Vendor is asserted equal to
    -- the sale's by Migration 65, so this is belt and braces rather than the only guard.
    and e.vendor_organization_id = v_vendor
    and v.vendor_organization_id = v_vendor
  order by e.priority desc, e.campaign_starts_at asc, e.campaign_version_id asc;
end;
$$;

revoke all     on function public.get_verified_sale_campaign_results(uuid) from public;
revoke execute on function public.get_verified_sale_campaign_results(uuid) from anon;
grant  execute on function public.get_verified_sale_campaign_results(uuid) to authenticated;

comment on function public.get_verified_sale_campaign_results(uuid) is
  'Browser read. One row per stored campaign evaluation for a verified sale the calling Claim Reviewer may read, with the reward rule, uncapped amount, capped amount and final coins joined where a reward exists. Gated on RECEIPT_REVIEW_READ resolving to the sale''s own Vendor; returns zero rows for every denial rather than raising. Ordered by campaign priority DESC, campaign_starts_at ASC, campaign_version_id ASC. Exposes no accumulator row, no other tenant and no staff identity.';


create function public.get_verified_sale_campaign_qualifying_items(
  p_verified_sale_id uuid
)
returns table (
  campaign_id               uuid,
  campaign_version_id       uuid,
  verified_sale_item_id     uuid,
  vendor_product_id         uuid,
  product_code_at_proposal  text,
  product_name_at_proposal  text,
  line_number               integer,
  qualifying_units          integer,
  product_source            text,
  product_status_at_sale    text,
  assignment_status_at_sale text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
begin
  v_vendor := public.resolve_claim_reviewer_organization('RECEIPT_REVIEW_READ');
  if v_vendor is null or p_verified_sale_id is null then
    return;
  end if;

  return query
  select q.campaign_id,
         q.campaign_version_id,
         q.verified_sale_item_id,
         q.vendor_product_id,
         -- The names frozen at proposal time, not the product's current ones. A product
         -- renamed since the sale must not make historical evidence describe something
         -- the reviewer never saw.
         i.product_code_at_proposal,
         i.product_name_at_proposal,
         i.line_number,
         q.qualifying_units,
         q.product_source,
         q.product_status_at_sale,
         q.assignment_status_at_sale
  from public.campaign_sale_item_qualifications q
  join public.campaign_sale_evaluations e on e.id = q.campaign_sale_evaluation_id
  join public.verified_sale_items i on i.id = q.verified_sale_item_id
  join public.verified_sales v on v.id = q.verified_sale_id
  where q.verified_sale_id = p_verified_sale_id
    and e.vendor_organization_id = v_vendor
    and v.vendor_organization_id = v_vendor
  order by e.priority desc, e.campaign_starts_at asc, e.campaign_version_id asc,
           i.line_number asc, q.verified_sale_item_id asc;
end;
$$;

revoke all     on function public.get_verified_sale_campaign_qualifying_items(uuid) from public;
revoke execute on function public.get_verified_sale_campaign_qualifying_items(uuid) from anon;
grant  execute on function public.get_verified_sale_campaign_qualifying_items(uuid) to authenticated;

comment on function public.get_verified_sale_campaign_qualifying_items(uuid) is
  'Browser read. One row per stored qualifying item for a verified sale the calling Claim Reviewer may read, carrying the product identity frozen at proposal time and the sale-time eligibility evidence Migration 66 resolved. Gated on RECEIPT_REVIEW_READ resolving to the sale''s own Vendor; returns zero rows for every denial rather than raising. Ordered by campaign priority DESC, campaign_starts_at ASC, campaign_version_id ASC, then sale item line_number ASC and id ASC.';
