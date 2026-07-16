import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AdminShell } from "@/components/admin/admin-shell";

/**
 * Server layout for the (admin) route group — the security boundary for every
 * Vendor Admin route.
 *
 * This check is what actually protects these routes. proxy.ts also redirects
 * unauthenticated traffic, but that is an optimistic pre-filter and must not be
 * relied on alone: it can be skipped by the matcher, and Next.js explicitly
 * advises against treating Proxy as an authorization solution. Because this
 * layout runs as part of rendering, no admin route can render around it.
 *
 * Scope: authentication ONLY. Role and permission checks, profile lookups, and
 * organization_members queries are deliberately not here yet — a verified
 * identity is currently the whole requirement.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  // getClaims() cryptographically verifies the JWT (and refreshes it if it is
  // close to expiring). getSession() would hand back the cookie's contents
  // without verifying them, which cannot support a trust decision.
  //
  // On no session it returns { data: null, error: null }, so presence of
  // `claims` — not absence of `error` — is the condition to test.
  const { data } = await supabase.auth.getClaims();

  if (!data?.claims) {
    // Fail closed: an unverifiable identity (expired, tampered, absent, or an
    // Auth server the client could not reach) never renders the admin.
    redirect("/login");
  }

  return <AdminShell>{children}</AdminShell>;
}
