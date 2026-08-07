"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { unstable_rethrow } from "next/navigation";
import { submitReceiptAction } from "@/app/(retailer)/retailer/receipts/actions";
import {
  INITIAL_SUBMIT_RECEIPT_STATE,
  RECEIPT_FILE_MESSAGES,
  RECEIPT_TRANSPORT_ERROR,
  type SubmitReceiptState,
} from "@/app/(retailer)/retailer/receipts/submit-receipt-state";
import {
  formatFileSize,
  SUPPORTED_RECEIPT_MIME_TYPES,
} from "@/lib/receipts/receipt-file";
import { receiptSelectionRejection } from "@/lib/receipts/receipt-upload-preflight";
import { runGuardedSubmission } from "@/lib/receipts/receipt-submission-attempt";
import { MAX_RECEIPT_FILE_MEGABYTES } from "@/lib/uploads/upload-policy";
import type { AssignedReceiptShop } from "@/lib/receipts/receipt-normalization";
import { ReceiptExtractionPanel } from "@/app/(retailer)/retailer/receipts/receipt-extraction-panel";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label, selectClasses, SelectChevron } from "@/components/ui/field";
import { CheckCircleIcon, UploadIcon, XIcon } from "@/components/ui/icons";

/**
 * The receipt submission form.
 *
 * A Client Component for two reasons and no others: `useActionState` (pending/error
 * feedback) and the file picker's name/size readout, which needs the selected File.
 *
 * WHAT CROSSES THE SERVER BOUNDARY INTO THIS COMPONENT. Only `shops`, the result of
 * list_my_assigned_receipt_shops() for this caller: an id, a name and an optional code,
 * all for shops they are actively assigned to at their own Retailer. No Retailer
 * organization id, profile id, membership id, role id, storage bucket, object path or
 * file hash is passed in — none is available to pass, because no RPC returns one.
 *
 * @/lib/receipts/receipt-file is imported here for its two PURE presentation exports.
 * That module also exports hashing, which uses node:crypto — Next.js tree-shakes the
 * unused export, and nothing in this component calls it. Hashing happens only on the
 * server, in the Server Action. The size rules come from the pure
 * @/lib/uploads/upload-policy and @/lib/receipts/receipt-upload-preflight instead, which
 * import nothing at all.
 *
 * NOTHING HERE IS AN AUTHORIZATION BOUNDARY, and nothing here is validation the server
 * relies on. The `accept` attribute, the size readout and the pre-flight check below are
 * conveniences; the Server Action re-resolves access, re-reads the assigned-shop list,
 * and re-derives the file's real type from its own bytes before anything is stored.
 *
 * ===========================================================================
 * TWO THINGS THIS COMPONENT DOES THAT ARE NOT COSMETIC
 * ===========================================================================
 *
 * 1. IT REFUSES AN OVER-SIZED FILE WITHOUT SENDING IT. A request larger than the
 *    framework's configured body limit is rejected by Next.js before the Server Action
 *    runs, as an HTTP 413 the action never sees and therefore cannot explain. Checking
 *    the size here means the person is told "that file is too large" by the same
 *    sentence the server would have used, instead of meeting a boundary that has no
 *    vocabulary for their problem. next.config.ts is configured well above the 10 MB
 *    file maximum precisely so a valid file never reaches that boundary either.
 *
 * 2. IT KEEPS AN OPERATIONAL FAILURE ON THIS PAGE. If the Server Action's own promise
 *    rejects — a dropped connection, a timeout, a 413, an unexpected server fault —
 *    React would otherwise store the rejection as this form's state and re-throw it
 *    during render, which unwinds to app/(retailer)/error.tsx and replaces the receipt
 *    page with "We could not load your retailer portal". That is a false story about
 *    what happened: the portal loaded fine, one upload did not. The rejection is caught
 *    below and reported inline instead.
 *
 *    ⚠️ CATCHING WOULD OTHERWISE SWALLOW AN AUTHORIZATION REDIRECT. When the Server
 *    Action calls redirect() — for an unauthenticated session, or for a caller the
 *    portal refuses — Next.js REJECTS the action promise. `serverActionReducer` reads
 *    the redirect off the response and calls
 *    `reject(createRedirectErrorForAction(...))`; see the
 *    `if (redirectLocation !== undefined) { … reject(redirectError) }` branch in
 *    next/dist/client/components/router-reducer/reducers/server-action-reducer.js. A
 *    bare catch would therefore turn /login and /retailer-access-denied into an upload
 *    message — an operational sentence for an authorization outcome, which is the very
 *    confusion this milestone exists to remove.
 *
 *    That is why the call goes through @/lib/receipts/receipt-submission-attempt, which
 *    hands every caught value to Next.js's own `unstable_rethrow` BEFORE classifying
 *    anything. Framework control flow — redirect, permanentRedirect, notFound and their
 *    relatives — is re-thrown untouched and reaches the router; only a genuine
 *    operational failure becomes RECEIPT_TRANSPORT_ERROR. No digest, status code or
 *    message is read to make that decision.
 */

type SubmitReceiptFormProps = {
  /** From list_my_assigned_receipt_shops(). The ONLY source of shop ids. */
  shops: AssignedReceiptShop[];
};

/** The shop the person had chosen, echoed back so a refusal does not lose it. */
function readSelectedShopId(payload: FormData): string {
  const raw = payload.get("shopId");
  return typeof raw === "string" ? raw : "";
}

/**
 * The action `useActionState` drives: a pre-flight check, the Server Action, and a
 * typed result for every way the call itself can fail.
 *
 * It is declared outside the component because it closes over nothing — keeping it out
 * here makes it plain that the only inputs are the previous state and the submitted
 * form, exactly as the Server Action's own signature promises.
 */
async function runReceiptSubmission(
  previous: SubmitReceiptState,
  payload: FormData,
): Promise<SubmitReceiptState> {
  const selectedShopId = readSelectedShopId(payload);

  // ---------------------------------------------------------------------------
  // Pre-flight — see note 1 in the module comment. Presentation only.
  // ---------------------------------------------------------------------------
  const files = payload
    .getAll("receipt")
    .filter((part): part is File => part instanceof File);

  const rejection = receiptSelectionRejection(files);
  if (rejection !== null) {
    return {
      fieldErrors: { receipt: RECEIPT_FILE_MESSAGES[rejection] },
      formError: null,
      successMessage: null,
      selectedShopId,
      // Nothing was sent, so nothing was stored and there is no reading to follow.
      extractionSubmissionId: null,
    };
  }

  // ---------------------------------------------------------------------------
  // The Server Action — see note 2 in the module comment.
  // ---------------------------------------------------------------------------
  // `unstable_rethrow` is passed by value, not called here: runGuardedSubmission hands
  // it every caught value before deciding anything, so a redirect the framework threw
  // escapes to the router untouched and /login and /retailer-access-denied keep working.
  //
  // The failure state is built HERE, from constants, and handed in already finished.
  // That is what makes it impossible for an exception's message, stack or digest to
  // reach the screen: the module that catches never gets to compose the result.
  return runGuardedSubmission({
    submit: () => submitReceiptAction(previous, payload),
    rethrowControlFlow: unstable_rethrow,
    previousState: previous,
    operationalFailureState: {
      fieldErrors: {},
      formError: RECEIPT_TRANSPORT_ERROR,
      successMessage: null,
      selectedShopId,
      // The request never reached the action, so nothing was reserved, uploaded or read.
      extractionSubmissionId: null,
    },
  });
}

export function SubmitReceiptForm({ shops }: SubmitReceiptFormProps) {
  const [state, formAction, pending] = useActionState(
    runReceiptSubmission,
    INITIAL_SUBMIT_RECEIPT_STATE,
  );

  // The chosen file's name and size, for feedback only. The File itself is submitted by
  // the browser with the form; nothing here reads or transmits its contents.
  const [chosen, setChosen] = useState<{ name: string; size: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Whether a file is currently being dragged over the drop target. Cosmetic only. */
  const [dragging, setDragging] = useState(false);

  /**
   * A local object URL for the chosen image, so the person can SEE what they picked
   * before they send it — the single most useful check against submitting a blurred or
   * wrong photograph.
   *
   * Created from the File the browser already holds and revoked when it changes. Nothing
   * is read, hashed, re-encoded or transmitted here: the browser submits the File itself
   * with the form, and the server derives the real type from its own bytes regardless.
   */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    const file = fileInputRef.current?.files?.[0] ?? null;
    if (chosen === null || file === null) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    // Revoked on every change and on unmount, so a long session cannot accumulate
    // object URLs for photographs the person has already replaced.
    return () => URL.revokeObjectURL(url);
  }, [chosen]);

  const maxMegabytes = MAX_RECEIPT_FILE_MEGABYTES;
  const disabled = pending || shops.length === 0;

  // Immediate feedback on the CURRENT selection, evaluated by the same pure function the
  // submission path uses, so the person learns a photo is too big at the moment they
  // pick it rather than after waiting for an upload. Presentation only, and it is the
  // same sentence the server would have produced.
  const selectionRejection = chosen ? receiptSelectionRejection([chosen]) : null;
  const selectionError =
    selectionRejection === null ? null : RECEIPT_FILE_MESSAGES[selectionRejection];

  // The selection's own problem wins while a file is chosen; after a submission attempt
  // the picker is cleared and whatever the server said is what remains on screen.
  const receiptError = selectionError ?? state.fieldErrors.receipt ?? null;

  // Clears the selected file and resets the native input. Presentation only — it
  // touches no server state and posts nothing.
  function clearChosen() {
    setChosen(null);
    setDragging(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /**
   * Accepts a dropped file by handing it to the REAL input.
   *
   * The dropped `FileList` is assigned to the file input itself rather than kept in
   * component state, so the form submits exactly the same way it does after a click:
   * one `<input type="file" name="receipt">`, submitted by the browser. There is no
   * second upload path, no fetch, and nothing here posts anything.
   *
   * Only the FIRST file is taken. The input is single-file, and silently uploading one
   * of several dropped images would be a guess.
   */
  function acceptDroppedFiles(files: FileList) {
    const input = fileInputRef.current;
    const file = files.item(0);
    if (input === null || file === null || disabled) return;

    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    setChosen({ name: file.name, size: file.size });
  }

  return (
    <form
      action={async (payload: FormData) => {
        await formAction(payload);
        // Clear the picker after every attempt: the browser cannot repopulate a file
        // input from the server, so leaving a stale name on screen would misdescribe
        // what a second click would send.
        setChosen(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }}
      className="space-y-5"
      noValidate
    >
      {state.formError && <Alert tone="error">{state.formError}</Alert>}

      {state.successMessage && (
        <div
          role="status"
          className="sr-animate-fade-in flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
        >
          <span className="sr-animate-pop flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-emerald-600">
            <CheckCircleIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-emerald-900">
              {state.successMessage}
            </p>
            {/* What happens next, stated as a process rather than as a result. It
                never promises the sale qualified, or that anything follows from it. */}
            <p className="mt-0.5 text-sm text-emerald-800">
              It appears in your submissions below, and goes to a reviewer next.
            </p>
          </div>
        </div>
      )}

      {/* THE READING, FOLLOWED TO A CONCLUSION.
          Rendered only when the action reported an attempt is actually open — the
          `submitted` branch alone sets this id. Keying on it remounts the panel for each
          new receipt, so a second submission starts a fresh run rather than inheriting the
          previous receipt's state. */}
      {state.extractionSubmissionId && (
        <ReceiptExtractionPanel
          key={state.extractionSubmissionId}
          submissionId={state.extractionSubmissionId}
        />
      )}

      <div className="space-y-2">
        <Label htmlFor="shopId">Shop</Label>
        <div className="relative">
          <select
            id="shopId"
            name="shopId"
            required
            disabled={disabled}
            defaultValue={state.selectedShopId}
            aria-describedby={state.fieldErrors.shopId ? "shopId-error" : undefined}
            className={selectClasses(Boolean(state.fieldErrors.shopId))}
          >
            <option value="">Select a shop…</option>
            {shops.map((shop) => (
              <option key={shop.shopId} value={shop.shopId}>
                {shop.shopCode ? `${shop.shopName} · ${shop.shopCode}` : shop.shopName}
              </option>
            ))}
          </select>
          <SelectChevron />
        </div>
        {state.fieldErrors.shopId && (
          <p id="shopId-error" role="alert" className="text-sm font-medium text-red-700">
            {state.fieldErrors.shopId}
          </p>
        )}
        <p className="text-xs text-slate-500">
          Only the shops you are currently assigned to are listed.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="receipt">Receipt photo</Label>

        {/*
          A large tap-to-upload target, mobile-first. The real <input type="file">
          keeps every semantic it had — id, name, ref, accept, required, disabled,
          onChange, aria — and stays keyboard-focusable; it is visually collapsed
          (`sr-only peer`) and the styled label is what a pointer taps. `peer-focus`
          lifts the label's ring so keyboard focus stays visible.
        */}
        <input
          ref={fileInputRef}
          id="receipt"
          name="receipt"
          type="file"
          /* A convenience filter for the file chooser only. The server derives the real
             type from the file's leading bytes and ignores what the browser claims. */
          accept={SUPPORTED_RECEIPT_MIME_TYPES.join(",")}
          required
          disabled={disabled}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            setChosen(file ? { name: file.name, size: file.size } : null);
          }}
          aria-describedby={receiptError ? "receipt-error" : "receipt-hint"}
          className="peer sr-only"
        />

        {chosen ? (
          <div className="flex items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2">
            {previewUrl !== null ? (
              /* A local preview of the file already in the picker. `alt` is empty and
                 the image is decorative: the file name beside it is the accessible
                 description, and a receipt photograph has no text this page could
                 truthfully describe. */
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt=""
                className="h-14 w-14 shrink-0 rounded-xl border border-indigo-200 bg-white object-cover"
              />
            ) : (
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm">
                <UploadIcon className="h-5 w-5" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-900" aria-live="polite">
                {chosen.name}
              </p>
              <p className="text-xs text-slate-500">{formatFileSize(chosen.size)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <label
                htmlFor="receipt"
                className="cursor-pointer rounded-lg px-2.5 py-1.5 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100"
              >
                Replace
              </label>
              <button
                type="button"
                onClick={clearChosen}
                disabled={disabled}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <XIcon className="h-4 w-4" />
                <span className="sr-only">Remove selected file</span>
              </button>
            </div>
          </div>
        ) : (
          /* Drag-and-drop is ADDITIVE: the label still wraps the real file input, so
             a click, a tap and the keyboard all behave exactly as before. Dropping is
             an extra way to reach the same input, never a second upload path. */
          <label
            htmlFor="receipt"
            onDragOver={(event) => {
              // Required for a drop to fire at all — the default is to refuse it.
              event.preventDefault();
              if (!disabled) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              acceptDroppedFiles(event.dataTransfer.files);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors peer-focus-visible:border-indigo-500 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-60 ${
              dragging
                ? "border-indigo-500 bg-indigo-50"
                : "border-slate-300 bg-slate-50 hover:border-indigo-400 hover:bg-indigo-50/50"
            }`}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
              <UploadIcon className="h-6 w-6" />
            </span>
            <span className="text-sm font-semibold text-slate-900">
              {dragging ? "Drop the image to attach it" : "Add a receipt photo"}
            </span>
            <span className="text-xs text-slate-500">
              Tap to choose a file, or drag one here
            </span>
            <span className="text-xs text-slate-500">
              One JPEG, PNG or WebP image, up to {maxMegabytes} MB
            </span>
          </label>
        )}

        {receiptError && (
          <p id="receipt-error" role="alert" className="text-sm font-medium text-red-700">
            {receiptError}
          </p>
        )}

        <p id="receipt-hint" className="text-xs text-slate-500">
          One JPEG, PNG or WebP image, up to {maxMegabytes} MB.
        </p>
      </div>

      {/*
        `disabled` already covers `pending`, so a second click cannot start a second
        submission while one is in flight — which matters here because the upload is a
        MUTATION with no idempotency contract: a duplicate send is a duplicate reserve.
        `selectionError` is folded in so the control is not offered for a file that
        cannot succeed; the pre-flight check refuses it anyway if the form is submitted
        by keyboard.
      */}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        disabled={disabled || selectionError !== null}
        loading={pending}
        loadingLabel="Submitting…"
        className="w-full sm:w-auto"
      >
        Submit receipt
      </Button>
    </form>
  );
}
