"use client";

import { useActionState, useState } from "react";
import { setShopTimeZone } from "@/app/(admin)/retailers/[relationshipId]/shops/timezone-actions";
import {
  INITIAL_SHOP_TIMEZONE_STATE,
  type ShopTimeZoneState,
} from "@/app/(admin)/retailers/[relationshipId]/shops/timezone-state";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";

/**
 * The per-shop time-zone control.
 *
 * A Client Component only so it can surface pending, error and success state via
 * useActionState — the same reason shops/new/shop-form.tsx is. Nothing else about
 * it is client-side: the form posts to the `setShopTimeZone` Server Action, which
 * performs the entire write through one authorized RPC. The browser Supabase
 * client is never imported or used here, there is no table update, no fetch, and
 * nothing is persisted client-side.
 *
 * This module must not import @/lib/supabase/server, @/lib/auth/vendor-admin-
 * access, or either Retailer loader — all are server-only and throw at build time
 * if they reach the browser bundle. The only imports that cross the boundary are
 * the Server Action itself and the plain state contract.
 *
 * ============================================================================
 * NOTHING IS EVER PREFILLED FROM A GUESS
 * ============================================================================
 * When a shop has no zone the input starts EMPTY. It is deliberately not seeded
 * from the shop's country_code, its city, `Intl.DateTimeFormat().resolvedOptions()
 * .timeZone`, or any other browser or device signal.
 *
 * A prefilled value is a value an operator will accept without reading. This
 * field decides which instant a printed sale time refers to, and therefore which
 * campaign window that sale falls into — a plausible-looking wrong default would
 * be adopted silently and would misprice sales for as long as it stood. A country
 * is not a time zone either: several countries span many. The only safe default is
 * no default, so the operator has to state the zone deliberately.
 *
 * When a shop DOES have a zone, the input is seeded with the stored value — that
 * is not a guess, it is the current fact being edited.
 */

/**
 * Why this field matters, shown beside the input rather than buried in a tooltip.
 * An operator setting a value that prices sales is entitled to know that.
 */
const TIMEZONE_HINT =
  "Region/City form, for example Asia/Dubai. Receipt sale times at this shop " +
  "cannot be verified until a time zone is set, and a wrong zone shifts when a " +
  "sale is counted.";

export function ShopTimeZoneControl({
  shopId,
  shopName,
  relationshipId,
  timezoneName,
}: {
  /**
   * An ADDRESS, not authorization. It says which of the caller's own shops to
   * configure; the RPC derives the Vendor from the session and refuses a shop
   * that is not theirs.
   */
  shopId: string;
  /** Used only for the accessible label, so two controls on one page differ. */
  shopName: string;
  /** Route address, used to revalidate the detail page after a write. */
  relationshipId: string;
  /** The stored zone, or null when it has never been configured. */
  timezoneName: string | null;
}) {
  const [state, formAction, pending] = useActionState<ShopTimeZoneState, FormData>(
    setShopTimeZone,
    INITIAL_SHOP_TIMEZONE_STATE,
  );

  // Collapsed by default so a Retailer with many shops stays scannable; a shop
  // with no zone is still called out by the badge in the row itself.
  const [open, setOpen] = useState(false);

  // The value the database currently holds: whatever the last successful write
  // returned, else the value the page was rendered with.
  const storedTimezone = state.savedTimezoneName ?? timezoneName;
  const isUnresolved = storedTimezone === null;

  // A stable, unique id per shop so two controls on one page cannot collide on
  // label/input association.
  const fieldId = `shop-timezone-${shopId}`;

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {isUnresolved ? (
          <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
            Time zone not configured
          </span>
        ) : (
          <span className="font-mono text-xs text-slate-700">{storedTimezone}</span>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setOpen(true)}
        >
          {isUnresolved ? "Configure" : "Edit"}
          <span className="sr-only"> time zone for {shopName}</span>
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3" noValidate>
      {/*
        Two hidden addresses, and nothing else. There is deliberately no Vendor
        organization id, Retailer organization id, actor id, role code, permission
        code or UTC offset input — the database derives every one of those from
        the caller's own token, and a field that does not exist cannot be forged.
      */}
      <input type="hidden" name="shopId" value={shopId} />
      <input type="hidden" name="relationshipId" value={relationshipId} />

      <TextField
        name="timezoneName"
        id={fieldId}
        label={`Time zone for ${shopName}`}
        required
        // Seeded from the STORED value only, never from a guess. Empty when unset.
        defaultValue={storedTimezone ?? ""}
        placeholder="Asia/Dubai"
        hint={TIMEZONE_HINT}
        error={state.fieldErrors.timezoneName}
        autoComplete="off"
        maxLength={64}
        disabled={pending}
        inputClassName="font-mono"
      />

      {state.formError && (
        <Alert tone="error" title="Couldn't save the time zone">
          {state.formError}
        </Alert>
      )}

      {/*
        Reported separately from a save. "Saved" when nothing was written would
        teach an operator to trust a message that is sometimes false.
      */}
      {state.unchanged && !state.formError && (
        <Alert tone="info" title="No change">
          That shop already uses {state.savedTimezoneName}.
        </Alert>
      )}

      {state.savedTimezoneName && !state.unchanged && !state.formError && (
        <Alert tone="success" title="Time zone saved">
          Sale times at {shopName} now resolve in {state.savedTimezoneName}.
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen(false)}
          disabled={pending}
        >
          Cancel
        </Button>
        {/*
          `loading` is what prevents an ordinary double submit: the button is
          disabled for the whole action, and a repeat submission of an unchanged
          value is a harmless no-op at the database anyway.
        */}
        <Button type="submit" size="sm" loading={pending} loadingLabel="Saving…">
          Save time zone
        </Button>
      </div>
    </form>
  );
}
