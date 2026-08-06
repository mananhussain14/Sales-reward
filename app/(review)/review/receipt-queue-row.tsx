import { Badge } from "@/components/ui/badge";
import {
  formatFileSize,
  formatMimeType,
  formatSubmittedAt,
} from "@/lib/review/claim-review-queue-filters";
import type { ClaimReviewQueueRow } from "@/lib/review/claim-review-queue";

/**
 * One receipt in the queue.
 *
 * A CARD at every width rather than a table that collapses. A table would need
 * horizontal scrolling on a phone for the eight values shown here, and the reviewer
 * is scanning rather than comparing columns — the receipt is the unit of work, so
 * the card is the unit of layout.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY ABSENT
 * ============================================================================
 * No image and no thumbnail: the bucket is private, there is no authorized read
 * path yet, and streaming it is Phase 1C-C's job.
 *
 * No amount, currency, merchant, sale date, product, campaign or reward eligibility.
 * Not because they are hidden — because they DO NOT EXIST. Every receipt in the
 * system has zero confirmations and zero extractions, so any such field would be
 * invented. Phase 1C is image-only for exactly this reason.
 *
 * No storage bucket, object path or file hash, and no profile, membership or
 * organization id. The RPC does not return them; this component could not print
 * them if it tried.
 */
export function ReceiptQueueRow({
  row,
  action,
}: {
  row: ClaimReviewQueueRow;
  action: React.ReactNode;
}) {
  // A receipt whose shop or submitter has since been deactivated is STILL reviewable
  // (decision D7) — the state is shown as context so a reviewer understands what
  // they are looking at, never as a reason to hide the work.
  const shopInactive = row.shopStatus !== "ACTIVE";
  const submitterInactive = row.submitterStatus !== "ACTIVE";

  return (
    <li className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900">
              {row.retailerName}
            </h3>
            {row.hasDuplicateHash ? (
              // Shown ONLY when true. The flag says these bytes appear more than
              // once; it never carries the hash itself.
              <Badge tone="amber">Possible duplicate</Badge>
            ) : null}
          </div>

          <dl className="grid gap-x-6 gap-y-1 text-sm text-slate-600 sm:grid-cols-2">
            <div className="flex flex-wrap items-center gap-x-2">
              <dt className="text-slate-500">Shop</dt>
              <dd className="font-medium text-slate-800">
                {row.shopName}
                {row.shopCode ? (
                  <span className="ml-1 font-normal text-slate-500">
                    ({row.shopCode})
                  </span>
                ) : null}
              </dd>
              {shopInactive ? (
                // Text inside the badge, not colour alone — a colour-blind reviewer
                // must get the same information.
                <Badge tone="slate">Shop {row.shopStatus.toLowerCase()}</Badge>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-x-2">
              <dt className="text-slate-500">Submitted by</dt>
              <dd className="font-medium text-slate-800">{row.submitterName}</dd>
              {submitterInactive ? (
                <Badge tone="slate">
                  Staff {row.submitterStatus.toLowerCase()}
                </Badge>
              ) : null}
            </div>

            <div className="flex items-center gap-x-2">
              <dt className="text-slate-500">Submitted</dt>
              <dd className="font-medium text-slate-800">
                <time dateTime={row.submittedAt}>
                  {formatSubmittedAt(row.submittedAt)}
                </time>
              </dd>
            </div>

            <div className="flex items-center gap-x-2">
              <dt className="text-slate-500">File</dt>
              <dd className="font-medium text-slate-800">
                {formatMimeType(row.mimeType)} ·{" "}
                {formatFileSize(row.fileSizeBytes)}
              </dd>
            </div>
          </dl>

          <p className="truncate text-xs text-slate-500" title={row.originalFileName}>
            {row.originalFileName}
          </p>
        </div>

        <div className="shrink-0">{action}</div>
      </div>
    </li>
  );
}
