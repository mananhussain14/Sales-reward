import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { ChevronLeftIcon } from "@/components/ui/icons";

/**
 * A back link rendered above a page header. A real `<Link>`, so it navigates
 * without client state and stays keyboard-focusable.
 */
export function BackLink({
  href,
  children,
  disabled = false,
}: {
  href: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg text-sm font-medium text-slate-500 transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      <ChevronLeftIcon className="h-4 w-4" />
      {children}
    </Link>
  );
}

/**
 * The standard page header: an optional eyebrow, a title, an optional supporting
 * description, and an optional action cluster aligned to the right on wide
 * screens. Used at the top of every route so titles, spacing, and action
 * placement stay identical product-wide.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-indigo-600">
            {eyebrow}
          </p>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm text-slate-500">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/**
 * A lighter within-page section heading, for grouping content under a page
 * header (e.g. "Active staff", "Pending invitations").
 */
export function SectionHeader({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-end justify-between gap-4", className)}>
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-sm text-slate-500">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
