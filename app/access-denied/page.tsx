import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { AccessDeniedCard } from "@/components/ui/access-denied-card";

export const metadata: Metadata = {
  title: "Access denied · SalesReward",
  description: "This account does not have access to this page.",
};

/**
 * The shared, role-neutral "you are signed in but this page is not yours" screen.
 *
 * It is reached by the Vendor Admin layout for a non-Vendor, and by the
 * authenticated-landing resolver for any signed-in account that qualifies for no
 * role at all. The wording therefore names no specific role or portal: doing so
 * would be wrong for whichever roles it is NOT talking about, and would hint at
 * what an unauthorized account should acquire next.
 *
 * A Vendor Super Admin who somehow lands here is bounced to the dashboard below, so
 * this only ever renders for an account that genuinely has no Vendor access.
 *
 * The access check runs again at this server boundary rather than trusting the
 * fact that the layout redirected here — this page is directly addressable, so
 * its own state must be established from the verified session, not from how the
 * caller arrived.
 *
 * The copy is deliberately vague about WHY access was denied. Naming the missing
 * role, the organization, or the failing lifecycle state would tell an
 * unauthorized (possibly hostile) account exactly what to acquire next, and
 * would confirm which organizations exist.
 *
 * The sign-out button is the page's only action, and the reason this page is not
 * a dead end: without it, a user who reaches here with the wrong account has no
 * way back to /login except by clearing cookies by hand. Signing out requires no
 * authorization — see app/auth/actions.ts.
 */
export default async function AccessDeniedPage() {
  const access = await getVendorSuperAdminAccess();

  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  // An authorized admin has no reason to see this page — send them to the
  // dashboard. This also keeps the page self-correcting: once access is granted,
  // a stale bookmark stops being a dead end.
  if (access.status === "authorized") {
    redirect("/");
  }

  return <AccessDeniedCard />;
}
