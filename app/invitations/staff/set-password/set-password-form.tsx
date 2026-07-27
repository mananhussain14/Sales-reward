"use client";

import { useActionState } from "react";
import { setStaffRecoveryPasswordAction } from "@/app/invitations/staff/set-password/actions";
import { INITIAL_STAFF_SET_PASSWORD_STATE } from "@/app/invitations/staff/set-password/set-password-state";
import { MIN_PASSWORD_LENGTH, PASSWORD_HINT } from "@/lib/auth/password-policy";
import { buttonClasses } from "@/components/ui/button";
import { inputClasses as controlInputClasses, Label } from "@/components/ui/field";
import { SpinnerIcon } from "@/components/ui/icons";

/**
 * The set-new-password form for a recovered staff account.
 *
 * A Client Component only so it can surface pending and error state. It carries NO
 * token, hash, email, auth user id, invitation id or account state: the recovery session
 * identifies the account, and the Server Action reads nothing from this form but the two
 * password fields.
 *
 * The recovered address is deliberately NOT shown. The person who opened the emailed
 * link already knows which mailbox it arrived in, and anyone else must not learn it.
 *
 * `minLength` comes from the shared password policy, so the browser's rule, the Server
 * Action's rule and the Supabase setting are one constant.
 */

const primaryButton = buttonClasses({ variant: "primary", fullWidth: true });

const inputClasses = controlInputClasses();

export function StaffSetPasswordForm() {
  const [state, formAction, pending] = useActionState(
    setStaffRecoveryPasswordAction,
    INITIAL_STAFF_SET_PASSWORD_STATE,
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.error ? (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-100"
        >
          {state.error}
        </p>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="recovery-password">New password</Label>
        <input
          id="recovery-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={pending}
          aria-describedby="recovery-password-hint"
          className={inputClasses}
        />
        <p id="recovery-password-hint" className="text-xs text-slate-500">
          {PASSWORD_HINT}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="recovery-confirm-password">Confirm new password</Label>
        <input
          id="recovery-confirm-password"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={pending}
          className={inputClasses}
        />
      </div>

      <button type="submit" disabled={pending} className={primaryButton}>
        {pending && <SpinnerIcon className="h-4 w-4 animate-spin" />}
        {pending ? "Saving your password…" : "Save password and continue"}
      </button>
    </form>
  );
}
