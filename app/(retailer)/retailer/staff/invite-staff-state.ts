import type {
  StaffInviteFieldErrors,
  StaffInviteValues,
} from "@/lib/staff/staff-invite-input";

/**
 * Shared state contract for the Invite Staff form.
 *
 * This lives outside actions.ts deliberately. A module with a top-level "use server"
 * directive may only export async functions — every export becomes a callable server
 * endpoint — so exporting a plain object from there is a runtime error.
 *
 * THE BROWSER-VISIBLE SURFACE IS ONLY WHAT IS HERE: field messages, one form message,
 * one success message, and the values the operator typed (echoed back so a rejected
 * submission does not lose their work). There is no invitation id, token, token hash,
 * Auth id, membership id, role id, organization id, or provider detail — none is
 * produced by the action, so there is nothing of that kind to carry.
 *
 * `values.shopIds` DOES carry shop UUIDs, and that is deliberate and bounded: they are
 * the checkboxes the operator ticked, they were rendered from
 * list_retailer_staff_assignable_shops() (which only a RETAILER_STAFF_SHOP_ASSIGN
 * holder can call), and they belong to the caller's own Retailer. Re-checking the
 * boxes on a failed submission is not possible without them.
 */
export type InviteStaffState = {
  fieldErrors: StaffInviteFieldErrors;
  /** A message about the submission as a whole, or null. */
  formError: string | null;
  /** Shown after a successful send, or null. */
  successMessage: string | null;
  values: StaffInviteValues;
};

export const EMPTY_INVITE_STAFF_VALUES: StaffInviteValues = {
  firstName: "",
  lastName: "",
  email: "",
  roleCode: "",
  shopIds: [],
};

export const INITIAL_INVITE_STAFF_STATE: InviteStaffState = {
  fieldErrors: {},
  formError: null,
  successMessage: null,
  values: EMPTY_INVITE_STAFF_VALUES,
};
