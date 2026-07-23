import { cardClasses } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading state for the owner activation page while the server resolves the
 * pending invitation. Shows the safe, data-free onboarding-card shell
 * immediately — brand, icon disc, heading, and password fields — so the page
 * never appears frozen. It reveals nothing: every block is a neutral placeholder.
 */
export default function CompleteInvitationLoading() {
  return (
    <div
      aria-busy="true"
      className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12"
    >
      <span role="status" className="sr-only">
        Loading your invitation…
      </span>
      <div aria-hidden="true" className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Skeleton className="h-10 w-40 rounded-xl" />
        </div>
        <div className={cardClasses("standard", "p-6 sm:p-8")}>
          <div className="flex flex-col items-center gap-3 text-center">
            <Skeleton className="h-12 w-12 rounded-2xl" />
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
          <div className="mt-6 space-y-4">
            <Skeleton className="h-11 w-full rounded-xl" />
            <Skeleton className="h-11 w-full rounded-xl" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
