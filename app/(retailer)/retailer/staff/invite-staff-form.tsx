"use client";

import { useActionState, useState } from "react";
import { inviteStaffAction } from "@/app/(retailer)/retailer/staff/actions";
import { INITIAL_INVITE_STAFF_STATE } from "@/app/(retailer)/retailer/staff/invite-staff-state";
import type { AssignableShop } from "@/lib/staff/staff-normalization";

/**
 * The Invite Staff form.
 *
 * A Client Component for two reasons and no others: `useActionState` (pending/error
 * feedback) and the one piece of genuinely interactive state — which role is selected,
 * which decides whether the shop picker is shown at all.
 *
 * WHAT CROSSES THE SERVER BOUNDARY INTO THIS COMPONENT. Only `shops`, the result of
 * list_retailer_staff_assignable_shops() for this caller: id, name, optional code and
 * city, all belonging to their own Retailer. No Retailer organization id, role UUID,
 * membership id, token, hash, or permission code is passed in — none is available to
 * pass, because no RPC returns one.
 *
 * NOTHING HERE IS AN AUTHORIZATION BOUNDARY. This form is rendered only for an owner,
 * but the Server Action re-applies the feature gate, re-resolves portal access, and
 * re-reads the assignable shop list before accepting a single id — because a Server
 * Action is a public endpoint and a hidden or disabled control is not a check. In
 * particular there is NO hidden field naming the Retailer or the role's UUID: the
 * server derives both.
 */

type InviteStaffFormProps = {
  /** From list_retailer_staff_assignable_shops(). The ONLY source of shop ids. */
  shops: AssignableShop[];
};

const MANAGER_ROLE = "RETAILER_MANAGER";
const SALES_ROLE = "SALES_STAFF";

const ROLE_OPTIONS = [
  {
    code: MANAGER_ROLE,
    label: "Retailer Manager",
    hint: "Can view the staff roster. Not assigned to specific shops.",
  },
  {
    code: SALES_ROLE,
    label: "Sales Staff",
    hint: "Works in one or more of your shops.",
  },
] as const;

const inputClasses =
  "block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-indigo-500 focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500";

const labelClasses =
  "block text-sm font-medium text-zinc-900 dark:text-zinc-100";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

export function InviteStaffForm({ shops }: InviteStaffFormProps) {
  const [state, formAction, pending] = useActionState(
    inviteStaffAction,
    INITIAL_INVITE_STAFF_STATE,
  );

  // Which role is selected, so the shop picker can appear only for Sales Staff.
  // Seeded from the server's echoed values so a rejected submission redraws the same
  // form the operator was looking at.
  const [roleCode, setRoleCode] = useState<string>(state.values.roleCode);

  // Re-sync when the ACTION returns a different role than we last saw from it: a
  // successful send clears the values, and a rejected one echoes them back.
  //
  // Adjusted during render rather than in an effect. This is React's documented
  // pattern for deriving state from changing input (react.dev, "You Might Not Need an
  // Effect"): it re-renders this component immediately, before children or the DOM are
  // touched, instead of painting a stale role and then correcting it in a second
  // cascading pass. `serverRole` records what the action last reported, so an
  // operator's own click is never clobbered — only a genuinely new server value
  // triggers the reset.
  const [serverRole, setServerRole] = useState<string>(state.values.roleCode);
  if (serverRole !== state.values.roleCode) {
    setServerRole(state.values.roleCode);
    setRoleCode(state.values.roleCode);
  }

  const showShops = roleCode === SALES_ROLE;

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.formError && (
        <div
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
        >
          <p>{state.formError}</p>
        </div>
      )}

      {state.successMessage && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          <p>{state.successMessage}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="firstName" className={labelClasses}>
            First name
          </label>
          <input
            id="firstName"
            name="firstName"
            type="text"
            autoComplete="given-name"
            required
            disabled={pending}
            defaultValue={state.values.firstName}
            aria-describedby={
              state.fieldErrors.firstName ? "firstName-error" : undefined
            }
            className={inputClasses}
          />
          <FieldError id="firstName-error" message={state.fieldErrors.firstName} />
        </div>

        <div className="space-y-2">
          <label htmlFor="lastName" className={labelClasses}>
            Last name
          </label>
          <input
            id="lastName"
            name="lastName"
            type="text"
            autoComplete="family-name"
            required
            disabled={pending}
            defaultValue={state.values.lastName}
            aria-describedby={
              state.fieldErrors.lastName ? "lastName-error" : undefined
            }
            className={inputClasses}
          />
          <FieldError id="lastName-error" message={state.fieldErrors.lastName} />
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="email" className={labelClasses}>
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
          defaultValue={state.values.email}
          aria-describedby={state.fieldErrors.email ? "email-error" : undefined}
          className={inputClasses}
        />
        <FieldError id="email-error" message={state.fieldErrors.email} />
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          The invitation can only be accepted by this address.
        </p>
      </div>

      {/* Role. A radio group in a fieldset so the legend names the group for screen
          readers, and so keyboard arrow navigation works as users expect. */}
      <fieldset
        className="space-y-2"
        aria-describedby={state.fieldErrors.roleCode ? "roleCode-error" : undefined}
      >
        <legend className={labelClasses}>Role</legend>
        <div className="mt-2 space-y-2">
          {ROLE_OPTIONS.map((option) => (
            <label
              key={option.code}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 px-4 py-3 transition-colors hover:bg-zinc-50 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50 dark:border-zinc-800 dark:hover:bg-zinc-900 dark:has-[:checked]:border-indigo-500 dark:has-[:checked]:bg-indigo-950/40"
            >
              <input
                type="radio"
                name="roleCode"
                value={option.code}
                checked={roleCode === option.code}
                onChange={() => setRoleCode(option.code)}
                disabled={pending}
                className="mt-0.5 h-4 w-4 shrink-0 border-zinc-300 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-zinc-600"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {option.label}
                </span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                  {option.hint}
                </span>
              </span>
            </label>
          ))}
        </div>
        <FieldError id="roleCode-error" message={state.fieldErrors.roleCode} />
      </fieldset>

      {/* Shops. Rendered ONLY for Sales Staff — a Retailer Manager invitation must
          carry no shop rows at all, so there is nothing to tick and the checkboxes are
          unmounted rather than merely hidden (an unmounted input submits nothing). */}
      {showShops && (
        <fieldset
          className="space-y-2"
          aria-describedby={state.fieldErrors.shopIds ? "shopIds-error" : undefined}
        >
          <legend className={labelClasses}>Shops</legend>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Choose at least one active shop this person will work in.
          </p>

          {shops.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              Your Retailer has no active shops yet, so Sales Staff cannot be invited.
            </p>
          ) : (
            <div className="mt-2 max-h-64 space-y-2 overflow-y-auto pr-1">
              {shops.map((shop) => (
                <label
                  key={shop.shopId}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 px-4 py-2.5 transition-colors hover:bg-zinc-50 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50 dark:border-zinc-800 dark:hover:bg-zinc-900 dark:has-[:checked]:border-indigo-500 dark:has-[:checked]:bg-indigo-950/40"
                >
                  <input
                    type="checkbox"
                    name="shopIds"
                    value={shop.shopId}
                    defaultChecked={state.values.shopIds.includes(shop.shopId)}
                    disabled={pending}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-zinc-600"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {shop.shopName}
                    </span>
                    {(shop.shopCode || shop.city) && (
                      <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                        {[shop.shopCode, shop.city].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}

          <FieldError id="shopIds-error" message={state.fieldErrors.shopIds} />
        </fieldset>
      )}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto dark:focus-visible:ring-offset-zinc-950"
      >
        {pending && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="h-4 w-4 animate-spin"
            aria-hidden="true"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth={4}
              className="opacity-25"
            />
            <path
              d="M12 2a10 10 0 0110 10"
              stroke="currentColor"
              strokeWidth={4}
              strokeLinecap="round"
            />
          </svg>
        )}
        {pending ? "Sending invitation…" : "Send invitation"}
      </button>
    </form>
  );
}
