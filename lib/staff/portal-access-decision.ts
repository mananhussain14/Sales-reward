/**
 * PURE MODULE — no imports, no I/O, no `next/headers`, no Supabase client.
 *
 * The precedence logic for "which Retailer portal experience does this caller get?",
 * and for "which sections of the staff page render?", separated from the resolvers
 * that fetch authorization so it can be unit-tested directly (see
 * ./portal-access-decision.test.ts). The server-only wiring that calls the real
 * resolvers lives in ./retailer-staff-access.ts, which imports `next/headers`
 * transitively and therefore cannot be imported into a test.
 *
 * This mirrors lib/auth/landing-decision.ts exactly, and for the same reason: a branchy
 * policy belongs in a pure function, and the module that performs I/O should only feed
 * it verified facts.
 *
 * THESE FUNCTIONS MAKE NO AUTHORIZATION DECISION OF THEIR OWN. They take only the
 * STATUS discriminants that two already-authorized database reads produced — never an
 * organization, retailer, membership, role, or permission id, and never a role NAME.
 * There is no role string anywhere in this file, deliberately: "owner" and "reader"
 * below describe which READ succeeded, not who the caller claims to be. A change to
 * the role-permission mapping in SQL therefore changes what people see without this
 * file being edited.
 */

/**
 * The Retailer Owner resolver's four states. It distinguishes an operational failure
 * ("unavailable") from an authorization denial ("unauthorized"), and this decision
 * preserves that distinction rather than collapsing one into the other.
 */
export type OwnerAccessStatus =
  | "authorized"
  | "unauthenticated"
  | "unauthorized"
  | "unavailable";

/**
 * The staff roster read's three states. `denied` means the caller holds no
 * RETAILER_STAFF_READ mapping for a single qualifying Retailer — a Sales Staff member
 * lands here, as does anyone outside the Retailer entirely.
 */
export type RosterReadStatus = "ok" | "denied" | "unavailable";

/**
 * The assigned-receipt-shop read's three states. `denied` means the caller holds no
 * RECEIPT_SUBMIT mapping for a single qualifying Retailer. That permission is mapped to
 * SALES_STAFF alone, so a Retailer Owner and a Retailer Manager both land here — which
 * is why neither can reach the submission experience.
 *
 * `ok` includes the zero-shops case: a Sales Staff member with no live assignment is
 * authorized but has nothing to submit against, and the page tells them so rather than
 * refusing them.
 */
export type SubmitterReadStatus = "ok" | "denied" | "unavailable";

/**
 * The outcome.
 *
 *   owner           the full portal: overview, shops, staff roster, invitations, and
 *                   the invite / resend / revoke controls.
 *   reader          the staff roster only.
 *   submitter       receipt submission and personal history only.
 *   unauthenticated no verified session.
 *   unauthorized    a verified identity that qualifies for neither.
 *   unavailable     a read failed. NOT a denial, and never presented as one.
 */
export type PortalAccessDecision =
  | { kind: "owner" }
  | { kind: "reader" }
  | { kind: "submitter" }
  | { kind: "unauthenticated" }
  | { kind: "unauthorized" }
  | { kind: "unavailable" };

/**
 * Whether the roster read is worth issuing at all, given the owner result.
 *
 * It is not, in exactly two cases: the caller is already an authorized owner (the
 * roster is read later, by the page, for its own sake), or there is no verified
 * session at all (both reads consult the same token, so the roster cannot answer
 * differently). Skipping it there avoids a round trip that could not change anything.
 */
export function shouldProbeRoster(owner: OwnerAccessStatus): boolean {
  return owner !== "authorized" && owner !== "unauthenticated";
}

/**
 * Whether the assigned-shop read is worth issuing, given the two earlier results.
 *
 * Only when the roster did not already authorize the caller. A Retailer Manager is
 * settled by the roster read, so their receipt probe is skipped — which matters beyond
 * saving a round trip: it means the Manager path never calls a Sales-Staff-only RPC at
 * all.
 */
export function shouldProbeSubmitter(
  owner: OwnerAccessStatus,
  roster: RosterReadStatus,
): boolean {
  return shouldProbeRoster(owner) && roster !== "ok";
}

/**
 * Resolve the portal decision from the two read statuses.
 *
 * OWNER-FIRST PRECEDENCE:
 *   1. owner authorized      -> the full portal. A person who is both an owner and
 *                               (somehow) a roster reader keeps the owner experience.
 *   2. owner unauthenticated -> unauthenticated. No session means no session.
 *   3. otherwise             -> consult the roster read:
 *        ok            -> reader
 *        unavailable   -> unavailable (the roster read itself broke)
 *        denied        -> consult the assigned-shop read:
 *          ok          -> submitter
 *          unavailable -> unavailable
 *          denied      -> unauthorized, UNLESS the owner read was itself
 *                         "unavailable" — in which case we never actually established
 *                         that they are not an owner, so the honest answer is
 *                         "unavailable". Telling an owner they lack access because of
 *                         a network fault would send them chasing a support ticket for
 *                         something a retry fixes.
 */
export function selectPortalAccess(
  owner: OwnerAccessStatus,
  roster: RosterReadStatus,
  submitter: SubmitterReadStatus,
): PortalAccessDecision {
  if (owner === "authorized") {
    return { kind: "owner" };
  }

  if (owner === "unauthenticated") {
    return { kind: "unauthenticated" };
  }

  if (roster === "ok") {
    return { kind: "reader" };
  }

  if (roster === "unavailable") {
    return { kind: "unavailable" };
  }

  // roster === "denied": not an owner and not a roster reader. The last question is
  // whether they are a Sales Staff member who may submit receipts.
  switch (submitter) {
    case "ok":
      return { kind: "submitter" };
    case "unavailable":
      return { kind: "unavailable" };
    case "denied":
    default:
      return owner === "unavailable"
        ? { kind: "unavailable" }
        : { kind: "unauthorized" };
  }
}

/**
 * The status of one of the staff page's owner-scoped reads
 * (list_retailer_staff_invitations, list_retailer_staff_assignable_shops).
 */
export type SectionReadStatus = "ok" | "denied" | "unavailable";

/**
 * Whether the Invitations section renders at all.
 *
 * A DENIED read hides the section entirely — a Manager is not shown an empty
 * "Invitations" heading, because they have no invitations feature, not zero
 * invitations. An UNAVAILABLE read still renders the section, carrying a retry-safe
 * message: the caller was authorized (the read reached the database and was not
 * refused), so hiding it would misreport a transient fault as a missing capability.
 */
export function showsInvitationSection(status: SectionReadStatus): boolean {
  return status !== "denied";
}

/** Whether the Invite Staff section renders at all. Same rule, same reasoning. */
export function showsInviteSection(status: SectionReadStatus): boolean {
  return status !== "denied";
}

/**
 * Whether the invite FORM itself (as opposed to the section) may be rendered.
 *
 * Only when the assignable-shop read actually succeeded: the form's shop picker is
 * populated exclusively from that result, and rendering it without one would offer a
 * Sales Staff invitation that could never be completed.
 */
export function showsInviteForm(status: SectionReadStatus): boolean {
  return status === "ok";
}
