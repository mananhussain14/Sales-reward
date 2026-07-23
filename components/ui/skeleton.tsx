import { cn } from "@/components/ui/cn";
import { cardClasses } from "@/components/ui/card";

/**
 * Loading placeholders.
 *
 * `Skeleton` is a single shimmering block (the shimmer is defined in globals.css
 * and suppressed under reduced-motion). `SkeletonCard` and `SkeletonRows` are the
 * two shapes the app's `loading.tsx` files reuse so a route never flashes a blank
 * screen while its Server Component streams.
 */
export function Skeleton({ className }: { className?: string }) {
  return <span className={cn("sr-skeleton block rounded-md", className)} />;
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cardClasses("standard", cn("p-5", className))}>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-8 w-16" />
      <Skeleton className="mt-3 h-3 w-32" />
    </div>
  );
}

export function SkeletonStatGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className={cardClasses("standard", "divide-y divide-slate-100")}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4">
          <Skeleton className="h-10 w-10 rounded-xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * The wrapper every route-level `loading.tsx` uses. It marks the region busy and
 * carries a SCREEN-READER status announcement (the visible blocks are hidden from
 * assistive tech), so the loading state is perceivable without sighted-only cues.
 * The label is generic ("Loading …") — it never names a record, id, or identity.
 */
export function SkeletonScreen({
  label = "Loading…",
  className,
  children,
}: {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div aria-busy="true" className={cn("mx-auto w-full", className)}>
      <span role="status" className="sr-only">
        {label}
      </span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

/** A page-title block: title bar, description line, and an optional action pill. */
export function SkeletonPageHeader({ withAction = false }: { withAction?: boolean }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {withAction && <Skeleton className="h-11 w-36 rounded-xl" />}
    </div>
  );
}

/** A premium table placeholder: header strip plus body rows, matching the real tables. */
export function SkeletonTable({
  columns = 4,
  rows = 5,
}: {
  columns?: number;
  rows?: number;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card">
      <div className="flex gap-4 border-b border-slate-200 bg-slate-50 px-4 py-3.5">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-3 flex-1" />
        ))}
      </div>
      <div className="divide-y divide-slate-100">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 px-4 py-4">
            {Array.from({ length: columns }).map((_, c) => (
              <Skeleton key={c} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A grouped form-section card placeholder: heading, then labelled input rows. */
export function SkeletonFormSection({ fields = 3 }: { fields?: number }) {
  return (
    <div className={cardClasses("standard", "space-y-5 p-5 sm:p-6")}>
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-56 max-w-full" />
      </div>
      <div className="space-y-5">
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The right-aligned Cancel / primary action pair at the foot of a form. */
export function SkeletonFormActions() {
  return (
    <div className="flex justify-end gap-3">
      <Skeleton className="h-11 w-24 rounded-xl" />
      <Skeleton className="h-11 w-36 rounded-xl" />
    </div>
  );
}
