"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useActionState } from "react";
import { setStaffMembershipStatusAction } from "@/app/(retailer)/retailer/staff/actions";
import { INITIAL_STAFF_LIFECYCLE_STATE } from "@/app/(retailer)/retailer/staff/staff-lifecycle-state";
import {
  canSubmitLifecycleChange,
  nextLifecycleStatus,
} from "@/lib/staff/staff-lifecycle-input";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * The staff activation/deactivation control: a Retailer Owner stands an existing Retailer
 * Manager or Sales Staff member down, or puts them back.
 *
 * A Client Component for three reasons and no others: `useActionState` (pending and outcome
 * feedback), dialog open/close with focus management, and the confirm-before-acting flow.
 * All three are ordinary, non-sensitive UI concerns.
 *
 * ============================================================================
 * WHAT CROSSES THE SERVER BOUNDARY INTO THIS COMPONENT
 * ============================================================================
 * The member's display name, their role label, their membership id, and their current
 * membership status — nothing else. No Retailer organization id, auth user id, profile id,
 * email, role UUID, permission code, token or hash is passed in; none is available to pass,
 * because no RPC returns one.
 *
 * NO INTERNAL IDENTIFIER IS EVER RENDERED. The membership id lives in the `value` of a
 * hidden input — an address the server re-validates against the roster it reads for itself
 * — and appears in no visible text, no title, no aria-label and no data attribute. Neither
 * does the raw status: `membershipStatus` decides which words to show and is never printed.
 *
 * ============================================================================
 * NOTHING HERE IS AN AUTHORIZATION BOUNDARY
 * ============================================================================
 * This control is rendered only for a caller the page proved holds the staff-management
 * capability, and only for an eligible row. But the Server Action re-resolves portal
 * access, re-proves that capability against the database, re-reads the canonical roster and
 * re-checks eligibility before accepting a single id — and
 * public.set_retailer_staff_membership_status re-derives the Retailer, the target's role
 * set, the target's current status and the self-target rule from auth.uid(). A hidden or
 * disabled control removes the accident; only those checks remove the capability.
 *
 * ============================================================================
 * SESSION AND CONTEXT ISOLATION
 * ============================================================================
 * Every instance is mounted with `key={member.membershipId}` by the page. A membership id
 * is unique per (organization, user), so a different account — or a different Retailer —
 * produces an entirely different roster and therefore different keys: React unmounts each
 * old instance and all of its state (open flag, feedback) is discarded. A response from a
 * previous instance's action cannot reach a new one, because the hook that owns it was
 * unmounted with it. The Server Action independently redirects to /login when the session
 * is gone, and to /retailer-access-denied when the caller is no longer authorized.
 */

type StaffLifecycleDialogProps = {
  /** organization_members.id — the canonical target, straight from the roster. */
  membershipId: string;
  /** For the accessible name and the dialog heading. Already visible on the row. */
  memberName: string;
  /** The display role label, e.g. "Sales Staff". Presentation only. */
  roleLabel: string;
  /**
   * The row's current membership status, exactly as the roster reported it. Decides the
   * direction of the action and is NEVER rendered — the visible words come from the two
   * copy blocks below.
   */
  membershipStatus: string;
};

/**
 * The copy for each direction, in one place so the button, the heading, the body and the
 * confirm label cannot drift apart.
 *
 * Both blocks state the PRESERVATION semantics explicitly, because that is the fact an
 * operator most needs before pressing a destructive-sounding button: nothing is deleted,
 * and the change is fully reversible.
 */
const DIRECTION_COPY = {
  DEACTIVATED: {
    opener: "Deactivate",
    heading: "Deactivate staff",
    confirm: "Deactivate staff",
    pendingLabel: "Deactivating…",
    body: "They will immediately lose access to the Retailer workspace, including receipt submission, the next time they open or refresh a page.",
    preservation:
      "Their profile, sign-in, role and shop assignments are kept, along with their receipts and history. You can reactivate them at any time.",
    openerVariant: "outline" as const,
    confirmVariant: "danger" as const,
  },
  ACTIVE: {
    opener: "Reactivate",
    heading: "Reactivate staff",
    confirm: "Reactivate staff",
    pendingLabel: "Reactivating…",
    body: "They will be able to sign in to the Retailer workspace again straight away.",
    preservation:
      "Their previous role and shop assignments were never removed, so their access returns exactly as it was. Nothing needs to be set up again.",
    openerVariant: "outline" as const,
    confirmVariant: "primary" as const,
  },
} as const;

export function StaffLifecycleDialog({
  membershipId,
  memberName,
  roleLabel,
  membershipStatus,
}: StaffLifecycleDialogProps) {
  const [state, formAction, pending] = useActionState(
    setStaffMembershipStatusAction,
    INITIAL_STAFF_LIFECYCLE_STATE,
  );

  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();
  const descriptionId = useId();

  // The direction this control offers, derived from the CURRENT row status. Null for any
  // status this operation does not own — the page already refuses to render the control in
  // that case, and this is the second, independent guard.
  const targetStatus = nextLifecycleStatus(membershipStatus);

  const committed =
    state.outcome === "changed" ||
    state.outcome === "unchanged" ||
    state.outcome === "saved-unconfirmed";

  // Everything that must happen when a NEW action result arrives, in one render-time
  // adjustment — React's documented pattern for deriving state from changing input, which
  // re-renders immediately instead of painting a stale frame and correcting it in a second
  // cascading pass. The same idiom ./manage-shops-dialog.tsx uses for its option list.
  //
  // Tracked against the state OBJECT rather than the outcome, so two consecutive results
  // with the same outcome each surface rather than the second being swallowed.
  //
  //   * the new outcome is shown (a previous dismissal is cleared);
  //   * a COMMITTED result closes the dialog, because the outcome belongs on the row next
  //     to the status that just changed, not inside a modal the operator must dismiss.
  //     Errors deliberately leave the dialog OPEN, so the message appears in the context of
  //     the decision the operator was making.
  const [seenState, setSeenState] = useState(state);
  const [dismissed, setDismissed] = useState(false);
  if (seenState !== state) {
    setSeenState(state);
    setDismissed(false);
    if (committed) setOpen(false);
  }

  // Focus management. On open, focus moves into the dialog; on close, back to the control
  // that opened it, so keyboard and screen-reader users are never dropped at the top of the
  // document.
  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    } else {
      openerRef.current?.focus();
    }
  }, [open]);

  // Escape closes — but never while a write is in flight, so a stray keypress cannot leave
  // the operator unsure whether their change was submitted.
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

  // The row is not one this control owns. Rendering nothing is the same decision the page
  // already made; this is defence in depth against a future caller that forgets the check.
  if (targetStatus === null) return null;

  const copy = DIRECTION_COPY[targetStatus];

  const submitEnabled = canSubmitLifecycleChange({
    submitting: pending,
    // After a committed write the confirm button is not offered at all: an ordinary second
    // click must never silently resubmit a change that has already happened.
    alreadyCommitted: committed,
    targetStatus,
  });

  function closeDialog() {
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
    <div className="flex flex-col items-start gap-2">
      {/* A plain <button> with the shared class helper rather than <Button>, because the
          opener needs a ref for focus restoration and the component does not type one.
          buttonClasses() is exposed for exactly this case, so the visual system is still
          the single source of truth. */}
      <button
        ref={openerRef}
        type="button"
        onClick={openDialog}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${copy.opener} ${memberName}`}
        className={buttonClasses({ variant: copy.openerVariant, size: "sm" })}
      >
        {copy.opener}
      </button>

      {/* The outcome, rendered on the row rather than in the modal. `aria-live` announces it
          to a screen reader without moving focus, which would be disorienting after a
          confirmation flow that already returned focus to the opener. */}
      {showFeedback && (
        <div className="w-full max-w-xs" aria-live="polite">
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
          // A click on the backdrop closes, matching the Escape affordance. The inner panel
          // stops propagation so a click inside never closes.
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
                  {copy.heading}
                </h2>
                <p className="mt-0.5 truncate text-sm text-slate-500">
                  <span className="font-medium text-slate-700">{memberName}</span>
                  <span aria-hidden="true"> · </span>
                  {roleLabel}
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
              {/* The canonical target and the requested state. Both are ADDRESSES the
                  server re-validates against the roster it reads from auth.uid() — never
                  capabilities, and never rendered as text. */}
              <input type="hidden" name="membershipId" value={membershipId} />
              <input type="hidden" name="requestedStatus" value={targetStatus} />

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {state.error && (
                  <div className="mb-4">
                    <Alert tone="error">{state.error}</Alert>
                  </div>
                )}

                <div id={descriptionId} className="space-y-3 text-sm text-slate-600">
                  <p>{copy.body}</p>
                  {/* The preservation promise, given visual weight of its own. It is the
                      fact that makes a destructive-sounding action safe to take. */}
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
                {/* Hidden once committed, so no ordinary retry can resubmit a change that
                    has already happened. The RPC is idempotent regardless. */}
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
