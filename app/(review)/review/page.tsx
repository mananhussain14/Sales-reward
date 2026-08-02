import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getClaimReviewQueue } from "@/lib/review/claim-review-queue";
import {
  buildClaimReviewQueueHref,
  parseClaimReviewQueueParams,
  sanitizeFilterSelection,
} from "@/lib/review/claim-review-queue-filters";
import { QueueFilters } from "@/app/(review)/review/queue-filters";
import { ReceiptQueueRow } from "@/app/(review)/review/receipt-queue-row";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Receipt review queue · SalesReward",
};

/**
 * The Claim Reviewer receipt review QUEUE — Phase 1C-B.
 *
 * A SERVER COMPONENT. Every value comes from three SECURITY DEFINER RPCs — the page
 * of receipts, the pending total, and the Retailer/shop filter options — each called
 * with the reviewer's own token. Nothing is fetched in the browser and no client
 * component receives a receipt. The entire filter and pagination state lives in the
 * query string, so this page needs no client state at all.
 *
 * ============================================================================
 * WHAT THIS PAGE CAN AND CANNOT TELL A REVIEWER
 * ============================================================================
 * IMAGE-ONLY, and the copy says so plainly. A receipt carries a stored image, a
 * shop, a submitter and file metadata — and no transaction data whatsoever. There is
 * no amount, currency, merchant, sale date or product anywhere in the schema for
 * these rows: every receipt has zero Retailer confirmations and zero extractions,
 * with OCR disabled. Implying otherwise would invite a reviewer to judge something
 * they cannot see.
 *
 * The image is not shown here either. The bucket is private with zero storage
 * policies, and the authorized read path is Phase 1C-C's work.
 *
 * ============================================================================
 * AUTHORIZATION
 * ============================================================================
 * The layout already guards this route, and this page does NOT rely on that — the
 * same check is repeated here because the rule must hold for this module whatever
 * route tree it is composed into. Beneath both, the database decides: the RPCs take
 * no Vendor, resolve it from auth.uid(), and return zero rows to anyone who is not
 * an authorized reviewer. Hiding a control removes an accident, never a capability.
 */
export default async function ClaimReviewQueuePage({
  searchParams,
}: {
  // A promise in this version of Next.js — it must be awaited before any value is
  // read.
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const resolved = await searchParams;
  const { filters, inputs, cursor, hasActiveFilters, cursorWasReset } =
    parseClaimReviewQueueParams(resolved);

  const queue = await getClaimReviewQueue(filters, cursor);

  if (queue.status === "unauthenticated") {
    redirect("/login");
  }

  // "unauthorized" and "unavailable" are deliberately NOT collapsed. A reviewer
  // whose access was revoked belongs on the denial page; one hitting a transient
  // fault must not be told they have lost access.
  if (queue.status === "unauthorized") {
    redirect("/review-access-denied");
  }

  if (queue.status === "unavailable") {
    return (
      <QueueShell>
        <Alert tone="warning" title="We couldn’t load the review queue">
          Something went wrong on our side. Please refresh this page to try again.
        </Alert>
      </QueueShell>
    );
  }

  const { rows, totalCount, nextCursor, filterOptions } = queue;

  // ---------------------------------------------------------------------------
  // Correct an impossible selection, then re-render at a truthful URL
  // ---------------------------------------------------------------------------
  // A Retailer or shop can be selected that is no longer offered — hand-typed, from
  // another Vendor, or simply because its last pending receipt was decided since the
  // link was made. Leaving it in place would show an empty queue while the picker
  // claimed a filter the reviewer never chose.
  //
  // This is NOT a security boundary — the database already refuses foreign data, and
  // an unknown id would have matched nothing anyway. It is honesty about what the URL
  // says. Nothing here distinguishes "not yours" from "nothing pending": both simply
  // revert to All, so this cannot be used to probe.
  //
  // Only when options were actually READ (`filterOptions !== null`). During an options
  // outage there is nothing to validate against, and dropping a valid selection would
  // be worse than leaving it.
  if (filterOptions !== null && (inputs.retailerId || inputs.shopId)) {
    const safe = sanitizeFilterSelection(
      inputs.retailerId,
      inputs.shopId,
      filterOptions,
    );
    if (safe.changed) {
      // The cursor is dropped with it: a page boundary from the old filter set means
      // nothing under the new one. No loop is possible — the corrected values are, by
      // construction, ones this same check accepts.
      redirect(
        buildClaimReviewQueueHref({
          retailerId: safe.retailerId,
          shopId: safe.shopId,
          submittedFromDate: inputs.submittedFromDate,
          submittedToDate: inputs.submittedToDate,
        }),
      );
    }
  }

  return (
    <QueueShell
      count={totalCount}
      // rows === null is a FAILED read, not an empty queue — the count must not
      // claim "0 waiting" when the truth is "we do not know".
      countIsKnown={rows !== null && totalCount !== null}
    >
      {cursorWasReset ? (
        <Alert tone="warning" title="Showing the first page">
          That page link was incomplete, so the queue has been reset to the
          beginning. Your filters are unchanged.
        </Alert>
      ) : null}

      <QueueFilters
        inputs={inputs}
        options={filterOptions}
        hasActiveFilters={hasActiveFilters}
      />

      {rows === null ? (
        // The read FAILED. Deliberately not an empty state: telling a reviewer their
        // queue is clear when it could not be read is the worst lie available here.
        <Alert tone="warning" title="We couldn’t load the receipts">
          The queue is temporarily unavailable. Please refresh this page to try
          again.
        </Alert>
      ) : rows.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState
            tone="slate"
            icon={<QueueIcon />}
            title="No receipts match these filters"
            description="Try a wider date range, or clear the filters to see everything waiting for review."
            action={
              <Link
                href="/review"
                className={buttonClasses({ variant: "secondary" })}
              >
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            tone="emerald"
            icon={<QueueIcon />}
            title="No receipts are waiting for review"
            description="New submissions appear here automatically, oldest first."
          />
        )
      ) : (
        <>
          <ul className="space-y-3" aria-label="Receipts waiting for review">
            {rows.map((row) => (
              <ReceiptQueueRow
                key={row.receiptSubmissionId}
                row={row}
                action={
                  // Phase 1C-B ships the QUEUE. Opening a receipt needs the detail
                  // page, its private image proxy and the decision form — all
                  // Phase 1C-C. A disabled control that says so is honest; a link to
                  // a route that does not exist is a 404 with extra steps.
                  //
                  // A non-interactive element rather than a disabled <button>, so
                  // keyboard users never tab to something that cannot act.
                  // aria-disabled marks the state for assistive technology.
                  <span
                    aria-disabled="true"
                    title="Receipt detail and review decisions arrive in the next milestone"
                    className="inline-flex h-9 cursor-not-allowed items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm font-medium text-slate-400"
                  >
                    Review receipt
                    <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                      Soon
                    </span>
                  </span>
                }
              />
            ))}
          </ul>

          {nextCursor ? (
            <div className="flex justify-center pt-2">
              <Link
                href={buildClaimReviewQueueHref(inputs, nextCursor)}
                className={buttonClasses({ variant: "secondary" })}
              >
                Load older receipts
              </Link>
            </div>
          ) : null}
        </>
      )}
    </QueueShell>
  );
}

/** The page frame, shared by every outcome so the header never disappears. */
function QueueShell({
  count,
  countIsKnown = false,
  children,
}: {
  count?: number | null;
  countIsKnown?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <PageHeader
        eyebrow="Claim review"
        title="Receipt review queue"
        description="Receipts submitted by retail staff, oldest first. Review is image-based: check that each receipt is legible and genuine. Amounts, products and reward eligibility are not available in this milestone."
        actions={
          countIsKnown && typeof count === "number" ? (
            <span className="inline-flex items-center rounded-lg bg-indigo-50 px-3 py-1.5 text-sm font-semibold text-indigo-700 ring-1 ring-indigo-100">
              {count} waiting
            </span>
          ) : null
        }
      />
      {children}
    </div>
  );
}

function QueueIcon() {
  return (
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
  );
}
