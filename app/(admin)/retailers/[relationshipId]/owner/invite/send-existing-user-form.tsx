"use client";

import { useActionState } from "react";
import { sendExistingUserRetailerOwnerInvitationAction } from "@/app/(admin)/retailers/[relationshipId]/owner/invite/actions";
import { INITIAL_SEND_EXISTING_USER_STATE } from "@/app/(admin)/retailers/[relationshipId]/owner/invite/existing-user-send-state";

/**
 * The one-click confirm form for sending an EXISTING-USER Retailer Owner invitation.
 *
 * There are NO editable fields. The recipient (`lockedEmail`) is shown read-only for
 * the admin's confirmation only — it is NOT posted back and never trusted: the Server
 * Action re-derives the email, names, and Retailer from the authoritative server
 * status under the caller's own token. The single hidden `relationshipId` is a
 * routing address, re-validated server-side.
 *
 * `submitLabel` varies by state (send / resend / retry) but the behaviour does not —
 * every case rotates a fresh token and re-sends the app-owned link.
 */
export function SendExistingUserForm({
  relationshipId,
  lockedEmail,
  submitLabel,
  pendingLabel,
}: {
  relationshipId: string;
  lockedEmail: string;
  submitLabel: string;
  pendingLabel: string;
}) {
  const [state, formAction, pending] = useActionState(
    sendExistingUserRetailerOwnerInvitationAction,
    INITIAL_SEND_EXISTING_USER_STATE,
  );

  return (
    <form action={formAction} className="space-y-5">
      {/* Routing address only; re-validated and re-authorized on the server. */}
      <input type="hidden" name="relationshipId" value={relationshipId} />

      {state.error && (
        <div
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          <p>{state.error}</p>
        </div>
      )}

      {/*
        Read-only recipient. Rendered as static text, NOT an <input>, so there is
        nothing here to edit and repost — reinforcing that the browser cannot choose
        the address. The value is the RPC's own canonical email.
      */}
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Recipient</p>
        <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          {lockedEmail}
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          This address already has a SalesReward account. They will receive a secure
          link, sign in, and accept — no new account is created. The address cannot be
          changed here.
        </p>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-zinc-950"
      >
        {pending ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}
