-- Migration: sales_staff_campaigns_earnings_reads
-- Purpose: Phase 2B. What a Sales Staff member has EARNED — the shared backend read
--          surface the Web Sales Staff portal and the Flutter app will both consume.
--
--   1 permission    STAFF_EARNINGS_VIEW  -> SALES_STAFF, and nothing else
--   1 internal fn   sales_staff_earnings_profile()                      STABLE
--   3 browser/mobile reads
--                   get_my_campaign_rewards(integer, timestamptz, uuid) STABLE
--                   get_my_campaign_earnings_summary()                  STABLE
--                   get_my_campaign_target_progress()                   STABLE
--
--   0 tables. 0 views. 0 indexes. 0 policies. 0 table grants. 0 writes of any kind.
--   No wallet, ledger, balance, payout, redemption or withdrawal object.
--
-- ============================================================================
-- WHAT THIS MIGRATION DOES NOT ADD, AND WHY
-- ============================================================================
-- CURRENT CAMPAIGNS AND CAMPAIGN PRODUCTS ALREADY EXIST. Migration 30
-- (20260815210000_vendor_campaign_operations) shipped the Sales Staff campaign surface:
--
--   list_my_staff_campaigns()                 19 columns, ACTIVE + SCHEDULED
--   get_my_staff_campaign(uuid)               the same 19 columns for one campaign
--   list_my_staff_campaign_products(uuid)     SNAPSHOT and LIVE_TEMPORAL both handled
--
-- All three already resolve the caller through resolve_retailer_member_organization(
-- 'STAFF_CAMPAIGNS_VIEW'), already restrict to campaign_eligible_retailers — the FROZEN
-- publication snapshot — and already require c.published_version_id = cv.id, which
-- excludes drafts structurally rather than by predicate. Re-implementing any of it here
-- would give one rule two owners, which is the failure this phase has avoided at every
-- layer. They are left exactly as they are and this migration adds nothing that overlaps
-- them.
--
-- ============================================================================
-- WHAT THE DEPLOYED MODEL DOES AND DOES NOT SUPPORT
-- ============================================================================
-- Read off the deployed schema rather than assumed:
--
--   * CAMPAIGNS TARGET RETAILERS, NEVER SHOPS. No campaign configuration table carries
--     a shop column at all — the only shop columns in the campaign namespace are on
--     campaign_sale_evaluations and campaign_rewards, and those record where a sale
--     HAPPENED, not who a campaign was aimed at. So there is no shop-level campaign
--     targeting to honour, and none is invented here.
--
--   * A STAFF MEMBER MAY BELONG TO SEVERAL SHOPS. retailer_shop_members is unique on
--     (organization_member_id, retailer_shop_id) WHERE removed_at IS NULL, so multiple
--     live rows per member are legal. Since campaigns are Retailer-scoped, shop
--     membership changes nothing about what a seller may see.
--
--   * ONE RETAILER, OR NOTHING. resolve_retailer_member_organization returns a row only
--     when EXACTLY ONE active Retailer qualifies, so a member of two Retailers resolves
--     to NULL and is refused rather than silently shown one of them.
--
-- ============================================================================
-- EARNED IS NOT A BALANCE
-- ============================================================================
-- Every number below is the sum of immutable campaign_rewards.reward_coins rows that
-- already exist. Nothing here is a wallet, a balance, an available amount, a redeemable
-- amount, a payable amount or a settled amount, and no column is named as though it
-- were. Nothing is subtracted, because there is nothing to subtract from: no ledger and
-- no redemption model exists, and inventing one in a read would be inventing money.
-- The column names say reward_coins and earnings, deliberately and throughout.
--
-- ============================================================================
-- WHY REWARD HISTORY IS FILTERED ON THE PROFILE AND NOT ON THE RETAILER
-- ============================================================================
-- Locked rule 3 says a seller sees rewards whose beneficiary_profile_id is their own.
-- Locked rule 7 says historical rewards stay visible when the Retailer relationship
-- later changes. Those two together mean the DATA filter is the profile alone: a seller
-- who moved from one Retailer to another keeps the earnings they made at the first, and
-- filtering on the current Retailer would silently delete their own history from them.
--
-- The Retailer resolver is still used — as the AUTHORIZATION GATE, proving the caller is
-- an active Sales Staff member of exactly one active Retailer right now. It is not used
-- as a row filter for rewards, and the two roles are kept visibly separate below.


-- ============================================================================
-- PART 1 — THE PERMISSION
-- ============================================================================
-- Narrow and separate from STAFF_CAMPAIGNS_VIEW. Seeing which campaigns are running is
-- a different question from seeing what you personally earned, and a future role that
-- should see one without the other must be expressible without a code change.
insert into public.permissions (code, name, description, module)
values
  (
    'STAFF_EARNINGS_VIEW',
    'View my campaign earnings',
    'Read the campaign rewards awarded to the signed-in Sales Staff member, their own earnings totals, and their own or their Retailer team''s progress towards a campaign target. Grants no ability to evaluate a sale, create or change a reward, see another staff member''s earnings, or redeem, withdraw or transfer anything.',
    'RETAILER_PORTAL'
  )
on conflict (code) do update
set
  name        = excluded.name,
  description = excluded.description,
  module      = excluded.module,
  updated_at  = now();

-- SALES_STAFF AND NOTHING ELSE.
--
-- Not RETAILER_OWNER or RETAILER_MANAGER: this surface answers "what did I earn", and a
-- manager reading it would be reading one named person's earnings through an endpoint
-- that was never designed to be supervisory. A Retailer-wide earnings view, if it is
-- ever wanted, is a different contract with a different audience and its own decisions
-- about what may be shown about a named employee.
--
-- Not CLAIM_REVIEWER or VENDOR_SUPER_ADMIN: neither is a beneficiary, and the reviewer
-- already reads reward evidence through the Claim Review surface.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'STAFF_EARNINGS_VIEW'
where r.code = 'SALES_STAFF'
on conflict (role_id, permission_id) do nothing;


-- ============================================================================
-- PART 2 — THE CONTEXT HELPER
-- ============================================================================
-- The signed-in Sales Staff member's own profile id, or NULL.
--
-- NULL is the single answer for signed out, no profile, suspended profile, suspended
-- membership, inactive organization, a Vendor organization, inactive role, this role
-- does not hold STAFF_EARNINGS_VIEW, zero qualifying Retailers AND more than one — the
-- resolver it delegates to collapses all of them, and this adds nothing to that list.
--
-- It takes NO ARGUMENTS. There is no profile, Retailer, Vendor, shop or permission
-- parameter for a caller to supply, so nothing about the identity can be nominated.
create function public.sales_staff_earnings_profile()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  -- auth.uid() is returned only once the resolver has confirmed the caller is an active
  -- Sales Staff member of exactly one active Retailer holding the permission. The
  -- resolver answers WHICH Retailer; this answers WHO, which is what the reward filter
  -- needs and what the Retailer id must never be used as.
  select auth.uid()
  where public.resolve_retailer_member_organization('STAFF_EARNINGS_VIEW') is not null;
$$;

revoke all     on function public.sales_staff_earnings_profile() from public;
revoke execute on function public.sales_staff_earnings_profile() from anon;
revoke execute on function public.sales_staff_earnings_profile() from authenticated;
revoke execute on function public.sales_staff_earnings_profile() from service_role;

comment on function public.sales_staff_earnings_profile() is
  'Internal, owner-execute-only. The signed-in Sales Staff member''s own profile id, or NULL when they are not an active Sales Staff member of exactly one active Retailer holding STAFF_EARNINGS_VIEW. Takes no arguments, so no identity may be supplied by a caller.';


-- ============================================================================
-- PART 3 — MY CAMPAIGN REWARDS
-- ============================================================================
-- The seller's own reward history, newest first, bounded and keyset-paginated.
--
-- ---- WHY KEYSET AND NOT OFFSET ---------------------------------------------
-- Rewards are append-only and arrive while a seller is scrolling, so an OFFSET page 2
-- would silently repeat or skip rows the moment a new reward landed. The cursor is
-- (awarded_at, campaign_reward_id) — the same pair the ORDER BY uses, with the uuid
-- making it total, so no two rows can tie and no row can be visited twice.
--
-- ---- WHAT IS NOT RETURNED --------------------------------------------------
-- No cap_subject_type and no cap_subject_id: they are internal accumulator keys, and
-- under RETAILER_TEAM the subject is the Retailer, which would tell a seller nothing
-- true about their own reward. No campaign_sale_evaluation_id, no Vendor, Retailer or
-- beneficiary id, no storage path, no reviewer identity and no evaluation internals.
--
-- AND NO verified_sale_id. Migration 69 (20260827090000) exists for one reason: to keep
-- that key out of a browser, resolving it in SQL from the receipt instead. Returning it
-- to a Sales Staff client here would give away in a reward list exactly what three
-- wrapper functions were written to withhold from a reviewer.
--
-- The receipt id IS returned in its place. It is UNIQUE PER VERIFIED SALE — the same
-- index Migration 69 resolves through — so it groups and navigates identically, and the
-- seller submitted that receipt and already reads it through get_my_receipt_submission.
create function public.get_my_campaign_rewards(
  p_limit              integer     default 50,
  p_before_awarded_at  timestamptz default null,
  p_before_reward_id   uuid        default null
)
returns table (
  campaign_reward_id      uuid,
  campaign_id             uuid,
  campaign_version_id     uuid,
  campaign_name           text,
  receipt_submission_id   uuid,
  shop_name               text,
  sale_at                 timestamptz,
  awarded_at              timestamptz,
  rule_type               text,
  performance_scope       text,
  qualifying_item_count   integer,
  qualifying_units        integer,
  coins_uncapped          bigint,
  coins_capped_to         bigint,
  reward_coins            bigint,
  threshold_units         integer,
  configured_reward_coins bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile uuid;
  v_limit   integer;
begin
  v_profile := public.sales_staff_earnings_profile();

  -- ZERO ROWS, never an error, matching every other Sales Staff read in this schema.
  if v_profile is null then
    return;
  end if;

  -- CLAMPED, not rejected. A client that asks for 100000 rows gets 100, and one that
  -- asks for 0 or a negative gets the default — a page size is a display preference and
  -- refusing it would break a screen over something harmless. The ceiling is what stops
  -- one call walking an entire history.
  v_limit := case
               when p_limit is null or p_limit < 1 then 50
               when p_limit > 100                  then 100
               else p_limit
             end;

  return query
  select
    w.id,
    w.campaign_id,
    w.campaign_version_id,
    c.name,
    w.receipt_submission_id,
    s.name,
    v.sale_at,
    w.awarded_at,
    w.rule_type,
    w.performance_scope,
    -- The ITEM COUNT lives on the evaluation, not on the reward: a reward records the
    -- units it paid on and the evaluation records how many lines produced them. Joined
    -- rather than recomputed, so the two can never disagree.
    e.qualifying_item_count,
    w.units_counted,
    w.coins_uncapped,
    w.coins_capped_to,
    w.reward_coins,
    w.threshold_units,
    w.configured_reward_coins
  from public.campaign_rewards w
  join public.campaigns c on c.id = w.campaign_id
  join public.verified_sales v on v.id = w.verified_sale_id
  join public.campaign_sale_evaluations e on e.id = w.campaign_sale_evaluation_id
  left join public.retailer_shops s on s.id = w.retailer_shop_id
  -- THE ONE ROW FILTER. Not the Retailer, not the shop, not the campaign: the
  -- beneficiary. A seller who changed Retailer keeps their own history, and no seller
  -- can reach another's by any combination of arguments, because there is no argument
  -- that names a person.
  where w.beneficiary_profile_id = v_profile
    and (
      p_before_awarded_at is null
      or p_before_reward_id is null
      or (w.awarded_at, w.id) < (p_before_awarded_at, p_before_reward_id)
    )
  order by w.awarded_at desc, w.id desc
  limit v_limit;
end;
$$;

revoke all     on function public.get_my_campaign_rewards(integer, timestamptz, uuid) from public;
revoke execute on function public.get_my_campaign_rewards(integer, timestamptz, uuid) from anon;
grant  execute on function public.get_my_campaign_rewards(integer, timestamptz, uuid) to authenticated;

comment on function public.get_my_campaign_rewards(integer, timestamptz, uuid) is
  'Browser and mobile read. The signed-in Sales Staff member''s OWN campaign rewards, newest first, keyset-paginated on (awarded_at, campaign_reward_id) and clamped to at most 100 rows. Filtered on campaign_rewards.beneficiary_profile_id alone, so history survives a change of Retailer and no argument can name another person. Sales are identified by receipt id, never by verified_sale_id, which Migration 69 deliberately keeps out of client hands. Returns the stored reward evidence — rule, units, uncapped, capped and final coins — and never a cap subject, a verified sale id, an evaluation id, another beneficiary or an accumulator. Reads only; creates and changes nothing, and is not a balance.';


-- ============================================================================
-- PART 4 — MY EARNINGS SUMMARY
-- ============================================================================
-- One row. Every value is a sum or count over the seller's OWN immutable reward rows.
--
-- ---- THE MONTH BOUNDARY IS RETURNED, NOT ASSUMED ---------------------------
-- "This month" needs a timezone, and this schema has no single one to offer a seller:
-- retailer_shops each carry their own IANA zone and retailer_shop_members lets one
-- member belong to SEVERAL shops, so there is no unambiguous "the seller's timezone" to
-- read. Rather than pick one silently and be quietly wrong for somebody, the window is
-- computed in UTC and its exact bounds are RETURNED, so a client can label the period it
-- is showing and recompute locally if it ever needs to.
create function public.get_my_campaign_earnings_summary()
returns table (
  total_reward_coins         bigint,
  current_month_reward_coins bigint,
  rewarded_sale_count        integer,
  rewarded_campaign_count    integer,
  latest_reward_at           timestamptz,
  current_month_start_utc    timestamptz,
  current_month_end_utc      timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile uuid;
  v_start   timestamptz;
  v_end     timestamptz;
begin
  v_profile := public.sales_staff_earnings_profile();

  if v_profile is null then
    return;
  end if;

  v_start := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_end   := v_start + interval '1 month';

  return query
  select
    -- coalesce so a seller with no rewards reads 0 rather than NULL. Zero earned is a
    -- true and ordinary answer; NULL would render as an empty box.
    coalesce(sum(w.reward_coins), 0)::bigint,
    coalesce(sum(w.reward_coins) filter (
      where w.awarded_at >= v_start and w.awarded_at < v_end), 0)::bigint,
    -- DISTINCT sales and campaigns, not row counts: two campaigns paying on one sale is
    -- one rewarded sale, and one campaign paying on ten sales is one rewarded campaign.
    count(distinct w.verified_sale_id)::integer,
    count(distinct w.campaign_id)::integer,
    max(w.awarded_at),
    v_start,
    v_end
  from public.campaign_rewards w
  where w.beneficiary_profile_id = v_profile;
end;
$$;

revoke all     on function public.get_my_campaign_earnings_summary() from public;
revoke execute on function public.get_my_campaign_earnings_summary() from anon;
grant  execute on function public.get_my_campaign_earnings_summary() to authenticated;

comment on function public.get_my_campaign_earnings_summary() is
  'Browser and mobile read. One row of the signed-in Sales Staff member''s OWN campaign earnings: total reward coins, coins awarded in the current UTC calendar month, distinct rewarded sales, distinct rewarded campaigns and the latest award instant, with the month window returned so a client can label it. Derived only from campaign_rewards rows whose beneficiary is the caller. These are coins EARNED — not a wallet, balance, available, redeemable, payable or settled amount — and nothing is subtracted, because no ledger or redemption model exists.';


-- ============================================================================
-- PART 5 — MY TARGET PROGRESS
-- ============================================================================
-- How far a TARGET_BONUS campaign has got, for the campaigns the seller can already see.
--
-- ---- WHY THIS IS SAFE TO EXPOSE, AND WHAT IS WITHHELD -----------------------
-- campaign_subject_accumulators is an internal cache keyed by (campaign_version_id,
-- cap_subject_type, cap_subject_id), and Migration 65 is explicit that it must never be
-- read as proof that somebody was paid. Two of its three facts can nonetheless be shown
-- truthfully, and one cannot:
--
--   units_counted_total   SAFE. Under INDIVIDUAL_STAFF the subject IS this seller, so it
--                         is their own qualifying units. Under RETAILER_TEAM the subject
--                         is their own Retailer, and team units are precisely what the
--                         team target measures — performance_scope is returned so a
--                         screen can say which it is showing.
--
--   target_bonus_awarded  NOT RETURNED. It is a per-SUBJECT flag: under RETAILER_TEAM it
--                         goes true when ANY team member crosses, which a seller would
--                         read as "I was paid". What is returned instead is
--                         bonus_awarded_to_me, reconstructed from the existence of a
--                         TARGET_BONUS reward whose beneficiary is the caller — the same
--                         evidence-first rule Migration 67 applies to itself.
--
--   coins_awarded_total   NOT RETURNED, under any name. Under RETAILER_TEAM it is the
--                         whole team's coins and would be mistaken for personal
--                         earnings; the earnings summary above is the only place a coin
--                         total belongs.
--
-- cap_subject_type and cap_subject_id are never returned either. The seller receives
-- normalized progress and nothing that identifies how it is stored.
--
-- ---- VISIBILITY MIRRORS THE CAMPAIGN LIST ----------------------------------
-- Same frozen campaign_eligible_retailers snapshot, same published-version join, same
-- ACTIVE/SCHEDULED derived-state filter as list_my_staff_campaigns, so a client can join
-- these rows to that list one-to-one on campaign_id. Only TARGET_BONUS campaigns appear:
-- a PER_UNIT_COINS campaign has no threshold to progress towards, and showing one a
-- progress bar would be inventing a goal the Vendor never set.
create function public.get_my_campaign_target_progress()
returns table (
  campaign_id             uuid,
  campaign_version_id     uuid,
  campaign_name           text,
  performance_scope       text,
  target_units            integer,
  configured_reward_coins bigint,
  progress_units          bigint,
  target_reached          boolean,
  bonus_awarded_to_me     boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_profile  uuid;
  v_retailer uuid;
begin
  v_profile := public.sales_staff_earnings_profile();

  if v_profile is null then
    return;
  end if;

  -- The Retailer is needed for TEAM progress and for the campaign targeting join. It is
  -- resolved from the caller, never supplied.
  v_retailer := public.resolve_retailer_member_organization('STAFF_EARNINGS_VIEW');

  if v_retailer is null then
    return;
  end if;

  return query
  select
    c.id,
    cv.id,
    c.name,
    cv.performance_scope,
    t.threshold_units,
    t.reward_coins,
    coalesce(a.units_counted_total, 0)::bigint,
    coalesce(a.units_counted_total, 0) >= t.threshold_units,
    exists (
      select 1
      from public.campaign_rewards w
      where w.campaign_version_id = cv.id
        and w.beneficiary_profile_id = v_profile
        and w.rule_type = 'TARGET_BONUS'
    )
  from public.campaign_eligible_retailers er
  join public.campaign_versions cv on cv.id = er.campaign_version_id
  join public.campaigns c
    on c.id = cv.campaign_id and c.published_version_id = cv.id
  join public.campaign_rules r
    on r.campaign_version_id = cv.id and r.sequence = 1 and r.rule_type = 'TARGET_BONUS'
  join public.campaign_rule_tiers t
    on t.campaign_rule_id = r.id and t.tier_number = 1
  -- LEFT, because no accumulator row exists until the first qualifying sale is applied.
  -- Absent means zero progress, which is exactly right and must not drop the campaign.
  left join public.campaign_subject_accumulators a
    on a.campaign_version_id = cv.id
   and a.cap_subject_type = case cv.performance_scope
                              when 'INDIVIDUAL_STAFF' then 'SALES_STAFF_PROFILE'
                              else 'RETAILER_ORGANIZATION'
                            end
   and a.cap_subject_id = case cv.performance_scope
                            when 'INDIVIDUAL_STAFF' then v_profile
                            else v_retailer
                          end
  where er.retailer_organization_id = v_retailer
    and public.campaign_derived_state(c.status, cv.starts_at, cv.ends_at)
        in ('ACTIVE', 'SCHEDULED')
  order by cv.starts_at, c.name, c.id;
end;
$$;

revoke all     on function public.get_my_campaign_target_progress() from public;
revoke execute on function public.get_my_campaign_target_progress() from anon;
grant  execute on function public.get_my_campaign_target_progress() to authenticated;

comment on function public.get_my_campaign_target_progress() is
  'Browser and mobile read. Progress towards each TARGET_BONUS campaign the signed-in Sales Staff member can already see, using the same frozen Retailer targeting, published-version join and ACTIVE/SCHEDULED filter as list_my_staff_campaigns so the rows join one-to-one on campaign_id. Progress units come from the accumulator subject the campaign''s own performance_scope selects — the seller under INDIVIDUAL_STAFF, their Retailer under RETAILER_TEAM — and bonus_awarded_to_me is reconstructed from the existence of a TARGET_BONUS reward whose beneficiary is the caller, never from the per-subject accumulator flag. Never returns cap_subject_type, cap_subject_id, the accumulator''s target flag or any coin total.';
