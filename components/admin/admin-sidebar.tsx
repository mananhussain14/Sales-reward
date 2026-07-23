"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS, type NavItem } from "@/components/admin/nav-items";
import { BrandLockup } from "@/components/ui/brand";
import { cn } from "@/components/ui/cn";
import { NavPendingSpinner, NavProgressReporter } from "@/components/ui/nav-progress";

type AdminSidebarProps = {
  /** Whether the off-canvas drawer is open (mobile only). */
  open: boolean;
  /** Called when a navigation action should dismiss the mobile drawer. */
  onNavigate: () => void;
};

function NavIcon({ children }: { children: NavItem["icon"] }) {
  return (
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
      {children}
    </svg>
  );
}

export function AdminSidebar({ open, onNavigate }: AdminSidebarProps) {
  const pathname = usePathname();

  return (
    <nav
      id="admin-sidebar"
      aria-label="Primary"
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white",
        "transition-transform duration-200 ease-in-out lg:translate-x-0",
        open ? "translate-x-0 shadow-modal lg:shadow-none" : "-translate-x-full",
      )}
    >
      <div className="flex h-16 items-center border-b border-slate-100 px-5">
        <BrandLockup context="Vendor Admin" idSuffix="-admin-nav" />
      </div>

      <ul className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const isActive = !item.disabled && pathname === item.href;

          if (item.disabled) {
            return (
              <li key={item.label}>
                <span
                  aria-disabled="true"
                  title="Coming soon"
                  className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-slate-400"
                >
                  <NavIcon>{item.icon}</NavIcon>
                  <span className="flex-1">{item.label}</span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    Soon
                  </span>
                </span>
              </li>
            );
          }

          return (
            <li key={item.label}>
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                onClick={onNavigate}
                className={cn(
                  "group relative flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                  isActive
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                )}
              >
                {/* Active indicator — an indigo rail, so the state is not carried
                    by background tint alone. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-indigo-600 transition-opacity",
                    isActive ? "opacity-100" : "opacity-0",
                  )}
                />
                <NavIcon>{item.icon}</NavIcon>
                <span className="flex-1">{item.label}</span>
                {/* Immediate per-item feedback while this route loads, plus a
                    report into the global top bar. Both use Next's own
                    useLinkStatus — no DOM interception. */}
                <NavPendingSpinner />
                <NavProgressReporter />
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-slate-100 px-5 py-4">
        <p className="text-xs font-medium text-slate-400">
          SalesReward · v0.1
        </p>
      </div>
    </nav>
  );
}
