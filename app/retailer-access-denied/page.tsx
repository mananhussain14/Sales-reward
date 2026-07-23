import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRetailerOwnerPortalAccess } from "@/lib/retailer-portal/retailer-owner-portal";
import { AccessDeniedCard } from "@/components/ui/access-denied-card";

export const metadata: Metadata = {
  title: "Access denied · SalesReward",
  description: "This account does not have access to this page.",
};

/**
 * Shown to an authenticated user who is not an authorized Retailer Owner.
 *
 * It lives OUTSIDE the (retailer) route group deliberately. Inside it, the group
 * layout's own authorization check would redirect every unauthorized visitor
 * straight back here, producing a redirect loop — the page has to sit where the
 * guard does not run.
 *
 * The access check runs again at this server boundary rather than trusting that
 * the layout redirected here: this page is directly addressable, so its state
 * must be established from the verified session, not from how the caller
 * arrived.
 *
 * The copy is deliberately vague about WHY access was denied, matching
 * /access-denied. This page is reached identically by an inactive profile, an
 * INVITED or inactive membership, an inactive Retailer, a missing or inactive
 * RETAILER_OWNER role, a missing permission, a Vendor Super Admin with no
 * Retailer Owner membership, a user qualifying for zero Retailers, and a user
 * ambiguously qualifying for more than one. Naming the failing condition would
 * tell an unauthorized (possibly hostile) account exactly what to acquire next.
 *
 * The ambiguous case matters most here: it must NOT list the candidate
 * Retailers, or even hint that more than one exists. It reads exactly like every
 * other denial.
 *
 * A Vendor Super Admin who lands here is NOT redirected into the Vendor Admin.
 * That would be an automatic cross-portal redirect based on a failed check in a
 * different product surface — it would tell any visitor whether the signed-in
 * account holds Vendor access, and it would bounce someone who typed /retailer
 * deliberately. The sign-out control is the way out, exactly as on
 * /access-denied.
 */
export default async function RetailerAccessDeniedPage() {
  const access = await getRetailerOwnerPortalAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  // An authorized owner has no reason to see this page — send them to the
  // portal. This keeps the page self-correcting: once access is granted, a stale
  // bookmark stops being a dead end.
  if (access.status === "authorized") {
    redirect("/retailer");
  }

  // "unavailable" deliberately falls through to the same generic card below.
  // The caller could not be evaluated, so the honest thing is to show no more
  // than the denial does — inventing a distinct "try again" state here would
  // reveal that the check reached the database and failed, rather than that it
  // denied.

  return <AccessDeniedCard />;
}
