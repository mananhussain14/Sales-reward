"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { InviteFormModel } from "@/lib/retailers/owner-status-normalization";
import { inviteRetailerOwnerAction } from "@/app/(admin)/retailers/[relationshipId]/owner/invite/actions";
import {
  buildInitialInviteOwnerState,
  type InviteOwnerField,
} from "@/app/(admin)/retailers/[relationshipId]/owner/invite/invite-owner-state";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { cardClasses } from "@/components/ui/card";
import { FieldHint, inputClasses, Label } from "@/components/ui/field";

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
      <Label htmlFor={name}>{label}</Label>
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
        className={inputClasses(Boolean(error))}
      />
      {error ? (
        // role="alert" so the message is announced when it appears after submit.
        <p id={errorId} role="alert" className="text-sm font-medium text-red-700">
          {error}
        </p>
      ) : (
        hint && <FieldHint id={hintId}>{hint}</FieldHint>
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
        <div className={cardClasses("muted", "px-4 py-3 text-sm")}>
          <p className="font-medium text-slate-700">Previous recipient</p>
          <p className="mt-0.5 text-slate-600">
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
        <Alert id="invite-owner-error" tone="error">
          {state.formError}
        </Alert>
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
          <Label htmlFor="email">Email address</Label>
          <input
            id="email"
            name="email"
            type="email"
            value={model.lockedEmail ?? ""}
            readOnly
            aria-invalid={state.fieldErrors.email ? true : undefined}
            aria-describedby={state.fieldErrors.email ? "email-error" : "email-hint"}
            className={inputClasses(Boolean(state.fieldErrors.email), "cursor-not-allowed opacity-70")}
          />
          {state.fieldErrors.email ? (
            <p id="email-error" role="alert" className="text-sm font-medium text-red-700">
              {state.fieldErrors.email}
            </p>
          ) : (
            <FieldHint id="email-hint">
              The invitation will be re-sent to this address. To invite a different
              person, wait for this invitation to expire.
            </FieldHint>
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
          className={buttonClasses(
            { variant: "outline" },
            pending ? "pointer-events-none cursor-not-allowed opacity-60" : undefined,
          )}
        >
          Cancel
        </Link>

        <Button type="submit" loading={pending} loadingLabel={model.pendingLabel}>
          {model.submitLabel}
        </Button>
      </div>
    </form>
  );
}
