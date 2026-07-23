"use client";

import { useActionState } from "react";
import { MIN_PASSWORD_LENGTH, PASSWORD_HINT } from "@/lib/auth/password-policy";
import { completeInvitation } from "@/app/invitations/complete/actions";
import { INITIAL_COMPLETE_INVITATION_STATE } from "@/app/invitations/complete/complete-state";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { inputClasses, Label } from "@/components/ui/field";

/**
 * Password-completion form for an invited Retailer Owner.
 *
 * A Client Component only so it can surface pending/error state via
 * useActionState. The passwords are posted straight to the `completeInvitation`
 * Server Action — the browser Supabase client is never involved, nothing is
 * persisted client-side, and no value is ever echoed back into the DOM.
 *
 * The inputs are UNCONTROLLED (no value/onChange). React never holds the
 * credential in state, and a failed submission clears both fields because the
 * action returns no values to repopulate them with. Retyping is the correct cost
 * for not keeping a password in a client-side store.
 */
export function CompleteInvitationForm() {
  const [state, formAction, pending] = useActionState(
    completeInvitation,
    INITIAL_COMPLETE_INVITATION_STATE,
  );

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {/*
        THERE IS DELIBERATELY NO HIDDEN FIELD HERE.

        An earlier revision posted a `passwordAlreadySet` flag so a retry could
        skip the password update. That was wrong: a hidden input is ordinary
        attacker-editable form data, so posting it on a FIRST attempt would have
        let the acceptance RPC activate a Retailer Owner membership without any
        credential ever being set.

        The action now runs both steps on every submission, so there is nothing to
        remember and nothing to forge. This form posts exactly two fields, both of
        them the invitee's own typed input.
      */}

      {/*
        Errors are rendered in a live region so screen readers announce them on
        submit. The container is only mounted when there is a message, which is
        what makes the announcement fire. Matches app/login/login-form.tsx.
      */}
      {state.formError && (
        <Alert id="complete-error" tone="error">
          {state.formError}
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <input
          id="password"
          name="password"
          type="password"
          /*
            "new-password", not "current-password". This tells the browser and
            password manager that a credential is being CREATED, which is what
            prompts an offer to generate and store a strong one. Using
            "current-password" here would make managers try to autofill an
            existing credential for this origin — exactly wrong for an account
            that does not have one yet.
          */
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={pending}
          aria-invalid={state.fieldErrors.password ? true : undefined}
          aria-describedby={
            state.fieldErrors.password ? "password-error" : "password-hint"
          }
          className={inputClasses(Boolean(state.fieldErrors.password))}
        />
        {state.fieldErrors.password ? (
          <p id="password-error" role="alert" className="text-sm font-medium text-red-700">
            {state.fieldErrors.password}
          </p>
        ) : (
          <p id="password-hint" className="text-xs text-slate-500">
            {PASSWORD_HINT}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm password</Label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          disabled={pending}
          aria-invalid={state.fieldErrors.confirmPassword ? true : undefined}
          aria-describedby={
            state.fieldErrors.confirmPassword ? "confirm-password-error" : undefined
          }
          className={inputClasses(Boolean(state.fieldErrors.confirmPassword))}
        />
        {state.fieldErrors.confirmPassword && (
          <p
            id="confirm-password-error"
            role="alert"
            className="text-sm font-medium text-red-700"
          >
            {state.fieldErrors.confirmPassword}
          </p>
        )}
      </div>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={pending}
        loadingLabel="Activating account…"
      >
        Activate account
      </Button>
    </form>
  );
}
