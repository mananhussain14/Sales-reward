import type { ReactNode } from "react";

export type RetailerNavItem = {
  label: string;
  href: string;
  /** SVG <path> element(s) rendered inside a shared 24x24 stroked <svg>. */
  icon: ReactNode;
};

/**
 * Retailer Portal navigation.
 *
 * A SEPARATE list from @/components/admin/nav-items, not a filtered view of it:
 * importing the Vendor Admin items and hiding some would mean the Vendor routes were
 * one rendering bug away from appearing in a Retailer's sidebar, and it would invite a
 * future edit to add a Vendor entry here by accident. Two lists that share nothing
 * cannot leak into each other.
 *
 * There is no "disabled / coming soon" entry. The Vendor Admin nav uses those to
 * sketch a roadmap to an internal audience; a Retailer is an external customer, and
 * advertising unbuilt modules to them sets an expectation this milestone cannot meet.
 *
 * NAVIGATION IS NOT AUTHORIZATION. Which items appear is presentation. The real
 * decisions are made on the server — app/(retailer)/retailer/layout.tsx for the portal
 * as a whole, each page for itself — and again in SQL by every RPC behind every read
 * and write. Hiding a link removes an accident, never a capability: a Manager who
 * types /retailer/shops still gets that page's own denial, and the shops RPC would
 * return them nothing regardless.
 */

const OVERVIEW_ITEM: RetailerNavItem = {
  label: "Overview",
  href: "/retailer",
  icon: (
    <path d="M2.25 12l8.954-8.955a1.5 1.5 0 012.122 0L22.5 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" />
  ),
};

const SHOPS_ITEM: RetailerNavItem = {
  label: "Shops",
  href: "/retailer/shops",
  icon: (
    <path d="M13.5 21v-7.5a.75.75 0 01.75-.75h3a.75.75 0 01.75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 003.75-.615A2.993 2.993 0 009.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 002.25 1.016c.896 0 1.7-.393 2.25-1.015a3.001 3.001 0 003.75.614m-16.5 0a3.004 3.004 0 01-.621-4.72L4.318 3.44A1.5 1.5 0 015.378 3h13.243a1.5 1.5 0 011.06.44l1.19 1.189a3 3 0 01-.621 4.72" />
  ),
};

const STAFF_ITEM: RetailerNavItem = {
  label: "Staff",
  href: "/retailer/staff",
  icon: (
    <path d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
  ),
};

/**
 * The navigation for a given portal access kind.
 *
 *   owner   the whole portal.
 *   reader  Staff only. The Overview and Shops pages are backed by
 *           get_retailer_owner_portal_context() and
 *           list_retailer_owner_portal_shops(), whose resolver requires the
 *           RETAILER_OWNER role — a Manager would be redirected by those pages and
 *           would receive no rows from those RPCs. Linking them would advertise two
 *           dead ends.
 */
export function retailerNavItems(kind: "owner" | "reader"): RetailerNavItem[] {
  if (kind === "reader") {
    return [STAFF_ITEM];
  }
  return [OVERVIEW_ITEM, SHOPS_ITEM, STAFF_ITEM];
}
