/**
 * Renders a stored lifecycle state as a readable label.
 *
 * The raw value is never printed: an unrecognized status falls back to
 * "Unknown" rather than leaking a database enum string into the page. The
 * mapped values are the ones the profiles, organization_members, and roles
 * check constraints allow — the first two share INVITED/SUSPENDED/DEACTIVATED,
 * while roles is ACTIVE/INACTIVE only.
 */
const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  INVITED: "Invited",
  SUSPENDED: "Suspended",
  DEACTIVATED: "Deactivated",
  INACTIVE: "Inactive",
};

/**
 * Zinc by default, matching the admin palette. Active is the one state given a
 * distinct hue — a directory is scanned for who is live, and that read should
 * not require parsing text.
 */
const STATUS_CLASSES: Record<string, string> = {
  ACTIVE:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400",
  INVITED: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  SUSPENDED: "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400",
  DEACTIVATED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  INACTIVE: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const UNKNOWN_CLASSES = "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";

export function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? "Unknown";
  const classes = STATUS_CLASSES[status] ?? UNKNOWN_CLASSES;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}
    >
      {label}
    </span>
  );
}
