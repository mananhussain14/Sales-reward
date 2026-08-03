import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getClaimReviewDetail } from "@/lib/review/claim-review-detail";
import { getClaimReceiptQualification } from "@/lib/review/claim-receipt-qualification";
import { QualificationPanel } from "@/app/(review)/review/[receiptSubmissionId]/qualification-panel";
import { getClaimReceiptSaleContext } from "@/lib/review/claim-receipt-sale-context";
import { getVerifiedSaleHeader } from "@/lib/review/verified-sale-header";
import { SaleHeaderPanel } from "@/app/(review)/review/[receiptSubmissionId]/sale-header-panel";
import {
  formatFileSize,
  formatMimeType,
  formatSubmittedAt,
  isReceiptSubmissionId,
} from "@/lib/review/claim-review-queue-filters";
import {
  DECISION_LABELS,
  isClaimReviewDecision,
  isRejectionReason,
  REJECTION_REASON_LABELS,
} from "@/lib/review/claim-review-decision-input";
import { DecisionForm } from "@/app/(review)/review/[receiptSubmissionId]/decision-form";
import { ReceiptImage } from "@/app/(review)/review/[receiptSubmissionId]/receipt-image";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = {
  title: "Review a receipt · SalesReward",
};

/**
 * One receipt, opened from the queue — Phase 1C-C.
 *
 * A SERVER COMPONENT. Every value comes from ONE SECURITY DEFINER RPC called with
 * the reviewer's own token: `get_claim_review_detail`. It takes the receipt id and
 * nothing else — no Vendor, no reviewer, no membership — and the database resolves
 * the tenant from auth.uid().
 *
 * ============================================================================
 * IMAGE-ONLY, AND THE PAGE SAYS SO
 * ============================================================================
 * A receipt carries a stored image, a shop, a submitter and file metadata, and NO
 * transaction data whatsoever. Every receipt in the system has zero Retailer
 * confirmations and zero extractions, with OCR disabled. There is no amount,
 * currency, merchant, sale date, product, campaign or reward anywhere behind this
 * page, so none is displayed and the copy says plainly that the review is based on
 * the image alone. An empty "Transaction details" table would imply the data
 * should be there and is merely missing.
 *
 * ============================================================================
 * MISSING, FOREIGN AND UNAUTHORIZED ARE ONE ANSWER
 * ============================================================================
 * `notFound()` for all of them. A malformed id never reaches the RPC; a receipt
 * belonging to another Vendor returns zero rows exactly as a nonexistent one does,
 * and no Retailer or shop name is rendered in either case. There is nothing here a
 * caller could use to discover which receipt ids are real.
 *
 * ============================================================================
 * A DECIDED RECEIPT STILL OPENS
 * ============================================================================
 * Decisions live in their own table, so the RPC keeps returning a decided receipt
 * with its decision columns filled. That is what makes the read-only view work.
 * The page branches on `decision`, never on whether a row came back.
 */
export default async function ClaimReviewDetailPage({
  params,
}: {
  // A promise in this version of Next.js — it must be awaited before any value is
  // read.
  params: Promise<{ receiptSubmissionId: string }>;
}) {
  const { receiptSubmissionId } = await params;

  // Shape first. A malformed id is indistinguishable from a nonexistent one and
  // never reaches an RPC, which would otherwise fail on the uuid cast.
  if (!isReceiptSubmissionId(receiptSubmissionId)) {
    notFound();
  }

  const result = await getClaimReviewDetail(receiptSubmissionId);

  if (result.status === "unauthenticated") {
    redirect("/login");
  }

  if (result.status === "not-found") {
    notFound();
  }

  if (result.status === "unavailable") {
    return (
      <DetailShell>
        <Alert tone="warning" title="We couldn’t load this receipt">
          Something went wrong on our side. Please refresh this page to try again.
        </Alert>
        <BackToQueue />
      </DetailShell>
    );
  }

  const d = result.detail;

  // Read ONLY for a VERIFIED receipt. A rejected one is already out of the reward
  // path by being rejected, and a second control would imply the rejection was not
  // enough. `null` here means the read failed — the panel says so rather than
  // rendering "not excluded", which would be a guess about a financial control.
  //
  // The two reads run CONCURRENTLY. Both are gated on the same already-completed
  // receipt authorization and each re-derives the Vendor from auth.uid() in SQL,
  // so overlapping them changes nothing about who may read what — it only stops
  // the reviewer paying for two sequential cross-region round trips.
  const [qualificationResult, saleContextResult] =
    d.decision === "VERIFIED"
      ? await Promise.all([
          getClaimReceiptQualification(d.receiptSubmissionId),
          getClaimReceiptSaleContext(d.receiptSubmissionId),
        ])
      : [null, null];

  const qualification =
    qualificationResult?.status === "authorized"
      ? qualificationResult.qualification
      : null;

  // `null` means the sale context could not be read. The panel renders an
  // unavailable state; it must never be mistaken for "no proposal", "not
  // excluded" or "finalizable".
  const saleContext =
    saleContextResult?.status === "authorized" ? saleContextResult.context : null;

  // Only fetched once the context says a sale exists, so an unfinalized receipt
  // costs no extra round trip.
  const saleHeaderResult = saleContext?.alreadyFinalized
    ? await getVerifiedSaleHeader(d.receiptSubmissionId)
    : null;
  const saleHeader =
    saleHeaderResult?.status === "authorized" ? saleHeaderResult.header : null;

  const submittedLabel = formatSubmittedAt(d.submittedAt);
  const shopInactive = d.shopStatus !== "ACTIVE";
  const submitterInactive = d.submitterStatus !== "ACTIVE";

  const decided = d.decision !== null;
  const decisionLabel = isClaimReviewDecision(d.decision)
    ? DECISION_LABELS[d.decision]
    : d.decision;
  const reasonLabel = isRejectionReason(d.rejectionReason)
    ? REJECTION_REASON_LABELS[d.rejectionReason]
    : d.rejectionReason;

  return (
    <DetailShell
      retailerName={d.retailerName}
      decided={decided}
      decision={d.decision}
    >
      <div className="grid gap-6 lg:grid-cols-5">
        {/* The image gets the majority of the width on desktop: it is the only
            evidence a reviewer has, and everything else is a caption to it. */}
        <div className="lg:col-span-3">
          <ReceiptImage
            receiptSubmissionId={d.receiptSubmissionId}
            retailerName={d.retailerName}
            submittedAtLabel={submittedLabel}
          />
        </div>

        <div className="space-y-6 lg:col-span-2">
          <section
            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
            aria-labelledby="submission-heading"
          >
            <h2
              id="submission-heading"
              className="text-sm font-semibold text-slate-900"
            >
              Submission details
            </h2>

            <dl className="mt-3 space-y-3 text-sm">
              <Row label="Retailer">{d.retailerName}</Row>
              <Row label="Shop">
                {d.shopName}
                {d.shopCode ? (
                  <span className="ml-1 font-normal text-slate-500">
                    ({d.shopCode})
                  </span>
                ) : null}
                {shopInactive ? (
                  <Badge tone="slate" className="ml-2">
                    Shop {d.shopStatus.toLowerCase()}
                  </Badge>
                ) : null}
              </Row>
              <Row label="Submitted by">
                {d.submitterName}
                {submitterInactive ? (
                  <Badge tone="slate" className="ml-2">
                    Staff {d.submitterStatus.toLowerCase()}
                  </Badge>
                ) : null}
              </Row>
              <Row label="Submitted">
                <time dateTime={d.submittedAt}>{submittedLabel}</time>
              </Row>
              <Row label="File">
                {formatMimeType(d.mimeType)} · {formatFileSize(d.fileSizeBytes)}
              </Row>
              <Row label="Filename">
                <span className="break-all">{d.originalFileName}</span>
              </Row>
              {d.hasDuplicateHash ? (
                <Row label="Duplicate check">
                  <Badge tone="amber">Possible duplicate</Badge>
                  <span className="mt-1 block text-xs text-slate-500">
                    The same image was submitted more than once.
                  </span>
                </Row>
              ) : null}
            </dl>
          </section>

          {/* Honest copy instead of an empty table. Saying the data does not
              exist is a different statement from showing blank cells. */}
          <section
            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
            aria-labelledby="scope-heading"
          >
            <h2 id="scope-heading" className="text-sm font-semibold text-slate-900">
              This is an image-only review
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Check that the receipt is legible and looks genuine. Amounts,
              currency, merchant, sale date, products, campaigns and reward
              eligibility are <strong>not recorded for this receipt</strong> and
              are not part of this decision.
            </p>
            <ul className="mt-3 space-y-1 text-xs text-slate-500">
              <li>
                Automatic text extraction:{" "}
                {d.extractionStatus === "NONE"
                  ? "not available"
                  : d.extractionStatus.toLowerCase()}
              </li>
              <li>
                Retailer-entered details:{" "}
                {d.hasRetailerConfirmation ? "provided" : "not provided"}
              </li>
            </ul>
          </section>

          {decided ? (
            <section
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
              aria-labelledby="decision-outcome-heading"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2
                  id="decision-outcome-heading"
                  className="text-sm font-semibold text-slate-900"
                >
                  Final decision
                </h2>
                {/* The word carries the meaning; the tone only reinforces it. */}
                <Badge tone={d.decision === "VERIFIED" ? "emerald" : "red"}>
                  {decisionLabel}
                </Badge>
              </div>

              <dl className="mt-3 space-y-3 text-sm">
                {reasonLabel ? (
                  <Row label="Reason">{reasonLabel}</Row>
                ) : null}
                {d.reviewerNote ? (
                  <Row label="Reviewer note">
                    <span className="whitespace-pre-wrap break-words">
                      {d.reviewerNote}
                    </span>
                  </Row>
                ) : null}
                {d.decidedAt ? (
                  <Row label="Decided">
                    <time dateTime={d.decidedAt}>
                      {formatSubmittedAt(d.decidedAt)}
                    </time>
                  </Row>
                ) : null}
                {d.decidedByName ? (
                  <Row label="Decided by">{d.decidedByName}</Row>
                ) : null}
              </dl>

              <p className="mt-4 text-xs text-slate-500">
                This decision is final. It cannot be edited, reopened or deleted,
                and no second decision can be recorded for this receipt.
              </p>

              <div className="mt-4">
                <BackToQueue />
              </div>
            </section>
          ) : (
            <DecisionForm receiptSubmissionId={d.receiptSubmissionId} />
          )}

          {/* Phase 1D-0. A SEPARATE question from the decision above: that one says
              the image was verified, this says whether the record may go on to
              become a sale. Only offered for a VERIFIED receipt. */}
          {d.decision === "VERIFIED" ? (
            <QualificationPanel
              receiptSubmissionId={d.receiptSubmissionId}
              qualification={qualification}
            />
          ) : null}

          {/* Phase 1D-A. A THIRD separate question: the decision says the image
              was verified, the qualification panel says the record is not
              excluded, and this says whether a reviewer accepted the Sales Staff
              figures as an authoritative sale. Only offered for a VERIFIED
              receipt, for the same reason the qualification panel is. */}
          {d.decision === "VERIFIED" ? (
            <SaleHeaderPanel
              receiptSubmissionId={d.receiptSubmissionId}
              context={saleContext}
              header={saleHeader}
            />
          ) : null}
        </div>
      </div>
    </DetailShell>
  );
}

/** One metadata row. `<dt>`/`<dd>` so the pairing survives without styling. */
function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-slate-800">{children}</dd>
    </div>
  );
}

function BackToQueue() {
  return (
    <Link href="/review" className={buttonClasses({ variant: "secondary" })}>
      Back to queue
    </Link>
  );
}

/**
 * The page frame, shared by every outcome so the header never disappears.
 *
 * The Retailer name is omitted on the failure path: naming it there would leak
 * whose receipt an unavailable id belonged to.
 */
function DetailShell({
  retailerName,
  decided = false,
  decision,
  children,
}: {
  retailerName?: string;
  decided?: boolean;
  decision?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Claim review"
        title={retailerName ? `Receipt from ${retailerName}` : "Review a receipt"}
        description="Review is based on the receipt image only. Amounts, products and reward eligibility are not available in this milestone."
        actions={
          decided ? (
            <Badge tone={decision === "VERIFIED" ? "emerald" : "red"}>
              {isClaimReviewDecision(decision ?? null)
                ? DECISION_LABELS[decision as "VERIFIED" | "REJECTED"]
                : "Decided"}
            </Badge>
          ) : (
            <Link
              href="/review"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Back to queue
            </Link>
          )
        }
      />
      {children}
    </div>
  );
}
