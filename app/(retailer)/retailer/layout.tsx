import { redirect } from "next/navigation";
import { getRetailerOwnerPortalAccess } from "@/lib/retailer-portal/retailer-owner-portal";
import { RetailerShell } from "@/components/retailer-portal/retailer-shell";

/**
 * Server layout for the /retailer segment — the authorization boundary for every
 * Retailer Owner Portal route (/retailer and /retailer/shops).
 *
 * WHY THIS LAYOUT LIVES AT /retailer AND NOT AT THE (retailer) GROUP ROOT.
 * Next.js pairs an error.tsx with the components it WRAPS — its sibling page and
 * everything nested below it — but NOT with its sibling layout in the same
 * segment. A throw from a layout escapes to the NEXT boundary up. This layout can
 * throw (see the "unavailable" branch below), so it must sit strictly BELOW the
 * boundary meant to catch it. The boundary is app/(retailer)/error.tsx at the
 * group root; placing this layout one segment deeper, at app/(retailer)/retailer/,
 * makes error.tsx its parent, so a layout-level RPC failure renders the portal's
 * generic retry state instead of escaping to the root error page.
 *
 * The (retailer) group contributes no URL segment, so the routes are unchanged:
 * this layout wraps /retailer and /retailer/shops, and no duplicate or dynamic
 * path is introduced by the move.
 *
 * This check is what actually protects these routes. proxy.ts keeps auth cookies
 * fresh and redirects unauthenticated traffic optimistically, but that is a
 * pre-filter and must not be relied on alone: it can be skipped by the matcher,
 * and Next.js explicitly advises against treating Proxy as an authorization
 * solution. Because this layout runs as part of rendering, no portal route can
 * render around it.
 *
 * Scope: authentication AND authorization. A verified identity is not
 * sufficient — the caller must resolve to exactly one qualifying active Retailer
 * Owner. That decision is delegated entirely to the portal access function,
 * which delegates it in turn to SQL. Neither the conditions nor the permission
 * codes are repeated here, so this layout and every page beneath it enforce
 * exactly the same rule as the database.
 *
 * This layout is deliberately parallel to app/(admin)/layout.tsx and shares
 * nothing with it. A Retailer Owner never passes the Vendor check and a Vendor
 * Super Admin never passes this one, so the two groups cannot admit each other's
 * users — and Vendor Admin behaviour is untouched by this milestone.
 */
export default async function RetailerPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getRetailerOwnerPortalAccess();

  // Unverifiable identity (expired, tampered, absent, or an Auth server the
  // client could not reach): back to sign-in. This matches the existing Vendor
  // Admin behaviour exactly — /login is the app's single sign-in route, and it
  // does not currently accept or honour a return path, so none is fabricated
  // here. Inventing one would be a new, unreviewed redirect surface.
  //
  // redirect() throws a NEXT_REDIRECT control signal, which Next.js intercepts
  // before it can reach app/(retailer)/error.tsx — an error boundary does not
  // swallow redirects or convert them into the generic failure state. Only a
  // genuine render error reaches that boundary.
  if (access.status === "unauthenticated") {
    redirect("/login");
  }

  // Verified identity, but not a single qualifying active Retailer Owner. Every
  // denial lands here identically — including the ambiguous multi-retailer case,
  // which fails closed in SQL. The destination page never reveals which
  // condition failed.
  //
  // Note this does NOT redirect to the Vendor Admin's /access-denied: that page
  // re-runs the Vendor check and would tell a Retailer Owner they lack "Vendor
  // Super Admin access", which is both confusing and a disclosure about a
  // different product surface. It also does not redirect them into Vendor Admin.
  if (access.status === "unauthorized") {
    redirect("/retailer-access-denied");
  }

  // The read itself failed — a transport fault, an RPC error, or a malformed
  // row. This is NOT a permission decision, so it must not be presented as one:
  // telling an authorized owner they lack access because of a network hiccup
  // would send them chasing a support ticket for something a retry fixes.
  //
  // Thrown so app/(retailer)/error.tsx renders the generic retry-safe state —
  // which it can only do because that boundary is this layout's PARENT, per the
  // placement rationale at the top of this file. The message is a fixed literal
  // carrying no database detail, no RPC name, and no row data, and Next.js does
  // not surface thrown messages from Server Components to the browser in
  // production regardless.
  if (access.status === "unavailable") {
    throw new Error("Retailer portal context is temporarily unavailable.");
  }

  // Past this point `access.status` is "authorized". The retailer name is the
  // only value handed to the client shell, and it came from the authorized
  // context — the only source it may come from.
  return (
    <RetailerShell retailerName={access.context.retailerName}>
      {children}
    </RetailerShell>
  );
}
