-- Migration: campaign_reward_formulas_caps_target_bonus
-- Purpose: Phase 2A-C. THE ARITHMETIC. How many coins a qualified evaluation is worth,
--          what a cap leaves of it, whether a target threshold was crossed, and the one
--          locked write that turns that answer into an immutable reward.
--
--   Unit 67A
--     1 internal fn   campaign_reward_calculation_for_evaluation(uuid)   pure, STABLE
--   Unit 67B
--     1 internal fn   campaign_apply_reward_for_evaluation(uuid)         locked, VOLATILE
--
--   0 tables. 0 indexes. 0 RPCs. 0 permissions. 0 role grants. 0 grants to anon,
--   authenticated or service_role. No coin, ledger, wallet, balance, payout or
--   redemption object. Nothing is posted anywhere.
--
-- ============================================================================
-- WHAT THIS MIGRATION IS, AND WHAT THE NEXT ONE IS
-- ============================================================================
-- Migration 65 decided WHERE a reward may be written and WHAT shape it may take.
-- Migration 66 decided WHICH campaign a sale matched and HOW MANY units qualified,
-- entirely from history at verified_sales.sale_at, and wrote nothing.
--
-- This migration decides HOW MANY COINS that is, and performs the single write that
-- has to happen under a lock. It does NOT decide who may ask: there is no RPC here, no
-- permission, no audit-log integration and no grant to any browser role. Migration 68
-- supplies the permissioned execution and audit contract and calls
-- campaign_apply_reward_for_evaluation inside its evaluator transaction.
--
-- Nothing here re-evaluates campaign candidacy, product eligibility, temporal
-- eligibility or exclusivity. Migration 66 owns all four, Migration 68 will persist
-- their answer as evidence, and this migration reads that evidence and multiplies.
--
-- ============================================================================
-- WHY THE CALCULATION READS EVIDENCE AND NOT THE ACCUMULATOR
-- ============================================================================
-- campaign_subject_accumulators is a CACHE. Migration 65 says so in its own words:
-- "If this table is ever lost, corrupted or found to disagree, the evidence tables are
-- authoritative and it is rebuilt from them — never the other way round. It must never
-- be read as proof that somebody was paid."
--
-- So the calculation derives BOTH running totals from the immutable evidence, using
-- exactly the two identities Migration 65 documented — and they deliberately come from
-- DIFFERENT tables:
--
--   units_before  =  sum(campaign_sale_evaluations.qualifying_units)
--                    over QUALIFIED evaluations of the same campaign version and cap
--                    subject, EXCLUDING this evaluation
--
--   coins_before  =  sum(campaign_rewards.reward_coins)
--                    over rewards of the same campaign version and cap subject,
--                    EXCLUDING this evaluation's own reward
--
--   target awarded = exists(campaign_rewards where rule_type = 'TARGET_BONUS')
--                    for that version and subject, EXCLUDING this evaluation
--
-- Units come from EVALUATIONS because a TARGET_BONUS campaign creates a reward row only
-- for the crossing sale: every qualifying sale before it contributes units and creates
-- no reward at all, so summing campaign_rewards.units_counted would understate the
-- total by every pre-crossing sale and the threshold could never be shown to have been
-- reached. Coins come from REWARDS because an evaluation records what was COUNTED and a
-- reward records what was PAID, and a cap-exhausted award of zero coins is a real state.
-- The target flag comes from reward EXISTENCE and never from reward_coins > 0, because a
-- capped crossing legitimately pays zero and must still be a crossing that happened once.
--
-- EXCLUDING THIS EVALUATION IS WHAT MAKES REPLAY STABLE. "Everything else that
-- qualified" is a pure function of immutable rows, so calling the calculation before the
-- write and again afterwards returns the same before-state both times. Had it read the
-- accumulator instead, the second call would see the first call's own increment and
-- report a different answer for the same sale.
--
-- The accumulator is still indispensable — as the LOCK TARGET, and as the reconciliation
-- witness that tells the applier whether this evaluation has already been applied. That
-- is Unit 67B's business, and the calculation never touches it.
--
-- ============================================================================
-- WHAT THE DEPLOYED SCHEMA ALREADY DECIDED, AND IS NOT RE-DECIDED HERE
-- ============================================================================
-- Every one of these was read off the deployed definitions rather than assumed:
--
--   * ONE RULE PER VERSION, AT sequence 1. campaign_apply_draft_config deletes and
--     rewrites exactly one rule at sequence 1, and campaign_rewards_assert_reward reads
--     that row and no other. A version carrying a second rule is a configuration this
--     schema cannot evaluate, and it is refused rather than silently reduced to the first.
--
--   * ONE TIER PER TARGET_BONUS RULE, AT tier_number 1. campaign_apply_draft_config
--     writes exactly one tier, and campaign_rewards_assert_reward proves a reward's
--     threshold_units and configured_reward_coins against tier_number = 1 alone — so a
--     reward for any other tier is UNSTORABLE, whatever this migration computed. There is
--     therefore no highest-only rule and no sum-all rule to choose between: the deployed
--     model has exactly one threshold, and a rule carrying a second tier is refused as an
--     unsupported configuration. TIERED_TARGET is the intended future value of
--     campaign_rules.rule_type and is deliberately still not permitted upstream.
--
--   * ONE REWARD PER (VERSION, SALE, BENEFICIARY), by unique index. Combined with the
--     unique (campaign_version_id, verified_sale_id) on evaluations and the lineage
--     equality campaign_rewards_assert_reward enforces, that IS one reward per
--     evaluation — so no new uniqueness object is needed here.
--
--   * THE CAP IS PER SUBJECT, PER VERSION. campaign_rules.max_reward_coins applies
--     across the whole campaign period, and campaign_subject_accumulators is keyed
--     (campaign_version_id, cap_subject_type, cap_subject_id). A campaign-wide budget was
--     rejected before this milestone because it would serialize every evaluation of a
--     campaign across all Retailers.
--
--   * THE CAP SUBJECT IS DERIVED FROM performance_scope, never chosen:
--       INDIVIDUAL_STAFF -> ('SALES_STAFF_PROFILE',   beneficiary_profile_id)
--       RETAILER_TEAM    -> ('RETAILER_ORGANIZATION', retailer_organization_id)
--     campaign_rewards_cap_subject_matches_scope enforces exactly that at the table.
--
--   * THE BENEFICIARY IS ALWAYS THE SUBMITTER. reward_recipient_scope admits
--     CONTRIBUTING_STAFF alone. RETAILER_TEAM changes what is COUNTED, never who is PAID:
--     the whole team's units accumulate against one Retailer subject, and the Sales Staff
--     member whose own sale crosses the threshold receives the full bonus, once.
--
-- ============================================================================
-- NO INDEX IS ADDED, AND WHY
-- ============================================================================
-- The two reconstruction queries were checked against the deployed indexes rather than
-- guessed at:
--
--   the coins sum   ->  campaign_rewards_version_subject_idx
--                       (campaign_version_id, cap_subject_id) — both predicates, leading.
--   the units sum   ->  campaign_sale_evaluations_version_idx
--                       (campaign_version_id, evaluated_at desc) — campaign_version_id is
--                       the leading column, so the scan is confined to one version.
--
-- A tighter partial index keyed on the derived subject would help the second query, but
-- the subject is a CASE over performance_scope and is not a stored column, so such an
-- index would have to be an expression index encoding a rule that already has an owner.
-- It is not added on speculation.
--
-- ============================================================================
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ============================================================================
-- No application-facing RPC. No permission and no role_permission row. No audit-log
-- write. No evaluation and no item-matching logic. No evidence row of any kind except
-- the reward it is asked to apply. No coin ledger, wallet, balance, payout or redemption
-- object, and no posting of a reward to anything. No Web and no Flutter change. No
-- reversal, correction, replacement or versioned-attempt flow: a later receipt exclusion
-- prevents a NEW reward and the reversal of a POSTED one belongs to the ledger phase.


-- ============================================================================
-- UNIT 67A — THE PURE REWARD CALCULATION
-- ============================================================================
-- One parameter: an evaluation id. Units, rate, threshold, cap, recipient, subject,
-- Vendor, Retailer, campaign version and sale time are ALL derived from the
-- authoritative rows, so a caller cannot enlarge its own reward by asserting a better
-- one. There is no override parameter and there is deliberately nowhere to put one.
--
-- ---- PER_UNIT_COINS --------------------------------------------------------
--   coins_uncapped = coins_per_unit * units_counted          (bigint, exact, no rounding)
--   headroom       = greatest(max_reward_coins - coins_before, 0)   when a cap exists
--   reward_coins   = least(coins_uncapped, headroom)               when a cap exists
--   reward_coins   = coins_uncapped                                when it does not
--
-- A partial award is legal and is the point: the award is the EXACT remaining headroom,
-- never all-or-nothing. An exhausted cap yields a zero-coin reward that is still a real,
-- immutable reward — the qualification happened and the evidence must say so.
--
-- CAPS REDUCE COINS, NEVER UNITS. units_counted stays the evaluation's full qualifying
-- unit count in every case, which is also what campaign_rewards_assert_reward demands.
--
-- ---- TARGET_BONUS ----------------------------------------------------------
--   crossed = units_before < threshold_units
--             and units_before + units_counted >= threshold_units
--
-- A sale that does not cross creates NO reward row. That is not a stylistic choice:
-- campaign_rewards_uncapped_matches_tier requires coins_uncapped = configured_reward_coins
-- on every TARGET_BONUS row, so "a qualifying sale before the crossing" has no
-- representation as a zero-coin reward and must not be invented as one. Its units still
-- accumulate, because the threshold is reached by accumulating them.
--
-- A crossing that a cap reduces to zero DOES create a row — coins_uncapped is the
-- configured bonus, coins_capped_to is 0 — so the crossing stays provable and cannot be
-- claimed a second time.
--
-- ---- Numeric exactness -----------------------------------------------------
-- Every quantity here is integer or bigint. No division, no rounding, no floating point
-- and no numeric coercion appears anywhere in this file: the deployed rule schema stores
-- integer coins precisely so that money-like quantities never have to round. The largest
-- product this file can form is bounded by campaign_rewards_uncapped_range at 5e12
-- (1e9 coins/unit x 5000 units), far inside bigint, and PostgreSQL raises 22003 on
-- bigint overflow rather than wrapping.
create function public.campaign_reward_calculation_for_evaluation(
  p_campaign_sale_evaluation_id uuid
)
returns table (
  campaign_sale_evaluation_id uuid,
  campaign_id                 uuid,
  campaign_version_id         uuid,
  verified_sale_id            uuid,
  receipt_submission_id       uuid,
  vendor_organization_id      uuid,
  retailer_organization_id    uuid,
  retailer_shop_id            uuid,
  beneficiary_profile_id      uuid,
  performance_scope           text,
  cap_subject_type            text,
  cap_subject_id              uuid,
  rule_type                   text,
  metric_type                 text,
  coins_per_unit              bigint,
  threshold_units             integer,
  configured_reward_coins     bigint,
  max_reward_coins            bigint,
  units_counted               integer,
  units_before                bigint,
  units_after                 bigint,
  threshold_crossed           boolean,
  target_already_awarded      boolean,
  coins_uncapped              bigint,
  cap_remaining_headroom      bigint,
  coins_capped_to             bigint,
  reward_coins                bigint,
  coins_before                bigint,
  coins_after                 bigint,
  creates_reward              boolean,
  no_reward_reason            text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_eval        public.campaign_sale_evaluations%rowtype;
  v_sale        public.verified_sales%rowtype;
  v_sub         public.receipt_submissions%rowtype;
  v_version     public.campaign_versions%rowtype;
  v_campaign    public.campaigns%rowtype;
  v_rule        public.campaign_rules%rowtype;
  v_tier        public.campaign_rule_tiers%rowtype;
  v_own_reward  public.campaign_rewards%rowtype;
  v_rule_count  integer;
  v_tier_count  integer;
  v_subject_typ text;
  v_subject_id  uuid;
  v_units_bef   bigint;
  v_units_aft   bigint;
  v_coins_bef   bigint;
  v_awarded     boolean;
  v_crossed     boolean;
  v_uncapped    bigint;
  v_headroom    bigint;
  v_reward      bigint;
  v_capped_to   bigint;
  v_creates     boolean;
  v_reason      text;
begin
  -- ---- 1. THE EVALUATION -----------------------------------------------------
  -- A null id is a caller error, a missing evaluation is a broken reference, and a
  -- non-QUALIFIED evaluation is a payment without a reason. All three raise: this
  -- function never returns a "sorry, nothing" row that a caller could mistake for a
  -- legitimate zero-coin award.
  if p_campaign_sale_evaluation_id is null then
    raise exception 'A campaign sale evaluation id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_eval
  from public.campaign_sale_evaluations e
  where e.id = p_campaign_sale_evaluation_id;

  if v_eval.id is null then
    raise exception 'That campaign sale evaluation does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  if v_eval.outcome <> 'QUALIFIED' then
    raise exception 'A campaign reward requires a QUALIFIED evaluation, not %', v_eval.outcome
      using errcode = 'check_violation';
  end if;

  -- outcome = 'QUALIFIED' IS NOT SUFFICIENT. The envelope may declare counts its item
  -- rows do not evidence — Migration 65's header explains why that ordering gap exists —
  -- and coins must not be computed from a declaration nothing backs.
  if not public.campaign_evaluation_has_complete_items(v_eval.id) then
    raise exception 'A campaign reward requires an evaluation carrying exactly the item evidence it declares'
      using errcode = 'check_violation';
  end if;

  -- Belt and braces against a future relaxation of campaign_sale_evaluations_counts_match_outcome.
  if v_eval.qualifying_units is null or v_eval.qualifying_units < 1 then
    raise exception 'A QUALIFIED evaluation must carry at least one qualifying unit'
      using errcode = 'check_violation';
  end if;

  -- ---- 2. SALE LINEAGE -------------------------------------------------------
  -- Broken lineage RAISES rather than producing a cautious zero. A zero-coin reward is a
  -- real business state — an exhausted cap — and laundering a corrupt input into the same
  -- shape would make the two indistinguishable afterwards.
  select * into v_sale
  from public.verified_sales v
  where v.id = v_eval.verified_sale_id;

  if v_sale.id is null then
    raise exception 'That evaluation has no authoritative sale'
      using errcode = 'foreign_key_violation';
  end if;

  if v_sale.receipt_submission_id is distinct from v_eval.receipt_submission_id
     or v_sale.vendor_organization_id   is distinct from v_eval.vendor_organization_id
     or v_sale.retailer_organization_id is distinct from v_eval.retailer_organization_id
     or v_sale.retailer_shop_id         is distinct from v_eval.retailer_shop_id
     or v_sale.sale_at                  is distinct from v_eval.sale_at then
    raise exception 'That evaluation contradicts its authoritative sale''s lineage or instant'
      using errcode = 'check_violation';
  end if;

  select * into v_sub
  from public.receipt_submissions s
  where s.id = v_eval.receipt_submission_id;

  if v_sub.id is null then
    raise exception 'That evaluation has no receipt submission'
      using errcode = 'foreign_key_violation';
  end if;

  -- The beneficiary is the SUBMITTER and is never supplied. verified_sales deliberately
  -- carries no seller column, so receipt_submissions is the one authoritative answer.
  if v_sub.submitted_by_profile_id is distinct from v_eval.beneficiary_profile_id then
    raise exception 'That evaluation''s beneficiary is not the receipt submitter'
      using errcode = 'check_violation';
  end if;

  if v_sub.retailer_organization_id is distinct from v_eval.retailer_organization_id
     or v_sub.retailer_shop_id      is distinct from v_eval.retailer_shop_id then
    raise exception 'That evaluation contradicts its receipt''s Retailer or shop'
      using errcode = 'check_violation';
  end if;

  -- The staff member's CURRENT status is deliberately not consulted. A sale made while a
  -- Sales Staff member was active stays rewardable after they leave; the profile row is
  -- RESTRICT-referenced by every evidence table precisely so that history survives them.
  if not exists (select 1 from public.profiles p where p.id = v_eval.beneficiary_profile_id) then
    raise exception 'That evaluation''s beneficiary profile does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  -- ---- 3. CAMPAIGN LINEAGE ---------------------------------------------------
  select * into v_version
  from public.campaign_versions cv
  where cv.id = v_eval.campaign_version_id;

  if v_version.id is null then
    raise exception 'That evaluation has no campaign version'
      using errcode = 'foreign_key_violation';
  end if;

  if v_version.campaign_id is distinct from v_eval.campaign_id then
    raise exception 'That evaluation names a campaign that is not its version''s own'
      using errcode = 'check_violation';
  end if;

  if v_version.published_at is null then
    raise exception 'A campaign reward requires a published campaign version'
      using errcode = 'check_violation';
  end if;

  -- The frozen configuration must still be the version's own. Published versions are
  -- immutable, so this can only fire if that immutability is ever broken — which is
  -- exactly when a reward must stop rather than quietly use the newer meaning.
  if v_version.performance_scope         is distinct from v_eval.performance_scope
     or v_version.reward_recipient_scope is distinct from v_eval.reward_recipient_scope
     or v_version.product_scope          is distinct from v_eval.product_scope
     or v_version.product_eligibility_resolution
                                         is distinct from v_eval.product_eligibility_resolution
     or v_version.stacking_mode          is distinct from v_eval.stacking_mode
     or v_version.exclusivity_key        is distinct from v_eval.exclusivity_key
     or v_version.priority               is distinct from v_eval.priority
     or v_version.starts_at              is distinct from v_eval.campaign_starts_at then
    raise exception 'That evaluation no longer matches its campaign version''s frozen configuration'
      using errcode = 'check_violation';
  end if;

  select * into v_campaign
  from public.campaigns c
  where c.id = v_eval.campaign_id;

  if v_campaign.id is null then
    raise exception 'That evaluation has no campaign'
      using errcode = 'foreign_key_violation';
  end if;

  -- THE TENANT BOUNDARY, again. It is cheap here and the consequence of missing it is a
  -- Vendor paying for another Vendor's sale.
  if v_campaign.vendor_organization_id is distinct from v_eval.vendor_organization_id then
    raise exception 'That evaluation''s campaign belongs to a different Vendor than the sale'
      using errcode = 'check_violation';
  end if;

  -- ---- 4. THE TWO WRITE GATES, AT THE LAST POSSIBLE MOMENT --------------------
  -- Repeated rather than inherited from the evaluation row. An exclusion recorded BETWEEN
  -- the evaluation and the reward must stop the reward, and the evaluation cannot know
  -- about it. Locked decision: an active exclusion prevents a NEW unposted reward;
  -- historical evidence is preserved untouched and no reversal happens here.
  if not public.receipt_has_finalized_sale_items(v_eval.receipt_submission_id) then
    raise exception 'A campaign reward requires a receipt with a complete finalized item set'
      using errcode = 'check_violation';
  end if;

  if public.receipt_qualification_is_excluded(v_eval.receipt_submission_id) then
    raise exception 'An excluded receipt cannot receive a campaign reward'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- 5. THE RULE -----------------------------------------------------------
  select count(*)::integer into v_rule_count
  from public.campaign_rules r
  where r.campaign_version_id = v_eval.campaign_version_id;

  if v_rule_count = 0 then
    raise exception 'That campaign version carries no reward rule'
      using errcode = 'check_violation';
  end if;

  -- A second rule is not evaluated as "the first one wins". Nothing in the deployed
  -- contract says which rule pays, campaign_rewards can only copy one, and guessing would
  -- silently pay a fraction of a configuration somebody meant.
  if v_rule_count > 1 then
    raise exception 'That campaign version carries % reward rules; exactly one is supported', v_rule_count
      using errcode = 'feature_not_supported';
  end if;

  select * into v_rule
  from public.campaign_rules r
  where r.campaign_version_id = v_eval.campaign_version_id
    and r.sequence = 1;

  if v_rule.id is null then
    raise exception 'That campaign version''s reward rule is not at sequence 1'
      using errcode = 'feature_not_supported';
  end if;

  if v_rule.metric_type is distinct from 'UNITS_SOLD' then
    raise exception 'Reward metric % is not supported', v_rule.metric_type
      using errcode = 'feature_not_supported';
  end if;

  select count(*)::integer into v_tier_count
  from public.campaign_rule_tiers t
  where t.campaign_rule_id = v_rule.id;

  if v_rule.rule_type = 'PER_UNIT_COINS' then
    if v_rule.coins_per_unit is null then
      raise exception 'A PER_UNIT_COINS rule must carry a rate'
        using errcode = 'check_violation';
    end if;
    -- A rate rule carrying a threshold tier is two rules disagreeing about what it pays.
    if v_tier_count > 0 then
      raise exception 'A PER_UNIT_COINS rule must carry no tier, but carries %', v_tier_count
        using errcode = 'feature_not_supported';
    end if;

  elsif v_rule.rule_type = 'TARGET_BONUS' then
    -- EXACTLY ONE TIER, AT tier_number 1. campaign_rewards_assert_reward proves a stored
    -- reward against tier_number = 1 alone, so a reward derived from any other tier could
    -- not be inserted whatever this function decided. Refusing the configuration here is
    -- what turns an unstorable answer into a legible error.
    if v_tier_count <> 1 then
      raise exception 'A TARGET_BONUS rule must carry exactly one tier, but carries %', v_tier_count
        using errcode = 'feature_not_supported';
    end if;

    select * into v_tier
    from public.campaign_rule_tiers t
    where t.campaign_rule_id = v_rule.id
      and t.tier_number = 1;

    if v_tier.id is null then
      raise exception 'A TARGET_BONUS rule''s single tier must be tier_number 1'
        using errcode = 'feature_not_supported';
    end if;

    if v_tier.threshold_units is null or v_tier.threshold_units < 1
       or v_tier.reward_coins is null or v_tier.reward_coins < 1 then
      raise exception 'That TARGET_BONUS tier is not a usable threshold and reward'
        using errcode = 'check_violation';
    end if;

  else
    raise exception 'Reward rule type % is not supported', v_rule.rule_type
      using errcode = 'feature_not_supported';
  end if;

  -- ---- 6. THE CAP SUBJECT, DERIVED AND NEVER CHOSEN --------------------------
  if v_eval.performance_scope = 'INDIVIDUAL_STAFF' then
    v_subject_typ := 'SALES_STAFF_PROFILE';
    v_subject_id  := v_eval.beneficiary_profile_id;
  elsif v_eval.performance_scope = 'RETAILER_TEAM' then
    -- THE WHOLE TEAM ACCUMULATES AGAINST ONE RETAILER SUBJECT. This single line is what
    -- makes another Sales Staff member's earlier units count towards this member's
    -- threshold, and it is the only difference between the two scopes on the counting
    -- side. Who is PAID does not change: see the beneficiary below.
    v_subject_typ := 'RETAILER_ORGANIZATION';
    v_subject_id  := v_eval.retailer_organization_id;
  else
    raise exception 'Performance scope % is not supported', v_eval.performance_scope
      using errcode = 'feature_not_supported';
  end if;

  if v_eval.reward_recipient_scope is distinct from 'CONTRIBUTING_STAFF' then
    raise exception 'Reward recipient scope % is not supported', v_eval.reward_recipient_scope
      using errcode = 'feature_not_supported';
  end if;

  -- ---- 7. THE RUNNING TOTALS, RECONSTRUCTED FROM EVIDENCE ---------------------
  -- Both sums EXCLUDE this evaluation, so "before" means "everything else that
  -- qualified" and is a pure function of immutable rows. See this file's header for why
  -- units come from evaluations and coins come from rewards.
  select coalesce(sum(e.qualifying_units), 0)::bigint into v_units_bef
  from public.campaign_sale_evaluations e
  where e.campaign_version_id = v_eval.campaign_version_id
    and e.outcome = 'QUALIFIED'
    and e.id <> v_eval.id
    and case e.performance_scope
          when 'INDIVIDUAL_STAFF' then e.beneficiary_profile_id
          when 'RETAILER_TEAM'    then e.retailer_organization_id
        end = v_subject_id;

  v_units_aft := v_units_bef + v_eval.qualifying_units::bigint;

  -- This evaluation's own reward, if one already exists. Read here so the coin total can
  -- exclude it and a replay reproduces the same before-state.
  select * into v_own_reward
  from public.campaign_rewards r
  where r.campaign_sale_evaluation_id = v_eval.id;

  select coalesce(sum(r.reward_coins), 0)::bigint into v_coins_bef
  from public.campaign_rewards r
  where r.campaign_version_id = v_eval.campaign_version_id
    and r.cap_subject_type = v_subject_typ
    and r.cap_subject_id = v_subject_id
    and r.campaign_sale_evaluation_id <> v_eval.id;

  -- LOCKED DECISION: target-bonus awarded state is reconstructed from reward EXISTENCE
  -- and threshold evidence, never from awarded coins. A crossing that a cap reduced to
  -- zero already claimed the one-time bonus, and reading reward_coins > 0 would hand it
  -- out a second time.
  select exists (
    select 1
    from public.campaign_rewards r
    where r.campaign_version_id = v_eval.campaign_version_id
      and r.cap_subject_type = v_subject_typ
      and r.cap_subject_id = v_subject_id
      and r.rule_type = 'TARGET_BONUS'
      and r.campaign_sale_evaluation_id <> v_eval.id
  ) into v_awarded;

  -- ---- 8. THE ARITHMETIC -----------------------------------------------------
  if v_rule.rule_type = 'PER_UNIT_COINS' then
    v_crossed  := false;
    v_creates  := true;
    v_reason   := null;
    v_uncapped := v_rule.coins_per_unit * v_eval.qualifying_units::bigint;

  else
    -- previous_units < threshold AND previous_units + current_units >= threshold.
    -- Strict on the left so a subject already at or past the threshold cannot cross it
    -- again; inclusive on the right so landing exactly on the threshold crosses it.
    v_crossed := v_units_bef < v_tier.threshold_units::bigint
             and v_units_aft >= v_tier.threshold_units::bigint;

    if v_awarded then
      -- Already claimed for this campaign version and subject. Units still accumulate;
      -- see the applier.
      v_creates  := false;
      v_reason   := 'TARGET_ALREADY_AWARDED';
      v_uncapped := 0;
    elsif not v_crossed then
      v_creates  := false;
      v_reason   := 'THRESHOLD_NOT_CROSSED';
      v_uncapped := 0;
    else
      v_creates  := true;
      v_reason   := null;
      -- campaign_rewards_uncapped_matches_tier: the uncapped amount IS the configured
      -- bonus, exactly. The bonus is not scaled by units and not multiplied by anything.
      v_uncapped := v_tier.reward_coins;
    end if;
  end if;

  -- ---- 9. THE CAP ------------------------------------------------------------
  if v_rule.max_reward_coins is null then
    v_headroom  := null;
    v_reward    := v_uncapped;
    v_capped_to := null;
  else
    v_headroom := greatest(v_rule.max_reward_coins - v_coins_bef, 0::bigint);
    v_reward   := least(v_uncapped, v_headroom);
    -- coins_capped_to records a cap that ACTUALLY BIT and nothing else:
    -- campaign_rewards_capped_range demands coins_capped_to < coins_uncapped, so a cap
    -- that changed nothing must be recorded as NULL rather than as a no-op ceiling.
    if v_creates and v_reward < v_uncapped then
      v_capped_to := v_reward;
    else
      v_capped_to := null;
    end if;
  end if;

  if not v_creates then
    -- No row is inserted, so no coins move. The headroom is still reported, because a
    -- caller asking "why did this sale pay nothing?" deserves to see whether the answer
    -- was the threshold or the cap.
    v_reward := 0;
  end if;

  -- ---- 10. THE ANSWER --------------------------------------------------------
  campaign_sale_evaluation_id := v_eval.id;
  campaign_id                 := v_eval.campaign_id;
  campaign_version_id         := v_eval.campaign_version_id;
  verified_sale_id            := v_eval.verified_sale_id;
  receipt_submission_id       := v_eval.receipt_submission_id;
  vendor_organization_id      := v_eval.vendor_organization_id;
  retailer_organization_id    := v_eval.retailer_organization_id;
  retailer_shop_id            := v_eval.retailer_shop_id;
  -- THE BENEFICIARY IS THE CROSSING SALE'S OWN SUBMITTER, under both performance scopes.
  beneficiary_profile_id      := v_eval.beneficiary_profile_id;
  performance_scope           := v_eval.performance_scope;
  cap_subject_type            := v_subject_typ;
  cap_subject_id              := v_subject_id;
  rule_type                   := v_rule.rule_type;
  metric_type                 := v_rule.metric_type;
  coins_per_unit              := v_rule.coins_per_unit;
  threshold_units             := v_tier.threshold_units;
  configured_reward_coins     := v_tier.reward_coins;
  max_reward_coins            := v_rule.max_reward_coins;
  units_counted               := v_eval.qualifying_units;
  units_before                := v_units_bef;
  units_after                 := v_units_aft;
  threshold_crossed           := v_crossed;
  target_already_awarded      := v_awarded;
  coins_uncapped              := v_uncapped;
  cap_remaining_headroom      := v_headroom;
  coins_capped_to             := v_capped_to;
  reward_coins                := v_reward;
  coins_before                := v_coins_bef;
  coins_after                 := v_coins_bef + v_reward;
  creates_reward              := v_creates;
  no_reward_reason            := v_reason;

  return next;
  return;
end;
$$;

revoke all     on function public.campaign_reward_calculation_for_evaluation(uuid) from public;
revoke execute on function public.campaign_reward_calculation_for_evaluation(uuid) from anon;
revoke execute on function public.campaign_reward_calculation_for_evaluation(uuid) from authenticated;
revoke execute on function public.campaign_reward_calculation_for_evaluation(uuid) from service_role;

comment on function public.campaign_reward_calculation_for_evaluation(uuid) is
  'Pure reward arithmetic for one QUALIFIED campaign sale evaluation, derived entirely from immutable stored evidence: nothing about units, rate, threshold, cap, recipient, subject, tenant, campaign version or sale time may be supplied. PER_UNIT_COINS pays coins_per_unit x the evaluation''s full qualifying units; TARGET_BONUS pays its single tier_number 1 bonus exactly once, when accumulated units cross threshold_units. A configured max_reward_coins is applied per campaign version per cap subject as remaining headroom, so a partial award of exactly the headroom is legal and an exhausted cap yields a zero-coin reward; caps reduce coins and never units. Prior units are reconstructed from QUALIFIED evaluations, prior coins from campaign_rewards, and target-awarded state from TARGET_BONUS reward existence — all excluding this evaluation, so a replay reproduces the same before-state. Raises on a null or missing evaluation, a non-QUALIFIED evaluation, incomplete item evidence, an unfinalized or actively excluded receipt, broken lineage, and an unsupported or contradictory rule configuration. Reads the accumulator not at all and writes nothing.';


-- ============================================================================
-- UNIT 67B — THE LOCKED APPLICATION
-- ============================================================================
-- The one function in this migration that writes. It is internal and owner-execute-only;
-- Migration 68 will call it inside the evaluator transaction that has already written the
-- evaluation envelope and its item evidence.
--
-- ---- The required order, and why each step is where it is -------------------
--   1. Validate the evaluation and lineage       — a rejected application must never have
--                                                  created an accumulator row.
--   2. Resolve the accumulator subject           — derived from performance_scope.
--   3. Ensure the accumulator row exists         — insert ... on conflict do nothing.
--   4. Lock it with SELECT ... FOR UPDATE        — the serialization point.
--   5. Re-read state after the lock              — the reconstruction below runs AFTER
--                                                  the lock is held, so a competitor's
--                                                  committed reward is visible to it.
--   6. Recalculate from the locked state.
--   7. Detect an existing reward for this evaluation.
--   8. Identical  -> return it idempotently.
--   9. Conflicting -> raise.
--  10. Insert the immutable reward row.
--  11. Update the accumulator to the exact after-state.
--  12. Return the stored result.
--
-- ---- Why an accumulator row lock and not an advisory lock -------------------
-- The row that has to be consistent is the row that is locked, so the lock cannot drift
-- from the thing it protects and no separate key space has to be kept in step. Exactly
-- ONE accumulator row is locked per call, so a deadlock between two applications is not
-- merely unlikely, it is unreachable: there is no second lock to acquire in a different
-- order. Different subjects are different rows and never block one another; a
-- campaign-wide lock would have made every Retailer wait for every other.
--
-- The unique indexes remain the final backstop. campaign_rewards_version_sale_beneficiary
-- _unique_idx makes a duplicate reward unstorable even if this function were wrong, and
-- campaign_sale_evaluations_exclusivity_unique_idx does the same for double payment
-- inside an exclusivity key.
--
-- ---- Idempotency, and the case that has no reward row to check --------------
-- A PER_UNIT_COINS evaluation and a TARGET_BONUS crossing both leave a reward row, so a
-- replay is recognised by finding it. A TARGET_BONUS sale that did NOT cross leaves no
-- reward row at all, and its only trace is the units it added to the accumulator. That
-- case is recognised by RECONCILIATION: the calculation reports units_before and
-- units_after from the evidence, and the locked accumulator must equal exactly one of
-- them — before means "not yet applied", after means "already applied". They can never be
-- equal, because a QUALIFIED evaluation carries at least one unit.
--
-- Anything else means the cache disagrees with the evidence, and that RAISES rather than
-- being repaired: silently rewriting a total from an unknown writer's state is the kind
-- of guess this system refuses, and Migration 65 already says the evidence tables are
-- authoritative and the accumulator is rebuilt from them.
--
-- ---- THE ONE CONTRACT THIS IMPOSES ON MIGRATION 68 -------------------------
-- Because "before" means "every OTHER qualified evaluation of this campaign version for
-- this subject", the reconciliation above holds exactly when every stored QUALIFIED
-- evaluation for that subject has already been applied. Migration 68 satisfies this by
-- construction — it writes the envelope, the items and the reward in ONE transaction, so
-- an evaluation and its application either both exist or neither does, and a failed
-- application takes the evaluation down with it. A writer that persisted a qualified
-- evaluation and then declined to apply it would leave a subject whose next application
-- raises, which is the fail-closed half of the same rule and not a second behaviour.
create function public.campaign_apply_reward_for_evaluation(
  p_campaign_sale_evaluation_id uuid
)
returns table (
  campaign_reward_id          uuid,
  campaign_sale_evaluation_id uuid,
  campaign_version_id         uuid,
  cap_subject_type            text,
  cap_subject_id              uuid,
  rule_type                   text,
  units_counted               integer,
  units_before                bigint,
  units_after                 bigint,
  threshold_units             integer,
  threshold_crossed           boolean,
  coins_uncapped              bigint,
  cap_remaining_headroom      bigint,
  coins_capped_to             bigint,
  reward_coins                bigint,
  coins_before                bigint,
  coins_after                 bigint,
  reward_created              boolean,
  application_result          text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_eval        public.campaign_sale_evaluations%rowtype;
  v_acc         public.campaign_subject_accumulators%rowtype;
  v_calc        record;
  v_existing    public.campaign_rewards%rowtype;
  v_reward_id   uuid;
  v_subject_typ text;
  v_subject_id  uuid;
  v_target_seen boolean;
  v_result      text;
  v_created     boolean;
  v_reward      bigint;
  v_uncapped    bigint;
  v_capped_to   bigint;
  v_units       integer;
begin
  -- ---- 1. VALIDATE ------------------------------------------------------------
  -- Only what is needed to resolve the subject safely. Every other gate — completeness,
  -- finalization, exclusion, lineage, rule configuration — is enforced by the calculation
  -- at step 6, UNDER the lock, which is the last moment at which it can still be true.
  if p_campaign_sale_evaluation_id is null then
    raise exception 'A campaign sale evaluation id is required'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_eval
  from public.campaign_sale_evaluations e
  where e.id = p_campaign_sale_evaluation_id;

  if v_eval.id is null then
    raise exception 'That campaign sale evaluation does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  if v_eval.outcome <> 'QUALIFIED' then
    raise exception 'A campaign reward requires a QUALIFIED evaluation, not %', v_eval.outcome
      using errcode = 'check_violation';
  end if;

  -- ---- 2. THE SUBJECT ---------------------------------------------------------
  if v_eval.performance_scope = 'INDIVIDUAL_STAFF' then
    v_subject_typ := 'SALES_STAFF_PROFILE';
    v_subject_id  := v_eval.beneficiary_profile_id;
  elsif v_eval.performance_scope = 'RETAILER_TEAM' then
    v_subject_typ := 'RETAILER_ORGANIZATION';
    v_subject_id  := v_eval.retailer_organization_id;
  else
    raise exception 'Performance scope % is not supported', v_eval.performance_scope
      using errcode = 'feature_not_supported';
  end if;

  -- ---- 3. ENSURE THE ROW EXISTS -----------------------------------------------
  -- Two first-ever evaluations for one subject can reach this line together. ON CONFLICT
  -- DO NOTHING waits for the competing insert to finish: if it committed, this inserts
  -- nothing and the row is there; if it rolled back, this inserts it. Either way the row
  -- exists when the statement returns, which is what makes the FOR UPDATE below reachable
  -- without a retry loop.
  --
  -- The conflict target is named as a CONSTRAINT rather than as a column list, because
  -- all three key columns are also OUT parameters of this function and an inference list
  -- cannot be qualified: PostgreSQL would refuse the statement as ambiguous. Naming the
  -- primary key is also the more precise statement of intent.
  insert into public.campaign_subject_accumulators (
    campaign_version_id, cap_subject_type, cap_subject_id
  )
  values (v_eval.campaign_version_id, v_subject_typ, v_subject_id)
  on conflict on constraint campaign_subject_accumulators_pkey do nothing;

  -- ---- 4. LOCK ----------------------------------------------------------------
  -- THE SERIALIZATION POINT. Two evaluations for the same campaign version and subject
  -- queue here, so they cannot both read the same cap headroom and cannot both find the
  -- one-time target bonus unclaimed.
  select * into v_acc
  from public.campaign_subject_accumulators a
  where a.campaign_version_id = v_eval.campaign_version_id
    and a.cap_subject_type = v_subject_typ
    and a.cap_subject_id = v_subject_id
  for update;

  if not found then
    raise exception 'The campaign subject accumulator could not be created or locked'
      using errcode = 'internal_error';
  end if;

  -- ---- 5/6. RECALCULATE FROM THE LOCKED STATE ---------------------------------
  -- This statement takes a fresh snapshot, taken after the lock was granted, so every
  -- reward a competing application committed while this one waited is visible to the
  -- reconstruction inside the calculation. That ordering is the whole point of steps 4
  -- and 6 being in this order and not the other.
  select * into v_calc
  from public.campaign_reward_calculation_for_evaluation(p_campaign_sale_evaluation_id);

  if v_calc is null then
    raise exception 'The reward calculation returned no result'
      using errcode = 'internal_error';
  end if;

  if v_calc.cap_subject_type is distinct from v_subject_typ
     or v_calc.cap_subject_id is distinct from v_subject_id then
    raise exception 'The reward calculation resolved a different cap subject than the locked accumulator'
      using errcode = 'internal_error';
  end if;

  -- The cache must not claim a bonus the evidence cannot show. Reconstructed from reward
  -- existence, exactly as the locked decision requires.
  select exists (
    select 1 from public.campaign_rewards r
    where r.campaign_version_id = v_eval.campaign_version_id
      and r.cap_subject_type = v_subject_typ
      and r.cap_subject_id = v_subject_id
      and r.rule_type = 'TARGET_BONUS'
  ) into v_target_seen;

  if v_acc.target_bonus_awarded and not v_target_seen then
    raise exception 'The accumulator claims a target bonus that no reward evidences'
      using errcode = 'check_violation';
  end if;

  -- ---- 7. AN EXISTING REWARD FOR THIS EVALUATION ------------------------------
  select * into v_existing
  from public.campaign_rewards r
  where r.campaign_sale_evaluation_id = p_campaign_sale_evaluation_id;

  if v_existing.id is not null then
    -- ---- 8/9. IDENTICAL, OR CONFLICTING --------------------------------------
    -- The compared fields are the ones that are pure functions of IMMUTABLE evidence:
    -- lineage, cap subject, the copied rule and the unit count. Two families are
    -- deliberately excluded, for two different reasons.
    --
    -- The AWARDED amount was a function of the headroom that existed at award time, and
    -- every reward granted since has legitimately moved that; recomputing it here and
    -- calling the difference a conflict would fail every honest replay.
    --
    -- The UNCAPPED amount is excluded because it is already pinned by the fields that ARE
    -- compared: campaign_rewards_uncapped_matches_rate forces coins_uncapped =
    -- coins_per_unit x units_counted, and campaign_rewards_uncapped_matches_tier forces
    -- coins_uncapped = configured_reward_coins. Agreeing on the rule and the units is
    -- therefore agreeing on the uncapped amount, at the table rather than here. It also
    -- must not be compared against a fresh calculation: units_before excludes this
    -- evaluation, so once a LATER sale has added units for the same subject, recomputing
    -- "did this sale cross the threshold?" answers a question about a different moment.
    -- The stored row is the record of the crossing; the recalculation is not.
    if v_existing.campaign_id             is distinct from v_calc.campaign_id
       or v_existing.campaign_version_id  is distinct from v_calc.campaign_version_id
       or v_existing.verified_sale_id     is distinct from v_calc.verified_sale_id
       or v_existing.receipt_submission_id is distinct from v_calc.receipt_submission_id
       or v_existing.vendor_organization_id   is distinct from v_calc.vendor_organization_id
       or v_existing.retailer_organization_id is distinct from v_calc.retailer_organization_id
       or v_existing.retailer_shop_id         is distinct from v_calc.retailer_shop_id
       or v_existing.beneficiary_profile_id   is distinct from v_calc.beneficiary_profile_id
       or v_existing.performance_scope        is distinct from v_calc.performance_scope
       or v_existing.cap_subject_type         is distinct from v_calc.cap_subject_type
       or v_existing.cap_subject_id           is distinct from v_calc.cap_subject_id
       or v_existing.rule_type                is distinct from v_calc.rule_type
       or v_existing.metric_type              is distinct from v_calc.metric_type
       or v_existing.coins_per_unit           is distinct from v_calc.coins_per_unit
       or v_existing.threshold_units          is distinct from v_calc.threshold_units
       or v_existing.configured_reward_coins  is distinct from v_calc.configured_reward_coins
       or v_existing.max_reward_coins         is distinct from v_calc.max_reward_coins
       or v_existing.units_counted            is distinct from v_calc.units_counted then
      raise exception 'A conflicting campaign reward already exists for that evaluation'
        using errcode = 'check_violation';
    end if;

    -- The accumulator must already reflect this reward, or the cache and the evidence
    -- disagree about a payment that has been made.
    if v_acc.units_counted_total is distinct from v_calc.units_after then
      raise exception 'The accumulator unit total % does not reconcile with the stored reward''s after-state %',
        v_acc.units_counted_total, v_calc.units_after
        using errcode = 'check_violation';
    end if;

    if v_acc.coins_awarded_total is distinct from v_calc.coins_before + v_existing.reward_coins then
      raise exception 'The accumulator coin total % does not reconcile with the stored reward',
        v_acc.coins_awarded_total
        using errcode = 'check_violation';
    end if;

    campaign_reward_id          := v_existing.id;
    campaign_sale_evaluation_id := v_existing.campaign_sale_evaluation_id;
    campaign_version_id         := v_existing.campaign_version_id;
    cap_subject_type            := v_existing.cap_subject_type;
    cap_subject_id              := v_existing.cap_subject_id;
    rule_type                   := v_existing.rule_type;
    units_counted               := v_existing.units_counted;
    units_before                := v_calc.units_before;
    units_after                 := v_calc.units_after;
    threshold_units             := v_existing.threshold_units;
    threshold_crossed           := v_existing.rule_type = 'TARGET_BONUS';
    coins_uncapped              := v_existing.coins_uncapped;
    cap_remaining_headroom      := v_calc.cap_remaining_headroom;
    coins_capped_to             := v_existing.coins_capped_to;
    reward_coins                := v_existing.reward_coins;
    coins_before                := v_calc.coins_before;
    coins_after                 := v_calc.coins_before + v_existing.reward_coins;
    reward_created              := true;
    application_result          := 'ALREADY_APPLIED';
    return next;
    return;
  end if;

  -- ---- THE NO-REWARD REPLAY ---------------------------------------------------
  -- No reward row, so the accumulator is the only witness. units_before and units_after
  -- differ by at least one, so exactly one of them can match.
  if v_acc.units_counted_total is distinct from v_calc.units_before then
    if v_acc.units_counted_total = v_calc.units_after
       and v_acc.coins_awarded_total = v_calc.coins_before
       and not v_calc.creates_reward then
      campaign_reward_id          := null;
      campaign_sale_evaluation_id := v_calc.campaign_sale_evaluation_id;
      campaign_version_id         := v_calc.campaign_version_id;
      cap_subject_type            := v_calc.cap_subject_type;
      cap_subject_id              := v_calc.cap_subject_id;
      rule_type                   := v_calc.rule_type;
      units_counted               := v_calc.units_counted;
      units_before                := v_calc.units_before;
      units_after                 := v_calc.units_after;
      threshold_units             := v_calc.threshold_units;
      threshold_crossed           := v_calc.threshold_crossed;
      coins_uncapped              := v_calc.coins_uncapped;
      cap_remaining_headroom      := v_calc.cap_remaining_headroom;
      coins_capped_to             := v_calc.coins_capped_to;
      reward_coins                := 0::bigint;
      coins_before                := v_calc.coins_before;
      coins_after                 := v_calc.coins_before;
      reward_created              := false;
      application_result          := 'ALREADY_APPLIED';
      return next;
      return;
    end if;

    raise exception 'The accumulator unit total % reconciles with neither the before-state % nor the after-state %',
      v_acc.units_counted_total, v_calc.units_before, v_calc.units_after
      using errcode = 'check_violation';
  end if;

  if v_acc.coins_awarded_total is distinct from v_calc.coins_before then
    raise exception 'The accumulator coin total % does not reconcile with the reward evidence %',
      v_acc.coins_awarded_total, v_calc.coins_before
      using errcode = 'check_violation';
  end if;

  -- ---- 10. INSERT THE IMMUTABLE REWARD ----------------------------------------
  v_created   := v_calc.creates_reward;
  v_units     := v_calc.units_counted;
  v_uncapped  := v_calc.coins_uncapped;
  v_capped_to := v_calc.coins_capped_to;
  v_reward    := v_calc.reward_coins;

  if v_created then
    insert into public.campaign_rewards (
      campaign_sale_evaluation_id,
      campaign_id, campaign_version_id, verified_sale_id, receipt_submission_id,
      vendor_organization_id, retailer_organization_id, retailer_shop_id,
      beneficiary_profile_id,
      performance_scope, cap_subject_type, cap_subject_id,
      rule_type, metric_type, coins_per_unit, threshold_units,
      configured_reward_coins, max_reward_coins,
      units_counted, coins_uncapped, coins_capped_to, reward_coins
    )
    values (
      v_calc.campaign_sale_evaluation_id,
      v_calc.campaign_id, v_calc.campaign_version_id, v_calc.verified_sale_id,
      v_calc.receipt_submission_id,
      v_calc.vendor_organization_id, v_calc.retailer_organization_id,
      v_calc.retailer_shop_id,
      v_calc.beneficiary_profile_id,
      v_calc.performance_scope, v_calc.cap_subject_type, v_calc.cap_subject_id,
      v_calc.rule_type, v_calc.metric_type, v_calc.coins_per_unit, v_calc.threshold_units,
      v_calc.configured_reward_coins, v_calc.max_reward_coins,
      v_units, v_uncapped, v_capped_to, v_reward
    )
    returning id into v_reward_id;
  else
    v_reward_id := null;
    v_reward    := 0::bigint;
  end if;

  -- ---- 11. THE ACCUMULATOR MOVES TO THE EXACT AFTER-STATE ----------------------
  -- UNITS ALWAYS INCREASE, including when the award is zero. A cap-exhausted sale and a
  -- pre-crossing TARGET_BONUS sale both qualified, and both must keep counting towards
  -- the totals the campaign is measured on; the coins are what the cap withheld, not the
  -- units. COINS increase by the FINAL awarded amount alone — never by coins_uncapped,
  -- which is evidence of what the rule produced and not of what was granted.
  --
  -- The target flag is written from the EVIDENCE — a TARGET_BONUS reward already existed,
  -- or one is being inserted now — rather than carried forward from its own previous
  -- value. A cache that had drifted false is therefore repaired to what the rewards say,
  -- which is the only direction Migration 65 permits: the evidence is authoritative and
  -- this table is rebuilt from it.
  update public.campaign_subject_accumulators a
     set units_counted_total = v_calc.units_after,
         coins_awarded_total = v_calc.coins_before + v_reward,
         target_bonus_awarded = v_target_seen
                                or (v_created and v_calc.rule_type = 'TARGET_BONUS')
   where a.campaign_version_id = v_eval.campaign_version_id
     and a.cap_subject_type = v_subject_typ
     and a.cap_subject_id = v_subject_id;

  -- ---- 12. THE STORED RESULT ---------------------------------------------------
  campaign_reward_id          := v_reward_id;
  campaign_sale_evaluation_id := v_calc.campaign_sale_evaluation_id;
  campaign_version_id         := v_calc.campaign_version_id;
  cap_subject_type            := v_calc.cap_subject_type;
  cap_subject_id              := v_calc.cap_subject_id;
  rule_type                   := v_calc.rule_type;
  units_counted               := v_units;
  units_before                := v_calc.units_before;
  units_after                 := v_calc.units_after;
  threshold_units             := v_calc.threshold_units;
  threshold_crossed           := v_calc.threshold_crossed;
  coins_uncapped              := v_uncapped;
  cap_remaining_headroom      := v_calc.cap_remaining_headroom;
  coins_capped_to             := v_capped_to;
  reward_coins                := v_reward;
  coins_before                := v_calc.coins_before;
  coins_after                 := v_calc.coins_before + v_reward;
  reward_created              := v_created;
  application_result          := 'APPLIED';

  return next;
  return;
end;
$$;

revoke all     on function public.campaign_apply_reward_for_evaluation(uuid) from public;
revoke execute on function public.campaign_apply_reward_for_evaluation(uuid) from anon;
revoke execute on function public.campaign_apply_reward_for_evaluation(uuid) from authenticated;
revoke execute on function public.campaign_apply_reward_for_evaluation(uuid) from service_role;

comment on function public.campaign_apply_reward_for_evaluation(uuid) is
  'Internal, owner-execute-only. Applies the reward for one QUALIFIED campaign sale evaluation inside the caller''s transaction: resolves the cap subject from performance_scope, ensures the campaign_subject_accumulators row with insert-on-conflict, locks exactly that one row with SELECT ... FOR UPDATE, recalculates from the state visible after the lock, and then either returns an existing identical reward idempotently, raises on a conflicting one, or inserts the immutable campaign_rewards row. The accumulator then moves to the exact after-state: units always increase by the evaluation''s qualifying units even when the award is zero, and coins increase only by the final awarded amount. A TARGET_BONUS sale that crosses nothing writes no reward and is recognised on replay by reconciling the accumulator against the calculated before and after states; anything that reconciles with neither raises rather than being repaired. Posts nothing to any ledger and creates no evaluation, item, permission or audit row.';
