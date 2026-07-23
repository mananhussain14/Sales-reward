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

const RECEIPTS_ITEM: RetailerNavItem = {
  label: "Receipts",
  href: "/retailer/receipts",
  icon: (
    <path d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
  ),
};

const PRODUCTS_ITEM: RetailerNavItem = {
  label: "Products",
  href: "/retailer/products",
  icon: (
    <path d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
  ),
};

/**
 * The navigation for a given portal access kind.
 *
 *   owner      the whole portal, minus Receipts. Products is the READ-ONLY assigned
 *              list; managing the catalog is a Vendor capability on a different
 *              surface entirely. Submitting a receipt is a Sales Staff
 *              act: RECEIPT_SUBMIT is mapped to SALES_STAFF alone, so an Owner would
 *              be refused by every receipt RPC. Showing them the entry would advertise
 *              a capability the database will not give them — which is exactly the
 *              "Owner navigation accidentally exposes a Sales-Staff-only action"
 *              mistake this milestone must avoid.
 *   reader     Staff and Products. Overview and Shops are backed by RPCs whose resolver
 *              requires the RETAILER_OWNER role, so a Manager would be redirected by
 *              those pages; and Receipts is refused for the same reason as for an
 *              Owner. Linking any of them would advertise dead ends.
 *   submitter  Receipts only. A Sales Staff member holds neither RETAILER_PORTAL_READ
 *              through the owner role nor RETAILER_STAFF_READ, and no
 *              RETAILER_PRODUCTS_READ mapping either — so Overview, Shops, Staff and
 *              Products are all refused to them by SQL, and none is offered here.
 *
 * Which items appear is presentation, never protection: each page re-resolves its own
 * access on the server, and every RPC behind every read and write decides again in SQL.
 */
export function retailerNavItems(
  kind: "owner" | "reader" | "submitter",
): RetailerNavItem[] {
  if (kind === "submitter") {
    return [RECEIPTS_ITEM];
  }
  if (kind === "reader") {
    return [STAFF_ITEM, PRODUCTS_ITEM];
  }
  return [OVERVIEW_ITEM, SHOPS_ITEM, STAFF_ITEM, PRODUCTS_ITEM];
}
