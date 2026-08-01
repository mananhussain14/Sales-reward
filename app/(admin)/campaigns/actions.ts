"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import {
  createCampaignDraft,
  createCampaignVersion,
  publishCampaign,
  setCampaignLifecycle,
  updateCampaignDraft,
  type CampaignStateRefusal,
} from "@/lib/campaigns/vendor-campaigns";
import {
  createRetailerGroup,
  setRetailerGroupMembers,
  updateRetailerGroup,
} from "@/lib/campaigns/retailer-groups";
import {
  isUuid,
  toCampaignRpcArgs,
  validateCampaignForm,
  validateGroupForm,
  type CampaignFormValues,
} from "@/lib/campaigns/campaign-input";
import type {
  CampaignActionState,
  CampaignFormState,
  GroupFormState,
  GroupMembersState,
} from "@/app/(admin)/campaigns/campaign-action-state";

/**
 * Server Actions for Vendor campaign management.
 *
 * NO TABLE IS WRITTEN HERE. Every effect is delegated to @/lib/campaigns/*, each of which
 * calls exactly one RPC per operation. `.from(` appears nowhere in this module, and no
 * service-role client is constructed anywhere in this feature.
 *
 * A SERVER ACTION IS A PUBLIC ENDPOINT. It is reachable by a hand-crafted POST from any
 * client, regardless of which page rendered the form. So every action re-resolves Vendor
 * Admin access before delegating — and the RPC then re-derives the Vendor from auth.uid()
 * and re-checks CAMPAIGNS_MANAGE or RETAILER_GROUPS_MANAGE, which is what actually stops
 * an unauthorized or cross-Vendor write. Hiding a control removes the accident; only
 * those checks remove the capability.
 *
 * WHAT THE BROWSER MAY INFLUENCE, EXHAUSTIVELY: a campaign's configuration fields, a
 * campaign id, a version id, a group id, and arrays of Retailer-relationship, group and
 * product ids. There is no Vendor organization id, actor id, membership id, role id,
 * permission code, audit value or lifecycle-state-before in any form — the database
 * derives every one of them.
 *
 * NOTHING HERE COMPUTES A REWARD. These actions configure and publish an OFFER. No
 * progress, balance, coin credit, claim or payout is read, written or returned.
 *
 * Because of the "use server" directive, every runtime export here is a callable server
 * endpoint, so Next.js rejects anything that is not an async function. The state types
 * live in ./campaign-action-state.
 */

/** Fixed literals; never interpolated from input. */
const CAMPAIGNS_PATH = "/campaigns";
const GROUPS_PATH = "/campaigns/groups";

/**
 * The one message for every failure that is not a field problem.
 *
 * It covers an unauthorized caller, a campaign id belonging to another Vendor, a foreign
 * Retailer or product id, and a database outage. Collapsing them is deliberate: the RPCs
 * already refuse all of the addressing cases with a single byte-identical exception so
 * they cannot be used as an existence oracle.
 */
const GENERIC_ERROR = "We couldn't complete that. Refresh the page and try again.";

/** Shown when the database rejected a value the form thought was fine. */
const INVALID_ERROR = "Check the campaign details and try again.";

/**
 * Safe, actionable copy for each state refusal the database can raise.
 *
 * Every one describes the CALLER'S OWN campaign — the RPC resolved it against the Vendor
 * derived from auth.uid() before it could refuse on state — so none discloses anything
 * about another tenant. `unknown` degrades to the generic message rather than echoing a
 * database string.
 */
const REFUSAL_COPY: Record<CampaignStateRefusal, string> = {
  cancelled: "This campaign has been cancelled and can no longer be changed.",
  "no-draft":
    "This campaign has no draft to edit. Create a new version to make changes.",
  "already-drafted":
    "This campaign already has a draft version. Edit or publish that one first.",
  "not-published": "Publish this campaign before using that control.",
  "no-eligible-retailer":
    "This campaign doesn't currently apply to any active Retailer. Check the audience and try again.",
  "no-eligible-product":
    "None of the selected products is assigned to an eligible Retailer. Assign them, or change the product selection.",
  "no-rule": "This campaign has no reward rule yet.",
  unknown: GENERIC_ERROR,
};

function readField(formData: FormData, field: string): string {
  const raw = formData.get(field);
  return typeof raw === "string" ? raw : "";
}

function readIds(formData: FormData, field: string): string[] {
  return formData
    .getAll(field)
    .filter((value): value is string => typeof value === "string");
}

/**
 * Re-resolves Vendor Admin access, or redirects.
 *
 * redirect() signals by throwing NEXT_REDIRECT, so calling this outside any try/catch is
 * required — catching it would swallow the navigation.
 */
async function requireVendorAdmin(): Promise<void> {
  const access = await getVendorSuperAdminAccess();
  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }
}

/** Reads the whole wizard out of one FormData. */
function readCampaignForm(formData: FormData): CampaignFormValues {
  return {
    name: readField(formData, "name"),
    description: readField(formData, "description"),
    audienceMode: readField(formData, "audienceMode"),
    vendorRetailerIds: readIds(formData, "vendorRetailerIds"),
    groupIds: readIds(formData, "groupIds"),
    performanceScope: readField(formData, "performanceScope"),
    productScope: readField(formData, "productScope"),
    productIds: readIds(formData, "productIds"),
    ruleType: readField(formData, "ruleType"),
    coinsPerUnit: readField(formData, "coinsPerUnit"),
    thresholdUnits: readField(formData, "thresholdUnits"),
    rewardCoins: readField(formData, "rewardCoins"),
    maxRewardCoins: readField(formData, "maxRewardCoins"),
    timezoneName: readField(formData, "timezoneName"),
    startsAt: readField(formData, "startsAt"),
    endsAt: readField(formData, "endsAt"),
    stackingMode: readField(formData, "stackingMode"),
    exclusivityKey: readField(formData, "exclusivityKey"),
    priority: readField(formData, "priority"),
  };
}

/* ---------------------------------------------------------------------------
 * Draft create and update
 * ------------------------------------------------------------------------- */

/**
 * Saves a NEW campaign draft.
 *
 * It does NOT publish. Publication is a separate, explicit act on the campaign's own
 * page, so no path through this form can make a campaign visible to a Retailer by
 * accident.
 */
export async function createCampaignDraftAction(
  prevState: CampaignFormState,
  formData: FormData,
): Promise<CampaignFormState> {
  const values = readCampaignForm(formData);

  await requireVendorAdmin();

  // ALREADY COMMITTED. A resubmit of a form that has already created a campaign would
  // create a SECOND one, and nothing downstream could tell that the two were meant to be
  // the same. The control is hidden once this is set; this is the server-side half.
  if (prevState.savedCampaignId !== null) {
    return { ...prevState, values };
  }

  const validation = validateCampaignForm(values);
  if (!validation.ok) {
    return {
      fieldErrors: validation.fieldErrors,
      formError: null,
      successMessage: null,
      values,
      savedCampaignId: null,
    };
  }

  const args = toCampaignRpcArgs(validation.values);
  if (args === null) {
    return {
      fieldErrors: {},
      formError: INVALID_ERROR,
      successMessage: null,
      values,
      savedCampaignId: null,
    };
  }

  const result = await createCampaignDraft(args);

  if (result.status === "ok") {
    revalidatePath(CAMPAIGNS_PATH);
    return {
      fieldErrors: {},
      formError: null,
      successMessage: `${validation.values.name} saved as a draft. It is not published yet.`,
      values: validation.values,
      savedCampaignId: result.campaignId ?? null,
    };
  }

  return {
    fieldErrors: {},
    formError:
      result.status === "invalid"
        ? INVALID_ERROR
        : result.status === "not-allowed"
          ? REFUSAL_COPY[result.reason]
          : GENERIC_ERROR,
    successMessage: null,
    values,
    savedCampaignId: null,
  };
}

/** Rewrites an existing campaign's draft version whole. */
export async function updateCampaignDraftAction(
  prevState: CampaignFormState,
  formData: FormData,
): Promise<CampaignFormState> {
  const campaignId = readField(formData, "campaignId").trim().toLowerCase();
  const values = readCampaignForm(formData);

  await requireVendorAdmin();

  if (!isUuid(campaignId)) {
    // Only reachable from a tampered form; reported identically to a foreign id.
    return {
      fieldErrors: {},
      formError: GENERIC_ERROR,
      successMessage: null,
      values,
      savedCampaignId: null,
    };
  }

  const validation = validateCampaignForm(values);
  if (!validation.ok) {
    return {
      fieldErrors: validation.fieldErrors,
      formError: null,
      successMessage: null,
      values,
      savedCampaignId: null,
    };
  }

  const args = toCampaignRpcArgs(validation.values);
  if (args === null) {
    return {
      fieldErrors: {},
      formError: INVALID_ERROR,
      successMessage: null,
      values,
      savedCampaignId: null,
    };
  }

  const result = await updateCampaignDraft(campaignId, args);

  if (result.status === "ok") {
    // CANONICAL REREAD. Both routes are revalidated so the next render comes from the
    // database rather than from the values this form happened to submit.
    revalidatePath(CAMPAIGNS_PATH);
    revalidatePath(`${CAMPAIGNS_PATH}/${campaignId}`);
    revalidatePath(`${CAMPAIGNS_PATH}/${campaignId}/edit`);
    return {
      fieldErrors: {},
      formError: null,
      successMessage: "Draft saved.",
      values: validation.values,
      savedCampaignId: campaignId,
    };
  }

  return {
    fieldErrors: {},
    formError:
      result.status === "invalid"
        ? INVALID_ERROR
        : result.status === "not-allowed"
          ? REFUSAL_COPY[result.reason]
          : GENERIC_ERROR,
    successMessage: null,
    values,
    savedCampaignId: null,
  };
}

/* ---------------------------------------------------------------------------
 * Lifecycle
 * ------------------------------------------------------------------------- */

/**
 * Publishes the campaign's draft version.
 *
 * IDEMPOTENT AT THE DATABASE, and reported honestly here: a second submit returns
 * `published: false`, which becomes a "nothing to publish" notice rather than a success
 * claim or an error. Nothing is retried — the first call already committed.
 */
export async function publishCampaignAction(
  prevState: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  const campaignId = readField(formData, "campaignId").trim().toLowerCase();

  await requireVendorAdmin();

  // A committed submit is never repeated, even if the control reappears somehow.
  if (prevState.committed) {
    return prevState;
  }

  if (!isUuid(campaignId)) {
    return { error: GENERIC_ERROR, success: null, committed: false };
  }

  const result = await publishCampaign(campaignId);

  if (result.status === "ok") {
    revalidatePath(CAMPAIGNS_PATH);
    revalidatePath(`${CAMPAIGNS_PATH}/${campaignId}`);

    if (!result.outcome.published) {
      return {
        error: null,
        success: "This campaign is already published. Nothing was changed.",
        committed: true,
      };
    }

    const retailers = result.outcome.eligibleRetailerCount;
    return {
      error: null,
      success: `Published to ${retailers} ${retailers === 1 ? "Retailer" : "Retailers"}.`,
      committed: true,
    };
  }

  return {
    error:
      result.status === "invalid"
        ? INVALID_ERROR
        : result.status === "not-allowed"
          ? REFUSAL_COPY[result.reason]
          : GENERIC_ERROR,
    success: null,
    committed: false,
  };
}

/**
 * Pauses, resumes or cancels a published campaign.
 *
 * A no-op — pausing something already paused — is reported as its own outcome, because
 * the database wrote nothing and claiming otherwise would be a lie the audit trail
 * contradicts.
 */
export async function setCampaignLifecycleAction(
  prevState: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  const campaignId = readField(formData, "campaignId").trim().toLowerCase();
  const raw = readField(formData, "action").trim().toUpperCase();

  await requireVendorAdmin();

  if (prevState.committed) {
    return prevState;
  }

  // The action is a closed literal set, checked here and again in SQL. A value outside it
  // can only come from a tampered form.
  if (
    !isUuid(campaignId) ||
    (raw !== "PAUSE" && raw !== "RESUME" && raw !== "CANCEL")
  ) {
    return { error: GENERIC_ERROR, success: null, committed: false };
  }

  const result = await setCampaignLifecycle(campaignId, raw);

  if (result.status === "ok") {
    revalidatePath(CAMPAIGNS_PATH);
    revalidatePath(`${CAMPAIGNS_PATH}/${campaignId}`);

    if (!result.outcome.statusChanged) {
      return {
        error: null,
        success: "That change had already been made. Nothing was changed.",
        committed: true,
      };
    }

    const done =
      raw === "PAUSE"
        ? "Campaign paused. It will stop applying to new sales."
        : raw === "RESUME"
          ? "Campaign resumed against its original dates."
          : "Campaign cancelled. This cannot be undone.";

    return { error: null, success: done, committed: true };
  }

  return {
    error:
      result.status === "invalid"
        ? INVALID_ERROR
        : result.status === "not-allowed"
          ? REFUSAL_COPY[result.reason]
          : GENERIC_ERROR,
    success: null,
    committed: false,
  };
}

/**
 * Opens a new editable version by copying the one in force.
 *
 * The published version stays in force and stays visible to Retailers until the new one
 * is published — a material change is prepared alongside the running campaign, never by
 * interrupting it.
 */
export async function createCampaignVersionAction(
  prevState: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  const campaignId = readField(formData, "campaignId").trim().toLowerCase();

  await requireVendorAdmin();

  if (prevState.committed) {
    return prevState;
  }

  if (!isUuid(campaignId)) {
    return { error: GENERIC_ERROR, success: null, committed: false };
  }

  const result = await createCampaignVersion(campaignId);

  if (result.status === "ok") {
    revalidatePath(CAMPAIGNS_PATH);
    revalidatePath(`${CAMPAIGNS_PATH}/${campaignId}`);
    return {
      error: null,
      success:
        "New draft version created. The published version keeps running until you publish this one.",
      committed: true,
    };
  }

  return {
    error:
      result.status === "invalid"
        ? INVALID_ERROR
        : result.status === "not-allowed"
          ? REFUSAL_COPY[result.reason]
          : GENERIC_ERROR,
    success: null,
    committed: false,
  };
}

/* ---------------------------------------------------------------------------
 * Retailer groups
 * ------------------------------------------------------------------------- */

const GROUP_GENERIC_ERROR =
  "We couldn't complete that. Refresh the page and try again.";

export async function createRetailerGroupAction(
  prevState: GroupFormState,
  formData: FormData,
): Promise<GroupFormState> {
  const values = {
    name: readField(formData, "name"),
    description: readField(formData, "description"),
  };
  const requested = readIds(formData, "vendorRetailerIds")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);

  await requireVendorAdmin();

  // Once the group row exists, this action never creates another. The form has already
  // stopped offering the control; this is the second guard, for a hand-crafted resubmit.
  if (prevState.createdGroupId !== null) {
    return prevState;
  }

  const validation = validateGroupForm(values);
  const fieldErrors = { ...validation.ok ? {} : validation.fieldErrors } as
    GroupFormState["fieldErrors"];

  // Ids are checked here so a malformed one cannot reach the second RPC AFTER the group
  // has already been created — the whole point of the pre-flight is that the recoverable
  // failure window stays as small as it can be.
  if (!requested.every(isUuid)) {
    fieldErrors.vendorRetailerIds = "Reload the page and choose the Retailers again.";
  }

  if (Object.keys(fieldErrors).length > 0 || !validation.ok) {
    return {
      fieldErrors,
      formError: null,
      successMessage: null,
      values,
      createdGroupId: null,
      partialWarning: null,
    };
  }

  const result = await createRetailerGroup({
    name: validation.values.name,
    description:
      validation.values.description.length > 0 ? validation.values.description : null,
  });

  if (result.status === "duplicate") {
    // Attached to the field the operator must change. Safe: the unique index is scoped
    // per Vendor, so this describes only their own groups.
    return {
      fieldErrors: { name: "A group with that name already exists." },
      formError: null,
      successMessage: null,
      values,
      createdGroupId: null,
      partialWarning: null,
    };
  }

  if (result.status !== "ok") {
    return {
      fieldErrors: {},
      formError: result.status === "invalid" ? INVALID_ERROR : GROUP_GENERIC_ERROR,
      successMessage: null,
      values,
      createdGroupId: null,
      partialWarning: null,
    };
  }

  const groupId = result.groupId;
  revalidatePath(GROUPS_PATH);

  // The create RPC returns the new id. Without it there is nothing to attach membership
  // to and nowhere to send the operator, so the group is reported as created and the
  // Retailers are left for the group's own page.
  if (groupId === undefined || !isUuid(groupId)) {
    return {
      fieldErrors: {},
      formError: null,
      successMessage: null,
      values,
      createdGroupId: null,
      partialWarning:
        requested.length > 0
          ? `${validation.values.name} was created, but its Retailers could not be attached. Open it from the list below to add them.`
          : `${validation.values.name} was created. Open it from the list below to add Retailers.`,
    };
  }

  // An empty selection is a legitimate advanced choice, and the UI offers it explicitly.
  // Skipping the second call keeps the no-op out of the audit trail entirely.
  if (requested.length === 0) {
    redirect(`${GROUPS_PATH}/${groupId}?created=1`);
  }

  const membership = await setRetailerGroupMembers(groupId, requested);

  if (membership.status === "ok") {
    revalidatePath(GROUPS_PATH);
    revalidatePath(`${GROUPS_PATH}/${groupId}`);
    // The whole task finished, so the operator lands on the group they just built.
    redirect(`${GROUPS_PATH}/${groupId}?created=1`);
  }

  // THE RECOVERABLE OUTCOME. The group exists; its Retailers do not. Reported truthfully,
  // with the id retained so the form can link straight to the editor — and so no retry of
  // this action can create a second group. NOTHING IS RETRIED AUTOMATICALLY.
  return {
    fieldErrors: {},
    formError: null,
    successMessage: null,
    values,
    createdGroupId: groupId,
    partialWarning:
      membership.status === "not-eligible"
        ? `${validation.values.name} was created, but its Retailers were not added: only active Retailers can be in a group. Open the group to choose again.`
        : `${validation.values.name} was created, but its Retailers were not added. Open the group to add them — this did not create a second group.`,
  };
}

export async function updateRetailerGroupAction(
  _prevState: GroupFormState,
  formData: FormData,
): Promise<GroupFormState> {
  const groupId = readField(formData, "groupId").trim().toLowerCase();
  const values = {
    name: readField(formData, "name"),
    description: readField(formData, "description"),
  };
  const rawStatus = readField(formData, "status").trim().toUpperCase();

  await requireVendorAdmin();

  if (!isUuid(groupId)) {
    return {
      fieldErrors: {},
      formError: GROUP_GENERIC_ERROR,
      successMessage: null,
      values,
      createdGroupId: null,
      partialWarning: null,
    };
  }

  const validation = validateGroupForm(values);
  if (!validation.ok) {
    return {
      fieldErrors: validation.fieldErrors,
      formError: null,
      successMessage: null,
      values,
      createdGroupId: null,
      partialWarning: null,
    };
  }

  const status =
    rawStatus === "ACTIVE" || rawStatus === "ARCHIVED" ? rawStatus : null;

  const result = await updateRetailerGroup({
    groupId,
    name: validation.values.name,
    description:
      validation.values.description.length > 0 ? validation.values.description : null,
    status,
  });

  if (result.status === "ok") {
    revalidatePath(GROUPS_PATH);
    revalidatePath(`${GROUPS_PATH}/${groupId}`);
    return {
      fieldErrors: {},
      formError: null,
      successMessage:
        result.changed === false ? "No changes to save." : "Group details saved.",
      values: validation.values,
      createdGroupId: null,
      partialWarning: null,
    };
  }

  if (result.status === "duplicate") {
    return {
      fieldErrors: { name: "A group with that name already exists." },
      formError: null,
      successMessage: null,
      values,
      createdGroupId: null,
      partialWarning: null,
    };
  }

  return {
    fieldErrors: {},
    formError: result.status === "invalid" ? INVALID_ERROR : GROUP_GENERIC_ERROR,
    successMessage: null,
    values,
    createdGroupId: null,
    partialWarning: null,
  };
}

/**
 * ATOMIC REPLACEMENT of a group's live membership.
 *
 * Editing a group NEVER alters a published campaign. Publication copied membership into
 * the eligibility snapshot and does not read the group again; a new campaign version is
 * what picks the change up. The UI says so next to this control.
 */
export async function setRetailerGroupMembersAction(
  prevState: GroupMembersState,
  formData: FormData,
): Promise<GroupMembersState> {
  const groupId = readField(formData, "groupId").trim().toLowerCase();
  const requested = readIds(formData, "vendorRetailerIds")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);

  await requireVendorAdmin();

  if (prevState.committed) {
    return prevState;
  }

  // Every id must be well formed before any of them travels. The database independently
  // refuses an id that is not one of this Vendor's relationships.
  if (!isUuid(groupId) || !requested.every(isUuid)) {
    return { error: GROUP_GENERIC_ERROR, success: null, committed: false };
  }

  const result = await setRetailerGroupMembers(groupId, requested);

  if (result.status === "ok") {
    revalidatePath(GROUPS_PATH);
    revalidatePath(`${GROUPS_PATH}/${groupId}`);

    const outcome = result.outcome;
    if (outcome === undefined) {
      // The write committed but the response could not be read. Reported as a success
      // without counts rather than as a failure — a failure notice here would invite a
      // resubmit of something that has already happened.
      return { error: null, success: "Membership saved.", committed: true };
    }

    if (outcome.membersAdded === 0 && outcome.membersRemoved === 0) {
      return { error: null, success: "No changes to save.", committed: true };
    }

    const parts: string[] = [];
    if (outcome.membersAdded > 0) parts.push(`${outcome.membersAdded} added`);
    if (outcome.membersRemoved > 0) parts.push(`${outcome.membersRemoved} removed`);
    return {
      error: null,
      success: `Membership saved — ${parts.join(", ")}.`,
      committed: true,
    };
  }

  if (result.status === "not-eligible") {
    return {
      error:
        "Only active Retailers can be added to a group. Remove any inactive Retailer from your selection.",
      success: null,
      committed: false,
    };
  }

  return {
    error: result.status === "invalid" ? INVALID_ERROR : GROUP_GENERIC_ERROR,
    success: null,
    committed: false,
  };
}
