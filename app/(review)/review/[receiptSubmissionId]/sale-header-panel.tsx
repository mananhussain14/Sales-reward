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
import { finalizeSaleHeaderAction } from "@/app/(review)/review/[receiptSubmissionId]/sale-finalization-actions";
import {
  type SaleFinalizationActionState,
  INITIAL_SALE_FINALIZATION_ACTION_STATE,
} from "@/app/(review)/review/[receiptSubmissionId]/sale-finalization-action-state";
import {
  isDstAmbiguityChoice,
  type DstAmbiguityChoice,
} from "@/lib/review/claim-sale-finalization-input";
import {
  REFRESHING_MESSAGE,
  SLOW_REQUEST_MESSAGE,
  SLOW_REQUEST_NOTICE_MS,
  shouldRefreshAfterSaleFinalizationSettlement,
} from "@/lib/review/claim-sale-finalization-settlement";
import {
  changedFieldLabel,
  dstChoiceLabel,
  entryModeLabel,
  formatLocalPrinted,
  formatMinorAmount,
  formatUtcInstant,
  precisionLabel,
} from "@/lib/review/claim-sale-display";
import type { ClaimReceiptSaleContext } from "@/lib/review/claim-receipt-sale-context";
import type { VerifiedSaleHeader } from "@/lib/review/verified-sale-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { FieldError } from "@/components/ui/field";

/**
 * Whether this receipt may become an authoritative sale — and, once it has, what
 * that sale permanently says.
 *
 * ============================================================================
 * THREE SEPARATE FACTS ON ONE PAGE
 * ============================================================================
 * The decision panel says the IMAGE was verified. The qualification panel says
 * the record is not excluded. This one says a Claim Reviewer accepted the Sales
 * Staff figures as authoritative. All three are true at once and none overwrites
 * another, so the copy repeats that in every state.
 *
 * ============================================================================
 * THE REVIEWER ACCEPTS OR DECLINES — NOTHING HERE IS EDITABLE
 * ============================================================================
 * Every figure shown is the immutable Sales Staff proposal, rendered read-only.
 * There is no input for an amount, a date, a merchant or a time, because the
 * database copies them and would refuse a row that did not match. The only
 * judgement the reviewer supplies is which of two real instants an ambiguous
 * local time meant.
 */
export function SaleHeaderPanel({
  receiptSubmissionId,
  context,
  header,
}: {
  receiptSubmissionId: string;
  /** `null` when the state could not be read — the panel then says so. */
  context: ClaimReceiptSaleContext | null;
  /** The finalized header, when one exists and could be read. */
  header: VerifiedSaleHeader | null;
}) {
  const [state, formAction, pending] = useActionState<
    SaleFinalizationActionState,
    FormData
  >(finalizeSaleHeaderAction, INITIAL_SALE_FINALIZATION_ACTION_STATE);

  const [choice, setChoice] = useState<DstAmbiguityChoice | null>(null);
  const [open, setOpen] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const choiceGroupRef = useRef<HTMLFieldSetElement | null>(null);
  const headingId = useId();
  const descriptionId = useId();
  const choiceErrorId = useId();

  // Closed during RENDER against the previous result rather than in an effect:
  // an effect would paint the stale dialog first and then immediately re-render
  // to close it. Matches the decision and qualification forms.
  const [lastResult, setLastResult] = useState(state);
  if (state !== lastResult) {
    setLastResult(state);
    if (
      state.formError ||
      state.needsDstChoice ||
      Object.keys(state.fieldErrors).length > 0
    ) {
      setOpen(false);
    }
  }

  useEffect(() => {
    if (open) dialogRef.current?.focus();
    else openerRef.current?.focus();
  }, [open]);

  // The database asked for a daylight-saving selection. Put the reviewer where
  // they can answer it rather than leaving them to find the controls.
  useEffect(() => {
    if (state.needsDstChoice) choiceGroupRef.current?.focus();
  }, [state.needsDstChoice]);

  // Escape closes — but never mid-submit, so a stray keypress cannot leave a
  // reviewer unsure whether an immutable sale was created.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

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
  // the manual uncertain-result button go through here.
  const refreshSaleStatus = useCallback(() => {
    startRefresh(() => {
      router.refresh();
    });
  }, [router]);

  useEffect(() => {
    if (!shouldRefreshAfterSaleFinalizationSettlement(state)) return;
    if (refreshRequested.current) return;
    refreshRequested.current = true;
    refreshSaleStatus();
  }, [state, refreshSaleStatus]);

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
  const excluded = context?.isQualificationExcluded === true;
  const finalized = context?.alreadyFinalized === true || header !== null;
  const hasProposal = context?.hasConfirmation === true;
  const timeStatus = context?.timeStatus ?? null;

  // A read outage must never present as finalizable, and neither must a state the
  // database says is blocked. Every gate below is a REASON not to offer the
  // action; the database re-checks all of them anyway.
  const timeBlocks =
    timeStatus === "NONEXISTENT" || timeStatus === "NO_TIMEZONE";
  const ambiguous = timeStatus === "AMBIGUOUS";
  const canOfferFinalization =
    !unavailable && !excluded && !finalized && hasProposal && !timeBlocks;
  const readyToConfirm = !ambiguous || choice !== null;

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
      aria-labelledby="sale-header-heading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="sale-header-heading"
          className="text-sm font-semibold text-slate-900"
        >
          Authoritative sale
        </h2>
        {!unavailable && (
          // The word carries the meaning; tone only reinforces it.
          <Badge
            tone={
              finalized ? "emerald" : excluded ? "amber" : hasProposal ? "slate" : "slate"
            }
          >
            {finalized
              ? "Finalized"
              : excluded
                ? "Blocked by exclusion"
                : hasProposal
                  ? "Not yet finalized"
                  : "Waiting for staff details"}
          </Badge>
        )}
      </div>

      {unavailable ? (
        <Alert tone="warning" className="mt-3">
          The sale status of this receipt is temporarily unavailable. Refresh to
          try again. The review decision and qualification state above are
          unaffected, and nothing can be finalized while this is unreadable.
        </Alert>
      ) : null}

      {/* THE AUTHORITATIVE ANSWER, rendered before anything is re-fetched. */}
      {state.settled ? (
        <>
          <Alert
            tone={
              state.outcome === "CONFLICT"
                ? "warning"
                : state.outcome === "FINALIZED"
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

      {/* The database asked a question. Not settled — the form stays open. */}
      {state.outcome === "AMBIGUOUS_TIME_REQUIRES_CHOICE" && !state.settled ? (
        <Alert tone="warning" role="alert" className="mt-3">
          {state.message}
        </Alert>
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
                onClick={refreshSaleStatus}
                disabled={isRefreshing}
                className={buttonClasses({ variant: "secondary" })}
              >
                {isRefreshing ? "Refreshing…" : "Refresh sale status"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ---------------- STATE H — already finalized (read-only) ---------- */}
      {!unavailable && finalized ? (
        <FinalizedHeaderBody header={header} />
      ) : null}

      {/* ---------------- STATE A — blocked by a qualification exclusion --- */}
      {!unavailable && !finalized && excluded ? (
        <div className="mt-3 space-y-3 text-sm">
          <p className="text-slate-600">
            <strong className="font-semibold text-slate-900">
              Sale finalization is blocked.
            </strong>{" "}
            This receipt has an active qualification exclusion, so it cannot
            become an authoritative sale, enter campaign qualification, or earn a
            reward or coins.
          </p>
          {context?.exclusionReason ? (
            <Row label="Exclusion reason">
              {context.exclusionReason === "TEST_DATA"
                ? "Test data"
                : context.exclusionReason === "NON_QUALIFYING"
                  ? "Non-qualifying"
                  : context.exclusionReason === "DUPLICATE"
                    ? "Duplicate"
                    : context.exclusionReason}
            </Row>
          ) : null}
          <p className="text-xs text-slate-500">
            The receipt&rsquo;s VERIFIED review decision is unchanged and remains
            visible above. Reversing the exclusion is done in the qualification
            panel; it does not by itself create a sale.
          </p>
        </div>
      ) : null}

      {/* ---------------- STATE B — no staff proposal yet ------------------ */}
      {!unavailable && !finalized && !excluded && !hasProposal ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-slate-600">
            Waiting for Sales Staff transaction details.
          </p>
          <p className="text-xs text-slate-500">
            The receipt image may already be VERIFIED, but a sale cannot be
            finalized until the Sales Staff member who submitted it has entered
            the transaction details from the receipt. This is a normal step, not a
            problem with this receipt.
          </p>
        </div>
      ) : null}

      {/* ------------- STATES C–G — a proposal exists, show it ------------- */}
      {!unavailable && !finalized && !excluded && hasProposal && context ? (
        <>
          <ProposalBody context={context} />

          {timeStatus === "NO_TIMEZONE" ? (
            <Alert tone="warning" className="mt-4">
              This shop has no time zone recorded, so the moment of sale cannot be
              resolved. An operator must set the shop&rsquo;s time zone before
              this receipt can be finalized. Nothing is assumed — the sale is not
              placed in UTC or any other fallback zone.
            </Alert>
          ) : null}

          {timeStatus === "NONEXISTENT" ? (
            <Alert tone="warning" className="mt-4">
              The local time printed on this receipt did not exist in{" "}
              {context.timezoneName ?? "the shop's time zone"} on that date —
              the clocks moved forward past it. This receipt cannot be finalized,
              and the time is not silently adjusted. The transaction details need
              to be corrected.
            </Alert>
          ) : null}

          {!timeBlocks ? (
            <form
              action={formAction}
              onSubmit={armSlowNotice}
              className="mt-4"
            >
              <input
                type="hidden"
                name="receiptSubmissionId"
                value={receiptSubmissionId}
              />

              <SaleTimeBody context={context} />

              {/* ---------- STATE E — ambiguous, an explicit choice ------- */}
              {ambiguous ? (
                <fieldset
                  ref={choiceGroupRef}
                  tabIndex={-1}
                  className="mt-4 outline-none"
                  aria-describedby={choiceErrorId}
                >
                  <legend className="text-sm font-medium text-slate-800">
                    Which of the two moments was the sale?
                  </legend>
                  <p className="mt-1 text-xs text-slate-500">
                    The clocks went back on this date, so{" "}
                    {formatLocalPrinted(
                      context.transactionDate,
                      context.transactionTime,
                    )}{" "}
                    happened twice in {context.timezoneName ?? "this time zone"}.
                    Neither is assumed to be correct — choose the one that matches
                    the sale.
                  </p>
                  <div className="mt-2 space-y-2">
                    {(
                      [
                        {
                          code: "FIRST" as const,
                          title: "First occurrence",
                          hint: "The earlier of the two instants, before the clocks changed.",
                          candidate: context.firstSaleAtCandidate,
                        },
                        {
                          code: "SECOND" as const,
                          title: "Second occurrence",
                          hint: "The later of the two instants, after the clocks changed.",
                          candidate: context.secondSaleAtCandidate,
                        },
                      ] as const
                    ).map((option) => (
                      <label
                        key={option.code}
                        className={cn(
                          "flex cursor-pointer gap-3 rounded-xl border p-3 text-sm",
                          choice === option.code
                            ? "border-indigo-400 bg-indigo-50/60 ring-1 ring-indigo-200"
                            : "border-slate-200 hover:bg-slate-50",
                        )}
                      >
                        <input
                          type="radio"
                          name="dstAmbiguityChoice"
                          value={option.code}
                          checked={choice === option.code}
                          onChange={(event) =>
                            setChoice(
                              isDstAmbiguityChoice(event.target.value)
                                ? event.target.value
                                : null,
                            )
                          }
                          disabled={pending}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                        />
                        <span className="min-w-0">
                          <span className="block font-medium text-slate-900">
                            {option.title}
                          </span>
                          <span className="block break-words text-xs text-slate-600">
                            {formatUtcInstant(option.candidate) ??
                              "Instant unavailable"}
                          </span>
                          <span className="block text-xs text-slate-500">
                            {option.hint}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {state.fieldErrors.dstAmbiguityChoice && (
                    <FieldError id={choiceErrorId}>
                      {state.fieldErrors.dstAmbiguityChoice}
                    </FieldError>
                  )}
                </fieldset>
              ) : null}

              <div className="mt-4">
                <button
                  ref={openerRef}
                  type="button"
                  onClick={() => setOpen(true)}
                  disabled={!canOfferFinalization || !readyToConfirm || pending}
                  aria-haspopup="dialog"
                  aria-expanded={open}
                  className={buttonClasses({ variant: "secondary" })}
                >
                  Finalize sale header
                </button>
                {ambiguous && choice === null ? (
                  <p className="mt-2 text-xs text-slate-500">
                    Choose the first or second occurrence to continue.
                  </p>
                ) : null}
              </div>

              {/* ---------------- STAGE 11 — final confirmation ----------- */}
              {open && (
                <div
                  className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
                  onMouseDown={(event) => {
                    if (event.target === event.currentTarget && !pending) {
                      setOpen(false);
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
                    className="flex w-full flex-col rounded-t-2xl bg-white shadow-xl outline-none sm:max-w-md sm:rounded-2xl"
                  >
                    <div className="border-b border-slate-200 px-5 py-4">
                      <h2
                        id={headingId}
                        className="text-base font-semibold text-slate-900"
                      >
                        Finalize this sale header?
                      </h2>
                    </div>

                    <div
                      id={descriptionId}
                      className="space-y-3 px-5 py-4 text-sm text-slate-600"
                    >
                      <p>
                        You are accepting the Sales Staff transaction details for
                        this receipt as authoritative.
                      </p>
                      <p>
                        <strong className="font-semibold text-slate-900">
                          The VERIFIED review decision will not change.
                        </strong>{" "}
                        It stays visible in review history exactly as it is.
                      </p>
                      <p>
                        The resolved sale time and time zone are{" "}
                        <strong className="font-semibold text-slate-900">
                          frozen permanently
                        </strong>
                        . If this shop&rsquo;s time zone is corrected later, this
                        sale will not move.
                      </p>
                      {choice ? (
                        <p className="rounded-lg bg-slate-50 p-3 text-slate-700">
                          <span className="block text-xs font-medium text-slate-500">
                            Your selection
                          </span>
                          {dstChoiceLabel(choice)} —{" "}
                          {formatUtcInstant(
                            choice === "FIRST"
                              ? context.firstSaleAtCandidate
                              : context.secondSaleAtCandidate,
                          )}
                        </p>
                      ) : null}
                      <p>
                        The sale header is append-only and audited: it cannot be
                        edited or deleted afterwards. If an active qualification
                        exclusion is recorded first, this will be refused.
                      </p>
                      <p>
                        No products are being confirmed, no campaign is being
                        evaluated, and no reward or coins are being created.
                      </p>
                      {pending && (
                        // One live region for the whole submit lifecycle, so a
                        // screen reader hears each sentence once.
                        <p role="status" className="text-slate-600">
                          {slow ? SLOW_REQUEST_MESSAGE : "Finalizing sale…"}
                        </p>
                      )}
                    </div>

                    <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          if (!pending) setOpen(false);
                        }}
                        disabled={pending}
                      >
                        Cancel
                      </Button>
                      {/* The ONLY submit in this component. */}
                      <Button
                        type="submit"
                        variant="primary"
                        loading={pending}
                        loadingLabel="Finalizing…"
                      >
                        Yes, finalize this sale
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

/** The immutable Sales Staff proposal. Read-only by construction — no inputs. */
function ProposalBody({ context }: { context: ClaimReceiptSaleContext }) {
  const total = formatMinorAmount(context.totalMinor, context.currencyCode);
  const subtotal = formatMinorAmount(context.subtotalMinor, context.currencyCode);
  const tax = formatMinorAmount(context.taxTotalMinor, context.currencyCode);

  return (
    <div className="mt-3 space-y-3 text-sm">
      <div>
        <h3 className="text-sm font-medium text-slate-800">
          Sales Staff proposal
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Entered by the Sales Staff member who submitted this receipt. You are
          accepting or declining these values — they cannot be edited here.
        </p>
      </div>

      <dl className="space-y-2">
        <Row label="Date">
          {formatLocalPrinted(context.transactionDate, context.transactionTime) ??
            "Not recorded"}
        </Row>
        {total ? (
          <Row label="Total">
            <span className="break-words">{total.text}</span>
            {!total.exact ? (
              <span className="block text-xs text-slate-500">
                Shown in minor units — this currency is not in the reference
                catalogue.
              </span>
            ) : null}
          </Row>
        ) : null}
        {subtotal ? <Row label="Subtotal">{subtotal.text}</Row> : null}
        {tax ? <Row label="Tax">{tax.text}</Row> : null}
        {context.merchantName ? (
          <Row label="Shop name">
            <span className="break-words">{context.merchantName}</span>
          </Row>
        ) : null}
        {context.documentNumber ? (
          <Row label="Receipt number">
            <span className="break-words">{context.documentNumber}</span>
          </Row>
        ) : null}
        <Row label="How it was entered">{entryModeLabel(context.entryMode)}</Row>
        {context.changedFields.length > 0 ? (
          <Row label="Corrected by staff">
            {context.changedFields.map(changedFieldLabel).join(", ")}
          </Row>
        ) : null}
      </dl>
    </div>
  );
}

/** What the frozen sale instant will be, and why. States F and G. */
function SaleTimeBody({ context }: { context: ClaimReceiptSaleContext }) {
  const preview = formatUtcInstant(context.resolvedSaleAtPreview);
  const dateOnly = context.saleTimePrecision === "DATE_ONLY";

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
      <h3 className="text-sm font-medium text-slate-800">
        Moment of sale, once finalized
      </h3>
      <dl className="mt-2 space-y-2 text-sm">
        <Row label="Shop time zone">
          {context.timezoneName ?? "Not recorded"}
        </Row>
        <Row label="Precision">
          {precisionLabel(context.saleTimePrecision) ?? "Not resolved"}
        </Row>
        {dateOnly ? (
          <Row label="No time on the receipt">
            Resolved to 12:00 local time in the shop&rsquo;s time zone, so the
            sale sits on the right day without claiming a time nobody printed.
          </Row>
        ) : null}
        {preview ? (
          <Row label="Resolved instant">
            <span className="break-words">{preview}</span>
          </Row>
        ) : null}
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        This instant is frozen when you finalize. Later changes to the shop&rsquo;s
        time zone will not move it.
      </p>
    </div>
  );
}

/** State H. The finalized header, read-only and with no correction affordance. */
function FinalizedHeaderBody({ header }: { header: VerifiedSaleHeader | null }) {
  if (header === null) {
    return (
      <Alert tone="info" className="mt-3">
        This receipt already has an authoritative sale header, but its details
        could not be read just now. Refresh to see them. Nothing about the sale
        has changed.
      </Alert>
    );
  }

  const total = formatMinorAmount(header.totalMinor, header.currencyCode);
  const subtotal = formatMinorAmount(header.subtotalMinor, header.currencyCode);
  const tax = formatMinorAmount(header.taxTotalMinor, header.currencyCode);

  return (
    <div className="mt-3 space-y-3 text-sm">
      <p className="text-slate-600">
        This receipt has been accepted as an authoritative sale.{" "}
        <strong className="font-semibold text-slate-900">
          Its VERIFIED review decision is unchanged
        </strong>{" "}
        and remains visible above.
      </p>

      <dl className="space-y-2">
        <Row label="Date on receipt">
          {formatLocalPrinted(header.transactionDate, header.transactionTime) ??
            "Not recorded"}
        </Row>
        <Row label="Moment of sale">
          <span className="break-words">
            {formatUtcInstant(header.saleAt) ?? "Not recorded"}
          </span>
        </Row>
        <Row label="Shop time zone">{header.timezoneName ?? "Not recorded"}</Row>
        <Row label="Precision">
          {precisionLabel(header.saleTimePrecision) ?? "Not recorded"}
        </Row>
        {header.dstAmbiguityChoice ? (
          <Row label="Daylight-saving interpretation">
            {dstChoiceLabel(header.dstAmbiguityChoice)}
          </Row>
        ) : null}
        {total ? (
          <Row label="Total">
            <span className="break-words">{total.text}</span>
          </Row>
        ) : null}
        {subtotal ? <Row label="Subtotal">{subtotal.text}</Row> : null}
        {tax ? <Row label="Tax">{tax.text}</Row> : null}
        {header.merchantName ? (
          <Row label="Shop name">
            <span className="break-words">{header.merchantName}</span>
          </Row>
        ) : null}
        {header.documentNumber ? (
          <Row label="Receipt number">
            <span className="break-words">{header.documentNumber}</span>
          </Row>
        ) : null}
        <Row label="Finalized">
          {formatUtcInstant(header.finalizedAt) ?? "Not recorded"}
        </Row>
        {header.finalizedByDisplayName ? (
          <Row label="Finalized by">{header.finalizedByDisplayName}</Row>
        ) : null}
      </dl>

      <p className="text-xs text-slate-500">
        This sale header is append-only: it cannot be edited or deleted, and the
        frozen instant will not move if the shop&rsquo;s time zone changes. No
        products have been confirmed, no campaign has been evaluated, and no
        reward or coins exist for it.
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
