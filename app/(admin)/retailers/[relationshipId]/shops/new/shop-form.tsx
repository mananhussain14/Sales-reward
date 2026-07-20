"use client";

import { useActionState } from "react";
import Link from "next/link";
import { addVendorRetailerShop } from "@/app/(admin)/retailers/[relationshipId]/shops/new/actions";
import {
  INITIAL_ADD_SHOP_STATE,
  type AddShopField,
  type AddShopState,
} from "@/app/(admin)/retailers/[relationshipId]/shops/new/add-shop-state";

/**
 * Add Shop form.
 *
 * This is a Client Component only so it can surface pending and error state via
 * useActionState — exactly the reason app/login/login-form.tsx and
 * app/(admin)/retailers/new/retailer-form.tsx are. Nothing else about it is
 * client-side: the form posts to the `addVendorRetailerShop` Server Action, which
 * performs the entire write through one authorized RPC. The browser Supabase
 * client is never imported or used here, there is no table insert, no fetch, and
 * nothing is persisted client-side.
 *
 * This module must not import @/lib/supabase/server, @/lib/auth/vendor-admin-
 * access, or either Retailer loader. All are server-only and throw at build time
 * if they reach the browser bundle. The only imports that cross this boundary are
 * the Server Action itself and the plain state contract.
 *
 * The form sends four typed values and ONE hidden field: the relationship id. It
 * has no Vendor organization id, Retailer organization id, actor id, shop id,
 * role code, permission code, or status input — the database derives every one of
 * those from the caller's own token.
 */

/**
 * The relationship id is a routing ADDRESS, not authorization, and it is passed
 * as a prop rather than read from the URL on the client so the value the form
 * submits is the same one the server already resolved and rendered this page for.
 *
 * It is safe to place in a hidden input precisely because it grants nothing:
 * public.add_vendor_retailer_shop() re-derives the caller's Vendor from
 * auth.uid() and matches the relationship on BOTH its id and that Vendor, so a
 * tampered value belonging to someone else selects no row and is refused with the
 * same generic message as a nonexistent one. It is never rendered visibly.
 */
type ShopFormProps = {
  relationshipId: string;
};

/** Shared input styling, matching the onboarding and sign-in forms exactly. */
const INPUT_CLASSES =
  "block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500";

/** Applied on top of the shared styling when a field has been rejected. */
const INPUT_ERROR_CLASSES =
  "border-red-400 focus-visible:border-red-500 focus-visible:ring-red-500 dark:border-red-800";

type FieldProps = {
  field: AddShopField;
  label: string;
  /** Optional guidance rendered under the label, associated for screen readers. */
  hint?: string;
  required?: boolean;
  autoComplete?: string;
  maxLength?: number;
  placeholder?: string;
  state: AddShopState;
  pending: boolean;
};

/**
 * One labelled input with its hint and its error.
 *
 * The error and hint are wired through aria-describedby, and aria-invalid marks
 * the field itself, so a screen reader announces both the rejection and the
 * guidance rather than leaving the message as unassociated red text. Ids are
 * derived from the field name, which is unique per form.
 *
 * The required field is marked twice over: `required` for assistive technology
 * and a visible asterisk for everyone else, since colour and placement alone do
 * not communicate a requirement.
 */
function Field({
  field,
  label,
  hint,
  required = false,
  autoComplete,
  maxLength,
  placeholder,
  state,
  pending,
}: FieldProps) {
  const error = state.fieldErrors[field];
  const hintId = hint ? `${field}-hint` : undefined;
  const errorId = error ? `${field}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-2">
      <label
        htmlFor={field}
        className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
      >
        {label}
        {required ? (
          <span className="ml-1 text-red-600 dark:text-red-400" aria-hidden="true">
            *
          </span>
        ) : (
          <span className="ml-1 font-normal text-zinc-400 dark:text-zinc-500">
            (optional)
          </span>
        )}
      </label>

      {hint && (
        <p id={hintId} className="text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      )}

      <input
        id={field}
        name={field}
        type="text"
        // The submitted value is rendered back as the default. React resets an
        // uncontrolled form after a form action completes, so the reset picks up
        // this updated attribute — which is what makes a rejected submission come
        // back filled in rather than blank. The value is the admin's own
        // canonicalized input; nothing here is read from the database.
        defaultValue={state.values[field]}
        required={required}
        autoComplete={autoComplete}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={pending}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${INPUT_CLASSES}${error ? ` ${INPUT_ERROR_CLASSES}` : ""}`}
      />

      {error && (
        <p id={errorId} className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export function ShopForm({ relationshipId }: ShopFormProps) {
  const [state, formAction, pending] = useActionState(
    addVendorRetailerShop,
    INITIAL_ADD_SHOP_STATE,
  );

  return (
    // noValidate for the same reason the sign-in and onboarding forms use it: the
    // server is the authority on what is valid, and letting the browser block
    // submission would mean two sets of rules, only one of which is enforced.
    <form action={formAction} className="space-y-6" noValidate>
      {/*
        The single hidden field: the routing address this form was opened for.
        Not rendered visibly anywhere, and not authorization — see the note on
        ShopFormProps above.
      */}
      <input type="hidden" name="relationshipId" value={relationshipId} />

      {/*
        The form-level error is rendered in a live region so screen readers
        announce it on submit. The container is only mounted when there is a
        message, which is what makes the announcement fire. This is the single
        safe message from the action — never a database string.
      */}
      {state.formError && (
        <div
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          >
            <path d="M12 9v3.75m0 3.75h.008M10.34 3.94l-8.02 13.5A1.5 1.5 0 003.6 19.5h16.8a1.5 1.5 0 001.28-2.06l-8.02-13.5a1.5 1.5 0 00-2.58 0z" />
          </svg>
          <p>{state.formError}</p>
        </div>
      )}

      <section className="rounded-xl border border-zinc-200 bg-white p-5 sm:p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Shop details
        </h3>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          The location is created as active. Only the name is required.
        </p>

        <div className="mt-5 space-y-5">
          <Field
            field="shopName"
            label="Shop name"
            required
            autoComplete="off"
            state={state}
            pending={pending}
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              field="shopCode"
              label="Shop code"
              hint="Your own reference for this location, if you use one."
              autoComplete="off"
              state={state}
              pending={pending}
            />
            <Field
              field="shopCity"
              label="City"
              autoComplete="address-level2"
              state={state}
              pending={pending}
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              field="countryCode"
              label="Country code"
              hint="Two-letter ISO country code, such as AE."
              autoComplete="off"
              maxLength={2}
              placeholder="AE"
              state={state}
              pending={pending}
            />
          </div>
        </div>
      </section>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
        {/*
          Cancel is disabled along with the inputs while the action runs. It is a
          link rather than a button, so `disabled` does not apply — aria-disabled
          plus pointer-events-none and a removal from the tab order is how a link
          is taken out of service. Navigating away mid-submit would abandon a
          write that is already in flight and leave the admin unsure whether it
          landed.
        */}
        <Link
          href={`/retailers/${relationshipId}`}
          aria-disabled={pending || undefined}
          tabIndex={pending ? -1 : undefined}
          className={`inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:focus-visible:ring-offset-zinc-950 ${
            pending ? "pointer-events-none opacity-60" : ""
          }`}
        >
          Cancel
        </Link>

        {/*
          The pending flag is what prevents an ordinary double submit: the button
          is disabled for the whole round trip, and on success the action
          redirects, so there is no filled form left to resubmit.
        */}
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-zinc-950"
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
          {pending ? "Adding Shop…" : "Add Shop"}
        </button>
      </div>
    </form>
  );
}
