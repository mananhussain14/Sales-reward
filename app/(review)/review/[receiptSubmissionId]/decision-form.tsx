"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { decideReceiptAction } from "@/app/(review)/review/[receiptSubmissionId]/actions";
import {
  type DecisionActionState,
  INITIAL_DECISION_ACTION_STATE,
} from "@/app/(review)/review/[receiptSubmissionId]/decision-action-state";
import {
  CLAIM_REVIEW_NOTE_MAX_LENGTH,
  CLAIM_REVIEW_REJECTION_REASONS,
  type ClaimReviewDecision,
  type ClaimReviewRejectionReason,
  isRejectionReason,
  reasonRequiresNote,
  REJECTION_REASON_LABELS,
} from "@/lib/review/claim-review-decision-input";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  FieldError,
  FieldHint,
  Label,
  selectClasses,
  SelectChevron,
  textareaClasses,
} from "@/components/ui/field";

/**
 * Verify or reject one receipt.
 *
 * ============================================================================
 * ONE FORM, ONE DECISION, ONE CONFIRMATION
 * ============================================================================
 * The decision is a RADIO GROUP, not two submit buttons. Two buttons in one form
 * would let a stray Enter keypress pick whichever the browser considers default,
 * and a reviewer could never see which one they were about to send. A radio makes
 * the choice explicit, visible and impossible to hold both of.
 *
 * Nothing submits from the main form. The only submit button lives inside the
 * confirmation dialog, so reaching the database always costs a deliberate second
 * action that names what is about to happen.
 *
 * ============================================================================
 * THE FORM ELEMENT WRAPS THE DIALOG
 * ============================================================================
 * One <form> contains both the fields and the dialog's submit, so the reviewer's
 * reason and note travel with the confirmation. Splitting them would mean copying
 * values into hidden inputs and hoping the two copies agreed.
 *
 * ============================================================================
 * LOCAL STATE IS NEVER THE AUTHORITY
 * ============================================================================
 * This component tracks what the reviewer has TYPED. It never marks a receipt
 * decided on its own: the submit control disappears on `state.settled`, which is
 * set only after the database returned DECIDED, ALREADY_DECIDED or CONFLICT. An
 * outage leaves `settled` false so the reviewer can genuinely try again, and
 * nothing is ever rendered optimistically as final.
 */
export function DecisionForm({
  receiptSubmissionId,
}: {
  receiptSubmissionId: string;
}) {
  const [state, formAction, pending] = useActionState<
    DecisionActionState,
    FormData
  >(decideReceiptAction, INITIAL_DECISION_ACTION_STATE);

  const [decision, setDecision] = useState<ClaimReviewDecision | null>(null);
  const [reason, setReason] = useState<ClaimReviewRejectionReason | null>(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();
  const descriptionId = useId();
  const noteId = useId();
  const noteHintId = useId();
  const noteErrorId = useId();
  const reasonId = useId();
  const reasonErrorId = useId();
  const decisionErrorId = useId();

  // When a submission comes back REFUSED, the dialog must close so the reviewer
  // can see and fix the field errors underneath it.
  //
  // Adjusted DURING RENDER against the previous result rather than in an effect.
  // React documents this for exactly this case ("adjusting state when props
  // change"): an effect would render the stale open dialog first and then
  // immediately re-render to close it, which is both a visible flicker and the
  // cascading-render pattern the lint rule exists to prevent.
  //
  // The reviewer's note needs no restoring — it is local component state and
  // survives the action round trip untouched.
  const [lastResult, setLastResult] = useState(state);
  if (state !== lastResult) {
    setLastResult(state);
    if (state.formError || Object.keys(state.fieldErrors).length > 0) {
      setOpen(false);
    }
  }

  useEffect(() => {
    if (open) dialogRef.current?.focus();
    else openerRef.current?.focus();
  }, [open]);

  // Escape closes — but NEVER mid-submit, so a stray keypress cannot leave a
  // reviewer unsure whether their decision was recorded.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  const noteRequired = decision === "REJECTED" && reasonRequiresNote(reason);
  const trimmedNote = note.trim();
  const noteTooLong = trimmedNote.length > CLAIM_REVIEW_NOTE_MAX_LENGTH;

  // Gates only the CONFIRM button, never the database. The server revalidates all
  // of this and the RPC checks it again after that.
  const canConfirm =
    decision === "VERIFIED"
      ? !noteTooLong
      : decision === "REJECTED" &&
        reason !== null &&
        !noteTooLong &&
        (!noteRequired || trimmedNote.length > 0);

  // Once the database has spoken the whole form is finished. The page itself
  // re-reads the stored decision on the next render; this is the immediate answer.
  if (state.settled) {
    const tone =
      state.outcome === "DECIDED"
        ? "success"
        : state.outcome === "CONFLICT"
          ? "warning"
          : "info";
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
        <Alert
          tone={tone}
          title={
            state.outcome === "DECIDED"
              ? "Decision recorded"
              : state.outcome === "CONFLICT"
                ? "Already decided by another reviewer"
                : "Decision already recorded"
          }
        >
          {state.message}
        </Alert>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/review" className={buttonClasses({ variant: "primary" })}>
            Back to queue
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
      aria-labelledby="decision-heading"
    >
      <input
        type="hidden"
        name="receiptSubmissionId"
        value={receiptSubmissionId}
      />

      <h2 id="decision-heading" className="text-sm font-semibold text-slate-900">
        Record your decision
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Based on the receipt image only. Your decision is final and cannot be
        changed, reopened or deleted.
      </p>

      {state.formError && (
        <Alert tone="error" role="alert" className="mt-4">
          {state.formError}
        </Alert>
      )}

      {/* Decision — a radio group, so exactly one can be held at a time. */}
      <fieldset className="mt-4" aria-describedby={decisionErrorId}>
        <legend className="text-sm font-medium text-slate-800">Decision</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {(
            [
              {
                value: "VERIFIED" as const,
                label: "Verify receipt",
                hint: "The image is legible and looks genuine.",
              },
              {
                value: "REJECTED" as const,
                label: "Reject receipt",
                hint: "Something about this receipt is wrong.",
              },
            ] satisfies {
              value: ClaimReviewDecision;
              label: string;
              hint: string;
            }[]
          ).map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-xl border p-3 text-sm",
                decision === option.value
                  ? "border-indigo-400 bg-indigo-50/60 ring-1 ring-indigo-200"
                  : "border-slate-200 hover:bg-slate-50",
              )}
            >
              <input
                type="radio"
                name="decision"
                value={option.value}
                checked={decision === option.value}
                onChange={() => {
                  setDecision(option.value);
                  // Verifying must not carry a reason — the RPC refuses one, so
                  // the form drops it rather than sending something invalid.
                  if (option.value === "VERIFIED") setReason(null);
                }}
                disabled={pending}
                className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
              />
              <span className="min-w-0">
                {/* The words carry the meaning. Colour and position are
                    reinforcement, never the only signal. */}
                <span className="block font-medium text-slate-900">
                  {option.label}
                </span>
                <span className="block text-xs text-slate-500">
                  {option.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
        {state.fieldErrors.decision && (
          <FieldError id={decisionErrorId}>
            {state.fieldErrors.decision}
          </FieldError>
        )}
      </fieldset>

      {decision === "REJECTED" && (
        <div className="mt-4 space-y-2">
          <Label htmlFor={reasonId} required>
            Reason for rejection
          </Label>
          <div className="relative">
            <select
              id={reasonId}
              name="rejectionReason"
              value={reason ?? ""}
              onChange={(event) =>
                setReason(
                  isRejectionReason(event.target.value)
                    ? event.target.value
                    : null,
                )
              }
              disabled={pending}
              aria-describedby={
                state.fieldErrors.rejectionReason ? reasonErrorId : undefined
              }
              className={selectClasses(Boolean(state.fieldErrors.rejectionReason))}
            >
              <option value="">Choose a reason…</option>
              {CLAIM_REVIEW_REJECTION_REASONS.map((code) => (
                <option key={code} value={code}>
                  {REJECTION_REASON_LABELS[code]}
                </option>
              ))}
            </select>
            <SelectChevron />
          </div>
          {state.fieldErrors.rejectionReason && (
            <FieldError id={reasonErrorId}>
              {state.fieldErrors.rejectionReason}
            </FieldError>
          )}
        </div>
      )}

      {/* The note is offered for BOTH decisions — it is optional when verifying —
          so the field does not appear and disappear as the reviewer changes their
          mind about what they saw. */}
      {decision !== null && (
        <div className="mt-4 space-y-2">
          <Label htmlFor={noteId} required={noteRequired}>
            Reviewer note
          </Label>
          <textarea
            id={noteId}
            name="reviewerNote"
            rows={3}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            disabled={pending}
            aria-describedby={cn(
              noteHintId,
              state.fieldErrors.reviewerNote ? noteErrorId : "",
            ).trim()}
            className={textareaClasses(Boolean(state.fieldErrors.reviewerNote))}
          />
          <FieldHint id={noteHintId}>
            {/* Requirement stated in words, never signalled by an asterisk
                alone. */}
            {noteRequired
              ? `A note is required for “${reason ? REJECTION_REASON_LABELS[reason] : ""}”. `
              : "Optional. "}
            {trimmedNote.length} of {CLAIM_REVIEW_NOTE_MAX_LENGTH} characters
            {noteTooLong ? " — too long to submit." : ""}
          </FieldHint>
          {state.fieldErrors.reviewerNote && (
            <FieldError id={noteErrorId}>
              {state.fieldErrors.reviewerNote}
            </FieldError>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          ref={openerRef}
          type="button"
          onClick={() => setOpen(true)}
          disabled={!canConfirm || pending}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={buttonClasses({
            variant: decision === "REJECTED" ? "danger" : "primary",
          })}
        >
          {decision === "REJECTED"
            ? "Continue to reject receipt"
            : "Continue to verify receipt"}
        </button>
        <Link href="/review" className={buttonClasses({ variant: "secondary" })}>
          Back to queue
        </Link>
      </div>

      {open && decision !== null && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !pending) setOpen(false);
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
                {decision === "VERIFIED"
                  ? "Verify this receipt?"
                  : "Reject this receipt?"}
              </h2>
            </div>

            <div className="px-5 py-4">
              <p id={descriptionId} className="text-sm text-slate-600">
                You are about to record{" "}
                <strong className="font-semibold text-slate-900">
                  {decision === "VERIFIED" ? "Verified" : "Rejected"}
                </strong>
                {decision === "REJECTED" && reason !== null ? (
                  <>
                    {" "}
                    with the reason{" "}
                    <strong className="font-semibold text-slate-900">
                      {REJECTION_REASON_LABELS[reason]}
                    </strong>
                  </>
                ) : null}
                . This decision is permanent: it cannot be edited, reopened or
                deleted, and no second decision can be recorded for this receipt.
              </p>
              {trimmedNote.length > 0 && (
                <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                  <span className="block text-xs font-medium text-slate-500">
                    Your note
                  </span>
                  {trimmedNote}
                </p>
              )}
              {pending && (
                <p className="mt-3 text-sm text-slate-600" role="status">
                  Recording your decision…
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
              {/* The ONLY submit in this component. `loading` disables it, so a
                  double click cannot send a second request. */}
              <Button
                type="submit"
                variant={decision === "REJECTED" ? "danger" : "primary"}
                loading={pending}
                loadingLabel="Recording…"
              >
                {decision === "VERIFIED"
                  ? "Yes, verify this receipt"
                  : "Yes, reject this receipt"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
