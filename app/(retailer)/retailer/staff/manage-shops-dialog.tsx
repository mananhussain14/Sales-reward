"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { updateStaffShopAssignmentsAction } from "@/app/(retailer)/retailer/staff/actions";
import { INITIAL_MANAGE_SHOPS_STATE } from "@/app/(retailer)/retailer/staff/manage-shops-state";
import type { AssignableShop } from "@/lib/staff/staff-normalization";
import {
  canSaveSelection,
  hasSelectionChanged,
  reconcileSelection,
} from "@/lib/staff/staff-shop-assignment-input";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { LocationIcon } from "@/components/ui/icons";

/**
 * The Manage Shops editor: a Retailer Owner changes an existing, active Sales Staff
 * member's ACTIVE shop assignments.
 *
 * A Client Component for three reasons and no others: `useActionState` (pending and
 * outcome feedback), the interactive checkbox selection, and dialog open/close with
 * focus management. All three are ordinary, non-sensitive UI concerns.
 *
 * ============================================================================
 * WHAT CROSSES THE SERVER BOUNDARY INTO THIS COMPONENT
 * ============================================================================
 * The member's display name, role label, membership id, the shop ids their roster row
 * reported, and the assignable shops for this caller — nothing else. No Retailer
 * organization id, auth user id, profile id, email, role UUID, permission code, token or
 * hash is passed in; none is available to pass, because no RPC returns one.
 *
 * NO INTERNAL IDENTIFIER IS EVER RENDERED. The membership id and the shop ids live in
 * `value` attributes of form controls and in React keys — they are addresses the server
 * re-validates — and appear in no visible text, no title, no aria-label and no data
 * attribute. Every label the operator reads is a shop NAME or a person's NAME.
 *
 * ============================================================================
 * NOTHING HERE IS AN AUTHORIZATION BOUNDARY
 * ============================================================================
 * This editor is rendered only for a caller whose assignable-shop read succeeded, but
 * the Server Action re-resolves portal access and re-reads that same list before
 * accepting a single id, and public.set_retailer_staff_shop_assignments re-derives the
 * Retailer, the target's role and status, and every shop's ownership from auth.uid().
 * A hidden or disabled control removes the accident; only those checks remove the
 * capability.
 *
 * ============================================================================
 * THE ACTIVE-SHOP PROJECTION
 * ============================================================================
 * `currentShopIds` is the member's VISIBLE active assignments. They may also hold a live
 * assignment to a suspended or deactivated shop, which no client can see and which the
 * backend preserves untouched. This component therefore never states or implies a total,
 * and after a successful save it does NOT patch the roster from the ids it submitted —
 * the Server Action revalidates the route and the page re-renders from the canonical
 * read.
 *
 * ============================================================================
 * SESSION AND CONTEXT ISOLATION
 * ============================================================================
 * Every instance is mounted with `key={member.membershipId}` by the page. A membership id
 * is unique per (organization, user), so a different account — or a different Retailer —
 * produces an entirely different roster and therefore different keys: React unmounts each
 * old instance and all of its state (open flag, selection, target, feedback) is
 * discarded. A response from a previous instance's action cannot reach a new one, because
 * the hook that owns it was unmounted with it. The Server Action independently redirects
 * to /login when the session is gone.
 */

type ManageShopsDialogProps = {
  /** organization_members.id — the canonical target, straight from the roster. */
  membershipId: string;
  /** For the accessible name and the dialog heading. */
  memberName: string;
  /** The display role label, e.g. "Sales Staff". Presentation only. */
  roleLabel: string;
  /** The member's VISIBLE active shop assignments, from the roster. Never "all". */
  currentShopIds: string[];
  /** From list_retailer_staff_assignable_shops(). The ONLY source of shop ids. */
  shops: AssignableShop[];
  /**
   * False when the assignable-shop read did not succeed. The editor then shows a
   * picker-specific failure with a read-only retry and cannot submit — a READ failure is
   * never converted into a write failure.
   */
  optionsReady: boolean;
};

export function ManageShopsDialog({
  membershipId,
  memberName,
  roleLabel,
  currentShopIds,
  shops,
  optionsReady,
}: ManageShopsDialogProps) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    updateStaffShopAssignmentsAction,
    INITIAL_MANAGE_SHOPS_STATE,
  );

  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();
  const descriptionId = useId();

  // The options actually offered. Normally the server-rendered list; after a
  // `stale-shops` refusal, the fresher list the action just read — so the operator
  // reviews against what is true now rather than what was true when the page rendered.
  const options = state.refreshedShops ?? shops;
  const optionIds = options.map((shop) => shop.shopId);

  // The set the editor opens with: the member's visible assignments INTERSECTED with the
  // options actually on screen. Preselecting an id with no checkbox would submit
  // something invisible.
  const initialSelection = reconcileSelection(currentShopIds, optionIds);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelection),
  );

  // Re-sync when the OPTIONS change identity — a `stale-shops` response replacing the
  // list, or the server re-rendering the page with a different assignable set. Adjusted
  // during render rather than in an effect: React's documented pattern for deriving state
  // from changing input, which re-renders immediately instead of painting a stale
  // selection and correcting it in a second cascading pass. `lastOptionKey` records what
  // we last saw, so an operator's own ticks are never clobbered by an unchanged echo.
  //
  // The reconciliation is what DROPS a now-unavailable shop from the requested set: a
  // selection is only ever re-derived from ids that are currently on offer.
  const optionKey = optionIds.join(",");
  const [lastOptionKey, setLastOptionKey] = useState<string>(optionKey);
  if (lastOptionKey !== optionKey) {
    setLastOptionKey(optionKey);
    setSelected(
      new Set(reconcileSelection(Array.from(selected), optionIds)),
    );
  }

  const selectedIds = Array.from(selected);
  const changed = hasSelectionChanged(initialSelection, selectedIds);
  const committed = state.outcome === "saved" || state.outcome === "saved-unconfirmed";

  const saveEnabled = canSaveSelection({
    selectedCount: selected.size,
    optionsReady,
    submitting: pending,
    changed,
    // After a committed write, Save is not offered at all: an ordinary retry must never
    // silently resubmit a change that has already happened.
    alreadySaved: committed,
  });

  // Focus management. On open, focus moves into the dialog; on close, back to the
  // control that opened it, so keyboard and screen-reader users are never dropped at the
  // top of the document.
  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    } else {
      openerRef.current?.focus();
    }
  }, [open]);

  // Escape closes — but never while a write is in flight, so a stray keypress cannot
  // leave the operator unsure whether their change was submitted.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  function toggleShop(shopId: string, checked: boolean) {
    // A Set cannot hold a duplicate, so a repeated id is structurally impossible in the
    // submitted set — and the server canonicalizes with `distinct` regardless.
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(shopId);
      else next.delete(shopId);
      return next;
    });
  }

  function closeEditor() {
    if (pending) return;
    setOpen(false);
  }

  return (
    <>
      {/* A plain <button> with the shared class helper rather than <Button>, because the
          opener needs a ref for focus restoration and the component does not type one.
          buttonClasses() is exposed for exactly this case, so the visual system is still
          the single source of truth. */}
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Manage shops for ${memberName}`}
        className={buttonClasses({ variant: "outline", size: "sm" })}
      >
        Manage shops
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
          // A click on the backdrop closes, matching the Escape affordance. The inner
          // panel stops propagation so a click inside never closes.
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditor();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={headingId}
            aria-describedby={descriptionId}
            tabIndex={-1}
            className={cn(
              "flex max-h-[90dvh] w-full flex-col rounded-t-2xl bg-white shadow-xl outline-none",
              "sm:max-h-[85dvh] sm:max-w-lg sm:rounded-2xl",
            )}
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <h2
                  id={headingId}
                  className="truncate text-base font-semibold text-slate-900"
                >
                  Manage shops
                </h2>
                <p id={descriptionId} className="mt-0.5 truncate text-sm text-slate-500">
                  <span className="font-medium text-slate-700">{memberName}</span>
                  <span aria-hidden="true"> · </span>
                  {roleLabel}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={closeEditor}
                disabled={pending}
                aria-label="Close"
              >
                Close
              </Button>
            </div>

            <form action={formAction} className="flex min-h-0 flex-1 flex-col">
              {/* The canonical target. A hidden field carrying an ADDRESS the server
                  re-validates against the Retailer it derives from auth.uid() — never a
                  capability, and never rendered as text. */}
              <input type="hidden" name="membershipId" value={membershipId} />

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {state.error && (
                  <div className="mb-4">
                    <Alert tone={state.outcome === "stale-shops" ? "warning" : "error"}>
                      {state.error}
                    </Alert>
                  </div>
                )}

                {state.success && (
                  <div className="mb-4">
                    <Alert
                      tone={state.outcome === "saved-unconfirmed" ? "warning" : "success"}
                    >
                      {state.success}
                    </Alert>
                  </div>
                )}

                {!optionsReady ? (
                  // A READ failure, reported as its own thing with a read-only retry.
                  // Never converted into a write failure, and the form cannot submit.
                  <div className="space-y-3">
                    <Alert tone="warning" title="Shops could not be loaded">
                      We couldn&apos;t load the list of shops. The staff list is
                      unaffected.
                    </Alert>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => router.refresh()}
                    >
                      Try loading shops again
                    </Button>
                  </div>
                ) : options.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500">
                    Your Retailer has no active shops, so shop assignments cannot be
                    changed yet.
                  </p>
                ) : (
                  <fieldset className="space-y-2" disabled={pending || committed}>
                    <div className="flex items-center justify-between gap-3">
                      <legend className="block text-sm font-medium text-slate-800">
                        Shops
                      </legend>
                      <span
                        className="text-xs font-medium text-slate-500"
                        aria-live="polite"
                      >
                        {selected.size} selected
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">
                      Choose every active shop this person works in. At least one shop is
                      required.
                    </p>

                    <div className="mt-2 grid grid-cols-1 gap-2">
                      {options.map((shop) => {
                        const checked = selected.has(shop.shopId);
                        return (
                          <label
                            key={shop.shopId}
                            className={cn(
                              "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-2.5 transition-all",
                              "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 has-[:focus-visible]:ring-offset-2",
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
                              onChange={(event) =>
                                toggleShop(shop.shopId, event.target.checked)
                              }
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
                                  {[shop.shopCode, shop.city]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              )}
                            </span>
                          </label>
                        );
                      })}
                    </div>

                    {selected.size === 0 && (
                      <p className="text-xs text-amber-700" role="status">
                        Select at least one shop to save.
                      </p>
                    )}
                  </fieldset>
                )}
              </div>

              {/* Footer */}
              <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeEditor}
                  disabled={pending}
                >
                  {committed ? "Done" : "Cancel"}
                </Button>
                {/* Hidden once committed, so no ordinary retry can resubmit a change that
                    has already happened. The RPC is idempotent regardless. */}
                {!committed && (
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={!saveEnabled}
                    loading={pending}
                    loadingLabel="Saving…"
                  >
                    Save changes
                  </Button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
