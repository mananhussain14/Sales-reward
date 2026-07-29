"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { getVendorRetailerDetail } from "@/lib/retailers/vendor-retailer-detail";
import { getVendorRetailerManageCapability } from "@/lib/retailers/vendor-retailer-manage-capability";
import { setVendorRetailerStatus } from "@/lib/retailers/vendor-retailer-lifecycle";
import {
  describeVendorRetailerLifecycleNoChange,
  describeVendorRetailerLifecycleOutcome,
  isConfirmedManageCapability,
  normalizeVendorRetailerRelationshipId,
  normalizeVendorRetailerRequestedStatus,
  validateVendorRetailerLifecycleSubmission,
  validateVendorRetailerLifecycleTransition,
} from "@/lib/retailers/vendor-retailer-lifecycle-input";
import type { RetailerLifecycleState } from "@/app/(admin)/retailers/[relationshipId]/lifecycle-state";

/* ---------------------------------------------------------------------------
 * Operator-facing copy
 * ------------------------------------------------------------------------- */

/**
 * The one message every disclosure-sensitive refusal shares.
 *
 * An unknown relationship, another Vendor's relationship, a relationship whose organization
 * is not a Retailer, a caller who has lost RETAILERS_MANAGE, and a tampered id are ALL
 * reported with this single string. public.set_vendor_retailer_status raises ONE
 * byte-identical 42501 for every one of them precisely so a caller cannot sweep relationship
 * ids to learn which exist. Distinguishing them here would reintroduce exactly the disclosure
 * the SQL went out of its way to prevent.
 */
const LIFECYCLE_DENIED =
  "This action is no longer allowed, or this Retailer record is unavailable. Refresh the page and try again.";

/**
 * 23514 — the requested status was not one this operation accepts. Reachable only from a
 * tampered submission, since the control posts a value this application produced.
 */
const LIFECYCLE_INVALID =
  "That status change isn't valid. Refresh the page and try again.";

/**
 * 55000 — the lifecycle change is unavailable.
 *
 * ============================================================================
 * DELIBERATELY GENERIC, AND THIS ONE MATTERS MOST
 * ============================================================================
 * FOUR different causes arrive here: the two status rows disagree, either row is
 * DEACTIVATED, ANOTHER VENDOR still holds a live relationship with this Retailer, or a
 * compare-and-set row count drifted. The database gives all four one SQLSTATE and one
 * message on purpose — the multi-Vendor case must not disclose that another tenant exists,
 * which Vendor it is, how many there are, or what state their relationship is in.
 *
 * So this sentence says WHAT the operator can act on and nothing about WHY. It must never
 * grow a cause, a count, a row state, or the words "another Vendor".
 */
const LIFECYCLE_RETAILER_UNAVAILABLE =
  "This Retailer's lifecycle status cannot be changed right now. Refresh the page, and contact support if it continues.";

/**
 * The generic service failure. Deliberately explicit that nothing was changed AND that
 * nothing was retried — an administrator who does not know whether a write landed will click
 * again, which is exactly what this wording prevents.
 */
const LIFECYCLE_UNAVAILABLE =
  "The Retailer status could not be changed. Nothing was retried automatically. Please try again in a moment.";

/**
 * THE PARTIAL SUCCESS: the write committed, but the response could not be described or the
 * canonical detail could not be re-read.
 *
 * It is a SUCCESS message and the wording is chosen to stop exactly one reaction —
 * submitting again. Nothing is lost by not retrying: the change is committed, and the RPC is
 * idempotent anyway, so a repeat would be a no-op that writes no audit row. The dialog hides
 * its confirm button on this outcome for the same reason.
 */
const LIFECYCLE_SAVED_UNCONFIRMED =
  "The change may have been saved. Refresh the page to confirm the current Retailer status.";

/* ---------------------------------------------------------------------------
 * The action
 * ------------------------------------------------------------------------- */

/** The detail route this action refreshes. Built from the verified id, never from the form. */
function retailerDetailPath(relationshipId: string): string {
  return `/retailers/${relationshipId}`;
}

function failure(error: string): RetailerLifecycleState {
  return { outcome: "error", error, success: null };
}

/**
 * Deactivates or reactivates one connected Retailer.
 *
 * A SERVER ACTION IS A PUBLIC ENDPOINT — reachable by a hand-crafted POST from any client,
 * regardless of which page rendered the control or whether that page rendered at all. So this
 * re-establishes its own footing exactly as the Add Shop and owner-invitation actions do:
 * Vendor access is re-resolved from the verified session, the caller's RETAILERS_MANAGE
 * capability is re-proved against the database, and the canonical Retailer detail is re-read
 * for THIS caller before a single id is accepted.
 *
 * WHAT THE BROWSER MAY INFLUENCE, EXHAUSTIVELY: one relationship id that must resolve to a
 * Retailer inside the caller's own Vendor context, and one requested status that must be
 * exactly the valid opposite of what the database currently holds. Nothing else is read from
 * the form — no Vendor organization id, Retailer organization id, current status, actor id,
 * role code, permission code, audit metadata or timestamp — and no such field would be
 * honoured if one were posted, because none is read. The RPC accepts only two arguments in
 * any case.
 *
 * THE RELATIONSHIP ID IS AN ADDRESS, NOT AUTHORIZATION. getVendorRetailerDetail() fetches the
 * row under BOTH `id = relationshipId` AND `vendor_organization_id = <the Vendor derived from
 * the verified token>`, so another Vendor's id resolves to `not-found` here — and the RPC
 * applies the same predicate again from auth.uid().
 *
 * THE RETAILER NAME IS DISPLAY ONLY. It is read from the canonical detail purely so the
 * success sentence can name the Retailer the database actually addressed. It is never an
 * input, never compared, and never an authorization fact.
 */
export async function setVendorRetailerStatusAction(
  _prevState: RetailerLifecycleState,
  formData: FormData,
): Promise<RetailerLifecycleState> {
  // 1. Read and canonicalize. ONLY these two fields are read; any other key a tampered POST
  //    carried is never looked at, so it cannot influence anything.
  const relationshipId = normalizeVendorRetailerRelationshipId(
    formData.get("relationshipId"),
  );
  const requestedStatus = normalizeVendorRetailerRequestedStatus(
    formData.get("requestedStatus"),
  );

  // 2. FORMAT validation, before any read. A tampered id or status is refused without the
  //    database being consulted at all, so an unauthorized caller learns nothing about
  //    whether the Retailer exists — not even whether their id was well-formed.
  const submission = validateVendorRetailerLifecycleSubmission(
    relationshipId,
    requestedStatus,
  );

  if (!submission.ok) {
    return failure(
      submission.reason === "invalid-status" ? LIFECYCLE_INVALID : LIFECYCLE_DENIED,
    );
  }

  // 3. Authorization, re-resolved from the verified session. Defence in depth: the RPC
  //    evaluates the same chain again from auth.uid() and is what actually stops an
  //    unauthorized or cross-tenant write.
  //
  //    redirect() signals by throwing NEXT_REDIRECT, so both calls sit outside any
  //    try/catch. A session that has gone away between page render and submit lands here,
  //    which is what stops a stale form from acting under a different account.
  const access = await getVendorSuperAdminAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }
  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  // 4. The capability probe AND the canonical detail read, issued together — neither depends
  //    on the other.
  //
  //    THE DETAIL READ IS NOT A CAPABILITY CHECK. It requires only RETAILERS_READ, which any
  //    Vendor Super Admin holds, so it proves the relationship is THIS Vendor's and reports
  //    the current lifecycle pair — but it says nothing about whether this caller may CHANGE
  //    it. The probe is what proves that, and it is checked first.
  const [capability, detail] = await Promise.all([
    getVendorRetailerManageCapability(),
    getVendorRetailerDetail(submission.relationshipId),
  ]);

  // Positive equality, never an exclusion list: an unrecognized capability value fails closed
  // without this line being edited. See isConfirmedManageCapability.
  if (!isConfirmedManageCapability(capability.status)) {
    return failure(
      capability.status === "denied" ? LIFECYCLE_DENIED : LIFECYCLE_UNAVAILABLE,
    );
  }

  if (detail.status === "unauthenticated") {
    redirect("/login");
  }
  if (detail.status === "unauthorized") {
    redirect("/access-denied");
  }
  if (detail.status === "not-found") {
    // A malformed, unknown, foreign or RLS-invisible relationship all arrive here
    // indistinguishably, and are reported as the same denial an unauthorized caller receives.
    return failure(LIFECYCLE_DENIED);
  }
  if (detail.status !== "authorized") {
    // A READ failure. Reported as a service problem rather than as a rejected write, because
    // nothing about the submission was wrong and nothing was attempted.
    return failure(LIFECYCLE_UNAVAILABLE);
  }

  const { retailer } = detail;

  // 5. Re-validate the transition against the CANONICAL pair the server just read — never
  //    against anything the browser claimed. This is what refuses a mismatched pair, a
  //    DEACTIVATED row, and a submission asking for the direction the Retailer is already in.
  const transition = validateVendorRetailerLifecycleTransition(
    {
      retailerStatus: retailer.retailerStatus,
      relationshipStatus: retailer.relationshipStatus,
    },
    submission.requestedStatus,
  );

  if (!transition.ok) {
    // `unsupported-pair` and `wrong-direction` share the generic lifecycle message rather
    // than the denial: the caller's rights are not in question, and the honest answer is that
    // this Retailer's status cannot be changed from where it is. It also avoids telling a
    // tampered submission which of the two rules it broke.
    return failure(LIFECYCLE_RETAILER_UNAVAILABLE);
  }

  // Display only. Read from the canonical detail so the success sentence names the Retailer
  // the database actually addressed — never from the browser, and never used to authorize.
  const retailerName = retailer.retailerName;

  // 6. The write. EXACTLY ONE RPC call, exactly two arguments, under the caller's own token.
  //    There is no retry loop anywhere below this line.
  const result = await setVendorRetailerStatus(
    submission.relationshipId,
    transition.requestedStatus,
  );

  switch (result.status) {
    case "denied":
      return failure(LIFECYCLE_DENIED);
    case "invalid":
      return failure(LIFECYCLE_INVALID);
    case "retailer-unavailable":
      return failure(LIFECYCLE_RETAILER_UNAVAILABLE);
    case "malformed":
      // 22P02. Only a tampered submission reaches this, since step 2 already required a
      // canonical UUID; reported as a denial so it is indistinguishable from one.
      return failure(LIFECYCLE_DENIED);
    case "unavailable":
      return failure(LIFECYCLE_UNAVAILABLE);
    case "saved-unconfirmed":
      // Committed, but undescribable. The page is still revalidated — the data MAY have
      // changed — and the administrator is told plainly to refresh rather than to try again.
      revalidatePath(retailerDetailPath(submission.relationshipId));
      return {
        outcome: "saved-unconfirmed",
        error: null,
        success: LIFECYCLE_SAVED_UNCONFIRMED,
      };
    case "changed":
    case "unchanged":
    default:
      break;
  }

  // 7. Committed. Revalidate, then RE-READ THE CANONICAL DETAIL.
  //
  //    revalidatePath alone is what refreshes the rendered page; the re-read below is a
  //    CONFIRMATION that the canonical source now answers, so a Retailer that has become
  //    unreadable is reported as "refresh to confirm" rather than as a confident success the
  //    page cannot actually show.
  revalidatePath(retailerDetailPath(submission.relationshipId));

  const refreshed = await getVendorRetailerDetail(submission.relationshipId);

  if (refreshed.status !== "authorized") {
    // THE WRITE STILL SUCCEEDED. A failed re-read is never presented as a failed write, and
    // never leaves the control in a state where an ordinary retry would resubmit a change
    // that is already committed. Nothing is retried here.
    return {
      outcome: "saved-unconfirmed",
      error: null,
      success: LIFECYCLE_SAVED_UNCONFIRMED,
    };
  }

  // The CONFIRMED status is the one the database reported, never the one that was requested.
  // They agree in practice; using the database's answer means the sentence describes what is
  // true rather than what was asked for.
  if (result.status === "unchanged") {
    return {
      outcome: "unchanged",
      error: null,
      success: describeVendorRetailerLifecycleNoChange(
        retailerName,
        result.retailerStatus,
      ),
    };
  }

  return {
    outcome: "changed",
    error: null,
    success: describeVendorRetailerLifecycleOutcome(
      retailerName,
      result.retailerStatus,
    ),
  };
}
