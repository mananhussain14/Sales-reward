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
