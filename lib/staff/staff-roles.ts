/**
 * PURE MODULE — no imports, no I/O.
 *
 * The Retailer role vocabulary the staff experience renders and submits.
 *
 * WHY CODES AND NOT UUIDs. Every staff RPC takes a role CODE (
 * reserve_retailer_staff_invitation(p_role_code text)) and returns a role CODE
 * (list_retailer_staff_members, list_retailer_staff_invitations,
 * get_retailer_staff_invitation_for_recipient). No internal role UUID is ever sent to
 * or received from the browser, so there is none here either — the database resolves
 * the code against its own catalogue and is the final authority on whether it is an
 * active, permitted staff role.
 *
 * DISPLAY NAMES ARE PRESENTATION ONLY. They never participate in an authorization
 * decision: the roster and invitation RPCs return the database's own role name where
 * one is available, and these strings are the fallback for rendering a code the UI
 * must label. Nothing branches on them.
 */

/** The two roles a staff invitation may target. Mirrors the database allow-set. */
export const STAFF_INVITABLE_ROLE_CODES = ["RETAILER_MANAGER", "SALES_STAFF"] as const;

export type StaffInvitableRoleCode = (typeof STAFF_INVITABLE_ROLE_CODES)[number];

/**
 * Every Retailer role the roster may show. RETAILER_OWNER appears because the owner
 * is a member of their own Retailer and therefore a roster row; it is NOT invitable
 * and is deliberately absent from STAFF_INVITABLE_ROLE_CODES above.
 */
const RETAILER_ROLE_DISPLAY_NAMES: Record<string, string> = {
  RETAILER_OWNER: "Retailer Owner",
  RETAILER_MANAGER: "Retailer Manager",
  SALES_STAFF: "Sales Staff",
};

/** Whether a value is one of the two invitable staff role codes. */
export function isStaffInvitableRoleCode(
  value: unknown,
): value is StaffInvitableRoleCode {
  return (
    typeof value === "string" &&
    (STAFF_INVITABLE_ROLE_CODES as readonly string[]).includes(value)
  );
}

/**
 * A human label for a role code.
 *
 * An unknown code returns the code itself rather than a guess or an empty string: it
 * is the honest thing to show if the catalogue ever gains a role this build predates,
 * and it never fabricates a name that could misdescribe someone's access.
 */
export function retailerRoleDisplayName(
  roleCode: string,
  providedName?: string | null,
): string {
  if (typeof providedName === "string" && providedName.trim().length > 0) {
    return providedName.trim();
  }
  return RETAILER_ROLE_DISPLAY_NAMES[roleCode] ?? roleCode;
}

/**
 * Whether a role's invitation must carry at least one shop.
 *
 * This mirrors reserve_retailer_staff_invitation's own rule exactly — Sales Staff
 * require at least one shop, Retailer Managers must have none — so the form can guide
 * the operator before submitting. The database re-applies both rules and remains the
 * authority; this is a courtesy check, never the enforcement.
 */
export function roleRequiresShops(roleCode: string): boolean {
  return roleCode === "SALES_STAFF";
}

/** Whether a role's invitation must carry NO shops. The complement of the above. */
export function roleForbidsShops(roleCode: string): boolean {
  return roleCode === "RETAILER_MANAGER";
}
