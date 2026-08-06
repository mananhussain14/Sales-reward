import type { ReactNode } from "react";
import { Chip } from "@/components/ui/surfaces";
import {
  BoltIcon,
  CalendarIcon,
  GaugeIcon,
  GroupsIcon,
  LayersIcon,
  LiveClockIcon,
  LockIcon,
  ProductsIcon,
  RewardIcon,
  SnapshotIcon,
  TargetIcon,
  TrophyIcon,
} from "@/components/ui/icons";
import {
  QUALIFIER_TONES,
  campaignQualifiers,
  type CampaignFace,
  type CampaignQualifier,
} from "@/lib/sales-staff/campaign-face";
import { formatCoins } from "@/lib/campaigns/campaign-vocabulary";
import type { AssignedCampaign } from "@/lib/campaigns/campaign-normalization";

/**
 * The glyphs that give each campaign type its face, and the chips that qualify it.
 *
 * The DECISIONS live in @/lib/sales-staff/campaign-face, which is pure and unit-tested by
 * being called. This file only maps a decided `kind` onto an icon, so a test can pin the
 * rules without rendering React.
 */

const FACE_ICONS: Record<CampaignFace["kind"], (props: { className?: string }) => ReactNode> = {
  scheduled: CalendarIcon,
  "target-reached": TrophyIcon,
  "target-team": GroupsIcon,
  "target-individual": TargetIcon,
  "per-unit": BoltIcon,
  target: TargetIcon,
};

export function CampaignFaceIcon({
  face,
  className,
}: {
  face: CampaignFace;
  className?: string;
}) {
  const Glyph = FACE_ICONS[face.kind];
  return <Glyph className={className} />;
}

const QUALIFIER_ICONS: Record<
  CampaignQualifier["kind"],
  (props: { className?: string }) => ReactNode
> = {
  products: ProductsIcon,
  cap: GaugeIcon,
  exclusive: LockIcon,
  combinable: LayersIcon,
  snapshot: SnapshotIcon,
  live: LiveClockIcon,
};

/**
 * The additive qualifier chips: how many products, any cap, exclusivity, and whether
 * eligibility was frozen at publication or is checked at sale time.
 *
 * All four are independent, so a capped exclusive snapshot per-unit campaign shows all of
 * them without a special case.
 */
export function CampaignQualifiers({
  campaign,
  className,
}: {
  campaign: AssignedCampaign;
  className?: string;
}) {
  const qualifiers = campaignQualifiers(campaign, formatCoins);

  return (
    <div className={className}>
      {qualifiers.map((qualifier) => {
        const Glyph = QUALIFIER_ICONS[qualifier.kind];
        return (
          <Chip
            key={qualifier.kind}
            icon={<Glyph className="h-3 w-3" />}
            label={qualifier.label}
            tone={QUALIFIER_TONES[qualifier.kind]}
          />
        );
      })}
    </div>
  );
}

/** The reward-type badge glyph: a bolt for a rate, a trophy for a threshold. */
export function RewardTypeIcon({ campaign }: { campaign: AssignedCampaign }) {
  return campaign.reward.ruleType === "PER_UNIT_COINS" ? (
    <BoltIcon className="h-3 w-3" />
  ) : (
    <RewardIcon className="h-3 w-3" />
  );
}
