/**
 * The state shapes the campaign forms and dialogs exchange with their Server Actions.
 *
 * A SEPARATE MODULE from ./actions.ts because that file carries the "use server"
 * directive, under which Next.js requires every runtime export to be an async function.
 * Types are erased, but the constants below are not, so they live here.
 */
import type { CampaignFieldErrors, CampaignFormValues } from "@/lib/campaigns/campaign-input";
import { EMPTY_CAMPAIGN_FORM } from "@/lib/campaigns/campaign-input";

/**
 * The wizard's round-trip state.
 *
 * `values` is echoed back on every outcome so a failed submit never empties the form —
 * an operator who spent six steps configuring a campaign must not lose it to one
 * validation message.
 *
 * `savedCampaignId` is set ONLY after a committed create. It is what stops the wizard
 * offering "Save draft" a second time: a resubmit would create a second campaign, and
 * the database has no way to know the two were meant to be one.
 */
export type CampaignFormState = {
  fieldErrors: CampaignFieldErrors;
  formError: string | null;
  successMessage: string | null;
  values: CampaignFormValues;
  savedCampaignId: string | null;
};

export const INITIAL_CAMPAIGN_FORM_STATE: CampaignFormState = {
  fieldErrors: {},
  formError: null,
  successMessage: null,
  values: EMPTY_CAMPAIGN_FORM,
  savedCampaignId: null,
};

/**
 * The state of a single-button control — publish, pause, resume, cancel, new version.
 *
 * `committed` is deliberately distinct from `success`. A committed operation hides its
 * own button so an ordinary retry cannot resubmit something that has already happened,
 * and a no-op (publishing twice, pausing something already paused) is reported as its own
 * outcome rather than as a success that changed nothing.
 */
export type CampaignActionState = {
  error: string | null;
  success: string | null;
  /** True once the operation has committed, whether or not it changed anything. */
  committed: boolean;
};

export const INITIAL_CAMPAIGN_ACTION_STATE: CampaignActionState = {
  error: null,
  success: null,
  committed: false,
};

/** The Retailer-group create/rename form. */
export type GroupFormState = {
  fieldErrors: { name?: string; description?: string };
  formError: string | null;
  successMessage: string | null;
  values: { name: string; description: string };
};

export const INITIAL_GROUP_FORM_STATE: GroupFormState = {
  fieldErrors: {},
  formError: null,
  successMessage: null,
  values: { name: "", description: "" },
};

/** The group membership editor. */
export type GroupMembersState = {
  error: string | null;
  success: string | null;
  committed: boolean;
};

export const INITIAL_GROUP_MEMBERS_STATE: GroupMembersState = {
  error: null,
  success: null,
  committed: false,
};
