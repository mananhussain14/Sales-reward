"use client";

import { useActionState, useId, useMemo, useState } from "react";
import Link from "next/link";
import {
  EMPTY_CAMPAIGN_FORM,
  WIZARD_STEPS,
  isStepComplete,
  stepErrors,
  validateCampaignForm,
  type CampaignFormValues,
  type WizardStepKey,
} from "@/lib/campaigns/campaign-input";
import {
  audienceLabel,
  performanceExplanation,
  performanceLabel,
  productScopeLabel,
  rewardSummary,
  stackingExplanation,
  stackingLabel,
  AUDIENCE_MODES,
  PERFORMANCE_SCOPES,
  PRODUCT_SCOPES,
  RULE_TYPES,
  STACKING_MODES,
} from "@/lib/campaigns/campaign-vocabulary";
import type { CampaignFormState } from "@/app/(admin)/campaigns/campaign-action-state";
import { INITIAL_CAMPAIGN_FORM_STATE } from "@/app/(admin)/campaigns/campaign-action-state";
import type { PublicationPreviewRow } from "@/lib/campaigns/campaign-normalization";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { cardClasses } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import { CheckIcon, SearchIcon } from "@/components/ui/icons";

/**
 * The six-step campaign wizard, used for BOTH creating a campaign and editing its draft.
 *
 * A Client Component for three reasons and no others: step navigation, the interactive
 * selection lists, and `useActionState` for pending and outcome feedback. All three are
 * ordinary, non-sensitive UI concerns.
 *
 * ============================================================================
 * WHAT CROSSES THE SERVER BOUNDARY INTO THIS COMPONENT
 * ============================================================================
 * The selectable Retailers, groups and products the calling Vendor already owns, and —
 * when editing — the draft's current values and its publication preview. No Vendor
 * organization id, auth user id, profile id, permission code, role code or audit value is
 * passed in; none is available to pass, because no RPC returns one.
 *
 * NO INTERNAL IDENTIFIER IS EVER RENDERED. Relationship, group and product ids live in
 * `value` attributes and React keys — they are addresses the server re-validates — and
 * appear in no visible text, no title, no aria-label and no data attribute. Every label an
 * operator reads is a NAME.
 *
 * ============================================================================
 * NOTHING HERE IS AN AUTHORIZATION BOUNDARY
 * ============================================================================
 * The Server Action re-resolves Vendor Admin access, and
 * create_vendor_campaign_draft / update_vendor_campaign_draft re-derive the Vendor from
 * auth.uid(), re-check CAMPAIGNS_MANAGE, and refuse any Retailer, group or product id
 * that is not this Vendor's. A step this component will not advance past removes an
 * accident; only those checks remove the capability.
 *
 * ============================================================================
 * WHY THIS WIZARD SAVES BUT NEVER PUBLISHES
 * ============================================================================
 * "Save draft" is the only mutation it offers, and it is explicit. Publication is a
 * separate act on the campaign's own page, behind its own confirmation, for two reasons:
 * a draft has no version to resolve against until it is saved, so the true eligibility
 * preview does not exist yet; and one publish surface is easier to reason about than two.
 * The review step says so plainly rather than implying the campaign is live.
 */

export type SelectableRetailer = {
  vendorRetailerId: string;
  retailerName: string;
  /** Shown so an operator can see WHY a Retailer will not resolve at publication. */
  isSelectable: boolean;
  statusNote: string | null;
};

export type SelectableGroup = {
  groupId: string;
  name: string;
  memberCount: number;
  isSelectable: boolean;
};

export type SelectableProduct = {
  productId: string;
  productCode: string;
  productName: string;
  brand: string | null;
  isSelectable: boolean;
};

type WizardProps = {
  mode: "create" | "edit";
  /** Present only in edit mode; carried in a hidden field the server re-validates. */
  campaignId?: string;
  initialValues?: CampaignFormValues;
  retailers: SelectableRetailer[];
  groups: SelectableGroup[];
  products: SelectableProduct[];
  /** True when an option list could not be loaded — the step then cannot be completed. */
  optionsReady: boolean;
  /** The server's publication preview. Only ever available for a SAVED draft. */
  preview: PublicationPreviewRow[] | null;
  action: (
    state: CampaignFormState,
    formData: FormData,
  ) => Promise<CampaignFormState>;
  /** The IANA zones offered. Resolved on the server from the runtime's zone database. */
  timeZones: string[];
};

/** A labelled field wrapper with a stable id/description association. */
function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  const hintId = `${htmlFor}-hint`;
  const errorId = `${htmlFor}-error`;
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="mt-0.5 text-xs text-slate-500">
          {hint}
        </p>
      )}
      <div className="mt-1.5">{children}</div>
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

const inputClasses =
  "block w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30";

/** A radio card — a large, obviously-selectable target for a closed choice. */
function ChoiceCard({
  name,
  value,
  checked,
  title,
  description,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  title: string;
  description: string;
  onChange: (value: string) => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-all",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500 has-[:focus-visible]:ring-offset-2",
        checked
          ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200"
          : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-0.5 h-4 w-4 shrink-0 border-slate-300 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-900">{title}</span>
        <span className="mt-0.5 block text-xs text-slate-500">{description}</span>
      </span>
    </label>
  );
}

/**
 * A searchable multi-select.
 *
 * The SEARCH IS PURELY VISUAL: every option is rendered as a checkbox and simply hidden
 * when it does not match, so a selection made before typing survives the filter and is
 * still submitted. Unmounting non-matching inputs would silently drop them from the
 * FormData — a selection an operator made and can no longer see is worse than no search.
 */
function MultiSelect({
  name,
  options,
  selected,
  onToggle,
  emptyMessage,
  searchLabel,
  disabled,
}: {
  name: string;
  options: {
    id: string;
    primary: string;
    secondary: string | null;
    isSelectable: boolean;
    note: string | null;
  }[];
  selected: Set<string>;
  onToggle: (id: string, checked: boolean) => void;
  emptyMessage: string;
  searchLabel: string;
  disabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      new Set(
        options
          .filter(
            (option) =>
              needle.length === 0 ||
              option.primary.toLowerCase().includes(needle) ||
              (option.secondary ?? "").toLowerCase().includes(needle),
          )
          .map((option) => option.id),
      ),
    [options, needle],
  );

  if (options.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 px-4 py-3 text-sm text-slate-500">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          {searchLabel}
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
          placeholder={searchLabel}
          className={cn(inputClasses, "pl-9")}
        />
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-slate-600" aria-live="polite">
          {selected.size} selected
        </span>
        {needle.length > 0 && (
          <span className="text-slate-400">{matches.size} shown</span>
        )}
      </div>

      <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-slate-200 p-2">
        {matches.size === 0 && (
          <p className="px-2 py-3 text-sm text-slate-500">Nothing matches that search.</p>
        )}
        {options.map((option) => {
          const checked = selected.has(option.id);
          const hidden = !matches.has(option.id);
          return (
            <label
              key={option.id}
              // Hidden, never unmounted: an off-screen checkbox still submits.
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-all",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-indigo-500",
                hidden && "hidden",
                checked
                  ? "border-indigo-500 bg-indigo-50"
                  : "border-transparent hover:bg-slate-50",
                !option.isSelectable && "opacity-70",
              )}
            >
              <input
                type="checkbox"
                name={name}
                value={option.id}
                checked={checked}
                disabled={disabled}
                onChange={(event) => onToggle(option.id, event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-indigo-600 focus-visible:ring-2 focus-visible:ring-indigo-500"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-slate-900">
                  {option.primary}
                </span>
                {option.secondary && (
                  <span className="block truncate text-xs text-slate-500">
                    {option.secondary}
                  </span>
                )}
                {option.note && (
                  <span className="mt-0.5 block text-xs font-medium text-amber-700">
                    {option.note}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function CampaignWizard({
  mode,
  campaignId,
  initialValues,
  retailers,
  groups,
  products,
  optionsReady,
  preview,
  action,
  timeZones,
}: WizardProps) {
  const [state, formAction, pending] = useActionState(
    action,
    initialValues === undefined
      ? INITIAL_CAMPAIGN_FORM_STATE
      : { ...INITIAL_CAMPAIGN_FORM_STATE, values: initialValues },
  );

  // The form's live values. Seeded from the server's echo after a submit, so a validation
  // failure never empties six steps of work.
  const [values, setValues] = useState<CampaignFormValues>(
    initialValues ?? EMPTY_CAMPAIGN_FORM,
  );
  const [stepIndex, setStepIndex] = useState(0);
  const fieldId = useId();

  const step = WIZARD_STEPS[stepIndex];
  const validation = validateCampaignForm(values);
  const serverErrors = state.fieldErrors;

  // Server field errors take precedence: they are the authoritative answer for the values
  // actually submitted.
  const errorsFor = (key: WizardStepKey) => ({
    ...stepErrors(validation.ok ? {} : validation.fieldErrors, key),
    ...stepErrors(serverErrors, key),
  });

  const currentErrors = errorsFor(step.key);
  const committed = state.savedCampaignId !== null;

  function update<K extends keyof CampaignFormValues>(
    key: K,
    value: CampaignFormValues[K],
  ) {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  function toggleId(key: "vendorRetailerIds" | "groupIds" | "productIds", id: string, on: boolean) {
    setValues((previous) => {
      const set = new Set(previous[key]);
      if (on) set.add(id);
      else set.delete(id);
      return { ...previous, [key]: Array.from(set) };
    });
  }

  const canAdvance = isStepComplete(values, step.key);
  const isLastStep = stepIndex === WIZARD_STEPS.length - 1;

  const selectedRetailers = new Set(values.vendorRetailerIds);
  const selectedGroups = new Set(values.groupIds);
  const selectedProducts = new Set(values.productIds);

  const conflicts = (preview ?? []).filter((row) => row.missingProductCount > 0);

  return (
    <form action={formAction} className="mt-8">
      {mode === "edit" && campaignId !== undefined && (
        // A canonical ADDRESS the server re-validates against the Vendor it derives from
        // auth.uid() — never a capability, and never rendered as text.
        <input type="hidden" name="campaignId" value={campaignId} />
      )}

      {/* Every step's fields are always mounted, so a value entered on step 2 is still in
          the FormData when the operator submits from step 6. Steps are shown and hidden,
          never mounted and unmounted. */}
      <ol
        className="flex flex-wrap gap-2"
        aria-label={`Step ${stepIndex + 1} of ${WIZARD_STEPS.length}: ${step.title}`}
      >
        {WIZARD_STEPS.map((wizardStep, index) => {
          const done = index < stepIndex && isStepComplete(values, wizardStep.key);
          const current = index === stepIndex;
          return (
            <li key={wizardStep.key}>
              <button
                type="button"
                onClick={() => setStepIndex(index)}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2",
                  current
                    ? "bg-indigo-600 text-white ring-indigo-600"
                    : done
                      ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                      : "bg-white text-slate-500 ring-slate-200 hover:bg-slate-50",
                )}
              >
                {done && <CheckIcon className="h-3 w-3" aria-hidden="true" />}
                <span aria-hidden="true">{index + 1}.</span>
                {wizardStep.title}
              </button>
            </li>
          );
        })}
      </ol>

      {state.formError && (
        <Alert tone="error" role="alert" className="mt-6">
          {state.formError}
        </Alert>
      )}
      {state.successMessage && (
        <Alert tone="success" className="mt-6">
          {state.successMessage}
        </Alert>
      )}

      <div className={cardClasses("standard", "mt-6 p-5 sm:p-6")}>
        <h2 className="text-base font-semibold text-slate-900">{step.title}</h2>

        {/* ---- Step 1: details ---- */}
        <div className={cn("mt-5 space-y-5", step.key !== "details" && "hidden")}>
          <Field
            label="Campaign name"
            htmlFor={`${fieldId}-name`}
            hint="Retailers and their Sales Staff will see this."
            error={currentErrors.name}
          >
            <input
              id={`${fieldId}-name`}
              name="name"
              value={values.name}
              onChange={(event) => update("name", event.target.value)}
              maxLength={150}
              required
              aria-invalid={currentErrors.name !== undefined}
              className={inputClasses}
            />
          </Field>
          <Field
            label="Description"
            htmlFor={`${fieldId}-description`}
            hint="Optional. Explain the offer in a sentence or two."
            error={currentErrors.description}
          >
            <textarea
              id={`${fieldId}-description`}
              name="description"
              value={values.description}
              onChange={(event) => update("description", event.target.value)}
              maxLength={2000}
              rows={3}
              className={inputClasses}
            />
          </Field>
        </div>

        {/* ---- Step 2: audience ---- */}
        <div className={cn("mt-5 space-y-5", step.key !== "audience" && "hidden")}>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">
              Which Retailers does this apply to?
            </legend>
            {AUDIENCE_MODES.map((option) => (
              <ChoiceCard
                key={option}
                name="audienceMode"
                value={option}
                checked={values.audienceMode === option}
                title={audienceLabel(option)}
                description={
                  option === "ALL_RETAILERS"
                    ? "Every Retailer connected to you when the campaign is published."
                    : option === "SELECTED_RETAILERS"
                      ? "Choose Retailers individually."
                      : "Choose reusable groups. Editing a group later does not change a published campaign."
                }
                onChange={(value) => update("audienceMode", value)}
              />
            ))}
          </fieldset>

          {values.audienceMode === "SELECTED_RETAILERS" && (
            <Field
              label="Retailers"
              htmlFor={`${fieldId}-retailers`}
              error={currentErrors.vendorRetailerIds}
            >
              <MultiSelect
                name="vendorRetailerIds"
                options={retailers.map((retailer) => ({
                  id: retailer.vendorRetailerId,
                  primary: retailer.retailerName,
                  secondary: null,
                  isSelectable: retailer.isSelectable,
                  note: retailer.statusNote,
                }))}
                selected={selectedRetailers}
                onToggle={(id, on) => toggleId("vendorRetailerIds", id, on)}
                emptyMessage="You have no connected Retailers yet."
                searchLabel="Search Retailers"
                disabled={pending || committed}
              />
            </Field>
          )}

          {values.audienceMode === "RETAILER_GROUPS" && (
            <Field
              label="Retailer groups"
              htmlFor={`${fieldId}-groups`}
              error={currentErrors.groupIds}
            >
              <MultiSelect
                name="groupIds"
                options={groups.map((group) => ({
                  id: group.groupId,
                  primary: group.name,
                  secondary: `${group.memberCount} ${group.memberCount === 1 ? "Retailer" : "Retailers"}`,
                  isSelectable: group.isSelectable,
                  note: group.isSelectable ? null : "Archived",
                }))}
                selected={selectedGroups}
                onToggle={(id, on) => toggleId("groupIds", id, on)}
                emptyMessage="You have no Retailer groups yet. Create one first."
                searchLabel="Search groups"
                disabled={pending || committed}
              />
            </Field>
          )}
        </div>

        {/* ---- Step 3: products ---- */}
        <div className={cn("mt-5 space-y-5", step.key !== "products" && "hidden")}>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">
              Which products count towards this campaign?
            </legend>
            {PRODUCT_SCOPES.map((option) => (
              <ChoiceCard
                key={option}
                name="productScope"
                value={option}
                checked={values.productScope === option}
                title={productScopeLabel(option)}
                description={
                  option === "ALL_ELIGIBLE_PRODUCTS"
                    ? "Whatever each Retailer is actively assigned, resolved as sales happen."
                    : "Choose products. A product not assigned to a Retailer is excluded for that Retailer."
                }
                onChange={(value) => update("productScope", value)}
              />
            ))}
          </fieldset>

          {values.productScope === "SELECTED_PRODUCTS" && (
            <Field
              label="Products"
              htmlFor={`${fieldId}-products`}
              error={currentErrors.productIds}
            >
              <MultiSelect
                name="productIds"
                options={products.map((product) => ({
                  id: product.productId,
                  primary: product.productName,
                  secondary: product.brand
                    ? `${product.productCode} · ${product.brand}`
                    : product.productCode,
                  isSelectable: product.isSelectable,
                  note: product.isSelectable ? null : "Inactive — will be excluded",
                }))}
                selected={selectedProducts}
                onToggle={(id, on) => toggleId("productIds", id, on)}
                emptyMessage="Your catalog has no products yet."
                searchLabel="Search products"
                disabled={pending || committed}
              />
            </Field>
          )}

          {/* The conflicts the requirement asks to be shown BEFORE publication. Only
              available for a SAVED draft — a new campaign has no version to resolve
              against yet, and inventing a client-side answer would be a second copy of
              the resolution rule. */}
          {conflicts.length > 0 && (
            <Alert tone="warning" title="Some Retailers are missing selected products">
              <ul className="mt-1 space-y-0.5 text-sm">
                {conflicts.map((row) => (
                  <li key={row.vendorRetailerId}>
                    {row.retailerName} holds {row.eligibleProductCount} of the selected
                    products — {row.missingProductCount} not assigned.
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm">
                Publishing will include only the products actually assigned to each
                Retailer. Assign the rest, or narrow the selection.
              </p>
            </Alert>
          )}
        </div>

        {/* ---- Step 4: performance and reward ---- */}
        <div className={cn("mt-5 space-y-5", step.key !== "reward" && "hidden")}>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">
              How is performance measured?
            </legend>
            {PERFORMANCE_SCOPES.map((option) => (
              <ChoiceCard
                key={option}
                name="performanceScope"
                value={option}
                checked={values.performanceScope === option}
                title={performanceLabel(option)}
                description={performanceExplanation(option)}
                onChange={(value) => update("performanceScope", value)}
              />
            ))}
          </fieldset>

          {values.performanceScope === "RETAILER_TEAM" && (
            <Alert tone="info">
              Each targeted Retailer gets its own separate total. Sales from different
              Retailers are never combined. Rewards will go to the contributing Sales
              Staff when the calculation engine is connected.
            </Alert>
          )}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">Reward type</legend>
            {RULE_TYPES.map((option) => (
              <ChoiceCard
                key={option}
                name="ruleType"
                value={option}
                checked={values.ruleType === option}
                title={option === "PER_UNIT_COINS" ? "Coins per unit" : "Target bonus"}
                description={
                  option === "PER_UNIT_COINS"
                    ? "A fixed number of coins for every eligible unit sold."
                    : "A one-off bonus once a unit target is reached."
                }
                onChange={(value) => update("ruleType", value)}
              />
            ))}
          </fieldset>

          {values.ruleType === "PER_UNIT_COINS" ? (
            <Field
              label="Coins per unit"
              htmlFor={`${fieldId}-coins`}
              hint="Whole coins. Never a fraction."
              error={currentErrors.coinsPerUnit}
            >
              <input
                id={`${fieldId}-coins`}
                name="coinsPerUnit"
                inputMode="numeric"
                pattern="[0-9]*"
                value={values.coinsPerUnit}
                onChange={(event) => update("coinsPerUnit", event.target.value)}
                aria-invalid={currentErrors.coinsPerUnit !== undefined}
                className={inputClasses}
              />
            </Field>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Unit target"
                htmlFor={`${fieldId}-target`}
                error={currentErrors.thresholdUnits}
              >
                <input
                  id={`${fieldId}-target`}
                  name="thresholdUnits"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={values.thresholdUnits}
                  onChange={(event) => update("thresholdUnits", event.target.value)}
                  aria-invalid={currentErrors.thresholdUnits !== undefined}
                  className={inputClasses}
                />
              </Field>
              <Field
                label="Bonus coins"
                htmlFor={`${fieldId}-bonus`}
                error={currentErrors.rewardCoins}
              >
                <input
                  id={`${fieldId}-bonus`}
                  name="rewardCoins"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={values.rewardCoins}
                  onChange={(event) => update("rewardCoins", event.target.value)}
                  aria-invalid={currentErrors.rewardCoins !== undefined}
                  className={inputClasses}
                />
              </Field>
            </div>
          )}

          <Field
            label="Maximum coins for the campaign"
            htmlFor={`${fieldId}-cap`}
            hint="Optional. Leave blank for no cap."
            error={currentErrors.maxRewardCoins}
          >
            <input
              id={`${fieldId}-cap`}
              name="maxRewardCoins"
              inputMode="numeric"
              pattern="[0-9]*"
              value={values.maxRewardCoins}
              onChange={(event) => update("maxRewardCoins", event.target.value)}
              aria-invalid={currentErrors.maxRewardCoins !== undefined}
              className={inputClasses}
            />
          </Field>
        </div>

        {/* ---- Step 5: schedule and stacking ---- */}
        <div className={cn("mt-5 space-y-5", step.key !== "schedule" && "hidden")}>
          <Field
            label="Campaign time zone"
            htmlFor={`${fieldId}-zone`}
            hint="Start and end times are read in this zone, for everyone."
            error={currentErrors.timezoneName}
          >
            <select
              id={`${fieldId}-zone`}
              name="timezoneName"
              value={values.timezoneName}
              onChange={(event) => update("timezoneName", event.target.value)}
              aria-invalid={currentErrors.timezoneName !== undefined}
              className={inputClasses}
            >
              <option value="">Choose a time zone…</option>
              {timeZones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Starts"
              htmlFor={`${fieldId}-starts`}
              error={currentErrors.startsAt}
            >
              <input
                id={`${fieldId}-starts`}
                name="startsAt"
                type="datetime-local"
                value={values.startsAt}
                onChange={(event) => update("startsAt", event.target.value)}
                aria-invalid={currentErrors.startsAt !== undefined}
                className={inputClasses}
              />
            </Field>
            <Field
              label="Ends"
              htmlFor={`${fieldId}-ends`}
              hint="Leave blank for an evergreen campaign."
              error={currentErrors.endsAt}
            >
              <input
                id={`${fieldId}-ends`}
                name="endsAt"
                type="datetime-local"
                value={values.endsAt}
                onChange={(event) => update("endsAt", event.target.value)}
                aria-invalid={currentErrors.endsAt !== undefined}
                className={inputClasses}
              />
            </Field>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">
              Does this campaign combine with others?
            </legend>
            {STACKING_MODES.map((option) => (
              <ChoiceCard
                key={option}
                name="stackingMode"
                value={option}
                checked={values.stackingMode === option}
                title={stackingLabel(option)}
                description={stackingExplanation(option)}
                onChange={(value) => update("stackingMode", value)}
              />
            ))}
          </fieldset>

          {values.stackingMode === "EXCLUSIVE" && (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Exclusivity key"
                htmlFor={`${fieldId}-key`}
                hint="Exclusive campaigns sharing a key compete; the highest priority wins."
                error={currentErrors.exclusivityKey}
              >
                <input
                  id={`${fieldId}-key`}
                  name="exclusivityKey"
                  value={values.exclusivityKey}
                  onChange={(event) => update("exclusivityKey", event.target.value)}
                  maxLength={64}
                  aria-invalid={currentErrors.exclusivityKey !== undefined}
                  className={inputClasses}
                />
              </Field>
              <Field
                label="Priority"
                htmlFor={`${fieldId}-priority`}
                hint="0 to 1000. Higher wins."
                error={currentErrors.priority}
              >
                <input
                  id={`${fieldId}-priority`}
                  name="priority"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={values.priority}
                  onChange={(event) => update("priority", event.target.value)}
                  aria-invalid={currentErrors.priority !== undefined}
                  className={inputClasses}
                />
              </Field>
            </div>
          )}
          {values.stackingMode !== "EXCLUSIVE" && (
            // Still submitted, so switching back and forth cannot lose the value; the
            // database forces it to NULL for a stackable campaign regardless.
            <>
              <input type="hidden" name="exclusivityKey" value={values.exclusivityKey} />
              <input type="hidden" name="priority" value={values.priority} />
            </>
          )}
        </div>

        {/* ---- Step 6: review ---- */}
        <div className={cn("mt-5 space-y-5", step.key !== "review" && "hidden")}>
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Name</dt>
              <dd className="mt-0.5 text-sm text-slate-800">{values.name || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Audience</dt>
              <dd className="mt-0.5 text-sm text-slate-800">
                {values.audienceMode === "ALL_RETAILERS"
                  ? "All Retailers"
                  : values.audienceMode === "SELECTED_RETAILERS"
                    ? `${values.vendorRetailerIds.length} selected Retailers`
                    : `${values.groupIds.length} Retailer groups`}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Measured</dt>
              <dd className="mt-0.5 text-sm text-slate-800">
                {values.performanceScope === "RETAILER_TEAM"
                  ? "Retailer team — each Retailer has its own total"
                  : "Individual Sales Staff"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Products</dt>
              <dd className="mt-0.5 text-sm text-slate-800">
                {values.productScope === "ALL_ELIGIBLE_PRODUCTS"
                  ? "All eligible products"
                  : `${values.productIds.length} selected products`}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Reward</dt>
              <dd className="mt-0.5 text-sm text-slate-800">
                {rewardSummary({
                  ruleType: values.ruleType === "TARGET_BONUS" ? "TARGET_BONUS" : "PER_UNIT_COINS",
                  coinsPerUnit: Number(values.coinsPerUnit) || null,
                  thresholdUnits: Number(values.thresholdUnits) || null,
                  rewardCoins: Number(values.rewardCoins) || null,
                  maxRewardCoins: Number(values.maxRewardCoins) || null,
                }) ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Schedule</dt>
              <dd className="mt-0.5 text-sm text-slate-800">
                {values.startsAt || "—"}
                {values.endsAt ? ` → ${values.endsAt}` : " → no end date"}
                {values.timezoneName ? ` (${values.timezoneName})` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-400">Stacking</dt>
              <dd className="mt-0.5 text-sm text-slate-800">
                {stackingLabel(
                  values.stackingMode === "EXCLUSIVE" ? "EXCLUSIVE" : "STACKABLE",
                )}
                {values.stackingMode === "EXCLUSIVE" && values.exclusivityKey
                  ? ` · ${values.exclusivityKey} · priority ${values.priority || "0"}`
                  : ""}
              </dd>
            </div>
          </dl>

          {!validation.ok && (
            <Alert tone="warning" title="Some steps are incomplete">
              Go back and fix the highlighted fields before saving.
            </Alert>
          )}

          {preview !== null && preview.length > 0 && (
            <div className={cardClasses("muted", "p-4")}>
              <h3 className="text-sm font-semibold text-slate-800">
                If published now, this campaign would reach {preview.length}{" "}
                {preview.length === 1 ? "Retailer" : "Retailers"}
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-slate-600">
                {preview.map((row) => (
                  <li key={row.vendorRetailerId}>
                    {row.retailerName}
                    {values.productScope === "SELECTED_PRODUCTS" &&
                      ` — ${row.eligibleProductCount} eligible products`}
                    {row.missingProductCount > 0 && (
                      <span className="ml-1 font-medium text-amber-700">
                        ({row.missingProductCount} not assigned)
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Alert tone="info">
            Saving stores this as a draft. Nothing is visible to a Retailer until you
            publish it from the campaign page, and results and coin calculations will
            appear when the calculation engine is connected.
          </Alert>
        </div>
      </div>

      {/* Footer */}
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="outline"
          onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
          disabled={stepIndex === 0 || pending}
        >
          Back
        </Button>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
          {!optionsReady && (
            <span className="text-xs font-medium text-amber-700" role="status">
              Some options could not be loaded. Refresh before saving.
            </span>
          )}

          {committed ? (
            // Save is not offered again after a committed write: an ordinary retry must
            // never silently create a second campaign or resubmit a change already made.
            <Link
              href={`/campaigns/${state.savedCampaignId}`}
              className={buttonClasses({ variant: "primary" })}
            >
              Review and publish
            </Link>
          ) : isLastStep ? (
            <Button
              type="submit"
              variant="primary"
              disabled={!validation.ok || !optionsReady || pending}
              loading={pending}
              loadingLabel="Saving…"
            >
              Save draft
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              onClick={() =>
                setStepIndex((index) => Math.min(WIZARD_STEPS.length - 1, index + 1))
              }
              disabled={!canAdvance || pending}
            >
              Next
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
