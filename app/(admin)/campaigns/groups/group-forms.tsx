"use client";

import { useActionState, useId, useState } from "react";
import Link from "next/link";
import {
  createRetailerGroupAction,
  setRetailerGroupMembersAction,
  updateRetailerGroupAction,
} from "@/app/(admin)/campaigns/actions";
import {
  INITIAL_GROUP_FORM_STATE,
  INITIAL_GROUP_MEMBERS_STATE,
} from "@/app/(admin)/campaigns/campaign-action-state";
import { hasMembershipChanged } from "@/lib/campaigns/campaign-input";
import type { SelectableRetailer } from "@/app/(admin)/campaigns/campaign-wizard";
import { EntityPicker } from "@/components/campaigns/entity-picker";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  Field,
  inputClasses,
  selectClasses,
  textareaClasses,
  SelectChevron,
} from "@/components/ui/field";

/**
 * The three Retailer-group controls: create, rename/archive, and edit Retailers.
 *
 * Client Components for the ordinary reasons only — `useActionState` for pending and
 * outcome feedback, and interactive selection. Nothing here is an authorization boundary:
 * every Server Action re-resolves Vendor Admin access, and every RPC re-derives the Vendor
 * from auth.uid() and re-checks RETAILER_GROUPS_MANAGE.
 *
 * A NO-OP IS REPORTED AS A NO-OP. The database writes nothing — and no audit row — when a
 * submit changes no value, and these forms say "No changes to save" rather than claiming a
 * save that did not happen.
 *
 * LANGUAGE: these screens say "Retailers", not "members". "Membership" survives only where
 * it names the underlying replace-the-whole-set contract, which is a technical fact worth
 * being precise about.
 */

/* ---------------------------------------------------------------------------
 * Create — name, description and Retailers, in ONE flow
 * ------------------------------------------------------------------------- */

/**
 * Creating a group and choosing its Retailers is one task, so it is one form.
 *
 * The previous flow made an operator create an empty group, find it in a list, open it,
 * and save a second time — four steps and two writes to express one intention, with an
 * empty group left behind if they stopped halfway.
 *
 * IT IS STILL TWO RPCs. `create_vendor_retailer_group` and
 * `set_vendor_retailer_group_members` are separate contracts and neither takes the
 * other's work as an argument, so there is a window where the group exists and its
 * Retailers do not. The Server Action reports exactly that when it happens — and keeps the
 * new group's id, so this form stops offering to create and offers the link to finish
 * instead. Nothing is retried automatically, and no retry can produce a second group.
 */
export function CreateGroupForm({
  retailers,
  optionsReady,
}: {
  retailers: SelectableRetailer[];
  /** False when the Retailer directory could not be read. */
  optionsReady: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    createRetailerGroupAction,
    INITIAL_GROUP_FORM_STATE,
  );
  const fieldId = useId();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [allowEmpty, setAllowEmpty] = useState(false);

  function toggle(id: string, on: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // The group exists. Whatever happened to its Retailers, creating again is wrong.
  const created = state.createdGroupId !== null;

  // A group with no Retailers is legal and occasionally wanted, but it is never the
  // DEFAULT: an operator who simply has not picked anyone yet must be stopped, and an
  // operator who genuinely wants a placeholder must say so.
  //
  // The guard applies ONLY when there is something to choose. With no connected Retailers
  // — or with the directory unreadable — there is no selection to make, and requiring an
  // opt-in the form cannot offer would leave the operator unable to create anything.
  const noneChosen = selected.size === 0;
  const canChoose = optionsReady && retailers.length > 0;
  const blockedOnEmpty = canChoose && noneChosen && !allowEmpty;

  return (
    <form action={formAction} className="space-y-5">
      {state.formError && (
        <Alert tone="error" role="alert">
          {state.formError}
        </Alert>
      )}

      {/* The recoverable outcome, stated as itself: not a success, not a failure. */}
      {state.partialWarning && (
        <Alert tone="warning" role="alert" title="The group was created">
          <p>{state.partialWarning}</p>
          {state.createdGroupId && (
            <p className="mt-3">
              <Link
                href={`/campaigns/groups/${state.createdGroupId}`}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                Open the group and add Retailers
              </Link>
            </p>
          )}
        </Alert>
      )}

      {state.successMessage && <Alert tone="success">{state.successMessage}</Alert>}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Group name"
          htmlFor={`${fieldId}-name`}
          hint="Something you will recognize when choosing a campaign audience."
          error={state.fieldErrors.name}
        >
          <input
            id={`${fieldId}-name`}
            name="name"
            defaultValue={state.values.name}
            maxLength={120}
            required
            disabled={created}
            placeholder="Premium Dubai Retailers"
            aria-invalid={state.fieldErrors.name !== undefined}
            className={inputClasses(state.fieldErrors.name !== undefined)}
          />
        </Field>

        <Field
          label="Description"
          htmlFor={`${fieldId}-description`}
          optional
          hint="What this group is for."
          error={state.fieldErrors.description}
        >
          <input
            id={`${fieldId}-description`}
            name="description"
            defaultValue={state.values.description}
            maxLength={500}
            disabled={created}
            className={inputClasses(state.fieldErrors.description !== undefined)}
          />
        </Field>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-slate-800">Retailers in this group</p>
          <p className="text-xs text-slate-500">
            You can change these at any time afterwards.
          </p>
        </div>

        {!optionsReady ? (
          // A READ failure reported as its own thing. The form still creates the group;
          // it simply cannot offer a selection it could not load.
          <Alert tone="warning" role="alert" title="Retailers could not be loaded">
            You can still create the group and add its Retailers from the group page.
          </Alert>
        ) : (
          <EntityPicker
            name="vendorRetailerIds"
            label="Retailers for this group"
            noun="Retailer"
            options={retailers.map((retailer) => ({
              id: retailer.vendorRetailerId,
              primary: retailer.retailerName,
              secondary: null,
              isSelectable: retailer.isSelectable,
              note: retailer.statusNote,
            }))}
            selected={selected}
            onToggle={toggle}
            onClear={() => setSelected(new Set())}
            emptyMessage="You have no connected Retailers yet. Create the group now and add Retailers once you have some."
            searchLabel="Search Retailers"
            disabled={pending || created}
            invalid={state.fieldErrors.vendorRetailerIds !== undefined}
          />
        )}

        {state.fieldErrors.vendorRetailerIds && (
          <p role="alert" className="text-sm font-medium text-red-700">
            {state.fieldErrors.vendorRetailerIds}
          </p>
        )}
      </div>

      {/* The intentional advanced choice, offered explicitly rather than by default. */}
      {canChoose && noneChosen && !created && (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3">
          <input
            type="checkbox"
            checked={allowEmpty}
            onChange={(event) => setAllowEmpty(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500"
          />
          <span className="text-xs leading-relaxed text-slate-600">
            Create this group empty for now. An empty group adds no Retailer to a
            campaign, so a campaign targeting only this group cannot be published until
            it has at least one.
          </span>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {/* Hidden once the group exists, so no ordinary retry can create a second one. */}
        {!created && (
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            loadingLabel="Creating…"
            disabled={blockedOnEmpty}
          >
            Create group
          </Button>
        )}
        {!created && blockedOnEmpty && (
          <span className="text-xs text-slate-500">
            Choose at least one Retailer, or tick the box above.
          </span>
        )}
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------------------
 * Rename / archive
 * ------------------------------------------------------------------------- */

export function EditGroupForm({
  groupId,
  name,
  description,
  status,
}: {
  groupId: string;
  name: string;
  description: string;
  status: "ACTIVE" | "ARCHIVED";
}) {
  const [state, formAction, pending] = useActionState(updateRetailerGroupAction, {
    ...INITIAL_GROUP_FORM_STATE,
    values: { name, description },
  });
  const fieldId = useId();
  const [nextStatus, setNextStatus] = useState(status);

  return (
    <form action={formAction} className="space-y-5">
      {/* A canonical ADDRESS the server re-validates against the Vendor it derives from
          auth.uid() — never a capability, and never rendered as text. */}
      <input type="hidden" name="groupId" value={groupId} />

      {state.formError && (
        <Alert tone="error" role="alert">
          {state.formError}
        </Alert>
      )}
      {state.successMessage && <Alert tone="success">{state.successMessage}</Alert>}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Group name"
          htmlFor={`${fieldId}-name`}
          error={state.fieldErrors.name}
        >
          <input
            id={`${fieldId}-name`}
            name="name"
            defaultValue={state.values.name}
            maxLength={120}
            required
            aria-invalid={state.fieldErrors.name !== undefined}
            className={inputClasses(state.fieldErrors.name !== undefined)}
          />
        </Field>

        <Field
          label="Status"
          htmlFor={`${fieldId}-status`}
          hint="Archiving stops this group being chosen for a new campaign. Campaigns already published through it are completely unaffected."
        >
          <div className="relative">
            <select
              id={`${fieldId}-status`}
              name="status"
              value={nextStatus}
              onChange={(event) =>
                setNextStatus(event.target.value === "ARCHIVED" ? "ARCHIVED" : "ACTIVE")
              }
              className={selectClasses()}
            >
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
            </select>
            <SelectChevron />
          </div>
        </Field>
      </div>

      <Field
        label="Description"
        htmlFor={`${fieldId}-description`}
        optional
        error={state.fieldErrors.description}
      >
        <textarea
          id={`${fieldId}-description`}
          name="description"
          defaultValue={state.values.description}
          maxLength={500}
          rows={2}
          className={textareaClasses(state.fieldErrors.description !== undefined)}
        />
      </Field>

      <Button type="submit" variant="primary" loading={pending} loadingLabel="Saving…">
        Save details
      </Button>
    </form>
  );
}

/* ---------------------------------------------------------------------------
 * Retailers in the group
 * ------------------------------------------------------------------------- */

/**
 * The Retailer editor for an existing group.
 *
 * ATOMIC REPLACEMENT: the whole intended set is submitted and the database computes the
 * difference, so two operators editing at once cannot interleave into a membership
 * neither of them chose. The picker's search is purely visual for exactly this reason —
 * see @/components/campaigns/entity-picker.
 */
export function GroupMembersForm({
  groupId,
  currentMemberIds,
  retailers,
  optionsReady,
}: {
  groupId: string;
  currentMemberIds: string[];
  retailers: SelectableRetailer[];
  optionsReady: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    setRetailerGroupMembersAction,
    INITIAL_GROUP_MEMBERS_STATE,
  );

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(currentMemberIds),
  );

  const selectedIds = Array.from(selected);
  const changed = hasMembershipChanged(currentMemberIds, selectedIds);

  function toggle(id: string, on: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  if (!optionsReady) {
    // A READ failure, reported as its own thing. Never converted into a write failure,
    // and the form cannot submit — saving against a list we could not load would replace
    // the membership with whatever happened to render.
    return (
      <Alert tone="warning" role="alert" title="Retailers could not be loaded">
        We couldn&apos;t load your Retailers, so this group cannot be changed right now.
        The group itself is unaffected.
      </Alert>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="groupId" value={groupId} />

      {state.error && (
        <Alert tone="error" role="alert">
          {state.error}
        </Alert>
      )}
      {state.success && <Alert tone="success">{state.success}</Alert>}

      <EntityPicker
        name="vendorRetailerIds"
        label="Retailers in this group"
        noun="Retailer"
        options={retailers.map((retailer) => ({
          id: retailer.vendorRetailerId,
          primary: retailer.retailerName,
          secondary: null,
          isSelectable: retailer.isSelectable,
          note: retailer.statusNote,
        }))}
        selected={selected}
        onToggle={toggle}
        onClear={() => setSelected(new Set())}
        emptyMessage="You have no connected Retailers yet."
        searchLabel="Search Retailers"
        disabled={pending || state.committed}
      />

      <p className="rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs leading-relaxed text-slate-600">
        Changing this group does <strong>not</strong> change any campaign that is already
        published through it — publication froze its eligibility. Create a new campaign
        version to pick the change up.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        {/* Hidden once committed, so no ordinary retry can resubmit a replacement that
            has already happened. The RPC is idempotent regardless. */}
        {!state.committed && (
          <Button
            type="submit"
            variant="primary"
            disabled={!changed || pending}
            loading={pending}
            loadingLabel="Saving…"
          >
            Save Retailers
          </Button>
        )}
        {!changed && !state.committed && (
          <span className={cn("text-xs text-slate-500")}>No changes to save.</span>
        )}
      </div>
    </form>
  );
}
