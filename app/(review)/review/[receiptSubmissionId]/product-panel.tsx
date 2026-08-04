"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { decideReceiptProductsAction } from "@/app/(review)/review/[receiptSubmissionId]/product-decision-actions";
import {
  type ProductDecisionActionState,
  INITIAL_PRODUCT_DECISION_ACTION_STATE,
} from "@/app/(review)/review/[receiptSubmissionId]/product-decision-action-state";
import {
  isProductRejectionReason,
  productReasonRequiresNote,
  PRODUCT_NOTE_MAX_LENGTH,
  PRODUCT_REJECTION_REASONS,
  PRODUCT_REJECTION_REASON_LABELS,
  type ProductDecision,
  type ProductRejectionReason,
} from "@/lib/review/claim-product-decision-input";
import {
  PENDING_REQUEST_MESSAGE,
  REFRESHING_MESSAGE,
  SLOW_REQUEST_MESSAGE,
  SLOW_REQUEST_NOTICE_MS,
  shouldRefreshAfterProductDecisionSettlement,
} from "@/lib/review/claim-product-decision-settlement";
import {
  currentAssignmentLabel,
  currentStatusLabel,
  exclusionReasonLabel,
  hasCurrentStateWarning,
  proposalStatusLabel,
  totalProposedQuantity,
} from "@/lib/review/claim-product-display";
import { formatUtcInstant } from "@/lib/review/claim-sale-display";
import type {
  ClaimProductProposalLine,
  ClaimReceiptProductContext,
} from "@/lib/review/claim-receipt-product-context";
import type { VerifiedSaleItems } from "@/lib/review/verified-sale-items";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { FieldError, Label, textareaClasses } from "@/components/ui/field";

/**
 * What was sold, according to the Sales Staff — and whether a Claim Reviewer
 * accepted that list as authoritative.
 *
 * ============================================================================
 * A FOURTH SEPARATE FACT ON ONE PAGE
 * ============================================================================
 * The decision panel says the IMAGE was verified. The qualification panel says
 * the record is not excluded. The sale-header panel says WHEN the sale happened
 * and FOR HOW MUCH. This one says WHAT was sold. All four are true at once and
 * none overwrites another, so the copy repeats that in every state.
 *
 * ============================================================================
 * THE WHOLE LIST, OR NONE OF IT
 * ============================================================================
 * The reviewer accepts or rejects the COMPLETE product list. They cannot edit,
 * add, remove, replace or reorder a line, and they cannot change a quantity —
 * there is no control for it anywhere in this file, and the database has no
 * parameter that would accept one. One wrong line means the whole list may be
 * rejected; there is no per-line verdict and no correction flow in this
 * milestone.
 *
 * ============================================================================
 * FROZEN BEATS CURRENT, AND BOTH ARE SHOWN
 * ============================================================================
 * Every product value displayed on a proposal line was frozen when the Sales
 * Staff member submitted it. The product's CURRENT catalogue status and its
 * CURRENT Retailer assignment are shown beside it, clearly labelled as current,
 * because a reviewer should be able to see that something changed. That
 * information is INFORMATIONAL ONLY: a product deactivated or unassigned after
 * the proposal does not block acceptance, and nothing here disables a control
 * because of it.
 */
export function ProductPanel({
  receiptSubmissionId,
  context,
  sale,
}: {
  receiptSubmissionId: string;
  /** `null` when the state could not be read — the panel then says so. */
  context: ClaimReceiptProductContext | null;
  /** The authoritative items, read only once a decision is ACCEPTED. */
  sale: VerifiedSaleItems | null;
}) {
  const [state, formAction, pending] = useActionState<
    ProductDecisionActionState,
    FormData
  >(decideReceiptProductsAction, INITIAL_PRODUCT_DECISION_ACTION_STATE);

  // Which dialog is open, and therefore which decision the one submit control
  // carries. `null` means no dialog and no decision value.
  const [mode, setMode] = useState<ProductDecision | null>(null);
  const [reason, setReason] = useState<ProductRejectionReason | null>(null);
  const [note, setNote] = useState("");

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const acceptRef = useRef<HTMLButtonElement | null>(null);
  const rejectRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();
  const descriptionId = useId();
  const reasonErrorId = useId();
  const noteId = useId();
  const noteErrorId = useId();
  const noteCountId = useId();

  // Closed during RENDER against the previous result rather than in an effect: an
  // effect would paint the stale dialog first and then immediately re-render to
  // close it. Matches the decision, qualification and sale-header forms.
  const [lastResult, setLastResult] = useState(state);
  if (state !== lastResult) {
    setLastResult(state);
    if (
      state.settled ||
      state.formError ||
      Object.keys(state.fieldErrors).length > 0
    ) {
      setMode(null);
    }
  }

  // Focus enters the dialog when it opens and returns to the control that opened
  // it when it closes — but ONLY if a dialog was ever open. Without the guard the
  // first render would pull focus to a panel at the bottom of the page, scrolling
  // the reviewer away from the receipt image they were reading.
  const dialogWasOpen = useRef(false);
  useEffect(() => {
    if (mode !== null) {
      dialogWasOpen.current = true;
      dialogRef.current?.focus();
      return;
    }
    if (dialogWasOpen.current) {
      dialogWasOpen.current = false;
      (acceptRef.current ?? rejectRef.current)?.focus();
    }
  }, [mode]);

  // Escape closes — but never mid-submit, so a stray keypress cannot leave a
  // reviewer unsure whether a permanent decision was recorded.
  useEffect(() => {
    if (mode === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) setMode(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mode, pending]);

  // ==========================================================================
  // SETTLEMENT: outcome first, refresh second
  // ==========================================================================
  // The action revalidates nothing, so `pending` clears as soon as the database
  // answers. The panel shows that answer, and only then asks the server for fresh
  // data. The client router refresh merges the new payload without discarding
  // client state, so the outcome the reviewer is reading survives it.
  const router = useRouter();
  const [isRefreshing, startRefresh] = useTransition();
  const refreshRequested = useRef(false);

  // ONE call site, deliberately — both the automatic post-settlement refresh and
  // the manual uncertain-result button go through here. It is read-only: it
  // re-renders the route and calls no RPC of its own.
  const checkProductDecisionStatus = useCallback(() => {
    startRefresh(() => {
      router.refresh();
    });
  }, [router]);

  useEffect(() => {
    if (!shouldRefreshAfterProductDecisionSettlement(state)) return;
    if (refreshRequested.current) return;
    refreshRequested.current = true;
    checkProductDecisionStatus();
  }, [state, checkProductDecisionStatus]);

  // A slow request is still a request. Presentation only: it cancels nothing,
  // resubmits nothing, claims no failure and touches no database state. Armed by
  // the submit EVENT so no state is set inside an effect.
  const [slow, setSlow] = useState(false);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function armSlowNotice() {
    if (slowTimer.current !== null) clearTimeout(slowTimer.current);
    slowTimer.current = setTimeout(() => setSlow(true), SLOW_REQUEST_NOTICE_MS);
  }

  if (!pending && slow) setSlow(false);

  useEffect(() => {
    if (pending) return;
    if (slowTimer.current !== null) {
      clearTimeout(slowTimer.current);
      slowTimer.current = null;
    }
  }, [pending]);

  useEffect(
    () => () => {
      if (slowTimer.current !== null) clearTimeout(slowTimer.current);
    },
    [],
  );

  // ==========================================================================
  // WHICH STATE ARE WE IN?
  // ==========================================================================
  const unavailable = context === null;
  const accepted = context?.alreadyAccepted === true;
  const rejected = context?.alreadyRejected === true;
  const decided = accepted || rejected;
  const hasProposal = context?.hasProductProposal === true;
  const hasSaleHeader = context?.hasVerifiedSaleHeader === true;
  const excluded = context?.isQualificationExcluded === true;

  // A read outage must never present as decidable, and neither must a state the
  // database says is blocked. Every gate below is a REASON not to offer the
  // action; the database re-checks all of them anyway, under a row lock.
  //
  // `state.settled` is included so the controls disappear the instant an
  // authoritative answer arrives, rather than lingering until the refresh lands.
  //
  // Note what is NOT here: a product's current status and its current assignment.
  // Neither may withhold this control.
  const canDecide =
    !unavailable &&
    !decided &&
    !excluded &&
    hasProposal &&
    hasSaleHeader &&
    !state.settled;

  const lines = context?.lines ?? [];
  const totalQuantity = totalProposedQuantity(lines);

  // The client mirror of the database's own rules. It can only ever be stricter
  // in effect — a value it lets through still has to survive the RPC.
  const noteTrimmed = note.trim();
  const noteTooLong = noteTrimmed.length > PRODUCT_NOTE_MAX_LENGTH;
  const noteMissing = productReasonRequiresNote(reason) && noteTrimmed === "";
  const rejectionReady = reason !== null && !noteMissing && !noteTooLong;
  const confirmDisabled =
    pending || (mode === "REJECTED" && !rejectionReady) || mode === null;

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
      aria-labelledby="product-decision-heading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="product-decision-heading"
          className="text-sm font-semibold text-slate-900"
        >
          Products on this receipt
        </h2>
        {!unavailable && (
          // The word carries the meaning; tone only reinforces it.
          <Badge
            tone={
              accepted
                ? "emerald"
                : rejected
                  ? "red"
                  : excluded
                    ? "amber"
                    : "slate"
            }
          >
            {accepted
              ? "Products accepted"
              : rejected
                ? "Products rejected"
                : excluded
                  ? "Blocked by exclusion"
                  : !hasProposal
                    ? "No product list submitted"
                    : !hasSaleHeader
                      ? "Waiting for sale details"
                      : "Not yet decided"}
          </Badge>
        )}
      </div>

      {/* ---------------- STATE G — the context could not be read ---------- */}
      {unavailable ? (
        <>
          <Alert tone="warning" className="mt-3">
            The product status of this receipt is temporarily unavailable. Nothing
            can be accepted or rejected while this is unreadable, and no decision
            is assumed either way. The review decision, qualification state and
            sale header above are unaffected.
          </Alert>
          <div className="mt-3">
            <button
              type="button"
              onClick={checkProductDecisionStatus}
              disabled={isRefreshing}
              className={buttonClasses({ variant: "secondary" })}
            >
              {isRefreshing ? "Checking…" : "Check product decision status"}
            </button>
          </div>
        </>
      ) : null}

      {/* THE AUTHORITATIVE ANSWER, rendered before anything is re-fetched. */}
      {state.settled ? (
        <>
          <Alert
            tone={
              state.outcome === "CONFLICT"
                ? "warning"
                : state.outcome === "ACCEPTED"
                  ? "success"
                  : "info"
            }
            className="mt-3"
          >
            {state.message}
          </Alert>
          {isRefreshing ? (
            <p role="status" className="mt-3 text-xs text-slate-500">
              {REFRESHING_MESSAGE}
            </p>
          ) : null}
        </>
      ) : null}

      {/* An UNCERTAIN result is neither success nor failure, and is worded and
          toned as its own thing so it can never read as either. */}
      {state.formError ? (
        <>
          <Alert
            tone={state.uncertain ? "warning" : "error"}
            role="alert"
            className="mt-3"
          >
            {state.formError}
          </Alert>
          {state.uncertain ? (
            <div className="mt-3">
              <button
                type="button"
                onClick={checkProductDecisionStatus}
                disabled={isRefreshing}
                className={buttonClasses({ variant: "secondary" })}
              >
                {isRefreshing ? "Checking…" : "Check product decision status"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ---------------- STATE A — the staff submitted no product list ---- */}
      {!unavailable && !hasProposal ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-slate-600">
            No product list was submitted for this receipt.
          </p>
          <p className="text-xs text-slate-500">
            The Sales Staff member who submitted this receipt did not propose any
            products with it. There is nothing to accept or reject, and no product
            list can be added here — a proposal is made once, when the receipt
            details are confirmed. This is a normal state, not a problem with this
            receipt.
          </p>
        </div>
      ) : null}

      {/* ---------------- STATES B–F — a proposal exists ------------------- */}
      {!unavailable && hasProposal && context ? (
        <>
          {/* STATE E shows the AUTHORITATIVE items instead of the proposal. */}
          {accepted ? (
            <AcceptedItemsBody context={context} sale={sale} />
          ) : (
            <ProposalBody
              lines={lines}
              lineCount={context.proposalLineCount}
              totalQuantity={totalQuantity}
            />
          )}

          {/* ---------------- STATE F — already rejected ------------------- */}
          {rejected ? <RejectedDecisionBody context={context} /> : null}

          {/* ---------------- STATE C — blocked by an exclusion ------------ */}
          {!decided && excluded ? (
            <div className="mt-4 space-y-3 text-sm">
              <p className="text-slate-600">
                <strong className="font-semibold text-slate-900">
                  A product decision is blocked.
                </strong>{" "}
                This receipt has an active qualification exclusion, so its product
                list cannot be accepted or rejected, it cannot enter campaign
                qualification, and it cannot earn a reward or coins.
              </p>
              {context.exclusionReason ? (
                <Row label="Exclusion reason">
                  {exclusionReasonLabel(context.exclusionReason)}
                </Row>
              ) : null}
              <p className="text-xs text-slate-500">
                The receipt&rsquo;s VERIFIED review decision and its sale header
                are unchanged and remain visible above. Reversing the exclusion is
                done in the qualification panel; it does not by itself decide the
                product list.
              </p>
            </div>
          ) : null}

          {/* ---------------- STATE B — no verified sale header yet -------- */}
          {!decided && !excluded && !hasSaleHeader ? (
            <div className="mt-4 space-y-2 text-sm">
              <p className="text-slate-600">
                <strong className="font-semibold text-slate-900">
                  Finalize the sale details first.
                </strong>{" "}
                A product decision cannot be recorded until this receipt has an
                authoritative sale header.
              </p>
              <p className="text-xs text-slate-500">
                Use the sale panel above to accept the Sales Staff transaction
                details. The product list shown here is read-only until then, and
                nothing about it changes when the sale header is finalized.
              </p>
            </div>
          ) : null}

          {/* ---------------- STATE D — ready to decide -------------------- */}
          {canDecide ? (
            <form
              action={formAction}
              onSubmit={armSlowNotice}
              className="mt-4 border-t border-slate-200 pt-4"
            >
              <input
                type="hidden"
                name="receiptSubmissionId"
                value={receiptSubmissionId}
              />
              {/* The ONE decision field. Set by which button opened the dialog,
                  never typed, and empty when no dialog is open. */}
              <input type="hidden" name="decision" value={mode ?? ""} />

              <h3 className="text-sm font-medium text-slate-800">
                Decide the complete product list
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                Accept every line as written, or reject the list as a whole. This
                decision is permanent: it cannot be reopened, replaced or
                corrected, and the Sales Staff member cannot submit a new proposal
                for this receipt.
              </p>

              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button
                  ref={acceptRef}
                  type="button"
                  onClick={() => setMode("ACCEPTED")}
                  disabled={pending}
                  aria-haspopup="dialog"
                  aria-expanded={mode === "ACCEPTED"}
                  className={buttonClasses({ variant: "secondary" })}
                >
                  Accept complete product list
                </button>
                <button
                  ref={rejectRef}
                  type="button"
                  onClick={() => setMode("REJECTED")}
                  disabled={pending}
                  aria-haspopup="dialog"
                  aria-expanded={mode === "REJECTED"}
                  className={buttonClasses({ variant: "outline" })}
                >
                  Reject complete product list
                </button>
              </div>

              {pending ? (
                <p role="status" className="mt-3 text-sm text-slate-600">
                  {slow ? SLOW_REQUEST_MESSAGE : PENDING_REQUEST_MESSAGE}
                </p>
              ) : null}

              {/* ---------------- THE CONFIRMATION DIALOG ----------------- */}
              {mode !== null && (
                <div
                  className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
                  onMouseDown={(event) => {
                    if (event.target === event.currentTarget && !pending) {
                      setMode(null);
                    }
                  }}
                >
                  <div
                    ref={dialogRef}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={headingId}
                    aria-describedby={descriptionId}
                    tabIndex={-1}
                    className="flex max-h-full w-full flex-col overflow-y-auto rounded-t-2xl bg-white shadow-xl outline-none sm:max-w-lg sm:rounded-2xl"
                  >
                    <div className="border-b border-slate-200 px-5 py-4">
                      <h2
                        id={headingId}
                        className="text-base font-semibold text-slate-900"
                      >
                        {mode === "ACCEPTED"
                          ? "Accept the complete product list permanently?"
                          : "Reject the complete product list permanently?"}
                      </h2>
                    </div>

                    <div
                      id={descriptionId}
                      className="space-y-3 px-5 py-4 text-sm text-slate-600"
                    >
                      {mode === "ACCEPTED" ? (
                        <>
                          <p>
                            Every one of the {context.proposalLineCount} proposal
                            lines shown above will become an authoritative sale
                            item, exactly as written.
                          </p>
                          <p>
                            <strong className="font-semibold text-slate-900">
                              The complete list is accepted together.
                            </strong>{" "}
                            Products and quantities cannot be edited, added,
                            removed or reordered here.
                          </p>
                          <p>
                            This decision is{" "}
                            <strong className="font-semibold text-slate-900">
                              permanent
                            </strong>
                            . It cannot be reopened, replaced or corrected
                            afterwards.
                          </p>
                          <p>
                            The receipt&rsquo;s VERIFIED review decision does not
                            change, no campaign is being evaluated, and no reward
                            or coins are being created.
                          </p>
                        </>
                      ) : (
                        <>
                          <p>
                            <strong className="font-semibold text-slate-900">
                              The complete list will be rejected.
                            </strong>{" "}
                            All {context.proposalLineCount} lines are rejected
                            together — a single line cannot be rejected on its own.
                            No authoritative sale items will exist for this
                            receipt.
                          </p>
                          <p>
                            The receipt&rsquo;s VERIFIED review decision is a
                            separate decision and{" "}
                            <strong className="font-semibold text-slate-900">
                              remains unchanged
                            </strong>
                            .
                          </p>
                          <p>
                            This decision is{" "}
                            <strong className="font-semibold text-slate-900">
                              permanent
                            </strong>
                            . There is no correction flow in this milestone: the
                            Sales Staff member cannot submit a corrected proposal
                            for this receipt.
                          </p>

                          <fieldset
                            className="pt-1"
                            aria-describedby={
                              state.fieldErrors.rejectionReason
                                ? reasonErrorId
                                : undefined
                            }
                          >
                            <legend className="text-sm font-medium text-slate-800">
                              Why is the product list being rejected?
                            </legend>
                            <div className="mt-2 space-y-2">
                              {PRODUCT_REJECTION_REASONS.map((code) => (
                                <label
                                  key={code}
                                  className={cn(
                                    "flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm",
                                    reason === code
                                      ? "border-indigo-400 bg-indigo-50/60 ring-1 ring-indigo-200"
                                      : "border-slate-200 hover:bg-slate-50",
                                  )}
                                >
                                  <input
                                    type="radio"
                                    name="rejectionReason"
                                    value={code}
                                    checked={reason === code}
                                    onChange={(event) =>
                                      setReason(
                                        isProductRejectionReason(
                                          event.target.value,
                                        )
                                          ? event.target.value
                                          : null,
                                      )
                                    }
                                    disabled={pending}
                                    className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                                  />
                                  <span className="min-w-0 break-words font-medium text-slate-900">
                                    {PRODUCT_REJECTION_REASON_LABELS[code]}
                                  </span>
                                </label>
                              ))}
                            </div>
                            {state.fieldErrors.rejectionReason && (
                              <FieldError id={reasonErrorId}>
                                {state.fieldErrors.rejectionReason}
                              </FieldError>
                            )}
                          </fieldset>

                          <div className="space-y-1.5 pt-1">
                            <Label
                              htmlFor={noteId}
                              required={productReasonRequiresNote(reason)}
                              optional={!productReasonRequiresNote(reason)}
                            >
                              Note for the record
                            </Label>
                            <textarea
                              id={noteId}
                              name="reviewerNote"
                              rows={3}
                              value={note}
                              onChange={(event) => setNote(event.target.value)}
                              disabled={pending}
                              maxLength={PRODUCT_NOTE_MAX_LENGTH}
                              aria-describedby={cn(
                                noteCountId,
                                state.fieldErrors.reviewerNote
                                  ? noteErrorId
                                  : undefined,
                              )}
                              className={textareaClasses(
                                Boolean(state.fieldErrors.reviewerNote),
                              )}
                            />
                            <p
                              id={noteCountId}
                              className={cn(
                                "text-xs",
                                noteTooLong ? "text-red-700" : "text-slate-500",
                              )}
                            >
                              {noteTrimmed.length} of {PRODUCT_NOTE_MAX_LENGTH}{" "}
                              characters
                              {productReasonRequiresNote(reason)
                                ? " · a note is required for this reason"
                                : " · optional for this reason"}
                            </p>
                            {state.fieldErrors.reviewerNote && (
                              <FieldError id={noteErrorId}>
                                {state.fieldErrors.reviewerNote}
                              </FieldError>
                            )}
                          </div>
                        </>
                      )}

                      {pending && (
                        // One live region for the whole submit lifecycle, so a
                        // screen reader hears each sentence once.
                        <p role="status" className="text-slate-600">
                          {slow ? SLOW_REQUEST_MESSAGE : PENDING_REQUEST_MESSAGE}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          if (!pending) setMode(null);
                        }}
                        disabled={pending}
                      >
                        Cancel
                      </Button>
                      {/* The ONLY submit in this component. */}
                      <Button
                        type="submit"
                        variant={mode === "REJECTED" ? "danger" : "primary"}
                        loading={pending}
                        loadingLabel="Saving…"
                        disabled={confirmDisabled}
                      >
                        {mode === "ACCEPTED"
                          ? "Yes, accept the whole list"
                          : "Yes, reject the whole list"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </form>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * The immutable Sales Staff proposal. Read-only by construction — there is no
 * input, no select and no button on a line, so nothing about a product or a
 * quantity can be changed from here.
 */
function ProposalBody({
  lines,
  lineCount,
  totalQuantity,
}: {
  lines: readonly ClaimProductProposalLine[];
  lineCount: number;
  totalQuantity: number;
}) {
  return (
    <div className="mt-3 space-y-3 text-sm">
      <div>
        <h3 className="text-sm font-medium text-slate-800">
          Product list submitted by Sales Staff
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          These values were frozen when the receipt details were confirmed. You are
          accepting or rejecting the complete list — products and quantities cannot
          be edited, added, removed or reordered by a reviewer.
        </p>
      </div>

      <ol className="space-y-3">
        {lines.map((line) => (
          <ProposalLineBody key={line.lineNumber} line={line} />
        ))}
      </ol>

      <dl className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Lines
            </dt>
            <dd className="mt-0.5 text-slate-800">{lineCount}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Total quantity
            </dt>
            <dd className="mt-0.5 text-slate-800">{totalQuantity}</dd>
          </div>
        </div>
      </dl>

      <p className="text-xs text-slate-500">
        Receipt-photo verification is a separate decision and is not changed by
        anything here. Accepting or rejecting this list evaluates no campaign and
        creates no reward and no coins.
      </p>
    </div>
  );
}

/** One proposal line. Frozen values first, current state clearly labelled after. */
function ProposalLineBody({ line }: { line: ClaimProductProposalLine }) {
  const warn = hasCurrentStateWarning(line);

  return (
    <li className="rounded-xl border border-slate-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 break-words font-medium text-slate-900">
          <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Line {line.lineNumber}
          </span>
          {line.productName ?? "Product name not recorded"}
        </p>
        <p className="shrink-0 text-slate-800">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Quantity
          </span>{" "}
          <span className="font-semibold">{line.quantity}</span>
        </p>
      </div>

      <dl className="mt-2 space-y-1 text-xs text-slate-600">
        <div className="break-words">
          <dt className="inline font-medium text-slate-500">Product code: </dt>
          <dd className="inline">{line.productCode ?? "Not recorded"}</dd>
        </div>
        {line.barcode ? (
          <div className="break-all">
            <dt className="inline font-medium text-slate-500">Barcode: </dt>
            <dd className="inline">{line.barcode}</dd>
          </div>
        ) : null}
        {line.brand ? (
          <div className="break-words">
            <dt className="inline font-medium text-slate-500">Brand: </dt>
            <dd className="inline">{line.brand}</dd>
          </div>
        ) : null}
      </dl>

      {/* FROZEN and CURRENT, side by side and named as such. The frozen value is
          what was accepted; the current one is context. */}
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge tone="slate">{proposalStatusLabel(line.statusAtProposal)}</Badge>
        <Badge tone={line.statusCurrent === "INACTIVE" ? "amber" : "slate"}>
          {currentStatusLabel(line.statusCurrent)}
        </Badge>
        <Badge tone={line.assignedCurrently === false ? "amber" : "slate"}>
          {currentAssignmentLabel(line.assignedCurrently)}
        </Badge>
      </div>

      {warn ? (
        <p className="mt-2 text-xs text-slate-500">
          This product has changed in the catalogue since it was proposed. The
          frozen values above are what this receipt recorded and remain
          authoritative, so this does not stop you accepting or rejecting the list.
        </p>
      ) : null}
    </li>
  );
}

/**
 * STATE E. The AUTHORITATIVE items, read from `get_verified_sale_items` — never
 * rebuilt from the proposal.
 */
function AcceptedItemsBody({
  context,
  sale,
}: {
  context: ClaimReceiptProductContext;
  sale: VerifiedSaleItems | null;
}) {
  if (sale === null) {
    return (
      <Alert tone="info" className="mt-3">
        The complete product list for this receipt was accepted, but the
        authoritative sale items could not be read just now. Refresh to see them.
        Nothing about the decision has changed, and it cannot be reopened or
        replaced.
      </Alert>
    );
  }

  const totalQuantity = totalProposedQuantity(sale.items);

  return (
    <div className="mt-3 space-y-3 text-sm">
      <p className="text-slate-600">
        The complete product list was accepted. These are the authoritative sale
        items for this receipt.{" "}
        <strong className="font-semibold text-slate-900">
          They cannot be edited, reordered or deleted
        </strong>
        , and no further product decision can be recorded.
      </p>

      <ol className="space-y-3">
        {sale.items.map((item) => (
          <li
            key={item.lineNumber}
            className="rounded-xl border border-slate-200 p-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="min-w-0 break-words font-medium text-slate-900">
                <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Line {item.lineNumber}
                </span>
                {item.productName ?? "Product name not recorded"}
              </p>
              <p className="shrink-0 text-slate-800">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Quantity
                </span>{" "}
                <span className="font-semibold">{item.quantity}</span>
              </p>
            </div>
            <dl className="mt-2 space-y-1 text-xs text-slate-600">
              <div className="break-words">
                <dt className="inline font-medium text-slate-500">
                  Product code:{" "}
                </dt>
                <dd className="inline">{item.productCode ?? "Not recorded"}</dd>
              </div>
              {item.barcode ? (
                <div className="break-all">
                  <dt className="inline font-medium text-slate-500">Barcode: </dt>
                  <dd className="inline">{item.barcode}</dd>
                </div>
              ) : null}
              {item.brand ? (
                <div className="break-words">
                  <dt className="inline font-medium text-slate-500">Brand: </dt>
                  <dd className="inline">{item.brand}</dd>
                </div>
              ) : null}
            </dl>
            <div className="mt-2">
              <Badge tone="slate">
                {proposalStatusLabel(item.statusAtProposal)}
              </Badge>
            </div>
          </li>
        ))}
      </ol>

      <dl className="space-y-2">
        <Row label="Lines">{sale.items.length}</Row>
        <Row label="Total quantity">{totalQuantity}</Row>
        <Row label="Decided">
          {formatUtcInstant(sale.decidedAt ?? context.decidedAt) ??
            "Not recorded"}
        </Row>
        {sale.decidedByDisplayName ?? context.decidedByDisplayName ? (
          <Row label="Decided by">
            {sale.decidedByDisplayName ?? context.decidedByDisplayName}
          </Row>
        ) : null}
      </dl>

      <p className="text-xs text-slate-500">
        The receipt&rsquo;s VERIFIED review decision is a separate decision and is
        unchanged. No campaign has been evaluated and no reward or coins exist for
        this receipt.
      </p>
    </div>
  );
}

/** STATE F. The rejection, read-only, with zero authoritative sale items. */
function RejectedDecisionBody({
  context,
}: {
  context: ClaimReceiptProductContext;
}) {
  return (
    <div className="mt-4 space-y-3 border-t border-slate-200 pt-4 text-sm">
      <p className="text-slate-600">
        The complete product list was rejected.{" "}
        <strong className="font-semibold text-slate-900">
          There are no authoritative sale items for this receipt
        </strong>
        , and none can be added: the decision cannot be reopened or replaced, and
        no corrected proposal can be submitted in this milestone.
      </p>

      <dl className="space-y-2">
        {context.rejectionReason ? (
          <Row label="Reason">
            {
              PRODUCT_REJECTION_REASON_LABELS[
                context.rejectionReason as ProductRejectionReason
              ]
            }
          </Row>
        ) : null}
        {context.reviewerNote ? (
          <Row label="Reviewer note">
            <span className="whitespace-pre-wrap break-words">
              {context.reviewerNote}
            </span>
          </Row>
        ) : null}
        <Row label="Decided">
          {formatUtcInstant(context.decidedAt) ?? "Not recorded"}
        </Row>
        {context.decidedByDisplayName ? (
          <Row label="Decided by">{context.decidedByDisplayName}</Row>
        ) : null}
      </dl>

      <p className="text-xs text-slate-500">
        The receipt&rsquo;s VERIFIED review decision is separate and is unchanged.
        Its sale header, if one was finalized, also remains exactly as it was. No
        campaign has been evaluated and no reward or coins exist.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 text-slate-800">{children}</dd>
    </div>
  );
}
