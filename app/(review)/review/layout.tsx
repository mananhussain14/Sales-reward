import { redirect } from "next/navigation";
import { getClaimReviewerAccess } from "@/lib/review/claim-reviewer-access";
import { ReviewShell } from "@/components/review/review-shell";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Server layout for the (review) route group — the authorization boundary for
 * every Claim Review route.
 *
 * This check is what actually protects these routes. proxy.ts also redirects
 * unauthenticated traffic, but that is an optimistic pre-filter and must not be
 * relied on alone: it can be skipped by the matcher, and Next.js explicitly advises
 * against treating Proxy as an authorization solution. Because this layout runs as
 * part of rendering, no /review route can render around it.
 *
 * Scope: authentication AND authorization. A verified identity is not sufficient —
 * the caller must resolve to a single ACTIVE Vendor organization in which they hold
 * CLAIM_REVIEW_PORTAL_READ. The decision is delegated entirely to the shared server
 * function; the query behind it is deliberately not repeated here, so this layout and
 * every future Server Action enforce exactly the same rule.
 *
 * IT DOES NOT REUSE THE VENDOR ADMIN OR RETAILER GATE. getVendorSuperAdminAccess()
 * resolves a hard-coded VENDOR_SUPER_ADMIN role and gates a different product
 * surface; getRetailerPortalAccess() resolves a Retailer. Sharing either would
 * couple two authorization boundaries that must be able to change independently.
 *
 * WHAT THIS LAYOUT DOES NOT AUTHORIZE: reading a receipt. CLAIM_REVIEW_PORTAL_READ
 * grants the portal shell and nothing else. No page beneath this layout may query
 * receipt data, and none does.
 */
export default async function ReviewLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getClaimReviewerAccess();

  // Unverifiable identity (expired, tampered, absent, or an Auth server the client
  // could not reach): back to sign-in.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  // Verified identity, but not an authorized reviewer. Sent to the REVIEWER's own
  // denial route, never to /access-denied: that page speaks about Vendor Super Admin
  // permissions, which is both confusing here and a disclosure about a different
  // product surface. The denial page sits outside this route group, so it cannot
  // re-enter this layout and loop.
  if (access.status === "unauthorized") {
    redirect("/review-access-denied");
  }

  // An operational failure — the RPC could not be reached or reported an error.
  // This is NOT a denial and must never be rendered as one: redirecting an
  // authorized reviewer to a denial page during a transient outage would tell them
  // they had lost access. The session is left intact and the page is retry-safe.
  if (access.status === "unavailable") {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl items-center px-4 py-10">
        <EmptyState
          tone="amber"
          title="Claim Review is temporarily unavailable"
          description="We couldn't confirm your access just now. Your session is still active — please refresh in a moment."
        />
      </main>
    );
  }

  // Past this point `access.status` is "authorized", so both display values are the
  // ones resolved by the check above — the only source they may come from.
  return (
    <ReviewShell
      userDisplayName={access.userDisplayName}
      organizationName={access.organizationName}
    >
      {children}
    </ReviewShell>
  );
}
