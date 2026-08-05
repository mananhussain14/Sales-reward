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

const CAMPAIGNS_ITEM: RetailerNavItem = {
  label: "Campaigns",
  href: "/retailer/campaigns",
  icon: (
    <path d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.24.117-1.526-.421a20.75 20.75 0 01-1.44-3.685m4.101-.585a20.85 20.85 0 018.834 2.535M10.34 6.66a20.85 20.85 0 008.834-2.535M18.75 4.971c.487.147.982.28 1.486.396a24.5 24.5 0 010 9.266c-.504.115-.999.249-1.486.396m0-10.058a20.83 20.83 0 01.42 5.03c0 1.716-.146 3.395-.42 5.028" />
  ),
};

/**
 * The Sales Staff campaign view. A SEPARATE entry from CAMPAIGNS_ITEM above, pointing at
 * a different route backed by a different RPC and a different permission:
 * list_my_staff_campaigns() under STAFF_CAMPAIGNS_VIEW, which returns only ACTIVE and
 * SCHEDULED campaigns and withholds the Vendor's name. Sharing one href between the two
 * would put an Owner-only read one routing change away from a shop-floor screen.
 */
const MY_CAMPAIGNS_ITEM: RetailerNavItem = {
  label: "Current campaigns",
  href: "/retailer/my-campaigns",
  icon: (
    <path d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.24.117-1.526-.421a20.75 20.75 0 01-1.44-3.685m4.101-.585a20.85 20.85 0 018.834 2.535M10.34 6.66a20.85 20.85 0 008.834-2.535M18.75 4.971c.487.147.982.28 1.486.396a24.5 24.5 0 010 9.266c-.504.115-.999.249-1.486.396m0-10.058a20.83 20.83 0 01.42 5.03c0 1.716-.146 3.395-.42 5.028" />
  ),
};

/**
 * The seller's own earnings.
 *
 * The label is "My campaign earnings" and NOT Wallet, Balance, Coins available, Redeem or
 * Payouts. No wallet, ledger or redemption model exists in the schema, and a navigation
 * label is the first promise a product makes — one that said "Wallet" would be advertising
 * a feature nothing behind it could honour.
 */
const MY_EARNINGS_ITEM: RetailerNavItem = {
  label: "My campaign earnings",
  href: "/retailer/my-earnings",
  icon: (
    <path d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  ),
};

/**
 * The navigation for a given portal access kind.
 *
 *   owner      the whole portal, minus Receipts. Products is the READ-ONLY assigned
 *              list; managing the catalog is a Vendor capability on a different
 *              surface entirely. Campaigns is likewise READ-ONLY — CAMPAIGNS_VIEW_ASSIGNED
 *              is mapped to RETAILER_OWNER alone and grants no write of any kind.
 *              Submitting a receipt is a Sales Staff
 *              act: RECEIPT_SUBMIT is mapped to SALES_STAFF alone, so an Owner would
 *              be refused by every receipt RPC. Showing them the entry would advertise
 *              a capability the database will not give them — which is exactly the
 *              "Owner navigation accidentally exposes a Sales-Staff-only action"
 *              mistake this milestone must avoid.
 *   reader     Staff and Products. Overview and Shops are backed by RPCs whose resolver
 *              requires the RETAILER_OWNER role, so a Manager would be redirected by
 *              those pages; and Receipts is refused for the same reason as for an
 *              Owner. Campaigns is absent for the same kind of reason: a Manager holds no
 *              CAMPAIGNS_VIEW_ASSIGNED mapping, so list_my_retailer_campaigns() refuses
 *              them. That visibility is DEFERRED for this milestone rather than
 *              accidentally omitted — no installed permission was a safe reuse, and a
 *              Manager gains it later by acquiring a role_permissions row.
 *              Linking any of them would advertise dead ends.
 *   submitter  Receipts, Current campaigns and My campaign earnings. A Sales Staff member
 *              holds neither RETAILER_PORTAL_READ through the owner role nor
 *              RETAILER_STAFF_READ, and no RETAILER_PRODUCTS_READ mapping either — so
 *              Overview, Shops, Staff and Products are all refused to them by SQL, and
 *              none is offered here. They DO hold STAFF_CAMPAIGNS_VIEW and, since
 *              Migration 70, STAFF_EARNINGS_VIEW; both now have a Web surface, so both
 *              are linked. The Owner's /retailer/campaigns is NOT among them: that route
 *              is backed by a different RPC under a different permission, and every
 *              staff-facing read lives on its own path.
 *
 * NEITHER NEW ENTRY IS OFFERED TO AN OWNER OR A READER. Both routes re-resolve access on
 * the server and both RPCs refuse anyone without the Sales Staff mapping, so linking them
 * would only advertise a dead end — the same reasoning that keeps Receipts out of the
 * Owner's sidebar.
 *
 * Which items appear is presentation, never protection: each page re-resolves its own
 * access on the server, and every RPC behind every read and write decides again in SQL.
 */
export function retailerNavItems(
  kind: "owner" | "reader" | "submitter",
): RetailerNavItem[] {
  if (kind === "submitter") {
    return [RECEIPTS_ITEM, MY_CAMPAIGNS_ITEM, MY_EARNINGS_ITEM];
  }
  if (kind === "reader") {
    return [STAFF_ITEM, PRODUCTS_ITEM];
  }
  return [OVERVIEW_ITEM, SHOPS_ITEM, STAFF_ITEM, PRODUCTS_ITEM, CAMPAIGNS_ITEM];
}
