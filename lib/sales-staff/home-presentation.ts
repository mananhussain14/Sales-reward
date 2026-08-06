/**
 * PURE MODULE — no imports beyond sibling types, no I/O, no Supabase client.
 *
 * How the Sales Staff Home decides WHAT TO LEAD WITH. Every function is total,
 * deterministic and unit-tested by being called.
 *
 * ============================================================================
 * A PRESENTATION RULE, NOT A RECOMMENDATION
 * ============================================================================
 * `selectHeroOpportunity` is three ordered FILTERS over the order the backend already
 * returned. Nothing is scored, ranked, weighted, or compared against another campaign,
 * and nothing about the reading seller enters the choice. A campaign that is first here
 * is first because `list_my_staff_campaigns()` returned it first — which is the only
 * ordering this application has any authority to present.
 *
 * There is deliberately no `.sort()` in this file. Re-ordering the backend's list would
 * be inventing a priority the contract does not express, and a seller who was shown "your
 * best campaign" would reasonably believe somebody had computed that.
 */
import type { AssignedCampaign } from "@/lib/campaigns/campaign-normalization";
import type { CampaignTargetProgress } from "@/lib/earnings/earnings-normalization";

/**
 * One campaign as the Home shows it: the offer, and the seller's progress towards it
 * when the backend returned a row.
 *
 * The two halves come from two contracts under two permissions and are joined on the
 * CAMPAIGN ID, never on the name — two campaigns may share a display name, and a name may
 * be edited between the two reads.
 */
export type SalesStaffOpportunity = {
  campaign: AssignedCampaign;
  /**
   * Null for a PER_UNIT_COINS campaign, which has no threshold to progress towards, and
   * for a session in which the progress read failed. Those two cases are deliberately
   * NOT distinguished here: both mean "there is no gauge to draw", and the campaign's own
   * offer is the honest thing to show for either.
   */
  progress: CampaignTargetProgress | null;
};

/** A campaign that eligible sales count towards RIGHT NOW. */
export function isRunning(campaign: AssignedCampaign): boolean {
  return campaign.derivedState === "ACTIVE";
}

/**
 * Pairs each campaign with its progress row, PRESERVING THE BACKEND'S ORDER.
 *
 * This function zips; it does not sort.
 */
export function buildOpportunities(
  campaigns: AssignedCampaign[],
  progressById: Map<string, CampaignTargetProgress>,
): SalesStaffOpportunity[] {
  return campaigns.map((campaign) => ({
    campaign,
    progress: progressById.get(campaign.campaignId) ?? null,
  }));
}

/**
 * The one campaign the Home leads with.
 *
 * THREE ORDERED PREFERENCES:
 *
 *   1. the first RUNNING campaign that has a target progress row;
 *   2. otherwise the first RUNNING campaign;
 *   3. otherwise the first campaign of any state.
 *
 * The first filter is "running AND has a target", not "has a target" — a scheduled
 * campaign with a progress row never outranks a campaign eligible sales count towards
 * today.
 *
 * IT DOES NOT PREFER AN UNREACHED TARGET OVER A REACHED ONE. That would be a judgement
 * about which reward deserves attention, and the contract gives no basis for one. First
 * is first.
 *
 * Returns null only when there is nothing to show at all.
 */
export function selectHeroOpportunity(
  opportunities: SalesStaffOpportunity[],
): SalesStaffOpportunity | null {
  if (opportunities.length === 0) return null;

  for (const opportunity of opportunities) {
    if (isRunning(opportunity.campaign) && opportunity.progress !== null) {
      return opportunity;
    }
  }
  for (const opportunity of opportunities) {
    if (isRunning(opportunity.campaign)) return opportunity;
  }
  return opportunities[0];
}

/**
 * Everything except the hero, in the backend's order.
 *
 * The hero is removed by IDENTITY rather than by id: a list that somehow carried the same
 * campaign twice would lose only the instance actually shown above, which is the
 * behaviour a reader expects from "and the rest".
 */
export function remainingOpportunities(
  opportunities: SalesStaffOpportunity[],
  hero: SalesStaffOpportunity | null,
): SalesStaffOpportunity[] {
  if (hero === null) return opportunities;
  return opportunities.filter((opportunity) => opportunity !== hero);
}

/**
 * Which eyebrow the hero wears.
 *
 * Decided by the stored `target_reached` boolean where there is a progress row, and by
 * the lifecycle state where there is not. It never resolves to "next reward" over a met
 * target, and never to "reached" over an unmet one.
 *
 * A KIND rather than a string, so this module imports nothing at runtime and stays
 * directly unit-testable; the component maps the kind onto the copy.
 */
export type HeroEyebrowKind = "next" | "reached" | "running" | "upcoming";

export function heroEyebrowKind(
  opportunity: SalesStaffOpportunity,
): HeroEyebrowKind {
  const { progress, campaign } = opportunity;
  if (progress !== null) {
    return progress.targetReached ? "reached" : "next";
  }
  return isRunning(campaign) ? "running" : "upcoming";
}

/**
 * How many campaigns the Home's opportunity strip carries before deferring to the full
 * list. The cap is STATED on screen when it truncates, so a partial strip is never read
 * as the whole list.
 */
export const MAX_OPPORTUNITY_CARDS = 6;
