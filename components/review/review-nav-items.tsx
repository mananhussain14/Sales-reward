import type { ReactNode } from "react";

export type ReviewNavItem = {
  label: string;
  href: string;
  /** When true, the item is shown but not navigable ("Coming soon"). */
  disabled: boolean;
  /** SVG <path> element(s) rendered inside a shared 24x24 stroked <svg>. */
  icon: ReactNode;
};

/**
 * Claim Review portal navigation.
 *
 * A SEPARATE list from @/components/admin/nav-items and
 * @/components/retailer-portal/retailer-nav-items, not a filtered view of either.
 * Importing the Vendor Admin items and hiding some would mean the Vendor routes —
 * Retailers, Users, Roles, Products, Campaigns, Audit Logs, and the Claims / Coins /
 * Payouts placeholders — were one rendering bug away from appearing in a reviewer's
 * sidebar, and it would invite a future edit to add a Vendor entry here by accident.
 * Three lists that share nothing cannot leak into each other. A source-level test
 * asserts that no module under components/review imports NAV_ITEMS.
 *
 * ONE ITEM, DISABLED. Phase 1B ships access and routing only: there is no queue RPC,
 * no receipt permission and no receipt data. A disabled entry is used rather than an
 * empty sidebar because an empty rail reads as a broken page, whereas "Coming soon"
 * reads as a deliberate state — the same reasoning the Vendor Admin nav applies to its
 * own unbuilt modules, and the audience here is internal rather than an external
 * customer.
 *
 * NAVIGATION IS NOT AUTHORIZATION. Which items appear is presentation. The real
 * decision is made on the server in app/(review)/review/layout.tsx, and will be made
 * again in SQL by every RPC behind every future read. Hiding a link removes an
 * accident, never a capability.
 */
export const REVIEW_NAV_ITEMS: ReviewNavItem[] = [
  {
    label: "Review queue",
    // The queue IS the portal root, so this is a real destination now rather than a
    // placeholder pointing at one. Enabled in Phase 1C-B.
    href: "/review",
    disabled: false,
    icon: (
      <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    ),
  },
];
