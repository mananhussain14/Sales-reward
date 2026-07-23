"use client";

import { useActionState } from "react";
import Link from "next/link";
import { onboardRetailer } from "@/app/(admin)/retailers/new/actions";
import {
  INITIAL_ONBOARD_RETAILER_STATE,
  type OnboardRetailerField,
  type OnboardRetailerState,
} from "@/app/(admin)/retailers/new/onboard-state";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { inputClasses, Label } from "@/components/ui/field";
import { FormStep, InfoPanel } from "@/components/ui/form-section";
import { BuildingIcon, StoreIcon } from "@/components/ui/icons";
import { cn } from "@/components/ui/cn";

/**
 * Retailer onboarding form.
 *
 * This is a Client Component only so it can surface pending and error state via
 * useActionState — exactly the reason app/login/login-form.tsx is one. Nothing
 * else about it is client-side: the form posts to the `onboardRetailer` Server
 * Action, which performs the entire write through one authorized RPC. The
 * browser Supabase client is never imported or used here, there is no table
 * insert, no fetch, and nothing is persisted client-side.
 *
 * This module must not import @/lib/supabase/server, @/lib/auth/vendor-admin-
 * access, or @/lib/retailers/vendor-retailers. All three are server-only and
 * throw at build time if they reach the browser bundle. The only imports that
 * cross this boundary are the Server Action itself and the plain state contract.
 *
 * The form sends six values, all of them typed by the admin: two names, two
 * codes, and a city. It has no hidden input, and in particular no vendor
 * organization id, actor id, relationship id, role code, permission code, or
 * status — the database derives every one of those from the caller's own token.
 */

type FieldProps = {
  field: OnboardRetailerField;
  label: string;
  /** Optional guidance rendered under the label, associated for screen readers. */
  hint?: string;
  required?: boolean;
  autoComplete?: string;
  /** Native hints only — the server re-validates and remains the authority. */
  inputMode?: "text";
  maxLength?: number;
  placeholder?: string;
  state: OnboardRetailerState;
  pending: boolean;
};

/**
 * One labelled input with its hint and its error.
 *
 * The error and hint are wired through aria-describedby, and aria-invalid marks
 * the field itself, so a screen reader announces both the rejection and the
 * guidance rather than leaving the message as unassociated red text. Ids are
 * derived from the field name, which is unique per form.
 */
function Field({
  field,
  label,
  hint,
  required = false,
  autoComplete,
  inputMode,
  maxLength,
  placeholder,
  state,
  pending,
}: FieldProps) {
  const error = state.fieldErrors[field];
  const hintId = hint ? `${field}-hint` : undefined;
  const errorId = error ? `${field}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-2">
      <Label htmlFor={field} optional={!required}>
        {label}
      </Label>

      {hint && (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      )}

      <input
        id={field}
        name={field}
        type="text"
        // The submitted value is rendered back as the default. React resets an
        // uncontrolled form after a form action completes, so the reset picks up
        // this updated attribute — which is what makes a rejected submission
        // come back filled in rather than blank. The value is the admin's own
        // canonicalized input; nothing here is read from the database.
        defaultValue={state.values[field]}
        required={required}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        placeholder={placeholder}
        disabled={pending}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={inputClasses(Boolean(error))}
      />

      {error && (
        <p id={errorId} className="text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function RetailerForm() {
  const [state, formAction, pending] = useActionState(
    onboardRetailer,
    INITIAL_ONBOARD_RETAILER_STATE,
  );

  return (
    // noValidate for the same reason the sign-in form uses it: the server is the
    // authority on what is valid, and letting the browser block submission would
    // mean two sets of rules, only one of which is enforced.
    <form action={formAction} className="space-y-6" noValidate>
      {/*
        The form-level error is rendered in a live region so screen readers
        announce it on submit. The container is only mounted when there is a
        message, which is what makes the announcement fire. This is the single
        safe message from the action — never a database string.
      */}
      {state.formError && (
        <Alert id="onboard-error" tone="error">
          {state.formError}
        </Alert>
      )}

      <FormStep
        step={1}
        icon={<BuildingIcon className="h-5 w-5" />}
        title="Retailer details"
        description="The Retailer company this Vendor will manage. It is created as active."
      >
        <div className="space-y-5">
          <Field
            field="retailerName"
            label="Retailer name"
            required
            autoComplete="organization"
            state={state}
            pending={pending}
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              field="countryCode"
              label="Country code"
              hint="Two-letter ISO country code, such as AE."
              autoComplete="off"
              maxLength={2}
              placeholder="AE"
              state={state}
              pending={pending}
            />
            <Field
              field="defaultCurrency"
              label="Default currency"
              hint="Three-letter code, such as AED."
              autoComplete="off"
              maxLength={3}
              placeholder="AED"
              state={state}
              pending={pending}
            />
          </div>
        </div>
      </FormStep>

      <FormStep
        step={2}
        icon={<StoreIcon className="h-5 w-5" />}
        title="First shop"
        description="Every Retailer starts with one shop location. More can be added later."
      >
        <div className="space-y-5">
          <Field
            field="shopName"
            label="Shop name"
            required
            autoComplete="off"
            state={state}
            pending={pending}
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              field="shopCode"
              label="Shop code"
              hint="Your own reference for this location, if you use one."
              autoComplete="off"
              state={state}
              pending={pending}
            />
            <Field
              field="shopCity"
              label="City"
              autoComplete="address-level2"
              state={state}
              pending={pending}
            />
          </div>
        </div>
      </FormStep>

      {/* Explains the single-submit workflow without changing it — one action
          creates the Retailer, its relationship, and this first shop together. */}
      <InfoPanel>
        <span className="font-medium">Both the Retailer and its first shop will be created together.</span>{" "}
        Everything is set up as active in a single step.
      </InfoPanel>

      {/*
        The action area is visually separated from the form content and sticks to
        the bottom of the viewport on desktop so the primary action stays reachable
        on a long form. On mobile it stays in normal flow and the buttons go
        full-width for easy tapping.
      */}
      <div className="flex flex-col-reverse gap-3 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-card backdrop-blur sm:sticky sm:bottom-4 sm:flex-row sm:items-center sm:justify-end">
        {/*
          Cancel is disabled along with the inputs while the action runs. It is a
          link rather than a button, so `disabled` does not apply — aria-disabled
          plus pointer-events-none and a removal from the tab order is how a link
          is taken out of service. Navigating away mid-submit would abandon a
          write that is already in flight and leave the admin unsure whether it
          landed.
        */}
        <Link
          href="/retailers"
          aria-disabled={pending || undefined}
          tabIndex={pending ? -1 : undefined}
          className={buttonClasses(
            { variant: "outline" },
            cn("w-full sm:w-auto", pending ? "pointer-events-none opacity-60" : undefined),
          )}
        >
          Cancel
        </Link>

        {/*
          The pending flag is what prevents an ordinary double submit: the button
          is disabled for the whole round trip, and on success the action
          redirects, so there is no filled form left to resubmit.
        */}
        <Button
          type="submit"
          className="w-full sm:w-auto"
          loading={pending}
          loadingLabel="Creating Retailer…"
        >
          Create Retailer
        </Button>
      </div>
    </form>
  );
}
