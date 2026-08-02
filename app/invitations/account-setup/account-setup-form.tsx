"use client";

import { useActionState } from "react";
import { completeGenericAccountSetupAction } from "@/app/invitations/account-setup/actions";
import { INITIAL_ACCOUNT_SETUP_STATE } from "@/app/invitations/account-setup/account-setup-state";
import { MIN_PASSWORD_LENGTH, PASSWORD_HINT } from "@/lib/auth/password-policy";
import { buttonClasses } from "@/components/ui/button";
import { inputClasses as controlInputClasses, Label } from "@/components/ui/field";
import { SpinnerIcon } from "@/components/ui/icons";

/**
 * The generic account-setup form: two password fields and nothing else.
 *
 * A CLIENT COMPONENT, so everything in this file reaches the browser. It therefore
 * holds no identity of any kind — no user id, no email, no organization, no role —
 * and submits none. The Server Action derives the account from the verified session
 * alone, so there is no hidden field here for a caller to edit.
 *
 * `pending` disables both inputs and the button while a submission is in flight,
 * which is the first line of defence against a duplicate submit; the action's own
 * session check is the second, and the real one.
 *
 * Nothing here mentions Claim Reviewer, Vendor or any other role. This screen is
 * reached by any invited account that has no portal yet, and naming a role would
 * both be a guess and tell the visitor something the page has no basis for.
 */

const primaryButton = buttonClasses({ fullWidth: true });
const inputClasses = controlInputClasses();

export function AccountSetupForm() {
  const [state, formAction, pending] = useActionState(
    completeGenericAccountSetupAction,
    INITIAL_ACCOUNT_SETUP_STATE,
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.formError ? (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100"
        >
          {state.formError}
        </p>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="account-setup-password">Password</Label>
        <input
          id="account-setup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={pending}
          aria-describedby="account-setup-password-hint"
          aria-invalid={state.fieldErrors.password ? true : undefined}
          className={inputClasses}
        />
        {state.fieldErrors.password ? (
          <p className="text-xs text-rose-600">{state.fieldErrors.password}</p>
        ) : (
          <p id="account-setup-password-hint" className="text-xs text-slate-500">
            {PASSWORD_HINT}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="account-setup-confirm-password">Confirm password</Label>
        <input
          id="account-setup-confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={pending}
          aria-invalid={state.fieldErrors.confirmPassword ? true : undefined}
          className={inputClasses}
        />
        {state.fieldErrors.confirmPassword ? (
          <p className="text-xs text-rose-600">
            {state.fieldErrors.confirmPassword}
          </p>
        ) : null}
      </div>

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending && <SpinnerIcon className="h-4 w-4 animate-spin" />}
        {pending ? "Saving your password…" : "Save password"}
      </button>
    </form>
  );
}
