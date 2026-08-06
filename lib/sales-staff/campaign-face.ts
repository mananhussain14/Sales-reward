/**
 * PURE MODULE — no imports beyond sibling types, no I/O, no React.
 *
 * WHICH FACE A CAMPAIGN WEARS.
 *
 * ============================================================================
 * THE COMPLAINT THIS ANSWERS
 * ============================================================================
 * Every campaign used to look the same: a name, a status pill and four grey chips,
 * repeated. It no longer does, and the difference is driven ENTIRELY by columns the
 * deployed contracts already return — never by anything computed here:
 *
 *   rule_type = PER_UNIT_COINS                  a bolt, and the RATE as the headline
 *   TARGET_BONUS + INDIVIDUAL_STAFF             a target glyph and a personal gauge
 *   TARGET_BONUS + RETAILER_TEAM                a team glyph and team wording
 *   target_reached = true                       a trophy, in emerald
 *   derived_state = SCHEDULED                   a calendar and the start date
 *
 * The tone and the glyph are two channels; the card also carries the status badge, the
 * reward sentence and the scope in words. MEANING IS NEVER CARRIED BY COLOUR ALONE, so a
 * reader who resolves none of the hues loses nothing.
 *
 * The additive qualifiers — a cap, exclusivity, snapshot vs live — are decided separately
 * in `campaignQualifiers` and are all independent of the face, so a capped exclusive
 * snapshot per-unit campaign renders all four without a special case.
 */
import type { AssignedCampaign } from "@/lib/campaigns/campaign-normalization";
import type { CampaignTargetProgress } from "@/lib/earnings/earnings-normalization";
import type { SurfaceTone } from "@/components/ui/surfaces";

/**
 * The visual identity of one campaign card.
 *
 * `kind` selects the glyph; `tone` tints it. They travel together because a trophy in
 * indigo or a calendar in emerald would each say something the contract does not.
 */
export type CampaignFace = {
  kind:
    | "scheduled"
    | "target-reached"
    | "target-team"
    | "target-individual"
    | "per-unit"
    | "target";
  tone: SurfaceTone;
};

export function campaignFace(
  campaign: AssignedCampaign,
  progress: CampaignTargetProgress | null,
): CampaignFace {
  // A campaign that has not started has no progress to draw, whatever else it is.
  if (campaign.derivedState === "SCHEDULED") {
    return { kind: "scheduled", tone: "blue" };
  }

  if (progress !== null) {
    // `target_reached` is the database's answer and the only one.
    if (progress.targetReached) return { kind: "target-reached", tone: "emerald" };
    return progress.performanceScope === "RETAILER_TEAM"
      ? { kind: "target-team", tone: "amber" }
      : { kind: "target-individual", tone: "indigo" };
  }

  // No progress row: either a per-unit campaign, which has no threshold to track, or a
  // target campaign whose progress read did not return one. Fall back to the rule.
  //
  // Deliberately NOT emerald for a target — emerald means "target reached" on the
  // indicator directly below, and two different meanings for one hue on one card is
  // exactly the ambiguity the tones exist to remove.
  return campaign.reward.ruleType === "PER_UNIT_COINS"
    ? { kind: "per-unit", tone: "indigo" }
    : { kind: "target", tone: "blue" };
}

/**
 * The additive qualifiers a campaign card shows, in a fixed order.
 *
 * Each appears ONLY where the contract says so. There is no "uncapped" chip and no
 * "stackable" chip shouting about the ordinary case — absence of a cap is the norm, and a
 * chip for it would be noise on every card in the product.
 */
export type CampaignQualifier =
  | { kind: "products"; label: string }
  | { kind: "cap"; label: string }
  | { kind: "exclusive"; label: string }
  | { kind: "combinable"; label: string }
  | { kind: "snapshot"; label: string }
  | { kind: "live"; label: string };

export function campaignQualifiers(
  campaign: AssignedCampaign,
  formatCoins: (coins: number) => string,
): CampaignQualifier[] {
  const qualifiers: CampaignQualifier[] = [
    {
      kind: "products",
      label:
        campaign.eligibleProductCount === 1
          ? "1 product"
          : `${campaign.eligibleProductCount} products`,
    },
  ];

  // Rendered only when `max_reward_coins` is non-null. A cap that never bit is still a
  // ceiling worth stating, but a campaign without one has nothing to say.
  if (campaign.reward.maxRewardCoins !== null) {
    qualifiers.push({
      kind: "cap",
      label: `Max ${formatCoins(campaign.reward.maxRewardCoins)}`,
    });
  }

  // Exclusivity is the unusual case and gets a chip; STACKABLE is stated too, because a
  // seller comparing two campaigns needs to know which of them can pay together.
  qualifiers.push(
    campaign.stackingMode === "EXCLUSIVE"
      ? { kind: "exclusive", label: "Exclusive" }
      : { kind: "combinable", label: "Combines" },
  );

  // The difference between "the products eligible when each sale happens" and "the list
  // frozen at publication". A reader who cannot tell those apart cannot read the product
  // list correctly, so it is always shown.
  qualifiers.push(
    campaign.productEligibilityResolution === "SNAPSHOT"
      ? { kind: "snapshot", label: "Snapshot" }
      : { kind: "live", label: "Live" },
  );

  return qualifiers;
}

/** The tone each qualifier chip carries. */
export const QUALIFIER_TONES: Record<CampaignQualifier["kind"], SurfaceTone> = {
  products: "slate",
  cap: "amber",
  exclusive: "red",
  combinable: "slate",
  snapshot: "blue",
  live: "blue",
};

/**
 * The gauge's colour ramp for a progress row.
 *
 * A PRESENTATION choice about colour that decides nothing: `target_reached` remains the
 * only statement that a target has been met, and the warm ramp is a threshold on the
 * clamped display fraction rather than a claim about it.
 */
export function progressSweep(
  progress: { targetReached: boolean },
  fraction: number,
): "indigo" | "warm" | "emerald" {
  if (progress.targetReached) return "emerald";
  return fraction >= 0.6 ? "warm" : "indigo";
}
