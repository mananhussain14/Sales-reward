/**
 * PURE MODULE — no imports beyond ./campaign-vocabulary, no I/O, no `next/headers`, no
 * Supabase client. Exercised directly by ./campaign-input.test.ts.
 *
 * Normalization and validation for the campaign wizard's form values.
 *
 * THIS IS NOT THE AUTHORITY, AND MUST NOT BE MISTAKEN FOR IT. Every rule below is
 * enforced again — and independently — by public.campaign_apply_draft_config() and by the
 * CHECK constraints on campaign_versions, campaign_rules and campaign_rule_tiers. What
 * this file buys is a field-level error next to the input that caused it, instead of one
 * form-level message after a round trip. A rule that lived ONLY here would be a rule the
 * Flutter client bypasses, which is exactly the failure mode this project's shared-backend
 * principle exists to prevent.
 *
 * THE TIME ZONE IS CHECKED AGAINST THE RUNTIME'S OWN ZONE DATABASE, not against a list
 * shipped in this file. `Intl.DateTimeFormat` throws for a zone it does not know, so
 * asking it IS the check — and a hard-coded array of IANA names would be a second, staler
 * copy that starts disagreeing the first time a zone is renamed. The DATABASE validates
 * the name again against pg_timezone_names, which is the authority; this only means an
 * operator learns about a bad zone before the round trip rather than after it.
 *
 * WHERE THIS FILE IS DELIBERATELY WEAKER THAN THE DATABASE:
 *   * Retailer, group and product ids are checked for UUID shape only. Whether one
 *     belongs to the calling Vendor is a tenancy question, and answering it in the
 *     browser would be answering it in the wrong place.
 *   * Nothing here checks whether a selected product is actually assigned to an eligible
 *     Retailer. That is resolved at publication and previewed by
 *     preview_vendor_campaign_publication().
 */
import {
  isAudienceMode,
  isPerformanceScope,
  isProductScope,
  isRuleType,
  isStackingMode,
  MAX_CAMPAIGN_COINS,
  MIN_CAMPAIGN_COINS,
  type AudienceMode,
  type PerformanceScope,
  type ProductScope,
  type RuleType,
  type StackingMode,
} from "./campaign-vocabulary.ts";

/**
 * The largest unit target a campaign may configure.
 *
 * campaign_rule_tiers.threshold_units is a PostgreSQL `integer`, so its own ceiling is
 * 2,147,483,647 and this mirrors it. Together with MAX_CAMPAIGN_COINS it is what bounds
 * the future reward engine's rate x quantity arithmetic inside bigint.
 */
export const MAX_UNIT_TARGET = 2_147_483_647;

/** Canonical UUID form: 8-4-4-4-12 hexadecimal, matched case-insensitively. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * The wizard's complete state, as strings — the shape a `<form>` produces and the shape
 * that survives a round trip through a Server Action's previous state.
 *
 * Numbers are strings here on purpose. "" and "abc" are both things an operator can type,
 * and both need a field-level message; coercing early would turn them into 0 and NaN and
 * lose the distinction.
 */
export type CampaignFormValues = {
  name: string;
  description: string;
  audienceMode: string;
  vendorRetailerIds: string[];
  groupIds: string[];
  performanceScope: string;
  productScope: string;
  productIds: string[];
  ruleType: string;
  coinsPerUnit: string;
  thresholdUnits: string;
  rewardCoins: string;
  maxRewardCoins: string;
  timezoneName: string;
  startsAt: string;
  endsAt: string;
  stackingMode: string;
  exclusivityKey: string;
  priority: string;
};

export const EMPTY_CAMPAIGN_FORM: CampaignFormValues = {
  name: "",
  description: "",
  audienceMode: "ALL_RETAILERS",
  vendorRetailerIds: [],
  groupIds: [],
  performanceScope: "INDIVIDUAL_STAFF",
  productScope: "ALL_ELIGIBLE_PRODUCTS",
  productIds: [],
  ruleType: "PER_UNIT_COINS",
  coinsPerUnit: "",
  thresholdUnits: "",
  rewardCoins: "",
  maxRewardCoins: "",
  timezoneName: "",
  startsAt: "",
  endsAt: "",
  stackingMode: "STACKABLE",
  exclusivityKey: "",
  priority: "0",
};

export type CampaignFieldErrors = Partial<Record<keyof CampaignFormValues, string>>;

/**
 * The wizard's six steps. Exported so the progress indicator, the step guard and the
 * validator all agree on what a step IS, rather than three lists drifting apart.
 */
export const WIZARD_STEPS = [
  { key: "details", title: "Campaign details" },
  { key: "audience", title: "Retailer audience" },
  { key: "products", title: "Product eligibility" },
  { key: "reward", title: "Performance and reward" },
  { key: "schedule", title: "Schedule and stacking" },
  { key: "review", title: "Review and publish" },
] as const;

export type WizardStepKey = (typeof WIZARD_STEPS)[number]["key"];

/** Which fields belong to which step, so a step shows only its own errors. */
const STEP_FIELDS: Record<WizardStepKey, (keyof CampaignFormValues)[]> = {
  details: ["name", "description"],
  audience: ["audienceMode", "vendorRetailerIds", "groupIds"],
  products: ["productScope", "productIds"],
  reward: [
    "performanceScope",
    "ruleType",
    "coinsPerUnit",
    "thresholdUnits",
    "rewardCoins",
    "maxRewardCoins",
  ],
  schedule: [
    "timezoneName",
    "startsAt",
    "endsAt",
    "stackingMode",
    "exclusivityKey",
    "priority",
  ],
  review: [],
};

/** Collapses internal whitespace runs, matching what the database stores. */
function collapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function uniqueIds(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const id = raw.trim().toLowerCase();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Normalizes every field the way the database will.
 *
 * Applied BEFORE validation and again before submission, so the value an operator sees
 * echoed back is the value that will be stored — an operator who typed "  Winter   Push "
 * and got "Winter Push" back has been told what happened rather than surprised by it
 * later.
 */
export function normalizeCampaignForm(values: CampaignFormValues): CampaignFormValues {
  return {
    name: collapse(values.name),
    description: values.description.trim(),
    audienceMode: values.audienceMode.trim().toUpperCase(),
    vendorRetailerIds: uniqueIds(values.vendorRetailerIds),
    groupIds: uniqueIds(values.groupIds),
    performanceScope: values.performanceScope.trim().toUpperCase(),
    productScope: values.productScope.trim().toUpperCase(),
    productIds: uniqueIds(values.productIds),
    ruleType: values.ruleType.trim().toUpperCase(),
    coinsPerUnit: values.coinsPerUnit.trim(),
    thresholdUnits: values.thresholdUnits.trim(),
    rewardCoins: values.rewardCoins.trim(),
    maxRewardCoins: values.maxRewardCoins.trim(),
    timezoneName: values.timezoneName.trim(),
    startsAt: values.startsAt.trim(),
    endsAt: values.endsAt.trim(),
    stackingMode: values.stackingMode.trim().toUpperCase(),
    // Normalized exactly as campaign_versions_exclusivity_key_shape requires, so what the
    // operator sees is what decides whether two campaigns compete.
    exclusivityKey: collapse(values.exclusivityKey).toUpperCase(),
    priority: values.priority.trim(),
  };
}

/**
 * Parses a whole number from a form field.
 *
 * Rejects anything that is not digits — "1e3", "1.5", "-5", " 12 " after trimming is
 * fine, "12px" is not. A coin amount that silently became something else would be a
 * promise nobody meant to make.
 */
function parseWholeNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Converts a `datetime-local` value to an ISO instant IN THE CAMPAIGN'S TIME ZONE.
 *
 * `<input type="datetime-local">` yields a WALL-CLOCK string with no zone — "2026-09-01T09:00".
 * Passing it straight to `new Date()` would interpret it in the BROWSER'S zone, so a
 * campaign authored in Dubai by an operator travelling in London would start five hours
 * late. Resolving it against the zone the operator explicitly chose is the only reading
 * that matches what they typed.
 *
 * The offset is found by asking Intl what the chosen zone's local time is for a candidate
 * instant, then correcting. One correction pass is sufficient for every fixed offset and
 * for every DST boundary except the ambiguous hour itself, where either reading is
 * defensible and the earlier is chosen.
 *
 * Returns null when the wall-clock string is malformed or the zone is unknown to this
 * runtime — the caller then reports a field error rather than sending a guess. The
 * DATABASE validates the zone again regardless.
 */
export function wallClockToIso(wallClock: string, timeZone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(wallClock)) return null;
  if (timeZone.length === 0) return null;

  const naive = Date.parse(`${wallClock}Z`);
  if (Number.isNaN(naive)) return null;

  let offset: number;
  try {
    offset = zoneOffsetMs(naive, timeZone);
  } catch {
    return null;
  }

  const corrected = naive - offset;

  // A second pass, in case the first candidate landed on the other side of a DST change.
  let finalOffset: number;
  try {
    finalOffset = zoneOffsetMs(corrected, timeZone);
  } catch {
    return null;
  }

  return new Date(naive - finalOffset).toISOString();
}

/**
 * Whether this runtime's zone database knows the name.
 *
 * `Intl.DateTimeFormat` throws a RangeError for an unrecognized `timeZone`, so asking it
 * IS the check — no list of IANA names is shipped, and nothing here can go stale relative
 * to the platform. The database asks pg_timezone_names independently and is the authority.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC, in milliseconds, at a given instant. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = formatter.formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";

  // Intl renders midnight as hour "24" in some engines; Date.UTC normalizes it.
  const asUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(get("hour")),
    Number(get("minute")),
    Number(get("second")),
  );

  if (Number.isNaN(asUtc)) throw new Error("unformattable");
  return asUtc - instant;
}

/** The reverse: an ISO instant rendered as a `datetime-local` value in a given zone. */
export function isoToWallClock(iso: string, timeZone: string): string {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant) || timeZone.length === 0) return "";

  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = formatter.formatToParts(new Date(instant));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const hour = get("hour") === "24" ? "00" : get("hour");
    return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
  } catch {
    return "";
  }
}

export type CampaignValidation =
  | { ok: true; values: CampaignFormValues }
  | { ok: false; fieldErrors: CampaignFieldErrors };

/**
 * Validates the WHOLE configuration.
 *
 * Whole rather than per-step because the draft is saved whole: the RPC takes one atomic
 * typed contract, so a campaign that is valid at step 4 and invalid at step 5 cannot be
 * persisted at all, and pretending otherwise would let an operator reach the review step
 * believing they were finished.
 *
 * `stepErrors()` below projects the result onto a step, which is how the wizard shows an
 * operator only the problems they can currently see.
 */
export function validateCampaignForm(values: CampaignFormValues): CampaignValidation {
  const v = normalizeCampaignForm(values);
  const errors: CampaignFieldErrors = {};

  // ---- Step 1: details ----
  if (v.name.length === 0) {
    errors.name = "Enter a campaign name.";
  } else if (v.name.length > 150) {
    errors.name = "Keep the name to 150 characters or fewer.";
  }
  if (v.description.length > 2000) {
    errors.description = "Keep the description to 2,000 characters or fewer.";
  }

  // ---- Step 2: audience ----
  if (!isAudienceMode(v.audienceMode)) {
    errors.audienceMode = "Choose who this campaign applies to.";
  } else if (v.audienceMode === "SELECTED_RETAILERS") {
    if (v.vendorRetailerIds.length === 0) {
      errors.vendorRetailerIds = "Select at least one Retailer.";
    } else if (!v.vendorRetailerIds.every(isUuid)) {
      errors.vendorRetailerIds = "That Retailer selection is no longer valid.";
    }
  } else if (v.audienceMode === "RETAILER_GROUPS") {
    if (v.groupIds.length === 0) {
      errors.groupIds = "Select at least one Retailer group.";
    } else if (!v.groupIds.every(isUuid)) {
      errors.groupIds = "That group selection is no longer valid.";
    }
  }

  // ---- Step 3: products ----
  if (!isProductScope(v.productScope)) {
    errors.productScope = "Choose which products are included.";
  } else if (v.productScope === "SELECTED_PRODUCTS") {
    if (v.productIds.length === 0) {
      errors.productIds = "Select at least one product.";
    } else if (!v.productIds.every(isUuid)) {
      errors.productIds = "That product selection is no longer valid.";
    }
  }

  // ---- Step 4: performance and reward ----
  if (!isPerformanceScope(v.performanceScope)) {
    errors.performanceScope = "Choose how performance is measured.";
  }

  // COIN BOUNDS mirror the database exactly: 1 .. MAX_CAMPAIGN_COINS on every configured
  // amount. `parseWholeNumber` already refuses anything beyond Number.MAX_SAFE_INTEGER, so
  // a value that reaches the range check has survived JSON transport exactly; the ceiling
  // then keeps a future rate x quantity inside bigint. See MAX_CAMPAIGN_COINS.
  const coinRangeMessage = `Enter a whole number between ${MIN_CAMPAIGN_COINS} and ${MAX_CAMPAIGN_COINS.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.`;
  const outOfCoinRange = (value: number | null) =>
    value === null || value < MIN_CAMPAIGN_COINS || value > MAX_CAMPAIGN_COINS;

  if (!isRuleType(v.ruleType)) {
    errors.ruleType = "Choose a reward type.";
  } else if (v.ruleType === "PER_UNIT_COINS") {
    if (outOfCoinRange(parseWholeNumber(v.coinsPerUnit))) {
      errors.coinsPerUnit = `Coins per unit. ${coinRangeMessage}`;
    }
  } else {
    const target = parseWholeNumber(v.thresholdUnits);
    if (target === null || target < 1 || target > MAX_UNIT_TARGET) {
      errors.thresholdUnits = `Unit target. Enter a whole number between 1 and ${MAX_UNIT_TARGET.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.`;
    }
    if (outOfCoinRange(parseWholeNumber(v.rewardCoins))) {
      errors.rewardCoins = `Bonus coins. ${coinRangeMessage}`;
    }
  }

  if (v.maxRewardCoins.length > 0) {
    if (outOfCoinRange(parseWholeNumber(v.maxRewardCoins))) {
      errors.maxRewardCoins = `Maximum coins. Leave blank, or ${coinRangeMessage.charAt(0).toLowerCase()}${coinRangeMessage.slice(1)}`;
    }
  }

  // ---- Step 5: schedule and stacking ----
  if (v.timezoneName.length === 0) {
    errors.timezoneName = "Choose the campaign time zone.";
  } else if (v.timezoneName.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(v.timezoneName)) {
    errors.timezoneName = "Choose a valid campaign time zone.";
  } else if (!isKnownTimeZone(v.timezoneName)) {
    // Attributed to the ZONE field rather than to the dates. A well-formed
    // "2026-09-01T09:00" that cannot be resolved is almost always an unknown zone, and
    // reporting it against the start date would send the operator to correct the one
    // field that is not wrong.
    errors.timezoneName = "Choose a valid campaign time zone.";
  }

  if (v.startsAt.length === 0) {
    errors.startsAt = "Enter a start date and time.";
  }

  const startIso =
    v.startsAt.length > 0 && v.timezoneName.length > 0
      ? wallClockToIso(v.startsAt, v.timezoneName)
      : null;

  if (v.startsAt.length > 0 && startIso === null && errors.timezoneName === undefined) {
    errors.startsAt = "Enter a valid start date and time.";
  }

  if (v.endsAt.length > 0) {
    const endIso =
      v.timezoneName.length > 0 ? wallClockToIso(v.endsAt, v.timezoneName) : null;
    if (endIso === null) {
      if (errors.timezoneName === undefined) {
        errors.endsAt = "Enter a valid end date and time.";
      }
    } else if (startIso !== null && Date.parse(endIso) <= Date.parse(startIso)) {
      errors.endsAt = "The end must be after the start.";
    }
  }

  if (!isStackingMode(v.stackingMode)) {
    errors.stackingMode = "Choose whether this campaign stacks with others.";
  } else if (v.stackingMode === "EXCLUSIVE") {
    if (v.exclusivityKey.length === 0) {
      errors.exclusivityKey = "Enter an exclusivity key.";
    } else if (
      v.exclusivityKey.length > 64 ||
      !/^[A-Z0-9][A-Z0-9 ._-]*$/.test(v.exclusivityKey)
    ) {
      errors.exclusivityKey =
        "Use letters, digits, spaces, dots, underscores or hyphens, starting with a letter or digit.";
    }
  }

  const priority = parseWholeNumber(v.priority.length === 0 ? "0" : v.priority);
  if (priority === null || priority > 1000) {
    errors.priority = "Enter a priority between 0 and 1000.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, values: v };
}

/** The subset of a validation's errors that belong to one wizard step. */
export function stepErrors(
  fieldErrors: CampaignFieldErrors,
  step: WizardStepKey,
): CampaignFieldErrors {
  const fields = STEP_FIELDS[step];
  const out: CampaignFieldErrors = {};
  for (const field of fields) {
    const message = fieldErrors[field];
    if (message !== undefined) out[field] = message;
  }
  return out;
}

/** True when a step has no outstanding errors — what gates the "Next" control. */
export function isStepComplete(
  values: CampaignFormValues,
  step: WizardStepKey,
): boolean {
  const result = validateCampaignForm(values);
  if (result.ok) return true;
  return Object.keys(stepErrors(result.fieldErrors, step)).length === 0;
}

/**
 * The arguments for create_vendor_campaign_draft / update_vendor_campaign_draft.
 *
 * Keys are the RPC's own parameter names, so the wrapper does no second mapping and a
 * renamed argument fails to compile rather than silently passing null. Arrays are sent as
 * null when the mode does not use them — the RPC clears them anyway, and sending a
 * selection the campaign will not use invites the belief that it did.
 */
export type CampaignRpcArgs = {
  p_name: string;
  p_description: string | null;
  p_starts_at: string;
  p_ends_at: string | null;
  p_timezone_name: string;
  p_audience_mode: AudienceMode;
  p_performance_scope: PerformanceScope;
  p_product_scope: ProductScope;
  p_stacking_mode: StackingMode;
  p_exclusivity_key: string | null;
  p_priority: number;
  p_rule_type: RuleType;
  p_coins_per_unit: number | null;
  p_threshold_units: number | null;
  p_reward_coins: number | null;
  p_max_reward_coins: number | null;
  p_vendor_retailer_ids: string[] | null;
  p_group_ids: string[] | null;
  p_product_ids: string[] | null;
};

/**
 * Builds the RPC arguments from a form that has ALREADY VALIDATED.
 *
 * Returns null when validation fails, so there is no path from an invalid form to a
 * request: the caller cannot skip the check by calling this directly.
 */
export function toCampaignRpcArgs(values: CampaignFormValues): CampaignRpcArgs | null {
  const result = validateCampaignForm(values);
  if (!result.ok) return null;

  const v = result.values;
  const startsAt = wallClockToIso(v.startsAt, v.timezoneName);
  if (startsAt === null) return null;

  const endsAt = v.endsAt.length > 0 ? wallClockToIso(v.endsAt, v.timezoneName) : null;
  if (v.endsAt.length > 0 && endsAt === null) return null;

  // Narrowed by validateCampaignForm; re-asserted through the guards so the types are
  // proved rather than cast.
  if (
    !isAudienceMode(v.audienceMode) ||
    !isPerformanceScope(v.performanceScope) ||
    !isProductScope(v.productScope) ||
    !isStackingMode(v.stackingMode) ||
    !isRuleType(v.ruleType)
  ) {
    return null;
  }

  const perUnit = v.ruleType === "PER_UNIT_COINS" ? parseWholeNumber(v.coinsPerUnit) : null;
  const threshold =
    v.ruleType === "TARGET_BONUS" ? parseWholeNumber(v.thresholdUnits) : null;
  const bonus = v.ruleType === "TARGET_BONUS" ? parseWholeNumber(v.rewardCoins) : null;
  const cap = v.maxRewardCoins.length > 0 ? parseWholeNumber(v.maxRewardCoins) : null;

  return {
    p_name: v.name,
    p_description: v.description.length > 0 ? v.description : null,
    p_starts_at: startsAt,
    p_ends_at: endsAt,
    p_timezone_name: v.timezoneName,
    p_audience_mode: v.audienceMode,
    p_performance_scope: v.performanceScope,
    p_product_scope: v.productScope,
    p_stacking_mode: v.stackingMode,
    p_exclusivity_key: v.stackingMode === "EXCLUSIVE" ? v.exclusivityKey : null,
    p_priority: parseWholeNumber(v.priority.length === 0 ? "0" : v.priority) ?? 0,
    p_rule_type: v.ruleType,
    p_coins_per_unit: perUnit,
    p_threshold_units: threshold,
    p_reward_coins: bonus,
    p_max_reward_coins: cap,
    p_vendor_retailer_ids:
      v.audienceMode === "SELECTED_RETAILERS" ? v.vendorRetailerIds : null,
    p_group_ids: v.audienceMode === "RETAILER_GROUPS" ? v.groupIds : null,
    p_product_ids: v.productScope === "SELECTED_PRODUCTS" ? v.productIds : null,
  };
}

/* ---------------------------------------------------------------------------
 * Retailer group input
 * ------------------------------------------------------------------------- */

export type GroupFormValues = { name: string; description: string };

export type GroupFieldErrors = Partial<Record<keyof GroupFormValues, string>>;

export function normalizeGroupForm(values: GroupFormValues): GroupFormValues {
  return { name: collapse(values.name), description: values.description.trim() };
}

export type GroupValidation =
  | { ok: true; values: GroupFormValues }
  | { ok: false; fieldErrors: GroupFieldErrors };

export function validateGroupForm(values: GroupFormValues): GroupValidation {
  const v = normalizeGroupForm(values);
  const errors: GroupFieldErrors = {};

  if (v.name.length === 0) {
    errors.name = "Enter a group name.";
  } else if (v.name.length > 120) {
    errors.name = "Keep the name to 120 characters or fewer.";
  }
  if (v.description.length > 500) {
    errors.description = "Keep the description to 500 characters or fewer.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, values: v };
}

/** True when the requested membership differs from what is already stored. */
export function hasMembershipChanged(current: string[], requested: string[]): boolean {
  const a = uniqueIds(current);
  const b = uniqueIds(requested);
  if (a.length !== b.length) return true;
  const set = new Set(a);
  return b.some((id) => !set.has(id));
}
