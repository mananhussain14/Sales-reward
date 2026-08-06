import { Badge, type BadgeTone } from "@/components/ui/badge";
import { CheckIcon, ClockIcon } from "@/components/ui/icons";
import type { CampaignState } from "@/lib/campaigns/campaign-vocabulary";

/**
 * The campaign's EFFECTIVE-TIME state as a pill.
 *
 * A SEPARATE map from the shared STATUS_MAP in @/components/ui/badge, not an extension of
 * it. That map translates the lifecycle vocabulary shared by profiles, memberships,
 * organizations, relationships and receipts, where ACTIVE means "in good standing". A
 * campaign's ACTIVE means "inside its effective period right now", and SCHEDULED, ENDED
 * and DRAFT have no counterpart there at all. Adding six campaign-only keys to a map five
 * other features read would make every future change to one of them a change to all of
 * them.
 *
 * The state itself is computed in SQL by public.campaign_derived_state() and is never
 * recomputed in TypeScript — this component renders what it is told.
 *
 * Meaning is never carried by colour alone: the label text is always present, and the two
 * time-sensitive states carry an icon as well.
 */

type StateMeta = { label: string; tone: BadgeTone; icon?: "clock" | "check" };

const STATE_MAP: Record<CampaignState, StateMeta> = {
  // Authored, never published. Visible to Vendor campaign managers only.
  DRAFT: { label: "Draft", tone: "slate" },
  // Published, but its period has not begun.
  SCHEDULED: { label: "Scheduled", tone: "blue", icon: "clock" },
  // Published, inside its period, neither paused nor cancelled.
  ACTIVE: { label: "Active", tone: "emerald", icon: "check" },
  // A human suspended eligibility inside a period that is still running. Amber because
  // it is reversible and expected to resume — the same reasoning the shared map applies
  // to SUSPENDED.
  PAUSED: { label: "Paused", tone: "amber" },
  // The period is over. Neutral: nothing is wrong, it simply finished.
  ENDED: { label: "Ended", tone: "slate" },
  // Terminal for the published version. Red because it is the one state that ended the
  // campaign before its time.
  CANCELLED: { label: "Cancelled", tone: "red" },
};

function stateIcon(kind: StateMeta["icon"]) {
  if (kind === "check") return <CheckIcon className="h-3 w-3" />;
  if (kind === "clock") return <ClockIcon className="h-3 w-3" />;
  return undefined;
}

export function CampaignStateBadge({ state }: { state: CampaignState }) {
  const meta = STATE_MAP[state];

  // Defensive: the normalizer already refuses an unrecognized state, so this is
  // unreachable from a well-formed read. It renders neutrally rather than throwing,
  // because a badge is not worth a blank page.
  if (!meta) {
    return <Badge tone="slate">Unknown</Badge>;
  }

  return (
    <Badge tone={meta.tone} icon={stateIcon(meta.icon)}>
      {meta.label}
    </Badge>
  );
}
