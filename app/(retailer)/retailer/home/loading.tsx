import { Skeleton, SkeletonScreen } from "@/components/ui/skeleton";

/**
 * The Home's loading state.
 *
 * Shapes that match what arrives — a greeting, the hero, the coins panel, an opportunity
 * row and one receipt row — so the screen does not reflow when the data lands. Skeletons,
 * not a spinner, are this product's loading language.
 *
 * `SkeletonScreen` sets `aria-busy`, renders a screen-reader-only status label, and hides
 * the visual blocks from assistive technology. The label is deliberately generic: it never
 * names a record, a campaign or an identity.
 */
export default function SalesStaffHomeLoading() {
  return (
    <SkeletonScreen label="Loading your home screen…">
      <div className="mx-auto w-full max-w-5xl">
        {/* Greeting */}
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-2 h-4 w-64" />

        {/* Hero and coins */}
        <div className="mt-6 grid gap-5 lg:grid-cols-3">
          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-card lg:col-span-2">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="mt-3 h-7 w-64" />
            <div className="mt-6 flex items-center gap-6">
              <Skeleton className="h-[148px] w-[148px] rounded-full" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="mt-2 h-5 w-32" />
                <Skeleton className="mt-3 h-4 w-full" />
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card">
            <div className="flex items-center gap-3">
              <Skeleton className="h-11 w-11 rounded-2xl" />
              <div className="min-w-0 flex-1">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="mt-2 h-5 w-24" />
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Skeleton className="h-14 rounded-xl" />
              <Skeleton className="h-14 rounded-xl" />
            </div>
          </div>
        </div>

        {/* Opportunities */}
        <Skeleton className="mt-8 h-5 w-40" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-card"
            >
              <div className="flex items-start gap-3">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <Skeleton className="h-4 flex-1" />
              </div>
              <Skeleton className="mt-4 h-12 w-full" />
              <Skeleton className="mt-4 h-5 w-2/3 rounded-full" />
            </div>
          ))}
        </div>

        {/* Latest receipt */}
        <Skeleton className="mt-8 h-5 w-32" />
        <div className="mt-4 flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-card">
          <Skeleton className="h-10 w-10 rounded-xl" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2 h-3 w-56" />
          </div>
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
      </div>
    </SkeletonScreen>
  );
}
