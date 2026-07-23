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

const inputClasses =
  "block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition-colors focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

const labelClasses = "block text-sm font-medium text-zinc-900 dark:text-zinc-100";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

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
      {state.formError && (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          <p>{state.formError}</p>
        </div>
      )}

      {state.successMessage && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          <p>{state.successMessage}</p>
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="shopId" className={labelClasses}>
          Shop
        </label>
        <select
          id="shopId"
          name="shopId"
          required
          disabled={pending || shops.length === 0}
          defaultValue={state.selectedShopId}
          aria-describedby={state.fieldErrors.shopId ? "shopId-error" : undefined}
          className={inputClasses}
        >
          <option value="">Select a shop…</option>
          {shops.map((shop) => (
            <option key={shop.shopId} value={shop.shopId}>
              {shop.shopCode ? `${shop.shopName} · ${shop.shopCode}` : shop.shopName}
            </option>
          ))}
        </select>
        <FieldError id="shopId-error" message={state.fieldErrors.shopId} />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Only the shops you are currently assigned to are listed.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="receipt" className={labelClasses}>
          Receipt photo
        </label>
        <input
          ref={fileInputRef}
          id="receipt"
          name="receipt"
          type="file"
          /* A convenience filter for the file chooser only. The server derives the real
             type from the file's leading bytes and ignores what the browser claims. */
          accept={SUPPORTED_RECEIPT_MIME_TYPES.join(",")}
          required
          disabled={pending || shops.length === 0}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            setChosen(file ? { name: file.name, size: file.size } : null);
          }}
          aria-describedby={
            state.fieldErrors.receipt ? "receipt-error" : "receipt-hint"
          }
          className="block w-full text-sm text-zinc-700 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60 dark:text-zinc-300 dark:file:bg-indigo-950/60 dark:file:text-indigo-300"
        />
        <FieldError id="receipt-error" message={state.fieldErrors.receipt} />

        {chosen && (
          <p
            className="text-xs font-medium text-zinc-700 dark:text-zinc-300"
            aria-live="polite"
          >
            {chosen.name} · {formatFileSize(chosen.size)}
          </p>
        )}

        <p id="receipt-hint" className="text-xs text-zinc-500 dark:text-zinc-400">
          One JPEG, PNG or WebP image, up to {maxMegabytes} MB.
        </p>
      </div>

      <button
        type="submit"
        disabled={pending || shops.length === 0}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto dark:focus-visible:ring-offset-zinc-950"
      >
        {pending && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="h-4 w-4 animate-spin"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth={4}
              className="opacity-25"
            />
            <path
              d="M12 2a10 10 0 0110 10"
              stroke="currentColor"
              strokeWidth={4}
              strokeLinecap="round"
            />
          </svg>
        )}
        {pending ? "Submitting…" : "Submit receipt"}
      </button>
    </form>
  );
}
