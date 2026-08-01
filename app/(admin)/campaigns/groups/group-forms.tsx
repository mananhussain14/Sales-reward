"use client";

import { useActionState, useId, useMemo, useState } from "react";
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
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { SearchIcon } from "@/components/ui/icons";

/**
 * The three Retailer-group controls: create, rename/archive, and edit membership.
 *
 * Client Components for the ordinary reasons only — `useActionState` for pending and
 * outcome feedback, and interactive selection. Nothing here is an authorization boundary:
 * every Server Action re-resolves Vendor Admin access, and every RPC re-derives the Vendor
 * from auth.uid() and re-checks RETAILER_GROUPS_MANAGE.
 *
 * A NO-OP IS REPORTED AS A NO-OP. The database writes nothing — and no audit row — when a
 * submit changes no value, and these forms say "No changes to save" rather than claiming a
 * save that did not happen.
 */

const inputClasses =
  "block w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30";

/* ---------------------------------------------------------------------------
 * Create
 * ------------------------------------------------------------------------- */

export function CreateGroupForm() {
  const [state, formAction, pending] = useActionState(
    createRetailerGroupAction,
    INITIAL_GROUP_FORM_STATE,
  );
  const fieldId = useId();

  return (
    <form action={formAction} className="space-y-4">
      {state.formError && (
        <Alert tone="error" role="alert">
          {state.formError}
        </Alert>
      )}
      {state.successMessage && <Alert tone="success">{state.successMessage}</Alert>}

      <div>
        <label
          htmlFor={`${fieldId}-name`}
          className="block text-sm font-medium text-slate-800"
        >
          Group name
        </label>
        <input
          id={`${fieldId}-name`}
          name="name"
          defaultValue={state.values.name}
          maxLength={120}
          required
          aria-invalid={state.fieldErrors.name !== undefined}
          aria-describedby={state.fieldErrors.name ? `${fieldId}-name-error` : undefined}
          className={cn(inputClasses, "mt-1.5")}
        />
        {state.fieldErrors.name && (
          <p
            id={`${fieldId}-name-error`}
            role="alert"
            className="mt-1.5 text-xs font-medium text-red-600"
          >
            {state.fieldErrors.name}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor={`${fieldId}-description`}
          className="block text-sm font-medium text-slate-800"
        >
          Description
        </label>
        <p className="mt-0.5 text-xs text-slate-500">
          Optional. What this group is for.
        </p>
        <textarea
          id={`${fieldId}-description`}
          name="description"
          defaultValue={state.values.description}
          maxLength={500}
          rows={2}
          className={cn(inputClasses, "mt-1.5")}
        />
        {state.fieldErrors.description && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">
            {state.fieldErrors.description}
          </p>
        )}
      </div>

      <Button type="submit" variant="primary" loading={pending} loadingLabel="Creating…">
        Create group
      </Button>
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
  const [state, formAction, pending] = useActionState(
    updateRetailerGroupAction,
    { ...INITIAL_GROUP_FORM_STATE, values: { name, description } },
  );
  const fieldId = useId();
  const [nextStatus, setNextStatus] = useState(status);

  return (
    <form action={formAction} className="space-y-4">
      {/* A canonical ADDRESS the server re-validates against the Vendor it derives from
          auth.uid() — never a capability, and never rendered as text. */}
      <input type="hidden" name="groupId" value={groupId} />

      {state.formError && (
        <Alert tone="error" role="alert">
          {state.formError}
        </Alert>
      )}
      {state.successMessage && <Alert tone="success">{state.successMessage}</Alert>}

      <div>
        <label
          htmlFor={`${fieldId}-name`}
          className="block text-sm font-medium text-slate-800"
        >
          Group name
        </label>
        <input
          id={`${fieldId}-name`}
          name="name"
          defaultValue={state.values.name}
          maxLength={120}
          required
          aria-invalid={state.fieldErrors.name !== undefined}
          className={cn(inputClasses, "mt-1.5")}
        />
        {state.fieldErrors.name && (
          <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">
            {state.fieldErrors.name}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor={`${fieldId}-description`}
          className="block text-sm font-medium text-slate-800"
        >
          Description
        </label>
        <textarea
          id={`${fieldId}-description`}
          name="description"
          defaultValue={state.values.description}
          maxLength={500}
          rows={2}
          className={cn(inputClasses, "mt-1.5")}
        />
      </div>

      <div>
        <label
          htmlFor={`${fieldId}-status`}
          className="block text-sm font-medium text-slate-800"
        >
          Status
        </label>
        <p className="mt-0.5 text-xs text-slate-500">
          Archiving stops this group being chosen for a new campaign. Campaigns already
          published through it are completely unaffected.
        </p>
        <select
          id={`${fieldId}-status`}
          name="status"
          value={nextStatus}
          onChange={(event) =>
            setNextStatus(event.target.value === "ARCHIVED" ? "ARCHIVED" : "ACTIVE")
          }
          className={cn(inputClasses, "mt-1.5")}
        >
          <option value="ACTIVE">Active</option>
          <option value="ARCHIVED">Archived</option>
        </select>
      </div>

      <Button type="submit" variant="primary" loading={pending} loadingLabel="Saving…">
        Save details
      </Button>
    </form>
  );
}

/* ---------------------------------------------------------------------------
 * Membership
 * ------------------------------------------------------------------------- */

/**
 * The membership editor.
 *
 * ATOMIC REPLACEMENT: the whole intended set is submitted and the database computes the
 * difference, so two operators editing at once cannot interleave into a membership
 * neither of them chose.
 *
 * THE SEARCH IS PURELY VISUAL. Every option stays mounted and is merely hidden when it
 * does not match, so a selection made before typing is still submitted. Unmounting
 * non-matching checkboxes would silently drop them from the FormData — which, for a
 * contract that REPLACES the set, would remove members the operator never intended to
 * remove.
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
  const [query, setQuery] = useState("");
  const searchId = useId();

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      new Set(
        retailers
          .filter(
            (retailer) =>
              needle.length === 0 ||
              retailer.retailerName.toLowerCase().includes(needle),
          )
          .map((retailer) => retailer.vendorRetailerId),
      ),
    [retailers, needle],
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
        We couldn&apos;t load your Retailers, so membership cannot be changed right now.
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

      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Search Retailers
        </label>
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          aria-hidden="true"
        />
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search Retailers"
          className={cn(inputClasses, "pl-9")}
        />
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-slate-600" aria-live="polite">
          {selected.size} of {retailers.length} selected
        </span>
        {needle.length > 0 && <span className="text-slate-400">{matches.size} shown</span>}
      </div>

      {retailers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500">
          You have no connected Retailers yet.
        </p>
      ) : (
        <fieldset
          className="max-h-96 space-y-2 overflow-y-auto rounded-xl border border-slate-200 p-2"
          disabled={pending || state.committed}
        >
          <legend className="sr-only">Retailers in this group</legend>
          {matches.size === 0 && (
            <p className="px-2 py-3 text-sm text-slate-500">
              No Retailer matches that search.
            </p>
          )}
          {retailers.map((retailer) => {
            const checked = selected.has(retailer.vendorRetailerId);
            const hidden = !matches.has(retailer.vendorRetailerId);
            return (
              <label
                key={retailer.vendorRetailerId}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-all",
                  "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500",
                  hidden && "hidden",
                  checked
                    ? "border-indigo-500 bg-indigo-50"
                    : "border-transparent hover:bg-slate-50",
                )}
              >
                <input
                  type="checkbox"
                  name="vendorRetailerIds"
                  value={retailer.vendorRetailerId}
                  checked={checked}
                  onChange={(event) =>
                    toggle(retailer.vendorRetailerId, event.target.checked)
                  }
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {retailer.retailerName}
                  </span>
                  {retailer.statusNote && (
                    <span className="mt-0.5 block text-xs font-medium text-amber-700">
                      {retailer.statusNote}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      <p className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Changing this group does <strong>not</strong> change any campaign that is already
        published through it — publication froze its eligibility. Create a new campaign
        version to pick the change up.
      </p>

      <div className="flex items-center gap-3">
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
            Save membership
          </Button>
        )}
        {!changed && !state.committed && (
          <span className="text-xs text-slate-500">No changes to save.</span>
        )}
      </div>
    </form>
  );
}
