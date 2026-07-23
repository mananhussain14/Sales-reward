"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { retailerNavItems } from "@/components/retailer-portal/retailer-nav-items";
import { BrandLockup } from "@/components/ui/brand";
import { cn } from "@/components/ui/cn";

/**
 * Retailer Portal application shell.
 *
 * A Client Component only because it owns the mobile drawer's open/closed state
 * and the active-navigation highlight, both of which need the current pathname.
 * It receives no data of its own: `retailerName` and `accessKind` come from the
 * server layout's already-authorized context and are the ONLY values that cross
 * this boundary. No organization id, membership id, role id, permission, email,
 * or user id is passed in — none is available to pass, because the RPCs do not
 * return any.
 *
 * This mirrors @/components/admin/admin-shell structurally so the two portals
 * read as one product, but it is a SEPARATE component that shares no navigation
 * source with it. See @/components/retailer-portal/retailer-nav-items for why.
 *
 * Nothing here is an authorization boundary. Hiding a link is presentation, not
 * protection: the real decision is made in app/(retailer)/retailer/layout.tsx on
 * the server, and again in SQL by the RPCs behind every read.
 */

type RetailerShellProps = {
  /**
   * Retailer name from the authorized server-side portal context, or null.
   *
   * NULL FOR A NON-OWNER, deliberately. No RPC in the installed schema returns the
   * Retailer's name to a Manager — get_retailer_owner_portal_context() requires the
   * owner role — and the portal layer performs no direct table reads. Rather than
   * fabricate a name or guess one, the header omits it. See
   * @/lib/staff/retailer-staff-access for the full rationale.
   */
  retailerName: string | null;
  /** Which portal experience the server authorized. Presentation only. */
  accessKind: "owner" | "reader" | "submitter";
  children: React.ReactNode;
};

/** Shown when there is no retailer name, or it yields no initials (whitespace only). */
const FALLBACK_INITIALS = "SR";

/** The caption under the header name block. Describes the experience, not a role grant. */
const ACCESS_CAPTIONS: Record<RetailerShellProps["accessKind"], string> = {
  owner: "Retailer Owner",
  reader: "Retailer staff",
  submitter: "Sales staff",
};

/**
 * Derives up to two avatar initials from the retailer name.
 *
 * Retailer names are operator-entered free text, so this tolerates padding, runs
 * of whitespace, null, and the empty string rather than assuming a clean value.
 * Same rules as the Vendor Admin header, for visual consistency.
 */
function getRetailerInitials(retailerName: string | null): string {
  if (retailerName === null) return FALLBACK_INITIALS;

  const words = retailerName.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return FALLBACK_INITIALS;

  const initials =
    words.length === 1
      ? words[0].slice(0, 2)
      : words[0].charAt(0) + words[1].charAt(0);

  return initials.toUpperCase() || FALLBACK_INITIALS;
}

/**
 * Whether a nav item is the one currently being viewed.
 *
 * Exact match only. A `startsWith` test would light up "Overview" (/retailer)
 * for every page in the portal, since every route is nested beneath it.
 */
function isActiveNavItem(pathname: string, href: string): boolean {
  return pathname === href;
}

export function RetailerShell({
  retailerName,
  accessKind,
  children,
}: RetailerShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();
  const navItems = retailerNavItems(accessKind);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  // Close the mobile drawer when Escape is pressed.
  useEffect(() => {
    if (!sidebarOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSidebarOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  const initials = getRetailerInitials(retailerName);

  return (
    <div className="min-h-screen bg-slate-50">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-indigo-600 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to main content
      </a>

      {/* Sidebar: a fixed rail on lg+, a slide-in drawer below it. */}
      <aside
        id="retailer-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 transform border-r border-slate-200 bg-white transition-transform duration-200 ease-in-out lg:translate-x-0",
          sidebarOpen ? "translate-x-0 shadow-modal lg:shadow-none" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 items-center border-b border-slate-100 px-5">
          <BrandLockup context="Retailer" idSuffix="-retailer-nav" />
        </div>

        <nav aria-label="Retailer portal" className="px-3 py-4">
          <ul className="flex flex-col gap-1">
            {navItems.map((item) => {
              const active = isActiveNavItem(pathname, item.href);

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={closeSidebar}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                      active
                        ? "bg-indigo-50 text-indigo-700"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-indigo-600 transition-opacity",
                        active ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1.75}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-5 w-5 shrink-0"
                      aria-hidden="true"
                    >
                      {item.icon}
                    </svg>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      {/* Backdrop for the mobile drawer. */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close navigation menu"
          onClick={closeSidebar}
          className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-[2px] lg:hidden"
        />
      )}

      <div className="flex min-h-screen flex-col lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-slate-200 bg-white/85 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setSidebarOpen((prev) => !prev)}
            aria-label={
              sidebarOpen ? "Close navigation menu" : "Open navigation menu"
            }
            aria-expanded={sidebarOpen}
            aria-controls="retailer-sidebar"
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 lg:hidden"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5" />
            </svg>
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-slate-900">
              Retailer Portal
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {/* Which Retailer is being viewed. There is only ever one — the
                portal resolves a single Retailer and fails closed otherwise —
                so this is context, not a selector. The name is omitted entirely
                when the server had no authorized source for it (a non-owner);
                the caption still says which experience is in view. */}
            <div className="hidden min-w-0 flex-col items-end leading-tight sm:flex">
              {retailerName !== null && (
                <span className="max-w-[12rem] truncate text-sm font-medium text-slate-900 md:max-w-[16rem]">
                  {retailerName}
                </span>
              )}
              <span className="text-xs text-slate-500">
                {ACCESS_CAPTIONS[accessKind]}
              </span>
            </div>
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-semibold text-white shadow-sm"
              aria-hidden="true"
            >
              {initials}
            </span>

            <span
              aria-hidden="true"
              className="hidden h-6 w-px bg-slate-200 sm:block"
            />

            {/* The existing shared sign-out implementation, unchanged. */}
            <SignOutButton variant="header" />
          </div>
        </header>

        <main
          id="main-content"
          className="sr-animate-fade-in flex-1 px-4 py-6 sm:px-6 lg:px-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
