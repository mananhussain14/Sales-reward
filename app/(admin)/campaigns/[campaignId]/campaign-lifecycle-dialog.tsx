"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import {
  createCampaignVersionAction,
  publishCampaignAction,
  setCampaignLifecycleAction,
} from "@/app/(admin)/campaigns/actions";
import { INITIAL_CAMPAIGN_ACTION_STATE } from "@/app/(admin)/campaigns/campaign-action-state";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";

/**
 * The confirmation dialog behind every campaign lifecycle mutation: publish, pause,
 * resume, cancel and create-new-version.
 *
 * ONE component for all five, because the safety properties are identical and five
 * near-copies would be five places to forget one of them:
 *
 *   * Nothing mutates without an explicit confirmation.
 *   * The submit button DISAPPEARS once the write commits, so an ordinary retry — a
 *     double click, a reload, an impatient second press — cannot resubmit something that
 *     has already happened. The RPCs are idempotent regardless; this removes the accident
 *     as well as the consequence.
 *   * A no-op is reported as a no-op. Publishing twice returns "already published" rather
 *     than a success claim, because the database wrote nothing and the audit trail says so.
 *   * NOTHING IS RETRIED AUTOMATICALLY. There is no retry path in this component at all.
 *
 * A Client Component for exactly three reasons: `useActionState`, dialog open/close, and
 * focus management. It holds no authorization decision — the Server Action re-resolves
 * Vendor Admin access, and the RPC re-derives the Vendor from auth.uid() and re-checks
 * CAMPAIGNS_MANAGE.
 *
 * The campaign id crosses into this component as an ADDRESS the server re-validates. It
 * lives in a hidden field and appears in no visible text, title or aria-label.
 */

export type LifecycleKind = "PUBLISH" | "PAUSE" | "RESUME" | "CANCEL" | "NEW_VERSION";

type Copy = {
  trigger: string;
  heading: string;
  body: string;
  confirm: string;
  busy: string;
  variant: "primary" | "secondary" | "outline" | "danger";
};

const COPY: Record<LifecycleKind, Copy> = {
  PUBLISH: {
    trigger: "Publish campaign",
    heading: "Publish this campaign?",
    body:
      "Eligible Retailers and their Sales Staff will see it immediately. Publishing freezes this version's configuration and its Retailer and product eligibility — later changes need a new version.",
    confirm: "Publish",
    busy: "Publishing…",
    variant: "primary",
  },
  PAUSE: {
    trigger: "Pause",
    heading: "Pause this campaign?",
    body:
      "It stops applying to new sales. The configuration, the dates and the eligibility snapshot are all preserved, and you can resume it against its original dates.",
    confirm: "Pause",
    busy: "Pausing…",
    variant: "secondary",
  },
  RESUME: {
    trigger: "Resume",
    heading: "Resume this campaign?",
    body:
      "It starts applying again, against its original start and end dates. Nothing about the configuration changes.",
    confirm: "Resume",
    busy: "Resuming…",
    variant: "primary",
  },
  CANCEL: {
    trigger: "Cancel campaign",
    heading: "Cancel this campaign?",
    body:
      "This cannot be undone. The campaign stops applying, keeps its history, and stays visible to Retailers as cancelled. You cannot resume or version it afterwards.",
    confirm: "Cancel campaign",
    busy: "Cancelling…",
    variant: "danger",
  },
  NEW_VERSION: {
    trigger: "Create new version",
    heading: "Create a new version?",
    body:
      "The current version keeps running and stays visible to Retailers. You will get an editable copy of its configuration to change and publish when you are ready.",
    confirm: "Create version",
    busy: "Creating…",
    variant: "outline",
  },
};

export function CampaignLifecycleDialog({
  campaignId,
  kind,
}: {
  campaignId: string;
  kind: LifecycleKind;
}) {
  const copy = COPY[kind];

  const action =
    kind === "PUBLISH"
      ? publishCampaignAction
      : kind === "NEW_VERSION"
        ? createCampaignVersionAction
        : setCampaignLifecycleAction;

  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_CAMPAIGN_ACTION_STATE,
  );

  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();
  const descriptionId = useId();

  // Focus moves into the dialog on open and back to its trigger on close, so keyboard and
  // screen-reader users are never dropped at the top of the document.
  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    } else {
      openerRef.current?.focus();
    }
  }, [open]);

  // Escape closes — but NEVER while a write is in flight, so a stray keypress cannot leave
  // an operator unsure whether they published.
  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, pending]);

  function close() {
    if (pending) return;
    setOpen(false);
  }

  return (
    <>
      {/* A plain <button> with the shared class helper rather than <Button>, because the
          trigger needs a ref for focus restoration and the component does not type one. */}
      <button
        ref={openerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={buttonClasses({ variant: copy.variant, size: "sm" })}
      >
        {copy.trigger}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-slate-900/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
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
              "flex w-full flex-col rounded-t-2xl bg-white shadow-xl outline-none",
              "sm:max-w-md sm:rounded-2xl",
            )}
          >
            <div className="border-b border-slate-200 px-5 py-4">
              <h2 id={headingId} className="text-base font-semibold text-slate-900">
                {copy.heading}
              </h2>
            </div>

            <form action={formAction} className="flex flex-col">
              <input type="hidden" name="campaignId" value={campaignId} />
              {kind !== "PUBLISH" && kind !== "NEW_VERSION" && (
                <input type="hidden" name="action" value={kind} />
              )}

              <div className="px-5 py-4">
                <p id={descriptionId} className="text-sm text-slate-600">
                  {copy.body}
                </p>

                {state.error && (
                  <Alert tone="error" role="alert" className="mt-4">
                    {state.error}
                  </Alert>
                )}
                {state.success && (
                  <Alert tone="success" className="mt-4">
                    {state.success}
                  </Alert>
                )}
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={close} disabled={pending}>
                  {state.committed ? "Done" : "Cancel"}
                </Button>
                {/* Hidden once committed, so no ordinary retry can resubmit a change that
                    has already happened. */}
                {!state.committed && (
                  <Button
                    type="submit"
                    variant={copy.variant}
                    loading={pending}
                    loadingLabel={copy.busy}
                  >
                    {copy.confirm}
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
