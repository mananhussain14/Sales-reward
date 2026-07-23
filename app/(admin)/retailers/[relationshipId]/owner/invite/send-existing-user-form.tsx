"use client";

import { useActionState } from "react";
import { sendExistingUserRetailerOwnerInvitationAction } from "@/app/(admin)/retailers/[relationshipId]/owner/invite/actions";
import { INITIAL_SEND_EXISTING_USER_STATE } from "@/app/(admin)/retailers/[relationshipId]/owner/invite/existing-user-send-state";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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

      {state.error && <Alert tone="error">{state.error}</Alert>}

      {/*
        Read-only recipient. Rendered as static text, NOT an <input>, so there is
        nothing here to edit and repost — reinforcing that the browser cannot choose
        the address. The value is the RPC's own canonical email.
      */}
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-slate-800">Recipient</p>
        <p className="rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700">
          {lockedEmail}
        </p>
        <p className="text-xs text-slate-500">
          This address already has a SalesReward account. They will receive a secure
          link, sign in, and accept — no new account is created. The address cannot be
          changed here.
        </p>
      </div>

      <Button type="submit" fullWidth loading={pending} loadingLabel={pendingLabel}>
        {submitLabel}
      </Button>
    </form>
  );
}
