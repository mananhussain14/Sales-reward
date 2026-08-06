-- Migration: receipt_keyed_campaign_evaluation_rpcs
-- Purpose: Phase 2A-E. THE KEY THE BROWSER ACTUALLY HOLDS. Three thin wrappers that
--          take a receipt id, resolve its one verified sale internally, and delegate
--          every decision to the Migration 68 functions unchanged.
--
--   1 browser RPC   evaluate_receipt_campaigns(uuid)                 VOLATILE
--   2 browser reads get_receipt_campaign_results(uuid)               STABLE
--                   get_receipt_campaign_qualifying_items(uuid)      STABLE
--
--   0 tables. 0 views. 0 indexes. 0 policies. 0 permissions. 0 role_permissions.
--   0 table privileges. 0 changes to any Migration 66, 67 or 68 function.
--
-- ============================================================================
-- WHY THIS MIGRATION EXISTS
-- ============================================================================
-- Migration 68 keyed its three browser functions on p_verified_sale_id. The Claim
-- Reviewer flow is keyed on receipt_submission_id from end to end — the queue, the
-- detail page and all five existing reads take the receipt id — and the browser has
-- no way to obtain a verified sale id:
--
--   * public.verified_sales carries RLS with ZERO policies and `authenticated` holds
--     no SELECT on it, so the id cannot be read from the table;
--   * no `authenticated`-callable function RETURNS a verified sale id except
--     evaluate_verified_sale_campaigns itself, which REQUIRES one as input;
--   * every Phase 1D reviewer read deliberately returns no internal foreign key at
--     all — "no Vendor, Retailer, shop, product, profile, confirmation, sale or
--     decision id", as get_verified_sale_items puts it.
--
-- So the deployed contract was unreachable from the only surface meant to call it.
-- These wrappers close that gap and nothing else.
--
-- ============================================================================
-- WHAT A WRAPPER IS ALLOWED TO DO, AND WHAT IT IS NOT
-- ============================================================================
-- Each one does exactly two things: turn a receipt id into a verified sale id, and
-- call its single Migration 68 counterpart. That is the whole body.
--
-- NO authorization of its own. Not a permission check, not a role check, not a
-- Vendor comparison, not a membership test. Migration 68 remains the SOLE execution
-- and authorization authority, and a second copy of that logic here would be a
-- second thing to keep in step with it — the exact failure this phase has avoided at
-- every layer. A wrapper that authorized would also be a wrapper that could
-- accidentally authorize MORE.
--
-- NO campaign matching, temporal eligibility, exclusivity, reward arithmetic, cap
-- calculation or accumulator access. NO insert or update of evaluation, item,
-- reward, accumulator or audit rows. Those belong to Migrations 66, 67 and 68 and
-- are not repeated, re-derived or reached past.
--
-- ============================================================================
-- THE RESOLVER READS verified_sales, AND WHY THAT IS NOT AN ESCALATION
-- ============================================================================
-- These functions are SECURITY DEFINER, so the internal SELECT on public.verified_sales
-- succeeds where the caller's own SELECT would not. Three properties make that safe,
-- and all three are asserted by the suite:
--
--   1. THE ID NEVER LEAVES. verified_sale_id is projected AWAY from every return
--      contract. A caller receives exactly the columns Migration 68 returns minus
--      that one, so nothing here hands the browser an internal key it could then use
--      to address a sale directly.
--
--   2. THE READ DECIDES NOTHING. Resolving the id grants no access to it. Whatever
--      comes back is passed to a Migration 68 function that authorizes from
--      auth.uid() exactly as before, so a reviewer sees precisely what they saw when
--      the same call was keyed on the sale id — no more, and no fewer.
--
--   3. FAILING TO RESOLVE IS INDISTINGUISHABLE FROM BEING REFUSED. See below.
--
-- The table itself stays unexposed: no policy, no grant, no view, no other path.
--
-- ============================================================================
-- ONE RECEIPT, AT MOST ONE SALE — AND IT IS AN INDEX, NOT AN ASSUMPTION
-- ============================================================================
-- verified_sales_receipt_unique_idx is UNIQUE on (receipt_submission_id), so the
-- resolution below is total: zero rows or exactly one, never a choice. There is no
-- ORDER BY and no LIMIT anywhere in these functions, because a second row is
-- unstorable rather than merely unlikely — had it been possible, picking one would
-- have made which sale a reviewer evaluated depend on the planner.
--
-- ============================================================================
-- THE REFUSAL CONVENTIONS ARE INHERITED, NOT INVENTED
-- ============================================================================
-- EXECUTION collapses every refusal into ONE 42501, exactly as
-- evaluate_verified_sale_campaigns and finalize_claim_receipt_sale_items already do.
-- A null id, a receipt that does not exist, a receipt with no verified sale yet, a
-- receipt belonging to another Vendor and a caller who is not a reviewer all raise
-- the SAME error with the SAME message. That is what stops the wrapper becoming the
-- oracle the RPC beneath it is careful not to be: "no such receipt" and "not yours"
-- must not be tellable apart, and neither must "not finalized yet".
--
-- READS return ZERO ROWS for every one of those causes and raise nothing at all,
-- matching get_verified_sale_items, get_claim_receipt_sale_context and every other
-- reviewer read in this schema.


-- ============================================================================
-- A — THE EXECUTION WRAPPER
-- ============================================================================
-- Returns the Migration 68 execution contract MINUS verified_sale_id: 13 columns
-- instead of 14. receipt_submission_id survives because the caller already knows it
-- — it is what they passed in — and a screen benefits from being able to confirm the
-- answer is about the receipt it asked about.
create function public.evaluate_receipt_campaigns(
  p_submission_id uuid
)
returns table (
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
  v_sale_id uuid;
begin
  -- ---- RESOLVE, OR REFUSE INDISTINGUISHABLY --------------------------------
  -- A null id short-circuits into the same refusal rather than a different one: a
  -- caller who can tell "you sent nothing" from "that is not yours" has learned
  -- something, and there is nothing here worth learning.
  if p_submission_id is not null then
    select v.id into v_sale_id
    from public.verified_sales v
    where v.receipt_submission_id = p_submission_id;
  end if;

  -- Unknown receipt, receipt with no finalized sale yet, and null id — one answer,
  -- and it is the SAME 42501 the delegate raises for "not a reviewer" and "not your
  -- Vendor". The message is deliberately identical to the delegate's own.
  if v_sale_id is null then
    raise exception 'This sale is not available for campaign evaluation'
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- DELEGATE ------------------------------------------------------------
  -- Everything that matters happens in there: the permission checks, the Vendor
  -- isolation, the verified_sales row lock, the finalization and exclusion
  -- re-checks, the evidence writes, the Migration 67 reward application, the
  -- idempotent replay and the audit entry. This function adds none of it and
  -- removes none of it.
  --
  -- verified_sale_id is the one column not selected. Every other column is passed
  -- through in the delegate's own order and type.
  return query
  select e.receipt_submission_id,
         e.campaign_sale_evaluation_id,
         e.campaign_id,
         e.campaign_version_id,
         e.outcome,
         e.non_qualification_reason,
         e.qualifying_item_count,
         e.qualifying_units,
         e.campaign_reward_id,
         e.reward_coins,
         e.reward_created,
         e.evaluation_created,
         e.application_result
  from public.evaluate_verified_sale_campaigns(v_sale_id) e;
end;
$$;

revoke all     on function public.evaluate_receipt_campaigns(uuid) from public;
revoke execute on function public.evaluate_receipt_campaigns(uuid) from anon;
grant  execute on function public.evaluate_receipt_campaigns(uuid) to authenticated;

comment on function public.evaluate_receipt_campaigns(uuid) is
  'Browser RPC. The receipt-keyed door to campaign evaluation: resolves the receipt''s one verified sale through the unique verified_sales receipt index and delegates entirely to evaluate_verified_sale_campaigns, which remains the sole authorization, locking, evidence, reward, idempotency and audit authority. Returns that function''s contract minus verified_sale_id, so no internal sale key reaches the browser. A null id, an unknown receipt, a receipt with no finalized sale, a foreign Vendor and a caller without permission all raise the same collapsed 42501. Performs no authorization, campaign matching, reward arithmetic or accumulator access of its own, and writes nothing.';


-- ============================================================================
-- B — THE RESULT READ WRAPPER
-- ============================================================================
-- The full 16-column reviewer result contract, unchanged. Ordering is the
-- delegate's — campaign priority DESC, campaign_starts_at ASC, campaign_version_id
-- ASC — and no ORDER BY is added here, because re-sorting a set that already has a
-- deterministic order is how two screens come to disagree about the same sale.
create function public.get_receipt_campaign_results(
  p_submission_id uuid
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
  v_sale_id uuid;
begin
  if p_submission_id is not null then
    select v.id into v_sale_id
    from public.verified_sales v
    where v.receipt_submission_id = p_submission_id;
  end if;

  -- ZERO ROWS, never an error. Null, unknown, unfinalized, foreign and unauthorized
  -- are one answer here exactly as they are in every other reviewer read.
  if v_sale_id is null then
    return;
  end if;

  return query
  select r.campaign_id,
         r.campaign_version_id,
         r.campaign_name,
         r.outcome,
         r.non_qualification_reason,
         r.qualifying_item_count,
         r.qualifying_units,
         r.rule_type,
         r.coins_per_unit,
         r.threshold_units,
         r.configured_reward_coins,
         r.max_reward_coins,
         r.coins_uncapped,
         r.coins_capped_to,
         r.reward_coins,
         r.awarded_at
  from public.get_verified_sale_campaign_results(v_sale_id) r;
end;
$$;

revoke all     on function public.get_receipt_campaign_results(uuid) from public;
revoke execute on function public.get_receipt_campaign_results(uuid) from anon;
grant  execute on function public.get_receipt_campaign_results(uuid) to authenticated;

comment on function public.get_receipt_campaign_results(uuid) is
  'Browser read. The receipt-keyed form of get_verified_sale_campaign_results: resolves the receipt''s one verified sale and delegates, returning that function''s 16-column contract and its deterministic ordering unchanged. Zero rows for a null id, an unknown receipt, a receipt with no finalized sale, a foreign Vendor or a caller without RECEIPT_REVIEW_READ — it raises nothing. Exposes no verified sale id, no accumulator row and no other tenant, and re-implements none of the delegate''s joins or authorization.';


-- ============================================================================
-- C — THE QUALIFYING-ITEM READ WRAPPER
-- ============================================================================
create function public.get_receipt_campaign_qualifying_items(
  p_submission_id uuid
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
  v_sale_id uuid;
begin
  if p_submission_id is not null then
    select v.id into v_sale_id
    from public.verified_sales v
    where v.receipt_submission_id = p_submission_id;
  end if;

  if v_sale_id is null then
    return;
  end if;

  -- campaign_sale_evaluation_id is NOT in the delegate's contract, so it is not in
  -- this one either. Items are matched to a campaign by (campaign_id,
  -- campaign_version_id), which the delegate returns on every row and which is
  -- exactly the key the result read is grouped by — never by display name.
  return query
  select i.campaign_id,
         i.campaign_version_id,
         i.verified_sale_item_id,
         i.vendor_product_id,
         i.product_code_at_proposal,
         i.product_name_at_proposal,
         i.line_number,
         i.qualifying_units,
         i.product_source,
         i.product_status_at_sale,
         i.assignment_status_at_sale
  from public.get_verified_sale_campaign_qualifying_items(v_sale_id) i;
end;
$$;

revoke all     on function public.get_receipt_campaign_qualifying_items(uuid) from public;
revoke execute on function public.get_receipt_campaign_qualifying_items(uuid) from anon;
grant  execute on function public.get_receipt_campaign_qualifying_items(uuid) to authenticated;

comment on function public.get_receipt_campaign_qualifying_items(uuid) is
  'Browser read. The receipt-keyed form of get_verified_sale_campaign_qualifying_items: resolves the receipt''s one verified sale and delegates, returning that function''s 11-column contract and its deterministic ordering unchanged. Items carry (campaign_id, campaign_version_id) so a caller groups them by campaign key rather than by display name. Zero rows for a null id, an unknown receipt, a receipt with no finalized sale, a foreign Vendor or a caller without RECEIPT_REVIEW_READ — it raises nothing. Exposes no verified sale id and no accumulator row.';
