import { cardClasses } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading state for the staff invitation page while the server validates the
 * invitation and decides which screen to show (activate, sign in, switch account,
 * or the automatic-acceptance transition). Shows only the safe, data-free shell —
 * brand, icon disc, heading — so the page is never blank while validation runs.
 * It reveals nothing about the invitation; every block is a neutral placeholder,
 * and no token, email, or status is read here.
 */
export default function StaffInvitationLoading() {
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
            <Skeleton className="h-6 w-52" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
          <div className="mt-6 space-y-4">
            <Skeleton className="h-11 w-full rounded-xl" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
