import { cn } from "@/components/ui/cn";
import { cardClasses } from "@/components/ui/card";

/**
 * A state-aware status card — the reusable base for both the Retailer Owner
 * invitation states and any other "here is the situation, here is the one thing
 * you can do about it" surface.
 *
 * Presentation only. It renders the heading, description, details, timeline and
 * action the caller supplies; it decides nothing and reveals nothing on its own.
 * `variant` tints the whole card for attention states (a failed delivery) without
 * relying on color alone — the icon and the wording always carry the meaning too.
 */
export type StatusCardVariant = "default" | "highlight" | "warning" | "danger";

export type StatusDetail = { label: string; value: React.ReactNode };

const VARIANT_CARD: Record<StatusCardVariant, string> = {
  default: "",
  highlight: "border-indigo-200 bg-indigo-50/40",
  warning: "border-amber-200 bg-amber-50/60",
  danger: "border-red-200 bg-red-50/60",
};

const DISC_TONES = {
  indigo: "bg-indigo-100 text-indigo-700",
  emerald: "bg-emerald-100 text-emerald-700",
  amber: "bg-amber-100 text-amber-700",
  red: "bg-red-100 text-red-700",
  slate: "bg-slate-100 text-slate-600",
} as const;

export type StatusIconTone = keyof typeof DISC_TONES;

export function StatusCard({
  icon,
  iconTone = "indigo",
  heading,
  description,
  badge,
  details,
  action,
  variant = "default",
  children,
  className,
}: {
  icon?: React.ReactNode;
  iconTone?: StatusIconTone;
  heading: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  details?: StatusDetail[];
  action?: React.ReactNode;
  variant?: StatusCardVariant;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cardClasses("standard", cn("p-6", VARIANT_CARD[variant], className))}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          {icon && (
            <span
              aria-hidden="true"
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
                DISC_TONES[iconTone],
              )}
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-base font-semibold text-slate-900">{heading}</p>
              {badge}
            </div>
            {description && (
              <p className="mt-1 text-sm text-slate-500">{description}</p>
            )}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      {details && details.length > 0 && (
        <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {details.map((detail) => (
            <div key={detail.label}>
              <dt className="text-xs font-medium text-slate-500">{detail.label}</dt>
              <dd className="mt-0.5 break-words text-sm text-slate-900">
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {children && <div className="mt-5">{children}</div>}
    </div>
  );
}

/**
 * A StatusCard fixed to the attention variant, for a failed/blocked state. A thin
 * convenience wrapper so callers read "WarningState" at the call site.
 */
export function WarningState({
  tone = "warning",
  ...props
}: Omit<React.ComponentProps<typeof StatusCard>, "variant"> & {
  tone?: "warning" | "danger";
}) {
  return (
    <StatusCard
      {...props}
      variant={tone}
      iconTone={props.iconTone ?? (tone === "danger" ? "red" : "amber")}
    />
  );
}
