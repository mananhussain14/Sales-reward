"use client";

import { useActionState, useState } from "react";
import { inviteStaffAction } from "@/app/(retailer)/retailer/staff/actions";
import { INITIAL_INVITE_STAFF_STATE } from "@/app/(retailer)/retailer/staff/invite-staff-state";
import type { AssignableShop } from "@/lib/staff/staff-normalization";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldError, inputClasses, Label } from "@/components/ui/field";
import { InfoPanel } from "@/components/ui/form-section";
import { cn } from "@/components/ui/cn";
import {
  CheckIcon,
  LocationIcon,
  ReceiptIcon,
  UsersIcon,
} from "@/components/ui/icons";

/**
 * The Invite Staff form.
 *
 * A Client Component for two reasons and no others: `useActionState` (pending/error
 * feedback) and the interactive selections — which role is chosen (it decides whether
 * the shop picker appears at all) and which shops are ticked (so the summary can count
 * them). Both are ordinary, non-sensitive form selections.
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
 * server derives both. The summary below is derived only from these non-sensitive
 * selections and is never trusted for anything.
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
    icon: <UsersIcon className="h-5 w-5" />,
  },
  {
    code: SALES_ROLE,
    label: "Sales Staff",
    hint: "Works in one or more of your shops.",
    icon: <ReceiptIcon className="h-5 w-5" />,
  },
] as const;

function FormFieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return <FieldError id={id}>{message}</FieldError>;
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

  // Which shops are ticked. Controlled so the summary can count them. Seeded from the
  // server's echoed values, and re-synced below whenever the ACTION returns a different
  // set — the same derive-state-during-render pattern used for the role.
  const [selectedShops, setSelectedShops] = useState<Set<string>>(
    () => new Set(state.values.shopIds),
  );

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

  // The same one-way sync for the shop selection: only a genuinely new server value
  // (a cleared set after a successful send, or an echoed set after a rejection) resets
  // the operator's ticks. Keyed on a stable join so an unchanged echo is a no-op.
  const serverShopKey = state.values.shopIds.join(",");
  const [lastServerShopKey, setLastServerShopKey] = useState<string>(serverShopKey);
  if (lastServerShopKey !== serverShopKey) {
    setLastServerShopKey(serverShopKey);
    setSelectedShops(new Set(state.values.shopIds));
  }

  const showShops = roleCode === SALES_ROLE;
  const selectedRole = ROLE_OPTIONS.find((option) => option.code === roleCode);
  const selectedShopCount = showShops ? selectedShops.size : 0;

  function toggleShop(shopId: string, checked: boolean) {
    setSelectedShops((prev) => {
      const next = new Set(prev);
      if (checked) next.add(shopId);
      else next.delete(shopId);
      return next;
    });
  }

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.formError && <Alert tone="error">{state.formError}</Alert>}

      {state.successMessage && <Alert tone="success">{state.successMessage}</Alert>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="firstName">First name</Label>
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
            className={inputClasses(Boolean(state.fieldErrors.firstName))}
          />
          <FormFieldError id="firstName-error" message={state.fieldErrors.firstName} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="lastName">Last name</Label>
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
            className={inputClasses(Boolean(state.fieldErrors.lastName))}
          />
          <FormFieldError id="lastName-error" message={state.fieldErrors.lastName} />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email address</Label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={pending}
          defaultValue={state.values.email}
          aria-describedby={state.fieldErrors.email ? "email-error" : undefined}
          className={inputClasses(Boolean(state.fieldErrors.email))}
        />
        <FormFieldError id="email-error" message={state.fieldErrors.email} />
        <p className="text-xs text-slate-500">
          The invitation can only be accepted by this address.
        </p>
      </div>

      {/* Role. A radio group in a fieldset so the legend names the group for screen
          readers, and so keyboard arrow navigation works as users expect. The cards
          are labelled radios — a real, accessible control, styled. */}
      <fieldset
        className="space-y-2"
        aria-describedby={state.fieldErrors.roleCode ? "roleCode-error" : undefined}
      >
        <legend className="block text-sm font-medium text-slate-800">Role</legend>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {ROLE_OPTIONS.map((option) => {
            const active = roleCode === option.code;
            return (
              <label
                key={option.code}
                className={cn(
                  "group relative flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3.5 transition-all",
                  "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 has-[:focus-visible]:ring-offset-2",
                  active
                    ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200"
                    : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50",
                )}
              >
                <input
                  type="radio"
                  name="roleCode"
                  value={option.code}
                  checked={active}
                  onChange={() => setRoleCode(option.code)}
                  disabled={pending}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors",
                    active ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500",
                  )}
                >
                  {option.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">
                      {option.label}
                    </span>
                    {active && (
                      <CheckIcon
                        className="h-4 w-4 text-indigo-600"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {option.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <FormFieldError id="roleCode-error" message={state.fieldErrors.roleCode} />
      </fieldset>

      {/* Shops. Rendered ONLY for Sales Staff — a Retailer Manager invitation must
          carry no shop rows at all, so there is nothing to tick and the checkboxes are
          unmounted rather than merely hidden (an unmounted input submits nothing). */}
      {showShops && (
        <fieldset
          className="space-y-2"
          aria-describedby={state.fieldErrors.shopIds ? "shopIds-error" : undefined}
        >
          <div className="flex items-center justify-between gap-3">
            <legend className="block text-sm font-medium text-slate-800">Shops</legend>
            {shops.length > 0 && (
              <span className="text-xs font-medium text-slate-500">
                {selectedShopCount} selected
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Choose at least one active shop this person will work in.
          </p>

          {shops.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500">
              Your Retailer has no active shops yet, so Sales Staff cannot be invited.
            </p>
          ) : (
            <div className="mt-2 grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {shops.map((shop) => {
                const checked = selectedShops.has(shop.shopId);
                return (
                  <label
                    key={shop.shopId}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-2.5 transition-all",
                      checked
                        ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200"
                        : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50",
                    )}
                  >
                    <input
                      type="checkbox"
                      name="shopIds"
                      value={shop.shopId}
                      checked={checked}
                      onChange={(event) => toggleShop(shop.shopId, event.target.checked)}
                      disabled={pending}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500"
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <LocationIcon
                          className="h-3.5 w-3.5 shrink-0 text-slate-400"
                          aria-hidden="true"
                        />
                        <span className="truncate text-sm font-medium text-slate-900">
                          {shop.shopName}
                        </span>
                      </span>
                      {(shop.shopCode || shop.city) && (
                        <span className="mt-0.5 block truncate pl-5 text-xs text-slate-500">
                          {[shop.shopCode, shop.city].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          <FormFieldError id="shopIds-error" message={state.fieldErrors.shopIds} />
        </fieldset>
      )}

      {/* Summary — derived only from the non-sensitive selections above, purely to
          orient the operator before they send. Never trusted by the server, which
          re-derives the role and re-checks every shop id itself. */}
      {selectedRole && (
        <InfoPanel tone="slate">
          <p className="text-slate-700">
            You&apos;re inviting a{" "}
            <span className="font-semibold text-slate-900">{selectedRole.label}</span>
            {showShops && (
              <>
                {" "}
                for{" "}
                <span className="font-semibold text-slate-900">
                  {selectedShopCount} {selectedShopCount === 1 ? "shop" : "shops"}
                </span>
              </>
            )}
            .
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            They accept by signing in with the email address you entered.
          </p>
        </InfoPanel>
      )}

      <Button
        type="submit"
        variant="primary"
        fullWidth
        className="sm:w-auto"
        loading={pending}
        loadingLabel="Sending invitation…"
      >
        Send invitation
      </Button>
    </form>
  );
}
