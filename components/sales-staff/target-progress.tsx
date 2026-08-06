import { ProgressRing } from "@/components/ui/progress-ring";
import { StatPill } from "@/components/ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { GroupsIcon, RewardIcon, UsersIcon } from "@/components/ui/icons";
import { cn } from "@/components/ui/cn";
import { progressSweep } from "@/lib/sales-staff/campaign-face";
import {
  formatCoins,
  progressFraction,
  progressHeadline,
  progressPercent,
  progressScopeExplanation,
  progressScopeLabel,
  progressSemanticLabel,
  progressValueLabel,
  targetStatement,
} from "@/lib/earnings/earnings-presentation";
import type { CampaignTargetProgress } from "@/lib/earnings/earnings-normalization";

/**
 * A campaign target, drawn as a ring and stated as facts.
 *
 * ============================================================================
 * THE GAUGE IS A DRAWING; THE NUMBERS ARE THE FACTS
 * ============================================================================
 * The ring receives a clamped fraction. The real numerator and denominator are printed
 * BESIDE it and are never replaced by the percentage inside it. A seller at 9 units
 * against a target of 8 sees a full ring AND `9 of 8 units`: the drawing saturates, the
 * facts do not, and nothing here rounds one to match the other.
 *
 * ============================================================================
 * ONE PROGRESSBAR, ONE UTTERANCE
 * ============================================================================
 * The whole block is a single `role="progressbar"`. The ring inside it is `aria-hidden`,
 * because a bare circular indicator announces a percentage and nothing about WHOSE units
 * it counts — which is exactly the confusion a RETAILER_TEAM target creates.
 *
 * `aria-valuenow` carries the TRUE current value, which may exceed `aria-valuemax`, for
 * the same reason and by the same precedent as the shared `ProgressBar`. `aria-valuetext`
 * carries the full sentence, and is what a reader actually hears.
 *
 * ============================================================================
 * A TEAM FIGURE IS NEVER READ AS A PERSONAL ONE
 * ============================================================================
 * `progressScopeLabel` decides the whole vocabulary — "Your progress" or "Team progress" —
 * and the explanation line under it says outright whose sales the number counts.
 * `bonus_awarded_to_me` decides the one sentence that makes a claim about money, and when
 * a colleague crossed the threshold the copy says so rather than implying the reader was
 * paid.
 */

const SCOPE_ICONS = {
  RETAILER_TEAM: GroupsIcon,
  INDIVIDUAL_STAFF: UsersIcon,
} as const;

const BADGE_TONES = {
  emerald: "emerald",
  amber: "amber",
  slate: "slate",
} as const;

export function TargetProgress({
  progress,
  variant = "detail",
  idSuffix,
  className,
}: {
  progress: CampaignTargetProgress;
  /**
   * `hero` is the Home's focal gauge; `detail` is the campaign page's; `compact` is the
   * inline gauge on an opportunity card, where there is room for a ring and two lines.
   */
  variant?: "hero" | "detail" | "compact";
  idSuffix: string;
  className?: string;
}) {
  const fraction = progressFraction(progress);
  const percent = progressPercent(progress);
  const statement = targetStatement(progress);
  const sweep = progressSweep(progress, fraction);
  const ScopeIcon = SCOPE_ICONS[progress.performanceScope];
  const semantic = progressSemanticLabel(progress);

  const ringSize = variant === "hero" ? 148 : variant === "detail" ? 120 : 64;
  const ringStroke = variant === "hero" ? 14 : variant === "detail" ? 12 : 7;

  const ring = (
    <ProgressRing
      fraction={fraction}
      size={ringSize}
      strokeWidth={ringStroke}
      sweep={sweep}
      ticks={variant === "hero" ? 36 : undefined}
      glow={variant === "hero"}
      idSuffix={idSuffix}
      trackClassName={variant === "compact" ? "stroke-slate-200" : "stroke-slate-100"}
      center={
        <>
          <span
            className={cn(
              "font-semibold tabular-nums text-slate-900",
              variant === "hero"
                ? "text-2xl"
                : variant === "detail"
                  ? "text-xl"
                  : "text-xs",
            )}
          >
            {percent}%
          </span>
          {variant !== "compact" && (
            <span className="mt-0.5 text-xs text-slate-500">of target</span>
          )}
        </>
      }
    />
  );

  /* ------------------------------------------------------------------ */
  /* Compact: the inline gauge on an opportunity card.                   */
  /* ------------------------------------------------------------------ */
  if (variant === "compact") {
    return (
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.targetUnits}
        aria-valuenow={progress.progressUnits}
        aria-valuetext={semantic}
        className={cn("flex items-center gap-3", className)}
      >
        {ring}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <ScopeIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {progressScopeLabel(progress.performanceScope)}
            </span>
          </p>
          <p className="mt-0.5 text-sm font-semibold tabular-nums text-slate-900">
            {progressValueLabel(progress)}
          </p>
          <p className="mt-1 line-clamp-2 text-xs text-slate-600">
            {/* Under a team target this is the sentence that keeps a shared figure
                from being read as a personal one, and — once a colleague has crossed
                it — says so outright. */}
            {statement.outcome === "reached-not-yours"
              ? statement.detail
              : progressHeadline(progress)}
          </p>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------------ */
  /* Hero and detail: the gauge beside the facts.                        */
  /* ------------------------------------------------------------------ */
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={progress.targetUnits}
      aria-valuenow={progress.progressUnits}
      aria-valuetext={semantic}
      className={cn(
        // Stacked on a narrow phone, side by side from `xs` up. Stacking is what keeps
        // both halves readable at a large text scale.
        "flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-6",
        className,
      )}
    >
      <div className="shrink-0">{ring}</div>

      <div className="min-w-0 flex-1 text-center sm:text-left">
        <p className="flex items-center justify-center gap-1.5 text-xs font-medium text-slate-500 sm:justify-start">
          <ScopeIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          {progressScopeLabel(progress.performanceScope)}
        </p>

        {/* The numerator and denominator, at headline weight. Never replaced by the
            percentage inside the ring. */}
        <p className="mt-1 text-lg font-semibold tabular-nums tracking-tight text-slate-900">
          {progressValueLabel(progress)}
        </p>

        <div className="mt-2 flex justify-center sm:justify-start">
          <Badge tone={BADGE_TONES[statement.tone]}>{statement.label}</Badge>
        </div>

        <p className="mt-2 text-sm text-slate-700">{progressHeadline(progress)}</p>

        {/* The one sentence on the block that makes a claim about money. */}
        <p className="mt-1 text-sm text-slate-600">{statement.detail}</p>

        {/* Says whose sales the number above counts. */}
        <p className="mt-1 text-xs text-slate-500">
          {progressScopeExplanation(progress.performanceScope)}
        </p>

        {progress.configuredRewardCoins !== null && (
          <div className="mt-3 flex justify-center sm:justify-start">
            <StatPill
              label="Configured bonus"
              value={`${formatCoins(progress.configuredRewardCoins)} coins`}
              tone="amber"
              icon={<RewardIcon className="h-3.5 w-3.5" />}
            />
          </div>
        )}
      </div>
    </div>
  );
}
