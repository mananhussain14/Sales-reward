"use client";

import { useActionState } from "react";
import { signIn } from "@/app/login/actions";
import { INITIAL_LOGIN_STATE } from "@/app/login/login-state";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { inputClasses, Label } from "@/components/ui/field";

/**
 * The universal sign-in form — used by every role.
 *
 * This is a Client Component only so it can surface pending/error state via
 * useActionState. The credential itself is posted straight to the `signIn` Server
 * Action — the browser Supabase client is never involved, and nothing is persisted
 * client-side.
 *
 * It renders no role text and makes no authorization decision. Where the person lands
 * afterwards is resolved on the server from their verified session; this component
 * never learns which role they hold.
 */
export function LoginForm({ next }: { next?: string | null }) {
  const [state, formAction, pending] = useActionState(signIn, INITIAL_LOGIN_STATE);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {/*
        The post-login destination, already validated to a safe same-origin path
        on the server before it reached this prop. The action re-validates it
        again on receipt — this hidden field is a convenience carrier, never a
        trust boundary. Omitted entirely when there is no safe `next`.
      */}
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {/*
        Errors are rendered in a live region so screen readers announce them on
        submit. The container is only mounted when there is a message, which is
        what makes the announcement fire.
      */}
      {state.error && (
        <Alert id="login-error" tone="error">
          {state.error}
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">Email address</Label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
          placeholder="you@company.com"
          aria-describedby={state.error ? "login-error" : undefined}
          className={inputClasses(false)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          placeholder="••••••••"
          aria-describedby={state.error ? "login-error" : undefined}
          className={inputClasses(false)}
        />
      </div>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={pending}
        loadingLabel="Signing in…"
      >
        Sign in
      </Button>
    </form>
  );
}
