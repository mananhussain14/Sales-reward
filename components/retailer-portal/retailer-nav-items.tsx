import type { ReactNode } from "react";

export type RetailerNavItem = {
  label: string;
  href: string;
  /** SVG <path> element(s) rendered inside a shared 24x24 stroked <svg>. */
  icon: ReactNode;
};

/**
 * Retailer Owner Portal navigation — the complete list.
 *
 * Two items, and deliberately no more. This is a SEPARATE list from
 * @/components/admin/nav-items, not a filtered view of it: importing the Vendor
 * Admin items and hiding some would mean the Vendor routes were one rendering
 * bug away from appearing in a Retailer Owner's sidebar, and it would invite a
 * future edit to add a Vendor entry here by accident. Two lists that share
 * nothing cannot leak into each other.
 *
 * There is no "disabled / coming soon" entry either. The Vendor Admin nav uses
 * those to sketch a roadmap to an internal audience; a Retailer Owner is an
 * external customer, and advertising unbuilt modules to them sets an expectation
 * this milestone has no way to meet.
 *
 * This milestone is READ-ONLY, so there is nothing here for creating, editing,
 * deleting, inviting, claiming, or paying out — and no Settings, Users, or Roles
 * entry, because the portal exposes no such capability.
 */
export const RETAILER_NAV_ITEMS: RetailerNavItem[] = [
  {
    label: "Overview",
    href: "/retailer",
    icon: (
      <path d="M2.25 12l8.954-8.955a1.5 1.5 0 012.122 0L22.5 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75" />
    ),
  },
  {
    label: "Shops",
    href: "/retailer/shops",
    icon: (
      <path d="M13.5 21v-7.5a.75.75 0 01.75-.75h3a.75.75 0 01.75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 003.75-.615A2.993 2.993 0 009.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 002.25 1.016c.896 0 1.7-.393 2.25-1.015a3.001 3.001 0 003.75.614m-16.5 0a3.004 3.004 0 01-.621-4.72L4.318 3.44A1.5 1.5 0 015.378 3h13.243a1.5 1.5 0 011.06.44l1.19 1.189a3 3 0 01-.621 4.72" />
    ),
  },
];
