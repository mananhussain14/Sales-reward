"use client";

import { useCallback, useEffect, useState } from "react";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { REVIEW_NAV_ITEMS } from "@/components/review/review-nav-items";
import { BrandLockup } from "@/components/ui/brand";
import { cn } from "@/components/ui/cn";

/**
 * Claim Review portal application shell.
 *
 * A Client Component only because it owns the mobile drawer's open/closed state.
 * It receives no data of its own: `userDisplayName` and `organizationName` come
 * from the server layout's already-authorized context and are the ONLY values that
 * cross this boundary. No organization id, membership id, role id, permission id,
 * profile id or email is passed in — none is available to pass, because
 * public.get_claim_reviewer_context() does not return any.
 *
 * Structurally it mirrors @/components/retailer-portal/retailer-shell so the three
 * portals read as one product, but it is a SEPARATE component that shares no
 * navigation source with either of the others. See
 * @/components/review/review-nav-items for why.
 *
 * THERE IS NO ACTIVE-LINK STATE and no `usePathname`, deliberately: /review is the
 * only route in this group and its single nav item is disabled, so highlighting
 * would be describing a choice the reviewer does not yet have.
 *
 * Nothing here is an authorization boundary. Hiding or disabling a link is
 * presentation, not protection: the real decision is made in
 * app/(review)/review/layout.tsx on the server, and will be made again in SQL by
 * every RPC behind every future read.
 */

type ReviewShellProps = {
  /** From the authorized server context. Approved for display to this reviewer. */
  userDisplayName: string;
  /** The Vendor this reviewer acts for. Approved for display. */
  organizationName: string;
  children: React.ReactNode;
};

/** Shown when the organization name yields no initials (whitespace only). */
const FALLBACK_INITIALS = "SR";

/**
 * Derives up to two avatar initials from the Vendor name.
 *
 * Organization names are operator-entered free text, so this tolerates padding,
 * runs of whitespace and the empty string rather than assuming a clean value. Same
 * rules as the Vendor Admin and Retailer headers, for visual consistency.
 */
function getInitials(organizationName: string): string {
  const words = organizationName.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return FALLBACK_INITIALS;

  const initials =
    words.length === 1
      ? words[0].slice(0, 2)
      : words[0].charAt(0) + words[1].charAt(0);

  return initials.toUpperCase() || FALLBACK_INITIALS;
}

export function ReviewShell({
  userDisplayName,
  organizationName,
  children,
}: ReviewShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

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

  const initials = getInitials(organizationName);

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
        id="review-sidebar"
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 transform border-r border-slate-200 bg-white transition-transform duration-200 ease-in-out lg:translate-x-0",
          sidebarOpen
            ? "translate-x-0 shadow-modal lg:shadow-none"
            : "-translate-x-full",
        )}
      >
        <div className="flex h-16 items-center border-b border-slate-100 px-5">
          <BrandLockup context="Claim Review" idSuffix="-review-nav" />
        </div>

        <nav aria-label="Claim Review portal" className="px-3 py-4">
          <ul className="flex flex-col gap-1">
            {REVIEW_NAV_ITEMS.map((item) => (
              <li key={item.href}>
                {/*
                  Rendered as a non-interactive element rather than a disabled
                  <Link>: a link that navigates nowhere is a worse affordance than
                  something that never looked clickable. aria-disabled marks the
                  state for assistive technology, and the visible "Soon" badge
                  states it in text rather than by colour alone.
                */}
                <div
                  aria-disabled="true"
                  className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-slate-400"
                >
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
                  <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Soon
                  </span>
                </div>
              </li>
            ))}
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
            aria-controls="review-sidebar"
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
              Claim Review
            </h1>
          </div>

          <div className="flex items-center gap-3">
            {/* Which Vendor this reviewer acts for. There is only ever one — the
                context resolver fails closed when a reviewer qualifies for two —
                so this is context, not a selector. */}
            <div className="hidden min-w-0 flex-col items-end leading-tight sm:flex">
              <span className="max-w-[12rem] truncate text-sm font-medium text-slate-900 md:max-w-[16rem]">
                {userDisplayName}
              </span>
              <span className="max-w-[12rem] truncate text-xs text-slate-500 md:max-w-[16rem]">
                {organizationName}
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
