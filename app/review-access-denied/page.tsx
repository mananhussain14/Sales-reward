import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getClaimReviewerAccess } from "@/lib/review/claim-reviewer-access";
import { ReviewAccessDeniedCard } from "@/components/review/review-access-denied-card";

export const metadata: Metadata = {
  title: "Access denied · SalesReward",
  description: "This account does not have Claim Review access.",
};

/**
 * Shown to an authenticated user who is not an authorized Claim Reviewer.
 *
 * IT LIVES OUTSIDE THE (review) ROUTE GROUP DELIBERATELY. Inside it, the group
 * layout's own authorization check would redirect every unauthorized visitor
 * straight back here, producing a redirect loop — the page has to sit where the
 * guard does not run.
 *
 * The access check runs again at this server boundary rather than trusting that the
 * layout redirected here: this page is directly addressable, so its state must be
 * established from the verified session, not from how the caller arrived.
 *
 * THE COPY NAMES THE SURFACE, NEVER THE MISSING CONDITION. It says Claim Review
 * access is absent, because a reviewer who typed /review deserves to know which
 * door refused them. It does not say which role, permission, membership or
 * organization state was missing. This page is reached identically by: a signed-in
 * user with no reviewer role, an inactive profile, an inactive membership, an
 * inactive organization, an inactive CLAIM_REVIEWER role, a removed role
 * assignment, a Retailer-only account, a Vendor Super Admin without reviewer
 * access, a user qualifying for zero Vendors, and a user ambiguously qualifying for
 * MORE THAN ONE. Naming the failing condition would tell an unauthorized account
 * exactly what to acquire next.
 *
 * The ambiguous multi-Vendor case matters most here: it must NOT list the candidate
 * Vendors, or even hint that more than one exists. It reads exactly like every other
 * denial.
 *
 * IT DOES NOT MENTION VENDOR SUPER ADMIN, and it does not redirect a Vendor Super
 * Admin into the Vendor Admin. An automatic cross-portal redirect based on a failed
 * check in a different product surface would tell any visitor whether the signed-in
 * account holds Vendor access, and it would bounce someone who typed /review
 * deliberately. The sign-out control inside the card is the way out, exactly as on
 * /access-denied and /retailer-access-denied.
 */
export default async function ReviewAccessDeniedPage() {
  const access = await getClaimReviewerAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  // An authorized reviewer has no reason to see this page — send them to the
  // portal. This keeps the page self-correcting: once access is granted, a stale
  // bookmark stops being a dead end. No loop is possible, because /review only
  // redirects here when access is "unauthorized".
  if (access.status === "authorized") {
    redirect("/review");
  }

  // "unavailable" deliberately falls through to the same generic card below. The
  // caller could not be evaluated, so the honest thing is to show no more than the
  // denial does — inventing a distinct "try again" state here would reveal that the
  // check reached the database and failed, rather than that it denied.
  // A DEDICATED card rather than the shared @/components/ui/access-denied-card. That
  // one is required to stay a no-prop, fixed, neutral component shared by the Vendor
  // and Retailer denial routes, and an existing contract test enforces it — see the
  // header of ReviewAccessDeniedCard for the full reasoning.
  return <ReviewAccessDeniedCard />;
}
