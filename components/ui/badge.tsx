import { cn } from "@/components/ui/cn";
import { CheckIcon, ClockIcon } from "@/components/ui/icons";

/**
 * Status pills, centralized.
 *
 * This is the ONE place backend status enums are mapped to a user-facing label,
 * a tone, and (where it helps) an icon — so the same value reads identically
 * everywhere and a raw enum string is never printed. Meaning is never carried by
 * color alone: the label text is always present, and key states add an icon.
 *
 * An unrecognized status renders as "Unknown" in a neutral tone rather than
 * leaking the raw database value into the page.
 */
export type BadgeTone =
  | "emerald"
  | "amber"
  | "indigo"
  | "blue"
  | "slate"
  | "red";

const TONE_CLASSES: Record<BadgeTone, string> = {
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  blue: "bg-blue-50 text-blue-700 ring-blue-600/20",
  slate: "bg-slate-100 text-slate-600 ring-slate-500/20",
  red: "bg-red-50 text-red-700 ring-red-600/20",
};

export function Badge({
  tone = "slate",
  icon,
  children,
  className,
}: {
  tone?: BadgeTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

type StatusMeta = { label: string; tone: BadgeTone; withIcon?: "clock" | "check" };

/**
 * Backend status → presentation. Covers the profile / membership / relationship
 * lifecycle states and the invitation / receipt states used across the product.
 * Labels are stable, human wording; the raw enum is never shown.
 */
const STATUS_MAP: Record<string, StatusMeta> = {
  ACTIVE: { label: "Active", tone: "emerald", withIcon: "check" },
  ACCEPTED: { label: "Accepted", tone: "emerald", withIcon: "check" },
  APPROVED: { label: "Approved", tone: "emerald", withIcon: "check" },
  INVITED: { label: "Invited", tone: "amber", withIcon: "clock" },
  PENDING: { label: "Pending", tone: "amber", withIcon: "clock" },
  AWAITING: { label: "Awaiting acceptance", tone: "amber", withIcon: "clock" },
  SUSPENDED: { label: "Suspended", tone: "amber" },
  PROCESSING: { label: "Processing", tone: "indigo" },
  UPLOADED: { label: "Uploaded", tone: "blue" },
  SUBMITTED: { label: "Submitted", tone: "blue" },
  EXPIRED: { label: "Expired", tone: "slate" },
  REVOKED: { label: "Revoked", tone: "slate" },
  DEACTIVATED: { label: "Deactivated", tone: "slate" },
  INACTIVE: { label: "Inactive", tone: "slate" },
  FAILED: { label: "Failed", tone: "red" },
  REJECTED: { label: "Rejected", tone: "red" },
};

function statusIcon(kind: StatusMeta["withIcon"]) {
  if (kind === "check") return <CheckIcon className="h-3 w-3" />;
  if (kind === "clock") return <ClockIcon className="h-3 w-3" />;
  return undefined;
}

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_MAP[status];

  if (!meta) {
    return <Badge tone="slate">Unknown</Badge>;
  }

  return (
    <Badge tone={meta.tone} icon={statusIcon(meta.withIcon)}>
      {meta.label}
    </Badge>
  );
}
