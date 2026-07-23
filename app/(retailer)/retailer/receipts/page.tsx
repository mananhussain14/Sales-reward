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
  "px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400";
const tdClasses = "px-5 py-3.5 text-sm text-zinc-600 dark:text-zinc-400";

/** Renders a submission status as a neutral pill. */
function StatusPill({ submission }: { submission: ReceiptSubmission }) {
  const tone =
    submission.status === "SUBMITTED"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
      : submission.status === "UPLOAD_FAILED"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
        : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {receiptStatusLabel(submission.status)}
    </span>
  );
}

/** A generic, retry-safe panel for a read that failed. Never names a cause. */
function ReadUnavailable({ heading }: { heading: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 dark:border-amber-900/60 dark:bg-amber-950/40"
    >
      <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
        {heading}
      </h3>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
        Something went wrong while loading this. Please try again in a moment.
      </p>
    </div>
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
    <div className="mx-auto w-full max-w-4xl">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Receipts
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Submit a customer receipt for one of your shops, and review what you have sent.
        </p>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Submit                                                              */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="submit-heading" className="mt-8">
        <h3
          id="submit-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Submit a receipt
        </h3>

        <div className="mt-3 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6 dark:border-zinc-800 dark:bg-zinc-950">
          {assigned.status !== "ok" ? (
            <ReadUnavailable heading="The submission form could not be loaded" />
          ) : shops.length === 0 ? (
            /* Authorized, but not assigned to any active shop yet. Worded so it cannot
               be mistaken for a permission problem — they ARE allowed to submit, there
               is simply nowhere to submit against until an owner assigns them. */
            <div className="rounded-lg border border-dashed border-zinc-300 px-5 py-8 text-center dark:border-zinc-700">
              <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                No shops assigned yet
              </h4>
              <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                You&rsquo;ll be able to submit receipts once someone at your Retailer
                assigns you to a shop.
              </p>
            </div>
          ) : (
            <SubmitReceiptForm shops={shops} />
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Personal history                                                    */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="history-heading" className="mt-10">
        <h3
          id="history-heading"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Your submissions
        </h3>

        {history.status !== "ok" ? (
          <div className="mt-3">
            <ReadUnavailable heading="Your submissions could not be loaded" />
          </div>
        ) : history.submissions.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-950">
            <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              No receipts yet
            </h4>
            <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
              Receipts you submit will appear here, with their current status.
            </p>
          </div>
        ) : (
          <>
            {/* Desktop table. Horizontally scrollable rather than wrapping. */}
            <div className="mt-3 hidden overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm sm:block dark:border-zinc-800 dark:bg-zinc-950">
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-zinc-200 dark:divide-zinc-800">
                  <caption className="sr-only">
                    Receipts you have submitted, newest first
                  </caption>
                  <thead className="bg-zinc-50 dark:bg-zinc-900/50">
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
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {/* Rendered in the RPC's own order (newest first). Nothing is
                        re-sorted here — a second, locale-dependent ordering could
                        disagree with the database's. The submission id is the key. */}
                    {history.submissions.map((submission) => (
                      <tr key={submission.submissionId}>
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
                        <td className="max-w-xs truncate px-5 py-3.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
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
            <ul className="mt-3 flex flex-col gap-3 sm:hidden">
              {history.submissions.map((submission) => (
                <li
                  key={submission.submissionId}
                  className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {submission.originalFileName}
                    </p>
                    <StatusPill submission={submission} />
                  </div>
                  <dl className="mt-3 flex flex-col gap-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-500 dark:text-zinc-400">Shop</dt>
                      <dd className="text-right text-zinc-700 dark:text-zinc-300">
                        {submission.shopName}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-500 dark:text-zinc-400">Submitted</dt>
                      <dd className="text-right text-zinc-700 dark:text-zinc-300">
                        {formatOwnerTimestamp(
                          submission.submittedAt ?? submission.createdAt,
                        )}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-zinc-500 dark:text-zinc-400">Size</dt>
                      <dd className="text-right text-zinc-700 dark:text-zinc-300">
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
