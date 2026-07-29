"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { setVendorRetailerStatusAction } from "@/app/(admin)/retailers/[relationshipId]/actions";
import { INITIAL_RETAILER_LIFECYCLE_STATE } from "@/app/(admin)/retailers/[relationshipId]/lifecycle-state";
import {
  canSubmitVendorRetailerLifecycleChange,
  resolveVendorRetailerLifecycle,
} from "@/lib/retailers/vendor-retailer-lifecycle-input";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * The Vendor's Retailer deactivate/reactivate control.
 *
 * A Client Component for three reasons and no others: `useActionState` (pending and outcome
 * feedback), dialog open/close with focus management, and the confirm-before-acting flow. All
 * three are ordinary, non-sensitive UI concerns.
 *
 * ============================================================================
 * WHAT CROSSES THE SERVER BOUNDARY INTO THIS COMPONENT
 * ============================================================================
 * The Retailer's display name and the two current status values — nothing else. No Vendor
 * organization id, Retailer organization id, auth user id, profile id, email, role code,
 * permission code or capability object is passed in. The capability was evaluated on the
 * SERVER and decided whether this component renders at all; it is never handed to the
 * browser, because a value the browser holds is a value the browser can change.
 *
 * The relationship id IS passed, because it is the address the form must post. It lives in
 * the `value` of a hidden input — re-validated by the server against a detail read it
 * performs for itself — and appears in no visible text, no title, no aria-label and no data
 * attribute. Neither do the raw statuses: they decide which words to show and are never
 * printed. The user-facing labels come from the copy block below.
 *
 * ============================================================================
 * NOTHING HERE IS AN AUTHORIZATION BOUNDARY
 * ============================================================================
 * This control is rendered only for a caller the page proved holds RETAILERS_MANAGE, and only
 * for a supported lifecycle pair. But the Server Action re-resolves Vendor access, re-proves
 * that capability against the database, re-reads the canonical detail and re-checks the
 * transition before accepting a single id — and public.set_vendor_retailer_status re-derives
 * the acting Vendor, the tenant boundary, the organization type, the multi-Vendor guard and
 * the current pair from auth.uid() under its own row locks. A hidden or disabled control
 * removes the accident; only those checks remove the capability.
 *
 * ============================================================================
 * SESSION AND STALE-RESULT ISOLATION
 * ============================================================================
 * The instance is mounted with `key={relationshipId}` by the page, so navigating to a
 * different Retailer unmounts this one and discards all of its state — a response belonging
 * to the previous Retailer's action cannot reach the new one, because the hook that owns it
 * was unmounted with it.
 *
 * A CHANGE OF ACCOUNT IS HANDLED BY THE SERVER, NOT BY A CLIENT GUESS. Nothing about the
 * caller is cached here: the action re-resolves the session on every submission and redirects
 * to /login when it has gone, so a form left open under user A cannot commit under user B.
 * No authorization state is stored, and there is no `unstable_cache`, `use cache` or
 * permission memo anywhere on this path.
 *
 * NO OPTIMISTIC STATUS. The badge on the page is never mutated from here. The status shown
 * always comes from the server's canonical read after `revalidatePath`, so the page can never
 * claim a state the database has not confirmed.
 */

type RetailerLifecycleDialogProps = {
  /** vendor_retailers.id — the canonical target, straight from the route params. */
  relationshipId: string;
  /** For the accessible name and the dialog heading. Already visible on the page. */
  retailerName: string;
  /**
   * The Retailer organization's current status, exactly as the canonical detail reported it.
   * Decides the direction of the action and is NEVER rendered.
   */
  retailerStatus: string;
  /**
   * The relationship's current status, from the same read. Both are required: this control is
   * offered only when they agree, and a single value could not express that.
   */
  relationshipStatus: string;
};

/**
 * The copy for each direction, in one place so the button, the heading, the body and the
 * confirm label cannot drift apart.
 *
 * Keyed by the REQUESTED stored status — SUSPENDED for deactivation, ACTIVE for
 * reactivation — while every visible word uses the product vocabulary. The stored value
 * never appears on screen.
 *
 * BOTH BLOCKS STATE PRESERVATION EXPLICITLY, because that is the fact an administrator most
 * needs before pressing a button that blocks an entire company: nothing is deleted, and the
 * change is fully reversible.
 */
const DIRECTION_COPY = {
  SUSPENDED: {
    opener: "Deactivate Retailer",
    heading: "Deactivate Retailer?",
    confirm: "Deactivate Retailer",
    pendingLabel: "Deactivating…",
    /** What stops, and for whom. */
    blocking:
      "Everyone at this Retailer — the Retailer Owner, any Retailer Manager and all Sales Staff — will be blocked from the Retailer workspace. People who are already signed in are blocked on their next refresh or protected action; nobody is signed out.",
    /** The operational consequences, stated plainly. */
    operations:
      "Receipt submission stops. New Shop creation, product assignment and invitation operations for this Retailer stop as well.",
    preservation:
      "Nothing is deleted. Existing users, roles, Shops, Shop assignments, product assignments, receipts and pending invitations are all kept, and reactivating restores the previous access wherever those records are still valid.",
    openerVariant: "outline" as const,
    confirmVariant: "danger" as const,
  },
  ACTIVE: {
    opener: "Reactivate Retailer",
    heading: "Reactivate Retailer?",
    confirm: "Reactivate Retailer",
    pendingLabel: "Reactivating…",
    blocking:
      "The preserved users, roles, Shops and Shop assignments at this Retailer become available again straight away. Nothing needs to be set up a second time.",
    operations:
      "Receipt access resumes according to the Shop assignments and permissions that were already in place.",
    preservation:
      "Any pending invitation that is still valid and has not expired can be used again. Invitations that expired while the Retailer was inactive stay expired.",
    openerVariant: "primary" as const,
    confirmVariant: "primary" as const,
  },
} as const;

export function RetailerLifecycleDialog({
  relationshipId,
  retailerName,
  retailerStatus,
  relationshipStatus,
}: RetailerLifecycleDialogProps) {
  const [state, formAction, pending] = useActionState(
    setVendorRetailerStatusAction,
    INITIAL_RETAILER_LIFECYCLE_STATE,
  );

  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();
  const descriptionId = useId();

  // The direction this control offers, derived from the CURRENT canonical pair. Null for any
  // pair this operation does not own — the page already refuses to render the control in that
  // case, and this is the second, independent guard.
  const action = resolveVendorRetailerLifecycle({
    retailerStatus,
    relationshipStatus,
  });

  const committed =
    state.outcome === "changed" ||
    state.outcome === "unchanged" ||
    state.outcome === "saved-unconfirmed";

  // Everything that must happen when a NEW action result arrives, in one render-time
  // adjustment — React's documented pattern for deriving state from changing input, which
  // re-renders immediately instead of painting a stale frame and correcting it in a second
  // cascading pass. The same idiom the Retailer-side staff dialog uses.
  //
  // Tracked against the state OBJECT rather than the outcome, so two consecutive results with
  // the same outcome each surface rather than the second being swallowed.
  //
  //   * the new outcome is shown (a previous dismissal is cleared);
  //   * a COMMITTED result closes the dialog, because the outcome belongs beside the status
  //     that just changed, not inside a modal the administrator must dismiss. Errors
  //     deliberately leave the dialog OPEN, so the message appears in the context of the
  //     decision being made.
  const [seenState, setSeenState] = useState(state);
  const [dismissed, setDismissed] = useState(false);
  if (seenState !== state) {
    setSeenState(state);
    setDismissed(false);
    if (committed) setOpen(false);
  }

  // Focus management. On open, focus moves into the dialog; on close, back to the control that
  // opened it, so keyboard and screen-reader users are never dropped at the top of the
  // document.
  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    } else {
      openerRef.current?.focus();
    }
  }, [open]);

  // Escape closes — but never while a write is in flight, so a stray keypress cannot leave the
  // administrator unsure whether their change was submitted.
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

  // Not a pair this control owns. Rendering nothing is the same decision the page already
  // made; this is defence in depth against a future caller that forgets the check.
  if (action === null) return null;

  const copy = DIRECTION_COPY[action.requestedStatus];

  const submitEnabled = canSubmitVendorRetailerLifecycleChange({
    submitting: pending,
    // After a committed write the confirm button is not offered at all: an ordinary second
    // click must never silently resubmit a change that has already happened.
    alreadyCommitted: committed,
    requestedStatus: action.requestedStatus,
  });

  function closeDialog() {
    // Dismissal is blocked ONLY while a committed request is in flight.
    if (pending) return;
    setOpen(false);
  }

  function openDialog() {
    // Clear any previous outcome so the dialog never opens showing the result of the last
    // operation alongside a fresh decision.
    setDismissed(true);
    setOpen(true);
  }

  const showFeedback = !dismissed && (state.success !== null || state.error !== null);

  return (
    <div className="flex flex-col items-stretch gap-3 sm:items-end">
      <button
        ref={openerRef}
        type="button"
        onClick={openDialog}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${copy.opener}: ${retailerName}`}
        className={buttonClasses({ variant: copy.openerVariant, size: "sm" })}
      >
        {copy.opener}
      </button>

      {/* The outcome, rendered beside the control rather than in the modal. `aria-live`
          announces it to a screen reader without moving focus, which would be disorienting
          after a confirmation flow that already returned focus to the opener. */}
      {showFeedback && (
        <div className="w-full sm:max-w-sm" aria-live="polite">
          <Alert
            tone={
              state.outcome === "changed"
                ? "success"
                : state.outcome === "unchanged"
                  ? "info"
                  : state.outcome === "saved-unconfirmed"
                    ? "warning"
                    : "error"
            }
          >
            {state.success ?? state.error}
          </Alert>
        </div>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
          // A click on the backdrop closes, matching the Escape affordance — and is refused
          // while pending by closeDialog for the same reason.
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog();
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
              "flex max-h-[90dvh] w-full flex-col rounded-t-2xl bg-white text-left shadow-xl outline-none",
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
                  {copy.heading}
                </h2>
                <p className="mt-0.5 truncate text-sm text-slate-500">
                  <span className="font-medium text-slate-700">{retailerName}</span>
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={closeDialog}
                disabled={pending}
                aria-label="Close"
              >
                Close
              </Button>
            </div>

            <form action={formAction} className="flex min-h-0 flex-1 flex-col">
              {/* The canonical target and the requested state. Both are ADDRESSES the server
                  re-validates against a detail read it performs from auth.uid() — never
                  capabilities, and never rendered as text. */}
              <input type="hidden" name="relationshipId" value={relationshipId} />
              <input
                type="hidden"
                name="requestedStatus"
                value={action.requestedStatus}
              />

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {state.error && (
                  <div className="mb-4">
                    <Alert tone="error">{state.error}</Alert>
                  </div>
                )}

                <div id={descriptionId} className="space-y-3 text-sm text-slate-600">
                  <p>{copy.blocking}</p>
                  <p>{copy.operations}</p>
                  {/* The preservation promise, given visual weight of its own. It is the fact
                      that makes a drastic-sounding action safe to take. */}
                  <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-600">
                    {copy.preservation}
                  </p>
                </div>
              </div>

              {/* Footer */}
              <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={closeDialog}
                  disabled={pending}
                >
                  Cancel
                </Button>
                {/* Hidden once committed, so no ordinary retry can resubmit a change that has
                    already happened. The RPC is idempotent regardless. */}
                {!committed && (
                  <Button
                    type="submit"
                    variant={copy.confirmVariant}
                    disabled={!submitEnabled}
                    loading={pending}
                    loadingLabel={copy.pendingLabel}
                  >
                    {copy.confirm}
                  </Button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
