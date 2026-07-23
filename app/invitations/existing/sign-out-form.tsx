"use client";

import { useActionState } from "react";
import { signOutForExistingInvitationAction } from "@/app/invitations/existing/actions";
import { INITIAL_ACCEPT_EXISTING_STATE } from "@/app/invitations/existing/accept-state";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Sign-out control for the wrong-account case. Signs the current visitor out and
 * returns them to sign-in with a safe `next` back to this page. Carries no token,
 * hash, email, or account detail.
 */
export function SignOutMismatchForm() {
  const [state, formAction, pending] = useActionState(
    signOutForExistingInvitationAction,
    INITIAL_ACCEPT_EXISTING_STATE,
  );

  return (
    <form action={formAction} className="space-y-4">
      {state.error && <Alert tone="error">{state.error}</Alert>}

      <Button
        type="submit"
        variant="outline"
        size="lg"
        fullWidth
        loading={pending}
        loadingLabel="Signing out…"
      >
        Sign out and sign in as the invited address
      </Button>
    </form>
  );
}
