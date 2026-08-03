"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { classifyReceiptQualificationAction } from "@/app/(review)/review/[receiptSubmissionId]/qualification-actions";
import {
  type QualificationActionState,
  INITIAL_QUALIFICATION_ACTION_STATE,
} from "@/app/(review)/review/[receiptSubmissionId]/qualification-action-state";
import {
  EXCLUSION_REASON_HINTS,
  EXCLUSION_REASON_LABELS,
  EXCLUSION_REASONS,
  isExclusionReason,
  QUALIFICATION_NOTE_MAX_LENGTH,
  reasonRequiresNote,
  type ExclusionReason,
} from "@/lib/review/claim-receipt-qualification-input";
import type { ClaimReceiptQualification } from "@/lib/review/claim-receipt-qualification";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  FieldError,
  FieldHint,
  Label,
  textareaClasses,
} from "@/components/ui/field";

/**
 * Whether this receipt may proceed toward a sale and a reward.
 *
 * ============================================================================
 * THIS PANEL IS NOT ABOUT THE REVIEW DECISION
 * ============================================================================
 * The decision above it says the IMAGE was verified. This says whether the
 * record may go on to become an authoritative sale. Both statements are true at
 * once and neither overwrites the other, so the copy repeats that in every
 * state — a reviewer must never come away thinking they changed the verdict.
 *
 * Rendered only for a VERIFIED receipt. A REJECTED one is already out of the
 * reward path by being rejected, and offering a second, redundant control would
 * imply the rejection was not enough.
 *
 * ============================================================================
 * WHAT "NOT EXCLUDED" DOES NOT MEAN
 * ============================================================================
 * It does not mean reward-eligible. No sale exists, no reward exists, and no
 * campaign has been evaluated — none of those things are built yet. The copy
 * says so explicitly rather than letting an absence read as an approval.
 */
export function QualificationPanel({
  receiptSubmissionId,
  qualification,
}: {
  receiptSubmissionId: string;
  /** `null` when the state could not be read — the panel then says so. */
  qualification: ClaimReceiptQualification | null;
}) {
  const [state, formAction, pending] = useActionState<
    QualificationActionState,
    FormData
  >(classifyReceiptQualificationAction, INITIAL_QUALIFICATION_ACTION_STATE);

  const [reason, setReason] = useState<ExclusionReason | null>(null);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<"EXCLUDE" | "REINSTATE" | null>(null);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const excludeOpenerRef = useRef<HTMLButtonElement | null>(null);
  const reinstateOpenerRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();
  const descriptionId = useId();
  const noteId = useId();
  const noteHintId = useId();
  const noteErrorId = useId();
  const reasonErrorId = useId();

  // Closed during RENDER against the previous result rather than in an effect:
  // an effect would paint the stale dialog first and then immediately re-render
  // to close it, which is both a flicker and the cascading-render pattern the
  // lint rule exists to prevent. Matches the decision form.
  const [lastResult, setLastResult] = useState(state);
  if (state !== lastResult) {
    setLastResult(state);
    if (state.formError || Object.keys(state.fieldErrors).length > 0) {
      setOpen(null);
    }
  }

  useEffect(() => {
    if (open) dialogRef.current?.focus();
    else if (open === null) {
      (excludeOpenerRef.current ?? reinstateOpenerRef.current)?.focus();
    }
  }, [open]);

  // Escape closes — but never mid-submit, so a stray keypress cannot leave a
  // reviewer unsure whether an immutable event was recorded.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) setOpen(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  const unavailable = qualification === null;
  const excluded = qualification?.qualificationState === "QUALIFICATION_EXCLUDED";
  const noteRequired = reasonRequiresNote(reason);
  const trimmedNote = note.trim();
  const noteTooLong = trimmedNote.length > QUALIFICATION_NOTE_MAX_LENGTH;

  const canConfirmExclude =
    reason !== null && !noteTooLong && (!noteRequired || trimmedNote.length > 0);

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-card sm:p-5"
      aria-labelledby="qualification-heading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="qualification-heading"
          className="text-sm font-semibold text-slate-900"
        >
          Reward qualification
        </h2>
        {!unavailable && (
          // The word carries the meaning; tone only reinforces it.
          <Badge tone={excluded ? "amber" : "slate"}>
            {excluded ? "Excluded from qualification" : "Not excluded"}
          </Badge>
        )}
      </div>

      {unavailable ? (
        <Alert tone="warning" className="mt-3">
          The qualification state of this receipt is temporarily unavailable.
          Refresh to try again. The review decision above is unaffected.
        </Alert>
      ) : null}

      {state.settled ? (
        <>
          <Alert
            tone={
              state.outcome === "CONFLICT"
                ? "warning"
                : state.outcome === "EXCLUDED" || state.outcome === "REINSTATED"
                  ? "success"
                  : "info"
            }
            className="mt-3"
          >
            {state.message}
          </Alert>
          <p className="mt-3 text-xs text-slate-500">
            Reload this page to see the current qualification state.
          </p>
        </>
      ) : null}

      {state.formError ? (
        <Alert tone="error" role="alert" className="mt-3">
          {state.formError}
        </Alert>
      ) : null}

      {!unavailable && !state.settled ? (
        <form action={formAction} className="mt-3">
          <input
            type="hidden"
            name="receiptSubmissionId"
            value={receiptSubmissionId}
          />
          <input
            type="hidden"
            name="action"
            value={excluded ? "REINSTATE" : "EXCLUDE"}
          />

          {excluded ? (
            <ExcludedBody qualification={qualification} />
          ) : (
            <NotExcludedBody />
          )}

          {!excluded ? (
            <fieldset className="mt-4" aria-describedby={reasonErrorId}>
              <legend className="text-sm font-medium text-slate-800">
                Reason for exclusion
              </legend>
              <div className="mt-2 space-y-2">
                {EXCLUSION_REASONS.map((code) => (
                  <label
                    key={code}
                    className={cn(
                      "flex cursor-pointer gap-3 rounded-xl border p-3 text-sm",
                      reason === code
                        ? "border-amber-400 bg-amber-50/60 ring-1 ring-amber-200"
                        : "border-slate-200 hover:bg-slate-50",
                    )}
                  >
                    <input
                      type="radio"
                      name="exclusionReason"
                      value={code}
                      checked={reason === code}
                      onChange={(event) =>
                        setReason(
                          isExclusionReason(event.target.value)
                            ? event.target.value
                            : null,
                        )
                      }
                      disabled={pending}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-amber-600"
                    />
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-900">
                        {EXCLUSION_REASON_LABELS[code]}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {EXCLUSION_REASON_HINTS[code]}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {state.fieldErrors.exclusionReason && (
                <FieldError id={reasonErrorId}>
                  {state.fieldErrors.exclusionReason}
                </FieldError>
              )}
            </fieldset>
          ) : null}

          <div className="mt-4 space-y-2">
            <Label htmlFor={noteId} required={noteRequired && !excluded}>
              Note
            </Label>
            <textarea
              id={noteId}
              name="reviewerNote"
              rows={2}
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
              {/* Requirement stated in words, never by an asterisk alone. */}
              {!excluded && noteRequired
                ? `A note is required for “${reason ? EXCLUSION_REASON_LABELS[reason] : ""}”. `
                : "Optional. "}
              {trimmedNote.length} of {QUALIFICATION_NOTE_MAX_LENGTH} characters
              {noteTooLong ? " — too long to submit." : ""}
            </FieldHint>
            {state.fieldErrors.reviewerNote && (
              <FieldError id={noteErrorId}>
                {state.fieldErrors.reviewerNote}
              </FieldError>
            )}
          </div>

          <div className="mt-4">
            {excluded ? (
              <button
                ref={reinstateOpenerRef}
                type="button"
                onClick={() => setOpen("REINSTATE")}
                disabled={pending || noteTooLong}
                aria-haspopup="dialog"
                aria-expanded={open === "REINSTATE"}
                className={buttonClasses({ variant: "secondary" })}
              >
                Reconsider this exclusion
              </button>
            ) : (
              <button
                ref={excludeOpenerRef}
                type="button"
                onClick={() => setOpen("EXCLUDE")}
                disabled={!canConfirmExclude || pending}
                aria-haspopup="dialog"
                aria-expanded={open === "EXCLUDE"}
                className={buttonClasses({ variant: "secondary" })}
              >
                Exclude from qualification
              </button>
            )}
          </div>

          {open !== null && (
            <div
              className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !pending) setOpen(null);
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
                    {open === "EXCLUDE"
                      ? "Exclude this receipt from qualification?"
                      : "Reconsider this exclusion?"}
                  </h2>
                </div>

                <div id={descriptionId} className="space-y-3 px-5 py-4 text-sm text-slate-600">
                  {open === "EXCLUDE" ? (
                    <>
                      <p>
                        You are recording{" "}
                        <strong className="font-semibold text-slate-900">
                          {reason ? EXCLUSION_REASON_LABELS[reason] : ""}
                        </strong>{" "}
                        against this receipt.
                      </p>
                      <p>
                        <strong className="font-semibold text-slate-900">
                          The VERIFIED review decision will not change.
                        </strong>{" "}
                        It stays visible in review history exactly as it is.
                      </p>
                      <p>
                        What changes is what happens next: this receipt will not be
                        able to become an authoritative sale, will not enter campaign
                        qualification, and will not earn a reward or coins.
                      </p>
                      <p>
                        This is recorded as an append-only, audited event. It cannot
                        be edited or deleted — only reversed by a later event.
                      </p>
                    </>
                  ) : (
                    <>
                      <p>
                        This records a{" "}
                        <strong className="font-semibold text-slate-900">
                          new append-only reversal event
                        </strong>
                        . The original exclusion is not deleted and stays visible in
                        history.
                      </p>
                      <p>
                        The VERIFIED review decision is unaffected, and reinstating
                        does not by itself create a sale, a reward or any coins —
                        later sale requirements would still have to be met.
                      </p>
                    </>
                  )}
                  {trimmedNote.length > 0 && (
                    <p className="rounded-lg bg-slate-50 p-3 text-slate-700">
                      <span className="block text-xs font-medium text-slate-500">
                        Your note
                      </span>
                      {trimmedNote}
                    </p>
                  )}
                  {pending && (
                    <p role="status" className="text-slate-600">
                      Recording…
                    </p>
                  )}
                </div>

                <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (!pending) setOpen(null);
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
                    loadingLabel="Recording…"
                  >
                    {open === "EXCLUDE"
                      ? "Yes, exclude this receipt"
                      : "Yes, record a reversal"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </form>
      ) : null}
    </section>
  );
}

/** The already-excluded summary. Read-only facts, then the reversal affordance. */
function ExcludedBody({
  qualification,
}: {
  qualification: ClaimReceiptQualification;
}) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">
        This receipt cannot become an authoritative sale, enter campaign
        qualification, or earn a reward or coins.{" "}
        <strong className="font-semibold text-slate-900">
          Its VERIFIED review decision is unchanged
        </strong>{" "}
        and remains visible above.
      </p>
      <dl className="space-y-2">
        {qualification.exclusionReason ? (
          <Row label="Reason">
            {isExclusionReason(qualification.exclusionReason)
              ? EXCLUSION_REASON_LABELS[qualification.exclusionReason]
              : qualification.exclusionReason}
          </Row>
        ) : null}
        {qualification.reviewerNote ? (
          <Row label="Note">
            <span className="whitespace-pre-wrap break-words">
              {qualification.reviewerNote}
            </span>
          </Row>
        ) : null}
        {qualification.classifiedAt ? (
          <Row label="Recorded">
            <time dateTime={qualification.classifiedAt}>
              {formatUtc(qualification.classifiedAt)}
            </time>
          </Row>
        ) : null}
        {qualification.classifiedByDisplayName ? (
          <Row label="Recorded by">{qualification.classifiedByDisplayName}</Row>
        ) : null}
      </dl>
    </div>
  );
}

/** The not-yet-classified state. Careful not to imply eligibility. */
function NotExcludedBody() {
  return (
    <div className="space-y-2 text-sm text-slate-600">
      <p>Not excluded from future qualification.</p>
      <p className="text-xs text-slate-500">
        This does <strong>not</strong> mean the receipt is reward-eligible. No sale
        and no reward exists for any receipt yet, and no campaign has been
        evaluated. Excluding a receipt only prevents it being used later.
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

/**
 * UTC, deterministic. A Server Component rendered this page, so a locale- or
 * timezone-dependent string would differ between the server and client renders.
 * Matches formatSubmittedAt in the queue filters module.
 */
function formatUtc(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Unknown date";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-` +
    `${pad(parsed.getUTCDate())} ${pad(parsed.getUTCHours())}:` +
    `${pad(parsed.getUTCMinutes())} UTC`
  );
}
