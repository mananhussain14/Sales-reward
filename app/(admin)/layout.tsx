import { redirect } from "next/navigation";
import { getVendorSuperAdminAccess } from "@/lib/auth/vendor-admin-access";
import { AdminShell } from "@/components/admin/admin-shell";

/**
 * Server layout for the (admin) route group — the authorization boundary for
 * every Vendor Admin route.
 *
 * This check is what actually protects these routes. proxy.ts also redirects
 * unauthenticated traffic, but that is an optimistic pre-filter and must not be
 * relied on alone: it can be skipped by the matcher, and Next.js explicitly
 * advises against treating Proxy as an authorization solution. Because this
 * layout runs as part of rendering, no admin route can render around it.
 *
 * Scope: authentication AND authorization. A verified identity is no longer
 * sufficient — the caller must resolve to an active VENDOR_SUPER_ADMIN in an
 * active VENDOR organization. The decision is delegated entirely to the shared
 * server function; the queries behind it are deliberately not repeated here, so
 * this layout and any future Server Action enforce exactly the same rule.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getVendorSuperAdminAccess();

  // Unverifiable identity (expired, tampered, absent, or an Auth server the
  // client could not reach): back to sign-in.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  // Verified identity, but not an active Vendor Super Admin. Also where every
  // fail-closed path inside the access check lands — a database or RPC error
  // denies rather than admits.
  if (access.status === "unauthorized") {
    redirect("/access-denied");
  }

  // Past this point `access.status` is "authorized", so both display values are
  // the ones resolved by the check above — the only source they may come from.
  return (
    <AdminShell
      organizationName={access.organizationName}
      userDisplayName={access.userDisplayName}
    >
      {children}
    </AdminShell>
  );
}
