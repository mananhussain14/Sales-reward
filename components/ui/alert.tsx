import { cn } from "@/components/ui/cn";
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  InfoIcon,
} from "@/components/ui/icons";

/**
 * Inline notice / alert.
 *
 * Status is never carried by color alone — each tone pairs a hue with an icon,
 * and the message text always states the meaning. `role` defaults to a polite
 * "status" for confirmations; pass `role="alert"` for errors that should
 * interrupt, matching the live-region behaviour the forms already rely on.
 */
export type AlertTone = "info" | "success" | "warning" | "error";

const TONES: Record<
  AlertTone,
  { container: string; icon: string; Icon: typeof InfoIcon }
> = {
  info: {
    container: "border-blue-200 bg-blue-50 text-blue-900",
    icon: "text-blue-600",
    Icon: InfoIcon,
  },
  success: {
    container: "border-emerald-200 bg-emerald-50 text-emerald-900",
    icon: "text-emerald-600",
    Icon: CheckCircleIcon,
  },
  warning: {
    container: "border-amber-200 bg-amber-50 text-amber-900",
    icon: "text-amber-600",
    Icon: AlertTriangleIcon,
  },
  error: {
    container: "border-red-200 bg-red-50 text-red-800",
    icon: "text-red-600",
    Icon: AlertTriangleIcon,
  },
};

export function Alert({
  tone = "info",
  title,
  children,
  role,
  id,
  className,
}: {
  tone?: AlertTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  role?: "status" | "alert";
  id?: string;
  className?: string;
}) {
  const { container, icon, Icon } = TONES[tone];
  const resolvedRole = role ?? (tone === "error" ? "alert" : "status");

  return (
    <div
      id={id}
      role={resolvedRole}
      aria-live={resolvedRole === "alert" ? "polite" : undefined}
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        container,
        className,
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", icon)} />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title ? "mt-0.5" : undefined)}>{children}</div>}
      </div>
    </div>
  );
}
