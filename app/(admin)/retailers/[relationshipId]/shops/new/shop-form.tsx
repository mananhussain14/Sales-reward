"use client";

import { useActionState } from "react";
import Link from "next/link";
import { addVendorRetailerShop } from "@/app/(admin)/retailers/[relationshipId]/shops/new/actions";
import {
  INITIAL_ADD_SHOP_STATE,
  type AddShopField,
  type AddShopState,
} from "@/app/(admin)/retailers/[relationshipId]/shops/new/add-shop-state";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { SectionCard } from "@/components/ui/card";
import { InfoPanel } from "@/components/ui/form-section";

/**
 * Add Shop form.
 *
 * This is a Client Component only so it can surface pending and error state via
 * useActionState — exactly the reason app/login/login-form.tsx and
 * app/(admin)/retailers/new/retailer-form.tsx are. Nothing else about it is
 * client-side: the form posts to the `addVendorRetailerShop` Server Action, which
 * performs the entire write through one authorized RPC. The browser Supabase
 * client is never imported or used here, there is no table insert, no fetch, and
 * nothing is persisted client-side.
 *
 * This module must not import @/lib/supabase/server, @/lib/auth/vendor-admin-
 * access, or either Retailer loader. All are server-only and throw at build time
 * if they reach the browser bundle. The only imports that cross this boundary are
 * the Server Action itself and the plain state contract.
 *
 * The form sends four typed values and ONE hidden field: the relationship id. It
 * has no Vendor organization id, Retailer organization id, actor id, shop id,
 * role code, permission code, or status input — the database derives every one of
 * those from the caller's own token.
 */

/**
 * The relationship id is a routing ADDRESS, not authorization, and it is passed
 * as a prop rather than read from the URL on the client so the value the form
 * submits is the same one the server already resolved and rendered this page for.
 *
 * It is safe to place in a hidden input precisely because it grants nothing:
 * public.add_vendor_retailer_shop() re-derives the caller's Vendor from
 * auth.uid() and matches the relationship on BOTH its id and that Vendor, so a
 * tampered value belonging to someone else selects no row and is refused with the
 * same generic message as a nonexistent one. It is never rendered visibly.
 */
type ShopFormProps = {
  relationshipId: string;
};

type FieldProps = {
  field: AddShopField;
  label: string;
  /** Optional guidance rendered under the label, associated for screen readers. */
  hint?: string;
  required?: boolean;
  autoComplete?: string;
  maxLength?: number;
  placeholder?: string;
  state: AddShopState;
  pending: boolean;
};

/**
 * One labelled input, delegating to the shared {@link TextField} so its hint and
 * error render BELOW the input — which keeps the two-column pair (shop code / city)
 * aligned even though only shop code carries a hint. See the layout note on
 * TextField. A required field is marked twice over (the `required` attribute for
 * assistive technology and a visible asterisk for everyone else), and the submitted
 * value is echoed back as the default so a rejected submission comes back filled in.
 */
function Field({
  field,
  label,
  hint,
  required = false,
  autoComplete,
  maxLength,
  placeholder,
  state,
  pending,
}: FieldProps) {
  return (
    <TextField
      name={field}
      label={label}
      hint={hint}
      required={required}
      autoComplete={autoComplete}
      maxLength={maxLength}
      placeholder={placeholder}
      defaultValue={state.values[field]}
      error={state.fieldErrors[field]}
      disabled={pending}
    />
  );
}

export function ShopForm({ relationshipId }: ShopFormProps) {
  const [state, formAction, pending] = useActionState(
    addVendorRetailerShop,
    INITIAL_ADD_SHOP_STATE,
  );

  return (
    // noValidate for the same reason the sign-in and onboarding forms use it: the
    // server is the authority on what is valid, and letting the browser block
    // submission would mean two sets of rules, only one of which is enforced.
    <form action={formAction} className="space-y-6" noValidate>
      {/*
        The single hidden field: the routing address this form was opened for.
        Not rendered visibly anywhere, and not authorization — see the note on
        ShopFormProps above.
      */}
      <input type="hidden" name="relationshipId" value={relationshipId} />

      {/*
        The form-level error is rendered in a live region so screen readers
        announce it on submit. The container is only mounted when there is a
        message, which is what makes the announcement fire. This is the single
        safe message from the action — never a database string.
      */}
      {state.formError && <Alert tone="error">{state.formError}</Alert>}

      <SectionCard
        title="Shop details"
        description="The location is created as active. Only the name is required."
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
          </div>
        </div>
      </SectionCard>

      {/* Accurate to current behaviour: Sales Staff are assigned to shops when a
          Retailer Owner invites them from the Retailer portal. */}
      <InfoPanel>Staff can later be assigned to this shop.</InfoPanel>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
        {/*
          Cancel is disabled along with the inputs while the action runs. It is a
          link rather than a button, so `disabled` does not apply — aria-disabled
          plus pointer-events-none and a removal from the tab order is how a link
          is taken out of service. Navigating away mid-submit would abandon a
          write that is already in flight and leave the admin unsure whether it
          landed.
        */}
        <Link
          href={`/retailers/${relationshipId}`}
          aria-disabled={pending || undefined}
          tabIndex={pending ? -1 : undefined}
          className={buttonClasses(
            { variant: "outline" },
            pending ? "pointer-events-none opacity-60" : undefined,
          )}
        >
          Cancel
        </Link>

        {/*
          The pending flag is what prevents an ordinary double submit: the button
          is disabled for the whole round trip, and on success the action
          redirects, so there is no filled form left to resubmit.
        */}
        <Button type="submit" loading={pending} loadingLabel="Adding Shop…">
          Add Shop
        </Button>
      </div>
    </form>
  );
}
