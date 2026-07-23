import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRetailerPortalAccess } from "@/lib/staff/retailer-staff-access";
import {
  getMyAssignedReceiptShops,
  getMyReceiptSubmissions,
} from "@/lib/receipts/receipt-data";
import {
  receiptStatusLabel,
  type ReceiptSubmission,
} from "@/lib/receipts/receipt-normalization";
import { formatFileSize } from "@/lib/receipts/receipt-file";
import { formatOwnerTimestamp } from "@/lib/retailers/owner-status-normalization";
import { SubmitReceiptForm } from "@/app/(retailer)/retailer/receipts/submit-receipt-form";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cardClasses } from "@/components/ui/card";
import { InboxIcon, LocationIcon } from "@/components/ui/icons";

export const metadata: Metadata = {
  title: "Receipts · Retailer Portal",
  description: "Submit customer receipts and review your own submission history.",
};

/**
 * The Sales Staff receipt experience: submit a receipt, and review your own history.
 *
 * AUTHORIZATION IS RESOLVED HERE, AT THIS PAGE'S OWN SERVER BOUNDARY, and again by
 * every RPC behind every section. The page is directly addressable, so its state must
 * come from the verified session rather than from how the caller arrived. React `cache`
 * makes the repeat resolution free — the layout and this page share one.
 *
 * WHY AN OWNER OR A MANAGER NEVER SEES THIS PAGE, without a role name appearing in it:
 * both reads below are gated on RECEIPT_SUBMIT, a permission mapped to SALES_STAFF
 * alone, so both answer `denied` for them and the portal resolves them as something
 * other than a submitter. The redirect below is the same one every other portal denial
 * uses.
 *
 * WHAT IS NEVER RENDERED: the storage bucket, the object path, the file hash, any
 * profile / membership / organization id, any failure code, and any other person's
 * submission. The history RPC returns none of them, so there is nothing of that kind
 * here to withhold. There is no receipt IMAGE either — displaying one needs a
 * short-lived signed URL minted after an ownership check, which is deliberately out of
 * scope for this MVP; a permanent link to a customer's receipt is exactly what the
 * private bucket exists to prevent.
 */

const thClasses =
  "px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500";
const tdClasses = "px-5 py-3.5 text-sm text-slate-600";

/** Renders a submission status as a status pill. Meaning is carried by the label. */
function StatusPill({ submission }: { submission: ReceiptSubmission }) {
  const tone =
    submission.status === "SUBMITTED"
      ? "emerald"
      : submission.status === "UPLOAD_FAILED"
        ? "amber"
        : "slate";

  return <Badge tone={tone}>{receiptStatusLabel(submission.status)}</Badge>;
}

/** A generic, retry-safe panel for a read that failed. Never names a cause. */
function ReadUnavailable({ heading }: { heading: string }) {
  return (
    <Alert tone="warning" role="alert" title={heading}>
      Something went wrong while loading this. Please try again in a moment.
    </Alert>
  );
}

export default async function RetailerReceiptsPage() {
  const access = await getRetailerPortalAccess();

  // The layout has already handled each of these, but this page is directly addressable
  // and must not depend on that. The branches are identical, so the two boundaries can
  // never disagree.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }
  if (access.status === "unavailable") {
    throw new Error("Retailer portal context is temporarily unavailable.");
  }

  // A portal member who is not a receipt submitter (an Owner or a Manager) is sent to
  // the same generic denial as anyone else. Fails closed.
  if (access.kind !== "submitter") {
    redirect("/retailer-access-denied");
  }

  const [assigned, history] = await Promise.all([
    getMyAssignedReceiptShops(),
    getMyReceiptSubmissions(),
  ]);

  const shops = assigned.status === "ok" ? assigned.shops : [];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <PageHeader
        eyebrow="Sales staff"
        title="Receipts"
        description="Submit a customer receipt for one of your shops, and review what you have sent."
      />

      {/* ------------------------------------------------------------------ */}
      {/* Submit                                                              */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="submit-heading" className="space-y-3">
        <SectionHeader
          title={<span id="submit-heading">Submit a receipt</span>}
        />

        <div className={cardClasses("standard", "p-5 sm:p-6")}>
          {assigned.status !== "ok" ? (
            <ReadUnavailable heading="The submission form could not be loaded" />
          ) : shops.length === 0 ? (
            /* Authorized, but not assigned to any active shop yet. Worded so it cannot
               be mistaken for a permission problem — they ARE allowed to submit, there
               is simply nowhere to submit against until an owner assigns them. */
            <EmptyState
              icon={<LocationIcon className="h-6 w-6" />}
              title="No shops assigned yet"
              description="You’ll be able to submit receipts once someone at your Retailer assigns you to a shop."
            />
          ) : (
            <SubmitReceiptForm shops={shops} />
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Personal history                                                    */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="history-heading" className="space-y-3">
        <SectionHeader
          title={<span id="history-heading">Your submissions</span>}
        />

        {history.status !== "ok" ? (
          <ReadUnavailable heading="Your submissions could not be loaded" />
        ) : history.submissions.length === 0 ? (
          <EmptyState
            icon={<InboxIcon className="h-6 w-6" />}
            tone="indigo"
            title="No receipts yet"
            description="Receipts you submit will appear here, with their current status."
          />
        ) : (
          <>
            {/* Desktop table. Horizontally scrollable rather than wrapping. */}
            <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card sm:block">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-100">
                  <caption className="sr-only">
                    Receipts you have submitted, newest first
                  </caption>
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr>
                      <th scope="col" className={thClasses}>
                        Submitted
                      </th>
                      <th scope="col" className={thClasses}>
                        Shop
                      </th>
                      <th scope="col" className={thClasses}>
                        File
                      </th>
                      <th scope="col" className={thClasses}>
                        Size
                      </th>
                      <th scope="col" className={thClasses}>
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {/* Rendered in the RPC's own order (newest first). Nothing is
                        re-sorted here — a second, locale-dependent ordering could
                        disagree with the database's. The submission id is the key. */}
                    {history.submissions.map((submission) => (
                      <tr key={submission.submissionId} className="transition-colors hover:bg-slate-50">
                        <td className={`whitespace-nowrap ${tdClasses}`}>
                          {formatOwnerTimestamp(
                            submission.submittedAt ?? submission.createdAt,
                          )}
                        </td>
                        <td className={`whitespace-nowrap ${tdClasses}`}>
                          {submission.shopCode
                            ? `${submission.shopName} · ${submission.shopCode}`
                            : submission.shopName}
                        </td>
                        <td className="max-w-xs truncate px-5 py-3.5 text-sm font-medium text-slate-900">
                          {submission.originalFileName}
                        </td>
                        <td className={`whitespace-nowrap ${tdClasses}`}>
                          {formatFileSize(submission.fileSizeBytes)}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5">
                          <StatusPill submission={submission} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile: stacked cards. A five-column table is unreadable below `sm`. */}
            <ul className="flex flex-col gap-3 sm:hidden">
              {history.submissions.map((submission) => (
                <li
                  key={submission.submissionId}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">
                      {submission.originalFileName}
                    </p>
                    <StatusPill submission={submission} />
                  </div>
                  <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Shop</dt>
                      <dd className="text-right text-slate-700">
                        {submission.shopName}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Submitted</dt>
                      <dd className="text-right text-slate-700">
                        {formatOwnerTimestamp(
                          submission.submittedAt ?? submission.createdAt,
                        )}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-slate-500">Size</dt>
                      <dd className="text-right text-slate-700">
                        {formatFileSize(submission.fileSizeBytes)}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
