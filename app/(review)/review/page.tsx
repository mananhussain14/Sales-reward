import { EmptyState } from "@/components/ui/empty-state";

/**
 * The Claim Review dashboard.
 *
 * DELIBERATELY EMPTY, and it must stay that way until Phase 1C.
 *
 * This page performs NO data access of any kind. It does not read
 * receipt_submissions, receipt_confirmations, receipt_extractions, receipt images,
 * audit logs, campaign data or reward data, and it creates no Supabase client at
 * all. That is not an oversight to be filled in later by whoever touches this file
 * next — it is the boundary of the milestone:
 *
 *   * the permission behind this portal, CLAIM_REVIEW_PORTAL_READ, authorizes the
 *     SHELL and nothing else. There is no receipt read permission yet, so any query
 *     added here would either be refused in SQL or would be reading data this
 *     caller has not been granted;
 *   * showing a COUNT would be the subtlest version of the same mistake. "6 receipts
 *     waiting" is receipt data, derived from a table this portal may not read, and
 *     it would leak the size of another tenant's activity through a number.
 *
 * The empty state is therefore written to look INTENTIONAL rather than broken — an
 * authorized reviewer seeing a blank page should understand that the queue has not
 * shipped, not that their access failed. The layout handles the genuinely failed
 * case separately, with a different message.
 *
 * A Server Component with no async work: there is nothing to await.
 */
export default function ReviewDashboardPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-slate-900">
          Claim Review
        </h2>
        <p className="text-sm text-slate-600">
          Receipt verification for the Vendor you review for.
        </p>
      </div>

      <EmptyState
        tone="indigo"
        icon={
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6"
            aria-hidden="true"
          >
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        }
        title="Receipt review opens in the next milestone"
        description="Your Claim Review access is active. There is no receipt queue to show yet — submitted receipts will appear here once review is switched on."
      />
    </div>
  );
}
