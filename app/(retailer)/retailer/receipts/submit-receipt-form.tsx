"use client";

import { useActionState, useRef, useState } from "react";
import { submitReceiptAction } from "@/app/(retailer)/retailer/receipts/actions";
import { INITIAL_SUBMIT_RECEIPT_STATE } from "@/app/(retailer)/retailer/receipts/submit-receipt-state";
import {
  formatFileSize,
  MAX_RECEIPT_FILE_BYTES,
  SUPPORTED_RECEIPT_MIME_TYPES,
} from "@/lib/receipts/receipt-file";
import type { AssignedReceiptShop } from "@/lib/receipts/receipt-normalization";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label, selectClasses, SelectChevron } from "@/components/ui/field";
import { UploadIcon, XIcon } from "@/components/ui/icons";

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
 * @/lib/receipts/receipt-file is imported here for its three PURE presentation
 * constants and the size formatter. That module also exports hashing, which uses
 * node:crypto — Next.js tree-shakes the unused export, and nothing in this component
 * calls it. Hashing happens only on the server, in the Server Action.
 *
 * NOTHING HERE IS AN AUTHORIZATION BOUNDARY, and nothing here is validation the server
 * relies on. The `accept` attribute and the size readout are conveniences; the Server
 * Action re-resolves access, re-reads the assigned-shop list, and re-derives the file's
 * real type from its own bytes before anything is stored.
 */

type SubmitReceiptFormProps = {
  /** From list_my_assigned_receipt_shops(). The ONLY source of shop ids. */
  shops: AssignedReceiptShop[];
};

export function SubmitReceiptForm({ shops }: SubmitReceiptFormProps) {
  const [state, formAction, pending] = useActionState(
    submitReceiptAction,
    INITIAL_SUBMIT_RECEIPT_STATE,
  );

  // The chosen file's name and size, for feedback only. The File itself is submitted by
  // the browser with the form; nothing here reads or transmits its contents.
  const [chosen, setChosen] = useState<{ name: string; size: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const maxMegabytes = Math.floor(MAX_RECEIPT_FILE_BYTES / (1024 * 1024));
  const disabled = pending || shops.length === 0;

  // Clears the selected file and resets the native input. Presentation only — it
  // touches no server state and posts nothing.
  function clearChosen() {
    setChosen(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
        <Alert tone="success" className="sr-animate-fade-in">
          {state.successMessage}
        </Alert>
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
          aria-describedby={
            state.fieldErrors.receipt ? "receipt-error" : "receipt-hint"
          }
          className="peer sr-only"
        />

        {chosen ? (
          <div className="flex items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-indigo-600 shadow-sm">
              <UploadIcon className="h-5 w-5" />
            </span>
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
          <label
            htmlFor="receipt"
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-8 text-center transition-colors hover:border-indigo-400 hover:bg-indigo-50/50 peer-focus-visible:border-indigo-500 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2 peer-disabled:cursor-not-allowed peer-disabled:opacity-60"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
              <UploadIcon className="h-6 w-6" />
            </span>
            <span className="text-sm font-semibold text-slate-900">
              Tap to upload a receipt
            </span>
            <span className="text-xs text-slate-500">
              One JPEG, PNG or WebP image, up to {maxMegabytes} MB
            </span>
          </label>
        )}

        {state.fieldErrors.receipt && (
          <p id="receipt-error" role="alert" className="text-sm font-medium text-red-700">
            {state.fieldErrors.receipt}
          </p>
        )}

        <p id="receipt-hint" className="text-xs text-slate-500">
          One JPEG, PNG or WebP image, up to {maxMegabytes} MB.
        </p>
      </div>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        disabled={disabled}
        loading={pending}
        loadingLabel="Submitting…"
        className="w-full sm:w-auto"
      >
        Submit receipt
      </Button>
    </form>
  );
}
