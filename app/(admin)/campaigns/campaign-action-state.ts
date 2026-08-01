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

/**
 * The Retailer-group create/rename form.
 *
 * `createdGroupId` and `partialWarning` exist for ONE situation, and it is the reason
 * group creation is worth stating carefully.
 *
 * Creating a group with its Retailers in a single flow is two RPCs —
 * create_vendor_retailer_group, then set_vendor_retailer_group_members — and there is no
 * transaction spanning them, because neither RPC accepts the other's work as an argument.
 * So the group can exist while its membership did not save. That outcome must never be
 * reported as a plain failure: a failure notice invites a retry, and retrying would
 * create a SECOND group with the same intent. It is reported as what it is — the group
 * exists, its Retailers did not save, here is the link to add them — and the create form
 * stops offering to create anything again.
 */
export type GroupFormState = {
  fieldErrors: { name?: string; description?: string; vendorRetailerIds?: string };
  formError: string | null;
  successMessage: string | null;
  values: { name: string; description: string };
  /** Set once the group row exists, whether or not its membership saved. */
  createdGroupId: string | null;
  /** Present only when the group was created but its Retailers were not attached. */
  partialWarning: string | null;
};

export const INITIAL_GROUP_FORM_STATE: GroupFormState = {
  fieldErrors: {},
  formError: null,
  successMessage: null,
  values: { name: "", description: "" },
  createdGroupId: null,
  partialWarning: null,
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
