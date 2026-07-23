"use client";

import { useActionState } from "react";
import { acceptExistingUserInvitationAction } from "@/app/invitations/existing/actions";
import { INITIAL_ACCEPT_EXISTING_STATE } from "@/app/invitations/existing/accept-state";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * The Accept button for the existing-user invitation.
 *
 * A Client Component only so it can surface pending/error state via useActionState.
 * It carries NO token and NO hash — the acceptance action reads the hash from the
 * HttpOnly cookie server-side. There is nothing here for a browser to tamper with.
 */
export function AcceptExistingInvitationForm() {
  const [state, formAction, pending] = useActionState(
    acceptExistingUserInvitationAction,
    INITIAL_ACCEPT_EXISTING_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.error && <Alert tone="error">{state.error}</Alert>}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={pending}
        loadingLabel="Accepting…"
      >
        Accept invitation
      </Button>
    </form>
  );
}
