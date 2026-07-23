"use client";

import { useActionState } from "react";
import {
  resendStaffInvitationAction,
  revokeStaffInvitationAction,
} from "@/app/(retailer)/retailer/staff/actions";
import { INITIAL_INVITATION_ACTION_STATE } from "@/app/(retailer)/retailer/staff/invitation-action-state";

/**
 * The per-invitation Resend and Revoke controls.
 *
 * Client Components only so they can surface pending/error state via useActionState
 * and — for revoke — ask for confirmation before submitting.
 *
 * THE ONLY VALUE EITHER FORM CARRIES IS THE INVITATION ID. No email, role, shop id,
 * token, or hash is placed in a hidden field: the resend action re-reads the
 * recipient, names, role and shops from the database, and the revoke action needs
 * nothing but the address. The id itself is not a capability — the RPCs match it
 * against the Retailer they derive from auth.uid(), so an id from another tenant
 * selects nothing.
 *
 * DUPLICATE SUBMISSION is prevented the same way everywhere in this codebase: the
 * submit button is disabled while `pending` is true, so the second click of a
 * double-click has no enabled control to hit. The database is the real backstop —
 * revoke re-asserts `status = 'PENDING'`, and a second resend simply rotates the token
 * again rather than creating anything.
 */

const feedbackClasses = "mt-1 text-xs";

function Feedback({ error, success }: { error: string | null; success: string | null }) {
  if (error) {
    return (
      <p
        role="alert"
        aria-live="polite"
        className={`${feedbackClasses} text-red-600 dark:text-red-400`}
      >
        {error}
      </p>
    );
  }
  if (success) {
    return (
      <p
        role="status"
        aria-live="polite"
        className={`${feedbackClasses} text-emerald-700 dark:text-emerald-400`}
      >
        {success}
      </p>
    );
  }
  return null;
}

export function ResendInvitationForm({
  invitationId,
  recipientLabel,
}: {
  invitationId: string;
  /** For the accessible name only — the action never reads it. */
  recipientLabel: string;
}) {
  const [state, formAction, pending] = useActionState(
    resendStaffInvitationAction,
    INITIAL_INVITATION_ACTION_STATE,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="invitationId" value={invitationId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Resend invitation to ${recipientLabel}`}
        className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 dark:focus-visible:ring-offset-zinc-950"
      >
        {pending ? "Sending…" : "Resend"}
      </button>
      <Feedback error={state.error} success={state.success} />
    </form>
  );
}

export function RevokeInvitationForm({
  invitationId,
  recipientLabel,
}: {
  invitationId: string;
  recipientLabel: string;
}) {
  const [state, formAction, pending] = useActionState(
    revokeStaffInvitationAction,
    INITIAL_INVITATION_ACTION_STATE,
  );

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        // Confirmation before a destructive, non-undoable action. A revoked invitation
        // cannot be un-revoked — the operator must issue a new one — so this is worth
        // one interruption. It is UX only: the action re-authorizes regardless, and a
        // submission that skips this handler entirely (no JS) is still refused or
        // performed by the server on its own terms.
        if (
          !window.confirm(
            `Revoke the invitation for ${recipientLabel}? Their invitation link will stop working immediately.`,
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <input type="hidden" name="invitationId" value={invitationId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Revoke invitation for ${recipientLabel}`}
        className="inline-flex items-center justify-center rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-900/60 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950/40 dark:focus-visible:ring-offset-zinc-950"
      >
        {pending ? "Revoking…" : "Revoke"}
      </button>
      <Feedback error={state.error} success={state.success} />
    </form>
  );
}
