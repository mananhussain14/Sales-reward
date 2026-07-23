"use client";

import { useActionState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  acceptStaffInvitationAction,
  activateStaffAccountAction,
  continueAsInvitedStaffAction,
  stayInvitedSignedInAction,
} from "@/app/invitations/staff/actions";
import { INITIAL_STAFF_ACCEPT_STATE } from "@/app/invitations/staff/accept-state";
import { MIN_PASSWORD_LENGTH, PASSWORD_HINT } from "@/lib/auth/password-policy";
import { buttonClasses } from "@/components/ui/button";
import { inputClasses as controlInputClasses, Label } from "@/components/ui/field";
import { SpinnerIcon } from "@/components/ui/icons";

/**
 * The client controls on the staff invitation page.
 *
 * Client Components only so they can surface pending/error state and — for the
 * transition — auto-submit on mount. NONE of them carries a token, hash, email,
 * Retailer, role, shop, membership or invitation id: the server actions read the hash
 * from the HttpOnly cookie and resolve everything else server-side, so there is nothing
 * here for a browser to tamper with and nothing invitation-specific reaching client
 * state.
 */

const primaryButton = buttonClasses({ variant: "primary", fullWidth: true });

const secondaryButton = buttonClasses({ variant: "outline", fullWidth: true });

const inputClasses = controlInputClasses();

/**
 * The error banner.
 *
 * Errors only. There is deliberately no success variant anywhere on this page:
 * activation and acceptance both end by redirecting, so there is nothing to announce
 * and nothing to wait for.
 */
function Alert({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      aria-live="polite"
      className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <p>{error}</p>
    </div>
  );
}

/** A small inline spinner for the transition. */
function Spinner() {
  return <SpinnerIcon className="h-5 w-5 animate-spin text-indigo-600" />;
}

/**
 * AUTOMATIC ACCEPTANCE.
 *
 * Rendered by the page ONLY after the server has verified — through the recipient RPC —
 * that the signed-in caller's confirmed email exactly matches the live invitation. This
 * component receives NO invitation data: not the Retailer, role, shops, email, token,
 * hash, membership or invitation id. It exists solely to POST the acceptance action
 * once and show a brief "Joining your Retailer…" while the server accepts and redirects.
 *
 * SUBMIT ONCE. A ref guards against React's development remount (Strict Mode invokes
 * effects twice) and any accidental re-entry, so the action fires exactly once on the
 * first mount. Even if it fired twice, accept_retailer_staff_invitation clears the
 * token on the first success, so the second call is refused and resolved to the same
 * landing — no duplicate membership, role or shop rows.
 *
 * NO DATABASE WORK IN A GET. The action runs on a POST (a form submission), never during
 * the page render. On success it redirects and this component unmounts; on a transient
 * failure it surfaces a generic retry and an account-switch escape hatch.
 */
export function AcceptInvitationTransition() {
  const [state, formAction, pending] = useActionState(
    acceptStaffInvitationAction,
    INITIAL_STAFF_ACCEPT_STATE,
  );

  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    // Programmatic submit invokes the server action exactly as a click would, so the
    // JS path needs no visible button. requestSubmit runs native form validation and
    // fires the action; there are no fields to validate here.
    formRef.current?.requestSubmit();
  }, []);

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <Alert error={state.error} />

      <div className="flex items-center gap-3" role="status" aria-live="polite">
        <Spinner />
        <span className="text-sm text-slate-600">
          {state.error ? "Almost there…" : "Joining your Retailer…"}
        </span>
      </div>

      {/* The POST that does the work. The submit button is a no-JS fallback: with JS it
          is triggered on mount and the user barely sees it; without JS it is the one
          control that lets a progressive-enhancement submission through. It carries no
          fields. */}
      <form ref={formRef} action={formAction} className="w-full">
        <button
          type="submit"
          disabled={pending}
          className={`${primaryButton} ${pending ? "" : "opacity-0"}`}
          aria-hidden={!state.error}
        >
          Continue
        </button>
      </form>

      {/* Only surfaces if acceptance could not complete — the transition's escape
          hatch. It offers an account switch rather than an inert error. */}
      {state.error && (
        <div className="w-full">
          <ContinueAsInvitedStaffButton label="Use a different account" />
        </div>
      )}
    </div>
  );
}

/**
 * THE WRONG-ACCOUNT / ACCOUNT-SWITCH SCREEN.
 *
 * Rendered when a signed-in caller holds a live invitation cookie but is NOT the
 * verified recipient — which, being decided by the generic recipient RPC, also covers a
 * genuinely dead invitation. It reveals nothing: not the current email, the invited
 * email, whether the invited address has an account, the Retailer, or any id.
 *
 * "Continue as invited staff" signs the current account out (preserving the invitation
 * cookie) and returns to the invitation, where the page decides activation vs sign-in.
 * "Stay signed in" sends the current account to its own authorized landing.
 */
export function WrongAccountSwitch() {
  return (
    <div className="space-y-4">
      <ContinueAsInvitedStaffButton label="Continue as invited staff" />
      <StaySignedInButton />
    </div>
  );
}

/** The account-switch action, as a primary button. Posts nothing. */
function ContinueAsInvitedStaffButton({ label }: { label: string }) {
  const [state, formAction, pending] = useActionState(
    continueAsInvitedStaffAction,
    INITIAL_STAFF_ACCEPT_STATE,
  );

  return (
    <form action={formAction} className="space-y-3">
      <Alert error={state.error} />
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending && <SpinnerIcon className="h-4 w-4 animate-spin" />}
        {pending ? "Switching…" : label}
      </button>
    </form>
  );
}

/** "Stay signed in" — returns the current account to its own authorized landing. */
function StaySignedInButton() {
  const [state, formAction, pending] = useActionState(
    stayInvitedSignedInAction,
    INITIAL_STAFF_ACCEPT_STATE,
  );

  return (
    <form action={formAction} className="space-y-3">
      <Alert error={state.error} />
      <button type="submit" disabled={pending} className={secondaryButton}>
        {pending && <SpinnerIcon className="h-4 w-4 animate-spin" />}
        {pending ? "One moment…" : "Stay signed in"}
      </button>
    </form>
  );
}

/**
 * The PASSWORD-ONLY activation form, for an invited person with no account yet.
 *
 * TWO FIELDS, AND NO EMAIL INPUT. The invited address is derived on the server from the
 * invitation token and handed straight to Supabase Auth; it is never rendered, never
 * placed in a prop or a hidden field, and never sent to the browser in any form.
 *
 * There is deliberately no "Sign in" button in this form: someone who has no account
 * cannot sign in, and offering it would suggest their address might already be
 * registered — which is exactly the fact the flow does not disclose.
 *
 * `minLength` comes from the shared password policy, so the browser's rule, the Server
 * Action's rule and the Supabase setting are one constant.
 */
export function ActivateStaffAccountForm() {
  const [state, formAction, pending] = useActionState(
    activateStaffAccountAction,
    INITIAL_STAFF_ACCEPT_STATE,
  );

  // The invited address turned out to have an account already — either it always did,
  // or a concurrent submission created one. Swap the password fields for the sign-in
  // button rather than reporting an error: the remedy is the same, and a race the
  // person did not cause should not read as a failure.
  if (state.mode === "sign-in") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-500">
          {state.message ?? "You already have a SalesReward account. Sign in to continue."}
        </p>
        <StaffInvitationSignInPrompt />
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <Alert error={state.error} />

      <div className="space-y-2">
        <Label htmlFor="activate-password">Password</Label>
        <input
          id="activate-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          disabled={pending}
          aria-describedby="activate-password-hint"
          className={inputClasses}
        />
        <p id="activate-password-hint" className="text-xs text-slate-500">
          {PASSWORD_HINT}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="activate-confirm-password">Confirm password</Label>
        <input
          id="activate-confirm-password"
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
        {pending ? "Creating your account…" : "Activate account"}
      </button>
    </form>
  );
}

/**
 * The sign-in prompt shown when the invited address ALREADY has an account.
 *
 * No password fields: the person has a password already. The link goes to the universal
 * /login with a validated internal return path back to this page, where the invitation
 * cookie is still waiting; after signing in, the transition accepts it automatically.
 *
 * The invited address is NOT shown — the person about to sign in already knows which
 * address they were invited at, and a stranger must not learn it.
 */
export function StaffInvitationSignInPrompt() {
  return (
    <Link
      href="/login?next=/invitations/staff"
      className={buttonClasses({ variant: "primary", size: "lg", fullWidth: true })}
    >
      Sign in
    </Link>
  );
}
