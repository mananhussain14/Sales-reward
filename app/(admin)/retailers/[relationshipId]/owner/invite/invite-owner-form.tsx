"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { InviteFormModel } from "@/lib/retailers/owner-status-normalization";
import { inviteRetailerOwnerAction } from "@/app/(admin)/retailers/[relationshipId]/owner/invite/actions";
import {
  buildInitialInviteOwnerState,
  type InviteOwnerField,
} from "@/app/(admin)/retailers/[relationshipId]/owner/invite/invite-owner-state";

/**
 * Invite Retailer Owner form.
 *
 * A Client Component only so it can surface pending/error state and retained
 * values via useActionState. Every value is posted straight to the
 * `inviteRetailerOwnerAction` Server Action — the browser Supabase client is never
 * involved and nothing is persisted client-side.
 *
 * THE ONLY IDENTIFIER IN THIS COMPONENT is `relationshipId`, carried as a hidden
 * input because the action needs to know WHICH Retailer. It is a routing address,
 * not authorization: the database derives the Vendor from the caller's own token
 * and re-verifies that this relationship belongs to it, so a tampered value
 * selects nothing. There is deliberately no hidden Vendor organization id,
 * Retailer organization id, actor/profile id, role id, membership id, or Auth user
 * id anywhere in this form.
 */

const INPUT_CLASS =
  "block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500";

/**
 * One labelled input with its own error region.
 *
 * Declared at MODULE scope, not inside InviteOwnerForm. A component defined during
 * render is a new component type on every render, so React unmounts and remounts
 * the subtree instead of updating it — which in a form means the focused input is
 * torn out from under the person typing in it. Everything it needs arrives as
 * props instead.
 */
function Field({
  name,
  label,
  type,
  autoComplete,
  hint,
  value,
  error,
  disabled,
}: {
  name: InviteOwnerField;
  label: string;
  type: "text" | "email";
  autoComplete: string;
  hint?: string;
  value: string;
  error?: string;
  disabled: boolean;
}) {
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;

  return (
    <div className="space-y-2">
      <label
        htmlFor={name}
        className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
      >
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required
        // Retained so a rejected submission does not clear the form. These are
        // the admin's own inputs after canonicalization — never a database value.
        defaultValue={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        className={INPUT_CLASS}
      />
      {error ? (
        // role="alert" so the message is announced when it appears after submit.
        <p id={errorId} role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="text-xs text-zinc-500 dark:text-zinc-400">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

type InviteOwnerFormProps = {
  /** Route segment, used only as the action's routing address and for Cancel. */
  relationshipId: string;
  /**
   * State-aware behavior: submit labels, prefilled values, and — for a resend or
   * retry — the fixed recipient email. The MODEL IS PRESENTATION ONLY. The Server
   * Action re-reads the owner status itself and, for a resend/retry, ignores the
   * submitted email entirely in favor of the RPC's own value, so nothing here is
   * trusted as authorization or as the source of truth for who is invited.
   */
  model: InviteFormModel;
};

export function InviteOwnerForm({ relationshipId, model }: InviteOwnerFormProps) {
  const [state, formAction, pending] = useActionState(
    inviteRetailerOwnerAction,
    buildInitialInviteOwnerState(model),
  );

  // The email is fixed for a resend/retry: the recipient must not change, and the
  // action enforces that on the server regardless. A readOnly (not disabled) input
  // keeps the value visible AND submitted; the action re-derives it either way.
  const emailLocked = model.lockedEmail !== null;

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {/* The single routing address. See the component docblock. */}
      <input type="hidden" name="relationshipId" value={relationshipId} />

      {/*
        Prior recipient shown as read-only context for an expiry replacement, so an
        admin can see who the expired invitation was for before choosing to reuse
        or change the address. Purely informational — the fields below are what get
        submitted.
      */}
      {model.previousRecipient && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900/50">
          <p className="font-medium text-zinc-700 dark:text-zinc-300">
            Previous recipient
          </p>
          <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">
            {model.previousRecipient.name}
            {model.previousRecipient.email ? ` · ${model.previousRecipient.email}` : ""}
          </p>
        </div>
      )}

      {/*
        Form-level errors in a live region so screen readers announce them on
        submit. The container is only mounted when there is a message, which is
        what makes the announcement fire. Matches app/login/login-form.tsx.
      */}
      {state.formError && (
        <div
          id="invite-owner-error"
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

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        {/*
          autoComplete "off" on the names, not "given-name"/"family-name". The
          admin is entering SOMEBODY ELSE'S details, so offering their own stored
          name would be both wrong and a small privacy leak into a colleague's
          invitation.
        */}
        <Field
          name="firstName"
          label="First name"
          type="text"
          autoComplete="off"
          value={state.values.firstName}
          error={state.fieldErrors.firstName}
          disabled={pending}
        />
        <Field
          name="lastName"
          label="Last name"
          type="text"
          autoComplete="off"
          value={state.values.lastName}
          error={state.fieldErrors.lastName}
          disabled={pending}
        />
      </div>

      {emailLocked ? (
        // Resend/retry: the address is fixed. Rendered readOnly so it is visible
        // and still submitted, but the Server Action ignores the submitted value
        // and re-derives the recipient from the owner-status RPC — the field
        // cannot be edited to invite someone else.
        //
        // The email STILL carries an error region: a locked-email submission can be
        // refused (for example, the address already has an Auth account, which the
        // action returns as an `email` field error). Without this region that safe
        // message would have nowhere to render and the submit would look like it
        // did nothing. Mirrors the accessible error pattern in <Field>: role=alert
        // on appearance, aria-invalid on the input, and aria-describedby pointing at
        // the error when present and the hint otherwise.
        <div className="space-y-2">
          <label
            htmlFor="email"
            className="block text-sm font-medium text-zinc-900 dark:text-zinc-100"
          >
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            value={model.lockedEmail ?? ""}
            readOnly
            aria-invalid={state.fieldErrors.email ? true : undefined}
            aria-describedby={state.fieldErrors.email ? "email-error" : "email-hint"}
            className={`${INPUT_CLASS} cursor-not-allowed opacity-70`}
          />
          {state.fieldErrors.email ? (
            <p id="email-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.fieldErrors.email}
            </p>
          ) : (
            <p id="email-hint" className="text-xs text-zinc-500 dark:text-zinc-400">
              The invitation will be re-sent to this address. To invite a different
              person, wait for this invitation to expire.
            </p>
          )}
        </div>
      ) : (
        <Field
          name="email"
          label="Email address"
          type="email"
          autoComplete="off"
          hint="The invitation link will be sent to this address."
          value={state.values.email}
          error={state.fieldErrors.email}
          disabled={pending}
        />
      )}

      <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
        {/*
          Cancel is a link, not a button, so it is a real navigation. It carries
          aria-disabled and tabIndex rather than the `disabled` attribute, which
          anchors do not support — this keeps it out of the tab order and
          announced as unavailable while a submission is in flight, so an admin
          cannot navigate away mid-invitation and be left unsure whether the email
          went out.
        */}
        <Link
          href={`/retailers/${relationshipId}`}
          aria-disabled={pending ? true : undefined}
          tabIndex={pending ? -1 : undefined}
          className={`inline-flex items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:focus-visible:ring-offset-zinc-950 ${
            pending
              ? "pointer-events-none cursor-not-allowed opacity-60"
              : "hover:bg-zinc-50 dark:hover:bg-zinc-800"
          }`}
        >
          Cancel
        </Link>

        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-zinc-950"
        >
          {pending && (
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 animate-spin" aria-hidden="true">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} className="opacity-25" />
              <path d="M12 2a10 10 0 0110 10" stroke="currentColor" strokeWidth={4} strokeLinecap="round" />
            </svg>
          )}
          {pending ? model.pendingLabel : model.submitLabel}
        </button>
      </div>
    </form>
  );
}
