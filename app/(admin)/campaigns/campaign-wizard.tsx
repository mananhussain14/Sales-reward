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
  performancePlainLabel,
  productResolutionExplanation,
  productResolutionLabel,
  productScopeLabel,
  productScopePlainLabel,
  rewardPreviewSentence,
  ruleTypeExplanation,
  ruleTypeLabel,
  stackingExplanation,
  stackingLabel,
  AUDIENCE_MODES,
  MAX_CAMPAIGN_COINS,
  PERFORMANCE_SCOPES,
  PRODUCT_SCOPES,
  RETAILER_TEAM_INDEPENDENCE,
  RULE_TYPES,
  STACKING_MODES,
} from "@/lib/campaigns/campaign-vocabulary";
import type { CampaignFormState } from "@/app/(admin)/campaigns/campaign-action-state";
import { INITIAL_CAMPAIGN_FORM_STATE } from "@/app/(admin)/campaigns/campaign-action-state";
import type { PublicationPreviewRow } from "@/lib/campaigns/campaign-normalization";
import {
  campaignStepStatuses,
  needsAttention,
  REVIEW_STEP_INDEX,
} from "@/lib/campaigns/campaign-step-state";
import { ChoiceCard, ChoiceCardGroup } from "@/components/campaigns/choice-cards";
import { EntityPicker } from "@/components/campaigns/entity-picker";
import { WizardStepper } from "@/components/campaigns/wizard-stepper";
import {
  CampaignSummaryPanel,
  ReviewFact,
  ReviewSection,
  type SummaryRow,
} from "@/components/campaigns/campaign-summary";
import { EligibilityPanel } from "@/components/campaigns/eligibility-panel";
import { CalculationEngineNotice } from "@/components/campaigns/campaign-facts";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { cardClasses } from "@/components/ui/card";
import { cn } from "@/components/ui/cn";
import {
  Field,
  inputClasses,
  selectClasses,
  textareaClasses,
  SelectChevron,
} from "@/components/ui/field";
import {
  CampaignsIcon,
  GroupsIcon,
  ProductsIcon,
  RetailersIcon,
  RewardIcon,
  StoreIcon,
  TrendingUpIcon,
  UsersIcon,
} from "@/components/ui/icons";

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
 * The final step is titled "Review and save" and says so plainly.
 *
 * ============================================================================
 * LAYOUT
 * ============================================================================
 * Three columns at `xl` — a step rail, the step itself, and a live summary; two at `lg`
 * with the summary beneath; one below that, with the rail collapsing to a fixed-height
 * "Step X of 6" header and the summary to a closed `<details>`. Nothing wraps at any
 * width, which is what the previous row-of-pills could not promise.
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

/** The icon that introduces each audience option. */
const AUDIENCE_ICONS: Record<string, React.ReactNode> = {
  ALL_RETAILERS: <RetailersIcon className="h-4 w-4" />,
  SELECTED_RETAILERS: <StoreIcon className="h-4 w-4" />,
  RETAILER_GROUPS: <GroupsIcon className="h-4 w-4" />,
};

/**
 * Parses a form string to a whole number for the PREVIEW ONLY.
 *
 * The authoritative parse is validateCampaignForm / toCampaignRpcArgs; this exists so the
 * preview sentence can show nothing rather than "NaN coins" while a field is half typed.
 */
function toNumberOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
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

  /**
   * Which steps the operator has actually opened.
   *
   * WHY THIS EXISTS. `audienceMode` and `productScope` start on a legal default, so
   * "produces no validation error" is true for those steps before anyone has seen them.
   * Reading completion from validity alone therefore reported "Complete" on an untouched
   * form — the defect this correction fixes. Visiting is a separate fact and is tracked
   * separately.
   *
   * EDIT MODE STARTS FULLY VISITED. A saved draft's every step was configured by whoever
   * wrote it, so presenting them as "Not started" would misdescribe work already done.
   * Their validity is still recomputed, so a step that has since become invalid shows
   * "Needs attention" rather than "Complete".
   */
  const [visited, setVisited] = useState<ReadonlySet<number>>(() =>
    mode === "edit"
      ? new Set(WIZARD_STEPS.map((_, index) => index))
      : new Set([0]),
  );

  function goToStep(index: number) {
    const next = Math.min(Math.max(index, 0), WIZARD_STEPS.length - 1);
    setStepIndex(next);
    setVisited((previous) =>
      previous.has(next) ? previous : new Set(previous).add(next),
    );
  }

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

  function toggleId(
    key: "vendorRetailerIds" | "groupIds" | "productIds",
    id: string,
    on: boolean,
  ) {
    setValues((previous) => {
      const set = new Set(previous[key]);
      if (on) set.add(id);
      else set.delete(id);
      return { ...previous, [key]: Array.from(set) };
    });
  }

  const canAdvance = isStepComplete(values, step.key);
  const isLastStep = stepIndex === WIZARD_STEPS.length - 1;
  const locked = pending || committed;

  const selectedRetailers = new Set(values.vendorRetailerIds);
  const selectedGroups = new Set(values.groupIds);
  const selectedProducts = new Set(values.productIds);

  const previewRows = preview ?? [];

  /**
   * Whether the chosen audience currently resolves to nobody.
   *
   * Only RETAILER_GROUPS can do this while still passing every field rule: an operator
   * may legitimately select a group that happens to have no Retailers in it. Publication
   * refuses such a campaign, so the audience step must not read "Complete" first. Group
   * membership counts are data the pure validator does not hold, which is why this is
   * computed here and passed in.
   */
  const audienceResolvesToNoRetailer =
    values.audienceMode === "RETAILER_GROUPS" &&
    values.groupIds.length > 0 &&
    values.groupIds.every(
      (id) => groups.find((group) => group.groupId === id)?.memberCount === 0,
    );

  // ONE computation, read by the desktop rail, the mobile header, the summary badge and
  // the review step — so no two of them can describe the same step differently.
  const stepStatuses = campaignStepStatuses({
    values,
    activeIndex: stepIndex,
    visited,
    saved: committed,
    audienceResolvesToNoRetailer,
  });

  const reviewStatus = stepStatuses[REVIEW_STEP_INDEX];
  const stepsNeedingAttention = WIZARD_STEPS.map((step, index) => ({ step, index }))
    .filter(({ index }) => needsAttention(stepStatuses[index]))
    .map(({ step, index }) => ({ title: step.title, index }));

  /* -------------------------------------------------------------------------
   * Display strings for the summary and review, derived ONCE so the panel beside
   * the form and the review step can never describe the campaign differently.
   * ---------------------------------------------------------------------- */

  const audienceText = useMemo(() => {
    if (values.audienceMode === "ALL_RETAILERS") return audienceLabel("ALL_RETAILERS");
    if (values.audienceMode === "SELECTED_RETAILERS") {
      const count = values.vendorRetailerIds.length;
      if (count === 0) return null;
      return `${count} selected ${count === 1 ? "Retailer" : "Retailers"}`;
    }
    const count = values.groupIds.length;
    if (count === 0) return null;
    return `${count} Retailer ${count === 1 ? "group" : "groups"}`;
  }, [values.audienceMode, values.vendorRetailerIds.length, values.groupIds.length]);

  const productText = useMemo(() => {
    if (values.productScope === "ALL_ELIGIBLE_PRODUCTS") {
      return productScopeLabel("ALL_ELIGIBLE_PRODUCTS");
    }
    const count = values.productIds.length;
    if (count === 0) return null;
    return `${count} selected ${count === 1 ? "product" : "products"}`;
  }, [values.productScope, values.productIds.length]);

  const resolution =
    values.productScope === "SELECTED_PRODUCTS" ? "SNAPSHOT" : "LIVE_TEMPORAL";

  const rewardPreview = rewardPreviewSentence({
    ruleType: values.ruleType === "TARGET_BONUS" ? "TARGET_BONUS" : "PER_UNIT_COINS",
    performanceScope:
      values.performanceScope === "RETAILER_TEAM" ? "RETAILER_TEAM" : "INDIVIDUAL_STAFF",
    coinsPerUnit: toNumberOrNull(values.coinsPerUnit),
    thresholdUnits: toNumberOrNull(values.thresholdUnits),
    rewardCoins: toNumberOrNull(values.rewardCoins),
    maxRewardCoins: toNumberOrNull(values.maxRewardCoins),
  });

  const scheduleText = useMemo(() => {
    if (values.startsAt.length === 0 || values.timezoneName.length === 0) return null;
    const start = values.startsAt.replace("T", " ");
    const end =
      values.endsAt.length === 0 ? "no end date" : values.endsAt.replace("T", " ");
    return `${start} → ${end}`;
  }, [values.startsAt, values.endsAt, values.timezoneName]);

  const stackingText =
    values.stackingMode === "EXCLUSIVE"
      ? values.exclusivityKey.trim().length === 0
        ? null
        : `${stackingLabel("EXCLUSIVE")} · ${values.exclusivityKey.trim()}`
      : stackingLabel("STACKABLE");

  /**
   * A row shows a DEFAULT the operator has not reached yet when its owning step has not
   * been visited. Such a row still displays its value — that is genuinely what the
   * campaign currently says — but is marked, and does not count towards progress. Without
   * this, an untouched form reported four of seven details "complete" purely because
   * three enums start on a legal value.
   */
  const unconfirmed = (ownerStep: number) => stepStatuses[ownerStep] === "NOT_STARTED";

  const summaryRows: SummaryRow[] = [
    { key: "name", label: "Name", value: values.name.trim() || null },
    {
      key: "audience",
      label: "Audience",
      value: audienceText,
      unconfirmed: unconfirmed(1),
    },
    {
      key: "products",
      label: "Products",
      value: productText,
      detail: productText === null ? null : productResolutionLabel(resolution),
      unconfirmed: unconfirmed(2),
    },
    {
      key: "performance",
      label: "Measured",
      value: performancePlainLabel(
        values.performanceScope === "RETAILER_TEAM"
          ? "RETAILER_TEAM"
          : "INDIVIDUAL_STAFF",
      ),
      unconfirmed: unconfirmed(3),
    },
    { key: "reward", label: "Reward", value: rewardPreview },
    {
      key: "schedule",
      label: "Schedule",
      value: scheduleText,
      detail: values.timezoneName || null,
    },
    {
      key: "stacking",
      label: "Stacking",
      value: stackingText,
      unconfirmed: unconfirmed(4),
    },
  ];

  /* ---------------------------------------------------------------------- */

  const stepBody = cardClasses("standard", "p-5 sm:p-6");

  return (
    <form action={formAction} className="mt-6">
      {mode === "edit" && campaignId !== undefined && (
        // A canonical ADDRESS the server re-validates against the Vendor it derives from
        // auth.uid() — never a capability, and never rendered as text.
        <input type="hidden" name="campaignId" value={campaignId} />
      )}

      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[13rem_minmax(0,1fr)_17rem]">
        {/* ---- Column 1: the step rail (or, narrow, the compact header) ---- */}
        <div className="order-1 lg:col-start-1 lg:row-start-1 lg:sticky lg:top-6 lg:self-start">
          <WizardStepper
            steps={WIZARD_STEPS}
            statuses={stepStatuses}
            activeIndex={stepIndex}
            onSelect={goToStep}
          />
        </div>

        {/* ---- Column 3 (or, narrow, second): the live summary ---- */}
        <CampaignSummaryPanel
          className="order-2 lg:col-start-2 lg:row-start-2 xl:col-start-3 xl:row-start-1"
          rows={summaryRows}
        />

        {/* ---- Column 2: the step ---- */}
        <div className="order-3 min-w-0 lg:col-start-2 lg:row-start-1">
          {state.formError && (
            <Alert tone="error" role="alert" className="mb-4">
              {state.formError}
            </Alert>
          )}
          {state.successMessage && (
            <Alert tone="success" className="mb-4">
              {state.successMessage}
            </Alert>
          )}

          {/* The step's own title and explanation. Hidden below `lg`, where the compact
              stepper header already shows both — printing them twice on a phone would
              waste the space the redesign is trying to recover. */}
          <div className="hidden lg:block">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900">
              {step.title}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">{step.summary}</p>
          </div>

          {/* Every step's fields are always mounted, so a value entered on step 2 is still
              in the FormData when the operator submits from step 6. Steps are shown and
              hidden, never mounted and unmounted. */}

          {/* ---- Step 1: details ---- */}
          <div className={cn(stepBody, "mt-4 space-y-5", step.key !== "details" && "hidden")}>
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
                placeholder="Summer bonus on skincare"
                aria-invalid={currentErrors.name !== undefined}
                className={inputClasses(currentErrors.name !== undefined)}
              />
            </Field>

            <Field
              label="Description"
              htmlFor={`${fieldId}-description`}
              optional
              hint="Explain the offer in a sentence or two. This is what a Retailer reads first."
              error={currentErrors.description}
            >
              <textarea
                id={`${fieldId}-description`}
                name="description"
                value={values.description}
                onChange={(event) => update("description", event.target.value)}
                maxLength={2000}
                rows={3}
                className={textareaClasses(currentErrors.description !== undefined)}
              />
            </Field>
          </div>

          {/* ---- Step 2: audience ---- */}
          <div className={cn(stepBody, "mt-4 space-y-5", step.key !== "audience" && "hidden")}>
            <ChoiceCardGroup legend="Which Retailers does this apply to?">
              {AUDIENCE_MODES.map((option) => (
                <ChoiceCard
                  key={option}
                  name="audienceMode"
                  value={option}
                  checked={values.audienceMode === option}
                  title={audienceLabel(option)}
                  icon={AUDIENCE_ICONS[option]}
                  description={
                    option === "ALL_RETAILERS"
                      ? "Every Retailer connected to you at the moment you publish. Retailers you connect later are not added to a published version."
                      : option === "SELECTED_RETAILERS"
                        ? "Pick Retailers individually. Best for a small or one-off audience."
                        : "Pick reusable groups you have already built. Editing a group later never changes a campaign already published through it."
                  }
                  footnote={
                    option === values.audienceMode
                      ? "Publication freezes the eligible Retailers for this version. Later changes need a new version."
                      : undefined
                  }
                  disabled={locked}
                  onChange={(value) => update("audienceMode", value)}
                />
              ))}
            </ChoiceCardGroup>

            {values.audienceMode === "SELECTED_RETAILERS" && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-800">Retailers</p>
                <EntityPicker
                  name="vendorRetailerIds"
                  label="Retailers for this campaign"
                  noun="Retailer"
                  options={retailers.map((retailer) => ({
                    id: retailer.vendorRetailerId,
                    primary: retailer.retailerName,
                    secondary: null,
                    isSelectable: retailer.isSelectable,
                    note: retailer.statusNote,
                  }))}
                  selected={selectedRetailers}
                  onToggle={(id, on) => toggleId("vendorRetailerIds", id, on)}
                  onClear={() => update("vendorRetailerIds", [])}
                  emptyMessage="You have no connected Retailers yet. Connect one before targeting a campaign."
                  searchLabel="Search Retailers"
                  disabled={locked}
                  invalid={currentErrors.vendorRetailerIds !== undefined}
                />
                {currentErrors.vendorRetailerIds && (
                  <p role="alert" className="text-sm font-medium text-red-700">
                    {currentErrors.vendorRetailerIds}
                  </p>
                )}
              </div>
            )}

            {values.audienceMode === "RETAILER_GROUPS" && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-slate-800">Retailer groups</p>
                  <Link
                    href="/campaigns/groups"
                    className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    Manage groups
                  </Link>
                </div>
                <EntityPicker
                  name="groupIds"
                  label="Retailer groups for this campaign"
                  noun="group"
                  options={groups.map((group) => ({
                    id: group.groupId,
                    primary: group.name,
                    secondary: `${group.memberCount} ${group.memberCount === 1 ? "Retailer" : "Retailers"}`,
                    isSelectable: group.isSelectable,
                    // An empty group resolves to nobody, which the operator must see
                    // BEFORE publication refuses the campaign for having no audience.
                    note: !group.isSelectable
                      ? "Archived"
                      : group.memberCount === 0
                        ? "Empty — adds no Retailer"
                        : null,
                  }))}
                  selected={selectedGroups}
                  onToggle={(id, on) => toggleId("groupIds", id, on)}
                  onClear={() => update("groupIds", [])}
                  emptyMessage="You have no Retailer groups yet. Create one first, then choose it here."
                  searchLabel="Search groups"
                  disabled={locked}
                  invalid={currentErrors.groupIds !== undefined}
                />
                {currentErrors.groupIds && (
                  <p role="alert" className="text-sm font-medium text-red-700">
                    {currentErrors.groupIds}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* ---- Step 3: products ---- */}
          <div className={cn(stepBody, "mt-4 space-y-5", step.key !== "products" && "hidden")}>
            <ChoiceCardGroup legend="Which products count towards this campaign?">
              {PRODUCT_SCOPES.map((option) => (
                <ChoiceCard
                  key={option}
                  name="productScope"
                  value={option}
                  checked={values.productScope === option}
                  title={productScopePlainLabel(option)}
                  icon={<ProductsIcon className="h-4 w-4" />}
                  description={productResolutionExplanation(
                    option === "SELECTED_PRODUCTS" ? "SNAPSHOT" : "LIVE_TEMPORAL",
                  )}
                  disabled={locked}
                  onChange={(value) => update("productScope", value)}
                />
              ))}
            </ChoiceCardGroup>

            {values.productScope === "SELECTED_PRODUCTS" && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-800">Products</p>
                <EntityPicker
                  name="productIds"
                  label="Products for this campaign"
                  noun="product"
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
                  onClear={() => update("productIds", [])}
                  emptyMessage="Your catalog has no products yet."
                  searchLabel="Search products"
                  disabled={locked}
                  invalid={currentErrors.productIds !== undefined}
                />
                {currentErrors.productIds && (
                  <p role="alert" className="text-sm font-medium text-red-700">
                    {currentErrors.productIds}
                  </p>
                )}
              </div>
            )}

            {/* The real coverage answer, from the server. Only available for a SAVED
                draft — a new campaign has no version to resolve against yet, and
                inventing a client-side answer would be a second copy of the rule. */}
            {previewRows.length > 0 && (
              <EligibilityPanel
                rows={previewRows}
                productScope={
                  values.productScope === "SELECTED_PRODUCTS"
                    ? "SELECTED_PRODUCTS"
                    : "ALL_ELIGIBLE_PRODUCTS"
                }
                selectedProductCount={values.productIds.length}
                onChangeAudience={() => goToStep(1)}
              />
            )}
          </div>

          {/* ---- Step 4: performance and reward ---- */}
          <div className={cn(stepBody, "mt-4 space-y-6", step.key !== "reward" && "hidden")}>
            <ChoiceCardGroup legend="How is performance measured?">
              {PERFORMANCE_SCOPES.map((option) => (
                <ChoiceCard
                  key={option}
                  name="performanceScope"
                  value={option}
                  checked={values.performanceScope === option}
                  title={performancePlainLabel(option)}
                  icon={
                    option === "RETAILER_TEAM" ? (
                      <UsersIcon className="h-4 w-4" />
                    ) : (
                      <TrendingUpIcon className="h-4 w-4" />
                    )
                  }
                  description={performanceExplanation(option)}
                  // The misreading a team campaign invites, answered at the point of
                  // choosing rather than in a notice further down the page.
                  footnote={
                    option === "RETAILER_TEAM" && values.performanceScope === option
                      ? RETAILER_TEAM_INDEPENDENCE
                      : undefined
                  }
                  disabled={locked}
                  onChange={(value) => update("performanceScope", value)}
                />
              ))}
            </ChoiceCardGroup>

            <ChoiceCardGroup legend="What does it earn?" columns={2}>
              {RULE_TYPES.map((option) => (
                <ChoiceCard
                  key={option}
                  name="ruleType"
                  value={option}
                  checked={values.ruleType === option}
                  title={ruleTypeLabel(option)}
                  icon={<RewardIcon className="h-4 w-4" />}
                  description={ruleTypeExplanation(option)}
                  disabled={locked}
                  onChange={(value) => update("ruleType", value)}
                />
              ))}
            </ChoiceCardGroup>

            {values.ruleType === "PER_UNIT_COINS" ? (
              <Field
                label="Coins per eligible unit"
                htmlFor={`${fieldId}-coins`}
                hint={`Whole coins, 1 to ${MAX_CAMPAIGN_COINS.toLocaleString("en-GB")}. Never a fraction.`}
                error={currentErrors.coinsPerUnit}
              >
                <input
                  id={`${fieldId}-coins`}
                  name="coinsPerUnit"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  min={1}
                  max={MAX_CAMPAIGN_COINS}
                  value={values.coinsPerUnit}
                  onChange={(event) => update("coinsPerUnit", event.target.value)}
                  aria-invalid={currentErrors.coinsPerUnit !== undefined}
                  className={inputClasses(
                    currentErrors.coinsPerUnit !== undefined,
                    "sm:max-w-xs",
                  )}
                />
              </Field>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  label="Unit target"
                  htmlFor={`${fieldId}-target`}
                  hint="Eligible units needed before the bonus applies."
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
                    className={inputClasses(currentErrors.thresholdUnits !== undefined)}
                  />
                </Field>
                <Field
                  label="Bonus coins"
                  htmlFor={`${fieldId}-bonus`}
                  hint="Awarded once the target is reached."
                  error={currentErrors.rewardCoins}
                >
                  <input
                    id={`${fieldId}-bonus`}
                    name="rewardCoins"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    min={1}
                    max={MAX_CAMPAIGN_COINS}
                    value={values.rewardCoins}
                    onChange={(event) => update("rewardCoins", event.target.value)}
                    aria-invalid={currentErrors.rewardCoins !== undefined}
                    className={inputClasses(currentErrors.rewardCoins !== undefined)}
                  />
                </Field>
              </div>
            )}

            <Field
              label="Maximum coins for the campaign"
              htmlFor={`${fieldId}-cap`}
              optional
              hint="Leave blank for no cap."
              error={currentErrors.maxRewardCoins}
            >
              <input
                id={`${fieldId}-cap`}
                name="maxRewardCoins"
                inputMode="numeric"
                pattern="[0-9]*"
                min={1}
                max={MAX_CAMPAIGN_COINS}
                value={values.maxRewardCoins}
                onChange={(event) => update("maxRewardCoins", event.target.value)}
                aria-invalid={currentErrors.maxRewardCoins !== undefined}
                className={inputClasses(
                  currentErrors.maxRewardCoins !== undefined,
                  "sm:max-w-xs",
                )}
              />
            </Field>

            {/* The reward read back as a sentence — the check an operator actually makes.
                It formats the configured numbers and computes nothing. */}
            <div
              className={cn(
                "rounded-xl border p-4",
                rewardPreview
                  ? "border-indigo-200 bg-indigo-50/60"
                  : "border-dashed border-slate-300 bg-slate-50",
              )}
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                What this offers
              </p>
              <p
                aria-live="polite"
                className={cn(
                  "mt-1 text-sm leading-relaxed",
                  rewardPreview ? "font-medium text-indigo-950" : "text-slate-500",
                )}
              >
                {rewardPreview ??
                  "Fill in the reward above and the offer will be written out here."}
              </p>
            </div>

            <CalculationEngineNotice />
          </div>

          {/* ---- Step 5: schedule and stacking ---- */}
          <div className={cn(stepBody, "mt-4 space-y-6", step.key !== "schedule" && "hidden")}>
            <Field
              label="Campaign time zone"
              htmlFor={`${fieldId}-zone`}
              hint="Start and end times are read in this zone, for everyone who sees the campaign."
              error={currentErrors.timezoneName}
            >
              <div className="relative sm:max-w-sm">
                <select
                  id={`${fieldId}-zone`}
                  name="timezoneName"
                  value={values.timezoneName}
                  onChange={(event) => update("timezoneName", event.target.value)}
                  aria-invalid={currentErrors.timezoneName !== undefined}
                  className={selectClasses(currentErrors.timezoneName !== undefined)}
                >
                  <option value="">Choose a time zone…</option>
                  {timeZones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
                <SelectChevron />
              </div>
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Starts"
                htmlFor={`${fieldId}-starts`}
                hint={
                  values.timezoneName
                    ? `Read in ${values.timezoneName}.`
                    : "Choose a time zone first."
                }
                error={currentErrors.startsAt}
              >
                <input
                  id={`${fieldId}-starts`}
                  name="startsAt"
                  type="datetime-local"
                  value={values.startsAt}
                  onChange={(event) => update("startsAt", event.target.value)}
                  aria-invalid={currentErrors.startsAt !== undefined}
                  className={inputClasses(currentErrors.startsAt !== undefined)}
                />
              </Field>
              <Field
                label="Ends"
                htmlFor={`${fieldId}-ends`}
                optional
                hint="Leave blank to run with no end date."
                error={currentErrors.endsAt}
              >
                <input
                  id={`${fieldId}-ends`}
                  name="endsAt"
                  type="datetime-local"
                  value={values.endsAt}
                  onChange={(event) => update("endsAt", event.target.value)}
                  aria-invalid={currentErrors.endsAt !== undefined}
                  className={inputClasses(currentErrors.endsAt !== undefined)}
                />
              </Field>
            </div>

            {/* The schedule read back in one line, including the evergreen case. */}
            <p
              aria-live="polite"
              className="rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700"
            >
              {scheduleText === null ? (
                <span className="text-slate-500">
                  Choose a time zone and a start to see the schedule written out.
                </span>
              ) : (
                <>
                  Runs from <strong className="font-semibold">{scheduleText}</strong>
                  {values.timezoneName && ` (${values.timezoneName})`}
                  {values.endsAt.length === 0 && " — it will keep running until you end it."}
                </>
              )}
            </p>

            <ChoiceCardGroup
              legend="Does this campaign combine with others?"
              columns={2}
            >
              {STACKING_MODES.map((option) => (
                <ChoiceCard
                  key={option}
                  name="stackingMode"
                  value={option}
                  checked={values.stackingMode === option}
                  title={stackingLabel(option)}
                  icon={<CampaignsIcon className="h-4 w-4" />}
                  description={
                    option === "STACKABLE"
                      ? "May reward alongside other eligible campaigns."
                      : "Competes with other campaigns using the same exclusivity key. The highest priority wins."
                  }
                  disabled={locked}
                  onChange={(value) => update("stackingMode", value)}
                />
              ))}
            </ChoiceCardGroup>

            {values.stackingMode === "EXCLUSIVE" ? (
              <div className="grid gap-5 rounded-xl border border-slate-200 bg-slate-50/70 p-4 sm:grid-cols-2">
                <Field
                  label="Exclusivity key"
                  htmlFor={`${fieldId}-key`}
                  hint="Exclusive campaigns sharing a key compete with each other."
                  error={currentErrors.exclusivityKey}
                >
                  <input
                    id={`${fieldId}-key`}
                    name="exclusivityKey"
                    value={values.exclusivityKey}
                    onChange={(event) => update("exclusivityKey", event.target.value)}
                    maxLength={64}
                    placeholder="SKINCARE Q3"
                    aria-invalid={currentErrors.exclusivityKey !== undefined}
                    className={inputClasses(currentErrors.exclusivityKey !== undefined)}
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
                    className={inputClasses(currentErrors.priority !== undefined)}
                  />
                </Field>
              </div>
            ) : (
              <>
                {/* Still submitted, so toggling back to Exclusive does not lose what was
                    typed — and `priority` is validated in both modes, so it must travel.
                    But the previous UI left a typed key sitting invisibly in the form
                    while the database discarded it, which is exactly the silent staleness
                    the requirement calls out. It is now stated. */}
                <input type="hidden" name="exclusivityKey" value={values.exclusivityKey} />
                <input type="hidden" name="priority" value={values.priority} />
                {values.exclusivityKey.trim().length > 0 && (
                  <div className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5">
                    <p className="text-xs leading-relaxed text-slate-600">
                      A stackable campaign has no exclusivity key.{" "}
                      <span className="font-medium text-slate-800">
                        “{values.exclusivityKey.trim()}”
                      </span>{" "}
                      is kept here in case you switch back to Exclusive, but it is{" "}
                      <strong className="font-semibold">not saved</strong> with this
                      campaign.
                    </p>
                    <button
                      type="button"
                      onClick={() => update("exclusivityKey", "")}
                      className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-200 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    >
                      Discard
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ---- Step 6: review ---- */}
          <div className={cn("mt-4 space-y-4", step.key !== "review" && "hidden")}>
            <div className="grid gap-3 sm:grid-cols-2">
              <ReviewSection
                title="Campaign"
                onEdit={() => goToStep(0)}
                editLabel="Edit"
                incomplete={values.name.trim().length === 0}
                incompleteMessage="A campaign name is required."
              >
                <ReviewFact label="Name">{values.name.trim() || "Not set"}</ReviewFact>
                {values.description.trim().length > 0 && (
                  <ReviewFact label="Description">
                    {values.description.trim()}
                  </ReviewFact>
                )}
              </ReviewSection>

              <ReviewSection
                title="Audience"
                onEdit={() => goToStep(1)}
                editLabel="Edit"
                incomplete={audienceText === null}
                incompleteMessage="Choose at least one Retailer or group."
              >
                <ReviewFact label="Reaches">
                  {audienceText ?? "Nothing selected"}
                </ReviewFact>
                <ReviewFact label="At publication">
                  Eligible Retailers are frozen for this version.
                </ReviewFact>
              </ReviewSection>

              <ReviewSection
                title="Products"
                onEdit={() => goToStep(2)}
                editLabel="Edit"
                incomplete={productText === null}
                incompleteMessage="Select at least one product."
              >
                <ReviewFact label="Covers">
                  {productText ?? "Nothing selected"}
                </ReviewFact>
                <ReviewFact label="Resolved">
                  {productResolutionLabel(resolution)}
                </ReviewFact>
              </ReviewSection>

              <ReviewSection
                title="Performance and reward"
                onEdit={() => goToStep(3)}
                editLabel="Edit"
                incomplete={rewardPreview === null}
                incompleteMessage="Complete the reward values."
              >
                <ReviewFact label="Measured">
                  {performancePlainLabel(
                    values.performanceScope === "RETAILER_TEAM"
                      ? "RETAILER_TEAM"
                      : "INDIVIDUAL_STAFF",
                  )}
                </ReviewFact>
                <ReviewFact label="Offers">
                  {rewardPreview ?? "Not set"}
                </ReviewFact>
              </ReviewSection>

              <ReviewSection
                title="Schedule"
                onEdit={() => goToStep(4)}
                editLabel="Edit"
                incomplete={scheduleText === null}
                incompleteMessage="Choose a time zone and a start."
              >
                <ReviewFact label="Runs">{scheduleText ?? "Not set"}</ReviewFact>
                {values.timezoneName && (
                  <ReviewFact label="Time zone">{values.timezoneName}</ReviewFact>
                )}
              </ReviewSection>

              <ReviewSection
                title="Stacking"
                onEdit={() => goToStep(4)}
                editLabel="Edit"
                incomplete={stackingText === null}
                incompleteMessage="An exclusive campaign needs a key."
              >
                <ReviewFact label="Mode">
                  {stackingText ?? "Exclusive, key missing"}
                </ReviewFact>
                <ReviewFact label="Meaning">
                  {stackingExplanation(
                    values.stackingMode === "EXCLUSIVE" ? "EXCLUSIVE" : "STACKABLE",
                  )}
                </ReviewFact>
              </ReviewSection>
            </div>

            {previewRows.length > 0 && (
              <EligibilityPanel
                rows={previewRows}
                productScope={
                  values.productScope === "SELECTED_PRODUCTS"
                    ? "SELECTED_PRODUCTS"
                    : "ALL_ELIGIBLE_PRODUCTS"
                }
                selectedProductCount={values.productIds.length}
                onReviewProducts={() => goToStep(2)}
                onChangeAudience={() => goToStep(1)}
              />
            )}

            {/* THE READINESS ANSWER, stated once and in words.
                `Save draft` is gated on the WHOLE form because create_vendor_campaign_draft
                requires every field — so an incomplete campaign is genuinely not saveable,
                and saying "can be saved as a draft" here would be untrue. */}
            {reviewStatus === "READY_TO_SAVE" ? (
              <Alert tone="success" title="Ready to save">
                Every step is complete. Saving stores this as a draft — it is not
                published, and no Retailer can see it yet.
              </Alert>
            ) : reviewStatus === "COMPLETE" ? (
              <Alert tone="success" title="Draft saved">
                This campaign has been saved as a draft. Open it to publish when you are
                ready.
              </Alert>
            ) : (
              <Alert tone="warning" title="Not ready to save yet">
                <p>
                  This draft cannot be saved until every step is complete. Publishing is a
                  separate step afterwards, and needs the same values.
                </p>
                {stepsNeedingAttention.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {stepsNeedingAttention.map((entry) => (
                      <li key={entry.index}>
                        <button
                          type="button"
                          onClick={() => goToStep(entry.index)}
                          className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-semibold text-amber-900 transition-colors hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
                        >
                          Fix {entry.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {/* A step never opened is not "wrong" — it simply has not been done, and
                    saying so avoids implying the operator made a mistake. */}
                {stepsNeedingAttention.length === 0 && (
                  <p className="mt-2 text-sm">
                    Use the Edit links above, or the step list, to finish the remaining
                    steps.
                  </p>
                )}
              </Alert>
            )}

            {/* The distinction the requirement asks to be explicit: what saving does, and
                what it does not do. */}
            <div className={cardClasses("muted", "p-4")}>
              <p className="text-sm font-semibold text-slate-800">
                Saving does not publish
              </p>
              <p className="mt-1 text-sm leading-relaxed text-slate-600">
                This is stored as a draft. Nothing is visible to a Retailer until you
                publish it from the campaign&apos;s own page, where publication is
                confirmed separately and freezes this version&apos;s configuration and
                eligibility.
              </p>
              <CalculationEngineNotice className="mt-3 bg-white" />
            </div>
          </div>

          {/* ---- Footer: consistent position at every step ---- */}
          <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => goToStep(stepIndex - 1)}
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
                // Save is not offered again after a committed write: an ordinary retry
                // must never silently create a second campaign or resubmit a change
                // already made.
                <Link
                  href={`/campaigns/${state.savedCampaignId}`}
                  className={buttonClasses({ variant: "primary" })}
                >
                  Open campaign
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
                  onClick={() => goToStep(stepIndex + 1)}
                  disabled={!canAdvance || pending}
                >
                  Continue
                </Button>
              )}
            </div>
          </div>

          {/* Why "Continue" is unavailable, stated rather than left to a greyed button. */}
          {!isLastStep && !canAdvance && (
            <p className="mt-2 text-right text-xs text-slate-500" role="status">
              Complete this step to continue.
            </p>
          )}
        </div>
      </div>
    </form>
  );
}
